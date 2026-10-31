/**
 * Hesitation is Weakness (Milestone 5, docs/M5-DESIGN.md §3.10). On our `turnEnd` lifecycle event (active
 * GM), offer `turn.end` triggers and, when one is used, let its reactor take the next turn. Fire-and-forget:
 * the lifecycle queue never waits on a prompt (turn/lifecycle.mjs awaits its listeners). Stays off when
 * Combat Tools automates the ability itself (`dsctHandlesHiw`: DSCT registers its HIW hooks only when
 * `abilityAutomationEnabled`, a reload setting, is on and draw-steel-triggers is inactive, and checks
 * `hiwEnabled` live, DSCT/ability-automation/class-shadow/hesitation.mjs:55-57, 70).
 *
 * - Only between turns, as the rules and Combat Tools have it: a turn started meanwhile (`updateCombat`
 *   with a turn, or a round change) cancels the open prompts (outcome cancelled, no cost).
 * - One shadow takes the next turn; other acceptances are moot (released, no card).
 * - `takeTurnNext` writes the turn first, in one update guarded by a re-check, then lowers the initiative
 *   as the system's tracker does (DSM:28290-28298). Core keeps the current combatant when a combatant's
 *   initiative changes (client/documents/combatant.mjs:248-259), so the new turn index stays right. The flag
 *   `hiwStart` lets eligibility skip "a turn this ability started" (`require.notStartedByThis`).
 * - End of round 1: one GM whisper lists combatants still Surprised (the system never removes it, C10).
 * - `turn.start` triggers are offered on our `turnStart` lifecycle event (no wave-2 content uses them).
 * `onRoundEvent` (turn/lifecycle.mjs, WP-E) is read through the module namespace; without it the round
 * change in `updateCombat` does the same.
 * - Milestone 6: the summon chain (summons/turn-chain.mjs) makes a summon current right at its summoner's turn end,
 *   which pre-empts the offer above; when the last chained summon's turn ends, `runHiwFor` offers it for the summoner
 *   with the same guards (docs/M6-DESIGN.md Q19).
 * i18n keys used here: DSAUTO.Trigger.SurprisedEnds.
 */
import { MODULE_ID, TRIGGERS_ID, loc } from "../constants.mjs";
import { compat } from "../compat/version-gate.mjs";
import { dsctActive, dsctSetting } from "../compat/dsct.mjs";
import { debug, error, log } from "../log.mjs";
import * as lifecycle from "../turn/lifecycle.mjs";
import { postTriggerCard } from "./card.mjs";
import { kindsInUse, offer, releaseDecisions, reportDecisions, runAfter, triggersActive } from "./engine.mjs";
import { clock, promptMs } from "./prompt.mjs";

const hiwOffers = new Map();   // combatId -> Set<AbortController> of open HIW offers
let registered = false;

const isActiveGM = () => !!game.users?.activeGM?.isSelf;
const randomID = () => globalThis.foundry?.utils?.randomID?.() ?? Math.random().toString(36).slice(2, 18);

/** onTurnEvent (turnEnd), updateCombat and onRoundEvent (cancel moot prompts). */
export function registerTurnOrder() {
  if (registered) return;
  registered = true;
  lifecycle.onTurnEvent(payload => {
    // Not awaited: the lifecycle queue must never wait on a prompt.
    if (payload?.event === "turnEnd") runHiw(payload).catch(err => error("hiw", err));
    if (payload?.event === "turnStart") runTurnStart(payload).catch(err => error("triggers.turnStart", err));
  });
  const hasRoundEvents = typeof lifecycle.onRoundEvent === "function";
  if (hasRoundEvents) {
    lifecycle.onRoundEvent(({ combat, event, round } = {}) => {
      try {
        if (!combat) return;
        cancelHiw(combat.id);
        if (event === "roundEnd" && round === 1) whisperSurprised(combat).catch(err => error("hiw.surprised", err));
      } catch (err) {
        error("hiw.round", err);
      }
    });
  }
  Hooks.on("updateCombat", (combat, changes) => {
    try {
      if (!isActiveGM() || !combat) return;
      const turnStarted = "turn" in (changes ?? {}) && changes.turn !== null;
      const roundChanged = "round" in (changes ?? {});
      if (turnStarted || roundChanged) cancelHiw(combat.id);
      // Fallback without onRoundEvent: round 1 -> 2 ends round 1.
      if (!hasRoundEvents && roundChanged && changes.round === 2) whisperSurprised(combat).catch(err => error("hiw.surprised", err));
    } catch (err) {
      error("hiw.updateCombat", err);
    }
  });
  Hooks.on("deleteCombat", combat => {
    try {
      if (!combat) return;
      cancelHiw(combat.id);
    } catch (err) {
      error("hiw.deleteCombat", err);
    }
  });
}

