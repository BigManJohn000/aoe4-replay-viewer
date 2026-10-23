# Animation audit — the "fusion folder" (`viewer3d/assets/anims/`)

Date: 2026-10-23. Scope: `viewer3d/assets/anims/index.json`, the baked GLBs, `viewer3d/viewer.js` (animation section),
`viewer3d/unit-batches.js`, `viewer3d/tools/havok/bake-anims.mjs`, `docs/audit/roster.json`, and the 2D viewer.
Read-only; no bakes, no servers. All numbers below were produced by parsing the artefacts with Python
(`index.json` is a single minified line, so it is cited by key path, not line number; `roster.json` and
`catalog.json` are line-addressable).

> **Correction to the brief.** There are **36 GLBs, not 37**, and they are exactly the 36 archetypes in `index.json`
> (**35.0 MB** total; smallest `base_water_monster.glb` 175 KB, largest `base_horse_combined.glb` 5.9 MB). Names differ
> from the brief's examples: there is no `base_villager` (it is **`base_civilian`**) and no `base_spear_samurai`
> (it is **`base_spearman_samurai`**). The folder contains only `index.json` + 36 `.glb` files.

---

## 0. Headline numbers

| Metric | Value |
|---|---|
| Archetypes / GLBs | **36 / 36** (all files present) |
| Bones (sum), clip count, state-key count | 2,138 · **490** · 389 |
| Clips with root-motion `move` / strike `hit` / `part: rider` | 160 · 77 · 26 |
| Blueprints mapped in `index.blueprints` | **939** |
| Animated ("skinned") catalog blueprints | **948** → 939 mapped + **9 unmapped** (100% accounted for) |
| Orphan clips (in `clips`, referenced by no state) | **0** |
| Dangling state refs (state lists a missing clip) / empty state lists | **0 / 0** |
| Clips present but unreachable by engine wiring ("dead") | **58** (11.8% of 490) |
| Standalone archetypes complete for their role | **17 of 30** (17/36 overall) |
| Roster unit types with an animation archetype | **141/227** as recorded; **154/227** estimated after correcting 13 roster join misses [inference] |
| Structure types with skeletal animation | **0/163** genuine buildings (the roster's 164 includes `worker-elephant`, a unit misfiled by its dummy building blueprint; it is animated via `base_elephant_combined`). Construction, ruin, packing and gate swing are procedural (`viewer.js:3166-3239`) |
| 2D viewer animation states | **0** |

---

## 1. Structural analysis of `index.json`

Schema (as baked): `archetypes[name] = {file, bones, clips{clip:{dur,frames,move?,hit?,part?}}, states{state:[clip…]}}`,
`blueprints[bp] = {base, extra?, jobs?{job:archetype}, style?}`, `unmapped[]` (`bake-anims.mjs:27-35`, `590-605`).

### 1.1 Summary table — archetypes × states present / missing / orphan clips

"present" = canonical states defined under the plain name. "dead" = clips reachable only through states the engine
never asks for (see §3.2). Orphan = 0 for every archetype.

| archetype | bones | clips | state keys | present /22 | missing /22 | orphan | dead clips |
|---|---:|---:|---:|---:|---:|---:|---:|
| base_archer | 48 | 44 | 45 | 13 | 9 | 0 | 3 |
| base_axe2h | 48 | 20 | 11 | 10 | 12 | 0 | 2 |
| base_bigcat | 36 | 8 | 8 | 8 | 14 | 0 | 0 |
| base_boar | 29 | 11 | 10 | 9 | 13 | 0 | 1 |
| base_butcher | 73 | 8 | 8 | 4 | 18 | 0 | 4 |
| base_camel_combined | 92 | 19 | 15 | 10 | 12 | 0 | 2 |
| base_cattle | 45 | 9 | 8 | 7 | 15 | 0 | 1 |
| base_civilian | 73 | 28 | 19 | 17 | 5 | 0 | 3 |
| base_crocodile | 40 | 9 | 9 | 8 | 14 | 0 | 1 |
| base_deer | 38 | 8 | 8 | 7 | 15 | 0 | 1 |
| base_elephant_archer | 48 | 8 | 7 | 7 | 15 | 0 | 0 |
| base_elephant_combined | 140 | 14 | 10 | 9 | 13 | 0 | 2 |
| base_elephant_spearman | 48 | 15 | 10 | 9 | 13 | 0 | 2 |
| base_farmer | 73 | 9 | 8 | 7 | 15 | 0 | 1 |
| base_fisherman | 73 | 5 | 5 | 4 | 18 | 0 | 1 |
| base_forager | 73 | 5 | 5 | 4 | 18 | 0 | 1 |
| base_fox | 36 | 10 | 9 | 8 | 14 | 0 | 1 |
| base_heavy_spearman | 48 | 21 | 12 | 10 | 12 | 0 | 4 |
| base_horse_combined | 127 | 41 | 29 | 10 | 12 | 0 | 5 |
| base_horse_gaia | 48 | 8 | 9 | 8 | 14 | 0 | 1 |
| base_land_monster | 48 | 4 | 5 | 4 | 18 | 0 | 1 |
| base_logger | 73 | 9 | 8 | 7 | 15 | 0 | 1 |
| base_miner | 73 | 7 | 7 | 6 | 16 | 0 | 1 |
| base_monk | 73 | 9 | 10 | 8 | 14 | 0 | 2 |
| base_reindeer | 38 | 7 | 7 | 6 | 16 | 0 | 1 |
| base_reindeer_combined | 127 | 5 | 5 | 5 | 17 | 0 | 0 |
| base_shaolin | 73 | 17 | 14 | 12 | 10 | 0 | 2 |
| base_sheep | 27 | 8 | 8 | 7 | 15 | 0 | 1 |
| base_spearman | 48 | 21 | 12 | 10 | 12 | 0 | 2 |
| base_spearman_samurai | 48 | 19 | 11 | 10 | 12 | 0 | 2 |
| base_spearshield | 48 | 17 | 11 | 10 | 12 | 0 | 2 |
| base_sword_2hand | 48 | 19 | 11 | 10 | 12 | 0 | 2 |
| base_sword_samurai | 48 | 19 | 11 | 10 | 12 | 0 | 2 |
| base_swordsman | 48 | 17 | 11 | 10 | 12 | 0 | 2 |
| base_water_monster | 51 | 2 | 4 | 4 | 18 | 0 | 0 |
| base_wolf | 31 | 10 | 9 | 8 | 14 | 0 | 1 |

`base_horse_combined` and `base_camel_combined` show only 10 plain states but reach 13 once their `@bow` variants are
counted (`aim/fire/reload` exist **only** as `@bow`). `state keys` also includes those `@style` rows and the villager
`work@<job>` rows, which is why it can exceed `present`.

### 1.2 Canonical action-state set (derived from the engine, not guessed)

`viewer.js:2470-2471` defines the only states ever looked up:

```
CLIP_STATES = ['idle','guard','aim','fire','reload','attack','convert','throw','flinch','death','dead',
               'work','tool_idle','carry_idle', ...GAITS]           // GAITS = walk,jog,run,sprint,
                                                                    //        tool_walk,tool_run,
                                                                    //        carry_walk,carry_run
```

That is **22 canonical states**. `stop`, `heal`, `mount`, `dismount`, `dropoff` are *not* in the list, and neither is
the `@herd` overlay. Additional state variants are addressed as `` `${state}@${style ?? job}` `` (`unit-batches.js:50-52`,
`374-383`; `bake-anims.mjs:31-34`). `viewer.js:2468` shows the three gait prefixes actually used
(`''`, `tool_`, `carry_`).

### 1.3 Missing canonical states — full list per archetype

| archetype | missing plain canonical states |
|---|---|
| base_archer | convert, dead, work, tool_idle, carry_idle, tool_walk, tool_run, carry_walk, carry_run |
| base_axe2h | aim, fire, reload, convert, dead, work, tool_idle, carry_idle, tool_walk, tool_run, carry_walk, carry_run |
| base_bigcat | aim, fire, reload, convert, throw, flinch, dead, work, tool_idle, carry_idle, tool_walk, tool_run, carry_walk, carry_run |
| base_boar | aim, fire, reload, convert, throw, flinch, work, tool_idle, carry_idle, tool_walk, tool_run, carry_walk, carry_run |
| base_butcher | idle, guard, aim, fire, reload, attack, convert, throw, flinch, death, dead, tool_idle, walk, jog, run, sprint, tool_walk, tool_run |
| base_camel_combined | aim, fire, reload, convert, dead, work, tool_idle, carry_idle, tool_walk, tool_run, carry_walk, carry_run |
| base_cattle | guard, aim, fire, reload, attack, convert, throw, flinch, work, tool_idle, carry_idle, tool_walk, tool_run, carry_walk, carry_run |
| base_civilian | convert, dead, carry_idle, carry_walk, carry_run |
| base_crocodile | aim, fire, reload, convert, throw, flinch, dead, work, tool_idle, carry_idle, tool_walk, tool_run, carry_walk, carry_run |
| base_deer | guard, aim, fire, reload, attack, convert, throw, flinch, work, tool_idle, carry_idle, tool_walk, tool_run, carry_walk, carry_run |
| base_elephant_archer | attack, convert, throw, dead, work, tool_idle, carry_idle, walk, jog, run, sprint, tool_walk, tool_run, carry_walk, carry_run |
| base_elephant_combined | aim, fire, reload, convert, throw, dead, work, tool_idle, carry_idle, tool_walk, tool_run, carry_walk, carry_run |
| base_elephant_spearman | aim, fire, reload, convert, throw, dead, work, tool_idle, carry_idle, tool_walk, tool_run, carry_walk, carry_run |
| base_farmer | idle, guard, aim, fire, reload, attack, convert, throw, flinch, death, dead, walk, jog, run, sprint |
| base_fisherman | idle, guard, aim, fire, reload, attack, convert, throw, flinch, death, dead, tool_idle, walk, jog, run, sprint, tool_walk, tool_run |
| base_forager | idle, guard, aim, fire, reload, attack, convert, throw, flinch, death, dead, tool_idle, walk, jog, run, sprint, tool_walk, tool_run |
| base_fox | aim, fire, reload, convert, throw, flinch, dead, work, tool_idle, carry_idle, tool_walk, tool_run, carry_walk, carry_run |
| base_heavy_spearman | aim, fire, reload, convert, dead, work, tool_idle, carry_idle, tool_walk, tool_run, carry_walk, carry_run |
| base_horse_combined | aim, fire, reload, convert, dead, work, tool_idle, carry_idle, tool_walk, tool_run, carry_walk, carry_run |
| base_horse_gaia | aim, fire, reload, attack, convert, throw, flinch, work, tool_idle, carry_idle, tool_walk, tool_run, carry_walk, carry_run |
| base_land_monster | guard, aim, fire, reload, attack, convert, throw, flinch, death, dead, work, tool_idle, carry_idle, sprint, tool_walk, tool_run, carry_walk, carry_run |
| base_logger | idle, guard, aim, fire, reload, attack, convert, throw, flinch, death, dead, walk, jog, run, sprint |
| base_miner | idle, guard, aim, fire, reload, attack, convert, throw, flinch, death, dead, carry_idle, walk, jog, run, sprint |
| base_monk | guard, aim, fire, reload, attack, throw, flinch, death, dead, work, tool_idle, sprint, tool_walk, tool_run |
| base_reindeer | guard, aim, fire, reload, attack, convert, throw, flinch, work, tool_idle, carry_idle, jog, tool_walk, tool_run, carry_walk, carry_run |
| base_reindeer_combined | guard, aim, fire, reload, attack, convert, throw, flinch, dead, work, tool_idle, carry_idle, sprint, tool_walk, tool_run, carry_walk, carry_run |
| base_shaolin | aim, fire, reload, throw, flinch, dead, work, tool_idle, tool_walk, tool_run |
| base_sheep | guard, aim, fire, reload, attack, convert, throw, flinch, work, tool_idle, carry_idle, tool_walk, tool_run, carry_walk, carry_run |
| base_spearman | aim, fire, reload, convert, dead, work, tool_idle, carry_idle, tool_walk, tool_run, carry_walk, carry_run |
| base_spearman_samurai | aim, fire, reload, convert, dead, work, tool_idle, carry_idle, tool_walk, tool_run, carry_walk, carry_run |
| base_spearshield | aim, fire, reload, convert, dead, work, tool_idle, carry_idle, tool_walk, tool_run, carry_walk, carry_run |
| base_sword_2hand | aim, fire, reload, convert, dead, work, tool_idle, carry_idle, tool_walk, tool_run, carry_walk, carry_run |
| base_sword_samurai | aim, fire, reload, convert, dead, work, tool_idle, carry_idle, tool_walk, tool_run, carry_walk, carry_run |
| base_swordsman | aim, fire, reload, convert, dead, work, tool_idle, carry_idle, tool_walk, tool_run, carry_walk, carry_run |
| base_water_monster | guard, aim, fire, reload, attack, convert, throw, flinch, death, dead, work, tool_idle, carry_idle, sprint, tool_walk, tool_run, carry_walk, carry_run |
| base_wolf | aim, fire, reload, convert, throw, flinch, dead, work, tool_idle, carry_idle, tool_walk, tool_run, carry_walk, carry_run |

**No missing clips for declared states:** every one of the 389 state keys points at ≥1 existing clip; no state has an
empty clip list and no clip reference is dangling. So "missing clips" inside the index is **0** — the only missing-clip
problem is missing *states* (above) and the engine fallbacks in §3.4.

### 1.4 Role-aware completeness (what the engine would actually use)

Expectations by role: melee = `idle, guard, walk, jog, run, sprint, attack, death, flinch`; ranged adds
`aim, fire, reload`; animal = `idle, walk, jog, run, sprint, death, dead`; worker = `idle, walk, jog, run, sprint,
work, death, carry_idle`. "Present" counts `@style` variants.

| archetype | role | missing role-critical states |
|---|---|---|
| base_bigcat | animal | dead |
| base_crocodile | animal | dead |
| base_fox | animal | dead |
| base_wolf | animal | dead |
| base_reindeer | animal | jog |
| base_land_monster | animal | sprint, death, dead |
| base_water_monster | animal | sprint, death, dead |
| base_elephant_archer | melee+ranged | **walk, jog, run, sprint, attack** |
| base_monk | melee | guard, sprint in its own set. Its own set also lacks attack, death and flinch, but all 25 monk mappings carry `extra: ['base_civilian']`, which supplies 3 death, 2 flinch and 3 attack clips at runtime (`unit-batches.js:374-381`; `viewer.js:2706,2725,2741`) |
| base_reindeer_combined | melee | guard, sprint, attack, flinch |
| base_shaolin | melee | flinch |
| base_spearshield | melee+ranged | **aim, fire, reload** (serves 10 ranged blueprints, e.g. bedouin-skirmisher) |
| base_civilian | worker | carry_idle |
| base_butcher / farmer / fisherman / forager / logger / miner | job sets | idle, walk, jog, run, sprint, death — **by design**; these are only reached through `jobs{}` and fall back to `base_civilian` for locomotion (base_miner also lacks `carry_idle`) |

`base_elephant_archer` looks worst on paper (idle/aim/fire/reload/flinch/death only), but it is the **tower crew rig**,
not a walking unit: its 2 blueprints (`unit_war_elephant_tower_archer_*`) are attachment entities (ebps
`attachment_child_ext`) that ride a tower elephant, 2 per mount, recorded within 0.36–0.63 m of it with the mount's
id + 1 / + 2 (26 crew entities in `aoe4_256564163`). They need no gait or melee clip. **Real defect, fixed:** the crew
stood at ground level, hidden inside the elephant; `Replay.seatCrews` now links each crew member to its mount and the
viewer stands it `CREW_SEAT` = 3.37 m up (the `basket_m` bind height shared by the sul armour, armour-upgrade and tug
healer elephant GLBs), at its mount's scale. Monk crews (`unit_war_elephant_tower_monk_*`) ride the healer elephant the
same way. Every recorded `base_elephant_combined` user is melee (combat.json), so it needs no aim/fire/reload.

### 1.5 Weapon overlays (`@<weapon>`)

Only **6 archetypes define any `@` variant**:

| archetype | variants |
|---|---|
| base_archer | `@crossbow`, `@repeater`, `@arquebus` (full idle/guard/walk/jog/run/sprint/aim/fire/reload), `@grenade` (aim/fire/reload only), `stop@arquebus` |
| base_horse_combined | `@bow` (guard/aim/fire/reload), `@spear`, `@pandao`, `@mehter` (attack), `@build/@farm/@wood/@gold/@stone/@berry/@meat/@fish` (work) |
| base_camel_combined | `@bow` (guard/aim/fire/reload) |
| base_spearman | `@swing` (attack) |
| base_heavy_spearman | `@swing` (attack) — **never requested** (only `base_spearman` gets style `swing`) |
| base_butcher | `@herd` (tool_idle/tool_walk/tool_run) — **never requested** (see §3.2) |

Styles referenced by blueprints (`bake-anims.mjs:333-352`): **spear 86, bow 51, crossbow 46, repeater 9, grenade 7,
pandao 6, arquebus 3, mehter 1, swing 1**. Every `(style, base)` pair resolves: all spear/bow/pandao/mehter
blueprints sit on `base_horse_combined` (or `base_camel_combined` for bow), all crossbow/repeater/arquebus/grenade on
`base_archer`, `swing` on `base_spearman`. There is **no blueprint whose style the archetype cannot serve**.
Overlay sets are intentionally partial: a missing `state@style` falls back to the plain state in the same archetype
(`unit-batches.js:378-381`), e.g. no `idle@grenade` → plain `idle`.

### 1.6 `unmapped` — exactly what it is and why

`unmapped` = "animated catalog blueprints without an archetype" (`bake-anims.mjs:35`, pushed at `598`). All 9 are
present in `catalog.json`, absent from `blueprints`, and are **not stale**:

| blueprint | catalog cat | catalog ages/models | why no archetype |
|---|---|---|---|
| unit_archer_tower_ram_abb_ha_1 | ranged | eng_ranged_bow_age02 | ram/tower archer attachment, no `parent_animator` archetype [inference from name/category] |
| unit_siege_crew_chi | infantry | chi villager male/female | siege-crew attachment; uses villager models, no archetype of its own |
| unit_siege_crew_chi_ha_01 | infantry | chi villager male/female | variant of the above |
| unit_siege_crew_eng | infantry | eng villager male/female | variant |
| unit_siege_crew_jpn | infantry | chi villager male/female | variant |
| unit_logistics_wagon | other | eng_horse_trade_age02 | wagon attachment, not a unit |
| gaia_huntable_enchanted_stag | other | stag_enchanted | unique stag skeleton; no SPEC entry / `.rhka` in the common archetypes [inference] |
| gaia_food_enchanted_stag_corpse | gaia:other | stag_enchanted | same |
| gaia_prototype_animal_corpse | other | sheep | prototype corpse entity, no dedicated rig |

So `unmapped` is **6 attachments (4 siege crews, the tower-ram archer, the logistics wagon) + 2 enchanted-stag
entities + 1 prototype corpse** — content that is
either never a standalone animated unit or has no baked skeleton. Nothing in `unmapped` is a missing unit animation.

---

## 2. Roster coverage (`docs/audit/roster.json`)

### 2.1 Unit types with no animation archetype — 86 of 227

Grouped by primary class (bucket precedence ship > siege > cavalry > ranged > infantry > religious > hero > villager/econ > other):

**ship — 32 (all unskinned or absent from catalog):** atakebune, attack-ship, baghlah, baochuan, carrack,
demolition-ship, dhow, dromon, explosive-dhow, explosive-junk, fishing-boat, galleass, galley, grand-galley, hulk,
hunting-canoe, junk, light-junk, lodya-attack-ship, lodya-demolition-ship, lodya-fishing-boat, lodya-galley,
lodya-trade-ship, lodya-transport-ship, trade-ship, transport-ship, venetian-galley, war-canoe, war-cog, war-junk,
warship, xebec.

**siege — 26 (all unskinned or absent from catalog):** battering-ram, bed-crossbow, bombard, cannon, cheirosiphon, clocktower-battering-ram,
clocktower-bombard, clocktower-counterweight-trebuchet, clocktower-nest-of-bees, clocktower-springald,
counterweight-trebuchet, culverin, great-bombard, huihui-pao, khaganate-nest-of-bees, mangonel, manjaniq, nest-of-bees,
ribauldequin, royal-cannon, royal-culverin, royal-ribauldequin, siege-tower, springald, tower-of-the-sultan,
traction-trebuchet.

**cavalry — 7:** camel-rider, demilancer, hippodrome-horseman, hippodrome-riddari, hippodrome-scout, khans-hunter,
szlachta-cavalry.

**ranged — 8:** earls-retinue, garrison-command, gunpowder-contingent, wynguard-army, wynguard-footmen,
wynguard-raiders, wynguard-ranger, wynguard-rangers.

**infantry — 5:** condottiero, hospitaller-knight, kharash, serjeant, wynguard-footman.

**villager/econ — 3:** emissary, reindeer-trader, yatai.

**other — 5:** city-guard, imperial-retinue, provincial-levy, ranged-specialists, runestones *(a building model
mis-bucketed as a unit)*.

**These 86 are not one problem.** Splitting them by evidence:

| group | count | evidence | verdict |
|---|---:|---|---|
| ships | 32 | `skinned=0` for the 27 families with a catalog blueprint, 5 have none (catalog: 122 ship blueprints, 0 mapped) | static, README:345 — needs new rigs |
| siege | 26 | `skinned=0` for 25, 1 absent | static, README:345 — needs new rigs |
| army/tech tokens | 8 | `unit_free_dummy_*` / 0-model `unit_wynguard_army_eng` etc.; unskinned | no rig needed (not map units) |
| roster join misses | **13** | a catalog blueprint for the same unit **is mapped** (table below) | **roster undercount — already animated** |
| no catalog model under that id | 6 | condottiero, camel-rider, demilancer, hippodrome-horseman/riddari/scout | mapping alias gap; [inference] riggable with existing archetypes |
| building | 1 | runestones → `building_varangian_runestone_byz_ha_mac` | not a unit |

The 13 roster join misses (roster `anim_archetypes: []`, but the catalogue's own blueprint for that unit is in
`index.blueprints`): hospitaller-knight → base_swordsman; serjeant → base_swordsman; wynguard-footman/footmen →
base_swordsman; wynguard-ranger/rangers → base_archer; earls-retinue → base_axe2h; kharash → base_swordsman;
khans-hunter → base_horse_combined (bow); szlachta-cavalry → base_horse_combined; emissary → base_civilian;
yatai → base_horse_combined; reindeer-trader → base_reindeer_combined. Root cause: `roster.sample_blueprint` is a
`stats.js` id that is not always a catalogue key — token order (`unit_serjeant_2_tem` vs `unit_serjeant_tem_2`,
`unit_cataphract_4_byz_mac_ha` vs `unit_cataphract_4_byz_ha_mac`), tier/variant digits
(`unit_footman_wynguard_4_eng` vs `unit_footman_wynguard_eng`), a misspelling (`unit_szlatcha_knight_4_tem` vs
`unit_szlactha_knight_4_tem`), or a different name (`unit_wynguard_earls_retinue_lan` vs `unit_earlsguard_3_lan`) —
so the roster's index join misses. **Corrected estimate: 154/227 [inference — assumes the replay's blueprint id is the
catalogue id, not the stats alias].**

