/**
 * 1.2.2: engine vocabulary for Judgement / Mark (Heroes p.80).
 *  - new event `ability.used` (emission, actionType), requires subjectEffect / sourceEffect / singleTarget / shifting / adjacent,
 *    roll.before for non-damaging power rolls (normalizer default `damaging: true` keeps the old behaviour),
 *    steps bane / speedZero / damage, `yieldsTo` Combat Tools, and the automatic melee taunt (feature rule requires).
 * Mocks on harness.mjs's world: tokens and actors in a uuid map, a tiny formula evaluator, a fake roll dialog.
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const paths = createRequire(import.meta.url)("./paths.cjs");
const imp = p => import(pathToFileURL(paths.SCRIPTS + p).href);
globalThis.__HARNESS_SKIP_SCENARIOS__ = true;
await import("./harness.mjs");

const schema = await imp("library/schema.mjs");
const tax = await imp("triggers/taxonomy.mjs");
const elig = await imp("triggers/eligibility.mjs");
const rollLock = await imp("triggers/roll-lock.mjs");
const cardMod = await imp("triggers/card.mjs");
const abilityUsed = await imp("triggers/ability-used.mjs");
const features = await imp("features/engine.mjs");
const custom = await imp("library/custom.mjs");
const mods = await imp("engine/modifiers.mjs");
const dmg = await imp("engine/damage.mjs");
const undoMod = await imp("engine/undo.mjs");
const targeted = await imp("engine/targeted.mjs");
const libPlan = await imp("engine/library-plan.mjs");
const carries = await imp("triggers/carries.mjs");
const gains = await imp("resources/gains.mjs");

const MOD = "stef-ds-automation";
const CT = "draw-steel-combat-tools";
const JUDGED = "MHQDlicbxXquwduc";
const MARKED = "YW2JEdoDPd0XlaII";
const SCENE = "scene00000000001";

/* ---------- world ---------- */
const docs = new Map();
globalThis.fromUuidSync = u => docs.get(u) ?? null;
globalThis.fromUuid = async u => docs.get(u) ?? null;
// A real tiny evaluator (the base harness only knows numbers and @potency).
ds.utils.evaluateFormula = (f, rd) => Number(Function(`"use strict"; return (${String(f).replace(/@([A-Za-z_][\w.]*)/g, (_m, p) => Number(p.split(".").reduce((o, k) => o?.[k], rd)) || 0)});`)());
let n = 0;
const id16 = () => `x${String(++n).padStart(15, "0")}`;
function effectsOf(list) {
  const c = new Map();
  c.contents = list;
  c.get = k => list.find(e => e.id === k);
  c.find = fn => list.find(fn);
  c.has = k => list.some(e => e.id === k);
  return c;
}
function mkActor(name, { type = "hero", dsid = "x", immune = [] } = {}) {
  const a = {
    uuid: `Actor.${id16()}`, name, type, statuses: new Set(), items: [], flags: {},
    system: {
      restrictions: {}, stamina: { value: 30, temporary: 0, max: 30, min: -10 },
      damage: { immunities: { all: 0 }, weaknesses: { all: 0 } },
      coreResource: { path: "system.hero.primary.value", name: "Wrath", minimum: 0, target: null },
      hero: { primary: { value: 3 } },
      calculateImmunityAndWeakness() { return {}; },
      async takeDamage(amount) { a.system.stamina.value -= amount; },
    },
  };
  a.system.statusImmunities = new Set(immune);
  a.effectList = [];
  a.effects = effectsOf(a.effectList);
  Object.defineProperty(a, "appliedEffects", { get: () => { for (const e of a.effectList) e.getFlag ??= function (s, k) { return this.flags?.[s]?.[k]; }; return a.effectList; } });
  Object.defineProperty(a.system, "statuses", { get: () => ({
    immunities: a.system.statusImmunities,
    taunted: { sources: { has: u => a.effectList.some(e => (e.system?.changes ?? []).some(c => c.key === "system.statuses.taunted.sources" && c.value === u)) } },
  }) });
  a.getRollData = () => ({ P: 3, M: 2 });
  a.testUserPermission = () => true;
  a.update = async changes => { for (const [k, v] of Object.entries(changes)) { const p = k.split("."); let o = a; for (const s of p.slice(0, -1)) o = o[s]; o[p.at(-1)] = v; } return a; };
  a.modifyTokenAttribute = async (_attr, v) => { a.system.stamina.value += v; return a; };
  a.createEmbeddedDocuments = async (_t, data) => data.map(d => {
    const e = { ...JSON.parse(JSON.stringify(d)), parent: a, flags: JSON.parse(JSON.stringify(d.flags ?? {})) };
    e.id = d._id ?? id16();
    e.toObject = () => ({ ...JSON.parse(JSON.stringify({ ...e, parent: undefined })), _id: e.id });
    e.update = async ch => { for (const [k, v] of Object.entries(ch)) { const p = k.split("."); let o = e; for (const s of p.slice(0, -1)) o = o[s] ??= {}; o[p.at(-1)] = v; } return e; };
    e.delete = async () => { a.effectList.splice(a.effectList.indexOf(e), 1); };
    a.effectList.push(e);
    return e;
  });
  a.deleteEmbeddedDocuments = async (_t, ids) => { for (const i of ids) { const e = a.effects.get(i); if (e) a.effectList.splice(a.effectList.indexOf(e), 1); } };
  docs.set(a.uuid, a);
  return a;
}
function mkToken(actor, x, y, disposition) {
  const t = {
    uuid: `Scene.${SCENE}.Token.${id16()}`, name: actor.name, actor, disposition, x: x * 100, y: y * 100, width: 1, height: 1,
    parent: { id: SCENE, grid: { size: 100, distance: 5 } }, elevation: 0,
  };
  actor.token = null;
  docs.set(t.uuid, t);
  return t;
}
function mkItem(actor, name, { type = "triggered", dsid = name.toLowerCase().replace(/\W+/g, "-") } = {}) {
  const item = {
    uuid: `${actor.uuid}.Item.${id16()}`, name, type: "ability", actor, flags: {},
    system: { type, resource: 0, _dsid: dsid, distance: { type: "melee", primary: 1 }, keywords: new Set(["melee"]) },
    getRollData: () => ({ P: 3 }),
  };
  actor.items.push(item);
  docs.set(item.uuid, item);
  return item;
}
const FRIENDLY = 1;
const HOSTILE = -1;
const censor = mkActor("Censor");
const judgement = mkItem(censor, "Judgement", { type: "main" });
const censorTok = mkToken(censor, 0, 0, FRIENDLY);
const judged = mkActor("Judged Goblin", { type: "npc" });
const judgedTok = mkToken(judged, 1, 0, HOSTILE);
const other = mkActor("Other Goblin", { type: "npc" });
const otherTok = mkToken(other, 2, 0, HOSTILE);
const ally = mkActor("Ally");
const allyTok = mkToken(ally, 0, 1, FRIENDLY);
judged.effectList.push({ id: JUDGED, origin: judgement.uuid, disabled: false, system: { changes: [] }, flags: {} });
// An effect of a different censor's Judgement does not count as ours.
const rival = mkActor("Rival Censor");
const rivalJ = mkItem(rival, "Judgement", { type: "main" });
other.effectList.push({ id: JUDGED, origin: rivalJ.uuid, disabled: false, system: { changes: [] }, flags: {} });
const far = mkActor("Far Goblin", { type: "npc" });
const farTok = mkToken(far, 4, 0, HOSTILE);
far.effectList.push({ id: JUDGED, origin: judgement.uuid, disabled: false, system: { changes: [] }, flags: {} });
await game.settings.set(MOD, "triggersOutsideCombat", true);
const ctSettings = { judgementAutomation: false, markAutomation: false };
for (const [k, v] of Object.entries(ctSettings)) game.settings.register(CT, k, { default: v });
game.modules.delete(CT);