/** DSCT posts its own HIW cards: active, abilityAutomationEnabled (snapshot at ready: requiresReload, review integration 12)
 *  and hiwEnabled (live) (DSCT/ability-automation/class-shadow/hesitation.mjs:55-57, 70). */
export function dsctHandlesHiw() {
  try {
    if (!dsctActive() || game.modules?.get?.(TRIGGERS_ID)?.active) return false;
    // detectCompat snapshots the reload setting at ready (WP-E); before that, read it.
    const automation = compat.dsctAbilityAutomation ?? dsctSetting("abilityAutomationEnabled", true);
    return automation !== false && dsctSetting("hiwEnabled", true) !== false;
  } catch (err) {
    error("hiw.dsct", err);
    return false;
  }
}

function cancelHiw(combatId) {
  const set = hiwOffers.get(combatId);
  if (!set) return;
  for (const controller of set) {
    try {
      controller.abort();
    } catch (_err) { /* already aborted */ }
  }
  hiwOffers.delete(combatId);
}

/**
 * Milestone 6 (Q19): offer Hesitation is Weakness for `actor` (the summoner) after a chained summon's turn ended with
 * nothing left. Same guards as the lifecycle path (active GM, overlays in use, not Combat Tools' HIW, default mode,
 * hero, between turns). Fire-and-forget: errors are logged, never thrown.
 */
export function runHiwFor({ combat, combatant, actor, round } = {}) {
  return runHiw({ combat, combatant, actor, round }).catch(err => error("hiw", err));
}

async function runHiw({ combat, combatant, actor, round } = {}) {
  if (!isActiveGM() || !triggersActive() || !kindsInUse().has("turn.end")) return;   // zero cost without overlays
  if (dsctHandlesHiw() || !game.combats?.isDefaultInitiativeMode) return;            // decision 10; DSM:3941-3943
  if (actor?.type !== "hero" || !combat || !combatant) return;
  const live = game.combats?.get?.(combat.id) ?? combat;
  // Between turns only: a turn already started (the Director activated someone) or the round moved on.
  if (!live.started || live.round !== round || live.combatant) return;
  const event = {
    id: randomID(), kind: "turn.end", sceneId: live.scene?.id ?? globalThis.canvas?.scene?.id ?? null,
    subject: { actorUuid: actor.uuid, tokenUuid: combatant.token?.uuid ?? null, name: actor.name, isHero: true },
    source: { actorUuid: null, tokenUuid: null, itemUuid: null, name: null, keywords: [], fromAbility: false, known: false },
    turn: { combatId: live.id, combatantId: combatant.id, round },
    at: clock.now(),
  };
  // The offer's signal aborts every prompt of it when a turn starts or the round changes.
  const controller = new AbortController();
  if (!hiwOffers.has(live.id)) hiwOffers.set(live.id, new Set());
  hiwOffers.get(live.id).add(controller);
  let decisions = [];
  try {
    decisions = await offer([event], { phase: "turn", deadline: clock.now() + promptMs() + 5_000, signal: controller.signal });
  } finally {
    const set = hiwOffers.get(live.id);
    set?.delete(controller);
    if (set && !set.size) hiwOffers.delete(live.id);
  }
  const used = decisions.filter(d => d?.outcome === "used");
  // Only a decision that takes the turn can win it (the schema requires the step on turn.end; a stamped
  // copy from before may lack it): another used one runs its own steps.
  const takes = d => (d.steps ?? []).some(s => s?.type === "takeTurnNext");
  const turnTakers = used.filter(takes);
  const others = used.filter(d => !takes(d));
  const winner = turnTakers[0] ?? null;
  for (const d of turnTakers.slice(1)) {
    // One shadow takes the next turn.
    d.outcome = "moot";
    d.why = "turnTaken";
    releaseDecisions([d]);
  }
  if (winner) {
    let r;
    try {
      r = await takeTurnNext(winner, { combatId: live.id, round });
    } catch (err) {
      error("hiw.turn", err);
      r = { ok: false, why: "error" };
    }
    if (!r.ok) {
      // Turn taken meanwhile, round over: no card, no cost (review conc 15).
      winner.outcome = "moot";
      winner.why = r.why;
      releaseDecisions([winner]);
    }
  }
  reportDecisions(decisions);
  if (winner?.outcome === "used") {
    log("hiw.turn", { reactor: winner.candidate?.reactor?.name, after: actor.name, round });
    await postTriggerCard(winner, { effects: { turn: true } });   // pays the ability's cost (Insight 1)
  }
  if (others.length) await runAfter({ holdDecisions: others });
}

