/**
 * Zone placement on the clicking client (Milestone 7, docs/M7-DESIGN.md §3.10.2, §1.7; WP-C). Every client: the
 * creator's owner (player cards) or the Director.
 *
 * The zone row's Place button (resolution-part `dsAutoZone`) runs `runZonePick`:
 *   1. burst / aura rows (`op.interactive === false`) are not picked: the GM builds the emanation around the
 *      creator's token on Apply, so the click relays `apply` with nothing else;
 *   2. the card's own system template (R21): a region of the creator's scene with `flags["draw-steel"].abilitySource`
 *      = the row's item uuid, created for this use, whose shapes match the area (type; one shape, or 1..count wall
 *      squares) is offered first (DialogV2 "Use the placed template" (default) | "Place again"); using it sends its
 *      shapes. Ours is a copy: Combat Tools may still sweep the system's template later;
 *   3. otherwise the creator's token must be on the viewed scene and level (core `placeRegion` builds the preview
 *      on `canvas.scene`, CL/canvas/layers/regions.mjs:701) on a square or gridless grid; the shapes come from
 *      WP-B `zoneShapes` (the system's own template shapes, DSM:6596-6640) and are placed with
 *      `canvas.regions.placeRegion(data, {create: false, allowRotation: line only, preConfirm})`. Core places each
 *      shape in turn: left click confirms, right click skips one (fewer wall squares are fine), Escape resolves null
 *      and nothing is sent. `create: false` returns the unsaved document and needs no create permission
 *      (regions.mjs:719);
 *   4. `preConfirm` is called WITHOUT await (regions.mjs:1108-1116, verified: its argument is
 *      `{event, document, regionIndex, regionCount, shape, shapeIndex, shapeCount}`, `document.shapes` ends with the
 *      shape being confirmed), so it is synchronous: the shape must lie within `range` squares of the creator's
 *      footprint (`squaresBetween`, as the GM measures) and on the scene, and a wall square after the first must
 *      touch an earlier one (side or corner) without repeating one; a refusal warns here (core shows nothing);
 *   5. only `{x, y, rotation}` per shape, the level and the creator's elevation go to the active GM in `apply`
 *      (`zonePlaces: {[opId]: {shapes, level, elevation}}`); sizes never come from the client. The GM checks
 *      everything again (§3.10.3). A refusal is read back from the record and shown as DSAUTO.Zone.Refused.
 * A second click on the same row while its picker is open is ignored (`busy`); another placement (a summon
 * picker, another Place) cancels the open one through core's `_cancelPlacement` (the first sends nothing).
 *
 * No engine or relay imports beyond the record reader: resolution-part.mjs imports this file
 * (S/parts/resolution-part.mjs:19-22); the relay function arrives as `request`.
 *
 * i18n keys: DSAUTO.Zone.{PlaceTitle, TooFar, NotConnected, TemplateTitle, UseTemplate, PlaceAgain, NeedsCanvas,
 * GridUnsupported, Refused}, DSAUTO.Reason.{noCreatorToken, noArea, outsideArea, badZonePlace, error} and the row's
 * own reason (dynamic), DSAUTO.Relay.Denied.
 */
import { MODULE_ID, loc } from "../constants.mjs";
import { getResolution } from "../engine/record.mjs";
import { debug, error, log } from "../log.mjs";
import { gridKind, insideScene, originOf, squaresBetween } from "../summons/squares.mjs";
import * as shapesLib from "./shapes.mjs";

/** The same picker warning is not repeated within this window (preConfirm runs on every click). */
const WARN_THROTTLE_MS = 1_200;
/** A template placed from the ability's use dialog is created before its card (DSM:4602): accepted this long before. */
const TEMPLATE_BEFORE_MS = 120_000;
/** Upper bound of shapes sent (MAX_ZONE_SQUARES, S/library/schema.mjs). */
const MAX_SHAPES = 30;
const SYSTEM_ID = "draw-steel";
/** Region shape type of each zone area (the system's ds.CONFIG.abilities.distances[type].area). */
const SHAPE_TYPE = Object.freeze({ wall: "rectangle", cube: "rectangle", line: "line" });

