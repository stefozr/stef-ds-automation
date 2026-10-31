// Fifth harness (Milestone 2): turn lifecycle dedupe (refresh + _onEndTurn, Combat Tools squad proxy,
// second GM), saving throws (NPC auto, hero prompt / decline / no answer, system policy, one creature
// at a time), the toMessage save-part fix, the _onExit cleanup fix, ongoing damage (description and
// flag specs, once per turn, immunity, undo, off) and until end conditions. Reuses harness.mjs's world.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const paths = (await import("node:module")).createRequire(import.meta.url)("./paths.cjs"); const ROOT = paths.SCRIPTS;

globalThis.__HARNESS_SKIP_SCENARIOS__ = true;

/* ---------- mocks installed before the module loads ---------- */
const log = { systemDelegate: [], posted: [], refresh: [], exitDeleted: [] };
let nextSave = [];   // scripted save totals
let nextRoll = [];   // scripted ongoing damage totals
function setPath(obj, key, value) {
  const parts = key.split(".");
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) { o[parts[i]] ??= {}; o = o[parts[i]]; }
  o[parts.at(-1)] = value;
}
const getPath = (obj, key) => key.split(".").reduce((o, k) => o?.[k], obj);

globalThis.__HARNESS_SETUP__ = () => {
  game.modules.set("lib-wrapper", { active: true });
  globalThis.libWrapper = {
    registered: [],
    register(mod, target, fn, type) {
      const keys = target.split(".");
      const key = keys.pop();
      const parent = keys.reduce((o, k) => o[k], globalThis);
      const original = parent[key];
      parent[key] = function (...args) { return fn.call(this, original.bind(this), ...args); };
      this.registered.push({ mod, target, type });
    },
  };
  // Core registry (records calls; expiry itself is core's job and not mocked).
  class ActiveEffectRegistry { async refresh(event, context) { log.refresh.push({ event, combatant: context?.combat?.combatant?.id }); } }
  foundry.helpers = { ActiveEffectRegistry };
  foundry.documents.ActiveEffect = { registry: new ActiveEffectRegistry() };
  foundry.utils.getProperty = getPath;
  foundry.applications = { instances: new Map(), api: { DialogV2: { wait: async () => null } } };
  // System: rolls, save manager, combat.
  const DSRoll = ds.rolls.DSRoll;
  DSRoll.prototype.toMessage = async function (messageData = {}, { create = true } = {}) {
    // Mirrors draw-steel.mjs:795-835: the parts are REPLACED by one generic roll part.
    const data = { type: "standard", ...messageData, system: { ...(messageData.system ?? {}), parts: { genericRoll00000: { _id: "genericRoll00000", type: "roll", rolls: [this] } } } };
    if (!create) return data;
    return getDocumentClass("ChatMessage").create(data);
  };
  class SavingThrowRoll extends DSRoll {
    constructor(formula = "1d10", data = {}, options = {}) { super(undefined, options); this.formula = formula; }
    static replaceFormulaData(f) { return f; }
    get successThreshold() { return this.options.successThreshold ?? 6; }
    async evaluate() { this.total = nextSave.length ? nextSave.shift() : 1; return this; }
    get product() { return this.total >= this.successThreshold; }
    toJSON() { return { class: "SavingThrowRoll", formula: this.formula, total: this.total, evaluated: true, options: this.options }; }
  }
  ds.rolls.SavingThrowRoll = SavingThrowRoll;
  ds.applications = { apps: { SavingThrowManager: class { static async delegateSavingThrow(effect) { log.systemDelegate.push(effect.uuid); return true; } }, SavingThrowDialog: class {} } };
  class MockCombat {
    async _onEndTurn(combatant, context) {
      // draw-steel.mjs:12094-12103
      if (!combatant.actor || context?.skipped) return;
      for (const e of combatant.actor.appliedEffects) if (e.duration?.expiry === "save") ds.applications.apps.SavingThrowManager.delegateSavingThrow(e);
    }
    async _onExit(combatant) {
      // draw-steel.mjs:12075-12086 including the Set-of-characters bug
      const set = new Set("save", "combatEnd");
      const del = combatant.actor.effects.filter(e => e.duration.expired || (set.has(e.duration.expiry) && e._source.start.combat === this.id));
      combatant.actor.deleteEmbeddedDocuments("ActiveEffect", del.map(e => e.id));
    }
  }
  globalThis.CONFIG.Combat = { documentClass: MockCombat };
  foundry.dice = { Roll: class {
    // Like core: a static method that relies on `this` (calling it detached throws).
    static validate(formula) { return this.isFormula(formula); }
    static isFormula(formula) { return !/[=]/.test(formula) && /^[\d\sd+\-*/()@.a-z]+$/i.test(formula); }
    constructor(formula) { this.formula = formula; }
    async evaluate() { this.total = nextRoll.length ? nextRoll.shift() : 3; return this; }
    toJSON() { return { formula: this.formula, total: this.total }; }
  } };
  game.settings.register("core", "messageMode", { default: "public" });
};

