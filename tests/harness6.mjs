// Sixth harness (Milestone 3): forced movement rows (per tier, bonuses, larger-creature bonus, potency,
// choice, slides), Combat Tools delegation (API form 3, undo log replay, moved-since, collision damage),
// our straight-line fallback (walls, creatures, stability, undo), the Combat Tools button lock, row
// edits (amount, temporary Stamina, distance, movement; validation and authorization), @spend from the
// roll dialog, and the api.forcedMovement / api.teleport cards. Reuses harness.mjs's world.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const paths = (await import("node:module")).createRequire(import.meta.url)("./paths.cjs"); const ROOT = paths.SCRIPTS;
globalThis.__HARNESS_SKIP_SCENARIOS__ = true;

/* ---------- mocks installed before the module loads ---------- */
const log = { fm: [], tp: [], replay: [], grabs: [] };
const G = 100;
const walls = new Set(); // "x,y>x,y" grid steps that a wall blocks
let collisionDamage = 0;  // Combat Tools mock: damage dealt to the mover
let grabsEnded = [];      // Combat Tools mock: grabs the move ends

globalThis.__HARNESS_SETUP__ = () => {
  game.modules.set("lib-wrapper", { active: true });
  globalThis.libWrapper = { register() {} };
  globalThis.CONST = { GRID_TYPES: { GRIDLESS: 0, SQUARE: 1 } };
  CONFIG.Canvas = { polygonBackends: { move: { testCollision(from, to) {
    const key = `${Math.floor(from.x / G)},${Math.floor(from.y / G)}>${Math.floor(to.x / G)},${Math.floor(to.y / G)}`;
    return walls.has(key);
  } } } };
  ds.CONFIG.abilities = { forcedMovement: {
    push: { label: "Push", vertical: "Vertical Push" }, pull: { label: "Pull", vertical: "Vertical Pull" }, slide: { label: "Slide", vertical: "Vertical Slide" },
  } };
  // Formula mock: numbers, "+", @potency.x and @spend (the dialog's spend values, summed).
  ds.utils.evaluateFormula = (f, rd) => String(f).split("+").map(t => t.trim()).reduce((sum, t) => {
    if (t.startsWith("@potency.")) return sum + rd.potency[t.split(".")[1]];
    if (t === "@spend") return sum + (rd.spend ?? []).reduce((a, b) => a + b, 0);
    const n = Number(t);
    if (!Number.isFinite(n)) throw new Error(`bad formula ${f}`);
    return sum + n;
  }, 0);
};

const world = await import(new URL("./harness.mjs", import.meta.url).href);
const { settle: settleQuick, makeAbility, hero, gobA, gobB, api, getResolution, buildView, users, setUser, Actor, registry, Message, messages, postAbility, Squad } = world;
const { gm, player } = users;
const { blockingForcedOp } = await import(pathToFileURL(ROOT + "ui/dstd-lock.mjs").href);
const { straightStep, sizeRank } = await import(pathToFileURL(ROOT + "delegation/forced-movement.mjs").href);
const { editOverride } = await import(pathToFileURL(ROOT + "engine/engine.mjs").href);

// This harness isolates legacy Director delegates; harness13 exercises the player consent flow.
Hooks.on("dsAuto.preApplyOp", (_message, op) => { if (["forced", "teleport"].includes(op.kind)) op.synthetic = true; });
const set = (key, value) => game.settings.set("stef-ds-automation", key, value);
// Moves wait for the token to settle (~100 ms per move) after the card is written.
const settle = () => new Promise(r => setTimeout(r, 450));
const opsOf = msg => Object.values(getResolution(msg).ops);
const forcedOps = msg => opsOf(msg).filter(o => o.kind === "forced");
const fl = (movement, distance) => `DSAUTO.Card.Forced ${JSON.stringify({ movement, distance })}`; // i18n mock

globalThis.ChatMessage = {
  getSpeaker: ({ actor } = {}) => ({ alias: actor?.name ?? "GM" }),
  async create(data) {
    const msg = new Message({ type: data.type, parts: data.system.parts, flags: data.flags, speaker: data.speaker });
    msg.author = game.user;
    messages.set(msg.id, msg);
    Hooks.callAll("createChatMessage", msg, {}, game.userId);
    return msg;
  },
};

