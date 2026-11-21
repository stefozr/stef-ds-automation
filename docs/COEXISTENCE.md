# Coexistence with other Draw Steel modules

Stef's Automation Suite works alone on the system's own data, and alongside the modules below. It never writes
another module's flags or settings: it reads them, calls the module's public API where one exists (the other module
then writes its own data), and locks or annotates buttons in the chat card only on the client that shows them.
`api.selfCheck()` prints the other modules' settings that matter (the "foreign" table).

Versions this was last checked against (automation 1.2.2): Combat Tools 2.2.4, ctlib 2.1.3, Battle Log 2.1.1,
Death Tracker 2.0.1, Target Damage 1.0.8, Draw Steel 1.2.2, Foundry 14.370. The contract list behind this page is
kept in the audit baseline (`D:/FoundryVTT/Audit/baselines/2026-11-21_ds1.2.2_ct2.2.4/contracts.json`).

**The rule: the suite has priority over Combat Tools.** Where the Automation box handles something, Combat Tools'
duplicate control is hidden on our side. Combat Tools stays the fallback for kinds the suite does not cover. The suite
never changes a Combat Tools setting by itself; it only does so when the GM clicks the overlap notice.

## Draw Steel: Combat Tools (`draw-steel-combat-tools`)

| | |
|---|---|
| Reads | Settings `abilityAutomationEnabled`, `autoApplyOwnAbilities`, `abilityTargetingEnabled`, `areaPicker`, `abilityTemplateCleanup`, `abilityTemplateSeconds`, `appliedEffectEnabled`, `applyDamageEnabled`, `flatEffectsEnabled`, `advancedEnrichers`, `conditionsEnabled`, `frightenedEnabled`, `tauntedEnabled`, `grabEnabled`, `forcedMovementEnabled`, `allowCrookedPushPull`, `gmBypassesSizeCheck`, `stealthSystemEnabled`, `neutralFoesHostile`, `squadToolsEnabled`, `squadSimultaneousTurns`, `pairSimultaneousTurns`, `autoSquadLabelsEnabled`, `squadLabelApplyEffects`, `autoTriggeredActionsEnabled`, `rollDialogPillUI`, `hiwEnabled`, `judgementAutomation`, `markAutomation`. Message flags (`useTargets`, `lastFmMoveId`, `flatDmgTypes` ...), item flags (`effectType`, its own automation of an ability), and the effect flags `judgement`, `mark`, `aura`, `stealth`. Its "Unspent Triggered Action" effect. |
| Calls | Its API: `applyFrightened`, `applyTaunted`, `grab` / `endGrab`, `forcedMovement` (push, pull, slide, collisions, undo by its log), `isFMActive`, `bypassNextFmGate`, `allowOutOfRange`, `teleport`, `getValidTargets`, `colorTokenPicker` (the square picker), `squadLabels`, `rollDialog` / `setRollDialogLock`, `stealth`. It listens to the hooks `dsct.preForcedMovement` and `dsct.forcedMovement`, and imports its forced-movement engine, `teleport.mjs` and `combat-reveal.mjs`. |
| Built into the suite | Hesitation is Weakness, Judgement (all of it: the holy damage, the Wrath bane / potency option, the taunt) and Mark (the taunt) are done by the suite. Combat Tools' own cards and buttons for them are hidden where the box has the row. A judgement that Combat Tools applied itself is left to it while its Judgement automation is on. |
| Hides | Its chips in card text ("15 Stamina", "Stand Up" ...), its flat and tiered heal / teleport buttons, "Apply Judgement" and "Apply Mark", and its own Hesitation is Weakness card, wherever the Automation box already has the same row. Buttons for things the box does not handle stay. |
| Copies | The suite always automates Combat Tools' enhanced ability copies. My Life for Yours shows one "Spend 1 Wrath" row after its Stand Up or Cleanse pick. Practical Magic's Damage and Teleport picks plan their rows, and answers already given in Combat Tools' target picker or roll window are reused. |
| Fallback | For kinds the suite does not cover, Combat Tools' own automation and buttons stay and work as before. |
| Locks | Its "Push 2" style buttons and Apply All on results our rows already applied (silently on cards the box handles; a warning only when you click). |
| GM overlap notice | A one-time notice (and Automation settings, Maintenance, "Combat Tools overlap: review") lists the Combat Tools switches that duplicate the suite: Hesitation is Weakness, Judgement, Mark and "Apply my abilities automatically". One click turns them off; "Not now" hides it until the list changes. |
| Overlaps | With **Targeted conditions** = Native while Combat Tools' conditions are on, both may represent the same condition (the self-check warns). Combat Tools takes over the token HUD toggle of frightened / taunted / grabbed while active, so a native effect of ours is ended with `api.endTargeted` or by deleting the effect. Its cover immunity can be used up by another hit during a hold. |

## ctlib (`draw-steel-ctlib`)

