/**
 * Source defeated (Milestone 8, docs/M8-DESIGN.md §3.5, D17; active GM): a creature that becomes defeated ends the
 * native targeted effects it is the source of, and they come back when it is revived (our undo with `reviveOnUndo`,
 * Death Tracker, by hand). Death Tracker cleans only Combat Tools' flagged effects (DT/death-tracker.mjs:244-265);
 * those are never touched here.
 * - Ending: the effect is marked expired (`duration.expired`, as a saved effect) with
 *   `flags.stef-ds-automation.targeted.endedBy = {reason, at, sourceUuid}`; a grab with several sources loses only that
 *   source's change, kept in `targeted.removed` for the revival.
 * - Revival: expired effects whose `endedBy.sourceUuid` is the creature are live again (`endedBy` null), removed
 *   grab changes are added back.
 * - The rows that made them are annotated `endedReason` (fire-and-forget through engine annotateOps, never awaited in a
 *   hook chain), cleared on revival; their undo still deletes the effect (`createdIds`). Hook `dsAuto.targetedEnded`.
 * Defeat is read from the actor's statuses (`CONFIG.specialStatusEffects.DEFEATED`) after the effect or actor write
 * settled, so the check is the same whatever toggled it (a status effect, Death Tracker, a module writing the actor).
 * Zero cost when unused: a module-level index `sourceUuid -> Set<effect key>` of our native effects (filled from the
 * effect hooks, seeded at ready and per viewed scene) is consulted first; no index entry, no work.
 *
 * i18n keys: none of its own (rows use DSAUTO.Reason.sourceDefeated, listed in engine/targeted.mjs).
 */
import { MODULE_ID } from "../constants.mjs";
import { error, log } from "../log.mjs";
import { ENDED, SOURCES, annotateRow, callEnded, candidateActors, changeSources, isNativeTargeted, rowOf } from "../engine/targeted.mjs";

const defeatedId = () => CONFIG.specialStatusEffects?.DEFEATED ?? "dead";

/** sourceUuid -> Set<"actorUuid|effectId">, and the reverse (effect key -> its source uuids). */
const bySource = new Map();
const byEffect = new Map();

const keyOf = effect => (effect?.parent?.uuid && effect.id ? `${effect.parent.uuid}|${effect.id}` : null);

function effectOf(key) {
  const at = key.lastIndexOf("|");
  try {
    return fromUuidSync(key.slice(0, at))?.effects?.get?.(key.slice(at + 1)) ?? null;
  } catch (_err) {
    return null;
  }
}

/** Every source uuid the effect answers to: its live changes, removed grab sources and the source that ended it. */
function sourcesOf(effect) {
  const flag = effect.flags?.[MODULE_ID]?.targeted ?? {};
  const out = new Set(changeSources(effect, flag.statusId));
  for (const r of flag.removed ?? []) if (r?.sourceUuid) out.add(r.sourceUuid);
  if (flag.endedBy?.sourceUuid) out.add(flag.endedBy.sourceUuid);
  return out;
}

function unindex(key) {
  for (const u of byEffect.get(key) ?? []) {
    const set = bySource.get(u);
    set?.delete(key);
    if (set && !set.size) bySource.delete(u);
  }
  byEffect.delete(key);
}

/** (Re)index one effect (ours only). */
export function indexEffect(effect) {
  const key = keyOf(effect);
  if (!key) return;
  unindex(key);
  if (!isNativeTargeted(effect)) return;
  const sources = sourcesOf(effect);
  byEffect.set(key, sources);
  for (const u of sources) {
    if (!bySource.has(u)) bySource.set(u, new Set());
    bySource.get(u).add(key);
  }
}

function seed(actors) {
  for (const actor of actors) for (const e of actor?.effects ?? []) if (isNativeTargeted(e)) indexEffect(e);
}

/** Has any native targeted effect of ours this creature as a source (also ended ones)? */
export const isIndexedSource = uuid => !!uuid && (bySource.get(uuid)?.size ?? 0) > 0;

