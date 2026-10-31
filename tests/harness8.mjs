// Eighth harness (Milestone 5): triggered actions. Holds of our damage (pre-pass, hold marker, halving,
// potency, not landed, re-apply, revocation), external damage (takeDamage MIXED, two-phase commit), the
// round's budget (DSCT effect, reservations, debits), prompts (router, recipients, fallback, timeout,
// release, mute, moot cancellation, queue deadlines), trigger cards (budget anchor, GM-only undo,
// follow-ups), trackers (Judgement / Mark), Hesitation is Weakness, the roll lock (Word of Guidance) and the
// movement gates, with the real wave-2 overlays of the library. Reuses harness.mjs's world.
// Scenarios H1-H50 follow docs/M5-DESIGN.md §7.1; H9b and H51-H59 cover the review fixes, H60-H72 the second review, H73-H83 the third.
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
  takeDamage: [], relay: [], relayErrors: [], sent: [], noteCause: 0, disarm: 0, fm: [], pills: [], locks: [], picker: [],
  combatUpdates: [], uses: [], targets: [], preMove: [], submitListeners: [], whispers: [],
};
const sw = { failTakeDamage: 0, fmActive: false };
const clear = () => {
  for (const k of Object.keys(log)) if (Array.isArray(log[k])) log[k].length = 0;
  log.noteCause = 0;
  log.disarm = 0;
};
const getPath = (obj, path) => String(path).split(".").reduce((o, k) => o?.[k], obj);
const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
class Coll extends Map {
  get contents() { return [...this.values()]; }
  find(fn) { return this.contents.find(fn); }
  filter(fn) { return this.contents.filter(fn); }
  some(fn) { return this.contents.some(fn); }
  [Symbol.iterator]() { return this.values(); }
}

/* ---------- DOM (roll lock, dialogs, indicator) ---------- */
const observers = [];
class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
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
    this.classList = new ClassList(this);
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
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === globalThis.document?.body;
  }
  all() { return this.children.flatMap(c => [c, ...c.all()]); }
  querySelectorAll(sel) {
    if (sel.startsWith(".")) return this.all().filter(e => e.classList.contains(sel.slice(1)));
    return this.all().filter(e => e.tagName === sel.toUpperCase());
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}
class MutationObserverMock {
  constructor(cb) { this.cb = cb; this.targets = []; observers.push(this); }
  observe(el) { this.targets.push(el); }
  disconnect() { this.targets = []; }
  trigger() { if (this.targets.length) this.cb([]); }
}
const windowListeners = [];
const openIds = new Set();   // document element ids present (Combat Tools' picker bar, vertical popup)
const mutate = () => { for (const o of [...observers]) o.trigger(); };

/* ---------- dialogs (DialogV2.wait) ---------- */
const dialogs = [];          // every DialogV2.wait call: {cfg, dialog, user, title, data, closed, result, click()}
let answerFn = () => "decline";
const parseLoc = (s) => {
  const i = String(s ?? "").indexOf(" ");
  if (i < 0) return {};
  try {
    return JSON.parse(String(s).slice(i + 1));
  } catch (_err) {
    return {};
  }
};
function makeForm(option = 0, spend = false) {
  return {
    querySelector(sel) {
      if (sel.includes('name="ds-auto-option"')) return { value: String(option) };
      if (/ds-auto-spend-\d+/.test(sel)) return { checked: !!spend };
      return null;
    },
  };
}
function dialogWait(cfg) {
  return new Promise(resolve => {
    const rec = { cfg, user: game.user?.id ?? null, title: cfg.window?.title ?? "", closed: false, result: undefined, renders: 0 };
    rec.data = parseLoc(rec.title);
    // Trigger prompts are named after the reactor (tracker prompts after the ability).
    rec.name = rec.data.name ?? rec.data.ability ?? null;
    const actions = (cfg.buttons ?? []).map(b => b.action);
    rec.kind = actions.includes("decline") ? "trigger" : (actions.includes("strike") ? "freeStrike" : (actions.includes("cancel") ? "confirmTarget" : "other"));
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
    const count = new El("p");
    count.classList.add("ds-auto-countdown");
    element.append(count);
    const dialog = { element, render() { rec.renders++; cfg.render?.(null, dialog); }, close() { finish(null); } };
    rec.dialog = dialog;
    rec.countdown = count;
    rec.click = (action, { option = 0, spend = false } = {}) => {
      if (rec.closed) return false;
      const button = (cfg.buttons ?? []).find(b => b.action === action);
      const value = button?.callback ? button.callback(null, { form: makeForm(option, spend) }, dialog) : action;
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
      a = "decline";
    }
    Promise.resolve(a).then(v => {
      if (v === undefined || v === null || rec.closed) return;
      if (typeof v === "string") rec.click(v);
      else rec.click(v.action, v);
    });
  });
}
/** answerFn by reactor name (trigger prompts) or dialog kind; missing = keep the dialog open. */
const byName = (map, other = {}) => rec => (rec.kind === "trigger" ? map[rec.name] : other[rec.kind]);
const triggerDialogs = (name = null) => dialogs.filter(d => d.kind === "trigger" && (!name || d.name === name));

/* ---------- system classes the wrappers patch ---------- */
class BaseActorModel {
  async takeDamage(amount, opts = {}) {
    const actor = this.parent;
    log.takeDamage.push({ actor: actor?.name, amount, opts: { ...opts } });
    if (sw.failTakeDamage > 0) {
      sw.failTakeDamage--;
      throw new Error("system refused");
    }
    const { immunity = 0, weakness = 0 } = this.calculateImmunityAndWeakness(opts);
    const dmg = Math.max(0, amount + weakness - immunity);
    if (!dmg) return actor;
    return actor.modifyTokenAttribute("stamina", -dmg, true, false);
  }
}
class TokenDocumentBase {
  async _preUpdateMovement(movement, operation) {
    log.preMove.push({ token: this.name, id: movement?.id ?? null });
    return undefined;
  }
}
class ActiveEffectRegistry { async refresh() {} }
class CombatBase {
  async _onEndTurn() {}
  async _onExit() {}
}

globalThis.__HARNESS_SETUP__ = () => {
  game.modules.set("lib-wrapper", { active: true });
  globalThis.libWrapper = {
    registered: [],
    register(mod, target, fn, type) {
      const keys = target.split(".");
      const key = keys.pop();
      const parent = keys.reduce((o, k) => o[k], globalThis);
      const descriptor = Object.getOwnPropertyDescriptor(parent, key);
      if (descriptor?.get) Object.defineProperty(parent, key, { ...descriptor, get() { return fn.call(this, descriptor.get.bind(this)); } });
      else {
        const original = parent[key];
        parent[key] = function (...args) { return fn.call(this, original.bind(this), ...args); };
      }
      this.registered.push({ mod, target, type });
    },
  };
  globalThis.CONST = { TOKEN_DISPOSITIONS: { HOSTILE: -1, NEUTRAL: 0, FRIENDLY: 1 }, GRID_TYPES: { GRIDLESS: 0, SQUARE: 1 } };
  ds.data.Actor = { BaseActorModel };
  ds.rolls.DamageRoll.prototype.applyDamage = async function (targets, { halfDamage = false } = {}) {
    const amount = halfDamage ? Math.floor(this.total / 2) : this.total;
    for (const a of targets) await a.system.takeDamage(amount, { type: this.type, ignoredImmunities: this.ignoredImmunities });
  };
  // Combat Tools' MIXED takeover of the Apply button (DSCT system-patches.mjs:297-336): it halves a Shift+Click
  // itself and calls takeDamage for game.user.targets, on the GM through its socket for a creature the user does
  // not own (helpers.mjs:44-51); DamageRoll#applyDamage never runs. `btn.total` stands for the clicked roll.
  ds.rolls.DamageRoll.applyDamageCallback = async function (event) {
    const btn = event.target?.closest?.(".apply-damage") ?? event.currentTarget;
    const amount = event.shiftKey ? Math.floor(btn.total / 2) : btn.total;
    for (const t of [...game.user.targets]) {
      const actor = t.document.actor;
      const take = () => actor.system.takeDamage(amount, { type: "", ignoredImmunities: [], staminaLoss: false });
      if (game.user.isGM || actor.testUserPermission(game.user, "OWNER")) await take();
      else await as(game.users.activeGM, take);
    }
  };
  CONFIG.Token = { documentClass: TokenDocumentBase };
  CONFIG.Combat = { documentClass: CombatBase };
  foundry.helpers = { ActiveEffectRegistry };
  foundry.documents.ActiveEffect = { registry: new ActiveEffectRegistry() };
  foundry.utils.getProperty = getPath;
  foundry.utils.setProperty = (obj, key, value) => { const parts = key.split("."); let o = obj; for (const k of parts.slice(0, -1)) o = o[k] ??= {}; o[parts.at(-1)] = value; };
  foundry.applications = { instances: new Map(), api: { DialogV2: { wait: dialogWait } } };
  // Formulas: @paths from the roll data, then plain arithmetic (as harness7).
  ds.utils.evaluateFormula = (f, rd) => {
    const src = String(f).replace(/@([A-Za-z_][A-Za-z0-9_.]*)/g, (_m, p) => {
      const v = getPath(rd, p);
      if (v === undefined || v === null || typeof v === "object") throw new Error(`no @${p}`);
      return `(${Number(v)})`;
    });
    if (!/^[\d\s+\-*/().]+$/.test(src)) throw new Error(`bad formula ${f}`);
    return Function(`return (${src})`)();
  };
  ds.CONFIG.abilities = { forcedMovement: {
    push: { label: "Push", vertical: "Vertical Push" }, pull: { label: "Pull", vertical: "Vertical Pull" }, slide: { label: "Slide", vertical: "Vertical Slide" },
  } };
  const restrictsTriggers = { type: new Set(["triggered", "freeTriggered"]) };
  CONFIG.statusEffects.push(
    { id: "dazed", _id: "dazed00000000000", name: "Dazed", restrictions: restrictsTriggers },
    { id: "surprised", _id: "surprised0000000", name: "Surprised", restrictions: restrictsTriggers },
    { id: "sleep", _id: "sleep00000000000", name: "Sleep" },
    { id: "bleeding", _id: "bleeding00000000", name: "Bleeding" },
    { id: "dying", _id: "dying00000000000", name: "Dying" },
  );
  // Combat Tools, ctlib (with a batch depth), their settings (read at ready).
  game.modules.set("draw-steel-combat-tools", { active: true, api: dsctApi, title: "Combat Tools" });
  game.modules.set("draw-steel-ctlib", { active: true });
  globalThis.ctlib = ctlibMock;
  for (const [key, value] of Object.entries({
    abilityAutomationEnabled: true, hiwEnabled: false, rollDialogPillUI: true, forcedMovementEnabled: true, conditionsEnabled: true,
  })) game.settings.register("draw-steel-combat-tools", key, { default: value });
  // DOM.
  globalThis.document = {
    body: new El("body"),
    createElement: tag => new El(tag),
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    // Combat Tools' path picker bar / vertical popup while open (`openIds`).
    getElementById: id => (openIds.has(id) ? new El("div") : null),
  };
  globalThis.addEventListener = (type, fn, capture) => windowListeners.push({ type, fn, capture: !!capture });
  globalThis.removeEventListener = (type, fn) => {
    const i = windowListeners.findIndex(l => l.type === type && l.fn === fn);
    if (i >= 0) windowListeners.splice(i, 1);
  };
  globalThis.MutationObserver = MutationObserverMock;
};

/* ---------- Combat Tools / ctlib mocks ---------- */
const ctlibMock = {
  depth: 0,
  services: new Map([["noteDamageCause", () => { log.noteCause++; }]]),
  async damageBatch(fn) {
    this.depth++;
    try {
      return await fn();
    } finally {
      this.depth--;
    }
  },
  async disarmCoverImmunity() { log.disarm++; },
  async replayUndo(entries) {
    for (const e of entries) {
      const doc = fromUuidSync(e.uuid);
      if (e.op === "update") await doc.update(e.data, e.options);
      if (e.op === "stamina") await doc.update({ "system.stamina.value": e.prevValue, "system.stamina.temporary": e.prevTemp });
    }
  },
};
const dsctApi = {
  isFMActive: () => sw.fmActive,
  setRollDialogLock(app, locked, reasons = []) {
    log.locks.push({ locked, reasons: [...reasons] });
    app._dsctBaneLocked = !!locked;
    app._dsctBaneLockReasons = locked ? [...reasons] : [];
    app.element?.classList?.[locked ? "add" : "remove"]("dsct-locked");
  },
  rollDialog: {
    addPill(app, pill) {
      log.pills.push(pill);
      if (Array.isArray(app?._dsctSources)) app._dsctSources.push({ ...pill, id: `ext${log.pills.length}`, enabled: true });
      return true;
    },
  },
  getValidTargets(srcToken, type, range, opts) {
    log.picker.push({ source: srcToken?.document?.name, type, range, opts });
    return [...scene.tokens.values()].filter(t => t.disposition === -1).map(t => t.object);
  },
  async colorTokenPicker({ tokens }) {
    log.picker.at(-1).tokens = tokens.map(t => t.document.uuid);
    return tokens[0] ?? null;
  },
  async forcedMovement(args) {
    const target = canvas.tokens.get(args.targetId);
    const source = args.sourceId ? canvas.tokens.get(args.sourceId) : null;
    let resumed = 0;
    // Combat Tools fires its gate synchronously, before its first await (forced-movement-engine.mjs:54-82).
    const allowed = Hooks.call("dsct.preForcedMovement", {
      target, source, type: args.type, distance: args.distance, resume: () => { resumed++; },
    });
    const entry = { ...args, allowed, at: mclock.t, stamina: target?.document?.actor?.system?.stamina?.value };
    log.fm.push(entry);
    if (!allowed || !target) return undefined;
    const doc = target.document;
    const start = { x: doc.x, y: doc.y, elevation: doc.elevation };
    const dir = args.type === "Pull" ? -1 : 1;
    await doc.update({ x: doc.x + dir * args.distance * G });
    return {
      content: `${doc.name} forced`, undoLog: [{ op: "update", uuid: doc.uuid, data: start, options: { isUndo: true } }],
      moveId: `move${log.fm.length}`, targetTokenId: doc.id, targetSceneId: SCENE, finalPos: { x: doc.x, y: doc.y, elevation: 0 }, hadDamage: false,
      grabsToRestore: [],
    };
  },
  async applyFrightened() {},
  async applyTaunted() {},
};

/* ---------- load the module ---------- */
const world = await import(new URL("./harness.mjs", import.meta.url).href);
// Trigger timing tests isolate Director delegates; harness13 verifies player-selected paths.
Hooks.on("dsAuto.preApplyOp", (_message, op) => { if (["forced", "teleport"].includes(op.kind)) op.synthetic = true; });
const {
  postAbility, makeAbility, hero, gobA, gobB, api, getResolution, buildView, Effect, setCombat, offHook, Message, users, setUser,
  setActiveGM, Actor, registry, messages, notifications,
} = world;
const { gm, gm2, player, player2 } = users;
const imp = p => import(pathToFileURL(ROOT + p).href);
const { clock, promptMs, openPrompts, externalPromptMs: externalPromptMsOf } = await imp("triggers/prompt.mjs");
const { handleTriggerRun, linkSpendBoxes } = await imp("ui/trigger-dialog.mjs");
const { uuidKey, budgetInfo } = await imp("triggers/budget.mjs");
const { kindsInUse, triggersActive } = await imp("triggers/engine.mjs");
const { externalHold, externalDone } = await imp("triggers/holds.mjs");
const { handleOp, timeoutFor } = await imp("relay/queries.mjs");
const { routePrompt, promptTypes } = await imp("relay/prompt-router.mjs");
const { isRollLocked, handlePreRoll, handlePreRollCancel } = await imp("triggers/roll-lock.mjs");
const { withOwnForcedMove, handleFmActive, onDstdSocket, markExternalHalf } = await imp("triggers/external.mjs");
const { effectiveUntil } = await imp("engine/record.mjs");
const { sign } = await imp("engine/ledger.mjs");
const { lifecycleIdle } = await imp("turn/lifecycle.mjs");
const { triggerCardsFor } = await imp("triggers/card.mjs");
const { trackerFor } = await imp("triggers/trackers.mjs");
const { markHalfClick } = await imp("ui/dstd-lock.mjs");

const set = (key, value) => game.settings.set("stef-ds-automation", key, value);
const settle = (ms = 60) => new Promise(r => setTimeout(r, ms));
const tick = () => new Promise(r => setImmediate(r));
Hooks.off = (name, fn) => offHook(name, fn);

/* ---------- manual clock (server time) ---------- */
const mclock = { t: Date.now(), timers: new Map(), seq: 0 };
clock.now = () => mclock.t;
clock.setTimeout = (fn, ms) => {
  const id = ++mclock.seq;
  // A timer fires on the client that armed it (`als` below: the user whose code runs).
  const store = als.getStore();
  mclock.timers.set(id, { at: mclock.t + Math.max(0, Number(ms) || 0), fn: store ? () => als.run(store, fn) : fn });
  return id;
};
clock.clearTimeout = id => { mclock.timers.delete(id); };
game.time = { get serverTime() { return mclock.t; } };
Object.defineProperty(Message.prototype, "timestamp", {
  get() { return this._ts ?? (this._ts = mclock.t); }, set(v) { this._ts = v; }, configurable: true,
});
/** Move server time on; every timer due by then fires in time order, back to back (a jump). */
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
const T = () => promptMs();

/* ---------- users and queries ---------- */
game.users.filter = fn => [gm, gm2, player, player2].filter(fn);
player.name = "Test";
player2.name = "Other";
player.character = null;
// One process plays every client: `game.user` is the user of the client whose code runs (AsyncLocalStorage
// follows every await and timer of it), else the harness default set by setUser (the Director).
const als = new AsyncLocalStorage();
const baseUser = Object.getOwnPropertyDescriptor(game, "user").get;
Object.defineProperty(game, "user", { get: () => als.getStore()?.user ?? baseUser(), configurable: true });
Object.defineProperty(game, "userId", { get: () => game.user.id, configurable: true });
for (const u of [gm, gm2, player, player2]) Object.defineProperty(u, "isSelf", { get: () => game.user === u, configurable: true });
/** Run `fn` on `user`'s client. */
const as = (user, fn) => als.run({ user }, fn);
// GM -> player: the handler runs on the player's client.
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
      throw new Error(err.message); // only the message crosses the socket
    }
  };
}
player.query = clientQuery(player);
player2.query = clientQuery(player2);
// player / other GM -> active GM: the handler runs on that GM's client.
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
  getSpeakerActor: speaker => everyone.find(a => a.id === speaker?.actor) ?? null,
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
/** What an ability's `use()` posts: an ability card the follow-up watchers see (not adopted: timestamp 0). */
function fakeUseCard(item) {
  const msg = { id: foundry.utils.randomID(), timestamp: 0, flags: {}, speaker: { actor: item.actor.id }, system: { parts: { contents: [{ type: "abilityUse", abilityUuid: item.uuid }] } } };
  Hooks.callAll("createChatMessage", msg, {}, game.userId);
  return msg;
}

/* ---------- actors ---------- */
Object.defineProperty(Actor.prototype, "hasPlayerOwner", { get() { return this.owners.size > 0; }, configurable: true });
Object.defineProperty(Actor.prototype, "documentName", { get: () => "Actor", configurable: true });
Actor.prototype.getActiveTokens = function (_linked = false, document = false) {
  return this.token ? [document ? this.token : this.token.object] : [];
};
const RESTRICTING = Object.fromEntries(CONFIG.statusEffects.filter(s => s.restrictions).map(s => [s.id, s.restrictions]));
function restrictionsOf(actor) {
  const type = new Set();
  for (const s of actor.statuses) for (const t of RESTRICTING[s]?.type ?? []) type.add(t);
  actor.system.restrictions = { type, dsid: new Set() };
}
function setStatus(actor, id, on = true) {
  if (on) actor.statuses.add(id);
  else actor.statuses.delete(id);
  restrictionsOf(actor);
}
const expand = (flat) => {
  const out = {};
  for (const [k, v] of Object.entries(flat)) foundry.utils.setProperty(out, k, v);
  return out;
};
// Stamina writes fire updateActor with the system's previousStamina (DSM:1511-1514).
const baseModify = Actor.prototype.modifyTokenAttribute;
Actor.prototype.modifyTokenAttribute = async function (attr, value, isDelta, bar) {
  const prev = { value: this.system.stamina.value, temporary: this.system.stamina.temporary };
  const out = await baseModify.call(this, attr, value, isDelta, bar);
  Hooks.callAll("updateActor", this, { system: { stamina: { value: this.system.stamina.value, temporary: this.system.stamina.temporary } } },
    { ds: { previousStamina: prev } }, game.userId);
  return out;
};
const baseUpdate = Actor.prototype.update;
Actor.prototype.update = async function (changes, options = {}) {
  const prev = { value: this.system.stamina.value, temporary: this.system.stamina.temporary };
  await baseUpdate.call(this, changes);
  Hooks.callAll("updateActor", this, expand(changes), { ...options, ds: { previousStamina: prev } }, game.userId);
  return this;
};
Actor.prototype.createEmbeddedDocuments = async function (_type, data, options = {}) {
  return data.map(d => {
    const statuses = new Set(d.statuses ?? []);
    const e = new Effect({ ...d, statuses: undefined }, this);
    e.statuses = statuses;
    e.uuid = `${this.uuid}.ActiveEffect.${e.id}`;
    e.duration ??= {};
    registry.set(e.uuid, e);
    this.effects.set(e.id, e);
    for (const s of statuses) this.statuses.add(s);
    restrictionsOf(this);
    Hooks.callAll("createActiveEffect", e, options, game.userId);
    return e;
  });
};
Actor.prototype.deleteEmbeddedDocuments = async function (_type, ids, options = {}) {
  const out = [];
  for (const id of ids) {
    const e = this.effects.get(id);
    if (!e) continue;
    this.effects.delete(id);
    for (const s of e.statuses ?? []) this.statuses.delete(s);
    restrictionsOf(this);
    Hooks.callAll("deleteActiveEffect", e, options, game.userId);
    out.push(e);
  }
  return out;
};
const everyone = [];
function enrich(a, { owner = null } = {}) {
  Object.setPrototypeOf(a.system, BaseActorModel.prototype);
  delete a.system.takeDamage;
  a.system.parent = a;
  a.system.restrictions = { type: new Set(), dsid: new Set() };
  a.items ??= new Coll();
  a.img = `${a.name}.png`;
  if (owner) a.owners.add(owner.id);
  everyone.push(a);
  return a;
}
function mkHero(id, name, { owner = null, stamina = 30, chr = { might: 1, agility: 1 }, resource = "Focus", value = 3, R = 2, recoveries = 2 } = {}) {
  const a = new Actor({ uuid: `Actor.${id}`, name, type: "hero", stamina, chr });
  enrich(a, { owner });
  a.system.hero = { primary: { value }, surges: 0, epic: { value: 0 } };
  a.system.coreResource = { name: resource, path: "system.hero.primary.value", minimum: 0 };
  a.system.recoveries = { value: recoveries, max: 8, recoveryValue: 10 };
  a.getRollData = () => ({ R, chr: 2, level: 1, potency: { weak: 1, average: 2, strong: 3 }, recoveries: { recoveryValue: 10 } });
  a.home = { value, recoveries };
  registry.set(a.uuid, a);
  return a;
}

/* ---------- scene and tokens ---------- */
const SCENE = "scene00000000001";
const G = 100;
const scene = { id: SCENE, name: "Start", grid: { size: G, distance: 5 }, tokens: new Coll() };
game.scenes = { active: scene, get: id => (id === SCENE ? scene : null) };
class TokenDoc extends TokenDocumentBase {
  constructor(id, actor, name, gx, gy, disposition) {
    super();
    Object.assign(this, { id, actor, name, x: gx * G, y: gy * G, elevation: 0, width: 1, height: 1, disposition, hidden: false, movementAction: "walk" });
    this.uuid = `Scene.${SCENE}.Token.${id}`;
    this.parent = scene;
    this.actorId = actor.id;
    this.actorLink = !actor.isToken;
    this.texture = { src: `${name}.png` };
    this.object = { id, document: this, scene, get center() { return { x: this.document.x + G / 2, y: this.document.y + G / 2 }; } };
    this.home = { x: this.x, y: this.y, disposition };
  }
  testUserPermission(user, level) { return this.actor?.testUserPermission(user, level) ?? false; }
  get isOwner() { return this.testUserPermission(game.user, "OWNER"); }
  async update(data) {
    for (const k of ["x", "y", "elevation"]) if (k in data) this[k] = data[k];
    return this;
  }
}
function place(id, actor, name, gx, gy, disposition) {
  const doc = new TokenDoc(id, actor, name, gx, gy, disposition);
  registry.set(doc.uuid, doc);
  scene.tokens.set(id, doc);
  actor.token = doc;
  return doc;
}
globalThis.canvas = {
  scene, grid: { size: G, distance: 5, type: 1 },
  tokens: {
    get: id => scene.tokens.get(id)?.object ?? null,
    get placeables() { return [...scene.tokens.values()].map(t => t.object); },
    setTargets(ids, opts) {
      log.targets.push({ user: game.user.id, ids: [...ids], mode: opts?.mode });
      game.user.targets = new Set(ids.map(id => scene.tokens.get(id)?.object).filter(Boolean));
    },
  },
};

