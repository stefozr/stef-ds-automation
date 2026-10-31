/**
 * 0.17.0: healing a defeated creature above 0 Stamina revives it (world setting `reviveOnHeal`, default on).
 *
 * Draw Steel: Death Tracker 1.2.1 marks an NPC dead when Dying is created on it (death-tracker.mjs:1526-1545,
 * `_doKillV3`); the system clears Dying and Winded when Stamina rises (updateStaminaEffects) but never Dead, and Death
 * Tracker only revives through Raise Dead, its revive button and the undo paths. So a healed goblin at full Stamina kept
 * its skull, its defeated combatant and its initiative 0.
 *
 * Active GM, on `updateActor` (and `updateToken` for unlinked tokens): Stamina above 0 now, the defeated status on the
 * actor, and the Stamina before the update (the system's `options.ds.previousStamina`) at 0 or below or unknown. A
 * creature killed at positive Stamina (Power Word Kill) stays dead. Heroes, retainers and minions are left alone (a
 * squad's pool decides for minions). Our own undo revives by itself (`options["stef-ds-automation"].undo`).
 * Death Tracker revives through compat/death-tracker.mjs `reviveTokens` (defeated flag, initiative, squad, skull tile);
 * without it the status is removed and the combatant is marked not defeated.
 */
import { MODULE_ID, DT_ID } from "../constants.mjs";
import { setting } from "../settings.mjs";
import { dtActive, reviveTokens } from "../compat/death-tracker.mjs";
import { error, log } from "../log.mjs";

const running = new Set();
const defeatedId = () => CONFIG.specialStatusEffects?.DEFEATED ?? "dead";

/** Should this Stamina update revive the actor? */
export function reviveWanted(actor, options = {}) {
  if (!actor || !setting("reviveOnHeal") || options?.[MODULE_ID]?.undo) return false;
  if (["hero", "retainer"].includes(actor.type) || actor.system?.isMinion) return false;
  if (!actor.statuses?.has?.(defeatedId())) return false;
  const now = Number(actor.system?.stamina?.value);
  if (!Number.isFinite(now) || now <= 0) return false;
  const before = Number(options?.ds?.previousStamina?.value);
  return !(Number.isFinite(before) && before > 0);
}

function tokenUuidsOf(actor) {
  if (actor.isToken && actor.token?.uuid) return [actor.token.uuid];
  return (actor.getActiveTokens?.(false, true) ?? []).map(t => t.uuid).filter(Boolean);
}

/** Revive `actor` (active GM): Death Tracker when active, else the status and the combatant flag. */
export async function reviveHealed(actor, options = {}) {
  if (!actor?.uuid || running.has(actor.uuid)) return false;
  running.add(actor.uuid);
  try {
    const from = options?.ds?.previousStamina?.value ?? null;
    const tokens = tokenUuidsOf(actor);
    if (dtActive() && tokens.length) await reviveTokens(tokens, { expandDeathGroups: false });
    if (actor.statuses?.has?.(defeatedId())) {
      // No Death Tracker (or the Director is not viewing the scene): lift the status ourselves.
      await actor.toggleStatusEffect?.(defeatedId(), { active: false });
      for (const c of game.combats?.contents ?? []) {
        for (const combatant of c.combatants?.contents ?? []) {
          if (combatant.defeated && combatant.actor?.uuid === actor.uuid) await combatant.update({ defeated: false });
        }
      }
    }
    log("revive.onHeal", { actor: actor.name, from, to: actor.system?.stamina?.value ?? null, via: dtActive() ? DT_ID : "status" });
    return true;
  } finally {
    running.delete(actor.uuid);
  }
}

export function registerReviveOnHeal() {
  const run = (actor, options) => {
    if (!game.users?.activeGM?.isSelf || !reviveWanted(actor, options)) return;
    reviveHealed(actor, options).catch(err => error("revive.onHeal", err));
  };
  Hooks.on("updateActor", (actor, changed, options) => {
    if (changed?.system?.stamina) run(actor, options);
  });
  Hooks.on("updateToken", (tokenDoc, changed, options) => {
    if (!tokenDoc?.actorLink && changed?.delta?.system?.stamina) run(tokenDoc.actor, options);
  });
}
