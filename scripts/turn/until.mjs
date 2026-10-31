/**
 * End conditions the system's effect ends cannot express (Milestone 2), stored in
 * `flags["stef-ds-automation"].until` as one spec or a list (the effect ends when any is met):
 *   {event: "turnEnd",   combatantId}  until the end of that combatant's NEXT turn ("until the end
 *                                      of your next turn": set during that combatant's own turn, its
 *                                      current turn end does not count)
 *   {event: "turnStart", combatantId}  until the start of that combatant's next turn
 *   {event: "dying"}                   until the creature is dying or dead
 *   {event: "moves"}                   until the creature's token moves
 * Effects managed only by us get `duration.expiry = "dsAutoUntil"`, which core never expires itself.
 * Ending follows `CONFIG.ActiveEffect.expiryAction` (update: mark expired, like a saved effect;
 * delete: delete). Active GM only. `api.until(effect, spec, {keepExpiry})` sets a spec.
 * Milestone 9 (docs/M9-DESIGN.md §C): a turnStart / turnEnd spec may carry `hold: "<name>"`; while the hold
 * registered under that name (`registerHold`) answers true for the effect, the turn event does not end it (Persistent
 * "extend": the effect lasts until its user lets the use go, persistent/registry.mjs). `expireEffect` ends one as the
 * listener does.
 */
import { MODULE_ID, UNTIL_EXPIRY } from "../constants.mjs";
import { error, log } from "../log.mjs";
import { isActing, onTurnEvent } from "./lifecycle.mjs";

const EVENTS = new Set(["turnEnd", "turnStart", "dying", "moves"]);
const DOWN = ["dying", "dead"];
const HOLD_RE = /^[A-Za-z][A-Za-z0-9-]{0,39}$/;
const holds = new Map();   // hold name -> (effect, spec, combat) => boolean

/** Milestone 9: register a hold (`spec.hold === name`): while `fn(effect, spec, combat)` is true, turn events skip the spec. */
export function registerHold(name, fn) {
  if (HOLD_RE.test(String(name ?? "")) && typeof fn === "function") holds.set(name, fn);
}

/** Is this spec held now? A hold that throws or is not registered holds nothing. */
function held(effect, spec, combat) {
  if (!spec?.hold) return false;
  try {
    return holds.get(spec.hold)?.(effect, spec, combat) === true;
  } catch (err) {
    error("until.hold", err, { hold: spec.hold });
    return false;
  }
}

export function registerUntil() {
  CONFIG.ActiveEffect.expiryEvents[UNTIL_EXPIRY] = "DSAUTO.Until.ExpiryLabel";
  onTurnEvent(onTurn);
  Hooks.on("updateActor", actor => checkDown(actor));
  Hooks.on("createActiveEffect", effect => checkDown(effect?.parent));
  Hooks.on("updateToken", (token, changes) => {
    if (changes && ("x" in changes || "y" in changes || "elevation" in changes)) checkMoved(token);
  });
}

/** Specs of an effect (always a list, invalid entries dropped). */
export function untilSpecs(effect) {
  const raw = effect?.flags?.[MODULE_ID]?.until;
  if (!raw) return [];
  return [raw].flat().filter(s => s && typeof s === "object" && EVENTS.has(s.event)
    && (!["turnEnd", "turnStart"].includes(s.event) || typeof s.combatantId === "string"));
}

/**
 * Normalize specs before storing them: a turnEnd spec set during that combatant's own turn waits for
 * its next turn (`armed: false` until that turn starts).
 */