// Heroes (owners per §7.1), monsters (the base world's goblins, now on this scene), Arixx.
const borin = mkHero("borin00000000001", "Borin", { owner: player2, resource: "Ferocity", chr: { might: 1, agility: 2 } });
const benedikt = mkHero("benedikt00000001", "Benedikt", { owner: player, chr: { might: 2, agility: 1 } });
const jory = mkHero("jory000000000001", "Jorah", { owner: player, resource: "Discipline", chr: { might: 1, agility: 0 } });
const kade = mkHero("kade000000000001", "KADE", { owner: player, resource: "Wrath" });
const dorian = mkHero("dorian0000000001", "Dorian", { owner: player2, resource: "Insight", value: 2 });
const duelist = mkHero("duelist000000001", "Duelist", { owner: player2, resource: "Drama" });
const conduit = mkHero("conduit000000001", "Conduit", { owner: player, resource: "Piety" });
for (const a of [hero, gobA, gobB]) enrich(a);
hero.system.hero = { primary: { value: 0 }, surges: 3, epic: { value: 0 } };
hero.system.stamina.max = 20;
hero.getRollData = () => ({ chr: 2, potency: { weak: 1, average: 2, strong: 3 } });
for (const g of [gobA, gobB]) {
  g.isToken = true;
  g.getRollData = () => ({ potency: { weak: 1, average: 2, strong: 3 } });
  g.system.characteristics.might ??= { value: 0, resist: 0 };
}
const arixx = new Actor({ uuid: "Actor.arixx00000000001", name: "Arixx", type: "npc", stamina: 40, chr: { might: 2, agility: 2 } });
enrich(arixx);
arixx.getRollData = () => ({ potency: { weak: 1, average: 2, strong: 3 } });
registry.set(arixx.uuid, arixx);
const tBorin = place("tokBorin00000001", borin, "Borin", 5, 5, 1);
const tBen = place("tokBenedikt00001", benedikt, "Benedikt", 6, 5, 1);
const tJory = place("tokJory000000001", jory, "Jorah", 5, 9, 1);
const tKade = place("tokKade000000001", kade, "KADE", 9, 5, 1);
const tDorian = place("tokDorian0000001", dorian, "Dorian", 5, 2, 1);
const tDuelist = place("tokDuelist000001", duelist, "Duelist", 4, 6, 1);
const tConduit = place("tokConduit000001", conduit, "Conduit", 2, 2, 1);
const tGobA = place("tokA000000000001", gobA, "Goblin A", 4, 5, -1);
const tGobB = place("tokB000000000001", gobB, "Goblin B", 12, 5, -1);
const tArixx = place("tokArixx00000001", arixx, "Arixx", 15, 15, -1);
const tHero = place("hero000000000tok", hero, "Hero", 8, 8, 1);
game.actors = new Coll([borin, benedikt, jory, kade, dorian, duelist, conduit, arixx, hero].map(a => [a.id, a]));
const tok = doc => ({ document: doc, actor: doc.actor });

/* ---------- abilities ---------- */
let itemN = 0;
const slugOf = name => name.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
function ability(actor, name, {
  type = "triggered", distance = { type: "melee", primary: 1 }, target = { type: "creature" }, resource = 0, keywords = [], damage = false,
  applied = null, forced = null, powerRoll = true, use = null, attach = true,
} = {}) {
  const id = `it${String(++itemN).padStart(14, "0")}`;
  const item = makeAbility({ uuid: `${actor.uuid}.Item.${id}`, name, actor, damage, applied });
  item.id = id;
  item.documentName = "Item";
  Object.assign(item.system, { _dsid: slugOf(name), type, distance, target, resource, keywords: new Set(keywords) });
  item.system.power.roll = { enabled: powerRoll };
  if (forced) item.system.power.effects.set("fmPRE00000000001", { id: "fmPRE00000000001", type: "forced", name: "Forced", forced });
  item.flags = {};
  item.getFlag = (scope, key) => item.flags?.[scope]?.[key];
  item.testUserPermission = (u, l) => actor.testUserPermission(u, l);
  Object.defineProperty(item, "isOwner", { get: () => actor.testUserPermission(game.user, "OWNER") });
  item.getRollData = () => ({ ...(actor.getRollData?.() ?? {}), potency: { weak: 1, average: 2, strong: 3 } });
  item.system.use = use ?? (async () => {
    log.uses.push({ item: name, user: game.user.id, targets: [...(game.user.targets ?? [])].map(t => t.id) });
    fakeUseCard(item);
    return null;
  });
  if (attach) actor.items.set(id, item);
  item.home = attach;
  return item;
}
// Reactor items (attached on demand: setReactors), and fixed ones.
const parry = ability(benedikt, "Parry", { attach: false });
const mark = ability(benedikt, "Mark", { type: "maneuver", attach: false });
const reflexes = ability(borin, "Unearthly Reflexes", { attach: false });
const borinFreeStrike = ability(borin, "Melee Free Strike", { type: "main", keywords: ["melee", "strike", "weapon"], damage: true });
const shield = ability(jory, "Inertial Shield", { attach: false });
const judgement = ability(kade, "Judgement", { type: "maneuver", distance: { type: "ranged", primary: 10 }, target: { type: "enemy" }, attach: false });
const mlfy = ability(kade, "My Life for Yours", { distance: { type: "ranged", primary: 5 }, target: { type: "ally" }, attach: false, use: null });
const hiw = ability(dorian, "Hesitation is Weakness", { resource: 1, attach: false });
const confusion = ability(dorian, "In All This Confusion", { target: { type: "self" }, distance: { type: "self" }, attach: false });
const riposte = ability(duelist, "Riposte", { attach: false });
const duelistParry = ability(duelist, "Parry", { attach: false });
const guidance = ability(conduit, "Word of Guidance", { distance: { type: "ranged", primary: 10 }, target: { type: "ally" }, attach: false });
const skitter = ability(arixx, "Skitter", { attach: false });
// A detached halve reaction whose note is not an effect (Unearthly Reflexes before library 0.2.0's `effect` notes):
// once the hit is halved, only its spend's potency step is left.
const duck = ability(borin, "Duck", { attach: false });
duck.flags["stef-ds-automation"] = { overlay: { detached: true, key: "ability:duck", version: "1.0.0", triggers: [
  { id: "duck", event: "damage.before", subject: "self", spend: { cost: 1 }, steps: [
    { type: "halve" }, { type: "potency", delta: -1, scope: "all", when: { spend: true } }, { type: "note", text: "Shift by hand" },
  ] },
] } };
const guard = ability(duelist, "Guard", { attach: false });
guard.flags["stef-ds-automation"] = { overlay: { detached: true, key: "ability:guard", version: "1.0.0", triggers: [
  { id: "guard", event: "damage.before", subject: "selfOrAlly", steps: [{ type: "halve" }, { type: "note", text: "Step in" }] },
] } };
const reactorItems = [parry, mark, reflexes, shield, judgement, mlfy, hiw, confusion, riposte, duelistParry, guidance, skitter, duck, guard];
function setReactors(...items) {
  for (const it of reactorItems) it.actor.items.delete(it.id);
  for (const it of items) it.actor.items.set(it.id, it);
}

/* ---------- the attacks ---------- */
const slowed = (value = "@potency.average", condition = "failure") => {
  const tier = { potency: { characteristic: "might", value }, effects: { slowed: { condition, end: "save", properties: new Set() } } };
  return { tier1: { potency: { characteristic: "might", value }, effects: {} }, tier2: tier, tier3: tier };
};
const spear = ability(gobA, "Goblin Spear", { type: "main", keywords: ["melee", "strike", "weapon"], damage: true });
const spearPotent = ability(gobA, "Goblin Hex Spear", { type: "main", keywords: ["melee", "strike", "weapon"], damage: true, applied: slowed() });
const gobBSpear = ability(gobB, "Goblin Spear", { type: "main", keywords: ["melee", "strike", "weapon"], damage: true });
const spearStrong = ability(gobA, "Goblin Brutal Spear", { type: "main", keywords: ["melee", "strike", "weapon"], damage: true, applied: slowed("@potency.strong") });
const spearTrick = ability(gobA, "Goblin Trick Spear", { type: "main", keywords: ["melee", "strike", "weapon"], damage: true, applied: slowed("@potency.average", "success") });
const push = (potency = null) => {
  const tier = { movement: new Set(["push"]), distance: "2", properties: new Set(), potency: potency ? { characteristic: "might", value: potency } : { characteristic: "none", value: "" } };
  return { bonuses: { push: 0, pull: 0, slide: 0 }, tier1: tier, tier2: tier, tier3: tier };
};
const shove = ability(gobA, "Goblin Shove", { type: "main", keywords: ["melee", "strike", "weapon"], damage: true, forced: push("@potency.average") });
const plainShove = ability(gobA, "Goblin Plain Shove", { type: "main", keywords: ["melee", "strike", "weapon"], damage: true, forced: push() });
const javelin = ability(gobA, "Goblin Javelin", { type: "main", keywords: ["melee", "ranged", "strike", "weapon"], damage: true,
  distance: { type: "meleeRanged", primary: 1, secondary: 5 } });
const heroStrike = ability(hero, "Hero Strike", { type: "main", keywords: ["melee", "strike", "weapon"], damage: true, applied: slowed() });
const heroSmash = ability(hero, "Hero Smash", { type: "main", keywords: ["melee", "strike", "weapon"], damage: true, forced: push() });
/** Post an ability card at tier 2 against these tokens (amount null: no damage roll). */
function post(item, docs, amount = 10, { tier = 2, author = gm, type = "" } = {}) {
  const toks = [docs].flat().map(tok);
  return postAbility(item, { [tier]: toks }, amount == null ? {} : { [tier]: [{ total: amount, options: { type } }] }, { author });
}
const opsOf = msg => Object.values(getResolution(msg)?.ops ?? {});
const dmgOp = (msg, actor = null) => opsOf(msg).find(o => o.kind === "damage" && !o.surge
  && (!actor || getResolution(msg).targets?.[o.targetKeys?.[0]]?.actorUuid === actor.uuid));
const condOp = msg => opsOf(msg).find(o => o.kind === "condition");
const cardsSince = n => messages.contents.slice(n).filter(m => getResolution(m)?.shape === "trigger");
const budgetOp = card => opsOf(card).find(o => o.kind === "budget");

/* ---------- combat ---------- */
let cmbN = 0;
function combatant(actor, doc, initiative = 1) {
  const c = {
    id: `cmb${String(++cmbN).padStart(13, "0")}`, name: actor.name, actor, token: doc, initiative, isDefeated: false,
    async update(changes) {
      log.combatUpdates.push({ who: actor.name, changes: { ...changes } });
      Object.assign(this, changes);
      return this;
    },
  };
  return c;
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
    } else target[k] = v;
  }
}
class HarnessCombat extends CombatBase {
  constructor() {
    super();
    this.id = "combat0000000001";
    this.started = true;
    this.round = 2;
    this.turn = null;
    this.scene = scene;
    this.flags = {};
    this.previous = { combatantId: null, round: 2 };
    this.turns = [];
    this.combatants = new Coll();
  }
  get combatant() { return this.turn === null || this.turn === undefined ? null : (this.turns[this.turn] ?? null); }
  getCombatantsByActor(actor) { return this.turns.filter(c => c.actor === actor || (actor?.uuid && c.actor?.uuid === actor.uuid)); }
  async update(changes, options = {}) {
    log.combatUpdates.push({ who: "combat", changes: { ...changes }, options });
    const exp = {};
    for (const [k, v] of Object.entries(changes)) foundry.utils.setProperty(exp, k, v);
    mergeInto(this, exp);
    Hooks.callAll("updateCombat", this, exp, options, game.userId);
    return this;
  }
}
const combat = new HarnessCombat();
for (const [a, d] of [[borin, tBorin], [benedikt, tBen], [jory, tJory], [kade, tKade], [dorian, tDorian], [duelist, tDuelist], [conduit, tConduit],
  [gobA, tGobA], [gobB, tGobB], [arixx, tArixx], [hero, tHero]]) {
  const c = combatant(a, d, 1);
  combat.turns.push(c);
  combat.combatants.set(c.id, c);
}
const cmbOf = a => combat.turns.find(c => c.actor === a);
setCombat(combat);
Object.assign(game.combats, {
  get: id => (id === combat.id ? combat : null),
  get contents() { return [combat]; },
  filter(fn) { return [combat].filter(fn); },
});
const nextRound = () => combat.update({ round: combat.round + 1 });
/** DSCT's "Unspent Triggered Action" effect on an actor (live). */
function dsctBudget(actor, disabled = false) {
  const e = new Effect({ name: "Unspent Triggered Action", disabled, duration: { expired: false }, flags: { "draw-steel-combat-tools": { effectType: "triggered-action" } } }, actor);
  e.statuses = new Set();
  e.keep = true;
  actor.effects.set(e.id, e);
  return e;
}

/* ---------- per-scenario reset ---------- */
const SETTINGS = {
  triggersEnabled: true, triggerPromptSeconds: 20, triggerFallback: "director", triggersOutsideCombat: false, triggerNpcs: true,
  triggerExternalDamage: true, triggerTrackers: true, triggerRollLock: true, deferToTriggersModule: true,
  damageMode: "auto", conditionsMode: "auto", forcedMovementMode: "auto", cardActionRole: 4, respectDstdApplications: true,
};
async function fresh({ reactors = [], round = true } = {}) {
  await settle(20);
  setUser(gm);
  setActiveGM(gm);
  answerFn = () => "decline";
  player.active = true;
  player2.active = true;
  player.intercept = null;
  player2.intercept = null;
  sw.failTakeDamage = 0;
  sw.fmActive = false;
  for (const [k, v] of Object.entries(SETTINGS)) await set(k, v);
  game.settings.set("draw-steel-combat-tools", "hiwEnabled", false);
  game.settings.set("draw-steel-combat-tools", "rollDialogPillUI", true);
  game.modules.delete("draw-steel-triggers");
  game.modules.delete("draw-steel-target-damage");
  for (const a of everyone) {
    a.system.stamina.value = a.system.stamina.max;
    a.system.stamina.temporary = 0;
    if (a.home) {
      a.system.hero.primary.value = a.home.value;
      a.system.recoveries.value = a.home.recoveries;
    }
    a.statuses.clear();
    restrictionsOf(a);
    for (const e of [...a.effects.values()]) if (!e.keep) a.effects.delete(e.id);
  }
  hero.system.hero.surges = 3;
  for (const t of scene.tokens.values()) Object.assign(t, t.home);
  for (const c of combat.turns) Object.assign(c, { initiative: 1, isDefeated: false });
  combat.turn = null;
  setReactors(...reactors);
  for (const u of [gm, gm2, player, player2]) u.targets = new Set();
  // Trackers: everyone above 0 again (re-armed, open re-target prompts dropped).
  for (const a of everyone) Hooks.callAll("updateActor", a, { system: { stamina: { value: a.system.stamina.value } } }, {}, gm.id);
  if (round) await nextRound();
  clear();
  dialogs.length = 0;
}
/** A hero's turn starts and ends (the system's registry refreshes); HIW listens to the turn end. */
async function heroTurn(actor) {
  const c = cmbOf(actor);
  combat.turn = combat.turns.indexOf(c);
  await foundry.documents.ActiveEffect.registry.refresh("turnStart", { combat, round: combat.round, turn: combat.turn });
  combat.turn = null;
  combat.previous = { combatantId: c.id, round: combat.round };
  await foundry.documents.ActiveEffect.registry.refresh("turnEnd", { combat, round: combat.round, turn: null });
}

/* ---------- library: the real wave-2 overlays ---------- */
const WAVE2 = [
  "tactician/parry.json", "null/inertial-shield.json", "troubadour/riposte.json", "censor/my-life-for-yours.json", "conduit/word-of-guidance.json",
  "shadow/hesitation-is-weakness.json", "fury/unearthly-reflexes.json", "shadow/in-all-this-confusion.json", "censor/judgement.json",
  "tactician/mark.json", "monsters/skitter.json",
].map(f => JSON.parse(readFileSync(LIBRARY + f, "utf8")));

/* ======================================================================== */
/*  H1: zero cost without overlays or without a started combat              */
/* ======================================================================== */
{
  await fresh({ reactors: [parry, reflexes] });
  assert.deepEqual([...kindsInUse()], ["damage.after"], "post-damage feature events are available without trigger overlays");
  const msg = post(spear, tBorin, 10);
  await settle();
  assert.equal(borin.system.stamina.value, 20);
  assert.equal(msg.updates, 1, "one write");
  assert.ok(!getResolution(msg).hold);
  assert.equal(dialogs.length + log.relay.length + log.sent.length, 0, "no prompt, no relay");
  // The library registers; without a started combat nothing changes either.
  const reg = api.library.registerSource({ id: "stef-ds-automation.library", priority: 50, overlays: WAVE2 });
  assert.deepEqual([reg.accepted, reg.rejected], [11, 0], "the wave-2 overlays pass the core schema");
  assert.deepEqual([...kindsInUse()].sort(), ["damage.after", "damage.before", "roll.before", "turn.end"]);
  await fresh({ reactors: [parry, reflexes] });
  combat.started = false;
  const msg2 = post(spear, tBorin, 10);
  await settle();
  combat.started = true;
  assert.equal(msg2.updates, 1);
  assert.equal(dialogs.length + log.relay.length + log.sent.length, 0);
  assert.ok(!getResolution(msg2).hold && !dmgOp(msg2).trigger, "no trigger record");
  console.log("ok H1 no overlays / no combat: one write, no prompt, no relay");
}

/* ======================================================================== */
/*  H2: Parry accepted, the damage held while the prompt is open             */
/* ======================================================================== */
let h2 = null;
{
  await fresh({ reactors: [parry] });
  let inside = null;
  let msg = null;
  answerFn = rec => {
    if (rec.name !== "Benedikt") return undefined;
    inside = {
      stamina: borin.system.stamina.value, depth: ctlibMock.depth, cause: log.noteCause, user: game.user.id,
      hold: clone(getResolution(msg)?.hold ?? null),
    };
    return "use";
  };
  const n = messages.size;
  msg = post(spearPotent, tBorin, 10);
  await settle();
  assert.ok(inside, "Benedikt's owner was asked");
  assert.equal(inside.user, "pl", "on the player's client");
  assert.equal(inside.stamina, 30, "nothing written while the prompt is open");
  assert.equal(inside.depth, 0, "outside the ctlib damage batch");
  assert.equal(inside.cause, 0, "Death Tracker attribution not yet noted");
  assert.deepEqual(inside.hold.names, [{ text: "Benedikt (Parry)", playerSide: true }]);
  const op = dmgOp(msg);
  assert.deepEqual(inside.hold.opIds, [op.opId]);
  assert.equal(borin.system.stamina.value, 25, "half of 10");
  assert.equal(op.half, true);
  const e = op.trigger.entries[0];
  assert.equal(e.abilityName, "Parry");
  assert.deepEqual(e.response, ["halve", "potency"]);
  assert.equal(e.halve, true);
  assert.equal(op.trigger.outcome, "used");
  const detail = buildView(msg, getResolution(msg)).rows.flatMap(r => r.ops).find(o => o.kind === "damage").detail;
  assert.ok(detail.includes('DSAUTO.Trigger.HalvedBy {"ability":"Parry","name":"Benedikt"}'), detail);
  assert.ok(!detail.includes("DSAUTO.Card.Half"), "no plain Half bit");
  assert.equal(getResolution(msg).hold, undefined, "hold marker removed by the final write");
  assert.equal(msg.updates, 2, "hold write + final write");
  const cards = cardsSince(n);
  assert.equal(cards.length, 1, "one trigger card, after the write");
  const b = budgetOp(cards[0]);
  assert.equal(b.status, "applied");
  assert.equal(b.charged, true);
  assert.ok(combat.flags["stef-ds-automation"].triggerBudget.used[uuidKey(benedikt.uuid)], "budget recorded on the combat");
  assert.equal(api.triggers.budget(benedikt).available, false);
  h2 = { msg, card: cards[0] };
  console.log("ok H2 Parry held, halved, hold marker, trigger card after the write");
}

/* ======================================================================== */
/*  H3: Parry's spend range                                                  */
/* ======================================================================== */
{
  await fresh({ reactors: [parry] });
  tBen.x = 8 * G; // 3 squares from Borin: only Parry's spend range (1 + Reason 2) reaches
  answerFn = byName({ Benedikt: "use" });
  const n = messages.size;
  post(spear, tBorin, 10);
  await settle();
  const req = sentTo("pl", "trigger").at(-1)?.data;
  assert.ok(req, "prompted");
  assert.deepEqual(req.options[0].spend, { cost: 1, label: "Reach and shift grow with Reason", required: true });
  assert.equal(borin.system.stamina.value, 25);
  const card = cardsSince(n)[0];
  const res = opsOf(card).find(o => o.kind === "resource");
  assert.equal(res.amount, -1);
  assert.equal(res.status, "applied");
  assert.equal(benedikt.system.hero.primary.value, 2, "focus -1");
  // 4 squares: out of reach.
  await fresh({ reactors: [parry] });
  tBen.x = 9 * G;
  post(spear, tBorin, 10);
  await settle();
  assert.equal(dialogs.length, 0, "no prompt at 4 squares");
  assert.equal(borin.system.stamina.value, 20);
  // Adjacent: the spend still buys the longer shift (Parry 1.1.0 splits its note by when.spend), so it is optional.
  await fresh({ reactors: [parry] });
  post(spear, tBorin, 10);
  await settle();
  const adj = sentTo("pl", "trigger").at(-1).data.options[0];
  assert.deepEqual(adj.spend, { cost: 1, label: "Reach and shift grow with Reason", required: false });
  assert.match(adj.stepsText, /Shift up to Reason squares/, "what the spend adds");
  // Protecting himself: the same optional spend (the range check is skipped for "self").
  await fresh({ reactors: [parry] });
  post(spear, tBen, 10);
  await settle();
  assert.equal(sentTo("pl", "trigger").at(-1).data.options[0].spend?.required, false, "self: optional spend offered");
  // A kit's +1 melee distance (already in the prepared base distance) applies to the spend's distance too (third review).
  const baseDist = parry.system.distance.primary;
  const ownSource = Object.getOwnPropertyDescriptor(parry, "_source");
  await fresh({ reactors: [parry] });
  parry.system.distance.primary = Number(baseDist) + 1;
  parry._source = { system: { distance: { primary: baseDist } } };
  try {
    tBen.x = 9 * G;   // 4 squares: 1 + Reason 2 + kit 1
    answerFn = byName({ Benedikt: "use" });
    post(spear, tBorin, 10);
    await settle();
    assert.equal(sentTo("pl", "trigger").at(-1)?.data?.options?.[0]?.spend?.required, true, "the spend reaches 4 squares with the kit");
    assert.equal(borin.system.stamina.value, 25);
  } finally {
    parry.system.distance.primary = baseDist;
    if (ownSource) Object.defineProperty(parry, "_source", ownSource);
    else delete parry._source;
  }
  console.log("ok H3 Parry spend required at 3 squares, none at 4, optional adjacent and for himself (the longer shift); kit bonus");
}

/* ======================================================================== */
/*  H4: Decline is the default                                               */
/* ======================================================================== */
{
  await fresh({ reactors: [parry] });
  const n = messages.size;
  const msg = post(spear, tBorin, 10);
  await settle();
  const rec = triggerDialogs("Benedikt")[0];
  assert.equal(rec.cfg.buttons[0].action, "decline");
  assert.equal(rec.cfg.buttons[0].default, true);
  assert.ok(!rec.cfg.buttons.slice(1).some(b => b.default), "only Decline is the default");
  assert.equal(borin.system.stamina.value, 20, "full damage");
  assert.equal(dmgOp(msg).trigger.outcome, "declined");
  assert.equal(cardsSince(n).length, 0);
  assert.equal(api.triggers.budget(benedikt).available, true, "budget untouched");
  console.log("ok H4 decline (default button): full damage, no card, budget untouched");
}

/* ======================================================================== */
/*  H5: timeout                                                              */
/* ======================================================================== */
{
  await fresh({ reactors: [parry] });
  answerFn = () => undefined; // nobody answers
  const n = messages.size;
  const msg = post(spear, tBorin, 10);
  await settle();
  const rec = triggerDialogs("Benedikt")[0];
  assert.ok(rec && !rec.closed, "dialog open");
  assert.equal(borin.system.stamina.value, 30, "held");
  await advance(T() + 3000);
  await settle();
  assert.equal(borin.system.stamina.value, 20, "full damage");
  assert.equal(dmgOp(msg).trigger.outcome, "timedOut");
  assert.ok(sentTo("pl", "triggerCancel").length, "triggerCancel sent");
  assert.ok(rec.closed, "the owner's dialog closed");
  assert.equal(cardsSince(n).length, 0);
  console.log("ok H5 timeout: full damage, timedOut, triggerCancel, dialog closed");
}

/* ======================================================================== */
/*  H6: owner offline: Director fallback or nobody                           */
/* ======================================================================== */
{
  await fresh({ reactors: [parry] });
  player.active = false;
  const msg = post(spear, tBorin, 10);
  await settle();
  assert.equal(sentTo("pl").length, 0);
  const rec = triggerDialogs("Benedikt")[0];
  assert.equal(rec?.user, "gm", "the Director's own dialog");
  assert.equal(dmgOp(msg).trigger.outcome, "declined");
  await fresh({ reactors: [parry] });
  player.active = false;
  await set("triggerFallback", "skip");
  const msg2 = post(spear, tBorin, 10);
  await settle();
  assert.equal(dialogs.length, 0, "no prompt");
  assert.equal(msg2.updates, 1, "no hold marker");
  assert.equal(dmgOp(msg2).trigger.outcome, "noAnswer");
  assert.equal(borin.system.stamina.value, 20);
  console.log("ok H6 owner offline: Director fallback / skip (noAnswer, one write)");
}

/* ======================================================================== */
/*  H7: dazed, surprised in round 1, asleep, dead                            */
/* ======================================================================== */
{
  for (const [label, prep] of [
    ["dazed", () => setStatus(benedikt, "dazed")],
    ["surprised round 1", async () => { setStatus(benedikt, "surprised"); await combat.update({ round: 1 }); }],
    ["sleep", () => setStatus(benedikt, "sleep")],
    ["dead", () => setStatus(benedikt, "dead")],
  ]) {
    await fresh({ reactors: [parry] });
    await prep();
    const msg = post(spear, tBorin, 10);
    await settle();
    assert.equal(dialogs.length, 0, `no prompt (${label})`);
    assert.equal(msg.updates, 1, `one write (${label})`);
    assert.equal(borin.system.stamina.value, 20);
  }
  console.log("ok H7 dazed / surprised (round 1) / sleep / dead: no prompt, one write");
}

