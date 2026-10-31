// Ninth harness (Milestone 6): summoning. The library effect `summon` (schema, detached entries, the sheet's
// types), the summon row (resolve, world actors, plan outcomes), placement on the owner's client (core
// placeTokens contract: synchronous preConfirm, skip, Escape, preCommit), the GM's checks and token creation,
// combat and squad insertion (unlinked combats, Death Tracker's pool clamp, Combat Tools' squad turns and
// labels), the "acts after its summoner" chain and its hold, Persistent upkeep, the end triggers, dismissal,
// undo, api.summon / api.summons, the card view and template, the check.cjs reserved-names rule and selfCheck.
// Reuses harness.mjs's world; every client runs in this one process (as harness8).
// Scenarios H1-H56 follow docs/M6-DESIGN.md §7.1 (H53, harness1-8 unchanged, is the separate runs of those files).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";

const paths = createRequire(import.meta.url)("./paths.cjs"); const ROOT = paths.SCRIPTS;
const LIBRARY = paths.LIBRARY_OVERLAYS;
globalThis.__HARNESS_SKIP_SCENARIOS__ = true;

/* ---------- logs and switches ---------- */
const log = {
  relay: [], relayErrors: [], sent: [], whispers: [], place: [], confirms: [], combatUpdates: [], starts: [], dsctStarts: [],
  dtDeletes: [], poolWrites: [], clamps: [], checkDefeated: [], labels: [], actorCreates: [], fromCompendium: [], actorFinds: 0,
  tokenCreates: [], tokenDeletes: [], combatantCreates: [], combatantDeletes: [], groupCreates: [], groupDeletes: [],
  hooks: [], pickTimeouts: 0, dsctSkips: [], dsctStripped: [],
};
const sw = { failCombatantCreate: 0, failCombatantDelete: 0, dsct: false, failNextUpdate: null, dsctKeys: false };
/** Combat Tools' `_turnStarted` (DSCT/squad-turns.mjs:88-89), modelled only with sw.dsctKeys (H29c). */
const dsctTurnStarted = new Set();
const dsctKey = m => `${m.id}:${m.parent?.round}:${m.group?.initiative}`;
const clear = () => {
  for (const k of Object.keys(log)) if (Array.isArray(log[k])) log[k].length = 0;
  log.actorFinds = 0;
  log.pickTimeouts = 0;
};
const getPath = (obj, path) => String(path).split(".").reduce((o, k) => o?.[k], obj);
const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
/**
 * Core writes onto the operation object it is given (CC/abstract/document.mjs:742 `operation.parent = this.parent`,
 * :878 / :896 `operation.parent = this`): a frozen operation throws in strict mode, as live (review fix). Removed
 * again so the logs' JSON clones stay acyclic.
 */
function coreOp(options, parent) {
  if (!options || typeof options !== "object") return;
  options.parent = parent ?? null;
  delete options.parent;
}
class Coll extends Map {
  get contents() { return [...this.values()]; }
  find(fn) { return this.contents.find(fn); }
  filter(fn) { return this.contents.filter(fn); }
  some(fn) { return this.contents.some(fn); }
  map(fn) { return this.contents.map(fn); }
  [Symbol.iterator]() { return this.values(); }
}

/* ---------- DOM (dialogs) ---------- */
class ClassList {
  constructor() { this.set = new Set(); }
  add(...c) { for (const x of c) this.set.add(x); }
  remove(...c) { for (const x of c) this.set.delete(x); }
  contains(c) { return this.set.has(c); }
  toggle(c, on) { if (on ?? !this.set.has(c)) this.set.add(c); else this.set.delete(c); }
}
class El {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.classList = new ClassList();
    this.dataset = {};
    this.textContent = "";
    this.style = {};
  }
  append(...kids) {
    for (const k of kids) {
      if (!k || typeof k !== "object") continue;
      k.remove();
      k.parentNode = this;
      this.children.push(k);
    }
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(c => c !== this);
    this.parentNode = null;
  }
  all() { return this.children.flatMap(c => [c, ...c.all()]); }
  querySelectorAll(sel) {
    if (sel.startsWith(".")) return this.all().filter(e => e.classList.contains(sel.slice(1)));
    return this.all().filter(e => e.tagName === sel.toUpperCase());
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}

/* ---------- dialogs (DialogV2.wait) ---------- */
const dialogs = [];          // every DialogV2.wait call: {cfg, user, title, kind, closed, result, click()}
let answerFn = () => undefined;
const parseLoc = (s) => {
  const i = String(s ?? "").indexOf(" ");
  if (i < 0) return {};
  try {
    return JSON.parse(String(s).slice(i + 1));
  } catch (_err) {
    return {};
  }
};
function makeForm(option = 0) {
  return {
    querySelector(sel) {
      if (sel.includes('name="ds-auto-option"') || sel.includes('name="ds-auto-summon-choice"')) return { value: String(option) };
      if (/ds-auto-spend-\d+/.test(sel)) return { checked: false };
      return null;
    },
  };
}
function dialogWait(cfg) {
  return new Promise(resolve => {
    const rec = { cfg, user: game.user?.id ?? null, title: cfg.window?.title ?? "", closed: false, result: undefined, renders: 0 };
    rec.data = parseLoc(rec.title);
    rec.name = rec.data.name ?? rec.data.ability ?? null;
    const actions = (cfg.buttons ?? []).map(b => b.action);
    rec.kind = actions.includes("decline") ? "trigger" : (actions.includes("keep") ? "upkeep" : (actions.includes("summon") ? "choose" : "other"));
    const finish = (value) => {
      if (rec.closed) return;
      rec.closed = true;
      rec.result = value;
      try {
        cfg.close?.();
      } catch (_err) { /* close callback */ }
      resolve(value);
    };
    const element = new El("form");
    for (const cls of ["ds-auto-countdown", "ds-auto-upkeep-bar-fill"]) {
      const e = new El("p");
      e.classList.add(cls);
      element.append(e);
    }
    const dialog = { element, render() { rec.renders++; cfg.render?.(null, dialog); }, close() { finish(null); } };
    rec.dialog = dialog;
    rec.click = (action, { option = 0 } = {}) => {
      if (rec.closed) return false;
      const button = (cfg.buttons ?? []).find(b => b.action === action);
      const value = button?.callback ? button.callback(null, { form: makeForm(option) }, dialog) : action;
      finish(value);
      return true;
    };
    dialogs.push(rec);
    dialog.render();
    if (rec.closed) return;
    let a;
    try {
      a = answerFn(rec);
    } catch (err) {
      console.error(err);
      a = undefined;
    }
    Promise.resolve(a).then(v => {
      if (v === undefined || v === null || rec.closed) return;
      if (typeof v === "string") rec.click(v);
      else rec.click(v.action, v);
    });
  });
}
const upkeepDialogs = () => dialogs.filter(d => d.kind === "upkeep");
const triggerDialogs = (name = null) => dialogs.filter(d => d.kind === "trigger" && (!name || d.name === name));

/* ---------- system classes the wrappers patch ---------- */
class TokenDocumentBase {
  async _preUpdateMovement() { return undefined; }
}
/** Core's effect registry; `refreshHook` lets a scenario make a refresh slow (H37c). */
let refreshHook = null;
class ActiveEffectRegistry { async refresh(event, context) { return refreshHook?.(event, context); } }
class CombatBase {
  async _onEndTurn() {}
  async _onExit() {}
}
/* The system's special effect base and the data fields the entry types use (H3 reads the schema back). */
class Field {
  constructor(a = {}, b = {}) {
    if (a instanceof Field) Object.assign(this, { element: a, options: b }, b);
    else Object.assign(this, { options: a }, a);
  }
}
class StringField extends Field {}
class BooleanField extends Field {}
class NumberField extends Field {}
class SetField extends Field {}
class SchemaField extends Field {
  constructor(fields, options = {}) {
    super(options);
    this.fields = fields;
  }
}
class BaseSpecialEffect {
  static defineSchema() { return {}; }
}

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
  globalThis.CONST = { TOKEN_DISPOSITIONS: { HOSTILE: -1, NEUTRAL: 0, FRIENDLY: 1 }, GRID_TYPES: { GRIDLESS: 0, SQUARE: 1, HEXODDR: 2 } };
  CONFIG.Token = { documentClass: TokenDocumentBase };
  CONFIG.Combat = { documentClass: CombatBase };
  foundry.helpers = { ActiveEffectRegistry };
  foundry.documents.ActiveEffect = { registry: new ActiveEffectRegistry() };
  foundry.utils.getProperty = getPath;
  foundry.utils.setProperty = (obj, key, value) => { const parts = key.split("."); let o = obj; for (const k of parts.slice(0, -1)) o = o[k] ??= {}; o[parts.at(-1)] = value; };
  foundry.utils.escapeHTML = v => String(v);
  foundry.applications = { instances: new Map(), api: { DialogV2: { wait: dialogWait } } };
  foundry.data.fields = { StringField, BooleanField, NumberField, SetField, SchemaField };
  ds.data.pseudoDocuments.specialEffects = { BaseSpecialEffect };
  ds.utils.evaluateFormula = (f, rd) => {
    const src = String(f).replace(/@([A-Za-z_][A-Za-z0-9_.]*)/g, (_m, p) => {
      const v = getPath(rd, p);
      if (v === undefined || v === null || typeof v === "object") throw new Error(`no @${p}`);
      return `(${Number(v)})`;
    });
    if (!/^[\d\s+\-*/().]+$/.test(src)) throw new Error(`bad formula ${f}`);
    return Function(`return (${src})`)();
  };
  CONFIG.statusEffects.push(
    { id: "dying", _id: "dying00000000000", name: "Dying" },
    { id: "dazed", _id: "dazed00000000000", name: "Dazed" },
  );
  // Combat Tools (squad turns, labels, HIW off), ctlib; their settings are read live.
  game.modules.set("draw-steel-combat-tools", { active: true, api: dsctApi, title: "Combat Tools" });
  game.modules.set("draw-steel-ctlib", { active: true });
  globalThis.ctlib = { services: new Map(), async damageBatch(fn) { return fn(); } };
  for (const [key, value] of Object.entries(DSCT_DEFAULTS)) game.settings.register("draw-steel-combat-tools", key, { default: value });
  game.settings.register("draw-steel", "initiativeMode", { default: "default" });
  globalThis.document = {
    body: new El("body"), createElement: tag => new El(tag), addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, getElementById: () => null,
  };
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
};

/* ---------- Combat Tools mock ---------- */
const DSCT_DEFAULTS = {
  abilityAutomationEnabled: true, hiwEnabled: false, rollDialogPillUI: true, forcedMovementEnabled: true, conditionsEnabled: true,
  squadSimultaneousTurns: false, autoSquadLabelsEnabled: true, squadLabelApplyEffects: true, squadToolsEnabled: true, pairSimultaneousTurns: false,
};
const dsctApi = {
  async squadLabels() { log.labels.push({ user: game.user?.id ?? null, scene: canvas.scene?.id ?? null, combat: game.combat?.id ?? null }); },
};

/* ---------- load the module ---------- */
const world = await import(new URL("./harness.mjs", import.meta.url).href);
const { makeAbility, api, getResolution, buildView, Effect, setCombat, offHook, Message, users, setUser, setActiveGM, Actor, registry, messages } = world;
const { gm, gm2, player, player2 } = users;
const imp = p => import(pathToFileURL(ROOT + p).href);
const { clock } = await imp("triggers/prompt.mjs");
const { handleOp, requestOp, validPlaces, timeoutFor } = await imp("relay/queries.mjs");
const { promptTypes } = await imp("relay/prompt-router.mjs");
const { lifecycleIdle, forgetCombat, resetActivations } = await imp("turn/lifecycle.mjs");
const schema = await imp("library/schema.mjs");
const entries = await imp("library/entries.mjs");
const { applyOps, undoOps, prepareSummon, withMessageLock } = await imp("engine/engine.mjs");
const { runSummonPick, buildPreviews, summonReasonText } = await imp("summons/place.mjs");
const registryMod = await imp("summons/registry.mjs");
const { REMOVAL, listSummons, summonInfo, summonTokens, indexEntries, dismissSummon, withSummonChain } = registryMod;
const { canPay, openUpkeeps, cancelUpkeep } = await imp("summons/upkeep.mjs");
const { closeUpkeepDialog, openUpkeepDialogs } = await imp("ui/summon-upkeep.mjs");
const { checkSquare, rectOf, squaresBetween, autoPlaces, originOf } = await imp("summons/squares.mjs");
const { freeGroupName, deletePresent } = await imp("summons/combat.mjs");
const { orphanSummons } = await imp("self-check.mjs");
const { HOOKS } = await imp("constants.mjs");

const set = (key, value) => game.settings.set("stef-ds-automation", key, value);
const settle = (ms = 60) => new Promise(r => setTimeout(r, ms));
Hooks.off = (name, fn) => offHook(name, fn);

/* ---------- manual clock (server time) ---------- */
const mclock = { t: Date.now(), timers: new Map(), seq: 0 };
clock.now = () => mclock.t;
clock.setTimeout = (fn, ms) => {
  const id = ++mclock.seq;
  const store = als.getStore();
  mclock.timers.set(id, { at: mclock.t + Math.max(0, Number(ms) || 0), fn: store ? () => als.run(store, fn) : fn });
  return id;
};
clock.clearTimeout = id => { mclock.timers.delete(id); };
game.time = { get serverTime() { return mclock.t; } };
Object.defineProperty(Message.prototype, "timestamp", {
  get() { return this._ts ?? (this._ts = mclock.t); }, set(v) { this._ts = v; }, configurable: true,
});
/** Move server time on; every timer due by then fires in time order (a jump). */
async function advance(ms) {
  mclock.t += ms;
  for (;;) {
    const due = [...mclock.timers.entries()].filter(([, x]) => x.at <= mclock.t).sort((a, b) => a[1].at - b[1].at);
    if (!due.length) break;
    for (const [id, x] of due) {
      if (!mclock.timers.has(id)) continue;
      mclock.timers.delete(id);
      x.fn();
    }
  }
  await settle();
}

/** Document hooks run on every client; ours act on the active GM's: fire them there (the caller may be a player). */
const asGM = fn => {
  const g = game.users.activeGM;
  return g && game.user !== g ? as(g, fn) : fn();
};
const emit = (name, ...args) => asGM(() => Hooks.callAll(name, ...args));

/* ---------- users and queries ---------- */
const ALL_USERS = [gm, gm2, player, player2];
game.users.filter = fn => ALL_USERS.filter(fn);
game.users.find = fn => ALL_USERS.find(fn);
game.users.contents = ALL_USERS;
// player2 plays the live user "Test" (owner of Borin); player is "Other" (owner of Benedikt and Dorian).
player2.name = "Test";
player.name = "Other";
for (const u of ALL_USERS) u.character = null;
const als = new AsyncLocalStorage();
const baseUser = Object.getOwnPropertyDescriptor(game, "user").get;
Object.defineProperty(game, "user", { get: () => als.getStore()?.user ?? baseUser(), configurable: true });
Object.defineProperty(game, "userId", { get: () => game.user.id, configurable: true });
for (const u of ALL_USERS) Object.defineProperty(u, "isSelf", { get: () => game.user === u, configurable: true });
/** Run `fn` on `user`'s client. */
const as = (user, fn) => als.run({ user }, fn);
function clientQuery(user) {
  return async (name, data, opts) => {
    log.sent.push({ to: user.id, name, type: data?.type ?? null, data: clone(data), opts });
    if (user.active === false) throw new Error("timed out");
    if (typeof user.intercept === "function") {
      const r = user.intercept(name, clone(data));
      if (r !== undefined) return r;
    }
    const caller = game.user;
    try {
      return await as(user, () => CONFIG.queries[name](clone(data), { user: caller }));
    } catch (err) {
      throw new Error(err.message);
    }
  };
}
player.query = clientQuery(player);
player2.query = clientQuery(player2);
function gmQuery(target) {
  return async (name, data) => {
    log.relay.push({ from: game.user.id, to: target.id, action: data?.action ?? null, data: clone(data), at: mclock.t });
    const caller = game.user;
    try {
      return await as(target, () => CONFIG.queries[name](clone(data), { user: caller }));
    } catch (err) {
      log.relayErrors.push({ action: data?.action, error: err.message });
      throw new Error(err.message);
    }
  };
}
gm.query = gmQuery(gm);
gm2.query = gmQuery(gm2);
const relayed = action => log.relay.filter(r => r.action === action);
const sentTo = (userId, type) => log.sent.filter(s => s.to === userId && (!type || s.type === type));

/* ---------- chat ---------- */
globalThis.ChatMessage = {
  getSpeaker: ({ actor } = {}) => ({ alias: actor?.name ?? "GM", actor: actor?.id ?? null }),
  getSpeakerActor: () => null,
  async create(data) {
    const msg = new Message({ type: data.type ?? "base", parts: data.system?.parts ?? {}, flags: data.flags, speaker: data.speaker, whisper: data.whisper });
    msg.author = game.user;
    msg.content = data.content ?? "";
    msg._ts = mclock.t;
    messages.set(msg.id, msg);
    if (Hooks.call("preCreateChatMessage", msg, data, {}, game.userId) === false) {
      messages.delete(msg.id);
      return null;
    }
    if (data.whisper?.length) log.whispers.push({ content: msg.content, whisper: [...data.whisper] });
    Hooks.callAll("createChatMessage", msg, {}, game.userId);
    return msg;
  },
};
ChatMessage.implementation = ChatMessage;
// A card write that fails once (H56: the card cannot record the summon).
const baseMsgUpdate = Message.prototype.update;
Message.prototype.update = async function (changes, options) {
  if (sw.failNextUpdate === this.id) {
    sw.failNextUpdate = null;
    throw new Error("the card was deleted");
  }
  return baseMsgUpdate.call(this, changes, options);
};

/* ---------- heroes ---------- */
Object.defineProperty(Actor.prototype, "hasPlayerOwner", { get() { return this.owners.size > 0; }, configurable: true });
Object.defineProperty(Actor.prototype, "documentName", { get: () => "Actor", configurable: true });
Actor.prototype.getActiveTokens = function (_linked = false, document = false) {
  return this.token ? [document ? this.token : this.token.object] : [];
};
const expand = (flat) => {
  const out = {};
  for (const [k, v] of Object.entries(flat)) foundry.utils.setProperty(out, k, v);
  return out;
};
const baseActorUpdate = Actor.prototype.update;
Actor.prototype.update = async function (changes, options = {}) {
  await baseActorUpdate.call(this, changes);
  emit("updateActor", this, expand(changes), options, game.userId);
  return this;
};
Actor.prototype.createEmbeddedDocuments = async function (_type, data, options = {}) {
  return data.map(d => {
    const statuses = new Set(d.statuses ?? []);
    const e = new Effect({ ...d, statuses: undefined }, this);
    e.statuses = statuses;
    this.effects.set(e.id, e);
    for (const s of statuses) this.statuses.add(s);
    emit("createActiveEffect", e, options, game.userId);
    return e;
  });
};
const everyone = [];
function mkHero(id, name, { owner = null, stamina = 30, resource = "Focus", value = 3, gain = "2" } = {}) {
  const a = new Actor({ uuid: `Actor.${id}`, name, type: "hero", stamina, chr: { might: 1, agility: 1 } });
  a.system.hero = { primary: { value, label: resource }, surges: 0, epic: { value: 0 }, xp: 0, victories: 0 };
  a.system.coreResource = { name: resource, path: "system.hero.primary.value", minimum: 0 };
  a.system.recoveries = { value: 2, max: 8, recoveryValue: 10 };
  a.system.class = { system: { turnGain: gain } };
  a.system.restrictions = { type: new Set(), dsid: new Set() };
  a.items = new Coll();
  a.img = `${name}.png`;
  a.getRollData = () => ({ chr: 2, level: 1, potency: { weak: 1, average: 2, strong: 3 } });
  if (owner) a.owners.add(owner.id);
  a.home = { value };
  registry.set(a.uuid, a);
  everyone.push(a);
  return a;
}
// Borin: a Fury (Ferocity, a non-constant gain), owned by Test (§7.1 "player2 = Test").
const borin = mkHero("borin00000000001", "Borin", { owner: player2, resource: "Ferocity", value: 4, gain: "1d3" });
const benedikt = mkHero("benedikt00000001", "Benedikt", { owner: player });
const dorian = mkHero("dorian0000000001", "Dorian", { owner: player, resource: "Insight", value: 2 });

/* ---------- world actors, compendium stat blocks ---------- */
const OWNER = 3;
class WorldActor {
  constructor(data) {
    const d = clone(data);
    this.id = d._id ?? foundry.utils.randomID();
    this.uuid = `Actor.${this.id}`;
    this.name = d.name;
    this.type = d.type ?? "npc";
    this.img = d.img ?? `${d.name}.png`;
    this._stats = d._stats ?? {};
    this.flags = d.flags ?? {};
    this.folder = d.folder ?? null;
    this.ownership = d.ownership ?? { default: 0 };
    this.prototypeToken = d.prototypeToken ?? { name: d.name, width: 1, height: 1, texture: { src: this.img } };
    this.system = d.system ?? { stamina: { value: 10, max: 10, temporary: 0, min: 0 } };
    this.items = new Coll();
    this.statuses = new Set();
    this.effects = new Coll();
    this.isToken = false;
  }
  get documentName() { return "Actor"; }
  get isMinion() { return !!this.system?.isMinion; }
  get isOwner() { return this.testUserPermission(game.user, "OWNER"); }
  get hasPlayerOwner() { return ALL_USERS.some(u => !u.isGM && this.testUserPermission(u, "OWNER")); }
  getFlag(scope, key) { return this.flags?.[scope]?.[key]; }
  testUserPermission(user, _level = "OWNER") {
    if (!user) return false;
    if (user.isGM) return true;
    return (this.ownership?.[user.id] ?? this.ownership?.default ?? 0) >= OWNER;
  }
  getRollData() { return { potency: { weak: 1, average: 2, strong: 3 } }; }
  getActiveTokens() { return []; }
  async update(changes, options = {}) {
    for (const [k, v] of Object.entries(changes)) {
      if (k === "ownership") Object.assign(this.ownership, v);
      else foundry.utils.setProperty(this, k, v);
    }
    emit("updateActor", this, expand(changes), options, game.userId);
    return this;
  }
  /** Core: a token document from the prototype, not created (`parent` given). */
  async getTokenDocument(data = {}, { parent = null } = {}) {
    const proto = clone(this.prototypeToken);
    return new TokenDoc9({ ...proto, name: proto.name ?? this.name, actorId: this.id, actorLink: false, ...clone(data) }, parent, { preview: true });
  }
  toObject() { return clone({ _id: this.id, name: this.name, type: this.type, img: this.img, system: this.system, prototypeToken: this.prototypeToken, flags: this.flags, ownership: this.ownership }); }
}
/** The synthetic actor of an unlinked token (base world actor merged with the token's delta, per token). */
class SynthActor {
  constructor(base, token) {
    // Foundry v14: an Actor has no `baseActor` (only TokenDocument#baseActor); keep the base private so code that reads
    // `actor.baseActor` fails here as it does live (M6 live run 2026-10-07, CH1).
    this._base = base;
    this.token = token;
    this.id = base.id;
    this.uuid = `${token.uuid}.Actor.${base.id}`;
    this.type = base.type;
    this.img = base.img;
    this.isToken = true;
    this._stats = base._stats;
    this.prototypeToken = base.prototypeToken;
    this.items = new Coll();
    this.statuses = new Set();
    this.effects = new Coll();
    const max = Number(base.system?.stamina?.max) || 10;
    const carried = token.delta?.system?.stamina?.value;
    this.system = {
      ...clone(base.system),
      stamina: { value: Number.isFinite(carried) ? carried : max, max, temporary: 0, min: 0 },
    };
    if (!token.preview) registry.set(this.uuid, this);
  }
  get documentName() { return "Actor"; }
  get name() { return this.token.name ?? this._base.name; }
  get isMinion() { return !!this.system?.isMinion; }
  get ownership() { return { ...this._base.ownership, ...(this.token.delta?.ownership ?? {}) }; }
  get flags() {
    const out = clone(this._base.flags ?? {});
    for (const [scope, v] of Object.entries(this.token.delta?.flags ?? {})) out[scope] = { ...(out[scope] ?? {}), ...clone(v) };
    return out;
  }
  get isOwner() { return this.testUserPermission(game.user, "OWNER"); }
  get hasPlayerOwner() { return ALL_USERS.some(u => !u.isGM && this.testUserPermission(u, "OWNER")); }
  getFlag(scope, key) { return this.flags?.[scope]?.[key]; }
  testUserPermission(user) {
    if (!user) return false;
    if (user.isGM) return true;
    const own = this.ownership;
    return (own[user.id] ?? own.default ?? 0) >= OWNER;
  }
  getRollData() { return { potency: { weak: 1, average: 2, strong: 3 } }; }
  getActiveTokens(_linked = false, document = false) { return [document ? this.token : this.token.object]; }
  async update(changes, options = {}) {
    for (const [k, v] of Object.entries(changes)) foundry.utils.setProperty(this, k, v);
    if ("system.stamina.value" in changes) foundry.utils.setProperty(this.token._source, "delta.system.stamina.value", changes["system.stamina.value"]);
    emit("updateActor", this, expand(changes), options, game.userId);
    return this;
  }
}
/** game.actors: per-client view (P1 negative: a world actor this client does not hold), spies on lookups. */
const hiddenActors = new Map();   // userId -> Set(actorId)
const hiddenFor = id => hiddenActors.get(game.user?.id)?.has(id) ?? false;
class ActorsColl extends Coll {
  raw(id) { return Map.prototype.get.call(this, id); }
  get(id) { return hiddenFor(id) ? undefined : super.get(id); }
  get contents() { return [...this.values()].filter(a => !hiddenFor(a.id)); }
  find(fn) {
    log.actorFinds++;
    return this.contents.find(fn);
  }
  fromCompendium(doc, { keepId = false } = {}) {
    log.fromCompendium.push({ uuid: doc.uuid, keepId });
    const data = clone({ name: doc.name, type: doc.type, img: doc.img, system: doc.system, prototypeToken: doc.prototypeToken, flags: doc.flags ?? {} });
    if (keepId) data._id = doc.id;
    data._stats = { compendiumSource: doc.uuid };
    data.ownership = { default: 0, [game.user.id]: OWNER };
    return data;
  }
}
game.actors = new ActorsColl();
for (const a of everyone) game.actors.set(a.id, a);
globalThis.Actor = {
  implementation: {
    async create(data, options = {}) {
      const a = new WorldActor(data);
      log.actorCreates.push({ name: a.name, options: clone(options), source: a.flags?.["draw-steel"]?.summonSource ?? null });
      game.actors.set(a.id, a);
      registry.set(a.uuid, a);
      return a;
    },
  },
};
game.folders = new Coll();
globalThis.Folder = {
  implementation: {
    async create(data) {
      const f = { id: foundry.utils.randomID(), ...clone(data) };
      game.folders.set(f.id, f);
      return f;
    },
  },
};
// The six §1.2 stat blocks (prototype sizes, organizations, Stamina) in "draw-steel.monsters".
const PACK = "draw-steel.monsters";
const STAT = {
  source: { id: "o7qp5KCUuRgfCko6", name: "Source of Earth", size: 2, stamina: 45, minion: false, org: "" },
  runner: { id: "Xw0gZCS09gdMjaw8", name: "Goblin Runner", size: 1, stamina: 4, minion: true, org: "minion" },
  hyena: { id: "5oS4rixqbIcsziNm", name: "Abyssal Hyena", size: 1, stamina: 7, minion: true, org: "minion" },
  vampire: { id: "pNA8H0vk4EDNq4UI", name: "Blood-Starved Vampire", size: 1, stamina: 12, minion: true, org: "minion" },
  recruit: { id: "ubQBS8oIMsfRK8du", name: "Hobgoblin Recruit", size: 1, stamina: 9, minion: true, org: "minion" },
  pollywog: { id: "UIerVsSyMb36Bm4D", name: "Angulotl Pollywog", size: 1, stamina: 4, minion: true, org: "minion" },
};
const cuuid = key => `Compendium.${PACK}.Actor.${STAT[key].id}`;
const packIndex = new Coll();
const packDocs = {};
for (const [key, s] of Object.entries(STAT)) {
  const doc = {
    documentName: "Actor", uuid: cuuid(key), id: s.id, name: s.name, type: "npc", img: `${key}.webp`, flags: {},
    prototypeToken: { name: s.name, width: s.size, height: s.size, texture: { src: `${key}-token.webp` }, disposition: -1, actorLink: false },
    system: { stamina: { value: s.stamina, max: s.stamina, temporary: 0, min: 0 }, isMinion: s.minion, organization: s.org, combat: { turns: 1 } },
  };
  packDocs[key] = doc;
  registry.set(doc.uuid, doc);
  packIndex.set(s.id, { _id: s.id, name: s.name });
}
game.packs = new Coll([[PACK, { collection: PACK, index: packIndex }]]);
/** The monsters pack unavailable (H16), then back. */
function packOnline(on) {
  for (const key of Object.keys(STAT)) {
    if (on) registry.set(cuuid(key), packDocs[key]);
    else registry.delete(cuuid(key));
  }
}

