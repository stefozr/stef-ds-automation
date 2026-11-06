/** Ward of Nature's Affection engine path (multi-target card, squads, back-to-back batches) and Psychic Pulse / Null Field. */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const paths = createRequire(import.meta.url)("./paths.cjs");
const imp = p => import(pathToFileURL(paths.SCRIPTS + p).href);
const { w, hero, gobA, gobB, token, scene, combat, feature, executeRule, featureRules, messages, getResolution, docs, Coll, put, placeables, wrappers } = await import("./harness12.mjs");
const { Actor, addToken, registry, makeAbility, postAbility, Squad, tA, tB } = w;
const { featureEngineIdle } = await imp("features/engine.mjs");
const { setAura, auraRadius } = await imp("features/auras.mjs");
const { registerPromptType } = await imp("relay/prompt-router.mjs");
const { handleFeaturePrompt } = await imp("features/engine.mjs");
const { lifecycleIdle, resetActivations, registerLifecycle } = await imp("turn/lifecycle.mjs");
const { zoneArea, zoneShapes } = await imp("zones/shapes.mjs");
const MOD = "stef-ds-automation";
const sleep = (ms = 60) => new Promise(r => setTimeout(r, ms));
w.setUser(w.users.gm);
foundry.helpers = { ActiveEffectRegistry: class { async refresh() {} } };
registerLifecycle();
registerPromptType("featureRule", handleFeaturePrompt);
registerPromptType("movementChoice", async () => ({ declined: true }));
foundry.data.operators.ForcedReplacement ??= { create: value => structuredClone(value) };
for (const a of [hero, gobA, gobB]) { a.effects.clear(); a.statuses.clear(); a.flags = {}; a.items.clear(); a.system.stamina = { value: 40, max: 40, min: -10, temporary: 0 }; }
await game.settings.set(MOD, "libraryDefersToCombatTools", false);
await game.settings.set(MOD, "forcedMovementMode", "manual");
await game.settings.set(MOD, "modeConditionNpc", "auto");
game.scenes.contents = [scene];
hero.getRollData = () => ({ M: 3, A: 1, R: 2, I: 3, P: 2 });

/** A further token on the harness scene, wired like harness12's. */
let n = 0;
function mkToken(name, x, extra = {}) {
  const L = "CDEFGH"[n++];
  const actor = new Actor({ uuid: `Scene.${scene.id}.Token.tok${L}000000000001.Actor.extra0000000000${L}`, name, stamina: 40, ...extra });
  registry.set(actor.uuid, actor);
  const { document: doc } = addToken(`tok${L}000000000001`, actor, name);
  Object.assign(doc, { x, y: 100, width: 1, height: 1, parent: scene, disposition: -1 });
  Object.assign(actor, { token: doc, items: new Coll(), flags: {}, getRollData: () => ({ M: 3, A: 1, R: 2, I: 1, P: 2 }), getActiveTokens: () => [doc] });
  actor.system.hero = { surges: 0, primary: { value: 3 } }; actor.system.keywords = new Set(["goblin"]);
  actor.update = async function(p) { for (const [k, v] of Object.entries(p)) put(this, k, v); return this; };
  docs.push(doc);
  const placeable = { id: doc.id, document: doc, actor }; doc.object = placeable; doc.testInsideRegion = () => true; placeables.push(placeable);
  const cb = { id: `cb${docs.length - 1}`, actor, token: doc, parent: combat, isDefeated: false, async update() {} };
  combat.combatants.set(cb.id, cb);
  return { actor, doc };
}
const C = mkToken("Goblin C", 300);

/* ---------------- Ward of Nature's Affection: engine path ---------------- */
// Library overlays apply to heroes (NPCs need an explicit opt-in): the Conduit is a hero.
gobA.type = "hero";
const ward = feature("Ward of Nature's Affection", gobA, "feature", "ward-of-natures-affection");
assert.equal(featureRules(ward).length, 1);
const wardFeature = rule => rule.event === "damage.after";
assert.ok(wardFeature(featureRules(ward)[0]));
const dialogs = []; let gate = null;
foundry.applications.api.DialogV2.confirm = async options => { dialogs.push(options); if (gate) await gate; return true; };
const wardCards = () => [...messages.values()].filter(m => getResolution(m)?.featureItemUuid === ward.uuid);
const strike = (name, actor = hero) => makeAbility({ uuid: `${actor.uuid}.Item.${name.replace(/ /g, "")}`, name, actor });
const hit = (item, targets, opts) => postAbility(item, { 2: targets }, { 2: [{ total: 4, options: { type: "psychic" } }] }, opts);

