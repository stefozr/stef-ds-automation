/**
 * Triggered-action dialog and follow-ups, owner side (Milestone 5, docs/M5-DESIGN.md §3.4, §3.7, §3.8).
 * Every client; the active GM calls the same functions locally for Director-side reactors.
 *
 * Prompt router types (every one accepts GM senders only, §6.13):
 *   trigger        a DialogV2 listing the reactor's options (one radio each when there are several), what
 *                  each costs, whether it uses the round's triggered action, the resource the reactor has, the
 *                  spend label and a bleeding warning, with a countdown taken from the request's server-time
 *                  deadline (it survives re-renders: the timers are armed once). Decline is the first and
 *                  default button (an unexpected prompt must not be used by Enter or Space, review rules-ux 11);
 *                  "Not this round" mutes that ability until the round changes. Escape or the close button
 *                  counts as `closed` (= declined, C7). Answers {outcome, optionId?, spend?, mute?}.
 *   triggerCancel  closes that dialog (its answer becomes `cancelled`, nobody waits for it any more).
 *   triggerRun     starts a follow-up on this client and answers {started: true} at once:
 *                    use         target the event's token(s) (or the reactor's own token for a self ability)
 *                                and use the ability; `item.system.use()` is NOT awaited (the system resolves
 *                                it only when its dialog closes, and Combat Tools may re-roll through another
 *                                call, review integration 3): a createChatMessage watcher reports `useStarted`
 *                                or `useCancelled` to the GM (relay action `trigger`); targets are restored.
 *                                Milestone 9 (D5): `spend` ({spend effect id: n}) opens the dialog pre-ticked
 *                                (`use({}, {context: {spend}})`), so the system charges the spend itself.
 *                    freeStrike  a Strike / Skip dialog (Skip is the default) with a countdown; Strike uses the
 *                                striker's Melee Free Strike ability, or its Ranged Free Strike when the melee
 *                                one does not reach (an NPC without one: the system's free strike, on a GM's
 *                                client only, without its own dialog); Skip, a timeout or no free strike reports
 *                                `followUpFailed`. A use whose dialog closed without a card ends the watch at
 *                                once; targets are restored only when the user has not retargeted meanwhile.
 *                    retarget    Judgement / Mark: pick a new target (Combat Tools' picker within the ability's
 *                                distance; none there: a notice; else the user's own single target that is not
 *                                the downed creature, or the "target, then Use" dialog) and use the ability again.
 *                    persistentUse  Milestone 9: a kept Persistent use's free re-roll: as `use` with the dialog's
 *                                resource 0 and the card flag `persistentReroll.parent`; reports `useStarted` or
 *                                `useCancelled` through relay action `persistent` (DSAUTO.Persistent.FreeUseNotice).
 *
 * i18n keys: DSAUTO.Trigger.Dialog.{Option, OptionFor, Spend, SpendRequired, Countdown, Cost, UsesBudget, Free, Have,
 * Bleeding, Mute, Cancel, Use, Decline, Strike, Skip, PickTarget, PickTargetHint, RetargetTitle},
 * DSAUTO.Trigger.Notify.{OtherScene, NoFreeStrike, NoTarget, RetargetCancelled}, DSAUTO.Relay.{Denied, BadRequest}.
 */
import { MODULE_ID, loc } from "../constants.mjs";
import { dsctApi } from "../compat/dsct.mjs";
import { itemDsid } from "../library/identity.mjs";
import { debug, error, log } from "../log.mjs";
import { requestOp } from "../relay/queries.mjs";
import { abilityRange, distanceSquares, tokenOnScene } from "../triggers/eligibility.mjs";
import { clock, promptMs } from "../triggers/prompt.mjs";

export const FREE_STRIKE_DSID = "melee-free-strike";
export const RANGED_FREE_STRIKE_DSID = "ranged-free-strike";
/** How long a use whose dialog closed without a card still waits for one (another module's re-roll). */
const USE_GRACE_MS = 2_000;
const TICK_MS = 250;
const MAX_OPTIONS = 20;
const MAX_IDS = 10;

const dialogs = new Map();   // promptId -> state {dialog, timedOut, cancelled, armed, tick, timer}
const runs = new Set();      // triggerRun ids already started on this client (duplicate deliveries)