export function prepareSpecs(specs, combat = game.combat) {
  return [specs].flat().map(s => {
    if (!s || !EVENTS.has(s.event)) throw new Error("DSAUTO.Relay.BadRequest");
    const out = { event: s.event };
    if (s.event === "turnEnd" || s.event === "turnStart") {
      const id = s.combatantId ?? s.combatant?.id;
      if (typeof id !== "string") throw new Error("DSAUTO.Relay.BadRequest");
      out.combatantId = id;
      out.combatId = s.combatId ?? combat?.id ?? null;
      // Acting now (the current combatant, or a Combat Tools squad follower whose turn is open): this
      // turn's end does not count.
      const acting = !!combat?.started && (combat.combatant?.id === id || isActing(combat.id, id));
      out.armed = s.event === "turnStart" || !acting;
      // Milestone 9: a named hold (persistent/registry.mjs) travels with the spec.
      if (typeof s.hold === "string" && HOLD_RE.test(s.hold)) out.hold = s.hold;
    }
    return out;
  });
}

/** Add end conditions to an effect (owner or GM). */
export async function setUntil(effectOrUuid, specs, { keepExpiry = false } = {}) {
  const effect = typeof effectOrUuid === "string" ? await fromUuid(effectOrUuid) : effectOrUuid;
  if (!effect?.update) throw new Error("DSAUTO.Relay.BadRequest");
  const list = [...untilSpecs(effect), ...prepareSpecs(specs)];
  const update = { [`flags.${MODULE_ID}.until`]: list };
  if (!keepExpiry) update["duration.expiry"] = UNTIL_EXPIRY;
  await effect.update(update);
  return list;
}

const ending = new Set();

/** End an effect as the turn listener does (expiryAction: mark expired or delete); one end at a time per effect. */
export async function expireEffect(effect, why) {
  return endEffect(effect, why);
}

async function endEffect(effect, why) {
  if (ending.has(effect.uuid)) return;
  ending.add(effect.uuid);
  try {
    if (CONFIG.ActiveEffect.expiryAction === "delete") await effect.delete();
    else await effect.update({ "duration.expired": true });
    log("until.ended", { effect: effect.name, actor: effect.parent?.name, why });
  } catch (err) {
    error("until.end", err, { effect: effect.uuid });
  } finally {
    ending.delete(effect.uuid);
  }
}

const live = effect => !effect.duration?.expired && !effect.disabled;

/** Actors of a combat (each once). */
function combatActors(combat) {
  const out = new Set();
  for (const c of combat?.combatants ?? []) if (c.actor) out.add(c.actor);
  return out;
}

async function onTurn({ event, combat, combatant }) {
  for (const actor of combatActors(combat)) {
    for (const effect of [...(actor.effects ?? [])]) {
      if (!live(effect)) continue;
      const specs = untilSpecs(effect);
      // A held spec (Milestone 9) neither ends nor arms the effect while its hold says so.
      const mine = specs.filter(s => s.combatantId === combatant.id && (!s.combatId || s.combatId === combat.id) && !held(effect, s, combat));
      if (!mine.length) continue;
      if (mine.some(s => s.event === event && (s.event === "turnStart" || s.armed !== false))) {
        await endEffect(effect, `${event}:${combatant.name}`);
        continue;
      }
      // That combatant's turn started: its next turn end counts now.
      if (event === "turnStart" && mine.some(s => s.event === "turnEnd" && s.armed === false)) {
        const armed = specs.map(s => (s.event === "turnEnd" && s.combatantId === combatant.id ? { ...s, armed: true } : s));
        await effect.update({ [`flags.${MODULE_ID}.until`]: armed }).catch(err => error("until.arm", err));
      }
    }
  }
}

function checkDown(actor) {
  if (!game.users.activeGM?.isSelf || !actor?.effects) return;
  if (!DOWN.some(s => actor.statuses?.has?.(s))) return;
  for (const effect of [...actor.effects]) {
    if (live(effect) && untilSpecs(effect).some(s => s.event === "dying")) endEffect(effect, "dying");
  }
}

function checkMoved(token) {
  if (!game.users.activeGM?.isSelf) return;
  const actor = token?.actor;
  for (const effect of [...(actor?.effects ?? [])]) {
    if (live(effect) && untilSpecs(effect).some(s => s.event === "moves")) endEffect(effect, "moves");
  }
}
