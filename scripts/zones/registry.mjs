/**
 * Milestone 7 (docs/M7-DESIGN.md §1.6, §2.1 WP-B, §3.10.10-§3.10.11): zone registry and lifetime.
 *
 * The region flag `flags["stef-ds-automation"].zone` is the zone's truth (written once at creation, `upkeptRound`
 * patched). A region is **ours** only when that flag's `zoneId` equals its `stef-ds-automation.zone` behavior's
 * `system.zoneId` **and** the card row `res.ops[opId]` records `regionUuid === region.uuid` with that zoneId (on the
 * GM the card must also be trusted by the ledger): a copied region or a hand-added behavior is logged once and
 * ignored (`zoneOf`).
 *
 * - One promise chain (`withZoneChain`) serializes `zoneHits` writes (zones/ledger.mjs), region deletions and the
 *   `upkeptRound` patches. Allowed waits (§6.1): card lock -> chain; lifecycle -> chain; chain -> a NEW card's lock
 *   (the upkeep card). Never chain or lifecycle -> an existing card's lock: the row annotation of an ended zone is
 *   fire-and-forget (`annotateOps`).
 * - Lifetime (active GM): the creator's turn start (`summonerTurnStart`, Persistent upkeep through zones/upkeep.mjs),
 *   the creator's turn end (`summonerTurnEnd`, an unanswered upkeep prompt), both turn-end cases **deferred 1.5 s**
 *   and dropped when that combatant's initiative rises again in the window (DSLF "Undo Last Activation" sets the
 *   turn back, which fires turnEnd, then restores the initiative; C12, §6.7); the end of the encounter
 *   (`deleteCombat` of a started combat: every non-manual zone of it, or of its scenes without a combat); the creator
 *   dying (`summonerDying`) or at 0 Stamina (`zeroStamina`); a region deleted by hand (`deleteRegion`, ended
 *   "deleted"); Dismiss (relay `zoneDismiss`, WP-E) and Undo (`undoZoneOp`).
 * - Arms (`armStart` / `armEnd`) are the M6 ones (activation-aware, round fallback after a GM reload); `counts` is a
 *   copy of summons/registry.mjs `counts`.
 * - Region index cache (`regionUuid -> zoneId`) on every client, kept by create / delete hooks and rebuilt on ready;
 *   every reader re-resolves the uuid.
 *
 * i18n keys used here: DSAUTO.Zone.Ended, DSAUTO.Zone.EncounterEnd, DSAUTO.Zone.End.{expired, encounterEnd, dismiss,
 * undo, creatorDown, deleted} (dynamic, values of ZONE_END).
 */
import * as constants from "../constants.mjs";
import { annotateOps } from "../engine/engine.mjs";
import { trusted } from "../engine/ledger.mjs";
import { getResolution } from "../engine/record.mjs";
import * as schema from "../library/schema.mjs";
import { debug, error, log } from "../log.mjs";
import { whisperGMs } from "../summons/registry.mjs";
import { clock } from "../triggers/prompt.mjs";
import * as lifecycle from "../turn/lifecycle.mjs";
import { dropTallies } from "./engine.mjs";
import { dropZoneClaims } from "./ledger.mjs";
import { cancelZoneUpkeep, offerZoneUpkeep } from "./upkeep.mjs";

const { MODULE_ID, loc } = constants;

export const ZONE_END = Object.freeze({ EXPIRED: "expired", ENCOUNTER_END: "encounterEnd", DISMISS: "dismiss", UNDO: "undo",
  CREATOR_DOWN: "creatorDown", DELETED: "deleted" });

/** The RegionBehavior type (schema.ZONE_TYPE once WP-D lands). */
export const zoneType = () => schema.ZONE_TYPE ?? "stef-ds-automation.zone";

const UNDO_GRACE_MS = 1_500;
const INTERNAL = () => ({ [MODULE_ID]: { internal: true } });
const HOOK_END = () => constants.HOOKS?.zoneEnd ?? "dsAuto.zoneEnd";

