/**
 * Milestone 6: summons in combat (docs/M6-DESIGN.md §3.6), on the active GM except the pure helpers.
 *
 * - Combats are found through their combatants (`tokenId` + `sceneId`), never through `combat.scene`: core creates
 *   combats unlinked (tracker button, token toggle; D17). Only a STARTED combat gets summon combatants (CH6).
 * - Initiative is explicit (a new combatant has none, R§ fact 17). Default mode: `after`/`with` summons with the chain
 *   on are held at 0 until the chain gives them their turn (CH9, D15), else `actsThisRound ? turns : 0`. Alternative
 *   mode: fractional initiative just below the summoner (and its earlier summons).
 * - Minions go into a squad: a joinable live squad of the same summoner and world actor in the same activation state
 *   and not acting now, else a new one owned by the summoner's non-GM owners. Members are created FIRST, then the pool
 *   is written (Critic B9: Death Tracker clamps a pool above the living minions, DT/death-tracker.mjs:1571-1584).
 *   Non-minions are never grouped.
 * - With Combat Tools' squad labels on, a new squad is named with the lowest free "Group N" (the DSLF Fix 5 rule,
 *   DSLF/squad-labels-guard.mjs:174-191) and DSCT's labeller runs on this client when it views that scene and that
 *   combat is game.combat (DSCT labels only game.combat, DSCT/squad-labels.mjs:70-74).
 * - Removal deletes our combatants first, lowers surviving pools by the living minions removed and deletes groups we
 *   created that are now empty; the tokens go afterwards (registry.dismissSummon), so core's `_onDeleteTokens` and
 *   Death Tracker's orphan cleanup find nothing left (R§ C3).
 *
 * Every write carries `{"stef-ds-automation": {internal: true}}`. Deletes are filtered to ids still present.
 */
import { MODULE_ID } from "../constants.mjs";
import { dsctApi, dsctSetting } from "../compat/dsct.mjs";
import { ctlibService } from "../compat/ctlib.mjs";
import { error, log } from "../log.mjs";
import { setting } from "../settings.mjs";
import * as lifecycle from "../turn/lifecycle.mjs";
import { indexEntries } from "./registry.mjs";

const INTERNAL = () => ({ [MODULE_ID]: { internal: true } });

const list = c => (c ? (Array.isArray(c) ? c : (c.contents ?? [...c])) : []);
const defaultMode = () => game.combats?.isDefaultInitiativeMode !== false;
const flagsOf = doc => doc?.flags?.[MODULE_ID] ?? {};

/**
 * The started combat that has the summoner's token as a combatant on the token's scene: {combat, combatant} | null.
 * Matched through the combatant (tokenId + sceneId), never through combat.scene (combats are unlinked, D17);
 * `game.combat` is preferred when several match.
 */
export function summonerCombat(summonerDoc) {
  try {
    if (!summonerDoc || !game.combats) return null;
    const sceneId = summonerDoc.parent?.id ?? null;
    const seen = new Set();
    for (const c of [game.combat, ...list(game.combats)]) {
      if (!c || seen.has(c.id)) continue;
      seen.add(c.id);
      if (!c.started) continue;
      if (c.scene && c.scene.id !== sceneId) continue;
      const cb = list(c.combatants).find(x => x.tokenId === summonerDoc.id && (x.sceneId ?? sceneId) === sceneId);
      if (cb) return { combat: c, combatant: cb };
    }
    return null;
  } catch (err) {
    error("summon.combat", err);
    return null;
  }
}

/** Combats holding a combatant for any of these token ids (dismissal; started or not, same matching rule). */
export function combatsWith(tokenIds) {
  if (!game.combats || !tokenIds?.length) return [];
  const ids = new Set(tokenIds);
  return list(game.combats).filter(c => list(c.combatants).some(x => ids.has(x.tokenId)));
}

/** A group DSCT activates as one (type squad, or type base with more than one member: DSCT/squad-turns.mjs:377). */
export function isDsctGroup(group) {
  if (!group) return false;
  if (group.type === "squad") return true;
  return group.type === "base" && (group.members?.size ?? 0) > 1;
}

/** Is this summon held at initiative 0 until the chain gives it its turn (default mode, chain on, after/with; CH9)? */
export function chainHolds(op) {
  return defaultMode() && (setting("summonTurnChain") ?? true) !== false && ["after", "with"].includes(op?.turn);
}