/* ---------- scenes and tokens ---------- */
const G = 100;
const LEVEL = "level00000000001";
class TokenDoc9 extends TokenDocumentBase {
  constructor(data, scene, { preview = false } = {}) {
    super();
    const d = clone(data);
    this._source = {
      x: 0, y: 0, elevation: 0, level: scene?.initialLevel ?? null, width: 1, height: 1, disposition: 0, hidden: false, actorLink: false,
      actorId: null, delta: {}, flags: {}, name: "Token", texture: { src: "token.png" }, rotation: 0, ring: { enabled: true }, sight: { enabled: true },
      ...d,
    };
    if (data?.level === undefined) this._source.level = scene?.initialLevel ?? null;
    this.id = d._id ?? foundry.utils.randomID();
    delete this._source._id;
    this.parent = scene;
    this.preview = preview;
    this._actor = null;
    this._synth = null;
  }
  get documentName() { return "Token"; }
  get uuid() { return `Scene.${this.parent?.id ?? "none"}.Token.${this.id}`; }
  get x() { return this._source.x; }
  set x(v) { this._source.x = v; }
  get y() { return this._source.y; }
  set y(v) { this._source.y = v; }
  get elevation() { return this._source.elevation; }
  get level() { return this._source.level; }
  get width() { return this._source.width; }
  get height() { return this._source.height; }
  get disposition() { return this._source.disposition; }
  set disposition(v) { this._source.disposition = v; }
  get hidden() { return this._source.hidden; }
  set hidden(v) { this._source.hidden = v; }
  get actorLink() { return this._source.actorLink; }
  get actorId() { return this._source.actorId; }
  get delta() { return this._source.delta; }
  get flags() { return this._source.flags; }
  get name() { return this._source.name; }
  get texture() { return this._source.texture; }
  get rotation() { return this._source.rotation; }
  /** Core v14: the world actor of the token (`game.actors.get(actorId)`). */
  get baseActor() { return this.actorId ? game.actors.get(this.actorId) ?? null : null; }
  get actor() {
    if (this._actor) return this._actor;
    if (this.actorLink) return game.actors.get(this.actorId) ?? null;
    const base = game.actors.raw(this.actorId);
    if (!base || hiddenFor(base.id)) return null;
    if (!this._synth || this._synth._base !== base) this._synth = new SynthActor(base, this);
    return this._synth;
  }
  get object() {
    const doc = this;
    return { id: doc.id, document: doc, get actor() { return doc.actor; }, scene: doc.parent, get center() { return { x: doc.x + G / 2, y: doc.y + G / 2 }; } };
  }
  testUserPermission(user, _level = "OWNER") {
    if (user?.isGM) return true;
    return !!this.actor?.testUserPermission(user, "OWNER");
  }
  get isOwner() { return this.testUserPermission(game.user, "OWNER"); }
  getFlag(scope, key) { return this.flags?.[scope]?.[key]; }
  toObject() { return { _id: this.id, ...clone(this._source) }; }
  async update(changes, options = {}) {
    coreOp(options, this.parent);
    const exp = {};
    for (const [k, v] of Object.entries(changes)) foundry.utils.setProperty(exp, k, v);
    mergeInto(this._source, exp);
    emit("updateToken", this, exp, options, game.userId);
    return this;
  }
}
const ForcedDeletion = foundry.data.operators.ForcedDeletion;
function mergeInto(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (v instanceof ForcedDeletion) {
      delete target[k];
      continue;
    }
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Set)) {
      if (!target[k] || typeof target[k] !== "object") target[k] = {};
      mergeInto(target[k], v);
    } else target[k] = Array.isArray(v) ? clone(v) : v;
  }
}
class Scene9 {
  constructor(id, name, { type = 1, width = 2000, height = 2000 } = {}) {
    this.id = id;
    this.name = name;
    this.uuid = `Scene.${id}`;
    this.grid = {
      size: G, distance: 5, type,
      // Core square grid: i = row, j = column.
      getOffset: ({ x, y }) => ({ i: Math.floor(y / G), j: Math.floor(x / G) }),
      getTopLeftPoint: ({ i, j }) => ({ x: j * G, y: i * G }),
    };
    this.dimensions = { sceneRect: { x: 0, y: 0, width, height } };
    this.levels = new Coll([[LEVEL, { id: LEVEL, name: "Ground" }]]);
    this.initialLevel = LEVEL;
    this.tokens = new Coll();
    this.flags = {};
  }
  get documentName() { return "Scene"; }
  async createEmbeddedDocuments(type, data, options = {}) {
    if (type !== "Token") throw new Error(`Scene9 ${type}`);
    coreOp(options, this);
    const out = data.map(d => new TokenDoc9(d, this));
    for (const t of out) {
      this.tokens.set(t.id, t);
      registry.set(t.uuid, t);
      log.tokenCreates.push({ id: t.id, name: t.name, options: clone(options) });
    }
    for (const t of out) emit("createToken", t, options, game.userId);
    return out;
  }
  async deleteEmbeddedDocuments(type, ids, options = {}) {
    if (type !== "Token") throw new Error(`Scene9 ${type}`);
    coreOp(options, this);
    const out = [];
    for (const id of ids) {
      const t = this.tokens.get(id);
      if (!t) throw new Error(`Token ${id} does not exist`);
      this.tokens.delete(id);
      registry.delete(t.uuid);
      if (t._synth) registry.delete(t._synth.uuid);
      log.tokenDeletes.push({ id, name: t.name, options: clone(options), at: log.combatantDeletes.length });
      out.push(t);
    }
    for (const t of out) emit("deleteToken", t, options, game.userId);
    return out;
  }
  async updateEmbeddedDocuments(type, updates, options = {}) {
    coreOp(options, this);
    const out = [];
    for (const u of updates) {
      const t = this.tokens.get(u._id);
      if (!t) continue;
      const { _id, ...rest } = u;
      await t.update(rest, options);
      out.push(t);
    }
    return out;
  }
}
const START = new Scene9("scene00000000001", "Start");
const OTHER = new Scene9("scene00000000002", "Elsewhere");
const HEXES = new Scene9("scene00000000003", "Hexes", { type: 2 });
class ScenesColl extends Coll {
  get active() { return START; }
}
game.scenes = new ScenesColl([[START.id, START], [OTHER.id, OTHER], [HEXES.id, HEXES]]);
/** Place a token on a scene (heroes linked; monsters unlinked with their synthetic actor and its items). */
function place(scene, actor, name, gx, gy, { disposition = -1, hidden = false, linked = actor.type === "hero" } = {}) {
  const doc = new TokenDoc9({
    name, x: gx * G, y: gy * G, width: 1, height: 1, disposition, hidden, actorLink: linked, actorId: actor.id, texture: { src: `${name}.png` },
  }, scene);
  scene.tokens.set(doc.id, doc);
  registry.set(doc.uuid, doc);
  if (linked) {
    doc._actor = actor;
    actor.token = doc;
  } else {
    doc._synth = new SynthActor(actor, doc);
    doc._synth.statuses = new Set();
  }
  doc.home = { x: doc.x, y: doc.y, disposition, hidden };
  return doc;
}
const tBorin = place(START, borin, "Borin", 5, 5, { disposition: 1 });
const tBen = place(START, benedikt, "Benedikt", 6, 5, { disposition: 1 });
const tDorian = place(START, dorian, "Dorian", 5, 2, { disposition: 1 });

/* ---------- canvas (per client: the viewed scene and level) ---------- */
const views = new Map();   // userId -> {scene, level}
const viewOf = () => views.get(game.user?.id) ?? { scene: START, level: { id: LEVEL } };
function view(user, scene, level = LEVEL) { views.set(user.id, { scene, level: level ? { id: level } : null }); }
const clickQ = new Map();  // userId -> ["esc" | "skip" | {x, y}]
const placing = new Map(); // userId -> open placement state
/** Queue clicks for a client's picker: {x, y} in grid squares (top-left), "skip" (right-click), "esc". */
function clicks(user, ...items) {
  if (!clickQ.has(user.id)) clickQ.set(user.id, []);
  clickQ.get(user.id).push(...items.map(c => (typeof c === "string" ? c : { ...c, x: c.x * G, y: c.y * G })));
}
async function nextClick(userId, state) {
  const end = Date.now() + 3000;
  for (;;) {
    if (state.cancelled) return "esc";
    const q = clickQ.get(userId);
    if (q?.length) return q.shift();
    if (Date.now() > end) {
      log.pickTimeouts++;
      return "esc";
    }
    await settle(5);
  }
}
globalThis.canvas = {
  get scene() { return viewOf().scene; },
  get level() { return viewOf().level; },
  get grid() { return viewOf().scene.grid; },
  tokens: {
    get: id => canvas.scene.tokens.get(id)?.object ?? null,
    get placeables() { return canvas.scene.tokens.contents.map(t => t.object); },
    setTargets() {},
    /** Core placeTokens (CL/canvas/layers/tokens.mjs:868-935, 1153-1278), driven by the click queue. */
    async placeTokens(data, { create = true, preConfirm = null, preCommit = null, allowRotation = false } = {}) {
      const user = game.user;
      const scene = canvas.scene;
      const prev = placing.get(user.id);
      if (prev) prev.cancelled = true;                         // _cancelPlacement: the open one resolves []
      const state = { cancelled: false };
      placing.set(user.id, state);
      try {
        // Previews are rebuilt with parent canvas.scene (:884); the owner check throws (:887).
        const previews = data.map(d => new TokenDoc9(d, scene, { preview: true }));
        for (const p of previews) if (!p.isOwner) throw new Error("You must be an owner of the actor to place a token");
        log.place.push({ user: user.id, count: previews.length, create, allowRotation, previews, standIn: previews[0]?.actorLink === true });
        const placed = [];
        for (let index = 0; index < previews.length;) {
          const click = await nextClick(user.id, state);
          if (state.cancelled || click === "esc") return [];
          if (click === "skip") {                               // right-click: this preview is dropped (:1202-1214)
            index++;
            continue;
          }
          const doc = previews[index];
          doc._source.x = click.x;
          doc._source.y = click.y;
          if ("level" in click) doc._source.level = click.level;
          const r = preConfirm?.({ event: {}, document: doc, index, count: previews.length });   // NOT awaited (:1183-1190)
          log.confirms.push({ user: user.id, x: click.x / G, y: click.y / G, result: r });
          if (r === false) continue;
          placed.push(doc);
          index++;
        }
        if (preCommit) {
          const ok = await preCommit(Object.freeze([...placed]));   // awaited (:1237-1241)
          if (ok !== undefined && !ok) return [];
        }
        if (!create) return placed;                             // create:false returns the previews (:1247-1253)
        return scene.createEmbeddedDocuments("Token", placed.map(p => p.toObject()));
      } finally {
        if (placing.get(user.id) === state) placing.delete(user.id);
      }
    },
  },
};

/* ---------- combat (unlinked by default, as core creates it) ---------- */
let cmbN = 0;
class Combatant9 {
  constructor(data, combat) {
    this.id = data._id ?? `cmb${String(++cmbN).padStart(13, "0")}`;
    this.parent = combat;
    this.tokenId = data.tokenId;
    this.sceneId = data.sceneId ?? null;
    this.actorId = data.actorId ?? null;
    this.initiative = data.initiative ?? null;
    this.hidden = !!data.hidden;
    this.flags = clone(data.flags ?? {});
    this._source = { group: data.group ?? null };
    this.defeated = !!data.defeated;
  }
  get documentName() { return "Combatant"; }
  get combat() { return this.parent; }
  get token() { return game.scenes.get(this.sceneId)?.tokens.get(this.tokenId) ?? null; }
  get actor() { return this.token?.actor ?? null; }
  get name() { return this.token?.name ?? this.actor?.name ?? "?"; }
  get group() { return this._source.group ? (this.parent.groups.get(this._source.group) ?? null) : null; }
  get isDefeated() { return this.defeated || !!this.actor?.statuses?.has?.("dead"); }
  getFlag(scope, key) { return this.flags?.[scope]?.[key]; }
  async update(changes, options = {}) {
    coreOp(options, this.parent);
    // sw.dsctKeys: DSCT's MIXED Combatant#_preUpdate (squad-turns.mjs:294-303): a squad member's first decrease takes
    // its start key (whatever the options); a later decrease under a taken key loses its initiative change.
    if (sw.dsctKeys && "initiative" in changes && Number(changes.initiative) < Number(this.initiative ?? 0)
      && dsctSquadTurns() && isSquadLike(this.group)) {
      const key = dsctKey(this);
      if (!dsctTurnStarted.has(key)) dsctTurnStarted.add(key);
      else {
        changes = { ...changes };
        delete changes.initiative;
        log.dsctStripped.push(this.id);
      }
    }
    const before = this.initiative;
    const exp = {};
    for (const [k, v] of Object.entries(changes)) foundry.utils.setProperty(exp, k, v);
    if ("group" in exp) {
      this._source.group = exp.group;
      delete exp.group;
    }
    mergeInto(this, exp);
    this._prevInitiative = before;
    log.combatUpdates.push({ who: this.name, id: this.id, changes: clone(changes), options: clone(options) });
    // The system's _preUpdate: every initiative DECREASE runs actor.system._onStartTurn (DSM:12232).
    if ("initiative" in changes && Number(changes.initiative) < Number(before ?? 0)) log.starts.push({ id: this.id, name: this.name });
    this.parent.setupTurns();
    emit("updateCombatant", this, exp, options, game.userId);
    return this;
  }
}
class Group9 {
  constructor(data, combat) {
    this.id = data._id ?? foundry.utils.randomID();
    this.parent = combat;
    this.type = data.type ?? "base";
    this.name = data.name ?? "Group";
    this.initiative = data.initiative ?? null;
    this.ownership = clone(data.ownership ?? { default: 0 });
    this.flags = clone(data.flags ?? {});
    const group = this;
    this.system = {
      staminaValue: data.system?.staminaValue ?? 0,
      // SquadModel's getter over minion members (DSM:15019-15024).
      get staminaMax() {
        return [...group.members].filter(m => m.actor?.system?.isMinion).reduce((s, m) => s + (Number(m.actor?.system?.stamina?.max) || 0), 0);
      },
    };
  }
  get documentName() { return "CombatantGroup"; }
  get combat() { return this.parent; }
  get members() { return new Set(this.parent.combatants.filter(c => c._source.group === this.id)); }
  getFlag(scope, key) { return this.flags?.[scope]?.[key]; }
  testUserPermission(user) { return !!user?.isGM || (this.ownership[user?.id] ?? this.ownership.default ?? 0) >= OWNER; }
  async update(changes, options = {}) {
    coreOp(options, this.parent);
    const before = this.initiative;
    if ("system.staminaValue" in changes) {
      let value = Number(changes["system.staminaValue"]);
      // Death Tracker's preUpdateCombatantGroup clamp: pool <= living minions x max (DT/death-tracker.mjs:1571-1584).
      const alive = [...this.members].filter(m => !m.isDefeated && m.actor?.system?.isMinion);
      const cap = alive.reduce((s, m) => s + (Number(m.actor?.system?.stamina?.max) || 0), 0);
      if (value > cap) {
        log.clamps.push({ group: this.name, asked: value, cap });
        value = cap;
      }
      this.system.staminaValue = value;
      log.poolWrites.push({ group: this.name, id: this.id, value, members: this.members.size });
      log.checkDefeated.push(this.id);   // the system's checkDefeatedMinions spy
    }
    if ("initiative" in changes) this.initiative = changes.initiative;
    if ("name" in changes) this.name = changes.name;
    this._prevInitiative = before;
    log.combatUpdates.push({ who: `group:${this.name}`, id: this.id, changes: clone(changes), options: clone(options) });
    emit("updateCombatantGroup", this, clone(changes), options, game.userId);
    return this;
  }
}
const reg = () => foundry.documents.ActiveEffect.registry;
let combatN = 0;
class Combat9 extends CombatBase {
  constructor({ started = true, round = 1, scene = null } = {}) {
    super();
    this.id = `combat${String(++combatN).padStart(10, "0")}`;
    this.started = started;
    this.round = round;
    this.turn = null;
    this.scene = scene;
    this.flags = {};
    this.previous = { combatantId: null, round, turn: null };
    this.turns = [];
    this.combatants = new Coll();
    this.groups = new Coll();
  }
  get documentName() { return "Combat"; }
  get combatant() { return this.turn === null || this.turn === undefined ? null : (this.turns[this.turn] ?? null); }
  getCombatantsByActor(actor) { return this.turns.filter(c => c.actor === actor || (actor?.uuid && c.actor?.uuid === actor.uuid)); }
  /** combat.turns rebuilt, keeping the current combatant (core keeps it when initiatives change). */
  setupTurns() {
    const cur = this.combatant;
    this.turns = this.combatants.contents.sort((a, b) => (Number(b.initiative ?? -1) - Number(a.initiative ?? -1)) || a.id.localeCompare(b.id));
    if (cur) {
      const i = this.turns.indexOf(cur);
      this.turn = i >= 0 ? i : null;
    }
  }
  async update(changes, options = {}) {
    coreOp(options, null);
    const prev = this.combatant;
    const oldRound = this.round;
    const oldTurn = this.turn;
    log.combatUpdates.push({ who: "combat", changes: { ...changes }, options });
    const exp = {};
    for (const [k, v] of Object.entries(changes)) foundry.utils.setProperty(exp, k, v);
    mergeInto(this, exp);
    emit("updateCombat", this, exp, options, game.userId);
    const turnChanged = "turn" in changes && changes.turn !== oldTurn;
    const roundChanged = "round" in changes && changes.round !== oldRound;
    if (roundChanged) {
      activatedGroups.clear();   // DSCT: _activatedGroupIds cleared on combatRoundChange (:291)
      dsctTurnStarted.clear();
    }
    if (turnChanged || roundChanged) {
      // The system's #triggerDSTurnEvents (active GM): turnEnd of the previous combatant, turnStart of the new one.
      this.previous = { combatantId: prev?.id ?? null, round: oldRound, turn: oldTurn };
      if (prev) await asGM(() => reg().refresh("turnEnd", { combat: this, round: oldRound, turn: null }));
      if (roundChanged) {
        await asGM(() => reg().refresh("roundEnd", { combat: this, round: oldRound }));
        await asGM(() => reg().refresh("roundStart", { combat: this, round: this.round }));
      }
      if (this.combatant) await asGM(() => reg().refresh("turnStart", { combat: this, round: this.round, turn: this.turn }));
    }
    return this;
  }
  async createEmbeddedDocuments(type, data, options = {}) {
    coreOp(options, this);
    if (type === "Combatant") {
      if (sw.failCombatantCreate > 0) {
        sw.failCombatantCreate--;
        throw new Error("combatant create refused");
      }
      const out = data.map(d => new Combatant9(d, this));
      for (const c of out) {
        this.combatants.set(c.id, c);
        log.combatantCreates.push({ id: c.id, tokenId: c.tokenId, initiative: c.initiative, group: c._source.group, options: clone(options), poolWritesBefore: log.poolWrites.length });
      }
      this.setupTurns();
      for (const c of out) emit("createCombatant", c, options, game.userId);
      return out;
    }
    if (type === "CombatantGroup") {
      const out = data.map(d => new Group9(d, this));
      for (const g of out) {
        this.groups.set(g.id, g);
        log.groupCreates.push({ id: g.id, name: g.name, initiative: g.initiative, ownership: clone(g.ownership), type: g.type });
      }
      for (const g of out) emit("createCombatantGroup", g, options, game.userId);
      return out;
    }
    throw new Error(`Combat9 ${type}`);
  }
  async deleteEmbeddedDocuments(type, ids, options = {}) {
    coreOp(options, this);
    if (type === "Combatant") {
      if (sw.failCombatantDelete > 0) {
        sw.failCombatantDelete--;
        throw new Error("combatant delete refused");
      }
      const cur = this.combatant;
      const gone = ids.map(id => {
        const c = this.combatants.get(id);
        if (!c) throw new Error(`Combatant ${id} does not exist`);
        return c;
      });
      // Core _preDeleteOperation (CL/documents/combatant.mjs:263-290): deleting the current combatant moves the
      // turn to the next combatant that stays (R§ fact 19).
      let nextCurrent = cur;
      if (cur && gone.includes(cur)) {
        const order = this.turns;
        const i = order.indexOf(cur);
        nextCurrent = [...order.slice(i + 1), ...order.slice(0, i)].find(c => !gone.includes(c)) ?? null;
        log.turnShift = { from: cur.name, to: nextCurrent?.name ?? null };
      }
      for (const c of gone) {
        this.combatants.delete(c.id);
        log.combatantDeletes.push({ id: c.id, tokenId: c.tokenId, name: c.name, options: clone(options) });
      }
      this.turn = null;
      this.setupTurns();
      if (nextCurrent) this.turn = this.turns.indexOf(nextCurrent);
      for (const c of gone) emit("deleteCombatant", c, options, game.userId);
      return gone;
    }
    if (type === "CombatantGroup") {
      const out = [];
      for (const id of ids) {
        const g = this.groups.get(id);
        if (!g) throw new Error(`CombatantGroup ${id} does not exist`);
        this.groups.delete(id);
        log.groupDeletes.push({ id, name: g.name });
        out.push(g);
      }
      for (const g of out) emit("deleteCombatantGroup", g, options, game.userId);
      return out;
    }
    throw new Error(`Combat9 ${type}`);
  }
  async updateEmbeddedDocuments(type, updates, options = {}) {
    coreOp(options, this);
    const coll = type === "Combatant" ? this.combatants : this.groups;
    const out = [];
    for (const u of updates) {
      const doc = coll.get(u._id);
      if (!doc) continue;
      const { _id, ...rest } = u;
      await doc.update(rest, options);
      out.push(doc);
    }
    return out;
  }
  /** Draw Steel's End Turn: no current combatant (DSM:11861-11867). */
  async endTurn() { return this.update({ turn: null }); }
  async nextTurn() { return this.update({ turn: this.turn === null ? 0 : Math.min(this.turn + 1, this.turns.length - 1) }); }
  /** Draw Steel's nextRound: the round, then every combatant to its turns, then every group to 1 (DSM:11872-11884). */
  async nextRound() {
    // Alternative mode: core's nextRound (turn 0), no initiative reset (DSM:11874-11877).
    if (!game.combats.isDefaultInitiativeMode) return this.update({ round: this.round + 1, turn: this.turns.length ? 0 : null });
    await this.update({ round: this.round + 1, turn: null });
    await this.updateEmbeddedDocuments("Combatant", this.combatants.contents.map(c => ({ _id: c.id, initiative: Number(c.actor?.system?.combat?.turns) || 1 })));
    await this.updateEmbeddedDocuments("CombatantGroup", this.groups.contents.map(g => ({ _id: g.id, initiative: 1 })));
  }
  async delete() {
    game.combats.delete(this.id);
    if (game.combat === this) setCombat(game.combats.contents[0] ?? null);
    // Core's Combat#_onDelete starts the "combatEnd" effect refresh without awaiting it, before the hooks run.
    foundry.documents.ActiveEffect.registry.refresh("combatEnd", { combat: this }).catch(() => {});   // core only logs a failure
    emit("deleteCombat", this, {}, game.userId);
  }
}
class CombatsColl extends Coll {
  constructor() {
    super();
    this.isDefaultInitiativeMode = true;
  }
}
game.combats = new CombatsColl();
/** A combat holding these tokens (initiative 1 each), registered and viewed as game.combat. */
function newCombat(tokens, { started = true, round = 1, scene = null, current = true } = {}) {
  const c = new Combat9({ started, round, scene });
  for (const t of tokens) {
    const cb = new Combatant9({ tokenId: t.id, sceneId: t.parent.id, actorId: t.actorId, initiative: 1, hidden: t.hidden }, c);
    c.combatants.set(cb.id, cb);
  }
  c.setupTurns();
  game.combats.set(c.id, c);
  if (current) setCombat(c);
  return c;
}
const cmbOf = (combat, token) => combat.combatants.find(c => c.tokenId === token.id) ?? null;
/** The tracker's activate button: lower the member first, then set the turn (DSM:28280-28297). */
async function activate(combat, token) {
  const c = cmbOf(combat, token);
  await c.update({ initiative: Math.max(0, (c.initiative ?? 1) - 1) });
  await combat.update({ turn: combat.turns.indexOf(c) }, { direction: 1 });
  await idle();
  return c;
}
async function endTurn(combat) {
  await combat.endTurn();
  await idle();
}
async function idle(ms = 30) {
  await settle(ms);
  await lifecycleIdle();
  await withSummonChain(() => null);
  await settle(ms);
}

