/** 0.13.0: compact card, the Details fold of Target Damage's panel, the folded Combat Tools teleport message. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const paths = createRequire(import.meta.url)("./paths.cjs");
const imp = p => import(pathToFileURL(paths.SCRIPTS + p).href);
globalThis.__HARNESS_SKIP_SCENARIOS__ = true;
const { makeAbility, postAbility, settle, hero, tA, tB, api, getResolution, buildView, setDstd, messages } = await import("./harness.mjs");
const { shouldFoldPanel, applyFold, toggleFold, badgeCount, FOLD_CLASS } = await imp("ui/dstd-fold.mjs");
const { expectTeleportMessage, matchTeleportExpectation, dsctTeleport, runTeleport } = await imp("delegation/teleport.mjs");
const { foldPatch, applyTeleportFold, FOLDED_TELEPORT_FLAG } = await imp("ui/teleport-message-fold.mjs");
const MOD = "stef-ds-automation";
const DSCT = "draw-steel-combat-tools";

/* ---------- a tiny DOM: elements answer the selectors the fold code asks for ---------- */
class FakeEl {
  constructor(tag, { cls = [], attrs = {}, children = {} } = {}) {
    this.tag = tag; this.classes = new Set(cls); this.attrs = { ...attrs }; this.dataset = {}; this.children = children; this.textContent = "";
    this.disabled = false; this.isConnected = true; this.ownerDocument = globalThis.document;
    this.classList = {
      add: (...c) => c.forEach(x => this.classes.add(x)), remove: (...c) => c.forEach(x => this.classes.delete(x)),
      contains: c => this.classes.has(c),
      toggle: (c, force) => { const on = force ?? !this.classes.has(c); if (on) this.classes.add(c); else this.classes.delete(c); return on; },
    };
    this.prepended = [];
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  querySelector(sel) { const v = this.children[sel]; return Array.isArray(v) ? v[0] ?? null : v ?? null; }
  querySelectorAll(sel) { const v = this.children[sel]; return Array.isArray(v) ? v : v ? [v] : []; }
  matches(sel) { return (this.attrs.matches ?? []).includes?.(sel) ?? false; }
  prepend(el) { this.prepended.push(el); this.children[`.${el.className}`] = el; }
  append() {}
  addEventListener(type, fn) { this.listener = fn; }
  remove() { this.removed = true; }
}

/* ---------- shouldFoldPanel ---------- */
assert.equal(shouldFoldPanel({ resolvedAt: 1 }, { dstd: true, state: {} }), true);
assert.equal(shouldFoldPanel({ resolvedAt: 1, synthetic: true }, { dstd: true, state: {} }), true, "synthetic cards fold too");
assert.equal(shouldFoldPanel({ resolvedAt: 0 }, { dstd: true, state: {} }), false, "unresolved cards keep the panel");
assert.equal(shouldFoldPanel({ resolvedAt: 1 }, { dstd: false, state: {} }), false, "no Target Damage");
assert.equal(shouldFoldPanel({ resolvedAt: 1 }, { dstd: true, state: null }), false, "no Target Damage state on the card");
assert.equal(shouldFoldPanel(null, { dstd: true, state: {} }), false, "no record");
console.log("ok shouldFoldPanel");

/* ---------- teleport expectations ---------- */
{
  const map = new Map();
  const t0 = 1_000_000;
  const clearA = expectTeleportMessage({ tokenId: "tokA", sceneId: "s1", cardId: "card1", opId: "op1" }, t0, map);
  assert.equal(matchTeleportExpectation({ isTpUndo: true, targetTokenId: "tokB", targetSceneId: "s1" }, map, t0 + 10), null, "another token");
  assert.equal(matchTeleportExpectation({ targetTokenId: "tokA", targetSceneId: "s1" }, map, t0 + 10), null, "not a teleport message");
  assert.equal(matchTeleportExpectation({ isTpUndo: true, targetTokenId: "tokA", targetSceneId: "s2" }, map, t0 + 10), null, "another scene");
  assert.equal(matchTeleportExpectation({ isTpUndo: true, targetTokenId: "tokA", targetSceneId: "s1" }, map, t0 + 400_000), null, "expired");
  assert.deepEqual(matchTeleportExpectation({ isTpUndo: true, targetTokenId: "tokA", targetSceneId: "s1" }, map, t0 + 10), { card: "card1", opId: "op1" });
  assert.equal(matchTeleportExpectation({ isTpUndo: true, targetTokenId: "tokA", targetSceneId: "s1" }, map, t0 + 11), null, "consumed once");
  clearA();
  const clearOld = expectTeleportMessage({ tokenId: "tokC", cardId: "old" }, t0, map);
  expectTeleportMessage({ tokenId: "tokC", cardId: "new" }, t0 + 1, map);
  clearOld();
  assert.equal(map.get("tokC")?.cardId, "new", "clear() removes only its own expectation");
  assert.deepEqual(matchTeleportExpectation({ isTpUndo: true, targetTokenId: "tokC" }, map, t0 + 2), { card: "new", opId: null }, "scene unknown on one side still matches");
  console.log("ok teleport expectations");
}

/* ---------- the Combat Tools message created inside our awaited teleport is tagged ---------- */
{
  const tagged = [];
  const fakeMessage = (tokenId, sceneId) => ({
    flags: { [DSCT]: { isTpUndo: true, targetTokenId: tokenId, targetSceneId: sceneId } },
    updateSource(patch) { tagged.push(patch); },
  });
  // Combat Tools creates its message inside api.teleport, on the calling client: preCreateChatMessage runs there.
  const fakeApi = {
    async teleport(opts) {
      const msg = fakeMessage(opts.sourceId, "scene1");
      Hooks.call("preCreateChatMessage", msg, {}, {}, game.userId);
    },
  };
  const tokenDoc = { id: "tok0000000000001", parent: { id: "scene1" } };
  await dsctTeleport(fakeApi, { tokenDoc, distance: 5, cardId: "cardX", opId: "opX" });
  assert.equal(tagged.length, 1, "the hook tagged our teleport's message");
  assert.deepEqual(tagged[0], { [`flags.${MOD}.${FOLDED_TELEPORT_FLAG}`]: { card: "cardX", opId: "opX" } });
  // After the call the expectation is gone: a later Combat Tools teleport of the same token is not tagged.
  Hooks.call("preCreateChatMessage", fakeMessage(tokenDoc.id, "scene1"), {}, {}, game.userId);
  assert.equal(tagged.length, 1, "teleports started outside our card stay as they are");
  // A message created by another user's client is never patched here.
  assert.equal(foldPatch(fakeMessage(tokenDoc.id, "scene1"), "someoneElse"), null);
  // A cancelled picker posts nothing; the expectation is cleared by the finally.
  await dsctTeleport({ async teleport() {} }, { tokenDoc, distance: 5, cardId: "cardY", opId: "opY" });
  Hooks.call("preCreateChatMessage", fakeMessage(tokenDoc.id, "scene1"), {}, {}, game.userId);
  assert.equal(tagged.length, 1, "cancelled picker leaves no expectation behind");
  // A throwing API still clears it.
  await assert.rejects(dsctTeleport({ async teleport() { throw new Error("boom"); } }, { tokenDoc, distance: 5, cardId: "z", opId: "z" }));
  Hooks.call("preCreateChatMessage", fakeMessage(tokenDoc.id, "scene1"), {}, {}, game.userId);
  assert.equal(tagged.length, 1);

  // runTeleport (the engine path) passes the card and op through, swap mode included (Combat Tools names our source).
  const prevCanvas = globalThis.canvas;
  globalThis.canvas = { ...(prevCanvas ?? {}), scene: { id: "scene1" } };
  const mover = { id: "tokMover00000001", uuid: "Scene.scene1.Token.tokMover00000001", parent: { id: "scene1" }, object: {}, actor: {}, x: 0, y: 0, elevation: 0 };
  const partner = { id: "tokPartner000001", uuid: "Scene.scene1.Token.tokPartner000001", parent: { id: "scene1" }, object: {}, actor: {}, x: 100, y: 0, elevation: 0 };
  const prevDsct = game.modules.get(DSCT);
  game.modules.set(DSCT, { active: true, api: { async teleport(opts) {
    Hooks.call("preCreateChatMessage", fakeMessage(opts.sourceId, "scene1"), {}, {}, game.userId);
    if (opts.mode === "swap") { mover.x = 100; partner.x = 0; } else mover.x = 300;
  } } });
  const patch = await runTeleport({ tokenDoc: mover, distance: 5, cardId: "cardR", opId: "opR" });
  assert.equal(patch.delegated, "dsct");
  assert.deepEqual(tagged.at(-1), { [`flags.${MOD}.${FOLDED_TELEPORT_FLAG}`]: { card: "cardR", opId: "opR" } });
  const swap = await runTeleport({ tokenDoc: mover, partnerDoc: partner, mode: "swap", distance: 5, cardId: "cardS", opId: "opS" });
  assert.equal(swap.moves.length, 2);
  assert.deepEqual(tagged.at(-1), { [`flags.${MOD}.${FOLDED_TELEPORT_FLAG}`]: { card: "cardS", opId: "opS" } });
  if (prevDsct) game.modules.set(DSCT, prevDsct); else game.modules.delete(DSCT);
  globalThis.canvas = prevCanvas;
  console.log("ok Combat Tools teleport message tagged only for our teleports");
}

/* ---------- rendering of a folded teleport message ---------- */
{
  const li = new FakeEl("li", { cls: ["chat-message"] });
  const prevDoc = globalThis.document;
  globalThis.document = { ...prevDoc, createElement: tag => new FakeEl(tag) };
  li.ownerDocument = globalThis.document;
  const message = { id: "tpmsg", flags: { [MOD]: { [FOLDED_TELEPORT_FLAG]: { card: "c", opId: "o" } } } };
  assert.equal(applyTeleportFold(message, li), true);
  assert.ok(li.classes.has("ds-auto-folded-teleport"));
  assert.equal(li.prepended.length, 1, "one expand toggle");
  applyTeleportFold(message, li);
  assert.equal(li.prepended.length, 1, "idempotent");
  li.prepended[0].listener({ preventDefault() {}, stopPropagation() {} });
  assert.ok(li.classes.has("ds-auto-folded-teleport--open"), "the toggle opens it");
  await game.settings.set(MOD, "foldDetails", false);
  assert.equal(applyTeleportFold(message, li), false);
  assert.ok(!li.classes.has("ds-auto-folded-teleport"), "setting off: as Combat Tools posted it");
  await game.settings.set(MOD, "foldDetails", true);
  assert.equal(applyTeleportFold({ id: "other", flags: {} }, new FakeEl("li")), false, "untagged messages untouched");
  globalThis.document = prevDoc;
  console.log("ok folded teleport message rendering");
}

/* ---------- Details fold on a resolved card ---------- */
{
  setDstd(true);
  const item = makeAbility({ uuid: "Actor.hero000000000001.Item.strike0000000150", name: "Strike150", actor: hero });
  const msg = postAbility(item, { 1: [tA], 2: [tB] }, { 1: [{ total: 3, options: {} }], 2: [{ total: 6, options: {} }] });
  await settle();
  const res = getResolution(msg);
  assert.ok(res?.resolvedAt, "resolved");
  // No Target Damage state on the card: nothing to fold, no Details button.
  assert.equal(buildView(msg, res).details, false);
  msg.flags["draw-steel-target-damage"] = { state: { targets: [] } };
  const view = buildView(msg, res);
  assert.equal(view.details, true, "Details offered");
  assert.equal(view.footer, true);
  assert.equal(view.compact, true, "compact by default");
  assert.equal(view.showHeader, false, "no Automation header line in compact mode");

  const live = new FakeEl("button", { attrs: {} });
  const locked = new FakeEl("button"); locked.classes.add("ds-auto-locked");
  const disabled = new FakeEl("button"); disabled.disabled = true;
  const update = new FakeEl("button");
  update.matches = sel => sel.includes('[data-dstd-action="updateTargets"]');   // panel chrome, not a result
  // Target Damage's quick button (row head) and full button (row body) share an operation id: one result.
  const quick = new FakeEl("button"); quick.dataset.operationId = "damage-1";
  const full = new FakeEl("button"); full.dataset.operationId = "damage-1";
  const dtButton = new FakeEl("button");   // Death Tracker, not a result
  dtButton.matches = sel => sel.includes(".dsct-dt-settle");
  const pill = new FakeEl("button"); pill.closest = sel => (sel.includes(".dsct-roll-pills-row") ? {} : null);   // an edge/bane editor
  const panel = new FakeEl("section");
  panel.querySelectorAll = () => [live, locked, disabled, update, live, quick, full, dtButton, pill];
  assert.equal(badgeCount(panel), 2, "live results only: the plain button and one damage operation");
  const badge = new FakeEl("span");
  const toggle = new FakeEl("button", { children: { ".ds-auto-details-badge": badge } });
  const li = new FakeEl("li", { cls: ["chat-message"], children: {
    "section.draw-steel-target-damage-panel": panel, ".ds-auto-resolution": new FakeEl("div"), '[data-action="dsAutoDetails"]': toggle,
  } });
  assert.equal(applyFold(msg, li), true);
  assert.ok(li.classes.has(FOLD_CLASS), "panel folded");
  assert.equal(toggle.attrs["aria-expanded"], "false");
  assert.equal(badge.textContent, "2");
  assert.equal(applyFold(msg, li), true, "idempotent");

  const prevDoc = globalThis.document;
  globalThis.document = { ...prevDoc, querySelectorAll: sel => (sel.includes(msg.id) ? [li] : []) };
  toggleFold(msg.id);
  assert.ok(!li.classes.has(FOLD_CLASS), "Details opens the panel");
  assert.equal(toggle.attrs["aria-expanded"], "true");
  applyFold(msg, li);
  assert.ok(!li.classes.has(FOLD_CLASS), "stays open after a re-render (session memory)");
  toggleFold(msg.id);
  assert.ok(li.classes.has(FOLD_CLASS), "closes again");
  globalThis.document = prevDoc;

  // A card without our section for this viewer (or a non-automated card) keeps its panel.
  const bare = new FakeEl("li", { cls: ["chat-message"], children: { "section.draw-steel-target-damage-panel": panel } });
  assert.equal(applyFold(msg, bare), false);
  // Setting off: nothing folds, no Details button.
  await game.settings.set(MOD, "foldDetails", false);
  assert.equal(applyFold(msg, li), false);
  assert.equal(buildView(msg, res).details, false);
  await game.settings.set(MOD, "foldDetails", true);

  /* ---------- template: compact and classic ---------- */
  // The harness formats keys as "key {json}": far longer than the real "6 damage". Short labels here, as live.
  const format = game.i18n.format;
  // 0.14.2: the chip counts in the one-line check, so it is short too ("T2").
  game.i18n.format = (k, d) => (k === "DSAUTO.Card.Damage" ? `${d.amount} damage` : k === "DSAUTO.Card.TierShort" ? `T${d.tier}` : format(k, d));
  const Handlebars = paths.handlebars();
  Handlebars.registerHelper("localize", k => k);
  const tpl = Handlebars.compile(readFileSync(paths.TEMPLATES + "parts/resolution.hbs", "utf8"));
  const compact = tpl({ ctx: { dsAuto: buildView(msg, res) } });
  assert.ok(compact.includes('class="ds-auto-resolution ds-auto-compact"'));
  assert.equal((compact.match(/class="ds-auto-row[ "]/g) ?? []).length, 2, "one row per target");
  assert.equal((compact.match(/ds-auto-row--one/g) ?? []).length, 2, "single-op rows are one line");
  assert.ok(compact.includes('data-action="dsAutoDetails"'), "Details toggle");
  assert.ok(/data-tooltip="DSAUTO\.Card\.Tier \{[^"]*">T\d</.test(compact), "short tier chip");
  assert.ok(!compact.includes("ds-auto-tier--none"), "targets with a tier get a real chip");
  assert.ok(view.rows.every(r => r.noTier === false), "both targets rolled a tier");
  // A target without a tier on a power-roll card: the dash chip, styled as text; never on a card without a power roll.
  const noTierView = buildView(msg, { ...res, targets: { ...res.targets, late: { name: "Late", img: null, tokenUuid: "x" } } });
  assert.equal(noTierView.rows.find(r => r.name === "Late")?.noTier, true);
  assert.ok(tpl({ ctx: { dsAuto: noTierView } }).includes('class="ds-auto-tier ds-auto-tier--none"'));
  const noRollView = buildView(msg, { ...res, noPowerRoll: true, targets: { late: { name: "Late", img: null, tokenUuid: "x" } } });
  assert.equal(noRollView.rows[0].noTier, false);
  assert.equal(noRollView.rows[0].tierShort, "", "no chip at all without a power roll");
  // 0.13.2: a target whose name + label would not fit one line takes the two-line layout.
  const longName = buildView(msg, { ...res, targets: Object.fromEntries(Object.entries(res.targets).map(([k, t]) => [k, { ...t, name: "Goblin Sniper with a very long name" }])) });
  assert.ok(longName.rows.every(r => r.ops.length === 1 && r.single === false), "long names: two-line rows");
  assert.ok(buildView(msg, res).rows.every(r => r.single === true), "short name + label: one-line rows");
  // 0.14.2: a wide chip ("Resource gain") counts: a short name + label still takes the two-line layout.
  const gainView = buildView(msg, { ...res, targets: Object.fromEntries(Object.entries(res.targets).map(([k, t]) => [k, { ...t, gainOnly: true }])) });
  assert.ok(gainView.rows.every(r => r.gainOnly && r.ops.length === 1 && r.single === false), "gain-only chip: two-line rows");
  game.i18n.format = format;
  assert.ok(!compact.includes("ds-auto-header"), "no header line");
  assert.ok(compact.includes('data-action="dsAutoUndo"'));
  assert.ok(!/data-target-key/.test(compact), "no attribute collision with Target Damage rows");
  await game.settings.set(MOD, "compactCard", false);
  const classic = tpl({ ctx: { dsAuto: buildView(msg, res) } });
  assert.ok(classic.includes('class="ds-auto-resolution"'), "classic root");
  assert.ok(classic.includes("ds-auto-header"), "classic header");
  assert.ok(classic.includes(">DSAUTO.Card.Tier {") && !classic.includes("DSAUTO.Card.TierShort"), "classic tier label");
  assert.ok(!classic.includes("ds-auto-status-text"));
  await game.settings.set(MOD, "compactCard", true);
  delete msg.flags["draw-steel-target-damage"];
  await api.undoOps(msg.id);
  setDstd(false);
  console.log("ok Details fold and compact template");
}

/* ---------- a pending row shows its short status; squads keep members as a tooltip ---------- */
{
  await game.settings.set(MOD, "damageMode", "prompt");
  const item = makeAbility({ uuid: "Actor.hero000000000001.Item.strike0000000151", name: "Strike151", actor: hero });
  const msg = postAbility(item, { 2: [tA] }, { 2: [{ total: 4, options: {} }] });
  await settle();
  const view = buildView(msg, getResolution(msg));
  const op = view.rows[0].ops[0];
  assert.equal(op.status, "pending");
  assert.equal(op.statusLabel, "DSAUTO.Status.pending.prompt");
  assert.equal(op.statusShort, "DSAUTO.Status.short.prompt", "pending rows say what they wait for, in one word");
  // One line only when name + label are short (the harness label is the raw key, far longer than live "4 damage").
  assert.equal(view.rows[0].single, (view.rows[0].name.length + op.label.length + view.rows[0].tierShort.length) <= 20);
  await game.settings.set(MOD, "damageMode", "auto");
  void messages;
  console.log("ok compact pending row");
}

console.log("\nALL HARNESS-15 TESTS PASSED");