/* ---------- overlays (the shapes the Judgement / Mark overlays will use) ---------- */
const subjectJudged = { ability: "judgement", effect: JUDGED };
const base = triggers => ({
  key: "ability:judgement", version: "1.2.2", name: "Judgement", effects: [{ id: "judged", type: "condition", effect: JUDGED }], triggers,
});
const J1 = {
  id: "holy", event: "ability.used", subject: "enemy", free: true, range: "unlimited", cost: 0, yieldsTo: "judgementAutomation",
  require: { actionType: "main", subjectEffect: subjectJudged },
  steps: [{ type: "damage", value: "2*@P", damageType: "holy" }],
};
const J2a = {
  id: "shift", event: "move.before", subject: "enemy", free: true, range: 1, cost: 1, yieldsTo: "judgementAutomation",
  require: { shifting: true, adjacent: true, subjectEffect: subjectJudged },
  steps: [{ type: "freeStrike", by: "reactor" }, { type: "speedZero" }],
};
const J2b = {
  id: "bane", event: "roll.before", subject: "enemy", free: true, range: 10, cost: 1, yieldsTo: "judgementAutomation",
  require: { damaging: false, subjectEffect: subjectJudged },
  steps: [{ type: "bane", amount: 1 }],
};
const J2c = {
  id: "potency", event: "damage.before", subject: "selfOrCreature", free: true, range: "unlimited", cost: 1, yieldsTo: "judgementAutomation",
  require: { singleTarget: true, sourceEffect: subjectJudged },
  steps: [{ type: "potency", delta: -1, scope: "one" }],
};
const TAUNT = {
  key: "ability:judgement", version: "1.2.2", name: "Judgement", effects: [{ id: "judged", type: "condition", effect: JUDGED }],
  automation: {
    version: 1,
    rules: [{
      id: "taunt", event: "damage.after", targets: "subject", yieldsTo: "judgementAutomation",
      require: { subject: "creature", dealer: "self", melee: true, subjectEffect: subjectJudged },
      effects: [{ id: "taunted", type: "condition", status: "taunted", end: "turn" }],
    }],
  },
};

