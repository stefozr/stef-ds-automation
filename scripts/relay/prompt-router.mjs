/**
 * Owner-side prompts (Milestone 5): `CONFIG.queries["stef-ds-automation.prompt"]` becomes a router by
 * `payload.type`. Milestone 2's saving throws register as `save` (turn/saves.mjs); the trigger engine
 * adds `trigger`, `triggerCancel` and `triggerRun` (ui/trigger-dialog.mjs); Milestone 6 adds `summonUpkeep` and
 * `summonUpkeepCancel` (Persistent upkeep, ui/summon-upkeep.mjs); Milestone 7 adds `heroTokenRegain` and
 * `heroTokenRegainCancel` (ui/hero-token-dialog.mjs; for a hero without a player owner the active GM routes the ask to
 * itself through `routePrompt`) and `zoneUpkeep` / `zoneUpkeepCancel` (ui/zone-prompts.mjs). main.mjs calls
 * `registerPromptRouter()` before any `registerPromptType`.
 *
 * Every type is sent by the active GM only: the router refuses other senders before a handler runs
 * (each handler checks again), and an unknown type is a malformed request. Errors cross the socket as
 * their message only, so refusals throw an i18n key (`DSAUTO.Relay.*`), as relay/queries.mjs does.
 */
import { QUERY_PROMPT } from "../constants.mjs";

const handlers = new Map(); // type -> async (payload, {user}) => answer

/** Add (or replace) the handler of one prompt type. */
export function registerPromptType(type, fn) {
  if (typeof type !== "string" || !type || typeof fn !== "function") return;
  handlers.set(type, fn);
}

/** Registered prompt types (selfCheck). */
export const promptTypes = () => [...handlers.keys()];

/** The query handler (exported for tests). */
export async function routePrompt(payload, ctx = {}) {
  if (!ctx?.user?.isGM) throw new Error("DSAUTO.Relay.Denied");
  const fn = handlers.get(payload?.type);
  if (!fn) throw new Error("DSAUTO.Relay.BadRequest");
  return fn(payload, ctx);
}

export function registerPromptRouter() {
  if (!globalThis.CONFIG?.queries) return;
  CONFIG.queries[QUERY_PROMPT] = routePrompt;
}
