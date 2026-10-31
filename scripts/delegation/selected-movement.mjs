/** Server-side geometry checks for local-only movement proposals. */
import { OP_STATUS } from "../constants.mjs";
import { distanceSquares } from "../triggers/eligibility.mjs";
import { moveTokenTo, positionOf, samePosition } from "./teleport.mjs";
export function validDestination(doc, pos, { distance, closerTo = null, ignoreLineOfEffect = false } = {}) {
  if (doc.parent.grid.type != null && doc.parent.grid.type !== 1) return false;
  if (!pos || ![pos.x, pos.y].every(Number.isFinite)) return false;
  const G = Number(doc.parent.grid.size) || 100;
  if (Math.abs(pos.x / G - Math.round(pos.x / G)) > 0.01 || Math.abs(pos.y / G - Math.round(pos.y / G)) > 0.01) return false;
  if (pos.elevation != null && pos.elevation !== doc.elevation) return false;
  const virtual = { ...pos, width: doc.width, height: doc.height, parent: doc.parent };
  if (distanceSquares(doc, virtual) > distance) return false;
  if (closerTo && distanceSquares(virtual, closerTo) >= distanceSquares(doc, closerTo)) return false;
  const bounds = doc.parent.dimensions?.sceneRect ?? globalThis.canvas?.dimensions?.sceneRect;
  if (bounds && (pos.x < bounds.x || pos.y < bounds.y || pos.x + doc.width * G > bounds.x + bounds.width || pos.y + doc.height * G > bounds.y + bounds.height)) return false;
  for (const t of doc.parent.tokens) {
    if (t.id === doc.id || t.actor?.statuses?.has("dead")) continue;
    if (pos.x < t.x + t.width * G && pos.x + doc.width * G > t.x && pos.y < t.y + t.height * G && pos.y + doc.height * G > t.y) return false;
  }
  const center = p => ({ x: p.x + doc.width * G / 2, y: p.y + doc.height * G / 2 });
  if (!ignoreLineOfEffect && CONFIG.Canvas?.polygonBackends?.move?.testCollision?.(center(doc), center(pos), { type: "move", mode: "any" })) return false;
  return true;
}
export function validForcedPath(doc, source, pick, { distance, movements, vertical, ignoreStability }) {
  if (doc.parent.grid.type != null && doc.parent.grid.type !== 1) return false;
  if (source && source.parent?.id !== doc.parent.id) return false;
  const G = Number(doc.parent.grid.size) || 100;
  const remaining = Math.max(0, distance - (ignoreStability ? 0 : Number(doc.actor.system?.combat?.stability ?? 0)));
  if (!movements.includes(pick?.movement) || !Array.isArray(pick.path) || pick.path.length > remaining) return false;
  if (!Number.isInteger(pick.verticalDistance ?? 0) || Math.abs(pick.verticalDistance ?? 0) > remaining || (!vertical && pick.verticalDistance)) return false;
  // 0.17.0: a pull goes up only towards a higher source (as Combat Tools' picker, forced-movement-engine.mjs:1577-1593).
  if (vertical && pick.movement === "pull" && pick.verticalDistance > 0 && !((source?.elevation ?? 0) > (doc.elevation ?? 0))) return false;
  if (vertical && pick.movement === "push" && pick.verticalDistance < 0) return false;
  let prev = { x: doc.x / G, y: doc.y / G };
  let direction;
  const center = p => ({ x: p.x * G + doc.width * G / 2, y: p.y * G + doc.height * G / 2 });
  const src = source ? { x: source.x + source.width * G / 2, y: source.y + source.height * G / 2 } : null;
  const dist = p => Math.max(Math.abs(center(p).x - src.x), Math.abs(center(p).y - src.y));
  for (const p of pick.path) {
    if (![p.x, p.y].every(Number.isInteger) || Math.max(Math.abs(p.x - prev.x), Math.abs(p.y - prev.y)) !== 1) return false;
    const bounds = doc.parent.dimensions?.sceneRect;
    if (bounds && (p.x * G < bounds.x || p.y * G < bounds.y || (p.x + doc.width) * G > bounds.x + bounds.width || (p.y + doc.height) * G > bounds.y + bounds.height)) return false;
    if (pick.movement === "push" || pick.movement === "pull") {
      if (!src || (pick.movement === "push" ? dist(p) <= dist(prev) : dist(p) >= dist(prev))) return false;
      const step = { x: p.x - prev.x, y: p.y - prev.y };
      let crooked = false;
      try { crooked = !!game.settings.get("draw-steel-combat-tools", "allowCrookedPushPull"); } catch (_) {}
      if (!crooked && direction && (step.x !== direction.x || step.y !== direction.y)) return false;
      direction = step;
    }
    prev = p;
  }
  return true;
}
export async function executeSelectedTeleport(doc, pick, options) {
  if (!validDestination(doc, pick?.destination, options)) return { status: OP_STATUS.FAILED, reason: "badDestination" };
  const startPos = positionOf(doc), finalPos = { ...pick.destination, elevation: doc.elevation };
  if (samePosition(startPos, finalPos)) return { status: OP_STATUS.SKIPPED, reason: "notMoved" };
  await moveTokenTo(doc, finalPos);
  return { status: OP_STATUS.APPLIED, delegated: "core", moves: [{ tokenUuid: doc.uuid, startPos, finalPos }] };
}
