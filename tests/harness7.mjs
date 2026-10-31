// Seventh harness (Milestone 4): the ability library runtime. Registry (validation, priority, monster
// keys), resolve layers (native / overlay / detached / disabled, Combat Tools coexistence), library rows
// (self rows, Recoveries, resources, conditions, cleanse with a choice, notes, teleports, filters,
// spend / strained, potency), choice groups, Combat Tools "choose one" picks, adoption of unseeded
// cards, detached entries (conversion, actions, keeper), and the shipped library overlays.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const paths = (await import("node:module")).createRequire(import.meta.url)("./paths.cjs"); const ROOT = paths.SCRIPTS;
const LIBRARY = paths.LIBRARY + "/";
globalThis.__HARNESS_SKIP_SCENARIOS__ = true;

/* ---------- mocks installed before the module loads ---------- */
const getPath = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);
globalThis.__HARNESS_SETUP__ = () => {
  game.modules.set("lib-wrapper", { active: true });
  globalThis.libWrapper = { register() {} };
  // Formulas: @paths from the roll data, then plain arithmetic (test only).
  ds.utils.evaluateFormula = (f, rd) => {
    const src = String(f).replace(/@([A-Za-z_][A-Za-z0-9_.]*)/g, (_m, p) => {
      const v = getPath(rd, p);
      if (v === undefined || v === null || typeof v === "object") throw new Error(`no @${p}`);
      return `(${Number(v)})`;
    });
    if (!/^[\d\s+\-*/().]+$/.test(src)) throw new Error(`bad formula ${f}`);
    return Function(`return (${src})`)();
  };
  // ForcedReplacement as core's: a proxy that exposes the inner value.
  class ForcedReplacement {
    constructor(v) { this.value = v; }
    static create(v) {
      const op = new ForcedReplacement(v);
      return new Proxy(op, {
        get: (t, p) => (p in t ? t[p] : t.value?.[p]),
        set: (t, p, val) => { if (p in t) t[p] = val; else t.value[p] = val; return true; },
        has: (t, p) => p in t || p in (t.value ?? {}),
      });
    }
    static get(op) { return op.value; }
  }
  foundry.data.operators.ForcedReplacement = ForcedReplacement;
  foundry.utils.setProperty = (obj, key, value) => { const parts = key.split("."); let o = obj; for (const k of parts.slice(0, -1)) o = o[k] ??= {}; o[parts.at(-1)] = value; };
  CONFIG.statusEffects.push(
    { id: "prone", _id: "prone00000000000", name: "Prone" },
    { id: "weakened", _id: "weakened00000000", name: "Weakened" },
    { id: "dazed", _id: "dazed00000000000", name: "Dazed" },
  );
  ds.CONFIG.conditions.prone = {};
  ds.CONFIG.conditions.weakened = {};
  CONFIG.ActiveEffect.documentClass = {
    async fromStatusEffect(id) {
      const s = CONFIG.statusEffects.find(e => e.id === id);
      return { toObject: () => ({ _id: s._id, name: s.name, statuses: [id], duration: {} }) };
    },
    getEffectStart: () => ({ combat: null, combatant: null, round: null, turn: null }),
  };
};

const world = await import(new URL("./harness.mjs", import.meta.url).href);
const { makeAbility, hero, gobA, gobB, tA, tB, api, getResolution, buildView, users, setUser, registry, Message, messages, postAbility, Effect, Actor, addToken } = world;
const { gm, player } = users;
// Library teleports reach the real owner path: Combat Tools (mocked per test) or the proposal picker.
// Exercise the card-button relay directly; api.request is a GM-only diagnostic from M8.
const { requestOp } = await import(pathToFileURL(ROOT + "relay/queries.mjs").href);
const lib = api.library;
const imp = p => import(pathToFileURL(ROOT + p).href);
const { effectToEntries, entryToEffect, entryId } = await imp("library/entries.mjs");
const { onPreUpdateItem } = await imp("library/keeper.mjs");
const { evaluate } = await imp("library/formula.mjs");
const { chooseAssignment, effectShows } = await imp("library/choose-compat.mjs");
const { formulaProblem, validateOverlay } = await imp("library/schema.mjs");

const set = (key, value) => game.settings.set("stef-ds-automation", key, value);
const settle = () => new Promise(r => setTimeout(r, 30));
const opsOf = msg => Object.values(getResolution(msg).ops);
const ForcedDeletion = foundry.data.operators.ForcedDeletion;

/* ---------- the user's token, an ally, hero resources ---------- */
const heroTok = addToken("hero000000000tok", hero, "Hero");
heroTok.document.disposition = 1;
hero.token = null;
tA.document.disposition = -1;
tB.document.disposition = -1;
const ally = new Actor({ uuid: "Actor.ally000000000001", name: "Ally", type: "hero" });
registry.set(ally.uuid, ally);
const tAlly = addToken("tokAlly000000001", ally, "Ally");
tAlly.document.disposition = 1;
ally.token = tAlly.document;
for (const a of [hero, ally]) {
  a.system.recoveries = { value: 8, max: 8, recoveryValue: 10 };
  a.system.hero = { surges: 0, primary: { value: 3 }, epic: { value: 0 } };
  a.system.stamina.value = 15;
  a.system.stamina.max = 30;
}
hero.getRollData = () => ({ P: 2, R: 3, chr: 3, potency: { weak: 1, average: 2, strong: 3 }, recoveries: { recoveryValue: 10 } });
ally.getRollData = () => ({ recoveries: { recoveryValue: 7 }, level: 2 });
gobA.getRollData = () => ({});
gobB.getRollData = () => ({});
const resetHeroes = () => {
  for (const a of [hero, ally]) {
    a.system.recoveries.value = 8;
    a.system.hero.surges = 0;
    a.system.hero.primary.value = 3;
    a.system.stamina.value = 15;
    a.system.stamina.temporary = 0;
    a.effects.clear();
    a.statuses.clear();
  }
  for (const a of [gobA, gobB]) { a.system.stamina.value = 20; a.system.stamina.temporary = 0; a.effects.clear(); a.statuses.clear(); }
};

/** An ability with special effects (spend / strained / Combat Tools types), own effects and update(). */
let n = 0;
function ability({ name, damage = false, applied = null, powerRoll = true, special = [], aes = [], actor = hero }) {
  const item = makeAbility({ uuid: `${actor.uuid}.Item.m4${String(++n).padStart(14, "0")}`, name, actor, damage, applied });
  item.system._dsid = name.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const specials = new Map(special.map(s => [s.id, s]));
  item.system.effects = { contents: [...specials.values()], get: id => specials.get(id) ?? null };
  item.system.power.roll = { enabled: powerRoll };
  item.flags = {};
  item.isOwner = true;
  for (const ae of aes) {
    const e = new Effect(ae, item);
    e.clone = (_d, { keepId } = {}) => { const c = new Effect({ ...e.toObject(), ...(keepId ? {} : { _id: undefined }) }); return c; };
    item.effects.set(e.id, e);
  }
  item.getFlag = (scope, key) => item.flags?.[scope]?.[key];
  item._source = { system: { effects: {} } };
  item.update = async (changes) => {
    for (const [k, v] of Object.entries(changes)) {
      const parts = k.split(".");
      let o = parts[0] === "system" ? item._source : item;
      if (parts[0] === "system" && parts[1] === "effects") {
        const id = parts[2];
        if (v instanceof ForcedDeletion) delete item._source.system.effects[id];
        else item._source.system.effects[id] = JSON.parse(JSON.stringify(v));
        continue;
      }
      for (const p of parts.slice(0, -1)) o = o[p] ??= {};
      if (v instanceof ForcedDeletion) delete o[parts.at(-1)];
      else o[parts.at(-1)] = v;
    }
    // Prepared view of our entries.
    const entries = Object.values(item._source.system.effects).map(d => ({ ...d, id: d._id }));
    item.system.effects.contents = [...specials.values(), ...entries];
    return item;
  };
  return item;
}

/** Post an ability card; `use` = special effect ids the card shows (abilityUse part). */
function use(item, byTier, dmg = {}, { shown = [], flags = {} } = {}) {
  const extraParts = { abilityUse000000: { _id: "abilityUse000000", type: "abilityUse", abilityUuid: item.uuid, effects: shown } };
  const msg = postAbility(item, byTier, dmg, { extraParts });
  Object.assign(msg.flags, flags);
  return msg;
}
/** A card without a power roll: only the abilityUse part, with the user's targets. */
function useNoRoll(item, targets = [], { shown = [] } = {}) {
  const parts = { abilityUse000000: { _id: "abilityUse000000", type: "abilityUse", abilityUuid: item.uuid, effects: shown } };
  const msg = new Message({ type: "standard", parts, speaker: { scene: "scene00000000001", token: "hero000000000tok" } });
  gm.targets = new Set(targets);
  Hooks.call("preCreateChatMessage", msg, {}, {}, gm.id);
  msg.author = gm;
  msg.timestamp = Date.now();
  messages.set(msg.id, msg);
  Hooks.callAll("createChatMessage", msg, {}, "x");
  return msg;
}

/* ---------- schema, formulas ---------- */
{
  assert.equal(formulaProblem("5 + @spend"), null);
  assert.equal(formulaProblem("3 * @P"), null);
  assert.equal(formulaProblem("max(1, @tier)"), null);
  assert.ok(formulaProblem("5 +"));
  assert.ok(formulaProblem("eval(1)"));
  assert.ok(formulaProblem("1; alert(1)"));
  const bad = validateOverlay({ key: "ability:x", version: "1", name: "X", effects: [{ id: "a", type: "heal", value: 1, recoveries: 1 }] });
  assert.ok(!bad.ok && bad.errors.some(e => /semver/.test(e)) && bad.errors.some(e => /exactly one/.test(e)));
  const choice = validateOverlay({ key: "ability:x", version: "1.0.0", name: "X", choices: [{ id: "g", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }],
    effects: [{ id: "a", type: "note", text: "x", choice: { group: "g", option: "a" } }] });
  assert.ok(choice.errors.some(e => /option "b" has no effects/.test(e)));
  assert.ok(!validateOverlay({ key: "ability:x", version: "1.0.0", name: "X", effects: [{ id: "a", type: "forced", movement: "push", distance: 1, targets: "self" }] }).ok);
  const it = ability({ name: "Formula" });
  assert.equal(evaluate("5 + @spend", it, { spend: [2, 1] }), 8);
  assert.equal(evaluate("@tier * 2", it, { tier: 3 }), 6);
  assert.equal(evaluate("@config.extra + 1", it, { config: { extra: 4 } }), 5);
  assert.equal(evaluate("@target.recoveries.recoveryValue", it, { target: ally }), 7);
  assert.equal(evaluate("@nope", it), null);
  console.log("ok schema / formulas");
}