const cache = new Map();          // regionUuid -> zoneId (every client)
let cacheBuilt = false;
const ending = new Set();         // zoneIds whose endZone is running (deleteRegion skips them)
const warned = new Set();         // regionUuids logged once as "not ours"
const pendingEnds = new Map();    // `${combatId}:${combatantId}` -> {timer, zoneIds: [{zoneId, upkeepOnly}], initiative, groupId}
let chain = Promise.resolve();
let registered = false;

const isActiveGM = () => !!game.users?.activeGM?.isSelf;
const finite = v => typeof v === "number" && Number.isFinite(v);

/** Array view of a Foundry collection, a Map or an array (harness mocks). */
export function list(c) {
  if (!c) return [];
  if (Array.isArray(c)) return c;
  if (Array.isArray(c.contents)) return c.contents;
  if (typeof c.values === "function") return [...c.values()];
  return [];
}

function lookup(uuid) {
  if (!uuid) return null;
  try {
    return fromUuidSync(uuid) ?? null;
  } catch (_err) {
    return null;
  }
}

/* -------------------------------------------- */
/*  Chain                                       */
/* -------------------------------------------- */

/** Serialize zone work on one promise chain. Resolves with fn's value; a failing fn does not break the chain. */
export function withZoneChain(fn) {
  const run = chain.catch(() => {}).then(() => fn());
  chain = run.catch(() => {});
  return run;
}

/* -------------------------------------------- */
/*  Readers (any client)                        */
/* -------------------------------------------- */

/** flags["stef-ds-automation"].zone of a region, or null. */
export function zoneFlag(region) {
  const f = region?.flags?.[MODULE_ID]?.zone;
  return f && typeof f === "object" && typeof f.zoneId === "string" ? f : null;
}

/** Our behavior document of a region (type stef-ds-automation.zone), or null. */
export function zoneBehavior(region) {
  const type = zoneType();
  return list(region?.behaviors).find(b => b?.type === type) ?? null;
}

function warnOnce(region, why) {
  const key = region?.uuid ?? String(region?.id);
  if (warned.has(key)) return;
  warned.add(key);
  log("zones.notOurs", { region: region?.name, uuid: region?.uuid, why });
}

/**
 * The zone flag of a region only when the region is genuinely ours (§1.6): the flag, the behavior's zoneId and the
 * card row's regionUuid agree (on a GM client the card must be trusted too). A copied region or a hand-added
 * behavior is logged once and ignored.
 * @param {RegionDocument} region
 * @param {object|null} [behaviorSystem]   the behavior's system (the event handler has it)
 * @returns {object|null}
 */
export function zoneOf(region, behaviorSystem = null) {
  try {
    const flag = zoneFlag(region);
    const system = behaviorSystem ?? zoneBehavior(region)?.system ?? null;
    if (!flag) {
      if (system?.zoneId) warnOnce(region, "noFlag");
      return null;
    }
    if (!system || system.zoneId !== flag.zoneId) {
      warnOnce(region, "behaviorMismatch");
      return null;
    }
    const message = flag.messageId ? game.messages?.get?.(flag.messageId) : null;
    const op = getResolution(message)?.ops?.[flag.opId];
    if (!op || op.regionUuid !== region.uuid || op.zoneId !== flag.zoneId) {
      warnOnce(region, message ? "cardMismatch" : "noCard");
      return null;
    }
    if (game.user?.isGM) {
      let ok = false;
      try {
        ok = trusted(message);
      } catch (_err) {
        ok = false;
      }
      if (!ok) {
        warnOnce(region, "cardUntrusted");
        return null;
      }
    }
    return flag;
  } catch (err) {
    error("zones.zoneOf", err);
    return null;
  }
}

function cacheAdd(region) {
  const f = zoneFlag(region);
  if (f && region?.uuid) cache.set(region.uuid, f.zoneId);
}

function cacheRebuild() {
  cache.clear();
  if (!game.scenes) return;
  for (const scene of list(game.scenes)) for (const r of list(scene?.regions)) cacheAdd(r);
  cacheBuilt = true;
  debug("zones.cache", { regions: cache.size });
}

function ensureCache() {
  if (!cacheBuilt) cacheRebuild();
}

