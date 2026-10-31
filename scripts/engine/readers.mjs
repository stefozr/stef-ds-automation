/**
 * Readers for the ability card shape, decided per CARD (Milestone 8, docs/M8-DESIGN.md §1.1, D1-D2):
 * - "tierParts" (every Draw Steel 1.1.2 card, and untargeted 1.2 uses): one `abilityResult` part per tier of success
 *   (`tier{N}Result00000`), holding one PowerRoll per target (options.target = ACTOR uuid) followed by one DamageRoll
 *   per damage effect (AbilityModel#use, draw-steel.mjs:6409-6440).
 * - "targetResult" (1.2 uses with targets): one `targetResult` part per target with its own `tier`, `targetUuid`
 *   (actor), `tokenUuid` (token, #2202), `potencies` (manual adjustments per PRE id) and `rolls: [powerRoll,
 *   ...damageRolls]` evaluated per target (R/data/item/ability.mjs:673-703).
 * - "unknown": a 1.2 development build whose `targetResult` schema has no `tokenUuid` field (older than 2026-10-05:
 *   it may pair targets with the wrong roll); every row is manual.
 */
import { compat } from "../compat/version-gate.mjs";

/**
 * Shape of ONE card from its (live or source) parts: "targetResult" | "tierParts" | "unknown".
 * `tokenField`: `compat.targetTokenUuid` (WP-B probe; null on 1.1.2 = not applicable, false only on a 1.2 build
 * without the field).
 */
export function cardShape(parts, { tokenField = compat.targetTokenUuid ?? null } = {}) {
  const list = Array.isArray(parts) ? parts : [...(parts ?? [])];
  if (!list.some(p => p?.type === "targetResult")) return "tierParts";
  return tokenField === false ? "unknown" : "targetResult";
}

/**
 * Read a card: `{shape, parts}`. parts: `[{tier, partId, damageRollIndexes, actorUuids, rollCount}]` plus, on a
 * targetResult card, `tokenUuid` and `potencies` per part. Sorted by tier.
 */
export function readCard(message) {
  const parts = message?.system?.parts?.contents ?? [];
  const shape = cardShape(parts);
  if (shape === "tierParts") return readTierParts(message);
  if (shape === "unknown") return { shape, parts: [] };
  const DamageRoll = ds.rolls.DamageRoll;
  const out = [];
  for (const part of parts) {
    if (part?.type !== "targetResult") continue;
    const rolls = part.rolls ?? [];
    const damageRollIndexes = [];
    rolls.forEach((r, i) => { if (r instanceof DamageRoll) damageRollIndexes.push(i); });
    out.push({
      tier: Number(part.tier), partId: part.id, damageRollIndexes, actorUuids: part.targetUuid ? [part.targetUuid] : [],
      tokenUuid: part.tokenUuid || null, rollCount: rolls.length, potencies: { ...(part.potencies ?? {}) },
    });
  }
  out.sort((a, b) => a.tier - b.tier);
  return { shape, parts: out };
}

/** Read the tier parts of a card (the "tierParts" shape; readCard dispatches here). */
export function readTierParts(message) {
  const parts = message?.system?.parts?.contents ?? [];
  const PowerRoll = ds.rolls.PowerRoll;
  const DamageRoll = ds.rolls.DamageRoll;
  const out = [];
  for (const part of parts) {
    if (part.type !== "abilityResult") continue;
    const rolls = part.rolls ?? [];
    const damageRollIndexes = [];
    const actorUuids = [];
    rolls.forEach((roll, i) => {
      if (roll instanceof DamageRoll) damageRollIndexes.push(i);
      else if (roll instanceof PowerRoll && roll.options?.target) actorUuids.push(roll.options.target);
    });
    out.push({ tier: Number(part.tier), partId: part.id, damageRollIndexes, actorUuids, rollCount: rolls.length });
  }
  out.sort((a, b) => a.tier - b.tier);
  return { shape: "tierParts", parts: out };
}

/**
 * Assign a tier to each target. A target's actor uuid is matched against the PowerRoll targets of
 * every tier part. If the card has a single tier part without targeted rolls (no targets at roll
 * time), every target gets that tier. An actor found in several tiers (two tokens of one linked
 * actor rolled differently) is ambiguous.
 * @returns {Record<string, {tier: number|null, partId: string|null, damageRollIndexes: number[], ambiguous?: boolean}>}
 */
export function assignTiers(targets, tierParts) {
  const result = {};
  const untargeted = tierParts.length === 1 && tierParts[0].actorUuids.length === 0 ? tierParts[0] : null;
  for (const [key, t] of Object.entries(targets)) {
    const matches = tierParts.filter(p => p.actorUuids.includes(t.actorUuid));
    const tiers = new Set(matches.map(m => m.tier));
    if (matches.length && tiers.size === 1) {
      const m = matches[0];
      result[key] = { tier: m.tier, partId: m.partId, damageRollIndexes: [...m.damageRollIndexes] };
    } else if (matches.length > 1) {
      const m = matches[matches.length - 1];
      result[key] = { tier: m.tier, partId: m.partId, damageRollIndexes: [...m.damageRollIndexes], ambiguous: true };
    } else if (untargeted) {
      result[key] = { tier: untargeted.tier, partId: untargeted.partId, damageRollIndexes: [...untargeted.damageRollIndexes] };
    } else {
      result[key] = { tier: null, partId: null, damageRollIndexes: [] };
    }
  }
  return result;
}

/**
 * targetResult cards: a target gets the part of its token (`tokenUuid`, exact); without one, the parts of its actor
 * that carry no `tokenUuid` (third-party callers): several with different tiers are ambiguous (the last one wins).
 * Same return shape as assignTiers, plus the part's `potencies`.
 */
export function assignTargetResults(targets, parts) {
  const byToken = new Map(parts.filter(p => p.tokenUuid).map(p => [p.tokenUuid, p]));
  const result = {};
  for (const [key, t] of Object.entries(targets)) {
    let m = t.tokenUuid ? byToken.get(t.tokenUuid) ?? null : null;
    let ambiguous = false;
    if (!m) {
      const byActor = parts.filter(p => !p.tokenUuid && p.actorUuids.includes(t.actorUuid));
      if (byActor.length) {
        ambiguous = new Set(byActor.map(p => p.tier)).size > 1;
        m = byActor.at(-1);
      }
    }
    result[key] = m
      ? { tier: m.tier, partId: m.partId, damageRollIndexes: [...m.damageRollIndexes], potencies: { ...(m.potencies ?? {}) }, ...(ambiguous ? { ambiguous } : {}) }
      : { tier: null, partId: null, damageRollIndexes: [] };
  }
  return result;
}

/** Tiers of the targets of a card read by readCard (dispatch on its shape; "unknown" assigns nothing). */
export function assignCard(targets, read) {
  if (read?.shape === "tierParts") return assignTiers(targets, read.parts);
  if (read?.shape === "targetResult") return assignTargetResults(targets, read.parts);
  return {};
}

/** Roll counts per result part (both shapes), used to notice rolls appended later (surges, modified damage). */
export function rollCounts(tierParts) {
  return Object.fromEntries(tierParts.map(p => [p.partId, p.rollCount]));
}
