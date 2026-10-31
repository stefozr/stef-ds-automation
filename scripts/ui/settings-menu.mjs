/**
 * The Automation settings window (Milestone 8, docs/M8-DESIGN.md §5.2-§5.4, D23): one ApplicationV2 form with a tab
 * per area holding every world setting except `enabled` (settings.mjs DEFINITIONS `menu`), a per-tab and a global
 * "Reset to defaults" (Foundry's own reset only touches the plain list), the detected modules (Other modules tab) and
 * the Maintenance tab: self-check, Prepare to uninstall (api.stripParts: count, confirm, run), the cleanup report
 * (api.cleanup dry run) and entries other modules add through `dsAuto.settingsMenu`.
 * Registered by main.mjs through settings.mjs registerSettingsMenu (restricted: Directors). The class is built on
 * first use (Foundry's ApplicationV2 is not there at import time in the harnesses); the context, save and reset
 * helpers are plain functions so the harness drives them without a DOM.
 *
 * i18n keys: DSAUTO.Menu.{title,ResetTab,ResetAll,ResetConfirm}, DSAUTO.Menu.Tab.<tab id>, DSAUTO.Menu.ActorType.<category>,
 * DSAUTO.Menu.Maintenance.{selfCheck,selfCheckGreen,strip,stripHint,stripDry,stripConfirm,stripReport,cleanup,
 * cleanupHint,fromModules}, DSAUTO.Menu.Maintenance.Cleanup.<row>, DSAUTO.Menu.Compat.{detected,notDetected,
 * systemVersion,cardShape,devBuild,modules}, DSAUTO.Strip.DoneHint.
 */
import { HOOKS, MODULE_ID, loc } from "../constants.mjs";
import { error } from "../log.mjs";
import {
  ACTOR_TYPE_CATEGORIES, ACTOR_TYPE_MODES, MENU_KEYS, MENU_TABS, defaultOf, definitionOf, setting, tabKeys,
} from "../settings.mjs";
import { compat, detectCompat } from "../compat/version-gate.mjs";
import { selfCheck } from "../self-check.mjs";
import { relayErrorText } from "../relay/queries.mjs";
import { stripParts } from "../maintenance/strip.mjs";
import { cleanup } from "../maintenance/cleanup.mjs";

export const TEMPLATE_MENU = `modules/${MODULE_ID}/templates/settings/menu.hbs`;
export const TEMPLATE_MAINTENANCE = `modules/${MODULE_ID}/templates/settings/maintenance.hbs`;
/** The tab whose other fields are greyed while its switch is off. */
const ENABLE_SWITCHES = Object.freeze({ triggers: "triggersEnabled" });
/** Rows of the cleanup report, in order (labels DSAUTO.Menu.Maintenance.Cleanup.<row>). */
const CLEANUP_ROWS = Object.freeze(["zones", "untilEffects", "summons", "items", "folders", "nativeTargeted"]);
/** Modules the Other modules tab lists (detected or not). */
const LISTED_MODULES = Object.freeze([
  "lib-wrapper", "draw-steel-combat-tools", "draw-steel-ctlib", "draw-steel-target-damage", "draw-steel-death-tracker",
  "draw-steel-battle-log", "draw-steel-triggers", "draw-steel-resources-ui", "stef-ds-fx", "stef-ds-qol",
]);

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const esc = v => (typeof foundry?.utils?.escapeHTML === "function" ? foundry.utils.escapeHTML(String(v ?? "")) : String(v ?? ""));

/* -------------------------------------------- */
/*  Values                                      */
/* -------------------------------------------- */

/** modeByActorType as the grid shows it: a hero cell still "inherit" shows the legacy heroOverride it falls back to. */
export function effectiveTypeModes() {
  const map = { ...defaultOf("modeByActorType"), ...(setting("modeByActorType") ?? {}) };
  const legacy = setting("heroOverride");
  if (map.hero === "inherit" && ACTOR_TYPE_MODES.includes(legacy)) map.hero = legacy;
  return map;
}

