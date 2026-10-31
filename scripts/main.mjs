import { registerAuras, setAura, chooseNullOption } from "./features/auras.mjs";
import { registerPerformanceRolls } from "./features/rolls.mjs";
import { registerFeatureCapabilities } from "./features/capabilities.mjs";
import { registerTemporaryResources } from "./features/temporary-resources.mjs";
import { registerPerformances } from "./features/performance.mjs";
import { registerFeatureEngine } from "./features/engine.mjs";
import { registerSurgeChoice, registerNativeSurgeTracking } from "./ui/surge-choice.mjs";
import { registerTemporaryStamina } from "./features/temporary-stamina.mjs";
import { registerAlone } from "./features/alone.mjs";
import { registerMovementChoice } from "./ui/movement-choice.mjs";
import { versionBanner } from "./ui/version-banner.mjs";
import { localizeHeroTokenSpend, registerHeroTokenSpend } from "./resources/hero-token-reroll.mjs";
import { registerAutomaticAreas } from "./engine/areas.mjs";
import { validateAutomation, saveAutomation, clearAutomation, presets, savePreset, deletePreset, applyPreset, editableAutomation, presetDraft } from "./library/custom.mjs";
/**
 * Stef's Automation Suite for Draw Steel — entry point.
 *
 * Milestones 1a + 1b ("auto-apply core", "players + modes"):
 *   SEED     author client, preCreateChatMessage: targets + our message part   (engine/seed.mjs)
 *   RESOLVE  active GM, createChatMessage: tiers -> ops -> apply auto ops -> ONE write (engine/engine.mjs)
 *   RENDER   every client: the dsAutoResolution part renders the stored record  (parts/*)
 *   RELAY    every button / API call runs on the active GM, authorized there     (relay/*)
 *   LOCK     Target Damage rows of applied ops are disabled                     (ui/dstd-lock.mjs)
 * Milestone 1.5 (hardening): Death Tracker revival on undo, half damage, status immunities, surges,
 * synthetic damage cards (api.applyDamage), resolve delay / Dice So Nice wait, confirmation dialog.
 * Milestone 2 (durations, saves, ongoing damage; libWrapper required):
 *   LIFECYCLE  one turn start/end event per combatant on the active GM, Combat Tools squad turns
 *              included; the system's end-of-turn save trigger runs once        (turn/lifecycle.mjs)
 *   SAVES      NPC saves roll themselves, heroes are asked on their owner's client (turn/saves.mjs)
 *   ONGOING    Burning-style damage ticks once per turn through a damage card    (turn/ongoing.mjs)
 *   UNTIL      "until the end of your next turn" / "until it moves" / dying ends  (turn/until.mjs)
 *   FIXES      save cards keep their part; encounter effects go when a combatant leaves (compat/system-fixes.mjs)
 * Milestone 3 (movement and per-row edits):
 *   FORCED     push / pull / slide rows per target and tier, moved through Combat Tools (its engine,
 *              undo log) or a straight line of our own; Combat Tools' own buttons locked once moved
 *              (engine/forced.mjs, delegation/forced-movement.mjs, ui/dstd-lock.mjs)
 *   TELEPORT   api.teleport cards, Combat Tools' square picker or a given destination (delegation/teleport.mjs)
 *   EDIT       change a row's amount, distance or movement type, heal as temporary Stamina (engine editOp)
 *   SPEND      the roll dialog's @spend reaches forced distances (engine/spend.mjs)
 * Milestone 4 (ability library):
 *   REGISTRY   overlays registered by content modules on `dsAuto.init`, looked up by identity at use time,
 *              nothing written to items (library/registry.mjs, identity.mjs, schema.mjs)
 *   RESOLVE    detached entries > item flags > overlay > native; Combat Tools' own automation wins per
 *              kind (library/resolve.mjs); its "choose one" picks filter effects (library/choose-compat.mjs)
 *   ROWS       library effects become rows, incl. cleanse / resource / note, the user's own row and
 *              "choose one" groups (engine/library-plan.mjs, library-apply.mjs)
 *   ENTRIES    `dsAuto.*` special effects for detached automation, kept through Combat Tools' pack
 *              refresh and Update Source (types/special-effects.mjs, library/keeper.mjs, actions.mjs)
 * Milestone 5 (triggered actions, trackers; docs/M5-DESIGN.md):
 *   ENGINE     one trigger engine on the active GM: reactors from overlay `triggers`, eligibility, budget per
 *              round, one prompt per reactor with a server-time deadline (triggers/engine.mjs, eligibility.mjs, budget.mjs)
 *   HOLDS      our damage held by a pre-pass before anything is written; external damage (system Apply, Target
 *              Damage, Combat Tools) held by a takeDamage wrapper with a two-phase commit (triggers/holds.mjs, external.mjs)
 *   PROMPTS    the prompt query routes by type (save, trigger, triggerCancel, triggerRun); owner dialog with a
 *              countdown, Director indicator with Release (relay/prompt-router.mjs, triggers/prompt.mjs, ui/trigger-*.mjs)
 *   CARDS      a trigger card per landed reaction (budget anchor, cost, notes), GM-only undo that revokes
 *              that reaction on its origin card; follow-ups run on the owner's client (triggers/card.mjs)
 *   ROLLS      Word of Guidance: the roll dialog waits for an edge (triggers/roll-lock.mjs)
 *   TRACKERS   Judgement / Mark: a new target at 0 Stamina, older effects end (triggers/trackers.mjs)
 *   TURNS      Hesitation is Weakness on our turnEnd event unless Combat Tools does it (triggers/turn-order.mjs)
 * Milestone 6 (summoning; docs/M6-DESIGN.md):
 *   SUMMON     library effect `summon` -> one row on the summoner's own row, never automatic; world actors imported
 *              or reused in "Summons (ds-auto)" at resolve time; the GM validates and creates the tokens
 *              (engine/library-plan.mjs, engine/summon.mjs, summons/actors.mjs, summons/squares.mjs)
 *   PLACE      the row's Summon button: core placeTokens(create: false) on the clicking owner's client, squares
 *              relayed in `apply` (summons/place.mjs); api.summon for the Director (engine/synthetic.mjs)
 *   COMBAT     combatants and minion squads when the summoner's token is in a started combat (summons/combat.mjs)
 *   CHAIN      "acts after the summoner": held at initiative 0, made current at the summoner's turn end
 *              (summons/turn-chain.mjs; registered before Hesitation is Weakness)
 *   REGISTRY   token flags, the combat index, end triggers, dismissal and its relay (summons/registry.mjs)
 *   UPKEEP     Persistent upkeep asked at the summoner's turn start with a countdown (summons/upkeep.mjs,
 *              ui/summon-upkeep.mjs)
 * Milestone 7 (resources and zones; docs/M7-DESIGN.md):
 *   GAINS      class features' `gains` rules: facts (our damage, GM-observed external damage, forced moves, ability
 *              cards, natural rolls, winded, hero deaths) -> undoable `gain` rows on the damage card or a gain card,
 *              claimed per round / encounter (resources/rules.mjs, facts.mjs, gains.mjs, gain-card.mjs, stamina-watch.mjs)
 *   NATIVE     the system's "gain N surges" power-roll effects become resource rows (engine/plan.mjs); the system's own
 *              button is locked once ours applied (ui/gain-lock.mjs)
 *   TOKENS     a lethal hit on a hero offers 2 hero tokens for the recovery value, as a heal row before the hit
 *              (resources/hero-tokens.mjs, ui/hero-token-dialog.mjs)
 *   MALICE     NPC trigger costs, Malice cards (relay malice), reminder whispers, villain-action tracking
 *              (resources/world-resources.mjs, malice-reminders.mjs, villain.mjs, ui/malice-reminder.mjs)
 *   ZONES      library effect `zone` -> a row placed on the owner's canvas; the GM creates our own region with the
 *              `stef-ds-automation.zone` behavior; entering / starting a turn hits through damage cards, credits per round,
 *              lifetime and Persistent upkeep (zones/*, ui/zone-prompts.mjs)
 *   ACTIVATE   a player's activation of their own summon is relayed to the GM (summons/activate.mjs)
 * Milestone 8 (release hardening; docs/M8-DESIGN.md):
 *   SETTINGS   one Automation settings window with tabs; the plain list keeps `enabled` and the client settings
 *              (settings.mjs, ui/settings-menu.mjs); heroOverride migrates into modeByActorType at ready
 *   UNINSTALL  api.stripParts (chat cards) and api.cleanup (zones, until effects, summons, items, folders)
 *              (maintenance/strip.mjs, cleanup.mjs)
 *   API        api.debug (GM only) for the diagnostics, deprecated forwards until 0.11.0, a frozen compat snapshot,
 *              refusals that throw, api.version / apiVersion / modeFor
 */
