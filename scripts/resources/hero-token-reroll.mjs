/**
 * 0.16.0: a hero token rerolls an ability's power roll (house rule, world setting `heroTokenRerollPowerRolls`, off by
 * default). Draw Steel lets a hero token reroll a test (TestPart#reroll, spend type "rerollTest"); this offers the same
 * on ability cards, which the system does not.
 *
 * On the active GM (relay action `heroReroll`; the Director, or the owner of the hero who used the ability, also after its
 * rows were applied):
 * 1. the card's applied rows are undone (the new tiers replace them);
 * 2. one hero token is spent through the system (spend type `dsAutoRerollPower`, which adds the system's hero-token
 *    part to the card);
 * 3. the 2d10 is rolled again once for every target, each target keeping its edges, banes and bonuses (the PowerRoll
 *    options carry them, `appliedModifier`), and the damage rolls are rebuilt for the new tiers (as AbilityModel#use: the
 *    damage type picked on the first roll and the dialog's spend);
 * 4. the result parts are replaced and the card is resolved again, its undone rows rebuilt from the new tiers.
 * A failure after the spend gives the token back.
 *
 * Both card shapes (engine/readers.mjs cardShape): Draw Steel 1.1.2 and untargeted 1.2 cards (tier parts: the rolls are
 * regrouped into one `abilityResult` part per new tier) and 1.2 cards with targets (one `targetResult` part per target:
 * every part keeps its id, target and token, only its tier and rolls change, so no part is deleted; a squad's minion
 * count is read back from its damage roll's data, `squadMinions`).
 *
 * i18n keys: DSAUTO.HeroToken.{RerollLabel, RerollMessage, Reroll, RerollHint, RerollNone}.
 */
import { MODULE_ID, OP_STATUS } from "../constants.mjs";
import { setting } from "../settings.mjs";
import { log } from "../log.mjs";
import { isAuthor } from "../relay/auth.mjs";
import { spendValues } from "../engine/spend.mjs";
import { cardShape } from "../engine/readers.mjs";

export const REROLL_SPEND = "dsAutoRerollPower";
const LABEL = "DSAUTO.HeroToken.RerollLabel";
const MESSAGE = "DSAUTO.HeroToken.RerollMessage";

/** init: our spend type, before the system localizes `hero.tokenSpends` (i18nInit). Every client (the GM spends). */
export function registerHeroTokenSpend() {
  const spends = globalThis.ds?.CONFIG?.hero?.tokenSpends;
  if (spends && !spends[REROLL_SPEND]) spends[REROLL_SPEND] = { label: LABEL, tokens: 1, messageContent: MESSAGE };
}

/** ready: localize our entry when the system's pass did not reach it. */
export function localizeHeroTokenSpend() {
  const spend = globalThis.ds?.CONFIG?.hero?.tokenSpends?.[REROLL_SPEND];
  if (!spend) return;
  if (spend.label === LABEL) spend.label = game.i18n.localize(LABEL);
  if (spend.messageContent === MESSAGE) spend.messageContent = game.i18n.localize(MESSAGE);
}

function lookup(uuid) {
  try {
    return uuid ? fromUuidSync(uuid) : null;
  } catch (_err) {
    return null;
  }
}

/**
 * The card's result parts and their power / damage rolls, or null (no power roll, or a 1.2 build without token uuids):
 * `{shape, parts, power, damage, targetOf, perPart}`; `targetOf` maps each power roll to its target's actor uuid and
 * `perPart` lists `{part, power, damage}` per result part.
 */
