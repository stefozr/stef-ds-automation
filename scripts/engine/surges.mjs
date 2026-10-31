import { withResourceChain } from "../resources/world-resources.mjs";
/**
 * Surges (Milestone 1.5). A hero spends surges on one target of a card:
 * - extra damage: up to 3 surges per damage roll, each dealing damage equal to the hero's highest
 *   characteristic (the system's Modify Damage dialog uses `getRollData().chr` and at most
 *   `min(3, surges)`, draw-steel.mjs:19652-19710); recorded as a separate damage op per target;
 * - +1 potency for 2 surges on one target that resisted by exactly one (it then fails).
 * Retainers spend their mentor's surges. Surges are paid when the op is applied and refunded when it is
 * undone, so rows that wait for the Director cost nothing until they land.
 */
import { OP_STATUS } from "../constants.mjs";

export const MAX_SURGES = 3;
export const POTENCY_SURGE_COST = 2;

function lookup(uuid) {
  if (!uuid) return null;
  try {
    return fromUuidSync(uuid);
  } catch (_err) {
    return null;
  }
}

/** The actor whose surges an ability's user spends: a hero, or a retainer's mentor. */
export function surgeActor(sourceActorUuid) {
  let actor = lookup(sourceActorUuid);
  if (actor?.type === "retainer") actor = actor.system?.retainer?.mentor ?? null;
  return actor?.type === "hero" ? actor : null;
}

export function availableSurges(actor) {
  return Math.max(0, Number(actor?.system?.hero?.surges ?? 0) || 0);
}

/** Damage per surge: the hero's highest characteristic. */
export function surgeDamage(actor) {
  try {
    return Math.max(0, Number(actor?.getRollData?.()?.chr ?? 0) || 0);
  } catch (_err) {
    return 0;
  }
}

/** Surge ops (pending or applied) that add to `baseOpId`. */
export function liveSurgeOps(res, baseOpId) {
  return Object.values(res?.ops ?? {}).filter(o => o.surge?.baseOpId === baseOpId
    && (o.status === OP_STATUS.PENDING || o.status === OP_STATUS.APPLIED));
}

/** Can a damage op take surges? (Not a surge op itself, not a synthetic card's op.) */
export function surgeableDamage(op) {
  return op?.kind === "damage" && !op.surge && !op.synthetic
    && (op.status === OP_STATUS.PENDING || op.status === OP_STATUS.APPLIED);
}

/**
 * Would +1 potency make this resisted condition or forced movement op fail? (`checkPotency`: fails
 * when value > resist.) A potency a triggered action lowered (`triggerResisted`, Milestone 5) counts too. A row whose
 * Draw Steel 1.2 part already carries the system's potency adjustment (`potency.bonus`, CH5) takes none: the system's
 * "Adjust potency" costs the same 2 surges for the same +1 (engine.mjs addSurge refuses with potencyAdjusted).
 */
export function potencySurgeable(op) {
  const p = op?.potency;
  return (op?.kind === "condition" || op?.kind === "forced") && !op.surge && !op.noApply && !!p && !p.fails && !p.bonus && op.status === OP_STATUS.SKIPPED
    && (op.reason === "resisted" || op.reason === "triggerResisted") && Number(p.resist) === Number(p.value);
}

/**
 * The op after a +1 potency spend (2 surges; potencySurgeable checked by the caller): pending again, potency raised so
 * it fails. Shared by the card's potency button (engine.mjs addSurge) and the surge dialog (ui/surge-choice.mjs).
 */
export function potencySurgePatch(op, actorUuid) {
  return {
    ...op, status: OP_STATUS.PENDING, reason: null,
    potency: { ...op.potency, value: Number(op.potency.value) + 1, fails: true, surged: true },
    surge: { kind: "potency", count: POTENCY_SURGE_COST, actorUuid },
  };
}

/** Pay an op's surges (active GM, before applying it). Returns false when the hero has too few. */
export async function paySurges(op) {
  const spend = op.surge ?? op.surgeSpend;
  const count = Number(spend?.count ?? 0);
  if (!count) return true;
  const actor = surgeActor(spend.actorUuid);
  if (!actor) return false;
  return withResourceChain(actor.uuid, async () => {
    if (availableSurges(actor) < count) return false;
    await actor.update({ "system.hero.surges": availableSurges(actor) - count });
    return true;
  });
}

/** Give back the surges an op paid (undo, or an application that did not land). */
export async function refundSurges(op, paid = op.surgesPaid) {
  const count = Number(paid ?? 0);
  if (!count) return;
  const actor = surgeActor((op.surge ?? op.surgeSpend)?.actorUuid);
  if (!actor) return;
  await withResourceChain(actor.uuid, () => actor.update({ "system.hero.surges": availableSurges(actor) + count }));
}
