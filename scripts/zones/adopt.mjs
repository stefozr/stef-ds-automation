/**
 * Milestone 9 (docs/M9-DESIGN.md §B, D-B1-D-B4): zone rows applied at resolve time from the area drawn on use, on the
 * active GM inside the card lock (engine resolveMessage).
 *
 * With `zoneMode` auto, a wall / cube / line row whose ability placed its area on use needs no Place click: the GM
 * copies the drawn area into our own zone region (D-B1: copy, never adopt the system region) and deletes the system
 * template afterwards. Shape sources, in order (D-B3):
 *   1. the live template (`cardTemplate` on the creator's scene, read here: authoritative), the seed's region first;
 *   2. the author's seed `res.areaTemplate` (engine/seed.mjs: Combat Tools deletes the template 5 s after creation,
 *      the card may resolve later): positions only, same item and scene, `validZonePlaces` limits, and only when the
 *      author could have clicked Place on that row (`mayAct(author, ..., "apply")`).
 * Sizes always come from the GM's row: `fitPlace` centres a larger cube on the drawn one (strained Incinerate), keeps
 * a line's origin and rotation, slices walls to `count` (D-B4). applyZone then re-checks everything as for a Place
 * click (count, connectivity, range, inside the scene, snap); a refusal leaves the row failed with Place working.
 *
 * No i18n keys here (the row detail reads `adopted`: DSAUTO.Card.ZoneAdopted in parts/view.mjs).
 */
import { MODULE_ID, OP_STATUS } from "../constants.mjs";
import { error, log } from "../log.mjs";
import { validZonePlaces } from "../relay/queries.mjs";
import { mayAct } from "../relay/auth.mjs";
import { distancePixels } from "./shapes.mjs";
import { cardTemplate, levelOf, plain, zonePlace } from "./place.mjs";

/** Shape types of the drawn areas we copy (the system's ds.CONFIG.abilities.distances[type].area). */
const COPIED = new Set(["wall", "cube", "line"]);
/** A seeded cube larger than this many squares is not believed (MAX_ZONE_SQUARES). */
const MAX_DRAWN = 30;
const finite = v => typeof v === "number" && Number.isFinite(v);

function lookup(uuid) {
  if (!uuid) return null;
  try {
    return fromUuidSync(uuid) ?? null;
  } catch (_err) {
    return null;
  }
}

function serverAuthor(message) {
  const id = message?._source?.author ?? message?.author?.id ?? null;
  return (id && game.users?.get?.(id)) || message?.author || null;
}

/**
 * The `zonePlaces` entry of a row from drawn shapes, sizes from the row (D-B4). Null when nothing usable is left.
 * @param {object} op                     the zone row (op.zone.area: GM-built shape, size, count)
 * @param {object[]} drawn                plain drawn shapes: {x, y, rotation, width?, height?, anchorX?, anchorY?}
 * @param {object} options
 * @param {Scene} options.scene           the creator's scene
 * @param {string|null} options.level
 * @param {number} options.elevation
 * @param {{x: number, y: number}[]} [options.points]  the card's target token centres (live fix 0.14.1: a cube drawn
 *                                         half a square off the grid is put on the grid position covering most of them)
 * @returns {{shapes: {x, y, rotation}[], level: string|null, elevation: number}|null}
 */
