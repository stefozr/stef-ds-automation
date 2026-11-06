import { featuresWantAfter } from "../features/engine.mjs";
/**
 * External holds and movement gates (Milestone 5, docs/M5-DESIGN.md §3.2, §3.12, §6.11). Every client:
 *   - a MIXED wrapper on `ds.data.Actor.BaseActorModel.prototype.takeDamage` (registered at `ready`; Combat Tools
 *     1.2.8 wraps the same method with a libWrapper WRAPPER, which runs outside ours, DSCT/conditions/
 *     line-of-effect.mjs:53-76; up to 1.2.7 it reassigned the method at init, inside ours) holds damage from the
 *     system's Apply button, Target Damage rows and Combat Tools through the relay action `hold`, then
 *     reports `holdDone` (two-phase commit). `wrapped` is called at most once; an error thrown by `wrapped`
 *     is not ours and propagates (C18). Skipped: our own engine writes (`options["stef-ds-automation"].internal`),
 *     DSCT Stamina loss (`options.staminaLoss`), collision and fall damage of a forced move (DSCT
 *     `isFMActive()` here, a local window of a Combat Tools move run here, or a live `fmActive` window on the
 *     GM), minions in a squad (DSM:1655-1658);
 *   - a WRAPPER on `ds.rolls.DamageRoll.prototype.applyDamage` marks the system's own half-damage calls:
 *     the system halves before `takeDamage` and awaits each target in turn (DSM:3830-3843), so a per-target
 *     counter (`halfActors`) covers exactly those calls on this client (C16);
 *   - a WRAPPER on the static `ds.rolls.DamageRoll.applyDamageCallback` (the Apply button): Combat Tools takes
 *     that button over by default (DSCT system-patches.mjs:297-336, 347-352), halves a Shift+Click itself and
 *     calls takeDamage without `DamageRoll#applyDamage`, on this client or on the active GM through its socket
 *     (DSCT/helpers.mjs:44-51). A WRAPPER runs outside its MIXED: the Shift+Click marks the button's tokens
 *     (`markHalfDamage`; relay action `halfMark` for creatures this user does not own) and counts them in
 *     `halfActors`. Marks pause while a hold waits (`pauseExternalHalf`): one click's targets are held in turn;
 *   - a `dsct.preForcedMovement` listener (DSCT forced-movement-engine.mjs:54-82, `Hooks.call`, synchronous)
 *     and a `_preUpdateMovement` MIXED wrapper (core client/documents/token.mjs:1989, 2676) hold only when
 *     an overlay declares a `forced.before` / `move.before` trigger (none in wave 2). Our own moves are never
 *     gated: `withOwnForcedMove` marks our synchronous `api.forcedMovement` call (C6), and teleports pass
 *     `options["stef-ds-automation"].internal`;
 *   - forced-move windows: every Combat Tools move run on this client opens a local window (`localFm`): its
 *     purely vertical branch never sets DSCT's FM flag (forced-movement-engine.mjs:1596-1716, the flag is set
 *     at :1751 only), so `isFMActive()` alone misses its collision and fall damage. A player's move also
 *     announces itself to the active GM (`fmActive`) before any of its collision damage reaches the GM through
 *     DSCT's `dsct.takeDamage` socket (DSCT/helpers.mjs:44-51), where `isFMActive()` is false (review conc 21,
 *     integration 6). A window lasts while the move runs: DSCT's flag seen on, or its path picker / vertical
 *     popup open; one that never started (stability, grabbed, restrained, a cancelled pick) or a vertical move
 *     that is over ends FM_GRACE_MS after the last such sign. It covers only Combat Tools' own damage calls (a
 *     `staminaLoss` key) from that mover, or sourceless on its target;
 *   - Target Damage's Shift+Click half damage is marked per target (`markExternalHalf`, C16), as are Combat
 *     Tools' purifying fire button and its area hook on Target Damage rows (ui/dstd-lock.mjs).
 * Milestone 7 (docs/M7-DESIGN.md §3.4): while a hero's gain rule of the started combat wants damage or winded facts on
 * the scene, every external takeDamage also REPORTS (never held: Stamina loss, forced-move damage, squad minions) its
 * type (normalized: "untyped" -> ""), source, squad pool and Stamina-loss mark to the active GM; the GM only uses a
 * report to add type and source to a Stamina change it saw land itself (resources/gain-card.mjs).
 * Registration goes through compat/lib-wrapper.mjs `wrap` only. Every wrapper falls back to the plain call
 * when anything of ours fails. i18n keys used here: none.
 */
import { MODULE_ID } from "../constants.mjs";
import { dsctApi } from "../compat/dsct.mjs";
import { wrap } from "../compat/lib-wrapper.mjs";
import { debug, error, log } from "../log.mjs";
import { mayRequestHold } from "../relay/auth.mjs";
import { requestOp, requestOpVia } from "../relay/queries.mjs";
import { setting } from "../settings.mjs";
import { clearWaiting, showRequesterWaiting } from "../ui/trigger-indicator.mjs";
import { kindsInUse, mayHold, offer, reportDecisions, runAfter, triggersActive } from "./engine.mjs";
import { externalDone, externalHold } from "./holds.mjs";
import { EXTERNAL_SLACK_MS, clock, externalPromptMs, promptMs } from "./prompt.mjs";
import { normType } from "../resources/facts.mjs";
import { gainsWant } from "../resources/rules.mjs";

export const installedTriggerWrappers = { takeDamage: false, applyDamage: false, applyDamageCallback: false, preUpdateMovement: false };

