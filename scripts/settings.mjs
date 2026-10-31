/**
 * Settings of stef-ds-automation. Every world setting except `enabled` lives in the Automation settings window
 * (ui/settings-menu.mjs, docs/M8-DESIGN.md §5): a DEFINITIONS entry with `menu: "<tab id>"` is registered with
 * `config: false` (still with its name and hint, which the window shows); `hidden: true` entries have neither (the
 * ledger, the legacy heroOverride). The plain list keeps `enabled`, the two client settings and the window's button.
 * i18n keys (M8): DSAUTO.Menu.{name,label,hint}, DSAUTO.Settings.targetedConditions.native,
 * DSAUTO.Settings.{modeByActorType,summonInterceptNative,frightenedMoveWarning}.{name,hint}.
 */
import { MODULE_ID } from "./constants.mjs";
import { log } from "./log.mjs";
import { onLedgerChanged } from "./engine/ledger.mjs";
import { ACTOR_CATEGORIES } from "./engine/actor-category.mjs";
import { rerenderCards } from "./ui/rerender.mjs";

const MODE_CHOICES = {
  auto: "DSAUTO.Settings.Mode.auto",
  prompt: "DSAUTO.Settings.Mode.prompt",
  manual: "DSAUTO.Settings.Mode.manual",
  off: "DSAUTO.Settings.Mode.off",
};

/** Target categories of `modeByActorType` (docs/M8-DESIGN.md §4.1): engine/actor-category.mjs ACTOR_CATEGORIES. */
export const ACTOR_TYPE_CATEGORIES = ACTOR_CATEGORIES;
/** Per-category choices: "inherit" keeps the feature's mode; "off" stays a feature-level choice (D21). */
export const ACTOR_TYPE_MODES = Object.freeze(["inherit", "auto", "prompt", "manual"]);
const ACTOR_TYPE_CHOICES = {
  inherit: "DSAUTO.Settings.heroOverride.inherit",
  auto: "DSAUTO.Settings.Mode.auto",
  prompt: "DSAUTO.Settings.Mode.prompt",
  manual: "DSAUTO.Settings.Mode.manual",
};
const modeByActorTypeDefault = () => Object.fromEntries(ACTOR_TYPE_CATEGORIES.map(c => [c, "inherit"]));

/** The setting's DataField (validated object), or plain Object where Foundry's fields are not loaded (harnesses). */
function modeByActorTypeType() {
  const f = globalThis.foundry?.data?.fields;
  if (typeof f?.SchemaField !== "function" || typeof f?.StringField !== "function") return Object;
  return new f.SchemaField(Object.fromEntries(ACTOR_TYPE_CATEGORIES.map(c =>
    [c, new f.StringField({ required: true, blank: false, initial: "inherit", choices: [...ACTOR_TYPE_MODES] })])));
}

/**
 * Tabs of the settings window, in order (labels DSAUTO.Menu.Tab.<id>). "maintenance" holds buttons only;
 * "compat" also shows the detected modules.
 */
export const MENU_TABS = Object.freeze([
  { id: "general", icon: "fa-solid fa-gear" },
  { id: "modes", icon: "fa-solid fa-sliders" },
  { id: "players", icon: "fa-solid fa-users" },
  { id: "conditions", icon: "fa-solid fa-bolt" },
  { id: "turns", icon: "fa-solid fa-hourglass-half" },
  { id: "movement", icon: "fa-solid fa-arrows-up-down-left-right" },
  { id: "library", icon: "fa-solid fa-book" },
  { id: "triggers", icon: "fa-solid fa-reply" },
  { id: "summons", icon: "fa-solid fa-hand-sparkles" },
  { id: "resources", icon: "fa-solid fa-gem" },
  { id: "compat", icon: "fa-solid fa-puzzle-piece" },
  { id: "maintenance", icon: "fa-solid fa-screwdriver-wrench" },
].map(t => Object.freeze(t)));