/** For tests and the cleanup: drop the index and rebuild it from every world and unlinked token actor. */
export function rebuildSourceIndex() {
  bySource.clear();
  byEffect.clear();
  seed(candidateActors());
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

let registered = false;

export function registerSourceDefeat() {
  if (registered) return;
  registered = true;
  Hooks.once("ready", () => guard("seed", () => {
    if (game.user?.isGM) rebuildSourceIndex();
  }));
  // A newly viewed scene's unlinked token actors (effects made earlier this session are indexed by the hooks).
  Hooks.on("canvasReady", canvas => guard("seedScene", () => {
    if (!game.user?.isGM) return;
    seed((canvas?.scene?.tokens ?? []).filter(t => !t.actorLink).map(t => t.actor).filter(Boolean));
  }));
  Hooks.on("createActiveEffect", effect => guard("create", () => onEffect(effect, false)));
  Hooks.on("updateActiveEffect", effect => guard("update", () => onEffect(effect, false)));
  Hooks.on("deleteActiveEffect", effect => guard("delete", () => onEffect(effect, true)));
  Hooks.on("updateActor", actor => guard("actor", () => {
    if (isIndexedSource(actor?.uuid)) queueCheck(actor.uuid);
  }));
}

function guard(where, fn) {
  try {
    fn();
  } catch (err) {
    error(`sourceDefeat.${where}`, err);
  }
}

function onEffect(effect, deleted) {
  if (!game.user?.isGM) return;
  if (isNativeTargeted(effect)) {
    if (deleted) {
      const key = keyOf(effect);
      if (key) unindex(key);
    } else indexEffect(effect);
  }
  // The defeated status came or went (a status effect, Death Tracker's revival deleting it).
  const actor = effect?.parent;
  if (actor?.documentName === "Actor" && effect.statuses?.has?.(defeatedId()) && isIndexedSource(actor.uuid)) queueCheck(actor.uuid);
}

/** One check per creature at a time, after the triggering write settled (statuses re-prepared). */
const chains = new Map();
function queueCheck(uuid) {
  if (!game.users.activeGM?.isSelf) return;
  const prev = chains.get(uuid) ?? Promise.resolve();
  const next = prev.then(() => new Promise(r => setTimeout(r, 0))).then(() => checkSource(uuid)).catch(err => error("sourceDefeat.check", err, { uuid }));
  chains.set(uuid, next);
  next.finally(() => {
    if (chains.get(uuid) === next) chains.delete(uuid);
  });
}

/** Wait until every queued check finished (tests). */
export async function sourceDefeatIdle() {
  while (chains.size) await Promise.all([...chains.values()]);
}

/** End or restore the effects of one source, from its current defeated state. */
export async function checkSource(uuid) {
  if (!game.users.activeGM?.isSelf || !isIndexedSource(uuid)) return;
  let actor = null;
  try {
    actor = fromUuidSync(uuid);
  } catch (_err) {
    actor = null;
  }
  if (!actor) return;
  const defeated = !!actor.statuses?.has?.(defeatedId());
  for (const key of [...(bySource.get(uuid) ?? [])]) {
    const effect = effectOf(key);
    if (!effect) {
      unindex(key);
      continue;
    }
    if (defeated) await endFor(effect, uuid);
    else await restoreFor(effect, uuid);
  }
}

const INTERNAL = () => ({ [MODULE_ID]: { internal: true } });

async function endFor(effect, uuid) {
  const flag = effect.flags?.[MODULE_ID]?.targeted ?? {};
  const statusId = flag.statusId;
  const sources = changeSources(effect, statusId);
  if (!sources.includes(uuid) || effect.duration?.expired) return;
  const row = rowOf(effect, uuid);
  const at = Date.now();
  if (sources.length > 1) {
    // A grab with several grabbers: only this one lets go.
    const key = SOURCES(statusId);
    const changes = effect.system?.changes ?? [];
    const change = changes.find(c => c?.key === key && c.value === uuid);
    await effect.update({
      "system.changes": changes.filter(c => c !== change),
      [`flags.${MODULE_ID}.targeted.removed`]: [...(flag.removed ?? []).filter(r => r?.sourceUuid !== uuid), { sourceUuid: uuid, change, at }],
    }, INTERNAL());
  } else {
    await effect.update({
      "duration.expired": true,
      [`flags.${MODULE_ID}.targeted.endedBy`]: { reason: ENDED.DEFEATED, at, sourceUuid: uuid },
    }, INTERNAL());
  }
  indexEffect(effect);
  if (row) annotateRow(row.messageId, row.opId, { endedReason: ENDED.DEFEATED, endedAt: at });
  callEnded(effect, ENDED.DEFEATED, uuid);
  log("targeted.sourceDefeated", { effect: effect.name, actor: effect.parent?.name, source: uuid, removedOnly: sources.length > 1 });
}

async function restoreFor(effect, uuid) {
  const flag = effect.flags?.[MODULE_ID]?.targeted ?? {};
  const update = {};
  if (flag.endedBy?.sourceUuid === uuid && effect.duration?.expired) {
    update["duration.expired"] = false;
    update[`flags.${MODULE_ID}.targeted.endedBy`] = null;
  }
  const removed = (flag.removed ?? []).find(r => r?.sourceUuid === uuid);
  if (removed) {
    const key = SOURCES(flag.statusId);
    const changes = effect.system?.changes ?? [];
    if (removed.change && !changes.some(c => c?.key === key && c.value === uuid)) update["system.changes"] = [...changes, removed.change];
    update[`flags.${MODULE_ID}.targeted.removed`] = (flag.removed ?? []).filter(r => r !== removed);
  }
  if (!Object.keys(update).length) return;
  await effect.update(update, INTERNAL());
  indexEffect(effect);
  const row = rowOf(effect, uuid);
  if (row) annotateRow(row.messageId, row.opId, { endedReason: null, endedAt: null });
  callEnded(effect, ENDED.REVIVED, uuid);
  log("targeted.sourceRevived", { effect: effect.name, actor: effect.parent?.name, source: uuid });
}
