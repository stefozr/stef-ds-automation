/**
 * Feature detection for the running system and modules. Never gate on version strings alone when a
 * feature can be probed; the 1.2.x message shape is detected through its registered part type.
 * Milestone 5: Draw Steel: Triggers (our trigger engine stands down), Combat Tools' roll dialog pills and
 * forced movement API, and its `abilityAutomationEnabled` setting as it was at `ready` (a requiresReload
 * setting: Combat Tools decides at init whether its Hesitation is Weakness and pill hooks exist).
 * Milestone 6 (summoning): Combat Tools' squad labeller, and the system's own summoning pieces of 1.2.x (portfolio
 * summons, the summon advancement, the companion actor type), probed only.
 * Milestone 7: region behaviors and our `stef-ds-automation.zone` type, Draw Steel: Resources UI (our gains stand down),
 * Combat Tools' template cleanup, Target Damage hiding the system's gain buttons, the Delian Tomb adventure.
 * Milestone 8 (docs/M8-DESIGN.md §1.6): the two 1.1.x system bugs are found by behaviour probes, not version strings
 * (`isNewerVersion("1.2.0", "1.2")` is true, so a "1.2" dev build would have got both fixes); the version is padded
 * for display only. New probes: the 1.2 target part's `tokenUuid` field, `AbilityUse#spendAmounts`,
 * `StandardModel#tierFor`, a dev build ("1.2" style version). `AbilityModel#performSummon` (the real 1.2 method)
 * replaces the dead `ds.utils.performSummon` probe.
 * 0.16.0: the versions of the Combat Tools family that passed the live matrix (VERIFIED). Nothing is switched off
 * outside the list; self-check and a Director banner say when an active module is outside it. (0.17.0 retired the
 * in-memory path bridge of Combat Tools' engine, the one part that copied its source.)
 */
import { BATTLE_LOG_ID, CTLIB_ID, DSCT_ID, DSPLUS_ID, DSTD_ID, DT_ADVENTURE_ID, DT_ID, RESOURCES_UI_ID, TRIGGERS_ID } from "../constants.mjs";

export const compat = {};

/** The live-verified versions of the Combat Tools family (TESTING.md §24, §27, §28); update after each live matrix. */
export const VERIFIED = Object.freeze({
  [DSCT_ID]: Object.freeze(["1.2.3", "1.2.6", "1.2.7", "1.2.8"]),
  [CTLIB_ID]: Object.freeze(["1.2.1", "1.4.0", "1.5.0", "1.5.1"]),
  [DT_ID]: Object.freeze(["1.1.3", "1.2.1", "1.2.2"]),
  [DSTD_ID]: Object.freeze(["1.0.8"]),
  [BATTLE_LOG_ID]: Object.freeze(["1.3.0", "1.4.1", "1.5.0"]),
  [TRIGGERS_ID]: Object.freeze(["1.1.0", "1.2.0", "1.3.0"]),
});

/** Is `version` (default: the installed one) of module `id` on the verified list? Unlisted modules: true. */
export function verifiedVersion(id, version = game.modules.get(id)?.version) {
  const list = VERIFIED[id];
  return !list || (version != null && list.includes(String(version)));
}

/**
 * One row per family module: `{id, version, active, verified}` (an inactive or missing module, or one without a
 * version string, counts as verified).
 */
export function familyVersions() {
  return Object.keys(VERIFIED).map(id => {
    const mod = game.modules.get(id);
    const version = mod?.version ?? null;
    return { id, version, active: !!mod?.active, verified: !mod?.active || version == null || verifiedVersion(id, version) };
  });
}

/** The active family modules outside the verified list, as "id version" strings. */
export const unverifiedFamily = () => familyVersions().filter(r => !r.verified).map(r => `${r.id} ${r.version}`);

/** A feature probe that never throws (false on error). */
function probe(fn) {
  try {
    return !!fn();
  } catch (_err) {
    return false;
  }
}

