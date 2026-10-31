# Stef's Automation Suite API

`game.modules.get("stef-ds-automation").api`, available from the `init` hook on (the module also fires
`Hooks.callAll("dsAuto.init", api)` then, which is where content modules register overlays).

- `api.version`: the module's version (a string, set at `init`).
- `api.apiVersion`: `1`. Bumped on a breaking change of this API, of a hook's arguments or of the overlay schema; from
  1.0.0 on such a change is also a MAJOR version.

**Who may call.** Read-only members work on any client. Registry registration changes only that client's registry. "Relayed" members send a request to the active Director's client,
which checks the caller's permissions there and resolves `{ok, ...}` or rejects with an error whose message is an
i18n key (`DSAUTO.Relay.Denied`, `DSAUTO.Relay.NotActiveGM`, `DSAUTO.Relay.BadRequest`, ...;
`game.i18n.localize(err.message)` gives the text). "Active GM" members run only on the active Director's client and
throw `DSAUTO.Relay.NotActiveGM` elsewhere where enforced. The resource/villain reset methods preserve
the older `false` result for players; local prompt inspection/release simply operates on that client's prompt state. "GM" members throw `DSAUTO.Relay.Denied` for players.

## Cards

| Member | Signature | Who | Notes |
|---|---|---|---|
| `selfCheck` | `() => {report, settings, foreign, problems}` | any client | Environment report (console tables); `problems` are localized sentences. |
| `setting` | `(key) => value` | any client | Reads one of the suite's settings. |
| `getResolution` | `(messageOrId) => record \| null` | any client | The card's resolution record. **The record's shape is internal** (`RECORD_VERSION`) and may change in any release. |
| `integrity` | `(messageId) => "fresh" \| "ok" \| "tampered" \| "unsigned"` | any client | Whether the stored record still carries the active Director's signature. |
| `trustCard` | `(messageId)` | active GM | Re-sign a card after checking it by hand. |
| `resolve` | `(messageId, {force = false})` | relayed (`force`: GM) | (Re)resolve a card; applied results are kept. |
| `applyOps` | `(messageId, opIds = null, {half = false})` | relayed | Apply pending rows (all when `opIds` is null). |
| `undoOps` | `(messageId, opIds = null)` | relayed | Undo applied rows. |
| `retarget` | `(messageId, tokenUuids)` | relayed | Rebuild a card for other tokens. |
| `surge` | `(messageId, opId, {count = 1, potency = false})` | relayed | 1-3 surges of extra damage, or +1 potency for 2 surges. |
| `editOp` | `(messageId, opId, edits, {apply = false})` | relayed (Directors) | `edits`: `{amount, temp, distance, movement}`; `null` returns to the ability's value. |
| `applyDamage` | `({targets, amount, type?, ignoredImmunities?, aoe?, source?, flavor?, half?, kind?, mode?})` | relayed (Directors) | Posts a damage / heal / temporary Stamina card with undo. `mode` here is not changed by "Mode by creature type". |
| `forcedMovement` | `({targets, movement, distance, source?, vertical?, ignoreStability?, properties?, path?, mode?, flavor?})` | relayed (Directors) | Push / pull / slide card with undo. |
| `teleport` | `({token, distance?, teleportMode?, partner?, destination?, animate?, mode?, flavor?})` | relayed (Directors) | Teleport card with undo. |
| `modeFor` | `(actorOrToken, kind = "damage") => {category, mode}` | any client | The creature category (`hero`, `retainer`, `npc`, `minion`, `summon`, `object`) and the mode a result of that kind would get. Unknown kinds throw `DSAUTO.Relay.BadRequest`. Excludes player-card caps and per-card safety downgrades. |

## Durations, saves, ongoing damage

| Member | Signature | Who | Notes |
|---|---|---|---|
| `until` | `(effect, specs, options)` | the caller's own permissions | End conditions the system cannot store: `turnEnd`, `turnStart`, `dying`, `moves`. |
| `untilSpecs` | `(effectOrUuid) => specs[]` | any client | |
| `ongoingSpecs` | `(effectOrUuid) => specs[]` | any client | What the ongoing-damage tick would roll. |
| `rollSave` | `async (effectOrUuid, {policy})` | active GM | Roll a save-ends effect's save now. |

## Targeted conditions (0.10.0)