/* ---------- canvas, tokens ---------- */
const SCENE = "scene00000000001";
const placeables = [];
globalThis.canvas = {
  scene: { id: SCENE, tokens: { get: id => placeables.find(t => t.id === id)?.document ?? null, filter: fn => placeables.map(t => t.document).filter(fn) } },
  grid: { size: G, type: 1 },
  tokens: { get placeables() { return placeables; }, get: id => placeables.find(t => t.id === id) ?? null },
};
class TokenDoc {
  constructor(id, actor, name, gx, gy, size = 1) {
    Object.assign(this, { id, actor, name, x: gx * G, y: gy * G, elevation: 0, width: size, height: size, hidden: false });
    this.uuid = `Scene.${SCENE}.Token.${id}`;
    this.parent = { id: SCENE };
    this.texture = { src: `${name}.png` };
    this.updates = [];
    this.object = { id, document: this, get center() { return { x: this.document.x + (this.document.width * G) / 2, y: this.document.y + (this.document.height * G) / 2 }; } };
  }
  get actorId() { return this.actor?.id; }
  async update(data, options = {}) {
    this.updates.push({ data, options });
    for (const k of ["x", "y", "elevation"]) if (k in data) this[k] = data[k];
    return this;
  }
}
function place(id, actor, name, gx, gy, size = 1) {
  const doc = new TokenDoc(id, actor, name, gx, gy, size);
  registry.set(doc.uuid, doc);
  placeables.push(doc.object);
  return { document: doc, actor, id };
}
const at = (t) => [t.document.x / G, t.document.y / G];
// Hero (the ability's user) at (5,5); goblin A east of it, goblin B south-east.
hero.system.combat = { size: { value: 1, letter: "L" }, stability: 0 };
gobA.system.combat = { size: { value: 1, letter: "M" }, stability: 0 };
gobB.system.combat = { size: { value: 1, letter: "M" }, stability: 1 };
const tHero = place("hero000000000tok", hero, "Hero", 5, 5);
const tA = place("tokA000000000001", gobA, "Goblin A", 6, 5);
const tB = place("tokB000000000001", gobB, "Goblin B", 6, 6);
gobA.token = tA.document; gobB.token = tB.document;
const home = () => {
  tA.document.x = 6 * G; tA.document.y = 5 * G; tB.document.x = 6 * G; tB.document.y = 6 * G;
  for (const a of [gobA, gobB]) { a.system.stamina.value = 20; a.system.stamina.temporary = 0; a.statuses.clear(); }
};

/* ---------- Combat Tools + ctlib mocks ---------- */
const dsctApi = {
  async forcedMovement(args) {
    const card = messages.contents.at(-1);
    log.fm.push({ ...args, targetStamina: canvas.tokens.get(args.targetId)?.document.actor.system.stamina.value,
      cardStatuses: Object.values(getResolution(card)?.ops ?? {}).filter(o => o.kind !== "forced").map(o => o.status) });
    const doc = canvas.tokens.get(args.targetId).document;
    const actor = doc.actor;
    const stability = args.ignoreStability ? 0 : (actor.system.combat?.stability ?? 0);
    const n = Math.max(0, args.distance - stability);
    if (!n) return undefined; // "stability fully resists"
    const start = { x: doc.x, y: doc.y, elevation: doc.elevation };
    const prev = { prevValue: actor.system.stamina.value, prevTemp: actor.system.stamina.temporary };
    const dir = args.type === "Pull" ? -1 : 1;
    await doc.update({ x: doc.x + dir * n * G });
    if (collisionDamage) await actor.modifyTokenAttribute("stamina", -collisionDamage, true, false);
    return {
      content: `<strong>${doc.name}</strong> forced: ${args.type} ${n}.`,
      undoLog: [
        { op: "update", uuid: doc.uuid, data: start, options: { isUndo: true } },
        { op: "stamina", uuid: actor.uuid, ...prev, squadGroupUuid: null, prevSquadHP: null, squadTokenIds: [], wasDeadBefore: false },
      ],
      moveId: `move${log.fm.length}`, targetTokenId: doc.id, targetSceneId: SCENE,
      finalPos: { x: doc.x, y: doc.y, elevation: doc.elevation }, hadDamage: !!collisionDamage, grabsToRestore: grabsEnded,
    };
  },
  async teleport({ distance, sourceId, targetId, mode }) {
    log.tp.push({ distance, sourceId, targetId, mode });
    const doc = canvas.tokens.get(sourceId).document;
    if (mode === "swap") {
      const other = canvas.tokens.get(targetId).document;
      const [x, y] = [doc.x, doc.y];
      await doc.update({ x: other.x, y: other.y });
      await other.update({ x, y });
      return;
    }
    await doc.update({ x: doc.x + 3 * G });
  },
  async grab(a, b, options) { log.grabs.push([a.id, b.id, options?.maxGrabs]); },
};
const ctlibMock = {
  async replayUndo(entries) {
    log.replay.push(entries.map(e => e.op));
    for (const e of entries) {
      const doc = fromUuidSync(e.uuid);
      if (e.op === "update") await doc.update(e.data, e.options);
      if (e.op === "stamina" && !e.wasDeadBefore) await doc.update({ "system.stamina.value": e.prevValue, "system.stamina.temporary": e.prevTemp });
    }
  },
  damageBatch: fn => fn(),
};
const setDsct = (on) => {
  if (on) {
    game.modules.set("draw-steel-combat-tools", { active: true, api: dsctApi });
    game.modules.set("draw-steel-ctlib", { active: true });
    globalThis.ctlib = ctlibMock;
  } else {
    game.modules.delete("draw-steel-combat-tools");
    game.modules.delete("draw-steel-ctlib");
    delete globalThis.ctlib;
  }
};
setDsct(true);

