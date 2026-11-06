/** Draw Steel 1.2 adaptations: per-target surge wrap, companion surges and recoveries, damage origin fallback. */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const paths = createRequire(import.meta.url)("./paths.cjs");
const imp = p => import(pathToFileURL(paths.SCRIPTS + p).href);
const { w, hero, gobA, registry, combat, feature, scene } = await import("./harness12.mjs");
const { registerNativeSurgeTracking, nativeSurgeActor } = await imp("ui/surge-choice.mjs");
const { registerFeatureCapabilities } = await imp("features/capabilities.mjs");
const { externalSource } = await imp("triggers/external.mjs");
const MOD = "stef-ds-automation";

/** A recording libWrapper (the earlier harnesses' registrations are not ours to repeat). */
const wrappers = new Map();
globalThis.libWrapper = { register(_m, target, fn) { wrappers.set(target, fn); } };
game.modules.set("lib-wrapper", { active: true });
const parts = "ds.data.pseudoDocuments.messageParts";
const surgeTargets = part => [`${parts}.${part}.prototype.modifyDamageDialog`, `${parts}.${part}.prototype.createModifiedDamageRoll`];

/* ---------- TargetResult surge wrap: present on a 1.2 mock, absent on a 1.1 mock ---------- */
{
  class Part { async modifyDamageDialog(roll) { return roll; } async createModifiedDamageRoll(roll) { return roll; } }
  ds.data.pseudoDocuments = { messageParts: { AbilityResult: class extends Part {}, TargetResult: class extends Part {} } };
  wrappers.clear();
  registerNativeSurgeTracking();
  for (const t of [...surgeTargets("AbilityResult"), ...surgeTargets("TargetResult")]) assert.ok(wrappers.has(t), `1.2 wraps ${t}`);
  assert.equal(wrappers.get(surgeTargets("AbilityResult")[0]), wrappers.get(surgeTargets("TargetResult")[0]), "the handler is shared");

  delete ds.data.pseudoDocuments.messageParts.TargetResult;
  wrappers.clear();
  registerNativeSurgeTracking();
  assert.ok(wrappers.has(surgeTargets("AbilityResult")[0]) && wrappers.has(surgeTargets("AbilityResult")[1]), "1.1 keeps the AbilityResult wrap");
  for (const t of surgeTargets("TargetResult")) assert.ok(!wrappers.has(t), `1.1 has no ${t}`);
  console.log("ok TargetResult surge wrap present on 1.2, absent on 1.1");
}

/* ---------- companion surges map to the master (retainer to the mentor) ---------- */
{
  const master = { type: "hero", system: { hero: { surges: 2 } } };
  const mentor = { type: "hero", system: { hero: { surges: 1 } } };
  const companion = { type: "companion", system: { companion: { master } } };
  const retainer = { type: "retainer", system: { retainer: { mentor } } };
  assert.equal(nativeSurgeActor(companion), master);
  assert.equal(nativeSurgeActor(retainer), mentor);
  assert.equal(nativeSurgeActor(hero), hero);
  assert.equal(nativeSurgeActor({ type: "companion", system: { companion: {} } }), undefined, "a companion without a master");

  // The spend a native dialog makes on the master's surges is counted on the roll.
  class Part {
    get ability() { return { actor: companion }; }
    async modifyDamageDialog() {}
    async createModifiedDamageRoll() {}
  }
  ds.data.pseudoDocuments = { messageParts: { AbilityResult: Part, TargetResult: class extends Part {} } };
  wrappers.clear();
  registerNativeSurgeTracking();
  for (const part of ["AbilityResult", "TargetResult"]) {
    const [dialog, create] = surgeTargets(part).map(t => wrappers.get(t));
    const instance = new ds.data.pseudoDocuments.messageParts[part]();
    master.system.hero.surges = 2;
    let seen = null;
    await dialog.call(instance, async () => { master.system.hero.surges = 1; await create.call(instance, async roll => { seen = roll.options.dsAutoNativeSurges; return roll; }, { options: {} }); });
    assert.equal(seen, 1, `${part}: the companion's master spent one surge`);
  }
  console.log("ok companion surges are the master's");
}

/* ---------- external damage: the system's origin is the fallback source ---------- */
{
  const a = "Actor.speaker0000000001", t = "Scene.s.Token.speaker0000001", b = "Actor.dsbl00000000001", u = "Scene.s.Token.dsbl0000000001";
  assert.deepEqual(externalSource({ origin: { actorUuid: a, tokenUuid: t, messageId: "m" } }), { actorUuid: a, tokenUuid: t }, "origin alone");
  assert.deepEqual(externalSource({ dsbl: { source: { actorUuid: b, tokenUuid: u } }, origin: { actorUuid: a, tokenUuid: t } }), { actorUuid: b, tokenUuid: u }, "Battle Log wins");
  assert.deepEqual(externalSource({ dsbl: { source: { tokenUuid: u } }, origin: { actorUuid: a, tokenUuid: t } }), { actorUuid: a, tokenUuid: u }, "each uuid falls back on its own");
  assert.deepEqual(externalSource({ origin: { actorUuid: null, tokenUuid: 5 } }), { actorUuid: null, tokenUuid: null }, "invalid uuids are dropped");
  assert.deepEqual(externalSource({}), { actorUuid: null, tokenUuid: null });
  assert.deepEqual(externalSource(undefined), { actorUuid: null, tokenUuid: null });
  console.log("ok external damage source falls back on the system's origin");
}

/* ---------- moonlight blocks Recoveries of a companion too ---------- */
{
  class Model { constructor(parent) { this.parent = parent; } async spendRecovery() { return "spent"; } }
  ds.data.Actor = { ...ds.data.Actor, HeroModel: class extends Model {}, RetainerModel: class extends Model {}, CompanionModel: class extends Model {} };
  CONFIG.Item = { dataModels: { ability: ds.data.Item.AbilityModel } };
  wrappers.clear();
  registerFeatureCapabilities();
  const target = "ds.data.Actor.CompanionModel.prototype.spendRecovery";
  assert.ok(wrappers.has(target), "the companion's spendRecovery is wrapped");

  // A performer (the hero) whose moonlight performance covers the companion's actor (Goblin A, one square away).
  const song = feature("Moonlit Song", hero, "ability", "moonlit-song");
  song.system.distance = { type: "aura", primary: 5 };
  hero.flags[MOD] = { performances: { items: [song.uuid] } };
  gobA.effects.set("moon", { id: "moon", disabled: false, duration: {}, flags: { [MOD]: { ruleEffect: { benefit: "moonlight", itemUuid: song.uuid } } } });
  w.setCombat(combat);
  const warnings = [];
  const warn = ui.notifications.warn;
  ui.notifications.warn = m => warnings.push(m);
  let called = false;
  const blocked = await wrappers.get(target).call(new Model(gobA), async () => { called = true; return "spent"; });
  ui.notifications.warn = warn;
  assert.equal(blocked, null);
  assert.equal(called, false, "moonlight blocks the companion's recovery");
  assert.equal(warnings.length, 1);

  // Without the benefit the call goes through, and arguments are forwarded.
  gobA.effects.clear();
  assert.equal(await wrappers.get(target).call(new Model(gobA), async (...args) => `spent:${args.join()}`, 1), "spent:1");
  console.log("ok companion Recovery restricted by moonlight");
}
console.log("ALL HARNESS-20 TESTS PASSED");
