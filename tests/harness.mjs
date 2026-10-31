// Node harness: runs stef-ds-automation's real modules against mocked Foundry / Draw Steel APIs.
// Usage: node harness.mjs
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const paths = (await import("node:module")).createRequire(import.meta.url)("./paths.cjs"); const ROOT = paths.SCRIPTS;
const imp = (p) => import(pathToFileURL(ROOT + p).href);

/* ---------------- generic helpers ---------------- */
class ForcedDeletion {}
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v) && !(v instanceof ForcedDeletion);
function setProperty(obj, key, value) {
  const parts = key.split(".");
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) { o[parts[i]] ??= {}; o = o[parts[i]]; }
  o[parts.at(-1)] = value;
}
function expandObject(flatObj) {
  const out = {};
  for (const [k, v] of Object.entries(flatObj)) setProperty(out, k, v);
  return out;
}
function merge(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (v instanceof ForcedDeletion) { delete target[k]; continue; }
    if (isObj(v)) { if (!isObj(target[k])) target[k] = {}; merge(target[k], v); }
    else target[k] = Array.isArray(v) ? structuredClone(v) : v;
  }
  return target;
}
const deepClone = (o) => (o === undefined ? o : JSON.parse(JSON.stringify(o)));
class Collection extends Map {
  get contents() { return [...this.values()]; }
  find(fn) { return this.contents.find(fn); }
  filter(fn) { return this.contents.filter(fn); }
  some(fn) { return this.contents.some(fn); }
  first() { return this.contents[0]; }
  [Symbol.iterator]() { return this.values(); }
}

/* ---------------- hooks ---------------- */
const hookFns = {};
const Hooks = {
  on(name, fn) { (hookFns[name] ??= []).push(fn); return fn; },
  once(name, fn) { (hookFns[name] ??= []).push(fn); return fn; },
  call(name, ...args) { for (const fn of hookFns[name] ?? []) if (fn(...args) === false) return false; return true; },
  callAll(name, ...args) { for (const fn of hookFns[name] ?? []) fn(...args); return true; },
  onError(where, err) { console.error("Hooks.onError", where, err); throw err; },
};

/* ---------------- rolls ---------------- */
class DSRoll { constructor(total, options = {}) { this.total = total; this.options = options; } }
class PowerRoll extends DSRoll { get product() { return this.options.tier; } }
class DamageRoll extends DSRoll {
  get type() { return this.options.type ?? (this.isHeal ? "value" : ""); }
  get isHeal() { return !!this.options.isHeal; }
  get ignoredImmunities() { return this.options.ignoredImmunities ?? []; }
  get aoe() { return !!this.options.aoe; }
}

/* ---------------- uuid registry ---------------- */
const registry = new Map();
const fromUuidSync = (u) => registry.get(u) ?? null;
const fromUuid = async (u) => registry.get(u) ?? null;

