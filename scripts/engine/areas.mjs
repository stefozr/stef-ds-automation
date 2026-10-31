/** Prepare native area targets before AbilityModel.use constructs roll contexts. */
import { MODULE_ID } from "../constants.mjs";
import { wrap } from "../compat/lib-wrapper.mjs";
import { setting } from "../settings.mjs";
import { zoneArea, zoneShapes } from "../zones/shapes.mjs";
import { evaluateInt } from "../library/formula.mjs";
import { featureAbilityUse } from "../features/capabilities.mjs";
import { dsctAreaPickerFor, dsctRangeExempt } from "../compat/dsct-use.mjs";

/*
 * 0.16.0: a use that a module vetoes at the roll dialog (Combat Tools' melee/ranged prompt, area picker or choose
 * prompt: `ds.canRenderAbilityConfigurationDialog` false) never resolves, because the system waits for a dialog that
 * never opens; Combat Tools then uses the ability again. So the state of a use (`entries`) is taken over by the next
 * use of the same item instead of blocking it, and only an open placement refuses a second use.
 */
const entries = new Map();          // item uuid -> {region, created, priorTargets, placing, at}
const ENTRY_STALE_MS = 600_000;
const prepared = new Map();
/* 0.16.0: Combat Tools' own area of an ability (its area picker links `abilitySource` after creating the region), with
 * this client's receive time, and when a use of the item first met that picker (adoption window). */
const linked = new Map();           // item uuid -> {region, at}
const pickerSince = new Map();      // item uuid -> ms
const MAX_LINKED = 50;
const live = r => !!r && !!r.parent?.regions?.get?.(r.id);

function noteLinked(region, flags) {
  const src = flags?.["draw-steel"]?.abilitySource;
  if (!src || region?.flags?.[MODULE_ID]?.zone) return;
  linked.delete(src);
  linked.set(src, { region, at: Date.now() });
  if (linked.size > MAX_LINKED) linked.delete(linked.keys().next().value);
}

/** Combat Tools' area for this item linked since `since` (still on its scene), or null. */
function linkedRegion(itemUuid, since) {
  const entry = linked.get(itemUuid);
  return entry && entry.at >= since && live(entry.region) ? entry.region : null;
}
const list = c => c?.contents ?? [...(c ?? [])];
const sourceOf = r => r.flags?.["draw-steel"]?.abilitySource;
const attachedTokenId = r => r.attachment?.token?.id ?? r.attachment?.token;
export function attachedAuraRegion(item, token) {
  if (!token || item.system?.distance?.type !== "aura") return null;
  return list(token.parent?.regions).find(r => sourceOf(r) === item.uuid && attachedTokenId(r) === token.id) ?? null;
}

/**
 * Milestone 9 (docs/M9-DESIGN.md §B): the area the user placed for this use of the item, while `use()` runs (the
 * card is created inside that window, so engine/seed.mjs can copy its shapes before Combat Tools' sweep deletes the
 * region). Placed templates only: never our burst (`instantaneousArea`) or an aura region (attached to a token).
 * @param {string} itemUuid
 * @returns {RegionDocument|null}
 */
export function preparedArea(itemUuid) {
  // 0.16.0: Combat Tools' silent burst is created while the dialog opens, after our wrapper ran.
  const region = itemUuid ? (prepared.get(itemUuid) ?? (pickerSince.has(itemUuid) ? linkedRegion(itemUuid, pickerSince.get(itemUuid)) : null)) : null;
  if (!region) return null;
  const ours = region.flags?.[MODULE_ID];
  if (ours?.instantaneousArea || ours?.auraArea || attachedTokenId(region)) return null;
  return region;
}

/** Test seam (harness10 H50): note or clear (`region` null) the prepared area of an item. */
export function notePreparedArea(itemUuid, region) {
  if (!itemUuid) return;
  if (region) prepared.set(itemUuid, region);
  else prepared.delete(itemUuid);
}
export async function removeAutomaticAuraRegions(item) {
  for (const scene of list(game.scenes)) {
    const ids = list(scene.regions).filter(r => sourceOf(r) === item.uuid && r.flags?.[MODULE_ID]?.auraArea).map(r => r.id);
    if (ids.length) await scene.deleteEmbeddedDocuments("Region", ids);
  }
}
/** Repair only regions created by our old centered-area path; never touch unrelated templates. */
export async function repairAutomaticAuraRegions() {
  if (game.users.activeGM?.id !== game.user.id) return;
  for (const scene of list(game.scenes)) for (const region of list(scene.regions)) {
    if (!scene.regions.get(region.id) || !region.flags?.[MODULE_ID]?.instantaneousArea) continue;
    const item = fromUuidSync(sourceOf(region) ?? "");
    if (item?.system?.distance?.type !== "aura") continue;
    const token = item.actor?.token?.parent?.id === scene.id ? item.actor.token : list(scene.tokens).find(t => t.actor?.uuid === item.actor?.uuid);
    if (!token) continue;
    const existing = attachedAuraRegion(item, token);
    if (existing && existing.id !== region.id) { await region.delete(); continue; }
    const area = zoneArea(item, { shape: "ability" }, v => evaluateInt(v, item));
    const shapes = zoneShapes(area, { scene, creatorDoc: token });
    if (item.system.target?.type === "selfAlly") for (const shape of shapes) if (shape.base) shape.base.hole = false;
    await region.update({ shapes, "attachment.token": token.id, "flags.draw-steel-combat-tools.aura": true,
      [`flags.${MODULE_ID}.instantaneousArea`]: false, [`flags.${MODULE_ID}.auraArea`]: true });
  }
}

