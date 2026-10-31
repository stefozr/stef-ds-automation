/**
 * Milestone 7 (docs/M7-DESIGN.md §1.6, §2.1 WP-B, §3.10.4): the RegionBehavior type `stef-ds-automation.zone` (declared by
 * module.json `documentTypes.RegionBehavior.zone`, WP-E). Registered on every client at init, before any scene's
 * regions are prepared.
 *
 * - Static events `tokenMoveIn`, `tokenMoveWithin`, `tokenMoveOut` only (client/data/region-behaviors/base.mjs:58-63):
 *   always delivered, and they make `hasEvent` true, so core splits a movement at the region boundary
 *   (client/documents/token.mjs #splitMovementPath) and a pass-through mid-move is seen. Each handler returns at once
 *   unless this client is the active GM; the engine then checks the region is genuinely ours (`zoneOf`: the flag,
 *   this behavior's zoneId and the card row agree).
 * - Turn events and `tokenEnter` are NOT subscribed (CH11, Q7): turn start / end come from our lifecycle.
 * - The schema's own `events` set is not defined: the base class gives every instance an empty Set, so the
 *   behavior sheet shows no event picker and `_handleRegionEvent` never runs.
 * - Values are GM-only: the region grants the creator's owners OBSERVER, a behavior update needs OWNER.
 * - Defined lazily: `class ... extends foundry.data.regionBehaviors.RegionBehaviorType` cannot be evaluated where the
 *   global is missing (harness mocks), so `makeZoneBehaviorType(Base)` builds it inside `registerZoneBehavior`.
 *
 * - Milestone 9 (docs/M9-DESIGN.md §B, D-B5): `terrain` "difficult" makes the area difficult terrain through core's
 *   terrain extension point (`_getTerrainEffects`, client/data/region-behaviors/base.mjs:129, consumed by
 *   Token#createTerrainMovementPath on every client): a ground move (an action whose terrain difficulty is the walk
 *   one: walk, crawl, climb) of a creature the zone `affects` costs double. Fly, swim, burrow, jump, teleports and
 *   forced moves (`forced`, `displace`) never pay. Radical heroes ignore it through features/capabilities.mjs's cost
 *   wrapper. The static events `behaviorViewed` / `behaviorUnviewed` / `regionBoundary` recompute planned paths.
 *
 * i18n: field labels through LOCALIZATION_PREFIXES DSAUTO.Zone.Behavior (DSAUTO.Zone.Behavior.FIELDS.<f>.label);
 * choices `DSAUTO.Entry.ZoneEvent.<v>`, `DSAUTO.Entry.Once.<v>`, `DSAUTO.Entry.Affects.<v>` (WP-D keys, dynamic),
 * `DSAUTO.Entry.Terrain.<v>` (Milestone 9, dynamic).
 */
import * as schema from "../library/schema.mjs";
import { error, log } from "../log.mjs";
import { affected, onZoneMovement } from "./engine.mjs";
import { zoneFlag, zoneType } from "./registry.mjs";

const EVENTS = () => schema.ZONE_EVENTS ?? ["enter", "move", "turnStart", "turnEnd"];
const ONCE = () => schema.ZONE_ONCE ?? ["round", "none"];
const AFFECTS = () => schema.ZONE_AFFECTS ?? ["enemies", "allies", "all"];
const TERRAINS = () => schema.ZONE_TERRAINS ?? ["difficult"];
/** Milestone 9: the terrain effect of a difficult zone (TerrainData.resolveTerrainEffects multiplies difficulties). */
const DIFFICULT = Object.freeze([Object.freeze({ name: "difficulty", difficulty: 2 })]);
const NONE = Object.freeze([]);
const ICON = "fa-solid fa-draw-polygon";
/** DSAUTO.Zone.Behavior is a prefix, not a key (built so T/check.cjs's key scan does not take it for one). */
const PREFIX = ["DSAUTO", "Zone", "Behavior"].join(".");

/** The data model class once registered (null before, or where Foundry is missing). */
export let ZoneBehaviorType = null;

/** The static handler of the three movement events: active GM only, never throws (bound to the system). */
async function onMovement(event) {
  try {
    if (!game.users?.activeGM?.isSelf) return;
    onZoneMovement(this, event);
  } catch (err) {
    error("zones.behaviorEvent", err, { event: event?.name });
  }
}

const keyed = (values, group) => Object.fromEntries(values.map(v => [v, `DSAUTO.Entry.${group}.${v}`]));

/** Ground actions by their config object (configs are fixed after init; a WeakMap keeps harness mocks apart). */
const groundCache = new WeakMap();

/**
 * Milestone 9: is a movement action a ground move (its terrain difficulty is the walk one)? `walk` itself; before
 * core's setup an action config names `terrainAction: "walk"`; after it, only `deriveTerrainDifficulty` is left, so
 * it is probed twice: walk 2 / the rest 1 must give 2 and walk 1 / the rest 2 must give 1 (crawl and climb do, jump's
 * max(walk, fly) and the teleports' constant 1 do not). Never throws.
 * @param {string} action
 * @returns {boolean}
 */