### 2.2 Structures

**0 of 163 genuine structure types have skeletal animation.** The single roster structure with `anim_archetypes` is
`worker-elephant → base_elephant_combined` — that is the worker elephant unit, mis-bucketed into `structures`
(`roster.json:19715`). All 164 structure `sample_blueprint`s are absent from `index.blueprints`, and the map contains
**zero `building_*` keys**.

What the engine does instead (all procedural, no skeletal clips):

- construction: the model is clipped at its HP-share height inside a generated scaffold (`viewer.js:3166-3182`, scaffold
  geometry `3100-3121`);
- ruin: destroyed buildings sink/tilt into a generated rubble heap for `RUIN_SECS` (`viewer.js:3192-3231`, constants
  `299-300`);
- damage flash: red emissive for `FLASH_SECS` after each recorded HP drop (`viewer.js:3533-3534`, `3547`);
- gates are the one articulated piece: `rv_door_l/r` pivots are swung by a hand-written angle table
  (`viewer.js:3417-3442`), not by a baked clip;
- farms swap crop cards by growth/damage state (`viewer.js:3217`, `3225`).

### 2.3 Blueprint map vs catalog

- catalog: **3,013** blueprints; **948** have at least one age model with skin joints ("animated").
- `index.blueprints`: **939**; `unmapped`: **9** → 948/948 covered. **0 stale mappings** (every index key exists in
  catalog: `index − catalog = 0`).
