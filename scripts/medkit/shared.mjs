/** Shared helpers of the medkit. */
export const MODULE_ID = "stef-ds-automation";

export const coreApi = () => game.modules.get(MODULE_ID)?.api ?? null;

/**
 * A class feature whose library overlay carries resource gains (core 0.9.0). The registry is asked by
 * the item's key, so a feature without gains (or an older core) is not one.
 */
export function isGainFeature(doc, api = coreApi()) {
  if (doc?.documentName !== "Item" || doc.type !== "feature" || !api?.library?.overlaysFor) return false;
  try {
    const key = api.library.keys?.itemKey?.(doc);
    return !!key && (api.library.overlaysFor(key) ?? []).some(o => (o.gains ?? []).length > 0);
  } catch (_err) {
    return false;
  }
}

/** Statuses of stef-ds-automation's library resolution, most specific first. */
export const STATUSES = ["locked", "disabled", "outdated", "customized", "unavailable", "covered", "configurable", "automated", "native", "manual"];

const ICONS = {
  locked: "fa-solid fa-lock",
  disabled: "fa-solid fa-ban",
  outdated: "fa-solid fa-clock-rotate-left",
  customized: "fa-solid fa-pen-ruler",
  unavailable: "fa-solid fa-plug-circle-xmark",
  covered: "fa-solid fa-handshake",
  configurable: "fa-solid fa-sliders",
  automated: "fa-solid fa-wand-magic-sparkles",
  native: "fa-solid fa-gears",
  manual: "fa-solid fa-hand",
};

export function statusInfo(status) {
  return {
    id: status,
    label: game.i18n.localize(`DSMEDKIT.Status.${status}.label`),
    hint: game.i18n.localize(`DSMEDKIT.Status.${status}.hint`),
    icon: ICONS[status] ?? "fa-solid fa-circle",
    cls: `ds-auto-status--${status}`,
  };
}

/** May this user open medkit windows (setting `medkitRole`)? */
export function mayUseMedkit(user = game.user) {
  if (user?.isGM) return true;
  return (user?.role ?? 0) >= Number(game.settings.get(MODULE_ID, "medkitRole") ?? 3);
}
