/**
 * "Acts after the summoner" (Milestone 6, docs/M6-DESIGN.md §3.7, CH3, CH9, D15, D16). In Draw Steel's default
 * (zipper) initiative mode an `after` / `with` summon is a chain: when its summoner's turn ends, the registry's
 * lifecycle listener (registered before Hesitation is Weakness's) calls `chainAfter`, which makes the summoner's
 * live `after` summons current one by one, each from the previous one's own `turnEnd`. Until then such a summon is
 * HELD at initiative 0 (also after the system's round reset), so nobody can activate it before its summoner.
 *
 * - Everything that selects or writes runs on the summon chain (`withSummonChain`): never concurrently with a
 *   dismissal, whose `dismissing` mark makes us skip a summon being removed.
 * - `takeSummonTurn`: raise (fires no turn start, DSM:12232 runs only on a decrease), turn write re-checked right
 *   before it, then the current member drops FIRST (update option `_dsctSquadBatch`, so Combat Tools' member hook
 *   stays out) and the group after it (with DSCT squad turns on, that group drop starts the OTHER members, and the
 *   current one is already 0: nobody starts twice). Raises carry `{"stef-ds-automation": {chain: true}}` so the hold hook
 *   leaves them alone.
 * - When a chained summon's turn ends with nothing left, Hesitation is Weakness (pre-empted at the summoner's own
 *   turn end) is offered for the summoner through turn-order's `runHiwFor` (WP-E export, optional call).
 * - Alternative initiative mode: fractional initiative (combat.mjs), no chain, no hold.
 * - The chain unit (review fix): a squad (one group, possibly shared by several entries that joined it) has ONE turn
 *   per round; the ungrouped members of one entry (non-minions, squad "none") one turn each (`chainedIds`).
 * i18n keys: none.
 */
import { MODULE_ID } from "../constants.mjs";
import { dsctSetting } from "../compat/dsct.mjs";
import { debug, error, log } from "../log.mjs";
import { setting } from "../settings.mjs";
import * as turnOrder from "../triggers/turn-order.mjs";
import { isDsctGroup } from "./combat.mjs";
import { indexEntries, isDismissing, patchIndex, summonTokens, summonsOf, withSummonChain } from "./registry.mjs";

const AFTER_TURNS = new Set(["after", "with"]);
// Fresh objects per write (review fix): core assigns `operation.parent` to the object it is given; a frozen one throws.
const CHAIN = () => ({ [MODULE_ID]: { chain: true } });
const HOLD = () => ({ [MODULE_ID]: { hold: true } });

/**
 * Review fix: Combat Tools' turn-start keys our hold drops took (`${member.id}:${round}:${group initiative}`, the
 * DSCT/squad-turns.mjs:89 `_startKey` its MIXED Combatant#_preUpdate wrapper adds on a member's first decrease,
 * whatever the options, :294-303). Its group-drop activation (:91-99) skips a member whose key is taken, so a member
 * held at round start (group still 0) would never get a turn start from the chained group drop. combatId -> {round, keys}.
 */
const heldKeys = new Map();

const isActiveGM = () => !!game.users?.activeGM?.isSelf;
const chainOn = () => (setting("summonTurnChain") ?? true) !== false;
const defaultMode = () => !!game.combats?.isDefaultInitiativeMode;

/** Array view of a Foundry collection, a Map or an array (harness mocks). */
function list(c) {
  if (!c) return [];
  if (Array.isArray(c)) return c;
  if (Array.isArray(c.contents)) return c.contents;
  if (typeof c.values === "function") return [...c.values()];
  return [];
}

function lookup(uuid) {
  if (!uuid) return null;
  try {
    return fromUuidSync(uuid);
  } catch (_err) {
    return null;
  }
}

/** The group of a combatant (core getter, else the source id). */
function groupOf(combat, c) {
  if (c?.group && typeof c.group === "object") return c.group;
  const id = c?._source?.group ?? (typeof c?.group === "string" ? c.group : null);
  return id ? (combat?.groups?.get?.(id) ?? null) : null;
}

