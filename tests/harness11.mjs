// Eleventh harness (Milestone 8): the runner of docs/M8-DESIGN.md §12.1. Base mocks = harness10's (copied below: the
// world of harness.mjs with __HARNESS_SKIP_SCENARIOS__, harness9's and the M7 mocks, every client in one process
// through AsyncLocalStorage, every library overlay registered), then run(): every tests/m8/wp-*.mjs present is
// imported in name order and its default export awaited as `export default async function (ctx)` with
// ctx = {world, mocks, assert, log, sw, asUser}. Each work package owns one file and installs its own extra mocks
// (§12.1 list) before its scenarios; a missing wp-a..wp-f file is skipped with a note. Before each file: `mocks.fresh()`.
// Run one file only: `node harness11.mjs wp-c` (several names allowed). Paths from tests/paths.cjs.
// Milestone 9: tests/m9/<name>.mjs files run after the M8 ones with the same ctx (`node harness11.mjs persistent`).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
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
  // Milestone 7.
  settingsSets: [], regionCreates: [], regionDeletes: [], regionUpdates: [], placeRegion: [], uses: [], warns: [], rolls: [], actorUpdates: [],
  itemDeletes: [],
};
const sw = { failCombatantCreate: 0, failCombatantDelete: 0, dsct: false, failNextUpdate: null, dsctKeys: false, failRegionCreate: false };
/** Token pairs without line of effect ("<fromTokenId>|<toTokenId>"). */
const noLoe = new Set();
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
const camel = k => k.replace(/^data-/, "").replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
class El {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.classList = new ClassList();
    this.dataset = {};
    this.attrs = {};
    this.textContent = "";
    this.style = {};
    this.listeners = {};
    this.disabled = false;
  }
  set className(v) { this.classList = new ClassList(); this.classList.add(...String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classList.set].join(" "); }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k.startsWith("data-")) this.dataset[camel(k)] = String(v);
    if (k === "class") this.className = v;
  }
  /** Enough HTML for the reminder fallback list: every <button ...> becomes a child with its attributes. */
  set innerHTML(html) {
    this.children = [];
    for (const m of String(html).matchAll(/<button([^>]*)>/g)) {
      const b = new El("button");
      for (const a of m[1].matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)) b.setAttribute(a[1], a[2] ?? "");
      this.append(b);
    }
  }
  appendChild(k) { this.append(k); return k; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  click() {
    if (this.disabled) return false;
    const ev = { type: "click", target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} };
    for (const fn of this.listeners.click ?? []) fn(ev);
    return true;
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
  /** One simple selector: tag, .class, [attr], [attr="v"] combined (no spaces). */
  matches(simple) {
    const re = /([a-zA-Z]+)|\.([A-Za-z0-9_-]+)|\[([A-Za-z0-9_-]+)(?:="([^"]*)")?\]/g;
    for (const m of simple.matchAll(re)) {
      if (m[1] && this.tagName !== m[1].toUpperCase()) return false;
      if (m[2] && !this.classList.contains(m[2])) return false;
      if (m[3]) {
        const has = m[3] in this.attrs || (m[3].startsWith("data-") && camel(m[3]) in this.dataset);
        const val = this.attrs[m[3]] ?? (m[3].startsWith("data-") ? this.dataset[camel(m[3])] : undefined);
        if (!has || (m[4] !== undefined && val !== m[4])) return false;
      }
    }
    return true;
  }
  querySelectorAll(sel) {
    const out = new Set();
    for (const part of String(sel).split(",").map(x => x.trim()).filter(Boolean)) {
      const chain = part.split(/\s+/);
      for (const e of this.all()) {
        if (!e.matches(chain.at(-1))) continue;
        let ok = true;
        let up = e.parentNode;
        for (let i = chain.length - 2; i >= 0; i--) {
          while (up && up !== this.parentNode && !up.matches(chain[i])) up = up.parentNode;
          if (!up) { ok = false; break; }
          up = up.parentNode;
        }
        if (ok) out.add(e);
      }
    }
    return [...out];
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
    rec.kind = actions.includes("spend") ? "herotoken" : (actions.includes("template") ? "template"
      : (actions.includes("decline") ? "trigger" : (actions.includes("keep") ? "upkeep" : (actions.includes("summon") ? "choose" : "other"))));
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
const tokenDialogs = () => dialogs.filter(d => d.kind === "herotoken");
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
/** The system's actor model (takeDamage reaches the external-damage wrapper, as harness8). */
class BaseActorModel {
  async takeDamage(amount, opts = {}) {
    const actor = this.parent;
    const { immunity = 0, weakness = 0 } = this.calculateImmunityAndWeakness(opts);
    const dmg = Math.max(0, amount + weakness - immunity);
    if (!dmg) return actor;
    return actor.modifyTokenAttribute("stamina", -dmg, true, false);
  }
  calculateImmunityAndWeakness({ type, ignoredImmunities = [] } = {}) {
    const out = {};
    const imm = this.damage?.immunities ?? { all: 0 };
    const weak = this.damage?.weaknesses ?? { all: 0 };
    const w = Math.max(weak.all ?? 0, weak[type] ?? 0);
    if (w > 0) out.weakness = w;
    const ign = new Set(ignoredImmunities);
    const i = ign.has("all") ? 0 : Math.max(ign.has("all") ? 0 : (imm.all ?? 0), ign.has(type) ? 0 : (imm[type] ?? 0));
    if (i > 0) out.immunity = i;
    return out;
  }
}
/** Core's RegionBehaviorType (CL/data/region-behaviors/base.mjs): a TypeDataModel with static events. */
class RegionBehaviorType {
  static events = {};
  constructor(data = {}, { parent = null } = {}) {
    for (const [k, v] of Object.entries(data)) this[k] = Array.isArray(v) && SET_FIELDS.has(k) ? new Set(v) : v;
    this.parent = parent;
  }
}
const SET_FIELDS = new Set(["triggers", "ignoredImmunities", "exceptKeywords", "exceptMonsters"]);
/** foundry.dice.Roll with scripted totals (`rollQueue`), else the formula's maximum. */
const rollQueue = [];
class ScriptedRoll {
  constructor(formula) { this.formula = formula; this.total = null; }
  async evaluate() {
    const m = /^(\d+)d(\d+)/.exec(this.formula);
    this.total = rollQueue.length ? rollQueue.shift() : (m ? Number(m[1]) * Number(m[2]) : Number(this.formula));
    log.rolls.push({ formula: this.formula, total: this.total });
    return this;
  }
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
  // The render hooks' root is an HTMLElement (renderChatMessageHTML, v13+).
  globalThis.HTMLElement = El;
  // Milestone 7 (§7.1): the region behavior config BEFORE main.mjs loads (registerZoneBehavior runs first in init).
  CONFIG.RegionBehavior = { dataModels: {}, typeIcons: {}, typeLabels: {} };
  foundry.data.regionBehaviors = { RegionBehaviorType };
  CONST.DOCUMENT_OWNERSHIP_LEVELS = { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 };
  CONST.REGION_VISIBILITY = { LAYER: 0, GAMEMASTER: 1, ALWAYS: 2 };
  CONFIG.Token.movement = { actions: { walk: {}, forced: {}, displace: { teleport: true }, teleport: { teleport: true } } };
  CONFIG.specialStatusEffects = { DEFEATED: "dead" };
  foundry.dice = { Roll: ScriptedRoll };
  ds.data.Actor = { BaseActorModel };
  ds.CONFIG.damageTypes = { ...ds.CONFIG.damageTypes, poison: { label: "Poison" }, acid: { label: "Acid" }, cold: { label: "Cold" } };
  // The system's Apply button (DamageRoll#applyDamage): takeDamage on the clicking client (H14).
  ds.rolls.DamageRoll.prototype.applyDamage = async function (targets, { halfDamage = false } = {}) {
    const amount = halfDamage ? Math.floor(this.total / 2) : this.total;
    for (const a of targets) await a.system.takeDamage(amount, { type: this.type, ignoredImmunities: this.ignoredImmunities });
  };
  // World settings of the system (Malice, hero tokens) and the initiative mode.
  game.settings.register("draw-steel", "malice", { default: { value: 0 } });
  game.settings.register("draw-steel", "heroTokens", { default: { value: 0 } });
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
const { handleOp, requestOp, validPlaces, timeoutFor, holdWaitMs, validZonePlaces } = await imp("relay/queries.mjs");
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
// Milestone 7.
const rulesMod = await imp("resources/rules.mjs");
const gainsMod = await imp("resources/gains.mjs");
const factsMod = await imp("resources/facts.mjs");
const watchMod = await imp("resources/stamina-watch.mjs");
const gainCardMod = await imp("resources/gain-card.mjs");
const heroTokensMod = await imp("resources/hero-tokens.mjs");
const worldRes = await imp("resources/world-resources.mjs");
const maliceRem = await imp("resources/malice-reminders.mjs");
const villainMod = await imp("resources/villain.mjs");
const shapesMod = await imp("zones/shapes.mjs");
const behaviorMod = await imp("zones/behavior.mjs");
const zoneReg = await imp("zones/registry.mjs");
const zoneEngine = await imp("zones/engine.mjs");
const zoneLedger = await imp("zones/ledger.mjs");
const zoneUpkeep = await imp("zones/upkeep.mjs");
const zoneCreate = await imp("zones/create.mjs");
const placeMod = await imp("zones/place.mjs");
const gainLock = await imp("ui/gain-lock.mjs");
const maliceUI = await imp("ui/malice-reminder.mjs");
const heroDialog = await imp("ui/hero-token-dialog.mjs");
const activateMod = await imp("summons/activate.mjs");
const registryLib = await imp("library/registry.mjs");
const engineMod = await imp("engine/engine.mjs");
const { gainCardClock } = gainCardMod;
const { ZONE_END } = zoneReg;

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
// The gain observers' own clock (report wait 1.5 s, forced pushes joined over 1.2 s) runs on the same manual time.
gainCardClock.setTimeout = (fn, ms) => clock.setTimeout(fn, ms);
gainCardClock.clearTimeout = id => clock.clearTimeout(id);
game.time = { get serverTime() { return mclock.t; } };
// Settings writes keep their options (§7.1: `dsblQuiet` on undo writes); world settings fire updateSetting.
{
  const baseSet = game.settings.set.bind(game.settings);
  game.settings.set = async (mod, key, value, options = {}) => {
    log.settingsSets.push({ key: `${mod}.${key}`, value: clone(value), options: clone(options), user: game.user?.id ?? null });
    const out = await baseSet(mod, key, value);
    Hooks.callAll("updateSetting", { key: `${mod}.${key}`, value }, {}, options, game.userId);
    return out;
  };
}
const worldSet = (key, value) => game.settings.set("draw-steel", key, { value });
const malice = () => game.settings.get("draw-steel", "malice").value;
const heroTokens = () => game.settings.get("draw-steel", "heroTokens").value;
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
  /** The speaker's token actor on its scene, else the world actor (core ChatMessage.getSpeakerActor). */
  getSpeakerActor: (speaker) => {
    const tok = speaker?.scene && speaker?.token ? game.scenes.get(speaker.scene)?.tokens.get(speaker.token) : null;
    return tok?.actor ?? (speaker?.actor ? game.actors.get(speaker.actor) ?? null : null);
  },
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
/** Message#delete: gone from the collection, deleteChatMessage on every client (ours act on the active GM). */
Message.prototype.delete = async function () {
  messages.delete(this.id);
  emit("deleteChatMessage", this, {}, game.userId);
  return this;
};
/** A render of a card on `user`'s client: the renderChatMessageHTML hook with a DOM root. */
function render(message, user, root = new El("li")) {
  as(user, () => Hooks.callAll("renderChatMessageHTML", message, root, {}));
  return root;
}
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
/**
 * Actor writes go through update (updateActor with the writing user, the Stamina watch's source, §3.4): the system's
 * modifyTokenAttribute for Stamina, its dying / dead statuses (heroes: dying at 0, dead at minus winded).
 */
Actor.prototype.modifyTokenAttribute = async function (attr, value, isDelta = true, _bar = true, options = {}) {
  const s = this.system.stamina;
  if (attr === "stamina.temporary") return this.update({ "system.stamina.temporary": isDelta ? s.temporary + value : value }, options);
  let v = s.value;
  let t = s.temporary;
  if (!isDelta) v = value;
  else if (value < 0) {
    const d = -value;
    const fromTemp = Math.min(d, t);
    t -= fromTemp;
    v = Math.max(s.min ?? -100, v - (d - fromTemp));
  } else v = Math.min(s.max, v + value);
  return this.update({ "system.stamina.value": v, "system.stamina.temporary": t }, options);
};
Actor.prototype.update = async function (changes, options = {}) {
  for (const [k, v] of Object.entries(changes)) foundry.utils.setProperty(this, k, v);
  const st = this.system.stamina;
  if (this.type === "hero") {
    if (st.value <= 0) this.statuses.add("dying"); else this.statuses.delete("dying");
    if (st.value <= -(st.winded ?? Math.floor(st.max / 2))) this.statuses.add("dead"); else this.statuses.delete("dead");
  } else if (st.value <= 0) this.statuses.add("dead"); else this.statuses.delete("dead");
  emit("updateActor", this, expand(changes), options, game.userId);
  return this;
};
Actor.prototype.deleteEmbeddedDocuments = async function (_type, ids, options = {}) {
  const out = [];
  for (const id of ids) {
    const e = this.effects.get(id);
    if (!e) continue;
    this.effects.delete(id);
    for (const st of e.statuses ?? []) this.statuses.delete(st);
    emit("deleteActiveEffect", e, options, game.userId);
    out.push(e);
  }
  return out;
};
const everyone = [];
/** A feature item (class feature with a dsid; gains live on its overlay `feature:<dsid>`). */
function feature(actor, name, dsid = name.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")) {
  const iid = `ft${String(++featureN).padStart(14, "0")}`;
  const item = {
    id: iid, uuid: `${actor.uuid}.Item.${iid}`, name, type: "feature", actor, parent: actor, documentName: "Item",
    system: { _dsid: dsid }, flags: {}, effects: new Coll(),
    getFlag(scope, key) { return this.flags?.[scope]?.[key]; },
    async update(changes) {
      for (const [k, v] of Object.entries(changes)) foundry.utils.setProperty(this, k, v);
      emit("updateItem", this, expand(changes), {}, game.userId);
      return this;
    },
  };
  registry.set(item.uuid, item);
  actor.items.set(iid, item);
  return item;
}
let featureN = 0;
function mkHero(id, name, { owner = null, stamina = 30, resource = "Focus", value = 3, gain = "2", features = [], rv = 10 } = {}) {
  const a = new Actor({ uuid: `Actor.${id}`, name, type: "hero", stamina, chr: { might: 1, agility: 1, reason: 1 } });
  a.system.stamina.winded = Math.floor(stamina / 2);
  a.system.hero = { primary: { value, label: resource }, surges: 0, epic: { value: 0 }, xp: 0, victories: 0 };
  a.system.coreResource = { name: resource, path: "system.hero.primary.value", minimum: 0 };
  a.system.recoveries = { value: 2, max: 8, recoveryValue: rv };
  a.system.class = { system: { turnGain: gain } };
  a.system.restrictions = { type: new Set(), dsid: new Set() };
  // The system's model: takeDamage reaches the external-damage wrapper (H14).
  const own = a.system.calculateImmunityAndWeakness;
  delete a.system.takeDamage;
  Object.setPrototypeOf(a.system, BaseActorModel.prototype);
  a.system.calculateImmunityAndWeakness = own;
  a.system.parent = a;
  a.items = new Coll();
  a.img = `${name}.png`;
  a.getRollData = () => ({ chr: 2, level: 1, R: 1, potency: { weak: 1, average: 2, strong: 3 } });
  if (owner) a.owners.add(owner.id);
  a.home = { value, stamina };
  registry.set(a.uuid, a);
  everyone.push(a);
  for (const f of features) feature(a, ...[].concat(f));
  return a;
}
// Borin: a Fury (Ferocity; damaging / primordial ferocity added by H9), owned by Test (§7.1 "player2 = Test").
const borin = mkHero("borin00000000001", "Borin", { owner: player2, resource: "Ferocity", value: 4, gain: "1d3", features: ["Ferocity"], rv: 10 });
const benedikt = mkHero("benedikt00000001", "Benedikt", { owner: player, features: ["Focus"] });
const dorian = mkHero("dorian0000000001", "Dorian", { owner: player, resource: "Insight", value: 2, features: ["Insight"] });
const kade = mkHero("kade000000000001", "KADE", { owner: player, resource: "Wrath", value: 1, features: ["Wrath"] });
const jory = mkHero("jory000000000001", "Jorah", { owner: player, resource: "Discipline", value: 1, features: ["Discipline"] });
const elsa = mkHero("elsa000000000001", "Elsa", { owner: player, resource: "Essence", value: 1, features: ["Essence"] });
const tala = mkHero("tala000000000001", "Tala", { owner: player, resource: "Clarity", value: 0, features: [["Clarity and Strain", "clarity-and-strain"]] });
const troy = mkHero("troy000000000001", "Troy", { owner: player, resource: "Drama", value: 0, features: ["Drama"] });
// A hero without a player owner (the GM is asked for its hero tokens, H18).
const nobody = mkHero("nobody0000000001", "Nobody", { resource: "Focus", value: 0 });

/* ---------- world actors, compendium stat blocks ---------- */
const OWNER = 3;
/** An NPC's system as the system's model (takeDamage, immunities) with its damage data. */
function npcModel(actor) {
  const sys = actor.system;
  sys.stamina ??= { value: 10, max: 10, temporary: 0, min: 0 };
  sys.stamina.temporary ??= 0;
  sys.stamina.min ??= 0;
  sys.stamina.winded ??= Math.floor((Number(sys.stamina.max) || 0) / 2);
  sys.damage ??= { immunities: { all: 0 }, weaknesses: { all: 0 } };
  if (Array.isArray(sys.monster?.keywords)) sys.monster.keywords = new Set(sys.monster.keywords);
  Object.setPrototypeOf(sys, BaseActorModel.prototype);
  Object.defineProperty(sys, "parent", { value: actor, enumerable: false, configurable: true, writable: true });
}
function npcStatuses(actor) {
  if (actor.system?.stamina?.value <= 0) actor.statuses.add("dead");
  else actor.statuses.delete("dead");
}
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
    npcModel(this);
    this.items = new Coll();
    this.statuses = new Set();
    this.effects = new Coll();
    this.isToken = false;
  }
  get appliedEffects() { return this.effects.contents; }
  modifyTokenAttribute(attr, value, isDelta, bar, options) { return Actor.prototype.modifyTokenAttribute.call(this, attr, value, isDelta, bar, options); }
  async createEmbeddedDocuments(type, data, options) { return Actor.prototype.createEmbeddedDocuments.call(this, type, data, options); }
  async deleteEmbeddedDocuments(type, ids, options) { return Actor.prototype.deleteEmbeddedDocuments.call(this, type, ids, options); }

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
  getRollData() { return { R: 1, potency: { weak: 1, average: 2, strong: 3 } }; }
  getActiveTokens(_linked = false, document = false) {
    const docs = game.scenes.contents.flatMap(sc => sc.tokens.filter(t => t.actorLink && t.actorId === this.id));
    return docs.map(t => (document ? t : t.object));
  }
  async update(changes, options = {}) {
    for (const [k, v] of Object.entries(changes)) {
      if (k === "ownership") Object.assign(this.ownership, v);
      else foundry.utils.setProperty(this, k, v);
    }
    npcStatuses(this);
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
      stamina: { value: Number.isFinite(carried) ? carried : max, max, temporary: 0, min: 0, winded: Math.floor(max / 2) },
    };
    if (base.system?.monster?.keywords) this.system.monster = { ...clone(base.system.monster), keywords: new Set(base.system.monster.keywords) };
    npcModel(this);
    if (!token.preview) registry.set(this.uuid, this);
  }
  get appliedEffects() { return this.effects.contents; }
  modifyTokenAttribute(attr, value, isDelta, bar, options) { return Actor.prototype.modifyTokenAttribute.call(this, attr, value, isDelta, bar, options); }
  async createEmbeddedDocuments(type, data, options) { return Actor.prototype.createEmbeddedDocuments.call(this, type, data, options); }
  async deleteEmbeddedDocuments(type, ids, options) { return Actor.prototype.deleteEmbeddedDocuments.call(this, type, ids, options); }
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
    npcStatuses(this);
    emit("updateActor", this, expand(changes), options, game.userId);
    return this;
  }
}
/** game.actors: per-client view (P1 negative: a world actor this client does not hold), spies on lookups. */
const hiddenActors = new Map();   // userId -> Set(actorId)
const hiddenFor = id => hiddenActors.get(game.user?.id)?.has(id) ?? false;
class ActorsColl extends Coll {
  /** The system's world-setting models (DSM:3873-3885): `game.actors.heroTokens.value` / `.malice.value`. */
  get heroTokens() { return { get value() { return game.settings.get("draw-steel", "heroTokens").value; } }; }
  get malice() { return { get value() { return game.settings.get("draw-steel", "malice").value; } }; }
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
    return {
      id: doc.id, document: doc, get actor() { return doc.actor; }, scene: doc.parent, get center() { return { x: doc.x + G / 2, y: doc.y + G / 2 }; },
      /** Combat Tools' line of effect (eligibility.lineOfEffect): blocked pairs from `noLoe`. */
      hasLineOfEffect: other => !noLoe.has(`${doc.id}|${other?.document?.id ?? other?.id}`),
    };
  }
  /** Core: the token's footprint centres tested against the region (TokenDocument#testInsideRegion). */
  testInsideRegion(region, position = null) {
    const p = position ?? this._source;
    for (let r = 0; r < Math.max(1, Math.round(this.height)); r++) {
      for (let c = 0; c < Math.max(1, Math.round(this.width)); c++) {
        if (region.testPoint({ x: p.x + (c + 0.5) * G, y: p.y + (r + 0.5) * G, elevation: p.elevation ?? 0 })) return true;
      }
    }
    return false;
  }
  get regions() { return new Set((this.parent?.regions?.contents ?? []).filter(r => this.testInsideRegion(r))); }
  /** Core's square-grid footprint offsets (no wall test here). */
  getOccupiedGridSpaceOffsets(p = this._source) {
    const out = [];
    for (let r = 0; r < Math.max(1, Math.round(this.height)); r++) for (let c = 0; c < Math.max(1, Math.round(this.width)); c++) out.push({ i: Math.floor(p.y / G) + r, j: Math.floor(p.x / G) + c });
    return out;
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
/** A region behavior document: its system is the registered data model (ours: ZoneRegionBehaviorType). */
class BehaviorDoc {
  constructor(d, region) {
    this.id = d._id ?? foundry.utils.randomID();
    this.type = d.type;
    this.name = d.name ?? "";
    this.disabled = !!d.disabled;
    this.parent = region;
    const Model = CONFIG.RegionBehavior.dataModels[d.type] ?? RegionBehaviorType;
    this.system = new Model(clone(d.system ?? {}), { parent: this });
  }
  get region() { return this.parent; }
  get documentName() { return "RegionBehavior"; }
  get uuid() { return `${this.parent.uuid}.RegionBehavior.${this.id}`; }
}
/** A region (core RegionDocument): shapes, behaviors, flags; testPoint through the shape geometry. */
class RegionDoc {
  constructor(d, scene) {
    const data = clone(d);
    this.id = data._id ?? foundry.utils.randomID();
    this.parent = scene;
    this.name = data.name ?? "Region";
    this.shapes = data.shapes ?? [];
    this.flags = data.flags ?? {};
    this.ownership = data.ownership ?? { default: 0 };
    this.hidden = !!data.hidden;
    this.levels = new Set(data.levels ?? []);
    this._source = { levels: [...(data.levels ?? [])] };
    this.elevation = data.elevation ?? { bottom: null, top: null };
    this.restriction = data.restriction ?? null;
    this.attachment = data.attachment ?? null;
    this.data = data;
    this._stats = { createdTime: data._stats?.createdTime ?? mclock.t };
    this.behaviors = new Coll();
    for (const b of data.behaviors ?? []) {
      const doc = new BehaviorDoc(b, this);
      this.behaviors.set(doc.id, doc);
    }
  }
  get documentName() { return "Region"; }
  get uuid() { return `${this.parent.uuid}.Region.${this.id}`; }
  getFlag(scope, key) { return this.flags?.[scope]?.[key]; }
  includedInLevel(level) { return !this.levels.size || this.levels.has(level?.id ?? level); }
  /** The region's own polygon test (core RegionDocument#testPoint): our shape geometry on a copy without testPoint. */
  testPoint(point) { return shapesMod.regionHasPoint({ shapes: this.shapes, parent: this.parent }, point); }
  get polygonTree() { return { testPoint: p => this.testPoint(p) }; }
  async update(changes, options = {}) {
    const exp = {};
    for (const [k, v] of Object.entries(changes)) foundry.utils.setProperty(exp, k, v);
    mergeInto(this, exp);
    log.regionUpdates.push({ id: this.id, changes: clone(changes) });
    emit("updateRegion", this, exp, options, game.userId);
    return this;
  }
  async delete(options = {}) { return this.parent.deleteEmbeddedDocuments("Region", [this.id], options); }
}
class Scene9 {
  constructor(id, name, { type = 1, width = 2000, height = 2000 } = {}) {
    this.id = id;
    this.name = name;
    this.uuid = `Scene.${id}`;
    this.grid = {
      // Draw Steel scenes: grid distance 1 (a square is one unit).
      size: G, distance: 1, type, sizeX: G, sizeY: G,
      // Core square grid: i = row, j = column.
      getOffset: ({ x, y }) => ({ i: Math.floor(y / G), j: Math.floor(x / G) }),
      getTopLeftPoint: ({ i, j }) => ({ x: j * G, y: i * G }),
      getCenterPoint: ({ i, j }) => ({ x: (j + 0.5) * G, y: (i + 0.5) * G }),
      /** Core SquareGrid#getDirectPath: the offsets a straight line between the waypoints' centres passes. */
      getDirectPath: (waypoints) => {
        const cell = w => ({ i: Math.floor(w.y / G), j: Math.floor(w.x / G) });
        const out = [cell(waypoints[0])];
        for (let k = 1; k < waypoints.length; k++) {
          const a = cell(waypoints[k - 1]);
          const b = cell(waypoints[k]);
          const n = Math.max(Math.abs(b.i - a.i), Math.abs(b.j - a.j));
          for (let t = 1; t <= n; t++) out.push({ i: a.i + Math.round(((b.i - a.i) * t) / n), j: a.j + Math.round(((b.j - a.j) * t) / n) });
        }
        return out;
      },
    };
    this.dimensions = { sceneRect: { x: 0, y: 0, width, height }, distancePixels: G, size: G, width, height };
    this.regions = new Coll();
    this.levels = new Coll([[LEVEL, { id: LEVEL, name: "Ground" }]]);
    this.initialLevel = LEVEL;
    this.tokens = new Coll();
    this.flags = {};
  }
  get documentName() { return "Scene"; }
  async createEmbeddedDocuments(type, data, options = {}) {
    if (type === "Region") {
      coreOp(options, this);
      if (sw.failRegionCreate) {
        sw.failRegionCreate = false;
        throw new Error("region create refused");
      }
      const out = data.map(d => new RegionDoc(d, this));
      out.forEach((r, i) => {
        this.regions.set(r.id, r);
        registry.set(r.uuid, r);
        log.regionCreates.push({ id: r.id, name: r.name, data: clone(data[i]), options: clone(options), user: game.user?.id ?? null });
      });
      for (const r of out) emit("createRegion", r, options, game.userId);
      return out;
    }
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
    if (type === "Region") {
      coreOp(options, this);
      const out = [];
      for (const id of ids) {
        const r = this.regions.get(id);
        if (!r) throw new Error(`Region ${id} does not exist`);
        this.regions.delete(id);
        registry.delete(r.uuid);
        log.regionDeletes.push({ id, name: r.name, options: clone(options), user: game.user?.id ?? null });
        out.push(r);
      }
      for (const r of out) emit("deleteRegion", r, options, game.userId);
      return out;
    }
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
/** Region clicks for a client's placeRegion: pixel points {x, y, rotation?}, "skip" (right-click), "esc". */
const regionQ = new Map();
function regionClicks(user, ...items) {
  if (!regionQ.has(user.id)) regionQ.set(user.id, []);
  regionQ.get(user.id).push(...items);
}
async function nextRegionClick(userId) {
  const end = Date.now() + 3000;
  for (;;) {
    const q = regionQ.get(userId);
    if (q?.length) return q.shift();
    if (Date.now() > end) {
      log.pickTimeouts++;
      return "esc";
    }
    await settle(5);
  }
}
/** The centre of grid square (gx, gy) in pixels (a wall square's anchor), or its top-left with `corner`. */
const cell = (gx, gy, { corner = false, rotation } = {}) => ({ x: (gx + (corner ? 0 : 0.5)) * G, y: (gy + (corner ? 0 : 0.5)) * G, ...(rotation === undefined ? {} : { rotation }) });
globalThis.canvas = {
  ready: true,
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
  regions: {
    /**
     * Core placeRegion (CL/canvas/layers/regions.mjs:690-725, 1100-1130) driven by the region click queue: each shape in
     * turn; preConfirm NOT awaited, with {event, document, regionIndex, regionCount, shape, shapeIndex, shapeCount}
     * and `document.shapes` ending with the shape being confirmed; right click skips a shape, Escape resolves null.
     * create: false returns the unsaved document.
     */
    async placeRegion(data, { create = true, allowRotation = false, preConfirm = null } = {}) {
      const user = game.user;
      const scene = canvas.scene;
      log.placeRegion.push({ user: user.id, shapes: data.shapes?.length ?? 0, create, allowRotation, levels: [...(data.levels ?? [])], scene: scene.id });
      const confirmed = [];
      const n = data.shapes?.length ?? 0;
      for (let idx = 0; idx < n;) {
        const click = await nextRegionClick(user.id);
        if (click === "esc") return null;
        if (click === "skip") {
          idx++;
          continue;
        }
        const shape = { ...clone(data.shapes[idx]), x: click.x, y: click.y, ...(allowRotation && click.rotation !== undefined ? { rotation: click.rotation } : {}) };
        const document = { shapes: [...confirmed, shape], levels: new Set(data.levels ?? []), _source: { levels: [...(data.levels ?? [])] } };
        const r = preConfirm?.({ event: {}, document, regionIndex: 0, regionCount: 1, shape, shapeIndex: idx, shapeCount: n });
        log.confirms.push({ user: user.id, x: click.x, y: click.y, result: r });
        if (r === false) continue;
        confirmed.push(shape);
        idx++;
      }
      if (!confirmed.length) return null;
      const doc = { ...clone({ ...data, shapes: confirmed }), levels: new Set(data.levels ?? []), _source: { levels: [...(data.levels ?? [])] } };
      if (!create) return doc;
      return (await scene.createEmbeddedDocuments("Region", [{ ...data, shapes: confirmed }]))[0];
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
  get uuid() { return `${this.parent.uuid}.Combatant.${this.id}`; }
  get combat() { return this.parent; }
  get token() { return game.scenes.get(this.sceneId)?.tokens.get(this.tokenId) ?? null; }
  get actor() { return this.token?.actor ?? null; }
  get name() { return this.token?.name ?? this.actor?.name ?? "?"; }
  get group() { return this._source.group ? (this.parent.groups.get(this._source.group) ?? null) : null; }
  get isDefeated() { return this.defeated || !!this.actor?.statuses?.has?.("dead"); }
  getFlag(scope, key) { return this.flags?.[scope]?.[key]; }
  async update(changes, options = {}) {
    // Core's preUpdate hook on the calling client: false vetoes the update (summons/activate.mjs).
    if (Hooks.call("preUpdateCombatant", this, changes, options, game.userId) === false) return this;
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
      /** SquadModel#takeDamage (DSM:15130-15160): immunity / weakness once, the area cap per minion, one pool write. */
      async takeDamage(minions, per, opts = {}) {
        let imm = 0;
        let weak = 0;
        for (const m of minions) {
          const r = m.system.calculateImmunityAndWeakness(opts);
          imm = Math.max(imm, r.immunity ?? 0);
          weak = Math.max(weak, r.weakness ?? 0);
        }
        if (opts.aoe) per = Math.min(per, Number(minions[0].system.stamina.max) || per);
        const dmg = Math.max(0, per * minions.length + weak - imm);
        if (dmg) await group.update({ "system.staminaValue": group.system.staminaValue - dmg }, {});
        return group;
      },
    };
  }
  get uuid() { return `${this.parent.uuid}.CombatantGroup.${this.id}`; }
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
    emit("updateCombatantGroup", this, expand(clone(changes)), options, game.userId);
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
  get uuid() { return `Combat.${this.id}`; }
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
    if (Hooks.call("preUpdateCombat", this, changes, options, game.userId) === false) return this;
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
        registry.set(g.uuid, g);
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
  // The system's AbilityModel#use (its dialog and spend): recorded (H22's reminder buttons).
  item.system.use = async (opts = {}) => { log.uses.push({ item: item.name, user: game.user?.id ?? null, opts: Object.keys(opts) }); return null; };
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

/* ---------- the Milestone 7 world (docs/M7-DESIGN.md §7.2 S1-S3 in miniature) ---------- */
/** A damage ability of an actor: a damage PRE and the tier rolls of `hit` (no library overlay needed). */
function attack(actor, name, opts = {}) {
  const item = ability(actor, name, { type: "main", distance: { type: "melee", primary: 1 }, target: { type: "creature" }, powerRoll: true, ...opts });
  item.system.power.effects.set("dmgPRE0000000001", { id: "dmgPRE0000000001", type: "damage", name: "Damage" });
  item.system.keywords = new Set(opts.keywords ?? ["strike", "melee", "weapon"]);
  return item;
}
const MPACK = "Compendium.draw-steel.monsters.Actor.";
const DTPACK = "Compendium.draw-steel-delian-tomb.monsters.Actor.";
/** A monster world actor with keywords and its abilities ({name, ...ability opts} or a damage attack name). */
function npc(name, source, { stamina = 15, keywords = ["goblin", "humanoid"], minion = false, turns = 1, abilities = [] } = {}) {
  const base = new WorldActor({
    name, type: "npc", _stats: { compendiumSource: source }, ownership: { default: 0 },
    system: {
      stamina: { value: stamina, max: stamina, temporary: 0, min: 0 }, isMinion: minion, combat: { turns },
      monster: { keywords: [...keywords] }, damage: { immunities: { all: 0 }, weaknesses: { all: 0 } },
    },
  });
  game.actors.set(base.id, base);
  registry.set(base.uuid, base);
  for (const a of abilities) {
    if (typeof a === "string") attack(base, a);
    else if (a.attack) attack(base, a.name, a);
    else ability(base, a.name, a);
  }
  return base;
}
/** A token of a monster (unlinked: its synthetic actor gets copies of the base actor's items, same ids). */
function npcToken(base, label, gx, gy, { linked = false, disposition = -1, size = 1, hidden = false } = {}) {
  const tok = place(START, base, label, gx, gy, { linked, disposition, hidden });
  tok._source.width = size;
  tok._source.height = size;
  tok.home.size = size;
  if (!linked) {
    for (const it of base.items.values()) {
      const copy = it.type === "ability" && it.system.power.effects.has("dmgPRE0000000001")
        ? attack(tok.actor, it.name, { id: it.id, dsid: it.system._dsid, type: it.system.type, distance: it.system.distance, resource: it.system.resource, keywords: [...it.system.keywords] })
        : ability(tok.actor, it.name, { id: it.id, dsid: it.system._dsid, type: it.system.type, distance: it.system.distance, target: it.system.target, resource: it.system.resource });
      copy.system.category = it.system.category;
      tok.actor.items.set(copy.id, copy);
    }
  }
  return tok;
}
// Heroes on Start (heroes linked; Borin at (5,5) as T104's creator).
const tBorin = place(START, borin, "Borin", 5, 5, { disposition: 1 });
const tBen = place(START, benedikt, "Benedikt", 6, 5, { disposition: 1 });
const tDorian = place(START, dorian, "Dorian", 5, 2, { disposition: 1 });
const tKade = place(START, kade, "KADE", 4, 5, { disposition: 1 });
const tJory = place(START, jory, "Jorah", 4, 6, { disposition: 1 });
const tElsa = place(START, elsa, "Elsa", 3, 3, { disposition: 1 });
const tTala = place(START, tala, "Tala", 2, 2, { disposition: 1 });
const tTroy = place(START, troy, "Troy", 2, 3, { disposition: 1 });
const tNobody = place(START, nobody, "Nobody", 1, 1, { disposition: 1 });
// Heroes' abilities.
const borinStrike = attack(borin, "Brutal Slam");
const wallOfFire = ability(borin, "Wall of Fire", { dsid: "wall-of-fire", distance: { type: "wall", primary: 5, secondary: 10 }, target: { type: "special" }, resource: 0 });
wallOfFire.system.keywords = new Set(["area", "magic"]);
const incinerate = ability(tala, "Incinerate", { dsid: "incinerate", distance: { type: "cube", primary: 1, secondary: 10 }, target: { type: "special" } });
const battleCry = attack(borin, "Battle Cry", { dsid: "battle-cry", target: { type: "ally" }, distance: { type: "ranged", primary: 10 } });
battleCry.system.power.effects.delete("dmgPRE0000000001");
battleCry.system.power.effects.set("resPRE0000000001", {
  id: "resPRE0000000001", type: "resource", name: "Gain surges",
  resource: { tier1: { amount: 1, type: "surge" }, tier2: { amount: 2, type: "surge" }, tier3: { amount: 3, type: "surge" } },
});
const kadeStrike = attack(kade, "Censure");
const judgement = ability(kade, "Judgement", { dsid: "judgement", type: "maneuver", target: { type: "creature" } });
const benStrike = attack(benedikt, "Hammer Blow");
const benHeroic = ability(benedikt, "Squad Hit and Run", { dsid: "squad-hit-and-run" });
const mark = ability(benedikt, "Mark", { dsid: "mark", type: "maneuver", target: { type: "creature" } });
const dorianStrike = attack(dorian, "Gasping Cut");
const elsaBolt = attack(elsa, "Fire Bolt", { distance: { type: "ranged", primary: 10 } });
const nullField = ability(jory, "Null Field", { dsid: "null-field", distance: { type: "aura", primary: 2 } });
const troyRoll = attack(troy, "Riposte");
const talaPush = attack(tala, "Kinetic Grip");
// Monsters (unlinked tokens as core drops them; §7.2 S3).
const warrior = npc("Goblin Warrior", `${MPACK}6SR8siFeC5lWUzoO`, { stamina: 15, abilities: ["Spear Charge"] });
const assassin = npc("Goblin Assassin", `${MPACK}6bpHvy0N4rObJBZq`, { stamina: 15, abilities: ["Sword Stab"] });
const stabby = npc("Goblin Assassin", `${MPACK}6bpHvy0N4rObJBZq`, { stamina: 15, abilities: ["Sword Stab"] });
const stinker = npc("Goblin Stinker", `${MPACK}CWcc0FNUfUaiYyH7`, {
  stamina: 10, abilities: [{ name: "Swamp Gas", type: "maneuver", distance: { type: "cube", primary: 3, secondary: 10 }, resource: 0 }],
});
const spine = npc("Goblin Spinecleaver", `${MPACK}Mdk2jvvw26BaR1HL`, { stamina: 5, minion: true, abilities: ["Cleave"] });
const monarchA = npc("Goblin Monarch", `${MPACK}Vxxc0EcLHPPnpSbK`, {
  stamina: 40, abilities: [{ name: "Get in Here!", type: "maneuver", distance: { type: "ranged", primary: 20 }, resource: 1 },
    { name: "Goblin Malice Features", type: "none", resource: 0 }, { name: "Goblin Mode", type: "none", resource: 3 },
    { name: "Swarm", type: "none", resource: 5 }, { name: "Get Reckless", type: "maneuver", resource: 2 }],
});
const arixx = npc("Arixx", `${MPACK}3B9NyJN29f9wjIpa`, {
  stamina: 60, keywords: ["beast"], turns: 2,
  abilities: [{ name: "Acid Spew", type: "villain", distance: { type: "cube", primary: 2, secondary: 5 } }, "Bite"],
});
const cornelia = npc("Dame Cornelia", `${DTPACK}K2ehwwXOEhx1vEOL`, {
  stamina: 80, keywords: ["human"], abilities: [{ name: "Parry!", type: "triggered", target: { type: "self" } },
    { name: "Rally the Line", type: "villain" }, "Longsword"],
});
const bargnot = npc("Mystic Queen Bargnot", `${DTPACK}tuCthtMZUysJwBe6`, {
  stamina: 70, abilities: [{ name: "Oversurge", type: "villain", target: { type: "self" } }],
});
const toxin = npc("Goblin Toxinaut", `${DTPACK}zbIGbGA0OblJ0zsV`, {
  stamina: 20, abilities: [{ name: "Swamp Gas", dsid: "swamp-gas-dt", type: "maneuver", distance: { type: "cube", primary: 3, secondary: 10 } }],
});
const mastermind = npc("Goblin Mastermind", `${DTPACK}1rgM4rU61L172gz8`, { stamina: 20 });
cornelia.items.find(i => i.name === "Parry!").system._dsid = "parry";
const tWarrior = npcToken(warrior, "Goblin Warrior", 9, 5);
const tAssassin = npcToken(assassin, "Goblin Assassin", 9, 7);
const tStabby = npcToken(stabby, "Stabby", 9, 8, { linked: true });
const tStinker = npcToken(stinker, "Goblin Stinker", 12, 12);
const tSpine1 = npcToken(spine, "Goblin Spinecleaver", 14, 3);
const tSpine2 = npcToken(spine, "Goblin Spinecleaver (2)", 15, 3);
const tSpine3 = npcToken(spine, "Goblin Spinecleaver (3)", 16, 3);
const tMonarch = npcToken(monarchA, "Goblin Monarch", 14, 9);
const tArixx = npcToken(arixx, "Arixx", 16, 12, { size: 2 });
const tCornelia = npcToken(cornelia, "Dame Cornelia", 18, 5);
const tBargnot = npcToken(bargnot, "Mystic Queen Bargnot", 18, 8, { linked: true });
const tToxin = npcToken(toxin, "Goblin Toxinaut", 17, 16);
const tMastermind = npcToken(mastermind, "Goblin Mastermind", 13, 16);
const tBigGob = npcToken(warrior, "Goblin Brute", 8, 12, { size: 2 });
const itemOn = (tok, name) => tok.actor.items.find(i => i.name === name);
const heroTokensOf = [tBorin, tBen, tDorian, tKade, tJory, tElsa, tTala, tTroy, tNobody];
// Every actor write with its options (dsblQuiet on undo writes, §3.3).
Hooks.on("updateActor", (a, changes, options, userId) => {
  if (game.users.activeGM?.isSelf) log.actorUpdates.push({ name: a.name, changes: clone(changes), options: clone(options ?? {}), userId });
});
/** Delete an item (deleteItem on every client: the rule cache drops). */
async function deleteItem(item) {
  item.actor.items.delete(item.id);
  registry.delete(item.uuid);
  log.itemDeletes.push(item.name);
  emit("deleteItem", item, {}, game.userId);
}
/** Add a feature (createItem on every client). */
function addFeature(actor, name, dsid) {
  const item = feature(actor, name, dsid);
  emit("createItem", item, {}, game.userId);
  return item;
}

/* ---------- library: every overlay of the library (wave 1-4) ---------- */
function overlayFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}${e.name}`;
    if (e.isDirectory()) out.push(...overlayFiles(`${p}/`));
    else if (e.name.endsWith(".json")) out.push(p);
  }
  return out;
}
const OVERLAY_FILES = overlayFiles(LIBRARY);
const ALL_OVERLAYS = OVERLAY_FILES.map(f => JSON.parse(readFileSync(f, "utf8")));
const M7_FILES = ["fury/ferocity.json", "censor/wrath.json", "elementalist/essence.json", "null/discipline.json", "shadow/insight.json",
  "tactician/focus.json", "talent/clarity-and-strain.json", "troubadour/drama.json", "elementalist/wall-of-fire.json", "talent/incinerate.json",
  "conduit/righteous-phalanx.json", "monsters/swamp-gas.json", "monsters/swamp-gas-dt.json", "monsters/acid-spew.json", "monsters/oversurge.json",
  "monsters/sword-stab.json", "monsters/shadow-stab.json", "null/dance-of-blows.json", "null/impart-force.json", "origins/glowing-eyes.json",
  "talent/choke.json"];
// Test-only overlays: upgrade features, an untargeted single-tier card, a confirm rule, an aura zone, a manual zone.
const TEST_OVERLAYS = [
  { key: "ability:test-aura", version: "1.0.0", name: "Test Aura", effects: [{ id: "aura", type: "zone", targets: "self", label: "Test aura", shape: "aura", size: 1, zoneEvents: ["enter", "turnStart"], value: 3, affects: "enemies", lasts: ["encounterEnd"] }] },
  { key: "ability:test-moat", version: "1.0.0", name: "Test Moat", effects: [{ id: "moat", type: "zone", targets: "self", label: "Moat", shape: "cube", size: 2, range: 10, zoneEvents: ["enter", "turnStart"], value: 2, affects: "all", lasts: ["manual"] }] },
];
const LIB_SOURCE = { id: "stef-ds-automation.library", priority: 50, overlays: [...ALL_OVERLAYS, ...TEST_OVERLAYS] };
const aura = ability(borin, "Test Aura", { dsid: "test-aura", distance: { type: "aura", primary: 1 } });
const moat = ability(benedikt, "Test Moat", { dsid: "test-moat", distance: { type: "cube", primary: 2, secondary: 10 } });

/* ---------- cards ---------- */
/**
 * An ability card of `item` (its actor's token speaks) by `author`: tier `tier` against `targets` with a damage roll of
 * `amount` (`type`), natural roll `natural`; no damage roll when `amount` is null.
 */
function useCard(item, { author = gm, targets = [], token = null, tier = 2, amount = null, type = "", natural = null, extraRolls = [] } = {}) {
  const tok = token ?? item.actor.token ?? item.actor.getActiveTokens?.(false, true)?.[0] ?? null;
  setUser(author);
  author.targets = new Set(targets.map(t => t.object));
  const parts = { abilityUse000000: { _id: "abilityUse000000", type: "abilityUse", abilityUuid: item.uuid } };
  const PowerRoll = ds.rolls.PowerRoll;
  const DamageRoll = ds.rolls.DamageRoll;
  if (targets.length || amount != null || natural != null) {
    const rolls = targets.map(t => {
      const r = new PowerRoll(10, { target: t.actor.uuid, tier });
      if (natural != null) r.naturalResult = natural;
      return r;
    });
    if (!targets.length && natural != null) {
      const r = new PowerRoll(10, { tier });
      r.naturalResult = natural;
      rolls.push(r);
    }
    if (amount != null) rolls.push(new DamageRoll(amount, { type }));
    rolls.push(...extraRolls);
    parts.tierResult000001 = { _id: "tierResult000001", type: "abilityResult", tier, rolls };
  }
  const msg = new Message({ type: "standard", parts, speaker: { scene: tok?.parent?.id ?? null, token: tok?.id ?? null, actor: item.actor?.id ?? null } });
  Hooks.call("preCreateChatMessage", msg, {}, {}, author.id);
  msg.isAuthor = true;
  msg.author = author;
  msg._source.author = author.id;
  messages.set(msg.id, msg);
  setUser(gm);
  author.targets = new Set();
  Hooks.callAll("createChatMessage", msg, {}, author.id);
  return msg;
}
/** A hit: `attacker`'s attack item on `targets` for `amount` (the card resolves and auto-applies). */
async function hit(item, targets, amount, opts = {}) {
  const msg = useCard(item, { targets: [].concat(targets), amount, ...opts });
  await idle();
  await settleAll();
  return messages.get(msg.id) ?? msg;
}
const opsOf = msg => Object.values(getResolution(messages.get(msg?.id ?? msg) ?? msg)?.ops ?? {});
const gainOps = msg => opsOf(msg).filter(o => o.kind === "gain").sort((a, b) => a.order - b.order);
const zoneOp = msg => opsOf(msg).find(o => o.kind === "zone") ?? null;
const dmgOps = msg => opsOf(msg).filter(o => o.kind === "damage");
const liveOp = (msg, opId) => getResolution(messages.get(msg.id) ?? msg)?.ops?.[opId] ?? null;
/** Every chain of ours idle: lifecycle, summons, zones, resource chains, gains, villains. */
async function settleAll(ms = 30) {
  for (let i = 0; i < 3; i++) {
    await settle(ms);
    await lifecycleIdle();
    await withSummonChain(() => null);
    await zoneReg.withZoneChain(() => null);
    await Promise.all(worldRes.busyResourceChains().map(k => worldRes.withResourceChain(k, () => null)));
  }
}
/** Messages created since a mark (cards whose record carries `key`). */
const markMsgs = () => messages.size;
const since = (n, pred = () => true) => [...messages.values()].slice(n).filter(pred);
const gainCards = n => since(n, m => !!getResolution(m)?.gain);
const zoneCards = n => since(n, m => !!getResolution(m)?.zone);
const maliceCards = n => since(n, m => !!getResolution(m)?.malice);
const ferocity = () => borin.system.hero.primary.value;
const viewRow = (msg, opId, user = gm) => as(user, () => buildView(messages.get(msg.id) ?? msg, getResolution(messages.get(msg.id) ?? msg)).rows.flatMap(r => r.ops).find(o => o.opId === opId) ?? null);
const viewOf10 = (msg, user = gm) => as(user, () => buildView(messages.get(msg.id) ?? msg, getResolution(messages.get(msg.id) ?? msg)));

/* ---------- token movement and region events (core v14) ---------- */
let moveN = 0;
const ALL_CLIENTS = () => [gm, gm2, player, player2];
/** Dispatch a region event to every behavior on every client (the behaviors' static handlers; ours act on the active GM). */
function regionEvent(region, name, data, user) {
  for (const client of ALL_CLIENTS()) {
    as(client, () => {
      for (const b of region.behaviors.values()) {
        if (b.disabled) continue;
        const cls = CONFIG.RegionBehavior.dataModels[b.type];
        const fn = cls?.events?.[name];
        if (typeof fn === "function") fn.call(b.system, { name, data, region, user });
      }
    });
  }
}
/**
 * Move a token through grid squares (top-left cells) as one movement made of `segments` (each a list of cells; core
 * splits a ruler drag into continued segments sharing the movement id, `pending` holding the rest). Each segment is
 * one token update: region events (in / within / out by the footprint before, along and after), then `moveToken`.
 * `action`: "walk" | "forced" | "teleport".
 */
async function moveTokenPath(tokenDoc, segments, { action = "walk", user = gm, id = null } = {}) {
  const movementId = id ?? `mv${String(++moveN).padStart(14, "0")}`;
  const wp = ([gx, gy]) => ({ x: gx * G, y: gy * G, elevation: 0, width: tokenDoc.width, height: tokenDoc.height, level: tokenDoc.level, action });
  for (let k = 0; k < segments.length; k++) {
    const origin = { x: tokenDoc.x, y: tokenDoc.y, elevation: 0, width: tokenDoc.width, height: tokenDoc.height, level: tokenDoc.level, action };
    const passed = segments[k].map(wp);
    const pending = segments.slice(k + 1).flat().map(wp);
    const movement = { id: movementId, origin, passed: { waypoints: passed }, pending: { waypoints: pending }, user };
    const regionsBefore = new Map(START.regions.contents.map(r => [r.id, tokenDoc.testInsideRegion(r)]));
    const last = passed.at(-1);
    await as(user, () => tokenDoc.update({ x: last.x, y: last.y }, { movement: { [tokenDoc.id]: movement } }));
    for (const r of [...tokenDoc.parent.regions.values()]) {
      const was = regionsBefore.get(r.id) ?? false;
      const now = tokenDoc.testInsideRegion(r);
      const along = passed.some(p => tokenDoc.testInsideRegion(r, p));
      const data = { token: tokenDoc, movement };
      if (!was && (now || along)) regionEvent(r, "tokenMoveIn", data, user);
      if (was && now) regionEvent(r, "tokenMoveWithin", data, user);
      if ((was || along) && !now) regionEvent(r, "tokenMoveOut", data, user);
    }
    emit("moveToken", tokenDoc, movement, {}, user.id);
    await settle(5);
  }
}
/** A straight walk from where the token stands to (gx, gy) as one segment: every square on the way. */
function lineCells(tokenDoc, gx, gy) {
  const a = { i: Math.floor(tokenDoc.y / G), j: Math.floor(tokenDoc.x / G) };
  const n = Math.max(Math.abs(gy - a.i), Math.abs(gx - a.j));
  const out = [];
  for (let t = 1; t <= n; t++) out.push([a.j + Math.round(((gx - a.j) * t) / n), a.i + Math.round(((gy - a.i) * t) / n)]);
  return out;
}
/** Combat Tools' push: one complete one-square movement per update (`forced`), `gapMs` of server time between. */
async function pushCells(tokenDoc, cells, { gapMs = 400, user = gm } = {}) {
  for (const c of cells) {
    await moveTokenPath(tokenDoc, [[c]], { action: "forced", user });
    await advance(gapMs);
  }
}
/** Run with a guard (deadlock check). */
async function within(ms, p, what) {
  let timer;
  const out = await Promise.race([p.then(v => ({ v })), new Promise(r => { timer = setTimeout(() => r(null), ms); })]);
  clearTimeout(timer);
  assert.ok(out, `${what}: finished within ${ms} ms`);
  return out.v;
}

/* ---------- per-scenario reset ---------- */
const SETTINGS = {
  enabled: true, damageMode: "auto", healingMode: "auto", conditionsMode: "auto", resourceMode: "auto", cardActionRole: 4,
  // Triggers off unless a scenario needs them (Cornelia's Parry! would hold every goblin hit on the scene).
  triggersEnabled: false, triggerPromptSeconds: 20, triggerFallback: "director", triggerNpcs: true, deferToTriggersModule: true,
  triggerExternalDamage: true, summonMode: "auto", summonPlacement: "pick", summonTurnChain: true, summonUpkeepSeconds: 30,
  resourceGains: "auto", heroTokenPrompt: true, maliceReminders: true, villainActionTracking: true, zoneMode: "auto", zoneDamage: "auto",
  libraryDefersToCombatTools: true, respectDstdApplications: true,
};
async function fresh({ tokens = 0, maliceValue = 0 } = {}) {
  await settleAll(10);
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
  for (const id of ["draw-steel-target-damage", "draw-steel-resources-ui", "draw-steel-triggers", "draw-steel-delian-tomb"]) game.modules.delete(id);
  game.combats.isDefaultInitiativeMode = true;
  sw.failCombatantCreate = 0;
  sw.failCombatantDelete = 0;
  sw.failNextUpdate = null;
  sw.dsctKeys = false;
  sw.failRegionCreate = false;
  dsctTurnStarted.clear();
  for (const d of dialogs) if (!d.closed) d.dialog.close();
  for (const o of zoneUpkeep.openZoneUpkeeps()) zoneUpkeep.cancelZoneUpkeep(o.zoneId, "cancelled");
  for (const id of openUpkeepDialogs()) closeUpkeepDialog(id);
  // Combats go through their delete (our deleteCombat listeners drop claims, tallies, spends), regions quietly.
  for (const c of [...game.combats.values()]) await c.delete();
  await settleAll(10);
  for (const scene of game.scenes.contents) {
    for (const r of [...scene.regions.values()]) {
      scene.regions.delete(r.id);
      registry.delete(r.uuid);
    }
    const extra = scene.tokens.filter(t => t.flags?.["stef-ds-automation"]?.summon || t.extra).map(t => t.id);
    if (extra.length) await scene.deleteEmbeddedDocuments("Token", extra, { "stef-ds-automation": { internal: true } });
    for (const t of scene.tokens.contents) {
      if (!t.home) continue;
      Object.assign(t._source, { x: t.home.x, y: t.home.y, disposition: t.home.disposition, hidden: t.home.hidden });
      if (t.home.size) Object.assign(t._source, { width: t.home.size, height: t.home.size });
      if (!t.actorLink && t._synth) {
        t._synth.system.stamina.value = t._synth.system.stamina.max;
        t._synth.system.stamina.temporary = 0;
        t._synth.statuses.clear();
        t._synth.system.combatGroups = new Set();
        delete t._synth.system.combatGroup;
        t._synth.effects.clear();
        delete t._source.delta?.system;
      }
    }
  }
  game.combats.clear();
  setCombat(null);
  activatedGroups.clear();
  for (const a of everyone) {
    a.system.stamina.value = a.home.stamina ?? a.system.stamina.max;
    a.system.stamina.temporary = 0;
    a.statuses.clear();
    a.effects.clear();
    a.system.hero.primary.value = a.home.value;
    a.system.hero.surges = 0;
    a.system.hero.xp = 0;
    a.system.hero.victories = 0;
    for (const it of a.items.values()) if (it.flags?.["stef-ds-automation"]) delete it.flags["stef-ds-automation"];
  }
  for (const a of game.actors.values()) {
    if (a instanceof WorldActor) {
      a.system.stamina.value = a.system.stamina.max;
      a.statuses.clear();
      a.effects.clear();
    }
  }
  game.settings.set("draw-steel", "malice", { value: maliceValue });
  game.settings.set("draw-steel", "heroTokens", { value: tokens });
  rulesMod.clearRuleCache();
  watchMod.resetStaminaWatch();
  zoneEngine.dropTallies(null);
  hiddenActors.clear();
  views.clear();
  clickQ.clear();
  regionQ.clear();
  placing.clear();
  noLoe.clear();
  rollQueue.length = 0;
  packOnline(true);
  mclock.timers.clear();
  delete log.turnShift;
  clear();
  dialogs.length = 0;
  notes.length = 0;
}
/** ui.notifications seen on every client (warnings of the zone picker). */
const notes = [];
ui.notifications.warn = (m) => { notes.push({ user: game.user?.id, kind: "warn", text: String(m) }); };
ui.notifications.info = (m) => { notes.push({ user: game.user?.id, kind: "info", text: String(m) }); };
/** A started combat of these tokens (initiative per combatant: its turns; heroes 1), viewed as game.combat. */
function fight(tokens, { round = 1, groups = [] } = {}) {
  const c = newCombat(tokens, { round });
  registry.set(c.uuid, c);
  for (const cb of c.combatants.values()) cb.initiative = Number(cb.actor?.system?.combat?.turns) || 1;
  for (const g of groups) {
    const grp = new Group9({ name: g.name ?? "Squad", type: "squad", initiative: 1, system: { staminaValue: g.pool } }, c);
    c.groups.set(grp.id, grp);
    registry.set(grp.uuid, grp);
    for (const t of g.members) {
      cmbOf(c, t)._source.group = grp.id;
      // The system's derived squad membership (SquadModel, DSM:15019): one group per minion.
      const sys = t.actor.system;
      sys.combatGroups = new Set([grp]);
      Object.defineProperty(sys, "combatGroup", { get: () => grp, configurable: true });
    }
  }
  c.setupTurns();
  // The active GM's Stamina watch seeds at a round / start change (§3.4): as core's startCombat would.
  emit("updateCombat", c, { round: c.round, started: true }, {}, gm.id);
  return c;
}
/** A turn of `token`'s combatant (the tracker's activation) and its end. */
async function turnOf(combat, token) { return activate(combat, token); }
/** The next round (Draw Steel's nextRound). */
async function nextRound(combat) {
  await combat.nextRound();
  await idle();
}

/* ---------- registration ---------- */
let regResult;
{
  regResult = api.library.registerSource(LIB_SOURCE);
  Hooks.callAll("canvasReady");
}

/* ======================================================================== */
/*  Runner: tests/m8/wp-*.mjs (docs/M8-DESIGN.md §12.1, §14.0)              */
/* ======================================================================== */
/** Everything above, by name, for the scenario modules (live bindings of `let` values through the setters). */
const mocks = Object.freeze({
  paths, LIBRARY, noLoe, dsctTurnStarted, dsctKey, clear, getPath, clone, coreOp, Coll,
  ClassList, camel, El, dialogs, parseLoc, makeForm, dialogWait, upkeepDialogs, tokenDialogs, triggerDialogs,
  TokenDocumentBase, ActiveEffectRegistry, CombatBase, Field, StringField, BooleanField, NumberField, SetField, SchemaField, BaseSpecialEffect,
  BaseActorModel, RegionBehaviorType, SET_FIELDS, rollQueue, ScriptedRoll, DSCT_DEFAULTS, dsctApi, makeAbility, api, getResolution,
  buildView, Effect, setCombat, offHook, Message, users, setUser, setActiveGM, Actor, registry,
  messages, gm, gm2, player, player2, imp, clock, handleOp, requestOp, validPlaces,
  timeoutFor, holdWaitMs, validZonePlaces, promptTypes, lifecycleIdle, forgetCombat, resetActivations, schema, entries, applyOps,
  undoOps, prepareSummon, withMessageLock, runSummonPick, buildPreviews, summonReasonText, registryMod, REMOVAL, listSummons, summonInfo,
  summonTokens, indexEntries, dismissSummon, withSummonChain, canPay, openUpkeeps, cancelUpkeep, closeUpkeepDialog, openUpkeepDialogs, checkSquare,
  rectOf, squaresBetween, autoPlaces, originOf, freeGroupName, deletePresent, orphanSummons, HOOKS, rulesMod, gainsMod,
  factsMod, watchMod, gainCardMod, heroTokensMod, worldRes, maliceRem, villainMod, shapesMod, behaviorMod, zoneReg,
  zoneEngine, zoneLedger, zoneUpkeep, zoneCreate, placeMod, gainLock, maliceUI, heroDialog, activateMod, registryLib,
  engineMod, gainCardClock, ZONE_END, set, settle, mclock, worldSet, malice, heroTokens, advance,
  asGM, emit, ALL_USERS, as, clientQuery, gmQuery, relayed, sentTo, render, expand,
  everyone, feature, mkHero, borin, benedikt, dorian, kade, jory, elsa, tala,
  troy, nobody, OWNER, npcModel, npcStatuses, WorldActor, SynthActor, hiddenActors, hiddenFor, ActorsColl,
  PACK, STAT, cuuid, packIndex, packDocs, packOnline, G, LEVEL, TokenDoc9, ForcedDeletion,
  mergeInto, BehaviorDoc, RegionDoc, Scene9, START, OTHER, HEXES, ScenesColl, place, views,
  viewOf, view, clickQ, placing, clicks, nextClick, regionQ, regionClicks, nextRegionClick, cell,
  Combatant9, Group9, reg, Combat9, CombatsColl, newCombat, cmbOf, activate, endTurn, idle,
  activatedGroups, dsctSquadTurns, isSquadLike, dsctStart, hookCalls, slugOf, ability, attack, MPACK, DTPACK,
  npc, npcToken, tBorin, tBen, tDorian, tKade, tJory, tElsa, tTala, tTroy,
  tNobody, borinStrike, wallOfFire, incinerate, battleCry, kadeStrike, judgement, benStrike, benHeroic, mark,
  dorianStrike, elsaBolt, nullField, troyRoll, talaPush, warrior, assassin, stabby, stinker, spine,
  monarchA, arixx, cornelia, bargnot, toxin, mastermind, tWarrior, tAssassin, tStabby, tStinker,
  tSpine1, tSpine2, tSpine3, tMonarch, tArixx, tCornelia, tBargnot, tToxin, tMastermind, tBigGob,
  itemOn, heroTokensOf, deleteItem, addFeature, overlayFiles, OVERLAY_FILES, ALL_OVERLAYS, M7_FILES, TEST_OVERLAYS, LIB_SOURCE,
  aura, moat, useCard, hit, opsOf, gainOps, zoneOp, dmgOps, liveOp, settleAll,
  markMsgs, since, gainCards, zoneCards, maliceCards, ferocity, viewRow, viewOf10, ALL_CLIENTS, regionEvent,
  moveTokenPath, lineCells, pushCells, within, SETTINGS, fresh, notes, fight, turnOf, nextRound,
  paths, LIBRARY, ROOT,
  setAnswer: fn => { answerFn = fn; },
  setRefreshHook: fn => { refreshHook = fn; },
});
const ctx = Object.freeze({ world, mocks, assert, log, sw, asUser: as });

const M8_DIR = new URL("./m8/", import.meta.url);
const EXPECTED = ["wp-a", "wp-b", "wp-c", "wp-d", "wp-e", "wp-f"];
const only = process.argv.slice(2).map(a => a.replace(/.mjs$/, ""));
let present = [];
try {
  present = readdirSync(M8_DIR).filter(f => /^wp-[a-z0-9-]+.mjs$/.test(f)).map(f => f.replace(/.mjs$/, "")).sort();
} catch (err) {
  if (err?.code !== "ENOENT") throw err;
}
// Milestone 9: tests/m9/<name>.mjs (same contract), run after the M8 files; `node harness11.mjs persistent` runs one.
const M9_DIR = new URL("./m9/", import.meta.url);
let present9 = [];
try {
  present9 = readdirSync(M9_DIR).filter(f => /^[a-z0-9-]+\.mjs$/.test(f)).map(f => f.replace(/\.mjs$/, "")).sort();
} catch (err) {
  if (err?.code !== "ENOENT") throw err;
}
for (const name of EXPECTED) if (!present.includes(name)) console.log(`note: tests/m8/${name}.mjs not present, skipped`);
const run = [
  ...(only.length ? present.filter(n => only.includes(n)) : present).map(name => ({ name, dir: M8_DIR, rel: "m8" })),
  ...(only.length ? present9.filter(n => only.includes(n)) : present9).map(name => ({ name, dir: M9_DIR, rel: "m9" })),
];
for (const n of only) if (!present.includes(n) && !present9.includes(n)) console.log(`note: tests/m8/${n}.mjs (or tests/m9/${n}.mjs) not present, skipped`);
let ran = 0;
for (const { name, dir, rel } of run) {
  const mod = await import(new URL(`${name}.mjs`, dir).href);
  if (typeof mod.default !== "function") throw new Error(`tests/${rel}/${name}.mjs: no default export function (ctx)`);
  await fresh();
  console.log(`--- ${name}`);
  await mod.default(ctx);
  await settleAll(10);
  ran++;
}
console.log(`
ALL HARNESS-11 TESTS PASSED (${ran} scenario file(s))`);
process.exit(0);