/* ======================================================================== */
/*  H8: the round's budget                                                   */
/* ======================================================================== */
{
  await fresh({ reactors: [parry] });
  answerFn = byName({ Benedikt: "use" });
  let n = messages.size;
  post(spear, tBorin, 10);
  await settle();
  assert.equal(cardsSince(n).length, 1);
  post(spear, tBorin, 10);
  await settle();
  assert.equal(triggerDialogs().length, 1, "second triggered action in the same round: no prompt");
  await nextRound();
  answerFn = byName({ Benedikt: "decline" });
  post(spear, tBorin, 10);
  await settle();
  assert.equal(triggerDialogs().length, 2, "next round: prompt");
  // DSCT's effect present and disabled: no prompt; enabled: prompt, then disabled by our card.
  const eff = dsctBudget(benedikt, true);
  await nextRound();
  post(spear, tBorin, 10);
  await settle();
  assert.equal(triggerDialogs().length, 2, "DSCT effect disabled: no prompt");
  await eff.update({ disabled: false });
  await nextRound();
  answerFn = byName({ Benedikt: "use" });
  n = messages.size;
  const msg = post(spear, tBorin, 10);
  await settle();
  assert.equal(triggerDialogs().length, 3, "DSCT effect enabled: prompt");
  const card = cardsSince(n)[0];
  assert.equal(budgetOp(card).dsctMode, "ours");
  assert.equal(eff.disabled, true, "our card spent DSCT's effect");
  // Undo of the trigger card (GM): budget and DSCT effect back, the origin entry revoked.
  await api.undoOps(card.id);
  await settle();
  assert.ok(!combat.flags["stef-ds-automation"].triggerBudget.used[uuidKey(benedikt.uuid)], "our entry deleted");
  assert.equal(eff.disabled, false, "DSCT effect re-enabled");
  const op = dmgOp(msg);
  assert.equal(op.trigger.entries[0].revoked, true, "origin entry revoked");
  assert.equal(op.trigger.halved, false);
  benedikt.effects.delete(eff.id);
  console.log("ok H8 budget: once per round, DSCT effect respected and spent, undo refunds and revokes");
}

/* ======================================================================== */
/*  H9 + H50: no stacking; the later halving is moot                         */
/* ======================================================================== */
const seenDecisions = [];
Hooks.on("dsAuto.trigger", (event, d) => seenDecisions.push({ ability: d.candidate?.item?.name, reactor: d.candidate?.reactor?.name, outcome: d.outcome, why: d.why }));
{
  await fresh({ reactors: [parry, duck] });
  seenDecisions.length = 0;
  answerFn = rec => {
    if (rec.name === "Benedikt") return "use";
    if (rec.name === "Borin") return (async () => { await tick(); mclock.t += 500; return "use"; })();
    return undefined;
  };
  const n = messages.size;
  const msg = post(spearPotent, tBorin, 10);
  await settle();
  assert.equal(triggerDialogs().length, 2, "both asked (Duck's spend could lower potency: not cancelled)");
  assert.equal(borin.system.stamina.value, 25, "halved once");
  const entries = dmgOp(msg).trigger.entries;
  assert.equal(entries.find(e => e.abilityName === "Parry").outcome, "used");
  const late = entries.find(e => e.abilityName === "Duck");
  assert.equal(late.outcome, "moot");
  assert.equal(late.why, "noEffect");
  const cards = cardsSince(n);
  assert.equal(cards.length, 1, "no card for the moot halving");
  assert.equal(getResolution(cards[0]).trigger.reactorName, "Benedikt");
  assert.equal(api.triggers.budget(borin).available, true, "Borin's reservation released");
  // H50: listeners see the final outcome.
  const r = seenDecisions.filter(d => d.ability === "Duck");
  assert.deepEqual(r.map(d => d.outcome), ["moot"], "dsAuto.trigger: moot, never used");
  console.log("ok H9 no stacking: second halving moot, no card, reservation released (H50 moot reported)");
}

/* ======================================================================== */
/*  H9b: a shift marked as an effect keeps the second reaction (fix)         */
/* ======================================================================== */
{
  // Unearthly Reflexes' shift (`effect: true`): halving never stacks, but the shift is still worth the action.
  await fresh({ reactors: [parry, reflexes] });
  answerFn = rec => {
    if (rec.name === "Benedikt") return "use";
    if (rec.name === "Borin") return (async () => { await tick(); mclock.t += 500; return "use"; })();
    return undefined;
  };
  const n = messages.size;
  const msg = post(spear, tBorin, 10);
  await settle(200);
  assert.equal(triggerDialogs("Borin").length, 1, "Borin asked");
  assert.ok(!sentTo("p2", "triggerCancel").length, "not cancelled as moot by Parry's halving");
  assert.equal(borin.system.stamina.value, 25, "halved once");
  const late = dmgOp(msg).trigger.entries.find(e => e.abilityName === "Unearthly Reflexes");
  assert.equal(late.outcome, "used", "used for its shift");
  assert.equal(late.halve, false);
  const cards = cardsSince(n);
  assert.equal(cards.length, 2, "a card for Reflexes as well");
  const rc = cards.find(c => getResolution(c).trigger.abilityName === "Unearthly Reflexes");
  const notes = opsOf(rc).filter(o => o.kind === "note").map(o => o.text);
  assert.ok(notes.some(t => /Agility/.test(t)), "the shift note");
  assert.ok(!notes.some(t => /halved|Halved/.test(t)), "no halving claimed");
  assert.equal(api.triggers.budget(borin).available, false, "Borin's triggered action spent");
  // An already halved hit (Apply half): Skitter is still offered for its shift.
  await fresh({ reactors: [skitter] });
  await set("damageMode", "manual");
  answerFn = byName({ Arixx: "decline" });
  const hit = post(spear, tArixx, 10);
  await settle();
  assert.equal(triggerDialogs("Arixx").length, 0, "nothing applied yet");
  await api.applyOps(hit.id, [dmgOp(hit).opId], { half: true });
  await settle();
  assert.equal(triggerDialogs("Arixx").length, 1, "Skitter offered on a halved hit (its shift)");
  assert.equal(arixx.system.stamina.value, 35);
  console.log("ok H9b effect notes: Reflexes used for its shift after Parry halved (card, budget); Skitter offered");
}

/* ======================================================================== */
/*  H10: moot cancellation of halve-only prompts; queued reactor not asked   */
/* ======================================================================== */
{
  await fresh({ reactors: [parry, duck, guard] });
  // The Duelist is busy with another prompt (api.triggers.offer on an external hit on him).
  let duelistFirst = null;
  let cardPosted = false;
  answerFn = rec => {
    if (rec.name === "Duelist" && !duelistFirst) {
      duelistFirst = rec;
      return undefined;
    }
    if (rec.name === "Benedikt") return cardPosted ? new Promise(r => setTimeout(() => r("use"), 5)) : "decline";
    return undefined; // Borin: keeps the dialog open
  };
  const busy = api.triggers.offer({
    id: "busyDuelist00001", kind: "damage.before", sceneId: SCENE,
    subject: { actorUuid: duelist.uuid, tokenUuid: tDuelist.uuid, name: "Duelist", isHero: true },
    source: { actorUuid: gobB.uuid, tokenUuid: tGobB.uuid, itemUuid: null, name: "Goblin B", keywords: [], fromAbility: false, known: true },
    damage: { instanceKey: "ext:busy", amount: 4, type: "", halved: false, hasPotency: false, messageId: null, targetKey: null, external: true },
    at: mclock.t,
  });
  await settle(20);
  assert.ok(duelistFirst && !duelistFirst.closed, "Duelist's first prompt open");
  const beforeBen = triggerDialogs("Benedikt").length;   // Benedikt declined that offer
  cardPosted = true;
  const msg = post(spear, tBorin, 10);
  await settle();
  const borinRec = triggerDialogs("Borin")[0];
  assert.ok(borinRec, "Borin was asked");
  assert.ok(triggerDialogs("Benedikt").length > beforeBen, "Benedikt was asked");
  await settle();
  assert.ok(borinRec.closed, "Borin's halve-only prompt closed by Benedikt's acceptance");
  assert.ok(sentTo("p2", "triggerCancel").length >= 1, "triggerCancel sent to Borin's owner");
  duelistFirst.click("decline");
  await busy;
  await settle();
  assert.equal(triggerDialogs("Duelist").length, 1, "the queued Duelist is not asked (instance already halved)");
  assert.equal(borin.system.stamina.value, 25);
  const borinEntry = dmgOp(msg).trigger.entries.find(e => e.byName === "Borin");
  assert.equal(borinEntry?.outcome, "moot", "cancelled prompt recorded as moot");
  console.log("ok H10 moot cancellation (triggerCancel) and the queued reactor not asked");
}

/* ======================================================================== */
/*  H11: potency                                                             */
/* ======================================================================== */
{
  // Listed condition op (fails by 1): resisted now.
  await fresh({ reactors: [parry] });
  answerFn = byName({ Benedikt: "use" });
  const msg = post(spearPotent, tBorin, 10);
  await settle();
  const c = condOp(msg);
  assert.equal(c.status, "skipped");
  assert.equal(c.reason, "triggerResisted");
  assert.equal(c.potency.triggerDeltas[0].delta, -1);
  assert.equal(c.potency.value, 1);
  assert.equal(c.potency.baseValue, 2);
  assert.ok(!borin.statuses.has("slowed"));
  // A pending manual condition op gets the patch through `extra` (written with the record).
  await fresh({ reactors: [parry] });
  await set("conditionsMode", "manual");
  answerFn = byName({ Benedikt: "use" });
  const msg2 = post(spearPotent, tBorin, 10);
  await settle();
  const c2 = condOp(msg2);
  assert.equal(c2.mode, "manual");
  assert.equal(c2.status, "skipped");
  assert.equal(c2.reason, "triggerResisted");
  assert.equal(c2.potency.value, 1);
  // Already applied: the trigger card warns (triggerPotencyLate).
  await fresh({ reactors: [parry] });
  await set("damageMode", "manual");
  answerFn = byName({ Benedikt: "use" });
  const n = messages.size;
  const msg3 = post(spearPotent, tBorin, 10);
  await settle();
  assert.equal(condOp(msg3).status, "applied");
  assert.equal(triggerDialogs().length, 0, "no damage applied yet: no prompt");
  await api.applyOps(msg3.id, [dmgOp(msg3).opId]);
  await settle();
  const card = cardsSince(n)[0];
  assert.ok(getResolution(card).warnings.some(w => w.code === "triggerPotencyLate"), "late potency warned on the trigger card");
  assert.equal(borin.system.stamina.value, 25);
  // condition "success": skipped (resisted) -> pending.
  await fresh({ reactors: [parry] });
  answerFn = byName({ Benedikt: "use" });
  const msg4 = post(spearTrick, tBorin, 10);
  await settle();
  const c4 = condOp(msg4);
  assert.equal(c4.status, "pending", "now applies");
  assert.equal(c4.reason ?? null, null);
  console.log("ok H11 potency: triggerResisted, extra patch on a manual row, late warning, success-condition back to pending");
}

/* ======================================================================== */
/*  H12: re-apply after undo                                                 */
/* ======================================================================== */
{
  await fresh({ reactors: [parry] });
  answerFn = byName({ Benedikt: "use" });
  const n = messages.size;
  const msg = post(spear, tBorin, 10);
  await settle();
  const id = dmgOp(msg).opId;
  await api.undoOps(msg.id, [id]);
  await settle();
  assert.equal(borin.system.stamina.value, 30);
  await api.applyOps(msg.id, [id]);
  await settle();
  assert.equal(triggerDialogs().length, 1, "the used reaction is reused: no prompt");
  assert.equal(borin.system.stamina.value, 25, "halved again");
  assert.equal(dmgOp(msg).half, true);
  // After the revocation (undo of the trigger card) a re-apply prompts again.
  await api.undoOps(msg.id, [id]);
  await api.undoOps(cardsSince(n)[0].id);
  await settle();
  assert.equal(dmgOp(msg).trigger.entries[0].revoked, true);
  answerFn = byName({ Benedikt: "decline" });
  await api.applyOps(msg.id, [id]);
  await settle();
  assert.equal(triggerDialogs().length, 2, "revoked: asked again");
  assert.equal(borin.system.stamina.value, 20);
  // After a declined result a re-apply prompts again (C17).
  await api.undoOps(msg.id, [id]);
  await api.applyOps(msg.id, [id]);
  await settle();
  assert.equal(triggerDialogs().length, 3, "declined: asked again");
  console.log("ok H12 re-apply: used reaction reused, revoked or declined asked again");
}

/* ======================================================================== */
/*  H13: surges on a trigger-halved base                                     */
/* ======================================================================== */
{
  await fresh({ reactors: [parry] });
  answerFn = byName({ Benedikt: "use" });
  const msg = post(heroStrike, tBorin, 10);
  await settle();
  assert.equal(borin.system.stamina.value, 25);
  const c = condOp(msg);
  assert.equal(c.reason, "triggerResisted");
  await api.surge(msg.id, dmgOp(msg).opId, { count: 1 });
  await settle();
  // g(10 + 2) - g(10) = 6 - 5 = 1 (a plain "Apply half" would deal 2 more)
  const s = opsOf(msg).find(o => o.surge?.kind === "damage");
  assert.equal(s.finalAmount, 1);
  assert.equal(borin.system.stamina.value, 24);
  // The resisted-by-one condition takes the +1 potency surge.
  await api.surge(msg.id, c.opId, { potency: true });
  await settle();
  assert.equal(condOp(msg).status, "applied");
  assert.ok(borin.statuses.has("slowed"));
  assert.equal(hero.system.hero.surges, 0);
  console.log("ok H13 surges: halved together with the base, potency surge on a triggerResisted row");
}

/* ======================================================================== */
/*  H14: Riposte (damage.after, free strike follow-up)                       */
/* ======================================================================== */
{
  await fresh({ reactors: [riposte] });
  let during = null;
  let msg = null;
  answerFn = rec => {
    if (rec.kind === "freeStrike") return "strike";
    if (rec.name !== "Duelist") return undefined;
    return (async () => {
      await tick(); // back on the Director's side of the harness (one process plays every client)
      during = { updates: msg.updates, resolved: !!getResolution(msg).resolvedAt };
      const r = await api.applyOps(msg.id); // the card is not locked while the prompt is open
      during.applyDone = !!r;
      return "use";
    })();
  };
  const n = messages.size;
  msg = post(spear, tBorin, 10);
  await settle(200);
  assert.ok(during, "Riposte offered after the damage");
  assert.equal(during.resolved, true);
  assert.equal(during.updates, 1, "after the origin's record write (one write, no hold marker)");
  assert.equal(during.applyDone, true, "another apply on the card completes while the prompt is open");
  const run = sentTo("p2", "triggerRun").at(-1)?.data;
  assert.equal(run?.kind, "freeStrike", "the free strike goes to Borin's owner");
  assert.equal(run.againstTokenUuid, tGobA.uuid);
  assert.equal(run.actorUuid, borin.uuid);
  const card = cardsSince(n)[0];
  assert.deepEqual(getResolution(card).trigger.followUps, [{ kind: "freeStrike", userId: "p2" }]);
  assert.ok(log.uses.some(u => u.item === "Melee Free Strike" && u.targets.includes(tGobA.id)), "Melee Free Strike used against the goblin");
  // Reports: another player is Denied; the follow-up user's reports after the strike started change nothing (fix).
  const report = (sub, id, user) => handleOp({ action: "trigger", trigger: { sub, triggerMessageId: id } }, { user });
  await assert.rejects(report("followUpFailed", card.id, player), /Denied/);
  assert.deepEqual(await report("useStarted", card.id, player2), { ok: true, ignored: true });
  assert.deepEqual(await report("followUpFailed", card.id, player2), { ok: true, ignored: true }, "late refund refused");
  await settle();
  assert.equal(budgetOp(card).status, "applied", "the strike landed: cost and budget stay spent");
  // A skipped free strike undoes the card (nothing landed by itself); a second report does nothing more.
  await nextRound();
  clear();
  answerFn = rec => (rec.kind === "freeStrike" ? "skip" : (rec.name === "Duelist" ? "use" : undefined));
  const n2 = messages.size;
  post(spear, tBorin, 10);
  await settle(200);
  const card2 = cardsSince(n2)[0];
  assert.equal(budgetOp(card2).status, "undone", "a failed free strike undoes the card (nothing landed by itself)");
  assert.deepEqual(await report("useCancelled", card2.id, player2), { ok: true, ignored: true }, "reported once");
  console.log("ok H14 Riposte after the write, free strike to the subject's owner, follow-up reports (once, never after a start)");
}

/* ======================================================================== */
/*  H15: My Life for Yours (use follow-up)                                   */
/* ======================================================================== */
{
  await fresh({ reactors: [mlfy] });
  answerFn = byName({ KADE: "use" });
  // A use() that never resolves (the system's dialog stays open) still reports through the watcher.
  mlfy.system.use = () => {
    log.uses.push({ item: mlfy.name, user: game.user.id, targets: [...(game.user.targets ?? [])].map(t => t.id) });
    fakeUseCard(mlfy);
    return new Promise(() => {});
  };
  let n = messages.size;
  post(spear, tBorin, 10);
  await settle(150);
  const card = cardsSince(n)[0];
  assert.ok(card, "trigger card");
  const run = sentTo("pl", "triggerRun").at(-1)?.data;
  assert.equal(run.kind, "use");
  assert.deepEqual(run.targetTokenUuids, [tBorin.uuid]);
  assert.equal(run.selfTarget, false);
  assert.ok(log.uses.some(u => u.item === "My Life for Yours" && u.targets.join() === tBorin.id), "used with Borin targeted");
  assert.ok(!opsOf(card).some(o => o.kind === "resource"), "a use step costs nothing on the trigger card (H45)");
  assert.equal(budgetOp(card).dsctMode, "byCard");
  await settle(50);
  assert.equal(budgetOp(card).status, "applied", "useStarted keeps the card");
  // useCancelled: no card within the watch time -> the trigger card is undone (budget back).
  await nextRound();
  clear();
  mlfy.system.use = () => new Promise(() => {});
  n = messages.size;
  post(spear, tBorin, 10);
  await settle(150);
  const card2 = cardsSince(n)[0];
  assert.equal(budgetOp(card2).status, "applied");
  assert.equal(api.triggers.budget(kade).available, false);
  await advance(T() + 30_000);
  await settle(150);
  assert.equal(budgetOp(card2).status, "undone", "useCancelled undid the card");
  assert.equal(api.triggers.budget(kade).available, true, "budget back");
  // 0 Recoveries: not offered.
  await nextRound();
  dialogs.length = 0;
  kade.system.recoveries.value = 0;
  post(spear, tBorin, 10);
  await settle(150);
  assert.equal(triggerDialogs("KADE").length, 0, "no Recoveries: no prompt");
  mlfy.system.use = async () => { fakeUseCard(mlfy); return null; };
  // Milestone 9 (D5): a chosen spend with a use step: the follow-up pre-ticks the ability's own spend effect in the
  // system's dialog (which charges it); the trigger card charges nothing (spendByUse).
  await fresh({ reactors: [mlfy] });
  const savedEffects = mlfy.system.effects;
  const spendFx = { id: "spend00000000000", type: "spend", resource: { multiple: false, value: 1 } };
  mlfy.system.effects = { contents: [spendFx], documentsByType: { spend: [spendFx] }, get: id => (id === spendFx.id ? spendFx : null) };
  const usedWith = [];
  mlfy.system.use = async (config, dialogOptions) => { usedWith.push(dialogOptions ?? null); fakeUseCard(mlfy); return null; };
  answerFn = byName({ KADE: { action: "use", spend: true } });
  const wrath = kade.system.hero.primary.value;
  n = messages.size;
  post(spear, tBorin, 10);
  await settle(150);
  const card3 = cardsSince(n)[0];
  assert.ok(card3, "trigger card with the spend");
  const run3 = sentTo("pl", "triggerRun").at(-1)?.data;
  assert.deepEqual(run3.spend, { spend00000000000: 1 }, "the use carries the spend");
  assert.deepEqual(usedWith.at(-1), { context: { spend: { spend00000000000: 1 } } }, "use({}, {context: {spend}}) pre-ticks it");
  assert.ok(!opsOf(card3).some(o => o.kind === "resource"), "the trigger card charges nothing for it");
  assert.equal(getResolution(card3).trigger.spendByUse, true);
  assert.equal(kade.system.hero.primary.value, wrath, "only the system's dialog spends the Wrath");
  const badRun = { type: "triggerRun", kind: "use", runId: "m9badspend000001", triggerMessageId: card3.id, itemUuid: mlfy.uuid, targetTokenUuids: [],
    selfTarget: false, watchMs: 10_000 };
  for (const spend of [{ short: 1 }, { spend00000000000: 21 }, { spend00000000000: 1.5 }, [1], { a000000000000001: 1, a000000000000002: 1, a000000000000003: 1, a000000000000004: 1, a000000000000005: 1 }]) {
    await assert.rejects(routePrompt({ ...badRun, spend }, { user: gm }), /BadRequest/, "validRun refuses a bad spend");
  }
  mlfy.system.effects = savedEffects;
  mlfy.system.use = async () => { fakeUseCard(mlfy); return null; };
  console.log("ok H15 My Life for Yours: use on the subject, watcher reports, useCancelled undoes, Recoveries required, spend by the use's dialog");
}

/* ======================================================================== */
/*  H16: external damage (takeDamage MIXED, two-phase commit)                */
/* ======================================================================== */
{
  await fresh({ reactors: [shield] });
  answerFn = byName({ "Jorah": "use" });
  const n = messages.size;
  await as(player, async () => {
    await jory.system.takeDamage(10, { type: "" });
  });
  await settle(100);
  const hold = relayed("hold")[0];
  assert.ok(hold, "relay hold");
  assert.equal(hold.from, "pl");
  assert.equal(hold.data.hold.amount, 10);
  assert.equal(sentTo("pl", "trigger").at(-1).data.timeoutMs, 10_000, "external prompts last min(T, 10 s): the GM ends by P + 3 s, under Target Damage's 15 s");
  const calls = log.takeDamage.filter(t => t.actor === "Jorah");
  assert.equal(calls.length, 1, "wrapped once");
  assert.equal(calls[0].amount, 5);
  assert.equal(jory.system.stamina.value, 25);
  const done = relayed("holdDone")[0];
  assert.equal(done.data.holdDone.applied, true);
  assert.equal(typeof done.data.holdDone.holdId, "string");
  assert.equal(cardsSince(n).length, 1, "trigger card after holdDone");
  // Passed through without a relay: our own writes, Stamina loss, forced-move damage, squad minions.
  clear();
  await as(player, async () => {
    await jory.system.takeDamage(4, { "stef-ds-automation": { internal: true } });
    await jory.system.takeDamage(3, { staminaLoss: true });
    // Combat Tools' flag left on (a move that threw) without a window: its sourceless damage (area hook,
    // purifying fire) is held again, no fallback on the flag (third review).
    sw.fmActive = true;
    await jory.system.takeDamage(2, { staminaLoss: false });
    sw.fmActive = false;
    jory.system.isMinion = true;
    jory.system.combatGroups.set("squad", {});
    await jory.system.takeDamage(1, {});
    delete jory.system.isMinion;
    jory.system.combatGroups.clear();
  });
  assert.deepEqual(relayed("hold").map(r => r.data.hold.amount), [2], "only the stuck-flag call relayed");
  assert.equal(jory.system.stamina.value, 15);
  // A player who does not own the actor: Denied, the damage lands unchanged.
  await fresh({ reactors: [reflexes] });
  await as(player, async () => {
    await borin.system.takeDamage(10, {});
  });
  await settle();
  assert.ok(log.relayErrors.some(e => e.action === "hold" && /Denied/.test(e.error)));
  assert.equal(borin.system.stamina.value, 20);
  assert.equal(dialogs.length, 0);
  console.log("ok H16 external damage: relay hold, 10 s prompt, wrapped once with half, holdDone, card; pass-throughs; Denied");
}

/* ======================================================================== */
/*  H17: damage.after of external damage                                     */
/* ======================================================================== */
{
  await fresh({ reactors: [mlfy] });
  answerFn = byName({ KADE: "decline" });
  await as(player, async () => {
    await jory.system.takeDamage(6, {});
  });
  await settle(150);
  assert.equal(relayed("hold").length, 0, "nothing could react before the damage: no hold");
  const done = relayed("holdDone")[0];
  assert.ok(done && !done.data.holdDone.holdId, "holdDone without a hold id");
  assert.equal(triggerDialogs("KADE").length, 1, "My Life for Yours offered after the damage");
  // A stale holdDone (another write meanwhile): no offer.
  await nextRound();
  dialogs.length = 0;
  await externalDone({ applied: true, actorUuid: jory.uuid, tokenUuid: tJory.uuid, before: { value: 30, temporary: 0 }, after: { value: 10, temporary: 0 } }, player);
  await settle(150);
  assert.equal(triggerDialogs("KADE").length, 0);
  console.log("ok H17 damage.after of external damage; stale holdDone ignored");
}

/* ======================================================================== */
/*  H18: deferToTriggersModule                                               */
/* ======================================================================== */
function rollApp(item) {
  const element = new El("form");
  const app = {
    element, form: element, renders: 0, handlerCalls: [],
    options: { ability: item, context: { modifiers: { edges: 0, banes: 0 } }, form: { handler: null } },
    render() { this.renders++; },
    submit() { return this.options.form.handler.call(this, null, this.form, {}, {}); }, // programmatic: 4 arguments
  };
  app.options.form.handler = async (...args) => { app.handlerCalls.push(args.length); return "rolled"; };
  return app;
}
/** A submit event on the dialog's form: capture listeners first (ours), then AppV2's handler (3 arguments). */
async function fireSubmit(app) {
  const ev = { target: app.element, prevented: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} };
  for (const l of windowListeners.filter(x => x.type === "submit" && x.capture)) l.fn(ev);
  if (!ev.prevented) await app.options.form.handler.call(app, ev, app.form, {});
  return ev;
}
{
  await fresh({ reactors: [parry, shield, guidance] });
  game.modules.set("draw-steel-triggers", { active: true });
  assert.equal(api.triggers.active(), false);
  const msg = post(spear, tBorin, 10);
  await settle();
  assert.equal(dialogs.length, 0);
  assert.equal(msg.updates, 1);
  await as(player, async () => {
    await jory.system.takeDamage(5, {});
  });
  assert.equal(relayed("hold").length, 0, "no relay");
  const app = rollApp(borinFreeStrike);
  await as(player2, async () => {
    Hooks.callAll("renderAbilityConfigurationDialog", app);
  });
  assert.equal(isRollLocked(app), false, "no roll lock");
  Hooks.callAll("closeAbilityConfigurationDialog", app);
  await set("deferToTriggersModule", false);
  assert.equal(api.triggers.active(), true);
  post(spear, tBorin, 10);
  await settle();
  assert.equal(triggerDialogs("Benedikt").length, 1, "setting off: holds again");
  game.modules.delete("draw-steel-triggers");
  console.log("ok H18 deferToTriggersModule: nothing held, no relay, no lock; setting off holds again");
}

