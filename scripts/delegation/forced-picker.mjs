/**
 * 0.17.0: a forced move that needs a pick (a slide, "push or pull", a vertical or flying move, setting `forcedPath`
 * "choose") runs in Draw Steel: Combat Tools' own picker on the screen of whoever used the ability, like Combat Tools'
 * own "Push N" card buttons. Its canvas highlights the squares the target can reach; a vertical move then gets its
 * Vertical Distance window. Our own path dialog (ui/movement-choice.mjs) is left for moves without Combat Tools.
 *
 * Active GM (`forcedByPicker`, from engine/forced.mjs applyMoveOp): the recipient is the card's author when they own
 * the ability's user, else an owner, else the active GM (ui/teleport-followup.mjs stepRecipient). The GM snapshots the
 * scene first, then sends the prompt `forcedStep {messageId, opId}`; a timeout, a disconnect or `{unavailable}` hands
 * the pick to the active GM itself.
 *
 * Recipient (`handleForcedStep`): asks Push or Pull first when the row allows both, then calls Combat Tools' API form 3
 * with `fastMove: false` (delegation/forced-movement.mjs dsctForcedSpec). The player need not own the target: Combat
 * Tools sends token updates of creatures they do not own to the GM through ctlib's socket (`safeUpdate`).
 *
 * A player's answer is checked on the GM before it is recorded: the target's `lastFmMoveId` flag (written by the GM
 * through that socket) must be the answer's `moveId`, and the target may not have moved farther than the row allows
 * (falling excepted). Undo replays Combat Tools' undo log with GM rights, so only the entries that put back what the
 * GM's own snapshot recorded are kept (`cleanUndoLog`). A failed check puts the target back and the row fails.
 */
import { OP_STATUS, QUERY_PROMPT, loc } from "../constants.mjs";
import { getResolution } from "../engine/record.mjs";
import { routePrompt } from "../relay/prompt-router.mjs";
import { log } from "../log.mjs";
import { stepRecipient } from "../ui/teleport-followup.mjs";
import { callDsctForced, dsctForcedSpec, dsctMoved, dsctResultPatch, forcedRefusal, settledPosition } from "./forced-movement.mjs";
import { dsctForcedTaken } from "../compat/dsct.mjs";
import { moveTokenTo, positionOf } from "./teleport.mjs";

const ASK_MS = 300_000;
const running = new Set();
const TOKEN_KEYS = ["x", "y", "elevation"];
const TILE_KEYS = ["texture.src", "alpha"];
const WALL_KEYS = ["move", "sight", "light", "sound"];
const TAG_RE = /^(broken|damaged:\d+)$/;
/** Refusals a recipient may report (forcedRefusal); anything else is a bad answer. */
const REFUSALS = new Set(["targetMissing", "notOnCanvas", "sourceNotOnCanvas", "selfForced", "notMoved", "stabilityResists"]);

function lookup(uuid) {
  try {
    return uuid ? fromUuidSync(uuid) : null;
  } catch (_err) {
    return null;
  }
}

const list = c => (Array.isArray(c) ? c : Array.isArray(c?.contents) ? c.contents : typeof c?.values === "function" ? [...c.values()] : []);

/** The movement the row makes: the Director's pick (Edit), the only one allowed, or null ("push or pull"). */
export function rowMovement(op) {
  const pick = op.override?.movement;
  if (pick && op.movements?.includes(pick)) return pick;
  return op.movement ?? null;
}

/** The distance for `movement` (before stability): the Director's override, else the ability's. */
export function rowDistance(op, movement) {
  const override = op.override?.distance;
  if (Number.isFinite(override)) return override;
  return Math.max(0, Math.floor(Number(op.distances?.[movement] ?? 0) || 0));
}

/**
 * What the GM knows before the move: every token's position, the actors' Stamina and statuses, tiles, walls and squad
 * pools. Keys are uuids.
 */
