/**
 * Summon activation by its owner (Milestone 7, M6 follow-up; docs/M7-DESIGN.md §3.13, D9, Q11; WP-C).
 *
 * The tracker's activate button lowers the combatant's initiative, then sets the combat's `turn` (DSM:28276-28298).
 * For a summon's combatant a player's update is refused by the server (TESTING.md T81: "User Test lacks permission
 * to update Combatant"; the combatant's permission follows the base actor, the summon's ownership lives in the
 * token delta). Hiding the button cannot reach third-party trackers (DSLF dock, Combat Tracker), a client-side
 * veto can:
 *
 * Client (non-GM): `preUpdateCombatant` of an update by this user that LOWERS the initiative of a combatant with
 * `flags["stef-ds-automation"].summonId` returns false and relays `summonActivate {combatId, combatantId}` to the active
 * GM; for 2 s a `preUpdateCombat` of this user that sets `turn` to that combatant is vetoed too (the system's handler
 * continues with it after the vetoed combatant update). A RAISE from 0 (the button on a combatant at 0, e.g. a summon
 * held after its summoner, 0.9.1) is vetoed and relayed as well, so the GM's refusal explains it (no turn change
 * follows a raise). A refusal comes back as a DSAUTO.Relay.* toast.
 *
 * GM (`handleSummonActivate`, called by the relay's card-less M7 routing): the combat exists and is started, the
 * combatant is a summon, the user owns its token's actor (or is a GM), its initiative is above 0
 * (DSAUTO.Relay.SummonCannotAct), it is not held after its summoner (`holdActive`, DSAUTO.Relay.SummonHeld) and no
 * other combatant's turn is running (DSAUTO.Relay.SummonNotNow). Then, on the summon chain, the system's own order:
 * `combatant.update({initiative: initiative - 1})`, `combat.update({turn: index}, {direction: 1})`. These writes are
 * NOT flagged internal: they are a real activation that the lifecycle, Combat Tools and DSLF's dock must see as one.
 *
 * The relay module is imported lazily (it imports this file for the GM handler).
 *
 * i18n keys: DSAUTO.Relay.{SummonCannotAct, SummonHeld, SummonNotNow, UnknownSummon, Denied, BadRequest}.
 */
import { MODULE_ID, loc } from "../constants.mjs";
import { debug, error, log } from "../log.mjs";
import { indexEntries, withSummonChain } from "./registry.mjs";
import { holdActive } from "./turn-chain.mjs";

/** How long the follow-up turn change of a vetoed activation is vetoed too. */
const TURN_VETO_MS = 2_000;
const ID_RE = /^[A-Za-z0-9]{16}$/;

const pending = new Map();   // combatantId -> {combatId, until}; this client's vetoed activations
const relayErr = key => new Error(key);
const warn = text => globalThis.ui?.notifications?.warn?.(text);

/** A relay refusal or failure as text: i18n keys (DSAUTO.*) are localized, anything else shown as is. */
function errorText(err) {
  const msg = String(err?.message ?? err ?? "");
  return msg.startsWith("DSAUTO.") ? loc(msg) : msg;
}

const summonIdOf = combatant => combatant?.flags?.[MODULE_ID]?.summonId ?? null;

/** Send the relay request (fire-and-forget from the veto); a refusal is a toast. */
function relayActivate(combatId, combatantId) {
  import("../relay/queries.mjs")
    .then(m => m.requestOp({ action: "summonActivate", summonActivate: { combatId, combatantId } }))
    .then(out => log("summon.activateRelay", { combatId, combatantId, activated: !!out?.activated }))
    .catch(err => {
      const text = errorText(err);
      if (text) warn(text);
      if (!String(err?.message ?? "").startsWith("DSAUTO.")) error("summons.activateRelay", err, { combatantId });
    });
}

/** preUpdateCombatant (non-GM client): veto a summon's initiative drop by this user and relay it. */
function onPreUpdateCombatant(combatant, changed, options, userId) {
  try {
    if (game.user?.isGM || userId !== game.user?.id) return;
    if (options?.[MODULE_ID]?.internal) return;
    if (!summonIdOf(combatant)) return;
    if (!changed || !Object.prototype.hasOwnProperty.call(changed, "initiative")) return;
    const before = Number(combatant.initiative);
    const after = changed.initiative == null ? NaN : Number(changed.initiative);
    if (!Number.isFinite(before) || !Number.isFinite(after) || after === before) return;
    // The button raises a combatant at 0 to its turns count instead (DSM:28291): a held summon (TESTING.md §14 T116).
    // The server refuses that too; the relay answers with the reason (SummonHeld / SummonCannotAct).
    const raise = after > before;
    if (raise && before > 0) return;
    const combat = combatant.parent ?? combatant.combat ?? null;
    if (!combat?.id || !combatant.id) return;
    if (!raise) pending.set(combatant.id, { combatId: combat.id, until: Date.now() + TURN_VETO_MS });
    debug("summon.activateVeto", { combatId: combat.id, combatantId: combatant.id, raise });
    relayActivate(combat.id, combatant.id);
    return false;
  } catch (err) {
    error("summons.preUpdateCombatant", err);
  }
}