/* ---------- abilities with forced movement ---------- */
let n = 0;
function forcedAbility({ tiers, bonuses = { push: 1, pull: 0, slide: 0 }, damage = false, keywords = ["melee", "weapon", "strike"] }) {
  const item = makeAbility({ uuid: `Actor.hero000000000001.Item.m3${String(++n).padStart(14, "0")}`, name: `M3 ${n}`, actor: hero, damage });
  const forced = { bonuses };
  for (const [tier, t] of Object.entries(tiers)) {
    forced[`tier${tier}`] = {
      movement: new Set(t.movement), distance: t.distance, properties: new Set(t.properties ?? []),
      potency: { characteristic: t.chr ?? (tier === "1" ? "none" : ""), value: t.potency ?? "@potency.weak" },
    };
  }
  item.system.power.effects.set("fmPRE00000000001", { id: "fmPRE00000000001", type: "forced", name: "Forced", forced });
  item.system.keywords = new Set(keywords);
  return item;
}
const use = (item, byTier, dmg = {}, opts = {}) => postAbility(item, byTier, dmg, opts);

/* ---------- sizes, straight steps ---------- */
assert.equal(sizeRank({ value: 1, letter: "L" }), 3);
assert.equal(sizeRank({ value: 2 }), 4);
assert.deepEqual(straightStep({ x: 0, y: 0 }, { x: 100, y: 0 }, "push"), { x: 1, y: 0 });
assert.deepEqual(straightStep({ x: 0, y: 0 }, { x: 100, y: 100 }, "push"), { x: 1, y: 1 });
assert.deepEqual(straightStep({ x: 0, y: 0 }, { x: 100, y: 30 }, "pull"), { x: -1, y: 0 });
console.log("ok size ranks / straight steps");

/* ---------- Combat Tools: straight push per tier, bonuses, undo ---------- */
{
  const item = forcedAbility({ tiers: { 1: { movement: ["push"], distance: "1" }, 3: { movement: ["push"], distance: "3" } } });
  log.fm.length = 0;
  const msg = use(item, { 1: [tA], 3: [tB] });
  await settle();
  const ops = forcedOps(msg);
  assert.equal(ops.length, 2, "one row per target");
  const a = ops.find(o => o.targetKeys[0].includes("tokA"));
  const b = ops.find(o => o.targetKeys[0].includes("tokB"));
  // push 1 + kit bonus 1 + larger creature with a melee weapon 1 = 3; tier 3: 3 + 1 + 1 = 5
  assert.equal(a.distances.push, 3);
  assert.equal(b.distances.push, 5);
  assert.equal(a.sizeBonus, 1);
  assert.equal(a.status, "applied");
  assert.equal(a.delegated, "dsct");
  assert.equal(log.fm.length, 2);
  assert.deepEqual([log.fm[0].type, log.fm[0].distance, log.fm[0].fastMove, log.fm[0].suppressMessage, log.fm[0].sourceId], ["Push", 3, true, true, "hero000000000tok"]);
  assert.deepEqual(at(tA), [9, 5], "A pushed 3");
  assert.deepEqual(at(tB), [10, 6], "B pushed 5 - stability 1 (Combat Tools applies it)");
  const view = buildView(msg, getResolution(msg));
  const rowA = view.rows.find(r => r.key.includes("tokA"));
  assert.equal(rowA.ops[0].label, fl("Push", 3));
  assert.ok(rowA.ops[0].detail.includes("DSAUTO.Card.SizeBonus"));
  assert.ok(view.rows.find(r => r.key.includes("tokB")).ops[0].detail.includes("DSAUTO.Card.Stability"), "B's stability shown to the Director");
  // The Combat Tools button of tier 1 is locked now.
  const button = { closest: () => ({ dataset: { messagePart: "tier1Result00000" } }), dataset: { movement: "push" } };
  assert.equal(blockingForcedOp(msg, button)?.opId, a.opId);
  assert.equal(blockingForcedOp(msg, { ...button, dataset: { movement: "pull" } }), null, "other movement type free");
  await api.undoOps(msg.id);
  assert.deepEqual(at(tA), [6, 5]);
  assert.deepEqual(at(tB), [6, 6]);
  assert.ok(forcedOps(msg).every(o => o.status === "undone"));
  assert.equal(blockingForcedOp(msg, button), null, "unlocked after undo");
  console.log("ok Combat Tools push per tier, bonuses, size bonus, lock, undo");
}

/* ---------- damage lands before the move; collision damage undone; moved since ---------- */
{
  const item = forcedAbility({ tiers: { 2: { movement: ["push"], distance: "2" } }, damage: true });
  log.fm.length = 0;
  collisionDamage = 2;
  const msg = use(item, { 2: [tA] }, { 2: [{ total: 5, options: {} }] });
  await settle();
  assert.equal(log.fm[0].targetStamina, 20 - 5, "the hit landed before the move");
  assert.equal(gobA.system.stamina.value, 20 - 5 - 2, "damage then collision");
  tA.document.x = 12 * G; // someone moved it since
  const fm = forcedOps(msg)[0];
  await api.undoOps(msg.id, [fm.opId]);
  const after = forcedOps(msg)[0];
  assert.equal(after.undoMode, "positionKept");
  assert.equal(tA.document.x, 12 * G, "position kept");
  assert.equal(gobA.system.stamina.value, 15, "collision damage undone, the hit stays");
  assert.deepEqual(log.replay.at(-1), ["stamina"], "position entry left out of the replay");
  await api.undoOps(msg.id);
  collisionDamage = 0;
  home();
  console.log("ok order damage -> move, collision undo, moved since");
}

