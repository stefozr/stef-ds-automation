/**
 * View model of the resolution section. Pure: derived from the persisted record on every client,
 * no client-side planning. Numbers that would reveal NPC immunities or characteristics stay hidden
 * from players who do not own the target (setting `hideNpcNumbersFromPlayers`). Buttons follow the
 * relay's authorization rules (relay/auth.mjs); the active GM checks them again on every request.
 * Milestone 5: who halved a row or changed its potency through a triggered action, the Director-only notes
 * of reactions that did not happen, a "still spent" note with an "Undo triggered action" button on an undone
 * row, the trigger card's budget and spend rows, and a "Waiting for triggered actions" banner while held.
 * Milestone 6: summon rows (what, how far, who places it, per viewer; once applied the names, how many, its turn,
 * why it went), the Summon button (the clicking client picks the squares) and a Dismiss button.
 * Milestone 7: gain rows (resource, rule, "now N", a roll, "waits for the Director"), gain-only gainer records, zone
 * rows (area, range, lasts, who places it; once placed its squares; why it went) with Place and Dismiss buttons,
 * hero-token heal rows, Malice / hero-token rows and the villain-action banners.
 * Milestone 9: the Persistent banners (what keeping the use does and its cost; "no essence spent" on a free re-roll).
 */
import { OP_STATUS, loc } from "../constants.mjs";
import { setting } from "../settings.mjs";
import {
  canApplyStatus, canUndoStatus, isAuthor, isOwnSummon, isOwnZone, isSelfTeleport, mayAct, mayDismissRow, mayDismissZone, mayResolve,
  mayRetarget, maySurge, zoneEnded,
} from "../relay/auth.mjs";
import { ownButtonOnly } from "../engine/record.mjs";
import { zoneReasonText } from "../zones/place.mjs";
import {
  MAX_SURGES, POTENCY_SURGE_COST, availableSurges, liveSurgeOps, potencySurgeable, surgeActor, surgeDamage, surgeableDamage,
} from "../engine/surges.mjs";
import { chosenDistance, chosenMovement, needsChoice, pickOnApply } from "../engine/forced.mjs";
import { effectiveUntil } from "../engine/record.mjs";
import { triggerHalved } from "../triggers/holds.mjs";
import { triggerCardsFor } from "../triggers/card.mjs";
import { summonReasonText } from "../summons/place.mjs";
import { keepKeyOf as persistentKeepKey } from "../persistent/registry.mjs";
import { dstdActive, dstdState } from "../compat/dstd.mjs";
import { shouldFoldPanel } from "../ui/dstd-fold.mjs";
import { heroRerollShown } from "../resources/hero-token-reroll.mjs";

/**
 * Compact card: name + label + the chip shown up to this long share one line with the icons and buttons (about 100 px
 * of text in the sidebar). 0.14.2: the chip counts ("Resource gain" left the label no room; a "T2" chip as before).
 */
const ONE_LINE_CHARS = 20;

/** An unresolved card older than this offers its author "Resolve now" (younger: resolution is in flight). */
const AUTHOR_RESOLVE_AFTER_MS = 5_000;

const serverNow = () => game.time?.serverTime ?? Date.now();

const holdRenders = new Map();   // messageId -> timer: re-render once the card's hold ran out

/** Re-render this card once (server time) `at` has passed. One timer per card. */
function rerenderAfter(message, at) {
  const id = message?.id;
  if (!id || holdRenders.has(id)) return;
  const ms = Math.min(Math.max(0, at - serverNow()) + 250, 2_147_000_000);
  const timer = setTimeout(() => {
    holdRenders.delete(id);
    const m = game.messages?.get?.(id);
    if (m) globalThis.ui?.chat?.updateMessage?.(m)?.catch?.(() => {});
  }, ms);
  timer?.unref?.();   // Node (offline tests) only
  holdRenders.set(id, timer);
}
/** Reactions that did not happen, shown to the Director only (Milestone 5). */
const QUIET_OUTCOMES = new Set(["declined", "timedOut", "noAnswer", "closed", "moot"]);
const signed = n => (Number(n) > 0 ? `+${Number(n)}` : String(Number(n) || 0));

const STATUS_ICONS = {
  pending: "fa-solid fa-hourglass-half",
  applied: "fa-solid fa-check",
  undone: "fa-solid fa-rotate-left",
  skipped: "fa-solid fa-ban",
  failed: "fa-solid fa-triangle-exclamation",
  external: "fa-solid fa-check-double",
};

const KIND_ICONS = {
  damage: "fa-solid fa-burst",
  heal: "fa-solid fa-heart-pulse",
  temp: "fa-solid fa-shield-heart",
  condition: "fa-solid fa-person-rays",
  forced: "fa-solid fa-person-walking-arrow-right",
  teleport: "fa-solid fa-person-through-window",
  hide: "fa-solid fa-user-ninja",
  modifier: "fa-solid fa-sliders",
  auraOption: "fa-solid fa-brain",
  auraActivation: "fa-solid fa-circle-nodes",
  cleanse: "fa-solid fa-hand-sparkles",
  resource: "fa-solid fa-bolt",
  note: "fa-solid fa-circle-info",
  budget: "fa-solid fa-stopwatch",
  summon: "fa-solid fa-person-circle-plus",
  gain: "fa-solid fa-arrow-trend-up",
  zone: "fa-solid fa-draw-polygon",
  pick: "fa-solid fa-crosshairs",
};

/** Kinds whose rows have an Edit button (engine editOverride; cleanse rows choose through Apply). */
const EDITABLE = new Set(["damage", "heal", "temp", "forced"]);

/** Does applying this cleanse row need a choice of effects first? */
export const cleanseNeedsChoice = op => op.kind === "cleanse" && op.count != null
  && !op.override?.effects?.length && (op.reason === "chooseEffects" || (op.candidates ?? 0) > op.count);

function statusName(id) {
  const s = globalThis.CONFIG?.statusEffects?.[id] ?? globalThis.CONFIG?.statusEffects?.find?.(e => e.id === id);
  return s?.name ? game.i18n.localize(s.name) : id;
}

function endName(end) {
  const cfg = ds.CONFIG.effectEnds?.[end];
  return cfg?.abbreviation ? game.i18n.localize(cfg.abbreviation) : end;
}

function cleanseLabel(op) {
  const what = [...(op.statuses ?? []).map(statusName), ...(op.ends ?? []).map(endName)].join(", ");
  return op.count != null ? loc("DSAUTO.Card.CleanseCount", { count: op.count, what }) : loc("DSAUTO.Card.Cleanse", { what });
}

/** Localized name of a forced movement type ("Push", or "Vertical Push"). */
export function movementLabel(movement, vertical = false) {
  const cfg = ds.CONFIG.abilities?.forcedMovement?.[movement];
  const key = vertical ? (cfg?.vertical ?? cfg?.label) : cfg?.label;
  return key ? game.i18n.localize(key) : movement;
}

function forcedLabel(op) {
  const chosen = chosenMovement(op);
  if (chosen) return loc("DSAUTO.Card.Forced", { movement: movementLabel(chosen, op.vertical), distance: chosenDistance(op) });
  return (op.movements ?? [])
    .map(m => loc("DSAUTO.Card.Forced", { movement: movementLabel(m, op.vertical), distance: op.distances?.[m] ?? 0 }))
    .join(" / ");
}