import { HOOKS, MODULE_ID, loc } from "./constants.mjs";
import { compat, detectCompat } from "./compat/version-gate.mjs";
import { log } from "./log.mjs";
import { migrateModes, registerSettings, registerSettingsMenu, setting } from "./settings.mjs";
import { dump, partTypeRegistered, selfCheck } from "./self-check.mjs";
import { onPreCreateChatMessage } from "./engine/seed.mjs";
import { isActiveGM, onCreateChatMessage, onUpdateChatMessage, sweepOnReady, trustCard } from "./engine/engine.mjs";
import { integrity, migrateLedger } from "./engine/ledger.mjs";
import { getResolution } from "./engine/record.mjs";
import { partActions, registerResolutionPart } from "./parts/resolution-part.mjs";
import { registerRelay, requestOp } from "./relay/queries.mjs";
import { registerDstdLock } from "./ui/dstd-lock.mjs";
import { loadDsctHandlerProbes as dsctHandlerProbes } from "./compat/dsct.mjs";
import { registerDstdFold } from "./ui/dstd-fold.mjs";
import { registerTeleportMessageFold } from "./ui/teleport-message-fold.mjs";
import { rerenderCards } from "./ui/rerender.mjs";
import { registerPromptDialog } from "./ui/prompt-dialog.mjs";
import { registerSystemFixes } from "./compat/system-fixes.mjs";
import { registerLifecycle } from "./turn/lifecycle.mjs";
import { registerSaves, runSave } from "./turn/saves.mjs";
import { ongoingSpecs, registerOngoing } from "./turn/ongoing.mjs";
import { registerUntil, setUntil, untilSpecs } from "./turn/until.mjs";
import { registerSpendCapture } from "./engine/spend.mjs";
import { registerUseChoice } from "./ui/use-choice.mjs";
import { allOverlays, findOverlay, hasOverlay, onRegistryChange, overlaysFor, registerSource, registryInfo, unregisterSource } from "./library/registry.mjs";
import { abilityStatus, dsctEnhancedState, resolveAbility } from "./library/resolve.mjs";
import { fullKey, itemKey, monsterKey } from "./library/identity.mjs";
import { configure, detach, reset, resync, setDisabled, setLocked } from "./library/actions.mjs";
import { compareVersions, validateOverlay } from "./library/schema.mjs";
import { registerKeeper } from "./library/keeper.mjs";
import { registerMoveLog } from "./engine/move-log.mjs";
import { entryTypesRegistered, registerEntryPartial, registerEntryTypes } from "./types/special-effects.mjs";
import { registerPromptRouter, registerPromptType } from "./relay/prompt-router.mjs";
import { handleDiceWait } from "./relay/dice-wait.mjs";
import { handleTriggerCancel, handleTriggerPrompt, handleTriggerRun } from "./ui/trigger-dialog.mjs";
import { registerIndicator } from "./ui/trigger-indicator.mjs";
import {
  listTriggers, offer, registerTriggerEngine, releaseDecisions, reportDecisions, serverNow, triggersActive,
} from "./triggers/engine.mjs";
import { budgetInfo, registerBudget } from "./triggers/budget.mjs";
import { registerTriggerCards } from "./triggers/card.mjs";
import { cancelPrompt, openPrompts, promptMs, registerPromptGM } from "./triggers/prompt.mjs";
import { registerRollLock } from "./triggers/roll-lock.mjs";
import { registerExternalWrappers, registerForcedGate } from "./triggers/external.mjs";
import { registerTrackers } from "./triggers/trackers.mjs";
import { registerTurnOrder } from "./triggers/turn-order.mjs";
import { EVENT_PHASE } from "./triggers/taxonomy.mjs";
import { listSummons, registerSummons, summonInfo } from "./summons/registry.mjs";
import { handleSummonUpkeep, handleSummonUpkeepCancel } from "./ui/summon-upkeep.mjs";
import { chooseActor, pickForApi } from "./summons/place.mjs";
import { ensureWorldActor, summonSourceUuid } from "./summons/actors.mjs";
import { normalizeSummonRequest } from "./engine/synthetic.mjs";
// Milestone 7.
import { gainRulesOf, registerRuleCache } from "./resources/rules.mjs";
import { gainLedger, registerGains, releaseLedgerEntry } from "./resources/gains.mjs";
import { registerStaminaWatch } from "./resources/stamina-watch.mjs";
import { registerReviveOnHeal } from "./resources/revive-on-heal.mjs";
import { registerGainObservers } from "./resources/gain-card.mjs";
import { registerHeroTokens } from "./resources/hero-tokens.mjs";
import { registerMaliceReminders } from "./resources/malice-reminders.mjs";
import { registerVillainTracking, resetVillain, villainUsed } from "./resources/villain.mjs";
import { worldValue } from "./resources/world-resources.mjs";
import { registerZoneBehavior } from "./zones/behavior.mjs";
import { listZones, regionOfZone, registerZones, zoneBehavior, zoneInfo, zoneOf } from "./zones/registry.mjs";
import { hitZone, registerZoneEngine } from "./zones/engine.mjs";
import { creditKey } from "./zones/ledger.mjs";
import { footprintSquares } from "./zones/shapes.mjs";
import { registerZoneUpkeepGM } from "./zones/upkeep.mjs";
import { registerPersistent } from "./persistent/registry.mjs";
import { handlePersistentUpkeep, handlePersistentUpkeepCancel } from "./ui/persistent-prompts.mjs";
import { handleHeroTokenRegain, handleHeroTokenRegainCancel } from "./ui/hero-token-dialog.mjs";
import { handleZoneUpkeep, handleZoneUpkeepCancel } from "./ui/zone-prompts.mjs";
import { handleTeleportStep } from "./ui/teleport-followup.mjs";
import { handleForcedStep } from "./delegation/forced-picker.mjs";
import { handleCleanseChoice } from "./ui/cleanse-choice.mjs";
import { handleTargetPick } from "./ui/target-pick.mjs";
import { registerGainLock } from "./ui/gain-lock.mjs";
import { registerMaliceReminderUI } from "./ui/malice-reminder.mjs";
import { registerSummonActivate } from "./summons/activate.mjs";
// Milestone 8.
import { automationSettingsClass } from "./ui/settings-menu.mjs";
import { stripParts } from "./maintenance/strip.mjs";
import { cleanup } from "./maintenance/cleanup.mjs";
import { modeFor as actorModeFor } from "./engine/actor-category.mjs";
import { registerPartLock } from "./ui/part-lock.mjs";
import { registerNativeSummon } from "./summons/native.mjs";
import { registerSourceDefeat } from "./turn/source-defeat.mjs";
import { registerFrightenedWarning } from "./ui/frightened-warning.mjs";
import { legacy } from "./maintenance/legacy.mjs";