/* ---------- potency, self target, choice, slide ---------- */
{
  // tier 2 potency might average (2): goblin B (might 3) resists, goblin A (might 0) is moved.
  const item = forcedAbility({ tiers: { 2: { movement: ["push"], distance: "1", chr: "might", potency: "@potency.average" } } });
  const msg = use(item, { 2: [tA, tB] });
  await settle();
  const [a, b] = ["tokA", "tokB"].map(k => forcedOps(msg).find(o => o.targetKeys[0].includes(k)));
  assert.equal(a.status, "applied");
  assert.equal(b.status, "skipped");
  assert.equal(b.reason, "resisted");
  await api.undoOps(msg.id);
  // Resisted by exactly one (might 2 vs average 2): 2 surges for +1 potency move it.
  gobB.system.characteristics.might.value = 2;
  hero.system.hero = { primary: { value: 0 }, surges: 2 };
  const msgP = use(item, { 2: [tB] });
  await settle();
  const p = forcedOps(msgP)[0];
  assert.equal(p.reason, "resisted");
  await api.surge(msgP.id, p.opId, { potency: true });
  const pAfter = forcedOps(msgP)[0];
  assert.deepEqual([pAfter.status, pAfter.surgesPaid, hero.system.hero.surges], ["applied", 2, 0], "potency surge moved it");
  await api.undoOps(msgP.id);
  assert.equal(hero.system.hero.surges, 2, "refunded on undo");
  gobB.system.characteristics.might.value = 3;
  delete hero.system.hero;

  // Self: the hero pushes itself -> skipped.
  const self = forcedAbility({ tiers: { 1: { movement: ["push"], distance: "1" } } });
  const msgSelf = use(self, { 1: [tHero] });
  await settle();
  assert.equal(forcedOps(msgSelf)[0].reason, "selfForced");

  // Push or pull: waits for a choice; Apply all leaves it; Edit + apply moves it (path picked: interactive).
  log.fm.length = 0;
  const either = forcedAbility({ tiers: { 1: { movement: ["push", "pull"], distance: "2" } }, bonuses: { push: 0, pull: 1, slide: 0 } });
  const msgE = use(either, { 1: [tA] });
  await settle();
  const e = forcedOps(msgE)[0];
  assert.equal(e.mode, "auto");
  assert.equal(e.movement, null);
  assert.deepEqual(e.distances, { push: 3, pull: 4 });
  assert.equal(buildView(msgE, getResolution(msgE)).rows[0].ops[0].applyAction, "dsAutoApply");
  assert.equal(buildView(msgE, getResolution(msgE)).rows[0].ops[0].label, `${fl("Push", 3)} / ${fl("Pull", 4)}`);
  await api.applyOps(msgE.id);
  assert.equal(log.fm.length, 0, "Apply all skips rows that need a choice");
  await api.applyOps(msgE.id, [e.opId]);
  assert.equal(forcedOps(msgE)[0].reason, "chooseMovement");
  assert.equal(forcedOps(msgE)[0].status, "pending");
  await api.editOp(msgE.id, e.opId, { movement: "pull" }, { apply: true });
  assert.equal(log.fm.length, 1);
  assert.deepEqual([log.fm[0].type, log.fm[0].distance, log.fm[0].fastMove], ["Pull", 4, true], "chosen type, its distance, straight once chosen");
  assert.equal(forcedOps(msgE)[0].status, "applied");
  assert.equal(forcedOps(msgE)[0].reason, null);
  // Combat Tools' buttons for BOTH types are locked now (seen live: its Pull button stayed open).
  const btn = movement => ({ closest: () => ({ dataset: { messagePart: "tier1Result00000" } }), dataset: { movement } });
  assert.ok(blockingForcedOp(msgE, btn("push")) && blockingForcedOp(msgE, btn("pull")));
  const { blockingForcedRow } = await import(pathToFileURL(ROOT + "ui/dstd-lock.mjs").href);
  assert.ok(blockingForcedRow(msgE, `${msgE.id}:${e.targetKeys[0]}:push`), "panel row of the other type locked too");
  await api.undoOps(msgE.id);

  // Slide: prompt (Director picks); a player may not apply or edit it.
  const slide = forcedAbility({ tiers: { 1: { movement: ["slide"], distance: "2" } } });
  const msgS = use(slide, { 1: [tA] });
  await settle();
  const s = forcedOps(msgS)[0];
  assert.equal(s.mode, "auto");
  assert.equal(s.interactive, true);
  setUser(player);
  await assert.rejects(api.editOp(msgS.id, s.opId, { distance: 1 }, { apply: true }), /Denied/);
  setUser(gm);
  home();
  console.log("ok potency, self, push-or-pull choice, slide prompt, player refused");
}

