/**
 * Formulas of library effects: deterministic, evaluated with the ability's roll data (characteristics
 * @M @A @R @I @P, @chr, @level, @potency.weak|average|strong, @recoveries.recoveryValue, ...) plus
 *   @tier      the tier of success the effect applies on (0 without a power roll)
 *   @spend     what the user spent in the roll dialog (sum)
 *   @config.x  the item's configuration (medkit) or the overlay's default
 *   @target.x  the roll data of the creature the effect is applied to (its recovery value, level, ...)
 * The system's own evaluator does the work (ds.utils.evaluateFormula), as for native distances.
 */

/** Evaluate a formula; null when it does not give a finite number. */
export function evaluate(formula, item, { tier = null, spend = null, config = null, actor = null, target = null } = {}) {
  if (typeof formula === "number") return Number.isFinite(formula) ? formula : null;
  if (formula == null || formula === "") return null;
  try {
    const rollData = rollDataFor(item, actor);
    rollData.tier = tier ?? 0;
    rollData.spend = Array.isArray(spend) ? spend.reduce((a, b) => a + (Number(b) || 0), 0) : Number(spend ?? 0) || 0;
    rollData.config = { ...(config ?? {}) };
    if (target) rollData.target = { ...(target.getRollData?.() ?? {}) };
    // The system's evaluator replaces unknown data with 0: an unknown @path makes the formula invalid.
    for (const [, path] of String(formula).matchAll(/@([A-Za-z_][A-Za-z0-9_.]*)/g)) {
      const v = path.split(".").reduce((o, k) => o?.[k], rollData);
      if (v === undefined || v === null || typeof v === "object") return null;
    }
    const value = Number(ds.utils.evaluateFormula(String(formula), rollData, { contextName: item?.uuid ?? "stef-ds-automation" }));
    return Number.isFinite(value) ? value : null;
  } catch (_err) {
    return null;
  }
}

/** Integer result (rounded down), clamped to [min, max]; null when invalid. */
export function evaluateInt(formula, item, ctx = {}, { min = 0, max = 10_000 } = {}) {
  const v = evaluate(formula, item, ctx);
  if (v == null) return null;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

/**
 * Roll data: the ability's (its actor's characteristics and potencies), or another actor's when an
 * effect is about that actor (a target's own recovery value).
 */
function rollDataFor(item, actor) {
  if (actor && actor !== item?.actor) {
    const data = actor.getRollData?.() ?? {};
    return { ...data };
  }
  return { ...(item?.getRollData?.() ?? {}) };
}