| Member | Signature | Who | Notes |
|---|---|---|---|
| `endTargeted` | `(actorOrUuid, statusId, {sourceUuid = null})` | relayed (the target's owners, Directors) | Ends a native frightened, taunted or grabbed effect of ours; with `sourceUuid` only that source of a grab. Fires `dsAuto.targetedEnded`. |

## Ability library

Every member below is on `api.library`. Registry operations are synchronous and local to the calling client;
register a source on every client from `Hooks.once("dsAuto.init", api => ...)`. Item writes return promises and
require the caller to own the item; they fire `dsAuto.medkitApplied` after completion.

| Member | Signature | Result / permission |
|---|---|---|
| `registerSource` | `({id, overlays = [], priority = 0})` | `{id, accepted, rejected}`; any client |
| `unregisterSource` | `(id)` | whether removed; any client |
| `onChange` | `(callback)` | unsubscribe function; any client |
| `info` | `()` | sources, counts, collisions and invalid entries; any client |
| `all` | `()` | all registered overlays; any client |
| `overlaysFor` / `has` | `(key)` | overlay array / boolean; any client |
| `find` / `resolve` / `status` | `(itemOrUuid)` | selected overlay / resolution layers / status; any client |
| `validate` | `(overlay)` | `{ok, errors}`; any client |
| `compareVersions` | `(a, b)` | numeric comparison; any client |
| `keys.itemKey` | `(item)` | item key; any client |
| `keys.monsterKey` | `(actor)` | monster key; any client |
| `keys.fullKey` | `(item, actor = item?.actor)` | complete key; any client |
| `dsctState` | `(itemOrUuid)` | Combat Tools state; any client |
| `entryTypesRegistered` | `()` | special-effect registration status; any client |
| `configure` | `(itemOrUuid, values = {})` | item owners |
| `disable` / `lock` | `(itemOrUuid, value = true)` | item owners |
| `detach` / `resync` | `(itemOrUuid)` | materialized entry count; item owners |
| `reset` | `(itemOrUuid)` | removes detached entries/stamp; item owners |

The overlay schema contract is **version 1** (`SCHEMA_VERSION`); each overlay's `version` is its own content
version, not the schema version. `registerSource` validates each overlay; invalid entries are skipped and reported
in `info().invalid`. See [AUTHORING.md](AUTHORING.md) for the content schema.

## Triggered actions, summons, resources, zones

| Member | Signature | Who |
|---|---|---|
| `triggers.active()` / `reactors(actor)` / `budget(actor)` | read | any client |
| `triggers.open()` / `triggers.release(promptId)` | local prompt list / cancel result | active GM prompt state; other clients have no local GM prompts |
| `summon({summoner, actor/actors, quantity?, distance?, origin?, anchor?, side?, turn?, actsThisRound?, squad?, lasts?, upkeep?, places?, pick?, flavor?, mode?})` | | Directors (relayed) |
| `summons.list(filter?)` / `get(id)` / `of(actorOrToken)` | read | any client |
| `summons.dismiss(summonId)` | | relayed (the Director, the summoner's or the summon's owners) |
| `summons.worldActor(compendiumUuid, itemOrUuid)` | | active GM |
| `resources.rules(actor)` / `ledger(actor, combat?)` / `heroTokens()` | read | any client |
| `resources.release(actor, ruleKey, {encounter})` | | active GM (another GM: `NotActiveGM`; player: `false`) |
| `malice.value()` / `malice.adjust(delta, {reason})` | read / relayed (Directors) | |
| `villain.used(actor, combat?)` / `villain.reset(actor?, combat?)` | read / active GM (another GM: `NotActiveGM`; player: `false`) | |
| `zones.list(filter?)` / `get(zoneId)` / `dismiss(zoneId)` | read / relayed (the Director, the creator's owners) | |

## Maintenance (0.10.0)

| Member | Signature | Who |
|---|---|---|
| `stripParts` | `({dryRun = true, synthetic = "convert" \| "delete" \| "keep", removeFlags = true, olderThanDays = null, batchSize = 100})` → `Promise<{dryRun, scanned, abilityCards, syntheticCards, partsRemoved, converted, deleted, flagsRemoved, ledgerPruned, errors}>` | active GM |
| `cleanup` | `({dryRun = true, zones = "dismiss", untilEffects = "convert", summons = "report", items = "report", folders = "report"})` → `Promise<{dryRun, zones, untilEffects, summons, items, folders, nativeTargeted, errors}>` | active GM |

See [UNINSTALL.md](UNINSTALL.md).

## Diagnostics: `api.debug` (GM only)

| Member | Signature | Notes |
|---|---|---|
| `debug.dump` | `(messageId?)` | Prints and returns a card's record (it shows numbers the card may hide from players). |
| `debug.request` | `(payload, {internal = false})` | Calls a relay action directly. The module's internal actions (`hold`, `holdDone`, `preRoll*`, `moveGate`, `fmActive`, `triggerCommit`, `halfMark`, `summonPrepare`, `nativeSummon`) are refused unless `internal: true`. |
| `debug.triggers.offer` | `(event \| events)` | GM diagnostics; the trigger engine processes events only on the active GM. No hold or card. |
| `debug.zones.hit` | `(zoneId, tokenOrUuid, {force})` | Active GM: one zone hit now; `force` ignores the round's credit. |

**Deprecated (0.10.0, removed in 0.11.0):** `api.dump`, `api.request`, `api.triggers.offer`, `api.zones.hit` forward
to the `api.debug` members (GM only) and warn once in the console.

`api.compat` is a frozen snapshot of what the module detected (system build, Combat Tools, Target Damage ...).

## Hooks

Names are in `HOOKS` (`scripts/constants.mjs`). "Vetoable" hooks are called with `Hooks.call`: a handler returning
`false` stops the step. "Where" is the client that fires the hook.

| Hook | Arguments | Where | Vetoable |
|---|---|---|---|
| `dsAuto.init` | `(api)` | every client, at `init` | no |
| `dsAuto.preResolve` | `(message, record, plan)` | active GM | yes: the card becomes manual |
| `dsAuto.resolved` | `(message, record, {reason})` | active GM | no |
| `dsAuto.preApplyOp` | `(message, op)` | active GM | yes: the row is skipped |
| `dsAuto.applyOp` | `(message, op, patch)` | active GM | no |
| `dsAuto.undoOp` | `(message, op, patch)` | active GM | no |
| `dsAuto.turnEvent` | `({event, combat, combatant, actor, round, turn, activation})` | active GM, once per creature and turn start / end | no |
| `dsAuto.preSave` | `(effect, {policy})` | active GM | yes: no save |
| `dsAuto.save` | `(effect, result)` | active GM | no |
| `dsAuto.preOngoing` | `(effect, spec, context)` | active GM | yes: no tick |
| `dsAuto.medkitApplied` | `(item, {action, overlay, result})` | the client that changed the item | no |
| `dsAuto.preTrigger` | `(event, candidate)` | active GM | yes: that reactor is not asked |
| `dsAuto.trigger` | `(event, decision)` | active GM, once the outcome is final | no |
| `dsAuto.trackerZero` | `(info, outcome)` | active GM | no |
| `dsAuto.preSummon` | `(message, op, {actorUuid, worldActorId, sceneId, squares, userId})` | active GM | yes: the row is skipped |
| `dsAuto.summon` | `(message, op, {summonId, tokenUuids, combatId, combatantIds, groupId})` | active GM | no |
| `dsAuto.dismissSummon` | `(info, {reason, userId})` | active GM | no |
| `dsAuto.preGain` | `(gainer, rule, fact)` | active GM | yes: no row |
| `dsAuto.gain` | `(message, op, {gainer, rule})` | active GM | no |
| `dsAuto.heroToken` | `(message, op, {hero, tokensBefore, tokensAfter})` | active GM | no |
| `dsAuto.preZoneHit` | `(region, tokenDoc, {zoneId, via, squares, amount})` | active GM | yes: no card |
| `dsAuto.zoneHit` | `(region, tokenDoc, {zoneId, via, squares, amount, messageId})` | active GM | no |
| `dsAuto.zoneEnd` | `(info, {reason, userId})` | active GM | no |
| `dsAuto.settingsMenu` (0.10.0) | `(registry)`, `registry.addMaintenance({id, label, hint, icon, run})` | any client, when the settings window renders | no |
| `dsAuto.stripped` (0.10.0) | `(report)` | the GM who ran `stripParts` | no |
| `dsAuto.cleaned` (0.10.0) | `(report)` | the GM who ran `cleanup` | no |
| `dsAuto.targetedEnded` (0.10.0) | `(effect, {reason: "sourceDefeated" \| "revived" \| "ended", sourceUuid})` | active GM | no |

## Stored data (for reference; not an API)

- Chat cards: `flags["stef-ds-automation"].resolution` (the record) and the message part `system.parts.dsAutoResolve000` of
  type `dsAutoResolution`.
- Tokens: `flags["stef-ds-automation"].summon`; regions: `flags["stef-ds-automation"].zone` with a behavior of type
  `stef-ds-automation.zone`; combats: `flags["stef-ds-automation"]` `summons`, `eventGains`, `eventGainsEncounter`, `zoneHits`,
  `villainActions`; effects: `duration.expiry = "dsAutoUntil"` and `flags["stef-ds-automation"]`; items:
  `flags["stef-ds-automation"]` and `dsAuto.*` special effects.

## Other modules

- `game.modules.get("stef-ds-automation").api.content`: `overlays` (a frozen copy of the built overlays), `count`,
  `reregister()`.
- `game.modules.get("stef-ds-automation").api.medkit`: `openItem(itemOrUuid)`, `openActor(actorOrUuid)`, `coverage()`,
  `coverageData()` (async), and the classes `ItemMedkit`, `ActorMedkit`, `CoverageReport`.

Cleanup row reports include the selected action, count and completed count; list-bearing rows also contain labels.
Native targeted effects are reported only. Errors are collected per action.
