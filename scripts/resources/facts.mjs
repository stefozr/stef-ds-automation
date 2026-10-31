/**
 * Facts for event gains (Milestone 7, docs/M7-DESIGN.md §2.1 WP-A, §3.1, §3.4, §3.5): what happened, independent of who
 * gains from it. Pure given documents (reads actors, tokens and chat messages; writes nothing); the active GM calls them.
 *
 *   DamageFact  {kind:"damage", id, sceneId, takers:[{actorUuid, tokenUuid}], dealer:{actorUuid, tokenUuid, director},
 *                dealt, type, surges, before:{value,temporary}|null, after:{...}|null, staminaMax, windedAt,
 *                messageId|null, opIds:[...], external, vouched: "gm" | "player"}
 *   ForcedFact  {kind:"forcedMove", id, sceneId, mover:{actorUuid, tokenUuid}, squares, messageId|null, opIds:[...]}
 *   UseFact     {kind:"abilityUse", id, sceneId, user:{actorUuid, tokenUuid, isHero, isNpc}, itemUuid, category,
 *                actionType, costsMalice, turnKey, messageId}
 *   RollFact    {kind:"naturalRoll", id, sceneId, roller:{actorUuid, tokenUuid}, natural, messageId}
 *   WindedFact  {kind:"winded", id, sceneId, taker:{actorUuid, tokenUuid, isHero}, states, messageId|null, opIds:[...]}
 *   DeathFact   {kind:"heroDeath", id, sceneId, taker:{actorUuid, tokenUuid, isHero: true}, dedupeKey, causeMessageId|null}
 *
 * - "You take damage" is false when immunity ate the hit: a damage fact needs a real drop of Stamina (temporary Stamina
 *   included: a hit fully absorbed by temporary Stamina is still taken, RES:1152-1154).
 * - Several ops of one call on one target (a base hit and its surges) make one fact; squad ops measure the pool.
 * - Winded and dying crossings come from the measured before/after only (never a client's word); a winded fact copies
 *   its damage's `opIds`, so undoing the hit cascades to its gain (C20).
 * i18n keys: none.
 */
import { OP_STATUS } from "../constants.mjs";
import { opSource } from "../engine/damage.mjs";
import { combatFor, uuidKey } from "../triggers/budget.mjs";
import { tokenOnScene } from "../triggers/eligibility.mjs";

/** Array view of a Foundry collection, a Map or an array (harness mocks). */
function list(c) {
  if (!c) return [];
  if (Array.isArray(c)) return c;
  if (Array.isArray(c.contents)) return c.contents;
  if (typeof c.values === "function") return [...c.values()];
  return [];
}

function lookup(uuid) {
  if (!uuid || typeof uuid !== "string") return null;
  try {
    return fromUuidSync(uuid);
  } catch (_err) {
    return null;
  }
}

/** Damage type as facts carry it: lowercase, untyped = "" (Combat Tools passes "untyped", DSCT/helpers.mjs:96). */
export const normType = t => {
  const s = String(t ?? "").toLowerCase();
  return s === "untyped" ? "" : s;
};

/** value + temporary of a snapshot. */
export const total = s => (Number(s?.value) || 0) + (Number(s?.temporary) || 0);

/** The scene id inside a token uuid ("Scene.<id>.Token.<id>"). */
export function sceneIdOf(tokenUuid) {
  const m = /Scene\.([A-Za-z0-9]{16})/.exec(String(tokenUuid ?? ""));
  return m ? m[1] : null;
}

/** The scene of an actor: its token's scene (synthetic actor), else its token on a started combat's scene. */
function actorScene(actor, tokenUuid = null) {
  return sceneIdOf(tokenUuid) ?? actor?.token?.parent?.id ?? null;
}

const party = (actor, tokenUuid = null) => ({ actorUuid: actor?.uuid ?? null, tokenUuid: tokenUuid ?? actor?.token?.uuid ?? null });

/** Who dealt the damage of a card (§3.1 dealerOf): the record's source; "director" = an NPC, or a GM card with no source. */
export function dealerOf(res) {
  const actorUuid = res?.sourceActorUuid ?? null;
  const actor = lookup(actorUuid);
  const director = actor ? actor.type === "npc" : (!actorUuid && Number(res?.authorRole ?? 0) >= 3);
  return { actorUuid, tokenUuid: res?.sourceTokenUuid ?? null, director: !!director };
}

