/**
 * Milestone 7 (docs/M7-DESIGN.md §2.1 WP-B, §3.10.1-§3.10.4): the geometry of zones. Pure given a scene: the owner's
 * placement (WP-C `zones/place.mjs`) and the active GM's creation and movement tallies both use it, always against
 * the document's own scene (`region.parent`, `token.parent`), never `canvas.grid` / `canvas.scene` (the active GM may
 * view another scene or none; the M6 rule of summons/squares.mjs).
 *
 * Two cell conventions meet here, on purpose kept apart:
 * - **Rectangles** (`shapeRects`, `connected`) use summons/squares.mjs: `{i0, j0, i1, j1}`, i = COLUMN, j = ROW, end
 *   exclusive, so `squaresBetween`, `originOf` and `insideScene` work on them unchanged.
 * - **Offset keys** (`footprintSquares`, `pathSquares`) are Foundry grid offsets `"i,j"` with i = ROW, j = COLUMN
 *   (common/grid/square.mjs getOffset). They are only counted, never compared with rectangles.
 *
 * Verified in Foundry v14.368 (2026-10-07) and recorded here, as §3.10.4 asks:
 * - Movement operation fields `id`, `origin`, `passed.waypoints`, `pending.waypoints` (client/documents/_types.mjs
 *   491-520); a waypoint carries `x, y, elevation, width, height, shape, level, action`.
 * - `RegionDocument#testPoint(point)` = elevation test + `polygonTree.testPoint` (client/documents/region.mjs:228): no
 *   canvas needed. It does not test levels; `includedInLevel` does (used when present).
 * - DIFFERENCE: `TokenDocument#getOccupiedGridSpaceOffsets` (client/documents/token.mjs:1419) builds a
 *   `ClockwiseSweepPolygon` from `level.edges` whenever the scene has a level, i.e. it reads the edges prepared for the
 *   VIEWED canvas. It is therefore not used; the footprint is computed here from the snapped top-left and the token's
 *   width / height in squares (the square-grid branch of that method, without its wall test).
 * - Shape data (common/data/data.mjs): rectangle `{x, y, width, height, anchorX, anchorY, rotation, gridBased}`, line
 *   `{x, y, length, width, rotation}` (width centred on the axis), emanation `{base, radius}` with a token base
 *   `{type: "token", x, y, width, height, shape}` (x / y integers, width / height in grid spaces). gridBased shapes keep
 *   their pixel size on Draw Steel scenes (grid distance 1, so distancePixels = grid.size).
 * - The system's areas (DSM:6596-6640, 23104-23165): wall = `count` 1x1 rectangles with anchor 0.5, cube = rectangle
 *   primary x primary (anchor 0), line = length primary / width secondary, aura / burst = emanation radius primary
 *   around the token base (`hole: true`).
 *
 * Everything returns quietly (null, [], empty Set, false) when the scene lacks what it reads (harness mocks).
 */
import * as schema from "../library/schema.mjs";
import { squaresBetween } from "../summons/squares.mjs";

const SHAPES = ["wall", "cube", "line", "burst", "aura"];
const EPS = 1e-6;
const maxSquares = () => schema.MAX_ZONE_SQUARES ?? 30;

const finite = v => typeof v === "number" && Number.isFinite(v);
const cellSize = scene => Number(scene?.grid?.size) || 100;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Pixels per distance unit of a scene (scene.dimensions.distancePixels, else grid.size / grid.distance). */
export function distancePixels(scene) {
  const dp = Number(scene?.dimensions?.distancePixels);
  if (dp > 0) return dp;
  const size = cellSize(scene);
  const dist = Number(scene?.grid?.distance) || 1;
  return size / dist;
}

/* -------------------------------------------- */
/*  Plan time                                   */
/* -------------------------------------------- */

