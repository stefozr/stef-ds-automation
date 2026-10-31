// Tenth harness (Milestone 7): resources and zones. Event gains (rules, facts, ledger, gain rows on our cards and gain
// cards, undo cascade), the Stamina watch and external reports, native resource rows, hero-token regain, NPC trigger
// Malice, Malice cards and reminders, villain actions, the zone row (plan, placement on the owner's canvas, the GM's
// region with the stef-ds-automation.zone behavior), zone hits (movement tallies, turn start, credits, filters), lifetime and
// upkeep, Dismiss / undo, gains on zone cards, summon activation, check.cjs and selfCheck, the API.
// Reuses harness.mjs's world and harness9's mocks (copied below: one process, every client through AsyncLocalStorage);
// adds the M7 mocks (docs/M7-DESIGN.md §7.1): RegionBehavior config before main.mjs loads, Regions with behaviors and
// movement events, scene.grid geometry, settings.set with options, world settings heroTokens / malice with
// game.actors getters, a scripted Roll, stamina.winded, modifyTokenAttribute writers, a renderChatMessageHTML DOM.
// Scenarios H1-H48 follow docs/M7-DESIGN.md §7.1 (H49: the 0.9.1 fixes from the live run, TESTING.md §14) (H45, harness1-9 unchanged, is the separate runs of those files;
// H47 / H48 run the library's and the medkit's own tools, see README). H50-H51: Milestone 9 WP-B (zones applied
// from the area drawn on use, difficult terrain; docs/M9-DESIGN.md §B).
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
  CONFIG.Token.movement = { actions: { walk: {}, forced: {}, displace: { teleport: true }, teleport: { teleport: true },
    // Milestone 9 (H51): ground and other actions as core's config has them before setup (jump: derived difficulty).
    crawl: { terrainAction: "walk" }, fly: {}, jump: { deriveTerrainDifficulty() {} } } };
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
// Milestone 9 (H50): the prepared-area seam of the use wrapper.
const areasMod = await imp("engine/areas.mjs");
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
/*  H1: gains schema                                                         */
/* ======================================================================== */
{
  const { validateOverlay, normalizeOverlay } = schema;
  const base = { key: "feature:test-feature", version: "1.0.0", name: "Test", effects: [] };
  const rule = (over = {}) => ({ id: "r", event: "damage", label: "Test rule", ...over });
  const ok = (gains, label) => {
    const r = validateOverlay({ ...base, gains });
    assert.ok(r.ok, `${label}: accepted ${JSON.stringify(r.errors)}`);
  };
  const refused = (o, re, label) => {
    const r = validateOverlay(o);
    assert.ok(!r.ok, `${label}: refused`);
    assert.ok(r.errors.some(e => re.test(e)), `${label}: ${JSON.stringify(r.errors)}`);
  };
  ok([rule()], "minimal damage rule");
  ok([rule({ event: "abilityUse", user: "ally", actionType: "freeManeuver" })], "freeManeuver accepted");
  ok([rule({ amount: "1d3" })], "dice amount");
  ok([rule({ event: "naturalRoll", natural: [19, 20], loe: true, once: "each" })], "natural roll");
  refused({ ...base, key: "ability:test", gains: [rule()] }, /feature/, "gains only on feature:");
  refused({ ...base, gains: [rule({ event: "explodes" })] }, /event/, "unknown event");
  refused({ ...base, gains: [rule({ amount: 21 })] }, /amount/, "amount 21");
  refused({ ...base, gains: [rule({ amount: "1d3 * 2" })] }, /amount/, "bad dice");
  refused({ ...base, gains: [rule({ once: "turn" })] }, /once/, "unknown once");
  refused({ ...base, gains: [rule({ resource: "malice" })] }, /resource/, "malice is not a gain resource");
  refused({ ...base, gains: [rule({ taker: "everyone" })] }, /taker/, "unknown taker");
  refused({ ...base, gains: [rule({ event: "abilityUse", taker: "self" })] }, /taker/, "taker does not go with abilityUse");
  refused({ ...base, gains: [rule({ event: "heroDeath", taker: "enemy" })] }, /taker/, "heroDeath taker enemy");
  refused({ ...base, gains: [rule({ event: "winded", dealer: "self" })] }, /dealer/, "dealer does not go with winded");
  refused({ ...base, gains: [rule({ within: 0 })] }, /within/, "within 0");
  refused({ ...base, gains: [rule({ event: "abilityUse", within: 5, withinAbility: "null-field" })] }, /within/, "within and withinAbility");
  refused({ ...base, gains: [rule({ event: "abilityUse", heroesInTurn: 3 })] }, /heroesInTurn|hero/, "heroesInTurn needs user hero");
  refused({ ...base, gains: [rule({ event: "naturalRoll" })] }, /natural/, "natural required");
  refused({ ...base, gains: [rule({ event: "winded", states: ["bloodied"] })] }, /states/, "bad states");
  refused({ ...base, gains: [rule({ label: undefined })] }, /label/, "label required");
  refused({ ...base, gains: [rule({ minSurges: 4 })] }, /minSurges/, "minSurges 4");
  refused({ ...base, gains: [rule({ takerEffect: { effect: "MHQDlicbxXquwduc" } })] }, /takerEffect/, "takerEffect needs an ability");
  refused({ ...base, gains: [rule(), rule()] }, /duplicate/, "duplicate id");
  refused({ ...base, gains: [rule({ amountBy: [{ feature: "a", amount: 2 }, { feature: "a", amount: 3 }] })] }, /amountBy|duplicate/, "duplicate amountBy feature");
  refused({ ...base, gains: Array.from({ length: 7 }, (_v, i) => rule({ id: `r${i}` })) }, /gains|6/, "7 gains");
  // normalizeOverlay: defaults (forcedMove taker selfOrCreature), amountBy sorted ascending.
  const n = normalizeOverlay({ ...base, gains: [
    rule({ event: "forcedMove", amountBy: [{ feature: "clear-mind", amount: 3 }, { feature: "mind-recovery", amount: 2 }] }),
    rule({ id: "d" }), rule({ id: "w", event: "winded" }),
  ] });
  assert.equal(n.gains[0].taker, "selfOrCreature", "forcedMove taker default");
  assert.deepEqual(n.gains[0].amountBy.map(a => a.amount), [2, 3], "amountBy sorted");
  assert.equal(n.gains[0].once, "round");
  assert.equal(n.gains[0].resource, "heroic");
  assert.equal(n.gains[0].amount, 1);
  assert.equal(n.gains[1].taker, "self");
  assert.equal(n.gains[1].dealer, "any");
  assert.deepEqual(n.gains[2].states, ["winded"]);
  assert.deepEqual(normalizeOverlay({ key: "ability:x", version: "1.0.0", name: "X", effects: [{ id: "n", type: "note", text: "x" }] }).gains, [], "gains ??= []");
  console.log("ok H1 gains schema: 4 accepted, 21 refusals, normalize defaults and sorted amountBy");
}

/* ======================================================================== */
/*  H2: zone schema + detached entries                                       */
/* ======================================================================== */
{
  const { validateOverlay, normalizeOverlay, ZONE_DEFAULTS } = schema;
  const base = { key: "ability:zone-test", version: "1.0.0", name: "Zone Test" };
  const zone = (over = {}) => ({ id: "z", type: "zone", targets: "self", value: "2", ...over });
  const r0 = validateOverlay({ ...base, effects: [zone()] });
  assert.ok(r0.ok, JSON.stringify(r0.errors));
  const refused = (over, re, label) => {
    const e = zone(over);
    for (const [k, v] of Object.entries(over)) if (v === undefined) delete e[k];
    const r = validateOverlay({ ...base, effects: [e] });
    assert.ok(!r.ok, `${label}: refused`);
    assert.ok(r.errors.some(x => re.test(x)), `${label}: ${JSON.stringify(r.errors)}`);
  };
  refused({ zoneEvents: ["move"] }, /once/, "move needs once none");
  refused({ zoneEvents: ["enter", "move"], once: "none" }, /enter|move/, "enter + move refused");
  refused({ targets: "targets" }, /self/, "targets must be self");
  refused({ value: undefined }, /value/, "value required");
  refused({ affects: "friends" }, /affects/, "unknown affects");
  refused({ shape: "circle" }, /shape/, "unknown shape");
  refused({ size: 31 }, /size/, "size 31");
  refused({ upkeep: 2, lasts: ["encounterEnd"] }, /summonerTurnStart|upkeep/, "upkeep without summonerTurnStart");
  refused({ filter: "allies" }, /filter/, "filter refused");
  refused({ potency: { characteristic: "might", value: "2" } }, /potency/, "potency refused");
  refused({ exceptKeywords: ["Goblin"] }, /keyword|lowercase/, "keywords lowercase");
  const okMove = validateOverlay({ ...base, effects: [zone({ zoneEvents: ["move"], once: "none" })] });
  assert.ok(okMove.ok, `move + none: ${JSON.stringify(okMove.errors)}`);
  const okEx = validateOverlay({ ...base, effects: [zone({ exceptMonsters: [`${MPACK}6SR8siFeC5lWUzoO`, "goblin-warrior"] })] });
  assert.ok(okEx.ok, `exceptMonsters: ${JSON.stringify(okEx.errors)}`);
  const n = normalizeOverlay({ ...base, effects: [{ id: "z", type: "zone", value: "2" }] }).effects[0];
  assert.equal(n.targets, "self", "targets self by default");
  assert.equal(n.onceShared ?? ZONE_DEFAULTS.onceShared, false, "onceShared false");
  // Detached entries: round trip and a fresh dsAuto.zone entry.
  const eff = zone({ zoneEvents: ["enter", "turnStart"], perSquare: true, size: 5, range: 10, lasts: ["summonerTurnStart"], upkeep: 1, exceptKeywords: ["goblin"] });
  const ents = entries.effectToEntries(eff, "ability:zone-test");
  assert.equal(ents.length, 1, "one entry");
  assert.equal(ents[0].type, "dsAuto.zone", "entry type");
  assert.equal(typeof ents[0].dsAuto.size, "string", "size stored as a string");
  const back = entries.entryToEffect(ents[0]);
  assert.equal(back.type, "zone");
  assert.equal(back.targets, "self");
  assert.deepEqual([...back.zoneEvents], ["enter", "turnStart"]);
  assert.equal(back.perSquare, true);
  assert.equal(Number(back.size), 5);
  assert.deepEqual([...back.exceptKeywords], ["goblin"]);
  const strip = ({ entryId: _e, ...rest }) => rest;   // the entry link is not overlay data
  const check = validateOverlay({ ...base, effects: [strip(back)] });
  assert.ok(check.ok, `round-tripped entry validates: ${JSON.stringify(check.errors)}`);
  // The sheet's data model: dsAuto.zone registered with the zone fields' initials.
  const Zone = ds.CONFIG.SpecialEffect["dsAuto.zone"]?.documentClass;
  assert.ok(Zone, "dsAuto.zone registered");
  const fields = Zone.defineSchema().dsAuto.fields;
  assert.deepEqual([...(fields.zoneEvents?.options?.initial ?? fields.zoneEvents?.initial ?? [])], ["enter", "turnStart"], "zoneEvents initial");
  assert.equal(fields.once?.options?.initial ?? fields.once?.initial, "round", "once initial (zonePick)");
  assert.equal(fields.affects?.options?.initial ?? fields.affects?.initial, "enemies", "affects initial (zonePick)");
  assert.deepEqual([...(fields.lasts?.options?.initial ?? fields.lasts?.initial ?? [])], ["summonerTurnStart"], "lasts initial for a zone");
  assert.equal(fields.forcedCounts?.options?.initial ?? fields.forcedCounts?.initial, true, "forcedCounts initial");
  const fresh0 = entries.entryToEffect({ _id: "dsAutofresh00001", type: "dsAuto.zone", name: "Fresh", dsAuto: { effectId: "fresh", value: "1" } });
  const vf = validateOverlay({ ...base, effects: [strip(fresh0)] });
  assert.ok(vf.ok, `a fresh zone entry validates: ${JSON.stringify(vf.errors)}`);
  console.log("ok H2 zone schema: 11 refusals, move/none and exceptMonsters accepted, entry round trip, dsAuto.zone fields");
}

/* ======================================================================== */
/*  H3: the M7 overlays                                                      */
/* ======================================================================== */
{
  const { validateOverlay } = schema;
  assert.equal(M7_FILES.length, 21, "21 new overlay files");
  for (const f of [...M7_FILES, "monsters/parry.json"]) {
    const o = JSON.parse(readFileSync(LIBRARY + f, "utf8"));
    const r = validateOverlay(o);
    assert.ok(r.ok, `${f}: ${JSON.stringify(r.errors)}`);
  }
  assert.equal(ALL_OVERLAYS.length, 175, `175 overlays in the library (got ${ALL_OVERLAYS.length})`);
  assert.deepEqual([regResult.accepted, regResult.rejected], [LIB_SOURCE.overlays.length, 0], `registered: ${JSON.stringify(regResult.problems ?? regResult)}`);
  const info = api.library.info();
  assert.ok(info.gainFeatures >= 8 || (Array.isArray(info.gainFeatures) && info.gainFeatures.length >= 8), `gain features: ${JSON.stringify(info.gainFeatures)}`);
  console.log(`ok H3 overlays: 22 files validate, ${ALL_OVERLAYS.length} overlays + ${TEST_OVERLAYS.length} test ones registered, 0 rejected`);
}

/* ======================================================================== */
/*  H4: NPC guard                                                            */
/* ======================================================================== */
{
  const find = item => api.library.find(item);
  // NPC + generic only -> null; NPC + monster-specific -> it; hero -> generic.
  const gobJudge = ability(warrior, "Judgement", { dsid: "judgement", attach: false });
  assert.equal(find(gobJudge), null, "an NPC never borrows a hero's generic overlay");
  assert.equal(find(judgement)?.key, "ability:judgement", "the hero gets it");
  assert.equal(find(itemOn(tAssassin, "Sword Stab"))?.key, "ability:sword-stab", "unlinked assassin: monster overlay through the base actor");
  assert.equal(find(itemOn(tStabby, "Sword Stab"))?.key, "ability:sword-stab", "linked Stabby: its own compendiumSource");
  const parry = itemOn(tCornelia, "Parry!");
  assert.equal(find(parry)?.key, "ability:parry", "Cornelia's Parry!");
  assert.ok(find(parry)?.monster?.includes("dame-cornelia"), "the monster parry overlay, not the tactician's");
  const blackguard = npc("Human Blackguard", `${MPACK}h0iw7LTM1djcBzn9`, { keywords: ["human"], abilities: [{ name: "Parry!", dsid: "parry", type: "triggered" }] });
  assert.ok(find(blackguard.items.find(i => i.name === "Parry!"))?.monster, "Human Blackguard: the monster parry overlay");
  // NPCs sharing a hero ability's key without a monster overlay: manual (§3.11 inventory).
  for (const [mon, ab] of [["Rival Tactician", "Overwatch"], ["Targon", "Overwatch"], ["Castellan Hoplon", "Inspiring Strike"],
    ["Hobgoblin Burning Witch", "Soul Burn"], ["Olothec", "Psychic Pulse"]]) {
    const a = npc(mon, `${MPACK}${slugOf(mon).padEnd(16, "x").slice(0, 16)}`, { keywords: ["human"] });
    const it = ability(a, ab, { attach: false });
    assert.equal(find(it), null, `${mon} ${ab}: null`);
  }
  // A test-only generic overlay that opts in for NPCs (npc: true) reaches the goblin; heroes still get it.
  api.library.registerSource({ id: "h4-npc", priority: 10, overlays: [{ key: "ability:goblin-choice", version: "1.0.0", name: "Choice", npc: true, effects: [{ id: "n", type: "note", text: "Pick" }] }] });
  const gobChoice = ability(warrior, "Goblin Choice", { dsid: "goblin-choice", attach: false });
  assert.equal(find(gobChoice)?.key, "ability:goblin-choice", "npc: true reaches an NPC");
  const heroChoice = ability(benedikt, "Goblin Choice", { dsid: "goblin-choice", attach: false });
  assert.equal(find(heroChoice)?.key, "ability:goblin-choice", "and a hero");
  api.library.unregisterSource("h4-npc");
  // Triggers follow: Cornelia's reactors list the monster Parry!, a generic-only NPC lists none.
  const corneliaTriggers = api.triggers.reactors(tCornelia).map(r => r.name);
  assert.ok(corneliaTriggers.includes("Parry!"), `Cornelia reacts with Parry!: ${JSON.stringify(corneliaTriggers)}`);
  const gobJudgeHolder = npc("Goblin Judge", `${MPACK}gobjudge00000001`, { abilities: [{ name: "Judgement", dsid: "judgement" }, { name: "Parry", dsid: "parry", type: "triggered" }] });
  const tGJ = npcToken(gobJudgeHolder, "Goblin Judge", 19, 19);
  assert.deepEqual(api.triggers.reactors(tGJ).map(r => r.name), [], "a goblin with hero-named abilities reacts with nothing");
  START.tokens.delete(tGJ.id);
  console.log("ok H4 NPC guard: generic refused for NPCs, monster overlays by base actor and own source, npc: true, triggers follow");
}

/* ======================================================================== */
/*  H5-H8: Fury, our damage (exit 1)                                         */
/* ======================================================================== */
const spear = itemOn(tWarrior, "Spear Charge");
const stab = itemOn(tAssassin, "Sword Stab");
const borinKey = () => Object.entries(getResolution(messages.contents.at(-1))?.targets ?? {}).find(([, t]) => t.actorUuid === borin.uuid)?.[0];
const roundLedger = (actor = borin, combat = game.combat) => api.resources.ledger(actor, combat).round;
let h5Combat;
{
  await fresh();
  h5Combat = fight([tBorin, tWarrior, tAssassin]);
  const before = ferocity();
  const msg = await hit(spear, tBorin, 5);
  const res = getResolution(msg);
  const gains = gainOps(msg);
  assert.equal(gains.length, 1, `one gain row: ${JSON.stringify(opsOf(msg).map(o => [o.kind, o.status, o.reason]))}`);
  const g = gains[0];
  const key = Object.entries(res.targets).find(([, t]) => t.actorUuid === borin.uuid)[0];
  assert.deepEqual(g.targetKeys, [key], "on Borin's own record");
  assert.ok(!res.targets[key].gainOnly, "Borin is a real target (no gain-only record)");
  assert.equal(g.status, "applied", `applied: ${g.reason}`);
  assert.equal(g.mode, "auto");
  assert.equal(g.gain.ruleKey, "ferocity:took-damage");
  assert.equal(ferocity(), before + 1, "Ferocity +1");
  assert.equal(g.finalAmount, 1);
  assert.equal(g.after.value, before + 1);
  assert.equal(Number.isInteger(g.seq), true, "seq");
  assert.equal(g.byUserId, gm.id, "byUserId");
  assert.deepEqual(g.gain.causeOpIds, dmgOps(msg).map(o => o.opId), "caused by the damage row");
  const entry = roundLedger()["ferocity:took-damage"];
  assert.ok(entry && entry.opId === g.opId && entry.messageId === msg.id, `eventGains entry: ${JSON.stringify(roundLedger())}`);
  assert.equal(msg.updates, 1, `one message update for the resolution (got ${msg.updates})`);
  // The row as the card shows it.
  const row = viewRow(msg, g.opId);
  assert.match(row.label, /DSAUTO\.Card\.Gain .*"amount":1.*Ferocity/, `label: ${row.label}`);
  assert.match(row.detail, /First damage taken this round/);
  assert.match(row.detail, /DSAUTO\.Card\.GainNow/);
  console.log("ok H5 our damage: one auto gain row on Borin's record, Ferocity +1, ledger entry, one message update");
}
{
  // H6: same round again -> nothing.
  const before = ferocity();
  const ledger = clone(roundLedger());
  const msg = await hit(stab, tBorin, 3);
  assert.equal(gainOps(msg).length, 0, "no gain row the second time this round");
  assert.equal(ferocity(), before);
  assert.deepEqual(roundLedger(), ledger, "ledger unchanged");
  console.log("ok H6 same round: no second gain");
  // H7: next round -> the stale round state is replaced (lazy reset), a gain again.
  await nextRound(h5Combat);
  assert.deepEqual(roundLedger(), {}, "a new round reads empty");
  borin.system.stamina.value = borin.system.stamina.max;
  const msg2 = await hit(spear, tBorin, 3);
  assert.equal(gainOps(msg2).length, 1, "a gain row in round 2");
  assert.equal(gainOps(msg2)[0].status, "applied");
  assert.equal(h5Combat.flags["stef-ds-automation"].eventGains.round, 2, "the round-2 state replaced the stale one");
  assert.equal(Object.keys(h5Combat.flags["stef-ds-automation"].eventGains.used).length, 1);
  assert.equal(ferocity(), before + 1);
  console.log("ok H7 next round: gain again after the lazy reset");
  // H8: two cards in the same tick (two locks) -> exactly one gain row.
  await nextRound(h5Combat);
  borin.system.stamina.value = borin.system.stamina.max;   // S5: no hit before H10 crosses the winded value
  const f0 = ferocity();
  const a = useCard(spear, { targets: [tBorin], amount: 2 });
  const b = useCard(stab, { targets: [tBorin], amount: 2 });
  await idle();
  await settleAll();
  const rows = [...gainOps(a), ...gainOps(b)];
  assert.equal(rows.length, 1, `one gain row over both cards: ${JSON.stringify(rows.map(r => [r.status, r.reason, r.gain.round]))} ${JSON.stringify(h5Combat.flags)}`);
  assert.equal(ferocity(), f0 + 1);
  assert.deepEqual(gainsMod.gainClaims(), [], "no claim left");
  console.log("ok H8 same instant: two cards, one gain row");
}

/* ======================================================================== */
/*  H9: upgrades                                                             */
/* ======================================================================== */
{
  await fresh();
  const c = fight([tBorin, tWarrior]);
  const amountOf = () => api.resources.rules(borin).find(r => r.ruleKey === "ferocity:took-damage")?.amount;
  assert.equal(amountOf(), 1);
  const damaging = addFeature(borin, "Damaging Ferocity", "damaging-ferocity");
  assert.equal(amountOf(), 2, "Damaging Ferocity -> 2 (cache dropped on createItem)");
  const primordial = addFeature(borin, "Primordial Ferocity", "primordial-ferocity");
  assert.equal(amountOf(), 3, "both upgrades -> 3 (the highest replaces, never adds)");
  const msg = await hit(spear, tBorin, 4);
  assert.equal(gainOps(msg)[0]?.finalAmount, 3, "+3 applied");
  await deleteItem(primordial);
  await deleteItem(damaging);
  assert.equal(amountOf(), 1, "features removed -> 1 (cache drop on deleteItem)");
  const ferocityItem = borin.items.find(i => i.type === "feature" && i.system._dsid === "ferocity");
  await ferocityItem.update({ "flags.stef-ds-automation.disabled": true });
  assert.deepEqual(api.resources.rules(borin), [], "a feature disabled in the medkit gives no rule");
  await ferocityItem.update({ "flags.stef-ds-automation.disabled": null });
  delete ferocityItem.flags["stef-ds-automation"];
  emit("updateItem", ferocityItem, {}, {}, gm.id);
  assert.equal(api.resources.rules(borin).length, 2, "re-enabled");
  void c;
  console.log("ok H9 upgrades: 2, 3, back to 1 on delete, none while disabled");
}