/** Initiative of the k-th (1-based) of n new combatants (§3.6). Default mode: actsThisRound ? turns : 0; alternative: fractional. */
export function initiativeFor({ combat, summonerCombatant, actor, op, k, n }) {
  if (defaultMode()) {
    if (chainHolds(op)) return 0;
    return op?.actsThisRound !== false ? (Number(actor?.system?.combat?.turns) || 1) : 0;
  }
  const s = Number(summonerCombatant?.initiative) || 0;
  const tokenId = summonerCombatant?.tokenId;
  const all = list(combat?.combatants);
  const mine = all.filter(c => c.id !== summonerCombatant?.id && flagsOf(c).summonerTokenId === tokenId
    && Number.isFinite(c.initiative) && c.initiative < s);
  const base = Math.min(s, ...mine.map(c => c.initiative));
  const mineIds = new Set(mine.map(c => c.id));
  const below = all.filter(c => c.id !== summonerCombatant?.id && !mineIds.has(c.id) && Number.isFinite(c.initiative) && c.initiative < base)
    .map(c => c.initiative);
  const lower = below.length ? Math.max(...below) : base - 1;
  const eps = Math.min(0.01, (base - lower) / ((n ?? 1) + 1));
  return base - (k ?? 1) * eps; // ties by name cannot be fully avoided (R§ 4.2)
}

/** Lowest free "Group N" (N 1-10) among the combat's groups, or null. Pure. */
export function freeGroupName(combat) {
  const taken = new Set();
  for (const g of list(combat?.groups)) {
    const m = /^Group (\d+)([a-z]?)$/i.exec(String(g?.name ?? "").trim());
    const n = m ? Number(m[1]) : NaN;
    if (n >= 1 && n <= 10) taken.add(n);
  }
  for (let n = 1; n <= 10; n++) if (!taken.has(n)) return `Group ${n}`;
  return null;
}

const labeller = () => {
  const api = dsctApi()?.squadLabels;
  if (typeof api === "function") return api;
  const svc = ctlibService("applySquadLabels");
  return typeof svc === "function" ? svc : null;
};

/** DSCT labels wanted: setting summonSquadLabels, DSCT squadToolsEnabled + autoSquadLabelsEnabled + squadLabelApplyEffects, a labeller. */
export function labelsWanted() {
  return (setting("summonSquadLabels") ?? true) !== false
    && !!dsctSetting("squadToolsEnabled", false) && !!dsctSetting("autoSquadLabelsEnabled", false)
    && !!dsctSetting("squadLabelApplyEffects", false) && !!labeller();
}

/**
 * Run DSCT's labeller on this GM client (api.squadLabels, else ctlib service applySquadLabels) when it views `sceneId`
 * and `combat` is `game.combat` (DSCT labels only game.combat, DSCT/squad-labels.mjs:70-74). False when skipped.
 */
export async function applySquadLabels(sceneId, combat) {
  try {
    if (globalThis.canvas?.scene?.id !== sceneId || !combat || game.combat?.id !== combat.id) return false;
    const fn = labeller();
    if (!fn) return false;
    await fn();
    return true;
  } catch (err) {
    error("summon.labels", err);
    return false;
  }
}

/**
 * A squad of the same summoner and world actor that new members can join: type squad, a non-defeated member, the same
 * activation state as the new members (`group.initiative > 0` === the new members can act this round), and not
 * acting now (no member is `combat.combatant` or `lifecycle.isActing`). Else null (a new squad is made).
 */
export function findJoinableSquad(combat, { summonerActorUuid, worldActorId, canAct }) {
  const raw = indexEntries(combat) ?? [];
  const entries = Array.isArray(raw) ? raw : Object.values(raw);
  for (const e of entries) {
    if (!e?.groupId || e.summonerActorUuid !== summonerActorUuid || e.worldActorId !== worldActorId) continue;
    const g = combat.groups?.get?.(e.groupId);
    if (g?.type !== "squad") continue;
    const members = [...(g.members ?? [])];
    if (!members.some(m => !m.isDefeated)) continue;
    // Already acted (or not yet): DSCT gates squad turns on the group's initiative (R§ fact 26).
    if (((Number(g.initiative) || 0) > 0) !== !!canAct) continue;
    // A held squad that already had its chained turn this round.
    if (!canAct && e.held && e.chainedRound === combat.round) continue;
    if (members.some(m => combat.combatant?.id === m.id || lifecycle.isActing?.(combat.id, m.id))) continue;
    return g;
  }
  return null;
}

const staminaMaxOf = cb => Number(cb?.actor?.system?.stamina?.max) || 0;

/**
 * Combat and squad insertion (§3.6). Idempotent: tokens already in the combat are skipped. Never throws: on failure
 * it deletes what it created itself (combatants first, then a group it created) and returns {error, ...}.
 * @returns {Promise<{combatantIds: string[], groupId: string|null, groupCreated: boolean, poolAdded: number, held: boolean, error?: string}>}
 */