const world = await import(new URL("./harness.mjs", import.meta.url).href);
const { settle, hero, tA, tB, gobA, gobB, api, getResolution, users, setUser, setActiveGM, Actor, registry, Message, messages } = world;
const { gm, gm2, player, player2 } = users;
const { claim, lifecycleIdle, onTurnEvent } = await import(pathToFileURL(ROOT + "turn/lifecycle.mjs").href);
const { scheduleExitCleanup } = await import(pathToFileURL(ROOT + "compat/system-fixes.mjs").href);
const { ongoingSpecs, parseDamageArgs, splitDamageArgs } = await import(pathToFileURL(ROOT + "turn/ongoing.mjs").href);
const { untilSpecs } = await import(pathToFileURL(ROOT + "turn/until.mjs").href);

const set = (key, value) => game.settings.set("stef-ds-automation", key, value);
const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));
const idle = async () => { await settle(); await lifecycleIdle(); await settle(); };

/* ---------- world bits ---------- */
Object.defineProperty(Actor.prototype, "hasPlayerOwner", { get() { return this.owners.size > 0; }, configurable: true });
Object.defineProperty(Actor.prototype, "documentName", { get() { return "Actor"; }, configurable: true });
Object.defineProperty(Actor.prototype, "appliedEffects", { get() { return this.effects.contents.filter(e => !e.duration?.expired && !e.disabled); }, configurable: true });
for (const a of [hero, gobA, gobB]) a.getRollData = () => ({});
game.users.filter = fn => [gm, gm2, player, player2].filter(fn);
player.character = { id: hero.id };
// GM -> player query: the handler runs on the player's client, the GM is `user`.
let playerOnline = true;
player.query = async (name, data) => {
  if (!playerOnline) throw new Error("timed out");
  const caller = game.user;
  setUser(player);
  try {
    return await CONFIG.queries[name](JSON.parse(JSON.stringify(data)), { user: caller });
  } catch (err) {
    throw new Error(err.message);
  } finally {
    setUser(caller);
  }
};
globalThis.ChatMessage = {
  getSpeaker: ({ actor } = {}) => ({ alias: actor?.name ?? "GM" }),
  async create(data) {
    const msg = new Message({ type: data.type, parts: data.system.parts, flags: data.flags, speaker: data.speaker });
    msg.rolls = data.rolls ?? [];
    msg.author = game.user;
    messages.set(msg.id, msg);
    Hooks.call("preCreateChatMessage", msg, data, {}, game.userId);
    Hooks.callAll("createChatMessage", msg, {}, game.userId);
    return msg;
  },
};
// The class the save code builds and posts (data in, applyMode, create).
class MockChatMessage {
  constructor(data) { this.data = data; }
  applyMode(mode) { this.data.mode = mode; }
  static getSpeaker({ actor } = {}) { return { alias: actor?.name ?? "GM" }; }
  static async create(src) {
    const data = src instanceof MockChatMessage ? src.data : src;
    const rec = { id: `msg${log.posted.length}`, data, rolls: data.rolls ?? [] };
    log.posted.push(rec);
    return rec;
  }
}
globalThis.getDocumentClass = () => MockChatMessage;

let effectN = 0;
class M2Effect {
  constructor(actor, { name = "Slowed", expiry = "save", description = "", flags = {}, combat = "combat0000000001" } = {}) {
    this._id = `m2eff${String(++effectN).padStart(11, "0")}`;
    Object.assign(this, { parent: actor, name, description, flags, disabled: false });
    this.duration = { expiry, expired: false };
    this._source = { start: { combat } };
    this.uuid = `${actor.uuid}.ActiveEffect.${this._id}`;
    this.system = { end: { roll: "1d10 + @combat.save.bonus" }, rollSave: async () => this.playerRoll?.() };
    actor.effects.set(this._id, this);
    registry.set(this.uuid, this);
  }
  get id() { return this._id; }
  get target() { return this.parent; }
  get actor() { return this.parent; }
  getRollData() { return {}; }
  getFlag(scope, key) { return this.flags?.[scope]?.[key]; }
  testUserPermission(user, level) { return this.parent.testUserPermission(user, level); }
  get isOwner() { return this.testUserPermission(game.user, "OWNER"); }
  async update(changes) { for (const [k, v] of Object.entries(changes)) setPath(this, k, v); return this; }
  async delete() { this.parent.effects.delete(this._id); }
}
const origDelete = Actor.prototype.deleteEmbeddedDocuments;
Actor.prototype.deleteEmbeddedDocuments = async function (type, ids, ...rest) {
  log.exitDeleted.push(...ids);
  return origDelete.call(this, type, ids, ...rest);
};
const clearEffects = () => { for (const a of [hero, gobA, gobB]) a.effects.clear(); };

