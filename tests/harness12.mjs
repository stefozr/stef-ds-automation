/** Generic features, areas, presets, frequency claims and performance benefits. */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const paths = createRequire(import.meta.url)("./paths.cjs");
const imp = p => import(pathToFileURL(paths.SCRIPTS + p).href);
globalThis.__HARNESS_SKIP_SCENARIOS__ = true;
const dialogs = [];
let accept = true;
const wrappers = new Map();
const registrationAttempts = [];
globalThis.__HARNESS_SETUP__ = () => {
  globalThis.CONST = { REGION_VISIBILITY: { ALWAYS: 1 }, DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 }, TOKEN_DISPOSITIONS: { FRIENDLY: 1, HOSTILE: -1 }, GRID_TYPES: { SQUARE: 1 } };
  game.modules.set("lib-wrapper", { active: true });
  globalThis.libWrapper = { register(_m, target, fn) {
    registrationAttempts.push(target);
    if (wrappers.has(target)) throw new Error(`Duplicate wrapper: ${target}`);
    wrappers.set(target, fn);
  } };
  foundry.utils.escapeHTML = s => s;
  foundry.utils.setProperty = (o, k, v) => { const parts = k.split("."); for (const p of parts.slice(0, -1)) o = o[p] ??= {}; o[parts.at(-1)] = v; };
  foundry.applications ??= { api: {} };
  foundry.applications.api.DialogV2 = { async confirm(opts) { dialogs.push(opts); return accept; }, async prompt() { return []; } };
  ds.utils.evaluateFormula = (formula, data) => {
    const src = String(formula).replace(/@([A-Za-z_][A-Za-z0-9_.]*)/g, (_, k) => Number(k.split(".").reduce((o, p) => o?.[p], data)));
    if (!/^[\d\s+*/().,\-]+$/.test(src.replace(/max|min|floor|ceil|abs|round/g, ""))) throw new Error("Bad formula");
    return Function("max", "min", "floor", "ceil", "abs", "round", `return (${src})`)(Math.max, Math.min, Math.floor, Math.ceil, Math.abs, Math.round);
  };
  CONFIG.ActiveEffect.documentClass = { getEffectStart: () => ({}) };
};
const w = await import("./harness.mjs");
const { hero, gobA, gobB, tA, tB, registry, api, Effect, addToken, setCombat, messages, getResolution, makeAbility, postAbility } = w;
const { validateAutomation, saveAutomation, presets, savePreset, applyPreset, deletePreset, presetDraft } = await imp("library/custom.mjs");
const { executeRule, featureRules, ruleTargets, runFeatureEvents } = await imp("features/engine.mjs");
const { undoOps, applyOps } = await imp("engine/engine.mjs");
const { prepareStrikeBonuses } = await imp("features/strike.mjs");
const { areaUse, registerAutomaticAreas, repairAutomaticAuraRegions, removeAutomaticAuraRegions } = await imp("engine/areas.mjs");
const { setPerformances, activePerformances, refreshPerformanceAuras } = await imp("features/performance.mjs");
const { hasBenefit, targetRestricted, radicalAvailable, registerFeatureCapabilities } = await imp("features/capabilities.mjs");
const { removeTemporaryResources, trackTemporaryResource } = await imp("features/temporary-resources.mjs");
globalThis.ChatMessage = {
  getSpeaker: ({ actor }) => ({ actor: actor?.id }),
  getSpeakerActor: () => hero,
  async create(data) {
    const msg = new w.Message({ type: "standard", parts: data.system.parts, flags: data.flags, speaker: data.speaker });
    msg.author = game.user; messages.set(msg.id, msg); Hooks.callAll("createChatMessage", msg); return msg;
  },
};
const library = (await import(pathToFileURL(paths.LIBRARY + "/dist/overlays.mjs"))).default;
assert.equal(api.library.registerSource({ id: "features-test", overlays: library }).accepted, 175);
class Coll extends Map { get contents() { return [...this.values()]; } [Symbol.iterator]() { return this.values(); } find(fn) { return this.contents.find(fn); } }
Effect.prototype.delete = async function() { this.parent.effects.delete(this.id); };
const put = (o, key, value) => { const parts = key.split("."); for (const p of parts.slice(0, -1)) o = o[p] ??= {}; if (value instanceof foundry.data.operators.ForcedDeletion) delete o[parts.at(-1)]; else o[parts.at(-1)] = structuredClone(value); };
const token = addToken("hero000000000tok", hero, "Hero").document;
const docs = [token, tA.document, tB.document];
const scene = { id: "scene00000000001", grid: { size: 100, distance: 1, type: 1 }, tokens: docs, regions: new Coll(), async createEmbeddedDocuments(type, data) {
  assert.equal(type, "Region"); return data.map(d => { const r = { ...structuredClone(d), id: foundry.utils.randomID(), parent: this, async update(p) { Object.assign(this, p); }, async delete() { scene.regions.delete(this.id); } }; this.regions.set(r.id, r); return r; });
} };
for (const [i, doc] of docs.entries()) { Object.assign(doc, { x: i * 100, y: 100, width: 1, height: 1, parent: scene, disposition: i ? -1 : 1 }); doc.actor.items = new Coll(); doc.actor.flags = {}; doc.actor.getRollData = () => ({ M: 3, A: 1, R: 2, I: 1, P: 2 }); doc.actor.getActiveTokens = () => [doc]; doc.actor.token = doc; doc.actor.system.hero = { surges: 0, primary: { value: 3 } }; doc.actor.system.keywords = new Set(i ? ["goblin"] : ["human"]); }
hero.getRollData = () => ({ M: 3, A: 1, R: 2, I: 1, P: 2 });
game.scenes.get = id => id === scene.id ? scene : null;
const placeables = docs.map(document => { const t = { id: document.id, document, actor: document.actor }; document.object = t; document.testInsideRegion = () => document.actor !== hero; return t; });
globalThis.canvas = { ready: true, scene, tokens: { placeables, setTargets(ids) { game.user.targets = new Set(placeables.filter(t => ids.includes(t.id))); } } };
const combatants = new Coll(docs.map((doc, i) => { const c = { id: `cb${i}`, actor: doc.actor, token: doc, parent: null, isDefeated: false, async update(p) { this.isDefeated = p.defeated; } }; return [c.id, c]; }));
const combat = { id: "fight", uuid: "Combat.fight", flags: {}, round: 1, turn: 0, started: true, scene, combatants, combatant: combatants.get("cb0"), async update(p) { for (const [k, v] of Object.entries(p)) put(this, k, v); }, getCombatantsByActor(a) { return combatants.contents.filter(c => c.actor === a); } };
setCombat(combat); game.combats.get = id => id === combat.id ? combat : null;
for (const c of combatants) c.parent = combat;
for (const actor of [hero, gobA, gobB]) actor.update = async function(p, options = {}) { if (Hooks.call("preUpdateActor", this, p, options) === false) return this; for (const [k, v] of Object.entries(p)) put(this, k, v); return this; };
let itemId = 0;
function feature(name, actor = hero, type = "feature", dsid = name.toLowerCase().replace(/ /g, "-")) {
  const id = `feature${++itemId}`; const item = { uuid: `${actor.uuid}.Item.${id}`, name, type, actor, isOwner: true, flags: {}, system: { _dsid: dsid }, getRollData: () => actor.getRollData(), async update(p) { for (const [k, v] of Object.entries(p)) put(this, k, v); return this; } };
  actor.items.set(id, item); registry.set(item.uuid, item); return item;
}
const auto = rules => ({ version: 1, rules });
const rule = (effects, extra = {}) => ({ id: "rule", event: "use", targets: "targets", effects, ...extra });
const resource = { id: "surge", type: "resource", resource: "surge", value: "2" };
assert.equal(validateAutomation(auto([rule([resource])])).ok, true);
for (const bad of [auto([rule([{ id: "bad", type: "modifier", key: "system.ownership", value: "1" }])]), auto([rule([resource], { range: "random()" })]), auto([rule([resource], { require: { unknown: true } })])]) assert.equal(validateAutomation(bad).ok, false);
const custom = feature("Homebrew");
await saveAutomation(custom, auto([rule([resource], { targets: "self" })]));
const saved = await savePreset("My feature", custom.flags["stef-ds-automation"].automation);
const copy = feature("Copy"); await applyPreset(copy, saved.id);
assert.notEqual(copy.flags["stef-ds-automation"].automation.rules[0].id, "rule");
copy.flags["stef-ds-automation"].automation.rules[0].effects[0].value = "99";
assert.equal(presets()[0].automation.rules[0].effects[0].value, "2");
await deletePreset(saved.id); assert.equal(presets().length, 0);
const configured = { ...auto([rule([{ ...resource, value: "@config.n" }])]), config: { n: 3 } };
const appended = presetDraft(configured, { ...configured, config: { n: 9 } }, { append: true });
assert.equal(appended.config.n, 9);
assert.notEqual(appended.rules[1].effects[0].value, "@config.n");
assert.equal(validateAutomation(appended).ok, true);
console.log("ok validated generic authoring and independent presets");

