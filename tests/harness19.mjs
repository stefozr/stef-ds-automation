/**
 * 1.2.0 (docs: DRAW-STEEL-120-PLAN.md steps 1a + 1b): the Automation box is THE apply / undo surface on Draw Steel 1.2.
 * - the veto of `ds.preApplyTargetResult` / relayed `ctlib.preApplyTargetResult` (compat/target-result-veto.mjs);
 * - the per-part lock of pending rows and ctlib's "Apply All Damage" (ui/part-lock.mjs);
 * - ctlib's journal as "applied elsewhere" (engine externalPatch / reconcileExternal);
 * - Target Damage standing down on targetResult cards and the self-check row.
 * Runs on the 1.1.x mock card of harness.mjs (partId tier1Result00000, damage roll index 1); a card's `targetResult`
 * nature is mocked where it matters (an extra part, `ds.CONFIG.MessagePart.targetResult`).
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const paths = createRequire(import.meta.url)("./paths.cjs");
const imp = p => import(pathToFileURL(paths.SCRIPTS + p).href);
globalThis.__HARNESS_SKIP_SCENARIOS__ = true;
const { makeAbility, postAbility, settle, hero, tA, api, getResolution, setDstd, messages, Message } = await import("./harness.mjs");
const veto = await imp("compat/target-result-veto.mjs");
const lock = await imp("ui/part-lock.mjs");
const ctlibMod = await imp("compat/ctlib.mjs");
const { dstdOnCard, isTargetResultCard } = await imp("compat/dstd.mjs");
const { wantsFold } = await imp("ui/dstd-fold.mjs");

const MOD = "stef-ds-automation";
const CTLIB = "draw-steel-ctlib";
const P = "tier1Result00000";
const set = (k, v) => game.settings.set(MOD, k, v);
globalThis.ui.notifications.warn = m => warns.push(m);
const warns = [];

let n = 0;
async function card(extraParts = {}) {
  const item = makeAbility({ uuid: `Actor.hero000000000001.Item.veto${String(++n).padStart(10, "0")}`, name: `Veto${n}`, actor: hero });
  const msg = postAbility(item, { 1: [tA] }, { 1: [{ total: 3, options: {} }] }, { extraParts });
  return msg;
}
/** The part as the system's hook receives it: id, message, rolls (the damage roll is index 1). */
const partOf = (msg, id = P) => {
  const src = msg.system.parts.get(P);
  return { id, message: msg, rolls: Array.from(src?.rolls ?? []) };
};
const preDamage = (msg, id = P) => {
  const part = partOf(msg, id);
  return Hooks.call("ds.preApplyTargetResult", part, "applyDamage", { roll: part.rolls[1], targets: [] });
};
const opId = msg => Object.keys(getResolution(msg).ops)[0];

