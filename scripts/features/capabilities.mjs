import { featureRules, frequencyKey } from "./engine.mjs";
import { requestOp } from "../relay/queries.mjs";
import { prepareAloneUse } from "./alone.mjs";
/** Active feature benefits participate in native ability checks and roll dialogs. */
import { MODULE_ID } from "../constants.mjs";
import { wrap } from "../compat/lib-wrapper.mjs";
import { setting } from "../settings.mjs";
import { currentActivation } from "../turn/lifecycle.mjs";
import { activePerformances, canPerform, isPerformance } from "./performance.mjs";
import { distanceSquares, relation, tokenOnScene } from "../triggers/eligibility.mjs";

const freeReactionActors = new Set();
const list = c => c?.contents ?? (c ? [...c] : []);
export function benefits(actor, type) {
  if (setting("enabled") === false) return [];
  return list(actor?.effects).filter(e => !e.disabled && !e.duration?.expired && e.flags?.[MODULE_ID]?.ruleEffect?.benefit === type && (type !== "moonlight" || moonlightInRange(actor, e)));
}
function moonlightInRange(actor, effect) {
  const item = fromUuidSync(effect.flags[MODULE_ID].ruleEffect.itemUuid ?? "");
  if (!item || !activePerformances(item.actor).includes(item.uuid) || !canPerform(item.actor)) return false;
  const scene = game.combat?.scene?.id ?? game.combat?.scene;
  const source = tokenOnScene(item.actor, scene), target = tokenOnScene(actor, scene);
  return !!source && !!target && distanceSquares(source, target) <= Number(item.system.distance?.primary ?? 5);
}
function actionCredit(actor) {
  const combat = game.combat;
  const c = list(combat?.combatants).find(c => c.actor?.uuid === actor.uuid);
  return `${combat?.id}:${combat?.round}:${c?.id}:${currentActivation(combat?.id, c?.id)?.n ?? combat?.turn}`;
}
export function hasBenefit(actor, type) { return benefits(actor, type).length > 0; }
export function radicalAvailable(actor, combat = game.combat) {
  return !!combat?.started && hasBenefit(actor, "radical") && actor.flags?.[MODULE_ID]?.radicalUsed !== `${combat.id}:${combat.round}`;
}
let radicalChain = Promise.resolve();
export function consumeRadical(actor, combat = game.combat) {
  const run = radicalChain.then(async () => {
    if (!radicalAvailable(actor, combat)) return false;
    await actor.update({ [`flags.${MODULE_ID}.radicalUsed`]: `${combat.id}:${combat.round}` });
    return true;
  });
  radicalChain = run.catch(() => {}); return run;
}

export function targetRestricted(ability, token) {
  const actor = ability.actor;
  if (!actor) return false;
  if (hasBenefit(actor, "entropy") && ["triggered", "freeTriggered"].includes(ability.type)) return true;
  if (hasBenefit(actor, "moonlight")) {
    if (["triggered", "freeTriggered"].includes(ability.type)) return true;
    if (actor.flags?.[MODULE_ID]?.moonlightAction === actionCredit(actor) && ["main", "maneuver"].includes(ability.type)) return true;
  }
  if (!ability.keywords?.has?.("strike")) return false;
  return benefits(actor, "sanctuary").some(e => e.flags[MODULE_ID].ruleEffect.sourceActorUuid === token?.actor?.uuid);
}

export async function clearSanctuaryOnHarm(event) {
  const source = event.source?.actorUuid;
  const harmed = event.subject?.actorUuid;
  if (!source || !harmed || !(event.damage?.finalAmount > 0 || event.damage?.amount > 0)) return;
  const harmedToken = event.subject?.tokenUuid ? fromUuidSync(event.subject.tokenUuid) : null;
  for (const c of game.combat?.combatants ?? []) for (const effect of benefits(c.actor, "sanctuary")) {
    if (effect.flags[MODULE_ID].ruleEffect.sourceActorUuid !== source) continue;
    const casterToken = c.token;
    if (c.actor.uuid === harmed || relation(casterToken, harmedToken) === "ally") await effect.delete();
  }
}

