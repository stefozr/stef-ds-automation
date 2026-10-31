/**
 * Reactive power rolls (1.1.0). An ability whose power roll is reactive ("each enemy in the area makes an Intuition
 * test") has no roll on its card: each target rolls a test later, and Draw Steel: Target Damage records the result
 * on the ability card (`state.reactiveResults`, one entry per target, kept current on rerolls). The resolve gives
 * those targets their test's tier on a synthetic part ("reactive"), so the tier's native rows are planned like any
 * other tier; damage comes from the effect's tier value (`toDamageRoll`), evaluated once and kept in the record.
 */
import { DSTD_ID, MODULE_ID } from "../constants.mjs";
import { dstdActive, dstdState, dstdTargetTokenUuids } from "../compat/dstd.mjs";
import { setting } from "../settings.mjs";
import { targetKey } from "./keys.mjs";
import { targetsFromTokenUuids } from "./targets.mjs";

/** The synthetic part id of a target's test result. */
export const REACTIVE_PART = "reactive";

/** Does this ability make its targets roll a test instead of rolling itself? */
export function isReactiveItem(item) {
  return item?.system?.power?.roll?.reactive === true;
}

/** Reactive support is on (world setting) and Target Damage, which records the results, is active. */
export function reactiveEnabled() {
  return setting("reactiveTests") !== false && dstdActive();
}

/** The test part of a test message (the system's `test000000000000`, `resultSource` = the ability). */
export function testPartOf(message) {
  return (message?.system?.parts?.contents ?? []).find(p => p?.type === "test" && p.resultSource) ?? null;
}

/**
 * The tier of a test card as the system shows it: the product of the test part's latest roll (a Hero Token reroll
 * appends to the part's rolls, which Target Damage's reroll sync does not read). Null without the message.
 */
function testCardResult(rollMessageId) {
  const part = testPartOf(game.messages?.get?.(rollMessageId ?? ""));
  const roll = [...(part?.rolls ?? [])].reverse().find(r => [1, 2, 3].includes(Number(r?.product)));
  return roll ? { tier: Number(roll.product), total: Number(roll.total) || 0 } : null;
}

/**
 * The test results on a card: target key -> `{tokenUuid, tier, total, rollMessageId, characteristic}`, from Target
 * Damage's records, with the tier and total of the test card itself when it is loaded. A target with several
 * entries (one per characteristic) keeps its newest.
 */
export function reactiveResults(message) {
  const out = {};
  const at = r => Number(r?.rerolledAt ?? r?.rolledAt ?? 0);
  for (const r of Object.values(dstdState(message)?.reactiveResults ?? {})) {
    const tokenUuid = r?.target?.tokenUuid;
    const live = testCardResult(r?.rollMessageId);
    const tier = live?.tier ?? Number(r?.tier);
    if (typeof tokenUuid !== "string" || ![1, 2, 3].includes(tier)) continue;
    const key = targetKey(tokenUuid);
    if (out[key] && at(out[key]) > at(r)) continue;
    out[key] = { tokenUuid, tier, total: live?.total ?? (Number(r.total) || 0), rollMessageId: r.rollMessageId ?? null,
      characteristic: r.characteristic ?? null, at: at(r) };
  }
  return out;
}

/** What the record remembers of the results and the target list: a change of either re-resolves the card. */
export function reactiveSignature(message) {
  const all = Object.entries(reactiveResults(message));
  const results = Object.fromEntries(all.map(([key, r]) => [key, `${r.tier}|${r.rollMessageId ?? ""}`]));
  const totals = Object.fromEntries(all.map(([key, r]) => [key, r.total]));
  return { results, totals, targets: [...dstdTargetTokenUuids(message)].map(targetKey).sort() };
}