/* ======================================================================== */
/*  H10: undo, cascade, re-apply, the 1d3 row                                */
/* ======================================================================== */
{
  await fresh();
  const c = fight([tBorin, tWarrior]);
  const f0 = ferocity();
  const msg = await hit(spear, tBorin, 4);
  const g = gainOps(msg)[0];
  // Undo the gain row alone: Ferocity back (absolute), ledger released, a quiet write for Battle Log.
  log.actorUpdates.length = 0;
  await api.undoOps(msg.id, [g.opId]);
  await settleAll();
  let live = liveOp(msg, g.opId);
  assert.equal(live.status, "undone");
  assert.equal(live.undoMode, "absolute");
  assert.equal(live.ledgerReleased, true, "ledger entry released");
  assert.equal(ferocity(), f0, "Ferocity back");
  assert.deepEqual(roundLedger(), {}, "ledger empty");
  assert.ok(log.actorUpdates.some(u => u.name === "Borin" && u.options.dsblQuiet === true), "undo write carries dsblQuiet");
  // Re-apply: the same op id applied again, undo fields cleared.
  await api.applyOps(msg.id, [g.opId]);
  await settleAll();
  live = liveOp(msg, g.opId);
  assert.equal(live.status, "applied");
  assert.equal(live.undoMode, null, "undoMode cleared");
  assert.equal(live.ledgerReleased, null, "ledgerReleased cleared");
  assert.equal(ferocity(), f0 + 1);
  assert.equal(roundLedger()["ferocity:took-damage"]?.opId, g.opId, "ledger holds the same op again");
  // Delta undo: Ferocity changed meanwhile (the system's turn gain) -> the gain's delta comes off.
  await borin.update({ "system.hero.primary.value": ferocity() + 2 });
  await api.undoOps(msg.id, [g.opId]);
  await settleAll();
  assert.equal(liveOp(msg, g.opId).undoMode, "delta");
  assert.equal(ferocity(), f0 + 2, "only the gain's +1 came off");
  // Damage-only undo cascades: re-apply the gain, then undo the damage row -> the gain goes too.
  await api.applyOps(msg.id, [g.opId]);
  await settleAll();
  const dmg = dmgOps(msg)[0];
  await api.undoOps(msg.id, [dmg.opId]);
  await settleAll();
  assert.equal(liveOp(msg, dmg.opId).status, "undone");
  assert.equal(liveOp(msg, g.opId).status, "undone", "the gain row was undone with its cause");
  assert.equal(ferocity(), f0 + 2);
  assert.deepEqual(roundLedger(), {}, "released by the cascade");
  // The 1d3 winded row: rolled on every apply.
  await fresh();
  const c2 = fight([tBorin, tWarrior]);
  borin.system.stamina.value = 20;
  rollQueue.push(2, 3);
  const w = await hit(spear, tBorin, 8);
  const wind = gainOps(w).find(o => o.gain.ruleKey === "ferocity:winded-or-dying");
  assert.ok(wind, `the winded row: ${JSON.stringify(gainOps(w).map(o => o.gain.ruleKey))}`);
  assert.equal(wind.amount, null, "the amount stays null (a roll)");
  assert.equal(wind.formula, "1d3");
  assert.equal(wind.rolled?.total, 2, "rolled 2");
  assert.equal(wind.finalAmount, 2);
  const encEntry = api.resources.ledger(borin, c2).encounter["ferocity:winded-or-dying"];
  assert.ok(encEntry, "encounter ledger entry");
  await api.undoOps(w.id, [wind.opId]);
  await settleAll();
  await api.applyOps(w.id, [wind.opId]);
  await settleAll();
  assert.equal(liveOp(w, wind.opId).rolled?.total, 3, "re-applied: rolled again (3)");
  assert.equal(log.rolls.filter(r => r.formula === "1d3").length, 2, "two rolls in all");
  // 0.16.0: setting gainUndoKeepsSlot: an undone once-per-round gain still counts for the round.
  await fresh();
  fight([tBorin, tWarrior]);
  await set("gainUndoKeepsSlot", true);
  const k0 = ferocity();
  const kept = await hit(spear, tBorin, 4);
  const kg = gainOps(kept)[0];
  await api.undoOps(kept.id, [kg.opId]);
  await settleAll();
  assert.deepEqual([liveOp(kept, kg.opId).status, liveOp(kept, kg.opId).ledgerKept, ferocity()], ["undone", true, k0], "undone, slot kept");
  assert.equal(roundLedger()["ferocity:took-damage"]?.opId, kg.opId, "the ledger still holds the round's gain");
  const again = await hit(spear, tBorin, 4);
  assert.equal(gainOps(again).length, 0, "the next hit this round gains nothing");
  await api.applyOps(kept.id, [kg.opId]);
  await settleAll();
  assert.deepEqual([liveOp(kept, kg.opId).status, ferocity()], ["applied", k0 + 1], "the undone row itself may apply again");
  await set("gainUndoKeepsSlot", false);
  void c;
  console.log("ok H10 undo: absolute and delta, ledger released, dsblQuiet, cascade with the damage, re-apply clears, 1d3 rolls again, slot kept on undo (setting)");
}

/* ======================================================================== */
/*  H11: modes                                                               */
/* ======================================================================== */
{
  await fresh();
  const c = fight([tBorin, tWarrior, tAssassin, tTroy]);
  await set("resourceGains", "prompt");
  const f0 = ferocity();
  const m1 = await hit(spear, tBorin, 2);
  const w1 = gainOps(m1)[0];
  assert.ok(w1, "a waiting row in prompt mode");
  assert.equal(w1.status, "pending");
  assert.equal(w1.mode, "prompt");
  assert.deepEqual(gainsMod.gainClaims(), [], "a waiting row holds no claim (D13)");
  assert.deepEqual(roundLedger(), {}, "nothing in the ledger yet");
  assert.equal(ferocity(), f0);
  const m2 = await hit(stab, tBorin, 2);
  const w2 = gainOps(m2)[0];
  assert.ok(w2 && w2.status === "pending", "a second waiting row the same round");
  // A re-resolve keeps the waiting row.
  await api.resolve(m1.id, { force: true });
  await settleAll();
  assert.equal(liveOp(m1, w1.opId)?.status, "pending", "re-resolve keeps the waiting gain row");
  // Apply one -> applied + ledger; apply the other -> alreadyGained.
  await api.applyOps(m1.id, [w1.opId]);
  await settleAll();
  assert.equal(liveOp(m1, w1.opId).status, "applied");
  assert.equal(roundLedger()["ferocity:took-damage"]?.opId, w1.opId);
  await api.applyOps(m2.id, [w2.opId]);
  await settleAll();
  assert.equal(liveOp(m2, w2.opId).status, "skipped");
  assert.equal(liveOp(m2, w2.opId).reason, "alreadyGained", "the first applied wins");
  assert.equal(ferocity(), f0 + 1);
  // "Apply all" never takes a waiting gain row? (prompt rows are part of Apply all; confirm rows are not, below.)
  // Deleting a card with a waiting row leaves the rule free.
  await nextRound(c);
  borin.system.stamina.value = borin.system.stamina.max;
  const m3 = await hit(spear, tBorin, 2);
  assert.equal(gainOps(m3)[0]?.status, "pending");
  await m3.delete();
  await set("resourceGains", "auto");
  const m4 = await hit(stab, tBorin, 2);
  assert.equal(gainOps(m4)[0]?.status, "applied", "the rule was still free after the card was deleted");
  // manual: a manual row; off: nothing.
  await nextRound(c);
  await set("resourceGains", "manual");
  const m5 = await hit(spear, tBorin, 1);
  assert.equal(gainOps(m5)[0]?.mode, "manual");
  await set("resourceGains", "off");
  await nextRound(c);
  const m6 = await hit(spear, tBorin, 1);
  assert.equal(gainOps(m6).length, 0, "off: nothing");
  await set("resourceGains", "auto");
  // A confirm rule under auto: Troy's natural 19 row waits and is not part of "Apply all".
  await nextRound(c);
  const n0 = markMsgs();
  const roll = useCard(troyRoll, { targets: [tWarrior], amount: 1, natural: 19 });
  await idle();
  await settleAll();
  const gc = gainCards(n0);
  assert.equal(gc.length, 1, `one gain card for the natural roll: ${gc.length}`);
  const nat = opsOf(gc[0]).find(o => o.gain?.ruleKey === "drama:natural-high");
  assert.ok(nat, "the natural-high row");
  assert.equal(nat.status, "pending");
  assert.equal(nat.mode, "prompt", "confirm -> prompt");
  assert.equal(engineMod.ownButtonOnly(nat), true, "confirm rows only by their own button");
  await api.applyOps(gc[0].id, null);   // "Apply all"
  await settleAll();
  assert.equal(liveOp(gc[0], nat.opId).status, "pending", "Apply all skips the confirm row");
  await api.applyOps(gc[0].id, [nat.opId]);
  await settleAll();
  assert.equal(liveOp(gc[0], nat.opId).status, "applied", "its own button applies it");
  assert.equal(troy.system.hero.primary.value, 3, "+3 Drama");
  void roll;
  // A hook veto releases the auto claim: the next event this round gains.
  await nextRound(c);
  borin.system.stamina.value = borin.system.stamina.max;
  const veto = Hooks.on(HOOKS.preApplyOp, (_m, op) => (op.kind === "gain" ? false : undefined));
  const m7 = await hit(spear, tBorin, 1);
  Hooks.off(HOOKS.preApplyOp, veto);
  assert.equal(gainOps(m7)[0]?.status, "skipped");
  assert.equal(gainOps(m7)[0]?.reason, "hookVetoed");
  assert.deepEqual(gainsMod.gainClaims(), [], "the vetoed row's claim was released");
  const m8 = await hit(stab, tBorin, 1);
  assert.equal(gainOps(m8)[0]?.status, "applied", "the rule is still free this round");
  console.log("ok H11 modes: prompt rows wait without claims, first applied wins, re-resolve keeps them, delete frees, manual / off, confirm outside Apply all, a veto releases");
}

/* ======================================================================== */
/*  H12: damage edge cases                                                   */
/* ======================================================================== */
{
  await fresh();
  const c = fight([tBorin, tWarrior, tElsa, tDorian, tSpine1, tSpine2, tSpine3], { groups: [{ name: "Spinecleavers", members: [tSpine1, tSpine2, tSpine3], pool: 15 }] });
  // Immunity to 0: "you take damage" is false.
  borin.system.damage.immunities.fire = 10;
  const m1 = await hit(spear, tBorin, 4, { type: "fire" });
  assert.equal(dmgOps(m1)[0].finalAmount, 0, "immune");
  assert.equal(gainOps(m1).length, 0, "no gain when immunity ate the hit");
  borin.system.damage.immunities.fire = 0;
  // Temporary Stamina absorbs everything: still taken.
  borin.system.stamina.temporary = 10;
  const m2 = await hit(spear, tBorin, 4);
  assert.equal(borin.system.stamina.value, borin.system.stamina.max, "Stamina untouched");
  assert.equal(gainOps(m2).length, 1, "temporary Stamina loss is damage taken");
  // Heal / temp ops: no fact.
  await nextRound(c);
  const healItem = attack(benedikt, "Second Wind", { target: { type: "ally" } });
  healItem.system.power.effects.delete("dmgPRE0000000001");
  healItem.system.power.effects.set("dmgPRE0000000001", { id: "dmgPRE0000000001", type: "damage", name: "Heal" });
  const heal = useCard(healItem, { targets: [tBorin], extraRolls: [new ds.rolls.DamageRoll(3, { isHeal: true, type: "value" })] });
  await idle();
  await settleAll();
  assert.equal(gainOps(heal).length, 0, "a heal is no damage fact");
  benedikt.items.delete(healItem.id);
  // A squad op: dealt measured by the pool; Elsa (Essence, typed within 10) gains from fire on the squad.
  tSpine1._source.x = 8 * G;
  tSpine1._source.y = 3 * G;
  const poolBefore = c.groups.contents[0].system.staminaValue;
  const sq = await hit(elsaBolt, [tSpine1, tSpine2], 3, { type: "fire" });
  const pool = c.groups.contents[0].system.staminaValue;
  assert.ok(pool < poolBefore, `the pool took the hit (${poolBefore} -> ${pool})`);
  const ess = gainOps(sq).find(o => o.gain.ruleKey === "essence:typed-damage-near");
  assert.ok(ess && ess.status === "applied", `Essence row from the squad hit: ${JSON.stringify(gainOps(sq).map(o => o.gain.ruleKey))}`);
  // Potency surges do not count for minSurges (Dorian's Insight needs a damage surge).
  await nextRound(c);
  dorian.system.hero.surges = 3;
  const ds1 = await hit(dorianStrike, tWarrior, 2);
  assert.equal(gainOps(ds1).filter(o => o.gain.ruleKey === "insight:surge-damage").length, 0, "no surge, no Insight");
  await api.surge(ds1.id, dmgOps(ds1)[0].opId, { count: 1 });
  await settleAll();
  const ins = gainOps(ds1).find(o => o.gain.ruleKey === "insight:surge-damage");
  assert.ok(ins, `a damage surge on the applied base -> Insight row (gain on that write): ${JSON.stringify(opsOf(ds1).map(o => [o.kind, o.status, o.reason]))}`);
  assert.equal(ins.status, "applied");
  console.log("ok H12 damage edge cases: immunity 0 none, temporary Stamina counts, heals none, squad pool dealt, damage surges count");
}

/* ======================================================================== */
/*  H13: gates                                                               */
/* ======================================================================== */
{
  await fresh();
  // No started combat: no gains (Q2).
  const m1 = await hit(spear, tBorin, 2);
  assert.equal(gainOps(m1).length, 0, "no combat, no gain");
  const c = fight([tBorin, tWarrior]);
  game.modules.set("draw-steel-resources-ui", { active: true });
  const m2 = await hit(spear, tBorin, 2);
  assert.equal(gainOps(m2).length, 0, "Resources UI active: none");
  const sc1 = api.selfCheck();
  game.modules.delete("draw-steel-resources-ui");
  game.modules.set("draw-steel-triggers", { active: true });
  const m3 = await hit(spear, tBorin, 2);
  assert.equal(gainOps(m3).length, 0, "Draw Steel: Triggers active: none");
  game.modules.delete("draw-steel-triggers");
  const text = JSON.stringify(sc1);
  assert.match(text, /resources-ui|Resources UI|gains/i, `selfCheck names the stand-down: ${text.slice(0, 400)}`);
  void c;
  console.log("ok H13 gates: no combat, Resources UI, Triggers module");
}

/* ======================================================================== */
/*  H14: external damage                                                     */
/* ======================================================================== */
const holdsMod = await imp("triggers/holds.mjs");
const externalMod = await imp("triggers/external.mjs");
/** The system's Apply button on `user`'s client: DamageRoll#applyDamage -> takeDamage (wrapped). */
const systemApply = (user, actor, amount, opts = {}) => as(user, () => actor.system.takeDamage(amount, opts));
/** A Director's sheet edit of Stamina (updateActor: the watch's cache follows). */
const setStamina = (actor, value) => actor.update({ "system.stamina.value": value });
const gainRowsOf = msgs => msgs.flatMap(m => opsOf(m).filter(o => o.kind === "gain"));
{
  await fresh();
  const c = fight([tBorin, tWarrior, tKade, tElsa, tSpine1, tSpine2, tSpine3], { groups: [{ name: "Spinecleavers", members: [tSpine1, tSpine2, tSpine3], pool: 15 }] });
  // (a) A player's system Apply on Borin: report-only -> holdDone -> the GM's watched change by that user -> gain card.
  let n = markMsgs();
  const f0 = ferocity();
  await systemApply(player2, borin, 5);
  await settleAll();
  assert.equal(gainCards(n).length, 0, "nothing before the 1.5 s report wait");
  await advance(1_600);
  await settleAll();
  let cards = gainCards(n);
  assert.equal(cards.length, 1, `one gain card: ${cards.length}`);
  let rows = gainRowsOf(cards);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "applied");
  assert.equal(rows[0].gain.ruleKey, "ferocity:took-damage");
  assert.equal(ferocity(), f0 + 1, "+1 Ferocity from external damage");
  assert.equal(getResolution(cards[0]).gain.source, "external");
  // (b) A forged report (no Stamina change) -> nothing.
  await nextRound(c);
  n = markMsgs();
  await as(player2, () => requestOp({ action: "holdDone", holdDone: { applied: true, actorUuid: borin.uuid, tokenUuid: tBorin.uuid, before: { value: 30, temporary: 0 }, after: { value: 20, temporary: 0 } } }));
  await advance(1_600);
  await settleAll();
  assert.equal(gainCards(n).length, 0, "a forged report moves no Stamina: nothing");
  // (c) A report with `before` inflated: the fact comes from the watch (dealt 2, not 12).
  const real = borin.system.stamina.value;
  const seen = [];
  const spy = Hooks.on("dsAuto.preGain", (_a, _r, fact) => { seen.push(fact); });
  await as(player2, () => borin.update({ "system.stamina.value": real - 2 }));
  await as(player2, () => requestOp({ action: "holdDone", holdDone: { applied: true, actorUuid: borin.uuid, tokenUuid: tBorin.uuid, before: { value: real + 10, temporary: 0 }, after: { value: real - 2, temporary: 0 } } }));
  await advance(1_600);
  await settleAll();
  Hooks.off("dsAuto.preGain", spy);
  assert.equal(seen[0]?.dealt, 2, `dealt from the watch: ${seen[0]?.dealt}`);
  // (d) A report from another user than the writer -> nothing (the watch saw player2 write; gm2 reports).
  await nextRound(c);
  n = markMsgs();
  await as(player2, () => borin.update({ "system.stamina.value": borin.system.stamina.value - 2 }));
  await as(player, () => requestOp({ action: "holdDone", holdDone: { applied: true, actorUuid: kade.uuid, tokenUuid: tKade.uuid, before: { value: 30, temporary: 0 }, after: { value: borin.system.stamina.value, temporary: 0 } } }));
  await advance(1_600);
  await settleAll();
  assert.equal(gainCards(n).length, 0, "a report about another actor than the change: nothing");
  // (e) A player-vouched dealer: KADE's judged goblin hits him through Combat Tools' Apply on the player's client.
  const judged = await tWarrior.actor.createEmbeddedDocuments("ActiveEffect", [{ _id: "MHQDlicbxXquwduc", name: "Judged", origin: judgement.uuid, statuses: [] }]);
  assert.ok(judged[0], "judged effect");
  n = markMsgs();
  await systemApply(player, kade, 3, { staminaLoss: false, dsbl: { source: { actorUuid: tWarrior.actor.uuid, tokenUuid: tWarrior.uuid, ability: "spear-charge" } } });
  await advance(1_600);
  await settleAll();
  cards = gainCards(n);
  rows = gainRowsOf(cards).filter(o => o.gain.ruleKey === "wrath:judged-hits-you");
  assert.equal(rows.length, 1, `the Wrath row: ${JSON.stringify(gainRowsOf(cards).map(o => o.gain.ruleKey))}`);
  assert.equal(rows[0].status, "pending", "a dealer only a player vouches for: the row waits");
  assert.equal(rows[0].gain.vouched, "player");
  assert.match(viewRow(cards[0], rows[0].opId).detail, /DSAUTO\.Card\.GainWaits/, "waits for the Director");
  // (f) A Target Damage record (GM-written) wins over the same hit's report 1.5 s later.
  await nextRound(c);
  game.modules.set("draw-steel-target-damage", { active: true });
  await setStamina(borin, borin.system.stamina.max);
  const card = await ChatMessage.create({ type: "base", content: "goblin hit" });
  n = markMsgs();
  const before = { value: borin.system.stamina.value, temporary: 0 };
  await systemApply(gm, borin, 4);
  const after = { value: borin.system.stamina.value, temporary: 0 };
  await card.update({ "flags.draw-steel-target-damage.state": {
    sourceActorUuid: tWarrior.actor.uuid, sourceTokenUuid: tWarrior.uuid,
    applications: { op1: { records: [{ kind: "damage", status: "applied", before, after, appliedAt: Date.now(), damageType: "", appliedByUserId: gm.id, target: { tokenUuid: tBorin.uuid, actorUuid: borin.uuid } }] } },
  } }, { userId: gm.id });
  await settleAll();
  cards = gainCards(n);
  assert.equal(cards.length, 1, "the Target Damage record makes the gain card at once");
  assert.equal(getResolution(cards[0]).gain.causeMessageId, card.id);
  await advance(1_600);
  await settleAll();
  assert.equal(gainCards(n).length, 1, "the same hit's report finds the change consumed: nothing more");
  // (g) A squad hit by Target Damage: a pool write, no takeDamage -> a fact with the pool delta (Elsa's Essence: fire).
  tSpine1._source.x = 8 * G;
  tSpine1._source.y = 3 * G;
  const grp = c.groups.contents[0];
  const pb = grp.system.staminaValue;
  await grp.update({ "system.staminaValue": pb - 6 }, {});
  n = markMsgs();
  const card2 = await ChatMessage.create({ type: "base", content: "fire on the squad" });
  await card2.update({ "flags.draw-steel-target-damage.state": {
    sourceActorUuid: elsa.uuid, sourceTokenUuid: tElsa.uuid,
    applications: { op1: { records: [{ kind: "damage", status: "applied", before: { value: pb, groupedMinion: true, groupUuid: grp.uuid }, after: { value: pb - 6 }, appliedAt: Date.now(), damageType: "fire", appliedByUserId: gm.id, target: { tokenUuid: tSpine1.uuid, actorUuid: tSpine1.actor.uuid } }] } },
  } }, { userId: gm.id });
  await settleAll();
  rows = gainRowsOf(gainCards(n));
  assert.ok(rows.some(o => o.gain.ruleKey === "essence:typed-damage-near" && o.status === "applied"), `Essence from the pool delta: ${JSON.stringify(rows.map(o => o.gain.ruleKey))}`);
  // (h) Death Tracker's later pool rewrite (its clamp) -> no second fact.
  n = markMsgs();
  await grp.update({ "system.staminaValue": pb - 7 }, {});
  await advance(6_000);
  await settleAll();
  assert.equal(gainCards(n).length, 0, "a pool rewrite nobody reports is no damage fact");
  game.modules.delete("draw-steel-target-damage");
  // (j) Combat Tools' "untyped" -> type "" (Essence: none).
  await nextRound(c);
  n = markMsgs();
  await systemApply(gm, tWarrior.actor, 3, { type: "untyped", staminaLoss: false, dsbl: { source: { actorUuid: elsa.uuid, ability: "x-bolt" } } });
  await advance(1_600);
  await settleAll();
  assert.equal(gainRowsOf(gainCards(n)).filter(o => o.gain.ruleKey === "essence:typed-damage-near").length, 0, "untyped is no Essence damage");
  // (k) Stamina loss crossing winded -> only the winded row.
  await nextRound(c);
  await setStamina(borin, 16);
  n = markMsgs();
  rollQueue.push(1);
  await systemApply(gm, borin, 3, { staminaLoss: true });
  await advance(1_600);
  await settleAll();
  rows = gainRowsOf(gainCards(n));
  assert.deepEqual(rows.map(o => o.gain.ruleKey), ["ferocity:winded-or-dying"], "Stamina loss: only the winded row");
  // (l) Our own engine writes make no report.
  await nextRound(c);
  n = markMsgs();
  await hit(spear, tBorin, 2);
  await advance(1_600);
  await settleAll();
  assert.equal(gainCards(n).length, 0, "our own damage: no external gain card (the card's own row instead)");
  // (i) A Combat Tools collision (a forced-move window) with triggers on: reported, not held -> gain card.
  await nextRound(c);
  await set("triggersEnabled", true);
  externalMod.handleFmActive({ targetTokenUuid: tBorin.uuid, id: "fmwindow00000001" }, gm);
  n = markMsgs();
  const d0 = dialogs.length;
  await systemApply(gm, borin, 2, { staminaLoss: false });
  await advance(1_600);
  await settleAll();
  assert.equal(dialogs.length, d0, "the collision is not held (no trigger prompt)");
  assert.equal(gainRowsOf(gainCards(n)).length, 1, "but reported: a gain card");
  externalMod.handleFmActive({ id: "fmwindow00000001", end: true }, gm);
  await set("triggersEnabled", false);
  // (m) A report reaching a non-active GM is forwarded to the active one.
  await nextRound(c);
  setActiveGM(gm2);
  n = markMsgs();
  const b0 = { value: borin.system.stamina.value, temporary: 0 };
  await as(player2, () => borin.update({ "system.stamina.value": b0.value - 2 }));
  await as(gm, () => holdsMod.externalDone({ applied: true, actorUuid: borin.uuid, tokenUuid: tBorin.uuid, before: b0, after: { value: b0.value - 2, temporary: 0 }, reportOnly: false }, player2));
  await advance(1_600);
  await settleAll();
  assert.ok(relayed("holdDone").some(r => r.from === gm.id && r.to === gm2.id), "forwarded to the active GM");
  assert.equal(gainCards(n).length, 1, "the active GM made the gain card");
  setActiveGM(gm);
  void judged;
  console.log("ok H14 external damage: report after 1.5 s, forged and mismatched reports ignored, watch numbers, player-vouched dealer waits, Target Damage wins, squad pool, untyped, Stamina loss, own writes, collisions, forwarding");
}