/** Dealer from a GM-observed external change's known source (Target Damage state, a report). */
function dealerFromSource(source) {
  const actorUuid = source?.actorUuid ?? null;
  const actor = lookup(actorUuid) ?? lookup(source?.tokenUuid)?.actor ?? null;
  return { actorUuid: actor?.uuid ?? actorUuid, tokenUuid: source?.tokenUuid ?? null, director: actor?.type === "npc" };
}

function staminaInfo(actorUuid) {
  const st = lookup(actorUuid)?.system?.stamina ?? null;
  const max = Number(st?.max);
  const winded = Number(st?.winded);
  return {
    staminaMax: Number.isFinite(max) ? max : null,
    windedAt: Number.isFinite(winded) ? winded : (Number.isFinite(max) ? Math.floor(max / 2) : null),
  };
}

/**
 * Facts of one applyOpList call from its patches: damage of applied damage/surge ops, applied forced moves, and the
 * winded/dying crossings of those hits. `ops` is the call's op list (created ops such as hero-token heals included).
 */
export function factsFromPatches(message, resLive, ops, patches) {
  const byInstance = new Map();
  const forced = [];
  const opsById = new Map((ops ?? []).map(o => [o?.opId, o]));
  const record = k => {
    const t = resLive?.targets?.[k];
    return { actorUuid: t?.actorUuid ?? null, tokenUuid: t?.tokenUuid ?? null };
  };
  const messageId = message?.id ?? null;
  for (const [id, p] of Object.entries(patches ?? {})) {
    if (p?.status !== OP_STATUS.APPLIED) continue;
    const op = opsById.get(id) ?? resLive?.ops?.[id];
    if (!op || op.heroToken) continue;   // a heal, not a fact
    if (op.kind === "damage") {
      const base = op.surge ? (resLive?.ops?.[op.surge.baseOpId] ?? op) : op;
      const keys = op.targetKeys ?? [];
      if (!keys.length) continue;
      let dealt;
      let takers;
      if (op.group) {
        takers = keys.map(record);
        dealt = (Number(p.before?.staminaValue) || 0) - (Number(p.after?.staminaValue) || 0);
      } else {
        takers = [record(keys[0])];
        dealt = total(p.before) - total(p.after);
      }
      if (!(dealt > 0)) continue;   // immunity ate it: "you take damage" is false
      const key = `${messageId}:${op.group ?? keys[0]}`;
      let f = byInstance.get(key);
      if (!f) {
        let type = base.type;
        if (type === undefined) {
          try {
            type = opSource(message, base)?.type;
          } catch (_err) { /* roll gone */ }
        }
        f = {
          kind: "damage", id: key, sceneId: sceneIdOf(takers[0]?.tokenUuid), takers, dealer: dealerOf(resLive),
          dealt: 0, type: normType(type), surges: 0, before: op.group ? null : (p.before ?? null), after: null,
          ...(op.group ? { staminaMax: null, windedAt: null } : staminaInfo(takers[0]?.actorUuid)),
          messageId, opIds: [], external: false, vouched: "gm", baseOpId: base.opId,
        };
        byInstance.set(key, f);
      }
      f.dealt += dealt;
      f.after = op.group ? null : (p.after ?? null);
      f.opIds.push(id);
      f.surges = damageSurges(resLive, patches, opsById, f.baseOpId);
    } else if (op.kind === "forced" && ((Number(p.movedDistance) || 0) > 0 || p.moves?.length)) {
      const mover = record(op.targetKeys?.[0]);
      forced.push({
        kind: "forcedMove", id: `${messageId}:${id}`, sceneId: sceneIdOf(mover.tokenUuid), mover,
        squares: Number(p.movedDistance) || 1, messageId, opIds: [id],
      });
    }
  }
  const damage = [...byInstance.values()];
  for (const f of damage) delete f.baseOpId;
  return [...damage, ...forced, ...damage.flatMap(windedFacts)];
}

/** Applied damage surges of a base op (potency surges do not count, R17), this call's patches included. */
function damageSurges(resLive, patches, opsById, baseOpId) {
  if (!baseOpId) return 0;
  const seen = new Set();
  const base = resLive?.ops?.[baseOpId] ?? opsById.get(baseOpId);
  let n = (patches?.[baseOpId]?.status ?? base?.status) === OP_STATUS.APPLIED ? Number(base?.surgeSpend?.count ?? base?.nativeSurges ?? 0) : 0;
  const count = (o, status) => {
    if (!o || seen.has(o.opId) || o.surge?.kind !== "damage" || o.surge.baseOpId !== baseOpId) return;
    if (status !== OP_STATUS.APPLIED) return;
    seen.add(o.opId);
    n += Number(o.surge.count) || 0;
  };
  for (const [id, p] of Object.entries(patches ?? {})) count(opsById.get(id) ?? resLive?.ops?.[id], p?.status);
  for (const o of Object.values(resLive?.ops ?? {})) count(o, patches?.[o?.opId]?.status ?? o?.status);
  return n;
}

