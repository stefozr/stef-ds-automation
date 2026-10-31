/**
 * Milestone 7 (docs/M7-DESIGN.md §1.6, §2.1 WP-B, §3.10.4-§3.10.8): the zone hit ledger. Per creature, per zone and
 * per combat round, `flags["stef-ds-automation"].zoneHits` on the Combat records which **credits** were used:
 * `{round, used: {<zoneId>: {<uuidKey(actorUuid)>: {<creditKey>: {at, messageId, via}}}}}`.
 *
 * - Credit keys: `any` (onceShared: one hit per round whatever the trigger), `enter` (once per round), and
 *   `turnStart:<activation>` / `turnEnd:<activation>` (once per activation of that creature, so a solo monster's
 *   second turn in the area is a new credit and a duplicate event of the same activation is not). `once: "none"`
 *   has no credit at all (`creditKey` returns null) and writes nothing.
 * - A state whose `round` differs from `combat.round` counts as empty (lazy reset, as triggers/budget.mjs): no write
 *   on a round change; the first write of a round replaces the stale state.
 * - Claims are synchronous and in memory (before any await, the budget.mjs pattern): `claimZoneHit` refuses a credit
 *   that is claimed in memory or written in the flag. The claim is held until the hit's card posted and its flag
 *   write landed (engine.mjs), or released when the hit never happens.
 * - Every flag write runs on the zone chain (`withZoneChain`, zones/registry.mjs), which waits for nothing but its own
 *   document writes; callers inside a card lock fire and forget.
 * Active GM only for writes; `zoneHitOf` reads on any client.
 */
import * as constants from "../constants.mjs";
import { debug, error } from "../log.mjs";
import { uuidKey } from "../triggers/budget.mjs";
import { withZoneChain } from "./registry.mjs";

const { MODULE_ID } = constants;
const FLAG = () => constants.ZONE_HIT_FLAG ?? "zoneHits";
const flagPath = () => `flags.${MODULE_ID}.${FLAG()}`;
const isActiveGM = () => !!game.users?.activeGM?.isSelf;
const ForcedDeletion = () => {
  const Op = globalThis.foundry?.data?.operators?.ForcedDeletion;
  return Op ? new Op() : null;
};
const newId = () => globalThis.foundry?.utils?.randomID?.(16) ?? Math.random().toString(36).slice(2, 18);

/** In-memory claims: `${combatId}:${round}:${zoneId}:${actorKey}:${creditKey}` -> claim token. */
const claims = new Map();

/**
 * The credit key of an event (§1.6). `via` is "enter" | "move" | "turnStart" | "turnEnd" | "manual" (api hit: the
 * `enter` credit). null for once "none" (no credit, every trigger hits).
 * @returns {string|null}
 */
export function creditKey(system, via, activation = null) {
  if (!system || system.once === "none") return null;
  if (system.onceShared) return "any";
  if (via === "turnStart" || via === "turnEnd") return `${via}:${Number.isFinite(Number(activation)) && activation !== null ? Number(activation) : 0}`;
  if (via === "move") return "move";
  return "enter";
}

/** The ledger of a combat for its current round ({} for another round: lazy reset). */
function state(combat) {
  const st = combat?.flags?.[MODULE_ID]?.[FLAG()];
  if (!st || typeof st !== "object" || st.round !== combat?.round) return { round: combat?.round ?? null, used: {} };
  return { round: st.round, used: st.used && typeof st.used === "object" ? st.used : {} };
}

const claimKey = (combat, zoneId, actorUuid, ck) => `${combat?.id ?? "none"}:${combat?.round ?? 0}:${zoneId}:${uuidKey(actorUuid)}:${ck}`;

/** The written entry of that credit this round, or null. Any client. */
export function zoneHitOf(combat, zoneId, actorUuid, ck) {
  if (!combat || !zoneId || !actorUuid || !ck) return null;
  const e = state(combat).used?.[zoneId]?.[uuidKey(actorUuid)]?.[ck];
  return e && typeof e === "object" ? e : null;
}

/**
 * Synchronous claim of a credit: null when it is taken (in memory or in the flag) this round. Without a started
 * combat there is no round to count in: the claim always succeeds (an unbounded token).
 * @returns {{key: string|null, id: string}|null}
 */
