/**
 * Hero-token regain dialog, owner side (Milestone 7, docs/M7-DESIGN.md §1.8, §3.7, Q5; WP-C). Every client; the
 * active GM opens the same dialog locally for a hero without a non-GM owner (`openHeroTokenDialog`, or the handler
 * called with `{user: game.user}`).
 *
 * Prompt router types (GM senders only; the router checks too, S/relay/prompt-router.mjs):
 *   heroTokenRegain        a DialogV2 "Spend hero tokens?": what the hit leaves the hero at, the party's tokens, the
 *                          Stamina regained and what is left after the hit with the spend, the reminder that only one
 *                          hero token benefit counts per turn (spends through the system's own buttons are not seen,
 *                          §8), and a countdown (text and bar) to the request's server-time `deadline`; the timers
 *                          are armed on the first render only (DialogV2 calls `render` on every render). "Take the
 *                          hit" is the first and default button (an unexpected prompt must never spend by Enter or
 *                          Space, as the trigger and upkeep dialogs); Escape or the close button counts as `closed`.
 *                          Answers {outcome: "spend" | "decline" | "timedOut" | "closed" | "cancelled"}.
 *   heroTokenRegainCancel  closes that dialog (its answer becomes `cancelled`, nobody waits for it any more);
 *                          answers {ok}.
 *
 * i18n keys: DSAUTO.HeroToken.Dialog.{Title, Intro, Spend, Decline, Countdown, OnePerTurn},
 * DSAUTO.Relay.{Denied, BadRequest}.
 */
import { loc } from "../constants.mjs";
import { error, log } from "../log.mjs";
import { clock } from "../triggers/prompt.mjs";

const TICK_MS = 250;
const MAX_MS = 130_000;
const MAX_COST = 10;

const dialogs = new Map();   // promptId -> state {dialog, timedOut, cancelled, armed, tick, timer}

const esc = v => {
  const s = String(v ?? "");
  const fn = globalThis.foundry?.utils?.escapeHTML;
  return typeof fn === "function" ? fn(s) : s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
};
const str = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;
const optStr = (v, max) => v == null || (typeof v === "string" && v.length <= max);
const num = v => typeof v === "number" && Number.isFinite(v);
const optNum = v => v == null || num(v);
const badRequest = () => new Error("DSAUTO.Relay.BadRequest");
const denied = () => new Error("DSAUTO.Relay.Denied");

function stopTimers(state) {
  if (state.tick !== null) clearInterval(state.tick);
  if (state.timer !== null) clock.clearTimeout(state.timer);
  state.tick = null;
  state.timer = null;
}

function content(request) {
  const intro = loc("DSAUTO.HeroToken.Dialog.Intro", {
    name: request.heroName ?? "", after: request.staminaAfter ?? 0, cost: request.cost ?? 2, tokens: request.tokens ?? 0,
    amount: request.amount ?? 0, with: request.staminaWith ?? 0,
  });
  return `<div class="ds-auto-herotoken">
    <p class="ds-auto-herotoken-intro">${esc(intro)}</p>
    <p class="ds-auto-herotoken-note"><i class="fa-solid fa-circle-info" inert></i> ${esc(loc("DSAUTO.HeroToken.Dialog.OnePerTurn"))}</p>
    <div class="ds-auto-herotoken-bar"><div class="ds-auto-herotoken-bar-fill"></div></div>
    <p class="ds-auto-countdown"></p>
  </div>`;
}

/**
 * The dialog itself; resolves {outcome}. Closes itself at `deadline` (server ms) as `timedOut`; a cancel from the
 * GM (closeHeroTokenDialog) resolves `cancelled`; a second delivery of the same prompt answers `cancelled` at once
 * (the first dialog keeps going). Never throws.
 */
