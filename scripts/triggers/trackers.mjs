/**
 * Trackers (Milestone 5, docs/M5-DESIGN.md §1.3, §3.8). Judgement and Mark: on the active GM, a tracked
 * creature reaching 0 Stamina (or getting `dying` / `dead`) prompts the source's owner once the engine is
 * done with the card that caused it (its forced movement included); a revive cancels an open prompt;
 * accept runs the `retarget` follow-up on the owner's client. A new tracked effect created by a different
 * card ends the source's earlier ones; Mark also ends when its tactician is dying.
 *
 * - Kill detection: `updateActor` with `system.stamina.value <= 0` whose previous value (stashed by the
 *   system's `_preUpdate` in `options.ds.previousStamina`, DSM:1511-1514) was above 0, and `createActiveEffect`
 *   with status `dead` / `dying` (squads die through Death Tracker's `dead` status, R§deathtracker F7). Both
 *   fire inside the engine's own Stamina write, so the prompt waits for that card's lock to clear
 *   (`applyingMessageFor` / `messageIdle`, C14, review conc 7) and for Combat Tools' forced move to end.
 * - One prompt per (source actor, effect, creature) until the creature is above 0 again (re-armed).
 * - Effects Combat Tools made itself (flag `judgement` / `mark`, DSCT tactical-effects.mjs:62, 112) and
 *   creatures carrying such an effect of the same source are left to Combat Tools (it posts its own card).
 * - "Use it again" ends the source's older effects only for engine-made effects (stamped with their card's
 *   id by engine/library-apply.mjs), never for an undo restore (`options["stef-ds-automation"].restore`). The free
 *   re-target after a kill marks a new target in place of the downed one: its effect ends only the downed
 *   creature's (`retargets`), so Anticipation's second mark stays.
 * engine/engine.mjs `applyingMessageFor` / `messageIdle` are read through the module namespace, so this file
 * also loads (and degrades to a short wait) before those exports exist.
 * i18n keys used here: DSAUTO.Trigger.Dialog.RetargetTitle, DSAUTO.Trigger.Dialog.Event.zero,
 * DSAUTO.Trigger.Step.retarget.
 */
import { DSCT_ID, HOOKS, MODULE_ID, loc } from "../constants.mjs";
import { dsctApi } from "../compat/dsct.mjs";
import * as engineCore from "../engine/engine.mjs";
import { allOverlays, onRegistryChange } from "../library/registry.mjs";
import { debug, error, log } from "../log.mjs";
import { setting } from "../settings.mjs";
import { combatFor } from "./budget.mjs";
import { abilityRange, incapacitated, resourceName, restricted, tokenOnScene } from "./eligibility.mjs";
import { itemTriggers, triggersActive } from "./engine.mjs";
import { cancelPrompt, clock, promptMs, promptReactor, runFollowUp, withReactorQueue } from "./prompt.mjs";

const MAX_FIRED = 2000;
/**
 * `${sourceActorPart}|${effectId}|${creatureUuid}` -> generation: prompted once until re-armed. A re-target
 * still waiting for the card's lock goes on only while its generation is current (a revive and a second kill
 * meanwhile schedule a new one; third review).
 */
const fired = new Map();
const trackerPrompts = new Map();   // promptId -> {creatureUuid, controller}
/** `${sourceActorPart}|${effectId}` -> {creatureUuid, until}: a re-target follow-up started for that downed creature. */
const retargets = new Map();
/** A re-target's pick and ability use finish within this (a later plain use of the ability ends every older effect). */
const RETARGET_MS = 120_000;
let registeredHooks = false;
let idCache = null;                 // tracker effect ids declared by registered overlays

const isActiveGM = () => !!game.users?.activeGM?.isSelf;
const randomID = () => globalThis.foundry?.utils?.randomID?.() ?? Math.random().toString(36).slice(2, 18);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Every handler: active GM, engine on, trackers on. */
const trackersOn = () => isActiveGM() && triggersActive() && !!setting("triggerTrackers");

function lookup(uuid) {
  if (typeof uuid !== "string" || !uuid) return null;
  try {
    return fromUuidSync(uuid);
  } catch (_err) {
    return null;
  }
}

