import { auraActive, auraRuleMatches, auraRadius, prepareAuraSpecial, expireAuraTurn } from "./auras.mjs";
import { entryId } from "../library/entries.mjs";
import { clearSanctuaryOnHarm } from "./capabilities.mjs";
import { removeTemporaryResources } from "./temporary-resources.mjs";
import { prepareSpecial, pickFeatureDestination } from "./specials.mjs";
import { resolveRecoveryChoices } from "./recovery-choices.mjs";
import { activePerformances, canPerform, performanceRoundReady } from "./performance.mjs";
/** Item feature rules share the ordinary plan, GM writer, record cards and Undo. */
import { MODULE_ID, QUERY_PROMPT, HOOKS, OP_STATUS } from "../constants.mjs";
import { setting } from "../settings.mjs";
import { dsctCoveredTypes } from "../library/resolve.mjs";
import { automationFor, validateAutomation } from "../library/custom.mjs";
import { findOverlay } from "../library/registry.mjs";
import { libraryOps, useState } from "../engine/library-plan.mjs";
import { buildForcedOp } from "../engine/plan.mjs";
import { evaluateInt, evaluate } from "../library/formula.mjs";
import { targetFromTokenDoc } from "../engine/targets.mjs";
import { postRecordCard } from "../engine/synthetic.mjs";
import { featureSettingKey, withTypeOverride, typeOverride, stricterMode } from "../engine/actor-category.mjs";
import { isActiveGM } from "../engine/engine.mjs";
import { onTurnEvent, onRoundEvent, currentActivation } from "../turn/lifecycle.mjs";
import { ownersOf } from "../triggers/prompt.mjs";
import { tokenOnScene, relation, distanceSquares, incapacitated } from "../triggers/eligibility.mjs";
import { routePrompt, registerPromptType } from "../relay/prompt-router.mjs";
import { worldValue } from "../resources/world-resources.mjs";
import { error, debug } from "../log.mjs";

