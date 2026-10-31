/**
 * Waiting indicator (Milestone 5, docs/M5-DESIGN.md §2.1 WP-B, §3.4). On the active GM: one line per open
 * trigger prompt (`DSAUTO.Trigger.Indicator.Waiting`) with a Release button (= declined); on the client of a
 * player whose own click is held (external damage): "Waiting for triggered actions" without a button
 * (review rules-ux 23). A fixed `<aside id="ds-auto-trigger-indicator" class="ds-auto-trigger-indicator">`
 * on `document.body` (bottom right, left of the sidebar). One `setInterval(500)` ticks the seconds from the
 * server-time deadlines while it is non-empty; the element is removed when empty. Not a toast: ds-local-fixes
 * Fix 4 mutes info toasts in combat. Without a DOM (node harnesses) nothing is shown.
 *
 * i18n keys: DSAUTO.Trigger.Indicator.Title, .Waiting, .Release, .Requester.
 */
import { loc } from "../constants.mjs";
import { error } from "../log.mjs";

const ROOT_ID = "ds-auto-trigger-indicator";
const TICK_MS = 500;

const rows = new Map(); // id -> {kind: "gm"|"requester", actorName, abilities, deadline, onRelease, el, text}
let root = null;
let list = null;
let ticker = null;

const serverNow = () => game.time?.serverTime ?? Date.now();
const secondsLeft = deadline => Math.max(0, Math.ceil(((Number(deadline) || 0) - serverNow()) / 1000));

function make(tag, ...classes) {
  const el = globalThis.document?.createElement?.(tag);
  if (el && classes.length) el.classList?.add?.(...classes);
  return el ?? null;
}

function ensureRoot() {
  if (root) return root;
  const body = globalThis.document?.body;
  if (!body?.append) return null;
  root = make("aside", "ds-auto-trigger-indicator");
  if (!root) return null;
  root.id = ROOT_ID;
  const title = make("header", "ds-auto-trigger-indicator-title");
  if (title) {
    title.textContent = loc("DSAUTO.Trigger.Indicator.Title");
    root.append(title);
  }
  list = make("ul", "ds-auto-trigger-indicator-rows");
  if (list) root.append(list);
  body.append(root);
  return root;
}

function rowText(row) {
  const seconds = secondsLeft(row.deadline);
  if (row.kind === "requester") return loc("DSAUTO.Trigger.Indicator.Requester", { seconds });
  return loc("DSAUTO.Trigger.Indicator.Waiting", { actor: row.actorName ?? "", abilities: (row.abilities ?? []).join(", "), seconds });
}

function paint(row) {
  if (row.text) row.text.textContent = rowText(row);
}

function tick() {
  try {
    for (const row of rows.values()) paint(row);
  } catch (err) {
    error("triggers.indicator", err);
  }
}

/** Remove one line (the aside stays). */
function dropRow(id) {
  const row = rows.get(id);
  if (!row) return;
  rows.delete(id);
  row.el?.remove?.();
}

function addRow(id, row) {
  dropRow(id);
  if (!ensureRoot() || !list) return;
  const el = make("li", "ds-auto-trigger-indicator-row", `ds-auto-trigger-indicator-row--${row.kind}`);
  if (!el) return;
  if (el.dataset) el.dataset.promptId = String(id);
  row.text = make("span", "ds-auto-trigger-indicator-text");
  if (row.text) el.append(row.text);
  if (row.kind === "gm" && typeof row.onRelease === "function") {
    const button = make("button", "ds-auto-trigger-release");
    if (button) {
      button.type = "button";
      button.textContent = loc("DSAUTO.Trigger.Indicator.Release");
      button.onclick = event => {
        event?.preventDefault?.();
        try {
          row.onRelease();
        } catch (err) {
          error("triggers.release", err);
        }
      };
      el.append(button);
    }
  }
  row.el = el;
  rows.set(id, row);
  list.append(el);
  paint(row);
  ticker ??= setInterval(tick, TICK_MS);
}

/** GM rows: one per open prompt, with a Release button. */
export function showWaiting(promptId, { actorName, abilities, deadline, onRelease } = {}) {
  try {
    if (promptId == null) return;
    addRow(promptId, { kind: "gm", actorName, abilities: [...(abilities ?? [])], deadline, onRelease });
  } catch (err) {
    error("triggers.indicator", err);
  }
}

/** Review rules-ux 23: "Waiting for triggered actions" on the requester's client. */
export function showRequesterWaiting(token, { deadline } = {}) {
  try {
    if (token == null) return;
    addRow(token, { kind: "requester", deadline });
  } catch (err) {
    error("triggers.indicator", err);
  }
}

export function clearWaiting(promptIdOrToken) {
  try {
    dropRow(promptIdOrToken);
    if (rows.size) return;
    if (ticker !== null) clearInterval(ticker);
    ticker = null;
    root?.remove?.();
    root = null;
    list = null;
  } catch (err) {
    error("triggers.indicator", err);
  }
}

/** Creates nothing until the first show. */
export function registerIndicator() {
  // Nothing to set up: the aside is built on the first show and removed when its last line clears.
}
