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
