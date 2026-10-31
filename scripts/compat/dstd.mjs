/** Draw Steel: Target Damage facade: read-only access to its private card state. */
import { DSTD_ID } from "../constants.mjs";

export const dstdActive = () => !!game.modules.get(DSTD_ID)?.active;

export function dstdState(message) {
  return message?.flags?.[DSTD_ID]?.state ?? null;
}

/** Token uuids DSTD currently lists for the card (it rewrites them for area auto-targeting). */
export function dstdTargetTokenUuids(message) {
  const targets = dstdState(message)?.targets;
  if (!Array.isArray(targets)) return [];
  return targets.map(t => t?.tokenUuid).filter(u => typeof u === "string" && u.length);
}

/**
 * Live per-token application records of a DSTD `applications` entry (operations.mjs):
 * - plain entry: the entry itself while `status` is "applied";
 * - "selected token" stack (pushApplicationRecord): every element of `stack` is a live application,
 *   the top level only mirrors the newest one;
 * - multi-token applications carry their per-token records in `records`.
 */
function liveRecords(entry) {
  const tops = Array.isArray(entry?.stack) && entry.stack.length ? entry.stack : [entry];
  const out = [];
  for (const rec of tops) {
    if (!rec || (rec.status ?? "applied") !== "applied") continue;
    if (Array.isArray(rec.records) && rec.records.length) out.push(...rec.records.filter(r => (r?.status ?? "applied") === "applied"));
    else out.push(rec);
  }
  return out;
}

/**
 * Which of an op's target tokens Target Damage has already applied the op's row to. DSTD records
 * damage rows by part + roll index + target token and status rows by part + effect + target token.
 * A per-target tier override (state.tierOverrides) makes DSTD apply the overridden tier's part, so for
 * an overridden target any live record of the same kind counts, whatever its part. A squad op of a Draw Steel 1.2
 * card lists every member's part and roll index in `op.parts` (Milestone 8, §1.4): each counts.
 * @param {ChatMessage} message
 * @param {object} op                   Our op (kind, partId, rollIndex, effectId).
 * @param {string[]} tokenUuids         Token uuids of the op's targets.
 * @returns {Set<string>}               The covered token uuids.
 */
export function dstdCoveredTokens(message, op, tokenUuids) {
  const covered = new Set();
  const state = dstdState(message);
  const apps = state?.applications;
  if (!apps || !tokenUuids?.length) return covered;
  const wanted = new Set(tokenUuids);
  const overridden = uuid => !!state.tierOverrides?.[String(uuid).replace(/\./g, "__")];
  const slots = [{ partId: op.partId, rollIndex: op.rollIndex }, ...(Array.isArray(op.parts) ? op.parts : [])];
  const matches = (rec) => {
    const uuid = rec?.target?.tokenUuid;
    if (!wanted.has(uuid)) return false;
    const anyPart = overridden(uuid);
    const mine = slots.filter(s => s?.partId === rec.partId);
    if (!anyPart && !mine.length) return false;
    if (op.kind === "condition") return rec.kind === "status" && rec.effectId === op.effectId;
    if (rec.kind !== "damage" && rec.kind !== "healing") return false;
    return anyPart || mine.some(s => Number(rec.rollIndex) === Number(s.rollIndex));
  };
  for (const entry of Object.values(apps)) {
    for (const rec of liveRecords(entry)) if (matches(rec)) covered.add(rec.target.tokenUuid);
  }
  return covered;
}

/** DSTD's key for a target: token uuid with dots replaced (target-utils.mjs getTargetKey). */
export function dstdTargetKeyFromButton(button) {
  const row = button.closest("[data-target-key]");
  if (row?.dataset.targetKey) return row.dataset.targetKey;
  try {
    const target = JSON.parse(button.dataset.target ?? "null");
    const raw = target?.tokenUuid ?? target?.actorUuid ?? "";
    return raw ? String(raw).replace(/\./g, "__") : null;
  } catch (_err) {
    return null;
  }
}