/** Heal rows edited into temporary Stamina (and back) show what they will apply. */
function healKind(op) {
  if (op.kind !== "heal" && op.kind !== "temp") return op.kind;
  const temp = op.override?.temp;
  if (typeof temp !== "boolean") return op.kind;
  return temp ? "temp" : "heal";
}

function damageTypeLabel(op) {
  if (op.kind === "damage") {
    const label = ds.CONFIG.damageTypes?.[op.type]?.label;
    return label ? game.i18n.localize(label) : "";
  }
  return "";
}

function canSeeNumbers(res, op) {
  if (game.user.isGM || !setting("hideNpcNumbersFromPlayers")) return true;
  return op.targetKeys.every(k => {
    try {
      return !!fromUuidSync(res.targets?.[k]?.actorUuid)?.isOwner;
    } catch (_err) {
      return false;
    }
  });
}

function conditionName(op) {
  const d = op.display ?? {};
  if (d.nameKey) return game.i18n.localize(d.nameKey);
  return d.name ?? op.effectId;
}

function endLabel(op) {
  const end = op.end ? ds.CONFIG.effectEnds?.[op.end] : null;
  return end?.abbreviation ? game.i18n.localize(end.abbreviation) : "";
}

function potencyText(res, op) {
  const p = op.potency;
  if (!p) return "";
  const key = ds.CONFIG.characteristics?.[p.characteristic]?.rollKey ?? p.characteristic;
  // The resist value is the target's characteristic: hidden like immunities.
  if (!canSeeNumbers(res, op)) return loc(p.fails ? "DSAUTO.Card.PotencyFailsHidden" : "DSAUTO.Card.PotencyResistsHidden", { chr: key, value: p.value });
  return loc(p.fails ? "DSAUTO.Card.PotencyFails" : "DSAUTO.Card.PotencyResists", { chr: key, value: p.value, resist: p.resist });
}

/** The ability targets only its user (Catch Breath, Black Ash Teleport): "Use my targets" has no use. */
function targetsOnlySelf(message) {
  try {
    const uuid = message.system?.parts?.get?.("abilityUse000000")?.abilityUuid;
    return fromUuidSync(uuid ?? "")?.system?.target?.type === "self";
  } catch (_err) {
    return false;
  }
}

/** "+1 Clarity": the hero's own name for their heroic resource when the system prepared one. */
function resourceLabel(res, op) {
  const amount = op.amount ?? 0;
  const named = op.resource === "heroic"
    ? fromUuidSync(res?.targets?.[op.targetKeys?.[0]]?.actorUuid ?? "")?.system?.hero?.primary?.label : null;
  // A cost paid (trigger cards, Milestone 5): "Spends 1 Focus".
  if (amount < 0) return loc("DSAUTO.Trigger.Card.Spend", { amount: -amount, name: named || loc(`DSAUTO.Entry.Resource.${op.resource}`) });
  if (named) return loc("DSAUTO.Card.ResourceNamed", { amount, name: named });
  // "+1 surge" / "+2 surges" (0.9.1).
  if (amount === 1 && op.resource === "surge") return loc("DSAUTO.Card.Resource.surgeOne");
  if (amount === 1 && op.resource === "heroToken") return loc("DSAUTO.Card.Resource.heroTokenOne");
  return loc(`DSAUTO.Card.Resource.${op.resource}`, { amount });
}

/* -------------------------------------------- */
/*  Summon rows (Milestone 6)                   */
/* -------------------------------------------- */

function syncDoc(uuid) {
  try {
    return uuid ? (fromUuidSync(uuid) ?? null) : null;
  } catch (_err) {
    return null;
  }
}

/** A choice's display name: its stat block's name, else its label, else the uuid's id. */
const choiceName = c => c?.name || c?.label || String(c?.uuid ?? "").split(".").pop() || "?";

/** "Summon 2 Goblin Runner", or "Summon 1: Air / Fire" while several stat blocks are offered. */
function summonLabel(op) {
  const choices = op.choices ?? [];
  // `placed` only while applied: an undone row keeps the old count in the record, its next pick offers `quantity`.
  const count = op.status === OP_STATUS.APPLIED && Number.isInteger(op.placed) ? op.placed : (op.quantity ?? 1);
  const chosen = op.actorUuid ? choices.find(c => c.uuid === op.actorUuid) : (choices.length === 1 ? choices[0] : null);
  if (chosen || op.status === OP_STATUS.APPLIED) {
    return loc("DSAUTO.Card.Summon", { count, name: chosen ? choiceName(chosen) : (op.names?.[0] ?? "") });
  }
  return loc("DSAUTO.Card.SummonChoice", { count, names: choices.map(choiceName).join(" / ") });
}

/** Names of the non-GM owners of an actor (who places a player's summon). */
function ownerNames(actor) {
  try {
    return (game.users?.filter?.(u => !u.isGM && actor?.testUserPermission?.(u, "OWNER")) ?? []).map(u => u.name).filter(Boolean);
  } catch (_err) {
    return [];
  }
}

/**
 * Does the summoner's scene have a combat the summon could not join (CH6)? A combat that has not started, or one
 * without the summoner's token among its combatants, while it has a combatant on that scene or none yet. Combats are
 * found through their combatants (core creates them without a scene, D17). This view must not import
 * summons/combat.mjs (the part keeps no engine imports).
 */
function sceneHasOtherCombat(summonerDoc) {
  const sceneId = summonerDoc?.parent?.id;
  if (!sceneId) return false;
  try {
    for (const combat of game.combats?.contents ?? []) {
      const cs = combat.combatants?.contents ?? [];
      const onScene = !cs.length || cs.some(c => c.sceneId === sceneId);
      if (!onScene) continue;
      const hasSummoner = cs.some(c => c.tokenId === summonerDoc.id && c.sceneId === sceneId);
      if (!combat.started || !hasSummoner) return true;
    }
  } catch (_err) { /* no combats */ }
  return false;
}