// Import time: the part type must exist before the ChatMessage schema is first built, and our special
// effect types before world items carrying them are validated.
const partRegisteredAtImport = registerResolutionPart();
registerEntryTypes();

/** Run a medkit action and announce it (`dsAuto.medkitApplied`). */
const medkitAction = (action, fn) => async (item, ...args) => {
  const doc = typeof item === "string" ? await fromUuid(item) : item;
  const result = await fn(doc, ...args);
  Hooks.callAll(HOOKS.medkitApplied, doc, { action, overlay: findOverlay(doc), result });
  return result;
};

partActions.request = requestOp;

/** An actor, a token (document or placeable) or a uuid, as an Actor (api.triggers). */
function actorOf(actorOrUuid) {
  let doc = actorOrUuid;
  try {
    if (typeof doc === "string") doc = fromUuidSync(doc);
  } catch (_err) {
    return null;
  }
  if (!doc) return null;
  return doc.documentName === "Token" || doc.document ? (doc.actor ?? null) : doc;
}

/* ---------- Milestone 8: API hardening (docs/M8-DESIGN.md §7) ---------- */

/** api.apiVersion: bumped on a breaking change of the public API (MAJOR from 1.0.0 on). */
const API_VERSION = 1;

/**
 * Relay actions only the module's own clients send (two-phase commits, roll locks, picks): api.debug.request refuses
 * them unless `{internal: true}` is passed, the deprecated api.request always.
 */
const INTERNAL_ACTIONS = new Set([
  "hold", "holdDone", "preRoll", "preRollCancel", "preRollDone", "moveGate", "fmActive", "triggerCommit", "halfMark",
  "summonPrepare", "nativeSummon",
]);

/** Directors only (api.debug). */
function gmOnly() {
  if (!game.user?.isGM) throw new Error("DSAUTO.Relay.Denied");
}

/** A GM who is not the active GM is told so (a player keeps the old `false`: they could never do it). */
function refuseInactiveGM() {
  if (game.user?.isGM && !isActiveGM()) throw new Error("DSAUTO.Relay.NotActiveGM");
}

function refuseInternal(payload, internal) {
  if (!internal && INTERNAL_ACTIONS.has(payload?.action)) throw new Error("DSAUTO.Relay.BadRequest");
}

/** One console warning per deprecated member (removed in 0.11.0). */
const warnedDeprecated = new Set();
function deprecated(oldName, newName) {
  if (warnedDeprecated.has(oldName)) return;
  warnedDeprecated.add(oldName);
  let text = `${oldName} -> ${newName}`;
  try {
    const localized = loc("DSAUTO.Api.Deprecated", { old: oldName, new: newName });
    if (localized && !localized.startsWith("DSAUTO.")) text = localized;
  } catch (_err) { /* before i18n */ }
  console.warn(`${MODULE_ID} | ${text}`);
}

/** Active GM, dev and testing: prompt the reactors of a trigger event (or a list); no hold, no card. */
async function offerEvents(events) {
  const list = (Array.isArray(events) ? events : [events]).filter(e => e && typeof e === "object");
  if (!list.length) return [];
  const decisions = await offer(list, { phase: EVENT_PHASE[list[0].kind] ?? "gate", deadline: serverNow() + promptMs() + 5_000 });
  reportDecisions(decisions);
  releaseDecisions(decisions);
  return decisions;
}

/**
 * Active GM, dev and testing: run a zone's hit on a token now (via "manual": the `enter` credit of this round, or none
 * for once "none"); honours that credit unless `force`. Resolves {messageId} or null.
 */