/** "1.2" -> "1.2.0"; display and logs only, never a gate. */
export function paddedVersion(v) {
  const p = String(v ?? "").split(".").filter(x => x !== "");
  while (p.length < 3) p.push("0");
  return p.slice(0, 3).join(".");
}

/** Is the running system at least version `v` (both padded to three parts)? Display and fallbacks only. */
export const systemVersionAtLeast = v => !!game.system?.version
  && !foundry.utils.isNewerVersion(paddedVersion(v), paddedVersion(game.system.version));

/** The fake combat id of the exit probe; our exit cleanup wrapper ignores calls carrying it (system-fixes.mjs). */
export const PROBE_COMBAT_ID = "probeCombat00000";

/**
 * True when the system's Combat#_onExit still misses non-expired combat effects (the 1.1.x `new Set("save", ...)`
 * bug). Synchronous and touches no document: `_onExit` is async but deletes before its first await (CH6), so a stub
 * actor whose `deleteEmbeddedDocuments` records the ids answers at once. No `_onExit` at all: false (nothing to fix).
 */
export function probeExitSetBug() {
  const fn = CONFIG.Combat?.documentClass?.prototype?._onExit;
  if (typeof fn !== "function") return false;
  const deleted = [];
  const effect = { id: "probe0000000000a", duration: { expired: false, expiry: "turnEnd" }, _source: { start: { combat: PROBE_COMBAT_ID } } };
  const actor = {
    effects: [effect],
    deleteEmbeddedDocuments: (_type, ids) => {
      deleted.push(...(ids ?? []));
      return Promise.resolve([]);
    },
  };
  try {
    const r = fn.call({ id: PROBE_COMBAT_ID }, { actor });
    r?.catch?.(() => {});
  } catch (_err) {
    return false;
  }
  return !deleted.includes(effect.id);
}

/**
 * True when BaseEffectModel#rollSave still sends its card through DSRoll#toMessage (1.1.x drops the savingThrow
 * part there). Without the method or without Function#toString: the version decides (below 1.2.0).
 */