/* ---------------- actors / effects ---------------- */
let idCounter = 0;
const randomID = () => `id${String(++idCounter).padStart(14, "0")}`;
class Effect {
  constructor(data, parent) { Object.assign(this, deepClone(data)); this._id ??= randomID(); this.parent = parent; this.flags ??= {}; }
  get id() { return this._id; }
  getFlag(scope, key) { return this.flags?.[scope]?.[key]; }
  toObject() { const { parent, ...rest } = this; return deepClone(rest); }
  async update(changes) { for (const [k, v] of Object.entries(changes)) setProperty(this, k, v); return this; }
}
class Actor {
  constructor({ uuid, name, type = "npc", stamina = 20, temp = 0, immunities = {}, weaknesses = {}, chr = {}, minion = false }) {
    Object.assign(this, { uuid, name, type, owners: new Set(), statuses: new Set(), effects: new Collection(), isMinion: minion });
    this.id = uuid.split(".").at(-1);
    const actor = this;
    this.system = {
      stamina: { value: stamina, temporary: temp, max: stamina, min: -10 },
      damage: { immunities: { all: 0, ...immunities }, weaknesses: { all: 0, ...weaknesses } },
      characteristics: Object.fromEntries(Object.entries(chr).map(([k, v]) => [k, { value: v, resist: 0 }])),
      combatGroups: new Collection(),
      get combatGroup() { return this.combatGroups.first() ?? null; },
      calculateImmunityAndWeakness({ type, ignoredImmunities = [] } = {}) {
        const out = {};
        const w = Math.max(this.damage.weaknesses.all, this.damage.weaknesses[type] ?? 0);
        if (w > 0) out.weakness = w;
        const imm = Object.entries(this.damage.immunities).filter(([t]) => !ignoredImmunities.includes(t) && !ignoredImmunities.includes("all"));
        const i = Math.max(Object.fromEntries(imm).all ?? 0, Object.fromEntries(imm)[type] ?? 0);
        if (i > 0) out.immunity = i;
        return out;
      },
      async takeDamage(amount, opts) {
        const { immunity = 0, weakness = 0 } = this.calculateImmunityAndWeakness(opts);
        const dmg = Math.max(0, amount + weakness - immunity);
        if (!dmg) return actor;
        return actor.modifyTokenAttribute("stamina", -dmg, true, false);
      },
      checkPotency(value, chr) { const c = this.characteristics[chr]; if (!c) throw new Error("bad chr"); return value > c.value + c.resist; },
    };
  }
  get appliedEffects() { return this.effects.contents; }
  testUserPermission(user, level) { if (level !== "OWNER") throw new Error("only OWNER mocked"); return !!user?.isGM || this.owners.has(user?.id); }
  get isOwner() { return this.testUserPermission(game.user, "OWNER"); }
  checkPotency(v, c) { return this.system.checkPotency(v, c); }
  getActiveTokens() { return []; }
  async modifyTokenAttribute(attr, value, isDelta) {
    const s = this.system.stamina;
    if (attr === "stamina.temporary") { s.temporary = isDelta ? s.temporary + value : value; return this; }
    if (value < 0) { const d = -value; const t = Math.min(d, s.temporary); s.temporary -= t; s.value = Math.max(s.min, s.value - (d - t)); }
    else s.value = Math.min(s.max, s.value + value);
    if (s.value <= 0) this.statuses.add("dead");
    return this;
  }
  async update(changes) {
    for (const [k, v] of Object.entries(changes)) setProperty(this, k, v);
    if (this.system.stamina.value > 0) this.statuses.delete("dead");
    return this;
  }
  async deleteEmbeddedDocuments(_t, ids) { for (const id of ids) this.effects.delete(id); }
  async createEmbeddedDocuments(_t, data) { return data.map(d => { const e = new Effect(d, this); this.effects.set(e.id, e); return e; }); }
}
class Squad {
  constructor(uuid, name, minions) {
    Object.assign(this, { uuid, name, id: uuid.split(".").at(-1) });
    const squad = this;
    this.system = {
      staminaValue: 30, staminaMax: 30,
      async takeDamage(minions, per, opts) {
        let imm = 0, weak = 0;
        for (const m of minions) { const r = m.system.calculateImmunityAndWeakness(opts); imm = Math.max(imm, r.immunity ?? 0); weak = Math.max(weak, r.weakness ?? 0); }
        if (opts.aoe) per = Math.min(per, minions[0].system.stamina.max);
        const dmg = Math.max(0, per * minions.length + weak - imm);
        this.staminaValue -= dmg;
        return squad;
      },
    };
    for (const m of minions) m.system.combatGroups.set(this.id, this);
  }
  async update(changes) { for (const [k, v] of Object.entries(changes)) setProperty(this, k, v); return this; }
}

