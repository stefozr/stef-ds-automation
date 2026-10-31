/**
 * Milestone 6: the squares of a summon (docs/M6-DESIGN.md §3.4). Pure given a scene: the owner's picker runs
 * `checkSquare` inside core's synchronous `preConfirm` (CL/canvas/layers/tokens.mjs:1183-1190), the active GM runs
 * `validatePlaces` / `autoPlaces` against the summoner's token scene (never `canvas.scene`).
 *
 * Geometry is our own, in grid cells: a footprint is a cell rectangle {i0, j0, i1, j1} (i = column, j = row, end
 * exclusive). Draw Steel counts distance in squares from the footprint, diagonals count 1, so two touching
 * rectangles are 1 apart (adjacent) and overlapping ones 0. Walls are ignored (Q17: no line of effect in M6);
 * tokens on another level never block (v14 levels). Hexagonal grids are refused (`gridUnsupported`); gridless
 * scenes use fractional cells.
 *
 * Every function returns quietly (null, [], "badPlace") when the scene lacks what it reads (harness mocks).
 *
 * i18n: the reasons returned here reach the card as `DSAUTO.Reason.<r>` (engine/summon.mjs) and the picker as
 * `DSAUTO.Summon.Picker.<r>` (summons/place.mjs): badPlace, offMap, wrongLevel, tooFar, occupied, gridUnsupported,
 * tooMany (validatePlaces only).
 */

/** core CONST.GRID_TYPES values, read live when present. */
const GRID = () => globalThis.CONST?.GRID_TYPES ?? { GRIDLESS: 0, SQUARE: 1 };

/** Upper bound of the GM search (squares), whatever the row's distance. */
const MAX_SEARCH = 100;

/** Pixel tolerance of position comparisons (snapping, scene rectangle). */
const EPS = 0.5;

const finite = v => typeof v === "number" && Number.isFinite(v);
const cellSize = scene => Number(scene?.grid?.size) || 100;
const sameLevel = (a, b) => (a ?? null) === (b ?? null);

/** "square" | "gridless" | "hex" from scene.grid.type (CONST.GRID_TYPES). */
export function gridKind(scene) {
  const type = scene?.grid?.type;
  const T = GRID();
  if (type === T.GRIDLESS) return "gridless";
  if (type === T.SQUARE) return "square";
  return "hex";
}

/** Cell rectangle {i0, j0, i1, j1} (end exclusive) of a token-like {x, y, width, height} (width/height in squares, min 1). */
export function rectOf(box, scene) {
  const s = cellSize(scene);
  const gridless = gridKind(scene) === "gridless";
  // Canvas coordinates: the scene padding is a whole number of cells, so cells start at 0.
  const i0 = gridless ? Number(box?.x) / s : Math.round(Number(box?.x) / s);
  const j0 = gridless ? Number(box?.y) / s : Math.round(Number(box?.y) / s);
  const w = Math.max(1, Number(box?.width) || 1);
  const h = Math.max(1, Number(box?.height) || 1);
  return { i0, j0, i1: i0 + w, j1: j0 + h };
}

const intersects = (a, b) => a.i0 < b.i1 && b.i0 < a.i1 && a.j0 < b.j1 && b.j0 < a.j1;

/** Draw Steel distance in squares between two cell rectangles: 0 overlapping, 1 adjacent (diagonals count 1). §3.4 */
export function squaresBetween(a, b) {
  if (intersects(a, b)) return 0;
  const gx = Math.max(0, b.i0 - a.i1, a.i0 - b.i1);
  const gy = Math.max(0, b.j0 - a.j1, a.j0 - b.j1);
  // Touching rectangles (gap 0 on both axes, no overlap) are adjacent: 1.
  return Math.max(0, Math.ceil(gx - 1e-9), Math.ceil(gy - 1e-9)) + 1;
}

/** Elevation difference in squares (ceil(|Δ| / grid.distance)). */
export function elevationSquares(e1, e2, scene) {
  const d = Number(scene?.grid?.distance) || 5;
  const diff = Math.abs((Number(e1) || 0) - (Number(e2) || 0));
  return Math.max(0, Math.ceil(diff / d - 1e-9));
}

/** {rect, elevation, level, sceneId} of a token document (the origin of a summon). */
export function originOf(tokenDoc) {
  if (!tokenDoc) return null;
  const scene = tokenDoc.parent ?? null;
  const src = tokenDoc._source ?? tokenDoc;
  return {
    rect: rectOf({ x: src.x ?? tokenDoc.x, y: src.y ?? tokenDoc.y, width: src.width ?? tokenDoc.width, height: src.height ?? tokenDoc.height }, scene),
    elevation: Number(tokenDoc.elevation ?? src.elevation) || 0,
    level: tokenDoc.level ?? src.level ?? null,
    sceneId: scene?.id ?? null,
  };
}