/** Keys that stay in Foundry's plain settings list (config: true). */
export const PLAIN_KEYS = Object.freeze(["enabled", "promptDialog", "compactCard", "foldDetails", "debug"]);

/** World and client settings (Milestones 1a to 8). Keys are stable: they are stored in the world. */
const DEFINITIONS = {
  automationPresets: { hidden: true, scope: "world", type: Object, default: [] },
  automaticAreas: { menu: "library", scope: "world", type: Boolean, default: true },
  enabled: { scope: "world", type: Boolean, default: true },
  damageMode: { menu: "modes", scope: "world", type: String, default: "auto", choices: MODE_CHOICES },
  healingMode: { menu: "modes", scope: "world", type: String, default: "auto", choices: MODE_CHOICES },
  conditionsMode: { menu: "modes", scope: "world", type: String, default: "auto", choices: MODE_CHOICES },
  potencyGate: { menu: "conditions", scope: "world", type: Boolean, default: true },
  potencyAlwaysMeansFailure: { menu: "conditions", scope: "world", type: Boolean, default: true },
  targetedConditions: {
    menu: "conditions", scope: "world", type: String, default: "auto",
    choices: {
      auto: "DSAUTO.Settings.targetedConditions.auto",
      native: "DSAUTO.Settings.targetedConditions.native",
      off: "DSAUTO.Settings.targetedConditions.off",
    },
  },
  autoGrab: { menu: "conditions", scope: "world", type: Boolean, default: false },
  // Milestone 8: a frightened creature's owner is warned when it moves closer to its source (WP-C).
  frightenedMoveWarning: { menu: "conditions", scope: "world", type: Boolean, default: true },
  lockDstdRows: { menu: "compat", scope: "world", type: Boolean, default: true },
  sweepOnReady: {
    menu: "general", scope: "world", type: String, default: "banner",
    choices: {
      banner: "DSAUTO.Settings.sweepOnReady.banner",
      auto: "DSAUTO.Settings.sweepOnReady.auto",
      off: "DSAUTO.Settings.sweepOnReady.off",
    },
  },
  sweepWindowMinutes: { menu: "general", scope: "world", type: Number, default: 15, range: { min: 1, max: 240, step: 1 } },
  mixedTierSafety: { menu: "modes", scope: "world", type: Boolean, default: true },
  hideNpcNumbersFromPlayers: { menu: "general", scope: "world", type: Boolean, default: true },
  // Milestone 1b: players and modes. heroOverride is hidden since M8 (migrated into modeByActorType.hero once,
  // migrateModes) and still read as the fallback for heroes while modeByActorType.hero is "inherit" (until 0.11.0).
  heroOverride: {
    hidden: true, scope: "world", type: String, default: "inherit",
    choices: {
      inherit: "DSAUTO.Settings.heroOverride.inherit",
      auto: "DSAUTO.Settings.Mode.auto",
      prompt: "DSAUTO.Settings.Mode.prompt",
      manual: "DSAUTO.Settings.Mode.manual",
    },
  },
  // Milestone 8: a mode per target category (docs/M8-DESIGN.md §4.1), edited as a grid in the modes tab.
  modeByActorType: { menu: "modes", scope: "world", type: Object, typeFactory: modeByActorTypeType, default: modeByActorTypeDefault(), cellChoices: ACTOR_TYPE_CHOICES },
  playerAuthoredMode: {
    menu: "modes", scope: "world", type: String, default: "inherit",
    choices: {
      inherit: "DSAUTO.Settings.playerAuthoredMode.inherit",
      prompt: "DSAUTO.Settings.Mode.prompt",
      manual: "DSAUTO.Settings.Mode.manual",
    },
  },
  cardActionRole: {
    menu: "players", scope: "world", type: Number, default: 4,
    choices: { 1: "USER.RolePlayer", 2: "USER.RoleTrusted", 3: "USER.RoleAssistant", 4: "USER.RoleGamemaster" },
  },
  playerCardActions: {
    menu: "players", scope: "world", type: String, default: "ownSource",
    choices: {
      ownSource: "DSAUTO.Settings.playerCardActions.ownSource",
      ownSourceOrTarget: "DSAUTO.Settings.playerCardActions.ownSourceOrTarget",
    },
  },
  respectDstdApplications: { menu: "compat", scope: "world", type: Boolean, default: true },
  // Milestone 1.5: hardening.
  reviveOnUndo: { menu: "general", scope: "world", type: Boolean, default: true },
  // 0.17.0: healing a defeated creature above 0 revives it (resources/revive-on-heal.mjs).
  reviveOnHeal: { menu: "general", scope: "world", type: Boolean, default: true },
  autoApplyDelayMs: { menu: "general", scope: "world", type: Number, default: 0, range: { min: 0, max: 10000, step: 250 } },
  waitForDiceSoNice: { menu: "general", scope: "world", type: Boolean, default: true },
  promptDialog: { scope: "client", type: Boolean, default: false },
  // 0.13.0: compact Automation section; Target Damage's panel and Combat Tools' teleport messages folded (this client).
  compactCard: { scope: "client", type: Boolean, default: true, onChange: () => rerenderCards() },
  foldDetails: { scope: "client", type: Boolean, default: true, onChange: () => rerenderCards() },
  // Milestone 2: durations, saves, ongoing damage.
  heroSaves: {
    menu: "turns", scope: "world", type: String, default: "prompt",
    choices: {
      prompt: "DSAUTO.Settings.heroSaves.prompt",
      auto: "DSAUTO.Settings.heroSaves.auto",
      system: "DSAUTO.Settings.Saves.system",
    },
  },
  npcSaves: {
    menu: "turns", scope: "world", type: String, default: "auto",
    choices: { auto: "DSAUTO.Settings.npcSaves.auto", system: "DSAUTO.Settings.Saves.system" },
  },
  savePromptSeconds: { menu: "turns", scope: "world", type: Number, default: 60, range: { min: 10, max: 300, step: 5 } },
  saveFallback: {
    menu: "turns", scope: "world", type: String, default: "auto",
    choices: { auto: "DSAUTO.Settings.saveFallback.auto", dialog: "DSAUTO.Settings.saveFallback.dialog" },
  },
  npcSaveMessageMode: {
    menu: "turns", scope: "world", type: String, default: "default",
    choices: {
      default: "DSAUTO.Settings.npcSaveMessageMode.default",
      public: "DSAUTO.Settings.npcSaveMessageMode.public",
      gm: "DSAUTO.Settings.npcSaveMessageMode.gm",
      blind: "DSAUTO.Settings.npcSaveMessageMode.blind",
    },
  },
  ongoingDamage: { menu: "modes", scope: "world", type: String, default: "auto", choices: MODE_CHOICES },
  ongoingFromDescription: { menu: "turns", scope: "world", type: Boolean, default: true },
  systemFixes: { menu: "general", scope: "world", type: Boolean, default: true, requiresReload: true },
  // Milestone 3: forced movement.
  forcedMovementMode: { menu: "modes", scope: "world", type: String, default: "auto", choices: MODE_CHOICES },
  forcedPath: {
    menu: "movement", scope: "world", type: String, default: "straight",
    choices: { straight: "DSAUTO.Settings.forcedPath.straight", choose: "DSAUTO.Settings.forcedPath.choose" },
  },
  forcedFallback: { menu: "movement", scope: "world", type: Boolean, default: true },
  // Milestone 4: ability library.
  libraryEnabled: { menu: "library", scope: "world", type: Boolean, default: true },
  libraryDefersToCombatTools: { menu: "library", scope: "world", type: Boolean, default: true },
  resourceMode: { menu: "modes", scope: "world", type: String, default: "auto", choices: MODE_CHOICES },
  // Milestone 5: triggered actions.
  triggersEnabled: { menu: "triggers", scope: "world", type: Boolean, default: true },
  triggerPromptSeconds: { menu: "triggers", scope: "world", type: Number, default: 20, range: { min: 5, max: 120, step: 1 } },
  triggerFallback: { menu: "triggers", scope: "world", type: String, default: "director", choices: { director: "DSAUTO.Settings.triggerFallback.director", skip: "DSAUTO.Settings.triggerFallback.skip" } },
  triggersOutsideCombat: { menu: "triggers", scope: "world", type: Boolean, default: false },
  triggerNpcs: { menu: "triggers", scope: "world", type: Boolean, default: true },
  triggerExternalDamage: { menu: "triggers", scope: "world", type: Boolean, default: true },
  triggerTrackers: { menu: "triggers", scope: "world", type: Boolean, default: true },
  triggerRollLock: { menu: "triggers", scope: "world", type: Boolean, default: true },
  deferToTriggersModule: { menu: "triggers", scope: "world", type: Boolean, default: true },
  // Milestone 6: summoning.
  summonMode: { menu: "modes", scope: "world", type: String, default: "auto", choices: MODE_CHOICES },
  summonPlacement: { menu: "summons", scope: "world", type: String, default: "pick", choices: { pick: "DSAUTO.Settings.summonPlacement.pick", auto: "DSAUTO.Settings.summonPlacement.auto" } },
  summonTurnChain: { menu: "summons", scope: "world", type: Boolean, default: true },
  summonSquadLabels: { menu: "summons", scope: "world", type: Boolean, default: true },
  summonEncounterEnd: { menu: "summons", scope: "world", type: String, default: "listed", choices: { listed: "DSAUTO.Settings.summonEncounterEnd.listed", all: "DSAUTO.Settings.summonEncounterEnd.all", none: "DSAUTO.Settings.summonEncounterEnd.none" } },
  summonOwnerPotency: { menu: "summons", scope: "world", type: Boolean, default: true },
  summonUpkeepSeconds: { menu: "summons", scope: "world", type: Number, default: 30, range: { min: 10, max: 120, step: 5 } },
  // Milestone 9 (docs/M9-DESIGN.md §C): keep a Persistent ability use at the user's turn start (re-roll, hold).
  persistentUpkeep: { menu: "summons", scope: "world", type: Boolean, default: true },
  // Milestone 8: the system's own summons (Draw Steel 1.2) are placed through our engine (WP-B, D10).
  summonInterceptNative: { menu: "summons", scope: "world", type: Boolean, default: true },
  // Milestone 7: resources and zones (docs/M7-DESIGN.md §4).
  resourceGains: { menu: "modes", scope: "world", type: String, default: "auto", choices: MODE_CHOICES },
  heroTokenPrompt: { menu: "resources", scope: "world", type: Boolean, default: true },
  // 0.16.0: an undone once-per-round (or encounter) gain keeps its slot; api.resources.release frees it by hand.
  gainUndoKeepsSlot: { menu: "resources", scope: "world", type: Boolean, default: false },
  // 0.16.0 (house rule): a hero token rerolls an ability's power roll (resources/hero-token-reroll.mjs).
  heroTokenRerollPowerRolls: { menu: "resources", scope: "world", type: Boolean, default: false },
  maliceReminders: { menu: "resources", scope: "world", type: Boolean, default: true },
  villainActionTracking: { menu: "resources", scope: "world", type: Boolean, default: true },
  zoneMode: { menu: "modes", scope: "world", type: String, default: "auto", choices: MODE_CHOICES },
  zoneDamage: { menu: "modes", scope: "world", type: String, default: "auto", choices: MODE_CHOICES },
  debug: { scope: "client", type: Boolean, default: false },
  // 0.16.0: the version set the unverified-versions warning was last shown for (ui/version-banner.mjs).
  versionBannerSeen: { hidden: true, scope: "client", type: String, default: "" },
  // Record signatures written by the active GM (engine/ledger.mjs); hidden, GM-writable only.
  ledger: { hidden: true, scope: "world", type: Object, default: { v: 0, h: {} }, onChange: () => onLedgerChanged() },
};

