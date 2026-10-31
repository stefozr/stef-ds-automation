// Second harness: delegation, lock mapping, private cards, choose gate, hook veto, late targets,
// and a real Handlebars render of the template with a view built by the module.
// Reuses harness.mjs's mock world by importing it with a flag that skips its own scenarios.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

globalThis.__HARNESS_SKIP_SCENARIOS__ = true;
const world = await import(new URL("./harness.mjs", import.meta.url).href);
const { postAbility, settle, makeAbility, hero, tA, tB, gobA, gobB, api, getResolution, buildView, Effect, setCombat, setDstd, Message, gm } = world;
const paths = createRequire(import.meta.url)("./paths.cjs"); const ROOT = paths.SCRIPTS;
const { blockingOp, blockingEnricherOp, onCaptureClick } = await import(pathToFileURL(ROOT + "ui/dstd-lock.mjs").href);

/* ---------- DSCT delegation: frightened with start.combatant patch ---------- */
{
  setCombat({ getCombatantsByActor: (a) => [{ id: `cmb-${a.name}`, initiative: 1 }] });
  const calls = [];
  const dsctApi = {
    async applyFrightened(targetToken, sourceActor, sourceTokenId, endStr) {
      calls.push({ target: targetToken.name, source: sourceActor.name, sourceTokenId, endStr });
      const a = targetToken.actor;
      const e = new Effect({ name: "Frightened", duration: { expiry: endStr }, start: {}, flags: { "draw-steel-combat-tools": { frightened: { sourceActorId: sourceActor.id } } } }, a);
      a.effects.set(e.id, e);
    },
    async applyTaunted() {},
  };
  game.modules.set("draw-steel-combat-tools", { active: true, api: dsctApi });
  game.settings.register("draw-steel-combat-tools", "conditionsEnabled", { default: true });
  game.settings.register("draw-steel-combat-tools", "frightenedEnabled", { default: true });
  const applied = {
    tier1: { potency: { characteristic: "none", value: "" }, effects: {} },
    tier2: { potency: { characteristic: "none", value: "" }, effects: { frightened: { condition: "always", end: "turn", properties: new Set() } } },
    tier3: { potency: { characteristic: "none", value: "" }, effects: {} },
  };
  const item = makeAbility({ uuid: "Actor.hero000000000001.Item.fear000000000001", name: "Fear", actor: hero, damage: false, applied });
  const msg = postAbility(item, { 2: [tA] }, {});
  await settle();
  assert.equal(calls.length, 1, "delegated once");
  assert.equal(calls[0].endStr, "turnEnd", "end key translated to expiry event");
  const ae = gobA.effects.find(e => e.getFlag("draw-steel-combat-tools", "frightened"));
  assert.equal(ae.start.combatant, "cmb-Goblin A", "start.combatant patched");
  const op = Object.values(getResolution(msg).ops)[0];
  assert.equal(op.delegated, "dsct-frightened");
  await api.undoOps(msg.id);
  assert.ok(!gobA.effects.has(ae.id), "undo deletes the DSCT effect");

  // grabbed without autoGrab waits for confirmation
  game.settings.register("draw-steel-combat-tools", "grabEnabled", { default: true });
  applied.tier2.effects = { grabbed: { condition: "always", end: "", properties: new Set() } };
  const msg2 = postAbility(item, { 2: [tA] }, {});
  await settle();
  const g = Object.values(getResolution(msg2).ops)[0];
  assert.equal(g.mode, "prompt");
  assert.equal(g.status, "pending");
  game.modules.delete("draw-steel-combat-tools");

  // targetedConditions "off": the targeted condition is manual with no Apply button
  applied.tier2.effects = { frightened: { condition: "always", end: "turn", properties: new Set() } };
  await game.settings.set("stef-ds-automation", "targetedConditions", "off");
  const msg3 = postAbility(item, { 2: [tA] }, {});
  await settle();
  const f = Object.values(getResolution(msg3).ops)[0];
  assert.equal(f.mode, "manual");
  assert.ok(f.noApply);
  assert.ok(!buildView(msg3, getResolution(msg3)).rows[0].ops[0].canApply);
  // M8 (D13): "auto" without Combat Tools routes to the native builder (an automatic row, not a manual one)
  await game.settings.set("stef-ds-automation", "targetedConditions", "auto");
  const msg4 = postAbility(item, { 2: [tA] }, {});
  await settle();
  const n = Object.values(getResolution(msg4).ops)[0];
  assert.equal(n.mode, "auto");
  assert.ok(!n.noApply, "native route: no manual-only row");
  assert.ok(n.native || n.status !== "pending", `native route taken (${n.status} ${n.reason ?? ""})`);
  setCombat(null);
  console.log("ok dsct delegation / grab prompt / no-dsct manual");
}

