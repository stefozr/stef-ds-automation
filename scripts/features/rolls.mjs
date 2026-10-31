/** Performance roll choices settle before an ability's automation plans its tiers. */
import { MODULE_ID } from "../constants.mjs";
import { hasBenefit, benefits } from "./capabilities.mjs";
import { askFeature } from "./engine.mjs";
import { isActiveGM } from "../engine/engine.mjs";
import { wrap } from "../compat/lib-wrapper.mjs";
import { currentActivation } from "../turn/lifecycle.mjs";
import { error } from "../log.mjs";

const pending = new Set();
const checked = new Set();
const list = c => c?.contents ?? (c ? [...c] : []);
export function turnCredit(actor) {
  const combat = game.combat;
  const combatant = list(combat?.combatants).find(c => c.actor?.uuid === actor.uuid);
  const activation = currentActivation(combat?.id, combatant?.id);
  return `${combat?.id}:${combat?.round}:${combatant?.id}:${activation?.n ?? combat?.turn}`;
}
function benefitItem(actor, type) {
  const effect = benefits(actor, type)[0];
  return effect ? fromUuidSync(effect.flags[MODULE_ID].ruleEffect.itemUuid) : null;
}
export async function preparePerformanceRolls(message, item = null) {
  if (!isActiveGM() || checked.has(message.id) || pending.has(message.id)) return;
  const actor = item?.actor ?? ChatMessage.getSpeakerActor?.(message.speaker);
  if (!actor) return;
  const parts = list(message.system?.parts);
  const powerParts = parts.filter(p => ["abilityResult", "targetResult", "test"].includes(p.type));
  const PowerRoll = ds.rolls.PowerRoll;
  if (!powerParts.length || (!hasBenefit(actor, "takeTwo") && !hasBenefit(actor, "acrobatics"))) return;
  pending.add(message.id); checked.add(message.id);
  try {
    const credit = turnCredit(actor);
    const testPart = powerParts.find(p => p.type === "test");
    const testRoll = testPart?.latestTest ?? testPart?.rolls?.at(-1);
    if (testRoll instanceof PowerRoll && hasBenefit(actor, "acrobatics") && (!testRoll.options?.skill || ["jump", "tumble", "climb"].includes(testRoll.options.skill)) && actor.flags?.[MODULE_ID]?.acrobaticsUsed !== credit) {
      const feature = benefitItem(actor, "acrobatics");
      const answer = feature && await askFeature(feature, { id: "acrobatics", label: game.i18n.localize("DSAUTO.Feature.Acrobatics") }, { promptActor: actor });
      if (answer?.accepted) {
        const forced = PowerRoll.fromData(testRoll.toJSON());
        forced.options.dsAutoTier = 3;
        await testPart.update({ rolls: [...testPart.rolls.slice(0, -1), forced] });
        await actor.update({ [`flags.${MODULE_ID}.acrobaticsUsed`]: credit });
        return;
      }
    }
    const first = powerParts.flatMap(p => p.rolls ?? []).find(r => r instanceof PowerRoll && r.product === 2);
    if (!first || !hasBenefit(actor, "takeTwo") || actor.flags?.[MODULE_ID]?.takeTwoSeen === credit) return;
    await actor.update({ [`flags.${MODULE_ID}.takeTwoSeen`]: credit });
    const feature = benefitItem(actor, "takeTwo");
    const answer = feature && await askFeature(feature, { id: "take-two", label: game.i18n.localize("DSAUTO.Feature.Reroll") }, { promptActor: actor });
    if (!answer?.accepted) return;
    if (testPart) { await testPart.reroll(); return; }
    const rerolled = await first.reroll();
    const DamageRoll = ds.rolls.DamageRoll;
    const damageSelection = powerParts.flatMap(p => p.rolls ?? []).find(r => r instanceof DamageRoll)?.type;
    const update = {};
    const grouped = new Map();
    for (const part of powerParts) {
      const powerRolls = part.rolls.filter(r => r instanceof PowerRoll);
      for (const original of powerRolls) {
        const roll = new PowerRoll(original.formula, {}, { ...original.options });
        roll.terms[0] = rerolled.terms[0];
        await roll.evaluate({ allowInteractive: false });
        const tier = roll.product;
        const id = part.type === "targetResult" ? part.id : `tier${tier}Result`.padEnd(16, "0");
        let data = grouped.get(id);
        if (!data) {
          const source = part.toObject?.() ?? part._source ?? {};
          data = { ...source, _id: id, type: part.type, tier, abilityUuid: item.uuid, rolls: [] };
          grouped.set(id, data);
        }
        data.rolls.push(roll);
      }
      update[`system.parts.${part.id}`] = new foundry.data.operators.ForcedDeletion();
    }
    for (const [id, data] of grouped) {
      const spend = message.flags?.[MODULE_ID]?.resolution?.spend;
      for (const effect of item.system.power.effects.documentsByType.damage ?? []) {
        const damage = effect.toDamageRoll(data.tier, { damageSelection, spend: Array.isArray(spend) ? spend : undefined });
        if (damage) { await damage.evaluate(); data.rolls.push(damage); }
      }
      update[`system.parts.${id}`] = data;
    }
    await message.update(update, { [MODULE_ID]: { internal: true } });
  } finally { pending.delete(message.id); }
}
export function registerPerformanceRolls() {
  wrap("ds.rolls.PowerRoll.prototype.product", function(wrapped) { return this.options?.dsAutoTier === 3 ? 3 : wrapped(); }, "MIXED");
  Hooks.on("createChatMessage", message => {
    const item = fromUuidSync(list(message.system?.parts).find(p => p.type === "abilityUse")?.abilityUuid ?? "");
    if (!message.flags?.[MODULE_ID]?.resolution && list(message.system?.parts).some(p => ["test", "abilityResult", "targetResult"].includes(p.type))) preparePerformanceRolls(message, item).catch(e => error("performance.roll", e));
  });
}