const busy = new Set();          // message.id:opId of rows whose picker or choice is open on this client
const lastWarn = { text: null, at: 0 };

const esc = v => {
  const s = String(v ?? "");
  const fn = globalThis.foundry?.utils?.escapeHTML;
  return typeof fn === "function" ? fn(s) : s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
};
const warn = text => globalThis.ui?.notifications?.warn?.(text);
const info = text => globalThis.ui?.notifications?.info?.(text);
const finite = v => typeof v === "number" && Number.isFinite(v);

/**
 * The text of a zone row's reason (row detail and the refusal toast): DSAUTO.Reason.<reason>, except `tooFar`, whose
 * generic text is forced movement's ("the move was longer than allowed"): with the area's `range` known it reads
 * DSAUTO.Zone.TooFar.
 * @param {string} reason
 * @param {{range?: number}} [opts]   the zone area (op.zone.area)
 */
export function zoneReasonText(reason, { range = null } = {}) {
  const r = typeof reason === "string" && /^[A-Za-z]+$/.test(reason) ? reason : "error";
  if (r === "tooFar" && Number.isFinite(Number(range)) && range !== null) return loc("DSAUTO.Zone.TooFar", { range: Number(range) });
  return loc(`DSAUTO.Reason.${r}`);
}

function warnThrottled(text) {
  const now = Date.now();
  if (lastWarn.text === text && now - lastWarn.at < WARN_THROTTLE_MS) return;
  lastWarn.text = text;
  lastWarn.at = now;
  warn(text);
}

function lookup(uuid) {
  if (!uuid) return null;
  try {
    return fromUuidSync(uuid);
  } catch (_err) {
    return null;
  }
}

/** The row as the record holds it now (re-read after the relay call). */
function freshOp(message, opId) {
  const live = globalThis.game?.messages?.get?.(message?.id) ?? message;
  return getResolution(live)?.ops?.[opId] ?? null;
}

/** A relay refusal or failure as text: i18n keys (DSAUTO.*) are localized, anything else shown as is. */
function errorText(err) {
  const msg = String(err?.message ?? err ?? "");
  return msg.startsWith("DSAUTO.") ? loc(msg) : msg;
}

/** Plain data of a shape (a ShapeData instance or a plain object). Exported for engine/seed.mjs and zones/adopt.mjs. */
export const plain = s => (typeof s?.toObject === "function" ? s.toObject() : { ...(s ?? {}) });

/**
 * First level id of a region-like document (source array or a Set), or null. Exported (Milestone 9) for seed / adopt.
 * @param {object} doc
 * @returns {string|null}
 */
export function levelOf(doc) {
  const src = doc?._source?.levels;
  if (Array.isArray(src) && src.length) return src[0] ?? null;
  const lv = doc?.levels;
  if (lv && typeof lv[Symbol.iterator] === "function") {
    for (const id of lv) return id ?? null;
  }
  return null;
}

/** Normalized {x, y, rotation} of one placed shape, or null when unusable (the relay validator's limits, §1.7). */
function placeOf(s) {
  const x = Number(s?.x);
  const y = Number(s?.y);
  if (!finite(x) || !finite(y) || Math.abs(x) > 1e6 || Math.abs(y) > 1e6) return null;
  let rotation = Number(s?.rotation ?? 0);
  if (!finite(rotation)) rotation = 0;
  rotation = ((rotation % 360) + 360) % 360;
  if (rotation >= 360) rotation = 0;
  return { x, y, rotation };
}

/**
 * The `zonePlaces` entry for a list of shapes; null when a shape is unusable or none is left. Exported (Milestone 9):
 * the seed's `areaTemplate.place` and the GM's adoption build the same entry.
 * @param {object[]} shapes          plain shape data (at most MAX_SHAPES are read)
 * @param {string|null} level
 * @param {number} elevation
 * @returns {{shapes: {x, y, rotation}[], level: string|null, elevation: number}|null}
 */
