/**
 * `dsAuto.*` special effect types (Milestone 4): the editable form of detached library automation
 * (library/entries.mjs). They never show in the ability's chat card (`showUse` false): the resolution
 * section shows what they do. Registered at module import time so world items carrying them validate
 * while the world loads (as Combat Tools does for its own types).
 *
 * Milestone 6: `dsAuto.summon` (the registry key is prefixed: the bare names in RESERVED_NAMES belong to the
 * system and Combat Tools, and `registerEntryTypes` asserts the key it writes is none of them). Its `targets`
 * field only offers "self" (a summon goes on the user's own row).
 *
 * i18n (M6-DESIGN §5.4): DSAUTO.Entry.Field.{actors, quantity, origin, side, turn, actsThisRound, squad, lasts,
 * upkeep, carryStamina, lockOnZero}; DSAUTO.Entry.{Origin, Side, Turn, Squad, Lasts}.<value> (dynamic, listed in
 * tests/check.cjs); TYPES.SpecialEffect.dsAuto.summon.
 *
 * Milestone 7: `dsAuto.zone` (a lasting area; `targets` only offers "self", as a summon). Its choice fields take
 * their initial value from ZONE_DEFAULTS (`zonePick`), `lasts` starts at ["summonerTurnStart"] for a zone.
 * i18n (M7-DESIGN §5.4): DSAUTO.Entry.Field.{zoneEvents, once, onceShared, perSquare, affects, exceptKeywords,
 * exceptMonsters, shape, size, width, range, forcedCounts}; DSAUTO.Entry.{ZoneEvent, Once, Affects, Shape}.<value>
 * (dynamic, listed in tests/check.cjs); TYPES.SpecialEffect.dsAuto.zone.
 *
 * Milestone 9: the zone's `terrain` choice ("" or a ZONE_TERRAINS value; DSAUTO.Entry.Field.terrain,
 * DSAUTO.Entry.Terrain.<value>, dynamic).
 * Milestone 9 (WP-A): `dsAuto.modifier` (key, value, mode add | override, end ""/MODIFIER_ENDS); the flattened pick
 * fields on every type that may pick (pickCount, pickWithin, pickOf, pickFilter, pickDamageTypes) and a teleport's boost
 * (boostResource, boostPer, boostMax); `targets` offers "pick" and "area" too. i18n: DSAUTO.Entry.Field.{key, pickCount,
 * pickWithin, pickOf, pickFilter, pickDamageTypes, boostResource, boostPer, boostMax}, DSAUTO.Entry.Targets.{pick, area},
 * DSAUTO.Entry.{PickOf, ModifierMode, ModifierEnd}.<value> (dynamic, listed in tests/check.cjs),
 * TYPES.SpecialEffect.dsAuto.modifier.
 */
import { MODULE_ID } from "../constants.mjs";
import {
  BOOST_RESOURCES, MAX_PICK, MODIFIER_ENDS, MODIFIER_MODES, PICK_OF,
  CHARACTERISTICS, EFFECT_TYPES, ENDS, FILTERS, FORCED_PROPERTIES, MOVEMENTS, RESOURCES, SPENDERS, STATUSES, SUMMON_DEFAULTS,
  SUMMON_LASTS, SUMMON_ORIGINS, SUMMON_SIDES, SUMMON_SQUADS, SUMMON_TURNS, TARGETS, TELEPORT_MODES, UNTILS, ZONE_AFFECTS,
  ZONE_DEFAULTS, ZONE_EVENTS, ZONE_ONCE, ZONE_SHAPES, ZONE_TERRAINS, assertNotReserved,
} from "../library/schema.mjs";
import { ENTRY_PREFIX, entryFieldsOf } from "../library/entries.mjs";

const PARTIAL = `${MODULE_ID}.special-effect`;

