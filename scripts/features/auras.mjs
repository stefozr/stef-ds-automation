/** Persistent moving auras. Recipient effects are source-tagged; encounter end is a content rule. */
import { MODULE_ID, HOOKS, OP_STATUS } from "../constants.mjs";
import { automationFor } from "../library/custom.mjs";
import { findOverlay } from "../library/registry.mjs";
import { evaluateInt } from "../library/formula.mjs";
import { executeRule, askFeature, frequencyKey } from "./engine.mjs";
import { distanceSquares, relation, tokenOnScene, incapacitated } from "../triggers/eligibility.mjs";
import { isActiveGM } from "../engine/engine.mjs";
import { postRecordCard } from "../engine/synthetic.mjs";
import { opSource } from "../engine/damage.mjs";
import { useState } from "../engine/library-plan.mjs";
import { targetFromTokenDoc } from "../engine/targets.mjs";
import { entryId } from "../library/entries.mjs";
import { onTurnEvent, currentActivation } from "../turn/lifecycle.mjs";
import { setting } from "../settings.mjs";
import { error } from "../log.mjs";
import { holdsAura } from "../persistent/registry.mjs";
import { zoneArea, zoneShapes } from "../zones/shapes.mjs";

const list = c => c?.contents ?? [...(c ?? [])];
let chain = Promise.resolve(), timer;
const schedule = fn => { const run = chain.then(fn); chain = run.catch(e => error("auras", e)); return run; };
export const auraDefinition = item => automationFor(item, findOverlay(item))?.aura ?? null;
export function auraActive(item) {
  return setting("enabled") !== false && setting("libraryEnabled") !== false && !item?.flags?.[MODULE_ID]?.disabled && !!auraDefinition(item) && !!item.flags?.[MODULE_ID]?.aura?.active && !["dying", "dead", "defeated"].includes(incapacitated(item.actor, game.combat));
}
/** Squares: the ability's distance, the strained Reflector Field's +1 and a granted `sizeBonus` (Psychic Pulse). */
export function auraRadius(item) {
  const state = item.flags?.[MODULE_ID]?.aura;
  return evaluateInt(item.system?.distance?.primary ?? 0, item) + (state?.strained && item.system._dsid === "reflector-field" ? 1 : 0) + (Number(state?.sizeBonus) || 0);
}
export function auraItems(scene = globalThis.canvas?.scene) {
  const actors = new Map(list(scene?.tokens).filter(t => t.actor).map(t => [t.actor.uuid, t.actor]));
  return [...actors.values()].flatMap(a => list(a.items)).filter(i => auraActive(i) && i.flags[MODULE_ID].aura.sceneId === scene?.id);
}
export function auraRecipients(item, { filter = "all", positions = null } = {}) {
  const state = item.flags?.[MODULE_ID]?.aura;
  const source = fromUuidSync(state?.tokenUuid ?? "");
  if (!source || !auraActive(item)) return [];
  const radius = auraRadius(item);
  return list(source.parent.tokens).filter(t => {
    if (!t.actor || t.actor.system?.isObject) return false;
    const side = relation(source, t);
    if (filter === "enemies" && side !== "enemy") return false;
    if (filter === "allies" && side !== "ally") return false;
    if (filter === "selfAlly" && !["ally", "self"].includes(side)) return false;
    return distanceSquares(source, t, positions) <= radius && (!source.object?.hasLineOfEffect || source.object.hasLineOfEffect(t.object));
  });
}
export function auraPotencyBonus(item, actor) {
  const token = tokenOnScene(actor, globalThis.canvas?.scene?.id);
  const source = tokenOnScene(item?.actor, token?.parent?.id);
  if (!token || !source) return 0;
  return auraItems(token.parent).some(field => field.system._dsid === "null-field" && field.flags[MODULE_ID].aura.option === "synaptic"
    && ["self", "ally"].includes(relation(fromUuidSync(field.flags[MODULE_ID].aura.tokenUuid), source))
    && auraRecipients(field, { filter: "enemies" }).some(t => t.uuid === token.uuid)) ? 1 : 0;
}
export function judgedBy(item, token) {
  const judgement = list(item.actor.items).find(i => i.system?._dsid === "judgement");
  return !!judgement && list(token?.actor?.effects).some(e => !e.disabled && e.origin === judgement.uuid && (e.id === "MHQDlicbxXquwduc" || e.flags?.[MODULE_ID]?.messageId));
}
export async function setAura(item, active, { message = null } = {}) {
  if (!isActiveGM() || !auraDefinition(item)) throw new Error("DSAUTO.Relay.BadRequest");
  const before = structuredClone(item.flags?.[MODULE_ID]?.aura ?? null);
  const token = active ? tokenOnScene(item.actor, message?.speaker?.scene ?? globalThis.canvas?.scene?.id) : null;
  if (active && (!token || ["dying", "dead", "defeated"].includes(incapacitated(item.actor, game.combat)))) throw new Error("DSAUTO.Reason.notOnCanvas");
  if (!active) await clearAuraEffects(item, { removeRegion: true });
  const combatant = list(game.combat?.combatants).find(c => c.actor?.uuid === item.actor.uuid);
  const state = active ? { active: true, tokenUuid: token.uuid, sceneId: token.parent.id, combatId: game.combat?.id ?? null,
    persistent: !!message?.system?.parts?.contents?.find(p => p.type === "abilityUse")?.effects?.some(id => item.system.effects?.get(id)?.type === "persistent"),
    strained: message ? !!useState(message, item).strained : false, activation: currentActivation(game.combat?.id, combatant?.id)?.n ?? game.combat?.turn ?? null, sourceMessageId: message?.id ?? null } : { active: false };
  await item.update({ [`flags.${MODULE_ID}.aura`]: foundry.data.operators.ForcedReplacement.create(state) });
  await refreshAuras();
  return { before, state };
}
/** Redraw the attached aura region at the current radius (the region keeps its centre on the token). Never throws on a missing region. */
export async function resizeAuraRegion(item) {
  const token = fromUuidSync(item.flags?.[MODULE_ID]?.aura?.tokenUuid ?? "");
  if (!token?.parent) return;
  const { attachedAuraRegion } = await import("../engine/areas.mjs");
  const region = attachedAuraRegion(item, token);
  if (!region) return;
  const area = zoneArea(item, { shape: "ability", size: auraRadius(item) }, v => evaluateInt(v, item));
  const shapes = zoneShapes(area, { scene: token.parent, creatorDoc: token });
  const hole = region.shapes?.[0]?.base?.hole;
  if (hole !== undefined) for (const shape of shapes) if (shape.base) shape.base.hole = hole;
  await region.update({ shapes });
}
/** Psychic Pulse: Null Field grows by `bonus` until the start of its user's next turn (cleared in expireAuraTurn). */
export async function growAura(item, bonus, { messageId = null } = {}) {
  const combatant = list(game.combat?.combatants).find(c => c.actor?.uuid === item.actor.uuid);
  const activation = currentActivation(game.combat?.id, combatant?.id)?.n ?? game.combat?.turn ?? null;
  await item.update({ [`flags.${MODULE_ID}.aura.sizeBonus`]: bonus, [`flags.${MODULE_ID}.aura.sizeBonusActivation`]: activation, [`flags.${MODULE_ID}.aura.sizeBonusMessageId`]: messageId });
  await resizeAuraRegion(item);
  await refreshAuras();
}
async function clearAuraEffects(item, { removeRegion = false } = {}) {
  if (removeRegion) {
    const { removeAutomaticAuraRegions } = await import("../engine/areas.mjs");
    await removeAutomaticAuraRegions(item);
  }
  for (const scene of list(game.scenes)) for (const token of list(scene.tokens)) {
    const ids = list(token.actor?.effects).filter(e => e.flags?.[MODULE_ID]?.ruleEffect?.itemUuid === item.uuid && (e.flags[MODULE_ID].ruleEffect.end === "aura" || item.system._dsid === "riders-on-the-storm")).map(e => e.id);
    if (ids.length) await token.actor.deleteEmbeddedDocuments("ActiveEffect", ids);
  }
}
export async function refreshAuras(scene = globalThis.canvas?.scene) {
  if (!isActiveGM() || !scene) return;
  const actors = new Map(list(scene.tokens).filter(t => t.actor).map(t => [t.actor.uuid, t.actor]));
  const items = [...actors.values()].flatMap(a => list(a.items)).filter(i => auraDefinition(i));
  for (const item of items) {
    if (item.flags?.[MODULE_ID]?.aura?.active && !auraActive(item)) await setAura(item, false);
    const rules = auraActive(item) ? automationFor(item, findOverlay(item)).rules.filter(r => r.event === "aura.continuous") : [];
    const forRule = r => r.targets === "self" ? [fromUuidSync(item.flags[MODULE_ID].aura.tokenUuid)].filter(Boolean) : auraRecipients(item, { filter: r.filter });
    const recipients = new Set(rules.flatMap(r => forRule(r).map(t => `${r.id}:${t.actor.uuid}`)));
    for (const actor of actors.values()) {
      const remove = list(actor.effects).filter(e => e.flags?.[MODULE_ID]?.ruleEffect?.itemUuid === item.uuid && e.flags[MODULE_ID].ruleEffect.end === "aura" && !recipients.has(`${e.flags[MODULE_ID].ruleEffect.ruleId}:${actor.uuid}`)).map(e => e.id);
      if (remove.length) await actor.deleteEmbeddedDocuments("ActiveEffect", remove);
    }
    for (const rule of rules) {
      const missing = forRule(rule).filter(t => !list(t.actor.effects).some(e => e.flags?.[MODULE_ID]?.ruleEffect?.itemUuid === item.uuid && e.flags[MODULE_ID].ruleEffect.ruleId === rule.id && !e.disabled));
      // Same-named continuous conditions follow the strongest native effect once, rather than multiplying overlap.
      if (missing.length) await executeRule(item, { ...rule, targets: "targets", end: "aura" }, { sceneId: scene.id, targetDocs: missing });
    }
  }
  for (const actor of actors.values()) {
    const groups = new Map();
    for (const e of list(actor.effects)) {
      const key = e.flags?.[MODULE_ID]?.auraEffectKey;
      if (!key || e.disabled) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    for (const effects of groups.values()) for (const [n, e] of effects.entries()) {
      const changes = n ? [] : e.flags[MODULE_ID].auraOriginalChanges;
      if (JSON.stringify(e.system?.changes ?? []) !== JSON.stringify(changes)) await e.update({ "system.changes": changes });
    }
  }
}
export function refreshAurasSoon() { clearTimeout(timer); timer = setTimeout(() => schedule(() => refreshAuras()), 50); }
export async function chooseNullOption(item) {
  const answer = await askFeature(item, { id: "null-option", label: game.i18n.localize("DSAUTO.Aura.NullOption") }, { kind: "choice", choices: [
    { id: "none", name: game.i18n.localize("DSAUTO.Aura.NoOption") },
    { id: "gravitic", name: game.i18n.localize("DSAUTO.Aura.Gravitic") }, { id: "anchor", name: game.i18n.localize("DSAUTO.Aura.Anchor") }, { id: "synaptic", name: game.i18n.localize("DSAUTO.Aura.Synaptic") } ] });
  const option = answer?.ids?.[0];
  if (!option || option === "none") return { ok: true };
  return purchaseNullOption(item, option);
}
export async function purchaseNullOption(item, option) {
  const state = item.flags?.[MODULE_ID]?.aura;
  const credit = frequencyKey({ once: "turn" }, {});
  const source = state?.tokenUuid ? fromUuidSync(state.tokenUuid) : null;
  if (!auraActive(item) || item.system._dsid !== "null-field" || !["gravitic", "anchor", "synaptic"].includes(option) || !credit || game.combat?.combatant?.actor?.uuid !== item.actor.uuid) throw new Error("DSAUTO.Relay.BadRequest");
  if (state.optionCredit === credit || item.actor.system.hero.primary.value < 1) return { ok: false };
  const target = targetFromTokenDoc(source);
  const result = await postRecordCard({ title: item.name, sourceActor: item.actor, abilityUuid: item.uuid, sourceTokenUuid: source.uuid, targets: { [target.key]: { ...target, self: true } }, user: game.user,
    ops: { cost: { opId: "cost", kind: "resource", resource: "heroic", amount: -1, minimumBefore: 1, mode: "auto", featureCost: true, status: "pending", targetKeys: [target.key], order: -1 },
      option: { opId: "option", kind: "auraOption", option, auraItemUuid: item.uuid, credit, costOpId: "cost", mode: "auto", status: "pending", targetKeys: [target.key], order: 0 } } });
  return { ok: result.ops.option?.status === OP_STATUS.APPLIED, messageId: result.messageId };
}
export async function applyAuraOption(message, op) {
  const item = fromUuidSync(op.auraItemUuid), before = structuredClone(item?.flags?.[MODULE_ID]?.aura ?? null);
  if (!auraActive(item) || before.optionCredit === op.credit || op.credit !== frequencyKey({ once: "turn" }, {})) return { status: OP_STATUS.SKIPPED, reason: "featureAlreadyUsed" };
  await item.update({ [`flags.${MODULE_ID}.aura.option`]: op.option, [`flags.${MODULE_ID}.aura.optionCredit`]: op.credit, [`flags.${MODULE_ID}.aura.optionMessageId`]: message.id });
  return { status: OP_STATUS.APPLIED, auraBefore: before, auraMessageId: message.id };
}
export async function undoAura(op) {
  const item = fromUuidSync(op.auraItemUuid);
  if (!item) return { status: OP_STATUS.FAILED, reason: "targetMissing" };
  if (op.kind === "auraActivation" && item.flags?.[MODULE_ID]?.aura?.sourceMessageId !== op.auraSourceMessageId) return { status: OP_STATUS.FAILED, reason: "effectChanged" };
  if (op.kind === "auraOption" && item.flags?.[MODULE_ID]?.aura?.optionMessageId !== op.auraMessageId) return { status: OP_STATUS.FAILED, reason: "effectChanged" };
  await clearAuraEffects(item, { removeRegion: op.kind === "auraActivation" && !op.auraBefore?.active });
  await item.update({ [`flags.${MODULE_ID}.aura`]: foundry.data.operators.ForcedReplacement.create(op.auraBefore ?? { active: false }) });
  refreshAurasSoon();
  return { status: OP_STATUS.UNDONE };
}
export function auraRuleMatches(item, rule, event) {
  if (!auraDefinition(item)) return true;
  if (!auraActive(item)) return false;
  if (rule.require?.auraOption && item.flags[MODULE_ID].aura.option !== rule.require.auraOption) return false;
  const subject = fromUuidSync(event.subject?.tokenUuid ?? "");
  if (["damage.after", "ability.use"].includes(event.kind) && !auraRecipients(item, { filter: rule.filter, positions: event.positions }).some(t => t.uuid === subject?.uuid)) return false;
  // Psychic Pulse's end-of-turn damage: only in the turn (activation) in which the field was enlarged.
  if (rule.require?.auraSize && !(item.flags[MODULE_ID].aura.sizeBonus > 0 && item.flags[MODULE_ID].aura.sizeBonusActivation === event.activation)) return false;
  if (rule.require?.actionType && event.ability?.type !== rule.require.actionType) return false;
  if (rule.require?.costsMalice && !(event.ability?.malice > 0)) return false;
  if (rule.require?.strike && !event.ability?.keywords?.includes("strike")) return false;
  return true;
}
export async function prepareAuraSpecial(item, rule, event, tokens) {
  if (!rule.special?.startsWith("aura")) return { tokens, effects: rule.effects };
  if (rule.special === "auraGrow") {
    // effects[0] reports the growth, effects[1] a field that is not active (nothing changes then).
    const field = list(item.actor.items).find(i => i.system?._dsid === "null-field" && auraActive(i));
    if (field) await growAura(field, 1, { messageId: event.id ?? null });
    return { tokens, effects: [field ? rule.effects[0] : rule.effects[1]].filter(Boolean) };
  }
  const effects = rule.effects.map(e => ({ ...e }));
  if (rule.special === "auraJudgedDamage") {
    const token = tokens[0];
    if ((!event.forced && judgedBy(item, token)) || (item.system._dsid === "edict-of-disruptive-isolation" && list(token.parent.tokens).some(t => relation(token, t) === "enemy" && distanceSquares(token, t) <= 1))) {
      const roll = await new ds.rolls.DamageRoll("2d6").evaluate();
      effects[0].value = evaluateInt(effects[0].value, item) + roll.total;
    }
  }
  if (rule.special === "auraSouls") effects[0].ignoresStability = ["self", "ally"].includes(relation(fromUuidSync(item.flags[MODULE_ID].aura.tokenUuid), tokens[0]));
  if (rule.special === "auraRecovery") {
    const accepted = [];
    for (const t of tokens) if (t.actor.system?.recoveries?.value > 0 && (await askFeature(item, { id: rule.id, label: `${item.name}: ${t.name}` }, { promptActor: t.actor }))?.accepted) accepted.push(t);
    tokens = accepted;
  }
  return { tokens, effects };
}
export function registerAuras() {
  Hooks.on(HOOKS.resolved, (message, res) => schedule(async () => {
    res ??= message.flags?.[MODULE_ID]?.resolution;
    if (!isActiveGM() || !res || res.synthetic) return;
    const item = fromUuidSync(res?.abilityUuid ?? "");
    if (item && auraDefinition(item) && item.flags?.[MODULE_ID]?.aura?.sourceMessageId !== message.id) {
      const { before, state } = await setAura(item, true, { message });
      if (item.system._dsid === "riders-on-the-storm") {
        const choice = await askFeature(item, { id: "primordial", label: game.i18n.localize("DSAUTO.Aura.Primordial") }, { kind: "choice", choices: ["cold", "fire", "corruption", "lightning"].map(id => ({ id, name: game.i18n.localize(ds.CONFIG.damageTypes[id]?.label ?? id) })) });
        const type = choice?.ids?.[0];
        if (!["cold", "fire", "corruption", "lightning"].includes(type)) { await setAura(item, false); return; }
        await item.update({ [`flags.${MODULE_ID}.aura.damageType`]: type });
      }
      const token = fromUuidSync(state.tokenUuid), target = targetFromTokenDoc(token);
      await postRecordCard({ title: item.name, sourceActor: item.actor, abilityUuid: item.uuid, targets: { [target.key]: { ...target, self: true } }, user: game.user,
        ops: { active: { opId: "active", kind: "auraActivation", auraItemUuid: item.uuid, auraBefore: before, auraSourceMessageId: message.id, mode: "manual", status: "applied", targetKeys: [target.key], seq: 1 } } });
      if (item.system._dsid === "null-field" && game.combat?.combatant?.actor?.uuid === item.actor.uuid) await chooseNullOption(item);
    }
    const token = fromUuidSync(res?.sourceTokenUuid ?? "");
    if (!token || !item) return;
    const { runFeatureEvents } = await import("./engine.mjs");
    await runFeatureEvents([{ id: `${message.id}:aura-use`, kind: "ability.use", sceneId: token.parent.id,
      subject: { tokenUuid: token.uuid, actorUuid: item.actor.uuid }, source: { tokenUuid: token.uuid, actorUuid: item.actor.uuid },
      ability: { type: item.system.type, keywords: [...(item.system.keywords ?? [])], malice: item.actor.type === "npc" ? Number(item.system.resource) : 0 } }]);
  }));
  Hooks.on("deleteCombat", combat => schedule(async () => { for (const item of auraItems(combat.scene)) if (auraDefinition(item).end === "encounter") await setAura(item, false); }));
  Hooks.on("preUpdateToken", (token, changes, options) => {
    if (!isActiveGM() || !["x", "y", "elevation"].some(k => changes[k] != null)) return;
    options[MODULE_ID] ??= {};
    options[MODULE_ID].auraExits = auraItems(token.parent).filter(i => i.system._dsid === "edict-of-stillness" && auraRecipients(i, { filter: "enemies" }).some(t => t.uuid === token.uuid)).map(i => i.uuid);
  });
  Hooks.on("updateToken", (token, _changes, options) => schedule(async () => {
    if (!isActiveGM()) return;
    for (const uuid of options?.[MODULE_ID]?.auraExits ?? []) {
      const item = fromUuidSync(uuid);
      if (!auraActive(item) || auraRecipients(item, { filter: "enemies" }).some(t => t.uuid === token.uuid)) continue;
      const rule = automationFor(item, findOverlay(item)).rules.find(r => r.event === "aura.exit");
      const forced = !!options?.[MODULE_ID]?.internal || token.movementAction === "forced";
      await executeRule(item, rule, { id: `exit:${token.uuid}:${foundry.utils.randomID()}`, subject: { tokenUuid: token.uuid, actorUuid: token.actor.uuid }, forced, sceneId: token.parent.id });
    }
  }));
  for (const hook of ["createToken", "updateToken", "deleteToken", "canvasReady"]) Hooks.on(hook, refreshAurasSoon);
  Hooks.on("updateActor", (_actor, changes) => { if (changes.system?.stamina || changes["system.stamina.value"] != null || changes.statuses) refreshAurasSoon(); });
  Hooks.on("updateItem", (_item, changes) => { if (changes.flags?.[MODULE_ID]?.disabled != null || changes[`flags.${MODULE_ID}.disabled`] != null) refreshAurasSoon(); });
  Hooks.on("deleteItem", item => { if (auraDefinition(item)) schedule(() => clearAuraEffects(item, { removeRegion: true })); });
  Hooks.on("preUpdateActiveEffect", (_effect, changes) => { if (changes.disabled != null) refreshAurasSoon(); });
}

export async function expireAuraTurn(e) {
    if (!isActiveGM()) return;
    for (const item of auraItems(e.combatant?.token?.parent)) {
      if (item.actor.uuid !== e.actor?.uuid) continue;
      // Milestone 9: a Persistent use that extends holds its aura (persistent/registry.mjs): its turn start never ends
      // it (the upkeep decides), its turn end only until it was kept once.
      const state = item.flags[MODULE_ID].aura, end = auraDefinition(item).end, hold = holdsAura(item, e.combat);
      const next = e.activation !== state.activation, held = !!hold && (e.event === "turnStart" || hold.kept);
      if (!held && ((end === "sourceNextTurnStart" && e.event === "turnStart" && next) || (end === "sourceNextTurnEnd" && e.event === "turnEnd" && next))) await setAura(item, false);
      else if (item.system._dsid === "null-field" && e.event === "turnStart" && state.optionCredit) await item.update({ [`flags.${MODULE_ID}.aura.option`]: null, [`flags.${MODULE_ID}.aura.optionCredit`]: null, [`flags.${MODULE_ID}.aura.optionMessageId`]: null });
    }
    // Psychic Pulse: the size bonus ends at the start of the user's next turn, never at the end of the turn it was granted in.
    if (e.event === "turnStart") for (const item of auraItems(e.combatant?.token?.parent)) {
      const state = item.flags[MODULE_ID].aura;
      if (item.actor.uuid !== e.actor?.uuid || !(state.sizeBonus > 0) || e.activation === state.sizeBonusActivation) continue;
      await item.update({ [`flags.${MODULE_ID}.aura.sizeBonus`]: new foundry.data.operators.ForcedDeletion(), [`flags.${MODULE_ID}.aura.sizeBonusActivation`]: new foundry.data.operators.ForcedDeletion(), [`flags.${MODULE_ID}.aura.sizeBonusMessageId`]: new foundry.data.operators.ForcedDeletion() });
      await resizeAuraRegion(item);
    }
    await refreshAuras();
}


/** Negation is decided on the GM before any target operation lands. Follow-up damage stays on the same signed card. */
export async function prepareAuraInterception(message, res, ops, patches, registerCreated) {
  if (res.synthetic) return;
  const ability = fromUuidSync(res.abilityUuid ?? ""), source = fromUuidSync(res.sourceTokenUuid ?? "");
  if (!ability || !source) return;
  const fields = auraItems(source.parent);
  const peace = ["triggered", "freeTriggered"].includes(ability.system.type) && fields.find(i => i.system._dsid === "edict-of-peace" && auraRecipients(i, { filter: "enemies" }).some(t => t.uuid === source.uuid));
  const additions = [];
  const append = (field, token, amount, type, cause) => {
    const target = targetFromTokenDoc(token); res.targets[target.key] ??= target;
    const id = `aura-${cause}-${additions.length}`;
    if (res.ops[id]?.status === OP_STATUS.APPLIED) return;
    const op = { opId: id, kind: "damage", lib: true, amount, type, ignoredImmunities: [], aoe: false, targetKeys: [target.key], mode: "auto", status: "pending", order: 999, label: field.name, auraCauseOpId: cause };
    registerCreated(patches, op, { [target.key]: res.targets[target.key] }); res.ops[id] = op; additions.push(op);
  };
  if (peace) {
    for (const op of ops) if (!op.featureCost) op.auraNegated = true;
    append(peace, source, evaluateInt("@P", peace), "holy", ops[0]?.opId ?? "peace");
  } else if (ability.system.keywords?.has?.("ranged") || ability.system.keywords?.includes?.("ranged")) {
    const reflected = new Set();
    for (const op of ops) {
      const target = fromUuidSync(res.targets[op.targetKeys?.[0]]?.tokenUuid ?? "");
      if (!target) continue;
      const field = fields.find(i => i.system._dsid === "reflector-field" && relation(fromUuidSync(i.flags[MODULE_ID].aura.tokenUuid), source) === "enemy" && auraRecipients(i, { filter: "allies" }).some(t => t.uuid === target.uuid));
      if (!field || op.featureCost) continue;
      op.auraNegated = true;
      if (op.kind === "damage") { const src = opSource(message, op); if (src) append(field, source, Math.floor(src.total / 2), src.type, op.opId); }
      if (field.flags[MODULE_ID].aura.strained && !reflected.has(`${field.uuid}:${target.uuid}`)) {
        reflected.add(`${field.uuid}:${target.uuid}`);
        const roll = await new ds.rolls.DamageRoll("2d6").evaluate();
        append(field, fromUuidSync(field.flags[MODULE_ID].aura.tokenUuid), roll.total, "", op.opId);
      }
    }
  }
  ops.push(...additions);
}