/* ---------- fallback without Combat Tools ---------- */
{
  setDsct(false);
  const item = forcedAbility({ tiers: { 1: { movement: ["push"], distance: "3" } }, bonuses: { push: 0, pull: 0, slide: 0 } });
  // push 3 + size 1 = 4; wall between (8,5) and (9,5): A moves 2 and stops 2 short.
  walls.add("8,5>9,5");
  const msg = use(item, { 1: [tA] });
  await settle();
  const op = forcedOps(msg)[0];
  assert.equal(op.delegate, "core");
  assert.equal(op.status, "applied");
  assert.equal(op.movedDistance, 2);
  assert.equal(op.collisionLeft, 2);
  assert.deepEqual(at(tA), [8, 5]);
  assert.equal(tA.document.updates.at(-1).options.movement[tA.id].waypoints[0].action, "displace");
  await api.undoOps(msg.id);
  assert.deepEqual(at(tA), [6, 5]);
  walls.clear();

  // Stability 1 and a creature in the way: B is pushed south-east (diagonal), 4 - 1 = 3, a goblin at (8,8) stops it at (7,7).
  const blocker = new Actor({ uuid: "Actor.blocker000000001", name: "Blocker" });
  registry.set(blocker.uuid, blocker);
  place("tokC000000000001", blocker, "Blocker", 8, 8);
  const msg2 = use(item, { 1: [tB] });
  await settle();
  const op2 = forcedOps(msg2)[0];
  assert.deepEqual(at(tB), [7, 7]);
  assert.equal(op2.collisionLeft, 2);
  await api.undoOps(msg2.id);
  placeables.splice(placeables.findIndex(t => t.id === "tokC000000000001"), 1);
  // A diagonal step may not cut a wall corner (seen live): B's first step (6,6)->(7,7) is blocked by a
  // wall on its east side.
  walls.add("6,6>7,6");
  const msgC = use(item, { 1: [tB] });
  await settle();
  assert.deepEqual([forcedOps(msgC)[0].status, forcedOps(msgC)[0].reason], ["skipped", "blocked"]);
  assert.deepEqual(at(tB), [6, 6]);
  walls.clear();

  // Slides need Combat Tools: manual reminder. Fallback off: every row is a reminder.
  const slide = forcedAbility({ tiers: { 1: { movement: ["slide"], distance: "2" } } });
  const msgS = use(slide, { 1: [tA] });
  await settle();
  assert.deepEqual([forcedOps(msgS)[0].mode, forcedOps(msgS)[0].noApply, forcedOps(msgS)[0].reason], ["auto", undefined, "delegateUnavailable"]);
  set("forcedFallback", false);
  const msgOff = use(item, { 1: [tA] });
  await settle();
  assert.equal(forcedOps(msgOff)[0].reason, "moveByHand");
  set("forcedFallback", true);

  // Director on another scene: fails, can be applied again later.
  canvas.scene.id = "otherScene000001";
  const msgAway = use(item, { 1: [tA] });
  await settle();
  assert.equal(forcedOps(msgAway)[0].status, "failed");
  assert.equal(forcedOps(msgAway)[0].reason, "notOnCanvas");
  canvas.scene.id = SCENE;
  await api.applyOps(msgAway.id, [forcedOps(msgAway)[0].opId]);
  assert.equal(forcedOps(msgAway)[0].status, "applied");
  await api.undoOps(msgAway.id);
  setDsct(true);
  home();
  console.log("ok fallback: wall, creature, stability, diagonal, undo, slide manual, off, other scene");
}

/* ---------- modes ---------- */
{
  set("forcedMovementMode", "prompt");
  const item = forcedAbility({ tiers: { 1: { movement: ["push"], distance: "1" } } });
  const msg = use(item, { 1: [tA] });
  await settle();
  assert.equal(forcedOps(msg)[0].status, "pending");
  set("forcedMovementMode", "off");
  const msgOff = use(item, { 1: [tA] });
  await settle();
  assert.equal(forcedOps(msgOff).length, 0, "off: no rows");
  set("forcedMovementMode", "auto");
  set("forcedPath", "choose");
  const msgChoose = use(item, { 1: [tA] });
  await settle();
  assert.deepEqual([forcedOps(msgChoose)[0].mode, forcedOps(msgChoose)[0].interactive], ["auto", true]);
  set("forcedPath", "straight");
  console.log("ok forced modes and path setting");
}