/* ======================================================================== */
/*  H15: every class rule                                                    */
/* ======================================================================== */
const judgedOn = (tok, { id = "MHQDlicbxXquwduc", origin = judgement.uuid } = {}) => tok.actor.createEmbeddedDocuments("ActiveEffect", [{ _id: id, name: "Judged", origin, statuses: [] }]);
const rowsFor = (msg, ruleKey) => gainOps(msg).filter(o => o.gain.ruleKey === ruleKey);
{
  await fresh();
  const c = fight([tBorin, tBen, tKade, tJory, tElsa, tTala, tTroy, tDorian, tWarrior, tAssassin, tMonarch]);
  // Censor: the judged foe damages KADE (effect by id) -> +1 Wrath on the goblin's card.
  await judgedOn(tWarrior);
  const w1 = await hit(spear, tKade, 3);
  const r1 = rowsFor(w1, "wrath:judged-hits-you");
  assert.equal(r1.length, 1, `judged foe hit you: ${JSON.stringify(gainOps(w1).map(o => o.gain.ruleKey))}`);
  assert.equal(r1[0].status, "applied");
  assert.equal(kade.system.hero.primary.value, 2, "+1 Wrath");
  // KADE hits his judged foe -> +1 Wrath on KADE's card (KADE gains on his own card: a gain-only record).
  const w2 = await hit(kadeStrike, tWarrior, 3);
  const r2 = rowsFor(w2, "wrath:you-hit-judged");
  assert.equal(r2.length, 1, "you hit your judged foe");
  const rec2 = getResolution(w2).targets[r2[0].targetKeys[0]];
  assert.equal(rec2.actorUuid, kade.uuid);
  assert.equal(rec2.gainOnly, true, "KADE's own record on his card is gain-only");
  assert.equal(kade.system.hero.primary.value, 3);
  // Once per round each.
  const w3 = await hit(kadeStrike, tWarrior, 1);
  assert.equal(rowsFor(w3, "wrath:you-hit-judged").length, 0, "once per round");
  // Judged by origin dsid (another effect id): next round, the assassin judged through the item's dsid.
  await nextRound(c);
  await judgedOn(tAssassin, { id: "otherEffectId001" });
  const w4 = await hit(kadeStrike, tAssassin, 2);
  assert.equal(rowsFor(w4, "wrath:you-hit-judged").length, 1, "judged effect recognized by its origin item's dsid");
  console.log("ok H15a Censor: both clauses, by effect id and by origin dsid, once per round");

  // Tactician: Benedikt's marked goblin damaged by Borin -> a gain-only record for Benedikt on Borin's card.
  await tWarrior.actor.createEmbeddedDocuments("ActiveEffect", [{ _id: "YW2JEdoDPd0XlaII", name: "Marked", origin: mark.uuid, statuses: [] }]);
  const t1 = await hit(borinStrike, tWarrior, 3);
  const tr = rowsFor(t1, "focus:marked-damaged");
  assert.equal(tr.length, 1, "Focus row on Borin's card");
  const benRec = getResolution(t1).targets[tr[0].targetKeys[0]];
  assert.equal(benRec.actorUuid, benedikt.uuid);
  assert.equal(benRec.gainOnly, true);
  const benRow = viewOf10(t1).rows.find(r => r.key === tr[0].targetKeys[0]);
  assert.equal(benRow.tierLabel, "DSAUTO.Card.GainRow", "the row reads 'Resource gain'");
  assert.equal(benRow.rowClass, "ds-auto-row-gain");
  assert.equal(benedikt.system.hero.primary.value, 4, "+1 Focus");
  console.log("ok H15b Tactician: marked foe damaged by an ally -> gain-only record on the ally's card");

  // Elementalist: typed damage within 10 (holy and untyped excluded, 11 squares excluded).
  await nextRound(c);
  const e1 = await hit(spear, tWarrior, 2, { type: "holy" });
  assert.equal(rowsFor(e1, "essence:typed-damage-near").length, 0, "holy: none");
  const e2 = await hit(spear, tWarrior, 2);
  assert.equal(rowsFor(e2, "essence:typed-damage-near").length, 0, "untyped: none");
  tWarrior._source.x = 14 * G;   // Elsa at (3,3): 11 squares
  const e3 = await hit(stab, tWarrior, 2, { type: "fire" });
  assert.equal(rowsFor(e3, "essence:typed-damage-near").length, 0, "11 squares: none");
  tWarrior._source.x = 13 * G;   // 10 squares
  const e4 = await hit(stab, tWarrior, 2, { type: "fire" });
  assert.equal(rowsFor(e4, "essence:typed-damage-near").length, 1, "fire within 10: +1 Essence");
  tWarrior._source.x = tWarrior.home.x;
  console.log("ok H15c Elementalist: typed within 10 only");

  // Talent: a Combat Tools push of 3 one-square updates -> one gain card; the Talent pushed by a goblin -> gain.
  await nextRound(c);
  let n = markMsgs();
  await pushCells(tWarrior, [[10, 5], [11, 5], [12, 5]]);
  await advance(1_300);
  await settleAll();
  let cards = gainCards(n);
  assert.equal(cards.length, 1, `one gain card for the whole push: ${cards.length}`);
  assert.equal(gainRowsOf(cards)[0]?.gain.ruleKey, "clarity-and-strain:forced-move");
  assert.equal(tala.system.hero.primary.value, 1, "+1 Clarity");
  await nextRound(c);
  n = markMsgs();
  await pushCells(tTala, [[2, 1]]);
  await advance(1_300);
  await settleAll();
  assert.equal(gainRowsOf(gainCards(n)).filter(o => o.gain.ruleKey === "clarity-and-strain:forced-move").length, 1, "the Talent pushed by a goblin gains");
  // Our own forced row (a move card): the gain row on that card, no second one from the moveToken it causes.
  await nextRound(c);
  n = markMsgs();
  const mv = await api.forcedMovement({ targets: [tAssassin], movement: "push", distance: 2, source: tBorin });
  await idle();
  await advance(1_300);
  await settleAll();
  const mvMsg = messages.get(mv.messageId);
  const fRows = gainOps(mvMsg).filter(o => o.gain.ruleKey === "clarity-and-strain:forced-move");
  const extra = gainRowsOf(gainCards(n)).filter(o => o.gain.ruleKey === "clarity-and-strain:forced-move");
  assert.equal(fRows.length + extra.length, 1, `one Clarity gain for our forced row: card ${fRows.length}, gain cards ${extra.length} (${JSON.stringify(opsOf(mvMsg).map(o => [o.kind, o.status, o.reason, o.movedDistance]))})`);
  console.log("ok H15d Talent: a 3-square push joined into one gain card, pushed Talent gains, our forced row counted once");

  // Null: the Director's Malice ability -> gain card; an enemy main action in the field -> a waiting row.
  await nextRound(c);
  n = markMsgs();
  useCard(itemOn(tMonarch, "Get in Here!"), { author: gm });
  await idle();
  await settleAll();
  let rows = gainRowsOf(gainCards(n)).filter(o => o.gain.ruleKey === "discipline:director-malice");
  assert.equal(rows.length, 1, "a Malice ability: +1 Discipline");
  assert.equal(rows[0].status, "applied");
  tAssassin._source.x = 5 * G;
  tAssassin._source.y = 7 * G;   // next to Jorah (4,6): inside the Null Field (aura 2)
  n = markMsgs();
  useCard(stab, { targets: [tBorin], amount: 1 });
  await idle();
  await settleAll();
  const field = gainRowsOf(gainCards(n)).filter(o => o.gain.ruleKey === "discipline:field-main-action");
  assert.equal(field.length, 1, "the field main action row");
  assert.equal(field[0].status, "pending", "it waits for the Director (confirm)");
  assert.match(viewRow(gainCards(n)[0], field[0].opId).detail, /GainWaits/);
  tAssassin._source.x = tAssassin.home.x;
  tAssassin._source.y = tAssassin.home.y;
  console.log("ok H15e Null: Malice ability gain card, field main action waits");

  // Troubadour: a hero winded (encounter), its own natural 20 without line of effect, hero deaths, three heroes.
  await nextRound(c);
  borin.system.stamina.value = 16;
  const tw = await hit(spear, tBorin, 3);
  const heroWinded = rowsFor(tw, "drama:hero-winded");
  assert.equal(heroWinded.length, 1, "a hero winded: Troy's row on the goblin's card");
  assert.equal(heroWinded[0].finalAmount, 2);
  noLoe.add(`${tTroy.id}|${tTroy.id}`);
  n = markMsgs();
  useCard(troyRoll, { targets: [tWarrior], amount: 1, natural: 20 });
  await idle();
  await settleAll();
  rows = gainRowsOf(gainCards(n)).filter(o => o.gain.ruleKey === "drama:natural-high");
  assert.equal(rows.length, 1, "its own natural 20: no line-of-effect test");
  noLoe.clear();
  // Another hero's natural 19 out of Troy's line of effect -> none.
  noLoe.add(`${tTroy.id}|${tBen.id}`);
  n = markMsgs();
  useCard(benStrike, { targets: [tWarrior], amount: 1, natural: 19 });
  await idle();
  await settleAll();
  assert.equal(gainRowsOf(gainCards(n)).filter(o => o.gain.ruleKey === "drama:natural-high").length, 0, "no line of effect: none");
  noLoe.clear();
  // Hero death: the defeated status on Borin -> +10 for Troy; undo and redo of the killing blow -> one +10 while applied.
  const drama0 = troy.system.hero.primary.value;
  n = markMsgs();
  const [dead] = await borin.createEmbeddedDocuments("ActiveEffect", [{ name: "Dead", statuses: ["dead"] }]);
  await settleAll();
  rows = gainRowsOf(gainCards(n)).filter(o => o.gain.ruleKey === "drama:hero-died");
  assert.equal(rows.length, 1, "+10 on Borin's death");
  assert.equal(troy.system.hero.primary.value, drama0 + 10);
  await borin.deleteEmbeddedDocuments("ActiveEffect", [dead.id]);
  n = markMsgs();
  await borin.createEmbeddedDocuments("ActiveEffect", [{ name: "Dead", statuses: ["dead"] }]);
  await settleAll();
  assert.equal(gainRowsOf(gainCards(n)).filter(o => o.gain.ruleKey === "drama:hero-died").length, 0, "the same hero again: none while the first row is applied");
  assert.equal(troy.system.hero.primary.value, drama0 + 10);
  // Two heroes dying in one apply -> +10 twice.
  n = markMsgs();
  await Promise.all([dorian.createEmbeddedDocuments("ActiveEffect", [{ name: "Dead", statuses: ["dead"] }]), jory.createEmbeddedDocuments("ActiveEffect", [{ name: "Dead", statuses: ["dead"] }])]);
  await settleAll();
  assert.equal(gainRowsOf(gainCards(n)).filter(o => o.gain.ruleKey === "drama:hero-died" && o.status === "applied").length, 2, "two deaths: +10 twice");
  // Three heroes using abilities in one turn (encounter, confirm -> prompt).
  await nextRound(c);
  await activate(c, tBorin);
  n = markMsgs();
  for (const it of [wallOfFire, benHeroic, judgement]) {
    useCard(it, { author: gm });
    await idle();
  }
  await settleAll();
  rows = gainRowsOf(gainCards(n)).filter(o => o.gain.ruleKey === "drama:heroes-same-turn");
  assert.equal(rows.length, 1, `three heroes this turn: ${JSON.stringify(gainRowsOf(gainCards(n)).map(o => o.gain.ruleKey))}`);
  assert.equal(rows[0].status, "pending", "waits for the Director");
  console.log("ok H15f Troubadour: hero winded, own natural 20, line of effect, deaths once per hero, two deaths, three heroes");

  // Fury: the winded 1d3 rolled once, undone with its damage row.
  await fresh();
  const c2 = fight([tBorin, tWarrior]);
  borin.system.stamina.value = 16;
  rollQueue.push(2);
  const fw = await hit(spear, tBorin, 3);
  const wrow = rowsFor(fw, "ferocity:winded-or-dying")[0];
  assert.equal(wrow?.rolled?.total, 2, "1d3 rolled once");
  assert.equal(log.rolls.length, 1);
  await api.undoOps(fw.id, [dmgOps(fw)[0].opId]);
  await settleAll();
  assert.equal(liveOp(fw, wrow.opId).status, "undone", "the winded row went with its damage row");
  assert.equal(liveOp(fw, rowsFor(fw, "ferocity:took-damage")[0].opId).status, "undone");
  void c2;
  console.log("ok H15g Fury: winded 1d3 rolled once, undone with its damage row");
}

/* ======================================================================== */
/*  H16: records                                                             */
/* ======================================================================== */
const recordMod = await imp("engine/record.mjs");
{
  await fresh();
  const c = fight([tBorin, tBen, tWarrior, tAssassin]);
  await tWarrior.actor.createEmbeddedDocuments("ActiveEffect", [{ _id: "YW2JEdoDPd0XlaII", name: "Marked", origin: mark.uuid, statuses: [] }]);
  await set("resourceGains", "prompt");
  // A waiting Focus row (prompt) and, after applying Borin's own, re-resolves keep both with their records.
  const m = await hit(borinStrike, tWarrior, 3);
  const focusRow = gainOps(m).find(o => o.gain.ruleKey === "focus:marked-damaged");
  assert.ok(focusRow && focusRow.status === "pending");
  const benKey = focusRow.targetKeys[0];
  await api.resolve(m.id, { force: true });
  await settleAll();
  let res = getResolution(messages.get(m.id));
  assert.equal(res.ops[focusRow.opId]?.status, "pending", "the waiting gain row survives a re-resolve");
  assert.equal(res.targets[benKey]?.gainOnly, true, "with its gain-only record");
  // Nothing is planned on the gain-only record (I2/C10): its only row is the gain row.
  assert.deepEqual(Object.values(res.ops).filter(o => o.targetKeys.includes(benKey)).map(o => o.kind), ["gain"], "no damage on the Tactician");
  await api.applyOps(m.id, [focusRow.opId]);
  await settleAll();
  await api.resolve(m.id, { force: true });
  await settleAll();
  res = getResolution(messages.get(m.id));
  assert.equal(res.ops[focusRow.opId]?.status, "applied", "applied gain row kept");
  assert.equal(res.targets[benKey]?.gainOnly, true);
  // realTargets / targetedOps ignore gain-only records.
  assert.ok(!(benKey in recordMod.realTargets(res)), "realTargets ignores gainOnly");
  assert.ok(!recordMod.targetedOps(res).some(o => o.opId === focusRow.opId), "targetedOps ignores the gain row");
  // A gainer that is now a real target gets a normal record; a dropped gainer record is reused unchanged (C26).
  await set("resourceGains", "auto");
  await nextRound(c);
  const m2 = await hit(borinStrike, [tWarrior, tBen], 1);
  const r2 = getResolution(m2);
  const benKey2 = Object.entries(r2.targets).find(([, t]) => t.actorUuid === benedikt.uuid)[0];
  await api.retarget(m2.id, [tWarrior.uuid]);
  await settleAll();
  const dropped = clone(getResolution(messages.get(m2.id)).targets[benKey2]);
  assert.equal(dropped?.dropped, true, `Benedikt dropped: ${JSON.stringify(dropped)}`);
  // The Focus gain of this round happened on m2 already (Benedikt's marked foe): next round a new hit on m2's goblin.
  await nextRound(c);
  await api.applyOps(m2.id, null);
  await settleAll();
  const r3 = getResolution(messages.get(m2.id));
  assert.deepEqual(r3.targets[benKey2], dropped, "the dropped record is not overwritten");
  // opWrite: rows created during applyOps are written as full ops (their gain field included).
  for (const o of Object.values(r3.ops).filter(x => x.kind === "gain")) assert.ok(o.gain?.ruleKey && o.targetKeys?.length, `full op written: ${o.opId}`);
  void c;
  console.log("ok H16 records: waiting and applied gain rows kept on re-resolve, nothing planned on gain-only records, realTargets / targetedOps, dropped record reused, full ops written");
}

/* ======================================================================== */
/*  H17: native resource rows                                                */
/* ======================================================================== */
{
  await fresh();
  const c = fight([tBorin, tBen, tDorian, tWarrior]);
  const msg = useCard(battleCry, { targets: [tBen, tDorian, tWarrior], tier: 2 });
  await idle();
  await settleAll();
  const res = getResolution(msg);
  const surges = Object.values(res.ops).filter(o => o.kind === "resource" && o.native);
  assert.equal(surges.length, 3, `one row per target: ${JSON.stringify(Object.values(res.ops).map(o => [o.kind, o.status, o.reason]))}`);
  const benOp = surges.find(o => res.targets[o.targetKeys[0]].actorUuid === benedikt.uuid);
  assert.equal(benOp.amount, 2, "tier 2: 2 surges");
  assert.equal(benOp.status, "applied");
  assert.equal(benedikt.system.hero.surges, 2);
  const gobOp = surges.find(o => res.targets[o.targetKeys[0]].actorUuid === tWarrior.actor.uuid);
  assert.equal(gobOp.status, "skipped");
  assert.equal(gobOp.reason, "noResource", "a non-hero target is skipped");
  // The system's own "Gain surges" button is locked once our row applied (gain-lock, every client).
  const root = new El("li");
  const btn = new El("button");
  btn.setAttribute("data-action", "gainResource");
  btn.setAttribute("data-uuid", `${battleCry.uuid}.PowerRollEffect.resPRE0000000001`);
  root.append(btn);
  render(messages.get(msg.id), player, root);
  assert.equal(btn.disabled, true, "the system's gainResource button is disabled");
  assert.equal(btn.dataset.tooltip, "DSAUTO.Lock.GainApplied");
  // Combat Tools' flat resource automation on the item keeps priority: no native rows.
  battleCry.system.effects = { contents: [{ type: "dsct.flatResource" }] };
  const msg2 = useCard(battleCry, { targets: [tBen], tier: 1 });
  await idle();
  await settleAll();
  assert.equal(Object.values(getResolution(msg2)?.ops ?? {}).filter(o => o.kind === "resource").length, 0, "dsct.flatResource: no rows");
  battleCry.system.effects = { contents: [] };
  // An overlay that replaces the native effect: no native rows.
  api.library.registerSource({ id: "h17", priority: 90, overlays: [{ key: "ability:battle-cry", version: "1.0.0", name: "Battle Cry", native: { suppress: ["resPRE0000000001"] }, effects: [{ id: "n", type: "note", text: "By hand" }] }] });
  const msg3 = useCard(battleCry, { targets: [tBen], tier: 1 });
  await idle();
  await settleAll();
  const ov = Object.values(getResolution(msg3)?.ops ?? {});
  api.library.unregisterSource("h17");
  assert.equal(ov.filter(o => o.kind === "resource").length, 0, `an overlay replacing the PRE: no rows (${JSON.stringify(ov.map(o => o.kind))})`);
  void c;
  console.log("ok H17 native resources: a surge row per target at its tier, non-heroes skipped, the system button locked, Combat Tools and overlays win");
}

