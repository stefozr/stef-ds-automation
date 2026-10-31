/** Limerick integration: native use, lifecycle, real prompt handlers and recovery commits. */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const paths = createRequire(import.meta.url)("./paths.cjs");
const imp = p => import(pathToFileURL(paths.SCRIPTS + p).href);
const { w, hero, gobA, gobB, token, scene, combat, feature, executeRule, featureRules, messages, getResolution, docs, wrappers } = await import("./harness12.mjs");
const { handleFeaturePrompt, featureEngineIdle, ruleTargets, runFeatureEvents } = await imp("features/engine.mjs");
const { routePrompt, registerPromptType } = await imp("relay/prompt-router.mjs");
const { featureAbilityUse } = await imp("features/capabilities.mjs");
const { activePerformances } = await imp("features/performance.mjs");
const { lifecycleIdle, resetActivations, registerLifecycle } = await imp("turn/lifecycle.mjs");
const { undoOps } = await imp("engine/engine.mjs");
const MOD = "stef-ds-automation";
w.setUser(w.users.gm);
foundry.helpers = { ActiveEffectRegistry: class { async refresh() {} } };
registerLifecycle();
for (const [i, actor] of [hero, gobA, gobB].entries()) {
  actor.effects.clear(); actor.items.clear(); actor.statuses.clear(); actor.flags = {};
  actor.system.stamina = { value: 10, max: 50, min: 0, temporary: 0 };
  actor.system.recoveries = { value: 3, max: 5, recoveryValue: 10 + i };
  docs[i].disposition = 1; docs[i].x = i * 100; docs[i].y = 100;
}
hero.getRollData = () => ({ M: 1, A: 1, R: 1, I: 1, P: 2 });
const limerick = feature("Revitalizing Limerick", hero, "ability", "revitalizing-limerick");
limerick.system.distance = { type: "aura", primary: 5 };
limerick.system.effects = { contents: [{ type: "dsct.flatHeal" }] };
game.modules.set("draw-steel-combat-tools", { active: true });
await game.settings.set(MOD, "libraryDefersToCombatTools", true);
await game.settings.set(MOD, "healingMode", "manual");
await game.settings.set(MOD, "modeByActorType", { hero: "manual", npc: "manual" });
await game.settings.set(MOD, "playerAuthoredMode", "manual");
assert.equal(featureRules(limerick).length, 0, "inactive performance has no turn-end rule");
assert.equal(await featureAbilityUse.call({ ...limerick.system, actor: hero, parent: limerick }, async () => null), null);
assert.equal(activePerformances(hero).length, 0, "cancelled native use does not activate");
await featureAbilityUse.call({ ...limerick.system, actor: hero, parent: limerick }, async () => ({ id: "native-use" }));
assert.deepEqual(activePerformances(hero), [limerick.uuid]);
assert.equal(hero.system.stamina.value, 10, "activation itself does not heal");

registerPromptType("featureRule", handleFeaturePrompt);
let selection = [token.uuid, docs[1].uuid], confirmation = true;
const dialogs = [], routed = [];
const fakeInputs = ids => ids.map(value => ({ value, checked: selection.includes(value), disabled: false, addEventListener() {} }));
foundry.applications.api.DialogV2.prompt = async options => {
  dialogs.push({ kind: "targets", options });
  const ids = [...options.content.matchAll(/value="([^"]+)"/g)].map(m => m[1]);
  const inputs = fakeInputs(ids), dialog = { element: { querySelectorAll: () => inputs }, async close() {} };
  options.render?.({}, dialog);
  const out = options.ok.callback({}, { form: { querySelectorAll: () => inputs.filter(i => i.checked) } });
  options.close?.({}, dialog);
  return out;
};
foundry.applications.api.DialogV2.confirm = async options => {
  dialogs.push({ kind: "recovery", options });
  if (confirmation instanceof Error) throw confirmation;
  return typeof confirmation === "function" ? confirmation(options) : confirmation;
};
const turnEnd = async () => {
  combat.combatant = combat.combatants.get("cb0"); combat.previous = { combatantId: "cb0" };
  const refresh = wrappers.get("foundry.helpers.ActiveEffectRegistry.prototype.refresh");
  await refresh(async () => {}, "turnStart", { combat }); await lifecycleIdle(); await featureEngineIdle();
  await refresh(async () => {}, "turnEnd", { combat }); await lifecycleIdle(); await featureEngineIdle();
};
resetActivations();
const cardCount = messages.size;
await turnEnd();
assert.equal(hero.system.stamina.value, 20); assert.equal(gobA.system.stamina.value, 21);
assert.equal(hero.system.recoveries.value, 2); assert.equal(gobA.system.recoveries.value, 2);
assert.equal(messages.size, cardCount + 2, "each recipient gets an independently applied card");
assert.match(dialogs[0].options.content, /limit.*2/);
assert.equal(dialogs.filter(d => d.kind === "recovery").length, 2);
assert.match(dialogs[1].options.content, /recoveries.*3/);
const refresh = wrappers.get("foundry.helpers.ActiveEffectRegistry.prototype.refresh");
await refresh(async () => {}, "turnEnd", { combat }); await lifecycleIdle(); await featureEngineIdle();
assert.equal(messages.size, cardCount + 2, "repeated end-turn signal cannot heal twice");
const lastCards = [...messages.values()].slice(-2);
for (const card of lastCards) await undoOps(card);
assert.equal(hero.system.stamina.value, 10); assert.equal(gobA.system.stamina.value, 10);
assert.equal(hero.system.recoveries.value, 3); assert.equal(gobA.system.recoveries.value, 3);
console.log("ok native activation, real lifecycle/dialog callbacks, DSCT coexistence, manual modes, duplicate events and Undo");