/* ---------- edits: amount, temporary Stamina, distance; validation ---------- */
{
  set("damageMode", "prompt");
  const item = makeAbility({ uuid: "Actor.hero000000000001.Item.m3edit0000000001", name: "Edit", actor: hero });
  const msg = use(item, { 1: [tA] }, { 1: [{ total: 6, options: { type: "fire" } }] });
  await settle();
  const op = opsOf(msg)[0];
  await api.editOp(msg.id, op.opId, { amount: 10 });
  assert.equal(opsOf(msg)[0].override.amount, 10);
  assert.equal(opsOf(msg)[0].status, "pending", "saved, not applied");
  assert.ok(buildView(msg, getResolution(msg)).rows[0].ops[0].detail.includes("DSAUTO.Card.Edited"));
  await api.editOp(msg.id, op.opId, { amount: 9 }, { apply: true });
  assert.equal(gobA.system.stamina.value, 20 - 7, "edited 9 minus fire immunity 2");
  await api.undoOps(msg.id);
  assert.equal(gobA.system.stamina.value, 20);
  await api.editOp(msg.id, op.opId, { amount: null }, { apply: true });
  assert.equal(gobA.system.stamina.value, 20 - 4, "cleared: the roll's 6 again");
  await api.undoOps(msg.id);
  set("damageMode", "auto");

  // Healing as temporary Stamina.
  set("healingMode", "prompt");
  const heal = makeAbility({ uuid: "Actor.hero000000000001.Item.m3heal0000000001", name: "Heal", actor: hero });
  gobA.system.stamina.value = 10;
  const msgH = use(heal, { 1: [tA] }, { 1: [{ total: 5, options: { isHeal: true, type: "value" } }] });
  await settle();
  const h = opsOf(msgH)[0];
  await api.editOp(msgH.id, h.opId, { temp: true }, { apply: true });
  assert.deepEqual([gobA.system.stamina.value, gobA.system.stamina.temporary], [10, 5]);
  assert.equal(buildView(msgH, getResolution(msgH)).rows[0].ops[0].label.startsWith("DSAUTO.Card.Temp"), true);
  await api.undoOps(msgH.id);
  assert.deepEqual([gobA.system.stamina.value, gobA.system.stamina.temporary], [10, 0]);
  set("healingMode", "auto");
  home();

  // Validation.
  const base = { kind: "damage", status: "pending", movements: [] };
  assert.throws(() => editOverride(base, { amount: -1 }), /BadRequest/);
  assert.throws(() => editOverride(base, { amount: 1.5 }), /BadRequest/);
  assert.throws(() => editOverride(base, { temp: true }), /BadRequest/, "damage cannot become temporary Stamina");
  assert.throws(() => editOverride({ ...base, status: "applied" }, { amount: 1 }), /BadRequest/);
  assert.throws(() => editOverride({ ...base, surge: { kind: "damage" } }, { amount: 1 }), /BadRequest/);
  assert.throws(() => editOverride({ kind: "forced", status: "pending", movements: ["push"] }, { movement: "slide" }), /BadRequest/);
  assert.throws(() => editOverride({ kind: "forced", status: "pending", movements: ["push"] }, { distance: 51 }), /BadRequest/);
  assert.throws(() => editOverride({ kind: "condition", status: "pending" }, {}), /BadRequest/);
  assert.deepEqual(editOverride({ kind: "forced", status: "pending", movements: ["push"], override: { distance: 2, by: "gm", at: 1 } }, { distance: null }), {});

  // Forced distance edit.
  set("forcedMovementMode", "prompt");
  log.fm.length = 0;
  const fm = forcedAbility({ tiers: { 1: { movement: ["push"], distance: "1" } } });
  const msgF = use(fm, { 1: [tA] });
  await settle();
  await api.editOp(msgF.id, forcedOps(msgF)[0].opId, { distance: 1 }, { apply: true });
  assert.equal(log.fm[0].distance, 1);
  assert.deepEqual(at(tA), [7, 5]);
  await api.undoOps(msgF.id);
  set("forcedMovementMode", "auto");
  console.log("ok edits: amount, clear, heal as temp, validation, forced distance");
}

/* ---------- @spend from the roll dialog ---------- */
{
  log.fm.length = 0;
  const item = forcedAbility({ tiers: { 1: { movement: ["push"], distance: "1 + @spend" } }, bonuses: { push: 0, pull: 0, slide: 0 } });
  // The author's client notes the dialog's spend choice when it closes.
  Hooks.callAll("closeAbilityConfigurationDialog", { item: { uuid: item.uuid }, options: { context: { spend: { spendA: 2 } } } });
  const msg = use(item, { 1: [tA] });
  await settle();
  assert.deepEqual(getResolution(msg).spend, [2]);
  assert.equal(forcedOps(msg)[0].distances.push, 1 + 2 + 1, "1 + @spend 2 + size bonus");
  await api.undoOps(msg.id);
  // Consumed once: the next use without the dialog has no spend.
  const msg2 = use(item, { 1: [tA] });
  await settle();
  assert.equal(getResolution(msg2).spend, null);
  assert.equal(forcedOps(msg2)[0].distances.push, 2);
  await api.undoOps(msg2.id);
  // An invalid distance formula: warning, no row.
  const bad = forcedAbility({ tiers: { 1: { movement: ["push"], distance: "@nope" } } });
  const msg3 = use(bad, { 1: [tA] });
  await settle();
  assert.equal(forcedOps(msg3).length, 0);
  assert.ok(getResolution(msg3).warnings.some(w => w.code === "forcedDistanceInvalid"));
  home();
  console.log("ok @spend, consumed once, invalid distance");
}

/* ---------- squads: minions move one by one ---------- */
{
  const m1 = new Actor({ uuid: `Scene.${SCENE}.Token.tokM100000000001.Actor.minion0000000001`, name: "M1", minion: true, stamina: 5 });
  const m2 = new Actor({ uuid: `Scene.${SCENE}.Token.tokM200000000001.Actor.minion0000000001`, name: "M2", minion: true, stamina: 5 });
  for (const m of [m1, m2]) { registry.set(m.uuid, m); m.system.combat = { size: { value: 1, letter: "M" }, stability: 0 }; }
  const squad = new Squad(`Scene.${SCENE}.CombatantGroup.squad00000000001`, "Wolves", [m1, m2]);
  registry.set(squad.uuid, squad);
  const t1 = place("tokM100000000001", m1, "M1", 5, 2);
  const t2 = place("tokM200000000001", m2, "M2", 2, 5);
  const item = forcedAbility({ tiers: { 1: { movement: ["push"], distance: "1" } }, damage: true });
  log.fm.length = 0;
  const msg = use(item, { 1: [t1, t2] }, { 1: [{ total: 3, options: {} }] });
  await settle();
  assert.equal(opsOf(msg).filter(o => o.kind === "damage").length, 1, "one squad damage row");
  assert.equal(forcedOps(msg).length, 2, "one forced row per minion");
  assert.deepEqual(log.fm.map(c => c.targetId).sort(), [t1.id, t2.id].sort(), "each minion moved on its own");
  await api.undoOps(msg.id);
  assert.deepEqual([at(t1), at(t2)], [[5, 2], [2, 5]]);
  console.log("ok squad minions moved one by one");
}

