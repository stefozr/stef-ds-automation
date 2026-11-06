/**
 * Three-layer resolution of an ability's automation (Milestone 4), highest first:
 *   1. detached entries: `dsAuto.*` special effects on the item (materialized from an overlay or
 *      authored by hand); the registry copy is then ignored for that item
 *   2. item flags `flags["stef-ds-automation"]`: {disabled, lock, config, overlay: {key, version, hash, detached}}
 *   3. the registry overlay (virtual, never written to the item)
 *   4. the native layer: the system's own power roll effects (engine/native.mjs)
 * An overlay may suppress native power roll effects by id (it replaces them), and limit the native rows to
 * one side (`native.filter`: an ability that spares allies).
 *
 * Combat Tools coexistence (setting `libraryDefersToCombatTools`): when the item carries Combat Tools'
 * own automation of a kind (`dsct.flat*` special effects: buttons on the card), library effects of that
 * kind are left to Combat Tools.
 *
 * Milestone 5: an overlay's `triggers` and `trackers` are overlay-level data (not effects or entries); a
 * detached item keeps them in its detach stamp. They are not seeded (`automatable` ignores them): the
 * trigger engine posts its own record card.
 *
 * Milestone 6: `summon` is an effect type of every layer (overlay effect, detached `dsAuto.summon` entry).
 * It counts as automatable like any non-note effect, and Combat Tools has no flat summon kind (DSCT_FLAT),
 * so a summon is never "covered".
 *
 * Milestone 9: an overlay's `persistent` (Persistent upkeep, persistent/registry.mjs) is overlay-level data like the
 * triggers; a detached item keeps it in its detach stamp. A re-roll or a hold counts as added automation.
 */
import { automationFor, useEffects } from "./custom.mjs";
import { DSCT_ID, MODULE_ID } from "../constants.mjs";
import { setting } from "../settings.mjs";
import { entryToEffect, itemEntries } from "./entries.mjs";
import { itemKey } from "./identity.mjs";
import { findOverlay } from "./registry.mjs";
import { compareVersions } from "./schema.mjs";

/** Combat Tools flat effect type -> the library effect type it automates. */
const DSCT_FLAT = {
  "dsct.flatDamage": "damage",
  "dsct.flatHeal": "heal",
  "dsct.flatCleanse": "cleanse",
  "dsct.flatApplied": "condition",
  "dsct.flatResource": "resource",
  "dsct.flatTeleport": "teleport",
  "dsct.flatForced": "forced",
};
const DSCT_TIERED = { dsctHeal: "heal", dsctTeleport: "teleport" };

export const itemFlags = item => item?.flags?.[MODULE_ID] ?? {};

/** Library effect types Combat Tools automates on this item itself. */
export function dsctCoveredTypes(item) {
  const out = new Set();
  if (!game.modules?.get?.(DSCT_ID)?.active) return out;
  try {
    for (const e of item?.system?.effects?.contents ?? []) if (DSCT_FLAT[e.type]) out.add(DSCT_FLAT[e.type]);
    // Its tiered power roll effects (tiered-effects.mjs): per-tier heal and teleport buttons.
    for (const e of item?.system?.power?.effects?.contents ?? []) if (DSCT_TIERED[e.type]) out.add(DSCT_TIERED[e.type]);
  } catch (_err) { /* no special effects */ }
  return out;
}

/** Combat Tools' enhanced-ability flags on the item (read only; we never set them). */
export function dsctEnhancedState(item) {
  const f = item?.flags?.[DSCT_ID] ?? {};
  return { enhanced: !!f.enhanced, locked: !!f.enhancedLock, hash: f.enhancedHash ?? null };
}

function modulesMet(overlay) {
  return (overlay?.requires?.modules ?? []).every(id => !!game.modules?.get?.(id)?.active);
}

/** Config values: overlay defaults overlaid with the item's configuration. */
export function configValues(overlay, flags) {
  const out = {};
  for (const c of overlay?.config ?? []) out[c.key] = c.default;
  for (const [k, v] of Object.entries(flags?.config ?? {})) if (k in out) out[k] = v;
  return out;
}

const hasNative = item => {
  try {
    return (item?.system?.power?.effects?.contents ?? []).some(e => ["damage", "applied", "forced"].includes(e.type));
  } catch (_err) {
    return false;
  }
};

/**
 * Resolve an ability.
 * @param {Item} item
 * @returns {{
 *   key: string|null, layer: "disabled"|"detached"|"overlay"|"native"|"none", status: string,
 *   overlay: object|null, effects: object[], suppress: Set<string>, nativeFilter: "allies"|"enemies"|null,
 *   config: object, choices: object[],
 *   dsctCovered: string[], disabled: boolean, locked: boolean, outdated: boolean, automatable: boolean,
 *   version: string|null, notes: string|null,
 *   triggers: object[], trackers: object[],  // Milestone 5: normalized, from the overlay or the detach stamp
 *   persistent: {cost, keep: string[], targets, note}|null   // Milestone 9: from the overlay or the detach stamp
 * }}
 */
