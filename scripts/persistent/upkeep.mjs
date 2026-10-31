/**
 * Milestone 9 (docs/M9-DESIGN.md §C.4, WP-C): Persistent upkeep of an ability use, zones/upkeep.mjs for uses. At the
 * user's turn start the registry's lifecycle listener calls `offerPersistentUpkeep` (fire-and-forget: the lifecycle
 * queue never waits on a prompt). The user's owner is asked through the prompt router (type `persistentUpkeep`,
 * ui/persistent-prompts.mjs opens the M6 dialog with the Persistent texts) with the M6 countdown
 * (`summonUpkeepSeconds`); nobody online: the active GM's own dialog with `triggerFallback` "director", else a GM
 * whisper and the use is let go (`noOwner`). Keep pays through a `resource` row on a small record card (heroic −cost,
 * synthetic, self, undoable; `meta.persistent`), patches `lastRound` / `kept` and runs the keep effects (extend:
 * the use's effects swap to a held turn-start spec; reroll: persistent/reroll.mjs). Any other answer lets it go.
 *
 * - One open prompt per use (`open`, by the card's messageId). `cancelPersistentUpkeep(id, why)` resolves it: with
 *   "turnEnd", "dismissed", "encounterEnd" or "undone" the caller owns what happens next.
 * - Timing as M6/M7: the owner's dialog closes itself at `deadline`, the GM gives up at `timeoutMs + 3 s`, the query
 *   socket at `timeoutMs + 10 s`; every outcome the owner did not give closes the owner's dialog
 *   (`persistentUpkeepCancel`). A recipient who disconnects answers at once.
 * - Keep is paid ON the Persistent chain, re-checked there (use still active, combat started, still affordable), so a
 *   concurrent end is never charged. Undoing the Keep card refunds without letting the use go (as summons / zones).
 *
 * i18n keys used here: DSAUTO.Persistent.UpkeepCard, DSAUTO.Persistent.CannotPay, DSAUTO.Persistent.NoOwner,
 * DSAUTO.Entry.Resource.heroic.
 */
import { MODULE_ID, OP_STATUS, QUERY_PROMPT, loc } from "../constants.mjs";
import { opId, targetKey } from "../engine/keys.mjs";
import { postRecordCard } from "../engine/synthetic.mjs";
import { targetFromTokenDoc, tokenDocForActorUuid } from "../engine/targets.mjs";
import { debug, error, log } from "../log.mjs";
import { setting } from "../settings.mjs";
import { whisperGMs } from "../summons/registry.mjs";
import { canPay } from "../summons/upkeep.mjs";
import { clock, recipientFor } from "../triggers/prompt.mjs";
import { untilSpecs } from "../turn/until.mjs";
import { closeUpkeepDialog } from "../ui/summon-upkeep.mjs";
import { openPersistentDialog } from "../ui/persistent-prompts.mjs";
import { PERSISTENT_HOLD, endUse, keepKeyOf, patchEntry, rawEntry, useEffects, withPersistentChain } from "./registry.mjs";
import { startReroll } from "./reroll.mjs";

const GM_SLACK_MS = 3_000;
const QUERY_SLACK_MS = 10_000;
const SHORT_QUERY_MS = 10_000;
/** Answers an owner's client may give; anything else counts as "let it go". */
const OWNER_OUTCOMES = new Set(["keep", "release", "timedOut", "closed", "cancelled"]);
/** Outcomes whose canceller owns what happens next. */
const CALLER_OWNS = new Set(["turnEnd", "dismissed", "encounterEnd", "undone"]);

const open = new Map();   // messageId -> {promptId, owner, local, resolve, abilityName, userName, deadline, combatId}
let registered = false;

const isActiveGM = () => !!game.users?.activeGM?.isSelf;
const randomID = () => globalThis.foundry?.utils?.randomID?.() ?? Math.random().toString(36).slice(2, 18);

function lookup(uuid) {
  if (!uuid) return null;
  try {
    return fromUuidSync(uuid) ?? null;
  } catch (_err) {
    return null;
  }
}

/** Open upkeep prompts (selfCheck, tests). */
export function openPersistentUpkeeps() {
  return [...open.entries()].map(([messageId, e]) => ({
    messageId, promptId: e.promptId, userId: e.owner?.id ?? null, local: !!e.local, abilityName: e.abilityName, deadline: e.deadline,
  }));
}

/** Resolve an open upkeep prompt as `why`. True when one was open. */
export function cancelPersistentUpkeep(messageId, why = "cancelled") {
  const slot = open.get(messageId);
  if (!slot?.resolve) return false;
  open.delete(messageId);
  slot.resolve({ outcome: why });
  return true;
}

/** deleteCombat: every prompt opened in that combat is cancelled as "encounterEnd" (nothing is charged). */
export function cancelPersistentUpkeepsOf(combatId) {
  let n = 0;
  if (!combatId) return n;
  for (const [messageId, slot] of [...open]) if (slot.combatId === combatId && cancelPersistentUpkeep(messageId, "encounterEnd")) n++;
  return n;
}

