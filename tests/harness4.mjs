// Fourth harness (Milestone 1.5): half damage, status immunity, surges (damage and potency), Death
// Tracker revival on undo, synthetic cards (api.applyDamage), resolve delay + Dice So Nice wait,
// confirmation dialog, warnings UI. Reuses harness.mjs's mock world (scenarios skipped).
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

globalThis.__HARNESS_SKIP_SCENARIOS__ = true;
const world = await import(new URL("./harness.mjs", import.meta.url).href);
const {
  postAbility, settle, makeAbility, hero, tA, tB, gobA, gobB, api, getResolution, buildView,
  users, setUser, Actor, addToken, registry, Squad, Message, messages, setCombat,
} = world;
const { gm, player, player2 } = users;
const paths = (await import("node:module")).createRequire(import.meta.url)("./paths.cjs"); const ROOT = paths.SCRIPTS;
const { integrity } = await import(pathToFileURL(ROOT + "engine/ledger.mjs").href);
const dtMock = await import(new URL("./mocks/dt-death-tracker.mjs", import.meta.url).href);

const set = (key, value) => game.settings.set("stef-ds-automation", key, value);
const DEFAULTS = {
  damageMode: "auto", healingMode: "auto", conditionsMode: "auto", heroOverride: "inherit", playerAuthoredMode: "inherit",
  cardActionRole: 4, playerCardActions: "ownSource", respectDstdApplications: true, reviveOnUndo: true,
  autoApplyDelayMs: 0, waitForDiceSoNice: true, promptDialog: false, potencyGate: true, potencyAlwaysMeansFailure: true,
};
const reset = () => { for (const [k, v] of Object.entries(DEFAULTS)) set(k, v); };
async function as(user, fn) {
  setUser(user);
  try {
    return await fn();
  } finally {
    setUser(gm);
  }
}
async function rejects(promise, key) {
  await assert.rejects(promise, err => err.message === key, `expected ${key}`);
}
const restore = () => {
  for (const a of [gobA, gobB, hero]) { a.system.stamina.value = a.system.stamina.max; a.system.stamina.temporary = 0; a.statuses.delete("dead"); }
};
let n = 0;
const ability = (opts = {}) => makeAbility({ uuid: `Actor.hero000000000001.Item.m15${String(++n).padStart(13, "0")}`, name: `M15 ${n}`, actor: hero, ...opts });
const opsOf = msg => Object.values(getResolution(msg).ops).sort((a, b) => a.order - b.order);
const allOps = view => view.rows.flatMap(r => r.ops);

// Hero surges and highest characteristic (the system reads getRollData().chr).
hero.system.hero = { surges: 5 };
hero.getRollData = () => ({ chr: 2 });

// Foundry bits the M1.5 code uses.
foundry.utils.escapeHTML = v => String(v).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
foundry.utils.getRoute = p => (p.includes("draw-steel-death-tracker/src/death-tracker.mjs")
  ? new URL("./mocks/dt-death-tracker.mjs", import.meta.url).href : `/${p}`);
const announced = [];
globalThis.ctlib = {
  services: new Map([["announcePendingRevival", uuid => announced.push(uuid)]]),
  damageBatch: fn => fn(),
};
game.modules.set("draw-steel-ctlib", { active: true });
const placeables = new Map();
globalThis.canvas = { tokens: { get: id => placeables.get(id) } };
globalThis.ChatMessage = {
  getSpeaker: ({ actor } = {}) => ({ alias: actor?.name ?? "GM" }),
  async create(data) {
    const msg = new Message({ type: data.type, parts: data.system.parts, flags: data.flags, speaker: data.speaker });
    msg.author = game.user;
    messages.set(msg.id, msg);
    Hooks.call("preCreateChatMessage", msg, data, {}, game.userId);
    Hooks.callAll("createChatMessage", msg, {}, game.userId);
    return msg;
  },
};
let dialogAnswer = null; // (config) => result for DialogV2.wait / input
foundry.applications = { api: { DialogV2: {
  wait: async (config) => dialogAnswer?.(config) ?? null,
  input: async (config) => dialogAnswer?.(config) ?? null,
} } };

reset();

