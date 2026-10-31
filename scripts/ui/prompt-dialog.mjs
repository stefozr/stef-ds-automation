/**
 * Optional confirmation dialog (client setting `promptDialog`, Milestone 1.5): after the active
 * Director's client resolves a card whose rows wait for confirmation ("Ask the Director"), it opens a
 * dialog listing them with a checkbox each. Apply selected sends them through the relay like the card
 * buttons; Later leaves them on the card. One dialog per card at a time; never blocks the engine.
 */
import { HOOKS, OP_STATUS, loc } from "../constants.mjs";
import { error } from "../log.mjs";
import { opLabel } from "../parts/view.mjs";
import { requestOp, relayErrorText } from "../relay/queries.mjs";
import { setting } from "../settings.mjs";

const open = new Set();

export function registerPromptDialog() {
  Hooks.on(HOOKS.resolved, (message, res) => {
    if (!setting("promptDialog") || !game.users.activeGM?.isSelf || !message || !res) return;
    const waiting = Object.values(res.ops ?? {})
      .filter(op => op.mode === "prompt" && op.status === OP_STATUS.PENDING && !op.noApply)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (!waiting.length || open.has(message.id)) return;
    showDialog(message, res, waiting).catch(err => error("promptDialog", err));
  });
}

function rowText(res, op) {
  const names = (op.targetKeys ?? []).map(k => res.targets?.[k]?.name).filter(Boolean);
  const who = op.group ? loc("DSAUTO.Card.Squad", { name: op.groupName ?? "" }) : names.join(", ");
  return who ? `${who}: ${opLabel(res, op)}` : opLabel(res, op);
}

async function showDialog(message, res, waiting) {
  const DialogV2 = foundry.applications.api.DialogV2;
  const esc = foundry.utils.escapeHTML ?? (v => String(v));
  const rows = waiting.map(op => `<label class="checkbox ds-auto-prompt-row">
      <input type="checkbox" name="op" value="${esc(op.opId)}" checked> ${esc(rowText(res, op))}
    </label>`).join("");
  const content = `<p>${esc(loc("DSAUTO.PromptDialog.Intro", { name: res.abilityName ?? "" }))}</p>
    <div class="ds-auto-prompt-rows">${rows}</div>`;
  open.add(message.id);
  let chosen = null;
  try {
    chosen = await DialogV2.wait({
      window: { title: "DSAUTO.PromptDialog.Title", icon: "fa-solid fa-wand-magic-sparkles" },
      content,
      rejectClose: false,
      buttons: [
        {
          action: "apply", label: "DSAUTO.PromptDialog.Apply", icon: "fa-solid fa-play", default: true,
          callback: (_event, button) => [...button.form.querySelectorAll('input[name="op"]:checked')].map(i => i.value),
        },
        { action: "later", label: "DSAUTO.PromptDialog.Later", icon: "fa-solid fa-clock" },
      ],
    });
  } finally {
    open.delete(message.id);
  }
  if (!Array.isArray(chosen) || !chosen.length) return;
  try {
    const result = await requestOp({ action: "apply", messageId: message.id, opIds: chosen });
    if (result?.refused?.length) ui.notifications.warn(loc("DSAUTO.Relay.Refused", { count: result.refused.length }));
  } catch (err) {
    ui.notifications.warn(relayErrorText(err));
  }
}