export function sceneSnapshot(scene) {
  const snap = { tokens: new Map(), actors: new Map(), tiles: new Map(), walls: new Map(), groups: new Map(), docs: new Set() };
  for (const t of list(scene?.tokens)) {
    snap.docs.add(t.uuid);
    snap.tokens.set(t.uuid, { x: t.x, y: t.y, elevation: t.elevation ?? 0 });
    const a = t.actor;
    const s = a?.system?.stamina;
    if (a?.uuid && s) snap.actors.set(a.uuid, { value: Number(s.value) || 0, temp: Number(s.temporary) || 0, statuses: new Set(a.statuses ?? []) });
  }
  for (const t of list(scene?.tiles)) {
    snap.docs.add(t.uuid);
    snap.tiles.set(t.uuid, { "texture.src": t.texture?.src ?? null, alpha: t.alpha });
  }
  for (const w of list(scene?.walls)) {
    snap.docs.add(w.uuid);
    snap.walls.set(w.uuid, { move: w.move, sight: w.sight, light: w.light, sound: w.sound });
  }
  for (const c of list(game.combats)) for (const g of list(c?.groups)) if (g?.uuid) snap.groups.set(g.uuid, Number(g.system?.staminaValue ?? 0));
  return snap;
}

const strings = v => (Array.isArray(v) ? v.filter(s => typeof s === "string" && s.length <= 64).slice(0, 50) : []);

/**
 * The entries of a client's undo log that only put back what `snap` recorded: token positions, tile looks and wall
 * restrictions as they were, Stamina as it was, statuses the move added, Combat Tools' breakage tags, and documents the
 * move created on the scene. Every other entry is dropped (`dropped` counts them).
 */
export function cleanUndoLog(entries, snap, scene) {
  const keep = [];
  let dropped = 0;
  const flatten = foundry.utils?.flattenObject ?? (o => o);
  for (const e of Array.isArray(entries) ? entries.slice(0, 500) : []) {
    const ok = (() => {
      if (!e || typeof e !== "object" || typeof e.uuid !== "string") return false;
      switch (e.op) {
        case "update": {
          if (!e.data || typeof e.data !== "object") return false;
          const data = flatten(e.data);
          const ref = snap.tokens.get(e.uuid) ?? snap.tiles.get(e.uuid) ?? snap.walls.get(e.uuid);
          const keys = snap.tokens.has(e.uuid) ? TOKEN_KEYS : snap.tiles.has(e.uuid) ? TILE_KEYS : WALL_KEYS;
          if (!ref || !Object.keys(data).length || !Object.entries(data).every(([k, v]) => keys.includes(k) && ref[k] === v)) return false;
          keep.push({ op: "update", uuid: e.uuid, data, options: { isUndo: true } });
          return true;
        }
        case "stamina": {
          const a = snap.actors.get(e.uuid);
          if (!a || Number(e.prevValue) !== a.value || Number(e.prevTemp ?? 0) !== a.temp) return false;
          const pool = e.squadGroupUuid ? snap.groups.get(e.squadGroupUuid) : undefined;
          const squad = pool !== undefined && Number(e.prevSquadHP) === pool;
          keep.push({ op: "stamina", uuid: e.uuid, prevValue: a.value, prevTemp: a.temp, squadGroupUuid: squad ? e.squadGroupUuid : null,
            prevSquadHP: squad ? pool : null, squadCombatantIds: strings(e.squadCombatantIds), squadTokenIds: strings(e.squadTokenIds), wasDeadBefore: !!e.wasDeadBefore });
          return true;
        }
        case "status": {
          const a = snap.actors.get(e.uuid);
          if (!a || typeof e.effectId !== "string" || e.active !== false || a.statuses.has(e.effectId)) return false;
          keep.push({ op: "status", uuid: e.uuid, effectId: e.effectId, active: false });
          return true;
        }
        case "addTags":
        case "removeTags": {
          const tags = strings(e.tags);
          if (!(snap.tiles.has(e.uuid) || snap.walls.has(e.uuid)) || !tags.length || !tags.every(t => TAG_RE.test(t))) return false;
          keep.push({ op: e.op, uuid: e.uuid, tags });
          return true;
        }
        case "delete": {
          const doc = lookup(e.uuid);
          if (!doc || doc.parent?.id !== scene?.id || snap.docs.has(e.uuid) || !["Token", "Tile"].includes(doc.documentName)) return false;
          keep.push({ op: "delete", uuid: e.uuid });
          return true;
        }
        default:
          return false;
      }
    })();
    if (!ok) dropped++;
  }
  return { entries: keep, dropped };
}

