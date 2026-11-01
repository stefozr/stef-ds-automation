/**
 * 1.1.1: feature-card moves go to the hero's player (stepRecipient), `when.alliesNearTarget`, `pick.flanking`
 * (You Were Watching the Wrong One).
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const paths = createRequire(import.meta.url)("./paths.cjs");
const imp = p => import(pathToFileURL(paths.SCRIPTS + p).href);
globalThis.__HARNESS_SKIP_SCENARIOS__ = true;
const w = await import("./harness.mjs");
const { Actor, registry, users } = w;
const { stepRecipient } = await imp("ui/teleport-followup.mjs");
const { alliesNear, isFlanking, flankingAllies } = await imp("engine/proximity.mjs");
const { libraryOps } = await imp("engine/library-plan.mjs");
const { targetFromTokenDoc } = await imp("engine/targets.mjs");
const { pickCandidates } = await imp("ui/target-pick.mjs");
const { validateOverlay } = await imp("library/schema.mjs");
const { effectToEntries, entryToEffect } = await imp("library/entries.mjs");
const MOD = "stef-ds-automation";
const library = (await import(pathToFileURL(paths.LIBRARY + "/dist/overlays.mjs"))).default;

/* ---------- stepRecipient ---------- */
{
  const { gm, player } = users;
  const all = [gm, player];
  game.users.filter = fn => all.filter(fn);
  const shadow = new Actor({ uuid: "Actor.shadow0000000001", name: "Shadow", type: "hero" });
  shadow.owners.add(player.id);
  const npc = new Actor({ uuid: "Actor.npc00000000000001", name: "Ogre" });
  const card = (synthetic, authorUserId = gm.id) => ({ author: gm, flags: { [MOD]: { resolution: { synthetic, authorUserId } } } });
  assert.equal(stepRecipient(card(true), shadow)?.id, player.id, "a GM-made feature card of a player's hero: the player moves");
  assert.equal(stepRecipient(card(true), npc)?.id, gm.id, "an NPC's feature card: the Director");
  assert.equal(stepRecipient(card(false), shadow)?.id, gm.id, "a real card the GM authored stays with the Director");
  assert.equal(stepRecipient({ author: player, flags: { [MOD]: { resolution: {} } } }, shadow)?.id, player.id, "a player's own card");
  player.active = false;
  assert.equal(stepRecipient(card(true), shadow)?.id, gm.id, "the player offline: the Director");
  player.active = true;
  delete game.users.filter;
  console.log("ok stepRecipient: feature cards of heroes go to their player");
}

/* ---------- a 10x10 scene: Shadow, target, allies ---------- */
const scene = { id: "scene00000000018", grid: { size: 100, distance: 1, type: 1 }, tokens: [] };
let n = 0;
function place(name, x, y, { disposition = 1, type = "hero", hidden = false } = {}) {
  const id = `tok18${String(++n).padStart(11, "0")}`;
  const actor = new Actor({ uuid: `Actor.a18${String(n).padStart(13, "0")}`, name, type });
  actor.system.isCreature = true;
  registry.set(actor.uuid, actor);
  const doc = { uuid: `Scene.${scene.id}.Token.${id}`, id, name, actor, texture: { src: "" }, object: null, hidden, parent: scene,
    x: x * 100, y: y * 100, width: 1, height: 1, disposition };
  registry.set(doc.uuid, doc); scene.tokens.push(doc);
  return doc;
}
const me = place("Shadow", 2, 5);
const target = place("Ogre", 3, 5, { disposition: -1, type: "npc" });
const flanker = place("Fury", 4, 5);
const far = place("Censor", 9, 9);
const enemy = place("Goblin", 3, 6, { disposition: -1, type: "npc" });

/* ---------- proximity ---------- */
{
  assert.deepEqual(alliesNear(target, me, 1).map(t => t.name), ["Fury"], "allies next to the target, never the user or an enemy");
  assert.deepEqual(alliesNear(target, me, 6).map(t => t.name).sort(), ["Censor", "Fury"]);
  assert.equal(isFlanking(me, target), true, "fallback without placeables: adjacent with an adjacent ally");
  me.x = 100;
  assert.equal(isFlanking(me, target), false, "not adjacent: not flanking");
  me.x = 200;
  // With placeables on this canvas the system's own checks decide.
  const obj = doc => ({ document: doc, actor: doc.actor, canFlank: true });
  for (const d of scene.tokens) d.object = obj(d);
  let flanking = false;
  me.object.isFlanking = () => flanking;
  me.object.getAdjacentAllies = () => [flanker.object, far.object];
  me.object.onOppositeSideOrCorner = (_t, ally) => ally === flanker.object;
  globalThis.canvas = { scene, grid: { size: 100 } };
  assert.equal(isFlanking(me, target), false, "the system says no");
  assert.deepEqual(flankingAllies(me, target), []);
  flanking = true;
  assert.deepEqual(flankingAllies(me, target).map(t => t.name), ["Fury"], "only allies on the opposite side");
  for (const d of scene.tokens) d.object = null;
  delete globalThis.canvas;
  console.log("ok proximity: allies near the target, flanking (system checks and fallback)");
}