export function resolveAbility(item) {
  // Setting off: only what the system itself describes (Milestones 1-3).
  const on = setting("libraryEnabled") !== false;
  const flags = on ? itemFlags(item) : {};
  const key = itemKey(item);
  const overlay = item && on ? findOverlay(item) : null;
  const usable = overlay && modulesMet(overlay) ? overlay : null;
  const entries = on ? itemEntries(item) : [];
  const detached = !!flags.overlay?.detached || entries.length > 0;
  const covered = setting("libraryDefersToCombatTools") ? dsctCoveredTypes(item) : new Set();
  const out = {
    key, layer: "none", status: "manual", overlay: overlay ?? null, effects: [], suppress: new Set(), nativeFilter: null, config: {},
    choices: [], dsctCovered: [], disabled: !!flags.disabled, locked: !!flags.lock, outdated: false,
    automatable: false, version: null, notes: null, triggers: [], trackers: [], persistent: null,
  };
  if (detached) {
    out.layer = "detached";
    out.effects = entries.map(entryToEffect).filter(Boolean);
    out.version = flags.overlay?.version ?? null;
    // Overlay-level data of a detached item: the overlay it was detached from, else what the stamp kept. A
    // monster's overlay and the generic one share a key (ability:parry): the stamp's `monster` tells them
    // apart (stamps from before it follow the key alone; third review).
    const stamp = flags.overlay ?? {};
    const sameMonster = stamp.monster === undefined || JSON.stringify(stamp.monster ?? null) === JSON.stringify(overlay?.monster ?? null);
    const from = overlay && stamp.key === overlay.key && sameMonster ? overlay : null;
    out.suppress = new Set(from?.native?.suppress ?? stamp.suppress ?? []);
    out.nativeFilter = (from ? from.native?.filter : stamp.nativeFilter) ?? null;
    out.choices = from?.choices ?? stamp.choices ?? [];
    out.config = configValues(from ?? { config: stamp.config ?? [] }, flags);
    out.notes = from?.notes ?? stamp.notes ?? null;
    out.triggers = from?.triggers ?? stamp.triggers ?? [];
    out.trackers = from?.trackers ?? stamp.trackers ?? [];
    out.persistent = from?.persistent ?? stamp.persistent ?? null;
    out.outdated = !!from && !!flags.overlay?.version && compareVersions(from.version, flags.overlay.version) > 0;
  } else if (usable) {
    out.layer = "overlay";
    out.effects = usable.effects;
    out.version = usable.version;
    out.suppress = new Set(usable.native?.suppress ?? []);
    out.nativeFilter = usable.native?.filter ?? null;
    out.choices = usable.choices ?? [];
    out.config = configValues(usable, flags);
    out.notes = usable.notes ?? null;
    out.triggers = usable.triggers ?? [];
    out.trackers = usable.trackers ?? [];
    out.persistent = usable.persistent ?? null;
  } else if (hasNative(item)) out.layer = "native";
  const automation = on ? automationFor(item, usable) : null;
  out.automation = automation;
  if (automation) {
    // Only item-flag automation replaces the effects (editableAutomation moves them into an on-use rule). An
    // overlay's own automation.rules sit next to its effects, which must keep running.
    const fromFlag = !!item?.flags?.[MODULE_ID]?.automation;
    if (fromFlag) {
      out.effects = useEffects(automation);
      out.layer = "detached";
      out.suppress = new Set(automation.suppress ?? []);
    } else if (automation.suppress?.length) out.suppress = new Set([...out.suppress, ...automation.suppress]);
  }
  // Combat Tools automates some kinds itself.
  if (covered.size && out.effects.length) {
    const before = out.effects.length;
    out.effects = out.effects.filter(e => !covered.has(e.type) || e.type === "note");
    if (out.effects.length < before) out.dsctCovered = [...covered];
  }
  if (out.disabled) {
    out.layer = "disabled";
    out.effects = [];
    out.suppress = new Set();
    out.nativeFilter = null;
    out.notes = null;
    out.triggers = [];
    out.trackers = [];
    out.persistent = null;
  }
  out.automatable = !out.disabled && (out.effects.some(e => e.type !== "note") || hasNative(item) || out.effects.length > 0 || !!automation?.rules?.length);
  out.status = statusOf(out, overlay, flags, item);
  return out;
}

/**
 * Medkit status, most specific first:
 *   locked > disabled > outdated > customized > unavailable > covered > configurable > automated > native > manual
 * "covered": the overlay adds nothing here because Combat Tools automates every one of its effects on
 * this item (only notes are left). Triggers and trackers (Milestone 5) always count as added.
 */
function statusOf(r, overlay, flags, item) {
  if (r.locked) return "locked";
  if (r.disabled) return "disabled";
  if (r.layer === "detached") return r.outdated ? "outdated" : "customized";
  if (overlay && !modulesMet(overlay)) return "unavailable";
  if (r.layer === "overlay") {
    const adds = !!r.automation?.rules?.length || r.effects.some(e => e.type !== "note") || r.suppress.size || r.nativeFilter || r.choices.length || r.triggers.length || r.trackers.length
      || (r.persistent?.keep ?? []).some(k => k !== "manual");
    if (r.dsctCovered.length && !adds) return "covered";
    return overlay.config?.length ? "configurable" : "automated";
  }
  if (r.layer === "native") return "native";
  return "manual";
}

/** Status only (medkit badges, coverage reports). */
export function abilityStatus(item) {
  return resolveAbility(item).status;
}