async function hitZoneNow(zoneId, tokenOrUuid, { force = false } = {}) {
  if (!isActiveGM()) throw new Error("DSAUTO.Relay.NotActiveGM");
  const region = regionOfZone(zoneId);
  if (!region || !zoneOf(region)) return null;
  const sys = zoneBehavior(region)?.system;
  let tokenDoc = tokenOrUuid;
  if (typeof tokenDoc === "string") tokenDoc = syncDoc(tokenDoc);
  if (tokenDoc?.document) tokenDoc = tokenDoc.document;
  if (!sys || !tokenDoc?.actor) return null;
  const squares = sys.perSquare ? Math.max(1, footprintSquares(tokenDoc, region)?.size ?? 0) : 1;
  return hitZone(region, tokenDoc, { via: "manual", squares, creditKey: creditKey(sys, "manual"), force: !!force });
}

/** api.modeFor: {category, mode} of a creature for a kind of result (engine/actor-category.mjs); unknown kinds refused. */
const MODE_KINDS = new Set(["damage", "heal", "temp", "healing", "condition", "cleanse", "forced", "teleport", "resource", "summon", "zone", "zoneDamage", "ongoing", "gain"]);
function modeFor(actorOrToken, kind = "damage") {
  if (!MODE_KINDS.has(kind)) throw new Error("DSAUTO.Relay.BadRequest");
  return actorModeFor(actorOrToken, kind);
}

/** The GM-only diagnostics (docs/M8-DESIGN.md §7, D25). */
const debugApi = Object.freeze({
  /** Print and return a card's record (latest card by default). */
  dump: (messageId) => {
    gmOnly();
    return dump(messageId);
  },
  /** Call a relay action directly; the module's internal actions need `{internal: true}`. */
  request: async (payload, { internal = false } = {}) => {
    gmOnly();
    refuseInternal(payload, internal);
    return requestOp(payload);
  },
  triggers: Object.freeze({
    /** Active GM: prompt the reactors of a trigger event (or a list); no hold, no card. */
    offer: async (events) => {
      gmOnly();
      return offerEvents(events);
    },
  }),
  zones: Object.freeze({
    /** Active GM: run a zone's hit on a token now (`force` ignores the round's credit). */
    hit: async (zoneId, tokenOrUuid, options = {}) => {
      gmOnly();
      return hitZoneNow(zoneId, tokenOrUuid, options);
    },
  }),
});