/** ZoneInfo (§1.10) of a region of ours. */
export function infoOf(region, flag = zoneFlag(region)) {
  const sys = zoneBehavior(region)?.system ?? {};
  return {
    zoneId: flag?.zoneId ?? null, regionUuid: region?.uuid ?? null, sceneId: region?.parent?.id ?? flag?.sceneId ?? null,
    label: flag?.label ?? sys.label ?? region?.name ?? "", creatorActorUuid: flag?.creatorActorUuid ?? null,
    creatorTokenUuid: flag?.creatorTokenUuid ?? null, itemUuid: flag?.itemUuid ?? null, messageId: flag?.messageId ?? null,
    opId: flag?.opId ?? null, lasts: [...(flag?.lasts ?? [])], upkeep: flag?.upkeep ?? null, combatId: flag?.combatId ?? null,
    createdRound: flag?.createdRound ?? null, triggers: [...(sys.triggers ?? [])], once: sys.once ?? null,
    perSquare: !!sys.perSquare, amount: Number(sys.amount) || 0, damageType: sys.damageType ?? "", affects: sys.affects ?? null,
    terrain: sys.terrain || null,   // Milestone 9
  };
}

/** Live regions of ours (zoneOf ok), every scene. */
function liveRegions() {
  ensureCache();
  const out = [];
  for (const [uuid, zoneId] of [...cache]) {
    const region = lookup(uuid);
    if (!region || zoneFlag(region)?.zoneId !== zoneId) {
      cache.delete(uuid);
      continue;
    }
    const flag = zoneOf(region);
    if (flag) out.push({ region, flag });
  }
  return out;
}

/** Live zones from region flags. filter {sceneId?, creatorActorUuid?, combatId?}. Any client. */
export function listZones(filter = {}) {
  try {
    if (!game.scenes) return [];
    const f = filter ?? {};
    const out = [];
    for (const { region, flag } of liveRegions()) {
      const info = infoOf(region, flag);
      if (f.sceneId && info.sceneId !== f.sceneId) continue;
      if (f.creatorActorUuid && info.creatorActorUuid !== f.creatorActorUuid) continue;
      if (f.combatId !== undefined && f.combatId !== null && info.combatId !== f.combatId) continue;
      info.createdAt = flag.createdAt ?? 0;
      out.push(info);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt).map(({ createdAt: _c, ...info }) => info);
  } catch (err) {
    error("zones.list", err);
    return [];
  }
}

/** The region of a zone: the one the card's row names (`regionUuid`), never a copy. Without the card, the earliest
 *  region carrying that zoneId with our behavior. */
export function regionOfZone(zoneId) {
  try {
    if (!zoneId || !game.scenes) return null;
    ensureCache();
    const candidates = [];
    for (const [uuid, id] of [...cache]) {
      if (id !== zoneId) continue;
      const r = lookup(uuid);
      if (r && zoneFlag(r)?.zoneId === zoneId) candidates.push(r);
      else cache.delete(uuid);
    }
    if (!candidates.length) {
      // The cache may be stale (a region created on another client before our hook ran): one rebuild.
      cacheRebuild();
      for (const [uuid, id] of cache) if (id === zoneId) candidates.push(lookup(uuid));
    }
    const live = candidates.filter(Boolean);
    if (!live.length) return null;
    const flag = zoneFlag(live[0]);
    const message = flag?.messageId ? game.messages?.get?.(flag.messageId) : null;
    const op = getResolution(message)?.ops?.[flag?.opId];
    // The row names this zone's region (an older apply's row names another zoneId: not this one).
    if (op?.regionUuid && op.zoneId === zoneId) return live.find(r => r.uuid === op.regionUuid) ?? null;
    const created = r => Number(r?._stats?.createdTime) || 0;
    return live.filter(r => zoneBehavior(r)?.system?.zoneId === zoneId).sort((a, b) => created(a) - created(b))[0] ?? null;
  } catch (err) {
    error("zones.regionOf", err, { zoneId });
    return null;
  }
}

