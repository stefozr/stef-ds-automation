/**
 * Milestone 9 (docs/M9-DESIGN.md §C, WP-C): Persistent ability uses. An overlay's `persistent` (library/schema.mjs)
 * says what keeping a use does; the resolve write records it on the card (`res.persistent = {cost, keep, targets,
 * note, parent, free}`, `persistentRecord`, null when off) and the active GM indexes the use on the Combat
 * (`flags["stef-ds-automation"].persistent[messageId]`, the summons index pattern) on `HOOKS.resolved`.
 *
 * - One promise chain (`withPersistentChain`) serializes index writes and the upkeep payment. Allowed waits (as M6
 *   §6.1): lifecycle -> chain; chain -> a NEW card's lock (the Keep card). Never from inside the chain: `endUse`,
 *   `patchEntry` without `onChain` (they queue on it).
 * - Lifetime (active GM): the user's turn start after the use (`counts(armStart, ">")`, turn/arms.mjs) offers the
 *   upkeep through persistent/upkeep.mjs (fire-and-forget: the lifecycle queue never waits on a prompt), unless the
 *   use was kept this round already, or it only re-rolls and no target is left within distance (released at once,
 *   `outOfDistance`). The user's turn end releases a use whose prompt is still open (`turnEnd`, M6 Q16). The end of
 *   the encounter cancels open prompts and lets every use of that combat go quietly.
 * - Keep effects: "extend" holds the use's effects (turn/until.mjs hold `persistent`: `holdsEffect`) and its aura
 *   (`holdsAura`, features/auras.mjs) while the use is active; "reroll" makes the power roll again for free
 *   (persistent/reroll.mjs). A re-roll's card becomes the use's new entry (`parent`, `kept` carried); the old one is
 *   marked superseded (`supersededBy`) without ending anything, and `entryOf` follows that link, so effects and the
 *   aura of the first card stay held by the chain of re-rolls.
 * - `endUse`: deactivate first (the holds release), then end the use's held effects (`expireEffect`; base-only and
 *   save-ends effects stay), turn its aura off when it was kept (or ends at turn start anyway), post the note card
 *   (DSAUTO.Persistent.Released, quiet for the encounter end) and call `HOOKS.persistentEnd`.
 *
 * i18n keys used here: DSAUTO.Persistent.Released, DSAUTO.Persistent.End.<PERSISTENT_END> (dynamic).
 */
import { HOOKS, MODULE_ID, loc } from "../constants.mjs";
import { sideOnly } from "../engine/record.mjs";
import { auraDefinition, setAura } from "../features/auras.mjs";
import { resolveAbility } from "../library/resolve.mjs";
import { debug, error, log } from "../log.mjs";
import { setting } from "../settings.mjs";
import { buildArm, counts } from "../turn/arms.mjs";
import * as lifecycle from "../turn/lifecycle.mjs";
import { expireEffect, registerHold, untilSpecs } from "../turn/until.mjs";
import { matchReroll, dropRerolls, rerollTargets } from "./reroll.mjs";
import { cancelPersistentUpkeep, cancelPersistentUpkeepsOf, offerPersistentUpkeep, registerPersistentUpkeepGM } from "./upkeep.mjs";

/** Why a use ended (`endedReason`); every one but `superseded` and `encounterEnd` posts the note card. */
export const PERSISTENT_END = Object.freeze(["released", "timedOut", "cannotPay", "noOwner", "outOfDistance", "turnEnd", "encounterEnd", "superseded", "gone"]);
/** Dialog and banner variants of a keep list (`keepKeyOf`). */
export const PERSISTENT_KEEP_KEYS = Object.freeze(["reroll", "extend", "both", "manual"]);
/** The until.mjs hold name of an extended use's effects. */
export const PERSISTENT_HOLD = "persistent";

const QUIET = new Set(["encounterEnd", "superseded"]);
const MAX_LINKS = 50;
const indexPath = id => `flags.${MODULE_ID}.persistent.${id}`;
const serverNow = () => game.time?.serverTime ?? Date.now();
const isActiveGM = () => !!game.users?.activeGM?.isSelf;
const enabled = () => setting("persistentUpkeep") !== false;

