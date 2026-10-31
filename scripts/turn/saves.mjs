/**
 * Saving throws at the end of a turn (Milestone 2).
 *
 * The system's `_onEndTurn` (draw-steel.mjs:12094-12103, deduplicated by turn/lifecycle.mjs) calls
 * `SavingThrowManager.delegateSavingThrow(effect)` for every "save ends" effect, without awaiting.
 * We wrap that static method (MIXED) and roll by policy:
 *   - creatures with a player owner (world setting `heroSaves`, default "prompt"): the owner's client
 *     opens the system's own save dialog through `CONFIG.queries["stef-ds-automation.prompt"]`; if nobody
 *     answers within `savePromptSeconds` the Director's client rolls (`saveFallback`). A player who
 *     closes the dialog declines the save (no fallback roll).
 *   - the Director's creatures (`npcSaves`, default "auto"): rolled at once, no dialog.
 *   - "system" leaves the system's routine in place.
 * Prompts for one creature come one after another. Our cards carry the system's `savingThrow` part,
 * so the hero-token button works on them (and on the system's own save cards via the toMessage fix).
 * Never vetoes `ds.canRenderSavingThrowDialog` (that leaves the caller hanging).
 */
import { HOOKS, MODULE_ID, QUERY_PROMPT, loc } from "../constants.mjs";
import { registerPromptType } from "../relay/prompt-router.mjs";
import { wrap } from "../compat/lib-wrapper.mjs";
import { debug, error, log, warn } from "../log.mjs";
import { setting } from "../settings.mjs";

const PART_ID = "savingThrow".padEnd(16, "0");
const inFlight = new Map(); // effect uuid -> Promise<boolean>
const actorQueues = new Map(); // actor uuid -> Promise

export const installedSaves = { delegate: false };

export function registerSaves() {
  // Milestone 5: the prompt query is a router by payload type (relay/prompt-router.mjs); saves are type "save".
  registerPromptType("save", handlePrompt);
  installedSaves.delegate = wrap("ds.applications.apps.SavingThrowManager.delegateSavingThrow", delegateWrapper, "MIXED");
}

/** The creature an effect sits on (the system's `effect.target`, else the parent actor). */
export function effectActor(effect) {
  const t = effect?.target;
  return t?.documentName === "Actor" ? t : (effect?.actor ?? null);
}

/** "prompt" | "auto" | "system" for this effect. */
export function savePolicy(effect) {
  const actor = effectActor(effect);
  return actor?.hasPlayerOwner ? setting("heroSaves") : setting("npcSaves");
}

/** Active non-GM owners; the user whose character this is comes first. */
export function activeOwners(effect) {
  const actor = effectActor(effect);
  const users = (game.users?.filter?.(u => !u.isGM && u.active && effect.testUserPermission(u, "OWNER")) ?? []);
  return users.sort((a, b) => Number(b.character?.id === actor?.id) - Number(a.character?.id === actor?.id));
}

/** @this {typeof SavingThrowManager} */
async function delegateWrapper(wrapped, effect, ...rest) {
  // The system throws for non-GM callers; keep that.
  if (!game.user?.isGM || !setting("enabled")) return wrapped(effect, ...rest);
  let policy = "system";
  try {
    policy = savePolicy(effect);
  } catch (err) {
    error("saves.policy", err);
  }
  if (policy === "system" || !effect?.uuid) return wrapped(effect, ...rest);
  return runSave(effect, policy);
}

/**
 * Roll one save by policy (active GM). One run per effect at a time; one creature's saves in order.
 * @returns {Promise<boolean>} success
 */
export function runSave(effect, policy = savePolicy(effect)) {
  if (inFlight.has(effect.uuid)) return inFlight.get(effect.uuid);
  const actorKey = effectActor(effect)?.uuid ?? effect.uuid;
  const prev = actorQueues.get(actorKey) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(() => saveOnce(effect, policy));
  const tracked = run.catch(err => {
    error("saves.run", err, { effect: effect.uuid });
    return false;
  }).finally(() => {
    inFlight.delete(effect.uuid);
    if (actorQueues.get(actorKey) === tracked) actorQueues.delete(actorKey);
  });
  inFlight.set(effect.uuid, tracked);
  actorQueues.set(actorKey, tracked);
  return tracked;
}

async function saveOnce(effect, policy) {
  // The effect may have ended or been removed while waiting in the queue.
  const live = fromUuidSync(effect.uuid);
  if (!live || live.duration?.expired || live.duration?.expiry !== "save") return false;
  if (effectActor(live)?.statuses?.has?.("dead")) return false;
  if (Hooks.call(HOOKS.preSave, live, { policy }) === false) {
    log("save.vetoed", { effect: live.name });
    return false;
  }
  let result = null;
  if (policy === "prompt") {
    const owner = activeOwners(live)[0] ?? null;
    if (owner) {
      result = await promptOwner(owner, live);
      if (result?.cancelled) {
        log("save.declined", { effect: live.name, user: owner.name });
        Hooks.callAll(HOOKS.save, live, { product: false, declined: true, by: owner.id, policy });
        return false;
      }
      if (!result?.rolled) warn("save.noAnswer", { effect: live.name, user: owner.name, reason: result?.reason ?? "timeout" });
    }
    if (!result?.rolled) {
      // The owner may have saved (or spent a hero token) after all, or the effect ended meanwhile.
      const now = fromUuidSync(live.uuid);
      if (!now || now.duration?.expired || now.duration?.expiry !== "save") {
        log("save.resolvedMeanwhile", { effect: live.name, expired: !!now?.duration?.expired, deleted: !now });
        const product = !now || !!now.duration?.expired;
        Hooks.callAll(HOOKS.save, live, { product, resolvedMeanwhile: true, policy });
        return product;
      }
      result = await fallbackRoll(now, owner ? "noAnswer" : "noOwner");
    }
  } else {
    result = await autoRoll(live);
  }
  const product = !!result?.product;
  log("save.result", { effect: live.name, actor: effectActor(live)?.name, policy, product, total: result?.total ?? null, by: result?.by ?? null });
  Hooks.callAll(HOOKS.save, live, { ...result, product, policy });
  return product;
}

