/**
 * Milestone 9 (docs/M9-DESIGN.md §C.5, WP-C): the Persistent "reroll" keep effect. A kept use makes its power roll
 * again without spending essence: the active GM picks the targets (`rerollTargets`), records what it expects
 * (`expectReroll`, in memory, plus `rerollRound` on the index entry for a GM reload), and starts the use on the
 * owner's client (or its own) through the trigger follow-up path (`runFollowUp`, prompt `triggerRun`, kind
 * `persistentUse`: ui/trigger-dialog.mjs `runPersistentUse` uses the item with the dialog's resource set to 0 and an
 * author hint flag `persistentReroll.parent`). The owner's client reports through relay action `persistent`
 * (`handlePersistentReport`: `useStarted` | `useCancelled`); a cancelled re-roll drops the expectation, the use
 * stays kept. The new card resolves like any other; at its resolve `matchReroll` (engine.mjs, through
 * persistent/registry.mjs persistentRecord) consumes the expectation and marks the record `parent` / `free`.
 *
 * - Targets: `recorded` = the use's own token targets still alive, on the user's scene and within the ability's
 *   distance; `area` = every enemy within that distance of the user with line of effect. None: a note card.
 * - The expectation is GM-validated: the author's flag only chooses between two pending re-rolls of one item; after a
 *   GM reload (expectation lost) a card whose hint names an active entry of this item with `rerollRound` = the
 *   combat's round still matches.
 *
 * i18n keys used here: DSAUTO.Persistent.NoTargets, DSAUTO.Persistent.RerollCancelled.
 */
import { MODULE_ID, loc } from "../constants.mjs";
import { abilityDistance } from "../engine/library-plan.mjs";
import { debug, error, log } from "../log.mjs";
import { distanceSquares, incapacitated, lineOfEffect, relation } from "../triggers/eligibility.mjs";
import { clock, ownersOf, promptMs, runFollowUp } from "../triggers/prompt.mjs";
import { patchEntry, postNote, rawEntry } from "./registry.mjs";

/** How long the GM waits for a re-roll's card (the owner's use dialog may stay open a while). */
const EXPECT_MS = 10 * 60_000;
const MAX_IDS = 10;

const expected = new Map();   // parentMessageId -> {parentMessageId, actorUuid, itemUuid, combatId, round, targetTokenUuids, until, runId}

const randomID = () => globalThis.foundry?.utils?.randomID?.() ?? Math.random().toString(36).slice(2, 18);

function lookup(uuid) {
  if (!uuid) return null;
  try {
    return fromUuidSync(uuid) ?? null;
  } catch (_err) {
    return null;
  }
}

function list(c) {
  if (!c) return [];
  if (Array.isArray(c)) return c;
  if (Array.isArray(c.contents)) return c.contents;
  if (typeof c.values === "function") return [...c.values()];
  return [];
}

/** Alive enough to be targeted again: on a scene, an actor that is not dead or defeated. */
const targetable = (doc, combat) => !!doc?.actor && !doc.hidden && !incapacitated(doc.actor, combat);

/**
 * The tokens a kept use's re-roll targets now (uuids, at most MAX_IDS): see the header. [] when the user's token or
 * the item is gone.
 * @param {object} entry                 the index entry
 * @param {{combat?: Combat|null}} [opts]
 * @returns {string[]}
 */
export function rerollTargets(entry, { combat = null } = {}) {
  try {
    const item = lookup(entry?.itemUuid);
    const source = lookup(entry?.tokenUuid);
    if (!item || !source?.parent) return [];
    const dist = abilityDistance(item);
    const within = t => dist == null || distanceSquares(source, t) <= dist;
    const sameScene = t => t?.parent?.id === source.parent.id;
    let docs;
    if ((entry.targets ?? "recorded") === "area") {
      docs = list(source.parent.tokens).filter(t => t !== source && relation(source, t) === "enemy" && lineOfEffect(source, t));
    } else docs = (entry.targetTokenUuids ?? []).map(lookup).filter(Boolean);
    return docs.filter(t => sameScene(t) && targetable(t, combat) && within(t)).slice(0, MAX_IDS).map(t => t.uuid);
  } catch (err) {
    error("persistent.rerollTargets", err, { messageId: entry?.messageId });
    return [];
  }
}

/* -------------------------------------------- */
/*  Expectations (active GM, in memory)          */
/* -------------------------------------------- */

/** Record a re-roll the GM started; a newer one of the same use replaces it. */
export function expectReroll(x) {
  if (!x?.parentMessageId) return;
  expected.set(x.parentMessageId, { ...x, until: x.until ?? clock.now() + EXPECT_MS });
}

/** Drop (and return) the expectation of a use's re-roll. */
export function consumeReroll(parentMessageId) {
  const x = expected.get(parentMessageId) ?? null;
  expected.delete(parentMessageId);
  return x;
}

/** deleteCombat: the expectations of that combat (every one without an id). */
export function dropRerolls(combatId = null) {
  for (const [id, x] of [...expected]) if (!combatId || x.combatId === combatId) expected.delete(id);
}

/** For tests and selfCheck: pending re-rolls. */
export const pendingRerolls = () => [...expected.values()].map(x => ({ ...x }));

