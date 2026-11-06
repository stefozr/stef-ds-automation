/**
 * 0.13.0: the Automation section is the card's apply / undo surface, so Draw Steel: Target Damage's panel is folded
 * behind a "Details" toggle on cards our part resolved (client setting `foldDetails`). The panel is never removed:
 * Combat Tools' rows (forced movement, teleport, conditions, roll pills) and "Update Targets" live in it and stay
 * one click away, still locked by ui/dstd-lock.mjs when we already applied a row.
 *
 * Mechanism: a class on the message `li` and one CSS rule (styles/ds-auto-compact.css). Target Damage rebuilds its
 * panel in place on the same `li` after every render and flag write, so the class keeps hiding it without timers;
 * a core re-render makes a new `li` and our render hook sets the class again. A ctlib panel decorator (after our
 * lock, priority 300) refreshes the toggle's badge after each rebuild. Open cards are remembered per message for
 * the session (per client).
 */
import { CTLIB_ID, loc } from "../constants.mjs";
import { dstdActive, dstdOnCard, dstdState } from "../compat/dstd.mjs";
import { ctlib } from "../compat/ctlib.mjs";
import { debug } from "../log.mjs";
import { setting } from "../settings.mjs";
import { getResolution } from "../engine/record.mjs";

export const FOLD_CLASS = "ds-auto-fold-dstd";
const PANEL = "section.draw-steel-target-damage-panel";
const TOGGLE = '[data-action="dsAutoDetails"]';
/** Live action buttons Target Damage and Combat Tools offer inside the panel (the toggle's badge). */
const LIVE_BUTTONS = [
  "button[data-dstd-action]",
  "[data-dsct-fm-key] > button:first-of-type",
  "[data-dsct-flat-tp-key] button", "[data-dsct-flat-cond-key] button", "[data-dsct-flat-heal-key] button",
  "[data-dsct-flat-res-key] button", "[data-dsct-flat-cleanse-key] button", "[data-dsct-dstd-cond] button",
  "button[data-dsct-action]",
].join(", ");
/** Panel chrome that is not a result to apply: Target Damage's own controls, editors (roll pills) and Death Tracker's buttons. */
const NOT_COUNTED = '[data-dstd-action="updateTargets"], [data-dstd-action="toggleTarget"], [data-dstd-action="editRoll"], [data-dstd-action="editDamage"], [data-dstd-action^="undo"], .dsct-dt-settle, .dsct-dt-release, .dsct-source-pill';
const EDITOR_ROWS = ".dsct-roll-pills-row, .dsct-dmg-pills-row, [data-dsct-pills]";

const openByMessage = new Set();
const windows = new Set();

/** Pure: fold when our part resolved the card, Target Damage is active and keeps state on the card (= renders a panel). */
export function shouldFoldPanel(res, { dstd = false, state = null } = {}) {
  return !!res?.resolvedAt && !!dstd && !!state;
}

export const isOpen = id => openByMessage.has(id);

/**
 * Number of live, not locked results in a panel (informational). Target Damage's quick button in a row's head and the
 * full button in its body share an operation id and count once.
 */
export function badgeCount(panel) {
  if (!panel?.querySelectorAll) return 0;
  const seen = new Set();
  for (const b of panel.querySelectorAll(LIVE_BUTTONS)) {
    if (b.disabled || b.classList?.contains("ds-auto-locked") || b.matches?.(NOT_COUNTED) || b.closest?.(EDITOR_ROWS)) continue;
    seen.add(b.dataset?.operationId ? `op:${b.dataset.operationId}` : b);
  }
  return seen.size;
}

/** Whether this message's Target Damage panel folds for this client (setting, record, Target Damage state). */
export function wantsFold(message) {
  if (setting("foldDetails") === false) return false;
  return shouldFoldPanel(getResolution(message), { dstd: dstdOnCard(message), state: dstdState(message) });
}

/** Idempotent: class on the li, the toggle's state and badge. Runs any number of times, before or after the panel exists. */
export function applyFold(message, li, panel = li?.querySelector?.(PANEL) ?? null) {
  if (!message || !li?.classList) return false;
  const want = wantsFold(message) && !!li.querySelector?.(".ds-auto-resolution");
  const folded = want && !isOpen(message.id);
  li.classList.toggle(FOLD_CLASS, folded);
  const btn = li.querySelector?.(TOGGLE);
  if (btn) {
    btn.setAttribute("aria-expanded", String(!folded));
    btn.dataset.tooltip = loc(folded ? "DSAUTO.Card.DetailsShow" : "DSAUTO.Card.DetailsHide");
    const badge = btn.querySelector?.(".ds-auto-details-badge");
    if (badge) {
      const n = badgeCount(panel);
      badge.textContent = n ? String(n) : "";
    }
  }
  return folded;
}

function liveItems(messageId) {
  const docs = [globalThis.document, ...windows].filter(Boolean);
  return docs.flatMap(doc => [...(doc.querySelectorAll?.(`li.chat-message[data-message-id="${messageId}"]`) ?? [])]);
}

/** Open or close one card's details on every rendered copy (log, notifications, popouts, detached windows). */
export function toggleFold(messageId) {
  if (!messageId) return;
  if (openByMessage.has(messageId)) openByMessage.delete(messageId);
  else openByMessage.add(messageId);
  const message = game.messages?.get?.(messageId);
  for (const li of liveItems(messageId)) applyFold(message, li);
}

const rootOf = html => (html instanceof HTMLElement ? html : html?.[0]);

export function registerDstdFold() {
  Hooks.on("renderChatMessageHTML", (message, html) => {
    const li = rootOf(html);
    if (!li || !getResolution(message)) return;
    applyFold(message, li);
  });
  Hooks.on("openDetachedWindow", (_id, win) => { if (win?.document) windows.add(win.document); });
  Hooks.on("closeDetachedWindow", (_id, win) => { if (win?.document) windows.delete(win.document); });

  Hooks.once("ready", () => {
    if (!dstdActive()) return;
    const lib = ctlib();
    if (typeof lib?.registerPanelDecorator === "function") {
      lib.registerPanelDecorator({
        id: "stef-ds-automation-fold",
        priority: 310,
        retry: [0, 250, 600],
        onMutation: true,
        decorate: ({ message, root, panel }) => { if (getResolution(message)) applyFold(message, root, panel); },
      });
      debug("fold.decorator", { via: CTLIB_ID });
      return;
    }
    // Without ctlib: refresh the badge after Target Damage has had a chance to build its panel.
    Hooks.on("renderChatMessageHTML", (message, html) => {
      const li = rootOf(html);
      if (!li || !getResolution(message)) return;
      const live = () => (li.isConnected ? li : document.querySelector(`li.chat-message[data-message-id="${message.id}"]`) ?? li);
      setTimeout(() => applyFold(message, live()), 0);
      setTimeout(() => applyFold(message, live()), 250);
    });
  });
}
