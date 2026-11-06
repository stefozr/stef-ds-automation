// Harness 22 (1.2.0): Shadow Insight discount in the Use Ability dialog (ui/insight-discount.mjs).
// Standalone: a mock of the system's AbilityConfigurationDialog methods the module wraps, with libWrapper emulated by
// replacing the prototype methods, and a mock of game.settings / game.combat.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const paths = createRequire(import.meta.url)("./paths.cjs");
const MOD = "stef-ds-automation";
const store = new Map([["enabled", true], ["libraryEnabled", true], ["insightDiscount", true]]);
const hooks = [];
let combat = { started: true };
globalThis.Hooks = { on: (name, fn) => hooks.push([name, fn]) };
globalThis.game = {
  settings: { get(mod, key) { if (!store.has(key)) throw new Error(`unregistered ${key}`); return store.get(key); } },
  get combat() { return combat; },
  modules: new Map([["lib-wrapper", { active: true }]]),
  i18n: { localize: k => k, format: k => k },
};

/** The system's dialog in miniature: the same method names, with the same data flow as AbilityConfigurationDialog. */
class Dialog {
  constructor(item, context) { this.item = item; this.options = { context }; }
  async _preparePartContext(partId, context) {
    if (partId === "roll") for (const t of Object.values(context.targets ?? {})) {
      t.combinedModifiers = {
        edges: Math.min(Math.max(t.modifiers.edges + context.modifiers.edges, 0), 2),
        banes: Math.min(Math.max(t.modifiers.banes + context.modifiers.banes, 0), 2),
      };
    }
    return context;
  }
  _refreshInputs(formData) {
    if ("resource" in formData) this.options.context.resource.value = formData.resource;
    if (formData.targets) for (const [id, t] of Object.entries(formData.targets)) Object.assign(this.options.context.targets[id].modifiers, t.modifiers);
  }
  _processFormData(_e, _f, formData) { return { resource: formData.resource }; }
  /** One render: the context is a shallow copy of options.context, parts in order roll then ability. */
  async render() {
    const context = { ...this.options.context };
    await this._preparePartContext("roll", context);
    await this._preparePartContext("ability", context);
    return context;
  }
  /** A form change (pill, field): refresh from the form, then re-render. */
  async change(formData) { this._refreshInputs(formData); return this.render(); }
  submit(formData) { return this._processFormData(null, null, formData); }
}
globalThis.ds = { applications: { apps: { AbilityConfigurationDialog: Dialog } } };
globalThis.libWrapper = {
  register(_m, target, fn) {
    const keys = target.split("."), name = keys.pop();
    const owner = keys.reduce((o, k) => o[k], globalThis);
    const orig = owner[name];
    owner[name] = function(...args) { return fn.call(this, orig.bind(this), ...args); };
  },
};

const { registerInsightDiscount, insightDiscountShown, insightDiscountApplies } = await import(pathToFileURL(paths.SCRIPTS + "ui/insight-discount.mjs").href);
registerInsightDiscount();
registerInsightDiscount(); // idempotent: wrapping twice would double the hooks and wrappers
assert.equal(hooks.filter(([n]) => n === "renderAbilityConfigurationDialog").length, 1, "one render hook");

const shadow = () => ({ items: [{ type: "feature", system: { _dsid: "insight" }, flags: {} }] });
const ability = (over = {}, actor = shadow()) => ({
  actor,
  system: { category: "heroic", resource: 3, power: { roll: { enabled: true } }, ...over },
});
const target = (edges = 0, banes = 0) => ({ modifiers: { edges, banes, bonuses: 0 } });
const dialog = (item, targets, modifiers = { edges: 0, banes: 0, bonuses: 0 }) =>
  new Dialog(item, { resource: { current: 5, value: item.system.resource, name: "Insight" }, modifiers, targets });
const cost = ctx => ctx.resource.value;

/* ---------- applies: one edge target among two ---------- */
{
  const d = dialog(ability(), { a: target(0, 0), b: target(1, 0) });
  const ctx = await d.render();
  assert.equal(cost(ctx), 2, "cost 3 -> 2 with an edge on one of two targets");
  assert.ok(insightDiscountShown(d), "the hint is shown");
  assert.deepEqual(d.submit({ resource: 2 }), { resource: 2 }, "the charge is the shown cost");
  console.log("ok edge on one target among two lowers the cost");
}

/* ---------- double edge, and a global edge, both count ---------- */
{
  assert.equal(cost(await dialog(ability(), { a: target(2, 0) }).render()), 2, "double edge");
  assert.equal(cost(await dialog(ability(), { a: target(0, 0) }, { edges: 1, banes: 0, bonuses: 0 }).render()), 2, "global edge");
  assert.equal(cost(await dialog(ability({ resource: 1 }), { a: target(1, 0) }).render()), 0, "cost 1 -> 0, never negative");
  console.log("ok double edge, global edge, minimum zero");
}

