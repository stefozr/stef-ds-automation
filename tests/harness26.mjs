/**
 * 2.2.1.1: Combat Tools' own "Apply All / Undo All" row and per-target buttons on cards the Automation box handles
 * (scripts/ui/family-apply-guard.mjs): card handled or not, the decoration of a fake DOM (card footer row, squad split,
 * per-target buttons) and the capture guard's decision for each Combat Tools button kind.
 * Plain-object messages (record + a `system.parts` map), signed through the ledger where a trusted record is needed.
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const paths = createRequire(import.meta.url)("./paths.cjs");
const imp = p => import(pathToFileURL(paths.SCRIPTS + p).href);
globalThis.__HARNESS_SKIP_SCENARIOS__ = true;
await import("./harness.mjs");
const guard = await imp("ui/family-apply-guard.mjs");
const { sign } = await imp("engine/ledger.mjs");

const MOD = "stef-ds-automation";
const P = "partA0000000000";
const Q = "partB0000000000";
const set = (k, v) => game.settings.set(MOD, k, v);
const warns = [];
globalThis.ui.notifications.warn = m => warns.push(m);

/* ---------- a tiny DOM: tag, classes, data-*, parent, compound selectors with commas ---------- */
class El {
  constructor(tag, { cls = "", data = {} } = {}) {
    this.tag = tag; this.kids = []; this.parent = null; this.disabled = false;
    this.classes = new Set(cls.split(/\s+/).filter(Boolean));
    this.classList = { add: c => this.classes.add(c), contains: c => this.classes.has(c) };
    this.dataset = { ...data };
  }
  get className() { return [...this.classes].join(" "); }
  append(...els) { for (const e of els) { e.parent = this; this.kids.push(e); } return this; }
  matches(sel) {
    return sel.split(",").map(s => s.trim()).some(s => {
      const m = s.match(/^([a-z]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/);
      if (!m) throw new Error(`unsupported selector ${s}`);
      if (m[1] && m[1] !== this.tag) return false;
      if (![...m[2].matchAll(/\.([\w-]+)/g)].every(c => this.classes.has(c[1]))) return false;
      return [...m[3].matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].every(([, attr, v]) => {
        const key = attr.replace(/^data-/, "").replace(/-(\w)/g, (_a, c) => c.toUpperCase());
        return v === undefined ? key in this.dataset : this.dataset[key] === v;
      });
    });
  }
  closest(sel) {
    for (let e = this; e; e = e.parent) if (e.matches(sel)) return e;
    return null;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = el => { for (const k of el.kids) { if (k.matches(sel)) out.push(k); walk(k); } };
    walk(this);
    return out;
  }
}
const btn = (cls, data) => new El("button", { cls, data });

/** A card DOM: the CT footer row, a squad split, and one targetResult section per part with the CT buttons. */
function dom() {
  const root = new El("li", { cls: "chat-message", data: { messageId: "m" } });
  const footer = new El("footer", { cls: "message-part-buttons dsct-apply-all-row" });
  const split = new El("span", { cls: "ctlib-split dsct-apply-all" });
  const go = btn("dsct-apply-all-go");
  const undo = btn("ctlib-undo dsct-apply-all-undo");
  split.append(go, undo); footer.append(split); root.append(footer);
  const details = new El("details", { cls: "dsct-squad12" });
  const sq = new El("span", { cls: "ctlib-split dsct-squad12-btn" });
  const sqGo = btn("dsct-squad12-btn-go");
  const sqUndo = btn("dsct-squad12-btn-undo");
  sq.append(sqGo, sqUndo); details.append(sq); root.append(details);
  const sections = {};
  for (const id of [P, Q]) {
    const section = new El("section", { data: { messagePart: id } });
    const fmRow = new El("div", { cls: "dsct-fm-roll", data: { fmIndex: "0" } });
    const b = {
      fm: btn("dsct-fm-go"), grab: btn("dsct-grab-btn"),
      frightened: btn("", { dsctAction: "dsct-frightened" }), taunted: btn("", { dsctAction: "dsct-taunted" }),
      purifying: btn("", { dsctAction: "dsct-purifying-fire" }), flat: btn("dsct-flat-damage-btn"), tp: btn("dsct-tp-ability-btn"),
      sys: btn("", { action: "applyDamage", index: "1" }), other: btn("some-other-btn"),
    };
    fmRow.append(b.fm);
    section.append(fmRow, ...Object.values(b).filter(x => x !== b.fm));
    root.append(section);
    sections[id] = b;
  }
  return { root, footer, split, go, undo, sq, sqGo, sqUndo, sections };
}

let n = 0;
const partsMap = () => {
  const parts = new Map([[P, { id: P, type: "targetResult" }], [Q, { id: Q, type: "targetResult" }]]);
  return parts;
};
/** A message with a record: `resolved` false = still resolving (fresh, no resolvedAt); ops signed when resolved. */
function card({ ops = {}, resolved = true } = {}) {
  const id = `fam${String(++n).padStart(12, "0")}`;
  const res = { shape: "targetResult", createdAt: Date.now(), ops };
  if (resolved) res.resolvedAt = Date.now();
  const message = { id, timestamp: Date.now(), flags: { [MOD]: { resolution: res } }, system: { parts: partsMap() } };
  if (resolved) sign(message);
  return message;
}
const op = (kind, partId, extra = {}) => ({ opId: `op${++n}`, kind, partId, status: "applied", targetKeys: ["t"], ...extra });
const ops = (...list) => Object.fromEntries(list.map(o => [o.opId, o]));
const lockedState = el => el.disabled && el.classes.has("ds-auto-locked");

/* ---------- cardHandled ---------- */
{
  assert.equal(guard.cardHandled(null), false, "no message");
  assert.equal(guard.cardHandled({ id: "x", flags: {}, system: { parts: partsMap() } }), false, "no record");
  assert.equal(guard.cardHandled(card({ resolved: false })), true, "resolving");
  assert.equal(guard.cardHandled(card({ ops: ops(op("damage", P, { rollIndex: 1 })) })), true, "resolved with an op");
  assert.equal(guard.cardHandled(card({ ops: ops(op("damage", P, { status: "undone" })) })), true, "an undone op still counts as handled");
  assert.equal(guard.cardHandled(card({ ops: ops(op("damage", P, { status: "external" })) })), true, "an external op counts");
  assert.equal(guard.cardHandled(card({ ops: {} })), false, "resolved with zero ops: not handled");
  const old = card({ resolved: false });
  old.flags[MOD].resolution.createdAt = Date.now() - 10 * 60_000;
  assert.equal(guard.cardHandled(old), false, "an abandoned unresolved record is not handled");
  const m = card({ ops: ops(op("damage", P)) });
  await set("enabled", false);
  assert.equal(guard.cardHandled(m), false, "suite disabled");
  assert.equal(guard.cardHandled(card({ resolved: false })), false, "suite disabled while resolving");
  await set("enabled", true);
  assert.equal(guard.cardHandled(m), true);
  console.log("ok cardHandled (resolving, ops, zero ops, none, abandoned, disabled)");
}

/* ---------- classification ---------- */
{
  const d = dom();
  const b = d.sections[P];
  for (const k of ["grab", "frightened", "taunted", "purifying", "flat", "tp"]) assert.equal(guard.ctButtonKind(b[k]), k, k);
  assert.equal(guard.ctButtonKind(b.fm), "forced");
  assert.equal(guard.ctButtonKind(btn("dsct-fm-go")), null, "a fm-go outside a .dsct-fm-roll row is not classified");
  assert.equal(guard.ctButtonKind(b.sys), null, "system buttons are the veto's business");
  assert.equal(guard.ctButtonKind(b.other), null);
  for (const k of ["damage", "forced", "applied", "heal", "cleanse", "teleport", "resource"]) assert.equal(guard.ctButtonKind(btn(`x dsct-flat-${k}-btn`)), "flat", `flat ${k}`);
  assert.equal(guard.ctButtonKind(btn("dsct-flat-bogus-btn")), null);
  assert.ok(guard.isApplyAllControl(d.go) && guard.isApplyAllControl(d.sqUndo) && !guard.isApplyAllControl(b.flat));
  console.log("ok ctButtonKind / isApplyAllControl");
}

/* ---------- decoration ---------- */
{
  // not handled: nothing is touched
  let d = dom();
  assert.equal(guard.decorateFamily(card({ ops: {} }), d.root), 0);
  assert.ok(!d.go.disabled && !d.footer.classes.has("ds-auto-locked"));

  // an applied damage op of P: apply-all row + squad split locked; flat / purifying / tp of P locked; Q and forced / grab stay
  d = dom();
  const msg = card({ ops: ops(op("damage", P, { rollIndex: 1 })) });
  const count = guard.decorateFamily(msg, d.root);
  for (const el of [d.go, d.undo, d.sqGo, d.sqUndo]) {
    assert.ok(lockedState(el), "apply-all control locked");
    assert.equal(el.dataset.tooltip, "DSAUTO.Lock.BoxOwnsCard");
  }
  assert.ok(d.footer.classes.has("ds-auto-locked") && d.split.classes.has("ds-auto-locked") && d.sq.classes.has("ds-auto-locked"), "rows marked for the CSS layer");
  const bp = d.sections[P];
  for (const k of ["flat", "purifying", "tp"]) { assert.ok(lockedState(bp[k]), `${k} of the owned part locked`); assert.equal(bp[k].dataset.tooltip, "DSAUTO.Lock.PartOwned"); }
  for (const k of ["fm", "grab", "frightened", "taunted", "sys", "other"]) assert.ok(!bp[k].disabled, `${k} not covered by a damage op`);
  for (const k of Object.keys(d.sections[Q])) assert.ok(!d.sections[Q][k].disabled, `other part ${k} free`);
  assert.equal(count, 4 + 3);

  // re-decorating a re-added row (a fresh DOM) works the same
  const d2 = dom();
  guard.decorateFamily(msg, d2.root);
  assert.ok(lockedState(d2.go));

  // owned forced + grabbed condition ops
  d = dom();
  guard.decorateFamily(card({ ops: ops(op("forced", P, { movedType: "push" }), op("condition", P, { effectId: "grabbed", status: "pending" })) }), d.root);
  assert.ok(lockedState(d.sections[P].fm) && lockedState(d.sections[P].grab), "forced + grab locked");
  assert.ok(lockedState(d.sections[P].flat), "any owned op locks the flat button");
  assert.ok(!d.sections[P].frightened.disabled && !d.sections[P].taunted.disabled, "other conditions free");

  // undone / skipped / external rows leave their buttons open (the apply-all controls are still locked: the card is handled)
  d = dom();
  guard.decorateFamily(card({ ops: ops(op("forced", P, { status: "undone" }), op("condition", P, { effectId: "grabbed", status: "skipped" }), op("damage", P, { status: "external" })) }), d.root);
  assert.ok(lockedState(d.go), "handled card: apply-all locked even when every op is undone");
  for (const k of Object.keys(d.sections[P])) assert.ok(!d.sections[P][k].disabled, `${k} free after undo / skip / external`);

  // resolving: every CT per-target button of a targetResult part is locked (the apply-all too)
  d = dom();
  guard.decorateFamily(card({ resolved: false }), d.root);
  assert.ok(lockedState(d.go));
  for (const id of [P, Q]) {
    for (const k of ["fm", "grab", "frightened", "taunted", "purifying", "flat", "tp"]) assert.equal(d.sections[id][k].dataset.tooltip, "DSAUTO.Lock.Resolving", `${id} ${k}`);
    assert.ok(!d.sections[id].sys.disabled && !d.sections[id].other.disabled, "system buttons are the veto's, unknown buttons stay");
  }
  console.log("ok decorateFamily (card row, squad split, per-target buttons, undone, resolving)");
}

/* ---------- guard decision ---------- */
{
  const d = dom();
  const b = d.sections[P];
  const forcedPending = card({ ops: ops(op("forced", P, { status: "pending" })) });
  assert.deepEqual(guard.guardDecision(forcedPending, b.fm), { key: "DSAUTO.Lock.PartOwned" }, "owned pending forced op blocks fm-go");
  assert.equal(guard.guardDecision(forcedPending, d.sections[Q].fm), null, "other part free");
  assert.equal(guard.guardDecision(forcedPending, b.grab), null, "a forced op does not own grab");
  assert.deepEqual(guard.guardDecision(forcedPending, d.go), { key: "DSAUTO.Lock.BoxOwnsCard" }, "apply-all blocked");
  assert.deepEqual(guard.guardDecision(forcedPending, d.sqUndo), { key: "DSAUTO.Lock.BoxOwnsCard" }, "squad undo blocked");
  assert.equal(guard.guardDecision(forcedPending, b.sys), null, "system buttons are not this guard's");
  assert.equal(guard.guardDecision(forcedPending, b.other), null);

  const undone = card({ ops: ops(op("forced", P, { status: "undone" })) });
  assert.equal(guard.guardDecision(undone, b.fm), null, "undone op: fm-go clickable");
  assert.deepEqual(guard.guardDecision(undone, d.go), { key: "DSAUTO.Lock.BoxOwnsCard" }, "apply-all stays blocked");

  const grabbed = card({ ops: ops(op("condition", P, { effectId: "grabbed" })) });
  assert.ok(guard.guardDecision(grabbed, b.grab), "owned grabbed condition blocks grab");
  assert.equal(guard.guardDecision(grabbed, b.frightened), null, "grabbed does not own frightened");
  assert.ok(guard.guardDecision(grabbed, b.flat) && guard.guardDecision(grabbed, b.tp) && guard.guardDecision(grabbed, b.purifying), "flat / tp / purifying: any owned op");
  const fright = card({ ops: ops(op("condition", P, { effectId: "frightened" }), op("condition", P, { effectId: "taunted", status: "pending" })) });
  assert.ok(guard.guardDecision(fright, b.frightened) && guard.guardDecision(fright, b.taunted));
  assert.equal(guard.guardDecision(fright, b.grab), null);
  const squad = card({ ops: ops(op("damage", "squadHead", { parts: [{ partId: P, rollIndex: 1 }] })) });
  assert.ok(guard.guardDecision(squad, b.flat), "a squad op that lists the part owns it");

  const resolving = card({ resolved: false });
  for (const k of ["fm", "grab", "frightened", "taunted", "purifying", "flat", "tp"]) assert.deepEqual(guard.guardDecision(resolving, b[k]), { key: "DSAUTO.Lock.Resolving" }, `resolving blocks ${k}`);
  assert.deepEqual(guard.guardDecision(resolving, d.go), { key: "DSAUTO.Lock.BoxOwnsCard" });
  const noPartType = card({ resolved: false });
  noPartType.system.parts.get(P).type = "abilityUse";
  assert.deepEqual(guard.guardDecision(noPartType, b.flat), { key: "DSAUTO.Lock.Resolving" }, "card-level (abilityUse) buttons blocked while resolving");
  noPartType.system.parts.get(P).type = "content";
  assert.equal(guard.guardDecision(noPartType, b.fm), null, "only targetResult / abilityUse parts");
  const cardLevel = card({ ops: ops(op("damage", "otherPart")) });
  cardLevel.system.parts.get(P).type = "abilityUse";
  assert.equal(guard.guardDecision(cardLevel, b.flat), null, "card-level button free when the box owns no row of that part");
  const cardWide = card({ ops: ops(op("damage", null)) });
  cardWide.system.parts.get(P).type = "abilityUse";
  assert.ok(guard.guardDecision(cardWide, b.flat), "card-level button locked by a card-wide owned op");

  const bare = { id: "bare", flags: {}, system: { parts: partsMap() } };
  assert.equal(guard.guardDecision(bare, b.fm), null, "card without a record is not blocked");
  assert.equal(guard.guardDecision(bare, d.go), null);
  assert.equal(guard.guardDecision(card({ ops: {} }), d.go), null, "resolved with zero ops: not blocked");
  await set("enabled", false);
  assert.equal(guard.guardDecision(forcedPending, b.fm), null, "suite disabled: never blocked");
  await set("enabled", true);
  console.log("ok guardDecision (owned, undone, conditions, squad, resolving, no record, disabled)");
}

/* ---------- the capture listener end to end ---------- */
{
  const msg = card({ ops: ops(op("forced", P, { status: "pending" })) });
  game.messages.set(msg.id, msg);
  const d = dom();
  d.root.dataset.messageId = msg.id;
  const click = (target, isTrusted = true) => {
    const ev = { target, isTrusted, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
    guard.onCaptureClick(ev);
    return ev;
  };
  warns.length = 0;
  let ev = click(d.sections[P].fm);
  assert.ok(ev.prevented && ev.stopped, "owned fm-go swallowed");
  assert.deepEqual(warns, ["DSAUTO.Lock.PartOwned"], "warned once with the lock text");
  click(d.sections[P].fm);
  assert.equal(warns.length, 1, "repeated clicks in a burst warn once");
  const n = warns.length;
  ev = click(d.sections[P].fm, false);
  assert.ok(ev.prevented && ev.stopped, "synthetic click swallowed");
  ev = click(d.go, false);
  assert.ok(ev.prevented && ev.stopped, "synthetic apply-all swallowed");
  assert.equal(warns.length, n, "synthetic clicks (autoApplyOwnAbilities) never toast");
  ev = click(d.go);
  assert.ok(ev.prevented && warns.at(-1) === "DSAUTO.Lock.BoxOwnsCard", "apply-all swallowed");
  ev = click(d.sections[Q].fm);
  assert.ok(!ev.prevented && !ev.stopped, "another part's fm-go passes");
  ev = click(d.sections[P].other);
  assert.ok(!ev.prevented, "unrelated button passes");
  ev = click(new El("div"));
  assert.ok(!ev.prevented, "a click outside any button passes");
  game.messages.delete(msg.id);
  console.log("ok onCaptureClick (swallow, warn once, pass)");
}
console.log("harness26 done");
process.exit(0);
