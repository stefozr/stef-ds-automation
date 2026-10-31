/** Re-render recent cards with an Automation section (optionally only some of them). */
import { getResolution } from "../engine/record.mjs";

export function rerenderCards(filter = () => true) {
  const recent = game.messages?.contents?.slice(-50) ?? [];
  for (const m of recent) {
    const res = getResolution(m);
    if (res && filter(res)) globalThis.ui?.chat?.updateMessage?.(m)?.catch?.(() => {});
  }
}
