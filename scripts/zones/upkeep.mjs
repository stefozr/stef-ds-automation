/**
 * Milestone 7 (docs/M7-DESIGN.md §1.8, §2.1 WP-B, §3.10.10, D7): Persistent upkeep of zones, summons/upkeep.mjs for
 * zones. At the creator's turn start the registry's lifecycle listener calls `offerZoneUpkeep` (fire-and-forget: the
 * lifecycle queue never waits on a prompt). The creator's owner is asked through the prompt router (type
 * `zoneUpkeep`, WP-C's `S/ui/zone-prompts.mjs` opens the M6 dialog with the zone texts) with a countdown
 * (`summonUpkeepSeconds`); Keep pays through a `resource` row on a small record card (heroic −cost, synthetic, self,
 * undoable; `applyResource` runs it on the creator's resource chain) and patches `upkeptRound`; any other answer,
 * no owner online, a creator who cannot pay or an NPC creator lets the zone go (`expired`).
 *
 * - One open prompt per zone (`open`, by zoneId). `cancelZoneUpkeep(id, why)` resolves it: with "turnEnd",
 *   "dismissed", "encounterEnd" or "undone" the caller owns what happens next (turnEnd: the registry ends the zone;
 *   dismissed / encounterEnd: the end is running; undone: DSLF's "Undo Last Activation" came back, the zone stays and
 *   the next turn start asks again).
 * - Timing as M6: the owner's dialog closes itself at `deadline`, the GM gives up at `timeoutMs + 3 s`, the query
 *   socket at `timeoutMs + 10 s`; every outcome the owner did not give closes the owner's dialog
 *   (`zoneUpkeepCancel`). A recipient who disconnects answers at once.
 * - Keep is paid ON the zone chain, re-checked there (region present, not ending, combat started, still affordable),
 *   so a concurrent end is never charged; the card is new (nobody holds its lock). A "cannot pay" found on the chain
 *   ends the zone after the chain step (endZone queues on the same chain).
 *
 * i18n keys used here: DSAUTO.Zone.UpkeepCard, DSAUTO.Zone.UpkeepNoOwner, DSAUTO.Entry.Resource.heroic.
 */
import { OP_STATUS, QUERY_PROMPT, loc } from "../constants.mjs";
import { opId, targetKey } from "../engine/keys.mjs";
import { postRecordCard } from "../engine/synthetic.mjs";
import { targetFromTokenDoc, tokenDocForActorUuid } from "../engine/targets.mjs";
import { debug, error, log } from "../log.mjs";
import { setting } from "../settings.mjs";
import { whisperGMs } from "../summons/registry.mjs";
import { canPay } from "../summons/upkeep.mjs";
import { clock, ownersOf } from "../triggers/prompt.mjs";
import { ZONE_END, endZone, isEnding, markUpkept, regionOfZone, withZoneChain } from "./registry.mjs";

const GM_SLACK_MS = 3_000;
const QUERY_SLACK_MS = 10_000;
const SHORT_QUERY_MS = 10_000;
/** Answers an owner's client may give; anything else counts as "let it go". */
const OWNER_OUTCOMES = new Set(["keep", "release", "timedOut", "closed", "cancelled"]);
/** Outcomes whose canceller owns what happens next. */
const CALLER_OWNS = new Set(["turnEnd", "dismissed", "encounterEnd", "undone"]);

const open = new Map();   // zoneId -> {promptId, owner, resolve, zoneName, creatorName, deadline, combatId}
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

export function openZoneUpkeeps() {
  return [...open.entries()].map(([zoneId, e]) => ({
    zoneId, promptId: e.promptId, userId: e.owner?.id ?? null, zoneName: e.zoneName, creatorName: e.creatorName, deadline: e.deadline,
  }));
}

/** Resolve an open upkeep prompt as `why`. True when one was open. */
export function cancelZoneUpkeep(zoneId, why = "cancelled") {
  const entry = open.get(zoneId);
  if (!entry?.resolve) return false;
  open.delete(zoneId);
  entry.resolve({ outcome: why });
  return true;
}

/** The record target of the creator (its token on the zone's scene, else any token of it, else the actor). */
function payerTarget(info, creator) {
  const region = regionOfZone(info.zoneId);
  const scene = region?.parent ?? (info.sceneId ? game.scenes?.get?.(info.sceneId) : null);
  const tokenDoc = lookup(info.creatorTokenUuid) ?? scene?.tokens?.find?.(t => t?.actor?.uuid === creator.uuid) ?? tokenDocForActorUuid(creator.uuid);
  const target = targetFromTokenDoc(tokenDoc)
    ?? { key: targetKey(creator.uuid), tokenUuid: null, actorUuid: creator.uuid, name: creator.name, img: creator.img ?? null };
  return { tokenDoc: tokenDoc ?? null, target };
}

/** Keep: re-checked and paid ON the zone chain, so a concurrent end is never charged. */
function payUpkeep(info, { combat, round, creator, owner, cost }) {
  return withZoneChain(async () => {
    if (!regionOfZone(info.zoneId) || isEnding(info.zoneId)) return "gone";
    // The encounter ended meanwhile: no charge after combat.
    if (combat && !game.combats?.get?.(combat.id)?.started) return "gone";
    if (!canPay(creator, cost)) return "cannotPay";
    const { tokenDoc, target } = payerTarget(info, creator);
    const id = opId("zoneUpkeep", info.zoneId, round);
    await postRecordCard({
      title: loc("DSAUTO.Zone.UpkeepCard", { name: info.label }), sourceActor: creator,
      sourceTokenUuid: tokenDoc?.uuid ?? null, targets: { [target.key]: target },
      ops: {
        [id]: {
          opId: id, order: 0, kind: "resource", mode: "auto", status: OP_STATUS.PENDING, synthetic: true, tier: null,
          resource: "heroic", amount: -cost, targetKeys: [target.key], self: true, upkeep: { zoneId: info.zoneId },
        },
      },
      modes: { resources: "auto" }, user: owner ?? game.user,
    });
    await markUpkept(info.zoneId, round);
    return "paid";
  });
}