/** The detail line of a summon row, for this viewer (§2.2 view). */
function summonDetail(res, op) {
  const bits = [];
  const user = game.user;
  const summonerDoc = syncDoc(op.summonerTokenUuid);
  if (op.status === OP_STATUS.APPLIED) {
    const names = [...new Set((op.names ?? []).filter(Boolean))];
    if (names.length) bits.push(loc("DSAUTO.Card.Summoned", { names: names.join(", ") }));
    if (Number.isInteger(op.placed) && Number.isInteger(op.requested) && op.placed < op.requested) {
      bits.push(loc("DSAUTO.Card.SummonPlaced", { placed: op.placed, requested: op.requested }));
    }
    if (op.combatId && (op.turn === "after" || op.turn === "with")) bits.push(loc("DSAUTO.Card.SummonActsAfter"));
    else if (op.combatId && op.turn === "own") bits.push(loc("DSAUTO.Card.SummonOwnTurn"));
    else if (!op.combatId && op.turn !== "none" && !op.dismissed && sceneHasOtherCombat(summonerDoc)) bits.push(loc("DSAUTO.Card.SummonNoCombat"));
    if (op.dismissed?.reason) bits.push(loc("DSAUTO.Card.SummonDismissed", { reason: loc(`DSAUTO.Summon.Removal.${op.dismissed.reason}`) }));
  } else {
    if (Number.isFinite(op.distance)) {
      const anchorName = op.origin === "target"
        ? (res.targets?.[op.anchorKey]?.name ?? syncDoc(op.anchorTokenUuid)?.name ?? null) : null;
      // Milestone 7 (M6 follow-up): "within 1 square", not "within 1 squares".
      bits.push(anchorName
        ? loc("DSAUTO.Card.SummonRangeTarget", { distance: op.distance, name: anchorName })
        : loc(op.distance === 1 ? "DSAUTO.Card.SummonRangeOne" : "DSAUTO.Card.SummonRange", { distance: op.distance }));
    }
    // Who picks the squares, per viewer: the summoner's owner on their own screen (the Director may still click).
    if (op.status !== OP_STATUS.SKIPPED && !op.noApply) {
      const summoner = syncDoc(op.summonerActorUuid ?? res.sourceActorUuid);
      const owners = isOwnSummon(op) ? ownerNames(summoner) : [];
      let mine = false;
      try {
        mine = !user.isGM && !!summoner?.testUserPermission?.(user, "OWNER");
      } catch (_err) { /* gone */ }
      if (isOwnSummon(op) && mine) bits.push(loc("DSAUTO.Card.SummonPicksSelf"));
      else if (owners.length) bits.push(loc("DSAUTO.Card.SummonPicksOwner", { name: owners.join(", ") }));
      // Milestone 7 (M6 follow-up): with automatic placement the Director's click lets the GM take the squares.
      else if (user.isGM && setting("summonPlacement") === "auto") bits.push(loc("DSAUTO.Card.SummonPicksAuto"));
      else bits.push(loc("DSAUTO.Card.SummonPicks"));
    }
  }
  if (op.undoMode === "alreadyGone") bits.push(loc("DSAUTO.Card.AlreadyGone"));
  if (op.reason) {
    const why = summonReasonText(op.reason);   // the square checks' reasons in summon wording (review fix)
    bits.push(op.status === OP_STATUS.FAILED && Number.isInteger(op.index)
      ? `${loc("DSAUTO.Card.SummonSquare", { n: op.index + 1 })}: ${why}` : why);
  }
  return bits.join(" · ");
}

/* -------------------------------------------- */
/*  Gain, zone and hero-token rows (Milestone 7) */
/* -------------------------------------------- */

/** The gainer's name for the resource: the hero's own heroic resource name ("Ferocity"), else the generic word. */
function gainResourceName(op) {
  if (op.resource === "heroic") {
    const named = syncDoc(op.gain?.gainerActorUuid)?.system?.hero?.primary?.label;
    if (named) return named;
  }
  return loc(`DSAUTO.Entry.Resource.${op.resource}`);
}

/** "+2 Ferocity", "+1d3 Ferocity" while the amount is a roll (the rolled amount once applied). */
function gainLabel(op) {
  const name = gainResourceName(op);
  if (op.status === OP_STATUS.APPLIED && Number.isFinite(Number(op.finalAmount))) return loc("DSAUTO.Card.Gain", { amount: Number(op.finalAmount), name });
  if (op.amount == null && op.formula) return loc("DSAUTO.Card.GainDice", { formula: op.formula, name });
  return loc("DSAUTO.Card.Gain", { amount: op.amount ?? 0, name });
}

/** The current round of a gain row's combat (null outside it). */
function combatRound(combatId) {
  try {
    const c = combatId ? game.combats?.get?.(combatId) : null;
    return c?.started ? c.round : null;
  } catch (_err) {
    return null;
  }
}

/** Rule · now N · rolled N · waits for the Director · from an earlier round. */
function gainDetail(op) {
  const bits = [];
  const g = op.gain ?? {};
  if (g.label) bits.push(g.label);
  if (op.status === OP_STATUS.APPLIED && op.after) bits.push(loc("DSAUTO.Card.GainNow", { value: op.after.value }));
  // Only while applied: an undone dice row rolls again when it is applied (0.9.1, no stale "rolled 1").
  if (op.status === OP_STATUS.APPLIED && op.rolled && Number.isFinite(Number(op.rolled.total))) bits.push(loc("DSAUTO.Card.GainRolled", { total: Number(op.rolled.total) }));
  // 0.16.0: the ledger slot, for the Director (diagnosing a gain seen twice in a round).
  if (game.user?.isGM && g.once && g.once !== "each" && g.ruleKey) bits.push(loc("DSAUTO.Card.GainSlot", { slot: `${g.once === "round" ? `r${g.round ?? "?"}` : "enc"} ${g.ruleKey}` }));
  if (op.status === OP_STATUS.UNDONE && op.ledgerKept) bits.push(loc("DSAUTO.Card.GainSlotKept"));
  if (op.status === OP_STATUS.PENDING) {
    if (g.confirm || g.vouched === "player") bits.push(loc("DSAUTO.Card.GainWaits"));
    const round = combatRound(g.combatId);
    if (g.once === "round" && round != null && g.round != null && round !== g.round) bits.push(loc("DSAUTO.Card.GainLate"));
  }
  return bits;
}

/** "Wall 5 within 10", "5 wall squares within 10", "Aura 2". */
function zoneAreaText(area) {
  if (!area?.shape) return "";
  const shape = loc(`DSAUTO.Zone.Shape.${area.shape}`);
  if (area.shape === "wall") return loc("DSAUTO.Card.ZoneWall", { count: area.count ?? area.size ?? 0, range: area.range ?? 0 });
  // A burst or aura is around its creator: no "within 0".
  if ((area.shape === "burst" || area.shape === "aura") && !area.range) return `${shape} ${area.size ?? 0}`;
  return loc("DSAUTO.Card.ZoneShape", { shape, size: area.size ?? 0, range: area.range ?? 0 }).replace(/\s+/g, " ").trim();
}

const zoneLastsText = lasts => (lasts ?? []).map(l => loc(`DSAUTO.Zone.Lasts.${l}`)).join(", ");

/** Milestone 9: "difficult terrain for enemies" of a terrain zone, or null. */
function zoneTerrainText(z) {
  if (!z?.terrain) return null;
  return loc("DSAUTO.Card.ZoneTerrain", { terrain: loc(`DSAUTO.Zone.Terrain.${z.terrain}`), who: loc(`DSAUTO.Zone.Affects.${z.affects ?? "enemies"}`) });
}

