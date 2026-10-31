/**
 * Damage, healing and temporary stamina appliers. They reuse the system's own math
 * (BaseActorModel#takeDamage, SquadModel#takeDamage, modifyTokenAttribute) so immunities,
 * weaknesses, temporary stamina, squad pools and the AoE cap behave exactly as the system's
 * "Apply Damage" button. Amounts are always re-derived from the roll stored in the card; ops of a
 * synthetic card (api.applyDamage) carry their amount in the GM-signed record instead.
 * Half damage rounds down before immunities, like the system's shift-click (draw-steel.mjs:3832).
 * Runs on the active GM (owner of every actor). The Death Tracker note (engine applyOpList) and
 * `reportSquadDamage` (right before the pool write) come after any triggered-action hold (Milestone 5).
 */
import { MODULE_ID, OP_STATUS } from "../constants.mjs";
import { reportSquadDamage } from "../compat/death-tracker.mjs";
import { triggerHalved } from "../triggers/holds.mjs";
import { tokenIdFromUuid } from "./keys.mjs";

/**
 * Milestone 5: our own writes reach the system's takeDamage with this marker in the options of that call,
 * so the external-damage hold (triggers/external.mjs) lets them through. The system reads only `type`,
 * `ignoredImmunities` and `aoe` (draw-steel.mjs:1625-1641, 15138).
 */
const INTERNAL = Object.freeze({ internal: true });

/** The roll an op refers to. */
export function opRoll(message, op) {
  return message?.system?.parts?.get(op.partId)?.rolls?.[op.rollIndex] ?? null;
}

/**
 * What an op deals, independent of the target: `{total, type, ignoredImmunities, aoe, isHeal, temp}`
 * from the card's roll, or from the op itself on a synthetic card. Null when the roll is gone.
 * An edited op (engine editOp) replaces the total and may turn healing into temporary Stamina.
 */
export function opSource(message, op) {
  let src;
  // Synthetic cards, library rows (Milestone 4) and hero-token heals (Milestone 7: the recovery value, no roll) carry
  // their amount in the GM-signed record. 1.1.0: so do reactive rows (the tier value of the target's test, no card roll).
  if (op.synthetic || op.lib || op.heroToken || op.reactive) {
    src = {
      total: Number(op.rawAmount ?? op.amount ?? 0), type: op.type ?? "", ignoredImmunities: [...(op.ignoredImmunities ?? [])],
      aoe: !!op.aoe, isHeal: op.kind === "heal" || op.kind === "temp", temp: op.kind === "temp",
    };
  } else {
    const roll = opRoll(message, op);
    if (!roll) return null;
    src = {
      total: roll.total, type: roll.type ?? "", ignoredImmunities: [...(roll.ignoredImmunities ?? [])],
      aoe: !!roll.aoe, isHeal: !!roll.isHeal, temp: roll.type !== "value",
    };
  }
  const o = op.override;
  if (Number.isInteger(o?.amount)) src.total = o.amount;
  if (src.isHeal && typeof o?.temp === "boolean") src.temp = o.temp;
  if (op.featureBonus?.amount && !src.isHeal) src.total += Number(op.featureBonus.amount);
  if (op.surgeSpend && !src.isHeal) src.total += op.surgeSpend.count * op.surgeSpend.perSurge;
  return src;
}

/** The amount an op deals before immunities: half (rounded down) when applied as half damage. */
export function effectiveAmount(src, op) {
  return op.half && !src.isHeal ? Math.floor(src.total / 2) : src.total;
}

export function snapStamina(actor) {
  const s = actor?.system?.stamina ?? {};
  return { value: s.value ?? 0, temporary: s.temporary ?? 0 };
}

/** The actor's immunity and weakness against a damage source (0 for objects without damage data). */
export function immunityWeakness(actor, src) {
  try {
    const { immunity = 0, weakness = 0 } = actor.system.calculateImmunityAndWeakness?.({
      type: src.type, ignoredImmunities: [...src.ignoredImmunities],
    }) ?? {};
    return { immunity, weakness };
  } catch (_err) {
    return { immunity: 0, weakness: 0 }; // objects without damage data
  }
}

/** Highest immunity and weakness over a squad's hit minions (applied once per squad). */
function squadImmunityWeakness(minions, src) {
  const out = { immunity: 0, weakness: 0 };
  for (const m of minions) {
    const r = immunityWeakness(m, src);
    out.immunity = Math.max(out.immunity, r.immunity);
    out.weakness = Math.max(out.weakness, r.weakness);
  }
  return out;
}

/**
 * Apply one damage / heal / temp op.
 * @returns {Promise<object>} Fields to merge into the op record.
 */
