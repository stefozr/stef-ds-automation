/**
 * 0.16.0: what Combat Tools 1.2.6 does when an ability is used, mirrored before our own `use` work runs
 * (engine/areas.mjs registerAutomaticAreas). Both functions never throw.
 * - dsctRangeExempt: Combat Tools' range check on the roll dialog (conditions/grab.mjs _checkAbilityRange) measures a
 *   "melee or ranged" ability by its melee distance unless `system.damageDisplay` is "ranged", and its melee/ranged
 *   prompt is remembered 5 minutes per ability, so a ranged use right after a melee one was refused. When every
 *   target is within the longer distance we ask Combat Tools to skip that check for this use (`api.allowOutOfRange`).
 * - dsctAreaPickerFor: Combat Tools places the area of a burst, cube or line ability itself (its area picker,
 *   ability-automation/area-picker.mjs areaOf / checkAndRunAreaPicker); our own placement before the dialog then
 *   placed a second area and cancelled the use.
 */
import { DSCT_ID } from "../constants.mjs";
import { dsctApi, dsctSetting } from "./dsct.mjs";
import { distanceSquares } from "../triggers/eligibility.mjs";
import { log } from "../log.mjs";

const EXEMPT_MS = 60_000;
/** Abilities we exempted. Combat Tools keeps an exemption for its whole window, for every use of the ability. */
const granted = new Set();
const AREA_SHAPES = new Set(["burst", "cube", "line"]);
const EACH_TYPES = new Set(["creature", "enemy", "ally", "object", "creatureObject", "enemyObject", "selfAlly"]);

/** Combat Tools' caster token for an ability: a controlled token of the actor, else any of its tokens on the canvas. */
export function dsctCasterToken(item) {
  const actor = item?.actor ?? item?.parent;
  if (!actor || !globalThis.canvas?.tokens) return null;
  const tokens = canvas.tokens;
  return (tokens.controlled ?? []).find(t => t.actor?.id === actor.id) ?? (tokens.placeables ?? []).find(t => t.actor?.id === actor.id) ?? null;
}

const automationOn = () => !!game.modules.get(DSCT_ID)?.active && dsctSetting("abilityAutomationEnabled", true) !== false;
const triggered = item => !!globalThis.ds?.CONFIG?.abilities?.types?.[item?.system?.type]?.triggered;

/**
 * Exempt a "melee or ranged" ability from Combat Tools' range check for this use when every current target is within
 * its longer distance. Returns true when the exemption was asked for. Any other use of an ability we exempted earlier
 * revokes that exemption, so a farther target within the window is still refused by Combat Tools.
 * @param {Item} item   the ability
 */
export function dsctRangeExempt(item) {
  try {
    const distance = item?.system?.distance;
    const api = dsctApi();
    if (distance?.type !== "meleeRanged" || typeof api?.allowOutOfRange !== "function" || !automationOn() || !item.uuid) return false;
    const revoke = () => {
      if (!granted.delete(item.uuid)) return false;
      api.allowOutOfRange(item.uuid, 0);   // expires now
      log("use.rangeExemptRevoked", { item: item.name });
      return false;
    };
    const reach = Math.max(Number.parseInt(distance.primary) || 0, Number.parseInt(distance.secondary) || 0);
    const caster = dsctCasterToken(item);
    if (!reach || !caster?.document) return revoke();
    const targets = [...(game.user?.targets ?? [])].filter(t => t?.document && t.id !== caster.id);
    if (!targets.length) return revoke();
    // Combat Tools refuses at a gap of `range` squares or more between footprints; distanceSquares is gap + 1.
    const gap = Math.max(...targets.map(t => distanceSquares(caster.document, t.document) - 1));
    if (!Number.isFinite(gap) || gap >= reach) return revoke();
    api.allowOutOfRange(item.uuid, EXEMPT_MS);
    granted.add(item.uuid);
    log("use.rangeExempt", { item: item.name, gap, range: reach });
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * Does Combat Tools place this ability's area itself when it is used (its area picker, or the silent burst of
 * `autoConfirmSelection`)? Mirrors its preconditions; an ability whose "choose one" effect changes the area is read
 * by its own distance and target.
 * @param {Item} item   the ability
 */
export function dsctAreaPickerFor(item) {
  try {
    if (!automationOn() || dsctSetting("abilityTargetingEnabled", true) === false || dsctSetting("areaPicker", true) === false) return false;
    const distance = item?.system?.distance, target = item?.system?.target;
    if (!AREA_SHAPES.has(distance?.type) || target?.value != null || !EACH_TYPES.has(target?.type)) return false;
    if (!(Number(distance.primary) > 0)) return false;
    if (triggered(item) || item.getFlag?.(DSCT_ID, "areaFilter")?.carriers) return false;
    const caster = dsctCasterToken(item);
    return !!caster?.document && caster.document.parent?.id === canvas.scene?.id;
  } catch (_err) {
    return false;
  }
}
