/**
 * Keeper of detached entries (Milestone 4). Two bulk rewrites would wipe our `dsAuto.*` entries:
 *   - Combat Tools' enhanced-ability refresh (`applyEnhanced`, also run by `distributeEnhancedAbilities()`)
 *     updates `system` with a ForcedDeletion for every typed entry its pack copy lacks (setup-macros.mjs
 *     `_retypeSafe`);
 *   - the system's "Update from compendium" replaces `system` wholesale (a ForcedReplacement,
 *     draw-steel.mjs `compendiumUpdateData`).
 * `preUpdateItem` runs on the updating client with the mutable changes (operators included), so the
 * entries are put back into that same update: ForcedDeletions of our ids become our data again, and a
 * replaced `system` gets our entries added. A single entry deleted from the item sheet (nothing else
 * changed) is the user's decision and stays deleted. If the changes have an unexpected shape, the
 * active GM restores the entries once the update landed (`updateItem`).
 * Locked items are left alone. Same pattern as ds-local-fixes Fix 3 (teleport-abilities.mjs).
 */
import { MODULE_ID } from "../constants.mjs";
import { debug, log, warn } from "../log.mjs";
import { entrySources, isEntryType } from "./entries.mjs";
import { itemFlags } from "./resolve.mjs";

/** uuid -> entries to restore after an update the pre-hook could not fix. */
const pending = new Map();
const inFlight = new Set();

const Deletion = () => globalThis.foundry?.data?.operators?.ForcedDeletion;
const Replacement = () => globalThis.foundry?.data?.operators?.ForcedReplacement;

function innerValue(op) {
  const R = Replacement();
  if (R && op instanceof R) return typeof R.get === "function" ? R.get(op) : op;
  return op;
}

/** Is this update a bulk rewrite of the item (not a single edit on its sheet)? */
function bulkRewrite(changes, system, deletedIds, ours) {
  if (Replacement() && changes.system instanceof Replacement()) return true;
  // Combat Tools' refresh writes name, img and the whole system object.
  if ("name" in changes || "img" in changes) return true;
  const otherSystemKeys = Object.keys(system ?? {}).filter(k => k !== "effects");
  if (otherSystemKeys.length >= 3) return true;
  // Every one of our entries deleted at once together with other changes.
  return deletedIds.length === ours.length && ours.length > 1 && otherSystemKeys.length > 0;
}

export function onPreUpdateItem(item, changes, _options, userId) {
  try {
    if (userId !== game.user.id || !changes || typeof changes !== "object") return;
    // Each update decides afresh (a memo of an update that never landed must not linger).
    pending.delete(item.uuid);
    const flags = itemFlags(item);
    if (!flags.overlay?.detached || flags.lock) return;
    // Our own writes (detach / reset) go through untouched.
    const ourFlags = changes.flags?.[MODULE_ID];
    if (ourFlags?.overlay !== undefined || (Deletion() && ourFlags instanceof Deletion())) return;
    const ours = entrySources(item);
    const ids = Object.keys(ours);
    if (!ids.length || changes.system === undefined) return;
    const system = innerValue(changes.system);
    if (!system || typeof system !== "object") return;
    const D = Deletion();
    const effects = system.effects;
    const deleted = effects && typeof effects === "object" ? ids.filter(id => D && effects[id] instanceof D) : [];
    const replaced = !!(Replacement() && changes.system instanceof Replacement());
    if (!deleted.length && !replaced) {
      // A whole system object of another shape (operator unwrapped on the way): check after the write.
      if ("power" in system && "_dsid" in system) pending.set(item.uuid, { entries: foundry.utils.deepClone(ours), at: Date.now() });
      return;
    }
    if (!bulkRewrite(changes, system, deleted, ids)) return;
    if (replaced) {
      if (!system.effects || typeof system.effects !== "object") system.effects = {};
      for (const id of ids) if (!(id in system.effects)) system.effects[id] = foundry.utils.deepClone(ours[id]);
    }
    for (const id of deleted) system.effects[id] = foundry.utils.deepClone(ours[id]);
    log("keeper.kept", { item: item.uuid, entries: ids.length, replaced });
    // Converge later in case the write still drops them (changes shape we did not foresee).
    pending.set(item.uuid, { entries: foundry.utils.deepClone(ours), at: Date.now() });
  } catch (err) {
    warn("keeper.preUpdate", { item: item?.uuid, error: String(err?.message ?? err) });
  }
}

export function onUpdateItem(item, _changes, _options, _userId) {
  const memo = pending.get(item.uuid);
  if (!memo) return;
  pending.delete(item.uuid);
  if (Date.now() - memo.at > 10_000) return;
  if (!game.users.activeGM?.isSelf && !item.isOwner) return;
  const present = entrySources(item);
  const missing = Object.keys(memo.entries).filter(id => !present[id]);
  if (!missing.length || inFlight.has(item.uuid)) return;
  const flags = itemFlags(item);
  if (!flags.overlay?.detached || flags.lock) return;
  inFlight.add(item.uuid);
  const update = {};
  for (const id of missing) update[`system.effects.${id}`] = memo.entries[id];
  setTimeout(() => {
    item.update(update, { dsAutoKeeper: true })
      .then(() => log("keeper.restored", { item: item.uuid, entries: missing.length }))
      .catch(err => warn("keeper.restore", { item: item.uuid, error: String(err?.message ?? err) }))
      .finally(() => inFlight.delete(item.uuid));
  }, 250);
}

/** A new copy (drag from a compendium, duplicate) keeps whatever entries it carries: nothing to do. */
export function registerKeeper() {
  Hooks.on("preUpdateItem", onPreUpdateItem);
  Hooks.on("updateItem", onUpdateItem);
  debug("keeper.registered", {});
}

/** For tests and the medkit: is this type ours? */
export { isEntryType };