/** What the dialog says besides the cost: the reminder, or who the re-roll would target. */
function detailOf(entry) {
  if (entry.note) return String(entry.note).slice(0, 300);
  return "";
}

/** The record target of the user (its recorded token, else any token of it, else the actor). */
function payerTarget(entry, actor) {
  const tokenDoc = lookup(entry.tokenUuid) ?? tokenDocForActorUuid(actor.uuid);
  const target = targetFromTokenDoc(tokenDoc)
    ?? { key: targetKey(actor.uuid), tokenUuid: null, actorUuid: actor.uuid, name: actor.name, img: actor.img ?? null };
  return { tokenDoc: tokenDoc ?? null, target };
}

/** Keep: re-checked and paid ON the chain, so a concurrent end is never charged. "paid" | "gone" | "cannotPay". */
function payUpkeep(entry, { combat, round, actor, owner, cost }) {
  return withPersistentChain(async () => {
    const live = game.combats?.get?.(combat?.id ?? entry.combatId) ?? null;
    if (!live?.started) return "gone";
    const now = rawEntry(live, entry.messageId);
    if (!now?.active) return "gone";
    if (!canPay(actor, cost)) return "cannotPay";
    const { tokenDoc, target } = payerTarget(entry, actor);
    const id = opId("persistentUpkeep", entry.messageId, round);
    await postRecordCard({
      title: loc("DSAUTO.Persistent.UpkeepCard", { name: entry.abilityName }), sourceActor: actor,
      sourceTokenUuid: tokenDoc?.uuid ?? null, targets: { [target.key]: target },
      ops: {
        [id]: {
          opId: id, order: 0, kind: "resource", mode: "auto", status: OP_STATUS.PENDING, synthetic: true, tier: null,
          resource: "heroic", amount: -cost, targetKeys: [target.key], self: true, upkeep: { messageId: entry.messageId },
        },
      },
      modes: { resources: "auto" }, user: owner ?? game.user,
      meta: { persistent: { upkeep: entry.messageId, keep: [now.keep].flat(), round } },
    });
    await patchEntry(live, entry.messageId, { lastRound: round, kept: (Number(now.kept) || 0) + 1 }, { onChain: true });
    return "paid";
  });
}

/**
 * extend: this combatant's until specs on the use's effects become one held turn-start spec (the effect lasts until
 * the next decision). Effects without a spec of this combatant (save ends, a base duration) are left alone.
 */
export async function keepExtend(entry, combat) {
  const live = game.combats?.get?.(combat?.id ?? entry.combatId) ?? combat;
  const held = { event: "turnStart", combatantId: entry.combatantId, combatId: live?.id ?? entry.combatId ?? null, armed: true, hold: PERSISTENT_HOLD };
  let n = 0;
  for (const effect of useEffects(live, rawEntry(live, entry.messageId) ?? entry)) {
    const specs = untilSpecs(effect);
    const mine = s => (s.event === "turnStart" || s.event === "turnEnd") && s.combatantId === entry.combatantId;
    if (!specs.some(mine)) continue;
    try {
      await effect.update({ [`flags.${MODULE_ID}.until`]: [...specs.filter(s => !mine(s)), held] });
      n++;
    } catch (err) {
      error("persistent.extend", err, { effect: effect?.uuid });
    }
  }
  debug("persistent.extend", { messageId: entry.messageId, effects: n });
  return n;
}

/** The keep effects after a paid Keep: extend first (the hold), then the free re-roll. */
async function keepEffects(entry, { combat, round, owner, local }) {
  const keep = [entry.keep].flat();
  if (keep.includes("extend")) await keepExtend(entry, combat);
  if (keep.includes("reroll")) await startReroll(entry, { combat, round, owner, local });
}

/**
 * Ask the user's owner to keep a Persistent use (fire-and-forget; one open prompt per use). Active GM.
 * @param {object} entry                 the index entry (persistent/registry.mjs)
 * @param {{combat: Combat|null, round: number|null}} ctx
 */
