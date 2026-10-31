// WP-B scenarios of Milestone 8 (docs/M8-DESIGN.md §12.1 H14-H17): compat probes, exit cleanup modes, native summons
// on 1.2, the relay's new actions and localized selfCheck problems. Run: `node harness11.mjs wp-b`.
// Extra mocks (installed here, restored at the end): Combat classes with a 1.1.2-style and a 1.2-style `_onExit`,
// `BaseEffectModel#rollSave` stubs with and without `.toMessage(`, `game.system.version` "1.1.2" / "1.2" / "1.2.0",
// the 1.2 target part schema, `AbilityModel#performSummon` (a system body that records its placeActor call),
// `summon` / `portfolioSummon` special effects, `_summonPortfolios`, an advancement with effects and a portfolio caller
// that charges the cost only for a non-empty array, `game.items.fromCompendium`, `_replaceDataRefs`.
export default async function (ctx) {
  const { mocks, assert, log, asUser } = ctx;
  const {
    imp, set, settle, settleAll, idle, view, clicks, START, tBen, benedikt, player, player2, gm, ability, cuuid, registry, messages,
    getResolution, buildView, requestOp, fight, cmbOf, notes, setActiveGM, setUser, relayed, ALL_USERS,
  } = mocks;
  const gate = await imp("compat/version-gate.mjs");
  const fixes = await imp("compat/system-fixes.mjs");
  const native = await imp("summons/native.mjs");
  const queries = await imp("relay/queries.mjs");
  const selfCheckMod = await imp("self-check.mjs");
  const { findWorldActor, summonSourceUuid } = await imp("summons/actors.mjs");
  const { registrations } = await imp("compat/lib-wrapper.mjs");
  const { UNTIL_EXPIRY } = await imp("constants.mjs");

  const saved = {
    version: game.system.version, combatClass: CONFIG.Combat.documentClass, ae: ds.data.ActiveEffect, mp: ds.CONFIG.MessagePart.targetResult,
    parts: { ...ds.data.pseudoDocuments.messageParts },
  };
  const restoreCompat = () => {
    game.system.version = saved.version;
    CONFIG.Combat.documentClass = saved.combatClass;
    if (saved.ae === undefined) delete ds.data.ActiveEffect;
    else ds.data.ActiveEffect = saved.ae;
    if (saved.mp === undefined) delete ds.CONFIG.MessagePart.targetResult;
    else ds.CONFIG.MessagePart.targetResult = saved.mp;
    ds.data.pseudoDocuments.messageParts = { ...saved.parts };
    gate.detectCompat();
  };

  /* ---------- H14 compat probes ---------- */
  {
    assert.equal(gate.paddedVersion("1.2"), "1.2.0");
    assert.equal(gate.paddedVersion("1.1.2"), "1.1.2");
    assert.equal(gate.paddedVersion("1.2.0.5"), "1.2.0");
    assert.equal(gate.paddedVersion(null), "0.0.0");
    game.system.version = "1.2";
    assert.equal(gate.systemVersionAtLeast("1.2.0"), true, "a 1.2 dev build is at least 1.2.0 (padded)");
    assert.equal(foundry.utils.isNewerVersion("1.2.0", "1.2"), true, "the raw compare that misled 0.9.x");
    game.system.version = "1.1.2";
    assert.equal(gate.systemVersionAtLeast("1.2.0"), false);

    // _onExit probes: the 1.1.x Set-of-characters bug, then 1.2's fixed body. The probe's `this` and actor are stubs.
    const seen = [];
    class Combat11 {
      async _onExit(combatant) {
        seen.push(this.id);
        const set = new Set("save", "combatEnd");
        const del = combatant.actor.effects.filter(e => e.duration.expired || (set.has(e.duration.expiry) && e._source.start.combat === this.id));
        combatant.actor.deleteEmbeddedDocuments("ActiveEffect", del.map(e => e.id));
      }
    }
    class Combat12 {
      async _onExit(combatant) {
        seen.push(this.id);
        const actor = combatant.actor;
        if (!actor) return;
        const combatEvents = new Set(["save", "combatEnd", "roundStart", "roundEnd", "turnStart", "turnEnd"]);
        const toDelete = actor.effects.filter(e => e.duration.expired || (combatEvents.has(e.duration.expiry) && (e._source.start.combat === this.id)));
        actor.deleteEmbeddedDocuments("ActiveEffect", toDelete.map(e => e.id));
      }
    }
    CONFIG.Combat.documentClass = Combat11;
    assert.equal(gate.probeExitSetBug(), true, "1.1.2-style _onExit: bug present");
    CONFIG.Combat.documentClass = Combat12;
    assert.equal(gate.probeExitSetBug(), false, "1.2-style _onExit: fixed");
    assert.deepEqual(seen, [gate.PROBE_COMBAT_ID, gate.PROBE_COMBAT_ID], "the probe runs on a stub combat only");
    CONFIG.Combat.documentClass = class { async _onExit() { throw new Error("boom"); } };
    assert.equal(gate.probeExitSetBug(), true, "an async throw is a promise: nothing deleted, caught");
    CONFIG.Combat.documentClass = class { _onExit() { throw new Error("sync boom"); } };
    assert.equal(gate.probeExitSetBug(), false, "a synchronous throw: no verdict, no fix");
    CONFIG.Combat.documentClass = saved.combatClass;

    // rollSave probes.
    ds.data.ActiveEffect = { BaseEffectModel: class { async rollSave() { const roll = { toMessage: async () => null }; return roll.toMessage({}); } } };
    assert.equal(gate.probeSaveThroughToMessage(), true, "rollSave with .toMessage(");
    ds.data.ActiveEffect = { BaseEffectModel: class { async rollSave() { return ChatMessage.create({}); } } };
    assert.equal(gate.probeSaveThroughToMessage(), false, "rollSave without .toMessage(");
    game.system.version = "1.2";
    assert.equal(gate.detectCompat().saveMessageBug, false, "version 1.2 with a fixed rollSave: no save fix");
    delete ds.data.ActiveEffect;
    assert.equal(gate.detectCompat().saveMessageBug, false, "version 1.2 without the method: the padded version decides (no fix)");
    game.system.version = "1.1.2";
    assert.equal(gate.detectCompat().saveMessageBug, true, "1.1.2 without the method: fallback keeps the fix");

    // New 1.2 probes.
    game.system.version = "1.2";
    let c = gate.detectCompat();
    assert.equal(c.devBuild, true);
    assert.equal(c.systemVersionPadded, "1.2.0");
    assert.equal(c.targetTokenUuid, null, "no targetResult part: not applicable");
    assert.ok(!("utilsPerformSummon" in c), "the dead probe is gone");
    ds.CONFIG.MessagePart.targetResult = class {};
    ds.data.pseudoDocuments.messageParts.TargetResult = { schema: { fields: { tokenUuid: {} } } };
    ds.data.pseudoDocuments.messageParts.AbilityUse = { schema: { fields: { spendAmounts: {} } } };
    c = gate.detectCompat();
    assert.equal(c.targetTokenUuid, true);
    assert.equal(c.abilityUseSpend, true);
    ds.data.pseudoDocuments.messageParts.TargetResult = { schema: { fields: {} } };
    c = gate.detectCompat();
    assert.equal(c.targetTokenUuid, false, "a 1.2 dev build without the field");
    const sc = asUser(gm, () => selfCheckMod.selfCheck());
    assert.ok(sc.problemKeys.some(p => p.key === "DSAUTO.SelfCheck.devBuild"), "selfCheck names the dev build");
    assert.match(sc.report.cardShape, /^unknown/);
    game.system.version = "1.2.0";
    assert.equal(gate.detectCompat().devBuild, false);
    restoreCompat();
    assert.equal(gate.compat.setBugsPresent, true, "harness Combat: an empty _onExit misses everything");
    console.log("ok H14 compat probes: padding, _onExit and rollSave by behaviour, 1.2 probes, utilsPerformSummon gone");
  }

  /* ---------- H15 exit cleanup modes ---------- */
  {
    class EffColl extends Map {
      filter(fn) { return [...this.values()].filter(fn); }
      get contents() { return [...this.values()]; }
    }
    const mkEff = (id, expiry, combat, expired = false) => ({ id, duration: { expiry, expired }, _source: { start: { combat } } });
    const mkActor = combatId => {
      const effects = new EffColl([
        ["turnEnd000000001", mkEff("turnEnd000000001", "turnEnd", combatId)],
        ["until00000000001", mkEff("until00000000001", UNTIL_EXPIRY, combatId)],
        ["otherCombat00001", mkEff("otherCombat00001", "save", "someOtherCombat0")],
        ["expired000000001", mkEff("expired000000001", "turnEnd", combatId, true)],
      ]);
      const deleted = [];
      return {
        uuid: "Actor.wpbExit000000001", name: "Exit test", effects, deleted,
        async deleteEmbeddedDocuments(_t, ids) {
          for (const id of ids) effects.delete(id);
          deleted.push(...ids);
          return [];
        },
      };
    };
    assert.deepEqual(fixes.installedFixes.exitCleanup, { installed: true, mode: "full" }, "harness Combat (bug present): full mode");
    const a = mkActor("combatWpb0000001");
    assert.deepEqual(fixes.missedExitEffects(a, "combatWpb0000001", "full").map(e => e.id).sort(), ["turnEnd000000001", "until00000000001"]);
    assert.deepEqual(fixes.missedExitEffects(a, "combatWpb0000001", "untilOnly").map(e => e.id), ["until00000000001"]);

    // Full mode through the installed wrapper: everything the (buggy) system missed goes after the delay.
    const full = mkActor("combatWpbFull001");
    const combat11 = Object.assign(new CONFIG.Combat.documentClass(), { id: "combatWpbFull001" });
    await asUser(gm, () => combat11._onExit({ actor: full }));
    await settle(fixes.EXIT_DELETE_DELAY_MS + 100);
    assert.deepEqual(full.deleted.sort(), ["turnEnd000000001", "until00000000001"], "1.1.2: the full list deleted after the delay");

    // 1.2: a fixed _onExit; the wrapper still installs (D8) and deletes only our until effects.
    class Combat12 {
      async _onExit(combatant) {
        const actor = combatant.actor;
        const ev = new Set(["save", "combatEnd", "roundStart", "roundEnd", "turnStart", "turnEnd"]);
        actor.deleteEmbeddedDocuments("ActiveEffect", actor.effects.filter(e => e.duration.expired || (ev.has(e.duration.expiry) && e._source.start.combat === this.id)).map(e => e.id));
      }
    }
    game.system.version = "1.2.0";
    ds.data.ActiveEffect = { BaseEffectModel: class { async rollSave() { return null; } } };
    CONFIG.Combat.documentClass = Combat12;
    gate.detectCompat();
    assert.equal(gate.compat.setBugsPresent, false);
    const before = registrations.length;
    fixes.registerSystemFixes();
    assert.deepEqual(fixes.installedFixes.exitCleanup, { installed: true, mode: "untilOnly" });
    assert.equal(registrations.length, before + 1, "only the exit wrapper registers (the save fix is not needed, never twice)");
    const fixed = mkActor("combatWpb12x0001");
    const combat12 = Object.assign(new Combat12(), { id: "combatWpb12x0001" });
    await asUser(gm, () => combat12._onExit({ actor: fixed }));
    assert.deepEqual(fixed.deleted.sort(), ["expired000000001", "turnEnd000000001"], "the system's own pass");
    await settle(fixes.EXIT_DELETE_DELAY_MS + 100);
    assert.deepEqual(fixed.deleted.sort(), ["expired000000001", "turnEnd000000001", "until00000000001"], "1.2: only our until effect added");
    // The probe through our wrapper schedules nothing.
    assert.equal(gate.probeExitSetBug(), false);
    const sc = asUser(gm, () => selfCheckMod.selfCheck());
    assert.equal(sc.report.fixExitCleanupMode, "untilOnly");
    assert.equal(sc.report.fixExitCleanup, true);
    // Back to the harness's 1.1.2 world: the mode follows, nothing wraps twice.
    restoreCompat();
    fixes.registerSystemFixes();
    assert.equal(registrations.length, before + 1, "re-registration on a wrapped class wraps nothing");
    assert.deepEqual(fixes.installedFixes.exitCleanup, { installed: true, mode: "full" });
    console.log("ok H15 exit cleanup: full list on 1.1.2, until effects only on a fixed _onExit, selfCheck mode");
  }

  /* ---------- H16-H17 native summons ---------- */
  const placeActorCalls = [];
  const Model = ds.data.Item.AbilityModel;
  const hadMethod = Object.prototype.hasOwnProperty.call(Model.prototype, "performSummon");
  assert.equal(gate.detectCompat().performSummon, false);
  assert.equal(native.registerNativeSummon(), false, "1.1.2: no performSummon, no wrapper");
  assert.equal(native.nativeSummonStatus(), "not needed");
  // The system's AbilityModel#performSummon (R/data/item/ability.mjs:966-1001) as far as it matters: placeActor.
  Model.prototype.performSummon = async function (uuid, { count = 1, effects = [] } = {}) {
    placeActorCalls.push({ user: game.user?.id ?? null, uuid, count, effects: effects.length, item: this.parent?.uuid ?? null });
    return Array.from({ length: count }, (_v, k) => ({ id: `systemToken${k}`, uuid: `Scene.x.Token.systemToken${k}` }));
  };
  gate.detectCompat();
  assert.equal(gate.compat.performSummon, true);
  assert.equal(native.registerNativeSummon(), true, "MIXED wrapper registered");
  assert.ok(globalThis.libWrapper.registered.some(r => r.target === "ds.data.Item.AbilityModel.prototype.performSummon" && r.type === "MIXED"));
  assert.equal(native.nativeSummonStatus(), "installed");
  /** The system's special effect calls `this.parent.performSummon(...)` with `this.parent` = the AbilityModel. */
  const systemSummon = (user, item, uuid, opts) => asUser(user, () => Model.prototype.performSummon.call({ parent: item }, uuid, opts));
  /** PortfolioSummonSpecialEffect#performSummon after its dialog: the cost only for a non-empty array. */
  const portfolioCaller = async (user, item, uuid, { count, effects, cost }) => {
    const tokens = await systemSummon(user, item, uuid, { count, effects });
    if (tokens?.length) item.actor.system.hero.primary.value -= cost;
    return tokens;
  };
  // Effects, rollData references and the item collection of 1.2.
  const prevItems = game.items;
  game.items = { fromCompendium: (doc, opts = {}) => ({ ...JSON.parse(JSON.stringify({ name: doc.name, type: "base", system: doc.system })), ...(opts.keepId ? { _id: doc.id } : {}) }) };
  CONFIG.ActiveEffect ??= {};
  const prevAE = CONFIG.ActiveEffect.documentClass;
  CONFIG.ActiveEffect.documentClass = class extends (prevAE ?? class {}) {
    static _replaceDataRefs(value, data) { return String(value).replace(/@([\w.]+)/g, (_m, p) => String(foundry.utils.getProperty(data, p) ?? 0)); }
  };
  const effUuid = "Compendium.draw-steel.abilities.Item.portEff000000001.ActiveEffect.effA000000000001";
  const strayUuid = "Compendium.draw-steel.abilities.Item.portEff000000001.ActiveEffect.effB000000000001";
  registry.set(effUuid, { uuid: effUuid, id: "effA000000000001", name: "Sharp Teeth", system: { changes: [{ key: "system.might", mode: 2, value: "@chr" }] } });
  registry.set(strayUuid, { uuid: strayUuid, id: "effB000000000001", name: "Stray", system: { changes: [] } });
  registry.set("Item.adv0000000000001.Advancement.adv1", { effects: [{ uuid: effUuid, level: 1 }] });

  // An ability with a summon effect (pool: one Goblin Runner, count 1) and one with a portfolio summon.
  const callRunner = ability(benedikt, "Call Runner", { distance: { type: "ranged", primary: 5 } });
  callRunner.system.effects = { contents: [{ id: "sumEffect0000001", type: "summon", summoning: { pool: new Set([cuuid("runner")]), count: 1 } }] };
  const portfolio = ability(benedikt, "Call Portfolio", { distance: { type: "ranged", primary: 5 }, dsid: "call-portfolio" });
  portfolio.system.effects = { contents: [{ id: "portEffect000001", type: "portfolioSummon" }] };
  benedikt.system._summonPortfolios = { "call-portfolio": [{ uuid: cuuid("hyena"), cost: 2, count: null, advancementUuid: "Item.adv0000000000001.Advancement.adv1" }] };
  const nativeCards = () => messages.contents.filter(m => getResolution(m)?.itemUuid && getResolution(m)?.native);
  const lastCard = () => nativeCards().at(-1) ?? null;
  const summonOpOf = m => Object.values(getResolution(m)?.ops ?? {}).find(o => o.kind === "summon") ?? null;
  const warned = (user, re) => notes.some(n => n.user === user.id && n.kind === "warn" && re.test(n.text));
  await set("summonInterceptNative", true);

  /* H16: a player clicks the system's Summon. */
  {
    const combat = fight([tBen]);
    view(player, START);
    clicks(player, { x: 7, y: 4 });
    const out = await systemSummon(player, callRunner, cuuid("runner"), { count: 1 });
    await settleAll();
    assert.equal(placeActorCalls.length, 0, "the system's placeActor never ran");
    assert.equal(relayed("nativeSummon").length, 1, "one relayed nativeSummon");
    assert.ok(Array.isArray(out) && out.length === 1, "the wrapper resolves one TokenDocument");
    const tok = out[0];
    const flag = tok.flags?.["stef-ds-automation"]?.summon;
    assert.ok(flag?.summonId, "our summon flag");
    assert.equal(tok.x, 700);
    assert.equal(tok.y, 400);
    assert.equal(tok.disposition, tBen.disposition, "friendly like the summoner");
    assert.equal(tok.delta?.ownership?.[player.id], 3, "owned by the summoner's player");
    const card = lastCard();
    assert.ok(card, "a native summon card");
    assert.equal(getResolution(card).abilityName, `DSAUTO.Card.Synthetic.nativeSummon ${JSON.stringify({ name: "Call Runner" })}`);
    const op = summonOpOf(card);
    assert.equal(op.status, "applied");
    assert.equal(op.native, true);
    assert.ok(!op.synthetic, "an own summon row (its owner may undo it)");
    assert.equal(op.turn, "after");
    assert.deepEqual(op.lasts, ["encounterEnd"]);
    assert.equal(op.squad, "join", "a minion stat block joins a squad");
    assert.deepEqual(op.tokenUuids, [tok.uuid]);
    const world = findWorldActor(cuuid("runner"), summonSourceUuid(callRunner));
    assert.ok(world && tok.actorId === world.id, "the world actor of the M6 key");
    assert.equal(world.flags?.["draw-steel"]?.summonSource, callRunner.uuid);
    const cb = combat.combatants.find(c => c.tokenId === tok.id);
    assert.ok(cb, "in the summoner's combat");
    assert.ok(cmbOf(combat, tBen), "summoner still there");
    assert.equal(getResolution(card).library, undefined, "no cost note without a portfolio");
    console.log("ok H16 native summon by a player: wrapper -> pick -> relay -> GM card applied, tokens owned, in combat, M6 world actor");
  }

  /* H17: edge cases. */
  {
    // Portfolio summon, cost 2, effects with @ references: charged only after a non-empty return.
    view(player, START);
    const focus = () => benedikt.system.hero.primary.value;
    const start = focus();
    const relaysBefore = relayed("nativeSummon").length;
    clicks(player, "esc");
    const cancelled = await portfolioCaller(player, portfolio, cuuid("hyena"), { count: 1, effects: [registry.get(effUuid)], cost: 2 });
    assert.equal(cancelled, null, "cancelled pick resolves null");
    assert.equal(focus(), start, "no cost on cancel");
    assert.equal(relayed("nativeSummon").length, relaysBefore, "no relay on cancel");
    clicks(player, { x: 7, y: 6 });
    const got = await portfolioCaller(player, portfolio, cuuid("hyena"), { count: 1, effects: [registry.get(effUuid)], cost: 2 });
    await settleAll();
    assert.equal(got?.length, 1);
    assert.equal(focus(), start - 2, "the portfolio cost charged after a non-empty return");
    const pcard = lastCard();
    const pop = summonOpOf(pcard);
    assert.equal(pop.status, "applied");
    const delta = got[0].delta;
    assert.equal(delta.effects?.length, 1, "the advancement effect in the token delta");
    assert.equal(delta.effects[0].system.changes[0].value, "2", "@chr replaced from the ability's roll data");
    assert.notEqual(delta.effects[0]._id, "effA000000000001", "a new id per token");
    assert.equal(getResolution(pcard).library?.notes, "DSAUTO.Summon.NativeCostNote", "cost note on the card");
    const banners = asUser(player, () => buildView(pcard, getResolution(pcard)).banners);
    assert.ok(banners.some(b => b.text === "DSAUTO.Summon.NativeCostNote"), "shown as a banner");

    // Undo by the owner: tokens gone, the cost stays paid (Q2).
    await asUser(player, () => requestOp({ action: "undo", messageId: pcard.id, opIds: [pop.opId] }));
    await settleAll();
    assert.equal(summonOpOf(messages.get(pcard.id)).status, "undone");
    assert.ok(!START.tokens.get(got[0].id), "undo deleted the token");
    assert.equal(focus(), start - 2, "no refund");

    // Refusals on the GM.
    const before = nativeCards().length;
    clicks(player, { x: 7, y: 6 });
    assert.equal(await systemSummon(player, callRunner, cuuid("vampire"), { count: 1 }), null);
    assert.ok(warned(player, /NativeSummonRefused/), "a stat block outside the pool is refused");
    clicks(player, { x: 7, y: 6 }, { x: 8, y: 6 });
    assert.equal(await systemSummon(player, callRunner, cuuid("runner"), { count: 2 }), null);
    clicks(player, { x: 7, y: 6 });
    assert.equal(await portfolioCaller(player, portfolio, cuuid("hyena"), { count: 1, effects: [registry.get(strayUuid)], cost: 2 }), null);
    assert.equal(focus(), start - 2, "a refused portfolio summon costs nothing");
    assert.equal(nativeCards().length, before, "no card for a refusal");
    assert.equal(notes.filter(n => n.user === player.id && /NativeSummonRefused/.test(n.text)).length, 3, "count above the effect's and a stray effect refused too");
    const payload = (extra = {}) => ({
      abilityUuid: callRunner.uuid, actorUuid: cuuid("runner"), count: 1, effectUuids: [], summonerTokenUuid: tBen.uuid,
      places: [{ x: 700, y: 600, elevation: 0, level: mocks.LEVEL, rotation: 0 }], ...extra,
    });
    await assert.rejects(asUser(player2, () => requestOp({ action: "nativeSummon", nativeSummon: payload() })), /DSAUTO.Relay.Denied/, "a non-owner is denied");
    await assert.rejects(asUser(player, () => requestOp({ action: "nativeSummon", nativeSummon: payload({ summonerTokenUuid: mocks.tBorin.uuid }) })), /DSAUTO.Relay.Denied/, "another actor's token");
    await assert.rejects(asUser(player, () => requestOp({ action: "nativeSummon", nativeSummon: payload({ count: 11 }) })), /DSAUTO.Relay.BadRequest/);
    await assert.rejects(asUser(player, () => requestOp({ action: "nativeSummon", nativeSummon: payload({ places: [] }) })), /DSAUTO.Relay.BadRequest/);
    await assert.rejects(asUser(player, () => requestOp({ action: "nativeSummon", nativeSummon: payload({ extra: 1 }) })), /DSAUTO.Relay.BadRequest/);

    // Setting off, no GM, module disabled: the system's own path.
    await set("summonInterceptNative", false);
    assert.equal(native.nativeSummonStatus(), "setting off");
    const sys1 = await systemSummon(player, callRunner, cuuid("runner"), { count: 1 });
    assert.equal(placeActorCalls.length, 1, "setting off: placeActor called");
    assert.equal(sys1?.[0]?.id, "systemToken0");
    await set("summonInterceptNative", true);
    setActiveGM(null);
    await systemSummon(player, callRunner, cuuid("runner"), { count: 1 });
    assert.equal(placeActorCalls.length, 2, "no GM: the system's path");
    setActiveGM(gm);
    // No summoner token on the viewed scene: a warning, nothing placed.
    view(player, mocks.OTHER);
    assert.equal(await systemSummon(player, callRunner, cuuid("runner"), { count: 1 }), null);
    assert.ok(warned(player, /NativeNoToken/), "NativeNoToken warning");
    view(player, START);
    assert.equal(placeActorCalls.length, 2);

    // The Director's own click: compendium previews (pickForApi), the same card.
    clicks(gm, { x: 8, y: 4 });
    const gmOut = await systemSummon(gm, callRunner, cuuid("runner"), { count: 1 });
    await settleAll();
    assert.equal(gmOut?.length, 1, "the Director's native summon");
    console.log("ok H17 native summon edges: portfolio cost only when placed, effects with @ replaced, refusals, denied, setting off / no GM -> system, undo keeps the cost");
  }

  /* ---------- relay endTargeted, relayErrorText, localized selfCheck ---------- */
  {
    assert.equal(queries.relayErrorText(new Error("group not created")), "DSAUTO.Relay.Failed", "a raw error reads as Relay.Failed");
    assert.equal(queries.relayErrorText(new Error("DSAUTO.Relay.Denied")), "DSAUTO.Relay.Denied");
    await assert.rejects(asUser(player, () => requestOp({ action: "endTargeted", endTargeted: { actorUuid: benedikt.uuid, statusId: "bad id!" } })), /DSAUTO.Relay.BadRequest/);
    let hasHandler = false;
    try {
      hasHandler = typeof (await imp("engine/targeted.mjs")).handleEndTargeted === "function";
    } catch (_err) { /* WP-C not landed */ }
    // A stranger (player2 owns neither Benedikt nor the source) below the role floor.
    const stranger = asUser(player2, () => requestOp({ action: "endTargeted", endTargeted: { actorUuid: benedikt.uuid, statusId: "frightened" } }));
    await assert.rejects(stranger, hasHandler ? /DSAUTO.Relay.Denied/ : /DSAUTO.Relay.BadRequest/);
    const { mayEndTargeted, mayNativeSummon } = await imp("relay/auth.mjs");
    assert.equal(mayEndTargeted(player, benedikt), true, "the affected actor's owner");
    assert.equal(mayEndTargeted(player2, benedikt, mocks.borin), true, "the source's owner");
    assert.equal(mayEndTargeted(player2, benedikt), false);
    assert.equal(mayEndTargeted(gm, benedikt), true);
    assert.equal(mayNativeSummon(player, callRunner, tBen), true);
    assert.equal(mayNativeSummon(player, callRunner, mocks.tBorin), false);
    assert.equal(queries.timeoutFor("nativeSummon") >= 300_000, true, "a long action (the GM may wait on a card lock)");

    const { problemText, PROBLEM_TEXT } = selfCheckMod;
    assert.equal(problemText({ id: "gridDistance", key: "DSAUTO.SelfCheck.gridDistance", data: { distance: 5, units: " ft" } }),
      PROBLEM_TEXT.gridDistance.replace("{distance}", "5").replace("{units}", " ft"), "English fallback with placeholders");
    const prevHas = game.i18n.has;
    game.i18n.has = k => k.startsWith("DSAUTO.SelfCheck.");
    assert.equal(problemText({ id: "wrappers", key: "DSAUTO.SelfCheck.wrappers", data: { list: "x" } }), `DSAUTO.SelfCheck.wrappers ${JSON.stringify({ list: "x" })}`, "game.i18n.format when the key exists");
    await set("targetedConditions", "native");
    const sc = asUser(gm, () => selfCheckMod.selfCheck());
    assert.ok(sc.problemKeys.some(p => p.key === "DSAUTO.SelfCheck.nativeWithDsct"), "native with Combat Tools conditions on");
    assert.ok(sc.problems.includes(`DSAUTO.SelfCheck.nativeWithDsct ${JSON.stringify(sc.problemKeys.find(p => p.key === "DSAUTO.SelfCheck.nativeWithDsct").data)}`), "problems are the localized texts");
    assert.equal(sc.report.nativeSummonWrapper, "installed");
    assert.ok(!("utilsPerformSummon" in sc.report));
    if (prevHas === undefined) delete game.i18n.has;
    else game.i18n.has = prevHas;
    await set("targetedConditions", "auto");
    console.log("ok relay endTargeted (shape, auth), relayErrorText -> Relay.Failed, selfCheck problems {key, data} localized with English fallback");
  }

  /* ---------- restore ---------- */
  if (!hadMethod) delete Model.prototype.performSummon;
  gate.detectCompat();
  game.items = prevItems;
  CONFIG.ActiveEffect.documentClass = prevAE;
  delete benedikt.system._summonPortfolios;
  callRunner.actor.items.delete(callRunner.id);
  portfolio.actor.items.delete(portfolio.id);
  setUser(gm);
  for (const u of ALL_USERS) u.active = true;
  void log;
  void idle;
}