/** Does the token's actor carry the defeated status (core special status, "dead" in Draw Steel)? */
function isDefeatedToken(t) {
  try {
    const id = globalThis.CONFIG?.specialStatusEffects?.DEFEATED ?? "dead";
    return !!t?.actor?.statuses?.has?.(id);
  } catch (_err) {
    return false;
  }
}

/**
 * Rectangles occupied on `level` by tokens whose actor is not defeated. `viewer` (a User, client picker only): skip
 * hidden tokens that viewer does not own (Q15: the picker never reveals them); the GM passes none (hidden ones block).
 */
export function occupiedRects(scene, { level, ignoreTokenIds = [], viewer = null } = {}) {
  const out = [];
  const tokens = scene?.tokens;
  if (!tokens) return out;
  const ignore = new Set(ignoreTokenIds ?? []);
  for (const t of tokens) {
    if (!t || ignore.has(t.id)) continue;
    const tl = t.level ?? t._source?.level ?? null;
    if (level != null && tl != null && tl !== level) continue;
    if (isDefeatedToken(t)) continue;
    if (viewer && t.hidden) {
      let owns = false;
      try {
        owns = !!t.testUserPermission?.(viewer, "OWNER");
      } catch (_err) {
        owns = false;
      }
      if (!owns) continue;
    }
    const src = t._source ?? t;
    out.push(rectOf({ x: src.x, y: src.y, width: src.width, height: src.height }, scene));
  }
  return out;
}

/** Is a footprint rectangle inside the scene rectangle (scene.dimensions.sceneRect, padding excluded)? */
export function insideScene(scene, rect) {
  const R = scene?.dimensions?.sceneRect;
  if (!R || !rect) return true;
  const s = cellSize(scene);
  return rect.i0 * s >= R.x - EPS && rect.j0 * s >= R.y - EPS
    && rect.i1 * s <= R.x + R.width + EPS && rect.j1 * s <= R.y + R.height + EPS;
}

/** Is {x, y} the snapped top-left of a footprint of `size` on this scene's grid? */
export function snappedEqual(scene, square, size) {
  if (gridKind(scene) !== "square") return true;
  const x = Number(square?.x);
  const y = Number(square?.y);
  if (!finite(x) || !finite(y)) return false;
  const grid = scene.grid;
  let tl = null;
  try {
    // Top-left of the cell holding a point just inside the footprint's corner (core square grid, i = row, j = column).
    if (typeof grid.getTopLeftPoint === "function" && typeof grid.getOffset === "function") {
      tl = grid.getTopLeftPoint(grid.getOffset({ x: x + 1, y: y + 1 }));
    }
  } catch (_err) {
    tl = null;
  }
  if (!tl) {
    const s = cellSize(scene);
    tl = { x: Math.floor((x + 1) / s) * s, y: Math.floor((y + 1) / s) * s };
  }
  return Math.abs(tl.x - x) <= EPS && Math.abs(tl.y - y) <= EPS;
}

/** Distance in squares from the origin's footprint to a rectangle at an elevation (the larger of plane and height). */
function distanceOf(scene, origin, rect, elevation) {
  return Math.max(squaresBetween(origin.rect, rect), elevationSquares(origin.elevation, elevation, scene));
}

/** Does the scene know this level (v14 embedded levels)? Scenes without levels accept any. */
function sceneHasLevel(scene, level) {
  const levels = scene?.levels;
  if (level == null || !levels || !(levels.size > 0)) return true;
  try {
    return typeof levels.has === "function" ? levels.has(level) : true;
  } catch (_err) {
    return true;
  }
}

/**
 * One square: null when legal, else a reason ("badPlace" | "offMap" | "wrongLevel" | "tooFar" | "occupied" | "gridUnsupported").
 * SYNCHRONOUS (core preConfirm is not awaited, CL/canvas/layers/tokens.mjs:1189).
 * @param {object} args
 * @param {Scene} args.scene
 * @param {{rect, elevation, level}} args.origin
 * @param {{x, y, elevation, level}} args.square
 * @param {{width, height}} args.size
 * @param {number} args.distance
 * @param {string} args.level            the summoner token's level id
 * @param {object[]} [args.taken]        rectangles of squares already accepted in this batch
 * @param {object[]} [args.occupied]     occupiedRects(scene, {level}) (pass it once per batch)
 */