/* ---------- half damage (rounded down, before immunities) ---------- */
{
  set("damageMode", "manual");
  const msg = postAbility(ability(), { 2: [tA] }, { 2: [{ total: 9 }] });
  await settle();
  const [op] = opsOf(msg);
  assert.equal(op.status, "pending");
  const view = buildView(msg, getResolution(msg));
  assert.ok(allOps(view)[0].canHalf, "half button on a pending damage row");
  await api.applyOps(msg.id, [op.opId], { half: true });
  let now = getResolution(msg).ops[op.opId];
  assert.equal(now.status, "applied");
  assert.equal(now.half, true);
  assert.equal(now.amount, 4, "floor(9/2)");
  assert.equal(gobA.system.stamina.value, 16);
  assert.ok(allOps(buildView(msg, getResolution(msg)))[0].detail.includes("DSAUTO.Card.Half"));
  await api.undoOps(msg.id);
  assert.equal(gobA.system.stamina.value, 20);
  await api.applyOps(msg.id, [op.opId]);
  now = getResolution(msg).ops[op.opId];
  assert.equal(now.half, false, "a plain apply deals full damage again");
  assert.equal(gobA.system.stamina.value, 11);
  // Half on a fire hit against fire immunity 2: 7 -> 3 -> 1.
  const msg2 = postAbility(ability(), { 2: [tA] }, { 2: [{ total: 7, options: { type: "fire" } }] });
  await settle();
  gobA.system.stamina.value = 20;
  await api.applyOps(msg2.id, null, { half: true });
  assert.equal(gobA.system.stamina.value, 19);
  // Players never get the half button without Apply.
  const pv = await as(player, () => buildView(msg2, getResolution(msg2)));
  assert.ok(!allOps(pv).some(o => o.canHalf));
  await api.undoOps(msg.id);
  await api.undoOps(msg2.id);
  reset();
  restore();
  console.log("ok half damage");
}

/* ---------- status immunity ---------- */
{
  setCombat({ getCombatantsByActor: (a) => [{ id: `cmb-${a.name}`, initiative: 1 }] });
  gobA.system.statuses = { immunities: new Set(["slowed"]) };
  const applied = { tier2: { potency: { characteristic: "might", value: "@potency.weak" }, effects: { slowed: { condition: "failure", end: "save" } } } };
  const msg = postAbility(ability({ damage: false, applied }), { 2: [tA, tB] }, {});
  await settle();
  const ops = opsOf(msg);
  const a = ops.find(o => o.targetKeys[0].includes("tokA"));
  const b = ops.find(o => o.targetKeys[0].includes("tokB"));
  assert.equal(a.status, "skipped");
  assert.equal(a.reason, "statusImmune");
  assert.ok(!gobA.statuses.has("slowed"));
  assert.equal(b.status, "skipped", "goblin B resists (might 3 vs 1)");
  assert.equal(b.reason, "resisted");
  // The Director can still override.
  await api.applyOps(msg.id, [a.opId]);
  assert.equal(getResolution(msg).ops[a.opId].status, "applied");
  await api.undoOps(msg.id);
  delete gobA.system.statuses;
  console.log("ok status immunity skip");
}