/* ---------- api.forcedMovement / api.teleport cards ---------- */
{
  log.fm.length = 0;
  const r = await api.forcedMovement({ targets: [tA.document], movement: "pull", distance: 1, source: tHero.document });
  assert.ok(r.ok);
  assert.deepEqual(at(tA), [5, 5], "pulled 1 (mock moves along x)");
  const msg = messages.get(r.messageId);
  assert.equal(getResolution(msg).synthetic, true);
  assert.equal(getResolution(msg).sourceTokenUuid, tHero.document.uuid);
  await api.undoOps(r.messageId);
  assert.deepEqual(at(tA), [6, 5]);
  await assert.rejects(api.forcedMovement({ targets: [tA.document], movement: "shove", distance: 1 }), /BadRequest/);
  await assert.rejects(api.forcedMovement({ targets: [tA.document], movement: "push", distance: 99 }), /BadRequest/);
  setUser(player);
  await assert.rejects(api.forcedMovement({ targets: [tA.document], movement: "push", distance: 1, source: tHero.document }), /Denied/);
  setUser(gm);

  // Teleport to a destination (no Combat Tools needed), undo.
  const t = await api.teleport({ token: tA.document, destination: { x: 9 * G, y: 9 * G } });
  assert.deepEqual(at(tA), [9, 9]);
  await api.undoOps(t.messageId);
  assert.deepEqual(at(tA), [6, 5]);
  // Combat Tools' picker: swap with a partner, undo both.
  const sw = await api.teleport({ token: tA.document, partner: tB.document, teleportMode: "swap", distance: 5 });
  assert.deepEqual([at(tA), at(tB)], [[6, 6], [6, 5]]);
  assert.equal(log.tp.at(-1).mode, "swap");
  assert.equal(opsOf(messages.get(sw.messageId))[0].moves.length, 2);
  await api.undoOps(sw.messageId);
  assert.deepEqual([at(tA), at(tB)], [[6, 5], [6, 6]]);
  // Without Combat Tools a pick is impossible: failed row.
  setDsct(false);
  const nt = await api.teleport({ token: tA.document });
  assert.equal(opsOf(messages.get(nt.messageId))[0].reason, "delegateUnavailable");
  setDsct(true);
  await assert.rejects(api.teleport({ token: tA.document, teleportMode: "fold" }), /BadRequest/);
  console.log("ok api.forcedMovement / api.teleport cards, undo, validation, Directors only");
}

/* ---------- Target Damage never marks movement rows "applied elsewhere" ---------- */
{
  game.modules.set("draw-steel-target-damage", { active: true });
  set("forcedMovementMode", "prompt");
  const item = forcedAbility({ tiers: { 1: { movement: ["push"], distance: "1" } } });
  const msg = use(item, { 1: [tA] });
  await settle();
  // A Target Damage record for this target with a tier override (matches any part).
  msg.flags["draw-steel-target-damage"] = { state: {
    tierOverrides: { [tA.document.uuid.replace(/\./g, "__")]: 2 },
    applications: { x: { records: [{ kind: "damage", target: { tokenUuid: tA.document.uuid }, partId: "tier1Result00000", rollIndex: 0 }] } },
  } };
  await api.applyOps(msg.id, [forcedOps(msg)[0].opId]);
  assert.equal(forcedOps(msg)[0].status, "applied");
  await api.undoOps(msg.id);
  game.modules.delete("draw-steel-target-damage");
  set("forcedMovementMode", "auto");
  home();
  console.log("ok movement rows ignore Target Damage records");
}

