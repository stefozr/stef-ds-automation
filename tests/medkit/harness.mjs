// Medkit harness: runs the medkit against stef-ds-automation's mocked world (its tests/harness.mjs).
// Header controls and badge hooks, the item window's context and actions, the actor window's bulk
// actions and monster key, the coverage numbers, and (0.2.0) triggers, trackers and the triggered-action line.
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

globalThis.__HARNESS_SKIP_SCENARIOS__ = true;
const paths = createRequire(import.meta.url)("./paths.cjs");
const MEDKIT = paths.SCRIPTS;
const LIBRARY = paths.LIBRARY;
const fileUrl = p => pathToFileURL(p).href;

globalThis.__HARNESS_SETUP__ = () => {
  game.modules.set("lib-wrapper", { active: true });
  globalThis.libWrapper = { register() {} };
  class ApplicationV2 {
    constructor(options = {}) { this.options = options; this.rendered = 0; }
    async render() { this.rendered++; this.context = await this._prepareContext({}); return this; }
  }
  foundry.applications = {
    api: { ApplicationV2, HandlebarsApplicationMixin: Base => class extends Base {}, DialogV2: { confirm: async () => true } },
    instances: new Map(),
  };
};

const world = await import(fileUrl(`${paths.CORE_TESTS}harness.mjs`));
const { makeAbility, hero, api } = world;
game.modules.set("stef-ds-automation", { active: true, api });

let medkitInit = null;
let medkitApi = null;
const onceOrig = Hooks.once;
Hooks.once = (name, fn) => {
  if (name === "init" && !medkitInit) medkitInit = fn;
  if (name === "dsAuto.init" && !medkitApi) medkitApi = fn;
  return onceOrig.call(Hooks, name, fn);
};
await import(pathToFileURL(`${MEDKIT}main.mjs`).href);
Hooks.once = onceOrig;
const hooks = {};
const onOrig = Hooks.on;
Hooks.on = (name, fn) => { hooks[name] = fn; return onOrig.call(Hooks, name, fn); };
const registered = [];
game.settings.registerMenu = (...a) => registered.push(a);
medkitInit();
Hooks.on = onOrig;
assert.ok(hooks.getHeaderControlsDrawSteelItemSheet && hooks.getHeaderControlsDrawSteelActorSheet && hooks.renderDrawSteelItemSheet);
assert.equal(registered.length, 1, "coverage report menu");
// Smart Automation's API is `api.smartAutomation` of the suite, set on `dsAuto.init`; `api.medkit` is its old alias.
medkitApi(api);
const medkit = api.smartAutomation;
assert.equal(api.medkit.openItem, medkit.openItem, "api.medkit alias");
assert.equal(api.medkit.ItemMedkit, medkit.ItemSmartAutomation, "old class name on the alias");
assert.equal(api.medkit.ActorMedkit, medkit.ActorSmartAutomation, "old class name on the alias");

const shipped = (await import(fileUrl(path.join(LIBRARY, "dist", "overlays.mjs")))).default;
api.library.registerSource({ id: "stef-ds-automation.library", overlays: shipped, priority: 50 });

/** An owned ability with update() (flags and our entries). */
function ownedAbility(name) {
  const item = makeAbility({ uuid: `${hero.uuid}.Item.mk${name.replace(/\W/g, "").padEnd(14, "0").slice(0, 14)}`, name, actor: hero, damage: false });
  item.system._dsid = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  item.documentName = "Item";
  item.isOwner = true;
  item.flags = {};
  item.img = "i.png";
  item._source = { system: { effects: {} } };
  item.system.effects = { contents: [], get: () => null };
  item.update = async (changes) => {
    for (const [k, v] of Object.entries(changes)) {
      const parts = k.split(".");
      if (parts[0] === "system") {
        if (v instanceof foundry.data.operators.ForcedDeletion) delete item._source.system.effects[parts[2]];
        else item._source.system.effects[parts[2]] = v;
        continue;
      }
      let o = item;
      for (const p of parts.slice(0, -1)) o = o[p] ??= {};
      if (v instanceof foundry.data.operators.ForcedDeletion) delete o[parts.at(-1)];
      else o[parts.at(-1)] = v;
    }
    item.system.effects.contents = Object.values(item._source.system.effects).map(d => ({ ...d, id: d._id }));
  };
  return item;
}