/* ---------- Combat Tools squad turns and Death Tracker stand-ins ---------- */
const activatedGroups = new Set();
const dsctSquadTurns = () => !!game.settings.get("draw-steel-combat-tools", "squadSimultaneousTurns");
const isSquadLike = g => !!g && (g.type === "squad" || (g.type === "base" && g.members.size > 1));
async function dsctStart(m) {
  log.dsctStarts.push({ id: m.id, name: m.name });
  await m.update({ initiative: Math.max(0, (m.initiative ?? 1) - 1) }, { _dsctSquadBatch: true });
}
// DSCT/squad-turns.mjs:371-406: a group's initiative drop starts every member above 0 (no member skipped).
Hooks.on("updateCombatantGroup", (g, changes) => {
  if (!dsctSquadTurns() || !("initiative" in changes) || !(Number(g._prevInitiative ?? 0) > Number(g.initiative ?? 0))) return;
  activatedGroups.add(g.id);
  for (const m of [...g.members]) {
    if (!((m.initiative ?? 0) > 0)) continue;
    if (sw.dsctKeys) {
      // activateSquadMembers (:91-99): a taken key is skipped; fireStartTurn changes no initiative.
      const key = dsctKey(m);
      if (dsctTurnStarted.has(key)) {
        log.dsctSkips.push(m.id);
        continue;
      }
      dsctTurnStarted.add(key);
      log.dsctStarts.push({ id: m.id, name: m.name });
      continue;
    }
    dsctStart(m);
  }
});
// DSCT/squad-turns.mjs:408-446: a member's drop starts the OTHER members and lowers the group, unless batched,
// the group is at 0 or already activated this round.
Hooks.on("updateCombatant", (c, changes, options) => {
  if (!dsctSquadTurns() || options?._dsctSquadBatch || !("initiative" in changes)) return;
  if (!(Number(c._prevInitiative ?? 0) > Number(c.initiative ?? 0))) return;
  const g = c.group;
  if (!isSquadLike(g) || !((g.initiative ?? 0) > 0) || activatedGroups.has(g.id)) return;
  activatedGroups.add(g.id);
  for (const m of [...g.members]) if (m.id !== c.id && (m.initiative ?? 0) > 0) dsctStart(m);
  g.update({ initiative: Math.max(0, g.initiative - 1) });
});
// Death Tracker's deleteToken cleanup (cleanOrphanedCombatants, DT/death-tracker.mjs:1992-2023): still-present
// combatants of the deleted token are deleted and their squad's pool lowered.
Hooks.on("deleteToken", (token) => {
  if (!game.users.activeGM?.isSelf) return;
  for (const combat of game.combats.contents) {
    const present = combat.combatants.filter(c => c.tokenId === token.id);
    log.dtDeletes.push({ token: token.name, found: present.length });
    if (!present.length) continue;
    (async () => {
      for (const c of present) {
        const g = c.group;
        await combat.deleteEmbeddedDocuments("Combatant", [c.id], {});
        if (g && combat.groups.has(g.id)) {
          const max = Number(token.actor?.system?.stamina?.max ?? c.actor?.system?.stamina?.max) || 0;
          await g.update({ "system.staminaValue": Math.max(0, g.system.staminaValue - max) });
        }
      }
    })();
  }
});
const hookCalls = name => log.hooks.filter(h => h.name === name);
for (const name of ["dsAuto.preSummon", "dsAuto.summon", "dsAuto.dismissSummon"]) {
  Hooks.on(name, (...args) => { log.hooks.push({ name, args }); });
}

/* ---------- abilities ---------- */
let itemN = 0;
const slugOf = name => name.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
/** An ability item on an actor (world or synthetic), registered by uuid; `id` reuses an item id (token copies). */
function ability(actor, name, { id = null, type = "main", distance = { type: "ranged", primary: 10 }, target = { type: "special" }, resource = 0, powerRoll = false, attach = true, dsid = null } = {}) {
  const iid = id ?? `it${String(++itemN).padStart(14, "0")}`;
  const item = makeAbility({ uuid: `${actor.uuid}.Item.${iid}`, name, actor, damage: false });
  item.id = iid;
  item.documentName = "Item";
  Object.assign(item.system, { _dsid: dsid ?? slugOf(name), type, distance, target, resource, keywords: new Set() });
  item.system.power.roll = { enabled: powerRoll };
  item.system.effects = { contents: [] };
  item.flags = {};
  item.getFlag = (scope, key) => item.flags?.[scope]?.[key];
  item.update = async (changes) => {
    for (const [k, v] of Object.entries(changes)) foundry.utils.setProperty(item, k, v);
    return item;
  };
  item.testUserPermission = (u, l) => actor.testUserPermission(u, l);
  Object.defineProperty(item, "isOwner", { get: () => actor.testUserPermission(game.user, "OWNER") });
  item.getRollData = () => ({ ...(actor.getRollData?.() ?? {}), potency: { weak: 1, average: 2, strong: 3 } });
  if (attach) actor.items.set(iid, item);
  return item;
}
const soe = ability(borin, "Summon Source of Earth");
const soeBen = ability(benedikt, "Summon Source of Earth");
const hiw = ability(dorian, "Hesitation is Weakness", { type: "triggered", resource: 1, target: { type: "creature" }, distance: { type: "melee", primary: 1 } });
/** A monster world actor (compendium-sourced, matched by monster overlays) with its ability, and its tokens. */
function monster(name, compendiumId, abilityName, { distance = { type: "ranged", primary: 10 }, target = { type: "special" }, type = "maneuver", resource = 1, stamina = 40 } = {}) {
  const base = new WorldActor({
    name, type: "npc", _stats: { compendiumSource: `Compendium.${PACK}.Actor.${compendiumId}` }, ownership: { default: 0 },
    system: { stamina: { value: stamina, max: stamina, temporary: 0, min: 0 }, isMinion: false, combat: { turns: 1 } },
  });
  game.actors.set(base.id, base);
  registry.set(base.uuid, base);
  const item = abilityName ? ability(base, abilityName, { distance, target, type, resource }) : null;
  return { base, item };
}
/** A token of a monster with its synthetic actor's own copy of the ability (same item id, synthetic uuid). */
function monsterToken(m, label, gx, gy, opts = {}) {
  const tok = place(START, m.base, label, gx, gy, { linked: false, ...opts });
  if (m.item) {
    const copy = ability(tok.actor, m.item.name, { id: m.item.id, distance: m.item.system.distance, target: m.item.system.target, type: m.item.system.type });
    tok.actor.items.set(copy.id, copy);
  }
  return tok;
}
const monarch = monster("Goblin Monarch", "Vxxc0EcLHPPnpSbK", "Get in Here!", { distance: { type: "ranged", primary: 20 } });
const tMonarch = monsterToken(monarch, "Goblin Monarch", 14, 9);
const tMonarch2 = monsterToken(monarch, "Goblin Monarch (2)", 3, 17);
const gnoll = monster("Gnoll Abyssal Summoner", "mNtGL8Wbj8mqpCzy", "Call Abyssal Hyenas", { distance: { type: "ranged", primary: 5 } });
const tGnoll = monsterToken(gnoll, "Gnoll Abyssal Summoner", 2, 12);
const bloodlord = monster("Hobgoblin Bloodlord", "Lcoa5x1olfOONQCJ", "An Army From Blood", { type: "triggered", target: { type: "creature" } });
const tBloodlord = monsterToken(bloodlord, "Hobgoblin Bloodlord", 12, 15);
const hobgoblin = monster("Hobgoblin", "hobgoblin0000001", null);
const tHobgoblin = monsterToken(hobgoblin, "Hobgoblin Sentry", 16, 15);
const lurker = monster("Lurker", "lurker0000000001", null);
const tLurker = monsterToken(lurker, "Lurker", 8, 8, { hidden: true });
const itemOf = tok => [...tok.actor.items.values()][0];

/* ---------- library: the six M6 overlays, Hesitation is Weakness and test overlays ---------- */
const M6_FILES = ["elementalist/summon-source-of-earth.json", "monsters/get-in-here.json", "monsters/call-abyssal-hyenas.json",
  "monsters/arise-my-children.json", "monsters/an-army-from-blood.json", "monsters/new-dawn.json"];
const M6 = M6_FILES.map(f => JSON.parse(readFileSync(LIBRARY + f, "utf8")));
const HIW = JSON.parse(readFileSync(LIBRARY + "shadow/hesitation-is-weakness.json", "utf8"));
const summonEffect = (over = {}) => ({
  id: "s", type: "summon", targets: "self", actors: [{ uuid: cuuid("source") }], quantity: "1", origin: "self", side: "summoner",
  turn: "own", actsThisRound: true, squad: "none", lasts: ["encounterEnd"], ...over,
});
/** A test overlay (its own ability on Borin). */
function testAbility(name, effects, { actor = borin, distance } = {}) {
  const item = ability(actor, name, distance ? { distance } : {});
  return { item, overlay: { key: `ability:${slugOf(name)}`, version: "1.0.0", name, effects } };
}
const pairSoe = testAbility("Pair of Earth", [summonEffect({ quantity: "2" })]);
const twoRows = testAbility("Two Rows", [summonEffect({ id: "a", turn: "after" }), summonEffect({ id: "b", actors: [{ uuid: cuuid("runner") }], turn: "after", squad: "none" })]);
const familiar = testAbility("Call Runners", [summonEffect({ actors: [{ uuid: cuuid("runner") }], quantity: "2", squad: "join", turn: "after" })]);
const runnersOwn = testAbility("Runners Own", [summonEffect({ actors: [{ uuid: cuuid("runner") }], quantity: "2", squad: "join", turn: "own" })]);
const shortTurn = testAbility("Short Shape", [summonEffect({ lasts: ["summonerTurnEnd"] })]);
const nopeQty = testAbility("Bad Count", [summonEffect({ quantity: "@nope" })]);
const special = testAbility("No Range", [summonEffect({})], { distance: { type: "special" } });
const lockSoe = testAbility("Locked Earth", [summonEffect({ lockOnZero: true, carryStamina: true, lasts: ["encounterEnd", "zeroStamina"] })]);
const dyingSoe = testAbility("Dying Earth", [summonEffect({ lasts: ["summonerDying", "encounterEnd"] })]);
const ownSoe = testAbility("Own Earth", [summonEffect({})]);
const lateSoe = testAbility("Late Earth", [summonEffect({ actsThisRound: false })]);
const noneSoe = testAbility("Turnless Earth", [summonEffect({ turn: "none" })]);
const runnersNew = testAbility("Runners Anew", [summonEffect({ actors: [{ uuid: cuuid("runner") }], quantity: "2", squad: "new", turn: "own" })]);
const afterSoe = testAbility("After Earth", [summonEffect({ turn: "after" })]);
const pairAfter = testAbility("Pair After", [summonEffect({ actors: [{ uuid: cuuid("runner") }], quantity: "2", squad: "none", turn: "after" })]);
const eitherSoe = testAbility("Either Earth", [summonEffect({ actors: [{ uuid: cuuid("source"), label: "the big one" }, { uuid: cuuid("runner") }] })]);
const TESTS = [eitherSoe, pairAfter, afterSoe, pairSoe, twoRows, familiar, runnersOwn, shortTurn, nopeQty, special, lockSoe, dyingSoe, ownSoe, lateSoe, noneSoe, runnersNew];
const SOURCE = { id: "stef-ds-automation.library", priority: 50, overlays: [...M6, HIW, ...TESTS.map(t => t.overlay)] };

/* ---------- cards ---------- */
/** An ability card by `author` for `item` (no power roll: the summon row sits on the user's own row). */
function useCard(item, { author = gm, targets = [], token = null } = {}) {
  const tok = token ?? item.actor.token ?? null;
  setUser(author);
  author.targets = new Set(targets.map(t => t.object));
  const parts = { abilityUse000000: { _id: "abilityUse000000", type: "abilityUse", abilityUuid: item.uuid } };
  const msg = new Message({ type: "standard", parts, speaker: { scene: tok?.parent?.id ?? null, token: tok?.id ?? null } });
  Hooks.call("preCreateChatMessage", msg, {}, {}, author.id);
  msg.isAuthor = true;
  msg.author = author;
  messages.set(msg.id, msg);
  setUser(gm);
  author.targets = new Set();
  Hooks.callAll("createChatMessage", msg, {}, author.id);
  return msg;
}
const opsOf = msg => Object.values(getResolution(msg)?.ops ?? {});
const sumOp = msg => opsOf(msg).find(o => o.kind === "summon") ?? null;
const sumOps = msg => opsOf(msg).filter(o => o.kind === "summon").sort((a, b) => a.order - b.order);
const liveOp = (msg, opId) => getResolution(messages.get(msg.id) ?? msg)?.ops?.[opId] ?? null;
/** The row's Summon button on `user`'s client (place.mjs), with the relay as partActions.request. */
async function pick(user, msg, op = sumOp(msg), clickList = null) {
  if (clickList) clicks(user, ...clickList);
  await as(user, () => runSummonPick({ message: msg, res: getResolution(msg), op, request: requestOp }));
  await idle();
}
/** Relay an apply as `user` (forged or not). */
const relayApply = (user, msg, opIds, extra = {}) => as(user, () => requestOp({ action: "apply", messageId: msg.id, opIds, ...extra }));
const sq = (gx, gy, extra = {}) => ({ x: gx * G, y: gy * G, elevation: 0, level: LEVEL, rotation: 0, ...extra });
const tokensOf = id => summonTokens(id);
const summonTokensOn = (scene = START) => scene.tokens.filter(t => t.flags?.["stef-ds-automation"]?.summon);
const worldActorsOf = key => game.actors.raw ? [...game.actors.values()].filter(a => a._stats?.compendiumSource === cuuid(key)) : [];
const textOf = (msg, user, kind = "summon") => as(user, () => {
  const v = buildView(msg, getResolution(msg));
  return v.rows.flatMap(r => r.ops).find(o => o.kind === kind) ?? null;
});
/** Run with a 5 s guard (deadlock check, H42/H51). */
async function within(ms, p, what) {
  let timer;
  const out = await Promise.race([p.then(v => ({ v })), new Promise(r => { timer = setTimeout(() => r(null), ms); })]);
  clearTimeout(timer);
  assert.ok(out, `${what}: finished within ${ms} ms`);
  return out.v;
}

/* ---------- per-scenario reset ---------- */
const SETTINGS = {
  summonMode: "auto", summonPlacement: "pick", summonTurnChain: true, summonSquadLabels: true, summonEncounterEnd: "listed",
  summonOwnerPotency: true, summonUpkeepSeconds: 30, cardActionRole: 4, triggersEnabled: true, triggerPromptSeconds: 20,
  triggerFallback: "director", triggerNpcs: true, deferToTriggersModule: true,
};
async function fresh() {
  await settle(20);
  await lifecycleIdle();
  await withSummonChain(() => null);
  setUser(gm);
  setActiveGM(gm);
  answerFn = () => undefined;
  for (const u of ALL_USERS) {
    u.active = true;
    u.intercept = null;
    u.targets = new Set();
  }
  for (const [k, v] of Object.entries(SETTINGS)) await set(k, v);
  for (const [k, v] of Object.entries(DSCT_DEFAULTS)) await game.settings.set("draw-steel-combat-tools", k, v);
  game.combats.isDefaultInitiativeMode = true;
  sw.failCombatantCreate = 0;
  sw.failCombatantDelete = 0;
  sw.failNextUpdate = null;
  sw.dsctKeys = false;
  dsctTurnStarted.clear();
  // Open prompts and dialogs of the previous scenario.
  for (const o of openUpkeeps()) cancelUpkeep(o.summonId, "cancelled");
  for (const id of openUpkeepDialogs()) closeUpkeepDialog(id);
  for (const d of dialogs) if (!d.closed) d.dialog.close();
  // Summon tokens of the previous scenario go quietly (internal: our own listeners do nothing).
  for (const scene of game.scenes.contents) {
    const ids = scene.tokens.filter(t => t.flags?.["stef-ds-automation"]?.summon || t.extra).map(t => t.id);
    if (ids.length) await scene.deleteEmbeddedDocuments("Token", ids, { "stef-ds-automation": { internal: true } });
    for (const t of scene.tokens.contents) if (t.home) Object.assign(t._source, { x: t.home.x, y: t.home.y, disposition: t.home.disposition, hidden: t.home.hidden });
  }
  game.combats.clear();
  setCombat(null);
  activatedGroups.clear();
  for (const a of everyone) {
    a.system.stamina.value = a.system.stamina.max;
    a.statuses.clear();
    a.system.hero.primary.value = a.home.value;
    a.system.hero.xp = 0;
    a.system.hero.victories = 0;
    for (const it of a.items.values()) if (it.flags?.["stef-ds-automation"]?.summonState) delete it.flags["stef-ds-automation"].summonState;
  }
  hiddenActors.clear();
  views.clear();
  clickQ.clear();
  placing.clear();
  packOnline(true);
  delete log.turnShift;
  clear();
  dialogs.length = 0;
}

/* ---------- registration ---------- */
{
  const reg9 = api.library.registerSource(SOURCE);
  assert.deepEqual([reg9.accepted, reg9.rejected], [SOURCE.overlays.length, 0], `overlays pass the core schema: ${JSON.stringify(reg9.problems ?? reg9)}`);
  Hooks.callAll("canvasReady");
}

/* ======================================================================== */
/*  H1: schema                                                               */
/* ======================================================================== */
{
  const { validateOverlay, normalizeOverlay, SUMMON_DEFAULTS } = schema;
  for (const o of M6) assert.ok(validateOverlay(o).ok, `${o.key}: ${JSON.stringify(validateOverlay(o).errors)}`);
  const base = { key: "ability:x", version: "1.0.0", name: "X" };
  const refused = (over, re, label) => {
    const eff = summonEffect(over);
    for (const [k, v] of Object.entries(over)) if (v === undefined) delete eff[k];
    const r = validateOverlay({ ...base, effects: [eff] });
    assert.ok(!r.ok, `${label}: refused`);
    assert.ok(r.errors.some(e => re.test(e)), `${label}: ${JSON.stringify(r.errors)}`);
  };
  refused({ count: 2 }, /count/, "count on a summon");
  refused({ actors: [{ uuid: "Actor.short" }] }, /Actor uuid/, "bad actor uuid");
  refused({ quantity: 0 }, /quantity/, "quantity 0");
  refused({ quantity: 11 }, /quantity/, "quantity 11");
  refused({ lasts: ["manual", "encounterEnd"] }, /manual/, "manual combined");
  refused({ upkeep: 2, lasts: ["encounterEnd"] }, /summonerTurnStart/, "upkeep without summonerTurnStart");
  refused({ targets: "targets" }, /own row|self/, "targets: targets");
  refused({ filter: "allies" }, /filter/, "filter");
  refused({ potency: { characteristic: "might", value: "2" } }, /potency/, "potency");
  refused({ actors: Array.from({ length: 7 }, (_v, i) => ({ uuid: `Compendium.${PACK}.Actor.aaaaaaaaaaaaaaa${i}` })) }, /actors/, "7 actors");
  refused({ actors: [{ uuid: cuuid("runner") }, { uuid: cuuid("runner") }] }, /duplicate/, "duplicate actors");
  // normalizeOverlay fills the defaults and maps a world-relative link to the monsters pack.
  const n = normalizeOverlay({ ...base, effects: [{ id: "s", type: "summon", actors: [{ uuid: `Actor.${STAT.source.id}` }] }] });
  const e = n.effects[0];
  assert.equal(e.actors[0].uuid, cuuid("source"), "Actor.<id> -> Compendium.draw-steel.monsters.Actor.<id>");
  assert.equal(e.targets, "self");
  for (const [k, v] of Object.entries(SUMMON_DEFAULTS)) assert.deepEqual(e[k], Array.isArray(v) ? [...v] : v, `default ${k}`);
  console.log("ok H1 schema: six overlays valid, eleven refusals, normalizeOverlay defaults and uuid mapping");
}

/* ======================================================================== */
/*  H2: detached entries                                                     */
/* ======================================================================== */
{
  await fresh();
  const soeOverlay = M6[0];
  const eff = schema.normalizeOverlay(soeOverlay).effects[0];
  const [entry] = entries.effectToEntries(eff, soeOverlay.key);
  assert.equal(entry.type, "dsAuto.summon");
  assert.deepEqual(entry.dsAuto.actors, [cuuid("source")], "actors as uuid strings");
  assert.equal(entry.dsAuto.quantity, "1");
  assert.deepEqual(entry.dsAuto.lasts, ["summonerTurnStart", "encounterEnd", "zeroStamina"]);
  assert.equal(entry.dsAuto.actsThisRound, true);
  assert.equal(entry.dsAuto.upkeep, 2);
  assert.equal(entry.dsAuto.targets, "self");
  const back = entries.entryToEffect(entry);
  assert.deepEqual(back.actors, [{ uuid: cuuid("source") }], "actors back as {uuid}");
  assert.deepEqual(back.lasts, ["summonerTurnStart", "encounterEnd", "zeroStamina"]);
  assert.equal(back.upkeep, 2);
  assert.equal(back.actsThisRound, true);
  assert.equal(back.targets, "self");
  // A hand-made entry (the sheet's sets) comes back on the user's own row whatever its targets say.
  const hand = {
    _id: "dsAutohand000001", type: "dsAuto.summon", name: "Hand Shaped",
    dsAuto: { targets: "targets", actors: new Set([cuuid("source")]), lasts: new Set(["encounterEnd"]), actsThisRound: true, quantity: "1", origin: "self", turn: "own", squad: "none", side: "summoner" },
  };
  const handEff = entries.entryToEffect(hand);
  assert.equal(handEff.targets, "self");
  assert.deepEqual(handEff.lasts, ["encounterEnd"]);
  const handItem = ability(borin, "Hand Shaped");
  handItem.system.effects = { contents: [hand] };
  const msg = useCard(handItem, { author: player2 });
  await idle();
  const op = sumOp(msg);
  assert.ok(op, "a summon row from the entry");
  const res = getResolution(msg);
  assert.equal(res.targets[op.targetKeys[0]]?.self, true, "on the user's own row (engine self record)");
  assert.equal(op.summonerTokenUuid, tBorin.uuid);
  borin.items.delete(handItem.id);
  console.log("ok H2 entries: Source of Earth round trip; a hand-made entry plans on the self row");
}

/* ======================================================================== */
/*  H3: special effect types                                                 */
/* ======================================================================== */
{
  const reg9 = ds.CONFIG.SpecialEffect["dsAuto.summon"];
  assert.ok(reg9, "dsAuto.summon registered (summon is in EFFECT_TYPES)");
  assert.equal(ds.CONFIG.SpecialEffect.summon, undefined, "the bare name stays the system's");
  assert.equal(reg9.label, "TYPES.SpecialEffect.dsAuto.summon");
  const fields = reg9.documentClass.defineSchema().dsAuto.fields;
  for (const k of schema.TYPE_FIELDS.summon) assert.ok(fields[k], `field ${k}`);
  assert.equal(fields.actsThisRound.initial, true, "actsThisRound initial true");
  assert.equal(fields.targets.initial, "self");
  assert.deepEqual(Object.keys(fields.targets.choices), ["self"], "targets: only self");
  assert.ok(fields.actors instanceof SetField && fields.lasts instanceof SetField);
  assert.deepEqual(Object.keys(fields.turn.choices), ["after", "own", "with", "none"]);
  assert.throws(() => schema.assertNotReserved("summon"));
  assert.doesNotThrow(() => schema.assertNotReserved("dsAuto.summon"));
  console.log("ok H3 types: dsAuto.summon with the §1.1 fields, SpecialEffect.summon untouched, assertNotReserved");
}

/* ======================================================================== */
/*  H4: resolve                                                              */
/* ======================================================================== */
{
  await fresh();
  const msg = useCard(soe, { author: player2 });
  await idle();
  const op = sumOp(msg);
  assert.ok(op, "summon row");
  assert.equal(op.self, true);
  assert.equal(getResolution(msg).targets[op.targetKeys[0]].self, true, "the self row");
  assert.equal(op.mode, "prompt", "auto becomes prompt (placed on the canvas)");
  assert.equal(op.status, "pending");
  assert.equal(op.quantity, 1);
  assert.equal(op.distance, 10, "the ability's distance");
  assert.equal(op.turn, "after");
  const c = op.choices[0];
  assert.deepEqual([c.name, c.img, c.width, c.height, c.isMinion], ["Source of Earth", "source-token.webp", 2, 2, false]);
  assert.ok(c.worldActorId, "world actor prepared");
  const wa = game.actors.raw(c.worldActorId);
  assert.equal(wa.flags["draw-steel"].summonSource, soe.uuid, "reuse key: Borin's item");
  assert.equal(wa._stats.compendiumSource, cuuid("source"));
  const folder = game.folders.get(wa.folder);
  assert.equal(folder?.name, "Summons (ds-auto)");
  assert.deepEqual(wa.ownership, { default: 0, gm: 3 }, "GM-owned world actor");
  assert.equal(log.actorCreates.length, 1, "imported once");
  assert.equal(log.fromCompendium[0].keepId, false, "never keepId");
  assert.equal(log.actorCreates[0].options.fromCompendium, true);
  assert.equal(msg.updates, 1, "one message write (the import is not one)");
  console.log("ok H4 resolve: one self row, prompt, quantity 1, distance 10, choice prepared, one import, one write");
}

