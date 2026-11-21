/**
 * Draw Steel 1.2 draws a native "Persistent (X)" special-effect button on ability cards (`button[data-action="persistent"]`
 * in the abilityUse part's footer); its handler adds an effect that subtracts X from the hero's essence gain until combat
 * ends. The suite already handles Persistent itself: at every turn start it asks whether to keep the ability and charges X
 * essence for each kept turn (the card record's `persistent = { cost, keep, ... }`). Both together would charge twice, so
 * on every card the Automation box handles and that carries a persistent cost:
 * 1. Hidden: the native button gets the class `ds-auto-hidden-native` (display none), so the card shows the persistent
 *    line of the Automation box only once. DS draws it inside `footer.message-part-buttons` (ability-use.hbs), next to the
 *    other ability buttons: the footer is hidden too only when every button in it is hidden (no empty row).
 * 2. Capture click guard (every client, document level), a backstop for the hidden button: a click on it is swallowed, a synthetic `.click()` as well.
 *    Only a trusted (real user) click toasts the warning.
 * Cards without our record, without a persistent cost, while the suite is disabled or with the turn-start ask off
 * (setting persistentUpkeep) keep the native button untouched.
 *
 * i18n keys: DSAUTO.Lock.PersistentTurnStart.
 */
import { loc } from "../constants.mjs";
import { getResolution } from "../engine/record.mjs";
import { error } from "../log.mjs";
import { cardHandled } from "./family-apply-guard.mjs";
import { setting } from "../settings.mjs";

export const PERSISTENT_BUTTON = '[data-action="persistent"]';
/** Hide class (styles/ds-auto-suite.css) and DS's button footer (templates/sidebar/chat/parts/ability-use.hbs). */
const HIDDEN = "ds-auto-hidden-native";
const FOOTER_CLASS = "message-part-buttons";
const KEY = "DSAUTO.Lock.PersistentTurnStart";

/** Does the box charge persistent cost on this card itself (so the native button must stay hidden)? */
function persistentHandled(message) {
  // With the turn-start ask off (setting persistentUpkeep) the suite keeps nothing, so the native button stays usable.
  return !!message && setting("persistentUpkeep") !== false && cardHandled(message) && Number(getResolution(message)?.persistent?.cost) > 0;
}

/**
 * Hide the native Persistent buttons of a handled card with a persistent cost (and their footer when nothing else is
 * left in it). Pure on the record and the DOM.
 * @returns {number} How many buttons were hidden.
 */
export function decoratePersistent(message, root) {
  if (!root?.querySelectorAll || !persistentHandled(message)) return 0;
  let n = 0;
  for (const el of root.querySelectorAll(PERSISTENT_BUTTON)) {
    el.classList.add(HIDDEN);
    n++;
    const footer = el.parentElement ?? el.parent;
    if (footer?.classList?.contains(FOOTER_CLASS) && [...footer.querySelectorAll("button")].every(b => b.classList.contains(HIDDEN))) footer.classList.add(HIDDEN);
  }
  return n;
}

/** Capture listener: swallow a click on the native Persistent button of a handled card. */
export function onCaptureClick(event) {
  try {
    const el = event.target?.closest?.(PERSISTENT_BUTTON);
    if (!el) return;
    const li = el.closest("[data-message-id]");
    const message = li ? game.messages.get(li.dataset.messageId) : null;
    if (!persistentHandled(message)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.isTrusted) ui.notifications?.warn?.(loc(KEY));
  } catch (err) {
    error("persistentLock.click", err);
  }
}

/** init: the capture guard on every client and the decoration after each chat message render. */
export function registerPersistentButtonLock() {
  if (typeof globalThis.document?.addEventListener !== "function" || typeof globalThis.Hooks?.on !== "function") return;
  document.addEventListener("click", onCaptureClick, true);
  Hooks.on("openDetachedWindow", (_id, win) => {
    try {
      win?.document?.addEventListener("click", onCaptureClick, true);
    } catch (_err) { /* cross-origin or closed */ }
  });
  Hooks.on("renderChatMessageHTML", (message, html) => {
    const root = globalThis.HTMLElement && html instanceof HTMLElement ? html : html?.[0] ?? html;
    if (!root) return;
    // The record may land a moment after the first render: look again.
    for (const ms of [0, 250, 700]) {
      setTimeout(() => {
        try {
          const live = root.isConnected ? root : (document.querySelector(`li.chat-message[data-message-id="${message.id}"]`) ?? root);
          decoratePersistent(message, live);
        } catch (err) {
          error("persistentLock.render", err, { messageId: message?.id ?? null });
        }
      }, ms);
    }
  });
}
