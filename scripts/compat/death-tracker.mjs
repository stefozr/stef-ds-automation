/** Draw Steel: Death Tracker attribution and revival, through the ctlib services it provides. */
import { DT_ID } from "../constants.mjs";
import { debug, warn } from "../log.mjs";
import { ctlibService } from "./ctlib.mjs";

export const dtActive = () => !!game.modules.get(DT_ID)?.active;

let causeNotes = 0;
/** How many causes this client noted (an external hold refreshes its own only while nobody else noted, §6.3). */
export const causeNoteCount = () => causeNotes;

/** Tell Death Tracker who caused the damage that is about to land (once per resolution). */
export function noteDamageCause({ userId, sourceActorUuid, messageId }) {
  causeNotes++;
  try {
    ctlibService("noteDamageCause")?.({ userId, sourceActorUuid, messageId, stated: true });
  } catch (_err) { /* attribution is best effort */ }
}

/** Mark a minion token as hit before the squad pool write so the right minion is defeated. */
export function reportSquadDamage(tokenId) {
  if (!tokenId) return;
  try {
    ctlibService("reportSquadDamage")?.(tokenId);
  } catch (_err) { /* best effort */ }
}

/**
 * Tell every client a token is about to be revived, before our Stamina restore lands, as Death
 * Tracker does for Target Damage's own undo (dstd-death.mjs:158): its panels keep the token's row.
 */
export function announcePendingRevival(tokenUuid) {
  if (!tokenUuid) return;
  try {
    ctlibService("announcePendingRevival")?.(tokenUuid);
  } catch (_err) { /* best effort */ }
}

let dtModule;
/** Token ids being revived now (reviveTokens). */
const reviving = new Set();

/**
 * Death Tracker's own module instance. Package scripts are loaded as ES modules, so importing the same
 * URL returns the instance Death Tracker runs (no second copy, same state).
 */
async function deathTrackerModule() {
  if (dtModule !== undefined) return dtModule;
  try {
    dtModule = await import(foundry.utils.getRoute(`modules/${DT_ID}/src/death-tracker.mjs`));
  } catch (err) {
    warn("revive.import", { error: String(err?.message ?? err) });
    dtModule = null;
  }
  return dtModule;
}

/**
 * Revive tokens that Death Tracker defeated, around our undo's Stamina restore (active GM).
 * Death Tracker's `reviveTokens` (death-tracker.mjs:2517 in 1.2.2) lifts the defeated status, puts the combatant
 * back into its squad and restores the captain; `skipGroupHpRestore` because our undo restores the
 * squad pool itself, right after the revival (engine/undo.mjs: Death Tracker clamps pool writes to the
 * living minions, so the pool is written once they are alive again). Tokens killed in
 * one stroke with ours (Death Tracker's death groups) come back with them. Revival works on placeables,
 * so the Director must be viewing the tokens' scene; tokens elsewhere stay defeated.
 * Fallback without the module import: Death Tracker's socket handler for Target Damage's undo; it
 * revives 500 ms later and adds the minions' Stamina back to the pool itself (capped by its clamp).
 * @param {string[]} tokenUuids
 * @param {object} [options]
 * @param {boolean} [options.expandDeathGroups]   Also revive tokens killed in one stroke with these
 *                                                (squad undo picks its minions itself: false).
 */
export async function reviveTokens(tokenUuids, { expandDeathGroups = true } = {}) {
  if (!dtActive() || !tokenUuids?.length || !game.users.activeGM?.isSelf) return;
  const defeated = CONFIG.specialStatusEffects?.DEFEATED ?? "dead";
  const ids = new Set();
  for (const uuid of tokenUuids) {
    const doc = safeUuid(uuid);
    if (!doc?.id) continue;
    ids.add(doc.id);
    if (!expandDeathGroups) continue;
    for (const id of globalThis.window?._dsctDeathGroups?.get?.(doc.id) ?? []) ids.add(id);
  }
  // 0.17.0: a token another call is reviving right now (undo and revive-on-heal) is revived once.
  const onCanvas = [...ids].filter(id => !reviving.has(id) && globalThis.canvas?.tokens?.get?.(id)?.actor?.statuses?.has?.(defeated));
  if (!onCanvas.length) return;
  const mod = await deathTrackerModule();
  if (typeof mod?.reviveTokens === "function") {
    debug("revive", { tokens: onCanvas.length, via: "reviveTokens" });
    for (const id of onCanvas) reviving.add(id);
    try {
      await mod.reviveTokens(onCanvas, { skipGroupHpRestore: true });
    } finally {
      for (const id of onCanvas) reviving.delete(id);
    }
    return;
  }
  const socket = globalThis.socketlib?.modules?.get?.(DT_ID);
  if (!socket) return;
  debug("revive", { tokens: tokenUuids.length, via: "socket" });
  for (const uuid of tokenUuids) await socket.executeAsGM("dt.dstdUndoDeath", uuid);
}

function safeUuid(uuid) {
  try {
    return fromUuidSync(uuid);
  } catch (_err) {
    return null;
  }
}
