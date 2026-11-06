/**
 * Per-part locks of the system's buttons on Draw Steel 1.2 cards (Milestone 8, docs/M8-DESIGN.md §1.8, D7). Every client.
 *
 * A 1.2 card has one `targetResult` part per target, each rendering its own one-click buttons for that target
 * (`TargetResultPart` ACTIONS: `applyDamage` with `data-index` = the roll index, `applyEffect` with `data-effect-id`
 * and `data-uuid` = the PowerRollEffect uuid, `gainResource` with `data-uuid`; R/data/pseudo-documents/message-parts/
 * target-result.mjs:27-32, 149-187). Once our row for that part applied, pressing the system's button would apply
 * twice. On every render of a card with a record, inside each `[data-message-part="<partId>"]` section of a
 * targetResult part, the matching buttons are disabled with the tooltip DSAUTO.Lock.PartApplied:
 * - `applyDamage[data-index=i]`: an applied damage / heal / temp op of that part and roll index, or a squad op that
 *   lists `{partId, rollIndex: i}` among its `parts` (squad damage collapses across target parts, §1.4);
 * - `applyEffect[data-effect-id=e]` whose `data-uuid` ends with `.<preId>`: an applied condition op of that part,
 *   effect and PRE;
 * - `gainResource` whose `data-uuid` ends with `.<preId>`: an applied native resource op of that part and PRE.
 * Undone rows unlock on the next render (the record write re-renders the card). The 1.1.2 card-wide resource lock
 * stays in ui/gain-lock.mjs.
 *
 * 1.2.0: rows still PENDING in the Automation box are locked too (tooltip DSAUTO.Lock.PartOwned), consistent with the
 * veto of `ds.preApplyTargetResult` (compat/target-result-veto.mjs, which shares `opCoversButton` / `ownedOps`), and
 * ctlib's "Apply All Damage" button is disabled when every damage part of the card is owned by our ops.
 *
 * i18n keys: DSAUTO.Lock.PartApplied, DSAUTO.Lock.PartOwned.
 */
import { OP_STATUS, loc } from "../constants.mjs";
import { getResolution } from "../engine/record.mjs";
import { integrity } from "../engine/ledger.mjs";
import { error } from "../log.mjs";
import { setting } from "../settings.mjs";

const DAMAGE_KINDS = new Set(["damage", "heal", "temp"]);

/** Does a button's PRE uuid name this effect id? */
const preOf = (uuid, preId) => {
  const u = String(uuid ?? "");
  return !!u && !!preId && (u === preId || u.endsWith(`.${preId}`));
};

/**
 * Does one op cover a system button of a targetResult part? (Shared by the visual lock and the veto, so both agree.)
 * @param {object} op
 * @param {string} partId
 * @param {"applyDamage"|"applyEffect"|"gainResource"} action
 * @param {object} [what]
 * @param {number|null} [what.index]       Damage roll index (null: any roll of the part, e.g. a relayed click).
 * @param {string|null} [what.effectId]    Effect id of an applyEffect button (null: any).
 * @param {string|null} [what.uuid]        PRE uuid of an applyEffect / gainResource button (null: any).
 */
export function opCoversButton(op, partId, action, { index = null, effectId = null, uuid = null } = {}) {
  if (!op || !partId) return false;
  if (action === "applyDamage") {
    if (!DAMAGE_KINDS.has(op.kind)) return false;
    const slots = [{ partId: op.partId, rollIndex: op.rollIndex }, ...(Array.isArray(op.parts) ? op.parts : [])];
    return slots.some(s => s?.partId === partId && (index == null || Number(s.rollIndex) === Number(index)));
  }
  if (action === "applyEffect") {
    return op.kind === "condition" && !op.lib && op.partId === partId && (effectId == null || op.effectId === effectId)
      && (uuid == null || preOf(uuid, op.preId));
  }
  if (action === "gainResource") return op.kind === "resource" && !!op.native && op.partId === partId && (uuid == null || preOf(uuid, op.preId));
  return false;
}

/**
 * The ops that own their rows on a card: applied ones, and (when the suite runs, the card is resolved and its record
 * is trusted) the pending ones the Automation box still waits to apply. `strict: false` returns the applied ops only
 * (the record needs no resolution or integrity check to say what it applied).
 * @returns {object[]}
 */
export function ownedOps(message, { strict = true } = {}) {
  const res = getResolution(message);
  if (!res?.ops) return [];
  const ops = Object.values(res.ops).filter(Boolean);
  const applied = ops.filter(o => o.status === OP_STATUS.APPLIED);
  if (!strict) return applied;
  if (setting("enabled") === false || !res.resolvedAt || integrity(message) !== "ok") return [];
  return [...applied, ...ops.filter(o => o.status === OP_STATUS.PENDING && !o.noApply)];
}

