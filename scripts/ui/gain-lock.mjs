/**
 * Lock of the system's "Gain N surges" buttons (Milestone 7, docs/M7-DESIGN.md §3.6; WP-C). Every client.
 *
 * The system's `resource` power-roll effects (Battle Cry, Orison of Victory) render a `gainResource` button per tier
 * (`data-action="gainResource"`, `data-uuid` = the PowerRollEffect's uuid, DSM:21170-21185) that gives the gain to
 * the SELECTED heroes (DSM:21197-21219). Our engine turns the same effect into native `resource` rows (§3.6); once
 * one of them is applied for that effect (`op.native && op.preId`), pressing the system's button would pay the gain
 * twice. On every render of a card whose record has such an applied row, the matching buttons are disabled with
 * the tooltip DSAUTO.Lock.GainApplied (a disabled button receives no click, so the system's action never runs).
 * Target Damage usually hides these buttons anyway (RES:578). A row undone again unlocks the button on the next
 * render (the record write re-renders the card).
 * Milestone 8: on a Draw Steel 1.2 card the buttons inside a `targetResult` part belong to that part's target only;
 * they are left to ui/part-lock.mjs (per part), so one target's applied row never locks another target's button.
 *
 * i18n keys: DSAUTO.Lock.GainApplied.
 */
import { OP_STATUS, loc } from "../constants.mjs";
import { getResolution } from "../engine/record.mjs";
import { error } from "../log.mjs";

const BUTTONS = '[data-action="gainResource"]';
const APPLIED = OP_STATUS.APPLIED;

/** preIds of the card's applied native resource rows (empty when none). Pure on the record. */
export function appliedResourcePres(res) {
  const out = new Set();
  for (const op of Object.values(res?.ops ?? {})) {
    if (op?.kind === "resource" && op.native && typeof op.preId === "string" && op.preId && op.status === APPLIED) out.add(op.preId);
  }
  return out;
}

/** Does a gainResource button's PRE uuid name one of these effect ids? */
const lockedBy = (uuid, pres) => {
  const u = String(uuid ?? "");
  if (!u) return false;
  for (const id of pres) if (u === id || u.endsWith(`.${id}`)) return true;
  return false;
};

/** Disable the locked gainResource buttons inside a rendered card. Returns how many were disabled. */
export function decorateGainButtons(message, root) {
  if (!root?.querySelectorAll) return 0;
  const res = getResolution(message);
  if (!res?.ops) return 0;
  const pres = appliedResourcePres(res);
  if (!pres.size) return 0;
  // Buttons of 1.2 targetResult parts: per-part locks (ui/part-lock.mjs), not card-wide.
  const perPart = new Set();
  for (const section of root.querySelectorAll("[data-message-part]")) {
    const partId = section.dataset?.messagePart ?? null;
    if (!partId || message?.system?.parts?.get?.(partId)?.type !== "targetResult") continue;
    for (const button of section.querySelectorAll(BUTTONS)) perPart.add(button);
  }
  let n = 0;
  for (const button of root.querySelectorAll(BUTTONS)) {
    if (perPart.has(button) || !lockedBy(button.dataset?.uuid, pres)) continue;
    button.disabled = true;
    button.classList?.add?.("ds-auto-locked");
    if (button.dataset) button.dataset.tooltip = loc("DSAUTO.Lock.GainApplied");
    n++;
  }
  return n;
}

/** init: renderChatMessageHTML -> disable the system's gain buttons whose effect has an applied native resource row. */
export function registerGainLock() {
  if (typeof globalThis.Hooks?.on !== "function") return;
  Hooks.on("renderChatMessageHTML", (message, html) => {
    try {
      const root = globalThis.HTMLElement && html instanceof HTMLElement ? html : html?.[0] ?? html;
      if (!root) return;
      decorateGainButtons(message, root);
    } catch (err) {
      error("gainLock.render", err, { messageId: message?.id ?? null });
    }
  });
}