/* ======================================================================== */
/*  H19: Word of Guidance (roll lock)                                        */
/* ======================================================================== */
{
  await fresh({ reactors: [guidance] });
  const app = rollApp(borinFreeStrike);
  let during = null;
  answerFn = rec => {
    if (rec.name !== "Conduit") return undefined;
    return (async () => {
      await settle(10);
      const ev = await as(player2, async () => {   // the roller's client
        const e = await fireSubmit(app);
        await app.submit();
        return e;
      });
      during = { locked: isRollLocked(app), prevented: ev.prevented, calls: app.handlerCalls.length };
      return { action: "use", spend: true };
    })();
  };
  const n = messages.size;
  await as(player2, async () => {
    Hooks.callAll("renderAbilityConfigurationDialog", app);
  });
  await settle(150);
  assert.ok(log.locks[0]?.locked && log.locks[0].reasons.includes("DSAUTO.Trigger.RollLock.Checking"), "Combat Tools' lock with our reason");
  assert.ok(during, "Conduit asked");
  assert.equal(during.locked, true);
  assert.equal(during.prevented, true, "submit blocked");
  assert.equal(during.calls, 0, "app.submit() blocked while locked");
  assert.deepEqual(log.pills.map(p => [p.kind, p.amount]), [["edge", 2]], "double edge pill");
  assert.equal(isRollLocked(app), false, "unlocked");
  assert.equal(log.locks.at(-1).locked, false);
  await as(player2, async () => {
    await fireSubmit(app);
  });
  await settle(150);
  assert.equal(app.handlerCalls.length, 1, "rolled");
  assert.equal(relayed("preRollDone")[0]?.data.preRollDone.applied, true);
  const card = cardsSince(n)[0];
  assert.ok(card, "trigger card after the roll");
  assert.ok(opsOf(card).some(o => o.kind === "note" && /Trigger\.Card\.Edge/.test(o.text)));
  Hooks.callAll("closeAbilityConfigurationDialog", app);
  // Without Combat Tools' pills: our class and the dialog's own modifiers (one edge without the spend).
  await fresh({ reactors: [guidance] });
  game.settings.set("draw-steel-combat-tools", "rollDialogPillUI", false);
  answerFn = byName({ Conduit: "use" });
  const app2 = rollApp(borinFreeStrike);
  await as(player2, async () => {
    Hooks.callAll("renderAbilityConfigurationDialog", app2);
    assert.ok(app2.element.classList.contains("ds-auto-roll-locked"));
  });
  await settle(150);
  assert.equal(app2.options.context.modifiers.edges, 1);
  assert.equal(app2.renders, 1);
  assert.ok(!app2.element.classList.contains("ds-auto-roll-locked"));
  await as(player2, async () => {
    Hooks.callAll("closeAbilityConfigurationDialog", app2);
  });
  await settle(100);
  assert.equal(relayed("preRollDone").at(-1)?.data.preRollDone.applied, false, "closed after the edge without rolling: released");
  // Combat Tools' Judgement lock set after ours stays on unlock.
  await fresh({ reactors: [guidance] });
  const app3 = rollApp(borinFreeStrike);
  answerFn = rec => {
    if (rec.name !== "Conduit") return undefined;
    dsctApi.setRollDialogLock(app3, true, [...app3._dsctBaneLockReasons, "Judgement"]);
    return "decline";
  };
  await as(player2, async () => {
    Hooks.callAll("renderAbilityConfigurationDialog", app3);
  });
  await settle(150);
  assert.deepEqual(log.locks.at(-1), { locked: true, reasons: ["Judgement"] }, "their lock stays");
  Hooks.callAll("closeAbilityConfigurationDialog", app3);
  // Closed while waiting: preRollCancel stops the GM's prompt.
  await fresh({ reactors: [guidance] });
  const app4 = rollApp(borinFreeStrike);
  answerFn = () => undefined;
  await as(player2, async () => {
    Hooks.callAll("renderAbilityConfigurationDialog", app4);
  });
  await settle(100);
  const open = triggerDialogs("Conduit")[0];
  assert.ok(open && !open.closed);
  const n4 = messages.size;
  await as(player2, async () => {
    Hooks.callAll("closeAbilityConfigurationDialog", app4);
  });
  await settle(150);
  assert.ok(relayed("preRollCancel").length, "preRollCancel sent");
  assert.ok(open.closed, "the Conduit's prompt closed");
  assert.equal(cardsSince(n4).length, 0);
  setUser(gm);
  console.log("ok H19 Word of Guidance: lock, blocked submit, double edge pill, commit on roll; modifiers; their lock kept; cancel on close");
}

/* ======================================================================== */
/*  H20: Judgement tracker                                                   */
/* ======================================================================== */
const JUDGED = "MHQDlicbxXquwduc";
const MARK = "YW2JEdoDPd0XlaII";
const effectOn = (actor, id, origin, stamp = null, extra = {}, options = {}) => actor.createEmbeddedDocuments("ActiveEffect", [{
  _id: id, name: id, origin, flags: stamp ? { "stef-ds-automation": { messageId: stamp } } : {}, ...extra,
}], options);
const zeroSeen = [];
Hooks.on("dsAuto.trackerZero", (info, outcome) => zeroSeen.push({ creature: info.creatureUuid, outcome }));
{
  await fresh({ reactors: [judgement] });
  await effectOn(gobA, JUDGED, judgement.uuid, "cardJudge0000001");
  let at = null;
  let msg = null;
  answerFn = rec => {
    if (rec.kind !== "trigger" || rec.name !== "Judgement") return undefined;
    at = { resolved: !!getResolution(msg)?.resolvedAt, updates: msg.updates };
    return "use";
  };
  msg = post(heroSmash, tGobA, 25);
  await settle(800);
  assert.ok(at, "re-target prompt");
  assert.equal(at.resolved, true, "after the card that killed it");
  const req = sentTo("pl", "trigger").at(-1).data;
  assert.equal(req.options[0].id, "retarget");
  assert.equal(req.options[0].eventKind, "zero");
  const run = sentTo("pl", "triggerRun").at(-1)?.data;
  assert.equal(run?.kind, "retarget");
  assert.equal(run.targetType, "enemy");
  assert.equal(run.range, 10);
  assert.deepEqual(run.excludeTokenUuids, [tGobA.uuid]);
  await settle(50);
  assert.equal(log.picker.at(-1)?.type, "enemy");
  assert.ok(!log.picker.at(-1).tokens.includes(tGobA.uuid), "the dead creature is not offered");
  assert.ok(log.uses.some(u => u.item === "Judgement"), "Judgement used again");
  // A second updateActor of the dead creature: no second prompt.
  await gobA.update({ "system.stamina.value": -3 });
  await settle(200);
  assert.equal(triggerDialogs("Judgement").length, 1);
  // The same effect created on gobB by another card ends gobA's.
  await effectOn(gobB, JUDGED, judgement.uuid, "cardJudge0000002");
  await settle();
  assert.ok(!gobA.effects.has(JUDGED), "older judgement ended");
  assert.ok(gobB.effects.has(JUDGED));
  // KADE dazed: no prompt.
  await fresh({ reactors: [judgement] });
  await effectOn(gobA, JUDGED, judgement.uuid, "cardJudge0000003");
  setStatus(kade, "dazed");
  zeroSeen.length = 0;
  await gobA.update({ "system.stamina.value": 0 });
  await settle(300);
  assert.equal(triggerDialogs("Judgement").length, 0, "dazed: no prompt");
  assert.deepEqual(zeroSeen.map(z => z.outcome), ["ineligible"]);
  // Combat Tools' own judgement effect: left to Combat Tools.
  await fresh({ reactors: [judgement] });
  await effectOn(gobA, JUDGED, judgement.uuid, null, { flags: { "draw-steel-combat-tools": { judgement: { actorId: kade.id } }, "stef-ds-automation": { messageId: "cardJudge0000004" } } });
  await gobA.update({ "system.stamina.value": 0 });
  await settle(300);
  assert.equal(triggerDialogs("Judgement").length, 0, "DSCT-flagged: no prompt");
  console.log("ok H20 Judgement: prompt after the card, retarget payload, once per kill, older effect ended, dazed / DSCT excluded");
}

/* ======================================================================== */
/*  H21: Mark ends when its tactician is dying                               */
/* ======================================================================== */
{
  await fresh({ reactors: [mark] });
  await effectOn(gobA, MARK, mark.uuid, "cardMark00000001");
  await effectOn(gobB, MARK, mark.uuid, "cardMark00000001");
  await settle();
  assert.ok(gobA.effects.has(MARK) && gobB.effects.has(MARK), "two marks of the same card both kept");
  await benedikt.createEmbeddedDocuments("ActiveEffect", [{ name: "Dying", statuses: ["dying"] }]);
  await settle();
  assert.ok(!gobA.effects.has(MARK) && !gobB.effects.has(MARK), "dying: every mark of Benedikt ended");
  console.log("ok H21 Mark: same card's marks kept; all end when the tactician is dying");
}

/* ======================================================================== */
/*  H22: Hesitation is Weakness                                              */
/* ======================================================================== */
{
  await fresh({ reactors: [hiw] });
  answerFn = byName({ Dorian: "use" });
  const n = messages.size;
  await heroTurn(borin);
  await settle(150);
  assert.equal(sentTo("p2", "trigger").length, 1, "Dorian's owner asked");
  const turnWrite = log.combatUpdates.findIndex(u => u.who === "combat" && "turn" in u.changes);
  const initWrite = log.combatUpdates.findIndex(u => u.who === "Dorian" && "initiative" in u.changes);
  assert.ok(turnWrite >= 0 && initWrite > turnWrite, "turn first, then initiative - 1");
  assert.equal(log.combatUpdates[turnWrite].changes.turn, combat.turns.indexOf(cmbOf(dorian)));
  assert.equal(log.combatUpdates[turnWrite].options.direction, 1);
  assert.deepEqual(log.combatUpdates[turnWrite].changes["flags.stef-ds-automation.hiwStart"], { combatantId: cmbOf(dorian).id, round: combat.round });
  assert.equal(cmbOf(dorian).initiative, 0);
  const card = cardsSince(n)[0];
  assert.equal(opsOf(card).find(o => o.kind === "resource")?.amount, -1, "Insight 1");
  assert.equal(dorian.system.hero.primary.value, 1);
  combat.turn = null;
  // Combat Tools automates it: no prompt from us.
  await fresh({ reactors: [hiw] });
  game.settings.set("draw-steel-combat-tools", "hiwEnabled", true);
  await heroTurn(borin);
  await settle(100);
  assert.equal(dialogs.length, 0, "DSCT hiwEnabled: no prompt");
  // A turn started meanwhile: the prompt is cancelled, nothing paid; the lifecycle queue never waits on it.
  await fresh({ reactors: [hiw] });
  answerFn = () => undefined;
  const n2 = messages.size;
  await heroTurn(borin);
  await settle(50);
  const rec = triggerDialogs("Dorian")[0];
  assert.ok(rec && !rec.closed, "prompt open");
  const idle = await Promise.race([lifecycleIdle().then(() => true), settle(200).then(() => false)]);
  assert.equal(idle, true, "lifecycle queue idle while the prompt is open");
  await combat.update({ turn: 0 });
  await settle(100);
  assert.ok(rec.closed, "cancelled");
  assert.equal(cardsSince(n2).length, 0);
  assert.equal(dorian.system.hero.primary.value, 2, "no cost");
  combat.turn = null;
  // A subject token with Hostile disposition still matches (subject "creature" + hero).
  await fresh({ reactors: [hiw] });
  tBorin.disposition = -1;
  await heroTurn(borin);
  await settle(100);
  assert.equal(triggerDialogs("Dorian").length, 1, "hostile hero token: still offered");
  console.log("ok H22 Hesitation is Weakness: turn then initiative, Insight paid; DSCT on; cancelled by a turn start; hostile token");
}

/* ======================================================================== */
/*  H23: forced movement gate                                                */
/* ======================================================================== */
// A hand-detached item whose stamp declares forced.before / move.before (no wave-2 overlay does).
const brace = ability(jory, "Brace", { attach: false });
brace.flags["stef-ds-automation"] = { overlay: { detached: true, key: "ability:brace", version: "1.0.0", triggers: [
  { id: "brace", event: "forced.before", subject: "self", steps: [{ type: "note", text: "Brace" }] },
  { id: "step", event: "move.before", subject: "self", steps: [{ type: "use", targets: "none" }] },
] } };
{
  await fresh({ reactors: [] });
  jory.items.set(brace.id, brace);
  Hooks.callAll("createItem", brace);
  assert.ok(kindsInUse().has("forced.before") && kindsInUse().has("move.before"), "stamp kinds in use");
  // Our own move (runDsct marks it): the gate lets it through.
  await withOwnForcedMove(() => dsctApi.forcedMovement({ type: "Push", distance: 1, targetId: tJory.id, sourceId: tGobA.id }));
  assert.equal(log.fm.at(-1).allowed, true, "own move not gated");
  // Someone else's move: held, resumed after the decision.
  let resumed = 0;
  const allowed = Hooks.call("dsct.preForcedMovement", { target: tJory.object, source: tGobA.object, type: "Push", distance: 2, resume: () => { resumed++; } });
  assert.equal(allowed, false, "held");
  assert.equal(resumed, 0);
  await settle();
  assert.equal(resumed, 1, "resumed after the decision");
  // No such reactor on the scene: no work.
  jory.items.delete(brace.id);
  resumed = 0;
  assert.equal(Hooks.call("dsct.preForcedMovement", { target: tJory.object, type: "Push", distance: 2, resume: () => { resumed++; } }), true);
  await settle(20);
  assert.equal(resumed, 0);
  console.log("ok H23 forced gate: own moves pass, others held and resumed, no reactor no work");
}

/* ======================================================================== */
/*  H24: _preUpdateMovement                                                  */
/* ======================================================================== */
{
  await fresh({ reactors: [] });
  const walk = id => ({ id, passed: { waypoints: [{ action: "walk" }] }, pending: { waypoints: [] } });
  const r = await as(player, () => tJory._preUpdateMovement(walk("mv000000000001"), {}));
  assert.equal(r, undefined, "wrapped result");
  assert.equal(log.preMove.length, 1);
  assert.equal(relayed("moveGate").length, 0, "no move.before reactor: no relay");
  jory.items.set(brace.id, brace);
  await as(player, () => tJory._preUpdateMovement(walk("mv000000000002"), {}));
  await settle();
  assert.equal(relayed("moveGate").length, 1, "relay moveGate");
  assert.equal(triggerDialogs("Jorah").length, 1, "Jorah asked (declined)");
  await as(player, async () => {
    await tJory._preUpdateMovement({ id: "mv000000000003", passed: { waypoints: [{ action: "displace" }] } }, {});
    await tJory._preUpdateMovement(walk("mv000000000004"), { "stef-ds-automation": { internal: true } });
  });
  assert.equal(relayed("moveGate").length, 1, "displace and our own moves are not gated");
  jory.items.delete(brace.id);
  console.log("ok H24 _preUpdateMovement: no reactor no relay, moveGate with one, displace / internal skipped");
}

/* ======================================================================== */
/*  H25: prompt router                                                       */
/* ======================================================================== */
{
  await fresh({ reactors: [] });
  // Milestone 6 adds the Persistent upkeep types (summonUpkeep, summonUpkeepCancel); Milestone 7 the hero-token and
  // area upkeep types (heroTokenRegain, heroTokenRegainCancel, zoneUpkeep, zoneUpkeepCancel).
  // Opt-in self teleports add the owner-side teleport/Hide handler.
  // Milestone 9: the affected creature's cleanse choice, the user's target pick, the Persistent keep prompt and its cancel.
  assert.deepEqual(promptTypes().sort(), [
    "cleanseChoice", "diceWait", "featureRule", "forcedStep", "heroTokenRegain", "heroTokenRegainCancel", "movementChoice", "persistentUpkeep", "persistentUpkeepCancel",
    "save", "summonUpkeep", "summonUpkeepCancel", "surgeChoice", "targetPick", "teleportStep", "trigger", "triggerCancel", "triggerRun",
    "zoneUpkeep", "zoneUpkeepCancel",
  ]);
  const eff = { uuid: "Actor.jory000000000001.ActiveEffect.save000000000001", get isOwner() { return jory.testUserPermission(game.user, "OWNER"); },
    system: { rollSave: async () => ({ id: "saveMsg", rolls: [{ product: true, total: 8 }] }) } };
  registry.set(eff.uuid, eff);
  const out = await player.query("stef-ds-automation.prompt", { type: "save", effectUuid: eff.uuid, timeoutMs: 10_000 });
  assert.deepEqual(out, { rolled: true, product: true, total: 8, messageId: "saveMsg" }, "saves still answer through the router");
  await assert.rejects(routePrompt({ type: "nope" }, { user: gm }), /BadRequest/);
  await assert.rejects(routePrompt({ type: "trigger", promptId: "x" }, { user: player }), /Denied/);
  await assert.rejects(as(player2, () => routePrompt({ type: "save", effectUuid: eff.uuid }, { user: gm })), /Denied/);
  console.log("ok H25 prompt router: save works, unknown type BadRequest, non-GM sender Denied");
}

/* ======================================================================== */
/*  H26: late answer; Release from the indicator                             */
/* ======================================================================== */
{
  await fresh({ reactors: [parry] });
  let late = null;
  player.intercept = (_name, data) => (data.type === "trigger"
    ? new Promise(r => { late = () => r({ outcome: "used", optionId: data.options[0].id, spend: false }); })
    : undefined);
  const n = messages.size;
  const msg = post(spear, tBorin, 10);
  await settle();
  assert.ok(late, "asked");
  assert.equal(borin.system.stamina.value, 30);
  await advance(T() + 3000);
  await settle();
  assert.equal(dmgOp(msg).trigger.outcome, "timedOut");
  late();
  await settle();
  assert.equal(borin.system.stamina.value, 20, "the late answer changes nothing");
  assert.equal(cardsSince(n).length, 0);
  assert.equal(api.triggers.budget(benedikt).available, true);
  player.intercept = null;
  // Release (= declined) from the Director's indicator.
  await fresh({ reactors: [parry] });
  answerFn = () => undefined;
  const msg2 = post(spear, tBorin, 10);
  await settle();
  const rec = triggerDialogs("Benedikt")[0];
  assert.equal(api.triggers.open().length, 1);
  const release = document.body.querySelector(".ds-auto-trigger-release");
  assert.ok(release, "indicator with a Release button");
  release.onclick({ preventDefault() {} });
  await settle();
  assert.equal(dmgOp(msg2).trigger.outcome, "declined");
  assert.ok(sentTo("pl", "triggerCancel").length && rec.closed, "the owner's dialog closed");
  assert.equal(borin.system.stamina.value, 20, "damage unchanged");
  assert.equal(document.body.querySelector(".ds-auto-trigger-indicator"), null, "indicator removed");
  console.log("ok H26 late answer ignored; Release = declined, owner's dialog closed");
}

/* ======================================================================== */
/*  H27: two cards held on the same reactor                                  */
/* ======================================================================== */
{
  await fresh({ reactors: [parry] });
  let first = null;
  answerFn = rec => {
    if (rec.name !== "Benedikt") return undefined;
    if (!first) {
      first = rec;
      return undefined;
    }
    return "use";
  };
  const n = messages.size;
  const m1 = post(spear, tBorin, 10);
  await settle(30);
  const m2 = post(spear, tBorin, 10);
  await settle(30);
  assert.equal(triggerDialogs("Benedikt").length, 1, "the second prompt waits for the first");
  first.click("use");
  await settle();
  assert.equal(triggerDialogs("Benedikt").length, 1, "budget spent by the first: the second is not shown");
  assert.equal(dmgOp(m1).half, true);
  assert.ok(!dmgOp(m2).half);
  assert.equal(borin.system.stamina.value, 15);
  assert.equal(cardsSince(n).length, 1);
  console.log("ok H27 one prompt chain per reactor; the spent budget stops the queued one");
}

/* ======================================================================== */
/*  H28: a non-active GM relays the hold                                     */
/* ======================================================================== */
{
  await fresh({ reactors: [shield] });
  setActiveGM(gm2);
  await jory.system.takeDamage(10, {}); // on gm's client
  setActiveGM(gm);
  await settle();
  const h = relayed("hold")[0];
  assert.ok(h && h.from === "gm" && h.to === "g2", "relayed to the active GM");
  assert.equal(triggerDialogs("Jorah").length, 1);
  assert.equal(jory.system.stamina.value, 20);
  console.log("ok H28 non-active GM relays hold to the active GM");
}

/* ======================================================================== */
/*  H29: template render                                                     */
/* ======================================================================== */
{
  const require = createRequire(import.meta.url);
  const Handlebars = paths.handlebars();
  Handlebars.registerHelper("localize", k => k);
  const tpl = Handlebars.compile(readFileSync(paths.TEMPLATES + "parts/resolution.hbs", "utf8"));
  const render = (msg, user) => as(user, () => tpl({ ctx: { dsAuto: buildView(msg, getResolution(msg)) } }));
  // Waiting banner: the Director sees every name, players see "the Director" for Director-side reactors.
  await fresh({ reactors: [skitter] });
  answerFn = () => undefined;
  const n = messages.size;
  const msg = post(heroStrike, tArixx, 10);
  await settle();
  const rec = triggerDialogs("Arixx")[0];
  assert.equal(rec?.user, "gm", "Skitter asks the Director");
  const pv = render(msg, player);
  assert.ok(pv.includes("DSAUTO.Trigger.Waiting") && pv.includes("DSAUTO.Trigger.Director") && !pv.includes("Arixx (Skitter)"), "player banner");
  const gv = render(msg, gm);
  assert.ok(gv.includes("Arixx (Skitter)"), "GM banner names the reactor");
  rec.click("use");
  await settle();
  const gv2 = render(msg, gm);
  assert.ok(gv2.includes("DSAUTO.Trigger.HalvedBy"), "halved by");
  assert.ok(!gv2.includes("DSAUTO.Trigger.Waiting"), "banner gone");
  const card = cardsSince(n)[0];
  const cv = render(card, gm);
  assert.ok(cv.includes("DSAUTO.Trigger.Card.Budget"), "trigger card renders its budget row");
  // GM-only outcome notes; "still spent" with its button on an undone origin row (GM only).
  await fresh({ reactors: [parry] });
  answerFn = byName({ Benedikt: "decline" });
  const m2 = post(spear, tBorin, 10);
  await settle();
  assert.ok(render(m2, gm).includes("DSAUTO.Trigger.Outcome.declined"));
  assert.ok(!/Trigger\.Outcome/.test(render(m2, player)), "outcome notes hidden from players");
  await nextRound();
  answerFn = byName({ Benedikt: "use" });
  const m3 = post(spear, tBorin, 10);
  await settle();
  await api.undoOps(m3.id, [dmgOp(m3).opId]);
  await settle();
  const g3 = render(m3, gm);
  assert.ok(g3.includes("DSAUTO.Trigger.StillSpent") && g3.includes('data-action="dsAutoUndoTrigger"'), "still spent + Undo triggered action");
  const p3 = render(m3, player);
  assert.ok(!p3.includes("StillSpent") && !p3.includes("dsAutoUndoTrigger"));
  console.log("ok H29 template: waiting banner (the Director), halved by, budget row, GM-only notes, still spent button");
}

/* ======================================================================== */
/*  H30: selfCheck                                                           */
/* ======================================================================== */
{
  const sc = api.selfCheck();
  for (const w of ["BaseActorModel.prototype.takeDamage MIXED ok", "DamageRoll.prototype.applyDamage WRAPPER ok", "_preUpdateMovement MIXED ok"]) {
    assert.ok(sc.report.wrappers.includes(w), `${w} in ${sc.report.wrappers}`);
  }
  for (const t of ["save", "trigger", "triggerCancel", "triggerRun"]) assert.ok(sc.report.promptTypes.includes(t));
  assert.equal(sc.report.triggersActive, true);
  console.log("ok H30 selfCheck: three trigger wrappers, four prompt types");
}

/* ---------- test-only overlays (a choice group with a pushed hit; a free triggered ward with a cost) ---------- */
api.library.registerSource({ id: "harness8", priority: 10, overlays: [
  {
    // npc: a goblin uses it (the Milestone 7 NPC guard gives NPCs only monster or `npc: true` overlays).
    key: "ability:goblin-choice", version: "1.0.0", name: "Goblin Choice", npc: true,
    choices: [{ id: "g", options: [{ id: "a", label: "Hit and shove" }, { id: "b", label: "Feint" }] }],
    effects: [
      { id: "d", type: "damage", value: "10", choice: { group: "g", option: "a" } },
      { id: "p", type: "forced", movement: "push", distance: "2", potency: { characteristic: "might", value: "@potency.average" }, choice: { group: "g", option: "a" } },
      { id: "n", type: "note", text: "Feint", choice: { group: "g", option: "b" } },
    ],
  },
  {
    key: "ability:test-ward", version: "1.0.0", name: "Test Ward", effects: [],
    triggers: [{ id: "ward", event: "damage.before", subject: "selfOrAlly", free: true, cost: 2, steps: [{ type: "halve" }] }],
  },
] });
const goblinChoice = ability(gobA, "Goblin Choice", { type: "main", keywords: ["melee", "strike", "weapon"] });
/** An external hit on `doc`'s creature (api.triggers.offer), to keep a reactor's prompt chain busy. */
const extEvent = (doc, id) => ({
  id, kind: "damage.before", sceneId: SCENE,
  subject: { actorUuid: doc.actor.uuid, tokenUuid: doc.uuid, name: doc.name, isHero: true },
  source: { actorUuid: gobB.uuid, tokenUuid: tGobB.uuid, itemUuid: null, name: "Goblin B", keywords: [], fromAbility: false, known: true },
  damage: { instanceKey: `ext:${id}`, amount: 4, type: "", halved: false, hasPotency: false, messageId: null, targetKey: null, external: true },
  at: mclock.t,
});
const rollEvent = (doc, id) => ({
  id, kind: "roll.before", sceneId: SCENE,
  subject: { actorUuid: doc.actor.uuid, tokenUuid: doc.uuid, name: doc.name, isHero: true },
  source: { actorUuid: null, tokenUuid: null, itemUuid: null, name: null, keywords: [], fromAbility: false, known: false },
  roll: { abilityUuid: borinFreeStrike.uuid, dialogId: id, damaging: true },
  at: mclock.t,
});