/* ---------- surges: extra damage on one target ---------- */
{
  hero.system.hero.surges = 5;
  const msg = postAbility(ability(), { 2: [tA, tB] }, { 2: [{ total: 5, options: { type: "fire" } }] }, { author: player });
  await settle();
  const base = opsOf(msg).find(o => o.targetKeys[0].includes("tokA"));
  assert.equal(gobA.system.stamina.value, 17, "5 fire - immunity 2");
  // The hero's owner sees the surge button (whatever the role floor); another player does not.
  const pv = await as(player, () => buildView(msg, getResolution(msg)));
  const pop = allOps(pv).find(o => o.opId === base.opId);
  assert.ok(pop.canSurge && pop.surgeMax === 3, "owner may spend up to 3");
  assert.ok(!pop.canApply, "but has no Apply button below the role floor");
  const ov = await as(player2, () => buildView(msg, getResolution(msg)));
  assert.ok(!allOps(ov).some(o => o.canSurge));
  await rejects(as(player2, () => api.surge(msg.id, base.opId, { count: 1 })), "DSAUTO.Relay.Denied");
  // Two surges: +4, immunity applies once to the total: f(9) - f(5) = 7 - 3 = 4.
  const r = await as(player, () => api.surge(msg.id, base.opId, { count: 2 }));
  assert.equal(r.status, "applied", "base row was applied automatically: the surge lands at once");
  let surgeOp = getResolution(msg).ops[r.opId];
  assert.equal(surgeOp.finalAmount, 4);
  assert.equal(surgeOp.surgesPaid, 2);
  assert.equal(gobA.system.stamina.value, 13);
  assert.equal(hero.system.hero.surges, 3);
  assert.ok(allOps(buildView(msg, getResolution(msg))).find(o => o.opId === r.opId).label.startsWith("DSAUTO.Card.SurgeDamage"));
  // Limits: at most 3 per damage roll, and the hero's surges.
  await rejects(as(player, () => api.surge(msg.id, base.opId, { count: 2 })), "DSAUTO.Relay.SurgeNotPossible");
  hero.system.hero.surges = 0;
  await rejects(as(player, () => api.surge(msg.id, base.opId, { count: 1 })), "DSAUTO.Relay.NotEnoughSurges");
  hero.system.hero.surges = 3;
  // Undo the surge: Stamina back, surges refunded; spending again is possible.
  await api.undoOps(msg.id, [r.opId]);
  surgeOp = getResolution(msg).ops[r.opId];
  assert.equal(surgeOp.status, "undone");
  assert.equal(surgeOp.surgesPaid, 0);
  assert.equal(gobA.system.stamina.value, 17);
  assert.equal(hero.system.hero.surges, 5);
  const r2 = await as(player, () => api.surge(msg.id, base.opId, { count: 3 }));
  assert.notEqual(r2.opId, r.opId, "a new row");
  assert.equal(gobA.system.stamina.value, 17 - 6, "f(11) - f(5) = 9 - 3");
  assert.equal(hero.system.hero.surges, 2);
  // Undo all: newest first, refunds.
  await api.undoOps(msg.id);
  assert.equal(gobA.system.stamina.value, 20);
  assert.equal(gobB.system.stamina.value, 20);
  assert.equal(hero.system.hero.surges, 5);
  restore();
  console.log("ok surge damage (immunity once, limits, refund on undo)");
}

/* ---------- surges on a waiting row are paid when it lands ---------- */
{
  set("damageMode", "manual");
  hero.system.hero.surges = 2;
  const msg = postAbility(ability(), { 1: [tB] }, { 1: [{ total: 4 }] }, { author: player });
  await settle();
  const [base] = opsOf(msg);
  const r = await as(player, () => api.surge(msg.id, base.opId, { count: 1 }));
  assert.equal(r.status, "pending", "waits like its base row");
  assert.equal(hero.system.hero.surges, 2, "nothing paid yet");
  hero.system.hero.surges = 0; // spent elsewhere meanwhile
  await api.applyOps(msg.id);
  const now = getResolution(msg);
  assert.equal(now.ops[base.opId].status, "applied");
  assert.equal(now.ops[r.opId].status, "failed");
  assert.equal(now.ops[r.opId].reason, "noSurges");
  assert.equal(gobB.system.stamina.value, 16, "only the base damage");
  hero.system.hero.surges = 1;
  await api.applyOps(msg.id, [r.opId]);
  assert.equal(getResolution(msg).ops[r.opId].status, "applied");
  assert.equal(gobB.system.stamina.value, 14);
  assert.equal(hero.system.hero.surges, 0);
  // A GM's surge on an applied manual row lands at once.
  hero.system.hero.surges = 1;
  const r3 = await api.surge(msg.id, base.opId, { count: 1 });
  assert.equal(r3.status, "applied");
  await api.undoOps(msg.id);
  assert.equal(gobB.system.stamina.value, 20);
  assert.equal(hero.system.hero.surges, 2, "both surge rows refunded");
  reset();
  restore();
  console.log("ok surge paid on application");
}

