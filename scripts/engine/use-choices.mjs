/**
 * 0.15.0: the "choose one" picks made in the Use Ability dialog (ui/use-choice.mjs), noted when the dialog closes and
 * taken once by the seed on the author's client, like the dialog's spend (engine/spend.mjs). Author-provided data:
 * ids are checked here, and the resolve keeps a pick only when it names an option of the plan's group.
 */

const KEEP_MS = 120_000;
/** As the relay's `choose` action (relay/queries.mjs): group and option ids are short strings. */
export const MAX_CHOICE_ID = 40;
const MAX_GROUPS = 10;
let last = null;

const validId = v => typeof v === "string" && v.length > 0 && v.length <= MAX_CHOICE_ID;

/** Note the picks of an ability just used on this client: `{group: option}`. */
export function noteChoices(itemUuid, picks) {
  if (!itemUuid || !picks || typeof picks !== "object") return;
  last = { itemUuid, picks: { ...picks }, at: Date.now() };
}

/** The picks noted for this ability on this client (consumed once): `{group: option}`, or null. */
export function takeChoices(itemUuid) {
  const entry = last;
  if (!entry || entry.itemUuid !== itemUuid || Date.now() - entry.at > KEEP_MS) return null;
  last = null;
  const out = Object.fromEntries(Object.entries(entry.picks).filter(([g, o]) => validId(g) && validId(o)).slice(0, MAX_GROUPS));
  return Object.keys(out).length ? out : null;
}
