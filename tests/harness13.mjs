/** Regression tests for player choices, recovery commits, source auras and dependent effects. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const paths = createRequire(import.meta.url)("./paths.cjs");
const imp = p => import(pathToFileURL(paths.SCRIPTS + p).href);
const { w, hero, gobA, gobB, token, scene, combat, feature, rule, executeRule, featureRules, registry, messages, getResolution, docs } = await import("./harness12.mjs");
const { applyRecoveries } = await imp("engine/library-apply.mjs");
const { targetFromTokenDoc } = await imp("engine/targets.mjs");
const { prepareSurgeChoice } = await imp("ui/surge-choice.mjs");
const { registerPromptType } = await imp("relay/prompt-router.mjs");
const { opSource } = await imp("engine/damage.mjs");
const { paySurges, refundSurges } = await imp("engine/surges.mjs");
const { applyMoveOp } = await imp("engine/forced.mjs");
const { validForcedPath, validDestination } = await imp("delegation/selected-movement.mjs");
const { setAura, refreshAuras, auraPotencyBonus, purchaseNullOption } = await imp("features/auras.mjs");
const { aloneEligible, grantAlone } = await imp("features/alone.mjs");
const { temporarySnapshot, reconcileTemporaryStamina, restoreTemporaryEffects, temporaryExplosionOps } = await imp("features/temporary-stamina.mjs");
const { prepareJudgementBenefits } = await imp("features/judgement.mjs");
const { postRecordCard } = await imp("engine/synthetic.mjs");
const { undoOps } = await imp("engine/engine.mjs");
const MOD = "stef-ds-automation";
for (const a of [hero, gobA, gobB]) { a.effects.clear(); a.statuses.clear(); a.flags = {}; a.items.clear(); }
hero.getRollData = () => ({ chr: 3, M: 3, A: 2, R: 2, I: 2, P: 2 });
game.settings.set(MOD, "playerAuthoredMode", "manual");
game.settings.set(MOD, "modeConditionNpc", "auto");
game.settings.set(MOD, "libraryDefersToCombatTools", false);
const target = targetFromTokenDoc(token), res = { targets: { [target.key]: target } };
hero.system.recoveries = { value: 3, max: 5, recoveryValue: 10 };
hero.system.stamina = { value: 10, max: 50, min: 0, temporary: 0 };
const healing = await applyRecoveries({}, res, { targetKeys: [target.key], recoveries: 1 });
assert.equal(healing.status, "applied"); assert.equal(hero.system.stamina.value, 20); assert.equal(hero.system.recoveries.value, 2);
const modify = hero.modifyTokenAttribute;
hero.modifyTokenAttribute = async () => hero;
await assert.rejects(applyRecoveries({}, res, { targetKeys: [target.key], recoveries: 1 }));
assert.equal(hero.system.recoveries.value, 2, "refused healing refunds its Recovery"); hero.modifyTokenAttribute = modify;
const limerick = feature("Revitalizing Limerick", hero, "ability", "revitalizing-limerick");
limerick.system.distance = { type: "aura", primary: 3 };
hero.flags[MOD] = { performances: { items: [limerick.uuid] } };
registerPromptType("featureRule", async p => p.kind === "targets" ? { ids: [token.uuid] } : { accepted: true });
const beforeHeal = hero.system.stamina.value;
const recoveryCard = await executeRule(limerick, featureRules(limerick)[0], { sceneId: scene.id, user: w.users.player, id: "limerick-heal" });
assert.equal(hero.system.stamina.value, beforeHeal + 10, "player-authored Limerick commits healing");
assert.equal(hero.system.recoveries.value, 1); await undoOps(messages.get(recoveryCard.messageId));
assert.equal(hero.system.stamina.value, beforeHeal); assert.equal(hero.system.recoveries.value, 2);
console.log("ok accepted Limerick recovery, rollback on refusal and Undo");

const strike = feature("Attack", hero, "ability"); strike.system.power = { roll: { enabled: true } };
hero.system.hero.surges = 3;
registerPromptType("surgeChoice", async p => Object.fromEntries(p.rows.map(r => [r.id, 2])));
const hit = { opId: "hit", kind: "damage", lib: true, amount: 7, targetKeys: [target.key], status: "pending" };
const surgeRes = { sourceActorUuid: hero.uuid, abilityUuid: strike.uuid, targets: res.targets, ops: { hit } };
const authorMessage = { author: game.user };
await prepareSurgeChoice(authorMessage, surgeRes, [hit]);
assert.equal(hit.surgeSpend.count, 2); assert.equal(opSource({}, hit).total, 13);
assert.equal(await paySurges(hit), true); assert.equal(hero.system.hero.surges, 1);
await refundSurges(hit, 2); assert.equal(hero.system.hero.surges, 3);
const compete = [{ surgeSpend: { actorUuid: hero.uuid, count: 2 } }, { surgeSpend: { actorUuid: hero.uuid, count: 2 } }];
assert.deepEqual(await Promise.all(compete.map(paySurges)), [true, false], "concurrent spends serialize");
hero.system.hero.surges = 3;
const reflected = { ...hit, opId: "reflected", surgeSpend: null, surgeChoiceDone: false, auraCauseOpId: "hit" };
await prepareSurgeChoice(authorMessage, surgeRes, [reflected]); assert.equal(reflected.surgeSpend, null, "reflections do not spend the attacker surges");
console.log("ok post-roll surge allocation, damage and serialized payment/refund");
// 0.17.0: one dialog for damage and potency; the total stays within the hero's surges.
{
  const { validSurgeChoice } = await imp("ui/surge-choice.mjs");
  hero.system.hero.surges = 3;
  const resisted = (id) => ({ opId: id, kind: "condition", status: "skipped", reason: "resisted", statusId: "bleeding", label: "Bleeding", targetKeys: [target.key], potency: { value: 2, resist: 2, characteristic: "might", fails: false } });
  let asked = null;
  registerPromptType("surgeChoice", async p => { asked = p; return { damage: { hit2: 1 }, potency: ["bleed"] }; });
  const hit2 = { opId: "hit2", kind: "damage", lib: true, amount: 7, targetKeys: [target.key], status: "pending" };
  const lands = { ...resisted("lands"), potency: { value: 3, resist: 2, characteristic: "might", fails: true } };
  const far = { ...resisted("far"), potency: { value: 1, resist: 2, characteristic: "might", fails: false } };
  const pRes = { sourceActorUuid: hero.uuid, abilityUuid: strike.uuid, targets: res.targets, ops: { hit2, bleed: resisted("bleed"), lands, far } };
  const list = [hit2];
  await prepareSurgeChoice(authorMessage, pRes, list, { patches: {} });
  assert.equal(validSurgeChoice(asked), true, "payload passes its validator");
  assert.deepEqual(asked.potency.map(r => r.id), ["bleed"], "potency only where +1 makes it land");
  assert.equal(hit2.surgeSpend.count, 1, "damage surge kept");
  const raised = list.find(o => o.opId === "bleed");
  assert.ok(raised, "the condition joins the call's list");
  assert.equal(raised.status, "pending"); assert.equal(raised.potency.value, 3); assert.equal(raised.potency.fails, true);
  assert.deepEqual(raised.surge, { kind: "potency", count: 2, actorUuid: hero.uuid });

  registerPromptType("surgeChoice", async () => ({ damage: { hit3: 3 }, potency: ["bleed3"] }));
  const hit3 = { opId: "hit3", kind: "damage", lib: true, amount: 7, targetKeys: [target.key], status: "pending" };
  const overRes = { sourceActorUuid: hero.uuid, abilityUuid: strike.uuid, targets: res.targets, ops: { hit3, bleed3: resisted("bleed3") } };
  const overList = [hit3];
  await prepareSurgeChoice(authorMessage, overRes, overList, { patches: {} });
  assert.equal(hit3.surgeSpend.count, 3); assert.equal(overList.length, 1, "over budget: the potency spend is dropped");

  const moveRes = { sourceActorUuid: hero.uuid, abilityUuid: strike.uuid, targets: res.targets,
    ops: { hit4: { opId: "hit4", kind: "damage", lib: true, amount: 7, targetKeys: [target.key], status: "pending" }, push: { ...resisted("push"), kind: "forced" } } };
  registerPromptType("surgeChoice", async () => ({ damage: {}, potency: ["push"] }));
  const movePatches = {};
  const moveList = [moveRes.ops.hit4];
  await prepareSurgeChoice(authorMessage, moveRes, moveList, { patches: movePatches });
  assert.equal(moveList.length, 1, "a move is not applied inside the damage call");
  assert.equal(movePatches.push.status, "pending"); assert.equal(movePatches.push.potencyChoiceDone, true);

  registerPromptType("surgeChoice", async () => ({ damage: {}, potency: ["bleed5"] }));
  const blockedRes = { sourceActorUuid: hero.uuid, abilityUuid: strike.uuid, targets: res.targets,
    ops: { hit5: { opId: "hit5", kind: "damage", lib: true, amount: 7, targetKeys: [target.key], status: "pending" }, bleed5: resisted("bleed5") } };
  const blockedList = [blockedRes.ops.hit5];
  await prepareSurgeChoice(authorMessage, blockedRes, blockedList, { potencyBlocked: () => true, patches: {} });
  assert.equal(blockedList.length, 1, "1.2: a part with the system's potency adjustment takes none");
  registerPromptType("surgeChoice", async p => Object.fromEntries(p.rows.map(r => [r.id, 2])));
  hero.system.hero.surges = 3;
  console.log("ok 0.17.0 surge dialog: damage dropdowns, potency +1, budget, moves, 1.2 refusal");
}
const insight = feature("Insight", hero, "feature", "insight");
(await imp("resources/rules.mjs")).clearRuleCache();
game.settings.set(MOD, "resourceGains", "auto");
hero.system.hero.primary.value = 0; hero.system.hero.surges = 3;
const surgeVictim = targetFromTokenDoc(docs[1]); gobA.system.stamina = { value: 50, max: 50, min: 0, temporary: 0 };
const attackWithSurges = async () => postRecordCard({ title: "Surge attack", sourceActor: hero, abilityUuid: strike.uuid, sourceTokenUuid: token.uuid, user: game.user, targets: { [surgeVictim.key]: surgeVictim },
  ops: { hit: { opId: "hit", kind: "damage", lib: true, amount: 5, type: "", mode: "auto", status: "pending", targetKeys: [surgeVictim.key], surgeSpend: { count: 1, actorUuid: hero.uuid, perSurge: 3 } } } });
const insightCard = await attackWithSurges();
assert.equal(gobA.system.stamina.value, 42); assert.equal(hero.system.hero.primary.value, 1, "damage with surges grants Insight");
await attackWithSurges(); assert.equal(hero.system.hero.primary.value, 1, "only first surge damage each round grants Insight");
await undoOps(messages.get(insightCard.messageId)); assert.equal(hero.system.hero.primary.value, 0, "Undo reverses the Insight grant");
console.log("ok Shadow Insight from incorporated surges, once per round and Undo");


token.x = 0; token.y = 100; token.elevation = 0;
token.update = async function(p) { Object.assign(this, p); return this; };
const teleportRes = { ...surgeRes, sourceTokenUuid: token.uuid };
registerPromptType("movementChoice", async () => ({ destination: { x: 0, y: 300, elevation: 0 } }));
const teleport = { opId: "tp", kind: "teleport", distance: 3, targetKeys: [target.key] };
const moved = await applyMoveOp(authorMessage, teleportRes, teleport);
assert.equal(moved.status, "applied"); assert.equal(token.y, 300);
registerPromptType("movementChoice", async () => ({ declined: true }));
assert.equal((await applyMoveOp(authorMessage, teleportRes, teleport)).status, "skipped");
assert.equal(validDestination(token, { x: 9000, y: 9000 }, { distance: 3 }), false);
token.x = 0; token.y = 100; gobA.system.combat = { stability: 0 };
const enemy = docs[1]; enemy.x = 100; enemy.y = 100;
assert.equal(validForcedPath(enemy, token, { movement: "push", path: [{ x: 2, y: 1 }], verticalDistance: 0 }, { distance: 2, movements: ["push"], vertical: false }), true);
assert.equal(validForcedPath(enemy, token, { movement: "push", path: [{ x: 0, y: 1 }] }, { distance: 2, movements: ["push"], vertical: false }), false);
console.log("ok local teleport proposal, decline and GM geometry");

// With Combat Tools' teleport API the recipient's owner picks in Combat Tools' teleport mode; the GM records the move.
const { noteMove } = await imp("engine/move-log.mjs");
const { combatToolsTeleport } = await imp("engine/forced.mjs");
const dsctCalls = [];
let dsctDestination = null;
game.modules.set("draw-steel-combat-tools", { active: true, api: { async teleport(opts) {
  dsctCalls.push({ ...opts, userId: game.user.id });
  if (!dsctDestination) return;
  const origin = { x: token.x, y: token.y, elevation: token.elevation };
  Object.assign(token, dsctDestination);
  noteMove(token, { origin, destination: { ...dsctDestination, elevation: token.elevation } }, {}, game.user);
} } });
const stepAnswers = [];
registerPromptType("teleportStep", async (payload, { user }) => {
  assert.equal(payload.step, "teleport"); assert.ok(user.isGM, "only the active GM asks");
  const next = stepAnswers.shift();
  if (next) return next;
  await game.modules.get("draw-steel-combat-tools").api.teleport({ distance: 3 });
  return { picked: true };
});
registerPromptType("movementChoice", async () => { throw new Error("the local proposal picker must not open with Combat Tools"); });
const ctRes = { ...teleportRes, resolvedAt: 0 };
const ctOp = extra => ({ opId: "ctp", kind: "teleport", distance: 3, selfMove: true, targetKeys: [target.key], ...extra });
const at = (x, y) => { token.x = x; token.y = y; token.elevation = 0; };
assert.equal(combatToolsTeleport(ctOp()), true);
assert.equal(combatToolsTeleport(ctOp({ synthetic: true })), false); assert.equal(combatToolsTeleport(ctOp({ teleportMode: "swap" })), false);
at(0, 100); dsctDestination = { x: 0, y: 300 };
const ctMoved = await applyMoveOp(authorMessage, ctRes, ctOp());
assert.equal(ctMoved.status, "applied"); assert.equal(ctMoved.delegated, "dsct"); assert.equal(ctMoved.byClient, true);
assert.deepEqual(ctMoved.moves[0].startPos, { x: 0, y: 100, elevation: 0 }); assert.equal(token.y, 300);
assert.equal(dsctCalls.length, 1, "Combat Tools' teleport mode opened once");
at(0, 100); dsctDestination = null;
const cancelled = await applyMoveOp(authorMessage, ctRes, ctOp());
assert.equal(cancelled.status, "pending", "a cancelled pick leaves Apply available"); assert.equal(cancelled.reason, "notMoved");
at(0, 100); dsctDestination = { x: 0, y: 900 };
const tooFar = await applyMoveOp(authorMessage, ctRes, ctOp());
assert.equal(tooFar.status, "failed"); assert.equal(tooFar.reason, "tooFar"); assert.equal(token.y, 100, "a refused move is rolled back");
const anchor = docs[1]; anchor.x = 500; anchor.y = 100;
at(0, 100); dsctDestination = { x: 0, y: 300 };
const notCloser = await applyMoveOp(authorMessage, ctRes, ctOp({ closerToTokenUuid: anchor.uuid }));
assert.equal(notCloser.status, "failed"); assert.equal(notCloser.reason, "badDestination"); assert.equal(token.y, 100);
at(0, 100); dsctDestination = { x: 200, y: 100 };
assert.equal((await applyMoveOp(authorMessage, ctRes, ctOp({ closerToTokenUuid: anchor.uuid }))).status, "applied", "Exorcist teleport ending closer");
at(0, 100); dsctDestination = { x: 100, y: 200 };
assert.equal((await applyMoveOp(authorMessage, ctRes, ctOp({ selfMove: false }))).status, "applied", "a recipient the GM asked may teleport");
// The owner's client cannot pick (other scene, offline): the active GM gets Combat Tools' picker.
const savedFilter = game.users.filter, savedPermission = hero.testUserPermission;
game.users.filter = fn => [w.users.player].filter(fn);
hero.testUserPermission = u => u.id === w.users.player.id;
at(0, 100); dsctDestination = { x: 0, y: 200 }; stepAnswers.push({ unavailable: true });
const calls = dsctCalls.length;
const fallback = await applyMoveOp({ author: w.users.player }, ctRes, ctOp());
assert.equal(fallback.status, "applied", "Director fallback"); assert.equal(dsctCalls.length, calls + 1); assert.equal(stepAnswers.length, 0);
game.users.filter = savedFilter; hero.testUserPermission = savedPermission;
// Without Combat Tools the local proposal picker is used.
game.modules.delete("draw-steel-combat-tools");
registerPromptType("movementChoice", async () => ({ declined: true }));
at(0, 100);
assert.equal(combatToolsTeleport(ctOp()), false);
assert.equal((await applyMoveOp(authorMessage, ctRes, ctOp())).status, "skipped");
anchor.x = 100; anchor.y = 100; // `enemy` again, adjacent for the tests below
console.log("ok Combat Tools teleport mode for owners, cancel, refusals with rollback, closer-to, Director fallback and proposal fallback");

// 0.17.0: a straight push asks nobody (Combat Tools' fastMove); a move that needs a pick runs in Combat Tools' own picker
// on the ability user's screen (prompt forcedStep). The Director's own pick is trusted; a player's answer must carry the
// moveId Combat Tools wrote on the target, stay within the row's distance, and only undo-log entries that put back what
// the Director's snapshot recorded are kept. A cancel leaves the row pending; "push or pull" asks first.
{
  const { straightForced } = await imp("engine/forced.mjs");
  const { cleanUndoLog, sceneSnapshot } = await imp("delegation/forced-picker.mjs");
  // The rollback writes the target back (moveTokenTo).
  if (typeof enemy.update !== "function") enemy.update = async data => Object.assign(enemy, foundry.utils.expandObject?.(data) ?? data);
  const fmCalls = [];
  const dsctMod = { active: true, version: "1.2.6", api: { async forcedMovement(spec) {
    fmCalls.push(spec);
    const from = { x: enemy.x, y: enemy.y };
    enemy.x = 300;
    return { undoLog: [{ op: "update", uuid: enemy.uuid, data: from }], content: "<p>moved</p>", moveId: "move-fast" };
  } } };
  game.modules.set("draw-steel-combat-tools", dsctMod);
  let steps = 0, step = null;
  registerPromptType("forcedStep", async (payload, ctx) => { steps++; return step(payload, ctx); });
  registerPromptType("movementChoice", async () => { throw new Error("our path dialog must not open with Combat Tools"); });
  const victim = targetFromTokenDoc(enemy);
  const fmRes = { sourceActorUuid: hero.uuid, sourceTokenUuid: token.uuid, abilityName: "Shove", targets: { [victim.key]: victim } };
  const pushOp = { opId: "fm", kind: "forced", movement: "push", movements: ["push"], distances: { push: 2 }, properties: [], targetKeys: [victim.key] };
  const slideOp = { ...pushOp, movement: "slide", movements: ["slide"], distances: { slide: 2 } };
  const home = () => { enemy.x = 100; enemy.y = 100; enemy.elevation = 0; token.x = 0; token.y = 100; enemy.flags = {}; };
  const picked = (x, moveId = "move-1", extra = {}) => async () => {
    const from = { x: enemy.x, y: enemy.y, elevation: enemy.elevation ?? 0 };
    enemy.x = x;
    enemy.flags = { "draw-steel-combat-tools": { lastFmMoveId: moveId } };
    return { movement: "slide", moveId, undoLog: [{ op: "update", uuid: enemy.uuid, data: from, options: { isUndo: true } }], content: "<p>slid</p>", ...extra };
  };
  gobA.system.combat = { stability: 0 };
  assert.equal(straightForced(pushOp), true); assert.equal(straightForced(slideOp), false);
  assert.equal(straightForced({ ...pushOp, vertical: true }), false); assert.equal(straightForced({ ...pushOp, choosePath: true }), false);
  home();
  const pushed = await applyMoveOp(authorMessage, fmRes, pushOp);
  assert.equal(steps, 0, "a straight push asks nobody");
  assert.deepEqual([pushed.status, pushed.delegated, fmCalls.length, fmCalls[0].type, fmCalls[0].fastMove, enemy.x], ["applied", "dsct", 1, "Push", true, 300]);
  // The Director used it: its own pick, trusted.
  home(); step = picked(200);
  const mine = await applyMoveOp(authorMessage, fmRes, slideOp);
  assert.equal(steps, 1, "a slide goes to Combat Tools' picker");
  assert.deepEqual([mine.status, mine.delegated, mine.movedType, mine.moveId, mine.byClient, mine.undoLog.length], ["applied", "dsct", "slide", "move-1", undefined, 1]);
  home(); step = async () => ({ cancelled: true });
  const cancelledPick = await applyMoveOp(authorMessage, fmRes, slideOp);
  assert.deepEqual([cancelledPick.status, cancelledPick.reason], ["pending", "notMoved"], "a cancelled pick leaves Apply available");
  // A player used it: their screen, their answer checked.
  const savedFilter = game.users.filter, savedPermission = hero.testUserPermission;
  game.users.filter = fn => [w.users.player].filter(fn);
  hero.testUserPermission = u => u.id === w.users.player.id;
  const playerMessage = { author: w.users.player };
  home(); step = picked(200);
  const theirs = await applyMoveOp(playerMessage, fmRes, slideOp);
  assert.deepEqual([theirs.status, theirs.byClient, theirs.pickedBy, theirs.undoLog.length], ["applied", true, w.users.player.id, 1]);
  home(); step = picked(200, "move-2", { moveId: "forged" });
  const forged = await applyMoveOp(playerMessage, fmRes, slideOp);
  assert.deepEqual([forged.status, forged.reason, enemy.x], ["failed", "badDestination", 100], "a moveId Combat Tools did not write: rolled back");
  home(); step = picked(600);
  const tooFarMove = await applyMoveOp(playerMessage, fmRes, slideOp);
  assert.deepEqual([tooFarMove.status, enemy.x], ["failed", 100], "farther than the row allows: rolled back");
  home(); step = async () => ({ unavailable: true });
  let gmSteps = 0;
  const playerStep = step;
  step = async (payload, ctx) => (gmSteps++ === 0 ? playerStep(payload, ctx) : picked(200)(payload, ctx));
  const takenOver = await applyMoveOp(playerMessage, fmRes, slideOp);
  assert.deepEqual([takenOver.status, takenOver.byClient, gmSteps], ["applied", undefined, 2], "the player cannot pick: the Director does");
  home(); step = async () => ({ ...(await picked(300)()), movement: "pull" });
  assert.equal((await applyMoveOp(playerMessage, fmRes, slideOp)).status, "failed", "a movement the row does not allow");
  game.users.filter = savedFilter; hero.testUserPermission = savedPermission;
  // Undo-log entries are kept only when they put back what the Director's snapshot recorded.
  home();
  const snap = sceneSnapshot(enemy.parent);
  enemy.x = 200;
  const cleaned = cleanUndoLog([
    { op: "update", uuid: enemy.uuid, data: { x: 100, y: 100, elevation: 0 } },
    { op: "update", uuid: enemy.uuid, data: { x: 100, y: 100, "flags.evil": true } },
    { op: "update", uuid: "Actor.someone", data: { name: "x" } },
    { op: "stamina", uuid: gobA.uuid, prevValue: gobA.system.stamina.value, prevTemp: gobA.system.stamina.temporary ?? 0 },
    { op: "stamina", uuid: gobA.uuid, prevValue: 999, prevTemp: 0 },
    { op: "status", uuid: gobA.uuid, effectId: "prone", active: false },
    { op: "status", uuid: gobA.uuid, effectId: "prone", active: true },
    { op: "macro", uuid: enemy.uuid },
  ], snap, enemy.parent);
  assert.deepEqual(cleaned.entries.map(e => e.op), ["update", "stamina", "status"]);
  assert.equal(cleaned.dropped, 5);
  // "push or pull": the recipient chooses; a row that allows one movement keeps it.
  home();
  const both = { ...pushOp, movement: null, movements: ["push", "pull"], distances: { push: 2, pull: 2 } };
  step = async (payload) => { assert.equal(payload.opId, "fm"); return { ...(await picked(300)()), movement: "pull" }; };
  const chose = await applyMoveOp(authorMessage, fmRes, both);
  assert.deepEqual([chose.status, chose.movedType], ["applied", "pull"]);
  game.modules.delete("draw-steel-combat-tools");
  registerPromptType("movementChoice", async () => ({ declined: true }));
  home();
  console.log("ok 0.17.0 forced picks in Combat Tools' picker: straight push, Director pick, cancel, player pick checked, takeover, undo log, push or pull");
}

// 0.18.0 (Combat Tools 1.2.7): the target's forcedMovementTaken squares count before stability, in a player's pick
// length and in the recorded distance; Combat Tools' `noMove` answer (empty undo log, no moveId) moved nothing.
{
  const { forcedRefusal, dsctMoved } = await imp("delegation/forced-movement.mjs");
  const victim = targetFromTokenDoc(enemy);
  const fmRes = { sourceActorUuid: hero.uuid, sourceTokenUuid: token.uuid, abilityName: "Shove", targets: { [victim.key]: victim } };
  const pushOp = { opId: "fm18", kind: "forced", movement: "push", movements: ["push"], distances: { push: 2 }, properties: [], targetKeys: [victim.key] };
  const slideOp = { ...pushOp, movement: "slide", movements: ["slide"], distances: { slide: 2 } };
  const home = () => { enemy.x = 100; enemy.y = 100; enemy.elevation = 0; token.x = 0; token.y = 100; enemy.flags = {}; };
  let answer = null, taken = 0;
  game.modules.set("draw-steel-combat-tools", { active: true, version: "1.2.7", api: { async forcedMovement(spec) { return answer(spec); } } });
  const savedGetFlag = gobA.getFlag;
  gobA.getFlag = (scope, key) => (scope === "draw-steel-combat-tools" && key === "forcedMovementTaken" ? taken : savedGetFlag?.call(gobA, scope, key));
  gobA.system.combat = { stability: 2 };
  home();
  assert.equal(forcedRefusal({ targetDoc: enemy, sourceDoc: token, movement: "push", distance: 2 })?.reason, "stabilityResists");
  assert.equal(forcedRefusal({ targetDoc: enemy, sourceDoc: token, movement: "push", distance: 2, taken: 2 }), null, "the extra squares beat stability");
  taken = 2; home();
  answer = () => { enemy.x = 300; return { undoLog: [{ op: "update", uuid: enemy.uuid, data: { x: 100, y: 100 } }], content: "", moveId: "m18" }; };
  const pushed = await applyMoveOp(authorMessage, fmRes, pushOp);
  assert.deepEqual([pushed.status, pushed.movedDistance], ["applied", 4], "stability 2 no longer resists; 2 + 2 squares recorded");
  gobA.system.combat = { stability: 0 }; taken = 0; home();
  answer = () => ({ undoLog: [], moveId: null, noMove: true, content: "" });
  const resisted = await applyMoveOp(authorMessage, fmRes, pushOp);
  assert.deepEqual([resisted.status, resisted.reason, enemy.x], ["skipped", "notMoved", 100], "Combat Tools' noMove is not an applied move");
  assert.equal(dsctMoved({ undoLog: [], moveId: null, noMove: true }), false); assert.equal(dsctMoved(undefined), false);
  assert.equal(dsctMoved({ undoLog: [], moveId: "x" }), true);
  // A player's pick 4 squares long: the row allows 2 + forcedMovementTaken 2.
  const savedFilter = game.users.filter, savedPermission = hero.testUserPermission;
  game.users.filter = fn => [w.users.player].filter(fn);
  hero.testUserPermission = u => u.id === w.users.player.id;
  registerPromptType("forcedStep", async () => {
    const from = { x: enemy.x, y: enemy.y, elevation: enemy.elevation ?? 0 };
    enemy.x = 500;
    enemy.flags = { "draw-steel-combat-tools": { lastFmMoveId: "m19" } };
    return { movement: "slide", moveId: "m19", undoLog: [{ op: "update", uuid: enemy.uuid, data: from, options: { isUndo: true } }], content: "" };
  });
  taken = 2; home();
  const longer = await applyMoveOp({ author: w.users.player }, fmRes, slideOp);
  assert.deepEqual([longer.status, longer.movedDistance, longer.byClient], ["applied", 4, true]);
  taken = 0; home();
  assert.equal((await applyMoveOp({ author: w.users.player }, fmRes, slideOp)).status, "failed", "without the flag 4 squares is too far");
  game.users.filter = savedFilter; hero.testUserPermission = savedPermission;
  gobA.getFlag = savedGetFlag;
  game.modules.delete("draw-steel-combat-tools");
  registerPromptType("movementChoice", async () => ({ declined: true }));
  home();
  console.log("ok 0.18.0 forcedMovementTaken (refusal, push, player pick) and Combat Tools' noMove answer");
}

// 0.18.0 (ctlib 1.5.0 range3d): trigger distance is the larger of the footprint gap and the vertical gap.
{
  const { distanceSquares } = await imp("triggers/eligibility.mjs");
  const grid = { size: 100, distance: 1 };
  const tok = (uuid, x, y, elevation = 0, size = 1) => ({ uuid, x, y, width: 1, height: 1, elevation, parent: { grid }, actor: { system: { combat: { size: { value: size } } } } });
  const a = tok("Scene.s.Token.a", 0, 0);
  assert.equal(distanceSquares(a, tok("Scene.s.Token.b", 100, 0)), 1, "adjacent");
  assert.equal(distanceSquares(a, tok("Scene.s.Token.b", 100, 0, 5)), 5, "flier 5 up: gap 4 squares above a 1-square column");
  assert.equal(distanceSquares(a, tok("Scene.s.Token.b", 0, 0, 3)), 3, "straight above, overlapping footprints");
  assert.equal(distanceSquares(a, tok("Scene.s.Token.b", 0, 0, 1)), 0, "stacked columns touching");
  assert.equal(distanceSquares(a, tok("Scene.s.Token.b", 600, 0, 3)), 6, "the flat gap wins when larger");
  assert.equal(distanceSquares(tok("Scene.s.Token.c", 0, 0, 0, 3), tok("Scene.s.Token.b", 100, 0, 3)), 1, "a size-3 creature reaches up to its height");
  assert.equal(distanceSquares(a, tok("Scene.s.Token.b", 100, 0), { "Scene.s.Token.b": { x: 100, y: 0, elevation: 4 } }), 4, "snapshot elevation");
  const savedLib = globalThis.ctlib;
  game.modules.set("draw-steel-ctlib", { active: true, version: "1.5.0" });
  globalThis.ctlib = { config: { get: key => (key === "range3d" ? false : undefined) } };
  assert.equal(distanceSquares(a, tok("Scene.s.Token.b", 100, 0, 5)), 1, "ctlib range3d off: flat");
  globalThis.ctlib = savedLib;
  game.modules.delete("draw-steel-ctlib");
  console.log("ok 0.18.0 3D trigger distance (flier, stacked, size, snapshot, ctlib range3d off)");
}

const alone = feature("I Work Better Alone", hero, "ability", "i-work-better-alone");
assert.equal(aloneEligible(alone, enemy), true, "Shadow itself does not count as an adjacent ally");
hero.system.hero.surges = 0;
const granted = await grantAlone(alone, { useId: "alone00000000001", tokenUuids: [enemy.uuid] }, game.user);
assert.equal(hero.system.hero.surges, 1); await grantAlone(alone, { useId: "alone00000000001", tokenUuids: [enemy.uuid] }, game.user);
assert.equal(hero.system.hero.surges, 1, "duplicate delivery does not duplicate grant"); await undoOps(messages.get(granted.messageId)); assert.equal(hero.system.hero.surges, 0);
console.log("ok pre-roll alone grant and deduplication");

const field = feature("Null Field", hero, "ability", "null-field"); field.system.distance = { primary: 1, type: "aura" };
field.effects = new Map([ ["0OMzJvPqF11x4lcj", { clone() { return { toObject: () => ({ name: "Dampen", type: "abilityModifier", system: { changes: [{ key: "potency", value: 1, type: "subtract", phase: "initial" }] } }) }; } }] ]);
game.scenes.contents = [scene];
foundry.data.operators.ForcedReplacement ??= { create: value => structuredClone(value) };
await setAura(field, true);
assert.equal(gobA.effects.contents.filter(e => e.origin === field.uuid).length, 1);
await refreshAuras(); assert.equal(gobA.effects.contents.filter(e => e.origin === field.uuid).length, 1, "refresh does not duplicate aura");
hero.system.hero.primary.value = 2;
await purchaseNullOption(field, "synaptic"); assert.equal(hero.system.hero.primary.value, 1); assert.equal(auraPotencyBonus(strike, gobA), 1);
await purchaseNullOption(field, "anchor"); assert.equal(hero.system.hero.primary.value, 1, "once per turn enhancement");
enemy.x = 700; await refreshAuras(); assert.equal(gobA.effects.contents.filter(e => e.origin === field.uuid).length, 0);
await setAura(field, false); assert.equal(field.flags[MOD].aura.active, false);
console.log("ok Null Field entry/exit, single discipline purchase, synaptic target potency and stop");

const iron = new w.Effect({ _id: "iron000000000001", flags: { [MOD]: { messageId: "iron-card", temporaryStamina: { remaining: 10 } } } }, hero); hero.effects.set(iron.id, iron);
hero.system.stamina.temporary = 10; const before = temporarySnapshot(hero);
hero.system.stamina.temporary = 4; assert.equal((await reconcileTemporaryStamina(hero, before)).length, 0); assert.equal(iron.flags[MOD].temporaryStamina.remaining, 4);
const partial = temporarySnapshot(hero); hero.system.stamina.temporary = 0;
const expired = await reconcileTemporaryStamina(hero, partial); assert.equal(expired.length, 1); assert.equal(hero.effects.has(iron.id), false);
hero.system.stamina.temporary = 4; await restoreTemporaryEffects(hero, { temporaryBefore: partial, temporaryExpired: expired }); assert.equal(hero.effects.has(iron.id), true);
hero.system.stamina.temporary = 20; assert.equal((await reconcileTemporaryStamina(hero, partial)).length, 1, "replacement expires old source");
console.log("ok partial temp loss, depletion, replacement and restore");
const shield = feature("Green Shield", hero, "ability", "the-green-defends-its-servants");
enemy.x = 100; enemy.y = 100;
const burst = temporaryExplosionOps(hero, [{ origin: shield.uuid }], "expiry");
assert.ok(Object.values(burst.ops).length > 0); assert.ok(Object.values(burst.ops).every(o => o.amount === 10 && o.temporaryCauseOpId === "expiry"));
console.log("ok shield explosion targets and causal damage");

const judgement = feature("Judgement", hero, "ability", "judgement"), oracle = feature("Oracle Judgement Benefit", hero, "feature", "oracle-judgement-benefit");
const judged = { opId: "judge", kind: "condition", effectId: "MHQDlicbxXquwduc", targetKeys: [target.key], order: 1 };
const judgedRes = { abilityUuid: judgement.uuid, sourceTokenUuid: token.uuid, targets: res.targets, ops: { judge: judged } }, patches = { judge: { status: "applied" } };
const benefits = []; const apply = async o => { benefits.push(o); patches[o.opId] = { status: "applied" }; };
await prepareJudgementBenefits({ id: "judge-message" }, judgedRes, [judged], patches, apply, () => {});
assert.equal(benefits[0].amount, 4); assert.equal(benefits[0].type, "holy");
await prepareJudgementBenefits({ id: "judge-again" }, judgedRes, [judged], patches, apply, () => {}); assert.equal(benefits.length, 1);
console.log("ok Oracle first judgement opportunity on a turn");
for (const [dsid, expected] of [["paragon-judgement-benefit", "forced"], ["exorcist-judgement-benefit", "teleport"]]) {
  for (const i of hero.items) if (i.system._dsid.endsWith("judgement-benefit")) i.flags[MOD] = { disabled: true };
  const benefit = feature(dsid, hero, "feature", dsid);
  const enemyRecord = targetFromTokenDoc(enemy);
  const cause = { ...judged, targetKeys: [enemyRecord.key] };
  const state = { ...judgedRes, targets: { [enemyRecord.key]: enemyRecord }, ops: { judge: cause } };
  const records = { judge: { status: "applied" } }, created = [];
  await prepareJudgementBenefits({ id: dsid }, state, [cause], records, async op => { created.push(op); }, () => {});
  assert.equal(created[0].kind, expected);
  if (expected === "forced") { assert.equal(created[0].vertical, true); assert.equal(created[0].distances.pull, 4); }
  else { assert.equal(created[0].closerToTokenUuid, enemy.uuid); assert.equal(state.targets[created[0].targetKeys[0]].tokenUuid, token.uuid); }
}
for (const i of hero.items) if (i.system._dsid.endsWith("judgement-benefit")) i.flags[MOD] = { disabled: true };
oracle.flags[MOD] = {}; combat.turn++;
registerPromptType("featureRule", async () => ({ accepted: false }));
await prepareJudgementBenefits({ id: "declined-judge" }, judgedRes, [judged], patches, apply, () => {});
registerPromptType("featureRule", async () => ({ accepted: true }));
await prepareJudgementBenefits({ id: "repeat-declined-judge" }, judgedRes, [judged], patches, apply, () => {});
assert.equal(benefits.length, 1, "declining the first judgement consumes the turn opportunity");
console.log("ok Paragon/Exorcist generated movement and declined first judgement opportunity");

// A previous turn's successful card must not block the newly reserved opportunity.
await setAura(field, true); await field.update({ [`flags.${MOD}.aura.option`]: "gravitic" });
enemy.x = 100; enemy.y = 100;
const gravitic = featureRules(field).find(r => r.id === "gravitic");
const frequencyId = (await imp("library/entries.mjs")).entryId(gravitic.id, enemy.uuid);
const oldFrequency = "previous-turn";
const oldCard = await postRecordCard({ title: "Old gravitic opportunity", sourceActor: hero, targets: {}, user: game.user,
  ops: { old: { opId: "old", kind: "note", mode: "manual", status: "applied", featureItemUuid: field.uuid, ruleId: frequencyId, featureFrequency: oldFrequency } } });
await field.update({ [`flags.${MOD}.ruleUses.${frequencyId}`]: oldFrequency, [`flags.${MOD}.ruleMessages.${frequencyId}`]: oldCard.messageId });
registerPromptType("featureRule", async () => ({ accepted: true }));
registerPromptType("movementChoice", async () => ({ declined: true }));
const nextGravitic = await executeRule(field, gravitic, { id: "gravitic-new-turn", kind: "damage.after", sceneId: scene.id,
  subject: { tokenUuid: enemy.uuid, actorUuid: gobA.uuid }, damage: { amount: 1, finalAmount: 1 } });
assert.ok(nextGravitic); assert.ok(Object.values(nextGravitic.ops).every(o => o.reason !== "featureAlreadyUsed"), "old message cannot consume the new opportunity");
assert.equal(field.flags[MOD].ruleMessages[frequencyId], nextGravitic.messageId);
const { claimFeature } = await imp("features/claims.mjs");
const orphanOp = { opId: "orphan", kind: "note", mode: "manual", status: "skipped", reason: "featureAlreadyUsed", featureOpportunity: true,
  featureItemUuid: field.uuid, ruleId: "orphan", featureFrequency: "orphan-turn" };
const orphanCard = await postRecordCard({ title: "Blocked old opportunity", sourceActor: hero, targets: {}, user: game.user,
  meta: { featureEventId: "original-damage-event" }, ops: { orphan: orphanOp } });
await field.update({ [`flags.${MOD}.ruleUses.orphan`]: "orphan-turn", [`flags.${MOD}.ruleMessages.orphan`]: "deleted-message" });
assert.equal(await claimFeature(orphanOp, orphanCard.messageId), true, "a previously blocked reserved card can recover a dangling message reference");
assert.equal(await claimFeature({ ...orphanOp, status: "pending", reason: null }, "different-card"), false, "another card cannot reuse the same reserved opportunity");
const { opLabel } = await imp("parts/view.mjs");
for (const option of ["gravitic", "anchor", "synaptic"]) assert.ok(opLabel({}, { kind: "auraOption", option }).length > 0);
assert.ok(opLabel({}, { kind: "auraActivation" }).length > 0);
await field.update({ [`flags.${MOD}.aura.option`]: "anchor" });
const anchorRule = featureRules(field).find(r => r.id === "anchor");
const anchorCard = await executeRule(field, anchorRule, { id: "enemy-anchor-start", kind: "turn.start", sceneId: scene.id,
  subject: { tokenUuid: enemy.uuid, actorUuid: gobA.uuid } });
assert.ok(anchorCard); assert.ok(gobA.effects.contents.some(e => e.flags?.[MOD]?.ruleEffect?.benefit === "noShift"));
assert.ok(!gobB.effects.contents.some(e => e.flags?.[MOD]?.ruleEffect?.itemUuid === field.uuid && e.flags[MOD].ruleEffect.benefit === "noShift"));
await field.update({ [`flags.${MOD}.aura.option`]: "synaptic" });
assert.equal(auraPotencyBonus(strike, gobA), 1);
enemy.x = 700; assert.equal(auraPotencyBonus(strike, gobA), 0, "Synaptic Break excludes enemies outside the aura");
console.log("ok Inertial Anchor target-start effect and Synaptic Break aura boundary");
console.log("ok next-turn gravitic reservation and visible aura card labels");

// Milestone 9 (WP-A, D4): a cleanse choice goes to the AFFECTED creature's owner (an NPC: the Director's own dialog); a
// valid answer becomes `override` (with `by`), no answer leaves the row pending ("chooseEffects").
{
  const { prepareCleanseChoice } = await imp("ui/cleanse-choice.mjs");
  const { applyCleanse } = await imp("engine/library-apply.mjs");
  const player = w.users.player;
  const savedFilter = game.users.filter, savedPermission = hero.testUserPermission, savedQuery = player.query;
  const sent = [];
  registerPromptType("cleanseChoice", async (payload, { user }) => { sent.push({ to: "local", user: user.id, payload }); return { effects: [payload.candidateIds[1]] }; });
  const save = (a, id, name) => a.createEmbeddedDocuments("ActiveEffect", [{ _id: id, name, statuses: [], duration: { expiry: "save" } }]);
  const gobRec = targetFromTokenDoc(docs[1]), heroRec = targetFromTokenDoc(token);
  const cleanseOp = (key, extra = {}) => ({ opId: `cl-${key.slice(-6)}`, kind: "cleanse", lib: true, statuses: [], ends: ["save"], count: 1, status: "pending", reason: "chooseEffects",
    targetKeys: [key], label: "Rain", ...extra });
  const clRes = (ops) => ({ abilityName: "Test of Rain", authorUserId: player.id, sourceActorUuid: hero.uuid, targets: { [gobRec.key]: gobRec, [heroRec.key]: heroRec },
    ops: Object.fromEntries(ops.map(o => [o.opId, o])) });
  const clMessage = { id: "cleanse-msg", author: player };
  // An NPC: the Director's own dialog (the active GM is this client).
  await save(gobA, "gobSave000000001", "Dazed"); await save(gobA, "gobSave000000002", "Slowed");
  const npcOp = cleanseOp(gobRec.key);
  const npcRes = clRes([npcOp]);
  await prepareCleanseChoice(clMessage, npcRes, [npcOp]);
  assert.deepEqual([sent.length, sent[0].to, sent[0].payload.type, sent[0].payload.actorUuid, sent[0].payload.count], [1, "local", "cleanseChoice", gobA.uuid, 1]);
  assert.deepEqual([...sent[0].payload.candidateIds].sort(), ["gobSave000000001", "gobSave000000002"]);
  assert.deepEqual([npcOp.override.effects, npcOp.override.by], [[sent[0].payload.candidateIds[1]], game.user.id], "the answer with who chose");
  const ended = await applyCleanse(clMessage, npcRes, npcOp);
  assert.equal(ended.status, "applied"); assert.equal(gobA.effects.has(sent[0].payload.candidateIds[1]), false);
  assert.equal(gobA.effects.has(sent[0].payload.candidateIds[0]), true, "only the chosen one ended");
  // Review fix: an owner asked once is not asked again (no answer: the row's own Apply lets the clicker choose).
  const onceOp = cleanseOp(gobRec.key, { opId: "cl-once00001" });
  await save(gobA, "gobSave000000003", "Weakened");
  const askedBefore = sent.length;
  await prepareCleanseChoice(clMessage, clRes([onceOp]), [onceOp]);
  assert.ok(onceOp.cleanseAsked, "the row remembers it was asked");
  delete onceOp.override;
  await prepareCleanseChoice(clMessage, clRes([onceOp]), [onceOp]);
  assert.equal(sent.length, askedBefore + 1, "asked once per row");
  // A hero with a player owner: that owner is asked (not the author's client unless they own it).
  await save(hero, "heroSave00000001", "Dazed"); await save(hero, "heroSave00000002", "Bleeding");
  game.users.filter = fn => [player].filter(fn);
  hero.testUserPermission = u => !!u?.isGM || u.id === player.id;
  player.query = async (name, payload, opts) => { sent.push({ to: player.id, name, payload, timeout: opts?.timeout }); return { effects: ["heroSave00000002"] }; };
  const heroOp = cleanseOp(heroRec.key);
  await prepareCleanseChoice(clMessage, clRes([heroOp]), [heroOp]);
  assert.deepEqual([sent.at(-1).to, sent.at(-1).timeout], [player.id, 32_000], "the creature's owner, 32 s");
  assert.deepEqual([heroOp.override.effects, heroOp.override.by], [["heroSave00000002"], player.id]);
  // An answer outside the offer, too many, or a timeout: nothing chosen, the row waits for its Apply.
  for (const answer of [{ effects: ["notOffered000001"] }, { effects: ["heroSave00000001", "heroSave00000002"] }, null]) {
    player.query = async () => { if (!answer) throw new Error("timeout"); return answer; };
    const op = cleanseOp(heroRec.key);
    const r = clRes([op]);
    await prepareCleanseChoice(clMessage, r, [op]);
    assert.equal(op.override, undefined, JSON.stringify(answer));
    assert.deepEqual([(await applyCleanse(clMessage, r, op)).reason], ["chooseEffects"], "pending, someone chooses on Apply");
  }
  // A row already chosen (Edit) or with no more effects than it may end is not asked.
  const before = sent.length;
  const chosen = cleanseOp(heroRec.key, { override: { effects: ["heroSave00000001"] } });
  const single = cleanseOp(heroRec.key, { count: 5 });
  await prepareCleanseChoice(clMessage, clRes([chosen, single]), [chosen, single]);
  assert.equal(sent.length, before);
  // D2: a target pick goes to the user's owner (the author first), the Director without one.
  const { offerPicks } = await imp("ui/target-pick.mjs");
  const pickScene = { id: scene.id, grid: { size: 100 }, tokens: [token, docs[1]] };
  const pickSaved = [token, docs[1]].map(d => ({ d, parent: d.parent, x: d.x, y: d.y, width: d.width, height: d.height }));
  for (const [d, x] of [[token, 0], [docs[1], 200]]) Object.assign(d, { x, y: 0, width: 1, height: 1, parent: pickScene });
  const pickOp = { opId: "pick1", kind: "pick", self: true, status: "pending", reason: "pickTargets", noApply: true, label: "Slide",
    pick: { effectId: "slide", count: 1, within: 10, of: "self", filter: null, damageTypes: [], anchorTokenUuid: token.uuid }, targetKeys: [heroRec.key] };
  const pickMessage = { id: "pick-msg", author: player, flags: { [MOD]: { resolution: { resolvedAt: 1, sourceActorUuid: hero.uuid, sourceTokenUuid: token.uuid, abilityName: "Green",
    targets: { [heroRec.key]: heroRec }, ops: { pick1: pickOp } } } } };
  const recorded = [];
  const engineFns = { recordPick: async (m, opId, answer, opts) => { recorded.push({ opId, answer, opts }); }, notePicksAsked: async (_m, ids) => ids };
  player.query = async (name, payload, opts) => { sent.push({ to: player.id, payload, timeout: opts?.timeout }); return { tokenUuids: [docs[1].uuid], damageType: null }; };
  await offerPicks(pickMessage, engineFns);
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual([sent.at(-1).to, sent.at(-1).payload.type, sent.at(-1).timeout, sent.at(-1).payload.candidates.map(c => c.tokenUuid)],
    [player.id, "targetPick", 122_000, [docs[1].uuid]], "the user's owner, the GM's candidates (never the user)");
  assert.deepEqual([recorded[0].opId, recorded[0].answer.tokenUuids, recorded[0].opts.userId], ["pick1", [docs[1].uuid], player.id]);
  game.users.filter = () => [];
  registerPromptType("targetPick", async (payload, { user }) => { sent.push({ to: "local", user: user.id, payload }); return { tokenUuids: [] }; });
  await offerPicks(pickMessage, engineFns);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(sent.at(-1).to, "local", "the Director picks when no owner is active");
  assert.equal(recorded.length, 1, "an empty answer records nothing");
  pickMessage.flags[MOD].resolution.pickAsked = { pick1: 1 };
  const n = sent.length;
  await offerPicks(pickMessage, engineFns);
  assert.equal(sent.length, n, "an offered row is not asked again");
  for (const s of pickSaved) Object.assign(s.d, { parent: s.parent, x: s.x, y: s.y, width: s.width, height: s.height });
  game.users.filter = savedFilter; hero.testUserPermission = savedPermission; player.query = savedQuery;
  console.log("ok M9 cleanse choice by the affected creature's owner (NPC local, override.by, refusals, timeout) and target-pick routing");
}

// 0.16.0: Combat Tools 1.2.6 at use time: the melee-or-ranged range exemption (Eviscerate) and its area picker
// (Incinerate): our area work adopts its region, survives its vetoed first use, and keeps its own path without it.
{
  const { dsctRangeExempt, dsctAreaPickerFor } = await imp("compat/dsct-use.mjs");
  const { areaUse, noteLinkedRegion, preparedArea } = await imp("engine/areas.mjs");
  const exempt = [];
  const dsctSettings = { abilityAutomationEnabled: true, abilityTargetingEnabled: true, areaPicker: true };
  game.modules.set("draw-steel-combat-tools", { active: true, version: "1.2.6", api: { allowOutOfRange: (uuid, ms) => exempt.push([uuid, ms]) } });
  const savedGet = game.settings.get;
  game.settings.get = function(ns, key) { return ns === "draw-steel-combat-tools" ? dsctSettings[key] : savedGet.call(this, ns, key); };
  const victim = docs[1];
  token.x = 0; token.y = 100; victim.y = 100;
  const eviscerate = { uuid: "Item.eviscerate0000", name: "Eviscerate", actor: hero, system: { type: "main", distance: { type: "meleeRanged", primary: 1, secondary: 5 } } };
  game.user.targets = new Set([w.placeables?.[1] ?? canvas.tokens.placeables[1]]);
  victim.x = 500;   // 4 squares between the footprints
  assert.equal(dsctRangeExempt(eviscerate), true); assert.deepEqual(exempt, [[eviscerate.uuid, 60000]]);
  victim.x = 600;   // 5 squares between: Combat Tools refuses, so do we, and our earlier exemption is revoked
  assert.equal(dsctRangeExempt(eviscerate), false); assert.deepEqual(exempt[1], [eviscerate.uuid, 0]);
  assert.equal(dsctRangeExempt(eviscerate), false); assert.equal(exempt.length, 2, "revoked once, only what we granted");
  victim.x = 500;
  assert.equal(dsctRangeExempt({ ...eviscerate, system: { distance: { type: "melee", primary: 1 } } }), false, "melee only: never exempt");
  dsctSettings.abilityAutomationEnabled = false;
  assert.equal(dsctRangeExempt(eviscerate), false, "Combat Tools' ability automation off");
  dsctSettings.abilityAutomationEnabled = true;
  game.user.targets = new Set();
  console.log("ok 0.16.0 melee-or-ranged range exemption");

  const incinerate = { uuid: "Item.incinerate000", name: "Incinerate", actor: hero, getFlag: () => null,
    system: { type: "main", distance: { type: "cube", primary: 3, secondary: 10 }, target: { type: "creature", value: null } } };
  assert.equal(dsctAreaPickerFor(incinerate), true);
  assert.equal(dsctAreaPickerFor({ ...incinerate, system: { ...incinerate.system, target: { type: "creature", value: 2 } } }), false, "numbered targets");
  assert.equal(dsctAreaPickerFor({ ...incinerate, system: { ...incinerate.system, distance: { type: "aura", primary: 2 } } }), false, "auras stay ours");
  dsctSettings.areaPicker = false; assert.equal(dsctAreaPickerFor(incinerate), false); dsctSettings.areaPicker = true;
  let placed = 0;
  const model = { parent: incinerate, actor: hero, hasTemplate: true, distance: incinerate.system.distance, target: incinerate.system.target, validTarget: () => true,
    async placeTemplate() { placed++; const [r] = await scene.createEmbeddedDocuments("Region", [{ name: "ours", shapes: [], flags: { "draw-steel": { abilitySource: incinerate.uuid } } }]); return r; } };
  incinerate.system = model;
  const [older] = await scene.createEmbeddedDocuments("Region", [{ name: "older", shapes: [], flags: { "draw-steel": { abilitySource: incinerate.uuid } } }]);
  noteLinkedRegion(older);
  await new Promise(r => setTimeout(r, 5));
  // First use: Combat Tools vetoes the dialog, the system's use() never resolves.
  void areaUse.call(model, () => new Promise(() => {}));
  await new Promise(r => setTimeout(r, 5));
  const [picked] = await scene.createEmbeddedDocuments("Region", [{ name: "Incinerate", shapes: [], flags: {} }]);
  picked.flags = { "draw-steel": { abilitySource: incinerate.uuid } };   // linked after creation, as Combat Tools does
  noteLinkedRegion(picked);
  let seen = null;
  const card = await areaUse.call(model, async () => { seen = preparedArea(incinerate.uuid); return { id: "incinerate-card" }; });
  assert.equal(card.id, "incinerate-card", "Combat Tools' re-entry reaches the dialog");
  assert.equal(seen, picked, "the use's area is Combat Tools' region, not an older one");
  assert.equal(placed, 0, "we never place a second area");
  assert.equal(scene.regions.has(picked.id), true, "Combat Tools' region is left to its own lifetime");
  assert.equal(preparedArea(incinerate.uuid), null);
  await picked.delete(); await older.delete();
  // Without its picker our own placement remains, and a vetoed use's area is taken over by the re-entry.
  dsctSettings.areaPicker = false;
  void areaUse.call(model, () => new Promise(() => {}));
  await new Promise(r => setTimeout(r, 5));
  assert.equal(placed, 1);
  const ours = scene.regions.contents.find(r => r.name === "ours");
  const again = await areaUse.call(model, async () => { seen = preparedArea(incinerate.uuid); return { id: "again" }; });
  assert.deepEqual([again.id, placed, seen], ["again", 1, ours], "the re-entry reuses the vetoed use's area");
  void areaUse.call(model, () => new Promise(() => {}));
  await new Promise(r => setTimeout(r, 5));
  const cancelled = await areaUse.call(model, async () => null);
  assert.equal(cancelled, null); assert.equal(placed, 2);
  assert.equal(scene.regions.contents.filter(r => r.name === "ours").length, 1, "a cancelled re-entry removes the area it took over");
  for (const r of scene.regions.contents.filter(r => r.name === "ours")) await r.delete();
  game.settings.get = savedGet;
  game.modules.delete("draw-steel-combat-tools");
  console.log("ok 0.16.0 Combat Tools area picker adoption, vetoed first use, own placement without the picker");
}

// 0.16.0: cleanse candidates (My Life for Yours: prone, or one save-ends / end-of-turn effect).
{
  const { cleanseCandidates, cleanseSeen } = await imp("engine/library-plan.mjs");
  const fx = (id, extra) => ({ id, name: id, statuses: new Set(), duration: {}, disabled: false, flags: {}, ...extra });
  const actorWith = (...effects) => ({ effects: { contents: effects } });
  const spec = { statuses: ["prone"], ends: ["save", "turn"] };
  const ids = a => cleanseCandidates(a, spec).map(e => e.id);
  const savedEnds = ds.CONFIG.effectEnds;
  ds.CONFIG.effectEnds = { turn: { expiryEvent: "turnEnd" }, save: { expiryEvent: "save" } };
  assert.deepEqual(ids(actorWith(fx("prone", { statuses: new Set(["prone"]) }), fx("bleed", { duration: { expiry: "save" } }), fx("slow", { duration: { expiry: "turnEnd" } }))),
    ["prone", "bleed", "slow"]);
  assert.deepEqual(ids(actorWith(fx("legacy", { system: { end: { type: "turn" } } }))), ["legacy"], "the legacy system.end.type");
  ds.CONFIG.effectEnds = { save: { expiryEvent: "saveEnds" } };
  assert.deepEqual(ids(actorWith(fx("renamed", { duration: { expiry: "saveEnds" } }))), ["renamed"], "the system's own expiry event wins");
  ds.CONFIG.effectEnds = savedEnds;
  assert.deepEqual(ids(actorWith(fx("expired", { duration: { expiry: "save", expired: true } }), fx("off", { disabled: true, duration: { expiry: "save" } }),
    fx("unspent", { duration: { expiry: "turnEnd" }, flags: { "draw-steel-combat-tools": { effectType: "triggered-action" } } }),
    fx("dying", { statuses: new Set(["dying", "prone"]) }))), [], "expired, disabled, bookkeeping and dying are never ended");
  const seen = cleanseSeen(actorWith(fx("expired", { duration: { expiry: "save", expired: true } })));
  assert.deepEqual(seen, [{ name: "expired", statuses: [], expiry: "save", disabled: false, expired: true }]);
  console.log("ok 0.16.0 cleanse candidates through effectEnds, legacy ends, inactive and bookkeeping effects, seen");
}

// 0.16.0: the verified family versions, the selfCheck problem and the Director's banner (once per version set).
{
  const { familyVersions, unverifiedFamily, verifiedVersion } = await imp("compat/version-gate.mjs");
  const { versionBanner } = await imp("ui/version-banner.mjs");
  const { selfCheck } = await imp("self-check.mjs");
  assert.equal(verifiedVersion("draw-steel-combat-tools", "1.2.8"), true); assert.equal(verifiedVersion("draw-steel-combat-tools", "1.2.9"), false);
  assert.equal(verifiedVersion("some-other-module", "0.0.1"), true, "modules outside the family are not judged");
  game.modules.set("draw-steel-combat-tools", { active: true, version: "1.2.6" });
  game.modules.set("draw-steel-ctlib", { active: true, version: "1.4.0" });
  assert.deepEqual(unverifiedFamily(), []);
  assert.ok(!selfCheck().problemKeys.some(p => p.key === "DSAUTO.SelfCheck.unverifiedVersion"));
  game.modules.get("draw-steel-combat-tools").version = "1.3.0";
  assert.deepEqual(unverifiedFamily(), ["draw-steel-combat-tools 1.3.0"]);
  assert.equal(familyVersions().find(r => r.id === "draw-steel-combat-tools").verified, false);
  const check = selfCheck();
  assert.ok(check.problemKeys.some(p => p.key === "DSAUTO.SelfCheck.unverifiedVersion" && p.data.list === "draw-steel-combat-tools 1.3.0"));
  assert.equal(check.report.forcedBridge, undefined, "0.17.0: the path bridge is retired");
  const warned = [];
  const savedUi = globalThis.ui;
  globalThis.ui = { ...(savedUi ?? {}), notifications: { warn: (text, options) => warned.push([text, options]), info() {}, error() {} } };
  const savedUser = game.user;
  w.setUser(w.users.gm);
  assert.equal(versionBanner(), true); assert.equal(warned.length, 1); assert.equal(warned[0][1].permanent, true);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(versionBanner(), false, "once per version set"); assert.equal(warned.length, 1);
  game.modules.get("draw-steel-combat-tools").version = "1.3.1";
  assert.equal(versionBanner(), true, "a new version set warns again");
  w.setUser(savedUser); globalThis.ui = savedUi;
  game.modules.delete("draw-steel-combat-tools"); game.modules.delete("draw-steel-ctlib");
  console.log("ok 0.16.0 verified family versions, selfCheck unverifiedVersion, Director banner once per version set");
}

// 0.16.0 (house rule): a hero token rerolls an ability card's power roll: applied rows undone, the token spent through
// the system, one new 2d10 for every target with each target's own modifiers, tier parts rebuilt, the card resolved
// again from the new tiers; refused without a token, for a monster's card and with the setting off.
{
  const { rerollPowerRoll, heroRerollAllowed, heroRerollShown, rerolledParts, registerHeroTokenSpend, REROLL_SPEND } = await imp("resources/hero-token-reroll.mjs");
  const { PowerRoll, DamageRoll } = ds.rolls;
  const tierQueue = [];
  PowerRoll.prototype.clone = function() { const r = new this.constructor(this.total, { ...this.options }); r.terms = [{ dice: "2d10" }]; return r; };
  PowerRoll.prototype.evaluate = async function() { this.options.tier = tierQueue.length ? tierQueue.shift() : this.options.tier; this.total = 10; return this; };
  DamageRoll.prototype.evaluate = async function() { return this; };
  const spends = [];
  game.actors ??= {};
  const savedTokens = game.actors.heroTokens;
  game.actors.heroTokens = { value: 2, async spendToken(type, options) { spends.push([type, options.messageId]); this.value -= 1; }, async giveToken(n) { this.value += n; } };
  ds.CONFIG.hero ??= { tokenSpends: {} };
  registerHeroTokenSpend();
  assert.equal(ds.CONFIG.hero.tokenSpends[REROLL_SPEND].tokens, 1);
  const strike = w.makeAbility({ uuid: "Actor.hero000000000001.Item.rerollStrike0001", name: "Reroll Strike", actor: hero });
  strike.system.power.effects.documentsByType = { damage: [{ toDamageRoll: tier => new DamageRoll(tier * 3, { type: "fire" }) }] };
  const victim = w.gobA.getActiveTokens?.()?.[0] ?? docs[1];
  game.settings.set(MOD, "modeDamageNpc", "auto");
  const card = w.postAbility(strike, { 1: [w.tA] }, { 1: [{ total: 3, options: { type: "fire" } }] });
  // The mock message stores roll objects: read the JSON this module writes back into them.
  const mockUpdate = card.update.bind(card);
  card.update = async (changes, options) => {
    const out = {};
    for (const [k, v] of Object.entries(changes)) {
      if (v instanceof foundry.data.operators.ForcedDeletion) { const id = k.split(".").at(-1); delete card._srcParts[id]; continue; }
      if (k.startsWith("system.parts.") && Array.isArray(v?.rolls)) {
        out[k] = { ...v, rolls: v.rolls.map(s => { const d = JSON.parse(s); return d.options?.target ? new PowerRoll(d.total, d.options) : new DamageRoll(d.total, d.options); }) };
      } else out[k] = v;
    }
    return mockUpdate(out, options);
  };
  await new Promise(r => setTimeout(r, 50));
  let res = getResolution(card);
  assert.ok(res?.resolvedAt, "the card resolved");
  game.settings.set(MOD, "heroTokenRerollPowerRolls", false);
  assert.equal(heroRerollAllowed(card, res, w.users.gm), false, "setting off");
  game.settings.set(MOD, "heroTokenRerollPowerRolls", true);
  assert.equal(heroRerollAllowed(card, res, w.users.gm), true);
  assert.equal(heroRerollShown(card, res, w.users.gm), true);
  assert.equal(heroRerollAllowed(card, res, w.users.player), false, "a player who did not use the ability");
  const gmAuthor = card.author;
  card.author = w.users.player;
  assert.ok(Object.values(res.ops).some(o => o.status === "applied"), "rows applied");
  assert.equal(heroRerollAllowed(card, res, w.users.player), true, "the hero's owner who used it, rows applied");
  card.author = gmAuthor;
  const before = Object.values(res.ops).filter(o => o.kind === "damage");
  assert.equal(before.length, 1); assert.equal(before[0].tier, 1);
  // The parts alone: one tier-3 part with the new damage, the tier-1 part removed.
  tierQueue.push(3);
  const preview = await rerolledParts(card, strike, res);
  assert.deepEqual(preview.tiers, { [w.tA.actor.uuid]: 3 });
  assert.ok(preview.update["system.parts.tier3Result00000"]); assert.ok(preview.update["system.parts.tier1Result00000"] instanceof foundry.data.operators.ForcedDeletion);
  tierQueue.push(3);
  const out = await rerollPowerRoll(card, { user: w.users.gm });
  assert.deepEqual(out, { ok: true, tiers: { [w.tA.actor.uuid]: 3 } });
  assert.deepEqual(spends, [[REROLL_SPEND, card.id]]); assert.equal(game.actors.heroTokens.value, 1);
  assert.equal(card.flags[MOD].heroRerolls, 1);
  res = getResolution(card);
  const after = Object.values(res.ops).filter(o => o.kind === "damage");
  assert.equal(after.length, 1, "the tier-1 row is rebuilt, not kept as undone"); assert.equal(after[0].tier, 3); assert.equal(after[0].amount, 9);
  game.actors.heroTokens.value = 0;
  assert.deepEqual(await rerollPowerRoll(card, { user: w.users.gm }), { ok: false, refused: "noToken" });
  assert.equal(heroRerollShown(card, res, w.users.gm), false, "no button without a token");
  const monsterStrike = w.makeAbility({ uuid: "Actor.gobA.Item.monsterStrike01", name: "Monster Strike", actor: w.gobA });
  const monsterCard = w.postAbility(monsterStrike, { 2: [w.tB] }, {});
  await new Promise(r => setTimeout(r, 50));
  assert.equal(heroRerollAllowed(monsterCard, getResolution(monsterCard), w.users.gm), false, "monsters spend no hero tokens");
  game.settings.set(MOD, "heroTokenRerollPowerRolls", false);
  game.actors.heroTokens = savedTokens;
  void victim;
  console.log("ok 0.16.0 hero-token reroll of a power roll (undo, spend, new tiers, rebuilt rows), refused without a token, for monsters, setting off");
}

// 0.17.0: a library choice group answered by Combat Tools' choose picks (Practical Magic).
{
  const { dsctPickedOption } = await imp("library/choose-compat.mjs");
  const pm = { system: { effects: { contents: [{ id: "ch1", type: "dsct.choose", choose: { choices: [{ name: "Knockback" }, { name: "Damage" }, { name: "Teleport" }] } }] } } };
  const group = { id: "mode", options: [{ id: "knockback", dsctOption: "Knockback" }, { id: "strike", dsctOption: "Damage" }, { id: "teleport", dsctOption: "Teleport" }] };
  const card = picks => ({ flags: { "draw-steel-combat-tools": { choosePicks: picks } } });
  assert.equal(dsctPickedOption(pm, card({ ch1: 0 }), group), "knockback");
  assert.equal(dsctPickedOption(pm, card({ ch1: [2] }), group), "teleport");
  assert.equal(dsctPickedOption(pm, card({ ch1: [0, 1] }), group), null, "two picks: the card asks");
  assert.equal(dsctPickedOption(pm, card(null), group), null, "no picks on the card");
  assert.equal(dsctPickedOption({ system: { effects: { contents: [] } } }, card({ ch1: 0 }), group), null, "no choose effect");
  console.log("ok 0.17.0 library choice answered by Combat Tools' choose picks");
}
// 0.17.0: healing a defeated creature above 0 revives it.
{
  const { reviveWanted, reviveHealed } = await imp("resources/revive-on-heal.mjs");
  game.settings.set(MOD, "reviveOnHeal", true);
  const dead = CONFIG.specialStatusEffects?.DEFEATED ?? "dead";
  gobA.statuses.add(dead); gobA.system.stamina = { value: 15, max: 15, min: 0, temporary: 0 };
  assert.equal(reviveWanted(gobA, { ds: { previousStamina: { value: -2 } } }), true, "healed from 0 or below: revive");
  assert.equal(reviveWanted(gobA, {}), true, "no previous Stamina known: revive");
  assert.equal(reviveWanted(gobA, { ds: { previousStamina: { value: 10 } } }), false, "killed at positive Stamina (Power Word Kill) stays dead");
  assert.equal(reviveWanted(gobA, { [MOD]: { undo: true } }), false, "our undo revives by itself");
  assert.equal(reviveWanted(hero, {}), false, "heroes are left alone");
  gobA.system.stamina.value = 0;
  assert.equal(reviveWanted(gobA, {}), false, "still at 0");
  gobA.system.stamina.value = 15;
  game.settings.set(MOD, "reviveOnHeal", false);
  assert.equal(reviveWanted(gobA, {}), false, "setting off");
  game.settings.set(MOD, "reviveOnHeal", true);
  if (typeof gobA.toggleStatusEffect !== "function") gobA.toggleStatusEffect = async (id, { active }) => { if (active) gobA.statuses.add(id); else gobA.statuses.delete(id); };
  assert.equal(await reviveHealed(gobA, {}), true);
  assert.equal(gobA.statuses.has(dead), false, "the defeated status is lifted without Death Tracker");
  gobA.statuses.clear();
  console.log("ok 0.17.0 revive on heal: crossing above 0, Power Word Kill, undo, heroes, setting");
}
console.log("ALL HARNESS-13 TESTS PASSED");