const list = c => c?.contents ?? (c ? [...c] : []);
const escape = s => foundry.utils.escapeHTML(String(s ?? ""));
let chain = Promise.resolve();
/** In-flight rule runs by `${item.uuid}:${frequencyId}`; the value settles when the run (prompt and card) is over. */
const pending = new Map();
/** Discrete events: a run that meets an in-flight run of the same rule waits its turn instead of being dropped (state refreshes are dropped). */
const QUEUED_EVENTS = new Set(["damage.after"]);
const seenEvents = new Set();
const schedule = fn => { const run = chain.then(fn); chain = run.catch(e => error("features", e)); return run; };
/** Wait for serialized feature events (integration tests). */
export const featureEngineIdle = () => chain;
export function featureRules(item) {
  if (setting("enabled") === false || setting("libraryEnabled") === false || item?.flags?.[MODULE_ID]?.disabled) return [];
  const a = automationFor(item, findOverlay(item));
  if (a?.aura && !auraActive(item)) return [];
  if (a?.performance && (!activePerformances(item.actor ?? {}).includes(item.uuid) || !canPerform(item.actor ?? {}))) return [];
  return a && validateAutomation(a).ok ? a.rules : [];
}
export function featuresWantAfter(sceneId = null) {
  if (setting("enabled") === false || setting("libraryEnabled") === false) return false;
  const scene = sceneId ? game.scenes?.get?.(sceneId) : globalThis.canvas?.scene;
  const actors = new Map([...featureActors(), ...list(scene?.tokens).map(t => t.actor)].filter(Boolean).map(a => [a.uuid, a]));
  return [...actors.values()].some(a => list(a.items).some(i => featureRules(i).some(r => r.event === "damage.after")) || list(a.effects).some(e => e.flags?.[MODULE_ID]?.ruleEffect?.benefit === "sanctuary"));
}
export function featureActors(combat = game.combat) {
  const actors = new Map();
  if (!combat) for (const t of list(globalThis.canvas?.scene?.tokens)) if (t.actor) actors.set(t.actor.uuid, t.actor);
  for (const c of list(combat?.combatants)) if (c.actor) actors.set(c.actor.uuid, c.actor);
  return [...actors.values()];
}
function tokenOf(actor, sceneId) { return tokenOnScene(actor, sceneId); }
/** The token of an event reference ({tokenUuid, actorUuid}): the token itself, else the actor's token on the event's scene. */
function eventToken(value, sceneId) {
  return value?.tokenUuid ? fromUuidSync(value.tokenUuid) : value?.actorUuid ? tokenOf(fromUuidSync(value.actorUuid), sceneId) : null;
}
export function ruleTargets(item, rule, event = {}) {
  const actor = item.actor;
  const sceneId = event.sceneId ?? actor?.token?.parent?.id ?? game.combat?.scene?.id ?? game.combat?.scene;
  const source = fromUuidSync(item.flags?.[MODULE_ID]?.aura?.tokenUuid ?? "") ?? tokenOf(actor, sceneId);
  const doc = value => eventToken(value, sceneId);
  let tokens;
  switch (rule.targets) {
    case "self": tokens = [source ?? (rule.event === "passive" ? { actor, uuid: actor.uuid, name: actor.name } : null)]; break;
    case "source": tokens = [doc(event.source)]; break;
    case "subject": tokens = [doc(event.subject)]; break;
    case "aura": tokens = list(source?.parent?.tokens); break;
    case "encounter": tokens = list(game.combat?.combatants).map(c => c.token); break;
    default: tokens = event.targetDocs ?? []; break;
  }
  if (event.auraSingle) tokens = tokens.filter(t => t.uuid === event.auraSingle);
  const range = rule.range == null ? (rule.targets === "aura" ? auraRadius(item) : null) : evaluateInt(rule.range, item);
  if (event.kind === "turn.start" && rule.targets === "aura") tokens = tokens.filter(t => t?.uuid === event.subject?.tokenUuid);
  return [...new Map(tokens.filter(t => {
    if (!t?.actor || t.actor.system?.isObject) return false;
    // Corpses inside an aura take no damage rows or effects (unless the rule is about the dead).
    if (rule.targets === "aura" && !rule.require?.dead && ["dead", "defeated"].includes(incapacitated(t.actor, game.combat))) return false;
    if (automationFor(item, findOverlay(item))?.performance && typeof item.system?.validTarget === "function" && !item.system.validTarget(t)) return false;
    if (rule.special === "thunderMother" && item.actor.flags?.[MODULE_ID]?.performanceTargets?.[item.system._dsid]?.includes(t.uuid)) return false;
    const side = relation(source, t);
    if (rule.filter === "allies" && side !== "ally") return false;
    if (rule.filter === "selfAlly" && !["self", "ally"].includes(side)) return false;
    if (rule.filter === "enemies" && side !== "enemy") return false;
    if (rule.keywords?.length && !rule.keywords.every(k => t.actor.system?.keywords?.has?.(k) || t.actor.system?.keywords?.includes?.(k))) return false;
    if (range != null && (!source || t.parent?.id !== source.parent?.id || distanceSquares(source, t, event.positions) > range)) return false;
    if (t.parent && source?.parent && t.parent.id === source.parent.id && typeof source.object?.hasLineOfEffect === "function" && !source.object.hasLineOfEffect(t.object)) return false;
    return true;
  }).map(t => [t.uuid, t])).values()];
}
export function frequencyKey(rule, event, combat = game.combat) {
  if (!combat) return null;
  const prefix = `${combat.id}:`;
  if (rule.once === "round") return `${prefix}round:${combat.round}`;
  if (rule.once === "encounter") return `${prefix}encounter`;
  if (rule.once === "turn") return `${prefix}turn:${event.combatantId ?? combat.combatant?.id}:${event.activation ?? currentActivation(combat.id, combat.combatant?.id)?.n ?? combat.turn}`;
  return null;
}

/**
 * 1.2.0 (player report: optional feature prompts were a bare "<feature>? Yes / No" that players missed or dismissed):
 * what happened and whom the feature would affect, for the confirm prompt.
 */
function promptDetail(event = {}, tokens = []) {
  const name = uuid => {
    const doc = uuid ? fromUuidSync(uuid) : null;
    return doc?.name ?? null;
  };
  const lines = [];
  const source = event.source?.name ?? name(event.source?.tokenUuid) ?? name(event.source?.actorUuid);
  const subject = name(event.subject?.tokenUuid) ?? name(event.subject?.actorUuid);
  if (event.kind === "damage.after" && source && subject) lines.push(game.i18n.format("DSAUTO.Feature.DamagedBy", { source, subject }));
  const names = [...new Set((tokens ?? []).map(t => t?.name).filter(Boolean))];
  if (names.length) lines.push(game.i18n.format("DSAUTO.Feature.Affects", { names: names.join(", ") }));
  return lines.join(" ");
}

