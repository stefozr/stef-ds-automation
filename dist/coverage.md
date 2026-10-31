# stef-ds-automation 1.1.0: coverage of Draw Steel 1.1.2

175 overlays (14 monster-specific); 11 overlays with triggers, 2 with trackers, 6 with summons, 7 with areas, 8 with resource gains.
"overlay" = the library adds automation (\* = the system describes nothing structured for it);
"native" = only the system's own power roll effects; "manual" = nothing automated.

| Group | Abilities | Overlay | Native only | Manual |
|---|---|---|---|---|
| (character-options) | 9 | 1 | 4 | 4 |
| (origins) | 17 | 1 | 6 | 10 |
| Basic Abilities | 15 | 5 | 4 | 6 |
| Censor | 46 | 15 | 23 | 8 |
| Conduit | 68 | 7 | 35 | 26 |
| Elementalist | 53 | 13 | 22 | 18 |
| Fury | 50 | 10 | 32 | 8 |
| Imbue Abilities | 3 | 0 | 2 | 1 |
| Kits | 21 | 2 | 19 | 0 |
| Null | 48 | 9 | 25 | 14 |
| Perks | 3 | 0 | 0 | 3 |
| Shadow | 52 | 13 | 27 | 12 |
| Tactician | 43 | 13 | 13 | 17 |
| Talent | 56 | 24 | 16 | 16 |
| Troubadour | 61 | 24 | 22 | 15 |

## (character-options)

Contact Spirits *

## (origins)

Glowing Eyes *

## Basic Abilities

Catch Breath *, Claw Dirt, Defend *, Heal *, Stand Up *

## Censor

Behold a Shield of Faith!, Blessing of the Faithful *, Edict of Disruptive Isolation *, Edict of Peace *, Edict of Perfect Order *, Edict of Purifying Pacifism *, Edict of Stillness *, Edict of Unyielding Resolve *, Gods Grant Thee Strength *, Judgement *, My Life for Yours *, Orison of Victory *, Pain of Your Own Making *, Shield of the Righteous, The Gods Punish and Defend

## Conduit

Aura of Souls *, Blessing of Steel *, Blessing of the Blade *, Blessing of the Midday Sun *, Righteous Phalanx *, Wellspring of Grace *, Word of Guidance *

## Elementalist

Luminous Champion Aloft *, Magma Titan *, No More Than a Breeze *, Practical Magic *, Subverted Perception of Space, Summon Source of Earth *, Swarm of Spirits, Test of Rain, The Flesh, a Crucible, The Green Defends Its Servants *, The Green Within, the Green Without, Unquiet Ground, Wall of Fire *

## Fury

Elemental Ferocity *, Furious Change *, Make Peace With Your God! *, My Turn!, Primordial Bane, Riders on the Storm *, Steelbreaker *, To the Death!, Unearthly Reflexes *, You Are Already Dead *

## Kits

Protective Attack, Weakening Brand

## Null

Absolute Zero *, Dance of Blows, Gravitic Charge, Impart Force, Inertial Shield *, Iron Body *, Kinetic Shield *, Null Field *, Psychic Pulse *

## Shadow

Black Ash Teleport *, Cacophony of Cinders *, Careful Observation *, Cinderstorm *, Coat the Blade *, Hesitation is Weakness *, I Work Better Alone, I'm No Threat *, In All This Confusion *, Teamwork Has Its Place, Time Bomb *, You Talk Too Much, You Were Watching the Wrong One

## Tactician

Advanced Tactics *, Counterstrategy *, Floodgates Open *, Go Now and Speed Well *, Inspiring Strike, Mark *, Overwatch *, Parry *, Squad! Gear Check!, Squad! Hit and Run! *, Squad! On Me! *, Squad! Remember Your Training! *, Win This Day! *

## Talent

Awe, Choke, Doubt, Entropic Bolt, Flashback *, Fling Through Time, Gravitic Burst, Gravitic Nova, Greater Kinetic Grip, Hoarfrost, Hypersonic, Incinerate, Inertia Soak *, Iron *, Kinetic Pulse, Materialize, Mind Spike, Optic Blast, Reflector Field *, Rejuvenate *, Soul Burn, Spirit Sword, Steel *, Synaptic Override *

## Troubadour

Acrobatics *, Blocking *, Choreography *, Dramatic Monologue *, Dramatic Reversal *, Expert Fencer, Fake Your Death *, Flip the Script *, Legendary Drum Fill *, Love Song *, Method Acting, Moonlight Sonata *, Radical Fantasia *, Revitalizing Limerick *, Riposte *, Rising Tension *, Spotlight *, Star Power *, Take Two! *, We Can't Be Upstaged! *, “Ballad of the Beast” *, “Fire Up the Night” *, “Never-Ending Hero” *, “Thunder Mother”

## Gains

8 class features gain their heroic resource from events.