/* ======================================================================== */
/*  H5: reuse                                                                */
/* ======================================================================== */
{
  await fresh();
  const m1 = useCard(soe, { author: player2 });
  await idle();
  assert.equal(log.actorCreates.length, 0, "a second card reuses the world actor");
  const id1 = sumOp(m1).choices[0].worldActorId;
  const m2 = useCard(soeBen, { author: player });
  await idle();
  const id2 = sumOp(m2).choices[0].worldActorId;
  assert.notEqual(id1, id2, "another hero's copy imports its own");
  assert.equal(log.actorCreates.at(-1).source, soeBen.uuid);
  clear();
  const g1 = useCard(itemOf(tMonarch), { token: tMonarch });
  await idle();
  const g2 = useCard(itemOf(tMonarch2), { token: tMonarch2 });
  await idle();
  const r1 = sumOp(g1);
  const r2 = sumOp(g2);
  assert.ok(r1.choices[0].worldActorId && r1.choices[0].worldActorId === r2.choices[0].worldActorId, "two Goblin Monarch tokens share one Goblin Runner");
  assert.equal(log.actorCreates.length, 1);
  assert.equal(log.actorCreates[0].source, monarch.item.uuid, "the base actor's item (CH1)");
  assert.equal(r1.sourceUuid, monarch.item.uuid);
  assert.equal(r1.quantity, 2);
  assert.equal(r1.distance, 20);
  console.log("ok H5 reuse: second card reuses, another hero imports its own, two monarch tokens share one runner actor");
}

/* ======================================================================== */
/*  H6: plan outcomes                                                        */
/* ======================================================================== */
{
  await fresh();
  const outcome = async (item, opts = {}) => {
    const msg = useCard(item, opts);
    await idle();
    const op = sumOp(msg);
    return op ? `${op.status} ${op.reason ?? ""}`.trim() : "none";
  };
  const own = borin.token;
  borin.token = null;
  try {
    // Review fix: the summon's own reason, and no Summon button (it could never work on this card).
    assert.equal(await outcome(soe, { author: player2, token: null }), "skipped noSummonerToken");
    const lone = messages.contents.at(-1);
    assert.equal(sumOp(lone).noApply, true, "noApply");
    assert.equal(textOf(lone, gm).canApply, false, "no Summon button, not even for the Director");
  } finally {
    borin.token = own;
  }
  assert.equal(await outcome(itemOf(tBloodlord), { token: tBloodlord }), "skipped noAnchor", "origin target without a target");
  soe.flags["stef-ds-automation"] = { summonState: { combatId: null, stamina: 0, at: 0, lockedAt: 0 } };
  assert.equal(await outcome(soe, { author: player2 }), "skipped summonLocked");
  delete soe.flags["stef-ds-automation"];
  assert.equal(await outcome(nopeQty.item, { author: player2 }), "failed formulaInvalid");
  assert.equal(await outcome(special.item, { author: player2 }), "failed noDistance");
  // Review fix: the Director's Apply (summonPlacement auto, GM search) keeps noDistance (not noSpace).
  await set("summonPlacement", "auto");
  const nd = messages.contents.at(-1);
  await api.applyOps(nd.id, [sumOp(nd).opId]);
  await idle();
  assert.equal(`${sumOp(nd).status} ${sumOp(nd).reason}`, "failed noDistance", "GM apply: still noDistance");
  await set("summonPlacement", "pick");
  await set("summonMode", "off");
  assert.equal(await outcome(soe, { author: player2 }), "none", "summonMode off: no row");
  console.log("ok H6 plan outcomes: noSummonerToken (noApply), noAnchor, summonLocked, formulaInvalid, noDistance, off");
}

/* ======================================================================== */
/*  H7: zero cost                                                            */
/* ======================================================================== */
{
  await fresh();
  const combat = newCombat([tBorin, tBen]);
  const strike = makeAbility({ uuid: `${borin.uuid}.Item.strike9000000001`, name: "Plain Strike", actor: borin });
  clear();
  const msg = world.postAbility(strike, { 2: [{ document: tBen, actor: benedikt }] }, { 2: [{ total: 3, options: {} }] }, { author: gm });
  await idle();
  assert.equal(benedikt.system.stamina.value, 27, "the damage landed");
  assert.equal(log.actorFinds + log.fromCompendium.length + log.actorCreates.length, 0, "no world actor lookup");
  assert.equal(log.combatUpdates.filter(u => u.who === "combat").length, 0, "no combat flag write");
  assert.equal(msg.updates, 1, "one write");
  assert.equal(combat.flags["stef-ds-automation"], undefined);
  console.log("ok H7 zero cost: no actor lookup, no combat write, one message write");
}

/* ======================================================================== */
/*  H8: exit criterion, placement                                            */
/* ======================================================================== */
let h8 = null;
{
  await fresh();
  const msg = useCard(soe, { author: player2 });
  await idle();
  const op = sumOp(msg);
  const wa = game.actors.raw(op.choices[0].worldActorId);
  const ownership = clone(wa.ownership);
  await pick(player2, msg, op, [{ x: 10, y: 5 }]);
  assert.equal(log.place.length, 1, "one placeTokens");
  const p = log.place[0];
  assert.equal(p.user, "p2", "on Test's client");
  assert.equal(p.count, 1);
  assert.equal(p.create, false);
  assert.equal(p.standIn, false, "the world actor's preview");
  assert.equal(as(player2, () => p.previews[0].isOwner), true, "owned through the local delta");
  assert.equal(p.previews[0].level, LEVEL, "Borin's level");
  const req = relayed("apply")[0];
  assert.ok(req && req.from === "p2", "apply relayed by Test");
  assert.deepEqual(req.data.places, { [op.opId]: { actor: cuuid("source"), squares: [sq(10, 5)] } });
  const toks = summonTokensOn();
  assert.equal(toks.length, 1, "one token");
  const t = toks[0];
  assert.equal(t.name, "Source of Earth");
  assert.equal(t.disposition, 1, "Borin's disposition (friendly)");
  assert.deepEqual(t.delta.ownership, { p2: 3 }, "Test owns it through the delta");
  assert.deepEqual(wa.ownership, ownership, "base actor ownership unchanged");
  assert.equal(t.delta.flags.world.ownerUuid, borin.uuid);
  assert.equal(t.flags["draw-steel"]?.summoner, undefined);
  assert.equal(t.delta.flags["draw-steel"], undefined, "never flags.draw-steel.summoner");
  const f = t.flags["stef-ds-automation"].summon;
  for (const k of ["summonId", "summonerActorUuid", "summonerTokenUuid", "itemUuid", "sourceUuid", "messageId", "opId", "worldActorId", "side", "turn", "lasts", "upkeep", "carryStamina", "lockOnZero", "combatId", "createdRound", "createdAt", "index", "count"]) {
    assert.ok(k in f, `token flag ${k}`);
  }
  assert.deepEqual([f.summonerActorUuid, f.itemUuid, f.messageId, f.opId, f.upkeep, f.index, f.count], [borin.uuid, soe.uuid, msg.id, op.opId, 2, 0, 1]);
  assert.equal(log.tokenCreates[0].options["stef-ds-automation"]?.internal, true);
  assert.equal(log.tokenCreates[0].options.controlObject, false);
  assert.equal(as(player2, () => t.isOwner), true, "Test can control it");
  const after = liveOp(msg, op.opId);
  assert.equal(after.status, "applied");
  assert.equal(after.byClient, true);
  assert.equal(after.placed, 1);
  assert.equal(after.combatId, null);
  assert.ok(!world.notifications.some(n => /Refused/.test(n[1])), "no refusal warning");
  h8 = { msg, op: after };
  console.log("ok H8 exit: Test picks one square, the GM creates a friendly token owned through the delta, row applied");
}

/* ======================================================================== */
/*  H9: picker checks (synchronous preConfirm)                               */
/* ======================================================================== */
const warnings = () => world.notifications.filter(n => n[0] === "warn").map(n => String(n[1]));
{
  await fresh();
  const msg = useCard(pairSoe.item, { author: player2 });
  await idle();
  const n0 = world.notifications.length;
  // Benedikt's square, 11 away, a legal square, overlapping the batch's first (2x2), a legal one.
  await pick(player2, msg, sumOp(msg), [{ x: 6, y: 4 }, { x: 16, y: 5 }, { x: 8, y: 2 }, { x: 9, y: 3 }, { x: 10, y: 2 }]);
  assert.deepEqual(log.confirms.map(c => c.result), [false, false, true, false, true], "preConfirm verdicts");
  assert.ok(log.confirms.every(c => typeof c.result === "boolean"), "synchronous: booleans, never a promise");
  const w = world.notifications.slice(n0).filter(n => n[0] === "warn").map(n => n[1]);
  assert.deepEqual(w, ["DSAUTO.Summon.Picker.occupied", "DSAUTO.Summon.Picker.tooFar", "DSAUTO.Summon.Picker.occupied"], "one warning each");
  const op = liveOp(msg, sumOp(msg).opId);
  assert.equal(op.status, "applied");
  assert.equal(op.placed, 2);
  assert.deepEqual(summonTokensOn().map(t => [t.x / G, t.y / G]).sort(), [[10, 2], [8, 2]].sort());
  console.log("ok H9 picker: occupied (Benedikt), tooFar, overlap in the batch refused with one warning each; legal ones accepted");
}

/* ======================================================================== */
/*  H10: right-click skip, Escape                                            */
/* ======================================================================== */
{
  await fresh();
  const msg = useCard(pairSoe.item, { author: player2 });
  await idle();
  await pick(player2, msg, sumOp(msg), [{ x: 10, y: 2 }, "skip"]);
  const op = liveOp(msg, sumOp(msg).opId);
  assert.equal(op.status, "applied");
  assert.deepEqual([op.placed, op.requested], [1, 2]);
  const detail = textOf(msg, player2).detail;
  assert.ok(detail.includes('DSAUTO.Card.SummonPlaced {"placed":1,"requested":2}'), detail);
  assert.ok(textOf(msg, player2).label.includes('"count":1'), "applied: the placed count");
  // Review fix: after Undo the label shows the quantity the next pick offers, not the old placed count.
  await as(player2, () => api.undoOps(msg.id, [op.opId]));
  await idle();
  assert.equal(liveOp(msg, op.opId).status, "undone");
  assert.ok(textOf(msg, player2).label.includes('"count":2'), `undone: the quantity (${textOf(msg, player2).label})`);
  const before = relayed("apply").length;
  const m2 = useCard(pairSoe.item, { author: player2 });
  await idle();
  await pick(player2, m2, sumOp(m2), ["esc"]);
  assert.equal(relayed("apply").length, before, "Escape: no relay call");
  assert.equal(liveOp(m2, sumOp(m2).opId).status, "pending");
  // Every preview skipped: nothing sent either.
  await pick(player2, m2, sumOp(m2), ["skip", "skip"]);
  assert.equal(relayed("apply").length, before, "all skipped: no relay call");
  console.log("ok H10 skip: 1 of 2 placed; Escape and all-skipped send nothing");
}

/* ======================================================================== */
/*  H11: the summoner's scene not viewed                                     */
/* ======================================================================== */
{
  await fresh();
  const msg = useCard(soe, { author: player2 });
  await idle();
  view(player2, OTHER);
  const n0 = world.notifications.length;
  await pick(player2, msg, sumOp(msg), [{ x: 10, y: 5 }]);
  assert.equal(log.place.length, 0, "no picker");
  assert.equal(log.relay.length, 0, "no request");
  assert.ok(world.notifications.slice(n0).some(n => n[1] === "DSAUTO.Summon.NeedsCanvas"), "NeedsCanvas");
  // Another level of the same scene: the same.
  view(player2, START, "level00000000002");
  await pick(player2, msg, sumOp(msg));
  assert.equal(log.place.length, 0);
  console.log("ok H11 another scene / level: NeedsCanvas, no request");
}

/* H11b (review fix): the viewed scene changes while the choice dialog is open: checked again before the picker. */
{
  await fresh();
  const msg = useCard(eitherSoe.item, { author: player2 });
  await idle();
  answerFn = rec => {
    if (rec.kind !== "choose") return undefined;
    view(player2, OTHER);   // the Director pulls the players to another scene meanwhile
    return { action: "summon", option: 0 };
  };
  const n0 = world.notifications.length;
  clear();
  await pick(player2, msg, sumOp(msg), [{ x: 10, y: 5 }]);
  assert.equal(log.place.length, 0, "no picker on the other map");
  assert.equal(liveOp(msg, sumOp(msg).opId).status, "pending", "nothing applied");
  assert.ok(world.notifications.slice(n0).some(n => n[1] === "DSAUTO.Summon.NeedsCanvas"), "NeedsCanvas");
  console.log("ok H11b scene changed during the choice dialog: NeedsCanvas, no picker, nothing sent");
}

/* ======================================================================== */
/*  H12: relay shapes                                                        */
/* ======================================================================== */
{
  await fresh();
  const ok1 = { actor: cuuid("source"), squares: [sq(10, 5)] };
  assert.equal(validPlaces(null, ["a"]), true);
  assert.equal(validPlaces({ a: ok1 }, ["a"]), true);
  assert.equal(validPlaces({ a: { ...ok1, foo: 1 } }, ["a"]), false, "unknown key");
  assert.equal(validPlaces({ a: { squares: Array.from({ length: 11 }, (_v, i) => sq(i, 0)) } }, ["a"]), false, "11 squares");
  assert.equal(validPlaces({ a: { squares: [{ ...sq(1, 1), x: Infinity }] } }, ["a"]), false, "x Infinity");
  assert.equal(validPlaces({ a: { squares: [{ ...sq(1, 1), level: 5 }] } }, ["a"]), false, "level 5");
  assert.equal(validPlaces({ b: ok1 }, ["a"]), false, "key not in opIds");
  assert.equal(validPlaces({ a: { squares: [] } }, ["a"]), false, "empty squares");
  assert.equal(validPlaces({ a: { squares: [{ x: 1, y: 2, elevation: 0 }] } }, ["a"]), false, "level missing");
  assert.equal(validPlaces({ a: { actor: cuuid("runner") } }, ["a"]), true, "the actor alone (GM search)");
  assert.equal(validPlaces({ a: {} }, ["a"]), false, "neither actor nor squares");
  // Review fix: the ability's range per distance type (cube / wall secondary, line tertiary).
  const { abilityDistance } = await imp("engine/library-plan.mjs");
  const withDistance = distance => ({ system: { distance }, getRollData: () => ({}) });
  assert.equal(abilityDistance(withDistance({ type: "ranged", primary: 10 })), 10);
  assert.equal(abilityDistance(withDistance({ type: "cube", primary: 3, secondary: 10 })), 10, "cube: within 10");
  assert.equal(abilityDistance(withDistance({ type: "wall", primary: 5, secondary: 8 })), 8, "wall: within 8");
  assert.equal(abilityDistance(withDistance({ type: "line", primary: 5, secondary: 1, tertiary: 2 })), 2, "line: within 2");
  assert.equal(abilityDistance(withDistance({ type: "meleeRanged", primary: 1, secondary: 5 })), 5);
  const msg = useCard(soe, { author: player2 });
  await idle();
  const op = sumOp(msg);
  await assert.rejects(relayApply(player2, msg, [op.opId], { places: { [op.opId]: { squares: [] } } }), /DSAUTO\.Relay\.BadRequest/);
  await assert.rejects(relayApply(player2, msg, [op.opId], { places: { other: ok1 } }), /DSAUTO\.Relay\.BadRequest/);
  assert.equal(summonTokensOn().length, 0);
  console.log("ok H12 relay shapes: validPlaces refusals, BadRequest on the relay");
}

/* ======================================================================== */
/*  H13: the GM's checks against forged requests                             */
/* ======================================================================== */
const tFar = place(OTHER, hobgoblin.base, "Far Sentry", 3, 3, { linked: false });
{
  await fresh();
  const msg = useCard(soe, { author: player2 });
  await idle();
  const op = sumOp(msg);
  const forge = async (squares, actor = cuuid("source")) => {
    await relayApply(player2, msg, [op.opId], { places: { [op.opId]: { actor, squares } } });
    const r = liveOp(msg, op.opId);
    return `${r.status} ${r.reason ?? ""} ${r.index ?? "-"}`;
  };
  assert.equal(await forge([sq(10, 5), sq(10, 2)]), "failed tooMany -", "2 squares for quantity 1");
  assert.equal(await forge([sq(16, 5)]), "failed tooFar 0", "11 away");
  assert.equal(await forge([sq(6, 4)]), "failed occupied 0", "on Benedikt");
  assert.equal(await forge([sq(10, 5, { level: "level00000000002" })]), "failed wrongLevel 0", "another level");
  assert.equal(await forge([sq(10, 5, { x: 1050 })]), "failed badPlace 0", "not snapped");
  assert.equal(await forge([sq(10, 5)], cuuid("runner")), "failed actorNotAllowed -", "not a choice");
  assert.equal(summonTokensOn().length, 0, "no token for a refused request");
  const view9 = textOf(msg, gm);
  assert.equal(liveOp(msg, op.opId).reason, "actorNotAllowed");
  assert.ok(view9.canApply, "a failed row keeps its Summon button");
  assert.equal(await forge([sq(10, 5)]), "applied  -", "a later legal apply works");
  // Anchor on another scene (an api card measured from a token elsewhere).
  const out = await api.summon({ summoner: tBorin, actor: cuuid("runner"), origin: "target", anchor: tFar, places: "auto" });
  const apiOp = opsOf(messages.get(out.messageId))[0];
  assert.deepEqual([apiOp.status, apiOp.reason], ["failed", "wrongScene"]);
  console.log("ok H13 GM checks: tooMany, tooFar, occupied, wrongLevel, badPlace, actorNotAllowed, wrongScene; then applied");
}

/* ======================================================================== */
/*  H14: authorization                                                       */
/* ======================================================================== */
{
  await fresh();
  const msg = useCard(soe, { author: player2 });
  await idle();
  const op = sumOp(msg);
  const places = { [op.opId]: { actor: cuuid("source"), squares: [sq(10, 5)] } };
  await assert.rejects(relayApply(player, msg, [op.opId], { places }), /DSAUTO\.Relay\.Denied/, "a player not owning Borin");
  // "Apply all" never applies a summon row.
  await api.applyOps(msg.id);
  await idle();
  assert.equal(liveOp(msg, op.opId).status, "pending", "Apply all leaves it");
  // Test without places: pending placeOnCanvas.
  await relayApply(player2, msg, [op.opId]);
  assert.deepEqual([liveOp(msg, op.opId).status, liveOp(msg, op.opId).reason], ["pending", "placeOnCanvas"]);
  // Test (owner) with cardActionRole 4 and the row in mode prompt: allowed (the bypass sits before the floor).
  assert.equal(game.settings.get("stef-ds-automation", "cardActionRole"), 4);
  assert.equal(liveOp(msg, op.opId).mode, "prompt");
  await relayApply(player2, msg, [op.opId], { places });
  await idle();
  assert.equal(liveOp(msg, op.opId).status, "applied");
  // A synthetic api.summon row is the Director's (D10): refused to Test.
  view(gm, OTHER);
  const out = await api.summon({ summoner: tBorin, actor: cuuid("runner") });
  const card = messages.get(out.messageId);
  const synOp = opsOf(card)[0];
  assert.equal(synOp.status, "pending", "not viewing the summoner's scene: the card waits for its Summon button");
  await assert.rejects(relayApply(player2, card, [synOp.opId], { places: { [synOp.opId]: { actor: cuuid("runner"), squares: [sq(10, 2)] } } }), /DSAUTO\.Relay\.Denied/);
  // Review fix: also under a lowered role floor and mode manual, and the GM's own world actor is never granted.
  await set("cardActionRole", 1);
  const out2 = await api.summon({ summoner: tBorin, actors: [monarch.base.uuid], mode: "manual" });
  await idle();
  const card2 = messages.get(out2.messageId);
  const syn2 = opsOf(card2)[0];
  assert.equal(syn2.mode, "manual");
  await assert.rejects(relayApply(player2, card2, [syn2.opId], { places: { [syn2.opId]: { actor: monarch.base.uuid, squares: [sq(10, 2)] } } }), /DSAUTO\.Relay\.Denied/, "role floor 1, manual: still the Director's");
  await assert.rejects(as(player2, () => requestOp({ action: "summonPrepare", messageId: card2.id, opId: syn2.opId, grant: true })), /DSAUTO\.Relay\.Denied/, "no grant request");
  await prepareSummon(card2, syn2.opId, { grant: true });
  await idle();
  assert.equal(monarch.base.ownership[player2.id], undefined, "a world actor the Director named is never granted");
  await set("cardActionRole", 4);
  console.log("ok H14 auth: non-owner Denied; Apply all skips; no places -> placeOnCanvas; owner allowed at role 4; api row refused to Test (also role 1 + manual; no grant on a named world actor)");
}

/* ======================================================================== */
/*  H15: P1 fallback (world actor missing on Test's client)                  */
/* ======================================================================== */
{
  await fresh();
  const msg = useCard(soe, { author: player2 });
  await idle();
  const op = sumOp(msg);
  const waId = op.choices[0].worldActorId;
  hiddenActors.set("p2", new Set([waId]));
  await pick(player2, msg, op, [{ x: 10, y: 5 }]);
  const prep = relayed("summonPrepare")[0];
  assert.ok(prep && prep.data.grant === true, "summonPrepare {grant: true} sent");
  const wa = game.actors.raw(waId);
  assert.equal(wa.ownership.p2, 3, "the GM gave Test OWNER on the world actor");
  const p = log.place[0];
  assert.equal(p.standIn, true, "stand-in preview from Borin's token");
  assert.deepEqual([p.previews[0].width, p.previews[0].height, p.previews[0].texture.src, p.previews[0].name], [2, 2, "source-token.webp", "Source of Earth"]);
  assert.equal(liveOp(msg, op.opId).status, "applied", "the GM creates the real summon");
  const t = summonTokensOn()[0];
  assert.equal(t.actorId, waId);
  assert.equal(t.width, 2);
  delete wa.ownership.p2;
  console.log("ok H15 P1 fallback: grant asked, OWNER given, stand-in preview (2x2, the summon's art), real summon created");
}

/* ======================================================================== */
/*  H16: prepare again after a failed import                                 */
/* ======================================================================== */
{
  await fresh();
  const fresh9 = ability(borin, "Summon Source of Earth");   // a new source item: nothing to reuse
  packOnline(false);
  const msg = useCard(fresh9, { author: player2 });
  await idle();
  const op = sumOp(msg);
  assert.deepEqual([op.status, op.reason], ["failed", "noWorldActor"]);
  // Pack still missing: stays failed.
  await as(player2, () => requestOp({ action: "summonPrepare", messageId: msg.id, opId: op.opId }));
  assert.deepEqual([liveOp(msg, op.opId).status, liveOp(msg, op.opId).reason], ["failed", "noWorldActor"]);
  packOnline(true);
  const u0 = msg.updates;
  await as(player2, () => requestOp({ action: "summonPrepare", messageId: msg.id, opId: op.opId }));
  const r = liveOp(msg, op.opId);
  assert.equal(r.status, "pending", "re-opened");
  assert.equal(r.reason ?? null, null, "reason cleared");
  assert.ok(r.choices[0].worldActorId, "choices filled");
  assert.equal(msg.updates, u0 + 1, "one signed write");
  assert.equal(api.integrity(msg.id), "ok");
  borin.items.delete(fresh9.id);
  console.log("ok H16 prepare: failed noWorldActor re-opened with one write; pack missing stays failed; integrity ok");
}

/* ======================================================================== */
/*  H17: double click, another row, two applies at once                      */
/* ======================================================================== */
{
  await fresh();
  const msg = useCard(soe, { author: player2 });
  await idle();
  const op = sumOp(msg);
  const first = as(player2, () => runSummonPick({ message: msg, res: getResolution(msg), op, request: requestOp }));
  await settle(30);
  await as(player2, () => runSummonPick({ message: msg, res: getResolution(msg), op, request: requestOp }));
  assert.equal(log.place.length, 1, "the second click is ignored (no second placeTokens)");
  clicks(player2, { x: 10, y: 5 });
  await first;
  await idle();
  assert.equal(relayed("apply").length, 1, "one apply");
  assert.equal(liveOp(msg, op.opId).status, "applied");
  // A click on another row's Summon cancels the open picker: the first sends nothing.
  const m1 = useCard(soe, { author: player2 });
  const m2 = useCard(soeBen, { author: player, token: tBen });
  await idle();
  clear();
  const p1 = as(player2, () => runSummonPick({ message: m1, res: getResolution(m1), op: sumOp(m1), request: requestOp }));
  await settle(30);
  const p2 = as(player2, () => runSummonPick({ message: m2, res: getResolution(m2), op: sumOp(m2), request: requestOp }));
  await p1;
  assert.equal(relayed("apply").length, 0, "the cancelled picker sent nothing");
  clicks(player2, "esc");
  await p2;
  // Two applies at once: the second is a no-op.
  const m3 = useCard(soe, { author: player2 });
  await idle();
  const o3 = sumOp(m3);
  const places = { [o3.opId]: { actor: cuuid("source"), squares: [sq(10, 9)] } };
  const n0 = summonTokensOn().length;
  await Promise.all([relayApply(player2, m3, [o3.opId], { places }), relayApply(player2, m3, [o3.opId], { places: { [o3.opId]: { actor: cuuid("source"), squares: [sq(1, 9)] } } })]);
  await idle();
  assert.equal(summonTokensOn().length, n0 + 1, "one token set");
  console.log("ok H17 double click ignored; another row's Summon cancels the open picker; two applies -> one summon");
}