/* ---------- DSTD lock mapping ---------- */
{
  const item = makeAbility({ uuid: "Actor.hero000000000001.Item.strike0000000010", name: "Strike10", actor: hero });
  const msg = postAbility(item, { 1: [tA] }, { 1: [{ total: 3, options: {} }] });
  await settle();
  const key = tA.document.uuid.replace(/\./g, "__");
  const fakeBtn = (dataset) => ({ dataset, closest: (sel) => (sel === "[data-target-key]" ? { dataset: { targetKey: key } } : null) });
  assert.ok(blockingOp(msg, fakeBtn({ dstdAction: "applyDamage", partId: "tier1Result00000", rollIndex: "1" })), "damage row locked");
  assert.equal(blockingOp(msg, fakeBtn({ dstdAction: "applyDamage", partId: "tier1Result00000", rollIndex: "2" })), null, "other roll not locked");
  await api.undoOps(msg.id);
  assert.equal(blockingOp(msg, fakeBtn({ dstdAction: "applyDamage", partId: "tier1Result00000", rollIndex: "1" })), null, "unlocked after undo");
  console.log("ok dstd lock mapping");
}

/* ---------- 0.18.0: Combat Tools 1.2.7 advanced enricher chips are locked like Target Damage rows ---------- */
{
  const item = makeAbility({ uuid: "Actor.hero000000000001.Item.strike0000000018", name: "Strike18", actor: hero });
  const actor = tA.document.actor ?? tA.actor;
  const update = actor.update;
  const undoOptions = [];
  actor.update = function (data, options) { undoOptions.push(options ?? {}); return update.call(this, data, options); };
  const msg = postAbility(item, { 1: [tA] }, { 1: [{ total: 3, options: {} }] });
  await settle();
  const uuid = tA.document.uuid;
  // Live §27: the power roll's damage row never comes from the effect text, so a text [[/damage]] chip stays free.
  assert.equal(blockingEnricherOp(msg, "damage", [uuid]), null, "extra text damage is not our tier damage");
  // A copy of the record (the real one is signed by the ledger): as if our library had planned the damage from the text.
  const copy = structuredClone(getResolution(msg));
  const tierOp = Object.values(copy.ops).find(o => o.kind === "damage");
  tierOp.lib = true;
  copy.ops.cond = { opId: "cond", kind: "condition", effectId: "slowed", status: "applied", targetKeys: [...tierOp.targetKeys] };
  const libCard = { id: msg.id, flags: { "stef-ds-automation": { resolution: copy } } };
  assert.ok(blockingEnricherOp(libCard, "damage", [uuid]), "a damage chip our library op covers is locked");
  assert.ok(blockingEnricherOp(libCard, "damage", null), "a plain link click (all its targets) is locked");
  assert.equal(blockingEnricherOp(msg, "apply", [uuid], { status: "slowed" }), null, "no condition of ours: a condition chip stays free");
  assert.ok(blockingEnricherOp(libCard, "apply", [uuid], { status: "slowed" }), "the same status we applied is locked");
  assert.equal(blockingEnricherOp(libCard, "apply", [uuid], { status: "prone" }), null, "another status stays free");
  assert.equal(blockingEnricherOp(libCard, "damage", ["Scene.other.Token.other00000000000"]), null, "another target stays free");
  assert.equal(blockingEnricherOp(libCard, "mystery", [uuid]), null, "unknown kinds are never locked");
  // The capture guard swallows a face click; a face Combat Tools applied itself (its click undoes) goes through.
  // The guard reads the card's record: a status chip of a condition we applied.
  const statusLink = { dataset: { status: "slowed" } };
  const ec = { dataset: { advKind: "apply" }, contains: () => true, querySelector: () => statusLink, closest: sel => (sel.includes("data-message-id") ? { dataset: { messageId: msg.id } } : null) };
  const real = getResolution(msg);
  const savedFlags = msg.flags;
  msg.flags = { ...savedFlags, "stef-ds-automation": { ...savedFlags["stef-ds-automation"], resolution: { ...real, ops: { ...real.ops, cond: copy.ops.cond } } } };
  const face = (applied = false) => ({ matches: () => applied, getAttribute: () => uuid, closest: () => null });
  const click = (el) => {
    let swallowed = 0;
    onCaptureClick({ target: { closest: sel => (sel === "enriched-content.dsct-adv" ? ec : sel === "[data-ctlib-face]" ? el : null) },
      preventDefault() {}, stopImmediatePropagation() { swallowed++; } });
    return swallowed;
  };
  const savedUi = globalThis.ui;
  globalThis.ui = { ...(savedUi ?? {}), notifications: { warn() {}, info() {}, error() {} } };
  assert.equal(click(face()), 1, "face click swallowed");
  assert.equal(click(face(true)), 0, "Combat Tools' own applied face: its undo click passes");
  msg.flags = savedFlags;
  assert.equal(click(face()), 0, "without our Slowed the chip is free");
  undoOptions.length = 0;
  await api.undoOps(msg.id);
  assert.ok(undoOptions.some(o => o.dsblUndo === true && o["stef-ds-automation"]?.undo), "the undo write tells Battle Log 1.5.0 it is an undo");
  globalThis.ui = savedUi;
  actor.update = update;
  console.log("ok 0.18.0 advanced enricher lock (chips, faces, link, undo) and the dsblUndo option");
}

