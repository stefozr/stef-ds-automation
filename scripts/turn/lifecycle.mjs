/**
 * Turn lifecycle (Milestone 2): one observation point for "a combatant's turn started / ended",
 * delivered once per ACTIVATION of a combatant on the active GM.
 *
 * Why the effect registry: Draw Steel's own turn pipeline (`#triggerDSTurnEvents`,
 * draw-steel.mjs:12034-12070, active GM only) calls `ActiveEffect.registry.refresh("turnStart" |
 * "turnEnd", {combat})` for the current / previous combatant, and Combat Tools' simultaneous squad
 * turns call the same refresh for every other squad member with a proxy combat whose `combatant` /
 * `previous.combatantId` is that member (squad-turns.mjs:40-90), on every GM client. Wrapping
 * `refresh` therefore sees every turn of every creature.
 *
 * Why activations, not rounds: a Draw Steel creature can act several times per round (solo monsters
 * have `system.combat.turns` 2-3; each activation lowers initiative and reuses the same turn index,
 * draw-steel.mjs:28280-28297). So per (combat, combatant) we track an activation counter: a turnStart
 * while no activation is open opens the next one (a second turnStart while open is a repeat); a
 * turnEnd closes the open one (a turnEnd while closed is a repeat). The combatant is read from the
 * refresh context BEFORE the refresh awaits anything: core rewrites `combat.previous` in place on
 * later combat updates (client/documents/combat.mjs:844-849).
 *
 * `Combat#_onEndTurn` (the system's save trigger) is wrapped MIXED for the same reason: Combat Tools
 * calls it again for the squad member the system already handled, and on every GM client, which
 * opens a second save dialog per effect. Only the active GM's first call per activation runs it.
 *
 * Milestone 5: the same refresh also carries "roundEnd" / "roundStart" (draw-steel.mjs:12051, 12056).
 * `onRoundEvent` listeners get each (combat, round, event) once, outside the serialized turn queue (a
 * triggered-action prompt must never stall it). A round set back (the Director rewinds to round 1) forgets
 * the claims of that round and later ones, so they are delivered again.
 */
import { HOOKS } from "../constants.mjs";
import { wrap } from "../compat/lib-wrapper.mjs";
import { debug, error, log } from "../log.mjs";

const TURN_EVENTS = new Set(["turnStart", "turnEnd"]);
const ROUND_EVENTS = new Set(["roundStart", "roundEnd"]);
const MAX_KEYS = 4000;
const seen = new Set();
const activations = new Map(); // `${combatId}:${combatantId}` -> {n, open}
const listeners = new Set();
const beforeEndTurn = new Set();
const roundListeners = new Set();
const roundHigh = new Map(); // combatId -> round of the last round event delivered
const combatEnds = new Map(); // combatId -> core's "combatEnd" refresh of a deleted combat, settled (never rejects)
const COMBAT_END_WAIT_MS = 5_000;
let queue = Promise.resolve();

export const installedWrappers = { refresh: false, onEndTurn: false };

export function registerLifecycle() {
  installedWrappers.refresh = wrap("foundry.helpers.ActiveEffectRegistry.prototype.refresh", refreshWrapper, "WRAPPER");
  installedWrappers.onEndTurn = wrap("CONFIG.Combat.documentClass.prototype._onEndTurn", onEndTurnDeduped, "MIXED");
  Hooks.on("deleteCombat", combat => forgetCombat(combat?.id));
}

/** Listen to deduplicated turn events: `fn({event, combat, combatant, actor, round, activation})`, active GM only. */
export function onTurnEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Listen to round events (Milestone 5): `fn({event: "roundStart"|"roundEnd", combat, round})`, active GM, once
 * per (combat, round, event), delivered in a microtask (never on the turn queue). Returns the unsubscribe.
 */
export function onRoundEvent(fn) {
  roundListeners.add(fn);
  return () => roundListeners.delete(fn);
}

/**
 * Synchronous listener run on the active GM right before the system's end-of-turn routine (saves) for
 * a combatant, once per activation: `fn({combat, combatant, activation})`. Used to snapshot state the
 * saves are about to change.
 */
export function onBeforeEndTurn(fn) {
  beforeEndTurn.add(fn);
  return () => beforeEndTurn.delete(fn);
}

/**
 * Claim a key once. Returns false when it was already claimed.
 * @returns {boolean}
 */