const REMOTE_FM_MS = 30_000;          // a window lives this long after its last notice (open or refresh)
const FM_POLL_MS = 500;
const FM_REFRESH_MS = 15_000;
const FM_WATCH_MAX_MS = 180_000;      // a requester refreshes a window this long at most
/** A move not seen running (DSCT's flag, its picker or popup) this long is over or never started. */
const FM_GRACE_MS = 5_000;
const MAX_REMOTE_FM = 50;
/** Combat Tools' path picker bar (ctlib picker-overlay.mjs:58-59) and vertical distance popup (DSCT forced-movement-vertical-popup.mjs:16). */
const DSCT_PICKER_IDS = ["dsct-picker-topbar", "dsct-vertical-popup"];
const MAX_GATED = 200;
/** Move kinds that are never gated: placed (teleport, our displace) or already forced. */
const UNGATED_ACTIONS = new Set(["displace", "teleport", "forced"]);

const EXTERNAL_HALF_MS = 5_000;
const MAX_EXTERNAL_HALF = 100;
const DSTD_SOCKET = "module.draw-steel-target-damage";

const halfActors = new Map();   // actor / token uuid -> count: a half-damage application runs for it on this client
const externalHalf = new Map(); // actor / token uuid -> {until, at} (clock ms): a Shift+Click half marked per target
let halfPause = 0;              // > 0 while a hold waits on this client: mark lifetimes are paused
let halfPausedAt = 0;
let ownForced = 0;            // > 0 while our own api.forcedMovement call runs synchronously (C6)
const remoteFm = new Map();   // GM: id -> {userId, targetTokenUuid, sourceTokenUuid, sourceActorUuid, until}
const localFm = new Map();    // this client: id -> {targetTokenUuid, sourceTokenUuid, sourceActorUuid, until} (moves run here)
const gated = new Set();      // movement ids (chain heads) already gated on this client
let wrappersRegistered = false;
let gateRegistered = false;

const isActiveGM = () => !!game.users?.activeGM?.isSelf;
const randomID = () => globalThis.foundry?.utils?.randomID?.() ?? Math.random().toString(36).slice(2, 18);
const validUuid = v => typeof v === "string" && v.length > 0 && v.length < 300;

function lookup(uuid) {
  if (!validUuid(uuid)) return null;
  try {
    return fromUuidSync(uuid);
  } catch (_err) {
    return null;
  }
}

/** The token document an actor stands on (synthetic actor's own token, else its first active token). */
function actorToken(actor) {
  try {
    return actor?.token ?? actor?.getActiveTokens?.(false, true)?.[0] ?? null;
  } catch (_err) {
    return null;
  }
}

