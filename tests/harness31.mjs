/**
 * 1.2.2: a Combat Tools advanced chip naming `flat=<effectId>` is HIDDEN (wrapper class + its "; " separator) when the card's
 * record holds an op of the kind that flat effect maps to (scripts/ui/dstd-lock.mjs, point 7); chips without `flat=` keep the
 * lock behaviour. Fake DOM with text nodes; the record is signed like harness28's.
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const paths = createRequire(import.meta.url)("./paths.cjs");
const imp = p => import(pathToFileURL(paths.SCRIPTS + p).href);
globalThis.__HARNESS_SKIP_SCENARIOS__ = true;
await import("./harness.mjs");
const lockMod = await imp("ui/dstd-lock.mjs");
const { sign } = await imp("engine/ledger.mjs");
const { targetKey } = await imp("engine/keys.mjs");

const MOD = "stef-ds-automation";
const ABILITY = "Item.myLife";
const items = new Map();
globalThis.fromUuidSync = u => items.get(u) ?? null;
globalThis.ui.notifications.warn = () => {};

class Text {
  constructor(data) { this.nodeType = 3; this.data = data; this.parent = null; }
  get nextSibling() { return this.parent?.kids[this.parent.kids.indexOf(this) + 1] ?? null; }
  get previousSibling() { return this.parent?.kids[this.parent.kids.indexOf(this) - 1] ?? null; }
}
class El {
  constructor(tag, { cls = "", data = {} } = {}) {
    this.nodeType = 1; this.tag = tag; this.kids = []; this.parent = null;
    this.classes = new Set(cls.split(/\s+/).filter(Boolean));
    this.classList = { add: c => this.classes.add(c), remove: c => this.classes.delete(c), contains: c => this.classes.has(c) };
    this.dataset = { ...data };
  }
  getAttribute(name) { return this.dataset[name.replace(/^data-/, "").replace(/-(\w)/g, (_a, c) => c.toUpperCase())] ?? null; }
  contains(el) { for (let e = el; e; e = e.parent) if (e === this) return true; return false; }
  append(...els) { for (const e of els) { e.parent = this; this.kids.push(e); } return this; }
  get nextSibling() { return this.parent?.kids[this.parent.kids.indexOf(this) + 1] ?? null; }
  get previousSibling() { return this.parent?.kids[this.parent.kids.indexOf(this) - 1] ?? null; }
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
    const walk = el => { for (const k of el.kids ?? []) { if (k.nodeType === 1 && k.matches(sel)) out.push(k); walk(k); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}

let n = 0;
/** A card whose record holds `ops` ([kind, status, reason?]); the ability has the flat effects `effects` ({id: type}). */
function card(ops, effects = { flat1: "dsct.flatHeal" }) {
  const id = `fch${String(++n).padStart(12, "0")}`;
  const res = { shape: "targetResult", createdAt: Date.now(), resolvedAt: Date.now(), abilityUuid: ABILITY, ops: {} };
  ops.forEach(([kind, status, reason], i) => { res.ops[`o${i}`] = { opId: `o${i}`, kind, status, reason, targetKeys: ["t"] }; });
  const message = { id, timestamp: Date.now(), flags: { [MOD]: { resolution: res } }, system: { parts: new Map() } };
  sign(message);
  game.messages.set(id, message);
  items.set(ABILITY, { system: { effects: { get: k => (effects[k] ? { id: k, type: effects[k] } : undefined) } } });
  return message;
}
/** li > p > [chip A, separator text, chip B]; chip A carries `source`, chip B a plain damage chip without flat=. */
function dom(messageId, source, { sep = "; " } = {}) {
  const li = new El("li", { data: { messageId } });
  const p = new El("p");
  const mk = (kind, src) => {
    const ec = new El("enriched-content", { cls: "dsct-adv", data: { advKind: kind } });
    const a = new El("a", { data: { dsctSource: src } });
    const face = new El("span", { data: { ctlibFace: "Scene.s.Token.t1" } });
    ec.append(a.append(face));
    return { ec, a, face };
  };
  const A = mk("heal", source);
  const B = mk("damage", "2 damage recipient=target");
  const s = new Text(sep);
  li.append(p.append(A.ec, s, B.ec));
  return { li, A, B, s };
}
const SRC = "@recoveries.recoveryValue value=self recovery=self recipient=target flat=flat1";
const click = target => {
  const ev = { target, isTrusted: true, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  lockMod.onCaptureClick(ev);
  return ev;
};
const HID = "ds-auto-hidden-native";

/* hidden: heal flat chip + a heal op */
{
  const m = card([["heal", "applied"]]);
  const d = dom(m.id, SRC);
  assert.equal(lockMod.hideDuplicateChips(m, d.li), 1);
  assert.ok(d.A.ec.classes.has(HID), "chip wrapper hidden");
  assert.equal(d.s.data, "", "separator blanked");
  assert.ok(!d.B.ec.classes.has(HID), "chip without flat= untouched");
  assert.ok(click(d.A.face).prevented, "click on a hidden chip stays swallowed (backstop)");
  assert.equal(lockMod.hideDuplicateChips(m, d.li), 1);
  assert.equal(d.s.data, "", "second pass keeps the separator blank");
  console.log("ok hidden by a matching op");
}

/* an op of another kind, no ops, a notChosen skip: visible */
{
  for (const [label, ops] of [["other kind", [["damage", "applied"]]], ["no ops", []], ["notChosen skip", [["heal", "skipped", "notChosen"]]]]) {
    const m = card(ops);
    const d = dom(m.id, SRC);
    assert.equal(lockMod.hideDuplicateChips(m, d.li), 0, label);
    assert.ok(!d.A.ec.classes.has(HID), `${label}: visible`);
    assert.equal(d.s.data, "; ", `${label}: separator kept`);
  }
  const m = card([["heal", "applied"]], { flat1: "dsct.flatDamage" });
  assert.equal(lockMod.hideDuplicateChips(m, dom(m.id, SRC).li), 0, "effect maps to damage, only a heal op: visible");
  const gone = card([["heal", "applied"]], {});
  assert.equal(lockMod.hideDuplicateChips(gone, dom(gone.id, SRC).li), 0, "unknown effect id: visible");
  console.log("ok visible without a matching op");
}

/* every status but a notChosen skip hides, an undone op too; temp heals count for heal; reversible */
{
  for (const status of ["planned", "prompt", "held", "applied", "undone", "failed"]) {
    const m = card([["heal", status]]);
    assert.equal(lockMod.hideDuplicateChips(m, dom(m.id, SRC).li), 1, status);
  }
  const m = card([["temp", "undone"]]);
  const d = dom(m.id, SRC);
  assert.equal(lockMod.hideDuplicateChips(m, d.li), 1, "temp op hides a heal chip");
  m.flags[MOD].resolution.ops.o0.status = "skipped";
  m.flags[MOD].resolution.ops.o0.reason = "notChosen";
  sign(m);
  assert.equal(lockMod.hideDuplicateChips(m, d.li), 0);
  assert.ok(!d.A.ec.classes.has(HID), "chip visible again");
  assert.equal(d.s.data, "; ", "separator restored");
  console.log("ok statuses and reversibility");
}

/* a hidden last chip blanks the separator before it; a longer text keeps its rest */
{
  const m = card([["heal", "applied"]]);
  const d = dom(m.id, "2 damage recipient=target");
  d.B.a.dataset.dsctSource = SRC;
  assert.equal(lockMod.hideDuplicateChips(m, d.li), 1);
  assert.ok(d.B.ec.classes.has(HID) && !d.A.ec.classes.has(HID));
  assert.equal(d.s.data, "", "separator before the hidden last chip blanked");
  const m2 = card([["heal", "applied"]]);
  const d2 = dom(m2.id, SRC, { sep: "; and then" });
  lockMod.hideDuplicateChips(m2, d2.li);
  assert.equal(d2.s.data, "and then", "only the separator part goes");
  console.log("ok separators");
}

/* chips without flat=: the lock logic is unchanged (a library-planned applied heal op locks, nothing is hidden) */
{
  const m = card([["heal", "applied"]]);
  Object.assign(m.flags[MOD].resolution.ops.o0, { lib: true, targetKeys: [targetKey("Scene.s.Token.t1")] });
  sign(m);
  const d = dom(m.id, "@recoveries.recoveryValue value=self recipient=target");
  assert.equal(lockMod.hideDuplicateChips(m, d.li), 0, "no flat=: not hidden");
  assert.ok(!d.A.ec.classes.has(HID));
  assert.equal(d.s.data, "; ");
  lockMod.decorateEnrichers(m, d.li);
  assert.ok(d.A.face.classes.has("ds-auto-locked"), "no flat=: face locked as before");
  assert.ok(click(d.A.face).prevented, "no flat=: click swallowed as before");
  assert.ok(!click(d.B.face).prevented, "unrelated damage chip passes");
  console.log("ok chips without flat= unchanged");
}
/* 1.2.2: Combat Tools' heal / teleport buttons (tiered or flat) are hidden by the suite's op of that kind (whatever lockDstdRows says) */
{
  const tieredCard = (ops, types) => {
    const m = card(ops);
    game.modules.set("draw-steel-combat-tools", { active: true });
    items.set(ABILITY, { system: { effects: { get: () => undefined, contents: [] }, power: { effects: { contents: types.map(type => ({ type })) } } } });
    return m;
  };
  const footer = m => {
    const li = new El("li", { data: { messageId: m.id } });
    const f = new El("footer");
    const heal = new El("button", { cls: "dsct-flat-heal-btn" });
    const tele = new El("button", { cls: "dsct-flat-teleport-btn" });
    const icon = new El("i");
    const other = new El("button", { cls: "dsct-flat-damage-btn" });
    li.append(f.append(heal.append(icon), tele, other));
    return { li, heal, tele, other, icon };
  };
  await game.settings.set(MOD, "lockDstdRows", false);
  const m = tieredCard([["heal", "applied"]], ["dsctHeal", "dsctTeleport"]);
  const d = footer(m);
  assert.equal(lockMod.hideDuplicateChips(m, d.li), 1, "only the heal button: the record has no teleport op");
  assert.ok(d.heal.classes.has(HID), "heal button hidden");
  assert.ok(!d.tele.classes.has(HID), "teleport button stays (fallback)");
  assert.ok(!d.other.classes.has(HID), "other buttons untouched");
  assert.ok(click(d.icon).prevented, "click on a hidden tiered button is swallowed with lockDstdRows off");
  assert.ok(!click(d.tele).prevented, "visible fallback button passes");
  assert.ok(!click(d.other).prevented);
  await game.settings.set(MOD, "lockDstdRows", true);
  assert.ok(click(d.heal).prevented, "and with it on");
  // teleport op, a temp heal op, a notChosen skip, an item without the tiered effect
  const t = tieredCard([["teleport", "pending"]], ["dsctTeleport"]);
  const dt = footer(t);
  assert.equal(lockMod.hideDuplicateChips(t, dt.li), 1);
  assert.ok(dt.tele.classes.has(HID) && !dt.heal.classes.has(HID));
  const tmp = tieredCard([["temp", "undone"]], ["dsctHeal"]);
  assert.equal(lockMod.hideDuplicateChips(tmp, footer(tmp).li), 1, "temp op hides a heal button");
  const skip = tieredCard([["heal", "skipped", "notChosen"]], ["dsctHeal"]);
  assert.equal(lockMod.hideDuplicateChips(skip, footer(skip).li), 0, "notChosen skip: visible");
  const none = tieredCard([["heal", "applied"]], []);
  assert.equal(lockMod.hideDuplicateChips(none, footer(none).li), 0, "no Combat Tools heal on the item: visible");
  // A flat (not tiered) Combat Tools heal renders the same button: hidden too.
  const flat = card([["heal", "applied"]]);
  items.set(ABILITY, { system: { effects: { get: () => undefined, contents: [{ type: "dsct.flatHeal" }] }, power: { effects: { contents: [] } } } });
  assert.equal(lockMod.hideDuplicateChips(flat, footer(flat).li), 1, "flat heal button hidden");
  game.modules.delete("draw-steel-combat-tools");
  const noop = tieredCard([], ["dsctHeal"]);
  const dn = footer(noop);
  assert.equal(lockMod.hideDuplicateChips(noop, dn.li), 0, "no op: visible");
  // reversible
  const rev = tieredCard([["heal", "applied"]], ["dsctHeal"]);
  const dr = footer(rev);
  lockMod.hideDuplicateChips(rev, dr.li);
  rev.flags[MOD].resolution.ops.o0.status = "skipped";
  rev.flags[MOD].resolution.ops.o0.reason = "notChosen";
  sign(rev);
  assert.equal(lockMod.hideDuplicateChips(rev, dr.li), 0);
  assert.ok(!dr.heal.classes.has(HID), "button visible again");
  console.log("ok tiered buttons hidden");
}
console.log("harness31 done");
process.exit(0);