export function fitPlace(op, drawn, { scene, level = null, elevation = 0, points = [] } = {}) {
  const area = op?.zone?.area ?? null;
  if (!area || !COPIED.has(area.shape) || !Array.isArray(drawn) || !drawn.length) return null;
  if (area.shape === "wall") {
    const count = Math.max(1, Number(area.count ?? area.size) || 1);
    return zonePlace(drawn.slice(0, count), level, elevation);
  }
  const s = drawn[0];
  if (area.shape === "line") return zonePlace([{ x: s.x, y: s.y, rotation: s.rotation ?? 0 }], level, elevation);
  // Cube: our shape is anchored at its top-left corner; a larger (or smaller) cube is centred on the drawn one.
  const dp = distancePixels(scene) || 100;
  const w = Number(s.width);
  const h = Number(s.height);
  const left = Number(s.x) - (finite(w) ? w : 0) * (Number(s.anchorX) || 0);
  const top = Number(s.y) - (finite(h) ? h : 0) * (Number(s.anchorY) || 0);
  const drawnSize = finite(w) && w > 0 ? Math.min(MAX_DRAWN, Math.max(1, Math.round(w / dp))) : null;
  const size = Math.max(1, Number(area.size) || 1);
  const shift = drawnSize ? Math.floor((size - drawnSize) / 2) * dp : 0;
  const gx = gridAligned(left - shift, top - shift, size * dp, dp, points);
  return zonePlace([{ x: gx.x, y: gx.y, rotation: 0 }], level, elevation);
}

/**
 * Live fix 0.14.1: Draw Steel's cube preview may snap to an edge midpoint, so a drawn cube can sit half a square off
 * the grid (its targets were counted on the edge). Our zone is grid-based: per axis, the lower or the upper grid line,
 * whichever covers more target centres (ties: the nearest line, as the region snap would round).
 */
function gridAligned(left, top, span, dp, points) {
  const pts = (points ?? []).filter(p => finite(p?.x) && finite(p?.y));
  const options = v => {
    const lo = Math.floor(v / dp + 1e-6) * dp;
    return Math.abs(v - lo) < 1e-6 ? [lo] : [Math.round(v / dp) * dp, ...(Math.round(v / dp) * dp === lo ? [lo + dp] : [lo])];
  };
  let best = null;
  for (const x of options(left)) {
    for (const y of options(top)) {
      const covered = pts.filter(p => p.x > x && p.x < x + span && p.y > y && p.y < y + span).length;
      if (!best || covered > best.covered) best = { x, y, covered };
    }
  }
  return best ?? { x: left, y: top };
}

/** Centres of the card's target tokens on this scene (for gridAligned). */
function targetCentres(res, scene) {
  const out = [];
  const G = Number(scene?.grid?.size) || 100;
  for (const t of Object.values(res?.targets ?? {}).slice(0, 60)) {
    try {
      const doc = t?.tokenUuid ? fromUuidSync(t.tokenUuid) : null;
      if (!doc || doc.parent?.id !== scene?.id) continue;
      out.push({ x: Number(doc.x) + (Number(doc.width) || 1) * G / 2, y: Number(doc.y) + (Number(doc.height) || 1) * G / 2 });
    } catch (_err) { /* gone */ }
  }
  return out;
}

/** Drawn shapes of a live template (plain data with sizes and anchors), or null. */
function templateShapes(region) {
  const shapes = [...(region?.shapes ?? [])].map(plain);
  return shapes.length ? shapes : null;
}

/**
 * Drawn shapes of the author's seed for this row, or null when it does not qualify (D-B3): same item and scene,
 * the relay's `zonePlaces` limits, and an author who may apply the row.
 */
function seedShapes(message, res, op, scene) {
  const seed = res?.areaTemplate;
  if (!seed || typeof seed !== "object" || seed.v !== 1) return null;
  if (seed.itemUuid !== op.itemUuid || !scene?.id || seed.sceneId !== scene.id) return null;
  const place = seed.place;
  if (!validZonePlaces({ [op.opId]: place }, [op.opId])) return null;
  const author = serverAuthor(message);
  if (!author || !mayAct(author, message, res, op, "apply")) return null;
  const sizes = Array.isArray(seed.shapeSizes) ? seed.shapeSizes : [];
  return {
    level: place.level ?? null,
    elevation: finite(place.elevation) ? place.elevation : 0,
    shapes: place.shapes.map((p, i) => {
      const z = sizes[i] && typeof sizes[i] === "object" ? sizes[i] : {};
      const num = v => (finite(v) && Math.abs(v) <= 1e6 ? v : undefined);
      return { x: p.x, y: p.y, rotation: p.rotation ?? 0, width: num(z.width), height: num(z.height), anchorX: num(z.anchorX), anchorY: num(z.anchorY) };
    }),
  };
}