| Feature | Rule | Event | Once | Amount |
|---|---|---|---|---|
| Clarity and Strain | A creature force moved, first this round | forcedMove | round | 1; Mind Recovery 2, Clear Mind 3 |
| Discipline | Enemy main action in your field, first this round (Director confirms) | abilityUse | round | 1; Regenerative Field 2 |
| Discipline | Director's Malice ability, first this round | abilityUse | round | 1 |
| Drama | Three heroes used abilities this turn (Director confirms) | abilityUse | encounter | 2 |
| Drama | First hero winded this encounter | winded | encounter | 2 |
| Drama | Natural 19 or 20 in sight (Director confirms) | naturalRoll | each | 3 |
| Drama | A hero died | heroDeath | each | 10 |
| Essence | Typed damage within 10, first this round | damage | round | 1; Font of Essence 2 |
| Ferocity | First damage taken this round | damage | round | 1; Damaging Ferocity 2, Primordial Ferocity 3 |
| Ferocity | First time winded or dying this encounter | winded | encounter | 1d3 |
| Focus | Your marked foe damaged, first this round | damage | round | 1; Focus on Their Weakness 2 |
| Focus | Ally's heroic ability within 10, first this round | abilityUse | round | 1 |
| Insight | Damage with a surge, first this round | damage | round | 1; Surge of Insight 2, Death Pool 3 |
| Wrath | Your judged foe damaged you, first this round | damage | round | 1 |
| Wrath | You damaged your judged foe, first this round | damage | round | 1; Wrath Beyond Wrath 2 |

## Generic feature rules

47 overlays use version 1 feature rules.

| Feature or ability | Event | Recipients | Effects |
|---|---|---|---|
| Acrobatics | turn.start | aura | acrobatics |
| Aura of Souls | turn.end | aura | forced |
| “Ballad of the Beast” | turn.start | aura | resource |
| Blessing of Steel | aura.continuous | aura | system.damage.immunities.all, targetBane |
| Blessing of the Blade | turn.end | aura | resource |
| Blessing of the Faithful | turn.end | aura | resource |
| Blessing of the Midday Sun | turn.end | aura | resource |
| Blessing of the Midday Sun | aura.continuous | aura | system.roll.banes |
| Blocking | turn.end | aura | blocking |
| Choreography | turn.start | aura | system.movement.value |
| Edict of Disruptive Isolation | turn.end | aura | damage |
| Edict of Peace | aura.continuous | aura | peace |
| Edict of Perfect Order | ability.use | subject | damage |
| Edict of Purifying Pacifism | ability.use | subject | damage |
| Edict of Stillness | aura.exit | subject | damage |
| Edict of Unyielding Resolve | turn.start | aura | heal |
| “Fire Up the Night” | turn.start | aura | concealment |
| Goblin Mode | turn.start | encounter | system.movement.value |
| I Work Better Alone | ability.beforeRoll | self | resource |
| Moonlight Sonata | round.start | aura | moonlight |
| “Never-Ending Hero” | turn.start | aura | dying |
| Null Field | aura.continuous | aura | condition |
| Null Field | damage.after | subject | forced |
| Null Field | turn.start | aura | noShift |
| Radical Fantasia | turn.start | aura | condition, radical |
| Reflector Field | aura.continuous | aura | reflector |
| Revitalizing Limerick | turn.end | aura | heal |
| Riders on the Storm | turn.end | aura | damage |
| Riders on the Storm | aura.continuous | self | condition |
| Riders on the Storm | turn.start | aura | condition |
| Riders on the Storm | turn.end | subject | condition |
| Spotlight | turn.start | aura | resource |
| Swarm of Spirits | aura.continuous | aura | system.combat.save.bonus, system.characteristics.might.resist, system.characteristics.agility.resist, system.characteristics.reason.resist, system.characteristics.intuition.resist, system.characteristics.presence.resist |
| Take Two! | turn.start | aura | takeTwo |
| “Thunder Mother” | round.end | aura | thunderMother |
| We Can't Be Upstaged! | turn.start | aura | system.movement.disengage |
| Wellspring of Grace | turn.start | aura | heal |
| Barbed Tail | strike.damage | targets | damage |
| Bastion Ward | passive | self | system.combat.save.bonus |
| Entropy Ward | damage.after | source | system.movement.value, entropy |
| Exorcist Judgement Benefit | judgement.applied | undefined | teleport |
| Oracle Judgement Benefit | judgement.applied | undefined | damage |
| Paragon Judgement Benefit | judgement.applied | undefined | forced |
| Quickness Ward | damage.after | self | shift |
| Repulsive Ward | damage.after | source | forced |
| Sanctuary Ward | damage.after | source | sanctuary |
| Spirit Ward | damage.after | source | damage |
| Steel Ward | damage.after | self | system.damage.immunities.all |
| Vanishing Ward | damage.after | self | condition |
| Ward of Delightful Consequences | damage.after | self | resource |
| Ward of Excellent Protection | passive | self | immunityChoice |
| Ward of Nature’s Affection | damage.after | source | forced |
| Ward of Surprising Reactivity | damage.after | source | forced |

## Monsters

