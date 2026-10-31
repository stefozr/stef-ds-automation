/**
 * The active GM's Stamina watch (Milestone 7, docs/M7-DESIGN.md §2.1 WP-A, §3.4 (a), CH5, D14, §6.6).
 *
 * The GM never takes a client's numbers for a fact: an external hit counts only when this client SAW a Stamina (or
 * squad pool) change land. The watch keeps, per actor uuid and per squad CombatantGroup uuid, the last known
 * `{value, temporary}` and the changes of the last 5 s: `{id, actorUuid, groupUuid, tokenUuid, before, after, userId, at,
 * internal, consumed}`.
 *
 * - Seeded for every combatant (and squad pool) when a combat starts or changes round, a combatant is created, and at
 *   ready; refreshed by `updateActor` (an unlinked token's delta also fires `updateActor` with the synthetic actor,
 *   `CL/documents/actor-delta.mjs:219-225`), `updateToken` (a `delta.system.stamina` change, deduped through the cache:
 *   whichever hook comes second sees no change) and `updateCombatantGroup` (`system.staminaValue`).
 * - A change is recorded only while some hero of the started combat on that scene has a `damage` or `winded` rule
 *   (`gainsWant`); the cache follows every change of an actor it knows.
 * - `internal` marks our own engine's writes (the option flag, or a write of this client while an engine apply list holds
 *   the actor, `applyingMessageFor`): those are counted by §3.1 and never become external facts.
 * - A change nobody claims within 5 s (a sheet edit, a module writing Stamina without takeDamage) expires: no fact.
 * i18n keys: none.
 */
import { MODULE_ID } from "../constants.mjs";
import { applyingMessageFor } from "../engine/engine.mjs";
import { debug, error } from "../log.mjs";
import { gainsWant } from "./rules.mjs";

const KEEP_MS = 5_000;
const cache = new Map();   // actor uuid | group uuid -> {value, temporary}
let changes = [];          // recent changes, oldest first

const isActiveGM = () => !!game.users?.activeGM?.isSelf;
const randomID = () => globalThis.foundry?.utils?.randomID?.(16) ?? Math.random().toString(36).slice(2, 18);
const total = s => (Number(s?.value) || 0) + (Number(s?.temporary) || 0);

/** Array view of a Foundry collection, a Map or an array (harness mocks). */
function list(c) {
  if (!c) return [];
  if (Array.isArray(c)) return c;
  if (Array.isArray(c.contents)) return c.contents;
  if (typeof c.values === "function") return [...c.values()];
  return [];
}

function snapActor(actor) {
  const s = actor?.system?.stamina;
  if (!s || s.value == null) return null;
  return { value: Number(s.value) || 0, temporary: Number(s.temporary) || 0 };
}

function snapGroup(group) {
  const v = group?.system?.staminaValue;
  if (v == null) return null;
  return { value: Number(v) || 0, temporary: 0 };
}

function prune() {
  const now = Date.now();
  if (changes.length && now - changes[0].at > KEEP_MS) changes = changes.filter(c => now - c.at <= KEEP_MS);
}

/** Should a change on this scene be recorded? */
function watching(sceneId) {
  return gainsWant("damage", sceneId ?? null) || gainsWant("winded", sceneId ?? null);
}

/** Record a new snapshot of a watched document; a change when the cache knew another value. */
function observe({ uuid, actorUuid = null, groupUuid = null, tokenUuid = null, sceneId = null, now, userId, options }) {
  if (!uuid || !now) return null;
  const prev = cache.get(uuid);
  cache.set(uuid, now);
  if (!prev || (prev.value === now.value && prev.temporary === now.temporary)) return null;
  if (!watching(sceneId)) return null;
  prune();
  const internal = !!options?.[MODULE_ID]?.internal || (userId === game.userId && !!applyingMessageFor(actorUuid ?? ""));
  const change = {
    id: randomID(), actorUuid, groupUuid, tokenUuid, before: prev, after: now, userId: userId ?? null, at: Date.now(),
    internal, consumed: false,
  };
  changes.push(change);
  debug("gains.watch", { actorUuid, groupUuid, before: total(prev), after: total(now), userId, internal });
  return change;
}

function observeActor(actor, userId, options) {
  if (!actor?.uuid) return;
  const now = snapActor(actor);
  if (!now) return;
  if (!cache.has(actor.uuid)) {
    // Only actors we seeded (combatants) are watched; others just enter the cache.
    cache.set(actor.uuid, now);
    return;
  }
  observe({
    uuid: actor.uuid, actorUuid: actor.uuid, tokenUuid: actor.token?.uuid ?? null, sceneId: actor.token?.parent?.id ?? null,
    now, userId, options,
  });
}

function observeGroup(group, userId, options) {
  if (!group?.uuid) return;
  const now = snapGroup(group);
  if (!now) return;
  const combat = group.parent ?? null;
  observe({ uuid: group.uuid, groupUuid: group.uuid, sceneId: combat?.scene?.id ?? combat?._source?.scene ?? null, now, userId, options });
}