/**
 * The drawn areas of a resolve's pending auto zone rows (interactive: wall / cube / line). Never throws.
 * @param {ChatMessage} message
 * @param {object} res                    the record with the GM's identity (sourceActorUuid) and the seed fields
 * @param {object[]} zoneOps              pending auto zone rows
 * @returns {{clientZones: Object<string, object>, adopted: Object<string, {source, regionUuid, sceneId}>}}
 */
export function adoptZoneTemplates(message, res, zoneOps) {
  const clientZones = {};
  const adopted = {};
  for (const op of zoneOps ?? []) {
    try {
      if (op?.kind !== "zone" || op.interactive === false) continue;
      const area = op.zone?.area ?? null;
      if (!area || !COPIED.has(area.shape)) continue;
      const creatorDoc = lookup(op.creatorTokenUuid);
      const scene = creatorDoc?.parent ?? null;
      if (!scene) continue;
      const seed = res?.areaTemplate ?? null;
      const preferId = typeof seed?.regionUuid === "string" ? seed.regionUuid.split(".").at(-1) : null;
      const tpl = cardTemplate(scene, op, message, area, { preferId });
      let source = null;
      let drawn = null;
      let level = null;
      let elevation = Number(creatorDoc.elevation) || 0;
      if (tpl) {
        drawn = templateShapes(tpl);
        level = levelOf(tpl) ?? creatorDoc.level ?? null;
        source = "template";
      } else {
        const s = seedShapes(message, res, op, scene);
        if (s) {
          drawn = s.shapes;
          level = s.level ?? creatorDoc.level ?? null;
          elevation = s.elevation;
          source = "seed";
        }
      }
      if (!drawn) continue;
      const place = fitPlace(op, drawn, { scene, level, elevation, points: targetCentres(res, scene) });
      if (!place) continue;
      clientZones[op.opId] = place;
      adopted[op.opId] = { source, regionUuid: tpl?.uuid ?? null, sceneId: scene.id };
      log("zones.adopt", { messageId: message?.id ?? null, opId: op.opId, source, shapes: place.shapes.length });
    } catch (err) {
      error("zones.adopt", err, { opId: op?.opId });
    }
  }
  return { clientZones, adopted };
}

/**
 * After the record write: delete the system templates whose area became a zone (D-B1). Fire-and-forget, never
 * throws; the option marks the deletion as ours (zones/registry.mjs onRegionDeleted ignores regions without our
 * flag anyway; Combat Tools clears its own sweep timer on delete).
 * @param {Object<string, {source, regionUuid}>} adopted
 * @param {Object<string, object>} patches   the apply's patches (only applied rows count)
 */
export function deleteAdoptedTemplates(adopted, patches) {
  try {
    const byScene = new Map();
    for (const [opId, a] of Object.entries(adopted ?? {})) {
      if (a?.source !== "template" || !a.regionUuid || patches?.[opId]?.status !== OP_STATUS.APPLIED) continue;
      const region = lookup(a.regionUuid);
      const scene = region?.parent;
      if (!scene || region.flags?.[MODULE_ID]?.zone) continue;   // never one of our zones
      if (!byScene.has(scene)) byScene.set(scene, new Set());
      byScene.get(scene).add(region.id);
    }
    for (const [scene, ids] of byScene) {
      const live = [...ids].filter(id => scene.regions?.get?.(id));
      if (!live.length) continue;
      // 0.16.0: Combat Tools' template lifetime may delete the region first (its 5 s sweep): not an error.
      Promise.resolve(scene.deleteEmbeddedDocuments("Region", live, { [MODULE_ID]: { internal: true, adoptedTemplate: true } }))
        .catch(err => (/does not exist/i.test(String(err?.message ?? err)) ? null : error("zones.adoptDelete", err)));
    }
  } catch (err) {
    error("zones.adoptDelete", err);
  }
}
