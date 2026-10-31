/**
 * Milestone 7 (docs/M7-DESIGN.md §1.5, §2.1 WP-B, §3.10.3, §3.10.11): op kind "zone" on the active GM.
 *
 * `applyZoneOp` runs inside the card lock (engine applyOpList, summon phase) and never throws: every failure is a row
 * reason. It creates **our own region** on the creator token's scene (never `canvas.scene`):
 * - no `flags.draw-steel.abilitySource` (CH1): Combat Tools' template sweep and placeRegion wrapper and Target
 *   Damage's AoE retargeting never look at it; our flag `flags["stef-ds-automation"].zone` (§1.6) instead;
 * - the behavior `stef-ds-automation.zone` inline (behaviors need a GM anyway), its values from the GM-signed row only;
 * - OBSERVER for the creator's non-GM owners (they see it; only the Director moves, reshapes or edits it, C9);
 * - burst / aura: an emanation around the creator built here at once (aura attached to the token, sharing its level
 *   and hidden state); wall / cube / line: the shapes the clicking client placed (`clientZone`, shapes only, already
 *   shape-validated by the relay), re-checked here: count, wall connectivity (R15), range from the creator's
 *   footprint, inside the scene. Sizes never come from the client. Without shapes the row stays pending.
 * Creating the region with its behavior fires `tokenEnter` (movement null) for creatures already inside; we never
 * subscribe to it, so placing the area on creatures hurts nobody until they move or start a turn (Q7).
 *
 * Undo ends the zone with reason undo and no card annotation (it would wait for this very lock, §6.1).
 *
 * i18n keys used here (reasons, §5.2): DSAUTO.Reason.noZoneType, noCreatorToken, noScene, badZonePlace, tooFar,
 * outsideArea, gridUnsupported, error, undoError.
 */
import { MODULE_ID, OP_STATUS } from "../constants.mjs";
import { summonerOwnerIds } from "../engine/summon.mjs";
import { error, log } from "../log.mjs";
import { summonerCombat } from "../summons/combat.mjs";
import { gridKind, insideScene, originOf, squaresBetween } from "../summons/squares.mjs";
import * as lifecycle from "../turn/lifecycle.mjs";
import { ZONE_END, endZone, regionOfZone, zoneType } from "./registry.mjs";
import { connected, regionHasPoint, shapeCells, shapeRects, zoneShapes } from "./shapes.mjs";

const OBSERVER = () => globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2;
const NONE = () => globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.NONE ?? 0;
const ALWAYS = () => globalThis.CONST?.REGION_VISIBILITY?.ALWAYS ?? 2;
const INTERNAL = () => ({ [MODULE_ID]: { internal: true } });
const serverNow = () => game.time?.serverTime ?? Date.now();
const finite = v => typeof v === "number" && Number.isFinite(v);

function syncDoc(uuid) {
  if (!uuid) return null;
  try {
    return fromUuidSync(uuid) ?? null;
  } catch (_err) {
    return null;
  }
}

const colorOf = user => {
  const c = user?.color;
  if (!c) return null;
  if (typeof c === "string") return c;
  return c.css ?? (typeof c.toString === "function" ? c.toString() : null);
};

/** M6 arms (summons/registry.mjs buildIndexEntry): activation-aware, with the counter's epoch and combatant. */
function armsOf(ctx) {
  const combat = ctx?.combat ?? null;
  const cb = ctx?.combatant ?? null;
  let act = null;
  try {
    act = combat && cb ? (lifecycle.currentActivation?.(combat.id, cb.id) ?? null) : null;
  } catch (_err) {
    act = null;
  }
  const round = combat?.round ?? null;
  const counter = { open: !!act?.open, epoch: lifecycle.activationEpoch ?? null, combatantId: cb?.id ?? null };
  return {
    armStart: { round, activation: act?.n ?? 0, ...counter },
    armEnd: { round, activation: act ? (act.open ? act.n : act.n + 1) : 0, ...counter },
  };
}