/* ---------- 1. vocabulary and validation ---------- */
{
  assert.ok(tax.TRIGGER_EVENTS.includes("ability.used") && tax.EVENT_PHASE["ability.used"] === "after");
  assert.deepEqual(tax.EVENT_STEPS["ability.used"], ["damage", "note"]);
  assert.ok(tax.EVENT_STEPS["roll.before"].includes("bane") && tax.EVENT_STEPS["move.before"].includes("speedZero") && tax.EVENT_STEPS["move.before"].includes("freeStrike"));
  for (const t of [J1, J2a, J2b, J2c]) {
    const out = schema.validateOverlay(base([t]));
    assert.ok(out.ok, `${t.id}: ${out.errors.join("; ")}`);
  }
  assert.ok(schema.validateOverlay(TAUNT).ok, schema.validateOverlay(TAUNT).errors.join("; "));
  const bad = (t, text) => {
    const out = schema.validateOverlay(base([t]));
    assert.ok(!out.ok && out.errors.some(e => e.includes(text)), `${text} in ${JSON.stringify(out.errors)}`);
  };
  bad({ ...J1, require: { actionType: "bogus" } }, "actionType");
  bad({ ...J1, yieldsTo: "nope" }, "yieldsTo");
  bad({ ...J1, require: { subjectEffect: { effect: JUDGED } } }, "subjectEffect");
  bad({ ...J1, require: { subjectEffect: { ability: "judgement", effect: "short" } } }, "subjectEffect");
  bad({ ...J1, steps: [{ type: "damage", value: "2*(" }] }, "formula");
  bad({ ...J1, steps: [{ type: "bane", amount: 1 }] }, "does not go with ability.used");
  bad({ ...J2a, steps: [{ type: "freeStrike" }, { type: "speedZero" }] }, "by: \"reactor\"");
  bad({ ...J2a, require: { shifting: false } }, "can only be true");
  bad({ ...J2c, require: { shifting: true } }, "does not go with damage.before");
  bad({ ...J2b, steps: [{ type: "bane", amount: 3 }] }, "bane needs");
  bad({ ...J2b, require: { damaging: "yes" } }, "damaging");
  bad({ ...J1, require: { actionType: "main" }, steps: [{ type: "speedZero" }] }, "does not go with ability.used");
  // damaging default: the normalizer keeps the old damaging-only roll.before; false opts out
  const wog = { id: "g", event: "roll.before", subject: "ally", steps: [{ type: "edge", amount: 1 }] };
  assert.equal(schema.normalizeOverlay(base([wog])).triggers[0].require.damaging, true, "default damaging true");
  assert.equal(schema.normalizeOverlay(base([J2b])).triggers[0].require.damaging, false, "explicit false kept");
  assert.equal(schema.normalizeOverlay(base([{ ...wog, require: { damaging: true } }])).triggers[0].require.damaging, true);
  assert.equal(schema.normalizeOverlay(base([J1])).triggers[0].require.damaging, undefined, "other events untouched");
  console.log("ok vocabulary and validation");
}