export async function askFeature(item, rule, { kind = "confirm", tokens = [], choices = [], limit = null, promptActor = item.actor, detail = "" } = {}) {
  const recipient = rule.cost > 0 || promptActor?.type === "npc" ? game.users.activeGM : ownersOf(promptActor)[0] ?? game.users.activeGM;
  const payload = { type: "featureRule", itemUuid: item.uuid, ruleId: rule.id, kind,
    tokens: tokens.map(t => t.uuid), choices, limit, label: rule.label ?? item.name, promptActorUuid: promptActor?.uuid, detail: String(detail ?? "").slice(0, 300) };
  return recipient?.isSelf || recipient?.id === game.userId
    ? routePrompt(payload, { user: game.user })
    : recipient?.query(QUERY_PROMPT, payload, { timeout: 123_000 });
}
async function recoveryDialog(method, options) {
  let timer, timedOut = false;
  try {
    const answer = await foundry.applications.api.DialogV2[method]({ ...options,
      render: (event, dialog) => {
        options.render?.(event, dialog);
        timer ??= setTimeout(() => { timedOut = true; void dialog.close(); }, 120_000);
      }, close: () => clearTimeout(timer), rejectClose: false });
    return { answer, timedOut };
  } finally { clearTimeout(timer); }
}
export async function handleFeaturePrompt(payload, { user } = {}) {
  if (!user?.isGM || user.id !== game.users.activeGM?.id) throw new Error("DSAUTO.Relay.Denied");
  const item = fromUuidSync(payload.itemUuid);
  const promptActor = fromUuidSync(payload.promptActorUuid ?? "") ?? item?.actor;
  if (!promptActor?.isOwner) throw new Error("DSAUTO.Relay.Denied");
  if (payload.kind === "recovery") {
    const rec = promptActor.system?.recoveries, stamina = promptActor.system?.stamina;
    const content = game.i18n.format("DSAUTO.Feature.RecoveryOffer", { name: escape(promptActor.name),
      amount: Number(rec?.recoveryValue ?? 0), value: Number(stamina?.value ?? 0),
      max: Number(stamina?.max ?? 0), recoveries: Number(rec?.value ?? 0) });
    const result = await recoveryDialog("confirm", { window: { title: item.name }, content: `<p>${content}</p>` });
    return { accepted: !result.timedOut && result.answer === true, timedOut: result.timedOut };
  }
  if (payload.kind === "performanceAttack") {
    const priorTargets = [...game.user.targets].map(t => t.id);
    const token = fromUuidSync(payload.tokens?.[0] ?? "");
    if (!token?.object || token.parent.id !== canvas.scene.id) return {};
    await item.update({ [`flags.${MODULE_ID}.performanceAttack`]: true });
    try {
      canvas.tokens.setTargets([token.id], { mode: "replace" });
      const message = await item.system.use();
      return { messageId: message?.id ?? null };
    } finally {
      await item.update({ [`flags.${MODULE_ID}.performanceAttack`]: new foundry.data.operators.ForcedDeletion() });
      canvas.tokens.setTargets(priorTargets, { mode: "replace" });
    }
  }
  if (payload.kind === "destination") return pickFeatureDestination(payload);
  if (payload.kind === "confirm") return { accepted: !!await foundry.applications.api.DialogV2.confirm({
    window: { title: item.name }, content: `${payload.detail ? `<p>${escape(payload.detail)}</p>` : ""}<p>${escape(payload.label)}${featureRules(item).find(r => r.id === payload.ruleId)?.cost ? ` (Malice: ${featureRules(item).find(r => r.id === payload.ruleId).cost})` : ""}</p>`, rejectClose: false,
  }) };
  const choices = payload.kind === "targets" ? payload.tokens.map(uuid => ({ id: uuid, name: fromUuidSync(uuid)?.name ?? uuid })) : payload.choices;
  const recoveryTargets = payload.kind === "targets" && featureRules(item).find(r => r.id === payload.ruleId)?.special === "recoveryChoices";
  const label = recoveryTargets ? game.i18n.format("DSAUTO.Feature.RecoveryTargets", { limit: payload.limit }) : payload.label;
  const content = `<p>${escape(label)}</p>${choices.map(c => `<label style="display:block"><input type="${payload.kind === "targets" || payload.kind === "performances" ? "checkbox" : "radio"}" name="choice" value="${escape(c.id)}"> ${escape(c.name)}</label>`).join("")}`;
  const options = { window: { title: item.name }, content, rejectClose: false,
    render: (_event, dialog) => {
      if (!recoveryTargets) return;
      const inputs = [...dialog.element.querySelectorAll('[name="choice"]')];
      const update = () => { const count = inputs.filter(e => e.checked).length; for (const e of inputs) e.disabled = !e.checked && count >= payload.limit; };
      for (const input of inputs) input.addEventListener("change", update);
      update();
    },
    ok: { label: "DSAUTO.Card.Apply", callback: (_event, button) => {
      const selected = [...button.form.querySelectorAll('[name="choice"]:checked')].map(el => el.value);
      if (recoveryTargets && selected.length > payload.limit) throw new Error(game.i18n.format("DSAUTO.Feature.RecoveryTargets", { limit: payload.limit }));
      return selected;
    } } };
  const ids = recoveryTargets ? (await recoveryDialog("prompt", options)).answer : await foundry.applications.api.DialogV2.prompt(options);
  return { ids: Array.isArray(ids) ? ids.slice(0, payload.limit ?? ids.length) : [] };
}