// A started combat: hero, goblin A, goblin B (a two-minion "squad" for the Combat Tools proxy case).
const mkCombatant = (id, actor, token) => ({ id, name: actor.name, actor, token: token ?? null });
const cHero = mkCombatant("cmbHero000000001", hero, { uuid: "Scene.scene00000000001.Token.heroTok000000001", actor: hero });
const cA = mkCombatant("cmbGobA000000001", gobA, tA.document);
const cB = mkCombatant("cmbGobB000000001", gobB, tB.document);
const combat = new CONFIG.Combat.documentClass();
Object.assign(combat, {
  id: "combat0000000001", started: true, round: 1, turn: 0,
  combatants: new (class extends Map { [Symbol.iterator]() { return this.values(); } })([[cHero.id, cHero], [cA.id, cA], [cB.id, cB]]),
  combatant: cHero, previous: { combatantId: null, round: 1 },
});
world.setCombat(combat);
const registryRefresh = (event, ctx) => foundry.documents.ActiveEffect.registry.refresh(event, ctx);
const turnStart = (c, round = combat.round) => { combat.combatant = c; combat.round = round; return registryRefresh("turnStart", { combat, round, turn: 0 }); };
const turnEnd = async (c, round = combat.round) => {
  await combat._onEndTurn(c, { round, turn: 0 });
  combat.previous = { combatantId: c.id, round };
  return registryRefresh("turnEnd", { combat, round, turn: 0 });
};
const fullTurn = async (c, round) => { await turnStart(c, round); await turnEnd(c, round); };
const dsctProxyStart = (member, round = combat.round) => registryRefresh("turnStart", {
  combat: Object.create(combat, { combatant: { get: () => member, configurable: true } }), round, turn: 1,
});
const dsctProxyEnd = (member, round = combat.round) => registryRefresh("turnEnd", {
  combat: Object.create(combat, { previous: { value: { ...combat.previous, combatantId: member.id }, configurable: true } }), round, turn: 1,
});

const defaults = { heroSaves: "prompt", npcSaves: "auto", saveFallback: "auto", ongoingDamage: "auto", ongoingFromDescription: true, npcSaveMessageMode: "default" };
const reset = () => { for (const [k, v] of Object.entries(defaults)) set(k, v); };
reset();

/* ---------- wrappers installed ---------- */
{
  const targets = libWrapper.registered.map(r => `${r.target}:${r.type}`);
  for (const t of [
    "ds.rolls.DSRoll.prototype.toMessage:WRAPPER",
    "CONFIG.Combat.documentClass.prototype._onExit:WRAPPER",
    "foundry.helpers.ActiveEffectRegistry.prototype.refresh:WRAPPER",
    "CONFIG.Combat.documentClass.prototype._onEndTurn:MIXED",
    "ds.applications.apps.SavingThrowManager.delegateSavingThrow:MIXED",
  ]) assert.ok(targets.includes(t), `registered ${t}`);
  assert.ok(!libWrapper.registered.some(r => r.type === "OVERRIDE"));
  const sc = api.selfCheck();
  assert.equal(sc.report.libWrapperReady, true);
  assert.equal(sc.report.fixSaveMessage, true);
  assert.equal(sc.report.fixExitCleanup, true);
  assert.equal(sc.report.promptQueryRegistered, true);
  assert.equal(CONFIG.ActiveEffect.expiryEvents.dsAutoUntil, "DSAUTO.Until.ExpiryLabel");
  console.log("ok wrappers + selfCheck");
}