export function zoneInfo(zoneId) {
  const region = regionOfZone(zoneId);
  const flag = region ? zoneOf(region) : null;
  return flag ? infoOf(region, flag) : null;
}

/** A GM, or an owner of the creator. */
export function mayDismissZone(user, info) {
  if (!user || !info) return false;
  if (user.isGM) return true;
  const actor = lookup(info.creatorActorUuid);
  try {
    return !!actor?.testUserPermission?.(user, "OWNER");
  } catch (_err) {
    return false;
  }
}

/* -------------------------------------------- */
/*  End (active GM)                             */
/* -------------------------------------------- */

/** Row annotation `{ended}` (fire-and-forget; decided inside the card lock: only while the row has that zoneId). */
function annotateEnded(info, reason, userId) {
  try {
    const message = info?.messageId ? game.messages?.get?.(info.messageId) : null;
    if (!message || !info.opId) return;
    annotateOps(message, res => {
      const op = res?.ops?.[info.opId];
      return op?.status === "applied" && op.zoneId === info.zoneId
        ? { [info.opId]: { ended: { reason, at: Date.now(), by: userId ?? null } } } : {};
    }).catch(err => error("zones.annotate", err));
  } catch (err) {
    error("zones.annotate", err);
  }
}

async function deleteRegion(region) {
  const scene = region?.parent;
  if (!scene) return false;
  if (game.scenes?.has && !game.scenes.has(scene.id)) return false;
  if (!list(scene.regions).some(r => r?.id === region.id) && !scene.regions?.has?.(region.id)) return false;
  try {
    if (typeof scene.deleteEmbeddedDocuments === "function") await scene.deleteEmbeddedDocuments("Region", [region.id], INTERNAL());
    else await region.delete?.(INTERNAL());
    return true;
  } catch (err) {
    // Another region or its parent scene deletion may have won the race.
    if (game.scenes?.has && !game.scenes.has(scene.id)) return false;
    if (scene.regions?.has?.(region.id)) throw err;
    return false;
  }
}

/**
 * End a zone (active GM): its open upkeep prompt is cancelled, its open tallies dropped (their claims released), its
 * region deleted (internal), its row annotated (fire-and-forget, unless `annotate` false), `dsAuto.zoneEnd` called,
 * the GMs whispered unless `quiet` (never for undo). Never throws.
 * @param {string} zoneId
 * @param {string} reason          a value of ZONE_END
 * @returns {Promise<{ended: boolean, gone: boolean, info?: object, error?: string}>}
 */
export async function endZone(zoneId, reason, { annotate = true, userId = null, quiet = false } = {}) {
  if (!isActiveGM() || !zoneId) return { ended: false, gone: true };
  try {
    cancelZoneUpkeep(zoneId, "dismissed");
  } catch (err) {
    error("zones.endCancel", err);
  }
  let result;
  try {
    result = await withZoneChain(async () => {
      const region = regionOfZone(zoneId);
      dropTallies(zoneId);
      dropZoneClaims(null, zoneId);
      if (!region) return { ended: false, gone: true, info: null };
      const info = infoOf(region, zoneFlag(region));
      ending.add(zoneId);
      try {
        const deleted = await deleteRegion(region);
        cache.delete(region.uuid);
        return { ended: deleted, gone: !deleted, info };
      } finally {
        ending.delete(zoneId);
      }
    });
  } catch (err) {
    error("zones.end", err, { zoneId, reason });
    return { ended: false, gone: false, error: String(err?.message ?? err) };
  }
  if (result.info && result.ended) {
    try {
      if (annotate && reason !== ZONE_END.UNDO) annotateEnded(result.info, reason, userId);
      if (!quiet && reason !== ZONE_END.UNDO) {
        whisperGMs(loc("DSAUTO.Zone.Ended", { label: result.info.label, reason: loc(`DSAUTO.Zone.End.${reason}`) }));
      }
      Hooks.callAll(HOOK_END(), result.info, { reason, userId });
    } catch (err) {
      error("zones.endAfter", err, { zoneId });
    }
    log("zones.end", { zoneId, reason, label: result.info.label });
  }
  return { ended: !!result.ended, gone: !!result.gone, info: result.info ?? undefined };
}

