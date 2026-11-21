/**
 * 1.2.2: the house-rule hero-token reroll (scripts/resources/hero-token-reroll.mjs) works on Draw Steel 1.2 cards with
 * targets (one `targetResult` part per target) as well as on tier-part cards: the button is allowed, every target part
 * keeps its id / target / token and gets its own new tier and rebuilt damage, the applied rows are undone and rebuilt
 * from the new tiers, one token is spent, and a squad's minion count survives into the new damage roll.
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const paths = createRequire(import.meta.url)("./paths.cjs");
const imp = p => import(pathToFileURL(paths.SCRIPTS + p).href);
globalThis.__HARNESS_SKIP_SCENARIOS__ = true;
const w = await import("./harness.mjs");
const { rerollPowerRoll, heroRerollAllowed, heroRerollShown, rerolledParts, cardRolls, registerHeroTokenSpend, REROLL_SPEND } = await imp("resources/hero-token-reroll.mjs");
const { getResolution } = await imp("engine/record.mjs");
const MOD = "stef-ds-automation";
const { PowerRoll, DamageRoll } = ds.rolls;

// Mock rolls: a queue of tiers for the next evaluations; a clone keeps options and shares the 2d10 term.
const tierQueue = [];
PowerRoll.prototype.clone = function() { const r = new this.constructor(this.total, { ...this.options }); r.terms = [{ dice: "2d10" }]; return r; };
PowerRoll.prototype.evaluate = async function() { this.options.tier = tierQueue.length ? tierQueue.shift() : this.options.tier; this.total = 10; return this; };
DamageRoll.prototype.evaluate = async function() { return this; };
const spends = [];
game.actors ??= {};
game.actors.heroTokens = { value: 3, async spendToken(type, options) { spends.push([type, options.messageId]); this.value -= 1; }, async giveToken(n) { this.value += n; } };
ds.CONFIG.hero ??= { tokenSpends: {} };
registerHeroTokenSpend();
w.setUser(w.users.gm);
game.settings.set(MOD, "heroTokenRerollPowerRolls", true);
game.settings.set(MOD, "modeDamageNpc", "auto");

const damageCalls = [];
function ability(uuid, name) {
  const item = w.makeAbility({ uuid, name, actor: w.hero });
  item.system.power.effects.documentsByType = { damage: [{ toDamageRoll: (tier, options) => { damageCalls.push({ tier, ...options }); return new DamageRoll(tier * 3, { type: "fire" }); } }] };
  return item;
}

/** The mock message stores roll objects: read back the JSON this module writes into them, as the system's schema would. */
function rebuildOnUpdate(card) {
  const mockUpdate = card.update.bind(card);
  card.updateOptions = [];
  card.update = async (changes, options) => {
    const out = {};
    for (const [k, v] of Object.entries(changes)) {
      if (v instanceof foundry.data.operators.ForcedDeletion) { delete card._srcParts[k.split(".").at(-1)]; continue; }
      if (k.startsWith("system.parts.") && Array.isArray(v?.rolls)) {
        out[k] = { ...v, rolls: v.rolls.map(s => { const d = JSON.parse(s); return d.options?.tier != null ? new PowerRoll(d.total, d.options) : new DamageRoll(d.total, d.options); }) };
      } else out[k] = v;
    }
    card.updateOptions.push(options);
    return mockUpdate(out, options);
  };
}

/**
 * A Draw Steel 1.2 card: one targetResult part per target (power roll + damage roll), created through the harness's own
 * create sequence. `game.user.targets` is what the seed reads, so the GM's target set is pinned to the card's targets.
 */
