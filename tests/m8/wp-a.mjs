// Milestone 8, WP-A (docs/M8-DESIGN.md §1.1-§1.5, §1.8, §4.2-§4.3; §12.1 H1-H13, H36): Draw Steel 1.2 `targetResult`
// cards (per-card shape, reader, seed and adoption, squads across target parts, appended rolls, potency adjustments,
// natural-roll facts, per-part locks) and modes by creature type (`modeByActorType`).
// Extra mocks (§12.1 "1.2 card"): `ds.CONFIG.MessagePart.targetResult`, the TargetResult / AbilityUse schema fields, the
// probes `compat.targetResult` / `compat.targetTokenUuid` (set here, restored at the end), a card builder that mirrors
// AbilityModel#use (R/data/item/ability.mjs:673-703: random part ids, per-target rolls, no target or token in the
// stored power roll's options) and DOM sections per part with the system's buttons.
// Never write reason or code literals with a colon here (tests/check.cjs scans every script for keys).
export default async function (ctx) {
  const { mocks, assert } = ctx;
  const as = ctx.asUser;
  const {
    Message, messages, setUser, gm, player, player2, getResolution, opsOf, dmgOps, gainOps, idle, settleAll, fresh, set, imp, El,
    place, START, registry, tWarrior, tAssassin, tStabby, tSpine1, tSpine2, tSpine3, tBorin, tBen, borin, stabby, warrior,
    borinStrike, wallOfFire, fight, activate, itemOn, markMsgs, since, useCard, hit, liveOp, zoneOp, regionClicks, cell,
    requestOp, placeMod, zoneReg, zoneEngine, factsMod, gainsMod, engineMod, render, attack, api,
  } = mocks;
  const { compat } = await imp("compat/version-gate.mjs");
  const readers = await imp("engine/readers.mjs");
  const cat = await imp("engine/actor-category.mjs");
  const partLock = await imp("ui/part-lock.mjs");
  const surges = await imp("engine/surges.mjs");
  const { PowerRoll, DamageRoll } = ds.rolls;
  const key = tok => tok.uuid.replace(/\./g, "__");
  const fresh12 = async () => {
    await fresh();
    compat.targetResult = true;
    compat.targetTokenUuid = true;
  };
  const readSet = k => {
    try {
      return game.settings.get("stef-ds-automation", k);
    } catch (_err) {
      return undefined;
    }
  };

  /* ---------- extra mocks ---------- */
  const hadMP = "targetResult" in ds.CONFIG.MessagePart;
  ds.CONFIG.MessagePart.targetResult ??= {};
  const mp = ds.data.pseudoDocuments.messageParts;
  const hadTR = "TargetResult" in mp;
  const hadAU = "AbilityUse" in mp;
  mp.TargetResult ??= { schema: { fields: { tokenUuid: {}, potencies: {} } } };
  mp.AbilityUse ??= { schema: { fields: { spendAmounts: {} } } };
  const saved = {
    targetResult: compat.targetResult, targetTokenUuid: compat.targetTokenUuid, modeByActorType: readSet("modeByActorType"),
    heroOverride: readSet("heroOverride"), playerAuthoredMode: readSet("playerAuthoredMode"), mixedTierSafety: readSet("mixedTierSafety"),
    ongoingDamage: readSet("ongoingDamage"),
  };
  const INHERIT = Object.freeze(Object.fromEntries(cat.ACTOR_CATEGORIES.map(c => [c, "inherit"])));
  const byType = over => set("modeByActorType", { ...INHERIT, ...over });

  let partN = 0;
  /**
   * A 1.2 ability card of `item` by `author`: one targetResult part per entry `{token, tier, damage: [amount | {amount,
   * type, aoe}], potencies}` (the entry gets its `partId`). `targets`: the author's targets at creation (default: the
   * entries' tokens). `tokenless`: parts without `tokenUuid` (third-party callers). `seed: false`: nobody seeded it.
   */
  function card12(item, { author = gm, targets = null, entries = [], natural = null, tokenless = false, spendAmounts = null, seed = true } = {}) {
    const tok = item.actor.token ?? item.actor.getActiveTokens?.(false, true)?.[0] ?? null;
    setUser(author);
    author.targets = new Set((targets ?? entries.map(e => e.token)).map(t => t.object));
    const parts = { abilityUse000000: { _id: "abilityUse000000", type: "abilityUse", abilityUuid: item.uuid, ...(spendAmounts ? { spendAmounts } : {}) } };
    for (const e of entries) {
      const id = `tr${String(++partN).padStart(14, "0")}`;
      // The system strips `target` / `tokenUuid` / `minions` from the stored power roll (ability.mjs:699-700).
      const power = new PowerRoll(10, { tier: e.tier });
      if (natural != null) power.naturalResult = natural;
      const dmg = (e.damage ?? []).map(d => new DamageRoll(d?.amount ?? d, { type: d?.type ?? "", aoe: !!d?.aoe }));
      parts[id] = {
        _id: id, type: "targetResult", abilityUuid: item.uuid, tier: e.tier, targetUuid: e.token.actor.uuid,
        ...(tokenless ? {} : { tokenUuid: e.token.uuid }), potencies: { ...(e.potencies ?? {}) }, rolls: [power, ...dmg],
      };
      e.partId = id;
    }
    const msg = new Message({ type: "standard", parts, speaker: { scene: tok?.parent?.id ?? null, token: tok?.id ?? null, actor: item.actor?.id ?? null } });
    msg.timestamp = Date.now();
    if (seed) Hooks.call("preCreateChatMessage", msg, {}, {}, author.id);
    msg.isAuthor = true;
    msg.author = author;
    msg._source.author = author.id;
    messages.set(msg.id, msg);
    setUser(gm);
    author.targets = new Set();
    Hooks.callAll("createChatMessage", msg, {}, author.id);
    return msg;
  }
  async function use12(item, opts) {
    const msg = card12(item, opts);
    await idle();
    await settleAll();
    return messages.get(msg.id) ?? msg;
  }
  const opOf = (msg, id) => getResolution(messages.get(msg.id) ?? msg)?.ops?.[id] ?? null;
  const hasWarning = (res, c) => (res.warnings ?? []).some(w => w.code === c);
  /** A second token of the linked NPC Stabby (place() rebinds the actor's token: given back). */
  function secondStabby() {
    const t = place(START, stabby, "Stabby (2)", 10, 9, { linked: true });
    stabby.token = tStabby;
    return t;
  }
  function dropToken(t) {
    START.tokens.delete(t.id);
    registry.delete(t.uuid);
  }

  /* ======================================================================== */
  /*  H1: cardShape                                                           */
  /* ======================================================================== */
  {
    await fresh12();
    const legacy = [{ type: "abilityUse" }, { type: "abilityResult" }];
    assert.equal(readers.cardShape(legacy), "tierParts", "no targetResult part");
    assert.equal(readers.cardShape([...legacy, { type: "targetResult" }], { tokenField: true }), "targetResult");
    assert.equal(readers.cardShape([{ type: "targetResult" }], { tokenField: null }), "targetResult", "null (not applicable) is not false");
    assert.equal(readers.cardShape([{ type: "targetResult" }], { tokenField: false }), "unknown", "a build without tokenUuid");
    assert.equal(readers.cardShape([{ type: "targetResult" }]), "targetResult", "default: compat.targetTokenUuid");
    const msg = new Message({
      type: "standard",
      parts: {
        abilityUse000000: { _id: "abilityUse000000", type: "abilityUse", abilityUuid: borinStrike.uuid },
        trH1000000000001: { _id: "trH1000000000001", type: "targetResult", tier: 2, targetUuid: tWarrior.actor.uuid, tokenUuid: tWarrior.uuid, rolls: [new PowerRoll(10, { tier: 2 })] },
      },
    });
    assert.equal(readers.cardShape(Object.values(msg._source.system.parts)), readers.cardShape(msg.system.parts.contents), "source and live parts agree");
    const read = readers.readCard(msg);
    assert.equal(read.shape, "targetResult");
    assert.deepEqual(read.parts.map(p => [p.partId, p.tier, p.tokenUuid, p.actorUuids[0]]), [["trH1000000000001", 2, tWarrior.uuid, tWarrior.actor.uuid]]);
    console.log("ok H1 cardShape per card (source = live)");
  }

  /* ======================================================================== */
  /*  H2 + H36: two targets at tiers 1 and 3; untargeted 1.2 card              */
  /* ======================================================================== */
  {
    await fresh12();
    const sW = tWarrior.actor.system.stamina.value;
    const sA = tAssassin.actor.system.stamina.value;
    const eW = { token: tWarrior, tier: 1, damage: [3] };
    const eA = { token: tAssassin, tier: 3, damage: [8] };
    const msg = await use12(borinStrike, { entries: [eW, eA] });
    const res = getResolution(msg);
    assert.equal(res.shape, "targetResult");
    assert.deepEqual([res.targets[key(tWarrior)].tier, res.targets[key(tWarrior)].partId], [1, eW.partId]);
    assert.deepEqual([res.targets[key(tAssassin)].tier, res.targets[key(tAssassin)].partId], [3, eA.partId]);
    assert.deepEqual(res.targets[key(tAssassin)].damageRollIndexes, [1]);
    assert.ok(!("potencies" in res.targets[key(tWarrior)]), "potencies are read from the card, never stored");
    assert.ok(!hasWarning(res, "unsupportedShape") && !hasWarning(res, "ambiguousTier"));
    const dW = opOf(msg, `damage-${eW.partId}-1-${key(tWarrior)}`);
    const dA = opOf(msg, `damage-${eA.partId}-1-${key(tAssassin)}`);
    assert.deepEqual([dW?.amount, dW?.status, dA?.amount, dA?.status], [3, "applied", 8, "applied"]);
    assert.equal(tWarrior.actor.system.stamina.value, sW - 3);
    assert.equal(tAssassin.actor.system.stamina.value, sA - 8);
    assert.deepEqual(res.rollCounts, { [eW.partId]: 2, [eA.partId]: 2 });
    assert.equal(msg.updates, 1, "H36: one write per auto-resolution on a 1.2 card");
    // An untargeted 1.2 use still makes one abilityResult part (ability.mjs:646-671): read as on 1.1.2.
    const plain = await hit(borinStrike, [tWarrior], 2);
    assert.equal(getResolution(plain).shape, "tierParts");
    const solo = useCard(borinStrike, { amount: 4, natural: 12 });
    await idle();
    await settleAll();
    const soloRes = getResolution(messages.get(solo.id));
    assert.equal(soloRes.shape, "tierParts");
    assert.ok(!hasWarning(soloRes, "unsupportedShape"), "an untargeted card is no unknown shape");
    console.log("ok H2 per-target tiers and damage indexes; untargeted card as 1.1.2; H36 one write");
  }

  /* ======================================================================== */
  /*  H3 / H4: a linked actor with two tokens                                  */
  /* ======================================================================== */
  {
    await fresh12();
    const t2 = secondStabby();
    try {
      const e1 = { token: tStabby, tier: 2, damage: [2] };
      const e2 = { token: t2, tier: 3, damage: [5] };
      const msg = await use12(borinStrike, { entries: [e1, e2] });
      const res = getResolution(msg);
      assert.deepEqual([res.targets[key(tStabby)].tier, res.targets[key(tStabby)].partId], [2, e1.partId], "exact by token");
      assert.deepEqual([res.targets[key(t2)].tier, res.targets[key(t2)].partId], [3, e2.partId]);
      assert.ok(!res.targets[key(tStabby)].ambiguous && !hasWarning(res, "ambiguousTier"), "H3: not ambiguous");
      assert.ok(dmgOps(msg).every(o => o.mode === "auto" && o.status === "applied"));

      // H4: the same parts without tokenUuid (a third-party caller): ambiguous.
      const f1 = { token: tStabby, tier: 2, damage: [2] };
      const f2 = { token: t2, tier: 3, damage: [5] };
      const amb = await use12(borinStrike, { entries: [f1, f2], tokenless: true });
      const ra = getResolution(amb);
      assert.ok(ra.targets[key(tStabby)].ambiguous && ra.targets[key(t2)].ambiguous, "both ambiguous");
      assert.ok(hasWarning(ra, "ambiguousTier"));
      assert.ok(dmgOps(amb).length && dmgOps(amb).every(o => o.mode === "manual" && o.status === "pending"), "mixedTierSafety: auto rows manual");
      await set("mixedTierSafety", false);
      const g1 = { token: tStabby, tier: 2, damage: [2] };
      const g2 = { token: t2, tier: 3, damage: [5] };
      const loose = await use12(borinStrike, { entries: [g1, g2], tokenless: true });
      const rl = getResolution(loose);
      assert.deepEqual([rl.targets[key(tStabby)].tier, rl.targets[key(t2)].tier], [3, 3], "without the safety: the last part's tier");
      assert.ok(dmgOps(loose).every(o => o.mode === "auto"));
    } finally {
      await set("mixedTierSafety", saved.mixedTierSafety ?? true);
      dropToken(t2);
    }
    console.log("ok H3 exact per token / H4 tokenless ambiguous (safety on and off)");
  }

  /* ======================================================================== */
  /*  H5: a development build without the tokenUuid field                      */
  /* ======================================================================== */
  {
    await fresh12();
    compat.targetTokenUuid = false;
    const s0 = tWarrior.actor.system.stamina.value;
    const msg = await use12(borinStrike, { entries: [{ token: tWarrior, tier: 3, damage: [6] }] });
    const res = getResolution(msg);
    assert.equal(res.shape, "unknown");
    assert.ok(hasWarning(res, "unsupportedShape") && hasWarning(res, "devBuildPairing"), "both warnings");
    assert.ok(opsOf(msg).every(o => o.mode !== "auto" && o.status !== "applied"), "nothing automatic");
    assert.equal(tWarrior.actor.system.stamina.value, s0, "nothing applied");
    compat.targetTokenUuid = true;
    console.log("ok H5 dev build: unknown, manual, unsupportedShape + devBuildPairing");
  }

  /* ======================================================================== */
  /*  H6: seed and adoption keep token identity; spend from spendAmounts        */
  /* ======================================================================== */
  {
    await fresh12();
    const t2 = secondStabby();
    try {
      // Targets changed while the dialog was open: the author targets only the warrior now.
      const msg = await use12(borinStrike, {
        targets: [tWarrior], spendAmounts: { first: 2, second: 99 },
        entries: [{ token: tWarrior, tier: 2, damage: [1] }, { token: t2, tier: 2, damage: [1] }],
      });
      const res = getResolution(msg);
      assert.ok(res.targets[key(t2)]?.fromRoll, "the rolled token comes from tokenUuid");
      assert.ok(!res.targets[key(tStabby)], "not the actor's other token");
      assert.ok(hasWarning(res, "targetsChanged"));
      assert.deepEqual(res.spend, [2, 20], "spend from spendAmounts, clamped");
      // A card nobody seeded: the active GM adopts it, the token kept, the spend from the card.
      const adopted = await use12(borinStrike, { seed: false, author: player, targets: [], spendAmounts: { first: 3 }, entries: [{ token: t2, tier: 1, damage: [1] }] });
      const ra = getResolution(adopted);
      assert.ok(ra?.adopted, "adopted");
      assert.ok(ra.targets[key(t2)] && !ra.targets[key(tStabby)], "adoption keeps the token");
      assert.deepEqual(ra.spend, [3], "GM adoption: spend from the card");
      assert.equal(ra.shape, "targetResult");
    } finally {
      dropToken(t2);
    }
    console.log("ok H6 seed / adoption by tokenUuid, spendAmounts");
  }

  /* ======================================================================== */
  /*  H7: squad damage collapses across target parts                          */
  /* ======================================================================== */
  {
    await fresh12();
    const c = fight([tBorin, tSpine1, tSpine2, tSpine3], { groups: [{ name: "Spines", pool: 15, members: [tSpine1, tSpine2, tSpine3] }] });
    const grp = c.groups.contents[0];
    const calls = [];
    const orig = grp.system.takeDamage;
    grp.system.takeDamage = async function (minions, per, opts) {
      calls.push({ n: minions.length, per });
      return orig.call(this, minions, per, opts);
    };
    const msg = await use12(borinStrike, { entries: [tSpine1, tSpine2, tSpine3].map(token => ({ token, tier: 2, damage: [3] })) });
    const sq = dmgOps(msg).filter(o => o.group);
    assert.equal(sq.length, 1, "one squad op");
    assert.equal(sq[0].parts.length, 3, "every member's part kept");
    assert.deepEqual(sq[0].targetKeys.sort(), [tSpine1, tSpine2, tSpine3].map(key).sort());
    assert.equal(sq[0].status, "applied");
    assert.deepEqual(calls, [{ n: 3, per: 3 }], "one takeDamage(minions, amount)");
    assert.equal(grp.system.staminaValue, 15 - 9);
    // A member whose roll differs gets its own squad op.
    calls.length = 0;
    const mixed = await use12(borinStrike, { entries: [[tSpine1, 2], [tSpine2, 2], [tSpine3, 4]].map(([token, amount]) => ({ token, tier: 2, damage: [amount] })) });
    const sq2 = dmgOps(mixed).filter(o => o.group).sort((a, b) => a.amount - b.amount);
    assert.deepEqual(sq2.map(o => [o.amount, o.parts.length]), [[2, 2], [4, 1]]);
    assert.notEqual(sq2[0].opId, sq2[1].opId);
    // A 1.1.2 card keeps the per-part key (stored records stay valid).
    const legacy = await hit(borinStrike, [tSpine1, tSpine2], 1);
    const lsq = dmgOps(legacy).filter(o => o.group);
    assert.equal(lsq.length, 1);
    assert.match(lsq[0].opId, /^damage-tierResult000001-\d+-group-/);
    assert.ok(!("parts" in lsq[0]), "no parts on a 1.1.2 squad op");
    grp.system.takeDamage = orig;
    console.log("ok H7 squad collapse across parts (one takeDamage), differing roll split, 1.1.2 key kept");
  }

  /* ======================================================================== */
  /*  H8: a roll appended to one target's part                                 */
  /* ======================================================================== */
  {
    await fresh12();
    const eA = { token: tWarrior, tier: 2, damage: [2] };
    const eB = { token: tAssassin, tier: 2, damage: [3] };
    const msg = await use12(borinStrike, { entries: [eA, eB] });
    const partB = msg.system.parts.get(eB.partId);
    await msg.update({ [`system.parts.${eB.partId}.rolls`]: [...partB.rolls, new DamageRoll(4, { type: "" })] });
    await idle();
    await settleAll();
    const added = opsOf(msg).filter(o => o.reason === "addedRoll");
    assert.equal(added.length, 1, "one new row");
    assert.deepEqual([added[0].targetKeys, added[0].partId, added[0].rollIndex, added[0].mode, added[0].amount], [[key(tAssassin)], eB.partId, 2, "manual", 4]);
    assert.deepEqual(getResolution(messages.get(msg.id)).rollCounts, { [eA.partId]: 2, [eB.partId]: 3 });
    console.log("ok H8 appended roll: one manual addedRoll row for that target, rollCounts per part");
  }

  /* ======================================================================== */
  /*  H9: potencies                                                            */
  /* ======================================================================== */
  const PRE = "appPRE0000000009";
  const ham = attack(borin, "Hamstring Test", { dsid: "hamstring-test" });
  ham.system.power.effects.set(PRE, {
    id: PRE, type: "applied", name: "Slow",
    applied: { tier2: { potency: { characteristic: "might", value: "2" }, effects: { slowed: { condition: "failure", end: "turn", properties: new Set() } } } },
  });
  const mightOn = [tWarrior.actor, tAssassin.actor];
  for (const a of mightOn) {
    a.system.characteristics = { might: { value: 2, resist: 0 } };
    a.checkPotency = (v, c) => v > a.system.characteristics[c].value + a.system.characteristics[c].resist;
  }
  try {
    await fresh12();
    await set("conditionsMode", "manual");
    const eW = { token: tWarrior, tier: 2, potencies: { [PRE]: 1 } };
    const eA = { token: tAssassin, tier: 2 };
    const msg = await use12(ham, { entries: [eW, eA] });
    const idW = `condition-${eW.partId}-${PRE}-slowed-${key(tWarrior)}`;
    const idA = `condition-${eA.partId}-${PRE}-slowed-${key(tAssassin)}`;
    const oW = opOf(msg, idW);
    const oA = opOf(msg, idA);
    assert.deepEqual([oW.status, oW.potency.value, oW.potency.bonus, oW.potency.fails], ["pending", 3, 1, true], "value + 1: no longer resisted");
    assert.deepEqual([oA.status, oA.reason, oA.potency.value, "bonus" in oA.potency], ["skipped", "resisted", 2, false]);
    assert.ok(surges.potencySurgeable(oA), "resisted by one: our potency surge is possible");
    // The system's "Adjust potency" after the resolve: that target's waiting rows only, one record write.
    const before = structuredClone(oW);
    const n0 = msg.updates;
    await msg.update({ [`system.parts.${eA.partId}.potencies`]: { [PRE]: 1 } });
    await idle();
    await settleAll();
    const nA = opOf(msg, idA);
    assert.deepEqual([nA.status, nA.reason ?? null, nA.potency.value, nA.potency.bonus], ["pending", null, 3, 1], "re-planned");
    assert.deepEqual(opOf(msg, idW), before, "the other target's row untouched");
    assert.equal(msg.updates - n0, 2, "the system's write and one record write");
    assert.ok(!surges.potencySurgeable(nA), "an adjusted row takes no potency surge");
    borin.system.hero.surges = 4;
    await assert.rejects(engineMod.addSurge(messages.get(msg.id), idA, { potency: true, user: gm }), /potencyAdjusted/);
    assert.equal(borin.system.hero.surges, 4, "nothing paid");
    console.log("ok H9 potencies: bonus in the check, re-plan of that part's rows (one write), surge refused");
  } finally {
    for (const a of mightOn) {
      delete a.system.characteristics;
      delete a.checkPotency;
    }
    await set("conditionsMode", "auto");
  }

  /* ======================================================================== */
  /*  H10: natural-roll facts once per card                                    */
  /* ======================================================================== */
  {
    await fresh12();
    const msg = await use12(borinStrike, { natural: 19, entries: [tWarrior, tAssassin, tStabby].map(token => ({ token, tier: 3, damage: [1] })) });
    const facts = factsMod.rollFactsOf(msg);
    assert.equal(facts.length, 1, "one naturalRoll fact for three target parts");
    assert.deepEqual([facts[0].kind, facts[0].natural, facts[0].id], ["naturalRoll", 19, `roll:${msg.id}:0`]);
    const legacy = useCard(borinStrike, { targets: [tWarrior, tAssassin], tier: 3, amount: 1, natural: 19 });
    await idle();
    await settleAll();
    const lf = factsMod.rollFactsOf(messages.get(legacy.id));
    assert.deepEqual(lf.map(f => [f.natural, f.id]), [[19, `roll:${legacy.id}:0`]], "1.1.2: one per tier part, unchanged");
    console.log("ok H10 natural-roll facts once per 1.2 card");
  }

  /* ======================================================================== */
  /*  H11: per-part locks of the system's buttons                              */
  /* ======================================================================== */
  {
    await fresh12();
    const P = "partP00000000001";
    const Q = "partQ00000000001";
    const GAIN_PRE = "resPRE0000000001";
    const fake = (ops, type = "targetResult") => ({
      id: "fakeMessage00001", system: { parts: new Map([[P, { type }], [Q, { type }]]) },
      flags: { "stef-ds-automation": { resolution: { ops } } },
    });
    const btn = (attrs) => {
      const b = new El("button");
      for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
      return b;
    };
    const dom = (ids = [P, Q]) => {
      const root = new El("li");
      const out = { root };
      for (const id of ids) {
        const section = new El("section");
        section.setAttribute("data-message-part", id);
        out[id] = {
          d1: btn({ "data-action": "applyDamage", "data-index": "1" }),
          d2: btn({ "data-action": "applyDamage", "data-index": "2" }),
          slowed: btn({ "data-action": "applyEffect", "data-effect-id": "slowed", "data-uuid": `${ham.uuid}.PowerRollEffect.${PRE}` }),
          dazed: btn({ "data-action": "applyEffect", "data-effect-id": "dazed", "data-uuid": `${ham.uuid}.PowerRollEffect.${PRE}` }),
          gain: btn({ "data-action": "gainResource", "data-uuid": `${ham.uuid}.PowerRollEffect.${GAIN_PRE}` }),
        };
        section.append(...Object.values(out[id]));
        root.append(section);
      }
      return out;
    };
    const locked = (d) => Object.fromEntries([P, Q].filter(id => d[id]).map(id => [id, Object.entries(d[id]).filter(([, b]) => b.disabled).map(([k]) => k)]));
    // Damage of part P, roll index 1.
    let d = dom();
    let n = partLock.decoratePartButtons(fake({ a: { kind: "damage", status: "applied", partId: P, rollIndex: 1 } }), d.root);
    assert.equal(n, 1);
    assert.deepEqual(locked(d), { [P]: ["d1"], [Q]: [] });
    assert.ok(d[P].d1.classList.contains("ds-auto-locked") && d[P].d1.dataset.tooltip, "class and tooltip");
    // A condition of part P: that effect of that PRE only.
    d = dom();
    partLock.decoratePartButtons(fake({ c: { kind: "condition", status: "applied", partId: P, effectId: "slowed", preId: PRE } }), d.root);
    assert.deepEqual(locked(d), { [P]: ["slowed"], [Q]: [] });
    // A native resource row of part Q.
    d = dom();
    partLock.decoratePartButtons(fake({ r: { kind: "resource", native: true, status: "applied", partId: Q, preId: GAIN_PRE } }), d.root);
    assert.deepEqual(locked(d), { [P]: [], [Q]: ["gain"] });
    // Undone: the next render leaves everything enabled.
    d = dom();
    n = partLock.decoratePartButtons(fake({ a: { kind: "damage", status: "undone", partId: P, rollIndex: 1 } }), d.root);
    assert.equal(n, 0);
    assert.deepEqual(locked(d), { [P]: [], [Q]: [] });
    // A squad op locks every member's part.
    d = dom();
    partLock.decoratePartButtons(fake({ s: { kind: "damage", status: "applied", partId: P, rollIndex: 1, parts: [{ partId: P, rollIndex: 1 }, { partId: Q, rollIndex: 1 }] } }), d.root);
    assert.deepEqual(locked(d), { [P]: ["d1"], [Q]: ["d1"] });
    // Not a targetResult part: untouched (the 1.1.2 card keeps ui/gain-lock.mjs).
    d = dom();
    assert.equal(partLock.decoratePartButtons(fake({ a: { kind: "damage", status: "applied", partId: P, rollIndex: 1 } }, "abilityResult"), d.root), 0);
    // A real card through the render hook.
    partLock.registerPartLock();
    const eW = { token: tWarrior, tier: 2, damage: [1] };
    const eA = { token: tAssassin, tier: 2, damage: [1] };
    const msg = await use12(borinStrike, { entries: [eW, eA] });
    await engineMod.undoOps(messages.get(msg.id), [`damage-${eA.partId}-1-${key(tAssassin)}`]);
    await settleAll();
    const real = dom([eW.partId, eA.partId]);
    render(messages.get(msg.id), player, real.root);
    assert.ok(real[eW.partId].d1.disabled && !real[eA.partId].d1.disabled, "applied part locked, undone part open");
    console.log("ok H11 per-part locks (damage, condition, resource, undone, squad, render hook)");
  }

  /* ======================================================================== */
  /*  H12: modeByActorType                                                     */
  /* ======================================================================== */
  {
    // The resolver.
    assert.deepEqual([...cat.ACTOR_CATEGORIES], ["hero", "retainer", "npc", "minion", "summon", "object"]);
    assert.equal(cat.actorCategory(borin), "hero");
    assert.equal(cat.actorCategory(tWarrior.actor, tWarrior.uuid), "npc");
    assert.equal(cat.actorCategory(tSpine1.actor, tSpine1.uuid), "minion");
    assert.equal(cat.actorCategory({ type: "retainer" }), "retainer");
    assert.equal(cat.actorCategory({ type: "object" }), "object");
    assert.equal(cat.actorCategory({ type: "party" }), null);
    assert.equal(cat.typeOverride({ type: "retainer" }, null, { ...INHERIT, retainer: "manual" }, "inherit"), "manual");
    assert.equal(cat.typeOverride({ type: "object" }, null, { ...INHERIT, object: "prompt" }, "inherit"), "prompt");
    assert.equal(cat.typeOverride(borin, null, INHERIT, "manual"), "manual", "heroOverride fallback");
    assert.equal(cat.typeOverride(borin, null, { ...INHERIT, hero: "auto" }, "manual"), "auto", "the map wins over the fallback");
    assert.equal(cat.withTypeOverride("off", "auto"), "off");

    await fresh12();
    await byType({ npc: "prompt" });
    const m1 = await use12(borinStrike, { entries: [{ token: tWarrior, tier: 2, damage: [1] }, { token: tBen, tier: 2, damage: [1] }] });
    const byTarget = msg => Object.fromEntries(dmgOps(msg).map(o => [o.targetKeys[0], o.mode]));
    assert.deepEqual(byTarget(m1), { [key(tWarrior)]: "prompt", [key(tBen)]: "auto" }, "npc prompt, hero inherit");
    assert.deepEqual(getResolution(m1).modes.byType, { ...INHERIT, npc: "prompt" }, "snapshot");
    // Minion (the squad's member actor).
    await byType({ minion: "manual" });
    fight([tBorin, tSpine1, tSpine2], { groups: [{ name: "Spines", pool: 10, members: [tSpine1, tSpine2] }] });
    const m2 = await use12(borinStrike, { entries: [tSpine1, tSpine2].map(token => ({ token, tier: 2, damage: [1] })) });
    assert.deepEqual(dmgOps(m2).map(o => [o.mode, o.status]), [["manual", "pending"]]);
    // A summon of ours (token flag).
    await fresh12();
    await byType({ summon: "manual", npc: "auto" });
    const sum = place(START, warrior, "Summoned Goblin", 20, 20, { linked: false });
    sum._source.flags["stef-ds-automation"] = { summon: { summonId: "wpaSummon0000001" } };
    try {
      assert.equal(cat.actorCategory(sum.actor, sum.uuid), "summon");
      const m3 = await use12(borinStrike, { entries: [{ token: sum, tier: 2, damage: [1] }, { token: tWarrior, tier: 2, damage: [1] }] });
      assert.deepEqual(byTarget(m3), { [key(sum)]: "manual", [key(tWarrior)]: "auto" });
    } finally {
      dropToken(sum);
    }
    // heroOverride as the fallback while hero is inherit.
    await byType({});
    await set("heroOverride", "manual");
    const m4 = await use12(borinStrike, { entries: [{ token: tBen, tier: 2, damage: [1] }] });
    assert.deepEqual(dmgOps(m4).map(o => o.mode), ["manual"], "heroOverride fallback");
    await set("heroOverride", saved.heroOverride ?? "inherit");
    // The player cap still wins when stricter.
    await byType({ npc: "auto" });
    await set("playerAuthoredMode", "manual");
    const m5 = await use12(borinStrike, { author: player, entries: [{ token: tWarrior, tier: 2, damage: [1] }] });
    assert.deepEqual(dmgOps(m5).map(o => o.mode), ["manual"], "player cap");
    await set("playerAuthoredMode", saved.playerAuthoredMode ?? "inherit");
    // A feature that is off stays off.
    await set("damageMode", "off");
    const m6 = await use12(borinStrike, { entries: [{ token: tWarrior, tier: 2, damage: [1] }] });
    assert.equal(dmgOps(m6).length, 0, "damage off");
    await set("damageMode", "auto");
    // An explicit mode of api.applyDamage wins.
    await byType({ npc: "manual" });
    const s0 = tWarrior.actor.system.stamina.value;
    await api.applyDamage({ targets: [tWarrior.uuid], amount: 2, mode: "auto" });
    await settleAll();
    assert.equal(tWarrior.actor.system.stamina.value, s0 - 2, "api.applyDamage({mode: auto}) unaffected");
    // api.modeFor (WP-D wires it): category and mode.
    assert.deepEqual(cat.modeFor(tWarrior, "damage"), { category: "npc", mode: "manual" });
    assert.deepEqual(cat.modeFor(borin, "damage"), { category: "hero", mode: "auto" });
    await byType({});
    console.log("ok H12 modeByActorType (npc, hero, minion, summon, retainer, object, fallback, player cap, off, api)");
  }

  /* ======================================================================== */
  /*  H13: ongoing damage, zone hits, gains                                    */
  /* ======================================================================== */
  {
    await fresh12();
    await byType({ npc: "manual" });
    // Ongoing: a burning tick on an NPC.
    const c = fight([tBorin, tWarrior]);
    const [burn] = await tWarrior.actor.createEmbeddedDocuments("ActiveEffect", [{ name: "Burning", flags: { "stef-ds-automation": { ongoing: { formula: "3", type: "fire", when: "turnStart" } } } }]);
    burn.uuid = `${tWarrior.actor.uuid}.ActiveEffect.${burn.id}`;
    registry.set(burn.uuid, burn);
    const s0 = tWarrior.actor.system.stamina.value;
    let n = markMsgs();
    await activate(c, tWarrior);
    await settleAll();
    const ticks = since(n, m => !!getResolution(m)?.ongoing);
    assert.equal(ticks.length, 1, "a tick card");
    assert.deepEqual(dmgOps(ticks[0]).map(o => [o.mode, o.status]), [["manual", "pending"]], "npc manual: a manual tick");
    assert.equal(tWarrior.actor.system.stamina.value, s0);
    // ongoingDamage off stays off.
    await set("ongoingDamage", "off");
    await byType({ npc: "auto" });
    n = markMsgs();
    await activate(c, tWarrior);
    await settleAll();
    assert.equal(since(n, m => !!getResolution(m)?.ongoing).length, 0, "off: no tick");
    await set("ongoingDamage", saved.ongoingDamage ?? "auto");
    registry.delete(burn.uuid);

    // Zone hit.
    await fresh12();
    await byType({ npc: "manual" });
    const zmsg = useCard(wallOfFire, { author: player2 });
    await idle();
    await settleAll();
    regionClicks(player2, ...[[7, 3], [7, 4], [7, 5], [7, 6], [7, 7]].map(([x, y]) => cell(x, y)));
    const zop = zoneOp(messages.get(zmsg.id));
    await as(player2, () => placeMod.runZonePick({ message: messages.get(zmsg.id), res: getResolution(messages.get(zmsg.id)), op: zop, request: requestOp }));
    await idle();
    await settleAll();
    const zoneId = liveOp(zmsg, zop.opId)?.zoneId;
    assert.ok(zoneId, "a zone");
    const region = zoneReg.regionOfZone(zoneId);
    const s1 = tWarrior.actor.system.stamina.value;
    const h = await zoneEngine.hitZone(region, tWarrior, { via: "api", force: true });
    await settleAll();
    assert.ok(h?.messageId, "a zone hit card");
    assert.deepEqual(dmgOps(messages.get(h.messageId)).map(o => [o.mode, o.status]), [["manual", "pending"]], "npc manual: a manual hit");
    assert.equal(tWarrior.actor.system.stamina.value, s1);
    await set("zoneDamage", "off");
    await byType({ npc: "auto" });
    assert.equal(await zoneEngine.hitZone(region, tWarrior, { via: "api", force: true }), null, "zoneDamage off stays off");
    await set("zoneDamage", "auto");

    // Gains: a hero's gain row with hero prompt.
    assert.equal(gainsMod.gainMode({}, {}, { actor: borin, tokenDoc: tBorin }), "auto");
    await byType({ hero: "prompt" });
    assert.equal(gainsMod.gainMode({}, {}, { actor: borin, tokenDoc: tBorin }), "prompt", "stricter by type");
    assert.equal(gainsMod.gainMode({ confirm: true }, {}, { actor: borin, tokenDoc: tBorin }), "prompt");
    await fresh12();
    await byType({ hero: "prompt" });
    fight([tBorin, tWarrior]);
    const spear = itemOn(tWarrior, "Spear Charge");
    const msg = await hit(spear, tBorin, 2);
    const dmg = dmgOps(msg)[0];
    assert.equal(dmg.mode, "prompt", "the hero's damage row waits");
    await engineMod.applyOps(messages.get(msg.id), [dmg.opId]);
    await settleAll();
    const g = gainOps(messages.get(msg.id));
    assert.ok(g.length >= 1, "a gain row");
    assert.deepEqual([g[0].mode, g[0].status], ["prompt", "pending"], "hero prompt: the gain row waits");
    await byType({});
    console.log("ok H13 ongoing / zone hit / gain modes by type; off stays off");
  }

  /* ---------- restore ---------- */
  await fresh();
  if (saved.modeByActorType === undefined) await set("modeByActorType", undefined);
  else await set("modeByActorType", saved.modeByActorType);
  compat.targetResult = saved.targetResult;
  compat.targetTokenUuid = saved.targetTokenUuid;
  if (!hadMP) delete ds.CONFIG.MessagePart.targetResult;
  if (!hadTR) delete mp.TargetResult;
  if (!hadAU) delete mp.AbilityUse;
  borin.items.delete(ham.id);
  registry.delete(ham.uuid);
}
