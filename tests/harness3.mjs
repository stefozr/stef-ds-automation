// Third harness (Milestone 1b): GM relay and its authorization table, player buttons, heroOverride,
// playerAuthoredMode, two-GM routing, retarget/resolve rules, respectDstdApplications, hidden numbers.
// Reuses harness.mjs's mock world by importing it with a flag that skips its own scenarios.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

globalThis.__HARNESS_SKIP_SCENARIOS__ = true;
const world = await import(new URL("./harness.mjs", import.meta.url).href);
const {
  postAbility, settle, makeAbility, hero, tA, tB, gobA, gobB, api, getResolution, buildView, setDstd,
  users, setUser, setActiveGM, Actor, addToken, registry,
} = world;
const { gm, gm2, player, player2 } = users;
const paths = (await import("node:module")).createRequire(import.meta.url)("./paths.cjs"); const ROOT = paths.SCRIPTS;
const engine = await import(pathToFileURL(ROOT + "engine/engine.mjs").href);
// Exercise the card-button relay directly; api.request is a GM-only diagnostic from M8.
const { requestOp } = await import(pathToFileURL(ROOT + "relay/queries.mjs").href);

const set = (key, value) => game.settings.set("stef-ds-automation", key, value);
const reset = () => {
  for (const [k, v] of Object.entries({
    damageMode: "auto", healingMode: "auto", conditionsMode: "auto", heroOverride: "inherit", playerAuthoredMode: "inherit",
    cardActionRole: 4, playerCardActions: "ownSource", respectDstdApplications: true,
  })) set(k, v);
};
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
const warned = [];
const origWarn = console.warn;
console.warn = (...args) => {
  if (args[1] === "relay.in") warned.push(args[2]);
  origWarn(...args);
};
let n = 0;
const ability = (opts = {}) => makeAbility({ uuid: `Actor.hero000000000001.Item.m1b${String(++n).padStart(13, "0")}`, name: `M1b ${n}`, actor: hero, ...opts });
const restore = () => {
  for (const a of [gobA, gobB, hero]) { a.system.stamina.value = a.system.stamina.max; a.system.stamina.temporary = 0; }
};

// A hero token to target (ally heals, NPC strikes on heroes).
const heroTok = addToken("tokH000000000001", hero, "Hero");
hero.token = heroTok.document;
registry.set(heroTok.document.uuid, heroTok.document);

reset();

/* ---------- T4: player card on a GM-owned NPC; Undo refused below cardActionRole; logged ---------- */
{
  const msg = postAbility(ability(), { 2: [tA] }, { 2: [{ total: 5 }] }, { author: player });
  await settle();
  const res = getResolution(msg);
  assert.ok(res.resolvedAt && res.authorUserId === "pl", "seeded by the player, resolved by the GM");
  assert.equal(gobA.system.stamina.value, 15, "GM applied the player's damage");
  const view = await as(player, () => buildView(msg, res));
  assert.equal(view.rows.length, 1, "player sees the rows");
  assert.ok(!view.rows[0].ops[0].canUndo && !view.showFooter, "no buttons below the role floor");
  assert.ok(buildView(msg, res).rows[0].ops[0].canUndo, "the GM has Undo");
  warned.length = 0;
  await rejects(as(player, () => api.undoOps(msg.id, Object.keys(res.ops))), "DSAUTO.Relay.Denied");
  assert.equal(gobA.system.stamina.value, 15, "nothing undone");
  assert.ok(warned.some(w => w.allowed === false && w.userId === "pl" && w.action === "undo"), "rejection logged");
  // Undo all by the player: every op refused, nothing done, no throw.
  const r = await as(player, () => api.undoOps(msg.id));
  assert.equal(r.refused.length, 1);
  assert.equal(gobA.system.stamina.value, 15);
  await api.undoOps(msg.id);
  restore();
  console.log("ok T4 role floor + rejection log");
}