/* ======================================================================== */
/*  H31: movement from the final state                                       */
/* ======================================================================== */
{
  await fresh({ reactors: [parry] });
  answerFn = byName({ Benedikt: "use" });
  const msg = post(shove, tBorin, 10);
  await settle(300);
  const f = opsOf(msg).find(o => o.kind === "forced");
  assert.equal(f.status, "skipped");
  assert.equal(f.reason, "triggerResisted");
  assert.equal(log.fm.length, 0, "Parry's -1 made the push resisted: no forced movement");
  // The same through a "choose one" pick.
  await fresh({ reactors: [parry] });
  answerFn = byName({ Benedikt: "use" });
  const m2 = post(goblinChoice, tBorin, null);
  await settle();
  assert.equal(dialogs.length, 0, "nothing applied before the pick");
  await api.request({ action: "choose", messageId: m2.id, group: "g", option: "a" });
  await settle(300);
  assert.equal(triggerDialogs("Benedikt").length, 1, "the picked hit is held");
  const f2 = opsOf(m2).find(o => o.kind === "forced");
  assert.equal(f2.status, "skipped");
  assert.equal(f2.reason, "triggerResisted");
  assert.equal(log.fm.length, 0, "no forced movement after the pick either");
  assert.equal(borin.system.stamina.value, 25);
  console.log("ok H31 moves from the final state (resolve and chooseOption)");
}

/* ======================================================================== */
/*  H32 + H50: a held hit that did not land                                  */
/* ======================================================================== */
{
  await fresh({ reactors: [parry] });
  game.modules.set("draw-steel-target-damage", { active: true });
  let msg = null;
  answerFn = rec => {
    if (rec.name !== "Benedikt") return undefined;
    // Target Damage applies the held row meanwhile (its own button).
    msg.flags["draw-steel-target-damage"] = { state: { applications: { a1: {
      target: { tokenUuid: tBorin.uuid }, kind: "damage", partId: "tier2Result00000", rollIndex: 1, status: "applied",
    } } } };
    borin.system.stamina.value -= 10;
    return "use";
  };
  seenDecisions.length = 0;
  const n = messages.size;
  msg = post(spear, tBorin, 10);
  await settle();
  const op = dmgOp(msg);
  assert.equal(op.status, "external");
  assert.equal(op.trigger.entries[0].outcome, "moot");
  assert.equal(op.trigger.entries[0].why, "notApplied");
  assert.equal(!!op.half, false, "halving reverted");
  assert.equal(cardsSince(n).length, 0, "no card, no cost");
  assert.equal(api.triggers.budget(benedikt).available, true, "reservation released");
  assert.deepEqual(seenDecisions.filter(d => d.ability === "Parry").map(d => d.outcome), ["moot"], "H50: moot, never used");
  // A later apply prompts again.
  delete msg.flags["draw-steel-target-damage"];
  game.modules.delete("draw-steel-target-damage");
  answerFn = byName({ Benedikt: "decline" });
  await api.applyOps(msg.id, [op.opId]);
  await settle();
  assert.equal(triggerDialogs("Benedikt").length, 2, "offered again");
  // A preApplyOp veto: no prompt at all.
  await fresh({ reactors: [parry] });
  const veto = Hooks.on("dsAuto.preApplyOp", (_m, o) => (o.kind === "damage" ? false : undefined));
  const m2 = post(spear, tBorin, 10);
  await settle();
  offHook("dsAuto.preApplyOp", veto);
  assert.equal(dialogs.length, 0);
  assert.equal(dmgOp(m2).status, "skipped");
  assert.equal(dmgOp(m2).reason, "hookVetoed");
  console.log("ok H32 not landed: external, moot notApplied, reverted, released, offered again; veto: no prompt (H50)");
}

/* ======================================================================== */
/*  H33: the hold marker only with a sent prompt                             */
/* ======================================================================== */
{
  await fresh({ reactors: [skitter] });
  await set("triggerNpcs", false);
  const msg = post(heroStrike, tArixx, 10);
  await settle();
  assert.equal(dialogs.length, 0);
  assert.equal(msg.updates, 1, "nobody to ask: one write");
  assert.equal(dmgOp(msg).trigger.outcome, "noAnswer");
  // A reactor that drops out while its prompt chain is busy: never asked, one write.
  await fresh({ reactors: [parry] });
  let busyRec = null;
  answerFn = rec => {
    if (rec.name === "Benedikt" && !busyRec) {
      busyRec = rec;
      return undefined;
    }
    return "use";
  };
  const busy = api.triggers.offer(extEvent(tBen, "busyBenedikt0001"));
  await settle(20);
  assert.ok(busyRec && !busyRec.closed);
  const m2 = post(spear, tBorin, 10);
  await settle(30);
  setStatus(benedikt, "dazed");
  busyRec.click("decline");
  await busy;
  await settle();
  assert.equal(triggerDialogs("Benedikt").length, 1, "re-checked after the queue wait: not asked");
  assert.equal(m2.updates, 1);
  assert.equal(borin.system.stamina.value, 20);
  console.log("ok H33 hold marker only when a prompt is sent (NPCs off; reactor dropped out in the queue)");
}

/* ======================================================================== */
/*  H34: deadlines                                                           */
/* ======================================================================== */
{
  await fresh({ reactors: [parry] });
  answerFn = () => undefined;
  const ms = [post(spear, tBorin, 5), post(spear, tBorin, 5), post(spear, tBorin, 5)];
  await settle();
  assert.equal(triggerDialogs("Benedikt").length, 1);
  await advance(T() + 3000);
  await settle();
  assert.equal(triggerDialogs("Benedikt").length, 2, "the second opens with the time left");
  await advance(T() + 3000);
  await settle();
  assert.equal(triggerDialogs("Benedikt").length, 2, "the third: no time left, no dialog");
  const e3 = dmgOp(ms[2]).trigger.entries[0];
  assert.equal(e3.outcome, "timedOut");
  assert.equal(e3.why, "deadline");
  assert.equal(borin.system.stamina.value, 15);
  // The GM answers a queued external hold before the requester's timeout (P + 15 s).
  await fresh({ reactors: [shield] });
  answerFn = () => undefined;
  post(spear, tJory, 5);
  await settle();
  assert.equal(triggerDialogs("Jorah").length, 1);
  const t0 = mclock.t;
  let answeredAt = null;
  const p = as(player, () => jory.system.takeDamage(6, {})).then(() => { answeredAt = mclock.t; });
  await settle();
  await advance(T() + 3000);
  await p;
  await settle();
  assert.ok(answeredAt !== null && answeredAt - t0 <= 12_000 + 15_000, `answered after ${answeredAt - t0} ms`);
  assert.equal(triggerDialogs("Jorah").length, 1, "the queued external prompt had no time left: not shown");
  assert.equal(jory.system.stamina.value, 30 - 5 - 6);
  // An aborted pre-roll stops queued prompts before they open.
  await fresh({ reactors: [guidance] });
  let busyRec = null;
  answerFn = rec => {
    if (rec.name === "Conduit" && !busyRec) {
      busyRec = rec;
      return undefined;
    }
    return "use";
  };
  const busy = api.triggers.offer(rollEvent(tBorin, "busyRoll00000001"));
  await settle(20);
  assert.ok(busyRec && !busyRec.closed);
  const pre = handlePreRoll({ dialogId: "dlg0000000000001", abilityUuid: borinFreeStrike.uuid, actorUuid: borin.uuid, tokenUuid: tBorin.uuid }, player2);
  await settle(20);
  await handlePreRollCancel({ dialogId: "dlg0000000000001" }, player2);
  busyRec.click("decline");
  await busy;
  const r = await pre;
  await settle();
  assert.equal(r.edges, 0);
  assert.equal(triggerDialogs("Conduit").length, 1, "aborted: the queued prompt never opened");
  console.log("ok H34 deadlines: third queued hold timed out without a dialog; external answered in time; aborted pre-roll");
}

/* ======================================================================== */
/*  H35: two-phase commit of external damage                                 */
/* ======================================================================== */
{
  await fresh({ reactors: [shield] });
  answerFn = byName({ "Jorah": "use" });
  const req = (amount = 10) => ({ actorUuid: jory.uuid, tokenUuid: tJory.uuid, amount, type: "", halved: false, ignoredImmunities: [], source: {} });
  const h = await externalHold(req(), player);
  assert.ok(h.holdId);
  assert.equal(h.amount, 5);
  assert.equal(api.triggers.budget(jory).available, false, "reserved until committed");
  await assert.rejects(externalDone({ holdId: h.holdId, applied: true, actorUuid: jory.uuid }, player2), /Denied/);
  const n = messages.size;
  await externalDone({ holdId: h.holdId, applied: false, actorUuid: jory.uuid }, player);
  await settle();
  assert.equal(cardsSince(n).length, 0, "not applied: no card");
  assert.equal(api.triggers.budget(jory).available, true, "released");
  // No holdDone: released after 60 s.
  await nextRound();
  const h2 = await externalHold(req(), player);
  assert.equal(api.triggers.budget(jory).available, false);
  await advance(60_000);
  assert.equal(api.triggers.budget(jory).available, true, "expired");
  await externalDone({ holdId: h2.holdId, applied: true, actorUuid: jory.uuid }, player);
  await settle();
  assert.equal(cardsSince(n).length, 0, "an expired hold commits nothing");
  // `wrapped` throws: the error reaches the caller, wrapped once, the hold released.
  await nextRound();
  log.takeDamage.length = 0;
  sw.failTakeDamage = 1;
  await assert.rejects(jory.system.takeDamage(10, {}), /system refused/);
  await settle();
  assert.equal(log.takeDamage.filter(t => t.actor === "Jorah").length, 1, "wrapped once");
  assert.equal(api.triggers.budget(jory).available, true, "released");
  assert.equal(cardsSince(n).length, 0);
  console.log("ok H35 two-phase commit: applied false / expiry release, Denied for others, a throwing write releases");
}

/* ======================================================================== */
/*  H36: byCard (In All This Confusion)                                      */
/* ======================================================================== */
{
  await fresh({ reactors: [confusion] });
  const eff = dsctBudget(dorian, false);
  answerFn = byName({ Dorian: "use" });
  confusion.system.use = async () => {
    log.uses.push({ item: confusion.name, user: game.user.id, targets: [...(game.user.targets ?? [])].map(t => t.id) });
    return null; // the teleport card never comes
  };
  const n = messages.size;
  post(spear, tDorian, 10);
  await settle(150);
  assert.equal(dorian.system.stamina.value, 25, "halved");
  const card = cardsSince(n)[0];
  assert.equal(budgetOp(card).dsctMode, "byCard");
  assert.equal(eff.disabled, false, "left to Combat Tools' own card");
  const run = sentTo("p2", "triggerRun").at(-1).data;
  assert.equal(run.kind, "use");
  assert.equal(run.selfTarget, true);
  assert.deepEqual(log.uses.at(-1).targets, [tDorian.id], "the reactor's own token targeted");
  await advance(T() + 30_000);
  await settle(150);
  const b = budgetOp(card);
  assert.equal(b.status, "applied", "the halving landed: card kept");
  assert.equal(b.dsctMode, "ours");
  assert.equal(b.after.dsct[0].disabled, true);
  assert.equal(eff.disabled, true, "DSCT's effect disabled by us");
  assert.equal(api.triggers.budget(dorian).available, false, "no second triggered action this round");
  // Undo of a byCard op re-enables DSCT's effect (DSCT disabled it when the ability card posted).
  await nextRound();
  await eff.update({ disabled: false });
  confusion.system.use = async () => { fakeUseCard(confusion); return null; };
  const n2 = messages.size;
  post(spear, tDorian, 10);
  await settle(150);
  const card2 = cardsSince(n2)[0];
  assert.equal(budgetOp(card2).dsctMode, "byCard");
  await eff.update({ disabled: true });
  await api.undoOps(card2.id);
  await settle();
  assert.equal(eff.disabled, false, "re-enabled");
  dorian.effects.delete(eff.id);
  console.log("ok H36 byCard: cancelled use keeps the card, re-tags ours, disables DSCT; undo of byCard re-enables");
}

/* ======================================================================== */
/*  H37: Busy guard                                                          */
/* ======================================================================== */
{
  await fresh({ reactors: [] });
  const msg = post(spear, tBorin, 10);
  await settle();
  const id = dmgOp(msg).opId;
  getResolution(msg).hold = { at: mclock.t, until: mclock.t + 20_000, by: "g2", names: [{ text: "Borin (Unearthly Reflexes)", playerSide: true }], opIds: [id], targetKeys: [] };
  sign(msg);
  for (const fn of [() => api.applyOps(msg.id, [id]), () => api.undoOps(msg.id, [id]), () => api.editOp(msg.id, id, { amount: 5 }), () => api.resolve(msg.id, { force: true })]) {
    await assert.rejects(fn(), /Busy/);
  }
  await advance(30_001);
  await api.undoOps(msg.id, [id]);
  await settle();
  assert.equal(borin.system.stamina.value, 30, "works after effectiveUntil + 10 s");
  // A forged `until` on a fresh card is clamped to message.timestamp + 260 s.
  const fake = new Message({ type: "standard", parts: {} });
  fake._ts = mclock.t;
  fake.flags["stef-ds-automation"] = { resolution: { hold: { at: 0, until: mclock.t + 9_999_999, by: "g2" } } };
  assert.equal(effectiveUntil(getResolution(fake), fake), mclock.t + 260_000);
  console.log("ok H37 Busy guard: refused while another GM holds, works after, forged until clamped");
}

/* ======================================================================== */
/*  H38: kill cause and revive                                               */
/* ======================================================================== */
{
  await fresh({ reactors: [judgement] });
  await effectOn(gobA, JUDGED, judgement.uuid, "cardJudge0000005");
  let at = null;
  answerFn = rec => {
    if (rec.name !== "Judgement") return undefined;
    at = { fm: log.fm.length, x: tGobA.x };
    return undefined;
  };
  zeroSeen.length = 0;
  const msg = post(heroSmash, tGobA, 25);
  await settle(900);
  assert.ok(at, "re-target prompt");
  assert.equal(at.fm, 1, "only after the push");
  assert.equal(at.x, 6 * G);
  const rec = triggerDialogs("Judgement")[0];
  assert.ok(!rec.closed);
  await api.undoOps(msg.id);
  await settle(300);
  assert.equal(gobA.system.stamina.value, 20, "revived by the undo");
  assert.ok(rec.closed, "prompt cancelled");
  assert.equal(zeroSeen.at(-1)?.outcome, "cancelled");
  // An answer after a revive: no follow-up.
  await fresh({ reactors: [judgement] });
  await effectOn(gobA, JUDGED, judgement.uuid, "cardJudge0000006");
  answerFn = rec2 => {
    if (rec2.name !== "Judgement") return undefined;
    gobA.system.stamina.value = 5; // healed without an update the trackers see
    return "use";
  };
  await gobA.update({ "system.stamina.value": 0 });
  await settle(300);
  assert.equal(triggerDialogs("Judgement").length, 1);
  assert.equal(sentTo("pl", "triggerRun").length, 0, "no follow-up for a creature that is up again");
  console.log("ok H38 re-target after the push; undo revives and cancels; answer after a revive does nothing");
}

/* ======================================================================== */
/*  H39: per-entry revocation                                                */
/* ======================================================================== */
{
  await fresh({ reactors: [parry, shield] });
  tBen.x = 6 * G;
  tBen.y = 9 * G; // next to Jorah
  answerFn = rec => {
    if (rec.name === "Benedikt") return "use";
    if (rec.name === "Jorah") return (async () => { await tick(); mclock.t += 500; return { action: "use", spend: true }; })();
    return undefined;
  };
  const n = messages.size;
  const msg = post(spearStrong, tJory, 10);
  await settle(200);
  assert.equal(jory.system.stamina.value, 25);
  const c = condOp(msg);
  assert.equal(c.potency.value, 1);
  assert.equal(c.potency.triggerDeltas.length, 2);
  assert.equal(c.reason, "triggerResisted");
  const cards = cardsSince(n);
  const parryCard = cards.find(m => getResolution(m).trigger.reactorName === "Benedikt");
  const shieldCard = cards.find(m => getResolution(m).trigger.reactorName === "Jorah");
  assert.ok(parryCard && shieldCard, "two trigger cards");
  await api.undoOps(msg.id, [dmgOp(msg).opId]);
  await settle();
  // Undo the Shield's card: the halving stays, potency back to Parry's -1 only, the row fails again.
  await api.undoOps(shieldCard.id);
  await settle(100);
  let op = dmgOp(msg);
  assert.equal(op.trigger.halved, true);
  assert.equal(op.half, true);
  let c2 = condOp(msg);
  assert.equal(c2.potency.value, 2);
  assert.equal(c2.potency.triggerDeltas.length, 1);
  assert.equal(c2.status, "pending", "triggerResisted -> pending");
  // Undo Parry's card: no halving, potency at its base value.
  await api.undoOps(parryCard.id);
  await settle(100);
  op = dmgOp(msg);
  assert.equal(op.half, false);
  assert.equal(op.trigger.halved, false);
  c2 = condOp(msg);
  assert.equal(c2.potency.value, 3);
  assert.equal(c2.status, "pending");
  console.log("ok H39 per-entry revocation: Shield's undo keeps Parry's halving and -1; Parry's undo restores the base");
}

/* ======================================================================== */
/*  H40: Surprised                                                           */
/* ======================================================================== */
{
  await fresh({ reactors: [reflexes] });
  setStatus(borin, "surprised");
  await combat.update({ round: 1 });
  post(spear, tBorin, 10);
  await settle();
  assert.equal(dialogs.length, 0, "round 1: Surprised blocks it");
  await foundry.documents.ActiveEffect.registry.refresh("roundEnd", { combat, round: 1 });
  await settle();
  assert.ok(log.whispers.some(w => w.content.includes("DSAUTO.Trigger.SurprisedEnds") && w.content.includes("Borin")), "GM whisper at the end of round 1");
  await combat.update({ round: 2 });
  post(spear, tBorin, 10);
  await settle();
  assert.equal(triggerDialogs("Borin").length, 1, "round 2, still Surprised: offered");
  console.log("ok H40 Surprised: round 1 blocked, whisper at its end, round 2 offered");
}

/* ======================================================================== */
/*  H41: "Not this round"                                                    */
/* ======================================================================== */
{
  await fresh({ reactors: [parry] });
  answerFn = byName({ Benedikt: "mute" });
  const m1 = post(spear, tBorin, 10);
  await settle();
  assert.equal(dmgOp(m1).trigger.outcome, "declined");
  post(spear, tBorin, 10);
  await settle();
  assert.equal(triggerDialogs("Benedikt").length, 1, "muted for the round");
  await nextRound();
  answerFn = byName({ Benedikt: "decline" });
  post(spear, tBorin, 10);
  await settle();
  assert.equal(triggerDialogs("Benedikt").length, 2, "next round: asked again");
  console.log("ok H41 Not this round: muted until the round changes");
}

/* ======================================================================== */
/*  H42: dialog behaviour                                                    */
/* ======================================================================== */
{
  await fresh({ reactors: [parry] });
  setStatus(benedikt, "bleeding");
  tBen.x = 8 * G; // the spend is required
  answerFn = () => undefined;
  post(spear, tBorin, 10);
  await settle();
  const rec = triggerDialogs("Benedikt")[0];
  assert.equal(rec.cfg.buttons[0].action, "decline");
  assert.equal(rec.cfg.buttons[0].default, true);
  assert.equal(rec.countdown.textContent, 'DSAUTO.Trigger.Dialog.Countdown {"seconds":20}');
  const timers = mclock.timers.size;
  mclock.t += 5000;
  rec.dialog.render();
  assert.equal(rec.countdown.textContent, 'DSAUTO.Trigger.Dialog.Countdown {"seconds":15}', "countdown from the request's deadline");
  assert.equal(mclock.timers.size, timers, "a second render does not re-arm the timers");
  const html = rec.cfg.content;
  for (const s of ["DSAUTO.Trigger.Dialog.UsesBudget", "DSAUTO.Trigger.Dialog.Have {&quot;value&quot;:3}", "DSAUTO.Trigger.Dialog.SpendRequired",
    "Reach and shift grow with Reason", "DSAUTO.Trigger.Dialog.Bleeding", "checked disabled"]) assert.ok(html.includes(s), `dialog shows ${s}`);
  rec.click("decline");
  await settle();
  console.log("ok H42 dialog: Decline default, countdown from the deadline, timers armed once, cost/budget/have/spend/bleeding");
}

/* ======================================================================== */
/*  H43: trigger card undo is the Director's                                 */
/* ======================================================================== */
{
  await fresh({ reactors: [parry] });
  answerFn = byName({ Benedikt: "use" });
  const n = messages.size;
  post(spear, tBorin, 10);
  await settle();
  const card = cardsSince(n)[0];
  await set("cardActionRole", 1);
  await assert.rejects(as(player, () => api.undoOps(card.id, [budgetOp(card).opId])), /Denied/);
  assert.equal(budgetOp(card).status, "applied");
  await api.undoOps(card.id);
  await settle();
  assert.equal(budgetOp(card).status, "undone", "the GM's undo works");
  console.log("ok H43 trigger card undo: the reactor's owner is Denied (C20), the GM may");
}

/* ======================================================================== */
/*  H44: external specifics                                                  */
/* ======================================================================== */
{
  // The system's Shift+Click half damage: the hold request says halved; halving is moot (no prompt here).
  await fresh({ reactors: [shield] });
  await as(player, () => new ds.rolls.DamageRoll(10, {}).applyDamage([jory], { halfDamage: true }));
  await settle();
  assert.equal(relayed("hold")[0]?.data.hold.halved, true);
  assert.equal(dialogs.length, 0, "halve steps moot");
  assert.equal(jory.system.stamina.value, 25);
  // A live fmActive window whose source matches the damage's dsbl source: not held on the GM.
  await fresh({ reactors: [shield] });
  await assert.rejects(Promise.resolve().then(() => handleFmActive({ targetTokenUuid: tBen.uuid, sourceTokenUuid: tGobB.uuid }, player2)), /Denied/);
  handleFmActive({ id: "fmWin00000000001", targetTokenUuid: tBen.uuid, sourceTokenUuid: tGobB.uuid }, player);
  // Combat Tools' own damage helper always passes a staminaLoss key (DSCT/helpers.mjs:117).
  await jory.system.takeDamage(4, { staminaLoss: false, dsbl: { source: { tokenUuid: tGobB.uuid } } });
  await settle();
  assert.equal(dialogs.length, 0, "collision damage of a remote forced move passes");
  assert.equal(jory.system.stamina.value, 26);
  // The window covers only Combat Tools' damage calls of that move (fix): the system's Apply button or a
  // Target Damage row (no staminaLoss key) on the pushed creature, or Combat Tools damage from another source.
  setReactors(shield, parry);
  await jory.system.takeDamage(4, { dsbl: { source: { tokenUuid: tGobB.uuid } } });
  await settle();
  assert.equal(triggerDialogs("Jorah").length, 1, "no staminaLoss key: held");
  dialogs.length = 0;
  await benedikt.system.takeDamage(4, { type: "" });
  await settle();
  assert.equal(triggerDialogs("Benedikt").length, 1, "Apply on the window's target: held");
  dialogs.length = 0;
  await benedikt.system.takeDamage(4, { staminaLoss: false, dsbl: { source: { tokenUuid: tGobA.uuid, actorUuid: gobA.uuid } } });
  await settle();
  assert.equal(triggerDialogs("Benedikt").length, 1, "another source's damage on the target: held");
  dialogs.length = 0;
  await benedikt.system.takeDamage(4, { staminaLoss: false });
  await settle();
  assert.equal(dialogs.length, 0, "sourceless Combat Tools damage on the target (a fall) passes");
  // The requester ends the window when the move ends: then the move's source is held again.
  assert.deepEqual(await handleOp({ action: "fmActive", fmActive: { id: "fmWin00000000001", end: true } }, { user: player }), { ok: true });
  await jory.system.takeDamage(4, { staminaLoss: false, dsbl: { source: { tokenUuid: tGobB.uuid } } });
  await settle();
  assert.equal(triggerDialogs("Jorah").length, 1, "window ended: held");
  // Requesting client: the window is announced, refreshed while Combat Tools' move runs, and ended after it.
  await fresh({ reactors: [shield] });
  await as(player, async () => {
    assert.equal(Hooks.call("dsct.preForcedMovement", { target: tGobA.object, source: tBen.object, type: "Push", distance: 2, resume() {} }), true);
  });
  await settle();
  const fmCalls = () => relayed("fmActive").map(r => r.data.fmActive);
  assert.equal(fmCalls().length, 1);
  const wid = fmCalls()[0].id;
  assert.ok(wid && fmCalls()[0].targetTokenUuid === tGobA.uuid, "announced with an id");
  openIds.add("dsct-picker-topbar");   // a long path pick: refreshed
  await advance(16_000);
  assert.ok(fmCalls().some(f => f.id === wid && f.refresh === true), "refreshed while the pick runs");
  openIds.delete("dsct-picker-topbar");
  sw.fmActive = true;
  await advance(1_000);
  sw.fmActive = false;
  await advance(1_000);
  assert.ok(fmCalls().some(f => f.id === wid && f.end === true), "ended when Combat Tools' move ended");
  // Target Damage's Shift+Click half (its own path, not DamageRoll#applyDamage): marked, so halving is moot (fix).
  await fresh({ reactors: [shield] });
  // A player's click: Target Damage's socket request reaches the active GM, whose handler then calls takeDamage.
  onDstdSocket({ type: "request", action: "applyDamage", payload: { halfDamage: true, target: { tokenUuid: tJory.uuid, actorUuid: jory.uuid } } });
  await jory.system.takeDamage(5, { type: "" });
  await settle();
  assert.equal(triggerDialogs("Jorah").length, 0, "a Target Damage half click: Inertial Shield's halving moot, no prompt");
  assert.equal(jory.system.stamina.value, 25);
  await jory.system.takeDamage(5, { type: "" });
  await settle();
  assert.equal(triggerDialogs("Jorah").length, 1, "the mark is used once");
  markExternalHalf([tJory.uuid]);
  await advance(6_000);
  await jory.system.takeDamage(4, { type: "" });
  await settle();
  assert.equal(triggerDialogs("Jorah").length, 2, "the mark expires");
  // A GM's own Shift+Click on a Target Damage row (handler run locally): marked from the capture listener.
  game.modules.set("draw-steel-target-damage", { active: true });
  const panel = new El("section");
  panel.matches = () => true;
  const row = { dataset: { dstdAction: "applyDamage", target: JSON.stringify({ tokenUuid: tJory.uuid, actorUuid: jory.uuid }) }, closest: sel => (sel.startsWith("section") ? panel : row) };
  markHalfClick({ shiftKey: true, target: { closest: sel => (sel.includes("purifying") ? null : row) } });
  await jory.system.takeDamage(4, { type: "" });
  await settle();
  assert.equal(triggerDialogs("Jorah").length, 2, "GM Shift+Click marked: no prompt");
  game.modules.delete("draw-steel-target-damage");
  // A subject our pre-pass holds right now: an external hold passes through without a prompt.
  await fresh({ reactors: [parry] });
  answerFn = () => undefined;
  post(spear, tBorin, 10);
  await settle();
  const rec = triggerDialogs("Benedikt")[0];
  const h = await externalHold({ actorUuid: borin.uuid, tokenUuid: tBorin.uuid, amount: 6, type: "", halved: false, ignoredImmunities: [], source: {} }, player2);
  assert.equal(h.holdId, null);
  assert.equal(h.amount, 6);
  assert.equal(triggerDialogs("Benedikt").length, 1, "no second prompt");
  rec.click("decline");
  await settle();
  // An external hit with no source counts as a creature's (Parry's attacker "creature").
  await fresh({ reactors: [parry] });
  await externalHold({ actorUuid: borin.uuid, tokenUuid: tBorin.uuid, amount: 6, type: "", halved: false, ignoredImmunities: [], source: {} }, player2);
  assert.equal(triggerDialogs("Benedikt").length, 1, "Parry offered for a sourceless external hit");
  console.log("ok H44 external: Shift+Click halved, remote forced-move window, held subject passes, sourceless hit is a creature's");
}