/* -------------------------------------------- */
/*  Lifetime (active GM)                        */
/* -------------------------------------------- */

/** Copy of summons/registry.mjs `counts` (M6 arms: activation-aware, round fallback across epochs). */
function counts(arm, { round, activation, combatantId = null }, op) {
  if (!arm) return true;
  if (finite(round) && finite(arm.round) && round > arm.round) return true;
  const sameCounter = arm.epoch === lifecycle.activationEpoch && (!arm.combatantId || !combatantId || arm.combatantId === combatantId);
  if (!sameCounter) {
    if (!finite(round) || !finite(arm.round) || round !== arm.round) return false;
    if (op !== ">") return true;
    return !arm.open || (finite(activation) && activation > 1);
  }
  if (!finite(activation) || !finite(arm.activation)) return false;
  return op === ">" ? activation > arm.activation : activation >= arm.activation;
}

/** Live zones whose creator is this combatant's token (same scene). */
function zonesOfCombatant(combatant) {
  const tokenId = combatant?.tokenId ?? combatant?.token?.id ?? null;
  if (!tokenId) return [];
  const sceneId = combatant?.sceneId ?? combatant?.token?.parent?.id ?? null;
  return liveRegions()
    .filter(({ region, flag }) => flag.creatorTokenId === tokenId && (!sceneId || region.parent?.id === sceneId))
    .map(({ region, flag }) => ({ region, flag, info: infoOf(region, flag) }));
}

const isHero = actor => !!actor?.system?.hero?.primary;
const pendKey = (combatId, combatantId) => `${combatId}:${combatantId}`;

/** The lifecycle turn listener (awaited by the lifecycle queue: never await a prompt or a card lock here). */
async function onTurn(payload) {
  try {
    const { event, combat, combatant, round, activation } = payload ?? {};
    if (!isActiveGM() || !combat || !combatant) return;
    if (event !== "turnStart" && event !== "turnEnd") return;
    const zones = zonesOfCombatant(combatant);
    if (!zones.length) return;
    const live = game.combats?.get?.(combat.id) ?? combat;
    const at = { round, activation: activation ?? null, combatantId: combatant.id ?? null };
    if (event === "turnStart") {
      for (const { flag, info } of zones) {
        if (!(flag.lasts ?? []).includes("summonerTurnStart")) continue;
        if (!counts(flag.armStart, at, ">")) continue;
        if (flag.upkeep && flag.upkeptRound === round) continue;   // already kept this round (a repeated turnStart)
        const creator = lookup(flag.creatorActorUuid);
        if (flag.upkeep && isHero(creator)) {
          offerZoneUpkeep(info, { combat: live, round });            // fire-and-forget (§3.10.10)
          continue;
        }
        await endZone(flag.zoneId, ZONE_END.EXPIRED);
      }
      return;
    }
    // turnEnd: decided now, carried out after the DSLF undo grace.
    const todo = [];
    for (const { flag } of zones) {
      const endsHere = (flag.lasts ?? []).includes("summonerTurnEnd") && counts(flag.armEnd, at, ">=");
      todo.push({ zoneId: flag.zoneId, endsHere });
    }
    deferTurnEnd(live, combatant, todo);
  } catch (err) {
    error("zones.turn", err, { event: payload?.event });
  }
}

/** §3.10.10: a turn end's zone work waits 1.5 s; an initiative rise of that combatant in the window drops it. */
function deferTurnEnd(combat, combatant, todo) {
  const key = pendKey(combat.id, combatant.id);
  const prior = pendingEnds.get(key);
  if (prior) clock.clearTimeout(prior.timer);
  const entry = {
    todo, initiative: Number(combatant.initiative ?? 0), groupId: combatant.group?.id ?? combatant._source?.group ?? null,
    groupInitiative: Number(combatant.group?.initiative ?? 0), combatId: combat.id, combatantId: combatant.id, timer: null,
  };
  entry.timer = clock.setTimeout(() => {
    if (pendingEnds.get(key) !== entry) return;
    pendingEnds.delete(key);
    runTurnEnd(entry).catch(err => error("zones.turnEnd", err));
  }, UNDO_GRACE_MS);
  pendingEnds.set(key, entry);
}