/** How far the target went (squares): across the grid, and upwards (a fall down is not limited). */
export function movedSquares(doc, from, to) {
  const grid = doc.parent?.grid ?? globalThis.canvas?.grid ?? {};
  const size = Number(grid.size ?? 100) || 100;
  const units = Number(grid.distance ?? 5) || 5;
  return Math.max(Math.abs(to.x - from.x) / size, Math.abs(to.y - from.y) / size, Math.max(0, (to.elevation ?? 0) - (from.elevation ?? 0)) / units);
}

async function ask(recipient, payload) {
  return recipient?.isSelf ? routePrompt(payload, { user: game.user }) : recipient?.query(QUERY_PROMPT, payload, { timeout: ASK_MS });
}

/**
 * Active GM: run a picked forced move in Combat Tools' picker on the ability user's screen (see the header).
 * @returns {Promise<object>} Fields to merge into the op record.
 */
export async function forcedByPicker(message, res, op, targetDoc) {
  const movement = rowMovement(op);
  const sourceDoc = lookup(op.sourceTokenUuid ?? res.sourceTokenUuid);
  // Known refusals need nobody's pick (a stable target, the source off the scene).
  if (movement) {
    const refused = forcedRefusal({ targetDoc, sourceDoc, movement, distance: rowDistance(op, movement), ignoreStability: !!op.ignoreStability, taken: dsctForcedTaken(targetDoc.actor) });
    if (refused) return refused;
  }
  const gm = game.users.activeGM;
  const sourceActor = lookup(res.sourceActorUuid) ?? sourceDoc?.actor ?? null;
  let by = sourceActor ? stepRecipient(message, sourceActor) : gm;
  const payload = { type: "forcedStep", messageId: message.id, opId: op.opId };
  const snap = sceneSnapshot(targetDoc.parent);
  const startPos = positionOf(targetDoc);
  let answer = null;
  try {
    answer = await ask(by, payload);
  } catch (_err) {
    answer = null;   // timed out or disconnected: the Director picks
  }
  if (!by?.isSelf && (!answer || answer.unavailable)) {
    by = gm;
    try {
      answer = await ask(gm, payload);
    } catch (_err) {
      answer = null;
    }
  }
  const trusted = !!by?.isSelf;
  log("forced.step", { opId: op.opId, by: by?.id ?? null, trusted, result: answer?.moveId ? "moved" : answer?.refused ?? (answer?.unavailable ? "unavailable" : "cancelled") });
  if (answer?.unavailable) return { status: OP_STATUS.FAILED, reason: answer.reason === "delegateUnavailable" ? "delegateUnavailable" : "notOnCanvas" };
  if (answer?.refused) {
    const reason = REFUSALS.has(answer.refused.reason) ? answer.refused.reason : "notMoved";
    return { status: answer.refused.status === OP_STATUS.FAILED ? OP_STATUS.FAILED : OP_STATUS.SKIPPED, reason };
  }
  // Cancelled in Combat Tools' picker (or refused there): the row's Apply starts it again.
  if (!answer?.moveId || !answer.undoLog) return { status: OP_STATUS.PENDING, reason: "notMoved" };
  // The movement the recipient used: the row's own, or one of the row's choices.
  const moved = movement ? (answer.movement === movement ? movement : null) : (op.movements?.includes(answer.movement) ? answer.movement : null);
  const finalPos = await settledPosition(targetDoc);
  // Combat Tools adds the target's forcedMovementTaken squares to the move (1.2.7).
  const allowed = moved ? rowDistance(op, moved) + dsctForcedTaken(targetDoc.actor) : 0;
  if (!trusted) {
    const flag = targetDoc.flags?.["draw-steel-combat-tools"]?.lastFmMoveId;
    if (!moved || flag !== answer.moveId || movedSquares(targetDoc, startPos, finalPos) > allowed + 0.01) {
      log("forced.step.rejected", { opId: op.opId, by: by?.id ?? null, moveId: answer.moveId, flag: flag ?? null, movement: answer.movement ?? null });
      await moveTokenTo(targetDoc, startPos);
      return { status: OP_STATUS.FAILED, reason: "badDestination" };
    }
  }
  const clean = trusted ? { entries: answer.undoLog, dropped: 0 } : cleanUndoLog(answer.undoLog, snap, targetDoc.parent);
  if (clean.dropped) log("forced.step.undoDropped", { opId: op.opId, dropped: clean.dropped });
  const patch = await dsctResultPatch({ ...answer, undoLog: clean.entries }, { targetDoc, movement: moved ?? answer.movement, distance: allowed, startPos, finalPos });
  return { ...patch, pickedBy: by?.id ?? null, ...(trusted ? {} : { byClient: true }) };
}