export async function applyDamageOp(message, res, op) {
  if (op.surge) return applySurgeOp(message, res, op);
  const src = opSource(message, op);
  if (!src) return { status: OP_STATUS.FAILED, reason: "rollMissing" };
  const amount = effectiveAmount(src, op);
  const { type, ignoredImmunities } = src;

  // Minion squad: one pool write for every hit minion of the squad (cap and immunities once).
  if (op.group) {
    if (src.isHeal) return { status: OP_STATUS.SKIPPED, reason: "minionHeal" };
    const group = fromUuidSync(op.group);
    const minions = op.targetKeys.map(k => fromUuidSync(res.targets?.[k]?.actorUuid)).filter(Boolean);
    if (!group?.system || !minions.length) return { status: OP_STATUS.FAILED, reason: "targetMissing" };
    for (const k of op.targetKeys) reportSquadDamage(tokenIdFromUuid(res.targets?.[k]?.tokenUuid));
    const before = { staminaValue: group.system.staminaValue };
    await group.system.takeDamage(minions, amount, { type, ignoredImmunities, aoe: src.aoe, [MODULE_ID]: INTERNAL });
    const after = { staminaValue: group.system.staminaValue };
    return { status: OP_STATUS.APPLIED, amount, finalAmount: before.staminaValue - after.staminaValue, before, after };
  }

  const actor = fromUuidSync(res.targets?.[op.targetKeys[0]]?.actorUuid);
  if (!actor) return { status: OP_STATUS.FAILED, reason: "targetMissing" };
  const before = snapStamina(actor);

  if (src.isHeal) {
    if (src.temp && amount < before.temporary) return { status: OP_STATUS.SKIPPED, reason: "tempNotHigher", amount };
    await actor.modifyTokenAttribute(src.temp ? "stamina.temporary" : "stamina", amount, !src.temp, !src.temp);
    return { status: OP_STATUS.APPLIED, amount, finalAmount: amount, before, after: snapStamina(actor) };
  }

  const { immunity, weakness } = immunityWeakness(actor, src);
  await actor.system.takeDamage(amount, { type, ignoredImmunities, aoe: src.aoe, [MODULE_ID]: INTERNAL });
  return {
    status: OP_STATUS.APPLIED, amount, immunity, weakness,
    finalAmount: Math.max(0, amount + weakness - immunity), before, after: snapStamina(actor),
  };
}

/**
 * Surge damage on top of a base damage op. The system adds surges to the damage roll, so immunity
 * and weakness apply once to the total: the surge op deals the difference the extra damage makes,
 * `f(base + earlier surges + this) - f(base + earlier surges)` with `f(x) = max(0, x + weakness -
 * immunity)` (for a squad: over the squad's total, with the area cap on the surged minion). The
 * difference is written as Stamina loss without a second immunity pass.
 * Milestone 5: when a used triggered action halved the base op (Parry), base and surges are halved
 * together, as one halved hit: `g(raw + earlier + S) - g(raw + earlier)` inside `f`, `g(x) = floor(x / 2)`.
 * Without it the M1.5 "Apply half" behaviour stays (only the base was halved).
 */
async function applySurgeOp(message, res, op) {
  const base = res.ops?.[op.surge.baseOpId];
  if (!base) return { status: OP_STATUS.FAILED, reason: "rollMissing" };
  const src = opSource(message, base);
  if (!src || src.isHeal) return { status: OP_STATUS.FAILED, reason: "rollMissing" };
  const B = effectiveAmount(src, base);
  const earlier = Object.values(res.ops ?? {})
    .filter(o => o.surge?.baseOpId === base.opId && o.opId !== op.opId && o.status === OP_STATUS.APPLIED)
    .reduce((sum, o) => sum + Number(o.amount ?? 0), 0);
  const S = Number(op.amount ?? 0);
  // x = what the surges have added so far (+ this one); the hit those surges belong to, halved or not.
  const halvedHit = triggerHalved(base);
  const raw = Number(src.total) || 0;
  const g = x => Math.floor(x / 2);
  const hit = x => (halvedHit ? g(raw + x) : B + x);

  if (op.group) {
    const group = fromUuidSync(op.group);
    const minions = (base.targetKeys ?? []).map(k => fromUuidSync(res.targets?.[k]?.actorUuid)).filter(Boolean);
    const surged = fromUuidSync(res.targets?.[op.targetKeys[0]]?.actorUuid);
    if (!group?.system || !minions.length || !surged) return { status: OP_STATUS.FAILED, reason: "targetMissing" };
    const { immunity, weakness } = squadImmunityWeakness(minions, src);
    const cap = src.aoe ? Number(minions[0].system?.stamina?.max ?? Infinity) : Infinity;
    const total = x => Math.max(0, (minions.length - 1) * Math.min(cap, B) + Math.min(cap, x) + weakness - immunity);
    const delta = Math.max(0, total(hit(earlier + S)) - total(hit(earlier)));
    reportSquadDamage(tokenIdFromUuid(res.targets?.[op.targetKeys[0]]?.tokenUuid));
    const before = { staminaValue: group.system.staminaValue };
    if (delta > 0) await group.update({ "system.staminaValue": before.staminaValue - delta }, { ds: { damageType: src.type } });
    const after = { staminaValue: group.system.staminaValue };
    return { status: OP_STATUS.APPLIED, amount: S, immunity, weakness, finalAmount: delta, before, after };
  }

  const actor = fromUuidSync(res.targets?.[op.targetKeys[0]]?.actorUuid);
  if (!actor) return { status: OP_STATUS.FAILED, reason: "targetMissing" };
  const { immunity, weakness } = immunityWeakness(actor, src);
  const f = x => Math.max(0, x + weakness - immunity);
  const delta = Math.max(0, f(hit(earlier + S)) - f(hit(earlier)));
  const before = snapStamina(actor);
  if (delta > 0) await actor.modifyTokenAttribute("stamina", -delta, true, false);
  return { status: OP_STATUS.APPLIED, amount: S, immunity, weakness, finalAmount: delta, before, after: snapStamina(actor) };
}
