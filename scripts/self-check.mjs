/**
 * Console diagnostics: `game.modules.get("stef-ds-automation").api.selfCheck()` and `.dump(messageId)`.
 * Milestone 5 adds the trigger engine's state (active, deferred, event kinds in use, prompt types, the
 * three trigger wrappers, Combat Tools' Hesitation is Weakness and roll pills). Milestone 6 adds the summoning rows
 * (the system's own summon pieces, Combat Tools' squad labeller, the upkeep prompt type, live summons, the
 * "Summons (ds-auto)" folder and orphan summon tokens whose card row does not hold them). Milestone 7 adds resource
 * gains (rules, candidates, the Stamina watch), hero tokens, Malice, the zone behavior type and live zones.
 * Milestone 8 (docs/M8-DESIGN.md §8.1, §1.6, §2.3): every problem is `{key, data}` (`DSAUTO.SelfCheck.<id>`) and
 * `problems` holds the localized text (the English below while a key is missing, so the report always reads); the
 * report adds the 1.2 probes (card shape, `tokenUuid`, dev build), the exit cleanup mode, the native summon wrapper,
 * the targeted route and the settings menu.
 *
 * i18n keys: DSAUTO.SelfCheck.{partType, relay, queryUsers, noActiveGM, libraryInvalid, entryTypes, libWrapper,
 * takeDamage, promptTrigger, promptUpkeep, promptPersistent, zoneType, gridDistance, gainsStandDown, wrappers, nativeWithDsct, devBuild,
 * menu, unverifiedVersion, advancedEnrichers, autoApplyOwn, dsctHandlers} (English in PROBLEM_TEXT, placeholders as written there).
 * 0.16.0: the Combat Tools family's versions against the verified list (`familyVersions`, problem `unverifiedVersion`).
 * 0.17.0: the forced-movement path bridge is retired (its `forcedBridge` row with it).
 * 0.18.0 (Combat Tools 1.2.7, docs/COMBAT-TOOLS-1.2.7.md): `advancedEnrichers` (its card chips are locked like Target
 * Damage rows, but its own auto-apply bypasses every click guard), `autoApplyOwn` (this client auto-applies its own
 * abilities through Combat Tools), `dsctHandlers` (another module took over Combat Tools' movements).
 */
import { DSCT_ID, DSTD_ID, DT_ID, MODULE_ID, PART_TYPE, QUERY_OP, QUERY_PROMPT, RESOURCES_UI_ID, TRIGGERS_ID } from "./constants.mjs";
import { compat, detectCompat, familyVersions, unverifiedFamily } from "./compat/version-gate.mjs";
import { SETTING_KEYS, setting } from "./settings.mjs";
import { getResolution } from "./engine/record.mjs";
import { assignTiers, readTierParts } from "./engine/readers.mjs";
import { libWrapperReady, registrations } from "./compat/lib-wrapper.mjs";
import { installedFixes } from "./compat/system-fixes.mjs";
import { registryInfo } from "./library/registry.mjs";
import { entryTypesRegistered } from "./types/special-effects.mjs";
import { promptTypes } from "./relay/prompt-router.mjs";
import { kindsInUse, triggersActive, triggersDeferred } from "./triggers/engine.mjs";
import { dsctHandlesHiw } from "./triggers/turn-order.mjs";
import { installedTriggerWrappers } from "./triggers/external.mjs";
import { listSummons } from "./summons/registry.mjs";
import { SUMMON_FOLDER_NAME } from "./summons/actors.mjs";
import { combatFor } from "./triggers/budget.mjs";
import { gainCandidates, gainsActive } from "./resources/rules.mjs";
import { staminaWatchInfo } from "./resources/stamina-watch.mjs";
import { worldValue } from "./resources/world-resources.mjs";
import { listZones } from "./zones/registry.mjs";
import { openTallies } from "./zones/engine.mjs";
import { openZoneUpkeeps } from "./zones/upkeep.mjs";
import { nativeSummonStatus } from "./summons/native.mjs";
import * as dsct from "./compat/dsct.mjs";
import * as plan from "./engine/plan.mjs";

/** The native targeted builder (docs/M8-DESIGN.md §3.2, another work package), loaded lazily: it may be absent. */
let targetedNs = null;
import("./engine/targeted.mjs").then(m => { targetedNs = m; }).catch(() => {});