const mixed = rule([{ id: "hit", type: "damage", value: "5", damageType: "fire", tiers: [2] }, { ...resource, targets: "self" }]);
await saveAutomation(custom, auto([mixed]));
const targets = { [tA.document.uuid.replaceAll(".", "__")]: { tier: 2 } };
const before = gobA.system.stamina.value;
const result = await executeRule(custom, mixed, { id: "custom-use", targetDocs: [tA.document], targetRecords: targets, sceneId: scene.id });
assert.equal(gobA.system.stamina.value, before - 3, "tier-gated damage uses native immunity");
assert.equal(hero.system.hero.surges, 2, "self resource goes to the user");
assert.equal(gobA.system.hero.surges, 0);
await undoOps(messages.get(result.messageId));
assert.equal(gobA.system.stamina.value, before); assert.equal(hero.system.hero.surges, 0);
const selfOnly = rule([{ ...resource, targets: "self" }]);
const selfResult = await executeRule(custom, selfOnly, { targetDocs: [], sceneId: scene.id });
assert.ok(selfResult); assert.equal(hero.system.hero.surges, 2);
console.log("ok generic target tiers, self effects, native mitigation and Undo");

const limited = rule([resource], { targets: "self", once: "round" });
await saveAutomation(custom, auto([limited]));
const first = await executeRule(custom, limited, { sceneId: scene.id });
assert.equal(await executeRule(custom, limited, { sceneId: scene.id }), null);
await undoOps(messages.get(first.messageId));
assert.ok(await executeRule(custom, limited, { sceneId: scene.id }), "Undo releases the frequency claim");
console.log("ok frequency claims, duplicate rejection and Undo release");

