/**
 * Draw Steel: Target Damage stays untouched, but its row buttons are locked for ops stef-ds-automation
 * already applied, so nobody applies the same damage or condition twice.
 *
 * 1. Capture guard (the real safety): one capture-phase click listener on the document (and on
 *    detached chat windows) swallows clicks on locked Target Damage / Combat Tools row buttons.
 *    Synthetic `.click()` calls dispatch through the capture phase too, so Combat Tools' "Apply All"
 *    (compat/dstd-compat.mjs:354-363) is blocked as well.
 * 2. Visual lock: a ctlib panel decorator (or a render hook without ctlib) disables the buttons and
 *    explains why in a tooltip. Target Damage rebuilds its panel on every flag change, so the
 *    decorator re-runs on render, on mutation and on short retries.
 * 3. Milestone 3: Combat Tools' own forced movement buttons of a tier part ("Push 2") move every
 *    targeted token again; they are locked the same way once we moved a target of that part.
 * 4. Milestone 5: while the card holds a target for triggered actions (`res.hold`), that target's damage
 *    and condition rows are locked too: the held damage lands through our engine (review integration 5).
 * 5. Milestone 5: a Shift+Click (half damage) on a Target Damage row (a GM's, or a player's through Combat
 *    Tools' area hook) or on Combat Tools' purifying fire button marks its targets as halved for the external
 *    hold (`markHalfClick`), whatever the lock setting.
 * 6. Combat Tools 1.2.7 advanced enrichers (world setting `advancedEnrichers`, default on) replace Target Damage's
 *    apply rows with per-target faces and value chips in the card text (advanced-enrichers.mjs:1345-1438). A click
 *    that would repeat one of our applied (or held) ops for that target is swallowed the same way: an `[[/apply]]`
 *    chip by its status (as Target Damage's apply rows were), every other kind only by the library ops we planned
 *    from the effect text. Our power-roll rows never come from the text, so its extra damage stays free (live §27).
 */
import { CTLIB_ID, OP_STATUS, loc } from "../constants.mjs";
import { dstdActive, dstdOnCard, dstdTargetKeyFromButton } from "../compat/dstd.mjs";
import { ctlib } from "../compat/ctlib.mjs";
import { debug } from "../log.mjs";
import { setting } from "../settings.mjs";
import { effectiveUntil, getResolution } from "../engine/record.mjs";
import { targetKey } from "../engine/keys.mjs";
import { dstdRowIsHeal, dstdTargetUuids, markExternalHalf, markHalfDamage, tokenUuids } from "../triggers/external.mjs";

const BUTTONS = '[data-dstd-action="applyDamage"], [data-dstd-action="applyStatus"], [data-dsct-dstd-cond]';
const PANEL = "section.draw-steel-target-damage-panel";
const FM_BUTTONS = '[data-dsct-action="dsct-fm"]';
/** Combat Tools' per-target forced movement rows inside Target Damage's panel (dstd-compat.mjs:1690-1793). */
const FM_ROW = "[data-dsct-fm-key]";
const FM_ROW_APPLY = `${FM_ROW} > button:first-child`;
/** A Combat Tools advanced enricher in the card text; `data-adv-kind` names its kind (advanced-enrichers.mjs:1428-1430). */
const ENRICHER = "enriched-content.dsct-adv";
/**
 * Our op kinds each advanced enricher kind would repeat (advanced-enrichers.mjs:935), and which of them: `[[/apply]]`
 * by its status or effect uuid (`link`), the others only ops our library planned from the text (`lib`).
 */
const fromText = o => !!o.lib;
const sameEffect = (o, link) => !!(link?.status ? o.effectId === link.status : link?.uuid && o.effectId === link.uuid);
const ENRICHER_OPS = {
  damage: { kinds: ["damage"], same: fromText },
  heal: { kinds: ["heal", "temp"], same: fromText },
  gain: { kinds: ["resource", "gain"], same: fromText },
  apply: { kinds: ["condition"], same: sameEffect },
  forced: { kinds: ["forced"], same: fromText },
  teleport: { kinds: ["teleport"], same: fromText },
  cleanse: { kinds: ["cleanse"], same: fromText },
};
/** The enricher's own link (Combat Tools' linkOf, advanced-enrichers.mjs:32): what it applies. */
const enricherLink = ec => {
  const a = ec?.querySelector?.(":scope > a.roll-link, :scope > a.roll-link-group, :scope > a");
  return { status: a?.dataset?.status ?? null, uuid: a?.dataset?.uuid ?? null };
};
/** Faces Combat Tools already applied: a click on them undoes Combat Tools' own row. */
const APPLIED_FACE = ".dsct-adv-applied, .dsct-adv-dead";