- The other **2,065** catalog blueprints are unskinned (buildings 858, trees/stealth 204, attachments 222,
  resources, etc.) and are out of scope for skeletal animation by construction (`bake-anims.mjs:591-593` keeps only
  blueprints whose age models have `bones`).
- Blueprint categories **not** in the map (unskinned / attachment / stats-only ids), absent/total: siege 301/303,
  ship 122/122, econ 81/119, other 69/86, attachment 222/222, ranged 12/192, infantry 14/251, cavalry 9/323,
  religious 1/31, villager 1/31, gaia:other 118/135 — the remainder listed in §2.1.

### 2.4 Animals and gaia

12 animal rigs / 12 gaia archetypes in the index: `base_sheep` (9 bps), `base_wolf` (7), `base_deer` (3),
`base_boar` (2), `base_reindeer` (2), `base_horse_gaia` (2, used for **zebra** + zebra corpse), `base_cattle` (1),
`base_crocodile` (1), `base_fox` (1), `base_bigcat` (1), `base_land_monster` (1), `base_water_monster` (1).

| recorded gaia kind | rig | gaia blueprint |
|---|---|---|
| deer | base_deer | ✔ gaia_huntable_deer, _deer_rus, _deer_corpse |
| wolf | base_wolf | ✔ huntable/wolf_pack/werewolf_1-4/corpse |
| boar | base_boar | ✔ huntable + corpse |
| sheep | base_sheep | ✔ 6 herdable + corpses |
| cattle | base_cattle | ✔ herdable_cattle_mal + corpse |
| fox | base_fox | ✔ prototype_fox |
| crocodile | base_crocodile | ✔ prototype_crocodile |
| reindeer | base_reindeer | ✔ huntable + corpse |
| bigcat | base_bigcat | ✔ protoype_bigcat (sic) |
| land_monster | base_land_monster | ✔ gaia_monster_land |
| water_monster | base_water_monster | ✔ gaia_monster_water |
| horse | base_horse_gaia (zebra) + base_horse_combined | ✔ zebra + corpse |
| **elephant** | base_elephant_combined exists | ✘ **no gaia_ blueprint** — only war/worker elephants |
| **camel** | base_camel_combined exists | ✘ **no gaia_ blueprint** |

