/**
 * Native targeted conditions (Milestone 8, docs/M8-DESIGN.md §3): frightened, taunted and grabbed written as the
 * system's own representation, on the active GM only (the relay's single writer).
 *
 * The system keeps the source of a targeted status in the derived, non-persisted `system.statuses.<id>.sources`
 * (DSM:1328-1340), filled only by an Active Effect change `system.statuses.<id>.sources` add <actor uuid>
 * (DSM:4196-4200). Every system path that makes these effects (`fromStatusEffect`, `toggleStatusEffect`, the applied
 * effect buttons) opens the source prompt on the CLICKING client with that user's targets (DSM:4189-4206), so the
 * effect is built here by hand (D14): the static status id (HUD and sheet toggles find it, DSM:24533-24590), `statuses`,
 * the source change, the end as `duration.expiry` and `start.combatant` (core's turn expiry needs it,
 * active-effect.mjs:930-948). No Combat Tools flags and no "Grabber" effect (DSCT would add its own banes on top of the
 * system's, R2 §2.6).
 * - Frightened and taunted (`maxSources: 1`) replace: the static-id effect and a Combat Tools flagged copy are deleted
 *   (kept for undo as `replaced` / `replacedExtra`).
 * - Grabbed appends a source to a live static effect of another grabber (the system allows several, D15); the same
 *   grabber again is idempotent. A Combat Tools grab is never touched (its grabber state would break).
 * - After the write the system must see the source (`sources.has`), otherwise everything is rolled back
 *   (`nativeNoSource`).
 * Routing (`targetedRoute`, plan.mjs, WP-A): `auto` = Combat Tools when its conditions are on, else native (D13);
 * `native` always; `off` manual rows.
 * `handleEndTargeted` is the relay action `endTargeted` (api.endTargeted, §3.6); `nativeTargetedEffects(filter)` lists
 * our effects for the self-check and the cleanup.
 *
 * i18n keys (WP-D merges them into lang/en.json):
 *   DSAUTO.Reason.nativeNoSource   "The effect was created but the system does not see its source"
 *   DSAUTO.Reason.sourceDefeated   "Ended: its source was defeated"
 *   DSAUTO.Reason.ended            "Ended by hand"
 *   DSAUTO.Targeted.GrabberHint    "A grabber's speed is halved unless it is larger than the creature it grabs (not tracked)."
 */
import { HOOKS, MODULE_ID, OP_STATUS } from "../constants.mjs";
import { dsctFlaggedEffect } from "../compat/dsct.mjs";
import { meetsRoleFloor } from "../relay/auth.mjs";
import { setUntil } from "../turn/until.mjs";
import { error, log } from "../log.mjs";
import * as engine from "./engine.mjs";
import { targetedRoute } from "./plan.mjs";

export const TARGETED = Object.freeze(["frightened", "taunted", "grabbed"]);

/** Why a native targeted effect (or one of its sources) ended: card annotations and the `targetedEnded` hook. */
export const ENDED = Object.freeze({ DEFEATED: "sourceDefeated", REVIVED: "revived", ENDED: "ended" });

/** Our own effect writes (trackers and watchers skip them). */
const INTERNAL = () => ({ [MODULE_ID]: { internal: true } });

/** The change key the system derives a status source from (DSM:4196-4200). */
export const SOURCES = statusId => `system.statuses.${statusId}.sources`;

const sourceChange = (statusId, uuid) => ({ key: SOURCES(statusId), type: "add", value: uuid, phase: "initial" });

/** Status config of a targeted status (the static `_id` is `id.padEnd(16, "0")`, DSM:31520-31522). */
export function targetedStatus(statusId) {
  const list = CONFIG.statusEffects;
  return (Array.isArray(list) ? list.find(s => s.id === statusId) : list?.[statusId]) ?? null;
}

/** "dsct" | "native" | "off" for a targeted status under the current settings. */
export function routeFor(statusId) {
  return targetedRoute(statusId);
}

function combatantFor(actor) {
  return game.combat?.getCombatantsByActor?.(actor)?.[0] ?? null;
}