/** "Actor.<id>" (or "Scene.<id>.Token.<id>.Actor.<id>") of an origin uuid; survives a replaced item. */
function actorPart(origin) {
  const m = typeof origin === "string" ? origin.match(/^(.*?Actor\.[A-Za-z0-9]+)/) : null;
  return m ? m[1] : null;
}

/** Tracker effect ids of every registered overlay (cached per registry change). */
function trackerEffectIds() {
  if (idCache) return idCache;
  const ids = new Set();
  try {
    for (const o of allOverlays()) for (const t of o?.trackers ?? []) if (t?.effect) ids.add(t.effect);
  } catch (err) {
    error("trackers.ids", err);
  }
  return (idCache = ids);
}

/** Could this effect be a tracker? A registered tracker id, or an engine-made effect (a detach stamp may declare it). */
const mayTrack = e => !!e && (trackerEffectIds().has(e.id) || !!e.flags?.[MODULE_ID]?.messageId);

/** Combat Tools' own Judgement / Mark effect flag, read without getFlag (which throws for inactive scopes). */
const dsctTracker = e => e?.flags?.[DSCT_ID]?.judgement ?? e?.flags?.[DSCT_ID]?.mark ?? null;

function trackersOf(item) {
  try {
    return item ? (itemTriggers(item)?.trackers ?? []) : [];
  } catch (_err) {
    return [];
  }
}

/** Stamina at or below 0, or dying / dead. */
function isDown(actor) {
  const v = Number(actor?.system?.stamina?.value);
  return (Number.isFinite(v) && v <= 0) || !!actor?.statuses?.has?.("dead") || !!actor?.statuses?.has?.("dying");
}

function rearm(creatureUuid) {
  const suffix = `|${creatureUuid}`;
  for (const k of [...fired.keys()]) if (k.endsWith(suffix)) fired.delete(k);
}

function remember(key) {
  const gen = randomID();
  fired.set(key, gen);
  if (fired.size > MAX_FIRED) fired.delete(fired.keys().next().value);
  return gen;
}

/** Poll `test` every 100 ms until true or `maxMs` passed. */
async function until(test, maxMs, step = 100) {
  const end = Date.now() + maxMs;
  for (;;) {
    let ok = true;
    try {
      ok = !!test();
    } catch (_err) {
      ok = true;
    }
    if (ok) return true;
    if (Date.now() >= end) return false;
    await sleep(step);
  }
}

/** World actors plus the actors of the scene's tokens (unlinked creatures), each once. */
function candidateActors(sceneId) {
  const out = new Map();
  for (const a of game.actors ?? []) if (a?.uuid) out.set(a.uuid, a);
  const scene = (sceneId ? game.scenes?.get?.(sceneId) : null) ?? combatFor(sceneId)?.scene ?? globalThis.canvas?.scene ?? null;
  for (const t of scene?.tokens ?? []) {
    const a = t?.actor;
    if (a?.uuid && !out.has(a.uuid)) out.set(a.uuid, a);
  }
  return [...out.values()];
}