export function zonePlace(shapes, level, elevation) {
  const out = [];
  for (const s of (shapes ?? []).slice(0, MAX_SHAPES)) {
    const p = placeOf(s);
    if (!p) return null;
    out.push(p);
  }
  if (!out.length) return null;
  const lv = typeof level === "string" && level.length >= 1 && level.length <= 40 ? level : null;
  const el = Number(elevation);
  return { shapes: out, level: lv, elevation: finite(el) && Math.abs(el) <= 1e5 ? el : 0 };
}

/**
 * Can this client place for the creator now? Null when it can, else the warning text. Previews are always built on
 * canvas.scene (regions.mjs:701), so the creator's scene and level must be viewed.
 */
function canvasProblem(creatorDoc) {
  if (!creatorDoc) return loc("DSAUTO.Reason.noCreatorToken");
  const cv = globalThis.canvas;
  const scene = cv?.scene;
  if (!cv?.ready || !scene || typeof cv?.regions?.placeRegion !== "function" || creatorDoc.parent?.id !== scene.id) return loc("DSAUTO.Zone.NeedsCanvas");
  const viewed = cv.level?.id ?? null;
  if (viewed && creatorDoc.level && viewed !== creatorDoc.level) return loc("DSAUTO.Zone.NeedsCanvas");
  if (gridKind(scene) === "hex") return loc("DSAUTO.Zone.GridUnsupported");
  return null;
}

/* -------------------------------------------- */
/*  The card's own system template (R21)         */
/* -------------------------------------------- */

/**
 * Do a template's shapes match the zone area (shape type, one shape or 1..count wall squares)? Milestone 9: a burst or
 * aura matches the emanation engine/areas.mjs areaUse places around the user (side-targets.mjs reads its creatures).
 */
function templateMatches(region, area) {
  const type = SHAPE_TYPE[area?.shape] ?? (area?.shape === "burst" || area?.shape === "aura" ? "emanation" : null);
  const shapes = [...(region?.shapes ?? [])];
  if (!type || !shapes.length) return false;
  if (!shapes.every(s => s?.type === type)) return false;
  const max = area.shape === "wall" ? Math.max(1, Number(area.count) || 1) : 1;
  return shapes.length <= max;
}

/**
 * The card's own system template on the creator's scene: `flags["draw-steel"].abilitySource` = the row's item, created
 * for this use (not before the use dialog opened), shapes matching the area. The newest one; null when none.
 * Milestone 9: `preferId` (the region the use's seed names) wins over a newer match when it qualifies itself.
 * @param {Scene} scene
 * @param {object} op               the zone row
 * @param {ChatMessage} message
 * @param {object} area             op.zone.area
 * @param {{preferId?: string|null}} [options]
 * @returns {RegionDocument|null}
 */
export function cardTemplate(scene, op, message, area, { preferId = null } = {}) {
  const regions = scene?.regions;
  if (!regions || !op?.itemUuid) return null;
  const since = Number(message?.timestamp ?? message?._stats?.createdTime ?? 0) - TEMPLATE_BEFORE_MS;
  let best = null;
  for (const r of regions) {
    if (r?.flags?.[SYSTEM_ID]?.abilitySource !== op.itemUuid) continue;
    if (r?.flags?.[MODULE_ID]?.zone) continue;   // one of our own zones (never has abilitySource, but be safe)
    const created = Number(r?._stats?.createdTime ?? 0);
    if (since > 0 && created < since) continue;
    if (!templateMatches(r, area)) continue;
    if (preferId && r.id === preferId) return r;   // Milestone 9: the use's own template
    if (!best || created > Number(best._stats?.createdTime ?? 0)) best = r;
  }
  return best;
}