/** Target keys whose tier differs between two signatures (a new result, or a reroll to another tier). */
export function changedResultKeys(before, after) {
  const keys = new Set([...Object.keys(before?.results ?? {}), ...Object.keys(after?.results ?? {})]);
  return [...keys].filter(k => before?.results?.[k] !== after?.results?.[k]);
}

/** Same target list, tiers and totals (a reroll to the same tier only changes the total shown)? */
export function sameSignature(a, b) {
  return JSON.stringify(a?.targets ?? []) === JSON.stringify(b?.targets ?? []) && !changedResultKeys(a, b).length
    && JSON.stringify(a?.totals ?? {}) === JSON.stringify(b?.totals ?? {});
}

/**
 * Give a reactive card's targets their test tiers (mutates `targets`). Target Damage's area targets and every
 * creature with a result join the card. A target with a result gets `tier`, `partId: "reactive"`, its damage
 * "rolls" (`reactiveRolls`, reused while the result is the same) and `damageRollIndexes`; one without waits
 * (`awaitingTest`).
 * @param {ChatMessage} message
 * @param {Item} item                 The reactive ability.
 * @param {Record<string, object>} targets
 * @param {Record<string, object>} previous  The stored target records (reused damage amounts).
 */
export async function prepareReactiveTargets(message, item, targets, previous = {}) {
  const results = reactiveResults(message);
  const join = targetsFromTokenUuids([...dstdTargetTokenUuids(message), ...Object.values(results).map(r => r.tokenUuid)]);
  for (const [key, t] of Object.entries(join)) if (!targets[key]) targets[key] = t;
  const damageEffects = [...(item.system?.power?.effects?.documentsByType?.damage ?? [])];
  for (const [key, t] of Object.entries(targets)) {
    if (t.self && !t.alsoTarget) continue;
    const r = results[key];
    if (!r) {
      // Explicit values, not deletions: the record write merges into the stored target.
      Object.assign(t, { tier: null, partId: null, damageRollIndexes: [], awaitingTest: true, reactive: null, reactiveRolls: null });
      continue;
    }
    const old = previous?.[key];
    const same = old?.reactive && old.tier === r.tier && old.reactive.rollMessageId === r.rollMessageId && Array.isArray(old.reactiveRolls);
    const rolls = same ? old.reactiveRolls : await reactiveDamage(damageEffects, r.tier);
    Object.assign(t, {
      awaitingTest: false, tier: r.tier, partId: REACTIVE_PART, reactive: { total: r.total, rollMessageId: r.rollMessageId, characteristic: r.characteristic },
      reactiveRolls: rolls, damageRollIndexes: rolls.map((_r, i) => i),
    });
  }
}

/** The tier's damage of each damage effect, as plain roll records (what buildPlan reads of a card roll). */
async function reactiveDamage(effects, tier) {
  const out = [];
  for (const pre of effects) {
    const roll = pre.toDamageRoll?.(tier);
    if (!roll) continue;
    await roll.evaluate();
    out.push({
      total: roll.total, type: roll.type ?? roll.options?.type ?? "", ignoredImmunities: [...(roll.ignoredImmunities ?? roll.options?.ignoredImmunities ?? [])],
      aoe: !!(roll.aoe ?? roll.options?.aoe), isHeal: !!roll.isHeal, formula: roll.formula,
    });
  }
  return out;
}

/** The reactive card whose results name this test message (newest cards first), or null. */
export function cardOfTest(testMessageId) {
  if (!testMessageId) return null;
  const messages = game.messages?.contents ?? [];
  for (let i = messages.length - 1, seen = 0; i >= 0 && seen < 200; i--, seen++) {
    const m = messages[i];
    const results = m?.flags?.[DSTD_ID]?.state?.reactiveResults;
    if (!results || !m.flags?.[MODULE_ID]?.resolution?.reactive) continue;
    const hit = Object.values(results).find(r => r?.rollMessageId === testMessageId);
    if (hit) return { message: m, key: targetKey(hit.target?.tokenUuid ?? "") };
  }
  return null;
}
