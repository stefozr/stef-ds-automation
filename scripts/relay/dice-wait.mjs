/**
 * 0.17.1: the Dice So Nice wait before a new card resolves follows the roller's screen. Dice So Nice does not animate in
 * a hidden tab (it defers the roll until the tab is shown, `queue.deferHidden`), so a Director whose window is in the
 * background waited the full cap. Then the active GM asks the card's author (prompt `diceWait`) to wait for its own
 * animation instead.
 */
import { QUERY_PROMPT } from "../constants.mjs";

/** The longest wait for the dice, on either side. */
export const DICE_WAIT_MAX_MS = 15_000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hidden = () => globalThis.document?.hidden === true;

/** Wait for this client's animation of the message's dice, at most `ms`. Never throws. */
async function localWait(messageId, ms) {
  try {
    await Promise.race([game.dice3d.waitFor3DAnimationByMessageID(messageId), sleep(ms)]);
  } catch (_err) { /* never block the resolution on Dice So Nice */ }
}

/**
 * Active GM: wait until the card's dice landed for the roller. A visible Director waits on its own screen ("local"); a
 * hidden one asks the author's client ("author"), or does not wait when the author is itself or offline ("none").
 * @returns {Promise<"local"|"author"|"none">}
 */
export async function waitForDice(message) {
  if (!hidden()) {
    await localWait(message.id, DICE_WAIT_MAX_MS);
    return "local";
  }
  const author = message.author;
  if (!author || author.isSelf || !author.active) return "none";
  try {
    await author.query(QUERY_PROMPT, { type: "diceWait", messageId: message.id }, { timeout: DICE_WAIT_MAX_MS });
  } catch (_err) { /* timeout or disconnect: no further wait */ }
  return "author";
}

/** The author's client: wait for its own animation of the card's dice (`{hidden: true}` when this tab is hidden too). */
export async function handleDiceWait(payload, { user } = {}) {
  if (!user?.isGM || user.id !== game.users.activeGM?.id) throw new Error("DSAUTO.Relay.Denied");
  const id = payload?.messageId;
  if (typeof id !== "string" || !id || id.length > 64 || !game.messages.get(id)) throw new Error("DSAUTO.Relay.BadRequest");
  if (hidden() || typeof game.dice3d?.waitFor3DAnimationByMessageID !== "function") return { hidden: hidden() };
  await localWait(id, DICE_WAIT_MAX_MS - 1000);
  return { done: true };
}