/** Our lock explanation: ctlib's rich tip when the element has one (ctlib's setTip drops data-tooltip), else a tooltip. */
function lockTip(el, text) {
  const setTip = ctlib()?.setTip;
  if (el.dataset?.dsctTip && typeof setTip === "function") setTip(el, { title: loc("DSAUTO.Lock.TipTitle"), body: text });
  else el.dataset.tooltip = text;
}

/** Our applied forced op for a Combat Tools panel row key `messageId:targetKey:movement`, or null. */
export function blockingForcedRow(message, key) {
  const parts = String(key ?? "").split(":");
  if (parts.length !== 3 || parts[0] !== message?.id) return null; // flat effect rows have 4 parts
  const [, targetKey, movement] = parts;
  const res = getResolution(message);
  return Object.values(res?.ops ?? {}).find(o => o.kind === "forced" && o.status === OP_STATUS.APPLIED
    && takesMovement(o, movement) && o.targetKeys?.includes(targetKey)) ?? null;
}

/** "Push or pull" is one effect: once it moved the target, buttons for any of its types would repeat it. */
const takesMovement = (op, movement) => op.movedType === movement || !!op.movements?.includes(movement);

/** Our applied forced movement op of the button's tier part and movement type, or null. */
export function blockingForcedOp(message, button) {
  const res = getResolution(message);
  if (!res?.ops) return null;
  const partId = button.closest?.("[data-message-part]")?.dataset?.messagePart ?? null;
  const movement = button.dataset?.movement ?? null;
  return Object.values(res.ops).find(o => o.kind === "forced" && o.status === OP_STATUS.APPLIED
    && (!partId || o.partId === partId) && (!movement || takesMovement(o, movement))) ?? null;
}

/** A damage or condition op of this card held for triggered actions on the row's target, or null (Milestone 5). */
function heldOp(message, res, button) {
  const h = res?.hold;
  if (!h || (game.time?.serverTime ?? Date.now()) >= effectiveUntil(res, message)) return null;
  const condKey = button.dataset?.dsctDstdCond;
  const tKey = condKey ? condKey.split(":cond:")[0] : dstdTargetKeyFromButton(button);
  if (!tKey || tKey === "selected-token" || !(h.targetKeys ?? []).includes(tKey)) return null;
  // A fresh card being resolved has no ops of its plan in the record yet: the row is locked all the same.
  const op = Object.values(res.ops ?? {}).find(o => (o.kind === "damage" || o.kind === "condition") && o.targetKeys?.includes(tKey))
    ?? { opId: h.opIds?.[0] ?? null, kind: "damage", targetKeys: [tKey] };
  return { ...op, held: true };
}

/** The applied op a Target Damage / Combat Tools button would duplicate (or a held one, `held: true`), or null. */
export function blockingOp(message, button) {
  const res = getResolution(message);
  const held = res ? heldOp(message, res, button) : null;
  if (held) return held;
  if (!res?.ops) return null;
  // Only ops WE applied lock a row; "external" ops were applied by Target Damage itself, whose own
  // buttons must stay usable (undo, re-apply after its undo).
  const ops = Object.values(res.ops).filter(o => o.status === OP_STATUS.APPLIED);
  if (!ops.length) return null;

  const condKey = button.dataset.dsctDstdCond;
  if (condKey) {
    const [tKey, effectId] = condKey.split(":cond:");
    if (!effectId) return null;
    return ops.find(o => o.kind === "condition" && o.effectId === effectId && o.targetKeys.includes(tKey)) ?? null;
  }

  const tKey = dstdTargetKeyFromButton(button);
  if (!tKey || tKey === "selected-token") return null;
  const action = button.dataset.dstdAction;
  if (action === "applyDamage") {
    const partId = button.dataset.partId;
    const rollIndex = Number(button.dataset.rollIndex);
    // A squad op on a 1.2 card lists every member's part (Milestone 8, §1.4).
    return ops.find(o => o.kind !== "condition" && o.targetKeys.includes(tKey) && ((o.partId === partId && o.rollIndex === rollIndex)
      || (Array.isArray(o.parts) && o.parts.some(p => p?.partId === partId && Number(p?.rollIndex) === rollIndex)))) ?? null;
  }
  if (action === "applyStatus") {
    const effectId = button.dataset.effectId;
    return ops.find(o => o.kind === "condition" && o.effectId === effectId && o.targetKeys.includes(tKey)) ?? null;
  }
  return null;
}