/**
 * A submitted value as the setting's type, or undefined when it is not valid (then the key is left alone).
 * Booleans from checkboxes, numbers clamped into their range, strings among their choices; modeByActorType cell by cell.
 */
export function coerceValue(key, raw) {
  const def = definitionOf(key);
  if (!def) return undefined;
  if (key === "modeByActorType") {
    if (!raw || typeof raw !== "object") return undefined;
    const current = { ...defaultOf(key), ...(setting(key) ?? {}) };
    return Object.fromEntries(ACTOR_TYPE_CATEGORIES.map(c => [c, ACTOR_TYPE_MODES.includes(raw[c]) ? raw[c] : current[c]]));
  }
  if (def.type === Boolean) {
    if (typeof raw === "boolean") return raw;
    if (raw === "true" || raw === "on") return true;
    if (raw === "false" || raw === "" || raw == null) return false;
    return undefined;
  }
  if (def.type === Number) {
    if (raw === "" || raw == null) return undefined;
    let n = Number(raw);
    if (!Number.isFinite(n)) return undefined;
    if (def.choices) return String(n) in def.choices ? n : undefined;
    if (def.range) n = Math.min(def.range.max ?? n, Math.max(def.range.min ?? n, n));
    return n;
  }
  if (def.type === String) {
    const s = String(raw ?? "");
    if (def.choices && !(s in def.choices)) return undefined;
    return s;
  }
  return undefined;
}

/**
 * Save the submitted values of the window (only window keys, only changed ones). A hero cell set to "inherit" also
 * clears the legacy heroOverride (otherwise the resolver would still fall back to it).
 * @param {object} values   expanded form data: {key: value, modeByActorType: {hero: ...}}
 * @returns {Promise<{changed: string[], reload: boolean}>}
 */
export async function saveSettings(values = {}) {
  const changed = [];
  let reload = false;
  for (const key of MENU_KEYS) {
    if (!values || !(key in values)) continue;
    const value = coerceValue(key, values[key]);
    if (value === undefined) continue;
    if (key === "modeByActorType" && value.hero === "inherit" && setting("heroOverride") !== "inherit") {
      await game.settings.set(MODULE_ID, "heroOverride", "inherit");
      changed.push("heroOverride");
    }
    if (same(setting(key), value)) continue;
    await game.settings.set(MODULE_ID, key, value);
    changed.push(key);
    if (definitionOf(key)?.requiresReload) reload = true;
  }
  return { changed, reload };
}

/** Keys among `keys` whose value differs from the default (modeByActorType brings the legacy heroOverride along). */
export function keysToReset(keys) {
  const out = keys.filter(k => !same(setting(k), defaultOf(k)));
  if (keys.includes("modeByActorType") && !same(setting("heroOverride"), defaultOf("heroOverride"))) out.push("heroOverride");
  return out;
}

/**
 * Set `keys` back to their defaults (no confirmation here).
 * @returns {Promise<{changed: string[], reload: boolean}>}
 */
export async function resetKeys(keys) {
  const changed = [];
  let reload = false;
  for (const key of keysToReset(keys)) {
    await game.settings.set(MODULE_ID, key, defaultOf(key));
    changed.push(key);
    if (definitionOf(key)?.requiresReload) reload = true;
  }
  return { changed, reload };
}

/* -------------------------------------------- */
/*  Context                                     */
/* -------------------------------------------- */

/** The DataField the window renders for a setting (the synthesis of Foundry's SettingsConfig, config.mjs:82-127). */
export function fieldFor(key) {
  const def = definitionOf(key);
  const fields = globalThis.foundry?.data?.fields;
  if (!def || !fields) return null;
  const label = `DSAUTO.Settings.${key}.name`;
  const hint = `DSAUTO.Settings.${key}.hint`;
  let field;
  if (def.type === Boolean) field = new fields.BooleanField({ initial: def.default ?? false, label, hint });
  else if (def.type === Number) {
    const { min, max, step } = def.range ?? {};
    field = new fields.NumberField({ required: true, choices: def.choices ?? undefined, initial: def.default, min, max, step, label, hint });
  } else field = new fields.StringField({ required: true, choices: def.choices ?? undefined, initial: def.default, label, hint });
  field.name = key;
  field.label ||= label;
  field.hint ||= hint;
  return field;
}

