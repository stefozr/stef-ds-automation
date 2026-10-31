/**
 * Detached automation: overlay effects materialized as `dsAuto.<type>` special effects in the item's
 * `system.effects` (one entry per effect and tier), so a Director can edit them in the system's own
 * special effect sheet. Pure conversions; the document types are registered in types/special-effects.mjs.
 *
 * Milestone 7: `zone` entries (the 17 keys of the schema's TYPE_FIELDS.zone, plus `terrain` from Milestone 9). Like a
 * summon, a zone always goes on the user's own row. Entries bypass normalizeOverlay, so the plan falls back to
 * ZONE_DEFAULTS for absent fields.
 *
 * Milestone 9: `modifier` entries (key, value, mode, end); an effect's `pick` and a teleport's `boost` as flat fields
 * (PICK_ENTRY_FIELDS, BOOST_ENTRY_FIELDS; `entryFieldsOf(type)` lists every field of one entry type).
 */
import { EFFECT_TYPES, TIERS, effectForTier, summonActorUuid } from "./schema.mjs";

export const ENTRY_PREFIX = "dsAuto.";

/** Fields of the `dsAuto` schema of an entry, per effect type (besides the common ones). */
export const ENTRY_FIELDS = Object.freeze({
  damage: ["value", "damageType", "ignoredImmunities"],
  heal: ["value", "recoveries", "spender", "temporary"],
  condition: ["status", "effect", "uuid", "end", "stacking", "until", "temporaryStamina"],
  cleanse: ["statuses", "ends", "count", "afterMove"],
  resource: ["resource", "value"],
  forced: ["movement", "distance", "vertical", "ignoresStability", "properties"],
  teleport: ["distance", "mode", "autoStart", "hideAfter", "hideWhileObserved", "hideSurge"],
  note: ["text"],
  // Milestone 6: the same keys as the schema's TYPE_FIELDS.summon (`actors` as compendium uuid strings).
  summon: ["actors", "quantity", "distance", "origin", "side", "turn", "actsThisRound", "squad", "lasts", "upkeep", "carryStamina", "lockOnZero"],
  // Milestone 7: the same keys as the schema's TYPE_FIELDS.zone.
  zone: ["value", "damageType", "ignoredImmunities", "zoneEvents", "once", "onceShared", "perSquare", "affects", "exceptKeywords",
    "exceptMonsters", "shape", "size", "width", "range", "lasts", "upkeep", "forcedCounts", "terrain"],
  // Milestone 9: the same keys as the schema's TYPE_FIELDS.modifier.
  modifier: ["key", "value", "mode", "end"],
});
/**
 * Milestone 9: the effect's `pick` and a teleport's `boost`, flattened into entry fields (the sheet edits flat
 * fields); entryToEffect rebuilds the objects. `entryFieldsOf(type)` is the whole schema of one entry type.
 */
export const PICK_ENTRY_FIELDS = Object.freeze(["pickCount", "pickWithin", "pickOf", "pickFilter", "pickDamageTypes"]);
export const BOOST_ENTRY_FIELDS = Object.freeze(["boostResource", "boostPer", "boostMax"]);
/** Types whose effects may pick their targets (schema NO_PICK_TYPES: summon, zone, note may not). */
const PICKING_TYPES = new Set(["damage", "heal", "condition", "cleanse", "resource", "forced", "teleport", "modifier"]);
export const entryFieldsOf = type => [
  ...COMMON_ENTRY_FIELDS, ...(ENTRY_FIELDS[type] ?? []), ...(PICKING_TYPES.has(type) ? PICK_ENTRY_FIELDS : []),
  ...(type === "teleport" ? BOOST_ENTRY_FIELDS : []),
];
/** Effect types that always go on the user's own row (`targets: "self"`), whatever an entry says. */
const SELF_TYPES = new Set(["summon", "zone"]);
/** Formula fields stored as strings in an entry (the sheet edits them as text). */
const FORMULA_FIELDS = new Set(["value", "distance", "quantity", "size", "width", "range"]);
export const COMMON_ENTRY_FIELDS = Object.freeze([
  "effectId", "label", "targets", "filter", "tiers", "whenSpend", "whenStrained", "whenConfig",
  "choiceGroup", "choiceOption", "potencyCharacteristic", "potencyValue", "manual",
]);