/* ---------- the veto matrix ---------- */
{
  await set("damageMode", "auto");
  const msg = await card();
  await settle();
  assert.equal(getResolution(msg).ops[opId(msg)].status, "applied");
  warns.length = 0;
  assert.equal(preDamage(msg), false, "applied row: vetoed");
  assert.deepEqual(warns, ["DSAUTO.Lock.PartOwned"], "with the 'use the Automation box' warning");
  assert.equal(preDamage(msg, "otherPart0000000"), true, "another part: free");
  // a roll index the op does not cover
  const part = partOf(msg);
  assert.equal(Hooks.call("ds.preApplyTargetResult", part, "applyDamage", { roll: part.rolls[0] }), true, "roll index 0 is no damage row of ours");
  assert.equal(Hooks.call("ds.preApplyTargetResult", part, "applyDamage", { roll: {} }), true, "unknown roll: free");

  // relay path (a player's click on a ctlib relay): vetoed only when relay is true
  warns.length = 0;
  assert.equal(Hooks.call("ctlib.preApplyTargetResult", part, "applyDamage", { targets: [], relay: true }), false, "relayed click vetoed");
  assert.equal(warns.length, 1);
  assert.equal(Hooks.call("ctlib.preApplyTargetResult", part, "applyDamage", { targets: [], roll: part.rolls[1] }), true, "non-relay ctlib call is ignored (the ds hook decided)");
  assert.equal(Hooks.call("ctlib.preApplyTargetResult", partOf(msg, "otherPart0000000"), "applyDamage", { relay: true }), true, "relay, another part");

  // undone: free
  await api.undoOps(msg.id);
  assert.equal(preDamage(msg), true, "undone row: free");

  // pending (manual mode): the Automation box still waits to apply it
  await set("damageMode", "manual");
  const m2 = await card();
  await settle();
  assert.equal(getResolution(m2).ops[opId(m2)].status, "pending");
  assert.equal(preDamage(m2), false, "pending row: vetoed");
  await set("damageMode", "auto");

  // external (applied elsewhere): free
  const m3 = await card();
  await settle();
  await api.undoOps(m3.id);
  await m3.update({ [`flags.${CTLIB}.journal`]: { j1: { id: "j1", partId: P, action: "applyDamage", index: 1, undone: false } } });
  game.modules.set(CTLIB, { active: true, version: "2.0.0" });
  await m3.update({ [`flags.${CTLIB}.journal.j1.at`]: 1 });
  await settle();
  assert.equal(getResolution(m3).ops[opId(m3)].status, "external");
  assert.equal(preDamage(m3), true, "external row: free");

  // no record: free
  const bare = new Message({ type: "standard", parts: { x: { _id: "x", type: "abilityUse" } } });
  assert.equal(Hooks.call("ds.preApplyTargetResult", { id: P, message: bare, rolls: [1, 2] }, "applyDamage", { roll: 2 }), true, "no record");
  assert.equal(Hooks.call("ds.preApplyTargetResult", { id: P, message: null, rolls: [] }, "applyDamage", {}), true, "no message");

  // suite disabled: free
  await set("damageMode", "auto");
  const m4 = await card();
  await settle();
  assert.equal(preDamage(m4), false);
  await set("enabled", false);
  assert.equal(preDamage(m4), true, "suite disabled: never vetoed");
  await set("enabled", true);

  // integrity not ok: free
  const rec = m4.flags[MOD].resolution;
  const savedAmount = rec.ops[Object.keys(rec.ops)[0]].amount;
  rec.ops[Object.keys(rec.ops)[0]].amount = 999;
  assert.equal(preDamage(m4), true, "tampered record: not trusted");
  rec.ops[Object.keys(rec.ops)[0]].amount = savedAmount;
  assert.equal(preDamage(m4), false, "restored record is trusted again");
  console.log("ok veto matrix (applied, pending, undone, external, other part, no record, disabled, tampered, relay)");
}

/* ---------- opCoversButton: condition, resource, squad ---------- */
{
  const c = { kind: "condition", partId: "p1", effectId: "slowed", preId: "PRE1" };
  assert.ok(lock.opCoversButton(c, "p1", "applyEffect", { effectId: "slowed", uuid: "Actor.a.Item.b.PowerRollEffect.PRE1" }));
  assert.ok(!lock.opCoversButton(c, "p1", "applyEffect", { effectId: "dazed", uuid: "Actor.a.Item.b.PowerRollEffect.PRE1" }), "other effect");
  assert.ok(!lock.opCoversButton(c, "p1", "applyEffect", { effectId: "slowed", uuid: "x.PRE2" }), "other PRE");
  assert.ok(!lock.opCoversButton(c, "p2", "applyEffect", { effectId: "slowed", uuid: "x.PRE1" }), "other part");
  assert.ok(!lock.opCoversButton({ ...c, lib: true }, "p1", "applyEffect", {}), "library rows are not the system's");
  const r = { kind: "resource", native: true, partId: "p1", preId: "G1" };
  assert.ok(lock.opCoversButton(r, "p1", "gainResource", { uuid: "a.G1" }));
  assert.ok(!lock.opCoversButton({ ...r, native: false }, "p1", "gainResource", { uuid: "a.G1" }));
  const sq = { kind: "damage", partId: "p1", rollIndex: 1, parts: [{ partId: "p1", rollIndex: 1 }, { partId: "p2", rollIndex: 1 }] };
  assert.ok(lock.opCoversButton(sq, "p2", "applyDamage", { index: 1 }), "squad op covers every member's part");
  assert.ok(!lock.opCoversButton(sq, "p2", "applyDamage", { index: 2 }));
  console.log("ok opCoversButton");
}