/* ---------- lifecycle: one event per combatant, proxies and repeats filtered ---------- */
{
  const seen = [];
  const off = onTurnEvent(p => seen.push(`${p.event}:${p.combatant.id}:${p.round}`));
  await turnStart(cA, 1);
  await turnStart(cA, 1);           // a second refresh for the same turn
  await turnEnd(cA, 1);
  await dsctProxyEnd(cA, 1);        // Combat Tools repeats the activated member
  await dsctProxyEnd(cB, 1);        // ... and ends the other squad member's turn
  await idle();
  assert.deepEqual(seen, ["turnStart:cmbGobA000000001:1", "turnEnd:cmbGobA000000001:1", "turnEnd:cmbGobB000000001:1"]);
  // Second GM client: nothing.
  setActiveGM(gm2);
  await turnStart(cHero, 1);
  await idle();
  setActiveGM(gm);
  assert.equal(seen.length, 3, "only the active GM dispatches");
  // Combat not started: nothing.
  combat.started = false;
  await turnStart(cHero, 2);
  combat.started = true;
  await idle();
  assert.equal(seen.length, 3);
  off();
  assert.equal(claim("x", 1, "c", "e"), true);
  assert.equal(claim("x", 1, "c", "e"), false);
  console.log("ok lifecycle dedupe");
}

/* ---------- _onEndTurn: once per (combat, round, combatant), active GM only ---------- */
{
  set("npcSaves", "system");
  const e = new M2Effect(gobA, { name: "Slowed" });
  log.systemDelegate.length = 0;
  await turnStart(cA, 5);
  await combat._onEndTurn(cA, { round: 5, turn: 1 });
  await combat._onEndTurn(cA, { round: 5, turn: 1 }); // Combat Tools fireEndTurn for the same member
  assert.deepEqual(log.systemDelegate, [e.uuid], "one save per effect");
  setActiveGM(gm2);
  await combat._onEndTurn(cB, { round: 5, turn: 2 });
  setActiveGM(gm);
  await combat._onEndTurn(cA, { round: 5, turn: 1 });
  assert.equal(log.systemDelegate.length, 1, "no new activation, no new save");
  await turnStart(cA, 6);
  await combat._onEndTurn(cA, { round: 6, turn: 1 });
  assert.equal(log.systemDelegate.length, 2, "next activation counts again");
  // A solo monster's second turn in the same round is a new activation too.
  await turnEnd(cA, 6);
  await turnStart(cA, 6);
  await combat._onEndTurn(cA, { round: 6, turn: 1 });
  await combat._onEndTurn(cA, { round: 6, turn: 1 });
  assert.equal(log.systemDelegate.length, 3, "the turn end repeats the claimed activation; the second activation saves once");
  // skipped turns are passed through (the system returns early itself)
  await combat._onEndTurn(cA, { round: 6, turn: 1, skipped: true });
  assert.equal(log.systemDelegate.length, 3);
  clearEffects();
  reset();
  console.log("ok _onEndTurn dedupe (squad repeat, second GM)");
}

/* ---------- NPC saves roll themselves ---------- */
{
  log.posted.length = 0;
  const ok = new M2Effect(gobA, { name: "Slowed" });
  nextSave = [7];
  const r1 = await ds.applications.apps.SavingThrowManager.delegateSavingThrow(ok);
  assert.equal(r1, true);
  assert.equal(ok.duration.expired, true, "success marks it expired, like rollSave");
  const [card] = log.posted;
  const part = card.data.system.parts.savingThrow00000;
  assert.equal(part.type, "savingThrow");
  assert.equal(part.effectUuid, ok.uuid);
  assert.equal(card.data.mode, "public", "Director's roll mode (core setting)");
  assert.equal(card.data.flags["stef-ds-automation"].save.product, true);
  const fail = new M2Effect(gobB, { name: "Weakened" });
  nextSave = [3];
  assert.equal(await ds.applications.apps.SavingThrowManager.delegateSavingThrow(fail), false);
  assert.equal(fail.duration.expired, false);
  set("npcSaveMessageMode", "gm");
  nextSave = [2];
  await ds.applications.apps.SavingThrowManager.delegateSavingThrow(fail);
  assert.equal(log.posted.at(-1).data.mode, "gm");
  // An effect that is no longer "save ends" (or gone) is not rolled.
  fail.duration.expiry = "turnEnd";
  const before = log.posted.length;
  assert.equal(await ds.applications.apps.SavingThrowManager.delegateSavingThrow(fail), false);
  assert.equal(log.posted.length, before);
  // dsAuto.preSave can veto.
  fail.duration.expiry = "save";
  const veto = Hooks.on("dsAuto.preSave", () => false);
  assert.equal(await ds.applications.apps.SavingThrowManager.delegateSavingThrow(fail), false);
  assert.equal(log.posted.length, before);
  world.offHook("dsAuto.preSave", veto);
  clearEffects();
  reset();
  console.log("ok NPC auto saves (expired on success, savingThrow part, visibility, veto)");
}