async function runTurnEnd(entry) {
  if (!isActiveGM()) return;
  for (const { zoneId, endsHere } of entry.todo) {
    // Unanswered at turn end: let it go (as M6 Q16); the canceller owns the end.
    const hadPrompt = cancelZoneUpkeep(zoneId, "turnEnd");
    if (hadPrompt || endsHere) await endZone(zoneId, ZONE_END.EXPIRED);
  }
}

/** DSLF "Undo Last Activation": the turn was set back and the initiative restored inside the grace window. */
function onInitiativeChange(doc, changes) {
  try {
    if (!isActiveGM() || !pendingEnds.size || !changes || !("initiative" in changes)) return;
    const isGroup = doc?.documentName === "CombatantGroup";
    const combatId = doc?.parent?.id ?? doc?.combat?.id ?? null;
    const now = Number(doc?.initiative ?? changes.initiative ?? 0);
    for (const [key, entry] of [...pendingEnds]) {
      if (combatId && entry.combatId !== combatId) continue;
      const mine = isGroup ? (entry.groupId && entry.groupId === doc.id) : entry.combatantId === doc?.id;
      if (!mine) continue;
      const before = isGroup ? entry.groupInitiative : entry.initiative;
      if (!(now > before)) continue;
      clock.clearTimeout(entry.timer);
      pendingEnds.delete(key);
      // An open upkeep prompt closes without ending the zone; the next turn start asks again (upkeptRound unset).
      for (const { zoneId } of entry.todo) cancelZoneUpkeep(zoneId, "undone");
      log("zones.turnEndUndone", { combatantId: entry.combatantId, zones: entry.todo.length });
    }
  } catch (err) {
    error("zones.initiative", err);
  }
}

/** End of the encounter (§3.10.10): a STARTED combat was deleted. */
async function onEncounterEnd(combat) {
  try {
    if (!isActiveGM() || !combat) return;
    for (const [key, entry] of [...pendingEnds]) {
      if (entry.combatId !== combat.id) continue;
      clock.clearTimeout(entry.timer);
      pendingEnds.delete(key);
    }
    dropZoneClaims(combat.id);
    if (!(combat.started || (combat.round ?? 0) > 0)) return;
    const sceneIds = new Set(list(combat.combatants).map(c => c?.sceneId).filter(Boolean));
    if (combat.scene?.id) sceneIds.add(combat.scene.id);
    const picked = [];
    for (const { region, flag } of liveRegions()) {
      const lasts = flag.lasts ?? [];
      if (lasts.length === 1 && lasts[0] === "manual") continue;
      const inThis = flag.combatId === combat.id;
      const sameSceneNoCombat = flag.combatId == null && sceneIds.has(region.parent?.id);
      if (inThis || sameSceneNoCombat) picked.push(flag);
    }
    if (!picked.length) return;
    for (const flag of picked) cancelZoneUpkeep(flag.zoneId, "encounterEnd");
    // Core's "combatEnd" effect refresh may still be writing: let it settle first (as M6).
    try {
      await lifecycle.combatEndSettled?.(combat.id);
    } catch (_err) { /* nothing to wait for */ }
    const names = [];
    for (const flag of picked) {
      const r = await endZone(flag.zoneId, ZONE_END.ENCOUNTER_END, { quiet: true });
      if (r.ended) names.push(r.info?.label ?? flag.label ?? "");
    }
    if (names.length) await whisperGMs(loc("DSAUTO.Zone.EncounterEnd", { names: [...new Set(names.filter(Boolean))].join(", ") }));
    log("zones.encounterEnd", { combatId: combat.id, removed: names.length });
  } catch (err) {
    error("zones.encounterEnd", err);
  }
}