const PARTIAL_SOURCE = `
<fieldset class="ds-auto-entry">
  <legend>{{localize "DSAUTO.Entry.Legend"}}</legend>
  <p class="hint">{{localize "DSAUTO.Entry.Hint"}}</p>
  {{#each ctx.rows as |r|}}
  {{formGroup r.field value=r.value name=r.name localize=true}}
  {{/each}}
</fieldset>`;

const choices = list => Object.fromEntries(list.map(v => [v, v]));
/** Choices labelled `DSAUTO.Entry.<group>.<value>` (summon vocabularies). */
const keyed = (list, group) => Object.fromEntries(list.map(v => [v, `DSAUTO.Entry.${group}.${v}`]));

/** DataField for one entry field; `type` (the effect type) matters for `targets` and the initial `lasts` only. */
function fieldFor(key, type = null) {
  const f = foundry.data.fields;
  const label = `DSAUTO.Entry.Field.${key}`;
  const str = (opts = {}) => new f.StringField({ required: true, blank: true, initial: "", label, ...opts });
  const pick = (list, group) => new f.StringField({ required: true, blank: false, initial: SUMMON_DEFAULTS[key], choices: keyed(list, group), label });
  // Milestone 7: zone choice fields start at ZONE_DEFAULTS (SUMMON_DEFAULTS has none of their keys).
  const zonePick = (list, group) => new f.StringField({ required: true, blank: false, initial: ZONE_DEFAULTS[key], choices: keyed(list, group), label });
  switch (key) {
    case "effectId": return str();
    case "label": return str();
    // A summon or zone goes on the user's own row: the sheet cannot set anything else.
    case "targets": {
      // Milestone 9: a note never picks, a movement never targets the area (schema pickProblems / AREA_EFFECT_TYPES).
      const list = type === "summon" || type === "zone" ? ["self"]
        : TARGETS.filter(v => !(v === "pick" && type === "note") && !(v === "area" && (type === "forced" || type === "teleport")));
      return new f.StringField({ required: true, blank: false, initial: list[0], choices: Object.fromEntries(list.map(v => [v, `DSAUTO.Entry.Targets.${v}`])), label });
    }
    case "filter": return str({ choices: Object.fromEntries([["", "DSAUTO.Entry.None"], ...FILTERS.map(v => [v, `DSAUTO.Entry.Filter.${v}`])]) });
    case "tiers": return new f.SetField(new f.NumberField({ integer: true, choices: { 1: "1", 2: "2", 3: "3" } }), { label });
    // Three states (a checkbox would turn "either" into "no" on every save of the sheet).
    case "whenSpend":
    case "whenStrained": return str({ choices: { "": "DSAUTO.Entry.Either", yes: "DSAUTO.Entry.Yes", no: "DSAUTO.Entry.No" } });
    case "whenConfig":
    case "whenAlliesNear":
    case "choiceGroup":
    case "choiceOption": return str();
    case "potencyCharacteristic": return str({ choices: Object.fromEntries([["", "DSAUTO.Entry.None"], ...CHARACTERISTICS.map(c => [c, `DRAW_STEEL.Actor.characteristics.${c}.full`])]) });
    case "potencyValue": return str();
    case "manual":
    case "autoStart":
    case "hideAfter":
    case "hideWhileObserved":
    case "carryStamina":
    case "lockOnZero":
    case "temporary":
    case "stacking":
    case "vertical":
    case "ignoresStability": return new f.BooleanField({ initial: false, label });
    case "value":
    case "distance": return str();
    case "damageType": return str();
    case "ignoredImmunities": return new f.SetField(new f.StringField({ blank: false }), { label });
    case "recoveries":
    case "upkeep":
    case "count": return new f.NumberField({ integer: true, min: 1, max: 10, nullable: true, initial: null, label });
    case "hideSurge": return new f.NumberField({ integer: true, min: 0, max: 3, initial: 0, label });
    case "status": return str({ choices: Object.fromEntries([["", "DSAUTO.Entry.None"], ...STATUSES.map(s => [s, s])]) });
    case "effect":
    case "uuid": return str();
    // Milestone 9: a modifier ends at MODIFIER_ENDS ("" = it stays until undone).
    case "end": return type === "modifier"
      ? str({ choices: Object.fromEntries([["", "DSAUTO.Entry.None"], ...MODIFIER_ENDS.map(e => [e, `DSAUTO.Entry.ModifierEnd.${e}`])]) })
      : str({ choices: Object.fromEntries(ENDS.map(e => [e, e ? `DSAUTO.Entry.End.${e}` : "DSAUTO.Entry.None"])) });
    case "statuses": return new f.SetField(new f.StringField({ blank: false, choices: Object.fromEntries(STATUSES.map(s => [s, s])) }), { label });
    case "ends": return new f.SetField(new f.StringField({ blank: false, choices: Object.fromEntries(ENDS.filter(Boolean).map(e => [e, `DSAUTO.Entry.End.${e}`])) }), { label });
    case "resource": return new f.StringField({ required: true, blank: false, initial: "surge", choices: Object.fromEntries(RESOURCES.map(v => [v, `DSAUTO.Entry.Resource.${v}`])), label });
    case "movement": return new f.SetField(new f.StringField({ blank: false, choices: Object.fromEntries(MOVEMENTS.map(m => [m, m])) }), { label });
    case "mode": return type === "modifier"
      ? new f.StringField({ required: true, blank: false, initial: "add", choices: keyed(MODIFIER_MODES, "ModifierMode"), label })
      : new f.StringField({ required: true, blank: false, initial: "normal", choices: choices(TELEPORT_MODES), label });
    case "text": return str();
    case "until": return str({ choices: Object.fromEntries([["", "DSAUTO.Entry.None"], ...UNTILS.map(v => [v, `DSAUTO.Entry.Until.${v}`])]) });
    case "spender": return new f.StringField({ required: true, blank: false, initial: "target", choices: Object.fromEntries(SPENDERS.map(v => [v, `DSAUTO.Entry.Spender.${v}`])), label });
    case "properties": return new f.SetField(new f.StringField({ blank: false, choices: Object.fromEntries(FORCED_PROPERTIES.map(v => [v, v])) }), { label });
    // Milestone 6: summons. `actors` are compendium Actor uuids, shown as tags.
    case "actors": return new f.SetField(new f.StringField({ blank: false }), { label });
    case "quantity": return str();
    case "origin": return pick(SUMMON_ORIGINS, "Origin");
    case "side": return pick(SUMMON_SIDES, "Side");
    case "turn": return pick(SUMMON_TURNS, "Turn");
    case "squad": return pick(SUMMON_SQUADS, "Squad");
    case "lasts": {
      const initial = type === "zone" ? ZONE_DEFAULTS.lasts : SUMMON_DEFAULTS.lasts;
      return new f.SetField(new f.StringField({ blank: false, choices: keyed(SUMMON_LASTS, "Lasts") }), { initial: [...initial], label });
    }
    case "actsThisRound": return new f.BooleanField({ initial: true, label });
    // Milestone 7: zones.
    case "zoneEvents": return new f.SetField(new f.StringField({ blank: false, choices: keyed(ZONE_EVENTS, "ZoneEvent") }), { initial: [...ZONE_DEFAULTS.zoneEvents], label });
    case "once": return zonePick(ZONE_ONCE, "Once");
    case "affects": return zonePick(ZONE_AFFECTS, "Affects");
    case "shape": return zonePick(ZONE_SHAPES, "Shape");
    case "exceptKeywords":
    case "exceptMonsters": return new f.SetField(new f.StringField({ blank: false }), { label });
    case "size":
    case "width":
    case "range": return str();
    case "onceShared":
    case "perSquare": return new f.BooleanField({ initial: false, label });
    case "forcedCounts": return new f.BooleanField({ initial: true, label });
    // Milestone 9: "" (no terrain) or a ZONE_TERRAINS value.
    case "terrain": return str({ choices: Object.fromEntries([["", "DSAUTO.Entry.None"], ...ZONE_TERRAINS.map(v => [v, `DSAUTO.Entry.Terrain.${v}`])]) });
    // Milestone 9: modifiers (an actor property path, checked by the schema), picks and teleport boosts.
    case "key": return str();
    case "pickCount": return new f.NumberField({ integer: true, min: 1, max: MAX_PICK, initial: 1, label });
    case "pickWithin": return str();
    case "pickOf": return new f.StringField({ required: true, blank: false, initial: "self", choices: keyed(PICK_OF, "PickOf"), label });
    case "pickFilter": return str({ choices: Object.fromEntries([["", "DSAUTO.Entry.None"], ...FILTERS.map(v => [v, `DSAUTO.Entry.Filter.${v}`])]) });
    case "pickDamageTypes": return new f.SetField(new f.StringField({ blank: false }), { label });
    case "pickFlanking": return new f.BooleanField({ initial: false, label });
    case "boostResource": return str({ choices: Object.fromEntries([["", "DSAUTO.Entry.None"], ...BOOST_RESOURCES.map(v => [v, `DSAUTO.Entry.Resource.${v}`])]) });
    case "boostPer": return new f.NumberField({ integer: true, min: 1, max: 10, initial: 1, label });
    case "boostMax": return new f.NumberField({ integer: true, min: 1, max: 20, nullable: true, initial: null, label });
  }
  return str();
}