const esc = v => {
  const s = String(v ?? "");
  const fn = foundry.utils?.escapeHTML;
  return typeof fn === "function" ? fn(s) : s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
};
const str = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;
const optStr = (v, max) => v == null || (typeof v === "string" && v.length <= max);
const strList = (v, max, len = 300) => Array.isArray(v) && v.length <= max && v.every(s => str(s, len));
const badRequest = () => new Error("DSAUTO.Relay.BadRequest");
const denied = () => new Error("DSAUTO.Relay.Denied");
const notify = (key, data) => globalThis.ui?.notifications?.warn?.(loc(key, data));
const info = (key, data) => globalThis.ui?.notifications?.info?.(loc(key, data));

function lookup(uuid) {
  if (!uuid) return null;
  try {
    return fromUuidSync(uuid);
  } catch (_err) {
    return null;
  }
}

/* -------------------------------------------- */
/*  Countdown dialog                             */
/* -------------------------------------------- */

function stopTimers(state) {
  if (state.tick !== null) clearInterval(state.tick);
  if (state.timer !== null) clock.clearTimeout(state.timer);
  state.tick = null;
  state.timer = null;
}

/**
 * A DialogV2 that closes itself at `end` (server ms). The timers are armed on the first render only
 * (DialogV2 calls `render` on every render, dialog.mjs:420-422; review conc 24), and the countdown text is
 * written in `render`, since string content goes through cleanHTML.
 * @returns {Promise<object>} the button callback's result, or {outcome: "timedOut"|"closed"|<cancel outcome>}
 */
async function countdownDialog(id, { title, icon, content, buttons, end, onRender = null }) {
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (!DialogV2?.wait) return { outcome: "closed" };
  if (dialogs.has(id)) return { outcome: "cancelled" };                 // duplicate delivery
  const remaining = () => end - clock.now();
  if (remaining() <= 0) return { outcome: "timedOut" };
  const state = { dialog: null, timedOut: false, cancelled: null, armed: false, tick: null, timer: null };
  dialogs.set(id, state);
  const paint = () => {
    const el = state.dialog?.element?.querySelector?.(".ds-auto-countdown");
    if (el) el.textContent = loc("DSAUTO.Trigger.Dialog.Countdown", { seconds: Math.max(0, Math.ceil(remaining() / 1000)) });
  };
  let result = null;
  try {
    result = await DialogV2.wait({
      window: { title, icon },
      classes: ["ds-auto-trigger-dialog"],
      position: { width: 440 },
      content,
      rejectClose: false,
      buttons,
      render: (_event, dialog) => {
        try {
          state.dialog = dialog;
          paint();
          onRender?.(dialog);
          // Cancelled or run out before the first render: close at once.
          if (state.cancelled || state.timedOut) {
            dialog?.close?.();
            return;
          }
          if (state.armed) return;
          state.armed = true;
          state.tick = setInterval(paint, TICK_MS);
          state.timer = clock.setTimeout(() => {
            state.timedOut = true;
            state.dialog?.close?.();
          }, Math.max(0, remaining()));
        } catch (err) {
          error("triggers.dialog.render", err);
        }
      },
      close: () => {
        stopTimers(state);
      },
    });
  } catch (err) {
    error("triggers.dialog", err, { id });
    result = null;
  } finally {
    stopTimers(state);
    if (dialogs.get(id) === state) dialogs.delete(id);
  }
  if (result?.outcome) return result;
  if (state.cancelled) return { outcome: state.cancelled };
  return state.timedOut ? { outcome: "timedOut" } : { outcome: "closed" };
}

/** Close an open dialog of ours (GM cancel, release, timeout on the GM side). */
export function closeTriggerDialog(promptId, outcome = "cancelled") {
  const state = dialogs.get(promptId);
  if (!state) return false;
  state.cancelled = outcome || "cancelled";
  try {
    state.dialog?.close?.();
  } catch (err) {
    error("triggers.dialog.close", err);
  }
  return true;
}

/* -------------------------------------------- */
/*  Trigger prompt                               */
/* -------------------------------------------- */

function costLine(o) {
  const bits = [];
  if (Number(o.cost) > 0) bits.push(loc("DSAUTO.Trigger.Dialog.Cost", { cost: o.cost, resource: o.resourceName ?? "" }));
  bits.push(loc(o.budget === "triggered" ? "DSAUTO.Trigger.Dialog.UsesBudget" : "DSAUTO.Trigger.Dialog.Free"));
  // The pool only matters when something costs it (live M5 finding: "you have 0" with nothing to pay).
  const pays = Number(o.cost) > 0 || Number(o.spend?.cost) > 0;
  if (pays && o.have !== null && o.have !== undefined) bits.push(loc("DSAUTO.Trigger.Dialog.Have", { value: o.have }));
  return bits.join(" · ");
}