/**
 * The English of every problem (the lang file holds the same text under DSAUTO.SelfCheck.<id>); `{name}`
 * placeholders are filled from the problem's data.
 */
export const PROBLEM_TEXT = Object.freeze({
  partType: "The dsAutoResolution part type is NOT in the ChatMessage schema: cards cannot show the resolution section.",
  relay: "The card relay query is not registered: card buttons and API calls fail on every client except the active GM.",
  queryUsers: "This user lacks the 'Query users' permission: card buttons cannot reach the Director.",
  noActiveGM: "No active GM: nothing is applied until a GM is connected.",
  libraryInvalid: "{count} library overlay(s) failed validation and were skipped (api.library.info().invalid).",
  entryTypes: "The dsAuto.* special effect types are not registered: detached library automation cannot load.",
  libWrapper: "libWrapper is not active: saving throws, ongoing damage, turn deduplication and the system fixes are off.",
  takeDamage: "The takeDamage wrapper is not installed: damage from the system's Apply button, Target Damage and Combat Tools is not held for triggered actions.",
  promptTrigger: "The prompt router has no trigger type: triggered-action prompts cannot reach players.",
  promptUpkeep: "The prompt router has no summonUpkeep type: Persistent upkeep cannot be asked (summons are let go).",
  promptPersistent: "The prompt router has no persistentUpkeep type: Persistent ability uses cannot be kept (each is let go).",
  zoneType: "The stef-ds-automation.zone region behavior is not registered: zones cannot be created.",
  gridDistance: "The viewed scene's grid distance is {distance}{units} per square, not 1: areas and the system's templates come out the wrong size (set Grid Distance to 1).",
  gainsStandDown: "Gains stand down: {module} owns resource gains.",
  wrappers: "Wrappers not installed: {list}.",
  nativeWithDsct: "Targeted conditions use our own effects while Combat Tools handles conditions: its token HUD toggles act on them too ({count} of our targeted effects live).",
  devBuild: "Draw Steel {version} is a development build without the target token field: every targeted row of its cards is manual.",
  menu: "The automation settings window is not registered: world settings can only be changed through the API.",
  unverifiedVersion: "Not verified with this version of Automation Suite: {list}. Combat Tools and its companions may have changed what we rely on; run the newest Combat Tools family live check in TESTING.md before a session.",
  advancedEnrichers: "Combat Tools' Advanced Enrichers are on: their Apply chips on automated cards are locked once Automation Suite applied, but Combat Tools' own auto-apply of enrichers is not. Turn the setting off if effects land twice.",
  autoApplyOwn: "Combat Tools auto-applies this client's own abilities (\"autoApplyOwnAbilities\"): its enricher auto-apply writes without a click, so it can repeat what Automation Suite applies.",
  dsctHandlers: "Another module took over Combat Tools' {list}: Automation Suite's forced moves and teleports through Combat Tools may answer differently.",
});

/** `{id, key, data}` of one problem. */
const problem = (id, data = {}) => ({ id, key: `DSAUTO.SelfCheck.${id}`, data });

/** The text of a problem: the lang file's when it has the key, else the English of PROBLEM_TEXT. */
export function problemText({ id, key, data = {} }) {
  try {
    if (typeof game.i18n?.has === "function" && game.i18n.has(key)) return game.i18n.format(key, data);
  } catch (_err) { /* the English below */ }
  return String(PROBLEM_TEXT[id] ?? key).replace(/\{(\w+)\}/g, (m, k) => (k in data ? String(data[k]) : m));
}

/** "BaseActorModel.prototype.takeDamage" for a prototype method, else the last two segments of the path. */
function wrapperName(target) {
  const parts = String(target).split(".");
  return parts.slice(parts.at(-2) === "prototype" ? -3 : -2).join(".");
}

function foreignSetting(moduleId, key) {
  // The system's own settings (Milestone 6: draw-steel.initiativeMode) have no module entry.
  if (moduleId !== game.system?.id && !game.modules.get(moduleId)?.active) return "(module inactive)";
  try {
    return game.settings.get(moduleId, key);
  } catch (_err) {
    return "(not registered)";
  }
}

/**
 * Milestone 6 (§6.4): summon tokens whose card row is not applied with their summonId (a GM left mid-apply, a
 * record write that failed). Scene names and token names, at most 20. Api cards and gone cards count too.
 */