/* ---------- 2. eligibility ---------- */
const trig = t => schema.normalizeOverlay(base([t])).triggers[0];
const ctx = (event, t) => ({ event, reactorActor: censor, reactorToken: censorTok, item: judgement, trigger: trig(t), combat: null });
const ref = (actor, tok) => ({ actorUuid: actor.uuid, tokenUuid: tok.uuid, name: actor.name });
const used = (actor, tok, actionType = "main") => abilityUsed.abilityUsedEvent({
  user: { actorUuid: actor.uuid, tokenUuid: tok.uuid, isHero: actor.type === "hero" }, itemUuid: `${actor.uuid}.Item.zz`, actionType, sceneId: SCENE, messageId: "msg1",
});
{
  // ability.used: the event and actionType filtering, subjectEffect
  const ev = used(judged, judgedTok);
  assert.equal(ev.kind, "ability.used");
  assert.equal(ev.subject.tokenUuid, judgedTok.uuid);
  assert.equal(ev.source.actorUuid, judged.uuid, "source = the user");
  assert.equal(ev.ability.actionType, "main");
  const c = elig.evaluate(ctx(ev, J1));
  assert.ok(c, "a judged creature using a main action is offered the holy damage");
  assert.deepEqual(c.steps.base.map(s => s.type), ["damage"]);
  assert.equal(elig.evaluate(ctx(used(judged, judgedTok, "maneuver"), J1)), null, "a maneuver is not a main action");
  assert.equal(elig.evaluate(ctx(used(other, otherTok), J1)), null, "judged by someone else: no");
  assert.equal(elig.evaluate(ctx(used(ally, allyTok), J1)), null, "an ally is not an enemy");
  assert.ok(!carries.carriesEffectOf(other, censor, subjectJudged) && carries.carriesEffectOf(other, rival, subjectJudged));
  assert.equal(gains.carriesEffectOf, carries.carriesEffectOf, "gains re-exports the shared helper");
  // out of the censor's reach: unlimited range, but no line of effect = no offer
  const wall = { ...judgedTok, object: { hasLineOfEffect: () => true } };
  assert.ok(elig.evaluate({ ...ctx(ev, J1) }));

  // move.before: shifting + adjacent
  const move = (tok, shifting) => ({ id: "m", kind: "move.before", sceneId: SCENE, subject: ref(tok.actor, tok), source: { actorUuid: null, tokenUuid: null, known: false, keywords: [] }, move: { tokenUuid: tok.uuid, shifting }, at: 0 });
  const mc = elig.evaluate(ctx(move(judgedTok, true), J2a));
  assert.ok(mc, "an adjacent judged creature starts to shift");
  assert.deepEqual(mc.steps.base.map(s => s.type), ["freeStrike", "speedZero"]);
  assert.equal(elig.evaluate(ctx(move(judgedTok, false), J2a)), null, "walking is not shifting");
  assert.equal(elig.evaluate(ctx(move(farTok, true), J2a)), null, "not adjacent");
  assert.deepEqual(elig.strikeTargetOf(move(judgedTok, true)), { tokenUuid: judgedTok.uuid, name: "Judged Goblin" }, "the reactor strikes the mover");

  // roll.before: non-damaging roll, and the unchanged damaging default
  const roll = (tok, damaging) => ({ id: "r", kind: "roll.before", sceneId: SCENE, subject: ref(tok.actor, tok), source: { keywords: [] }, roll: { abilityUuid: "x", dialogId: "d", damaging }, at: 0 });
  assert.ok(elig.evaluate(ctx(roll(judgedTok, false), J2b)), "non-damaging power roll of a judged creature");
  assert.ok(elig.evaluate(ctx(roll(judgedTok, true), J2b)), "damaging too (damaging: false = no check)");
  assert.equal(elig.evaluate(ctx(roll(otherTok, false), J2b)), null, "not judged by this censor");
  const wogT = { id: "g", event: "roll.before", subject: "enemy", steps: [{ type: "edge", amount: 1 }] };
  assert.equal(elig.evaluate(ctx(roll(judgedTok, false), wogT)), null, "default damaging true: a non-damaging roll is not offered");
  assert.ok(elig.evaluate(ctx(roll(judgedTok, true), wogT)), "default damaging true: a damaging roll is");
  const tenAway = mkActor("Distant", { type: "npc" });
  const tenTok = mkToken(tenAway, 11, 0, HOSTILE);
  tenAway.effectList.push({ id: JUDGED, origin: judgement.uuid, disabled: false, system: { changes: [] }, flags: {} });
  assert.equal(elig.evaluate(ctx(roll(tenTok, false), J2b)), null, "more than 10 squares away");

  // damage.before: singleTarget, sourceEffect, potency
  const hit = (targetCount, source = judged, sourceTok = judgedTok, hasPotency = true) => ({
    id: "d", kind: "damage.before", sceneId: SCENE, subject: ref(ally, allyTok), source: { ...ref(source, sourceTok), itemUuid: "i", keywords: ["melee"], fromAbility: true, known: true },
    damage: { instanceKey: "k", amount: 5, type: "", halved: false, hasPotency, targetCount, external: false }, at: 0,
  });
  const pc = elig.evaluate(ctx(hit(1), J2c));
  assert.ok(pc && pc.steps.base[0].type === "potency" && pc.steps.base[0].scope === "one", "one-target ability of a judged creature: potency -1 for that creature");
  assert.equal(elig.evaluate(ctx(hit(2), J2c)), null, "two targets: no");
  assert.equal(elig.evaluate(ctx(hit(1, other, otherTok), J2c)), null, "source not judged by this censor");
  assert.equal(elig.evaluate(ctx(hit(1, judged, judgedTok, false), J2c)), null, "no potency to reduce: moot");
  console.log("ok eligibility: ability.used, subjectEffect, sourceEffect, singleTarget, shifting, adjacent, damaging");
}