/** Is `mentor` (an actor, a uuid or an id) this actor? */
function sameActor(mentor, actor) {
  if (!mentor || !actor) return false;
  if (mentor === actor) return true;
  if (typeof mentor === "string") return mentor === actor.uuid || mentor === actor.id;
  return !!mentor.uuid && mentor.uuid === actor.uuid;
}

/**
 * The combatants of an entry that already had their chained turn in `round`: a Set of ids, or null when the whole
 * entry is done (a squad's group turn, an entry made with actsThisRound false, an entry written before
 * `chainedIds` existed). Ungrouped members (non-minions, squad "none") are separate creatures: one turn each.
 */
function chainedIdsOf(entry, round) {
  if (entry?.chainedRound !== round) return new Set();
  return Array.isArray(entry.chainedIds) ? new Set(entry.chainedIds) : null;
}

/**
 * The combatant that takes the summon's next chained turn this round (the first live member not chained yet;
 * a squad is one unit), or null. Retainers whose mentor is the summoner are skipped (Combat Tools' pair turns own
 * them).
 */
export function turnCombatantOf(combat, entry, round) {
  if (!combat || !entry) return null;
  const done = chainedIdsOf(entry, round);
  if (!done) return null;   // already had its turn this round (CH9)
  const tokenIds = entry.tokenIds ?? [];
  const members = list(combat.combatants).filter(c => tokenIds.includes(c.tokenId) && !c.isDefeated);
  if (!members.length) return null;
  const summoner = lookup(entry.summonerActorUuid);
  if (summoner && members.some(c => sameActor(c.actor?.system?.retainer?.mentor, summoner))) return null;
  return members.find(c => !done.has(c.id)) ?? null;   // held at 0: initiative is not the test any more
}

/** Has every member of the entry had its chained turn in `round` (CH9)? */
export function chainedThisRound(combat, entry, round) {
  return !!entry && !turnCombatantOf(combat, entry, round) && entry.chainedRound === round;
}

/** Is the hold of an index entry active now (CH9)? Pure on the live combat. */
export function holdActive(combat, entry) {
  if (!combat || !entry?.held || chainedThisRound(combat, entry, combat.round)) return false;
  if (!defaultMode() || !chainOn()) return false;
  const s = list(combat.combatants).find(x => x.tokenId === entry.summonerTokenId);
  if (!s || s.isDefeated) return false;   // no summoner in the fight: the Director runs it
  // The summoner's turn has not ended this round.
  return combat.combatant?.id === s.id || (s.initiative ?? 0) > 0;
}

/** Active GM, on the chain: lower held members (option _dsctSquadBatch) and then their group to 0 (§3.7). Idempotent. */
export async function holdSummons(combat, entries) {
  if (!isActiveGM() || !combat) return;
  const live = game.combats?.get?.(combat.id) ?? combat;
  for (const e of entries ?? []) {
    if (!holdActive(live, e)) continue;
    const tokenIds = e.tokenIds ?? [];
    const current = live.combatant?.id ?? null;
    const ms = list(live.combatants).filter(c => tokenIds.includes(c.tokenId) && (c.initiative ?? 0) > 0 && c.id !== current);
    // Members FIRST: a later group drop activates nobody.
    if (ms.length) {
      const g0 = e.groupId ? (live.groups?.get?.(e.groupId) ?? null) : null;
      if (g0 && dsctSetting("squadSimultaneousTurns", false) && isDsctGroup(g0)) noteHeldKeys(live, ms, g0);
      await live.updateEmbeddedDocuments("Combatant", ms.map(m => ({ _id: m.id, initiative: 0 })), { _dsctSquadBatch: true, ...HOLD() });
    }
    const g = e.groupId ? (live.groups?.get?.(e.groupId) ?? null) : null;
    if (g && (g.initiative ?? 0) > 0) await g.update({ initiative: 0 }, HOLD());
    if (ms.length || g) debug("summon.hold", { summonId: e.summonId, members: ms.length });
  }
}