const api = {
  /** The module's version (set at init) and the API contract version. */
  version: null,
  apiVersion: API_VERSION,
  selfCheck,
  /** Deprecated (0.10.0): api.debug.dump. Removed in 0.11.0. */
  dump: (messageId) => {
    deprecated("api.dump", "api.debug.dump");
    return debugApi.dump(messageId);
  },
  /** Detection state at the time of the call: a frozen copy (callers cannot change what the module detected). */
  get compat() {
    return Object.freeze({ ...compat });
  },
  setting,
  /** 1.0.0: import the data of the pre-1.0 modules again (`{dryRun: true}` only reports, `{force: true}` reruns). */
  migrateLegacy: options => legacy.migrate(options),
  /** GM-only diagnostics: dump, request, triggers.offer, zones.hit. */
  debug: debugApi,

  getResolution: messageOrId => getResolution(typeof messageOrId === "string" ? game.messages.get(messageOrId) : messageOrId),
  // Card actions, relayed to the active GM and authorized there like the card buttons.
  /** Resolve a card (again). `force` re-runs a resolved card (GM only); applied ops are kept. */
  resolve: (messageId, { force = false } = {}) => requestOp({ action: "resolve", messageId, force }),
  applyOps: (messageId, opIds = null, { half = false } = {}) => requestOp({ action: "apply", messageId, opIds, half }),
  undoOps: (messageId, opIds = null) => requestOp({ action: "undo", messageId, opIds }),
  retarget: (messageId, tokenUuids) => requestOp({ action: "retarget", messageId, tokenUuids }),
  /**
   * Spend the card's hero's surges: `count` (1-3) as extra damage on damage row `opId`, or
   * `{potency: true}` for +1 potency (2 surges) on a condition row resisted by exactly one.
   */
  surge: (messageId, opId, { count = 1, potency = false } = {}) =>
    requestOp(potency ? { action: "surge", messageId, opId, potency: true } : { action: "surge", messageId, opId, count }),
  /**
   * Post a damage, healing or temporary Stamina card that applies like an ability's results, with undo
   * (Directors only). Resolves with `{ok, messageId, ops}`.
   * @param {object} options
   * @param {Array<string|Token|TokenDocument>|string} options.targets   Token uuids or tokens.
   * @param {number} options.amount
   * @param {string} [options.type]                  Damage type key ("" = untyped).
   * @param {string[]} [options.ignoredImmunities]
   * @param {boolean} [options.aoe]                  Area damage: minion squads take the area cap.
   * @param {Actor|Token|string} [options.source]    Who deals it (speaker and Death Tracker attribution).
   * @param {string} [options.flavor]                Card title.
   * @param {boolean} [options.half]                 Half damage, rounded down.
   * @param {"damage"|"heal"|"temp"} [options.kind]
   * @param {"auto"|"prompt"|"manual"} [options.mode] "auto" applies at once (default).
   */
  applyDamage: (options = {}) => requestOp({ action: "damage", damage: serializeDamageOptions(options) }),
  // Milestone 3.
  /**
   * Change a row before applying it (relayed; allowed to whoever may apply it). `edits`: `amount`
   * (damage / healing), `temp` (heal as temporary Stamina), `distance` and `movement` (forced movement);
   * null resets a field to the ability's value. `apply: true` applies the row afterwards.
   */
  editOp: (messageId, opId, edits = {}, { apply = false } = {}) => requestOp({ action: "edit", messageId, opId, edits, apply }),
  /**
   * Force-move creatures on a card with undo (Directors only). Resolves with `{ok, messageId, ops}`.
   * @param {object} options
   * @param {Array<string|Token|TokenDocument>|string} options.targets
   * @param {"push"|"pull"|"slide"} options.movement
   * @param {number} options.distance                 Squares before stability.
   * @param {string|Token|TokenDocument} [options.source]  Who pushes or pulls (needed for push and pull).
   * @param {boolean} [options.vertical]
   * @param {boolean} [options.ignoreStability]
   * @param {string[]} [options.properties]           Combat Tools' "no-collision-damage" family.
   * @param {"straight"|"choose"} [options.path]       "choose": the Director picks the path (Combat Tools).
   * @param {"auto"|"prompt"|"manual"} [options.mode]
   * @param {string} [options.flavor]
   */
  forcedMovement: (options = {}) => requestOp({ action: "move", move: serializeMoveOptions("forced", options) }),
  /**
   * Teleport a creature on a card with undo (Directors only). Without `destination` the active Director
   * picks the square through Combat Tools.
   * @param {object} options
   * @param {string|Token|TokenDocument} options.token
   * @param {number} [options.distance]                Squares (default 5).
   * @param {"normal"|"swap"|"adjacent"} [options.teleportMode]
   * @param {string|Token|TokenDocument} [options.partner]   Swap / adjacent partner.
   * @param {{x: number, y: number, elevation?: number}} [options.destination]  Top-left corner, in pixels.
   * @param {boolean} [options.animate]
   * @param {"auto"|"prompt"|"manual"} [options.mode]
   * @param {string} [options.flavor]
   */
  teleport: (options = {}) => requestOp({ action: "move", move: serializeMoveOptions("teleport", options) }),
  // Milestone 6.
  /**
   * Summon creatures for a summoner on a card with undo and Dismiss (Directors only). With `places` "pick" (or the
   * setting summonPlacement "pick") the calling Director picks the squares on their canvas first; "auto" lets the
   * active GM take the nearest free squares; an array gives them. Resolves `{ok, messageId, ops}`, or
   * `{ok: false, cancelled: true}` when the pick was cancelled.
   * @param {object} options
   * @param {string|Token|TokenDocument} options.summoner
   * @param {string} [options.actor]                  One stat block (compendium Actor uuid or "Actor.<id>").
   * @param {string[]} [options.actors]               1-6 stat blocks (a choice).
   * @param {number} [options.quantity]               1-10 (default 1).
   * @param {number} [options.distance]               Squares (default 10).
   * @param {"self"|"target"} [options.origin]
   * @param {string|Token|TokenDocument} [options.anchor]   origin "target": the token it appears next to.
   * @param {"summoner"|"hostile"} [options.side]
   * @param {"after"|"own"|"with"|"none"} [options.turn]
   * @param {boolean} [options.actsThisRound]
   * @param {"join"|"new"|"none"} [options.squad]
   * @param {string[]} [options.lasts]
   * @param {number|null} [options.upkeep]
   * @param {"pick"|"auto"|object[]} [options.places]
   * @param {string} [options.pick]                   The chosen stat block when several.
   * @param {string} [options.flavor]
   * @param {"auto"|"prompt"|"manual"} [options.mode]
   */
  summon: (options = {}) => apiSummon(options),
  /**
   * Deprecated (0.10.0): api.debug.request. Calls a relay action directly (`{action, messageId, ...}`, authorized per
   * action on the active GM); the module's internal actions are refused. Removed in 0.11.0.
   */
  request: async (payload) => {
    deprecated("api.request", "api.debug.request");
    return debugApi.request(payload);
  },
  /** Record integrity of a card: fresh | ok | tampered | unsigned (engine/ledger.mjs). */
  integrity: messageId => integrity(game.messages.get(messageId)),
  /** Active GM: accept a locked card's current record after checking it (`api.dump(id)`). */
  trustCard: messageId => trustCard(game.messages.get(messageId)),
  // Milestone 2.
  /**
   * Add end conditions to an effect (see turn/until.mjs): `{event: "turnEnd"|"turnStart", combatantId}`,
   * `{event: "dying"}`, `{event: "moves"}`, or a list. `keepExpiry` keeps the effect's own end too.
   */
  until: (effect, specs, options) => setUntil(effect, specs, options),
  untilSpecs: effect => untilSpecs(typeof effect === "string" ? fromUuidSync(effect) : effect),
  /** Ongoing damage specs the turn-start/turn-end tick would use for this effect. */
  ongoingSpecs: effect => ongoingSpecs(typeof effect === "string" ? fromUuidSync(effect) : effect),
  /** Active GM: roll a "save ends" effect's save now, by policy ("prompt" | "auto"; default per setting). */
  rollSave: async (effect, { policy } = {}) => {
    if (!isActiveGM()) throw new Error("DSAUTO.Relay.NotActiveGM");
    const doc = typeof effect === "string" ? await fromUuid(effect) : effect;
    if (!doc) throw new Error("DSAUTO.Relay.BadRequest");
    return policy ? runSave(doc, policy) : runSave(doc);
  },
  // Milestone 4: ability library.
  library: {
    /** Content modules: `Hooks.once("dsAuto.init", api => api.library.registerSource({id, overlays, priority}))`. */
    registerSource,
    unregisterSource,
    onChange: onRegistryChange,
    info: registryInfo,
    all: allOverlays,
    overlaysFor,
    has: hasOverlay,
    /** The overlay an item uses (monster-specific first), or null. */
    find: item => findOverlay(typeof item === "string" ? fromUuidSync(item) : item),
    /** What the engine will use for this ability (layers, effects, status). */
    resolve: item => resolveAbility(typeof item === "string" ? fromUuidSync(item) : item),
    status: item => abilityStatus(typeof item === "string" ? fromUuidSync(item) : item),
    validate: validateOverlay,
    compareVersions,
    keys: { itemKey, monsterKey, fullKey },
    dsctState: item => dsctEnhancedState(typeof item === "string" ? fromUuidSync(item) : item),
    // Item actions (owners only; flags and our own entries only).
    configure: medkitAction("configure", configure),
    disable: medkitAction("disable", (item, disabled = true) => setDisabled(item, disabled)),
    lock: medkitAction("lock", (item, locked = true) => setLocked(item, locked)),
    detach: medkitAction("detach", detach),
    resync: medkitAction("resync", resync),
    reset: medkitAction("reset", reset),
    entryTypesRegistered,
    validateAutomation,
    editableAutomation,
    presetDraft,
    saveAutomation: medkitAction("saveAutomation", saveAutomation),
    clearAutomation: medkitAction("clearAutomation", clearAutomation),
    presets, savePreset, deletePreset,
    useAutomation: (item, tokenUuids = []) => requestOp({ action: "featureUse", itemUuid: typeof item === "string" ? item : item.uuid, tokenUuids }),
    setAura: (item, active = false) => requestOp({ action: "auraControl", itemUuid: typeof item === "string" ? item : item.uuid, active }),
    enhanceAura: item => requestOp({ action: "auraControl", itemUuid: typeof item === "string" ? item : item.uuid, enhance: true }),
    setPerformance: (item, active = true) => requestOp({ action: "performanceSet", itemUuid: typeof item === "string" ? item : item.uuid, active }),
    applyPreset: medkitAction("applyPreset", applyPreset),
  },
  // Milestone 5: triggered actions.
  triggers: {
    /** Engine on (setting, not deferred to Draw Steel: Triggers). Any client. */
    active: () => triggersActive(),
    /** The triggers and trackers of an actor's abilities: [{itemUuid, name, triggers, trackers}]. Any client. */
    reactors: actorOrUuid => listTriggers(actorOf(actorOrUuid)),
    /** The round's triggered action: {tracked, available, source, usedAbility, round}. Any client. */
    budget: actorOrUuid => budgetInfo(actorOf(actorOrUuid)),
    /** Active GM: prompts open right now: [{promptId, reactorName, abilities, deadline}]. */
    open: () => openPrompts(),
    /** Active GM: cancel a prompt (counts as declined). */
    release: promptId => cancelPrompt(promptId, "released"),
    /** Deprecated (0.10.0): api.debug.triggers.offer (Directors only). Removed in 0.11.0. */
    offer: async (events) => {
      deprecated("api.triggers.offer", "api.debug.triggers.offer");
      return debugApi.triggers.offer(events);
    },
  },
  // Milestone 6: summons (token flags are the truth; every client reads them).
  summons: {
    /** Live summons: [SummonInfo]; filter {summonerActorUuid?, sceneId?, combatId?, summonId?}. Any client. */
    list: (filter = {}) => listSummons(filter),
    get: summonId => summonInfo(summonId),
    /** Summons of an actor (Actor, Token, TokenDocument or uuid). Any client. */
    of: actorOrToken => {
      const actor = actorOf(actorOrToken);
      return actor?.uuid ? listSummons({ summonerActorUuid: actor.uuid }) : [];
    },
    /** Relayed (the Director, the summoner's owners, the summon's owners). Resolves {ok, removed, gone}. */
    dismiss: summonId => requestOp({ action: "summonDismiss", summonDismiss: { summonId } }),
    /** Active GM: the world actor of a stat block for a source item (imported when missing), or null. */
    worldActor: async (compendiumUuid, itemOrUuid) => {
      if (!isActiveGM()) throw new Error("DSAUTO.Relay.NotActiveGM");
      const item = typeof itemOrUuid === "string" ? await fromUuid(itemOrUuid).catch(() => null) : itemOrUuid;
      const sourceUuid = item ? summonSourceUuid(item) : null;
      if (!sourceUuid) throw new Error("DSAUTO.Relay.BadRequest");
      const { actor } = await ensureWorldActor(compendiumUuid, { sourceUuid });
      return actor ?? null;
    },
  },
  // Milestone 7: resources (docs/M7-DESIGN.md §1.10).
  resources: {
    /** Gain rules of a hero (Actor, Token or uuid): [{featureKey, ruleKey, rule, amount, formula}]. Any client. */
    rules: actorOrUuid => {
      const actor = actorOf(actorOrUuid);
      return actor ? gainRulesOf(actor) : [];
    },
    /** The hero's ledger entries {round: {<ruleKey>: entry}, encounter: {...}} (combat: its own, by default). Any client. */
    ledger: (actorOrUuid, combat = undefined) => gainLedger(combat ?? null, actorOf(actorOrUuid)),
    /**
     * Active GM: release one ledger entry (the Director grants it again by hand). Resolves true when one went; another
     * Director gets DSAUTO.Relay.NotActiveGM, a player false.
     */
    release: async (actorOrUuid, ruleKey, { encounter = false } = {}) => {
      refuseInactiveGM();
      return releaseLedgerEntry(null, actorOf(actorOrUuid), ruleKey, { encounter });
    },
    /** The party's hero tokens. Any client. */
    heroTokens: () => worldValue("heroToken"),
  },
  malice: {
    /** The Malice pool. Any client. */
    value: () => worldValue("malice"),
    /** Directors: post an undoable Malice card (relay malice). Resolves {ok, messageId, before, after}. */
    adjust: (delta, { reason = null } = {}) => requestOp({ action: "malice", malice: { delta, ...(reason == null ? {} : { reason }) } }),
  },
  villain: {
    /** Villain actions an NPC used in a combat: [{dsid, name, round, messageId}]. Any client. */
    used: (actorOrUuid, combat = undefined) => villainUsed(actorOf(actorOrUuid), combat ?? null),
    /** Active GM: forget one NPC's (or every) villain marker of a combat (another Director: NotActiveGM, a player: false). */
    reset: async (actorOrUuid = null, combat = undefined) => {
      refuseInactiveGM();
      return resetVillain(actorOrUuid == null ? null : actorOf(actorOrUuid), combat ?? undefined);
    },
  },
  // Milestone 7: zones (region flags are the truth; every client reads them).
  zones: {
    /** Live zones: [ZoneInfo]; filter {sceneId?, creatorActorUuid?, combatId?}. Any client. */
    list: (filter = {}) => listZones(filter),
    get: zoneId => zoneInfo(zoneId),
    /** Relayed (the Director or an owner of the creator). Resolves {ok, ended}. */
    dismiss: zoneId => requestOp({ action: "zoneDismiss", zoneDismiss: { zoneId } }),
    /** Deprecated (0.10.0): api.debug.zones.hit. Active GM only. Removed in 0.11.0. */
    hit: async (zoneId, tokenOrUuid, options = {}) => {
      deprecated("api.zones.hit", "api.debug.zones.hit");
      return hitZoneNow(zoneId, tokenOrUuid, options);
    },
  },
  // Milestone 8: uninstall preparation (calling GM, the active GM; dry run by default; docs/M8-DESIGN.md §6).
  /** Remove our part and flags from chat cards; automation-only cards become plain text (or are deleted / kept). */
  stripParts: (options = {}) => stripParts(options),
  /** Report (dry run) or remove zones, "until" effects, summons, item customizations and the summons folder. */
  cleanup: (options = {}) => cleanup(options),
  /**
   * End a native targeted condition (frightened, taunted, grabbed) on a creature, or one grab source (relayed; Directors,
   * the creature's owners, the source's owners). Resolves {ok, ended: "effect"|"source"|"none"}.
   */
  endTargeted: (actorOrUuid, statusId, { sourceUuid = null } = {}) => {
    const actor = actorOf(actorOrUuid);
    const actorUuid = actor?.uuid ?? (typeof actorOrUuid === "string" ? actorOrUuid : null);
    const source = sourceUuid == null ? null : (typeof sourceUuid === "string" ? sourceUuid : (actorOf(sourceUuid)?.uuid ?? null));
    return requestOp({ action: "endTargeted", endTargeted: { actorUuid, statusId, sourceUuid: source } });
  },
  /** The mode a result of `kind` on this creature gets: {category, mode}. Any client, read-only. */
  modeFor,
};

