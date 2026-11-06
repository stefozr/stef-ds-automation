/** Metakinetic Mastery (Null): thresholds on discipline (tracking on 1.2, value on 1.1), computed at use time. */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const paths = createRequire(import.meta.url)("./paths.cjs");
const imp = p => import(pathToFileURL(paths.SCRIPTS + p).href);
const { w, hero, gobA, combat, feature, scene, token } = await import("./harness12.mjs");
const { planGains } = await imp("resources/gains.mjs");
const { clearRuleCache } = await imp("resources/rules.mjs");
const { rollEdgesFor, forcedBonusFor, resourceLevel } = await imp("features/mastery.mjs");
const { registerFeatureCapabilities, featureAbilityUse } = await imp("features/capabilities.mjs");
const { buildForcedOp } = await imp("engine/plan.mjs");
const MOD = "stef-ds-automation";

w.setUser(w.users.gm);
hero.items.clear(); hero.effects.clear(); hero.flags = {};
hero.type = "hero";
hero.system.stamina = { value: 20, max: 50, min: 0, temporary: 0 };
hero.getRollData = () => ({ M: 1, A: 1, R: 1, I: 3, P: 2 });
feature("Metakinetic Mastery", hero, "feature", "metakinetic-mastery");
clearRuleCache();
const setDiscipline = (tracking, value = 1) => { hero.system.hero = { surges: 0, primary: { value, ...(tracking === undefined ? {} : { tracking }) } }; };

/* ---------- levels: tracking on 1.2, value on 1.1 ---------- */
setDiscipline(5, 2); assert.equal(resourceLevel(hero), 5, "tracking wins");
setDiscipline(undefined, 7); assert.equal(resourceLevel(hero), 7, "1.1 falls back to the value");

/* ---------- roll edges: only Grab and Knockback, 1 at 6, 2 at 10 (never 3) ---------- */
const edges = { 1: 0, 2: 0, 4: 0, 6: 1, 8: 1, 10: 2, 12: 2 };
for (const [d, n] of Object.entries(edges)) {
  setDiscipline(Number(d));
  assert.equal(rollEdgesFor(hero, "grab"), n, `grab edges at ${d}`);
  assert.equal(rollEdgesFor(hero, "knockback"), n, `knockback edges at ${d}`);
  assert.equal(rollEdgesFor(hero, "psychic-pulse"), 0, `other abilities get none at ${d}`);
}
setDiscipline(undefined, 6); assert.equal(rollEdgesFor(hero, "grab"), 1, "1.1 fallback edge");

/* the getActorModifiers wrapper adds them live (1.2 returns the modifiers object) */
const wrappers = new Map();
globalThis.libWrapper = { register(_m, target, fn) { wrappers.set(target, fn); } };
game.modules.set("lib-wrapper", { active: true });
CONFIG.Item = { dataModels: { ability: ds.data.Item.AbilityModel } };
registerFeatureCapabilities();
const modifiers = wrappers.get("CONFIG.Item.dataModels.ability.prototype.getActorModifiers");
const model = dsid => ({ actor: hero, _dsid: dsid });
for (const [d, n] of Object.entries(edges)) {
  setDiscipline(Number(d));
  assert.equal(modifiers.call(model("knockback"), () => ({ edges: 0, banes: 0 })).edges ?? 0, n, `wrapped knockback ${d}`);
  assert.equal(modifiers.call(model("shove"), () => ({ edges: 0, banes: 0 })).edges ?? 0, 0, `wrapped other ${d}`);
}
console.log("ok roll edges by threshold, per ability, live");

/* ---------- forced bonus: Knockback +@I from 2, every forced move +@I from 12, never doubled ---------- */
const evaluate = f => (f === "@I" ? 3 : null);
const bonus = { 1: [0, 0], 2: [3, 0], 4: [3, 0], 6: [3, 0], 10: [3, 0], 12: [3, 3] };
for (const [d, [kb, other]] of Object.entries(bonus)) {
  setDiscipline(Number(d));
  assert.equal(forcedBonusFor(hero, "knockback", evaluate), kb, `knockback bonus at ${d}`);
  assert.equal(forcedBonusFor(hero, "pull", evaluate), other, `other forced move at ${d}`);
}
const knock = feature("Knockback", hero, "ability", "knockback");
const forcedOf = async d => {
  setDiscipline(d);
  const op = buildForcedOp({ eff: { preId: "pre1", bonuses: {} }, td: { movements: ["push"], distance: "2", properties: [], potency: { characteristic: "", value: "" } },
    item: knock, actor: gobA, target: { partId: "p", tier: 2, potencies: {} }, key: "k", mode: "auto", sourceTokenUuid: null, spend: null, warnings: [] });
  return op.distances.push;
};
assert.equal(await forcedOf(1), 2, "no bonus at 1");
assert.equal(await forcedOf(2), 5, "Knockback +I at 2");
assert.equal(await forcedOf(12), 5, "12 replaces, not adds");
setDiscipline(12); knock.system._dsid = "grab";
assert.equal(await forcedOf(12), 5, "any forced move at 12");
setDiscipline(6); assert.equal(await forcedOf(6), 2, "other abilities at 6");
knock.system._dsid = "knockback";
console.log("ok forced distance bonus on the op (carried to Combat Tools moves)");