/* ---------- surges on a squad: one minion's extra damage into the pool ---------- */
{
  const m1 = new Actor({ uuid: "Scene.scene00000000001.Token.tokS100000000001.Actor.minion0000000002", name: "S1", minion: true, stamina: 5 });
  const m2 = new Actor({ uuid: "Scene.scene00000000001.Token.tokS200000000001.Actor.minion0000000002", name: "S2", minion: true, stamina: 5 });
  registry.set(m1.uuid, m1); registry.set(m2.uuid, m2);
  const squad = new Squad("Scene.scene00000000001.CombatantGroup.squad00000000002", "Rats", [m1, m2]);
  registry.set(squad.uuid, squad);
  const tm1 = addToken("tokS100000000001", m1, "S1"); const tm2 = addToken("tokS200000000001", m2, "S2");
  m1.token = tm1.document; m2.token = tm2.document;
  hero.system.hero.surges = 3;
  const msg = postAbility(ability(), { 2: [tm1, tm2] }, { 2: [{ total: 3 }] });
  await settle();
  assert.equal(squad.system.staminaValue, 24);
  const [base] = opsOf(msg);
  const r = await api.surge(msg.id, base.opId, { count: 1 });
  assert.equal(getResolution(msg).ops[r.opId].group, squad.uuid);
  assert.equal(squad.system.staminaValue, 22, "+2 on one minion");
  // Area cap: a minion already at its cap takes nothing more.
  const msg2 = postAbility(ability(), { 2: [tm1, tm2] }, { 2: [{ total: 7, options: { aoe: true } }] });
  await settle();
  assert.equal(squad.system.staminaValue, 12);
  const [base2] = opsOf(msg2);
  await api.surge(msg2.id, base2.opId, { count: 1 });
  assert.equal(squad.system.staminaValue, 12, "capped at the minion's Stamina");
  await api.undoOps(msg2.id);
  await api.undoOps(msg.id);
  assert.equal(squad.system.staminaValue, 30);
  console.log("ok surge on a squad (pool, area cap)");
}

/* ---------- +1 potency for 2 surges ---------- */
{
  hero.system.hero.surges = 2;
  const applied = { tier2: { potency: { characteristic: "might", value: "@potency.strong" }, effects: { slowed: { condition: "failure", end: "save" } } } };
  const msg = postAbility(ability({ damage: false, applied }), { 2: [tA, tB] }, {}, { author: player });
  await settle();
  const ops = opsOf(msg);
  const a = ops.find(o => o.targetKeys[0].includes("tokA"));
  const b = ops.find(o => o.targetKeys[0].includes("tokB"));
  assert.equal(a.status, "applied", "goblin A (might 0) fails 3");
  assert.equal(b.reason, "resisted", "goblin B (might 3) resists 3");
  const pv = await as(player, () => buildView(msg, getResolution(msg)));
  assert.ok(allOps(pv).find(o => o.opId === b.opId).canPotencySurge, "resisted by exactly one");
  assert.ok(!allOps(pv).find(o => o.opId === a.opId).canPotencySurge);
  await as(player, () => api.surge(msg.id, b.opId, { potency: true }));
  let now = getResolution(msg).ops[b.opId];
  assert.equal(now.status, "applied", "conditions are automatic: lands at once");
  assert.equal(now.potency.value, 4);
  assert.equal(now.potency.fails, true);
  assert.equal(now.surgesPaid, 2);
  assert.ok(gobB.statuses.has("slowed"));
  assert.equal(hero.system.hero.surges, 0);
  assert.ok(allOps(buildView(msg, getResolution(msg))).find(o => o.opId === b.opId).detail.includes("DSAUTO.Card.PotencySurged"));
  await rejects(api.surge(msg.id, b.opId, { potency: true }), "DSAUTO.Relay.SurgeNotPossible");
  await api.undoOps(msg.id, [b.opId]);
  now = getResolution(msg).ops[b.opId];
  assert.equal(now.status, "undone");
  assert.equal(hero.system.hero.surges, 2, "refunded");
  await api.undoOps(msg.id);
  gobA.statuses.delete("slowed"); gobB.statuses.delete("slowed");
  console.log("ok +1 potency surge");
}

