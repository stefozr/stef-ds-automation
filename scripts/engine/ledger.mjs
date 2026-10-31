/**
 * Record integrity. The resolution record lives in a message flag, and the card's author owns the
 * message (ChatMessage#getUserLevel), so a player can rewrite the record from the console. The active
 * GM therefore signs every record it writes: a hash per message in a world setting only GMs can write.
 * The engine acts only on records whose hash matches ("ok") or that were never resolved ("fresh",
 * whose seeded ops are ignored); "tampered" and "unsigned" resolved records are locked until a GM
 * trusts them again (`api.trustCard`).
 *
 * Hash: two seeded cyrb53 passes over a canonical (key-sorted) JSON, 106 bits. Not cryptographic, but
 * the attacker cannot write the ledger and would need a second preimage.
 */
import { MODULE_ID } from "../constants.mjs";
import { error, log } from "../log.mjs";
import { getResolution } from "./record.mjs";

const SETTING = "ledger";
const MAX_ENTRIES = 2000;
const SAVE_DELAY_MS = 250;
export const LEDGER_VERSION = 1;

let ledger = null;
let saveTimer = null;

function cyrb53(str, seed) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** JSON with sorted keys and without undefined values, so every client and the server agree. */
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(v => canonical(v === undefined ? null : v)).join(",")}]`;
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

export function recordHash(res) {
  const s = canonical(res ?? null);
  return cyrb53(s, 1) + cyrb53(s, 7);
}

function load() {
  if (ledger) return ledger;
  let stored = null;
  try {
    stored = game.settings.get(MODULE_ID, SETTING);
  } catch (_err) { /* before registration */ }
  ledger = { v: stored?.v ?? 0, h: { ...(stored?.h ?? {}) } };
  return ledger;
}

/** Another GM saved the ledger (setting onChange): drop the cache so the next read reloads it. */
export function onLedgerChanged() {
  if (!saveTimer) ledger = null;
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const data = load();
    const ids = Object.keys(data.h).filter(id => game.messages.has(id));
    const kept = ids.slice(-MAX_ENTRIES);
    data.h = Object.fromEntries(kept.map(id => [id, data.h[id]]));
    game.settings.set(MODULE_ID, SETTING, { v: data.v, h: data.h }).catch(err => error("ledger.save", err));
  }, SAVE_DELAY_MS);
}

/** Sign the message's current record (active GM, right after its own write). */
export function sign(message) {
  if (!game.user.isGM || !message) return;
  const res = getResolution(message);
  const data = load();
  if (res) data.h[message.id] = recordHash(res);
  else delete data.h[message.id];
  scheduleSave();
}

/**
 * @returns {"none"|"fresh"|"ok"|"tampered"|"unsigned"}
 *   fresh: seeded, never resolved and never signed; ok: matches the GM's signature;
 *   tampered: signed but changed since; unsigned: claims to be resolved but the GM never signed it.
 */
export function integrity(message) {
  const res = getResolution(message);
  if (!res) return "none";
  const entry = load().h[message?.id];
  if (!entry) return res.resolvedAt ? "unsigned" : "fresh";
  return entry === recordHash(res) ? "ok" : "tampered";
}

export const trusted = message => ["fresh", "ok"].includes(integrity(message));

/** One-time trust-on-first-use of every resolved card that existed before the ledger (0.1.x cards). */
export function migrateLedger() {
  if (!game.users.activeGM?.isSelf) return;
  const data = load();
  if (data.v >= LEDGER_VERSION) return;
  let count = 0;
  for (const m of game.messages) {
    const res = getResolution(m);
    if (!res?.resolvedAt || data.h[m.id]) continue;
    data.h[m.id] = recordHash(res);
    count++;
  }
  data.v = LEDGER_VERSION;
  log("ledger.migrate", { signed: count });
  scheduleSave();
}

/** Test hook: forget the cache. */
export function resetLedgerCache() {
  ledger = null;
}