function postTargetCard(item, targets) {
  const fixed = new Set(targets.map(t => t.tok));
  Object.defineProperty(w.gm, "targets", { configurable: true, get: () => fixed, set() {} });
  const extraParts = Object.fromEntries(targets.map(t => [t.id, {
    _id: t.id, type: "targetResult", tier: t.tier, abilityUuid: item.uuid, targetUuid: t.tok.actor.uuid, tokenUuid: t.tok.document.uuid,
    potencies: t.potencies ?? {},
    rolls: [new PowerRoll(10, { tier: t.tier, appliedModifier: t.mod ?? 0 }), new DamageRoll(t.tier * 3, { type: "fire" })],
  }]));
  const card = w.postAbility(item, {}, {}, { extraParts });
  rebuildOnUpdate(card);
  return card;
}
const settle = () => new Promise(r => setTimeout(r, 50));
const stamina = actor => actor.system.stamina.value;

/* ---------- (a) a targetResult card: allowed, shape, rolls read ---------- */
const strike = ability("Actor.hero000000000001.Item.targetReroll0001", "Target Reroll");
const PA = "partA0000000000", PB = "partB0000000000";
const card = postTargetCard(strike, [{ id: PA, tok: w.tA, tier: 1, mod: 1, potencies: { dmgPRE0000000001: 1 } }, { id: PB, tok: w.tB, tier: 3 }]);
await settle();
let res = getResolution(card);
assert.ok(res?.resolvedAt, "the card resolved");
assert.equal(res.shape, "targetResult");
assert.equal(stamina(w.gobA), 20 - 1, "tier 1: 3 fire minus 2 immunity applied");
assert.equal(stamina(w.gobB), 20 - 9, "tier 3: 9 applied");
const read = cardRolls(card);
assert.equal(read.shape, "targetResult");
assert.equal(read.power.length, 2); assert.equal(read.damage.length, 2);
assert.deepEqual([...read.targetOf.values()], [w.gobA.uuid, w.gobB.uuid], "targets come from the parts' targetUuid");
assert.equal(heroRerollAllowed(card, res, w.users.gm), true, "targetResult card: allowed");
assert.equal(heroRerollShown(card, res, w.users.gm), true, "targetResult card: button shown");
game.settings.set(MOD, "heroTokenRerollPowerRolls", false);
assert.equal(heroRerollAllowed(card, res, w.users.gm), false, "setting off");
game.settings.set(MOD, "heroTokenRerollPowerRolls", true);
const gmAuthor = card.author;
card.author = w.users.player;
assert.equal(heroRerollAllowed(card, res, w.users.player), true, "the hero's owner who used it");
card.author = gmAuthor;
console.log("ok targetResult card: shape, rolls, allowed and shown");

/* ---------- (b) the parts alone ---------- */
{
  tierQueue.push(2, 3);
  damageCalls.length = 0;
  const preview = await rerolledParts(card, strike, res);
  assert.deepEqual(preview.tiers, { [w.gobA.uuid]: 2, [w.gobB.uuid]: 3 }, "per-target tiers keyed by the target actor");
  assert.deepEqual(Object.keys(preview.update).sort(), [`system.parts.${PA}`, `system.parts.${PB}`], "both parts kept, none deleted");
  const a = preview.update[`system.parts.${PA}`];
  assert.equal(a._id, PA); assert.equal(a.type, "targetResult"); assert.equal(a.tier, 2);
  assert.equal(a.targetUuid, w.gobA.uuid); assert.equal(a.tokenUuid, w.tA.document.uuid);
  assert.ok(!("potencies" in a), "manual potencies are left alone (merged, no potency re-plan)");
  assert.equal(a.rolls.length, 2, "power roll + rebuilt damage");
  assert.equal(JSON.parse(a.rolls[0]).options.appliedModifier, 1, "the target's own modifier survives");
  assert.deepEqual(damageCalls.map(c => c.tier), [2, 3], "damage rebuilt per part for its new tier");
  assert.equal(damageCalls[0].damageSelection, "fire");
  console.log("ok rerolledParts on a targetResult card");
}

