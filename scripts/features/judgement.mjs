import { withResourceChain } from "../resources/world-resources.mjs";
/** Subclass benefits belong to the successful Judgement, including triggered retargets. */
import { MODULE_ID, OP_STATUS } from "../constants.mjs";
import { askFeature, frequencyKey } from "./engine.mjs";
import { evaluateInt } from "../library/formula.mjs";
import { featureRules } from "./engine.mjs";

export async function prepareJudgementBenefits(message, res, ops, patches, runOne, registerCreated) {
  const ability = fromUuidSync(res.abilityUuid ?? "");
  if (ability?.system?._dsid !== "judgement") return;
  const judged = ops.find(o => o.kind === "condition" && (o.effectId === "MHQDlicbxXquwduc" || o.libSource?.effect === "MHQDlicbxXquwduc") && patches[o.opId]?.status === OP_STATUS.APPLIED);
  if (!judged) return;
  const actor = ability.actor;
  const benefit = [...actor.items].find(i => ["oracle-judgement-benefit", "exorcist-judgement-benefit", "paragon-judgement-benefit"].includes(i.system?._dsid) && featureRules(i).length);
  if (!benefit) return;
  const credit = frequencyKey({ once: "turn" }, {});
  if (credit && !await withResourceChain(benefit.uuid, async () => {
    if (benefit.flags?.[MODULE_ID]?.judgementOpportunity?.credit === credit) return false;
    await benefit.update({ [`flags.${MODULE_ID}.judgementOpportunity`]: { credit, messageId: message.id, causeOpId: judged.opId } });
    return true;
  })) return;
  const opportunity = { benefitItemUuid: benefit.uuid, credit };
  patches[judged.opId].judgementOpportunity = opportunity;
  if (!(await askFeature(benefit, { id: "judgement", label: benefit.name }))?.accepted) return;
  const amount = evaluateInt("2*@P", ability);
  const rule = featureRules(benefit)[0];
  const kind = benefit.system._dsid.split("-")[0];
  const id = `${judged.opId}-benefit`;
  if (res.ops[id]?.status === OP_STATUS.APPLIED) return;
  const op = { opId: id, order: judged.order + 0.1, mode: "auto", status: OP_STATUS.PENDING, lib: true,
    featureItemUuid: benefit.uuid, ruleId: rule.id, label: benefit.name, judgementCause: judged.opId,
    targetKeys: [...judged.targetKeys] };
  if (kind === "oracle") Object.assign(op, { kind: "damage", amount, type: "holy", ignoredImmunities: [], aoe: false });
  if (kind === "paragon") Object.assign(op, { kind: "forced", movement: "pull", movements: ["pull"], distances: { pull: amount }, vertical: true, interactive: true, choosePath: true, properties: [], sourceTokenUuid: res.sourceTokenUuid });
  if (kind === "exorcist") {
    const key = Object.keys(res.targets).find(k => res.targets[k].tokenUuid === res.sourceTokenUuid);
    if (!key) {
      const doc = fromUuidSync(res.sourceTokenUuid ?? "");
      if (!doc) return;
      const { targetFromTokenDoc } = await import("../engine/targets.mjs");
      const target = targetFromTokenDoc(doc); res.targets[target.key] = { ...target, self: true }; op.targetKeys = [target.key];
    } else op.targetKeys = [key];
    Object.assign(op, { kind: "teleport", distance: amount, selfMove: true, autoStart: true, interactive: true, closerToTokenUuid: res.targets[judged.targetKeys[0]].tokenUuid });
  }
  registerCreated(patches, op, Object.fromEntries(op.targetKeys.map(k => [k, res.targets[k]]))); res.ops[id] = op; ops.push(op);
  await runOne(op);
}

export async function releaseJudgementOpportunity(message, op) {
  const info = op.judgementOpportunity;
  const item = info ? fromUuidSync(info.benefitItemUuid) : null;
  const current = item?.flags?.[MODULE_ID]?.judgementOpportunity;
  if (item && current?.messageId === message.id && current.causeOpId === op.opId) await item.update({ [`flags.${MODULE_ID}.judgementOpportunity`]: new foundry.data.operators.ForcedDeletion() });
}