/** "template" | "place" | null (closed): use the placed template, or place again. */
async function askTemplate(op) {
  const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
  if (!DialogV2?.wait) return "place";
  try {
    const result = await DialogV2.wait({
      window: { title: loc("DSAUTO.Zone.TemplateTitle", { name: op.label ?? "" }), icon: "fa-solid fa-draw-polygon" },
      classes: ["ds-auto-zone-dialog"],
      position: { width: 360 },
      content: `<div class="ds-auto-zone-choice"><p>${esc(op.label ?? "")}</p></div>`,
      rejectClose: false,
      buttons: [
        { action: "template", label: "DSAUTO.Zone.UseTemplate", icon: "fa-solid fa-check", default: true, callback: () => "template" },
        { action: "place", label: "DSAUTO.Zone.PlaceAgain", icon: "fa-solid fa-draw-polygon", callback: () => "place" },
      ],
    });
    return result === "template" || result === "place" ? result : null;
  } catch (err) {
    error("zones.askTemplate", err);
    return null;
  }
}

/* -------------------------------------------- */
/*  The picker                                   */
/* -------------------------------------------- */

/**
 * The synchronous preConfirm check of one shape (exported for the harness). Null when it may be confirmed, else the
 * warning text. `earlier` = the shapes already confirmed (plain data).
 */
export function checkZoneShape({ scene, area, origin, shape, earlier = [] }) {
  const rects = shapesLib.shapeRects?.([plain(shape)], scene);
  const rect = rects?.[0];
  if (!rect) return null;                                        // nothing to measure: the GM decides
  const range = Math.max(0, Number(area?.range) || 0);
  if (origin?.rect && squaresBetween(origin.rect, rect) > range) return loc("DSAUTO.Zone.TooFar", { range });
  if (!insideScene(scene, rect)) return loc("DSAUTO.Reason.outsideArea");
  if (area?.shape === "wall" && earlier.length) {
    const before = shapesLib.shapeRects?.(earlier.map(plain), scene) ?? [];
    if (before.some(r => squaresBetween(r, rect) === 0)) return loc("DSAUTO.Reason.badZonePlace");   // the same square twice
    if (before.length && !before.some(r => squaresBetween(r, rect) <= 1)) return loc("DSAUTO.Zone.NotConnected");
  }
  return null;
}

/** placeRegion(create: false) with the synchronous preConfirm; the placed (unsaved) RegionDocument, or null. */
async function pickShapes({ op, area, creatorDoc }) {
  const cv = globalThis.canvas;
  const scene = cv.scene;
  const shapes = shapesLib.zoneShapes?.(area, { scene, creatorDoc }) ?? [];
  if (!Array.isArray(shapes) || !shapes.length) {
    warn(zoneReasonText("noArea"));
    return null;
  }
  const level = cv.level?.id ?? creatorDoc.level ?? null;
  const origin = originOf(creatorDoc);
  const data = {
    name: op.label ?? "", shapes: shapes.slice(0, MAX_SHAPES), color: game.user?.color ?? null,
    levels: level ? [level] : [], restriction: { enabled: !!level, type: "move" }, displayMeasurements: true,
    visibility: globalThis.CONST?.REGION_VISIBILITY?.ALWAYS ?? 2, highlightMode: "coverage",
    flags: { [MODULE_ID]: { zonePreview: true } },
  };
  // SYNCHRONOUS: core does not await it (regions.mjs:1113), only `=== false` blocks.
  const preConfirm = ({ document, shape }) => {
    try {
      const all = [...(document?.shapes ?? [])];
      const earlier = all.slice(0, -1);
      const why = checkZoneShape({ scene, area, origin, shape: shape ?? all.at(-1), earlier });
      if (why) {
        warnThrottled(why);
        return false;
      }
      return true;
    } catch (err) {
      error("zones.preConfirm", err);
      return false;
    }
  };
  info(loc("DSAUTO.Zone.PlaceTitle"));
  const placed = await cv.regions.placeRegion(data, { create: false, allowRotation: area.shape === "line", preConfirm });
  return placed && (placed.shapes?.length ?? 0) > 0 ? placed : null;
}

