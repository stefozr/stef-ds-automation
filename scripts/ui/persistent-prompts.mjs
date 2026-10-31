/**
 * Persistent prompts, owner side (Milestone 9, docs/M9-DESIGN.md §C.4; WP-C). Every client; the active GM opens the
 * same dialog itself for a user nobody online answers for (`triggerFallback` "director", persistent/upkeep.mjs).
 *
 * Prompt router types (GM senders only; the router checks too, S/relay/prompt-router.mjs):
 *   persistentUpkeep        keep a Persistent ability use at its user's turn start: the M6 upkeep dialog
 *                           (`S/ui/summon-upkeep.mjs openUpkeepDialog`) with `kind: "persistent"`, which makes it use
 *                           the DSAUTO.Persistent.Upkeep.{Title, Intro.<keepKey>} texts and show the use's `detail`.
 *                           The use's fields are mapped onto the dialog's summon fields (summonId <- messageId,
 *                           summonName <- abilityName, summonerName <- userName). Answers as M6: {outcome: "keep" |
 *                           "release" | "timedOut" | "closed" | "cancelled"}.
 *   persistentUpkeepCancel  closes that dialog; answers {ok}.
 *
 * i18n keys: DSAUTO.Relay.{Denied, BadRequest} (the dialog's own texts are summon-upkeep.mjs's).
 */
import { closeUpkeepDialog, openUpkeepDialog } from "./summon-upkeep.mjs";

/** Keep variants (persistent/registry.mjs PERSISTENT_KEEP_KEYS; a copy, so this client file needs no GM-side import). */
const KEEP_KEYS = new Set(["reroll", "extend", "both", "manual"]);

const str = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;
const optStr = (v, max) => v == null || (typeof v === "string" && v.length <= max);
const badRequest = () => new Error("DSAUTO.Relay.BadRequest");
const denied = () => new Error("DSAUTO.Relay.Denied");

/** Shape of a persistentUpkeep request (§C.4). */
export function validPersistentUpkeep(p) {
  if (!p || typeof p !== "object" || !str(p.promptId, 40) || !str(p.messageId, 64)) return false;
  if (!Number.isInteger(p.cost) || p.cost < 1 || p.cost > 10) return false;
  if (!(p.current == null || Number.isFinite(p.current))) return false;
  if (!Number.isFinite(p.timeoutMs) || !Number.isFinite(p.deadline)) return false;
  if (!KEEP_KEYS.has(p.keepKey)) return false;
  return optStr(p.abilityName, 300) && optStr(p.userName, 300) && optStr(p.resourceName, 100) && optStr(p.detail, 300);
}

/** The upkeep dialog for a valid request (owner side, or the active GM's own for the fallback). */
export function openPersistentDialog(payload) {
  return openUpkeepDialog({
    promptId: payload.promptId, kind: "persistent", keepKey: payload.keepKey, detail: payload.detail ?? "",
    cost: payload.cost, current: payload.current ?? 0, resourceName: payload.resourceName ?? "",
    deadline: payload.deadline, timeoutMs: payload.timeoutMs,
    summonId: payload.messageId, summonName: payload.abilityName ?? "", summonerName: payload.userName ?? "",
  });
}

/** Prompt type "persistentUpkeep" (registered by main.mjs). GM sender only (the router checks too). */
export async function handlePersistentUpkeep(payload, { user } = {}) {
  if (!user?.isGM) throw denied();
  if (!validPersistentUpkeep(payload)) throw badRequest();
  return openPersistentDialog(payload);
}

/** Prompt type "persistentUpkeepCancel". */
export async function handlePersistentUpkeepCancel(payload, { user } = {}) {
  if (!user?.isGM) throw denied();
  if (!str(payload?.promptId, 40)) throw badRequest();
  return { ok: closeUpkeepDialog(payload.promptId, "cancelled") };
}
