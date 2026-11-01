/**
 * 1.1.1: who stands near a card's target, for `when.alliesNearTarget` (library-plan libraryOps) and `pick.flanking`
 * (library-plan pickRow, ui/target-pick.mjs pickCandidates). Pure apart from the canvas: flanking uses the system's
 * own token checks (DrawSteelToken#isFlanking, #getAdjacentAllies, #canFlank, #onOppositeSideOrCorner) when both
 * tokens are placed on this client's canvas; elsewhere "an allied creature next to the target" stands in.
 */
import { distanceSquares, notCreature, relation } from "../triggers/eligibility.mjs";

const list = c => c?.contents ?? [...(c ?? [])];

/** Allied creatures of `userToken` (never the user itself), not hidden, within `within` squares of `anchor`. */
export function alliesNear(anchor, userToken, within, { userActorUuid = null } = {}) {
  const scene = anchor?.parent;
  if (!scene || !userToken) return [];
  const range = Math.max(0, Number(within) || 0);
  return list(scene.tokens).filter(t => t?.actor && !t.hidden && !notCreature(t.actor)
    && t.uuid !== userToken.uuid && t.actor.uuid !== (userActorUuid ?? userToken.actor?.uuid)
    && relation(userToken, t) === "ally" && distanceSquares(anchor, t) <= range);
}

/** Both placeables on this client's canvas, or null. */
function placed(userToken, anchor) {
  const scene = globalThis.canvas?.scene;
  const a = userToken?.object, t = anchor?.object;
  if (!scene || userToken?.parent?.id !== scene.id || anchor?.parent?.id !== scene.id) return null;
  if (!a || !t || typeof a.isFlanking !== "function" || typeof a.getAdjacentAllies !== "function") return null;
  return { a, t };
}

/** Is `userToken` flanking `anchor`? */
export function isFlanking(userToken, anchor) {
  if (!userToken || !anchor) return false;
  const p = placed(userToken, anchor);
  if (p) return !!p.a.isFlanking(p.t);
  return distanceSquares(userToken, anchor) <= 1 && alliesNear(anchor, userToken, 1).length > 0;
}

/** The allies flanking `anchor` together with `userToken` (token documents). Empty when the user is not flanking. */
export function flankingAllies(userToken, anchor) {
  if (!isFlanking(userToken, anchor)) return [];
  const p = placed(userToken, anchor);
  if (!p) return alliesNear(anchor, userToken, 1);
  return p.a.getAdjacentAllies(p.t)
    .filter(o => o !== p.t && o.canFlank && !o.document?.hidden && (o.actor?.system?.adjacentFlanking || p.a.onOppositeSideOrCorner?.(p.t, o)))
    .map(o => o.document).filter(Boolean);
}