/** lasts summonerDying / zeroStamina: the creator is dying, dead, or at 0 Stamina. */
function checkCreatorDown(actor) {
  try {
    if (!isActiveGM() || !actor?.uuid) return;
    ensureCache();
    if (!cache.size) return;
    const st = actor.statuses;
    const down = !!st?.has && (st.has("dying") || st.has("dead"));
    const value = Number(actor.system?.stamina?.value);
    const zero = Number.isFinite(value) && value <= 0;
    if (!down && !zero) return;
    for (const { flag } of liveRegions()) {
      if (flag.creatorActorUuid !== actor.uuid || ending.has(flag.zoneId)) continue;
      const lasts = flag.lasts ?? [];
      if ((down && lasts.includes("summonerDying")) || (zero && lasts.includes("zeroStamina"))) {
        endZone(flag.zoneId, ZONE_END.CREATOR_DOWN).catch(err => error("zones.creatorDown", err));
      }
    }
  } catch (err) {
    error("zones.creatorDown", err);
  }
}

/** A region of ours deleted by someone else (or with its creator's token, an attached aura). */
function onRegionDeleted(region, options) {
  try {
    const flag = zoneFlag(region);
    if (!flag) return;
    cache.delete(region.uuid);
    if (!isActiveGM() || options?.[MODULE_ID]?.internal || ending.has(flag.zoneId)) return;
    dropTallies(flag.zoneId);
    dropZoneClaims(null, flag.zoneId);
    cancelZoneUpkeep(flag.zoneId, "dismissed");
    const info = infoOf(region, flag);
    annotateEnded(info, ZONE_END.DELETED, null);
    Hooks.callAll(HOOK_END(), info, { reason: ZONE_END.DELETED, userId: null });
    log("zones.deleted", { zoneId: flag.zoneId, label: info.label });
  } catch (err) {
    error("zones.regionDeleted", err);
  }
}

/** Patch `upkeptRound` on the zone's region (call ON the chain only). */
export async function markUpkept(zoneId, round) {
  const region = regionOfZone(zoneId);
  if (!region?.update) return false;
  await region.update({ [`flags.${MODULE_ID}.zone.upkeptRound`]: round }, INTERNAL());
  return true;
}

/** Is this zone's end running? */
export const isEnding = zoneId => ending.has(zoneId);

/**
 * init (main.mjs, after registerOngoing): the lifecycle listener and the hooks of §3.10.10. Never throws.
 */
export function registerZones() {
  if (registered) return;
  registered = true;
  try {
    lifecycle.onTurnEvent?.(onTurn);
    Hooks.on("deleteCombat", combat => {
      onEncounterEnd(combat).catch(err => error("zones.encounterEnd", err));
    });
    Hooks.on("updateCombat", (combat, changes) => {
      try {
        if (combat?.id && changes && "round" in changes) dropZoneClaims(combat.id);
      } catch (err) {
        error("zones.round", err);
      }
    });
    Hooks.on("updateCombatant", (doc, changes) => onInitiativeChange(doc, changes));
    Hooks.on("updateCombatantGroup", (doc, changes) => onInitiativeChange(doc, changes));
    Hooks.on("updateActor", actor => checkCreatorDown(actor));
    Hooks.on("updateToken", (token, changes) => {
      try {
        if (changes?.delta) checkCreatorDown(token?.actor);
      } catch (err) {
        error("zones.updateToken", err);
      }
    });
    Hooks.on("createActiveEffect", effect => {
      try {
        const actor = effect?.parent?.documentName === "Actor" ? effect.parent : (effect?.parent?.parent ?? null);
        if (actor?.documentName === "Actor") checkCreatorDown(actor);
      } catch (err) {
        error("zones.effect", err);
      }
    });
    Hooks.on("createRegion", region => {
      try {
        cacheAdd(region);
      } catch (err) {
        error("zones.regionCreated", err);
      }
    });
    Hooks.on("deleteRegion", (region, options) => onRegionDeleted(region, options));
    const rebuild = () => {
      try {
        cacheRebuild();
      } catch (err) {
        error("zones.cache", err);
      }
    };
    Hooks.on("ready", rebuild);
    Hooks.on("canvasReady", rebuild);
  } catch (err) {
    error("zones.register", err);
  }
}
