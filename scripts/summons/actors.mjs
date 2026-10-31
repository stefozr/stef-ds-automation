/**
 * Milestone 6: the world actors summons are made from (docs/M6-DESIGN.md §3.1).
 *
 * One world actor per (stat block, source item): the reuse key is upstream's (R§ fact 35),
 * `_stats.compendiumSource === <compendium uuid>` and `flags.draw-steel.summonSource === <source item uuid>`.
 * A missing one is imported on the active GM with `game.actors.fromCompendium(doc, {keepId: false})` and
 * `Actor.implementation.create(data, {fromCompendium: true})` into the GM-owned folder "Summons (ds-auto)". Never
 * `importFromCompendium`, never `keepId: true` (R§ C1, fact 10). Imports of the same key share one in-flight promise
 * (two rows, two clicks), so no duplicate actor is ever made.
 *
 * The source item of an unlinked NPC summoner is the base actor's item (CH1): every monster token's item has its own
 * synthetic uuid, which would import one actor per token.
 *
 * `grantUserIds` is the CH8 fallback only (the world actor is missing on the owner's client): OWNER on the world actor
 * for the summoner's non-GM owners. Otherwise the world actor stays GM-only and players own each token through its delta.
 *
 * Writes only actors and the folder, never the chat message (one signed record write per resolution, H2/H4).
 */
import { MODULE_ID, OP_STATUS } from "../constants.mjs";
import { debug, error, log } from "../log.mjs";
import { baseActorOf } from "../library/identity.mjs";
import { summonActorUuid } from "../library/schema.mjs";

export const SUMMON_FOLDER_NAME = "Summons (ds-auto)";

const OWNER = 3;
const WORLD_UUID = /^Actor\.([A-Za-z0-9]{16})$/;

const isGM = () => !!game.users?.activeGM?.isSelf;

/** In-flight imports, keyed `<compendium uuid>|<source uuid>`. */
const inflight = new Map();
/** The folder creation in flight (one at a time). */
let folderPromise = null;

/** The source item uuid of the reuse key (CH1): the base actor's item for a token actor, else item.uuid. Pure on documents. */
export function summonSourceUuid(item) {
  try {
    if (item?.actor?.isToken) {
      const base = baseActorOf(item.actor)?.items?.get?.(item.id);
      if (base?.uuid) return base.uuid;
    }
  } catch (_err) { /* fall through to the item's own uuid */ }
  return item?.uuid ?? null;
}

/** World actor already imported for (compendium uuid, source uuid), or null. Any client (reads game.actors). */
export function findWorldActor(compendiumUuid, sourceUuid) {
  if (!compendiumUuid || !game.actors) return null;
  try {
    return game.actors.find(a => (a._stats?.compendiumSource ?? a._source?._stats?.compendiumSource) === compendiumUuid
      && (a.flags?.["draw-steel"]?.summonSource ?? null) === (sourceUuid ?? null)) ?? null;
  } catch (_err) {
    return null;
  }
}

/** The "Summons (ds-auto)" Actor folder (created on first use). Active GM. */
export async function summonFolder() {
  if (!game.folders) return null;
  const found = game.folders.find?.(f => f.type === "Actor" && f.flags?.[MODULE_ID]?.summons) ?? null;
  if (found) return found;
  if (!isGM()) return null;
  const cls = globalThis.Folder?.implementation;
  if (!cls) return null;
  folderPromise ??= cls.create({ name: SUMMON_FOLDER_NAME, type: "Actor", flags: { [MODULE_ID]: { summons: true } } })
    .catch(err => {
      error("summon.folder", err);
      return null;
    })
    .finally(() => { folderPromise = null; });
  return folderPromise;
}

/** CH8 fallback: OWNER on the world actor for users who lack it (active GM only). */
async function grant(actor, userIds) {
  if (!actor || !userIds?.length || !isGM()) return;
  const missing = userIds.filter(id => (actor.ownership?.[id] ?? 0) !== OWNER);
  if (!missing.length) return;
  await actor.update({ ownership: Object.fromEntries(missing.map(id => [id, OWNER])) }, { [MODULE_ID]: { internal: true } });
  log("summon.grant", { actor: actor.name, users: missing });
}

/**
 * The world actor to summon: a world actor uuid as is ("Actor.<id>" present in game.actors, api.summon only), else the
 * reused or newly imported copy of the compendium actor. `grantUserIds`: CH8 fallback, OWNER on the world actor (our
 * imported copy only, never on a world actor named as is).
 * @returns {Promise<{actor: Actor|null, created: boolean, why?: string}>}
 */