/* ---------- registry: validation, priority, monster keys ---------- */
{
  const r = lib.registerSource({ id: "test-low", priority: 1, overlays: [
    { key: "ability:reg-one", version: "1.0.0", name: "Reg One", effects: [{ id: "a", type: "note", text: "low" }] },
    { key: "ability:reg-bad", version: "x", name: "Bad", effects: [] },
  ] });
  assert.deepEqual([r.accepted, r.rejected], [1, 1]);
  lib.registerSource({ id: "test-high", priority: 9, overlays: [
    { key: "ability:reg-one", version: "2.0.0", name: "Reg One", effects: [{ id: "a", type: "note", text: "high" }] },
    { key: "ability:reg-one", monster: ["goblin-a"], version: "1.0.0", name: "Reg One", effects: [{ id: "a", type: "note", text: "goblin" }] },
  ] });
  const generic = ability({ name: "Reg One" });
  assert.equal(lib.find(generic).effects[0].text, "high", "higher priority wins");
  const gobItem = makeAbility({ uuid: `${gobA.uuid}.Item.regone0000000001`, name: "Reg One", actor: gobA, damage: false });
  gobA.type = "npc";
  assert.equal(lib.find(gobItem).effects[0].text, "goblin", "monster-specific overlay (name slug) wins");
  gobA.flags = { "stef-ds-automation": { monsterKey: "other" } };
  gobA.getFlag = (s, k) => gobA.flags?.[s]?.[k];
  // Milestone 7 NPC guard (docs/M7-DESIGN.md §3.11): an NPC never borrows a generic overlay without `npc: true`.
  assert.equal(lib.find(gobItem), null, "a pinned monster key changes the match (no generic overlay for an NPC)");
  delete gobA.flags;
  delete gobA.getFlag;
  const info = lib.info();
  assert.ok(info.invalid.some(i => i.key === "ability:reg-bad"));
  assert.ok(info.collisions.some(c => c.key === "ability:reg-one"));
  lib.unregisterSource("test-low");
  lib.unregisterSource("test-high");
  assert.equal(lib.find(generic), null);
  console.log("ok registry (validation, priority, monster keys)");
}

/* ---------- the shipped library registers cleanly ---------- */
{
  const shipped = (await import(pathToFileURL(LIBRARY + "dist/overlays.mjs").href)).default;
  const r = lib.registerSource({ id: "stef-ds-automation.library", priority: 50, overlays: shipped });
  assert.equal(r.rejected, 0, "every shipped overlay passes the runtime schema");
  assert.ok(r.accepted >= 10);
  console.log(`ok library: ${r.accepted} overlays registered`);
}

/* ---------- resolve layers and statuses ---------- */
{
  lib.registerSource({ id: "t-layers", priority: 60, overlays: [
    { key: "ability:layer-o", version: "1.1.0", name: "Layer O", effects: [{ id: "a", type: "resource", targets: "self", resource: "surge", value: 1 }] },
    { key: "ability:layer-c", version: "1.0.0", name: "Layer C", config: [{ key: "x", type: "checkbox", label: "X", default: false }], effects: [{ id: "a", type: "note", text: "n" }] },
    { key: "ability:layer-d", version: "1.0.0", name: "Layer D", effects: [{ id: "h", type: "heal", value: 3 }, { id: "t", type: "teleport", targets: "self", distance: 3 }] },
  ] });
  assert.equal(lib.status(ability({ name: "Layer None" })), "manual");
  assert.equal(lib.status(ability({ name: "Layer Native", damage: true })), "native");
  const o = ability({ name: "Layer O" });
  assert.equal(lib.status(o), "automated");
  assert.equal(lib.status(ability({ name: "Layer C" })), "configurable");
  o.flags = { "stef-ds-automation": { disabled: true } };
  assert.equal(lib.status(o), "disabled");
  o.flags = { "stef-ds-automation": { lock: true } };
  assert.equal(lib.status(o), "locked");
  o.flags = {};
  // Combat Tools automates heals and teleports itself on this item: only those kinds are left to it.
  game.modules.set("draw-steel-combat-tools", { active: true, api: {} });
  const d = ability({ name: "Layer D", special: [{ id: "dsctflat00000001", type: "dsct.flatHeal" }] });
  let r = lib.resolve(d);
  assert.deepEqual(r.effects.map(e => e.type), ["teleport"]);
  assert.deepEqual(r.dsctCovered, ["heal"]);
  assert.equal(r.status, "automated", "the teleport is still ours");
  // Combat Tools covers every library effect: the overlay adds nothing ("covered", not "automated").
  const all = ability({ name: "Layer D", special: [{ id: "dsctflat00000001", type: "dsct.flatHeal" }, { id: "dsctflat00000002", type: "dsct.flatTeleport" }] });
  assert.deepEqual([lib.resolve(all).effects.length, lib.status(all)], [0, "covered"]);
  await set("libraryDefersToCombatTools", false);
  assert.equal(lib.resolve(d).effects.length, 2);
  await set("libraryDefersToCombatTools", true);
  game.modules.delete("draw-steel-combat-tools");
  await set("libraryEnabled", false);
  assert.equal(lib.status(o), "manual", "library off: overlays ignored");
  await set("libraryEnabled", true);
  console.log("ok resolve layers / statuses / Combat Tools coexistence / master switch");
}

/* ---------- self rows: Catch Breath (Recoveries), no power roll ---------- */
{
  resetHeroes();
  const item = ability({ name: "Catch Breath", powerRoll: false });
  const msg = useNoRoll(item, [tA]); // a stray target gets nothing and is dropped
  await settle();
  const res = getResolution(msg);
  assert.ok(res?.resolvedAt);
  assert.deepEqual(Object.keys(res.targets).length, 1, "only the user's own row");
  const op = opsOf(msg)[0];
  assert.deepEqual([op.kind, op.recoveries, op.self, op.status], ["heal", 1, true, "applied"]);
  assert.deepEqual([hero.system.recoveries.value, hero.system.stamina.value], [7, 25]);
  const view = buildView(msg, res);
  assert.equal(view.rows[0].tierLabel, "DSAUTO.Card.Self");
  assert.match(view.rows[0].ops[0].label, /HealRecoveries/);
  assert.equal(view.canRetarget, true);
  item.system.target = { type: "self" };
  assert.equal(buildView(msg, res).canRetarget, false, "no \"Use my targets\" on a self-only ability");
  delete item.system.target;
  await api.undoOps(msg.id);
  assert.deepEqual([hero.system.recoveries.value, hero.system.stamina.value], [8, 15], "Recovery and Stamina back");
  console.log("ok self row, Recoveries, undo");
}

/* ---------- resources with native damage (To the Death!), undo ---------- */
{
  resetHeroes();
  const item = ability({ name: "To the Death!", damage: true });
  const msg = use(item, { 2: [tA] }, { 2: [{ total: 6, options: {} }] });
  await settle();
  const kinds = opsOf(msg).map(o => `${o.kind}:${o.status}`).sort();
  assert.deepEqual(kinds, ["damage:applied", "resource:applied"]);
  assert.equal(hero.system.hero.surges, 2);
  assert.equal(gobA.system.stamina.value, 14);
  hero.system.hero.surges = 5; // spent / gained elsewhere in between
  await api.undoOps(msg.id);
  assert.equal(hero.system.hero.surges, 3, "delta undo of the gain");
  assert.equal(gobA.system.stamina.value, 20);
  console.log("ok resource gain with native damage, delta undo");
}

/* ---------- conditions: statuses, the ability's own effect, potency by tier ---------- */
{
  resetHeroes();
  lib.registerSource({ id: "t-cond", priority: 60, overlays: [{
    key: "ability:cond-test", version: "1.0.0", name: "Cond Test",
    effects: [
      { id: "dazed", type: "condition", status: "dazed", end: "save", potency: { characteristic: "might", value: "@potency.average" }, tiers: [2, 3] },
      { id: "mark", type: "condition", effect: "markEffect000001" },
      { id: "ward", type: "condition", targets: "self", effect: "wardEffect000001" },
    ],
  }] });
  const item = ability({ name: "Cond Test", aes: [{ _id: "markEffect000001", name: "Marked", duration: { expiry: "combatEnd" } }, { _id: "wardEffect000001", name: "Ward" }] });
  const msg = use(item, { 2: [tA, tB] });
  await settle();
  // Potency average 2: goblin A (might 0) fails, goblin B (might 3) resists.
  assert.ok(gobA.effects.get("dazed00000000000"), "A dazed");
  assert.equal(gobA.effects.get("dazed00000000000").duration.expiry, "save");
  assert.ok(!gobB.effects.get("dazed00000000000"));
  const skipped = opsOf(msg).find(o => o.libEffect === "dazed" && o.status === "skipped");
  assert.equal(skipped.reason, "resisted");
  assert.equal(gobA.effects.get("markEffect000001")?.duration?.expiry, "combatEnd", "the ability's own effect keeps its duration");
  assert.ok(hero.effects.get("wardEffect000001"), "self effect on the user");
  // Applying again replaces the copy (kept for undo); undo puts the old one back.
  await gobA.effects.get("markEffect000001").update({ name: "Marked (old)" });
  const msg2 = use(item, { 2: [tA] });
  await settle();
  assert.equal(gobA.effects.get("markEffect000001").name, "Marked");
  await api.undoOps(msg2.id);
  assert.equal(gobA.effects.get("markEffect000001").name, "Marked (old)");
  await api.undoOps(msg.id);
  assert.ok(!gobA.effects.get("dazed00000000000") && !gobA.effects.get("markEffect000001") && !hero.effects.get("wardEffect000001"));
  console.log("ok library conditions (status, own effect, self, potency, replace + undo)");
}