| | |
|---|---|
| Calls | `damageBatch` (Death Tracker waits for the whole batch before it resolves kills) and its services `noteDamageCause`, `reportSquadDamage`. |

## Draw Steel: Target Damage (`draw-steel-target-damage`)

| | |
|---|---|
| Reads | Its message flags (`state`: targets after area auto-targeting, applications, and the per-target test results `reactiveResults` of reactive abilities) and settings `hideSystemButtons`, `aoeTargeting`. |
| Locks | Its row buttons for results our rows applied; results it applied first are shown as "applied elsewhere" on our card (setting **Respect Target Damage applications**). |
| Reactive tests | A target's rolled test (recorded by Target Damage) tiers that target's rows on the ability card; the system's apply buttons on that test card (and Combat Tools' forced movement button there) are locked once our card has the target's rows (setting **Automate reactive tests**). |
| Overlaps | Its own hold limit: damage from its rows waits at most 13 s for a triggered action (it gives up after 15 s). On Draw Steel 1.2 its behaviour depends on its own 1.2 update (not tested). |

## Draw Steel: Death Tracker (`draw-steel-death-tracker`)

| | |
|---|---|
| Reads | Settings `cleanOrphanedCombatants`, `clearSkullsOnCombatEnd`. |
| Calls | Through ctlib: attribution, squad hits and pending revival. Revival uses Death Tracker's loaded module instance (`reviveTokens` with `skipGroupHpRestore`), with a socket fallback, when our undo restores Stamina and the Director views the scene. |
| Overlaps | It cleans only Combat Tools' flagged condition effects when a source dies; our native targeted effects are ended by our own source-defeat handling (0.10.0). |

## Draw Steel: Battle Log (`draw-steel-battle-log`)

| | |
|---|---|
| Reads | Settings `resourceLog`, `resourceLogTokenCards` (self-check only). The qol module also reads `collapsibleAbilities`. |
| Overlaps | Damage from other buttons that we halve during a hold is logged unhalved. |

## Draw Steel: Triggers (`draw-steel-triggers`)

| | |
|---|---|
| Stands down | With it active (and **Leave triggers to Draw Steel: Triggers** on) our triggered-action engine is off; our resource gains stand down too. |

## Draw Steel: Resources UI (`draw-steel-resources-ui`)

| | |
|---|---|
| Stands down | With it active our resource gains are off (it owns them; the self-check says so). |

## Stef's Quality of Life Improvements (`stef-ds-qol`)

| | |
|---|---|
| Read by it | Its teleport fix asks `api.library.find` and the setting `libraryEnabled`, and leaves abilities the library teleports to us. |
| Overlaps | Its "Undo Last Activation" restores the heroic resource to its old value even when a gain row stays applied: undo the gain row first, or add the erased gain back on the sheet afterwards and leave its applied row unchanged. |

## Draw Steel: Combat Tracker (`draw-steel-combat-tracker`)

| | |
|---|---|
| Read by qol | The qol tracker dock reads its settings `alignLeft` and `resizableWidth` and imports its `scripts/combat-dock.mjs`. Only tested versions are patched (qol `VERIFIED_VERSIONS`). |

## Draw Steel Plus (`draw-steel-plus`)

| | |
|---|---|
| Overlaps | None known. The medkit's badges and windows work on its sheets as on the stock sheets. |

## The Draw Steel system

The core registers one chat message part type (`dsAutoResolution`), `dsAuto.*` special effect types, a region
behavior type (`stef-ds-automation.zone`) and the effect expiry `dsAutoUntil`. With libWrapper it wraps a few system and
Foundry methods (listed in the core README, "Requirements"); the 1.1.x fixes install only where the system still has
the bug. It never writes the system's own summoner flag; on Draw Steel 1.2 builds the system's native summon goes
through our placement (setting **Intercept native summons**).

## Draw Steel 1.2

- **Target Damage is off.** On Draw Steel 1.2 the system's per-target sections and ctlib's Apply / Undo replace it
  (Combat Tools 2.2 lists it as "recommends", for Draw Steel 1.1 only). Every Target Damage path of the suite stands
  down on a 1.2 card, and the self-check (`dstdOnSystem12`) asks the Director to turn it off.
- **The veto.** `ds.preApplyTargetResult` (and ctlib's relayed `ctlib.preApplyTargetResult`) refuses a per-target
  button, and ctlib's **Apply All Damage**, for rows the Automation box applied or still owns; see
  `scripts/compat/target-result-veto.mjs`.
- **ctlib journal.** Rows that ctlib's journal (`flags.draw-steel-ctlib.journal`) shows as applied by those buttons
  are marked applied elsewhere (`appliedByCtlib`, or `partlyAppliedByCtlib` for part of a squad row) and follow a later
  undo. Setting **Respect Target Damage applications** (`respectDstdApplications`) governs this too.
  Details: [COMBAT-TOOLS-2.2.md](COMBAT-TOOLS-2.2.md).