/** The detail line of a zone row, for this viewer (§3.10.9). */
function zoneDetail(res, op) {
  const bits = [];
  const z = op.zone ?? {};
  const lasts = zoneLastsText(z.lasts);
  const terrain = zoneTerrainText(z);
  if (op.status === OP_STATUS.APPLIED) {
    if (Number.isFinite(Number(op.squares))) bits.push(loc(Number(op.squares) === 1 ? "DSAUTO.Card.ZonePlacedOne" : "DSAUTO.Card.ZonePlaced", { squares: Number(op.squares) }));
    // Milestone 9: applied at resolve from the area drawn on use (zones/adopt.mjs).
    if (op.adopted) bits.push(loc("DSAUTO.Card.ZoneAdopted"));
    if (terrain && !op.ended?.reason) bits.push(terrain);
    if (op.ended?.reason) bits.push(loc("DSAUTO.Card.ZoneEnded", { reason: loc(`DSAUTO.Zone.End.${op.ended.reason}`) }));
    else if (lasts) bits.push(loc("DSAUTO.Card.ZoneLasts", { lasts }));
  } else {
    const area = zoneAreaText(z.area);
    if (area) bits.push(area);
    if (lasts) bits.push(loc("DSAUTO.Card.ZoneLasts", { lasts }));
    // Milestone 9: a terrain-only zone (amount 0) hits nobody, it only slows.
    if (z.affects && !(terrain && !(Number(z.amount) > 0))) bits.push(loc("DSAUTO.Card.ZoneAffects", { who: loc(`DSAUTO.Zone.Affects.${z.affects}`) }));
    if (terrain) bits.push(terrain);
    if (op.status !== OP_STATUS.SKIPPED && op.status !== OP_STATUS.FAILED && !op.noApply) {
      const creator = syncDoc(op.creatorActorUuid ?? res.sourceActorUuid);
      if (op.interactive === false) {
        bits.push(loc("DSAUTO.Card.ZoneAround", { name: syncDoc(op.creatorTokenUuid)?.name ?? creator?.name ?? "" }));
      } else {
        const owners = isOwnZone(op) ? ownerNames(creator) : [];
        let mine = false;
        try {
          mine = !game.user.isGM && !!creator?.testUserPermission?.(game.user, "OWNER");
        } catch (_err) { /* gone */ }
        if (isOwnZone(op) && mine) bits.push(loc("DSAUTO.Card.ZonePlacesSelf"));
        else if (owners.length) bits.push(loc("DSAUTO.Card.ZonePlacesOwner", { name: owners.join(", ") }));
        else bits.push(loc("DSAUTO.Card.ZonePlaces"));
      }
    }
  }
  if (op.undoMode === "alreadyGone") bits.push(loc("DSAUTO.Card.AlreadyGone"));
  if (op.reason) bits.push(zoneReasonText(op.reason, { range: z.area?.range ?? null }));
  return bits.join(" · ");
}

/* -------------------------------------------- */
/*  Pick rows and teleport boosts (Milestone 9) */
/* -------------------------------------------- */

/** The detail line of a pick placeholder: "within 10 of Goblin" and who picks, for this viewer. */
function pickDetail(res, op) {
  const bits = [];
  const p = op.pick ?? {};
  const anchorName = (p.of === "target" ? res.targets?.[op.anchorKey]?.name : null) ?? syncDoc(p.anchorTokenUuid)?.name ?? "";
  if (Number.isFinite(Number(p.within)) && anchorName) bits.push(loc("DSAUTO.Card.PickOf", { distance: Number(p.within), name: anchorName }));
  if (op.status === OP_STATUS.PENDING && !op.awaitingChoice) {
    const user = syncDoc(res.sourceActorUuid);
    let mine = false;
    try {
      mine = !game.user.isGM && !!user?.testUserPermission?.(game.user, "OWNER");
    } catch (_err) { /* gone */ }
    const owners = ownerNames(user);
    if (mine) bits.push(loc("DSAUTO.Pick.PicksSelf"));
    else if (owners.length) bits.push(loc("DSAUTO.Pick.PicksOwner", { name: owners.join(", ") }));
    else bits.push(loc("DSAUTO.Pick.PicksDirector"));
  }
  if (op.awaitingChoice) bits.push(loc("DSAUTO.Card.AwaitingChoice"));
  if (op.reason && op.reason !== "pickTargets") bits.push(loc(`DSAUTO.Reason.${op.reason}`));
  return bits.join(" · ");
}

/** The mover's name for a boost resource: the hero's own heroic resource name ("Essence"), else the generic word. */
function boostResourceName(res, op) {
  const named = op.boost?.resource === "heroic"
    ? syncDoc(res?.targets?.[op.targetKeys?.[0]]?.actorUuid)?.system?.hero?.primary?.label : null;
  return named || loc(`DSAUTO.Entry.Resource.${op.boost?.resource ?? "heroic"}`);
}

/** "Boost: 1 extra square per essence" while pending; "+2 squares for 2 Essence" once applied with a spend. */
function boostText(res, op) {
  const b = op.boost ?? {};
  const spent = op.status === OP_STATUS.APPLIED ? Number(op.boostSpent?.amount) || 0 : 0;
  const name = boostResourceName(res, op);
  if (spent > 0) return loc("DSAUTO.Card.TeleportBoosted", { squares: spent * (Number(b.per) || 1), amount: spent, name });
  return loc("DSAUTO.Card.TeleportBoost", { label: b.label || loc("DSAUTO.Teleport.BoostDefault", { per: Number(b.per) || 1, name }) });
}

export function opLabel(res, op) {
  const numbers = canSeeNumbers(res, op);
  const amount = Number.isInteger(op.override?.amount) ? op.override.amount : op.amount;
  // Library rows may carry a short label of their own (our words, never rules text).
  if (op.kind === "auraActivation") return loc("DSAUTO.Aura.Active");
  if (op.kind === "auraOption") return loc(({ gravitic: "DSAUTO.Aura.Gravitic", anchor: "DSAUTO.Aura.Anchor", synaptic: "DSAUTO.Aura.Synaptic" })[op.option] ?? "DSAUTO.Aura.NoOption");
  if (op.kind === "note") return op.text ?? "";
  if (op.kind === "summon") return summonLabel(op);
  // Milestone 9: "Pick 1: Slide a creature near the target".
  if (op.kind === "pick") return loc("DSAUTO.Card.PickTargets", { count: op.pick?.count ?? 1, label: op.label ?? "" });
  // Milestone 7.
  if (op.kind === "gain") return gainLabel(op);
  if (op.kind === "zone") return loc("DSAUTO.Card.Zone", { label: op.label ?? "" });
  if (op.heroToken) {
    const healed = op.status === OP_STATUS.APPLIED && Number.isFinite(Number(op.finalAmount)) ? Number(op.finalAmount) : (op.amount ?? 0);
    return loc("DSAUTO.Card.HeroTokenHeal", { amount: healed });
  }
  // The trigger card's anchor (Milestone 5): the round's triggered action, or a free use.
  if (op.kind === "budget") {
    const free = op.budgetType !== "triggered" || (op.status === OP_STATUS.APPLIED && !op.charged);
    return loc(free ? "DSAUTO.Trigger.Card.BudgetFree" : "DSAUTO.Trigger.Card.Budget", { ability: op.ability ?? "" });
  }
  if (op.label && op.kind === "condition") return op.label;
  if (op.kind === "heal" && op.recoveries) return loc("DSAUTO.Card.HealRecoveries", { count: op.recoveries, amount });
  switch (healKind(op)) {
    case "damage": {
      const shown = numbers && op.status === OP_STATUS.APPLIED && op.finalAmount != null ? op.finalAmount : amount;
      const key = op.surge ? "DSAUTO.Card.SurgeDamage" : "DSAUTO.Card.Damage";
      return loc(key, { amount: shown, type: damageTypeLabel(op), count: op.surge?.count ?? 0 }).replace(/\s+/g, " ").trim();
    }
    case "heal":
      return loc("DSAUTO.Card.Heal", { amount });
    case "temp":
      return loc("DSAUTO.Card.Temp", { amount });
    case "forced":
      return forcedLabel(op);
    case "teleport":
      return loc("DSAUTO.Card.Teleport", { distance: op.distance ?? 0 });
    case "featureMove": return `${op.label}: ${op.moveStyle} ${op.distance}`;
    case "modifier":
      // Milestone 9: a library modifier row names what it does in our words ("Damage weakness ... (+3)").
      if (op.lib) return loc("DSAUTO.Card.ModifierRow", { label: op.label || loc("DSAUTO.Card.Modifier"), value: signed(op.value) });
      return `${op.label ?? loc("DSAUTO.Card.Modifier")}: ${op.property} ${op.value >= 0 ? "+" : ""}${op.value}`;
    case "hide":
      return loc("DSAUTO.Card.Hide");
    case "cleanse":
      return cleanseLabel(op);
    case "resource":
      return resourceLabel(res, op);
    default: {
      const end = endLabel(op);
      return end ? `${conditionName(op)} (${end})` : conditionName(op);
    }
  }
}