/* ---------- cleanse with a choice; filters ---------- */
{
  resetHeroes();
  lib.registerSource({ id: "t-cleanse", priority: 60, overlays: [{
    key: "ability:cleanse-test", version: "1.0.0", name: "Cleanse Test",
    effects: [
      { id: "end", type: "cleanse", filter: "allies", ends: ["save", "turn"], count: 1 },
      { id: "hurt", type: "damage", filter: "enemies", value: 4, damageType: "fire" },
    ],
  }] });
  const item = ability({ name: "Cleanse Test" });
  await ally.createEmbeddedDocuments("ActiveEffect", [
    { _id: "allyBleed0000001", name: "Bleeding", statuses: ["bleeding"], duration: { expiry: "save" } },
    { _id: "allySlow00000001", name: "Slowed", statuses: ["slowed"], duration: { expiry: "turnEnd" } },
    { _id: "allyDead00000001", name: "Winded", statuses: ["winded"], duration: { expiry: "save" } },
  ]);
  const msg = use(item, { 1: [tAlly, tA] });
  await settle();
  const cleanse = opsOf(msg).find(o => o.kind === "cleanse");
  const hurt = opsOf(msg).find(o => o.kind === "damage");
  assert.deepEqual(cleanse.targetKeys, [tAlly.document.uuid.replace(/\./g, "__")], "cleanse only on the ally");
  assert.equal(hurt.targetKeys[0], tA.document.uuid.replace(/\./g, "__"), "damage only on the enemy");
  assert.equal(gobA.system.stamina.value, 18, "fire 4 - immunity 2");
  assert.deepEqual([cleanse.status, cleanse.reason, cleanse.candidates], ["pending", "chooseEffects", 2], "two candidates for one: someone chooses");
  assert.equal(buildView(msg, getResolution(msg)).rows.find(r => r.name === "Ally").ops[0].applyAction, "dsAutoEditApply");
  await api.applyOps(msg.id);
  assert.equal(opsOf(msg).find(o => o.kind === "cleanse").status, "pending", "Apply all leaves a row that needs a choice");
  await api.applyOps(msg.id, [cleanse.opId]);
  assert.equal(getResolution(msg).ops[cleanse.opId].reason, "chooseEffects");
  assert.ok(ally.effects.has("allyBleed0000001") && ally.effects.has("allySlow00000001"));
  await assert.rejects(api.editOp(msg.id, hurt.opId, { effects: ["allySlow00000001"] }, { apply: true }), /BadRequest/, "effects only on cleanse rows");
  await api.editOp(msg.id, cleanse.opId, { effects: ["allySlow00000001"] }, { apply: true });
  assert.ok(!ally.effects.has("allySlow00000001") && ally.effects.has("allyBleed0000001"), "the chosen one ended");
  await assert.rejects(api.editOp(msg.id, cleanse.opId, { effects: ["a", "b"] }), /BadRequest/);
  await api.undoOps(msg.id, [cleanse.opId]);
  assert.ok(ally.effects.has("allySlow00000001"), "undo brings it back");
  console.log("ok cleanse (choice, Apply all skip, edit + apply, undo), ally / enemy filters");
}

/* ---------- native.filter: the system's own rows spare allies (Awe); flags left clean ---------- */
{
  resetHeroes();
  const keyOf = t => t.document.uuid.replace(/\./g, "__");
  const spare = { key: "ability:spare-test", version: "1.0.0", name: "Spare Test", native: { filter: "enemies" },
    effects: [{ id: "temp", type: "heal", filter: "allies", value: 3, temporary: true }] };
  assert.ok(validateOverlay(spare).ok);
  assert.ok(!validateOverlay({ ...spare, native: { filter: "friends" } }).ok, "filter is allies or enemies");
  assert.ok(!validateOverlay({ ...spare, native: { only: "enemies" } }).ok, "unknown native field");
  lib.registerSource({ id: "t-native-filter", priority: 60, overlays: [spare] });
  const item = ability({ name: "Spare Test", damage: true });
  assert.equal(lib.resolve(item).nativeFilter, "enemies");
  const msg = use(item, { 2: [tAlly, tA] }, { 2: [{ total: 8, options: { type: "psychic" } }] });
  await settle();
  const dmg = opsOf(msg).filter(o => o.kind === "damage");
  const onAlly = dmg.find(o => o.targetKeys[0] === keyOf(tAlly));
  const onFoe = dmg.find(o => o.targetKeys[0] === keyOf(tA));
  assert.deepEqual([onAlly.status, onAlly.reason], ["skipped", "nativeSparesAllies"], "the ally takes no native damage");
  assert.equal(onFoe.status, "applied");
  assert.deepEqual([ally.system.stamina.value, ally.system.stamina.temporary, gobA.system.stamina.value], [15, 3, 12]);
  // The Director can still apply the skipped row by hand.
  await api.applyOps(msg.id, [onAlly.opId]);
  assert.equal(ally.system.stamina.value, 10, "8 psychic, 3 of it from temporary Stamina");
  await api.undoOps(msg.id);
  assert.deepEqual([ally.system.stamina.value, ally.system.stamina.temporary, gobA.system.stamina.value], [15, 0, 20]);
  // Detached items keep the filter in the stamp; Reset / Enable / Unlock leave no flags behind.
  await lib.detach(item);
  assert.equal(item.flags["stef-ds-automation"].overlay.nativeFilter, "enemies");
  lib.unregisterSource("t-native-filter");
  assert.equal(lib.resolve(item).nativeFilter, "enemies", "without the overlay");
  await lib.reset(item);
  assert.equal(item.flags["stef-ds-automation"], undefined, "reset removes the empty scope");
  await lib.disable(item, true);
  assert.deepEqual(item.flags["stef-ds-automation"], { disabled: true });
  assert.equal(lib.resolve(item).notes, null);
  await lib.lock(item, true);
  await lib.disable(item, false);
  assert.deepEqual(item.flags["stef-ds-automation"], { lock: true }, "no disabled: false");
  await lib.lock(item, false);
  assert.equal(item.flags["stef-ds-automation"], undefined, "no lock: false, no empty scope");
  console.log("ok native.filter (allies spared, manual apply, undo, detached stamp), clean flags");
}

/* ---------- choice groups (Heal): pick, skip, lock, undo ---------- */
{
  resetHeroes();
  const item = ability({ name: "Heal", powerRoll: false });
  const msg = useNoRoll(item, [tAlly]);
  await settle();
  let res = getResolution(msg);
  assert.ok(res.choices.help, "group on the record");
  assert.ok(opsOf(msg).every(o => o.awaitingChoice && o.status === "pending"));
  await api.applyOps(msg.id);
  assert.equal(ally.system.recoveries.value, 8, "Apply all waits for the choice");
  let view = buildView(msg, res);
  assert.equal(view.choices.length, 1);
  assert.ok(view.choices[0].canChoose);
  assert.ok(view.rows[0].ops.every(o => !o.canApply), "rows wait");
  await requestOp({ action: "choose", messageId: msg.id, group: "help", option: "recovery" });
  res = getResolution(msg);
  const heal = opsOf(msg).find(o => o.kind === "heal");
  const note = opsOf(msg).find(o => o.kind === "note");
  assert.deepEqual([heal.status, note.status, note.reason], ["applied", "skipped", "notChosen"]);
  assert.deepEqual([ally.system.recoveries.value, ally.system.stamina.value], [7, 25], "the ally spent a Recovery (their own value)");
  await assert.rejects(requestOp({ action: "choose", messageId: msg.id, group: "help", option: "save" }), /ChoiceLocked/);
  await api.undoOps(msg.id);
  await requestOp({ action: "choose", messageId: msg.id, group: "help", option: "save" });
  assert.deepEqual(opsOf(msg).map(o => `${o.kind}:${o.status}`).sort(), ["heal:skipped", "note:pending"]);
  view = buildView(msg, getResolution(msg));
  assert.equal(view.choices[0].picked, "save");
  // Players cannot pick on a Director-only card.
  setUser(player);
  await assert.rejects(requestOp({ action: "choose", messageId: msg.id, group: "help", option: "recovery" }), /Denied/);
  setUser(gm);
  console.log("ok choice groups (wait, pick, other skipped, locked after apply, re-pick, denied)");
}

/* ---------- when: spend / strained / config ---------- */
{
  resetHeroes();
  lib.registerSource({ id: "t-when", priority: 60, overlays: [{
    key: "ability:when-test", version: "1.0.0", name: "When Test",
    config: [{ key: "bonus", type: "checkbox", label: "Bonus", default: false }],
    effects: [
      { id: "spent", type: "resource", targets: "self", resource: "surge", value: "1 + @spend", when: { spend: true } },
      { id: "strain", type: "condition", targets: "self", status: "weakened", end: "turn", when: { strained: true } },
      { id: "cfg", type: "resource", targets: "self", resource: "heroic", value: 1, when: { config: "bonus" } },
    ],
  }] });
  const item = ability({ name: "When Test", special: [{ id: "spend00000000000", type: "spend" }, { id: "strained00000001", type: "strained" }] });
  const plain = use(item, { 1: [tA] });
  await settle();
  assert.equal(opsOf(plain).length, 0, "nothing without spend, strain or option");
  item.flags = { "stef-ds-automation": { config: { bonus: true } } };
  const msg = use(item, { 1: [tA] }, {}, { shown: ["spend00000000000", "strained00000001"] });
  getResolution(msg).spend = [2];
  await settle();
  await api.resolve(msg.id, { force: true });
  assert.deepEqual(opsOf(msg).map(o => o.libEffect).sort(), ["cfg", "spent", "strain"]);
  assert.equal(opsOf(msg).find(o => o.libEffect === "spent").amount, 3, "1 + @spend 2");
  const cfgLabel = () => buildView(msg, getResolution(msg)).rows.flatMap(r => r.ops).find(o => o.opId === opsOf(msg).find(x => x.libEffect === "cfg").opId).label;
  assert.match(cfgLabel(), /Resource\.heroic/);
  hero.system.hero.primary.label = "Clarity";
  assert.match(cfgLabel(), /ResourceNamed/, "the hero's own resource name");
  delete hero.system.hero.primary.label;
  item.flags = {};
  console.log("ok when.spend / when.strained / when.config");
}