// 1. Conduit (gobA) is the 2nd of 3 targets: exactly one offer.
hit(strike("Sweeping Blow"), [tB, tA, C.doc.object ? { actor: C.actor, document: C.doc } : null].filter(Boolean));
await sleep(150); await featureEngineIdle();
assert.equal(dialogs.length, 1, "one ward offer for the 2nd of 3 targets");
assert.equal(wardCards().length, 1);
assert.equal(gobA.system.stamina.value, 36); assert.equal(gobB.system.stamina.value, 36); assert.equal(C.actor.system.stamina.value, 36);
console.log("ok ward: one offer when the Conduit is the 2nd of 3 targets");

// 2. A squad as co-target and a minion (squad) as the source.
const m1 = mkToken("Minion 1", 400, { minion: true, stamina: 5 }), m2 = mkToken("Minion 2", 500, { minion: true, stamina: 5 });
new Squad(`Scene.${scene.id}.CombatantGroup.squad00000000001`, "Wolves", [m1.actor, m2.actor]);
dialogs.length = 0;
hit(strike("Pack Attack"), [tB, tA, { actor: m1.actor, document: m1.doc }, { actor: m2.actor, document: m2.doc }]);
await sleep(150); await featureEngineIdle();
assert.equal(dialogs.length, 1, "squad co-targets do not hide or duplicate the offer");
dialogs.length = 0;
const gobBItem = strike("Minion Swarm", m1.actor);
hit(gobBItem, [tA], { forge: res => { res.sourceTokenUuid = m1.doc.uuid; res.sourceActorUuid = m1.actor.uuid; } });
await sleep(150); await featureEngineIdle();
assert.equal(dialogs.length, 0, "minion source at x=400 is outside the ward range (diagnosable, no offer)");
m1.doc.x = 200;
hit(strike("Minion Swarm 2", m1.actor), [tA], { forge: res => { res.sourceTokenUuid = m1.doc.uuid; res.sourceActorUuid = m1.actor.uuid; } });
await sleep(150); await featureEngineIdle();
assert.equal(dialogs.length, 1, "a minion source in range gets its offer");
console.log("ok ward: squad co-target and squad source");

// 3. Back-to-back batches: the second arrives while the first prompt is open; both offer.
dialogs.length = 0;
let open; gate = new Promise(r => { open = r; });
hit(strike("First"), [tA]);
await sleep(80);
hit(strike("Second"), [tA]);
await sleep(80);
assert.equal(dialogs.length, 1, "first offer is open, the second queues");
gate = null; open(); await sleep(150); await featureEngineIdle();
assert.equal(dialogs.length, 2, "the queued second batch is offered too (not dropped)");
console.log("ok ward: two batches back-to-back both offer");

// 4. Missing source token: no offer, a debug line says why.
await game.settings.set(MOD, "debug", true);
const logged = []; const oldDebug = console.debug; console.debug = (...a) => logged.push(a);
dialogs.length = 0;
await executeRule(ward, featureRules(ward)[0], { id: "ghost-event", kind: "damage.after", sceneId: scene.id, subject: { actorUuid: gobA.uuid, tokenUuid: tA.document.uuid }, source: { actorUuid: hero.uuid, tokenUuid: "Scene.otherscene000001.Token.ghost00000000001" } });
await sleep(150); await featureEngineIdle();
console.debug = oldDebug;
assert.equal(dialogs.length, 0);
assert.ok(logged.some(a => a[1] === "feature.skip" && a[2].why === "noEligibleToken"), "debug log for the skipped rule");
await game.settings.set(MOD, "debug", false);
console.log("ok ward: skipped for a missing source token, logged");

// 5. 1.2.0 (live): an external hit nobody held (system / ctlib per-target Apply) carries the source the requester
// reported (externalSource: dsbl or Draw Steel 1.2's options.origin); before, it had an unknown source and the ward
// (require.sourceWithin) was skipped silently.
{
  const { externalDone } = await imp("triggers/holds.mjs");
  dialogs.length = 0;
  const now = { value: gobA.system.stamina.value, temporary: gobA.system.stamina.temporary ?? 0 };
  const heroTokenUuid = token?.document?.uuid ?? token?.uuid;
  await externalDone({ applied: true, actorUuid: gobA.uuid, tokenUuid: tA.document.uuid, before: { value: now.value + 3, temporary: now.temporary },
    after: now, source: { actorUuid: hero.uuid, tokenUuid: heroTokenUuid }, reportOnly: false }, w.users.gm);
  await sleep(200); await featureEngineIdle();
  assert.equal(dialogs.length, 1, "an unheld external hit with a reported source offers the ward");
  dialogs.length = 0;
  await externalDone({ applied: true, actorUuid: gobA.uuid, tokenUuid: tA.document.uuid, before: { value: now.value + 3, temporary: now.temporary },
    after: now, source: { actorUuid: null, tokenUuid: "Scene.otherscene000001.Token.ghost00000000001" }, reportOnly: false }, w.users.gm);
  await sleep(200); await featureEngineIdle();
  assert.equal(dialogs.length, 0, "an unresolvable reported source stays unknown (no offer)");
  console.log("ok ward: unheld external hit uses the reported source");
}
gobA.items.clear(); gobA.type = "npc";