export function cardRolls(message) {
  const PowerRoll = globalThis.ds?.rolls?.PowerRoll;
  const DamageRoll = globalThis.ds?.rolls?.DamageRoll;
  const all = message?.system?.parts?.contents ?? [];
  const shape = cardShape(all);
  if (!PowerRoll || shape === "unknown") return null;
  const type = shape === "targetResult" ? "targetResult" : "abilityResult";
  const parts = all.filter(p => p?.type === type);
  const power = [];
  const damage = [];
  const targetOf = new Map();
  const perPart = [];
  for (const p of parts) {
    const entry = { part: p, power: [], damage: [] };
    for (const r of p.rolls ?? []) {
      if (DamageRoll && r instanceof DamageRoll) entry.damage.push(r);
      else if (r instanceof PowerRoll) entry.power.push(r);
    }
    for (const r of entry.power) targetOf.set(r, shape === "targetResult" ? p.targetUuid : r.options?.target);
    power.push(...entry.power);
    damage.push(...entry.damage);
    perPart.push(entry);
  }
  return power.length ? { shape, parts, power, damage, targetOf, perPart } : null;
}

const heroTokens = () => Number(game.actors?.heroTokens?.value ?? 0) || 0;

/** May `user` reroll this card's power roll with a hero token now (button and relay check)? */
export function heroRerollAllowed(message, res, user = game.user) {
  if (!setting("heroTokenRerollPowerRolls") || !user || !res?.resolvedAt || res.synthetic) return false;
  if (!cardRolls(message)) return false;
  const actor = lookup(res.abilityUuid)?.actor ?? lookup(res.sourceActorUuid);
  if (actor?.type !== "hero") return false;
  if (user.isGM) return true;
  // Live check 2026-10-25: rows are usually applied at once, and "Use my targets" refuses players then. The reroll
  // undoes them on the Director's client, so the hero's owner who used the ability may still spend the token.
  return !!actor.testUserPermission?.(user, "OWNER") && isAuthor(user, message);
}

/** Show the card's button: a token to spend, nothing held, and the user may. */
export const heroRerollShown = (message, res, user = game.user) => heroTokens() >= 1 && !res?.hold && heroRerollAllowed(message, res, user);

/**
 * The new result parts for a reroll: `{update, tiers, total}`. `update` is for ChatMessage#update (replaced parts as
 * sources, removed ones as deletions); `tiers` maps each target's actor uuid to its new tier
 * (a power roll's `options.target` on tier parts, the part's `targetUuid` on target parts).
 */
export async function rerolledParts(message, item, res) {
  const card = cardRolls(message);
  if (!card) throw new Error("DSAUTO.HeroToken.RerollNone");
  const [first] = card.power;
  const base = first.clone();
  await base.evaluate({ allowInteractive: false });
  const rolled = new Map();
  for (const old of card.power) {
    if (old === first) {
      rolled.set(old, base);
      continue;
    }
    const roll = old.clone();
    roll.terms[0] = base.terms[0];   // one 2d10 for every target, as AbilityModel#use
    await roll.evaluate({ allowInteractive: false });
    rolled.set(old, roll);
  }
  const damageSelection = card.damage.find(r => r.options?.type)?.options?.type;
  const spend = spendValues(res?.spend ?? null);
  const damageEffects = item.system?.power?.effects?.documentsByType?.damage ?? [];
  const damageFor = async (tier, squadMinions) => {
    const out = [];
    for (const effect of damageEffects) {
      const damage = effect.toDamageRoll(tier, { damageSelection, ...(spend?.length ? { spend } : {}), ...(squadMinions ? { squadMinions } : {}) });
      if (!damage) continue;
      await damage.evaluate();
      out.push(damage);
    }
    return out;
  };
  const update = {};
  if (card.shape === "targetResult") {
    for (const { part, power, damage } of card.perPart) {
      const roll = rolled.get(power[0]);
      const tier = Number(roll.product);
      // DS drops `minions` from the roll options after the use; the squad's count survives in its damage rolls' data.
      const squad = damage.map(r => r.data?.squadMinions).find(n => n != null);
      const squadMinions = roll.options?.minions ?? (squad != null ? Number(squad) + 1 : undefined);
      const source = part.toObject?.() ?? part._source ?? {};
      const data = {
        ...source, _id: part.id, type: "targetResult", tier, abilityUuid: item.uuid,
        targetUuid: part.targetUuid ?? source.targetUuid, tokenUuid: part.tokenUuid ?? source.tokenUuid,
        rolls: [roll, ...await damageFor(tier, squadMinions)].map(r => JSON.stringify(r)),
      };
      // The part is merged into the stored one: `potencies` (manual adjustments) stay as they are, and leaving the key out
      // keeps the potency listener (engine.mjs, a changed `potencies`) quiet.
      delete data.potencies;
      if (data.tokenUuid == null) delete data.tokenUuid;
      update[`system.parts.${part.id}`] = data;
    }
  } else {
    const grouped = Object.groupBy([...rolled.values()], r => r.product);
    const keep = new Set();
    for (const [tier, rolls] of Object.entries(grouped)) {
      const id = `tier${tier}Result`.padEnd(16, "0");
      keep.add(id);
      const all = [...rolls, ...await damageFor(Number(tier))];
      update[`system.parts.${id}`] = { _id: id, type: "abilityResult", tier: Number(tier), abilityUuid: item.uuid, flavor: "", rolls: all.map(r => JSON.stringify(r)) };
    }
    for (const p of card.parts) if (!keep.has(p.id)) update[`system.parts.${p.id}`] = new foundry.data.operators.ForcedDeletion();
  }
  const tiers = Object.fromEntries([...rolled].filter(([old]) => card.targetOf.get(old)).map(([old, r]) => [card.targetOf.get(old), r.product]));
  return { update, tiers, total: base.total };
}