Plus **enchanted stag** is recorded but unmapped (no rig, `unmapped[6]`), and `gaia_prototype_animal_corpse` has no
dedicated rig. Net: 12/14 recorded kinds have a gaia mapping; elephant/camel have rigs but no gaia blueprint
[inference: the game only uses them as player units].

---

## 3. Engine wiring (`viewer3d/viewer.js` animation section, 2445+)

### 3.1 How a state is chosen

1. `unitReady(url,bp)` gates a model on having **idle** clips; until then/if false the unit stands in its bind pose
   (`2481-2495`). `clipTable(bp, style)` is the gate (`2491`).
2. `clipTable(bp, key)` fills one handle list per `CLIP_STATES` entry: up to 8 variants via `units.clip(bp, st, key, n)`;
   if a state is empty for `key`, retry with the blueprint's `style` (`2506-2528`). `T.ranged` is set when the unit's
   main damage is `Ranged` **and** it has fire clips (`2525`).
3. `unit-batches.resolve()` walks `[jobs[key] ?? base, ...extra, base]` and takes the **first archetype that defines
   `` `${state}@${style ?? key}` `` or `state`** (`unit-batches.js:374-383`) — it does not merge states across archetypes.
4. `unitAnim()` builds the frame's candidates (`2702-2772`); `mixOut()` keeps the **two heaviest full-body clips** (or one
   full-body + one rider layer) and hands `{a,ta,b,tb,w}` to `UnitBatches.set` (`2603-2642`, `3539-3544`).