/* ======================================================================== */
/*  H17b: several stat blocks (choose one; CH2)                              */
/* ======================================================================== */
{
  await fresh();
  const msg = useCard(eitherSoe.item, { author: player2 });
  await idle();
  const op = sumOp(msg);
  assert.equal(op.choices.length, 2);
  assert.ok(op.choices.every(c => c.worldActorId), "both prepared");
  assert.equal(op.choices[0].label, "the big one", "the label kept through the preparation");
  assert.equal(textOf(msg, player2).label, 'DSAUTO.Card.SummonChoice {"count":1,"names":"Source of Earth / Goblin Runner"}');
  // A GM apply without a pick (no places): which one?
  await api.applyOps(msg.id, [op.opId]);
  await idle();
  assert.deepEqual([liveOp(msg, op.opId).status, liveOp(msg, op.opId).reason], ["failed", "chooseActor"]);
  // Test's Summon button: the choice dialog (second option), then the picker for a 1x1 runner.
  answerFn = rec => (rec.kind === "choose" ? { action: "summon", option: 1 } : undefined);
  await pick(player2, msg, op, [{ x: 10, y: 5 }]);
  assert.equal(dialogs.filter(d => d.kind === "choose").length, 1, "one choice dialog");
  assert.equal(log.place[0].previews[0].width, 1);
  const r = liveOp(msg, op.opId);
  assert.equal(r.status, "applied");
  assert.equal(r.actorUuid, cuuid("runner"));
  assert.deepEqual(r.names, ["Goblin Runner"]);
  assert.equal(textOf(msg, player2).label, 'DSAUTO.Card.Summon {"count":1,"name":"Goblin Runner"}');
  // Closing the dialog sends nothing.
  const m2 = useCard(eitherSoe.item, { author: player2 });
  await idle();
  answerFn = () => undefined;
  const p = pick(player2, m2, sumOp(m2));
  await settle(50);
  dialogs.filter(d => d.kind === "choose" && !d.closed).forEach(d => d.dialog.close());
  await p;
  assert.equal(liveOp(m2, sumOp(m2).opId).status, "pending", "closed: nothing sent");
  console.log("ok H17b choose one: SummonChoice label, GM without a pick -> chooseActor, Test chooses the runner, closing sends nothing");
}

/* ======================================================================== */
/*  H18: combat insertion (unlinked combat, the summoner's turn running)     */
/* ======================================================================== */
/** Apply a row as `user` with explicit squares (the picker's result). */
async function place9(user, msg, squares, op = null, actor = null) {
  if (!op && !sumOp(msg)) await idle();
  op ??= sumOp(msg);
  actor ??= op.choices[0].uuid;
  await relayApply(user, msg, [op.opId], { places: { [op.opId]: { actor, squares } } });
  await idle();
  return clone(liveOp(msg, op.opId));
}
{
  await fresh();
  const combat = newCombat([tBorin, tBen, tMonarch]);
  assert.equal(combat.scene, null, "unlinked, as core creates it");
  const bc = cmbOf(combat, tBorin);
  bc.hidden = true;
  await activate(combat, tBorin);
  const msg = useCard(soe, { author: player2 });
  await idle();
  const op = await place9(player2, msg, [sq(10, 5)]);
  assert.equal(op.status, "applied");
  assert.equal(op.combatId, combat.id);
  assert.equal(op.combatantIds.length, 1);
  const cb = combat.combatants.get(op.combatantIds[0]);
  assert.equal(cb.initiative, 0, "held at 0 (turn after, chain on)");
  assert.equal(cb.hidden, true, "hidden like Borin's combatant");
  assert.deepEqual(cb.flags["stef-ds-automation"], { summonOf: bc.id, summonerTokenId: tBorin.id, summonId: op.summonId });
  assert.equal(combat.combatant, bc, "Borin still current");
  const e = indexEntries(combat)[0];
  assert.equal(e.summonerTokenId, tBorin.id);
  assert.equal(e.held, true);
  const armOf = a => ({ round: a.round, activation: a.activation, open: a.open, combatantId: a.combatantId });
  assert.deepEqual(armOf(e.armStart), { round: 1, activation: 1, open: true, combatantId: bc.id });
  assert.deepEqual(armOf(e.armEnd), { round: 1, activation: 1, open: true, combatantId: bc.id });
  assert.ok(e.armStart.epoch && e.armStart.epoch === e.armEnd.epoch, "arms carry the lifecycle epoch");
  assert.equal(summonTokensOn()[0].flags["stef-ds-automation"].summon.combatId, combat.id);
  // turn "own": initiative 1; with actsThisRound false: 0.
  const m2 = useCard(ownSoe.item, { author: player2 });
  await idle();
  const o2 = await place9(player2, m2, [sq(10, 9)]);
  assert.equal(combat.combatants.get(o2.combatantIds[0]).initiative, 1, "own: acts this round");
  assert.equal(indexEntries(combat).find(x => x.summonId === o2.summonId).held, false);
  const m3 = useCard(lateSoe.item, { author: player2 });
  await idle();
  const o3 = await place9(player2, m3, [sq(1, 5)]);
  assert.equal(combat.combatants.get(o3.combatantIds[0]).initiative, 0, "actsThisRound false: 0");
  assert.equal(indexEntries(combat).find(x => x.summonId === o3.summonId).chainedRound, 1);
  assert.equal(combat.combatant, bc);
  console.log("ok H18 combat: held at 0, hidden like Borin, flags, Borin still current, index entry arms; own -> 1, not this round -> 0");
}

/* ======================================================================== */
/*  H19: no running combat                                                   */
/* ======================================================================== */
{
  await fresh();
  const setup = newCombat([tBorin, tBen], { started: false });
  const msg = useCard(soe, { author: player2 });
  await idle();
  const op = await place9(player2, msg, [sq(10, 5)]);
  assert.equal(op.combatId, null);
  assert.equal(setup.combatants.size, 2, "no combatant added to a combat that has not started");
  assert.ok(textOf(msg, gm).detail.includes("DSAUTO.Card.SummonNoCombat"), "not in a running combat");
  game.combats.clear();
  setCombat(null);
  const m2 = useCard(soe, { author: player2 });
  await idle();
  const o2 = await place9(player2, m2, [sq(10, 9)]);
  assert.equal(o2.combatId, null);
  assert.ok(!textOf(m2, gm).detail.includes("SummonNoCombat"), "out of combat: nothing said about combat");
  const combat = newCombat([tBorin, tBen]);
  const m3 = useCard(noneSoe.item, { author: player2 });
  await idle();
  const o3 = await place9(player2, m3, [sq(1, 5)]);
  // Review fix: a turn "none" summon made in a running combat is indexed (no combatant), so its summoner-turn ends fire.
  assert.equal(o3.combatId, combat.id, "turn none: the combat recorded");
  assert.equal(combat.combatants.size, 2, "turn none: no combatant even in combat");
  assert.ok(indexEntries(combat).some(e => e.summonId === o3.summonId), "turn none: indexed");
  assert.ok(!textOf(m3, gm).detail.includes("SummonNoCombat"), "turn none: nothing said about combat");
  const tn = await api.summon({ summoner: tBorin, actor: cuuid("runner"), places: "auto", turn: "none", lasts: ["summonerTurnEnd"], squad: "none" });
  await idle();
  const tnOp = opsOf(messages.get(tn.messageId))[0];
  assert.equal(tnOp.status, "applied");
  assert.equal(combat.combatants.size, 2, "no combatant");
  await activate(combat, tBorin);
  assert.equal(summonTokens(tnOp.summonId).length, 1, "still there during Borin's turn");
  await endTurn(combat);
  assert.equal(summonTokens(tnOp.summonId).length, 0, "turn none + summonerTurnEnd: dismissed at Borin's turn end");
  console.log("ok H19 no combat: unstarted combat untouched (detail says so); no combat: no text; turn none: no combatant, indexed, summonerTurnEnd fires");
}

/* ======================================================================== */
/*  H20: a new squad (Director's Get in Here!)                               */
/* ======================================================================== */
{
  await fresh();
  const combat = newCombat([tBorin, tMonarch]);
  const msg = useCard(itemOf(tMonarch), { token: tMonarch });
  await idle();
  clear();
  await pick(gm, msg, sumOp(msg), [{ x: 14, y: 11 }, { x: 15, y: 11 }]);
  const op = liveOp(msg, sumOp(msg).opId);
  assert.equal(op.status, "applied");
  assert.equal(op.placed, 2);
  const g = combat.groups.get(op.groupId);
  assert.ok(op.groupCreated);
  assert.equal(g.type, "squad");
  assert.equal(g.name, "Group 1", "lowest free Group N (labels on)");
  assert.equal(g.initiative, 1);
  assert.deepEqual(g.ownership, { default: 0 }, "no player ownership (hostile)");
  assert.equal(log.combatantCreates[0].poolWritesBefore, 0, "members created before the pool write");
  assert.equal(log.poolWrites.length, 1);
  assert.deepEqual([log.poolWrites[0].value, log.poolWrites[0].members], [8, 2], "pool 8 over two members");
  assert.equal(log.clamps.length, 0, "Death Tracker's clamp does not cut it");
  assert.equal(g.system.staminaValue, 8);
  assert.equal(log.labels.length, 1, "Combat Tools' labeller called once");
  assert.ok(summonTokensOn().every(t => t.disposition === -1), "hostile like the monarch");
  // Labels off: the stat block's name.
  await fresh();
  await set("summonSquadLabels", false);
  const c2 = newCombat([tBorin, tMonarch]);
  const m2 = useCard(itemOf(tMonarch), { token: tMonarch });
  await idle();
  const o2 = await place9(gm, m2, [sq(14, 11), sq(15, 11)]);
  assert.equal(c2.groups.get(o2.groupId).name, "Goblin Runner");
  assert.equal(log.labels.length, 0);
  // The GM views another scene, or another combat is game.combat: no labeller call.
  await fresh();
  const c3 = newCombat([tBorin, tMonarch]);
  view(gm, OTHER);
  const m3 = useCard(itemOf(tMonarch), { token: tMonarch });
  await idle();
  await place9(gm, m3, [sq(14, 11), sq(15, 11)]);
  assert.equal(log.labels.length, 0, "GM elsewhere: no labels");
  view(gm, START);
  const viewed = newCombat([tBen]);
  assert.equal(game.combat, viewed);
  const m4 = useCard(itemOf(tMonarch), { token: tMonarch });
  await idle();
  const o4 = await place9(gm, m4, [sq(16, 11), sq(17, 11)]);
  assert.equal(o4.combatId, c3.id);
  assert.equal(log.labels.length, 0, "another combat viewed: no labels");
  console.log("ok H20 new squad: Group 1, initiative 1, members before the pool (8), labeller once; labels off -> name; elsewhere -> no labels");
}

/* ======================================================================== */
/*  H21 / H21b: joining a squad, and when not                                */
/* ======================================================================== */
{
  await fresh();
  const combat = newCombat([tBorin, tMonarch]);
  const use = async (squares, item = itemOf(tMonarch), opts = { token: tMonarch }) => {
    const m = useCard(item, opts);
    await idle();
    return place9(gm, m, squares);
  };
  const a = await use([sq(14, 11), sq(15, 11)]);
  const b = await use([sq(16, 11), sq(17, 11)]);
  assert.equal(b.groupId, a.groupId, "joined");
  assert.equal(b.groupCreated, false);
  assert.equal(b.poolAdded, 8);
  assert.equal(combat.groups.get(a.groupId).system.staminaValue, 16, "pool 8 -> 16");
  assert.equal(combat.groups.get(a.groupId).members.size, 4);
  const c = await use([sq(6, 8), sq(7, 8)], runnersNew.item, { author: player2 });
  assert.notEqual(c.groupId, a.groupId);
  assert.equal(combat.groups.get(c.groupId).name, "Group 2", "squad new");
  // H21b: the squad acted (group 0): a new squad.
  await fresh();
  const c2 = newCombat([tBorin, tMonarch]);
  const s1 = await use([sq(14, 11), sq(15, 11)]);
  await c2.groups.get(s1.groupId).update({ initiative: 0 });
  const s2 = await use([sq(16, 11), sq(17, 11)]);
  assert.notEqual(s2.groupId, s1.groupId, "acted: not joined");
  const g2 = c2.groups.get(s2.groupId);
  assert.deepEqual([g2.name, g2.system.staminaValue, g2.initiative], ["Group 2", 8, 1]);
  // A member of the squad is acting now: a new squad too.
  const member = c2.combatants.get(s2.combatantIds[0]);
  await c2.update({ turn: c2.turns.indexOf(member) });
  await idle();
  const s3 = await use([sq(14, 13), sq(15, 13)]);
  assert.notEqual(s3.groupId, s2.groupId, "acting now: not joined");
  await c2.update({ turn: null });
  await idle();
  // A failed insertion rolls back: our group deleted, no combatant, tokens deleted, row failed error.
  const groups = c2.groups.size;
  const cbs = c2.combatants.size;
  sw.failCombatantCreate = 1;
  const m = useCard(itemOf(tMonarch), { token: tMonarch });
  await idle();
  const tokensBefore = summonTokensOn().length;
  const f = await place9(gm, m, [sq(14, 15), sq(15, 15)]);
  assert.deepEqual([f.status, f.reason], ["failed", "error"]);
  assert.equal(c2.groups.size, groups, "our group deleted");
  assert.equal(c2.combatants.size, cbs, "no combatant left");
  assert.equal(summonTokensOn().length, tokensBefore, "tokens deleted");
  console.log("ok H21 join: pool 8 -> 16, squad new -> Group 2; H21b acted / acting -> new squad; a failed insertion rolls back");
}

/* ======================================================================== */
/*  H22: a player's squad (api.summon of minions for Borin)                  */
/* ======================================================================== */
{
  await fresh();
  const combat = newCombat([tBorin, tMonarch]);
  const out = await api.summon({ summoner: tBorin, actor: cuuid("runner"), quantity: 2, places: "auto" });
  await idle();
  const op = opsOf(messages.get(out.messageId))[0];
  assert.equal(op.status, "applied");
  const g = combat.groups.get(op.groupId);
  assert.deepEqual(g.ownership, { default: 0, p2: 3 }, "Test owns the group");
  assert.ok(summonTokensOn().every(t => t.disposition === 1), "friendly");
  assert.ok(summonTokensOn().every(t => t.delta.ownership?.p2 === 3));
  console.log("ok H22 player squad: group owned by Test, friendly runners");
}

/* ======================================================================== */
/*  H23: insertion is idempotent                                             */
/* ======================================================================== */
{
  await fresh();
  const combat = newCombat([tBorin, tBen]);
  const msg = useCard(ownSoe.item, { author: player2 });
  await idle();
  const op = await place9(player2, msg, [sq(10, 5)]);
  const { insertSummon } = await imp("summons/combat.mjs");
  const tokens = summonTokens(op.summonId);
  const wa = game.actors.raw(op.worldActorId);
  const again = await insertSummon({ combat, summonerCombatant: cmbOf(combat, tBorin), tokens, actor: wa, op: { ...sumOp(msg), ...op }, summonId: op.summonId });
  assert.deepEqual(again.combatantIds, [], "a token that already has a combatant is skipped");
  assert.equal(combat.combatants.filter(c => c.tokenId === tokens[0].id).length, 1, "no duplicate");
  console.log("ok H23 idempotent insertion");
}

/* ======================================================================== */
/*  H24: the alternative initiative mode                                     */
/* ======================================================================== */
{
  await fresh();
  game.combats.isDefaultInitiativeMode = false;
  const combat = newCombat([tBorin, tBen, tMonarch]);
  cmbOf(combat, tBorin).initiative = 10;
  cmbOf(combat, tBen).initiative = 5;
  cmbOf(combat, tMonarch).initiative = 3;
  combat.setupTurns();
  const msg = useCard(pairSoe.item, { author: player2 });
  await idle();
  const op = await place9(player2, msg, [sq(10, 2), sq(10, 7)]);
  const inits = op.combatantIds.map(id => combat.combatants.get(id).initiative);
  assert.ok(Math.abs(inits[0] - 9.99) < 1e-9 && Math.abs(inits[1] - 9.98) < 1e-9, `s - eps, s - 2 eps: ${inits}`);
  assert.ok(inits.every(v => v > 5 && v < 10), "between Borin and the next combatant");
  // No chain on Borin's turn end (an `after` summon in this mode).
  const m2 = useCard(soe, { author: player2 });
  await idle();
  await place9(player2, m2, [sq(1, 5)]);
  await combat.update({ turn: combat.turns.indexOf(cmbOf(combat, tBorin)) });
  await idle();
  clear();
  await combat.update({ turn: combat.turns.indexOf(cmbOf(combat, tBorin)) + 1 });
  await idle();
  assert.equal(combat.flags["stef-ds-automation"]?.summonTurn, undefined, "no chain");
  assert.ok(!log.combatUpdates.some(u => u.who === "combat" && "flags.stef-ds-automation.summonTurn" in u.changes));
  // Review fix: dismissing the pair on its first token's turn moves past BOTH tokens (never onto the sibling that is
  // deleted next: core's static _preDeleteOperation would not find the survivor and the next creature is skipped).
  const [r1, r2] = op.combatantIds.map(id => combat.combatants.get(id));
  const expected = combat.turns[combat.turns.indexOf(r2) + 1];
  await combat.update({ turn: combat.turns.indexOf(r1) });
  await idle();
  clear();
  await dismissSummon(op.summonId, REMOVAL.DISMISS);
  await idle();
  assert.equal(log.turnShift, undefined, "the current combatant was not deleted");
  assert.equal(combat.combatant, expected, "the next surviving creature is current");
  assert.ok(!log.combatUpdates.some(u => u.who === "combat" && u.changes.turn === combat.turns.indexOf(r2)), "never the sibling's turn");
  // The summon last in the order: the next round starts, on a survivor.
  const m3 = useCard(soe, { author: player2 });
  await idle();
  const o3 = await place9(player2, m3, [sq(1, 9)]);
  const last = combat.combatants.get(o3.combatantIds[0]);
  last.initiative = 1;
  combat.setupTurns();
  await combat.update({ turn: combat.turns.indexOf(last) });
  await idle();
  assert.equal(combat.turns.at(-1), last, "last in the order");
  const round = combat.round;
  await dismissSummon(o3.summonId, REMOVAL.DISMISS);
  await idle();
  assert.equal(combat.round, round + 1, "the next round");
  assert.ok(combat.combatant && combat.combatants.has(combat.combatant.id), "on a live combatant");
  game.combats.isDefaultInitiativeMode = true;
  console.log("ok H24 alternative mode: s - eps, s - 2 eps, above the next combatant; no chain; dismissal on its own turn moves past every token of the summon");
}

/* ======================================================================== */
/*  H25 / H25b: the chain, Hesitation is Weakness after it                   */
/* ======================================================================== */
const updatesOf = id => log.combatUpdates.map((u, i) => ({ ...u, i })).filter(u => u.id === id);
const turnWrites = () => log.combatUpdates.map((u, i) => ({ ...u, i })).filter(u => u.who === "combat" && "turn" in u.changes && u.changes.turn !== null);
const hiwAsked = () => sentTo("pl", "trigger").filter(s => JSON.stringify(s.data).includes("Hesitation is Weakness"));
/** Borin summons Source of Earth (turn after) during his own turn in a fresh combat. */
async function chainSetup({ item = soe, squares = [sq(10, 5)], extra = [] } = {}) {
  const combat = newCombat([tBorin, tBen, tDorian, tMonarch, ...extra]);
  await activate(combat, tBorin);
  const msg = useCard(item, { author: player2 });
  await idle();
  const op = await place9(player2, msg, squares);
  return { combat, msg, op, cb: combat.combatants.get(op.combatantIds[0]) };
}
{
  await fresh();
  answerFn = rec => (rec.kind === "trigger" ? "decline" : undefined);
  const { combat, op, cb } = await chainSetup();
  assert.equal(cb.initiative, 0, "held");
  clear();
  await endTurn(combat);
  const raise = updatesOf(cb.id).find(u => u.changes.initiative === 1);
  const drop = updatesOf(cb.id).find(u => u.changes.initiative === 0);
  const tw = turnWrites()[0];
  assert.ok(raise && tw && drop && raise.i < tw.i && tw.i < drop.i, "raise, turn write, drop");
  assert.equal(raise.options["stef-ds-automation"]?.chain, true);
  assert.equal(tw.options.direction, 1);
  assert.deepEqual(tw.changes["flags.stef-ds-automation.summonTurn"], { combatantId: cb.id, summonId: op.summonId, summonerTokenId: tBorin.id, round: 1 });
  assert.equal(log.starts.filter(s => s.id === cb.id).length, 1, "only the drop starts its turn (the raise fires nothing)");
  assert.equal(combat.combatant, cb, "Source of Earth current");
  assert.equal(cb.initiative, 0);
  assert.equal(indexEntries(combat)[0].chainedRound, 1);
  assert.equal(hiwAsked().length, 0, "no HIW offer at Borin's turn end (the chain pre-empted it)");
  // H25b: the chained turn ends with nothing left -> HIW for Borin.
  await endTurn(combat);
  await settle(80);
  const asked = hiwAsked();
  assert.equal(asked.length, 1, "HIW offered after the chained turn");
  assert.ok(JSON.stringify(asked[0].data).includes("Borin"), "subject Borin");
  assert.equal(turnWrites().length, 1, "no further chain write");
  // summonTurnChain off: the normal HIW at Borin's own turn end.
  await fresh();
  answerFn = rec => (rec.kind === "trigger" ? "decline" : undefined);
  await set("summonTurnChain", false);
  const s2 = await chainSetup();
  assert.equal(s2.cb.initiative, 1, "chain off: no hold (acts like own)");
  clear();
  await endTurn(s2.combat);
  await settle(80);
  assert.equal(turnWrites().length, 0, "no chain");
  assert.equal(hiwAsked().length, 1, "HIW at Borin's turn end");
  console.log("ok H25 chain: raise, turn write (direction 1, marker), drop, chainedRound; no HIW flash; H25b HIW for Borin after; chain off -> HIW");
}

/* ======================================================================== */
/*  H25c: the hold                                                           */
/* ======================================================================== */
{
  await fresh();
  const { combat, cb } = await chainSetup();
  await endTurn(combat);
  await endTurn(combat);
  clear();
  await combat.nextRound();
  await idle();
  assert.equal(cb.initiative, 0, "the round reset raised it, the hold put it back");
  const hold = updatesOf(cb.id).find(u => u.changes.initiative === 0);
  assert.ok(hold?.options?._dsctSquadBatch && hold.options["stef-ds-automation"]?.hold, "hold write options");
  // A player's activate-raise before Borin's turn end: back to 0.
  await as(player2, () => cb.update({ initiative: 1 }));
  await idle();
  assert.equal(cb.initiative, 0, "raised early -> held again");
  // Squad: members before the group, no Combat Tools start.
  await fresh();
  await game.settings.set("draw-steel-combat-tools", "squadSimultaneousTurns", true);
  const sq9 = await chainSetup({ item: familiar.item, squares: [sq(10, 5), sq(11, 5)] });
  const op9 = indexEntries(sq9.combat)[0];
  const g = sq9.combat.groups.get(op9.groupId);
  assert.equal(g.initiative, 0, "a held squad sits at 0");
  await endTurn(sq9.combat);
  await endTurn(sq9.combat);
  clear();
  await sq9.combat.nextRound();
  await idle(60);
  const members = [...g.members];
  assert.ok(members.every(m => m.initiative === 0) && g.initiative === 0, "members and group back at 0");
  const lastMemberHold = Math.max(...members.map(m => updatesOf(m.id).filter(u => u.changes.initiative === 0).at(-1)?.i ?? -1));
  const groupHold = log.combatUpdates.findLastIndex(u => u.id === g.id && u.changes.initiative === 0);
  assert.ok(lastMemberHold >= 0 && lastMemberHold < groupHold, "members lowered before the group");
  assert.equal(log.dsctStarts.length, 0, "no Combat Tools start");
  // After Borin's turn ended while another turn was current (no chain): the Director's raise stays.
  await fresh();
  const s3 = await chainSetup();
  await s3.combat.update({ turn: s3.combat.turns.indexOf(cmbOf(s3.combat, tBen)) });   // Borin's turn ends straight into Ben's
  await idle();
  assert.equal(s3.combat.combatant, cmbOf(s3.combat, tBen), "the chain could not run");
  await s3.cb.update({ initiative: 1 });
  await idle();
  assert.equal(s3.cb.initiative, 1, "hold lifted: the Director's raise stays");
  console.log("ok H25c hold: round reset and early raises put back to 0 (members before the group, no DSCT start); lifted after the summoner's turn");
}

/* ======================================================================== */
/*  H26: two `after` summons, chained in order                               */
/* ======================================================================== */
{
  await fresh();
  answerFn = rec => (rec.kind === "trigger" ? "decline" : undefined);
  const combat = newCombat([tBorin, tBen, tMonarch]);
  await activate(combat, tBorin);
  const msg = useCard(twoRows.item, { author: player2 });
  await idle();
  const [ra, rb] = sumOps(msg);
  const a = await place9(player2, msg, [sq(10, 5)], ra);
  const b = await place9(player2, msg, [sq(10, 9)], rb);
  const ca = combat.combatants.get(a.combatantIds[0]);
  const cbb = combat.combatants.get(b.combatantIds[0]);
  await endTurn(combat);
  assert.equal(combat.combatant, ca, "the first summon after Borin");
  await endTurn(combat);
  assert.equal(combat.combatant, cbb, "the second when the first's turn ends");
  clear();
  await endTurn(combat);
  assert.equal(combat.combatant, null);
  assert.equal(turnWrites().length, 0, "nothing left: no write");
  console.log("ok H26 two after summons chained in creation order; nothing left -> no write");
}

