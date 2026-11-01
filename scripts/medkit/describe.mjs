/**
 * Human-readable lines for library effects, triggers, trackers and native effects (medkit views). Words
 * only, from our own strings (and the core's step words) and the system's labels: no rules text.
 *
 * i18n (Milestone 5, M5-DESIGN §5.5): DSMEDKIT.Trigger.{Line, Free, Budget, Spend, Cost, Tracker, EndsOnDying},
 * DSMEDKIT.Trigger.Event.<eventKey> and DSMEDKIT.Trigger.Subject.<subject> (dynamic, listed in tests/check.cjs);
 * the core's DSAUTO.Trigger.Step.{halve, potency, edge1, edge2, use, freeStrike, takeTurnNext}. Headings and
 * the budget line (DSMEDKIT.Trigger.{Heading, TrackerHeading, BudgetAvailable, BudgetUsed, BudgetUntracked})
 * are in the item window template and actor-medkit.mjs.
 *
 * i18n (Milestone 6, M6-DESIGN §5.4): DSMEDKIT.Effect.summon, DSMEDKIT.Effect.summonTurn_<turn> and
 * DSMEDKIT.Summon.Lasts.<end> (dynamic, listed in tests/check.cjs). The "Summons" fieldset's keys
 * (DSMEDKIT.Summons.*) are in actor-medkit.mjs and its template.
 *
 * i18n (Milestone 7, M7-DESIGN §5.4): DSMEDKIT.Effect.zone, DSMEDKIT.Gain.Line, DSMEDKIT.Gain.Once.<once> (dynamic,
 * listed in tests/check.cjs); the core's DSAUTO.Entry.ZoneEvent.<event>, DSAUTO.Zone.Affects.<affects> and
 * DSAUTO.Zone.Lasts.<end> (the zone line's words).
 */
const L = (key, data) => (data ? game.i18n.format(`DSMEDKIT.Effect.${key}`, data) : game.i18n.localize(`DSMEDKIT.Effect.${key}`));

function statusName(id) {
  const s = CONFIG.statusEffects?.[id] ?? CONFIG.statusEffects?.find?.(e => e.id === id);
  return s?.name ? game.i18n.localize(s.name) : id;
}

function endName(end) {
  const cfg = ds.CONFIG.effectEnds?.[end];
  return cfg?.abbreviation ? game.i18n.localize(cfg.abbreviation) : end;
}

function effectName(item, id) {
  return item?.effects?.get?.(id)?.name ?? id;
}

/**
 * Name of a summon stat block: the overlay's label, else the name in the pack index (synchronous), else
 * the uuid's id. `Actor.<id>` (a world-relative link) is looked up in the monsters pack, as the core maps it.
 */
function summonActorName(actor) {
  if (actor?.label) return actor.label;
  const uuid = String(actor?.uuid ?? actor ?? "");
  const pack = /^Compendium\.([\w-]+\.[\w-]+)\.Actor\.([A-Za-z0-9]{16})$/.exec(uuid);
  const world = /^Actor\.([A-Za-z0-9]{16})$/.exec(uuid);
  const [packId, id] = pack ? [pack[1], pack[2]] : world ? ["draw-steel.monsters", world[1]] : [null, null];
  if (!id) return uuid.split(".").pop() || "?";
  try {
    const name = game.packs?.get?.(packId)?.index?.get?.(id)?.name;
    if (name) return name;
  } catch (_err) { /* no packs (tests) */ }
  return id;
}