/**
 * Active GM: reroll the card's power roll with a hero token (see the header). Returns `{ok, tiers?}`, with `refused`
 * ("noToken" | "undo" | "spend") when nothing was rerolled.
 */
export async function rerollPowerRoll(message, { user = game.user } = {}) {
  const { getResolution } = await import("../engine/record.mjs");
  const { resolveMessage, undoOps } = await import("../engine/engine.mjs");
  let res = getResolution(message);
  if (!heroRerollAllowed(message, res, user)) throw new Error("DSAUTO.Relay.Denied");
  if (heroTokens() < 1) return { ok: false, refused: "noToken" };
  const item = lookup(res.abilityUuid);
  if (!item) throw new Error("DSAUTO.HeroToken.RerollNone");
  if (Object.values(res.ops ?? {}).some(o => o.status === OP_STATUS.APPLIED)) {
    await undoOps(message, null, { userId: user.id });
    message = game.messages.get(message.id) ?? message;
    res = getResolution(message);
    if (Object.values(res?.ops ?? {}).some(o => o.status === OP_STATUS.APPLIED)) return { ok: false, refused: "undo" };
  }
  const beforeCard = cardRolls(message);
  const before = Object.fromEntries((beforeCard?.power ?? []).filter(r => beforeCard.targetOf.get(r)).map(r => [beforeCard.targetOf.get(r), r.product]));
  const spent = await game.actors.heroTokens.spendToken(REROLL_SPEND, { messageId: message.id });
  if (spent === false) return { ok: false, refused: "spend" };
  try {
    const { update, tiers, total } = await rerolledParts(message, item, res);
    update[`flags.${MODULE_ID}.heroRerolls`] = (Number(message.flags?.[MODULE_ID]?.heroRerolls) || 0) + 1;
    await message.update(update, { [MODULE_ID]: { heroReroll: true } });
    const why = "heroReroll";   // the resolve's log reason (not a row reason)
    await resolveMessage(game.messages.get(message.id) ?? message, { force: true, reason: why, rebuildUndone: true });
    log("heroToken.reroll", { messageId: message.id, by: user.id, before, after: tiers, total });
    return { ok: true, tiers };
  } catch (err) {
    await game.actors.heroTokens.giveToken?.(1, { chatMessage: false });
    throw err;
  }
}