/* ======================================================================== */
/*  H27: chain guards                                                        */
/* ======================================================================== */
{
  // A turn already started.
  await fresh();
  let s = await chainSetup();
  await s.combat.update({ turn: s.combat.turns.indexOf(cmbOf(s.combat, tBen)) });
  await idle();
  assert.notEqual(s.combat.combatant, s.cb, "a turn already started: no chain");
  // A defeated summon is skipped.
  await fresh();
  s = await chainSetup();
  s.cb.defeated = true;
  clear();
  await endTurn(s.combat);
  assert.equal(turnWrites().length, 0, "defeated: skipped");
  // Already chained this round: skipped (Borin acts again in the same round).
  await fresh();
  s = await chainSetup();
  await endTurn(s.combat);
  await endTurn(s.combat);
  await s.combat.update({ turn: s.combat.turns.indexOf(cmbOf(s.combat, tBorin)) });
  await idle();
  clear();
  await endTurn(s.combat);
  assert.equal(turnWrites().length, 0, "already chained this round");
  // A retainer whose mentor is Borin: Combat Tools' pair turns own it.
  await fresh();
  s = await chainSetup();
  summonTokens(s.op.summonId)[0].actor.system.retainer = { mentor: borin.uuid };
  clear();
  await endTurn(s.combat);
  assert.equal(turnWrites().length, 0, "retainer of Borin: skipped");
  // Borin revived by Death Tracker (a new combatant id): his summons still chain (token-id key).
  await fresh();
  s = await chainSetup({ item: afterSoe.item });
  await endTurn(s.combat);
  await endTurn(s.combat);
  await s.combat.nextRound();
  await idle();
  const old = cmbOf(s.combat, tBorin);
  await s.combat.deleteEmbeddedDocuments("Combatant", [old.id]);
  const [revived] = await s.combat.createEmbeddedDocuments("Combatant", [{ tokenId: tBorin.id, sceneId: START.id, actorId: borin.id, initiative: 1 }]);
  assert.notEqual(revived.id, old.id);
  await activate(s.combat, tBorin);
  await endTurn(s.combat);
  assert.equal(s.combat.combatant, s.cb, "chained after the revived Borin");
  console.log("ok H27 chain guards: turn taken, defeated, chained this round, retainer skipped; DT revival still chains");
}

/* ======================================================================== */
/*  H28 / H29: a squad's chained turn                                        */
/* ======================================================================== */
{
  // H28: Combat Tools' squad turns off.
  await fresh();
  const s = await chainSetup({ item: familiar.item, squares: [sq(10, 5), sq(11, 5)] });
  const e = indexEntries(s.combat)[0];
  const g = s.combat.groups.get(e.groupId);
  const [m1, m2] = [...g.members];
  clear();
  await endTurn(s.combat);
  const seq = log.combatUpdates.filter(u => [m1.id, m2.id, g.id].includes(u.id) || (u.who === "combat" && "turn" in u.changes && u.changes.turn !== null))
    .map(u => (u.who === "combat" ? "turn" : `${u.id === g.id ? "group" : (u.id === m1.id ? "m1" : "m2")}:${u.changes.initiative}`));
  assert.deepEqual(seq, ["m1:1", "group:1", "turn", "m1:0", "group:0"], `DSCT off sequence: ${seq}`);
  assert.equal(s.combat.combatant, m1);
  // H29: Combat Tools' squad turns on: every live member raised, the group, the turn, the member first, then the group.
  await fresh();
  await game.settings.set("draw-steel-combat-tools", "squadSimultaneousTurns", true);
  const t = await chainSetup({ item: familiar.item, squares: [sq(10, 5), sq(11, 5)] });
  const g2 = t.combat.groups.get(indexEntries(t.combat)[0].groupId);
  const [n1, n2] = [...g2.members];
  clear();
  await endTurn(t.combat);
  await idle(60);
  const raises = log.combatUpdates.filter(u => [n1.id, n2.id].includes(u.id) && u.changes.initiative === 1);
  assert.equal(raises.length, 2, "all live members raised");
  assert.ok(raises.every(u => u.options._dsctSquadBatch), "raised with _dsctSquadBatch");
  const curDrop = log.combatUpdates.find(u => u.id === n1.id && u.changes.initiative === 0);
  assert.ok(curDrop?.options?._dsctSquadBatch, "the current member's drop is batched");
  assert.equal(g2.initiative, 0, "group 0 (not -1)");
  assert.equal(n1.initiative, 0, "current member 0");
  assert.equal(t.combat.combatant, n1);
  assert.deepEqual(log.dsctStarts.map(x => x.id), [n2.id], "Combat Tools starts the other member");
  assert.equal(log.starts.filter(x => x.id === n1.id).length, 1, "one start for the current member");
  assert.equal(log.starts.filter(x => x.id === n2.id).length, 1, "one start for the other");
  console.log("ok H28 squad chain (DSCT off): m1 up, group up, turn, m1 down, group down; H29 (DSCT on): group 0, one start per member");
}

/* H29b (review fix): ungrouped members of one `after` summon get one chained turn each; a squad joined by a second
   `after` summon still has ONE turn per round; the hold finds a shared group after its creator is dismissed. */
{
  await fresh();
  answerFn = rec => (rec.kind === "trigger" ? "decline" : undefined);
  const s = await chainSetup({ item: pairAfter.item, squares: [sq(10, 5), sq(11, 5)] });
  const [a, b] = s.op.combatantIds.map(id => s.combat.combatants.get(id));
  assert.ok(a.initiative === 0 && b.initiative === 0, "both held");
  await endTurn(s.combat);
  assert.equal(s.combat.combatant, a, "the first creature after Borin");
  await endTurn(s.combat);
  assert.equal(s.combat.combatant, b, "the second creature after the first (not stranded at 0)");
  clear();
  await endTurn(s.combat);
  await settle(80);
  assert.equal(s.combat.combatant, null);
  assert.equal(turnWrites().length, 0, "nothing left");
  assert.equal(hiwAsked().length, 1, "HIW for Borin after the last one");
  const e = indexEntries(s.combat)[0];
  assert.deepEqual([e.chainedRound, [...e.chainedIds].sort()], [1, [a.id, b.id].sort()]);
  // Next round: the hold lowers both again and the chain gives both their turn again.
  await s.combat.nextRound();
  await idle();
  assert.ok(a.initiative === 0 && b.initiative === 0, "held again in round 2");
  await activate(s.combat, tBorin);
  await endTurn(s.combat);
  assert.equal(s.combat.combatant, a, "round 2: first");
  await endTurn(s.combat);
  assert.equal(s.combat.combatant, b, "round 2: second");

  // A held squad joined by a second cast: one squad turn per round.
  await fresh();
  answerFn = rec => (rec.kind === "trigger" ? "decline" : undefined);
  const t = await chainSetup({ item: familiar.item, squares: [sq(10, 5), sq(11, 5)] });
  const ea = indexEntries(t.combat)[0];
  const g = t.combat.groups.get(ea.groupId);
  await endTurn(t.combat);
  await endTurn(t.combat);
  await t.combat.nextRound();
  await idle();
  assert.equal(g.initiative, 0, "squad held in round 2");
  await activate(t.combat, tBorin);
  const m2 = useCard(familiar.item, { author: player2 });
  await idle();
  const ob = await place9(player2, m2, [sq(12, 5), sq(13, 5)]);
  assert.equal(ob.groupId, g.id, "the second cast joined the held squad");
  clear();
  await endTurn(t.combat);
  assert.ok(g.members.has(t.combat.combatant?.id) || [...g.members].includes(t.combat.combatant), "the squad's chained turn");
  await endTurn(t.combat);
  await settle(80);
  assert.equal(turnWrites().length, 1, "one squad turn in round 2, not one per index entry");
  assert.equal(t.combat.combatant, null);
  assert.ok(indexEntries(t.combat).every(x => x.chainedRound === 2), "both entries marked chained");
  // Round 3: the creator's summon is dismissed; a raise of the shared group is still held.
  await t.combat.nextRound();
  await idle();
  await dismissSummon(ea.summonId, REMOVAL.DISMISS);
  await idle();
  assert.ok(t.combat.groups.has(g.id), "the group stays (the joined members remain)");
  await g.update({ initiative: 1 });
  await idle();
  assert.equal(g.initiative, 0, "the shared group is held without its creator's entry");
  console.log("ok H29b chain units: ungrouped members one turn each (also next round); a joined squad one turn per round; shared group held after its creator went");
}

/* H29c (review fix): Combat Tools' start keys. From round 2 the round-start hold drops the members while the group is
   still 0 (its raise needs a server round trip), so DSCT records `member:R:0`; the chained group drop computes the same
   key and DSCT skips the other members: we start them ourselves (fireStartTurn without region events). */
{
  await fresh();
  await game.settings.set("draw-steel-combat-tools", "squadSimultaneousTurns", true);
  sw.dsctKeys = true;
  answerFn = rec => (rec.kind === "trigger" ? "decline" : undefined);
  const t = await chainSetup({ item: familiar.item, squares: [sq(10, 5), sq(11, 5)] });
  const g = t.combat.groups.get(indexEntries(t.combat)[0].groupId);
  const [n1, n2] = [...g.members];
  await endTurn(t.combat);   // round 1: chained, DSCT starts n2 itself (no key taken yet)
  assert.deepEqual(log.dsctStarts.map(x => x.id), [n2.id], "round 1: Combat Tools starts the other member");
  await endTurn(t.combat);
  // Round 2 as live: round change (keys cleared), the combatant raise, the hold, then the group raise.
  await t.combat.update({ round: 2, turn: null });
  await t.combat.updateEmbeddedDocuments("Combatant", t.combat.combatants.contents.map(c => ({ _id: c.id, initiative: 1 })));
  await idle();
  assert.equal(n1.initiative, 0, "held");
  assert.equal(n2.initiative, 0, "held");
  await t.combat.updateEmbeddedDocuments("CombatantGroup", t.combat.groups.contents.map(x => ({ _id: x.id, initiative: 1 })));
  await idle();
  assert.equal(g.initiative, 0, "group held");
  const started = [];
  for (const m of [n1, n2]) m.actor.system._onStartTurn = c => { started.push(c.id); };
  const refreshes = [];
  const r0 = reg().refresh;
  reg().refresh = async function (event, ctx, ...rest) {
    if (event === "turnStart") refreshes.push(ctx?.combat?.combatant?.id ?? null);
    return r0.call(this, event, ctx, ...rest);
  };
  try {
    clear();
    await activate(t.combat, tBorin);
    await endTurn(t.combat);
    await idle(60);
  } finally {
    reg().refresh = r0;
    for (const m of [n1, n2]) delete m.actor.system._onStartTurn;
  }
  assert.equal(t.combat.combatant, n1, "chained");
  assert.deepEqual(log.dsctSkips, [n2.id], "Combat Tools skipped n2 (its key was taken by the hold)");
  assert.deepEqual(started, [n2.id], "we started n2 (its _onStartTurn)");
  assert.ok(refreshes.includes(n2.id), "turnStart refresh for n2");
  assert.equal(log.dsctStripped.length, 0, "nothing stripped");
  console.log("ok H29c DSCT start keys: a member skipped after the round-start hold is started by the chain");
}

/* ======================================================================== */
/*  H30: Persistent upkeep kept                                              */
/* ======================================================================== */
/** Round 2 of a chained Source of Earth: the source is held, Borin's turn starts (upkeep asked). */
async function upkeepSetup() {
  const s = await chainSetup();
  await endTurn(s.combat);
  await endTurn(s.combat);
  await s.combat.nextRound();
  await idle();
  return s;
}
{
  await fresh();
  answerFn = rec => (rec.kind === "upkeep" ? "keep" : (rec.kind === "trigger" ? "decline" : undefined));
  const s = await upkeepSetup();
  const n0 = messages.size;
  clear();
  await activate(s.combat, tBorin);
  await idle(80);
  const req = sentTo("p2", "summonUpkeep")[0]?.data;
  assert.ok(req, "asked Test");
  assert.deepEqual([req.cost, req.resourceName, req.current, req.summonName], [2, "Ferocity", 4, "Source of Earth"]);
  assert.equal(req.deadline, mclock.t + 30_000);
  const card = messages.contents.slice(n0).find(m => getResolution(m)?.ops && opsOf(m).some(o => o.kind === "resource"));
  assert.ok(card, "a Keep card");
  const row = opsOf(card).find(o => o.kind === "resource");
  assert.equal(row.status, "applied");
  assert.equal(row.amount, -2);
  assert.equal(borin.system.hero.primary.value, 2, "Ferocity 4 - 2");
  assert.ok(summonTokens(s.op.summonId).length, "the summon stays");
  assert.equal(indexEntries(s.combat)[0].upkeptRound, 2);
  await endTurn(s.combat);
  assert.equal(s.combat.combatant, s.cb, "chained again at Borin's turn end");
  console.log("ok H30 upkeep kept: prompt to Test (2 Ferocity, has 4), Keep card -2 applied, upkeptRound, chained again");
}

/* ======================================================================== */
/*  H31: Persistent upkeep not kept                                          */
/* ======================================================================== */
{
  const expiredWith = async (setup, label) => {
    await fresh();
    const s = await upkeepSetup();
    await setup?.(s);
    clear();
    await activate(s.combat, tBorin);
    await idle(80);
    return s;
  };
  const gone = (s, label) => {
    assert.equal(summonTokens(s.op.summonId).length, 0, `${label}: dismissed`);
    assert.ok(log.whispers.length >= 1, `${label}: GM whisper`);
  };
  // Let it go.
  let s = await expiredWith(() => { answerFn = rec => (rec.kind === "upkeep" ? "release" : undefined); });
  gone(s, "release");
  assert.ok(log.whispers.some(w => w.content.includes("DSAUTO.Summon.Removal.expired")), "its time ran out");
  // No answer: the GM gives up at deadline + 3 s.
  s = await expiredWith(() => { answerFn = () => undefined; });
  assert.equal(summonTokens(s.op.summonId).length, 1, "waiting");
  await advance(30_000 + 3_000);
  await idle();
  gone(s, "no answer");
  // Test offline.
  s = await expiredWith(() => { player2.active = false; });
  gone(s, "offline");
  assert.ok(log.whispers.some(w => w.content.includes("DSAUTO.Summon.UpkeepNoOwner")));
  assert.equal(sentTo("p2", "summonUpkeep").length, 0);
  // Ferocity 1 after the turn's gain: cannot pay.
  s = await expiredWith(() => { borin.system.hero.primary.value = 1; });
  gone(s, "Ferocity 1");
  assert.ok(log.whispers.some(w => w.content.includes("DSAUTO.Summon.UpkeepCannotPay")));
  // Spent below the cost while the prompt is open, then Keep: no card, dismissed.
  let release = null;
  s = await expiredWith(() => { answerFn = rec => (rec.kind === "upkeep" ? new Promise(r => { release = () => r("keep"); }) : undefined); });
  const n0 = messages.size;
  borin.system.hero.primary.value = 1;
  release();
  await idle(80);
  gone(s, "spent meanwhile");
  assert.ok(!messages.contents.slice(n0).some(m => opsOf(m).some(o => o.kind === "resource")), "no Keep card");
  assert.equal(borin.system.hero.primary.value, 1, "no charge");
  // canPay: a constant class gain decides (Elementalist "2"), else the pool.
  const ele = { system: { class: { system: { turnGain: "2" } }, hero: { primary: { value: 0 } } } };
  assert.equal(canPay(ele, 2), true, "gain 2, cost 2: offered whatever the pool");
  assert.equal(canPay(ele, 3), false, "cost 3: cannot pay");
  assert.equal(canPay(borin, 1), true);
  assert.equal(canPay(borin, 2), false, "Fury: the pool (1)");
  console.log("ok H31 upkeep: release, no answer (deadline + 3 s), offline, cannot pay, spent meanwhile -> dismissed expired; canPay");
}

/* ======================================================================== */
/*  H31b: upkeep still open at the summoner's turn end                       */
/* ======================================================================== */
{
  await fresh();
  const s = await upkeepSetup();
  await activate(s.combat, tBorin);
  await idle(80);
  assert.equal(openUpkeeps().length, 1, "prompt open");
  const dlg = upkeepDialogs()[0];
  clear();
  await endTurn(s.combat);
  await idle(80);
  assert.equal(summonTokens(s.op.summonId).length, 0, "dismissed in the turnEnd listener");
  assert.equal(turnWrites().length, 0, "no summonTurn write");
  assert.equal(log.starts.filter(x => x.id === s.cb.id).length, 0, "no turn start for the source");
  assert.equal(log.whispers.length, 1, "dismissed once (the continuation does not dismiss twice)");
  assert.ok(dlg.closed, "Test's dialog closed (summonUpkeepCancel)");
  assert.ok(sentTo("p2", "summonUpkeepCancel").length >= 1);
  // A dismissal while Keep is being paid: the payment re-checks on the chain and charges nothing.
  await fresh();
  answerFn = rec => (rec.kind === "upkeep" ? "keep" : undefined);
  const t = await upkeepSetup();
  let unblock;
  const blocker = withSummonChain(() => new Promise(r => { unblock = r; }));
  // Borin activates by hand (no idle(): it would queue on the blocked chain).
  const bc = cmbOf(t.combat, tBorin);
  await bc.update({ initiative: 0 });
  await t.combat.update({ turn: t.combat.turns.indexOf(bc) }, { direction: 1 });
  await settle(80);
  assert.equal(sentTo("p2", "summonUpkeep").length, 1, "asked; Keep answered");
  // The Keep payment waits on the chain; meanwhile the summon's tokens go (as a dismissal's step does).
  const ids = summonTokens(t.op.summonId).map(x => x.id);
  await START.deleteEmbeddedDocuments("Token", ids, { "stef-ds-automation": { internal: true } });
  const n0 = messages.size;
  unblock();
  await blocker;
  await idle(80);
  assert.ok(!messages.contents.slice(n0).some(m => opsOf(m).some(o => o.kind === "resource")), "no Keep card");
  assert.equal(borin.system.hero.primary.value, 4, "no charge");
  console.log("ok H31b turn end with the prompt open: dismissed before the chain, no phantom turn, once; a dismissal during Keep -> no charge");
}

/* H31c (review fix): the encounter ends while the upkeep prompt is open (policy "none": the summon stays). The prompt
   is cancelled at deleteCombat: no Keep card, no charge after combat, the owner's dialog closed, no dismissal. */
{
  await fresh();
  await set("summonEncounterEnd", "none");
  let release = null;
  answerFn = rec => (rec.kind === "upkeep" ? new Promise(r => { release = () => r("keep"); }) : (rec.kind === "trigger" ? "decline" : undefined));
  const s = await upkeepSetup();
  await activate(s.combat, tBorin);
  await idle(80);
  assert.equal(openUpkeeps().length, 1, "prompt open");
  const dlg = upkeepDialogs()[0];
  const n0 = messages.size;
  clear();
  await s.combat.delete();
  await idle(80);
  assert.equal(openUpkeeps().length, 0, "cancelled at deleteCombat");
  assert.ok(dlg.closed, "Test's dialog closed");
  release?.();
  await idle(80);
  assert.ok(!messages.contents.slice(n0).some(m => opsOf(m).some(o => o.kind === "resource")), "no Keep card");
  assert.equal(borin.system.hero.primary.value, 4, "no charge after combat");
  assert.ok(summonTokens(s.op.summonId).length, "policy none: the summon stays");
  assert.ok(!log.whispers.some(w => w.content.includes("DSAUTO.Summon.Removal.expired")), "not dismissed as expired");
  console.log("ok H31c encounter end with the prompt open: cancelled, no card, no charge, dialog closed, summon kept (policy none)");
}

/* ======================================================================== */
/*  H32: arming of the summoner's turn start                                 */
/* ======================================================================== */
const apiSummon = async (opts) => {
  const out = await api.summon({ summoner: tBorin, actor: cuuid("runner"), places: "auto", ...opts });
  await idle();
  const msg = messages.get(out.messageId);
  return { msg, op: opsOf(msg)[0] };
};
const alive = id => summonTokens(id).length > 0;
{
  await fresh();
  const combat = newCombat([tBorin, tBen]);
  await activate(combat, tBorin);
  const { op } = await apiSummon({ lasts: ["summonerTurnStart"], squad: "none" });
  assert.equal(op.status, "applied");
  const arm0 = indexEntries(combat)[0].armStart;
  assert.deepEqual([arm0.round, arm0.activation, arm0.open, typeof arm0.epoch, arm0.combatantId], [1, 1, true, "string", cmbOf(combat, tBorin).id]);
  // A late turnStart of the same activation (repeated by the system / Combat Tools): deduplicated, not dismissed.
  await asGM(() => reg().refresh("turnStart", { combat, round: 1 }));
  await idle();
  assert.ok(alive(op.summonId), "same activation: kept");
  // After a GM reload the lifecycle counts activation 1 again: the arm (activation 1) still holds in this round.
  forgetCombat(combat.id);
  await asGM(() => reg().refresh("turnStart", { combat, round: 1 }));
  await idle();
  assert.ok(alive(op.summonId), "activation 1 again in the same round: kept");
  await endTurn(combat);
  await combat.nextRound();
  await idle();
  assert.ok(alive(op.summonId), "the round change alone does not dismiss");
  await activate(combat, tBorin);
  assert.ok(!alive(op.summonId), "the next turn start dismisses");
  // A reload between the turns: the next round's turn start still dismisses (round fallback).
  await fresh();
  const c2 = newCombat([tBorin, tBen]);
  await activate(c2, tBorin);
  const s2 = await apiSummon({ lasts: ["summonerTurnStart"], squad: "none" });
  await endTurn(c2);
  forgetCombat(c2.id);
  await c2.nextRound();
  await idle();
  await activate(c2, tBorin);
  assert.ok(!alive(s2.op.summonId), "round fallback after a reload");
  console.log("ok H32 arming: kept through repeats of its activation, dismissed at the next turn start (also after a reload)");
}
/* H32b (review fix): a GM reload AFTER the arm, in the same round. The counters restart at 1 (new epoch); the arm
   holds the old, larger number and must not be compared with it. */
{
  await fresh();
  const combat = newCombat([tBorin, tBen]);
  await activate(combat, tBorin);
  await endTurn(combat);
  await combat.nextRound();
  await idle();
  await activate(combat, tBorin);   // round 2: Borin's activation 2
  const { op } = await apiSummon({ lasts: ["summonerTurnEnd"], squad: "none" });
  assert.equal(indexEntries(combat)[0].armEnd.activation, 2);
  resetActivations();               // the GM presses F5 mid-turn
  await endTurn(combat);
  assert.ok(!alive(op.summonId), "summonerTurnEnd: dismissed at the end of that turn after a reload");
  // summonerTurnStart made inside the open activation: a repeated start after the reload keeps it, a second
  // activation in the same round (a solo monster) dismisses it.
  await fresh();
  const c2 = newCombat([tBorin, tBen]);
  await activate(c2, tBorin);
  await endTurn(c2);
  await c2.nextRound();
  await idle();
  await activate(c2, tBorin);
  const s2 = await apiSummon({ lasts: ["summonerTurnStart"], squad: "none" });
  resetActivations();
  await asGM(() => reg().refresh("turnStart", { combat: c2, round: 2 }));
  await idle();
  assert.ok(alive(s2.op.summonId), "a repeated start of the arm's activation after a reload: kept");
  await endTurn(c2);
  await activate(c2, tBorin);       // a second activation in round 2
  assert.ok(!alive(s2.op.summonId), "the next activation's start in the same round dismisses (stale arm)");
  console.log("ok H32b reload after arming: summonerTurnEnd and a same-round second activation still count (epoch arms)");
}

/* ======================================================================== */
/*  H33: lasts summonerTurnEnd                                               */
/* ======================================================================== */
{
  await fresh();
  const combat = newCombat([tBorin, tBen]);
  await activate(combat, tBorin);
  const { op } = await apiSummon({ lasts: ["summonerTurnEnd"], squad: "none", turn: "after" });
  const msg2 = useCard(shortTurn.item, { author: player2 });
  await idle();
  const o2 = await place9(player2, msg2, [sq(10, 2)]);
  assert.ok(alive(op.summonId) && alive(o2.summonId));
  clear();
  await endTurn(combat);
  assert.ok(!alive(op.summonId) && !alive(o2.summonId), "dismissed at the end of the turn they were made in");
  assert.equal(turnWrites().length, 0, "before the chain: no chained turn for a summon that just went");
  assert.equal(combat.combatant, null);
  console.log("ok H33 summonerTurnEnd: dismissed at the end of that turn, before the chain");
}

/* ======================================================================== */
/*  H34: zero Stamina and the lock                                           */
/* ======================================================================== */
{
  await fresh();
  const combat = newCombat([tBorin, tBen]);
  const msg = useCard(soe, { author: player2 });
  await idle();
  const op = await place9(player2, msg, [sq(10, 5)]);
  const actor = summonTokens(op.summonId)[0].actor;
  await actor.update({ "system.stamina.value": 0 });
  await idle();
  assert.ok(alive(op.summonId), "not at once (2 s)");
  await advance(2_000);
  await idle();
  assert.ok(!alive(op.summonId), "dismissed after 2 s");
  assert.ok(log.whispers.some(w => w.content.includes("DSAUTO.Summon.Removal.death")), "reason death");
  assert.equal(soe.flags["stef-ds-automation"].summonState.lockedAt, 0, "lockedAt = XP + Victories");
  assert.equal(liveOp(msg, op.opId).dismissed?.reason, REMOVAL.DEATH);
  const m2 = useCard(soe, { author: player2 });
  await idle();
  assert.deepEqual([sumOp(m2).status, sumOp(m2).reason], ["skipped", "summonLocked"]);
  borin.system.hero.victories = 1;
  const m3 = useCard(soe, { author: player2 });
  await idle();
  assert.equal(sumOp(m3).status, "pending", "a Victory later: open again");
  // Healed within the 2 s: kept; a later drop re-arms the check.
  const o3 = await place9(player2, m3, [sq(10, 9)]);
  const a3 = summonTokens(o3.summonId)[0].actor;
  await a3.update({ "system.stamina.value": 0 });
  await a3.update({ "system.stamina.value": 10 });
  await advance(2_000);
  await idle();
  assert.ok(alive(o3.summonId), "healed in time: kept");
  await a3.update({ "system.stamina.value": 0 });
  await advance(2_000);
  await idle();
  assert.ok(!alive(o3.summonId), "the guard re-armed");
  console.log("ok H34 zero Stamina: dismissed after 2 s (death), locked until a Victory; healed in time kept, re-armed");
}

