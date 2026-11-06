/** CTLib facade (shared library of the Combat Tools family). */
import { CTLIB_ID } from "../constants.mjs";

export function ctlib() {
  return game.modules.get(CTLIB_ID)?.active ? (globalThis.ctlib ?? null) : null;
}

export function ctlibService(name) {
  try {
    return ctlib()?.services?.get?.(name) ?? null;
  } catch (_err) {
    return null;
  }
}

/**
 * Run damage writes inside ctlib's damage batch so Death Tracker holds kill resolution until every
 * write of the batch has landed (window._dsctDamageBatchDepth).
 */
export async function damageBatch(fn) {
  const lib = ctlib();
  if (typeof lib?.damageBatch === "function") return lib.damageBatch(fn);
  return fn();
}

/** Is the ctlib module active (its journal flag on cards is then live)? */
export const ctlibActive = () => !!game.modules.get(CTLIB_ID)?.active;

/** ctlib's live (not undone) journal entries of a card, `message.flags["draw-steel-ctlib"].journal` (1.2 cards). */
export function ctlibLiveEntries(message) {
  const journal = message?.flags?.[CTLIB_ID]?.journal;
  if (!journal || typeof journal !== "object") return [];
  return Object.values(journal).filter(e => e && typeof e === "object" && !e.undone);
}

/**
 * How ctlib's journal covers one of our ops (a button of the system's per-target section, or its "Apply All Damage",
 * applied the row):
 * - damage / heal / temp: an applyDamage entry for the op's part and roll index (a squad op lists every member's
 *   `{partId, rollIndex}` in `op.parts`);
 * - condition: an applyEffect entry of the same part and effect id;
 * - native resource: a gainResource entry of the same part.
 * @returns {{covered: number, total: number}} Slots of the op that are covered, and how many it has (0 total: no
 *   journal counterpart for this kind of op).
 */
export function ctlibCoverage(message, op) {
  const entries = ctlibLiveEntries(message);
  if (op?.kind === "condition" && !op.lib) {
    return { covered: entries.some(e => e.action === "applyEffect" && e.partId === op.partId && e.effect === op.effectId) ? 1 : 0, total: 1 };
  }
  if (op?.kind === "resource" && op.native) {
    return { covered: entries.some(e => e.action === "gainResource" && e.partId === op.partId) ? 1 : 0, total: 1 };
  }
  if (["damage", "heal", "temp"].includes(op?.kind)) {
    const slots = Array.isArray(op.parts) && op.parts.length ? op.parts : [{ partId: op.partId, rollIndex: op.rollIndex }];
    const covered = slots.filter(s => entries.some(e => e.action === "applyDamage" && e.partId === s?.partId
      && Number(e.index) === Number(s?.rollIndex))).length;
    return { covered, total: slots.length };
  }
  return { covered: 0, total: 0 };
}
