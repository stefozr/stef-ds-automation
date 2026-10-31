/**
 * Persistent upkeep (Milestone 6, docs/M6-DESIGN.md §1.7, §3.11, D18, Q16, Q18). At the summoner's turn start the
 * registry's lifecycle listener calls `offerUpkeep` (fire-and-forget: the lifecycle queue never waits on a prompt).
 * The summoner's owner is asked through the prompt router (type `summonUpkeep`, WP-C's dialog on the owner's
 * client) with a countdown; Keep pays through a `resource` row on a small record card (undoable), anything else
 * lets the summon go (`expired`).
 *
 * - One open prompt per summon (`open`, by summonId). `cancelUpkeep(id, why)` resolves it: with "turnEnd" or
 *   "dismissed" the caller owns the dismissal (the turnEnd listener dismisses before the chain runs, so a doomed
 *   summon never gets a turn; dismissSummon cancels its own prompt).
 * - Timing as trigger prompts (S/triggers/prompt.mjs): the owner's dialog closes itself at `deadline` (server time),
 *   the GM gives up at `timeoutMs + 3 s`, the query socket at `timeoutMs + 10 s`; every outcome the owner did not
 *   give closes the owner's dialog (`summonUpkeepCancel`). A recipient who disconnects answers at once.
 * - Keep is paid ON the summon chain, re-checked there (tokens present, not being dismissed, still affordable), so
 *   a concurrent dismissal is never charged. The card is new: nobody else holds its lock.
 * - No GM-local dialog: an NPC summoner, or nobody online to answer, lets the summon go (Q16), with a GM whisper.
 * i18n keys used here: DSAUTO.Summon.UpkeepCard, DSAUTO.Summon.UpkeepCannotPay, DSAUTO.Summon.UpkeepNoOwner,
 * DSAUTO.Entry.Resource.heroic.
 */
import { OP_STATUS, QUERY_PROMPT, loc } from "../constants.mjs";
import { postRecordCard } from "../engine/synthetic.mjs";
import { opId, targetKey } from "../engine/keys.mjs";
import { targetFromTokenDoc, tokenDocForActorUuid } from "../engine/targets.mjs";
import { debug, error, log } from "../log.mjs";
import { clock, ownersOf } from "../triggers/prompt.mjs";
import { setting } from "../settings.mjs";
import { REMOVAL, dismissSummon, isDismissing, patchIndex, summonTokens, whisperGMs, withSummonChain } from "./registry.mjs";

/** Slack between the GM's give-up time and the owner's deadline, and of the core query socket (as triggers). */
const GM_SLACK_MS = 3_000;
const QUERY_SLACK_MS = 10_000;
const SHORT_QUERY_MS = 10_000;
/** Answers an owner's client may give; anything else counts as "let it go". */
const OWNER_OUTCOMES = new Set(["keep", "release", "timedOut", "closed", "cancelled"]);
/** Outcomes whose canceller owns the dismissal (encounterEnd: the registry's encounter-end policy decides). */
const CALLER_DISMISSES = new Set(["turnEnd", "dismissed", "encounterEnd"]);

const open = new Map();   // summonId -> {promptId, owner, resolve, summonName, summonerName, deadline, combatId}

const isActiveGM = () => !!game.users?.activeGM?.isSelf;
const randomID = () => globalThis.foundry?.utils?.randomID?.() ?? Math.random().toString(36).slice(2, 18);

function lookup(uuid) {
  if (!uuid) return null;
  try {
    return fromUuidSync(uuid);
  } catch (_err) {
    return null;
  }
}

/** The hero's class item (the system's getter lives on the data model, DSM:3596). */
const classOf = actor => actor?.system?.class ?? actor?.class ?? null;

/** Can the summoner pay `cost` now (D18): constant class turnGain -> cost <= turnGain; else primary.value >= cost. */
export function canPay(summoner, cost) {
  const n = Number(cost) || 0;
  const gain = classOf(summoner)?.system?.turnGain;
  // Elementalist "2": maintaining lowers what you earn this turn, never below 0.
  if (typeof gain === "number" || (typeof gain === "string" && /^\s*\d+\s*$/.test(gain))) return n <= Number(gain);
  // A non-constant gain (Fury 1d3): the gain is already in the pool when we ask, so the pool decides.
  return (Number(summoner?.system?.hero?.primary?.value) || 0) >= n;
}

export function openUpkeeps() {
  return [...open.entries()].map(([summonId, e]) => ({
    summonId, promptId: e.promptId, userId: e.owner?.id ?? null, summonName: e.summonName, summonerName: e.summonerName, deadline: e.deadline,
  }));
}