/* ---------- review findings (0.5.0) ---------- */
{
  const { blockingForcedRow } = await import(pathToFileURL(ROOT + "ui/dstd-lock.mjs").href);
  // 1. Undo reverses only the collision damage: later damage stays; an undone hit is not dealt again.
  collisionDamage = 2;
  const item = forcedAbility({ tiers: { 1: { movement: ["push"], distance: "1" } }, damage: true });
  const msg = use(item, { 1: [tA] }, { 1: [{ total: 5, options: {} }] });
  await settle();
  assert.equal(gobA.system.stamina.value, 13, "5 hit + 2 collision");
  // 4. The card was written (damage applied) before Combat Tools moved the target.
  assert.deepEqual(log.fm.at(-1).cardStatuses, ["applied"]);
  await gobA.modifyTokenAttribute("stamina", -4, true, false); // someone else hits it
  const fm = forcedOps(msg)[0];
  await api.undoOps(msg.id, [fm.opId]);
  assert.equal(gobA.system.stamina.value, 11, "only the 2 collision damage reversed, the other 4 kept");
  assert.equal(forcedOps(msg)[0].undoMode, "delta");
  await api.undoOps(msg.id);
  assert.equal(gobA.system.stamina.value, 16, "the hit's undo is delta too (the other 4 stay)");
  home();
  collisionDamage = 0;
  const msg2 = use(item, { 1: [tA] }, { 1: [{ total: 5, options: {} }] });
  await settle();
  const dmg = opsOf(msg2).find(o => o.kind === "damage");
  await api.undoOps(msg2.id, [dmg.opId]);
  assert.equal(gobA.system.stamina.value, 20);
  await api.undoOps(msg2.id);
  assert.equal(gobA.system.stamina.value, 20, "no collision: the move's undo leaves Stamina alone");
  assert.ok(!log.replay.at(-1).includes("stamina"));
  home();

  // 3. Combat Tools' per-target rows inside Target Damage's panel are locked too.
  const msg3 = use(forcedAbility({ tiers: { 1: { movement: ["push"], distance: "1" } } }), { 1: [tA] });
  await settle();
  const key = forcedOps(msg3)[0].targetKeys[0];
  assert.ok(blockingForcedRow(msg3, `${msg3.id}:${key}:push`));
  assert.equal(blockingForcedRow(msg3, `${msg3.id}:${key}:pull`), null);
  assert.equal(blockingForcedRow(msg3, `${msg3.id}:${key}:flatFm:x`), null, "flat effect rows are not ours");
  // 8. Ended grabs come back with each grabber's count; not when the creature stays where it was pushed.
  await api.undoOps(msg3.id);
  grabsEnded = [{ grabberTokenId: tHero.id, grabbedTokenId: tA.id }, { grabberTokenId: tHero.id, grabbedTokenId: tB.id }];
  await api.applyOps(msg3.id, [forcedOps(msg3)[0].opId]);
  log.grabs.length = 0;
  await api.undoOps(msg3.id);
  assert.deepEqual(log.grabs.map(g => g[2]), [2, 2], "maxGrabs per grabber");
  await api.applyOps(msg3.id, [forcedOps(msg3)[0].opId]);
  assert.equal(forcedOps(msg3)[0].grabsLost, null, "stale note cleared on re-apply");
  tA.document.x = 15 * G;
  log.grabs.length = 0;
  await api.undoOps(msg3.id);
  assert.equal(log.grabs.length, 0);
  assert.equal(forcedOps(msg3)[0].grabsLost, 2);
  grabsEnded = [];
  home();

  // 2. A cleared Edit field is gone from the stored record. 9. Edit + Apply deals full damage after a half apply.
  set("damageMode", "prompt");
  const strike = makeAbility({ uuid: "Actor.hero000000000001.Item.m3edit0000000002", name: "Edit2", actor: hero });
  const msg4 = use(strike, { 1: [tA] }, { 1: [{ total: 6, options: {} }] });
  await settle();
  const op4 = opsOf(msg4)[0];
  await api.editOp(msg4.id, op4.opId, { amount: 9 });
  await api.editOp(msg4.id, op4.opId, { amount: null });
  assert.ok(!("amount" in getResolution(msg4).ops[op4.opId].override), "cleared in the record");
  await api.applyOps(msg4.id, [op4.opId], { half: true });
  assert.equal(gobA.system.stamina.value, 17);
  await api.undoOps(msg4.id);
  await api.editOp(msg4.id, op4.opId, { amount: 8 }, { apply: true });
  assert.equal(gobA.system.stamina.value, 12, "full 8, not half");
  await api.undoOps(msg4.id);
  // 6. Edit is the Director's: a player who may apply the row still may not edit it.
  set("cardActionRole", 1);
  hero.owners.add("pl");
  setUser(player);
  await assert.rejects(api.editOp(msg4.id, op4.opId, { amount: 10000 }, { apply: true }), /Denied/);
  assert.equal(buildView(msg4, getResolution(msg4)).rows[0].ops[0].canEdit, false);
  setUser(gm);
  set("cardActionRole", 4);
  set("damageMode", "auto");
  home();

  // 5. The straight pull never passes the source: hero (5,5), A at (8,6), pull 5 stops next to it.
  setDsct(false);
  tA.document.x = 8 * G; tA.document.y = 6 * G;
  tB.document.x = 2 * G; tB.document.y = 2 * G; // out of the way
  const r = await api.forcedMovement({ targets: [tA.document], movement: "pull", distance: 5, source: tHero.document });
  assert.deepEqual(at(tA), [5, 6], "three steps west to the square next to the source; the fourth would move it away");
  await api.undoOps(r.messageId);
  setDsct(true);
  home();

  // 11. A flying target always gets the picker; "Director picks" on an API card is kept.
  gobA.statuses.add("fly");
  const msg5 = use(forcedAbility({ tiers: { 1: { movement: ["push"], distance: "1" } } }), { 1: [tA] });
  await settle();
  assert.deepEqual([forcedOps(msg5)[0].mode, forcedOps(msg5)[0].flying], ["auto", true]);
  gobA.statuses.delete("fly");
  log.fm.length = 0;
  await api.forcedMovement({ targets: [tA.document], movement: "push", distance: 1, source: tHero.document, path: "choose" });
  assert.equal(log.fm[0].fastMove, false);
  home();
  console.log("ok review findings (delta Stamina undo, moves after the write, panel rows, grabs, cleared edits, half, Director-only edit, pull overshoot, flying, path)");
}

api.selfCheck();
console.log("\nALL HARNESS-6 TESTS PASSED");