/* ======================================================================== */
/*  H18: hero tokens                                                         */
/* ======================================================================== */
const heroRows = msg => opsOf(msg).filter(o => o.heroToken);
const tokenAsks = () => log.sent.filter(s => s.type === "heroTokenRegain");
/** Answer hero-token dialogs with `outcome` (and record them); other dialogs stay open. */
const tokenAnswer = (outcome) => { answerFn = rec => (rec.kind === "herotoken" ? outcome : undefined); };
{
  await fresh({ tokens: 3 });
  const c = fight([tBorin, tWarrior, tAssassin, tNobody]);
  await activate(c, tWarrior);
  borin.system.stamina.value = 3;
  tokenAnswer("spend");
  // The ask while it is open: the card shows who is asked (a new hold marker).
  let heldSeen = null;
  answerFn = rec => {
    if (rec.kind !== "herotoken") return undefined;
    const m = messages.contents.at(-1);
    heldSeen = clone(getResolution(m)?.hold ?? null);
    return "spend";
  };
  const msg = await hit(spear, tBorin, 5);
  assert.equal(tokenAsks().length, 1, "Test was asked");
  assert.equal(tokenAsks()[0].to, player2.id);
  assert.match(String(tokenAsks()[0].data.heroName), /Borin/);
  assert.equal(tokenAsks()[0].data.staminaAfter, -2);
  assert.equal(tokenAsks()[0].data.staminaWith, 8);
  assert.ok(heldSeen?.names?.some(n => n.text === "Test" && n.playerSide), `the card waits for Test: ${JSON.stringify(heldSeen)}`);
  const hrow = heroRows(msg)[0];
  const dmg = dmgOps(msg)[0];
  assert.ok(hrow, "a hero-token heal row");
  assert.ok(hrow.order < dmg.order, "before the damage row");
  assert.equal(hrow.status, "applied");
  assert.equal(hrow.heroToken.damageOpId, dmg.opId);
  assert.ok(hrow.seq < dmg.seq, "applied first in the batch");
  assert.equal(heroTokens(), 1, "2 tokens spent");
  assert.equal(borin.system.stamina.value, 3 + 10 - 5, "Stamina 3 + rv - 5");
  const v = viewRow(msg, hrow.opId);
  assert.match(v.label, /HeroTokenHeal/);
  assert.match(v.detail, /HeroTokenLeft/);
  assert.equal(v.canEdit, false, "the heal row is not editable");
  await assert.rejects(api.editOp(msg.id, hrow.opId, { amount: 20 }), /BadRequest/, "editOp refuses it");
  assert.ok(!getResolution(messages.get(msg.id)).hold, "the hold marker is gone after the write");
  assert.equal(msg.updates, 2, "the hold marker, then one write for the resolution");
  // Undo all: Stamina 3, tokens 3 (quiet), the spend freed -> the same hit re-applied this turn asks again.
  log.settingsSets.length = 0;
  await api.undoOps(msg.id, null);
  await settleAll();
  assert.equal(borin.system.stamina.value, 3, "Stamina back");
  assert.equal(heroTokens(), 3, "tokens back");
  assert.ok(log.settingsSets.some(s => s.key === "draw-steel.heroTokens" && s.options.dsblQuiet === true), "tokens back quietly");
  assert.deepEqual(heroTokensMod.heroTokenSpends(), [], "spend freed");
  log.sent.length = 0;
  await api.applyOps(msg.id, [dmg.opId]);
  await settleAll();
  assert.equal(tokenAsks().length, 1, "asked again after the undo");
  assert.equal(heroTokens(), 1);
  // Undo of the damage row alone takes the heal along.
  await api.undoOps(msg.id, [dmg.opId]);
  await settleAll();
  assert.equal(heroRows(messages.get(msg.id)).every(o => o.status === "undone"), true, "the heal was undone with its damage");
  assert.equal(heroTokens(), 3);
  assert.equal(borin.system.stamina.value, 3);
  console.log("ok H18a spend: heal row first, tokens and Stamina, waiting banner, not editable, undo all, re-ask, cascade");

  // A preApplyOp veto of the damage: the heal is undone at once (damageNotApplied), tokens back.
  await nextRound(c);
  await activate(c, tWarrior);
  log.sent.length = 0;
  const veto = Hooks.on(HOOKS.preApplyOp, (_m, op) => (op.kind === "damage" && !op.heroToken ? false : undefined));
  const vm = await hit(spear, tBorin, 5);
  Hooks.off(HOOKS.preApplyOp, veto);
  const vh = heroRows(vm)[0];
  assert.ok(vh, "the heal row exists");
  assert.equal(vh.status, "undone");
  assert.equal(vh.reason, "damageNotApplied");
  assert.equal(heroTokens(), 3, "tokens back at once");
  assert.equal(borin.system.stamina.value, 3);
  // Decline / timeout / closed: no row, the spend freed.
  for (const how of ["decline", "timeout", "closed"]) {
    await nextRound(c);
    await activate(c, tWarrior);
    if (how === "decline") tokenAnswer("decline");
    else answerFn = () => undefined;
    const p = hit(spear, tBorin, 5);
    if (how === "timeout") {
      await settle(50);
      await advance(25_000);
    } else if (how === "closed") {
      await settle(50);
      tokenDialogs().at(-1)?.dialog.close();
    }
    const dm = await p;
    assert.equal(heroRows(dm).length, 0, `${how}: no heal row`);
    assert.deepEqual(heroTokensMod.heroTokenSpends(), [], `${how}: spend freed`);
    assert.equal(heroTokens(), 3);
    await setStamina(borin, 3);
  }
  console.log("ok H18b veto -> damageNotApplied, decline / timeout / closed free the spend");

  // Owner offline -> no prompt; a hero without a player owner -> the GM is asked; tokens 1 -> none; non-lethal -> none.
  await nextRound(c);
  await activate(c, tWarrior);
  log.sent.length = 0;
  player2.active = false;
  tokenAnswer("spend");
  const off = await hit(spear, tBorin, 5);
  assert.equal(tokenAsks().length, 0, "owner offline: nobody asked");
  assert.equal(heroRows(off).length, 0);
  player2.active = true;
  await setStamina(borin, 3);
  nobody.system.stamina.value = 3;
  const d0 = dialogs.length;
  const nob = await hit(stab, tNobody, 5);
  assert.equal(dialogs.slice(d0).filter(d => d.kind === "herotoken" && d.user === gm.id).length, 1, "no player owner: the active GM is asked");
  assert.equal(heroRows(nob)[0]?.status, "applied");
  await nextRound(c);
  await activate(c, tWarrior);
  await worldSet("heroTokens", 1);
  log.sent.length = 0;
  await hit(spear, tBorin, 5);
  assert.equal(tokenAsks().length, 0, "1 token: no ask");
  await worldSet("heroTokens", 3);
  await setStamina(borin, 20);
  await hit(spear, tBorin, 5);
  assert.equal(tokenAsks().length, 0, "not lethal: no ask");
  console.log("ok H18c offline owner, ownerless hero (GM asked), 1 token, non-lethal");

  // Two cards lethal in the same tick -> one ask; a second card that became non-lethal (healed meanwhile) -> no ask.
  await nextRound(c);
  await activate(c, tWarrior);
  await setStamina(borin, 3);
  log.sent.length = 0;
  tokenAnswer("spend");
  const a = useCard(spear, { targets: [tBorin], amount: 5 });
  const b = useCard(stab, { targets: [tBorin], amount: 5 });
  await idle();
  await settleAll();
  assert.equal(tokenAsks().length, 1, "one ask for the turn");
  assert.equal(heroRows(a).length + heroRows(b).length, 1);
  await nextRound(c);
  await activate(c, tWarrior);
  await setStamina(borin, 3);
  await worldSet("heroTokens", 3);
  log.sent.length = 0;
  // The first card's ask is answered only after a heal landed: the second card's ask finds the hit not lethal.
  let release;
  answerFn = rec => (rec.kind === "herotoken" ? new Promise(r => { release = () => r("decline"); }) : undefined);
  const first = useCard(spear, { targets: [tBorin], amount: 5 });
  await settle(80);
  const second = useCard(stab, { targets: [tBorin], amount: 2 });
  await settle(30);
  await setStamina(borin, 30);
  release?.();
  await idle();
  await settleAll();
  assert.equal(tokenAsks().length, 1, `the healed hero's second card asks nothing (${tokenAsks().length})`);
  void first;
  void second;
  // The hero's reactor queue busy for 6 s -> skipped.
  await nextRound(c);
  await activate(c, tWarrior);
  await setStamina(borin, 3);
  await worldSet("heroTokens", 3);
  log.sent.length = 0;
  tokenAnswer("spend");
  const { withReactorQueue } = await imp("triggers/prompt.mjs");
  let unblock;
  const block = withReactorQueue(borin.uuid, () => new Promise(r => { unblock = r; }));
  const busyHit = useCard(spear, { targets: [tBorin], amount: 5 });
  await settle(50);
  await advance(6_000);
  unblock();
  await block;
  await idle();
  await settleAll();
  assert.equal(tokenAsks().length, 0, "a busy hero is skipped");
  assert.equal(heroRows(busyHit).length, 0);
  // The card deleted while asked -> UnknownCard (nothing written).
  await nextRound(c);
  await activate(c, tWarrior);
  await setStamina(borin, 3);
  await worldSet("heroTokens", 3);
  let gone;
  answerFn = rec => (rec.kind === "herotoken" ? new Promise(r => { gone = r; }) : undefined);
  const del = useCard(spear, { targets: [tBorin], amount: 5 });
  await settle(80);
  await del.delete();
  gone?.("spend");
  await idle();
  await settleAll();
  assert.equal(heroTokens(), 3, "nothing spent on a deleted card");
  assert.equal(borin.system.stamina.value, 3);
  void c;
  console.log("ok H18d same tick one ask, healed meanwhile no ask, busy queue skipped, card deleted while asked");
}

/* ======================================================================== */
/*  H19: hero tokens after a Parry                                           */
/* ======================================================================== */
{
  await fresh({ tokens: 3 });
  const benParry = ability(benedikt, "Parry", { dsid: "parry", type: "triggered", target: { type: "creature" } });
  const c = fight([tBorin, tBen, tWarrior]);
  await set("triggersEnabled", true);
  await activate(c, tWarrior);
  // Halved to non-lethal: Borin 6, hit 10 -> 5 after Parry: no hero-token prompt.
  await setStamina(borin, 6);
  answerFn = rec => (rec.kind === "trigger" ? "use" : (rec.kind === "herotoken" ? "spend" : undefined));
  log.sent.length = 0;
  const m1 = await hit(spear, tBorin, 10);
  assert.ok(dmgOps(m1)[0].trigger?.entries?.some(e => e.outcome === "used"), "Parry used");
  assert.equal(borin.system.stamina.value, 1, "halved");
  assert.equal(tokenAsks().length, 0, "the halving made it non-lethal: no prompt");
  // Still lethal after the halving: the prompt carries the halved numbers.
  await nextRound(c);
  await activate(c, tWarrior);
  benedikt.system.hero.primary.value = 3;
  await setStamina(borin, 3);
  log.sent.length = 0;
  const m2 = await hit(spear, tBorin, 10);
  assert.equal(tokenAsks().length, 1, "still lethal: asked");
  assert.equal(tokenAsks()[0].data.staminaAfter, 3 - 5, "with the halved hit");
  assert.equal(heroRows(m2)[0]?.status, "applied");
  assert.equal(holdWaitMs(), 3 * 20_000 + 20_000, "holdWaitMs = 3T + 20 s");
  benedikt.items.delete(benParry.id);
  void c;
  console.log("ok H19 Parry then hero tokens: non-lethal after the halving asks nothing, halved numbers, holdWaitMs");
}

/* ======================================================================== */
/*  H20: an NPC trigger pays Malice                                          */
/* ======================================================================== */
{
  await fresh({ maliceValue: 5 });
  // Dame Cornelia's Parry! would react to Arixx's damage too (she is on the scene): off the scene here.
  START.tokens.delete(tCornelia.id);
  const skitter = itemOn(tArixx, "Skitter") ?? ability(tArixx.actor, "Skitter", { dsid: "skitter", type: "triggered", resource: 2, target: { type: "self" } });
  skitter.system.resource = 2;
  const c = fight([tBorin, tArixx]);
  await set("triggersEnabled", true);
  answerFn = rec => (rec.kind === "trigger" ? "use" : undefined);
  const n = markMsgs();
  const m = await hit(borinStrike, tArixx, 10);
  const trig = since(n, x => getResolution(x)?.shape === "trigger");
  assert.equal(trig.length, 1, "a trigger card for Skitter");
  const res = getResolution(trig[0]);
  const pay = Object.values(res.ops).find(o => o.kind === "resource");
  assert.equal(pay.resource, "malice", "an NPC pays from the Malice pool");
  assert.equal(pay.amount, -2);
  assert.equal(pay.status, "applied");
  assert.equal(malice(), 3, "Malice 5 - 2");
  assert.equal(pay.before.value, 5);
  assert.equal(pay.after.value, 3);
  assert.equal(dmgOps(m)[0].finalAmount, 5, "the hit was halved");
  // Undo the trigger card's cost: +2 back.
  await api.undoOps(trig[0].id, [pay.opId]);
  await settleAll();
  assert.equal(malice(), 5, "undo gives the Malice back");
  // Malice 1: not offered.
  await nextRound(c);
  await worldSet("malice", 1);
  const d0 = dialogs.filter(d => d.kind === "trigger").length;
  await hit(borinStrike, tArixx, 4);
  assert.equal(dialogs.filter(d => d.kind === "trigger").length, d0, "Malice 1 < cost 2: Skitter not offered");
  await set("triggersEnabled", false);
  START.tokens.set(tCornelia.id, tCornelia);
  console.log("ok H20 NPC trigger Malice: cost row on the trigger card, Malice -2, undo +2, not offered when the pool is short");
}

/* ======================================================================== */
/*  H21: relay malice                                                        */
/* ======================================================================== */
{
  await fresh({ maliceValue: 3 });
  const note = "test adjust";
  const r = await api.malice.adjust(2, { reason: note });
  assert.equal(r.ok, true);
  assert.deepEqual([r.before, r.after], [3, 5]);
  assert.equal(malice(), 5);
  const card = messages.get(r.messageId);
  assert.equal(getResolution(card).malice.reason, note);
  await as(player, async () => {
    await assert.rejects(api.malice.adjust(1), /Denied/, "a player is denied");
  });
  const r2 = await api.malice.adjust(-6);
  assert.equal(r2.ok, false);
  const op2 = Object.values(getResolution(messages.get(r2.messageId)).ops)[0];
  assert.equal(op2.status, "failed");
  assert.equal(op2.reason, "notEnoughMalice", "a cost is never clamped silently");
  assert.equal(malice(), 5);
  log.settingsSets.length = 0;
  await api.undoOps(r.messageId, null);
  await settleAll();
  assert.equal(malice(), 3, "undo");
  assert.ok(log.settingsSets.some(s => s.key === "draw-steel.malice" && s.options.dsblQuiet), "the undo write is quiet");
  // Two Malice cards in the same tick: both deltas land (one world chain).
  const [x, y] = await Promise.all([api.malice.adjust(4), api.malice.adjust(-2)]);
  assert.ok(x.ok && y.ok, "both applied");
  assert.equal(malice(), 5, "3 + 4 - 2");
  await assert.rejects(api.malice.adjust(51), /BadRequest/, "|delta| <= 50");
  console.log("ok H21 Malice cards: before/after, player denied, notEnoughMalice, quiet undo, same tick both land");
}

/* ======================================================================== */
/*  H22: Malice reminders                                                    */
/* ======================================================================== */
{
  await fresh({ maliceValue: 5 });
  const tMonarch2 = npcToken(monarchA, "Goblin Monarch (2)", 13, 9);
  const c = fight([tBorin, tMonarch, tMonarch2]);
  const remindersNow = () => [...messages.values()].filter(m => m.flags?.["stef-ds-automation"]?.maliceReminder);
  await activate(c, tMonarch);
  await settleAll();
  let rems = remindersNow();
  assert.equal(rems.length, 1, "one reminder whisper at the monster's turn start");
  const rem = rems[0];
  assert.deepEqual([...rem.whisper].sort(), [gm.id, gm2.id].sort(), "whispered to the Directors");
  const names = rem.flags["stef-ds-automation"].maliceReminder.items.map(i => i.name).sort();
  assert.deepEqual(names, ["Goblin Mode", "Swarm"], `type none features with a cost <= 5: ${names}`);
  // A second goblin of the same kind that round with the same pool: none.
  await endTurn(c);
  await activate(c, tMonarch2);
  await settleAll();
  assert.equal(remindersNow().length, 1, "same features, same pool, same round: no second whisper");
  // The pool changed: a new one.
  await endTurn(c);
  await worldSet("malice", 3);
  await nextRound(c);
  await activate(c, tMonarch);
  await settleAll();
  rems = remindersNow();
  assert.equal(rems.length, 2, "a new round / pool: a new whisper");
  assert.deepEqual(rems[1].flags["stef-ds-automation"].maliceReminder.items.map(i => i.name), ["Goblin Mode"], "only what Malice 3 pays");
  // Off: none.
  await endTurn(c);
  await set("maliceReminders", false);
  await nextRound(c);
  await activate(c, tMonarch);
  await settleAll();
  assert.equal(remindersNow().length, 2, "off: none");
  // The Use buttons: a GM's click runs item.system.use; a player's buttons stay disabled.
  const root = new El("li");
  const div = new El("div");
  div.className = "ds-auto-malice-reminder";
  div.innerHTML = rem.content;
  root.append(div);
  render(rem, gm, root);
  const button = root.querySelector("button[data-uuid]");
  assert.ok(button && !button.disabled, "wired on a GM client");
  button.click();
  await settleAll();
  assert.equal(log.uses.length, 1, "the system's use ran");
  assert.equal(log.uses[0].user, gm.id);
  const proot = render(rem, player);
  const pbuttons = proot.querySelectorAll("button[data-uuid]");
  assert.ok(pbuttons.length && pbuttons.every(b => b.disabled), "a player's buttons are disabled (the list is built from the flag)");
  START.tokens.delete(tMonarch2.id);
  console.log("ok H22 reminders: one whisper per round and pool, only payable type-none features, off, Use on a GM client only");
}

/* ======================================================================== */
/*  H23: villain actions                                                     */
/* ======================================================================== */
{
  await fresh();
  game.modules.set("draw-steel-delian-tomb", { active: true });
  const c = fight([tBorin, tArixx, tCornelia, tBargnot]);
  const spew = itemOn(tArixx, "Acid Spew");
  const codes = m => (getResolution(messages.get(m.id))?.warnings ?? []).map(w => w.code);
  const villainWhispers = () => log.whispers.filter(w => /DSAUTO\.Villain\./.test(w.content));
  const v1 = useCard(spew, { author: gm });
  await idle();
  await settleAll();
  assert.deepEqual(api.villain.used(tArixx).map(u => u.name), ["Acid Spew"], "first use recorded");
  assert.ok(!codes(v1).includes("villainActionReused"));
  // The same action again (observer first): whisper + reused banner.
  await nextRound(c);
  const v2 = useCard(spew, { author: gm });
  await idle();
  await settleAll();
  assert.ok(codes(v2).includes("villainActionReused"), `reused banner: ${codes(v2)}`);
  assert.ok(villainWhispers().some(w => /Villain\.Reused/.test(w.content)), "a whisper");
  // Resolve first (no observer yet): the warning comes from the flag, this message's own entries excluded.
  const ghost = { id: "ghostmessage0001", speaker: { scene: START.id } };
  assert.deepEqual(villainMod.villainWarnings(spew, ghost).map(w => w.code), ["villainActionReused", "villainActionRound"], "resolve-first order agrees");
  // Another villain's action in the same round (Cornelia, then Bargnot): round banner and a whisper naming Cornelia's.
  await nextRound(c);
  const vc = useCard(itemOn(tCornelia, "Rally the Line"), { author: gm });
  await idle();
  const vb = useCard(itemOn(tBargnot, "Oversurge"), { author: gm });
  await idle();
  await settleAll();
  assert.ok(!codes(vc).includes("villainActionRound"));
  assert.ok(codes(vb).includes("villainActionRound"), `round banner: ${codes(vb)}`);
  assert.ok(villainWhispers().some(w => /Villain\.Again.*Rally the Line/.test(w.content)), "the whisper names Cornelia's action");
  // Bargnot's Oversurge: her own row "Dazed until her turn ends".
  const daze = opsOf(vb).find(o => o.kind === "condition");
  assert.ok(daze, `Oversurge's self row: ${JSON.stringify(opsOf(vb).map(o => [o.kind, o.status]))}`);
  // Next round: none.
  await nextRound(c);
  const vb2 = useCard(itemOn(tBargnot, "Oversurge"), { author: gm });
  await idle();
  await settleAll();
  assert.ok(!codes(vb2).includes("villainActionRound"), "next round: no round banner");
  assert.ok(codes(vb2).includes("villainActionReused"), "but Oversurge was used before");
  // deleteChatMessage retracts its entries.
  await vb2.delete();
  await vb.delete();
  await settleAll();
  assert.deepEqual(api.villain.used(tBargnot), [], "Bargnot's entries are gone with her cards");
  await api.villain.reset(null, c);
  await settleAll();
  assert.deepEqual(api.villain.used(tArixx, c), [], "api.villain.reset");
  console.log("ok H23 villain actions: recorded, reuse banner + whisper (both orders), round banner + whisper, delete retracts, reset");
}

/* ======================================================================== */
/*  Zones: helpers                                                           */
/* ======================================================================== */
/** The card of a zone ability by `author` (no power roll: the zone row sits on the user's own row). */
async function zoneCard(item, { author = player2, useEffects = null } = {}) {
  const msg = useCard(item, { author });
  if (useEffects) {
    const use = msg.system.parts.get("abilityUse000000");
    if (use) use.effects = useEffects;
  }
  await idle();
  await settleAll();
  return messages.get(msg.id) ?? msg;
}
/** Place a zone row on `user`'s client: the Place button with these region clicks (pixel points, "skip", "esc"). */
async function placeZone(user, msg, points, op = zoneOp(msg)) {
  regionClicks(user, ...points);
  await as(user, () => placeMod.runZonePick({ message: messages.get(msg.id) ?? msg, res: getResolution(messages.get(msg.id) ?? msg), op, request: requestOp }));
  await idle();
  await settleAll();
  return liveOp(msg, op.opId);
}
/** The wall of T104: 5 squares in a column at x = 7, rows 3-7 (Borin stands at (5,5)). */
const WALL = [[7, 3], [7, 4], [7, 5], [7, 6], [7, 7]];
async function wallOfFireUp(cells = WALL, { user = player2 } = {}) {
  const msg = await zoneCard(wallOfFire, { author: user });
  const op = await placeZone(user, msg, cells.map(([x, y]) => cell(x, y)));
  const region = op?.regionUuid ? fromUuidSync(op.regionUuid) : null;
  return { msg: messages.get(msg.id), op, region, zoneId: op?.zoneId ?? null };
}
const zoneHitCards = (n, zoneId = null) => zoneCards(n).filter(m => !zoneId || getResolution(m).zone.zoneId === zoneId);
const hitAmount = m => dmgOps(m)[0]?.amount;
const regionOf = zoneId => zoneReg.regionOfZone(zoneId);
/** A hero without a token on any scene (noCreatorToken). */
const OTHER_HERO = mkHero("tokenless0000001", "Tokenless", { owner: player2 });