/** An evaluated integer or null (numbers pass straight through; formulas go to `evaluate`). */
function evalInt(value, evaluate) {
  if (value === undefined || value === null || value === "") return null;
  let n = null;
  if (typeof value === "number") n = value;
  else {
    try {
      n = typeof evaluate === "function" ? evaluate(value) : Number(value);
    } catch (_err) {
      n = null;
    }
  }
  if (n === null || n === undefined || n === "" || typeof n === "boolean") return null;
  n = Number(n);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

/**
 * The area of a zone row (§3.10.1). `null` when the shape is "ability" and the ability has no area distance (the
 * caller's `failed noArea`); an area whose `size`, `width` or `range` is null had a formula that did not evaluate
 * (the caller's `failed formulaInvalid`).
 * @param {Item} item                        the ability (its `system.distance`)
 * @param {object} eff                       the zone effect (absent fields: ZONE_DEFAULTS)
 * @param {(formula) => number|null} evaluate
 * @returns {{shape, size, width, count, range}|null}
 */
export function zoneArea(item, eff, evaluate) {
  const d = item?.system?.distance ?? {};
  let shape = eff?.shape ?? "ability";
  if (shape === "ability") shape = SHAPES.includes(d.type) ? d.type : null;
  if (!shape || !SHAPES.includes(shape)) return null;
  const rawSize = evalInt(eff?.size ?? d.primary, evaluate);
  const rawWidth = shape === "line" ? evalInt(eff?.width ?? d.secondary, evaluate) : 1;
  let rawRange;
  if (eff?.range !== undefined && eff?.range !== null && eff?.range !== "") rawRange = evalInt(eff.range, evaluate);
  else {
    const fallback = { wall: d.secondary, cube: d.secondary, line: d.tertiary }[shape];
    rawRange = fallback !== undefined && fallback !== null && fallback !== "" ? evalInt(fallback, evaluate) : 0;
  }
  const size = rawSize === null ? null : clamp(rawSize, 1, maxSquares());
  const width = rawWidth === null ? null : clamp(rawWidth, 1, 10);
  const range = rawRange === null ? null : clamp(rawRange, 0, 100);
  return { shape, size, width, count: shape === "wall" ? size : 1, range };
}

/* -------------------------------------------- */
/*  Region shape data                           */
/* -------------------------------------------- */

/**
 * Region shape data for an area, mirroring the system's placeTemplate (DSM:6596-6640). x / y are 0 (the placement or
 * the GM sets them); an emanation's token base sits on the creator's current position.
 * @returns {object[]}
 */
export function zoneShapes(area, { scene, creatorDoc } = {}) {
  if (!area?.shape) return [];
  const dp = distancePixels(scene);
  const size = Math.max(1, Number(area.size) || 1);
  switch (area.shape) {
    case "wall": {
      const n = clamp(Math.floor(Number(area.count ?? area.size) || 1), 1, maxSquares());
      return Array.from({ length: n }, () => ({
        type: "rectangle", gridBased: true, x: 0, y: 0, width: dp, height: dp, anchorX: 0.5, anchorY: 0.5, rotation: 0,
      }));
    }
    case "cube":
      return [{ type: "rectangle", gridBased: true, x: 0, y: 0, width: size * dp, height: size * dp, anchorX: 0, anchorY: 0, rotation: 0 }];
    case "line":
      return [{ type: "line", gridBased: true, x: 0, y: 0, length: size * dp, width: Math.max(1, Number(area.width) || 1) * dp, rotation: 0 }];
    case "burst":
    case "aura": {
      const src = creatorDoc?._source ?? creatorDoc ?? {};
      const base = {
        type: "token", hole: true,
        x: Math.round(Number(src.x ?? creatorDoc?.x) || 0), y: Math.round(Number(src.y ?? creatorDoc?.y) || 0),
        width: Math.max(0.5, Number(src.width ?? creatorDoc?.width) || 1), height: Math.max(0.5, Number(src.height ?? creatorDoc?.height) || 1),
      };
      const shape = src.shape ?? creatorDoc?.shape;
      if (shape !== undefined && shape !== null) base.shape = shape;
      return [{ type: "emanation", gridBased: true, radius: size * dp, base }];
    }
    default:
      return [];
  }
}

/** The pixel bounds {x0, y0, x1, y1} of one shape (rotations included), or null. */
function shapeBounds(shape, scene) {
  if (!shape || typeof shape !== "object") return null;
  const s = cellSize(scene);
  const x = Number(shape.x) || 0;
  const y = Number(shape.y) || 0;
  const corners = pts => {
    const xs = pts.map(p => p[0]);
    const ys = pts.map(p => p[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  };
  const rotate = (px, py, ox, oy, deg) => {
    const r = ((Number(deg) || 0) * Math.PI) / 180;
    if (!r) return [px, py];
    const c = Math.cos(r);
    const n = Math.sin(r);
    return [ox + (px - ox) * c - (py - oy) * n, oy + (px - ox) * n + (py - oy) * c];
  };
  switch (shape.type) {
    case "rectangle": {
      const w = Math.max(0, Number(shape.width) || 0);
      const h = Math.max(0, Number(shape.height) || 0);
      const left = x - w * (Number(shape.anchorX) || 0);
      const top = y - h * (Number(shape.anchorY) || 0);
      return corners([[left, top], [left + w, top], [left + w, top + h], [left, top + h]].map(([px, py]) => rotate(px, py, x, y, shape.rotation)));
    }
    case "line": {
      const len = Math.max(0, Number(shape.length) || 0);
      const half = Math.max(0, Number(shape.width) || 0) / 2;
      return corners([[x, y - half], [x + len, y - half], [x + len, y + half], [x, y + half]].map(([px, py]) => rotate(px, py, x, y, shape.rotation)));
    }
    case "emanation": {
      const r = Math.max(0, Number(shape.radius) || 0);
      const b = shape.base ?? {};
      let inner;
      if (b.type === "token") {
        inner = { x0: Number(b.x) || 0, y0: Number(b.y) || 0, x1: (Number(b.x) || 0) + (Number(b.width) || 1) * s, y1: (Number(b.y) || 0) + (Number(b.height) || 1) * s };
      } else inner = shapeBounds(b, scene) ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
      return { x0: inner.x0 - r, y0: inner.y0 - r, x1: inner.x1 + r, y1: inner.y1 + r };
    }
    case "circle":
    case "cone":
    case "ring": {
      const r = Math.max(0, Number(shape.radius ?? shape.outerRadius) || 0);
      return { x0: x - r, y0: y - r, x1: x + r, y1: y + r };
    }
    case "ellipse": {
      const rx = Math.max(0, Number(shape.radiusX) || 0);
      const ry = Math.max(0, Number(shape.radiusY) || 0);
      const r = Math.max(rx, ry);
      return { x0: x - r, y0: y - r, x1: x + r, y1: y + r };
    }
    case "polygon": {
      const p = Array.isArray(shape.points) ? shape.points.map(Number) : [];
      if (p.length < 4) return null;
      const pts = [];
      for (let k = 0; k + 1 < p.length; k += 2) pts.push([p[k], p[k + 1]]);
      return corners(pts);
    }
    default:
      return null;
  }
}

/** Grid rectangles {i0, j0, i1, j1} (i = column, j = row, end exclusive) each shape covers: its bounds, in cells. */
export function shapeRects(shapes, scene) {
  const s = cellSize(scene);
  const out = [];
  for (const shape of shapes ?? []) {
    const b = shapeBounds(shape, scene);
    if (!b) continue;
    const i0 = Math.floor(b.x0 / s + EPS);
    const j0 = Math.floor(b.y0 / s + EPS);
    const i1 = Math.max(i0 + 1, Math.ceil(b.x1 / s - EPS));
    const j1 = Math.max(j0 + 1, Math.ceil(b.y1 / s - EPS));
    out.push({ i0, j0, i1, j1 });
  }
  return out;
}

/** Are these rectangles one connected group, side or corner adjacent (overlap counts)? Empty: true. */
export function connected(rects) {
  const list = (rects ?? []).filter(Boolean);
  if (list.length <= 1) return true;
  const seen = new Set([0]);
  const stack = [0];
  while (stack.length) {
    const a = list[stack.pop()];
    for (let k = 0; k < list.length; k++) {
      if (seen.has(k)) continue;
      if (squaresBetween(a, list[k]) <= 1) {
        seen.add(k);
        stack.push(k);
      }
    }
  }
  return seen.size === list.length;
}

/* -------------------------------------------- */
/*  Point tests                                 */
/* -------------------------------------------- */

/** Is a point inside one shape (our own geometry: the fallback when a region has no polygon tree)? */
function insideShape(shape, point, scene) {
  if (!shape || shape.hole) return false;
  const s = cellSize(scene);
  const px = Number(point.x);
  const py = Number(point.y);
  const x = Number(shape.x) || 0;
  const y = Number(shape.y) || 0;
  // Into the shape's own frame (rotation around its origin).
  const local = () => {
    const r = (-(Number(shape.rotation) || 0) * Math.PI) / 180;
    const c = Math.cos(r);
    const n = Math.sin(r);
    return [x + (px - x) * c - (py - y) * n, y + (px - x) * n + (py - y) * c];
  };
  switch (shape.type) {
    case "rectangle": {
      const [lx, ly] = local();
      const w = Number(shape.width) || 0;
      const h = Number(shape.height) || 0;
      const left = x - w * (Number(shape.anchorX) || 0);
      const top = y - h * (Number(shape.anchorY) || 0);
      return lx >= left - EPS && lx <= left + w + EPS && ly >= top - EPS && ly <= top + h + EPS;
    }
    case "line": {
      const [lx, ly] = local();
      const len = Number(shape.length) || 0;
      const half = (Number(shape.width) || 0) / 2;
      return lx >= x - EPS && lx <= x + len + EPS && ly >= y - half - EPS && ly <= y + half + EPS;
    }
    case "emanation": {
      // Square grid, Draw Steel diagonals (every step counts 1): the base rectangle grown by the radius.
      const b = shapeBounds(shape, scene);
      if (!b) return false;
      if (!(px >= b.x0 - EPS && px <= b.x1 + EPS && py >= b.y0 - EPS && py <= b.y1 + EPS)) return false;
      const base = shape.base;
      if (base?.hole) {
        const inner = base.type === "token"
          ? { x0: Number(base.x) || 0, y0: Number(base.y) || 0, x1: (Number(base.x) || 0) + (Number(base.width) || 1) * s, y1: (Number(base.y) || 0) + (Number(base.height) || 1) * s }
          : shapeBounds(base, scene);
        if (inner && px > inner.x0 + EPS && px < inner.x1 - EPS && py > inner.y0 + EPS && py < inner.y1 - EPS) return false;
      }
      return true;
    }
    case "circle": {
      const r = Number(shape.radius) || 0;
      return (px - x) ** 2 + (py - y) ** 2 <= r * r + EPS;
    }
    default: {
      const b = shapeBounds(shape, scene);
      return !!b && px >= b.x0 && px <= b.x1 && py >= b.y0 && py <= b.y1;
    }
  }
}

/** Is a point inside a region: core's `testPoint` (+ level) when present, else our shape geometry. */
export function regionHasPoint(region, point, level = undefined) {
  if (!region || !point) return false;
  try {
    if (level !== undefined && level !== null && typeof region.includedInLevel === "function" && !region.includedInLevel(level)) return false;
    if (typeof region.testPoint === "function") return !!region.testPoint({ x: point.x, y: point.y, elevation: Number(point.elevation) || 0 });
    if (typeof region.polygonTree?.testPoint === "function") return !!region.polygonTree.testPoint(point);
  } catch (_err) {
    // fall through to the shapes
  }
  const shapes = [...(region.shapes ?? [])];
  const scene = region.parent ?? null;
  const holes = shapes.filter(sh => sh?.hole);
  if (holes.some(sh => insideShape({ ...sh, hole: false }, point, scene))) return false;
  return shapes.some(sh => insideShape(sh, point, scene));
}

/** Cells (offset keys "i,j", i = row) whose centres lie inside these shapes (a region not yet created). */
export function shapeCells(shapes, scene) {
  const s = cellSize(scene);
  const out = new Set();
  const rects = shapeRects(shapes, scene);
  const fake = { shapes, parent: scene };
  for (const r of rects) {
    for (let col = r.i0; col < r.i1; col++) {
      for (let row = r.j0; row < r.j1; row++) {
        if (regionHasPoint(fake, { x: (col + 0.5) * s, y: (row + 0.5) * s, elevation: 0 })) out.add(`${row},${col}`);
      }
    }
  }
  return out;
}

/* -------------------------------------------- */
/*  Footprints and paths                        */
/* -------------------------------------------- */

const isTeleport = action => {
  if (!action) return false;
  try {
    const def = globalThis.CONFIG?.Token?.movement?.actions?.[action];
    if (def) return !!def.teleport;
  } catch (_err) { /* no CONFIG */ }
  return action === "displace" || action === "teleport";
};

/** Grid offset {i: row, j: col} of a token's top-left (scene grid; floor of the point just inside the corner). */
function topLeftOffset(grid, x, y) {
  const s = Number(grid?.size) || 100;
  const px = (Number(x) || 0) + 1;
  const py = (Number(y) || 0) + 1;
  try {
    if (grid && typeof grid.getOffset === "function") {
      const o = grid.getOffset({ x: px, y: py });
      if (finite(o?.i) && finite(o?.j)) return { i: o.i, j: o.j };
    }
  } catch (_err) { /* mock grid */ }
  return { i: Math.floor(py / s), j: Math.floor(px / s) };
}

/** A straight sequence of offsets from a to b inclusive (fallback when the grid has no getDirectPath). */
function lineOffsets(a, b) {
  const n = Math.max(Math.abs(b.i - a.i), Math.abs(b.j - a.j));
  if (!n) return [{ i: a.i, j: a.j }];
  const out = [];
  for (let k = 0; k <= n; k++) {
    out.push({ i: Math.round(a.i + ((b.i - a.i) * k) / n), j: Math.round(a.j + ((b.j - a.j) * k) / n) });
  }
  return out;
}

/** Offsets of the top-left along a direct path between two token positions (scene grid). */
function directOffsets(grid, from, to) {
  const s = Number(grid?.size) || 100;
  const a = topLeftOffset(grid, from.x, from.y);
  const b = topLeftOffset(grid, to.x, to.y);
  try {
    if (grid && typeof grid.getDirectPath === "function") {
      const path = grid.getDirectPath([{ x: a.j * s + s / 2, y: a.i * s + s / 2 }, { x: b.j * s + s / 2, y: b.i * s + s / 2 }]);
      if (Array.isArray(path) && path.length) return path.map(o => ({ i: o.i, j: o.j }));
    }
  } catch (_err) { /* fall back */ }
  return lineOffsets(a, b);
}

/** Offset keys of a footprint whose top-left offset is `o` (width / height in squares, at least one each). */
function footprintKeys(o, width, height) {
  const rows = Math.max(1, Math.ceil(Math.round((Number(height) || 1) * 2) / 2 - EPS));
  const cols = Math.max(1, Math.ceil(Math.round((Number(width) || 1) * 2) / 2 - EPS));
  const out = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push({ i: o.i + r, j: o.j + c });
  return out;
}

/** The footprint offsets of a position that lie inside the region. */
function insideKeys(region, grid, o, { width, height, elevation, level }) {
  const s = Number(grid?.size) || 100;
  const out = [];
  for (const cell of footprintKeys(o, width, height)) {
    let c = null;
    try {
      c = typeof grid?.getCenterPoint === "function" ? grid.getCenterPoint({ i: cell.i, j: cell.j }) : null;
    } catch (_err) {
      c = null;
    }
    const point = { x: finite(c?.x) ? c.x : (cell.j + 0.5) * s, y: finite(c?.y) ? c.y : (cell.i + 0.5) * s, elevation };
    if (regionHasPoint(region, point, level)) out.push(`${cell.i},${cell.j}`);
  }
  return out;
}

const tokenSize = (tokenDoc, p) => ({
  width: Number(p?.width ?? tokenDoc?._source?.width ?? tokenDoc?.width) || 1,
  height: Number(p?.height ?? tokenDoc?._source?.height ?? tokenDoc?.height) || 1,
});

/**
 * Squares (offset keys "i,j", i = row) of a token footprint at a position (default: where it stands) that lie inside
 * a region. Grid of `region.parent`.
 * @returns {Set<string>}
 */
export function footprintSquares(tokenDoc, region, position = null) {
  const out = new Set();
  try {
    const grid = region?.parent?.grid ?? tokenDoc?.parent?.grid;
    if (!grid || !tokenDoc) return out;
    const src = tokenDoc._source ?? tokenDoc;
    const p = position ?? { x: src.x ?? tokenDoc.x, y: src.y ?? tokenDoc.y, elevation: src.elevation ?? tokenDoc.elevation, level: src.level ?? tokenDoc.level };
    const o = topLeftOffset(grid, p.x, p.y);
    const { width, height } = tokenSize(tokenDoc, p);
    for (const k of insideKeys(region, grid, o, { width, height, elevation: Number(p.elevation) || 0, level: p.level ?? src.level ?? null })) out.add(k);
  } catch (_err) {
    // quiet: an unreadable token or region covers nothing
  }
  return out;
}

/**
 * Area squares newly covered along a movement's passed path (§3.10.4): the points `[origin, ...passed.waypoints]`;
 * each consecutive pair whose target is not a teleport is walked square by square (the grid's direct path of the
 * top-left), a teleport pair (`CONFIG.Token.movement.actions[action].teleport`, displace included) counts only its
 * destination footprint; the origin footprint's squares are removed (the token was already there).
 * @returns {Set<string>}
 */
export function pathSquares(tokenDoc, region, movement) {
  const out = new Set();
  try {
    const grid = region?.parent?.grid ?? tokenDoc?.parent?.grid;
    if (!grid || !tokenDoc || !movement) return out;
    const origin = movement.origin ?? null;
    const waypoints = [...(movement.passed?.waypoints ?? [])];
    const points = [origin, ...waypoints].filter(p => p && finite(Number(p.x)) && finite(Number(p.y)));
    if (!points.length) return out;
    for (let k = 1; k < points.length; k++) {
      const a = points[k - 1];
      const b = points[k];
      const size = tokenSize(tokenDoc, b);
      const elevation = Number(b.elevation ?? a.elevation) || 0;
      const level = b.level ?? a.level ?? tokenDoc._source?.level ?? null;
      const steps = isTeleport(b.action) ? [topLeftOffset(grid, b.x, b.y)] : directOffsets(grid, a, b);
      for (const o of steps) for (const key of insideKeys(region, grid, o, { ...size, elevation, level })) out.add(key);
    }
    if (origin) {
      const size = tokenSize(tokenDoc, origin);
      const o = topLeftOffset(grid, origin.x, origin.y);
      for (const key of insideKeys(region, grid, o, { ...size, elevation: Number(origin.elevation) || 0, level: origin.level ?? null })) out.delete(key);
    }
  } catch (_err) {
    // quiet: nothing counted
  }
  return out;
}
