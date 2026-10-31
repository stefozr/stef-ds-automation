/**
 * Turn arms (Milestone 9, docs/M9-DESIGN.md §C): the M6 activation-aware arms as pure exports, shared by the
 * Persistent registry (persistent/registry.mjs). Copies of summons/registry.mjs `counts` / `buildIndexEntry`'s arms
 * and zones/create.mjs `armsOf`; those copies stay untouched this wave (moving them is a follow-up).
 *
 * An arm is `{round, activation, open, epoch, combatantId}`: the round and the user's activation number when it was
 * made, whether that activation was still open, and the identity of the activation counter (lifecycle epoch and
 * combatant), so a counter restarted by a GM reload or a Death Tracker revival is never compared by number.
 */
import * as lifecycle from "./lifecycle.mjs";

const finite = v => typeof v === "number" && Number.isFinite(v);

/**
 * The arms of something made now during `combatant`'s activation in `combat` (both may be null: no combat).
 * turnStart counts when activation > n (a later turn); turnEnd when activation >= the open one (or the next).
 * @param {Combat|null} combat
 * @param {Combatant|null} combatant
 * @returns {{armStart: object, armEnd: object}}
 */
export function buildArm(combat, combatant) {
  let act = null;
  try {
    act = combat && combatant ? (lifecycle.currentActivation?.(combat.id, combatant.id) ?? null) : null;
  } catch (_err) {
    act = null;
  }
  const round = combat?.round ?? null;
  const counter = { open: !!act?.open, epoch: lifecycle.activationEpoch ?? null, combatantId: combatant?.id ?? null };
  return {
    armStart: { round, activation: act?.n ?? 0, ...counter },
    armEnd: { round, activation: act ? (act.open ? act.n : act.n + 1) : 0, ...counter },
  };
}

/**
 * Does a turn event count against an arm (summons/registry.mjs `counts`)? A later round always does. Within the arm's
 * round the activation numbers decide, but only when they come from the same counter; otherwise a turnEnd ('>=')
 * counts and a turnStart ('>') counts unless the arm was made inside the then-open activation and this may be a
 * repeat of its start (a second activation counts). Without an activation number the round decides.
 * @param {object|null} arm
 * @param {{round: number|null, activation: number|null, combatantId?: string|null}} at
 * @param {">"|">="} op
 * @returns {boolean}
 */
export function counts(arm, { round, activation, combatantId = null }, op) {
  if (!arm) return true;
  if (finite(round) && finite(arm.round) && round > arm.round) return true;
  const sameCounter = arm.epoch === lifecycle.activationEpoch && (!arm.combatantId || !combatantId || arm.combatantId === combatantId);
  if (!sameCounter) {
    if (!finite(round) || !finite(arm.round) || round !== arm.round) return false;
    if (op !== ">") return true;
    return !arm.open || (finite(activation) && activation > 1);
  }
  if (!finite(activation) || !finite(arm.activation)) return false;
  return op === ">" ? activation > arm.activation : activation >= arm.activation;
}