/** Milestone 5: what triggered actions did to a row (halving, potency) and, for the Director, what they did not. */
function triggerDetail(op) {
  const bits = [];
  const entries = op.trigger?.entries ?? [];
  if (triggerHalved(op)) {
    const e = entries.find(x => x.outcome === "used" && !x.revoked && x.halve)
      ?? entries.find(x => x.outcome === "used" && !x.revoked && x.couldHalve);
    if (e) bits.push(loc("DSAUTO.Trigger.HalvedBy", { ability: e.abilityName ?? "", name: e.byName ?? "" }));
  }
  for (const d of op.potency?.triggerDeltas ?? []) bits.push(loc("DSAUTO.Trigger.PotencyBy", { delta: signed(d.delta), by: d.by ?? "" }));
  if (game.user.isGM) {
    for (const e of entries) {
      if (QUIET_OUTCOMES.has(e.outcome)) bits.push(loc(`DSAUTO.Trigger.Outcome.${e.outcome}`, { ability: e.abilityName ?? "", name: e.byName ?? "" }));
    }
  }
  if (entries.some(e => e.outcome === "used" && e.revoked)) bits.push(loc("DSAUTO.Trigger.Revoked"));
  return bits;
}

/** Live used reactions of an undone row (review rules-ux 9): the reaction stays spent until its card is undone. */
function stillSpent(op) {
  if (op.kind !== "damage" || op.status !== OP_STATUS.UNDONE) return [];
  return (op.trigger?.entries ?? []).filter(e => e.outcome === "used" && !e.revoked);
}

/** Row annotations of native targeted effects that ended (engine/targeted.mjs ENDED; "revived" clears the field). */
const ENDED_TEXT = Object.freeze({ sourceDefeated: "DSAUTO.Reason.sourceDefeated", ended: "DSAUTO.Reason.ended" });

function opDetail(res, op) {
  if (op.kind === "summon") return summonDetail(res, op);
  if (op.kind === "zone") return zoneDetail(res, op);
  if (op.kind === "pick") return pickDetail(res, op);
  const bits = [];
  if (op.kind === "hide" && op.whileObserved) bits.push(loc("DSAUTO.Card.HideWhileObserved"));
  // Milestone 7: what a gain row is for; what the hero tokens cost.
  if (op.kind === "gain") bits.push(...gainDetail(op));
  // 0.16.0: what a cleanse that ended nothing saw (Director only); a move Combat Tools' own picker made.
  if (op.kind === "cleanse" && op.status === OP_STATUS.SKIPPED && Array.isArray(op.seen) && game.user.isGM) {
    const list = op.seen.map(s => `${s.name}${s.expiry ? ` [${s.expiry}]` : ""}${s.disabled || s.expired ? ` (${loc("DSAUTO.Card.CleanseInactive")})` : ""}`).join(", ");
    bits.push(loc("DSAUTO.Card.CleanseSeen", { list: list || loc("DSAUTO.Card.CleanseSeenNone") }));
  }
  if (op.pickFallback === "dsctPicker" && op.status === OP_STATUS.APPLIED) bits.push(loc("DSAUTO.Card.PickFallback"));
  if (op.heroToken && op.status === OP_STATUS.APPLIED && op.tokens) {
    bits.push(loc("DSAUTO.Card.HeroTokenLeft", { cost: op.heroToken.cost ?? 2, left: op.tokens.after ?? 0 }));
  }
  // A triggered action's halving names who did it instead of "half damage".
  if (op.half && !triggerHalved(op)) bits.push(loc("DSAUTO.Card.Half"));
  bits.push(...triggerDetail(op));
  if (game.user.isGM) for (const e of stillSpent(op)) bits.push(loc("DSAUTO.Trigger.StillSpent", { ability: e.abilityName ?? "", name: e.byName ?? "" }));
  if (op.kind === "damage" && canSeeNumbers(res, op)) {
    if (op.immunity) bits.push(loc("DSAUTO.Card.Immunity", { value: op.immunity }));
    if (op.weakness) bits.push(loc("DSAUTO.Card.Weakness", { value: op.weakness }));
    if (op.group && op.status === OP_STATUS.APPLIED && op.finalAmount != null) bits.push(loc("DSAUTO.Card.SquadPool", { value: op.finalAmount }));
  }
  if (op.kind === "condition") {
    const p = potencyText(res, op);
    if (p) bits.push(p);
    if (op.surge?.kind === "potency") bits.push(loc("DSAUTO.Card.PotencySurged", { count: op.surge.count }));
    if (op.delegated) bits.push(loc("DSAUTO.Card.ViaCombatTools"));
    // Milestone 8: a native targeted effect ended by its source's defeat or by hand (engine/targeted.mjs); a native grab
    // leaves the grabber's own state to the table.
    if (ENDED_TEXT[op.endedReason]) bits.push(loc(ENDED_TEXT[op.endedReason]));
    if (op.native && op.effectId === "grabbed" && op.status === OP_STATUS.APPLIED && !op.endedReason) bits.push(loc("DSAUTO.Targeted.GrabberHint"));
  }
  if (op.kind === "forced") bits.push(...forcedDetail(res, op));
  if (op.kind === "teleport" && op.delegated === "dsct") bits.push(loc("DSAUTO.Card.ViaCombatTools"));
  if (op.kind === "teleport" && op.status !== OP_STATUS.APPLIED && !op.noApply) bits.push(loc(op.selfMove ? "DSAUTO.Card.PicksSquareSelf" : "DSAUTO.Card.PicksSquare"));
  // Milestone 9 (D6): extra squares for a resource, offered in the mover's teleport step; what was spent once applied.
  if (op.kind === "teleport" && op.boost) bits.push(boostText(res, op));
  if (op.kind === "cleanse" && op.status === OP_STATUS.APPLIED && op.removedNames?.length) bits.push(loc("DSAUTO.Card.Ended", { names: op.removedNames.join(", ") }));
  if (op.kind === "auraOption") bits.push(loc("DSAUTO.Aura.UntilNextTurn"));
  if (op.kind === "resource" && op.status === OP_STATUS.APPLIED && op.after) bits.push(loc("DSAUTO.Card.ResourceNow", { value: op.after.value }));
  if (op.lib && op.kind === "condition") {
    const p = potencyText(res, op);
    if (p && !bits.includes(p)) bits.push(p);
  }
  if ((op.kind === "damage" || op.kind === "forced") && op.lib && op.potency) {
    const p = potencyText(res, op);
    if (p && !bits.includes(p)) bits.push(p);
  }
  if (op.awaitingChoice) bits.push(loc("DSAUTO.Card.AwaitingChoice"));
  if (op.override && Object.keys(op.override).some(k => k !== "by" && k !== "at")) bits.push(loc("DSAUTO.Card.Edited"));
  if (op.reason) bits.push(loc(`DSAUTO.Reason.${op.reason}`));
  if (op.undoMode === "delta") bits.push(loc("DSAUTO.Card.UndoDelta"));
  if (op.undoMode === "positionKept") bits.push(loc("DSAUTO.Card.PositionKept"));
  if (op.grabsLost) bits.push(loc("DSAUTO.Card.GrabsLost", { count: op.grabsLost }));
  if (op.revivalPending) bits.push(loc("DSAUTO.Card.RevivalPending"));
  return bits.join(" · ");
}

