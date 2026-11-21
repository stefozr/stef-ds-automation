// 1.2.2 (harness32): Combat Tools copies that move a spend into a pick (My Life for Yours asks the spend itself) and picks that
// name overlay choices (Practical Magic plans its Damage row without a rolled tier). Plain system copies stay as they were.
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

function use(item, byTier, dmg = {}, { shown = [], flags = {} } = {}) {
  const extraParts = { abilityUse000000: { _id: "abilityUse000000", type: "abilityUse", abilityUuid: item.uuid, effects: shown } };
  const msg = postAbility(item, byTier, dmg, { extraParts });
  Object.assign(msg.flags, flags);
  return msg;
}
const DSCT = "draw-steel-combat-tools";
/** A card without a power roll, with Combat Tools' picks stamped before the card resolves. */
function useNoRoll(item, targets = [], { shown = [], picks = null } = {}) {
  const parts = { abilityUse000000: { _id: "abilityUse000000", type: "abilityUse", abilityUuid: item.uuid, effects: shown } };
  const msg = new Message({ type: "standard", parts, speaker: { scene: "scene00000000001", token: "hero000000000tok" } });
  if (picks) msg.flags[DSCT] = { choosePicks: picks };
  gm.targets = new Set(targets);
  Hooks.call("preCreateChatMessage", msg, {}, {}, gm.id);
  msg.author = gm;
  msg.timestamp = Date.now();
  messages.set(msg.id, msg);
  Hooks.callAll("createChatMessage", msg, {}, "x");
  return msg;
}

const fs = await import("node:fs");
const overlay = name => JSON.parse(fs.readFileSync(new URL(`../src/overlays/${name}`, import.meta.url), "utf8"));
const pmFile = fs.readdirSync(new URL("../src/overlays", import.meta.url)).flatMap(d => (fs.existsSync(new URL(`../src/overlays/${d}/practical-magic.json`, import.meta.url)) ? [`${d}/practical-magic.json`] : []))[0];
const registered = lib.registerSource({ id: "t-h32", priority: 60, overlays: [overlay("censor/my-life-for-yours.json"), overlay(pmFile)] });
assert.ok(!registered.errors?.length, JSON.stringify(registered));
game.modules.set(DSCT, { active: true, api: {} });
const keyOf = t => t.document.uuid.replace(/\./g, "__");

const flatCleanse = (id, name, status, expiry) => ({ id, type: "dsct.flatCleanse", name, flatCleanse: { expiryFilter: expiry, statusFilter: status, spend: { enabled: true, value: 1 } } });
function mlfy({ system = false } = {}) {
  return ability({ name: "My Life for Yours", powerRoll: false, special: system
    ? [{ id: "spend00000000000", type: "spend", resource: { value: 1, multiple: false } }]
    : [
      { id: "spend00000000000", type: "base", name: "Spend" },
      { id: "dsctFlatHeal0001", type: "dsct.flatHeal", name: "", flatHeal: { spend: { enabled: false, value: 1 } } },
      flatCleanse("dsctFlatCleanse1", "Cleanse", [], ["turnEnd", "save"]),
      flatCleanse("dsctFlatStandUp1", "Stand Up", ["prone"], []),
      { id: "dsctChoose000001", type: "dsct.choose", name: "", choose: { count: 1, choices: [{ name: "Cleanse", effects: ["Cleanse"] }, { name: "Stand Up", effects: ["Stand Up"] }] } },
    ] });
}
const PICK = { dsctChoose000001: 1 }, PICK_CLEANSE = { dsctChoose000001: 0 };
const prone = { _id: "allyProne0000001", name: "Prone", statuses: ["prone"], duration: {} };
const bleed = { _id: "allyBleed0000001", name: "Bleeding", statuses: ["bleeding"], duration: { expiry: "save" } };
const cleanseOf = msg => opsOf(msg).find(o => o.kind === "cleanse");
const wrath = () => hero.system.hero.primary.value;

/* ---------- Stand Up: a waiting row, pay + stand up, undo refunds ---------- */
{
  resetHeroes();
  await ally.createEmbeddedDocuments("ActiveEffect", [prone, bleed]);
  const msg = useNoRoll(mlfy(), [tAlly], { picks: PICK });
  await settle();
  const c = cleanseOf(msg);
  assert.deepEqual([c.status, c.mode, c.statuses, c.ends, c.spendCost.amount, c.spendCost.resource], ["pending", "prompt", ["prone"], [], 1, "heroic"], "waits, narrowed to prone");
  assert.equal(wrath(), 3, "nothing charged silently");
  assert.ok(opsOf(msg).some(o => o.kind === "heal" && o.status === "applied"), "the heal still applies");
  assert.ok(ally.effects.has(prone._id));
  await api.applyOps(msg.id);
  assert.equal(wrath(), 3, "Apply all does not pay");
  assert.ok(buildView(msg, getResolution(msg)).rows.flatMap(r => r.ops).find(o => o.kind === "cleanse").spendButton, "the row names the spend");
  await api.applyOps(msg.id, [c.opId]);
  assert.equal(wrath(), 2, "one Wrath paid");
  assert.ok(!ally.effects.has(prone._id) && ally.effects.has(bleed._id), "prone ended, the save effect stays");
  assert.equal(cleanseOf(msg).status, "applied");
  await api.undoOps(msg.id, [c.opId]);
  assert.equal(wrath(), 3, "undo refunds");
  assert.ok(ally.effects.has(prone._id), "prone is back");
  console.log("ok MLFY Stand Up: waiting row, pay, narrowed end, undo refund");
}