/* ---------- (c) applied -> undo -> reroll -> rebuild, one token ---------- */
{
  const before = game.actors.heroTokens.value;
  tierQueue.push(2, 3);
  const out = await rerollPowerRoll(card, { user: w.users.gm });
  assert.deepEqual(out, { ok: true, tiers: { [w.gobA.uuid]: 2, [w.gobB.uuid]: 3 } });
  assert.deepEqual(spends, [[REROLL_SPEND, card.id]]); assert.equal(game.actors.heroTokens.value, before - 1, "one token spent");
  assert.equal(card.flags[MOD].heroRerolls, 1);
  assert.ok(card.updateOptions.some(o => o?.[MOD]?.heroReroll === true), "the part update carries heroReroll");
  assert.deepEqual(card.system.parts.contents.filter(p => p.type === "targetResult").map(p => p.id).sort(), [PA, PB], "same part ids");
  assert.deepEqual(card.system.parts.get(PA).potencies, { dmgPRE0000000001: 1 }, "potencies kept");
  res = getResolution(card);
  const dmg = Object.values(res.ops).filter(o => o.kind === "damage");
  assert.equal(dmg.length, 2, "rows rebuilt, none left as undone history");
  assert.ok(dmg.every(o => o.status === "applied"), "rebuilt rows applied again (auto mode)");
  assert.deepEqual(dmg.map(o => [o.partId, o.tier, o.amount]).sort(), [[PA, 2, 6], [PB, 3, 9]]);
  assert.equal(stamina(w.gobA), 20 - 4, "tier 2: 6 fire minus 2 immunity; the first hit was undone");
  assert.equal(stamina(w.gobB), 20 - 9, "B undone, then hit again once");
  assert.equal(Object.values(res.ops).filter(o => o.status === "undone").length, 0);
  console.log("ok applied -> undo -> reroll -> rebuilt rows, ids kept, one token");
}

/* ---------- (d) a squad's minion count survives ---------- */
{
  const squadStrike = ability("Actor.hero000000000001.Item.squadReroll00001", "Squad Reroll");
  const c = postTargetCard(squadStrike, [{ id: PA, tok: w.tA, tier: 2 }]);
  await settle();
  // DS drops `minions` from the options after the use; the count lives in the damage roll's data.
  c.system.parts.get(PA).rolls.find(r => r instanceof DamageRoll).data = { squadMinions: 2 };
  damageCalls.length = 0;
  await rerolledParts(c, squadStrike, getResolution(c));
  assert.equal(damageCalls[0].squadMinions, 3, "squadMinions = data.squadMinions + 1, as AbilityModel#use passed it");
  const plain = postTargetCard(strike, [{ id: PB, tok: w.tB, tier: 1 }]);
  await settle();
  damageCalls.length = 0;
  await rerolledParts(plain, strike, getResolution(plain));
  assert.ok(!("squadMinions" in damageCalls[0]), "no squad, no option");
  console.log("ok squad minions carried into the rebuilt damage");
}

/* ---------- (e) tier parts cards are unchanged ---------- */
{
  const tp = ability("Actor.hero000000000001.Item.tierReroll000001", "Tier Reroll");
  const t = w.postAbility(tp, { 1: [w.tA] }, { 1: [{ total: 3, options: { type: "fire" } }] });
  await settle();
  const r = getResolution(t);
  assert.equal(cardRolls(t).shape, "tierParts");
  assert.equal(heroRerollAllowed(t, r, w.users.gm), true);
  tierQueue.push(3);
  const preview = await rerolledParts(t, tp, r);
  assert.deepEqual(preview.tiers, { [w.gobA.uuid]: 3 });
  assert.ok(preview.update["system.parts.tier3Result00000"]);
  assert.ok(preview.update["system.parts.tier1Result00000"] instanceof foundry.data.operators.ForcedDeletion, "the old tier part is removed");
  console.log("ok tier-part card unchanged");
}

/* ---------- (f) a 1.2 build without token uuids is refused ---------- */
{
  const { compat } = await imp("compat/version-gate.mjs");
  const saved = compat.targetTokenUuid;
  compat.targetTokenUuid = false;
  assert.equal(cardRolls(card), null, "unknown shape: no reroll");
  compat.targetTokenUuid = saved;
  console.log("ok unknown shape refused");
}
game.settings.set(MOD, "heroTokenRerollPowerRolls", false);
console.log("ALL HARNESS-30 TESTS PASSED");