### 3.2 States actually requested vs present-but-dead

Requested (the 22 canonical states, with these triggers): `idle`, `walk/jog/run/sprint`, `tool_*`, `carry_*`
(locomotion, `2765-2769`); `guard` (melee stance, `2761`); `aim/fire/reload` (ranged only, `2525`, `2725-2733`,
`2761`); `attack`/`convert` (blows, `2725`); `throw` (torch blows, `2725`); `flinch` (HP drops, `2739-2745`);
`death` (`2705-2708`); `dead` (animals only, `2797`); `work` (`2750-2754`); `tool_idle`/`carry_idle` (`2760`).

**Never requested anywhere:** `stop` (40 clips in 26 archetypes), `stop@arquebus` (1), `heal` (2: base_monk,
base_shaolin), `mount` + `dismount` (2: base_horse_combined — the rider is always seated; no mount logic exists),
`dropoff` (8: 7 worker/civilian sets + base_horse_combined), `tool_idle@herd`/`tool_walk@herd`/`tool_run@herd`
(3: base_butcher; `herd`
is in `blueprints.jobs` but **not in `JOB_KEY`**, so the key is never passed), and `attack@swing` on
base_heavy_spearman (2; only `base_spearman` is ever assigned style `swing`). **Total 58 dead clips.** *Since wired
(B1): `stop`, `stop@arquebus`, `dropoff` (7 worker/civilian sets) and `heal` — 50 clips; see Checklist 2.*

`dead` is *not* dead wiring: `CLIP_STATES` builds it for every archetype, but only `animalAnim` reads it (`2797`);
units hold the last frame of `death` instead.

`convert` is only a fallback for `attack` (`nthOf(T.attack,k) ?? nthOf(T.convert,k)`, `2725`), which is exactly how
monks/shaolin fight/convert; it works but is not a dedicated "convert" state.

### 3.3 Villager work loops

Yes — the 8 `JOBS` loops (build, farm, wood, gold, stone, berry, meat, fish), served by `blueprints.jobs` and
`JOB_KEY` (`viewer.js:2467`, `viewer.js:2711-2712`, `2750-2754`):

| job | archetype | clip |
|---|---|---|
| build | base_civilian (no `build` entry in `jobs{}`, so base) | `builder/builder_hammer_kneeling_01` |
| farm | base_farmer | `sickle/harvesting_01/02` |
| wood/chop | base_logger | `chopping/logger_axe_chop_tree_01/02` |
| gold, stone/mine | base_miner | `mining/miner_hammer_ground_01` |
| berry/forage | base_forager | `foraging/forager_berries_kneeling_01` |
| meat/skin | base_butcher | `killing/gathering_meat_01` |
| fish | base_fisherman | `fishing/casting_01` |
| herd | base_butcher | `killing/gathering_meat_01` (the shepherd `@herd` clips are dead) |
| any job, mounted | base_horse_combined | `mount_dismount/{builder_hammer_kneeling,harvesting_01,logger_axe_chop_tree_01,dismounted_mining,forager_berries_kneeling,gathering_meat,casting}` — reachable only if a job code reaches `unit_mounted_villager_1_jin` [inference; its blueprint has no `jobs{}` map] |