export function claim(...parts) {
  if (parts.some(p => p === undefined || p === null || p === "")) return true;
  const key = parts.join(":");
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > MAX_KEYS) {
    let drop = seen.size - MAX_KEYS / 2;
    for (const k of seen) {
      if (drop-- <= 0) break;
      seen.delete(k);
    }
  }
  return true;
}

export function forgetCombat(combatId) {
  if (!combatId) return;
  for (const k of seen) if (k.startsWith(`${combatId}:`)) seen.delete(k);
  for (const k of activations.keys()) if (k.startsWith(`${combatId}:`)) activations.delete(k);
  roundHigh.delete(combatId);
}

/** A round set back: its round events and those of later rounds may come again. */
function forgetRounds(combatId, fromRound) {
  const prefix = `${combatId}:round:`;
  for (const k of seen) {
    if (k.startsWith(prefix) && Number(k.slice(prefix.length).split(":")[0]) >= fromRound) seen.delete(k);
  }
}

const actKey = (combatId, combatantId) => `${combatId}:${combatantId}`;

/** Is that combatant's turn open right now (including Combat Tools squad followers)? */
export function isActing(combatId, combatantId) {
  return !!activations.get(actKey(combatId, combatantId))?.open;
}

/**
 * Milestone 6: the activation counter of a combatant, `{n, open}`, or null when none is recorded (a GM reload clears
 * them; summons/registry.mjs then arms its end triggers by round only).
 */
export function currentActivation(combatId, combatantId) {
  const s = activations.get(actKey(combatId, combatantId));
  return s ? { n: s.n, open: !!s.open } : null;
}

const newEpoch = () => globalThis.foundry?.utils?.randomID?.(16) ?? Math.random().toString(36).slice(2);

/**
 * Milestone 6 review: the epoch of the activation counters. The counters live in this client's memory only and
 * restart at 1 after a GM reload or on another active GM, so an arm stored with a counter value (registry
 * buildIndexEntry) also stores this epoch; an arm of another epoch is compared by round (registry `counts`).
 */
export let activationEpoch = newEpoch();

/** Forget every activation counter and start a new epoch (what a GM reload does; harness9 uses it). */
export function resetActivations() {
  activations.clear();
  activationEpoch = newEpoch();
}

/**
 * Record a turn event. Returns the activation number, or null for a repeat.
 * A turnEnd with no recorded start (module loaded mid-turn) counts as a fresh, closed activation.
 */
export function recordTurnEvent(combatId, combatantId, event, round = null) {
  const key = actKey(combatId, combatantId);
  const state = activations.get(key);
  if (event === "turnStart") {
    // Open in the same round = a repeat; open from an earlier round = its end was missed.
    if (state?.open && (round === null || state.round === null || state.round === round)) return null;
    const n = (state?.n ?? 0) + 1;
    activations.set(key, { n, open: true, round });
    return n;
  }
  if (state?.open) {
    state.open = false;
    return state.n;
  }
  if (state) return null;
  activations.set(key, { n: 1, open: false, round });
  return 1;
}

/** The activation the end-of-turn routine belongs to (opens one when nothing was recorded). */
function endingActivation(combatId, combatantId) {
  const key = actKey(combatId, combatantId);
  let state = activations.get(key);
  if (!state) {
    state = { n: 1, open: true, round: null };
    activations.set(key, state);
  }
  return state.n;
}

/** Finish queued listener work (tests, and callers that need ordering). */
export const lifecycleIdle = () => queue;

/** The combatant a refresh context is about, or null. */
export function contextCombatant(event, combat) {
  if (!combat) return null;
  if (event === "turnStart") return combat.combatant ?? null;
  const id = combat.previous?.combatantId;
  return id ? (combat.combatants?.get?.(id) ?? null) : null;
}

/**
 * Milestone 6 (T88, live run 2026-10-07): core's `Combat#_onDelete` starts `refresh("combatEnd")` without awaiting it,
 * then the `deleteCombat` hooks run. That refresh writes `duration.expired` on effects of the combat's actors (Combat
 * Tools' squad label effects on summons among them); deleting those tokens meanwhile makes the batch fail ("A parent
 * Document … must be a Document instance" on the client, "id … does not exist" on the server). Resolves once that
 * refresh is done, at once when none is running, and after `ms` at the latest.
 */
export function combatEndSettled(combatId, ms = COMBAT_END_WAIT_MS) {
  const run = combatId ? combatEnds.get(combatId) : null;
  if (!run) return Promise.resolve();
  let timer = null;
  const late = new Promise(resolve => { timer = setTimeout(resolve, ms); });
  return Promise.race([run, late]).finally(() => clearTimeout(timer));
}