/* ---------- authorization table above the floor ---------- */
{
  set("cardActionRole", 1);
  set("damageMode", "manual");
  const msg = postAbility(ability(), { 1: [tA], 2: [tB] }, { 1: [{ total: 4 }], 2: [{ total: 6 }] }, { author: player });
  await settle();
  const res = getResolution(msg);
  const [idA, idB] = Object.values(res.ops).sort((a, b) => a.order - b.order).map(o => o.opId);
  // Author (and owner of the source actor) may apply.
  const pv = await as(player, () => buildView(msg, res));
  assert.ok(pv.rows.every(r => r.ops.every(o => o.canApply)) && pv.canApplyAll, "author has Apply buttons");
  // Another player owning nothing: no buttons, relay refuses.
  const ov = await as(player2, () => buildView(msg, res));
  assert.ok(!ov.showFooter && ov.rows.every(r => r.ops.every(o => !o.canApply)), "non-owner has no buttons");
  await rejects(as(player2, () => api.applyOps(msg.id, [idA])), "DSAUTO.Relay.Denied");
  // ownSourceOrTarget: owning goblin A's actor allows its op only; Apply all reports the refused one.
  set("playerCardActions", "ownSourceOrTarget");
  gobA.owners.add("p2");
  const r = await as(player2, () => api.applyOps(msg.id));
  assert.deepEqual(r.refused, [idB]);
  let now = getResolution(msg);
  assert.equal(now.ops[idA].status, "applied");
  assert.equal(now.ops[idA].byUserId, "p2", "applied by the requesting user, not the GM");
  assert.equal(now.ops[idB].status, "pending");
  // Back to ownSource and drop ownership: p2 may still undo what p2 applied.
  set("playerCardActions", "ownSource");
  gobA.owners.delete("p2");
  const ov2 = await as(player2, () => buildView(msg, getResolution(msg)));
  assert.ok(ov2.rows.flatMap(r => r.ops).find(o => o.opId === idA).canUndo, "own application keeps its Undo");
  await as(player2, () => api.undoOps(msg.id, [idA]));
  now = getResolution(msg);
  assert.equal(now.ops[idA].status, "undone");
  assert.equal(now.ops[idA].undoneBy, "p2");
  assert.equal(gobA.system.stamina.value, 20);
  // The author applies the rest.
  await as(player, () => api.applyOps(msg.id));
  assert.equal(getResolution(msg).ops[idB].status, "applied");
  assert.equal(gobB.system.stamina.value, 14);
  await api.undoOps(msg.id);
  reset();
  restore();
  console.log("ok authorization table (author, owner of targets, own undo, refused list)");
}

/* ---------- skipped ops are the Director's override ---------- */
{
  set("cardActionRole", 1);
  gobA.system.stamina.temporary = 9;
  const msg = postAbility(ability(), { 1: [tA] }, { 1: [{ total: 3, options: { isHeal: true, type: "temporary" } }] }, { author: player });
  await settle();
  const op = Object.values(getResolution(msg).ops)[0];
  assert.equal(op.status, "skipped");
  const pv = await as(player, () => buildView(msg, getResolution(msg)));
  assert.ok(!pv.rows[0].ops[0].canApply, "player cannot override a skip");
  assert.ok(buildView(msg, getResolution(msg)).rows[0].ops[0].canApply, "GM can");
  await rejects(as(player, () => api.applyOps(msg.id, [op.opId])), "DSAUTO.Relay.Denied");
  reset();
  restore();
  console.log("ok skipped ops GM-only");
}