Also `work` is reused outside units: tree felling phases the first chopper's `work` clip (`viewer.js:1732-1737`).

Note `base_forager` has **no idle/locomotion**; every villager job table falls back to `base_civilian` for those
states (`2538-2539`). The one blueprint that this breaks is `poi_viz_excavator` (its base *is* `base_forager`) —
the only blueprint in the whole index with no idle, so it can never leave bind pose.

### 3.4 Fallback behaviour when a clip is missing

| missing | behaviour | line |
|---|---|---|
| state for a style | retried on the plain state in the same archetype | `viewer.js:2523`, `unit-batches.js:378-381` |
| state across archetypes | first archetype in `jobs[key]→extra→base` that has it wins; no merging | `unit-batches.js:374-383` |
| `attack` | falls back to `convert` | `viewer.js:2725` |
| `throw` (torch blow) | the whole blow is **skipped** (`if (!h) continue`) — no torch-throw animation | `viewer.js:2725-2726` |
| `fire` (or non-ranged) | `T.ranged=false`, so the unit uses `guard`/`attack` instead of aim/fire/reload | `viewer.js:2525`, `2761` |
| `death` | falls back to `idle` and holds it | `viewer.js:2706` |
| `dead` (animal) | holds the last frame of `death` | `viewer.js:2797` |
| `tool_*`/`carry_*` gaits | falls back to the plain gait set | `viewer.js:2538-2539` |
| `carry_idle`/`tool_idle` | falls back to `idle` | `viewer.js:2760` |
| no idle at all | `unitReady=false` → model drawn in bind pose | `viewer.js:2481-2492` |
| nothing at all | `mixOut()` returns false; the unit is not `set()` that frame | `viewer.js:2635`, `3540` |

### 3.5 What `unit-batches.js` supports

- **GPU-instanced skinning** — one draw per material per pass for any unit count (`unit-batches.js:1-37`, `472-505`).
- **Two clips blended per instance**: `a`,`ta`,`b`,`tb`,`w`; model-space matrix blend with columns rescaled
  (`unit-batches.js:56-60`, shader `118-146`).
- **A rider layer**: `part:'rider'` clips rotate only the rider subtree, re-seated on the horse's attach bone
  (`unit-batches.js:12-14`, `283-293`, `viewer.js:2638`, `2762`).
- **Uniforms**: `rvAnim` (RGBA16F clip matrix rows), `rvJoint` (per-model joint table), `rvInst` (instances), `rvBase`
  (`unit-batches.js:103-106`).
- **Per-instance data**: matrix, team colour, skin colour, flash, rider flag, clip pair + weight, prop bits
  (`25-32`, `556-560`).
- **Per-instance LOD** by distance ÷ scale against the model's `rv_lod<n>` `dist`, with 1.1 hysteresis
  (`unit-batches.js:19-24`, `36-37`, `624-631`); frustum culling and shadow-pass culling (`33-35`).
- **Props**: `rvwpn_main`, `rvwpn_torch`, `rvtool_*` bits shown/hidden per state (`viewer.js:2644-2658`, `2770`).

---

## 4. 2D engine hooks (`viewer/`)

The 2D viewer has **no animation-state concept at all**. It paints pre-built `Path2D` figures:

- `UNIT_ART` is a static figure table (`viewer/map.js:1145`), and every unit is drawn from it at any zoom
  (`viewer/map.js:6-9`, `1352-1360`); units are stamped from cached sprites (`1363`).
- `BUILDING_TYPES` (`viewer/map.js:43`) and `GAIA_ART` (`viewer/map.js:1947`) are likewise static artwork.
- The only `frame` in 2D is the render loop (`viewer/app.js:104`, `938-966`) and the shared time-sampled model
  `V.frame(t)` (`viewer/frame.js:853`), which supplies selection/combat lists, not poses.
- Time-varying 2D visuals are overlays only: attack lines, death marks, under-attack alerts, damage numbers
  (`viewer/fx.js:18`, `viewer/map.js:119-123`, `2082-2179`). `map.js:1728` `c.clip()` is a canvas clip region, not a
  video clip.

**What "wired into the 2D engine" can and cannot mean:** the 2D map has no skeleton, no clip table and no state
machine, so a baked animation cannot be "wired" into it without a new per-state sprite/frame system. At most it could
switch a *static* sprite per state (e.g. a death/attack overlay, which it already approximates procedurally). Any
statement that a new state is "wired into 2D" should be rejected unless the 2D renderer gains a frame atlas.

---

# Checklist 1 — COMPLETE AND WIRED

States/archetypes that exist **and** the engine actually requests:

- **17 standalone archetypes** pass their role check (`base_archer`, `base_axe2h`, `base_boar`, `base_camel_combined`,
  `base_cattle`, `base_deer`, `base_elephant_combined`, `base_elephant_spearman`, `base_heavy_spearman`,
  `base_horse_combined`, `base_horse_gaia`, `base_sheep`, `base_spearman`, `base_spearman_samurai`,
  `base_sword_2hand`, `base_sword_samurai`, `base_swordsman`).
- **22 canonical states** are requested and resolved: idle, guard, aim, fire, reload, attack, convert, throw, flinch,
  death, dead (animals), work, tool_idle, carry_idle, walk, jog, run, sprint, tool_walk, tool_run, carry_walk,
  carry_run (`viewer.js:2470-2471`).
- **Locomotion**: idle ↔ walk/jog/run/sprint blending with root motion and odometer phasing (`viewer.js:2535-2549`,
  `2588-2601`, `2765-2769`); 160 clips carry `move`.
- **Combat**: attack/fire/throw placed on the `hit` frame (77 clips carry `hit`), reload chains after shots
  (`viewer.js:2723-2736`).
- **Reactions**: flinch on HP drop, death clip + sink (`2739-2745`, `2705-2709`, `3537`).
- **Weapon overlays**: all 9 styles resolve to a variant or a plain fallback (§1.5).
- **Work loops**: build/farm/wood/gold/stone/berry/meat/fish + mounted work (§3.3).
- **Rider layering**: 26 rider clips (17 horse, 9 camel) play over the horse gait (`unit-batches.js:12-14`,
  `viewer.js:2762`).
