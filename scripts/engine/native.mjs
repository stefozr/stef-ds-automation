/**
 * Translate the structured power-roll effects of an ability (system data) into effect records the
 * plan builder understands. The ability library (M4) will produce the same shape from overlays.
 */
import { dsctChooseGated } from "../compat/dsct.mjs";

/** Forced movement types of the system (ds.CONFIG.abilities.forcedMovement). */
export const FORCED_MOVEMENTS = Object.freeze(["push", "pull", "slide"]);

/**
 * @param {Item} item   The ability item.
 * @returns {{damage: object[], conditions: object[], forced: object[], resources: object[], other: object[], chooseGated: boolean}}
 */
export function nativeEffects(item) {
  const out = { damage: [], conditions: [], forced: [], resources: [], other: [], chooseGated: dsctChooseGated(item) };
  const effects = item?.system?.power?.effects;
  if (!effects) return out;
  for (const pre of effects) {
    if (pre.type === "damage") {
      out.damage.push({ preId: pre.id, name: pre.name });
    } else if (pre.type === "applied") {
      for (const n of [1, 2, 3]) {
        const tierData = pre.applied?.[`tier${n}`];
        if (!tierData) continue;
        for (const [effectId, cfg] of Object.entries(tierData.effects ?? {})) {
          out.conditions.push({
            preId: pre.id,
            preName: pre.name,
            tier: n,
            effectId,
            condition: cfg.condition ?? "always",
            end: cfg.end ?? "",
            stacking: !!cfg.properties?.has?.("stacking"),
            originDuration: !!cfg.properties?.has?.("originDuration"),
            // Prepared values: tiers inherit the characteristic of the previous tier (draw-steel.mjs:20603-20617).
            potency: { characteristic: tierData.potency?.characteristic ?? "", value: tierData.potency?.value ?? "" },
          });
        }
      }
    } else if (pre.type === "forced") {
      const tiers = {};
      for (const n of [1, 2, 3]) {
        const tierData = pre.forced?.[`tier${n}`];
        const movements = [...(tierData?.movement ?? [])].filter(m => FORCED_MOVEMENTS.includes(m));
        if (!movements.length) continue;
        tiers[n] = {
          movements,
          distance: String(tierData.distance ?? "0"),
          properties: [...(tierData.properties ?? [])],
          potency: { characteristic: tierData.potency?.characteristic ?? "", value: tierData.potency?.value ?? "" },
        };
      }
      // Kit and ability bonuses per movement type (prepared, not persisted: draw-steel.mjs:20825, 6083).
      const bonuses = { push: 0, pull: 0, slide: 0, ...(pre.forced?.bonuses ?? {}) };
      out.forced.push({ preId: pre.id, name: pre.name, tiers, bonuses });
    } else if (pre.type === "resource") {
      // Milestone 7 (docs/M7-DESIGN.md §3.6): "gain N surges" per tier, a row per target at its tier.
      const tiers = {};
      for (const n of [1, 2, 3]) {
        const tierData = pre.resource?.[`tier${n}`];
        if (!tierData) continue;
        tiers[n] = { amount: Number(tierData.amount) || 0, type: String(tierData.type ?? "surge") };
      }
      out.resources.push({ preId: pre.id, name: pre.name, tiers });
    } else {
      out.other.push({ preId: pre.id, type: pre.type, name: pre.name });
    }
  }
  return out;
}

/** Does the item have anything the engine can automate (damage, applied effects, forced movement)? */
export function hasAutomatableEffects(item) {
  const effects = item?.system?.power?.effects;
  if (!effects) return false;
  for (const e of effects) if (e.type === "damage" || e.type === "applied" || e.type === "forced" || e.type === "resource") return true;
  return false;
}

/** Status effect config for an id, or null for item-embedded effects. */
export function statusConfig(effectId) {
  return CONFIG.statusEffects.find(s => s.id === effectId) ?? null;
}

/** Display data of an applied effect: a status (i18n key) or the item's embedded effect name. */
export function effectDisplay(item, effectId) {
  const status = statusConfig(effectId);
  if (status) return { statusId: effectId, nameKey: status.name ?? effectId, img: status.img ?? null };
  const ae = item?.effects?.get?.(effectId);
  return { statusId: null, name: ae?.name ?? effectId, img: ae?.img ?? null };
}

/** Status ids an applied effect carries: the status itself, or the item effect's `statuses`. */
export function effectStatuses(item, effectId) {
  if (statusConfig(effectId)) return [effectId];
  const statuses = item?.effects?.get?.(effectId)?.statuses;
  return statuses ? [...statuses] : [];
}