/* ---------- the suite is still resolving the card ---------- */
{
  await set("damageMode", "auto");
  const extra = { tgt000000000001: { _id: "tgt000000000001", type: "targetResult", rolls: [] } };
  const msg = await card(extra);
  const res = getResolution(msg);
  assert.ok(res && !res.resolvedAt, "seeded, not resolved yet");
  assert.ok(isTargetResultCard(msg), "a 1.2 card");
  assert.equal(veto.isResolving(msg), true);
  warns.length = 0;
  assert.equal(preDamage(msg, "tgt000000000001"), false, "resolving: every per-target button waits");
  assert.deepEqual(warns, ["DSAUTO.Lock.Resolving"], "with its own message");
  assert.equal(veto.isResolving(msg, Date.now() + veto.RESOLVING_MAX_MS + 1000), false, "an abandoned record is not resolving");
  await set("enabled", false);
  assert.equal(veto.isResolving(msg), false, "suite disabled");
  await set("enabled", true);
  await settle();
  assert.ok(getResolution(msg).resolvedAt, "resolved");
  assert.equal(veto.isResolving(msg), false);
  assert.equal(preDamage(msg, "tgt000000000001"), true, "after resolution a row without an op is clickable");
  // A 1.1.x card (no targetResult part) is never 'resolving'.
  const old = await card();
  assert.equal(veto.isResolving(old), false);
  await settle();
  console.log("ok veto while resolving (blocked, abandoned, disabled, after resolve)");
}

/* ---------- ctlib journal -> external, undone -> pending ---------- */
{
  game.modules.set(CTLIB, { active: true, version: "2.0.0" });
  const msg = await card();
  await settle();
  await api.undoOps(msg.id);
  const id = opId(msg);
  assert.equal(getResolution(msg).ops[id].status, "undone");
  const journal = undone => ({ j1: { id: "j1", at: 1, userId: "pl", partId: P, action: "applyDamage", index: 1, undone, targets: [{ uuid: tA.document.uuid }] } });
  await msg.update({ [`flags.${CTLIB}.journal`]: journal(false) });
  await settle();
  let op = getResolution(msg).ops[id];
  assert.deepEqual([op.status, op.reason], ["external", "appliedByCtlib"], "a live journal entry marks the row applied elsewhere");
  await msg.update({ [`flags.${CTLIB}.journal.j1.undone`]: true });
  await settle();
  op = getResolution(msg).ops[id];
  assert.equal(op.status, "pending", "an undone entry: pending again");
  // Another roll index does not cover it.
  await msg.update({ [`flags.${CTLIB}.journal`]: { j2: { ...journal(false).j1, id: "j2", index: 2 } } });
  await settle();
  assert.equal(getResolution(msg).ops[id].status, "pending", "other roll index");
  // The setting still gates it.
  await set("respectDstdApplications", false);
  await msg.update({ [`flags.${CTLIB}.journal.j2.index`]: 1 });
  await settle();
  assert.equal(getResolution(msg).ops[id].status, "pending", "respectDstdApplications off: ignored");
  await set("respectDstdApplications", true);
  // Our own Apply refuses to double a row ctlib applied.
  await api.applyOps(msg.id, [id]);
  op = getResolution(msg).ops[id];
  assert.deepEqual([op.status, op.reason], ["external", "appliedByCtlib"], "apply does not double the card's own button");

  // coverage of the other kinds and squads
  const entries = { a: { action: "applyEffect", partId: "p1", effect: "slowed", undone: false }, b: { action: "gainResource", partId: "p1", undone: false },
    c: { action: "applyDamage", partId: "p1", index: 1, undone: false }, d: { action: "applyDamage", partId: "p2", index: 1, undone: true } };
  const fake = { flags: { [CTLIB]: { journal: entries } } };
  assert.deepEqual(ctlibMod.ctlibCoverage(fake, { kind: "condition", partId: "p1", effectId: "slowed" }), { covered: 1, total: 1 });
  assert.deepEqual(ctlibMod.ctlibCoverage(fake, { kind: "condition", partId: "p1", effectId: "dazed" }), { covered: 0, total: 1 });
  assert.deepEqual(ctlibMod.ctlibCoverage(fake, { kind: "resource", native: true, partId: "p1" }), { covered: 1, total: 1 });
  assert.deepEqual(ctlibMod.ctlibCoverage(fake, { kind: "damage", partId: "p1", rollIndex: 1, parts: [{ partId: "p1", rollIndex: 1 }, { partId: "p2", rollIndex: 1 }] }),
    { covered: 1, total: 2 }, "squad: the undone entry does not count");
  assert.deepEqual(ctlibMod.ctlibCoverage(fake, { kind: "zone" }), { covered: 0, total: 0 });
  game.modules.delete(CTLIB);
  console.log("ok ctlib journal as applied elsewhere (external, undone, index, setting, apply guard, kinds)");
}

