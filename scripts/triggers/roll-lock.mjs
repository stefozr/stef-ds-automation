/**
 * Pre-roll lock (Milestone 5, docs/M5-DESIGN.md §3.11, §6.10). Word of Guidance and the like: while an ally
 * may add an edge to a damage-dealing ability roll, the roller's AbilityConfigurationDialog is locked.
 *
 * Roller's client (every client, `renderAbilityConfigurationDialog`):
 *   - only for a damage-dealing power roll, with `triggerRollLock` on and something on that scene that could
 *     react (`engine.mayHold("roll.before")`); otherwise nothing happens (zero cost);
 *   - with Combat Tools' roll pills (its API, its ability automation at ready and `rollDialogPillUI` on) the
 *     lock goes through `api.setRollDialogLock` with our reasons merged with Combat Tools' own (one shared
 *     boolean, DSCT/ability-automation/roll-dialog-hooks.mjs:826-850): a MutationObserver re-asserts ours when
 *     its Judgement timer clears the class, and on unlock its reasons are read at that moment and kept
 *     (review conc 23); without them a class of ours greys the dialog out;
 *   - an overlay of ours always offers "Roll without waiting" (preRollCancel; review rules-ux 10);
 *   - Enter and the Roll button are blocked by a capture `submit` listener; `app.submit()` calls the form
 *     handler directly (client/applications/api/application.mjs:1641-1648), so the instance's
 *     `options.form.handler` is guarded for the dialog's lifetime;
 *   - the answer's edges become a Combat Tools pill (`api.rollDialog.addPill`) or are added to the dialog's
 *     `context.modifiers.edges` (read by the system's _processFormData, DSM:2326);
 *   - two-phase commit (deviation 11): `preRollDone {applied: true}` once the roll is submitted with the edge;
 *     closing without rolling (or no edge added) releases it.
 * `ds.canRenderAbilityConfigurationDialog` is never vetoed: on Draw Steel 1.1.x a veto hangs DSApplication.create
 * (DSM:411-426); 1.2.0 (#2194) resolves it null (draw-steel.mjs:401-408), but the guard stays for 1.1.x.
 *
 * GM (relay actions `preRoll`, `preRollCancel`, `preRollDone`): one `roll.before` offer per dialog, at most a
 * double edge in all; accepted decisions wait in memory until `preRollDone`, the round changes or 10 minutes
 * pass.
 *
 * i18n keys: DSAUTO.Trigger.RollLock.Checking, DSAUTO.Trigger.RollLock.Skip, DSAUTO.Trigger.Dialog.Countdown,
 * DSAUTO.Relay.Denied, DSAUTO.Relay.BadRequest.
 */
import { loc } from "../constants.mjs";
import { dsctApi, dsctSetting } from "../compat/dsct.mjs";
import { compat } from "../compat/version-gate.mjs";
import { debug, error, log } from "../log.mjs";
import { mayRequestHold } from "../relay/auth.mjs";
import { requestOp, requestOpVia } from "../relay/queries.mjs";
import { setting } from "../settings.mjs";
import { mayHold, offer, releaseDecisions, reportDecisions, runAfter, triggersActive } from "./engine.mjs";
import { clock, promptMs } from "./prompt.mjs";

const LOCKED_CLASS = "ds-auto-roll-locked";
const OVERLAY_CLASS = "ds-auto-roll-lock-overlay";
const DSCT_LOCKED_CLASS = "dsct-locked";
const TICK_MS = 500;
const MAX_EDGES = 2;
const PENDING_MS = 600_000;

/* Roller's client: app -> state */
const states = new Map();

/* Active GM */
const preRolls = new Map();   // dialogId -> {userId, controller}
const pending = new Map();    // holdId -> PendingCommit {holdId, kind: "preRoll", userId, decisions, effects, expires, timer}

/** Is this pre-roll commit pending on this client? (taken here even after the active GM changed, §6.4) */
export const hasPreRollPending = holdId => typeof holdId === "string" && pending.has(holdId);