/** One line for a library effect. */
export function describeEffect(effect, item) {
  const e = effect;
  let what;
  switch (e.type) {
    case "damage": what = L("damage", { value: e.value, type: e.damageType || "" }); break;
    case "heal":
      what = e.recoveries ? L("recoveries", { count: e.recoveries }) : L(e.temporary ? "temp" : "heal", { value: e.value });
      break;
    case "condition": {
      const name = e.status ? statusName(e.status) : e.effect ? effectName(item, e.effect) : (e.label || e.uuid);
      what = e.end ? L("conditionEnd", { name, end: endName(e.end) }) : L("condition", { name });
      break;
    }
    case "cleanse": {
      const list = [...(e.statuses ?? []).map(statusName), ...(e.ends ?? []).map(endName)].join(", ");
      what = e.count ? L("cleanseCount", { count: e.count, what: list }) : L("cleanse", { what: list });
      break;
    }
    case "resource": what = L("resource", { value: e.value, resource: game.i18n.localize(`DSMEDKIT.Resource.${e.resource}`) }); break;
    case "forced": what = L("forced", { movement: [e.movement].flat().join(" / "), distance: e.distance }); break;
    case "teleport": what = L("teleport", { distance: e.distance }); break;
    case "note": what = L("note", { text: e.text }); break;
    case "summon": {
      const names = (Array.isArray(e.actors) ? e.actors : []).map(summonActorName).join(" / ");
      what = L("summon", { count: e.quantity ?? "1", what: names });
      break;
    }
    case "zone": what = describeZone(e); break;
    default: what = e.type;
  }
  const bits = [];
  // A summon or an area is always the user's own (on their row): "the user" says nothing there.
  if (e.type === "summon") {
    bits.push(L(`summonTurn_${e.turn ?? "own"}`));
    const lasts = [...(e.lasts ?? ["encounterEnd"])];
    if (lasts.length) bits.push(lasts.map(v => game.i18n.localize(`DSMEDKIT.Summon.Lasts.${v}`)).join(", "));
  } else if (e.type === "zone") bits.push(L("damage", { value: e.value ?? "", type: e.damageType || "" }));
  else bits.push(e.targets === "self" ? L("toSelf") : e.filter === "allies" ? L("toAllies") : e.filter === "enemies" ? L("toEnemies") : L("toTargets"));
  if (e.tiers?.length) bits.push(L("tiers", { tiers: e.tiers.join(", ") }));
  if (e.byTier) bits.push(L("byTier"));
  if (e.potency) bits.push(L("potency", { chr: e.potency.characteristic, value: e.potency.value }));
  if (e.when?.spend) bits.push(L("whenSpend"));
  if (e.when?.strained) bits.push(L("whenStrained"));
  if (e.when?.config) bits.push(L("whenConfig", { key: e.when.config }));
  if (e.when?.alliesNearTarget != null) bits.push(L("whenAlliesNear", { n: e.when.alliesNearTarget }));
  if (e.choice) bits.push(L("choice", { option: e.choice.option }));
  if (e.manual) bits.push(L("manual"));
  return { type: e.type, what, detail: bits.join(" · ") };
}

/* -------------------------------------------- */
/*  Areas and resource gains (core 0.9.0) */
/* -------------------------------------------- */

/** Defaults of a zone effect the line falls back to (detached entries are not normalized; core ZONE_DEFAULTS). */
const ZONE_LINE_DEFAULTS = { zoneEvents: ["enter", "turnStart"], affects: "enemies", lasts: ["summonerTurnStart"] };

/** "Area: <label> · <events> · <affects> · <lasts>" with the core's words for events, sides and ends. */
function describeZone(e) {
  const events = [...(e.zoneEvents?.length ? e.zoneEvents : ZONE_LINE_DEFAULTS.zoneEvents)];
  const lasts = [...(e.lasts?.length ? e.lasts : ZONE_LINE_DEFAULTS.lasts)];
  return L("zone", {
    label: e.label || e.name || "",
    triggers: events.map(v => game.i18n.localize(`DSAUTO.Entry.ZoneEvent.${v}`)).join(" / "),
    affects: game.i18n.localize(`DSAUTO.Zone.Affects.${e.affects || ZONE_LINE_DEFAULTS.affects}`),
    lasts: lasts.map(v => game.i18n.localize(`DSAUTO.Zone.Lasts.${v}`)).join(", "),
  });
}

/**
 * One line for a gain rule: "<label>: +<amount> <resource> (<once>)". `view` is the core's rule view of a hero
 * (`api.resources.rules`: the amount with the hero's upgrades applied); without it the rule's own amount and its
 * upgrades (detail) are shown.
 * @param {object} rule   A normalized gain rule (overlay `gains[i]`).
 * @param {{amount?: number|null, formula?: string|null}} [view]
 * @param {Actor|null} [hero]  0.4.1: the hero whose heroic resource name ("Ferocity") replaces "heroic resource".
 */
export function describeGain(rule, view = null, hero = null) {
  const g = rule ?? {};
  const amount = view ? (view.formula ?? view.amount ?? g.amount ?? 1) : (g.amount ?? 1);
  const resource = g.resource ?? "heroic";
  const named = resource === "heroic" ? hero?.system?.hero?.primary?.label : null;
  const what = game.i18n.format("DSMEDKIT.Gain.Line", {
    label: g.label ?? g.id ?? "",
    amount,
    resource: named || game.i18n.localize(`DSMEDKIT.Resource.${resource}`),
    once: game.i18n.localize(`DSMEDKIT.Gain.Once.${g.once ?? "round"}`),
  });
  const bits = [];
  if (!view && Array.isArray(g.amountBy) && g.amountBy.length) bits.push(g.amountBy.map(a => `${a.feature} +${a.amount}`).join(", "));
  if (g.confirm) bits.push(L("manual"));
  return { id: g.id, event: g.event, what, detail: bits.join(" · ") };
}