/* ---------------- abilities ---------------- */
function makeAbility({ uuid, name, actor, damage = true, applied = null, choose = false }) {
  const pres = new Collection();
  if (damage) pres.set("dmgPRE0000000001", { id: "dmgPRE0000000001", type: "damage", name: "Damage" });
  if (applied) {
    const pre = {
      id: "appPRE0000000001", type: "applied", name: "Effect",
      applied: applied,
      async applyEffect(tierKey, effectId, { targets }) {
        const cfg = this.applied[tierKey].effects[effectId];
        const status = globalThis.CONFIG.statusEffects.find(s => s.id === effectId);
        const out = [];
        for (const a of targets) {
          const combatant = game.combat?.getCombatantsByActor(a)[0];
          const data = { _id: status._id, name: effectId, statuses: [effectId], duration: { expiry: cfg.end ? ds.CONFIG.effectEnds[cfg.end].expiryEvent : null }, start: { combatant: combatant?.id ?? null } };
          a.effects.delete(status._id);
          const e = new Effect(data, a);
          a.effects.set(e.id, e);
          a.statuses.add(effectId);
          out.push([e]);
        }
        return out;
      },
    };
    pres.set(pre.id, pre);
  }
  const item = {
    uuid, name, actor, type: "ability",
    system: {
      _dsid: name.toLowerCase().replace(/\W+/g, "-"),
      power: { effects: pres },
      effects: { contents: choose ? [{ type: "dsct.choose", choose: { choices: [{ effects: ["x"] }] } }] : [] },
    },
    effects: new Collection(),
    getRollData() { return { potency: { weak: 1, average: 2, strong: 3 } }; },
  };
  registry.set(uuid, item);
  return item;
}