// Exercise owner query routing with the real router and handler, not canned answers.
game.users.filter = predicate => Object.values(w.users).filter(predicate);
hero.owners.add(w.users.player.id);
const oldQuery = w.users.player.query;
w.users.player.query = async (name, payload) => {
  routed.push({ userId: w.users.player.id, name, payload });
  return routePrompt(payload, { user: w.users.gm });
};
selection = [token.uuid];
await executeRule(limerick, featureRules(limerick)[0], { id: "owner-test", sceneId: scene.id });
assert.deepEqual(routed.map(r => r.payload.kind), ["targets", "recovery"]);
assert.equal(routed[1].payload.promptActorUuid, hero.uuid);
// Receiving player must own the offered creature; sender must be the active GM.
w.setUser(w.users.player);
assert.equal((await handleFeaturePrompt(routed[1].payload, { user: w.users.gm })).accepted, true);
w.setUser(w.users.player2);
await assert.rejects(handleFeaturePrompt(routed[1].payload, { user: w.users.gm }));
w.setUser(w.users.gm);
await assert.rejects(handleFeaturePrompt(routed[1].payload, { user: w.users.player }));
w.users.player.active = false;
const routedBefore = routed.length;
await executeRule(limerick, featureRules(limerick)[0], { id: "offline-test", sceneId: scene.id });
assert.equal(routed.length, routedBefore, "offline owner falls back to Director");
w.users.player.active = true; w.users.player.query = oldQuery;
delete game.users.filter;
console.log("ok owner selection/recovery routing, receiving ownership, sender authorization and offline Director fallback");

// A player who has not answered must not hold another player's accepted healing.
game.users.filter = predicate => Object.values(w.users).filter(predicate);
const originalType = gobA.type;
gobA.type = "hero"; gobA.owners.add(w.users.player2.id);
selection = [token.uuid, docs[1].uuid];
let release;
w.users.player.query = async (_name, payload) => routePrompt(payload, { user: w.users.gm });
const oldQuery2 = w.users.player2.query;
w.users.player2.query = async () => new Promise(resolve => { release = resolve; });
const startHp = hero.system.stamina.value, allyHp = gobA.system.stamina.value;
const independent = executeRule(limerick, featureRules(limerick)[0], { id: "independent-test", sceneId: scene.id });
await w.settle();
assert.equal(hero.system.stamina.value, startHp + 10);
assert.equal(gobA.system.stamina.value, allyHp);
release({ accepted: true }); await independent;
assert.equal(gobA.system.stamina.value, allyHp + 11);
await executeRule(limerick, featureRules(limerick)[0], { id: "independent-test", sceneId: scene.id });
assert.equal(gobA.system.stamina.value, allyHp + 11, "replayed event cannot repeat a spend");
w.users.player.query = oldQuery; w.users.player2.query = oldQuery2;
gobA.type = originalType; gobA.owners.delete(w.users.player2.id); delete game.users.filter;
selection = [token.uuid];
console.log("ok separate player responses commit independently and replay cannot spend twice");