export function probeSaveThroughToMessage() {
  const fn = globalThis.ds?.data?.ActiveEffect?.BaseEffectModel?.prototype?.rollSave;
  if (typeof fn !== "function") return !systemVersionAtLeast("1.2.0");
  let src = null;
  try {
    src = Function.prototype.toString.call(fn);
  } catch (_err) {
    return !systemVersionAtLeast("1.2.0");
  }
  return /\.toMessage\(/.test(src);
}

/** Combat Tools' `abilityAutomationEnabled` at ready: true/false, or undefined (not readable: probe live). */
let dsctAutomationAtReady;
let dsctAutomationTaken = false;

function readDsctAutomation() {
  if (!game.modules.get(DSCT_ID)?.active) return false;
  try {
    return game.settings.get(DSCT_ID, "abilityAutomationEnabled") !== false;
  } catch (_err) {
    return undefined;
  }
}

/**
 * @param {object} [options]
 * @param {boolean} [options.ready]   The `ready` call: take the Combat Tools settings snapshot.
 */
export function detectCompat({ ready = false } = {}) {
  const mp = globalThis.ds?.CONFIG?.MessagePart ?? {};
  const pre = globalThis.ds?.data?.pseudoDocuments?.powerRollEffects?.BasePowerRollEffect;
  const ability = globalThis.ds?.data?.Item?.AbilityModel;
  const parts = globalThis.ds?.data?.pseudoDocuments?.messageParts;
  const dsctOn = !!game.modules.get(DSCT_ID)?.active;
  const dsctApi = dsctOn ? game.modules.get(DSCT_ID)?.api ?? null : null;
  // Combat Tools active but its api not published yet: undefined, so callers probe it live.
  const dsctFeature = pick => (dsctApi ? typeof pick(dsctApi) === "function" : (dsctOn ? undefined : false));
  if ((ready || game.ready) && !dsctAutomationTaken) {
    dsctAutomationAtReady = readDsctAutomation();
    dsctAutomationTaken = dsctAutomationAtReady !== undefined;
  }
  Object.assign(compat, {
    systemVersion: game.system?.version ?? null,
    coreVersion: game.version ?? null,
    // Milestone 8: "1.2.0" for a "1.2" dev build (display only) and whether the version string is such a build.
    systemVersionPadded: game.system?.version ? paddedVersion(game.system.version) : null,
    devBuild: /^\d+\.\d+$/.test(game.system?.version ?? ""),
    // 1.2.x writes one `targetResult` part per target (read per card, engine/readers.mjs cardShape).
    targetResult: !!mp.targetResult,
    // The target part's `tokenUuid` field (#2202): null where there is no targetResult part (1.1.x, "not
    // applicable"), false on a 1.2 dev build without it (its cards stay "unknown", every row manual).
    targetTokenUuid: mp.targetResult ? probe(() => !!parts?.TargetResult?.schema?.fields?.tokenUuid) : null,
    abilityUseSpend: probe(() => !!parts?.AbilityUse?.schema?.fields?.spendAmounts),
    tierFor: probe(() => typeof globalThis.ds?.data?.ChatMessage?.StandardModel?.prototype?.tierFor === "function"),
    summonTypes: !!globalThis.ds?.CONFIG?.SpecialEffect?.summon,
    potencyOption: typeof pre?.prototype?.potencyOption === "function",
    performSummon: typeof ability?.prototype?.performSummon === "function",
    // System bugs `new Set("save", ...)` (character sets) in Combat#_onExit, through 1.1.x: probed (M8).
    setBugsPresent: probeExitSetBug(),
    // DSRoll#toMessage drops the savingThrow part of save cards; probed on rollSave's source (M8).
    saveMessageBug: probeSaveThroughToMessage(),
    dsct: !!game.modules.get(DSCT_ID)?.active,
    dstd: !!game.modules.get(DSTD_ID)?.active,
    ctlib: !!game.modules.get(CTLIB_ID)?.active && !!globalThis.ctlib,
    deathTracker: !!game.modules.get(DT_ID)?.active,
    dsplus: !!game.modules.get(DSPLUS_ID)?.active,
    libWrapper: !!game.modules.get("lib-wrapper")?.active,
    // Milestone 5.
    triggersModule: !!game.modules.get(TRIGGERS_ID)?.active,
    rollPills: dsctFeature(api => api.rollDialog?.addPill),
    fmGate: dsctFeature(api => api.forcedMovement),
    dsctAbilityAutomation: dsctAutomationAtReady,
    // Milestone 6.
    dsctSquadLabels: dsctFeature(api => api.squadLabels),
    portfolioSummon: probe(() => !!globalThis.ds?.CONFIG?.SpecialEffect?.portfolioSummon),
    summonAdvancement: probe(() => !!globalThis.ds?.CONFIG?.Advancement?.summon),
    companionType: probe(() => !!globalThis.CONFIG?.Actor?.dataModels?.companion),
    // Milestone 7 (DSTD registers its settings at its own init: read again at ready).
    regionBehaviors: probe(() => !!globalThis.CONFIG?.RegionBehavior?.dataModels),
    zoneType: probe(() => !!globalThis.CONFIG?.RegionBehavior?.dataModels?.["stef-ds-automation.zone"]),
    resourcesUi: !!game.modules.get(RESOURCES_UI_ID)?.active,
    dsctTemplateCleanup: dsctOn && probe(() => game.settings.get(DSCT_ID, "abilityTemplateCleanup")),
    dstdHidesGainButtons: !!game.modules.get(DSTD_ID)?.active && probe(() => game.settings.get(DSTD_ID, "hideSystemButtons")),
    delianTomb: !!game.modules.get(DT_ADVENTURE_ID)?.active,
  });
  return compat;
}
