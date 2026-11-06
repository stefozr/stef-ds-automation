/**
 * Virtual overlay registry (Milestone 4). Content modules register sources on `dsAuto.init`:
 *
 *   Hooks.once("dsAuto.init", api => api.library.registerSource({ id: "stef-ds-automation.library", overlays, priority: 50 }));
 *
 * Nothing is written to items: overlays are looked up by identity when an ability is used, so every
 * copy (actor-embedded, unlinked tokens, compendium documents) is covered at once. Invalid overlays
 * are skipped with a console warning; for one key the highest priority wins, monster-specific overlays
 * before generic ones. Milestone 7: NPCs get generic overlays only when they say `npc: true`.
 */
import { MODULE_ID } from "../constants.mjs";
import { warn } from "../log.mjs";
import { actorClassDsid, itemKey, monsterKeys } from "./identity.mjs";
import { normalizeOverlay, overlayHash, validateOverlay } from "./schema.mjs";

const sources = new Map();
/** key -> overlays (normalized), best first. */
let index = new Map();
const invalid = [];
const listeners = new Set();

function rebuild() {
  index = new Map();
  const ordered = [...sources.values()].sort((a, b) => b.priority - a.priority);
  for (const src of ordered) {
    for (const o of src.overlays) {
      const list = index.get(o.key) ?? [];
      list.push(o);
      index.set(o.key, list);
    }
  }
  // Within one key: priority (stable, from the source order), monster-specific overlays first.
  for (const list of index.values()) list.sort((a, b) => (b.monster ? 1 : 0) - (a.monster ? 1 : 0));
  for (const fn of listeners) {
    try {
      fn();
    } catch (_err) { /* listeners never break registration */ }
  }
}

/**
 * Register (or replace) a source of overlays.
 * @param {object} source
 * @param {string} source.id
 * @param {object[]} source.overlays
 * @param {number} [source.priority]   Higher wins for the same key (world content > shipped library).
 * @returns {{id: string, accepted: number, rejected: number}}
 */
export function registerSource({ id, overlays = [], priority = 0 } = {}) {
  if (!id || typeof id !== "string") throw new Error(`${MODULE_ID} | library.registerSource needs an id`);
  const accepted = [];
  let rejected = 0;
  for (const raw of overlays ?? []) {
    const { ok, errors } = validateOverlay(raw);
    if (!ok) {
      rejected++;
      invalid.push({ source: id, key: raw?.key ?? "(no key)", errors });
      warn("library.invalid", { source: id, key: raw?.key, errors });
      continue;
    }
    const o = normalizeOverlay(raw, id);
    o.hash = overlayHash(raw);
    accepted.push(o);
  }
  sources.set(id, { id, priority: Number(priority) || 0, overlays: accepted });
  rebuild();
  return { id, accepted: accepted.length, rejected };
}

export function unregisterSource(id) {
  const had = sources.delete(id);
  if (had) rebuild();
  return had;
}

/** Called after every (un)registration (medkit refreshes its views). */
export function onRegistryChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** All overlays registered for a key (best first). */
export function overlaysFor(key) {
  return index.get(key) ?? [];
}

/**
 * The overlay for an item: a monster-specific one matching the owning NPC, else a generic one.
 * Milestone 7 NPC guard (docs/M7-DESIGN.md §3.11): an NPC gets a generic overlay only when it opts in with
 * `npc: true` (monster abilities that share a hero ability's key, such as Dame Cornelia's Parry!, never borrow
 * the hero's automation). Heroes, retainers and objects keep the generic fallback.
 * @param {Item} item
 * @param {Actor} [actor]
 */
export function findOverlay(item, actor = item?.actor) {
  const key = itemKey(item);
  if (!key) return null;
  const list = index.get(key);
  if (!list?.length) return null;
  const mkeys = monsterKeys(actor);
  if (mkeys.length) {
    const specific = list.find(o => o.monster?.some(m => mkeys.includes(m)));
    if (specific) return specific;
  }
  // 1.2.0: a class-scoped overlay (essence / ferocity) applies only to heroes of that class; unscoped ones always.
  // An actor whose class is unknown (no class item, partial data) keeps the pre-1.2.0 behavior: the overlay applies.
  const cls = actorClassDsid(actor);
  const classOk = o => !o.class || !cls || o.class === cls;
  if (actor?.type === "npc") return list.find(o => !o.monster && o.npc === true && classOk(o)) ?? null;
  return list.find(o => !o.monster && classOk(o)) ?? null;
}

export function hasOverlay(key) {
  return (index.get(key)?.length ?? 0) > 0;
}

/** Summary for selfCheck and the medkit. */
export function registryInfo() {
  const collisions = [...index.entries()].filter(([, l]) => l.filter(o => !o.monster && !o.class).length > 1).map(([k, l]) => ({ key: k, sources: l.map(o => o.source) }));
  return {
    sources: [...sources.values()].map(s => ({ id: s.id, priority: s.priority, overlays: s.overlays.length })),
    keys: index.size,
    overlays: [...sources.values()].reduce((n, s) => n + s.overlays.length, 0),
    monsterSpecific: [...index.values()].flat().filter(o => o.monster).length,
    // Milestone 7: generic overlays that opt in for NPCs, and the class features with event gains.
    npcGeneric: [...index.values()].flat().filter(o => o.npc === true).length,
    gainFeatures: [...index.entries()].filter(([, l]) => l.some(o => (o.gains ?? []).length > 0)).map(([k]) => k),
    collisions,
    invalid: [...invalid],
  };
}

/** Every registered overlay (best per key first), for listings and coverage reports. */
export function allOverlays() {
  return [...index.values()].flat();
}