function makeType(BaseSpecialEffect, type) {
  // Milestone 9: entryFieldsOf adds the flattened pick and boost fields where the type has them.
  const keys = entryFieldsOf(type);
  return class extends BaseSpecialEffect {
    static get TYPE() {
      return `${ENTRY_PREFIX}${type}`;
    }

    static defineSchema() {
      const f = foundry.data.fields;
      return Object.assign(super.defineSchema(), {
        dsAuto: new f.SchemaField(Object.fromEntries(keys.map(k => [k, fieldFor(k, type)]))),
      });
    }

    get detailsPartial() {
      return PARTIAL;
    }

    get label() {
      return this.name || game.i18n.localize(`TYPES.SpecialEffect.dsAuto.${type}`);
    }

    async getSheetContext() {
      const fields = this.schema.fields.dsAuto.fields;
      const src = this._source?.dsAuto ?? {};
      return {
        rows: keys.map(k => ({ field: fields[k], value: src[k] instanceof Array ? src[k] : src[k], name: `dsAuto.${k}` })),
      };
    }

    showUse() {
      return false;
    }
  };
}

let registered = false;

/** Register the types (module import time). Returns false outside a Draw Steel world. */
export function registerEntryTypes() {
  if (registered) return true;
  const Base = globalThis.ds?.data?.pseudoDocuments?.specialEffects?.BaseSpecialEffect;
  const registry = globalThis.ds?.CONFIG?.SpecialEffect;
  if (!Base || !registry || !globalThis.foundry?.data?.fields) return false;
  for (const type of EFFECT_TYPES) {
    // The prefixed key, never the bare type: "summon" is an effect type and a reserved name (M6-DESIGN §1.1).
    const key = `${ENTRY_PREFIX}${type}`;
    assertNotReserved(key);
    registry[key] = {
      label: `TYPES.SpecialEffect.dsAuto.${type}`,
      defaultImage: "icons/svg/aura.svg",
      documentClass: makeType(Base, type),
    };
  }
  try {
    globalThis.Handlebars?.registerPartial?.(PARTIAL, PARTIAL_SOURCE);
  } catch (_err) { /* re-registered on init */ }
  registered = true;
  return true;
}

/** Handlebars may not exist yet at import time: register the partial again on init. */
export function registerEntryPartial() {
  try {
    globalThis.Handlebars?.registerPartial?.(PARTIAL, PARTIAL_SOURCE);
  } catch (_err) { /* ignore */ }
}

export const entryTypesRegistered = () => registered;