/**
 * Our applied (or held) op an advanced enricher of `kindId` would repeat for these token uuids, or null.
 * `uuids` null: the enricher's own target list, unknown here, so any target of the card counts. `link`: the
 * enricher's `{status, uuid}` (an `[[/apply]]` matches only the same effect).
 */
export function blockingEnricherOp(message, kindId, uuids, link = null) {
  const rule = ENRICHER_OPS[kindId];
  const res = getResolution(message);
  if (!rule || !res) return null;
  const keys = uuids ? new Set(uuids.map(targetKey)) : null;
  const h = res.hold;
  if (h && (kindId === "damage" || kindId === "apply") && (game.time?.serverTime ?? Date.now()) < effectiveUntil(res, message)) {
    const held = (h.targetKeys ?? []).filter(k => !keys || keys.has(k));
    if (held.length) return { opId: h.opIds?.[0] ?? null, kind: rule.kinds[0], targetKeys: held, held: true };
  }
  return Object.values(res.ops ?? {}).find(o => o.status === OP_STATUS.APPLIED && rule.kinds.includes(o.kind) && rule.same(o, link)
    && (!keys || (o.targetKeys ?? []).some(k => keys.has(k)))) ?? null;
}

/**
 * The token uuids an advanced enricher click applies to (Combat Tools' onClick, advanced-enrichers.mjs:1345-1380):
 * a face, a value chip, the user's targets on Shift+click, null for a plain link click (all its targets), [] for
 * anything that applies nothing (tools, a face Combat Tools applied, whose click undoes it).
 */
function enricherClickTargets(event, ec) {
  const at = sel => {
    const el = event.target?.closest?.(sel);
    return el && ec.contains(el) ? el : null;
  };
  const face = at("[data-ctlib-face]");
  if (face) return face.matches(APPLIED_FACE) ? [] : [face.getAttribute("data-ctlib-face")];
  const chip = at(".dsct-adv-val");
  if (chip) return String(chip.dataset.advUuids ?? "").split(" ").filter(Boolean);
  if (at("[data-adv-tool]") || !at("a")) return [];
  return event.shiftKey ? tokenUuids([...(game.user?.targets ?? [])]) : null;
}

/** The rendered card: `root` while attached, else the message's current element in the chat log. */
function liveRoot(message, root) {
  return root?.isConnected ? root : (document.querySelector(`li.chat-message[data-message-id="${message.id}"]`) ?? root);
}

function messageFor(element) {
  const li = element.closest("li.chat-message[data-message-id], [data-message-id]");
  return li ? game.messages.get(li.dataset.messageId) : null;
}

/**
 * Milestone 5: a Shift+Click half damage that never reaches DamageRoll#applyDamage marks its targets so a halve
 * step is moot (C16, triggers/external.mjs):
 *   - a GM's click on a Target Damage damage row halves on Target Damage's own path, run on this client (DSTD
 *     socket.mjs:11-13; a player's click is marked on the GM from Target Damage's socket request);
 *   - Combat Tools' area hook on such a row (dstd-compat.mjs:1081-1101) halves itself on the clicking client,
 *     players included (their takeDamage of creatures they do not own goes to the GM: `markHalfDamage`);
 *   - Combat Tools' purifying fire button (system-patches.mjs:632-659) halves on its own for game.user.targets.
 * The capture listener runs before Combat Tools' own listeners.
 */
