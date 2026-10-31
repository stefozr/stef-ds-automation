/**
 * Gain cards and the gain observers (Milestone 7, docs/M7-DESIGN.md §2.1 WP-A, §3.4, §3.5, D4, D14, Q15). Active GM.
 *
 * Gains not caused by our own damage have no card of their own: they become rows of a small public **gain card**
 * (`postRecordCard`, title `DSAUTO.Gain.CardTitle`, record field `gain: {v, source, causeMessageId}`), whose auto rows
 * apply at once through the engine (applyOps -> applyGainOp).
 *
 * Sources (each acted on by the active GM only, each handler catching its own errors):
 * - External damage the GM saw land (resources/stamina-watch.mjs): a `takeDamage` report (`observeExternalReport`, from
 *   holds.mjs externalDone) only adds type and source to a change written by that user (or a GM), after 1.5 s so a
 *   Target Damage record of the same hit wins; Target Damage application records (`updateChatMessage`, GM-written
 *   message flags with type, source, surges and squad pools). A dealer or type only a player vouches for makes the row
 *   wait for the Director (gains.mjs gainMode).
 * - Ability cards (`abilityUse`) and natural power rolls of new chat messages, each message once.
 * - Forced movement (`moveToken` waypoints with action "forced") not made by our engine; a Combat Tools push (one
 *   update per square) is joined while its updates keep coming within 1.2 s.
 * - A hero's death (the defeated status created on a hero), once until that status is removed.
 * If a card cannot be posted, its claims are released.
 * i18n keys: DSAUTO.Gain.CardTitle.
 */
import * as C from "../constants.mjs";
import { OP_STATUS, loc } from "../constants.mjs";
import { applyingMessageFor } from "../engine/engine.mjs";
import { postRecordCard } from "../engine/synthetic.mjs";
import { debug, error, log } from "../log.mjs";
import { setting } from "../settings.mjs";
import { combatFor } from "../triggers/budget.mjs";
import { deathFactOf, externalDamageFact, forcedFactOf, normType, rollFactsOf, total, useFactOf, windedFacts } from "./facts.mjs";
import { planGains, releaseGainClaims } from "./gains.mjs";
import { gainsActive, gainsWant } from "./rules.mjs";
import { consumeChange, findChange } from "./stamina-watch.mjs";

const DSTD_ID = () => C.DSTD_ID ?? "draw-steel-target-damage";
const REPORT_WAIT_MS = 1_500;   // a Target Damage record of the same hit wins (§3.4)
const DSTD_FRESH_MS = 10_000;   // application records older than this are history, not a new hit
const FORCED_IDLE_MS = 1_200;   // a Combat Tools push: one-square updates joined while they keep coming
const MAX_SEEN = 2_000;

const seenMessages = new Set();       // message ids observed (createChatMessage)
const seenApplications = new Set();   // `${messageId}:${opId}:${appliedAt}:${target}`
const deadClaims = new Set();         // `${actorUuid}:${combatId}:dead`
const pushes = new Map();             // token uuid -> {fact, timer}

const isActiveGM = () => !!game.users?.activeGM?.isSelf;
const clock = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) };

/** Bounded "seen" sets (drop the older half). */
function remember(set, key) {
  if (set.has(key)) return false;
  set.add(key);
  if (set.size > MAX_SEEN) {
    let drop = set.size - MAX_SEEN / 2;
    for (const k of set) {
      if (drop-- <= 0) break;
      set.delete(k);
    }
  }
  return true;
}

function lookup(uuid) {
  if (!uuid || typeof uuid !== "string") return null;
  try {
    return fromUuidSync(uuid);
  } catch (_err) {
    return null;
  }
}

/**
 * Post a public gain card: one row per op, targets per gainer; its auto ops apply at once (postRecordCard).
 * @returns {Promise<{messageId, ops}|null>}
 */