/* ---------- T10: heroOverride and playerAuthoredMode ---------- */
{
  const npc = new Actor({ uuid: "Actor.npc0000000000001", name: "Ogre", type: "npc" });
  registry.set(npc.uuid, npc);
  const npcItem = makeAbility({ uuid: "Actor.npc0000000000001.Item.club000000000001", name: "Club", actor: npc });

  set("heroOverride", "prompt");
  let msg = postAbility(npcItem, { 2: [heroTok, tA] }, { 2: [{ total: 4 }] });
  await settle();
  let ops = Object.values(getResolution(msg).ops);
  const heroOp = ops.find(o => o.targetKeys[0].includes("tokH"));
  const gobOp = ops.find(o => o.targetKeys[0].includes("tokA"));
  assert.equal(heroOp.mode, "prompt");
  assert.equal(heroOp.status, "pending", "hero rows wait");
  assert.equal(gobOp.status, "applied", "non-hero rows still automatic");
  assert.equal(hero.system.stamina.value, hero.system.stamina.max);
  assert.equal(getResolution(msg).modes.heroOverride, "prompt");
  await api.applyOps(msg.id, [heroOp.opId]);
  assert.equal(hero.system.stamina.value, hero.system.stamina.max - 4, "GM confirms the hero row");
  await api.undoOps(msg.id);

  set("heroOverride", "manual");
  msg = postAbility(npcItem, { 2: [heroTok] }, { 2: [{ total: 4 }] });
  await settle();
  const op = Object.values(getResolution(msg).ops)[0];
  assert.equal(op.mode, "manual");
  assert.ok(buildView(msg, getResolution(msg)).rows[0].ops[0].canApply, "manual row has its Apply button");

  // heroOverride can also loosen: auto on heroes while damage asks.
  set("heroOverride", "auto");
  set("damageMode", "prompt");
  msg = postAbility(npcItem, { 2: [heroTok, tA] }, { 2: [{ total: 2 }] });
  await settle();
  ops = Object.values(getResolution(msg).ops);
  assert.equal(ops.find(o => o.targetKeys[0].includes("tokH")).status, "applied");
  assert.equal(ops.find(o => o.targetKeys[0].includes("tokA")).status, "pending");
  await api.undoOps(msg.id);
  set("damageMode", "off");
  msg = postAbility(npcItem, { 2: [heroTok] }, { 2: [{ total: 2 }] });
  await settle();
  assert.equal(Object.keys(getResolution(msg).ops).length, 0, "off stays off for heroes");
  reset();

  // playerAuthoredMode caps player cards only, and wins over a looser hero override.
  set("playerAuthoredMode", "prompt");
  set("heroOverride", "auto");
  const pmsg = postAbility(ability(), { 2: [tA, heroTok] }, { 2: [{ total: 3 }] }, { author: player });
  const gmsg = postAbility(ability(), { 2: [tA] }, { 2: [{ total: 3 }] });
  await settle();
  assert.ok(Object.values(getResolution(pmsg).ops).every(o => o.status === "pending" && o.mode === "prompt"), "player card waits");
  assert.equal(getResolution(pmsg).modes.playerAuthored, "prompt");
  assert.equal(Object.values(getResolution(gmsg).ops)[0].status, "applied", "GM card unaffected");
  await api.undoOps(gmsg.id);
  set("playerAuthoredMode", "manual");
  const pmsg2 = postAbility(ability(), { 2: [tA] }, { 2: [{ total: 3 }] }, { author: player });
  await settle();
  assert.equal(Object.values(getResolution(pmsg2).ops)[0].mode, "manual");
  // The player's manual Apply relays to the GM once the role floor allows it.
  set("cardActionRole", 1);
  await as(player, () => api.applyOps(pmsg2.id));
  assert.equal(Object.values(getResolution(pmsg2).ops)[0].status, "applied");
  assert.equal(gobA.system.stamina.value, 17);
  await api.undoOps(pmsg2.id);
  reset();
  restore();
  console.log("ok T10 heroOverride / playerAuthoredMode / player manual apply relays");
}