let chain = Promise.resolve();
let orderSeq = 0;
let registered = false;

/** Array view of a Foundry collection, a Map or an array (harness mocks). */
function list(c) {
  if (!c) return [];
  if (Array.isArray(c)) return c;
  if (Array.isArray(c.contents)) return c.contents;
  if (typeof c.values === "function") return [...c.values()];
  return [];
}

function lookup(uuid) {
  if (!uuid) return null;
  try {
    return fromUuidSync(uuid) ?? null;
  } catch (_err) {
    return null;
  }
}

/** The live Combat document of an id or a (possibly stale) document; null when it is gone. */
function liveCombat(combat) {
  const id = typeof combat === "string" ? combat : combat?.id;
  if (!id) return null;
  if (!game.combats) return typeof combat === "object" ? combat : null;
  return game.combats.get?.(id) ?? null;
}

/* -------------------------------------------- */
/*  Chain                                       */
/* -------------------------------------------- */

/** Serialize Persistent index work on one promise chain. Resolves with fn's value; a failure does not break it. */
export function withPersistentChain(fn) {
  const run = chain.catch(() => {}).then(() => fn());
  chain = run.catch(() => {});
  return run;
}

/* -------------------------------------------- */
/*  Readers (any client)                        */
/* -------------------------------------------- */

/** The keep list as a dialog / banner key: reroll | extend | both | manual. */
export function keepKeyOf(keep) {
  const k = [keep].flat();
  if (k.includes("reroll") && k.includes("extend")) return "both";
  if (k.includes("reroll")) return "reroll";
  if (k.includes("extend")) return "extend";
  return "manual";
}