/* ---------- teleports: the owner picks on their client, the GM records ---------- */
{
  resetHeroes();
  heroTok.document.x = 500; heroTok.document.y = 500; heroTok.document.elevation = 0;
  heroTok.document.parent = { id: "scene00000000001", grid: { size: 100 } };
  heroTok.document.update = async (d) => { Object.assign(heroTok.document, d); return heroTok.document; };
  lib.registerSource({ id: "t-manual-teleport", priority: 60, overlays: [{ key: "ability:manual-teleport-test", version: "1.0.0", name: "Manual Teleport Test", effects: [{ id: "teleport", type: "teleport", targets: "self", distance: "5 + @spend", autoStart: false }] }] });
  const item = ability({ name: "Manual Teleport Test", special: [{ id: "spend00000000000", type: "spend" }] });
  const msg = useNoRoll(item, [], { shown: [] });
  await settle();
  const op = opsOf(msg)[0];
  assert.deepEqual([op.kind, op.mode, op.selfMove, op.distance], ["teleport", "manual", true, 5]);
  // The owner (a player, below the role floor) may apply it with the move they made.
  setUser(player);
  let view = buildView(msg, getResolution(msg));
  assert.equal(view.rows[0].ops[0].applyAction, "dsAutoApply");
  assert.ok(view.rows[0].ops[0].canApply);
  // Foundry reports the player's move on every client (moveToken); the request only claims it.
  const move = (user, from, to) => {
    heroTok.document.x = to.x; heroTok.document.y = to.y; heroTok.document.elevation = to.elevation ?? 0;
    Hooks.callAll("moveToken", heroTok.document, { origin: { elevation: 0, ...from }, destination: { elevation: 0, ...to } }, {}, user);
  };
  const claim = () => requestOp({ action: "apply", messageId: msg.id, opIds: [op.opId], moves: { [op.opId]: true } });
  move(player, { x: 500, y: 500 }, { x: 900, y: 500 }); // 4 squares on the player's client
  await claim();
  let rec = getResolution(msg).ops[op.opId];
  assert.deepEqual([rec.status, rec.byClient, rec.moves[0].finalPos.x], ["applied", true, 900]);
  setUser(gm);
  await api.undoOps(msg.id);
  assert.equal(heroTok.document.x, 500, "undo puts it back");
  // Too long (elevation counts), no move reported, a move by someone else, a forged payload: refused.
  setUser(player);
  move(player, { x: 500, y: 500 }, { x: 600, y: 500, elevation: 40 });
  await claim();
  assert.equal(getResolution(msg).ops[op.opId].reason, "tooFar", "8 squares up (5 ft each)");
  heroTok.document.x = 500; heroTok.document.elevation = 0;
  await claim();
  assert.equal(getResolution(msg).ops[op.opId].reason, "badDestination", "no move of this token was reported");
  move(gm, { x: 500, y: 500 }, { x: 700, y: 500 });
  await claim();
  assert.equal(getResolution(msg).ops[op.opId].reason, "badDestination", "the Director moved it, not the player");
  await assert.rejects(requestOp({ action: "apply", messageId: msg.id, opIds: [op.opId], moves: { [op.opId]: [{ tokenUuid: heroTok.document.uuid, startPos: { x: 0, y: 0 } }] } }), /BadRequest/);
  // Someone who does not own the user may not.
  hero.owners.delete("pl");
  await assert.rejects(requestOp({ action: "apply", messageId: msg.id, opIds: [op.opId] }), /Denied/);
  // "Apply all" never opens a square picker.
  hero.owners.add("pl");
  setUser(gm);
  await api.applyOps(msg.id);
  assert.notEqual(getResolution(msg).ops[op.opId].status, "applied");
  setUser(player);
  hero.owners.delete("pl");
  hero.owners.add("pl");
  setUser(gm);
  heroTok.document.x = 500;
  console.log("ok self-teleport by the owner (recorded, undo, too far, mismatch, bad payload, not owner)");
}

/* ---------- Combat Tools "choose one" picks ---------- */
/* ---------- Black Ash: automatic owner picker, optional Hide, confirmed surge, cascade undo ---------- */
{
  resetHeroes();
  const savedCanvas = globalThis.canvas;
  const savedDialog = foundry.applications?.api?.DialogV2;
  const savedModule = game.modules.get("draw-steel-combat-tools");
  const savedFilter = game.users.filter;
  const savedQuery = player.query;
  const savedObject = heroTok.document.object;
  let accept = true, eligible = true, cancelled = false, fakeSuccess = false;
  let picks = 0, attempts = 0, pickerUser = null, hideUser = null;
  const savedMovementMode = game.settings.get("stef-ds-automation", "forcedMovementMode");
  heroTok.id = heroTok.document.id;
  heroTok.document.object = heroTok;
  globalThis.canvas = { ...savedCanvas, scene: heroTok.document.parent };
  foundry.applications ??= {}; foundry.applications.api ??= {};
  foundry.applications.api.DialogV2 = { confirm: async () => accept };
  game.users.filter = fn => [gm, player].filter(fn);
  player.query = async (name, data) => {
    const sender = game.user;
    setUser(player);
    try { return await CONFIG.queries[name](data, { user: sender }); }
    finally { setUser(sender); }
  };
  const hidden = () => new Set(hero.effects.contents.find(e => e.statuses?.has?.("dsctHidden") || e.statuses?.includes?.("dsctHidden"))?.getFlag("draw-steel-combat-tools", "hiddenFrom") ?? []);
  const stealth = {
    isActive: () => true,
    proposeHide: (_token, opts) => eligible && opts.whileObserved ? [tA.document.id] : [],
    hiddenFrom: hidden,
    async runHide(_token, opts) {
      attempts++; hideUser = game.user.id;
      assert.equal(opts.whileObserved, true);
      if (!eligible) return [];
      if (!fakeSuccess) {
        const effect = new Effect({ _id: "blackashhidden01", flags: { "draw-steel-combat-tools": { hiddenFrom: [tA.document.id] } } }, hero);
        effect.statuses = new Set(["dsctHidden"]);
        effect.toObject = () => ({ _id: effect.id, statuses: ["dsctHidden"], flags: JSON.parse(JSON.stringify(effect.flags)) });
        hero.effects.set(effect.id, effect);
      }
      return [tA.document.id];
    },
  };
  game.modules.set("draw-steel-combat-tools", { active: true, api: {
    stealth,
    async teleport({ distance }) {
      picks++; pickerUser = game.user.id;
      assert.ok([5, 7].includes(distance));
      if (cancelled) return;
      const origin = { x: heroTok.document.x, y: heroTok.document.y, elevation: 0 };
      const destination = { x: origin.x + 400, y: origin.y, elevation: 0 };
      await heroTok.document.update(destination);
      Hooks.callAll("moveToken", heroTok.document, { origin, destination }, {}, game.user);
    },
  } });
  const item = ability({ name: "Black Ash Teleport", powerRoll: false, special: [{ id: "spend00000000000", type: "spend" }] });
  const newCard = async ({ playerAuthored = false, spend = 0 } = {}) => {
    heroTok.document.x = 500; heroTok.document.y = 500;
    const parts = { abilityUse000000: { _id: "abilityUse000000", type: "abilityUse", abilityUuid: item.uuid, effects: spend ? ["spend00000000000"] : [] } };
    const msg = new Message({ type: "standard", parts, speaker: { scene: "scene00000000001", token: heroTok.document.id } });
    const author = playerAuthored ? player : gm;
    setUser(author);
    Hooks.call("preCreateChatMessage", msg, {}, {}, author.id);
    msg.author = author; msg.timestamp = Date.now(); messages.set(msg.id, msg);
    setUser(gm);
    getResolution(msg).spend = [spend];
    await api.resolve(msg.id);
    item.flags = {};
    return msg;
  };
  const msg = await newCard({ playerAuthored: true });
  assert.equal(picks, 1);
  assert.equal(pickerUser, player.id, "automatic picker runs on the author's screen");
  assert.equal(hideUser, player.id, "Hide runs on that owner's screen");
  assert.equal(hero.system.hero.surges, 1);
  assert.deepEqual(opsOf(msg).map(o => [o.kind, o.status]), [["teleport", "applied"], ["hide", "applied"], ["resource", "applied"]]);
  const teleport = opsOf(msg).find(o => o.kind === "teleport");
  await Promise.all([api.applyOps(msg.id, [teleport.opId]), api.applyOps(msg.id, [teleport.opId])]);
  assert.equal(picks, 1); assert.equal(attempts, 1); assert.equal(hero.system.hero.surges, 1);
  await api.undoOps(msg.id, [teleport.opId]);
  assert.equal(hero.system.hero.surges, 0); assert.equal(hero.effects.size, 0); assert.equal(heroTok.document.x, 500);
  await api.applyOps(msg.id, [teleport.opId]);
  assert.equal(hero.system.hero.surges, 1, "reapply offers one new Hide and one reward");
  await api.undoOps(msg.id);
  accept = false;
  const declined = await newCard();
  assert.equal(opsOf(declined).find(o => o.kind === "hide").reason, "hideDeclined");
  assert.equal(hero.system.hero.surges, 0);
  accept = true; eligible = false;
  const noCover = await newCard();
  assert.equal(opsOf(noCover).find(o => o.kind === "hide").reason, "hideIneligible");
  assert.equal(hero.system.hero.surges, 0);
  eligible = true; fakeSuccess = true;
  await newCard();
  assert.equal(hero.system.hero.surges, 0, "a claimed success without actual hidden state grants nothing");
  fakeSuccess = false; cancelled = true;
  const beforeAttempts = attempts;
  const cancel = await newCard();
  assert.equal(opsOf(cancel).find(o => o.kind === "teleport").status, "pending");
  assert.equal(attempts, beforeAttempts, "cancelled teleport never offers Hide");
  assert.equal(hero.system.hero.surges, 0);
  cancelled = false;
  const retry = opsOf(cancel).find(o => o.kind === "teleport");
  await api.applyOps(cancel.id, [retry.opId]);
  assert.equal(hero.system.hero.surges, 1);
  const changed = hero.effects.get("blackashhidden01");
  changed.flags["draw-steel-combat-tools"].hiddenFrom.push(tB.document.id);
  heroTok.document.x += 100;
  await api.undoOps(cancel.id);
  assert.equal(hero.system.hero.surges, 0);
  assert.ok(hidden().has(tB.document.id), "Undo preserves subsequent hidden changes");
  assert.equal(heroTok.document.x, 1000, "Undo preserves subsequent movement");
  resetHeroes();
  stealth.isActive = () => false;
  const unavailable = await newCard();
  assert.equal(opsOf(unavailable).find(o => o.kind === "hide").reason, "hideUnavailable");
  assert.equal(hero.system.hero.surges, 0);
  stealth.isActive = () => true;
  const spent = await newCard({ spend: 2 });
  assert.equal(opsOf(spent).find(o => o.kind === "teleport").distance, 7);
  assert.equal(pickerUser, gm.id, "GM-authored ability uses the GM's picker");
  await api.undoOps(spent.id);
  set("forcedMovementMode", "manual");
  const beforeManual = picks;
  const manual = await newCard();
  assert.equal(picks, beforeManual, "manual mode does not open the picker on resolution");
  const manualTeleport = opsOf(manual).find(o => o.kind === "teleport");
  assert.equal(manualTeleport.mode, "manual");
  assert.equal(buildView(manual, getResolution(manual)).rows.flatMap(r => r.ops).find(o => o.kind === "hide").canApply, false);
  await api.applyOps(manual.id, [manualTeleport.opId]);
  assert.equal(hero.system.hero.surges, 1, "manual teleport still offers Hide and grants its success reward");
  await api.undoOps(manual.id);
  set("forcedMovementMode", savedMovementMode);
  set("resourceMode", "manual");
  const manualReward = await newCard();
  const reward = opsOf(manualReward).find(o => o.kind === "resource");
  assert.equal(reward.status, "pending"); assert.equal(hero.system.hero.surges, 0);
  await api.applyOps(manualReward.id, [reward.opId]);
  assert.equal(hero.system.hero.surges, 1);
  await api.undoOps(manualReward.id);
  set("resourceMode", "off");
  const offReward = await newCard();
  assert.ok(!opsOf(offReward).some(o => o.kind === "resource"));
  assert.equal(hero.system.hero.surges, 0);
  await api.undoOps(offReward.id);
  set("resourceMode", "auto");
  // An existing hidden relationship is restored rather than removed by Hide undo.
  const preexisting = new Effect({ _id: "blackashhidden01", flags: { "draw-steel-combat-tools": { hiddenFrom: [tB.document.id] } } }, hero);
  preexisting.statuses = new Set(["dsctHidden"]);
  preexisting.toObject = () => ({ _id: preexisting.id, statuses: ["dsctHidden"], flags: JSON.parse(JSON.stringify(preexisting.flags)) });
  hero.effects.set(preexisting.id, preexisting);
  const prior = await newCard();
  await api.undoOps(prior.id);
  assert.deepEqual([...hidden()], [tB.document.id], "pre-existing hidden relationships survive Undo");
  // Entry round-trip preserves all four opt-in fields.
  const overlay = lib.resolve(item).effects[0];
  const detached = entryToEffect(effectToEntries(overlay, "ability:black-ash-teleport")[0]);
  for (const field of ["autoStart", "hideAfter", "hideWhileObserved", "hideSurge"]) assert.equal(detached[field], overlay[field]);
  player.query = savedQuery; game.users.filter = savedFilter;
  if (savedModule) game.modules.set("draw-steel-combat-tools", savedModule); else game.modules.delete("draw-steel-combat-tools");
  foundry.applications.api.DialogV2 = savedDialog;
  globalThis.canvas = savedCanvas; heroTok.document.object = savedObject;
  resetHeroes(); setUser(gm);
  console.log("ok Black Ash owner picker, optional observed Hide, verified surge, retry, duplicate requests, cascade undo and changed state");
}

