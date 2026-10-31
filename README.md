# Stef's Automation Suite for Draw Steel

Automation for the [Draw Steel](https://github.com/MetaMorphic-Digital/draw-steel) system on Foundry VTT 14: when
an ability is used, its results are applied to each target at that target's own tier of success, with a per-target
summary and undo on the chat card. Think of what MidiQOL's workflow does for dnd5e, for Draw Steel ability cards.

One module, three parts:

- **The engine**: per-target damage, healing and conditions (immunities, weaknesses, minion squads, potency,
  surges, half damage), saves and ongoing damage, encounter effects, forced movement and teleports, triggered
  actions, summons, heroic resource gains, Malice and villain actions, lasting areas, the settings window and the
  API.
- **The ability library**: 175 ability and feature entries that add what the system's own data leaves out
  (conditions written in the ability text, triggered actions such as Parry or Inertial Shield, summons, resource
  gains, areas such as Wall of Fire). No rules text is shipped: entries are structured data keyed by ability name.
- **The medkit**: an **Automation** window on item and actor sheets (status per ability, disable / lock / detach,
  a custom automation editor with presets), a coverage report and maintenance entries.

Everything is applied by the Director's client; players see the results and use the card's buttons.

## Installation

In Foundry's setup screen: **Add-on Modules → Install Module**, paste this manifest URL and press **Install**:

```
https://github.com/stefozr/stef-ds-automation/releases/latest/download/module.json
```

Then enable **Stef's Automation Suite for Draw Steel** (and libWrapper) in your world.

## Requirements and compatible modules

| Module | Required? | What it adds or why |
|---|---|---|
| Foundry VTT 14 | yes | Verified on 14.369. |
| [Draw Steel](https://github.com/MetaMorphic-Digital/draw-steel) system | yes | Verified on 1.1.2 (1.2 development builds are read per card, see below). |
| [libWrapper](https://github.com/ruipin/fvtt-lib-wrapper) | yes | Saves, ongoing damage, turn deduplication, triggered actions and the system fixes wrap system methods through it. |
| Draw Steel: Combat Tools | recommended (verified 1.2.8) | Forced movement, teleports, areas and range checks go through its engine and undo log; without it the suite moves tokens in a straight line itself. Targeted conditions can use its builder. |
| Draw Steel: Target Damage | recommended (verified 1.0.8) | Its apply buttons are locked for results the suite already applied. |
| Draw Steel: ctlib, Death Tracker, Battle Log | recommended (verified 1.5.1, 1.2.2, 1.5.0) | Shared services, revival on undo, battle log entries. |
| Draw Steel: Triggers | keep disabled | The suite's own triggered actions and gains replace it. |
| [Stef's Auto FX for Draw Steel](https://github.com/stefozr/stef-ds-fx) | optional | An animation per target at the tier the suite resolved. |
| [Stef's Quality of Life Improvements for Draw Steel](https://github.com/stefozr/stef-ds-qol) | optional | Compact ability cards and table fixes; its teleport fix hands abilities the library teleports to the suite. |
| Draw Steel Plus | optional | Its item sheet gets the medkit's badge and Automation control too. |

Everything degrades cleanly without the recommended modules; `game.modules.get("stef-ds-automation").api.selfCheck()`
reports what was detected.

**libWrapper wrappers:** `DSRoll#toMessage` and `Combat#_onExit` (WRAPPER, only
  where behavior probes find the bugs, setting "Fix Draw Steel 1.1 turn bugs"; exit cleanup always
  covers our own until effects), `ActiveEffectRegistry#refresh` (WRAPPER),
  `Combat#_onEndTurn` and `SavingThrowManager.delegateSavingThrow` (MIXED: they skip repeated calls, and the
  second one rolls saves by our policy unless a policy says "Draw Steel's own"). Milestone 5 (registered at
  `ready`): `BaseActorModel#takeDamage` (MIXED: holds damage from other buttons; our own writes and errors
  of the system pass through unchanged), `DamageRoll#applyDamage` (WRAPPER: marks the system's half-damage
  clicks) and `TokenDocument#_preUpdateMovement` (MIXED: a movement gate, idle unless an overlay declares a
  `move.before` trigger). On systems that expose it, `AbilityModel#performSummon` is MIXED behind
  **Intercept native summons**. Without libWrapper the Milestone 2 and 5 features are off and selfCheck says so.

## Upgrading from the Draw Steel automation modules

Before 1.0.0 this suite was three modules: **Draw Steel: Automation Core** (`ds-auto-core`), **Draw Steel:
Automation Library** (`ds-auto-library`) and **Draw Steel: Automation Medkit** (`ds-auto-medkit`).

1. Install this module and enable it; disable the three old modules in the same step.
2. On the first load, the active Director's client imports the old data once: every world and user setting of the
   three modules (the card ledger included, so old cards stay signed), every flag stored under `ds-auto-core` on
   chat cards, combats, combatants, tokens, regions, actors, items, effects, users and folders, and the zone
   region behaviors (recreated with the new type). Each client also copies its own client settings. A
   notification says what was imported; reload once afterwards.
3. Remove the old modules.

To see what would be imported, or to run it again:
`game.modules.get("stef-ds-automation").api.migrateLegacy({ dryRun: true })` (report only) or
`migrateLegacy({ force: true })`.

## Who does what

| Client | Job |
|---|---|
| The player or Director who uses the ability | Records the targets on the card (before it is created). |
| The active Director | Applies everything and writes the result to the card in one update. |
| Everyone | Renders the Automation section from what is stored on the card; buttons ask the active Director. |

If no Director is connected, nothing is applied and the card says so; the Director can resolve it later
with **Resolve now** (or automatically, see the settings).

## What it does

When an ability is used and its card appears in chat:

1. The card remembers which tokens were targeted; on supported Draw Steel 1.2 development builds it also reads
   the system's per-target parts and token identifiers.
2. The Director's client works out each target's own **tier of success** and applies, per target:
   - **damage** with the system's own math: immunities, weaknesses, temporary Stamina, minion **squad
     pools** (one write per squad, area damage capped per minion);
   - **healing and temporary Stamina** (minions and lower temporary Stamina are skipped, as in the rules);
   - **conditions and effects** after the **potency check** against the target's characteristic, with a
     duration that ends on the right creature's turn (the system's multi-target bug is avoided);
     conditions the target is **immune** to are skipped;
   - **frightened and taunted**, with their source, through Combat Tools or the native builder; **grabbed** waits for
     confirmation unless "Apply grabbed automatically" is on;
   - **forced movement** (push, pull, slide) after the hit, with the tier's distance, the ability's and kit
     bonuses, +1 for a larger creature using a melee weapon, and the potency check; see below.
3. An **Automation** section at the bottom of the card is the card's apply / undo surface: one line per target
   (name, tier, result, status, buttons; the details are in the tooltips; client option "Compact automation
   card", on by default) with what was applied, skipped (and why) or waiting, with per row:
   - **Apply** / **Undo**, and **½** (apply half damage);
   - **✎ Edit** (Director, rows not yet applied): change the amount, apply healing as temporary Stamina,
     or change a forced movement's distance or type, then save or apply;
   - **⚡ Spend surges** (1–3 surges of extra damage on that target) and **⏫ +1 potency** (2 surges, on a
     condition the target resisted by exactly one), for the hero's owner and the Director;
   - and **Undo all** / **Apply all** / **Use my targets** below, plus **Details**, which opens Target Damage's
     panel (see 5).
4. **Undo** restores Stamina (only its own change if someone else hit the target since), deletes the
   conditions it created, gives back spent surges, and **revives** a creature it had defeated through Draw
   Steel: Death Tracker (when the Director views the creature's scene).
5. **Draw Steel: Target Damage** is left as it is, but on cards the automation resolved its panel is folded under
   **Details** (client option "Fold details on automated cards", on by default): the dice, edges and banes, Combat
   Tools' rows and Update Targets are one click away. Its buttons for results that were already applied are
   locked, so nothing is applied twice (also Combat Tools' Apply All); results Target Damage applied first are
   marked "applied elsewhere". Combat Tools' own "X teleported N squares" message for a teleport the card ran
   shrinks to one line (the card's row has the Undo; the chevron shows Combat Tools' Undo Teleport, which also
   reverses fall damage and statuses).

Each feature can be set to *Automatic*, *Ask the Director*, *Manual buttons* or *Off*, with overrides for
results by creature type and for cards posted by players. Players' buttons (when allowed) are relayed to the
Director's client and checked there. Optional: a delay before applying, waiting for Dice So Nice, and a
confirmation dialog for results that wait for the Director.

In combat:

6. **Saving throws** at the end of a creature's turn, once per "save ends" effect: the Director's
   creatures roll at once (no dialog, the card shows the result); for a hero, the player's own client
   opens the save dialog, and if nobody answers in time (60 s by default) the Director's client rolls. A
   player who closes the dialog skips the save. Prompts for one creature come one after another. Save cards
   keep their **hero token** button again (Draw Steel 1.1 dropped it).
7. **Each turn event happens once**: Draw Steel: Combat Tools' simultaneous squad turns, and a second
   Director client, no longer cause double save dialogs.
8. **Ongoing damage** such as Burning ("takes 1d6 fire damage at the start of each of their turns") posts a
   damage card once per turn: rolled, immunities and squads applied, undoable.
9. **Encounter cleanup**: save-ends and other turn/round/encounter effects are deleted when a creature
   leaves combat or the encounter ends (Draw Steel 1.1 kept them).
10. End conditions the system cannot store ("until the end of your next turn", "until it moves", "until
    it is dying") for effects set up through the API (used by the ability library).

Forced movement:

11. **Push and pull** rows move the target straight away from or towards the ability's user. With **Draw
    Steel: Combat Tools** its engine does the move (stability, walls, other creatures, objects, collision
    and fall damage, grabs) and undo replays its log; without it, straight pushes and pulls on square grids
    are moved by the module (walls and creatures stop the target, the card shows how many squares were
    left for collision damage, dealt by hand). Combat Tools' own "Push 2" buttons on a result whose targets
    were moved are locked, so nobody moves them twice.
12. **Slides, vertical moves and "push or pull"** wait for the Director: Apply opens Combat Tools' path
    picker on the Director's screen ("push or pull" asks which first). Setting **Forced movement path =
    Director picks** does this for every push and pull too. Without Combat Tools these rows are reminders.
13. **Undo** puts the creature back (unless it moved again since: then it stays and the row says so),
    reverses the move's own collision damage (damage dealt since stays), broken objects and ended grabs,
    and revives creatures the collision killed.
14. **+1 potency** surges work on forced movement the target resisted by exactly one.
15. `@spend` in a forced distance uses what the user chose to spend in the roll dialog.
16. **Teleport** and forced movement cards from the API (`api.teleport`, `api.forcedMovement`), with undo,
    for macros and the ability library (M4). Combat Tools' own teleport effects keep their own buttons.

Ability library (content comes from the built-in **ability library**, the user interface
from the **medkit**):

17. **Overlays** describe what an ability does beyond the system's own power roll effects: conditions from
    the ability text (statuses or the ability's own effects, with potency, ends and "until the start / end
    of your next turn"), healing (also spending Recoveries, the user's or the target's own), temporary
    Stamina, ending effects ("end one effect that a save ends"), surges / heroic / epic resource /
    Recoveries, forced movement, teleports and reminders. They are looked up by the ability's identifier
    when it is used: **nothing is written to items**, every copy (actor, token, compendium) is covered.
18. **Your own row**: effects on the ability's user ("you gain 2 surges") get a row of their own on the
    card; abilities without a power roll (Catch Breath, Defend) work too. Effects can go to allies or
    enemies only, apply on some tiers, only when the user spent their resource on the Spend option or is
    strained.
19. **Choose one**: an overlay's options are picked in the system's Use Ability dialog (from 0.15.0; Use Ability
    stays disabled until each group has a pick) and stay on the card as buttons, the pick highlighted and changeable
    until a row of it is applied; the rows of the other options are skipped. Draw Steel: Combat Tools' own "choose one" picks are honoured (only the picked option's
    applied effects and rows).
20. **Ending effects** with more candidates than allowed ask which (Apply opens a list; from 0.14.0 the affected
    creature's owner is asked first, see 45).
21. **Self teleports** (Black Ash Teleport): the token's owner picks the square on their own screen with
    Combat Tools' picker, the Director's client records the move for undo. In automatic mode, Black Ash opens
    the picker on use, then offers Hide at a qualifying destination. That attempt allows hiding while observed;
    a successful Hide grants one surge. Hide, the surge and teleport are recorded for Undo.
22. **Combat Tools first**: where an ability carries Combat Tools' own automation of a kind (its heal,
    cleanse, teleport... buttons), the library leaves that kind to it.
23. **Detach** (medkit): the library's automation can be copied onto an item as editable `dsAuto.*`
    special effects; they survive Combat Tools' enhanced-ability refresh and the system's Update Source.
    Per item: options, disable, lock, re-sync, reset.
24. A card nobody prepared (its author's client failed) is taken over by the Director when the library
    automates its ability.

Triggered actions (the reactions come from the library's `triggers` and `trackers`):

25. **Prompts with a countdown**: when a creature could use a triggered action from the library (Parry,
    Inertial Shield, Riposte, My Life for Yours, Word of Guidance, Hesitation is Weakness, Unearthly
    Reflexes, In All This Confusion, the Arixx's Skitter), its owner's client shows one dialog listing every
    option (cost, whether it uses the round's triggered action, the resource they have, an optional or
    needed spend, a bleeding warning) with a countdown (20 s by default). **Decline** is the default button;
    **Not this round** stops asking about that ability until the round changes. No player online: the
    Director answers (or nobody, setting "Owner not connected"). The Director sees who is being asked, with
    a **Release** button; a player whose own click waits sees "Waiting for triggered actions".
26. **Holds**: damage from our cards waits before anything is written (no Stamina change, no Death Tracker
    card while the prompt is open; the card says "Waiting for triggered actions: the defender (Parry)").
    Damage from the system's Apply button, Target Damage rows and Combat Tools waits at most 13 s (a 10 s
    prompt; Target Damage gives up after 15 s). A damage-dealing roll waits in its roll dialog for an edge (Word of
    Guidance); "Roll without waiting" always works.
27. **Halving and potency**: a halving never stacks with another or with "Apply half"; the row says
    "halved by Parry (the defender)". A potency change re-checks the conditions and forced movement of that
    target (a push that is now resisted does not move).
28. **Trigger cards**: every reaction whose effect landed posts a card with the round's triggered action,
    the heroic resource it cost and what it did; **Undo** on it (Director only) gives the triggered action
    and the cost back and takes that reaction off the hit (the other reactions stay). Undoing the hit
    itself keeps the reaction: the Director sees "Parry (the defender) is still spent" and an "Undo triggered
    action" button; applying the hit again uses the same reaction without asking.
29. **The round's triggered action** is tracked per creature on the combat, together with Combat Tools'
    "Unspent Triggered Action" effect when it has one; free triggered actions never use it.
30. **Follow-ups** run on the owner's client: an ability used in response (My Life for Yours, In All This
    Confusion's teleport) opens its own roll dialog with the target set; a free strike (Riposte) asks
    Strike / Skip first.
31. **Judgement and Mark**: when the judged or marked creature drops to 0 Stamina, the censor's or
    tactician's owner is asked to use the ability on a new target (once our card and its forced movement
    are done; a revive closes the prompt); using it again ends the older effect; Mark also ends when the
    tactician is dying.
32. **Hesitation is Weakness** after a hero's turn, unless Combat Tools' own automation does it.

Summoning (0.8.0, with the library 0.3.0):

33. **A Summon row** on the summoner's own line of the card ("Summon 1 Source of Earth · within 10 squares · you
    place it on your screen"). It is never applied by itself and never by **Apply all**. The stat block is
    imported once per ability (or reused) into the Director's folder "Summons (ds-auto)" while the card resolves.
34. **Placing**: the summoner's owner (or the Director) clicks **Summon**, chooses the creature when the ability
    offers several, and places the previews on their own canvas: too far, occupied, outside the map or on another
    level is refused while picking; right-click skips one, Escape cancels. The Director checks every square again
    and creates the tokens: the summoner's side (or hostile), owned by the summoner's players, at the summoner's
    elevation. The Director's own summon rows can use the nearest free squares instead (setting **Director's summon
    placement**).
35. **Combat**: a summon made while its summoner's token is in a started combat joins it. Minions go into a squad
    (joining one of the same summoner and creature that has not acted yet, else a new "Group N" with Combat Tools'
    labels). A summon that "acts right after you" waits at initiative 0 and becomes current as soon as its
    summoner's turn ends (setting **Summons act after their summoner**).
36. **Ends**: at the summoner's next turn start or turn end, at the end of the encounter (setting **Summons at
    the end of the encounter**), when the summoner is dying, at 0 Stamina (after 2 s), or by hand: the row's
    **Dismiss** button (the summoner's players, the Director) or **Undo**. The Director gets a whisper listing what
    was removed and why.
37. **Persistent upkeep** (Summon Source of Earth): at the summoner's turn start their player is asked **Keep** or
    **Let it go** with a countdown (30 s); Keep posts a small card that spends the cost (undoable). Stamina
    carries over between summons in one combat, and a summon reduced to 0 Stamina locks the ability until the hero
    earns a Victory.
38. **Persistent abilities** (0.14.0; The Flesh, a Crucible, No More Than a Breeze, Swarm of Spirits ...): at the
    user's next turn start their player is asked **Keep** or **Let it go** (30 s, as summons); Keep spends the cost
    on a small undoable card. The Flesh then makes its power roll again at the same target without essence (the card
    says "no essence spent"); Breeze, Luminous Champion Aloft, Subverted Perception, Magma Titan and The Green keep
    their effect until the next decision; Swarm of Spirits rolls again at every enemy in the aura and keeps the aura.
    Let it go, no answer by the end of the turn or a cost that cannot be paid ends it (a note says why). Setting
    **Persistent abilities** (Summons tab).

Known limits of summoning: "with the summoner" is a chain like "after"; hexagonal grids are refused; summons
appear at the summoner's elevation, with no line-of-effect check; a combat created but not started gets no
summon combatants, and a summon made outside combat is not added to a combat that starts later; a held summon
shows as "acted" in the tracker until its chained turn; undo never restores turns the chain changed; usage limits
and "can't regain Stamina" are notes; Ravenous Horde, winded joins, the Summoner class module's abilities,
clones and transforms are not automated. Native summons on supported Draw Steel 1.2 builds use the same placement
engine (see "Draw Steel 1.2" below).

Surprised (round 1 only): the system never removes Surprised, so from round 2 on a creature that is still
Surprised can use triggered actions again; at the end of round 1 the Director gets one whisper listing the
creatures still Surprised.

Known limits: squads, Stamina loss (bleeding) and collision or fall damage are never held; damage from
other buttons that is halved is logged unhalved by Battle Log; another hit on the same creature during a
hold can use up Combat Tools' cover immunity meant for the held hit; bleeding while using a triggered
action that posts no ability card is a reminder row, not an automatic Stamina loss; prompts go to the
creature's owners (the user whose character it is first), never to a second Director.

Resources and zones (0.9.0, with the library 0.4.0):

39. **Resource gains**: class features that give heroic resource when something happens (Ferocity and Damaging /
    Primordial Ferocity, Wrath, Essence, Discipline, Insight, Focus, Clarity and Strain, Drama) become **undoable
    rows**: on the damage card when our damage caused them ("+1 Ferocity · Took damage · now 4"), otherwise on a
    small public **Resource gain** card (damage from other buttons that the Director's client saw land, Combat Tools
    pushes, ability cards, natural rolls, winded, a hero's death). "First time each round" (or each encounter) is
    tracked per hero and rule on the combat; undoing the hit also undoes the gains it caused. Setting **Resource
    gains** (Automatic; Ask the Director makes every row wait for a click). Rows the rules leave to the table (the Null
    Field assumed up, the Troubadour's line of effect, a dealer or damage type only a player's report vouches for)
    wait for the Director and are not part of **Apply all**.
40. **Surge gains from abilities** (Battle Cry, Orison of Victory): the system's "gain N surges" results become rows
    per target at its tier (setting **Resources**); the system's own gain button is locked once our row applied it.
41. **Hero tokens on a lethal hit**: when our damage would leave a hero at 0 Stamina or less and the party has 2 or
    more hero tokens, the hero's player (the Director for a hero without one) is asked with a countdown while the card
    waits; **Spend** heals the recovery value before the hit lands (a "Hero tokens" row tied to the hit: undoing the
    hit undoes it, a hit that does not land gives the tokens back). One spend per hero per turn. Setting **Hero tokens
    on a lethal hit** (on).
42. **Malice**: a monster's triggered action pays its cost from the Malice pool (refused when the pool is short);
    `api.malice.adjust` posts an undoable Malice card (Directors). At a monster's turn start the Director gets a
    whisper listing the malice features the pool can pay, with **Use** buttons (setting **Malice reminders**).
    Villain actions are marked used per encounter, and a second use or a second villain action in the same round gets
    a whisper and a card banner (setting **Villain action tracking**).
43. **Areas** (Wall of Fire, Righteous Phalanx, Incinerate, Acid Spew, Swamp Gas, Unquiet Ground): an **Area** row on the user's own
    line ("Wall 5 within 10 · lasts: until its creator's next turn · hits enemies"). Its **Place** button lets the
    creator's player (or the Director) place the squares on their own canvas, or reuse the template the system already
    placed for the card; bursts and auras appear around the creator. The Director creates the area (a region with
    the "Automation Zone" behavior, visible to everyone, editable by the Director only). A creature that enters it
    (once per round) or starts its turn there takes the damage through a normal damage card (immunities, squads,
    Death Tracker, triggered actions, hero tokens and gains included); per-square areas count the squares crossed.
    The area ends at its creator's next turn (with Persistent upkeep asked, as for summons), at the end of the
    encounter, when its creator is down, by **Dismiss** or **Undo**. Setting **Areas**: on Automatic, an area the
    ability drew on use (or a burst / aura around its creator) is applied when the card resolves, without a Place
    click ("from the area drawn on use"); Ask and Manual keep the Place button. An area can also be difficult
    terrain (Unquiet Ground): the ground moves of the creatures it affects cost double; flying, jumping, teleports
    and forced movement do not; Radical heroes ignore it. Setting **Area damage**.
44. **Summon activation**: a player's click on their own summon's turn in the tracker is relayed to the Director's
    client (the server refuses it otherwise); a summon that acts right after its summoner, or another creature's
    running turn, is refused with a message.

Picks and areas (0.14.0, with the library 0.8.0):

45. **Picks and areas**: effects on "a creature within N squares" are picked by the user's owner on their own screen
    (with a damage type when the ability lets them choose); effects on "each ally in the area" reach the creatures
    inside the placed area. Cleanse choices go to the affected creature's owner. A trigger's spend with a use step
    is ticked in the ability's own dialog. Self teleports can buy extra squares with a resource. Modifier rows
    (damage weakness) end at the creature's next turn.

Known limits of resources and zones: Conduit prayers and domains, Melodrama, Talent strain damage and other gains not
listed above are not automated; spends through the system's own hero-token buttons do not count toward "one per
turn" (the dialog reminds the player), and damage from other buttons never offers hero tokens; a Stamina value set
by hand on a sheet is a correction, not damage; areas ignore line of effect; difficult terrain applies to tokens on
the viewed scene only (core's terrain costs), and overlapping difficult zones multiply; areas are refused on
gridless and hexagonal scenes, and only the Director moves or reshapes one; a region created over creatures does not
count as entering (a "displace" move does); areas are sized in squares, so the scene's grid distance must be 1
square, as the system's own templates expect (the self-check warns); Local Fixes' "Undo Last Activation" restores
the heroic resource to its old value even when a gain row stays applied: undo the gain row first, or afterwards add
the erased amount back on the sheet and leave the row as it is. Monster abilities that only borrowed a hero overlay (Overwatch,
Inspiring Strike, Soul Burn, Psychic Pulse) are manual now: monsters only get monster overlays.

## Surges

The hero's owner (or the Director) spends surges from the card, whatever "Who may use card buttons" says;
retainers use their mentor's surges. Extra damage is a row of its own that adds to the hit: immunity and
weakness count once for the whole hit, squads take it into the pool (with the area cap). The row follows
its base row's mode: if the base damage was applied automatically, the surge damage lands at once;
otherwise it waits for the Director like the base row. Surges are paid when the row lands and refunded
when it is undone. The system's own "Modify Damage Roll" menu still works: it adds a new manual row for
every target of that tier.

## Homebrew and feature automation

Open an item's **Automation** window and choose **Edit automation** in the Medkit. Add a rule,
choose when it runs and whom it affects, then add damage, healing, conditions, resource gains,
movement or modifiers. Formulas use the item's roll data (`@M`, `@A`, `@R`, `@I`, `@P`, `@tier`,
`@spend` and `@target.*`). Save writes only that item's version 1 automation flag. World presets are
independent copies; editing one item does not change other items that used the preset.

Bursts and auras center their native template on the user and select valid targets before the roll.
Aimed areas ask for one placement. The global automatic-area setting and the item's Area option
can select manual placement instead. Cancelling the roll removes its newly created area.

On-use homebrew rules post separate recorded feature cards after the ability resolves. Damage runs
before conditions and movement; each feature card has its own Undo. Optional Wards and Barbed Tail
ask their owner. Goblin Mode has one shared Director prompt per event across its encounter copies.
Performance selections are maintained on the actor; Routines asks each round, Medley allows two,
and the visible auras follow their performer. Recipient bonuses expire on the recipient's turn.
Spotlight points are spent before permanent heroic resource and unused points expire.

Only explicitly configured mechanics are automated. Rules do not infer arbitrary homebrew prose,
line-of-effect or safe teleport destinations from descriptions; movement requiring a destination
asks for one. The installed feature families and additional live checks are listed in
[FEATURE-AUTOMATION.md](docs/FEATURE-AUTOMATION.md).

## Settings window

Open **Settings → Configure Settings → Stef's Automation Suite → Open settings** as a Director.
The twelve tabs are General, Modes, Players, Conditions, Saves and ongoing, Movement, Library, Triggered actions,
Summons, Resources, Other modules and Maintenance. World options live here; the plain Foundry list keeps the
master switch and the four client options (prompt dialog, compact automation card, fold details on automated
cards, debug logging).

Each settings tab can reset its options to defaults. Maintenance offers the self-check, Prepare to uninstall,
a Cleanup report and entries supplied by the medkit. The cleanup report counts data; the API performs cleanup.

## Mode by creature type

In Modes, choose Inherit, Automatic, Ask the Director or Manual buttons for heroes, retainers, NPCs, minions,
summons and objects. The category is the **target** of a result; our summon tokens take priority over their actor's
other category. A feature set to Off stays off. Player-card restrictions and safety downgrades can still make a
card more restrictive. The overrides also apply to ongoing damage and area hits.

The active Director migrates the old hero override once. `heroOverride` remains a readable fallback for this minor
version; use the settings window for new changes. `api.modeFor(creature, "damage")` reports the category and world
mode, before per-card restrictions.

## Targeted conditions

**Targeted conditions = Automatic** uses Combat Tools while its conditions are enabled, otherwise the core's
native builder. **Native** always uses the builder; **Off** leaves these conditions to the table. Native effects
use the system's own frightened, taunted and grabbed statuses and source actor references. Frightened and taunted
replace their earlier source; grabbed can have several. Undo restores the earlier effect or sources.

A defeated source expires our native targeted effects; revival reactivates them. Dying alone does not end them.
The target's owner or a Director can end them with `api.endTargeted(actor, "grabbed", {sourceUuid})` (omit the
source to end the whole effect). With Combat Tools enabled, use this API or delete a native effect rather than
relying on its HUD toggle.

Native taunted needs the attacker's token controlled for the system's roll modifier. Native frightened warns the
moving player when they move closer; it does not block movement. Native grabs do not enforce one grab per grabber
or make the grabbed token follow its source. Grab still waits for confirmation unless automatic grabs are enabled.

## Draw Steel 1.2

Support is implemented against the 1.2.x development source contract recorded in the M8 design. It has not been
verified in a live development world or against a released 1.2 system; the manifests continue to verify **1.1.2**.

The reader is chosen per card: old and untargeted cards use tier parts, while supported targetResult cards match
by token identifier, or by actor when no token identifier is supplied. Ambiguous tiers become manual under
mixed-tier safety. Development builds without the token identifier schema stay manual. Squad damage is grouped
across target parts, natural-roll gains count once per card, and card potency adjustments re-check that target.
The system's per-part damage, condition and resource buttons are locked once the corresponding result is applied.

**Intercept native summons** keeps the system's selection and cost dialogs but places previews on the clicking
user's screen and asks the active Director to validate and create the tokens. It is inert on 1.1.2. Native summons
act after their summoner, last until encounter end or dismissal, and join squads when they are minions. Cancelling
returns no tokens; successful placement lets the system charge its portfolio cost. **Undo does not refund that
system-charged cost**; the summon card states this.

## The ability library

- Conditions written into the ability text: statuses and the ability's own effects ("the target is
  judged", "you are weakened (save ends)", "Defending"), with potency and ends, and "until the start /
  end of your next turn".
- Healing: spending Recoveries (Catch Breath, Heal, My Turn!), temporary Stamina (Iron, Steelbreaker,
  Shield of the Righteous by tier).
- Ending effects: "end one effect that is ended by a saving throw or ends at the end of their turn",
  standing up from prone.
- Surges, heroic resource ("gain 1 clarity"), self damage on strained Talent abilities.
- Self teleports (Black Ash Teleport, In All This Confusion: the player picks the square), teleports of
  allied targets. Black Ash opens its picker automatically in automatic mode, offers its special Hide after
  teleporting into cover or concealment, and grants one surge when Hide succeeds.
- Choose one: the options are buttons on the card (Heal, Primordial Bane's element, Time Bomb's damage
  type, ...).
- Fixes of system data where an applied effect meant for the user would land on the target (Claw Dirt,
  Method Acting, Gravitic Charge).
- A reminder on the card of what stays by hand for that ability.
- **Triggered actions** (0.2.0, with the core's triggered actions on): Parry, Inertial Shield and Unearthly
  Reflexes halve the damage before it lands (and lower potency); Riposte offers the ally a free strike;
  My Life for Yours heals an ally who took damage; Word of Guidance adds an edge to an ally's roll;
  Hesitation is Weakness takes the next turn; In All This Confusion halves, then teleports; the Arixx's
  Skitter halves for the Director. The owner is asked with a countdown; the cost and the round's triggered
  action are recorded with undo.
- **Trackers** (0.2.0): when a creature judged (Judgement) or marked (Mark) drops to 0 Stamina, the censor
  or tactician is asked to pick a new target; using it again ends the older effect.
- **Summons** (0.3.0): Summon Source of Earth (the elementalist's source acts right after them, is kept
  each turn by paying Persistent 2, keeps its Stamina through the encounter and locks the ability at 0),
  and the Director's reinforcements: Get in Here! (Goblin Monarch), Call Abyssal Hyenas (Gnoll Abyssal
  Summoner), Arise, My Children (Vampire Lord), An Army From Blood (Hobgoblin Bloodlord, next to the
  target) and New Dawn (Angulotl Daybringer). The clicker picks the squares on their canvas; the minions
  join a squad and the summons leave at the end of the encounter.
- **Resource gains** (0.4.0): the heroic resource the party's class features grant on events, once per
  round or encounter, as undoable rows: Ferocity (damage taken; winded or dying 1d3), Wrath (your judged foe
  and you), Essence (typed damage within 10), Discipline (a main action in the Null Field, the Director's
  Malice abilities; the field row waits for the Director), Insight (damage with a surge), Focus (your marked
  foe damaged, an ally's heroic ability), Clarity and Strain (forced movement), Drama (three heroes in a turn,
  a hero winded, a natural 19 or 20, a hero's death). Upgrades (Damaging / Primordial Ferocity, ...) replace
  the amount.
- **Lasting areas** (0.4.0): Wall of Fire (per square, Persistent 1), Righteous Phalanx, Incinerate (a bigger
  column when strained), the Arixx's Acid Spew, the Goblin Stinker's and the Delian Tomb Toxinaut's Swamp
  Gas: placed on the canvas, they damage creatures that enter, move in or start their turn in them, and go
  when their time is up.
- **Monsters** (0.4.0): Sword Stab and Shadow Stab (the edge bonus as a click), Mystic Queen Bargnot's
  Oversurge (she is dazed), Dame Cornelia's Parry! (halves a strike's damage). From core 0.9.0 monsters
  never borrow a hero overlay of the same name: the coverage report lists those left manual.
- **Wave 3** (0.4.0): Glowing Eyes (the card for the damage when you are hit), Impart Force, Dance of Blows
  and Choke (their extra damage and forced movement as clicks).
- **Damage weakness** (0.8.0): Weakening Brand gives the target weakness equal to the roll characteristic until
  its next turn ends (undoable).
- **Target picks** (0.8.0): "a creature within N squares" is picked by the user's player on their own screen
  (Practical Magic, with the damage type; The Green Within, the Green Without, near the target).
- **Allies in the area** (0.8.0): Test of Rain ends an effect on the user and each ally in the cube; each
  creature's owner chooses which.
- **Spend in the ability's dialog** (0.8.0): My Life for Yours pays its Wrath spend in the ability's own roll
  dialog, ticked from the reaction prompt.
- **Teleport boost** (0.8.0): Practical Magic's teleport buys extra squares with essence.
- **Difficult terrain** (0.8.0): Unquiet Ground's area costs enemies double for ground moves; areas drawn on use
  (Incinerate) are applied when the card resolves.
- **Persistent abilities** (0.8.0): The Flesh, a Crucible rolls again for free when kept; No More Than a Breeze,
  Luminous Champion Aloft, Subverted Perception of Space, Magma Titan and The Green Defends Its Servants keep
  their effects while kept; Swarm of Spirits rolls again at every enemy in its aura and keeps the aura.

Nothing is written to your items, and no rules text is shipped: overlays carry only structured data and
short reminders in our own words. Abilities Draw Steel: Combat Tools automates itself keep its buttons.

### Authoring library entries

`AUTHORING.md` explains the format and the rules. Tools (Node 20+):

```
node tools/index-system.mjs    # index the system's packs into .cache/ (once, and after a system update)
node tools/show.mjs <dsid>     # what the index knows about an ability (--folder "Talent" --enrichers)
node tools/validate.mjs        # schema, references, licensing lint
node tools/build.mjs           # validate + dist/overlays.mjs + dist/coverage.md
node tools/dist-check.mjs      # dist/overlays.mjs built from the current src/overlays and version? (CI; no system data)
node tools/review.mjs <group>  # overlays next to the ability text
```

The tools read the system packs from a copy, so Foundry can keep running. They need `classic-level`: from
`npm install` at the repository root (or any `node_modules` above the tools), `DS_AUTO_NODE_MODULES`, or the npx
cache. From 0.4.0 the index also reads the class features, the Delian Tomb's monsters and malice features and the
adventures' actors when those modules are installed (see `AUTHORING.md`). `dist/overlays.mjs` is committed; its
first line holds the version and a hash of `src/overlays`, so rebuild after every overlay or version change
(`dist-check.mjs` fails otherwise).

## The medkit

- **Edit automation**: build rules as **When → Who → What**, with damage, healing, movement, conditions,
  resources and modifiers. Advanced settings contain filters, duration, costs and trigger requirements;
  advanced effect settings contain tier, potency and other gates. Presets and ability settings have their
  own expandable sections. **Save automation** remains accessible while scrolling; changes stay in the
  draft until saved. Reset custom automation is under Ability settings.
- **Ability sheets** (stock and Draw Steel Plus): a status badge in the title bar and an **Automation**
  header control. Statuses: Native (only the system's own effects), Automated / Configurable (the library
  adds automation), Customized (entries on the item), Outdated (detached from an older library version),
  Unavailable (the overlay needs an inactive module), Combat Tools (Combat Tools automates everything the
  library would add), Disabled, Locked, Manual.
- **Automation window** of an ability: the key the library knows it by, the system's own effects (and which
  the library replaces), the library's effects in plain words, its **triggers** (when it can react, to whom,
  what it does, the spend, the cost and whether it uses the round's triggered action) and **trackers**
  (Judgement and Mark: a new target at 0 Stamina), summons (which stat block, how many, when it acts, how
  long it lasts), what is left to Combat Tools, Combat Tools' enhanced
  state, options, and the actions:
  - **Disable / Enable**: the card's rows wait for a click, library effects are ignored;
  - **Lock / Unlock**: freeze the automation as it is;
  - **Detach**: copy the library automation onto the item as editable special effects (they survive
    Combat Tools' enhanced-ability refresh and the system's Update Source);
  - **Re-sync** (outdated detached items) and **Reset** (back to the library).
- **Actor sheets**: an **Automation** header control with every ability's status and bulk actions; for
  NPCs the monster key monster-specific overlays match, with a pin when the automatic key is wrong; and
  whether the actor's triggered action of this round is available, used (by which ability) or not tracked;
  and the actor's live **summons** (scene, how long they last) with a Dismiss button (core 0.8.0).
  With (core 0.9.0): for heroes, their **resource gains** (each rule with the amount their upgrades give,
  and whether it was used this round or encounter, with a Release button for the Director); for NPCs, the
  **villain actions** used this encounter (Reset for the Director); for everyone, the live **areas** they
  created (Wall of Fire, Swamp Gas, ...) with a Dismiss button.
- **Class feature sheets** (core 0.9.0): a feature whose library overlay has resource gains (Ferocity,
  Focus, Drama, ...) gets the badge and the Automation window, which lists its gains (event, amount, once per
  round / encounter, upgrades) with Disable / Enable (a disabled feature grants nothing).
- Areas in the ability window: "Area: Wall of fire · Enters / Starts turn inside · enemies · until its
  creator's next turn" and the damage.
- **Settings > Automation coverage**: per ability compendium, how many abilities the library, the system,
  or nothing automates.

Nothing changes on an item unless you press an action, and then only the suite's own flags and
special effects.

### Maintenance entries

With Stef's Automation Suite 0.10.0 the core's settings window (**Configure Settings > Draw Steel: Automation
Core > Automation settings**) has a **Maintenance** tab, and the medkit adds two entries there:

- **Automation coverage**: the coverage report above.
- **Customized items**: the world's items and the actors' items whose automation is stored on the item (Customized,
  and Outdated detached copies), with links to them. A library update does not reach these items, and the core's
  cleanup (before an uninstall) can remove their entries; nothing is changed by the list itself.

With an older core nothing changes: the coverage report stays in the settings list.

### Medkit settings

- **Medkit: who may open it** (world, default Assistant GM). Changing an item also needs ownership.
- **Medkit: status badge on ability sheets** (client).

## Coexistence

See [the coexistence contract](docs/COEXISTENCE.md) for the settings and APIs read from Combat Tools,
ctlib, Target Damage, Death Tracker, Battle Log, Triggers, Resources UI, Local Fixes and Draw Steel Plus.

**Verified family versions:** Combat Tools 1.2.8, ctlib 1.5.1, Death Tracker 1.2.2, Target Damage 1.0.8,
Battle Log 1.5.0; Draw Steel: Triggers is meant to stay disabled (the suite's triggered actions and gains run instead).
`selfCheck()` reports a family module outside this list (`unverifiedVersion`) and the Director gets one warning per
version set.

## Known limitations

- Only mechanics the system data or the library describe are automated; rules prose is never interpreted. Each
  card says what stays by hand.
- Nothing is applied while no Director is connected; the card waits and **Resolve now** catches up.
- Live-verified with Draw Steel 1.1.2 and the Combat Tools family listed above. Other versions are reported by
  `selfCheck()` (`unverifiedVersion`); check a session's worth of abilities after updating that family.
- Draw Steel 1.2 support is implemented against development builds only (see above).

## Uninstall

Before disabling the modules, open **Maintenance → Prepare to uninstall** as the active Director. It counts the
cards, asks for confirmation and removes our sections from ability cards; cards consisting only of our section
become readable plain text. Their undo history is removed. Review **Cleanup report**, then use the API for the
remaining areas, until effects, summon tokens or customized items:

```js
const api = game.modules.get("stef-ds-automation").api;
await api.stripParts(); // dry run
await api.stripParts({dryRun: false});
await api.cleanup(); // dry run
// Optional: removes summons and detached item customizations; deletes empty summon folders.
await api.cleanup({dryRun: false, summons: "dismiss", items: "remove", folders: "delete"});
```

Cleanup leaves native targeted effects in place because the system can read them. Its default non-dry-run actions
also dismiss our areas and convert until effects to effects that must be removed by hand. See
[the uninstall guide](docs/UNINSTALL.md) for the complete cleanup table and tradeoffs.

If the core is already disabled, this standalone Director macro strips our sections using Foundry alone. It
cannot recover text summaries for cards that were only ours: they stay invisible unless `DELETE_OURS` is true.

```js
if (!game.user.isGM) throw new Error("Run this macro as a Director.");
const DELETE_OURS = false;
const Del = foundry.data.operators.ForcedDeletion;
const partsOf = m => Object.entries(m._source.system?.parts ?? {});
const isOurs = ([, p]) => p?.type === "dsAutoResolution";
const touched = game.messages.filter(m => partsOf(m).some(isOurs));
const onlyOurs = touched.filter(m => partsOf(m).every(isOurs));
const toDelete = DELETE_OURS ? onlyOurs.map(m => m.id) : [];
const updates = touched.filter(m => !toDelete.includes(m.id)).map(m => {
  const u = {_id: m.id, "flags.stef-ds-automation": new Del()};
  for (const [id, p] of partsOf(m)) if (isOurs([id, p])) u[`system.parts.${id}`] = new Del();
  return u;
});
for (let i = 0; i < updates.length; i += 100)
  await ChatMessage.implementation.updateDocuments(updates.slice(i, i + 100));
for (let i = 0; i < toDelete.length; i += 100)
  await ChatMessage.implementation.deleteDocuments(toDelete.slice(i, i + 100));
ui.notifications.info(`Stripped ${updates.length} chat card(s), deleted ${toDelete.length}.`);
```

## API

See [the full API reference](docs/API.md) for signatures, permissions, return values and hooks.
`api.apiVersion` is 1; `api.version` follows the installed module. The resolution record is internal.
`api.compat` and the library's `api.overlays` return frozen shallow snapshots.

Diagnostics live under `api.debug` and require a Director. The old `dump`, `request`, `triggers.offer` and
`zones.hit` paths warn once. Raw internal relay actions are refused
unless a Director explicitly uses `api.debug.request(payload, {internal: true})`.

## For developers

```js
const api = game.modules.get("stef-ds-automation").api;
api.selfCheck();                                   // environment report
api.debug.dump(messageId?);                              // record of a card
api.resolve(messageId, { force });                 // (re)resolve a card, applied results are kept
api.applyOps(messageId, opIds?, { half });         // apply pending ops (all if omitted)
api.undoOps(messageId, opIds?);                    // undo applied ops (all if omitted)
api.retarget(messageId, tokenUuids);               // rebuild a card for other tokens
api.surge(messageId, opId, { count });             // 1-3 surges of extra damage on a damage row
api.surge(messageId, opId, { potency: true });     // +1 potency for 2 surges on a resisted condition
api.applyDamage({ targets, amount, type, ignoredImmunities, aoe, source, flavor, half, kind, mode });
                                                   // post a damage / heal / temp card with undo (Directors)
api.rollSave(effectOrUuid, { policy });            // roll a save-ends effect's save now (active Director)
api.until(effect, { event: "turnEnd", combatantId }, { keepExpiry });
                                                   // end conditions: turnEnd | turnStart | dying | moves
api.ongoingSpecs(effect);                          // what the ongoing-damage tick would roll
api.editOp(messageId, opId, { amount, temp, distance, movement }, { apply });
                                                   // change a row first (null = back to the ability's value)
api.forcedMovement({ targets, movement, distance, source, vertical, ignoreStability, properties, path, mode, flavor });
                                                   // force-move creatures on a card with undo (Directors)
api.teleport({ token, distance, teleportMode, partner, destination, animate, mode, flavor });
                                                   // teleport on a card with undo (Directors; no destination:
                                                   // the active Director picks the square via Combat Tools)
// Milestone 4: ability library
api.library.registerSource({ id, overlays, priority }); // content modules, on Hooks.once("dsAuto.init")
api.library.find(item);                            // the overlay an item uses (monster-specific first)
api.library.resolve(item);                         // layers, effects, status the engine will use
api.library.status(item);                          // locked | disabled | outdated | customized | unavailable |
                                                   // covered | configurable | automated | native | manual
api.library.info();                                // sources, counts, invalid overlays, key collisions
api.library.validate(overlay);                     // the schema check content goes through
api.library.configure(item, values) / disable(item, bool) / lock(item, bool) / detach(item) / resync(item) / reset(item)
api.debug.request({ action: "choose", messageId, group, option }); // pick a "choose one" option on a card
// Milestone 5: triggered actions
api.triggers.active();                             // engine on (settings, not deferred to Draw Steel: Triggers)
api.triggers.reactors(actorOrUuid);                // [{itemUuid, name, triggers, trackers}] of its abilities
api.triggers.budget(actorOrUuid);                  // {tracked, available, source, usedAbility, round}
api.triggers.open();                               // prompts open now (active Director)
api.triggers.release(promptId);                    // cancel a prompt, counts as declined (active Director)
api.debug.triggers.offer(event);                         // dev / testing: ask the reactors of a trigger event; no hold, no card
api.summon({ summoner, actor, quantity, distance, places }); // Director: a summon card ("pick" | "auto" | squares)
api.summons.list(filter?);                         // live summons from token flags (any client)
api.summons.of(actorOrToken);                      // summons of a summoner
api.summons.dismiss(summonId);                     // relayed: the Director, the summoner's or the summon's owners
api.summons.worldActor(compendiumUuid, item);      // active Director: the world actor of a stat block for an ability
// Milestone 7: resources and zones
api.resources.rules(actorOrUuid);                  // a hero's gain rules [{featureKey, ruleKey, rule, amount, formula}]
api.resources.ledger(actorOrUuid, combat?);        // {round: {...}, encounter: {...}} entries of the hero
api.resources.release(actorOrUuid, ruleKey, { encounter }); // active Director: free one entry (re-grant by hand)
api.resources.heroTokens();                        // the party's hero tokens
api.malice.value();                                // the Malice pool
api.malice.adjust(delta, { reason });              // Directors: an undoable Malice card
api.villain.used(actorOrUuid, combat?);            // villain actions an NPC used [{dsid, name, round, messageId}]
api.villain.reset(actorOrUuid?, combat?);          // active Director: forget the markers
api.zones.list(filter?);                           // live areas [ZoneInfo] {sceneId?, creatorActorUuid?, combatId?}
api.zones.get(zoneId);
api.zones.dismiss(zoneId);                         // relayed: the Director or the creator's owners
api.debug.zones.hit(zoneId, tokenOrUuid, { force });     // active Director, dev and testing: one hit now
```

Overlays are JSON (see [docs/AUTHORING.md](docs/AUTHORING.md); the schema is
`scripts/library/schema.mjs`): `{key: "ability:<dsid>", version, name, notes?, native: {suppress?, filter?},
config?, choices?, effects: [...]}`, effect types `damage`, `heal`, `condition`, `cleanse`, `resource`,
`forced`, `teleport`, `note`. Resolution order per item: detached `dsAuto.*` entries > item flags
`flags["stef-ds-automation"]` (`disabled`, `lock`, `config`, `overlay`) > registry overlay > the system's power
roll effects. Settings: **Ability library** (on), **Library: leave Combat Tools' own automation alone**
(on), **Resources** (mode, Automatic).

Effects can declare ongoing damage explicitly with
`flags["stef-ds-automation"].ongoing = { formula: "1d6", type: "fire", when: "turnStart" | "turnEnd" }` (or a
list); otherwise the effect text is read (setting "Ongoing damage: read effect text").

Card actions are relayed to the active Director and authorized there. Registry reads and registration are
client-local; item actions use the caller's ownership permissions. See the API reference for each member.

Hooks: `dsAuto.init(api)` (content modules register overlays here), `dsAuto.medkitApplied(item, {action,
overlay, result})` (0.6.0), `dsAuto.preResolve(message, record, plan)` (return `false` to make the card
manual), `dsAuto.resolved(message, record, {reason})`, `dsAuto.preApplyOp(message, op)` (return `false` to
skip an op), `dsAuto.applyOp(message, op, patch)`, `dsAuto.undoOp(message, op, patch)`; Milestone 2:
`dsAuto.turnEvent({event, combat, combatant, actor, round, turn, activation})` (once per creature and turn start/end, active
Director), `dsAuto.preSave(effect, {policy})` (return `false` to skip the save), `dsAuto.save(effect,
result)`, `dsAuto.preOngoing(effect, spec, context)` (return `false` to skip a tick); Milestone 5 (active
Director): `dsAuto.preTrigger(event, candidate)` (return `false` to skip that reactor), `dsAuto.trigger(event,
decision)` (every outcome, once it is final), `dsAuto.trackerZero(info, outcome)`; Milestone 6 (active Director):
`dsAuto.preSummon(message, op, {actorUuid, worldActorId, sceneId, squares, userId})` (return `false` to skip the
row), `dsAuto.summon(message, op, {summonId, tokenUuids, combatId, combatantIds, groupId})`,
`dsAuto.dismissSummon(info, {reason, userId})`; Milestone 7 (active Director): `dsAuto.preGain(gainer, rule, fact)`
(return `false`: no row), `dsAuto.gain(message, op, {gainer, rule})`, `dsAuto.heroToken(message, op, {hero,
tokensBefore, tokensAfter})`, `dsAuto.preZoneHit(region, tokenDoc, {zoneId, via, squares, amount})` (return `false`:
no card), `dsAuto.zoneHit(region, tokenDoc, {zoneId, via, squares, amount, messageId})`, `dsAuto.zoneEnd(info,
{reason, userId})`.

Overlays may carry `triggers` (event `damage.before` | `damage.after` | `roll.before` | `turn.start` |
`turn.end` | `forced.before` | `move.before`, subject, range, cost and optional spend, steps `halve`, `potency`,
`edge`, `use`, `freeStrike`, `takeTurnNext`, `note`) and `trackers` (`onZero: "retarget"`, `endPrevious`,
`endOnSourceDying`); see [docs/API.md](docs/API.md). Settings (Milestone 5): **Triggered actions** (on),
**Triggered action prompt** (20 s; other buttons' damage at most 10 s), **Owner not connected** (ask the
Director), **Triggered actions outside combat** (off), **Director's creatures react** (on), **Hold damage
from other buttons** (on), **Judgement and Mark trackers** (on), **Hold rolls for triggered actions** (on),
**Leave triggers to Draw Steel: Triggers** (on).

Overlays may carry `summon` effects (`actors`, `quantity`, `distance`, `origin`, `side`, `turn`, `actsThisRound`,
`squad`, `lasts`, `upkeep`, `carryStamina`, `lockOnZero`; always on the user's own row); see [docs/API.md](docs/API.md)
and [docs/AUTHORING.md](docs/AUTHORING.md). Settings (Milestone 6): **Summons** (mode; Automatic acts as Ask), **Director's
summon placement** (pick), **Summons act after their summoner** (on), **Label summon squads** (on), **Summons at the
end of the encounter** (those whose ability says so), **Summoner potency link** (on), **Persistent upkeep prompt**
(30 s). Summon tokens carry `flags["stef-ds-automation"].summon` (the truth), the combat an index
`flags["stef-ds-automation"].summons`; the system's own summoner flag is never written.

Feature overlays (`key: "feature:<dsid>"`) may carry `gains` (event `damage` | `forcedMove` | `abilityUse` |
`naturalRoll` | `winded` | `heroDeath`, filters, `once`, resource, amount and `amountBy` upgrades, `confirm`); overlays
may carry `zone` effects (`zoneEvents`, `once`, `onceShared`, `perSquare`, `affects`, `exceptKeywords`,
`exceptMonsters`, `shape`, `size`, `width`, `range`, `lasts`, `upkeep`, `forcedCounts`; always on the user's own
row); generic overlays reach NPCs only with `npc: true`. See [docs/API.md](docs/API.md) and [docs/AUTHORING.md](docs/AUTHORING.md).
Settings (Milestone 7): **Resource gains** (Automatic), **Hero tokens on a lethal hit** (on), **Malice reminders**
(on), **Villain action tracking** (on), **Areas** (mode; Automatic applies areas drawn on use at resolve), **Area
damage** (Automatic). The
combat carries `flags["stef-ds-automation"]` `eventGains`, `eventGainsEncounter`, `zoneHits` and `villainActions`; an area
is a region with `flags["stef-ds-automation"].zone` and a behavior of type `stef-ds-automation.zone` (no
`flags.draw-steel.abilitySource`, so Combat Tools and Target Damage leave it alone).

Milestone 9 (0.14.0): library effects may use `targets: "pick"` (with `pick`) and `targets: "area"`, the effect type
`modifier`, a self teleport's `boost`, a zone's `terrain: "difficult"`, and the overlay-level `persistent` (`keep`,
`cost`, `targets`, `note`); see [docs/API.md](docs/API.md) and [docs/AUTHORING.md](docs/AUTHORING.md). New prompt types
`cleanseChoice`, `targetPick`, `persistentUpkeep`, `persistentUpkeepCancel`; hook `dsAuto.persistentEnd(entry,
{reason})` (active Director). Setting **Persistent abilities** (`persistentUpkeep`, on). The combat carries
`flags["stef-ds-automation"].persistent`; cards add `picks`, `pickAsked`, `area`, `areaTemplate` and `persistent` to the
record.

Card data: `flags["stef-ds-automation"].resolution` (record version 1, signed by the active Director; Milestone 5
adds `hold` while reactors are asked, `op.trigger` on held damage rows, and `shape: "trigger"` cards with a
`budget` op) and the
message part `system.parts.dsAutoResolve000` of type `dsAutoResolution`. If the module is disabled later,
old cards log one console error per stored part at load; the rest of the card renders normally. The
same goes for detached `dsAuto.*` special effects on items (one error per entry; the ability still works).

The library content and the medkit have small APIs of their own under the suite's API:

```js
const api = game.modules.get("stef-ds-automation").api;
api.content.overlays;      // the built library entries: a frozen copy
api.content.reregister();  // register them again (after unregisterSource, say)
api.medkit.openItem(itemOrUuid); api.medkit.openActor(actorOrUuid); api.medkit.coverage();
api.medkit.customizedItems(); // items whose automation is stored on the item
```

Other modules can add library entries the same way:
`Hooks.once("dsAuto.init", api => api.library.registerSource({ id, overlays, priority }))`.

Tests run offline with Node 20+: `npm install`, then `npm test` (see [tests/README.md](tests/README.md)).

## Stef's modules

| Module | What it does |
|---|---|
| [Stef's Automation Suite for Draw Steel](https://github.com/stefozr/stef-ds-automation) | Applies ability results per target (damage, conditions, forced movement, saves, triggered actions, summons, areas) with undo, plus the automation library and editor. |
| [Stef's Quality of Life Improvements for Draw Steel](https://github.com/stefozr/stef-ds-qol) | Small fixes and table conveniences for the Draw Steel system and the Combat Tools family. |
| [Stef's Auto FX for Draw Steel](https://github.com/stefozr/stef-ds-fx) | Sequencer animations for abilities, scaled by tier, per target with the Automation Suite. |
| [Stef's Character Sheets Evolved for Draw Steel](https://github.com/stefozr/stef-ds-charsheet) | A compact hero and monster sheet with class art, collapsible rows and a combat strip. |
| [Stef's Health Overlay](https://github.com/stefozr/stef-health-overlay) | Injury overlays on tokens by remaining Stamina / HP (Draw Steel and D&D 5e). |

## License

Code: MIT (see [LICENSE](LICENSE)).

Stef's Automation Suite for Draw Steel is an independent product and is not affiliated with, endorsed or sponsored by MCDM Productions, LLC. Draw Steel is a trademark of MCDM Productions, LLC. This module ships no Draw Steel rules text or artwork; it uses ability, feature, condition and monster names and compendium identifiers only to work with content you already have.
