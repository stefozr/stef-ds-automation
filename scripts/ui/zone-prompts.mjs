/**
 * Zone prompts, owner side (Milestone 7, docs/M7-DESIGN.md §1.8, §3.10.10; WP-C). Every client.
 *
 * Prompt router types (GM senders only; the router checks too, S/relay/prompt-router.mjs):
 *   zoneUpkeep        Persistent upkeep of a lasting area (Wall of Fire): the M6 upkeep dialog
 *                     (`S/ui/summon-upkeep.mjs openUpkeepDialog`) with `kind: "zone"`, which makes it use the
 *                     DSAUTO.Zone.Upkeep.{Title, Intro} texts (WP-E). The zone fields are mapped onto the dialog's
 *                     summon fields (summonId <- zoneId, summonName <- zoneName, summonerName <- creatorName).
 *                     Answers as M6: {outcome: "keep" | "release" | "timedOut" | "closed" | "cancelled"}.
 *   zoneUpkeepCancel  closes that dialog; answers {ok}.
 *
 * i18n keys: DSAUTO.Relay.{Denied, BadRequest} (the dialog's own texts are WP-E's, §2.2 summon-upkeep).
 */
import { closeUpkeepDialog, openUpkeepDialog } from "./summon-upkeep.mjs";

const str = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;
const optStr = (v, max) => v == null || (typeof v === "string" && v.length <= max);
const badRequest = () => new Error("DSAUTO.Relay.BadRequest");
const denied = () => new Error("DSAUTO.Relay.Denied");

/** Shape of a zoneUpkeep request (§1.8). */
export function validZoneUpkeep(p) {
  if (!p || typeof p !== "object" || !str(p.promptId, 40) || !str(p.zoneId, 40)) return false;
  if (!Number.isInteger(p.cost) || p.cost < 1 || p.cost > 10) return false;
  if (!(p.current == null || Number.isFinite(p.current))) return false;
  if (!Number.isFinite(p.timeoutMs) || !Number.isFinite(p.deadline)) return false;
  return optStr(p.zoneName, 300) && optStr(p.creatorName, 300) && optStr(p.resourceName, 100);
}

/** Prompt type "zoneUpkeep" (registered by main.mjs). GM sender only (the router checks too). */
export async function handleZoneUpkeep(payload, { user } = {}) {
  if (!user?.isGM) throw denied();
  if (!validZoneUpkeep(payload)) throw badRequest();
  return openUpkeepDialog({
    promptId: payload.promptId, kind: "zone", cost: payload.cost, current: payload.current ?? 0,
    resourceName: payload.resourceName ?? "", deadline: payload.deadline, timeoutMs: payload.timeoutMs,
    summonId: payload.zoneId, summonName: payload.zoneName ?? "", summonerName: payload.creatorName ?? "",
    zoneId: payload.zoneId, zoneName: payload.zoneName ?? "", creatorName: payload.creatorName ?? "",
  });
}

/** Prompt type "zoneUpkeepCancel". */
export async function handleZoneUpkeepCancel(payload, { user } = {}) {
  if (!user?.isGM) throw denied();
  if (!str(payload?.promptId, 40)) throw badRequest();
  return { ok: closeUpkeepDialog(payload.promptId, "cancelled") };
}
