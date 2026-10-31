/**
 * 0.16.0: a Director's warning when an active module of the Combat Tools family is outside the versions verified with
 * this Automation Suite (compat/version-gate.mjs VERIFIED). Once per client and version set (hidden client setting
 * `versionBannerSeen`); the selfCheck problem `unverifiedVersion` stays as long as the versions do.
 */
import { MODULE_ID } from "../constants.mjs";
import { unverifiedFamily } from "../compat/version-gate.mjs";
import { log } from "../log.mjs";

/** Show the warning if due. Returns true when it was shown. */
export function versionBanner() {
  if (!game.user?.isGM) return false;
  const list = unverifiedFamily();
  if (!list.length) return false;
  log("versions.unverified", { list });
  const stamp = `${game.modules.get(MODULE_ID)?.version ?? ""}|${list.join(",")}`;
  let seen = "";
  try {
    seen = game.settings.get(MODULE_ID, "versionBannerSeen") ?? "";
  } catch (_err) { /* not registered */ }
  if (seen === stamp) return false;
  ui.notifications?.warn?.(game.i18n.format("DSAUTO.Banner.unverified", { list: list.join(", ") }), { permanent: true });
  Promise.resolve(game.settings.set(MODULE_ID, "versionBannerSeen", stamp)).catch(() => {});
  return true;
}