// Run the real local dialog deadline, including its automatic close and late-answer rejection.
const nativeTimeout = globalThis.setTimeout, confirmDialog = foundry.applications.api.DialogV2.confirm;
globalThis.setTimeout = (fn, ms, ...args) => ms === 120_000 ? (queueMicrotask(fn), 0) : nativeTimeout(fn, ms, ...args);
foundry.applications.api.DialogV2.confirm = options => new Promise(resolve => {
  options.render({}, { async close() { options.close?.(); resolve(true); } });
});
const expired = await handleFeaturePrompt({ type: "featureRule", kind: "recovery", itemUuid: limerick.uuid, promptActorUuid: hero.uuid }, { user: w.users.gm });
assert.equal(expired.timedOut, true); assert.equal(expired.accepted, false);
globalThis.setTimeout = nativeTimeout; foundry.applications.api.DialogV2.confirm = confirmDialog;
console.log("ok real recovery dialog auto-closes and refuses answers after its deadline");

hero.system.recoveries.value = 3;
const before = hero.system.recoveries.value;
confirmation = false;
const declined = await executeRule(limerick, featureRules(limerick)[0], { id: "decline-test", sceneId: scene.id });
assert.equal(Object.values(declined.ops)[0].reason, "recoveryDeclined");
assert.equal(Object.values(declined.ops)[0].noApply, true);
confirmation = null;
await executeRule(limerick, featureRules(limerick)[0], { id: "closed-test", sceneId: scene.id });
assert.equal(hero.system.recoveries.value, before);
confirmation = new Error("connection lost");
const timeout = await executeRule(limerick, featureRules(limerick)[0], { id: "timeout-test", sceneId: scene.id });
assert.equal(Object.values(timeout.ops)[0].reason, "recoveryTimedOut");
confirmation = true;
hero.system.stamina.value = 50;
const full = await executeRule(limerick, featureRules(limerick)[0], { id: "full-test", sceneId: scene.id });
assert.equal(Object.values(full.ops)[0].reason, "nothingGained"); assert.equal(hero.system.recoveries.value, before);
hero.system.stamina.value = 47;
await executeRule(limerick, featureRules(limerick)[0], { id: "clamp-test", sceneId: scene.id });
assert.equal(hero.system.stamina.value, 50);
hero.system.stamina.value = 10; hero.system.recoveries.value = 0;
const empty = await executeRule(limerick, featureRules(limerick)[0], { id: "empty-test", sceneId: scene.id });
assert.equal(Object.values(empty.ops)[0].reason, "noRecoveries");
hero.system.recoveries.value = 3;
const modify = hero.modifyTokenAttribute;
hero.modifyTokenAttribute = async () => { throw new Error("healing veto"); };
const failed = await executeRule(limerick, featureRules(limerick)[0], { id: "failed-test", sceneId: scene.id });
assert.equal(Object.values(failed.ops)[0].status, "failed"); assert.equal(hero.system.recoveries.value, 3);
hero.modifyTokenAttribute = modify;
console.log("ok decline, closure, timeout, no Recoveries, full Stamina, clamping and failed-heal refund");

hero.getRollData = () => ({ P: 0 });
const dialogCount = dialogs.length;
assert.equal(await executeRule(limerick, featureRules(limerick)[0], { id: "zero-test", sceneId: scene.id }), null);
assert.equal(dialogs.length, dialogCount);
hero.getRollData = () => ({ P: 2 });
selection = [];
assert.equal(await executeRule(limerick, featureRules(limerick)[0], { id: "none-test", sceneId: scene.id }), null);
selection = docs.map(d => d.uuid);
await assert.rejects(executeRule(limerick, featureRules(limerick)[0], { id: "cap-test", sceneId: scene.id }));
docs[2].x = 1000;
assert.equal(ruleTargets(limerick, featureRules(limerick)[0], { sceneId: scene.id }).some(t => t.uuid === docs[2].uuid), false);
docs[2].x = 200; docs[2].disposition = -1;
assert.equal(ruleTargets(limerick, featureRules(limerick)[0], { sceneId: scene.id }).some(t => t.uuid === docs[2].uuid), false);
docs[2].disposition = 1;
const duplicate = { ...token, uuid: "Scene.duplicate.Token.hero", actor: hero };
scene.tokens.push(duplicate);
selection = [token.uuid];
await executeRule(limerick, featureRules(limerick)[0], { id: "dedupe-test", sceneId: scene.id });
assert.equal(dialogs.findLast(d => d.kind === "targets").options.content.match(/> Hero</g)?.length, 1);
scene.tokens.pop();
await game.settings.set(MOD, "healingMode", "off");
assert.equal(await executeRule(limerick, featureRules(limerick)[0], { id: "disabled-test", sceneId: scene.id }), null);
console.log("ok Presence zero, empty/over-limit choices, range, enemies, duplicate token creatures and disabled healing");