/* ---------- header controls and badge ---------- */
{
  const item = ownedAbility("Catch Breath");
  const controls = [];
  hooks.getHeaderControlsDrawSteelItemSheet({ document: item }, controls);
  assert.equal(controls.length, 1);
  assert.equal(controls[0].icon, "fa-solid fa-kit-medical");
  assert.equal(controls[0].visible(), true, "the GM may open it");
  const none = [];
  hooks.getHeaderControlsDrawSteelItemSheet({ document: { documentName: "Item", type: "class" } }, none);
  assert.equal(none.length, 0, "only abilities");
  const actorControls = [];
  hooks.getHeaderControlsDrawSteelActorSheet({ document: { documentName: "Actor" } }, actorControls);
  assert.equal(actorControls.length, 1);
  // The badge goes into the window header before the title.
  const inserted = [];
  const header = { querySelector: sel => (sel === ".window-title" ? "TITLE" : null), insertBefore: (el, ref) => inserted.push([el, ref]) };
  globalThis.document = { ...globalThis.document, createElement: () => ({ dataset: {}, setAttribute() {}, addEventListener() {}, className: "", innerHTML: "" }) };
  hooks.renderDrawSteelItemSheet({ document: item, element: { querySelector: () => header } });
  assert.equal(inserted.length, 1);
  assert.match(inserted[0][0].className, /ds-auto-status--automated/);
  assert.equal(inserted[0][1], "TITLE");
  console.log("ok header controls and badge");
}

/* ---------- item window: context and actions ---------- */
{
  const { ItemSmartAutomation: ItemMedkit } = medkit;
  const item = ownedAbility("Catch Breath");
  const app = new ItemMedkit({ item });
  let ctx = await app._prepareContext();
  assert.equal(ctx.status.id, "automated");
  assert.equal(ctx.overlay.source, "stef-ds-automation.library");
  assert.equal(ctx.effects.length, 1);
  assert.match(ctx.effects[0].what, /DSMEDKIT\.Effect\.recoveries/);
  assert.ok(ctx.canDetach && !ctx.canReset);
  await api.library.detach(item);
  ctx = await app._prepareContext();
  assert.deepEqual([ctx.status.id, ctx.canDetach, ctx.canResync, ctx.canReset], ["customized", false, true, true]);
  await api.library.lock(item, true);
  ctx = await app._prepareContext();
  assert.deepEqual([ctx.status.id, ctx.canResync, ctx.canReset, ctx.locked], ["locked", false, false, true]);
  await api.library.lock(item, false);
  await api.library.reset(item);
  await api.library.disable(item, true);
  ctx = await app._prepareContext();
  assert.equal(ctx.status.id, "disabled");
  await api.library.disable(item, false);
  const plain = ownedAbility("Nothing Here");
  ctx = await new ItemMedkit({ item: plain })._prepareContext();
  assert.deepEqual([ctx.status.id, ctx.canDetach, ctx.effects.length], ["manual", false, 0]);
  console.log("ok item window (statuses, detach / lock / reset / disable)");
}