/** Index entries of a combat, [] when none, in creation order. */
export function persistentEntries(combat) {
  const index = combat?.flags?.[MODULE_ID]?.persistent;
  if (!index || typeof index !== "object") return [];
  return Object.values(index).filter(e => e && typeof e === "object" && typeof e.messageId === "string").sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** The entry of exactly this card (no supersede link followed), or null. */
export function rawEntry(combat, messageId) {
  const e = messageId ? combat?.flags?.[MODULE_ID]?.persistent?.[messageId] : null;
  return e && typeof e === "object" && e.messageId === messageId ? e : null;
}

/** The entry that now speaks for a card: its own, or the re-roll that superseded it (followed to the last). */
export function entryOf(combat, messageId) {
  let e = rawEntry(combat, messageId);
  for (let i = 0; e?.supersededBy && i < MAX_LINKS; i++) e = rawEntry(combat, e.supersededBy) ?? e;
  return e;
}

/** Message ids of a use's chain of cards, newest first (the entry and every parent). */
export function chainIds(combat, entry) {
  const out = [];
  for (let e = entry, i = 0; e && i < MAX_LINKS && !out.includes(e.messageId); i++) {
    out.push(e.messageId);
    e = e.parent ? rawEntry(combat, e.parent) : null;
  }
  return out;
}

/** The Combat an effect's until spec names, else the viewed one. */
const combatOfSpec = (spec, combat) => liveCombat(spec?.combatId) ?? combat ?? game.combat ?? null;

/**
 * until.mjs hold `persistent`: the effect's card (flags["stef-ds-automation"].messageId) has an active Persistent use that
 * extends. Setting off: nothing is held.
 */
export function holdsEffect(effect, spec, combat = null) {
  if (!enabled()) return false;
  const messageId = effect?.flags?.[MODULE_ID]?.messageId;
  const e = messageId ? entryOf(combatOfSpec(spec, combat), messageId) : null;
  return !!e?.active && [e.keep].flat().includes("extend");
}

/**
 * features/auras.mjs: is this aura held by an active Persistent use that extends (its activation card or a re-roll
 * of it)? `{held: true, kept}` (kept: the use was kept at least once), else null.
 */
export function holdsAura(item, combat = null) {
  if (!enabled()) return null;
  const messageId = item?.flags?.[MODULE_ID]?.aura?.sourceMessageId;
  const live = liveCombat(combat) ?? combat ?? game.combat ?? null;
  const e = messageId ? entryOf(live, messageId) : null;
  if (!e?.active || ![e.keep].flat().includes("extend")) return null;
  return { held: true, kept: (Number(e.kept) || 0) > 0 };
}

/** library-apply.mjs: does a use of this item hold its "until the start of your next turn" effects (setting on)? */
export function extendsUse(item) {
  if (!enabled() || !item) return false;
  try {
    return [resolveAbility(item).persistent?.keep ?? []].flat().includes("extend");
  } catch (_err) {
    return false;
  }
}

/* -------------------------------------------- */
/*  The resolve record                          */
/* -------------------------------------------- */

/** The essence of the item's own Persistent special effect (Draw Steel PersistentSpecialEffect#essence), or null. */
export function persistentCost(item) {
  const effects = item?.system?.effects;
  const all = list(effects);
  const e = all.find(x => x?.type === "persistent");
  const n = Number(e?.essence);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The started combat the use belongs to: the viewed one when the user fights in it, else another of theirs. */
function combatOfUser(actor) {
  if (!actor) return null;
  const inIt = c => !!c?.started && list(c.combatants).some(cb => cb?.actor === actor || cb?.actor?.uuid === actor.uuid || (!actor.isToken && cb?.actorId === actor.id));
  if (inIt(game.combat)) return game.combat;
  return list(game.combats).find(inIt) ?? null;
}

/**
 * The record field `res.persistent` of a resolve (engine.mjs): null without an overlay `persistent`, with the setting
 * off, for a non-hero or outside a started combat. A fresh card matches a pending re-roll (`matchReroll`: GM
 * expectation, the author's flag a hint only); a re-resolve keeps what the card had.
 * @returns {{cost: number, keep: string[], targets: string|null, note: string|null, parent: string|null, free: boolean}|null}
 */
export function persistentRecord({ lib, item, message, res = null, fresh = false } = {}) {
  try {
    const p = lib?.persistent;
    // A re-resolve (Use my targets, a pick, force) keeps what the card had: a use only becomes Persistent when it is
    // first resolved in a started combat, never later (an old card re-resolved in a new encounter starts no chain).
    if (!fresh) return res?.persistent ?? null;
    if (!p || !enabled() || !item?.actor?.system?.hero?.primary) return null;
    const combat = combatOfUser(item.actor);
    if (!combat) return null;
    const cost = Number(p.cost) || persistentCost(item);
    if (!cost) return null;
    const match = matchReroll(message, item, combat);
    return {
      cost, keep: [p.keep].flat().filter(Boolean), targets: p.targets ?? null, note: p.note ?? null,
      parent: match?.parent ?? null, free: !!match?.free, combatId: combat.id,
    };
  } catch (err) {
    error("persistent.record", err, { messageId: message?.id });
    return null;
  }
}

/* -------------------------------------------- */
/*  Index writes (active GM, on the chain)      */
/* -------------------------------------------- */

/** The user's combatant: by its token on the card's scene, else by actor. */
function combatantOf(combat, actor, tokenDoc) {
  const all = list(combat?.combatants);
  if (tokenDoc?.id) {
    const byToken = all.find(c => c?.tokenId === tokenDoc.id && (!c.sceneId || !tokenDoc.parent?.id || c.sceneId === tokenDoc.parent.id));
    if (byToken) return byToken;
  }
  return all.find(c => c?.actor === actor || c?.actor?.uuid === actor?.uuid) ?? null;
}

/** Token uuids of the card's real targets (not the user's own row, dropped, gain-only, picked-only or area-only records). */
function targetTokenUuids(res) {
  return Object.values(res?.targets ?? {})
    .filter(t => t && !t.dropped && !sideOnly(t) && typeof t.tokenUuid === "string")
    .map(t => t.tokenUuid);
}

/** A new index entry from a resolved card (pure apart from the lifecycle read of the arms). */
export function buildEntry({ message, res, item, combat, combatant, parent = null }) {
  const p = res.persistent;
  const tokenDoc = lookup(res.sourceTokenUuid);
  const round = combat?.round ?? null;
  const { armStart } = buildArm(combat, combatant);
  return {
    messageId: message.id, combatId: combat?.id ?? null, combatantId: combatant?.id ?? null,
    actorUuid: item.actor?.uuid ?? res.sourceActorUuid ?? null, tokenUuid: tokenDoc?.uuid ?? res.sourceTokenUuid ?? null,
    sceneId: tokenDoc?.parent?.id ?? message.speaker?.scene ?? null, itemUuid: item.uuid, abilityName: item.name ?? "",
    cost: p.cost, keep: [...p.keep], targets: p.targets ?? null, note: p.note ?? null,
    targetTokenUuids: targetTokenUuids(res), createdRound: round, armStart,
    // A re-roll is made while its parent was kept this round: the same turn start must not ask again.
    lastRound: parent ? round : null, kept: parent ? (Number(parent.kept) || 0) : 0, rerollRound: null,
    parent: parent?.messageId ?? null, supersededBy: null, active: true, endedReason: null, endedRound: null,
    order: serverNow() + ((orderSeq++ % 1000) / 1000),
  };
}

async function writePatch(combat, messageId, patch) {
  const live = liveCombat(combat);
  if (!live || !rawEntry(live, messageId)) return false;
  const update = {};
  for (const [k, v] of Object.entries(patch)) update[`${indexPath(messageId)}.${k}`] = v;
  await live.update(update);
  return true;
}

/**
 * Active GM: merge `patch` into one entry. Queued on the chain; `{onChain: true}` writes at once and is only for
 * callers already running on it (awaiting a queued call from inside the chain would deadlock).
 */
export async function patchEntry(combat, messageId, patch, { onChain = false } = {}) {
  if (!isActiveGM() || !messageId || !patch) return false;
  try {
    if (onChain) return await writePatch(combat, messageId, patch);
    return await withPersistentChain(() => writePatch(combat, messageId, patch));
  } catch (err) {
    error("persistent.patch", err, { messageId });
    return false;
  }
}

/** HOOKS.resolved (active GM): index a Persistent use; a re-roll supersedes its parent. */
async function onResolved(message, res) {
  try {
    if (!isActiveGM() || !enabled() || !message?.id || !res?.persistent || res.synthetic) return;
    const item = lookup(res.abilityUuid);
    const combat = combatOfUser(item?.actor);
    if (!item || !combat) return;
    await withPersistentChain(async () => {
      const live = liveCombat(combat);
      if (!live?.started) return;
      // A card resolved again (Use my targets): its entry keeps its state, only the targets follow.
      if (rawEntry(live, message.id)) {
        await live.update({ [`${indexPath(message.id)}.targetTokenUuids`]: targetTokenUuids(res) });
        return;
      }
      // Only the encounter the use was first resolved in (records before 0.14.0 carry no combatId).
      if (res.persistent.combatId && res.persistent.combatId !== live.id) return;
      const parent = res.persistent.parent ? rawEntry(live, res.persistent.parent) : null;
      const combatant = combatantOf(live, item.actor, lookup(res.sourceTokenUuid));
      const entry = buildEntry({ message, res, item, combat: live, combatant, parent });
      const update = { [indexPath(message.id)]: entry };
      if (parent) {
        Object.assign(update, {
          [`${indexPath(parent.messageId)}.active`]: false, [`${indexPath(parent.messageId)}.supersededBy`]: message.id,
          [`${indexPath(parent.messageId)}.endedReason`]: "superseded", [`${indexPath(parent.messageId)}.endedRound`]: live.round ?? null,
        });
      }
      await live.update(update);
      log("persistent.index", { messageId: message.id, ability: entry.abilityName, parent: entry.parent, kept: entry.kept });
    });
  } catch (err) {
    error("persistent.resolved", err, { messageId: message?.id });
  }
}

/* -------------------------------------------- */
/*  End (active GM)                             */
/* -------------------------------------------- */

/** Actors that may carry the use's effects: the combat's, the recorded targets' and the user. */
function actorsOf(combat, entry) {
  const out = new Set();
  for (const c of list(combat?.combatants)) if (c?.actor) out.add(c.actor);
  for (const uuid of entry.targetTokenUuids ?? []) {
    const a = lookup(uuid)?.actor;
    if (a) out.add(a);
  }
  const user = lookup(entry.actorUuid);
  if (user) out.add(user);
  return [...out];
}

/** Live effects made by the use's cards (flags["stef-ds-automation"].messageId of the chain), on every actor of actorsOf. */
export function useEffects(combat, entry) {
  const ids = new Set(chainIds(combat, entry));
  const out = [];
  for (const actor of actorsOf(combat, entry)) {
    for (const effect of list(actor.effects)) {
      if (!effect?.duration?.expired && ids.has(effect?.flags?.[MODULE_ID]?.messageId)) out.push(effect);
    }
  }
  return out;
}

/** The use's effects a hold keeps alive (an until spec with hold "persistent"). */
export function heldEffects(combat, entry) {
  return useEffects(combat, entry).filter(effect => untilSpecs(effect).some(s => s.hold === PERSISTENT_HOLD));
}

/** Note card: a plain chat message spoken by the use's user. */
export async function postNote(entry, text, kind) {
  try {
    if (!globalThis.ChatMessage || !text) return null;
    const esc = globalThis.foundry?.utils?.escapeHTML ?? (v => String(v));
    const actor = lookup(entry?.actorUuid);
    const speaker = actor ? ChatMessage.getSpeaker({ actor }) : { alias: game.modules?.get?.(MODULE_ID)?.title ?? MODULE_ID };
    return await ChatMessage.implementation.create({
      content: `<p>${esc(text)}</p>`, speaker,
      flags: { [MODULE_ID]: { persistentNote: { messageId: entry?.messageId ?? null, kind } } },
    });
  } catch (err) {
    error("persistent.note", err);
    return null;
  }
}

/** The use's aura off when the use held it past its own end: kept at least once, or it ends at turn start anyway. */
async function auraOff(combat, entry) {
  const item = lookup(entry.itemUuid);
  const def = item ? auraDefinition(item) : null;
  const state = item?.flags?.[MODULE_ID]?.aura;
  if (!def || !state?.active || !chainIds(combat, entry).includes(state.sourceMessageId)) return;
  if (!((Number(entry.kept) || 0) > 0 || def.end === "sourceNextTurnStart")) return;
  await setAura(item, false);
}

/**
 * Let a use go (active GM; never from inside the chain): deactivate first (its holds release), then end its held
 * effects, its aura (see auraOff), post the note card (not for the quiet reasons) and call HOOKS.persistentEnd.
 * An open upkeep prompt of the use is cancelled (`dismissed`). Never throws.
 * @param {object} entry                 the index entry (or one with messageId and combatId)
 * @param {string} why                   a value of PERSISTENT_END
 * @returns {Promise<boolean>}           true when this call ended an active use
 */
export async function endUse(entry, why, { quiet = false } = {}) {
  if (!isActiveGM() || !entry?.messageId) return false;
  try {
    cancelPersistentUpkeep(entry.messageId, "dismissed");
  } catch (err) {
    error("persistent.endCancel", err);
  }
  let ended = null;
  let combat = null;
  try {
    ended = await withPersistentChain(async () => {
      combat = liveCombat(entry.combatId);
      const now = combat ? rawEntry(combat, entry.messageId) : null;
      if (!now?.active) return null;
      await writePatch(combat, entry.messageId, { active: false, endedReason: why, endedRound: combat.round ?? null });
      return { ...now, active: false, endedReason: why };
    });
  } catch (err) {
    error("persistent.end", err, { messageId: entry.messageId, why });
    return false;
  }
  if (!ended) return false;
  await afterEnd(combat, ended, why, { quiet });
  return true;
}

async function afterEnd(combat, entry, why, { quiet = false } = {}) {
  try {
    for (const effect of heldEffects(combat, entry)) await expireEffect(effect, `persistent:${why}`);
    await auraOff(combat, entry);
  } catch (err) {
    error("persistent.endEffects", err, { messageId: entry.messageId });
  }
  try {
    if (!quiet && !QUIET.has(why)) {
      await postNote(entry, loc("DSAUTO.Persistent.Released", { ability: entry.abilityName, reason: loc(`DSAUTO.Persistent.End.${why}`) }), "released");
    }
    Hooks.callAll(HOOKS.persistentEnd ?? "dsAuto.persistentEnd", foundry.utils?.deepClone?.(entry) ?? entry, { reason: why });
  } catch (err) {
    error("persistent.endAfter", err, { messageId: entry.messageId });
  }
  log("persistent.end", { messageId: entry.messageId, ability: entry.abilityName, why });
}

/* -------------------------------------------- */
/*  Lifetime (active GM)                        */
/* -------------------------------------------- */

/** Does an entry belong to this combatant (its id, or a re-created combatant of the same token)? */
function ofCombatant(entry, combatant) {
  if (!combatant) return false;
  if (entry.combatantId && entry.combatantId === combatant.id) return true;
  const tokenId = combatant.tokenId ?? combatant.token?.id ?? null;
  return !!tokenId && typeof entry.tokenUuid === "string" && entry.tokenUuid.endsWith(`.Token.${tokenId}`);
}

/** The lifecycle turn listener (awaited by the lifecycle queue: never await a prompt or a card lock here). */
async function onTurn(payload) {
  try {
    const { event, combat, combatant, round, activation } = payload ?? {};
    if (!isActiveGM() || !enabled() || !combat || !combatant) return;
    if (event !== "turnStart" && event !== "turnEnd") return;
    const live = liveCombat(combat) ?? combat;
    const mine = persistentEntries(live).filter(e => e.active && ofCombatant(e, combatant));
    if (!mine.length) return;
    if (event === "turnEnd") {
      // Unanswered at turn end: let it go (M6 Q16); the canceller owns the end.
      for (const e of mine) if (cancelPersistentUpkeep(e.messageId, "turnEnd")) await endUse(e, "turnEnd");
      return;
    }
    const at = { round, activation: activation ?? null, combatantId: combatant.id ?? null };
    for (const e of mine) {
      if (!counts(e.armStart, at, ">")) continue;
      if (e.lastRound === round) continue;   // kept this round already (a repeated turnStart, a re-roll's own card)
      const keep = [e.keep].flat();
      if (keep.includes("reroll") && !keep.includes("extend") && !rerollTargets(e, { combat: live }).length) {
        await endUse(e, "outOfDistance");
        continue;
      }
      offerPersistentUpkeep(e, { combat: live, round });   // fire-and-forget (§C.4)
    }
  } catch (err) {
    error("persistent.turn", err, { event: payload?.event });
  }
}

/** deleteCombat: open prompts cancelled, expectations dropped, every active use of it let go quietly. */
async function onEncounterEnd(combat) {
  try {
    if (!isActiveGM() || !combat?.id) return;
    cancelPersistentUpkeepsOf(combat.id);
    dropRerolls(combat.id);
    const active = persistentEntries(combat).filter(e => e.active);
    for (const e of active) await afterEnd(combat, { ...e, active: false }, "encounterEnd", { quiet: true });
    if (active.length) debug("persistent.encounterEnd", { combatId: combat.id, uses: active.length });
  } catch (err) {
    error("persistent.encounterEnd", err);
  }
}

/**
 * init (main.mjs, after registerZoneUpkeepGM and before registerUntil: the lifecycle awaits listeners in order, so a
 * use let go at turn start is inactive before the until scan). The hold, the resolved listener, the lifecycle
 * listener, deleteCombat and the upkeep's userConnected watch. Never throws.
 */
export function registerPersistent() {
  if (registered) return;
  registered = true;
  try {
    registerHold(PERSISTENT_HOLD, holdsEffect);
    lifecycle.onTurnEvent?.(onTurn);
    Hooks.on(HOOKS.resolved, (message, res) => {
      onResolved(message, res).catch(err => error("persistent.resolved", err));
    });
    Hooks.on("deleteCombat", combat => {
      onEncounterEnd(combat).catch(err => error("persistent.encounterEnd", err));
    });
    registerPersistentUpkeepGM();
  } catch (err) {
    error("persistent.register", err);
  }
}

