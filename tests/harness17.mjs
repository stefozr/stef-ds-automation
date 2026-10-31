// Harness 17 (1.1.0): reactive power rolls. Each target rolls a test; Target Damage records the tier on the ability
// card (state.reactiveResults); the resolve tiers that target's native rows from it (engine/reactive.mjs).
// Reuses harness.mjs's mock world by importing it with a flag that skips its own scenarios.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

globalThis.__HARNESS_SKIP_SCENARIOS__ = true;
const world = await import(new URL("./harness.mjs", import.meta.url).href);
const { postAbility, settle, makeAbility, hero, tA, tB, gobA, gobB, api, getResolution, buildView, setDstd, Message, messages } = world;
const paths = createRequire(import.meta.url)("./paths.cjs"); const ROOT = paths.SCRIPTS;
const { lockedBy } = await import(pathToFileURL(ROOT + "ui/test-card-lock.mjs").href);

/** A reactive ability: damage 7 / 5 / 3 corruption, slowed (EoT) on tier 1. */
function reactiveAbility(uuid) {
  const applied = {
    tier1: { potency: { characteristic: "none", value: "" }, effects: { slowed: { condition: "always", end: "turn", properties: new Set() } } },
    tier2: { potency: { characteristic: "none", value: "" }, effects: {} },
    tier3: { potency: { characteristic: "none", value: "" }, effects: {} },
  };
  const item = makeAbility({ uuid, name: "Corpse Candles", actor: hero, damage: true, applied });
  const values = { 1: 7, 2: 5, 3: 3 };
  const dmg = item.system.power.effects.get("dmgPRE0000000001");
  dmg.toDamageRoll = (tier) => {
    const roll = { total: values[tier], type: "corruption", ignoredImmunities: [], aoe: true, isHeal: false, formula: String(values[tier]) };
    roll.evaluate = async () => roll;
    return roll;
  };
  item.system.power.effects.documentsByType = { damage: [dmg] };
  item.system.power.roll = { reactive: true, enabled: false, characteristics: ["presence"] };
  return item;
}

let rolledAt = 1000;
const result = (token, tier, total, rollMessageId) => ({
  target: { tokenUuid: token.document.uuid, name: token.name }, characteristic: "presence", tier, total, rollMessageId, rolledAt: ++rolledAt,
});
const keyOf = token => token.document.uuid.replace(/\./g, "__");
const opsOf = (msg, token) => Object.values(getResolution(msg).ops ?? {}).filter(o => o.targetKeys?.includes(keyOf(token)));
async function dstd(msg, state) {
  await msg.update({ "flags.draw-steel-target-damage.state": { isReactive: true, targets: [], reactiveResults: {}, applications: {}, ...state } });
  for (let i = 0; i < 4; i++) await settle();
}