export async function ensureWorldActor(uuid, { sourceUuid, grantUserIds = [], allowWorld = false } = {}) {
  try {
    if (!game.actors) return { actor: null, created: false, why: "noActors" };
    const world = typeof uuid === "string" ? WORLD_UUID.exec(uuid) : null;
    if (allowWorld && world) {
      const own = game.actors.get(world[1]);
      // An existing world actor the Director named (api.summon) is not one of our imports: never granted (review fix).
      if (own) return { actor: own, created: false };
    }
    const cuuid = summonActorUuid(uuid);
    if (!cuuid) return { actor: null, created: false, why: "badUuid" };
    const found = findWorldActor(cuuid, sourceUuid);
    if (found) {
      await grant(found, grantUserIds);
      return { actor: found, created: false };
    }
    if (!isGM()) return { actor: null, created: false, why: "notGM" };
    const key = `${cuuid}|${sourceUuid ?? ""}`;
    if (inflight.has(key)) {
      const shared = await inflight.get(key);
      if (shared.actor) await grant(shared.actor, grantUserIds);
      return { ...shared, created: false };
    }
    const promise = importActor(cuuid, sourceUuid).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    const out = await promise;
    if (out.actor) await grant(out.actor, grantUserIds);
    return out;
  } catch (err) {
    error("summon.worldActor", err, { uuid });
    return { actor: null, created: false, why: "error" };
  }
}

async function importActor(cuuid, sourceUuid) {
  try {
    const doc = await fromUuid(cuuid).catch(() => null);
    if (doc?.documentName !== "Actor") return { actor: null, created: false, why: "missing" };
    const cls = globalThis.Actor?.implementation;
    if (!cls || typeof game.actors.fromCompendium !== "function") return { actor: null, created: false, why: "noActorClass" };
    const data = game.actors.fromCompendium(doc, { keepId: false });
    const setProp = foundry.utils.setProperty;
    if (!data._stats?.compendiumSource) setProp(data, "_stats.compendiumSource", cuuid);
    setProp(data, "flags.draw-steel.summonSource", sourceUuid ?? null);
    setProp(data, `flags.${MODULE_ID}.summonActor`, { compendiumUuid: cuuid, sourceUuid: sourceUuid ?? null, at: Date.now() });
    data.folder = (await summonFolder())?.id ?? null;
    const actor = await cls.create(data, { fromCompendium: true, [MODULE_ID]: { internal: true } });
    if (!actor) return { actor: null, created: false, why: "createFailed" };
    log("summon.import", { name: actor.name, source: sourceUuid });
    return { actor, created: true };
  } catch (err) {
    error("summon.import", err, { uuid: cuuid });
    return { actor: null, created: false, why: "error" };
  }
}

/** `{uuid, name, img, width, height, isMinion, worldActorId}` of a choice from its world actor. Pure. */
export function choiceInfo(actor, uuid) {
  const proto = actor?.prototypeToken;
  return {
    uuid,
    name: actor?.name ?? "",
    img: proto?.texture?.src || actor?.img || null,
    width: Math.max(1, Number(proto?.width) || 1),
    height: Math.max(1, Number(proto?.height) || 1),
    isMinion: !!(actor?.system?.isMinion ?? actor?.isMinion),
    worldActorId: actor?.id ?? null,
  };
}

/**
 * Resolve-time preparation (engine resolveMessage, card lock): for every pending summon op of `ops`, ensure each choice's
 * world actor and fill `choices[k]`; a row with no preparable choice becomes failed noWorldActor. Mutates `ops`.
 * @returns {Promise<number>} summon ops seen
 */
export async function prepareSummonOps(ops, { item = null, grantUserIds = [] } = {}) {
  if (!isGM() || !ops) return 0;
  let n = 0;
  for (const op of Object.values(ops)) {
    if (op?.kind !== "summon" || op.status !== OP_STATUS.PENDING) continue;
    n++;
    try {
      const src = op.sourceUuid ?? (item ? summonSourceUuid(item) : null);
      for (const c of op.choices ?? []) {
        if (!c?.uuid) continue;
        const { actor, why } = await ensureWorldActor(c.uuid, { sourceUuid: src, grantUserIds, allowWorld: !!op.synthetic });
        if (actor) Object.assign(c, choiceInfo(actor, c.uuid)); // keeps c.label
        else {
          c.worldActorId = null;
          debug("summon.prepare", { uuid: c.uuid, why });
        }
      }
    } catch (err) {
      error("summon.prepare", err, { opId: op.opId });
    }
    if (!(op.choices ?? []).some(c => c?.worldActorId)) {
      op.status = OP_STATUS.FAILED;
      op.reason = "noWorldActor";
    }
  }
  return n;
}
