/**
 * The resolution section of an ability card: a MessagePart type of our own, so it renders the same
 * with and without Draw Steel Plus' improved chat (which swaps the system's part templates).
 *
 * It must be registered at MODULE IMPORT time: the system's CollectionField snapshots the registered
 * part types once, when the ChatMessage "standard" schema is first built (draw-steel.mjs:15413).
 */
import { MODULE_ID, PART_TYPE, loc } from "../constants.mjs";
import { getResolution } from "../engine/record.mjs";
import { availableSurges, surgeActor, surgeDamage } from "../engine/surges.mjs";
import { chosenDistance, chosenMovement } from "../engine/forced.mjs";
import { cleanseCandidates } from "../engine/library-plan.mjs";
import { dsctApi } from "../compat/dsct.mjs";
import { dsctTeleport, moveTokenTo, positionOf, samePosition } from "../delegation/teleport.mjs";
import { buildView, movementLabel } from "./view.mjs";
import { runSummonPick } from "../summons/place.mjs";
import { runZonePick } from "../zones/place.mjs";
import { toggleFold } from "../ui/dstd-fold.mjs";
import { cleanseDialog } from "../ui/cleanse-choice.mjs";
import { localPick } from "../ui/target-pick.mjs";

const BaseMessagePart = globalThis.ds?.data?.pseudoDocuments?.messageParts?.BaseMessagePart;

/** The relay entry point (relay/queries.mjs requestOp), injected by main.mjs to keep this file free of engine imports. */
export const partActions = {
  request: null,
};

function messageOf(part) {
  return part.message ?? null;
}

