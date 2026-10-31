/**
 * Malice reminder whisper, card side (Milestone 7, docs/M7-DESIGN.md §3.8, Q6; WP-C). Every client; the Use buttons
 * work for GMs only (the whisper goes to GMs anyway).
 *
 * WP-A's `malice-reminders.mjs` whispers the Director at a monster's turn start with
 * `flags["stef-ds-automation"].maliceReminder = {combatId, round, actorUuid, items: [{uuid, name, cost}]}`. On every render
 * of such a message (authored by a GM: the flag is only trusted then) this file wires the Use buttons:
 *   - buttons already in the content: `[data-ds-auto-malice-use]` or `button[data-uuid]` inside
 *     `.ds-auto-malice-reminder`, each limited to a uuid the flag lists;
 *   - none in the content: a list is appended from the flag (name, cost, Use), so the reminder works whatever
 *     markup the whisper carries.
 * A click runs `item.system.use({event})` on this GM client: the system's own dialog and Malice spend
 * (DSM:6457-6469), never ours; the card that use posts resolves as any. The button is disabled while the use runs.
 *
 * 0.9.1: when the system's dialog has not opened after DIALOG_WAIT_MS (another module vetoed it), the button comes
 * back with a warning.
 *
 * i18n keys: DSAUTO.Malice.{Use, Cost, NoDialog}.
 */
import { MODULE_ID, loc } from "../constants.mjs";
import { debug, error, log } from "../log.mjs";
import { clock } from "../triggers/prompt.mjs";

const MAX_ITEMS = 30;
const running = new Set();   // item uuids whose use is running on this client

const esc = v => {
  const s = String(v ?? "");
  const fn = globalThis.foundry?.utils?.escapeHTML;
  return typeof fn === "function" ? fn(s) : s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
};

/** The reminder flag of a message, only when a GM wrote the message; null otherwise. Items are sanitized. */
export function reminderOf(message) {
  const f = message?.flags?.[MODULE_ID]?.maliceReminder;
  if (!f || typeof f !== "object") return null;
  const author = message.author ?? message.user ?? null;
  if (!author?.isGM) return null;
  const items = (Array.isArray(f.items) ? f.items : [])
    .filter(i => i && typeof i.uuid === "string" && i.uuid.length > 0 && i.uuid.length <= 300)
    .slice(0, MAX_ITEMS)
    .map(i => ({ uuid: i.uuid, name: String(i.name ?? ""), cost: Number(i.cost) || 0 }));
  return { ...f, items };
}

/** The list markup appended when the whisper has no buttons of its own. */
function listHtml(items) {
  const rows = items.map(i => `<li class="ds-auto-malice-item">`
    + `<span class="ds-auto-malice-name">${esc(i.name)}</span>`
    + `<span class="ds-auto-malice-cost">${esc(loc("DSAUTO.Malice.Cost", { cost: i.cost }))}</span>`
    + `<button type="button" class="ds-auto-malice-use" data-ds-auto-malice-use data-uuid="${esc(i.uuid)}">`
    + `<i class="fa-solid fa-bolt" inert></i> ${esc(loc("DSAUTO.Malice.Use"))}</button></li>`).join("");
  return `<ul class="ds-auto-malice-list">${rows}</ul>`;
}

/**
 * How long the system's dialog may take to open. A module that vetoes `ds.canRenderAbilityConfigurationDialog` (Combat
 * Tools' range check against the Director's current targets) leaves the system's `use()` pending for good
 * (DSM:411-426, TESTING.md §14 T111): the button would stay disabled forever.
 */
export const DIALOG_WAIT_MS = 4_000;

/** Use one listed feature on this GM client (the system's dialog and spend). Never throws. */
async function useItem(uuid, event, button) {
  if (running.has(uuid)) return;
  running.add(uuid);
  if (button) button.disabled = true;
  let hook = null;
  let timer = null;
  try {
    const item = await fromUuid(uuid);
    if (typeof item?.system?.use !== "function") {
      debug("malice.reminderUse", { uuid, why: "gone" });   // the item was deleted since the whisper
      return;
    }
    log("malice.reminderUse", { item: item.name, uuid });
    let opened = false;
    hook = Hooks.on("renderAbilityConfigurationDialog", app => {
      if ((app?.options?.ability?.uuid ?? app?.ability?.uuid) === uuid) opened = true;
    });
    const use = Promise.resolve(item.system.use({ event })).then(() => "done");
    const waited = new Promise(resolve => { timer = clock.setTimeout(() => resolve("wait"), DIALOG_WAIT_MS); });
    let outcome = await Promise.race([use, waited]);
    if (outcome === "wait" && opened) outcome = await use;    // the dialog is open: wait for the Director
    if (outcome === "wait") {
      use.catch(err => error("malice.reminderUse", err, { uuid }));
      debug("malice.reminderUse", { uuid, why: "noDialog" });
      globalThis.ui?.notifications?.warn?.(loc("DSAUTO.Malice.NoDialog", { name: item.name }));
    }
  } catch (err) {
    error("malice.reminderUse", err, { uuid });
  } finally {
    if (hook !== null) Hooks.off("renderAbilityConfigurationDialog", hook);
    if (timer !== null) clock.clearTimeout(timer);
    running.delete(uuid);
    if (button) button.disabled = false;
  }
}

/** Wire (or add) the Use buttons of a rendered reminder whisper. Returns the number of buttons wired. */
export function decorateReminder(message, root) {
  const rem = reminderOf(message);
  if (!rem || !root?.querySelectorAll) return 0;
  const allowed = new Set(rem.items.map(i => i.uuid));
  let buttons = [...root.querySelectorAll("[data-ds-auto-malice-use], .ds-auto-malice-reminder button[data-uuid]")];
  if (!buttons.length && rem.items.length) {
    const host = root.querySelector(".message-content") ?? root;
    const wrap = document.createElement("div");
    wrap.className = "ds-auto-malice-reminder";
    wrap.innerHTML = listHtml(rem.items);
    host.appendChild(wrap);
    buttons = [...wrap.querySelectorAll("[data-ds-auto-malice-use]")];
  }
  const isGM = !!game.user?.isGM;
  let n = 0;
  for (const button of buttons) {
    const uuid = button.dataset?.uuid;
    if (!uuid || !allowed.has(uuid) || !isGM) {
      button.disabled = true;
      continue;
    }
    if (button.dataset.dsAutoWired) continue;   // a re-render of the same element
    button.dataset.dsAutoWired = "1";
    button.disabled = running.has(uuid);
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      useItem(uuid, event, button);
    });
    n++;
  }
  return n;
}

/** init: renderChatMessageHTML -> the reminder card's Use buttons run `item.system.use({event})` on this GM client. */
export function registerMaliceReminderUI() {
  if (typeof globalThis.Hooks?.on !== "function") return;
  Hooks.on("renderChatMessageHTML", (message, html) => {
    try {
      if (!message?.flags?.[MODULE_ID]?.maliceReminder) return;
      const root = globalThis.HTMLElement && html instanceof HTMLElement ? html : html?.[0] ?? html;
      decorateReminder(message, root);
    } catch (err) {
      error("malice.reminderRender", err, { messageId: message?.id ?? null });
    }
  });
}