/* ---------- hero saves: the owner is asked ---------- */
{
  log.posted.length = 0;
  const e = new M2Effect(hero, { name: "Dazed" });
  let asked = 0;
  e.playerRoll = async () => {
    asked++;
    assert.equal(game.user, player, "runs on the player's client");
    await e.update({ "duration.expired": true });
    return { id: "playerSave", rolls: [{ product: true, total: 8 }] };
  };
  const results = [];
  const h = Hooks.on("dsAuto.save", (_eff, r) => results.push(r));
  assert.equal(await ds.applications.apps.SavingThrowManager.delegateSavingThrow(e), true);
  assert.equal(asked, 1);
  assert.equal(log.posted.length, 0, "the player's own save card, nothing from the Director");
  assert.equal(results.at(-1).by, "pl");
  // Declined: no fallback roll.
  const d = new M2Effect(hero, { name: "Bleeding" });
  d.playerRoll = async () => undefined;
  assert.equal(await ds.applications.apps.SavingThrowManager.delegateSavingThrow(d), false);
  assert.equal(log.posted.length, 0);
  assert.equal(results.at(-1).declined, true);
  // No answer: the Director's client rolls, with a note.
  playerOnline = false;
  nextSave = [9];
  assert.equal(await ds.applications.apps.SavingThrowManager.delegateSavingThrow(d), true);
  assert.equal(log.posted.length, 1);
  assert.match(log.posted[0].data.system.parts.savingThrow00000.flavor, /Save\.Note\.noAnswer/);
  assert.equal(log.posted[0].data.mode, "public", "hero saves are public");
  playerOnline = true;
  // No owner connected.
  player.active = false;
  const n = new M2Effect(hero, { name: "Frightened" });
  nextSave = [1];
  assert.equal(await ds.applications.apps.SavingThrowManager.delegateSavingThrow(n), false);
  assert.match(log.posted.at(-1).data.system.parts.savingThrow00000.flavor, /Save\.Note\.noOwner/);
  player.active = true;
  // Only a GM may send the prompt.
  setUser(player2);
  await assert.rejects(CONFIG.queries["stef-ds-automation.prompt"]({ type: "save", effectUuid: n.uuid }, { user: player2 }), /Denied/);
  setUser(gm);
  // A player cannot be prompted for an effect they do not own.
  setUser(player2);
  await assert.rejects(CONFIG.queries["stef-ds-automation.prompt"]({ type: "save", effectUuid: n.uuid }, { user: gm }), /Denied/);
  setUser(gm);
  // heroSaves "system": the system's routine runs.
  set("heroSaves", "system");
  log.systemDelegate.length = 0;
  await ds.applications.apps.SavingThrowManager.delegateSavingThrow(n);
  assert.deepEqual(log.systemDelegate, [n.uuid]);
  world.offHook("dsAuto.save", h);
  clearEffects();
  reset();
  console.log("ok hero saves (prompt, decline, no answer, no owner, system)");
}

/* ---------- one creature's prompts come one after another; repeats share the run ---------- */
{
  const order = [];
  const mk = (name) => {
    const e = new M2Effect(hero, { name });
    e.playerRoll = async () => { order.push(`open ${name}`); await wait(15); order.push(`close ${name}`); return { id: name, rolls: [{ product: false, total: 2 }] }; };
    return e;
  };
  const a = mk("A"), b = mk("B");
  const SM = ds.applications.apps.SavingThrowManager;
  const p1 = SM.delegateSavingThrow(a); // not awaited, like the system
  const p2 = SM.delegateSavingThrow(b);
  const p3 = SM.delegateSavingThrow(a); // the same effect again while it is in flight
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(order, ["open A", "close A", "open B", "close B"]);
  clearEffects();
  console.log("ok saves serialized per creature");
}

/* ---------- fix: save cards keep the savingThrow part ---------- */
{
  log.posted.length = 0;
  const roll = new ds.rolls.SavingThrowRoll("1d10", {}, {});
  await roll.evaluate();
  const part = { _id: "savingThrow00000", type: "savingThrow", effectUuid: "Actor.x.ActiveEffect.y", rolls: [roll] };
  await roll.toMessage({ rolls: [roll], system: { parts: { savingThrow00000: part } } });
  const parts = log.posted[0].data.system.parts;
  assert.deepEqual(Object.keys(parts), ["savingThrow00000"]);
  assert.equal(parts.savingThrow00000.effectUuid, "Actor.x.ActiveEffect.y");
  assert.equal(typeof parts.savingThrow00000.rolls[0], "string", "rolls serialized for the JSONField");
  // create: false returns the data
  const data = await roll.toMessage({ system: { parts: { savingThrow00000: part } } }, { create: false });
  assert.ok(data.system.parts.savingThrow00000);
  // Other rolls keep the system behaviour.
  const plain = new ds.rolls.DSRoll(4, {});
  await plain.toMessage({ system: { parts: { savingThrow00000: part } } });
  assert.deepEqual(Object.keys(log.posted.at(-1).data.system.parts), ["genericRoll00000"]);
  console.log("ok fix: savingThrow part kept");
}