/**
 * Region create data for a zone row and validated shapes (§3.10.3).
 * @param {object} args
 * @param {object} args.op               the zone row
 * @param {object[]} args.shapes         final shape data
 * @param {Scene} args.scene
 * @param {TokenDocument} args.creatorDoc
 * @param {string[]} args.ownerIds       the creator's non-GM owners (OBSERVER)
 * @param {string} args.zoneId
 * @param {ChatMessage} args.message
 * @param {{combat, combatant}|Combat|null} args.combat   summonerCombat's context (or a Combat)
 * @returns {object}
 */
export function zoneRegionData({ op, shapes, scene, creatorDoc, ownerIds = [], zoneId, message, combat = null }) {
  const z = op?.zone ?? {};
  const area = z.area ?? {};
  const ctx = combat && combat.combat !== undefined ? combat : (combat ? { combat, combatant: null } : null);
  const fight = ctx?.combat ?? null;
  const level = creatorDoc?.level ?? creatorDoc?._source?.level ?? null;
  const attached = area.shape === "aura";
  const label = String(op?.label || z.label || "").slice(0, 200) || "Zone";
  const owner = (ownerIds ?? []).map(id => game.users?.get?.(id)).find(Boolean) ?? null;
  const flag = {
    v: 1, zoneId, messageId: message?.id ?? null, opId: op?.opId ?? null, itemUuid: op?.itemUuid ?? null,
    effectId: typeof op?.libEffect === "string" ? op.libEffect : (op?.libEffect?.id ?? null), label,
    creatorActorUuid: op?.creatorActorUuid ?? creatorDoc?.actor?.uuid ?? null, creatorTokenUuid: creatorDoc?.uuid ?? op?.creatorTokenUuid ?? null,
    creatorTokenId: creatorDoc?.id ?? null, sceneId: scene?.id ?? null,
    combatId: fight?.id ?? null, createdRound: fight?.round ?? null, createdAt: serverNow(),
    lasts: [...(z.lasts ?? ["summonerTurnStart"])], upkeep: finite(Number(z.upkeep)) && Number(z.upkeep) > 0 ? Number(z.upkeep) : null,
    upkeptRound: null, ...armsOf(ctx),
  };
  const system = {
    zoneId, triggers: [...(z.events ?? z.zoneEvents ?? ["enter", "turnStart"])], once: z.once ?? "round", onceShared: !!z.onceShared,
    perSquare: !!z.perSquare, amount: Math.max(0, Math.min(500, Math.floor(Number(z.amount) || 0))), damageType: z.damageType ?? "",
    ignoredImmunities: [...(z.ignoredImmunities ?? [])], affects: z.affects ?? "enemies", exceptKeywords: [...(z.exceptKeywords ?? [])],
    exceptMonsters: [...(z.exceptMonsters ?? [])], sourceActorUuid: op?.creatorActorUuid ?? creatorDoc?.actor?.uuid ?? "",
    aoe: !!z.aoe, forcedCounts: z.forcedCounts !== false, label,
    // Milestone 9: "" or a ZONE_TERRAINS value (behavior.mjs _getTerrainEffects).
    terrain: typeof z.terrain === "string" ? z.terrain : "",
  };
  const ownership = { default: NONE() };
  for (const id of ownerIds ?? []) ownership[id] = OBSERVER();
  const data = {
    name: label, color: colorOf(owner) ?? colorOf(game.user) ?? "#d9541f", shapes,
    levels: level ? [level] : [], elevation: { bottom: null, top: null },
    // A restricted region must be in exactly one level (CL/canvas/layers/regions.mjs:716-718).
    restriction: { enabled: !!level, type: "move" },
    visibility: ALWAYS(), highlightMode: "coverage", displayMeasurements: false,
    hidden: attached ? !!creatorDoc?.hidden : false, locked: false, ownership,
    behaviors: [{ type: zoneType(), name: label, system }],
    flags: { [MODULE_ID]: { zone: flag } },
  };
  if (attached && creatorDoc?.id) data.attachment = { token: creatorDoc.id };
  return data;
}

