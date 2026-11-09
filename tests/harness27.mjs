/**
 * 1.2.0: Death Tracker deaths belong to the card that caused them. The cause is noted before every op that can deal
 * damage (batch, forced move, teleport, single-row applies, picker), the Automation box shows a "Fallen" row for a
 * linked death (ui/death-fold.mjs, parts/view.mjs) and Death Tracker's own card is hidden only when fully linked.
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const paths = createRequire(import.meta.url)("./paths.cjs");
const imp = p => import(pathToFileURL(paths.SCRIPTS + p).href);
globalThis.__HARNESS_SKIP_SCENARIOS__ = true;
const h = await import("./harness.mjs");
const { postAbility, makeAbility, settle, hero, tA, gobA, api, getResolution, buildView, messages } = h;
const { noteCardCause } = await imp("compat/death-tracker.mjs");
const { fallenFor, shouldHideDeathMessage, tokenIdOfUuid, applyDeathFold, DEATH_FOLD_CLASS } = await imp("ui/death-fold.mjs");
const { sign } = await imp("engine/ledger.mjs");
const DT = "draw-steel-death-tracker";

/* ---------- cause noted ---------- */
const noted = [];
game.modules.set("draw-steel-ctlib", { active: true });
globalThis.ctlib = { services: new Map([["noteDamageCause", payload => noted.push(payload)]]) };

noteCardCause({ id: "cardX" }, { authorUserId: "u1", sourceActorUuid: "Actor.a" });
assert.deepEqual(noted.pop(), { userId: "u1", sourceActorUuid: "Actor.a", messageId: "cardX", stated: true });
noteCardCause(null, {});
assert.equal(noted.length, 0, "no card, no note");

const item = makeAbility({ uuid: "Actor.hero000000000001.Item.strike0000000001", name: "Strike", actor: hero });
const msg = postAbility(item, { 2: [tA] }, { 2: [{ total: 4, options: {} }] });
await settle();
assert.ok(getResolution(msg)?.resolvedAt);
assert.ok(noted.length >= 1 && noted.every(n => n.messageId === msg.id), "the damage batch links its deaths to the card");

// Single-row applies of movement ops (they run outside the damage batch): each notes right before it runs.
const res0 = getResolution(msg);
const key = Object.keys(res0.targets)[0];
for (const kind of ["forced", "teleport"]) {
  noted.length = 0;
  const opId = `n-${kind}`;
  const op = kind === "forced"
    ? { opId, kind, status: "pending", movement: "push", movements: ["push"], distances: { push: 2 }, properties: [], targetKeys: [key], order: 50 }
    : { opId, kind, status: "pending", distance: 3, targetKeys: [key], order: 51 };
  msg.flags["stef-ds-automation"].resolution.ops[opId] = op;
  sign(msg);
  await api.applyOps(msg.id, [opId]);
  assert.ok(noted.length >= 1 && noted.every(n => n.messageId === msg.id && n.userId === res0.authorUserId), `${kind} row notes the cause before it runs`);
}
delete globalThis.ctlib;
game.modules.delete("draw-steel-ctlib");