/* ---------- targets wait, results build rows, a reroll re-tiers, undo ---------- */
{
  setDstd(true);
  const startA = gobA.system.stamina.value, startB = gobB.system.stamina.value;
  const item = reactiveAbility("Actor.hero000000000001.Item.reactive00000001");
  const msg = postAbility(item, {}, {});
  await settle();
  let res = getResolution(msg);
  assert.ok(res.resolvedAt, "the card resolves at once");
  assert.ok(res.reactive?.signature, "a reactive record");
  assert.equal(res.noPowerRoll, false, "a reactive card is not 'no power roll'");

  // Target Damage lists the area's targets: both wait for their tests, no rows, no "no tier" warning.
  const targets = [{ tokenUuid: tA.document.uuid }, { tokenUuid: tB.document.uuid }];
  await dstd(msg, { targets });
  res = getResolution(msg);
  assert.equal(Object.keys(res.targets).length, 2, "both area targets on the card");
  assert.ok(Object.values(res.targets).every(t => t.awaitingTest), "both wait for their tests");
  assert.equal(Object.keys(res.ops ?? {}).length, 0, "no rows yet");
  assert.ok(!(res.warnings ?? []).some(w => w.code === "noTier"), "no 'no tier' warning");
  const view = buildView(msg, res);
  assert.ok(view.rows.every(r => r.tierLabel === "DSAUTO.Card.AwaitingTest"), "rows say they wait");

  // Goblin A rolls tier 1: 7 corruption + slowed, applied automatically.
  await dstd(msg, { targets, reactiveResults: { "reactive-reactive-presence-a": result(tA, 1, 5, "testA1") } });
  res = getResolution(msg);
  assert.equal(res.targets[keyOf(tA)].tier, 1);
  assert.equal(res.targets[keyOf(tA)].partId, "reactive");
  assert.ok(res.targets[keyOf(tB)].awaitingTest, "Goblin B still waits");
  const a1 = opsOf(msg, tA);
  const dmgA = a1.find(o => o.kind === "damage");
  assert.equal(dmgA?.amount, 7, "tier 1 damage from the effect's tier value");
  assert.equal(dmgA.reactive, true);
  assert.equal(dmgA.status, "applied");
  assert.equal(gobA.system.stamina.value, startA - 7, "Goblin A took 7");
  assert.ok(a1.some(o => o.kind === "condition" && o.status === "applied"), "slowed applied");
  assert.ok(gobA.statuses.has("slowed"));
  assert.ok(buildView(msg, res).rows.find(r => r.key === keyOf(tA)).tierLabel.startsWith("DSAUTO.Card.TestTier"), "row shows the test tier");

  // The test card of Goblin A is locked; an unrelated test card is not.
  const test = new Message({ type: "standard", parts: { test000000000000: { _id: "test000000000000", type: "test", resultSource: item.uuid, rolls: [] } } });
  test.id = "testA1"; messages.set(test.id, test);
  assert.equal(lockedBy(test)?.id, msg.id, "Goblin A's test card is locked by the ability card");
  const other = new Message({ type: "standard", parts: { test000000000000: { _id: "test000000000000", type: "test", resultSource: item.uuid, rolls: [] } } });
  messages.set(other.id, other);
  assert.equal(lockedBy(other), null, "a test card with no result on any card is not locked");

  // Goblin B rolls tier 3: 3 corruption; Goblin A's rows are untouched.
  const resultsAB = { "reactive-reactive-presence-a": result(tA, 1, 5, "testA1"), "reactive-reactive-presence-b": result(tB, 3, 18, "testB1") };
  await dstd(msg, { targets, reactiveResults: resultsAB });
  assert.equal(gobB.system.stamina.value, startB - 3, "Goblin B took 3");
  assert.equal(gobA.system.stamina.value, startA - 7, "Goblin A unchanged by B's result");
  assert.equal(opsOf(msg, tA).filter(o => o.status === "applied").length, 2, "A's applied rows stay");

  // Goblin A rerolls (hero token on the test card): tier 2. Old rows are undone, the tier 2 row applies.
  const reroll = { ...resultsAB, "reactive-reactive-presence-a": { ...result(tA, 2, 13, "testA1"), rerolledAt: ++rolledAt } };
  await dstd(msg, { targets, reactiveResults: reroll });
  res = getResolution(msg);
  assert.equal(res.targets[keyOf(tA)].tier, 2, "re-tiered");
  assert.equal(gobA.system.stamina.value, startA - 5, "the reroll replaced 7 with 5");
  const slowRow = opsOf(msg, tA).find(o => o.kind === "condition");
  assert.equal(slowRow, undefined, "tier 1's slowed row was undone and left the card (tier 2 has none)");
  assert.ok(!gobA.effects.find(e => e.statuses?.includes?.("slowed")), "the slowed effect is gone");
  const dmgA2 = opsOf(msg, tA).find(o => o.kind === "damage");
  assert.equal(dmgA2.amount, 5);
  assert.equal(dmgA2.status, "applied");
  assert.equal(gobB.system.stamina.value, startB - 3, "Goblin B untouched by A's reroll");

  // The same state written again (Target Damage rewrites the whole state) changes nothing.
  const before = JSON.stringify(getResolution(msg).ops);
  await dstd(msg, { targets, reactiveResults: reroll, updatedAt: 5 });
  assert.equal(JSON.stringify(getResolution(msg).ops), before, "an unchanged result does not re-resolve");

  // Undo everything.
  await api.undoOps(msg.id);
  assert.equal(gobA.system.stamina.value, startA);
  assert.equal(gobB.system.stamina.value, startB);
  messages.delete(test.id); messages.delete(other.id);
  console.log("ok reactive: waiting targets, tiered rows, reroll, test-card lock, undo");
}

/* ---------- a result for a creature outside the target list joins the card ---------- */
{
  const startB = gobB.system.stamina.value;
  const item = reactiveAbility("Actor.hero000000000001.Item.reactive00000002");
  const msg = postAbility(item, {}, {});
  await settle();
  await dstd(msg, { targets: [{ tokenUuid: tA.document.uuid }], reactiveResults: { r: result(tB, 2, 14, "testB2") } });
  const res = getResolution(msg);
  assert.equal(res.targets[keyOf(tB)]?.tier, 2, "the tested creature joins");
  assert.ok(res.targets[keyOf(tA)].awaitingTest);
  assert.equal(gobB.system.stamina.value, startB - 5);
  await api.undoOps(msg.id);
  assert.equal(gobB.system.stamina.value, startB);
  console.log("ok reactive: a tested creature outside the list joins");
}