export async function postGainCard({ ops, targets, source, causeMessageId = null, title = null } = {}) {
  const list = Array.isArray(ops) ? ops : Object.values(ops ?? {});
  if (!list.length) return null;
  if (!isActiveGM()) {
    releaseGainClaims(list);
    return null;
  }
  const byId = Object.fromEntries(list.map(o => [o.opId, o]));
  const first = list[0];
  const firstTarget = targets?.[first.targetKeys?.[0]] ?? null;
  const sourceActor = lookup(first.gain?.gainerActorUuid);
  let result = null;
  try {
    result = await postRecordCard({
      title: title ?? loc("DSAUTO.Gain.CardTitle"), sourceActor, sourceTokenUuid: firstTarget?.tokenUuid ?? null,
      targets: targets ?? {}, ops: byId, modes: { resources: setting("resourceGains") ?? "auto" },
      meta: { gain: { v: 1, source: source ?? null, causeMessageId: causeMessageId ?? null } },
    });
  } catch (err) {
    releaseGainClaims(list);
    throw err;
  }
  // Rows that ended neither applied nor waiting (vetoed, failed) hold no claim (C22).
  releaseGainClaims(list.filter(o => ![OP_STATUS.APPLIED, OP_STATUS.PENDING].includes(result?.ops?.[o.opId]?.status)));
  log("gains.card", { messageId: result?.messageId ?? null, source, rows: list.length, causeMessageId });
  return result;
}

/** Plan and post one gain card for facts (fire-and-forget callers). */
async function gainCardFor(facts, { source, causeMessageId = null }) {
  if (!facts.length) return null;
  const { ops, targets } = planGains(facts, { origin: "gainCard" });
  if (!ops.length) return null;
  return postGainCard({ ops, targets, source, causeMessageId });
}

/** A GM-observed external change with what else is known about it (type, source, who vouches). Fire-and-forget. */
export function observeExternalDamage(change, { type = "", source = null, vouched = "gm", staminaLoss = false, surges = 0, taker = null, messageId = null } = {}) {
  try {
    if (!isActiveGM() || !gainsActive() || !change) return;
    const fact = externalDamageFact(change, { type, source, vouched, surges, taker, messageId });
    if (!fact) return;
    const facts = staminaLoss ? windedFacts(fact) : [fact, ...windedFacts(fact)];
    gainCardFor(facts, { source: "external", causeMessageId: messageId })
      .catch(err => error("gains.external", err));
  } catch (err) {
    error("gains.external", err);
  }
}

/**
 * holds.mjs externalDone (active GM): match a takeDamage report to a change the GM saw (stamina-watch findChange),
 * 1.5 s later (a Target Damage record of the same hit consumes the change first). Never throws.
 */
export function observeExternalReport(report, user) {
  try {
    if (!isActiveGM() || !report?.applied || !report.after || !user?.id) return;
    const r = { ...report };
    // A report a non-active GM forwarded (holds.mjs externalDone) names the user who reported it to that GM: only a GM's
    // forward is believed; the change must still be that reporter's write (or a GM's).
    const reporter = (user.isGM && typeof r.reporter === "string" ? game.users?.get?.(r.reporter) : null) ?? user;
    clock.setTimeout(() => {
      try {
        const group = typeof r.groupUuid === "string" ? r.groupUuid : null;
        const change = findChange({ actorUuid: r.actorUuid ?? null, groupUuid: group, after: group ? null : total(r.after), userId: reporter.id });
        if (!change || !consumeChange(change)) {
          debug("gains.reportUnmatched", { actorUuid: r.actorUuid, groupUuid: group, user: reporter.name });
          return;
        }
        observeExternalDamage(change, {
          type: normType(r.type), source: r.source ?? null, staminaLoss: !!r.staminaLoss, vouched: reporter.isGM ? "gm" : "player",
          taker: group ? { actorUuid: r.actorUuid ?? null, tokenUuid: r.tokenUuid ?? null } : null,
        });
      } catch (err) {
        error("gains.report", err);
      }
    }, REPORT_WAIT_MS);
  } catch (err) {
    error("gains.report", err);
  }
}

