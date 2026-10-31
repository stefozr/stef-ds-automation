/**
 * Frightened movement warning (Milestone 8, docs/M8-DESIGN.md §3.7, D20; every client): a frightened creature cannot
 * willingly move closer to the source of its fear. The system does not code that rule and Combat Tools enforces it
 * only for its own flagged effects, so for our native effects the moving user's client warns when the new position
 * is closer to the nearest token of the source on the same scene. A warning only: the move is never blocked.
 * Skipped with the setting `frightenedMoveWarning` off and while Combat Tools handles frightened itself.
 * Distances come from the token's own scene grid (`measurePath` when the grid has it), never `canvas.grid`.
 *
 * i18n keys (WP-D merges them into lang/en.json):
 *   DSAUTO.Targeted.FrightenedCloser   "{name} is frightened of {source} and cannot willingly move closer."
 */
import { MODULE_ID, loc } from "../constants.mjs";
import { dsctHandlesTargeted } from "../compat/dsct.mjs";
import { setting } from "../settings.mjs";
import { error } from "../log.mjs";
import { targetedStatus } from "../engine/targeted.mjs";

let registered = false;

export function registerFrightenedWarning() {
  if (registered) return;
  registered = true;
  Hooks.on("preUpdateToken", (tokenDoc, changes, options, userId) => {
    try {
      frightenedCheck(tokenDoc, changes, userId);
    } catch (err) {
      error("frightenedWarning", err);
    }
    // Never vetoes the move.
  });
}

/** The live native frightened effect of an actor (ours: static id with our flag), or null. */
function nativeFrightened(actor) {
  const id = targetedStatus("frightened")?._id;
  const e = id ? actor?.effects?.get?.(id) : null;
  if (!e || e.duration?.expired || e.disabled || !e.flags?.[MODULE_ID]?.targeted) return null;
  return e;
}

function lookup(uuid) {
  if (typeof uuid !== "string" || !uuid) return null;
  try {
    return fromUuidSync(uuid);
  } catch (_err) {
    return null;
  }
}

/** Tokens of a source actor on `scene`: its token from the effect first, then its active tokens. */
function sourceTokens(sourceUuid, tokenUuid, scene) {
  const out = new Map();
  const tok = lookup(tokenUuid);
  if (tok?.parent === scene) out.set(tok.id, tok);
  const actor = lookup(sourceUuid);
  let docs = [];
  try {
    docs = actor?.getActiveTokens?.(false, true) ?? [];
  } catch (_err) {
    docs = [];
  }
  for (const d of docs) if (d?.parent === scene && !out.has(d.id)) out.set(d.id, d);
  return [...out.values()];
}

/** Centre of a token document at (x, y) in scene pixels. */
function centre(doc, x, y, grid) {
  const sx = grid.sizeX ?? grid.size;
  const sy = grid.sizeY ?? grid.size;
  return { x: x + ((Number(doc.width) || 1) * sx) / 2, y: y + ((Number(doc.height) || 1) * sy) / 2 };
}

/** Scene grid distance between two points: the grid's own measurement, else squares (Chebyshev) x grid distance. */
function distance(grid, a, b) {
  if (typeof grid.measurePath === "function") {
    const d = grid.measurePath([a, b])?.distance;
    if (Number.isFinite(d)) return d;
  }
  const sx = grid.sizeX ?? grid.size;
  const sy = grid.sizeY ?? grid.size;
  return Math.max(Math.abs(a.x - b.x) / sx, Math.abs(a.y - b.y) / sy) * (Number(grid.distance) || 1);
}

/**
 * Warn the moving user when `tokenDoc` moves closer to the source of its native frightened.
 * @returns {boolean} whether a warning was shown (tests)
 */
export function frightenedCheck(tokenDoc, changes, userId) {
  if (userId !== game.userId || !changes || !("x" in changes || "y" in changes)) return false;
  if (!(setting("frightenedMoveWarning") ?? true) || dsctHandlesTargeted("frightened")) return false;
  const effect = nativeFrightened(tokenDoc?.actor);
  const scene = tokenDoc?.parent;
  const grid = scene?.grid;
  if (!effect || !grid) return false;
  const flag = effect.flags[MODULE_ID].targeted;
  const sources = sourceTokens(flag.sourceActorUuid, flag.sourceTokenUuid, scene).filter(t => t.id !== tokenDoc.id);
  if (!sources.length) return false;
  const before = centre(tokenDoc, tokenDoc.x, tokenDoc.y, grid);
  const after = centre(tokenDoc, changes.x ?? tokenDoc.x, changes.y ?? tokenDoc.y, grid);
  // Closer to the nearest source token than before (several tokens of one source: the nearest counts).
  let d0 = Infinity;
  let nearest = null;
  for (const s of sources) {
    const c = centre(s, s.x, s.y, grid);
    d0 = Math.min(d0, distance(grid, before, c));
    const d1 = distance(grid, after, c);
    if (!nearest || d1 < nearest.d1) nearest = { s, d1 };
  }
  if (!(nearest.d1 < d0)) return false;
  ui.notifications.warn(loc("DSAUTO.Targeted.FrightenedCloser", { name: tokenDoc.name, source: nearest.s.name }));
  return true;
}