/** DEFINITIONS keys that only describe the entry for us (stripped before game.settings.register). */
const LOCAL_KEYS = new Set(["menu", "hidden", "typeFactory", "cellChoices"]);

export function registerSettings() {
  for (const [key, def] of Object.entries(DEFINITIONS)) {
    const hidden = !!def.hidden;
    const data = Object.fromEntries(Object.entries(def).filter(([k]) => !LOCAL_KEYS.has(k)));
    if (def.typeFactory) data.type = def.typeFactory();
    if (data.default && typeof data.default === "object") data.default = clone(data.default);
    game.settings.register(MODULE_ID, key, {
      ...(hidden ? {} : { name: `DSAUTO.Settings.${key}.name`, hint: `DSAUTO.Settings.${key}.hint` }),
      ...data,
      config: !hidden && !def.menu,
    });
  }
}

/**
 * The Automation settings window's button in the plain list (restricted: Directors only). `type` is the window class
 * (ui/settings-menu.mjs automationSettingsClass); without one (no ApplicationV2, harnesses) nothing is registered.
 * @returns {boolean} registered
 */
export function registerSettingsMenu(type) {
  if (!type || typeof game.settings?.registerMenu !== "function") return false;
  try {
    game.settings.registerMenu(MODULE_ID, "config", {
      name: "DSAUTO.Menu.name", label: "DSAUTO.Menu.label", hint: "DSAUTO.Menu.hint",
      icon: "fa-solid fa-wand-magic-sparkles", type, restricted: true,
    });
    return true;
  } catch (err) {
    console.error(`${MODULE_ID} | registerMenu failed`, err);
    return false;
  }
}

