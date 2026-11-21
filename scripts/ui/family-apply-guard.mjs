/**
 * 2.2.1.1: Combat Tools draws its own "Apply All / Undo All" row on Draw Steel 1.2 ability cards (`footer.dsct-apply-all-row`
 * > `span.ctlib-split.dsct-apply-all`, and on minion squads `span.ctlib-split.dsct-squad12-btn` in a `details.dsct-squad12`),
 * and its Apply All clicks every per-target button (`btn.click()`), among them Combat Tools' own forced movement rows,
 * grab, frightened / taunted / purifying fire, flat and teleport-ability buttons, which never pass the system's
 * `ds.preApplyTargetResult` hook (compat/target-result-veto.mjs). Its client setting `autoApplyOwnAbilities` even runs
 * Apply All ~600 ms after the card renders. The Automation box is THE apply / undo surface of a card, so on every
 * card the box handles:
 * 1. Visual lock: Combat Tools' apply-all controls (and the old ctlib `[data-ctlib-apply-all]` button, ui/part-lock.mjs)
 *    are disabled with a tooltip, and their row gets `ds-auto-locked` so a CSS layer (stef-ds-qol) can hide it. Combat Tools'
 *    per-target buttons whose row the box owns are disabled too (its verdictOf counts a disabled button as done).
 * 2. Capture click guard (every client, document level): a click on those controls, or on a per-target button of a part
 *    the card is still resolving / the box owns a covering row of, is swallowed. A synthetic `.click()` goes through the
 *    capture phase too, so Combat Tools' Apply All and `autoApplyOwnAbilities` cannot apply twice (or race a pending op).
 *    Undone, skipped and external rows stay clickable (a manual apply after an undo is intended). Only a trusted (real
 *    user) click toasts the warning; Combat Tools' synthetic auto-apply clicks are swallowed silently (ui/user-click.mjs).
 *
 * "Handled by the box" (`cardHandled`): the suite is enabled, the card has our record, and the record is still resolving
 * (`isResolving`) or holds at least one op of any status.
 *
 * i18n keys: DSAUTO.Lock.BoxOwnsCard, DSAUTO.Lock.PartOwned, DSAUTO.Lock.Resolving.
 */
import { loc } from "../constants.mjs";
import { getResolution } from "../engine/record.mjs";
import { isResolving } from "../compat/target-result-veto.mjs";
import { error } from "../log.mjs";
import { setting } from "../settings.mjs";
import { lock, ownedOps } from "./part-lock.mjs";
import { registerUserClickTracker } from "./user-click.mjs";

/** Combat Tools' apply-all controls (card footer row and minion squad header). */
export const APPLY_ALL_CONTROLS = ".dsct-apply-all-go, .dsct-apply-all-undo, .dsct-squad12-btn-go, .dsct-squad12-btn-undo";
/** Anything a click on a per-target Combat Tools button may land on (classified by `ctButtonKind`). */
const CT_CANDIDATES = "button, .dsct-fm-go, .dsct-grab-btn, .dsct-tp-ability-btn, [data-dsct-action]";
const FLAT_RE = /\bdsct-flat-(damage|forced|applied|heal|cleanse|teleport|resource)-btn\b/;
const ACTION_KINDS = { "dsct-frightened": "frightened", "dsct-taunted": "taunted", "dsct-purifying-fire": "purifying" };
/** The condition effect id each condition-style button applies. */
const CONDITION_ID = { grab: "grabbed", frightened: "frightened", taunted: "taunted" };

const has = (el, c) => !!el?.classList?.contains?.(c);

/** Is this element one of Combat Tools' apply-all / undo-all controls? */
export const isApplyAllControl = el => has(el, "dsct-apply-all-go") || has(el, "dsct-apply-all-undo")
  || has(el, "dsct-squad12-btn-go") || has(el, "dsct-squad12-btn-undo");

