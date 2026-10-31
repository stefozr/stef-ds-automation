/**
 * What the ability's user chose to spend in the roll dialog (`@spend` in formulas).
 *
 * The system puts the dialog's spend values into the roll data of damage formulas only
 * (`rollData.spend = Object.values(fd.spend)`, draw-steel.mjs:5793, 6444) and stores nothing on the card.
 * The dialog keeps the live choice in `options.context.spend` (draw-steel.mjs:4546), so the author's
 * client notes it when the dialog closes and the seed copies it into the record; forced movement
 * distances are then evaluated with the same `@spend` the damage formulas saw.
 * It is author-provided data (like the seeded targets): values are clamped to small integers.
 */

const KEEP_MS = 120_000;
const MAX_VALUE = 20;
let last = null;

function noteSpend(app) {
  try {
    const item = app?.item ?? app?.options?.item ?? null;
    const spend = app?.options?.context?.spend;
    if (!item?.uuid || !spend || typeof spend !== "object") return;
    last = { itemUuid: item.uuid, values: Object.values(spend), at: Date.now() };
  } catch (_err) { /* never break the dialog */ }
}

export function registerSpendCapture() {
  Hooks.on("closeAbilityConfigurationDialog", noteSpend);
}

/** The spend values for an ability just used on this client (consumed once), or null. */
export function takeSpend(itemUuid) {
  const entry = last;
  if (!entry || entry.itemUuid !== itemUuid || Date.now() - entry.at > KEEP_MS) return null;
  last = null;
  const values = entry.values.map(v => Math.max(0, Math.min(MAX_VALUE, Math.floor(Number(v) || 0))));
  return values.length ? values : null;
}

/** Clamp a stored spend list (the record is author-seeded). */
export function spendValues(raw) {
  if (!Array.isArray(raw)) return null;
  const values = raw.slice(0, 10).map(v => Math.max(0, Math.min(MAX_VALUE, Math.floor(Number(v) || 0))));
  return values.length ? values : null;
}

/**
 * Draw Steel 1.2 stores the dialog's spend on the card (`abilityUse.spendAmounts = fd.spend`, R/data/item/ability.mjs:
 * 597-606): the clamped values for any author (the GM-side adoption included), or null when the part has none.
 */
export function spendFromUse(use) {
  const raw = use?.spendAmounts;
  if (!raw || typeof raw !== "object") return null;
  return spendValues(Object.values(raw));
}