const esc = v => {
  const s = String(v ?? "");
  const fn = foundry.utils?.escapeHTML;
  return typeof fn === "function" ? fn(s) : s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
};
const isActiveGM = () => !!game.users?.activeGM?.isSelf;
const randomId = () => foundry.utils?.randomID?.() ?? Math.random().toString(36).slice(2, 18);

function lookup(uuid) {
  if (!uuid) return null;
  try {
    return fromUuidSync(uuid);
  } catch (_err) {
    return null;
  }
}

/** A damage-dealing power roll (DSM:4393-4405: `options.ability` is the item). */
function damagingRoll(item) {
  try {
    if (!item?.system?.power?.roll?.enabled) return false;
    return [...(item.system.power.effects ?? [])].some(e => e?.type === "damage");
  } catch (_err) {
    return false;
  }
}

/* -------------------------------------------- */
/*  Roller's client                              */
/* -------------------------------------------- */

/** Combat Tools' roll pills are in play (review integration 12: its ability automation is decided at ready). */
function pillsOn() {
  const api = dsctApi();
  if (typeof api?.setRollDialogLock !== "function") return false;
  const rollPills = compat.rollPills ?? typeof api?.rollDialog?.addPill === "function";
  const automation = compat.dsctAbilityAutomation ?? (dsctSetting("abilityAutomationEnabled", true) !== false);
  return !!rollPills && !!automation && dsctSetting("rollDialogPillUI", true) !== false;
}

const oursHtml = st => st.ours.map(esc);
const mergedReasons = (app, st) => [...new Set([...oursHtml(st), ...(app._dsctBaneLockReasons ?? [])])];

function onRender(app) {
  const known = states.get(app);
  if (known) {
    if (known.locked) reassert(app, known);
    return;
  }
  if (!setting("triggerRollLock") || !triggersActive()) return;
  const item = app?.options?.ability;
  const actor = item?.actor;
  if (!actor || !app.element || !damagingRoll(item)) return;
  const token = actor.token ?? actor.getActiveTokens?.(false, true)?.[0] ?? null;
  const sceneId = token?.parent?.id ?? globalThis.canvas?.scene?.id ?? null;
  if (!mayHold("roll.before", sceneId)) return;                        // nothing on that scene could react

  const st = {
    dialogId: randomId(), locked: true, ours: [loc("DSAUTO.Trigger.RollLock.Checking")], holdId: null, gmId: null, edges: 0, pill: null, edgesBase: 0,
    submitted: false, committed: false, closed: false, pills: false, observer: null, overlay: null, blocker: null,
    handler: null, guard: null, tick: null, deadline: clock.now() + promptMs() + 5_000,
  };
  states.set(app, st);
  lock(app, st);
  log("rollLock.lock", { ability: item.name, actor: actor.name, dialogId: st.dialogId });
  Promise.resolve()
    .then(() => requestOp({ action: "preRoll", preRoll: { dialogId: st.dialogId, abilityUuid: item.uuid, actorUuid: actor.uuid, tokenUuid: token?.uuid ?? null } }))
    .then(r => {
      st.holdId = typeof r?.holdId === "string" ? r.holdId : null;
      st.gmId = typeof r?.gmId === "string" ? r.gmId : null;   // the GM that keeps the pending commit
      const edges = Math.min(MAX_EDGES, Math.max(0, Math.floor(Number(r?.edges) || 0)));
      if (!st.closed && !st.submitted && edges > 0) st.edges = addEdges(app, st, { edges, sources: r?.sources ?? [] });
      log("rollLock.answer", { dialogId: st.dialogId, holdId: st.holdId, edges: st.edges });
    })
    .catch(err => debug("rollLock.relay", { dialogId: st.dialogId, why: String(err?.message ?? err) }))
    .finally(() => {
      try {
        if (st.locked) unlock(app, st);
        if (st.holdId && !st.edges) done(st, false);                    // nothing was added: release it
      } catch (err) {
        error("triggers.rollLock.unlock", err);
      }
    });
}