/* -------------------------------------------- */
/*  Observers                                   */
/* -------------------------------------------- */

/** Ability cards and natural power rolls of a new message: one gain card per message. */
function onCreateMessage(message) {
  if (!isActiveGM() || !message?.id || !gainsActive()) return;
  const sceneId = message.speaker?.scene ?? null;
  const wantUse = gainsWant("abilityUse", sceneId);
  const wantRoll = gainsWant("naturalRoll", sceneId);
  if (!wantUse && !wantRoll) return;
  if (!remember(seenMessages, message.id)) return;
  const facts = [];
  const use = wantUse ? useFactOf(message) : null;
  if (use) facts.push(use);
  if (wantRoll) facts.push(...rollFactsOf(message));
  if (!facts.length) return;
  gainCardFor(facts, { source: use ? "abilityUse" : "roll", causeMessageId: message.id })
    .catch(err => error("gains.cardObserver", err));
}

/** Target Damage application records of a message (§3.4 (b)): each new damage record with a watched change. */
function onUpdateMessage(message, changed, userId) {
  if (!isActiveGM() || !message?.id) return;
  const id = DSTD_ID();
  if (!changed?.flags?.[id]) return;
  const state = message.flags?.[id]?.state;
  const apps = state?.applications;
  if (!apps || typeof apps !== "object") return;
  const writerIsGM = !!game.users?.get?.(userId)?.isGM;
  const now = Date.now();
  for (const [opId, app] of Object.entries(apps)) {
    const records = Array.isArray(app?.records) ? app.records : [app];
    for (const rec of records) {
      if (rec?.kind !== "damage" || rec.status !== "applied" || !rec.after || !rec.before) continue;
      const at = Number(rec.appliedAt) || 0;
      if (!at || now - at > DSTD_FRESH_MS) continue;
      const targetId = rec.target?.tokenUuid ?? rec.target?.actorUuid ?? "";
      if (!remember(seenApplications, `${message.id}:${opId}:${at}:${targetId}`)) continue;
      const tokenDoc = lookup(rec.target?.tokenUuid);
      const actor = tokenDoc?.actor ?? lookup(rec.target?.actorUuid);
      if (!actor) continue;
      const sceneId = tokenDoc?.parent?.id ?? null;
      if (!gainsWant("damage", sceneId) && !gainsWant("winded", sceneId)) continue;
      const pool = rec.before?.groupedMinion ? (rec.before.groupUuid ?? null) : null;
      const change = findChange({
        actorUuid: pool ? null : actor.uuid, groupUuid: pool, after: pool ? Number(rec.after.value) || 0 : total(rec.after),
        userId: rec.appliedByUserId ?? userId,
      });
      // No change seen: a forged or stale flag write moves no Stamina.
      if (!change || !consumeChange(change)) {
        debug("gains.dstdUnmatched", { messageId: message.id, opId, actor: actor.name });
        continue;
      }
      observeExternalDamage(change, {
        type: normType(rec.damageType), source: { actorUuid: state.sourceActorUuid ?? null, tokenUuid: state.sourceTokenUuid ?? null },
        vouched: writerIsGM ? "gm" : "player", surges: (Number(rec.surgeSpend?.surges) || 0) + (Number((message.system?.parts?.get?.(rec.partId)?.rolls?.[Number(rec.rollIndex)] ?? message.rolls?.[Number(rec.rollIndex)])?.options?.dsAutoNativeSurges) || 0),
        taker: { actorUuid: actor.uuid, tokenUuid: tokenDoc?.uuid ?? null }, messageId: message.id,
      });
    }
  }
}