/** Snap a placed shape to the grid (walls: cell centres, cubes: cell corners; lines keep their origin). */
function snapShape(shape, scene) {
  const s = Number(scene?.grid?.size) || 100;
  if (gridKind(scene) !== "square" || shape.type !== "rectangle") return shape;
  const ax = Number(shape.anchorX) || 0;
  const ay = Number(shape.anchorY) || 0;
  if (ax === 0.5 && ay === 0.5) return { ...shape, x: (Math.floor(shape.x / s) + 0.5) * s, y: (Math.floor(shape.y / s) + 0.5) * s };
  if (ax === 0 && ay === 0) return { ...shape, x: Math.round(shape.x / s) * s, y: Math.round(shape.y / s) * s };
  return shape;
}

/** Covered grid squares: the created region's own test where it has one, else our shape geometry. */
function coveredSquares(region, shapes, scene) {
  const cells = shapeCells(shapes, scene);
  if (!region || typeof region.testPoint !== "function") return cells.size;
  const s = Number(scene?.grid?.size) || 100;
  let n = 0;
  const rects = shapeRects(shapes, scene);
  const seen = new Set();
  for (const r of rects) {
    for (let col = r.i0; col < r.i1; col++) {
      for (let row = r.j0; row < r.j1; row++) {
        const key = `${row},${col}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (regionHasPoint(region, { x: (col + 0.5) * s, y: (row + 0.5) * s, elevation: Number(region.elevation?.bottom) || 0 })) n++;
      }
    }
  }
  return n || cells.size;
}

/**
 * Applier of op kind "zone" (engine applyOpList, summon phase, inside the card lock). Never throws its own errors.
 * @param {ChatMessage} message
 * @param {object} res              the record (resLive)
 * @param {object} op
 * @param {object} [options]
 * @param {{shapes: {x, y, rotation}[], level?, elevation?}|null} [options.clientZone]   shapes from the relay
 * @param {string|null} [options.userId]
 * @param {"template"|"seed"|null} [options.adopted]   Milestone 9: the shapes came from the area drawn on use
 *                                  (zones/adopt.mjs), recorded on the applied row as `adopted`
 * @returns {Promise<object>}       patch (§1.5)
 */
export async function applyZoneOp(message, res, op, { clientZone = null, userId = null, adopted = null } = {}) {
  try {
    return await applyZone(message, res, op, { clientZone, userId, adopted });
  } catch (err) {
    error("zones.apply", err, { opId: op?.opId });
    return { status: OP_STATUS.FAILED, reason: "error", error: String(err?.message ?? err) };
  }
}

async function applyZone(message, res, op, { clientZone, adopted = null }) {
  if (!globalThis.CONFIG?.RegionBehavior?.dataModels?.[zoneType()]) return { status: OP_STATUS.FAILED, reason: "noZoneType" };
  const creatorDoc = syncDoc(op.creatorTokenUuid);
  if (!creatorDoc) return { status: OP_STATUS.FAILED, reason: "noCreatorToken" };
  const scene = creatorDoc.parent;   // NEVER canvas.scene
  if (!scene) return { status: OP_STATUS.FAILED, reason: "noScene" };
  if (gridKind(scene) === "hex") return { status: OP_STATUS.FAILED, reason: "gridUnsupported" };
  const area = op.zone?.area ?? null;
  if (!area?.shape) return { status: OP_STATUS.FAILED, reason: "badZonePlace" };
  const base = zoneShapes(area, { scene, creatorDoc });
  if (!base.length) return { status: OP_STATUS.FAILED, reason: "badZonePlace" };

  let shapes;
  if (area.shape === "burst" || area.shape === "aura") shapes = base;
  else {
    const picked = Array.isArray(clientZone?.shapes) ? clientZone.shapes : null;
    if (!picked) return { status: OP_STATUS.PENDING };   // nothing placed: the row waits for its Place button
    const n = picked.length;
    const max = Number(area.count) || base.length;
    if (n < 1 || n > max || n > base.length) return { status: OP_STATUS.FAILED, reason: "badZonePlace" };
    shapes = picked.map((s, i) => {
      const rot = area.shape === "line" && finite(Number(s?.rotation)) ? ((Number(s.rotation) % 360) + 360) % 360 : 0;
      return snapShape({ ...base[i], x: Number(s?.x), y: Number(s?.y), rotation: rot }, scene);
    });
    if (shapes.some(s => !finite(s.x) || !finite(s.y))) return { status: OP_STATUS.FAILED, reason: "badZonePlace" };
    const rects = shapeRects(shapes, scene);
    if (area.shape === "wall" && !connected(rects)) return { status: OP_STATUS.FAILED, reason: "badZonePlace" };
    const origin = originOf(creatorDoc);
    const range = Math.max(0, Number(area.range) || 0);
    for (const r of rects) {
      if (squaresBetween(origin.rect, r) > range) return { status: OP_STATUS.FAILED, reason: "tooFar" };
      if (!insideScene(scene, r)) return { status: OP_STATUS.FAILED, reason: "outsideArea" };
    }
  }

  const ctx = summonerCombat(creatorDoc);   // by combatant, never combat.scene
  const zoneId = foundry.utils.randomID(16);
  const ownerIds = summonerOwnerIds(creatorDoc.actor);
  const data = zoneRegionData({ op, shapes, scene, creatorDoc, ownerIds, zoneId, message, combat: ctx });
  const created = await scene.createEmbeddedDocuments("Region", [data], INTERNAL());
  const region = created?.[0] ?? null;
  if (!region) return { status: OP_STATUS.FAILED, reason: "error", error: "noRegion" };
  const squares = coveredSquares(region, shapes, scene);
  log("zones.create", { zoneId, label: data.name, shape: area.shape, squares, sceneId: scene.id, combatId: ctx?.combat?.id ?? null });
  return {
    status: OP_STATUS.APPLIED, zoneId, regionUuid: region.uuid, sceneId: scene.id, squares,
    combatId: ctx?.combat?.id ?? null, createdRound: ctx?.combat?.round ?? null,
    // Cleared on every apply (RESET_ON_APPLY gains them in M7; written here too, records merge).
    ended: null, undoMode: null,
    // Milestone 9: "template" | "seed" when resolveMessage applied it from the area drawn on use, else null.
    adopted: adopted === "template" || adopted === "seed" ? adopted : null,
  };
}

/** Undo of op kind "zone" (engine/undo.mjs, inside the card lock): endZone(op.zoneId, undo, {annotate: false}). */
export async function undoZoneOp(res, op) {
  if (!op?.zoneId) return { status: OP_STATUS.UNDONE, undoMode: "alreadyGone" };
  try {
    const r = await endZone(op.zoneId, ZONE_END.UNDO, { annotate: false, quiet: true });
    if (r?.error) return { status: OP_STATUS.FAILED, reason: "undoError", error: r.error };
    return { status: OP_STATUS.UNDONE, undoMode: r?.ended ? null : "alreadyGone" };
  } catch (err) {
    error("zones.undo", err, { zoneId: op.zoneId });
    return { status: OP_STATUS.FAILED, reason: "undoError", error: String(err?.message ?? err) };
  }
}

/** A record write failed after zones were created: end them again (fire-and-forget, as cleanupSummons). */
export function cleanupZones(patches) {
  try {
    for (const p of Object.values(patches ?? {})) {
      if (p?.status !== OP_STATUS.APPLIED || typeof p.zoneId !== "string" || !p.regionUuid) continue;
      // The card never recorded it: zoneOf cannot match, so find the region by the patch's own uuid.
      const region = regionOfZone(p.zoneId);
      if (!region) continue;
      endZone(p.zoneId, ZONE_END.UNDO, { annotate: false, quiet: true }).catch(err => error("zones.cleanup", err));
    }
  } catch (err) {
    error("zones.cleanup", err);
  }
}