export async function openHeroTokenDialog(request) {
  const id = request?.promptId;
  try {
    const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
    if (!DialogV2?.wait) return { outcome: "closed" };
    if (dialogs.has(id)) return { outcome: "cancelled" };                  // duplicate delivery
    const total = Math.min(MAX_MS, Math.max(1_000, Number(request.timeoutMs) || 20_000));
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
      if (text) text.textContent = loc("DSAUTO.HeroToken.Dialog.Countdown", { seconds: Math.ceil(left / 1000) });
      const fill = el.querySelector(".ds-auto-herotoken-bar-fill");
      if (fill?.style) fill.style.width = `${Math.max(0, Math.min(100, (left / total) * 100)).toFixed(1)}%`;
    };
    const cost = Number.isInteger(request.cost) ? request.cost : 2;
    let result = null;
    try {
      result = await DialogV2.wait({
        window: { title: "DSAUTO.HeroToken.Dialog.Title", icon: "fa-solid fa-hand-holding-heart" },
        classes: ["ds-auto-herotoken-dialog"],
        position: { width: 420 },
        content: content(request),
        rejectClose: false,
        buttons: [
          { action: "decline", label: "DSAUTO.HeroToken.Dialog.Decline", icon: "fa-solid fa-shield-halved", default: true, callback: () => ({ outcome: "decline" }) },
          { action: "spend", label: loc("DSAUTO.HeroToken.Dialog.Spend", { cost }), icon: "fa-solid fa-heart-pulse", callback: () => ({ outcome: "spend" }) },
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
            error("heroTokens.dialog.render", err);
          }
        },
        close: () => {
          stopTimers(state);
        },
      });
    } catch (err) {
      error("heroTokens.dialog", err, { promptId: id });
      result = null;
    } finally {
      stopTimers(state);
      if (dialogs.get(id) === state) dialogs.delete(id);
    }
    let answer;
    // A cancel that arrived while the button callback ran still wins: the GM no longer waits for this answer.
    if (state.cancelled) answer = { outcome: state.cancelled };
    else if (result?.outcome === "spend" || result?.outcome === "decline") answer = { outcome: result.outcome };
    else answer = { outcome: state.timedOut ? "timedOut" : "closed" };
    log("heroToken.dialog", { promptId: id, hero: request.heroName ?? null, outcome: answer.outcome });
    return answer;
  } catch (err) {
    error("heroTokens.openDialog", err, { promptId: id });
    return { outcome: "closed" };
  }
}

/** Close an open hero-token dialog (GM cancel: deadline, card gone, recipient left). True when one was open. */
export function closeHeroTokenDialog(promptId, outcome = "cancelled") {
  const state = dialogs.get(promptId);
  if (!state) return false;
  state.cancelled = outcome || "cancelled";
  try {
    state.dialog?.close?.();
  } catch (err) {
    error("heroTokens.dialog.close", err);
  }
  return true;
}

/** Shape of a heroTokenRegain request (§1.8). */
export function validHeroTokenRequest(p) {
  if (!p || typeof p !== "object" || !str(p.promptId, 40)) return false;
  if (!Number.isInteger(p.cost) || p.cost < 1 || p.cost > MAX_COST) return false;
  if (!num(p.timeoutMs) || !num(p.deadline)) return false;
  for (const k of ["tokens", "amount", "staminaNow", "staminaAfter", "staminaWith"]) if (!optNum(p[k])) return false;
  return optStr(p.heroName, 300) && optStr(p.heroUuid, 300);
}

/** Prompt type "heroTokenRegain" (registered by main.mjs). GM sender only (the router checks too). */
export async function handleHeroTokenRegain(payload, { user } = {}) {
  if (!user?.isGM) throw denied();
  if (!validHeroTokenRequest(payload)) throw badRequest();
  return openHeroTokenDialog(payload);
}

/** Prompt type "heroTokenRegainCancel". */
export async function handleHeroTokenRegainCancel(payload, { user } = {}) {
  if (!user?.isGM) throw denied();
  if (!str(payload?.promptId, 40)) throw badRequest();
  return { ok: closeHeroTokenDialog(payload.promptId, "cancelled") };
}

/** For tests and selfCheck: open hero-token dialogs on this client. */
export const openHeroTokenDialogs = () => [...dialogs.keys()];