/* ---------- live bug 2026-10-05: Target Damage applied a row we had undone -> no double apply ---------- */
{
  setDstd(true);
  const item = makeAbility({ uuid: "Actor.hero000000000001.Item.strike0000000012", name: "Strike12", actor: hero });
  const msg = postAbility(item, { 1: [tA] }, { 1: [{ total: 3, options: {} }] });
  await settle();
  const opIdA = Object.keys(getResolution(msg).ops)[0];
  await api.undoOps(msg.id);
  const before = gobA.system.stamina.value;
  // Target Damage (row button or Combat Tools' Apply All) applies the same row itself.
  const appRec = (status) => ({ kind: "damage", status, partId: "tier1Result00000", rollIndex: 1, target: { tokenUuid: tA.document.uuid }, amount: 3 });
  await msg.update({ "flags.draw-steel-target-damage.state.applications": { "damage-tier1Result00000-1-x": appRec("applied") } });
  gobA.system.stamina.value -= 3;
  await api.applyOps(msg.id, [opIdA]);
  let op = getResolution(msg).ops[opIdA];
  assert.equal(op.status, "external", "our Apply does not double Target Damage's application");
  assert.equal(op.reason, "appliedByTargetDamage");
  assert.equal(gobA.system.stamina.value, before - 3, "stamina changed once");
  const key = tA.document.uuid.replace(/\./g, "__");
  const fakeBtn = (dataset) => ({ dataset, closest: (sel) => (sel === "[data-target-key]" ? { dataset: { targetKey: key } } : null) });
  assert.equal(blockingOp(msg, fakeBtn({ dstdAction: "applyDamage", partId: "tier1Result00000", rollIndex: "1" })), null, "external ops do not lock Target Damage's own row");
  assert.ok(buildView(msg, getResolution(msg)).rows[0].ops[0].canApply, "Apply stays available for a retry");
  // Target Damage undoes its record: our Apply works again.
  gobA.system.stamina.value += 3;
  await msg.update({ "flags.draw-steel-target-damage.state.applications": { "damage-tier1Result00000-1-x": appRec("undone") } });
  await api.applyOps(msg.id, [opIdA]);
  op = getResolution(msg).ops[opIdA];
  assert.equal(op.status, "applied", "applies once Target Damage's record is undone");
  assert.equal(gobA.system.stamina.value, before - 3);
  await api.undoOps(msg.id);

  // Review findings (0.1.1): reconcile, Apply all, stacks, tier overrides, partial squad coverage.
  const apps = (map) => msg.update({ "flags.draw-steel-target-damage.state.applications": map });
  await apps({ "damage-tier1Result00000-1-y": appRec("applied") });
  await settle();
  op = getResolution(msg).ops[opIdA];
  assert.equal(op.status, "external", "reconcile marks an undone op covered by Target Damage as external");
  await apps({ "damage-tier1Result00000-1-y": appRec("undone") });
  await settle();
  op = getResolution(msg).ops[opIdA];
  assert.equal(op.status, "pending", "reconcile sets external back to pending after Target Damage's undo");
  await apps({ "damage-tier1Result00000-1-y": appRec("applied") });
  await settle();
  await apps({ "damage-tier1Result00000-1-y": appRec("undone") });
  // Apply all (no ids) also retries external ops, even before reconcile ran.
  await api.applyOps(msg.id);
  assert.equal(getResolution(msg).ops[opIdA].status, "applied", "Apply all applies once Target Damage undid");
  await api.undoOps(msg.id);
  await apps({});
  await settle();

  const { dstdCoveredTokens } = await import(pathToFileURL(ROOT + "compat/dstd.mjs").href);
  const uA = tA.document.uuid, uB = tB.document.uuid;
  const dop = { kind: "damage", partId: "tier1Result00000", rollIndex: 1 };
  const fakeMsg = (state) => ({ flags: { "draw-steel-target-damage": { state } } });
  const rec = (uuid, extra = {}) => ({ kind: "damage", status: "applied", partId: "tier1Result00000", rollIndex: 1, target: { tokenUuid: uuid }, ...extra });
  // selected-token stack: the top level mirrors only the newest push
  let cov = dstdCoveredTokens(fakeMsg({ applications: { s: { ...rec(uB), stack: [rec(uA), rec(uB)], stackCount: 2 } } }), dop, [uA]);
  assert.ok(cov.has(uA), "older stack entries count");
  cov = dstdCoveredTokens(fakeMsg({ applications: { s: { kind: "damage", status: "undone", stack: [], stackCount: 0 } } }), dop, [uA]);
  assert.equal(cov.size, 0, "fully popped stack covers nothing");
  cov = dstdCoveredTokens(fakeMsg({ applications: { m: { status: "applied", records: [rec(uA), rec(uB)] } } }), dop, [uA, uB]);
  assert.equal(cov.size, 2, "multi-token records");
  // tier override: DSTD applied the tier-2 part for A
  const t2 = rec(uA, { partId: "tier2Result00000", rollIndex: 2 });
  assert.equal(dstdCoveredTokens(fakeMsg({ applications: { o: t2 } }), dop, [uA]).size, 0, "other part without override does not count");
  assert.ok(dstdCoveredTokens(fakeMsg({ applications: { o: t2 }, tierOverrides: { [uA.replace(/\./g, "__")]: { tier: 2 } } }), dop, [uA]).has(uA), "override: any part counts");
  const sop = { kind: "condition", partId: "tier1Result00000", effectId: "slowed" };
  assert.ok(dstdCoveredTokens(fakeMsg({ applications: { c: { kind: "status", status: "applied", partId: "tier1Result00000", effectId: "slowed", target: { tokenUuid: uA } } } }), sop, [uA]).has(uA), "status rows");

  // partial squad coverage: a two-target op with only one target covered is skipped, not external
  const msg2 = postAbility(item, { 1: [tA, tB] }, { 1: [{ total: 3, options: {} }] });
  await settle();
  await api.undoOps(msg2.id);
  const res2 = getResolution(msg2);
  const [idA2, idB2] = Object.keys(res2.ops);
  const keyB = res2.ops[idB2].targetKeys[0];
  await msg2.update({ [`flags.stef-ds-automation.resolution.ops.${idA2}.targetKeys`]: [res2.ops[idA2].targetKeys[0], keyB], [`flags.stef-ds-automation.resolution.ops.${idA2}.group`]: "squad" });
  await api.trustCard(msg2.id); // a direct record edit breaks the signature (ledger.mjs) until a GM trusts it
  const stA = gobA.system.stamina.value, stB = gobB.system.stamina.value;
  await msg2.update({ "flags.draw-steel-target-damage.state.applications": { x: rec(uA, { rollIndex: res2.ops[idA2].rollIndex }) } });
  await settle();
  await api.applyOps(msg2.id, [idA2]);
  op = getResolution(msg2).ops[idA2];
  assert.equal(op.status, "skipped", "partly covered squad op is not applied");
  assert.equal(op.reason, "partlyAppliedByTargetDamage");
  assert.equal(gobA.system.stamina.value, stA);
  assert.equal(gobB.system.stamina.value, stB);
  setDstd(false);
  console.log("ok no double apply after a Target Damage application (+ stack, override, reconcile, partial squad)");
}