function forcedDetail(res, op) {
  const bits = [];
  const p = potencyText(res, op);
  if (p) bits.push(p);
  if (op.ignoreStability) bits.push(loc("DSAUTO.Card.IgnoresStability"));
  else if (op.stability > 0 && canSeeNumbers(res, op)) bits.push(loc("DSAUTO.Card.Stability", { value: op.stability }));
  if (op.sizeBonus) bits.push(loc("DSAUTO.Card.SizeBonus"));
  if (op.status !== OP_STATUS.APPLIED && !op.noApply && chosenMovement(op) && pickOnApply(op)) bits.push(loc("DSAUTO.Card.PicksPath"));
  if (op.delegated === "dsct") bits.push(loc("DSAUTO.Card.ViaCombatTools"));
  if (op.status === OP_STATUS.APPLIED && op.summary) bits.push(op.summary);
  if (op.collisionLeft) bits.push(loc("DSAUTO.Card.CollisionLeft", { count: op.collisionLeft }));
  return bits;
}

/** 0.14.1: the compact card's one-word status of a pending or failed row (DSAUTO.Status.short.*). */
function statusShortLabel(op) {
  if (op.status === OP_STATUS.FAILED) return loc("DSAUTO.Status.short.failed");
  return loc(`DSAUTO.Status.short.${["auto", "prompt", "manual"].includes(op.mode) ? op.mode : "manual"}`);
}

function statusLabel(op) {
  if (op.kind === "note") return loc("DSAUTO.Status.note");
  if (op.status === OP_STATUS.PENDING) return loc(`DSAUTO.Status.pending.${op.mode}`);
  return loc(`DSAUTO.Status.${op.status}`);
}

/**
 * Surge buttons of an op for this user. `surges` = {hero, may, available, perSurge} for the card.
 * The active GM checks everything again (engine addSurge); this only decides what to show.
 */
function surgeButtons(res, op, surges) {
  const out = { canSurge: false, canPotencySurge: false, surgeMax: 0 };
  if (!surges.may || res.tampered) return out;
  if (surgeableDamage(op) && surges.perSurge > 0) {
    const used = Number(op.surgeSpend?.count ?? op.nativeSurges ?? 0) + liveSurgeOps(res, op.opId).reduce((sum, o) => sum + Number(o.surge?.count ?? 0), 0);
    out.surgeMax = Math.min(MAX_SURGES - used, surges.available);
    out.canSurge = out.surgeMax > 0;
  }
  out.canPotencySurge = potencySurgeable(op) && surges.available >= POTENCY_SURGE_COST;
  return out;
}

function opView(message, res, op, surges, opWarnings, compact = false) {
  const user = game.user;
  // Milestone 9: a pick placeholder is never applied; its Pick button opens the picker here (relay `pick`).
  const pick = op.kind === "pick";
  const canApply = (canApplyStatus(op) || (pick && op.status === OP_STATUS.PENDING)) && !op.awaitingChoice && mayAct(user, message, res, op, "apply");
  const choice = (op.synthetic && needsChoice(op)) || cleanseNeedsChoice(op);
  // Teleports go through Apply: the active GM asks the recipient's owner, whose screen opens Combat Tools'
  // teleport mode (engine/forced.mjs combatToolsTeleport), so the card's own picker button stays off.
  const ownTeleport = false;
  // A summon is placed on the clicking client's canvas; a Director with summonPlacement "auto" lets the GM search
  // (a row offering several stat blocks still goes through the Summon button: its choice dialog, then the search).
  const summon = op.kind === "summon";
  const gmAuto = user.isGM && setting("summonPlacement") === "auto" && (op.choices?.length ?? 0) <= 1;
  const summonAction = summon && !gmAuto ? "dsAutoSummon" : null;
  // Milestone 7: a zone is placed on the clicking client's canvas (burst and aura: the GM builds it on Place).
  const zone = op.kind === "zone";
  return {
    opId: op.opId,
    kind: op.kind,
    kindIcon: KIND_ICONS[op.kind] ?? "fa-solid fa-circle",
    label: opLabel(res, op),
    detail: opDetail(res, op),
    status: op.status,
    statusIcon: op.kind === "note" ? "fa-solid fa-hand" : (STATUS_ICONS[op.status] ?? "fa-solid fa-circle"),
    statusLabel: statusLabel(op),
    // 0.13.0 compact card: a short status word only where the icon alone is ambiguous; the detail as a tooltip.
    // 0.14.1 (live): one short word (the full status stays the tooltip); a long one squeezed the label column.
    statusShort: compact && op.kind !== "note" && (op.status === OP_STATUS.PENDING || op.status === OP_STATUS.FAILED) ? statusShortLabel(op) : "",
    // "external" (applied by Target Damage) stays clickable: the engine re-checks and applies only
    // once Target Damage has undone its record.
    canApply,
    // A row that needs a choice (push or pull) opens the Edit dialog instead of applying.
    applyAction: pick ? "dsAutoPick" : zone ? "dsAutoZone" : (summonAction ?? (ownTeleport ? "dsAutoTeleport" : (choice ? "dsAutoEditApply" : "dsAutoApply"))),
    // The Summon button (Milestone 6), the Place button (Milestone 7) and the Pick button (Milestone 9) show their own
    // icon and tooltip.
    summonButton: summon,
    zoneButton: zone,
    pickButton: pick,
    // Edit can raise a row past what was rolled: the Director's tool (engine editOp checks it again). A hero-token
    // heal is what the tokens bought (Milestone 7, C25).
    canEdit: canApply && user.isGM && EDITABLE.has(op.kind) && !op.surge && !op.heroToken,
    // A triggered action already halved it (Milestone 5): halving again is not offered.
    canHalf: canApply && op.kind === "damage" && !op.surge && !triggerHalved(op),
    canUndo: canUndoStatus(op) && mayAct(user, message, res, op, "undo"),
    // Milestone 6: the summoner's owners and the Director dismiss a live summon (the relay checks again).
    canDismiss: summon && op.status === OP_STATUS.APPLIED && !op.dismissed && !!op.summonId && mayDismissRow(user, res, op),
    // Milestone 7: the creator's owners and the Director dismiss a live area (relay zoneDismiss checks again).
    canDismissZone: zone && op.status === OP_STATUS.APPLIED && !zoneEnded(op) && !!op.zoneId
      && mayDismissZone(user, { creatorActorUuid: op.creatorActorUuid ?? res.sourceActorUuid }),
    warning: opWarnings.get(op.opId) ?? null,
    undoTriggers: undoTriggerButtons(message, op),
    ...surgeButtons(res, op, surges),
  };
}

/**
 * Director only: "Undo triggered action" per live used reaction of an undone damage row (review rules-ux 9).
 * The button runs the existing undo on that trigger card (no automatic refund: undo then re-apply keeps it).
 */
function undoTriggerButtons(message, op) {
  if (!game.user.isGM) return [];
  const spent = stillSpent(op);
  if (!spent.length) return [];
  const cards = triggerCardsFor(message?.id);
  const out = [];
  for (const e of spent) {
    const card = cards.find(c => c.entryId === e.id);
    if (!card || out.some(b => b.messageId === card.messageId)) continue;
    out.push({ messageId: card.messageId, label: `${loc("DSAUTO.Trigger.UndoTrigger")} (${e.abilityName ?? ""})` });
  }
  return out;
}

