/**
 * Side targets of a card (Milestone 9, docs/M9-DESIGN.md §A, D2 / D3): creatures that get library rows without being
 * the card's targets. Runs on the active GM inside resolveMessage, right before buildPlan, on the copy of the target
 * records the resolve writes.
 *
 * - Picks (`targets: "pick"`): `res.picks[effectId] = {tokenUuids, damageType?, by, at}` is written GM-signed by
 *   engine.mjs recordPick (never by a client). Each picked creature gets `picked: [effectId, ...]` on its record; one
 *   that is no card target gets a record of its own (`pickOnly`) on the card's tier (D2: "tier = card tier"); a card
 *   target keeps its own tier. A picked damage type lands in `pickDamageTypes[effectId]` (library-plan damageRow).
 * - Area (`targets: "area"`): every creature inside the area the use placed: the author's client notes the tokens
 *   inside the region engine/areas.mjs areaUse placed (seeded as `res.area.tokenUuids`, author-provided: validated
 *   strings, the user and other scenes left out); else the card's own template (zones/place.mjs cardTemplate) with
 *   zones/engine.mjs insideRegion; else the banner `areaNotFound`. A card target inside the area gets `area: true,
 *   alsoTarget: true`, any other creature an `area` record of its own (record.mjs areaOnly).
 * Every resolve strips the marks of the previous one first (the records are rebuilt from `res.picks` and the area).
 * A fresh card's `picks` are the author's seed: never read (engine.mjs passes `{}`).
 */
import { MAX_PICK } from "../library/schema.mjs";
import { evaluateInt } from "../library/formula.mjs";
import { zoneArea } from "../zones/shapes.mjs";
import { cardTemplate } from "../zones/place.mjs";
import { insideRegion } from "../zones/engine.mjs";
import { areaOnly, pickedOnly } from "./record.mjs";
import { targetFromTokenDoc } from "./targets.mjs";

/** At most this many creatures come from one area (seeded or found). */
export const MAX_AREA_TOKENS = 60;

const list = c => c?.contents ?? [...(c ?? [])];

function doc(uuid) {
  if (typeof uuid !== "string" || !uuid || uuid.length >= 300) return null;
  try {
    return fromUuidSync(uuid) ?? null;
  } catch (_err) {
    return null;
  }
}

/** Remove the side marks of an earlier resolve: side-only records go, real targets lose `picked` / `area`. */
export function stripSideTargets(targets) {
  for (const [key, t] of Object.entries(targets ?? {})) {
    if (pickedOnly(t) || areaOnly(t)) {
      delete targets[key];
      continue;
    }
    delete t.picked;
    delete t.pickDamageTypes;
    if (t.area) {
      delete t.area;
      if (!t.self) delete t.alsoTarget;
    }
  }
}

/** A stored pick, shape-checked (it is GM-written, but a resolve must never throw on a bad one). */
function validPick(p) {
  return !!p && typeof p === "object" && Array.isArray(p.tokenUuids) && p.tokenUuids.length >= 1 && p.tokenUuids.length <= MAX_PICK
    && p.tokenUuids.every(u => typeof u === "string" && u.length > 0 && u.length < 300)
    && (p.damageType == null || (typeof p.damageType === "string" && /^[a-z]{1,20}$/.test(p.damageType)));
}

/** Records for the picked creatures of every pick effect (D2). */
function attachPicks({ targets, lib, picks, selfKey, cardTier }) {
  for (const effect of lib.effects ?? []) {
    if (effect.targets !== "pick") continue;
    const p = picks?.[effect.id];
    if (!validPick(p)) continue;
    for (const uuid of p.tokenUuids) {
      const rec = targetFromTokenDoc(doc(uuid));
      if (!rec || rec.key === selfKey) continue;
      const t = targets[rec.key] ?? (targets[rec.key] = {
        ...rec, pickOnly: true, tier: cardTier.tier ?? null, partId: cardTier.partId ?? null, damageRollIndexes: [],
      });
      t.picked = [...new Set([...(t.picked ?? []), effect.id])];
      if (p.damageType) t.pickDamageTypes = { ...(t.pickDamageTypes ?? {}), [effect.id]: p.damageType };
    }
  }
}

