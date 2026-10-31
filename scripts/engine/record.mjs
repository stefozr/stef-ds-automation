/** Access helpers for the resolution record stored in `flags["stef-ds-automation"].resolution`. */
import { FLAG, MODULE_ID, OP_STATUS, PART_ID, PART_TYPE } from "../constants.mjs";

export function getResolution(message) {
  return message?.flags?.[MODULE_ID]?.[FLAG] ?? null;
}

/** Dotted update path inside the record, e.g. recordPath("ops.x") -> "flags.stef-ds-automation.resolution.ops.x". */
export const recordPath = (sub = "") => `flags.${MODULE_ID}.${FLAG}${sub ? `.${sub}` : ""}`;

/** Source data of our message part (inserted by the author, or by the GM if missing). */
export function partSource() {
  return { _id: PART_ID, type: PART_TYPE, name: "", flavor: "", rolls: [], sort: 1_000_000 };
}

export function hasPart(message) {
  try {
    if (message?.system?.parts?.get?.(PART_ID)) return true;
  } catch (_err) { /* fall through */ }
  return !!message?._source?.system?.parts?.[PART_ID];
}

/** The ability user's own row that nobody targeted (library "self" effects). */
export const selfOnly = t => !!t?.self && !t.alsoTarget;

/**
 * Milestone 7: a record that is not a target: the user's own row, or a gainer who is on the card only for a resource gain
 * (`gainOnly`, docs/M7-DESIGN.md §1.6). Gain rows never lock the card's targets and never count as "already targeted".
 */
export const sideOnly = t => selfOnly(t) || (!!t?.gainOnly && !t.alsoTarget) || pickedOnly(t) || areaOnly(t);

/**
 * Milestone 9 (docs/M9-DESIGN.md §A): a creature on the card only because the user's owner picked it for a
 * `targets: "pick"` effect (`pickOnly`), or because it stood inside the area the use placed (`area` without
 * `alsoTarget`; a real target inside the area carries both). Their rows come from those effects alone
 * (engine/side-targets.mjs).
 */
export const pickedOnly = t => !!t?.pickOnly;
export const areaOnly = t => !!t?.area && !t.alsoTarget;

/** Target records the user actually targeted (without the user's own row and gain-only records). */
export function realTargets(res) {
  return Object.fromEntries(Object.entries(res?.targets ?? {}).filter(([, t]) => !sideOnly(t)));
}

/** Ops that touch a real target (not only the user's own row or a gain-only record). */
export function targetedOps(res) {
  return Object.values(res?.ops ?? {}).filter(op => !(op.targetKeys?.length && op.targetKeys.every(k => sideOnly(res?.targets?.[k]))));
}

/** Milestone 6 / 7: placed on the canvas, never automatic, never part of "Apply all"; applied in the last phase. */
export const PLACED_KINDS = new Set(["summon", "zone"]);

/** Rows only their own button applies: "Apply all" and the footer count leave them out (Milestone 7, re-exported by the engine). */
export const ownButtonOnly = op => PLACED_KINDS.has(op?.kind) || (op?.kind === "gain" && !!op.gain?.confirm);

/** Ops in display/application order. */
export function sortedOps(res) {
  return Object.values(res?.ops ?? {}).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function isApplied(op) {
  return op?.status === OP_STATUS.APPLIED || op?.status === OP_STATUS.EXTERNAL;
}

/** The longest hold of a card (`2 x 120 s + 6 s`, the longest offer) plus a margin (Milestone 5). */
export const HOLD_MAX_MS = 260_000;

/**
 * Until when a card's triggered-action hold (`res.hold`, Milestone 5) counts as live, in server ms.
 * `hold.until` is clamped to `base + 260 s`, with `base` the GM-signed `hold.at` of a resolved card, else
 * a server-set time (a fresh card's record is author-written; review integration 20): the message's last
 * modification (`_stats.modifiedTime`, set by the server on the hold's own write), at least its creation
 * `timestamp`. A fresh card resolved minutes after it was posted (the sweep, "Resolve now") keeps a live hold
 * (third review); a hold nobody writes again still runs out 260 s after the card's last change.
 * 0 without a hold. Readers (view, sweep, Busy guard) compare it with the server time.
 */
export function effectiveUntil(res, message) {
  const h = res?.hold;
  if (!h) return 0;
  const base = res.resolvedAt
    ? Number(h.at)
    : Math.max(Number(message?.timestamp) || 0, Number(message?._stats?.modifiedTime) || 0);
  const cap = (Number.isFinite(base) ? base : 0) + HOLD_MAX_MS;
  const until = Number(h.until);
  return Number.isFinite(until) ? Math.min(until, cap) : cap;
}

/** Next sequence number for an applied op (Undo all runs in reverse sequence). */
export function nextSeq(res, extra = []) {
  const seqs = [...Object.values(res?.ops ?? {}), ...extra].map(o => o?.seq ?? 0);
  return Math.max(0, ...seqs) + 1;
}