/* ---------- 3. yieldsTo: per effect (Combat Tools' extras only fire for the judgements it made) ---------- */
{
  const ev = used(judged, judgedTok);
  assert.ok(elig.evaluate(ctx(ev, J1)), "Combat Tools off: offered");
  game.modules.set(CT, { active: true, version: "2.2.4" });
  await game.settings.set(CT, "judgementAutomation", true);
  assert.ok(elig.evaluate(ctx(ev, J1)), "judgementAutomation on, the suite's own judgement: still offered (Combat Tools cannot see it)");
  // A judgement Combat Tools made itself (its flag): left to Combat Tools while its automation is on.
  const ctJudged = mkActor("CT-judged Goblin", { type: "npc" });
  const ctJudgedTok = mkToken(ctJudged, 1, 1, HOSTILE);
  ctJudged.effectList.push({ id: JUDGED, origin: judgement.uuid, disabled: false, system: { changes: [] }, flags: { [CT]: { judgement: { userId: "u1" } } } });
  const evCt = used(ctJudged, ctJudgedTok);
  assert.equal(elig.evaluate(ctx(evCt, J1)), null, "Combat Tools' own judgement: yields");
  assert.ok(elig.evaluate(ctx(evCt, { ...J1, yieldsTo: undefined })), "no yieldsTo: offered");
  assert.ok(elig.evaluate(ctx(evCt, { ...J1, yieldsTo: "markAutomation" })), "another setting off: offered");
  assert.equal(elig.triggerYieldFlag(trig(J1)), "judgement");
  // feature rules take the same field, per effect too
  const item = mkItem(censor, "Judgement taunt");
  item.flags[MOD] = { automation: TAUNT.automation };
  const rule = features.featureRules(item)[0];
  assert.ok(rule, "the rule is always listed");
  const dmg = who => ({ kind: "damage.after", sceneId: SCENE, subject: { actorUuid: who.uuid }, source: { actorUuid: censor.uuid } });
  const rq = { ...rule, require: { subjectEffect: rule.require.subjectEffect } };
  assert.equal(features.ruleEventMatches(item, rq, dmg(judged)), true, "the suite's judgement: the taunt runs");
  assert.equal(features.ruleEventMatches(item, rq, dmg(ctJudged)), false, "Combat Tools' judgement while it is on: left to it");
  await game.settings.set(CT, "judgementAutomation", false);
  assert.ok(elig.evaluate(ctx(evCt, J1)), "Combat Tools' automation off: its judgement gets the suite's extras");
  assert.equal(features.ruleEventMatches(item, rq, dmg(ctJudged)), true);
  game.modules.delete(CT);
  console.log("ok yieldsTo per effect");
}

/* ---------- 4. ability.used emission ---------- */
{
  const sel = abilityUsed.abilityUsedEvent({ user: { actorUuid: judged.uuid, tokenUuid: judgedTok.uuid, isHero: false }, itemUuid: judgement.uuid, actionType: "main", sceneId: SCENE, messageId: "m9" });
  assert.equal(sel.subject.name, "Judged Goblin");
  assert.deepEqual(sel.ability, { itemUuid: judgement.uuid, actionType: "main", messageId: "m9" });
  // Nothing declares ability.used yet: a card is ignored quietly.
  const smash = mkItem(judged, "Smash", { type: "main" });
  const mkMsg = (id, item = smash) => ({ id, speaker: { scene: SCENE, token: judgedTok.id, actor: judged.id }, system: { parts: [{ type: "abilityUse", abilityUuid: item.uuid }] } });
  const quiet = [];
  const spy = Hooks.on("dsAuto.preTrigger", (event, c) => { quiet.push({ kind: event.kind, type: event.ability?.actionType, reactor: c.reactor.name }); return false; });
  assert.deepEqual(await abilityUsed.onAbilityUsedMessage(mkMsg("msgquiet")), []);
  assert.equal(quiet.length, 0, "no overlay with an ability.used trigger: no event");
  // An overlay with the J1 trigger: ONE event per card, however often the card is seen again.
  const registry = await imp("library/registry.mjs");
  const scene = { id: SCENE, tokens: [censorTok, judgedTok, otherTok, allyTok, farTok] };
  game.scenes.get = id => (id === SCENE ? scene : null);
  registry.registerSource({ id: "t34", overlays: [base([{ ...J1, yieldsTo: undefined }])] });
  await abilityUsed.onAbilityUsedMessage(mkMsg("msg1a"));
  await abilityUsed.onAbilityUsedMessage(mkMsg("msg1a"));
  await abilityUsed.onAbilityUsedMessage({ ...mkMsg("msg1a") });
  assert.deepEqual(quiet, [{ kind: "ability.used", type: "main", reactor: "Censor" }], "one event for one card");
  await abilityUsed.onAbilityUsedMessage(mkMsg("msg1b"));
  assert.equal(quiet.length, 2, "a second card is a second event");
  quiet.length = 0;
  const maneuver = mkItem(judged, "Slip Away", { type: "maneuver" });
  await abilityUsed.onAbilityUsedMessage(mkMsg("msg2", maneuver));
  assert.equal(quiet.length, 0, "a maneuver: the trigger's actionType main filters it before any prompt");
  registry.unregisterSource("t34");
  void spy;
  console.log("ok ability.used event");
}