function lock(app, st) {
  st.pills = pillsOn();
  if (st.pills) {
    dsctApi().setRollDialogLock(app, true, mergedReasons(app, st));
    const Observer = globalThis.MutationObserver;
    if (typeof Observer === "function") {
      st.observer = new Observer(() => {
        try {
          if (st.locked && !app.element?.classList?.contains?.(DSCT_LOCKED_CLASS)) dsctApi()?.setRollDialogLock?.(app, true, mergedReasons(app, st));
        } catch (err) {
          error("triggers.rollLock.observer", err);
        }
      });
      st.observer.observe(app.element, { attributes: true, attributeFilter: ["class"] });
    }
  } else app.element.classList?.add?.(LOCKED_CLASS);
  addOverlay(app, st);

  // Enter / the Roll button: our capture listener runs before AppV2's own form listener.
  st.blocker = event => {
    if (!st.locked) return;
    if (event?.target !== app.element && event?.target !== app.form) return;
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
  };
  globalThis.window?.addEventListener?.("submit", st.blocker, true);

  // app.submit() bypasses events (review conc 23): guard the instance's handler for the dialog's lifetime.
  const form = app.options?.form;
  if (form && typeof form.handler === "function") {
    st.handler = form.handler;
    st.guard = async function (...args) {
      if (st.locked) {
        // From a form event (no submitOptions) a throw keeps the dialog open (application.mjs:2140-2146);
        // a programmatic submit() just does nothing.
        if (args.length < 4) throw new Error(loc("DSAUTO.Trigger.RollLock.Checking"));
        return undefined;
      }
      st.submitted = true;
      const kept = edgeKept(app, st);                                   // read before the handler rolls
      const out = await st.handler.apply(this, args);
      if (st.holdId) done(st, kept);                                    // the roll is made: commit the edge (or release it)
      return out;
    };
    form.handler = st.guard;
  }
}

function addOverlay(app, st) {
  const doc = globalThis.document;
  if (!doc?.createElement || !app.element?.append) return;
  st.overlay?.remove?.();
  const overlay = doc.createElement("div");
  overlay.classList?.add?.(OVERLAY_CLASS);
  const card = doc.createElement("div");
  card.classList?.add?.("ds-auto-roll-lock-card");
  const reason = doc.createElement("div");
  reason.classList?.add?.("ds-auto-roll-lock-reason");
  reason.textContent = st.ours.join(" · ");
  const count = doc.createElement("div");
  count.classList?.add?.("ds-auto-countdown");
  const button = doc.createElement("button");
  button.type = "button";
  if (button.dataset) button.dataset.action = "ds-auto-roll-skip";
  button.textContent = loc("DSAUTO.Trigger.RollLock.Skip");
  button.onclick = event => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    skip(app, st);
  };
  card.append(reason, count, button);
  overlay.append(card);
  app.element.append(overlay);
  st.overlay = overlay;
  st.count = count;
  const paint = () => {
    if (st.count) st.count.textContent = loc("DSAUTO.Trigger.Dialog.Countdown", { seconds: Math.max(0, Math.ceil((st.deadline - clock.now()) / 1000)) });
  };
  paint();
  if (st.tick === null || st.tick === undefined) st.tick = setInterval(paint, TICK_MS);
}

/** "Roll without waiting": stop the GM's prompts and unlock at once. */
function skip(app, st) {
  try {
    if (!st.locked) return;
    log("rollLock.skip", { dialogId: st.dialogId });
    requestOp({ action: "preRollCancel", preRollCancel: { dialogId: st.dialogId } }).catch(() => {});
    unlock(app, st);
  } catch (err) {
    error("triggers.rollLock.skip", err);
  }
}