function optionHtml(o, i, many, showSubject) {
  // The intro already names the subject; repeat it per option only when the options differ in subject.
  const key = showSubject && o.subjectName ? "DSAUTO.Trigger.Dialog.OptionFor" : "DSAUTO.Trigger.Dialog.Option";
  const text = esc(loc(key, { ability: o.abilityName ?? "", subject: o.subjectName ?? "", steps: o.stepsText ?? "" }));
  const head = many
    ? `<label class="ds-auto-trigger-choice"><input type="radio" name="ds-auto-option" value="${i}"${i === 0 ? " checked" : ""}> <strong>${text}</strong></label>`
    : `<div class="ds-auto-trigger-choice"><strong>${text}</strong></div>`;
  const lines = [head];
  // The overlay's prompt subtitle (trigger / tracker `label`), our own words.
  if (typeof o.label === "string" && o.label) lines.push(`<div class="ds-auto-trigger-label">${esc(o.label.slice(0, 200))}</div>`);
  lines.push(`<div class="ds-auto-trigger-cost">${esc(costLine(o))}</div>`);
  if (o.bleeding) lines.push(`<div class="ds-auto-trigger-bleeding"><i class="fa-solid fa-droplet"></i> ${esc(loc("DSAUTO.Trigger.Dialog.Bleeding"))}</div>`);
  if (o.spend) {
    const key = o.spend.required ? "DSAUTO.Trigger.Dialog.SpendRequired" : "DSAUTO.Trigger.Dialog.Spend";
    const label = esc(loc(key, { cost: o.spend.cost, resource: o.resourceName ?? "" }));
    const extra = o.spend.label ? ` <span class="ds-auto-trigger-spend-label">${esc(o.spend.label)}</span>` : "";
    const flags = o.spend.required ? " checked disabled" : "";
    lines.push(`<label class="ds-auto-trigger-spend"><input type="checkbox" name="ds-auto-spend-${i}" value="1"${flags}> ${label}${extra}</label>`);
  }
  return `<li class="ds-auto-trigger-option">${lines.join("")}</li>`;
}

function promptContent(request) {
  const options = request.options ?? [];
  const many = options.length > 1;
  const showSubject = new Set(options.map(o => o.subjectName ?? "")).size > 1;
  return `<div class="ds-auto-trigger-prompt">
    ${request.intro ? `<p class="ds-auto-trigger-intro">${esc(request.intro)}</p>` : ""}
    <ul class="ds-auto-trigger-options">${options.map((o, i) => optionHtml(o, i, many, showSubject)).join("")}</ul>
    <p class="ds-auto-countdown"></p>
  </div>`;
}

const SPEND_PREFIX = "ds-auto-spend-";

/**
 * Ticking an option's spend box selects that option (its radio): readChoice reads only the selected option's
 * box, so a tick under another option would be dropped. The other options' optional boxes are unticked. One
 * delegated listener per rendered element.
 */
export function linkSpendBoxes(dialog) {
  const el = dialog?.element;
  if (!el || typeof el.addEventListener !== "function" || el.dataset?.dsAutoSpendLinked) return;
  if (el.dataset) el.dataset.dsAutoSpendLinked = "1";
  el.addEventListener("change", event => {
    try {
      const cb = event?.target;
      const name = String(cb?.name ?? "");
      if (!name.startsWith(SPEND_PREFIX) || !cb.checked) return;
      const i = name.slice(SPEND_PREFIX.length);
      const radio = el.querySelector?.(`input[name="ds-auto-option"][value="${i}"]`);
      if (radio) radio.checked = true;
      for (const other of el.querySelectorAll?.(`input[type="checkbox"][name^="${SPEND_PREFIX}"]`) ?? []) {
        if (other !== cb && !other.disabled) other.checked = false;
      }
    } catch (err) {
      debug("triggers.dialog.spend", { why: String(err?.message ?? err) });
    }
  });
}