/* H34b (review fix): zeroStamina on a summon of two creatures: only the one at 0 goes; the last one ends the summon. */
{
  await fresh();
  const combat = newCombat([tBorin, tBen]);
  const out = await api.summon({ summoner: tBorin, actor: cuuid("source"), quantity: 2, places: "auto", turn: "own", lasts: ["zeroStamina"], squad: "none" });
  await idle();
  const op = opsOf(messages.get(out.messageId))[0];
  assert.equal(op.status, "applied");
  const [a, b] = summonTokens(op.summonId);
  assert.ok(a && b, "two creatures");
  const cbs = combat.combatants.size;
  clear();
  await a.actor.update({ "system.stamina.value": 0 });
  await advance(2_000);
  await idle();
  assert.deepEqual(summonTokens(op.summonId).map(t => t.id), [b.id], "only the creature at 0 removed");
  assert.equal(combat.combatants.size, cbs - 1, "its combatant removed");
  assert.ok(!combat.combatants.some(c => c.tokenId === a.id));
  assert.deepEqual(indexEntries(combat).find(e => e.summonId === op.summonId)?.tokenIds, [b.id], "index keeps the other");
  assert.ok(log.whispers.some(w => w.content.includes("DSAUTO.Summon.Removal.death")), "reason death");
  assert.equal(opsOf(messages.get(out.messageId))[0].dismissed ?? null, null, "the row stays live");
  await b.actor.update({ "system.stamina.value": 0 });
  await advance(2_000);
  await idle();
  assert.ok(!alive(op.summonId), "the last one ends the summon");
  assert.ok(!indexEntries(combat).some(e => e.summonId === op.summonId), "index entry dropped");
  assert.equal(opsOf(messages.get(out.messageId))[0].dismissed?.reason, REMOVAL.DEATH);
  console.log("ok H34b zeroStamina, two creatures: only the one at 0 goes (combatant, token, index); the last one dismisses the summon");
}

/* ======================================================================== */
/*  H35: Stamina carried over                                                */
/* ======================================================================== */
{
  await fresh();
  const combat = newCombat([tBorin, tBen]);
  const msg = useCard(soe, { author: player2 });
  await idle();
  const op = await place9(player2, msg, [sq(10, 5)]);
  await summonTokens(op.summonId)[0].actor.update({ "system.stamina.value": 30 });
  const out = await as(player2, () => api.summons.dismiss(op.summonId));
  assert.equal(out.removed, 1);
  await idle();
  assert.deepEqual([soe.flags["stef-ds-automation"].summonState.combatId, soe.flags["stef-ds-automation"].summonState.stamina], [combat.id, 30]);
  const m2 = useCard(soe, { author: player2 });
  await idle();
  const o2 = await place9(player2, m2, [sq(10, 5)]);
  const t2 = summonTokens(o2.summonId)[0];
  assert.equal(o2.carried, 30);
  assert.equal(t2.delta.system.stamina.value, 30, "delta.system.stamina.value");
  assert.equal(t2.actor.system.stamina.value, 30);
  await as(player2, () => api.summons.dismiss(o2.summonId));
  await idle();
  newCombat([tBorin, tBen]);
  const m3 = useCard(soe, { author: player2 });
  await idle();
  const o3 = await place9(player2, m3, [sq(10, 5)]);
  assert.equal(o3.carried, null, "a new combat: full Stamina");
  assert.equal(summonTokens(o3.summonId)[0].actor.system.stamina.value, 45);
  console.log("ok H35 carry: 30/45 carried in the same combat, 45 in a new one");
}

/* ======================================================================== */
/*  H36: the summoner dying                                                  */
/* ======================================================================== */
{
  await fresh();
  const msg = useCard(dyingSoe.item, { author: player2 });
  await idle();
  const op = await place9(player2, msg, [sq(10, 5)]);
  const other = await place9(player2, useCard(ownSoe.item, { author: player2 }), [sq(10, 9)]);
  await borin.createEmbeddedDocuments("ActiveEffect", [{ name: "Dying", statuses: ["dying"] }]);
  await idle();
  assert.ok(!alive(op.summonId), "summonerDying: dismissed");
  assert.ok(alive(other.summonId), "a summon without summonerDying stays");
  const m2 = useCard(dyingSoe.item, { author: player2 });
  await idle();
  const o2 = await place9(player2, m2, [sq(1, 5)]);
  assert.deepEqual([o2.status, o2.reason], ["skipped", "summonerDown"]);
  console.log("ok H36 summoner dying: summonerDying summons dismissed; a row applied while dying -> skipped summonerDown");
}

/* ======================================================================== */
/*  H37: end of the encounter                                                */
/* ======================================================================== */
{
  await fresh();
  // A listed summon made out of combat before the encounter (CH7).
  const pre = await place9(player2, useCard(soe, { author: player2 }), [sq(1, 5)]);
  assert.equal(pre.combatId, null);
  const combat = newCombat([tBorin, tMonarch]);
  const s1 = await place9(player2, useCard(soe, { author: player2 }), [sq(10, 5)]);
  const gm1 = useCard(itemOf(tMonarch), { token: tMonarch });
  await idle();
  const s2 = await place9(gm, gm1, [sq(14, 11), sq(15, 11)]);
  summonTokens(s2.summonId)[0].actor.statuses.add("dead");   // one dead runner
  const manual = await apiSummon({ lasts: ["manual"], squad: "none", places: [{ x: 10 * G, y: 9 * G }] });
  assert.equal(manual.op.status, "applied");
  clear();
  await combat.delete();
  await idle();
  assert.ok(![pre, s1, s2].some(o => alive(o.summonId)), "listed summons removed (alive and dead, CH7 included)");
  assert.ok(alive(manual.op.summonId), "listed: a manual summon stays");
  const ends = log.whispers.filter(w => w.content.includes("DSAUTO.Summon.EncounterEnd"));
  assert.equal(ends.length, 1, "one GM whisper");
  assert.ok(ends[0].content.includes("Source of Earth") && ends[0].content.includes("Goblin Runner"));
  assert.equal(log.whispers.length, 1, "quiet dismissals");
  assert.equal(soe.flags["stef-ds-automation"].summonState.stamina, null, "summonState.stamina cleared");
  // all: a manual summon of that combat goes too.
  await fresh();
  await set("summonEncounterEnd", "all");
  const c2 = newCombat([tBorin, tBen]);
  const m2 = await apiSummon({ lasts: ["manual"], squad: "none" });
  assert.equal(m2.op.combatId, c2.id);
  await c2.delete();
  await idle();
  assert.ok(!alive(m2.op.summonId), "all: removed");
  // none: kept.
  await fresh();
  await set("summonEncounterEnd", "none");
  const c3 = newCombat([tBorin, tBen]);
  const m3 = await apiSummon({ squad: "none" });
  await c3.delete();
  await idle();
  assert.ok(alive(m3.op.summonId), "none: kept");
  // A combat that never started removes nothing.
  await fresh();
  const m4 = await apiSummon({ squad: "none" });
  const c4 = newCombat([tBorin, tBen], { started: false, round: 0 });
  await c4.delete();
  await idle();
  assert.ok(alive(m4.op.summonId), "never started: nothing removed");
  console.log("ok H37 encounter end: listed (alive, dead, out-of-combat on that scene) removed with one whisper; all / none; unstarted");
}

/* H37b (review fix): a deletion in flight elsewhere (Death Tracker's clearSkullsOnCombatEnd) passes `has`, the
   server refuses the whole batch: the ids still present are deleted once more; a real failure still throws. */
{
  const coll = new Map([["a", 1], ["b", 1], ["c", 1]]);
  let inFlight = "a";
  const calls = [];
  const parent = {
    tokens: coll,
    async deleteEmbeddedDocuments(_name, ids) {
      calls.push([...ids]);
      if (inFlight && ids.includes(inFlight)) {
        coll.delete(inFlight);   // the other module's delete lands first
        inFlight = null;
        throw new Error('Token "a" does not exist!');
      }
      for (const id of ids) coll.delete(id);
      return ids;
    },
  };
  assert.deepEqual(await deletePresent(parent, "Token", ["a", "b", "c"]), ["b", "c"]);
  assert.deepEqual(calls, [["a", "b", "c"], ["b", "c"]], "retried with the ids still present");
  assert.equal(coll.size, 0, "the living tokens are gone too");
  coll.set("d", 1);
  const broken = { tokens: coll, async deleteEmbeddedDocuments() { throw new Error("refused"); } };
  await assert.rejects(deletePresent(broken, "Token", ["d"]), /refused/, "nothing deleted meanwhile: thrown");
  console.log("ok H37b deletePresent: a batch refused over a concurrent deletion is retried with the ids left; a real failure throws");
}

/* H37c (live run 2026-10-07, T88): core's "combatEnd" refresh writes expired effects on the summons' tokens while the
   deleteCombat hooks run; the encounter-end removal waits for it, so no token is deleted under that write. */
{
  await fresh();
  await set("summonEncounterEnd", "listed");
  const combat = newCombat([tBorin, tMonarch]);
  const gm1 = useCard(itemOf(tMonarch), { token: tMonarch });
  await idle();
  const s1 = await place9(gm, gm1, [sq(14, 11), sq(15, 11)]);
  assert.ok(alive(s1.summonId));
  let release = null;
  const seen = [];
  refreshHook = (event, context) => {
    if (event !== "combatEnd") return undefined;
    seen.push(context?.combat?.id);
    return new Promise(resolve => { release = resolve; }).then(() => {
      seen.push(alive(s1.summonId) ? "tokens there at the write" : "tokens gone before the write");
    });
  };
  try {
    await combat.delete();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(seen, [combat.id], "the combatEnd refresh started");
    assert.ok(alive(s1.summonId), "nothing removed while core's expired-effect write is in flight");
    release();
    await idle();
    await new Promise(resolve => setTimeout(resolve, 20));
    await idle();
    assert.equal(seen[1], "tokens there at the write");
    assert.ok(!alive(s1.summonId), "removed once the refresh is done");
    // A refresh that fails does not block the removal.
    await fresh();
    const c2 = newCombat([tBorin, tMonarch]);
    const gm2 = useCard(itemOf(tMonarch), { token: tMonarch });
    await idle();
    const s2 = await place9(gm, gm2, [sq(14, 11), sq(15, 11)]);
    refreshHook = event => (event === "combatEnd" ? Promise.reject(new Error("refused")) : undefined);
    await c2.delete().catch(() => {});
    await idle();
    await new Promise(resolve => setTimeout(resolve, 20));
    await idle();
    assert.ok(!alive(s2.summonId), "a failed refresh still lets the removal run");
  } finally {
    refreshHook = null;
  }
  console.log("ok H37c encounter end waits for core's combatEnd effect refresh (and not for a failed one)");
}

/* ======================================================================== */
/*  H38: dismissal                                                           */
/* ======================================================================== */
{
  await fresh();
  const combat = newCombat([tBorin, tMonarch]);
  const msgA = useCard(runnersOwn.item, { author: player2 });
  await idle();
  const a = await place9(player2, msgA, [sq(10, 5), sq(11, 5)]);
  const msgB = useCard(runnersOwn.item, { author: player2 });
  await idle();
  const b = await place9(player2, msgB, [sq(10, 9), sq(11, 9)]);
  assert.equal(b.groupId, a.groupId, "B joined A's squad");
  const g = combat.groups.get(a.groupId);
  assert.equal(g.system.staminaValue, 16);
  assert.equal(textOf(msgB, player2).canDismiss, true, "Dismiss button for Test");
  assert.equal(textOf(msgB, player).canDismiss, false, "not for another player");
  clear();
  const out = await as(player2, () => api.summons.dismiss(b.summonId));
  assert.deepEqual([out.ok, out.removed, out.gone], [true, 2, false]);
  await idle();
  assert.equal(log.combatantDeletes.length, 2);
  assert.ok(log.tokenDeletes.every(t => t.at === 2), "combatants deleted before the tokens");
  assert.ok(log.tokenDeletes.every(t => t.options["stef-ds-automation"]?.internal), "tokens with {internal: true}");
  assert.ok(log.dtDeletes.every(d => d.found === 0), "Death Tracker finds nothing to do");
  assert.equal(log.poolWrites.length, 1, "the pool changes once");
  assert.equal(g.system.staminaValue, 8, "living minions' pool minus the removed");
  assert.ok(combat.groups.has(g.id), "the squad lives on");
  assert.deepEqual(liveOp(msgB, sumOp(msgB).opId).dismissed?.reason, REMOVAL.DISMISS, "row annotated");
  assert.equal(textOf(msgB, player2).canDismiss, false, "Dismiss button gone");
  assert.ok(!listSummons().some(s => s.summonId === b.summonId), "gone on the GM");
  assert.ok(!as(player2, () => api.summons.list()).some(s => s.summonId === b.summonId), "gone on Test's client");
  assert.ok(as(player2, () => api.summons.of(borin)).some(s => s.summonId === a.summonId), "A still listed");
  // A second dismissal: gone, no delete call.
  clear();
  const again = await as(gm, () => dismissSummon(b.summonId, REMOVAL.DISMISS));
  assert.deepEqual([again.removed, again.gone], [0, true]);
  assert.equal(log.tokenDeletes.length + log.combatantDeletes.length, 0, "no delete call");
  // The last summon of our squad: the empty group is deleted.
  await as(player2, () => api.summons.dismiss(a.summonId));
  await idle();
  assert.ok(!combat.groups.has(g.id), "our empty group deleted");
  // A token deleted meanwhile by someone else: no throw.
  const c = await place9(player2, useCard(runnersOwn.item, { author: player2 }), [sq(10, 5), sq(11, 5)]);
  const [t1] = summonTokens(c.summonId);
  await START.deleteEmbeddedDocuments("Token", [t1.id], {});
  await idle();
  const r = await as(player2, () => api.summons.dismiss(c.summonId));
  assert.equal(r.removed, 1, "the rest removed, no throw");
  console.log("ok H38 dismiss: combatants before tokens (internal), DT idle, pool once, group kept / deleted when empty, annotated, lists updated");
}

/* ======================================================================== */
/*  H38b: dismissal against the chain; a held card does not stall it         */
/* ======================================================================== */
{
  await fresh();
  answerFn = rec => (rec.kind === "trigger" ? "decline" : undefined);
  const combat = newCombat([tBorin, tBen, tMonarch]);
  await activate(combat, tBorin);
  const msg = useCard(pairAfter.item, { author: player2 });
  await idle();
  const op = await place9(player2, msg, [sq(10, 5), sq(11, 5)]);
  await endTurn(combat);
  const ids = op.combatantIds;
  assert.ok(ids.includes(combat.combatant?.id), "one token's turn");
  clear();
  await as(player2, () => api.summons.dismiss(op.summonId));
  await idle(60);
  assert.ok(!combat.combatants.some(c => ids.includes(c.id)), "both gone");
  assert.equal(turnWrites().length, 0, "the summon's turnEnd chain picked neither token");
  assert.ok(combat.combatant === null || combat.combatants.has(combat.combatant.id), "combat.turn points at a live combatant (or none)");
  // A dismissal while another card's lock is held (an M5 hold prompting): the lifecycle queue is not stalled.
  await fresh();
  const c2 = newCombat([tBorin, tBen]);
  await activate(c2, tBorin);
  const m2 = useCard(shortTurn.item, { author: player2 });
  await idle();
  const o2 = await place9(player2, m2, [sq(10, 5)]);
  let release;
  const held = withMessageLock(m2.id, () => new Promise(r => { release = r; }));
  await settle(10);
  await c2.endTurn();
  const idleNow = await Promise.race([settle(40).then(() => lifecycleIdle()).then(() => true), settle(1500).then(() => false)]);
  assert.equal(idleNow, true, "lifecycle queue idle while the card lock is held");
  assert.ok(!alive(o2.summonId), "dismissed without waiting for the card");
  assert.equal(liveOp(m2, o2.opId).dismissed ?? null, null, "annotation still waiting for the lock");
  release();
  await held;
  await idle();
  assert.equal(liveOp(m2, o2.opId).dismissed?.reason, REMOVAL.EXPIRED, "annotated after the lock");
  console.log("ok H38b dismissal vs chain: no token picked, turn on a live combatant; a held card lock never stalls the lifecycle");
}

/* ======================================================================== */
/*  H39: dismissing the current combatant                                    */
/* ======================================================================== */
{
  await fresh();
  answerFn = rec => (rec.kind === "trigger" ? "decline" : undefined);
  const s = await chainSetup({ item: afterSoe.item });
  await endTurn(s.combat);
  assert.equal(s.combat.combatant, s.cb, "the summon is current");
  clear();
  await dismissSummon(s.op.summonId, REMOVAL.DISMISS);
  await idle();
  const endIdx = log.combatUpdates.findIndex(u => u.who === "combat" && u.changes.turn === null);
  assert.ok(endIdx >= 0, "endTurn first");
  assert.equal(log.turnShift, undefined, "no core turn shift onto another combatant");
  assert.equal(s.combat.turn, null, "combat.turn null afterwards");
  assert.equal(as(player2, () => game.combat.combatant), null, "on every client");
  console.log("ok H39 dismiss mid-turn: endTurn first, then the deletion; turn null");
}

/* ======================================================================== */
/*  H40: dismissal authorization                                             */
/* ======================================================================== */
{
  await fresh();
  const { op } = await apiSummon({ squad: "none" });
  await assert.rejects(as(player, () => api.summons.dismiss(op.summonId)), /DSAUTO\.Relay\.Denied/, "another player");
  // A user owning only the summon token (a monster's summon handed to Other).
  const mon = await api.summon({ summoner: tMonarch, actor: cuuid("runner"), squad: "none", places: "auto" });
  await idle();
  const mop = opsOf(messages.get(mon.messageId))[0];
  const [mt] = summonTokens(mop.summonId);
  mt._source.delta.ownership = { pl: 3 };
  mt._synth = null;
  const r = await as(player, () => api.summons.dismiss(mop.summonId));
  assert.equal(r.removed, 1, "owner of the summon token: allowed");
  await assert.rejects(as(player2, () => api.summons.dismiss("nope00000000nope")), /DSAUTO\.Relay\.UnknownSummon/);
  console.log("ok H40 dismiss auth: other player Denied, token owner allowed, unknown id UnknownSummon");
}
/* H40b (review fix): a player writes the summon flag of the Director's hostile summon onto their own hero token. */
{
  await fresh();
  const mon = await api.summon({ summoner: tMonarch, actor: cuuid("runner"), squad: "none", places: "auto" });
  await idle();
  const id = opsOf(messages.get(mon.messageId))[0].summonId;
  assert.ok(alive(id));
  const forged = { summonId: id, summonerActorUuid: benedikt.uuid, index: -1, lasts: ["zeroStamina"] };
  // The GM is online: the write is stripped again.
  await as(player, () => tBen.update({ "flags.stef-ds-automation.summon": forged }));
  await idle();
  assert.equal(tBen.flags["stef-ds-automation"]?.summon, undefined, "a player's summon flag write is stripped by the GM");
  // Written while no GM was online (found by the cache rebuild): not a member, so neither the summoner nor a token owner.
  tBen._source.flags["stef-ds-automation"] = { ...(tBen._source.flags["stef-ds-automation"] ?? {}), summon: forged };
  try {
    Hooks.callAll("canvasReady");
    assert.ok(!summonInfo(id).tokenUuids.includes(tBen.uuid), "the forged token is not a member (the signed record decides)");
    assert.equal(summonInfo(id).summonerActorUuid, tMonarch.actor.uuid, "the summoner comes from a real member");
    await assert.rejects(as(player, () => api.summons.dismiss(id)), /DSAUTO\.Relay\.Denied/, "forged ownership refused");
    assert.ok(alive(id), "the Director's summon survives");
  } finally {
    delete tBen._source.flags["stef-ds-automation"].summon;
    Hooks.callAll("canvasReady");
  }
  console.log("ok H40b forged flag: stripped when the GM sees the write; otherwise not a member (record decides), dismiss Denied");
}

/* ======================================================================== */
/*  H41: deletions and copies made by others                                 */
/* ======================================================================== */
{
  await fresh();
  const combat = newCombat([tBorin, tBen]);
  const msg = useCard(ownSoe.item, { author: player2 });
  await idle();
  const op = await place9(player2, msg, [sq(10, 5)]);
  const [t] = summonTokens(op.summonId);
  await START.deleteEmbeddedDocuments("Token", [t.id], {});   // the Director, by hand
  await idle();
  assert.equal(indexEntries(combat).length, 0, "registry entry dropped");
  assert.equal(liveOp(msg, op.opId).dismissed?.reason, REMOVAL.DISMISS, "row annotated dismiss");
  assert.ok(textOf(msg, gm).detail.includes("DSAUTO.Card.SummonDismissed"));
  // A copy-paste of a summon token: the copy loses the flag and survives a dismissal of the original.
  const o2 = await place9(player2, useCard(ownSoe.item, { author: player2 }), [sq(10, 9)]);
  const [orig] = summonTokens(o2.summonId);
  const [copy] = await START.createEmbeddedDocuments("Token", [{ ...orig.toObject(), _id: undefined, x: 12 * G }], {});
  await idle();
  assert.equal(copy.flags["stef-ds-automation"]?.summon, undefined, "the copy is not part of the summon");
  await dismissSummon(o2.summonId, REMOVAL.DISMISS);
  await idle();
  assert.ok(START.tokens.has(copy.id), "the copy survives");
  copy.extra = true;
  console.log("ok H41 external delete: entry dropped, row annotated; a pasted copy loses the flag and survives");
}

/* ======================================================================== */
/*  H42: undo                                                                */
/* ======================================================================== */
{
  await fresh();
  const combat = newCombat([tBorin, tBen]);
  const msg = useCard(ownSoe.item, { author: player2 });
  await idle();
  const op0 = sumOp(msg);
  const op = await place9(player2, msg, [sq(10, 5)]);
  const cbs = combat.combatants.size;
  await within(5_000, as(player2, () => api.undoOps(msg.id, [op.opId])), "undo inside the lock");
  await idle();
  const u = liveOp(msg, op.opId);
  assert.equal(u.status, "undone");
  assert.equal(u.undoMode ?? null, null);
  assert.ok(!alive(op.summonId), "tokens gone");
  assert.equal(combat.combatants.size, cbs - 1, "combatant gone");
  // Re-apply as Test without places: pending placeOnCanvas; with places: applied, dismissed cleared, Dismiss back.
  await relayApply(player2, msg, [op.opId]);
  assert.deepEqual([liveOp(msg, op.opId).status, liveOp(msg, op.opId).reason], ["pending", "placeOnCanvas"]);
  const re = await place9(player2, msg, [sq(10, 5)], op0);
  assert.equal(re.status, "applied");
  assert.equal(re.dismissed, null);
  assert.notEqual(re.summonId, op.summonId);
  assert.equal(textOf(msg, player2).canDismiss, true, "Dismiss button back");
  // A late annotation of the old summon does not land on the re-applied row (summonId differs).
  const stale = { ...summonTokens(re.summonId)[0].toObject(), _id: undefined, x: 1 * G, y: 9 * G };
  stale.flags["stef-ds-automation"].summon.summonId = op.summonId;
  const [ghost] = await START.createEmbeddedDocuments("Token", [stale], { "stef-ds-automation": { internal: true } });
  await START.deleteEmbeddedDocuments("Token", [ghost.id], {});
  await idle();
  assert.equal(liveOp(msg, op.opId).dismissed, null, "not annotated (newer summon)");
  // Undo after a dismissal: alreadyGone.
  await dismissSummon(re.summonId, REMOVAL.DISMISS);
  await idle();
  await api.undoOps(msg.id, [op.opId]);
  await idle();
  assert.deepEqual([liveOp(msg, op.opId).status, liveOp(msg, op.opId).undoMode], ["undone", "alreadyGone"]);
  assert.ok(textOf(msg, gm).detail.includes("DSAUTO.Card.AlreadyGone"));
  // A failing dismissal: failed undoError (never a false undo).
  const m2 = useCard(ownSoe.item, { author: player2 });
  await idle();
  const o2 = await place9(player2, m2, [sq(10, 9)]);
  sw.failCombatantDelete = 1;
  await api.undoOps(m2.id, [o2.opId]);
  await idle();
  assert.deepEqual([liveOp(m2, o2.opId).status, liveOp(m2, o2.opId).reason], ["failed", "undoError"]);
  // "Undo all" includes the summon row.
  const m3 = useCard(ownSoe.item, { author: player2 });
  await idle();
  const o3 = await place9(player2, m3, [sq(1, 5)]);
  await api.undoOps(m3.id);
  await idle();
  assert.equal(liveOp(m3, o3.opId).status, "undone");
  assert.ok(!alive(o3.summonId));
  console.log("ok H42 undo: removed within the lock; re-apply pending / applied (dismissed cleared); stale annotation refused; alreadyGone; undoError; Undo all");
}

/* H42b (review fix): a summon that is gone (expired, dismissed) leaves the owner's bypass: no Undo, then Apply, for a
   free new summon. The Director still may. */
{
  await fresh();
  newCombat([tBorin, tBen]);
  const msg = useCard(ownSoe.item, { author: player2 });
  await idle();
  const op = await place9(player2, msg, [sq(10, 5)]);
  assert.equal(textOf(msg, player2).canUndo, true, "live: the owner may undo");
  await dismissSummon(op.summonId, REMOVAL.EXPIRED);
  await idle();
  assert.equal(liveOp(msg, op.opId).dismissed?.reason, REMOVAL.EXPIRED);
  assert.equal(textOf(msg, player2).canUndo, false, "expired: no Undo for the owner");
  await assert.rejects(as(player2, () => requestOp({ action: "undo", messageId: msg.id, opIds: [op.opId] })), /DSAUTO\.Relay\.Denied/, "relay undo refused");
  assert.equal(liveOp(msg, op.opId).status, "applied");
  // The Director undoes it (alreadyGone): the owner still cannot re-apply it.
  await api.undoOps(msg.id, [op.opId]);
  await idle();
  assert.deepEqual([liveOp(msg, op.opId).status, liveOp(msg, op.opId).undoMode], ["undone", "alreadyGone"]);
  assert.equal(textOf(msg, player2).canApply, false, "no Summon button for the owner");
  await assert.rejects(relayApply(player2, msg, [op.opId], { places: { [op.opId]: { actor: cuuid("source"), squares: [sq(10, 5)] } } }), /DSAUTO\.Relay\.Denied/, "re-apply refused");
  assert.equal(textOf(msg, gm).canApply, true, "the Director may");
  console.log("ok H42b gone summon: the owner's Undo and re-apply refused (expired, alreadyGone); the Director may");
}