function trackCombatEnd(combat, run) {
  const id = combat?.id;
  if (!id) return;
  const settled = Promise.resolve(run).then(() => {}, () => {});
  combatEnds.set(id, settled);
  settled.then(() => {
    if (combatEnds.get(id) === settled) combatEnds.delete(id);
  });
}

async function refreshWrapper(wrapped, event, context, ...rest) {
  // Read who the event is about now: `combat.previous` can change while the refresh awaits.
  let snapshot = null;
  if (TURN_EVENTS.has(event)) {
    try {
      snapshot = snapshotEvent(event, context);
    } catch (err) {
      error("lifecycle.snapshot", err, { event });
    }
  }
  const run = wrapped(event, context, ...rest);
  if (event === "combatEnd") trackCombatEnd(context?.combat, run);
  const result = await run;
  if (snapshot) {
    try {
      observe(snapshot);
    } catch (err) {
      error("lifecycle.observe", err, { event });
    }
  }
  if (ROUND_EVENTS.has(event)) {
    try {
      observeRound(event, context);
    } catch (err) {
      error("lifecycle.round", err, { event });
    }
  }
  return result;
}

/** One round event on the active GM (the system calls the refresh there only, draw-steel.mjs:12018). */
function observeRound(event, context) {
  if (!game.users.activeGM?.isSelf || context?.skipped || !roundListeners.size) return;
  const combat = context?.combat;
  if (!combat?.started || !combat.id) return;
  const round = Number(context?.round ?? combat.round);
  if (!Number.isFinite(round)) return;
  const high = roundHigh.get(combat.id);
  if (high != null && round < high) forgetRounds(combat.id, round);
  roundHigh.set(combat.id, round);
  if (!claim(combat.id, "round", round, event)) {
    debug("round.duplicate", { event, round });
    return;
  }
  const payload = { event, combat: game.combats?.get?.(combat.id) ?? combat, round };
  debug("round.event", { event, round });
  queueMicrotask(() => {
    for (const fn of roundListeners) {
      try {
        Promise.resolve(fn(payload)).catch(err => error("lifecycle.roundListener", err, { event }));
      } catch (err) {
        error("lifecycle.roundListener", err, { event });
      }
    }
  });
}

function snapshotEvent(event, context) {
  if (!game.users.activeGM?.isSelf || context?.skipped) return null;
  const combat = context?.combat;
  if (!combat?.started) return null;
  const combatant = contextCombatant(event, combat);
  if (!combatant) return null;
  return { event, combat, combatant, round: context?.round ?? combat.round, turn: context?.turn ?? null };
}

function observe({ event, combat, combatant, round, turn }) {
  const activation = recordTurnEvent(combat.id, combatant.id, event, round ?? null);
  if (activation === null) {
    debug("turn.duplicate", { event, combatant: combatant.name, round });
    return;
  }
  // Listeners get the real combat document, not Combat Tools' proxy.
  const real = game.combats?.get?.(combat.id) ?? combat;
  const payload = { event, combat: real, combatant, actor: combatant.actor ?? null, round, turn, activation };
  debug("turn.event", { event, combatant: combatant.name, round, activation });
  queue = queue.then(() => dispatch(payload)).catch(err => error("lifecycle.dispatch", err, { event }));
}

async function dispatch(payload) {
  Hooks.callAll(HOOKS.turnEvent, payload);
  for (const fn of listeners) {
    try {
      await fn(payload);
    } catch (err) {
      error("lifecycle.listener", err, { event: payload.event, combatant: payload.combatant?.name });
    }
  }
}

/** @this {DrawSteelCombat} */
async function onEndTurnDeduped(wrapped, combatant, context = {}, ...rest) {
  // The system runs its turn pipeline on the active GM only; extra GM clients reach this through
  // Combat Tools and would open their own save dialogs.
  if (!game.users.activeGM?.isSelf) return undefined;
  if (context?.skipped || !combatant?.id) return wrapped(combatant, context, ...rest);
  const activation = endingActivation(this.id, combatant.id);
  if (!claim(this.id, combatant.id, activation, "onEndTurn")) {
    log("turn.endTurnDuplicate", { combatant: combatant.name, round: context?.round ?? this.round, activation });
    return undefined;
  }
  for (const fn of beforeEndTurn) {
    try {
      fn({ combat: this, combatant, activation });
    } catch (err) {
      error("lifecycle.beforeEndTurn", err, { combatant: combatant.name });
    }
  }
  return wrapped(combatant, context, ...rest);
}