/** Expiry event for an effect end key ("turn" -> "turnEnd", "save" -> "save", ...). */
function expiryEvent(endKey) {
  return endKey ? (ds.CONFIG.effectEnds?.[endKey]?.expiryEvent ?? null) : null;
}

const flagOf = effect => effect?.flags?.[MODULE_ID]?.targeted ?? null;

/** Is this one of our native targeted effects? */
export const isNativeTargeted = effect => !!flagOf(effect)?.statusId;

/** Source uuids of an effect's change list for `statusId`. */
export function changeSources(effect, statusId) {
  const changes = effect?.system?.changes ?? effect?.changes ?? [];
  return changes.filter(c => c?.key === SOURCES(statusId) && typeof c.value === "string").map(c => c.value);
}

/** Does the system see `sourceUuid` as a source of `statusId` on `actor`? */
const systemSees = (actor, statusId, sourceUuid) => !!actor?.system?.statuses?.[statusId]?.sources?.has?.(sourceUuid);

/** The effect data of the system's representation (R2 §4.3). */
function nativeEffectData({ status, op, item, res, message, sourceUuid, expiry, combatant }) {
  const AE = CONFIG.ActiveEffect?.documentClass;
  const start = { ...(typeof AE?.getEffectStart === "function" ? AE.getEffectStart() : {}), combatant: combatant?.id ?? null };
  if (!game.combats?.isDefaultInitiativeMode) start.initiative = combatant?.initiative ?? null;
  const system = { changes: [sourceChange(op.effectId, sourceUuid)] };
  if (expiry === "save") system.end = { roll: "1d10 + @combat.save.bonus" };
  const row = { sourceUuid, messageId: message?.id ?? null, opId: op.opId ?? null };
  return {
    _id: status._id,
    name: game.i18n.localize(status.name ?? op.effectId),
    img: status.img ?? null,
    type: "base",
    statuses: [op.effectId],
    showIcon: globalThis.CONST?.ACTIVE_EFFECT_SHOW_ICON?.ALWAYS ?? 2,
    description: status.rule ? `@Embed[${status.rule} inline]` : "",
    origin: item?.uuid ?? res.abilityUuid ?? null,
    transfer: true,
    system,
    duration: { expiry: expiry ?? null },
    start,
    flags: {
      [MODULE_ID]: {
        messageId: message?.id ?? null, opId: op.opId ?? null,
        targeted: { statusId: op.effectId, sourceActorUuid: sourceUuid, sourceTokenUuid: res.sourceTokenUuid ?? null, rows: [row] },
      },
    },
  };
}

/** Fields every native patch sets, so nothing of an earlier apply (or of the DSCT route) lingers on the row. */
const BASE_PATCH = Object.freeze({
  native: true, delegated: null, grabbedTokenId: null, appended: false, idempotent: false, updatedId: null,
  createdIds: [], replaced: null, replacedExtra: [], untilSet: null, endedReason: null,
});

/**
 * Apply a targeted condition op natively (active GM).
 * @returns {Promise<object>} Fields to merge into the op record.
 */