/* ======================================================================== */
/*  H24: the zone row                                                        */
/* ======================================================================== */
{
  await fresh();
  fight([tBorin, tWarrior]);
  const msg = await zoneCard(wallOfFire);
  const res = getResolution(msg);
  const ops = opsOf(msg);
  assert.equal(ops.length, 1, `one row: ${JSON.stringify(ops.map(o => o.kind))}`);
  const op = ops[0];
  assert.equal(op.kind, "zone");
  assert.equal(res.targets[op.targetKeys[0]].self, true, "on Borin's own row");
  assert.equal(op.mode, "prompt", "never automatic");
  assert.equal(op.status, "pending");
  assert.deepEqual(op.zone.area, { shape: "wall", size: 5, width: 1, count: 5, range: 10 }, "wall 5 within 10");
  assert.equal(op.zone.amount, 1, "amount = R");
  assert.equal(op.zone.perSquare, true);
  assert.equal(op.zone.damageType, "fire");
  assert.equal(op.zone.upkeep, 1);
  assert.equal(op.interactive, true);
  assert.equal(op.creatorTokenUuid, tBorin.uuid);
  const v = viewOf10(msg, player2);
  assert.equal(v.canApplyAll, false, "not counted in Apply all (footer)");
  const row = v.rows.flatMap(r => r.ops).find(o => o.opId === op.opId);
  assert.equal(row.applyAction, "dsAutoZone", "its own Place button");
  assert.equal(row.zoneButton, true);
  assert.match(row.detail, /ZoneWall/);
  await api.applyOps(msg.id, null);
  await settleAll();
  assert.equal(liveOp(msg, op.opId).status, "pending", "Apply all leaves it");
  // Incinerate strained / not strained picks the right effect.
  incinerate.system.effects = new Coll([["strainedE0000001", { id: "strainedE0000001", type: "strained" }]]);
  const plain = await zoneCard(incinerate, { author: player });
  assert.equal(zoneOp(plain)?.label, "Column of fire", "not strained");
  assert.equal(zoneOp(plain)?.zone.area.size, 1);
  const strained = await zoneCard(incinerate, { author: player, useEffects: ["strainedE0000001"] });
  await api.resolve(strained.id, { force: true });
  await settleAll();
  assert.equal(zoneOp(strained)?.label, "Column of fire (strained)", "strained");
  assert.equal(zoneOp(strained)?.zone.area.size, 5, "the strained size");
  assert.deepEqual(zoneOp(strained)?.zone.lasts, ["summonerTurnEnd"]);
  // A detached entry without `affects` uses ZONE_DEFAULTS; noCreatorToken, noArea, formulaInvalid.
  const detached = ability(borin, "Detached Fire", { distance: { type: "cube", primary: 2, secondary: 5 } });
  detached.system.effects = { contents: [{ _id: "dsAutodetach0001", type: "dsAuto.zone", name: "Detached", dsAuto: { effectId: "fire", value: "3", zoneEvents: new Set(["enter"]) } }] };
  const dm = await zoneCard(detached);
  const dop = zoneOp(dm);
  assert.ok(dop, "a zone row from a detached entry");
  assert.equal(dop.zone.affects, "enemies", "ZONE_DEFAULTS.affects");
  assert.deepEqual(dop.zone.lasts, ["summonerTurnStart"], "ZONE_DEFAULTS.lasts");
  assert.equal(dop.zone.once, "round");
  const noArea = ability(borin, "No Area", { distance: { type: "melee", primary: 1 } });
  noArea.system.effects = { contents: [{ _id: "dsAutonoarea0001", type: "dsAuto.zone", name: "No Area", dsAuto: { effectId: "z", value: "1" } }] };
  assert.equal(zoneOp(await zoneCard(noArea))?.reason, "noArea");
  const badFormula = ability(borin, "Bad Formula", { distance: { type: "cube", primary: 2, secondary: 5 } });
  badFormula.system.effects = { contents: [{ _id: "dsAutobadform001", type: "dsAuto.zone", name: "Bad", dsAuto: { effectId: "z", value: "@nope" } }] };
  assert.equal(zoneOp(await zoneCard(badFormula))?.reason, "formulaInvalid");
  const tokenless = ability(OTHER_HERO, "Tokenless Wall", { distance: { type: "wall", primary: 2, secondary: 5 } });
  tokenless.system.effects = { contents: [{ _id: "dsAutotokenl0001", type: "dsAuto.zone", name: "T", dsAuto: { effectId: "z", value: "1" } }] };
  const tl = zoneOp(await zoneCard(tokenless, { author: gm }));
  assert.equal(tl?.reason, "noCreatorToken");
  assert.equal(tl?.noApply, true);
  for (const it of [detached, noArea, badFormula]) borin.items.delete(it.id);
  console.log("ok H24 zone row: self row, prompt, wall 5 within 10, amount R, outside Apply all, Incinerate strained, defaults, noArea / formulaInvalid / noCreatorToken");
}

/* ======================================================================== */
/*  H25: placement on the owner's client                                     */
/* ======================================================================== */
{
  await fresh();
  fight([tBorin, tWarrior]);
  const msg = await zoneCard(wallOfFire);
  const op = zoneOp(msg);
  // A square 11 away is refused (warning), a square touching none (NotConnected), then 5 good ones.
  notes.length = 0;
  log.relay.length = 0;
  const after = await placeZone(player2, msg, [cell(16, 5), cell(7, 3), cell(9, 9), cell(7, 4), cell(7, 5), cell(7, 6), cell(7, 7)], op);
  const refused = log.confirms.filter(x => x.result === false).length;
  assert.equal(refused, 2, "two shapes refused by preConfirm");
  assert.ok(notes.some(x => x.user === player2.id && /Zone\.TooFar/.test(x.text)), "too far warned");
  assert.ok(notes.some(x => x.user === player2.id && /Zone\.NotConnected/.test(x.text)), "not connected warned");
  assert.equal(log.placeRegion[0].create, false, "placeRegion(create: false)");
  assert.equal(log.placeRegion[0].shapes, 5, "five wall shapes (zoneShapes)");
  const sent = relayed("apply").at(-1);
  const place = sent.data.zonePlaces[op.opId];
  assert.equal(place.shapes.length, 5);
  for (const sh of place.shapes) assert.deepEqual(Object.keys(sh).sort(), ["rotation", "x", "y"], "only {x, y, rotation} per shape");
  assert.equal(after.status, "applied", `placed: ${after.reason}`);
  // Escape: nothing sent.
  const msg2 = await zoneCard(wallOfFire);
  log.relay.length = 0;
  await placeZone(player2, msg2, ["esc"]);
  assert.equal(relayed("apply").length, 0, "Escape sends nothing");
  // A view on another scene: NeedsCanvas.
  view(player2, OTHER);
  notes.length = 0;
  await placeZone(player2, msg2, []);
  assert.ok(notes.some(x => /Zone\.NeedsCanvas/.test(x.text)), "needs the creator's scene");
  views.clear();
  // The card's own system template on the scene: "Use the placed template" sends its shapes.
  const tpl = (await START.createEmbeddedDocuments("Region", [{
    name: "Wall of Fire", shapes: [{ type: "rectangle", x: 350, y: 1050, width: 100, height: 100, anchorX: 0.5, anchorY: 0.5, rotation: 0 }, { type: "rectangle", x: 450, y: 1050, width: 100, height: 100, anchorX: 0.5, anchorY: 0.5, rotation: 0 }],
    flags: { "draw-steel": { abilitySource: wallOfFire.uuid } },
  }]))[0];
  answerFn = rec => (rec.kind === "template" ? "template" : undefined);
  log.relay.length = 0;
  const op2 = await placeZone(player2, msg2, []);
  const sent2 = relayed("apply").at(-1);
  assert.deepEqual(sent2.data.zonePlaces[zoneOp(msg2).opId].shapes.map(sh => [sh.x, sh.y]), [[350, 1050], [450, 1050]], "the template's shapes");
  assert.equal(op2.status, "applied");
  assert.equal(op2.squares, 2);
  START.regions.delete(tpl.id);
  console.log("ok H25 placement: preConfirm refusals warned, create:false, only {x, y, rotation} relayed, Escape, NeedsCanvas, the card's own template");
}

/* ======================================================================== */
/*  H26: creation on the GM                                                  */
/* ======================================================================== */
{
  await fresh();
  const c = fight([tBorin, tWarrior]);
  const { msg, op, region, zoneId } = await wallOfFireUp();
  assert.equal(op.status, "applied");
  assert.equal(op.squares, 5, "5 squares placed");
  const create = log.regionCreates.at(-1);
  assert.equal(create.data.flags?.["draw-steel"]?.abilitySource, undefined, "no abilitySource (Combat Tools and Target Damage never see it)");
  assert.equal(create.options["stef-ds-automation"]?.internal, true);
  assert.equal(create.data.behaviors.length, 1);
  assert.equal(create.data.behaviors[0].type, "stef-ds-automation.zone", "the behavior inline");
  assert.equal(create.data.ownership[player2.id], 2, "OBSERVER for the creator's owner");
  assert.equal(create.data.ownership.default, 0);
  const flag = region.flags["stef-ds-automation"].zone;
  for (const k of ["zoneId", "messageId", "opId", "itemUuid", "label", "creatorActorUuid", "creatorTokenUuid", "creatorTokenId", "sceneId", "combatId", "createdRound", "lasts", "upkeep", "armStart", "armEnd"]) {
    assert.ok(k in flag, `flag field ${k}`);
  }
  assert.equal(flag.zoneId, zoneId);
  assert.equal(flag.messageId, msg.id);
  assert.equal(flag.combatId, c.id);
  const sys = zoneReg.zoneBehavior(region).system;
  assert.equal(sys.zoneId, zoneId);
  assert.equal(sys.amount, 1);
  assert.equal(sys.perSquare, true);
  assert.equal(sys.damageType, "fire");
  assert.ok(zoneReg.zoneOf(region), "ours");
  for (const sh of region.shapes) assert.equal(sh.width, 100, "sizes from the GM (100 px squares)");
  // The GM's checks: 6 shapes for a 5-square wall, two separated groups, a far shape: refused.
  const bad = async (shapes, reason, label) => {
    const m = await zoneCard(wallOfFire);
    const id = zoneOp(m).opId;
    await as(player2, () => requestOp({ action: "apply", messageId: m.id, opIds: [id], zonePlaces: { [id]: { shapes } } }));
    await settleAll();
    assert.equal(liveOp(m, id).status, "failed", label);
    assert.equal(liveOp(m, id).reason, reason, `${label}: ${liveOp(m, id).reason}`);
  };
  await bad([7, 8, 9, 10, 11, 12].map(y => ({ x: 750, y: y * 100 + 50, rotation: 0 })), "badZonePlace", "6 shapes");
  await bad([{ x: 750, y: 350, rotation: 0 }, { x: 750, y: 650, rotation: 0 }], "badZonePlace", "two separated groups");
  await bad([{ x: 1650, y: 550, rotation: 0 }], "tooFar", "11 squares away");
  // Client sizes: the relay refuses any key but x, y, rotation.
  const m2 = await zoneCard(wallOfFire);
  const id2 = zoneOp(m2).opId;
  await as(player2, async () => {
    await assert.rejects(requestOp({ action: "apply", messageId: m2.id, opIds: [id2], zonePlaces: { [id2]: { shapes: [{ x: 750, y: 350, width: 900 }] } } }), /BadRequest/, "client sizes refused");
    await assert.rejects(requestOp({ action: "apply", messageId: m2.id, opIds: [id2], zonePlaces: { [id2]: { shapes: [{ x: 750, y: 350 }] } }, places: { [id2]: { squares: [{ x: 700, y: 300 }] } } }), /BadRequest/, "zonePlaces with places on the same op refused");
  });
  // Combat Tools' template sweep and Target Damage's retarget stand-ins look for abilitySource: ours untouched.
  const swept = START.regions.filter(r => r.flags?.["draw-steel"]?.abilitySource);
  assert.equal(swept.length, 0, "nothing for Combat Tools to sweep");
  // An aura: attached to the creator, hidden like a hidden creator, nothing to pick.
  tBorin._source.hidden = true;
  const am = await zoneCard(aura);
  const aop = zoneOp(am);
  assert.equal(aop.interactive, false);
  log.placeRegion.length = 0;
  const aplaced = await placeZone(player2, am, [], aop);
  assert.equal(log.placeRegion.length, 0, "no squares asked");
  assert.equal(aplaced.status, "applied");
  const ar = fromUuidSync(aplaced.regionUuid);
  assert.equal(ar.attachment?.token, tBorin.id, "attached to the creator");
  assert.equal(ar.hidden, true, "hidden like its creator");
  assert.equal(ar.shapes[0].type, "emanation");
  tBorin._source.hidden = false;
  console.log("ok H26 creation: no abilitySource, inline behavior, OBSERVER, flags, GM-side sizes, 6 shapes / gap / far refused, client sizes refused, aura attached and hidden");
}

/* ======================================================================== */
/*  H27: enter (exit 2)                                                      */
/* ======================================================================== */
{
  await fresh();
  const c = fight([tBorin, tWarrior, tAssassin]);
  const { zoneId, region } = await wallOfFireUp();
  // The goblin drags across the wall from 6 squares away: in + out in one movement -> one card, 1 square, 1 fire.
  tWarrior._source.x = 10 * G;
  tWarrior._source.y = 6 * G;
  let n = markMsgs();
  const s0 = tWarrior.actor.system.stamina.value;
  await moveTokenPath(tWarrior, [lineCells(tWarrior, 4, 6)]);
  await advance(100);
  await settleAll();
  let hits = zoneHitCards(n, zoneId);
  assert.equal(hits.length, 1, `one hit card: ${hits.length}`);
  const r = getResolution(hits[0]);
  assert.equal(r.zone.squares, 1, "1 square");
  assert.equal(r.zone.via, "enter");
  assert.equal(hitAmount(hits[0]), 1, "1 x R");
  assert.equal(dmgOps(hits[0])[0].type, "fire");
  assert.match(r.abilityName, /Zone\.HitFlavor.*Wall of fire/, `title: ${r.abilityName}`);
  assert.equal(tWarrior.actor.system.stamina.value, s0 - 1);
  assert.equal(zoneLedger.zoneHitOf(c, zoneId, tWarrior.actor.uuid, "enter")?.messageId, hits[0].id, "the credit");
  // Back across in the same round: nothing.
  n = markMsgs();
  await moveTokenPath(tWarrior, [lineCells(tWarrior, 10, 6)]);
  await advance(100);
  await settleAll();
  assert.equal(zoneHitCards(n).length, 0, "once per round");
  // tokenEnter (movement null: a region created or moved onto a creature): not subscribed.
  n = markMsgs();
  regionEvent(region, "tokenEnter", { token: tAssassin, movement: null }, gm);
  regionEvent(region, "tokenMoveIn", { token: tAssassin, movement: null }, gm);
  await advance(100);
  await settleAll();
  assert.equal(zoneHitCards(n).length, 0, "no movement: nothing");
  // A non-active GM client does nothing: the hit above came once although every client got the events.
  assert.equal(log.relay.filter(x => x.action === "damage").length, 0, "no client asked for damage");
  // A copied region with the same zoneId and a hand-added behavior: not ours (logged), nothing.
  const copy = (await START.createEmbeddedDocuments("Region", [{ ...clone(region.data), _id: undefined, name: "Copy", behaviors: [{ type: "stef-ds-automation.zone", system: clone(region.data.behaviors[0].system) }] }]))[0];
  assert.equal(zoneReg.zoneOf(copy), null, "a copy is not ours");
  tAssassin._source.x = 10 * G;
  tAssassin._source.y = 3 * G;
  START.regions.delete(region.id);   // only the copy is on the path now
  n = markMsgs();
  await moveTokenPath(tAssassin, [lineCells(tAssassin, 4, 3)]);
  await advance(100);
  await settleAll();
  assert.equal(zoneHitCards(n).length, 0, "the copy hits nobody");
  START.regions.set(region.id, region);
  START.regions.delete(copy.id);
  void c;
  console.log("ok H27 enter: one card for a pass-through (1 square, R fire), once per round, movement null ignored, copies ignored");
}

/* ======================================================================== */
/*  H28: squares                                                             */
/* ======================================================================== */
{
  await fresh();
  const c = fight([tBorin, tWarrior, tAssassin, tBigGob, tStabby]);
  // A horizontal wall at row 9, columns 3-7.
  const { zoneId } = await wallOfFireUp([[3, 9], [4, 9], [5, 9], [6, 9], [7, 9]]);
  // A ruler drag: 5 approach segments (continued, pending waypoints), then 3 wall squares: ONE card of 3 squares.
  tWarrior._source.x = 0;
  tWarrior._source.y = 4 * G;
  let n = markMsgs();
  view(gm, OTHER);   // geometry from scene.grid, not the viewed canvas
  await moveTokenPath(tWarrior, [[[0, 5]], [[0, 6]], [[0, 7]], [[1, 8]], [[2, 9]], [[3, 9], [4, 9], [5, 9]]]);
  await advance(100);
  await settleAll();
  let hits = zoneHitCards(n, zoneId);
  assert.equal(hits.length, 1, `one card for the whole drag: ${hits.length}`);
  assert.equal(getResolution(hits[0]).zone.squares, 3, "3 wall squares");
  assert.equal(hitAmount(hits[0]), 3, "3 x R");
  // Continued segments: the tally waits for the last one (C3): no card while waypoints are pending.
  tAssassin._source.x = 2 * G;
  tAssassin._source.y = 8 * G;
  n = markMsgs();
  const mvId = "mvcontinued00001";
  const wp = ([x, y]) => ({ x: x * G, y: y * G, width: 1, height: 1, action: "walk" });
  const seg1 = { id: mvId, origin: wp([2, 8]), passed: { waypoints: [[3, 9], [4, 9]].map(wp) }, pending: { waypoints: [[5, 9], [6, 9]].map(wp) } };
  await tAssassin.update({ x: 4 * G, y: 9 * G });
  regionEvent(regionOf(zoneId), "tokenMoveIn", { token: tAssassin, movement: seg1 }, gm);
  await advance(2_000);
  await settleAll();
  assert.equal(zoneHitCards(n, zoneId).length, 0, "no card while the movement continues");
  const seg2 = { id: mvId, origin: wp([4, 9]), passed: { waypoints: [[5, 9], [6, 9]].map(wp) }, pending: { waypoints: [] } };
  await tAssassin.update({ x: 6 * G, y: 9 * G });
  regionEvent(regionOf(zoneId), "tokenMoveWithin", { token: tAssassin, movement: seg2 }, gm);
  await advance(100);
  await settleAll();
  hits = zoneHitCards(n, zoneId);
  assert.equal(hits.length, 1, "one card once the last segment came");
  assert.equal(getResolution(hits[0]).zone.squares, 4, "squares of both segments");
  // A Combat Tools push of 3 one-square updates 400 ms apart: one card, 3 squares (forced idle 1.2 s).
  await nextRound(c);
  tWarrior._source.x = 2 * G;
  tWarrior._source.y = 9 * G;
  n = markMsgs();
  await pushCells(tWarrior, [[3, 9], [4, 9], [5, 9]]);
  assert.equal(zoneHitCards(n).length, 0, "still joining while the updates keep coming");
  await advance(1_300);
  await settleAll();
  hits = zoneHitCards(n, zoneId);
  assert.equal(hits.length, 1, "one card for the push");
  assert.equal(getResolution(hits[0]).zone.squares, 3, "3 squares");
  // A teleport landing on the wall across 4 wall squares: only the destination footprint.
  tStabby._source.x = 2 * G;
  tStabby._source.y = 9 * G;
  n = markMsgs();
  await moveTokenPath(tStabby, [[[7, 9]]], { action: "teleport" });
  await advance(100);
  await settleAll();
  hits = zoneHitCards(n, zoneId);
  assert.equal(hits.length, 1);
  assert.equal(getResolution(hits[0]).zone.squares, 1, "the landing square only");
  // A 2x2 creature starting its turn on 2 wall squares: 2 x R; the origin footprint of a move never counts.
  tBigGob._source.x = 4 * G;
  tBigGob._source.y = 8 * G;   // covers (4,8)(5,8)(4,9)(5,9): 2 wall squares
  n = markMsgs();
  await activate(c, tBigGob);
  await settleAll();
  hits = zoneHitCards(n, zoneId);
  assert.equal(hits.length, 1, "turn start inside");
  assert.equal(getResolution(hits[0]).zone.squares, 2, "2 squares of the footprint");
  assert.equal(hitAmount(hits[0]), 2);
  const origin = shapesMod.pathSquares(tBigGob, regionOf(zoneId), {
    origin: { x: 4 * G, y: 8 * G, width: 2, height: 2 }, passed: { waypoints: [{ x: 4 * G, y: 7 * G, width: 2, height: 2, action: "walk" }] },
  });
  assert.equal(origin.size, 0, "moving off: the origin footprint's squares never count");
  views.clear();
  console.log("ok H28 squares: one card per drag (continued segments), push joined over 1.2 s, teleport counts the landing, footprints, scene grid");
}

/* ======================================================================== */
/*  H29: turn start (lifecycle)                                              */
/* ======================================================================== */
{
  await fresh();
  const c = fight([tBorin, tWarrior, tArixx, tSpine1, tSpine2, tSpine3], { groups: [{ name: "Spinecleavers", members: [tSpine1, tSpine2, tSpine3], pool: 15 }] });
  const { zoneId, region } = await wallOfFireUp();
  // Inside at its turn start: a card.
  tWarrior._source.x = 7 * G;
  tWarrior._source.y = 5 * G;
  let n = markMsgs();
  await activate(c, tWarrior);
  await settleAll();
  let hits = zoneHitCards(n, zoneId);
  assert.equal(hits.length, 1, "turn start inside: one card");
  assert.equal(getResolution(hits[0]).zone.via, "turnStart");
  await endTurn(c);
  // Entered earlier this round -> another card at its turn start (onceShared false): the assassin walks in, then acts.
  await nextRound(c);
  tWarrior._source.x = 9 * G;
  n = markMsgs();
  await moveTokenPath(tWarrior, [lineCells(tWarrior, 7, 5)]);
  await advance(100);
  await settleAll();
  await activate(c, tWarrior);
  await settleAll();
  hits = zoneHitCards(n, zoneId);
  assert.deepEqual(hits.map(h => getResolution(h).zone.via), ["enter", "turnStart"], "enter and turn start are separate credits");
  await endTurn(c);
  // onceShared: true -> the turn start finds the shared credit taken.
  zoneReg.zoneBehavior(region).system.onceShared = true;
  await nextRound(c);
  tWarrior._source.x = 9 * G;
  n = markMsgs();
  await moveTokenPath(tWarrior, [lineCells(tWarrior, 7, 5)]);
  await advance(100);
  await settleAll();
  await activate(c, tWarrior);
  await settleAll();
  assert.deepEqual(zoneHitCards(n, zoneId).map(h => getResolution(h).zone.creditKey), ["any"], "onceShared: one hit");
  await endTurn(c);
  zoneReg.zoneBehavior(region).system.onceShared = false;
  // A solo monster's second activation inside: a second card (turnStart:<activation>).
  await nextRound(c);
  tArixx._source.x = 7 * G;
  tArixx._source.y = 4 * G;   // 2x2 on (7,4)(8,4)(7,5)(8,5): 2 wall squares
  n = markMsgs();
  await activate(c, tArixx);
  await endTurn(c);
  await activate(c, tArixx);
  await settleAll();
  hits = zoneHitCards(n, zoneId);
  assert.deepEqual(hits.map(h => getResolution(h).zone.creditKey), ["turnStart:1", "turnStart:2"], "one per activation");
  // Combat Tools' duplicate turn start of the same activation: nothing extra (the lifecycle dedupes).
  n = markMsgs();
  await asGM(() => foundry.documents.ActiveEffect.registry.refresh("turnStart", { combat: c, round: c.round, turn: c.turn }));
  await settleAll();
  assert.equal(zoneHitCards(n).length, 0, "a duplicated turnStart adds nothing");
  await endTurn(c);
  // Squad members each once (Combat Tools' squad turns).
  await game.settings.set("draw-steel-combat-tools", "squadSimultaneousTurns", true);
  await nextRound(c);
  for (const [t, x] of [[tSpine1, 7], [tSpine2, 7]]) {
    t._source.x = x * G;
  }
  tSpine1._source.y = 6 * G;
  tSpine2._source.y = 7 * G;
  n = markMsgs();
  await activate(c, tSpine1);
  // Combat Tools' squad turns: the refresh for every other member with a proxy combat (squad-turns.mjs:40-90), twice.
  for (let k = 0; k < 2; k++) {
    for (const t of [tSpine2, tSpine3]) {
      const m = cmbOf(c, t);
      const proxy = new Proxy(c, { get: (target, key) => (key === "combatant" ? m : target[key]) });
      await asGM(() => foundry.documents.ActiveEffect.registry.refresh("turnStart", { combat: proxy, round: c.round }));
    }
  }
  await settleAll();
  hits = zoneHitCards(n, zoneId);
  assert.equal(hits.length, 2, `one card per member inside (no third from the duplicates): ${hits.length}`);
  await game.settings.set("draw-steel-combat-tools", "squadSimultaneousTurns", false);
  console.log("ok H29 turn start: inside -> card, enter + turn start, onceShared, solo monster twice, duplicates nothing, squad members each once");
}