14 monster overlays (a monster ability gets only these: generic overlays stay off NPCs unless they say `npc: true`).

| Ability | Monsters | Automates |
|---|---|---|
| Acid Spew (`ability:acid-spew`) | Arixx | zone |
| An Army From Blood (`ability:an-army-from-blood`) | Hobgoblin Bloodlord | summon |
| Arise, My Children (`ability:arise-my-children`) | Vampire Lord | summon |
| Call Abyssal Hyenas (`ability:call-abyssal-hyenas`) | Gnoll Abyssal Summoner | summon |
| Get in Here! (`ability:get-in-here`) | Goblin Monarch | summon |
| Goblin Mode (`ability:goblin-mode`) | Worg, Goblin Warrior, Goblin Assassin, Goblin Cursespitter, War Spider, Goblin Stinker, Skitterling, Goblin Sniper, Goblin Spinecleaver, Goblin Underboss, Goblin Monarch, Goblin Runner, Goblin Mastermind, Goblin Battleborn, Goblin Deathtongue, Mystic Queen Bargnot, Goblin Shadowknife, Goblin Toxinaut | feature rules |
| New Dawn (`ability:new-dawn`) | Angulotl Daybringer | summon |
| Oversurge (`ability:oversurge`) | Mystic Queen Bargnot | condition |
| Parry! (`ability:parry`) | Human Blackguard, Dame Cornelia | triggers |
| Shadow Stab (`ability:shadow-stab`) | Goblin Shadowknife | damage |
| Skitter (`ability:skitter`) | Arixx | triggers |
| Swamp Gas (`ability:swamp-gas`) | Goblin Stinker | zone |
| Swamp Gas (`ability:swamp-gas-dt`) | Goblin Toxinaut | zone |
| Sword Stab (`ability:sword-stab`) | Goblin Assassin | damage |

### Monster abilities with a generic overlay key and no monster overlay

The NPC guard leaves them unautomated (the hero overlay of the same key does something else).

- Castellan Hoplon: Inspiring Strike (`ability:inspiring-strike`)
- Rival Tactician: Overwatch (`ability:overwatch`)
- Targon: Overwatch (`ability:overwatch`)
- Olothec: Psychic Pulse (`ability:psychic-pulse`)
- Hobgoblin Burning Witch: Soul Burn (`ability:soul-burn`)

## Monsters in your adventures

Monster overlays that match each adventure actor (by its compendium source, else its name).

- **Part 1: Into the Tomb**: Bugbear Channeler, Ghoul, Goblin Assassin (Goblin Mode, Sword Stab), Goblin Sniper (Goblin Mode), Goblin Spinecleaver (Goblin Mode), Goblin Warrior (Goblin Mode), Skeleton, Violet, Zombie
- **Part 2: Broadhurst and Environs**: Aldiva, Arixx (Acid Spew, Skitter), Armored Soulwight, Black Ichor, Boddorff Buckfeather, Brune, Civilian, Clawfish, Crawling Claw, Creeping Sludge, Dame Cornelia (Parry!), Decrepit Skeleton, Dwarf Stone Whisperer, Dwarf Trapper, Dwarf Warden, Essence of Change, Flow of the River, Ghost, Ghoul, Glass Spider, Gorek, Gummy Ball, Human Archer, Human Brawler, Human Guard, Human Raider, Human Rogue, Human Scoundrel, Human Trickshot, Imit Putty, Laesi, Mara, Memorial Ivy, Mohler, Ogre Goon, Ogre Juggernaut, Rotting Zombie, Shade, Skeleton, Soulwight, Specter, Spindlegoth, Sudden Downpour, Targon, Thurston, Tomb Horror, Vurkor, Wallmaster, Werewolf, Zombie
- **Part 3: The Jagged Edge**: Bugbear Commander, Civilian, Goblin Assassin (Goblin Mode, Sword Stab), Goblin Battleborn (Goblin Mode), Goblin Cursespitter (Goblin Mode), Goblin Deathtongue (Goblin Mode), Goblin Mastermind (Goblin Mode), Goblin Runner (Goblin Mode), Goblin Shadowknife (Goblin Mode, Shadow Stab), Goblin Sniper (Goblin Mode), Goblin Spinecleaver (Goblin Mode), Goblin Stinker (Goblin Mode, Swamp Gas), Goblin Toxinaut (Goblin Mode, Swamp Gas), Goblin Underboss (Goblin Mode), Goblin Warrior (Goblin Mode), Mystic Queen Bargnot (Goblin Mode, Oversurge), Queen Bargnot (Get in Here!, Goblin Mode), Targon, War Spider (Goblin Mode), Worg (Goblin Mode)
- **Road to Broadhurst**: Goblin Assassin (Goblin Mode, Sword Stab), Goblin Sniper (Goblin Mode), Goblin Stinker (Goblin Mode, Swamp Gas), Goblin Warrior (Goblin Mode), Gogellwyc, Radenwight Maestro, Radenwight Mischiever, Radenwight Redeye, Radenwight Swiftpaw