- **Structures** are "wired" only procedurally — scaffold/clip/ruin/flash/gate swing (§2.2), not animation.
- **154 of 227 roster unit types** resolve to a mapped archetype (141 as recorded + 13 corrected, estimated).

# Checklist 2 — PRESENT BUT NOT WIRED

Exists in the folder/index but the engine never requests it, or never resolves to a clip. **B1 status:** `stop`,
`dropoff` and `heal` are now in `CLIP_STATES` and played by `unitAnim` (`stopsOf`, `dropsOf`, `healsOf`): the stop
clip as an arrival that pauses (> 0.3 m move, ≥ 0.25 s still, no job) settles, the load's dropoff clip where a
villager's carry ends (not at work stands), the heal clip through the monk's heal spans from the combat index; all
weighted by stillness so none slides while walking. The table is the audit-time state; what stays dead follows it.

| item | scope | evidence |
|---|---|---|
| `stop` clips | 40 clips across 26 archetypes | not in `CLIP_STATES` (`viewer.js:2470-2471`) |
| `stop@arquebus` | 1 | same |
| `heal` | 2 (base_monk, base_shaolin) | not in `CLIP_STATES`; monk/shaolin healing is never animated (`viewer.js:2470`) |
| `mount` / `dismount` | 2 (base_horse_combined) | no mount logic in `unitAnim`; rider always seated (`viewer.js:2702-2772`) |
| `dropoff` | 8 (7 worker/civilian sets + base_horse_combined) | not in `CLIP_STATES` |
| `tool_idle@herd`, `tool_walk@herd`, `tool_run@herd` | 3 (base_butcher) | `herd` absent from `JOB_KEY` (`viewer.js:2467`), so key never passed; herd reuses the meat `work` clip |
| `attack@swing` on base_heavy_spearman | 2 | style `swing` only assigned to `base_spearman` (`bake-anims.mjs:350`) |
| `dead` in non-animal tables | built for all, read only by `animalAnim` | `viewer.js:2797` |
| `convert` as a first-class state | only reached when `attack` is missing | `viewer.js:2725` |
| torch `throw` gaps | any archetype without `throw`: blow silently skipped | `viewer.js:2725-2726` |
| 9 `unmapped` blueprints | never resolve to an archetype | §1.6 |
| 13 roster units marked no-rig despite mapped catalog bps | serjeant, hospitaller-knight, kharash, wynguard-footman/footmen/ranger/rangers, earls-retinue, khans-hunter, szlachta-cavalry, emissary, yatai, reindeer-trader | §2.1 |
| all 164 structure sample blueprints | absent from `index.blueprints` | §2.3 |
| `poi_viz_excavator` | only blueprint with no idle → bind pose forever | `viewer.js:2491`, `2538-2539` |

Still dead after B1 (8 clips): `mount`/`dismount` (no mount or dismount event is recorded), the 3 `@herd` clips (the
recorder logs no herding job, so `JOB_KEY` has nothing to map), `attack@swing` on base_heavy_spearman (both
heavy-spearman blueprints wield `cdn_2h_spear`, so `styleOf` never picks `swing`; dropping them needs a rebake), and
the horse's `dropoff` (no mounted villager carries loads in the recordings).

# Checklist 3 — MISSING (create / export / map)

**A. Units with no usable rig (needs a new bake or a mapping fix)**

1. *Ships (32)* and *siege (26)* — unskinned catalog models; README:345 says static. This is the single biggest gap
   (58 unit types, 25.6% of the roster). To animate: export `base_ship*` / `base_siege*` skeletons and add SPEC +
   states; until then the engine has no place to put clips.
2. *Mapping-alias units (6)* — condottiero, camel-rider, demilancer, hippodrome-horseman, hippodrome-riddari,
   hippodrome-scout: no catalog blueprint under the id used by `roster.sample_blueprint`. [Inference] map to
   `base_swordsman` (condottiero), `base_camel_combined` (camel-rider), `base_horse_combined` (demilancer, hippodrome).
3. *Army/tech tokens (8)* — no rig needed (garrison-command, gunpowder-contingent, wynguard-army, wynguard-raiders,
   city-guard, imperial-retinue, provincial-levy, ranged-specialists).

**B. Missing states per archetype (highest impact first)**

1. ~~`base_elephant_archer`: walk, jog, run, sprint, attack~~ — not missing: it is the tower crew rig (§1.4); the crews
   now stand in their elephant's basket.
2. `base_spearshield`: aim, fire, reload — 10 ranged blueprints (bedouin-skirmisher etc.) shoot with `attack`/`guard`.
3. `base_monk`: guard, sprint. Attack, death and flinch already play through the `base_civilian` overlay that every
   monk mapping carries (`extra: ['base_civilian']`, 25/25 mappings).
4. `base_land_monster` / `base_water_monster`: death, dead (+ sprint) — the animal disappears at death instead of
   falling (`viewer.js:2795-2797` with `k=null`).