/* ---------- part lock of pending rows and "Apply All Damage" ---------- */
{
  class El {
    constructor(tag, attrs = {}) {
      this.tag = tag; this.dataset = {}; this.disabled = false; this.kids = []; this.classes = new Set();
      this.classList = { add: c => this.classes.add(c), contains: c => this.classes.has(c) };
      for (const [k, v] of Object.entries(attrs)) this.dataset[k] = v;
    }
    append(...els) { this.kids.push(...els); }
    querySelectorAll(sel) {
      const out = [];
      const walk = el => {
        for (const k of el.kids) {
          if (sel === "[data-message-part]" ? k.dataset.messagePart : sel === "[data-ctlib-apply-all]" ? "ctlibApplyAll" in k.dataset
            : sel.startsWith("[data-action=") && k.dataset.action === sel.match(/"(\w+)"/)?.[1]) out.push(k);
          walk(k);
        }
      };
      walk(this);
      return out;
    }
  }
  const dom = ids => {
    const root = new El("li");
    const out = { root };
    for (const id of ids) {
      const section = new El("section", { messagePart: id });
      out[id] = { d1: new El("button", { action: "applyDamage", index: "1" }), d0: new El("button", { action: "applyDamage", index: "0" }) };
      section.append(...Object.values(out[id]));
      root.append(section);
    }
    out.all = new El("button", { ctlibApplyAll: "" });
    root.append(out.all);
    return out;
  };
  const DamageRoll = ds.rolls.DamageRoll;
  const PowerRoll = ds.rolls.PowerRoll;
  const mk = id => ({ id, type: "targetResult", rolls: [new PowerRoll(10, {}), new DamageRoll(3, {})] });

  await set("damageMode", "manual");
  const msg = await card();
  await settle();
  const realSystem = msg.system;
  msg.system = { parts: new Map([[P, mk(P)], ["other0000000000", mk("other0000000000")]]) };
  msg.system.parts.get = Map.prototype.get;
  msg.system.parts[Symbol.iterator] = function* () { yield* this.values(); };
  let d = dom([P, "other0000000000"]);
  const count = lock.decoratePartButtons(msg, d.root);
  assert.ok(d[P].d1.disabled && !d[P].d0.disabled, "the pending row's damage button is locked");
  assert.ok(!d.other0000000000.d1.disabled, "another part stays open");
  assert.equal(d[P].d1.dataset.tooltip, "DSAUTO.Lock.PartOwned", "pending: the 'use the Automation box' tooltip");
  assert.ok(!d.all.disabled, "apply-all stays while a damage part is not ours");
  assert.equal(count, 1);
  // Only the owned part on the card: apply-all is disabled too.
  msg.system = { parts: new Map([[P, mk(P)]]) };
  msg.system.parts[Symbol.iterator] = function* () { yield* this.values(); };
  d = dom([P]);
  lock.decoratePartButtons(msg, d.root);
  assert.ok(d.all.disabled, "every damage part owned: apply-all disabled");
  // Applied: the applied tooltip.
  await api.applyOps(msg.id, [opId(msg)]);
  d = dom([P]);
  lock.decoratePartButtons(msg, d.root);
  assert.equal(d[P].d1.dataset.tooltip, "DSAUTO.Lock.PartApplied");
  // Undone: nothing owned.
  await api.undoOps(msg.id);
  d = dom([P]);
  assert.equal(lock.decoratePartButtons(msg, d.root), 0);
  assert.ok(!d.all.disabled);
  msg.system = realSystem;
  await set("damageMode", "auto");
  console.log("ok part lock of pending rows and the apply-all button");
}