/** "Choose one" groups of the card (library choices) with what this user may do. */
function choiceViews(message, res, ops) {
  const out = [];
  for (const g of Object.values(res.choices ?? {})) {
    const groupOps = ops.filter(o => o.choice?.group === g.id);
    if (!groupOps.length) continue;
    const locked = groupOps.some(o => o.status === OP_STATUS.APPLIED);
    const canChoose = !locked && !res.tampered && groupOps.some(o => mayAct(game.user, message, res, o, "apply"));
    out.push({
      id: g.id, label: g.label || loc("DSAUTO.Card.ChooseOne"), canChoose, picked: g.picked ?? null,
      options: (g.options ?? []).map(o => ({ id: o.id, label: o.label, picked: o.id === g.picked })),
    });
  }
  return out;
}

/**
 * Who is being asked, for the waiting banner: the Director sees every name; a player sees the player-side
 * ones and "the Director" for the rest (review rules-ux 6).
 */
function holdNames(hold, isGM) {
  const names = Array.isArray(hold?.names) ? hold.names : [];
  if (isGM) return names.map(n => n?.text ?? "").filter(Boolean).join(", ");
  const shown = names.filter(n => n?.playerSide).map(n => n.text ?? "").filter(Boolean);
  if (names.some(n => !n?.playerSide)) shown.push(loc("DSAUTO.Trigger.Director"));
  return shown.join(", ");
}

/** Warning codes shown as a banner over the whole card. */
const BANNER_WARNINGS = [
  "unsupportedShape", "privateCard", "dsctChoose", "targetsChanged", "itemMissing", "hookManual",
  // Milestone 7: villain actions (they name no target).
  "villainActionReused", "villainActionRound",
  // Milestone 9: the area of a "targets: area" effect was not found (allies in it get nothing).
  "areaNotFound",
];