/* ---------------- Psychic Pulse / Null Field ---------------- */
gobA.system.stamina.value = 40; gobB.system.stamina.value = 40;
token.x = 0; tA.document.x = 100; tB.document.x = 200; m1.doc.x = 800; m2.doc.x = 900;
const field = feature("Null Field", hero, "ability", "null-field"); field.system.distance = { primary: 1, type: "aura" };
field.effects = new Map([["0OMzJvPqF11x4lcj", { clone() { return { toObject: () => ({ name: "Dampen", type: "abilityModifier", system: { changes: [{ key: "potency", value: 1, type: "subtract", phase: "initial" }] } }) }; } }]]);
const pulse = feature("Psychic Pulse", hero, "ability", "psychic-pulse");
const aura = () => field.flags[MOD]?.aura;
const dampened = a => a.effects.contents.some(e => e.origin === field.uuid);
await setAura(field, true);
const [region] = await scene.createEmbeddedDocuments("Region", [{ attachment: { token: token.id }, shapes: zoneShapes(zoneArea(field, { shape: "ability" }, v => Number(v)), { scene, creatorDoc: token }),
  flags: { "draw-steel": { abilitySource: field.uuid }, [MOD]: { auraArea: true } } }]);
assert.equal(auraRadius(field), 1); assert.ok(dampened(gobA)); assert.ok(!dampened(gobB));
const radiusPx = () => region.shapes[0].radius;
assert.equal(radiusPx(), 100);

// The overlay carries its own damage effect next to its "grow" rule: the rule must not replace the effect.
const { resolveAbility } = await imp("library/resolve.mjs");
const { editableAutomation, saveAutomation, validateAutomation } = await imp("library/custom.mjs");
assert.deepEqual(resolveAbility(pulse).effects.map(e => e.id), ["pulse"], "overlay rules do not drop the overlay effects");
assert.equal(resolveAbility(pulse).layer, "overlay");
{
  // Opening the overlay in the editor keeps the effects as an on-use rule, next to the overlay's own rules.
  const draft = editableAutomation(pulse, resolveAbility(pulse));
  assert.deepEqual(draft.rules.map(r => r.id), ["on-use", "grow"]);
  assert.deepEqual(draft.rules[0].effects.map(e => e.id), ["pulse"]);
  assert.equal(validateAutomation(draft).ok, true);
  // Saving it as an item flag keeps the damage (the flag now owns every effect, as for effect-only overlays).
  const copy = feature("Psychic Pulse", gobA, "ability", "psychic-pulse"); gobA.type = "hero";
  await saveAutomation(copy, draft);
  const saved = resolveAbility(copy);
  assert.equal(saved.layer, "detached");
  assert.deepEqual(copy.flags[MOD].automation.rules[0].effects.map(e => e.id), ["pulse"], "saved flag keeps the effects");
  gobA.items.clear(); gobA.type = "npc";
}
console.log("ok Pulse: overlay effects survive its own rules and the editor save");