export async function applyNativeTargeted(message, res, op, item, actor) {
  const status = targetedStatus(op.effectId);
  if (!status?._id || !TARGETED.includes(op.effectId)) return { status: OP_STATUS.FAILED, reason: "effectMissing" };
  const sourceActor = (res.sourceActorUuid ? fromUuidSync(res.sourceActorUuid) : null) ?? item?.actor ?? null;
  // The synthetic uuid for an unlinked token: the system compares `actor.uuid` (DSM:6519-6551).
  if (!sourceActor?.uuid) return { status: OP_STATUS.FAILED, reason: "sourceMissing" };
  const sourceUuid = sourceActor.uuid;
  const id = op.effectId;
  const existing = actor.effects.get(status._id) ?? null;
  const live = existing && !existing.duration?.expired;

  // Grabbed: a live static effect of another grabber gets this source appended; the same grabber again is a no-op.
  if (id === "grabbed" && live) {
    if (changeSources(existing, id).includes(sourceUuid)) {
      return { ...BASE_PATCH, status: OP_STATUS.APPLIED, idempotent: true, sourceUuid };
    }
    const replaced = existing.toObject();
    const changes = [...(existing.system?.changes ?? []), sourceChange(id, sourceUuid)];
    const flag = flagOf(existing) ?? { statusId: id, sourceActorUuid: null, sourceTokenUuid: null };
    const rows = [...(flag.rows ?? []), { sourceUuid, messageId: message?.id ?? null, opId: op.opId ?? null }];
    await existing.update({ "system.changes": changes, [`flags.${MODULE_ID}.targeted`]: { ...flag, statusId: id, rows } }, INTERNAL());
    if (!systemSees(actor, id, sourceUuid)) {
      await existing.update({ "system.changes": replaced.system?.changes ?? [], [`flags.${MODULE_ID}.targeted`]: replaced.flags?.[MODULE_ID]?.targeted ?? null }, INTERNAL());
      return { status: OP_STATUS.FAILED, reason: "nativeNoSource" };
    }
    log("targeted.append", { actor: actor.name, status: id, source: sourceUuid });
    return { ...BASE_PATCH, status: OP_STATUS.APPLIED, appended: true, updatedId: existing.id, replaced, sourceUuid };
  }

  // Replace: the static-id effect, and for frightened / taunted a Combat Tools flagged copy (one source only).
  const flagged = id === "grabbed" ? null : dsctFlaggedEffect(actor, id);
  const replaced = existing?.toObject() ?? null;
  const replacedExtra = flagged && flagged.id !== existing?.id ? [flagged.toObject()] : [];
  const del = [existing?.id, ...replacedExtra.map(e => e._id)].filter(Boolean);
  if (del.length) await actor.deleteEmbeddedDocuments("ActiveEffect", del, INTERNAL());
  const expiry = op.until ? null : expiryEvent(op.end);
  const combatant = combatantFor(op.originDuration ? sourceActor : actor);
  const data = nativeEffectData({ status, op, item, res, message, sourceUuid, expiry, combatant });
  const created = (await actor.createEmbeddedDocuments("ActiveEffect", [data], { keepId: true, ...INTERNAL() })) ?? [];
  const createdIds = created.map(e => e?.id).filter(Boolean);
  if (!createdIds.length || !systemSees(actor, id, sourceUuid)) {
    await rollback(actor, createdIds, [replaced, ...replacedExtra]);
    return { status: OP_STATUS.FAILED, reason: createdIds.length ? "nativeNoSource" : "nothingCreated" };
  }
  const patch = { ...BASE_PATCH, status: OP_STATUS.APPLIED, createdIds, replaced, replacedExtra, sourceUuid };
  // "Until the start / end of your next turn" (library rows): the user's turns end it, as library-apply.mjs.
  if (op.until) {
    const user = combatantFor(sourceActor);
    if (user && game.combat?.started) {
      try {
        await setUntil(created[0], { event: op.until === "yourNextTurnStart" ? "turnStart" : "turnEnd", combatantId: user.id }, { keepExpiry: !!expiry });
        patch.untilSet = op.until;
      } catch (err) {
        error("targeted.until", err, { opId: op.opId });
      }
    }
  }
  log("targeted.create", { actor: actor.name, status: id, source: sourceUuid, replaced: !!replaced, extra: replacedExtra.length });
  return patch;
}

/** Undo a failed write: delete what was created, recreate what was replaced (restored, not newly made). */
async function rollback(actor, createdIds, restore) {
  try {
    const ids = createdIds.filter(i => actor.effects.has(i));
    if (ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ids, INTERNAL());
    const back = restore.filter(d => d?._id && !actor.effects.has(d._id));
    if (back.length) await actor.createEmbeddedDocuments("ActiveEffect", back, { keepId: true, [MODULE_ID]: { internal: true, restore: true } });
  } catch (err) {
    error("targeted.rollback", err, { actor: actor?.uuid });
  }
}

/**
 * Undo of a native op (undo.mjs): an append removes only its own source (a later grab may have appended again), and
 * so does the row that created a grab other grabbers joined since; an idempotent apply wrote nothing. Other native
 * ops use the generic branch (delete what was created, restore what was replaced).
 * @returns {Promise<object|null>} The patch, or null for the generic branch.
 */