/* -------------------------------------------- */
/*  The row's Place button                       */
/* -------------------------------------------- */

/** Relay `apply` (with zonePlaces when given) and warn when the row did not end applied. */
async function send({ message, op, request, place = null }) {
  const payload = { action: "apply", messageId: message.id, opIds: [op.opId] };
  if (place) payload.zonePlaces = { [op.opId]: place };
  const out = await request(payload);
  const after = freshOp(message, op.opId);
  log("zone.pick", { messageId: message.id, opId: op.opId, outcome: after?.status ?? null, shapes: place?.shapes?.length ?? 0 });
  if (out?.refused?.length) warn(loc("DSAUTO.Zone.Refused", { why: loc("DSAUTO.Relay.Denied") }));
  else if (after?.status !== "applied") warn(loc("DSAUTO.Zone.Refused", { why: zoneReasonText(after?.reason, { range: op.zone?.area?.range ?? null }) }));
}

/**
 * The zone row's Place button (resolution-part dsAutoZone): pick on this canvas (or reuse the card's own system
 * template when it still exists, §3.10.2), relay apply with zonePlaces. `request` = partActions.request (relay
 * requestOp). Never throws.
 */
export async function runZonePick({ message, res, op, request }) {
  void res;
  if (!message?.id || !op?.opId || typeof request !== "function") return;
  const key = `${message.id}:${op.opId}`;
  if (busy.has(key)) return;                                      // double click: the first picker goes on
  busy.add(key);
  try {
    // Burst / aura: nothing to pick, the GM builds the emanation around the creator's token.
    if (op.interactive === false) {
      await send({ message, op, request });
      return;
    }
    const area = op.zone?.area ?? null;
    if (!area || !SHAPE_TYPE[area.shape]) {
      warn(zoneReasonText("noArea"));
      return;
    }
    const creatorDoc = lookup(op.creatorTokenUuid);
    if (!creatorDoc) {
      warn(zoneReasonText("noCreatorToken"));
      return;
    }

    // The card's own system template, when it is still on the creator's scene (R21).
    const tpl = cardTemplate(creatorDoc.parent, op, message, area);
    if (tpl) {
      const choice = await askTemplate(op);
      if (!choice) return;                                        // closed: nothing sent
      if (choice === "template") {
        const place = zonePlace([...tpl.shapes].map(plain), levelOf(tpl) ?? creatorDoc.level ?? null, creatorDoc.elevation ?? 0);
        if (!place) {
          warn(zoneReasonText("badZonePlace"));
          return;
        }
        log("zone.template", { messageId: message.id, opId: op.opId, regionId: tpl.id, shapes: place.shapes.length });
        await send({ message, op, request, place });
        return;
      }
    }

    // The dialog may have changed the viewed scene or level: checked here, right before the picker.
    const live = lookup(op.creatorTokenUuid);
    const problem = canvasProblem(live);
    if (problem) {
      warn(problem);
      log("zone.pick", { messageId: message.id, opId: op.opId, outcome: "noCanvas" });
      return;
    }
    const placed = await pickShapes({ op, area, creatorDoc: live });
    if (!placed) {
      log("zone.pick", { messageId: message.id, opId: op.opId, outcome: "cancelled" });
      return;                                                     // Esc or every shape skipped: nothing sent
    }
    const place = zonePlace([...placed.shapes].map(plain), levelOf(placed) ?? live.level ?? null, live.elevation ?? 0);
    if (!place) {
      warn(zoneReasonText("badZonePlace"));
      return;
    }
    await send({ message, op, request, place });
  } catch (err) {
    const text = errorText(err);
    if (text) warn(text);
    if (!String(err?.message ?? "").startsWith("DSAUTO.")) error("zones.pick", err, { opId: op?.opId });
    else debug("zone.pickRefused", { opId: op?.opId, why: String(err?.message ?? "") });
  } finally {
    busy.delete(key);
  }
}