function entryFor(tabId, key) {
  const label = `DSAUTO.Settings.${key}.name`;
  const hint = `DSAUTO.Settings.${key}.hint`;
  if (key === "modeByActorType") {
    const values = effectiveTypeModes();
    const choices = definitionOf(key).cellChoices;
    return {
      key, grid: true, label, hint,
      cells: ACTOR_TYPE_CATEGORIES.map(c => ({ category: c, name: `${key}.${c}`, label: `DSAUTO.Menu.ActorType.${c}`, value: values[c], choices })),
    };
  }
  const switchKey = ENABLE_SWITCHES[tabId];
  const disabled = !!switchKey && key !== switchKey && setting(switchKey) === false;
  return { key, label, hint, field: fieldFor(key), value: setting(key), disabled, switch: key === switchKey };
}

/** Read-only rows of the Other modules tab: system version, card shape, development build, detected modules. */
export function compatRows() {
  try {
    detectCompat();
  } catch (err) {
    error("settingsMenu.compat", err);
  }
  const yesNo = v => (v ? "DSAUTO.Menu.Compat.detected" : "DSAUTO.Menu.Compat.notDetected");
  const shape = compat.targetResult ? (compat.targetTokenUuid === false ? "unknown" : "targetResult") : "tierParts";
  return {
    info: [
      { label: "DSAUTO.Menu.Compat.systemVersion", text: compat.systemVersion ?? "" },
      { label: "DSAUTO.Menu.Compat.cardShape", text: shape },
      { label: "DSAUTO.Menu.Compat.devBuild", textKey: yesNo(!!compat.devBuild) },
    ],
    modules: LISTED_MODULES.map(id => {
      const mod = game.modules?.get?.(id);
      return { id, name: mod?.title ?? id, version: mod?.active ? (mod.version ?? "") : "", textKey: yesNo(!!mod?.active) };
    }),
  };
}

/**
 * Maintenance entries other modules add (`dsAuto.settingsMenu`, any client): `{id, label, hint, icon, run}`; labels are
 * i18n keys of the calling module. Collected again at every render.
 * @returns {Map<string, {id, label, hint, icon, run}>}
 */
export function collectMaintenanceEntries() {
  const entries = new Map();
  const registry = Object.freeze({
    addMaintenance(entry) {
      const { id, label, hint = null, icon = null, run } = entry ?? {};
      if (typeof id !== "string" || !id || typeof label !== "string" || typeof run !== "function" || entries.has(id)) return false;
      entries.set(id, { id, label, hint: typeof hint === "string" ? hint : null, icon: typeof icon === "string" ? icon : "fa-solid fa-toolbox", run });
      return true;
    },
  });
  try {
    Hooks.callAll(HOOKS.settingsMenu ?? "dsAuto.settingsMenu", registry);
  } catch (err) {
    error("settingsMenu.hook", err);
  }
  return entries;
}

/** The Maintenance tab's view of the window's state. */
function maintenanceView(state, entries) {
  const strip = state.strip;
  return {
    selfCheck: state.selfCheck,
    strip: strip ? {
      report: loc("DSAUTO.Menu.Maintenance.stripReport", { abilityCards: strip.abilityCards, syntheticCards: strip.syntheticCards, flagsRemoved: strip.flagsRemoved }),
      done: !strip.dryRun,
      errors: strip.errors?.length ?? 0,
    } : null,
    cleanup: state.cleanup ? CLEANUP_ROWS.map(row => ({
      row, text: loc(`DSAUTO.Menu.Maintenance.Cleanup.${row}`, { count: state.cleanup[row]?.count ?? 0 }),
      list: (state.cleanup[row]?.list ?? []).slice(0, 20),
    })) : null,
    entries: [...entries.values()].map(({ run: _run, ...e }) => e),
  };
}

