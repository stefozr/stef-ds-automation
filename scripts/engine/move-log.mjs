/**
 * Recent token moves as Foundry reports them on every client (`moveToken(document, movement, operation,
 * user)`: the movement's origin and destination, and the user core says made it). The active GM uses
 * it to check a teleport a player made on their own client (engine/forced.mjs recordClientMoves): the
 * start position comes from here, never from the player's request.
 */
const KEEP_MS = 10 * 60_000;
const PER_TOKEN = 8;
/** tokenUuid -> [{origin, destination, userId, at, used}] newest last */
const moves = new Map();

const pos = p => ({ x: Number(p?.x ?? 0), y: Number(p?.y ?? 0), elevation: Number(p?.elevation ?? 0) || 0 });

export function noteMove(document, movement, _operation, user) {
  if (!document?.uuid || !movement?.origin || !movement?.destination) return;
  const list = (moves.get(document.uuid) ?? []).filter(m => Date.now() - m.at < KEEP_MS);
  list.push({ origin: pos(movement.origin), destination: pos(movement.destination), userId: user?.id ?? null, at: Date.now(), used: false });
  while (list.length > PER_TOKEN) list.shift();
  moves.set(document.uuid, list);
}

export function registerMoveLog() {
  Hooks.on("moveToken", noteMove);
}

/**
 * The newest unused move of a token by a user since `since` that ended where the token stands now,
 * extended back over that user's moves of the same token right before it (one teleport may be several
 * updates). Marks them used. Null when there is none.
 */
export function takeMove(tokenUuid, userId, current, since = 0) {
  const list = moves.get(tokenUuid) ?? [];
  const same = (a, b) => a.x === b.x && a.y === b.y && (a.elevation ?? 0) === (b.elevation ?? 0);
  let i = list.length - 1;
  while (i >= 0 && (list[i].used || list[i].at < since)) i--;
  if (i < 0) return null;
  const last = list[i];
  if (last.userId !== userId || !same(last.destination, current)) return null;
  let first = i;
  while (first > 0 && !list[first - 1].used && list[first - 1].userId === userId && list[first - 1].at >= since
    && same(list[first - 1].destination, list[first].origin)) first--;
  for (let k = first; k <= i; k++) list[k].used = true;
  return { startPos: { ...list[first].origin }, finalPos: { ...last.destination } };
}
