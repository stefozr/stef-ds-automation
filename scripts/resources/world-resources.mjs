/**
 * World resources and resource chains (Milestone 7, docs/M7-DESIGN.md §1.5, §2.1 WP-A, §3.8, §6.1).
 *
 * - Malice and hero tokens are the system's world settings (`draw-steel.malice` / `draw-steel.heroTokens`, read through
 *   `game.actors.malice` / `.heroTokens`, DSM:3873-3885). Ours are written only on the active GM, each through one
 *   promise chain (`world:malice`, `world:heroTokens`), the value read inside the chain right before the write.
 * - `withResourceChain(key, fn)` is the one serializer of every resource read-modify-write of ours: per actor uuid
 *   (heroic resource, surges, epic: gains, library `resource` rows, upkeep cards, gain undo) and per world resource.
 *   A chain waits for nothing but its own document write (§2.0); a failing `fn` does not break the chain.
 * - World-resource ops are `resource` ops with `resource: "malice" | "heroToken"`: a spend larger than the pool fails
 *   (`notEnoughMalice` / `noHeroTokens`, a cost is never clamped silently), a gain never goes below 0. Real changes are
 *   written plainly (Battle Log logs them); undo writes carry `{dsblQuiet: true}` (RES:640-641).
 * - `postMaliceCard` is the relay `malice` (Directors, console/API, assistant GMs): one undoable record card.
 * The system's own Malice writes (NPC `updateResource`, round start) bypass the chain (§6.2, §8).
 *
 * i18n keys used by WP-A (block for WP-E's lang merge; §5.1):
 *   DSAUTO.Reason.alreadyGained, DSAUTO.Reason.noHeroTokens, DSAUTO.Reason.notEnoughMalice,
 *   DSAUTO.Reason.damageNotApplied, DSAUTO.Warning.villainActionReused, DSAUTO.Warning.villainActionRound,
 *   DSAUTO.Gain.CardTitle, DSAUTO.Malice.CardTitle, DSAUTO.Malice.Pool, DSAUTO.Malice.ReminderSpeaker,
 *   DSAUTO.Malice.ReminderIntro, DSAUTO.Malice.Use, DSAUTO.Malice.Cost, DSAUTO.Villain.Reused, DSAUTO.Villain.Again
 *   (existing: DSAUTO.Reason.targetMissing, noResource, nothingGained; DSAUTO.Relay.NotActiveGM, DSAUTO.Relay.BadRequest).
 *   DSAUTO.Card.Gain*, DSAUTO.Card.HeroToken*, DSAUTO.Card.Resource.malice/heroToken and DSAUTO.Entry.Resource.* are
 *   rendered by WP-E's view, not here.
 */
import { OP_STATUS, loc } from "../constants.mjs";
import { opId } from "../engine/keys.mjs";
import { postRecordCard } from "../engine/synthetic.mjs";
import { error, log } from "../log.mjs";

/** Op resource -> the system's world setting key. */
export const WORLD_RESOURCES = Object.freeze({ malice: "malice", heroToken: "heroTokens" });
/** Pseudo actor uuid for budget.debit / pendingDebit: the shared Malice pool (§3.8). */
export const MALICE_DEBIT_KEY = "world:malice";

const SYSTEM_ID = "draw-steel";
const chains = new Map();   // key -> tail of its chain

const isActiveGM = () => !!game.users?.activeGM?.isSelf;
const randomID = () => globalThis.foundry?.utils?.randomID?.(16) ?? Math.random().toString(36).slice(2, 18);
const settingKey = resource => WORLD_RESOURCES[resource] ?? (Object.values(WORLD_RESOURCES).includes(resource) ? resource : null);
const chainKey = resource => `world:${settingKey(resource)}`;

/**
 * Run `fn` after every earlier job of the same key settled. Resolves / rejects with `fn`'s result; the chain itself
 * never breaks.
 */
export function withResourceChain(key, fn) {
  const k = String(key ?? "");
  const prev = chains.get(k) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(() => fn());
  const tail = run.catch(() => {});
  chains.set(k, tail);
  tail.then(() => {
    if (chains.get(k) === tail) chains.delete(k);
  });
  return run;
}

/** The pool's value (Malice or hero tokens), 0 when unreadable (harness mocks, before the system's init). */
export function worldValue(resource) {
  const key = settingKey(resource);
  if (!key) return 0;
  try {
    const model = key === "malice" ? game.actors?.malice : game.actors?.heroTokens;
    const v = Number(model?.value ?? game.settings?.get?.(SYSTEM_ID, key)?.value);
    return Number.isFinite(v) ? v : 0;
  } catch (_err) {
    return 0;
  }
}