export async function executeRule(item, rule, event = {}) {
  if (!isActiveGM() || !item?.actor || item.flags?.[MODULE_ID]?.disabled) return null;
  if (event.source?.featureChain?.includes(item.uuid)) return null;
  if (event.id) {
    const previous = list(game.messages).find(message => {
      const record = message.flags?.[MODULE_ID]?.resolution;
      return record?.featureEventId === event.id && record.featureItemUuid === item.uuid && record.featureRuleId === rule.id;
    });
    if (previous) return { messageId: previous.id, ops: previous.flags[MODULE_ID].resolution.ops };
  }
  const frequencyId = rule.perTarget ? entryId(rule.id, event.auraSingle ?? event.subject?.tokenUuid ?? "") : rule.id;
  const shared = rule.targets === "encounter" && item.system?.category === "maliceAncestry";
  const key = shared ? `${game.combat?.id}:${item.system._dsid}:${rule.id}` : `${item.uuid}:${frequencyId}`;
  const frequency = frequencyKey(rule, event);
  const inflight = pending.get(key);
  if (inflight && QUEUED_EVENTS.has(event.kind)) {
    debug("feature.queued", { item: item.name, rule: rule.id, event: event.kind, eventId: event.id });
    await inflight;
    return executeRule(item, rule, event);
  }
  if (inflight || (frequency && (shared ? game.combat?.flags?.[MODULE_ID]?.encounterRuleUses?.[item.system._dsid] : item.flags?.[MODULE_ID]?.ruleUses?.[frequencyId]) === frequency)) return null;
  let tokens = ruleTargets(item, rule, event);
  if (!tokens.length && rule.event === "use" && rule.effects.some(e => e.targets === "self")) tokens = [tokenOf(item.actor, event.sceneId)].filter(Boolean);
  if (!tokens.length) {
    // A reference (attacker, event subject) that resolves to no token on the scene would otherwise skip the rule silently.
    if (["source", "subject"].includes(rule.targets) || rule.require?.sourceWithin != null) debug("feature.skip", { item: item.name, rule: rule.id, why: "noEligibleToken", targets: rule.targets, event: event.kind, ref: event[rule.targets === "subject" ? "subject" : "source"] ?? null, sceneId: event.sceneId ?? null });
    return null;
  }
  if (rule.perTarget && !event.auraSingle && tokens.length > 1) {
    const results = [];
    for (const token of tokens) results.push(await executeRule(item, rule, { ...event, id: `${event.id ?? "aura"}:${token.uuid}`, auraSingle: token.uuid, subject: { tokenUuid: token.uuid, actorUuid: token.actor.uuid } }));
    return results;
  }
  if (rule.require?.adjacent) {
    const source = eventToken(event.source, event.sceneId);
    const target = tokenOf(item.actor, event.sceneId);
    if (!source || !target || distanceSquares(source, target, event.positions) > 1) {
      debug("feature.skip", { item: item.name, rule: rule.id, why: !source ? "noSourceToken" : !target ? "noOwnerToken" : "notAdjacent", source: event.source ?? null });
      return null;
    }
  }
  if (rule.require?.sourceWithin != null) {
    const src = eventToken(event.source, event.sceneId);
    const self = tokenOf(item.actor, event.sceneId);
    const within = evaluateInt(rule.require.sourceWithin, item) ?? -1;
    const sameScene = !!src && !!self && (!src.parent || !self.parent || src.parent.id === self.parent.id);
    const distance = sameScene ? distanceSquares(src, self, event.positions) : Infinity;
    if (distance > within) {
      debug("feature.skip", { item: item.name, rule: rule.id, why: !src ? "noSourceToken" : !self ? "noOwnerToken" : !sameScene ? "otherScene" : "outOfRange", distance, within, source: event.source ?? null, sceneId: event.sceneId ?? null });
      return null;
    }
  }
  const subjectKeywords = fromUuidSync(event.subject?.actorUuid ?? "")?.system?.keywords;
  if (rule.require?.subjectKeyword && !(subjectKeywords?.has?.(rule.require.subjectKeyword) || subjectKeywords?.includes?.(rule.require.subjectKeyword))) return null;
  if (rule.require?.dead) tokens = tokens.filter(t => ["dead", "defeated"].includes(incapacitated(t.actor, game.combat)));
  if (!tokens.length) return null;
  if (rule.require?.dying) tokens = tokens.filter(t => t.actor.statuses?.has("dying"));
  if (!tokens.length) return null;
  if (rule.cost && worldValue("malice") < rule.cost) return null;
  let release;
  pending.set(key, new Promise(resolve => { release = resolve; }));
  try {
    // Inside the try: a failed claim write must still settle `pending`, or queued runs of this rule would wait forever.
    if (rule.opportunity && frequency) await item.update({ [`flags.${MODULE_ID}.ruleUses.${frequencyId}`]: frequency,
      [`flags.${MODULE_ID}.ruleMessages.${frequencyId}`]: new foundry.data.operators.ForcedDeletion() });
    const moonlight = rule.effects.some(e => e.key === "benefit:moonlight");
    if (moonlight) {
      const chosen = [];
      for (const token of tokens) {
        if (list(token.actor.effects).some(e => e.flags?.[MODULE_ID]?.ruleEffect?.itemUuid === item.uuid && e.flags[MODULE_ID].ruleEffect.benefit === "moonlight")) continue;
        if ((await askFeature(item, rule, { promptActor: token.actor }))?.accepted) chosen.push(token);
      }
      tokens = chosen; if (!tokens.length) return null;
    } else if ((rule.optional || rule.cost > 0) && !(await askFeature(item, rule, { detail: promptDetail(event, tokens) }))?.accepted) return null;
    if (rule.limit) {
      const recoveryChoices = rule.special === "recoveryChoices";
      if (recoveryChoices && setting("healingMode") === "off") return null;
      const limit = evaluateInt(rule.limit, item, {}, { min: recoveryChoices ? 0 : 1, max: 100 });
      if (limit == null || limit === 0) return null;
      if (recoveryChoices) {
        const actors = new Set();
        tokens = tokens.filter(t => { if (actors.has(t.actor.uuid)) return false; actors.add(t.actor.uuid); return true; });
      }
      const answer = await askFeature(item, rule, { kind: "targets", tokens, limit });
      const ids = new Set(answer?.ids ?? []);
      if (recoveryChoices && (ids.size > limit || [...ids].some(id => !tokens.some(t => t.uuid === id)))) return null;
      tokens = tokens.filter(t => ids.has(t.uuid)).slice(0, limit);
      if (!tokens.length) return null;
    }
    if (rule.special === "recoveryChoices") return resolveRecoveryChoices(item, rule, event, tokens);
    const special = await (rule.special?.startsWith("aura") ? prepareAuraSpecial : prepareSpecial)(item, rule, event, tokens);
    if (!special?.tokens.length) return null;
    tokens = special.tokens;
    const targets = Object.fromEntries(tokens.map(doc => { const t = targetFromTokenDoc(doc); return [t.key, { ...t, ...(event.targetRecords?.[t.key] ?? {}), tier: event.targetRecords?.[t.key]?.tier ?? event.tier ?? null }]; }));
    const source = tokenOf(item.actor, event.sceneId);
    const warnings = [];
    const covered = setting("libraryDefersToCombatTools") ? dsctCoveredTypes(item) : new Set();
    const effects = special.effects.filter(e => e.type !== "modifier" && !covered.has(e.type));
    let selfKey = null;
    if (source && special.effects.some(e => e.targets === "self")) {
      const self = targetFromTokenDoc(source);
      selfKey = self.key;
      targets[selfKey] = { ...self, ...(targets[selfKey] ?? {}), self: true, alsoTarget: !!targets[selfKey] };
    }
    const tiers = Object.values(targets).map(t => t.tier).filter(Number.isInteger);
    const selfTier = tiers.length ? Math.max(...tiers) : null;
    const decideMode = (kind, actor, tokenUuid) => {
      const mode = withTypeOverride(setting(featureSettingKey(kind)) ?? "auto", typeOverride(actor, tokenUuid));
      return event.user && !event.user.isGM && !(["recoveryChoices", "auraRecovery"].includes(rule.special) && kind === "heal") && !["forced", "teleport"].includes(kind) ? stricterMode(mode, setting("playerAuthoredMode")) : mode;
    };
    const automation = automationFor(item, findOverlay(item));
    const config = { ...(automation?.config ?? {}), ...(item.flags?.[MODULE_ID]?.config ?? {}) };
    const plan = libraryOps({ lib: { effects, config, choices: automation?.choices ?? [] }, item, targets, selfKey, self: { tier: selfTier }, use: event.use ?? {},
      noPowerRoll: true, warnings, order: 0, spend: event.spend, sourceTokenUuid: source?.uuid,
      decideMode, forcedRow: opts => buildForcedOp({ ...opts, item, sourceTokenUuid: source?.uuid, warnings }) });
    const ops = plan.ops;
    if (item.system?._dsid === "riders-on-the-storm") for (const op of Object.values(ops)) if (op.kind === "damage") op.type = item.flags?.[MODULE_ID]?.aura?.damageType ?? op.type;
    for (const op of Object.values(ops)) if (op.kind === "damage" && (rule.targets === "aura" || (rule.event === "use" && item.system?.hasTemplate))) op.aoe = true;
    let order = Object.keys(ops).length;
    for (const e of special.effects.filter(e => e.type === "modifier")) for (const [targetKey, t] of Object.entries(targets).filter(([k, t]) => e.targets === "self" ? k === selfKey : k !== selfKey || t.alsoTarget)) {
      if (e.tiers?.length && !e.tiers.includes(t.tier)) continue;
      if (e.when?.spend != null && e.when.spend !== !!event.use?.spend) continue;
      if (e.when?.config && !config[e.when.config]) continue;
      if (e.when?.strained != null && e.when.strained !== !!event.use?.strained) continue;
      const targetActor = fromUuidSync(t.actorUuid);
      if (e.potency && setting("potencyGate") && !targetActor?.checkPotency?.(evaluateInt(e.potency.value, item, { tier: t.tier, spend: event.spend, target: targetActor }), e.potency.characteristic)) continue;
      const value = evaluate(e.value, item, { tier: t.tier, spend: event.spend, config, target: targetActor });
      if (value == null) throw new Error("DSAUTO.Reason.formulaInvalid");
      const id = `modifier-${order}`;
      ops[id] = { opId: id, kind: "modifier", property: e.key, value, modifierMode: e.mode ?? "add", modifierId: e.id,
        targetKeys: [targetKey], status: OP_STATUS.PENDING, mode: decideMode("condition", fromUuidSync(t.actorUuid), t.tokenUuid), order: order++ };
    }
    if (["shift", "blocking"].includes(rule.special)) for (const [targetKey] of Object.entries(targets)) {
      const id = `feature-move-${order}`;
      ops[id] = { opId: id, kind: "featureMove", moveStyle: rule.special === "shift" ? "shift" : "teleport",
        distance: evaluateInt(rule.range ?? item.system?.distance?.primary ?? 0, item), targetKeys: [targetKey],
        status: OP_STATUS.PENDING, mode: decideMode("teleport", item.actor, source?.uuid), order: order++ };
    }
    for (const op of Object.values(ops)) Object.assign(op, { featureItemUuid: item.uuid, ruleId: frequencyId, featureEnd: rule.end, label: rule.label ?? item.name, temporaryResource: rule.special === "spotlight", featureFrequency: frequency, featureOpportunity: !!rule.opportunity, sharedRuleDsid: shared ? item.system._dsid : null });
    for (const [id, op] of Object.entries(ops)) if (op.mode === "off") delete ops[id];
    if (!Object.keys(ops).length) return null;
    if (rule.cost && source) {
      const self = targetFromTokenDoc(source);
      targets[self.key] ??= { ...self, self: true };
    }
    if (rule.cost) ops["malice-cost"] = { opId: "malice-cost", kind: "resource", resource: "malice", amount: -rule.cost,
      mode: "manual", status: OP_STATUS.PENDING, targetKeys: source ? [targetFromTokenDoc(source).key] : [], order: -1, featureCost: true, featureItemUuid: item.uuid, ruleId: rule.id, featureFrequency: frequency, featureOpportunity: !!rule.opportunity, sharedRuleDsid: shared ? item.system._dsid : null };
    if (rule.cost) for (const op of Object.values(ops)) if (!op.featureCost) op.costOpId = "malice-cost";
    const result = await postRecordCard({ title: rule.label ?? item.name, sourceActor: item.actor, sourceTokenUuid: source?.uuid,
      abilityUuid: item.uuid, targets, ops, modes: {}, warnings, user: event.user ?? game.user, meta: { choices: plan.choices, featureEventId: event.id ?? null, featureRuleId: rule.id, featureItemUuid: item.uuid, featureChain: [...(event.source?.featureChain ?? []), item.uuid] } });
    return result;
  } finally { pending.delete(key); release(); }
}