/* ======================================================================== */
/*  H45: costs                                                               */
/* ======================================================================== */
{
  await fresh({ reactors: [parry] });
  setStatus(benedikt, "bleeding");
  answerFn = byName({ Benedikt: "use" });
  const n = messages.size;
  post(spear, tBorin, 10);
  await settle();
  assert.equal(sentTo("pl", "trigger").at(-1).data.options[0].bleeding, true, "the prompt warns");
  const card = cardsSince(n)[0];
  assert.ok(opsOf(card).some(o => o.kind === "note" && o.mode === "manual" && o.text === "DSAUTO.Trigger.Card.Bleeding"), "Bleeding row on the card");
  // (A use step costs nothing: H15.) Two free uses with a cost on one reactor with resource for one.
  await fresh({ reactors: [] });
  const ward = ability(benedikt, "Test Ward", { type: "freeTriggered" });
  let first = null;
  answerFn = rec => {
    if (rec.name !== "Benedikt") return undefined;
    if (!first) {
      first = rec;
      return undefined;
    }
    return "use";
  };
  post(spear, tBorin, 10);
  await settle(30);
  post(spear, tBorin, 10);
  await settle(30);
  first.click("use");
  await settle(150);
  assert.equal(triggerDialogs("Benedikt").length, 1, "the pending debit leaves too little for the second");
  assert.equal(benedikt.system.hero.primary.value, 1, "paid once (2 of 3)");
  assert.equal(borin.system.stamina.value, 15);
  benedikt.items.delete(ward.id);
  console.log("ok H45 costs: bleeding row and prompt line; pending debit blocks the second free use");
}

/* ======================================================================== */
/*  H46: roll lock extras                                                    */
/* ======================================================================== */
{
  await fresh({ reactors: [guidance] });
  answerFn = () => undefined;
  const app = rollApp(borinFreeStrike);
  await as(player2, async () => { Hooks.callAll("renderAbilityConfigurationDialog", app); });
  await settle(50);
  const rec = triggerDialogs("Conduit")[0];
  assert.ok(rec && !rec.closed);
  // Combat Tools' Judgement timer clears the shared lock: ours comes back with both reasons.
  app._dsctBaneLockReasons = [...app._dsctBaneLockReasons, "Judgement"];
  app.element.classList.remove("dsct-locked");
  mutate();
  const last = log.locks.at(-1);
  assert.ok(last.locked && last.reasons.includes("DSAUTO.Trigger.RollLock.Checking") && last.reasons.includes("Judgement"), "reasons merged");
  // "Roll without waiting".
  const skip = app.element.querySelector("button");
  assert.equal(skip?.textContent, "DSAUTO.Trigger.RollLock.Skip");
  await as(player2, async () => skip.onclick({ preventDefault() {}, stopPropagation() {} }));
  assert.equal(isRollLocked(app), false, "unlocked at once");
  await settle(100);
  assert.ok(relayed("preRollCancel").length, "preRollCancel");
  assert.ok(rec.closed, "the Conduit's prompt closed");
  assert.deepEqual(log.locks.at(-1), { locked: true, reasons: ["Judgement"] }, "Combat Tools' own reason stays");
  await as(player2, async () => { Hooks.callAll("closeAbilityConfigurationDialog", app); });
  console.log("ok H46 roll lock: reasons merged on re-assert; Roll without waiting cancels and unlocks");
}

/* ======================================================================== */
/*  H47: Hesitation is Weakness when the turn is taken meanwhile             */
/* ======================================================================== */
{
  await fresh({ reactors: [hiw] });
  seenDecisions.length = 0;
  answerFn = rec => {
    if (rec.name !== "Dorian") return undefined;
    combat.turn = combat.turns.indexOf(cmbOf(gobA)); // the Director started a turn (no updateCombat seen yet)
    return "use";
  };
  const n = messages.size;
  await heroTurn(borin);
  await settle(150);
  combat.turn = null;
  assert.equal(cardsSince(n).length, 0, "no card");
  assert.equal(dorian.system.hero.primary.value, 2, "no cost");
  assert.equal(api.triggers.budget(dorian).available, true, "reservation released");
  assert.deepEqual(seenDecisions.filter(d => d.ability === "Hesitation is Weakness").map(d => [d.outcome, d.why]), [["moot", "turnTaken"]]);
  console.log("ok H47 HIW: turn taken meanwhile -> moot, released, no card");
}

/* ======================================================================== */
/*  H48: tracker creations                                                   */
/* ======================================================================== */
{
  await fresh({ reactors: [mark] });
  await effectOn(gobA, MARK, mark.uuid, "cardMarkA0000001");
  // Re-created by our undo (restore marker): nothing ended.
  await effectOn(gobB, MARK, mark.uuid, "cardMarkB0000001", {}, { "stef-ds-automation": { restore: true } });
  await settle();
  assert.ok(gobA.effects.has(MARK), "restore does not end the older mark");
  // Without a card stamp: nothing ended.
  await gobB.deleteEmbeddedDocuments("ActiveEffect", [MARK]);
  await effectOn(gobB, MARK, mark.uuid, null);
  await settle();
  assert.ok(gobA.effects.has(MARK), "unstamped effect does not end it");
  await gobB.deleteEmbeddedDocuments("ActiveEffect", [MARK]);
  // A Mark applied by another tactician ability (no tracker on that item): found through the source actor.
  const overwatch = ability(benedikt, "Overwatch", { type: "main" });
  const [e] = await effectOn(gobB, MARK, overwatch.uuid, "cardOther0000001");
  await settle();
  assert.equal(trackerFor(e)?.item, mark, "Mark's tracker found through Benedikt");
  assert.ok(!gobA.effects.has(MARK), "the older mark ended");
  benedikt.items.delete(overwatch.id);
  console.log("ok H48 tracker creations: restore / unstamped ignored; tracker found through the source actor");
}

/* ======================================================================== */
/*  H49: Riposte at range, and after a push                                  */
/* ======================================================================== */
{
  await fresh({ reactors: [riposte] });
  tGobA.x = 10 * G; // 5 squares from Borin
  post(javelin, tBorin, 10);
  await settle(200);
  assert.equal(triggerDialogs("Duelist").length, 0, "a melee+ranged strike used at range: no Riposte");
  await fresh({ reactors: [riposte] });
  let at = null;
  answerFn = rec => {
    if (rec.name !== "Duelist") return undefined;
    at = { x: tBorin.x };
    return "decline";
  };
  post(plainShove, tBorin, 10);
  await settle(600);
  assert.ok(at, "still offered");
  assert.equal(at.x, 7 * G, "Borin was already pushed out of reach (measured from before the hit)");
  console.log("ok H49 Riposte: not at range; offered from the pre-hit positions after a push");
}

console.log("ok H50 dsAuto.trigger reports final outcomes (moot in H9 and H32)");

/* ======================================================================== */
/*  H51: the reactor queue wait ends by the offer's deadline (fix)           */
/* ======================================================================== */
{
  await fresh({ reactors: [parry] });
  answerFn = () => undefined;
  post(spear, tBorin, 10);   // our pre-pass asks Benedikt (deadline 2T + 6 s)
  await settle();
  const first = triggerDialogs("Benedikt")[0];
  assert.ok(first && !first.closed);
  // External damage on another ally of Benedikt (Duelist, 2 squares: Parry with the spend) queues behind it.
  const t0 = mclock.t;
  let done = null;
  externalHold({ actorUuid: duelist.uuid, tokenUuid: tDuelist.uuid, amount: 6, type: "", halved: false, ignoredImmunities: [], source: {} }, player2)
    .then(r => { done = { r, at: mclock.t }; });
  await settle();
  assert.equal(done, null, "waiting in Benedikt's queue");
  await advance(externalPromptMsOf() + 3_000 - 3_000);
  assert.ok(done, "given up by its deadline - 3 s, while the other prompt is still open");
  assert.ok(done.at - t0 <= 10_000, `after ${done.at - t0} ms`);
  assert.equal(done.r.holdId, null);
  assert.equal(done.r.amount, 6, "unchanged");
  assert.ok(!first.closed);
  first.click("decline");
  await settle();
  assert.equal(triggerDialogs("Benedikt").length, 1, "the abandoned job never prompts");
  // A lone external prompt whose answer never comes back (a stalled client): the GM gives up at P + 3 s
  // (under Target Damage's 15 s, C19).
  await nextRound();
  player.intercept = (_name, data) => (data?.type === "trigger" ? new Promise(() => {}) : undefined);
  const t1 = mclock.t;
  let done2 = null;
  externalHold({ actorUuid: duelist.uuid, tokenUuid: tDuelist.uuid, amount: 6, type: "", halved: false, ignoredImmunities: [], source: {} }, player2)
    .then(r => { done2 = { r, at: mclock.t }; });
  await settle();
  assert.equal(sentTo("pl", "trigger").at(-1)?.data.timeoutMs, 10_000, "asked for 10 s");
  await advance(12_900);
  assert.equal(done2, null);
  await advance(200);
  assert.ok(done2 && done2.at - t1 <= 13_100, "GM side ends by P + 3 s");
  player.intercept = null;
  console.log("ok H51 queue wait bounded by the deadline (no prompt after); external hold ends by P + 3 s");
}

/* ======================================================================== */
/*  H52: surge / undo during a hold (fix)                                    */
/* ======================================================================== */
{
  assert.ok(timeoutFor("surge") >= 30_000 + 2 * T() + 6_000 + 3_000, "surge waits out a hold of the card");
  assert.ok(timeoutFor("undo") >= 30_000 + 2 * T() + 6_000 + 3_000, "undo waits out a hold of the card");
  assert.ok(timeoutFor("apply") >= 300_000);
  await set("triggerPromptSeconds", 120);
  assert.ok(timeoutFor("apply") >= 2 * (2 * 120_000 + 9_000), "two holds back to back at 120 s");
  await set("triggerPromptSeconds", 20);
  await fresh({ reactors: [parry] });
  await set("damageMode", "manual");
  answerFn = () => undefined;
  const m = post(spear, [tJory, tBorin], 10);
  await settle();
  const jId = dmgOp(m, jory).opId;
  const bId = dmgOp(m, borin).opId;
  await api.applyOps(m.id, [jId]);   // Jorah: nobody in reach
  await settle();
  assert.equal(triggerDialogs().length, 0);
  const applying = api.applyOps(m.id, [bId]);
  await settle();
  const rec = triggerDialogs("Benedikt")[0];
  assert.ok(rec && getResolution(m).hold, "held");
  const opView = () => buildView(m, getResolution(m)).rows.flatMap(r => r.ops).find(o => o.opId === jId);
  assert.equal(opView().canUndo, false, "no Undo while the card is held");
  rec.click("decline");
  await applying;
  await settle();
  assert.equal(opView().canUndo, true, "Undo again once the hold ended");
  console.log("ok H52 surge / undo: requester timeouts cover a hold; buttons hidden while held");
}

/* ======================================================================== */
/*  H53: halving to 0 keeps the weakness (fix)                               */
/* ======================================================================== */
{
  await fresh({ reactors: [shield] });
  answerFn = byName({ "Jorah": "use" });
  jory.system.damage.weaknesses.fire = 5;
  try {
    await jory.system.takeDamage(1, { type: "fire" });
    await settle(100);
  } finally {
    delete jory.system.damage.weaknesses.fire;
  }
  assert.equal(triggerDialogs("Jorah").length, 1);
  assert.equal(log.takeDamage.filter(t => t.actor === "Jorah").at(-1)?.amount, 0, "the system's takeDamage called with 0");
  assert.equal(jory.system.stamina.value, 25, "0 + weakness 5, as the system and our own engine path");
  console.log("ok H53 external hit halved to 0 still takes the weakness");
}

/* ======================================================================== */
/*  H54: an undone trigger card is final (fix)                               */
/* ======================================================================== */
{
  await fresh({ reactors: [parry] });
  answerFn = byName({ Benedikt: { action: "use", spend: true } });   // 1 Focus for the longer shift
  const n = messages.size;
  post(spear, tBorin, 10);
  await settle();
  const card = cardsSince(n)[0];
  assert.equal(benedikt.system.hero.primary.value, 2, "Focus spent");
  await api.undoOps(card.id);
  await settle();
  assert.equal(budgetOp(card).status, "undone");
  await assert.rejects(api.applyOps(card.id, [budgetOp(card).opId]), /Denied/, "the Director cannot re-apply it either");
  const res = opsOf(card).find(o => o.kind === "resource");
  await assert.rejects(api.applyOps(card.id, [res.opId]), /Denied/);
  assert.equal(benedikt.system.hero.primary.value, 3, "no focus charged again");
  assert.equal(api.triggers.budget(benedikt).available, true, "no budget charged again");
  assert.ok(buildView(card, getResolution(card)).rows.flatMap(r => r.ops).every(o => !o.canApply), "no Apply on its rows");
  console.log("ok H54 undone trigger card: rows not applied again (cost and budget stay refunded)");
}

/* ======================================================================== */
/*  H55: a reused reaction halves a plain re-apply after "Apply half" (fix)  */
/* ======================================================================== */
{
  await fresh({ reactors: [parry] });
  await set("damageMode", "manual");
  answerFn = byName({ Benedikt: "use" });
  const msg = post(spearPotent, tBorin, 10);
  await settle();
  const id = dmgOp(msg).opId;
  await api.applyOps(msg.id, [id], { half: true });
  await settle();
  assert.equal(borin.system.stamina.value, 25, "Apply half");
  const e = dmgOp(msg).trigger.entries[0];
  assert.equal(e.outcome, "used");
  assert.equal(e.halve, false, "Parry's halving was moot");
  assert.equal(e.couldHalve, true);
  await api.undoOps(msg.id, [id]);
  await settle();
  assert.equal(borin.system.stamina.value, 30);
  await api.applyOps(msg.id, [id]);
  await settle();
  assert.equal(triggerDialogs("Benedikt").length, 1, "reused without a prompt");
  assert.equal(borin.system.stamina.value, 25, "Parry halves the plain re-apply");
  assert.equal(dmgOp(msg).trigger.halved, true);
  console.log("ok H55 reuse after Apply half: the moot halving of the used reaction applies on a plain re-apply");
}

/* ======================================================================== */
/*  H56: Riposte's free strike by distance; NPC free strike (fix)            */
/* ======================================================================== */
const borinRanged = ability(borin, "Ranged Free Strike", { type: "main", keywords: ["ranged", "strike", "weapon"], damage: true, distance: { type: "ranged", primary: 5 }, attach: false });
const longSpear = ability(gobA, "Goblin Long Spear", { type: "main", keywords: ["melee", "strike", "weapon"], damage: true, distance: { type: "melee", primary: 2 } });
{
  await fresh({ reactors: [riposte] });
  borin.items.set(borinRanged.id, borinRanged);
  tGobA.x = 7 * G;   // 2 squares from Borin: in the spear's reach, not in Borin's melee free strike's
  answerFn = rec => (rec.kind === "freeStrike" ? "strike" : (rec.name === "Duelist" ? "use" : undefined));
  post(longSpear, tBorin, 10);
  await settle(300);
  assert.ok(log.uses.some(u => u.item === "Ranged Free Strike" && u.targets.includes(tGobA.id)), "the ranged free strike reaches");
  assert.ok(!log.uses.some(u => u.item === "Melee Free Strike"));
  // Adjacent: the melee one.
  await fresh({ reactors: [riposte] });
  borin.items.set(borinRanged.id, borinRanged);
  answerFn = rec => (rec.kind === "freeStrike" ? "strike" : (rec.name === "Duelist" ? "use" : undefined));
  post(spear, tBorin, 10);
  await settle(300);
  assert.ok(log.uses.some(u => u.item === "Melee Free Strike"), "adjacent: melee");
  borin.items.delete(borinRanged.id);
  // An NPC striker without a free strike ability: planned to the active GM, the system's strike without its dialog.
  const { followUpPlan } = await imp("triggers/card.mjs");
  arixx.owners.add(player.id);
  try {
    const plan = followUpPlan({ candidate: { reactor: { actorUuid: duelist.uuid }, event: { subject: { actorUuid: arixx.uuid } } }, steps: [{ type: "freeStrike", by: "subject" }] });
    assert.equal(plan[0].userId, null, "the active GM runs the system's free strike");
  } finally {
    arixx.owners.delete(player.id);
  }
  const strikes = [];
  arixx.system.performFreeStrike = async opts => { strikes.push({ user: game.user.id, configure: opts?.configure }); };
  answerFn = rec => (rec.kind === "freeStrike" ? "strike" : undefined);
  await handleTriggerRun({
    kind: "freeStrike", runId: "runNpcStrike0001", triggerMessageId: "noCard0000000001", actorUuid: arixx.uuid, againstTokenUuid: tBorin.uuid,
    title: "", intro: "", timeoutMs: 20_000, deadline: mclock.t + 20_000,
  }, { user: gm });
  await settle(100);
  assert.deepEqual(strikes, [{ user: "gm", configure: false }], "no second dialog");
  delete arixx.system.performFreeStrike;
  console.log("ok H56 free strike: ranged when the melee one does not reach; NPC strike on the GM without its dialog");
}

/* ======================================================================== */
/*  H57: a cancelled use ends the watch; targets set meanwhile are kept (fix) */
/* ======================================================================== */
{
  await fresh({ reactors: [mlfy] });
  answerFn = byName({ KADE: "use" });
  // The user targets someone else in the system's dialog, then cancels it (use() resolves null, no card).
  mlfy.system.use = async () => {
    canvas.tokens.setTargets([tGobB.id], { mode: "replace" });
    return null;
  };
  const n = messages.size;
  post(spear, tBorin, 10);
  await settle(150);
  const card = cardsSince(n)[0];
  assert.equal(budgetOp(card).status, "applied");
  await advance(2_500);
  await settle(100);
  assert.equal(budgetOp(card).status, "undone", "useCancelled right after the dialog closed (not after T + 30 s)");
  assert.deepEqual([...player.targets].map(t => t.id), [tGobB.id], "the targets set meanwhile are not overwritten");
  mlfy.system.use = async () => { fakeUseCard(mlfy); return null; };
  console.log("ok H57 cancelled use: watch ends at once, the user's new targets kept");
}

/* ======================================================================== */
/*  H58: budget not tracked while the engine is off; turn.start (fix)        */
/* ======================================================================== */
const vigil = ability(kade, "Vigil", { attach: false });
vigil.flags["stef-ds-automation"] = { overlay: { detached: true, key: "ability:vigil", version: "1.0.0", triggers: [
  { id: "vigil", event: "turn.start", subject: "selfOrAlly", range: "unlimited", steps: [{ type: "use", targets: "subject" }] },
] } };
{
  await fresh({ reactors: [] });
  assert.equal(api.triggers.budget(borin).tracked, true);
  game.modules.set("draw-steel-triggers", { active: true });
  assert.equal(api.triggers.budget(borin).tracked, false, "deferred to Draw Steel: Triggers: not tracked");
  game.modules.delete("draw-steel-triggers");
  await set("triggersEnabled", false);
  assert.equal(api.triggers.budget(borin).tracked, false, "engine off: not tracked");
  await set("triggersEnabled", true);
  // turn.start: offered when a turn starts.
  kade.items.set(vigil.id, vigil);
  Hooks.callAll("createItem", vigil);
  answerFn = byName({ KADE: "use" });
  const n = messages.size;
  await heroTurn(borin);
  await lifecycleIdle();
  await settle(200);
  assert.equal(triggerDialogs("KADE").length, 1, "turn.start offered to KADE for Borin's turn");
  assert.ok(cardsSince(n).length >= 1, "trigger card");
  assert.ok(log.uses.some(u => u.item === "Vigil" && u.targets.includes(tBorin.id)), "used on Borin");
  kade.items.delete(vigil.id);
  console.log("ok H58 budget untracked when off or deferred; turn.start offered");
}

/* ======================================================================== */
/*  H59: schema and cache (fix)                                              */
/* ======================================================================== */
{
  const { trackerProblems, triggerProblems } = await imp("library/schema.mjs");
  const trackers = [{ id: "judged", effect: JUDGED, onZero: "retarget" }];
  assert.ok(trackerProblems({ effects: [{ id: "j", type: "condition", effect: JUDGED, stacking: true }], trackers }).some(p => /stacks/.test(p)),
    "a tracker on a stacking condition is refused");
  assert.deepEqual(trackerProblems({ effects: [{ id: "j", type: "condition", effect: JUDGED }], trackers }), []);
  assert.deepEqual(triggerProblems({ triggers: [{ id: "x", event: "damage.before", steps: [{ type: "halve" }, { type: "note", text: "Shift", effect: true }] }] }), []);
  assert.ok(triggerProblems({ triggers: [{ id: "x", event: "damage.before", steps: [{ type: "halve" }, { type: "note", text: "Shift", effect: "yes" }] }] }).length);
  // A monster key change (rename, pinned key) re-resolves the cached triggers.
  await fresh({ reactors: [skitter] });
  assert.equal(api.triggers.reactors(arixx).length, 1);
  arixx.name = "Brood";
  Hooks.callAll("updateActor", arixx, { name: "Brood" }, {}, gm.id);
  assert.equal(api.triggers.reactors(arixx).length, 0, "renamed homebrew copy: no Skitter overlay");
  arixx.flags = { ...(arixx.flags ?? {}), "stef-ds-automation": { monsterKey: "arixx" } };
  Hooks.callAll("updateActor", arixx, { flags: { "stef-ds-automation": { monsterKey: "arixx" } } }, {}, gm.id);
  assert.equal(api.triggers.reactors(arixx).length, 1, "pinned key: Skitter again");
  delete arixx.flags["stef-ds-automation"];
  arixx.name = "Arixx";
  Hooks.callAll("updateActor", arixx, { name: "Arixx", flags: { "stef-ds-automation": { "-=monsterKey": null } } }, {}, gm.id);
  assert.equal(api.triggers.reactors(arixx).length, 1);
  console.log("ok H59 schema: stacking tracker refused, note effect flag; monster key changes re-resolve");
}

/* ======================================================================== */
/*  H60: the active GM changes during a hold (second review)                 */
/* ======================================================================== */
{
  // External damage: the Assistant answers the hold, the Director logs in before the commit.
  await fresh({ reactors: [shield] });
  setActiveGM(gm2);
  answerFn = rec => {
    if (rec.name !== "Jorah") return undefined;
    setActiveGM(gm);   // a Gamemaster connects while the Assistant's prompt is open
    return "use";
  };
  const n = messages.size;
  try {
    await as(player, async () => {
      await jory.system.takeDamage(10, { type: "" });
    });
    await settle(200);
  } finally {
    setActiveGM(gm);
  }
  assert.equal(relayed("hold")[0]?.to, "g2", "asked the Assistant");
  assert.equal(jory.system.stamina.value, 25, "halved");
  assert.equal(relayed("holdDone")[0]?.to, "g2", "holdDone to the GM that keeps the pending commit");
  assert.equal(relayed("triggerCommit")[0]?.to, "gm", "forwarded to the new active GM");
  assert.equal(cardsSince(n).length, 1, "the reaction's card is posted (cost and budget charged)");
  assert.equal(budgetOp(cardsSince(n)[0]).status, "applied");
  // Word of Guidance: the edge's commit too; the names reach Combat Tools' pill escaped (its innerHTML).
  await fresh({ reactors: [guidance] });
  const oldName = guidance.name;
  guidance.name = 'Word <img src=x onerror="alert(1)">';
  setActiveGM(gm2);
  const app = rollApp(borinFreeStrike);
  answerFn = rec => {
    if (rec.name !== "Conduit") return undefined;
    setActiveGM(gm);
    return "use";
  };
  const n2 = messages.size;
  try {
    await as(player2, async () => {
      Hooks.callAll("renderAbilityConfigurationDialog", app);
    });
    await settle(150);
    assert.equal(relayed("preRoll")[0]?.to, "g2");
    const pill = log.pills.at(-1);
    assert.ok(pill && !pill.reason.includes("<img") && pill.reason.includes("&lt;img"), "ability name escaped");
    await as(player2, async () => {
      await fireSubmit(app);
    });
    await settle(200);
    assert.equal(relayed("preRollDone")[0]?.to, "g2", "preRollDone to the GM that keeps the pending commit");
    assert.ok(relayed("triggerCommit").length >= 1, "forwarded");
    assert.equal(cardsSince(n2).length, 1, "Word of Guidance's card posted");
  } finally {
    guidance.name = oldName;
    setActiveGM(gm);
    Hooks.callAll("closeAbilityConfigurationDialog", app);
  }
  // A card's pre-pass hold: the hit lands on the Assistant, its damage.after events go along (third review).
  await fresh({ reactors: [parry, riposte] });
  setActiveGM(gm2);
  let duelistAsked = null;
  answerFn = rec => {
    if (rec.name === "Benedikt") {
      setActiveGM(gm);
      return "use";
    }
    if (rec.name === "Duelist") {
      duelistAsked = rec.user;
      return "decline";
    }
    return undefined;
  };
  const n3 = messages.size;
  try {
    await as(gm2, async () => {
      post(spear, tBorin, 10);
      await settle(400);
    });
    await settle(400);
  } finally {
    setActiveGM(gm);
  }
  assert.equal(borin.system.stamina.value, 25, "Parry halved the hit");
  const fwd = relayed("triggerCommit").at(-1);
  assert.equal(fwd?.to, "gm");
  assert.equal(fwd?.data?.triggerCommit?.afterEvents?.length, 1, "the landed hit's damage.after event forwarded");
  assert.ok(duelistAsked, "Riposte offered by the new active GM");
  assert.equal(cardsSince(n3).length, 1, "Parry's card");
  console.log("ok H60 active GM changed mid-hold: commits reach the issuing GM, cards and damage.after events forwarded; pill names escaped");
}

