/** Identifiers shared by every part of stef-ds-automation. Changing any of them orphans stored data. */

export const MODULE_ID = "stef-ds-automation";

/** Flag key under `flags["stef-ds-automation"]` that holds the resolution record of an ability card. */
export const FLAG = "resolution";

/** MessagePart type registered in `ds.CONFIG.MessagePart` and its fixed id inside a card. */
export const PART_TYPE = "dsAutoResolution";
export const PART_ID = "dsAutoResolve000"; // 16 alphanumerics (pseudo-document id rule)

/** CONFIG.queries name for the GM relay (relay/queries.mjs). */
export const QUERY_OP = `${MODULE_ID}.op`;

/** CONFIG.queries name for prompts the active GM sends to a player (Milestone 2: saving throws). */
export const QUERY_PROMPT = `${MODULE_ID}.prompt`;

/**
 * `duration.expiry` of effects whose end is managed by turn/until.mjs (flag `until`). Core never
 * expires it on its own (it is not a core expiry event and nobody refreshes it).
 */
export const UNTIL_EXPIRY = "dsAutoUntil";

/** Version of the resolution record shape. */
export const RECORD_VERSION = 1;

/** Hooks emitted by the engine. */
export const HOOKS = Object.freeze({
  init: "dsAuto.init",
  preResolve: "dsAuto.preResolve",
  resolved: "dsAuto.resolved",
  preApplyOp: "dsAuto.preApplyOp",
  applyOp: "dsAuto.applyOp",
  undoOp: "dsAuto.undoOp",
  // Milestone 2: turn lifecycle (active GM, once per combatant and event).
  turnEvent: "dsAuto.turnEvent",
  preSave: "dsAuto.preSave",
  save: "dsAuto.save",
  preOngoing: "dsAuto.preOngoing",
  // Milestone 4: Smart Automation changed an item's automation (medkitApplied: its name before 1.0.1, still fired).
  smartAutomationApplied: "dsAuto.smartAutomationApplied",
  medkitApplied: "dsAuto.medkitApplied",
  // Milestone 5: triggered actions and trackers (active GM).
  preTrigger: "dsAuto.preTrigger",
  trigger: "dsAuto.trigger",
  trackerZero: "dsAuto.trackerZero",
  // Milestone 6: summoning (active GM). preSummon returning false vetoes the row (skipped hookVetoed).
  preSummon: "dsAuto.preSummon",
  summon: "dsAuto.summon",
  dismissSummon: "dsAuto.dismissSummon",
  // Milestone 7: resource gains, hero tokens and zones (active GM). preGain / preZoneHit returning false: no row / no card.
  preGain: "dsAuto.preGain",
  gain: "dsAuto.gain",
  preZoneHit: "dsAuto.preZoneHit",
  zoneHit: "dsAuto.zoneHit",
  zoneEnd: "dsAuto.zoneEnd",
  heroToken: "dsAuto.heroToken",
  // Milestone 8 (docs/M8-DESIGN.md §11.3). settingsMenu: any client, at each render of the settings window, with a
  // registry `{addMaintenance({id, label, hint, icon, run})}`; stripped / cleaned: the calling GM, with the report;
  // targetedEnded: active GM, `(effect, {reason: "sourceDefeated"|"revived"|"ended", sourceUuid})`.
  settingsMenu: "dsAuto.settingsMenu",
  stripped: "dsAuto.stripped",
  cleaned: "dsAuto.cleaned",
  targetedEnded: "dsAuto.targetedEnded",
  // Milestone 9 (docs/M9-DESIGN.md §C): a Persistent use was let go (active GM), `(entry, {reason})`.
  persistentEnd: "dsAuto.persistentEnd",
});

/** Third-party package ids we integrate with (never required). */
export const DSCT_ID = "draw-steel-combat-tools";
export const DSTD_ID = "draw-steel-target-damage";
export const CTLIB_ID = "draw-steel-ctlib";
export const DT_ID = "draw-steel-death-tracker";
export const DSPLUS_ID = "draw-steel-plus";
/** Milestone 5: with this module active (and `deferToTriggersModule` on) our trigger engine stays off. */
export const TRIGGERS_ID = "draw-steel-triggers";
/** 0.16.0: listed in the verified family versions (compat/version-gate.mjs VERIFIED). */
export const BATTLE_LOG_ID = "draw-steel-battle-log";
/** Milestone 7: with this module active our resource gains stand down (it owns them). */
export const RESOURCES_UI_ID = "draw-steel-resources-ui";
/** Milestone 7: the Delian Tomb adventure (monster content of the library). */
export const DT_ADVENTURE_ID = "draw-steel-delian-tomb";

/** Milestone 7: Combat flag keys under `flags["stef-ds-automation"]` (docs/M7-DESIGN.md §1.6). */
export const GAIN_FLAG = "eventGains";
export const GAIN_ENC_FLAG = "eventGainsEncounter";
export const ZONE_HIT_FLAG = "zoneHits";
export const VILLAIN_FLAG = "villainActions";

/**
 * Op kinds and statuses. "budget" (Milestone 5) is the undo anchor of every trigger card; "summon" (Milestone 6) is
 * placed on the canvas and never applied by itself; "gain" (Milestone 7) is an event resource gain and "zone" a lasting area
 * placed on the canvas.
 */
export const OP_KINDS = Object.freeze(["damage", "heal", "temp", "condition", "forced", "teleport", "cleanse", "resource", "note", "budget", "summon", "gain", "zone", "modifier", "pick"]);
export const OP_STATUS = Object.freeze({
  PENDING: "pending",
  APPLIED: "applied",
  UNDONE: "undone",
  SKIPPED: "skipped",
  FAILED: "failed",
  EXTERNAL: "external",
});

export const MODES = Object.freeze(["auto", "prompt", "manual", "off"]);

/** Localize helper. */
export function loc(key, data) {
  return data ? game.i18n.format(key, data) : game.i18n.localize(key);
}