/** Record the DSCT start keys a hold drop of `members` takes now (the group's initiative in memory, before the drop). */
function noteHeldKeys(combat, members, group) {
  const round = combat.round;
  let slot = heldKeys.get(combat.id);
  if (!slot || slot.round !== round) heldKeys.set(combat.id, (slot = { round, keys: new Set() }));
  for (const m of members) slot.keys.add(`${m.id}:${round}:${group.initiative}`);
}

/** Did a hold drop of ours take the DSCT start key this member needs now? */
function keyTaken(combat, member, group) {
  const slot = heldKeys.get(combat.id);
  return !!slot && slot.round === combat.round && slot.keys.has(`${member.id}:${combat.round}:${group.initiative}`);
}

/**
 * Start a squad member Combat Tools skipped (its key was taken by our hold drop): what DSCT's fireStartTurn does
 * without region events (DSCT/squad-turns.mjs:40-58, the group hook passes skipRegionEvents). Fire-and-forget.
 */
async function startSkippedMember(combat, member) {
  const turn = list(combat.turns).findIndex(t => t.id === member.id);
  if (turn < 0) return;
  await member.actor?.system?._onStartTurn?.(member);
  const proxy = Object.create(combat, { combatant: { get: () => member, configurable: true } });
  await globalThis.foundry?.documents?.ActiveEffect?.registry?.refresh?.("turnStart", { round: combat.round, turn, skipped: false, combat: proxy });
  log("summon.dsctStart", { member: member.name, round: combat.round });
}

/** Runs ON the chain: raise, turn write, member drop (§3.7). Re-checks combat.combatant right before the turn write. */
export async function takeSummonTurn(combat, entry, { round, summonerTokenId, combatant: c } = {}) {
  if (!combat || !entry || !c) return { ok: false, why: "notInTurns" };
  const g = groupOf(combat, c);
  const dsctSquad = !!g && !!dsctSetting("squadSimultaneousTurns", false) && isDsctGroup(g);
  const raise = dsctSquad ? list(g.members).filter(m => !m.isDefeated) : [c];
  // 1. Raise (no turn start: only a decrease fires one). Members first while the group is 0: Combat Tools' member
  //    hook returns on _dsctSquadBatch and at group 0; a group raise is ignored by it.
  for (const m of raise) {
    if ((m.initiative ?? 0) < 1) await m.update({ initiative: 1 }, { _dsctSquadBatch: true, ...CHAIN() });
  }
  if (g && (g.initiative ?? 0) < 1) await g.update({ initiative: 1 }, CHAIN());
  // 2. Turn write, re-checked right before it (as takeTurnNext); the index is recomputed now (deletions shift it).
  if (combat.combatant) return { ok: false, why: "turnTaken" };   // raised ones stay at 1: the hold has lifted
  const turn = list(combat.turns).findIndex(t => t.id === c.id);
  if (turn < 0) return { ok: false, why: "notInTurns" };
  await combat.update({
    turn, [`flags.${MODULE_ID}.summonTurn`]: { combatantId: c.id, summonId: entry.summonId, summonerTokenId, round },
  }, { direction: 1 });
  // 3. Drops: the current member first (core keeps the current combatant when initiatives change), with
  //    _dsctSquadBatch so Combat Tools' member hook stays out; then the group (its hook starts the other members).
  await c.update({ initiative: 0 }, { _dsctSquadBatch: true });
  const gLive = g ? (combat.groups?.get?.(g.id) ?? g) : null;
  if (gLive && (gLive.initiative ?? 0) > 0) {
    // Which members Combat Tools' group hook will skip (key taken by our round-start hold), read before the drop.
    const skipped = dsctSquad
      ? raise.filter(m => m.id !== c.id && !m.isDefeated && keyTaken(combat, m, { initiative: 0 }))
      : [];
    await gLive.update({ initiative: 0 });
    for (const m of skipped) {
      if (!((m.initiative ?? 0) > 0)) continue;
      startSkippedMember(combat, m).catch(err => error("summon.dsctStart", err));
    }
  }
  if (g) {
    // A group acts as one: every entry sharing it (a later summon joined the squad) had this turn.
    const groupId = g.id;
    const sharing = indexEntries(combat).filter(e => e.summonId === entry.summonId || (groupId && e.groupId === groupId));
    for (const e of sharing) await patchIndex(combat, e.summonId, { chainedRound: round, chainedIds: null }, { onChain: true });
  } else {
    // Ungrouped members are separate creatures: each gets its own chained turn.
    const done = chainedIdsOf(entry, round) ?? new Set();
    await patchIndex(combat, entry.summonId, { chainedRound: round, chainedIds: [...done, c.id] }, { onChain: true });
  }
  return { ok: true };
}

