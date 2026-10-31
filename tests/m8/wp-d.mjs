// M8 WP-D scenarios (docs/M8-DESIGN.md §12.1 H26-H31): settings registration and migration, the settings window,
// api.stripParts, api.cleanup, the public API changes and the i18n checks. Run: `node harness11.mjs wp-d`.
// Extra mocks (installed here, removed again at the end): a recording game.settings.register / registerMenu,
// foundry.data.fields defaults, a HandlebarsApplicationMixin(ApplicationV2) stub, DialogV2.confirm, SettingsConfig
// reloadConfirm, ChatMessage.updateDocuments / deleteDocuments recording batches, a progress notification handle, and
// swapped game.messages / actors / items / folders / scenes collections for the maintenance passes.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS = fileURLToPath(new URL("../", import.meta.url));

export default async function (ctx) {
  const { mocks, assert, log, asUser: as } = ctx;
  const { imp, gm, gm2, player, Coll, settleAll, setActiveGM } = mocks;
  const settingsMod = await imp("settings.mjs");
  const menuMod = await imp("ui/settings-menu.mjs");
  const stripMod = await imp("maintenance/strip.mjs");
  const cleanupMod = await imp("maintenance/cleanup.mjs");
  const { HOOKS, MODULE_ID, UNTIL_EXPIRY } = await imp("constants.mjs");
  const { LEDGER_VERSION } = await imp("engine/ledger.mjs");
  const api = game.modules.get(MODULE_ID).api;
  const { SETTING_KEYS, MENU_TABS, MENU_KEYS, PLAIN_KEYS, ACTOR_TYPE_CATEGORIES, ACTOR_TYPE_MODES, tabKeys, definitionOf, defaultOf, setting } = settingsMod;
  const set = (k, v) => game.settings.set(MODULE_ID, k, v);
  /** The H27 window, reused by H28 (Prepare to uninstall). */
  let winState = null;

  // Snapshot of every setting of ours (restored at the end; fresh() only resets the harness's own list).
  const snapshot = Object.fromEntries(SETTING_KEYS.map(k => [k, JSON.parse(JSON.stringify(setting(k) ?? null))]));
  const restoreSettings = async () => { for (const [k, v] of Object.entries(snapshot)) await set(k, v); };
  // Extra globals; every one is put back at the end.
  const saved = {
    register: game.settings.register, registerMenu: game.settings.registerMenu, fields: foundry.data.fields,
    applications: foundry.applications, expandObject: foundry.utils.expandObject,
    messages: game.messages, actors: game.actors, items: game.items, folders: game.folders, scenes: game.scenes,
    info: ui.notifications.info, warnFn: console.warn,
  };
  const restoreGlobals = () => {
    game.settings.register = saved.register;
    if (saved.registerMenu) game.settings.registerMenu = saved.registerMenu; else delete game.settings.registerMenu;
    foundry.data.fields = saved.fields;
    foundry.applications = saved.applications;
    if (saved.expandObject) foundry.utils.expandObject = saved.expandObject; else delete foundry.utils.expandObject;
    game.messages = saved.messages;
    game.actors = saved.actors;
    game.items = saved.items;
    game.folders = saved.folders;
    game.scenes = saved.scenes;
    ui.notifications.info = saved.info;
    console.warn = saved.warnFn;
    delete ChatMessage.updateDocuments;
    delete ChatMessage.deleteDocuments;
  };
  foundry.utils.expandObject ??= (flat) => {
    const out = {};
    for (const [k, v] of Object.entries(flat ?? {})) foundry.utils.setProperty(out, k, v);
    return out;
  };

  try {
    /* ======================================================================== */
    /*  H26: settings registration, tabs, migration                              */
    /* ======================================================================== */
    {
      const calls = [];
      game.settings.register = (mod, key, cfg) => calls.push({ mod, key, cfg });
      settingsMod.registerSettings();
      game.settings.register = saved.register;
      const byKey = Object.fromEntries(calls.map(c => [c.key, c.cfg]));
      assert.deepEqual(Object.keys(byKey).sort(), [...SETTING_KEYS].sort(), "every definition registered");
      for (const [key, cfg] of Object.entries(byKey)) {
        const def = definitionOf(key);
        assert.ok(!("menu" in cfg) && !("hidden" in cfg) && !("typeFactory" in cfg) && !("cellChoices" in cfg), `${key}: local keys stripped`);
        if (def.hidden) {
          assert.ok(!cfg.name && !cfg.hint && cfg.config === false, `${key}: hidden, no name/hint`);
        } else {
          assert.equal(cfg.name, `DSAUTO.Settings.${key}.name`, `${key} name`);
          assert.equal(cfg.hint, `DSAUTO.Settings.${key}.hint`, `${key} hint`);
          assert.equal(cfg.config, PLAIN_KEYS.includes(key), `${key}: config ${PLAIN_KEYS.includes(key)}`);
        }
      }
      for (const k of ["enabled", "promptDialog", "debug"]) assert.equal(byKey[k].config, true, `${k} stays in the plain list`);
      for (const k of ["ledger", "heroOverride"]) assert.ok(definitionOf(k).hidden, `${k} hidden`);
      // Each shown key in exactly one tab or in the plain list.
      const tabIds = MENU_TABS.map(t => t.id);
      assert.equal(tabIds.length, 12, "12 tabs");
      const seen = new Map();
      for (const t of tabIds) for (const k of tabKeys(t)) seen.set(k, [...(seen.get(k) ?? []), t]);
      for (const k of SETTING_KEYS) {
        if (definitionOf(k).hidden) continue;
        const n = (seen.get(k)?.length ?? 0) + (PLAIN_KEYS.includes(k) ? 1 : 0);
        assert.equal(n, 1, `${k} in exactly one place`);
      }
      assert.deepEqual([...MENU_KEYS].sort(), SETTING_KEYS.filter(k => !definitionOf(k).hidden && !PLAIN_KEYS.includes(k)).sort());
      for (const k of ["summonInterceptNative", "frightenedMoveWarning", "modeByActorType"]) assert.ok(MENU_KEYS.includes(k), `${k} in the window`);
      assert.deepEqual(Object.keys(definitionOf("targetedConditions").choices), ["auto", "native", "off"]);
      // modeByActorType: a SchemaField of six choice fields when Foundry's fields exist; the default validates.
      const type = byKey.modeByActorType.type;
      assert.ok(type?.fields, "a SchemaField with harness fields");
      assert.deepEqual(Object.keys(type.fields), [...ACTOR_TYPE_CATEGORIES]);
      for (const c of ACTOR_TYPE_CATEGORIES) {
        assert.deepEqual(type.fields[c].options.choices, [...ACTOR_TYPE_MODES], `${c} choices`);
        assert.ok(ACTOR_TYPE_MODES.includes(byKey.modeByActorType.default[c]), `${c} default valid`);
      }
      assert.deepEqual(byKey.modeByActorType.default, Object.fromEntries(ACTOR_TYPE_CATEGORIES.map(c => [c, "inherit"])));
      // Without Foundry's fields: a plain Object type.
      foundry.data.fields = undefined;
      calls.length = 0;
      game.settings.register = (mod, key, cfg) => calls.push({ key, cfg });
      settingsMod.registerSettings();
      game.settings.register = saved.register;
      foundry.data.fields = saved.fields;
      assert.equal(calls.find(c => c.key === "modeByActorType").cfg.type, Object, "Object without fields");
      // registerMenu: restricted, only with a window class and the API.
      delete game.settings.registerMenu;
      assert.equal(settingsMod.registerSettingsMenu(class {}), false, "no registerMenu: nothing");
      const menus = [];
      game.settings.registerMenu = (mod, key, data) => menus.push({ mod, key, data });
      assert.equal(settingsMod.registerSettingsMenu(null), false, "no class: nothing");
      class FakeMenu {}
      assert.equal(settingsMod.registerSettingsMenu(FakeMenu), true);
      assert.equal(menus.length, 1);
      assert.deepEqual([menus[0].mod, menus[0].key, menus[0].data.restricted, menus[0].data.type], [MODULE_ID, "config", true, FakeMenu]);
      assert.equal(menus[0].data.name, "DSAUTO.Menu.name");

      // Migration: heroOverride -> modeByActorType.hero once, active GM only, idempotent.
      await set("modeByActorType", defaultOf("modeByActorType"));
      await set("heroOverride", "manual");
      assert.equal(await as(gm2, () => settingsMod.migrateModes()), false, "not the active GM");
      assert.equal(await as(player, () => settingsMod.migrateModes()), false, "a player");
      assert.equal(setting("modeByActorType").hero, "inherit");
      assert.equal(await as(gm, () => settingsMod.migrateModes()), true, "migrated");
      assert.equal(setting("modeByActorType").hero, "manual");
      assert.equal(setting("heroOverride"), "manual", "heroOverride kept as the fallback");
      const writes = log.settingsSets.length;
      assert.equal(await as(gm, () => settingsMod.migrateModes()), false, "second call: nothing");
      assert.equal(log.settingsSets.length, writes, "no second write");
      await set("modeByActorType", { ...defaultOf("modeByActorType"), hero: "prompt" });
      assert.equal(await as(gm, () => settingsMod.migrateModes()), false, "hero already set: kept");
      assert.equal(setting("modeByActorType").hero, "prompt");
      await set("heroOverride", "inherit");
      await set("modeByActorType", defaultOf("modeByActorType"));
      assert.equal(await as(gm, () => settingsMod.migrateModes()), false, "nothing to migrate");
      console.log("ok H26 settings: name/hint unless hidden, menu keys config false, one place per key, modeByActorType field and default, registerMenu, heroOverride migration once");
    }

    /* ======================================================================== */
    /*  H27: the settings window                                                 */
    /* ======================================================================== */
    {
      const confirms = [];
      let confirmAnswer = false;
      const reloads = [];
      class ApplicationV2 {
        static DEFAULT_OPTIONS = {};
        static TABS = {};
        constructor() {
          this.tabGroups = Object.fromEntries(Object.entries(this.constructor.TABS).map(([g, c]) => [g, c.initial]));
          this.renders = 0;
          this.element = null;
        }
        async _prepareContext() {
          const [group, cfg] = Object.entries(this.constructor.TABS)[0] ?? [];
          if (!group) return {};
          return { rootId: "app-1", tabs: Object.fromEntries(cfg.tabs.map(t => [t.id, { ...t, group, label: `${cfg.labelPrefix}.${t.id}`, active: this.tabGroups[group] === t.id }])) };
        }
        render() { this.renders++; return this; }
      }
      const HandlebarsApplicationMixin = Base => class extends Base {};
      foundry.applications = {
        ...saved.applications,
        api: {
          ...saved.applications.api, ApplicationV2, HandlebarsApplicationMixin,
          DialogV2: { ...saved.applications.api.DialogV2, confirm: async (cfg) => { confirms.push(cfg); return confirmAnswer; } },
        },
        settings: { SettingsConfig: { reloadConfirm: async (opts) => { reloads.push(opts); } } },
      };
      const Cls = menuMod.automationSettingsClass();
      assert.ok(Cls, "class built once ApplicationV2 exists");
      assert.equal(menuMod.automationSettingsClass(), Cls, "built once");
      assert.equal(Cls.DEFAULT_OPTIONS.tag, "form");
      assert.equal(Cls.DEFAULT_OPTIONS.form.closeOnSubmit, false);
      for (const a of ["resetTab", "resetAll", "runSelfCheck", "stripDry", "stripRun", "cleanupDry", "maintenanceEntry"]) {
        assert.equal(typeof Cls.DEFAULT_OPTIONS.actions[a], "function", `action ${a}`);
      }
      assert.deepEqual(Object.keys(Cls.PARTS), ["tabs", "body", "footer"]);
      assert.ok(Cls.PARTS.body.templates.includes(menuMod.TEMPLATE_MAINTENANCE));

      // A maintenance entry from another module (the medkit's pattern).
      const runs = [];
      const onMenu = registry => {
        registry.addMaintenance({ id: "medkit.coverage", label: "DSMEDKIT.Maintenance.coverage", hint: "DSMEDKIT.Maintenance.coverageHint", icon: "fa-solid fa-table", run: () => runs.push("coverage") });
        registry.addMaintenance({ id: "bad" });                       // refused: no label, no run
        registry.addMaintenance({ id: "boom", label: "X.y", run: () => { throw new Error("DSAUTO.Relay.Denied"); } });
      };
      Hooks.on(HOOKS.settingsMenu, onMenu);
      const app = new Cls();
      const context = await app._prepareContext({});
      assert.equal(context.sections.length, 12, "12 tabs with fields");
      assert.equal(Object.keys(context.tabs).length, 12);
      assert.equal(context.sections.find(s => s.active).id, "general");
      for (const s of context.sections) {
        assert.equal(s.label, `DSAUTO.Menu.Tab.${s.id}`);
        assert.equal(s.fields.length, tabKeys(s.id).length, `${s.id} fields`);
      }
      const modes = context.sections.find(s => s.id === "modes");
      const grid = modes.fields.find(f => f.grid);
      assert.equal(grid.key, "modeByActorType");
      assert.deepEqual(grid.cells.map(c => c.name), ACTOR_TYPE_CATEGORIES.map(c => `modeByActorType.${c}`));
      const damage = modes.fields.find(f => f.key === "damageMode");
      assert.equal(damage.field.name, "damageMode");
      assert.equal(damage.field.options.choices, definitionOf("damageMode").choices);
      assert.ok(damage.field instanceof foundry.data.fields.StringField);
      assert.ok(context.sections.find(s => s.id === "general").fields.find(f => f.key === "sweepWindowMinutes").field instanceof foundry.data.fields.NumberField);
      // Triggers are off in this harness: the tab's other fields are greyed, the switch is not.
      const trig = context.sections.find(s => s.id === "triggers").fields;
      assert.equal(trig.find(f => f.key === "triggersEnabled").disabled, false);
      assert.ok(trig.filter(f => f.key !== "triggersEnabled").every(f => f.disabled), "greyed while triggers are off");
      const compatSection = context.sections.find(s => s.id === "compat");
      assert.ok(compatSection.compat.info.length === 3 && compatSection.compat.modules.some(m => m.id === "draw-steel-combat-tools"));
      const maint = context.sections.find(s => s.id === "maintenance");
      assert.equal(maint.resettable, false);
      assert.deepEqual(maint.maintenance.entries.map(e => e.id), ["medkit.coverage", "boom"], "valid entries only");
      assert.ok(!("run" in maint.maintenance.entries[0]), "run not in the template context");
      await Cls.DEFAULT_OPTIONS.actions.maintenanceEntry.call(app, {}, { dataset: { entryId: "medkit.coverage" } });
      assert.deepEqual(runs, ["coverage"], "the entry ran");
      const warnsBefore = mocks.world?.notifications?.length ?? 0;
      await Cls.DEFAULT_OPTIONS.actions.maintenanceEntry.call(app, {}, { dataset: { entryId: "boom" } });   // error -> warning, no throw
      void warnsBefore;
      Hooks.off(HOOKS.settingsMenu, onMenu);

      // Submit: only changed keys are saved; invalid values ignored; numbers and booleans coerced.
      const before = log.settingsSets.length;
      const r1 = await menuMod.saveSettings({
        damageMode: "prompt", healingMode: setting("healingMode"), conditionsMode: "nonsense", sweepWindowMinutes: "30",
        potencyGate: false, enabled: false, ledger: { v: 9, h: {} },
        modeByActorType: { npc: "prompt", hero: "bogus" },
      });
      assert.deepEqual(r1.changed.sort(), ["damageMode", "modeByActorType", "potencyGate", "sweepWindowMinutes"].sort());
      assert.equal(r1.reload, false);
      assert.deepEqual(log.settingsSets.slice(before).map(s => s.key).sort(), r1.changed.map(k => `${MODULE_ID}.${k}`).sort(), "one write per changed key");
      assert.equal(setting("sweepWindowMinutes"), 30);
      assert.equal(setting("potencyGate"), false);
      assert.equal(setting("enabled"), true, "plain-list keys are not the window's");
      assert.equal(setting("conditionsMode"), "auto", "invalid choice ignored");
      assert.deepEqual(setting("modeByActorType"), { ...defaultOf("modeByActorType"), npc: "prompt" }, "invalid cell keeps its value");
      assert.equal((await menuMod.saveSettings({ sweepWindowMinutes: 9999 })).changed[0], "sweepWindowMinutes");
      assert.equal(setting("sweepWindowMinutes"), 240, "clamped into its range");
      // A changed requiresReload setting -> the reload prompt (through the form handler).
      await Cls.DEFAULT_OPTIONS.form.handler.call(app, {}, null, { object: { systemFixes: !setting("systemFixes") } });
      assert.equal(reloads.length, 1, "reload prompt");
      assert.deepEqual(reloads[0], { world: true });
      await Cls.DEFAULT_OPTIONS.form.handler.call(app, {}, null, { object: { "modeByActorType.minion": "manual" } });
      assert.equal(setting("modeByActorType").minion, "manual", "grid cells through expandObject");
      assert.equal(reloads.length, 1, "no reload for a plain setting");
      // A hero cell set back to "inherit" clears the legacy fallback too.
      await set("heroOverride", "manual");
      assert.equal(menuMod.effectiveTypeModes().hero, "manual", "the grid shows the fallback");
      await menuMod.saveSettings({ modeByActorType: { ...setting("modeByActorType"), hero: "inherit" } });
      assert.equal(setting("heroOverride"), "inherit");

      // Reset tab: declined -> nothing; accepted -> that tab's keys only.
      const general = setting("sweepWindowMinutes");
      confirmAnswer = false;
      const w0 = log.settingsSets.length;
      await Cls.DEFAULT_OPTIONS.actions.resetTab.call(app, {}, { dataset: { section: "modes" } });
      assert.equal(log.settingsSets.length, w0, "declined: no write");
      assert.equal(confirms.length, 1);
      assert.match(String(confirms[0].content), /DSAUTO\.Menu\.ResetConfirm/);
      confirmAnswer = true;
      await Cls.DEFAULT_OPTIONS.actions.resetTab.call(app, {}, { dataset: { section: "modes" } });
      assert.equal(setting("damageMode"), "auto");
      assert.deepEqual(setting("modeByActorType"), defaultOf("modeByActorType"));
      assert.equal(setting("sweepWindowMinutes"), general, "other tabs untouched");
      const w1 = log.settingsSets.length;
      await Cls.DEFAULT_OPTIONS.actions.resetTab.call(app, {}, { dataset: { section: "modes" } });
      assert.equal(log.settingsSets.length, w1, "nothing left to reset: no dialog, no write");
      // Reset all (systemFixes is requiresReload: prompt again when it changes).
      await Cls.DEFAULT_OPTIONS.actions.resetAll.call(app, {}, {});
      assert.equal(setting("sweepWindowMinutes"), defaultOf("sweepWindowMinutes"));
      assert.equal(setting("potencyGate"), true);
      assert.equal(setting("systemFixes"), defaultOf("systemFixes"));
      assert.equal(reloads.length, 2, "reset of systemFixes prompts a reload");
      // Self-check into the maintenance view.
      await Cls.DEFAULT_OPTIONS.actions.runSelfCheck.call(app, {}, {});
      assert.ok(app.maintenance.selfCheck && Array.isArray(app.maintenance.selfCheck.problems));
      console.log("ok H27 window: 12 tabs with fields and the grid, greyed triggers, only changed keys saved, reload prompt, per-tab reset (declined: nothing), maintenance entries from the hook run");
      // Leave the stubs for the strip button below (restored at the end).
      winState = { app, Cls, setConfirm: v => { confirmAnswer = v; }, confirms };
    }

    /* ======================================================================== */
    /*  H28: api.stripParts                                                      */
    /* ======================================================================== */
    {
      const { PART_TYPE } = await imp("constants.mjs");
      const batches = [];
      const deletes = [];
      let duringPass = null;
      let failNext = false;
      ChatMessage.updateDocuments = async (updates, options) => {
        duringPass = stripMod.stripInProgress();
        if (failNext) { failNext = false; throw new Error("write refused"); }
        batches.push({ updates, options });
        return updates;
      };
      ChatMessage.deleteDocuments = async (ids, options) => { deletes.push({ ids, options }); return ids; };
      const progress = [];
      ui.notifications.info = (msg, opts) => {
        if (opts?.progress) { const h = { msg, pcts: [], update: ({ pct }) => h.pcts.push(pct) }; progress.push(h); return h; }
        return null;
      };
      const record = (title, ops) => ({
        abilityName: title,
        targets: { t1: { name: "Goblin", actorUuid: "Actor.none000000000001" } },
        ops: Object.fromEntries(ops.map((o, i) => [`op${i}`, { opId: `op${i}`, order: i, targetKeys: ["t1"], status: "applied", mode: "auto", ...o }])),
      });
      const msg = (id, parts, flags = null, { ts = Date.now(), flavor = "" } = {}) => ({
        id, timestamp: ts, flavor, flags: flags ? { [MODULE_ID]: flags } : {},
        system: { parts: new Map() },                 // our part may be invalid already: only _source has it
        _source: { system: { parts }, flags: flags ? { [MODULE_ID]: flags } : {} },
      });
      const ours = { dsAutoResolve000: { _id: "dsAutoResolve000", type: PART_TYPE } };
      const abilityParts = { abilityUse000000: { type: "abilityUse" }, ...ours };
      const old = Date.now() - 10 * 86_400_000;
      const fakes = new Coll();
      const add = m => fakes.set(m.id, m);
      add(msg("ability000000001", abilityParts, { resolution: record("Strike", [{ kind: "damage", amount: 5 }]) }));
      add(msg("ability000000002", abilityParts, { resolution: record("Old strike", [{ kind: "damage", amount: 3 }]) }, { ts: old }));
      add(msg("synthetic0000001", { ...ours }, { resolution: record("Fire", [{ kind: "damage", amount: 7, type: "fire" }]) }));
      add(msg("savecard00000001", { savingThrow00001: { type: "savingThrow" } }, { save: { effectUuid: "x" } }));
      add(msg("plain00000000001", { content000000001: { type: "content" } }));
      game.messages = fakes;
      await set("ledger", { v: LEDGER_VERSION, h: { ability000000001: "a", synthetic0000001: "b", other00000000001: "c" } });
      const stripped = [];
      const onStripped = r => stripped.push(r);
      Hooks.on(HOOKS.stripped, onStripped);

      // Guards.
      await assert.rejects(as(player, () => api.stripParts()), /DSAUTO\.Relay\.NotActiveGM/);
      await assert.rejects(as(gm2, () => api.stripParts({ dryRun: true })), /DSAUTO\.Relay\.NotActiveGM/);
      await assert.rejects(api.stripParts({ synthetic: "burn" }), /BadRequest/);
      // Dry run: counts, no writes.
      const dry = await api.stripParts();
      assert.deepEqual(
        [dry.dryRun, dry.scanned, dry.abilityCards, dry.syntheticCards, dry.partsRemoved, dry.converted, dry.deleted, dry.flagsRemoved],
        [true, 5, 2, 1, 3, 1, 0, 4]);
      assert.equal(batches.length + deletes.length, 0, "dry run writes nothing");
      assert.equal(stripped.length, 0, "no hook on a dry run");
      // Partial pass (older than a week): only the old ability card; the ledger loses nothing of it.
      const part = await api.stripParts({ dryRun: false, olderThanDays: 7 });
      assert.deepEqual([part.scanned, part.abilityCards, part.partsRemoved], [1, 1, 1]);
      assert.equal(batches.length, 1);
      assert.deepEqual(Object.keys(setting("ledger").h).sort(), ["ability000000001", "other00000000001", "synthetic0000001"], "partial: only stripped ids pruned");
      batches.length = 0;
      // Full run: ability card loses our part and flags; the synthetic card becomes a content part with the summary.
      await set("hideNpcNumbersFromPlayers", false);
      const run = await api.stripParts({ dryRun: false });
      assert.equal(duringPass, true, "stripInProgress during the writes");
      assert.equal(stripMod.stripInProgress(), false, "and off afterwards");
      assert.deepEqual(batches[0].options, { [MODULE_ID]: { strip: true } }, "writes carry the strip option");
      const ups = Object.fromEntries(batches.flatMap(b => b.updates).map(u => [u._id, u]));
      const ForcedDeletion = foundry.data.operators.ForcedDeletion;
      assert.ok(ups.ability000000001["system.parts.dsAutoResolve000"] instanceof ForcedDeletion);
      assert.ok(ups.ability000000001[`flags.${MODULE_ID}`] instanceof ForcedDeletion);
      assert.ok(!("content" in ups.ability000000001), "ability card keeps its content");
      const syn = ups.synthetic0000001;
      assert.ok(syn["system.parts.dsAutoResolve000"] instanceof ForcedDeletion);
      const added = Object.entries(syn).filter(([k, v]) => k.startsWith("system.parts.") && !(v instanceof ForcedDeletion));
      assert.equal(added.length, 1, "one new part");
      assert.equal(added[0][1].type, "content");
      assert.match(syn.content, /Fire/);
      assert.match(syn.content, /Goblin/);
      assert.match(syn.content, /7/, "numbers shown when the card shows them");
      assert.ok(ups.savecard00000001 && !Object.keys(ups.savecard00000001).some(k => k.startsWith("system.parts")), "flags-only message: flags only");
      assert.ok(!ups.plain00000000001, "untouched message");
      assert.deepEqual(setting("ledger"), { v: LEDGER_VERSION, h: {} }, "full pass: ledger emptied");
      assert.equal(run.ledgerPruned, 3);
      assert.equal(stripped.length, 2, "dsAuto.stripped fired (partial and full pass)");
      assert.equal(stripped[1], run);
      assert.ok(progress.length >= 1 && progress.at(-1).pcts.at(-1) === 1, "progress bar to 100%");
      // Hidden NPC numbers: the public summary leaves the number out.
      await set("hideNpcNumbersFromPlayers", true);
      const hidden = stripMod.summaryHtml(fakes.get("synthetic0000001"));
      assert.ok(!/7/.test(hidden) && /DSAUTO\.Card\.Synthetic\.damage/.test(hidden), "number hidden");
      // delete / keep.
      batches.length = 0;
      const del = await api.stripParts({ dryRun: false, synthetic: "delete" });
      assert.equal(del.deleted, 1);
      assert.deepEqual(deletes[0].ids, ["synthetic0000001"]);
      assert.deepEqual(deletes[0].options, { [MODULE_ID]: { strip: true } });
      deletes.length = 0;
      batches.length = 0;
      const keep = await api.stripParts({ dryRun: false, synthetic: "keep" });
      assert.equal(keep.syntheticCards, 1);
      assert.ok(!batches.flatMap(b => b.updates).some(u => u._id === "synthetic0000001") && !deletes.length, "keep: untouched");
      // 250 cards -> 3 batches of at most 100; a failing batch is reported, the next ones still run.
      const many = new Coll();
      for (let i = 0; i < 250; i++) {
        const id = `bulk${String(i).padStart(12, "0")}`;
        many.set(id, msg(id, abilityParts, { resolution: record("x", [{ kind: "damage", amount: 1 }]) }));
      }
      game.messages = many;
      batches.length = 0;
      failNext = true;
      const bulk = await api.stripParts({ dryRun: false });
      assert.equal(batches.length, 2, "first batch failed, two written");
      assert.deepEqual(batches.map(b => b.updates.length), [100, 50]);
      assert.equal(bulk.errors.length, 100, "every id of the failed batch reported");
      assert.equal(bulk.errors[0].message, "write refused");
      batches.length = 0;
      await api.stripParts({ dryRun: false });
      assert.deepEqual(batches.map(b => b.updates.length), [100, 100, 50], "3 batches");
      Hooks.off(HOOKS.stripped, onStripped);

      // The window's Prepare to uninstall: dry run, confirm, run.
      const { app, setConfirm, confirms } = winState;
      game.messages = fakes;
      batches.length = 0;
      setConfirm(false);
      await app.constructor.DEFAULT_OPTIONS.actions.stripRun.call(app, {}, {});
      assert.equal(batches.length, 0, "declined: nothing written");
      assert.match(String(confirms.at(-1).content), /DSAUTO\.Menu\.Maintenance\.stripConfirm/);
      assert.equal(app.maintenance.strip.dryRun, true);
      setConfirm(true);
      await app.constructor.DEFAULT_OPTIONS.actions.stripRun.call(app, {}, {});
      assert.ok(batches.length >= 1, "accepted: written");
      assert.equal(app.maintenance.strip.dryRun, false);
      const view = (await app._prepareContext({})).sections.find(s => s.id === "maintenance").maintenance.strip;
      assert.equal(view.done, true);
      game.messages = saved.messages;
      console.log("ok H28 stripParts: guards, dry run counts, part and flags removed, synthetic card converted (numbers hidden when the card hides them), delete / keep, partial ledger prune, full reset, 3 batches, batch errors, hook, the window's confirm");
    }

    /* ======================================================================== */
    /*  H29: api.cleanup                                                         */
    /* ======================================================================== */
    {
      const { wallOfFire, useCard, player2, regionClicks, placeMod, cell, idle, messages, getResolution, requestOp, zoneOp, liveOp } = mocks;
      // A real zone (Wall of Fire placed by its owner) on the harness scene.
      const card = useCard(wallOfFire, { author: player2 });
      await idle();
      await settleAll();
      const m = messages.get(card.id) ?? card;
      const op = zoneOp(m);
      regionClicks(player2, ...[[7, 3], [7, 4], [7, 5], [7, 6], [7, 7]].map(([x, y]) => cell(x, y)));
      await as(player2, () => placeMod.runZonePick({ message: m, res: getResolution(m), op, request: requestOp }));
      await idle();
      await settleAll();
      const zoneId = liveOp(m, op.opId)?.zoneId;
      assert.ok(zoneId && api.zones.list().some(z => z.zoneId === zoneId), "a zone exists");
      await assert.rejects(as(gm2, () => api.cleanup()), /NotActiveGM/);
      await assert.rejects(api.cleanup({ items: "burn" }), /BadRequest/);
      const dry = await api.cleanup();
      assert.equal(dry.dryRun, true);
      assert.ok(dry.zones.count >= 1 && dry.zones.done === 0, "dry: counted, not ended");
      assert.ok(api.zones.list().some(z => z.zoneId === zoneId));
      const cleaned = [];
      const onCleaned = r => cleaned.push(r);
      Hooks.on(HOOKS.cleaned, onCleaned);
      const run = await api.cleanup({ dryRun: false, untilEffects: "report" });
      await settleAll();
      assert.ok(run.zones.done >= 1, "zones dismissed");
      assert.ok(!api.zones.list().some(z => z.zoneId === zoneId), "the zone is gone");
      assert.equal(cleaned.length, 1, "dsAuto.cleaned fired");

      // Until effects, items, folders: swapped collections.
      const updates = [];
      const deleted = [];
      const actor = { uuid: "Actor.cleanupActor0001", name: "Hero", effects: null, items: null };
      const until = { id: "e1", uuid: `${actor.uuid}.ActiveEffect.e1`, name: "Until", parent: actor, _source: { duration: { expiry: UNTIL_EXPIRY } }, update: async u => updates.push(["effect", u]) };
      const other = { id: "e2", uuid: `${actor.uuid}.ActiveEffect.e2`, name: "Other", parent: actor, _source: { duration: { expiry: "turnEnd" } }, update: async u => updates.push(["other", u]) };
      actor.effects = new Coll([[until.id, until], [other.id, other]]);
      const custom = { id: "i1", uuid: `${actor.uuid}.Item.i1`, name: "Strike", parent: actor, _source: { system: { effects: { ent1: { type: "dsAuto.damage" }, sys1: { type: "damage" } } }, flags: { [MODULE_ID]: { overlay: { key: "x" } } } }, update: async u => updates.push(["item", u]) };
      const plainItem = { id: "i2", uuid: `${actor.uuid}.Item.i2`, name: "Plain", parent: actor, _source: { system: { effects: {} }, flags: {} }, update: async u => updates.push(["plain", u]) };
      actor.items = new Coll([[custom.id, custom], [plainItem.id, plainItem]]);
      const emptyFolder = { id: "f1", type: "Actor", flags: { [MODULE_ID]: { summons: true } }, contents: [], children: [], delete: async () => deleted.push("f1") };
      const fullFolder = { id: "f2", type: "Actor", flags: { [MODULE_ID]: { summons: true } }, contents: [{}], children: [], delete: async () => deleted.push("f2") };
      game.actors = new Coll([[actor.uuid, actor]]);
      game.items = new Coll();
      game.folders = new Coll([["f1", emptyFolder], ["f2", fullFolder], ["f3", { id: "f3", type: "Item", flags: {} }]]);
      game.scenes = new Coll();
      const report = await api.cleanup();
      assert.equal(report.untilEffects.count, 1);
      assert.equal(report.items.count, 1);
      assert.deepEqual(report.items.list, ["Hero: Strike"]);
      assert.deepEqual([report.folders.count, report.folders.empty], [2, 1]);
      assert.equal(updates.length, 0, "dry run writes nothing");
      const done = await api.cleanup({ dryRun: false, items: "remove", folders: "delete" });
      const ForcedDeletion = foundry.data.operators.ForcedDeletion;
      const eff = updates.find(u => u[0] === "effect")?.[1];
      assert.equal(eff["duration.expiry"], null, "until effect converted");
      assert.ok(eff[`flags.${MODULE_ID}`] instanceof ForcedDeletion);
      assert.ok(!updates.some(u => u[0] === "other"), "other effects untouched");
      const it = updates.find(u => u[0] === "item")?.[1];
      assert.ok(it["system.effects.ent1"] instanceof ForcedDeletion && !("system.effects.sys1" in it), "only our entries");
      assert.ok(it[`flags.${MODULE_ID}`] instanceof ForcedDeletion);
      assert.ok(!updates.some(u => u[0] === "plain"));
      assert.deepEqual(deleted, ["f1"], "only the empty folder deleted");
      assert.deepEqual([done.untilEffects.done, done.items.done, done.folders.done], [1, 1, 1]);
      Hooks.off(HOOKS.cleaned, onCleaned);
      game.actors = saved.actors;
      game.items = saved.items;
      game.folders = saved.folders;
      game.scenes = saved.scenes;
      console.log("ok H29 cleanup: dry-run report, zone dismissed, until effects converted, customized items reported and cleaned, only an empty folder deleted, hook");
    }

    /* ======================================================================== */
    /*  H30: the public API                                                      */
    /* ======================================================================== */
    {
      assert.equal(api.version, game.modules.get(MODULE_ID).version);
      assert.equal(api.apiVersion, 1);
      // api.debug: Directors only.
      assert.throws(() => as(player, () => api.debug.dump()), /DSAUTO\.Relay\.Denied/);
      await assert.rejects(as(player, () => api.debug.request({ action: "apply", messageId: "x" })), /Denied/);
      await assert.rejects(as(player, () => api.debug.triggers.offer([])), /Denied/);
      await assert.rejects(as(player, () => api.debug.zones.hit("nope", null)), /Denied/);
      assert.doesNotThrow(() => api.debug.dump());
      assert.deepEqual(await api.debug.triggers.offer([]), []);
      assert.equal(await api.debug.zones.hit("nope", null), null);
      // Internal relay actions need {internal: true}.
      const relayed = () => log.relay.filter(r => r.action === "hold").length;
      const r0 = relayed();
      // (a second Director: its requests go through the relay log)
      await assert.rejects(as(gm2, () => api.debug.request({ action: "hold", hold: {} })), /BadRequest/);
      await assert.rejects(as(gm2, () => api.request({ action: "hold", hold: {} })), /BadRequest/);
      assert.equal(relayed(), r0, "refused before the relay");
      await as(gm2, () => api.debug.request({ action: "hold", hold: {} }, { internal: true })).catch(() => null);
      assert.equal(relayed(), r0 + 1, "internal: reaches the relay");
      // Deprecated forwards warn at most once per name and still work.
      const warns = [];
      console.warn = (...a) => warns.push(a.join(" "));
      const d1 = api.dump();
      const d2 = api.dump();
      assert.deepEqual(d1, d2);
      await api.triggers.offer([]);
      await api.triggers.offer([]);
      console.warn = saved.warnFn;
      assert.ok(warns.filter(w => /api\.dump/.test(w)).length <= 1, "api.dump warns once");
      assert.ok(warns.filter(w => /api\.triggers\.offer/.test(w)).length <= 1, "offer warns once");
      assert.throws(() => as(player, () => api.dump()), /Denied/, "deprecated dump is GM only");
      await assert.rejects(as(player, () => api.triggers.offer([])), /Denied/);
      await assert.rejects(as(player, () => api.request({ action: "nuke" })), /Denied/, "deprecated request is GM only");
      const playerRequests = log.relay.length;
      await assert.rejects(as(player, () => api.request({ action: "choose", messageId: "missing", group: "g", option: "a" })), /Denied/);
      assert.equal(log.relay.length, playerRequests, "deprecated request refuses players before the relay");
      // api.compat: a frozen snapshot.
      const c = api.compat;
      assert.ok(Object.isFrozen(c));
      const dsct = c.dsct;
      assert.throws(() => { c.dsct = !dsct; }, TypeError);
      assert.equal(api.compat.dsct, dsct, "detection unaffected");
      assert.notEqual(api.compat, c, "a fresh snapshot per read");
      // Refusals that throw: another Director gets NotActiveGM; a player keeps false (harness10 H44).
      await assert.rejects(as(gm2, () => api.resources.release("Actor.x", "rule")), /NotActiveGM/);
      await assert.rejects(as(gm2, () => api.villain.reset()), /NotActiveGM/);
      assert.equal(await as(player, () => api.resources.release("Actor.x", "rule")), false);
      assert.equal(await as(player, () => api.villain.reset()), false);
      // api.modeFor: feature mode, off stays off, per-category override, the hero fallback.
      await set("modeByActorType", { ...defaultOf("modeByActorType"), npc: "prompt", minion: "manual", summon: "prompt" });
      const npcActor = { type: "npc", uuid: "Actor.npc" };
      assert.deepEqual(api.modeFor(npcActor), { category: "npc", mode: "prompt" });
      assert.deepEqual(api.modeFor({ type: "npc", isMinion: true }), { category: "minion", mode: "manual" });
      assert.deepEqual(api.modeFor({ type: "hero" }), { category: "hero", mode: "auto" });
      await set("heroOverride", "manual");
      assert.deepEqual(api.modeFor({ type: "hero" }, "heal"), { category: "hero", mode: "manual" }, "heroOverride fallback");
      await set("heroOverride", "inherit");
      assert.deepEqual(api.modeFor({ type: "npc", token: { flags: { [MODULE_ID]: { summon: { summonId: "s" } } } } }), { category: "summon", mode: "prompt" });
      await set("damageMode", "off");
      assert.deepEqual(api.modeFor(npcActor), { category: "npc", mode: "off" }, "off stays off");
      await set("damageMode", "auto");
      assert.deepEqual(api.modeFor({ type: "party" }, "condition"), { category: null, mode: setting("conditionsMode") });
      assert.throws(() => api.modeFor(npcActor, "nonsense"), /BadRequest/);
      // api.endTargeted goes through the relay.
      const e0 = log.relay.filter(r => r.action === "endTargeted").length;
      await as(player, () => api.endTargeted("Actor.target0000000001", "grabbed", { sourceUuid: "Actor.source0000000001" })).catch(() => null);
      const sent = log.relay.filter(r => r.action === "endTargeted");
      assert.equal(sent.length, e0 + 1, "relayed");
      assert.deepEqual(sent.at(-1).data.endTargeted, { actorUuid: "Actor.target0000000001", statusId: "grabbed", sourceUuid: "Actor.source0000000001" });
      assert.equal(typeof api.stripParts, "function");
      assert.equal(typeof api.cleanup, "function");
      console.log("ok H30 API: debug GM only, internal actions refused, deprecated forwards warn once, frozen compat, NotActiveGM refusals, version, apiVersion, modeFor, endTargeted relayed");
    }

    /* ======================================================================== */
    /*  H31: check.cjs and i18n-audit.cjs                                        */
    /* ======================================================================== */
    {
      const node = (script, env) => {
        try {
          return { code: 0, out: execFileSync(process.execPath, [join(TESTS, script)], { env: { ...process.env, ...env }, encoding: "utf8", cwd: TESTS }) };
        } catch (err) {
          return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
        }
      };
      const base = { DSAUTO_CHECK_SKIP_SYNTAX: "1" };
      delete process.env.DSAUTO_CHECK_LANG;
      delete process.env.DSAUTO_CHECK_SKIP_I18N;   // strict from M8 phase 3 on
      const ok = node("check.cjs", base);
      assert.equal(ok.code, 0, `check.cjs passes (strict): ${ok.out.split("\n").filter(l => /FAIL/.test(l)).join(" | ")}`);
      assert.match(ok.out, /i18n stef-ds-automation:/, "the audit covers the merged module (core, library content, medkit)");
      // A key removed from a copy of en.json fails the check.
      const dir = mkdtempSync(join(tmpdir(), "dsauto-wpd-"));
      try {
        const lang = JSON.parse(readFileSync(join(TESTS, "..", "lang", "en.json"), "utf8"));
        for (const [path, parent] of [["DSAUTO.Menu.Tab.general", l => l.DSAUTO.Menu.Tab], ["DSAUTO.Settings.modeByActorType.hint", l => l.DSAUTO.Settings.modeByActorType], ["DSAUTO.Menu.ActorType.minion", l => l.DSAUTO.Menu.ActorType]]) {
          const copy = JSON.parse(JSON.stringify(lang));
          delete parent(copy)[path.split(".").at(-1)];
          const file = join(dir, `en-${path.replace(/\W/g, "")}.json`);
          writeFileSync(file, JSON.stringify(copy));
          const r = node("check.cjs", { ...base, DSAUTO_CHECK_LANG: file });
          assert.notEqual(r.code, 0, `removing ${path} fails`);
          assert.ok(r.out.includes(`i18n key missing: ${path}`), `${path}: ${r.out.split("\n").filter(l => /FAIL/.test(l)).slice(0, 3).join(" | ")}`);
        }
        // The audit: passes on the module (strict), fails on hard-coded English.
        const audit = node("i18n-audit.cjs", {});
        assert.equal(audit.code, 0, `i18n-audit passes: ${audit.out.split("\n").filter(l => /FAIL/.test(l)).join(" | ")}`);
        const core = join(dir, "stef-ds-automation");
        for (const sub of ["scripts", "templates", "lang", "module.json"]) cpSync(join(TESTS, "..", sub), join(core, sub), { recursive: true });
        appendFileSync(join(core, "scripts", "settings.mjs"), '\nexport function hello() { ui.notifications.warn("Hello there"); }\n');
        const env = { DS_AUTO_CORE: core };
        const bad = node("i18n-audit.cjs", env);
        assert.equal(bad.code, 1, "an injected notification fails the audit");
        assert.match(bad.out, /hard-coded notify\.warn .*Hello there/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      // selfCheck problems have their keys (English verbatim); unknown relay errors become DSAUTO.Relay.Failed.
      const { relayErrorText } = await imp("relay/queries.mjs");
      assert.equal(relayErrorText(new Error("group not created")), "DSAUTO.Relay.Failed");
      const langNow = JSON.parse(readFileSync(join(TESTS, "..", "lang", "en.json"), "utf8"));
      const { PROBLEM_TEXT } = await imp("self-check.mjs");
      for (const [id, text] of Object.entries(PROBLEM_TEXT)) assert.equal(langNow.DSAUTO.SelfCheck[id], text, `SelfCheck.${id} in en.json`);
      console.log("ok H31 i18n: check.cjs passes strict on the merged module, removed keys fail, the audit passes and catches an injected notification");
    }
  } finally {
    restoreGlobals();
    await restoreSettings();
    await settleAll(10);
    setActiveGM(gm);
  }
}