/** The chosen option and spend, read from the dialog's form (first option when nothing is readable). */
function readChoice(form, request) {
  const options = request.options ?? [];
  let index = 0;
  if (options.length > 1) {
    const picked = Number(form?.querySelector?.('input[name="ds-auto-option"]:checked')?.value);
    if (Number.isInteger(picked) && picked >= 0 && picked < options.length) index = picked;
  }
  const option = options[index];
  if (!option) return { outcome: "closed" };
  let spend = false;
  if (option.spend) spend = option.spend.required ? true : !!form?.querySelector?.(`input[name="ds-auto-spend-${index}"]`)?.checked;
  return { outcome: "used", optionId: option.id, spend };
}

/** Open the countdown dialog; resolves {outcome: "used"|"declined"|"timedOut"|"closed"|"cancelled", optionId?, spend?, mute?}. */
export async function openTriggerDialog(request) {
  try {
    const end = Number.isFinite(request?.deadline) ? request.deadline : clock.now() + (Number(request?.timeoutMs) || promptMs());
    const buttons = [
      { action: "decline", label: "DSAUTO.Trigger.Dialog.Decline", icon: "fa-solid fa-xmark", default: true, callback: () => ({ outcome: "declined" }) },
    ];
    if (request.canMute) {
      buttons.push({ action: "mute", label: "DSAUTO.Trigger.Dialog.Mute", icon: "fa-solid fa-bell-slash", callback: () => ({ outcome: "declined", mute: true }) });
    }
    buttons.push({ action: "use", label: "DSAUTO.Trigger.Dialog.Use", icon: "fa-solid fa-check", callback: (_event, button) => readChoice(button?.form, request) });
    const answer = await countdownDialog(request.promptId, {
      title: request.title ?? "", icon: "fa-solid fa-bolt", content: promptContent(request), buttons, end,
      onRender: (request.options?.length ?? 0) > 1 ? linkSpendBoxes : null,
    });
    log("trigger.dialog", { promptId: request.promptId, outcome: answer.outcome, optionId: answer.optionId ?? null });
    return answer;
  } catch (err) {
    error("triggers.openDialog", err, { promptId: request?.promptId });
    return { outcome: "closed" };
  }
}

function validPrompt(p) {
  if (!p || typeof p !== "object" || !str(p.promptId, 40)) return false;
  if (!Array.isArray(p.options) || p.options.length < 1 || p.options.length > MAX_OPTIONS) return false;
  if (!p.options.every(o => o && typeof o === "object" && str(o.id, 200))) return false;
  if (!Number.isFinite(p.timeoutMs) || !Number.isFinite(p.deadline)) return false;
  return str(p.reactor?.actorUuid, 300) && optStr(p.title, 300) && optStr(p.intro, 1000);
}

/** Prompt router handlers (WP-E registers them for "trigger", "triggerCancel", "triggerRun"). */
export async function handleTriggerPrompt(payload, { user } = {}) {
  if (!user?.isGM) throw denied();
  if (!validPrompt(payload)) throw badRequest();
  const actor = lookup(payload.reactor.actorUuid);
  if (!actor?.isOwner) throw denied();
  return openTriggerDialog(payload);
}

export async function handleTriggerCancel(payload, { user } = {}) {
  if (!user?.isGM) throw denied();
  if (!str(payload?.promptId, 40)) throw badRequest();
  return { ok: closeTriggerDialog(payload.promptId, "cancelled") };
}

/* -------------------------------------------- */
/*  Follow-ups (triggerRun)                      */
/* -------------------------------------------- */

/** Ability parts of a chat message (a Collection in the system, a plain object in harnesses). */
function messageParts(message) {
  const parts = message?.system?.parts;
  if (!parts) return [];
  if (Array.isArray(parts.contents)) return parts.contents;
  if (Array.isArray(parts)) return parts;
  return Object.values(parts);
}

function isUseOf(message, item, actor) {
  const part = messageParts(message).find(p => p?.type === "abilityUse");
  if (!part || part.abilityUuid !== item.uuid) return false;
  const speaker = message.speaker?.actor;
  return !speaker || !actor?.id || speaker === actor.id;
}

/**
 * One-shot watcher: resolves true on the first card of this ability by this actor within `ms`, else false.
 * `giveUp(ms)` shortens the wait (the system's use() resolved without a card: its dialog was cancelled).
 */