/** Push or pull, when the row allows both (closing: null). */
async function askMovement(op) {
  const DialogV2 = foundry.applications?.api?.DialogV2;
  const choices = (op.movements ?? []).filter(m => ["push", "pull", "slide"].includes(m));
  if (!DialogV2?.wait || !choices.length) return null;
  const label = m => loc(`DSAUTO.ForcedStep.${m}`, { distance: rowDistance(op, m) });
  try {
    const picked = await DialogV2.wait({
      window: { title: loc("DSAUTO.ForcedStep.Title"), icon: "fa-solid fa-person-walking-arrow-right" },
      content: `<p>${foundry.utils.escapeHTML(loc("DSAUTO.ForcedStep.Choose", { label: op.label ?? "" }))}</p>`,
      buttons: choices.map((m, i) => ({ action: m, label: label(m), default: i === 0 })),
      rejectClose: false,
    });
    return choices.includes(picked) ? picked : null;
  } catch (_err) {
    return null;
  }
}

/** Recipient: pick the move in Combat Tools' picker (see the header). */
export async function handleForcedStep(payload, { user } = {}) {
  if (!user?.isGM || user.id !== game.users.activeGM?.id) throw new Error("DSAUTO.Relay.Denied");
  if (typeof payload?.messageId !== "string" || typeof payload?.opId !== "string" || payload.opId.length > 300) throw new Error("DSAUTO.Relay.BadRequest");
  const message = game.messages.get(payload.messageId);
  const res = getResolution(message);
  const op = res?.ops?.[payload.opId];
  if (!op || op.kind !== "forced" || op.status === OP_STATUS.APPLIED) throw new Error("DSAUTO.Relay.BadRequest");
  const sourceActor = lookup(res.sourceActorUuid);
  if (!game.user.isGM && !sourceActor?.testUserPermission?.(game.user, "OWNER")) throw new Error("DSAUTO.Relay.Denied");
  const targetDoc = lookup(res.targets?.[op.targetKeys?.[0]]?.tokenUuid);
  if (!targetDoc?.object || targetDoc.parent?.id !== globalThis.canvas?.scene?.id) return { unavailable: true };
  if (typeof globalThis.game.modules.get("draw-steel-combat-tools")?.api?.forcedMovement !== "function") return { unavailable: true, reason: "delegateUnavailable" };
  if (running.has(targetDoc.uuid)) throw new Error("DSAUTO.Relay.Busy");
  running.add(targetDoc.uuid);
  try {
    const movement = rowMovement(op) ?? await askMovement(op);
    if (!movement) return { cancelled: true };
    const distance = rowDistance(op, movement);
    const sourceDoc = lookup(op.sourceTokenUuid ?? res.sourceTokenUuid);
    const args = { targetDoc, sourceDoc, movement, distance, vertical: !!(op.vertical || op.flying), ignoreStability: !!op.ignoreStability, properties: op.properties ?? [] };
    const refused = forcedRefusal({ ...args, taken: dsctForcedTaken(targetDoc.actor) });
    if (refused) return { refused };
    const onScene = sourceDoc?.object && sourceDoc.parent?.id === targetDoc.parent?.id ? sourceDoc : null;
    const result = await callDsctForced(dsctForcedSpec({ ...args, sourceDoc: onScene, interactive: true }));
    if (!dsctMoved(result)) return { cancelled: true, movement };
    return {
      movement, moveId: String(result.moveId), undoLog: result.undoLog, hadDamage: !!result.hadDamage,
      content: String(result.content ?? "").slice(0, 4000),
      grabsToRestore: (result.grabsToRestore ?? []).slice(0, 20).map(g => ({ grabberTokenId: g.grabberTokenId, grabbedTokenId: g.grabbedTokenId })),
    };
  } finally {
    running.delete(targetDoc.uuid);
  }
}
