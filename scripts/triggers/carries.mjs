/**
 * 1.2.2: does a creature carry an effect that comes from an owner's ability (Judgement's "judged", Mark's "marked")?
 * Shared by event gains (resources/gains.mjs dealerEffect / takerEffect), trigger requirements (`subjectEffect` /
 * `sourceEffect`) and feature rules. Lives here so eligibility.mjs needs nothing of the gain engine.
 */
import { itemDsid } from "../library/identity.mjs";

function lookup(uuid) {
  if (!uuid) return null;
  try {
    return fromUuidSync(uuid);
  } catch (_err) {
    return null;
  }
}

function list(c) {
  if (!c) return [];
  if (Array.isArray(c)) return c;
  if (Array.isArray(c.contents)) return c.contents;
  if (typeof c.values === "function") return [...c.values()];
  return [];
}

/**
 * Does `actor` carry an enabled effect from the gainer's ability (CH8): its origin resolves to an item of the gainer
 * (or starts with the gainer's uuid) and its id is the effect id, or the origin item's dsid is the ability.
 */
export function carriesEffectOf(actor, gainer, spec, { skipCtFlag = null } = {}) {
  if (!actor || !gainer?.uuid || !spec?.ability) return false;
  let effects = [];
  try {
    effects = list(actor.appliedEffects ?? actor.effects);
  } catch (_err) {
    return false;
  }
  for (const e of effects) {
    if (!e || e.disabled) continue;
    // 1.2.2: an effect Combat Tools made and still automates itself (ctYieldFlag) is left to Combat Tools.
    if (skipCtFlag && (e.getFlag?.("draw-steel-combat-tools", skipCtFlag) ?? e.flags?.["draw-steel-combat-tools"]?.[skipCtFlag])) continue;
    const origin = typeof e.origin === "string" ? e.origin : null;
    if (!origin) continue;
    const doc = lookup(origin);
    const owner = doc?.actor ?? (doc?.documentName === "Actor" ? doc : doc?.parent) ?? null;
    const ours = (owner?.uuid && owner.uuid === gainer.uuid) || origin.startsWith(`${gainer.uuid}.`);
    if (!ours) continue;
    if (spec.effect && e.id === spec.effect) return true;
    if (doc && itemDsid(doc) === spec.ability) return true;
  }
  return false;
}