export function markHalfClick(event) {
  try {
    if (!event?.shiftKey) return;
    if (event.target?.closest?.('[data-dsct-action="dsct-purifying-fire"]')) {
      markHalfDamage(tokenUuids([...(game.user?.targets ?? [])]));
      return;
    }
    if (!dstdActive()) return;
    const button = event.target?.closest?.('[data-dstd-action="applyDamage"]');
    const panel = button?.closest?.(PANEL);
    if (!button || !panel) return;
    // Combat Tools marks the panel it hooked (`data-dsct-area-dmg-hooked`, dstd-compat.mjs:1084-1085).
    const dsctArea = !!(panel.dataset?.dsctAreaDmgHooked || button.closest?.("[data-dsct-area-dmg-hooked]"));
    if (!game.user?.isGM && !dsctArea) return;
    // A healing row never reaches takeDamage: its mark would halve the creature's next hit (third review).
    const ds = button.dataset ?? {};
    if (dstdRowIsHeal({
      message: typeof button.closest === "function" ? messageFor(button) : null, partId: ds.partId, rollIndex: ds.rollIndex,
      synthetic: ds.syntheticDamage === "true" ? { isHeal: ds.isHeal === "true" } : null,
    })) return;
    let target = null;
    try {
      target = button.dataset?.target ? JSON.parse(button.dataset.target) : null;
    } catch (_err) {
      target = null;
    }
    // A "selected token" row applies to the controlled tokens (DSTD chat-targeting.mjs:1194-1198; Combat Tools'
    // area hook takes the first one, dstd-compat.mjs:1094).
    const byId = target?.tokenId && !target.tokenUuid ? globalThis.canvas?.tokens?.get?.(target.tokenId) : null;
    const uuids = target?.selectedToken
      ? tokenUuids(globalThis.canvas?.tokens?.controlled ?? [])
      : (byId ? tokenUuids([byId]) : dstdTargetUuids([target]));
    if (game.user?.isGM) markExternalHalf(uuids);
    else markHalfDamage(uuids);
  } catch (err) {
    debug("lock.halfClick", { why: String(err?.message ?? err) });
  }
}

/**
 * Capture listener: swallow a click on a locked row (applied by us, or held for triggered actions). A Shift+Click
 * half is marked only when the click goes through: a swallowed click applies nothing, and its mark would halve the
 * next unrelated hit on those creatures (C16).
 */
export function onCaptureClick(event) {
  let blocked = null;
  try {
    blocked = lockedClick(event);
  } finally {
    if (!blocked) markHalfClick(event);
  }
  if (!blocked) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  debug("lock.blocked", { messageId: blocked.messageId, opId: blocked.op.opId, held: !!blocked.op.held });
  ui.notifications.warn(loc(blocked.warn));
}

/** The lock that swallows this click, or null. */
function lockedClick(event) {
  if (!setting("lockDstdRows")) return null;
  const fm = event.target?.closest?.(`${FM_BUTTONS}, ${FM_ROW_APPLY}`);
  if (fm) {
    const message = messageFor(fm);
    const rowKey = fm.closest(FM_ROW)?.dataset?.dsctFmKey;
    const op = !message ? null : (rowKey ? blockingForcedRow(message, rowKey) : blockingForcedOp(message, fm));
    return op ? { op, messageId: message.id, warn: "DSAUTO.Lock.AlreadyMoved" } : null;
  }
  const ec = event.target?.closest?.(ENRICHER);
  if (ec?.dataset?.advKind) {
    const message = messageFor(ec);
    const uuids = message ? enricherClickTargets(event, ec) : [];
    const op = uuids?.length === 0 ? null : blockingEnricherOp(message, ec.dataset.advKind, uuids, enricherLink(ec));
    return op ? { op, messageId: message.id, warn: op.held ? "DSAUTO.Relay.Busy" : "DSAUTO.Lock.AlreadyApplied" } : null;
  }
  if (!dstdActive()) return null;
  const button = event.target?.closest?.(BUTTONS);
  if (!button || !button.closest(PANEL)) return null;
  const message = messageFor(button);
  if (!message || !dstdOnCard(message)) return null;
  const op = blockingOp(message, button);
  return op ? { op, messageId: message.id, warn: op.held ? "DSAUTO.Relay.Busy" : "DSAUTO.Lock.AlreadyApplied" } : null;
}

/** Disable Combat Tools' forced movement buttons for parts whose targets we already moved. */
export function decorateForced(message, root) {
  if (!setting("lockDstdRows") || !root || !getResolution(message)) return;
  for (const button of root.querySelectorAll(FM_BUTTONS)) {
    if (!blockingForcedOp(message, button)) continue;
    button.disabled = true;
    button.classList.add("ds-auto-locked");
    lockTip(button, loc("DSAUTO.Lock.MovedTooltip"));
  }
}