{
  resetHeroes();
  const applied = { tier2: { potency: { characteristic: "", value: "" }, effects: { slowed: { condition: "always", end: "save", properties: new Set() } } } };
  const item = ability({ name: "Choose Test", applied, special: [
    { id: "chooseFx00000001", type: "dsct.choose", choose: { count: 1, choices: [{ name: "Slow", effects: ["Effect"] }, { name: "Mend", effects: ["Mend them"] }] } },
  ] });
  lib.registerSource({ id: "t-choose", priority: 60, overlays: [{
    key: "ability:choose-test", version: "1.0.0", name: "Choose Test",
    effects: [{ id: "mend", type: "heal", name: "Mend them", targets: "self", value: 2 }],
  }] });
  const assign = chooseAssignment(item, { flags: { "draw-steel-combat-tools": { choosePicks: { chooseFx00000001: 1 } } } });
  assert.ok(assign.picked && effectShows("Mend them", assign) && !effectShows("Effect", assign) && effectShows("Other", assign));
  const pickMend = use(item, { 2: [tA] }, {}, { flags: { "draw-steel-combat-tools": { choosePicks: { chooseFx00000001: 1 } } } });
  await settle();
  assert.deepEqual(opsOf(pickMend).map(o => o.kind).sort(), ["heal"], "the unpicked applied effect is gone");
  assert.ok(!getResolution(pickMend).warnings.some(w => w.code === "dsctChoose"));
  const pickSlow = use(item, { 2: [tA] }, {}, { flags: { "draw-steel-combat-tools": { choosePicks: { chooseFx00000001: 0 } } } });
  await settle();
  assert.deepEqual(opsOf(pickSlow).map(o => o.kind).sort(), ["condition"]);
  const noPicks = use(item, { 2: [tA] });
  await settle();
  assert.ok(opsOf(noPicks).every(o => o.mode === "prompt"), "no picks on the card: everything waits");
  assert.ok(getResolution(noPicks).warnings.some(w => w.code === "dsctChoose"));
  console.log("ok Combat Tools choose picks (native and library effects filtered by name; no picks: prompt)");
}

/* ---------- native suppression ---------- */
{
  resetHeroes();
  const applied = { tier1: { potency: { characteristic: "", value: "" }, effects: { slowed: { condition: "always", end: "turn", properties: new Set() } } } };
  const item = ability({ name: "Claw Dirt", applied });
  item.system.power.effects.get("appPRE0000000001").id = "gwwGZVwMTP51E7sH";
  item.system.power.effects.set("gwwGZVwMTP51E7sH", item.system.power.effects.get("appPRE0000000001"));
  item.system.power.effects.delete("appPRE0000000001");
  const msg = use(item, { 1: [tA] });
  await settle();
  assert.ok(!gobA.statuses.has("slowed"), "the native effect on the target is replaced");
  assert.ok(hero.effects.get("slowed0000000000") && hero.effects.get("weakened00000000"), "slowed and weakened on the user");
  console.log("ok native suppression (Claw Dirt)");
}

/* ---------- adoption of an unseeded card ---------- */
{
  resetHeroes();
  const item = ability({ name: "To the Death!", damage: true });
  const parts = {
    abilityUse000000: { _id: "abilityUse000000", type: "abilityUse", abilityUuid: item.uuid, effects: [] },
    tier3Result00000: { _id: "tier3Result00000", type: "abilityResult", tier: 3, rolls: [new ds.rolls.PowerRoll(20, { target: gobA.uuid, tier: 3 }), new ds.rolls.DamageRoll(9, {})] },
  };
  const msg = new Message({ type: "standard", parts, speaker: { scene: "scene00000000001", token: "hero000000000tok" } });
  msg.author = player;
  msg.timestamp = Date.now();
  messages.set(msg.id, msg);
  Hooks.callAll("createChatMessage", msg, {}, "pl"); // nobody seeded it
  await settle();
  await settle();
  const res = getResolution(msg);
  assert.ok(res?.resolvedAt && res.adopted, "taken over and resolved");
  assert.ok(res.warnings.some(w => w.code === "adoptedCard"));
  assert.equal(gobA.system.stamina.value, 11, "target from the roll");
  assert.equal(hero.system.hero.surges, 2);
  const old = new Message({ type: "standard", parts, speaker: {} });
  old.timestamp = Date.now() - 120_000;
  messages.set(old.id, old);
  Hooks.callAll("createChatMessage", old, {}, "pl");
  await settle();
  assert.equal(getResolution(old), null, "old cards are never taken over");
  console.log("ok adoption of unseeded cards");
}