/** api.applyDamage options as plain data (tokens and actors become uuids) for the relay. */
function serializeDamageOptions(options) {
  const uuidOf = v => (typeof v === "string" ? v : (v?.document?.uuid ?? v?.uuid ?? null));
  const list = options.targets == null ? [] : (Array.isArray(options.targets) || options.targets instanceof Set ? [...options.targets] : [options.targets]);
  return { ...options, targets: list.map(uuidOf).filter(Boolean), source: options.source == null ? null : uuidOf(options.source.actor ?? options.source) };
}

/** api.forcedMovement / api.teleport options as plain data (tokens become uuids) for the relay. */
function serializeMoveOptions(kind, options) {
  const uuidOf = v => (typeof v === "string" ? v : (v?.document?.uuid ?? v?.uuid ?? null));
  const list = v => (v == null ? [] : (Array.isArray(v) || v instanceof Set ? [...v] : [v])).map(uuidOf).filter(Boolean);
  const out = { ...options, kind };
  if ("targets" in options) out.targets = list(options.targets);
  for (const key of ["source", "token", "partner"]) if (key in options) out[key] = options[key] == null ? null : uuidOf(options[key]);
  return out;
}

/** api.summon options as plain data (tokens become uuids) for the relay. */
function serializeSummonOptions(options) {
  const uuidOf = v => (typeof v === "string" ? v : (v?.document?.uuid ?? v?.uuid ?? null));
  const out = { ...options };
  for (const key of ["summoner", "anchor"]) if (key in options) out[key] = options[key] == null ? null : uuidOf(options[key]);
  if ("actor" in options && options.actor != null) out.actor = uuidOf(options.actor);
  if (Array.isArray(options.actors)) out.actors = options.actors.map(uuidOf);
  if (Array.isArray(options.places)) out.places = options.places.map(sq => ({ ...sq }));
  return out;
}