export function orphanSummons() {
  const out = [];
  try {
    for (const scene of game.scenes?.contents ?? []) {
      for (const t of scene.tokens?.contents ?? []) {
        const meta = t.flags?.[MODULE_ID]?.summon;
        if (!meta?.summonId) continue;
        const res = meta.messageId ? getResolution(game.messages?.get?.(meta.messageId)) : null;
        const op = res?.ops?.[meta.opId];
        if (op?.status === "applied" && op.summonId === meta.summonId) continue;
        out.push(`${t.name} (${scene.name}, ${meta.summonId})`);
        if (out.length >= 20) return out;
      }
    }
  } catch (_err) { /* diagnostics only */ }
  return out;
}

/** Milestone 7 rows of the report (resources, hero tokens, Malice, zones). Never throws. */
function m7Report() {
  const safe = (fn, fallback = "(error)") => {
    try {
      return fn();
    } catch (_err) {
      return fallback;
    }
  };
  const combat = safe(() => combatFor(globalThis.canvas?.scene?.id ?? null), null);
  const types = promptTypes();
  return {
    resourceGains: setting("resourceGains"),
    gainsActive: safe(() => gainsActive(), false),
    gainFeatures: safe(() => (registryInfo().gainFeatures ?? []).join(", ") || "(none)"),
    gainCandidates: safe(() => gainCandidates(combat).map(c => c.actor?.name).join(", ") || "(none)"),
    staminaWatch: safe(() => staminaWatchInfo().watched, 0),
    heroTokens: safe(() => worldValue("heroToken"), 0),
    malice: safe(() => worldValue("malice"), 0),
    zoneType: !!compat.zoneType,
    liveZones: safe(() => listZones().length, 0),
    openZoneTallies: safe(() => openTallies().length, 0),
    openZoneUpkeeps: safe(() => openZoneUpkeeps().length, 0),
    m7PromptTypes: ["heroTokenRegain", "heroTokenRegainCancel", "zoneUpkeep", "zoneUpkeepCancel"].every(t => types.includes(t)),
    dsctTemplateCleanup: !!compat.dsctTemplateCleanup,
    resourcesUiActive: !!compat.resourcesUi,
  };
}

/**
 * Milestone 8 rows of the report (targeted route, our native targeted effects next to Combat Tools, the settings
 * menu). Never throws. `menuRegistered` is null where the settings registry has no menus map (nothing to check).
 */
function m8Report() {
  const safe = (fn, fallback = "(error)") => {
    try {
      return fn();
    } catch (_err) {
      return fallback;
    }
  };
  const dsctOn = safe(() => !!dsct.dsctConditionsOn?.(), false);
  const menus = game.settings?.menus;
  return {
    targetedConditions: setting("targetedConditions") ?? "auto",
    targetedRoute: safe(() => plan.targetedRoute?.("frightened") ?? "(n/a)"),
    dsctConditionsOn: dsctOn,
    nativeTargetedEffects: safe(() => (dsctOn ? targetedNs?.nativeTargetedEffects?.()?.length ?? null : null), null),
    menuRegistered: menus instanceof Map ? [...menus.keys()].some(k => String(k).startsWith(`${MODULE_ID}.`)) : null,
  };
}

/** Is our part type part of the ChatMessage "standard" schema on this client? */
export function partTypeRegistered() {
  try {
    const field = CONFIG.ChatMessage.dataModels?.standard?.schema?.fields?.parts;
    return !!field?.element?.types?.[PART_TYPE];
  } catch (_err) {
    return false;
  }
}