/* ---------- edge and bane cancel ---------- */
{
  const d = dialog(ability(), { a: target(1, 1) });
  assert.equal(cost(await d.render()), 3, "edge + bane on the same target: no discount");
  assert.ok(!insightDiscountShown(d));
  assert.equal(cost(await dialog(ability(), { a: target(1, 0) }, { edges: 0, banes: 1, bonuses: 0 }).render()), 3, "a global bane cancels the target edge");
  assert.equal(cost(await dialog(ability(), { a: target(0, 2), b: target(1, 0) }).render()), 2, "another target keeps its edge");
  console.log("ok edges and banes cancel");
}

/* ---------- no discount without the feature, or when the ability is out of scope ---------- */
{
  const edge = { a: target(1, 0) };
  const plain = { items: [{ type: "feature", system: { _dsid: "other" }, flags: {} }] };
  assert.equal(cost(await dialog(ability({}, plain), edge).render()), 3, "no insight feature");
  const off = shadow(); off.items[0].flags[MOD] = { disabled: true };
  assert.equal(cost(await dialog(ability({}, off), edge).render()), 3, "feature disabled by the medkit flag");
  assert.equal(cost(await dialog(ability({ category: "signature" }), edge).render()), 3, "not heroic");
  assert.equal(cost(await dialog(ability({ power: { roll: { enabled: false } } }), edge).render()), 3, "no power roll");
  assert.equal(cost(await dialog(ability({ resource: 0 }), edge).render()), 0, "cost 0 stays 0");
  combat = null;
  assert.equal(cost(await dialog(ability(), edge).render()), 3, "no combat");
  combat = { started: false };
  assert.equal(cost(await dialog(ability(), edge).render()), 3, "combat not started");
  combat = { started: true };
  for (const key of ["insightDiscount", "libraryEnabled", "enabled"]) {
    store.set(key, false);
    assert.equal(cost(await dialog(ability(), edge).render()), 3, `${key} off`);
    store.set(key, true);
  }
  assert.ok(!insightDiscountApplies(dialog(ability({ resource: 0 }), edge)), "predicate: cost 0");
  console.log("ok no discount without the feature, outside heroic power-roll abilities, outside combat, or with a setting off");
}

/* ---------- a manual edit wins, even when the edges change ---------- */
{
  const d = dialog(ability(), { a: target(1, 0) });
  assert.equal(cost(await d.render()), 2);
  // An unrelated form change (the field still holds our value) is not an edit.
  assert.equal(cost(await d.change({ resource: 2 })), 2);
  // The player types 3 (the full cost): an edit, the discount never returns.
  assert.equal(cost(await d.change({ resource: 3 })), 3, "typed value kept");
  assert.ok(!insightDiscountShown(d), "no hint after an edit");
  assert.deepEqual(d.submit({ resource: 3 }), { resource: 3 }, "the charge is the typed value");
  // Even a later edge change does not touch the typed value.
  await d.change({ resource: 3, targets: { a: { modifiers: { edges: 0 } } } });
  assert.equal(cost(await d.change({ resource: 3, targets: { a: { modifiers: { edges: 2 } } } })), 3);
  // A typed value that differs from base and shown stays through a submit.
  const e = dialog(ability(), { a: target(1, 0) });
  await e.render();
  assert.equal(cost(await e.change({ resource: 1 })), 1, "typed 1");
  assert.deepEqual(e.submit({ resource: 1 }), { resource: 1 });
  console.log("ok a manual edit wins");
}

/* ---------- a re-render after the edges change toggles between cost and cost - 1 ---------- */
{
  const d = dialog(ability(), { a: target(0, 0) });
  assert.equal(cost(await d.render()), 3, "no edge yet");
  assert.equal(cost(await d.change({ resource: 3, targets: { a: { modifiers: { edges: 1 } } } })), 2, "an edge pill: 3 -> 2");
  assert.ok(insightDiscountShown(d));
  assert.equal(cost(await d.change({ resource: 2, targets: { a: { modifiers: { banes: 1 } } } })), 3, "a bane pill cancels it: 2 -> 3");
  assert.ok(!insightDiscountShown(d));
  assert.equal(cost(await d.change({ resource: 3, targets: { a: { modifiers: { banes: 0 } } } })), 2, "bane removed: 3 -> 2");
  console.log("ok edges toggling re-render moves the cost");
}

/* ---------- a stale render cannot charge the full cost ---------- */
{
  const d = dialog(ability(), { a: target(1, 0) });
  await d.render();
  assert.deepEqual(d.submit({ resource: 3 }), { resource: 2 }, "the form still said 3 (stale), the decision wins");
  // Edges removed after the render (no re-render yet): the stale shown cost is raised back.
  d.options.context.targets.a.modifiers.edges = 0;
  d.options.context.targets.a.combinedModifiers.edges = 0;
  assert.deepEqual(d.submit({ resource: 2 }), { resource: 3 }, "no edge any more: full cost");
  console.log("ok submit repeats the decision");
}

console.log("harness22 passed");
