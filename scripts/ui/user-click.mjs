/**
 * Tracks the time of the last TRUSTED user click (`event.isTrusted === true`: a real pointer press, never a script's
 * `el.click()`). Combat Tools' client setting `autoApplyOwnAbilities` runs its Apply All ~600 ms after each card renders
 * with synthetic `btn.click()`s. The click guards (ui/family-apply-guard.mjs, ui/dstd-lock.mjs) and the apply veto
 * (compat/target-result-veto.mjs) still block those, but must not toast on them: only a click the user made may warn.
 * The veto is a hook with no event, so it asks `userClickedRecently(ms, messageId)` instead of looking at `isTrusted`:
 * the real click must also have landed on that card (the user's own click on the roll dialog's Roll button comes
 * ~600 ms before Combat Tools' synthetic Apply All, so time alone is not enough).
 */

let lastUserClick = 0;
let lastMessageId = null;
let installed = false;

/** Record the click when it is a real user click. Used by the document listeners; exported for the harnesses. */
export function noteUserClick(event) {
  if (event?.isTrusted !== true) return;
  lastUserClick = Date.now();
  lastMessageId = event.target?.closest?.("[data-message-id]")?.dataset?.messageId ?? null;
}

/** Test hook: set (or reset with 0) the last user click timestamp. */
export function setLastUserClick(ts = 0, messageId = null) {
  lastUserClick = ts;
  lastMessageId = messageId;
}

/** Did the user click for real within the last `ms` milliseconds (and, with `messageId`, on that chat card)? */
export function userClickedRecently(ms = 1000, messageId = null) {
  if (!(lastUserClick > 0 && Date.now() - lastUserClick < ms)) return false;
  return !messageId || lastMessageId === messageId;
}

function attach(doc) {
  doc?.addEventListener?.("pointerdown", noteUserClick, true);
  doc?.addEventListener?.("click", noteUserClick, true);
}

/** init: the capture listeners on the main document and on detached windows (idempotent). */
export function registerUserClickTracker() {
  if (installed) return;
  if (typeof globalThis.document?.addEventListener !== "function") return;
  installed = true;
  attach(document);
  if (typeof globalThis.Hooks?.on !== "function") return;
  Hooks.on("openDetachedWindow", (_id, win) => {
    try {
      attach(win?.document);
    } catch (_err) { /* cross-origin or closed */ }
  });
}