/* ---------- detached entries: conversion, actions, keeper ---------- */
{
  resetHeroes();
  const effect = { id: "push", type: "forced", movement: ["push", "pull"], distance: 2, byTier: { 3: { distance: 4 } }, tiers: [2, 3], potency: { characteristic: "might", value: "@potency.strong" } };
  const entries = effectToEntries(effect, "ability:x");
  assert.equal(entries.length, 2, "one entry per tier when it varies");
  assert.ok(entries.every(e => /^dsAuto[a-z0-9]{10}$/.test(e._id)) && entries[0]._id !== entries[1]._id);
  assert.equal(entryId("a", "b", 1), entryId("a", "b", 1), "deterministic ids");
  const back = entries.map(entryToEffect);
  assert.equal(entries[0].dsAuto.whenSpend, "", "either way, as a three-state field");
  assert.deepEqual(entryToEffect({ ...entries[0], dsAuto: { ...entries[0].dsAuto, whenSpend: "no" } }).when, { spend: false });
  assert.deepEqual([back[1].tiers, back[1].distance, back[1].movement], [[3], "4", ["push", "pull"]]);
  assert.deepEqual(back[0].potency, { characteristic: "might", value: "@potency.strong" });

  const item = ability({ name: "Layer O" });
  await lib.detach(item);
  let r = lib.resolve(item);
  assert.deepEqual([r.layer, r.status, r.effects.length, item.flags["stef-ds-automation"].overlay.version], ["detached", "customized", 1, "1.1.0"]);
  // A newer overlay makes it outdated; resync takes the new version.
  lib.registerSource({ id: "t-layers2", priority: 70, overlays: [{ key: "ability:layer-o", version: "1.2.0", name: "Layer O", effects: [{ id: "a", type: "resource", targets: "self", resource: "surge", value: 2 }] }] });
  assert.equal(lib.status(item), "outdated");
  await lib.resync(item);
  r = lib.resolve(item);
  assert.deepEqual([r.status, r.effects[0].value], ["customized", "2"]);
  // Keeper: Combat Tools' refresh deletes our entries along with a full system rewrite -> kept.
  const ids = Object.keys(item._source.system.effects);
  const refresh = { name: "Layer O", img: "x.png", system: { effects: Object.fromEntries(ids.map(id => [id, new ForcedDeletion()])), power: {}, keywords: [] } };
  onPreUpdateItem(item, refresh, {}, game.userId);
  assert.ok(ids.every(id => refresh.system.effects[id]?.type === "dsAuto.resource"), "ForcedDeletion swapped for our data");
  // Update from compendium: system replaced -> our entries added to the replacement.
  const replace = { system: foundry.data.operators.ForcedReplacement.create({ _dsid: "layer-o", power: { effects: {} }, effects: { before0000000000: { type: "base" } } }) };
  onPreUpdateItem(item, replace, {}, game.userId);
  const inner = foundry.data.operators.ForcedReplacement.get(replace.system);
  assert.ok(ids.every(id => inner.effects[id]?.type === "dsAuto.resource") && inner.effects.before0000000000, "entries added to the replacement");
  // A single entry deleted on the sheet stays deleted.
  const single = { system: { effects: { [ids[0]]: new ForcedDeletion() } } };
  onPreUpdateItem(item, single, {}, game.userId);
  assert.ok(single.system.effects[ids[0]] instanceof ForcedDeletion);
  // Locked: the keeper leaves it alone, actions refuse.
  item.flags["stef-ds-automation"].lock = true;
  const locked = { name: "x", system: { effects: { [ids[0]]: new ForcedDeletion() } } };
  onPreUpdateItem(item, locked, {}, game.userId);
  assert.ok(locked.system.effects[ids[0]] instanceof ForcedDeletion);
  await assert.rejects(lib.reset(item), /Locked/);
  item.flags["stef-ds-automation"].lock = false;
  await lib.reset(item);
  r = lib.resolve(item);
  assert.deepEqual([r.layer, Object.keys(item._source.system.effects).length], ["overlay", 0]);
  // Configure keeps only declared keys, typed.
  const c = ability({ name: "Layer C" });
  await lib.configure(c, { x: 1, junk: 5 });
  assert.deepEqual(c.flags["stef-ds-automation"].config, { x: true });
  console.log("ok detached entries (conversion, detach, outdated, resync, keeper, lock, reset, configure)");
}

/* ---------- until (the user's next turn), the user's Recovery for a target, forced properties ---------- */
{
  resetHeroes();
  world.setCombat({ id: "combat0000000001", started: true, combatant: null, getCombatantsByActor: a => [{ id: `cmb${a.name.replace(/\W/g, "")}`.padEnd(16, "0").slice(0, 16), initiative: 1 }] });
  lib.registerSource({ id: "t-new", priority: 60, overlays: [{
    key: "ability:new-test", version: "1.0.0", name: "New Test",
    effects: [
      { id: "guard", type: "condition", targets: "self", status: "weakened", until: "yourNextTurnStart" },
      { id: "mend", type: "heal", recoveries: 1, spender: "self", filter: "allies" },
      { id: "shove", type: "forced", movement: "push", distance: 2, filter: "enemies", properties: ["no-collision-damage"] },
    ],
  }] });
  const item = ability({ name: "New Test" });
  const msg = use(item, { 2: [tAlly, tA] });
  await settle();
  const weak = hero.effects.get("weakened00000000");
  assert.ok(weak, "weakened on the user");
  assert.deepEqual(weak.flags["stef-ds-automation"].until.map(s => s.event), ["turnStart"]);
  assert.equal(weak.duration.expiry, "dsAutoUntil", "only the user's next turn start ends it");
  const mend = opsOf(msg).find(o => o.libEffect === "mend");
  assert.deepEqual([mend.status, mend.amount], ["applied", 10], "the user's recovery value");
  assert.deepEqual([hero.system.recoveries.value, ally.system.recoveries.value, ally.system.stamina.value], [7, 8, 25], "the user paid, the ally healed");
  const shove = opsOf(msg).find(o => o.libEffect === "shove");
  assert.deepEqual(shove.properties, ["no-collision-damage"]);
  await api.undoOps(msg.id, [mend.opId]);
  assert.deepEqual([hero.system.recoveries.value, ally.system.stamina.value], [8, 15], "the Recovery goes back to the user");
  // Out of combat the condition just stays (no until).
  world.setCombat(null);
  const msg2 = use(item, { 2: [tA] });
  await settle();
  const again = hero.effects.get("weakened00000000");
  assert.ok(!again.flags?.["stef-ds-automation"]?.until && opsOf(msg2).find(o => o.libEffect === "guard").untilSet === null);
  // Combat Tools' tiered heal / teleport effects count as its own automation.
  game.modules.set("draw-steel-combat-tools", { active: true, api: {} });
  const d = ability({ name: "Layer D" });
  d.system.power.effects.set("dsctTier00000001", { id: "dsctTier00000001", type: "dsctTeleport" });
  assert.deepEqual(lib.resolve(d).dsctCovered, ["teleport"]);
  game.modules.delete("draw-steel-combat-tools");
  console.log("ok until (user's next turn), Recovery paid by the user, forced properties, Combat Tools tiered effects");
}

/* ---------- review findings (0.6.0) ---------- */
{
  resetHeroes();
  const { anythingApplied } = await imp("relay/auth.mjs");
  // 2. The user's own row does not count as targets or as something applied to them.
  const item = ability({ name: "To the Death!", damage: true });
  const msg = useNoRoll(item, []);
  await settle();
  const res = getResolution(msg);
  assert.ok(Object.values(res.targets).every(t => t.self), "only the user's own row");
  assert.equal(anythingApplied(res), false, "a surge gained by the user does not lock retargeting");
  // 3. Detached entries keep their choice groups without the library.
  const heal = ability({ name: "Heal", powerRoll: false });
  await lib.detach(heal);
  lib.unregisterSource("stef-ds-automation.library");
  const r = lib.resolve(heal);
  assert.deepEqual([r.layer, r.choices.map(g => g.id)], ["detached", ["help"]]);
  const m2 = useNoRoll(heal, [tAlly]);
  await settle();
  assert.ok(opsOf(m2).every(o => o.awaitingChoice), "rows still wait for the pick");
  // 5. Edit + Apply cannot skip the choice.
  const row = opsOf(m2).find(o => o.kind === "heal");
  await assert.rejects(api.editOp(m2.id, row.opId, { amount: 5 }, { apply: true }), /ChoiceFirst/);
  const shipped = (await import(pathToFileURL(LIBRARY + "dist/overlays.mjs").href)).default;
  lib.registerSource({ id: "stef-ds-automation.library", priority: 50, overlays: shipped });
  console.log("ok review findings (self row vs targets, detached choices, choice gate on edit)");
}