export async function insertSummon({ combat, summonerCombatant, tokens, actor, op, summonId, ownerIds = [] }) {
  const made = { combatantIds: [], groupId: null, groupCreated: false, poolAdded: 0 };
  let joined = null;
  try {
    // Idempotent (GH#1609 drift): a token that already has a combatant is skipped.
    const fresh = (tokens ?? []).filter(t => !list(combat.combatants).some(c => c.tokenId === t.id));
    if (!fresh.length) return { combatantIds: [], groupId: null, groupCreated: false, poolAdded: 0, held: false };
    const minion = !!(actor?.system?.isMinion ?? actor?.isMinion);
    const held = chainHolds(op);
    const canAct = held ? false : op?.actsThisRound !== false; // a held squad sits at 0 like its members
    let group = null;
    if (minion && op?.squad !== "none") {
      if (op?.squad === "join") {
        group = findJoinableSquad(combat, { summonerActorUuid: op.summonerActorUuid, worldActorId: actor.id, canAct });
        joined = group;
      }
      if (!group) {
        const name = (labelsWanted() && freeGroupName(combat)) || actor.name;
        const ownership = { default: 0, ...Object.fromEntries((ownerIds ?? []).map(id => [id, 3])) }; // player clicks the group (R§ 6.2)
        [group] = await combat.createEmbeddedDocuments("CombatantGroup", [{
          type: "squad", name, initiative: canAct ? 1 : 0, ownership,
          flags: { [MODULE_ID]: { summonGroup: { summonId, summonerActorUuid: op.summonerActorUuid, worldActorId: actor.id } } },
        }], INTERNAL());
        if (!group) throw new Error("group not created");
        made.groupId = group.id;
        made.groupCreated = true;
      } else made.groupId = group.id;
    }
    const data = fresh.map((t, k) => ({
      tokenId: t.id, sceneId: t.parent?.id, actorId: t.actorId,
      hidden: !!summonerCombatant?.hidden,
      initiative: initiativeFor({ combat, summonerCombatant, actor, op, k: k + 1, n: fresh.length }),
      ...(group ? { group: group.id } : {}),
      flags: { [MODULE_ID]: { summonOf: summonerCombatant?.id ?? null, summonerTokenId: summonerCombatant?.tokenId ?? null, summonId } },
    }));
    const cbs = await combat.createEmbeddedDocuments("Combatant", data, INTERNAL());
    made.combatantIds = (cbs ?? []).map(c => c.id);
    let poolAdded = 0;
    if (group) {
      // Members FIRST, then the pool (Critic B9): the squad's staminaMax getter now counts the new minions
      // (SquadModel, DSM:15019-15024) and Death Tracker's clamp sees full Stamina.
      const g = combat.groups?.get?.(group.id) ?? group;
      const added = (cbs ?? []).reduce((sum, cb) => sum + staminaMaxOf(cb), 0);
      let next;
      if (made.groupCreated) {
        const max = Number(g.system?.staminaMax);
        next = Number.isFinite(max) && max > 0 ? max : added;
        poolAdded = next;
      } else {
        poolAdded = added;
        next = (Number(g.system?.staminaValue) || 0) + added;
      }
      await g.update({ "system.staminaValue": next }, INTERNAL());
      if (!made.groupCreated) made.poolAdded = poolAdded;
    }
    if (group && labelsWanted()) await applySquadLabels(fresh[0].parent?.id ?? null, combat);
    log("summon.combat", { summonId, combatants: made.combatantIds.length, group: made.groupId, created: made.groupCreated, held });
    return { combatantIds: made.combatantIds, groupId: made.groupId, groupCreated: made.groupCreated, poolAdded, held };
  } catch (err) {
    // Roll back what THIS call made: a joined pool lowered again, our combatants, then our group.
    try {
      if (joined && made.poolAdded > 0) {
        const g = combat.groups?.get?.(joined.id);
        if (g) await g.update({ "system.staminaValue": Math.max(0, (Number(g.system?.staminaValue) || 0) - made.poolAdded) }, INTERNAL());
      }
    } catch (_e) { /* best effort */ }
    await deletePresent(combat, "Combatant", made.combatantIds, INTERNAL()).catch(() => {});
    if (made.groupCreated) await deletePresent(combat, "CombatantGroup", [made.groupId], INTERNAL()).catch(() => {});
    return { combatantIds: [], groupId: null, groupCreated: false, poolAdded: 0, held: false, error: String(err?.message ?? err) };
  }
}

/**
 * The index of the first combatant in `combat.turns` after `from` that is not one of `tokenIds` (and not defeated
 * when the tracker skips defeated combatants), or -1.
 */
function survivorTurn(combat, tokenIds, from) {
  const skip = !!combat?.settings?.skipDefeated;
  return list(combat?.turns).findIndex((t, i) => i > from && !tokenIds.includes(t?.tokenId) && !(skip && t?.isDefeated));
}

