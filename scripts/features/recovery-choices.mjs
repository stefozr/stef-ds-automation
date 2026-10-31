/** GM-owned recovery offers: each recipient resolves without waiting for other players. */
import { MODULE_ID, OP_STATUS } from "../constants.mjs";
import { askFeature } from "./engine.mjs";
import { ownersOf } from "../triggers/prompt.mjs";
import { tokenOnScene } from "../triggers/eligibility.mjs";
import { targetFromTokenDoc } from "../engine/targets.mjs";
import { postRecordCard } from "../engine/synthetic.mjs";

const queues = new Map();
function enqueue(userId, fn) {
  const run = (queues.get(userId) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  queues.set(userId, tail);
  tail.finally(() => { if (queues.get(userId) === tail) queues.delete(userId); });
  return run;
}

export async function resolveRecoveryChoices(item, rule, event, tokens) {
  const source = tokenOnScene(item.actor, event.sceneId);
  const results = await Promise.allSettled(tokens.map(token => {
    const userId = ownersOf(token.actor)[0]?.id ?? game.users.activeGM?.id;
    return enqueue(userId, async () => {
      const actor = fromUuidSync(token.actor.uuid);
      const target = targetFromTokenDoc(token);
      let reason = null;
      let answer;
      if (!actor) reason = "targetMissing";
      else if (!(actor.system?.recoveries?.value > 0)) reason = "noRecoveries";
      else {
        try { answer = await askFeature(item, rule, { kind: "recovery", promptActor: actor }); }
        catch (_) { answer = { timedOut: true }; }
        if (!answer?.accepted) reason = answer?.timedOut ? "recoveryTimedOut" : "recoveryDeclined";
      }
      // The offer grants consent only; spending and native healing remain on the GM writer.
      const op = { opId: "recovery", kind: "heal", lib: true, recoveries: 1,
        amount: Number(actor?.system?.recoveries?.recoveryValue ?? 0), targetKeys: [target.key],
        status: reason ? OP_STATUS.SKIPPED : OP_STATUS.PENDING, mode: "auto", order: 0,
        featureItemUuid: item.uuid, ruleId: rule.id, label: item.name,
        ...(reason ? { reason, noApply: true } : {}) };
      return postRecordCard({ title: item.name, sourceActor: item.actor, sourceTokenUuid: source?.uuid,
        abilityUuid: item.uuid, targets: { [target.key]: target }, ops: { recovery: op },
        modes: {}, warnings: [], user: event.user ?? game.user,
        meta: { featureEventId: event.id ?? null, featureRuleId: rule.id, featureItemUuid: item.uuid,
          featureChain: [...(event.source?.featureChain ?? []), item.uuid] } });
    });
  }));
  const cards = results.filter(r => r.status === "fulfilled").map(r => r.value);
  for (const r of results) if (r.status === "rejected") console.error(`${MODULE_ID} | recovery offer failed`, r.reason);
  return cards.length ? { ...cards[0], messageIds: cards.map(c => c.messageId) } : null;
}