const speed = { id: "speed", type: "modifier", key: "system.movement.value", value: "2", mode: "add" };
const modeRule = rule([speed], { event: "turn.start", targets: "encounter", keywords: ["goblin"], require: { subjectKeyword: "goblin" }, optional: true, cost: 3, once: "round", end: "roundEnd" });
for (const actor of [gobA, gobB]) { const i = feature("Goblin Mode", actor, "ability"); i.system.category = "maliceAncestry"; await saveAutomation(i, auto([modeRule])); }
await game.settings.set("draw-steel", "malice", { value: 5 });
let count = dialogs.length;
accept = false;
await runFeatureEvents([{ id: "decline-mode", kind: "turn.start", sceneId: scene.id, subject: { actorUuid: gobA.uuid, tokenUuid: tA.document.uuid } }]);
assert.equal(dialogs.length, count + 1, "one shared prompt on decline");
accept = true;
await runFeatureEvents([{ id: "accept-mode", kind: "turn.start", sceneId: scene.id, subject: { actorUuid: gobA.uuid, tokenUuid: tA.document.uuid } }]);
assert.equal(game.settings.get("draw-steel", "malice").value, 2);
assert.equal(gobA.effects.contents.filter(e => e.system?.changes?.[0]?.key === speed.key).length, 1);
assert.equal(gobB.effects.contents.filter(e => e.system?.changes?.[0]?.key === speed.key).length, 1);
await runFeatureEvents([{ id: "accept-mode", kind: "turn.start", sceneId: scene.id, subject: { actorUuid: gobA.uuid, tokenUuid: tA.document.uuid } }]);
assert.equal(game.settings.get("draw-steel", "malice").value, 2);
console.log("ok shared Goblin Mode prompt, Malice cost and encounter recipients");

const goblinCard = [...messages.values()].findLast(m => getResolution(m)?.featureItemUuid && Object.values(getResolution(m).ops).some(o => o.featureCost));
const paid = game.settings.get("draw-steel", "malice").value;
await undoOps(goblinCard);
assert.equal(game.settings.get("draw-steel", "malice").value, paid + 3);
assert.equal(gobA.effects.size, 0); assert.equal(gobB.effects.size, 0);
const protect = feature("Protected modifier");
const modResult = await executeRule(protect, rule([speed], { targets: "self" }), { sceneId: scene.id });
const modMessage = messages.get(modResult.messageId);
const modifier = hero.effects.contents.find(e => e.origin === protect.uuid);
await modifier.update({ "system.changes.0.value": 9 });
await undoOps(modMessage);
assert.equal(hero.effects.has(modifier.id), true, "Undo preserves a modified effect");
console.log("ok feature cost refund and conservative modifier Undo");