export function selfCheck() {
  detectCompat();
  const report = {
    module: game.modules.get(MODULE_ID)?.version,
    system: compat.systemVersion,
    core: compat.coreVersion,
    user: `${game.user.name} (${game.user.isGM ? "GM" : "player"})`,
    activeGM: game.users.activeGM?.name ?? "(none)",
    iAmActiveGM: !!game.users.activeGM?.isSelf,
    partTypeRegistered: partTypeRegistered(),
    relayRegistered: typeof CONFIG.queries?.[QUERY_OP] === "function",
    canQueryUsers: !!game.user?.hasPermission?.("QUERY_USER"),
    // Milestone 8: the 1.2 card shape is read per card (engine/readers.mjs); this is what this system can write.
    cardShape: !compat.targetResult ? "tierParts" : (compat.targetTokenUuid === false ? "unknown (1.2 dev build without tokenUuid: manual)" : "targetResult (1.2.x)"),
    targetTokenUuid: compat.targetTokenUuid ?? "(not applicable)",
    abilityUseSpend: compat.abilityUseSpend,
    systemVersionPadded: compat.systemVersionPadded,
    devBuild: compat.devBuild,
    combatTools: compat.dsct,
    targetDamage: compat.dstd,
    ctlib: compat.ctlib,
    deathTracker: compat.deathTracker,
    deathTrackerVersion: game.modules.get(DT_ID)?.active ? game.modules.get(DT_ID).version : "(inactive)",
    reviveOnUndo: setting("reviveOnUndo") && !!game.modules.get(DT_ID)?.active,
    diceSoNice: typeof game.dice3d?.waitFor3DAnimationByMessageID === "function",
    drawSteelPlus: compat.dsplus,
    libWrapper: compat.libWrapper,
    systemSetBugsPresent: compat.setBugsPresent,
    // Milestone 2
    libWrapperReady: libWrapperReady(),
    wrappers: registrations.map(r => `${wrapperName(r.target)} ${r.type} ${r.ok ? "ok" : `NOT INSTALLED (${r.reason})`}`).join("; ") || "(none)",
    fixSaveMessage: installedFixes.saveMessage,
    fixExitCleanup: !!installedFixes.exitCleanup?.installed,
    fixExitCleanupMode: installedFixes.exitCleanup?.mode ?? "(not installed)",
    promptQueryRegistered: typeof CONFIG.queries?.[QUERY_PROMPT] === "function",
    expiryActionCore: CONFIG.ActiveEffect?.expiryAction ?? "(unset)",
    // Milestone 4
    librarySources: registryInfo().sources.map(s => `${s.id} (${s.overlays}, priority ${s.priority})`).join("; ") || "(none)",
    libraryOverlays: registryInfo().overlays,
    libraryInvalid: registryInfo().invalid.length,
    libraryCollisions: registryInfo().collisions.length,
    entryTypesRegistered: entryTypesRegistered(),
    // Milestone 5
    triggersActive: triggersActive(),
    triggersDeferred: triggersDeferred(),
    triggerKinds: [...kindsInUse()].sort().join(", ") || "(none)",
    promptTypes: promptTypes().join(", ") || "(none)",
    triggerWrappers: Object.entries(installedTriggerWrappers).map(([k, v]) => `${k} ${v ? "ok" : "no"}`).join("; "),
    dsctHandlesHiw: dsctHandlesHiw(),
    rollPills: compat.rollPills ?? "(unknown)",
    dsctAbilityAutomation: compat.dsctAbilityAutomation ?? "(unknown)",
    // Milestone 6
    summonTypes: compat.summonTypes,
    performSummon: compat.performSummon,
    nativeSummonWrapper: nativeSummonStatus(),
    portfolioSummon: compat.portfolioSummon,
    dsctSquadLabels: compat.dsctSquadLabels ?? "(unknown)",
    summonPromptTypes: promptTypes().includes("summonUpkeep") && promptTypes().includes("summonUpkeepCancel"),
    openSummons: listSummons().length,
    summonFolder: !!game.folders?.find?.(f => f.type === "Actor" && f.flags?.[MODULE_ID]?.summons),
    summonFolderName: SUMMON_FOLDER_NAME,
    orphanSummons: orphanSummons().join("; ") || "(none)",
    // Milestone 7
    ...m7Report(),
    // Milestone 8
    ...m8Report(),
  };
  const ours = Object.fromEntries(SETTING_KEYS.map(k => [k, setting(k)]));
  const foreign = {
    [`${DSCT_ID}.conditionsEnabled`]: foreignSetting(DSCT_ID, "conditionsEnabled"),
    [`${DSCT_ID}.grabEnabled`]: foreignSetting(DSCT_ID, "grabEnabled"),
    [`${DSCT_ID}.frightenedEnabled`]: foreignSetting(DSCT_ID, "frightenedEnabled"),
    [`${DSCT_ID}.tauntedEnabled`]: foreignSetting(DSCT_ID, "tauntedEnabled"),
    [`${DSCT_ID}.appliedEffectEnabled`]: foreignSetting(DSCT_ID, "appliedEffectEnabled"),
    [`${DSCT_ID}.applyDamageEnabled`]: foreignSetting(DSCT_ID, "applyDamageEnabled"),
    [`${DSCT_ID}.flatEffectsEnabled`]: foreignSetting(DSCT_ID, "flatEffectsEnabled"),
    [`${DSTD_ID}.applyPermission`]: foreignSetting(DSTD_ID, "applyPermission"),
    [`${DSTD_ID}.hideSystemButtons`]: foreignSetting(DSTD_ID, "hideSystemButtons"),
    [`${DSTD_ID}.minionDamageAutomation`]: foreignSetting(DSTD_ID, "minionDamageAutomation"),
    [`${DT_ID}.overrideMinionDefeat`]: foreignSetting(DT_ID, "overrideMinionDefeat"),
    [`${DSCT_ID}.squadToolsEnabled`]: foreignSetting(DSCT_ID, "squadToolsEnabled"),
    [`${DSCT_ID}.forcedMovementEnabled`]: foreignSetting(DSCT_ID, "forcedMovementEnabled"),
    // Milestone 5: Combat Tools' own triggered-action automation next to ours.
    [`${DSCT_ID}.abilityAutomationEnabled`]: foreignSetting(DSCT_ID, "abilityAutomationEnabled"),
    [`${DSCT_ID}.hiwEnabled`]: foreignSetting(DSCT_ID, "hiwEnabled"),
    [`${DSCT_ID}.rollDialogPillUI`]: foreignSetting(DSCT_ID, "rollDialogPillUI"),
    [`${DSCT_ID}.autoTriggeredActionsEnabled`]: foreignSetting(DSCT_ID, "autoTriggeredActionsEnabled"),
    [`${DSCT_ID}.judgementAutomation`]: foreignSetting(DSCT_ID, "judgementAutomation"),
    [`${DSCT_ID}.markAutomation`]: foreignSetting(DSCT_ID, "markAutomation"),
    // Milestone 6: squads, labels and Death Tracker's cleanup next to our summons.
    [`${DSCT_ID}.squadSimultaneousTurns`]: foreignSetting(DSCT_ID, "squadSimultaneousTurns"),
    [`${DSCT_ID}.pairSimultaneousTurns`]: foreignSetting(DSCT_ID, "pairSimultaneousTurns"),
    [`${DSCT_ID}.autoSquadLabelsEnabled`]: foreignSetting(DSCT_ID, "autoSquadLabelsEnabled"),
    [`${DSCT_ID}.squadLabelApplyEffects`]: foreignSetting(DSCT_ID, "squadLabelApplyEffects"),
    [`${DT_ID}.cleanOrphanedCombatants`]: foreignSetting(DT_ID, "cleanOrphanedCombatants"),
    [`${DT_ID}.clearSkullsOnCombatEnd`]: foreignSetting(DT_ID, "clearSkullsOnCombatEnd"),
    "draw-steel.initiativeMode": foreignSetting("draw-steel", "initiativeMode"),
    // Milestone 7: templates, area targeting and the resource log next to our zones and gains.
    [`${DSCT_ID}.abilityTemplateCleanup`]: foreignSetting(DSCT_ID, "abilityTemplateCleanup"),
    [`${DSCT_ID}.abilityTemplateSeconds`]: foreignSetting(DSCT_ID, "abilityTemplateSeconds"),
    // 0.18.1: Combat Tools 1.2.8 turns Neutral NPCs Hostile at combat start; our ally / enemy checks read dispositions.
    [`${DSCT_ID}.neutralFoesHostile`]: foreignSetting(DSCT_ID, "neutralFoesHostile"),
    [`${DSTD_ID}.aoeTargeting`]: foreignSetting(DSTD_ID, "aoeTargeting"),
    "draw-steel-battle-log.resourceLog": foreignSetting("draw-steel-battle-log", "resourceLog"),
    "draw-steel-battle-log.resourceLogTokenCards": foreignSetting("draw-steel-battle-log", "resourceLogTokenCards"),
  };
  console.log(`${MODULE_ID} | selfCheck`);
  console.table(report);
  console.table(ours);
  console.table(foreign);
  const found = [];
  if (!report.partTypeRegistered) found.push(problem("partType"));
  if (!report.relayRegistered) found.push(problem("relay"));
  if (!game.user?.isGM && game.user?.hasPermission && !report.canQueryUsers) found.push(problem("queryUsers"));
  if (!game.users.activeGM) found.push(problem("noActiveGM"));
  if (report.libraryInvalid) found.push(problem("libraryInvalid", { count: report.libraryInvalid }));
  if (!report.entryTypesRegistered) found.push(problem("entryTypes"));
  if (!report.libWrapperReady) found.push(problem("libWrapper"));
  // Milestone 5.
  const takeDamage = registrations.find(r => r.target.endsWith("BaseActorModel.prototype.takeDamage"));
  if (report.triggersActive && setting("triggerExternalDamage") && takeDamage && !takeDamage.ok
    && takeDamage.reason !== "libWrapper missing") {
    found.push(problem("takeDamage"));
  }
  if (!promptTypes().includes("trigger")) found.push(problem("promptTrigger"));
  // Milestone 6.
  if (!promptTypes().includes("summonUpkeep")) found.push(problem("promptUpkeep"));
  // Milestone 9.
  if (!promptTypes().includes("persistentUpkeep")) found.push(problem("promptPersistent"));
  // Milestone 7.
  if (!compat.zoneType) found.push(problem("zoneType"));
  // 0.9.1 (TESTING.md §14): areas, like the system's own templates, are sized in squares × the grid's distance pixels.
  const grid = globalThis.canvas?.scene?.grid;
  report.sceneGridDistance = grid?.distance ?? null;
  if (grid && Number(grid.distance) !== 1) {
    found.push(problem("gridDistance", { distance: grid.distance, units: grid.units ? ` ${grid.units}` : "" }));
  }
  if (compat.resourcesUi || compat.triggersModule) {
    found.push(problem("gainsStandDown", { module: compat.resourcesUi ? RESOURCES_UI_ID : TRIGGERS_ID }));
  }
  const missing = registrations.filter(r => !r.ok && r.reason !== "libWrapper missing");
  if (missing.length) found.push(problem("wrappers", { list: missing.map(r => `${r.target} (${r.reason})`).join(", ") }));
  // Milestone 8.
  if (report.targetedConditions === "native" && report.dsctConditionsOn) {
    found.push(problem("nativeWithDsct", { count: report.nativeTargetedEffects ?? 0 }));
  }
  if (compat.targetResult && compat.targetTokenUuid === false) found.push(problem("devBuild", { version: compat.systemVersion ?? "?" }));
  if (report.menuRegistered === false) found.push(problem("menu"));
  // 0.16.0.
  report.familyVersions = familyVersions();
  const unverified = unverifiedFamily();
  if (unverified.length) found.push(problem("unverifiedVersion", { list: unverified.join(", ") }));
  // 0.18.0 (Combat Tools 1.2.7).
  report.dsctAdvancedEnrichers = dsct.dsctSetting("advancedEnrichers", null);
  report.dsctAutoApplyOwn = dsct.dsctSetting("autoApplyOwnAbilities", null);
  report.dsctForeignHandlers = dsct.dsctForeignHandlers();
  if (report.dsctAdvancedEnrichers === true) found.push(problem("advancedEnrichers"));
  if (report.dsctAutoApplyOwn === true) found.push(problem("autoApplyOwn"));
  if (report.dsctForeignHandlers.length) found.push(problem("dsctHandlers", { list: report.dsctForeignHandlers.join(", ") }));
  const problems = found.map(problemText);
  if (problems.length) console.warn(`${MODULE_ID} | selfCheck problems:\n- ${problems.join("\n- ")}`);
  else console.log(`${MODULE_ID} | selfCheck: all green`);
  return { report, settings: ours, foreign, problems, problemKeys: found.map(({ key, data }) => ({ key, data })) };
}

/** Print the record of a card and what the readers see now. Defaults to the latest card with a record. */
export function dump(messageId) {
  const message = messageId ? game.messages.get(messageId)
    : game.messages.contents.findLast(m => getResolution(m));
  if (!message) {
    console.warn(`${MODULE_ID} | dump: no card with a resolution record found`);
    return null;
  }
  const res = getResolution(message);
  const { shape, parts } = readTierParts(message);
  const tiers = shape === "tierParts" ? assignTiers(res?.targets ?? {}, parts) : {};
  const out = { messageId: message.id, record: foundry.utils.deepClone(res), readNow: { shape, parts, tiers } };
  console.log(`${MODULE_ID} | dump ${message.id}`, out);
  if (res?.ops) {
    console.table(Object.values(res.ops).map(o => ({
      op: o.opId, kind: o.kind, mode: o.mode, status: o.status, reason: o.reason ?? "",
      amount: o.amount ?? "", final: o.finalAmount ?? "", targets: o.targetKeys?.length ?? 0,
    })));
  }
  return out;
}