/** preUpdateCombat (non-GM client): veto this user's turn change to a summon whose activation was just relayed. */
function onPreUpdateCombat(combat, changed, options, userId) {
  try {
    if (game.user?.isGM || userId !== game.user?.id || !pending.size) return;
    if (!changed || !Object.prototype.hasOwnProperty.call(changed, "turn")) return;
    const now = Date.now();
    for (const [id, p] of [...pending]) if (p.until < now) pending.delete(id);
    const target = combat?.turns?.[changed.turn] ?? null;
    const p = target ? pending.get(target.id) : null;
    if (!p || p.combatId !== combat.id) return;
    pending.delete(target.id);
    return false;
  } catch (err) {
    error("summons.preUpdateCombat", err);
  }
}

/** init: preUpdateCombatant / preUpdateCombat on non-GM clients (the GM's own clicks need no relay). */
export function registerSummonActivate() {
  if (typeof globalThis.Hooks?.on !== "function") return;
  Hooks.on("preUpdateCombatant", onPreUpdateCombatant);
  Hooks.on("preUpdateCombat", onPreUpdateCombat);
}

/** Does `user` own the summon's token actor (or is a GM)? */
function ownsSummon(user, combatant) {
  if (user?.isGM) return true;
  const actor = combatant?.token?.actor ?? combatant?.actor ?? null;
  try {
    return !!actor?.testUserPermission?.(user, "OWNER");
  } catch (_err) {
    return false;
  }
}

/** The refusal (an i18n key) of an activation now, or null when it may run. */
function refusal(combat, combatant) {
  if (!combat?.started) return "DSAUTO.Relay.SummonNotNow";
  // Held first: a held summon sits at 0, which would otherwise read as "no turn left".
  const entry = indexEntries(combat).find(e => e.summonId === summonIdOf(combatant)) ?? null;
  if (entry && holdActive(combat, entry)) return "DSAUTO.Relay.SummonHeld";
  if (!(Number(combatant.initiative) > 0)) return "DSAUTO.Relay.SummonCannotAct";
  const current = combat.combatant ?? null;
  if (current && current.id !== combatant.id) return "DSAUTO.Relay.SummonNotNow";
  return null;
}

/**
 * GM side of relay summonActivate (§3.13). `req` is the action's data `{combatId, combatantId}` (the full payload
 * `{summonActivate: {...}}` is accepted too). Throws DSAUTO.Relay.* on refusal; resolves {ok, activated}.
 */
export async function handleSummonActivate(req, user) {
  const d = req?.summonActivate ?? req;
  if (!d || typeof d !== "object" || !ID_RE.test(String(d.combatId ?? "")) || !ID_RE.test(String(d.combatantId ?? ""))) throw relayErr("DSAUTO.Relay.BadRequest");
  const combat = game.combats?.get?.(d.combatId) ?? null;
  const combatant = combat?.combatants?.get?.(d.combatantId) ?? null;
  if (!combatant || !summonIdOf(combatant)) throw relayErr("DSAUTO.Relay.UnknownSummon");
  if (!ownsSummon(user, combatant)) throw relayErr("DSAUTO.Relay.Denied");
  const first = refusal(combat, combatant);
  if (first) throw relayErr(first);
  return withSummonChain(async () => {
    // Re-read live: another activation or turn change may have run while queued.
    const live = game.combats?.get?.(d.combatId) ?? null;
    const c = live?.combatants?.get?.(d.combatantId) ?? null;
    if (!c || !summonIdOf(c)) throw relayErr("DSAUTO.Relay.UnknownSummon");
    const why = refusal(live, c);
    if (why) throw relayErr(why);
    const initiative = Number(c.initiative);
    await c.update({ initiative: initiative - 1 });
    const index = live.turns.findIndex(t => t.id === c.id);
    if (index >= 0) await live.update({ turn: index }, { direction: 1 });
    log("summon.activate", { combatId: live.id, combatantId: c.id, by: user?.name ?? null, turn: index });
    return { ok: true, activated: index >= 0 };
  });
}