/* ---------- Milestone 9 (WP-A): modifiers, picks, area allies, teleport boosts, the five overlays ---------- */
{
  resetHeroes();
  const fs = await import("node:fs");
  const { registerPromptType } = await imp("relay/prompt-router.mjs");
  const { handleTargetPick, pickCandidates } = await imp("ui/target-pick.mjs");
  const { handleMovementChoice } = await imp("ui/movement-choice.mjs");
  const { recordPick } = await imp("engine/engine.mjs");
  const { noteArea } = await imp("engine/areas.mjs");
  const keyOf = t => t.document.uuid.replace(/\./g, "__");
  const until = async (fn, ms = 2_000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await settle(); return fn(); };
  // One scene with positions: the hero at 0, the ally 1 square away, Goblin A 3, Goblin B 15.
  const docs = [heroTok, tAlly, tA, tB].map(t => t.document);
  const saved = docs.map(d => ({ d, parent: d.parent, x: d.x, y: d.y, width: d.width, height: d.height, update: d.update }));
  const scene = { id: "scene00000000001", grid: { size: 100, distance: 5 }, tokens: docs, regions: [] };
  const at = (t, x) => Object.assign(t.document, { x, y: 0, width: 1, height: 1, elevation: 0, parent: scene });
  at(heroTok, 0); at(tAlly, 100); at(tA, 300); at(tB, 1500);
  for (const d of docs) d.update ??= async (data) => Object.assign(d, data);

  // D1: a modifier row (Weakening Brand): value from @chr, the creature's next turn end, undo; a bad key is refused.
  Effect.prototype.delete ??= async function() { this.parent.effects.delete(this.id); };   // as harness12
  const combatants = [{ id: "cmbGoblinA000009", actor: gobA }, { id: "cmbHero000000009", actor: hero }];
  world.setCombat({ id: "combat0000000009", started: true, round: 1, combatants, combatant: null, getCombatantsByActor: a => combatants.filter(c => c.actor === a) });
  lib.registerSource({ id: "t-m9", priority: 60, overlays: [
    { key: "ability:brand-test", version: "1.0.0", name: "Brand Test", effects: [
      { id: "weakness", type: "modifier", key: "system.damage.weaknesses.all", value: "@chr", mode: "add", end: "nextTurnEnd", label: "Weakness" }] },
    { key: "ability:pick-test", version: "1.0.0", name: "Pick Test", choices: [{ id: "mode", options: [{ id: "strike", label: "Strike" }, { id: "rest", label: "Rest" }] }],
      effects: [
        { id: "strike", type: "damage", value: "@R", targets: "pick", pick: { count: 1, within: 10, damageTypes: ["fire", "cold"] }, label: "Pick damage", choice: { group: "mode", option: "strike" } },
        { id: "rest", type: "note", text: "Rest.", choice: { group: "mode", option: "rest" } }] },
    { key: "ability:green-test", version: "1.0.0", name: "Green Test", effects: [
      { id: "slide", type: "forced", movement: "slide", distance: 2, targets: "pick", pick: { count: 1, within: 10, of: "target" }, label: "Slide" }] },
    { key: "ability:area-test", version: "1.0.0", name: "Area Test", effects: [
      { id: "self", type: "cleanse", targets: "self", ends: ["save", "turn"], count: 1 },
      { id: "allies", type: "cleanse", targets: "area", filter: "allies", ends: ["save", "turn"], count: 1 }] },
    { key: "ability:boost-test", version: "1.0.0", name: "Boost Test", effects: [
      { id: "tp", type: "teleport", targets: "self", distance: "@R", boost: { resource: "heroic", per: 1, label: "Extra" } }] },
  ] });
  assert.ok(!validateOverlay({ key: "ability:x", version: "1.0.0", name: "X", effects: [{ id: "m", type: "modifier", key: "system.stamina.value", value: 1 }] }).ok, "unsupported modifier key");
  assert.ok(!validateOverlay({ key: "ability:x", version: "1.0.0", name: "X", effects: [{ id: "p", type: "damage", value: 1, targets: "pick" }] }).ok, "a pick needs `pick`");
  assert.ok(!validateOverlay({ key: "ability:x", version: "1.0.0", name: "X", effects: [{ id: "p", type: "damage", value: 1, targets: "pick", filter: "enemies", pick: { within: 5 } }] }).ok, "a pick's side goes in pick.filter");
  assert.ok(!validateOverlay({ key: "ability:x", version: "1.0.0", name: "X", effects: [{ id: "t", type: "teleport", distance: 2, boost: { resource: "heroic" } }] }).ok, "a boost needs targets self");
  assert.ok(!validateOverlay({ key: "ability:x", version: "1.0.0", name: "X", effects: [{ id: "f", type: "forced", movement: "push", distance: 1, targets: "area" }] }).ok, "no forced move on the area");
  const brand = ability({ name: "Brand Test", damage: true });
  // The system's item roll data carries its actor's (and @chr, the roll characteristic).
  const heroData = item => Object.assign(item, { getRollData: () => ({ ...hero.getRollData() }) });
  heroData(brand);
  const bm = use(brand, { 2: [tA] }, { 2: [{ total: 5, options: {} }] });
  await settle();
  const mod = opsOf(bm).find(o => o.kind === "modifier");
  assert.deepEqual([mod.status, mod.value, mod.property, mod.featureEnd, mod.ruleId, mod.lib], ["applied", 3, "system.damage.weaknesses.all", "nextTurnEnd", "lib", true]);
  const ae = gobA.effects.get(mod.createdIds[0]);
  assert.deepEqual(ae.system.changes, [{ key: "system.damage.weaknesses.all", value: 3, type: "add", phase: "initial" }]);
  assert.equal(ae.flags["stef-ds-automation"].ruleEffect.end, "nextTurnEnd");
  assert.deepEqual(ae.flags["stef-ds-automation"].until.map(s => [s.event, s.combatantId]), [["turnEnd", "cmbGoblinA000009"]], "ends at the target's turn end");
  assert.match(buildView(bm, getResolution(bm)).rows.flatMap(r => r.ops).find(o => o.kind === "modifier").label, /ModifierRow/);
  const bm2 = use(brand, { 1: [tA] }, { 1: [{ total: 3, options: {} }] });
  await settle();
  const mod2 = opsOf(bm2).find(o => o.kind === "modifier");
  assert.equal(mod2.createdIds[0], mod.createdIds[0], "a second brand replaces the first (one effect per creature)");
  assert.ok(mod2.replaced);
  await api.undoOps(bm2.id, [mod2.opId]);
  assert.ok(gobA.effects.has(mod.createdIds[0]), "undo of the second brings the first back");
  await api.undoOps(bm.id, [mod.opId]);
  assert.ok(!gobA.effects.has(mod.createdIds[0]), "undo removes it");
  world.setCombat(null);
  resetHeroes();

  // D2: a pick placeholder waits for the choice, then the user's owner is asked once; the GM checks the answer.
  let pickAnswer = null;
  const pickCalls = [];
  registerPromptType("targetPick", async payload => { pickCalls.push(payload); return pickAnswer ?? { tokenUuids: [] }; });
  const picker = heroData(ability({ name: "Pick Test", powerRoll: false }));
  const pm = useNoRoll(picker, []);
  await settle();
  const ph = () => opsOf(pm).find(o => o.kind === "pick");
  assert.deepEqual([ph().status, ph().reason, ph().noApply, ph().awaitingChoice, ph().targetKeys[0]], ["pending", "pickTargets", true, true, keyOf(heroTok)]);
  assert.deepEqual(ph().pick, { effectId: "strike", effectType: "damage", count: 1, within: 10, of: "self", filter: null, damageTypes: ["fire", "cold"], anchorTokenUuid: heroTok.document.uuid });
  assert.equal(pickCalls.length, 0, "no prompt while the choice is open");
  await api.applyOps(pm.id);
  assert.equal(ph().status, "pending", "Apply all leaves the pick row");
  await requestOp({ action: "choose", messageId: pm.id, group: "mode", option: "strike" });
  await until(() => pickCalls.length === 1);
  assert.equal(pickCalls.length, 1, "asked once the option was picked");
  assert.deepEqual(pickCalls[0].candidates.map(c => c.tokenUuid).sort(), [tAlly.document.uuid, tA.document.uuid].sort(), "within 10, never the user");
  assert.deepEqual(pickCalls[0].damageTypes, ["fire", "cold"]);
  assert.ok(getResolution(pm).pickAsked?.[ph().opId], "offered once (a reload does not ask again)");
  let pv = buildView(pm, getResolution(pm)).rows.flatMap(r => r.ops).find(o => o.kind === "pick");
  assert.deepEqual([pv.pickButton, pv.applyAction, pv.canApply], [true, "dsAutoPick", true]);
  assert.match(pv.label, /PickTargets/);
  const pid = ph().opId;
  for (const bad of [{ tokenUuids: [tB.document.uuid], damageType: "fire" }, { tokenUuids: [tA.document.uuid, tAlly.document.uuid], damageType: "fire" },
    { tokenUuids: [tA.document.uuid], damageType: "holy" }, { tokenUuids: [tA.document.uuid] }, { tokenUuids: [heroTok.document.uuid], damageType: "fire" },
    { tokenUuids: [tA.document.uuid, tA.document.uuid], damageType: "fire" }]) {
    await assert.rejects(recordPick(messages.get(pm.id), pid, bad), /PickRefused/, JSON.stringify(bad));
  }
  assert.equal(getResolution(pm).picks, undefined, "nothing written for a refused pick");
  // The user's owner (a player below the role floor) picks through the relay.
  setUser(player);
  await assert.rejects(requestOp({ action: "pick", messageId: pm.id, opId: pid, tokenUuids: [tA.document.uuid], damageType: "FIRE" }), /BadRequest/);
  await requestOp({ action: "pick", messageId: pm.id, opId: pid, tokenUuids: [tA.document.uuid], damageType: "fire" });
  setUser(gm);
  let res = getResolution(pm);
  assert.deepEqual([res.picks.strike.tokenUuids, res.picks.strike.damageType, res.picks.strike.by], [[tA.document.uuid], "fire", player.id]);
  const rec = res.targets[keyOf(tA)];
  assert.deepEqual([rec.pickOnly, rec.picked, rec.pickDamageTypes], [true, ["strike"], { strike: "fire" }]);
  const hit = opsOf(pm).find(o => o.kind === "damage");
  assert.deepEqual([hit.targetKeys[0], hit.type, hit.amount, hit.status], [keyOf(tA), "fire", 3, "applied"], "a fire row for the picked creature");
  assert.equal(gobA.system.stamina.value, 19, "3 fire - immunity 2");
  assert.ok(!ph(), "the placeholder is gone");
  await api.resolve(pm.id, { force: true });
  assert.equal(pickCalls.length, 1, "a re-resolve does not ask again");
  assert.ok(opsOf(pm).some(o => o.kind === "damage" && o.targetKeys[0] === keyOf(tA)), "the pick survives a re-resolve");
  hero.owners.delete("pl");
  const pm2 = useNoRoll(picker, []);
  await settle();
  await requestOp({ action: "choose", messageId: pm2.id, group: "mode", option: "strike" });
  await until(() => pickCalls.length === 2);
  setUser(player);
  await assert.rejects(requestOp({ action: "pick", messageId: pm2.id, opId: opsOf(pm2).find(o => o.kind === "pick").opId, tokenUuids: [tA.document.uuid], damageType: "fire" }), /Denied/, "not the user's owner");
  setUser(gm);
  hero.owners.add("pl");
  // The owner's prompt answers: a cold row for the ally.
  pickAnswer = { tokenUuids: [tAlly.document.uuid], damageType: "cold" };
  const pm3 = useNoRoll(picker, []);
  await settle();
  await requestOp({ action: "choose", messageId: pm3.id, group: "mode", option: "strike" });
  await until(() => opsOf(pm3).some(o => o.kind === "damage"));
  const cold = opsOf(pm3).find(o => o.kind === "damage");
  assert.deepEqual([cold.targetKeys[0], cold.type], [keyOf(tAlly), "cold"]);
  await api.undoOps(pm.id);
  await api.undoOps(pm3.id);
  // 0.15.0: the option picked in the Use Ability dialog (ui/use-choice.mjs) is seeded; the card resolves with it.
  const { choiceGroupsFor, _test: useChoice } = await imp("ui/use-choice.mjs");
  const { noteChoices, takeChoices } = await imp("engine/use-choices.mjs");
  assert.deepEqual(choiceGroupsFor(picker), [{ id: "mode", label: "", options: [{ id: "strike", label: "Strike" }, { id: "rest", label: "Rest" }] }]);
  assert.deepEqual(choiceGroupsFor(heroData(ability({ name: "Boost Test", powerRoll: false }))), [], "no groups, no radios");
  // The dialog's close: a cancelled dialog (no config) and an incomplete pick note nothing.
  const dialog = (config, picks) => ({ config, options: { ability: picker, context: { dsAutoChoices: picks } } });
  useChoice.onClose(dialog(null, { mode: "rest" }));
  assert.equal(takeChoices(picker.uuid), null, "cancelled: nothing noted");
  useChoice.onClose(dialog({ rolls: [] }, {}));
  assert.equal(takeChoices(picker.uuid), null, "no pick: nothing noted");
  useChoice.onClose(dialog({ rolls: [] }, { mode: "rest" }));
  const pd = useNoRoll(picker, []);
  await settle();
  let pres = getResolution(pd);
  assert.deepEqual([pres.choices.mode.picked, pres.choices.mode.by], ["rest", gm.id], "the dialog's pick and who made it");
  const pdPick = opsOf(pd).find(o => o.kind === "pick");
  assert.deepEqual([pdPick?.status, pdPick?.reason, !!pdPick?.awaitingChoice], ["skipped", "notChosen", false], "the other option's rows are skipped");
  assert.ok(buildView(pd, pres).choices[0].options.find(o => o.id === "rest").picked, "the card shows the pick");
  // Still changeable on the card until a row of the group is applied.
  await requestOp({ action: "choose", messageId: pd.id, group: "mode", option: "strike" });
  assert.equal(getResolution(pd).choices.mode.picked, "strike");
  await until(() => pickCalls.length === 4);
  // Taken once: the next use starts blank; a pick noted for another ability is not used.
  const pd2 = useNoRoll(picker, []);
  await settle();
  assert.ok(!getResolution(pd2).choices.mode.picked && opsOf(pd2).every(o => o.awaitingChoice), "no pick: the card asks as before");
  noteChoices("Actor.other.Item.other", { mode: "rest" });
  const pd3 = useNoRoll(picker, []);
  await settle();
  assert.ok(!getResolution(pd3).choices.mode.picked, "another ability's pick is ignored");
  // An unknown option is dropped by the resolve; bad ids by the take.
  noteChoices(picker.uuid, { mode: "nope" });
  const pd4 = useNoRoll(picker, []);
  await settle();
  assert.ok(!getResolution(pd4).choices.mode.picked, "an option the group lacks is not kept");
  noteChoices(picker.uuid, { mode: "x".repeat(41) });
  assert.equal(takeChoices(picker.uuid), null);
  // The dialog's seeded pick of the pick option: the owner is asked at once, as after a card click.
  useChoice.onClose(dialog({ rolls: [] }, { mode: "strike" }));
  const pd5 = useNoRoll(picker, []);
  await until(() => pickCalls.length === 5);
  assert.equal(getResolution(pd5).choices.mode.picked, "strike");
  for (const m of [pd, pd5]) await api.undoOps(m.id);
  console.log("ok use-dialog choice");
  // The Green Within case: measured from the target; the target itself picked keeps its tier.
  pickAnswer = { tokenUuids: [tA.document.uuid] };
  const green = ability({ name: "Green Test", damage: true });
  const gm1 = use(green, { 2: [tA] }, { 2: [{ total: 4, options: {} }] });
  await until(() => opsOf(gm1).some(o => o.kind === "forced"));
  const slide = opsOf(gm1).find(o => o.kind === "forced");
  const gres = getResolution(gm1);
  assert.deepEqual([slide.targetKeys, slide.tier, gres.targets[keyOf(tA)].tier, gres.targets[keyOf(tA)].picked, !!gres.targets[keyOf(tA)].pickOnly],
    [[keyOf(tA)], 2, 2, ["slide"], false], "the picked target keeps tier 2");
  const anchorOp = { kind: "pick", pick: { anchorTokenUuid: tA.document.uuid, within: 10, of: "target" } };
  assert.deepEqual(pickCandidates(anchorOp, gres).map(c => c.tokenUuid).sort(), [tAlly.document.uuid, tA.document.uuid].sort(), "within 10 of the target");
  await api.undoOps(gm1.id);
  registerPromptType("targetPick", handleTargetPick);

  // D3: the creatures inside the area: seeded by the author's client, else the card's template, else a banner.
  resetHeroes();
  const area = ability({ name: "Area Test", powerRoll: false });
  area.system.distance = { type: "cube", primary: "3", secondary: "10" };
  const region = { id: "regionM9area0001", parent: scene, shapes: [{ type: "rectangle" }], flags: { "draw-steel": { abilitySource: area.uuid } }, _stats: { createdTime: Date.now() } };
  const inside = new Set([tAlly.document.id, tA.document.id, heroTok.document.id]);
  for (const d of docs) d.testInsideRegion = r => r === region && inside.has(d.id);
  const addSave = (a, id) => a.createEmbeddedDocuments("ActiveEffect", [{ _id: id, name: "Dazed", statuses: ["dazed"], duration: { expiry: "save" } }]);
  await addSave(ally, "allyDazed0000009");
  await addSave(hero, "heroDazed0000009");
  await addSave(gobA, "gobDazed00000009");
  noteArea(area, region);
  const am = useNoRoll(area, []);
  await settle();
  let ares = getResolution(am);
  assert.deepEqual([...ares.area.tokenUuids].sort(), [heroTok.document.uuid, tAlly.document.uuid, tA.document.uuid].sort(), "seeded by the author");
  assert.deepEqual([ares.targets[keyOf(tAlly)]?.area, !!ares.targets[keyOf(tAlly)]?.alsoTarget], [true, false]);
  assert.ok(!ares.targets[keyOf(tA)], "an enemy in the area gets nothing (filter allies): not shown");
  const allyRow = opsOf(am).find(o => o.libEffect === "allies");
  assert.deepEqual([allyRow.targetKeys[0], allyRow.status], [keyOf(tAlly), "applied"]);
  assert.ok(!ally.effects.has("allyDazed0000009") && !hero.effects.has("heroDazed0000009") && gobA.effects.has("gobDazed00000009"));
  assert.ok(!(ares.warnings ?? []).some(w => w.code === "areaNotFound"));
  await api.undoOps(am.id);
  // No seed: the card's own template on the user's scene.
  scene.regions = [region];
  const am2 = useNoRoll(area, []);
  await settle();
  assert.equal(getResolution(am2).area, null, "nothing seeded this time");
  assert.equal(opsOf(am2).find(o => o.libEffect === "allies")?.targetKeys[0], keyOf(tAlly), "found from the template");
  await api.undoOps(am2.id);
  // Neither: the allies get nothing and the card says so.
  scene.regions = [];
  const am3 = useNoRoll(area, []);
  await settle();
  assert.ok(!opsOf(am3).some(o => o.libEffect === "allies"));
  assert.ok(getResolution(am3).warnings.some(w => w.code === "areaNotFound"));
  assert.ok(buildView(am3, getResolution(am3)).banners.some(b => /areaNotFound/.test(b.text)), "banner");
  await api.undoOps(am3.id);
  for (const d of docs) delete d.testInsideRegion;

  // D6: a self teleport with an essence boost (the fallback picker's number input): +2 squares, -2 charged, undone together.
  resetHeroes();
  let mcAnswer = null;
  let mcPayload = null;
  registerPromptType("movementChoice", async payload => { mcPayload = payload; return mcAnswer; });
  const booster = heroData(ability({ name: "Boost Test", powerRoll: false }));
  mcAnswer = { destination: { x: 500, y: 0 }, path: [], boost: 2 };
  const tm = useNoRoll(booster, []);
  await until(() => opsOf(tm).find(o => o.kind === "teleport")?.status === "applied");
  const tp = opsOf(tm).find(o => o.kind === "teleport");
  assert.deepEqual(mcPayload.boost, { max: 3, per: 1, label: "Extra", name: "DSAUTO.Entry.Resource.heroic" }, "the dialog offers up to the hero's 3");
  assert.deepEqual([tp.status, tp.distance, tp.boostSpent], ["applied", 3, { resource: "heroic", amount: 2 }]);
  assert.equal(heroTok.document.x, 500, "3 + 2 squares");
  const pay = getResolution(tm).ops[`${tp.opId}-boost`];
  assert.deepEqual([pay.kind, pay.amount, pay.status, pay.boostOf, pay.noApply], ["resource", -2, "applied", tp.opId, true]);
  assert.equal(hero.system.hero.primary.value, 1);
  assert.match(buildView(tm, getResolution(tm)).rows.flatMap(r => r.ops).find(o => o.kind === "teleport").detail, /TeleportBoosted/);
  await api.undoOps(tm.id, [tp.opId]);
  assert.deepEqual([heroTok.document.x, hero.system.hero.primary.value, getResolution(tm).ops[pay.opId].status], [0, 3, "undone"], "the payment goes back with the teleport");
  // Over budget: the boost counts as 0, so 5 squares is too far.
  mcAnswer = { destination: { x: 500, y: 0 }, path: [], boost: 5 };
  const tm2 = useNoRoll(booster, []);
  await until(() => ["failed", "applied", "skipped"].includes(opsOf(tm2).find(o => o.kind === "teleport")?.status));
  const tp2 = opsOf(tm2).find(o => o.kind === "teleport");
  assert.deepEqual([tp2.status, tp2.reason, heroTok.document.x, hero.system.hero.primary.value], ["failed", "badDestination", 0, 3]);
  assert.ok(!getResolution(tm2).ops[`${tp2.opId}-boost`], "nothing charged");
  registerPromptType("movementChoice", handleMovementChoice);

  // The five overlays of the library validate (the shipped count is the integration's).
  for (const f of ["kits/weakening-brand", "censor/my-life-for-yours", "elementalist/practical-magic", "elementalist/the-green-within-the-green-without", "elementalist/test-of-rain"]) {
    const o = JSON.parse(fs.readFileSync(`${LIBRARY}src/overlays/${f}.json`, "utf8"));
    const v = validateOverlay(o);
    assert.ok(v.ok, `${f}: ${v.errors.join("; ")}`);
  }
  // Detached entries round-trip the new fields.
  const pickEntry = effectToEntries(lib.resolve(picker).effects.find(e => e.id === "strike"), "ability:pick-test")[0];
  assert.deepEqual(entryToEffect(pickEntry).pick, { count: 1, within: "10", of: "self", damageTypes: ["fire", "cold"] });
  const boostEntry = effectToEntries(lib.resolve(booster).effects[0], "ability:boost-test")[0];
  assert.deepEqual(entryToEffect(boostEntry).boost, { resource: "heroic", per: 1 });
  const modEntry = effectToEntries(lib.resolve(brand).effects[0], "ability:brand-test")[0];
  assert.deepEqual(Object.fromEntries(["key", "value", "mode", "end"].map(k => [k, entryToEffect(modEntry)[k]])), { key: "system.damage.weaknesses.all", value: "@chr", mode: "add", end: "nextTurnEnd" });
  lib.unregisterSource("t-m9");
  for (const s of saved) Object.assign(s.d, { parent: s.parent, x: s.x, y: s.y, width: s.width, height: s.height });
  resetHeroes();
  console.log("ok M9 WP-A: modifier rows, picks (choice, prompt once, GM check, relay, re-resolve, Green Within), area allies (seed / template / banner), teleport boost, overlays, entries");
}

api.selfCheck();
console.log("\nALL HARNESS-7 TESTS PASSED");