export function registerAutomaticAreas() {
  // libWrapper permits one registration per module and target. Feature checks surround area
  // preparation so a rejected use cannot leave a template behind or change the user's targets.
  wrap("CONFIG.Item.dataModels.ability.prototype.use", function(wrapped, ...args) {
    // 0.16.0: before Combat Tools' range check sees the dialog (refreshed on its re-entry too).
    dsctRangeExempt(this.parent);
    return featureAbilityUse.call(this, areaUse.bind(this, wrapped), ...args);
  }, "MIXED");
  wrap("CONFIG.Item.dataModels.ability.prototype.placeTemplate", function(wrapped, ...args) {
    const token = this.actor?.token ?? this.actor?.getActiveTokens?.(true, true)?.[0];
    const kept = prepared.get(this.parent.uuid);
    const region = (live(kept) ? kept : null) ?? attachedAuraRegion(this.parent, token);
    if (region) {
      if (args[0]?.setTargets === "replace") canvas.tokens.setTargets(canvas.tokens.placeables.filter(t => this.validTarget(t.document) && t.document.testInsideRegion(region)).map(t => t.id), { mode: "replace" });
      return region;
    }
    return wrapped(...args);
  }, "MIXED");
  for (const hook of ["ready", "canvasReady"]) Hooks.on(hook, () => repairAutomaticAuraRegions().catch(error => console.error("stef-ds-automation | aura region repair", error)));
  Hooks.on("createRegion", region => noteLinked(region, region?.flags));
  Hooks.on("updateRegion", (region, changed) => noteLinked(region, changed?.flags));
}

/** Test seam (harness10): Combat Tools linked `region` to its ability now. */
export function noteLinkedRegion(region) {
  noteLinked(region, region?.flags);
}

/* Milestone 9 (docs/M9-DESIGN.md §A, D3): the creatures inside the area a use placed, noted on the author's client and
 * consumed once by the seed (engine/seed.mjs), as spend.mjs notes the dialog's spend. */
const AREA_KEEP_MS = 120_000;
const MAX_AREA_TOKENS = 60;
let lastArea = null;

/** Note the tokens (with an actor) inside `region` for this use of `item`. Never throws. */
export function noteArea(item, region) {
  try {
    if (!item?.uuid || !region) return;
    const tokenUuids = list(region.parent?.tokens).filter(t => t?.actor && t.testInsideRegion?.(region)).slice(0, MAX_AREA_TOKENS).map(t => t.uuid);
    lastArea = { itemUuid: item.uuid, tokenUuids, at: Date.now() };
  } catch (_err) {
    lastArea = null;
  }
}

/** The token uuids noted for an ability just used on this client (consumed once), or null. */
export function takeArea(itemUuid) {
  const entry = lastArea;
  if (!entry || entry.itemUuid !== itemUuid || Date.now() - entry.at > AREA_KEEP_MS) return null;
  lastArea = null;
  return [...entry.tokenUuids];
}