/* ---------- fix: a leaving combatant's encounter effects are deleted ---------- */
{
  log.exitDeleted.length = 0;
  const saveEnds = new M2Effect(gobA, { name: "Slowed", expiry: "save" });
  const eot = new M2Effect(gobA, { name: "Taunted", expiry: "turnEnd" });
  const encounter = new M2Effect(gobA, { name: "Marked", expiry: "combatEnd" });
  const expired = new M2Effect(gobA, { name: "Old", expiry: "save" });
  expired.duration.expired = true;
  const lasting = new M2Effect(gobA, { name: "Kit", expiry: null });
  const otherCombat = new M2Effect(gobA, { name: "Elsewhere", expiry: "save", combat: "combat0000000002" });
  const respite = new M2Effect(gobA, { name: "Rested", expiry: "respite" });
  await combat._onExit(cA);
  assert.deepEqual(log.exitDeleted, [expired.id], "the system alone deletes only expired effects");
  await wait(450);
  for (const e of [saveEnds, eot, encounter]) assert.ok(!gobA.effects.has(e.id), `${e.name} deleted`);
  for (const e of [lasting, otherCombat, respite]) assert.ok(gobA.effects.has(e.id), `${e.name} kept`);
  // Not the active GM: nothing scheduled.
  const again = new M2Effect(gobA, { name: "Slowed again", expiry: "save" });
  setActiveGM(gm2);
  assert.equal(scheduleExitCleanup(combat, cA, 1), null);
  setActiveGM(gm);
  assert.ok(gobA.effects.has(again.id));
  clearEffects();
  console.log("ok fix: exit cleanup");
}

/* ---------- ongoing damage ---------- */
{
  const burning = new M2Effect(gobA, {
    name: "Burning", expiry: "save",
    description: "<p>A burning creature takes [[/damage 1d6 fire]] damage at the start of each of their turns. A burning object takes 1d6 fire damage at the end of each round.</p>",
  });
  assert.deepEqual(ongoingSpecs(burning).map(s => [s.formula, s.type, s.when, s.from]), [["1d6", "fire", "turnStart", "description"]]);
  assert.deepEqual(splitDamageArgs("2d6 + 3 holy"), { formula: "2d6 + 3", type: "holy" });
  const before = messages.size;
  nextRoll = [5];
  await turnStart(cA, 10);
  await turnStart(cA, 10); // repeated refresh: still one tick
  await idle();
  assert.equal(messages.size, before + 1, "one card per turn start");
  const card = messages.contents.at(-1);
  const res = getResolution(card);
  assert.equal(res.ongoing.effectUuid, burning.uuid);
  assert.equal(res.synthetic, true);
  const [op] = Object.values(res.ops);
  assert.equal(op.status, "applied");
  assert.equal(op.type, "fire");
  assert.equal(gobA.system.stamina.value, 20 - 3, "5 fire minus fire immunity 2");
  assert.equal(card.rolls.length, 1, "the roll rides on the card (Dice So Nice)");
  await api.undoOps(card.id);
  assert.equal(gobA.system.stamina.value, 20, "undo restores");
  // Turn end does not tick a turn-start effect; the next round does.
  await turnEnd(cA, 10);
  await idle();
  assert.equal(messages.size, before + 1);
  nextRoll = [1];
  await turnStart(cA, 11);
  await idle();
  assert.equal(messages.size, before + 2);
  await api.undoOps(messages.contents.at(-1).id);
  // Flag spec at turn end, untyped; an effect text without "each of their turns" is ignored.
  burning.description = "takes [[/damage 15]] damage at the start of your next turn";
  assert.deepEqual(ongoingSpecs(burning), []);
  const bleed = new M2Effect(gobB, { name: "Acid", expiry: "turnEnd", flags: { "stef-ds-automation": { ongoing: { formula: "2", when: "turnEnd" } } } });
  assert.equal(ongoingSpecs(bleed)[0].from, "flag");
  nextRoll = [2];
  await fullTurn(cB, 11);
  await idle();
  assert.equal(gobB.system.stamina.value, 18);
  await api.undoOps(messages.contents.at(-1).id);
  // Mode "manual": the card waits.
  set("ongoingDamage", "manual");
  await fullTurn(cB, 12);
  await idle();
  const manual = getResolution(messages.contents.at(-1));
  assert.equal(Object.values(manual.ops)[0].status, "pending");
  assert.equal(gobB.system.stamina.value, 20);
  // Off: nothing; dead creatures: nothing; text matching off: nothing.
  set("ongoingDamage", "off");
  const n0 = messages.size;
  await fullTurn(cB, 13);
  await idle();
  set("ongoingDamage", "auto");
  gobB.statuses.add("dead");
  await fullTurn(cB, 14);
  await idle();
  gobB.statuses.delete("dead");
  burning.description = "<p>A burning creature takes [[/damage 1d6 fire]] damage at the start of each of their turns.</p>";
  set("ongoingFromDescription", false);
  await turnStart(cA, 15);
  await idle();
  assert.equal(messages.size, n0);
  // dsAuto.preOngoing can veto.
  set("ongoingFromDescription", true);
  const veto = Hooks.on("dsAuto.preOngoing", () => false);
  await turnStart(cA, 16);
  await idle();
  assert.equal(messages.size, n0);
  world.offHook("dsAuto.preOngoing", veto);
  clearEffects();
  reset();
  gobA.system.stamina.value = 20; gobB.system.stamina.value = 20;
  console.log("ok ongoing damage (description + flag, once per turn, immunity, undo, modes, veto)");
}

