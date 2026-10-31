/** Once-per-turn/round claims are shared across cards and written by the GM. */
import { MODULE_ID, OP_STATUS } from "../constants.mjs";
let chain = Promise.resolve();
function owner(op) {
  return op.sharedRuleDsid ? game.combat : fromUuidSync(op.featureItemUuid ?? "");
}
function paths(op) {
  const id = op.sharedRuleDsid ?? op.ruleId;
  const base = op.sharedRuleDsid ? "encounterRule" : "rule";
  return { uses: `${base}Uses`, messages: `${base}Messages`, id };
}
export function claimFeature(op, messageId) {
  if (!op.featureFrequency) return Promise.resolve(true);
  const run = chain.then(async () => {
    const doc = owner(op); if (!doc) return false;
    const p = paths(op), flags = doc.flags?.[MODULE_ID] ?? {};
    const priorId = flags[p.messages]?.[p.id];
    const prior = priorId ? game.messages?.get(priorId)?.flags?.[MODULE_ID]?.resolution : null;
    // Older releases reserved the new turn without clearing its old message reference.
    const staleOpportunity = op.featureOpportunity && prior && Object.values(prior.ops ?? {}).some(o =>
      o.featureItemUuid === op.featureItemUuid && o.ruleId === op.ruleId && o.featureFrequency && o.featureFrequency !== op.featureFrequency)
      && !Object.values(prior.ops ?? {}).some(o => o.featureItemUuid === op.featureItemUuid && o.ruleId === op.ruleId && o.featureFrequency === op.featureFrequency);
    const record = game.messages?.get(messageId)?.flags?.[MODULE_ID]?.resolution;
    const orphanedRetry = op.featureOpportunity && !prior && op.status === OP_STATUS.SKIPPED && op.reason === "featureAlreadyUsed" && record?.featureEventId
      && ![...(game.messages?.contents ?? game.messages?.values?.() ?? [])].some(m => m.id !== messageId &&
        Object.values(m.flags?.[MODULE_ID]?.resolution?.ops ?? {}).some(o => o.featureItemUuid === op.featureItemUuid && o.ruleId === op.ruleId && o.featureFrequency === op.featureFrequency && o.status === OP_STATUS.APPLIED));
    if (flags[p.uses]?.[p.id] === op.featureFrequency && priorId !== messageId && !(op.featureOpportunity && !priorId) && !staleOpportunity && !orphanedRetry) return false;
    await doc.update({ [`flags.${MODULE_ID}.${p.uses}.${p.id}`]: op.featureFrequency, [`flags.${MODULE_ID}.${p.messages}.${p.id}`]: messageId });
    return true;
  });
  chain = run.catch(() => {}); return run;
}
export function releaseFeatureClaim(op, messageId, ops) {
  if ((op.featureOpportunity && op.status !== OP_STATUS.UNDONE) || !op.featureFrequency || ops.some(o => o.featureItemUuid === op.featureItemUuid && o.ruleId === op.ruleId && o.status === OP_STATUS.APPLIED && !o.featureCost)) return Promise.resolve();
  const run = chain.then(async () => {
    const doc = owner(op); if (!doc) return;
    const p = paths(op), flags = doc.flags?.[MODULE_ID] ?? {};
    if (flags[p.messages]?.[p.id] !== messageId) return;
    await doc.update({ [`flags.${MODULE_ID}.${p.uses}.${p.id}`]: new foundry.data.operators.ForcedDeletion(), [`flags.${MODULE_ID}.${p.messages}.${p.id}`]: new foundry.data.operators.ForcedDeletion() });
  });
  chain = run.catch(() => {}); return run;
}