/* ---------- private card -> manual ---------- */
{
  const item = makeAbility({ uuid: "Actor.hero000000000001.Item.strike0000000011", name: "Strike11", actor: hero });
  const msg = postAbility(item, { 1: [tA] }, { 1: [{ total: 3, options: {} }] }, { whisper: ["pl"], isAuthor: false });
  await settle();
  const res = getResolution(msg);
  assert.equal(gobA.system.stamina.value, 20, "nothing applied on a private player card");
  assert.ok(res.warnings.some(w => w.code === "privateCard"));
  assert.equal(Object.values(res.ops)[0].mode, "manual");
  console.log("ok private card");
}

/* ---------- dsct.choose gate ---------- */
{
  const applied = {
    tier1: { potency: { characteristic: "none", value: "" }, effects: { slowed: { condition: "always", end: "save", properties: new Set() } } },
    tier2: { potency: { characteristic: "none", value: "" }, effects: {} },
    tier3: { potency: { characteristic: "none", value: "" }, effects: {} },
  };
  const item = makeAbility({ uuid: "Actor.hero000000000001.Item.choose0000000001", name: "Choose", actor: hero, damage: false, applied, choose: true });
  const msg = postAbility(item, { 1: [tB] }, {});
  await settle();
  const res = getResolution(msg);
  assert.equal(Object.values(res.ops)[0].mode, "prompt");
  assert.ok(res.warnings.some(w => w.code === "dsctChoose"));
  assert.ok(!gobB.statuses.has("slowed"));
  console.log("ok choose gate");
}

