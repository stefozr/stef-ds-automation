/**
 * 1.2.2: Combat Tools' "choose one" copies that move a spend into the choice. Combat Tools turns the system's `spend`
 * effect into a plain one and puts the spend on the kept flat effect (`dsct.flatCleanse` with `flatCleanse.spend =
 * {enabled, value}`, My Life for Yours: Stand Up / Cleanse), so the roll dialog has no spend box and `useState().spend`
 * stays false. The overlay effects gated `when.spend` of that kind still belong to the pick, but they must neither
 * apply nor charge silently: libraryOps plans them as a waiting row that asks for the spend (library-plan.mjs).
 */
import { DSCT_ID, OP_STATUS } from "../constants.mjs";
import { getResolution } from "../engine/record.mjs";
import { DSCT_FLAT } from "./resolve.mjs";

const FLAG = "choosePicks";
/** How far back a trigger card may be for its payment to count for a use card (ms). */
const TRIGGER_WINDOW_MS = 30 * 60 * 1000;
/** How many of the latest chat messages are looked at. */
const SCAN = 80;

const list = v => (Array.isArray(v) ? v : (v instanceof Set ? [...v] : []));

function effectsOf(item) {
  try {
    return [...(item?.system?.effects?.contents ?? [])];
  } catch (_err) {
    return [];
  }
}

/**
 * What Combat Tools' picks on the card keep with a spend of their own.
 * @returns {{type: string, cost: number, name: string, statusFilter: string[], expiryFilter: string[]}[]}
 *   one entry per kept flat effect with `spend.enabled`; empty without picks, without a choose effect, or when the item
 *   still has a system `spend` effect (the roll dialog's box carries the spend then).
 */
export function ctPickedSpends(item, message) {
  const effects = effectsOf(item);
  if (!effects.length || effects.some(e => e.type === "spend")) return [];
  let picks = null;
  try {
    picks = message?.getFlag?.(DSCT_ID, FLAG) ?? message?.flags?.[DSCT_ID]?.[FLAG] ?? null;
  } catch (_err) { /* no flags */ }
  if (!picks || typeof picks !== "object") return [];
  const kept = new Set();
  for (const e of effects) {
    if (e.type !== "dsct.choose") continue;
    const raw = picks[e.id];
    const chosen = (Array.isArray(raw) ? raw : [raw]).filter(v => v !== undefined && v !== null).map(Number).filter(Number.isInteger);
    for (const i of chosen) for (const name of e.choose?.choices?.[i]?.effects ?? []) kept.add(String(name).trim());
  }
  if (!kept.size) return [];
  const out = [];
  for (const e of effects) {
    const type = DSCT_FLAT[e.type];
    const data = type ? e[e.type.split(".")[1]] : null;
    if (!type || !data?.spend?.enabled || !kept.has(String(e.name ?? "").trim())) continue;
    out.push({
      type, name: String(e.name ?? ""), cost: Math.max(1, Math.floor(Number(data.spend.value)) || 1),
      statusFilter: list(data.statusFilter).map(String), expiryFilter: list(data.expiryFilter).map(String),
    });
  }
  return out;
}

const abilityUuidOf = message => {
  for (const p of message?.system?.parts?.contents ?? []) if (p?.type === "abilityUse") return p.abilityUuid ?? null;
  return null;
};

/**
 * Did our damage trigger already take the spend for this use (overlay trigger `protect`, triggers/card.mjs pay)? The
 * newest trigger card of this ability that paid a spend (its payment row applied, not undone) before this use card,
 * with no other card of the ability in between (the card then belongs to that reaction), within half an hour.
 */
export function triggerPaidSpend(message, item) {
  try {
    const all = [...(game.messages?.contents ?? [])].slice(-SCAN);
    const at = Number(message?.timestamp) || Date.now();
    const itemUuid = item?.uuid;
    if (!itemUuid) return false;
    for (let i = all.length - 1; i >= 0; i--) {
      const m = all[i];
      if (!m || m.id === message?.id || (Number(m.timestamp) || 0) > at) continue;
      if (abilityUuidOf(m) === itemUuid) return false;
      const res = getResolution(m);
      if (res?.shape !== "trigger" || res.trigger?.itemUuid !== itemUuid) continue;
      if (at - (Number(m.timestamp) || 0) > TRIGGER_WINDOW_MS) return false;
      if (!res.trigger.spend || res.trigger.spendByUse || !(Number(res.trigger.spendCost) > 0)) return false;
      return Object.values(res.ops ?? {}).some(o => o.triggerSpend && o.status === OP_STATUS.APPLIED);
    }
  } catch (_err) { /* no history */ }
  return false;
}