export function claimZoneHit(combat, zoneId, actorUuid, ck) {
  if (!ck) return { key: null, id: newId(), none: true };
  if (!combat?.started) return { key: null, id: newId() };
  const key = claimKey(combat, zoneId, actorUuid, ck);
  if (claims.has(key)) return null;
  if (zoneHitOf(combat, zoneId, actorUuid, ck)) return null;
  const token = { key, id: newId(), combatId: combat.id, zoneId };
  claims.set(key, token);
  debug("zones.claim", { zoneId, actorUuid, creditKey: ck, round: combat.round });
  return token;
}

/** Release an in-memory claim (a hit that never posted, or one whose flag write landed). */
export function releaseClaim(claim) {
  if (!claim || typeof claim !== "object" || !claim.key) return;
  if (claims.get(claim.key) === claim) claims.delete(claim.key);
}

/** Drop the claims of a combat (round change, deleteCombat) or of one zone in it (endZone: zoneId with combatId null). */
export function dropZoneClaims(combatId, zoneId = null) {
  for (const [key, token] of claims) {
    if (combatId && token.combatId !== combatId) continue;
    if (zoneId && token.zoneId !== zoneId) continue;
    claims.delete(key);
  }
}

/** The live Combat document (never a deleted one when the world collection exists). */
function liveCombat(combat) {
  const id = typeof combat === "string" ? combat : combat?.id;
  if (!id) return null;
  if (game.combats) return game.combats.get?.(id) ?? null;
  return typeof combat === "object" ? combat : null;
}

/**
 * Write a credit entry (active GM, on the zone chain). Skipped when the combat is gone or in another round than
 * `round` (when given), when the entry already holds the same message, and with `ifFree` when another card holds it.
 * @param {Combat|string} combat
 * @param {object} entry          {at, messageId, via}
 * @param {object} [options]
 * @param {number|null} [options.round]
 * @param {boolean} [options.ifFree]
 * @returns {Promise<boolean>}    true when written
 */
export async function writeZoneHit(combat, zoneId, actorUuid, ck, entry, { round = null, ifFree = false } = {}) {
  if (!isActiveGM() || !zoneId || !actorUuid || !ck) return false;
  try {
    return await withZoneChain(async () => {
      const live = liveCombat(combat);
      if (!live?.started) return false;
      if (round !== null && round !== undefined && live.round !== round) return false;
      const existing = zoneHitOf(live, zoneId, actorUuid, ck);
      if (existing && existing.messageId && existing.messageId === entry?.messageId) return false;
      if (existing && ifFree) return false;
      const key = uuidKey(actorUuid);
      const value = { at: entry?.at ?? Date.now(), messageId: entry?.messageId ?? null, via: entry?.via ?? null };
      const st = live.flags?.[MODULE_ID]?.[FLAG()];
      const opts = { [MODULE_ID]: { internal: true } };
      if (st && st.round === live.round) {
        await live.update({ [`${flagPath()}.used.${zoneId}.${key}.${ck}`]: value }, opts);
        return true;
      }
      const del = ForcedDeletion();
      if (st && del) await live.update({ [flagPath()]: del }, opts);
      await live.update({ [flagPath()]: { round: live.round, used: { [zoneId]: { [key]: { [ck]: value } } } } }, opts);
      return true;
    });
  } catch (err) {
    error("zones.writeHit", err, { zoneId, creditKey: ck });
    return false;
  }
}

/**
 * Release a written credit (active GM, on the zone chain): only while the entry is still that message's when
 * `messageId` is given (an undone hit card frees the credit; the Director can re-trigger).
 * @returns {Promise<boolean>}
 */
export async function releaseZoneHit(combat, zoneId, actorUuid, ck, { messageId = null } = {}) {
  if (!isActiveGM() || !zoneId || !actorUuid || !ck) return false;
  try {
    return await withZoneChain(async () => {
      const live = liveCombat(combat);
      if (!live) return false;
      const existing = zoneHitOf(live, zoneId, actorUuid, ck);
      if (!existing) return false;
      if (messageId && existing.messageId !== messageId) return false;
      const path = `${flagPath()}.used.${zoneId}.${uuidKey(actorUuid)}.${ck}`;
      const del = ForcedDeletion();
      const update = del ? { [path]: del } : { [`${flagPath()}.used.${zoneId}.${uuidKey(actorUuid)}.-=${ck}`]: null };
      await live.update(update, { [MODULE_ID]: { internal: true } });
      debug("zones.release", { zoneId, actorUuid, creditKey: ck, messageId });
      return true;
    });
  } catch (err) {
    error("zones.releaseHit", err, { zoneId, creditKey: ck });
    return false;
  }
}
