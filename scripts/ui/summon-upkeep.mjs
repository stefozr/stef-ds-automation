/**
 * Persistent upkeep dialog, owner side (Milestone 6, docs/M6-DESIGN.md §1.7, §3.11). Every client; there is no
 * GM-local use (an NPC summoner, or nobody online to answer, is dismissed by the GM: Q16).
 *
 * Prompt router types (GM senders only; the router checks too, S/relay/prompt-router.mjs):
 *   summonUpkeep        a DialogV2 "Keep <summon>?" with the Persistent cost, the resource and what the summoner
 *                       has, and a countdown (text and bar) to the request's server-time `deadline`; the timers
 *                       are armed on the first render only (DialogV2 calls `render` on every render). "Let it go"
 *                       is the first and default button (an unexpected prompt must not be kept by Enter or Space,
 *                       as the trigger dialog); Escape or the close button counts as `closed`. Answers {outcome:
 *                       "keep" | "release" | "timedOut" | "closed" | "cancelled"}. The GM pays on Keep (§3.11).
 *   summonUpkeepCancel  closes that dialog (its answer becomes `cancelled`, nobody waits for it any more);
 *                       answers {ok}.
 *
 * Milestone 9: `kind: "persistent"` (ui/persistent-prompts.mjs) keeps an ability use: DSAUTO.Persistent.Upkeep.Title,
 * DSAUTO.Persistent.Upkeep.Intro.<keepKey> (dynamic: reroll, extend, both, manual) and the use's `detail` (its note).
 *
 * i18n keys: DSAUTO.Summon.Upkeep.{Title, Intro, Keep, Release, Countdown}, DSAUTO.Relay.{Denied, BadRequest}.
 */
import { loc } from "../constants.mjs";
import { error, log } from "../log.mjs";
import { clock } from "../triggers/prompt.mjs";

const TICK_MS = 250;
const MAX_MS = 130_000;

const dialogs = new Map();   // promptId -> state {dialog, timedOut, cancelled, armed, tick, timer}

const esc = v => {
  const s = String(v ?? "");
  const fn = foundry.utils?.escapeHTML;
  return typeof fn === "function" ? fn(s) : s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
};
const str = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;
const optStr = (v, max) => v == null || (typeof v === "string" && v.length <= max);
const badRequest = () => new Error("DSAUTO.Relay.BadRequest");
const denied = () => new Error("DSAUTO.Relay.Denied");

function stopTimers(state) {
  if (state.tick !== null) clearInterval(state.tick);
  if (state.timer !== null) clock.clearTimeout(state.timer);
  state.tick = null;
  state.timer = null;
}

/** Milestone 7: the same dialog keeps a Persistent area (`kind: "zone"`, ui/zone-prompts.mjs) with its own texts. */
const isZone = request => request?.kind === "zone";
/** Milestone 9: and a Persistent ability use (`kind: "persistent"`, ui/persistent-prompts.mjs): texts per `keepKey`. */
const isUse = request => request?.kind === "persistent";
/** Keep variants of a use's dialog (persistent/registry.mjs PERSISTENT_KEEP_KEYS). */
const KEEP_KEYS = new Set(["reroll", "extend", "both", "manual"]);

function introKey(request) {
  if (isUse(request)) return `DSAUTO.Persistent.Upkeep.Intro.${request.keepKey}`;
  return isZone(request) ? "DSAUTO.Zone.Upkeep.Intro" : "DSAUTO.Summon.Upkeep.Intro";
}

function titleKey(request) {
  if (isUse(request)) return "DSAUTO.Persistent.Upkeep.Title";
  return isZone(request) ? "DSAUTO.Zone.Upkeep.Title" : "DSAUTO.Summon.Upkeep.Title";
}

function content(request) {
  const intro = loc(introKey(request), {
    cost: request.cost, resource: request.resourceName ?? "", current: request.current ?? 0, name: request.summonName ?? "",
  });
  // A use's own reminder (the overlay's note), our words.
  const detail = isUse(request) && request.detail ? `<p class="ds-auto-upkeep-detail">${esc(request.detail)}</p>` : "";
  return `<div class="ds-auto-upkeep">
    <p class="ds-auto-upkeep-intro">${esc(intro)}</p>${detail}
    <div class="ds-auto-upkeep-bar"><div class="ds-auto-upkeep-bar-fill"></div></div>
    <p class="ds-auto-countdown"></p>
  </div>`;
}

/**
 * The dialog itself (owner side only); resolves {outcome}. Closes itself at `deadline` (server ms) as
 * `timedOut`; a cancel from the GM (closeUpkeepDialog) resolves `cancelled`; a second delivery of the same
 * prompt answers `cancelled` at once (the first dialog keeps going).
 */