/** Send one card action to the active GM; denials come back as i18n keys and are shown as warnings. */
async function run(event, payload) {
  event.preventDefault();
  event.stopPropagation();
  const button = event.currentTarget;
  if (button) button.disabled = true;
  try {
    if (!payload.messageId) return;
    const result = await partActions.request?.(payload);
    if (result?.refused?.length) ui.notifications.warn(loc("DSAUTO.Relay.Refused", { count: result.refused.length }));
  } catch (err) {
    const msg = String(err?.message ?? "");
    if (msg.startsWith("DSAUTO.")) ui.notifications.warn(loc(msg));
    else Hooks.onError(`${MODULE_ID}.cardAction`, err, { log: "error", notify: "error" });
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}

export const ResolutionPart = BaseMessagePart ? class ResolutionPart extends BaseMessagePart {
  /** @inheritdoc */
  static get TYPE() {
    return PART_TYPE;
  }

  /** @inheritdoc */
  static TEMPLATE = `modules/${MODULE_ID}/templates/parts/resolution.hbs`;

  /** @inheritdoc */
  static ACTIONS = {
    ...super.ACTIONS,
    dsAutoApply: this.#onApply,
    dsAutoApplyHalf: this.#onApplyHalf,
    dsAutoEdit: this.#onEdit,
    dsAutoEditApply: this.#onEdit,
    dsAutoSurge: this.#onSurge,
    dsAutoPotencySurge: this.#onPotencySurge,
    dsAutoUndo: this.#onUndo,
    dsAutoApplyAll: this.#onApplyAll,
    dsAutoUndoAll: this.#onUndoAll,
    dsAutoResolve: this.#onResolve,
    dsAutoRetarget: this.#onRetarget,
    dsAutoHeroReroll: this.#onHeroReroll,
    dsAutoChoose: this.#onChoose,
    dsAutoTeleport: this.#onOwnTeleport,
    dsAutoUndoTrigger: this.#onUndoTrigger,
    // Milestone 6: place a summon on this client's canvas; dismiss a live one.
    dsAutoSummon: this.#onSummon,
    dsAutoDismiss: this.#onDismiss,
    // Milestone 7: place an area on this client's canvas; dismiss a live one.
    dsAutoZone: this.#onZone,
    dsAutoZoneDismiss: this.#onZoneDismiss,
    // Milestone 9: pick the creature(s) of a pick row here, then relay them.
    dsAutoPick: this.#onPick,
    // 0.13.0: open or close the folded Target Damage panel (this client only, never relayed).
    dsAutoDetails: this.#onDetails,
  };

  /** Shown when the card has a record; GMs always see it (they operate private cards manually). */
  get visible() {
    const res = getResolution(this.message);
    if (!res) return false;
    return game.user.isGM || this.isContentVisible;
  }

  /** @inheritdoc */
  async _prepareContext(context) {
    await super._prepareContext(context);
    const res = getResolution(this.message);
    context.ctx.dsAuto = res ? buildView(this.message, res) : null;
  }

  /** "Details": show or hide Target Damage's panel under the card (ui/dstd-fold.mjs). */
  static #onDetails(event) {
    event.preventDefault();
    event.stopPropagation();
    toggleFold(messageOf(this)?.id);
  }

  /** The row's Summon button: pick the squares here, then relay apply with them (summons/place.mjs; never throws). */
  static #onSummon(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const message = messageOf(this);
    const res = getResolution(message);
    const op = res?.ops?.[target.dataset.opId];
    if (!message || !op) return;
    return runSummonPick({ message, res, op, request: partActions.request });
  }

  /** Dismiss the row's live summon (relay summonDismiss: it works after the card is gone too). */
  static #onDismiss(event, target) {
    const message = messageOf(this);
    const op = getResolution(message)?.ops?.[target.dataset.opId];
    return run(event, { action: "summonDismiss", messageId: message?.id, summonDismiss: { summonId: op?.summonId ?? "" } });
  }

  /** The row's Place button: place the area here (or reuse the card's template), then relay apply (zones/place.mjs). */
  static #onZone(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const message = messageOf(this);
    const res = getResolution(message);
    const op = res?.ops?.[target.dataset.opId];
    if (!message || !op) return;
    return runZonePick({ message, res, op, request: partActions.request });
  }

  /**
   * Milestone 9: the row's Pick button: the picker on this client (ui/target-pick.mjs localPick), then relay `pick`; the
   * active GM checks the creatures against its own candidates and resolves the card again.
   */
  static async #onPick(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const message = messageOf(this);
    const res = getResolution(message);
    const op = res?.ops?.[target.dataset.opId];
    if (!message || op?.kind !== "pick") return;
    const answer = await localPick(op, res);
    if (!answer?.tokenUuids?.length) return;
    return run({ preventDefault() {}, stopPropagation() {}, currentTarget: target }, {
      action: "pick", messageId: message.id, opId: op.opId, tokenUuids: answer.tokenUuids, damageType: answer.damageType ?? null,
    });
  }

  /** Dismiss the row's live area (relay zoneDismiss: it works after the card is gone too). */
  static #onZoneDismiss(event, target) {
    const message = messageOf(this);
    const op = getResolution(message)?.ops?.[target.dataset.opId];
    return run(event, { action: "zoneDismiss", messageId: message?.id, zoneDismiss: { zoneId: op?.zoneId ?? "" } });
  }

  static #onApply(event, target) {
    return run(event, { action: "apply", messageId: messageOf(this)?.id, opIds: [target.dataset.opId] });
  }

  static #onApplyHalf(event, target) {
    return run(event, { action: "apply", messageId: messageOf(this)?.id, opIds: [target.dataset.opId], half: true });
  }

  /** Ask how many surges to spend (1 up to the button's maximum), then relay the spend. */
  static async #onSurge(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const message = messageOf(this);
    const res = getResolution(message);
    const op = res?.ops?.[target.dataset.opId];
    const hero = surgeActor(res?.sourceActorUuid);
    const max = Math.max(0, Number(target.dataset.surgeMax) || 0);
    if (!op || !hero || !max) return;
    const name = res.targets?.[op.targetKeys?.[0]]?.name ?? "";
    const count = await askSurgeCount({ max, perSurge: surgeDamage(hero), available: availableSurges(hero), name });
    if (!count) return;
    return run({ preventDefault() {}, stopPropagation() {}, currentTarget: target }, {
      action: "surge", messageId: message.id, opId: op.opId, count,
    });
  }

  /** Edit a row (amount, temporary Stamina, distance, movement type), then save or apply it. */
  static async #onEdit(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const message = messageOf(this);
    const res = getResolution(message);
    const op = res?.ops?.[target.dataset.opId];
    if (!op) return;
    const name = res.targets?.[op.targetKeys?.[0]]?.name ?? "";
    const answer = op.kind === "cleanse"
      ? await askCleanse(op, name, fromUuidSync(res.targets?.[op.targetKeys?.[0]]?.actorUuid ?? ""))
      : await askEdit(op, name);
    if (!answer) return;
    return run({ preventDefault() {}, stopPropagation() {}, currentTarget: target }, {
      action: "edit", messageId: message.id, opId: op.opId, edits: answer.edits, apply: answer.apply,
    });
  }

  /** Pick an option of a "choose one" group. */
  static #onChoose(event, target) {
    return run(event, { action: "choose", messageId: messageOf(this)?.id, group: target.dataset.group, option: target.dataset.option });
  }

  /**
   * A self-teleport by the mover's owner: Combat Tools' square picker runs on this client (the owner
   * moves their own token), then the active GM records the move for undo.
   */
  static async #onOwnTeleport(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const message = messageOf(this);
    const res = getResolution(message);
    const op = res?.ops?.[target.dataset.opId];
    const doc = op ? fromUuidSync(res.targets?.[op.targetKeys?.[0]]?.tokenUuid ?? "") : null;
    const api = dsctApi();
    if (!op || !doc) return;
    if (typeof api?.teleport !== "function" || !doc.object || doc.parent?.id !== globalThis.canvas?.scene?.id) {
      ui.notifications.warn(loc("DSAUTO.Card.TeleportNeedsCanvas"));
      return;
    }
    // Combat Tools treats 0 as "5": nothing to pick then.
    if (!(Number(op.distance) > 0)) return;
    const startPos = positionOf(doc);
    await dsctTeleport(api, { tokenDoc: doc, distance: op.distance, mode: op.teleportMode ?? "normal", animate: true, cardId: message.id, opId: op.opId });
    if (samePosition(startPos, positionOf(doc))) return;
    // The Director's client records the move from Foundry's own report; if it refuses, the token goes back.
    let recorded = false;
    try {
      const result = await partActions.request?.({ action: "apply", messageId: message.id, opIds: [op.opId], moves: { [op.opId]: true } });
      recorded = getResolution(game.messages.get(message.id))?.ops?.[op.opId]?.status === "applied" && !result?.refused?.length;
    } catch (err) {
      const msg = String(err?.message ?? "");
      ui.notifications.warn(msg.startsWith("DSAUTO.") ? loc(msg) : msg);
    }
    if (!recorded) {
      ui.notifications.warn(loc("DSAUTO.Card.TeleportRefused"));
      await moveTokenTo(doc, startPos).catch(() => {});
    }
  }

  static #onPotencySurge(event, target) {
    return run(event, { action: "surge", messageId: messageOf(this)?.id, opId: target.dataset.opId, potency: true });
  }

  static #onUndo(event, target) {
    return run(event, { action: "undo", messageId: messageOf(this)?.id, opIds: [target.dataset.opId] });
  }

  static #onApplyAll(event) {
    return run(event, { action: "apply", messageId: messageOf(this)?.id });
  }

  /** Milestone 5 (Director): undo the trigger card of a reaction still spent on an undone row. */
  static #onUndoTrigger(event, target) {
    return run(event, { action: "undo", messageId: target.dataset.triggerMessage });
  }

  static #onUndoAll(event) {
    return run(event, { action: "undo", messageId: messageOf(this)?.id });
  }

  static #onResolve(event) {
    return run(event, { action: "resolve", messageId: messageOf(this)?.id });
  }

  /** 0.16.0: reroll the power roll with a hero token (the active GM undoes, spends, rerolls and resolves again). */
  static #onHeroReroll(event) {
    return run(event, { action: "heroReroll", messageId: messageOf(this)?.id });
  }

  static #onRetarget(event) {
    const tokenUuids = [...game.user.targets].map(t => t.document.uuid);
    if (!tokenUuids.length) {
      event.preventDefault();
      ui.notifications.warn(loc("DSAUTO.Card.RetargetNone"));
      return;
    }
    return run(event, { action: "retarget", messageId: messageOf(this)?.id, tokenUuids });
  }
} : null;

