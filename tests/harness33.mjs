/**
 * 1.2.2: the suite has priority over Combat Tools.
 *  - Hesitation is Weakness no longer steps aside while Combat Tools' hiwEnabled is on (`suiteRunsHiw`, turn-order.mjs).
 *  - ui/ct-duplicates.mjs hides Combat Tools' HIW card, Judgement and Mark buttons (only with the suite's guard / overlay)
 *    and swallows clicks on them.
 *  - compat/dsct-overlap.mjs lists the Combat Tools switches that duplicate the suite, the dismissal signature and the dialog.
 * Fake DOM like harness31's.
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const paths = createRequire(import.meta.url)("./paths.cjs");
const imp = p => import(pathToFileURL(paths.SCRIPTS + p).href);
globalThis.__HARNESS_SKIP_SCENARIOS__ = true;
await import("./harness.mjs");
const turnOrder = await imp("triggers/turn-order.mjs");
const dup = await imp("ui/ct-duplicates.mjs");
const overlap = await imp("compat/dsct-overlap.mjs");
const { sign } = await imp("engine/ledger.mjs");
const settingsMod = await imp("settings.mjs");
const registry = await imp("library/registry.mjs");
const { compat } = await imp("compat/version-gate.mjs");
const overlays = (await import(pathToFileURL(paths.CORE + "/dist/overlays.mjs").href)).default;

const MOD = "stef-ds-automation";
const CT = "draw-steel-combat-tools";
const HID = "ds-auto-hidden-native";
const ctSwitches = { abilityAutomationEnabled: true, hiwEnabled: false, judgementAutomation: false, markAutomation: false, autoApplyOwnAbilities: false };
for (const [k, v] of Object.entries(ctSwitches)) game.settings.register(CT, k, { default: v });
const ct = (key, value) => game.settings.set(CT, key, value);
const mine = (key, value) => game.settings.set(MOD, key, value);
const setCt = on => { if (on) game.modules.set(CT, { active: true, version: "2.2.4" }); else game.modules.delete(CT); };
const resetCt = () => { for (const [k, v] of Object.entries(ctSwitches)) ct(k, v); };

class El {
  constructor(tag, { cls = "", data = {} } = {}) {
    this.nodeType = 1; this.tag = tag; this.kids = []; this.parent = null;
    this.classes = new Set(cls.split(/\s+/).filter(Boolean));
    this.classList = { add: c => this.classes.add(c), remove: c => this.classes.delete(c), contains: c => this.classes.has(c) };
    this.dataset = { ...data };
  }
  append(...els) { for (const e of els) { e.parent = this; this.kids.push(e); } return this; }
  matches(sel) {
    if (sel.includes(",")) return sel.split(",").some(x => this.matches(x.trim()));
    const m = sel.match(/^([a-z-]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/);
    if (!m) return false;
    if (m[1] && m[1] !== this.tag) return false;
    if (![...m[2].matchAll(/\.([\w-]+)/g)].every(([, c]) => this.classes.has(c))) return false;
    return [...m[3].matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].every(([, attr, v]) => {
      const key = attr.replace(/^data-/, "").replace(/-(\w)/g, (_a, c) => c.toUpperCase());
      return v === undefined ? key in this.dataset : this.dataset[key] === v;
    });
  }
  closest(sel) { for (let e = this; e; e = e.parent) if (e.matches?.(sel)) return e; return null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = el => { for (const k of el.kids ?? []) { if (k.matches(sel)) out.push(k); walk(k); } };
    walk(this);
    return out;
  }
}
/** A card li with a Combat Tools button of each kind. */
function card({ hiw = false, rows = true, resolved = true, dsid = null } = {}) {
  const li = new El("li", { cls: "chat-message", data: { messageId: "msg0000000000001" } });
  const buttons = {
    judgement: new El("button", { cls: "dsct-judgement-btn" }).append(new El("i", { cls: "fa-solid fa-skull-crossbones" })),
    bane: new El("button", { cls: "dsct-judgement-btn" }).append(new El("i", { cls: "fa-solid fa-dice-d20" })),
    mark: new El("button", { cls: "dsct-mark-btn" }),
    reminder: new El("button", { cls: "dsct-mark-reminder-btn" }),
    other: new El("button", { cls: "something-else" }),
  };
  li.append(...Object.values(buttons));
  // The Automation box's record: the suite's judged and marked rows (the Apply buttons are hidden only with them).
  const res = { shape: "targetResult", createdAt: Date.now(), ops: {} };
  if (resolved) res.resolvedAt = Date.now();
  if (dsid) res.abilityDsid = dsid;
  if (rows) {
    res.ops.j = { opId: "j", kind: "condition", effectId: "MHQDlicbxXquwduc", status: "applied", targetKeys: ["t"] };
    res.ops.m = { opId: "m", kind: "condition", effectId: "YW2JEdoDPd0XlaII", status: "applied", targetKeys: ["t"] };
  }
  const message = { id: "msg0000000000001", timestamp: Date.now(), flags: { [MOD]: { resolution: res } }, system: { parts: new Map() },
    getFlag: (ns, key) => (hiw && ns === CT && key === "isHiwMessage" ? true : undefined) };
  sign(message);
  game.messages.set(message.id, message);
  return { li, buttons, message };
}
const click = target => {
  const ev = { target, isTrusted: false, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  return { swallowed: dup.onCaptureClick(ev), ev };
};

/* ---- no overlays yet: nothing to hide, HIW not run by the suite ---- */
{
  assert.equal(turnOrder.suiteRunsHiw(), false, "no turn.end overlay: suiteRunsHiw false");
  const c = card({ hiw: true });
  assert.equal(dup.hideCtDuplicates(c.message, c.li), 0);
  assert.ok(!c.li.classes.has(HID) && !c.buttons.judgement.classes.has(HID) && !c.buttons.mark.classes.has(HID));
  assert.equal(click(c.buttons.judgement).swallowed, false, "visible button: click goes through");
  console.log("ok nothing hidden without the suite's automation");
}

/* ---- the shipped library registered ---- */
const reg = registry.registerSource({ id: "h33", priority: 10, overlays });
assert.ok(reg.accepted > 100, `library registered (${reg.accepted})`);
assert.ok(registry.hasOverlay("ability:judgement") && registry.hasOverlay("ability:mark"), "judgement and mark overlays exist");

/* ---- suiteRunsHiw + HIW no longer steps aside ---- */
{
  setCt(true);
  compat.dsctAbilityAutomation = true;   // the reload-setting snapshot detectCompat takes at ready
  ct("hiwEnabled", true);
  assert.equal(turnOrder.dsctHandlesHiw(), true, "reporting: Combat Tools' HIW is on");
  assert.equal(turnOrder.suiteRunsHiw(), true, "Combat Tools' hiwEnabled does not make the suite step aside");
  ct("hiwEnabled", false);
  assert.equal(turnOrder.suiteRunsHiw(), true, "also with it off");
  game.combats.isDefaultInitiativeMode = false;
  assert.equal(turnOrder.suiteRunsHiw(), false, "not the default initiative mode");
  game.combats.isDefaultInitiativeMode = true;
  await mine("triggersEnabled", false);
  assert.equal(turnOrder.suiteRunsHiw(), false, "triggers engine off");
  await mine("triggersEnabled", true);
  assert.equal(turnOrder.suiteRunsHiw(), true);
  console.log("ok suiteRunsHiw: engine, turn.end overlay, default initiative; Combat Tools hiwEnabled ignored");
}

/* ---- hiding ---- */
{
  const c = card({ hiw: true });
  assert.equal(dup.hideCtDuplicates(c.message, c.li), 4, "HIW li + judgement + mark + reminder");
  assert.ok(c.li.classes.has(HID), "HIW message hidden");
  assert.ok(c.buttons.judgement.classes.has(HID) && c.buttons.mark.classes.has(HID) && c.buttons.reminder.classes.has(HID));
  assert.ok(!c.buttons.bane.classes.has(HID), "Combat Tools' bane button stays (its Judgement extras are the fallback)");
  assert.ok(!c.buttons.other.classes.has(HID), "other buttons untouched");
  // A card without the suite's rows (an NPC censor the library leaves alone): Combat Tools' Apply buttons stay.
  const bare = card({ rows: false });
  assert.equal(dup.hideCtDuplicates(bare.message, bare.li), 0, "no suite row on this card: Combat Tools' buttons stay");
  assert.equal(dup.cardHasSuiteRow(c.message, "judgement"), true);
  assert.equal(dup.cardHasSuiteRow(bare.message, "mark"), false);
  // While the card is still resolving (an open prompt of it), the suite's row is coming: the Apply button is hidden.
  const pending = card({ rows: false, resolved: false, dsid: "judgement" });
  assert.equal(dup.cardHasSuiteRow(pending.message, "judgement"), true, "resolving Judgement card: hidden");
  assert.equal(dup.cardHasSuiteRow(pending.message, "mark"), false, "another ability: not");
  for (const target of [c.buttons.judgement, c.buttons.mark, c.buttons.reminder, c.li]) {
    const { swallowed, ev } = click(target);
    assert.ok(swallowed && ev.prevented && ev.stopped, "click swallowed (synthetic, silent)");
  }
  // A click inside the hidden HIW card (its Start Turn button).
  const start = new El("button");
  c.li.append(start);
  assert.ok(click(start).swallowed, "Start Turn button inside the hidden HIW card swallowed");

  const plain = card();
  dup.hideCtDuplicates(plain.message, plain.li);
  assert.ok(!plain.li.classes.has(HID), "a card that is not Combat Tools' HIW message stays visible");
  assert.equal(click(plain.buttons.other).swallowed, false, "other click goes through");

  // The HIW card comes back when the suite no longer runs it.
  game.combats.isDefaultInitiativeMode = false;
  dup.hideCtDuplicates(c.message, c.li);
  assert.ok(!c.li.classes.has(HID), "HIW card shown again when suiteRunsHiw is false");
  game.combats.isDefaultInitiativeMode = true;
  console.log("ok HIW card, judgement and mark buttons hidden, clicks swallowed");
}

/* ---- buttons stay without the overlay / with the library off ---- */
{
  registry.unregisterSource("h33");
  const c = card({ hiw: true });
  assert.equal(dup.hideCtDuplicates(c.message, c.li), 0, "overlays gone: nothing hidden");
  assert.equal(click(c.buttons.mark).swallowed, false);
  registry.registerSource({ id: "h33", priority: 10, overlays });
  await mine("libraryEnabled", false);
  const d = card();
  assert.equal(dup.hideCtDuplicates(d.message, d.li), 0, "library off: buttons stay");
  await mine("libraryEnabled", true);
  assert.equal(dup.hideCtDuplicates(d.message, d.li), 3, "library on again: hidden");
  // Only the Judgement overlay: the mark buttons stay.
  const only = overlays.filter(o => o.key !== "ability:mark");
  registry.registerSource({ id: "h33", priority: 10, overlays: only });
  const e = card();
  assert.equal(dup.hideCtDuplicates(e.message, e.li), 1, "no mark overlay: only the judgement button hidden");
  assert.ok(e.buttons.judgement.classes.has(HID) && !e.buttons.mark.classes.has(HID) && !e.buttons.reminder.classes.has(HID));
  assert.ok(!e.buttons.bane.classes.has(HID));
  assert.equal(click(e.buttons.bane).swallowed, false, "visible bane button: click goes through");
  registry.registerSource({ id: "h33", priority: 10, overlays });
  console.log("ok hidden only with the overlay and the library on");
}

/* ---- overlapSwitches ---- */
{
  resetCt();
  setCt(true);
  assert.deepEqual(overlap.overlapSwitches(), [], "all off: empty");
  ct("hiwEnabled", true);
  ct("judgementAutomation", true);
  ct("markAutomation", true);
  ct("autoApplyOwnAbilities", true);
  const list = overlap.overlapSwitches();
  assert.deepEqual(list.map(s => s.key), ["hiwEnabled", "judgementAutomation", "markAutomation", "autoApplyOwnAbilities"]);
  assert.deepEqual(list.map(s => s.scope), ["world", "world", "world", "client"]);
  assert.ok(list.every(s => s.namespace === CT && s.labelKey && s.suiteDoes), "entry shape");
  ct("abilityAutomationEnabled", false);
  assert.ok(!overlap.overlapSwitches().some(s => s.key === "hiwEnabled"), "hiwEnabled only counts while abilityAutomationEnabled is on");
  ct("abilityAutomationEnabled", true);
  ct("markAutomation", false);
  assert.deepEqual(overlap.overlapSwitches().map(s => s.key), ["hiwEnabled", "judgementAutomation", "autoApplyOwnAbilities"]);
  setCt(false);
  assert.deepEqual(overlap.overlapSwitches(), [], "without Combat Tools: empty");
  console.log("ok overlapSwitches");
}

/* ---- dismissal signature ---- */
{
  const a = [{ namespace: CT, key: "markAutomation" }, { namespace: CT, key: "hiwEnabled" }];
  const b = [a[1], a[0]];
  assert.equal(overlap.overlapSignature("2.2.4", a), overlap.overlapSignature("2.2.4", b), "order does not matter");
  assert.notEqual(overlap.overlapSignature("2.2.4", a), overlap.overlapSignature("2.2.5", a), "Combat Tools version changes it");
  assert.notEqual(overlap.overlapSignature("2.2.4", a), overlap.overlapSignature("2.2.4", [a[0]]), "switch list changes it");
  const sig = overlap.overlapSignature("2.2.4", a);
  assert.equal(overlap.overlapDue(a, "", "2.2.4"), true, "never dismissed: due");
  assert.equal(overlap.overlapDue(a, sig, "2.2.4"), false, "dismissed with this signature: not due");
  assert.equal(overlap.overlapDue(a, sig, "2.2.5"), true, "new version: due again");
  assert.equal(overlap.overlapDue([...a, { namespace: CT, key: "judgementAutomation" }], sig, "2.2.4"), true, "new switch: due again");
  assert.equal(overlap.overlapDue([], "", "2.2.4"), false, "nothing overlapping: never due");
  console.log("ok dismissal signature");
}

/* ---- dialog: turn off / not now / ready check ---- */
{
  resetCt();
  setCt(true);
  ct("hiwEnabled", true);
  ct("judgementAutomation", true);
  ct("autoApplyOwnAbilities", true);
  let answer = "off";
  let shown = 0;
  let content = "";
  globalThis.foundry ??= {};
  foundry.applications = { api: { DialogV2: { wait: async opts => { shown++; content = opts.content; return answer; } } } };
  await mine("ctOverlapDismissed", "");
  const before = overlap.overlapSwitches();
  assert.equal(await overlap.showOverlapDialog(), "off");
  assert.ok(content.includes("DSAUTO.Overlap.clientNote"), "the client note is shown when a client key is listed");
  assert.deepEqual(overlap.overlapSwitches(), [], "turn off: the listed keys are off");
  assert.equal(before.length, 3);

  resetCt();
  ct("markAutomation", true);
  answer = "later";
  shown = 0;
  assert.equal((await overlap.checkOverlapAtReady()), "later");
  assert.equal(game.settings.get(MOD, "ctOverlapDismissed"), overlap.overlapSignature("2.2.4", overlap.overlapSwitches()), "Not now stores the signature");
  assert.ok(!content.includes("DSAUTO.Overlap.clientNote"), "no client note without a client key");
  assert.equal(await overlap.checkOverlapAtReady(), null, "same list: not shown again");
  assert.equal(shown, 1);
  ct("judgementAutomation", true);
  assert.equal(await overlap.checkOverlapAtReady(), "later", "a new switch: shown again");
  assert.equal(shown, 2);
  // Only the active GM is asked.
  Object.defineProperty(game.users, "activeGM", { get: () => ({ isSelf: false }), configurable: true });
  await mine("ctOverlapDismissed", "");
  assert.equal(await overlap.checkOverlapAtReady(), null, "not the active GM: no dialog");
  setCt(false);
  console.log("ok dialog: turn off, Not now, shown again on a new signature, active GM only");
}

console.log("harness33 passed");