/**
 * On a turnEnd lifecycle payload (awaited by registry's listener): chain the next `after` summon (§3.7). The selection
 * and the writes run on withSummonChain (never concurrently with a dismissal); when nothing is left after a chained
 * summon's turn, Hesitation is Weakness is offered for the summoner (fire-and-forget).
 */
export async function chainAfter(payload) {
  try {
    const { event, combat, combatant, round } = payload ?? {};
    if (!isActiveGM() || event !== "turnEnd" || !combat || !combatant || !chainOn()) return;
    if (!defaultMode()) return;   // alternative mode: fractional initiative (§3.6), no chain
    if (!indexEntries(game.combats?.get?.(combat.id) ?? combat).length) return;   // zero cost without summons
    const outcome = await withSummonChain(async () => {
      const live = game.combats?.get?.(combat.id);
      // Between turns only (R§ fact 32): a turn already started or the round moved on.
      if (!live?.started || live.round !== round || live.combatant) return { done: "notBetweenTurns" };
      const marker = live.flags?.[MODULE_ID]?.summonTurn;
      // Who just ended? The summoner itself, or a summon we chained (then continue with its summoner's next summon).
      const chained = !!marker && marker.combatantId === combatant.id && marker.round === round;
      const summonerTokenId = chained ? marker.summonerTokenId : combatant.tokenId;
      if (!chained && combatant.flags?.[MODULE_ID]?.summonId) return { done: "ownTurn" };   // a summon ending an unchained turn
      for (const entry of summonsOf(live, summonerTokenId)) {
        if (!AFTER_TURNS.has(entry.turn)) continue;
        if (isDismissing(entry.summonId) || !summonTokens(entry.summonId).length) continue;   // being removed / gone
        // Unpaid Persistent (also a prompt lost to a GM reload).
        if (entry.upkeep && (entry.lasts ?? []).includes("summonerTurnStart") && round > (entry.createdRound ?? round)
          && entry.upkeptRound !== round) continue;
        const c = turnCombatantOf(live, entry, round);
        if (!c) continue;
        const r = await takeSummonTurn(live, entry, { round, summonerTokenId, combatant: c });
        if (r.ok) {
          log("summon.chain", { summon: c.name, round });
          return { done: "chained" };
        }
        if (r.why === "turnTaken") return { done: "turnTaken" };
      }
      return { done: "nothingLeft", chained, summonerTokenId, live };
    });
    debug("summon.chainOutcome", { done: outcome?.done, round });
    // Q19: the chain pre-empted HIW at the summoner's turn end; offer it now, for the summoner (fire-and-forget).
    if (outcome?.done === "nothingLeft" && outcome.chained) {
      const sc = list(outcome.live.combatants).find(x => x.tokenId === outcome.summonerTokenId);
      if (sc && typeof turnOrder.runHiwFor === "function") {
        Promise.resolve()
          .then(() => turnOrder.runHiwFor({ combat: outcome.live, combatant: sc, actor: sc.actor ?? null, round }))
          .catch(err => error("summon.hiw", err));
      }
    }
  } catch (err) {
    error("summon.chain", err, { event: payload?.event });
  }
}