/** Surge count dialog (a dropdown, 0.17.0). Resolves with a number in [1, max], or null when cancelled. */
async function askSurgeCount({ max, perSurge, available, name }) {
  const DialogV2 = foundry.applications.api.DialogV2;
  const esc = foundry.utils.escapeHTML ?? (v => String(v));
  const content = `<div class="form-group">
      <label>${esc(loc("DSAUTO.SurgeDialog.Label"))}</label>
      <div class="form-fields"><select name="count" autofocus>${Array.from({ length: max }, (_v, i) => `<option value="${i + 1}">${i + 1}</option>`).join("")}</select></div>
      <p class="hint">${esc(loc("DSAUTO.SurgeDialog.Hint", { damage: perSurge, name, available, max }))}</p>
    </div>`;
  let data = null;
  try {
    data = await DialogV2.input({
      window: { title: "DSAUTO.SurgeDialog.Title", icon: "fa-solid fa-bolt" },
      content,
      ok: { label: "DSAUTO.SurgeDialog.Spend", icon: "fa-solid fa-bolt" },
      rejectClose: false,
    });
  } catch (_err) {
    return null;
  }
  const count = Math.floor(Number(data?.count));
  if (!Number.isFinite(count) || count < 1) return null;
  return Math.min(max, count);
}

/**
 * Edit dialog of a row. Resolves with `{edits, apply}` or null when cancelled. An empty field goes back
 * to the ability's value.
 */