/** Used by the single ability-use wrapper registered alongside automatic areas. */
export async function featureAbilityUse(wrapped, config = {}, dialogOptions = {}, messageOptions = {}) {
  if (this.actor?.flags?.[MODULE_ID]?.moonlightChosen != null && this.actor.flags[MODULE_ID].moonlightChosen === game.combat?.id && !hasBenefit(this.actor, "moonlight")) {
    ui.notifications.warn(game.i18n.localize("DSAUTO.Feature.Restricted")); return null;
  }
  const chosen = list(game.user.targets).map(t => t.document);
  if (targetRestricted(this, chosen[0]) || chosen.some(t => targetRestricted(this, t))) {
    ui.notifications.warn(game.i18n.localize("DSAUTO.Feature.Restricted")); return null;
  }
  const repeated = featureRules(this.parent).some(rule => {
    if (!rule.activateOnUse) return false;
    const frequency = frequencyKey(rule, {});
    const used = rule.targets === "encounter" && this.category === "maliceAncestry" ? game.combat?.flags?.[MODULE_ID]?.encounterRuleUses?.[this._dsid] : this.parent.flags?.[MODULE_ID]?.ruleUses?.[rule.id];
    return frequency && used === frequency;
  });
  if (repeated) { ui.notifications.warn(game.i18n.localize("DSAUTO.Reason.featureAlreadyUsed")); return null; }
  let radicalCredit = null;
  if (this.type === "triggered" && radicalAvailable(this.actor) && await foundry.applications.api.DialogV2.confirm({ window: { title: this.parent.name }, content: `<p>${game.i18n.localize("DSAUTO.Feature.Radical")}</p>`, rejectClose: false })) radicalCredit = await requestOp({ action: "featureRadical", itemUuid: this.parent.uuid });
  if (radicalCredit?.ok === false) { ui.notifications.warn(game.i18n.localize("DSAUTO.Feature.Restricted")); return null; }
  const freeSearch = ["search", "dsct-search"].includes(this._dsid) && hasBenefit(this.actor, "concealment") && this.actor.flags?.[MODULE_ID]?.freeSearchUsed !== actionCredit(this.actor);
  const freeReaction = this.type === "triggered" && this.actor.flags?.[MODULE_ID]?.radicalCard?.itemUuid === this.parent.uuid && this.actor.flags[MODULE_ID].radicalCard.combatId === game.combat?.id && this.actor.flags[MODULE_ID].radicalCard.round === game.combat?.round && !this.actor.flags[MODULE_ID].radicalCard.used;
  if (freeReaction) freeReactionActors.add(this.actor.uuid);
  let result;
  try { result = await prepareAloneUse.call(this, wrapped, config, dialogOptions, messageOptions); }
  finally {
    freeReactionActors.delete(this.actor.uuid);
    if (!result && radicalCredit?.creditId) await requestOp({ action: "featureRadical", itemUuid: this.parent.uuid, cancel: true, creditId: radicalCredit.creditId });
  }
  if (result && freeReaction) { await result.update({ [`flags.${MODULE_ID}.freeTriggered`]: true }); await this.actor.update({ [`flags.${MODULE_ID}.radicalCard.used`]: true }); }
  if (result && freeSearch) {
    await this.actor.update({ [`flags.${MODULE_ID}.freeSearchUsed`]: actionCredit(this.actor) });
    await result.update({ [`flags.${MODULE_ID}.freeManeuver`]: true });
  }
  if (result && hasBenefit(this.actor, "moonlight") && ["main", "maneuver"].includes(this.type)) await this.actor.update({ [`flags.${MODULE_ID}.moonlightAction`]: actionCredit(this.actor) });
  if (result && this._dsid === "revitalizing-limerick" && setting("enabled") !== false && setting("libraryEnabled") !== false
    && !this.parent.flags?.[MODULE_ID]?.disabled && isPerformance(this.parent) && game.combat?.started && canPerform(this.actor)) {
    await requestOp({ action: "performanceSet", itemUuid: this.parent.uuid, active: true });
  }
  return result;
}