/* ---------- preApplyOp veto ---------- */
{
  const veto = Hooks.on("dsAuto.preApplyOp", () => false);
  const item = makeAbility({ uuid: "Actor.hero000000000001.Item.strike0000000012", name: "Strike12", actor: hero });
  const msg = postAbility(item, { 1: [tA] }, { 1: [{ total: 3, options: {} }] });
  await settle();
  const op = Object.values(getResolution(msg).ops)[0];
  assert.equal(op.status, "skipped");
  assert.equal(op.reason, "hookVetoed");
  world.offHook("dsAuto.preApplyOp", veto);
  console.log("ok preApplyOp veto");
}

/* ---------- late targets from Target Damage ---------- */
{
  setDstd(true);
  const item = makeAbility({ uuid: "Actor.hero000000000001.Item.area000000000001", name: "Area", actor: hero });
  const msg = postAbility(item, {}, {}, { extraParts: { tier3Result00000: { _id: "tier3Result00000", type: "abilityResult", tier: 3, rolls: [new ds.rolls.PowerRoll(17, { tier: 3 }), new ds.rolls.DamageRoll(5, {})] } } });
  await settle();
  assert.equal(Object.keys(getResolution(msg).targets).length, 0);
  await msg.update({ "flags.draw-steel-target-damage.state.targets": [{ tokenUuid: tA.document.uuid }, { tokenUuid: tB.document.uuid }] });
  await settle();
  const res = getResolution(msg);
  assert.equal(Object.keys(res.targets).length, 2, "late targets picked up");
  assert.equal(gobA.system.stamina.value, 15);
  assert.equal(gobB.system.stamina.value, 15);
  await api.undoOps(msg.id);
  setDstd(false);
  console.log("ok late targets");
}

/* ---------- Handlebars render of the template ---------- */
{
  const require = createRequire(import.meta.url);
  const Handlebars = paths.handlebars();
  Handlebars.registerHelper("localize", (k) => k);
  const tpl = Handlebars.compile(readFileSync(paths.TEMPLATES + "parts/resolution.hbs", "utf8"));
  const item = makeAbility({ uuid: "Actor.hero000000000001.Item.strike0000000013", name: "Strike13", actor: hero });
  const msg = postAbility(item, { 1: [tA], 2: [tB] }, { 1: [{ total: 3, options: { type: "fire" } }], 2: [{ total: 6, options: {} }] });
  await settle();
  const html = tpl({ ctx: { dsAuto: buildView(msg, getResolution(msg)) } });
  assert.ok(html.includes('data-action="dsAutoUndo"'), "undo buttons rendered for the GM");
  assert.ok(html.includes("Goblin A") && html.includes("Goblin B"));
  console.log("row warnings:", JSON.stringify(getResolution(msg).warnings)); assert.equal((html.match(/class="ds-auto-row[ "]/g) ?? []).length, 2);
  assert.ok(!/data-target-key/.test(html), "no attribute collision with Target Damage rows");
  await api.undoOps(msg.id);
  console.log("ok template render");
}

console.log("\nALL HARNESS-2 TESTS PASSED");