function snapStamina(actor) {
  const s = actor?.system?.stamina ?? {};
  return { value: Number(s.value ?? 0), temporary: Number(s.temporary ?? 0) };
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

/** At `ready`: after Combat Tools <= 1.2.7 reassigned takeDamage at init; Combat Tools 1.2.8 uses libWrapper (outside ours). */
export function registerExternalWrappers() {
  if (wrappersRegistered) return;
  wrappersRegistered = true;
  installedTriggerWrappers.takeDamage = wrap("ds.data.Actor.BaseActorModel.prototype.takeDamage", takeDamageWrapper, "MIXED");
  installedTriggerWrappers.applyDamage = wrap("ds.rolls.DamageRoll.prototype.applyDamage", applyDamageWrapper, "WRAPPER");
  installedTriggerWrappers.applyDamageCallback = wrap("ds.rolls.DamageRoll.applyDamageCallback", applyDamageCallbackWrapper, "WRAPPER");
  installedTriggerWrappers.preUpdateMovement = wrap("CONFIG.Token.documentClass.prototype._preUpdateMovement", preUpdateMovementWrapper, "MIXED");
  try {
    if (game.modules?.get?.("draw-steel-target-damage")?.active) game.socket?.on?.(DSTD_SOCKET, onDstdSocket);
  } catch (err) {
    error("triggers.dstdSocket", err);
  }
}

/** At `init`: Hooks.on("dsct.preForcedMovement", forcedGate). */
export function registerForcedGate() {
  if (gateRegistered) return;
  gateRegistered = true;
  Hooks.on("dsct.preForcedMovement", forcedGate);
}

/** Run `fn` synchronously with "this forced move is ours" set (C6). Returns fn's return value (a promise). */
export function withOwnForcedMove(fn) {
  // DSCT reaches `Hooks.call("dsct.preForcedMovement")` before its first await (forced-movement-engine.mjs:39-77,
  // helpers.mjs:79-83), so the gate fires inside fn(): the counter is back to 0 before any other move can start.
  ownForced++;
  try {
    return fn();
  } finally {
    ownForced--;
  }
}

/* -------------------------------------------- */
/*  Damage                                      */
/* -------------------------------------------- */

/** MIXED on ds.data.Actor.BaseActorModel.prototype.takeDamage; this = BaseActorModel. */
export async function takeDamageWrapper(wrapped, damage, options = {}) {
  let plan = null;
  try {
    plan = await planExternal(this, damage, options);
  } catch (err) {
    error("triggers.takeDamage", err);
    plan = null;
  }
  // Errors thrown by wrapped are the system's (or another module's): they propagate unchanged (C18).
  if (!plan) return wrapped(damage, options);
  const actor = plan.actor;
  if (plan.negated) {
    // Full negate (no wave-2 step does this): Combat Tools <= 1.2.7 disarms cover immunity in a `finally` inside
    // wrapped, which never runs when wrapped is skipped (C4). 1.2.8's WRAPPER runs outside us and disarms here
    // too; disarming twice is harmless. A halving down to 0 is not a negate: the
    // system still adds weakness to 0 damage (DSM:1667-1669), as our own engine path does.
    try {
      globalThis.ctlib?.disarmCoverImmunity?.(actor)?.catch?.(() => {});
    } catch (_err) { /* ctlib missing or changed */ }
    report(plan, true, null, null);
    return actor;
  }
  const before = snapStamina(actor);   // right before the write (review conc 19)
  let ok = false;
  try {
    const result = await wrapped(plan.amount, options);
    ok = true;
    return result;
  } finally {
    report(plan, ok, before, ok ? snapStamina(actor) : before);
  }
}

/**
 * The damage source of an external takeDamage call: DSCT's `options.dsbl.source` (DSCT/helpers.mjs:117), else Draw
 * Steel 1.2's `options.origin` (DamageRoll.getOrigin: the chat message speaker's actorUuid / tokenUuid), so features
 * with `require.sourceWithin` see chat-button hits too. Each uuid falls back on its own.
 */
export function externalSource(options) {
  const dsbl = options?.dsbl?.source ?? null;
  const origin = options?.origin ?? null;
  const pick = key => (validUuid(dsbl?.[key]) ? dsbl[key] : (validUuid(origin?.[key]) ? origin[key] : null));
  return { actorUuid: pick("actorUuid"), tokenUuid: pick("tokenUuid") };
}

/**
 * Decide whether (and how) to hold one external takeDamage call. Never throws its own errors.
 * @returns {Promise<{amount: number, holdId: string|null, actor: Actor, token: TokenDocument|null}|null>} null = untouched
 */
async function planExternal(model, damage, options) {
  const actor = model?.parent;
  if (!actor) return null;
  if (options?.[MODULE_ID]?.internal) return null;                  // our own engine writes (engine/damage.mjs; §3.1 counts them)
  const token = actorToken(actor);
  const sceneId = token?.parent?.id ?? globalThis.canvas?.scene?.id ?? null;
  // Milestone 7 (§3.4): besides holds, a report tells the active GM the type and source of a change it watches
  // (resource gains); the report alone proves nothing (the GM matches it to a Stamina change it saw land).
  const holdsOn = (triggersActive() || featuresWantAfter(sceneId)) && !!setting("triggerExternalDamage");
  const reporting = gainsWant("damage", sceneId) || gainsWant("winded", sceneId);
  if (!holdsOn && !reporting) return null;
  const staminaLoss = !!options?.staminaLoss;                      // DSCT bleeding and the like (DSCT/helpers.mjs:95-121)
  const minion = !!model.isMinion && (model.combatGroups?.size ?? 0) >= 1;
  const group = minion && model.combatGroups?.size === 1 ? (model.combatGroup ?? null) : null;
  // Never held: Stamina loss, collision / fall damage of a forced move run here or on another client (every Combat
  // Tools move opens its window in forcedGate, §3.12; no fallback on Combat Tools' FM flag, which is never cleared
  // when a move throws: forced-movement-engine.mjs:1751, 2565-2570), and minions in a squad (DSM:1655-1665).
  const noHold = staminaLoss || fmWindowsCover(localFm, actor, options)
    || (isActiveGM() && remoteFmCovers(actor, options)) || minion;
  // A Shift+Click half mark is this call's even when the half rounds to 0 (takeDamage(0)): consumed before
  // anything returns, so the creature's next hit is not taken for halved (third review).
  const halvedMark = holdsOn && !noHold ? consumeExternalHalf(actor, token) : false;
  if (!Number.isFinite(damage) || damage <= 0) return null;
  const src = externalSource(options);
  const extra = {
    type: normType(options?.type), staminaLoss, groupUuid: group?.uuid ?? null,
    source: { ...src },
  };
  // A report-only plan has no gmId: its report goes to the active GM (I28).
  const reportOnly = { amount: damage, holdId: null, gmId: undefined, actor, token, reportOnly: true, ...extra };
  if (noHold || !holdsOn) return reporting ? reportOnly : null;
  const wantAfter = mayHold("damage.after", sceneId);
  if (!mayHold("damage.before", sceneId)) {
    if (wantAfter) return { ...reportOnly, reportOnly: false };
    return reporting ? reportOnly : null;
  }

  const immunities = options?.ignoredImmunities;
  const req = {
    actorUuid: actor.uuid, tokenUuid: token?.uuid ?? null, amount: Math.floor(damage),
    type: String(options?.type ?? "").slice(0, 40),
    ignoredImmunities: (typeof immunities === "string" ? [immunities] : [...(immunities ?? [])]).slice(0, 20).map(String),
    // A half application running for this creature on this client (the system's Shift+Click, Combat Tools'
    // Apply) or a Shift+Click half marked per target (Target Damage, Combat Tools' socket); the mark is consumed.
    halved: halvedMark || halfRunning(actor, token),
    source: { ...src },
  };
  let res = null;
  let gmId = null;   // the GM that keeps the pending commit (holdDone goes there, §6.4)
  // Half marks of later targets of the same click wait while this hold does (C16): the clicking module applies
  // its targets one after another, each behind its own hold.
  const resume = pauseExternalHalf();
  if (isActiveGM()) {
    gmId = game.userId;
    res = await externalHold(req, game.user, { local: true }).catch(err => {
      error("triggers.externalHold", err);
      return null;
    }).finally(resume);
  } else {
    // The player whose click is held sees why nothing happens yet (review rules-ux 23).
    const wait = randomID();
    try {
      showRequesterWaiting(wait, { deadline: clock.now() + externalPromptMs() + EXTERNAL_SLACK_MS });
    } catch (err) {
      error("triggers.requesterWaiting", err);
    }
    try {
      res = await requestOp({ action: "hold", hold: req });
      gmId = typeof res?.gmId === "string" ? res.gmId : null;
    } catch (err) {
      debug("triggers.hold.relay", { why: String(err?.message ?? err) });
      res = null;
    } finally {
      resume();
      try {
        clearWaiting(wait);
      } catch (_err) { /* indicator gone */ }
    }
  }
  // Without a holdId nothing is committed later, so nothing may change the amount either.
  const holdId = typeof res?.holdId === "string" && res.holdId ? res.holdId : null;
  const valid = holdId && Number.isInteger(res?.amount) && res.amount >= 0 && res.amount <= damage;
  const amount = valid ? res.amount : damage;
  log("triggers.externalHold", { actor: actor.name, damage, amount, holdId, halved: req.halved });
  return {
    amount, holdId, actor, token, gmId: holdId ? gmId : null, negated: !!(valid && res.negated === true && amount === 0),
    reportOnly: false, ...extra, staminaLoss: false, groupUuid: null,
  };
}

/**
 * holdDone, fire-and-forget, never throws: a local call when this client issued the hold (or is the active
 * GM), else to the GM that issued it (its pending commit lives there; the active GM may have changed
 * meanwhile, §6.4), else to the active GM.
 */
function report(plan, applied, before, after) {
  try {
    const payload = {
      ...(plan.holdId ? { holdId: plan.holdId } : {}),
      applied: !!applied, actorUuid: plan.actor.uuid, tokenUuid: plan.token?.uuid ?? null, before, after,
      // Milestone 7 (§3.4): what the GM's Stamina watch cannot see by itself.
      type: plan.type ?? "", source: plan.source ?? null, groupUuid: plan.groupUuid ?? null,
      staminaLoss: !!plan.staminaLoss, reportOnly: !!plan.reportOnly,
    };
    if (plan.gmId ? plan.gmId === game.userId : isActiveGM()) {
      Promise.resolve(externalDone(payload, game.user)).catch(err => error("triggers.holdDone", err));
    } else {
      requestOpVia(plan.gmId, { action: "holdDone", holdDone: payload })
        .catch(err => debug("triggers.holdDone.relay", { why: String(err?.message ?? err) }));
    }
  } catch (err) {
    error("triggers.holdDone", err);
  }
}

/** WRAPPER on ds.rolls.DamageRoll.prototype.applyDamage: marks the half-damage call's targets on this client (C16). */
export async function applyDamageWrapper(wrapped, targets, options = {}) {
  if (!options?.halfDamage) return wrapped(targets, options);
  // Only the call's own targets (as the system finds them, DSM:3823): an unrelated takeDamage on this client
  // meanwhile (the call may wait on holds for seconds) is not halved.
  let ids = [];
  try {
    const actors = targets ?? globalThis.ds?.utils?.tokensToActors?.() ?? [];
    for (const a of actors) {
      if (validUuid(a?.uuid)) ids.push(a.uuid);
      if (validUuid(a?.token?.uuid)) ids.push(a.token.uuid);
    }
  } catch (_err) {
    ids = [];
  }
  const done = raiseHalf(ids);
  try {
    return await wrapped(targets, options);
  } finally {
    done();
  }
}

/** Count a half application for these actor / token uuids; returns its (idempotent) end. */
function raiseHalf(uuids) {
  const list = [...new Set((uuids ?? []).filter(validUuid))];
  for (const u of list) halfActors.set(u, (halfActors.get(u) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    for (const u of list) {
      const n = (halfActors.get(u) ?? 0) - 1;
      if (n > 0) halfActors.set(u, n);
      else halfActors.delete(u);
    }
  };
}

/** Does a half application run for this actor (or its token) on this client? */
function halfRunning(actor, token) {
  if (!halfActors.size) return false;
  return [actor?.uuid, token?.uuid, actor?.token?.uuid].some(u => u && halfActors.has(u));
}

/** The roll behind an Apply button (as the system and Combat Tools find it, DSM:3723-3730). */
function clickedRoll(btn) {
  try {
    const part = btn?.closest?.("[data-message-part]");
    const li = btn?.closest?.("[data-message-id]");
    const message = li ? game.messages?.get?.(li.dataset?.messageId) : null;
    const idx = Number.parseInt(btn?.dataset?.index, 10);
    return (part ? message?.system?.parts?.get?.(part.dataset?.messagePart)?.rolls?.[idx] : message?.rolls?.[idx]) ?? null;
  } catch (_err) {
    return null;
  }
}

/** Actor and token uuids of canvas tokens (placeables). */
export function tokenUuids(tokens) {
  const out = [];
  for (const t of tokens ?? []) {
    const doc = t?.document ?? null;
    if (validUuid(doc?.uuid)) out.push(doc.uuid);
    const actor = t?.actor ?? doc?.actor ?? null;
    if (validUuid(actor?.uuid)) out.push(actor.uuid);
  }
  return out;
}

/**
 * WRAPPER on the static ds.rolls.DamageRoll.applyDamageCallback (the Apply button). With Combat Tools' Apply
 * handling (its default without Target Damage) its MIXED halves a Shift+Click itself and never calls
 * DamageRoll#applyDamage: the button's tokens are marked halved (game.user.targets for Combat Tools, the
 * controlled tokens for the system, DSM:3720) and the call counts as halfApply on this client (C16).
 */
export async function applyDamageCallbackWrapper(wrapped, event) {
  if (!event?.shiftKey) return wrapped(event);
  let uuids = [];
  try {
    const btn = event.target?.closest?.(".apply-damage") ?? event.currentTarget ?? null;
    if (!clickedRoll(btn)?.isHeal) {
      const dsct = btn?.dataset?.dsctArea !== undefined;   // Combat Tools took the button over (system-patches.mjs:301-303)
      const tokens = dsct ? [...(game.user?.targets ?? [])] : [...(globalThis.canvas?.tokens?.controlled ?? [])];
      uuids = tokenUuids(tokens);
      await markHalfDamage(uuids);
    }
  } catch (err) {
    debug("triggers.halfClick", { why: String(err?.message ?? err) });
  }
  const done = raiseHalf(uuids);
  try {
    return await wrapped(event);
  } finally {
    done();
  }
}

/**
 * A Shift+Click half damage on this client: its targets are marked here (Combat Tools calls takeDamage locally
 * for creatures this user owns) and, for the others, on the active GM (relay action `halfMark`: Combat Tools
 * sends their takeDamage over its socket, DSCT/helpers.mjs:44-51). Awaited before the click runs on, so the mark
 * reaches the GM first. Never throws.
 */
export async function markHalfDamage(uuids) {
  try {
    const list = [...new Set((uuids ?? []).filter(validUuid))].slice(0, 40);
    if (!list.length || !triggersActive() || !setting("triggerExternalDamage") || !kindsInUse().has("damage.before")) return;
    if (isActiveGM()) {
      markExternalHalf(list);
      return;
    }
    const remote = [];
    const local = [];
    for (const u of list) {
      const doc = lookup(u);
      const actor = doc?.actor ?? doc;
      (actor?.isOwner ? local : remote).push(u);
    }
    if (local.length) markExternalHalf(local);
    if (remote.length && game.users?.activeGM) {
      await requestOp({ action: "halfMark", halfMark: { uuids: remote } })
        .catch(err => debug("triggers.halfMark.relay", { why: String(err?.message ?? err) }));
    }
  } catch (err) {
    error("triggers.halfMark", err);
  }
}

/**
 * Target Damage halves on its own path (Shift+Click: `payload.halfDamage`, DSTD chat-targeting.mjs:1210,
 * operations.mjs:27, 109) and calls takeDamage directly, never DamageRoll#applyDamage: its half clicks are
 * marked per target for a few seconds (C16, halving never stacks). A GM's click runs Target Damage's handler
 * locally (marked from ui/dstd-lock.mjs's capture listener), a player's on the active GM through Target
 * Damage's socket (DSTD socket.mjs:11-13, 52-54; marked from `onDstdSocket`, which runs before the handler
 * reaches takeDamage: the handler awaits first).
 */
export function markExternalHalf(uuids, ms = EXTERNAL_HALF_MS) {
  const at = clock.now();
  const until = at + Math.max(0, Number(ms) || 0);
  for (const u of uuids ?? []) {
    if (!validUuid(u)) continue;
    externalHalf.delete(u);   // re-inserted: the oldest marks are dropped first
    externalHalf.set(u, { until, at });
  }
  while (externalHalf.size > MAX_EXTERNAL_HALF) externalHalf.delete(externalHalf.keys().next().value);
}

/** A mark's end, counting the time the holds open on this client have waited so far (they pause it). */
function markUntil(m, now) {
  if (!halfPause) return m.until;
  const from = Math.max(m.at, halfPausedAt);
  return m.until > from ? m.until + Math.max(0, now - from) : m.until;
}

/**
 * Pause the half marks' lifetimes while a hold waits on this client (C16): Combat Tools and Target Damage apply
 * one click's targets one after another, each awaiting its takeDamage (DSCT system-patches.mjs:322-331, DSTD
 * operations.mjs:41-62), so a later target's mark must outlive the earlier targets' prompts (up to
 * externalPromptMs + 3 s each). A mark still ends EXTERNAL_HALF_MS of unpaused time after it was set. Called
 * around every hold: planExternal on the requesting client, the relay action `hold` on the GM. Returns the
 * (idempotent) end of the pause.
 */
export function pauseExternalHalf() {
  if (halfPause++ === 0) halfPausedAt = clock.now();
  let ended = false;
  return () => {
    if (ended || halfPause <= 0) return;
    ended = true;
    if (halfPause > 1) {
      halfPause--;
      return;
    }
    const now = clock.now();
    for (const m of externalHalf.values()) m.until = markUntil(m, now);
    halfPause = 0;
  };
}

/** Was a half application marked for this actor (or its token)? Consumes the mark. */
function consumeExternalHalf(actor, token) {
  if (!externalHalf.size) return false;
  const now = clock.now();
  for (const [u, m] of externalHalf) if (markUntil(m, now) <= now) externalHalf.delete(u);
  const keys = [actor?.uuid, token?.uuid, actor?.token?.uuid].filter(Boolean);
  const hit = keys.some(k => externalHalf.has(k));
  if (hit) for (const k of keys) externalHalf.delete(k);
  return hit;
}

/** The actor / token uuids of Target Damage targets (`{tokenUuid, actorUuid}`, DSTD operations.mjs:405-410). */
export function dstdTargetUuids(targets) {
  const out = [];
  for (const t of targets ?? []) {
    if (validUuid(t?.tokenUuid)) out.push(t.tokenUuid);
    if (validUuid(t?.actorUuid)) out.push(t.actorUuid);
  }
  return out;
}

/**
 * Is a Target Damage row a healing one? Its heal rows share the `applyDamage` action and apply through
 * modifyTokenAttribute, never takeDamage (DSTD operations.mjs:98-105): a half mark set for one would halve the
 * creature's next hit (third review). The roll as Target Damage finds it (operations.mjs:524-531); a synthetic
 * row says so itself (chat-targeting.mjs:947-963).
 */
export function dstdRowIsHeal({ message = null, messageId = null, partId = null, rollIndex = null, synthetic = null } = {}) {
  try {
    if (synthetic) return !!synthetic.isHeal;
    const msg = message ?? (messageId ? game.messages?.get?.(messageId) : null);
    if (!msg) return false;
    const idx = Number(rollIndex);
    if (!Number.isInteger(idx)) return false;
    const part = partId && partId !== "message" ? msg.system?.parts?.get?.(partId) : null;
    return !!(part?.rolls?.[idx] ?? msg.rolls?.[idx])?.isHeal;
  } catch (_err) {
    return false;
  }
}

/** Active GM: Target Damage's socket request of a player's Shift+Click half damage marks its targets. */
export function onDstdSocket(message) {
  try {
    if (message?.type !== "request" || message.action !== "applyDamage" || !message.payload?.halfDamage) return;
    if (!isActiveGM()) return;   // Target Damage's responsible GM (DSTD socket.mjs getResponsibleGM)
    const p = message.payload;
    if (dstdRowIsHeal({ messageId: p.messageId, partId: p.partId, rollIndex: p.rollIndex, synthetic: p.syntheticDamage })) return;
    markExternalHalf(dstdTargetUuids(Array.isArray(p.targets) && p.targets.length ? p.targets : [p.target]));
  } catch (err) {
    error("triggers.dstdHalf", err);
  }
}

/* -------------------------------------------- */
/*  Movement gates                              */
/* -------------------------------------------- */

/** MIXED on CONFIG.Token.documentClass.prototype._preUpdateMovement; this = TokenDocument. */
export async function preUpdateMovementWrapper(wrapped, movement, operation) {
  const shifting = [...(movement?.passed?.waypoints ?? []), ...(movement?.pending?.waypoints ?? [])].some(p => p.action === "shift");
  if (shifting && [...(this.actor?.effects ?? [])].some(e => !e.disabled && e.flags?.[MODULE_ID]?.ruleEffect?.benefit === "noShift")) {
    ui.notifications.warn(game.i18n.localize("DSAUTO.Aura.NoShift")); return false;
  }
  const r = await wrapped(movement, operation);
  if (r === false) return false;
  try {
    if (!triggersActive() || !kindsInUse().has("move.before")) return r;    // zero cost in wave 2
    if (operation?.[MODULE_ID]?.internal || this.movementAction === "forced" || dsctApi()?.isFMActive?.()) return r;
    const actions = [...(movement?.passed?.waypoints ?? []), ...(movement?.pending?.waypoints ?? [])].map(w => w?.action);
    if ((actions.length && actions.every(a => UNGATED_ACTIONS.has(a))) || movement?.method === "undo") return r;
    // Continuation segments of one drag share the chain's first id (core token.mjs:1040-1041).
    const id = movement?.chain?.[0] ?? movement?.id;
    if (!id || gated.has(id)) return r;
    gated.add(id);
    if (gated.size > MAX_GATED) gated.delete(gated.values().next().value);
    if (!mayHold("move.before", this.parent?.id ?? null)) return r;
    const req = { tokenUuid: this.uuid, kind: "move", movementId: String(id).slice(0, 40) };
    const res = isActiveGM() ? await handleMoveGate(req, game.user) : await requestOp({ action: "moveGate", moveGate: req });
    return res?.allow === false ? false : r;
  } catch (err) {
    debug("triggers.moveGate", { why: String(err?.message ?? err) });
    return r;
  }
}

/** Synchronous; false holds the forced move (DSCT returns early, forced-movement-engine.mjs:78) until `resume`. */
export function forcedGate(ctx) {
  let active = false;
  let kinds = new Set();
  // Collision / fall damage of this move (ours included) is never held: a local window here (the vertical
  // branch never sets DSCT's flag), announced to the GM from another client (§3.12). Opened when the move runs:
  // at once when it passes, right before resume() when it is held (the resumed run skips this hook, and a
  // window opened now would end while the gate's prompt is open; third review).
  const track = () => {
    try {
      if (active && (kinds.has("damage.before") || kinds.has("damage.after"))) trackForcedMove(ctx);
    } catch (err) {
      error("triggers.fmWatch", err);
    }
  };
  try {
    active = triggersActive();
    kinds = active ? kindsInUse() : kinds;
  } catch (err) {
    error("triggers.fmWatch", err);
  }
  if (ownForced > 0) {
    track();
    return true;   // our runDsct (delegation/forced-movement.mjs)
  }
  // Combat Tools 1.2.7 advanced enrichers probe this gate first and record a held move as 0 squares with no undo
  // (advanced-enrichers.mjs:740-770): their moves pass, without a forced.before prompt.
  if (ctx?.origin === "enricher") {
    track();
    return true;
  }
  try {
    const target = ctx?.target?.document;
    if (!active || !kinds.has("forced.before") || !target || typeof ctx?.resume !== "function"
        || !mayHold("forced.before", target.parent?.id ?? null)) {
      track();   // zero cost in wave 2 (no forced.before)
      return true;
    }
    const req = { tokenUuid: target.uuid, kind: "forced", type: ctx.type, distance: ctx.distance };
    const held = isActiveGM() ? handleMoveGate(req, game.user) : requestOp({ action: "moveGate", moveGate: req });
    // Decline or error: the move goes ahead unchanged. resume() re-runs it with DSCT's own card (documented).
    Promise.resolve(held).catch(() => null).then(res => {
      try {
        track();
        const mods = Number.isInteger(res?.distance) ? { distance: res.distance } : {};
        Promise.resolve(ctx.resume(mods)).catch(err => error("triggers.forcedResume", err));
      } catch (err) {
        error("triggers.forcedResume", err);
      }
    });
    return false;
  } catch (err) {
    error("triggers.forcedGate", err);
    track();
    return true;
  }
}

/** GM side of relay action "moveGate". */
export async function handleMoveGate(req, user) {
  const r = req?.moveGate ?? req;
  if (!isActiveGM()) return { ok: true, allow: true };
  const token = lookup(r?.tokenUuid);
  if (!token) return { ok: true, allow: true };
  if (!mayRequestHold(user, token)) throw new Error("DSAUTO.Relay.Denied");
  try {
    const actor = token.actor ?? null;
    const forced = r.kind === "forced";
    const event = {
      id: randomID(), kind: forced ? "forced.before" : "move.before", sceneId: token.parent?.id ?? null,
      subject: { actorUuid: actor?.uuid ?? null, tokenUuid: token.uuid, name: actor?.name ?? token.name ?? "", isHero: actor?.type === "hero" },
      source: { actorUuid: null, tokenUuid: null, itemUuid: null, name: null, keywords: [], fromAbility: false, known: false },
      move: {
        tokenUuid: token.uuid, forced,
        ...(forced && typeof r.type === "string" ? { type: r.type } : {}),
        ...(Number.isFinite(r.distance) ? { distance: r.distance } : {}),
      },
      at: clock.now(),
    };
    const decisions = await offer([event], { phase: "gate", deadline: clock.now() + promptMs() + 5_000 });
    reportDecisions(decisions);
    // No wave-2 step changes a move, so there is nothing to commit later: cards at once.
    for (const d of decisions) {
      if (d?.outcome !== "used") continue;
      setTimeout(() => {
        Promise.resolve(runAfter({ holdDecisions: [d] })).catch(err => error("triggers.after", err));
      }, 0);
    }
  } catch (err) {
    error("triggers.moveGate", err);
  }
  return { ok: true, allow: true };   // the field is reserved
}

/** Combat Tools' path picker or vertical distance popup is open on this client (a move waits for its user). */
function dsctPickerOpen() {
  try {
    const doc = globalThis.document;
    return DSCT_PICKER_IDS.some(id => !!doc?.getElementById?.(id));
  } catch (_err) {
    return false;
  }
}

/**
 * Watch one forced move of Combat Tools run on this client until it ends: Combat Tools' FM flag went from on to
 * off (forced-movement-engine.mjs:1751, 2565-2570), `dsct.forcedMovement` fired for this target (:46), or the
 * move was not seen running (flag on, picker or popup open) for FM_GRACE_MS: it never started (stability,
 * grabbed, restrained, a cancelled pick, :79-129, 1583-1593) or its vertical branch is over (it never sets the
 * flag). Capped at FM_WATCH_MAX_MS. `onRefresh` runs every FM_REFRESH_MS while the move is seen running.
 */
function watchForcedMove(ctx, { onRefresh = null, onEnd = null } = {}) {
  const targetId = ctx?.target?.document?.id ?? ctx?.target?.id ?? null;
  const start = clock.now();
  let lastRefresh = start;
  let lastBusy = start;
  let seen = false;
  let ended = false;
  let timer = null;
  let hookId = null;
  const end = () => {
    if (ended) return;
    ended = true;
    clock.clearTimeout(timer);
    try {
      if (hookId !== null) Hooks.off?.("dsct.forcedMovement", hookId);
    } catch (_err) { /* hook gone */ }
    try {
      onEnd?.();
    } catch (err) {
      error("triggers.fmWatch", err);
    }
  };
  try {
    hookId = Hooks.on?.("dsct.forcedMovement", data => {
      const id2 = data?.target?.document?.id ?? data?.target?.id ?? null;
      if (!targetId || !id2 || id2 === targetId) end();
    }) ?? null;
  } catch (_err) {
    hookId = null;
  }
  const poll = () => {
    if (ended) return;
    try {
      const now = clock.now();
      if (dsctApi()?.isFMActive?.()) seen = true;
      else if (seen) return end();
      const busy = seen || dsctPickerOpen();
      if (busy) lastBusy = now;
      else if (now - lastBusy >= FM_GRACE_MS) return end();
      if (now - start >= FM_WATCH_MAX_MS) return end();
      if (busy && onRefresh && now - lastRefresh >= FM_REFRESH_MS) {
        lastRefresh = now;
        onRefresh();
      }
    } catch (err) {
      debug("triggers.fmWatch", { why: String(err?.message ?? err) });
    }
    timer = clock.setTimeout(poll, FM_POLL_MS);
  };
  timer = clock.setTimeout(poll, FM_POLL_MS);
}

/**
 * A forced move of Combat Tools starts on this client: a local window (its damage here) and, on a client that
 * is not the active GM, a remote one (relay `fmActive` with a window id: its damage reaching the GM through
 * Combat Tools' socket), both ended by watchForcedMove.
 */
function trackForcedMove(ctx) {
  const id = randomID();
  const w = {
    targetTokenUuid: ctx?.target?.document?.uuid ?? null,
    sourceTokenUuid: ctx?.source?.document?.uuid ?? null,
    sourceActorUuid: ctx?.source?.actor?.uuid ?? null,
  };
  if (!w.targetTokenUuid && !w.sourceTokenUuid && !w.sourceActorUuid) return;
  localFm.set(id, { ...w, until: clock.now() + FM_WATCH_MAX_MS });
  while (localFm.size > MAX_REMOTE_FM) localFm.delete(localFm.keys().next().value);
  const remote = !isActiveGM() && !!game.users?.activeGM;
  const send = extra => requestOp({ action: "fmActive", fmActive: { id, ...extra } })
    .catch(err => debug("triggers.fmActive.relay", { why: String(err?.message ?? err) }));
  if (remote) send(w);
  watchForcedMove(ctx, {
    onRefresh: remote ? () => send({ refresh: true }) : null,
    onEnd: () => {
      localFm.delete(id);
      if (remote) send({ end: true });
    },
  });
}

/**
 * GM side of "fmActive" (review conc 21, integration 6): open a window for a forced move run on another client
 * (`id` from the requester), extend it (`refresh`) or end it (`end`). A window only lets Combat Tools' own damage
 * calls through (remoteFmCovers).
 */
export function handleFmActive(req, user) {
  const r = req?.fmActive ?? req;
  if (!isActiveGM()) return { ok: true };
  const userId = user?.id ?? null;
  const cid = typeof r?.id === "string" && r.id.length > 0 && r.id.length <= 40 ? r.id : null;
  const key = cid ? `${userId}:${cid}` : randomID();
  if (cid && (r.end === true || r.refresh === true)) {
    const w = remoteFm.get(key) ?? null;
    if (w) {
      if (r.end === true) remoteFm.delete(key);
      else w.until = Math.min(w.created + FM_WATCH_MAX_MS + REMOTE_FM_MS, clock.now() + REMOTE_FM_MS);
    }
    debug("triggers.fmActive", { user: user?.name, id: cid, end: r.end === true, refresh: r.refresh === true, known: !!w });
    return { ok: true };
  }
  const target = validUuid(r?.targetTokenUuid) ? r.targetTokenUuid : null;
  const sourceToken = validUuid(r?.sourceTokenUuid) ? r.sourceTokenUuid : null;
  const sourceActor = validUuid(r?.sourceActorUuid) ? r.sourceActorUuid : null;
  if (!target && !sourceToken && !sourceActor) return { ok: true };
  // It can only let damage through unheld, and only for a mover or target the user owns.
  if (!user?.isGM && ![target, sourceToken, sourceActor].some(u => u && mayRequestHold(user, lookup(u)))) {
    throw new Error("DSAUTO.Relay.Denied");
  }
  pruneRemoteFm();
  const now = clock.now();
  remoteFm.set(key, {
    userId, targetTokenUuid: target, sourceTokenUuid: sourceToken, sourceActorUuid: sourceActor, created: now,
    until: now + REMOTE_FM_MS,
  });
  while (remoteFm.size > MAX_REMOTE_FM) remoteFm.delete(remoteFm.keys().next().value);
  debug("triggers.fmActive", { user: user?.name, target, sourceToken, sourceActor });
  return { ok: true };
}

function pruneRemoteFm() {
  const now = clock.now();
  for (const [id, w] of remoteFm) if (w.until <= now) remoteFm.delete(id);
}

/**
 * GM: does a live remote forced-move window cover this takeDamage call? Only Combat Tools' forced-move damage
 * calls (isForcedMoveCall): one whose `dsbl.source` is the window's mover, or a sourceless one on its target.
 */
export function remoteFmCovers(actor, options) {
  pruneRemoteFm();
  return fmWindowsCover(remoteFm, actor, options);
}

/**
 * Is this takeDamage call shaped like Combat Tools' forced-move damage? DSCT/helpers.mjs:117 passes a
 * `staminaLoss` key on every Combat Tools damage call (the system's Apply button, Target Damage rows and the free
 * strike never do). Its forced move wraps itself in `withDamageSource({tokenUuid, actorUuid})` (DSCT
 * forced-movement-engine.mjs:43); its takeover of the Apply button passes `messageDamageSource(msg)`, which always
 * has an `ability` key (DSCT/helpers.mjs:84-92, system-patches.mjs:330-332): that damage is not a forced move's.
 */
function isForcedMoveCall(options) {
  if (!options || !Object.prototype.hasOwnProperty.call(options, "staminaLoss")) return false;
  const src = options?.dsbl?.source ?? null;
  return !(src && typeof src === "object" && Object.prototype.hasOwnProperty.call(src, "ability"));
}

/** Does a live forced-move window of `windows` (remoteFm, localFm) cover this takeDamage call? (rule above) */
function fmWindowsCover(windows, actor, options) {
  try {
    if (!windows.size || !actor) return false;
    if (!isForcedMoveCall(options)) return false;
    // DSCT's withDamageSource wraps the whole forced move, collisions and falls included (DSCT/helpers.mjs:79-83, 117).
    const src = options?.dsbl?.source ?? null;
    const tokenUuids = new Set([actor.token?.uuid, ...(actor.getActiveTokens?.(false, true) ?? []).map(t => t?.uuid)].filter(Boolean));
    const now = clock.now();
    for (const w of windows.values()) {
      if (w.until <= now) continue;
      if (src && ((w.sourceTokenUuid && w.sourceTokenUuid === src.tokenUuid) || (w.sourceActorUuid && w.sourceActorUuid === src.actorUuid))) return true;
      // Damage from another source on the pushed creature is not this move's.
      if (!src && w.targetTokenUuid && tokenUuids.has(w.targetTokenUuid)) return true;
    }
    // Not covered: a forced move without a source damaging a blocker that is not its target (documented).
    return false;
  } catch (err) {
    error("triggers.remoteFm", err);
    return false;
  }
}