/** A token document from a uuid, or null. */
function syncDoc(uuid) {
  try {
    return uuid ? (fromUuidSync(uuid) ?? null) : null;
  } catch (_err) {
    return null;
  }
}

/**
 * api.summon on the calling client (§3.13): Directors only (refused before any picker: core placeTokens would throw
 * on actorless previews). "pick" picks the squares here when the Director views the summoner's scene; otherwise the
 * card waits for its Summon button.
 */
async function apiSummon(options = {}) {
  if (!game.user?.isGM) throw new Error("DSAUTO.Relay.Denied");
  const req = serializeSummonOptions(options ?? {});
  const norm = normalizeSummonRequest(req);   // the shape check before picking (throws DSAUTO.Relay.BadRequest)
  const places = req.places === "auto" || Array.isArray(req.places) ? req.places
    : (req.places == null && (setting("summonPlacement") ?? "pick") === "auto" ? "auto" : "pick");
  if (places === "pick") {
    const summonerDoc = syncDoc(norm.summoner);
    const anchorDoc = norm.origin === "target" ? syncDoc(norm.anchor) : summonerDoc;
    if (summonerDoc && summonerDoc.parent?.id === globalThis.canvas?.scene?.id) {
      const choice = norm.pick ?? (norm.actors.length === 1 ? norm.actors[0]
        : await chooseActor({ choices: norm.actors.map(u => ({ uuid: u, name: syncDoc(u)?.name ?? u })) }));
      if (!choice) return { ok: false, cancelled: true };
      const picked = await pickForApi({
        summonerDoc, anchorDoc, choice: { uuid: choice }, quantity: norm.quantity, distance: norm.distance, origin: norm.origin,
      });
      if (!picked) return { ok: false, cancelled: true };
      req.places = picked.squares;
      req.pick = picked.actor;
    } else req.places = null;   // not viewing the summoner's scene: the card waits for the Summon button
  } else req.places = places;
  return requestOp({ action: "summon", summon: req });
}


/** World settings that change which buttons or numbers a card shows. */
const VIEW_SETTINGS = new Set(["cardActionRole", "playerCardActions", "hideNpcNumbersFromPlayers", "summonPlacement", "resourceGains", "zoneMode"].map(k => `${MODULE_ID}.${k}`));

/** Run one registration of the init sequence; a failure is logged and the next ones still run. */
function safely(name, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`${MODULE_ID} | ${name} failed`, err);
  }
}