/* ---------- until: next turn end / start, dying, moves ---------- */
{
  // Set during goblin A's own turn: its current turn end does not count.
  combat.combatant = cA;
  const mark = new M2Effect(gobB, { name: "Marked", expiry: "turnEnd" });
  await api.until(mark, { event: "turnEnd", combatantId: cA.id });
  assert.equal(mark.duration.expiry, "dsAutoUntil");
  assert.equal(untilSpecs(mark)[0].armed, false);
  await turnEnd(cA, 20);
  await idle();
  assert.equal(mark.duration.expired, false, "not at the end of the current turn");
  await turnStart(cA, 21);
  await idle();
  assert.equal(untilSpecs(mark)[0].armed, true, "armed when its next turn starts");
  await turnEnd(cA, 21);
  await idle();
  assert.equal(mark.duration.expired, true, "ends at the end of its next turn");
  // Set outside that combatant's turn: its next turn end counts at once. keepExpiry keeps "save".
  combat.combatant = cHero;
  const guard = new M2Effect(gobA, { name: "Guarded", expiry: "save" });
  await api.until(guard, [{ event: "turnStart", combatantId: cHero.id }], { keepExpiry: true });
  assert.equal(guard.duration.expiry, "save");
  await turnStart(cB, 22);
  await idle();
  assert.equal(guard.duration.expired, false, "another combatant's turn");
  await turnStart(cHero, 22);
  await idle();
  assert.equal(guard.duration.expired, true);
  // Dying / moves.
  const shield = new M2Effect(hero, { name: "Shield" });
  await api.until(shield, { event: "dying" });
  Hooks.callAll("updateActor", hero, {});
  await settle();
  assert.equal(shield.duration.expired, false);
  hero.statuses.add("dying");
  Hooks.callAll("updateActor", hero, {});
  await settle();
  assert.equal(shield.duration.expired, true);
  hero.statuses.delete("dying");
  const hidden = new M2Effect(gobA, { name: "Hidden" });
  await api.until(hidden, { event: "moves" });
  Hooks.callAll("updateToken", tA.document, { name: "x" });
  await settle();
  assert.equal(hidden.duration.expired, false);
  Hooks.callAll("updateToken", tA.document, { x: 100 });
  await settle();
  assert.equal(hidden.duration.expired, true);
  // expiryAction "delete" deletes instead.
  CONFIG.ActiveEffect.expiryAction = "delete";
  const gone = new M2Effect(gobA, { name: "Gone" });
  await api.until(gone, { event: "moves" });
  Hooks.callAll("updateToken", tA.document, { y: 5 });
  await settle();
  assert.ok(!gobA.effects.has(gone.id));
  CONFIG.ActiveEffect.expiryAction = "update";
  await assert.rejects(api.until(gone, { event: "nonsense" }), /BadRequest/);
  await assert.rejects(api.until(hidden, { event: "turnEnd" }), /BadRequest/, "turn specs need a combatant");
  clearEffects();
  console.log("ok until (next turn end / start, keepExpiry, dying, moves, delete action)");
}

