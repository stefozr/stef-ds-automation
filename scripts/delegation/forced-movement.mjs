/**
 * Forced movement (push / pull / slide) of one target, on the active GM.
 *
 * - With Draw Steel: Combat Tools (setting `forcedMovementEnabled`) its engine moves the token: stability,
 *   walls, creatures, objects, collision and fall damage, grabs. It is called through API form 3
 *   (`api.forcedMovement({type, distance, sourceId, targetId, ..., suppressMessage: true})`,
 *   forced-movement-engine.mjs:2808-2814), which returns `{undoLog, finalPos, hadDamage, ...}` instead of
 *   posting its own card. Undo replays that log with ctlib's `replayUndo` (ctlib helpers.mjs:881).
 *   `fastMove` takes the straight line away from (push) or towards (pull) the source without asking;
 *   without it the Director picks the path on the canvas (slides, vertical moves, setting "choose").
 *   Form 3 takes no keywords, so the larger-creature bonus is added here (sizeBonus).
 * - Without it: a straight-line push or pull of our own on square grids. Walls and creatures stop the
 *   target; collision damage is left to the Director (the card shows the squares left). Slides and
 *   vertical moves need a choice and stay manual.
 *
 * Both work on placeables: the Director must be viewing the target's scene.
 * Milestone 5: our own Combat Tools calls run inside `withOwnForcedMove`, so our own triggered-action gate on
 * `dsct.preForcedMovement` (triggers/external.mjs) recognises them and never holds them (C6).
 * 0.16.0: with Draw Steel: Triggers active its `dsct.preForcedMovement` hold would swallow our call (no result, the move
 * resumed later without an undo log), so our calls skip that gate once (`bypassNextFmGate`).
 * 0.17.0: a move that needs a pick runs in Combat Tools' own picker on the screen of whoever used the ability
 * (delegation/forced-picker.mjs); the path bridge of 0.12-0.16 (dsct-picked-path.mjs) is retired. This module builds the
 * spec and the record for both callers (`dsctForcedSpec`, `forcedRefusal`, `dsctResultPatch`).
 */
import { OP_STATUS, TRIGGERS_ID } from "../constants.mjs";
import { ctlib } from "../compat/ctlib.mjs";
import { announcePendingRevival, reviveTokens } from "../compat/death-tracker.mjs";
import { dsctApi, dsctForcedOn, dsctForcedTaken } from "../compat/dsct.mjs";
import { log } from "../log.mjs";
import { setting } from "../settings.mjs";
import { withOwnForcedMove } from "../triggers/external.mjs";
import { moveTokenTo, positionOf, samePosition } from "./teleport.mjs";

const DSCT_PROPERTIES = ["no-collision-damage", "no-mover-collision-damage", "no-obstacle-collision-damage"];

/**
 * Does moving this way need a pick on the canvas? Slides and vertical moves always do, so do flying
 * targets (Combat Tools turns their push into a vertical move and asks how far, forced-movement-engine.mjs
 * :210-214) and the setting `forcedPath = choose`.
 */
export function needsPick({ movement, vertical = false, flying = false, choosePath = false }) {
  return !movement || movement === "slide" || !!vertical || !!flying || !!choosePath;
}

/** Who carries out forced movement now: "dsct", "core" (our straight line) or null (by hand only). */
export function forcedDelegate({ interactive = false } = {}) {
  if (dsctForcedOn()) return "dsct";
  if (setting("forcedFallback")) return "core";
  return null;
}

/** Size order of Draw Steel (1T < 1S < 1M < 1L < 2 < 3 ...), as ctlib's sizeRank (helpers.mjs:1166). */
export function sizeRank(size) {
  const value = Number(size?.value ?? 1);
  if (value >= 2) return value + 2;
  return { T: 0, S: 1, M: 2, L: 3 }[size?.letter] ?? 2;
}

/**
 * +1 distance when a larger creature force-moves with a melee weapon ability (Draw Steel rule; Combat
 * Tools applies it only to its own card buttons, forced-movement-engine.mjs:106-114).
 */