/* ---------- Death Tracker revival on undo ---------- */
{
  game.modules.set("draw-steel-death-tracker", { active: true, version: "1.1.3" });
  // A creature whose defeated status stays until Death Tracker lifts it (the mock Actor clears it on update).
  class Sticky extends Actor {
    async update(changes) {
      for (const [k, v] of Object.entries(changes)) {
        const parts = k.split(".");
        let o = this;
        for (const p of parts.slice(0, -1)) o = o[p];
        o[parts.at(-1)] = v;
      }
      return this;
    }
  }
  const ogre = new Sticky({ uuid: "Scene.scene00000000001.Token.tokO000000000001.Actor.ogre000000000001", name: "Ogre", stamina: 6 });
  registry.set(ogre.uuid, ogre);
  const tO = addToken("tokO000000000001", ogre, "Ogre");
  ogre.token = tO.document;
  placeables.set("tokO000000000001", { id: "tokO000000000001", actor: ogre });
  const msg = postAbility(ability(), { 3: [tO] }, { 3: [{ total: 9 }] });
  await settle();
  assert.ok(ogre.statuses.has("dead"));
  await api.undoOps(msg.id);
  let op = opsOf(msg)[0];
  assert.deepEqual(announced, [tO.document.uuid], "announced before the restore");
  assert.equal(dtMock.calls.length, 1);
  assert.deepEqual(dtMock.calls[0].tokenIds, ["tokO000000000001"]);
  assert.equal(dtMock.calls[0].options.skipGroupHpRestore, true, "our undo already restored the pool");
  assert.ok(!ogre.statuses.has("dead"));
  assert.equal(op.revivalPending, null);
  assert.equal(ogre.system.stamina.value, 6);
  // Off the Director's canvas: stays defeated, the row says so.
  await api.applyOps(msg.id, [opsOf(msg)[0].opId]);
  placeables.delete("tokO000000000001");
  await api.undoOps(msg.id);
  op = opsOf(msg)[0];
  assert.equal(dtMock.calls.length, 1, "no placeable, no revival");
  assert.equal(op.revivalPending, true);
  assert.ok(allOps(buildView(msg, getResolution(msg)))[0].detail.includes("DSAUTO.Card.RevivalPending"));
  // Setting off: not even tried.
  ogre.statuses.delete("dead");
  placeables.set("tokO000000000001", { id: "tokO000000000001", actor: ogre });
  set("reviveOnUndo", false);
  await api.applyOps(msg.id, [opsOf(msg)[0].opId]);
  await api.undoOps(msg.id);
  assert.equal(dtMock.calls.length, 1);
  assert.equal(opsOf(msg)[0].revivalPending, true);
  // Death groups: tokens killed in one stroke come back together.
  set("reviveOnUndo", true);
  ogre.statuses.delete("dead");
  const imp2 = new Sticky({ uuid: "Scene.scene00000000001.Token.tokI000000000001.Actor.imp0000000000001", name: "Imp", stamina: 1 });
  imp2.statuses.add("dead");
  placeables.set("tokI000000000001", { id: "tokI000000000001", actor: imp2 });
  globalThis._dsctDeathGroups = new Map([["tokO000000000001", new Set(["tokO000000000001", "tokI000000000001"])]]);
  await api.applyOps(msg.id, [opsOf(msg)[0].opId]);
  await api.undoOps(msg.id);
  assert.deepEqual(dtMock.calls.at(-1).tokenIds.sort(), ["tokI000000000001", "tokO000000000001"]);
  assert.ok(!imp2.statuses.has("dead"));
  delete globalThis._dsctDeathGroups;
  // Squads: Death Tracker clamps pool writes to living minions x Stamina (preUpdateCombatantGroup), so
  // the undo revives first and writes the pool afterwards (live run 2026-10-06: 16 -> 12 otherwise).
  const k1 = new Sticky({ uuid: "Scene.scene00000000001.Token.tokK100000000001.Actor.kobold0000000001", name: "K1", minion: true, stamina: 4 });
  const k2 = new Sticky({ uuid: "Scene.scene00000000001.Token.tokK200000000001.Actor.kobold0000000001", name: "K2", minion: true, stamina: 4 });
  registry.set(k1.uuid, k1); registry.set(k2.uuid, k2);
  const kSquad = new Squad("Scene.scene00000000001.CombatantGroup.squad00000000003", "Kobolds", [k1, k2]);
  kSquad.system.staminaValue = 8;
  registry.set(kSquad.uuid, kSquad);
  const tk1 = addToken("tokK100000000001", k1, "K1"); const tk2 = addToken("tokK200000000001", k2, "K2");
  k1.token = tk1.document; k2.token = tk2.document;
  const member = (actor, token) => ({ actor, token, get isDefeated() { return actor.statuses.has("dead"); } });
  kSquad.system.minions = [member(k1, tk1.document), member(k2, tk2.document)];
  placeables.set("tokK100000000001", { id: "tokK100000000001", actor: k1 });
  placeables.set("tokK200000000001", { id: "tokK200000000001", actor: k2 });
  const clamp = () => [k1, k2].filter(m => !m.statuses.has("dead")).length * 4;
  const origUpdate = kSquad.update.bind(kSquad);
  kSquad.update = async (changes) => {
    const v = changes["system.staminaValue"];
    if (v !== undefined) changes = { ...changes, "system.staminaValue": Math.min(v, clamp()) };
    return origUpdate(changes);
  };
  const kMsg = postAbility(ability(), { 2: [tk1] }, { 2: [{ total: 5 }] });
  await settle();
  assert.equal(kSquad.system.staminaValue, 3);
  k1.statuses.add("dead"); // Death Tracker defeats the hit minion
  await api.undoOps(kMsg.id);
  assert.ok(!k1.statuses.has("dead"), "revived");
  assert.equal(kSquad.system.staminaValue, 8, "pool fully restored (not clamped to the 4 of one living minion)");
  assert.equal(opsOf(kMsg)[0].undoMode, "absolute");
  assert.equal(opsOf(kMsg)[0].revivalPending, null);
  // Death Tracker may defeat a squad member that was not hit (live run 2026-10-06): the undo revives
  // as many minions as the restored pool needs, whoever they are.
  const kMsg2 = postAbility(ability(), { 2: [tk1] }, { 2: [{ total: 5 }] });
  await settle();
  assert.equal(kSquad.system.staminaValue, 3);
  k2.statuses.add("dead"); // not the target
  const calls = dtMock.calls.length;
  await api.undoOps(kMsg2.id);
  assert.ok(!k2.statuses.has("dead"), "the defeated non-target revived");
  assert.deepEqual(dtMock.calls.at(-1).tokenIds, ["tokK200000000001"]);
  assert.equal(dtMock.calls.length, calls + 1);
  assert.equal(kSquad.system.staminaValue, 8);
  // Only as many as needed: pool restored to 5 needs 2 alive; nothing to revive when both live.
  const kMsg3 = postAbility(ability(), { 2: [tk1] }, { 2: [{ total: 2 }] });
  await settle();
  await api.undoOps(kMsg3.id);
  assert.equal(dtMock.calls.length, calls + 1, "no revival when nobody is defeated");
  // Revival off: the pool stays clamped to the living, the row says so.
  set("reviveOnUndo", false);
  const kMsg4 = postAbility(ability(), { 2: [tk1] }, { 2: [{ total: 5 }] });
  await settle();
  k1.statuses.add("dead");
  await api.undoOps(kMsg4.id);
  assert.equal(kSquad.system.staminaValue, 4, "clamped by Death Tracker");
  assert.equal(opsOf(kMsg4)[0].revivalPending, true);
  k1.statuses.delete("dead");
  set("reviveOnUndo", true);
  game.modules.delete("draw-steel-death-tracker");
  console.log("ok Death Tracker revival on undo");
}

