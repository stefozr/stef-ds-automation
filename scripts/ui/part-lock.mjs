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
 * i18n keys: DSAUTO.Lock.PartApplied.
 */
import { OP_STATUS, loc } from "../constants.mjs";
import { getResolution } from "../engine/record.mjs";
import { error } from "../log.mjs";

const DAMAGE_KINDS = new Set(["damage", "heal", "temp"]);

/** Does a button's PRE uuid name this effect id? */
const preOf = (uuid, preId) => {
  const u = String(uuid ?? "");
  return !!u && !!preId && (u === preId || u.endsWith(`.${preId}`));
};

/** Is a damage-like op applied for (partId, rollIndex)? */
function damageApplied(ops, partId, rollIndex) {
  return ops.some(o => DAMAGE_KINDS.has(o.kind) && ((o.partId === partId && Number(o.rollIndex) === rollIndex)
    || (Array.isArray(o.parts) && o.parts.some(p => p?.partId === partId && Number(p?.rollIndex) === rollIndex))));
}

function lock(button) {
  button.disabled = true;
  button.classList?.add?.("ds-auto-locked");
  if (button.dataset) button.dataset.tooltip = loc("DSAUTO.Lock.PartApplied");
}

/**
 * Disable the system buttons of targetResult parts whose row we applied. Pure on the record and the DOM.
 * @returns {number} How many buttons were disabled.
 */
export function decoratePartButtons(message, root) {
  if (!root?.querySelectorAll) return 0;
  const res = getResolution(message);
  if (!res?.ops) return 0;
  const ops = Object.values(res.ops).filter(o => o?.status === OP_STATUS.APPLIED);
  if (!ops.length) return 0;
  let n = 0;
  for (const section of root.querySelectorAll("[data-message-part]")) {
    const partId = section.dataset?.messagePart ?? null;
    if (!partId || message?.system?.parts?.get?.(partId)?.type !== "targetResult") continue;
    for (const button of section.querySelectorAll('[data-action="applyDamage"]')) {
      const index = Number(button.dataset?.index);
      if (!Number.isInteger(index) || !damageApplied(ops, partId, index)) continue;
      lock(button);
      n++;
    }
    for (const button of section.querySelectorAll('[data-action="applyEffect"]')) {
      const effectId = button.dataset?.effectId ?? null;
      const hit = ops.some(o => o.kind === "condition" && !o.lib && o.partId === partId && o.effectId === effectId
        && preOf(button.dataset?.uuid, o.preId));
      if (!hit) continue;
      lock(button);
      n++;
    }
    for (const button of section.querySelectorAll('[data-action="gainResource"]')) {
      const hit = ops.some(o => o.kind === "resource" && o.native && o.partId === partId && preOf(button.dataset?.uuid, o.preId));
      if (!hit) continue;
      lock(button);
      n++;
    }
  }
  return n;
}

/** init (WP-D wires it in main.mjs): renderChatMessageHTML -> per-part locks. */
export function registerPartLock() {
  if (typeof globalThis.Hooks?.on !== "function") return;
  Hooks.on("renderChatMessageHTML", (message, html) => {
    try {
      const root = globalThis.HTMLElement && html instanceof HTMLElement ? html : html?.[0] ?? html;
      if (!root) return;
      decoratePartButtons(message, root);
    } catch (err) {
      error("partLock.render", err, { messageId: message?.id ?? null });
    }
  });
}