/** After a re-render: our lock and overlay back (Combat Tools re-asserts its own on render). */
function reassert(app, st) {
  if (st.pills) dsctApi()?.setRollDialogLock?.(app, true, mergedReasons(app, st));
  else app.element?.classList?.add?.(LOCKED_CLASS);
  if (!st.overlay?.isConnected && st.overlay?.parentNode !== app.element) addOverlay(app, st);
}

function unlock(app, st) {
  st.locked = false;
  st.observer?.disconnect?.();
  st.observer = null;
  globalThis.window?.removeEventListener?.("submit", st.blocker, true);
  if (st.tick !== null && st.tick !== undefined) clearInterval(st.tick);
  st.tick = null;
  st.overlay?.remove?.();
  st.overlay = null;
  st.count = null;
  if (st.pills) {
    // Combat Tools' reasons read now, not at lock time (review conc 23): a Judgement lock set meanwhile stays.
    const ours = new Set(oursHtml(st));
    const theirs = (app._dsctBaneLockReasons ?? []).filter(r => !ours.has(r));
    if (theirs.length && app._dsctBaneLocked !== false) dsctApi()?.setRollDialogLock?.(app, true, theirs);
    else dsctApi()?.setRollDialogLock?.(app, false);
  } else app.element?.classList?.remove?.(LOCKED_CLASS);
  // The form handler guard stays (it only commits from now on); it is restored on close.
}

function addEdges(app, st, { edges, sources }) {
  const abilities = [...new Set(sources.map(s => s?.ability).filter(Boolean))].join(", ");
  const names = [...new Set(sources.map(s => s?.name).filter(Boolean))].join(", ");
  if (st.pills) {
    // Combat Tools writes `reason` and `src` into the dialog with innerHTML (roll-dialog-hooks.mjs:448, 456, 509):
    // actor and item names are any owner's text, so they are escaped here.
    const before = new Set(Array.isArray(app._dsctSources) ? app._dsctSources : []);
    const added = dsctApi()?.rollDialog?.addPill?.(app, {
      kind: "edge", amount: edges, reason: esc(abilities || loc("DSAUTO.Trigger.RollLock.Checking")), src: names ? esc(names) : null, scope: "global",
    });
    if (added) {
      // Our pill (addExternalRollPill pushes it, roll-dialog-hooks.mjs:788-796): the roller may switch it off.
      st.pill = (Array.isArray(app._dsctSources) ? app._dsctSources : []).find(p => !before.has(p)) ?? null;
      return edges;
    }
  }
  const context = app.options?.context;
  if (!context) return 0;
  context.modifiers ??= {};
  // The dialog's global edges select only holds 0-2 (DSM:2221 modChoices): a higher value shows and submits
  // as 0 on the first form change (DSM:2275-2296). Add only what fits; 0 releases the hold.
  const cur = Math.max(0, Number(context.modifiers.edges) || 0);
  const add = Math.max(0, Math.min(edges, MAX_EDGES - cur));
  if (!add) return 0;
  context.modifiers.edges = cur + add;
  st.edgesBase = cur;
  app.render?.();
  return add;
}

/**
 * Is the edge still on the roll as it is submitted? The roller can switch Combat Tools' pill off (its click
 * handler, roll-dialog-hooks.mjs:573-583) or lower the dialog's edges select: the roll goes out without it, and
 * the reaction is released, never charged (§3.11, decision 1/7; third review). Unknown: kept.
 */
function edgeKept(app, st) {
  if (!(st.edges > 0)) return false;
  try {
    if (st.pills) {
      if (!st.pill) return true;   // not found in Combat Tools' sources: as before
      const sources = app._dsctSources;
      return st.pill.enabled !== false && (!Array.isArray(sources) || sources.includes(st.pill));
    }
    const edges = Number(app.options?.context?.modifiers?.edges);
    return !Number.isFinite(edges) || edges >= (Number(st.edgesBase) || 0) + st.edges;
  } catch (_err) {
    return true;
  }
}

