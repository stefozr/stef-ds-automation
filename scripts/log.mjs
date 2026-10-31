import { MODULE_ID } from "./constants.mjs";

const PREFIX = `${MODULE_ID} |`;

function debugOn() {
  try {
    return !!game.settings.get(MODULE_ID, "debug");
  } catch (_err) {
    return false;
  }
}

/** Structured event log: `stef-ds-automation | resolve.finish {...}`. */
export function log(event, data) {
  if (data === undefined) console.log(PREFIX, event);
  else console.log(PREFIX, event, data);
}

/** Verbose log, only with the client "debug" setting on. */
export function debug(event, data) {
  if (!debugOn()) return;
  if (data === undefined) console.debug(PREFIX, event);
  else console.debug(PREFIX, event, data);
}

export function warn(event, data) {
  if (data === undefined) console.warn(PREFIX, event);
  else console.warn(PREFIX, event, data);
}

/** Report an error through Foundry's error pipeline without throwing. */
export function error(where, err, data = {}) {
  try {
    Hooks.onError(`${MODULE_ID}.${where}`, err, { msg: PREFIX, log: "error", notify: null, ...data });
  } catch (_e) {
    console.error(PREFIX, where, err, data);
  }
}