/**
 * Resolve an open upkeep prompt as `why` (turnEnd, dismissal). True when one was open. With why "turnEnd" or
 * "dismissed" the offer's continuation does NOT dismiss: the caller owns the dismissal (§3.8, §3.11).
 */
export function cancelUpkeep(summonId, why = "cancelled") {
  const entry = open.get(summonId);
  if (!entry?.resolve) return false;
  open.delete(summonId);   // a second cancel (dismissSummon after the turnEnd listener) finds nothing
  entry.resolve({ outcome: why });
  return true;
}

/**
 * Review fix: the combat was deleted (deleteCombat, before the encounter-end policy runs). Every prompt opened in it
 * is cancelled as "encounterEnd": nothing is charged and the continuation does not dismiss (the policy does, or the
 * summon stays). The owner's dialog is closed.
 */
export function cancelUpkeepsOf(combatId) {
  let n = 0;
  if (!combatId) return n;
  for (const [summonId, entry] of [...open]) {
    if (entry.combatId === combatId && cancelUpkeep(summonId, "encounterEnd")) n++;
  }
  return n;
}

function cannotPay(info, why) {
  whisperGMs(loc("DSAUTO.Summon.UpkeepCannotPay", { name: info.summonName, summoner: info.summonerName, cost: info.cost }));
  log("summon.upkeep", { summonId: info.summonId, outcome: "cannotPay", why });
  return dismissSummon(info.summonId, REMOVAL.EXPIRED);
}

/** The record target of the summoner (its token on the entry's scene, else any token of it, else the actor). */
function payerTarget(entry, summoner) {
  const scene = entry.sceneId ? game.scenes?.get?.(entry.sceneId) : null;
  const tokenDoc = scene?.tokens?.get?.(entry.summonerTokenId) ?? tokenDocForActorUuid(summoner.uuid);
  const target = targetFromTokenDoc(tokenDoc)
    ?? { key: targetKey(summoner.uuid), tokenUuid: null, actorUuid: summoner.uuid, name: summoner.name, img: summoner.img ?? null };
  return { tokenDoc: tokenDoc ?? null, target };
}

/** Keep: re-checked and paid ON the summon chain, so a concurrent dismissal can never be charged. */
function payUpkeep(entry, info, { combat, round, summoner, owner }) {
  return withSummonChain(async () => {
    if (!summonTokens(entry.summonId).length || isDismissing(entry.summonId)) return "gone";   // dismissed meanwhile: no charge
    // The encounter ended meanwhile (review fix): no charge after combat, no write to the deleted Combat.
    if (!game.combats?.get?.(combat?.id ?? entry.combatId)?.started) return "gone";
    if (!canPay(summoner, info.cost)) return "cannotPay";   // the pool may have changed while asking
    const { tokenDoc, target } = payerTarget(entry, summoner);
    const id = opId("upkeep", entry.summonId, round);
    await postRecordCard({
      title: loc("DSAUTO.Summon.UpkeepCard", { name: info.summonName }), sourceActor: summoner,
      sourceTokenUuid: tokenDoc?.uuid ?? null, targets: { [target.key]: target },
      ops: {
        [id]: {
          opId: id, order: 0, kind: "resource", mode: "auto", status: OP_STATUS.PENDING, synthetic: true, tier: null,
          resource: "heroic", amount: -info.cost, targetKeys: [target.key], self: true, upkeep: { summonId: entry.summonId },
        },
      },
      modes: { resources: "auto" }, user: owner ?? game.user,
    });
    await patchIndex(combat, entry.summonId, { upkeptRound: round }, { onChain: true });
    return "paid";
  });
}