// Milestone 9 (WP-A): the real owner-side handlers with the mocked DialogV2.
{
  const { handleCleanseChoice } = await imp("ui/cleanse-choice.mjs");
  const { handleTargetPick } = await imp("ui/target-pick.mjs");
  const { handleTeleportStep } = await imp("ui/teleport-followup.mjs");
  const { targetFromTokenDoc } = await imp("engine/targets.mjs");
  const api = foundry.applications.api;
  const saved = { wait: api.DialogV2.wait, input: api.DialogV2.input, ux: foundry.applications.ux, canvas: globalThis.canvas, module: game.modules.get("draw-steel-combat-tools") };
  const waits = [], inputs = [];
  let formData = {}, inputData = {};
  foundry.applications.ux = { FormDataExtended: class { constructor(form) { this.object = form.data; } } };
  api.DialogV2.wait = async options => {
    waits.push(options);
    options.render?.({}, { close: async () => {}, rendered: false });
    return options.buttons[0].callback({}, { form: { data: formData } });
  };
  api.DialogV2.input = async options => {
    inputs.push(options);
    options.render?.({}, { close: async () => {}, rendered: false });
    return inputData;
  };
  const heroRec = targetFromTokenDoc(token), gobRec = targetFromTokenDoc(docs[1]);
  const record = ops => ({ resolvedAt: 1, abilityName: "M9 Test", sourceActorUuid: hero.uuid, sourceTokenUuid: token.uuid,
    targets: { [heroRec.key]: heroRec, [gobRec.key]: gobRec }, ops });
  const card = (id, ops) => {
    const m = { id, flags: { [MOD]: { resolution: record(ops) } } };
    messages.set(id, m);
    return m;
  };
  const gmUser = w.users.gm;
  // cleanseChoice: the creature's own effects among those the GM named, at most `count`.
  hero.effects.clear();
  await hero.createEmbeddedDocuments("ActiveEffect", [
    { _id: "m9heroSave000001", name: "Dazed", statuses: [], duration: { expiry: "save" } },
    { _id: "m9heroSave000002", name: "Slowed", statuses: [], duration: { expiry: "turnEnd" } },
  ]);
  card("m9cleanse0000001", { cl: { opId: "cl", kind: "cleanse", statuses: [], ends: ["save", "turn"], count: 1, targetKeys: [heroRec.key] } });
  const cPayload = { type: "cleanseChoice", messageId: "m9cleanse0000001", opId: "cl", actorUuid: hero.uuid, name: "Hero", count: 1,
    candidateIds: ["m9heroSave000001", "m9heroSave000002"], label: "Rain" };
  formData = { "e-m9heroSave000002": true };
  assert.deepEqual(await handleCleanseChoice(cPayload, { user: gmUser }), { effects: ["m9heroSave000002"] });
  assert.match(waits.at(-1).content, /Dazed/); assert.match(waits.at(-1).content, /Slowed/);
  assert.equal(waits.at(-1).buttons[0].label, "DSAUTO.Cleanse.PromptApply");
  formData = { "e-m9heroSave000001": true, "e-m9heroSave000002": true };
  assert.deepEqual(await handleCleanseChoice(cPayload, { user: gmUser }), { effects: [] }, "too many: nothing");
  formData = { "e-m9heroSave000002": true };
  assert.deepEqual(await handleCleanseChoice({ ...cPayload, candidateIds: ["m9heroSave000001"] }, { user: gmUser }), { effects: [] }, "only what the GM offered");
  await assert.rejects(handleCleanseChoice(cPayload, { user: w.users.player }), /Denied/, "only the active GM sends it");
  await assert.rejects(handleCleanseChoice({ ...cPayload, candidateIds: ["bad"] }, { user: gmUser }), /BadRequest/);
  await assert.rejects(handleCleanseChoice({ ...cPayload, count: 0 }, { user: gmUser }), /BadRequest/);
  // Live fix: on a card's first resolve the GM asks before the record is written; the payload's filters are used.
  const firstResolve = { ...cPayload, messageId: "m9cleanseNoRec01", statuses: [], ends: ["save", "turn"] };
  assert.deepEqual(await handleCleanseChoice(firstResolve, { user: gmUser }), { effects: ["m9heroSave000002"] }, "no record yet: payload filters");
  await assert.rejects(handleCleanseChoice({ ...cPayload, messageId: "m9cleanseNoRec01" }, { user: gmUser }), /BadRequest/, "no record, no filters");
  await assert.rejects(handleCleanseChoice({ ...firstResolve, ends: ["bad key!"] }, { user: gmUser }), /BadRequest/);
  // targetPick: the checkbox list (several or no Combat Tools picker) with the damage-type select.
  card("m9pick0000000001", { pk: { opId: "pk", kind: "pick", self: true, status: "pending", label: "Strike", targetKeys: [heroRec.key],
    pick: { effectId: "strike", count: 1, within: 10, of: "self", damageTypes: ["fire", "cold"], anchorTokenUuid: token.uuid } } });
  const pPayload = { type: "targetPick", messageId: "m9pick0000000001", opId: "pk", label: "Strike", count: 1,
    candidates: [{ tokenUuid: docs[1].uuid, name: "Goblin A", img: null }, { tokenUuid: docs[2].uuid, name: "Goblin B", img: null }], damageTypes: ["fire", "cold"] };
  formData = { "t-1": true, damageType: "cold" };
  assert.deepEqual(await handleTargetPick(pPayload, { user: gmUser }), { tokenUuids: [docs[2].uuid], damageType: "cold" });
  assert.match(waits.at(-1).content, /name="damageType"/);
  formData = { "t-0": true, "t-1": true, damageType: "cold" };
  assert.deepEqual(await handleTargetPick(pPayload, { user: gmUser }), { tokenUuids: [], damageType: null }, "too many");
  formData = { "t-0": true, damageType: "holy" };
  assert.deepEqual(await handleTargetPick(pPayload, { user: gmUser }), { tokenUuids: [], damageType: null }, "a type not offered");
  await assert.rejects(handleTargetPick({ ...pPayload, damageTypes: ["Fire!"] }, { user: gmUser }), /BadRequest/);
  await assert.rejects(handleTargetPick({ ...pPayload, count: 6 }, { user: gmUser }), /BadRequest/);
  await assert.rejects(handleTargetPick(pPayload, { user: w.users.player }), /Denied/);
  // One creature, all on this canvas: Combat Tools' token picker, then the damage type.
  globalThis.canvas = { ...(saved.canvas ?? {}), scene: { id: scene.id } };
  const savedObjects = [docs[1], docs[2]].map(d => [d, d.object]);
  for (const d of [docs[1], docs[2]]) d.object = { document: d };
  const picked = [];
  game.modules.set("draw-steel-combat-tools", { active: true, api: {
    async colorTokenPicker({ tokens }) { picked.push(tokens.length); return tokens[0]; },
    async teleport(opts) { picked.push(opts); },
  } });
  inputData = { damageType: "fire" };
  assert.deepEqual(await handleTargetPick(pPayload, { user: gmUser }), { tokenUuids: [docs[1].uuid], damageType: "fire" });
  assert.equal(picked[0], 2, "the picker highlights both candidates");
  // teleportStep with a boost: the number (at most what the mover has), then Combat Tools' teleport of distance + boost.
  const savedTokenObject = token.object;
  token.object = { document: token };
  hero.system.hero = { ...(hero.system.hero ?? {}), primary: { value: 2 } };
  card("m9tele000000001", { tp: { opId: "tp", kind: "teleport", status: "pending", distance: 3, selfMove: true, teleportMode: "normal", targetKeys: [heroRec.key],
    boost: { resource: "heroic", per: 1, max: null, label: "Extra" } } });
  inputData = { boost: 5 };
  assert.deepEqual(await handleTeleportStep({ type: "teleportStep", messageId: "m9tele000000001", opId: "tp", step: "teleport" }, { user: gmUser }), { picked: true, boost: 2 });
  assert.equal(picked.at(-1).distance, 5, "3 + 2 (capped at the 2 essence)");
  assert.match(inputs.at(-1).content, /max="2"/);
  inputData = {};
  assert.deepEqual(await handleTeleportStep({ type: "teleportStep", messageId: "m9tele000000001", opId: "tp", step: "teleport" }, { user: gmUser }), { picked: true, boost: 0 });
  assert.equal(picked.at(-1).distance, 3, "closed: no boost");
  token.object = savedTokenObject;
  for (const [d, o] of savedObjects) d.object = o;
  for (const id of ["m9cleanse0000001", "m9pick0000000001", "m9tele000000001"]) messages.delete(id);
  api.DialogV2.wait = saved.wait; api.DialogV2.input = saved.input; foundry.applications.ux = saved.ux; globalThis.canvas = saved.canvas;
  game.modules.set("draw-steel-combat-tools", saved.module);
  hero.effects.clear();
  console.log("ok M9 real handlers: cleanse choice, target pick (list and Combat Tools picker), teleport step with an essence boost");
}
console.log("ALL HARNESS-14 TESTS PASSED");