/** Write a pool (GM). `quiet` marks a correction for Battle Log (`dsblQuiet`, RES:540-541). Never below 0. */
export async function setWorldValue(resource, value, { quiet = false } = {}) {
  const key = settingKey(resource);
  if (!key) throw new Error("DSAUTO.Relay.BadRequest");
  if (!game.user?.isGM) throw new Error("DSAUTO.Relay.NotActiveGM");
  const next = Math.max(0, Math.floor(Number(value) || 0));
  await game.settings.set(SYSTEM_ID, key, { value: next }, quiet ? { dsblQuiet: true } : {});
  return next;
}

/** Applier of a world-resource op (engine applyOpList, before the generic `resource` branch). */
export async function applyWorldResource(message, res, op) {
  if (!settingKey(op?.resource)) return { status: OP_STATUS.FAILED, reason: "noResource" };
  const amount = Math.trunc(Number(op.amount) || 0);
  if (!amount) return { status: OP_STATUS.SKIPPED, reason: "nothingGained" };
  return withResourceChain(chainKey(op.resource), async () => {
    const before = worldValue(op.resource);
    const next = before + amount;
    if (amount < 0 && next < 0) {
      log("world.spendRefused", { resource: op.resource, before, amount, messageId: message?.id ?? null });
      if (op.resource === "malice") return { status: OP_STATUS.FAILED, reason: "notEnoughMalice", before: { value: before } };
      return { status: OP_STATUS.FAILED, reason: "noHeroTokens", before: { value: before } };
    }
    const after = await setWorldValue(op.resource, next);
    log("world.apply", { resource: op.resource, before, after, messageId: message?.id ?? null, opId: op.opId });
    return { status: OP_STATUS.APPLIED, before: { value: before }, after: { value: after }, finalAmount: after - before };
  });
}

/** Undo of a world-resource op: absolute while the pool still shows `after`, else the delta back (never below 0). */
export async function undoWorldResource(res, op) {
  if (!settingKey(op?.resource)) return { status: OP_STATUS.FAILED, reason: "noResource" };
  return withResourceChain(chainKey(op.resource), async () => {
    const current = worldValue(op.resource);
    const before = Number(op.before?.value ?? 0) || 0;
    const after = Number(op.after?.value ?? 0) || 0;
    const absolute = current === after;
    const next = Math.max(0, absolute ? before : current - (after - before));
    await setWorldValue(op.resource, next, { quiet: true });
    log("world.undo", { resource: op.resource, current, next, absolute, opId: op.opId });
    return { status: OP_STATUS.UNDONE, undoMode: absolute ? "absolute" : "delta" };
  });
}

/**
 * Relay `malice` (active GM): post an undoable Malice card for `delta` (its single auto op applies at once).
 * @returns {Promise<{ok: boolean, messageId: string|null, before: number|null, after: number|null}>}
 */
export async function postMaliceCard({ delta, reason = null, user = game.user } = {}) {
  if (!isActiveGM()) throw new Error("DSAUTO.Relay.NotActiveGM");
  const n = Math.trunc(Number(delta));
  if (!Number.isFinite(n) || n === 0 || Math.abs(n) > 50) throw new Error("DSAUTO.Relay.BadRequest");
  const key = "world-malice";
  const note = typeof reason === "string" && reason ? reason.slice(0, 100) : null;
  // The reason shows on the card (0.9.1): "Malice pool (live test)".
  const target = { key, tokenUuid: null, actorUuid: null, name: note ? `${loc("DSAUTO.Malice.Pool")} (${note})` : loc("DSAUTO.Malice.Pool"), img: null };
  const id = opId("malice", randomID());
  const ops = {
    [id]: {
      opId: id, order: 0, kind: "resource", resource: "malice", amount: n, mode: "auto", status: OP_STATUS.PENDING,
      synthetic: true, tier: null, targetKeys: [key],
    },
  };
  try {
    const result = await postRecordCard({
      title: loc("DSAUTO.Malice.CardTitle"), sourceActor: null, sourceTokenUuid: null, targets: { [key]: target }, ops,
      modes: { resources: "auto" }, meta: { malice: { v: 1, reason: note, by: user?.id ?? game.userId } }, user,
    });
    const op = result?.ops?.[id] ?? null;
    log("malice.card", { messageId: result?.messageId, delta: n, status: op?.status, user: user?.name });
    return {
      ok: op?.status === OP_STATUS.APPLIED, messageId: result?.messageId ?? null,
      before: op?.before?.value ?? null, after: op?.after?.value ?? null,
    };
  } catch (err) {
    error("malice.card", err, { delta: n });
    throw err;
  }
}

/** Keys with a job queued or running (selfCheck, harness). */
export const busyResourceChains = () => [...chains.keys()];