5. `base_shaolin`: flinch; `base_reindeer_combined`: guard, sprint, attack, flinch.
6. Animals missing `dead` pose: bigcat, crocodile, fox, wolf (they hold the death clip's last frame — acceptable but
   not the game's pose); `base_reindeer` missing `jog`.
7. `base_civilian`/`base_miner` missing `carry_idle`; `base_miner` also carries no idle (falls back to civilian).
8. `base_butcher`'s herding set: `work@herd` (shepherd) is not exported; herd plays the meat clip.

**C. No animation at all**

- **164/164 structures** — no skeletal animation; only procedural construction/ruin/flash/gates (§2.2). Nothing to
  create per-ID unless building clips are desired.
- **Enchanted stag (3 blueprints)** — no rig (`unmapped`), needs a `base_stag` archetype if it must move.

**D. Dead clip budget to reclaim**

- 58 clips (11.8%) were baked but unreachable: 40 `stop`, 8 `dropoff`, 2 `heal`, 2 `attack@swing` (heavy), 3
  `@herd`, 2 `mount/dismount`, 1 `stop@arquebus`. B1 wired `stop`, `dropoff` and `heal`; 8 remain (Checklist 2).

---

## Coverage numbers

- **154 of 227 unit types animated (estimated)** (roster records 141; +13 join corrections [inference]). Of the
  remaining 73: 58 ships/siege (no rig, README), 6 catalog-alias units, 8 army tokens, 1 building.
- **17 of 30 standalone archetypes complete** (17 of 36 total; 6 job-only sets are partial by design).
- **0 orphan clips** (all 490 are referenced by ≥1 state); **58 clips dead by wiring**; **0 dangling state refs**.
- **939/948 skinned blueprints mapped (99.1%)**; 9 unmapped; 0 stale mappings.
- **0/163 genuine structures** have skeletal animation (procedural construction/ruin only); **12/14 gaia kinds** have
  a gaia blueprint; **0** animation states in 2D.

---

## Evidence

### Index / bake
- `viewer3d/assets/anims/index.json` — single minified line; schema keys `archetypes`, `blueprints`, `unmapped`.
- `viewer3d/tools/havok/bake-anims.mjs:27-35` — schema + "unmapped = animated catalog blueprints without an archetype".
- `viewer3d/tools/havok/bake-anims.mjs:31-34` — canonical state list and `state@key` override rule.
- `viewer3d/tools/havok/bake-anims.mjs:330-352` — job regexes and `styleOf()` (weapon → overlay key per family).
- `viewer3d/tools/havok/bake-anims.mjs:590-605` — animated-blueprint filter (age model must have `bones`), resolve,
  `unmapped.push`, `modelsOf`.
- `viewer3d/tools/havok/bake-anims.mjs:617-620` — bake only used archetypes, filter empty states.

### Engine — state selection
- `viewer3d/viewer.js:2445-2460` — the animation section's own contract (locomotion/combat/reactions/work).
- `viewer3d/viewer.js:2467-2471` — `JOB_KEY`, `GAITS`, `CLIP_STATES` (22 canonical states).
- `viewer3d/viewer.js:2474-2475` — `index.json` load; bind pose if absent.
- `viewer3d/viewer.js:2483-2495` — `unitReady` requires `clipTable(...).idle.length > 0`.
- `viewer3d/viewer.js:2506-2528` — `clipTable`, variant collection, style retry, `T.ranged`.
- `viewer3d/viewer.js:2535-2549` — `gaitsOf`, gait-prefix fallback.
- `viewer3d/viewer.js:2588-2601` — `gaitPos` speed blending.
- `viewer3d/viewer.js:2603-2642` — two-clip crossfade + rider layer (`mixOut`).
- `viewer3d/viewer.js:2688-2693` — horse-archer `fire@bow` left/right selection.
- `viewer3d/viewer.js:2702-2772` — `unitAnim`: death `2705-2709`; job/key `2711-2712`; blow clips `2723-2736`
  (attack→convert `2725`, skip on missing `2726`, reload `2729-2733`); flinch `2739-2745`; work `2747-2755`;
  stance/gait `2757-2769`; props `2770`.
- `viewer3d/viewer.js:2778-2783` — `deathOf` (animal death time).
- `viewer3d/viewer.js:2790-2814` — `animalAnim`, `dead` hold and gait.
- `viewer3d/viewer.js:3533-3545` — per-frame flash, `animHeld`, `unitAnim` call and `units.set`.
- `viewer3d/viewer.js:1732-1737` — felling uses `units.resolve(...,'work',...)` and the clip duration.

### Engine — structures
- `viewer3d/viewer.js:2819-2822` — `FLAT_BP`, `SIEGE_BP`.
- `viewer3d/viewer.js:3100-3121` / `3122-3149` — generated scaffold / rubble geometry.
- `viewer3d/viewer.js:3166-3190` — `setSite` construction clip plane + scaffold.
- `viewer3d/viewer.js:3192-3231` — `showRuin` / `updateBuilding` (rise, sink, tilt, rubble, farm crop).
- `viewer3d/viewer.js:3417-3442` — `swingGates` (door pivots, angle table, not a clip).
- `viewer3d/viewer.js:3533-3534`, `3547` — damage flash (`FLASH_SECS` at `295`).
- `README.md:345` — "In 3D, ships and siege engines are static models (no rig support yet)."

### UnitBatches
- `viewer3d/unit-batches.js:1-18` — family/clip texture, two-clip blend, rider clips.
- `viewer3d/unit-batches.js:19-24` — LOD nodes, joint table, prop collapse.
- `viewer3d/unit-batches.js:25-32` — instance texture layout.
- `viewer3d/unit-batches.js:33-37` — culling + LOD hysteresis.
- `viewer3d/unit-batches.js:43-66` — API contract (`prepare`, `clip`, `props`, `set`, `update`, `stats`).
- `viewer3d/unit-batches.js:103-106` — `rvAnim`/`rvJoint`/`rvInst`/`rvBase` uniforms.
- `viewer3d/unit-batches.js:346-383` — `clipId` handles and `resolve()` chain.
- `viewer3d/unit-batches.js:388-395` — `prepare()`.
- `viewer3d/unit-batches.js:624-631` — per-instance LOD switch.

### Jobs
- `viewer3d/core/replay.js:361-375` — JOBS table (8 jobs: build, farm, wood, gold, stone, berry, meat, fish),
  `CARRY=16`, `HOLD=32`.
- `viewer3d/viewer.js:2467` — `JOB_KEY` mapping (no `herd`).

### Roster
- `docs/audit/roster.json:1313` — camel-rider (`anim_archetypes: []`).
- `docs/audit/roster.json:1469` — cataphract (sample bp token order differs from catalog).
- `docs/audit/roster.json:1844` — condottiero.
- `docs/audit/roster.json:9131` — serjeant (mapped catalog bps exist).
- `docs/audit/roster.json:19715` — worker-elephant, the only "structure" with an archetype.

### 2D viewer
- `viewer/map.js:6-9` — every unit is a `UNIT_ART` figure at any zoom.
- `viewer/map.js:43` — `BUILDING_TYPES`; `1145` — `UNIT_ART`; `1352-1360` — `paintUnit`; `1363` — sprites stamped.
- `viewer/map.js:1947` — `GAIA_ART`; `2082-2179` — death-mark/attack-line overlays.
- `viewer/app.js:104`, `938-966` — `requestAnimationFrame` render loop only.
- `viewer/frame.js:853` — shared `frame(t)` state query (no poses).
- `viewer/fx.js:18` — time-normalised overlay effects, not unit animation.