/* ======================================================================== */
/*  H30-H32: filters, same instant, Swamp Gas                                */
/* ======================================================================== */
{
  await fresh();
  game.modules.set("draw-steel-delian-tomb", { active: true });
  const c = fight([tBorin, tBen, tWarrior, tStinker, tToxin, tMastermind, tCornelia]);
  // Enemies only (Wall of Fire): Benedikt walks through: nothing; the goblin: a card.
  const { zoneId } = await wallOfFireUp();
  tBen._source.x = 6 * G;
  tBen._source.y = 4 * G;
  let n = markMsgs();
  await moveTokenPath(tBen, [lineCells(tBen, 8, 4)]);
  await advance(100);
  await settleAll();
  assert.equal(zoneHitCards(n, zoneId).length, 0, "an ally of the creator: nothing");
  // The creator never.
  n = markMsgs();
  await moveTokenPath(tBorin, [lineCells(tBorin, 8, 5)]);
  await advance(100);
  await settleAll();
  assert.equal(zoneHitCards(n, zoneId).length, 0, "the creator: nothing");
  // Swamp Gas: affects all minus goblins; move/none/perSquare: 3 squares in one drag -> one card 6 poison.
  const gas = await zoneCard(itemOn(tStinker, "Swamp Gas"), { author: gm });
  const gop = await placeZone(gm, gas, [cell(8, 10, { corner: true })]);
  assert.equal(gop.status, "applied", `gas placed: ${gop.reason}`);
  assert.equal(gop.squares, 9, "a 3 cube");
  const gasId = gop.zoneId;
  tBorin._source.x = 7 * G;
  tBorin._source.y = 11 * G;
  n = markMsgs();
  await moveTokenPath(tBorin, [lineCells(tBorin, 11, 11)]);
  await advance(100);
  await settleAll();
  let hits = zoneHitCards(n, gasId);
  assert.equal(hits.length, 1, "Borin: one card for the drag");
  assert.equal(getResolution(hits[0]).zone.squares, 3);
  assert.equal(hitAmount(hits[0]), 6, "3 squares x 2 poison");
  assert.equal(dmgOps(hits[0])[0].type, "poison");
  // Another move: another card (once none).
  n = markMsgs();
  await moveTokenPath(tBorin, [lineCells(tBorin, 9, 11)]);
  await advance(100);
  await settleAll();
  assert.equal(zoneHitCards(n, gasId).length, 1, "another move, another card");
  // A goblin walks through: nothing (exceptKeywords goblin).
  tWarrior._source.x = 7 * G;
  tWarrior._source.y = 12 * G;
  n = markMsgs();
  await moveTokenPath(tWarrior, [lineCells(tWarrior, 11, 12)]);
  await advance(100);
  await settleAll();
  assert.equal(zoneHitCards(n, gasId).length, 0, "goblins are spared");
  // A push of 3 one-square updates: one card.
  tBen._source.x = 7 * G;
  tBen._source.y = 10 * G;
  n = markMsgs();
  await pushCells(tBen, [[8, 10], [9, 10], [10, 10]]);
  await advance(1_300);
  await settleAll();
  hits = zoneHitCards(n, gasId);
  assert.equal(hits.length, 1, "one card for the push");
  assert.equal(hitAmount(hits[0]), 6);
  // The Delian Tomb Swamp Gas spares the listed goblins by monster key and hits Dame Cornelia.
  const dtGas = await zoneCard(itemOn(tToxin, "Swamp Gas"), { author: gm });
  const dop = await placeZone(gm, dtGas, [cell(14, 14, { corner: true })]);
  assert.equal(dop.status, "applied", `DT gas: ${dop.reason}`);
  tMastermind._source.x = 13 * G;
  tMastermind._source.y = 15 * G;
  tCornelia._source.x = 13 * G;
  tCornelia._source.y = 16 * G;
  n = markMsgs();
  await moveTokenPath(tMastermind, [lineCells(tMastermind, 17, 15)]);
  await moveTokenPath(tCornelia, [lineCells(tCornelia, 17, 16)]);
  await advance(100);
  await settleAll();
  hits = zoneHitCards(n, dop.zoneId);
  assert.deepEqual(hits.map(h => getResolution(h).zone.tokenUuid), [tCornelia.uuid], "the mastermind is spared, Cornelia is hit");
  // Dead creatures and objects never.
  tWarrior.actor.statuses.add("dead");
  assert.equal(zoneEngine.affected(zoneReg.zoneBehavior(regionOf(zoneId)).system, regionOf(zoneId), tWarrior), false, "dead: never");
  tWarrior.actor.statuses.delete("dead");
  tWarrior.actor.system.isObject = true;
  assert.equal(zoneEngine.affected(zoneReg.zoneBehavior(regionOf(zoneId)).system, regionOf(zoneId), tWarrior), false, "objects: never");
  delete tWarrior.actor.system.isObject;
  // Allies (a test zone of Benedikt's with affects allies, made by the GM's edit).
  zoneReg.zoneBehavior(regionOf(zoneId)).system.affects = "allies";
  assert.equal(zoneEngine.affected(zoneReg.zoneBehavior(regionOf(zoneId)).system, regionOf(zoneId), tBen), true, "allies: Benedikt");
  assert.equal(zoneEngine.affected(zoneReg.zoneBehavior(regionOf(zoneId)).system, regionOf(zoneId), tWarrior), false, "allies: not the goblin");
  zoneReg.zoneBehavior(regionOf(zoneId)).system.affects = "enemies";
  void c;
  console.log("ok H30/H32 filters and Swamp Gas: enemies, creator never, goblins spared, per-square move hits, push joined, Delian Tomb list by key, dead / objects, allies");
}
{
  // H31: a forced move into the area at the start of its turn: two credits by default, one with onceShared.
  await fresh();
  const c = fight([tBorin, tWarrior]);
  const { zoneId, region } = await wallOfFireUp();
  // Pushed into the wall, then its turn starts the same round: enter and turn start are two credits.
  tWarrior._source.x = 9 * G;
  tWarrior._source.y = 5 * G;
  let n = markMsgs();
  await pushCells(tWarrior, [[8, 5], [7, 5]]);
  await advance(1_300);
  await settleAll();
  await activate(c, tWarrior);
  await settleAll();
  assert.deepEqual(zoneHitCards(n, zoneId).map(h => getResolution(h).zone.creditKey), ["enter", "turnStart:1"], "enter and turn start: two credits");
  await endTurn(c);
  // onceShared: the push and the same round's turn start share one credit.
  zoneReg.zoneBehavior(region).system.onceShared = true;
  await nextRound(c);
  tWarrior._source.x = 9 * G;
  n = markMsgs();
  await pushCells(tWarrior, [[8, 5], [7, 5]]);
  await advance(1_300);
  await settleAll();
  await activate(c, tWarrior);
  await settleAll();
  assert.equal(zoneHitCards(n, zoneId).length, 1, "onceShared: one");
  console.log("ok H31 same instant: two credits by default, one shared");
}

/* ======================================================================== */
/*  H33: the Stamina chain                                                   */
/* ======================================================================== */
const zoneEnded = (msg, opId) => liveOp(msg, opId)?.ended?.reason ?? null;
{
  await fresh({ tokens: 3 });
  const c = fight([tBorin, tWarrior, tArixx]);
  const { zoneId } = await wallOfFireUp();
  // A zone hit and a burning tick at the same turn start: one after the other on the goblin's chain.
  tWarrior._source.x = 7 * G;
  tWarrior._source.y = 5 * G;
  const [burn] = await tWarrior.actor.createEmbeddedDocuments("ActiveEffect", [{ name: "Burning", flags: { "stef-ds-automation": { ongoing: { formula: "3", type: "fire", when: "turnStart" } } } }]);
  burn.uuid = `${tWarrior.actor.uuid}.ActiveEffect.${burn.id}`;
  registry.set(burn.uuid, burn);
  const s0 = tWarrior.actor.system.stamina.value;
  const n = markMsgs();
  await activate(c, tWarrior);
  await settleAll();
  const cards = since(n, m => !!getResolution(m)?.ongoing || !!getResolution(m)?.zone);
  assert.deepEqual(cards.map(m => (getResolution(m).ongoing ? "tick" : "zone")), ["tick", "zone"], "the tick first, then the zone hit (registration order)");
  assert.ok(cards.every(m => dmgOps(m)[0].status === "applied"), "both applied");
  assert.equal(tWarrior.actor.system.stamina.value, s0 - 3 - 1, "both writes landed");
  await endTurn(c);
  // Detached when a hero-token prompt may open: a lethal hit on Borin (2+ tokens) at his turn start never stalls the queue.
  await nextRound(c);
  const puddle = await zoneCard(itemOn(tArixx, "Acid Spew"), { author: gm });
  const pop = await placeZone(gm, puddle, [cell(13, 12, { corner: true })]);
  assert.equal(pop.status, "applied", `puddle: ${pop.reason}`);
  tBorin._source.x = 13 * G;
  tBorin._source.y = 12 * G;
  await setStamina(borin, 1);
  answerFn = () => undefined;   // the hero-token dialog stays open
  await activate(c, tBorin);
  await settle(80);
  assert.equal(tokenDialogs().filter(d => !d.closed).length, 1, "the hero-token prompt is open");
  // The lifecycle queue is free: the next turn events run while the prompt is open.
  const t0 = Date.now();
  await within(3_000, (async () => { await endTurn(c); await activate(c, tWarrior); })(), "the next turn while the prompt is open");
  assert.ok(Date.now() - t0 < 3_000);
  tokenDialogs().at(-1).click("decline");
  await settleAll();
  void zoneId;
  console.log("ok H33 Stamina chain: tick then zone hit in order, a lethal hero hit detached from the lifecycle queue");
}

/* ======================================================================== */
/*  H34: zone undo                                                           */
/* ======================================================================== */
{
  await fresh();
  const c = fight([tBorin, tWarrior]);
  const { zoneId } = await wallOfFireUp();
  const cross = async () => {
    tWarrior._source.x = 9 * G;
    tWarrior._source.y = 6 * G;
    const n = markMsgs();
    await moveTokenPath(tWarrior, [lineCells(tWarrior, 5, 6)]);
    await advance(100);
    await settleAll();
    return zoneHitCards(n, zoneId);
  };
  const [a] = await cross();
  assert.ok(a, "card A");
  await api.undoOps(a.id, null);
  await settleAll();
  assert.equal(zoneLedger.zoneHitOf(c, zoneId, tWarrior.actor.uuid, "enter"), null, "undo released the credit");
  const [b] = await cross();
  assert.ok(b, "re-entry hits again: card B");
  await api.applyOps(a.id, [dmgOps(a)[0].opId]);
  await settleAll();
  assert.equal(dmgOps(messages.get(a.id))[0].status, "applied", "A re-applied");
  assert.equal(zoneLedger.zoneHitOf(c, zoneId, tWarrior.actor.uuid, "enter")?.messageId, b.id, "B keeps the credit (re-apply writes only a free credit)");
  console.log("ok H34 zone undo: the credit released, re-entry hits, re-apply leaves another card's credit");
}

/* ======================================================================== */
/*  H35: lifetime                                                            */
/* ======================================================================== */
const phalanx = ability(benedikt, "Righteous Phalanx", { dsid: "righteous-phalanx", distance: { type: "cube", primary: 2, secondary: 5 } });
{
  await fresh();
  const c = fight([tBorin, tTala, tBen, tWarrior, tStinker, tArixx]);
  // summonerTurnStart: Tala's column made in her turn; not ended at a repeat of that activation, ended at her next turn start.
  await activate(c, tTala);
  const col = await zoneCard(incinerate, { author: player });
  const colOp = await placeZone(player, col, [cell(3, 7, { corner: true })]);
  assert.equal(colOp.status, "applied", `column: ${colOp.reason}`);
  await asGM(() => foundry.documents.ActiveEffect.registry.refresh("turnStart", { combat: c, round: c.round, turn: c.turn }));
  await settleAll();
  assert.ok(regionOf(colOp.zoneId), "a repeated turn start of the creating activation: still there");
  await endTurn(c);
  await advance(1_600);
  await settleAll();
  assert.ok(regionOf(colOp.zoneId), "its own turn end does not end a summonerTurnStart zone");
  await nextRound(c);
  await activate(c, tTala);
  await settleAll();
  assert.equal(regionOf(colOp.zoneId), null, "ended at her next turn start");
  assert.equal(zoneEnded(col, colOp.opId), "expired", "the row: gone, its time ran out");
  await endTurn(c);
  await advance(1_600);
  // summonerTurnEnd (strained column): ends 1.5 s after her turn end; the DSLF undo pattern keeps it.
  await nextRound(c);
  await activate(c, tTala);
  const sc = await zoneCard(incinerate, { author: player, useEffects: ["strainedE0000001"] });
  await api.resolve(sc.id, { force: true });
  await settleAll();
  const scOp = await placeZone(player, sc, [cell(1, 8, { corner: true })]);
  assert.equal(scOp.status, "applied", `strained column: ${scOp.reason}`);
  // DSLF "Undo Last Activation": the turn set back (turnEnd), then the initiative raised within 1.5 s.
  const cb = cmbOf(c, tTala);
  await c.update({ turn: null });
  await idle();
  await advance(500);
  await cb.update({ initiative: (cb.initiative ?? 0) + 1 });
  await advance(1_600);
  await settleAll();
  assert.ok(regionOf(scOp.zoneId), "the undone activation's turn end does not end it");
  await activate(c, tTala);
  await endTurn(c);
  assert.ok(regionOf(scOp.zoneId), "still there inside the 1.5 s grace");
  await advance(1_600);
  await settleAll();
  assert.equal(regionOf(scOp.zoneId), null, "a plain turn end ends it after 1.5 s");
  // summonerDying (Righteous Phalanx), zeroStamina (Swamp Gas), manual (the moat), encounterEnd (Acid puddle).
  const ph = await zoneCard(phalanx, { author: player });
  const phOp = await placeZone(player, ph, [cell(6, 8, { corner: true })]);
  assert.equal(phOp.status, "applied", `phalanx: ${phOp.reason}`);
  await setStamina(benedikt, 0);
  await settleAll();
  assert.equal(regionOf(phOp.zoneId), null, "summonerDying: ended when the creator is dying");
  assert.equal(zoneEnded(ph, phOp.opId), "creatorDown");
  const gas = await zoneCard(itemOn(tStinker, "Swamp Gas"), { author: gm });
  const gasOp = await placeZone(gm, gas, [cell(10, 14, { corner: true })]);
  await setStamina(tStinker.actor, 0);
  await settleAll();
  assert.equal(regionOf(gasOp.zoneId), null, "zeroStamina: the Stinker at 0");
  const mo = await zoneCard(moat, { author: player });
  const moOp = await placeZone(player, mo, [cell(1, 12, { corner: true })]);
  assert.equal(moOp.status, "applied", `moat: ${moOp.reason}`);
  const sp = await zoneCard(itemOn(tArixx, "Acid Spew"), { author: gm });
  const spOp = await placeZone(gm, sp, [cell(13, 12, { corner: true })]);
  const wall = await wallOfFireUp();
  await c.delete();
  await settleAll();
  assert.equal(regionOf(spOp.zoneId), null, "encounterEnd: the puddle goes with the combat");
  assert.equal(regionOf(wall.zoneId), null, "a zone of this combat without encounterEnd goes too");
  assert.ok(regionOf(moOp.zoneId), "a manual zone stays");
  assert.ok(log.whispers.some(w => /Zone\.EncounterEnd/.test(w.content)), "one whisper lists what was removed");
  await api.zones.dismiss(moOp.zoneId);
  await settleAll();
  assert.equal(regionOf(moOp.zoneId), null, "manual: until dismissed");
  // A GM reload (a new activation epoch): the round fallback still ends a summonerTurnStart zone at the next round's turn.
  const c2 = fight([tBorin, tTala, tWarrior]);
  await activate(c2, tTala);
  const col2 = await zoneCard(incinerate, { author: player });
  const col2Op = await placeZone(player, col2, [cell(3, 7, { corner: true })]);
  await endTurn(c2);
  resetActivations();
  await nextRound(c2);
  await activate(c2, tTala);
  await settleAll();
  assert.equal(regionOf(col2Op.zoneId), null, "after a reload: ended by the round fallback");
  console.log("ok H35 lifetime: summonerTurnStart (not on the repeat), summonerTurnEnd after 1.5 s, DSLF undo keeps it, dying, zero Stamina, encounter end (manual stays), reload epoch");
}

/* ======================================================================== */
/*  H36: Persistent upkeep                                                   */
/* ======================================================================== */
const upkeepAnswer = outcome => { answerFn = rec => (rec.kind === "upkeep" ? outcome : undefined); };
{
  await fresh();
  const c = fight([tBorin, tWarrior]);
  await activate(c, tBorin);
  let wall = await wallOfFireUp();
  await endTurn(c);
  await advance(1_600);
  // Keep: a card spending 1 Ferocity (resource chain), the wall stays, upkeptRound.
  await nextRound(c);
  upkeepAnswer("keep");
  const f0 = ferocity();
  let n = markMsgs();
  await activate(c, tBorin);
  await settleAll();
  const asks = dialogs.filter(d => d.kind === "upkeep");
  assert.equal(asks.length, 1, "Test was asked");
  assert.equal(asks[0].user, player2.id);
  assert.match(String(asks[0].title), /Zone\.Upkeep\.Title/, `the dialog shows the zone texts: ${asks[0].title}`);
  const upCards = since(n, m => /Zone\.UpkeepCard/.test(getResolution(m)?.abilityName ?? ""));
  assert.equal(upCards.length, 1, "a card spending 1");
  const pay = opsOf(upCards[0])[0];
  assert.equal(pay.kind, "resource");
  assert.equal(pay.amount, -1);
  assert.equal(pay.status, "applied");
  assert.equal(ferocity(), f0 - 1, "1 Ferocity spent");
  assert.ok(regionOf(wall.zoneId), "the wall stays");
  assert.equal(regionOf(wall.zoneId).flags["stef-ds-automation"].zone.upkeptRound, c.round, "upkeptRound");
  await endTurn(c);
  await advance(1_600);
  assert.ok(regionOf(wall.zoneId), "kept through the turn end");
  // Release: ended expired.
  await nextRound(c);
  upkeepAnswer("release");
  await activate(c, tBorin);
  await settleAll();
  assert.equal(regionOf(wall.zoneId), null, "released: gone");
  assert.equal(zoneEnded(wall.msg, wall.op.opId), "expired", "the row: its time ran out");
  await endTurn(c);
  await advance(1_600);
  // Timeout: ended.
  await nextRound(c);
  answerFn = () => undefined;
  await activate(c, tBorin);
  wall = await wallOfFireUp();
  await endTurn(c);
  await advance(1_600);
  await nextRound(c);
  answerFn = () => undefined;
  await activate(c, tBorin);
  await settleAll();
  assert.ok(regionOf(wall.zoneId), "while asked: still there");
  await advance(35_000);
  await settleAll();
  assert.equal(regionOf(wall.zoneId), null, "timed out: gone");
  await endTurn(c);
  await advance(1_600);
  // No owner online: ended (a whisper), cannot pay: ended.
  await nextRound(c);
  await activate(c, tBorin);
  wall = await wallOfFireUp();
  await endTurn(c);
  await advance(1_600);
  await nextRound(c);
  player2.active = false;
  await activate(c, tBorin);
  await settleAll();
  player2.active = true;
  assert.equal(regionOf(wall.zoneId), null, "no owner: gone");
  assert.ok(log.whispers.some(w => /Zone\.UpkeepNoOwner/.test(w.content)), "the Director is told");
  await endTurn(c);
  await advance(1_600);
  await nextRound(c);
  await activate(c, tBorin);
  wall = await wallOfFireUp();
  await endTurn(c);
  await advance(1_600);
  await nextRound(c);
  borin.system.hero.primary.value = 0;
  n = dialogs.length;
  await activate(c, tBorin);
  await settleAll();
  assert.equal(dialogs.length, n, "cannot pay: nobody asked");
  assert.equal(regionOf(wall.zoneId), null, "cannot pay: gone");
  console.log("ok H36 upkeep: Keep pays 1 and keeps (upkeptRound), Let it go / timeout / no owner / cannot pay end it, zone texts");
}

