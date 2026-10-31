// M9 WP-C scenarios (P1-P12): generic Persistent upkeep of ability
// uses. Run by harness11 (`node harness11.mjs persistent`, or `node harness16.mjs`). Extra mocks (installed here,
// removed at the end): Elsa's The Flesh, a Crucible / No More Than a Breeze / The Green Defends Its Servants / Swarm of
// Spirits items with the system's `persistent` special effect and their own ActiveEffects (a `clone` as core's), an
// `AbilityModel#use` that records its `dialogOptions` / `messageOptions` and posts the card the system would (on the
// calling client, resolved by the active GM), a recording `canvas.tokens.setTargets`, the ActiveEffect document class
// (`getEffectStart`) and `ForcedReplacement` (the aura state write).
export default async function (ctx) {
  const { mocks, assert, log } = ctx;
  const {
    imp, Effect, Message, set, settleAll, advance, as, asGM, gm, player, elsa, tElsa, tWarrior, tAssassin, tBen, benedikt, G,
    fight, activate, endTurn, nextRound, attack, ability, useCard, getResolution, messages, notes, dialogs, upkeepDialogs,
    setAnswer, mclock, api, engineMod,
  } = mocks;
  const schema = await imp("library/schema.mjs");
  const { resolveAbility } = await imp("library/resolve.mjs");
  const reg = await imp("persistent/registry.mjs");
  const upkeep = await imp("persistent/upkeep.mjs");
  const reroll = await imp("persistent/reroll.mjs");
  const { untilSpecs } = await imp("turn/until.mjs");
  const { promptTypes } = await imp("relay/prompt-router.mjs");
  const MOD = "stef-ds-automation";
  const restore = [];

  try {
    /* ---------- extra mocks ---------- */
    if (!CONFIG.ActiveEffect.documentClass) {
      CONFIG.ActiveEffect.documentClass = { getEffectStart: () => ({ combat: null, combatant: null, round: null, turn: null }) };
      restore.push(() => { delete CONFIG.ActiveEffect.documentClass; });
    }
    if (!foundry.data.operators.ForcedReplacement) {
      foundry.data.operators.ForcedReplacement = { create: v => v };
      restore.push(() => { delete foundry.data.operators.ForcedReplacement; });
    }
    const targeted = [];   // canvas.tokens.setTargets calls {user, ids}
    const baseSetTargets = canvas.tokens.setTargets;
    canvas.tokens.setTargets = (ids) => { targeted.push({ user: game.user?.id, ids: [...ids] }); };
    restore.push(() => { canvas.tokens.setTargets = baseSetTargets; });

    /** The system's Persistent special effect on an item (DSM PersistentSpecialEffect). */
    const persistentEffect = (item, essence) => {
      const all = [{ id: "persistent000000", type: "persistent", essence }];
      item.system.effects = { contents: all, get: id => all.find(e => e.id === id) ?? null };
    };
    /** One of the item's own ActiveEffects (core's clone / toObject). */
    const ownEffect = (item, id, name) => {
      item.effects.set(id, {
        id, name,
        clone(_data, { keepId = false } = {}) {
          return { toObject: () => ({ ...(keepId ? { _id: id } : {}), name, origin: item.uuid, statuses: [], duration: {}, flags: {} }) };
        },
      });
    };
    const flesh = attack(elsa, "The Flesh, a Crucible", { dsid: "the-flesh-a-crucible", distance: { type: "ranged", primary: 10 }, keywords: ["magic", "ranged", "strike", "fire"] });
    persistentEffect(flesh, 1);
    const breeze = ability(elsa, "No More Than a Breeze", { dsid: "no-more-than-a-breeze", type: "maneuver", target: { type: "selfOrAlly" } });
    persistentEffect(breeze, 1);
    ownEffect(breeze, "LA17VDt3bDbNwIJs", "No More Than a Breeze");
    const green = ability(elsa, "The Green Defends Its Servants", { dsid: "the-green-defends-its-servants", type: "maneuver", target: { type: "selfOrAlly" } });
    persistentEffect(green, 2);
    ownEffect(green, "Bs1Ant6ozienc9Hx", "Elemental Shield");
    const swarm = attack(elsa, "Swarm of Spirits", { dsid: "swarm-of-spirits", distance: { type: "aura", primary: 3 }, keywords: ["area", "magic", "green"] });
    persistentEffect(swarm, 1);
    ownEffect(swarm, "BE6pdvzaGxrzjtCH", "Swarm of Spirits");
    restore.push(() => { for (const it of [flesh, breeze, green, swarm]) elsa.items.delete(it.id); });

    /** A card of `item` posted on `author`'s client (seeded there), resolved by the active GM: no roll with `noRoll`. */
    const cardAs = (author, item, { targets = [], tier = 2, amount = 1, flags = {}, noRoll = false } = {}) => {
      const tok = tElsa;
      const parts = { abilityUse000000: { _id: "abilityUse000000", type: "abilityUse", abilityUuid: item.uuid } };
      if (!noRoll) {
        const rolls = targets.map(t => new ds.rolls.PowerRoll(10, { target: t.actor.uuid, tier }));
        if (amount != null) rolls.push(new ds.rolls.DamageRoll(amount, { type: "" }));
        parts.tierResult000001 = { _id: "tierResult000001", type: "abilityResult", tier, rolls };
      }
      const msg = new Message({ type: "standard", parts, flags, speaker: { scene: tok.parent.id, token: tok.id, actor: item.actor.id } });
      author.targets = new Set(targets.map(t => t.object));
      as(author, () => Hooks.call("preCreateChatMessage", msg, {}, {}, author.id));
      author.targets = new Set();
      msg.isAuthor = true;
      msg.author = author;
      msg._source.author = author.id;
      messages.set(msg.id, msg);
      asGM(() => Hooks.callAll("createChatMessage", msg, {}, author.id));
      return msg;
    };
    // AbilityModel#use as the system: the dialog's resource is what it spends, messageOptions.data merges into the card.
    const uses = [];
    let useAnswer = "card";   // "card" | "cancel"
    for (const item of [flesh, swarm]) {
      item.system.use = async (config = {}, dialogOptions = {}, messageOptions = {}) => {
        const last = targeted.filter(t => t.user === game.user?.id).at(-1)?.ids ?? [];
        uses.push({ item: item.name, user: game.user?.id, config, resource: dialogOptions?.context?.resource?.value, flags: messageOptions?.data?.flags ?? null, ids: last });
        if (useAnswer === "cancel") return null;
        const tokens = last.map(id => tElsa.parent.tokens.get(id)).filter(Boolean);
        return cardAs(game.user, item, { targets: tokens, flags: messageOptions?.data?.flags ?? {} });
      };
    }
    const entries = c => reg.persistentEntries(c);
    const entry = (c, msg) => reg.rawEntry(c, msg.id ?? msg);
    const live = msg => messages.get(msg.id) ?? msg;
    const notesOf = (kind, msg = null) => [...messages.values()].filter(m => m.flags?.[MOD]?.persistentNote?.kind === kind
      && (!msg || m.flags[MOD].persistentNote.messageId === (msg.id ?? msg)));
    const keepCards = since => [...messages.values()].slice(since).filter(m => getResolution(m)?.persistent?.upkeep);
    const answer = outcome => setAnswer(rec => (rec.kind === "upkeep" ? outcome : undefined));
    const essence = () => elsa.system.hero.primary.value;
    const childOf = (c, msg) => entries(c).find(e => e.parent === (msg.id ?? msg)) ?? null;

    /* ======================================================================== */
    /*  P1: schema, normalize, resolve                                           */
    /* ======================================================================== */
    {
      const base = { key: "ability:the-flesh-a-crucible", version: "1.0.0", name: "The Flesh, a Crucible", effects: [] };
      const ok = o => schema.validateOverlay(o).ok;
      const errs = o => schema.validateOverlay(o).errors.join(" | ");
      assert.ok(ok({ ...base, persistent: { keep: "reroll" } }), "reroll alone may have effects: []");
      assert.ok(!ok({ ...base, persistent: { keep: "manual", note: "x" } }), "manual automates nothing (rule 4)");
      assert.match(errs({ ...base, effects: [{ id: "n", type: "note", text: "x" }], persistent: { keep: "manual" } }), /needs a `note`/);
      assert.match(errs({ ...base, persistent: { keep: ["reroll", "manual"] } }), /stands alone/);
      assert.match(errs({ ...base, persistent: { keep: ["reroll", "reroll"] } }), /twice/);
      assert.match(errs({ ...base, persistent: { keep: "reroll", cost: 11 } }), /cost/);
      assert.match(errs({ ...base, persistent: { keep: "reroll", foo: 1 } }), /unknown field "foo"/);
      assert.match(errs({ ...base, persistent: { keep: "extend", targets: "area" } }), /goes with `keep: "reroll"`|needs a condition/);
      assert.match(errs({ ...base, persistent: { keep: "extend" } }), /needs a condition effect with `until` or an aura/);
      assert.match(errs({ ...base, npc: true, persistent: { keep: "reroll" } }), /hero rule/);
      assert.match(errs({ ...base, effects: [{ id: "z", type: "zone", targets: "self", value: 1 }], persistent: { keep: "reroll" } }), /keeps itself/);
      assert.ok(ok({ ...base, effects: [{ id: "c", type: "condition", status: "slowed", until: "yourNextTurnStart" }], persistent: { keep: "extend" } }));
      assert.ok(ok({ ...base, automation: { version: 1, aura: { end: "sourceNextTurnEnd" }, rules: [] }, persistent: { keep: ["reroll", "extend"], targets: "area" } }), "an aura can be held");
      const n = schema.normalizeOverlay({ ...base, persistent: { keep: "reroll" } });
      assert.deepEqual(n.persistent, { cost: null, keep: ["reroll"], targets: "recorded", note: null });
      assert.equal(schema.normalizeOverlay({ ...base, persistent: { keep: "extend" }, effects: [] }).persistent.targets, null);
      assert.equal(schema.persistentAutomates({ keep: "manual" }), false);
      const r = resolveAbility(flesh);
      assert.deepEqual(r.persistent?.keep, ["reroll"], "resolveAbility exposes the overlay's persistent");
      assert.equal(r.status, "automated");
      assert.equal(reg.persistentCost(flesh), 1, "the item's own Persistent essence");
      assert.equal(reg.keepKeyOf(["reroll", "extend"]), "both");
      assert.ok(promptTypes().includes("persistentUpkeep") && promptTypes().includes("persistentUpkeepCancel"), "prompt types registered");
      console.log("ok P1 schema (fields, keep list, rule 4, hero only, no summon/zone, extend needs until or an aura), normalize, resolve");
    }

    /* ======================================================================== */
    /*  P2: the record and the index                                              */
    /* ======================================================================== */
    {
      // Outside combat: no record, no index.
      let msg = useCard(flesh, { author: player, targets: [tWarrior], amount: 1 });
      await settleAll();
      assert.equal(getResolution(live(msg)).persistent ?? null, null, "no combat: no record");
      const before = msg;
      const c = fight([tElsa, tWarrior]);
      await activate(c, tElsa);
      // Review fix: the card used before the encounter, resolved again in it (Use my targets / force), starts no chain.
      await api.resolve(before.id, { force: true });
      await settleAll();
      assert.equal(getResolution(live(before)).persistent ?? null, null, "a re-resolve never makes an old use Persistent");
      assert.equal(entries(c).length, 0, "and indexes nothing");
      // Setting off: none either.
      await set("persistentUpkeep", false);
      msg = useCard(flesh, { author: player, targets: [tWarrior], amount: 1 });
      await settleAll();
      assert.equal(getResolution(live(msg)).persistent ?? null, null, "setting off: no record");
      assert.equal(entries(c).length, 0, "setting off: no index");
      await set("persistentUpkeep", true);
      msg = useCard(flesh, { author: player, targets: [tWarrior], amount: 1 });
      await settleAll();
      const rec = getResolution(live(msg)).persistent;
      assert.deepEqual(rec, { cost: 1, keep: ["reroll"], targets: "recorded", note: null, parent: null, free: false, combatId: c.id });
      // A re-resolve keeps the record as it was (no new match, same combat).
      await api.resolve(msg.id, { force: true });
      await settleAll();
      assert.deepEqual(getResolution(live(msg)).persistent, rec, "re-resolve keeps the record");
      const e = entry(c, msg);
      assert.ok(e?.active, "indexed and active");
      assert.deepEqual(e.targetTokenUuids, [tWarrior.uuid]);
      assert.equal(e.combatantId, c.combatants.find(x => x.tokenId === tElsa.id).id);
      assert.equal(e.kept, 0);
      assert.equal(e.createdRound, 1);
      // A banner on the card.
      const view = mocks.viewOf10(msg);
      assert.ok(view.banners.some(b => /Card\.Persistent\.reroll/.test(b.text)), `the Persistent banner: ${view.banners.map(b => b.text).join(" / ")}`);
      // Its own turn end and a repeated start do not ask.
      await endTurn(c);
      assert.equal(upkeepDialogs().length, 0, "not asked in the turn of the use");
      console.log("ok P2 record {cost, keep, targets, note, parent, free} + index entry; none outside combat or with the setting off; banner");
    }

    /* ======================================================================== */
    /*  P3 / P4: keep -> free re-roll at the recorded target; the chain; release  */
    /* ======================================================================== */
    let c3;
    {
      await mocks.fresh();
      c3 = fight([tElsa, tWarrior]);
      await activate(c3, tElsa);
      const msg = useCard(flesh, { author: player, targets: [tWarrior], amount: 1 });
      await settleAll();
      await endTurn(c3);
      await nextRound(c3);
      answer("keep");
      const e0 = essence();
      const n = messages.size;
      uses.length = 0;
      await activate(c3, tElsa);
      await settleAll();
      await advance(10);
      await settleAll();
      const asks = upkeepDialogs();
      assert.equal(asks.length, 1, "the owner was asked once");
      assert.equal(asks[0].user, player.id, "on the owner's client");
      assert.match(String(asks[0].title), /Persistent\.Upkeep\.Title/, `the use's texts: ${asks[0].title}`);
      const sent = log.sent.find(s => s.type === "persistentUpkeep");
      assert.equal(sent?.data?.keepKey, "reroll");
      assert.equal(sent?.data?.cost, 1);
      const kc = keepCards(n);
      assert.equal(kc.length, 1, "a Keep card");
      const pay = Object.values(getResolution(kc[0]).ops)[0];
      assert.equal(pay.kind, "resource");
      assert.equal(pay.amount, -1);
      assert.equal(pay.status, "applied");
      assert.equal(essence(), e0 - 1, "1 essence paid");
      assert.equal(uses.length, 1, "the ability used again");
      assert.equal(uses[0].user, player.id, "on the owner's client");
      assert.equal(uses[0].resource, 0, "the dialog's cost set to 0");
      assert.equal(uses[0].flags?.[MOD]?.persistentReroll?.parent, msg.id, "the author hint");
      assert.deepEqual(uses[0].ids, [tWarrior.id], "the recorded target targeted");
      assert.ok(notes.some(x => x.user === player.id && /FreeUseNotice/.test(x.text)), "the free-use notice");
      const child = childOf(c3, msg);
      assert.ok(child, "the re-roll is the use's new entry");
      const childRes = getResolution(messages.get(child.messageId));
      assert.equal(childRes.persistent.parent, msg.id);
      assert.equal(childRes.persistent.free, true);
      assert.ok(mocks.viewOf10(messages.get(child.messageId)).banners.some(b => /PersistentFree/.test(b.text)), "the free banner");
      const parent = entry(c3, msg);
      assert.equal(parent.active, false);
      assert.equal(parent.supersededBy, child.messageId);
      assert.equal(parent.endedReason, "superseded");
      assert.equal(child.kept, 1, "kept carried");
      assert.equal(child.lastRound, c3.round);
      assert.equal(reg.entryOf(c3, msg.id).messageId, child.messageId, "entryOf follows the link");
      assert.equal(notesOf("released").length, 0, "superseded: no note");
      assert.equal(reroll.pendingRerolls().length, 0, "the expectation consumed");
      console.log("ok P3 keep: owner prompt, Keep card -1, the use again with cost 0 at the recorded target, child parent/free, parent superseded");
    }
    {
      // P4: round 3 asks once (the child), release -> inactive + a note.
      await endTurn(c3);
      await nextRound(c3);
      answer("release");
      const before = upkeepDialogs().length;
      const n = messages.size;
      await activate(c3, tElsa);
      await settleAll();
      assert.equal(upkeepDialogs().length - before, 1, "asked once in round 3");
      const child = reg.entryOf(c3, [...entries(c3)][0].messageId);
      assert.equal(child.active, false, "released");
      assert.equal(child.endedReason, "released");
      assert.equal(keepCards(n).length, 0, "nothing paid");
      assert.equal(notesOf("released", child.messageId).length, 1, "the note card");
      await endTurn(c3);
      await nextRound(c3);
      const b2 = upkeepDialogs().length;
      await activate(c3, tElsa);
      await settleAll();
      assert.equal(upkeepDialogs().length, b2, "released: never asked again");
      console.log("ok P4 the chain asks once per round; release -> inactive and a note card");
    }

    /* ======================================================================== */
    /*  P5: out of distance; P6: cannot pay                                       */
    /* ======================================================================== */
    {
      await mocks.fresh();
      const c = fight([tElsa, tWarrior]);
      await activate(c, tElsa);
      const msg = useCard(flesh, { author: player, targets: [tWarrior], amount: 1 });
      await settleAll();
      await endTurn(c);
      tWarrior._source.x = 30 * G;   // beyond 10
      await nextRound(c);
      answer("keep");
      const before = dialogs.length;
      await activate(c, tElsa);
      await settleAll();
      assert.equal(dialogs.length, before, "out of distance: nobody asked");
      assert.equal(entry(c, msg).endedReason, "outOfDistance");
      assert.equal(notesOf("released", msg).length, 1, "a note says why");
      console.log("ok P5 a re-roll-only use with no target within distance is let go at turn start, without a prompt");
    }
    {
      await mocks.fresh();
      const c = fight([tElsa, tWarrior]);
      await activate(c, tElsa);
      let msg = useCard(flesh, { author: player, targets: [tWarrior], amount: 1 });
      await settleAll();
      await endTurn(c);
      await nextRound(c);
      // Elsa's turn gain is "2": cost 1 at pool 0 is payable (what she earns this turn pays it).
      elsa.system.hero.primary.value = 0;
      answer("release");
      let before = upkeepDialogs().length;
      await activate(c, tElsa);
      await settleAll();
      assert.equal(upkeepDialogs().length - before, 1, "gain 2, cost 1, pool 0: asked");
      await endTurn(c);
      // A gain that is not constant: the pool decides (0 < 1).
      elsa.system.class.system.turnGain = "1d3";
      restore.push(() => { elsa.system.class.system.turnGain = "2"; });
      msg = useCard(flesh, { author: player, targets: [tWarrior], amount: 1 });
      await settleAll();
      await nextRound(c);
      elsa.system.hero.primary.value = 0;
      before = upkeepDialogs().length;
      await activate(c, tElsa);
      await settleAll();
      assert.equal(upkeepDialogs().length, before, "cannot pay: nobody asked");
      assert.equal(entry(c, msg).endedReason, "cannotPay");
      assert.ok(log.whispers.some(w => /Persistent\.CannotPay/.test(w.content)), "the Director is told");
      elsa.system.class.system.turnGain = "2";
      console.log("ok P6 cannot pay: a constant gain covers the cost at pool 0 (asked), a dice gain with pool 0 does not (let go, whisper)");
    }

    /* ======================================================================== */
    /*  P7: timeout; offline owner -> the Director's own dialog / skip            */
    /* ======================================================================== */
    {
      await mocks.fresh();
      const c = fight([tElsa, tWarrior]);
      await activate(c, tElsa);
      let msg = useCard(flesh, { author: player, targets: [tWarrior], amount: 1 });
      await settleAll();
      await endTurn(c);
      await nextRound(c);
      setAnswer(() => undefined);
      await activate(c, tElsa);
      await settleAll();
      assert.equal(entry(c, msg).active, true, "while asked: active");
      assert.equal(upkeep.openPersistentUpkeeps().length, 1);
      await advance(35_000);
      await settleAll();
      assert.equal(entry(c, msg).endedReason, "timedOut", "no answer: let go");
      assert.ok(log.sent.some(s => s.type === "persistentUpkeepCancel" && s.to === player.id) || upkeepDialogs().every(d => d.closed), "the owner's dialog closed");
      await endTurn(c);
      // The owner offline: the Director's own dialog (triggerFallback "director").
      msg = useCard(flesh, { author: player, targets: [tWarrior], amount: 1 });
      await settleAll();
      await nextRound(c);
      player.active = false;
      answer("keep");
      const before = upkeepDialogs().length;
      uses.length = 0;
      await activate(c, tElsa);
      await settleAll();
      const asked = upkeepDialogs().slice(before);
      assert.equal(asked.length, 1);
      assert.equal(asked[0].user, gm.id, "the Director's own dialog");
      assert.equal(uses[0]?.user, gm.id, "the re-roll on the Director's client");
      assert.ok(childOf(c, msg), "kept by the Director");
      await endTurn(c);
      // triggerFallback skip, Director-side prompts off: nobody, a whisper, let go.
      await set("triggerFallback", "skip");
      await set("triggerNpcs", false);
      msg = useCard(flesh, { author: gm, targets: [tWarrior], amount: 1 });
      await settleAll();
      await nextRound(c);
      const b2 = upkeepDialogs().length;
      await activate(c, tElsa);
      await settleAll();
      player.active = true;
      assert.equal(upkeepDialogs().length, b2, "nobody asked");
      assert.equal(entry(c, msg).endedReason, "noOwner");
      assert.ok(log.whispers.some(w => /Persistent\.NoOwner/.test(w.content)));
      console.log("ok P7 timeout lets go and closes the dialog; offline owner: the Director's dialog (fallback) or a whisper (skip)");
    }

    /* ======================================================================== */
    /*  P8: extend (held spec survives the turn start; keep; release ends it)     */
    /* ======================================================================== */
    {
      await mocks.fresh();
      const c = fight([tElsa, tBen, tWarrior]);
      await activate(c, tElsa);
      const elsaCb = c.combatants.find(x => x.tokenId === tElsa.id);
      const msg = cardAs(player, breeze, { targets: [tBen], noRoll: true });
      await settleAll();
      let eff = [...benedikt.effects.values()].find(e => e.flags?.[MOD]?.messageId === msg.id);
      assert.ok(eff, "Breeze on Benedikt");
      let specs = untilSpecs(eff);
      assert.deepEqual(specs.map(s => [s.event, s.combatantId, s.hold]), [["turnStart", elsaCb.id, "persistent"]], "a held turn-start spec");
      assert.ok(reg.holdsEffect(eff, specs[0], c), "held while the use is active");
      await endTurn(c);
      await nextRound(c);
      setAnswer(() => undefined);
      await activate(c, tElsa);
      await settleAll();
      assert.ok(!eff.duration?.expired, "the turn start did not end it (the prompt is open)");
      // Keep (the owner answers late, before the deadline).
      const d = upkeepDialogs().at(-1);
      d.click("keep");
      await settleAll();
      assert.ok(!eff.duration?.expired, "kept: still on");
      specs = untilSpecs(eff);
      assert.deepEqual(specs.map(s => [s.event, s.hold]), [["turnStart", "persistent"]]);
      await endTurn(c);
      await nextRound(c);
      answer("release");
      await activate(c, tElsa);
      await settleAll();
      assert.equal(eff.duration?.expired, true, "released: the held effect ends");
      assert.equal(entry(c, msg).endedReason, "released");
      // The setting off: a held spec is not held (ends at the turn start, as 0.13).
      await mocks.fresh();
      const c2 = fight([tElsa, tBen, tWarrior]);
      await activate(c2, tElsa);
      const m2 = cardAs(player, breeze, { targets: [tBen], noRoll: true });
      await settleAll();
      eff = [...benedikt.effects.values()].find(e => e.flags?.[MOD]?.messageId === m2.id);
      await set("persistentUpkeep", false);
      await endTurn(c2);
      await nextRound(c2);
      await activate(c2, tElsa);
      await settleAll();
      assert.equal(eff.duration?.expired, true, "setting off: nothing holds it");
      await set("persistentUpkeep", true);
      console.log("ok P8 extend: held spec survives the turn start while asked, keep keeps it held, release ends it; setting off holds nothing");
    }
    {
      // The Green: base end "until the end of your next turn" kept on release, swapped to a held start on keep.
      await mocks.fresh();
      const c = fight([tElsa, tBen, tWarrior]);
      await activate(c, tElsa);
      let msg = cardAs(player, green, { targets: [tBen], noRoll: true });
      await settleAll();
      let eff = [...benedikt.effects.values()].find(e => e.flags?.[MOD]?.messageId === msg.id);
      assert.ok(eff, "the shield on Benedikt");
      assert.deepEqual(untilSpecs(eff).map(s => [s.event, s.hold ?? null]), [["turnEnd", null]], "base spec: the end of the next turn, not held");
      await endTurn(c);
      await nextRound(c);
      answer("release");
      await activate(c, tElsa);
      await settleAll();
      assert.ok(!eff.duration?.expired, "released at the start: lasts to the end of that turn");
      await endTurn(c);
      assert.equal(eff.duration?.expired, true, "ended at the end of the turn");
      // Keep: swapped (the shield's temporary Stamina gone first: a lower grant is skipped, and the shield with it).
      benedikt.system.stamina.temporary = 0;
      msg = cardAs(player, green, { targets: [tBen], noRoll: true });
      await settleAll();
      eff = [...benedikt.effects.values()].find(e => e.flags?.[MOD]?.messageId === msg.id && !e.duration?.expired);
      await nextRound(c);
      answer("keep");
      await activate(c, tElsa);
      await settleAll();
      assert.deepEqual(untilSpecs(eff).map(s => [s.event, s.hold ?? null]), [["turnStart", "persistent"]], "kept: a held turn-start spec");
      await endTurn(c);
      assert.ok(!eff.duration?.expired, "kept: past the end of the turn");
      await nextRound(c);
      answer("release");
      await activate(c, tElsa);
      await settleAll();
      assert.equal(eff.duration?.expired, true, "released after a keep: ends at once");
      console.log("ok P8b The Green: base turn-end spec kept on release, swapped to a held start on keep");
    }

    /* ======================================================================== */
    /*  P9: Swarm of Spirits (aura held, area targets, release)                   */
    /* ======================================================================== */
    {
      await mocks.fresh();
      tWarrior._source.x = 6 * G;
      tWarrior._source.y = 3 * G;
      const c = fight([tElsa, tWarrior, tAssassin]);
      await activate(c, tElsa);
      const msg = useCard(swarm, { author: player, targets: [tWarrior], amount: 3 });
      await settleAll();
      assert.equal(swarm.flags?.[MOD]?.aura?.active, true, "the aura is on");
      assert.equal(swarm.flags[MOD].aura.sourceMessageId, msg.id);
      await endTurn(c);
      await settleAll();
      assert.equal(swarm.flags[MOD].aura.active, true, "its own turn end does not end it");
      await nextRound(c);
      setAnswer(() => undefined);
      uses.length = 0;
      await activate(c, tElsa);
      await settleAll();
      assert.equal(swarm.flags[MOD].aura.active, true, "held through the turn start while asked");
      upkeepDialogs().at(-1).click("keep");
      await settleAll();
      await advance(10);
      await settleAll();
      const run = log.sent.find(s => s.type === "triggerRun" && s.data?.kind === "persistentUse");
      assert.deepEqual(run?.data?.targetTokenUuids, [tWarrior.uuid], "area: every enemy within 3 (the assassin is farther)");
      assert.equal(uses.length, 1, "rolled again");
      const child = childOf(c, msg);
      assert.ok(child, "the re-roll's entry");
      await endTurn(c);
      await settleAll();
      assert.equal(swarm.flags[MOD].aura.active, true, "kept: past its turn end");
      assert.ok(reg.holdsAura(swarm, c)?.kept, "held and kept");
      await nextRound(c);
      answer("release");
      await activate(c, tElsa);
      await settleAll();
      assert.equal(swarm.flags[MOD].aura.active, false, "released after a keep: the aura ends");
      console.log("ok P9 Swarm of Spirits: the aura held at the turn start, area targets, kept past the turn end, ended on release");
    }

    /* ======================================================================== */
    /*  P10: turn end with an open prompt; P11: Keep-card undo; P12: deleteCombat */
    /* ======================================================================== */
    {
      await mocks.fresh();
      const c = fight([tElsa, tWarrior]);
      await activate(c, tElsa);
      let msg = useCard(flesh, { author: player, targets: [tWarrior], amount: 1 });
      await settleAll();
      await endTurn(c);
      await nextRound(c);
      setAnswer(() => undefined);
      await activate(c, tElsa);
      await settleAll();
      assert.equal(upkeep.openPersistentUpkeeps().length, 1);
      await endTurn(c);
      await settleAll();
      assert.equal(upkeep.openPersistentUpkeeps().length, 0, "the prompt is gone");
      assert.equal(entry(c, msg).endedReason, "turnEnd", "unanswered at the turn end: let go");
      assert.ok(log.sent.some(s => s.type === "persistentUpkeepCancel"), "the owner's dialog is closed");
      console.log("ok P10 a prompt still open at the user's turn end is cancelled and the use let go");

      // P11: undoing the Keep card refunds; the use stays kept.
      msg = useCard(flesh, { author: player, targets: [tWarrior], amount: 1 });
      await settleAll();
      await nextRound(c);
      answer("keep");
      const n = messages.size;
      await activate(c, tElsa);
      await settleAll();
      const kc = keepCards(n)[0];
      const e1 = essence();
      await engineMod.undoOps(live(kc), Object.keys(getResolution(kc).ops));
      await settleAll();
      assert.equal(essence(), e1 + 1, "refunded");
      assert.equal(reg.entryOf(c, msg.id).active, true, "still kept (as summons and zones)");
      console.log("ok P11 undoing the Keep card refunds the essence and keeps the use");
    }
    {
      // P12: the encounter ends while asked: nothing charged, the dialog closed, held effects end.
      await mocks.fresh();
      const c = fight([tElsa, tBen, tWarrior]);
      await activate(c, tElsa);
      const msg = cardAs(player, breeze, { targets: [tBen], noRoll: true });
      await settleAll();
      const eff = [...benedikt.effects.values()].find(e => e.flags?.[MOD]?.messageId === msg.id);
      await endTurn(c);
      await nextRound(c);
      setAnswer(() => undefined);
      await activate(c, tElsa);
      await settleAll();
      assert.equal(upkeep.openPersistentUpkeeps().length, 1);
      const n = messages.size;
      await c.delete();
      await settleAll();
      assert.equal(upkeep.openPersistentUpkeeps().length, 0, "cancelled");
      assert.equal(keepCards(n).length, 0, "nothing charged");
      assert.equal(eff.duration?.expired, true, "the held effect ends with the encounter");
      assert.equal(notesOf("released", msg).length, 0, "quietly");
      console.log("ok P12 deleteCombat cancels the open prompt, charges nothing and ends held effects quietly");
    }
    void mclock;
    void api;
  } finally {
    setAnswer(() => undefined);
    for (const fn of restore.reverse()) {
      try {
        fn();
      } catch (_err) { /* restore what can be */ }
    }
  }
}