const ward = feature("Ward of Delightful Consequences", hero, "feature", "ward-of-delightful-consequences");
assert.equal(featureRules(ward).length, 1);
const wr = featureRules(ward)[0];
const wrResult = await executeRule(ward, wr, { sceneId: scene.id, subject: { actorUuid: hero.uuid, tokenUuid: token.uuid }, source: { actorUuid: gobA.uuid, tokenUuid: tA.document.uuid } });
assert.ok(wrResult);
const tail = feature("Barbed Tail", hero, "ancestryTrait", "barbed-tail");
assert.equal(featureRules(tail).length, 1);
const strike = makeAbility({ uuid: `${hero.uuid}.Item.strike`, name: "Strike", actor: hero });
strike.system.keywords = new Set(["melee", "strike"]);
const msg = postAbility(strike, { 2: [tA] }, { 2: [{ total: 10, options: { type: "fire" } }] });
await new Promise(resolve => setTimeout(resolve, 100));
const hit = Object.values(getResolution(msg).ops).find(o => o.kind === "damage");
assert.equal(hit.featureBonus?.amount, 3);
assert.equal(hit.finalAmount, 11, "extra strike damage added before immunity");
console.log("ok installed Ward and Barbed Tail integration");

hero.effects.clear();
const choreo = feature("Choreography", hero, "ability", "choreography");
choreo.system.distance = { type: "aura", primary: "5" }; choreo.system.target = { type: "selfAlly" };
assert.equal(featureRules(choreo).length, 0, "inactive performances do not fire");
await setPerformances(hero, [choreo.uuid], combat);
assert.deepEqual(activePerformances(hero), [choreo.uuid]);
assert.equal(featureRules(choreo).length, 1);
assert.equal(scene.regions.size, 1);
const aura = scene.regions.contents[0];
token.x = 300; await refreshPerformanceAuras(hero);
assert.equal(aura.shapes[0].base.x, 300);
assert.equal(aura.shapes[0].base.hole, false);
hero.statuses.add("dazed"); assert.equal(featureRules(choreo).length, 0); hero.statuses.delete("dazed");
await setPerformances(hero, [], combat); assert.equal(scene.regions.size, 0);
console.log("ok performance activation, exclusions and moving auras");

hero.system.hero.primary.value = 7;
await trackTemporaryResource(hero, { id: "spotlight" }, { opId: "grant", featureEnd: "turnEnd" }, 1);
await hero.update({ "system.hero.primary.value": 6 });
await removeTemporaryResources(hero);
assert.equal(hero.system.hero.primary.value, 6, "spent temporary point is not subtracted twice");
await trackTemporaryResource(hero, { id: "spotlight2" }, { opId: "grant", featureEnd: "turnEnd" }, 1);
await removeTemporaryResources(hero);
assert.equal(hero.system.hero.primary.value, 5, "unspent temporary point expires");
console.log("ok temporary resource spending and expiry");

Object.assign(CONST, { REGION_VISIBILITY: { ALWAYS: 1 }, DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 } });
const arixx = { parent: { uuid: "Item.dirtdevil", name: "Dirt Devil", flags: {} }, actor: hero, hasTemplate: true, target: { type: "creature" }, distance: { type: "burst", primary: "3" }, validTarget: d => d.actor !== hero };
arixx.parent.system = arixx;
await game.settings.set("stef-ds-automation", "automaticAreas", true);
let rolled = 0;
await areaUse.call(arixx, async () => { rolled++; assert.deepEqual([...game.user.targets].map(t => t.id), [tA.document.id, tB.document.id]); return { id: "area-card" }; });
assert.equal(rolled, 1); assert.equal(scene.regions.contents[0].shapes[0].base.x, token.x);
const beforeRegions = scene.regions.size;
await areaUse.call(arixx, async () => null);
assert.equal(scene.regions.size, beforeRegions, "cancelled use removes the new area");
console.log("ok Dirt Devil centered template and targets before rolling");