/* ======================================================================== */
/*  H37: Dismiss, undo, delete                                               */
/* ======================================================================== */
{
  await fresh();
  const c = fight([tBorin, tWarrior]);
  let wall = await wallOfFireUp();
  // The row's Dismiss: offered to the creator's owner and the Director; another player is denied.
  assert.equal(viewRow(wall.msg, wall.op.opId, player2).canDismissZone, true, "Test may dismiss");
  assert.equal(viewRow(wall.msg, wall.op.opId, gm).canDismissZone, true, "the Director may dismiss");
  assert.equal(viewRow(wall.msg, wall.op.opId, player).canDismissZone, false, "another player may not");
  await as(player, async () => { await assert.rejects(api.zones.dismiss(wall.zoneId), /Denied/); });
  assert.ok(regionOf(wall.zoneId), "still there");
  const out = await as(player2, () => api.zones.dismiss(wall.zoneId));
  await settleAll();
  assert.deepEqual(out, { ok: true, ended: true });
  assert.equal(regionOf(wall.zoneId), null);
  assert.equal(zoneEnded(wall.msg, wall.op.opId), "dismiss");
  // Undo after it is gone: alreadyGone; re-apply after alreadyGone: a new region, the row live again, Dismiss offered.
  await api.undoOps(wall.msg.id, [wall.op.opId]);
  await settleAll();
  assert.equal(liveOp(wall.msg, wall.op.opId).status, "undone");
  assert.equal(liveOp(wall.msg, wall.op.opId).undoMode, "alreadyGone");
  // The owner bypass is gone with the area (zoneEnded): Test's Place is refused, the Director re-applies.
  notes.length = 0;
  await placeZone(player2, wall.msg, WALL.map(([x, y]) => cell(x, y)), liveOp(wall.msg, wall.op.opId));
  assert.equal(liveOp(wall.msg, wall.op.opId).status, "undone", "the owner cannot bring a gone area back");
  assert.ok(notes.some(x => x.user === player2.id && /Relay\.Denied|Zone\.Refused/.test(x.text)), `Test is told: ${JSON.stringify(notes)}`);
  const re = await placeZone(gm, wall.msg, WALL.map(([x, y]) => cell(x, y)), liveOp(wall.msg, wall.op.opId));
  assert.equal(re.status, "applied", `re-applied: ${re.reason}`);
  assert.notEqual(re.zoneId, wall.zoneId, "a new zone");
  assert.ok(regionOf(re.zoneId), "a new region");
  assert.equal(re.ended, null, "the row is not gone");
  assert.equal(re.undoMode, null);
  assert.equal(viewRow(wall.msg, re.opId, player2).canDismissZone, true, "Dismiss offered again");
  // Undo the live row: the region is deleted (no whisper for an undo).
  const w0 = log.whispers.length;
  await api.undoOps(wall.msg.id, [re.opId]);
  await settleAll();
  assert.equal(regionOf(re.zoneId), null, "undo deletes the region");
  assert.equal(liveOp(wall.msg, re.opId).undoMode, null);
  assert.equal(log.whispers.length, w0, "no whisper for an undo");
  // A region deleted by hand: the row reads "gone: its area was deleted".
  wall = await wallOfFireUp();
  const region = regionOf(wall.zoneId);
  await START.deleteEmbeddedDocuments("Region", [region.id]);
  await settleAll();
  assert.equal(zoneEnded(wall.msg, wall.op.opId), "deleted");
  assert.match(viewRow(wall.msg, wall.op.opId).detail, /ZoneEnded.*Zone\.End\.deleted/);
  // A zone dismissed while a goblin's drag is still tallied: no card, the credit released.
  wall = await wallOfFireUp();
  tWarrior._source.x = 9 * G;
  tWarrior._source.y = 6 * G;
  const n = markMsgs();
  await moveTokenPath(tWarrior, [[[8, 6], [7, 6]], [[6, 6]], [[5, 6]]].slice(0, 1), { id: "mvdismissed00001" });
  // One continued segment still pending: re-issue the first with pending waypoints.
  tWarrior._source.x = 9 * G;
  const mvm = { id: "mvdismissed00002", origin: { x: 9 * G, y: 6 * G, width: 1, height: 1 }, passed: { waypoints: [{ x: 8 * G, y: 6 * G, action: "walk" }, { x: 7 * G, y: 6 * G, action: "walk" }] }, pending: { waypoints: [{ x: 6 * G, y: 6 * G, action: "walk" }] } };
  await tWarrior.update({ x: 7 * G });
  regionEvent(regionOf(wall.zoneId), "tokenMoveIn", { token: tWarrior, movement: mvm }, gm);
  assert.ok(zoneEngine.openTallies().some(t => t.zoneId === wall.zoneId), "a tally is open");
  await api.zones.dismiss(wall.zoneId);
  await advance(5_000);
  await settleAll();
  assert.equal(zoneHitCards(n, wall.zoneId).length, 0, "no card for a dismissed zone");
  assert.equal(zoneEngine.openTallies().length, 0, "the tally dropped");
  assert.equal(zoneLedger.zoneHitOf(c, wall.zoneId, tWarrior.actor.uuid, "enter"), null, "no credit");
  // Encounter cleanup can race deletion of the entire scene: its detached region collection still has the region.
  wall = await wallOfFireUp();
  const racedRegion = regionOf(wall.zoneId);
  const deleteDocuments = START.deleteEmbeddedDocuments;
  START.deleteEmbeddedDocuments = async () => {
    game.scenes.delete(START.id);
    throw new Error(`The Scene ${START.id} does not exist in scenes`);
  };
  try {
    const ended = await zoneReg.endZone(wall.zoneId, zoneReg.ZONE_END.ENCOUNTER_END);
    assert.equal(ended.gone, true, "the scene deletion already removed its region");
    assert.equal(ended.ended, false, "cleanup did not delete it a second time");
    assert.equal(ended.error, undefined, "a deleted parent scene is not a cleanup error");
  } finally {
    START.deleteEmbeddedDocuments = deleteDocuments;
    game.scenes.set(START.id, START);
    START.regions.delete(racedRegion.id);
    registry.delete(racedRegion.uuid);
  }
  console.log("ok H37 Dismiss / undo / delete: owner and Director, others denied, alreadyGone, re-apply makes a new region, undo deletes quietly, deleted by hand, open tallies dropped");
}

/* ======================================================================== */
/*  H38: gains on zone cards                                                 */
/* ======================================================================== */
{
  await fresh();
  const c = fight([tBorin, tStinker]);
  const gas = await zoneCard(itemOn(tStinker, "Swamp Gas"), { author: gm });
  const gop = await placeZone(gm, gas, [cell(8, 10, { corner: true })]);
  await nextRound(c);
  tBorin._source.x = 7 * G;
  tBorin._source.y = 11 * G;
  const f0 = ferocity();
  const n = markMsgs();
  await moveTokenPath(tBorin, [lineCells(tBorin, 11, 11)]);
  await advance(100);
  await settleAll();
  const hits = zoneHitCards(n, gop.zoneId);
  assert.equal(hits.length, 1);
  const g = gainOps(hits[0]);
  assert.equal(g.length, 1, "the zone hit card carries the gain row");
  assert.equal(g[0].gain.ruleKey, "ferocity:took-damage");
  assert.equal(g[0].status, "applied");
  assert.equal(ferocity(), f0 + 1);
  assert.equal(hits[0].updates, 1, "one write for the hit and its gain");
  assert.equal(gainCards(n).length, 0, "no separate gain card");
  console.log("ok H38 gains on zone cards: the hit card carries +1 Ferocity in its one write");
}

/* ======================================================================== */
/*  H39: a player's activation of their own summon                           */
/* ======================================================================== */
{
  await fresh();
  const earth = npc("Source of Earth", `${MPACK}o7qp5KCUuRgfCko6`, { stamina: 45, keywords: ["elemental"] });
  earth.ownership = { default: 0, [player2.id]: 3 };
  const tEarth = npcToken(earth, "Source of Earth", 4, 4, { disposition: 1 });
  const c = fight([tBorin, tEarth, tWarrior]);
  const cbE = cmbOf(c, tEarth);
  cbE.flags["stef-ds-automation"] = { summonId: "summon0000000001" };
  // Test lowers his summon's initiative (the tracker's activate): vetoed locally, relayed, the GM activates it.
  log.relay.length = 0;
  await as(player2, () => cbE.update({ initiative: cbE.initiative - 1 }));
  await settleAll();
  await idle();
  assert.equal(relayed("summonActivate").length, 1, "relayed to the GM");
  assert.equal(c.combatant?.id, cbE.id, "the summon's turn");
  assert.equal(cbE.initiative, 0, "lowered by the GM");
  await endTurn(c);
  // Another's turn running -> SummonNotNow; not the owner -> Denied; a held summon -> SummonHeld.
  await nextRound(c);
  await activate(c, tWarrior);
  notes.length = 0;
  await as(player2, () => cbE.update({ initiative: cbE.initiative - 1 }));
  await settleAll();
  assert.ok(notes.some(x => x.user === player2.id && /SummonNotNow/.test(x.text)), "another creature's turn: refused");
  await endTurn(c);
  await assert.rejects(as(player, () => requestOp({ action: "summonActivate", summonActivate: { combatId: c.id, combatantId: cbE.id } })), /Denied/, "not the owner");
  c.flags["stef-ds-automation"] = { summons: { s1: { summonId: "summon0000000001", held: true, summonerTokenId: tBorin.id, tokenIds: [tEarth.id], order: 0 } } };
  await assert.rejects(as(player2, () => requestOp({ action: "summonActivate", summonActivate: { combatId: c.id, combatantId: cbE.id } })), /SummonHeld/, "held after its summoner");
  delete c.flags["stef-ds-automation"].summons;
  START.tokens.delete(tEarth.id);
  console.log("ok H39 summon activation: vetoed and relayed, the GM activates; not now, denied, held");
}

/* ======================================================================== */
/*  H40: M6 wording and stale fields                                         */
/* ======================================================================== */
{
  await fresh();
  const bloodlord = npc("Hobgoblin Bloodlord", `${MPACK}Lcoa5x1olfOONQCJ`, {
    stamina: 60, keywords: ["hobgoblin"], abilities: [{ name: "An Army From Blood", type: "triggered", target: { type: "creature" } }],
  });
  const tBlood = npcToken(bloodlord, "Hobgoblin Bloodlord", 12, 15);
  fight([tBorin, tBlood]);
  const army = useCard(itemOn(tBlood, "An Army From Blood"), { author: gm });
  await idle();
  await settleAll();
  const sop = opsOf(army).find(o => o.kind === "summon");
  assert.ok(sop, `a summon row: ${JSON.stringify(opsOf(army).map(o => [o.kind, o.status, o.reason]))}`);
  assert.equal(sop.reason, "noAnchor", "no target: noAnchor");
  assert.match(viewRow(army, sop.opId).detail, /SummonRangeOne/, "within 1 square");
  // T87 replay: a re-resolve with a target clears the stale reason.
  await api.retarget(army.id, [tBorin.uuid]);
  await settleAll();
  const after = opsOf(army).find(o => o.kind === "summon");
  assert.equal(after.reason ?? null, null, `reason cleared: ${after.reason}`);
  assert.equal(after.status, "pending");
  assert.match(viewRow(army, after.opId).detail, /SummonRangeTarget/);
  // Automatic placement: a GM reads "the Director's client takes the nearest free squares".
  await set("summonPlacement", "auto");
  const gih = useCard(itemOn(tMonarch, "Get in Here!"), { author: gm });
  await idle();
  await settleAll();
  const gop = opsOf(gih).find(o => o.kind === "summon");
  assert.match(viewRow(gih, gop.opId, gm).detail, /SummonPicksAuto/, "auto placement text for a GM");
  await set("summonPlacement", "pick");
  START.tokens.delete(tBlood.id);
  console.log("ok H40 M6 wording: within 1 square, a re-resolve clears noAnchor, the auto placement text");
}

/* ======================================================================== */
/*  H41: one write                                                           */
/* ======================================================================== */
{
  await fresh();
  fight([tBorin, tWarrior]);
  const msg = await hit(spear, tBorin, 3);
  assert.equal(gainOps(msg).length, 1);
  assert.equal(msg.updates, 1, "a card with a gain row: one message update per auto-resolution");
  console.log("ok H41 one write: a card with an applied gain row is written once (harness.mjs:382 runs in H45)");
}

/* ======================================================================== */
/*  H42: check.cjs                                                           */
/* ======================================================================== */
{
  const require = createRequire(import.meta.url);
  const { reservedProblems } = require("./check.cjs");
  assert.ok(reservedProblems('ds.CONFIG.SpecialEffect.summon = X;').length, "the reserved-name rule still bites");
  assert.equal(reservedProblems('ds.CONFIG.SpecialEffect["dsAuto.zone"] = X;').length, 0, "our prefixed zone type is fine");
  // Removing one dynamic key (§5.6) from a copy of en.json fails the check.
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const lang = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
  const dir = mkdtempSync(`${tmpdir()}/dsauto-check-`);
  for (const [path, label] of [["DSAUTO.Zone.End.dismiss", "ZONE_END"], ["DSAUTO.Entry.ZoneEvent.move", "ZONE_EVENTS"], ["DSAUTO.Zone.Behavior.FIELDS.amount.label", "behavior fields"]]) {
    const copy = clone(lang);
    const parts = path.split(".");
    const parent = parts.slice(0, -1).reduce((o, k) => o?.[k], copy);
    assert.ok(parent && parts.at(-1) in parent, `${path} exists`);
    delete parent[parts.at(-1)];
    const file = `${dir}/en-${label.replace(/\W/g, "")}.json`;
    writeFileSync(file, JSON.stringify(copy));
    let out = "";
    let failed = false;
    try {
      out = execFileSync(process.execPath, [new URL("./check.cjs", import.meta.url).pathname.replace(/^\/(\w:)/, "$1")], { env: { ...process.env, DSAUTO_CHECK_LANG: file, DSAUTO_CHECK_SKIP_SYNTAX: "1" }, encoding: "utf8" });
    } catch (err) {
      failed = true;
      out = String(err.stdout ?? "");
    }
    assert.ok(failed, `removing ${path} fails the check`);
    assert.ok(out.includes(`i18n key missing: ${path}`), `${label}: ${out.split("\n").filter(l => /FAIL/.test(l)).join(" | ")}`);
  }
  rmSync(dir, { recursive: true, force: true });
  console.log("ok H42 check.cjs: reserved names unchanged, a removed dynamic key (zone end, zone event, behavior field) fails the check");
}

/* ======================================================================== */
/*  H43: selfCheck                                                           */
/* ======================================================================== */
{
  await fresh({ tokens: 2, maliceValue: 4 });
  fight([tBorin, tWarrior]);
  await wallOfFireUp();
  const { report, problems, foreign } = api.selfCheck();
  for (const k of ["resourceGains", "gainsActive", "gainFeatures", "gainCandidates", "staminaWatch", "heroTokens", "malice", "zoneType", "liveZones", "m7PromptTypes", "dsctTemplateCleanup", "resourcesUiActive"]) {
    assert.ok(k in report, `selfCheck reports ${k}`);
  }
  assert.equal(report.zoneType, true);
  assert.equal(report.m7PromptTypes, true, "the four new prompt types");
  assert.equal(report.heroTokens, 2);
  assert.equal(report.malice, 4);
  assert.equal(report.liveZones, 1);
  assert.match(report.gainFeatures, /feature:ferocity/);
  assert.ok("draw-steel-combat-tools.abilityTemplateCleanup" in foreign);
  assert.ok(!problems.some(p => /zone region behavior/.test(p)));
  // A missing zone type and a stand-down module: problem lines.
  const Zt = CONFIG.RegionBehavior.dataModels["stef-ds-automation.zone"];
  delete CONFIG.RegionBehavior.dataModels["stef-ds-automation.zone"];
  game.modules.set("draw-steel-triggers", { active: true });
  const second = api.selfCheck();
  CONFIG.RegionBehavior.dataModels["stef-ds-automation.zone"] = Zt;
  game.modules.delete("draw-steel-triggers");
  assert.ok(second.problems.some(p => /stef-ds-automation\.zone region behavior is not registered/.test(p)), `zone type problem: ${second.problems}`);
  assert.ok(second.problems.some(p => /Gains stand down: draw-steel-triggers/.test(p)), "stand-down problem");
  api.selfCheck();
  console.log("ok H43 selfCheck: the M7 fields, a missing zone type and a stand-down module reported");
}

/* ======================================================================== */
/*  H44: API                                                                 */
/* ======================================================================== */
{
  await fresh();
  const c = fight([tBorin, tWarrior, tAssassin]);
  assert.deepEqual(api.resources.rules(tBorin).map(r => r.ruleKey), ["ferocity:took-damage", "ferocity:winded-or-dying"], "rules by token");
  assert.deepEqual(api.resources.rules(borin.uuid).map(r => r.amount), [1, null]);
  assert.equal(api.resources.rules(tWarrior).length, 0, "no rules for a monster");
  await hit(spear, tBorin, 2);
  assert.ok(api.resources.ledger(borin).round["ferocity:took-damage"], "ledger");
  assert.ok(api.resources.ledger(tBorin, c).round["ferocity:took-damage"], "ledger by token and combat");
  assert.equal(await as(player, () => api.resources.release(borin, "ferocity:took-damage")), false, "release: active GM only");
  assert.equal(await api.resources.release(borin, "ferocity:took-damage"), true, "released");
  assert.deepEqual(api.resources.ledger(borin).round, {});
  const again = await hit(stab, tBorin, 2);
  assert.equal(gainOps(again).length, 1, "the Director re-granted it");
  assert.equal(api.resources.heroTokens(), 0);
  assert.equal(api.malice.value(), 0);
  // Zones: list / get / hit (honours the credit unless force) / dismiss.
  const wall = await wallOfFireUp();
  const listed = api.zones.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].zoneId, wall.zoneId);
  assert.equal(listed[0].label, "Wall of fire");
  assert.deepEqual(listed[0].lasts, ["summonerTurnStart"]);
  assert.equal(api.zones.list({ sceneId: OTHER.id }).length, 0, "filter by scene");
  assert.equal(api.zones.list({ creatorActorUuid: borin.uuid }).length, 1);
  assert.equal(api.zones.get(wall.zoneId)?.regionUuid, wall.region.uuid);
  tWarrior._source.x = 7 * G;
  tWarrior._source.y = 5 * G;
  const h1 = await api.zones.hit(wall.zoneId, tWarrior);
  await settleAll();
  assert.ok(h1?.messageId, "api hit: a card");
  const h2 = await api.zones.hit(wall.zoneId, tWarrior.uuid);
  assert.equal(h2, null, "the enter credit is taken");
  const h3 = await api.zones.hit(wall.zoneId, tWarrior, { force: true });
  await settleAll();
  assert.ok(h3?.messageId, "force ignores the credit");
  await as(player, async () => { await assert.rejects(api.zones.hit(wall.zoneId, tWarrior), /NotActiveGM/); });
  await api.zones.dismiss(wall.zoneId);
  await settleAll();
  assert.equal(api.zones.get(wall.zoneId), null, "dismissed");
  await assert.rejects(api.zones.dismiss(wall.zoneId), /UnknownZone/);
  console.log("ok H44 API: resources.rules / ledger / release / heroTokens, malice.value, zones.list / get / hit (credit, force) / dismiss");
}

/* ======================================================================== */
/*  H46: resource chains                                                     */
/* ======================================================================== */
{
  await fresh({ tokens: 3, maliceValue: 2 });
  const c = fight([tBorin, tWarrior, tArixx]);
  // A gain card and a damage card's gain on one Fury in the same tick: both land.
  const f0 = ferocity();
  rollQueue.push(1);
  const windFact = { kind: "winded", id: "h46:winded", sceneId: START.id, taker: { actorUuid: borin.uuid, tokenUuid: tBorin.uuid, isHero: true }, states: ["winded"], messageId: null, opIds: [] };
  const plan = gainsMod.planGains([windFact], { origin: "gainCard" });
  assert.equal(plan.ops.length, 1);
  const [card] = await Promise.all([gainCardMod.postGainCard({ ...plan, source: "external" }), hit(spear, tBorin, 2)]);
  await settleAll();
  assert.equal(opsOf(messages.get(card.messageId))[0].status, "applied");
  assert.equal(ferocity(), f0 + 2, "+1 (took damage) and +1 (winded, rolled 1): +2 in all");
  // Zone upkeep -1 and a gain +1 at the same turn start: net 0.
  await nextRound(c);
  await activate(c, tBorin);
  await wallOfFireUp();
  const puddle = await zoneCard(itemOn(tArixx, "Acid Spew"), { author: gm });
  await placeZone(gm, puddle, [cell(13, 12, { corner: true })]);
  await endTurn(c);
  await advance(1_600);
  tBorin._source.x = 13 * G;
  tBorin._source.y = 12 * G;
  await nextRound(c);
  borin.system.stamina.value = borin.system.stamina.max;
  upkeepAnswer("keep");
  const f1 = ferocity();
  const n46 = markMsgs();
  await activate(c, tBorin);
  await settleAll();
  const paid = since(n46, m => /Zone\.UpkeepCard/.test(getResolution(m)?.abilityName ?? ""));
  const gained = zoneCards(n46).flatMap(m => gainOps(m)).filter(o => o.status === "applied");
  assert.equal(paid.length, 1, "the upkeep was paid");
  assert.equal(gained.length, 1, "the puddle's hit carried a gain");
  assert.equal(ferocity(), f1, "upkeep -1 and the zone hit's gain +1: net 0");
  // A hero-token spend and a Malice card in the same tick: each lands.
  await endTurn(c);
  await advance(1_600);
  await nextRound(c);
  await activate(c, tWarrior);
  tokenAnswer("spend");
  await setStamina(borin, 2);
  const [, mal] = await Promise.all([hit(stab, tBorin, 6), api.malice.adjust(3)]);
  await settleAll();
  assert.equal(heroTokens(), 1, "the hero tokens were spent");
  assert.equal(mal.ok, true);
  assert.equal(malice(), 5, "and the Malice landed");
  console.log("ok H46 resource chains: gain card + card gain both land, upkeep and gain net 0, hero tokens and Malice in one tick");
}

