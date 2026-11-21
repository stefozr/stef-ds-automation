/**
 * 1.2.2: a feature question never stalls the turn lifecycle. The feature engine queues its turn work on its own chain and
 * returns nothing to the lifecycle (features/engine.mjs onFeatureTurnEvent), so a Routines window left open (round-start
 * performance wait) no longer holds back the later turn listeners (Persistent upkeep, ...). The Routines dialog on the GM also
 * times out after 120 s like the recovery dialogs (no ids = "maintain current").
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const paths = createRequire(import.meta.url)("./paths.cjs");
const imp = p => import(pathToFileURL(paths.SCRIPTS + p).href);
const { w, hero, combat, feature, wrappers, registry } = await import("./harness12.mjs");
const { featureEngineIdle, handleFeaturePrompt } = await imp("features/engine.mjs");
const { activePerformances } = await imp("features/performance.mjs");
const { registerPromptType } = await imp("relay/prompt-router.mjs");
const lifecycle = await imp("turn/lifecycle.mjs");
const MOD = "stef-ds-automation";
w.setUser(w.users.gm);
foundry.helpers = { ActiveEffectRegistry: class { async refresh() {} } };
lifecycle.registerLifecycle();
registerPromptType("featureRule", handleFeaturePrompt);
lifecycle.resetActivations();

const routines = feature("Routines", hero, "feature", "routines");
const choreo = [...hero.items].find?.(i => i.system?._dsid === "choreography") ?? hero.items.contents?.find(i => i.system?._dsid === "choreography");
assert.ok(choreo, "the harness hero has a performance ability");

/* ---------- (b) the Routines dialog times out after 120 s ---------- */
{
  const nativeTimeout = globalThis.setTimeout, nativePrompt = foundry.applications.api.DialogV2.prompt;
  const timers = [];
  globalThis.setTimeout = (fn, ms, ...args) => ms === 120_000 ? (timers.push(fn), timers.length) : nativeTimeout(fn, ms, ...args);
  let closed = false;
  foundry.applications.api.DialogV2.prompt = options => new Promise(resolve => {
    const dialog = { close: async () => { closed = true; resolve(null); } };
    options.render({}, dialog);
  });
  try {
    const payload = { type: "featureRule", itemUuid: routines.uuid, ruleId: "routines", kind: "performances", tokens: [], choices: [{ id: "maintain", name: "Maintain" }], limit: 1, label: "Routines", promptActorUuid: hero.uuid };
    let result = null;
    const run = handleFeaturePrompt(payload, { user: w.users.gm }).then(r => { result = r; });
    await new Promise(r => nativeTimeout(r, 20));
    assert.equal(timers.length, 1, "a 120 s timer is armed on the performances dialog");
    assert.equal(result, null, "still waiting before the limit");
    timers[0]();
    await run;
    assert.ok(closed, "the dialog is closed on timeout");
    assert.deepEqual(result, { ids: [] }, "timeout answers no ids (= maintain current)");
  } finally { globalThis.setTimeout = nativeTimeout; foundry.applications.api.DialogV2.prompt = nativePrompt; }
  console.log("ok Routines dialog: 120 s limit answers no ids");
}

/* ---------- (a) a blocked feature chain does not stall later turn listeners ---------- */
// The feature engine and the performance round listener are already registered by the harness's main init.
{
  const seen = [];
  lifecycle.onTurnEvent(e => { seen.push(e.event); });   // registered after the feature engine, like Persistent upkeep
  let release;
  const gate = new Promise(r => { release = r; });
  const prompts = [];
  foundry.applications.api.DialogV2.prompt = options => { prompts.push(options); return gate; };   // no render: no timer, the window stays open
  const deleted = [];
  hero.effects.set("ruleFx", { id: "ruleFx", parent: hero, flags: { [MOD]: { ruleEffect: { combatId: combat.id, end: "turnEnd" } } }, async delete() { deleted.push(this.id); } });

  const refresh = wrappers.get("foundry.helpers.ActiveEffectRegistry.prototype.refresh");
  const fire = async (event, context) => { await refresh(async () => {}, event, { combat, ...context }); };
  await fire("roundStart", { round: 7 });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(prompts.length, 1, "the Routines question is open: the feature chain is blocked");

  const cbHero = [...combat.combatants].find(c => c.actor === hero) ?? combat.combatants.contents?.find(c => c.actor === hero);
  combat.combatant = cbHero; combat.previous = { combatantId: cbHero.id };
  await fire("turnStart", {}); await lifecycle.lifecycleIdle();
  await fire("turnEnd", {}); await lifecycle.lifecycleIdle();
  assert.deepEqual(seen, ["turnStart", "turnEnd"], "later listeners got both turn events while the chain is blocked");
  assert.deepEqual(deleted, [], "the queued feature turn work waits behind the open question");

  release([]);   // Routines answered: no ids = maintain current
  await featureEngineIdle();
  assert.deepEqual(deleted, ["ruleFx"], "the queued turnEnd work ran once the block cleared");
  assert.deepEqual(activePerformances(hero), [], "the round work finished first (maintain current)");
  console.log("ok lifecycle: later turn listeners run while a feature question is open; queued feature work runs after");
}
console.log("harness29 ok");
process.exit(0);