/* ---------- surge gains: once per round for damage OR forced move; 1 from 4, 2 from 8 ---------- */
const sceneId = scene.id;
const me = { actorUuid: hero.uuid, tokenUuid: token.uuid };
const damageFact = id => ({ kind: "damage", id, sceneId, takers: [me], dealer: { actorUuid: gobA.uuid, tokenUuid: null }, dealt: 3, type: "", surges: 0, opIds: [] });
const moveFact = id => ({ kind: "forcedMove", id, sceneId, mover: me, squares: 2, opIds: [] });
let round = 10;
const plan = facts => { combat.round = ++round; return planGains(facts, { origin: "card" }).ops.filter(o => o.gain.ruleKey.startsWith("metakinetic-mastery"));  };
for (const [d, n] of [[1, 0], [2, 0], [4, 1], [6, 1], [8, 2], [12, 2]]) {
  setDiscipline(d);
  const dmg = plan([damageFact(`d${d}`)]);
  assert.equal(dmg.length, n ? 1 : 0, `damage surge row at ${d}`);
  if (n) { assert.equal(dmg[0].amount, n); assert.equal(dmg[0].resource, "surge"); }
  const mv = plan([moveFact(`m${d}`)]);
  assert.equal(mv.length, n ? 1 : 0, `forced move surge row at ${d}`);
  if (n) assert.equal(mv[0].amount, n);
}
setDiscipline(undefined, 4);
assert.equal(plan([damageFact("fallback")]).length, 1, "1.1 value fallback");
// one slot per round for both events
setDiscipline(4); combat.round = ++round;
const both = planGains([damageFact("both-d"), moveFact("both-m")], { origin: "card" }).ops.filter(o => o.gain.ruleKey.startsWith("metakinetic-mastery"));
assert.equal(both.length, 1, "damage and forced move share the round's slot");
// "even if you resist the effect": a move stability cut to nothing still counts for this gain (includeResisted)
const resisted = plan([{ ...moveFact("resisted"), squares: 0, resisted: true }]);
assert.equal(resisted.length, 1, "resisted forced move still gives the surge");
const { matches } = await imp("resources/gains.mjs");
assert.equal(matches({ event: "forcedMove", taker: "self" }, { ...moveFact("r2"), squares: 0, resisted: true }, { actor: hero, tokenUuid: token.uuid, actorUuid: hero.uuid }), false, "other forcedMove gains ignore resisted moves");
console.log("ok surge rows by threshold, shared once per round");

/* ---------- use benefits and the Inertial Shield offer ---------- */
const created = [];
globalThis.ChatMessage = { getSpeaker: () => ({}), async create(data) { created.push(data); return { id: "offer" }; } };
const used = (dsid, category, type = "main") => featureAbilityUse.call({ _dsid: dsid, category, type, actor: hero, parent: feature(dsid, hero, "ability", dsid) }, async () => ({ id: "card", async update() {} }));
setDiscipline(10); hero.system.stamina.temporary = 0;
await used("fire-bolt", "heroic");
assert.equal(hero.system.stamina.temporary, 0, "no temporary Stamina below 12");
setDiscipline(12);
await used("fire-bolt", "signature");
assert.equal(hero.system.stamina.temporary, 0, "only heroic abilities");
await used("fire-bolt2", "heroic");
assert.equal(hero.system.stamina.temporary, 10, "10 temporary Stamina at 12");
hero.system.stamina.temporary = 15; await used("fire-bolt3", "heroic");
assert.equal(hero.system.stamina.temporary, 15, "temporary Stamina does not stack");
assert.equal(created.length, 0, "no offer without Inertial Shield");
setDiscipline(1);
await used("inertial-shield", "signature", "maneuver");
assert.equal(created.length, 1, "Inertial Shield offers Knockback");
assert.equal(created[0].flags[MOD].featureOffer.itemUuid, knock.uuid);
assert.equal(created[0].flags[MOD].featureOffer.free, "triggered");
console.log("ok heroic temporary Stamina and the Inertial Shield offer");
console.log("ALL HARNESS-25 TESTS PASSED");
