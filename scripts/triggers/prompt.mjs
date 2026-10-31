/**
 * Trigger prompts, GM side (Milestone 5, docs/M5-DESIGN.md §3.4, §6.2, §6.6). One prompt per reactor, sent
 * to its active non-GM owners (the user whose character it is first) through the prompt router's `trigger`
 * type, or shown on the active GM's own client for Director-side reactors (`triggerNpcs`) and as the
 * `triggerFallback` when every owner is offline. A reactor never has two prompts open (one promise chain per
 * reactor actor, as turn/saves.mjs does for saves).
 *
 * Timing (every value is server time, so clients with skewed clocks agree):
 *   - the owner's dialog closes itself at the request's `deadline` (`timedOut`);
 *   - the GM gives up at `timeoutMs + 3 s` (`timedOut`) and sends `triggerCancel`; a late answer resolves a
 *     promise nobody awaits any more;
 *   - every outcome the owner did not give (GM timeout, Release, a moot cancellation, an aborted offer)
 *     closes the owner's dialog (review conc 12);
 *   - a query that fails (the player left mid-prompt) is `noAnswer`: no fallback once a prompt was sent.
 * The active GM sees a waiting indicator with a Release button (= declined) while a prompt is open.
 * Follow-ups (`triggerRun`) start on the planned user's client, or on the GM's own (runFollowUp).
 *
 * i18n keys: none of its own (ui/trigger-dialog.mjs and ui/trigger-indicator.mjs render the texts).
 */
import { QUERY_PROMPT } from "../constants.mjs";
import { debug, error, log } from "../log.mjs";
import { setting } from "../settings.mjs";
import { closeTriggerDialog, handleTriggerRun, openTriggerDialog } from "../ui/trigger-dialog.mjs";
import { clearWaiting, showWaiting } from "../ui/trigger-indicator.mjs";

/** Clock seam for tests (harness8 replaces the functions). `now` is server time. */
export const clock = { now: () => game.time?.serverTime ?? Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) };
export const promptMs = () => Math.min(120, Math.max(5, Number(setting("triggerPromptSeconds")) || 20)) * 1000;
/** C19: Target Damage's player socket waits 15 s; the GM gives up at P + 3 s (the hold's deadline), plus its write. */
export const EXTERNAL_PROMPT_MS = 10_000;
export const EXTERNAL_SLACK_MS = 3_000;
export const externalPromptMs = () => Math.min(promptMs(), EXTERNAL_PROMPT_MS);

/** Slack between the GM's give-up time and the owner's deadline, and of the core query socket. */
const GM_SLACK_MS = 3_000;
const QUERY_SLACK_MS = 10_000;
/** `triggerCancel` and `triggerRun` answer at once on the owner's client. */
const SHORT_QUERY_MS = 10_000;
const RUN_QUERY_MS = 15_000;
/** Outcomes an owner's client may answer with; anything else counts as no answer. */
const OWNER_OUTCOMES = new Set(["used", "declined", "timedOut", "closed", "cancelled"]);

const open = new Map();   // promptId -> {resolve, user, local, actorName, abilities, deadline, timer}
const queues = new Map(); // reactor actor uuid -> Promise (tail of its prompt chain)

const clampMs = (v, min, max) => Math.min(max, Math.max(min, Math.round(Number(v) || 0)));

function ownsActor(user, actor) {
  try {
    return !!actor?.testUserPermission?.(user, "OWNER");
  } catch (_err) {
    return false;
  }
}

/** Active non-GM owners of an actor, the user whose character it is first (as S/turn/saves.mjs:46-50). */
export function ownersOf(actor) {
  if (!actor) return [];
  const users = game.users?.filter?.(u => !u.isGM && u.active && ownsActor(u, actor)) ?? [];
  return [...users].sort((a, b) => Number(b.character?.id === actor.id) - Number(a.character?.id === actor.id));
}