/* ======================================================================== */
/*  H49: 0.9.1 fixes from the Milestone 7 live run (TESTING.md §14)          */
/* ======================================================================== */
{
  const ongoingMod = await imp("turn/ongoing.mjs");
  // (a) T107: two zone hits on two members of one squad at once: both reach the pool (one queue per squad).
  await fresh();
  const c = fight([tBorin, tWarrior, tSpine1, tSpine2, tSpine3], { groups: [{ name: "Spinecleavers", members: [tSpine1, tSpine2, tSpine3], pool: 15 }] });
  const { zoneId } = await wallOfFireUp();
  const k1 = ongoingMod.staminaKey(tSpine1.uuid);
  assert.match(k1, /^group:/, `a squad member queues on its squad: ${k1}`);
  assert.equal(ongoingMod.staminaKey(tSpine2.uuid), k1, "the same queue for every member");
  assert.equal(ongoingMod.staminaKey(tBorin.uuid), tBorin.uuid, "anyone else: their own token");
  tSpine1._source.x = 7 * G; tSpine1._source.y = 6 * G;
  tSpine2._source.x = 7 * G; tSpine2._source.y = 7 * G;
  const pool0 = c.groups.contents[0].system.staminaValue;
  const n = markMsgs();
  const [h1, h2] = await Promise.all([api.zones.hit(zoneId, tSpine1, { force: true }), api.zones.hit(zoneId, tSpine2, { force: true })]);
  await settleAll();
  assert.ok(h1?.messageId && h2?.messageId, "two hit cards");
  const dealt = zoneHitCards(n, zoneId).flatMap(m => dmgOps(m)).filter(o => o.status === "applied")
    .reduce((s, o) => s + (Number(o.before?.staminaValue) - Number(o.after?.staminaValue)), 0);
  const befores = zoneHitCards(n, zoneId).flatMap(m => dmgOps(m)).map(o => o.before?.staminaValue);
  assert.notEqual(befores[0], befores[1], `the second write read the first one's result: ${JSON.stringify(befores)}`);
  assert.equal(c.groups.contents[0].system.staminaValue, pool0 - dealt, `the pool took both hits (${pool0} -> ${c.groups.contents[0].system.staminaValue}, dealt ${dealt})`);
  console.log("ok H49a squad members' zone hits queue on the squad's pool: both land");

  // (b) T116: a player's activate on a held summon (initiative 0) RAISES it: vetoed, relayed, SummonHeld; not held: CannotAct.
  const earth = npc("Source of Earth", `${MPACK}o7qp5KCUuRgfCko6`, { stamina: 45, keywords: ["elemental"] });
  earth.ownership = { default: 0, [player2.id]: 3 };
  const tEarth = npcToken(earth, "Source of Earth", 4, 4, { disposition: 1 });
  const c2 = fight([tBorin, tEarth, tWarrior]);
  const cbE = cmbOf(c2, tEarth);
  cbE.flags["stef-ds-automation"] = { summonId: "summon0000000002" };
  await activate(c2, tBorin);
  await asGM(() => cbE.update({ initiative: 0 }));
  c2.flags["stef-ds-automation"] = { summons: { s2: { summonId: "summon0000000002", held: true, summonerTokenId: tBorin.id, tokenIds: [tEarth.id], order: 0 } } };
  log.relay.length = 0;
  notes.length = 0;
  await as(player2, () => cbE.update({ initiative: 1 }));
  await settleAll();
  await idle();
  assert.equal(cbE.initiative, 0, "the raise was vetoed on the player's client");
  assert.equal(relayed("summonActivate").length, 1, "and relayed");
  assert.ok(notes.some(x => x.user === player2.id && /SummonHeld/.test(x.text)), `held: the reason as a toast: ${JSON.stringify(notes)}`);
  delete c2.flags["stef-ds-automation"].summons;
  notes.length = 0;
  await as(player2, () => cbE.update({ initiative: 1 }));
  await settleAll();
  await idle();
  assert.ok(notes.some(x => x.user === player2.id && /SummonCannotAct/.test(x.text)), "not held, at 0: no turn left");
  assert.equal(cbE.initiative, 0);
  START.tokens.delete(tEarth.id);
  console.log("ok H49b a raise from 0 of a player's summon: vetoed and relayed (SummonHeld / SummonCannotAct)");

  // (c) T103: the hero-token hold reads "Waiting for Test"; a declined re-ask skips the earlier spend's row.
  await fresh({ tokens: 3 });
  const c3 = fight([tBorin, tWarrior]);
  await activate(c3, tWarrior);
  borin.system.stamina.value = 3;
  let banner = null;
  let holdKind = null;
  answerFn = rec => {
    if (rec.kind !== "herotoken") return undefined;
    const m = messages.contents.at(-1);
    holdKind = getResolution(m)?.hold?.kind ?? null;
    banner = viewOf10(m).banners?.find(b => b.cls === "waiting")?.text ?? null;
    return "spend";
  };
  const msg = await hit(spear, tBorin, 5);
  assert.equal(holdKind, "heroToken", "the hold marker says what it waits for");
  assert.match(String(banner), /HeroTokenWaiting/, `banner: ${banner}`);
  const hrow = heroRows(msg)[0];
  const dmg = dmgOps(msg)[0];
  assert.equal(hrow.status, "applied");
  await api.undoOps(msg.id, null);
  await settleAll();
  assert.equal(heroRows(messages.get(msg.id))[0].status, "undone");
  tokenAnswer("decline");
  await api.applyOps(msg.id, [dmg.opId]);
  await settleAll();
  const after = heroRows(messages.get(msg.id))[0];
  assert.equal(after.status, "skipped", "the earlier spend's row is no longer offered");
  assert.equal(after.reason, "heroTokenDeclined");
  assert.equal(viewRow(msg, after.opId)?.canApply ?? false, false, "no Apply button");
  assert.equal(heroTokens(), 3, "no tokens spent");
  console.log("ok H49c hero tokens: 'Waiting for' banner, a declined re-ask skips the old spend row");

  // (d) T111: a Use whose system dialog never opens (another module vetoed it) gives the button back with a warning.
  await fresh({ maliceValue: 5 });
  const c4 = fight([tBorin, tMonarch]);
  await activate(c4, tMonarch);
  await settleAll();
  const rem = [...messages.values()].filter(m => m.flags?.["stef-ds-automation"]?.maliceReminder).at(-1);
  assert.ok(rem, "a reminder");
  const root = render(rem, gm);
  const button = root.querySelector("button[data-uuid]");
  const item = await fromUuid(button.dataset.uuid);
  const realUse = item.system.use;
  item.system.use = () => new Promise(() => {});            // vetoed: never resolves
  notes.length = 0;
  button.click();
  await settle();
  assert.equal(button.disabled, true, "disabled while waiting");
  await advance(maliceUI.DIALOG_WAIT_MS + 10);
  await settle();
  assert.equal(button.disabled, false, "back after the wait");
  assert.ok(notes.some(x => /Malice\.NoDialog/.test(x.text)), `a warning: ${JSON.stringify(notes)}`);
  // The dialog opened: the Director takes their time, the button waits for the use.
  let finish;
  item.system.use = () => new Promise(r => { finish = r; });
  button.click();
  await settle();
  Hooks.callAll("renderAbilityConfigurationDialog", { options: { ability: item } });
  await advance(maliceUI.DIALOG_WAIT_MS + 10);
  await settle();
  assert.equal(button.disabled, true, "an open dialog: still running");
  finish(null);
  await settle();
  assert.equal(button.disabled, false, "done");
  item.system.use = realUse;
  console.log("ok H49d Malice reminder: a dialog that never opens gives the Use button back with a warning");

  // (e) Wording: plurals, the dice row's roll only while applied, the Malice reason on the card.
  const mc = await api.malice.adjust(1, { reason: "live test" });
  const mr = getResolution(messages.get(mc.messageId));
  assert.match(Object.values(mr.targets)[0].name, /\(live test\)$/, "the reason on the card");
  assert.equal(api.selfCheck().problems.some(p => /grid distance/.test(p)), START.grid?.distance != null && Number(START.grid.distance) !== 1);
  console.log("ok H49e wording: Malice reason shown; selfCheck grid distance line");
}

/* ======================================================================== */
/*  H50: zones applied from the area drawn on use (Milestone 9 WP-B)         */
/* ======================================================================== */
/** A system template of `item` on START (flags.draw-steel.abilitySource): one cube of `n` squares, top-left (gx, gy). */
async function cubeTemplate(item, gx, gy, n = 1) {
  const shape = { type: "rectangle", x: gx * G, y: gy * G, width: n * G, height: n * G, anchorX: 0, anchorY: 0, rotation: 0 };
  return (await START.createEmbeddedDocuments("Region", [{ name: item.name, shapes: [shape], flags: { "draw-steel": { abilitySource: item.uuid } } }]))[0];
}
const shapeAt = op => {
  const s = fromUuidSync(op.regionUuid)?.shapes?.[0];
  return s ? [s.x, s.y, s.width] : null;
};
{
  await fresh();
  fight([tTala, tBorin, tWarrior]);
  // (a) The live template: applied at resolve (no Place click), adopted, the system template deleted.
  let tpl = await cubeTemplate(incinerate, 6, 3);
  log.relay.length = 0;
  const d0 = log.regionDeletes.length;
  const m1 = await zoneCard(incinerate, { author: player });
  const o1 = clone(zoneOp(m1));   // a snapshot: the record's op object is merged into later
  assert.equal(o1.status, "applied", `adopted at resolve: ${o1.reason}`);
  assert.equal(o1.adopted, "template");
  assert.equal(relayed("apply").length, 0, "no Place click relayed");
  assert.deepEqual(shapeAt(o1), [600, 300, 100], "the drawn cube, sizes from the GM");
  const del = log.regionDeletes.slice(d0).find(x => x.id === tpl.id);
  assert.ok(del, "the system template deleted after the write");
  assert.equal(del.options["stef-ds-automation"]?.adoptedTemplate, true);
  assert.equal(START.regions.get(tpl.id), undefined);
  assert.match(viewRow(m1, o1.opId).detail, /ZoneAdopted/);
  // Undo, then a forced re-resolve: the row stays undone; Place re-applies it with a new zone.
  await api.undoOps(m1.id, [o1.opId]);
  await settleAll();
  assert.equal(liveOp(m1, o1.opId).status, "undone");
  assert.equal(regionOf(o1.zoneId), null, "undo removes the region");
  await api.resolve(m1.id, { force: true });
  await settleAll();
  assert.equal(liveOp(m1, o1.opId).status, "undone", "a forced re-resolve keeps the undone row");
  const re1 = await placeZone(gm, m1, [cell(4, 4, { corner: true })], liveOp(m1, o1.opId));
  assert.equal(re1.status, "applied", `Place again: ${re1.reason}`);
  assert.notEqual(re1.zoneId, o1.zoneId, "a new zone");
  assert.equal(re1.adopted, null, "placed by hand");
  // (b) No template, no seed: pending with its Place button (H25 unchanged).
  const m2 = await zoneCard(incinerate, { author: player });
  assert.equal(zoneOp(m2).status, "pending");
  assert.equal(zoneOp(m2).mode, "prompt", "written as prompt");
  assert.doesNotMatch(viewRow(m2, zoneOp(m2).opId).detail, /ZoneAdopted/);
  // (c) The seed: the template is gone (Combat Tools' sweep) before the card resolves.
  tpl = await cubeTemplate(incinerate, 5, 6);
  areasMod.notePreparedArea(incinerate.uuid, tpl);
  const m3 = useCard(incinerate, { author: player });
  areasMod.notePreparedArea(incinerate.uuid, null);
  const seed = getResolution(m3).areaTemplate;
  assert.equal(seed?.itemUuid, incinerate.uuid, "seeded on the author's client");
  assert.equal(seed.sceneId, START.id);
  assert.deepEqual(seed.place.shapes, [{ x: 500, y: 600, rotation: 0 }], "positions only in the place");
  await START.deleteEmbeddedDocuments("Region", [tpl.id]);
  await idle();
  await settleAll();
  const o3 = zoneOp(m3);
  assert.equal(o3.status, "applied", `from the seed: ${o3.reason}`);
  assert.equal(o3.adopted, "seed");
  assert.deepEqual(shapeAt(o3), [500, 600, 100]);
  assert.equal(getResolution(messages.get(m3.id)).areaTemplate, undefined, "the seed is spent");
  // (d) A forged seed (another item) and a seed of a user who could not Place the row: ignored.
  tpl = await cubeTemplate(incinerate, 5, 6);
  areasMod.notePreparedArea(incinerate.uuid, tpl);
  const m4 = useCard(incinerate, { author: player });
  const m5 = useCard(incinerate, { author: player2 });
  areasMod.notePreparedArea(incinerate.uuid, null);
  getResolution(m4).areaTemplate.itemUuid = wallOfFire.uuid;
  assert.ok(getResolution(m5).areaTemplate, "Test's client seeded too");
  await START.deleteEmbeddedDocuments("Region", [tpl.id]);
  await idle();
  await settleAll();
  assert.equal(zoneOp(m4).status, "pending", "forged seed ignored");
  assert.equal(zoneOp(m4).mode, "prompt");
  assert.equal(zoneOp(m5).status, "pending", "Test does not own Tala: seed ignored");
  // (e) A template 11 squares away: failed tooFar, the template kept, Place still works.
  tpl = await cubeTemplate(incinerate, 13, 2);
  const m6 = await zoneCard(incinerate, { author: player });
  const o6 = zoneOp(m6);
  assert.equal(o6.status, "failed");
  assert.equal(o6.reason, "tooFar");
  assert.equal(o6.mode, "prompt");
  assert.ok(START.regions.get(tpl.id), "a refused template stays");
  await START.deleteEmbeddedDocuments("Region", [tpl.id]);
  const p6 = await placeZone(player, m6, [cell(4, 2, { corner: true })], o6);
  assert.equal(p6.status, "applied", `Place after a refusal: ${p6.reason}`);
  // (f) Strained: the 5-cube centred on the drawn 1-cube (2 squares up and left).
  incinerate.system.effects = new Coll([["strainedE0000001", { id: "strainedE0000001", type: "strained" }]]);
  tpl = await cubeTemplate(incinerate, 6, 6);
  const m7 = await zoneCard(incinerate, { author: player, useEffects: ["strainedE0000001"] });
  const o7 = zoneOp(m7);
  assert.equal(o7.label, "Column of fire (strained)");
  assert.equal(o7.status, "applied", `strained: ${o7.reason}`);
  assert.deepEqual(shapeAt(o7), [400, 400, 500], "shifted by -2 squares, the GM's size");
  // (f2) Live fix 0.14.1: a 2-cube drawn half a square off the grid (Draw Steel's preview snapped to an edge midpoint)
  // goes on the grid line covering the target; without targets, the nearest line as before.
  {
    const { fitPlace } = await imp("zones/adopt.mjs");
    const scene = { grid: { size: 140, distance: 1 }, dimensions: { distancePixels: 140 } };
    const op2 = { zone: { area: { shape: "cube", size: 2 } } };
    const drawn = [{ x: 4060, y: 3990, rotation: 0, width: 280, height: 280, anchorX: 0.5, anchorY: 0.5 }];
    const at = (points) => fitPlace(op2, drawn, { scene, points })?.shapes[0];
    assert.deepEqual([at([{ x: 3990, y: 3850 }]).x, at([{ x: 3990, y: 3850 }]).y], [3920, 3780], "covers the target in the upper row");
    assert.deepEqual([at([{ x: 3990, y: 4130 }]).x, at([{ x: 3990, y: 4130 }]).y], [3920, 3920], "covers the target in the lower row");
    assert.deepEqual([at([]).x, at([]).y], [3920, 3920], "no targets: rounded");
  }
  // (g) zoneMode prompt: never adopted.
  await set("zoneMode", "prompt");
  tpl = await cubeTemplate(incinerate, 6, 3);
  const m8 = await zoneCard(incinerate, { author: player });
  assert.equal(zoneOp(m8).status, "pending", "prompt: not adopted");
  assert.ok(START.regions.get(tpl.id), "the template stays");
  await START.deleteEmbeddedDocuments("Region", [tpl.id]);
  await set("zoneMode", "auto");
  // (h) An aura with zoneMode auto: built around its creator at resolve.
  const am = await zoneCard(aura);
  const ao = zoneOp(am);
  assert.equal(ao.status, "applied", `aura at resolve: ${ao.reason}`);
  assert.equal(ao.adopted, null);
  assert.equal(fromUuidSync(ao.regionUuid)?.attachment?.token, tBorin.id);
  console.log("ok H50 adoption: live template, no template -> prompt, seed after the sweep, forged / unauthorized seeds ignored, tooFar keeps Place, strained centred, zoneMode prompt, aura at resolve, undo + re-resolve");
}

/* ======================================================================== */
/*  H51: difficult terrain (Milestone 9 WP-B)                                */
/* ======================================================================== */
{
  await fresh();
  const c = fight([tBorin, tBen, tWarrior, tAssassin]);
  // Schema, entries, the entry and behavior fields.
  const { validateOverlay } = schema;
  const base = { key: "ability:terrain-test", version: "1.0.0", name: "Terrain Test" };
  const ug = { id: "g", type: "zone", targets: "self", terrain: "difficult", affects: "enemies", lasts: ["encounterEnd"] };
  const ok = validateOverlay({ ...base, effects: [ug] });
  assert.ok(ok.ok, `terrain-only zone: ${JSON.stringify(ok.errors)}`);
  const mud = validateOverlay({ ...base, effects: [{ ...ug, terrain: "mud" }] });
  assert.ok(!mud.ok && mud.errors.some(e => /terrain/.test(e)), `mud refused: ${JSON.stringify(mud.errors)}`);
  const { terrain: _t, ...neither } = ug;
  const nv = validateOverlay({ ...base, effects: [neither] });
  assert.ok(!nv.ok && nv.errors.some(e => /value. or a .terrain/.test(e)), `neither refused: ${JSON.stringify(nv.errors)}`);
  const libUg = ALL_OVERLAYS.find(o => o.key === "ability:unquiet-ground");
  assert.ok(libUg && validateOverlay(libUg).ok, "the library's Unquiet Ground validates");
  const ents = entries.effectToEntries(ug, "ability:terrain-test");
  const back = entries.entryToEffect(ents[0]);
  assert.equal(back.terrain, "difficult", "entry round trip");
  const { entryId: _e, ...backPlain } = back;
  assert.ok(validateOverlay({ ...base, effects: [backPlain] }).ok, "round-tripped entry validates");
  const tf = ds.CONFIG.SpecialEffect["dsAuto.zone"].documentClass.defineSchema().dsAuto.fields.terrain;
  assert.deepEqual(Object.keys(tf.options?.choices ?? tf.choices), ["", "difficult"], "entry choice: none or difficult");
  const bf = behaviorMod.ZoneBehaviorType.defineSchema().terrain;
  assert.equal(bf.options.blank, true, "behavior field blank-able");
  assert.deepEqual(Object.keys(bf.options.choices), ["difficult"]);
  // Unquiet Ground drawn on use over the goblin warrior (9,5): applied at resolve, amount 0.
  const unquiet = ability(borin, "Unquiet Ground", { dsid: "unquiet-ground", distance: { type: "cube", primary: 2, secondary: 10 } });
  unquiet.system.keywords = new Set(["area", "magic"]);
  await cubeTemplate(unquiet, 8, 4, 2);
  const um = await zoneCard(unquiet);
  const uo = zoneOp(um);
  assert.equal(uo.status, "applied", `Unquiet Ground: ${uo.reason}`);
  assert.equal(uo.adopted, "template");
  assert.equal(uo.zone.terrain, "difficult");
  assert.equal(uo.zone.amount, 0, "terrain only");
  assert.equal(log.regionCreates.at(-1).data.behaviors[0].system.terrain, "difficult", "system.terrain");
  const region = regionOf(uo.zoneId);
  const beh = zoneReg.zoneBehavior(region);
  const sys = beh.system;
  assert.match(viewRow(um, uo.opId).detail, /ZoneTerrain/);
  // _getTerrainEffects: ground moves of creatures the zone affects.
  const DIFF = [{ name: "difficulty", difficulty: 2 }];
  const fx = (tok, action, s = sys) => s._getTerrainEffects(tok, { action, width: 1, height: 1, preview: true });
  assert.deepEqual(fx(tWarrior, "walk"), DIFF, "hostile walk");
  assert.deepEqual(fx(tWarrior, "crawl"), DIFF, "hostile crawl");
  for (const a of ["forced", "displace", "teleport", "fly", "jump", undefined, "nope"]) assert.deepEqual(fx(tWarrior, a), [], `no cost: ${a}`);
  assert.deepEqual(fx(tBorin, "walk"), [], "the creator");
  assert.deepEqual(fx(tBen, "walk"), [], "an ally");
  const disp = tAssassin.disposition;
  tAssassin.disposition = 0;
  assert.deepEqual(fx(tAssassin, "walk"), [], "a neutral creature");
  tAssassin.disposition = disp;
  beh.disabled = true;
  assert.deepEqual(fx(tWarrior, "walk"), [], "disabled behavior");
  beh.disabled = false;
  const zid = sys.zoneId;
  sys.zoneId = "foreignZone00001";
  assert.deepEqual(fx(tWarrior, "walk"), [], "a behavior whose zoneId is not the region's");
  sys.zoneId = zid;
  sys.affects = "all";
  assert.deepEqual(fx(tBen, "walk"), DIFF, "affects all: allies too");
  assert.deepEqual(fx(tBorin, "walk"), [], "never the creator");
  sys.affects = "enemies";
  // After core's setup only deriveTerrainDifficulty is left: probed.
  const acts = CONFIG.Token.movement.actions;
  Object.assign(acts, { climb2: { deriveTerrainDifficulty: d => d.walk }, leap2: { deriveTerrainDifficulty: ({ walk, fly }) => Math.max(walk, fly) }, blink2: { deriveTerrainDifficulty: () => 1 } });
  assert.deepEqual(fx(tWarrior, "climb2"), DIFF, "derived from walk");
  assert.deepEqual(fx(tWarrior, "leap2"), [], "max(walk, fly) is not a ground move");
  assert.deepEqual(fx(tWarrior, "blink2"), [], "constant 1");
  for (const k of ["climb2", "leap2", "blink2"]) delete acts[k];
  assert.deepEqual(sys._getTerrainEffects(null, null), [], "never throws");
  // Wall of Fire (terrain ""): no terrain.
  const wall = await wallOfFireUp();
  const wsys = zoneReg.zoneBehavior(wall.region).system;
  assert.equal(wsys.terrain, "");
  assert.deepEqual(fx(tWarrior, "walk", wsys), [], "Wall of Fire is no terrain");
  // Static events: planned paths recomputed for a terrain zone; never throws without the canvas.
  const ev = behaviorMod.ZoneBehaviorType.events;
  let recalcs = 0;
  canvas.tokens.recalculatePlannedMovementPaths = () => { recalcs++; };
  for (const e of ["behaviorViewed", "behaviorUnviewed", "regionBoundary"]) await ev[e].call(sys, { name: e });
  assert.equal(recalcs, 3, "three events, three recalculations");
  await ev.behaviorViewed.call(wsys, { name: "behaviorViewed" });
  assert.equal(recalcs, 3, "not for a zone without terrain");
  delete canvas.tokens.recalculatePlannedMovementPaths;
  await ev.behaviorViewed.call(sys, { name: "behaviorViewed" });
  const cv = globalThis.canvas;
  globalThis.canvas = undefined;
  try {
    await ev.regionBoundary.call(sys, { name: "regionBoundary" });
  } finally {
    globalThis.canvas = cv;
  }
  // A terrain-only zone deals nothing: no tally, no credit, no card on entry or at turn start.
  const n = markMsgs();
  await moveTokenPath(tAssassin, [[[8, 6], [8, 5]]]);
  await advance(5_000);
  await settleAll();
  assert.equal(zoneEngine.openTallies().length, 0, "no tally");
  assert.equal(zoneLedger.zoneHitOf(c, uo.zoneId, tAssassin.actor.uuid, "enter"), null, "no credit");
  await turnOf(c, tWarrior);
  await settleAll();
  assert.equal(zoneHitCards(n, uo.zoneId).length, 0, "no zone card");
  // A pending terrain row reads "difficult terrain for enemies", not "hits enemies".
  const um2 = await zoneCard(unquiet);
  const d2 = viewRow(um2, zoneOp(um2).opId).detail;
  assert.match(d2, /ZoneTerrain/);
  assert.doesNotMatch(d2, /ZoneAffects/);
  // Dismiss and undo remove the region.
  await as(player2, () => api.zones.dismiss(uo.zoneId));
  await settleAll();
  assert.equal(regionOf(uo.zoneId), null, "dismissed");
  const p2 = await placeZone(player2, um2, [cell(12, 12, { corner: true })]);
  assert.equal(p2.status, "applied", `placed: ${p2.reason}`);
  await api.undoOps(um2.id, [p2.opId]);
  await settleAll();
  assert.equal(regionOf(p2.zoneId), null, "undone");
  borin.items.delete(unquiet.id);
  console.log("ok H51 terrain: schema / entries / fields, system.terrain, difficulty 2 for hostile ground moves only, creator / ally / neutral / forced / teleport / fly / jump / disabled / foreign / Wall of Fire none, affects all, path recalculation, no hits, dismiss and undo");
}

/* ======================================================================== */
/*  H45, H47, H48: separate runs                                             */
/* ======================================================================== */
console.log("note H45: harness.mjs .. harness9.mjs run separately (README); H47: the library tools tools/validate.mjs and tools/build.mjs; H48: the medkit tests tests/medkit/check.cjs and tests/medkit/harness.mjs");

console.log("\nALL HARNESS-10 TESTS PASSED");
process.exit(0);