/* ---------- Target Damage stands down on targetResult cards ---------- */
{
  setDstd(true);
  const plain = await card();
  const tr = await card({ tgt000000000002: { _id: "tgt000000000002", type: "targetResult", rolls: [] } });
  assert.equal(dstdOnCard(plain), true, "1.1.x card: Target Damage works");
  assert.equal(dstdOnCard(tr), false, "targetResult card: it stands down");
  // fold: a state on the card would fold the panel on a 1.1.x card, never on a 1.2 one
  for (const m of [plain, tr]) await settle(), m.flags["draw-steel-target-damage"] = { state: { applications: {} } };
  assert.equal(wantsFold(plain), true);
  assert.equal(wantsFold(tr), false, "no Details fold for a targetResult card");
  // lateTargets: Target Damage's list on a targetResult card does not retarget it
  const before = Object.keys(getResolution(tr).targets ?? {}).length;
  await tr.update({ "flags.draw-steel-target-damage.state.targets": [{ tokenUuid: tA.document.uuid }] });
  await settle();
  assert.equal(Object.keys(getResolution(tr).targets ?? {}).length, before, "no late retarget on a targetResult card");
  setDstd(false);
  console.log("ok Target Damage gating (dstdOnCard, fold, late targets; the click lock shares dstdOnCard)");
}

/* ---------- self-check row ---------- */
{
  const had = "targetResult" in ds.CONFIG.MessagePart;
  const key = "DSAUTO.SelfCheck.dstdOnSystem12";
  const log = console.log, table = console.table, warn = console.warn;
  console.log = console.table = console.warn = () => {};
  let off, on1, on2;
  try {
    ds.CONFIG.MessagePart.targetResult = {};
    setDstd(true);
    on1 = api.selfCheck();
    setDstd(false);
    off = api.selfCheck();
    delete ds.CONFIG.MessagePart.targetResult;
    setDstd(true);
    on2 = api.selfCheck();
  } finally {
    console.log = log; console.table = table; console.warn = warn;
    if (!had) delete ds.CONFIG.MessagePart.targetResult;
    setDstd(false);
  }
  assert.ok(on1.problemKeys.some(p => p.key === key), "1.2 and Target Damage on: the row");
  assert.ok(on1.problems.some(t => t.includes("turn it off")), "with its text");
  assert.ok(!off.problemKeys.some(p => p.key === key), "Target Damage off: no row");
  assert.ok(!on2.problemKeys.some(p => p.key === key), "1.1.x system: no row");
  console.log("ok self-check row dstdOnSystem12");
}

console.log("harness19 done");
process.exit(0);