/**
 * At the resolve of a FRESH card (engine.mjs, through persistentRecord): is it the free re-roll of a kept use? The
 * GM's expectation decides (item and actor, not expired); the author's flag `persistentReroll.parent` only picks
 * between two. Without an expectation (a GM reload) the hint must name an active entry of this item whose
 * `rerollRound` is the combat's round. Consumes the match.
 * @returns {{parent: string, free: true}|null}
 */
export function matchReroll(message, item, combat) {
  try {
    if (!item?.uuid) return null;
    const hint = message?.flags?.[MODULE_ID]?.persistentReroll?.parent ?? null;
    const now = clock.now();
    const mine = [...expected.values()].filter(x => x.itemUuid === item.uuid && x.actorUuid === item.actor?.uuid && x.until >= now);
    const x = mine.find(c => c.parentMessageId === hint) ?? mine.sort((a, b) => (a.until ?? 0) - (b.until ?? 0))[0] ?? null;
    if (x) {
      expected.delete(x.parentMessageId);
      return { parent: x.parentMessageId, free: true };
    }
    if (typeof hint !== "string") return null;
    const e = rawEntry(combat, hint);
    if (e?.active && e.itemUuid === item.uuid && e.rerollRound != null && e.rerollRound === combat?.round) return { parent: hint, free: true };
    return null;
  } catch (err) {
    error("persistent.matchReroll", err, { messageId: message?.id });
    return null;
  }
}

/* -------------------------------------------- */
/*  Start (active GM)                           */
/* -------------------------------------------- */

/**
 * Start a kept use's free re-roll (after the Keep card was paid): targets, expectation, `rerollRound`, then the
 * follow-up on the owner's client (`owner`, or the GM's own when `local` / no owner). Never throws.
 * @returns {Promise<{started: boolean, targets: string[]}>}
 */
export async function startReroll(entry, { combat = null, round = null, owner = null, local = false } = {}) {
  try {
    const targets = rerollTargets(entry, { combat });
    if (!targets.length) {
      await postNote(entry, loc("DSAUTO.Persistent.NoTargets", { ability: entry.abilityName }), "noTargets");
      return { started: false, targets };
    }
    const runId = randomID();
    expectReroll({
      parentMessageId: entry.messageId, actorUuid: entry.actorUuid, itemUuid: entry.itemUuid, combatId: combat?.id ?? entry.combatId ?? null,
      round, targetTokenUuids: targets, runId,
    });
    await patchEntry(combat ?? entry.combatId, entry.messageId, { rerollRound: round });
    const r = await runFollowUp(local ? null : owner, {
      kind: "persistentUse", runId, itemUuid: entry.itemUuid, targetTokenUuids: targets, parentMessageId: entry.messageId,
      watchMs: promptMs() + 60_000,
    });
    log("persistent.reroll", { messageId: entry.messageId, targets: targets.length, started: !!r?.started, to: local ? "director" : owner?.name ?? null });
    if (!r?.started) {
      consumeReroll(entry.messageId);
      await postNote(entry, loc("DSAUTO.Persistent.RerollCancelled", { ability: entry.abilityName }), "rerollCancelled");
    }
    return { started: !!r?.started, targets };
  } catch (err) {
    error("persistent.startReroll", err, { messageId: entry?.messageId });
    return { started: false, targets: [] };
  }
}

/* -------------------------------------------- */
/*  Reports (relay action `persistent`)          */
/* -------------------------------------------- */

const SUBS = new Set(["useStarted", "useCancelled"]);

/** Payload of the relay action `persistent` (relay/queries.mjs VALID). */
export function validPersistentReport(d) {
  return !!d && typeof d === "object" && !Array.isArray(d) && SUBS.has(d.sub)
    && typeof d.parentMessageId === "string" && /^[A-Za-z0-9]{1,64}$/.test(d.parentMessageId)
    && typeof d.runId === "string" && d.runId.length > 0 && d.runId.length <= 40;
}

/**
 * Active GM: a re-roll follow-up's report. Re-validated here: an expectation of that use with that runId, sent by a
 * GM or an owner of the use's user. `useCancelled` drops the expectation (the use stays kept, a note says so).
 * @returns {Promise<{ok: boolean}>}
 */
export async function handlePersistentReport(data, user) {
  const x = expected.get(data?.parentMessageId);
  if (!x || x.runId !== data.runId) {
    debug("persistent.reportStale", { parentMessageId: data?.parentMessageId, sub: data?.sub });
    return { ok: false };
  }
  const actor = lookup(x.actorUuid);
  const owns = !!user?.isGM || ownersOf(actor).some(u => u.id === user?.id) || !!actor?.testUserPermission?.(user, "OWNER");
  if (!owns) throw new Error("DSAUTO.Relay.Denied");
  if (data.sub === "useCancelled") {
    consumeReroll(data.parentMessageId);
    const combat = game.combats?.get?.(x.combatId) ?? null;
    const entry = rawEntry(combat, data.parentMessageId) ?? { messageId: data.parentMessageId, actorUuid: x.actorUuid, abilityName: "" };
    await postNote(entry, loc("DSAUTO.Persistent.RerollCancelled", { ability: entry.abilityName }), "rerollCancelled");
  }
  log("persistent.report", { parentMessageId: data.parentMessageId, sub: data.sub, user: user?.name });
  return { ok: true };
}