/** Who answers for a reactor: {user, local, none, why}. local = the active GM's own dialog. */
export function recipientFor(actor) {
  const owners = ownersOf(actor);
  if (owners.length) return { user: owners[0], local: false, none: false, why: "owner" };
  if (!actor?.hasPlayerOwner) {
    return setting("triggerNpcs") ? { user: null, local: true, none: false, why: "director" } : { user: null, local: false, none: true, why: "npcsOff" };
  }
  return setting("triggerFallback") === "director"
    ? { user: null, local: true, none: false, why: "fallback" }
    : { user: null, local: false, none: true, why: "ownerOffline" };
}

/** The offered option an answer names, or null. */
const optionOf = (request, id) => (request.options ?? []).find(o => o.id === id) ?? null;

/** Spend as the option allows it: none without a spend, always with a required one (review conc / §6.13). */
function spendFor(option, asked) {
  if (!option?.spend) return false;
  return option.spend.required ? true : !!asked;
}

/**
 * Ask one reactor (§3.4). Shows the GM indicator meanwhile. Resolves, never rejects.
 * @param {Actor} actor
 * @param {PromptRequest} request          promptId, options, intro, title (timeoutMs / deadline filled here)
 * @param {{signal?: AbortSignal, timeoutMs?: number, recipient?: object, onFirstPrompt?: () => Promise<void>}} [opts]
 * @returns {Promise<PromptAnswer>}
 */
export async function promptReactor(actor, request, opts = {}) {
  const { signal = null, timeoutMs, recipient = null, onFirstPrompt = null } = opts ?? {};
  try {
    if (signal?.aborted) return { outcome: "cancelled", by: null, at: clock.now() };
    const t = clampMs(timeoutMs ?? promptMs(), 1_000, 120_000);
    request.timeoutMs = t;
    request.deadline = clock.now() + t;
    const { user = null, local = false, none = false } = recipient ?? recipientFor(actor);
    if (none || (!local && !user)) return { outcome: "noAnswer", by: null, at: clock.now() };
    // The hold marker write, once per offer, right before the first prompt is actually sent (review conc 4).
    try {
      await onFirstPrompt?.();
    } catch (err) {
      error("triggers.firstPrompt", err);
    }
    if (signal?.aborted) return { outcome: "cancelled", by: null, at: clock.now() };
    // The marker write took time: the GM keeps the owner's deadline (the dialog closes itself there).
    const left = Math.max(0, request.deadline - clock.now());

    const abilities = [...new Set((request.options ?? []).map(o => o.abilityName).filter(Boolean))];
    const entry = { resolve: null, user, local, actorName: actor?.name ?? request.reactor?.name ?? "", abilities, deadline: request.deadline, timer: null };
    const cancelP = new Promise(resolve => {
      entry.resolve = resolve;
      signal?.addEventListener?.("abort", () => resolve({ outcome: "cancelled" }), { once: true });
    });
    open.set(request.promptId, entry);
    showWaiting(request.promptId, {
      actorName: entry.actorName, abilities, deadline: request.deadline,
      onRelease: () => cancelPrompt(request.promptId, "released"),
    });
    log("trigger.prompt", { promptId: request.promptId, reactor: entry.actorName, to: local ? "director" : user.name, options: abilities, ms: t });

    const asked = local
      ? openTriggerDialog(request)
      : user.query(QUERY_PROMPT, request, { timeout: t + QUERY_SLACK_MS });
    const answerP = Promise.resolve(asked)
      .catch(err => ({ outcome: "error", why: String(err?.message ?? err) }))
      .then(a => ({ ...(a ?? { outcome: "closed" }), fromOwner: true }));
    const timerP = new Promise(resolve => {
      entry.timer = clock.setTimeout(() => resolve({ outcome: "timedOut", why: "gmDeadline" }), left + GM_SLACK_MS);
    });

    let raw = await Promise.race([answerP, timerP, cancelP]);
    open.delete(request.promptId);
    clearWaiting(request.promptId);
    clock.clearTimeout(entry.timer);

    // Every outcome the owner did not give closes the owner's dialog (review conc 12).
    if (!raw.fromOwner) {
      if (local) closeTriggerDialog(request.promptId, raw.outcome);
      else if (user.active !== false) {
        Promise.resolve()
          .then(() => user.query(QUERY_PROMPT, { type: "triggerCancel", promptId: request.promptId }, { timeout: SHORT_QUERY_MS }))
          .catch(err => debug("trigger.cancelFailed", { promptId: request.promptId, why: String(err?.message ?? err) }));
      }
    }
    if (raw.fromOwner && raw.outcome !== "error" && !OWNER_OUTCOMES.has(raw.outcome)) raw = { outcome: "error", why: "badAnswer" };
    let option = null;
    if (raw.outcome === "used") {
      option = optionOf(request, raw.optionId);
      if (!option) raw = { outcome: "error", why: "unknownOption" };
    }
    // A player who dropped mid-prompt (or sent nonsense): no reaction, no fallback (decision 4).
    if (raw.outcome === "error") {
      debug("trigger.promptError", { promptId: request.promptId, why: raw.why ?? null });
      raw = { ...raw, outcome: "noAnswer" };
    }
    const answer = {
      outcome: raw.outcome,
      optionId: option ? option.id : null,
      spend: option ? spendFor(option, raw.spend) : false,
      mute: raw.outcome === "declined" && !!raw.mute && !!request.canMute,
      by: local ? game.userId : user.id,
      at: clock.now(),
    };
    log("trigger.answer", { promptId: request.promptId, outcome: answer.outcome, optionId: answer.optionId, spend: answer.spend, mute: answer.mute, why: raw.why ?? null });
    return answer;
  } catch (err) {
    error("triggers.promptReactor", err, { promptId: request?.promptId });
    if (request?.promptId) {
      open.delete(request.promptId);
      clearWaiting(request.promptId);
    }
    return { outcome: "noAnswer", optionId: null, spend: false, mute: false, by: null, at: clock.now() };
  }
}