/* -------------------------------------------- */
/*  Triggers and trackers (core 0.7.0)  */
/* -------------------------------------------- */

/** i18n key suffix of an event kind ("damage.before" -> "damageBefore"), as the core's taxonomy. */
const eventKey = kind => String(kind ?? "").replace(/\.(\w)/, (_m, c) => c.toUpperCase());

/** Words for one trigger step; the step words are the core's (`DSAUTO.Trigger.Step.*`). */
function stepWords(step, item) {
  switch (step.type) {
    case "halve": return game.i18n.localize("DSAUTO.Trigger.Step.halve");
    case "potency": return game.i18n.format("DSAUTO.Trigger.Step.potency", { delta: step.delta > 0 ? `+${step.delta}` : String(step.delta) });
    case "edge": return game.i18n.localize(step.amount === 2 ? "DSAUTO.Trigger.Step.edge2" : "DSAUTO.Trigger.Step.edge1");
    case "use": return game.i18n.format("DSAUTO.Trigger.Step.use", { ability: item?.name ?? "" });
    case "freeStrike": return game.i18n.localize("DSAUTO.Trigger.Step.freeStrike");
    case "takeTurnNext": return game.i18n.localize("DSAUTO.Trigger.Step.takeTurnNext");
    case "note": return step.text;
    default: return step.type;
  }
}

/**
 * One line for an overlay trigger: event, subject and steps (`what`); budget, cost, spend (`detail`).
 * @param {object} trigger  Normalized trigger (library resolve).
 * @param {Item} item
 */
export function describeTrigger(trigger, item) {
  const t = trigger ?? {};
  const steps = (t.steps ?? []).map(s => (s.when?.spend === true ? `${stepWords(s, item)} (${L("whenSpend")})` : stepWords(s, item)));
  const what = game.i18n.format("DSMEDKIT.Trigger.Line", {
    event: game.i18n.localize(`DSMEDKIT.Trigger.Event.${eventKey(t.event)}`),
    subject: game.i18n.localize(`DSMEDKIT.Trigger.Subject.${t.subject ?? "self"}`),
    steps: steps.join(", "),
  });
  const bits = [];
  if (t.label) bits.push(t.label);
  const free = t.free === true || item?.system?.type === "freeTriggered";
  bits.push(game.i18n.localize(free ? "DSMEDKIT.Trigger.Free" : "DSMEDKIT.Trigger.Budget"));
  const cost = Number(t.cost ?? item?.system?.resource ?? 0) || 0;
  if (cost > 0) bits.push(game.i18n.format("DSMEDKIT.Trigger.Cost", { cost }));
  if (t.spend?.cost) bits.push(game.i18n.format("DSMEDKIT.Trigger.Spend", { cost: t.spend.cost }) + (t.spend.label ? ` (${t.spend.label})` : ""));
  return { event: t.event, what, detail: bits.join(" · ") };
}

/** One line for an overlay tracker: the effect it follows, and when it ends. */
export function describeTracker(tracker, item) {
  const k = tracker ?? {};
  const what = game.i18n.format("DSMEDKIT.Trigger.Tracker", { effect: effectName(item, k.effect) });
  const bits = [];
  if (k.label) bits.push(k.label);
  if (k.endOnSourceDying) bits.push(game.i18n.localize("DSMEDKIT.Trigger.EndsOnDying"));
  return { what, detail: bits.join(" · ") };
}

/** Lines for the native power roll effects of an ability (what the system itself describes). */
export function describeNative(item) {
  const out = [];
  for (const pre of item?.system?.power?.effects?.contents ?? []) {
    if (pre.type === "damage") out.push({ id: pre.id, what: L("nativeDamage") });
    else if (pre.type === "applied") {
      const ids = new Set();
      for (const n of [1, 2, 3]) for (const id of Object.keys(pre.applied?.[`tier${n}`]?.effects ?? {})) ids.add(id);
      out.push({ id: pre.id, what: L("nativeApplied", { names: [...ids].map(id => (CONFIG.statusEffects?.[id] ? statusName(id) : effectName(item, id))).join(", ") }) });
    } else if (pre.type === "forced") out.push({ id: pre.id, what: L("nativeForced") });
    else out.push({ id: pre.id, what: pre.type });
  }
  return out;
}