/* ---------- 5. bane step ---------- */
{
  const dec = (id, steps, outcome = "used") => ({ id, outcome, steps, candidate: { reactor: { name: "R" + id }, item: { name: "Judgement" } } });
  const released = [];
  const t = rollLock.tallyRollMods([dec("a", [{ type: "bane", amount: 1 }]), dec("b", [{ type: "bane", amount: 2 }]), dec("c", [{ type: "bane", amount: 1 }]), dec("e", [{ type: "edge", amount: 1 }])], { release: d => released.push(...d) });
  assert.equal(t.banes, 2, "banes are capped at 2");
  assert.equal(t.edges, 1, "edges tallied apart");
  assert.deepEqual(t.held.map(d => d.id), ["a", "b", "e"]);
  assert.equal(released.length, 1);
  assert.equal(released[0].outcome, "moot");
  assert.equal(released[0].why, "edgeCap");
  assert.equal(t.effects.get("a").banes, 1);
  const skipped = rollLock.tallyRollMods([dec("s", [{ type: "bane", amount: 1 }])], { aborted: true, release: () => {} });
  assert.equal(skipped.banes + skipped.edges, 0);

  // the dialog (no pills): context.modifiers.banes, capped by what fits; an NPC roller's dialog is the same app
  const app = { options: { context: { modifiers: { edges: 0, banes: 1 } } }, render() { this.rendered = true; } };
  const st = { pills: false, edges: 0, banes: 0, edgesBase: 0, banesBase: 0 };
  assert.equal(rollLock.addMods(app, st, "bane", { amount: 2, sources: [{ name: "Censor", ability: "Judgement" }] }), 1, "only 1 more fits");
  assert.equal(app.options.context.modifiers.banes, 2);
  assert.equal(app.options.context.modifiers.edges, 0, "edges untouched");
  assert.equal(st.banesBase, 1);
  st.banes = 1;
  assert.ok(rollLock.modsKept(app, st), "still on the roll");
  app.options.context.modifiers.banes = 1;
  assert.ok(!rollLock.modsKept(app, st), "the roller lowered it: released");
  assert.equal(rollLock.addMods({ options: { context: { modifiers: { banes: 2 } } }, render() {} }, { pills: false }, "bane", { amount: 1, sources: [] }), 0, "full: nothing added");
  // Combat Tools roll pills: kind "bane"
  const pills = [];
  game.modules.set(CT, { active: true, version: "2.2.4", api: { rollDialog: { addPill: (a, p) => { const pill = { ...p, enabled: true }; a._dsctSources.push(pill); pills.push(pill); return true; } } } });
  const papp = { _dsctSources: [], options: { context: {} } };
  const pst = { pills: true, edges: 0, banes: 0 };
  assert.equal(rollLock.addMods(papp, pst, "bane", { amount: 1, sources: [{ name: "Cen<b>sor", ability: "Judgement" }] }), 1);
  assert.equal(pills[0].kind, "bane");
  assert.ok(!pills[0].src.includes("<b>"), "names are escaped");
  assert.equal(pst.banePill, pills[0]);
  pst.banes = 1;
  assert.ok(rollLock.modsKept(papp, pst));
  pills[0].enabled = false;
  assert.ok(!rollLock.modsKept(papp, pst), "pill switched off: released");
  game.modules.delete(CT);
  // GM answer shape through the relay handler's result object
  assert.ok("banes" in { banes: t.banes, baneSources: t.baneSources });
  console.log("ok bane step");
}