/* ======================================================================== */
/*  H61: a second potency step keeps a row resisted (second review)          */
/* ======================================================================== */
{
  await fresh({ reactors: [parry, reflexes] });
  answerFn = byName({ Benedikt: "use", Borin: { action: "use", spend: true } });
  const msg = post(spearPotent, tBorin, 10);
  await settle(150);
  const c = condOp(msg);
  assert.equal(c.potency.triggerDeltas?.length, 2, "both potency steps recorded");
  assert.equal(c.potency.value, 0);
  assert.equal(c.status, "skipped");
  assert.equal(c.reason, "triggerResisted");
  assert.ok(!borin.statuses.has("slowed"), "resisted after the first step, still resisted after the second");
  assert.equal(borin.system.stamina.value, 25, "halved once");
  console.log("ok H61 two potency steps on one row: stays triggerResisted, condition not applied");
}

/* ======================================================================== */
/*  H62: two pending surges applied with a trigger-halved base (second review) */
/* ======================================================================== */
{
  await fresh({ reactors: [parry] });
  await set("damageMode", "manual");
  const hit = ability(hero, "Hero Hit", { type: "main", keywords: ["melee", "strike", "weapon"], damage: true });
  const rollData = hero.getRollData;
  hero.getRollData = () => ({ ...rollData(), chr: 3 });
  try {
    const msg = post(hit, tBorin, 7);
    await settle();
    const base = dmgOp(msg).opId;
    await api.surge(msg.id, base, { count: 1 });
    await api.surge(msg.id, base, { count: 1 });
    await settle();
    assert.equal(opsOf(msg).filter(o => o.surge?.kind === "damage" && o.status === "pending").length, 2, "two pending surge rows");
    answerFn = byName({ Benedikt: "use" });
    await api.applyOps(msg.id);
    await settle(150);
    // g(7) = 3 for the base; g(13) - g(7) = 3 for both surges (each alone: g(10) - g(7) = 2).
    const surges = opsOf(msg).filter(o => o.surge?.kind === "damage");
    assert.equal(surges.reduce((s, o) => s + Number(o.finalAmount ?? 0), 0), 3);
    assert.equal(borin.system.stamina.value, 24);
  } finally {
    hero.getRollData = rollData;
    hero.items.delete(hit.id);
  }
  console.log("ok H62 two surge rows in one apply list on a halved hit: 3, not 4");
}

/* ======================================================================== */
/*  H63: re-resolving keeps a reaction's potency change (second review)      */
/* ======================================================================== */
{
  await fresh({ reactors: [parry] });
  answerFn = byName({ Benedikt: "use" });
  const msg = post(spearPotent, tBorin, 10);
  await settle();
  assert.equal(condOp(msg).reason, "triggerResisted");
  answerFn = () => "decline";
  await api.resolve(msg.id, { force: true });   // what "Use my targets" does for the targets it keeps
  await settle(200);
  const c = condOp(msg);
  assert.equal(c.status, "skipped");
  assert.equal(c.reason, "triggerResisted");
  assert.equal(c.potency.value, 1);
  assert.equal(c.potency.baseValue, 2);
  assert.ok(!borin.statuses.has("slowed"), "not applied by the rebuild");
  console.log("ok H63 re-resolve: a reaction's potency change carried to the rebuilt row");
}

/* ======================================================================== */
/*  H64: Death Tracker's cause is kept fresh while a prompt is open          */
/* ======================================================================== */
{
  await fresh({ reactors: [shield] });
  answerFn = () => undefined;
  const p = as(player, () => jory.system.takeDamage(10, { type: "" }));
  await settle(50);
  const rec = triggerDialogs("Jorah")[0];
  assert.ok(rec && !rec.closed);
  const before = log.noteCause;
  await advance(5_000);
  assert.ok(log.noteCause > before, "refreshed before Death Tracker's 8 s TTL");
  await advance(4_000);
  assert.ok(log.noteCause >= before + 1);
  rec.click("use");
  await p;
  await settle(100);
  assert.equal(jory.system.stamina.value, 25);
  // Death Tracker has one slot: another application's cause is never overwritten by the refresh (third review).
  const { noteDamageCause } = await imp("compat/death-tracker.mjs");
  for (const other of ["note", "batch"]) {
    await fresh({ reactors: [shield] });
    answerFn = () => undefined;
    const p2 = as(player, () => jory.system.takeDamage(10, { type: "" }));
    await settle(50);
    const rec2 = triggerDialogs("Jorah")[0];
    assert.ok(rec2 && !rec2.closed);
    if (other === "note") noteDamageCause({ userId: player2.id, sourceActorUuid: null, messageId: "otherCard" });
    else globalThis.window._dsctDamageBatchDepth = 1;
    const before2 = log.noteCause;
    try {
      await advance(5_000);
      assert.equal(log.noteCause, before2, `no refresh over another application's cause (${other})`);
      rec2.click("use");
      await p2;
      await settle(100);
      // Right before our write: noted once the other application is done, never while its batch settles.
      assert.equal(log.noteCause, before2 + (other === "note" ? 1 : 0), `note before the write (${other})`);
      assert.equal(jory.system.stamina.value, 25);
    } finally {
      delete globalThis.window._dsctDamageBatchDepth;
    }
  }
  console.log("ok H64 Death Tracker cause refreshed every 5 s while the external prompt is open; never over another application's cause");
}

/* ======================================================================== */
/*  H65: a hit immunity reduces to 0 offers nothing (second review)          */
/* ======================================================================== */
{
  await fresh({ reactors: [reflexes] });
  answerFn = byName({ Borin: "use" });
  borin.system.damage.immunities.corruption = 5;
  try {
    const msg = post(spear, tBorin, 4, { type: "corruption" });
    await settle();
    assert.equal(triggerDialogs("Borin").length, 0, "our card: nothing taken, nothing offered");
    assert.equal(dmgOp(msg).status, "applied");
    await as(player2, () => borin.system.takeDamage(4, { type: "corruption" }));
    await settle();
    assert.equal(triggerDialogs("Borin").length, 0, "external: nothing offered");
    assert.equal(relayed("hold").length, 1);
    post(spear, tBorin, 7, { type: "corruption" });
    await settle(150);
    assert.equal(triggerDialogs("Borin").length, 1, "2 gets through: offered");
  } finally {
    delete borin.system.damage.immunities.corruption;
  }
  console.log("ok H65 damage.before not offered for a hit immunity takes to 0 (card and external)");
}

/* ======================================================================== */
/*  H66: a roll appended while a fresh card is held (second review)          */
/* ======================================================================== */
{
  await fresh({ reactors: [parry] });
  answerFn = () => undefined;
  const msg = post(spear, tBorin, 10);
  await settle();
  const rec = triggerDialogs("Benedikt")[0];
  assert.ok(rec && !rec.closed && !getResolution(msg).resolvedAt, "held before the first write");
  const src = msg._srcParts.tier2Result00000;
  src.rolls = [...src.rolls, new ds.rolls.DamageRoll(2, {})];
  await msg.update({ "system.parts.tier2Result00000.rolls": src.rolls });
  await settle();
  rec.click("decline");
  await settle(150);
  const added = opsOf(msg).find(o => o.reason === "addedRoll");
  assert.ok(added, "the appended roll got its manual row after the hold");
  assert.equal(added.mode, "manual");
  console.log("ok H66 a roll appended during a hold gets its row");
}

/* ======================================================================== */
/*  H67: Combat Tools' Apply button and purifying fire Shift+Click (second review) */
/* ======================================================================== */
{
  const btn = { dataset: { dsctArea: "false" }, total: 10, closest: () => null };
  const click = () => ds.rolls.DamageRoll.applyDamageCallback({ shiftKey: true, target: { closest: () => btn }, currentTarget: btn });
  // The Director's click: Combat Tools halves 10 to 5 and calls takeDamage here.
  await fresh({ reactors: [shield] });
  answerFn = byName({ "Jorah": "use" });
  gm.targets = new Set([tJory.object]);
  await click();
  await settle(100);
  assert.equal(triggerDialogs("Jorah").length, 0, "halved by Combat Tools: Inertial Shield's halving moot");
  assert.equal(jory.system.stamina.value, 25);
  await jory.system.takeDamage(4, { type: "" });
  await settle(100);
  assert.equal(triggerDialogs("Jorah").length, 1, "the mark was used: the next hit is offered");
  // A player's click on a creature it does not own: halfMark to the GM first, then Combat Tools' socket call.
  await fresh({ reactors: [shield] });
  answerFn = byName({ "Jorah": "use" });
  await as(player2, async () => {
    player2.targets = new Set([tJory.object]);
    await click();
  });
  await settle(100);
  assert.ok(relayed("halfMark")[0]?.data.halfMark.uuids.includes(tJory.uuid), "marked on the GM");
  assert.equal(triggerDialogs("Jorah").length, 0);
  assert.equal(jory.system.stamina.value, 25);
  // Combat Tools' purifying fire button: marked from the capture listener (its own handler halves).
  await fresh({ reactors: [shield] });
  answerFn = byName({ "Jorah": "use" });
  const fire = { dataset: {} };
  await as(player, async () => {
    player.targets = new Set([tJory.object]);
    markHalfClick({ shiftKey: true, target: { closest: sel => (sel.includes("purifying") ? fire : null) } });
    await jory.system.takeDamage(5, { type: "fire", staminaLoss: false });
  });
  await settle(100);
  assert.equal(relayed("hold")[0]?.data.hold.halved, true, "purifying fire half marked");
  assert.equal(triggerDialogs("Jorah").length, 0);
  // A player's Shift+Click on a Target Damage row that Combat Tools' area hook handles (halved on the player's
  // client, sent to the GM through its socket for a creature the player does not own).
  await fresh({ reactors: [shield] });
  game.modules.set("draw-steel-target-damage", { active: true });
  try {
    const panel = new El("section");
    panel.dataset.dsctAreaDmgHooked = "1";
    const row = { dataset: { dstdAction: "applyDamage", target: JSON.stringify({ tokenUuid: tJory.uuid, actorUuid: jory.uuid }) },
      closest: sel => (sel.startsWith("section") ? panel : row) };
    await as(player2, async () => {
      markHalfClick({ shiftKey: true, target: { closest: sel => (sel.includes("purifying") ? null : row) } });
    });
    await settle();
    assert.ok(relayed("halfMark")[0]?.data.halfMark.uuids.includes(tJory.uuid), "area hook half marked on the GM");
    await jory.system.takeDamage(5, { type: "", staminaLoss: false });
    await settle(100);
    assert.equal(triggerDialogs("Jorah").length, 0);
  } finally {
    game.modules.delete("draw-steel-target-damage");
  }
  console.log("ok H67 Shift+Click through Combat Tools' Apply button (GM and player) and purifying fire: halving moot");
}

/* ======================================================================== */
/*  H68: forced-move windows of moves run here; moves that never start (second review) */
/* ======================================================================== */
{
  // A vertical move on the Director's client never sets Combat Tools' FM flag: its local window covers it.
  await fresh({ reactors: [shield] });
  answerFn = byName({ "Jorah": "use" });
  assert.equal(Hooks.call("dsct.preForcedMovement", { target: tJory.object, source: tGobA.object, type: "Push", distance: 0, verticalHeight: 2, resume() {} }), true);
  await jory.system.takeDamage(3, { staminaLoss: false, dsbl: { source: { tokenUuid: tGobA.uuid } } });
  await settle();
  assert.equal(triggerDialogs("Jorah").length, 0, "collision damage of a move run here passes");
  assert.equal(jory.system.stamina.value, 27);
  assert.equal(relayed("fmActive").length, 0, "the active GM announces nothing");
  await advance(6_000);   // not seen running for 5 s: over
  await jory.system.takeDamage(4, { staminaLoss: false, dsbl: { source: { tokenUuid: tGobA.uuid } } });
  await settle(100);
  assert.equal(triggerDialogs("Jorah").length, 1, "the window ended: held again");
  // A player's move that never starts (stability, a cancelled pick): its window ends after 5 s, never refreshed.
  await fresh({ reactors: [shield] });
  await as(player, async () => {
    Hooks.call("dsct.preForcedMovement", { target: tGobA.object, source: tBen.object, type: "Push", distance: 1, resume() {} });
  });
  await settle();
  const calls = () => relayed("fmActive").map(r => r.data.fmActive);
  assert.equal(calls().length, 1);
  await advance(6_000);
  assert.ok(calls().some(f => f.end === true), "ended");
  assert.ok(!calls().some(f => f.refresh === true), "never refreshed");
  await jory.system.takeDamage(4, { staminaLoss: false, dsbl: { source: { tokenUuid: tBen.uuid } } });
  await settle(100);
  assert.equal(triggerDialogs("Jorah").length, 1, "the mover's Combat Tools damage is held again");
  console.log("ok H68 forced moves: a vertical move's damage passes on the client running it; a move that never starts ends its window");
}

/* ======================================================================== */
/*  H69: object actors are neither allies nor attacking creatures (second review) */
/* ======================================================================== */
{
  const pavise = new Actor({ uuid: "Actor.pavise0000000001", name: "Pavise", type: "object", stamina: 20, chr: {} });
  enrich(pavise);
  pavise.system.isObject = true;
  registry.set(pavise.uuid, pavise);
  const tPavise = place("tokPavise0000001", pavise, "Pavise", 7, 5, 1);
  try {
    await fresh({ reactors: [parry] });
    post(spear, tPavise, 10);
    await settle(150);
    assert.equal(triggerDialogs("Benedikt").length, 0, "a friendly object is no ally: no Parry");
    // The same token as a creature: offered (the setup is right).
    pavise.system.isObject = false;
    post(spear, tPavise, 10);
    await settle(150);
    assert.equal(triggerDialogs("Benedikt").length, 1);
    pavise.system.isObject = true;
    // An object's damage is not "a creature deals damage".
    dialogs.length = 0;
    await externalHold({ actorUuid: borin.uuid, tokenUuid: tBorin.uuid, amount: 6, type: "", halved: false, ignoredImmunities: [], source: { actorUuid: pavise.uuid } }, player2);
    assert.equal(triggerDialogs("Benedikt").length, 0, "Parry not offered against an object's damage");
  } finally {
    scene.tokens.delete(tPavise.id);
    everyone.splice(everyone.indexOf(pavise), 1);
  }
  console.log("ok H69 object actors: not an ally subject, not an attacking creature");
}

/* ======================================================================== */
/*  H70: a re-target after a kill ends only the downed creature's mark (second review) */
/* ======================================================================== */
{
  await fresh({ reactors: [mark] });
  await effectOn(gobA, MARK, mark.uuid, "cardMark00000002");
  await effectOn(gobB, MARK, mark.uuid, "cardMark00000002");   // Anticipation: two marks from one use
  answerFn = rec => (rec.kind === "trigger" && rec.name === "Mark" ? "use" : undefined);
  await gobA.update({ "system.stamina.value": 0 });
  await settle(400);
  assert.equal(triggerDialogs("Mark").length, 1, "re-target prompt");
  assert.ok(log.uses.some(u => u.item === "Mark"), "Mark used again");
  // The new card's mark (engine-made, its own card id) on the picked creature.
  await effectOn(arixx, MARK, mark.uuid, "cardMark00000003");
  await settle();
  assert.ok(arixx.effects.has(MARK));
  assert.ok(gobB.effects.has(MARK), "the surviving mark stays");
  assert.ok(!gobA.effects.has(MARK), "the downed creature's mark is replaced");
  // A later plain use of Mark ends every older mark again.
  await effectOn(hero, MARK, mark.uuid, "cardMark00000004");
  await settle();
  assert.ok(!gobB.effects.has(MARK) && !arixx.effects.has(MARK), "use it again: older marks end");
  // Revived and killed again while the first re-target still waits (a forced move): one prompt (third review).
  await fresh({ reactors: [mark] });
  await effectOn(gobA, MARK, mark.uuid, "cardMark00000005");
  answerFn = rec => (rec.kind === "trigger" && rec.name === "Mark" ? "use" : undefined);
  sw.fmActive = true;
  try {
    await gobA.update({ "system.stamina.value": 0 });
    await settle(150);
    await gobA.update({ "system.stamina.value": 5 });
    await settle(50);
    await gobA.update({ "system.stamina.value": 0 });
    await settle(150);
    assert.equal(triggerDialogs("Mark").length, 0, "still waiting for the move");
  } finally {
    sw.fmActive = false;
  }
  await settle(500);
  assert.equal(triggerDialogs("Mark").length, 1, "one re-target prompt for the second kill");
  assert.equal(log.uses.filter(u => u.item === "Mark").length, 1, "one re-target");
  console.log("ok H70 Mark re-target replaces only the downed creature's mark; a plain re-use ends all; one prompt after revive + kill");
}

/* ======================================================================== */
/*  H71: re-target without Combat Tools' picker, or with nobody to pick (second review) */
/* ======================================================================== */
{
  await fresh({ reactors: [mark] });
  const run = (extra = {}) => as(player, () => handleTriggerRun({
    kind: "retarget", runId: foundry.utils.randomID(), itemUuid: mark.uuid, actorUuid: benedikt.uuid, range: 5,
    targetType: "enemy", excludeTokenUuids: [tGobA.uuid], ...extra,
  }, { user: gm }));
  // Nobody in range: a notice instead of silence.
  const getValid = dsctApi.getValidTargets;
  dsctApi.getValidTargets = () => [];
  notifications.length = 0;
  try {
    await run();
    await settle();
  } finally {
    dsctApi.getValidTargets = getValid;
  }
  assert.ok(notifications.some(([lvl, m]) => lvl === "warn" && /NoTarget/.test(m)), "notified");
  assert.equal(log.uses.length, 0);
  // Without the picker: the downed creature still targeted is not taken; the dialog asks, checked after it.
  const picker = dsctApi.colorTokenPicker;
  delete dsctApi.colorTokenPicker;
  try {
    player.targets = new Set([tGobA.object]);
    answerFn = rec => (rec.kind === "confirmTarget" ? "use" : undefined);
    await run();
    await settle();
    assert.equal(dialogs.filter(d => d.kind === "confirmTarget").length, 1, "asked to target");
    assert.equal(log.uses.length, 0, "still the downed creature: not used");
    player.targets = new Set([tGobB.object]);
    await run();
    await settle();
    assert.equal(dialogs.filter(d => d.kind === "confirmTarget").length, 1, "a valid single target: no dialog");
    assert.deepEqual(log.uses.map(u => u.targets), [[tGobB.id]], "used on the new target");
  } finally {
    dsctApi.colorTokenPicker = picker;
    player.targets = new Set();
  }
  console.log("ok H71 re-target: notice with nobody to pick; without the picker the excluded target is refused");
}

/* ======================================================================== */
/*  H72: a spend box selects its option; labels; validator (second review)   */
/* ======================================================================== */
{
  // A tick under another option selects that option (readChoice reads the selected option's box only).
  const inputs = [
    { name: "ds-auto-option", value: "0", checked: true }, { name: "ds-auto-option", value: "1", checked: false },
    { name: "ds-auto-spend-0", checked: true, disabled: false }, { name: "ds-auto-spend-1", checked: false, disabled: false },
  ];
  let onChange = null;
  const element = {
    dataset: {},
    addEventListener: (type, fn) => { if (type === "change") onChange = fn; },
    querySelector: sel => inputs.find(i => i.name === "ds-auto-option" && sel.includes(`value="${i.value}"`)) ?? null,
    querySelectorAll: () => inputs.filter(i => i.name.startsWith("ds-auto-spend-")),
  };
  linkSpendBoxes({ element });
  linkSpendBoxes({ element });   // once per element
  inputs[3].checked = true;
  onChange({ target: inputs[3] });
  assert.equal(inputs[1].checked, true, "its option selected");
  assert.equal(inputs[2].checked, false, "the other option's box unticked");
  // A trigger's `label` is the prompt's subtitle.
  const braced = ability(borin, "Brace", { attach: false });
  braced.flags["stef-ds-automation"] = { overlay: { detached: true, key: "ability:brace", version: "1.0.0", triggers: [
    { id: "brace", event: "damage.before", subject: "self", label: "Brace for the hit", steps: [{ type: "halve" }] },
  ] } };
  reactorItems.push(braced);
  await fresh({ reactors: [braced] });
  post(spear, tBorin, 10);
  await settle(150);
  const req = sentTo("p2", "trigger").at(-1)?.data;
  assert.equal(req?.options?.[0]?.label, "Brace for the hit");
  assert.ok(triggerDialogs("Borin")[0]?.cfg.content.includes("Brace for the hit"), "shown in the dialog");
  // Validator rule 9 as the engine (realStep): an effect note is a real step, so forced.before can validate.
  const { triggerProblems } = await imp("library/schema.mjs");
  assert.deepEqual(triggerProblems({ triggers: [{ id: "x", event: "forced.before", subject: "self", steps: [{ type: "note", text: "Brace by hand", effect: true }] }] }), []);
  assert.ok(triggerProblems({ triggers: [{ id: "x", event: "forced.before", subject: "self", steps: [{ type: "note", text: "Brace" }] }] })
    .some(p => /plain note/.test(p)), "a plain note alone is refused");
  console.log("ok H72 spend box selects its option; trigger label shown; forced.before effect note validates");
}

/* ======================================================================== */
/*  Third review: H73-H83                                                    */
/* ======================================================================== */
const { sweepOnReady, addSurge } = await imp("engine/engine.mjs");
const { onCaptureClick } = await imp("ui/dstd-lock.mjs");
const { tick: ongoingTick } = await imp("turn/ongoing.mjs");

/* H73: one Shift+Click's later targets stay halved while an earlier target's prompt is open */
{
  await fresh({ reactors: [reflexes, shield] });
  // Combat Tools / Target Damage apply the click's targets one after another; Borin's prompt takes 8 s.
  answerFn = rec => {
    if (rec.name === "Borin") return (async () => { await tick(); mclock.t += 8_000; return "decline"; })();
    return rec.kind === "trigger" ? "use" : undefined;
  };
  markExternalHalf([tBorin.uuid, borin.uuid, tJory.uuid, jory.uuid]);
  await borin.system.takeDamage(5, { type: "", staminaLoss: false });
  await settle(100);
  assert.equal(triggerDialogs("Borin").length, 1, "Unearthly Reflexes still offered on a halved hit (its shift)");
  await jory.system.takeDamage(5, { type: "", staminaLoss: false });
  await settle(100);
  assert.equal(triggerDialogs("Jorah").length, 0, "still marked halved after 8 s of hold: Inertial Shield's halving moot");
  assert.equal(jory.system.stamina.value, 25, "not halved twice");
  // The pause ends with the hold: a mark still runs out 5 s later.
  markExternalHalf([tJory.uuid, jory.uuid]);
  await advance(6_000);
  answerFn = byName({ "Jorah": "decline" });
  await jory.system.takeDamage(4, { type: "" });
  await settle(100);
  assert.equal(triggerDialogs("Jorah").length, 1, "expired after 5 s of unheld time");
  console.log("ok H73 half marks pause while a hold waits: a later target of the same click is not halved twice");
}

/* H74: a held half application marks only its own targets */
{
  await fresh({ reactors: [reflexes, shield] });
  answerFn = byName({ "Jorah": "decline" });   // Borin's prompt stays open meanwhile
  const p = new ds.rolls.DamageRoll(10, {}).applyDamage([borin], { halfDamage: true });
  await settle(100);
  assert.equal(triggerDialogs("Borin").length, 1, "the half application is held on Borin");
  await jory.system.takeDamage(10, { type: "" });   // e.g. a player's Target Damage row run here meanwhile
  await settle(100);
  assert.equal(triggerDialogs("Jorah").length, 1, "unrelated damage is not halved: Inertial Shield offered");
  assert.equal(jory.system.stamina.value, 20);
  triggerDialogs("Borin")[0].click("decline");
  await p;
  await settle();
  assert.equal(borin.system.stamina.value, 25);
  console.log("ok H74 a held Shift+Click half application marks only its own targets");
}

/* H75: a swallowed Shift+Click on a locked row marks nothing */
{
  await fresh({ reactors: [shield] });
  answerFn = byName({ "Jorah": "decline" });
  game.modules.set("draw-steel-target-damage", { active: true });
  const tKey = tJory.uuid.replace(/\./g, "__");
  const held = new Message({ type: "standard", parts: {} });
  held.timestamp = mclock.t;
  held.flags = { "stef-ds-automation": { resolution: { ops: {}, targets: {}, hold: { at: mclock.t, until: mclock.t + 30_000, by: gm2.id, names: ["X"], opIds: [], targetKeys: [tKey] } } } };
  messages.set(held.id, held);
  try {
    const panel = new El("section");
    const li = { dataset: { messageId: held.id } };
    const row = {
      dataset: { dstdAction: "applyDamage", target: JSON.stringify({ tokenUuid: tJory.uuid, actorUuid: jory.uuid }) },
      closest: sel => (/purifying|dsct-fm|target-key|area-dmg|message-part/.test(sel) ? null
        : (sel.startsWith("section") ? panel : (sel.includes("data-message-id") ? li : row))),
    };
    let swallowed = 0;
    const click = () => onCaptureClick({ shiftKey: true, target: row, preventDefault() {}, stopImmediatePropagation() { swallowed++; } });
    notifications.length = 0;
    click();
    assert.equal(swallowed, 1, "held row: swallowed");
    await jory.system.takeDamage(4, { type: "" });
    await settle(100);
    assert.equal(triggerDialogs("Jorah").length, 1, "no half mark left behind: the next hit is offered");
    delete getResolution(held).hold;
    click();
    assert.equal(swallowed, 1, "not locked: goes through");
    await jory.system.takeDamage(4, { type: "" });
    await settle(100);
    assert.equal(triggerDialogs("Jorah").length, 1, "a click that goes through is marked");
  } finally {
    messages.delete(held.id);
    game.modules.delete("draw-steel-target-damage");
  }
  console.log("ok H75 a Shift+Click swallowed by the row lock leaves no half mark");
}