/* ---------- the overlay through the plan ---------- */
const overlay = library.find(o => o.key === "ability:you-were-watching-the-wrong-one");
assert.ok(overlay, "overlay in dist");
assert.equal(validateOverlay(overlay).errors?.length ?? 0, 0, "overlay validates");
const item = { uuid: `${me.actor.uuid}.Item.wrongone00000001`, name: overlay.name, actor: me.actor, system: { _dsid: "you-were-watching-the-wrong-one", keywords: new Set(["melee", "strike", "weapon"]) }, flags: {}, getRollData: () => ({}) };
function plan() {
  const self = { ...targetFromTokenDoc(me), self: true };
  const t = { ...targetFromTokenDoc(target), tier: 2 };
  const targets = { [self.key]: self, [t.key]: t };
  const { ops } = libraryOps({ lib: { effects: overlay.effects, config: {} }, item, targets, selfKey: self.key, self: { tier: 2 }, use: {},
    decideMode: () => "auto", forcedRow: () => null, spend: {}, noPowerRoll: false, warnings: [], order: 0, sourceTokenUuid: me.uuid });
  return Object.values(ops);
}
{
  flanker.x = 900; flanker.y = 0; far.x = 800; far.y = 500;          // the Censor 5 squares from the target
  let ops = plan();
  const surge = ops.find(o => o.libEffect === "surge");
  assert.ok(surge, "an ally 5 squares from the target: the surge row");
  assert.equal(surge.mode, "auto", "applies by itself");
  assert.equal(ops.find(o => o.libEffect === "flank")?.reason, "notFlanking", "not flanking: no pick offered");
  far.x = 900;                                                         // 6 squares
  ops = plan();
  assert.ok(!ops.some(o => o.libEffect === "surge"), "no ally within 5: no surge");
  far.hidden = true; flanker.x = 400; flanker.y = 500;                 // next to the target, opposite the Shadow
  ops = plan();
  assert.ok(ops.some(o => o.libEffect === "surge"), "the flanking ally counts as near");
  const pick = ops.find(o => o.libEffect === "flank");
  assert.equal(pick.kind, "pick"); assert.equal(pick.status, "pending"); assert.equal(pick.pick.flanking, true);
  const res = { sourceTokenUuid: me.uuid, sourceActorUuid: me.actor.uuid };
  enemy.x = 300; enemy.y = 600;
  assert.deepEqual(pickCandidates(pick, res).map(c => c.tokenUuid), [flanker.uuid], "only the flanking ally is offered");
  for (const d of scene.tokens) if (d !== me && d !== target) { d.x = 900; d.y = 900; }
  far.hidden = false; far.x = 900; far.y = 0;
  ops = plan();
  assert.ok(!ops.some(o => o.libEffect === "surge"), "only enemies near: no surge");
  console.log("ok You Were Watching the Wrong One: surge with an ally within 5, flanking pick");
}

/* ---------- schema and the Smart Automation entry round trip ---------- */
{
  const bad = (effect) => validateOverlay({ ...overlay, effects: [effect] }).errors?.length > 0;
  assert.ok(bad({ ...overlay.effects[0], when: { alliesNearTarget: -1 } }), "negative squares");
  assert.ok(bad({ ...overlay.effects[0], when: { alliesNearTarget: "random()" } }), "a bad formula");
  assert.ok(bad({ ...overlay.effects[1], pick: { ...overlay.effects[1].pick, flanking: "yes" } }), "flanking must be boolean");
  assert.ok(bad({ ...overlay.effects[1], pick: { ...overlay.effects[1].pick, of: "self" } }), "flanking is measured from the target");
  for (const effect of overlay.effects) {
    const [entry] = effectToEntries(effect, overlay.key);
    const back = entryToEffect(entry);
    if (effect.when) assert.deepEqual(back.when, effect.when, "when.alliesNearTarget survives the entry");
    if (effect.pick) assert.equal(back.pick.flanking, true, "pick.flanking survives the entry");
  }
  console.log("ok schema checks and entry round trip of the new fields");
}
console.log("\nALL HARNESS18 TESTS PASSED");