/** Build the template context for the resolution section. */
export function buildView(message, res) {
  const isGM = game.user.isGM;
  // 0.13.0: compact layout and the Details fold of Target Damage's panel (client settings).
  const compact = setting("compactCard") !== false;
  const fold = setting("foldDetails") !== false;
  const activeGM = game.users.activeGM;
  const ops = Object.values(res.ops ?? {}).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const rows = [];
  const byKey = new Map();
  const hero = res.synthetic ? null : surgeActor(res.sourceActorUuid);
  const surges = { may: maySurge(game.user, hero), available: availableSurges(hero), perSurge: surgeDamage(hero) };
  // Warnings about one op are shown on its row (several of the same code are merged).
  const opWarnings = new Map();
  for (const w of res.warnings ?? []) if (w.opId) opWarnings.set(w.opId, loc(`DSAUTO.Warning.${w.code}`));

  for (const [key, t] of Object.entries(res.targets ?? {})) {
    const selfOnly = !!t.self && !t.alsoTarget;
    // Milestone 7: a gainer on the card only for its gain rows (never a target).
    const gainOnly = !!t.gainOnly && !t.alsoTarget;
    const row = {
      key, name: t.name, img: t.img, tier: t.tier, ops: [], dropped: !!t.dropped, self: !!t.self, gainOnly,
      tierLabel: t.dropped ? loc("DSAUTO.Card.PreviousTarget")
        : selfOnly ? loc("DSAUTO.Card.Self")
          : gainOnly ? loc("DSAUTO.Card.GainRow")
            // 1.1.0: a reactive target shows its test's total, or that it has not rolled yet.
            : t.awaitingTest ? loc("DSAUTO.Card.AwaitingTest")
              : (t.tier && t.reactive ? loc("DSAUTO.Card.TestTier", { tier: t.tier, total: t.reactive.total })
                : (t.tier ? loc("DSAUTO.Card.Tier", { tier: t.tier }) : (res.noPowerRoll ? "" : loc("DSAUTO.Card.NoTier")))),
    };
    row.tierShort = (t.dropped || selfOnly || gainOnly) ? row.tierLabel
      : t.awaitingTest ? loc("DSAUTO.Card.AwaitingTestShort")
        : (t.tier ? loc("DSAUTO.Card.TierShort", { tier: t.tier }) : (res.noPowerRoll ? "" : loc("DSAUTO.Card.NoTierShort")));
    // A target of a power-roll card without a tier (added after the roll): the chip is a dash, styled as text.
    row.noTier = !t.dropped && !selfOnly && !gainOnly && !t.tier && !res.noPowerRoll;
    rows.push(row);
    byKey.set(key, row);
  }
  const squadRows = new Map();
  for (const op of ops) {
    if (op.group) {
      let row = squadRows.get(op.group);
      if (!row) {
        const names = op.targetKeys.map(k => res.targets?.[k]?.name).filter(Boolean);
        row = {
          key: op.group, name: loc("DSAUTO.Card.Squad", { name: op.groupName ?? "" }), members: names.join(", "), img: null, ops: [], squad: true,
          tierLabel: loc("DSAUTO.Card.Tier", { tier: op.tier }), tierShort: loc("DSAUTO.Card.TierShort", { tier: op.tier }),
        };
        squadRows.set(op.group, row);
        rows.push(row);
      }
      row.ops.push(opView(message, res, op, surges, opWarnings, compact));
      continue;
    }
    const row = byKey.get(op.targetKeys[0]);
    if (row) row.ops.push(opView(message, res, op, surges, opWarnings, compact));
  }
  // Minion targets whose only ops are squad ops: show them inside the squad row, not twice.
  const squadMembers = new Set(ops.filter(o => o.group).flatMap(o => o.targetKeys));
  // A gain-only record without rows (its gain row went with an undone resolve) is not shown.
  const visibleRows = rows.filter(r => r.squad || r.ops.length || (!squadMembers.has(r.key) && !r.gainOnly));
  // Milestone 7: classes the resources stylesheet styles (styles/ds-auto-resources.css).
  for (const r of visibleRows) {
    const kinds = new Set(r.ops.map(o => o.kind));
    r.rowClass = r.gainOnly ? "ds-auto-row-gain" : (kinds.size === 1 && kinds.has("zone") ? "ds-auto-row-zone" : "");
    // 0.13.0 compact card: a target with one short result is one line (0.13.2: a long name or label takes the two-line
    // layout, the one-line row has about 100 px for its text in the sidebar); the members of a squad move to a tooltip.
    // The chip the template shows (resolution.hbs): a gain-only row's label always, else the short tier when compact.
    const chip = r.gainOnly ? r.tierLabel : (compact && !res.synthetic ? r.tierShort : "");
    r.single = r.ops.length === 1
      && (String(r.name ?? "").length + String(r.ops[0].label ?? "").length + String(chip ?? "").length) <= ONE_LINE_CHARS;
    r.nameTooltip = compact && r.members ? r.members : "";
    if (compact) for (const o of r.ops) o.tooltip = o.detail || "";
  }

  const banners = [];
  const resolved = !!res.resolvedAt;
  // A record changed outside the engine is locked (engine/ledger.mjs): no actions until a GM trusts it.
  const locked = !!res.tampered;
  if (locked) {
    for (const row of visibleRows) {
      for (const op of row.ops) op.canApply = op.canEdit = op.canHalf = op.canUndo = op.canSurge = op.canPotencySurge = op.canDismiss = op.canDismissZone = false;
    }
  }
  // Milestone 5: reactors are being asked; nothing on the card lands until they answered.
  const held = !!res.hold && serverNow() < effectiveUntil(res, message) + 5_000;
  if (held) {
    // Nothing else re-renders the card when a hold runs out (its GM reloaded or left mid-prompt): the
    // waiting banner would stay, and the Resolve banner would never come back.
    rerenderAfter(message, effectiveUntil(res, message) + 5_000);
    // 0.9.1: a hero-token prompt is not a triggered action ("Waiting for Test", TESTING.md §14 T103).
    const waitKey = res.hold?.kind === "heroToken" ? "DSAUTO.Card.HeroTokenWaiting" : "DSAUTO.Trigger.Waiting";
    banners.push({ cls: "waiting", icon: "fa-solid fa-user-clock", text: loc(waitKey, { names: holdNames(res.hold, isGM) }) });
    // Surges and undo would only queue behind the hold (the card's lock): offered again once it ends.
    for (const row of visibleRows) {
      for (const op of row.ops) op.canUndo = op.canSurge = op.canPotencySurge = op.canDismiss = op.canDismissZone = false;
    }
  }
  if (!resolved && !locked && !held) {
    if (!activeGM) banners.push({ cls: "waiting", icon: "fa-solid fa-user-clock", text: loc("DSAUTO.Card.WaitingForDirector") });
    else if (isGM) banners.push({ cls: "unresolved", icon: "fa-solid fa-circle-exclamation", text: loc("DSAUTO.Card.Unresolved"), action: "dsAutoResolve", actionLabel: loc("DSAUTO.Card.ResolveNow") });
    else if (mayResolve(game.user, message) && Date.now() - (res.createdAt ?? 0) > AUTHOR_RESOLVE_AFTER_MS) {
      banners.push({ cls: "unresolved", icon: "fa-solid fa-circle-exclamation", text: loc("DSAUTO.Card.UnresolvedAuthor"), action: "dsAutoResolve", actionLabel: loc("DSAUTO.Card.ResolveNow") });
    } else banners.push({ cls: "waiting", icon: "fa-solid fa-hourglass-half", text: loc("DSAUTO.Card.Resolving") });
  }
  if (res.tampered) {
    banners.push({ cls: "warning", icon: "fa-solid fa-lock", text: loc(isGM ? "DSAUTO.Card.TamperedGM" : "DSAUTO.Card.Tampered") });
  }
  const shownCodes = new Set();
  for (const w of res.warnings ?? []) {
    if (!BANNER_WARNINGS.includes(w.code) || shownCodes.has(w.code)) continue;
    if (w.code === "privateCard" && !isGM) continue;
    shownCodes.add(w.code);
    banners.push({ cls: "warning", icon: "fa-solid fa-triangle-exclamation", text: loc(`DSAUTO.Warning.${w.code}`) });
  }
  // What the library leaves to the table (overlay notes, our words).
  if (resolved && res.library?.notes) banners.push({ cls: "info", icon: "fa-solid fa-book", text: res.library.notes });
  // Milestone 9: a Persistent use (kept at the user's turn start) and a free re-roll of one.
  if (resolved && !res.synthetic && res.persistent?.cost) {
    banners.push({ cls: "info", icon: "fa-solid fa-hourglass-half", text: loc(`DSAUTO.Card.Persistent.${persistentKeepKey(res.persistent.keep)}`, { cost: res.persistent.cost }) });
    if (res.persistent.free) banners.push({ cls: "info", icon: "fa-solid fa-rotate", text: loc("DSAUTO.Card.PersistentFree") });
  }
  const noTargets = resolved && !Object.values(res.targets ?? {}).some(t => !t.dropped);
  if (noTargets) banners.push({ cls: "info", icon: "fa-solid fa-crosshairs", text: loc("DSAUTO.Card.NoTargets") });

  // Footer buttons count only the ops this user may act on.
  const user = game.user;
  const pendingCount = locked ? 0 : ops.filter(o => o.status === OP_STATUS.PENDING && !o.noApply && !needsChoice(o)
    && !o.awaitingChoice && !cleanseNeedsChoice(o) && !(isSelfTeleport(o) && !user.isGM) && !ownButtonOnly(o)
    && mayAct(user, message, res, o, "apply")).length;
  // A held card hides "Undo all" as it hides each row's Undo: it would queue behind the hold and undo the
  // held damage too once it lands (third review). The card re-renders when the hold ends.
  const appliedCount = (locked || held) ? 0 : ops.filter(o => o.status === OP_STATUS.APPLIED && mayAct(user, message, res, o, "undo")).length;
  const canRetarget = resolved && !locked && !targetsOnlySelf(message) && mayRetarget(user, message, res);
  // 0.16.0 (house rule setting): a hero token rerolls the power roll.
  const canHeroReroll = resolved && !locked && !held && heroRerollShown(message, res, user);
  const rowWarnings = new Map();
  for (const w of res.warnings ?? []) {
    if (!w.targetKey) continue;
    const list = rowWarnings.get(w.targetKey) ?? [];
    const text = loc(`DSAUTO.Warning.${w.code}`);
    if (!list.includes(text)) list.push(text);
    rowWarnings.set(w.targetKey, list);
  }
  for (const r of visibleRows) r.warning = rowWarnings.get(r.key)?.join(" ") ?? null;
  // Warnings that name a target or op the card no longer shows (dropped targets, removed ops) and
  // unknown codes: listed for the Director under "Notes" so nothing is silently lost.
  const shownKeys = new Set(visibleRows.map(r => r.key));
  const shownOps = new Set(ops.map(o => o.opId));
  const notes = !isGM ? [] : [...new Set((res.warnings ?? []).filter(w => {
    if (BANNER_WARNINGS.includes(w.code)) return false;
    if (w.opId) return !shownOps.has(w.opId);
    if (w.targetKey) return !shownKeys.has(w.targetKey);
    return true;
  }).map(w => {
    const name = w.targetKey ? res.targets?.[w.targetKey]?.name : null;
    const text = loc(`DSAUTO.Warning.${w.code}`);
    return name ? `${name}: ${text}` : text;
  }))];

  const showFooter = resolved && (pendingCount > 0 || appliedCount > 0 || canRetarget || canHeroReroll);
  const details = fold && shouldFoldPanel(res, { dstd: dstdActive(), state: dstdState(message) });
  return {
    title: res.abilityName ?? "",
    compact,
    showHeader: !compact || !!res.synthetic,
    details,
    footer: showFooter || details,
    rows: visibleRows,
    banners,
    choices: locked ? [] : choiceViews(message, res, ops),
    isGM,
    resolved,
    isAuthor: isAuthor(user, message),
    showFooter,
    canApplyAll: resolved && pendingCount > 0,
    canUndoAll: resolved && appliedCount > 0,
    canRetarget,
    canHeroReroll,
    notes,
    synthetic: !!res.synthetic,
    empty: resolved && !visibleRows.some(r => r.ops.length) && !noTargets,
    // 1.1.0: a reactive card whose targets have not rolled their tests yet.
    emptyText: loc(res.reactive && Object.values(res.targets ?? {}).some(t => t.awaitingTest && !t.dropped) ? "DSAUTO.Card.AwaitingTests" : "DSAUTO.Card.NothingToApply"),
  };
}