export function groundAction(action) {
  if (action === "walk") return true;
  try {
    const actions = globalThis.CONFIG?.Token?.movement?.actions;
    const cfg = typeof action === "string" ? actions?.[action] : null;
    if (!cfg || typeof cfg !== "object") return false;
    let ground = groundCache.get(cfg);
    if (ground !== undefined) return ground;
    if (cfg.terrainAction !== undefined) ground = cfg.terrainAction === "walk";
    else if (typeof cfg.deriveTerrainDifficulty === "function") {
      const probe = (walk, rest) => {
        const d = { walk };
        for (const k of Object.keys(actions)) if (k !== "walk") d[k] = rest;
        return cfg.deriveTerrainDifficulty(d);
      };
      ground = probe(2, 1) === 2 && probe(1, 2) === 1;
    } else ground = false;
    groundCache.set(cfg, ground);
    return ground;
  } catch (_err) {
    return false;
  }
}

/** Static region events: planned movement paths follow a terrain zone appearing, leaving or changing shape. */
async function onTerrainChanged(_event) {
  try {
    if (!this?.terrain) return;
    globalThis.canvas?.tokens?.recalculatePlannedMovementPaths?.();
  } catch (err) {
    error("zones.terrainEvent", err);
  }
}

/**
 * Build the behavior data model on a RegionBehaviorType base.
 * @param {typeof foundry.data.regionBehaviors.RegionBehaviorType} Base
 */
export function makeZoneBehaviorType(Base) {
  const f = foundry.data.fields;
  return class ZoneRegionBehaviorType extends Base {
    static LOCALIZATION_PREFIXES = [PREFIX];

    static defineSchema() {
      return {
        zoneId: new f.StringField({ required: true, blank: true, initial: "" }),
        triggers: new f.SetField(new f.StringField({ required: true, blank: false, choices: keyed(EVENTS(), "ZoneEvent") }), { initial: ["enter", "turnStart"] }),
        once: new f.StringField({ required: true, blank: false, choices: keyed(ONCE(), "Once"), initial: "round" }),
        onceShared: new f.BooleanField({ initial: false }),
        perSquare: new f.BooleanField({ initial: false }),
        amount: new f.NumberField({ required: true, nullable: false, integer: true, min: 0, max: 500, initial: 0 }),
        damageType: new f.StringField({ required: true, blank: true, initial: "" }),
        ignoredImmunities: new f.SetField(new f.StringField({ required: true, blank: false })),
        affects: new f.StringField({ required: true, blank: false, choices: keyed(AFFECTS(), "Affects"), initial: "enemies" }),
        exceptKeywords: new f.SetField(new f.StringField({ required: true, blank: false })),
        exceptMonsters: new f.SetField(new f.StringField({ required: true, blank: false })),
        sourceActorUuid: new f.StringField({ required: true, blank: true, initial: "" }),
        aoe: new f.BooleanField({ initial: false }),
        forcedCounts: new f.BooleanField({ initial: true }),
        label: new f.StringField({ required: true, blank: true, initial: "" }),
        // Milestone 9: "" (none) or a ZONE_TERRAINS value; `blank: true` keeps "" valid next to the choices.
        terrain: new f.StringField({ required: true, blank: true, initial: "", choices: keyed(TERRAINS(), "Terrain") }),
      };
    }

    static events = {
      tokenMoveIn: onMovement,
      tokenMoveWithin: onMovement,
      tokenMoveOut: onMovement,
      // Milestone 9: every client, for the terrain cost of planned paths.
      behaviorViewed: onTerrainChanged,
      behaviorUnviewed: onTerrainChanged,
      regionBoundary: onTerrainChanged,
    };

    /**
     * Milestone 9 (D-B5): difficult terrain for the ground moves of a creature this zone affects. Runs per segment
     * per drag frame on every client, so it reads only the region flag (no card lookup) and never throws.
     * @param {TokenDocument} token
     * @param {{action: string}} segment
     * @returns {object[]}
     */
    _getTerrainEffects(token, segment) {
      try {
        if (this.terrain !== "difficult") return NONE;
        const behavior = this.parent ?? null;
        const region = behavior?.region ?? this.region ?? null;
        if (!region || behavior?.disabled) return NONE;
        if (!groundAction(segment?.action)) return NONE;
        if (!this.zoneId || zoneFlag(region)?.zoneId !== this.zoneId) return NONE;
        return affected(this, region, token) ? DIFFICULT : NONE;
      } catch (_err) {
        return NONE;
      }
    }
  };
}

/** init: CONFIG.RegionBehavior.dataModels["stef-ds-automation.zone"] and its icon. Never throws; false without CONFIG. */
export function registerZoneBehavior() {
  try {
    const cfg = globalThis.CONFIG?.RegionBehavior;
    const Base = globalThis.foundry?.data?.regionBehaviors?.RegionBehaviorType;
    if (!cfg?.dataModels || typeof Base !== "function" || !globalThis.foundry?.data?.fields) return false;
    const type = zoneType();
    ZoneBehaviorType ??= makeZoneBehaviorType(Base);
    cfg.dataModels[type] = ZoneBehaviorType;
    if (cfg.typeIcons) cfg.typeIcons[type] = ICON;
    log("zones.behavior", { type });
    return true;
  } catch (err) {
    error("zones.registerBehavior", err);
    return false;
  }
}

export const zoneBehaviorRegistered = () => {
  try {
    return !!ZoneBehaviorType && globalThis.CONFIG?.RegionBehavior?.dataModels?.[zoneType()] === ZoneBehaviorType;
  } catch (_err) {
    return false;
  }
};