export function registerFeatureCapabilities() {
  wrap("CONFIG.Item.dataModels.ability.prototype.validTarget", function(wrapped, token) {
    return !targetRestricted(this, token) && wrapped(token);
  });
  wrap("CONFIG.Item.dataModels.ability.prototype.getActorModifiers", function(wrapped, options) {
    const result = wrapped(options);
    options.modifiers ??= {};
    if (hasBenefit(this.actor, "dying")) options.modifiers.edges = (options.modifiers.edges ?? 0) + 1;
    const auraKeys = new Set();
    for (const effect of list(this.actor?.effects)) {
      if (effect.disabled) continue;
      const auraKey = effect.flags?.[MODULE_ID]?.auraEffectKey;
      if (auraKey && auraKeys.has(auraKey)) continue;
      if (auraKey) auraKeys.add(auraKey);
      const info = effect.flags?.[MODULE_ID]?.ruleEffect;
      if (info?.property === "system.roll.edges") options.modifiers.edges = (options.modifiers.edges ?? 0) + Number(info.value);
      if (info?.property === "system.roll.banes") options.modifiers.banes = (options.modifiers.banes ?? 0) + Number(info.value);
      if (info?.property === "system.roll.bonuses") options.modifiers.bonuses = (options.modifiers.bonuses ?? 0) + Number(info.value);
    }
    return result;
  });
  wrap("CONFIG.Item.dataModels.ability.prototype.getTargetModifiers", function(wrapped, target) {
    const result = wrapped(target);
    if (hasBenefit(target?.actor, "targetBane")) result.banes = (result.banes ?? 0) + 1;
    return result;
  });
  wrap("ds.rolls.PowerRoll.getActorModifiers", function(wrapped, options) {
    const result = wrapped(options);
    if (hasBenefit(options.actor, "dying")) options.modifiers.edges = (options.modifiers.edges ?? 0) + 1;
    return result;
  });
  wrap("CONFIG.Token.movement.TerrainData.getMovementCostFunction", function(wrapped, token, options) {
    const cost = wrapped(token, options);
    if (!hasBenefit(token.actor, "radical")) return cost;
    return (from, to, distance, segment) => {
      const difficulty = segment?.terrain?.difficulty;
      if (Number.isFinite(difficulty) && difficulty > 1) return distance;
      return cost?.(from, to, distance, segment) ?? distance;
    };
  });
  for (const target of ["ds.data.Actor.HeroModel.prototype.spendRecovery", "ds.data.Actor.RetainerModel.prototype.spendRecovery"]) wrap(target, function(wrapped, ...args) {
    if (hasBenefit(this.parent, "moonlight")) { ui.notifications.warn(game.i18n.localize("DSAUTO.Feature.Restricted")); return null; }
    return wrapped(...args);
  }, "MIXED");
  Hooks.on("preUpdateActiveEffect", (effect, changes) => {
    if (changes.disabled === true && effect.flags?.["draw-steel-combat-tools"]?.effectType === "triggered-action" && (freeReactionActors.has(effect.parent?.uuid) || (effect.parent?.flags?.[MODULE_ID]?.radicalCard?.combatId === game.combat?.id && effect.parent.flags[MODULE_ID].radicalCard.round === game.combat?.round && !effect.parent.flags[MODULE_ID].radicalCard.used))) return false;
  });
  Hooks.on("preUpdateActor", (actor, changes, options) => {
    if (options?.[MODULE_ID]?.internal || !hasBenefit(actor, "moonlight")) return;
    const recoveries = changes["system.recoveries.value"] ?? changes.system?.recoveries?.value;
    if (recoveries != null && Number(recoveries) < actor.system.recoveries.value) return false;
  });
  // Combat Tools' pills are independent of native modifiers. Disable only the specific benefit's pill.
  Hooks.on("renderAbilityConfigurationDialog", app => {
    const item = app.item ?? app.options?.ability;
    const actor = item?.actor;
    const ignoreConcealment = hasBenefit(actor, "concealment");
    const ignoreCover = !!item?.flags?.[MODULE_ID]?.performanceAttack;
    if (!ignoreConcealment && !ignoreCover) return;
    const pills = app._dsctSources ?? app._dsctPills ?? app.dsctPills;
    for (const pill of Array.isArray(pills) ? pills : []) if ((ignoreConcealment && /concealment/i.test(pill.reason ?? pill.label ?? "")) || (ignoreCover && /cover/i.test(pill.reason ?? pill.label ?? ""))) {
      const button = app.element?.querySelector(`[data-pill-id="${pill.id}"]`);
      if (pill.enabled && button) button.click(); else pill.enabled = false;
    }
    for (const pill of app.element?.querySelectorAll?.('[data-pill-id]') ?? []) {
      const id = pill.dataset.pillId ?? "";
      if ((ignoreConcealment && id.includes("conc-")) || (ignoreCover && id.includes("cov-"))) {
        const toggle = pill.querySelector('input[type="checkbox"]');
        if (toggle?.checked) toggle.click();
      }
    }
  });
}
