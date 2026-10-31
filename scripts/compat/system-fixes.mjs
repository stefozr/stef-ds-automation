/**
 * Work-arounds for two Draw Steel 1.1.x bugs that break durations (Milestone 2). Both are gated by
 * behaviour probes, not version strings (Milestone 8, compat/version-gate.mjs: a "1.2" dev build compares
 * as newer than "1.2.0"), and switched by the world setting `systemFixes`.
 *
 * 1. `DSRoll#toMessage` replaces `system.parts` with one generic roll part (draw-steel.mjs:819-826),
 *    so `BaseEffectModel#rollSave` (1092-1140) loses its `savingThrow` part: the save card has no
 *    effect link and no hero-token button. WRAPPER: when a SavingThrowRoll is sent with a
 *    `savingThrow` part, the message is built with `create: false` and created with that part.
 * 2. `DrawSteelCombat#_onExit` (12075-12086) means to delete the combat's turn/round/save/encounter
 *    effects of a leaving combatant, but `new Set("save", ...)` is a set of characters, so only
 *    effects that are already expired are deleted: save-ends effects survive the encounter.
 *    WRAPPER: after the system's pass, delete what it missed. Core runs `refresh("combatEnd")`
 *    without awaiting it right before (client/documents/combat.mjs:675-685), so the deletion waits a
 *    moment and skips effects that are gone by then.
 *    Milestone 8 (D8): the wrapper installs whenever `systemFixes` is on. Where the probe finds `_onExit`
 *    fixed (mode "untilOnly") it deletes only our own `dsAutoUntil` effects, which no system version knows;
 *    with the bug present (mode "full") everything the system missed. The probe's own call is skipped.
 */
import { MODULE_ID, UNTIL_EXPIRY } from "../constants.mjs";
import { PROBE_COMBAT_ID, compat } from "./version-gate.mjs";
import { wrap } from "./lib-wrapper.mjs";
import { debug, error, log } from "../log.mjs";
import { setting } from "../settings.mjs";

export const EXIT_DELETE_DELAY_MS = 400;
const COMBAT_EXPIRIES = new Set(["save", "combatEnd", "roundStart", "roundEnd", "turnStart", "turnEnd", UNTIL_EXPIRY]);

const UNTIL_ONLY = new Set([UNTIL_EXPIRY]);

/** "full" (the system's Set bug: everything it missed) or "untilOnly" (fixed `_onExit`: our until effects). */
let exitMode = "full";

/** Which fixes were installed on this client; `exitCleanup` is `{installed, mode}` (Milestone 8). */
export const installedFixes = { saveMessage: false, exitCleanup: { installed: false, mode: null } };

/** Combat classes whose `_onExit` this client wrapped (a second call never wraps twice, only sets the mode). */
const exitWrapped = new WeakSet();
let saveTried = false;

export function registerSystemFixes() {
  if (!setting("systemFixes")) return;
  if (compat.saveMessageBug && !saveTried) {
    saveTried = true;
    installedFixes.saveMessage = wrap("ds.rolls.DSRoll.prototype.toMessage", toMessageKeepingSavePart, "WRAPPER");
  }
  exitMode = compat.setBugsPresent ? "full" : "untilOnly";
  const cls = CONFIG.Combat?.documentClass;
  const installed = (!!cls && exitWrapped.has(cls)) || wrap("CONFIG.Combat.documentClass.prototype._onExit", onExitCleanup, "WRAPPER");
  if (installed && cls) exitWrapped.add(cls);
  installedFixes.exitCleanup = { installed, mode: installed ? exitMode : null };
}

/* -------------------------------------------- */
/*  1. Saving throw card keeps its part          */
/* -------------------------------------------- */

/** `savingThrow` parts in the data a caller passes to toMessage (rollSave builds exactly one). */
export function savingThrowParts(messageData) {
  const parts = messageData?.system?.parts;
  if (!parts || typeof parts !== "object") return [];
  return Object.values(parts).filter(p => p && typeof p === "object" && p.type === "savingThrow" && typeof p._id === "string");
}

const serializeRoll = r => (typeof r === "string" ? r : JSON.stringify(r));

/** @this {DSRoll} */
async function toMessageKeepingSavePart(wrapped, messageData = {}, options = {}) {
  const keep = savingThrowParts(messageData);
  const SavingThrowRoll = globalThis.ds?.rolls?.SavingThrowRoll;
  if (!keep.length || !SavingThrowRoll || !(this instanceof SavingThrowRoll)) return wrapped(messageData, options);
  const create = options?.create !== false;
  const data = await wrapped(messageData, { ...options, create: false });
  if (!data || typeof data !== "object") return data;
  data.system ??= {};
  data.system.parts = Object.fromEntries(keep.map(p => [p._id, {
    ...p,
    rolls: (Array.isArray(p.rolls) && p.rolls.length ? p.rolls : [this]).map(serializeRoll),
  }]));
  debug("fix.saveMessage", { effectUuid: keep[0].effectUuid });
  if (!create) return data;
  return getDocumentClass("ChatMessage").create(data);
}

/* -------------------------------------------- */
/*  2. Encounter cleanup when a combatant exits  */
/* -------------------------------------------- */

const pendingExit = new Set();

/**
 * Effects of `actor` the system's `_onExit` should delete but does not (not yet expired, this combat). `mode`
 * "untilOnly" (a fixed `_onExit`): only our `dsAutoUntil` effects.
 */
export function missedExitEffects(actor, combatId, mode = exitMode) {
  const expiries = mode === "full" ? COMBAT_EXPIRIES : UNTIL_ONLY;
  return (actor?.effects?.contents ?? [...(actor?.effects ?? [])]).filter(e =>
    !e.duration?.expired && expiries.has(e.duration?.expiry) && (e._source?.start?.combat ?? e.start?.combat) === combatId);
}

/** @this {DrawSteelCombat} */
async function onExitCleanup(wrapped, combatant, ...rest) {
  // The exit probe (detectCompat, ready and selfCheck run it again through this wrapper): never scheduled.
  if (this?.id === PROBE_COMBAT_ID) return wrapped(combatant, ...rest);
  const result = await wrapped(combatant, ...rest);
  try {
    scheduleExitCleanup(this, combatant);
  } catch (err) {
    error("fix.exitCleanup", err);
  }
  return result;
}

export function scheduleExitCleanup(combat, combatant, delay = EXIT_DELETE_DELAY_MS) {
  const actor = combatant?.actor;
  if (!actor || !game.users.activeGM?.isSelf) return null;
  const ids = missedExitEffects(actor, combat.id).map(e => e.id).filter(id => !pendingExit.has(`${actor.uuid}.${id}`));
  if (!ids.length) return null;
  for (const id of ids) pendingExit.add(`${actor.uuid}.${id}`);
  return new Promise(resolve => {
    setTimeout(async () => {
      const live = ids.filter(id => actor.effects?.has?.(id) ?? actor.effects?.get?.(id));
      try {
        if (live.length) await actor.deleteEmbeddedDocuments("ActiveEffect", live, { [MODULE_ID]: { exitCleanup: true } });
        if (live.length) log("fix.exitCleanup", { actor: actor.name, combat: combat.id, deleted: live.length });
      } catch (err) {
        error("fix.exitCleanup", err, { actor: actor.uuid, ids: live });
      } finally {
        for (const id of ids) pendingExit.delete(`${actor.uuid}.${id}`);
        resolve(live);
      }
    }, delay);
  });
}