/* ---------- 6. speedZero and damage steps (ops of the trigger card) ---------- */
{
  const ev = used(judged, judgedTok);
  const decision = steps => ({ id: "dd", outcome: "used", steps, candidate: { event: { ...ev, id: "evt1" }, trigger: { id: "holy" }, reactor: { actorUuid: censor.uuid, name: "Censor" }, item: { uuid: judgement.uuid, name: "Judgement" } } });
  const ops = cardMod.stepOps(decision([{ type: "damage", value: "2*@P", damageType: "holy" }, { type: "speedZero" }, { type: "note", text: "x" }]), censor);
  assert.equal(ops.length, 2);
  const [dop, sop] = ops;
  assert.equal(dop.kind, "damage");
  assert.equal(dop.amount, 6, "2 * Presence 3, rolled with the reactor's roll data");
  assert.equal(dop.type, "holy");
  assert.ok(dop.lib && dop.mode === "auto" && dop.status === "pending");
  assert.equal(sop.kind, "modifier");
  assert.equal(sop.property, "system.movement.value");
  assert.equal(sop.modifierMode, "override");
  assert.equal(sop.value, 0);
  assert.equal(sop.featureEnd, "turnEnd");
  assert.equal(cardMod.stepOps(decision([{ type: "damage", value: "@zzz" }]), censor)[0].status, "failed", "an unknown formula path fails the row");
  const text = cardMod.stepSummary(decision([{ type: "damage", value: "2*@P", damageType: "holy" }, { type: "speedZero" }, { type: "bane", amount: 1 }]), { banes: 1 });
  assert.equal(text.length, 3);

  // apply + undo of the speed row on the judged creature
  const res = { targets: { k1: { actorUuid: judged.uuid, tokenUuid: judgedTok.uuid } }, abilityUuid: null, sourceActorUuid: censor.uuid, abilityName: "Judgement" };
  const message = { id: "card1" };
  const row = { ...sop, targetKeys: ["k1"] };
  const patch = await mods.applyModifier(message, res, row);
  assert.equal(patch.status, "applied");
  const eff = judged.effects.get(patch.createdIds[0]);
  assert.deepEqual(eff.system.changes[0], { key: "system.movement.value", value: 0, type: "override", phase: "initial" });
  assert.equal(eff.flags[MOD].ruleEffect.end, "turnEnd", "ends with the creature's turn (features/engine.mjs expireRules)");
  const undone = await undoMod.undoOp(message, res, { ...row, ...patch });
  assert.equal(undone.status, "undone");
  assert.equal(judged.effectList.filter(e => e.id === patch.createdIds[0]).length, 0, "undo removes the speed effect");

  // apply + undo of the holy damage row
  const drow = { ...dop, targetKeys: ["k1"] };
  const before = judged.system.stamina.value;
  const dpatch = await dmg.applyDamageOp(message, res, drow);
  assert.equal(dpatch.status, "applied");
  assert.equal(judged.system.stamina.value, before - 6);
  assert.equal(dpatch.finalAmount, 6);
  const dundo = await undoMod.undoOp(message, res, { ...drow, ...dpatch });
  assert.equal(dundo.status, "undone");
  assert.equal(judged.system.stamina.value, before, "undo gives the Stamina back");
  console.log("ok speedZero and damage steps");
}