export function offerPersistentUpkeep(entry, { combat = null, round = null } = {}) {
  try {
    if (!isActiveGM() || !entry?.messageId || open.has(entry.messageId)) return;
    const actor = lookup(entry.actorUuid);
    const item = lookup(entry.itemUuid);
    const cost = Number(entry.cost) || 0;
    const end = (why, opts) => endUse(entry, why, opts).catch(err => error("persistent.upkeep", err));
    if (!actor?.system?.hero?.primary || !item || cost <= 0) {
      end("gone");
      return;
    }
    if (!canPay(actor, cost)) {
      whisperGMs(loc("DSAUTO.Persistent.CannotPay", { ability: entry.abilityName, name: actor.name ?? "", cost }));
      log("persistent.upkeep", { messageId: entry.messageId, outcome: "cannotPay", why: "offer" });
      end("cannotPay");
      return;
    }
    const recipient = recipientFor(actor);
    if (recipient.none || (!recipient.local && !recipient.user)) {
      whisperGMs(loc("DSAUTO.Persistent.NoOwner", { ability: entry.abilityName, name: actor.name ?? "" }));
      log("persistent.upkeep", { messageId: entry.messageId, outcome: "noOwner", why: recipient.why ?? null });
      end("noOwner");
      return;
    }
    const current = Number(actor.system.hero.primary.value) || 0;   // the turn's gain is already in (DSM:3424-3436)
    const t = Math.min(120, Math.max(10, Number(setting("summonUpkeepSeconds") ?? 30) || 30)) * 1000;
    const request = {
      type: "persistentUpkeep", promptId: randomID(), messageId: entry.messageId, abilityName: entry.abilityName ?? "",
      userName: actor.name ?? "", cost, resourceName: actor.system.hero.primary.label || loc("DSAUTO.Entry.Resource.heroic"), current,
      keepKey: keepKeyOf(entry.keep), detail: detailOf(entry), deadline: clock.now() + t, timeoutMs: t,
    };
    // Registered synchronously: a turnEnd or an end right after this call finds it.
    const slot = {
      promptId: request.promptId, owner: recipient.user ?? null, local: !!recipient.local, resolve: null,
      abilityName: request.abilityName, userName: request.userName, deadline: request.deadline, combatId: combat?.id ?? entry.combatId ?? null,
    };
    const cancelP = new Promise(resolve => { slot.resolve = resolve; });
    open.set(entry.messageId, slot);
    runOffer(entry, { combat, round, actor, cost, request, slot, cancelP, t })
      .catch(err => error("persistent.upkeep", err, { messageId: entry.messageId }))
      .finally(() => {
        if (open.get(entry.messageId) === slot) open.delete(entry.messageId);
      });
  } catch (err) {
    error("persistent.upkeep", err, { messageId: entry?.messageId });
  }
}

/** The owner's answer, or the GM's own dialog's (local); never rejects. */
function askOwner(slot, request, t) {
  return Promise.resolve()
    .then(() => (slot.local ? openPersistentDialog(request) : slot.owner.query(QUERY_PROMPT, request, { timeout: t + QUERY_SLACK_MS })))
    .then(a => ({ ...(a ?? { outcome: "closed" }), fromOwner: true }))
    .catch(err => ({ outcome: "noAnswer", why: String(err?.message ?? err) }));
}

/** Close the asked dialog after an outcome its owner did not give. */
function closeAsked(slot, request) {
  if (slot.local) {
    closeUpkeepDialog(request.promptId, "cancelled");
    return;
  }
  if (slot.owner?.active === false) return;
  Promise.resolve()
    .then(() => slot.owner.query(QUERY_PROMPT, { type: "persistentUpkeepCancel", promptId: request.promptId }, { timeout: SHORT_QUERY_MS }))
    .catch(err => debug("persistent.upkeepCancelFailed", { promptId: request.promptId, why: String(err?.message ?? err) }));
}

async function runOffer(entry, { combat, round, actor, cost, request, slot, cancelP, t }) {
  log("persistent.upkeepPrompt", { messageId: entry.messageId, to: slot.local ? "director" : slot.owner?.name, cost, ms: t });
  let timer = null;
  const answerP = askOwner(slot, request, t);
  const timerP = new Promise(resolve => {
    timer = clock.setTimeout(() => resolve({ outcome: "timedOut", why: "gmDeadline" }), Math.max(0, request.deadline - clock.now()) + GM_SLACK_MS);
  });
  const raw = await Promise.race([answerP, timerP, cancelP]);
  clock.clearTimeout(timer);
  if (open.get(entry.messageId) === slot) open.delete(entry.messageId);
  // Every outcome the owner did not give closes the owner's dialog.
  if (!raw.fromOwner) closeAsked(slot, request);
  const outcome = raw.fromOwner && !OWNER_OUTCOMES.has(raw.outcome) ? "release" : raw.outcome;
  log("persistent.upkeep", { messageId: entry.messageId, outcome, why: raw.why ?? null });
  if (CALLER_OWNS.has(outcome)) return;
  if (outcome !== "keep") {
    await endUse(entry, outcome === "timedOut" ? "timedOut" : "released");
    return;
  }
  const paid = await payUpkeep(entry, { combat, round, actor, owner: slot.owner, cost });
  if (paid === "cannotPay") {
    log("persistent.upkeep", { messageId: entry.messageId, outcome: "cannotPay", why: "keep" });
    await endUse(entry, "cannotPay");
    return;
  }
  if (paid === "paid") await keepEffects(entry, { combat, round, owner: slot.owner, local: slot.local });
}

/** init (active GM work): userConnected (left) -> the open prompt to that user answers noAnswer. */
export function registerPersistentUpkeepGM() {
  if (registered) return;
  registered = true;
  try {
    Hooks.on("userConnected", (user, connected) => {
      try {
        if (connected || !isActiveGM()) return;
        for (const [messageId, slot] of [...open]) {
          if (slot.local || slot.owner?.id !== user?.id) continue;
          open.delete(messageId);
          slot.resolve?.({ outcome: "noAnswer", why: "userLeft" });
          log("persistent.upkeepUserLeft", { messageId, user: user?.name });
        }
      } catch (err) {
        error("persistent.upkeepUserLeft", err);
      }
    });
  } catch (err) {
    error("persistent.registerUpkeep", err);
  }
}