/* ---------- two GMs: only the active GM writes; others relay ---------- */
{
  set("damageMode", "prompt");
  const msg = postAbility(ability(), { 1: [tA] }, { 1: [{ total: 5 }] });
  await settle();
  const id = Object.keys(getResolution(msg).ops)[0];
  const direct = await as(gm2, () => engine.applyOps(msg, [id]));
  assert.equal(direct, null, "engine refuses on a non-active GM");
  assert.equal(gobA.system.stamina.value, 20);
  await as(gm2, () => api.applyOps(msg.id, [id]));
  assert.equal(getResolution(msg).ops[id].status, "applied", "second GM's click relayed to the active GM");
  assert.equal(getResolution(msg).ops[id].byUserId, "g2");
  assert.equal(msg.updates, 2, "one write for resolve, one for the relayed apply");
  // No active GM: requests fail cleanly.
  setActiveGM(null);
  await rejects(as(player, () => api.undoOps(msg.id)), "DSAUTO.Relay.NoActiveGM");
  setActiveGM(gm);
  await api.undoOps(msg.id);
  reset();
  restore();
  console.log("ok two-GM routing / no active GM");
}

/* ---------- retarget and resolve rules ---------- */
{
  set("damageMode", "prompt");
  const msg = postAbility(ability(), {}, {}, { author: player, extraParts: { tier2Result00000: { _id: "tier2Result00000", type: "abilityResult", tier: 2, rolls: [new ds.rolls.PowerRoll(12, { tier: 2 }), new ds.rolls.DamageRoll(4, {})] } } });
  await settle();
  const pv = await as(player, () => buildView(msg, getResolution(msg)));
  assert.ok(pv.canRetarget, "author may fix a forgotten target below the role floor");
  assert.ok(!(await as(player2, () => buildView(msg, getResolution(msg)))).canRetarget, "others may not");
  await rejects(as(player2, () => api.retarget(msg.id, [tB.document.uuid])), "DSAUTO.Relay.Denied");
  await as(player, () => api.retarget(msg.id, [tA.document.uuid]));
  const id = Object.keys(getResolution(msg).ops)[0];
  assert.ok(id?.includes("tokA"), "player retarget rebuilt the card");
  await api.applyOps(msg.id);
  // Something applied: below the floor the author can no longer retarget.
  assert.ok(!(await as(player, () => buildView(msg, getResolution(msg)))).canRetarget);
  await rejects(as(player, () => api.retarget(msg.id, [tB.document.uuid])), "DSAUTO.Relay.Denied");
  set("cardActionRole", 1);
  await as(player, () => api.retarget(msg.id, [tB.document.uuid]));
  assert.ok(Object.keys(getResolution(msg).ops).some(k => k.includes("tokB")), "above the floor the author may");
  await api.undoOps(msg.id);
  reset();
  restore();

  // Resolve: posted with no GM; the author may resolve, others not; force is GM only.
  setActiveGM(null);
  const m2 = postAbility(ability(), { 1: [tA] }, { 1: [{ total: 2 }] }, { author: player });
  await settle();
  setActiveGM(gm);
  assert.ok(!getResolution(m2).resolvedAt);
  getResolution(m2).createdAt -= 60_000;
  const banner = (await as(player, () => buildView(m2, getResolution(m2)))).banners[0];
  assert.equal(banner.action, "dsAutoResolve", "author gets Resolve now once the card is old");
  assert.ok(!(await as(player2, () => buildView(m2, getResolution(m2)))).banners[0].action, "others only see the wait text");
  await rejects(as(player2, () => api.resolve(m2.id)), "DSAUTO.Relay.Denied");
  await rejects(as(player, () => api.resolve(m2.id, { force: true })), "DSAUTO.Relay.Denied");
  await as(player, () => api.resolve(m2.id));
  assert.ok(getResolution(m2).resolvedAt);
  assert.equal(gobA.system.stamina.value, 18);
  await api.undoOps(m2.id);
  restore();
  console.log("ok retarget / resolve rules");
}