function watchUse(item, actor, ms) {
  let done = false;
  let hookId = null;
  let timer = null;
  let finish = null;
  const p = new Promise(resolve => {
    finish = ok => {
      if (done) return;
      done = true;
      if (hookId !== null) Hooks.off?.("createChatMessage", hookId);
      if (timer !== null) clock.clearTimeout(timer);
      resolve(ok);
    };
    hookId = Hooks.on("createChatMessage", message => {
      try {
        if (!done && isUseOf(message, item, actor)) finish(true);
      } catch (err) {
        error("triggers.watchUse", err);
      }
    });
    timer = clock.setTimeout(() => finish(false), ms);
  });
  p.giveUp = (grace = USE_GRACE_MS) => {
    if (done) return;
    if (timer !== null) clock.clearTimeout(timer);
    timer = clock.setTimeout(() => finish(false), grace);
  };
  return p;
}

/** Tell the GM how a follow-up went (relay action `trigger`); never throws. */
function report(sub, triggerMessageId) {
  if (!triggerMessageId) return;
  Promise.resolve()
    .then(() => requestOp({ action: "trigger", trigger: { sub, triggerMessageId } }))
    .catch(err => debug("trigger.reportFailed", { sub, why: String(err?.message ?? err) }));
}

/**
 * Use an ability without awaiting the system's dialog (§3.7, review integration 3). The returned promise
 * resolves with use()'s result: null (or undefined after an error) when no card was made (DSM AbilityModel#use).
 */
function useAbility(item, dialogOptions = null) {
  // Milestone 9 (D5): `dialogOptions` merge into the system's dialog config (`{context: {spend}}` pre-ticks a spend).
  return Promise.resolve()
    .then(() => (dialogOptions ? item.system.use({}, dialogOptions) : item.system.use()))
    .catch(err => {
      debug("trigger.useFailed", { item: item?.name, why: String(err?.message ?? err) });
      return undefined;
    });
}

/** Use the ability and end the watch early when its dialog closed without a card. */
function useWatched(item, seen, dialogOptions = null) {
  useAbility(item, dialogOptions).then(r => {
    if (!r) seen.giveUp();
  }).catch(() => seen.giveUp());
}

/** Token ids of these token uuids on the viewed scene; `elsewhere` when some are not there. */
function tokensOnCanvas(uuids) {
  const sceneId = globalThis.canvas?.scene?.id ?? null;
  const ids = [];
  let elsewhere = false;
  for (const uuid of uuids) {
    const doc = lookup(uuid);
    if (doc && sceneId && doc.parent?.id === sceneId) ids.push(doc.id);
    else elsewhere = true;
  }
  return { ids, elsewhere };
}

/** The actor's token (placeable) on the viewed scene, or null. */
function canvasToken(actor) {
  const sceneId = globalThis.canvas?.scene?.id ?? null;
  if (!actor || !sceneId) return null;
  const tokens = actor.getActiveTokens?.(false, false) ?? [];
  return tokens.find(t => (t.document?.parent?.id ?? t.scene?.id) === sceneId) ?? null;
}

/** Replace this user's targets; returns the previous ids (to restore) or null when nothing was changed. */
function setTargets(ids) {
  const layer = globalThis.canvas?.tokens;
  if (!ids.length || typeof layer?.setTargets !== "function") return null;
  const prev = [...(game.user?.targets ?? [])].map(t => t.id);
  layer.setTargets(ids, { mode: "replace" });
  return prev;
}

/** Restore the targets `setTargets` replaced, unless the user has targeted something else since (`ids` = ours). */
function restoreTargets(prev, ids = null) {
  if (!prev) return;
  try {
    if (ids) {
      const now = [...(game.user?.targets ?? [])].map(t => t.id);
      if (now.length !== ids.length || !ids.every(id => now.includes(id))) return;
    }
    globalThis.canvas?.tokens?.setTargets?.(prev, { mode: "replace" });
  } catch (err) {
    debug("trigger.restoreTargets", { why: String(err?.message ?? err) });
  }
}

/** `use`: target, use the ability (not awaited), report whether its card came. */
async function runUse(p, item) {
  const actor = item.actor;
  let ids = [];
  let elsewhere = false;
  if (p.selfTarget) {
    const own = canvasToken(actor);
    if (own) ids = [own.id];
    else elsewhere = true;
  } else ({ ids, elsewhere } = tokensOnCanvas(p.targetTokenUuids));
  if (elsewhere) notify("DSAUTO.Trigger.Notify.OtherScene");
  const prev = setTargets(ids);
  const seen = watchUse(item, actor, p.watchMs);
  // Milestone 9 (D5): the spend the reactor chose opens pre-ticked; the system charges it.
  useWatched(item, seen, p.spend ? { context: { spend: { ...p.spend } } } : null);
  const ok = await seen;
  log("trigger.use", { item: item.name, started: ok, triggerMessageId: p.triggerMessageId });
  report(ok ? "useStarted" : "useCancelled", p.triggerMessageId);
  restoreTargets(prev, ids);
}