export async function undoNativeTargeted(actor, op) {
  if (op.idempotent) return { status: OP_STATUS.UNDONE, undoMode: "noop" };
  const effect = actor.effects.get(op.appended ? op.updatedId : op.createdIds?.[0]) ?? null;
  // The grab this row created has other grabbers by now: only this row's source goes.
  const shared = !op.appended && op.effectId === "grabbed" && !!effect && changeSources(effect, op.effectId).some(u => u !== op.sourceUuid);
  if (!op.appended && !shared) return null;
  if (effect) {
    const key = SOURCES(op.effectId);
    const changes = [...(effect.system?.changes ?? [])];
    const at = changes.findIndex(c => c?.key === key && c.value === op.sourceUuid);
    if (at >= 0) changes.splice(at, 1);
    const flag = flagOf(effect);
    const update = { "system.changes": changes };
    if (flag?.rows) update[`flags.${MODULE_ID}.targeted.rows`] = flag.rows.filter(r => !(r.sourceUuid === op.sourceUuid && r.opId === op.opId));
    await effect.update(update, INTERNAL());
  }
  return { status: OP_STATUS.UNDONE };
}

/* -------------------------------------------- */
/*  Listing (self-check, cleanup)               */
/* -------------------------------------------- */

/** A collection's documents (`contents`, any iterable), or none (partial mocks, a world before ready). */
function iterable(c) {
  if (!c) return [];
  if (Array.isArray(c.contents)) return c.contents;
  return typeof c[Symbol.iterator] === "function" ? c : [];
}

/** Every actor that may carry effects: world actors and the unlinked token actors of every scene. */
export function candidateActors() {
  const out = new Map();
  for (const a of iterable(game.actors)) if (a?.uuid && !out.has(a.uuid)) out.set(a.uuid, a);
  for (const scene of iterable(game.scenes)) {
    for (const t of iterable(scene?.tokens)) {
      if (t.actorLink) continue;
      let a = null;
      try {
        a = t.actor;
      } catch (_err) {
        a = null;
      }
      if (a?.uuid && !out.has(a.uuid)) out.set(a.uuid, a);
    }
  }
  return [...out.values()];
}

/**
 * Our native targeted effects, optionally filtered: a function `(effect) => boolean`, or `{statusId, sourceUuid,
 * actorUuid, live}` (`live: true` = not expired).
 * @returns {ActiveEffect[]}
 */
export function nativeTargetedEffects(filter = null) {
  const test = typeof filter === "function" ? filter : (e => {
    const f = filter ?? {};
    const flag = flagOf(e);
    if (f.statusId && flag.statusId !== f.statusId) return false;
    if (f.sourceUuid && !changeSources(e, flag.statusId).includes(f.sourceUuid) && flag.endedBy?.sourceUuid !== f.sourceUuid) return false;
    if (f.actorUuid && e.parent?.uuid !== f.actorUuid) return false;
    if (f.live && e.duration?.expired) return false;
    return true;
  });
  const out = [];
  for (const actor of candidateActors()) {
    for (const e of actor.effects ?? []) if (isNativeTargeted(e) && test(e)) out.push(e);
  }
  return out;
}

/* -------------------------------------------- */
/*  api.endTargeted (relay action endTargeted)  */
/* -------------------------------------------- */

function owns(user, doc) {
  try {
    return !!doc?.testUserPermission?.(user, "OWNER");
  } catch (_err) {
    return false;
  }
}

function lookup(uuid) {
  if (typeof uuid !== "string" || !uuid) return null;
  try {
    return fromUuidSync(uuid);
  } catch (_err) {
    return null;
  }
}

/** Fire-and-forget card annotation of the row that made a source (engine annotateOps, its own lock). */
export function annotateRow(messageId, opId, patch) {
  if (!messageId || !opId) return;
  const message = game.messages?.get?.(messageId);
  if (!message || typeof engine.annotateOps !== "function") return;
  engine.annotateOps(message, { [opId]: patch }).catch(err => error("targeted.annotate", err, { messageId, opId }));
}

