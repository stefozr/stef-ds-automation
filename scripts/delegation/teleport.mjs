/**
 * Teleport one creature, on the active GM, and the token-move helpers forced movement shares.
 *
 * - A given destination: the token is placed there directly (a "displace" move: no ruler, no movement
 *   cost, like ctlib's teleport writes, ctlib helpers.mjs:912-918).
 * - No destination: Draw Steel: Combat Tools lets the Director pick the square on the canvas
 *   (`api.teleport({distance, sourceId, targetId, mode, animate})`, teleport.mjs:456-473; modes
 *   "normal", "swap" with a partner, "adjacent" to a partner). It returns nothing, so the positions
 *   before and after are compared to record what moved.
 * Undo puts every moved token back unless it moved again since (forced-movement.mjs undoMoves).
 */
import { MODULE_ID, OP_STATUS } from "../constants.mjs";
import { dsctApi, dsctActive } from "../compat/dsct.mjs";

export const TELEPORT_MODES = Object.freeze(["normal", "swap", "adjacent"]);

export function positionOf(doc) {
  return { x: Number(doc?.x ?? 0), y: Number(doc?.y ?? 0), elevation: Number(doc?.elevation ?? 0) };
}

export function samePosition(a, b) {
  return !!a && !!b && a.x === b.x && a.y === b.y && (a.elevation ?? 0) === (b.elevation ?? 0);
}

/**
 * Place a token without walking it there (core "displace" movement action). Our marker in the update
 * options reaches `_preUpdateMovement` as `operation`: the Milestone 5 movement gate never holds our moves.
 */
export async function moveTokenTo(doc, pos) {
  const data = { x: pos.x, y: pos.y };
  const waypoint = { x: pos.x, y: pos.y, action: "displace" };
  if (pos.elevation != null && pos.elevation !== (doc.elevation ?? 0)) {
    data.elevation = pos.elevation;
    waypoint.elevation = pos.elevation;
  }
  return doc.update(data, { movement: { [doc.id]: { waypoints: [waypoint] } }, [MODULE_ID]: { internal: true } });
}

/**
 * 0.13.0: Combat Tools posts its own "X teleported N squares" message for every teleport it runs. When we drove the
 * teleport, the message is tagged on creation (ui/teleport-message-fold.mjs) and folded to one line: our row's Undo
 * puts the token back. An expectation per token lives only around our awaited `api.teleport` call (Combat Tools
 * creates the message inside it, on this client); a cancelled picker posts nothing and the `finally` clears it.
 */
const EXPECT_TTL_MS = 310_000;
const expected = new Map();   // tokenId -> {cardId, opId, sceneId, at}

/** @returns {() => void} clears this expectation only (a newer one for the same token stays). */
export function expectTeleportMessage({ tokenId, sceneId = null, cardId = null, opId = null }, now = Date.now(), map = expected) {
  const entry = { cardId, opId, sceneId, at: now };
  map.set(tokenId, entry);
  return () => { if (map.get(tokenId) === entry) map.delete(tokenId); };
}

/** Pure: the expectation a Combat Tools teleport message's flags satisfy (consumed once), else null. */
export function matchTeleportExpectation(dsctFlags, map = expected, now = Date.now()) {
  if (dsctFlags?.isTpUndo !== true || !dsctFlags.targetTokenId) return null;
  const e = map.get(dsctFlags.targetTokenId);
  if (!e || now - e.at > EXPECT_TTL_MS) return null;
  if (e.sceneId && dsctFlags.targetSceneId && e.sceneId !== dsctFlags.targetSceneId) return null;
  map.delete(dsctFlags.targetTokenId);
  return { card: e.cardId ?? null, opId: e.opId ?? null };
}

/** Every call of Combat Tools' teleport API from this module goes through here. */
export async function dsctTeleport(api, { tokenDoc, partnerDoc = null, distance, mode = "normal", animate = true, cardId = null, opId = null }) {
  const clear = expectTeleportMessage({ tokenId: tokenDoc.id, sceneId: tokenDoc.parent?.id ?? null, cardId, opId });
  try {
    return await api.teleport({ distance, sourceId: tokenDoc.id, targetId: partnerDoc?.id ?? null, mode, animate });
  } finally {
    clear();
  }
}

function onCanvas(doc) {
  const scene = globalThis.canvas?.scene;
  return !!doc?.object && !!scene && doc.parent?.id === scene.id;
}

/**
 * @param {object} spec
 * @param {TokenDocument} spec.tokenDoc          Who teleports.
 * @param {number} [spec.distance]               Squares (Combat Tools pick).
 * @param {"normal"|"swap"|"adjacent"} [spec.mode]
 * @param {TokenDocument} [spec.partnerDoc]      Swap / adjacent partner.
 * @param {{x: number, y: number, elevation?: number}} [spec.destination]
 * @param {boolean} [spec.animate]
 * @param {string} [spec.cardId]                 The card (folds Combat Tools' teleport message).
 * @param {string} [spec.opId]
 * @returns {Promise<object>} Fields to merge into the op record.
 */
export async function runTeleport({ tokenDoc, distance = 5, mode = "normal", partnerDoc = null, destination = null, animate = true, cardId = null, opId = null }) {
  if (!tokenDoc?.actor) return { status: OP_STATUS.FAILED, reason: "targetMissing" };
  if (destination) {
    const startPos = positionOf(tokenDoc);
    const finalPos = { x: Number(destination.x), y: Number(destination.y), elevation: Number(destination.elevation ?? startPos.elevation) };
    if (![finalPos.x, finalPos.y, finalPos.elevation].every(Number.isFinite)) return { status: OP_STATUS.FAILED, reason: "badDestination" };
    if (samePosition(startPos, finalPos)) return { status: OP_STATUS.SKIPPED, reason: "notMoved" };
    await moveTokenTo(tokenDoc, finalPos);
    return { status: OP_STATUS.APPLIED, delegated: "core", moves: [{ tokenUuid: tokenDoc.uuid, startPos, finalPos }] };
  }
  const api = dsctApi();
  if (!dsctActive() || typeof api?.teleport !== "function") return { status: OP_STATUS.FAILED, reason: "delegateUnavailable" };
  if (!onCanvas(tokenDoc) || (partnerDoc && !onCanvas(partnerDoc))) return { status: OP_STATUS.FAILED, reason: "notOnCanvas" };
  if (mode !== "normal" && !partnerDoc) return { status: OP_STATUS.FAILED, reason: "partnerMissing" };
  const docs = [tokenDoc, partnerDoc].filter(Boolean);
  const before = docs.map(positionOf);
  await dsctTeleport(api, { tokenDoc, partnerDoc, distance, mode, animate, cardId, opId });
  const moves = [];
  docs.forEach((doc, i) => {
    const finalPos = positionOf(doc);
    if (!samePosition(before[i], finalPos)) moves.push({ tokenUuid: doc.uuid, startPos: before[i], finalPos });
  });
  if (!moves.length) return { status: OP_STATUS.SKIPPED, reason: "notMoved" };
  return { status: OP_STATUS.APPLIED, delegated: "dsct", moves };
}
