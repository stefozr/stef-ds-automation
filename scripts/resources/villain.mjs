/**
 * Villain-action bookkeeping (Milestone 7, docs/M7-DESIGN.md §1.6, §2.1 WP-A, §3.9, R1, Q6). Active GM writes; any client
 * reads.
 *
 * Rules text: each villain action once per encounter, and "no more than one villain action can be used per round (this
 * holds even if you have two or more creatures with villain actions)". Warnings only, nothing is blocked.
 * - `createChatMessage` (active GM, setting `villainActionTracking`): an NPC's ability card of type `villain` in a
 *   started combat is recorded on the Combat (`villainActions`: `used[actor][dsid]` once, `rounds[round]` one entry for
 *   ANY villain, older rounds dropped with the first write of a round) on the villain chain. A reuse, or a second
 *   villain action in the round, whispers the Directors.
 * - `villainWarnings(item, message)` (engine resolveMessage, sync): the banner codes of that card, from what the
 *   observer decided for the message (`pending`), else from the flag and the in-memory mirror excluding this message's
 *   own entries, so both orders (observer first, resolve first) agree (H23).
 * - `deleteChatMessage` (active GM): entries of that message are removed (a mistaken use is retracted).
 * The in-memory mirror holds entries whose write is still queued, so two cards in one tick see each other.
 * i18n keys: DSAUTO.Villain.Reused, DSAUTO.Villain.Again, DSAUTO.Warning.villainActionReused,
 * DSAUTO.Warning.villainActionRound.
 */
import * as C from "../constants.mjs";
import { MODULE_ID, loc } from "../constants.mjs";
import { itemDsid } from "../library/identity.mjs";
import { error, log } from "../log.mjs";
import { setting } from "../settings.mjs";
import { whisperGMs } from "../summons/registry.mjs";
import { combatFor, uuidKey } from "../triggers/budget.mjs";

const VILLAIN_FLAG = () => C.VILLAIN_FLAG ?? "villainActions";
const MAX_PENDING = 200;

const pending = new Map();   // messageId -> {reused, another}
const mirror = new Map();    // combatId -> {used: {key: {dsid: entry}}, rounds: {round: entry}} (writes in flight)
let villainChain = Promise.resolve();

const isActiveGM = () => !!game.users?.activeGM?.isSelf;
const ForcedDeletion = () => new foundry.data.operators.ForcedDeletion();
const flagPath = () => `flags.${MODULE_ID}.${VILLAIN_FLAG()}`;
const INTERNAL = () => ({ [MODULE_ID]: { internal: true } });
const tracking = () => (setting("villainActionTracking") ?? true) && setting("enabled") !== false;

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

function onChain(fn) {
  const run = villainChain.catch(() => {}).then(fn);
  villainChain = run.catch(() => {});
  return run;
}

/** The villain ability of an ability card and its NPC user, or null. */
function villainUseOf(message) {
  const use = list(message?.system?.parts).find(p => p?.type === "abilityUse");
  const item = lookup(use?.abilityUuid);
  if (item?.system?.type !== "villain" || item.actor?.type !== "npc") return null;
  return { item, actor: item.actor };
}

/** The flag state merged with the in-memory mirror (entries of `skipMessageId` left out). */
function stateOf(combat, skipMessageId = null) {
  const st = combat?.flags?.[MODULE_ID]?.[VILLAIN_FLAG()] ?? {};
  const m = mirror.get(combat?.id) ?? { used: {}, rounds: {} };
  const used = {};
  for (const src of [st.used ?? {}, m.used]) {
    for (const [key, byDsid] of Object.entries(src)) {
      for (const [dsid, e] of Object.entries(byDsid ?? {})) {
        if (!e || e.messageId === skipMessageId) continue;
        used[key] ??= {};
        used[key][dsid] ??= e;
      }
    }
  }
  const rounds = {};
  for (const src of [st.rounds ?? {}, m.rounds]) {
    for (const [round, e] of Object.entries(src)) if (e && e.messageId !== skipMessageId) rounds[round] ??= e;
  }
  return { used, rounds };
}

