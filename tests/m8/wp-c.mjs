// WP-C scenarios (docs/M8-DESIGN.md §3, §12.1 H18-H25): native targeted conditions, the delegated path's undo fix,
// source defeat, api.endTargeted and the frightened warning. Extra mocks (installed here, removed at the end):
// CONFIG.statusEffects for taunted / grabbed with their static ids, `system.statuses.<id>.sources` derived from the
// effects' `system.changes` (add unions, expired effects ignored; a switch makes the "system" ignore them), an effect
// `toObject` that gives `statuses` as an array (as core) and an effect `update` that fires updateActiveEffect, Combat
// Tools' applyFrightened / applyTaunted (flagged effects, the previous flagged one deleted).
// Planning rows (op.route, autoGrab, the selfCheck row) belong to WP-A / WP-B: checked only once their exports exist.
import { readFileSync } from "node:fs";

export default async function (ctx) {
  const { mocks, assert } = ctx;
  const {
    imp, Effect, dsctApi, set, settle, settleAll, idle, emit, as, gm, gm2, player, player2, setActiveGM, borin, benedikt,
    tBorin, tBen, tWarrior, tAssassin, G, notes, fight, ability, useCard, opsOf, getResolution, messages, HOOKS, paths,
  } = mocks;
  const T = await imp("engine/targeted.mjs");
  const { applyConditionOp } = await imp("engine/conditions.mjs");
  const { undoOp } = await imp("engine/undo.mjs");
  const SD = await imp("turn/source-defeat.mjs");
  const FW = await imp("ui/frightened-warning.mjs");
  const plan = await imp("engine/plan.mjs");
  const { requestOp } = await imp("relay/queries.mjs");
  const DSCT = "draw-steel-combat-tools";
  const MOD = "stef-ds-automation";

  const restore = [];
  const sys = { ignoreChanges: false };
  const ended = [];
  try {
    /* ---------- extra mocks ---------- */
    const added = [];
    const statusRow = (id, extra = {}) => {
      let s = CONFIG.statusEffects.find(x => x.id === id);
      if (!s) {
        s = { id, _id: id.padEnd(16, "0"), name: `DRAW_STEEL.ActiveEffect.${id}`, img: `${id}.svg` };
        CONFIG.statusEffects.push(s);
        added.push(s);
      }
      const before = { ...s };
      Object.assign(s, { targeted: true, ...extra });
      restore.push(() => {
        for (const k of Object.keys(s)) if (!(k in before)) delete s[k];
        Object.assign(s, before);
      });
    };
    statusRow("frightened", { rule: "Compendium.draw-steel.journals.JournalEntry.x.JournalEntryPage.frightened", maxSources: 1 });
    statusRow("taunted", { rule: "Compendium.draw-steel.journals.JournalEntry.x.JournalEntryPage.taunted", maxSources: 1 });
    statusRow("grabbed");
    restore.push(() => { for (const s of added) CONFIG.statusEffects.splice(CONFIG.statusEffects.indexOf(s), 1); });

    // Core's toObject gives arrays; the harness's JSON clone turns a Set into {} (not iterable on restore).
    const baseToObject = Effect.prototype.toObject;
    Effect.prototype.toObject = function () {
      const o = baseToObject.call(this);
      o.statuses = [...(this.statuses ?? [])];
      return o;
    };
    const baseEffUpdate = Effect.prototype.update;
    Effect.prototype.update = async function (changes, options = {}) {
      await baseEffUpdate.call(this, changes);
      if (this.parent) emit("updateActiveEffect", this, changes, options, game.userId);
      return this;
    };
    restore.push(() => { Effect.prototype.toObject = baseToObject; Effect.prototype.update = baseEffUpdate; });

    /** The system's derived `system.statuses.<id>.sources` (DSM:1328-1340), from live effects' changes. */
    const derived = new Set();
    function derive(actor) {
      if (derived.has(actor)) return;
      derived.add(actor);
      const s = actor.system;
      const desc = Object.getOwnPropertyDescriptor(s, "statuses");
      const base = desc && "value" in desc ? desc.value : undefined;
      Object.defineProperty(s, "statuses", {
        configurable: true,
        get() {
          const out = { ...(base ?? {}) };
          for (const id of T.TARGETED) {
            const sources = new Set();
            if (!sys.ignoreChanges) {
              for (const e of actor.effects.values()) {
                if (e.duration?.expired || e.disabled) continue;
                for (const c of e.system?.changes ?? []) if (c.key === `system.statuses.${id}.sources` && c.type === "add") sources.add(c.value);
              }
            }
            out[id] = { sources };
          }
          return out;
        },
      });
      restore.push(() => {
        if (desc) Object.defineProperty(s, "statuses", desc);
        else delete s.statuses;
      });
    }
    for (const t of [tBorin, tBen, tWarrior, tAssassin]) derive(t.actor);

    // Combat Tools' frightened / taunted (DSCT conditions.mjs:67-83): the previous flagged effect deleted, a new one made.
    const dsctApply = flag => async (targetDoc, sourceActor, sourceTokenId, endStr) => {
      const a = targetDoc.actor;
      const old = a.effects.find(e => e.flags?.[DSCT]?.[flag]);
      if (old) await a.deleteEmbeddedDocuments("ActiveEffect", [old.id]);
      await a.createEmbeddedDocuments("ActiveEffect", [{
        name: `${flag} [${sourceActor.name}]`, type: "base", statuses: [], system: { changes: [] }, duration: { expiry: endStr },
        flags: { [DSCT]: { [flag]: { sourceActorId: sourceActor.id, sourceTokenId } } },
      }]);
    };
    dsctApi.applyFrightened = dsctApply("frightened");
    dsctApi.applyTaunted = dsctApply("taunted");
    restore.push(() => { delete dsctApi.applyFrightened; delete dsctApi.applyTaunted; });
    restore.push(() => game.settings.set(DSCT, "frightenedEnabled", true));
    restore.push(() => set("targetedConditions", "auto"));
    restore.push(() => set("frightenedMoveWarning", true));
    const dsctConditions = on => game.settings.set(DSCT, "conditionsEnabled", on);

    SD.registerSourceDefeat();
    FW.registerFrightenedWarning();
    Hooks.on(HOOKS.targetedEnded ?? "dsAuto.targetedEnded", (effect, info) => ended.push({ effect: effect?.name, actor: effect?.parent?.name, ...info }));

    /* ---------- helpers ---------- */
    const STATIC = { frightened: "frightened000000", taunted: "taunted000000000", grabbed: "grabbed000000000" };
    let opN = 0;
    /** A library-style targeted op (no PRE needed) from `src` (token) on `tgt` (token), applied on the GM. */
    function rowOf(src, tgt, effectId, { end = "save", route, originDuration = false, item = null } = {}) {
      const res = {
        abilityUuid: item?.uuid ?? null, sourceActorUuid: src.actor.uuid, sourceTokenUuid: src.uuid,
        targets: { t1: { actorUuid: tgt.actor.uuid, tokenUuid: tgt.uuid } },
      };
      const op = { opId: `wpc-${effectId}-${++opN}`, kind: "condition", lib: true, effectId, targeted: true, targetKeys: ["t1"], end, originDuration };
      if (route !== undefined) op.route = route;
      return { res, op };
    }
    const MSG = { id: "wpcNoCard0000001" };
    async function apply(row) {
      const patch = await as(gm, () => applyConditionOp(MSG, row.res, row.op));
      row.rec = { ...row.op, ...patch };
      return patch;
    }
    async function revert(row) {
      const patch = await as(gm, () => undoOp(MSG, row.res, row.rec));
      row.rec = { ...row.rec, ...patch };
      return patch;
    }
    const eff = (tok, id) => tok.actor.effects.get(STATIC[id]) ?? null;
    const sources = (tok, id) => [...(tok.actor.system.statuses?.[id]?.sources ?? [])];
    const dsctCopies = (tok, flag) => tok.actor.effects.filter(e => e.flags?.[DSCT]?.[flag]);
    const wpaPlan = typeof plan.targetedRoute === "function";

    /* ================= H21 routing ================= */
    {
      await set("targetedConditions", "off");
      assert.equal(T.routeFor("frightened"), "off", "H21: off → manual rows");
      await set("targetedConditions", "native");
      assert.equal(T.routeFor("frightened"), "native", "H21: native even with Combat Tools on");
      await set("targetedConditions", "auto");
      assert.equal(T.routeFor("frightened"), "dsct", "H21: auto with Combat Tools conditions on → dsct");
      await dsctConditions(false);
      assert.equal(T.routeFor("taunted"), "native", "H21: auto, Combat Tools conditions off → native (DECIDED)");
      await dsctConditions(true);
      await game.settings.set(DSCT, "frightenedEnabled", false);
      assert.equal(T.routeFor("frightened"), "native", "H21: auto, frightenedEnabled off → native");
      assert.equal(T.routeFor("taunted"), "dsct", "H21: the per-condition toggle only");
      // A 0.9.x record (no route) and a library row: routed at apply time → native.
      const row = rowOf(tWarrior, tBorin, "frightened");
      const p = await apply(row);
      assert.equal(p.status, "applied", `H21: routed natively at apply (${p.reason ?? ""})`);
      assert.ok(p.native && eff(tBorin, "frightened"), "H21: native static effect");
      await revert(row);
      await game.settings.set(DSCT, "frightenedEnabled", true);
      // `off` with a 0.9.x record planned for Combat Tools: still delegated.
      await set("targetedConditions", "off");
      const row2 = rowOf(tWarrior, tBorin, "frightened");
      const p2 = await apply(row2);
      assert.equal(p2.delegated, "dsct-frightened", "H21: a delegated 0.9.x record stays delegated");
      await revert(row2);
      assert.equal(dsctCopies(tBorin, "frightened").length, 0, "H21: undone");
      await set("targetedConditions", "auto");
      // Planning (WP-A) and the selfCheck row (WP-B).
      if (wpaPlan) {
        await set("targetedConditions", "off");
        assert.equal(plan.targetedRoute("frightened"), "off", "H21: plan route off");
        await set("targetedConditions", "auto");
      } else console.log("  note: H21 plan rows skipped (WP-A targetedRoute not present yet)");
      const sc = readFileSync(`${paths.SCRIPTS}self-check.mjs`, "utf8");
      if (sc.includes("nativeWithDsct")) {
        await set("targetedConditions", "native");
        const out = await mocks.api.selfCheck();
        assert.ok(JSON.stringify(out).includes("nativeWithDsct") || JSON.stringify(out).includes("NativeWithDsct"), "H21: selfCheck nativeWithDsct");
        await set("targetedConditions", "auto");
      } else console.log("  note: H21 selfCheck nativeWithDsct skipped (WP-B row not present yet)");
      console.log("H21 ok: routing");
    }

    /* ================= H18 delegated path fix ================= */
    {
      await set("targetedConditions", "auto");
      await dsctConditions(true);
      const first = rowOf(tWarrior, tBorin, "frightened");
      const p1 = await apply(first);
      assert.equal(p1.delegated, "dsct-frightened", "H18: delegated");
      const old = dsctCopies(tBorin, "frightened")[0];
      assert.ok(old, "H18: flagged effect");
      const second = rowOf(tAssassin, tBorin, "frightened");
      const p2 = await apply(second);
      assert.equal(p2.replaced?._id, old.id, "H18: replaced = the earlier flagged effect");
      assert.equal(dsctCopies(tBorin, "frightened").length, 1, "H18: DSCT deleted the old one");
      await revert(second);
      const back = dsctCopies(tBorin, "frightened");
      assert.equal(back.length, 1, "H18: undo → one flagged effect");
      assert.equal(back[0].id, old.id, "H18: the earlier one restored");
      assert.equal(back[0].flags[DSCT].frightened.sourceActorId, tWarrior.actor.id, "H18: its source kept");
      await revert(first);
      assert.equal(dsctCopies(tBorin, "frightened").length, 0, "H18: all undone");
      // A native copy is deleted first and restored on undo.
      await set("targetedConditions", "native");
      const nat = rowOf(tWarrior, tBorin, "frightened");
      await apply(nat);
      assert.ok(eff(tBorin, "frightened"), "H18: native copy");
      await set("targetedConditions", "auto");
      const del = rowOf(tAssassin, tBorin, "frightened");
      const p3 = await apply(del);
      assert.equal(p3.delegated, "dsct-frightened", "H18: delegated over a native copy");
      assert.equal(p3.replacedExtra?.length, 1, "H18: replacedExtra holds the native copy");
      assert.equal(eff(tBorin, "frightened"), null, "H18: native copy deleted (no double count)");
      assert.equal(p3.native, null, "H18: no native fields on a delegated row");
      await revert(del);
      assert.ok(eff(tBorin, "frightened"), "H18: native copy restored on undo");
      assert.equal(dsctCopies(tBorin, "frightened").length, 0, "H18: DSCT effect gone");
      assert.deepEqual(sources(tBorin, "frightened"), [tWarrior.actor.uuid], "H18: its source again");
      await revert(nat);
      console.log("H18 ok: delegated path records replaced / replacedExtra");
    }

    /* ================= H19 native frightened ================= */
    {
      await dsctConditions(false);
      const combat = fight([tWarrior, tBorin, tAssassin]);
      const cmb = tok => combat.getCombatantsByActor(tok.actor)[0];
      const row = rowOf(tWarrior, tBorin, "frightened", { end: "save" });
      const p = await apply(row);
      assert.equal(p.status, "applied", `H19: applied (${p.reason ?? ""})`);
      const e = eff(tBorin, "frightened");
      assert.ok(e, "H19: static id frightened000000");
      assert.deepEqual(p.createdIds, ["frightened000000"], "H19: createdIds");
      assert.ok(e.statuses.has("frightened"), "H19: statuses");
      assert.ok(tWarrior.actor.uuid.includes(".Token."), "H19: the unlinked source has a synthetic uuid");
      assert.deepEqual(e.system.changes, [{ key: "system.statuses.frightened.sources", type: "add", value: tWarrior.actor.uuid, phase: "initial" }], "H19: source change");
      assert.ok(tBorin.actor.system.statuses.frightened.sources.has(tWarrior.actor.uuid), "H19: the system sees the source");
      assert.equal(e.start.combatant, cmb(tBorin).id, "H19: start.combatant = the target's combatant");
      assert.equal(e.duration.expiry, "save", "H19: expiry per end");
      assert.equal(e.system.end?.roll, "1d10 + @combat.save.bonus", "H19: save roll");
      assert.equal(e.transfer, true, "H19: transfer");
      assert.match(e.description, /^@Embed\[.*frightened inline\]$/, "H19: rule embedded");
      assert.equal(e.flags[MOD].targeted.statusId, "frightened", "H19: our flag");
      assert.equal(e.flags[MOD].targeted.sourceActorUuid, tWarrior.actor.uuid, "H19: flag source");
      assert.equal(e.flags[MOD].targeted.sourceTokenUuid, tWarrior.uuid, "H19: flag source token");
      assert.ok(!e.flags[DSCT], "H19: no Combat Tools flag");
      // originDuration: the source's combatant; turn end.
      const tRow = rowOf(tWarrior, tBen, "taunted", { end: "turn", originDuration: true });
      derive(tBen.actor);
      fight([tWarrior, tBen]);
      const tp = await apply(tRow);
      assert.equal(tp.status, "applied", "H19: taunted applied");
      const te = eff(tBen, "taunted");
      assert.equal(te.start.combatant, game.combat.getCombatantsByActor(tWarrior.actor)[0].id, "H19: originDuration → the source's combatant");
      assert.equal(te.duration.expiry, "turnEnd", "H19: EoT expiry");
      assert.equal(te.system.end, undefined, "H19: no save roll for EoT");
      await revert(tRow);
      // A second source replaces; undo restores the first.
      const row2 = rowOf(tAssassin, tBorin, "frightened");
      const p2 = await apply(row2);
      assert.equal(p2.replaced?.system?.changes?.[0]?.value, tWarrior.actor.uuid, "H19: replaced = the first");
      assert.deepEqual(sources(tBorin, "frightened"), [tAssassin.actor.uuid], "H19: one source (maxSources 1)");
      await revert(row2);
      assert.deepEqual(sources(tBorin, "frightened"), [tWarrior.actor.uuid], "H19: undo restores the first");
      // A Combat Tools flagged copy is replaced too (replacedExtra) and restored on undo.
      await tBorin.actor.createEmbeddedDocuments("ActiveEffect", [{ name: "Frightened [x]", statuses: [], flags: { [DSCT]: { frightened: { sourceActorId: "x" } } } }]);
      const row3 = rowOf(tAssassin, tBorin, "frightened");
      const p3 = await apply(row3);
      assert.equal(p3.replacedExtra.length, 1, "H19: the flagged copy kept for undo");
      assert.equal(dsctCopies(tBorin, "frightened").length, 0, "H19: flagged copy deleted");
      await revert(row3);
      assert.equal(dsctCopies(tBorin, "frightened").length, 1, "H19: flagged copy restored");
      await revert(row);
      assert.equal(eff(tBorin, "frightened"), null, "H19: undo of the first → nothing left");
      for (const d of dsctCopies(tBorin, "frightened")) await tBorin.actor.deleteEmbeddedDocuments("ActiveEffect", [d.id]);
      console.log("H19 ok: native frightened / taunted");
    }

    /* ================= H20 native grab ================= */
    {
      await dsctConditions(false);
      const g1 = rowOf(tWarrior, tBorin, "grabbed", { end: "" });
      const p1 = await apply(g1);
      assert.equal(p1.status, "applied", "H20: grab applied");
      const g2 = rowOf(tAssassin, tBorin, "grabbed", { end: "" });
      const p2 = await apply(g2);
      assert.ok(p2.appended && p2.updatedId === STATIC.grabbed, "H20: a second grabber appends");
      assert.deepEqual(sources(tBorin, "grabbed").sort(), [tWarrior.actor.uuid, tAssassin.actor.uuid].sort(), "H20: two sources");
      const g3 = rowOf(tAssassin, tBorin, "grabbed", { end: "" });
      const p3 = await apply(g3);
      assert.ok(p3.idempotent && p3.status === "applied", "H20: the same grabber again → idempotent");
      assert.equal(eff(tBorin, "grabbed").system.changes.length, 2, "H20: no third change");
      const u3 = await revert(g3);
      assert.equal(u3.undoMode, "noop", "H20: idempotent undo writes nothing");
      assert.equal(sources(tBorin, "grabbed").length, 2, "H20: still two");
      await revert(g2);
      assert.deepEqual(sources(tBorin, "grabbed"), [tWarrior.actor.uuid], "H20: undo of the append removes only its source");
      // The creator's undo while another grabber joined: only its own source goes.
      await apply(g2);
      await revert(g1);
      assert.deepEqual(sources(tBorin, "grabbed"), [tAssassin.actor.uuid], "H20: creator's undo keeps the other grabber");
      await revert(g2);
      assert.equal(sources(tBorin, "grabbed").length, 0, "H20: all sources gone");
      const left = eff(tBorin, "grabbed");
      if (left) await tBorin.actor.deleteEmbeddedDocuments("ActiveEffect", [left.id]);
      if (wpaPlan) {
        await set("autoGrab", false);
        const scare = ability(tWarrior.actor, "Grab Test", { powerRoll: true, target: { type: "creature" } });
        scare.system.power.effects.set("appPRE0000000001", appliedPre("grabbed", ""));
        const msg = useCard(scare, { targets: [tBorin], tier: 2, token: tWarrior });
        await idle();
        await settleAll();
        const op = opsOf(msg).find(o => o.kind === "condition");
        assert.equal(op?.mode, "prompt", "H20: autoGrab false → prompt row");
      } else console.log("  note: H20 autoGrab prompt row skipped (WP-A planning not present yet)");
      console.log("H20 ok: native grab");
    }

    /* ================= H22 verification failure ================= */
    {
      await dsctConditions(false);
      const keep = rowOf(tWarrior, tBorin, "frightened");
      await apply(keep);
      sys.ignoreChanges = true;
      const bad = rowOf(tAssassin, tBorin, "frightened");
      const p = await apply(bad);
      sys.ignoreChanges = false;
      assert.equal(p.status, "failed", "H22: failed");
      assert.equal(p.reason, "nativeNoSource", "H22: nativeNoSource");
      const e = eff(tBorin, "frightened");
      assert.ok(e, "H22: the replaced effect is back");
      assert.equal(e.system.changes[0].value, tWarrior.actor.uuid, "H22: with its own source");
      assert.equal(tBorin.actor.effects.size, 1, "H22: nothing else left behind");
      // Grab append rolled back.
      const g1 = rowOf(tWarrior, tBen, "grabbed", { end: "" });
      await apply(g1);
      sys.ignoreChanges = true;
      const pg = await apply(rowOf(tAssassin, tBen, "grabbed", { end: "" }));
      sys.ignoreChanges = false;
      assert.equal(pg.reason, "nativeNoSource", "H22: append not seen → failed");
      assert.equal(eff(tBen, "grabbed").system.changes.length, 1, "H22: the append rolled back");
      await revert(g1);
      await revert(keep);
      console.log("H22 ok: verification failure rolls back");
    }

    /** An applied PRE of `id` on every tier (the system's AppliedPowerRollEffect shape, as harness.mjs). */
    function appliedPre(id, end) {
      const tier = { effects: { [id]: { end, properties: new Set(), condition: "always" } }, potency: { characteristic: "", value: "" } };
      return { id: "appPRE0000000001", type: "applied", name: "Effect", applied: { tier1: tier, tier2: tier, tier3: tier }, async applyEffect() { return []; } };
    }
    /** A card of the warrior frightening `targets`; each condition row applied natively (directly unless the plan did). */
    async function frightCard(targets, id = "frightened") {
      const item = ability(tWarrior.actor, `Scare ${id}`, { powerRoll: true, target: { type: "creature" } });
      item.system.power.effects.set("appPRE0000000001", appliedPre(id, "save"));
      const msg = useCard(item, { targets, tier: 2, token: tWarrior });
      await idle();
      await settleAll();
      const live = messages.get(msg.id);
      for (const op of opsOf(live).filter(o => o.kind === "condition")) {
        if (op.status === "applied" && op.native) continue;
        const p = await as(gm, () => applyConditionOp(live, getResolution(live), { ...op, route: "native" }));
        assert.equal(p.status, "applied", `card row applied natively (${p.reason ?? ""})`);
      }
      return live;
    }

    /* ================= H23 source defeated ================= */
    {
      await dsctConditions(false);
      fight([tWarrior, tBorin, tBen, tAssassin]);
      const msg = await frightCard([tBorin, tBen]);
      const U = tWarrior.actor.uuid;
      assert.ok(SD.isIndexedSource(U), "H23: the source is indexed");
      // A grab with two sources and a Combat Tools flagged effect of the same source.
      const ga = rowOf(tWarrior, tAssassin, "grabbed", { end: "" });
      derive(tAssassin.actor);
      await apply(ga);
      const gb = rowOf(tBen, tAssassin, "grabbed", { end: "" });
      await apply(gb);
      await tBen.actor.createEmbeddedDocuments("ActiveEffect", [{ name: "Taunted [Goblin]", statuses: [], flags: { [DSCT]: { taunted: { sourceActorId: tWarrior.actor.id } } } }]);
      const flagged = dsctCopies(tBen, "taunted")[0];
      ended.length = 0;
      // A non-active GM does nothing.
      setActiveGM(gm2);
      tWarrior.actor.statuses.add("dead");
      await as(gm, () => SD.checkSource(U));
      await as(gm, async () => { Hooks.callAll("updateActor", tWarrior.actor, {}, {}, gm.id); });
      await SD.sourceDefeatIdle();
      assert.ok(!eff(tBorin, "frightened").duration.expired, "H23: a non-active GM ends nothing");
      tWarrior.actor.statuses.delete("dead");
      setActiveGM(gm);
      // Defeated: Stamina 0 (the dead status, updateActor).
      await tWarrior.actor.update({ "system.stamina.value": 0 });
      await SD.sourceDefeatIdle();
      await settleAll();
      for (const tok of [tBorin, tBen]) {
        const e = eff(tok, "frightened");
        assert.equal(e.duration.expired, true, `H23: ${tok.name}'s frightened expired`);
        assert.equal(e.flags[MOD].targeted.endedBy.sourceUuid, U, "H23: endedBy");
        assert.equal(sources(tok, "frightened").length, 0, "H23: the system no longer sees it");
      }
      const rows = opsOf(msg).filter(o => o.kind === "condition");
      assert.equal(rows.length, 2, "H23: two rows");
      for (const r of rows) assert.equal(r.endedReason, "sourceDefeated", "H23: row annotated sourceDefeated");
      const grab = eff(tAssassin, "grabbed");
      assert.ok(!grab.duration?.expired, "H23: the grab with two sources stays");
      assert.deepEqual(sources(tAssassin, "grabbed"), [tBen.actor.uuid], "H23: only the defeated grabber's change removed");
      assert.equal(dsctCopies(tBen, "taunted")[0]?.id, flagged.id, "H23: the Combat Tools flagged effect untouched");
      assert.ok(!dsctCopies(tBen, "taunted")[0].duration?.expired, "H23: not expired either");
      assert.equal(ended.filter(x => x.reason === "sourceDefeated").length, 3, "H23: targetedEnded × 3");
      // Revived.
      ended.length = 0;
      await tWarrior.actor.update({ "system.stamina.value": 15 });
      await SD.sourceDefeatIdle();
      await settleAll();
      for (const tok of [tBorin, tBen]) {
        const e = eff(tok, "frightened");
        assert.equal(e.duration.expired, false, `H23: ${tok.name}'s frightened back`);
        assert.equal(e.flags[MOD].targeted.endedBy, null, "H23: endedBy cleared");
        assert.deepEqual(sources(tok, "frightened"), [U], "H23: source seen again");
      }
      for (const r of opsOf(msg).filter(o => o.kind === "condition")) assert.equal(r.endedReason ?? null, null, "H23: annotation cleared");
      assert.deepEqual(sources(tAssassin, "grabbed").sort(), [U, tBen.actor.uuid].sort(), "H23: the grab change re-added");
      assert.equal(ended.filter(x => x.reason === "revived").length, 3, "H23: targetedEnded revived × 3");
      // Undo of the row still deletes the effect.
      await revert(gb);
      await revert(ga);
      await tBen.actor.deleteEmbeddedDocuments("ActiveEffect", [flagged.id]);
      for (const tok of [tBorin, tBen]) await tok.actor.deleteEmbeddedDocuments("ActiveEffect", [STATIC.frightened]);
      assert.ok(!SD.isIndexedSource(U), "H23: index empty once the effects are gone");
      console.log("H23 ok: source defeated / revived");
    }

    /* ================= H24 api.endTargeted ================= */
    {
      await dsctConditions(false);
      const msg = await frightCard([tBorin], "taunted");
      ended.length = 0;
      // A stranger (role below cardActionRole, owns neither).
      await assert.rejects(() => T.handleEndTargeted({ actorUuid: borin.uuid, statusId: "taunted" }, player), /DSAUTO.Relay.Denied/, "H24: a stranger → Denied");
      await assert.rejects(() => T.handleEndTargeted({ actorUuid: borin.uuid, statusId: "slowed" }, gm), /DSAUTO.Relay.BadRequest/, "H24: not a targeted status");
      const out = await T.handleEndTargeted({ actorUuid: borin.uuid, statusId: "taunted" }, player2);
      assert.deepEqual(out, { ok: true, ended: "effect" }, "H24: the target's owner ends a native taunted");
      assert.equal(eff(tBorin, "taunted"), null, "H24: effect gone");
      await settleAll();
      assert.equal(opsOf(msg).find(o => o.kind === "condition").endedReason, "ended", "H24: row annotated ended");
      assert.equal(ended.length, 1, "H24: targetedEnded fired");
      assert.equal(ended[0].reason, "ended", "H24: reason ended");
      assert.deepEqual(await T.handleEndTargeted({ actorUuid: borin.uuid, statusId: "taunted" }, gm), { ok: true, ended: "none" }, "H24: nothing left → none");
      // One grab source removed with sourceUuid (the GM, by token uuid).
      const g1 = rowOf(tWarrior, tBen, "grabbed", { end: "" });
      const g2 = rowOf(tAssassin, tBen, "grabbed", { end: "" });
      await apply(g1);
      await apply(g2);
      const o2 = await T.handleEndTargeted({ actorUuid: tBen.uuid, statusId: "grabbed", sourceUuid: tAssassin.actor.uuid }, gm);
      assert.deepEqual(o2, { ok: true, ended: "source" }, "H24: one grab source removed");
      assert.deepEqual(sources(tBen, "grabbed"), [tWarrior.actor.uuid], "H24: the other grabber stays");
      // Non-active GM refuses.
      setActiveGM(gm2);
      await assert.rejects(() => as(gm, () => T.handleEndTargeted({ actorUuid: tBen.uuid, statusId: "grabbed" }, gm)), /NotActiveGM/, "H24: not the active GM");
      setActiveGM(gm);
      // Through the relay (WP-B registers the action).
      const q = readFileSync(`${paths.SCRIPTS}relay/queries.mjs`, "utf8");
      if (q.includes("endTargeted")) {
        const r = await as(player, () => requestOp({ action: "endTargeted", endTargeted: { actorUuid: benedikt.uuid, statusId: "grabbed" } }));
        assert.equal(r?.ended, "effect", "H24: the relay ends it (Other owns Benedikt)");
        assert.equal(eff(tBen, "grabbed"), null, "H24: gone");
      } else {
        console.log("  note: H24 relay action skipped (WP-B endTargeted not registered yet)");
        await T.handleEndTargeted({ actorUuid: benedikt.uuid, statusId: "grabbed" }, player);
        assert.equal(eff(tBen, "grabbed"), null, "H24: the owner ends the whole grab");
      }
      console.log("H24 ok: api.endTargeted");
    }

    /* ================= H25 frightened warning ================= */
    {
      await dsctConditions(false);
      const row = rowOf(tWarrior, tBorin, "frightened");
      await apply(row);
      const move = (user, gx, gy = 5) => as(user, () => Hooks.call("preUpdateToken", tBorin, { x: gx * G, y: gy * G }, {}, user.id));
      notes.length = 0;
      assert.notEqual(move(player2, 6), false, "H25: the move is never blocked");
      const w = notes.filter(n => n.kind === "warn");
      assert.equal(w.length, 1, "H25: one warning moving closer");
      assert.equal(w[0].user, player2.id, "H25: on the mover's client");
      assert.match(w[0].text, /DSAUTO\.Targeted\.FrightenedCloser/, "H25: the warning text");
      notes.length = 0;
      move(player2, 4);
      move(player2, 5, 3);
      assert.equal(notes.length, 0, "H25: moving away or sideways-away → none");
      as(gm, () => Hooks.call("preUpdateToken", tBorin, { x: 7 * G }, {}, player2.id));
      assert.equal(notes.length, 0, "H25: other clients stay quiet");
      await dsctConditions(true);
      move(player2, 7);
      assert.equal(notes.length, 0, "H25: Combat Tools conditions on → none");
      await dsctConditions(false);
      await set("frightenedMoveWarning", false);
      move(player2, 7);
      assert.equal(notes.length, 0, "H25: setting off → none");
      await set("frightenedMoveWarning", true);
      // An expired (ended) frightened warns no more.
      await tWarrior.actor.update({ "system.stamina.value": 0 });
      await SD.sourceDefeatIdle();
      move(player2, 7);
      assert.equal(notes.length, 0, "H25: source defeated → no warning");
      await tWarrior.actor.update({ "system.stamina.value": 15 });
      await SD.sourceDefeatIdle();
      await revert(row);
      console.log("H25 ok: frightened warning");
    }

    /* ---------- nativeTargetedEffects ---------- */
    {
      await dsctConditions(false);
      const a = rowOf(tWarrior, tBorin, "frightened");
      const b = rowOf(tAssassin, tBen, "taunted");
      await apply(a);
      await apply(b);
      assert.equal(T.nativeTargetedEffects().length, 2, "nativeTargetedEffects: all");
      assert.equal(T.nativeTargetedEffects({ statusId: "taunted" }).length, 1, "nativeTargetedEffects: by status");
      assert.equal(T.nativeTargetedEffects({ sourceUuid: tWarrior.actor.uuid })[0]?.parent, borin, "nativeTargetedEffects: by source");
      assert.equal(T.nativeTargetedEffects(e => e.parent === benedikt).length, 1, "nativeTargetedEffects: predicate");
      await revert(a);
      await revert(b);
      assert.equal(T.nativeTargetedEffects().length, 0, "nativeTargetedEffects: none left");
      console.log("nativeTargetedEffects ok");
    }
    await settle(10);
  } finally {
    sys.ignoreChanges = false;
    for (const fn of restore.reverse()) await fn();
  }
}