export async function areaUse(wrapped, ...args) {
  const automation = this.parent?.flags?.[MODULE_ID]?.automation;
  const enabled = setting("enabled") && (automation?.area === "auto" || (automation?.area !== "manual" && setting("automaticAreas")));
  if (!enabled || !this.hasTemplate || !globalThis.canvas?.ready) return wrapped(...args);
  const token = this.actor?.token ?? this.actor?.getActiveTokens?.(true, true)?.[0];
  if (!token || token.parent?.id !== canvas.scene.id) return wrapped(...args);
  const uuid = this.parent.uuid;
  // 0.16.0: Combat Tools places the area itself; we only adopt its region.
  if (this.distance.type !== "aura" && dsctAreaPickerFor(this.parent)) return dsctAreaUse.call(this, wrapped, args);
  const now = Date.now();
  let prior = entries.get(uuid);
  if (prior?.placing) return null;   // the area of this item is being placed (a second click)
  if (prior && now - prior.at > ENTRY_STALE_MS) {
    // Abandoned long ago (its dialog was vetoed and never reopened).
    if (prior.created && live(prior.region)) await prior.region.delete().catch(() => null);
    prior = null;
  }
  const entry = { region: live(prior?.region) ? prior.region : null, created: !!prior?.created, priorTargets: prior?.priorTargets ?? [...game.user.targets].map(t => t.id), placing: true, at: now };
  entries.set(uuid, entry);
  let region = entry.region;
  let completed = false;
  try {
    if (region) {
      // A vetoed use's area, taken over by Combat Tools' re-entry.
      const ids = canvas.tokens.placeables.filter(t => this.validTarget(t.document) && t.document.testInsideRegion(region)).map(t => t.id);
      canvas.tokens.setTargets(ids, { mode: "replace" });
    } else if (["burst", "aura"].includes(this.distance.type)) {
      const area = zoneArea(this.parent, { shape: "ability" }, v => evaluateInt(v, this.parent));
      const shapes = area ? zoneShapes(area, { scene: token.parent, creatorDoc: token }) : null;
      if (this.target?.type === "selfAlly") for (const shape of shapes ?? []) if (shape.base) shape.base.hole = false;
      if (!shapes?.length) return wrapped(...args);
      region = attachedAuraRegion(this.parent, token);
      if (!region) {
        const aura = this.distance.type === "aura";
        [region] = await token.parent.createEmbeddedDocuments("Region", [{
          name: this.parent.name, shapes, color: game.user.color, visibility: CONST.REGION_VISIBILITY.ALWAYS,
          levels: canvas.level ? [canvas.level.id] : [], highlightMode: "coverage", displayMeasurements: true,
          ownership: { [game.user.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
          ...(aura ? { attachment: { token: token.id }, hidden: token.hidden, restriction: { enabled: true, type: "move" } } : {}),
          flags: { "draw-steel": { abilitySource: this.parent.uuid }, ...(aura ? { "draw-steel-combat-tools": { aura: true } } : {}),
            [MODULE_ID]: { instantaneousArea: !aura, auraArea: aura } },
        }]);
        entry.created = true;
      }
      const ids = canvas.tokens.placeables.filter(t => this.validTarget(t.document) && t.document.testInsideRegion(region)).map(t => t.id);
      canvas.tokens.setTargets(ids, { mode: "replace" });
    } else {
      region = await this.placeTemplate({ setTargets: "replace" });
      entry.created = !!region;
      if (!region) return null;
      // The system leaves stale targets intact when the placed area is empty.
      const ids = canvas.tokens.placeables.filter(t => this.validTarget(t.document) && t.document.testInsideRegion(region)).map(t => t.id);
      canvas.tokens.setTargets(ids, { mode: "replace" });
    }
    entry.region = region;
    entry.placing = false;
    prepared.set(uuid, region);
    // Milestone 9 (D3): who stands in the area, for a "targets: area" effect (seed.mjs takeArea).
    noteArea(this.parent, region);
    const message = await wrapped(...args);
    completed = !!message;
    return message;
  } finally {
    entry.placing = false;
    // A later use of the item took this one over: it cleans up.
    if (entries.get(uuid) === entry) {
      entries.delete(uuid);
      prepared.delete(uuid);
      if (!completed) {
        if (region && entry.created && live(region)) await region.delete();
        canvas.tokens.setTargets(entry.priorTargets, { mode: "replace" });
      }
    }
  }
}

/**
 * 0.16.0: a use whose area Combat Tools' picker places. Its first entry is vetoed at the dialog and never resolves;
 * the re-entry finds the region Combat Tools linked to the item since then and notes it as the use's area (seed, zones).
 * Combat Tools' template lifetime removes the region; we never delete it.
 */
async function dsctAreaUse(wrapped, args) {
  const uuid = this.parent.uuid;
  const now = Date.now();
  const since = (pickerSince.get(uuid) ?? 0) > now - AREA_KEEP_MS ? pickerSince.get(uuid) : now;
  pickerSince.set(uuid, since);
  entries.delete(uuid);
  const region = linkedRegion(uuid, since);
  if (region) {
    prepared.set(uuid, region);
    noteArea(this.parent, region);
  } else prepared.delete(uuid);
  let message = null;
  try {
    message = await wrapped(...args);
    return message;
  } finally {
    if (message && pickerSince.get(uuid) === since) pickerSince.delete(uuid);
    if (region && prepared.get(uuid) === region) prepared.delete(uuid);
  }
}
