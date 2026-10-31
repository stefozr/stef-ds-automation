/**
 * Malice reminders (Milestone 7, docs/M7-DESIGN.md §2.1 WP-A, §3.8, Q6, R10). Active GM.
 *
 * At a monster's turn start (our lifecycle, once per activation), the Director gets a whisper listing the monster's
 * start-of-turn malice features the pool can pay now: abilities of `system.type === "none"` with a cost
 * (`Number(system.resource) > 0`, category maliceAncestry or the Delian Tomb's "heroic" ones). Cost-free headers ("Goblin
 * Malice Features") and malice actions / triggers (main, maneuver, triggered, free…) are not listed: they are used as
 * actions, not at turn start. One whisper per (combat, round, feature set, Malice value): a second goblin of the same
 * kind that round with the same pool gets none.
 *
 * The whisper is a plain message with `flags["stef-ds-automation"].maliceReminder = {combatId, round, actorUuid, items}` and
 * one Use button per feature (`button.ds-auto-malice-use[data-uuid]`); WP-C's ui/malice-reminder.mjs wires the buttons
 * on GM clients (`item.system.use()`: the system's dialog spends the Malice, never us). The listener never awaits the
 * whisper (fire-and-forget: the lifecycle queue is never held).
 * i18n keys: DSAUTO.Malice.ReminderSpeaker, DSAUTO.Malice.ReminderIntro, DSAUTO.Malice.Use, DSAUTO.Malice.Cost.
 */
import { MODULE_ID, loc } from "../constants.mjs";
import { itemDsid } from "../library/identity.mjs";
import { error, log } from "../log.mjs";
import { setting } from "../settings.mjs";
import * as lifecycle from "../turn/lifecycle.mjs";
import { worldValue } from "./world-resources.mjs";

const MAX_KEYS = 500;
const claimed = new Set();

const isActiveGM = () => !!game.users?.activeGM?.isSelf;
const esc = v => (globalThis.foundry?.utils?.escapeHTML ?? (s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)))(String(v ?? ""));

/** Array view of a Foundry collection, a Map or an array (harness mocks). */
function list(c) {
  if (!c) return [];
  if (Array.isArray(c)) return c;
  if (Array.isArray(c.contents)) return c.contents;
  if (typeof c.values === "function") return [...c.values()];
  return [];
}

function claim(key) {
  if (claimed.has(key)) return false;
  claimed.add(key);
  if (claimed.size > MAX_KEYS) {
    let drop = claimed.size - MAX_KEYS / 2;
    for (const k of claimed) {
      if (drop-- <= 0) break;
      claimed.delete(k);
    }
  }
  return true;
}

/**
 * The NPC's affordable start-of-turn malice features: [{uuid, name, cost, dsid}], abilities of `system.type === "none"`
 * with `Number(system.resource) > 0` and cost <= malice, unique by dsid.
 */
export function maliceFeatures(actor, malice = worldValue("malice")) {
  if (actor?.type !== "npc") return [];
  const pool = Number(malice) || 0;
  const out = [];
  const seen = new Set();
  for (const item of list(actor.items)) {
    if (item?.type !== "ability" || item.system?.type !== "none") continue;
    const cost = Number(item.system?.resource);
    if (!Number.isFinite(cost) || cost <= 0 || cost > pool) continue;
    const dsid = itemDsid(item) ?? item.id;
    if (seen.has(dsid)) continue;
    seen.add(dsid);
    out.push({ uuid: item.uuid, name: item.name ?? "", cost, dsid });
  }
  return out;
}

function content(actor, malice, feats) {
  const rows = feats.map(f => `<li class="ds-auto-malice-item"><span class="ds-auto-malice-name">${esc(f.name)}</span> `
    + `<span class="ds-auto-malice-cost">${esc(loc("DSAUTO.Malice.Cost", { cost: f.cost }))}</span> `
    + `<button type="button" class="ds-auto-malice-use" data-uuid="${esc(f.uuid)}">${esc(loc("DSAUTO.Malice.Use"))}</button></li>`);
  return `<div class="ds-auto-malice-reminder"><p>${esc(loc("DSAUTO.Malice.ReminderIntro", { name: actor.name ?? "", malice }))}</p>`
    + `<ul>${rows.join("")}</ul></div>`;
}

async function remind({ event, combat, actor, combatant }) {
  if (event !== "turnStart" || !isActiveGM()) return;
  if (!(setting("maliceReminders") ?? true) || setting("enabled") === false) return;
  if (actor?.type !== "npc" || !combat?.started) return;
  const malice = worldValue("malice");
  const feats = maliceFeatures(actor, malice);
  if (!feats.length) return;
  const key = `${combat.id}:${combat.round}:${feats.map(f => f.dsid).sort().join(",")}:${malice}`;
  if (!claim(key)) return;
  const gms = game.users?.filter?.(u => u.isGM).map(u => u.id) ?? [];
  const items = feats.map(f => ({ uuid: f.uuid, name: f.name, cost: f.cost }));
  await ChatMessage.implementation.create({
    content: content(actor, malice, feats), whisper: gms,
    speaker: { alias: loc("DSAUTO.Malice.ReminderSpeaker") },
    flags: { [MODULE_ID]: { maliceReminder: { combatId: combat.id, round: combat.round, actorUuid: actor.uuid, items } } },
  });
  log("malice.reminder", { actor: actor.name, combatant: combatant?.name, malice, items: items.map(i => i.name) });
}

/** init: lifecycle turnStart listener (fire-and-forget whisper, §3.8). */
export function registerMaliceReminders() {
  lifecycle.onTurnEvent?.(payload => {
    try {
      remind(payload ?? {}).catch(err => error("malice.reminder", err));
    } catch (err) {
      error("malice.reminder", err);
    }
  });
  Hooks.on("deleteCombat", combat => {
    try {
      for (const k of [...claimed]) if (k.startsWith(`${combat?.id}:`)) claimed.delete(k);
    } catch (err) {
      error("malice.reminder", err);
    }
  });
}
