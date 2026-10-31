/** A teleport's optional Hide, verified against Combat Tools' actual hidden state on the GM. */
import { OP_STATUS } from "../constants.mjs";
import { dsctApi, dsctSetting } from "../compat/dsct.mjs";
import { askTeleportStep } from "../ui/teleport-followup.mjs";
import { positionOf, samePosition } from "../delegation/teleport.mjs";

const managed = effect => ["dsctHidden", "dsctWasHidden"].some(id => effect.statuses?.has?.(id));
const snapshots = actor => [...actor.effects.values()].filter(managed).map(e => e.toObject());
const fingerprint = data => JSON.stringify(data.map(({ _stats, ...source }) => source).sort((a, b) => a._id.localeCompare(b._id)));

export async function applyHideOp(message, res, op) {
  const teleport = res.ops?.[op.teleportOpId];
  if (teleport?.status !== OP_STATUS.APPLIED) return { status: OP_STATUS.PENDING, reason: "awaitingTeleport" };
  const doc = fromUuidSync(res.targets?.[op.targetKeys?.[0]]?.tokenUuid ?? "");
  if (!doc?.actor) return { status: OP_STATUS.FAILED, reason: "targetMissing" };
  const destination = teleport.moves?.find(m => m.tokenUuid === doc.uuid)?.finalPos;
  if (!samePosition(destination, positionOf(doc))) return { status: OP_STATUS.SKIPPED, reason: "hideDestinationChanged" };
  const stealth = dsctApi()?.stealth;
  if (!doc.object || doc.parent?.id !== globalThis.canvas?.scene?.id) return { status: OP_STATUS.FAILED, reason: "notOnCanvas" };
  if (!dsctSetting("stealthSystemEnabled", true) || !stealth?.isActive?.() || typeof stealth.runHide !== "function" || typeof stealth.proposeHide !== "function") {
    return { status: OP_STATUS.FAILED, reason: "hideUnavailable" };
  }
  const before = snapshots(doc.actor);
  const eligible = new Set(stealth.proposeHide(doc.object, { whileObserved: !!op.whileObserved }));
  if (!eligible.size) return { status: OP_STATUS.SKIPPED, reason: "hideIneligible", noApply: true };
  let answer;
  try {
    ({ answer } = await askTeleportStep(message, op, doc.actor, "hide"));
  } catch (err) {
    const after = snapshots(doc.actor);
    if (fingerprint(before) === fingerprint(after)) throw err;
    return { status: OP_STATUS.APPLIED, hideBefore: before, hideAfter: after, hideSucceeded: false, noApply: false, error: String(err?.message ?? err) };
  }
  if (answer?.declined) return { status: OP_STATUS.SKIPPED, reason: "hideDeclined", noApply: true };
  if (answer?.unavailable) return { status: OP_STATUS.FAILED, reason: "hideUnavailable" };
  const hidden = stealth.hiddenFrom(doc.object);
  const confirmed = (Array.isArray(answer?.ids) ? answer.ids : []).filter(id => eligible.has(id) && hidden.has(id));
  const after = snapshots(doc.actor);
  // The actor's token must still be at this teleport's destination when the attempt finishes.
  const success = samePosition(destination, positionOf(doc)) && confirmed.length > 0;
  if (!success && fingerprint(before) === fingerprint(after)) return { status: OP_STATUS.SKIPPED, reason: "hideFailed", noApply: true };
  return { status: OP_STATUS.APPLIED, hideBefore: before, hideAfter: after, hideSucceeded: success, noApply: false, reason: success ? null : "hideFailed" };
}

export async function undoHideOp(res, op) {
  const actor = fromUuidSync(res.targets?.[op.targetKeys?.[0]]?.actorUuid ?? "");
  if (!actor) return { status: OP_STATUS.FAILED, reason: "targetMissing" };
  if (fingerprint(snapshots(actor)) !== fingerprint(op.hideAfter ?? [])) return { status: OP_STATUS.FAILED, reason: "hideChanged" };
  const before = op.hideBefore ?? [];
  const ids = new Set(before.map(e => e._id));
  const remove = snapshots(actor).filter(e => !ids.has(e._id)).map(e => e._id);
  if (remove.length) await actor.deleteEmbeddedDocuments("ActiveEffect", remove);
  for (const data of before) {
    const existing = actor.effects.get(data._id);
    if (existing) {
      const { _stats, ...source } = data;
      // Replace flags too: a shallow merge would retain the Hide attempt's pending state.
      await existing.update({ ...source, flags: foundry.data.operators.ForcedReplacement.create(source.flags ?? {}) });
    } else await actor.createEmbeddedDocuments("ActiveEffect", [data], { keepId: true });
  }
  Hooks.callAll("dsct.stealthChanged");
  return { status: OP_STATUS.UNDONE };
}
