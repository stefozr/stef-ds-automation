/**
 * Item-level library actions (Milestone 4), used by the medkit and the console API:
 *   configure  store config values (flags only)
 *   disable / enable, lock / unlock   flags only
 *   detach     materialize the overlay as `dsAuto.*` entries + stamp `flags.overlay {key, version, hash, detached}`
 *              (the stamp also keeps overlay-level data: choices, config, notes, triggers, trackers)
 *   resync     detach again from the current overlay (outdated items), keeping config and lock
 *   reset      remove our entries and the stamp (back to the registry overlay)
 * Writes only our own flag scope and our own entry ids; never name, img or other system data.
 */
import { MODULE_ID } from "../constants.mjs";
import { log } from "../log.mjs";
import { effectToEntries, entrySources } from "./entries.mjs";
import { findOverlay } from "./registry.mjs";
import { itemFlags } from "./resolve.mjs";

const ForcedDeletion = () => new foundry.data.operators.ForcedDeletion();

/**
 * Update of one key of our flag scope; `undefined` removes the key, and the whole scope goes when
 * nothing else is left in it (no `{lock: false}` or empty objects behind).
 */
function flagChange(item, key, value) {
  const rest = { ...itemFlags(item) };
  if (value === undefined) delete rest[key];
  else rest[key] = value;
  if (!Object.keys(rest).length) return { [`flags.${MODULE_ID}`]: ForcedDeletion() };
  return { [`flags.${MODULE_ID}.${key}`]: value === undefined ? ForcedDeletion() : value };
}

function requireWritable(item) {
  if (!item?.isOwner) throw new Error("DSAUTO.Library.NotOwner");
  if (item.pack) throw new Error("DSAUTO.Library.InCompendium");
}

/** Entries for an overlay (deterministic ids). */
export function overlayEntries(overlay) {
  const out = {};
  let sort = 400_000;
  for (const effect of overlay.effects ?? []) {
    for (const entry of effectToEntries(effect, overlay.key, sort)) out[entry._id] = entry;
    sort += 10;
  }
  return out;
}

export async function configure(item, values = {}) {
  requireWritable(item);
  const overlay = findOverlay(item);
  const allowed = new Map((overlay?.config ?? item?.flags?.[MODULE_ID]?.overlay?.config ?? []).map(c => [c.key, c]));
  const clean = {};
  for (const [k, v] of Object.entries(values)) {
    const c = allowed.get(k);
    if (!c) continue;
    if (c.type === "checkbox") clean[k] = !!v;
    else if (c.type === "number") clean[k] = Number.isFinite(Number(v)) ? Number(v) : c.default;
    else if (c.type === "select") clean[k] = c.options.find(o => String(o.value) === String(v))?.value ?? c.default;
  }
  await item.update({ [`flags.${MODULE_ID}.config`]: clean });
  log("library.configure", { item: item.uuid, config: clean });
  return clean;
}

export async function setDisabled(item, disabled) {
  requireWritable(item);
  await item.update(flagChange(item, "disabled", disabled ? true : undefined));
  log("library.disable", { item: item.uuid, disabled: !!disabled });
}

export async function setLocked(item, locked) {
  requireWritable(item);
  await item.update(flagChange(item, "lock", locked ? true : undefined));
  log("library.lock", { item: item.uuid, locked: !!locked });
}

/**
 * Materialize the overlay on the item. Existing entries of ours are replaced (resync).
 * @returns {Promise<number>} Number of entries written.
 */
export async function detach(item) {
  requireWritable(item);
  if (itemFlags(item).lock) throw new Error("DSAUTO.Library.Locked");
  const overlay = findOverlay(item);
  if (!overlay) throw new Error("DSAUTO.Library.NoOverlay");
  const wanted = overlayEntries(overlay);
  const update = {};
  for (const id of Object.keys(entrySources(item))) if (!wanted[id]) update[`system.effects.${id}`] = ForcedDeletion();
  for (const [id, data] of Object.entries(wanted)) update[`system.effects.${id}`] = data;
  update[`flags.${MODULE_ID}.overlay`] = {
    key: overlay.key, version: overlay.version, hash: overlay.hash ?? null, detached: true,
    suppress: [...(overlay.native?.suppress ?? [])], nativeFilter: overlay.native?.filter ?? null, at: Date.now(),
    // Overlay-level data the entries need without the library (module off, other monster key).
    choices: foundry.utils.deepClone(overlay.choices ?? []), config: foundry.utils.deepClone(overlay.config ?? []), notes: overlay.notes ?? null,
    // Milestone 5: triggers and trackers are overlay-level, so a trigger-only overlay detaches with zero
    // entries and only this stamp (resolve treats `overlay.detached` as detached).
    triggers: foundry.utils.deepClone(overlay.triggers ?? []), trackers: foundry.utils.deepClone(overlay.trackers ?? []),
    // Milestone 9: Persistent upkeep is overlay-level too.
    persistent: foundry.utils.deepClone(overlay.persistent ?? null),
    // Which overlay of that key (a monster's own or the generic one, e.g. ability:parry): resolve follows the
    // live overlay only when it is the same one (third review).
    monster: foundry.utils.deepClone(overlay.monster ?? null),
  };
  await item.update(update);
  log("library.detach", { item: item.uuid, key: overlay.key, version: overlay.version, entries: Object.keys(wanted).length });
  return Object.keys(wanted).length;
}

export const resync = detach;

/** Remove our entries and the stamp: the item follows the registry again. */
export async function reset(item) {
  requireWritable(item);
  if (itemFlags(item).lock) throw new Error("DSAUTO.Library.Locked");
  const update = {};
  for (const id of Object.keys(entrySources(item))) update[`system.effects.${id}`] = ForcedDeletion();
  Object.assign(update, flagChange(item, "overlay", undefined));
  await item.update(update);
  log("library.reset", { item: item.uuid });
}