export function sizeBonus(sourceActor, targetActor, keywords) {
  const kw = new Set([...(keywords ?? [])].map(k => String(k).toLowerCase()));
  if (!sourceActor || !targetActor || !kw.has("melee") || !kw.has("weapon")) return 0;
  return sizeRank(sourceActor.system?.combat?.size) > sizeRank(targetActor.system?.combat?.size) ? 1 : 0;
}

/** The target's stability (shown on the card; the delegate applies it). */
export function stabilityOf(actor) {
  return Math.max(0, Number(actor?.system?.combat?.stability ?? 0) || 0);
}

function onCanvas(doc) {
  const scene = globalThis.canvas?.scene;
  return !!doc?.object && !!scene && doc.parent?.id === scene.id;
}

const stripHtml = html => String(html ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Move one target.
 * @param {object} spec
 * @param {TokenDocument} spec.targetDoc
 * @param {TokenDocument|null} spec.sourceDoc
 * @param {"push"|"pull"|"slide"} spec.movement
 * @param {number} spec.distance            Before stability (the delegate subtracts it).
 * @param {boolean} [spec.vertical]
 * @param {boolean} [spec.ignoreStability]
 * @param {string[]} [spec.properties]     Combat Tools' collision properties.
 * @param {boolean} [spec.interactive]     The Director picks the path (Combat Tools only).
 * @returns {Promise<object>} Fields to merge into the op record.
 */
export async function runForced(spec) {
  const { sourceDoc, interactive = false } = spec;
  const distance = Math.max(0, Math.floor(Number(spec.distance) || 0));
  const delegate = forcedDelegate({ interactive });
  if (!delegate) return { status: OP_STATUS.FAILED, reason: "delegateUnavailable" };
  const sourceOk = sourceDoc && onCanvas(sourceDoc);
  const taken = delegate === "dsct" ? dsctForcedTaken(spec.targetDoc?.actor) : 0;
  const refused = forcedRefusal({ ...spec, distance, taken });
  if (refused) return refused;
  return delegate === "dsct"
    ? runDsct({ ...spec, distance, sourceDoc: sourceOk ? sourceDoc : null })
    : runCore({ ...spec, distance });
}

/**
 * Why this move cannot run (a patch), or null: the target or source missing or off the viewed scene, a self move, no
 * distance, or stability covering the whole move (Combat Tools resists with a notification and a `noMove` result).
 * `taken`: Combat Tools' extra squares the target takes (dsctForcedTaken), added before stability.
 */
export function forcedRefusal({ targetDoc, sourceDoc, movement, distance, ignoreStability = false, taken = 0 }) {
  if (!targetDoc?.actor) return { status: OP_STATUS.FAILED, reason: "targetMissing" };
  if (!onCanvas(targetDoc)) return { status: OP_STATUS.FAILED, reason: "notOnCanvas" };
  const needsSource = movement === "push" || movement === "pull";
  const sourceOk = sourceDoc && onCanvas(sourceDoc);
  if (needsSource && !sourceOk) return { status: OP_STATUS.FAILED, reason: "sourceNotOnCanvas" };
  if (needsSource && sourceDoc.id === targetDoc.id) return { status: OP_STATUS.SKIPPED, reason: "selfForced" };
  if (!(distance > 0)) return { status: OP_STATUS.SKIPPED, reason: "notMoved" };
  if (!ignoreStability && distance + taken <= stabilityOf(targetDoc.actor)) return { status: OP_STATUS.SKIPPED, reason: "stabilityResists" };
  return null;
}

/** Combat Tools' API form 3 spec (1.2.7 forced-movement-engine.mjs:3033-3039); `interactive` opens its picker. */
export function dsctForcedSpec({ targetDoc, sourceDoc, movement, distance, vertical = false, ignoreStability = false, properties = [], interactive = false }) {
  const props = new Set(properties);
  return {
    type: capitalize(movement), distance,
    sourceId: sourceDoc?.id ?? null, targetId: targetDoc.id,
    // Form 3 does not flip the sign for pulls itself (form 2 does, forced-movement-engine.mjs:2771).
    verticalHeight: vertical ? (movement === "pull" ? -distance : distance) : 0,
    fallReduction: 0, noFallDamage: false,
    noCollisionDamage: props.has(DSCT_PROPERTIES[0]),
    noMoverCollisionDamage: props.has(DSCT_PROPERTIES[1]),
    noObstacleCollisionDamage: props.has(DSCT_PROPERTIES[2]),
    ignoreStability: !!ignoreStability, fastMove: !interactive, suppressMessage: true,
  };
}

/**
 * Call Combat Tools' engine on this client (the active GM, or the user picking in delegation/forced-picker.mjs).
 * Combat Tools fires dsct.preForcedMovement synchronously inside this call: our gate lets it through.
 */
export async function callDsctForced(spec) {
  const api = dsctApi();
  if (typeof api?.forcedMovement !== "function") return null;
  const foreignGate = !!game.modules.get(TRIGGERS_ID)?.active;
  return withOwnForcedMove(() => {
    if (foreignGate) api.bypassNextFmGate?.();
    return api.forcedMovement(spec);
  });
}

/** Whether a Combat Tools result moved the target (every real move carries a `moveId`; `noMove` results do not). */
export const dsctMoved = result => !!(result?.undoLog && result.moveId && !result.noMove);

/** The applied record of a Combat Tools move. `finalPos`: the token's settled position (taken here when not given). */
export async function dsctResultPatch(result, { targetDoc, movement, distance, startPos, finalPos = null }) {
  return {
    status: OP_STATUS.APPLIED, delegated: "dsct", movedType: movement, movedDistance: distance,
    undoLog: result.undoLog, staminaAfter: staminaSnapshots(result.undoLog), moveId: result.moveId ?? null,
    // Combat Tools' `finalPos` is read while its animation still runs (fractional pixels, seen live):
    // the position is taken from the token once it has settled.
    startPos, finalPos: finalPos ?? await settledPosition(targetDoc), hadDamage: !!result.hadDamage,
    summary: stripHtml(result.content), collisionLeft: null,
    grabsEnded: (result.grabsToRestore ?? []).map(g => ({ grabberTokenId: g.grabberTokenId, grabbedTokenId: g.grabbedTokenId })),
  };
}

async function runDsct(args) {
  const { targetDoc, movement, distance, interactive = false } = args;
  if (typeof dsctApi()?.forcedMovement !== "function") return { status: OP_STATUS.FAILED, reason: "delegateUnavailable" };
  const startPos = positionOf(targetDoc);
  const spec = dsctForcedSpec(args);
  const result = await callDsctForced(spec);
  // Nothing moved: stability resisted it all or a self move (Combat Tools 1.2.7 answers `noMove` with an empty
  // undo log), the target is grabbed or restrained, the path pick was cancelled, or another module's
  // dsct.preForcedMovement hook held it (our own gate never holds our calls). The Director may apply again.
  if (!dsctMoved(result)) {
    log("forced.refused", { type: spec.type, distance, targetId: spec.targetId, sourceId: spec.sourceId, fastMove: spec.fastMove, interactive, noMove: !!result?.noMove });
    return { status: OP_STATUS.SKIPPED, reason: "notMoved" };
  }
  return dsctResultPatch(result, { targetDoc, movement, distance: distance + dsctForcedTaken(targetDoc.actor), startPos });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The token's position once its movement has finished (two equal whole-pixel reads, at most ~2 s). */
export async function settledPosition(doc) {
  try {
    await doc.object?.movementAnimationPromise;
  } catch (_err) { /* no animation */ }
  let last = positionOf(doc);
  for (let i = 0; i < 20; i++) {
    await sleep(100);
    const now = positionOf(doc);
    if (samePosition(now, last) && Number.isInteger(now.x) && Number.isInteger(now.y)) return now;
    last = now;
  }
  return last;
}

function lookupDoc(uuid) {
  try {
    return uuid ? fromUuidSync(uuid) : null;
  } catch (_err) {
    return null;
  }
}

/** Stamina right after the move, per "stamina" entry of Combat Tools' undo log (same order). */
function staminaSnapshots(undoLog) {
  return (undoLog ?? []).filter(e => e?.op === "stamina").map(e => {
    const s = lookupDoc(e.uuid)?.system?.stamina ?? {};
    const squad = e.squadGroupUuid ? lookupDoc(e.squadGroupUuid)?.system?.staminaValue : null;
    return { value: s.value ?? 0, temp: s.temporary ?? 0, squad: squad ?? null };
  });
}

/**
 * Combat Tools' "stamina" entries write the values from before the move back as they are
 * (ctlib replayUndo). That would also wipe damage dealt since, or deal again what an undo removed in
 * between. Rewrite them to reverse only the move's own change (the collision damage): dropped when the
 * move changed nothing, else current + (before - after). Returns the entries and whether anything else
 * had changed Stamina since (`delta`).
 */
export function deltaStaminaEntries(undoLog, after) {
  let i = 0;
  let delta = false;
  const out = [];
  for (const e of undoLog ?? []) {
    if (e?.op !== "stamina") {
      out.push(e);
      continue;
    }
    const a = after?.[i++];
    if (!a) {
      out.push(e); // older record without snapshots: Combat Tools' own behaviour
      continue;
    }
    const prevSquad = e.squadGroupUuid && e.prevSquadHP != null ? Number(e.prevSquadHP) : null;
    const changed = Number(e.prevValue) !== a.value || Number(e.prevTemp ?? 0) !== a.temp || (prevSquad != null && a.squad != null && prevSquad !== a.squad);
    if (!changed) continue;
    const actor = lookupDoc(e.uuid);
    const s = actor?.system?.stamina ?? {};
    const cur = { value: s.value ?? 0, temp: s.temporary ?? 0 };
    if (cur.value !== a.value || cur.temp !== a.temp) delta = true;
    let value = cur.value + (Number(e.prevValue) - a.value);
    if (Number.isFinite(s.max)) value = Math.min(s.max, value);
    const next = { ...e, prevValue: value, prevTemp: Math.max(0, cur.temp + (Number(e.prevTemp ?? 0) - a.temp)) };
    if (prevSquad != null && a.squad != null) {
      const group = lookupDoc(e.squadGroupUuid);
      const curSquad = Number(group?.system?.staminaValue ?? a.squad);
      if (curSquad !== a.squad) delta = true;
      next.prevSquadHP = Math.max(0, curSquad + (prevSquad - a.squad));
    } else {
      next.prevSquadHP = null;
    }
    out.push(next);
  }
  return { entries: out, delta };
}

/** One grid step for a straight push (away from the source) or pull (towards it): 8 directions. */
export function straightStep(sourceCenter, targetCenter, movement) {
  let dx = targetCenter.x - sourceCenter.x;
  let dy = targetCenter.y - sourceCenter.y;
  if (movement === "pull") [dx, dy] = [-dx, -dy];
  if (!dx && !dy) return null;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const TAN_67 = 2.414; // beyond 67.5 degrees off an axis the step is straight along that axis
  if (ax > TAN_67 * ay) return { x: Math.sign(dx), y: 0 };
  if (ay > TAN_67 * ax) return { x: 0, y: Math.sign(dy) };
  return { x: Math.sign(dx), y: Math.sign(dy) };
}

function wallBetween(from, to) {
  try {
    const backend = CONFIG.Canvas?.polygonBackends?.move;
    return !!backend?.testCollision?.(from, to, { type: "move", mode: "any" });
  } catch (_err) {
    return false;
  }
}

const isDead = actor => !!actor?.statuses?.has?.(CONFIG.specialStatusEffects?.DEFEATED ?? "dead");

function occupied(targetDoc, pos, G) {
  const w = (targetDoc.width ?? 1) * G;
  const h = (targetDoc.height ?? 1) * G;
  for (const t of globalThis.canvas?.tokens?.placeables ?? []) {
    const d = t.document;
    if (!d || d.id === targetDoc.id || isDead(d.actor)) continue;
    const dw = (d.width ?? 1) * G;
    const dh = (d.height ?? 1) * G;
    if (pos.x < d.x + dw && d.x < pos.x + w && pos.y < d.y + dh && d.y < pos.y + h) return true;
  }
  return false;
}

async function runCore({ targetDoc, sourceDoc, movement, distance, vertical = false, ignoreStability = false }) {
  if (movement === "slide" || vertical) return { status: OP_STATUS.FAILED, reason: "delegateUnavailable" };
  const grid = globalThis.canvas?.grid;
  const square = globalThis.CONST?.GRID_TYPES?.SQUARE ?? 1;
  if (!grid?.size || grid.type !== square) return { status: OP_STATUS.FAILED, reason: "gridUnsupported" };
  const G = grid.size;
  const n = Math.max(0, distance - (ignoreStability ? 0 : stabilityOf(targetDoc.actor)));
  if (!n) return { status: OP_STATUS.SKIPPED, reason: "stabilityResists" };
  const step = straightStep(sourceDoc.object.center, targetDoc.object.center, movement);
  if (!step) return { status: OP_STATUS.SKIPPED, reason: "notMoved" };
  const half = { x: ((targetDoc.width ?? 1) * G) / 2, y: ((targetDoc.height ?? 1) * G) / 2 };
  const startPos = positionOf(targetDoc);
  let cur = { x: startPos.x, y: startPos.y };
  let moved = 0;
  const src = sourceDoc.object.center;
  const dist = p => Math.hypot(p.x - src.x, p.y - src.y);
  for (let i = 0; i < n; i++) {
    const next = { x: cur.x + step.x * G, y: cur.y + step.y * G };
    const from = { x: cur.x + half.x, y: cur.y + half.y };
    const to = { x: next.x + half.x, y: next.y + half.y };
    // Every square of a pull brings it closer to the source, of a push farther away (no overshoot).
    if (movement === "pull" ? dist(to) >= dist(from) : dist(to) <= dist(from)) break;
    // A diagonal step may not cut a wall corner (as Combat Tools, cornerCutsWall): both orthogonal
    // sides must be open too.
    const corner = step.x && step.y && (wallBetween(from, { x: to.x, y: from.y }) || wallBetween(from, { x: from.x, y: to.y }));
    if (corner || wallBetween(from, to) || occupied(targetDoc, next, G)) break;
    cur = next;
    moved++;
  }
  const collisionLeft = n - moved || null;
  if (!moved) return { status: OP_STATUS.SKIPPED, reason: "blocked", collisionLeft };
  const finalPos = { x: cur.x, y: cur.y, elevation: startPos.elevation };
  await moveTokenTo(targetDoc, finalPos);
  return {
    status: OP_STATUS.APPLIED, delegated: "core", movedType: movement, movedDistance: moved,
    moves: [{ tokenUuid: targetDoc.uuid, startPos, finalPos }], startPos, finalPos, collisionLeft, summary: null,
  };
}

/* -------------------------------------------- */
/*  Undo                                        */
/* -------------------------------------------- */

/** Defeated tokens whose Stamina a Combat Tools undo log restores (not those dead before the move). */
function defeatedInLog(undoLog) {
  const out = new Set();
  const scene = globalThis.canvas?.scene;
  for (const entry of undoLog ?? []) {
    if (entry?.op !== "stamina" || entry.wasDeadBefore) continue;
    let actor = null;
    try {
      actor = fromUuidSync(entry.uuid);
    } catch (_err) { /* gone */ }
    const docs = actor?.isToken ? [actor.token] : (scene?.tokens?.filter?.(t => t.actor?.id === actor?.id) ?? []);
    for (const tid of entry.squadTokenIds ?? []) {
      const t = scene?.tokens?.get?.(tid);
      if (t) docs.push(t);
    }
    for (const d of docs) if (d?.uuid && isDead(d.actor)) out.add(d.uuid);
  }
  return [...out];
}

/**
 * Undo a forced movement op. The target goes back where it started unless it moved since (then it
 * stays and `undoMode` is "positionKept"); collision damage, broken walls and ended grabs are restored
 * either way.
 * @returns {Promise<object>} Fields to merge into the op record.
 */
export async function undoForced(op) {
  // Teleports and our own straight line record positions only (Combat Tools' teleport keeps no log).
  if (op.kind !== "forced" || op.delegated !== "dsct") return undoMoves(op);
  const lib = ctlib();
  if (typeof lib?.replayUndo !== "function") return { status: OP_STATUS.FAILED, reason: "delegateUnavailable" };
  const log = Array.isArray(op.undoLog) ? op.undoLog : [];
  const posEntry = log.find(e => e?.op === "update" && e.data && "x" in e.data);
  const targetDoc = posEntry ? fromUuidSync(posEntry.uuid) : null;
  const moved = !!targetDoc && !!op.finalPos && !samePosition(positionOf(targetDoc), op.finalPos);
  const { entries, delta } = deltaStaminaEntries(moved ? log.filter(e => e !== posEntry) : log, op.staminaAfter);
  // Only creatures whose Stamina the move itself changed (collision damage) are revived.
  const revive = setting("reviveOnUndo") ? defeatedInLog(entries) : [];
  for (const uuid of revive) announcePendingRevival(uuid);
  await lib.replayUndo(entries);
  if (revive.length) {
    try {
      await reviveTokens(revive);
    } catch (err) {
      console.warn("stef-ds-automation | revive failed", err);
    }
  }
  // A creature that stays where it was pushed is no longer next to its grabber.
  const grabsLost = moved ? (op.grabsEnded?.length ?? 0) : await restoreGrabs(op.grabsEnded);
  return {
    status: OP_STATUS.UNDONE, undoMode: moved ? "positionKept" : (delta ? "delta" : null),
    revivalPending: revive.some(u => isDead(fromUuidSync(u)?.actor)) || null, grabsLost: grabsLost || null,
  };
}

/**
 * Grabs the move ended, given back through Combat Tools with each grabber's number of grabs (as its own
 * undo does, forced-movement-undo.mjs:8-19). Returns how many could not be restored.
 */
async function restoreGrabs(grabs) {
  if (!grabs?.length) return 0;
  const api = dsctApi();
  const perGrabber = new Map();
  for (const { grabberTokenId } of grabs) perGrabber.set(grabberTokenId, (perGrabber.get(grabberTokenId) ?? 0) + 1);
  let lost = 0;
  for (const { grabberTokenId, grabbedTokenId } of grabs) {
    const grabber = globalThis.canvas?.tokens?.get?.(grabberTokenId);
    const grabbed = globalThis.canvas?.tokens?.get?.(grabbedTokenId);
    if (!grabber || !grabbed || typeof api?.grab !== "function") {
      lost++;
      continue;
    }
    try {
      await api.grab(grabber, grabbed, { forceApply: true, maxGrabs: perGrabber.get(grabberTokenId) ?? 1 });
    } catch (_err) {
      lost++;
    }
  }
  return lost;
}

/** Undo plain moves (our straight line, teleports): back to the start if still where we left it. */
export async function undoMoves(op) {
  let kept = 0;
  for (const m of op.moves ?? []) {
    const doc = fromUuidSync(m.tokenUuid);
    if (!doc) {
      kept++;
      continue;
    }
    if (!samePosition(positionOf(doc), m.finalPos)) {
      kept++;
      continue;
    }
    await moveTokenTo(doc, m.startPos);
  }
  if (!op.moves?.length) return { status: OP_STATUS.FAILED, reason: "targetMissing" };
  return { status: OP_STATUS.UNDONE, undoMode: kept ? "positionKept" : null };
}