/** Milestone 9: tell the GM how a Persistent re-roll went (relay action `persistent`); never throws. */
function reportPersistent(sub, p) {
  Promise.resolve()
    .then(() => requestOp({ action: "persistent", persistent: { sub, parentMessageId: p.parentMessageId, runId: p.runId } }))
    .catch(err => debug("persistent.reportFailed", { sub, why: String(err?.message ?? err) }));
}

/**
 * Milestone 9 `persistentUse`: a kept Persistent use's power roll again, free (persistent/reroll.mjs). As `use`, with
 * the dialog's resource set to 0 (`AbilityModel#use` spends only what its dialog returns) and the author hint
 * `flags["stef-ds-automation"].persistentReroll.parent` on the card (the GM's expectation decides, the flag only names it).
 */
async function runPersistentUse(p, item) {
  const actor = item.actor;
  const { ids, elsewhere } = tokensOnCanvas(p.targetTokenUuids);
  if (elsewhere) notify("DSAUTO.Trigger.Notify.OtherScene");
  const prev = setTargets(ids);
  const seen = watchUse(item, actor, p.watchMs);
  info("DSAUTO.Persistent.FreeUseNotice", { ability: item.name });
  Promise.resolve()
    .then(() => item.system.use({}, { context: { resource: { value: 0 } } }, { data: { flags: { [MODULE_ID]: { persistentReroll: { parent: p.parentMessageId } } } } }))
    .catch(err => {
      debug("persistent.useFailed", { item: item?.name, why: String(err?.message ?? err) });
      return undefined;
    })
    .then(r => {
      if (!r) seen.giveUp();
    });
  const ok = await seen;
  log("persistent.use", { item: item.name, started: ok, parentMessageId: p.parentMessageId });
  reportPersistent(ok ? "useStarted" : "useCancelled", p);
  restoreTargets(prev, ids);
}

/** The striker's free strike against `against`: melee when it reaches, else ranged (Riposte: "a free strike"). */
function freeStrikeItem(actor, against) {
  const find = dsid => actor.items?.find?.(i => i.type === "ability" && itemDsid(i) === dsid) ?? null;
  const melee = find(FREE_STRIKE_DSID);
  const ranged = find(RANGED_FREE_STRIKE_DSID);
  if (!melee || !ranged || !against) return melee ?? ranged;
  const from = tokenOnScene(actor, against.parent?.id ?? null);
  const d = from ? distanceSquares(from, against) : Infinity;
  const reach = abilityRange(melee, { melee: true });
  if (Number.isFinite(d) && (reach == null || d <= reach)) return melee;
  const range = abilityRange(ranged);
  return Number.isFinite(d) && (range == null || d <= range) ? ranged : melee;
}