function done(st, applied) {
  if (st.committed || !st.holdId) return;
  st.committed = true;
  log("rollLock.done", { dialogId: st.dialogId, holdId: st.holdId, applied });
  // To the GM that issued the hold (it keeps the pending commit), even when another GM is active now (§6.4).
  requestOpVia(st.gmId, { action: "preRollDone", preRollDone: { holdId: st.holdId, applied } })
    .catch(err => debug("rollLock.done", { why: String(err?.message ?? err) }));
}

function onClose(app) {
  const st = states.get(app);
  if (!st) return;
  st.closed = true;
  states.delete(app);
  if (st.locked) {
    requestOp({ action: "preRollCancel", preRollCancel: { dialogId: st.dialogId } }).catch(() => {});
    unlock(app, st);
  }
  if (st.holdId && !st.submitted) done(st, false);                      // closed without rolling: release the reaction
  const form = app.options?.form;
  if (form && st.guard && form.handler === st.guard) form.handler = st.handler;
}

/** Every client: renderAbilityConfigurationDialog / close hooks. GM: pending commits dropped on round change. */
export function registerRollLock() {
  Hooks.on("renderAbilityConfigurationDialog", app => {
    try {
      onRender(app);
    } catch (err) {
      error("triggers.rollLock.render", err);
    }
  });
  Hooks.on("closeAbilityConfigurationDialog", app => {
    try {
      onClose(app);
    } catch (err) {
      error("triggers.rollLock.close", err);
    }
  });
  Hooks.on("updateCombat", (combat, changes) => {
    try {
      if (isActiveGM() && changes && "round" in changes) dropPending(combat?.id, "round");
    } catch (err) {
      error("triggers.rollLock.round", err);
    }
  });
  Hooks.on("deleteCombat", combat => {
    try {
      if (isActiveGM()) dropPending(combat?.id, "combatDeleted");
    } catch (err) {
      error("triggers.rollLock.round", err);
    }
  });
}

/** Tests. */
export function isRollLocked(app) {
  return !!states.get(app)?.locked;
}

/* -------------------------------------------- */
/*  Active GM                                    */
/* -------------------------------------------- */

function releasePending(holdId, why) {
  const p = pending.get(holdId);
  if (!p) return;
  pending.delete(holdId);
  clock.clearTimeout(p.timer);
  releaseDecisions(p.decisions);
  log("preRoll.released", { holdId, why });
}

/** Round change or deleted combat: accepted edges of that combat that were never rolled are released. */
function dropPending(combatId, why) {
  for (const [holdId, p] of [...pending]) {
    if (p.decisions.some(d => (d.combatId ?? null) === (combatId ?? null))) releasePending(holdId, why);
  }
}

const NO_EDGE = Object.freeze({ ok: true, holdId: null, edges: 0, sources: [] });