/* H76: Combat Tools' FM flag no longer lets every damage through */
{
  await fresh({ reactors: [shield] });
  answerFn = byName({ "Jorah": "decline" });
  sw.fmActive = true;   // a move of Combat Tools waits on a friendly-fire confirmation (or threw mid-path)
  try {
    await jory.system.takeDamage(4, { type: "" });   // a Target Damage row meanwhile
    await settle(100);
    assert.equal(triggerDialogs("Jorah").length, 1, "unrelated damage held");
    await jory.system.takeDamage(4, { staminaLoss: false, dsbl: { source: { tokenUuid: tGobA.uuid, actorUuid: gobA.uuid, ability: "Spear" } } });
    await settle(100);
    assert.equal(triggerDialogs("Jorah").length, 2, "Combat Tools' Apply button (an ability source) held");
    const collision = { staminaLoss: false, dsbl: { source: { tokenUuid: tGobA.uuid, actorUuid: gobA.uuid } } };
    await jory.system.takeDamage(3, collision);
    await settle(100);
    assert.equal(triggerDialogs("Jorah").length, 3, "no window (the flag left on by a move that threw): held, no fallback on the flag");
    assert.equal(Hooks.call("dsct.preForcedMovement", { target: tBorin.object, source: tGobA.object, type: "Push", distance: 1, resume() {} }), true);
    await jory.system.takeDamage(3, collision);
    await settle(100);
    assert.equal(triggerDialogs("Jorah").length, 3, "the move's own collision damage passes (its window)");
  } finally {
    sw.fmActive = false;
  }
  // A forced-move window does not cover the mover's Apply-button damage either.
  await fresh({ reactors: [shield] });
  answerFn = byName({ "Jorah": "decline" });
  handleFmActive({ id: "fmWin00000000073", targetTokenUuid: tJory.uuid, sourceTokenUuid: tBen.uuid }, player);
  await jory.system.takeDamage(4, { staminaLoss: false, dsbl: { source: { tokenUuid: tBen.uuid, actorUuid: benedikt.uuid, ability: "Strike" } } });
  await settle(100);
  assert.equal(triggerDialogs("Jorah").length, 1, "an ability-card source is not the move's");
  await jory.system.takeDamage(4, { staminaLoss: false, dsbl: { source: { tokenUuid: tBen.uuid, actorUuid: benedikt.uuid } } });
  await settle(100);
  assert.equal(triggerDialogs("Jorah").length, 1, "the move's damage passes");
  await handleOp({ action: "fmActive", fmActive: { id: "fmWin00000000073", end: true } }, { user: player });
  console.log("ok H76 Combat Tools' FM flag and windows cover only its forced-move damage calls");
}

/* H77: revoking a reaction drops a pending potency surge the row no longer needs */
{
  await fresh({ reactors: [parry] });
  await set("conditionsMode", "manual");
  answerFn = byName({ Benedikt: "use" });
  const n = messages.size;
  const msg = post(heroStrike, tBorin, 10);
  await settle();
  const c = condOp(msg);
  assert.equal(c.reason, "triggerResisted");
  await addSurge(msg, c.opId, { potency: true, user: player });   // a player asks: waits for the Director
  await settle();
  assert.equal(condOp(msg).status, "pending");
  assert.equal(condOp(msg).surge?.kind, "potency");
  await api.undoOps(cardsSince(n)[0].id);
  await settle(100);
  const after = condOp(msg);
  assert.equal(after.surge ?? null, null, "surge dropped");
  assert.equal(after.potency.surged, false);
  assert.equal(after.potency.fails, true, "lands on its own");
  assert.equal(after.status, "pending");
  await api.applyOps(msg.id, [c.opId]);
  await settle();
  assert.equal(condOp(msg).status, "applied");
  assert.equal(hero.system.hero.surges, 3, "no surge paid");
  console.log("ok H77 revoke: a pending potency surge the row no longer needs is dropped, never paid");
}

/* H78: surge rows pushing a hit past immunity count for damage.before */
{
  await fresh({ reactors: [reflexes] });
  await set("damageMode", "manual");
  const hit = ability(hero, "Hero Hit 2", { type: "main", keywords: ["melee", "strike", "weapon"], damage: true });
  const rollData = hero.getRollData;
  hero.getRollData = () => ({ ...rollData(), chr: 3 });
  borin.system.damage.immunities.corruption = 5;
  try {
    const msg = post(hit, tBorin, 3, { type: "corruption" });
    await settle();
    await api.surge(msg.id, dmgOp(msg).opId, { count: 1 });   // 3 + 3 = 6 > immunity 5
    await settle();
    answerFn = byName({ Borin: "use" });
    await api.applyOps(msg.id);
    await settle(150);
    assert.equal(triggerDialogs("Borin").length, 1, "offered: base and surge deal damage together");
    assert.equal(borin.system.stamina.value, 30, "halved together: g(6) = 3, immunity 5");
  } finally {
    delete borin.system.damage.immunities.corruption;
    hero.getRollData = rollData;
    hero.items.delete(hit.id);
  }
  console.log("ok H78 a pending surge row that takes the hit past immunity: damage.before offered");
}

/* H79: a hero dead by Stamina neither reacts nor is helped */
{
  await fresh({ reactors: [parry] });
  answerFn = byName({ Benedikt: "decline" });
  benedikt.system.stamina.value = -10;   // -winded: dead, no status set (the system never sets one)
  post(spear, tBorin, 10);
  await settle(150);
  assert.equal(triggerDialogs("Benedikt").length, 0, "dead reactor: not offered");
  await fresh({ reactors: [parry] });
  answerFn = byName({ Benedikt: "decline" });
  benedikt.system.stamina.value = -5;    // dying: still reacts
  post(spear, tBorin, 10);
  await settle(150);
  assert.equal(triggerDialogs("Benedikt").length, 1, "dying reactor: offered");
  // My Life for Yours on a subject the hit killed.
  await fresh({ reactors: [mlfy] });
  answerFn = byName({ KADE: "decline" });
  borin.system.stamina.value = 2;
  post(spear, tBorin, 15);
  await settle(150);
  assert.equal(triggerDialogs("KADE").length, 0, "dead subject: not offered");
  await fresh({ reactors: [mlfy] });
  answerFn = byName({ KADE: "decline" });
  post(spear, tBorin, 10);
  await settle(150);
  assert.equal(triggerDialogs("KADE").length, 1, "living subject: offered");
  console.log("ok H79 dead by Stamina: no reaction, and no heal or free strike for a dead subject");
}

/* H80: re-target texts */
{
  await fresh({ reactors: [mark] });
  const run = () => as(player, () => handleTriggerRun({
    kind: "retarget", runId: foundry.utils.randomID(), itemUuid: mark.uuid, actorUuid: benedikt.uuid, range: 5,
    targetType: "enemy", excludeTokenUuids: [tGobA.uuid],
  }, { user: gm }));
  const getValid = dsctApi.getValidTargets;
  const picker = dsctApi.colorTokenPicker;
  let hint = null;
  dsctApi.getValidTargets = () => [tGobB.object];
  dsctApi.colorTokenPicker = async o => { hint = o.hint; return null; };
  try {
    await run();
    await settle();
  } finally {
    dsctApi.getValidTargets = getValid;
    dsctApi.colorTokenPicker = picker;
  }
  assert.ok(/PickTargetHint/.test(hint ?? ""), "the picker's hint: click a creature (it has no Use button)");
  delete dsctApi.colorTokenPicker;
  notifications.length = 0;
  try {
    answerFn = rec => (rec.kind === "confirmTarget" ? "cancel" : undefined);
    await run();
    await settle();
  } finally {
    dsctApi.colorTokenPicker = picker;
  }
  assert.ok(notifications.some(([lvl, m]) => lvl === "warn" && /RetargetCancelled/.test(m)), "says the follow-up ended");
  console.log("ok H80 re-target: the picker's hint and the cancelled notice say what to do");
}

/* H81: one creature's ongoing ticks apply one after another while a reactor is on the scene */
{
  await fresh({ reactors: [parry] });
  const Roll = foundry.dice?.Roll;
  foundry.dice = { ...(foundry.dice ?? {}), Roll: class {
    constructor(formula) { this.formula = formula; }
    async evaluate() { this.total = Number(this.formula); return this; }
    toJSON() { return { formula: this.formula, total: this.total }; }
  } };
  const trace = [];
  const own = Object.getOwnPropertyDescriptor(gobA.system, "takeDamage");
  const base = gobA.system.takeDamage;
  gobA.system.takeDamage = async function (amount, opts) {
    trace.push(`start ${amount}`);
    await settle(30);
    const out = await base.call(this, amount, opts);
    trace.push(`end ${amount}`);
    return out;
  };
  const burn = new Effect({ name: "Burning", flags: { "stef-ds-automation": { ongoing: [{ formula: "5", when: "turnStart" }, { formula: "4", when: "turnStart" }] } } }, gobA);
  burn.uuid = `${gobA.uuid}.ActiveEffect.${burn.id}`;
  registry.set(burn.uuid, burn);
  gobA.effects.set(burn.id, burn);
  try {
    const before = gobA.system.stamina.value;
    await heroTurn(gobA);
    await lifecycleIdle();
    await settle(300);
    assert.deepEqual(trace, ["start 5", "end 5", "start 4", "end 4"], "never two at once");
    assert.equal(gobA.system.stamina.value, before - 9, "both ticks landed");
  } finally {
    gobA.effects.delete(burn.id);
    if (own) Object.defineProperty(gobA.system, "takeDamage", own);
    else delete gobA.system.takeDamage;
    if (Roll) foundry.dice.Roll = Roll;
    else delete foundry.dice.Roll;
  }
  console.log("ok H81 ongoing ticks of one creature apply one after another (no lost Stamina write)");
}

/* H82: turn.end triggers need takeTurnNext; the Blackguard's Parry! is not the Tactician's */
{
  const { triggerProblems } = await imp("library/schema.mjs");
  assert.ok(triggerProblems({ triggers: [{ id: "x", event: "turn.end", subject: "ally", steps: [{ type: "use", targets: "subject" }] }] })
    .some(p => /takeTurnNext/.test(p)), "turn.end use-only refused");
  assert.ok(triggerProblems({ triggers: [{ id: "x", event: "turn.end", subject: "ally", require: { subjectType: "npc" }, steps: [{ type: "takeTurnNext" }] }] })
    .some(p => /heroes/.test(p)), "turn.end for npcs refused");
  const blackguard = JSON.parse(readFileSync(LIBRARY + "monsters/parry.json", "utf8"));
  assert.equal(blackguard.key, "ability:parry");
  assert.ok(blackguard.monster.includes("human-blackguard"));
  assert.deepEqual(blackguard.triggers[0].steps, [{ type: "halve" }], "halving only: no potency, no shift");
  assert.deepEqual(blackguard.triggers[0].require.keywords, ["strike"]);
  console.log("ok H82 turn.end needs takeTurnNext (heroes only); the Blackguard's Parry! has its own overlay");
}

/* H83: the sweep resolves a card whose hold this GM lost in a reload; another GM's live hold waits */
{
  await fresh({ reactors: [] });
  await set("sweepOnReady", "auto");
  try {
    setActiveGM(gm2);   // nobody resolves the card on create
    const a = post(spear, tGobB, 3);
    const b = post(spear, tGobB, 3);
    await settle();
    setActiveGM(gm);
    for (const m of [a, b]) {
      m.timestamp = mclock.t;
      assert.ok(!getResolution(m).resolvedAt);
    }
    getResolution(a).hold = { at: mclock.t, until: mclock.t + 40_000, by: gm.id, names: ["X"], opIds: [], targetKeys: [] };
    getResolution(b).hold = { at: mclock.t, until: mclock.t + 40_000, by: gm2.id, names: ["X"], opIds: [], targetKeys: [] };
    await sweepOnReady();
    await settle();
    assert.ok(getResolution(a).resolvedAt, "own hold from before the reload: resolved");
    assert.equal(getResolution(a).hold, undefined, "its dead marker removed");
    assert.ok(!getResolution(b).resolvedAt, "another GM's live hold: left alone (swept again when it runs out)");
    messages.delete(b.id);
  } finally {
    await set("sweepOnReady", "banner");
    setActiveGM(gm);
  }
  console.log("ok H83 sweep: a hold lost in a reload is resolved; another GM's live hold is swept once it ran out");
}

/* H84: a reaction whose hit never lands leaves an undone potency row undone (third review) */
{
  await fresh({ reactors: [parry] });
  answerFn = byName({ Benedikt: "decline" });
  const msg = post(spearPotent, tBorin, 10);
  await settle(150);
  const condId = condOp(msg).opId;
  const dmgId = dmgOp(msg).opId;
  await api.undoOps(msg.id, [condId]);
  await api.undoOps(msg.id, [dmgId]);
  await settle();
  assert.equal(condOp(msg).status, "undone");
  answerFn = byName({ Benedikt: "use" });
  sw.failTakeDamage = 1;
  try {
    await api.applyOps(msg.id, [dmgId]).catch(() => null);
    await settle(150);
  } finally {
    sw.failTakeDamage = 0;
  }
  assert.notEqual(dmgOp(msg).status, "applied", "the hit did not land");
  assert.equal(dmgOp(msg).trigger.entries.at(-1).why, "notApplied");
  assert.equal(condOp(msg).status, "undone", "the undone condition row stays undone");
  assert.equal(condOp(msg).potency.triggerDeltas?.length ?? 0, 0, "its potency untouched");
  // settlePrePass restores every sibling exactly as it was (an undone or failed row is never revived as pending).
  const { settlePrePass } = await imp("triggers/holds.mjs");
  const pre = {
    instances: new Map([["k", {
      key: "k", decisions: [{ id: "d84", candidate: null }], ops: [{ opId: "dmg" }], siblings: new Set(["u", "f", "s"]),
      entries: [], origHalf: new Map([["dmg", false]]),
    }]]),
    origPotency: new Map([
      ["u", { potency: { value: 2 }, status: "undone", reason: null }],
      ["f", { potency: { value: 2 }, status: "failed", reason: "targetMissing" }],
      ["s", { potency: { value: 2 }, status: "skipped", reason: "resisted" }],
    ]),
    effects: new Map(), landed: [], decisions: [],
  };
  const patches = { dmg: { status: "failed" }, u: { potency: { value: 1 } } };
  settlePrePass(pre, patches, { ops: {} });
  assert.deepEqual([patches.u.status, patches.f.status, patches.s.status], ["undone", "failed", "skipped"]);
  assert.equal(patches.f.reason, "targetMissing");
  assert.equal(patches.u.potency.value, 2);
  console.log("ok H84 a hit that never lands restores its potency rows exactly (an undone row stays undone)");
}

/* H85: revoking the halving reaction keeps the hit halved while another live reaction could halve it (third review) */
{
  await fresh({ reactors: [parry, reflexes] });
  answerFn = byName({ Benedikt: "use", Borin: "use" });
  const n = messages.size;
  const msg = post(spear, tBorin, 10);
  await settle(200);
  const entries = dmgOp(msg).trigger.entries;
  const halving = entries.find(e => e.halve);
  assert.ok(halving && entries.some(e => e.couldHalve && e.outcome === "used"), "one halved, the other could");
  const card = cardsSince(n).find(c => JSON.stringify(c.flags ?? {}).includes(halving.id));
  assert.ok(card, "the halving reaction's card");
  await api.undoOps(card.id);
  await settle();
  const op = dmgOp(msg);
  assert.ok(op.trigger.entries.find(e => e.id === halving.id).revoked);
  assert.equal(op.trigger.halved, true, "still halved by the other live reaction");
  assert.equal(op.half, true);
  console.log("ok H85 revoking the halving reaction: a live reaction that could halve keeps the hit halved");
}

/* H86: a potency spend is not offered when every potency row of the hit is already resisted (third review) */
{
  const spearFeeble = ability(gobA, "Goblin Feeble Spear", { type: "main", keywords: ["melee", "strike", "weapon"], damage: true, applied: slowed("-6") });
  try {
    await fresh({ reactors: [duck] });
    answerFn = byName({ Borin: { action: "use", spend: true } });
    const msg = post(spearFeeble, tBorin, 10);
    await settle(150);
    assert.equal(condOp(msg).status, "skipped", "resisted at plan time");
    const req = log.sent.filter(s => s.type === "trigger" && s.data?.reactor?.name === "Borin").at(-1)?.data;
    assert.ok(req, "Duck offered (its halving)");
    assert.equal(req.options[0].spend ?? null, null, "no spend: its potency step could change nothing");
    assert.equal(borin.system.stamina.value, 25);
    assert.equal(condOp(msg).potency.triggerDeltas?.length ?? 0, 0);
  } finally {
    gobA.items.delete(spearFeeble.id);
  }
  console.log("ok H86 an already resisted potency row: the potency spend is not offered");
}

/* H87: a held forced move's window opens right before resume(), so its collision damage passes (third review) */
const braceFx = ability(jory, "Brace Hard", { attach: false });
braceFx.flags["stef-ds-automation"] = { overlay: { detached: true, key: "ability:brace-hard", version: "1.0.0", triggers: [
  { id: "braceHard", event: "forced.before", subject: "self", steps: [{ type: "note", text: "Brace", effect: true }] },
] } };
{
  await fresh({ reactors: [shield] });
  const brace = braceFx;
  jory.items.set(brace.id, brace);
  Hooks.callAll("createItem", brace);
  try {
    answerFn = () => undefined;
    let hit = null;
    const collision = { staminaLoss: false, dsbl: { source: { tokenUuid: tGobA.uuid, actorUuid: gobA.uuid } } };
    const allowed = Hooks.call("dsct.preForcedMovement", {
      target: tJory.object, source: tGobA.object, type: "Push", distance: 2,
      resume: () => { hit = jory.system.takeDamage(3, collision); },
    });
    assert.equal(allowed, false, "held");
    await settle(50);
    const gate = triggerDialogs("Jorah")[0];
    assert.ok(gate && !gate.closed, "Brace asked");
    await advance(6_000);   // longer than the window's grace: a window opened at the gate would be gone
    gate.click("use");
    await settle(100);
    assert.ok(hit, "resumed");
    await hit;
    await settle(100);
    assert.equal(triggerDialogs("Jorah").length, 1, "the resumed move's collision damage is not held");
    assert.equal(jory.system.stamina.value, 27);
  } finally {
    jory.items.delete(brace.id);
    Hooks.callAll("deleteItem", brace);
  }
  console.log("ok H87 a held forced move: its window opens right before resume(), collision damage passes");
}

/* H88: Shift+Click half marks: one that rounds to 0 is consumed; healing rows never mark (third review) */
{
  await fresh({ reactors: [shield] });
  answerFn = byName({ "Jorah": "use" });
  markExternalHalf([tJory.uuid, jory.uuid]);
  await jory.system.takeDamage(0, { type: "" });   // Math.floor(1 / 2)
  await settle(50);
  await jory.system.takeDamage(6, { type: "" });
  await settle(150);
  assert.equal(triggerDialogs("Jorah").length, 1, "the next hit is not taken for halved: offered");
  assert.equal(jory.system.stamina.value, 27, "halved by the Shield");
  // Target Damage healing rows: a player's socketed Shift+Click and a GM's click mark nothing.
  await fresh({ reactors: [shield] });
  answerFn = byName({ "Jorah": "use" });
  const healMsg = post(spear, tGobB, 3);
  await settle();
  const realRolls = healMsg.rolls;
  healMsg.rolls = [{ isHeal: true, total: 4 }];
  try {
    onDstdSocket({ type: "request", action: "applyDamage", payload: { halfDamage: true, messageId: healMsg.id, rollIndex: "0", target: { tokenUuid: tJory.uuid, actorUuid: jory.uuid } } });
    onDstdSocket({ type: "request", action: "applyDamage", payload: { halfDamage: true, syntheticDamage: { isHeal: true }, target: { tokenUuid: tJory.uuid, actorUuid: jory.uuid } } });
    await jory.system.takeDamage(6, { type: "" });
    await settle(150);
    assert.equal(triggerDialogs("Jorah").length, 1, "no half mark from a heal row: offered");
    assert.equal(jory.system.stamina.value, 27);
  } finally {
    healMsg.rolls = realRolls;
  }
  const { dstdRowIsHeal } = await imp("triggers/external.mjs");
  assert.equal(dstdRowIsHeal({ message: healMsg, rollIndex: "0", synthetic: { isHeal: true } }), true);
  assert.equal(dstdRowIsHeal({ message: healMsg, rollIndex: "0" }), !!healMsg.rolls?.[0]?.isHeal);
  console.log("ok H88 a half mark rounding to 0 is consumed; Target Damage healing rows never mark");
}

/* H89: a downed NPC never reacts; a spend that is the option's only effect is pre-ticked (third review) */
{
  // The Arixx at 0 Stamina with the system's `dying` only (no Death Tracker): no Skitter.
  await fresh({ reactors: [skitter] });
  const st = arixx.system.stamina.value;
  arixx.system.stamina.value = 0;
  arixx.statuses.add("dying");
  try {
    post(heroStrike, tArixx, 10);
    await settle(150);
    assert.equal(triggerDialogs("Arixx").length, 0, "a dead monster is not offered Skitter");
  } finally {
    arixx.system.stamina.value = st;
    arixx.statuses.delete("dying");
  }
  // Inertial Shield on a hit applied with "Apply half": only its spend's potency step is left, so the spend is required.
  await fresh({ reactors: [shield] });
  await set("damageMode", "manual");
  await set("conditionsMode", "manual");
  answerFn = byName({ "Jorah": "use" });   // Use without ticking anything
  const n = messages.size;
  const msg = post(spearPotent, tJory, 10);
  await settle();
  await api.applyOps(msg.id, [dmgOp(msg).opId], { half: true });
  await settle(150);
  const req = log.sent.filter(s => s.type === "trigger" && s.data?.reactor?.name === "Jorah").at(-1)?.data;
  assert.ok(req, "offered");
  assert.equal(req.options[0].spend?.required, true, "the spend is the option: pre-ticked");
  assert.equal(condOp(msg).potency.triggerDeltas?.length, 1, "potency lowered");
  assert.equal(cardsSince(n).length, 1, "the Shield's card (spend charged)");
  console.log("ok H89 a downed NPC is not offered a reaction; a spend that is the only effect is required");
}

/* H90: Word of Guidance's edge switched off (pill) or lowered (no pills) before rolling: released, no card (third review) */
{
  for (const mode of ["pill", "select"]) {
    await fresh({ reactors: [guidance] });
    if (mode === "select") game.settings.set("draw-steel-combat-tools", "rollDialogPillUI", false);
    const app = rollApp(borinFreeStrike);
    if (mode === "pill") app._dsctSources = [];
    answerFn = byName({ Conduit: "use" });
    const n = messages.size;
    try {
      await as(player2, async () => {
        Hooks.callAll("renderAbilityConfigurationDialog", app);
      });
      await settle(150);
      if (mode === "pill") {
        assert.equal(app._dsctSources.length, 1, "our pill");
        app._dsctSources[0].enabled = false;   // the roller clicks it off
      } else {
        assert.equal(app.options.context.modifiers.edges, 1, "the edge added");
        app.options.context.modifiers.edges = 0;   // the roller lowers the select
      }
      await as(player2, async () => {
        await fireSubmit(app);
      });
      await settle(200);
      assert.equal(relayed("preRollDone").at(-1)?.data?.preRollDone?.applied, false, `${mode}: released`);
      assert.equal(cardsSince(n).length, 0, `${mode}: no Word of Guidance card`);
    } finally {
      Hooks.callAll("closeAbilityConfigurationDialog", app);
    }
  }
  console.log("ok H90 an edge switched off or lowered before the roll releases Word of Guidance");
}

/* H91: holds of a fresh card resolved late; Undo all hidden while held; a detached monster overlay keeps its stamp (third review) */
{
  // effectiveUntil: a fresh card's cap starts at its last server-set change (the hold's own write).
  const { effectiveUntil } = await imp("engine/record.mjs");
  const now = mclock.t;
  const res = { hold: { at: now, until: now + 40_000 } };
  assert.ok(effectiveUntil(res, { timestamp: now - 300_000 }) < now, "creation time only: dead (the old behaviour)");
  assert.equal(effectiveUntil(res, { timestamp: now - 300_000, _stats: { modifiedTime: now } }), now + 40_000, "hold write time: live");
  assert.equal(effectiveUntil({ resolvedAt: now, hold: { at: now - 300_000, until: now + 40_000 } }, { _stats: { modifiedTime: now } }),
    now - 300_000 + 260_000, "a resolved card still caps at its GM-signed hold.at");
  // Undo all is hidden while the card is held (as each row's Undo).
  await fresh({ reactors: [] });
  const m = post(spearPotent, tBorin, 10);
  await settle();
  assert.equal(buildView(m, getResolution(m)).canUndoAll, true, "applied rows: Undo all");
  getResolution(m).hold = { at: mclock.t, until: mclock.t + 40_000, by: gm.id, names: [], opIds: [], targetKeys: [] };
  try {
    assert.equal(buildView(m, getResolution(m)).canUndoAll, false, "held: no Undo all");
  } finally {
    delete getResolution(m).hold;
  }
  // A detached Blackguard "Parry!" keeps its own triggers on an actor whose overlay for that key is the Tactician's.
  const { resolveAbility } = await imp("library/resolve.mjs");
  const blackguard = JSON.parse(readFileSync(LIBRARY + "monsters/parry.json", "utf8"));
  const own = parry.flags["stef-ds-automation"];
  parry.flags["stef-ds-automation"] = { overlay: {
    detached: true, key: "ability:parry", version: blackguard.version, monster: blackguard.monster, triggers: blackguard.triggers, trackers: [],
  } };
  try {
    const r = resolveAbility(parry);
    assert.deepEqual(r.triggers, blackguard.triggers, "the stamp's triggers, not the Tactician's");
    assert.equal(r.outdated, false, "not outdated against another overlay");
    delete parry.flags["stef-ds-automation"].overlay.monster;   // a stamp from before 0.7.0: follows the key
    assert.notDeepEqual(resolveAbility(parry).triggers, blackguard.triggers);
  } finally {
    if (own === undefined) delete parry.flags["stef-ds-automation"];
    else parry.flags["stef-ds-automation"] = own;
  }
  console.log("ok H91 fresh-card hold cap from its write; Undo all hidden while held; detached monster stamp kept");
}

console.log("\nALL HARNESS-8 TESTS PASSED");
process.exit(0);
console.log("\nPART 2 DONE");
process.exit(0);
