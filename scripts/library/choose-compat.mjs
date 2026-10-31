/**
 * Draw Steel: Combat Tools "choose one" abilities (Milestone 4).
 *
 * A `dsct.choose` special effect lists choices; each choice names the effects that belong to it
 * (`choose.choices[i].effects`: names of power roll effects or special effects). The user picks in
 * Combat Tools' dialog before the roll, and Combat Tools stamps the picks on the card
 * (`flags["draw-steel-combat-tools"].choosePicks = {effectId: index | [indexes]}`, choose-effect.mjs
 * `_stampMessage`). An effect whose name some choice claims shows only when a picked choice claims it
 * (`_effectShows`); unclaimed effects always show. We apply the same rule to applied and forced
 * effects (damage rolls are already filtered by Combat Tools) and to library effects with a `name`.
 *
 * 0.17.0: a library choice group whose options name Combat Tools' choices (`dsctOption`, Practical Magic) is answered by
 * the card's picks (`dsctPickedOption`), so the user is not asked a second time on our card.
 */
import { DSCT_ID } from "../constants.mjs";

const FLAG = "choosePicks";

function chooseEffects(item) {
  try {
    return [...(item?.system?.effects?.contents ?? [])].filter(e => e.type === "dsct.choose" && (e.choose?.choices?.length ?? 0) > 0);
  } catch (_err) {
    return [];
  }
}

const pickedIndexes = (picks, effectId) => {
  const value = picks?.[effectId];
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map(Number).filter(Number.isInteger);
};

/**
 * What the card's picks select.
 * @returns {null | {picked: boolean, claimed: Set<string>, active: Set<string>}}
 *   null when the ability has no choose effect; `picked` false when the card carries no picks (Combat
 *   Tools inactive, or the card was made another way): then nothing can be filtered.
 */
function cardPicks(message) {
  try {
    return message?.getFlag?.(DSCT_ID, FLAG) ?? message?.flags?.[DSCT_ID]?.[FLAG] ?? null;
  } catch (_err) {
    return null;
  }
}

export function chooseAssignment(item, message) {
  const effects = chooseEffects(item);
  if (!effects.length) return null;
  const picks = cardPicks(message);
  const claimed = new Set();
  const active = new Set();
  for (const effect of effects) {
    const chosen = pickedIndexes(picks, effect.id);
    (effect.choose.choices ?? []).forEach((choice, index) => {
      for (const name of choice.effects ?? []) {
        const n = String(name).trim();
        if (!n) continue;
        claimed.add(n);
        if (chosen.includes(index)) active.add(n);
      }
    });
  }
  return { picked: !!picks && Object.keys(picks).length > 0, claimed, active };
}

/**
 * 0.17.0: the option of a library choice group that Combat Tools' picks on the card select: the one option whose
 * `dsctOption` names a picked choice (null when none or several do, or the card carries no picks).
 */
export function dsctPickedOption(item, message, group) {
  const effects = chooseEffects(item);
  const picks = effects.length ? cardPicks(message) : null;
  if (!picks) return null;
  const names = new Set();
  for (const effect of effects) {
    const choices = effect.choose.choices ?? [];
    for (const i of pickedIndexes(picks, effect.id)) if (choices[i]?.name) names.add(String(choices[i].name).trim());
  }
  const hits = (group?.options ?? []).filter(o => o?.dsctOption && names.has(String(o.dsctOption).trim()));
  return hits.length === 1 ? hits[0].id : null;
}

/** Does an effect with this name apply under the assignment? Unnamed and unclaimed effects always do. */
export function effectShows(name, assignment) {
  if (!assignment) return true;
  const n = String(name ?? "").trim();
  if (!n || !assignment.claimed.has(n)) return true;
  return assignment.active.has(n);
}