export async function openUpkeepDialog(request) {
  const id = request?.promptId;
  try {
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (!DialogV2?.wait) return { outcome: "closed" };
    if (dialogs.has(id)) return { outcome: "cancelled" };                  // duplicate delivery
    const total = Math.min(MAX_MS, Math.max(1_000, Number(request.timeoutMs) || 30_000));
    const end = Number.isFinite(request.deadline) ? request.deadline : clock.now() + total;
    const remaining = () => end - clock.now();
    if (remaining() <= 0) return { outcome: "timedOut" };
    const state = { dialog: null, timedOut: false, cancelled: null, armed: false, tick: null, timer: null };
    dialogs.set(id, state);
    // String content goes through cleanHTML: the countdown text and the bar are written here, not in the markup.
    const paint = () => {
      const el = state.dialog?.element;
      if (!el?.querySelector) return;
      const left = Math.max(0, remaining());
      const text = el.querySelector(".ds-auto-countdown");
      if (text) text.textContent = loc("DSAUTO.Summon.Upkeep.Countdown", { seconds: Math.ceil(left / 1000) });
      const fill = el.querySelector(".ds-auto-upkeep-bar-fill");
      if (fill?.style) fill.style.width = `${Math.max(0, Math.min(100, (left / total) * 100)).toFixed(1)}%`;
    };
    let result = null;
    try {
      result = await DialogV2.wait({
        window: { title: loc(titleKey(request), { name: request.summonName ?? "" }), icon: "fa-solid fa-hourglass-half" },
        classes: ["ds-auto-upkeep-dialog"],
        position: { width: 400 },
        content: content(request),
        rejectClose: false,
        buttons: [
          { action: "release", label: "DSAUTO.Summon.Upkeep.Release", icon: "fa-solid fa-xmark", default: true, callback: () => ({ outcome: "release" }) },
          { action: "keep", label: "DSAUTO.Summon.Upkeep.Keep", icon: "fa-solid fa-check", callback: () => ({ outcome: "keep" }) },
        ],
        render: (_event, dialog) => {
          try {
            state.dialog = dialog;
            paint();
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
            error("summons.upkeepDialog.render", err);
          }
        },
        close: () => {
          stopTimers(state);
        },
      });
    } catch (err) {
      error("summons.upkeepDialog", err, { promptId: id });
      result = null;
    } finally {
      stopTimers(state);
      if (dialogs.get(id) === state) dialogs.delete(id);
    }
    let answer;
    if (result?.outcome) answer = { outcome: result.outcome };
    else if (state.cancelled) answer = { outcome: state.cancelled };
    else answer = { outcome: state.timedOut ? "timedOut" : "closed" };
    if (isZone(request)) log("zone.upkeepDialog", { promptId: id, zoneId: request.summonId ?? null, outcome: answer.outcome });
    else if (isUse(request)) log("persistent.upkeepDialog", { promptId: id, messageId: request.summonId ?? null, outcome: answer.outcome });
    else log("summon.upkeepDialog", { promptId: id, summonId: request.summonId ?? null, outcome: answer.outcome });
    return answer;
  } catch (err) {
    error("summons.openUpkeepDialog", err, { promptId: id });
    return { outcome: "closed" };
  }
}

/** Close an open upkeep dialog of ours (GM cancel: turn end, dismissal, GM timeout). True when one was open. */
export function closeUpkeepDialog(promptId, outcome = "cancelled") {
  const state = dialogs.get(promptId);
  if (!state) return false;
  state.cancelled = outcome || "cancelled";
  try {
    state.dialog?.close?.();
  } catch (err) {
    error("summons.upkeepDialog.close", err);
  }
  return true;
}

function validUpkeep(p) {
  if (!p || typeof p !== "object" || !str(p.promptId, 40) || !str(p.summonId, 40)) return false;
  if (!Number.isInteger(p.cost) || p.cost < 1 || p.cost > 10) return false;
  if (!(p.current == null || Number.isFinite(p.current))) return false;
  if (!Number.isFinite(p.timeoutMs) || !Number.isFinite(p.deadline)) return false;
  if (!(p.kind == null || p.kind === "zone" || p.kind === "persistent")) return false;
  if (p.kind === "persistent" && !KEEP_KEYS.has(p.keepKey)) return false;
  return optStr(p.summonName, 300) && optStr(p.summonerName, 300) && optStr(p.resourceName, 100) && optStr(p.detail, 300);
}

/** Prompt type "summonUpkeep" (registered by main.mjs). GM sender only (the router checks too). */
export async function handleSummonUpkeep(payload, { user } = {}) {
  if (!user?.isGM) throw denied();
  if (!validUpkeep(payload)) throw badRequest();
  return openUpkeepDialog(payload);
}

/** Prompt type "summonUpkeepCancel". */
export async function handleSummonUpkeepCancel(payload, { user } = {}) {
  if (!user?.isGM) throw denied();
  if (!str(payload?.promptId, 40)) throw badRequest();
  return { ok: closeUpkeepDialog(payload.promptId, "cancelled") };
}

/** For tests and selfCheck: open upkeep dialogs on this client. */
export const openUpkeepDialogs = () => [...dialogs.keys()];