/* ---------- actor window and coverage ---------- */
{
  const { ActorSmartAutomation: ActorMedkit } = medkit;
  const a = ownedAbility("Catch Breath");
  const b = ownedAbility("Defend");
  const c = ownedAbility("Plain Strike");
  const actor = { name: "Hero", img: "h.png", type: "hero", isOwner: true, items: [a, b, c, { type: "class" }], getFlag: () => null };
  const app = new ActorMedkit({ actor });
  const ctx = await app._prepareContext();
  assert.equal(ctx.rows.length, 3);
  assert.deepEqual(ctx.rows.map(r => r.status.id), ["automated", "automated", "manual"]);
  assert.ok(ctx.summary.some(s => s.id === "automated" && s.n === 2));
  const npc = { name: "Goblin Sniper (2)", img: "g.png", type: "npc", isOwner: true, items: [], getFlag: () => null, flags: {} };
  const nctx = await new ActorMedkit({ actor: npc })._prepareContext();
  assert.equal(nctx.monsterKey, "goblin-sniper");
  game.packs = [{ documentName: "Item", collection: "draw-steel.abilities", title: "Abilities",
    getIndex: async () => [
      { type: "ability", name: "Catch Breath", system: { _dsid: "catch-breath", power: { effects: {} } } },
      { type: "ability", name: "Strike", system: { _dsid: "strike", power: { effects: { a: { type: "damage" } } } } },
      { type: "ability", name: "Wave", system: { _dsid: "wave", power: { effects: {} } } },
      { type: "kit", name: "Kit" },
    ] }];
  const rows = await medkit.coverageData();
  assert.deepEqual([rows[0].total, rows[0].overlay, rows[0].native, rows[0].manual, rows[0].missing[0]], [3, 1, 1, 1, "Wave"]);
  console.log("ok actor window (statuses, summary, monster key) and coverage");
}
/* ---------- triggers, trackers and the triggered-action line (library 0.2.0, core 0.7.0) ---------- */
{
  const { ItemSmartAutomation: ItemMedkit, ActorSmartAutomation: ActorMedkit } = medkit;
  // Parry: a trigger-only overlay (effects: []) still counts as automated.
  const parry = ownedAbility("Parry");
  parry.system.type = "triggered";
  let ctx = await new ItemMedkit({ item: parry })._prepareContext();
  assert.equal(ctx.status.id, "automated");
  assert.equal(ctx.effects.length, 0);
  assert.equal(ctx.triggers.length, 1);
  assert.match(ctx.triggers[0].what, /DSMEDKIT\.Trigger\.Line/);
  assert.match(ctx.triggers[0].what, /DSAUTO\.Trigger\.Step\.halve/);
  assert.match(ctx.triggers[0].what, /Shift 1/, "note steps keep their text");
  assert.match(ctx.triggers[0].detail, /DSMEDKIT\.Trigger\.Budget/);
  assert.match(ctx.triggers[0].detail, /DSMEDKIT\.Trigger\.Spend/);
  // Detach: no entries, and the stamp keeps the triggers when the library is gone.
  assert.equal(await api.library.detach(parry), 0);
  assert.equal(parry.flags["stef-ds-automation"].overlay.triggers.length, 1);
  api.library.unregisterSource("stef-ds-automation.library");
  const r = api.library.resolve(parry);
  assert.deepEqual([r.layer, r.triggers.length, r.triggers[0].subject], ["detached", 1, "selfOrAlly"]);
  api.library.registerSource({ id: "stef-ds-automation.library", overlays: shipped, priority: 50 });
  await api.library.reset(parry);
  // Hesitation is Weakness: free triggered with a cost of 1.
  const hiw = ownedAbility("Hesitation is Weakness");
  hiw.system.type = "freeTriggered";
  hiw.system.resource = 1;
  ctx = await new ItemMedkit({ item: hiw })._prepareContext();
  assert.match(ctx.triggers[0].detail, /DSMEDKIT\.Trigger\.Free/);
  assert.match(ctx.triggers[0].detail, /DSMEDKIT\.Trigger\.Cost/);
  // Mark: a tracker that ends when its source is dying.
  ctx = await new ItemMedkit({ item: ownedAbility("Mark") })._prepareContext();
  assert.deepEqual([ctx.triggers.length, ctx.trackers.length], [0, 1]);
  assert.match(ctx.trackers[0].what, /DSMEDKIT\.Trigger\.Tracker/);
  assert.match(ctx.trackers[0].detail, /DSMEDKIT\.Trigger\.EndsOnDying/);
  // The triggered-action line: hidden without api.triggers, else available / used / not tracked.
  const actor = { name: "Hero", img: "h.png", type: "hero", isOwner: true, items: [], getFlag: () => null };
  const saved = api.triggers;
  try {
    api.triggers = undefined;
    assert.equal((await new ActorMedkit({ actor })._prepareContext()).budget, null);
    const states = [
      [{ tracked: false }, /BudgetUntracked/],
      [{ tracked: true, available: true }, /BudgetAvailable/],
      [{ tracked: true, available: false, usedAbility: "Parry" }, /BudgetUsed.*Parry/],
    ];
    for (const [state, re] of states) {
      api.triggers = { ...(saved ?? {}), budget: () => state };
      assert.match((await new ActorMedkit({ actor })._prepareContext()).budget, re);
    }
    api.triggers = { budget: () => { throw new Error("boom"); } };
    assert.equal((await new ActorMedkit({ actor })._prepareContext()).budget, null, "an API error hides the line");
  } finally {
    api.triggers = saved;
  }
  console.log("ok triggers / trackers in the item window, detach stamp, triggered-action line");
}
/* ---------- summons (library 0.3.0, core 0.8.0) ---------- */
{
  const { ItemSmartAutomation: ItemMedkit, ActorSmartAutomation: ActorMedkit } = medkit;
  // Summon Source of Earth: one summon line, the stat block named from the pack index, no "the user" bit.
  const savedPacks = game.packs;
  game.packs = new Map([["draw-steel.monsters", { index: new Map([["o7qp5KCUuRgfCko6", { name: "Source of Earth" }]]) }]]);
  try {
    const soe = ownedAbility("Summon Source of Earth");
    const ctx = await new ItemMedkit({ item: soe })._prepareContext();
    assert.equal(ctx.status.id, "automated");
    assert.equal(ctx.effects.length, 1);
    assert.equal(ctx.effects[0].type, "summon");
    assert.match(ctx.effects[0].what, /DSMEDKIT\.Effect\.summon/);
    assert.match(ctx.effects[0].what, /Source of Earth/, "named from the pack index");
    assert.match(ctx.effects[0].detail, /^DSMEDKIT\.Effect\.summonTurn_after/, "the turn first, no target bit");
    assert.doesNotMatch(ctx.effects[0].detail, /toSelf/);
    assert.match(ctx.effects[0].detail, /DSMEDKIT\.Summon\.Lasts\.summonerTurnStart/);
    // Without the pack index the uuid's id stands in.
    game.packs = undefined;
    const bare = await new ItemMedkit({ item: soe })._prepareContext();
    assert.match(bare.effects[0].what, /o7qp5KCUuRgfCko6/);
  } finally {
    game.packs = savedPacks;
  }
  // The actor window's Summons fieldset: hidden without api.summons, else one line per summon with Dismiss.
  const actor = { name: "Borin", img: "b.png", type: "hero", isOwner: true, items: [], getFlag: () => null };
  const saved = api.summons;
  const savedScenes = game.scenes;
  try {
    api.summons = undefined;
    let ctx = await new ActorMedkit({ actor })._prepareContext();
    assert.deepEqual([ctx.summonsApi, ctx.summons], [false, null]);
    const dismissed = [];
    game.scenes = new Map([["scene1", { name: "Start" }]]);
    api.summons = {
      of: a => (a === actor ? [{ summonId: "sum1", names: ["Source of Earth"], sceneId: "scene1", lasts: ["summonerTurnStart", "encounterEnd"] }] : []),
      dismiss: async id => { dismissed.push(id); return { ok: true, removed: 1 }; },
    };
    const app = new ActorMedkit({ actor });
    ctx = await app._prepareContext();
    assert.equal(ctx.summonsApi, true);
    assert.equal(ctx.canDismiss, true);
    assert.equal(ctx.summons.length, 1);
    assert.match(ctx.summons[0].line, /DSMEDKIT\.Summons\.Line.*Source of Earth.*Start/);
    assert.match(ctx.summons[0].lasts, /DSMEDKIT\.Summon\.Lasts\.encounterEnd/);
    const target = { disabled: false, closest: () => ({ dataset: { summonId: "sum1" } }) };
    await ActorMedkit.DEFAULT_OPTIONS.actions.dismissSummon.call(app, {}, target);
    assert.deepEqual(dismissed, ["sum1"]);
    api.summons = { of: () => { throw new Error("boom"); } };
    assert.equal((await new ActorMedkit({ actor })._prepareContext()).summons, null, "an API error hides the fieldset");
  } finally {
    api.summons = saved;
    game.scenes = savedScenes;
  }
  console.log("ok summons: the item window's summon line and the actor window's Summons with Dismiss");
}
/* ---------- resource gains, areas, villain actions (library 0.4.0, core 0.9.0) ---------- */
{
  const { ItemSmartAutomation: ItemMedkit, ActorSmartAutomation: ActorMedkit } = medkit;
  const feature = (name, dsid) => ({
    uuid: `${hero.uuid}.Item.ft${dsid.replace(/\W/g, "").padEnd(14, "0").slice(0, 14)}`, name, img: "f.png", documentName: "Item", type: "feature",
    system: { _dsid: dsid }, actor: hero, flags: {}, isOwner: true,
  });
  const ferocity = feature("Ferocity", "ferocity");
  const crafty = feature("Crafty", "crafty");
  // Header control and badge: a feature with gains gets them, a feature without gains does not.
  const controls = [];
  hooks.getHeaderControlsDrawSteelItemSheet({ document: ferocity }, controls);
  assert.equal(controls.length, 1, "a feature with gains gets the control");
  const none = [];
  hooks.getHeaderControlsDrawSteelItemSheet({ document: crafty }, none);
  assert.equal(none.length, 1, "a feature without gains gets authoring controls");
  const inserted = [];
  const header = { querySelector: sel => (sel === ".window-title" ? "TITLE" : null), insertBefore: (el, ref) => inserted.push([el, ref]) };
  hooks.renderDrawSteelItemSheet({ document: ferocity, element: { querySelector: () => header } });
  hooks.renderDrawSteelItemSheet({ document: crafty, element: { querySelector: () => header } });
  assert.equal(inserted.length, 2, "coverage badges on both features");
  // The feature window: the gains only, no ability layers; Disable / Enable work on it.
  let ctx = await new ItemMedkit({ item: ferocity })._prepareContext();
  assert.equal(ctx.feature, true);
  assert.equal(ctx.status.id, "automated");
  assert.equal(ctx.gains.length, 2);
  assert.match(ctx.gains[0].what, /DSMEDKIT\.Gain\.Line/);
  assert.match(ctx.gains[0].what, /First damage taken this round/);
  assert.match(ctx.gains[0].detail, /damaging-ferocity \+2/, "upgrades listed");
  assert.equal(ctx.native, undefined, "no ability layers");
  ferocity.flags = { "stef-ds-automation": { disabled: true } };
  ctx = await new ItemMedkit({ item: ferocity })._prepareContext();
  assert.deepEqual([ctx.status.id, ctx.disabled], ["disabled", true]);
  ferocity.flags = {};
  // An ability without an overlay is unchanged.
  ctx = await new ItemMedkit({ item: ownedAbility("Nothing Here") })._prepareContext();
  assert.deepEqual([ctx.feature, ctx.status.id], [undefined, "manual"]);
  // The zone line of an area ability (Wall of Fire): label, events, side and end in the core's words.
  ctx = await new ItemMedkit({ item: ownedAbility("Wall of Fire") })._prepareContext();
  assert.equal(ctx.effects.length, 1);
  assert.match(ctx.effects[0].what, /DSMEDKIT\.Effect\.zone/);
  assert.match(ctx.effects[0].what, /Wall of fire/);
  assert.match(ctx.effects[0].what, /DSAUTO\.Entry\.ZoneEvent\.enter/);
  assert.match(ctx.effects[0].what, /DSAUTO\.Zone\.Affects\.enemies/);
  assert.match(ctx.effects[0].what, /DSAUTO\.Zone\.Lasts\.summonerTurnStart/);
  assert.doesNotMatch(ctx.effects[0].detail, /toSelf/);
  // The actor window: Resource gains (heroes), Areas (everyone), Villain actions (NPCs); hidden without the API.
  const actor = { name: "Borin", img: "b.png", type: "hero", uuid: "Actor.borin000000000", isOwner: true, items: [], getFlag: () => null };
  const npc = { name: "Mystic Queen Bargnot", img: "q.png", type: "npc", uuid: "Actor.bargnot00000000", isOwner: true, items: [], getFlag: () => null, flags: {} };
  const saved = { resources: api.resources, zones: api.zones, villain: api.villain };
  const calls = [];
  try {
    for (const k of ["resources", "zones", "villain"]) api[k] = undefined;
    ctx = await new ActorMedkit({ actor })._prepareContext();
    assert.deepEqual([ctx.gains, ctx.zones, ctx.villain], [null, null, null], "no M7 sections without the core's API");
    api.resources = {
      rules: a => (a === actor ? [{ featureKey: "feature:ferocity", ruleKey: "ferocity:took-damage", rule: { id: "took-damage", event: "damage", label: "First damage taken this round", once: "round", resource: "heroic", amount: 1 }, amount: 3, formula: null },
        { featureKey: "feature:ferocity", ruleKey: "ferocity:winded-or-dying", rule: { id: "winded-or-dying", event: "winded", label: "Winded", once: "encounter", resource: "heroic", amount: "1d3" }, amount: null, formula: "1d3" }] : []),
      ledger: () => ({ round: { "ferocity:took-damage": { at: 1 } }, encounter: { "ferocity:winded-or-dying": { at: 2 } } }),
      release: async (a, ruleKey, opts) => { calls.push(["release", a, ruleKey, opts]); return true; },
    };
    api.zones = {
      list: f => (f.creatorActorUuid === actor.uuid ? [{ zoneId: "zone0000000000z1", label: "Wall of fire", lasts: ["summonerTurnStart"] }] : []),
      dismiss: async id => { calls.push(["dismiss", id]); return { ok: true, ended: true }; },
    };
    api.villain = {
      used: a => (a === npc ? [{ dsid: "oversurge", name: "Oversurge", round: 2, messageId: "m" }] : []),
      reset: async a => { calls.push(["reset", a]); return true; },
    };
    const app = new ActorMedkit({ actor });
    ctx = await app._prepareContext();
    assert.equal(ctx.gains.length, 2);
    assert.match(ctx.gains[0].what, /"amount":3/, "the hero's upgraded amount");
    assert.match(ctx.gains[1].what, /"amount":"1d3"/);
    assert.equal(ctx.gains[0].used, "DSMEDKIT.Gain.Used");
    assert.deepEqual([ctx.gains[1].used, ctx.gains[1].encounter], ["DSMEDKIT.Gain.UsedEncounter", true]);
    assert.equal(ctx.zones.length, 1);
    assert.match(ctx.zones[0].line, /DSMEDKIT\.Zones\.Line.*Wall of fire.*DSAUTO\.Zone\.Lasts\.summonerTurnStart/);
    assert.equal(ctx.villain, null, "no villain section for a hero");
    const row = { dataset: { ruleKey: "ferocity:winded-or-dying", encounter: "true" } };
    await ActorMedkit.DEFAULT_OPTIONS.actions.releaseGain.call(app, {}, { disabled: false, closest: () => row });
    await ActorMedkit.DEFAULT_OPTIONS.actions.dismissZone.call(app, {}, { disabled: false, closest: () => ({ dataset: { zoneId: "zone0000000000z1" } }) });
    const napp = new ActorMedkit({ actor: npc });
    const nctx = await napp._prepareContext();
    assert.equal(nctx.gains, null, "no gains for an NPC");
    assert.equal(nctx.zones, null, "an empty areas list is hidden");
    assert.match(nctx.villain[0].line, /DSMEDKIT\.Villain\.Line.*Oversurge.*2/);
    await ActorMedkit.DEFAULT_OPTIONS.actions.resetVillain.call(napp, {}, { disabled: false });
    assert.deepEqual(calls, [["release", actor, "ferocity:winded-or-dying", { encounter: true }], ["dismiss", "zone0000000000z1"], ["reset", npc]]);
    // A refusal from the core is localized, never thrown at the user.
    const warned = [];
    const savedUi = globalThis.ui;
    globalThis.ui = { ...(savedUi ?? {}), notifications: { warn: m => warned.push(m), info() {}, error() {} } };
    api.zones.dismiss = async () => { throw new Error("DSAUTO.Relay.Denied"); };
    await ActorMedkit.DEFAULT_OPTIONS.actions.dismissZone.call(app, {}, { disabled: false, closest: () => ({ dataset: { zoneId: "zone0000000000z1" } }) });
    globalThis.ui = savedUi;
    assert.deepEqual(warned, ["DSAUTO.Relay.Denied"]);
    api.resources = { rules: () => { throw new Error("boom"); } };
    assert.equal((await new ActorMedkit({ actor })._prepareContext()).gains, null, "an API error hides the section");
  } finally {
    Object.assign(api, saved);
  }
  console.log("ok resource gains (feature control, badge, window), the area line, the actor window's gains / areas / villain actions");
}
/* ---------- 0.5.0: Maintenance entries in core 0.10.0's settings window ---------- */
{
  // Registered only through the core's hook: with a 0.9.x core (no settings window, the hook never fires) there are
  // no entries and the coverage report stays the medkit's own settings menu (asserted at init: one registerMenu).
  assert.equal(typeof hooks["dsAuto.settingsMenu"], "function", "the medkit listens to dsAuto.settingsMenu");
  const entries = [];
  const registry = { addMaintenance: e => entries.push(e) };
  assert.equal(entries.length, 0, "nothing before the core fires the hook");
  Hooks.callAll("dsAuto.settingsMenu", { notARegistry: true });
  assert.equal(entries.length, 0, "a registry without addMaintenance is ignored");
  Hooks.callAll("dsAuto.settingsMenu", registry);
  assert.deepEqual(entries.map(e => e.id), ["stef-ds-automation.coverage", "stef-ds-automation.customized"]);
  for (const e of entries) {
    assert.match(e.label, /^DSMEDKIT\.Maintenance\./);
    assert.match(e.hint, /^DSMEDKIT\.Maintenance\..*Hint$/);
    assert.equal(typeof e.run, "function");
    assert.match(e.icon, /^fa-solid /);
  }
  // Coverage: opens the report.
  const report = await entries[0].run();
  assert.ok(report instanceof medkit.CoverageReport && report.rendered === 1, "the coverage report rendered");
  // Customized: a notice when nothing is customized, a list dialog otherwise.
  const infos = [];
  const prompts = [];
  const savedUi = globalThis.ui;
  const savedItems = game.items;
  const savedActors = game.actors;
  const savedPrompt = foundry.applications.api.DialogV2.prompt;
  globalThis.ui = { ...(savedUi ?? {}), notifications: { info: m => infos.push(m), warn() {}, error() {} } };
  foundry.applications.api.DialogV2.prompt = async opts => { prompts.push(opts); return true; };
  try {
    const plain = ownedAbility("Catch Breath");
    const detached = ownedAbility("Catch Breath");
    detached.uuid = `${hero.uuid}.Item.mkDetached000000`;
    detached.name = "Catch Breath <b>";
    const owner = { name: "Hero One", items: [plain, detached] };
    game.items = [];
    game.actors = [owner];
    assert.deepEqual(await entries[1].run(), []);
    assert.deepEqual(infos, ["DSMEDKIT.Maintenance.customizedNone"]);
    assert.equal(prompts.length, 0);
    await api.library.detach(detached);
    const list = await entries[1].run();
    assert.deepEqual(list.map(e => [e.uuid, e.actor, e.status]), [[detached.uuid, "Hero One", "customized"]]);
    assert.deepEqual(medkit.customizedItems().map(e => e.uuid), [detached.uuid], "api.customizedItems");
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].window.title, "DSMEDKIT.Maintenance.customized");
    assert.ok(prompts[0].content.includes(`data-uuid="${detached.uuid}"`) && prompts[0].content.includes("Hero One: "));
    assert.ok(prompts[0].content.includes("Catch Breath &lt;b&gt;") && !prompts[0].content.includes("<b>"), "names escaped");
    assert.ok(!prompts[0].content.includes(plain.uuid), "an automated item is not listed");
    // Without the core's library API the list is empty (no throw).
    game.modules.set("stef-ds-automation", { active: true, api: {} });
    assert.deepEqual(medkit.customizedItems(), []);
  } finally {
    game.modules.set("stef-ds-automation", { active: true, api });
    globalThis.ui = savedUi;
    game.items = savedItems;
    game.actors = savedActors;
    foundry.applications.api.DialogV2.prompt = savedPrompt;
  }
  console.log("ok maintenance entries (dsAuto.settingsMenu: coverage report, customized items; none without the hook)");
}
{
  const { AutomationEditor } = await import(fileUrl(`${MEDKIT}automation-editor.mjs`));
  const homebrew = ownedAbility("Homebrew performance");
  homebrew.flags = { "stef-ds-automation": { automation: { version: 1, performance: true, rules: [{ id: "benefit", event: "turn.start", targets: "aura", effects: [{ id: "perk", type: "modifier", key: "benefit:takeTwo", value: "0" }] }] } } };
  const editor = new AutomationEditor({ item: homebrew });
  const context = editor._prepareContext();
  assert.equal(context.performance, true);
  assert.ok(context.rules[0].effects[0].fields.find(f => f.key === "key").choices.some(c => c.value === "benefit:takeTwo" && c.selected), "opening a performance preserves its modifier selection");
  editor.draft.rules[0].effects[0].value = "9";
  assert.equal(homebrew.flags["stef-ds-automation"].automation.rules[0].effects[0].value, "0", "editing a draft does not mutate the item");
  console.log("ok generic editor draft isolation and performance modifier selection");
}
console.log("\nALL MEDKIT TESTS PASSED");
