/**
 * SEED: runs on the author's client in `preCreateChatMessage` (synchronous). It stores who the
 * targets are, because standard Draw Steel ability cards only carry actor uuids in their rolls
 * (AbilityConfigurationDialog#_processFormData, draw-steel.mjs:4557-4559) and token identity would be
 * lost. It also inserts our message part so every client renders the resolution section.
 * Draw Steel 1.2 (Milestone 8, docs/M8-DESIGN.md §1.2): the shape is decided per card (cardShape on the source
 * parts); `targetResult` parts carry the target's token uuid, so targets rolled against keep their token, and the
 * dialog's spend is on the card (`abilityUse.spendAmounts`).
 *
 * The heroic resource is spent before the card is created (draw-steel.mjs:6468), so this function
 * must never throw: any error is logged and the card is created untouched.
 */
import { MODULE_ID, RECORD_VERSION } from "../constants.mjs";
import { error, debug } from "../log.mjs";
import { setting } from "../settings.mjs";
import { hasAutomatableEffects } from "./native.mjs";
import { resolveAbility } from "../library/resolve.mjs";
import { getResolution, partSource } from "./record.mjs";
import { cardShape } from "./readers.mjs";
import { spendFromUse, takeSpend } from "./spend.mjs";
import { takeChoices } from "./use-choices.mjs";
import { targetFromTokenDoc, tokenDocForActorUuid } from "./targets.mjs";
import { PART_ID } from "../constants.mjs";
import { preparedArea, takeArea } from "./areas.mjs";
import { levelOf, plain, zonePlace } from "../zones/place.mjs";

/** Upper bound of the shapes a seed copies (MAX_ZONE_SQUARES, S/library/schema.mjs). */
const MAX_AREA_SHAPES = 30;

/**
 * Who the card's result parts rolled against: `[{actorUuid, tokenUuid}]`. 1.1.2 `abilityResult` parts: the PowerRolls'
 * `options.target` (source data: JSON strings), no token; 1.2 `targetResult` parts: `targetUuid` / `tokenUuid` (plain
 * strings).
 */
function rollTargets(sourceParts) {
  const out = new Map();
  for (const part of sourceParts) {
    if (part?.type === "targetResult") {
      const actorUuid = typeof part.targetUuid === "string" && part.targetUuid ? part.targetUuid : null;
      const tokenUuid = typeof part.tokenUuid === "string" && part.tokenUuid ? part.tokenUuid : null;
      if (actorUuid || tokenUuid) out.set(`${actorUuid}|${tokenUuid}`, { actorUuid, tokenUuid });
      continue;
    }
    if (part?.type !== "abilityResult") continue;
    for (const raw of part.rolls ?? []) {
      let roll = raw;
      if (typeof raw === "string") {
        try {
          roll = JSON.parse(raw);
        } catch (_err) {
          continue;
        }
      }
      const target = roll?.options?.target;
      if (typeof target === "string" && target) out.set(`${target}|null`, { actorUuid: target, tokenUuid: null });
    }
  }
  return [...out.values()];
}

/** The token document of a rolled target: its own token (1.2), else the actor's. */
function rolledTokenDoc({ actorUuid, tokenUuid }) {
  if (tokenUuid) {
    try {
      const doc = fromUuidSync(tokenUuid);
      if (doc?.actor) return doc;
    } catch (_err) { /* stale or compendium uuid */ }
  }
  return actorUuid ? tokenDocForActorUuid(actorUuid) : null;
}

function speakerTokenUuid(message, item) {
  const { scene, token } = message.speaker ?? {};
  if (scene && token) return `Scene.${scene}.Token.${token}`;
  const doc = item?.actor?.token ?? item?.actor?.getActiveTokens?.(true, true)?.[0];
  return doc?.uuid ?? null;
}

/** Does the engine automate anything of this ability (native effects or the library)? */
export function automates(item) {
  if (!item) return false;
  if (hasAutomatableEffects(item)) return true;
  try {
    return resolveAbility(item).automatable;
  } catch (err) {
    error("seed.library", err);
    return false;
  }
}

export function onPreCreateChatMessage(message, _data, _options, userId) {
  try {
    if (userId !== game.userId) return;
    if (!setting("enabled")) return;
    if (message.type !== "standard" || getResolution(message)) return;
    const sourceParts = Object.values(message._source?.system?.parts ?? {});
    const use = sourceParts.find(p => p?.type === "abilityUse");
    if (!use?.abilityUuid) return;
    const item = fromUuidSync(use.abilityUuid);
    if (!automates(item)) return;

    const targets = {};
    for (const token of game.user.targets) {
      const t = targetFromTokenDoc(token.document);
      if (t) targets[t.key] = t;
    }
    const record = seedRecord(message, sourceParts, use, item, targets, userId, game.user.role);
    message.updateSource({ [`flags.${MODULE_ID}.resolution`]: record });
    // Separate write: if the part insert is rejected, the record survives and the GM inserts the
    // part together with the resolution write.
    try {
      message.updateSource({ [`system.parts.${PART_ID}`]: partSource() });
    } catch (err) {
      error("seed.part", err);
    }
    debug("seed", { ability: item.name, targets: Object.keys(record.targets).length });
  } catch (err) {
    error("seed", err);
  }
}

/**
 * The seed record of a card. `targets` are the author's targets; actors rolled against but no longer
 * targeted (targets changed while the dialog was open) are added from the rolls.
 */