/** A forced move not made by our engine (§3.5): joined per token while updates come within 1.2 s. */
function onMoveToken(tokenDoc, movement) {
  if (!isActiveGM() || !tokenDoc?.actor) return;
  const fact = forcedFactOf(tokenDoc, movement);
  if (!fact) return;
  if (applyingMessageFor(tokenDoc.actor.uuid)) return;   // our own forced rows are counted from their patches (§3.1)
  if (!gainsWant("forcedMove", fact.sceneId)) return;
  const key = tokenDoc.uuid;
  const open = pushes.get(key);
  if (open) {
    clock.clearTimeout(open.timer);
    open.fact.squares += fact.squares;
  } else pushes.set(key, { fact, timer: null });
  const entry = pushes.get(key);
  entry.timer = clock.setTimeout(() => {
    pushes.delete(key);
    try {
      debug("gains.forced", { token: tokenDoc.name, squares: entry.fact.squares });
      gainCardFor([entry.fact], { source: "forcedMove" }).catch(err => error("gains.forced", err));
    } catch (err) {
      error("gains.forced", err);
    }
  }, FORCED_IDLE_MS);
}

const defeatedId = () => globalThis.CONFIG?.specialStatusEffects?.DEFEATED ?? "dead";
const hasDefeated = effect => {
  const st = effect?.statuses;
  return !!(st?.has?.(defeatedId()) || (Array.isArray(st) && st.includes(defeatedId())));
};

/** A hero's death: the defeated status created on a hero (once until removed). */
function onCreateEffect(effect) {
  if (!isActiveGM() || !hasDefeated(effect)) return;
  const actor = effect.parent;
  if (actor?.documentName !== "Actor" && !actor?.system) return;
  if (actor?.type !== "hero" || !gainsActive()) return;
  const fact = deathFactOf(actor, { causeMessageId: applyingMessageFor(actor.uuid) });
  if (!fact || !gainsWant("heroDeath", fact.sceneId)) return;
  const combat = combatFor(fact.sceneId);
  if (!combat?.started) return;
  const claim = `${actor.uuid}:${combat.id}:dead`;
  if (deadClaims.has(claim)) return;
  deadClaims.add(claim);
  gainCardFor([fact], { source: "death", causeMessageId: fact.causeMessageId })
    .catch(err => error("gains.death", err));
}

function onDeleteEffect(effect) {
  if (!hasDefeated(effect)) return;
  const uuid = effect.parent?.uuid;
  if (!uuid) return;
  for (const k of [...deadClaims]) if (k.startsWith(`${uuid}:`)) deadClaims.delete(k);
}

/**
 * init: createChatMessage (ability cards, power rolls), updateChatMessage (Target Damage application records, §3.4),
 * moveToken (forced moves), createActiveEffect / deleteActiveEffect (deaths).
 */
export function registerGainObservers() {
  Hooks.on("createChatMessage", message => {
    try {
      onCreateMessage(message);
    } catch (err) {
      error("gains.cardObserver", err);
    }
  });
  Hooks.on("updateChatMessage", (message, changed, _options, userId) => {
    try {
      onUpdateMessage(message, changed, userId);
    } catch (err) {
      error("gains.dstdObserver", err);
    }
  });
  Hooks.on("moveToken", (tokenDoc, movement) => {
    try {
      onMoveToken(tokenDoc, movement);
    } catch (err) {
      error("gains.forced", err);
    }
  });
  Hooks.on("createActiveEffect", effect => {
    try {
      onCreateEffect(effect);
    } catch (err) {
      error("gains.death", err);
    }
  });
  Hooks.on("deleteActiveEffect", effect => {
    try {
      onDeleteEffect(effect);
    } catch (err) {
      error("gains.death", err);
    }
  });
  Hooks.on("deleteCombat", combat => {
    try {
      for (const k of [...deadClaims]) if (k.includes(`:${combat?.id}:`)) deadClaims.delete(k);
    } catch (err) {
      error("gains.deleteCombat", err);
    }
  });
}

/** Test seam (harness: scripted timers). */
export const gainCardClock = clock;