/* ---------- malformed requests ---------- */
{
  const msg = postAbility(ability(), { 1: [tA] }, { 1: [{ total: 1 }] });
  await settle();
  await rejects(as(player, () => requestOp({ action: "nuke", messageId: msg.id })), "DSAUTO.Relay.BadRequest");
  await rejects(as(player, () => requestOp({ action: "apply", messageId: msg.id, opIds: "x" })), "DSAUTO.Relay.BadRequest");
  await rejects(as(player, () => requestOp({ action: "retarget", messageId: msg.id, tokenUuids: [1] })), "DSAUTO.Relay.BadRequest");
  await rejects(as(player, () => requestOp({ action: "apply", messageId: "nope" })), "DSAUTO.Relay.UnknownCard");
  await requestOp({ action: "undo", messageId: msg.id, opIds: [] });
  assert.equal(Object.values(getResolution(msg).ops)[0].status, "applied", "an empty list is not 'all'");
  await api.undoOps(msg.id);
  restore();
  console.log("ok malformed requests");
}

/* ---------- respectDstdApplications off: no external detection ---------- */
{
  setDstd(true);
  set("respectDstdApplications", false);
  set("damageMode", "prompt");
  const msg = postAbility(ability(), { 1: [tA] }, { 1: [{ total: 3 }] });
  await settle();
  const id = Object.keys(getResolution(msg).ops)[0];
  const rec = { kind: "damage", status: "applied", partId: "tier1Result00000", rollIndex: 1, target: { tokenUuid: tA.document.uuid } };
  await msg.update({ "flags.draw-steel-target-damage.state.applications": { x: rec } });
  await settle();
  assert.equal(getResolution(msg).ops[id].status, "pending", "no reconcile");
  await api.applyOps(msg.id, [id]);
  assert.equal(getResolution(msg).ops[id].status, "applied", "applied despite the Target Damage record");
  await api.undoOps(msg.id);
  set("respectDstdApplications", true);
  setDstd(false);
  reset();
  restore();
  console.log("ok respectDstdApplications off");
}

/* ---------- numbers hidden from non-owners (immunity, potency resist) ---------- */
{
  set("cardActionRole", 1);
  const applied = {
    tier2: { potency: { characteristic: "might", value: "@potency.average" }, effects: { slowed: { condition: "failure", end: "save", properties: new Set() } } },
  };
  const msg = postAbility(ability({ applied }), { 2: [tA] }, { 2: [{ total: 5, options: { type: "fire" } }] }, { author: player });
  await settle();
  const res = getResolution(msg);
  const pv = await as(player, () => buildView(msg, res));
  const ops = pv.rows[0].ops;
  const dmg = ops.find(o => o.kind === "damage");
  const cond = ops.find(o => o.kind === "condition");
  assert.ok(!dmg.detail.includes("Immunity"), "immunity hidden from the player");
  assert.ok(cond.detail.includes("PotencyFailsHidden") && !cond.detail.includes("resist"), "potency resist hidden");
  const gv = buildView(msg, res).rows[0].ops;
  assert.ok(gv.find(o => o.kind === "damage").detail.includes("Immunity"), "GM sees immunity");
  assert.ok(gv.find(o => o.kind === "condition").detail.includes("\"resist\""), "GM sees the resist value");
  gobA.owners.add("pl");
  const ownerView = await as(player, () => buildView(msg, res)).then(v => v.rows[0].ops);
  assert.ok(ownerView.find(o => o.kind === "damage").detail.includes("Immunity"), "owners see numbers");
  gobA.owners.delete("pl");
  await api.undoOps(msg.id);
  reset();
  restore();
  console.log("ok hidden numbers");
}

/* ---------- T14: player self roll is manual and hidden from the GM's automation; GM blind roll auto ---------- */
{
  const msg = postAbility(ability(), { 1: [tA] }, { 1: [{ total: 2 }] }, { author: player, whisper: ["pl"], isAuthor: false });
  await settle();
  const res = getResolution(msg);
  assert.ok(Object.values(res.ops).every(o => o.mode === "manual" && o.status === "pending"), "self roll: all manual");
  assert.ok(res.warnings.some(w => w.code === "privateCard"));
  const gmsg = postAbility(ability(), { 1: [tA] }, { 1: [{ total: 2 }] }, { whisper: ["gm"] });
  gmsg.blind = true;
  await settle();
  assert.equal(Object.values(getResolution(gmsg).ops)[0].status, "applied", "GM blind roll applies");
  await api.undoOps(gmsg.id);
  restore();
  console.log("ok T14 private / blind");
}