function remember(messageId, value) {
  pending.set(messageId, value);
  if (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
}

function dropMirror(combatId, messageId) {
  const m = mirror.get(combatId);
  if (!m) return;
  for (const byDsid of Object.values(m.used)) for (const [dsid, e] of Object.entries(byDsid)) if (e.messageId === messageId) delete byDsid[dsid];
  for (const [round, e] of Object.entries(m.rounds)) if (e.messageId === messageId) delete m.rounds[round];
}

/** Record a villain action card (§3.9). */
function observe(message) {
  if (!isActiveGM() || !tracking() || !message?.id) return;
  const vu = villainUseOf(message);
  if (!vu) return;
  const { item, actor } = vu;
  const sceneId = message.speaker?.scene ?? actor.token?.parent?.id ?? null;
  const combat = combatFor(sceneId);
  if (!combat?.started) return;
  const key = uuidKey(actor.uuid);
  const dsid = itemDsid(item);
  if (!dsid) return;
  const round = combat.round;
  const st = stateOf(combat, message.id);
  const prevUse = st.used[key]?.[dsid] ?? null;
  const prior = st.rounds[round] ?? null;
  remember(message.id, { reused: !!prevUse, another: prior });
  const entry = { round, messageId: message.id, at: Date.now(), name: item.name ?? dsid };
  const roundEntry = { actorUuid: actor.uuid, dsid, name: item.name ?? dsid, actorName: actor.name ?? "", messageId: message.id };
  // Mirror first (sync): a second card in the same tick sees this one.
  const m = mirror.get(combat.id) ?? { used: {}, rounds: {} };
  mirror.set(combat.id, m);
  if (!prevUse) (m.used[key] ??= {})[dsid] ??= entry;
  if (!prior) m.rounds[round] ??= roundEntry;
  onChain(async () => {
    const live = game.combats?.get?.(combat.id) ?? combat;
    if (!live) return;
    const flag = live.flags?.[MODULE_ID]?.[VILLAIN_FLAG()] ?? {};
    const update = {};
    if (!flag.used?.[key]?.[dsid]) update[`${flagPath()}.used.${key}.${dsid}`] = entry;
    if (!flag.rounds?.[round]) {
      update[`${flagPath()}.rounds.${round}`] = roundEntry;
      for (const r of Object.keys(flag.rounds ?? {})) if (Number(r) < round) update[`${flagPath()}.rounds.${r}`] = ForcedDeletion();
    }
    if (Object.keys(update).length) await live.update(update, INTERNAL());
  }).catch(err => error("villain.record", err))
    .finally(() => dropMirror(combat.id, message.id));
  if (prevUse) whisperGMs(loc("DSAUTO.Villain.Reused", { name: actor.name ?? "", ability: item.name ?? dsid }));
  if (prior) whisperGMs(loc("DSAUTO.Villain.Again", { name: prior.actorName || lookup(prior.actorUuid)?.name || "", ability: prior.name ?? prior.dsid ?? "" }));
  log("villain.use", { actor: actor.name, ability: item.name, round, reused: !!prevUse, another: !!prior });
}

/** Warnings for a villain-action card being resolved: [{code: "villainActionReused"|"villainActionRound"}]. Sync. */
export function villainWarnings(item, message) {
  try {
    if (!tracking() || item?.system?.type !== "villain" || item.actor?.type !== "npc" || !message?.id) return [];
    let p = pending.get(message.id);
    if (!p) {
      const combat = combatFor(message.speaker?.scene ?? item.actor.token?.parent?.id ?? null);
      if (!combat?.started) return [];
      const st = stateOf(combat, message.id);
      p = { reused: !!st.used[uuidKey(item.actor.uuid)]?.[itemDsid(item)], another: st.rounds[combat.round] ?? null };
    }
    const out = [];
    if (p.reused) out.push({ code: "villainActionReused" });
    if (p.another) out.push({ code: "villainActionRound" });
    return out;
  } catch (err) {
    error("villain.warnings", err);
    return [];
  }
}

/** Villain actions an NPC used in a combat: [{dsid, name, round, messageId}]. Any client. */
export function villainUsed(actor, combat) {
  const a = typeof actor === "string" ? (lookup(actor)?.actor ?? lookup(actor)) : (actor?.actor ?? actor);
  const c = combat ?? combatFor(a?.token?.parent?.id ?? null);
  if (!a?.uuid || !c) return [];
  const used = stateOf(c).used[uuidKey(a.uuid)] ?? {};
  return Object.entries(used).map(([dsid, e]) => ({ dsid, name: e.name ?? dsid, round: e.round ?? null, messageId: e.messageId ?? null }))
    .sort((x, y) => (x.round ?? 0) - (y.round ?? 0));
}

/** Active GM: forget one NPC's (or every) villain marker of a combat. */
export async function resetVillain(actor = null, combat = undefined) {
  if (!isActiveGM()) return false;
  const a = typeof actor === "string" ? (lookup(actor)?.actor ?? lookup(actor)) : (actor?.actor ?? actor);
  const c = combat ?? combatFor(a?.token?.parent?.id ?? null);
  if (!c) return false;
  return onChain(async () => {
    const live = game.combats?.get?.(c.id) ?? c;
    const flag = live.flags?.[MODULE_ID]?.[VILLAIN_FLAG()];
    if (!a) {
      mirror.delete(c.id);
      if (flag) await live.update({ [flagPath()]: ForcedDeletion() }, INTERNAL());
      log("villain.reset", { combat: c.id, all: true });
      return true;
    }
    const key = uuidKey(a.uuid);
    const m = mirror.get(c.id);
    if (m) {
      delete m.used[key];
      for (const [r, e] of Object.entries(m.rounds)) if (e.actorUuid === a.uuid) delete m.rounds[r];
    }
    const update = {};
    if (flag?.used?.[key]) update[`${flagPath()}.used.${key}`] = ForcedDeletion();
    for (const [r, e] of Object.entries(flag?.rounds ?? {})) if (e?.actorUuid === a.uuid) update[`${flagPath()}.rounds.${r}`] = ForcedDeletion();
    if (Object.keys(update).length) await live.update(update, INTERNAL());
    log("villain.reset", { combat: c.id, actor: a.name });
    return true;
  });
}

/** A deleted card retracts its entries. */
function forget(message) {
  if (!isActiveGM() || !message?.id) return;
  pending.delete(message.id);
  for (const combat of list(game.combats)) {
    dropMirror(combat.id, message.id);
    const flag = combat.flags?.[MODULE_ID]?.[VILLAIN_FLAG()];
    if (!flag) continue;
    const hits = [];
    for (const [key, byDsid] of Object.entries(flag.used ?? {})) {
      for (const [dsid, e] of Object.entries(byDsid ?? {})) if (e?.messageId === message.id) hits.push(`used.${key}.${dsid}`);
    }
    for (const [r, e] of Object.entries(flag.rounds ?? {})) if (e?.messageId === message.id) hits.push(`rounds.${r}`);
    if (!hits.length) continue;
    onChain(async () => {
      const live = game.combats?.get?.(combat.id);
      if (!live) return;
      await live.update(Object.fromEntries(hits.map(h => [`${flagPath()}.${h}`, ForcedDeletion()])), INTERNAL());
      log("villain.forget", { messageId: message.id, entries: hits.length });
    }).catch(err => error("villain.forget", err));
  }
}

/** init: createChatMessage (record + whisper), deleteChatMessage (forget), deleteCombat (the flag goes with it). */
export function registerVillainTracking() {
  Hooks.on("createChatMessage", message => {
    try {
      observe(message);
    } catch (err) {
      error("villain.record", err);
    }
  });
  Hooks.on("deleteChatMessage", message => {
    try {
      forget(message);
    } catch (err) {
      error("villain.forget", err);
    }
  });
  Hooks.on("deleteCombat", combat => {
    try {
      if (combat?.id) mirror.delete(combat.id);
    } catch (err) {
      error("villain.deleteCombat", err);
    }
  });
}