export async function runFeatureEvents(events) {
  if (!isActiveGM() || setting("enabled") === false) return;
  for (const event of events) {
    if (seenEvents.has(event.id)) continue;
    seenEvents.add(event.id);
    if (event.kind === "damage.after") await clearSanctuaryOnHarm(event).catch(err => error("features.sanctuary", err));
    if (seenEvents.size > 2000) seenEvents.delete(seenEvents.values().next().value);
    const sharedOffers = new Set();
    for (const actor of featureActors()) for (const item of list(actor.items)) for (const rule of featureRules(item)) {
      if (event.kind.startsWith("turn.") && rule.require?.subject === "self" && actor.uuid !== event.subject?.actorUuid) continue;
      if (rule.event !== event.kind || (event.kind === "damage.after" && rule.require?.subject !== "creature" && actor.uuid !== event.subject?.actorUuid)) continue;
      if (!auraRuleMatches(item, rule, event)) continue;
      const offer = rule.targets === "encounter" && item.system?.category === "maliceAncestry" ? `${item.system._dsid}:${rule.id}` : null;
      if (offer && sharedOffers.has(offer)) continue;
      if (offer) sharedOffers.add(offer);
      // One failing rule must not drop the rules and events (the other targets of the same card) behind it.
      try { await executeRule(item, rule, event); } catch (err) { error("features.rule", err, { item: item.name, rule: rule.id, event: event.kind }); }
    }
  }
}