/* ---------------- messages ---------------- */
class Part {
  constructor(src) { Object.assign(this, deepClone(src)); this.rolls = (src.rolls ?? []).map(r => r); }
  get id() { return this._id; }
}
class Message {
  constructor(data) {
    this.id = randomID();
    this.type = data.type;
    this.flags = deepClone(data.flags ?? {});
    this.speaker = data.speaker ?? {};
    this.whisper = data.whisper ?? [];
    this.blind = false;
    this.isAuthor = true;
    this.updates = 0;
    this._srcParts = data.parts; // with roll objects
    this._source = { system: { parts: Object.fromEntries(Object.entries(data.parts).map(([k, p]) => [k, { ...p, rolls: (p.rolls ?? []).map(r => JSON.stringify({ options: r.options, total: r.total })) }])) } };
    this.#build();
  }
  #build() {
    const parts = new Collection();
    for (const [k, p] of Object.entries(this._srcParts)) parts.set(k, new Part(p));
    this.system = { parts };
  }
  updateSource(changes) {
    const exp = expandObject(changes);
    if (exp.flags) merge(this.flags, exp.flags);
    if (exp.system?.parts) { for (const [k, v] of Object.entries(exp.system.parts)) { this._srcParts[k] = v; this._source.system.parts[k] = v; } this.#build(); }
  }
  getFlag(scope, key) { return this.flags?.[scope]?.[key]; }
  async update(changes, { userId = "gm" } = {}) {
    this.updates++;
    const exp = expandObject(changes);
    if (exp.flags) merge(this.flags, exp.flags);
    if (exp.system?.parts) { for (const [k, v] of Object.entries(exp.system.parts)) this._srcParts[k] = { ...(this._srcParts[k] ?? {}), ...v }; this.#build(); }
    Hooks.callAll("updateChatMessage", this, exp, {}, userId);
    return this;
  }
}

/* ---------------- globals ---------------- */
const settingsStore = new Map();
const messages = new Collection();
const notifications = [];
globalThis.Hooks = Hooks;
globalThis.fromUuidSync = fromUuidSync;
globalThis.fromUuid = fromUuid;
globalThis.ui = { notifications: { warn: (m) => notifications.push(["warn", m]), error: (m) => notifications.push(["error", m]), info: () => {} } };
globalThis.window = globalThis;
globalThis.document = { addEventListener() {}, querySelector() { return null; } };
globalThis.foundry = {
  utils: { deepClone, isNewerVersion: (a, b) => a.localeCompare(b, undefined, { numeric: true }) > 0, randomID },
  data: { operators: { ForcedDeletion } },
  documents: { ChatMessage: class {} },
};
globalThis.CONFIG = {
  statusEffects: [
    { id: "slowed", _id: "slowed0000000000", name: "DRAW_STEEL.ActiveEffect.Slowed", img: "slowed.svg" },
    { id: "frightened", _id: "frightened000000", name: "DRAW_STEEL.ActiveEffect.Frightened" },
    { id: "dead", _id: "dead000000000000", name: "Dead" },
  ],
  specialStatusEffects: { DEFEATED: "dead" },
  queries: {},
  ActiveEffect: { expiryEvents: {}, expiryAction: "update" },
  ChatMessage: { dataModels: { standard: { schema: { fields: { parts: { element: { types: {} } } } } } } },
};
class BaseMessagePart {
  static ACTIONS = { selectToken() {} };
  get message() { return this._message; }
  get isContentVisible() { return true; }
  async _prepareContext(context) { context.ctx = {}; }
}
globalThis.ds = {
  rolls: { DSRoll, PowerRoll, DamageRoll },
  data: { pseudoDocuments: { messageParts: { BaseMessagePart }, powerRollEffects: { BasePowerRollEffect: class {} } }, Item: { AbilityModel: class {} } },
  CONFIG: {
    MessagePart: { abilityUse: {}, abilityResult: {} },
    SpecialEffect: {},
    conditions: { frightened: { targeted: true }, taunted: { targeted: true }, grabbed: { targeted: true }, slowed: {} },
    effectEnds: { turn: { expiryEvent: "turnEnd", abbreviation: "EoT" }, save: { expiryEvent: "save", abbreviation: "save ends" }, encounter: { expiryEvent: "combatEnd" } },
    damageTypes: { fire: { label: "Fire" }, holy: { label: "Holy" } },
    characteristics: { might: { rollKey: "M" }, agility: { rollKey: "A" } },
  },
  utils: { evaluateFormula: (f, rd) => (typeof f === "string" && f.startsWith("@potency.") ? rd.potency[f.split(".")[1]] : Number(f)) },
};
// Mock of User#query: the handler runs as the active GM with the caller as `user` (as core does).
async function query(name, data) {
  const caller = currentUser;
  currentUser = gm;
  try {
    return await CONFIG.queries[name](JSON.parse(JSON.stringify(data)), { user: caller });
  } catch (err) {
    throw new Error(err.message); // only the message crosses the socket
  } finally {
    currentUser = caller;
  }
}
const gm = { id: "gm", name: "GM", isGM: true, role: 4, active: true, targets: new Set(), query, get isSelf() { return currentUser === gm; } };
const player = { id: "pl", name: "Player", isGM: false, role: 1, active: true, targets: new Set(), query, get isSelf() { return currentUser === player; } };
const player2 = { id: "p2", name: "Other", isGM: false, role: 1, active: true, targets: new Set(), query, get isSelf() { return currentUser === player2; } };
const gm2 = { id: "g2", name: "GM2", isGM: true, role: 4, active: true, targets: new Set(), query, get isSelf() { return currentUser === gm2; } };
let currentUser = gm;
let combat = null;
globalThis.game = {
  get user() { return currentUser; },
  get userId() { return currentUser.id; },
  users: { get activeGM() { return gm; }, get(id) { return [gm, gm2, player, player2].find(u => u.id === id) ?? null; } },
  system: { version: "1.1.2" },
  version: "14.368",
  modules: new Map([["stef-ds-automation", { active: true, version: "0.1.0" }]]),
  settings: {
    register(mod, key, cfg) { settingsStore.set(`${mod}.${key}`, cfg.default); },
    get(mod, key) { const k = `${mod}.${key}`; if (!settingsStore.has(k)) throw new Error(`unregistered ${k}`); return settingsStore.get(k); },
    async set(mod, key, v) { settingsStore.set(`${mod}.${key}`, v); return v; },
  },
  messages,
  i18n: { localize: (k) => k, format: (k, d) => `${k} ${JSON.stringify(d)}` },
  get combat() { return combat; },
  scenes: { active: { id: "scene00000000001" } },
  combats: { isDefaultInitiativeMode: true },
};

/* ---------------- load module ---------------- */
// Later harnesses install extra mocks (libWrapper, system classes) before the module loads.
await globalThis.__HARNESS_SETUP__?.();
await imp("main.mjs");
assert.ok(ds.CONFIG.MessagePart.dsAutoResolution, "part registered at import");
Hooks.callAll("init");
Hooks.callAll("ready");
const { getResolution } = await imp("engine/record.mjs");
const { buildView } = await imp("parts/view.mjs");
const api = game.modules.get("stef-ds-automation").api;
assert.ok(api?.selfCheck, "api exposed");

/* ---------------- scene ---------------- */
const hero = new Actor({ uuid: "Actor.hero000000000001", name: "Hero", type: "hero", chr: { might: 2 } });
hero.owners.add("pl");
registry.set(hero.uuid, hero);
function addToken(id, actor, name) {
  const doc = { uuid: `Scene.scene00000000001.Token.${id}`, id, name, actor, texture: { src: `${name}.png` }, object: null, hidden: false, parent: { id: "scene00000000001" } };
  actor.token = actor.token ?? null;
  registry.set(doc.uuid, doc);
  return { document: doc, actor };
}
const gobA = new Actor({ uuid: "Scene.scene00000000001.Token.tokA000000000001.Actor.goblin0000000001", name: "Goblin A", chr: { might: 0, agility: 1 }, immunities: { fire: 2 } });
const gobB = new Actor({ uuid: "Scene.scene00000000001.Token.tokB000000000001.Actor.goblin0000000001", name: "Goblin B", chr: { might: 3, agility: 1 }, weaknesses: { holy: 2 } });
registry.set(gobA.uuid, gobA); registry.set(gobB.uuid, gobB);
const tA = addToken("tokA000000000001", gobA, "Goblin A");
const tB = addToken("tokB000000000001", gobB, "Goblin B");
gobA.token = tA.document; gobB.token = tB.document;

function postAbility(item, targetsByTier, damageByTier, { author = gm, extraParts = {}, whisper = [], isAuthor = true, forge = null } = {}) {
  currentUser = author;
  author.targets = new Set(Object.values(targetsByTier).flat());
  const parts = { abilityUse000000: { _id: "abilityUse000000", type: "abilityUse", abilityUuid: item.uuid } };
  for (const [tier, toks] of Object.entries(targetsByTier)) {
    const id = `tier${tier}Result`.padEnd(16, "0");
    const rolls = toks.map(t => new PowerRoll(10, { target: t.actor.uuid, tier: Number(tier) }));
    for (const d of damageByTier[tier] ?? []) rolls.push(new DamageRoll(d.total, d.options ?? {}));
    parts[id] = { _id: id, type: "abilityResult", tier: Number(tier), rolls };
  }
  Object.assign(parts, extraParts);
  const msg = new Message({ type: "standard", parts, speaker: { scene: "scene00000000001", token: "hero000000000tok" }, whisper });
  Hooks.call("preCreateChatMessage", msg, {}, {}, author.id);
  forge?.(msg.flags["stef-ds-automation"]?.resolution, msg); // a malicious author edits the seed before create
  msg.isAuthor = isAuthor;
  msg.author = author;
  messages.set(msg.id, msg);
  currentUser = gm;
  Hooks.callAll("createChatMessage", msg, {}, "x");
  return msg;
}
const settle = () => new Promise(r => setTimeout(r, 20));
const setCombat = (c) => { combat = c; };
const setDstd = (on) => { if (on) game.modules.set("draw-steel-target-damage", { active: true }); else game.modules.delete("draw-steel-target-damage"); };
const offHook = (name, fn) => { hookFns[name] = (hookFns[name] ?? []).filter(f => f !== fn); };
const setUser = (u) => { currentUser = u; };
const setActiveGM = (u) => Object.defineProperty(game.users, "activeGM", { get: () => u, configurable: true });
const users = { gm, gm2, player, player2 };
export {
  postAbility, settle, makeAbility, hero, tA, tB, gobA, gobB, api, getResolution, buildView, Effect, setCombat, setDstd, offHook,
  Message, gm, users, setUser, setActiveGM, Actor, addToken, registry, notifications, Squad, messages,
};
if (!globalThis.__HARNESS_SKIP_SCENARIOS__) {

/* ---------------- T: damage per tier with immunity / weakness ---------------- */
{
  const item = makeAbility({ uuid: "Actor.hero000000000001.Item.strike0000000001", name: "Strike", actor: hero });
  const msg = postAbility(item, { 1: [tA], 3: [tB] }, { 1: [{ total: 5, options: { type: "fire" } }], 3: [{ total: 9, options: { type: "holy" } }] });
  await settle();
  const res = getResolution(msg);
  assert.ok(res?.resolvedAt, "resolved");
  assert.equal(Object.keys(res.targets).length, 2);
  assert.equal(gobA.system.stamina.value, 20 - 3, "fire immunity 2 reduces 5 to 3");
  assert.equal(gobB.system.stamina.value, 20 - 11, "holy weakness 2 raises 9 to 11");
  assert.ok(msg.system.parts.get("dsAutoResolve000"), "part inserted by seed");
  assert.equal(msg.updates, 1, "exactly one message write per auto resolution");
  const view = buildView(msg, res);
  assert.equal(view.rows.length, 2);
  assert.ok(view.canUndoAll);
  // Undo all restores both
  await api.undoOps(msg.id);
  assert.equal(gobA.system.stamina.value, 20);
  assert.equal(gobB.system.stamina.value, 20);
  const res2 = getResolution(msg);
  assert.ok(Object.values(res2.ops).every(o => o.status === "undone"));
  // Re-apply one op
  const oneId = Object.keys(res2.ops)[0];
  await api.applyOps(msg.id, [oneId]);
  assert.equal(getResolution(msg).ops[oneId].status, "applied");
  await api.undoOps(msg.id);
  console.log("ok damage/immunity/weakness/undo/reapply");
}

/* ---------------- T: temp stamina + delta undo ---------------- */
{
  gobA.system.stamina.temporary = 5;
  const item = makeAbility({ uuid: "Actor.hero000000000001.Item.strike0000000002", name: "Strike2", actor: hero });
  const msg = postAbility(item, { 2: [tA] }, { 2: [{ total: 8, options: {} }] });
  await settle();
  assert.equal(gobA.system.stamina.temporary, 0);
  assert.equal(gobA.system.stamina.value, 17);
  // someone else hits for 4 in between
  await gobA.modifyTokenAttribute("stamina", -4, true);
  await api.undoOps(msg.id);
  const op = Object.values(getResolution(msg).ops)[0];
  assert.equal(op.undoMode, "delta");
  assert.equal(gobA.system.stamina.value, 16, "only our 3 value damage reversed, the other 4 kept");
  assert.equal(gobA.system.stamina.temporary, 5);
  gobA.system.stamina.value = 20; gobA.system.stamina.temporary = 0;
  console.log("ok temp stamina/delta undo");
}

/* ---------------- T: potency-gated slowed per target ---------------- */
{
  combat = { getCombatantsByActor: (a) => [{ id: `cmb-${a.name}`, initiative: 1 }] };
  const applied = {
    tier1: { potency: { characteristic: "might", value: "@potency.weak" }, effects: {} },
    tier2: { potency: { characteristic: "might", value: "@potency.average" }, effects: { slowed: { condition: "failure", end: "save", properties: new Set() } } },
    tier3: { potency: { characteristic: "might", value: "@potency.strong" }, effects: { slowed: { condition: "always", end: "save", properties: new Set() } } },
  };
  const item = makeAbility({ uuid: "Actor.hero000000000001.Item.halt000000000001", name: "Halt", actor: hero, damage: false, applied });
  const msg = postAbility(item, { 2: [tA, tB] }, {});
  await settle();
  // tier 2 potency average = 2: goblin A might 0 -> fails (2 > 0); goblin B might 3 -> resists
  assert.ok(gobA.statuses.has("slowed"), "A slowed");
  assert.ok(!gobB.statuses.has("slowed"), "B resisted");
  const eff = gobA.effects.get("slowed0000000000");
  assert.equal(eff.start.combatant, "cmb-Goblin A", "start.combatant is the target's own combatant");
  assert.equal(eff.duration.expiry, "save");
  const res = getResolution(msg);
  const skipped = Object.values(res.ops).find(o => o.status === "skipped");
  assert.equal(skipped?.reason, "resisted");
  // tier 3 'always' + potency -> warning, treated as failure
  const msg3 = postAbility(item, { 3: [tB] }, {});
  await settle();
  const res3 = getResolution(msg3);
  assert.ok(res3.warnings.some(w => w.code === "conditionAlwaysWithPotency"));
  assert.ok(!gobB.statuses.has("slowed"), "B might 3 vs strong 3 resists");
  // undo removes slowed from A
  await api.undoOps(msg.id);
  assert.ok(!gobA.effects.has("slowed0000000000"));
  combat = null;
  console.log("ok potency/start.combatant/undo condition");
}

/* ---------------- T: squad pool, aoe cap ---------------- */
{
  const m1 = new Actor({ uuid: "Scene.scene00000000001.Token.tokM100000000001.Actor.minion0000000001", name: "M1", minion: true, stamina: 5 });
  const m2 = new Actor({ uuid: "Scene.scene00000000001.Token.tokM200000000001.Actor.minion0000000001", name: "M2", minion: true, stamina: 5 });
  registry.set(m1.uuid, m1); registry.set(m2.uuid, m2);
  const squad = new Squad("Scene.scene00000000001.CombatantGroup.squad00000000001", "Wolves", [m1, m2]);
  registry.set(squad.uuid, squad);
  const tm1 = addToken("tokM100000000001", m1, "M1"); const tm2 = addToken("tokM200000000001", m2, "M2");
  m1.token = tm1.document; m2.token = tm2.document;
  const item = makeAbility({ uuid: "Actor.hero000000000001.Item.burst00000000001", name: "Burst", actor: hero });
  const msg = postAbility(item, { 2: [tm1, tm2] }, { 2: [{ total: 7, options: { aoe: true } }] });
  await settle();
  assert.equal(squad.system.staminaValue, 30 - 10, "aoe capped at minion max 5 x 2 minions");
  const res = getResolution(msg);
  const ops = Object.values(res.ops);
  assert.equal(ops.length, 1, "one op for the squad");
  assert.deepEqual(ops[0].targetKeys.length, 2);
  const view = buildView(msg, res);
  assert.ok(view.rows.some(r => r.squad), "squad row");
  assert.ok(!view.rows.some(r => r.name === "M1"), "minions not listed twice");
  await api.undoOps(msg.id);
  assert.equal(squad.system.staminaValue, 30);
  console.log("ok squad/aoe/undo");
}

/* ---------------- T: heal on minion skipped, temp heal not higher skipped ---------------- */
{
  gobA.system.stamina.temporary = 6;
  const item = makeAbility({ uuid: "Actor.hero000000000001.Item.heal000000000001", name: "Shield", actor: hero });
  const msg = postAbility(item, { 1: [tA] }, { 1: [{ total: 4, options: { isHeal: true, type: "temporary" } }] });
  await settle();
  const op = Object.values(getResolution(msg).ops)[0];
  assert.equal(op.status, "skipped");
  assert.equal(op.reason, "tempNotHigher");
  gobA.system.stamina.temporary = 0;
  console.log("ok temp heal skip");
}

/* ---------------- T: player-authored card, prompt mode, no targets -> retarget ---------------- */
{
  game.settings.set("stef-ds-automation", "damageMode", "prompt");
  const item = makeAbility({ uuid: "Actor.hero000000000001.Item.strike0000000003", name: "Strike3", actor: hero });
  const msg = postAbility(item, { 1: [tA] }, { 1: [{ total: 6, options: {} }] }, { author: player });
  await settle();
  assert.equal(gobA.system.stamina.value, 20, "prompt mode: nothing applied");
  const res = getResolution(msg);
  const op = Object.values(res.ops)[0];
  assert.equal(op.status, "pending");
  assert.equal(op.mode, "prompt");
  await api.applyOps(msg.id);
  assert.equal(gobA.system.stamina.value, 14);
  await api.undoOps(msg.id);
  game.settings.set("stef-ds-automation", "damageMode", "auto");

  // card with no targets at roll time; then GM retargets
  const msg2 = postAbility(item, {}, {}, { extraParts: { tier2Result00000: { _id: "tier2Result00000", type: "abilityResult", tier: 2, rolls: [new PowerRoll(12, { tier: 2 }), new DamageRoll(4, {})] } } });
  await settle();
  const r2 = getResolution(msg2);
  assert.equal(Object.keys(r2.targets).length, 0);
  assert.ok(buildView(msg2, r2).banners.some(b => b.text === "DSAUTO.Card.NoTargets"));
  await api.retarget(msg2.id, [tA.document.uuid]);
  assert.equal(gobA.system.stamina.value, 16, "untargeted single tier applies to retargeted tokens");
  const r3 = getResolution(msg2);
  assert.equal(Object.keys(r3.targets).length, 1);
  // retarget again to B: A's applied op is kept, B gets a new op
  await api.retarget(msg2.id, [tB.document.uuid]);
  const r4 = getResolution(msg2);
  assert.equal(Object.values(r4.targets).filter(t => !t.dropped).length, 1, "one active target"); assert.ok(Object.values(r4.targets).some(t => t.dropped && t.name === "Goblin A"), "A kept as dropped history");
  assert.ok(Object.values(r4.ops).some(o => o.status === "applied" && o.targetKeys[0].includes("tokA")), "A's applied op kept as history");
  assert.equal(gobB.system.stamina.value, 16);
  await api.undoOps(msg2.id);
  assert.equal(gobA.system.stamina.value, 20); assert.equal(gobB.system.stamina.value, 20);
  console.log("ok prompt mode/player card/retarget");
}

/* ---------------- T: appended roll -> manual op ---------------- */
{
  const item = makeAbility({ uuid: "Actor.hero000000000001.Item.strike0000000004", name: "Strike4", actor: hero });
  const msg = postAbility(item, { 1: [tA] }, { 1: [{ total: 2, options: {} }] });
  await settle();
  // system context menu adds a roll to the tier part
  const src = msg._srcParts.tier1Result00000;
  src.rolls = [...src.rolls, new DamageRoll(3, {})];
  await msg.update({ "system.parts.tier1Result00000.rolls": src.rolls });
  await settle();
  const ops = Object.values(getResolution(msg).ops);
  const added = ops.find(o => o.reason === "addedRoll");
  assert.ok(added, "appended roll became a manual op");
  assert.equal(added.mode, "manual");
  await api.undoOps(msg.id);
  console.log("ok appended roll");
}

/* ---------------- T: no active GM -> nothing; card shows waiting ---------------- */
{
  const saved = Object.getOwnPropertyDescriptor(game.users, "activeGM");
  Object.defineProperty(game.users, "activeGM", { get: () => null, configurable: true });
  const item = makeAbility({ uuid: "Actor.hero000000000001.Item.strike0000000005", name: "Strike5", actor: hero });
  const msg = postAbility(item, { 1: [tA] }, { 1: [{ total: 2, options: {} }] }, { author: player });
  await settle();
  const res = getResolution(msg);
  assert.ok(!res.resolvedAt);
  currentUser = player;
  assert.ok(buildView(msg, res).banners.some(b => b.text === "DSAUTO.Card.WaitingForDirector"));
  currentUser = gm;
  Object.defineProperty(game.users, "activeGM", saved);
  // GM resolves via button
  await api.resolve(msg.id);
  assert.ok(getResolution(msg).resolvedAt);
  await api.undoOps(msg.id);
  console.log("ok no GM/resolve later");
}

/* ---------------- T: seed must not throw on odd input ---------------- */
{
  const msg = new Message({ type: "standard", parts: { abilityUse000000: { _id: "abilityUse000000", type: "abilityUse", abilityUuid: "Item.missing" } } });
  Hooks.call("preCreateChatMessage", msg, {}, {}, gm.id);
  assert.equal(getResolution(msg), null, "no record for unknown items");
  const msg2 = new Message({ type: "base", parts: {} });
  Hooks.call("preCreateChatMessage", msg2, {}, {}, gm.id);
  console.log("ok seed robustness");
}

api.selfCheck();
console.log("\nALL HARNESS TESTS PASSED");
}
