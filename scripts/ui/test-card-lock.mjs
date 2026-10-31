/**
 * 1.1.0: the test card of a reactive ability (engine/reactive.mjs). The system renders the tier's effects on each
 * target's test card with apply buttons that act on the clicker's selected tokens; once the ability card carries that
 * target's rows they are applied (and undone) there, so the test card's buttons are locked. The Hero Token reroll
 * stays: a reroll re-tiers the target's rows on the ability card.
 */
import { DSTD_ID, MODULE_ID } from "../constants.mjs";
import { getResolution } from "../engine/record.mjs";
import { REACTIVE_PART, cardOfTest, reactiveEnabled, testPartOf } from "../engine/reactive.mjs";

const APPLY_BUTTONS = '[data-action="applyEffect"], [data-action="rollDamage"], [data-action="applyDamage"], [data-dsct-action="dsct-fm"]';
const loc = (key, data) => (data ? game.i18n.format(key, data) : game.i18n.localize(key));

/** The ability card that owns rows for this test's target (its buttons are locked), or null. */
export function lockedBy(message) {
  if (!reactiveEnabled() || !testPartOf(message)) return null;
  const found = cardOfTest(message.id);
  if (!found) return null;
  const res = getResolution(found.message);
  const owns = Object.values(res?.ops ?? {}).some(op => op.partId === REACTIVE_PART && (op.targetKeys ?? []).includes(found.key));
  return owns ? found.message : null;
}

function decorate(message, root) {
  if (!root?.querySelectorAll || !lockedBy(message)) return;
  for (const button of root.querySelectorAll(APPLY_BUTTONS)) {
    button.disabled = true;
    button.classList.add("ds-auto-locked");
    button.dataset.tooltip = loc("DSAUTO.Lock.TestCard");
  }
}

export function registerTestCardLock() {
  Hooks.on("renderChatMessageHTML", (message, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root || !testPartOf(message)) return;
    // Combat Tools adds its forced movement button in its own render hook: decorate after it.
    const live = () => (root.isConnected ? root : document.querySelector(`li.chat-message[data-message-id="${message.id}"]`) ?? root);
    for (const ms of [0, 250, 600]) setTimeout(() => decorate(message, live()), ms);
  });
  // The ability card's rows changed (built, applied, undone): its test cards re-render with the matching lock.
  Hooks.on("updateChatMessage", (message, changed) => {
    if (!changed?.flags?.[MODULE_ID]?.resolution || !getResolution(message)?.reactive) return;
    for (const r of Object.values(message.flags?.[DSTD_ID]?.state?.reactiveResults ?? {})) {
      const test = game.messages.get(r?.rollMessageId ?? "");
      if (test) globalThis.ui?.chat?.updateMessage?.(test)?.catch?.(() => {});
    }
  });
}