/** Release (indicator button, api.triggers.release) = declined; any other reason = cancelled. */
export function cancelPrompt(promptId, why = "cancelled") {
  const entry = open.get(promptId);
  if (!entry?.resolve) return false;
  entry.resolve({ outcome: why === "released" ? "declined" : "cancelled", why });
  return true;
}

export function openPrompts() {
  return [...open.entries()].map(([promptId, e]) => ({ promptId, reactorName: e.actorName, abilities: [...e.abilities], deadline: e.deadline }));
}

/** One promise chain per reactor actor (as S/turn/saves.mjs:70-85): a reactor never has two prompts open. */
export function withReactorQueue(actorUuid, fn) {
  const key = actorUuid ?? "";
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(() => fn());
  const tail = run.catch(() => {}).finally(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  queues.set(key, tail);
  return run;
}

/** Start a follow-up on a user's client (GM local when user is null or the active GM). Resolves {started}. */
export async function runFollowUp(user, payload) {
  const request = { ...(payload ?? {}), type: "triggerRun" };
  try {
    if (!user || user.isSelf || user.id === game.userId) {
      const r = await handleTriggerRun(request, { user: game.user });
      return { started: !!r?.started };
    }
    if (user.active === false) return { started: false };
    const r = await user.query(QUERY_PROMPT, request, { timeout: RUN_QUERY_MS });
    return { started: !!r?.started };
  } catch (err) {
    debug("trigger.runFailed", { kind: request.kind, user: user?.name ?? null, why: String(err?.message ?? err) });
    return { started: false };
  }
}

/**
 * Active GM: a recipient who disconnects while asked counts as no answer at once (§6.6), instead of
 * waiting for the query socket to time out.
 */
export function registerPromptGM() {
  Hooks.on("userConnected", (user, connected) => {
    try {
      if (connected || !game.users?.activeGM?.isSelf) return;
      for (const [promptId, entry] of open) {
        if (entry.local || entry.user?.id !== user?.id) continue;
        entry.resolve?.({ outcome: "noAnswer", why: "userLeft" });
        log("trigger.userLeft", { promptId, user: user?.name });
      }
    } catch (err) {
      error("triggers.userConnected", err);
    }
  });
}