/* ---------- api.applyDamage: synthetic card ---------- */
{
  restore();
  const r = await api.applyDamage({ targets: [tA.document, tB.document.uuid], amount: 6, type: "fire", flavor: "Burning", source: hero });
  assert.ok(r.ok && r.messageId);
  const msg = messages.get(r.messageId);
  const res = getResolution(msg);
  assert.equal(res.synthetic, true);
  assert.equal(res.abilityName, "Burning");
  assert.equal(res.sourceActorUuid, hero.uuid);
  assert.equal(integrity(msg), "ok", "signed by the active GM");
  assert.equal(gobA.system.stamina.value, 16, "6 fire - immunity 2");
  assert.equal(gobB.system.stamina.value, 14);
  assert.ok(Object.values(res.ops).every(o => o.status === "applied" && o.synthetic));
  const view = buildView(msg, res);
  assert.ok(view.synthetic && !view.canRetarget && view.canUndoAll);
  assert.ok(!allOps(view).some(o => o.canSurge), "no surges on synthetic cards");
  await rejects(api.resolve(msg.id, { force: true }), "DSAUTO.Relay.Synthetic");
  await rejects(api.retarget(msg.id, [tA.document.uuid]), "DSAUTO.Relay.Synthetic");
  await api.undoOps(msg.id);
  assert.equal(gobA.system.stamina.value, 20);
  assert.equal(gobB.system.stamina.value, 20);
  await api.applyOps(msg.id, Object.keys(res.ops));
  assert.equal(gobB.system.stamina.value, 14, "reapply uses the stored amount");
  await api.undoOps(msg.id);
  // Half, healing, temporary Stamina, manual mode.
  const h = await api.applyDamage({ targets: tB.document.uuid, amount: 7, half: true });
  assert.equal(gobB.system.stamina.value, 17, "floor(7/2)");
  await api.undoOps(h.messageId);
  gobB.system.stamina.value = 10;
  await api.applyDamage({ targets: [tB.document.uuid], amount: 4, kind: "heal" });
  assert.equal(gobB.system.stamina.value, 14);
  const t = await api.applyDamage({ targets: [tB.document.uuid], amount: 5, kind: "temp", mode: "manual" });
  assert.equal(gobB.system.stamina.temporary, 0, "manual: waits");
  await api.applyOps(t.messageId);
  assert.equal(gobB.system.stamina.temporary, 5);
  // Directors only; bad requests rejected.
  await rejects(as(player, () => api.applyDamage({ targets: [tA.document.uuid], amount: 3 })), "DSAUTO.Relay.Denied");
  await rejects(api.applyDamage({ targets: [], amount: 3 }), "DSAUTO.Relay.BadRequest");
  await rejects(api.applyDamage({ targets: [tA.document.uuid], amount: -1 }), "DSAUTO.Relay.BadRequest");
  await rejects(api.applyDamage({ targets: [tA.document.uuid], amount: 3, type: "nonsense" }), "DSAUTO.Relay.BadRequest");
  restore();
  console.log("ok api.applyDamage synthetic cards");
}