/** Seed the cache with a combat's combatants and squad pools. */
function seedCombat(combat) {
  if (!combat) return;
  for (const c of list(combat.combatants)) {
    const actor = c?.actor;
    const snap = snapActor(actor);
    if (actor?.uuid && snap && !cache.has(actor.uuid)) cache.set(actor.uuid, snap);
  }
  for (const g of list(combat.groups)) {
    const snap = snapGroup(g);
    if (g?.uuid && snap && !cache.has(g.uuid)) cache.set(g.uuid, snap);
  }
}

function seedAll() {
  for (const combat of list(game.combats)) if (combat?.started) seedCombat(combat);
}

/**
 * The newest unconsumed, non-internal change of that actor (or pool) with that `after` total (null = any), written by
 * `userId` or by a GM (the system's Apply runs on the clicking client, Target Damage on the GM), within 5 s.
 */
export function findChange({ actorUuid = null, groupUuid = null, after = null, userId = null } = {}) {
  prune();
  const byGM = id => !!game.users?.get?.(id)?.isGM;
  for (let i = changes.length - 1; i >= 0; i--) {
    const c = changes[i];
    if (c.consumed || c.internal) continue;
    if (groupUuid ? c.groupUuid !== groupUuid : (c.groupUuid || c.actorUuid !== actorUuid)) continue;
    if (after != null && total(c.after) !== Number(after)) continue;
    if (userId && c.userId !== userId && !byGM(c.userId)) continue;
    return c;
  }
  return null;
}

/** Mark a change used (one fact per change); false when it was already. Synchronous. */
export function consumeChange(change) {
  if (!change || change.consumed) return false;
  change.consumed = true;
  return true;
}

/** selfCheck / harness: watched documents and recent changes. */
export function staminaWatchInfo() {
  prune();
  return { watched: cache.size, recent: changes.length };
}

/** Forget everything (harness; a new active GM re-seeds at its next combat event). */
export function resetStaminaWatch() {
  cache.clear();
  changes = [];
}

/** init: hooks of the watch (active GM work only; every handler catches its own errors). */
export function registerStaminaWatch() {
  Hooks.on("ready", () => {
    try {
      if (isActiveGM()) seedAll();
    } catch (err) {
      error("gains.watchSeed", err);
    }
  });
  Hooks.on("updateCombat", (combat, changed) => {
    try {
      if (!isActiveGM() || !combat?.started || !changed) return;
      if ("round" in changed || "active" in changed || "started" in changed) seedCombat(combat);
    } catch (err) {
      error("gains.watchSeed", err);
    }
  });
  Hooks.on("createCombatant", combatant => {
    try {
      if (!isActiveGM()) return;
      const actor = combatant?.actor;
      const snap = snapActor(actor);
      if (actor?.uuid && snap && !cache.has(actor.uuid)) cache.set(actor.uuid, snap);
      const group = combatant?.group ?? null;
      const gs = snapGroup(group);
      if (group?.uuid && gs && !cache.has(group.uuid)) cache.set(group.uuid, gs);
    } catch (err) {
      error("gains.watchSeed", err);
    }
  });
  Hooks.on("createCombatantGroup", group => {
    try {
      if (!isActiveGM()) return;
      const gs = snapGroup(group);
      if (group?.uuid && gs && !cache.has(group.uuid)) cache.set(group.uuid, gs);
    } catch (err) {
      error("gains.watchSeed", err);
    }
  });
  Hooks.on("updateActor", (actor, changed, options, userId) => {
    try {
      if (!isActiveGM() || !changed?.system?.stamina) return;
      observeActor(actor, userId, options);
    } catch (err) {
      error("gains.watch", err);
    }
  });
  Hooks.on("updateToken", (tokenDoc, changed, options, userId) => {
    try {
      if (!isActiveGM() || !changed?.delta?.system?.stamina || tokenDoc?.actorLink) return;
      observeActor(tokenDoc.actor, userId, options);
    } catch (err) {
      error("gains.watch", err);
    }
  });
  Hooks.on("updateCombatantGroup", (group, changed, options, userId) => {
    try {
      if (!isActiveGM() || changed?.system?.staminaValue === undefined) return;
      if (!cache.has(group?.uuid)) {
        const gs = snapGroup(group);
        if (group?.uuid && gs) cache.set(group.uuid, gs);
        return;
      }
      observeGroup(group, userId, options);
    } catch (err) {
      error("gains.watch", err);
    }
  });
  Hooks.on("deleteCombat", combat => {
    try {
      // Pools go with their combat; actors stay cached (they may be in another combat).
      for (const g of list(combat?.groups)) if (g?.uuid) cache.delete(g.uuid);
    } catch (err) {
      error("gains.watch", err);
    }
  });
}