/** `freeStrike`: Strike / Skip with a countdown, then the striker's melee free strike. */
async function runFreeStrike(p, actor) {
  const end = Number.isFinite(p.deadline) ? p.deadline : clock.now() + p.timeoutMs;
  const answer = await countdownDialog(`run:${p.runId}`, {
    title: p.title || loc("DSAUTO.Trigger.Dialog.FreeStrikeTitle"),
    icon: "fa-solid fa-hand-fist",
    content: `<div class="ds-auto-trigger-prompt">
      ${p.intro ? `<p class="ds-auto-trigger-intro">${esc(p.intro)}</p>` : ""}
      <p class="ds-auto-countdown"></p>
    </div>`,
    buttons: [
      { action: "skip", label: "DSAUTO.Trigger.Dialog.Skip", icon: "fa-solid fa-xmark", default: true, callback: () => ({ outcome: "declined" }) },
      { action: "strike", label: "DSAUTO.Trigger.Dialog.Strike", icon: "fa-solid fa-hand-fist", callback: () => ({ outcome: "used" }) },
    ],
    end,
  });
  if (answer.outcome !== "used") {
    log("trigger.freeStrike", { actor: actor.name, outcome: answer.outcome });
    report("followUpFailed", p.triggerMessageId);
    return;
  }
  const against = lookup(p.againstTokenUuid);
  const item = freeStrikeItem(actor, against);
  if (item) {
    const { ids, elsewhere } = tokensOnCanvas(p.againstTokenUuid ? [p.againstTokenUuid] : []);
    if (elsewhere) notify("DSAUTO.Trigger.Notify.OtherScene");
    const prev = setTargets(ids);
    const seen = watchUse(item, actor, Math.max(0, end - clock.now()) + 30_000);
    useWatched(item, seen);
    const ok = await seen;
    log("trigger.freeStrike", { actor: actor.name, item: item.name, started: ok });
    report(ok ? "useStarted" : "useCancelled", p.triggerMessageId);
    restoreTargets(prev, ids);
    return;
  }
  // The system's NPC free strike writes the damage itself: on a GM's client only (a player's client cannot
  // write the target's Stamina, DSM:13576-13578). Our Strike button was the confirmation: no second dialog.
  if (actor.type === "npc" && typeof actor.system?.performFreeStrike === "function" && against?.actor && game.user?.isGM) {
    try {
      await actor.system.performFreeStrike({ targets: [against.actor], configure: false });   // DSM:13502
      report("useStarted", p.triggerMessageId);
    } catch (err) {
      error("triggers.freeStrike", err);
      report("followUpFailed", p.triggerMessageId);
    }
    return;
  }
  notify("DSAUTO.Trigger.Notify.NoFreeStrike", { name: actor.name });
  report("followUpFailed", p.triggerMessageId);
}

/** Small "target, then Use" dialog without Combat Tools' picker; true = go ahead. */
async function confirmTarget(item) {
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (!DialogV2?.wait) return false;
  const result = await DialogV2.wait({
    window: { title: loc("DSAUTO.Trigger.Dialog.RetargetTitle", { ability: item.name }), icon: "fa-solid fa-crosshairs" },
    classes: ["ds-auto-trigger-dialog"],
    content: `<p>${esc(loc("DSAUTO.Trigger.Dialog.PickTarget"))}</p>`,
    rejectClose: false,
    buttons: [
      { action: "cancel", label: "DSAUTO.Trigger.Dialog.Cancel", icon: "fa-solid fa-xmark", default: true },
      { action: "use", label: "DSAUTO.Trigger.Dialog.Use", icon: "fa-solid fa-check" },
    ],
  });
  return result === "use";
}

/** `retarget` (§3.8 owner side): a new target for Judgement / Mark, then the ability again. */
async function runRetarget(p, item) {
  const srcToken = canvasToken(item.actor);
  if (!srcToken) {
    notify("DSAUTO.Trigger.Notify.OtherScene");
    log("trigger.retarget", { item: item.name, why: "noToken" });
    return;
  }
  const api = dsctApi();
  const exclude = new Set(p.excludeTokenUuids);
  if (typeof api?.getValidTargets === "function" && typeof api?.colorTokenPicker === "function") {
    // range 0 = no limit (CTL/token-picker.mjs:21-24)
    const tokens = (api.getValidTargets(srcToken, p.targetType, p.range ?? 0, { excludeSelf: true, checkLOS: true }) ?? [])
      .filter(t => !exclude.has(t.document?.uuid));
    if (!tokens.length) {
      // CTL's picker returns null at once on an empty list (token-picker.mjs:77-78): say why nothing happens.
      notify("DSAUTO.Trigger.Notify.NoTarget", { ability: item.name });
      log("trigger.retarget", { item: item.name, outcome: "noTargets" });
      return;
    }
    // CTL's picker resolves on a click on a highlighted token; it has no Use button (token-picker.mjs:112-154).
    const picked = await api.colorTokenPicker({ tokens, title: item.name, hint: loc("DSAUTO.Trigger.Dialog.PickTargetHint", { ability: item.name }) });
    if (!picked) {
      log("trigger.retarget", { item: item.name, outcome: "noPick" });
      return;
    }
    globalThis.canvas?.tokens?.setTargets?.([picked.id], { mode: "replace" });
  } else {
    // Without the picker: exactly one target that is not the downed creature (often still targeted after the
    // strike that dropped it), else ask; checked again after the dialog.
    const okTargets = () => {
      const t = [...(game.user?.targets ?? [])];
      return t.length === 1 && !exclude.has(t[0]?.document?.uuid);
    };
    if (!okTargets() && (!(await confirmTarget(item)) || !okTargets())) {
      // The dialog is gone and nothing waits any more: say so (review).
      notify("DSAUTO.Trigger.Notify.RetargetCancelled", { ability: item.name });
      log("trigger.retarget", { item: item.name, outcome: "cancelled" });
      return;
    }
  }
  log("trigger.retarget", { item: item.name, outcome: "use" });
  useAbility(item);   // not awaited, as `use` (§3.7); the overlay applies the effect through our engine
}