/** GM: ask the owner's client to roll. Resolves `{rolled, product, messageId}` | `{cancelled}` | `{reason}`. */
async function promptOwner(user, effect) {
  const timeoutMs = Math.max(10, Number(setting("savePromptSeconds")) || 60) * 1000;
  try {
    const answer = await user.query(QUERY_PROMPT, { type: "save", effectUuid: effect.uuid, timeoutMs }, { timeout: timeoutMs + 10_000 });
    if (answer?.rolled) return { rolled: true, product: !!answer.product, total: answer.total ?? null, messageId: answer.messageId ?? null, by: user.id };
    if (answer?.cancelled) return { cancelled: true };
    return { rolled: false, reason: answer?.timedOut ? "timeout" : "noRoll" };
  } catch (err) {
    debug("save.promptFailed", { user: user.name, error: String(err?.message ?? err) });
    return { rolled: false, reason: "error" };
  }
}

async function fallbackRoll(effect, why) {
  if (setting("saveFallback") === "dialog") {
    const message = await effect.system.rollSave();
    const roll = message?.rolls?.[0];
    return { rolled: !!message, product: !!roll?.product, total: roll?.total ?? null, messageId: message?.id ?? null, by: game.userId, fallback: why };
  }
  return autoRoll(effect, { note: loc(`DSAUTO.Save.Note.${why}`) });
}

/**
 * Roll a save without a dialog (the formula and threshold the system's dialog defaults to) and post
 * it with the system's savingThrow part. Success marks the effect expired, like `rollSave`.
 */
export async function autoRoll(effect, { note = "" } = {}) {
  const SavingThrowRoll = ds.rolls.SavingThrowRoll;
  const actor = effectActor(effect);
  const rollData = effect.getRollData?.() ?? actor?.getRollData?.() ?? {};
  const formula = SavingThrowRoll.replaceFormulaData(effect.system?.end?.roll || "1d10", rollData);
  const successThreshold = foundry.utils.getProperty(actor ?? {}, "system.combat.save.threshold") ?? 6;
  const flavor = loc("DSAUTO.Save.Flavor", { name: effect.name });
  // No `flavor` roll option: core would write it into the formula ("1d10[flavor]"); the part shows it.
  const roll = new SavingThrowRoll(formula, rollData, { successThreshold });
  await roll.evaluate();
  if (roll.product) await effect.update({ "duration.expired": true });
  const message = await postSave(effect, actor, roll, { flavor: note ? `${flavor} (${note})` : flavor, auto: true });
  return { rolled: true, product: !!roll.product, total: roll.total, messageId: message?.id ?? null, by: game.userId, auto: true };
}

function saveMessageMode(actor) {
  if (actor?.hasPlayerOwner) return "public";
  const mode = setting("npcSaveMessageMode");
  return mode && mode !== "default" ? mode : game.settings.get("core", "messageMode");
}

async function postSave(effect, actor, roll, { flavor, auto }) {
  const Cls = getDocumentClass("ChatMessage");
  const data = {
    type: "standard",
    author: game.user.id,
    speaker: Cls.getSpeaker({ actor }),
    rolls: [roll],
    sound: CONFIG.sounds?.dice,
    system: { parts: { [PART_ID]: { _id: PART_ID, type: "savingThrow", effectUuid: effect.uuid, flavor, rolls: [roll] } } },
    flags: { [MODULE_ID]: { save: { effectUuid: effect.uuid, product: !!roll.product, auto } } },
  };
  const msg = new Cls(data);
  msg.applyMode?.(saveMessageMode(actor));
  return Cls.create(msg);
}

/* -------------------------------------------- */
/*  Owner side                                   */
/* -------------------------------------------- */

/** Close the system's save dialog for this effect (prompt timed out). */
function closeSaveDialog(effect) {
  const Dialog = globalThis.ds?.applications?.apps?.SavingThrowDialog;
  for (const app of foundry.applications.instances?.values?.() ?? []) {
    if (Dialog && !(app instanceof Dialog)) continue;
    const e = app.options?.context?.effect;
    if (e === effect || (e?.uuid && e.uuid === effect.uuid)) app.close();
  }
}

/** Query handler on the owner's client: open the system's save dialog for the effect. */
export async function handlePrompt(payload, { user } = {}) {
  if (!user?.isGM) throw new Error("DSAUTO.Relay.Denied");
  if (payload?.type !== "save" || typeof payload.effectUuid !== "string") throw new Error("DSAUTO.Relay.BadRequest");
  const effect = await fromUuid(payload.effectUuid);
  if (!effect?.isOwner) throw new Error("DSAUTO.Relay.Denied");
  const timeoutMs = Math.min(Math.max(Number(payload.timeoutMs) || 60_000, 5_000), 300_000);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    closeSaveDialog(effect);
  }, timeoutMs);
  try {
    const message = await effect.system.rollSave();
    if (!message) return timedOut ? { rolled: false, timedOut: true } : { rolled: false, cancelled: true };
    const roll = message.rolls?.[0];
    return { rolled: true, product: !!roll?.product, total: roll?.total ?? null, messageId: message.id ?? message._id ?? null };
  } finally {
    clearTimeout(timer);
  }
}