/* ---------- Cleanse pick: save / end of turn only ---------- */
{
  resetHeroes();
  await ally.createEmbeddedDocuments("ActiveEffect", [prone, bleed]);
  const msg = useNoRoll(mlfy(), [tAlly], { picks: PICK_CLEANSE });
  await settle();
  const c = cleanseOf(msg);
  assert.deepEqual([c.statuses, c.ends, c.status, c.candidates], [[], ["save", "turn"], "pending", 1], "Cleanse narrows to save / end of turn");
  await api.applyOps(msg.id, [c.opId]);
  assert.ok(!ally.effects.has(bleed._id) && ally.effects.has(prone._id), "only the save effect ended");
  assert.equal(wrath(), 2);
  console.log("ok MLFY Cleanse pick narrows");
}

/* ---------- nothing to end: no row to pay; short on Wrath ---------- */
{
  resetHeroes();
  const msg = useNoRoll(mlfy(), [tAlly], { picks: PICK });
  await settle();
  const c = cleanseOf(msg);
  assert.deepEqual([c.status, c.reason, c.spendCost], ["skipped", "nothingToEnd", undefined], "nothing prone: skipped, no spend offered");
  resetHeroes();
  await ally.createEmbeddedDocuments("ActiveEffect", [prone]);
  hero.system.hero.primary.value = 0;
  const short = useNoRoll(mlfy(), [tAlly], { picks: PICK });
  await settle();
  assert.deepEqual([cleanseOf(short).status, cleanseOf(short).reason], ["skipped", "notEnoughResource"]);
  await api.applyOps(short.id, [cleanseOf(short).opId]);
  assert.ok(ally.effects.has(prone._id) && wrath() === 0, "a short apply pays and ends nothing");
  console.log("ok MLFY nothing to end, not enough Wrath");
}

/* ---------- the damage trigger already paid ---------- */
{
  resetHeroes();
  await ally.createEmbeddedDocuments("ActiveEffect", [prone]);
  const item = mlfy();
  const trig = new Message({ type: "standard", parts: {} });
  trig.flags["stef-ds-automation"] = { resolution: { shape: "trigger", trigger: { itemUuid: item.uuid, spend: true, spendCost: 1, spendByUse: false }, ops: { r: { triggerSpend: true, status: "applied" } }, targets: {}, choices: {} } };
  trig.timestamp = Date.now() - 1000;
  messages.set(trig.id, trig);
  const msg = useNoRoll(item, [tAlly], { picks: PICK });
  await settle();
  const c = cleanseOf(msg);
  assert.ok(!c.spendCost && c.status === "applied", "applied without asking");
  assert.equal(wrath(), 3, "not charged twice");
  assert.ok(!ally.effects.has(prone._id));
  console.log("ok MLFY trigger-paid use applies without asking");
}

/* ---------- plain system copy unchanged ---------- */
{
  resetHeroes();
  await ally.createEmbeddedDocuments("ActiveEffect", [prone]);
  const item = mlfy({ system: true });
  const off = useNoRoll(item, [tAlly]);
  await settle();
  assert.ok(!cleanseOf(off), "no spend ticked: no cleanse row");
  const on = useNoRoll(item, [tAlly], { shown: ["spend00000000000"] });
  await settle();
  const c = cleanseOf(on);
  assert.ok(c && !c.spendCost, "the system's spend box carries the spend");
  assert.deepEqual(c.statuses, ["prone"]);
  assert.deepEqual(c.ends, ["save", "turn"]);
  console.log("ok plain system copy unchanged");
}