/**
 * Every tab of the window with its fields (the body template's context).
 * @param {object} [state]    the window's maintenance state {selfCheck, strip, cleanup}
 * @param {Map} [entries]     maintenance entries (collectMaintenanceEntries)
 * @param {string} [active]   the active tab id
 */
export function menuSections(state = {}, entries = new Map(), active = "general") {
  return MENU_TABS.map(t => {
    const keys = tabKeys(t.id);
    return {
      id: t.id, icon: t.icon, label: `DSAUTO.Menu.Tab.${t.id}`,
      active: t.id === active, cssClass: t.id === active ? "active" : "",
      fields: keys.map(k => entryFor(t.id, k)),
      resettable: keys.length > 0,
      compat: t.id === "compat" ? compatRows() : null,
      maintenance: t.id === "maintenance" ? maintenanceView(state, entries) : null,
    };
  });
}

/* -------------------------------------------- */
/*  Actions                                     */
/* -------------------------------------------- */

/** A yes/no question (DialogV2.confirm); false when it is declined or cannot be asked. */
export async function confirmText(text) {
  const Dialog = globalThis.foundry?.applications?.api?.DialogV2;
  if (typeof Dialog?.confirm !== "function") return false;
  try {
    return !!(await Dialog.confirm({ window: { title: "DSAUTO.Menu.title" }, content: `<p>${esc(text)}</p>`, modal: true, rejectClose: false }));
  } catch (_err) {
    return false;
  }
}

async function reloadPrompt(reload) {
  if (!reload) return;
  try {
    await globalThis.foundry?.applications?.settings?.SettingsConfig?.reloadConfirm?.({ world: true });
  } catch (err) {
    error("settingsMenu.reload", err);
  }
}

/** Reset `keys` after confirmation. @returns {Promise<string[]|null>} the reset keys, null when declined. */
export async function confirmAndReset(keys) {
  const pending = keysToReset(keys);
  if (!pending.length) return [];
  if (!(await confirmText(loc("DSAUTO.Menu.ResetConfirm", { count: pending.length })))) return null;
  const { changed, reload } = await resetKeys(keys);
  await reloadPrompt(reload);
  return changed;
}

const warnError = err => {
  error("settingsMenu.action", err);
  try {
    ui.notifications?.warn?.(relayErrorText(err));
  } catch (_err) { /* ignore */ }
};

/**
 * The window's button actions, `this` = the window (exported for the harness). Each re-renders the window.
 */
export const menuActions = Object.freeze({
  async resetTab(_event, target) {
    const tab = target?.dataset?.section;
    if (!tab || !MENU_TABS.some(t => t.id === tab)) return;
    const done = await confirmAndReset(tabKeys(tab));
    if (done?.length) this.render?.();
  },
  async resetAll() {
    const done = await confirmAndReset([...MENU_KEYS]);
    if (done?.length) this.render?.();
  },
  async runSelfCheck() {
    try {
      const { problems = [] } = selfCheck() ?? {};
      this.maintenance.selfCheck = { green: !problems.length, problems: [...problems] };
    } catch (err) {
      warnError(err);
    }
    this.render?.();
  },
  async stripDry() {
    try {
      this.maintenance.strip = await stripParts({ dryRun: true });
    } catch (err) {
      warnError(err);
    }
    this.render?.();
  },
  async stripRun() {
    try {
      const dry = await stripParts({ dryRun: true });
      this.maintenance.strip = dry;
      if (!(await confirmText(loc("DSAUTO.Menu.Maintenance.stripConfirm", { abilityCards: dry.abilityCards, syntheticCards: dry.syntheticCards })))) {
        this.render?.();
        return;
      }
      this.maintenance.strip = await stripParts({ dryRun: false });
    } catch (err) {
      warnError(err);
    }
    this.render?.();
  },
  async cleanupDry() {
    try {
      this.maintenance.cleanup = await cleanup({ dryRun: true });
    } catch (err) {
      warnError(err);
    }
    this.render?.();
  },
  async maintenanceEntry(_event, target) {
    const entry = this.entries?.get?.(target?.dataset?.entryId);
    if (!entry) return;
    try {
      await entry.run();
    } catch (err) {
      warnError(err);
    }
  },
});

