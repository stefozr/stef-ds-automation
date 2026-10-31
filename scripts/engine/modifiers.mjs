/** Managed attribute modifiers, with independent effects and conservative Undo. */
import { MODULE_ID, OP_STATUS } from "../constants.mjs";
import { entryId } from "../library/entries.mjs";
import { setUntil } from "../turn/until.mjs";

export async function applyModifier(message, res, op) {
  const actor = fromUuidSync(res.targets?.[op.targetKeys?.[0]]?.actorUuid ?? "");
  if (!actor) return { status: OP_STATUS.FAILED, reason: "targetMissing" };
  const id = entryId("modifier", op.featureItemUuid ?? res.abilityUuid, op.ruleId, op.modifierId, actor.uuid);
  const prior = actor.effects.get(id)?.toObject() ?? null;
  const data = {
    _id: id, name: op.label ?? res.abilityName, type: "base", transfer: true, origin: op.featureItemUuid ?? res.abilityUuid,
    system: { changes: op.property === "benefit:dying" ? [{ key: "system.statuses.immunities", value: "bleeding", type: "add", phase: "initial" }] : op.property === "benefit:entropy" ? [{ key: "system.restrictions.type", value: "triggered", type: "add", phase: "initial" }, { key: "system.restrictions.type", value: "freeTriggered", type: "add", phase: "initial" }] : op.property === "benefit:concealment" ? [{ key: "flags.draw-steel-combat-tools.stealth.ignoresConcealmentBane", value: true, type: "override", phase: "initial" }] : op.property.startsWith("benefit:") || op.property.startsWith("system.roll.") ? [] : [{ key: op.property, value: op.value, type: op.modifierMode ?? "add", phase: "initial" }] },
    flags: { [MODULE_ID]: { messageId: message.id, ruleEffect: { itemUuid: op.featureItemUuid, ruleId: op.ruleId, end: op.featureEnd, benefit: op.property.startsWith("benefit:") ? op.property.slice(8) : null, combatId: game.combat?.id, round: game.combat?.round, sourceActorUuid: res.sourceActorUuid } } },
  };
  if (op.featureEnd === "aura") {
    data.flags[MODULE_ID].auraEffectKey = `${fromUuidSync(op.featureItemUuid)?.system?._dsid}:${op.ruleId}:${op.modifierId}`;
    data.flags[MODULE_ID].auraOriginalChanges = structuredClone(data.system.changes);
  }
  if (prior) await actor.deleteEmbeddedDocuments("ActiveEffect", [id]);
  try {
    const created = await actor.createEmbeddedDocuments("ActiveEffect", [data], { keepId: true });
    if (!created?.length) throw new Error("DSAUTO.Reason.nothingCreated");
    await applyRuleDuration(created[0], res, op);
    if (op.property === "benefit:moonlight" && game.combat) {
      await actor.update({ [`flags.${MODULE_ID}.moonlightChosen`]: game.combat.id });
      for (const c of game.combat.combatants) if (c.actor?.uuid === actor.uuid && c.isDefeated) await c.update({ defeated: false });
    }
    return { status: OP_STATUS.APPLIED, createdIds: [created[0].id], replaced: prior, modifierSnapshot: created[0].toObject() };
  } catch (err) {
    if (prior && !actor.effects.has(id)) await actor.createEmbeddedDocuments("ActiveEffect", [prior], { keepId: true });
    throw err;
  }
}

export async function undoModifier(res, op) {
  const actor = fromUuidSync(res.targets?.[op.targetKeys?.[0]]?.actorUuid ?? "");
  if (!actor) return { status: OP_STATUS.FAILED, reason: "targetMissing" };
  for (const id of op.createdIds ?? []) {
    const current = actor.effects.get(id);
    if (current && (current.flags?.[MODULE_ID]?.messageId !== op.modifierSnapshot?.flags?.[MODULE_ID]?.messageId || JSON.stringify(current.toObject().system) !== JSON.stringify(op.modifierSnapshot?.system) || !!current.disabled !== !!op.modifierSnapshot?.disabled)) return { status: OP_STATUS.FAILED, reason: "effectChanged" };
    if (current) await current.delete();
  }
  if (op.replaced && !actor.effects.has(op.replaced._id)) await actor.createEmbeddedDocuments("ActiveEffect", [op.replaced], { keepId: true });
  return { status: OP_STATUS.UNDONE };
}

export async function applyRuleDuration(effect, res, op) {
  if (!effect || !op.featureEnd) return;
  const combat = game.combat;
  const source = combat?.combatants?.find(c => c.actor?.uuid === res.sourceActorUuid);
  const target = combat?.combatants?.find(c => c.actor?.uuid === effect.parent?.uuid);
  const end = op.featureEnd;
  const c = end.startsWith("source") ? source : target;
  const event = /Start$/.test(end) ? "turnStart" : "turnEnd";
  if (["nextTurnEnd", "nextTurnStart", "sourceNextTurnStart", "sourceNextTurnEnd", "turnEnd"].includes(end) && c) {
    await setUntil(effect, { event, combatantId: c.id });
  }
  await effect.update({ [`flags.${MODULE_ID}.ruleEffect`]: {
    itemUuid: op.featureItemUuid, ruleId: op.ruleId, end, property: op.property, value: op.value, combatId: combat?.id ?? null,
    round: combat?.round ?? null, benefit: op.property?.startsWith("benefit:") ? op.property.slice(8) : null, sourceActorUuid: res.sourceActorUuid,
  } });
}