async function askEdit(op, name) {
  const DialogV2 = foundry.applications.api.DialogV2;
  const esc = foundry.utils.escapeHTML ?? (v => String(v));
  const fields = [];
  if (op.kind === "forced") {
    if ((op.movements?.length ?? 0) > 1) {
      const chosen = chosenMovement(op);
      const options = op.movements.map(m => `<option value="${esc(m)}"${m === chosen ? " selected" : ""}>${esc(movementLabel(m, op.vertical))} ${esc(op.distances?.[m] ?? "")}</option>`).join("");
      fields.push(`<div class="form-group"><label>${esc(loc("DSAUTO.EditDialog.Movement"))}</label><div class="form-fields"><select name="movement">${options}</select></div></div>`);
    }
    const value = Number.isFinite(op.override?.distance) ? op.override.distance : "";
    const placeholder = chosenMovement(op) ? chosenDistance(op) : "";
    fields.push(`<div class="form-group"><label>${esc(loc("DSAUTO.EditDialog.Distance"))}</label><div class="form-fields"><input type="number" name="distance" min="0" max="50" step="1" value="${value}" placeholder="${placeholder}"></div><p class="hint">${esc(loc("DSAUTO.EditDialog.DistanceHint"))}</p></div>`);
  } else {
    const value = Number.isInteger(op.override?.amount) ? op.override.amount : "";
    fields.push(`<div class="form-group"><label>${esc(loc("DSAUTO.EditDialog.Amount"))}</label><div class="form-fields"><input type="number" name="amount" min="0" max="10000" step="1" value="${value}" placeholder="${esc(op.amount ?? "")}" autofocus></div><p class="hint">${esc(loc("DSAUTO.EditDialog.AmountHint"))}</p></div>`);
    if (op.kind !== "damage" && !op.group) {
      const temp = typeof op.override?.temp === "boolean" ? op.override.temp : op.kind === "temp";
      fields.push(`<div class="form-group"><label>${esc(loc("DSAUTO.EditDialog.Temp"))}</label><div class="form-fields"><input type="checkbox" name="temp"${temp ? " checked" : ""}></div></div>`);
    }
  }
  const read = (_event, button) => {
    const form = button.form;
    const data = new foundry.applications.ux.FormDataExtended(form).object;
    const edits = {};
    const num = v => (v === "" || v == null || Number.isNaN(Number(v)) ? null : Math.floor(Number(v)));
    if (op.kind === "forced") {
      edits.distance = num(data.distance);
      if ("movement" in data) edits.movement = data.movement || null;
      else if (!chosenMovement(op) && op.movements?.length) edits.movement = op.movements[0];
    } else {
      edits.amount = num(data.amount);
      if ("temp" in data) edits.temp = !!data.temp;
    }
    return edits;
  };
  let result = null;
  try {
    result = await DialogV2.wait({
      window: { title: "DSAUTO.EditDialog.Title", icon: "fa-solid fa-pen" },
      content: `<p>${esc(loc("DSAUTO.EditDialog.Intro", { name }))}</p>${fields.join("")}`,
      buttons: [
        { action: "apply", label: "DSAUTO.EditDialog.Apply", icon: "fa-solid fa-play", default: true, callback: (e, b) => ({ edits: read(e, b), apply: true }) },
        { action: "save", label: "DSAUTO.EditDialog.Save", icon: "fa-solid fa-floppy-disk", callback: (e, b) => ({ edits: read(e, b), apply: false }) },
      ],
      rejectClose: false,
    });
  } catch (_err) {
    return null;
  }
  return result && typeof result === "object" ? result : null;
}

/**
 * Which effects a cleanse row ends (count of them). Resolves with `{edits: {effects}, apply: true}`,
 * or null when cancelled.
 */
async function askCleanse(op, name, actor) {
  const candidates = cleanseCandidates(actor, { statuses: op.statuses, ends: op.ends });
  if (!candidates.length) {
    ui.notifications.warn(loc("DSAUTO.Reason.nothingToEnd"));
    return null;
  }
  // Milestone 9: the dialog itself lives in ui/cleanse-choice.mjs (the owner's prompt uses it too).
  const result = await cleanseDialog({ name, count: op.count ?? candidates.length, candidates: candidates.map(e => ({ id: e.id, name: e.name })) });
  return result ? { edits: { effects: result }, apply: true } : null;
}

/** Register the part type. Called from the top level of main.mjs (import time). */
export function registerResolutionPart() {
  const registry = globalThis.ds?.CONFIG?.MessagePart;
  if (!registry || !ResolutionPart) {
    console.error(`${MODULE_ID} | the Draw Steel system was not loaded before this module; the resolution part is not registered`);
    return false;
  }
  registry[PART_TYPE] = { documentClass: ResolutionPart };
  return true;
}