/**
 * Ask the creator's owner to keep a Persistent zone (fire-and-forget; one open prompt per zone). Active GM.
 * @param {object} info                ZoneInfo (zones/registry.mjs infoOf)
 * @param {{combat: Combat|null, round: number|null}} ctx
 */
export function offerZoneUpkeep(info, { combat = null, round = null } = {}) {
  try {
    if (!isActiveGM() || !info?.zoneId || open.has(info.zoneId)) return;
    const creator = lookup(info.creatorActorUuid);
    const cost = Number(info.upkeep) || 0;
    const zoneName = info.label ?? "";
    const expire = (opts = {}) => endZone(info.zoneId, ZONE_END.EXPIRED, opts).catch(err => error("zones.upkeep", err));
    // An NPC or a creature without a heroic resource: nobody can keep it.
    if (!creator?.system?.hero?.primary || cost <= 0) {
      expire();
      return;
    }
    if (!canPay(creator, cost)) {
      log("zones.upkeep", { zoneId: info.zoneId, outcome: "cannotPay", why: "offer" });
      expire();
      return;
    }
    const owner = ownersOf(creator)[0] ?? null;
    if (!owner) {
      whisperGMs(loc("DSAUTO.Zone.UpkeepNoOwner", { name: zoneName }));
      log("zones.upkeep", { zoneId: info.zoneId, outcome: "noOwner" });
      expire({ quiet: true });
      return;
    }
    const current = Number(creator.system.hero.primary.value) || 0;   // the turn's gain is already in (DSM:3424-3436)
    const t = Math.min(120, Math.max(10, Number(setting("summonUpkeepSeconds") ?? 30) || 30)) * 1000;
    const request = {
      type: "zoneUpkeep", promptId: randomID(), zoneId: info.zoneId, zoneName, creatorName: creator.name ?? "",
      cost, resourceName: creator.system.hero.primary.label || loc("DSAUTO.Entry.Resource.heroic"), current,
      deadline: clock.now() + t, timeoutMs: t,
    };
    // Registered synchronously: a turnEnd or an end right after this call finds it.
    const slot = {
      promptId: request.promptId, owner, resolve: null, zoneName, creatorName: creator.name ?? "", deadline: request.deadline,
      combatId: combat?.id ?? info.combatId ?? null,
    };
    const cancelP = new Promise(resolve => { slot.resolve = resolve; });
    open.set(info.zoneId, slot);
    runOffer(info, { combat, round, creator, owner, cost, request, slot, cancelP, t })
      .catch(err => error("zones.upkeep", err, { zoneId: info.zoneId }))
      .finally(() => {
        if (open.get(info.zoneId) === slot) open.delete(info.zoneId);
      });
  } catch (err) {
    error("zones.upkeep", err, { zoneId: info?.zoneId });
  }
}

async function runOffer(info, { combat, round, creator, owner, cost, request, slot, cancelP, t }) {
  log("zones.upkeepPrompt", { zoneId: info.zoneId, to: owner.name, cost, ms: t });
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
  if (open.get(info.zoneId) === slot) open.delete(info.zoneId);
  // Every outcome the owner did not give closes the owner's dialog.
  if (!raw.fromOwner && owner.active !== false) {
    Promise.resolve()
      .then(() => owner.query(QUERY_PROMPT, { type: "zoneUpkeepCancel", promptId: request.promptId }, { timeout: SHORT_QUERY_MS }))
      .catch(err => debug("zones.upkeepCancelFailed", { promptId: request.promptId, why: String(err?.message ?? err) }));
  }
  const outcome = raw.fromOwner && !OWNER_OUTCOMES.has(raw.outcome) ? "release" : raw.outcome;
  log("zones.upkeep", { zoneId: info.zoneId, outcome, why: raw.why ?? null });
  if (CALLER_OWNS.has(outcome)) return;
  if (outcome !== "keep") {
    await endZone(info.zoneId, ZONE_END.EXPIRED);
    return;
  }
  const paid = await payUpkeep(info, { combat, round, creator, owner, cost });
  if (paid === "cannotPay") {
    log("zones.upkeep", { zoneId: info.zoneId, outcome: "cannotPay", why: "keep" });
    await endZone(info.zoneId, ZONE_END.EXPIRED);
  }
}

/** init (active GM work): userConnected (left) -> the open prompt to that user answers noAnswer. */
export function registerZoneUpkeepGM() {
  if (registered) return;
  registered = true;
  try {
    Hooks.on("userConnected", (user, connected) => {
      try {
        if (connected || !isActiveGM()) return;
        for (const [zoneId, entry] of [...open]) {
          if (entry.owner?.id !== user?.id) continue;
          open.delete(zoneId);
          entry.resolve?.({ outcome: "noAnswer", why: "userLeft" });
          log("zones.upkeepUserLeft", { zoneId, user: user?.name });
        }
      } catch (err) {
        error("zones.upkeepUserLeft", err);
      }
    });
  } catch (err) {
    error("zones.registerUpkeep", err);
  }
}