/* ======================================================================== */
/*  H43: api.summon                                                          */
/* ======================================================================== */
const squaresOf = id => summonTokens(id).map(t => [t.x / G, t.y / G]);
{
  await fresh();
  // A places array without level / elevation: filled from Borin's token.
  const a = await apiSummon({ actor: cuuid("source"), squad: "none", places: [{ x: 10 * G, y: 5 * G }] });
  assert.equal(a.op.status, "applied");
  assert.equal(a.op.synthetic, true);
  const [ta] = summonTokens(a.op.summonId);
  assert.deepEqual([ta.level, ta.elevation], [LEVEL, 0]);
  await assert.rejects(api.summon({ summoner: tBorin, actor: cuuid("runner"), places: [{ x: "a", y: 1 }] }), /DSAUTO\.Relay\.BadRequest/, "malformed array");
  // auto: nearest free squares, ring by ring, row-major.
  const b = await apiSummon({ quantity: 2, distance: 1, squad: "none" });
  assert.deepEqual(squaresOf(b.op.summonId), [[4, 4], [5, 4]], "deterministic ring order");
  assert.equal(b.op.auto, true);
  // At the map's corner: never outside the scene rectangle, fewer when the space is short, then none.
  tBorin._source.x = 0;
  tBorin._source.y = 0;
  const c = await apiSummon({ quantity: 5, distance: 1, squad: "none" });
  assert.deepEqual(squaresOf(c.op.summonId), [[1, 0], [0, 1], [1, 1]], "inside the scene only");
  assert.deepEqual([c.op.placed, c.op.requested], [3, 5]);
  const d = await apiSummon({ quantity: 1, distance: 1, squad: "none" });
  assert.deepEqual([d.op.status, d.op.reason], ["failed", "noSpace"]);
  // A player: refused before any picker.
  await assert.rejects(as(player2, () => api.summon({ summoner: tBorin, actor: cuuid("runner") })), /DSAUTO\.Relay\.Denied/);
  assert.equal(log.place.length, 0);
  // pick: the calling Director picks on their canvas first (compendium prototype previews).
  tBorin._source.x = 5 * G;
  tBorin._source.y = 5 * G;
  clicks(gm, { x: 10, y: 2 });
  const e = await api.summon({ summoner: tBorin, actor: cuuid("source"), squad: "none", places: "pick" });
  await idle();
  const eo = opsOf(messages.get(e.messageId))[0];
  assert.equal(eo.status, "applied");
  assert.equal(log.place.at(-1).user, "gm");
  assert.equal(log.place.at(-1).previews[0].actorId, null, "actorless compendium preview");
  assert.equal(eo.byClient, true);
  console.log("ok H43 api.summon: squares filled from the summoner, BadRequest, auto ring order / scene bounds / short / noSpace, Denied, pick");
}

/* ======================================================================== */
/*  H44: summonPlacement auto                                                */
/* ======================================================================== */
{
  await fresh();
  await set("summonPlacement", "auto");
  const combat = newCombat([tBorin, tMonarch]);
  const msg = useCard(itemOf(tMonarch), { token: tMonarch });
  await idle();
  assert.equal(textOf(msg, gm).applyAction, "dsAutoApply", "the Director's row: Apply (GM search)");
  await api.applyOps(msg.id, [sumOp(msg).opId]);
  await idle();
  const op = liveOp(msg, sumOp(msg).opId);
  assert.equal(op.status, "applied");
  assert.equal(op.auto, true);
  assert.equal(op.placed, 2);
  assert.ok(combat.groups.get(op.groupId));
  const m2 = useCard(soe, { author: player2 });
  await idle();
  assert.equal(textOf(m2, player2).applyAction, "dsAutoSummon", "a player's row still picks");
  // Review fix: a row offering several stat blocks keeps the Summon button for the Director: choose, then the GM search.
  const m3 = useCard(eitherSoe.item, { author: player2 });
  await idle();
  const o3 = sumOp(m3);
  assert.equal(textOf(m3, gm).applyAction, "dsAutoSummon", "multi-choice row: the Summon button (choice dialog)");
  answerFn = rec => (rec.kind === "choose" ? { action: "summon", option: 1 } : undefined);
  await pick(gm, m3, o3);
  const r3 = liveOp(m3, o3.opId);
  assert.deepEqual([r3.status, r3.actorUuid, r3.auto], ["applied", cuuid("runner"), true], "the chosen one, placed by the GM search");
  assert.equal(log.place.length, 0, "no picker");
  // api.summon with several stat blocks, places auto and a pick: the pick is kept.
  const out = await api.summon({ summoner: tBorin, actors: [cuuid("source"), cuuid("runner")], pick: cuuid("runner"), places: "auto", squad: "none" });
  await idle();
  const ao = opsOf(messages.get(out.messageId))[0];
  assert.deepEqual([ao.status, ao.actorUuid], ["applied", cuuid("runner")], "api auto keeps the pick");
  console.log("ok H44 placement auto: Director's row applies with the GM search; players still pick; multi-choice: choose then search; api pick kept");
}

/* ======================================================================== */
/*  H45: origin target (An Army From Blood)                                  */
/* ======================================================================== */
{
  await fresh();
  const combat = newCombat([tBorin, tBloodlord, tHobgoblin]);
  const msg = useCard(itemOf(tBloodlord), { token: tBloodlord, targets: [tHobgoblin] });
  await idle();
  const op = sumOp(msg);
  assert.equal(op.status, "pending");
  assert.equal(op.origin, "target");
  assert.equal(op.anchorTokenUuid, tHobgoblin.uuid);
  const res = getResolution(msg);
  assert.ok(op.anchorKey && res.targets[op.anchorKey]?.name === "Hobgoblin Sentry", "the anchor stays on the card");
  assert.ok(textOf(msg, gm).detail.includes('DSAUTO.Card.SummonRangeTarget {"distance":1,"name":"Hobgoblin Sentry"}'));
  // A non-fresh re-resolve keeps the row pending (the anchor is still on the card).
  await api.resolve(msg.id, { force: true });
  await idle();
  assert.equal(sumOp(msg).status, "pending");
  assert.equal(sumOp(msg).anchorTokenUuid, tHobgoblin.uuid);
  // Adjacent to the target: fine; adjacent only to the Bloodlord: too far.
  const near = await place9(gm, msg, [sq(13, 15)]);
  assert.deepEqual([near.status, near.reason], ["failed", "tooFar"]);
  const ok9 = await place9(gm, msg, [sq(17, 15), sq(17, 16)]);
  assert.equal(ok9.status, "applied");
  assert.equal(ok9.combatId, combat.id);
  // Review fix: the Bloodlord on a ledge (elevation 2), the anchor at 0: squares sit at the ANCHOR's elevation (the
  // range is measured from it), on the GM search and on the picker's previews.
  const msg2 = useCard(itemOf(tBloodlord), { token: tBloodlord, targets: [tHobgoblin] });
  await idle();
  tBloodlord._source.elevation = 2;
  try {
    const { data } = await buildPreviews({ choice: sumOp(msg2).choices[0], summonerDoc: tBloodlord, anchorDoc: tHobgoblin, quantity: 2 });
    assert.ok(data.length === 2 && data.every(d => d.elevation === 0), "previews at the anchor's elevation");
    await api.applyOps(msg2.id, [sumOp(msg2).opId]);
    await idle();
    const o = liveOp(msg2, sumOp(msg2).opId);
    assert.deepEqual([o.status, o.reason ?? null, o.auto], ["applied", null, true], "GM search next to the anchor despite the height gap");
    assert.ok(summonTokens(o.summonId).every(t => t.elevation === 0), "created at the anchor's elevation");
  } finally {
    tBloodlord._source.elevation = 0;
  }
  // Review fix: api.summon squares without elevation sit at the ANCHOR's elevation for origin "target" (D12).
  tBloodlord._source.elevation = 15;
  try {
    const hx = tHobgoblin.x / G;
    const hy = tHobgoblin.y / G;
    const taken = (x, y) => START.tokens.some(t => x * G >= t.x && x * G < t.x + (t.width ?? 1) * G && y * G >= t.y && y * G < t.y + (t.height ?? 1) * G);
    const [fx, fy] = [[0, -1], [1, -1], [-1, -1], [0, 1], [1, 1], [-1, 1], [1, 0], [-1, 0]].map(([dx, dy]) => [hx + dx, hy + dy]).find(([x, y]) => !taken(x, y));
    const out = await api.summon({ summoner: tBloodlord, actor: cuuid("runner"), origin: "target", anchor: tHobgoblin, distance: 1, squad: "none", places: [{ x: fx * G, y: fy * G }] });
    await idle();
    const ao = opsOf(messages.get(out.messageId))[0];
    assert.deepEqual([ao.status, ao.reason ?? null], ["applied", null], "api squares next to the anchor (summoner 15 ft up)");
    assert.ok(summonTokens(ao.summonId).every(t => t.elevation === 0), "at the anchor's elevation");
  } finally {
    tBloodlord._source.elevation = 0;
  }
  console.log("ok H45 origin target: anchor kept (also on a re-resolve), within 1 of the target, adjacent to the Bloodlord refused; anchor's elevation used (also api squares)");
}

/* ======================================================================== */
/*  H46: two summon rows on one card                                         */
/* ======================================================================== */
{
  await fresh();
  const twin = ability(borin, "Two Rows");   // a new source item: both stat blocks imported for it
  const msg = useCard(twin, { author: player2 });
  await idle();
  const [ra, rb] = sumOps(msg);
  assert.ok(ra && rb, "two rows");
  assert.equal(log.actorCreates.length, 2, "one import per stat block");
  newCombat([tBorin, tBen]);
  const a = await place9(player2, msg, [sq(10, 5)], ra);
  const b = await place9(player2, msg, [sq(10, 9)], rb);
  assert.notEqual(a.summonId, b.summonId);
  const ix = indexEntries(game.combat);
  assert.deepEqual(ix.map(e => e.summonId), [a.summonId, b.summonId], "creation order");
  borin.items.delete(twin.id);
  console.log("ok H46 two rows: one import per stat block, two summonIds in creation order");
}

/* ======================================================================== */
/*  H47: hooks                                                               */
/* ======================================================================== */
{
  await fresh();
  const veto = () => false;
  Hooks.on("dsAuto.preSummon", veto);
  const msg = useCard(soe, { author: player2 });
  await idle();
  const v = await place9(player2, msg, [sq(10, 5)]);
  Hooks.off("dsAuto.preSummon", veto);
  assert.deepEqual([v.status, v.reason], ["skipped", "hookVetoed"]);
  assert.equal(summonTokensOn().length, 0, "no token");
  const pre = hookCalls("dsAuto.preSummon")[0].args;
  assert.equal(pre[0], messages.get(msg.id));
  assert.equal(pre[1].opId, sumOp(msg).opId);
  assert.deepEqual(Object.keys(pre[2]).sort(), ["actorUuid", "sceneId", "squares", "userId", "worldActorId"]);
  assert.deepEqual([pre[2].actorUuid, pre[2].sceneId, pre[2].userId], [cuuid("source"), START.id, "p2"]);
  clear();
  const combat = newCombat([tBorin, tBen]);
  const m2 = useCard(soe, { author: player2 });
  await idle();
  const o2 = await place9(player2, m2, [sq(10, 5)]);
  const done = hookCalls("dsAuto.summon")[0].args;
  assert.equal(done[1].status, "applied");
  assert.deepEqual(done[2], { summonId: o2.summonId, tokenUuids: o2.tokenUuids, combatId: combat.id, combatantIds: o2.combatantIds, groupId: null });
  await as(player2, () => api.summons.dismiss(o2.summonId));
  await idle();
  const dis = hookCalls("dsAuto.dismissSummon")[0].args;
  assert.equal(dis[0].summonId, o2.summonId);
  assert.deepEqual(dis[1], { reason: REMOVAL.DISMISS, userId: "p2" });
  for (const k of ["tokenUuids", "names", "sceneId", "summonerActorUuid", "summonerTokenUuid", "itemUuid", "messageId", "opId", "lasts", "turn", "combatId", "createdRound", "worldActorId", "alive"]) {
    assert.ok(k in dis[0], `SummonInfo.${k}`);
  }
  assert.equal(HOOKS.preSummon, "dsAuto.preSummon");
  console.log("ok H47 hooks: preSummon veto -> hookVetoed; summon and dismissSummon arguments (§1.8)");
}

/* ======================================================================== */
/*  H48: card view and template                                              */
/* ======================================================================== */
{
  await fresh();
  const msg = useCard(soe, { author: player2 });
  await idle();
  const tv = textOf(msg, player2);
  assert.equal(tv.label, 'DSAUTO.Card.Summon {"count":1,"name":"Source of Earth"}');
  assert.ok(tv.detail.includes('DSAUTO.Card.SummonRange {"distance":10}'));
  assert.ok(tv.detail.includes("DSAUTO.Card.SummonPicksSelf"), "Test: you place it on your screen");
  assert.equal(tv.applyAction, "dsAutoSummon");
  assert.equal(tv.summonButton, true);
  const gv = textOf(msg, gm);
  assert.ok(gv.detail.includes('DSAUTO.Card.SummonPicksOwner {"name":"Test"}') && !gv.detail.includes("SummonPicksSelf"), "the Director: placed by Test");
  const ov = textOf(msg, player);
  assert.ok(!ov.detail.includes("SummonPicksSelf"), "another player is not told to place it");
  // An NPC row: whoever clicks.
  const npc = useCard(itemOf(tMonarch), { token: tMonarch });
  await idle();
  assert.ok(textOf(npc, gm).detail.includes("DSAUTO.Card.SummonPicks"), "NPC row: whoever clicks Summon");
  // Failed on its second square.
  const pair = useCard(pairSoe.item, { author: player2 });
  await idle();
  const f = await place9(player2, pair, [sq(10, 2), sq(6, 4)]);
  assert.deepEqual([f.status, f.reason, f.index], ["failed", "occupied", 1]);
  // Review fix: the square checks' reasons in the summon wording (DSAUTO.Summon.Picker.*), not forced movement's.
  assert.ok(textOf(pair, gm).detail.includes('DSAUTO.Card.SummonSquare {"n":2}: DSAUTO.Summon.Picker.occupied'));
  assert.equal(summonReasonText("tooFar"), "DSAUTO.Summon.Picker.tooFar");
  assert.equal(summonReasonText("gridUnsupported"), "DSAUTO.Summon.Picker.gridUnsupported");
  assert.equal(summonReasonText("noSpace"), "DSAUTO.Reason.noSpace");
  // Applied, then dismissed.
  const o = await place9(player2, msg, [sq(10, 5)]);
  const av = textOf(msg, player2);
  assert.ok(av.detail.includes('DSAUTO.Card.Summoned {"names":"Source of Earth"}'));
  assert.equal(av.canDismiss, true);
  const require = createRequire(import.meta.url);
  const Handlebars = paths.handlebars();
  Handlebars.registerHelper("localize", k => k);
  const tpl = Handlebars.compile(readFileSync(paths.TEMPLATES + "parts/resolution.hbs", "utf8"));
  const render = user => as(user, () => tpl({ ctx: { dsAuto: buildView(msg, getResolution(msg)) } }));
  assert.ok(render(player2).includes('data-action="dsAutoDismiss"'), "Dismiss for the summoner's owner");
  assert.ok(render(gm).includes('data-action="dsAutoDismiss"'), "Dismiss for the Director");
  assert.ok(!render(player).includes('data-action="dsAutoDismiss"'), "no Dismiss for another player");
  await dismissSummon(o.summonId, REMOVAL.DISMISS);
  await idle();
  const dv = textOf(msg, gm);
  assert.ok(dv.detail.includes('DSAUTO.Card.SummonDismissed {"reason":"DSAUTO.Summon.Removal.dismiss"}'));
  assert.equal(dv.canDismiss, false);
  assert.ok(!render(gm).includes('data-action="dsAutoDismiss"'), "no Dismiss once gone");
  const pend = useCard(soe, { author: player2 });
  await idle();
  const pv = as(player2, () => tpl({ ctx: { dsAuto: buildView(pend, getResolution(pend)) } }));
  assert.ok(pv.includes('data-action="dsAutoSummon"'), "the Summon button");
  console.log("ok H48 view: labels, per-viewer who picks, square n reason, Summoned / dismissed; template Dismiss for owner and Director only");
}

/* ======================================================================== */
/*  H49: the check.cjs reserved-names rule                                   */
/* ======================================================================== */
{
  const require = createRequire(import.meta.url);
  const { reservedProblems } = require("./check.cjs");
  for (const src of [
    "  static ACTIONS = { performSummon: this.#x };",
    "ds.CONFIG.SpecialEffect.summon = MyType;",
    'CONFIG.SpecialEffect["summon"] = MyType;',
    'actor.setFlag("draw-steel", "summoner", uuid);',
    'actor.update({ "flags.draw-steel.summoner": uuid });',
    'token.flags["draw-steel"].summoner = uuid;',
    'registerPromptType("summon", fn);',
    "ds.CONFIG.MessagePart.fall = Part;",
  ]) assert.ok(reservedProblems(src).length >= 1, `flagged: ${src}`);
  assert.ok(reservedProblems('<button data-action="performSummon">', { template: true }).length >= 1, "template data-action");
  assert.equal(reservedProblems('{{!-- data-action="performSummon" --}}', { template: true }).length, 0, "template comment");
  assert.equal(reservedProblems("// never write flags.draw-steel.summoner\n/* setFlag(\"draw-steel\", \"summoner\", x) */").length, 0, "comments pass");
  assert.equal(reservedProblems('if (ds.CONFIG.SpecialEffect.summon === undefined) x();').length, 0, "a comparison passes");
  const gate = readFileSync(ROOT + "compat/version-gate.mjs", "utf8");
  assert.ok(/performSummon:\s*typeof/.test(gate), "the probe exists");
  assert.equal(reservedProblems(gate).length, 0, "version-gate.mjs:49 passes");
  const { readdirSync, statSync } = await import("node:fs");
  const walk = dir => readdirSync(dir).flatMap(n => (statSync(dir + n).isDirectory() ? walk(dir + n + "/") : [dir + n]));
  const real = [...walk(ROOT), ...walk(paths.TEMPLATES)].filter(f => /\.(mjs|hbs)$/.test(f));
  for (const f of real) assert.deepEqual(reservedProblems(readFileSync(f, "utf8"), { template: f.endsWith(".hbs") }), [], f);
  console.log(`ok H49 reserved-names rule: planted writes flagged, comments and probes pass, ${real.length} real sources clean`);
}

/* ======================================================================== */
/*  H50: selfCheck                                                           */
/* ======================================================================== */
{
  await fresh();
  const msg = useCard(soe, { author: player2 });
  await idle();
  // An orphan: a summon token whose card row is not applied with its summonId (a GM left mid-apply).
  const [orphan] = await START.createEmbeddedDocuments("Token", [{
    name: "Lost Source", x: 1 * G, y: 1 * G, actorId: sumOp(msg).choices[0].worldActorId, actorLink: false,
    flags: { "stef-ds-automation": { summon: { summonId: "orphan0000000001", messageId: msg.id, opId: sumOp(msg).opId, lasts: ["manual"] } } },
  }], { "stef-ds-automation": { internal: true } });
  const sc = api.selfCheck();
  for (const k of ["summonTypes", "performSummon", "portfolioSummon", "dsctSquadLabels", "summonPromptTypes", "openSummons", "summonFolder", "orphanSummons"]) {
    assert.ok(k in sc.report, `selfCheck row ${k}`);
  }
  assert.equal(sc.report.summonPromptTypes, true);
  assert.equal(sc.report.summonFolder, true);
  assert.ok(sc.report.orphanSummons.includes("Lost Source"), sc.report.orphanSummons);
  assert.ok(orphanSummons().some(s => s.includes("orphan0000000001")));
  assert.ok(promptTypes().includes("summonUpkeep") && promptTypes().includes("summonUpkeepCancel"));
  orphan.extra = true;
  console.log("ok H50 selfCheck: M6 rows present, orphanSummons lists a token whose row is not applied");
}

/* ======================================================================== */
/*  H51: locks (card lock, placement lock, summon chain)                     */
/* ======================================================================== */
{
  await fresh();
  const combat = newCombat([tBorin, tBen, tMonarch]);
  const msg = useCard(twoRows.item, { author: player2 });
  await idle();
  const [ra, rb] = sumOps(msg);
  const a = await place9(player2, msg, [sq(10, 5)], ra);
  // The apply of row b holds the card lock and awaits addSummon on the chain while a's dismissal runs on the
  // chain and fires its annotation for the same card (it waits for the lock): both finish.
  const both = Promise.all([
    dismissSummon(a.summonId, REMOVAL.DISMISS),
    relayApply(player2, msg, [rb.opId], { places: { [rb.opId]: { actor: rb.choices[0].uuid, squares: [sq(10, 9)] } } }),
  ]);
  await within(5_000, both, "apply + dismissal of the same card");
  await idle();
  assert.equal(liveOp(msg, rb.opId).status, "applied");
  assert.equal(liveOp(msg, ra.opId).dismissed?.reason, REMOVAL.DISMISS, "annotated after the chain");
  assert.equal(indexEntries(combat).length, 1);
  // Undo (annotate: false) never waits for its own lock.
  await within(5_000, api.undoOps(msg.id, [rb.opId]), "undo inside its lock");
  assert.equal(liveOp(msg, rb.opId).status, "undone");
  console.log("ok H51 locks: apply (card lock -> chain) and a dismissal annotating the same card both finish; undo never self-waits");
}

/* ======================================================================== */
/*  H52: another GM becomes the active GM                                    */
/* ======================================================================== */
{
  await fresh();
  const { op } = await apiSummon({ squad: "none" });
  setActiveGM(gm2);
  await as(gm2, () => Hooks.callAll("userConnected", gm2, true));
  const listed = as(gm2, () => api.summons.list());
  assert.ok(listed.some(s => s.summonId === op.summonId), "listed from token flags on gm2");
  const out = await as(player2, () => api.summons.dismiss(op.summonId));
  assert.equal(out.removed, 1);
  assert.equal(relayed("summonDismiss").at(-1).to, "g2", "relayed to the new active GM");
  assert.ok(!alive(op.summonId));
  setActiveGM(gm);
  console.log("ok H52 GM change: gm2 lists and dismisses from token flags (cache rebuilt)");
}

/* ======================================================================== */
/*  H54: squares (scene rectangle, hidden tokens, distance)                  */
/* ======================================================================== */
{
  await fresh();
  const R = { i0: 5, j0: 5, i1: 6, j1: 6 };
  assert.equal(squaresBetween(R, { i0: 5, j0: 5, i1: 6, j1: 6 }), 0, "overlap 0");
  assert.equal(squaresBetween(R, { i0: 6, j0: 5, i1: 7, j1: 6 }), 1, "adjacent 1");
  assert.equal(squaresBetween(R, { i0: 6, j0: 6, i1: 7, j1: 7 }), 1, "diagonal 1");
  assert.equal(squaresBetween(R, { i0: 8, j0: 5, i1: 9, j1: 6 }), 3);
  const msg = useCard(soe, { author: player2 });
  await idle();
  const n0 = world.notifications.length;
  // The picker: a 2x2 footprint leaving the map is refused; a square over the hidden Lurker is accepted (not revealed).
  await pick(player2, msg, sumOp(msg), [{ x: 19, y: 5 }, { x: 8, y: 7 }]);
  assert.deepEqual(log.confirms.map(c => c.result), [false, true]);
  assert.ok(world.notifications.slice(n0).some(n => n[1] === "DSAUTO.Summon.Picker.offMap"));
  const r = liveOp(msg, sumOp(msg).opId);
  assert.deepEqual([r.status, r.reason, r.index], ["failed", "occupied", 0], "the GM refuses the hidden Lurker's square");
  const off = await place9(player2, msg, [sq(19, 5)]);
  assert.deepEqual([off.status, off.reason], ["failed", "offMap"], "GM: offMap");
  // Hexagonal grids are refused.
  assert.equal(checkSquare({ scene: HEXES, origin: originOf(tBorin), square: sq(6, 6), size: { width: 1, height: 1 }, distance: 5, level: LEVEL }), "gridUnsupported");
  console.log("ok H54 squares: distance rules; offMap on the picker and the GM; hidden Lurker not revealed by the picker, refused by the GM; hex refused");
}

/* ======================================================================== */
/*  H55: two cards, one square                                               */
/* ======================================================================== */
{
  await fresh();
  const m1 = useCard(soe, { author: player2 });
  const m2 = useCard(soeBen, { author: player, token: tBen });
  await idle();
  const o1 = sumOp(m1);
  const o2 = sumOp(m2);
  await Promise.all([
    relayApply(player2, m1, [o1.opId], { places: { [o1.opId]: { actor: cuuid("source"), squares: [sq(9, 2)] } } }),
    relayApply(player, m2, [o2.opId], { places: { [o2.opId]: { actor: cuuid("source"), squares: [sq(9, 2)] } } }),
  ]);
  await idle();
  const st = [liveOp(m1, o1.opId), liveOp(m2, o2.opId)].map(o => `${o.status} ${o.reason ?? ""}`.trim()).sort();
  assert.deepEqual(st, ["applied", "failed occupied"], "the placement lock: one wins");
  assert.equal(summonTokensOn().length, 1);
  console.log("ok H55 two cards, one square: one applied, the other failed occupied");
}

/* ======================================================================== */
/*  H56: the card write fails after the tokens exist                         */
/* ======================================================================== */
{
  await fresh();
  const combat = newCombat([tBorin, tBen]);
  const msg = useCard(ownSoe.item, { author: player2 });
  await idle();
  const op = sumOp(msg);
  const fail = (message) => { sw.failNextUpdate = message.id; };
  Hooks.on("dsAuto.summon", fail);
  const cbs = combat.combatants.size;
  await assert.rejects(relayApply(player2, msg, [op.opId], { places: { [op.opId]: { actor: cuuid("source"), squares: [sq(10, 5)] } } }));
  Hooks.off("dsAuto.summon", fail);
  await idle(80);
  assert.equal(summonTokensOn().length, 0, "tokens removed again");
  assert.equal(combat.combatants.size, cbs, "combatant removed again");
  assert.equal(indexEntries(combat).length, 0);
  assert.equal(orphanSummons().length, 0, "no orphan");
  assert.equal(liveOp(msg, op.opId).status, "pending", "the row stays pending");
  console.log("ok H56 write failure: the summon's tokens and combatant removed again, no orphan, row still pending");
}

console.log("\nALL HARNESS-9 TESTS PASSED");
process.exit(0);