/* ---------- resolve delay and Dice So Nice wait ---------- */
{
  set("autoApplyDelayMs", 40);
  const msg = postAbility(ability(), { 1: [tA] }, { 1: [{ total: 2 }] });
  await settle();
  assert.ok(!getResolution(msg).resolvedAt, "still waiting");
  await new Promise(r => setTimeout(r, 60));
  assert.ok(getResolution(msg).resolvedAt, "resolved after the delay");
  await api.undoOps(msg.id);
  set("autoApplyDelayMs", 0);
  let release;
  game.dice3d = { waitFor3DAnimationByMessageID: () => new Promise(r => { release = r; }) };
  const msg2 = postAbility(ability(), { 1: [tA] }, { 1: [{ total: 2 }] });
  await settle();
  assert.ok(!getResolution(msg2).resolvedAt, "waits for the dice");
  release(true);
  await settle();
  assert.ok(getResolution(msg2).resolvedAt, "resolved after the dice");
  await api.undoOps(msg2.id);
  // 0.17.1: a hidden Director (Dice So Nice defers its animation) waits on the author's screen instead.
  document.hidden = true;
  const playerQuery = player.query;
  const asked = [];
  let answer;
  player.query = (name, data, opts) => { asked.push({ name, data, opts }); return new Promise((r, j) => { answer = { r, j }; }); };
  const msg4 = postAbility(ability(), { 1: [tA] }, { 1: [{ total: 2 }] }, { author: player });
  await settle();
  assert.equal(asked.length, 1, "hidden: the author is asked");
  assert.deepEqual(asked[0].data, { type: "diceWait", messageId: msg4.id });
  assert.equal(asked[0].opts.timeout, 15_000);
  assert.ok(!getResolution(msg4).resolvedAt, "waits for the author's dice");
  answer.r({ done: true });
  await settle();
  assert.ok(getResolution(msg4).resolvedAt, "resolved when the author answered");
  await api.undoOps(msg4.id);
  const msg5 = postAbility(ability(), { 1: [tA] }, { 1: [{ total: 2 }] }, { author: player });
  await settle();
  answer.j(new Error("timeout"));
  await settle();
  assert.ok(getResolution(msg5).resolvedAt, "a timed-out author does not block");
  await api.undoOps(msg5.id);
  // The Director's own roll (or an offline author) while hidden: no wait, though the local stub never settles.
  game.dice3d = { waitFor3DAnimationByMessageID: () => new Promise(() => {}) };
  const msg6 = postAbility(ability(), { 1: [tA] }, { 1: [{ total: 2 }] });
  await settle();
  assert.ok(getResolution(msg6).resolvedAt, "hidden, own roll: no wait");
  await api.undoOps(msg6.id);
  player.active = false;
  const before = asked.length;
  const msg7 = postAbility(ability(), { 1: [tA] }, { 1: [{ total: 2 }] }, { author: player });
  await settle();
  assert.equal(asked.length, before, "an offline author is not asked");
  assert.ok(getResolution(msg7).resolvedAt, "hidden, offline author: no wait");
  await api.undoOps(msg7.id);
  player.active = true;
  player.query = playerQuery;
  // The author's side: Directors only; a hidden client answers at once; a visible one waits for its animation.
  const { handleDiceWait } = await import(pathToFileURL(ROOT + "relay/dice-wait.mjs").href);
  await assert.rejects(handleDiceWait({ messageId: msg7.id }, { user: player }), /DSAUTO.Relay.Denied/);
  await assert.rejects(handleDiceWait({ messageId: "nope" }, { user: gm }), /DSAUTO.Relay.BadRequest/);
  assert.deepEqual(await handleDiceWait({ messageId: msg7.id }, { user: gm }), { hidden: true });
  document.hidden = false;
  let landed;
  game.dice3d = { waitFor3DAnimationByMessageID: () => new Promise(r => { landed = r; }) };
  let waited = null;
  const pending = handleDiceWait({ messageId: msg7.id }, { user: gm }).then(v => { waited = v; });
  await settle();
  assert.equal(waited, null, "the author waits for its own animation");
  landed(true);
  await pending;
  assert.deepEqual(waited, { done: true });
  delete document.hidden;
  set("waitForDiceSoNice", false);
  game.dice3d = { waitFor3DAnimationByMessageID: () => new Promise(() => {}) };
  const msg3 = postAbility(ability(), { 1: [tA] }, { 1: [{ total: 2 }] });
  await settle();
  assert.ok(getResolution(msg3).resolvedAt, "setting off: no wait");
  await api.undoOps(msg3.id);
  delete game.dice3d;
  reset();
  restore();
  console.log("ok resolve delay + Dice So Nice wait (hidden Director: the author's screen)");
}