/* ---------- review finding 1: the author rewrites the record after resolution ---------- */
{
  const msg = postAbility(ability(), { 2: [tA] }, { 2: [{ total: 5 }] }, { author: player });
  await settle();
  const id = Object.keys(getResolution(msg).ops)[0];
  assert.equal(api.integrity(msg.id), "ok");
  assert.equal(gobA.system.stamina.value, 15);
  // The author owns the message: reset the card so a "Resolve" would apply the damage again.
  await msg.update({ "flags.stef-ds-automation.resolution.resolvedAt": null, [`flags.stef-ds-automation.resolution.ops.${id}.status`]: "pending" }, { userId: "pl" });
  await settle();
  assert.equal(api.integrity(msg.id), "tampered");
  assert.equal(getResolution(msg).tampered?.state, "tampered", "the GM marked the card");
  assert.ok(buildView(msg, getResolution(msg)).banners.some(b => b.text === "DSAUTO.Card.TamperedGM"), "GM banner");
  const lockedView = await as(player, () => buildView(msg, getResolution(msg)));
  assert.ok(!lockedView.showFooter && lockedView.rows.every(r => r.ops.every(o => !o.canApply && !o.canUndo)), "no buttons on a locked card");
  assert.ok(!lockedView.banners.some(b => b.action), "no Resolve now on a locked card");
  await rejects(as(player, () => api.resolve(msg.id)), "DSAUTO.Relay.Tampered");
  await rejects(as(player, () => api.retarget(msg.id, [tB.document.uuid])), "DSAUTO.Relay.Tampered");
  await rejects(api.undoOps(msg.id), "DSAUTO.Relay.Tampered");
  assert.equal(gobA.system.stamina.value, 15, "nothing applied twice");
  // Forged undo snapshot on a signed card: also refused.
  await msg.update({ [`flags.stef-ds-automation.resolution.ops.${id}`]: { status: "applied", before: { value: 99, temporary: 0 }, after: { value: 15, temporary: 0 } } }, { userId: "pl" });
  await rejects(api.undoOps(msg.id), "DSAUTO.Relay.Tampered");
  assert.equal(gobA.system.stamina.value, 15);
  // The GM checks and accepts the current record.
  await api.trustCard(msg.id);
  assert.equal(api.integrity(msg.id), "ok");
  assert.ok(!getResolution(msg).tampered);
  restore();
  console.log("ok tampered record locked / trustCard");
}