/** Active GM (relay action "preRoll"). */
export async function handlePreRoll(req, user) {
  if (!isActiveGM()) return { ...NO_EDGE, sources: [] };
  const r = req?.preRoll ?? req;
  if (!r || typeof r.dialogId !== "string" || !r.dialogId || r.dialogId.length > 40
      || typeof r.abilityUuid !== "string" || typeof r.actorUuid !== "string") throw new Error("DSAUTO.Relay.BadRequest");
  const item = lookup(r.abilityUuid);
  const actor = lookup(r.actorUuid);
  if (!item || !actor || item.actor?.uuid !== actor.uuid || !mayRequestHold(user, actor)) throw new Error("DSAUTO.Relay.Denied");
  if (preRolls.has(r.dialogId)) return { ...NO_EDGE, sources: [] };   // duplicate request for one dialog
  let decisions = [];
  const controller = new AbortController();
  preRolls.set(r.dialogId, { userId: user?.id ?? null, controller });
  try {
    const token = lookup(r.tokenUuid) ?? actor.token ?? actor.getActiveTokens?.(false, true)?.[0] ?? null;
    const now = clock.now();
    const event = {
      id: randomId(), kind: "roll.before", sceneId: token?.parent?.id ?? globalThis.canvas?.scene?.id ?? null,
      subject: { actorUuid: actor.uuid, tokenUuid: token?.uuid ?? null, name: actor.name, isHero: actor.type === "hero" },
      source: { actorUuid: null, tokenUuid: null, itemUuid: null, name: null, keywords: [], fromAbility: false, known: false },
      // The requester only asks for damaging rolls; checked here again (the GM decides what an edge is for).
      roll: { abilityUuid: item.uuid, dialogId: r.dialogId, damaging: damagingRoll(item) },
      at: now,
    };
    decisions = await offer([event], { phase: "preRoll", signal: controller.signal, deadline: now + promptMs() + 5_000 });
  } catch (err) {
    error("triggers.preRoll", err);
  } finally {
    preRolls.delete(r.dialogId);
  }
  let edges = 0;
  const sources = [];
  const held = [];
  const effects = new Map();
  try {
    for (const d of decisions ?? []) {
      if (d?.outcome !== "used") continue;
      const e = Math.max(0, ...(d.steps ?? []).filter(s => s?.type === "edge").map(s => Number(s.amount) || 0));
      // Double edge is the maximum; a roll skipped meanwhile takes nothing.
      if (edges >= MAX_EDGES || e <= 0 || controller.signal.aborted) {
        d.outcome = "moot";
        d.why = controller.signal.aborted ? "skipped" : "edgeCap";
        releaseDecisions([d]);
        continue;
      }
      edges = Math.min(MAX_EDGES, edges + e);
      sources.push({ name: d.candidate?.reactor?.name ?? "", ability: d.candidate?.item?.name ?? "" });
      held.push(d);
      effects.set(d.id, { edges: e });
    }
    reportDecisions(decisions ?? []);
  } catch (err) {
    error("triggers.preRoll", err);
    releaseDecisions(held);
    return { ...NO_EDGE, sources: [] };
  }
  if (!held.length) return { ok: true, holdId: null, edges: 0, sources: [] };
  const holdId = randomId();
  pending.set(holdId, {
    holdId, kind: "preRoll", userId: user?.id ?? null, decisions: held, effects, expires: clock.now() + PENDING_MS,
    timer: clock.setTimeout(() => releasePending(holdId, "expired"), PENDING_MS),
  });
  log("preRoll.held", { holdId, edges, sources: sources.map(s => `${s.ability} (${s.name})`) });
  return { ok: true, holdId, edges, sources };
}

export async function handlePreRollCancel(req, user) {
  const r = req?.preRollCancel ?? req;
  const p = typeof r?.dialogId === "string" ? preRolls.get(r.dialogId) : null;
  if (p && (user?.isGM || p.userId === user?.id)) {
    p.controller.abort();
    log("preRoll.cancelled", { dialogId: r.dialogId });
  }
  return { ok: true };
}

/** Two-phase commit (deviation 11). */
export async function handlePreRollDone(req, user) {
  const r = req?.preRollDone ?? req;
  const p = typeof r?.holdId === "string" ? pending.get(r.holdId) : null;
  if (!p) return { ok: true };                                          // expired or unknown: nothing to commit
  if (p.userId !== user?.id) throw new Error("DSAUTO.Relay.Denied");   // committed only by its requester
  pending.delete(p.holdId);
  clock.clearTimeout(p.timer);
  if (r.applied === true) {
    log("preRoll.committed", { holdId: p.holdId });
    setTimeout(() => {
      Promise.resolve()
        .then(() => runAfter({ holdDecisions: p.decisions, origin: null, effectsByDecision: p.effects }))
        .catch(err => error("triggers.preRoll.after", err));
    }, 0);
  } else {
    releaseDecisions(p.decisions);
    log("preRoll.released", { holdId: p.holdId, why: "notRolled" });
  }
  return { ok: true };
}
