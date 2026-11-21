/**
 * 1.2.2: the suite always has priority over Combat Tools. Where the suite already does what a Combat Tools card control
 * does, that control is HIDDEN (`ds-auto-hidden-native`, display:none) on every client, and clicks on it are swallowed
 * in the capture phase (silently: a synthetic click from Combat Tools' own automation gets no toast):
 *
 *   - Combat Tools' whole Hesitation is Weakness card: the `li` of a message flagged `draw-steel-combat-tools.isHiwMessage`
 *     (class-shadow/hesitation.mjs:105), while `suiteRunsHiw()` (triggers/turn-order.mjs) holds;
 *   - Combat Tools' "Apply Judgement" buttons (`.dsct-judgement-btn` with the skull icon, class-censor/judgement.mjs:31-52)
 *     while the suite has the `ability:judgement` overlay. Its other Judgement buttons (impose bane / decline, apply
 *     taunted, spend Wrath) exist only while Combat Tools' `judgementAutomation` is on, which is exactly when the suite's
 *     own Judgement triggers stand down: they stay as the fallback;
 *   - `.dsct-mark-btn` and `.dsct-mark-reminder-btn` (class-tactician/mark.mjs) while it has `ability:mark`.
 * The Apply buttons are hidden only on a card whose Automation box has the suite's judged / marked row (cardHasSuiteRow).
 * Combat Tools' Mark reminder card and its "fallen" Judgement card are about effects Combat Tools made (the suite's
 * trackers leave those alone, triggers/trackers.mjs), so the reminder button is hidden only with a suite row too.
 * Combat Tools builds its buttons in its own render hook (maybe after ours), so a few short passes re-apply the class.
 */
import { DSCT_ID, OP_STATUS } from "../constants.mjs";
import { getResolution } from "../engine/record.mjs";
import { hasOverlay } from "../library/registry.mjs";
import { setting } from "../settings.mjs";
import { suiteRunsHiw } from "../triggers/turn-order.mjs";
import { debug } from "../log.mjs";

const HIDDEN = "ds-auto-hidden-native";
const JUDGEMENT_BTN = ".dsct-judgement-btn";
const MARK_BTN = ".dsct-mark-btn, .dsct-mark-reminder-btn";
const HIDDEN_CONTROL = `${JUDGEMENT_BTN}, ${MARK_BTN}`;
const HIDDEN_HIW = `li.${HIDDEN}[data-message-id]`;

/** The ability's own judged / marked effect (Draw Steel compendium ids, as the overlays use them). */
const OWN_EFFECT = { judgement: "MHQDlicbxXquwduc", mark: "YW2JEdoDPd0XlaII" };

/**
 * This card's Automation box has the suite's row for that effect (a condition op of the effect, not a "not chosen" skip):
 * only then is Combat Tools' Apply button a duplicate. Cards without such a row (an NPC censor the library leaves
 * unautomated, a card the box does not handle) keep Combat Tools' button as the fallback.
 */
export function cardHasSuiteRow(message, dsid) {
  const effectId = OWN_EFFECT[dsid];
  const res = getResolution(message);
  if (!effectId || !res?.ops) return false;
  // Still resolving (a prompt of the card is open, e.g. the Oracle Judgement benefit): the suite's row is coming, so
  // Combat Tools' button would add a second effect meanwhile (seen live). Shown again if the finished card has no row.
  if (!res.resolvedAt && res.abilityDsid === dsid) return true;
  return Object.values(res.ops).some(o => o?.kind === "condition" && o.effectId === effectId
    && !(o.status === OP_STATUS.SKIPPED && o.reason === "notChosen"));
}

/** Combat Tools' "Apply Judgement" button (skull icon), not its bane / taunt / Wrath buttons. */
export const isApplyJudgement = el => (el?.querySelectorAll?.(".fa-skull-crossbones")?.length ?? 0) > 0;

/** The suite automates this ability: the suite and its library are on and the overlay is registered. */
export function suiteAutomates(dsid) {
  try {
    return setting("enabled") !== false && setting("libraryEnabled") !== false && hasOverlay(`ability:${dsid}`);
  } catch (_err) {
    return false;
  }
}

/** Hide (or show again) the Combat Tools duplicates of one rendered card. Idempotent; returns how many are hidden. */
export function hideCtDuplicates(message, root) {
  if (!root?.querySelectorAll || !message) return 0;
  let n = 0;
  if (message.getFlag?.(DSCT_ID, "isHiwMessage")) {
    if (suiteRunsHiw()) {
      root.classList.add(HIDDEN);
      n++;
    } else root.classList.remove(HIDDEN);
  }
  const hide = (selector, on, only = null) => {
    for (const el of root.querySelectorAll(selector)) {
      if (only && !only(el)) continue;
      if (on) {
        el.classList.add(HIDDEN);
        n++;
      } else el.classList.remove(HIDDEN);
    }
  };
  hide(JUDGEMENT_BTN, suiteAutomates("judgement") && cardHasSuiteRow(message, "judgement"), isApplyJudgement);
  hide(MARK_BTN, suiteAutomates("mark") && cardHasSuiteRow(message, "mark"));
  return n;
}

/** Capture listener: swallow a click on a hidden Combat Tools duplicate. Returns true when swallowed. */
export function onCaptureClick(event) {
  const target = event?.target;
  const control = target?.closest?.(HIDDEN_CONTROL);
  const hidden = (control?.classList?.contains(HIDDEN) ? control : null) ?? target?.closest?.(HIDDEN_HIW);
  if (!hidden) return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  debug("ctDuplicates.blocked", { synthetic: !event.isTrusted });
  return true;
}

export function registerCtDuplicates() {
  document.addEventListener("click", onCaptureClick, true);
  Hooks.on("openDetachedWindow", (_id, win) => {
    try {
      win?.document?.addEventListener("click", onCaptureClick, true);
    } catch (_err) { /* cross-origin or closed */ }
  });
  Hooks.on("renderChatMessageHTML", (message, html) => {
    try {
      const root = html instanceof HTMLElement ? html : html?.[0];
      if (!root) return;
      hideCtDuplicates(message, root);
      // Combat Tools adds its buttons in its own hook, possibly after this one.
      for (const ms of [0, 250, 600, 1500]) setTimeout(() => {
        const live = root.isConnected ? root : (document.querySelector(`li.chat-message[data-message-id="${message.id}"]`) ?? root);
        hideCtDuplicates(message, live);
      }, ms);
    } catch (err) {
      debug("ctDuplicates.render", { why: String(err?.message ?? err) });
    }
  });
}