function tokenOf(actor) {
  try {
    return actor?.token ?? actor?.getActiveTokens?.(false, true)?.[0] ?? null;
  } catch (_err) {
    return null;
  }
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

export function registerTrackers() {
  if (registeredHooks) return;
  registeredHooks = true;
  try {
    onRegistryChange(() => { idCache = null; });
  } catch (err) {
    error("trackers.register", err);
  }
  Hooks.on("updateActor", onUpdateActor);
  Hooks.on("createActiveEffect", onCreateEffect);
  Hooks.on("deleteActiveEffect", onDeleteEffect);
}

function onUpdateActor(actor, changes, options) {
  try {
    if (!trackersOn()) return;
    const v = changes?.system?.stamina?.value;
    if (v === undefined || v === null) return;
    if (v > 0) {
      // Revived (an undo, a heal): ask again next time, and drop a prompt about it (review conc 9).
      rearm(actor.uuid);
      cancelTrackerPrompts(actor.uuid, "moot");
      return;
    }
    const prev = options?.ds?.previousStamina?.value;
    if (prev !== undefined && prev !== null && prev <= 0) return;
    onZero(actor).catch(err => error("trackers.zero", err));
  } catch (err) {
    error("trackers.updateActor", err);
  }
}

function onCreateEffect(effect, options) {
  try {
    if (!trackersOn()) return;
    const actor = effect?.parent;
    if (actor?.documentName !== "Actor") return;
    const statuses = effect.statuses ?? new Set();
    if (statuses.has("dead") || statuses.has("dying")) onZero(actor).catch(err => error("trackers.zero", err));
    if (statuses.has("dying")) onSourceDying(actor).catch(err => error("trackers.sourceDying", err));
    // Engine-made and not an undo restore (review conc 10, integration 21).
    if (effect.origin && effect.flags?.[MODULE_ID]?.messageId && !options?.[MODULE_ID]?.restore && mayTrack(effect)) {
      onTrackedEffectCreated(effect, options).catch(err => error("trackers.created", err));
    }
  } catch (err) {
    error("trackers.createEffect", err);
  }
}

function onDeleteEffect(effect) {
  try {
    if (!trackersOn()) return;
    const actor = effect?.parent;
    if (actor?.documentName !== "Actor") return;
    const statuses = effect.statuses ?? new Set();
    if ((statuses.has("dead") || statuses.has("dying")) && Number(actor.system?.stamina?.value) > 0) {
      rearm(actor.uuid);
      cancelTrackerPrompts(actor.uuid, "moot");
    }
  } catch (err) {
    error("trackers.deleteEffect", err);
  }
}

/* -------------------------------------------- */
/*  Lookup                                      */
/* -------------------------------------------- */

/** Tracker of an effect: by its origin item, else any item of the origin's actor declaring a tracker for that effect id. */
export function trackerFor(effect) {
  try {
    if (!effect?.origin) return null;
    const origin = lookup(effect.origin);
    const originItem = origin?.documentName === "Item" ? origin : null;
    const srcActor = originItem?.actor ?? (origin?.documentName === "Actor" ? origin : lookup(actorPart(effect.origin)));
    if (!srcActor) return null;
    const declares = i => trackersOf(i).some(t => t?.effect === effect.id);
    // A Mark applied by another tactician ability carries that item as its origin (review rules-ux 20).
    const item = originItem && declares(originItem) ? originItem : (srcActor.items?.find?.(declares) ?? null);
    const tracker = item ? trackersOf(item).find(t => t?.effect === effect.id) : null;
    return tracker ? { item, sourceActor: srcActor, tracker } : null;
  } catch (err) {
    error("trackers.trackerFor", err);
    return null;
  }
}

/** Tracker effects on a creature: [{effect, item, sourceActor, tracker}] (DSCT-flagged ones excluded). */
export function trackedEffects(actor) {
  const out = [];
  try {
    const effects = [...(actor?.effects ?? [])];
    for (const e of effects) {
      if (!mayTrack(e) || dsctTracker(e)) continue;
      const t = trackerFor(e);
      if (!t) continue;
      // Combat Tools tracks this source on that creature itself and posts its own card.
      if (effects.some(x => dsctTracker(x)?.actorId === t.sourceActor.id)) continue;
      out.push({ effect: e, ...t });
    }
  } catch (err) {
    error("trackers.tracked", err);
  }
  return out;
}

/* -------------------------------------------- */
/*  Zero Stamina: re-target                     */
/* -------------------------------------------- */

export async function onZero(actor) {
  if (!trackersOn() || !actor) return;
  for (const t of trackedEffects(actor)) {
    if (t.tracker.onZero !== "retarget") continue;
    const key = `${actorPart(t.effect.origin)}|${t.effect.id}|${actor.uuid}`;
    if (fired.has(key)) continue;
    const gen = remember(key);
    // Never awaited by the hook: it fires inside the engine's own write.
    retarget(t, actor, key, gen).catch(err => error("trackers.retarget", err));
  }
}

async function retarget(t, creature, key, gen = fired.get(key)) {
  // Registered before the waits: a revive meanwhile aborts it (review conc 9; third review).
  const promptId = randomID();
  const controller = new AbortController();
  trackerPrompts.set(promptId, { creatureUuid: creature.uuid, controller });
  try {
    await retargetAfterWaits(t, creature, key, gen, promptId, controller);
  } finally {
    trackerPrompts.delete(promptId);
  }
}

/** Still the current re-target of that kill? (not revived, no second kill meanwhile) */
const current = (key, gen, controller) => !controller.signal.aborted && fired.get(key) === gen;

async function retargetAfterWaits(t, creature, key, gen, promptId, controller) {
  await sleep(0);   // updateActor fires inside takeDamage, inside the engine's apply list
  // The card that caused it, its write and its forced movement come first (R§rules 1.2; C14, review conc 7).
  const messageId = engineCore.applyingMessageFor?.(creature.uuid) ?? null;
  if (messageId && typeof engineCore.messageIdle === "function") await engineCore.messageIdle(messageId);
  else await until(() => !engineCore.applyingMessageFor?.(creature.uuid), 15_000);   // e.g. a kill through Death Tracker's dead status
  await until(() => !dsctApi()?.isFMActive?.(), 10_000);
  if (!current(key, gen, controller)) {
    debug("tracker.moot", { why: "superseded", creature: creature.name });
    return;
  }

  const src = t.sourceActor;
  const creatureToken = tokenOf(creature);
  const sceneId = creatureToken?.parent?.id ?? globalThis.canvas?.scene?.id ?? null;
  const combat = combatFor(sceneId);
  const info = { tracker: t.tracker, effectUuid: t.effect.uuid, creatureUuid: creature.uuid, sourceActorUuid: src.uuid, itemUuid: t.item.uuid };
  const srcToken = tokenOnScene(src, sceneId);
  // Decision 6: a free triggered use of a maneuver, so dazed (and the like) blocks it.
  if (!srcToken || incapacitated(src, combat) || restricted(src, t.item, "freeTriggered", combat)
      || (!combat && !setting("triggersOutsideCombat"))) {
    debug("tracker.ineligible", { source: src.name, creature: creature.name, item: t.item.name });
    Hooks.callAll(HOOKS.trackerZero, info, "ineligible");
    return;
  }
  if (!isDown(creature)) return;   // revived meanwhile

  const T = promptMs();
  const deadline = clock.now() + T + 5_000;
  const request = {
    type: "trigger", promptId, title: loc("DSAUTO.Trigger.Dialog.RetargetTitle", { ability: t.item.name }),
    intro: loc("DSAUTO.Trigger.Dialog.Event.zero", { subject: creature.name }),
    reactor: { actorUuid: src.uuid, name: src.name, img: src.img }, canMute: false,
    options: [{
      id: "retarget", abilityName: t.item.name, subjectName: creature.name, eventKind: "zero", label: t.tracker.label ?? null,
      stepsText: loc("DSAUTO.Trigger.Step.retarget"), cost: 0, resourceName: resourceName(src), have: null,
      budget: "free", spend: null, bleeding: false,
    }],
  };
  let answer;
  let timer = null;
  try {
    // The wait in the reactor's queue ends by the deadline - 3 s as well (as engine.offer, §6.2).
    const job = { started: false, abandoned: false };
    const give = new Promise(resolve => {
      timer = clock.setTimeout(() => {
        if (job.started) return;
        job.abandoned = true;
        resolve({ outcome: "timedOut", why: "deadline", by: null, at: clock.now() });
      }, Math.max(0, deadline - 3_000 - clock.now()));
    });
    const run = withReactorQueue(src.uuid, async () => {
      if (job.abandoned) return null;
      job.started = true;
      // A queued prompt gets only the time left before its deadline, or none at all (as engine.offer).
      const remaining = deadline - clock.now();
      if (!current(key, gen, controller) || !isDown(creature)) return { outcome: "cancelled", by: null, at: clock.now() };
      if (remaining < 3_000) return { outcome: "timedOut", why: "deadline", by: null, at: clock.now() };
      return promptReactor(src, request, { signal: controller.signal, timeoutMs: Math.min(T, remaining - 3_000) });
    });
    answer = await Promise.race([run, give]);
  } finally {
    clock.clearTimeout(timer);
    trackerPrompts.delete(promptId);
  }
  const outcome = answer?.outcome ?? "noAnswer";
  Hooks.callAll(HOOKS.trackerZero, info, outcome);
  if (outcome !== "used") {
    log("tracker.answer", { source: src.name, creature: creature.name, item: t.item.name, outcome });
    return;
  }
  if (!isDown(creature) || fired.get(key) !== gen) {
    log("tracker.moot", { why: "revived", creature: creature.name });   // undone while the prompt was open (review conc 9)
    return;
  }
  const by = answer.by ? game.users?.get?.(answer.by) : null;
  const user = by && !by.isGM ? by : null;   // null: the active GM's own client
  // The new effect replaces the downed creature's only (set before the follow-up can create it).
  const rkey = `${actorPart(t.effect.origin) ?? src.uuid}|${t.effect.id}`;
  retargets.set(rkey, { creatureUuid: creature.uuid, until: clock.now() + RETARGET_MS });
  const result = await runFollowUp(user, {
    kind: "retarget", runId: randomID(), itemUuid: t.item.uuid, actorUuid: src.uuid, trackerKey: key.slice(0, 300),
    range: abilityRange(t.item), targetType: t.item.system?.target?.type ?? "creature",
    excludeTokenUuids: [creatureToken?.uuid].filter(Boolean),
  });
  if (!result?.started) retargets.delete(rkey);
  log("tracker.retarget", { source: src.name, creature: creature.name, item: t.item.name, user: user?.name ?? null, started: !!result?.started });
}

/** The re-target follow-up this new effect comes from (consumed), or null. */
function takeRetarget(origin, effectId) {
  const now = clock.now();
  for (const [k, r] of retargets) if (r.until <= now) retargets.delete(k);
  const key = `${origin}|${effectId}`;
  const r = retargets.get(key) ?? null;
  if (r) retargets.delete(key);
  return r;
}

/** Cancel open re-target prompts about a creature (revived, review conc 9). */
export function cancelTrackerPrompts(creatureUuid, why = "moot") {
  let n = 0;
  for (const [promptId, p] of trackerPrompts) {
    if (p.creatureUuid !== creatureUuid) continue;
    // Abort covers a prompt still queued behind another one; cancelPrompt closes an open one.
    try {
      p.controller.abort();
    } catch (_err) { /* already aborted */ }
    try {
      cancelPrompt(promptId, why);
    } catch (err) {
      error("trackers.cancel", err);
    }
    n++;
  }
  return n;
}

/* -------------------------------------------- */
/*  Ending older effects                        */
/* -------------------------------------------- */

/** "Use this ability again" (decision 10): the same source's older effects end; the same card's are kept. */
export async function onTrackedEffectCreated(effect, options) {
  if (!trackersOn()) return;
  const t = trackerFor(effect);
  if (!t?.tracker?.endPrevious) return;
  const stamp = effect.flags?.[MODULE_ID]?.messageId ?? null;
  const origin = actorPart(effect.origin);
  const parent = effect.parent;
  const sceneId = tokenOf(parent)?.parent?.id ?? null;
  // A re-target after a kill: "mark a new target" in place of the downed creature, the others stay.
  const re = origin ? takeRetarget(origin, effect.id) : null;
  for (const actor of candidateActors(sceneId)) {
    if (actor === parent || actor.uuid === parent?.uuid) continue;
    if (re && actor.uuid !== re.creatureUuid) continue;
    const ids = [...(actor.effects ?? [])]
      .filter(e => e.id === effect.id && actorPart(e.origin) === origin && e.flags?.[MODULE_ID]?.messageId !== stamp)
      .map(e => e.id);
    if (!ids.length) continue;
    try {
      await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
      log("tracker.endPrevious", { item: t.item.name, from: actor.name, to: parent?.name });
    } catch (err) {
      error("trackers.endPrevious", err, { actor: actor.name });
    }
  }
  if (parent?.uuid) rearm(parent.uuid);
}

/** Mark: "until you are dying". */
export async function onSourceDying(actor) {
  if (!trackersOn() || !actor) return;
  const effectIds = new Set();
  for (const item of actor.items ?? []) {
    for (const t of trackersOf(item)) if (t?.endOnSourceDying && t.effect) effectIds.add(t.effect);
  }
  if (!effectIds.size) return;
  const sceneId = tokenOf(actor)?.parent?.id ?? null;
  for (const other of candidateActors(sceneId)) {
    const ids = [...effectIds].filter(id => {
      const e = other.effects?.get?.(id);
      return e && actorPart(e.origin) === actor.uuid;
    });
    if (!ids.length) continue;
    try {
      await other.deleteEmbeddedDocuments("ActiveEffect", ids);
      log("tracker.sourceDying", { source: actor.name, from: other.name });
    } catch (err) {
      error("trackers.sourceDying", err, { actor: other.name });
    }
  }
}