/** Does any owned op of `message` cover this button of part `partId`? See opCoversButton. */
export const partOwnedBySuite = (message, partId, action, what) => ownedOps(message).some(o => opCoversButton(o, partId, action, what));

function lock(button, tipKey = "DSAUTO.Lock.PartApplied") {
  button.disabled = true;
  button.classList?.add?.("ds-auto-locked");
  if (button.dataset) button.dataset.tooltip = loc(tipKey);
}

/** The roll index ctlib's "Apply All Damage" uses for a part: its first damage (not healing) roll, or -1. */
function firstDamageIndex(part) {
  const DamageRoll = globalThis.ds?.rolls?.DamageRoll;
  if (!DamageRoll) return -1;
  return Array.from(part?.rolls ?? []).findIndex(r => r instanceof DamageRoll && !r.isHeal);
}

/**
 * Disable ctlib's "Apply All Damage" button when every damage part of the card is owned by our ops (its click would
 * only be vetoed part by part). Pure on the record and the DOM.
 * @returns {number} How many buttons were disabled.
 */
export function decorateApplyAll(message, root) {
  if (!root?.querySelectorAll) return 0;
  const buttons = [...root.querySelectorAll("[data-ctlib-apply-all]")];
  if (!buttons.length) return 0;
  const owned = ownedOps(message);
  if (!owned.length) return 0;
  const parts = Array.from(message?.system?.parts ?? []).filter(p => p?.type === "targetResult" && firstDamageIndex(p) >= 0);
  if (!parts.length || !parts.every(p => owned.some(o => opCoversButton(o, p.id, "applyDamage", { index: firstDamageIndex(p) })))) return 0;
  for (const button of buttons) lock(button, "DSAUTO.Lock.PartOwned");
  return buttons.length;
}

/**
 * Disable the system buttons of targetResult parts whose row we own: applied rows (tooltip PartApplied) and rows
 * still pending in the Automation box (tooltip PartOwned), the same set the veto refuses (compat/target-result-veto.mjs).
 * Pure on the record and the DOM.
 * @returns {number} How many buttons were disabled.
 */
export function decoratePartButtons(message, root) {
  if (!root?.querySelectorAll) return 0;
  const applied = ownedOps(message, { strict: false });
  const owned = ownedOps(message);
  if (!applied.length && !owned.length) return 0;
  const tip = (partId, action, what) => (applied.some(o => opCoversButton(o, partId, action, what)) ? "DSAUTO.Lock.PartApplied"
    : (owned.some(o => opCoversButton(o, partId, action, what)) ? "DSAUTO.Lock.PartOwned" : null));
  let n = 0;
  for (const section of root.querySelectorAll("[data-message-part]")) {
    const partId = section.dataset?.messagePart ?? null;
    if (!partId || message?.system?.parts?.get?.(partId)?.type !== "targetResult") continue;
    const buttons = (action, what) => {
      for (const button of section.querySelectorAll(`[data-action="${action}"]`)) {
        const w = what(button);
        const key = w ? tip(partId, action, w) : null;
        if (!key) continue;
        lock(button, key);
        n++;
      }
    };
    buttons("applyDamage", b => {
      const index = Number(b.dataset?.index);
      return Number.isInteger(index) ? { index } : null;
    });
    buttons("applyEffect", b => ({ effectId: b.dataset?.effectId ?? "", uuid: b.dataset?.uuid ?? "" }));
    buttons("gainResource", b => ({ uuid: b.dataset?.uuid ?? "" }));
  }
  return n + decorateApplyAll(message, root);
}

/** init (WP-D wires it in main.mjs): renderChatMessageHTML -> per-part locks. */
export function registerPartLock() {
  if (typeof globalThis.Hooks?.on !== "function") return;
  Hooks.on("renderChatMessageHTML", (message, html) => {
    try {
      const root = globalThis.HTMLElement && html instanceof HTMLElement ? html : html?.[0] ?? html;
      if (!root) return;
      decoratePartButtons(message, root);
      // ctlib adds its footer button in its own render hook: look again once it ran.
      setTimeout(() => {
        try {
          decorateApplyAll(message, root);
        } catch (err) {
          error("partLock.applyAll", err, { messageId: message?.id ?? null });
        }
      }, 0);
    } catch (err) {
      error("partLock.render", err, { messageId: message?.id ?? null });
    }
  });
}