/* -------------------------------------------- */
/*  The window                                  */
/* -------------------------------------------- */

let MenuClass = null;

/** The AutomationSettings class (built once), or null when Foundry's ApplicationV2 is not available. */
export function automationSettingsClass() {
  if (MenuClass) return MenuClass;
  const appApi = globalThis.foundry?.applications?.api;
  if (typeof appApi?.ApplicationV2 !== "function" || typeof appApi?.HandlebarsApplicationMixin !== "function") return null;
  const action = name => function (event, target) { return menuActions[name].call(this, event, target); };

  class AutomationSettings extends appApi.HandlebarsApplicationMixin(appApi.ApplicationV2) {
    static DEFAULT_OPTIONS = {
      id: "stef-ds-automation-settings",
      tag: "form",
      classes: ["ds-auto-settings"],
      window: { title: "DSAUTO.Menu.title", icon: "fa-solid fa-wand-magic-sparkles", resizable: true, contentClasses: ["standard-form"] },
      position: { width: 760, height: 700 },
      form: { handler: AutomationSettings.#onSubmit, closeOnSubmit: false, submitOnChange: false },
      actions: Object.fromEntries(Object.keys(menuActions).map(name => [name, action(name)])),
    };

    static TABS = {
      sections: { tabs: MENU_TABS.map(t => ({ id: t.id, icon: t.icon })), initial: "general", labelPrefix: "DSAUTO.Menu.Tab" },
    };

    static PARTS = {
      tabs: { template: "templates/generic/tab-navigation.hbs" },
      body: { template: TEMPLATE_MENU, templates: [TEMPLATE_MAINTENANCE], scrollable: [""] },
      footer: { template: "templates/generic/form-footer.hbs" },
    };

    /** Maintenance results shown until the window closes. */
    maintenance = { selfCheck: null, strip: null, cleanup: null };

    /** Maintenance entries of other modules (collected at each render). */
    entries = new Map();

    async _prepareContext(options) {
      const context = await super._prepareContext(options);
      this.entries = collectMaintenanceEntries();
      const active = this.tabGroups?.sections ?? "general";
      context.verticalTabs = true;
      context.sections = menuSections(this.maintenance, this.entries, active);
      context.buttons = [{ type: "submit", icon: "fa-solid fa-floppy-disk", label: "SETTINGS.Save" }];
      return context;
    }

    async _onRender(context, options) {
      await super._onRender?.(context, options);
      const root = this.element;
      if (!root?.querySelector) return;
      // Enable-greying: a tab's other fields follow its switch while the form is open (values are kept).
      for (const [tab, switchKey] of Object.entries(ENABLE_SWITCHES)) {
        const toggle = root.querySelector(`[name="${switchKey}"]`);
        if (!toggle) continue;
        toggle.addEventListener("change", () => {
          for (const key of tabKeys(tab)) {
            if (key === switchKey) continue;
            for (const el of root.querySelectorAll(`[name="${key}"]`)) el.disabled = !toggle.checked;
          }
        });
      }
    }

    static async #onSubmit(_event, _form, formData) {
      const values = foundry.utils.expandObject(formData?.object ?? {});
      const { reload } = await saveSettings(values);
      await reloadPrompt(reload);
      this.render();
    }
  }
  MenuClass = AutomationSettings;
  return MenuClass;
}