/** End the current turn first when it belongs to one of these tokens (R§ fact 19). Returns true when it did. */
export async function endTurnIfCurrent(combat, tokenIds) {
  const cur = combat?.combatant;
  if (!cur || !tokenIds?.includes(cur.tokenId)) return false;
  // Draw Steel's endTurn leaves no current combatant (DSM:11861-11867).
  if (defaultMode() && typeof combat.endTurn === "function") {
    await combat.endTurn();
    return true;
  }
  // Alternative mode: move on to the next combatant that is NOT being removed. A plain nextTurn would usually land on
  // a sibling token of the same summon (adjacent fractional initiatives), which is then deleted while current; core's
  // static Combatant._preDeleteOperation never finds the survivor (it reads the class's `this.turn`), so the old index
  // would skip the next creature, or wrap the round on the clients only (CL/documents/combatant.mjs:264-295).
  const next = survivorTurn(combat, tokenIds, Number.isInteger(combat.turn) ? combat.turn : -1);
  if (next >= 0) await combat.update({ round: combat.round, turn: next }, { direction: 1 });
  else {
    await combat.nextRound();
    if (combat.combatant && tokenIds.includes(combat.combatant.tokenId)) {
      const first = survivorTurn(combat, tokenIds, -1);
      await combat.update({ turn: first >= 0 ? first : null }, { direction: 1 });
    }
  }
  return true;
}

/**
 * Delete embedded ids that still exist (`collection.has(id)`): Combatant, CombatantGroup or Token. Never throws on
 * gone ids. A deletion still in flight elsewhere passes `has` (the local collection changes only when the server
 * answers) and the server then refuses the WHOLE batch ("does not exist"): e.g. Death Tracker's
 * clearSkullsOnCombatEnd deleting dead minions one by one while our encounter-end dismissal runs. Then the ids are
 * filtered again (waiting up to 0.5 s for the collection to catch up) and the rest is deleted once more; a second
 * failure, or no id gone meanwhile, is thrown.
 */
export async function deletePresent(parent, documentName, ids, options) {
  const coll = { Combatant: parent?.combatants, CombatantGroup: parent?.groups, Token: parent?.tokens }[documentName];
  if (!coll || !ids?.length) return [];
  const present = () => [...new Set(ids)].filter(id => id && coll.has(id));
  const live = present();
  if (!live.length) return [];
  try {
    await parent.deleteEmbeddedDocuments(documentName, live, options ?? INTERNAL());
    return live;
  } catch (err) {
    // The other deletion's broadcast may still be on its way: give the collection a moment to catch up.
    let left = present();
    for (let i = 0; i < 5 && left.length === live.length; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      left = present();
    }
    if (left.length === live.length) throw err;   // nothing was deleted by someone else: a real failure
    log("summon.deleteRetry", { documentName, asked: live.length, left: left.length });
    if (left.length) await parent.deleteEmbeddedDocuments(documentName, left, options ?? INTERNAL());
    return left;
  }
}

/**
 * Remove the summon's combatants: delete them, lower surviving squads' pools by the living minions removed, delete
 * groups we created that are now empty (§3.9 steps 3-5).
 * @returns {Promise<{combatantIds: string[], poolRemoved: number, groupsDeleted: string[]}>}
 */
export async function removeFromCombat({ combat, tokenIds }) {
  const ids = new Set(tokenIds ?? []);
  const ours = list(combat?.combatants).filter(c => ids.has(c.tokenId));
  if (!ours.length) return { combatantIds: [], poolRemoved: 0, groupsDeleted: [] };
  // Per group: the Stamina of the living minions we take out (read before the deletion).
  const byGroup = new Map();
  for (const c of ours) {
    const gid = c.group?.id ?? c._source?.group ?? null;
    if (!gid) continue;
    const minion = !!(c.actor?.system?.isMinion ?? c.actor?.isMinion);
    const alive = minion && !c.isDefeated ? staminaMaxOf(c) : 0;
    byGroup.set(gid, (byGroup.get(gid) ?? 0) + alive);
  }
  const deleted = await deletePresent(combat, "Combatant", ours.map(c => c.id), INTERNAL());
  let poolRemoved = 0;
  const groupsDeleted = [];
  for (const [gid, max] of byGroup) {
    const g = combat.groups?.get?.(gid);
    if (!g) continue;
    if ((g.members?.size ?? 0) === 0 && flagsOf(g).summonGroup) {
      groupsDeleted.push(...await deletePresent(combat, "CombatantGroup", [g.id], INTERNAL()));
      continue;
    }
    if (g.type === "squad" && max > 0) {
      await g.update({ "system.staminaValue": Math.max(0, (Number(g.system?.staminaValue) || 0) - max) }, INTERNAL());
      poolRemoved += max;
    }
  }
  return { combatantIds: deleted, poolRemoved, groupsDeleted };
}