/** The seeded area tokens (author-provided): a list of uuid strings, or null when the seed has none. */
function seededArea(res) {
  const raw = res?.area?.tokenUuids;
  if (!Array.isArray(raw)) return null;
  return raw.filter(u => typeof u === "string" && u.length > 0 && u.length < 300).slice(0, MAX_AREA_TOKENS);
}

/** GM fallback: the tokens inside the card's own template on the user's scene, or null without one. */
function templateArea({ item, message, sourceTokenUuid }) {
  const source = doc(sourceTokenUuid);
  const scene = source?.parent;
  if (!scene || !item) return null;
  let area = null;
  try {
    area = zoneArea(item, { shape: "ability" }, v => evaluateInt(v, item));
  } catch (_err) {
    area = null;
  }
  if (!area) return null;
  const region = cardTemplate(scene, { itemUuid: item.uuid }, message, area);
  if (!region) return null;
  return list(scene.tokens).filter(t => t?.actor && insideRegion(t, region)).slice(0, MAX_AREA_TOKENS).map(t => t.uuid);
}

/** Records for the creatures inside the area (D3); false when the area was not found. */
function attachArea({ res, targets, item, message, selfKey, sourceTokenUuid, cardTier }) {
  const uuids = seededArea(res) ?? templateArea({ item, message, sourceTokenUuid });
  if (!uuids) return false;
  const source = doc(sourceTokenUuid);
  const userActorUuid = item?.actor?.uuid ?? null;
  for (const uuid of uuids) {
    const d = doc(uuid);
    // The user is never one of "the creatures in the area" (its own row has the self effects); other scenes neither.
    if (!d?.actor || (source && d.parent?.id !== source.parent?.id) || d.actor.uuid === userActorUuid) continue;
    const rec = targetFromTokenDoc(d);
    if (!rec || rec.key === selfKey) continue;
    const t = targets[rec.key];
    if (t) {
      if (t.self) continue;
      t.area = true;
      if (!t.pickOnly) t.alsoTarget = true;
    } else {
      targets[rec.key] = { ...rec, area: true, tier: cardTier.tier ?? null, partId: cardTier.partId ?? null, damageRollIndexes: [] };
    }
  }
  return true;
}

/**
 * Strip the previous side marks and attach the picked and area records for this resolve. Mutates `targets`; pushes
 * `{code: "areaNotFound"}` into `warnings` when an area effect found no area.
 * @param {object} args
 * @param {object} args.res               The stored record (`picks` ignored when `fresh`, `area` seeded).
 * @param {Record<string, object>} args.targets  The resolve's target records (the user's own record included).
 * @param {Item} args.item
 * @param {object} args.lib               resolveAbility(item)
 * @param {ChatMessage} args.message
 * @param {string|null} args.selfKey
 * @param {string|null} args.sourceTokenUuid
 * @param {{tier: number|null, partId: string|null}} args.cardTier   library-plan cardTier()
 * @param {boolean} args.fresh
 * @param {object[]} args.warnings
 */
export function attachSideTargets({ res, targets, item, lib, message, selfKey = null, sourceTokenUuid = null, cardTier = {}, fresh = false, warnings = [] }) {
  stripSideTargets(targets);
  const effects = lib?.effects ?? [];
  if (effects.some(e => e.targets === "pick")) attachPicks({ targets, lib, picks: fresh ? {} : res?.picks, selfKey, cardTier });
  if (effects.some(e => e.targets === "area")) {
    let found = false;
    try {
      found = attachArea({ res, targets, item, message, selfKey, sourceTokenUuid, cardTier });
    } catch (_err) {
      found = false;
    }
    if (!found && !warnings.some(w => w.code === "areaNotFound")) warnings.push({ code: "areaNotFound" });
  }
}
