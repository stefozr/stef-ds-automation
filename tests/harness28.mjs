/**
 * 1.2.2: Draw Steel 1.2's native "Persistent (X)" button on ability cards (`[data-action="persistent"]`) is hidden on cards
 * the Automation box handles and that carry a persistent cost (scripts/ui/persistent-button-lock.mjs): the suite already
 * charges X at each kept turn start, so the native button would charge twice (its footer is hidden too when no other button
 * is left in it). Decoration of a fake DOM and the capture
 * guard (trusted click toasts, synthetic click is silent, cards without a cost or record stay untouched).
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const paths = createRequire(import.meta.url)("./paths.cjs");
const imp = p => import(pathToFileURL(paths.SCRIPTS + p).href);
globalThis.__HARNESS_SKIP_SCENARIOS__ = true;
await import("./harness.mjs");
const lockMod = await imp("ui/persistent-button-lock.mjs");
const { sign } = await imp("engine/ledger.mjs");

const MOD = "stef-ds-automation";
const warns = [];
globalThis.ui.notifications.warn = m => warns.push(m);

class El {
  constructor(tag, { cls = "", data = {} } = {}) {
    this.tag = tag; this.kids = []; this.parent = null; this.disabled = false;
    this.classes = new Set(cls.split(/\s+/).filter(Boolean));
    this.classList = { add: c => this.classes.add(c), contains: c => this.classes.has(c) };
    this.dataset = { ...data };
  }
  append(...els) { for (const e of els) { e.parent = this; this.kids.push(e); } return this; }
  matches(sel) {
    const m = sel.match(/^([a-z]+)?((?:\[[^\]]+\])*)$/);
    if (m[1] && m[1] !== this.tag) return false;
    return [...m[2].matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].every(([, attr, v]) => {
      const key = attr.replace(/^data-/, "").replace(/-(\w)/g, (_a, c) => c.toUpperCase());
      return v === undefined ? key in this.dataset : this.dataset[key] === v;
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
function dom(messageId) {
  const root = new El("li", { data: { messageId } });
  const persistent = new El("button", { data: { action: "persistent", specialEffectId: "eff1" } });
  const other = new El("button", { data: { action: "rollTest" } });
  const footer = new El("footer", { cls: "message-part-buttons" });
  root.append(footer.append(persistent, other));
  return { root, persistent, other, footer };
}

let n = 0;
function card({ cost, record = true } = {}) {
  const id = `per${String(++n).padStart(12, "0")}`;
  const message = { id, timestamp: Date.now(), flags: {}, system: { parts: new Map() } };
  if (record) {
    const res = { shape: "targetResult", createdAt: Date.now(), resolvedAt: Date.now(), ops: { o1: { opId: "o1", kind: "damage", status: "applied", targetKeys: ["t"] } } };
    if (cost !== undefined) res.persistent = { cost, keep: false };
    message.flags[MOD] = { resolution: res };
    sign(message);
  }
  game.messages.set(id, message);
  return message;
}
const click = (target, isTrusted = true) => {
  const ev = { target, isTrusted, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  lockMod.onCaptureClick(ev);
  return ev;
};

/* ---------- decoration ---------- */
{
  const m = card({ cost: 2 });
  const d = dom(m.id);
  assert.equal(lockMod.decoratePersistent(m, d.root), 1);
  assert.ok(d.persistent.classes.has("ds-auto-hidden-native"), "persistent button hidden");
  assert.ok(!d.persistent.disabled, "hidden, not disabled");
  assert.ok(!d.other.classes.has("ds-auto-hidden-native"), "other buttons untouched");
  assert.ok(!d.footer.classes.has("ds-auto-hidden-native"), "footer with another button stays");
  // A footer that holds only the Persistent button goes too (no empty row).
  const solo = card({ cost: 2 });
  const sRoot = new El("li", { data: { messageId: solo.id } });
  const sFooter = new El("footer", { cls: "message-part-buttons" });
  const sBtn = new El("button", { data: { action: "persistent" } });
  sRoot.append(sFooter.append(sBtn));
  assert.equal(lockMod.decoratePersistent(solo, sRoot), 1);
  assert.ok(sBtn.classes.has("ds-auto-hidden-native") && sFooter.classes.has("ds-auto-hidden-native"), "lone button: footer hidden too");

  for (const [label, msg] of [["no persistent cost", card()], ["zero cost", card({ cost: 0 })], ["no record", card({ record: false })]]) {
    const x = dom(msg.id);
    assert.equal(lockMod.decoratePersistent(msg, x.root), 0, label);
    assert.ok(!x.persistent.classes.has("ds-auto-hidden-native"), `${label}: untouched`);
  }
  await game.settings.set(MOD, "persistentUpkeep", false);
  const off = dom(m.id);
  assert.equal(lockMod.decoratePersistent(m, off.root), 0, "turn-start ask off: the native button stays usable");
  assert.ok(!click(off.persistent).prevented, "turn-start ask off: click passes");
  await game.settings.set(MOD, "persistentUpkeep", true);
  assert.equal(lockMod.decoratePersistent(null, d.root), 0);
  assert.equal(lockMod.decoratePersistent(m, null), 0);
  console.log("ok decoratePersistent");
}

/* ---------- capture click ---------- */
{
  const m = card({ cost: 2 });
  const d = dom(m.id);
  warns.length = 0;
  let ev = click(d.persistent);
  assert.ok(ev.prevented && ev.stopped, "trusted click swallowed");
  assert.deepEqual(warns, ["DSAUTO.Lock.PersistentTurnStart"], "trusted click warns");
  ev = click(d.persistent, false);
  assert.ok(ev.prevented && ev.stopped, "synthetic click swallowed");
  assert.equal(warns.length, 1, "synthetic click is silent");
  ev = click(d.other);
  assert.ok(!ev.prevented && !ev.stopped, "other buttons pass");

  for (const [label, msg] of [["no persistent cost", card()], ["no record", card({ record: false })]]) {
    const x = dom(msg.id);
    ev = click(x.persistent);
    assert.ok(!ev.prevented && !ev.stopped, `${label}: click passes`);
  }
  assert.equal(warns.length, 1, "passing clicks never warn");
  const orphan = new El("button", { data: { action: "persistent" } });
  assert.ok(!click(orphan).prevented, "no message row: passes");
  console.log("ok onCaptureClick");
}
console.log("harness28 done");
process.exit(0);