const clone = v => (v && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v);

/** Read a setting; falls back to the declared default before registration or on error. */
export function setting(key) {
  try {
    return game.settings.get(MODULE_ID, key);
  } catch (_err) {
    return clone(DEFINITIONS[key]?.default);
  }
}

export const SETTING_KEYS = Object.keys(DEFINITIONS);

/** A setting's declared default (a fresh copy). */
export function defaultOf(key) {
  return clone(DEFINITIONS[key]?.default);
}

/** Read-only view of one definition (the settings window): {key, menu, hidden, scope, type, choices, cellChoices, range, requiresReload}. */
export function definitionOf(key) {
  const def = DEFINITIONS[key];
  if (!def) return null;
  return Object.freeze({
    key, menu: def.menu ?? null, hidden: !!def.hidden, scope: def.scope, type: def.type, default: clone(def.default),
    choices: def.choices ?? null, cellChoices: def.cellChoices ?? null, range: def.range ?? null, requiresReload: !!def.requiresReload,
  });
}

/** Keys of one tab of the settings window, in DEFINITIONS order. */
export function tabKeys(tabId) {
  return SETTING_KEYS.filter(k => DEFINITIONS[k].menu === tabId);
}

/** Every key the settings window edits (in a tab, not hidden). */
export const MENU_KEYS = Object.freeze(SETTING_KEYS.filter(k => DEFINITIONS[k].menu && !DEFINITIONS[k].hidden));

/**
 * Milestone 8 (docs/M8-DESIGN.md §4.4, D22): copy a non-default `heroOverride` into `modeByActorType.hero` once.
 * Active GM, at ready. Idempotent: once hero is not "inherit" nothing happens (and while it is "inherit" the resolver
 * falls back to heroOverride anyway, so a second copy changes nothing).
 * @returns {Promise<boolean>} migrated
 */
export async function migrateModes() {
  if (!game.users?.activeGM?.isSelf) return false;
  const map = { ...modeByActorTypeDefault(), ...(setting("modeByActorType") ?? {}) };
  const legacy = setting("heroOverride");
  if (map.hero !== "inherit" || !ACTOR_TYPE_MODES.includes(legacy) || legacy === "inherit") return false;
  map.hero = legacy;
  await game.settings.set(MODULE_ID, "modeByActorType", map);
  log("settings.migrateModes", { hero: legacy });
  return true;
}