const nullArea = { ...arixx, parent: { uuid: "Item.null-area-regression", name: "Null Field", flags: {}, actor: hero }, distance: { type: "aura", primary: "2" } };
nullArea.parent.system = nullArea;
registry.set(nullArea.parent.uuid, nullArea.parent);
const beforeAuraRegions = scene.regions.size;
await areaUse.call(nullArea, async () => ({ id: "null-area-card" }));
const attachedArea = scene.regions.contents.find(r => r.flags?.["draw-steel"]?.abilitySource === nullArea.parent.uuid);
assert.equal(attachedArea.attachment.token, token.id, "automatic aura uses the native token attachment");
assert.equal(attachedArea.flags["stef-ds-automation"].auraArea, true);
assert.equal(attachedArea.flags["draw-steel-combat-tools"].aura, true);
await areaUse.call(nullArea, async () => ({ id: "null-area-again" }));
assert.equal(scene.regions.size, beforeAuraRegions + 1, "repeat use reuses the attached aura");
await areaUse.call(nullArea, async () => null);
assert.equal(scene.regions.size, beforeAuraRegions + 1, "cancelling reuse never deletes the active aura");
const oldScenes = game.scenes.contents;
game.scenes.contents = [scene];
const [legacyArea] = await scene.createEmbeddedDocuments("Region", [{ name: "Null Field", shapes: attachedArea.shapes, flags: { "draw-steel": { abilitySource: nullArea.parent.uuid }, "stef-ds-automation": { instantaneousArea: true } } }]);
await repairAutomaticAuraRegions();
assert.equal(scene.regions.has(legacyArea.id), false, "legacy static duplicate is removed when an attached aura exists");
assert.equal(scene.regions.has(attachedArea.id), true);
const [unrelated] = await scene.createEmbeddedDocuments("Region", [{ flags: { "draw-steel": { abilitySource: arixx.parent.uuid }, "stef-ds-automation": { instantaneousArea: true } } }]);
await repairAutomaticAuraRegions();
assert.equal(scene.regions.has(unrelated.id), true, "burst templates are not migrated");
await unrelated.delete();
console.log("ok automatic aura attachment, reuse, cancellation and legacy duplicate cleanup");


// Exercise the init/ready registration sequence with libWrapper's one-target-per-module rule.
const abilityPrototype = ds.data.Item.AbilityModel.prototype;
Object.assign(abilityPrototype, { use() {}, placeTemplate() {}, validTarget() { return true; }, getActorModifiers() {} });
CONFIG.Item = { dataModels: { ability: ds.data.Item.AbilityModel } };
registerAutomaticAreas();
registerFeatureCapabilities();
const templateWrapper = wrappers.get("CONFIG.Item.dataModels.ability.prototype.placeTemplate");
let duplicatePlaced = false;
const placedAura = await templateWrapper.call(nullArea, async () => { duplicatePlaced = true; });
assert.equal(placedAura, attachedArea);
assert.equal(duplicatePlaced, false, "chat Place Template reuses the attached aura");
scene.deleteEmbeddedDocuments = async (_type, ids) => { for (const id of ids) await scene.regions.get(id)?.delete(); };
await removeAutomaticAuraRegions(nullArea.parent);
assert.equal(scene.regions.has(attachedArea.id), false, "stopping removes the automatic aura visual");
const [orphanedAura] = await scene.createEmbeddedDocuments("Region", [{ shapes: [], flags: { "draw-steel": { abilitySource: nullArea.parent.uuid }, "stef-ds-automation": { instantaneousArea: true } } }]);
await repairAutomaticAuraRegions();
assert.equal(orphanedAura["attachment.token"], token.id, "a lone legacy static aura is attached to its caster");
assert.equal(orphanedAura["flags.stef-ds-automation.auraArea"], true);
assert.equal(orphanedAura["flags.stef-ds-automation.instantaneousArea"], false);
assert.equal(orphanedAura.shapes[0].base.x, token.x, "repair centers the aura on the current caster position");
await orphanedAura.delete();
game.scenes.contents = oldScenes;

const useTarget = "CONFIG.Item.dataModels.ability.prototype.use";
assert.equal(registrationAttempts.filter(target => target === useTarget).length, 1, "init and ready register ability use only once");
const useWrapper = wrappers.get(useTarget);
const config = { regression: true }, dialogOptions = {}, messageOptions = {};
const priorRegions = scene.regions.size;
await useWrapper.call(arixx, async (...args) => {
  assert.deepEqual(args, [config, dialogOptions, messageOptions]);
  assert.deepEqual([...game.user.targets].map(t => t.id), [tA.document.id, tB.document.id]);
  return { id: "combined-area-card" };
}, config, dialogOptions, messageOptions);
assert.equal(scene.regions.size, priorRegions + 1, "combined wrapper still prepares centered areas");
hero.flags["stef-ds-automation"].moonlightChosen = combat.id;
let forbiddenUse = false;
assert.equal(await useWrapper.call(arixx, async () => { forbiddenUse = true; }), null);
assert.equal(forbiddenUse, false, "feature restriction prevents native use");
assert.equal(scene.regions.size, priorRegions + 1, "feature restriction prevents template creation");
delete hero.flags["stef-ds-automation"].moonlightChosen;
console.log("ok single libWrapper registration preserves feature restrictions and area targeting");
console.log("ALL HARNESS-12 TESTS PASSED");

export { w, hero, gobA, gobB, token, scene, combat, feature, rule, resource, executeRule, featureRules, registry, messages, getResolution, docs, Coll, put, placeables, wrappers };