const turn= async event => {
  combat.combatant = combat.combatants.get("cb0"); combat.previous = { combatantId: "cb0" };
  await wrappers.get("foundry.helpers.ActiveEffectRegistry.prototype.refresh")(async () => {}, event, { combat });
  await lifecycleIdle(); await featureEngineIdle();
};
const usePulse = async id => {
  Hooks.callAll("dsAuto.resolved", { id, flags: {} }, { abilityUuid: pulse.uuid, sourceTokenUuid: token.uuid, targets: {}, ops: {} });
  await sleep(60); await featureEngineIdle();
};
const pulseCards = () => [...messages.values()].filter(m => getResolution(m)?.featureItemUuid === field.uuid && getResolution(m)?.featureRuleId === "pulse");
resetActivations();
await turn("turnStart");
await usePulse("pulse-use-1");
assert.equal(aura().sizeBonus, 1); assert.equal(auraRadius(field), 2, "radius = primary + 1");
assert.equal(radiusPx(), 200, "region redrawn");
assert.ok(dampened(gobB), "recipients refreshed: Goblin B now inside");
await turn("turnEnd");
assert.equal(aura().sizeBonus, 1, "not cleared at the end of the current turn");
assert.equal(pulseCards().length, 1, "one end-of-turn card");
assert.equal(gobA.system.stamina.value, 37); assert.equal(gobB.system.stamina.value, 37);
assert.equal(hero.system.stamina.value, 40, "only enemies take it");
await turn("turnEnd");
assert.equal(pulseCards().length, 1, "once per activation");
await turn("turnStart");
assert.equal(aura().sizeBonus, undefined, "cleared at the next turn start");
assert.equal(auraRadius(field), 1); assert.equal(radiusPx(), 100);
assert.ok(!dampened(gobB), "Goblin B left the field again");
await turn("turnEnd");
assert.equal(pulseCards().length, 1, "no damage on an activation without a Pulse");
assert.equal(gobA.system.stamina.value, 37);
console.log("ok Pulse: radius before/after/next turn start, end-of-turn damage once to enemies inside only");

// A corpse inside the field takes no end-of-turn damage row.
{
  const dead = mkToken("Dead Minion", 150, { minion: true, stamina: 5 });
  dead.actor.system.stamina.value = 0; dead.actor.statuses = new Set(["dead", "dying"]);
  await turn("turnStart");
  await usePulse("pulse-use-dead");
  const cards = pulseCards().length;
  const hp = [gobA.system.stamina.value, gobB.system.stamina.value];
  await turn("turnEnd");
  assert.equal(pulseCards().length, cards + 1, "the pulse still fires for the living");
  assert.equal(gobA.system.stamina.value, hp[0] - 3); assert.equal(gobB.system.stamina.value, hp[1] - 3);
  assert.equal(dead.actor.system.stamina.value, 0, "no damage to the dead");
  const card = pulseCards().at(-1);
  assert.ok(!Object.values(getResolution(card).ops).some(o => (o.targetKeys ?? []).some(k => k.includes(dead.doc.id))), "no row for the dead");
  combat.combatants.delete(`cb${docs.indexOf(dead.doc)}`);
  await turn("turnStart");
  console.log("ok Pulse: end-of-turn pulse skips dead creatures in the field");
}

// Null Field inactive: nothing changes, the card says so.
await setAura(field, false);
const before = messages.size, cardsBefore = pulseCards().length, hpB = gobB.system.stamina.value;
await usePulse("pulse-use-2");
assert.equal(aura()?.sizeBonus, undefined); assert.equal(auraRadius(field), 1);
assert.ok(messages.size > before, "a note card is posted");
await turn("turnStart"); await turn("turnEnd");
assert.equal(pulseCards().length, cardsBefore); assert.equal(gobB.system.stamina.value, hpB);
console.log("ok Pulse: inactive Null Field changes nothing");

// Engine level: a no-power-roll Psychic Pulse card with a seeded enemy plans the overlay's damage row (2 x Intuition).
{
  const { targetFromTokenDoc } = await imp("engine/targets.mjs");
  const ally = mkToken("Ally", 150); ally.doc.disposition = token.disposition;
  const card = w.makeAbility({ uuid: `${hero.uuid}.Item.pulseCard`, name: "Psychic Pulse", actor: hero, damage: false });
  card.system.power.roll = { enabled: false }; card.getRollData = () => hero.getRollData();
  gobB.system.stamina.value = 40;
  const msg = w.postAbility(card, {}, {}, { forge: res => { for (const d of [tB.document, ally.doc]) { const t = targetFromTokenDoc(d); res.targets[t.key] = t; } } });
  await sleep(150); await featureEngineIdle();
  const res = getResolution(msg);
  const ops = Object.values(res.ops).filter(o => o.libEffect === "pulse");
  assert.equal(ops.length, 1, "one damage op");
  assert.equal(ops[0].amount, 6, "2 x Intuition 3");
  assert.deepEqual(Object.keys(res.targets), [targetFromTokenDoc(tB.document).key], "the enemy keeps its record, the ally gets none");
  assert.equal(gobB.system.stamina.value, 34);
  console.log("ok Pulse: no-power-roll card plans the overlay damage for the enemy only");
}
console.log("ALL HARNESS-24 TESTS PASSED");