/**
 * The fact of one GM-observed external change (§3.4); null when nothing was dealt.
 * @param {object} change   a Stamina-watch change {id, actorUuid, groupUuid, tokenUuid?, before, after, userId}
 * @param {object} extra    {type, source, vouched, surges?, taker?: {actorUuid, tokenUuid}, messageId?}
 */
export function externalDamageFact(change, extra = {}) {
  if (!change) return null;
  const dealt = total(change.before) - total(change.after);
  if (!(dealt > 0)) return null;
  const taker = extra.taker?.actorUuid
    ? { actorUuid: extra.taker.actorUuid, tokenUuid: extra.taker.tokenUuid ?? null }
    : { actorUuid: change.actorUuid ?? null, tokenUuid: change.tokenUuid ?? null };
  if (!taker.actorUuid) return null;
  if (!taker.tokenUuid) taker.tokenUuid = lookup(taker.actorUuid)?.token?.uuid ?? null;
  const pool = !!change.groupUuid;
  const actor = lookup(taker.actorUuid);
  const sceneId = sceneIdOf(taker.tokenUuid) ?? actorScene(actor) ?? tokenOnScene(actor, null)?.parent?.id ?? null;
  return {
    kind: "damage", id: `watch:${change.id}`, sceneId, takers: [taker], dealer: dealerFromSource(extra.source),
    dealt, type: normType(extra.type), surges: Math.max(0, Number(extra.surges) || 0),
    before: pool ? null : { value: Number(change.before?.value) || 0, temporary: Number(change.before?.temporary) || 0 },
    after: pool ? null : { value: Number(change.after?.value) || 0, temporary: Number(change.after?.temporary) || 0 },
    ...(pool ? { staminaMax: null, windedAt: null } : staminaInfo(taker.actorUuid)),
    messageId: extra.messageId ?? null, opIds: [], external: true, vouched: extra.vouched === "player" ? "player" : "gm",
  };
}

/** WindedFact[] of a single-taker damage fact: before above the threshold, after at or below (§3.1). */
export function windedFacts(fact) {
  if (!fact || fact.kind !== "damage" || fact.takers?.length !== 1 || !fact.before || !fact.after) return [];
  const taker = fact.takers[0];
  const actor = lookup(taker.actorUuid);
  const isHero = actor?.type === "hero";
  const windedAt = fact.windedAt ?? staminaInfo(taker.actorUuid).windedAt;
  const b = Number(fact.before.value);
  const a = Number(fact.after.value);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return [];
  const states = [];
  if (Number.isFinite(windedAt) && b > windedAt && a <= windedAt) states.push("winded");
  if (isHero && b > 0 && a <= 0) states.push("dying");
  if (!states.length) return [];
  return [{
    kind: "winded", id: `${fact.id}:winded`, sceneId: fact.sceneId, taker: { ...taker, isHero }, states,
    messageId: fact.messageId ?? null, opIds: [...(fact.opIds ?? [])],
  }];
}

/** Parts of a chat message as an array. */
function partsOf(message) {
  try {
    return list(message?.system?.parts);
  } catch (_err) {
    return [];
  }
}

/** The speaker's actor and token of a message (the speaker token on its scene, else the actor's token there). */
function speakerOf(message, fallbackActor = null) {
  let actor = null;
  try {
    actor = globalThis.ChatMessage?.getSpeakerActor?.(message?.speaker) ?? null;
  } catch (_err) { /* no speaker */ }
  actor ??= fallbackActor;
  const sceneId = message?.speaker?.scene ?? null;
  let tokenDoc = null;
  try {
    const scene = sceneId ? game.scenes?.get?.(sceneId) : null;
    tokenDoc = message?.speaker?.token ? (scene?.tokens?.get?.(message.speaker.token) ?? null) : null;
  } catch (_err) { /* scene gone */ }
  tokenDoc ??= actor?.token ?? tokenOnScene(actor, sceneId);
  return { actor, tokenDoc, sceneId: sceneId ?? tokenDoc?.parent?.id ?? null };
}

