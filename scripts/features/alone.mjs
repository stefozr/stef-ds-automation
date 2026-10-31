/** A pre-roll grant is a signed, undoable resource card, never a client resource write. */
import { MODULE_ID } from "../constants.mjs";
import { featureRules } from "./engine.mjs";
import { distanceSquares, relation, tokenOnScene } from "../triggers/eligibility.mjs";
import { targetFromTokenDoc } from "../engine/targets.mjs";
import { postRecordCard } from "../engine/synthetic.mjs";
import { undoOps, isActiveGM } from "../engine/engine.mjs";
import { requestOp } from "../relay/queries.mjs";
import { wrap } from "../compat/lib-wrapper.mjs";
const calls = new Map();
let chain = Promise.resolve();
const list = c => c?.contents ?? [...(c ?? [])];
export function aloneEligible(item, target) {
  const source = tokenOnScene(item.actor, target?.parent?.id);
  return !!source && !!target?.actor && target.parent?.id === source.parent?.id && !list(target.parent.tokens).some(t => relation(source, t) === "ally" && distanceSquares(t, target) <= 1);
}
export function grantAlone(item, payload, user) {
  const run = chain.then(async () => {
    if (!isActiveGM() || item.system?._dsid !== "i-work-better-alone" || !featureRules(item).some(r => r.event === "ability.beforeRoll")) return { ok: true };
    if (typeof payload.useId !== "string" || !/^[A-Za-z0-9]{16}$/.test(payload.useId)) throw new Error("DSAUTO.Relay.BadRequest");
    const prior = list(game.messages).find(m => m.flags?.[MODULE_ID]?.resolution?.aloneUseId === payload.useId && m.flags[MODULE_ID].resolution.sourceActorUuid === item.actor.uuid);
    if (payload.cancel) { if (prior) await undoOps(prior); return { ok: true }; }
    if (prior) return { ok: true, messageId: prior.id };
    if (!Array.isArray(payload.tokenUuids) || payload.tokenUuids.length !== 1) return { ok: true };
    const target = fromUuidSync(payload.tokenUuids[0]);
    if (!target?.object || (!user.isGM && (target.hidden || !target.object.visible)) || !aloneEligible(item, target)) return { ok: true };
    const source = tokenOnScene(item.actor, target.parent.id), record = targetFromTokenDoc(source);
    const result = await postRecordCard({ title: item.name, sourceActor: item.actor, abilityUuid: item.uuid, sourceTokenUuid: source.uuid,
      targets: { [record.key]: { ...record, self: true } }, user, meta: { aloneUseId: payload.useId },
      ops: { surge: { opId: "surge", kind: "resource", resource: "surge", amount: 1, mode: "auto", status: "pending", targetKeys: [record.key], self: true, order: 0 } } });
    return { ok: true, messageId: result.messageId };
  });
  chain = run.catch(() => {}); return run;
}
export async function prepareAloneUse(wrapped, config, dialogOptions, messageOptions) {
  if (this._dsid !== "i-work-better-alone" || !featureRules(this.parent).some(r => r.event === "ability.beforeRoll")) return wrapped(config, dialogOptions, messageOptions);
  const useId = foundry.utils.randomID(16);
  calls.set(useId, { itemUuid: this.parent.uuid });
  const opts = foundry.utils.mergeObject(messageOptions ?? {}, { data: { flags: { [MODULE_ID]: { aloneUseId: useId } } } }, { inplace: false });
  let result;
  try { result = await wrapped(config, { ...dialogOptions, dsAutoAloneUseId: useId }, opts); return result; }
  finally {
    if (!result && calls.get(useId)?.granted) await requestOp({ action: "aloneGrant", itemUuid: this.parent.uuid, useId, cancel: true });
    calls.delete(useId);
  }
}
export function registerAlone() {
  wrap("ds.applications.apps.AbilityConfigurationDialog.create", async function(wrapped, config, ...args) {
    const fd = await wrapped(config, ...args);
    const useId = config?.dsAutoAloneUseId, call = calls.get(useId);
    if (!fd || !call) return fd;
    const actors = new Set((fd.rolls ?? []).map(r => r.target));
    const targets = [...(game.user.targets ?? [])].map(t => t.document).filter(t => actors.has(t.actor?.uuid));
    const tokens = targets.length ? targets.map(t => t.uuid) : Object.values(config.context?.targets ?? {}).map(t => t.tokenUuid).filter(Boolean);
    const result = await requestOp({ action: "aloneGrant", itemUuid: call.itemUuid, useId, tokenUuids: tokens });
    call.granted = !!result.messageId;
    return fd;
  }, "MIXED");
}
export async function undoAloneUse(message) {
  const useId = message.flags?.[MODULE_ID]?.aloneUseId;
  if (!useId) return;
  const card = list(game.messages).find(m => m.flags?.[MODULE_ID]?.resolution?.aloneUseId === useId);
  if (card) await undoOps(card);
}