/** Milestone 9 (D5): a `use` run's `spend` (absent, or at most 4 spend-effect ids of 16 characters, each 0-20). */
function validSpend(spend) {
  if (spend == null) return true;
  if (typeof spend !== "object" || Array.isArray(spend)) return false;
  const entries = Object.entries(spend);
  return entries.length <= 4 && entries.every(([k, v]) => /^[A-Za-z0-9]{16}$/.test(k) && Number.isInteger(v) && v >= 0 && v <= 20);
}

function validRun(p) {
  if (!p || typeof p !== "object" || !str(p.runId, 40)) return false;
  switch (p.kind) {
    case "use":
      return str(p.triggerMessageId, 64) && str(p.itemUuid, 300) && strList(p.targetTokenUuids, MAX_IDS)
        && typeof p.selfTarget === "boolean" && Number.isFinite(p.watchMs) && validSpend(p.spend);
    case "freeStrike":
      return str(p.triggerMessageId, 64) && str(p.actorUuid, 300) && optStr(p.againstTokenUuid, 300)
        && optStr(p.title, 300) && optStr(p.intro, 1000) && Number.isFinite(p.timeoutMs) && Number.isFinite(p.deadline);
    case "retarget":
      return str(p.itemUuid, 300) && str(p.actorUuid, 300) && (p.range === null || p.range === undefined || Number.isFinite(p.range))
        && optStr(p.targetType, 40) && strList(p.excludeTokenUuids ?? [], MAX_IDS) && optStr(p.trackerKey, 400);
    case "persistentUse":
      return str(p.itemUuid, 300) && strList(p.targetTokenUuids, MAX_IDS) && str(p.parentMessageId, 64) && Number.isFinite(p.watchMs);
    default:
      return false;
  }
}

/** Every triggerRun kind: use, freeStrike, retarget (§3.7, §3.8). */
export async function handleTriggerRun(payload, { user } = {}) {
  if (!user?.isGM) throw denied();
  if (!validRun(payload)) throw badRequest();
  const p = {
    ...payload,
    watchMs: Math.min(600_000, Math.max(5_000, Number(payload.watchMs) || promptMs() + 30_000)),
    timeoutMs: Math.min(120_000, Math.max(1_000, Number(payload.timeoutMs) || promptMs())),
    targetType: payload.targetType || "creature",
    excludeTokenUuids: payload.excludeTokenUuids ?? [],
    targetTokenUuids: payload.targetTokenUuids ?? [],
  };
  // The user must own what it acts for (§2.3); checked before anything starts.
  let work = null;
  if (p.kind === "freeStrike") {
    const actor = lookup(p.actorUuid);
    if (!actor?.isOwner) throw denied();
    work = () => runFreeStrike(p, actor);
  } else {
    const item = lookup(p.itemUuid);
    if (!item?.isOwner || !item.actor || typeof item.system?.use !== "function") throw denied();
    if (p.kind === "retarget" && item.actor.uuid !== p.actorUuid) throw badRequest();
    work = p.kind === "use" ? () => runUse(p, item) : () => runRetarget(p, item);
  }
  // Milestone 9: a kept Persistent use's free re-roll (the item checks above apply).
  if (p.kind === "persistentUse") work = () => runPersistentUse(p, lookup(p.itemUuid));
  if (runs.has(p.runId)) return { started: true };                 // duplicate delivery: already running
  runs.add(p.runId);
  if (runs.size > 200) runs.delete(runs.values().next().value);
  Promise.resolve()
    .then(work)
    .catch(err => {
      error(`triggers.run.${p.kind}`, err);
      // A failed free re-roll drops the GM's expectation, so the next (paid) use is not taken for the free one.
      if (p.kind === "persistentUse") reportPersistent("useCancelled", p);
      else if (p.kind !== "retarget") report("followUpFailed", p.triggerMessageId);
    });
  return { started: true };
}

/** For tests and selfCheck: open trigger dialogs on this client. */
export const openTriggerDialogs = () => [...dialogs.keys()];