/* ---------- review findings (0.4.0) ---------- */
{
  // 1. Solo monster: two activations in one round => two saves, two ongoing ticks.
  log.posted.length = 0;
  const slowed = new M2Effect(gobA, { name: "Slowed" });
  const burn = new M2Effect(gobA, { name: "Burning", expiry: "combatEnd", description: "takes [[/damage 1d6 fire]] damage at the start of each of their turns" });
  const n0 = messages.size;
  nextSave = [1, 1];
  nextRoll = [4, 4];
  await fullTurn(cA, 40);
  await idle();
  await fullTurn(cA, 40);
  await idle();
  assert.equal(log.posted.filter(c => c.data.flags["stef-ds-automation"]?.save).length, 2, "a save per activation");
  assert.equal(messages.size, n0 + 2, "a Burning tick per activation");
  for (const m of messages.contents.slice(-2)) await api.undoOps(m.id);
  burn.delete(); slowed.delete();

  // 2. The combatant is read before the refresh awaits: a later change of combat.previous does not matter.
  const seen = [];
  const off = onTurnEvent(p => seen.push(`${p.event}:${p.combatant.id}`));
  await turnStart(cHero, 41);
  combat.previous = { combatantId: cHero.id, round: 41 };
  const pending = registryRefresh("turnEnd", { combat, round: 41, turn: 0 });
  combat.previous = { combatantId: null, round: 41 }; // core rewrites it in place meanwhile
  await pending;
  await idle();
  assert.ok(seen.includes(`turnEnd:${cHero.id}`), "turn end attributed to the snapshot");
  // Skipped turns (alternative initiative) are ignored.
  await registryRefresh("turnStart", { combat, round: 42, turn: 0, skipped: true });
  await idle();
  assert.equal(seen.filter(x => x === `turnStart:${cHero.id}`).length, 1, "the skipped turn start is not delivered");
  off();

  // 3. No double roll: the owner's save ended the effect although the query failed.
  const e = new M2Effect(hero, { name: "Dazed" });
  e.playerRoll = async () => { await e.update({ "duration.expired": true }); throw new Error("message create failed"); };
  log.posted.length = 0;
  assert.equal(await ds.applications.apps.SavingThrowManager.delegateSavingThrow(e), true);
  assert.equal(log.posted.length, 0, "no fallback roll for an effect that already ended");
  e.delete();

  // 4. "/damage" options as the system parses them.
  assert.deepEqual(parseDamageArgs("1d6 type=holy"), [{ formula: "1d6", type: "holy", ignoredImmunities: [] }]);
  assert.deepEqual(parseDamageArgs("2 fire scaling &amp; 1d4 type=holy/fire ignoredImmunities=fire aoe"), [
    { formula: "2", type: "fire", ignoredImmunities: [] },
    { formula: "1d4", type: "holy", ignoredImmunities: ["fire"] },
  ]);
  const acidic = new M2Effect(gobB, { name: "Acidic", expiry: "combatEnd", description: "takes [[/damage 3 type=holy]] damage at the start of each of their turns" });
  assert.deepEqual(ongoingSpecs(acidic).map(x => [x.formula, x.type]), [["3", "holy"]]);
  acidic.delete();

  // 5. Turn-end ongoing damage ticks even when that turn's save ends the effect first.
  const acid = new M2Effect(gobB, { name: "Acid", expiry: "save", flags: { "stef-ds-automation": { ongoing: { formula: "2", when: "turnEnd" } } } });
  nextSave = [10];
  nextRoll = [2];
  const n1 = messages.size;
  await fullTurn(cB, 43);
  await idle();
  assert.equal(acid.duration.expired, true, "saved");
  assert.equal(messages.size, n1 + 1, "still took the turn-end damage");
  assert.equal(gobB.system.stamina.value, 18);
  await api.undoOps(messages.contents.at(-1).id);
  acid.delete();

  // 6. Until: a Combat Tools squad follower acting now does not lose its next turn end.
  combat.combatant = cA;
  await dsctProxyStart(cB, 44);
  await idle();
  const mark = new M2Effect(gobA, { name: "Marked", expiry: "turnEnd" });
  await api.until(mark, { event: "turnEnd", combatantId: cB.id });
  assert.equal(untilSpecs(mark)[0].armed, false, "follower's turn is open");
  mark.delete();

  // 7. Module off: the system's save routine runs.
  set("enabled", false);
  const z = new M2Effect(gobA, { name: "Slowed" });
  log.systemDelegate.length = 0;
  await ds.applications.apps.SavingThrowManager.delegateSavingThrow(z);
  assert.deepEqual(log.systemDelegate, [z.uuid]);
  set("enabled", true);
  clearEffects();
  reset();
  console.log("ok review findings (solo turns, snapshot, no double save, /damage options, turn-end snapshot, follower until, master switch)");
}

console.log("\nALL HARNESS-5 TESTS PASSED");