/**
 * `turn.start` (taxonomy): on our `turnStart` lifecycle event, offer the triggers of the creatures whose turn
 * it is about (steps `use` / `note`); nothing is held, the turn goes on. Used reactions post their card and
 * run their follow-ups (engine.runAfter). Zero cost without such a trigger.
 */
async function runTurnStart({ combat, combatant, actor, round } = {}) {
  if (!isActiveGM() || !triggersActive() || !kindsInUse().has("turn.start")) return;
  if (!combat || !combatant || !actor) return;
  const live = game.combats?.get?.(combat.id) ?? combat;
  if (!live.started) return;
  const event = {
    id: randomID(), kind: "turn.start", sceneId: live.scene?.id ?? globalThis.canvas?.scene?.id ?? null,
    subject: { actorUuid: actor.uuid, tokenUuid: combatant.token?.uuid ?? null, name: actor.name, isHero: actor.type === "hero" },
    source: { actorUuid: null, tokenUuid: null, itemUuid: null, name: null, keywords: [], fromAbility: false, known: false },
    turn: { combatId: live.id, combatantId: combatant.id, round: round ?? live.round },
    at: clock.now(),
  };
  const decisions = await offer([event], { phase: "turn", deadline: clock.now() + promptMs() + 5_000 });
  reportDecisions(decisions);
  const used = [];
  for (const d of decisions) {
    if (d?.outcome === "used") used.push(d);
    else releaseDecisions([d]);
  }
  if (used.length) await runAfter({ holdDecisions: used });
}

/**
 * Give the reactor of a used `takeTurnNext` decision the next turn (active GM).
 * @returns {Promise<{ok: boolean, why?: string}>}
 */
export async function takeTurnNext(decision, { combatId, round } = {}) {
  const combat = game.combats?.get?.(combatId);
  if (!combat?.started || combat.round !== round) return { ok: false, why: "roundOver" };
  let reactor = null;
  try {
    reactor = fromUuidSync(decision?.candidate?.reactor?.actorUuid ?? "");
  } catch (_err) {
    reactor = null;
  }
  const c = reactor ? (combat.getCombatantsByActor?.(reactor)?.[0] ?? null) : null;
  if (!c || c.isDefeated || !((c.initiative ?? 0) > 0)) return { ok: false, why: "noTurnsLeft" };
  // Re-checked right before the write: endTurn sets turn null (DSM:11861-11867), a started turn is never overwritten.
  if (combat.combatant) return { ok: false, why: "turnTaken" };
  const turn = combat.turns.findIndex(t => t.id === c.id);
  if (turn < 0) return { ok: false, why: "noTurnsLeft" };
  await combat.update({ turn, [`flags.${MODULE_ID}.hiwStart`]: { combatantId: c.id, round } }, { direction: 1 });
  await c.update({ initiative: c.initiative - 1 });
  debug("hiw.takeTurn", { combatant: c.name, round, turn });
  return { ok: true };
}

/** End of round 1: combatants still Surprised (the system never removes it; rules: until the end of round 1). */
async function whisperSurprised(combat) {
  // onRoundEvent delivers each (combat, round, event) once; the updateCombat fallback fires once per update.
  if (!isActiveGM() || !triggersActive()) return;
  const names = [...(combat.combatants ?? [])].filter(c => c.actor?.statuses?.has?.("surprised")).map(c => c.name);
  if (!names.length) return;
  const esc = foundry.utils.escapeHTML ?? (v => String(v));
  const gms = game.users?.filter?.(u => u.isGM).map(u => u.id) ?? [];
  await ChatMessage.implementation.create({
    content: `<p>${esc(loc("DSAUTO.Trigger.SurprisedEnds", { names: names.join(", ") }))}</p>`,
    whisper: gms, speaker: { alias: game.modules?.get?.(MODULE_ID)?.title ?? MODULE_ID },
  });
}
