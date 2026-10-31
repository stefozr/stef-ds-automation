/**
 * libWrapper registrations (Milestone 2 onwards). Every wrapper stef-ds-automation registers goes through
 * `wrap`, so selfCheck can list them. libWrapper is a hard requirement from 0.4.0; without it the
 * turn features stay off (selfCheck reports it) and the M1 engine keeps working.
 */
import { MODULE_ID } from "../constants.mjs";
import { error, log } from "../log.mjs";

/** `{target, type, ok, reason?}` per attempted registration. */
export const registrations = [];

export const libWrapperReady = () => !!game.modules.get("lib-wrapper")?.active && typeof globalThis.libWrapper?.register === "function";

/** Resolve a dotted path ("ds.rolls.DSRoll.prototype.toMessage") to check that the target exists. */
function resolvePath(path) {
  let obj = globalThis;
  for (const key of path.split(".")) {
    obj = obj?.[key];
    if (obj === undefined || obj === null) return undefined;
  }
  return obj;
}

/**
 * Register one wrapper. WRAPPER always chains; MIXED may return without calling `wrapped` (used only
 * where we deduplicate a call or take over a system routine, never to replace a method outright).
 * @param {string} target
 * @param {Function} fn          `function (wrapped, ...args)`; `this` is the wrapped object.
 * @param {"WRAPPER"|"MIXED"} type
 * @returns {boolean} registered
 */
export function wrap(target, fn, type = "WRAPPER") {
  const entry = { target, type, ok: false };
  registrations.push(entry);
  if (!libWrapperReady()) {
    entry.reason = "libWrapper missing";
    return false;
  }
  const keys = target.split(".");
  const parent = resolvePath(keys.slice(0, -1).join("."));
  const getter = parent && Object.getOwnPropertyDescriptor(parent, keys.at(-1))?.get;
  if (!getter && typeof resolvePath(target) !== "function") {
    entry.reason = "target missing";
    log("wrap.skipped", { target, reason: entry.reason });
    return false;
  }
  try {
    globalThis.libWrapper.register(MODULE_ID, target, fn, type);
    entry.ok = true;
    return true;
  } catch (err) {
    entry.reason = String(err?.message ?? err);
    error("wrap", err, { target });
    return false;
  }
}
