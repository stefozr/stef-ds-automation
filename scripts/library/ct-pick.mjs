/**
 * 1.2.2: a library `pick` row (targets: "pick") whose effect Combat Tools already asked for on this card. Combat Tools'
 * copy of the ability keeps a flat effect of the same kind (`dsct.flatDamage` for a damage pick) behind its own choice,
 * its target picker stamps the chosen tokens (`flags.draw-steel-combat-tools.useTargets`) and its roll dialog the
 * damage type (`flatDmgTypes[<flat effect id>]`). The answer is read here; engine.mjs answerPicksFromCt gives it to
 * recordPick, which checks it against the pick (count, distance, anchor, allowed types) like any pick.
 */
import { DSCT_ID } from "../constants.mjs";
import { effectShows } from "./choose-compat.mjs";
import { DSCT_FLAT } from "./resolve.mjs";

const flagOf = (message, key) => {
  try {
    return message?.getFlag?.(DSCT_ID, key) ?? message?.flags?.[DSCT_ID]?.[key] ?? null;
  } catch (_err) {
    return null;
  }
};

/**
 * @param {Item} item
 * @param {ChatMessage} message
 * @param {object} op             The pending pick row (`op.pick.effectType`, `.damageTypes`).
 * @param {object|null} assignment  chooseAssignment(item, message)
 * @returns {{tokenUuids: string[], damageType: string|null}|null}  null when the card does not hold a usable answer
 */
export function ctPickAnswer(item, message, op, assignment) {
  const p = op?.pick;
  if (!p?.effectType) return null;
  const targets = flagOf(message, "useTargets");
  const tokenUuids = Array.isArray(targets) ? [...new Set(targets.filter(u => typeof u === "string" && u))] : [];
  if (!tokenUuids.length || tokenUuids.length !== targets.length) return null;
  let flat = [];
  try {
    flat = [...(item?.system?.effects?.contents ?? [])].filter(e => DSCT_FLAT[e.type] === p.effectType && effectShows(e.name, assignment));
  } catch (_err) { /* no special effects */ }
  if (!flat.length) return null;
  const types = p.damageTypes ?? [];
  if (!types.length) return { tokenUuids, damageType: null };
  const chosen = flagOf(message, "flatDmgTypes") ?? {};
  const found = new Set(flat.map(e => chosen[e.id]).filter(t => typeof t === "string" && types.includes(t)));
  return found.size === 1 ? { tokenUuids, damageType: [...found][0] } : null;
}
