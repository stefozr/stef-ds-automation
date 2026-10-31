# Coexistence with other Draw Steel modules

Stef's Automation Suite works alone on the system's own data, and alongside the modules below. It never writes
another module's flags or settings: it reads them, calls the module's public API where one exists (the other module
then writes its own data), and locks or annotates buttons in the chat card only on the client that shows them.
`api.selfCheck()` prints the other modules' settings that matter (the "foreign" table).

Source contracts reviewed (M8 live coexistence testing remains pending): Combat Tools 1.2.3, ctlib 1.2.1, Target Damage 1.0.8, Death Tracker 1.1.3, Battle Log 1.3.0,
Stef's Quality of Life Improvements 1.0.0, on Draw Steel 1.1.2 and Foundry 14.368.

## Draw Steel: Combat Tools (`draw-steel-combat-tools`)

| | |
|---|---|
| Reads | Settings `conditionsEnabled`, `forcedMovementEnabled`, `abilityAutomationEnabled`, `squadToolsEnabled`, `squadSimultaneousTurns`, `pairSimultaneousTurns`, `autoSquadLabelsEnabled`, `squadLabelApplyEffects`, `hiwEnabled`, `autoTriggeredActionsEnabled`, `judgementAutomation`, `markAutomation`, `abilityTemplateCleanup`, `abilityTemplateSeconds`, `rollDialogPillUI`; its message flags for "choose one" picks; its item flags (its own automation of an ability); its "Unspent Triggered Action" effect and its Judgement / Mark effect flags. |
| Calls | Its API for frightened, taunted and grabbed (setting **Targeted conditions** = Automatic and its conditions on), forced movement (push, pull, slide, collisions, undo by its log), the square picker (self teleports, slides) and squad turn labels. |
| Stands down | Where an ability carries Combat Tools' own automation of a kind (heal, cleanse, teleport ...), the library leaves that kind to it (setting **Library: leave Combat Tools' own automation alone**). Its own Hesitation is Weakness, Judgement and Mark automation are left alone when on. |
| Locks | Its "Push 2" style buttons and Apply All on results our rows already applied. |
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
| Reads | Settings `resourceLog`, `resourceLogTokenCards` (self-check only). |
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