/* ---------- review findings 1, 2, 4: a forged seed ---------- */
{
  set("playerAuthoredMode", "manual");
  const msg = postAbility(ability(), { 2: [tA] }, { 2: [{ total: 5 }] }, {
    author: player,
    forge: (seed) => {
      seed.authorRole = 4;                                    // claims to be a GM card
      seed.sourceActorUuid = "Actor.whatever";
      const key = Object.keys(seed.targets)[0];
      seed.targets[key].actorUuid = gobB.uuid;                // token A, but "actor B"
      seed.ops = { evil: { opId: "evil", kind: "damage", status: "applied", targetKeys: [key], before: { value: 99, temporary: 0 }, after: { value: 20, temporary: 0 } } };
    },
  });
  await settle();
  const res = getResolution(msg);
  assert.equal(api.integrity(msg.id), "ok");
  assert.ok(!res.ops.evil, "seeded ops are dropped at the first resolution");
  assert.equal(res.authorRole, 1, "author role from the server's author");
  assert.equal(res.sourceActorUuid, hero.uuid, "source actor from the ability");
  assert.equal(Object.values(res.targets)[0].actorUuid, gobA.uuid, "target rebuilt from its token");
  assert.ok(Object.values(res.ops).every(o => o.mode === "manual" && o.status === "pending"), "player cap applies despite the forged role");
  await api.applyOps(msg.id);
  assert.equal(gobA.system.stamina.value, 15, "damage hits the token's actor");
  assert.equal(gobB.system.stamina.value, 20);
  await api.undoOps(msg.id);
  assert.equal(gobA.system.stamina.value, 20);
  reset();

  // A seed claiming to be resolved already is never resolved and stays locked.
  const m2 = postAbility(ability(), { 1: [tA] }, { 1: [{ total: 3 }] }, {
    author: player,
    forge: (seed) => {
      seed.resolvedAt = 1;
      seed.ops = { evil: { opId: "evil", kind: "damage", status: "applied", targetKeys: [Object.keys(seed.targets)[0]], before: { value: 99, temporary: 0 }, after: { value: 20, temporary: 0 } } };
    },
  });
  await settle();
  assert.equal(api.integrity(m2.id), "unsigned");
  await rejects(api.undoOps(m2.id), "DSAUTO.Relay.Tampered");
  assert.equal(gobA.system.stamina.value, 20);
  restore();
  console.log("ok forged seed (ops, author role, source, target actor, resolved claim)");
}

/* ---------- review findings 3 and 6: retarget limits, prompt rows ---------- */
{
  set("cardActionRole", 1);
  set("damageMode", "prompt");
  const msg = postAbility(ability(), { 1: [tA] }, { 1: [{ total: 3 }] }, { author: player });
  await settle();
  const op = Object.values(getResolution(msg).ops)[0];
  assert.ok(!(await as(player, () => buildView(msg, getResolution(msg)))).rows[0].ops[0].canApply, "prompt rows wait for the Director");
  await rejects(as(player, () => api.applyOps(msg.id, [op.opId])), "DSAUTO.Relay.Denied");
  tB.document.hidden = true;
  await rejects(as(player, () => api.retarget(msg.id, [tB.document.uuid])), "DSAUTO.Relay.Denied");
  tB.document.hidden = false;
  tB.document.parent = { id: "otherScene000001" };
  await rejects(as(player, () => api.retarget(msg.id, [tB.document.uuid])), "DSAUTO.Relay.Denied");
  await api.retarget(msg.id, [tB.document.uuid]); // the GM may
  tB.document.parent = { id: "scene00000000001" };
  await as(player, () => api.retarget(msg.id, [tA.document.uuid]));
  assert.ok(Object.keys(getResolution(msg).ops).some(k => k.includes("tokA")));
  reset();
  restore();
  console.log("ok retarget token limits / prompt rows GM-only");
}

/* ---------- ledger: saved to the world setting; 0.1.x cards are trusted once ---------- */
{
  const ledger = await import(pathToFileURL(ROOT + "engine/ledger.mjs").href);
  const msg = postAbility(ability(), { 1: [tA] }, { 1: [{ total: 1 }] });
  await settle();
  await api.undoOps(msg.id);
  await new Promise(r => setTimeout(r, 300)); // debounced save
  assert.ok(game.settings.get("stef-ds-automation", "ledger").h[msg.id], "signature saved to the world setting");
  await game.settings.set("stef-ds-automation", "ledger", { v: 0, h: {} });
  ledger.resetLedgerCache();
  assert.equal(api.integrity(msg.id), "unsigned");
  ledger.migrateLedger();
  assert.equal(api.integrity(msg.id), "ok");
  await new Promise(r => setTimeout(r, 300));
  assert.equal(game.settings.get("stef-ds-automation", "ledger").v, 1);
  assert.ok(game.settings.get("stef-ds-automation", "ledger").h[msg.id]);
  restore();
  console.log("ok ledger save / migration");
}

console.warn = origWarn;
console.log("\nALL HARNESS-3 TESTS PASSED");