/* ---------- confirmation dialog for rows that wait for the Director ---------- */
{
  set("promptDialog", true);
  set("damageMode", "prompt");
  let seen = null;
  dialogAnswer = (config) => {
    seen = config;
    const apply = config.buttons.find(b => b.action === "apply");
    // Uncheck the second row: only the first is applied.
    const values = [...config.content.matchAll(/value="([^"]+)"/g)].map(m => m[1].replace(/&#45;/g, "-"));
    const form = { querySelectorAll: () => values.slice(0, 1).map(value => ({ value })) };
    return apply.callback({}, { form });
  };
  const msg = postAbility(ability(), { 1: [tA], 2: [tB] }, { 1: [{ total: 2 }], 2: [{ total: 3 }] });
  await settle();
  await settle();
  assert.ok(seen, "dialog opened on the active GM");
  const ops = opsOf(msg);
  assert.equal(ops.filter(o => o.status === "applied").length, 1, "the checked row applied");
  assert.equal(ops.filter(o => o.status === "pending").length, 1, "the other stays on the card");
  await api.undoOps(msg.id);
  // Off: no dialog.
  set("promptDialog", false);
  seen = null;
  postAbility(ability(), { 1: [tA] }, { 1: [{ total: 2 }] });
  await settle();
  assert.equal(seen, null);
  dialogAnswer = null;
  reset();
  restore();
  console.log("ok confirmation dialog");
}

/* ---------- warnings UI: op warnings on the row, notes for the Director ---------- */
{
  const applied = { tier1: { potency: { characteristic: "might", value: "@potency.weak" }, effects: { slowed: { end: "save" } } } };
  const msg = postAbility(ability({ damage: false, applied }), { 1: [tA] }, {});
  await settle();
  const res = getResolution(msg);
  assert.ok(res.warnings.some(w => w.code === "conditionAlwaysWithPotency" && w.opId));
  const view = buildView(msg, res);
  assert.equal(allOps(view)[0].warning, "DSAUTO.Warning.conditionAlwaysWithPotency", "shown on the row");
  assert.deepEqual(view.notes, [], "nothing hidden");
  // A warning about a target the card no longer lists goes to the Director's notes.
  const copy = structuredClone(res); // never touch the signed record itself
  copy.warnings.push({ code: "noTier", targetKey: "Scene__x__Token__gone000000000001" });
  const view2 = buildView(msg, copy);
  assert.deepEqual(view2.notes, ["DSAUTO.Warning.noTier"]);
  const pv = await as(player, () => buildView(msg, copy));
  assert.deepEqual(pv.notes, [], "players get no notes");
  await api.undoOps(msg.id);
  gobA.statuses.delete("slowed");
  console.log("ok warnings UI");
}

console.log("\nALL HARNESS-4 TESTS PASSED");