/* ---------- Practical Magic: Damage pick plans the damage row without a rolled tier ---------- */
{
  resetHeroes();
  const item = ability({ name: "Practical Magic", powerRoll: true, special: [
    { id: "C9ikI7guJqg94kaG", type: "dsct.choose", name: "", choose: { count: 1, choices: [
      { name: "Knockback", effects: ["Knockback"] }, { name: "Damage", effects: ["Damage"] }, { name: "Teleport", effects: ["Teleport"] }] } },
  ] });
  item.getRollData = () => ({ ...hero.getRollData() });
  const dmg = useNoRoll(item, [tA], { picks: { C9ikI7guJqg94kaG: 1 } });
  await settle();
  const ops = opsOf(dmg);
  const pk = ops.find(o => o.kind === "pick");
  assert.ok(pk && pk.status === "pending" && !pk.awaitingChoice, "the Damage pick plans its pick row");
  const tp = ops.find(o => o.libEffect === "teleport");
  assert.deepEqual([tp.status, tp.reason], ["skipped", "notChosen"]);
  const { recordPick } = await imp("engine/engine.mjs");
  const docs = [heroTok, tA].map(t => t.document);
  const scene = { id: "scene00000000001", grid: { size: 100, distance: 5 }, tokens: docs, regions: [] };
  Object.assign(heroTok.document, { x: 0, y: 0, width: 1, height: 1, elevation: 0, parent: scene });
  Object.assign(tA.document, { x: 300, y: 0, width: 1, height: 1, elevation: 0, parent: scene });
  await recordPick(messages.get(dmg.id), pk.opId, { tokenUuids: [tA.document.uuid], damageType: "fire" });
  const hit = opsOf(dmg).find(o => o.kind === "damage");
  assert.deepEqual([hit.targetKeys[0], hit.type, hit.amount], [keyOf(tA), "fire", 3], "damage to the picked creature");
  const tele = useNoRoll(item, [], { picks: { C9ikI7guJqg94kaG: 2 } });
  await settle();
  const t2 = opsOf(tele).find(o => o.libEffect === "teleport");
  assert.ok(t2 && t2.reason !== "notChosen", "the Teleport pick keeps the teleport row");
  console.log("ok Practical Magic Damage / Teleport picks plan their rows");
}

/* ---------- Practical Magic: Combat Tools' target and damage type answer the pick ---------- */
{
  const flatDamage = { id: "dsctFlatDmg0001", type: "dsct.flatDamage", name: "Damage", flatDamage: {} };
  const pmItem = () => {
    const item = ability({ name: "Practical Magic", powerRoll: true, special: [
      { id: "C9ikI7guJqg94kaG", type: "dsct.choose", name: "", choose: { count: 1, choices: [
        { name: "Knockback", effects: ["Knockback"] }, { name: "Damage", effects: ["Damage"] }, { name: "Teleport", effects: ["Teleport"] }] } },
      flatDamage,
    ] });
    item.getRollData = () => ({ ...hero.getRollData() });
    return item;
  };
  const scene = { id: "scene00000000001", grid: { size: 100, distance: 5 }, tokens: [heroTok, tA].map(t => t.document), regions: [] };
  const place = x => {
    Object.assign(heroTok.document, { x: 0, y: 0, width: 1, height: 1, elevation: 0, parent: scene });
    Object.assign(tA.document, { x, y: 0, width: 1, height: 1, elevation: 0, parent: scene });
  };
  const card = (flags, picks = { C9ikI7guJqg94kaG: 1 }) => {
    resetHeroes();
    const msg = useNoRoll(pmItem(), [], { picks });
    Object.assign(msg.flags[DSCT], flags);
    return msg;
  };
  const resolveAgain = async msg => { await api.resolve?.(msg.id, { force: true }); await settle(); };
  const state = msg => ({ pick: opsOf(msg).find(o => o.kind === "pick"), hit: opsOf(msg).find(o => o.kind === "damage") });

  // In range, type chosen: answered, damage planned on the chosen creature.
  place(300);
  let msg = card({ useTargets: [tA.document.uuid], flatDmgTypes: { [flatDamage.id]: "acid" } });
  await resolveAgain(msg);
  let st = state(msg);
  assert.ok(!st.pick || st.pick.status !== "pending", "the pick is answered");
  assert.deepEqual([st.hit?.targetKeys[0], st.hit?.type], [keyOf(tA), "acid"], "damage on Combat Tools' target, its type");
  const recorded = Object.values(getResolution(msg).picks ?? {});
  assert.equal(recorded.length, 1);
  assert.deepEqual([recorded[0].tokenUuids, recorded[0].damageType], [[tA.document.uuid], "acid"]);

  // Out of range: stays waiting.
  place(1200);
  msg = card({ useTargets: [tA.document.uuid], flatDmgTypes: { [flatDamage.id]: "acid" } });
  await resolveAgain(msg);
  st = state(msg);
  assert.equal(st.pick?.status, "pending", "out of range: the pick waits");
  assert.ok(!st.hit);

  // No damage type, an unknown type, no target, no Combat Tools flags: stays waiting.
  place(300);
  for (const flags of [{ useTargets: [tA.document.uuid] }, { useTargets: [tA.document.uuid], flatDmgTypes: { [flatDamage.id]: "plasma" } },
    { flatDmgTypes: { [flatDamage.id]: "acid" } }, {}]) {
    msg = card(flags);
    await resolveAgain(msg);
    assert.equal(state(msg).pick?.status, "pending", `waits for ${JSON.stringify(flags)}`);
  }
  console.log("ok Practical Magic: Combat Tools' target and damage type answer the pick");
}
