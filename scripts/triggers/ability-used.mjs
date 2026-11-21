/**
 * `ability.used` events (1.2.2). The active GM emits ONE event per ability-use card: the createChatMessage hook sees a card
 * once (a re-render or an update never reaches it), and the message id is remembered besides. The event is built from the
 * same fact the event gains read (resources/facts.mjs useFactOf): subject and source are the user's token / actor, the
 * ability is `{itemUuid, actionType, messageId}` (`actionType` = the item's `system.type`, require.actionType).
 * Phase "after": reactors are asked at once, their steps (damage, note) run on trigger cards (engine.runAfter).
 * Zero cost when no overlay declares an `ability.used` trigger or no combat is started.
 */
import { error, log } from "../log.mjs";
import { setting } from "../settings.mjs";
import { useFactOf } from "../resources/facts.mjs";
import { combatFor } from "./budget.mjs";
import { kindsInUse, mayHold, offer, reportDecisions, runAfter, serverNow, triggersActive } from "./engine.mjs";
import { promptMs } from "./prompt.mjs";

const isActiveGM = () => !!game.users?.activeGM?.isSelf;
const newId = () => globalThis.foundry?.utils?.randomID?.() ?? Math.random().toString(36).slice(2, 18);
const MAX_SEEN = 400;
const seen = new Set();

function lookup(uuid) {
  if (!uuid) return null;
  try {
    return fromUuidSync(uuid);
  } catch (_err) {
    return null;
  }
}

/** The `ability.used` event of a use fact (pure). */
export function abilityUsedEvent(fact) {
  const actor = lookup(fact?.user?.actorUuid);
  const token = lookup(fact?.user?.tokenUuid);
  const name = token?.name ?? actor?.name ?? "";
  const ref = { actorUuid: fact.user.actorUuid, tokenUuid: fact.user.tokenUuid ?? null, name };
  return {
    id: newId(), kind: "ability.used", sceneId: fact.sceneId ?? null,
    subject: { ...ref, isHero: !!fact.user.isHero },
    source: { ...ref, itemUuid: fact.itemUuid, keywords: [], fromAbility: true, known: true },
    ability: { itemUuid: fact.itemUuid, actionType: fact.actionType ?? "", messageId: fact.messageId ?? null },
    at: serverNow(),
  };
}

/** Remember a message id once; false when it was seen. */
function firstTime(id) {
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > MAX_SEEN) for (const k of [...seen].slice(0, MAX_SEEN / 2)) seen.delete(k);
  return true;
}

/** Handle one new chat message (active GM). Returns the decisions (tests), never throws. */
export async function onAbilityUsedMessage(message) {
  try {
    if (!isActiveGM() || !message?.id || !triggersActive() || !kindsInUse().has("ability.used")) return [];
    const sceneId = message.speaker?.scene ?? null;
    if (!setting("triggersOutsideCombat") && !combatFor(sceneId)?.started) return [];
    if (!firstTime(message.id)) return [];
    const fact = useFactOf(message);
    if (!fact) return [];
    if (!mayHold("ability.used", fact.sceneId)) return [];
    const event = abilityUsedEvent(fact);
    const T = promptMs();
    const decisions = await offer([event], { phase: "after", deadline: serverNow() + 2 * T + 6_000 });
    reportDecisions(decisions);
    for (const d of decisions) {
      if (d?.outcome !== "used") continue;
      setTimeout(() => {
        Promise.resolve(runAfter({ holdDecisions: [d] })).catch(err => error("triggers.after", err));
      }, 0);
    }
    log("trigger.abilityUsed", { message: message.id, decisions: decisions.length });
    return decisions;
  } catch (err) {
    error("triggers.abilityUsed", err);
    return [];
  }
}

export function registerAbilityUsed() {
  Hooks.on("createChatMessage", message => {
    onAbilityUsedMessage(message);
  });
}