async function expireRules(combat, end, actor = null) {
  for (const a of featureActors(combat)) for (const effect of list(a.effects)) {
    const info = effect.flags?.[MODULE_ID]?.ruleEffect;
    if (info?.combatId === combat.id && info.end === end && (!actor || effect.parent.uuid === actor.uuid)) await effect.delete();
  }
}
export function registerFeatureEngine() {
  registerPromptType("featureRule", handleFeaturePrompt);
  onTurnEvent(e => schedule(async () => {
    await expireAuraTurn(e);
    if (e.event === "turnEnd" && e.actor?.flags?.[MODULE_ID]?.temporaryResources) await removeTemporaryResources(e.actor, Object.keys(e.actor.flags[MODULE_ID].temporaryResources).filter(id => e.actor.flags[MODULE_ID].temporaryResources[id].end === "turnEnd"));
    if (e.event === "turnEnd") await expireRules(e.combat, "turnEnd", e.actor);
    const token = e.combatant?.token;
    await runFeatureEvents([{ id: `${e.combat.id}:${e.combatant.id}:${e.activation}:${e.event}`, kind: e.event === "turnStart" ? "turn.start" : "turn.end",
      combatantId: e.combatant.id, activation: e.activation, sceneId: token?.parent?.id, subject: { actorUuid: e.actor?.uuid, tokenUuid: token?.uuid } }]);
  }));
  onRoundEvent(e => schedule(async () => {
    if (e.event === "roundStart") await performanceRoundReady(e.combat, e.round);
    if (e.event === "roundEnd") await expireRules(e.combat, "roundEnd");
    await runFeatureEvents([{ id: `${e.combat.id}:${e.round}:${e.event}`, kind: e.event === "roundStart" ? "round.start" : "round.end", sceneId: e.combat.scene?.id }]);
  }));
  Hooks.on("deleteCombat", combat => schedule(async () => {
    if (!isActiveGM()) return;
    for (const actor of featureActors(combat)) {
      const credits = actor.flags?.[MODULE_ID]?.temporaryResources ?? {};
      await removeTemporaryResources(actor, Object.keys(credits).filter(id => credits[id].combatId === combat.id));
      if (actor.flags?.[MODULE_ID]?.moonlightChosen === combat.id) {
        await actor.createEmbeddedDocuments("ActiveEffect", [{ name: game.i18n.localize("DSAUTO.Feature.MoonlightDust"), statuses: ["dead"], flags: { [MODULE_ID]: { moonlightDust: combat.id } } }]);
        
        await actor.update({ [`flags.${MODULE_ID}.moonlightChosen`]: new foundry.data.operators.ForcedDeletion() });
      }
    }
    await expireRules(combat, "encounterEnd");
  }));
  Hooks.on(HOOKS.resolved, (message, resolved) => schedule(async () => {
    if (!isActiveGM()) return;
    const res = resolved ?? message.flags?.[MODULE_ID]?.resolution;
    if (res?.synthetic || seenEvents.has(`${message.id}:use`)) return;
    seenEvents.add(`${message.id}:use`);
    const item = fromUuidSync(res?.abilityUuid ?? "");
    if (!item) return;
    for (const rule of featureRules(item).filter(r => r.event === "use" || r.activateOnUse)) await executeRule(item, rule.activateOnUse ? { ...rule, cost: 0, optional: false } : rule, { id: message.id, sceneId: fromUuidSync(res.sourceTokenUuid ?? "")?.parent?.id,
      targetDocs: Object.values(res.targets ?? {}).map(t => fromUuidSync(t.tokenUuid ?? "")).filter(Boolean), spend: res.spend, targetRecords: res.targets, subject: { actorUuid: item.actor.uuid, tokenUuid: res.sourceTokenUuid }, user: game.users.get(res.authorUserId), use: useState(message, item) });
  }));
  Hooks.on("updateActor", (actor, changes) => {
    if (!isActiveGM() || !game.combat?.started || !["dead", "defeated"].includes(incapacitated(actor, game.combat))) return;
    if (!(changes.system?.stamina || changes["system.stamina.value"] != null || changes.statuses)) return;
    schedule(async () => {
      for (const performer of featureActors()) for (const item of list(performer.items)) for (const rule of featureRules(item).filter(r => r.effects.some(e => e.key === "benefit:moonlight"))) await executeRule(item, rule, { sceneId: game.combat.scene?.id });
    });
  });
  const refresh = item => schedule(async () => {
    if (!isActiveGM() || !item?.actor) return;
    for (const effect of list(item.actor.effects)) if (effect.flags?.[MODULE_ID]?.ruleEffect?.itemUuid === item.uuid && effect.flags[MODULE_ID].ruleEffect.end === "passive") await effect.delete();
    for (const rule of featureRules(item).filter(r => r.event === "passive")) await executeRule(item, { ...rule, targets: "self", end: "passive" });
  });
  for (const hook of ["createItem", "updateItem"]) Hooks.on(hook, (item, changes) => {
    if (changes && (changes.flags?.[MODULE_ID]?.ruleUses || Object.keys(changes).every(k => k.startsWith(`flags.${MODULE_ID}.ruleUses`)))) return;
    refresh(item);
  });
  Hooks.on("deleteItem", item => schedule(async () => {
    if (!isActiveGM()) return;
    for (const actor of new Map([...featureActors(), item.actor].filter(Boolean).map(a => [a.uuid, a])).values()) for (const effect of list(actor.effects)) if (effect.flags?.[MODULE_ID]?.ruleEffect?.itemUuid === item.uuid) await effect.delete();
  }));
  Hooks.on("updateSetting", doc => {
    if ([`${MODULE_ID}.enabled`, `${MODULE_ID}.libraryEnabled`].includes(doc.key)) for (const actor of new Map([...list(game.actors), ...featureActors()].map(a => [a.uuid, a])).values()) for (const item of list(actor.items)) refresh(item);
  });
  Hooks.once("ready", () => { for (const actor of new Map([...list(game.actors), ...featureActors()].map(a => [a.uuid, a])).values()) for (const item of list(actor.items)) if (featureRules(item).some(r => r.event === "passive")) refresh(item); });
}