/* ---------- a Hero Token reroll on the test card (Target Damage's record keeps the old tier) ---------- */
{
  const startA = gobA.system.stamina.value;
  const item = reactiveAbility("Actor.hero000000000001.Item.reactive00000004");
  const msg = postAbility(item, {}, {});
  await settle();
  const PowerRoll = globalThis.ds.rolls.PowerRoll;
  const test = new Message({ type: "standard", parts: { test000000000000: { _id: "test000000000000", type: "test", resultSource: item.uuid, rolls: [new PowerRoll(3, { tier: 1 })] } } });
  test.id = "testA4"; messages.set(test.id, test);
  const results = { r: result(tA, 1, 3, "testA4") };
  await dstd(msg, { targets: [{ tokenUuid: tA.document.uuid }], reactiveResults: results });
  assert.equal(gobA.system.stamina.value, startA - 7, "tier 1 applied");
  // The reroll appends to the test part; Target Damage only stamps rerolledAt (its sync reads message.rolls).
  await test.update({ "system.parts.test000000000000": { rolls: [new PowerRoll(3, { tier: 1 }), new PowerRoll(21, { tier: 3 })] } });
  for (let i = 0; i < 4; i++) await settle();
  const res = getResolution(msg);
  assert.equal(res.targets[keyOf(tA)].tier, 3, "the test card's latest roll wins");
  assert.equal(res.targets[keyOf(tA)].reactive.total, 21);
  assert.equal(gobA.system.stamina.value, startA - 3, "7 undone, 3 applied");
  // A reroll to the same tier with another total keeps the applied rows (label only).
  const applied = JSON.stringify(opsOf(msg, tA).map(o => [o.opId, o.status]));
  await test.update({ "system.parts.test000000000000": { rolls: [new PowerRoll(3, { tier: 1 }), new PowerRoll(21, { tier: 3 }), new PowerRoll(19, { tier: 3 })] } });
  for (let i = 0; i < 4; i++) await settle();
  assert.equal(getResolution(msg).targets[keyOf(tA)].reactive.total, 19, "total refreshed");
  assert.equal(JSON.stringify(opsOf(msg, tA).map(o => [o.opId, o.status])), applied, "rows untouched");
  assert.equal(gobA.system.stamina.value, startA - 3);
  await api.undoOps(msg.id);
  assert.equal(gobA.system.stamina.value, startA);
  messages.delete(test.id);
  console.log("ok reactive: Hero Token reroll read from the test card");
}

/* ---------- Combat Tools 1.2.8 frightened (static id, source as a change, no flag) is recognised ---------- */
{
  const { Effect, setCombat } = world;
  setCombat({ getCombatantsByActor: () => [] });
  let made = 0;
  const dsctApi = {
    async applyFrightened(targetToken, sourceActor) {
      const a = targetToken.actor;
      a.effects.delete("frightened000000");
      const e = new Effect({ _id: "frightened000000", name: `Frightened [${sourceActor.name}]`, _stats: { createdTime: 5000 + ++made },
        system: { changes: [{ key: "system.statuses.frightened.sources", type: "add", value: sourceActor.uuid }] } }, a);
      e.statuses = new Set(["frightened"]);
      a.effects.set(e.id, e);
      a.statuses.add("frightened");
      return e;
    },
    async applyTaunted() {},
  };
  game.modules.set("draw-steel-combat-tools", { active: true, api: dsctApi });
  game.settings.register("draw-steel-combat-tools", "conditionsEnabled", { default: true });
  game.settings.register("draw-steel-combat-tools", "frightenedEnabled", { default: true });
  const fear = {
    tier1: { potency: { characteristic: "none", value: "" }, effects: { frightened: { condition: "always", end: "save", properties: new Set() } } },
    tier2: { potency: { characteristic: "none", value: "" }, effects: {} },
    tier3: { potency: { characteristic: "none", value: "" }, effects: {} },
  };
  const item = makeAbility({ uuid: "Actor.hero000000000001.Item.fear128000000001", name: "Fear", actor: hero, damage: false, applied: fear });
  for (const round of [1, 2]) { // the second use replaces the first (same static id, new creation time)
    const msg = postAbility(item, { 1: [tA] }, {});
    await settle(); await settle();
    const op = Object.values(getResolution(msg).ops).find(o => o.kind === "condition");
    assert.equal(op.status, "applied", `round ${round}: delegated frightened applied (${op.reason ?? ""})`);
    assert.equal(op.delegated, "dsct-frightened");
  }
  game.modules.delete("draw-steel-combat-tools");
  setCombat(null);
  console.log("ok Combat Tools 1.2.8 frightened delegation");
}

/* ---------- setting off: the old behaviour (no power roll, no rows) ---------- */
{
  await game.settings.set("stef-ds-automation", "reactiveTests", false);
  const startA = gobA.system.stamina.value;
  const item = reactiveAbility("Actor.hero000000000001.Item.reactive00000003");
  const msg = postAbility(item, {}, {});
  await settle();
  await dstd(msg, { targets: [{ tokenUuid: tA.document.uuid }], reactiveResults: { r: result(tA, 1, 3, "testA3") } });
  const res = getResolution(msg);
  assert.ok(!res.reactive, "no reactive record");
  assert.equal(Object.keys(res.ops ?? {}).length, 0, "no rows");
  assert.equal(gobA.system.stamina.value, startA, "nothing applied");
  await game.settings.set("stef-ds-automation", "reactiveTests", true);
  setDstd(false);
  console.log("ok reactive: setting off");
}

console.log("ALL HARNESS17 TESTS PASSED");
