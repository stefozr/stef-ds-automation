/** Routines: owner choices, persistent activation, and auras tied to performers. */
import { MODULE_ID } from "../constants.mjs";
import { isActiveGM } from "../engine/engine.mjs";
import { askFeature } from "./engine.mjs";
import { onRoundEvent } from "../turn/lifecycle.mjs";
import { findOverlay } from "../library/registry.mjs";
import { automationFor } from "../library/custom.mjs";
import { tokenOnScene } from "../triggers/eligibility.mjs";
import { zoneArea, zoneShapes } from "../zones/shapes.mjs";
import { evaluateInt } from "../library/formula.mjs";
import { error } from "../log.mjs";

const busy = new Set();
const roundChoices = new Map();
export const performanceRoundReady = (combat, round) => roundChoices.get(`${combat.id}:${round}`) ?? Promise.resolve();
const list = c => c?.contents ?? (c ? [...c] : []);
export const activePerformances = actor => actor.flags?.[MODULE_ID]?.performances?.items ?? [];
export function canPerform(actor) { return !["dazed", "dead", "surprised"].some(s => actor.statuses?.has(s)); }
export function isPerformance(item) { return !!automationFor(item, findOverlay(item))?.performance; }
export async function choosePerformances(actor, combat) {
  if (!isActiveGM() || busy.has(actor.uuid)) return;
  const routine = list(actor.items).find(i => i.system?._dsid === "routines" && !i.flags?.[MODULE_ID]?.disabled);
  if (!routine) return;
  busy.add(actor.uuid);
  try {
    if (!canPerform(actor)) return setPerformances(actor, [], combat);
    const items = list(actor.items).filter(i => isPerformance(i) && !i.flags?.[MODULE_ID]?.disabled);
    if (!items.length) return;
    const limit = list(actor.items).some(i => i.system?._dsid === "medley" && !i.flags?.[MODULE_ID]?.disabled) ? 2 : 1;
    const current = activePerformances(actor).filter(uuid => items.some(i => i.uuid === uuid));
    const choices = [{ id: "maintain", name: game.i18n.localize("DSAUTO.Feature.Maintain") }, { id: "stop", name: game.i18n.localize("DSAUTO.Feature.Stop") }, ...items.map(i => ({ id: i.uuid, name: i.name }))];
    const answer = await askFeature(routine, { id: "routines", label: game.i18n.localize("DSAUTO.Feature.ChoosePerformance") }, { kind: "performances", choices, limit });
    const ids = answer?.ids ?? [];
    const selected = ids.includes("stop") ? [] : ids.includes("maintain") || !ids.length ? current : ids.filter(id => items.some(i => i.uuid === id)).slice(0, limit);
    await setPerformances(actor, selected, combat);
  } finally { busy.delete(actor.uuid); }
}
export async function setPerformances(actor, items, combat) {
  if (actor.flags?.[MODULE_ID]?.performances?.combatId !== combat?.id) await actor.update({ [`flags.${MODULE_ID}.performanceTargets`]: {} });
  await actor.update({ [`flags.${MODULE_ID}.performances`]: { items, combatId: combat?.id ?? null, round: combat?.round ?? null } });
  await refreshPerformanceAuras(actor, combat);
}
export async function refreshPerformanceAuras(actor, combat = game.combat) {
  const source = tokenOnScene(actor, combat?.scene?.id ?? combat?.scene);
  if (!source) return;
  const scene = source.parent;
  const active = new Set(activePerformances(actor));
  for (const region of list(scene.regions)) {
    const info = region.flags?.[MODULE_ID]?.performanceAura;
    if (info?.actorUuid === actor.uuid && !active.has(info.itemUuid)) await region.delete();
  }
  for (const uuid of active) {
    const item = fromUuidSync(uuid);
    if (!item || item.system?.distance?.type !== "aura") continue;
    const area = zoneArea(item, { shape: "ability" }, v => evaluateInt(v, item));
    const shapes = zoneShapes(area, { scene, creatorDoc: source });
    // Performances targeting self include the performer's occupied space.
    if (item.system?.target?.type === "selfAlly") for (const s of shapes) if (s.base) s.base.hole = false;
    const prior = list(scene.regions).find(r => r.flags?.[MODULE_ID]?.performanceAura?.itemUuid === uuid && r.flags[MODULE_ID].performanceAura.actorUuid === actor.uuid);
    if (prior) await prior.update({ shapes });
    else await scene.createEmbeddedDocuments("Region", [{ name: item.name, shapes, color: game.user.color,
      visibility: CONST.REGION_VISIBILITY.ALWAYS, highlightMode: "coverage", displayMeasurements: true,
      flags: { [MODULE_ID]: { performanceAura: { actorUuid: actor.uuid, itemUuid: uuid, combatId: combat?.id } } } }]);
  }
}
export function registerPerformances() {
  onRoundEvent(e => {
    if (e.event !== "roundStart" || !isActiveGM()) return;
    const actors = new Map(list(e.combat.combatants).filter(c => c.actor).map(c => [c.actor.uuid, c.actor]));
    const run = (async () => { for (const actor of actors.values()) await choosePerformances(actor, e.combat); })();
    roundChoices.set(`${e.combat.id}:${e.round}`, run.catch(err => error("performance.choose", err)));
    if (roundChoices.size > 100) roundChoices.delete(roundChoices.keys().next().value);
    return run;
  });
  Hooks.once("ready", () => { if (isActiveGM()) for (const c of list(game.combat?.combatants)) if (activePerformances(c.actor ?? {}).length) refreshPerformanceAuras(c.actor).catch(e => error("performance.aura", e)); });
  Hooks.on("updateToken", token => {
    if (!isActiveGM() || !activePerformances(token.actor ?? {}).length) return;
    refreshPerformanceAuras(token.actor).catch(e => error("performance.aura", e));
  });
  Hooks.on("updateActor", actor => {
    if (isActiveGM() && activePerformances(actor).length && !canPerform(actor)) setPerformances(actor, [], game.combat).catch(e => error("performance.end", e));
  });
  Hooks.on("deleteItem", item => {
    if (isActiveGM() && item.actor && activePerformances(item.actor).includes(item.uuid)) setPerformances(item.actor, activePerformances(item.actor).filter(id => id !== item.uuid), game.combat).catch(e => error("performance.end", e));
  });
  Hooks.on("deleteToken", token => {
    if (!isActiveGM() || !token.actor) return;
    if (tokenOnScene(token.actor, token.parent.id)) return refreshPerformanceAuras(token.actor).catch(e => error("performance.aura", e));
    for (const region of list(token.parent.regions)) if (region.flags?.[MODULE_ID]?.performanceAura?.actorUuid === token.actor.uuid) region.delete().catch(e => error("performance.end", e));
  });
  Hooks.on("deleteCombat", combat => {
    if (!isActiveGM()) return;
    for (const c of list(combat.combatants)) if (c.actor?.flags?.[MODULE_ID]?.performances?.combatId === combat.id) setPerformances(c.actor, [], combat).catch(e => error("performance.end", e));
  });
}