/** The row (card and op) that made `sourceUuid` a source of the effect. */
export function rowOf(effect, sourceUuid) {
  const flag = flagOf(effect);
  const row = (flag?.rows ?? []).find(r => r?.sourceUuid === sourceUuid);
  if (row) return row;
  if (flag?.sourceActorUuid === sourceUuid) return { sourceUuid, messageId: effect.flags?.[MODULE_ID]?.messageId ?? null, opId: effect.flags?.[MODULE_ID]?.opId ?? null };
  return null;
}

export function callEnded(effect, reason, sourceUuid) {
  try {
    Hooks.callAll(HOOKS.targetedEnded ?? "dsAuto.targetedEnded", effect, { reason, sourceUuid: sourceUuid ?? null });
  } catch (err) {
    error("targeted.hook", err);
  }
}

/**
 * Relay `endTargeted` (active GM): end the static effect of `statusId` on an actor, or only one source of a grab with
 * several. Allowed: the role floor (`cardActionRole`, Directors), owners of the affected actor, owners of the source.
 * @param {{actorUuid: string, statusId: string, sourceUuid?: string|null}} req  (or a payload holding `endTargeted`)
 * @param {User} user
 * @returns {Promise<{ok: true, ended: "effect"|"source"|"none"}>}
 */
export async function handleEndTargeted(req, user) {
  if (!game.users.activeGM?.isSelf) throw new Error("DSAUTO.Relay.NotActiveGM");
  const data = req?.endTargeted && typeof req.endTargeted === "object" ? req.endTargeted : req;
  const { actorUuid, statusId } = data ?? {};
  const sourceUuid = data?.sourceUuid ?? null;
  if (!user || typeof actorUuid !== "string" || actorUuid.length > 300 || !TARGETED.includes(statusId)) throw new Error("DSAUTO.Relay.BadRequest");
  if (sourceUuid !== null && (typeof sourceUuid !== "string" || sourceUuid.length > 300)) throw new Error("DSAUTO.Relay.BadRequest");
  const doc = lookup(actorUuid);
  const actor = doc?.documentName === "Token" ? doc.actor : doc;
  if (!actor?.effects) throw new Error("DSAUTO.Relay.BadRequest");
  const status = targetedStatus(statusId);
  const effect = status?._id ? (actor.effects.get(status._id) ?? null) : null;
  const sources = effect ? changeSources(effect, statusId) : [];
  const allowed = user.isGM || meetsRoleFloor(user) || owns(user, actor)
    || (sourceUuid ? owns(user, lookup(sourceUuid)) : sources.some(u => owns(user, lookup(u))));
  if (!allowed) throw new Error("DSAUTO.Relay.Denied");
  if (!effect || (sourceUuid && !sources.includes(sourceUuid))) return { ok: true, ended: "none" };
  if (sourceUuid && sources.length > 1) {
    const key = SOURCES(statusId);
    const changes = [...(effect.system?.changes ?? [])].filter(c => !(c?.key === key && c.value === sourceUuid));
    const update = { "system.changes": changes };
    const flag = flagOf(effect);
    if (flag?.rows) update[`flags.${MODULE_ID}.targeted.rows`] = flag.rows.filter(r => r.sourceUuid !== sourceUuid);
    const row = rowOf(effect, sourceUuid);
    await effect.update(update, INTERNAL());
    if (row) annotateRow(row.messageId, row.opId, { endedReason: ENDED.ENDED, endedAt: Date.now() });
    callEnded(effect, ENDED.ENDED, sourceUuid);
    log("targeted.endSource", { actor: actor.name, status: statusId, source: sourceUuid, by: user.id });
    return { ok: true, ended: "source" };
  }
  const rows = sources.map(u => rowOf(effect, u)).filter(Boolean);
  await actor.deleteEmbeddedDocuments("ActiveEffect", [effect.id], INTERNAL());
  for (const row of rows) annotateRow(row.messageId, row.opId, { endedReason: ENDED.ENDED, endedAt: Date.now() });
  callEnded(effect, ENDED.ENDED, sourceUuid);
  log("targeted.end", { actor: actor.name, status: statusId, by: user.id });
  return { ok: true, ended: "effect" };
}