export const isEntryType = type => typeof type === "string" && type.startsWith(ENTRY_PREFIX) && EFFECT_TYPES.includes(type.slice(ENTRY_PREFIX.length));

/** 16 alphanumerics from a string (pseudo-document ids). */
export function entryId(...parts) {
  const text = parts.join("|");
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = ((h1 << 5) + h1 + c) | 0;
    h2 = ((h2 << 5) + h2 ^ c) | 0;
  }
  const body = ((h1 >>> 0).toString(36) + (h2 >>> 0).toString(36)).replace(/[^a-z0-9]/g, "").padEnd(10, "0").slice(0, 10);
  return `dsAuto${body}`;
}

/**
 * Entries of one overlay effect: one per tier when it varies by tier (`byTier`), else one.
 * @returns {object[]} Source data of `dsAuto.<type>` special effects.
 */
export function effectToEntries(effect, overlayKey, sortBase = 400_000) {
  const tiers = effect.byTier ? (effect.tiers ?? TIERS) : [null];
  return tiers.map((tier, i) => {
    const e = effectForTier(effect, tier);
    const data = {
      effectId: effect.id,
      label: e.label ?? "",
      // A summon or zone always goes on the user's own row (entryToEffect forces it too).
      targets: SELF_TYPES.has(effect.type) ? "self" : (e.targets ?? "targets"),
      filter: e.filter ?? "",
      tiers: tier ? [tier] : [...(e.tiers ?? [])],
      whenSpend: triState(e.when?.spend),
      whenStrained: triState(e.when?.strained),
      whenConfig: e.when?.config ?? "",
      choiceGroup: e.choice?.group ?? "",
      choiceOption: e.choice?.option ?? "",
      potencyCharacteristic: e.potency?.characteristic ?? "",
      potencyValue: e.potency?.value != null ? String(e.potency.value) : "",
      manual: !!e.manual,
    };
    for (const k of ENTRY_FIELDS[effect.type]) {
      const v = e[k];
      if (v === undefined || v === null) continue;
      if (k === "actors") {
        if (Array.isArray(v)) data.actors = v.map(a => summonActorUuid(a?.uuid ?? a)).filter(Boolean);
        continue;
      }
      data[k] = Array.isArray(v) ? [...v] : (typeof v === "number" && FORMULA_FIELDS.has(k) ? String(v) : v);
    }
    if (effect.type === "forced" && !Array.isArray(data.movement) && data.movement) data.movement = [data.movement];
    // Milestone 9: flattened `pick` / `boost`.
    if (e.pick && PICKING_TYPES.has(effect.type)) {
      Object.assign(data, {
        pickCount: Number.isInteger(e.pick.count) ? e.pick.count : 1, pickWithin: e.pick.within != null ? String(e.pick.within) : "",
        pickOf: e.pick.of ?? "self", pickFilter: e.pick.filter ?? "", pickDamageTypes: [...(e.pick.damageTypes ?? [])],
      });
    }
    if (e.boost && effect.type === "teleport") {
      Object.assign(data, { boostResource: e.boost.resource ?? "", boostPer: Number(e.boost.per) || 1, boostMax: Number.isInteger(e.boost.max) ? e.boost.max : null });
    }
    return {
      _id: entryId(overlayKey, effect.id, tier ?? 0),
      type: `${ENTRY_PREFIX}${effect.type}`,
      name: effect.name ?? "",
      img: null,
      sort: sortBase + i,
      description: "",
      before: false,
      dsAuto: data,
    };
  });
}

const blankToNull = v => (v === "" || v === undefined ? null : v);
/** `when` flags as entry fields: "yes" / "no" / "" (either). */
const triState = v => (v === true ? "yes" : v === false ? "no" : "");
const fromTriState = v => (v === true || v === "yes" ? true : v === false || v === "no" ? false : null);