/** The current combat turn key (`heroesInTurn`, §3.2): `${combat.id}:${round}:${turn}:${combatantId}`. */
export function turnKeyOf(combat) {
  if (!combat?.started) return null;
  return `${combat.id}:${combat.round}:${combat.turn}:${combat.combatant?.id ?? ""}`;
}

/** The abilityUse fact of an ability card (its `abilityUse` part, budget.mjs:274-276 pattern); null otherwise. */
export function useFactOf(message) {
  const use = partsOf(message).find(p => p?.type === "abilityUse");
  if (!use?.abilityUuid) return null;
  const item = lookup(use.abilityUuid);
  if (!item) return null;
  const { actor, tokenDoc, sceneId } = speakerOf(message, item.actor ?? null);
  const user = actor ?? item.actor ?? null;
  if (!user) return null;
  const isNpc = user.type === "npc";
  const cost = Number(item.system?.resource);
  return {
    kind: "abilityUse", id: `use:${message.id}`, sceneId,
    user: { actorUuid: user.uuid, tokenUuid: tokenDoc?.uuid ?? null, isHero: user.type === "hero", isNpc },
    itemUuid: item.uuid, category: item.system?.category ?? "", actionType: item.system?.type ?? "",
    costsMalice: isNpc && Number.isFinite(cost) && cost > 0,
    turnKey: turnKeyOf(combatFor(sceneId)), messageId: message.id,
  };
}

function naturalOf(roll) {
  try {
    const PowerRoll = globalThis.ds?.rolls?.PowerRoll;
    if (PowerRoll && !(roll instanceof PowerRoll)) return null;
    const n = Number(roll?.naturalResult);
    return Number.isInteger(n) && n >= 2 && n <= 20 ? n : null;
  } catch (_err) {
    return null;
  }
}

/**
 * Natural power-roll facts of a message: per part the LAST power roll (a reroll replaces the earlier one, DSM:20224);
 * a message without rolling parts uses its own rolls. The roller is the speaker's actor.
 * Draw Steel 1.2 (Milestone 8, D6): a card with `targetResult` parts has one part per target, all sharing one d10
 * (R1 §3.7): only the first such part counts, so the card makes ONE fact (`roll:<messageId>:0`).
 */
export function rollFactsOf(message) {
  const naturals = [];
  let parts = partsOf(message).filter(p => list(p?.rolls).length);
  const perTarget = parts.filter(p => p?.type === "targetResult");
  if (perTarget.length) parts = perTarget.slice(0, 1);
  const lists = parts.length ? parts.map(p => list(p.rolls)) : [list(message?.rolls)];
  for (const rolls of lists) {
    const last = [...rolls].reverse().map(naturalOf).find(n => n != null);
    if (last != null) naturals.push(last);
  }
  if (!naturals.length) return [];
  const { actor, tokenDoc, sceneId } = speakerOf(message);
  if (!actor) return [];
  return naturals.map((natural, i) => ({
    kind: "naturalRoll", id: `roll:${message.id}:${i}`, sceneId,
    roller: { actorUuid: actor.uuid, tokenUuid: tokenDoc?.uuid ?? null }, natural, messageId: message.id,
  }));
}

/** A forced move of a token (a passed waypoint with action "forced"), null otherwise. */
export function forcedFactOf(tokenDoc, movement) {
  const waypoints = list(movement?.passed?.waypoints);
  const steps = waypoints.filter(w => w?.action === "forced").length;
  if (!steps || !tokenDoc?.actor) return null;
  return {
    kind: "forcedMove", id: `move:${movement?.id ?? tokenDoc.id}`, sceneId: tokenDoc.parent?.id ?? sceneIdOf(tokenDoc.uuid),
    mover: party(tokenDoc.actor, tokenDoc.uuid), squares: steps, messageId: null, opIds: [],
  };
}

/** A hero's death (the defeated status): the dead hero is the dedupe key, the killing card (if any) the cause. */
export function deathFactOf(actor, { causeMessageId = null } = {}) {
  if (actor?.type !== "hero") return null;
  const tokenDoc = actor.token ?? tokenOnScene(actor, null);
  return {
    kind: "heroDeath", id: `death:${uuidKey(actor.uuid)}:${Date.now()}`, sceneId: tokenDoc?.parent?.id ?? null,
    taker: { actorUuid: actor.uuid, tokenUuid: tokenDoc?.uuid ?? null, isHero: true },
    dedupeKey: uuidKey(actor.uuid), causeMessageId: causeMessageId ?? null,
  };
}