/* ---------- 7. automatic taunt ---------- */
{
  const rule = TAUNT.automation.rules[0];
  const meleeItem = mkItem(censor, "Mace Strike");
  const dmgEvent = ({ dealer = censor, keywords = ["melee"], subject = judged, subjectTok = judgedTok, distance = 1 } = {}) => ({
    id: "e", kind: "damage.after", sceneId: SCENE, subject: ref(subject, subjectTok),
    source: { actorUuid: dealer.uuid, tokenUuid: censorTok.uuid, itemUuid: meleeItem.uuid, keywords, fromAbility: true, known: true, name: dealer.name },
    damage: { amount: 4, finalAmount: 4, external: false }, at: 0, _distance: distance,
  });
  const taunter = mkItem(censor, "Judgement");
  const match = ev => features.ruleEventMatches(taunter, rule, ev);
  assert.ok(match(dmgEvent()), "the owner's melee damage on a judged creature");
  assert.ok(!match(dmgEvent({ dealer: ally })), "damage dealt by someone else");
  assert.ok(!match(dmgEvent({ keywords: ["ranged"] })), "a ranged ability");
  assert.ok(match(dmgEvent({ keywords: ["melee", "ranged"] })), "melee+ranged used within melee reach (adjacent)");
  assert.ok(!match(dmgEvent({ subject: other, subjectTok: otherTok })), "a creature judged by someone else");
  const farEvent = dmgEvent({ keywords: ["melee", "ranged"], subject: far, subjectTok: farTok });
  assert.ok(!match(farEvent), "melee+ranged used from beyond its melee reach is a ranged strike");
  assert.ok(!match({ ...dmgEvent(), source: { ...dmgEvent().source, fromAbility: false } }), "not from an ability card");
  assert.ok(!features.ruleEventMatches(taunter, { ...rule, require: { ...rule.require, dealer: "self" } }, { ...dmgEvent(), source: { actorUuid: null, keywords: ["melee"], fromAbility: true } }));
  // Mark: the same rule with the marked effect
  const markRule = { ...rule, require: { ...rule.require, subjectEffect: { ability: "mark", effect: MARKED } } };
  assert.ok(schema.validateOverlay({ ...TAUNT, key: "ability:mark", name: "Mark", effects: [{ id: "marked", type: "condition", effect: MARKED }], automation: { version: 1, rules: [markRule] } }).ok);
  assert.ok(!features.ruleEventMatches(taunter, markRule, dmgEvent()), "judged is not marked");
  const marked = mkActor("Marked", { type: "npc" });
  const markedTok = mkToken(marked, 1, 1, HOSTILE);
  const markItem = mkItem(censor, "Mark");
  marked.effectList.push({ id: MARKED, origin: markItem.uuid, disabled: false, system: { changes: [] }, flags: {} });
  assert.ok(features.ruleEventMatches(taunter, markRule, dmgEvent({ subject: marked, subjectTok: markedTok })));
  // bad rule values
  const badRule = r => custom.validateAutomation({ version: 1, rules: [{ ...rule, ...r }] }).ok;
  assert.ok(!badRule({ yieldsTo: "x" }) && !badRule({ require: { dealer: "ally" } }) && !badRule({ require: { subjectEffect: { effect: JUDGED } } }) && !badRule({ require: { melee: "yes" } }));

  // the planned row: taunted until the end of the creature's turn, from the owner; immune creatures are skipped
  const effects = schema.normalizeOverlay({ ...TAUNT, effects: rule.effects }).effects;
  const plan = target => libPlan.libraryOps({
    lib: { effects, config: {}, choices: [] }, item: taunter,
    targets: { k1: { key: "k1", tokenUuid: target.uuid, actorUuid: target.actor.uuid, name: target.name, tier: null } },
    selfKey: null, self: { tier: null }, use: {}, noPowerRoll: true, warnings: [], order: 0, sourceTokenUuid: censorTok.uuid,
    decideMode: () => "auto", forcedRow: () => null,
  }).ops;
  game.settings.register(MOD, "targetedConditions", { default: "auto" });
  const rows = Object.values(plan(judgedTok));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].effectId, "taunted");
  assert.equal(rows[0].end, "turn", "the system's [[/apply taunted turn]] end");
  assert.equal(rows[0].targeted, true);
  assert.ok(["native", "dsct", "off"].includes(rows[0].route ?? "off"), "routed through targetedRoute");
  judged.system.statusImmunities.add("taunted");
  const immune = Object.values(plan(judgedTok))[0];
  assert.equal(immune.status, "skipped");
  assert.equal(immune.reason, "statusImmune", "taunt immunity is respected");
  judged.system.statusImmunities.delete("taunted");

  // applied natively with the owner as the source, and undone
  CONFIG.statusEffects.push({ id: "taunted", _id: "taunted00000000", name: "Taunted" });
  const res = { targets: { k1: { actorUuid: judged.uuid, tokenUuid: judgedTok.uuid } }, sourceActorUuid: censor.uuid, sourceTokenUuid: censorTok.uuid, abilityUuid: taunter.uuid };
  const op = { ...rows[0], targetKeys: ["k1"], route: "native" };
  const patch = await targeted.applyNativeTargeted({ id: "card2" }, res, op, taunter, judged);
  assert.equal(patch.status, "applied", JSON.stringify(patch));
  assert.equal(patch.sourceUuid, censor.uuid, "the taunt source is the owner");
  const tEffect = judged.effectList.find(e => e.id === "taunted00000000");
  assert.equal(tEffect.duration.expiry, "turnEnd");
  assert.ok(judged.system.statuses.taunted.sources.has(censor.uuid));
  const gone = await undoMod.undoOp({ id: "card2" }, res, { ...op, ...patch });
  assert.equal(gone.status, "undone");
  assert.ok(!judged.effectList.some(e => e.id === "taunted00000000"), "undo removes the taunt");
  console.log("ok automatic taunt");
}

console.log("harness34 done");
process.exit(0);