/**
 * Which per-target Combat Tools button is this? "forced" | "grab" | "frightened" | "taunted" | "purifying" | "flat" | "tp",
 * or null for anything else (system buttons are the veto's business).
 */
export function ctButtonKind(el) {
  if (!el) return null;
  if (has(el, "dsct-fm-go") && el.closest?.(".dsct-fm-roll")) return "forced";
  if (has(el, "dsct-grab-btn")) return "grab";
  if (has(el, "dsct-tp-ability-btn")) return "tp";
  const byAction = ACTION_KINDS[el.dataset?.dsctAction ?? ""];
  if (byAction) return byAction;
  if (FLAT_RE.test(String(el.className ?? ""))) return "flat";
  return null;
}

/** Does the box handle this card (see the file header)? */
export function cardHandled(message) {
  try {
    const res = getResolution(message);
    if (!res || setting("enabled") === false) return false;
    return isResolving(message) || Object.keys(res.ops ?? {}).length > 0;
  } catch (err) {
    error("familyGuard.handled", err, { messageId: message?.id ?? null });
    return false;
  }
}

const opOnPart = (op, partId) => op?.partId === partId || (Array.isArray(op?.parts) && op.parts.some(p => p?.partId === partId));

/**
 * Does the box own a row of part `partId` that a Combat Tools button of this kind would repeat? Owned = applied or pending
 * (`ownedOps`); undone, skipped and external rows are not. forced: a "forced" op; grab / frightened / taunted: a
 * "condition" op with effect grabbed / frightened / taunted; purifying / flat / tp: any owned op of the part.
 */
export function ctButtonOwned(message, partId, kind) {
  const ops = ownedOps(message).filter(o => opOnPart(o, partId));
  if (kind === "forced") return ops.some(o => o.kind === "forced");
  if (CONDITION_ID[kind]) return ops.some(o => o.kind === "condition" && o.effectId === CONDITION_ID[kind]);
  return ops.length > 0;
}

/** The card part a button sits in: a targetResult part, or the abilityUse part (card-level flat / teleport buttons). */
const guardedPartOf = (message, el) => {
  const partId = el?.closest?.("[data-message-part]")?.dataset?.messagePart ?? null;
  const type = partId ? message?.system?.parts?.get?.(partId)?.type : null;
  return type === "targetResult" || type === "abilityUse" ? { partId, type } : null;
};

/**
 * The lock tooltip key for a Combat Tools button of a card (null: free). `resolving` blocks every such button of a
 * targetResult or abilityUse part; otherwise only the owned rows.
 */
export function ctButtonLock(message, el) {
  const kind = ctButtonKind(el);
  const part = kind ? guardedPartOf(message, el) : null;
  if (!part) return null;
  if (isResolving(message)) return "DSAUTO.Lock.Resolving";
  // Card-level buttons (abilityUse part, which Combat Tools' Apply All clicks after the targets): owned when the box
  // owns a row of that part or a row with no part (a card-wide op).
  if (part.type === "abilityUse") {
    return ownedOps(message).some(o => !o?.partId || opOnPart(o, part.partId)) ? "DSAUTO.Lock.PartOwned" : null;
  }
  return ctButtonOwned(message, part.partId, kind) ? "DSAUTO.Lock.PartOwned" : null;
}

/**
 * The guard's decision for a clicked element on a card: `{ key }` (the tooltip / warning key) to swallow the click, or null.
 * @param {object} message
 * @param {Element} el   The clicked control (the nearest button).
 */
export function guardDecision(message, el) {
  if (!message || !el || !cardHandled(message)) return null;
  if (isApplyAllControl(el)) return { key: "DSAUTO.Lock.BoxOwnsCard" };
  const key = ctButtonLock(message, el);
  return key ? { key } : null;
}

/**
 * Disable Combat Tools' apply-all controls and the per-target buttons whose row the box owns (or all of them while the card
 * is resolving). Pure on the record and the DOM.
 * @returns {number} How many controls were disabled.
 */