/** Overlay effect of an entry (its source data or the prepared pseudo-document). */
export function entryToEffect(entry) {
  const type = String(entry?.type ?? "").slice(ENTRY_PREFIX.length);
  if (!EFFECT_TYPES.includes(type)) return null;
  const d = entry.dsAuto ?? {};
  const list = v => (v == null ? [] : [...v]);
  const effect = {
    id: d.effectId || entry._id || entry.id,
    type,
    // A summon or zone goes on the user's own row whatever the entry says (the engine's self-row test reads `targets`).
    targets: SELF_TYPES.has(type) ? "self" : (d.targets || "targets"),
    entryId: entry._id ?? entry.id,
  };
  if (entry.name) effect.name = entry.name;
  if (d.label) effect.label = d.label;
  if (d.filter) effect.filter = d.filter;
  const tiers = list(d.tiers).map(Number).filter(t => TIERS.includes(t));
  if (tiers.length) effect.tiers = tiers;
  const when = {};
  const spend = fromTriState(d.whenSpend);
  const strained = fromTriState(d.whenStrained);
  if (spend !== null) when.spend = spend;
  if (strained !== null) when.strained = strained;
  if (d.whenConfig) when.config = d.whenConfig;
  if (Object.keys(when).length) effect.when = when;
  if (d.choiceGroup && d.choiceOption) effect.choice = { group: d.choiceGroup, option: d.choiceOption };
  if (d.potencyCharacteristic && d.potencyValue) effect.potency = { characteristic: d.potencyCharacteristic, value: d.potencyValue };
  if (d.manual) effect.manual = true;
  for (const k of ENTRY_FIELDS[type]) {
    let v = d[k];
    if (v instanceof Set) v = [...v];
    v = blankToNull(v);
    if (v === null) continue;
    if (Array.isArray(v) && !v.length && !["movement"].includes(k)) continue;
    if (k === "spender" && v === "target") continue;
    if (k === "actors") {
      const uuids = (Array.isArray(v) ? v : [v]).map(u => String(u ?? "").trim()).filter(Boolean);
      if (uuids.length) effect.actors = uuids.map(uuid => ({ uuid }));
      continue;
    }
    effect[k] = v;
  }
  if (type === "forced" && Array.isArray(effect.movement) && effect.movement.length === 1) effect.movement = effect.movement[0];
  // Milestone 9: the flattened `pick` (with `targets: "pick"`) and a teleport's `boost`.
  if (effect.targets === "pick" && PICKING_TYPES.has(type)) {
    const pick = { count: Number.isInteger(Number(d.pickCount)) && Number(d.pickCount) > 0 ? Number(d.pickCount) : 1, within: blankToNull(d.pickWithin) ?? "0", of: d.pickOf || "self" };
    if (d.pickFilter) pick.filter = d.pickFilter;
    const types = list(d.pickDamageTypes).filter(t => typeof t === "string" && t);
    if (types.length && type === "damage") pick.damageTypes = types;
    effect.pick = pick;
  }
  if (type === "teleport" && d.boostResource) {
    effect.boost = { resource: d.boostResource, per: Number(d.boostPer) > 0 ? Number(d.boostPer) : 1 };
    if (Number.isInteger(d.boostMax) && d.boostMax > 0) effect.boost.max = d.boostMax;
  }
  return effect;
}

/** The detached entries of an item (`dsAuto.*` special effects), as overlay effects. */
export function itemEntries(item) {
  let list = [];
  try {
    list = [...(item?.system?.effects?.contents ?? [])].filter(e => isEntryType(e.type));
  } catch (_err) {
    list = [];
  }
  return list;
}

/** Source data of our entries on an item, keyed by id (what the keeper restores). */
export function entrySources(item) {
  const src = item?._source?.system?.effects ?? item?.toObject?.()?.system?.effects ?? {};
  const out = {};
  for (const [id, data] of Object.entries(src)) if (isEntryType(data?.type)) out[id] = data;
  return out;
}