/** Disable locked buttons inside a rendered card. */
export function decorate(message, root) {
  if (!setting("lockDstdRows") || !root) return;
  if (!getResolution(message)) return;
  for (const button of dstdOnCard(message) ? root.querySelectorAll(`${PANEL} ${FM_ROW_APPLY}`) : []) {
    if (!blockingForcedRow(message, button.closest(FM_ROW)?.dataset?.dsctFmKey)) continue;
    button.disabled = true;
    button.classList.add("ds-auto-locked");
    lockTip(button, loc("DSAUTO.Lock.MovedTooltip"));
  }
  // 1.2.0: no Target Damage panel work on a 1.2 card (the enrichers below are independent of it).
  for (const button of dstdOnCard(message) ? root.querySelectorAll(`${PANEL} :is(${BUTTONS})`) : []) {
    const op = blockingOp(message, button);
    if (!op) continue;
    button.disabled = true;
    button.classList.add("ds-auto-locked");
    lockTip(button, loc(op.held ? "DSAUTO.Relay.Busy" : "DSAUTO.Lock.Tooltip"));
  }
  decorateEnrichers(message, root);
}

/** Mark advanced enricher faces and value chips that would repeat our ops (the capture guard does the blocking). */
export function decorateEnrichers(message, root) {
  if (!setting("lockDstdRows") || !root?.querySelectorAll || !getResolution(message)) return;
  const lock = (el, op) => {
    el.classList.add("ds-auto-locked");
    lockTip(el, loc(op.held ? "DSAUTO.Relay.Busy" : "DSAUTO.Lock.Tooltip"));
  };
  for (const ec of root.querySelectorAll(ENRICHER)) {
    const kindId = ec.dataset.advKind;
    const link = enricherLink(ec);
    for (const face of ec.querySelectorAll("[data-ctlib-face]")) {
      if (face.matches(APPLIED_FACE)) continue;
      const op = blockingEnricherOp(message, kindId, [face.getAttribute("data-ctlib-face")], link);
      if (op) lock(face, op);
    }
    for (const chip of ec.querySelectorAll(".dsct-adv-val")) {
      const op = blockingEnricherOp(message, kindId, String(chip.dataset.advUuids ?? "").split(" ").filter(Boolean), link);
      if (op) lock(chip, op);
    }
  }
}

export function registerDstdLock() {
  document.addEventListener("click", onCaptureClick, true);
  Hooks.on("openDetachedWindow", (_id, win) => {
    try {
      win?.document?.addEventListener("click", onCaptureClick, true);
    } catch (_err) { /* cross-origin or closed */ }
  });

  // Combat Tools builds its forced movement buttons in its own render hook: decorate right after.
  Hooks.on("renderChatMessageHTML", (message, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root || !getResolution(message)) return;
    setTimeout(() => decorateForced(message, root), 0);
    // Combat Tools builds advanced enricher faces when the enriched content renders (independent of Target Damage).
    for (const ms of [0, 250, 600, 1500]) setTimeout(() => decorateEnrichers(message, liveRoot(message, root)), ms);
  });

  Hooks.once("ready", () => {
    if (!dstdActive()) return;
    const lib = ctlib();
    if (typeof lib?.registerPanelDecorator === "function") {
      lib.registerPanelDecorator({
        id: "stef-ds-automation-lock",
        priority: 300,
        immediate: true,
        retry: [0, 250, 600],
        onMutation: true,
        decorate: ({ message, root }) => decorate(message, root),
      });
      debug("lock.decorator", { via: CTLIB_ID });
      return;
    }
    // Without ctlib: decorate after Target Damage has had a chance to build its panel.
    Hooks.on("renderChatMessageHTML", (message, html) => {
      const root = html instanceof HTMLElement ? html : html?.[0];
      if (!root || !getResolution(message)) return;
      const live = () => (root.isConnected ? root : document.querySelector(`li.chat-message[data-message-id="${message.id}"]`) ?? root);
      setTimeout(() => decorate(message, live()), 0);
      setTimeout(() => decorate(message, live()), 250);
    });
  });
}