/** Offer Persistent upkeep for an index entry (fire-and-forget; one open prompt per summon). */
export function offerUpkeep(entry, { combat, round } = {}) {
  try {
    if (!isActiveGM() || !entry?.summonId || open.has(entry.summonId)) return;
    const summoner = lookup(entry.summonerActorUuid);
    const cost = Number(entry.upkeep) || 0;
    const summonName = summonTokens(entry.summonId)[0]?.name ?? "";
    const info = { summonId: entry.summonId, summonName, summonerName: summoner?.name ?? "", cost };
    // NPC or no heroic resource: nobody can keep it.
    if (!summoner?.system?.hero?.primary) {
      dismissSummon(entry.summonId, REMOVAL.EXPIRED).catch(err => error("summon.upkeep", err));
      return;
    }
    const current = Number(summoner.system.hero.primary.value) || 0;   // the turn's gain is already in (DSM:3424-3436)
    if (!canPay(summoner, cost)) {
      cannotPay(info, "offer").catch(err => error("summon.upkeep", err));
      return;
    }
    const owner = ownersOf(summoner)[0] ?? null;
    if (!owner) {
      whisperGMs(loc("DSAUTO.Summon.UpkeepNoOwner", { name: summonName, summoner: summoner.name }));
      log("summon.upkeep", { summonId: entry.summonId, outcome: "noOwner" });
      dismissSummon(entry.summonId, REMOVAL.EXPIRED).catch(err => error("summon.upkeep", err));
      return;
    }
    const t = Math.min(120, Math.max(10, Number(setting("summonUpkeepSeconds") ?? 30) || 30)) * 1000;
    const request = {
      type: "summonUpkeep", promptId: randomID(), summonId: entry.summonId, summonName, summonerName: summoner.name,
      cost, resourceName: summoner.system.hero.primary.label || loc("DSAUTO.Entry.Resource.heroic"), current,
      deadline: clock.now() + t, timeoutMs: t,
    };
    // Registered synchronously: a turnEnd or a dismissal right after this call finds it.
    const slot = {
      promptId: request.promptId, owner, resolve: null, summonName, summonerName: summoner.name, deadline: request.deadline,
      combatId: combat?.id ?? entry.combatId ?? null,
    };
    const cancelP = new Promise(resolve => { slot.resolve = resolve; });
    open.set(entry.summonId, slot);
    runOffer(entry, info, { combat, round, summoner, owner, request, slot, cancelP, t })
      .catch(err => error("summon.upkeep", err, { summonId: entry.summonId }))
      .finally(() => {
        if (open.get(entry.summonId) === slot) open.delete(entry.summonId);
      });
  } catch (err) {
    error("summon.upkeep", err, { summonId: entry?.summonId });
  }
}

async function runOffer(entry, info, { combat, round, summoner, owner, request, slot, cancelP, t }) {
  log("summon.upkeepPrompt", { summonId: entry.summonId, to: owner.name, cost: info.cost, ms: t });
  let timer = null;
  const answerP = Promise.resolve()
    .then(() => owner.query(QUERY_PROMPT, request, { timeout: t + QUERY_SLACK_MS }))
    .then(a => ({ ...(a ?? { outcome: "closed" }), fromOwner: true }))
    .catch(err => ({ outcome: "noAnswer", why: String(err?.message ?? err) }));
  const timerP = new Promise(resolve => {
    timer = clock.setTimeout(() => resolve({ outcome: "timedOut", why: "gmDeadline" }), Math.max(0, request.deadline - clock.now()) + GM_SLACK_MS);
  });
  const raw = await Promise.race([answerP, timerP, cancelP]);
  clock.clearTimeout(timer);
  if (open.get(entry.summonId) === slot) open.delete(entry.summonId);
  // Every outcome the owner did not give closes the owner's dialog.
  if (!raw.fromOwner && owner.active !== false) {
    Promise.resolve()
      .then(() => owner.query(QUERY_PROMPT, { type: "summonUpkeepCancel", promptId: request.promptId }, { timeout: SHORT_QUERY_MS }))
      .catch(err => debug("summon.upkeepCancelFailed", { promptId: request.promptId, why: String(err?.message ?? err) }));
  }
  const outcome = raw.fromOwner && !OWNER_OUTCOMES.has(raw.outcome) ? "release" : raw.outcome;
  log("summon.upkeep", { summonId: entry.summonId, outcome, why: raw.why ?? null });
  if (CALLER_DISMISSES.has(outcome)) return;   // the canceller owns the dismissal (§3.8, §3.9)
  if (outcome !== "keep") {
    await dismissSummon(entry.summonId, REMOVAL.EXPIRED);
    return;
  }
  const paid = await payUpkeep(entry, info, { combat, round, summoner, owner });
  if (paid === "cannotPay") await cannotPay(info, "keep");
}

/** userConnected (left) → the open prompt to that user answers noAnswer. */
export function registerUpkeepGM() {
  Hooks.on("userConnected", (user, connected) => {
    try {
      if (connected || !isActiveGM()) return;
      for (const [summonId, entry] of [...open]) {
        if (entry.owner?.id !== user?.id) continue;
        open.delete(summonId);
        entry.resolve?.({ outcome: "noAnswer", why: "userLeft" });
        log("summon.upkeepUserLeft", { summonId, user: user?.name });
      }
    } catch (err) {
      error("summon.upkeepUserLeft", err);
    }
  });
}