export function checkSquare({ scene, origin, square, size, distance, level, taken = [], occupied = null }) {
  const kind = gridKind(scene);
  if (kind === "hex") return "gridUnsupported";
  if (!square || !origin?.rect) return "badPlace";
  const elevation = square.elevation ?? 0;
  if (![square.x, square.y, elevation].every(finite)) return "badPlace";
  if (!sameLevel(square.level, level) || !sceneHasLevel(scene, level)) return "wrongLevel";
  if (kind === "square" && !snappedEqual(scene, square, size)) return "badPlace";
  const r = rectOf({ x: square.x, y: square.y, width: size?.width, height: size?.height }, scene);
  if (!insideScene(scene, r)) return "offMap";
  const max = Number(distance);
  if (!Number.isFinite(max) || distanceOf(scene, origin, r, elevation) > max) return "tooFar";
  const blockers = occupied ?? occupiedRects(scene, { level });
  if (blockers.some(o => intersects(o, r)) || (taken ?? []).some(o => intersects(o, r))) return "occupied";
  return null;
}

const plainSquare = sq => ({
  x: Number(sq.x), y: Number(sq.y), elevation: Number(sq.elevation ?? 0), level: sq.level ?? null,
  rotation: finite(sq.rotation) ? sq.rotation : 0,
});

/** All squares of a request: {ok: true, squares} or {ok: false, reason, index}. Also "tooMany". */
export function validatePlaces({ scene, origin, squares, size, quantity, distance, level }) {
  if (!Array.isArray(squares) || !squares.length) return { ok: false, reason: "badPlace", index: null };
  if (squares.length > (Number(quantity) || 0)) return { ok: false, reason: "tooMany", index: null };
  const occupied = occupiedRects(scene, { level });
  const taken = [];
  for (let k = 0; k < squares.length; k++) {
    const sq = squares[k];
    const why = checkSquare({ scene, origin, square: sq, size, distance, level, taken, occupied });
    if (why) return { ok: false, reason: why, index: k };
    taken.push(rectOf({ x: sq.x, y: sq.y, width: size?.width, height: size?.height }, scene));
  }
  return { ok: true, squares: squares.map(plainSquare) };
}

/**
 * GM search: up to `quantity` free squares within `distance` and inside the scene, nearest first, ties row-major.
 * [] when none. Candidates are top-left cells aligned with the origin's footprint (whole cells on a square grid);
 * cells outside the scene rectangle are never tried and the search box is bounded by MAX_SEARCH.
 */
export function autoPlaces({ scene, origin, size, quantity, distance, level, elevation }) {
  const kind = gridKind(scene);
  const want = Math.max(0, Math.floor(Number(quantity) || 0));
  const D = Math.min(Math.floor(Number(distance)), MAX_SEARCH);
  if (kind === "hex" || !origin?.rect || !want || !(D >= 1)) return [];
  const s = cellSize(scene);
  const w = Math.max(1, Number(size?.width) || 1);
  const h = Math.max(1, Number(size?.height) || 1);
  const a = origin.rect;
  const elev = Number(elevation ?? origin.elevation) || 0;
  // Every top-left within D - 1 cells of gap from the origin footprint, bucketed by its distance.
  const rings = new Map();
  for (let dj = -(h + D - 1); dj <= (a.j1 - a.j0) + D - 1; dj++) {
    for (let di = -(w + D - 1); di <= (a.i1 - a.i0) + D - 1; di++) {
      const i = a.i0 + di;
      const j = a.j0 + dj;
      const rect = { i0: i, j0: j, i1: i + w, j1: j + h };
      const d = squaresBetween(a, rect);
      if (d < 1 || d > D || !insideScene(scene, rect)) continue;
      if (!rings.has(d)) rings.set(d, []);
      rings.get(d).push({ i, j });
    }
  }
  const occupied = occupiedRects(scene, { level });
  const taken = [];
  const out = [];
  for (let d = 1; d <= D; d++) {
    const cells = rings.get(d);
    if (!cells) continue;
    cells.sort((p, q) => (p.j - q.j) || (p.i - q.i));
    for (const c of cells) {
      const square = { x: c.i * s, y: c.j * s, elevation: elev, level: level ?? null, rotation: 0 };
      if (checkSquare({ scene, origin, square, size: { width: w, height: h }, distance: D, level, taken, occupied })) continue;
      out.push(square);
      taken.push({ i0: c.i, j0: c.j, i1: c.i + w, j1: c.j + h });
      if (out.length >= want) return out;
    }
  }
  return out;
}
