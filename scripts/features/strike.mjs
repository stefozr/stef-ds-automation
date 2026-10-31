/** Optional extra strike damage is part of its original hit, before mitigation. */
import { MODULE_ID, OP_STATUS } from "../constants.mjs";
import { featureRules, askFeature, frequencyKey } from "./engine.mjs";
import { evaluateInt } from "../library/formula.mjs";

const reserved = new Map();
export async function prepareStrikeBonuses(message, res, ops) {
  if (res.synthetic) return;
  const ability = fromUuidSync(res.abilityUuid ?? "");
  const actor = ability?.actor;
  if (!actor || !ability.system.keywords?.has?.("melee") || !ability.system.keywords?.has?.("strike")) return;
  for (const item of actor.items?.contents ?? actor.items ?? []) for (const rule of featureRules(item).filter(r => r.event === "strike.damage")) {
    const key = `${item.uuid}:${rule.id}`;
    const frequency = frequencyKey(rule, {});
    if (reserved.has(key) || (frequency && item.flags?.[MODULE_ID]?.ruleUses?.[rule.id] === frequency)) continue;
    const hits = ops.filter(o => o.kind === "damage" && !o.surge && !o.featureBonus);
    if (!hits.length) continue;
    reserved.set(key, message.id);
    try {
      if (rule.optional && !(await askFeature(item, rule))?.accepted) continue;
      let op = hits[0];
      if (hits.length > 1) {
        const tokens = hits.map(o => fromUuidSync(res.targets[o.targetKeys[0]].tokenUuid)).filter(Boolean);
        const answer = await askFeature(item, rule, { kind: "targets", tokens, limit: 1 });
        op = hits.find(o => answer?.ids?.includes(res.targets[o.targetKeys[0]].tokenUuid));
        if (!op) continue;
      }
      const amount = rule.effects.filter(e => e.type === "damage").reduce((n, e) => n + (evaluateInt(e.value, item) ?? 0), 0);
      if (!amount) continue;
      op.featureBonus = { amount, itemUuid: item.uuid, ruleId: rule.id, frequency };
      Object.assign(op, { featureItemUuid: item.uuid, ruleId: rule.id, featureFrequency: frequency });
      res.ops[op.opId] = op;
    } finally {
      if (!ops.some(o => o.featureBonus?.itemUuid === item.uuid)) reserved.delete(key);
    }
  }
}
export async function settleStrikeBonus(message, op, patch) {
  const bonus = op.featureBonus;
  if (!bonus) return;
  if (patch.status === OP_STATUS.APPLIED) {
    Object.assign(patch, { featureBonus: bonus, featureItemUuid: bonus.itemUuid, ruleId: bonus.ruleId, featureFrequency: bonus.frequency });

  }
  reserved.delete(`${bonus.itemUuid}:${bonus.ruleId}`);
}

export function releaseStrikeReservations(messageId) { for (const [key, id] of reserved) if (id === messageId) reserved.delete(key); }