Hooks.once("init", () => {
  // Milestone 7: the region behavior type first, before any scene's regions (and their behaviors) are prepared.
  safely("registerZoneBehavior", registerZoneBehavior);
  registerSettings();
  // Milestone 8: the Automation settings window (restricted button in the plain list).
  safely("registerSettingsMenu", () => registerSettingsMenu(automationSettingsClass()));
  registerRelay();
  // Milestone 5: the prompt query routes by type; saves register theirs in registerSaves.
  registerPromptRouter();
  registerSurgeChoice();
  safely("registerNativeSurgeTracking", registerNativeSurgeTracking);
  registerTemporaryStamina();
  registerAlone();
  registerMovementChoice();
  // 0.16.0: the hero-token reroll's spend type, before the system localizes the spend list (i18nInit).
  safely("registerHeroTokenSpend", registerHeroTokenSpend);
  detectCompat();
  registerDstdLock();
  // 0.13.0: Target Damage's panel folded under "Details"; Combat Tools' teleport messages for our rows folded.
  safely("registerDstdFold", registerDstdFold);
  safely("registerTeleportMessageFold", registerTeleportMessageFold);
  // Milestone 8: per-part locks of the system's buttons on 1.2 cards (every client).
  safely("registerPartLock", registerPartLock);
  registerPromptDialog();
  // Milestone 2 (libWrapper; selfCheck lists what was installed).
  registerSystemFixes();
  // Milestone 8: the system's own summons (1.2) through our engine: after detectCompat and the system fixes (D10).
  safely("registerNativeSummon", registerNativeSummon);
  registerLifecycle();
  registerSaves();
  // Milestone 5: owner-side prompt types, then the trigger engine (hooks and gates check the settings per call).
  registerPromptType("trigger", handleTriggerPrompt);
  registerPromptType("triggerCancel", handleTriggerCancel);
  registerPromptType("triggerRun", handleTriggerRun);
  // Milestone 6: Persistent upkeep on the summoner's owner's client.
  registerPromptType("summonUpkeep", handleSummonUpkeep);
  registerPromptType("summonUpkeepCancel", handleSummonUpkeepCancel);
  // Milestone 7: hero-token regain and Persistent areas on the owner's client.
  registerPromptType("heroTokenRegain", handleHeroTokenRegain);
  registerPromptType("heroTokenRegainCancel", handleHeroTokenRegainCancel);
  registerPromptType("zoneUpkeep", handleZoneUpkeep);
  registerPromptType("zoneUpkeepCancel", handleZoneUpkeepCancel);
  // Milestone 9: Persistent ability uses kept on the user's owner's client.
  registerPromptType("persistentUpkeep", handlePersistentUpkeep);
  registerPromptType("persistentUpkeepCancel", handlePersistentUpkeepCancel);
  registerPromptType("teleportStep", handleTeleportStep);
  // 0.17.0: forced moves picked in Combat Tools' picker on the ability user's screen.
  registerPromptType("forcedStep", handleForcedStep);
  // 0.17.1: the Dice So Nice wait on the roller's screen while the Director's tab is hidden.
  registerPromptType("diceWait", handleDiceWait);
  // Milestone 9: cleanse choices on the affected creature's owner's client, target picks on the user's owner's client.
  registerPromptType("cleanseChoice", handleCleanseChoice);
  registerPromptType("targetPick", handleTargetPick);
  registerTriggerEngine();
  safely("registerPerformances", registerPerformances);
  safely("registerAuras", registerAuras);
  safely("registerFeatureEngine", registerFeatureEngine);
  safely("registerTemporaryResources", registerTemporaryResources);
  registerBudget();
  registerTriggerCards();
  registerPromptGM();
  registerIndicator();
  registerRollLock();
  registerForcedGate();
  registerTrackers();
  // Milestone 6: BEFORE registerTurnOrder. The lifecycle awaits listeners in registration order, so the summon chain's
  // turn write lands before Hesitation is Weakness looks for "between turns" (R§ C6).
  registerSummons();
  registerTurnOrder();
  registerOngoing();
  // Milestone 7: AFTER registerOngoing (the lifecycle awaits listeners in order: a zone tick queues behind the same
  // turn's ongoing ticks on the creature's Stamina chain).
  registerZones();
  registerZoneEngine();
  registerZoneUpkeepGM();
  // Milestone 9: BEFORE registerUntil (a use let go at turn start is inactive before the until scan runs).
  safely("registerPersistent", registerPersistent);
  registerUntil();
  registerSpendCapture();
  // 0.15.0: library choice groups picked in the Use Ability dialog.
  safely("registerUseChoice", registerUseChoice);
  safely("registerAutomaticAreas", registerAutomaticAreas);
  // Milestone 7: resources. The Stamina watch seeds itself at ready, so it registers here, before ready.
  registerRuleCache();
  registerGains();
  registerStaminaWatch();
  registerReviveOnHeal();
  registerGainObservers();
  registerHeroTokens();
  registerMaliceReminders();
  registerVillainTracking();
  // Milestone 7: client UI.
  registerGainLock();
  registerMaliceReminderUI();
  registerSummonActivate();
  // Milestone 4.
  registerEntryTypes();
  registerEntryPartial();
  registerKeeper();
  registerMoveLog();
  // Milestone 8: native targeted conditions end with their source (active GM); frightened move warning (every client).
  safely("registerSourceDefeat", registerSourceDefeat);
  safely("registerFrightenedWarning", registerFrightenedWarning);
  const mod = game.modules.get(MODULE_ID);
  api.version = mod?.version ?? null;
  if (mod) mod.api = api;
  Hooks.callAll(HOOKS.init, api);
});

Hooks.on("preCreateChatMessage", onPreCreateChatMessage);
Hooks.on("createChatMessage", onCreateChatMessage);
Hooks.on("updateChatMessage", onUpdateChatMessage);

// Button and number visibility follow these settings: refresh the cards when they change.
// (A world setting saved for the first time is created, later saves update it.)
const onViewSetting = (doc) => {
  if (VIEW_SETTINGS.has(doc?.key)) rerenderCards();
};
Hooks.on("createSetting", onViewSetting);
Hooks.on("updateSetting", onViewSetting);

// A Director connecting or leaving changes who resolves: refresh banners, and let a GM who just
// became the active GM pick up recent unresolved cards (sweepOnReady = auto).
Hooks.on("userConnected", (user) => {
  if (!user?.isGM) return;
  // Their banner depends on whether a Director is connected.
  rerenderCards(res => !res.resolvedAt);
  sweepOnReady().catch(err => console.error(`${MODULE_ID} | sweep failed`, err));
});

Hooks.once("ready", () => {
  safely("registerFeatureCapabilities", registerFeatureCapabilities);
  safely("registerPerformanceRolls", registerPerformanceRolls);
  detectCompat({ ready: true });
  dsctHandlerProbes().catch(() => {});
  // After Combat Tools reassigned takeDamage at its init (DSCT/conditions/line-of-effect.mjs:51-71).
  registerExternalWrappers();
  const registered = partTypeRegistered();
  log("ready", {
    version: game.modules.get(MODULE_ID)?.version,
    partRegisteredAtImport,
    partTypeInSchema: registered,
    activeGM: isActiveGM(),
    enabled: setting("enabled"),
    library: registryInfo().overlays,
  });
  migrateLedger();
  // Milestone 8: heroOverride -> modeByActorType.hero once (active GM; idempotent).
  if (isActiveGM()) migrateModes().catch(err => console.error(`${MODULE_ID} | migrateModes failed`, err));
  if (!registered && game.user.isGM) {
    ui.notifications.error(game.i18n.localize("DSAUTO.Errors.PartNotRegistered"), { permanent: true });
  }
  sweepOnReady().catch(err => console.error(`${MODULE_ID} | sweep failed`, err));
  // 0.16.0: the Combat Tools family outside the verified versions.
  safely("versionBanner", versionBanner);
  safely("localizeHeroTokenSpend", localizeHeroTokenSpend);
});