/* ---------- Fallen decision ---------- */
const death = (over = {}) => ({ flags: { [DT]: { isDeathMessage: true, deadTokenIds: ["tk1"], deaths: [{ tokenId: "tk1", name: "Radenwight", isObject: false }], cause: { messageId: "card1" }, ...over } } });
const dead = ids => id => ids.includes(id);
assert.equal(tokenIdOfUuid("Scene.s1.Token.tk1"), "tk1");
assert.equal(tokenIdOfUuid(null), null);
assert.deepEqual(fallenFor({ cardId: "card1", tokenId: "tk1", messages: [death()], isDefeated: dead(["tk1"]) }), { object: false }, "linked + defeated");
assert.equal(fallenFor({ cardId: "card1", tokenId: "tk1", messages: [death()], isDefeated: dead([]) }), null, "revived");
assert.equal(fallenFor({ cardId: "card1", tokenId: "tk1", messages: [death({ cause: { messageId: null } })], isDefeated: dead(["tk1"]) }), null, "unlinked");
assert.equal(fallenFor({ cardId: "card1", tokenId: "tk1", messages: [death({ cause: { messageId: "other" } })], isDefeated: dead(["tk1"]) }), null, "another card");
assert.equal(fallenFor({ cardId: "card1", tokenId: "tk2", messages: [death()], isDefeated: dead(["tk1", "tk2"]) }), null, "another token");
assert.deepEqual(fallenFor({ cardId: "card1", tokenId: "tk1", messages: [death({ deaths: [{ tokenId: "tk1", isObject: true }] })], isDefeated: dead(["tk1"]) }), { object: true }, "object: Destroyed");
assert.deepEqual(fallenFor({ cardId: "card1", tokenId: "tk1", messages: [death({ deaths: [] })], isDefeated: dead(["tk1"]) }), { object: false }, "deadTokenIds only");
assert.equal(fallenFor({ cardId: "card1", tokenId: "tk1", messages: [{ flags: {} }], isDefeated: dead(["tk1"]) }), null);

/* ---------- hide decision ---------- */
const withRecord = { id: "card1", flags: { "stef-ds-automation": { resolution: { ops: {} } } } };
const plain = { id: "card2", flags: {} };
const lookup = id => ({ card1: withRecord, card2: plain })[id];
assert.equal(shouldHideDeathMessage(death(), { getMessage: lookup, enabled: true }), true, "linked to a card with our record");
assert.equal(shouldHideDeathMessage(death({ cause: { messageId: null } }), { getMessage: lookup, enabled: true }), false, "no messageId");
assert.equal(shouldHideDeathMessage(death({ cause: { messageId: "card2" } }), { getMessage: lookup, enabled: true }), false, "card without our record");
assert.equal(shouldHideDeathMessage(death({ cause: { messageId: "gone" } }), { getMessage: lookup, enabled: true }), false, "card missing");
assert.equal(shouldHideDeathMessage(death(), { getMessage: lookup, enabled: false }), false, "suite disabled");
assert.equal(shouldHideDeathMessage({ flags: {} }, { getMessage: lookup, enabled: true }), false, "not a death message");

// The hook toggles the class on the rendered li.
const li = { classList: { set: new Set(), toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); }, contains(c) { return this.set.has(c); } } };
messages.set("card1", withRecord);
assert.equal(applyDeathFold(death(), li), true);
assert.ok(li.classList.contains(DEATH_FOLD_CLASS));
assert.equal(applyDeathFold(death({ cause: { messageId: null } }), li), false);
assert.ok(!li.classList.contains(DEATH_FOLD_CLASS), "a link that is gone shows the card again");
messages.delete("card1");

// The box: a defeated, linked target gets the Fallen row.
{
  const res = getResolution(msg);
  const t = res.targets[key];
  const tokenId = tokenIdOfUuid(t.tokenUuid);
  const deathMsg = { id: "dm1", flags: { [DT]: { isDeathMessage: true, deadTokenIds: [tokenId], deaths: [{ tokenId, isObject: false }], cause: { messageId: msg.id } } } };
  messages.set("dm1", deathMsg);
  const doc = fromUuidSync(t.tokenUuid);
  const had = doc?.actor?.statuses?.has?.("dead");
  assert.ok(doc?.actor?.statuses, "token actor resolves");
  {
    doc.actor.statuses.add("dead");
    const row = buildView(msg, res).rows.find(r => r.key === key);
    assert.equal(row.fallen, "DSAUTO.Row.Fallen", "linked + defeated shows the row");
    deathMsg.flags[DT].deaths[0].isObject = true;
    assert.equal(buildView(msg, res).rows.find(r => r.key === key).fallen, "DSAUTO.Row.Destroyed");
    doc.actor.statuses.delete("dead");
    assert.ok(!buildView(msg, res).rows.find(r => r.key === key).fallen, "revived: no row");
    if (had) doc.actor.statuses.add("dead");
  }
  messages.delete("dm1");
}
console.log("ALL HARNESS-27 TESTS PASSED");