export function decorateFamily(message, root) {
  if (!root?.querySelectorAll || !cardHandled(message)) return 0;
  let n = 0;
  for (const el of root.querySelectorAll(APPLY_ALL_CONTROLS)) {
    lock(el, "DSAUTO.Lock.BoxOwnsCard");
    for (const row of [el.closest?.(".dsct-apply-all-row"), el.closest?.(".ctlib-split")]) row?.classList?.add?.("ds-auto-locked");
    n++;
  }
  for (const el of root.querySelectorAll(CT_CANDIDATES)) {
    if (isApplyAllControl(el)) continue;
    const key = ctButtonLock(message, el);
    if (!key) continue;
    lock(el, key);
    n++;
  }
  return n;
}

const warned = new Map();
/** Warn once per message and text within a second: Combat Tools' Apply All clicks many buttons in a row. */
function warnOnce(messageId, key) {
  const now = Date.now();
  const id = `${messageId}|${key}`;
  if (now - (warned.get(id) ?? 0) < 1000) return;
  warned.set(id, now);
  ui.notifications?.warn?.(loc(key));
}

/** Capture listener: swallow a click the decision blocks. */
export function onCaptureClick(event) {
  try {
    const el = event.target?.closest?.(`${APPLY_ALL_CONTROLS}, ${CT_CANDIDATES}`);
    if (!el) return;
    const li = el.closest("[data-message-id]");
    const message = li ? game.messages.get(li.dataset.messageId) : null;
    const decision = guardDecision(message, el);
    if (!decision) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.isTrusted) warnOnce(message.id, decision.key);
  } catch (err) {
    error("familyGuard.click", err);
  }
}

/** init: the capture guard on every client and the decoration after Combat Tools built its row. */
export function registerFamilyApplyGuard() {
  if (typeof globalThis.document?.addEventListener !== "function" || typeof globalThis.Hooks?.on !== "function") return;
  registerUserClickTracker();
  document.addEventListener("click", onCaptureClick, true);
  Hooks.on("openDetachedWindow", (_id, win) => {
    try {
      win?.document?.addEventListener("click", onCaptureClick, true);
    } catch (_err) { /* cross-origin or closed */ }
  });
  Hooks.on("renderChatMessageHTML", (message, html) => {
    const root = globalThis.HTMLElement && html instanceof HTMLElement ? html : html?.[0] ?? html;
    if (!root) return;
    // Combat Tools adds its row in its own render hook (registered at ready, after ours): look again once it ran.
    for (const ms of [0, 250, 700]) {
      setTimeout(() => {
        try {
          const live = root.isConnected ? root : (document.querySelector(`li.chat-message[data-message-id="${message.id}"]`) ?? root);
          decorateFamily(message, live);
        } catch (err) {
          error("familyGuard.render", err, { messageId: message?.id ?? null });
        }
      }, ms);
    }
    watchCard(message.id, root);
  });
}

const watched = new WeakSet();
/**
 * Other modules rebuild parts of a rendered card later without a new render hook (Battle Log's target panel, slow clients
 * where the parts arrive after the 700 ms look): decorate again whenever the card's content changes. lock() only touches
 * attributes, so the observer (childList only) does not wake itself.
 */
function watchCard(messageId, root) {
  if (typeof globalThis.MutationObserver !== "function" || !root?.nodeType || watched.has(root)) return;
  watched.add(root);
  let timer = null, shown = false;
  const observer = new MutationObserver(() => {
    // The hook runs before the card is in the chat log: stop only once a shown card was replaced (re-render).
    if (root.isConnected) shown = true;
    else if (shown) { observer.disconnect(); return; }
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const message = game.messages?.get?.(messageId);
        if (message) decorateFamily(message, root);
      } catch (err) {
        error("familyGuard.watch", err, { messageId });
      }
    }, 50);
  });
  observer.observe(root, { childList: true, subtree: true });
}
