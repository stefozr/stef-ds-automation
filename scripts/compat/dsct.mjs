/** Draw Steel: Combat Tools facade. Every function degrades to a no-op when DSCT is absent. */
import { DSCT_ID } from "../constants.mjs";

export const dsctActive = () => !!game.modules.get(DSCT_ID)?.active;

export function dsctApi() {
  return dsctActive() ? (game.modules.get(DSCT_ID)?.api ?? null) : null;
}

export function dsctSetting(key, fallback = undefined) {
  if (!dsctActive()) return fallback;
  try {
    return game.settings.get(DSCT_ID, key);
  } catch (_err) {
    return fallback;
  }
}

/**
 * Extra squares of forced movement the actor takes (Combat Tools 1.2.7 flag `forcedMovementTaken`, e.g. Choking Dust
 * +2). Combat Tools adds it before stability (forced-movement-engine.mjs:57, :200-205); 0 without Combat Tools.
 */
export function dsctForcedTaken(actor) {
  if (!dsctActive()) return 0;
  return Number(actor?.getFlag?.(DSCT_ID, "forcedMovementTaken")) || 0;
}

/** Combat Tools 1.2.7's handler getters (forced-movement-engine.mjs:46, teleport.mjs:251), from its own module instances. */
const handlerProbes = { forcedMovement: null, teleport: null };

/** Load the handler getters once at ready (the same ES module instances Combat Tools runs). */
export async function loadDsctHandlerProbes() {
  if (!dsctActive()) return;
  const load = async (path, name, key) => {
    try {
      const m = await import(foundry.utils.getRoute(`modules/${DSCT_ID}/src/${path}`));
      if (typeof m[name] === "function") handlerProbes[key] = m[name];
    } catch (_err) { /* moved or renamed: the probe stays unknown */ }
  };
  await Promise.all([
    load("forced-movement/forced-movement-engine.mjs", "forcedMovementHandler", "forcedMovement"),
    load("teleport.mjs", "teleportHandler", "teleport"),
  ]);
}

/**
 * Combat Tools movements another module took over with `registerForcedMovementHandler` / `registerTeleportHandler`
 * (1.2.7): `api.forcedMovement` then answers whatever that handler returns, and teleports post no undo card.
 */
export function dsctForeignHandlers() {
  return Object.entries(handlerProbes).filter(([, get]) => {
    try {
      return !!get?.();
    } catch (_err) {
      return false;
    }
  }).map(([key]) => key);
}

/** DSCT handles frightened / taunted / grabbed itself (flag-based effects with movement enforcement). */
export function dsctConditionsOn() {
  return dsctActive() && dsctSetting("conditionsEnabled", true) !== false && !!dsctApi();
}

/** DSCT moves force-moved creatures itself (setting `forcedMovementEnabled`, API form 3). */
export function dsctForcedOn() {
  return dsctActive() && dsctSetting("forcedMovementEnabled", true) !== false && typeof dsctApi()?.forcedMovement === "function";
}

/** Per-condition DSCT toggles; unknown keys count as enabled. */
export function dsctConditionEnabled(statusId) {
  const key = { frightened: "frightenedEnabled", taunted: "tauntedEnabled", grabbed: "grabEnabled" }[statusId];
  if (!key) return false;
  return dsctSetting(key, true) !== false;
}

/**
 * Does the item carry a DSCT "choose one" special effect with choices? DSCT filters such abilities by
 * effect name at use time (choose-effect.mjs), which we do not replicate before M4, so condition ops
 * on these abilities are never auto-applied.
 */
export function dsctChooseGated(item) {
  try {
    return item?.system?.effects?.contents?.some(e => e.type === "dsct.choose" && (e.choose?.choices?.length ?? 0) > 0) ?? false;
  } catch (_err) {
    return false;
  }
}

/**
 * DSCT handles this targeted status itself (its conditions and the per-condition toggle on): the `auto` route of
 * `targetedConditions` delegates it (Milestone 8, docs/M8-DESIGN.md §3.1), and our frightened warning stays quiet.
 */
export function dsctHandlesTargeted(statusId) {
  return dsctConditionsOn() && dsctConditionEnabled(statusId);
}

/** Find the DSCT flagged effect for a targeted status on an actor. */
export function dsctFlaggedEffect(actor, statusId) {
  return actor?.appliedEffects?.find(e => e.getFlag(DSCT_ID, statusId)) ?? actor?.effects?.find(e => e.getFlag(DSCT_ID, statusId)) ?? null;
}