export function seedRecord(message, sourceParts, use, item, targets, userId, role) {
  // Actors rolled against but no longer targeted (targets changed while the dialog was open).
  const warnings = [];
  const known = new Set(Object.values(targets).map(t => t.actorUuid));
  const knownTokens = new Set(Object.values(targets).map(t => t.tokenUuid));
  for (const rolled of rollTargets(sourceParts)) {
    // A 1.2 part names its token: only that token counts as known (two tokens of one linked actor).
    if (rolled.tokenUuid ? knownTokens.has(rolled.tokenUuid) : known.has(rolled.actorUuid)) continue;
    const t = targetFromTokenDoc(rolledTokenDoc(rolled), { fromRoll: true });
    if (t && !targets[t.key]) {
      targets[t.key] = t;
      known.add(t.actorUuid);
      knownTokens.add(t.tokenUuid);
    }
  }
  if (Object.values(targets).some(t => t.fromRoll)) warnings.push({ code: "targetsChanged" });

  return {
    v: RECORD_VERSION,
    shape: cardShape(sourceParts),
    abilityUuid: use.abilityUuid,
    abilityDsid: item.system?._dsid ?? null,
    abilityName: item.name,
    sourceActorUuid: item.actor?.uuid ?? null,
    sourceTokenUuid: speakerTokenUuid(message, item),
    authorUserId: userId,
    authorRole: role,
    createdAt: Date.now(),
    generation: 1,
    targets,
    ops: {},
    warnings,
    spend: seedSpend(use, userId),
    // Milestone 9 (docs/M9-DESIGN.md §B): the area drawn on use, for zones/adopt.mjs (null when none).
    areaTemplate: seedAreaTemplate(message, item, userId),
    // Milestone 9 (docs/M9-DESIGN.md §A, D3): the creatures inside that area (engine/side-targets.mjs; null when none).
    area: seedArea(use, userId),
    // 0.15.0: the "choose one" picks made in the Use Ability dialog (ui/use-choice.mjs); the resolve keeps a valid one.
    ...seedChoices(use, userId),
  };
}

/** 0.15.0: `{choices: {group: {picked, by}}}` from the dialog's picks (author's client only, consumed once), else {}. */
function seedChoices(use, userId) {
  const picks = userId === game.userId ? takeChoices(use?.abilityUuid) : null;
  if (!picks) return {};
  return { choices: Object.fromEntries(Object.entries(picks).map(([g, picked]) => [g, { picked, by: userId }])) };
}

/**
 * Milestone 9: where the author drew the use's area (engine/areas.mjs preparedArea), while the region still exists:
 * Combat Tools deletes it a few seconds later, the card may resolve after that. Author's client only (the GM's
 * adoptionUpdate has no prepared area of someone else's use). Only positions are trusted later (zones/adopt.mjs):
 * the GM builds sizes itself, `shapeSizes` only centres a larger cube on the drawn one.
 */
function seedAreaTemplate(message, item, userId) {
  try {
    if (userId !== game.userId || !item?.uuid) return null;
    const region = preparedArea(item.uuid);
    if (!region) return null;
    const shapes = [...(region.shapes ?? [])].slice(0, MAX_AREA_SHAPES).map(plain);
    const tokenUuid = speakerTokenUuid(message, item);
    let elevation = 0;
    try {
      elevation = Number(fromUuidSync(tokenUuid)?.elevation) || 0;
    } catch (_err) { /* no token */ }
    const place = zonePlace(shapes, levelOf(region), elevation);
    if (!place) return null;
    const size = v => (Number.isFinite(Number(v)) ? Number(v) : null);
    return {
      v: 1, itemUuid: item.uuid, regionUuid: region.uuid ?? null, sceneId: region.parent?.id ?? null, place,
      shapeSizes: shapes.map(s => ({
        type: String(s.type ?? ""), width: size(s.width), height: size(s.height), length: size(s.length), anchorX: size(s.anchorX), anchorY: size(s.anchorY),
      })),
      at: Date.now(),
    };
  } catch (err) {
    error("seed.areaTemplate", err);
    return null;
  }
}

/**
 * The dialog's spend: from the card on 1.2 (`spendAmounts`, any author), else what this client noted when the dialog
 * closed (consumed once, the author's own client only).
 */
function seedSpend(use, userId) {
  const noted = userId === game.userId ? takeSpend(use.abilityUuid) : null;
  return use?.spendAmounts && typeof use.spendAmounts === "object" ? spendFromUse(use) : noted;
}

/**
 * Milestone 9: the tokens engine/areas.mjs noted inside the area of this use (author's client only, consumed once).
 * Author-provided like the targets: engine/side-targets.mjs validates every uuid on the GM.
 */
function seedArea(use, userId) {
  const tokenUuids = userId === game.userId ? takeArea(use?.abilityUuid) : null;
  return tokenUuids ? { tokenUuids } : null;
}

/**
 * GM-side seed (Milestone 4): a recent ability card that nobody seeded (its author's client threw, or
 * a script created it) is taken over by the active GM when the engine automates its ability. The
 * targets come from the rolls (the author's targets are not known here), or Target Damage's list.
 * @returns {object|null} The update that inserts the record and our part.
 */
export function adoptionUpdate(message) {
  if (message?.type !== "standard" || getResolution(message)) return null;
  const sourceParts = Object.values(message._source?.system?.parts ?? {});
  const use = sourceParts.find(p => p?.type === "abilityUse");
  if (!use?.abilityUuid) return null;
  const item = fromUuidSync(use.abilityUuid);
  if (!automates(item)) return null;
  const author = message.author ?? null;
  const record = seedRecord(message, sourceParts, use, item, {}, author?.id ?? null, author?.role ?? null);
  record.adopted = true;
  // The targets come from the rolls here: that is how adopted cards always work, not a change.
  record.warnings = [...record.warnings.filter(w => w.code !== "targetsChanged"), { code: "adoptedCard" }];
  return { [`flags.${MODULE_ID}.resolution`]: record, [`system.parts.${PART_ID}`]: partSource() };
}
