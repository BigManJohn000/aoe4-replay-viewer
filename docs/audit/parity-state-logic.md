# Parity audit: 2D `viewer/` vs 3D `viewer3d/`

Harness run once: `node viewer3d/tools/parity-check.mjs` → **exit 0**, `aoe4_245598603: 790405 comparisons at 120 times, 1992 entities` / `parity OK`.

The 3D page loads every shared module (`viewer3d/index.html:440-450`), so combat, eco and fights already agree. The drift lives where the harness does not look: a **second complete replay model**, duplicated sight/fog, duplicated gaia handling, and duplicated HUD-facing facts.

## A. Replay model: `viewer/model.js` vs `viewer3d/core/replay.js`

The 3D page runs **both** models over the same payload: `M2 = RV.prepare(...)` (`viewer3d/viewer.js:973`) and `R = new Replay(...)` (`viewer3d/viewer.js:1017`). `marks.js`, `panels.js`, `hud.js` read `M2` (`marks.js:3,133-136`; `hud.js:29-32`); the renderer reads `R`.

| Fact | 2D (canonical path) | 3D | Divergence |
|---|---|---|---|
| Entity record | `model.js:100-127` (`type`, `bkind`, `sight`, `seen`, `ptier`) | `replay.js:100-142` (`seg`,`hd`,`isBuilding`,`isUnit`,`followsAge`,`builtAt`,`wall`,`arms`,`sup`,`cons`,`trips`,`mv`,`exV`,`garr`,`corpse*`) | 3D has **no** `type`/`bkind`/`sight`; 2D has none of the 3D animation state |
| Unit type / icon class | `RV_UNITS.rules`, first match (`model.js:42-50`) | none — `RV_UNITS` used only for `military` (`replay.js:397`) | `RV_UNITS.rules` is a 2D-only consumer |
| Building kind | 21 regex rules → `bkind` (`model.js:54-82`) | none; 3D icons read a **2D** entity (`viewer.js:4078`) | 3D cannot classify a building on its own |
| `isUnit` | excludes `other` (`model.js:673`) | includes `other` (`replay.js:130`), matching `frame.js:119` | 3D hand-patches call sites (`viewer.js:1223,3479`) |
| Tier | bp tier + upgrades (`model.js:155-164`); default `0` (`:124`) | + `ageOf(owner)` for buildings/villagers/scout/monk (`replay.js:736-742`); default `1` (`:128`) | building "visual tier" exists only in 3D |
| Display name | keeps `" I"`, keeps Tech/Defense/Viz/Resource tokens (`model.js:7-25`) | drops them (`replay.js:77-95`) | harness masks this (`parity-check.mjs:136`) |
| Defeats | `markDefeats` `model.js:129-149` | identical copy `replay.js:155-178` | pure duplication |
| Kills | `d.kills` sorted, `killT` (`model.js:315-316`) | same (`replay.js:430-431`) | none |
| Conversions / owner flips | `prepConversions`/`prepFlips` (`model.js:323-324,430-480`) | **absent** | 3D borrows `M2.conversions`/`M2.flips` (`marks.js:324-349`) |
| Sacred sites | `caps`/`changes`/`near`/`siteState`/`SITE_CAPTURE` (`model.js:326-401`) | absent; site is a plain gaia object drawn from `t >= spans[0]` (`viewer.js:1934,4540`) | holder/contested state is 2D-only (`hud.js:72`) |
| Vision | recorded mask + `seenBefore` + `explored` grid (`model.js:579-591,630-671`) | recorded mask only (`replay.js:264-269`); fog rebuilt from **catalog sight** (`viewer.js:5091-5182`) | two independent fog systems |
| Water | inferred in model, `+0.2` (`model.js:332-335`) | recomputed, same `+0.2` (`viewer.js:1477-1481`) | duplicate; `M2.waterLevel` unused |
| Relics | gaia `relic` (`convert.py:89`; `map.js:2013`) | gaia asset + marker fallback (`viewer.js:207,277`) | none material |
| Gaia `killed` | **dropped** (`model.js:230` destructures 8) | read, drives `killT` (`replay.js:294-299`) | 2D cannot time animal/bush death |
| Resource amounts | raw sample (`model.js:252-256`) | quantized to 10 s scan + `full` high-water (`replay.js:30,277,303,451`) | different displayed amount between samples |
| Walls / gates | link pairs + gate angle (`model.js:186-223`); gate fix by `bkind` (`:282-289`) | full shapes, tuck/arms/rows (`replay.js:200-203,869-934`); gate fix by `/gate/` (`:805-813`) | two wall geometries |
| Villager jobs | converter `d.jobs` (`eco.js:273`, `fights.js:1043`) | derived from geometry (`replay.js:364-382,581`) | different job source |
| Garrisons, corpses, supervision, Mongol trips, build times | none | `replay.js:509-579,838-851,750-795,778-795` | 3D-only facts |
| Attacks / blows / heals / damage typing | shared `frame.combat` (`model.js:339`) | shared `frame.combat` (`replay.js:422`) | agree; 3D re-times motion (`replay.js:470-501`) which 2D never does |
| Banked resources / pop | `RV.statsAt` (`model.js:620`) | `analysis.statsAt` (`analysis.js:8`) | duplicate query |
| Army | **entity count** `RV.armyAt` (`model.js:681-694`), used by panel (`app.js:684`) | 5 s series `analysis.armyAt` (`analysis.js:21`), used at `viewer.js:4382` | **different numbers in the two UIs** |
| Techs / age | table in `app.js:768-784`; no player-age derivation | `analysis.techTable` (`:33`) + `ageT` from `techs[kind=age]` (`replay.js:402-404`) | age-of-player is 3D-only |

## B. Shared modules: actually shared?

| Module | 2D call site | 3D call site | Verdict |
|---|---|---|---|
| `RV_UNITS` | `model.js:44` (rules), `:674` (military); `eco.js:240`, `fights.js` via stat classes | `replay.js:397` (military only); guard `viewer.js:957` | shared, **rules unused in 3D** |
| `RV_STATS` | `frame.js:148,205`; `eco.js:168,227` | only indirectly via `RV_FRAME.statOf` (`viewer.js:2525`, `frame.js:146`) and guard `viewer.js:965` | shared |
| `RV_FRAME` | `model.js:339-340`, `fx.js:12,33`, `eco.js:165`, `fights.js:102` | `replay.js:422`; `viewer.js:1023,2525,4616,4663` | shared |
| `RV_FX` | `fx.js` | `viewer.js:3761,3827-3834`; `fx3d.js` | shared |
| `RV_ECO` | `app.js:744`, `caster.js:33,211` | `viewer.js:4427`, `ecopanel.js` | shared |
| `RV_FIGHTS` | `app.js:653` | `viewer.js:4280` | shared |
| `RV_CARD` | `app.js:814,869,871` | `viewer.js:4639-4684` | shared |
| `RV_FIGHTPANEL`/`RV_ECOPANEL` | `app.js:653,744`; `map.js:787` | `viewer.js:4301,4317,4427` | shared |
| `RV.prepare` model | `app.js:78` | second copy at `viewer.js:973` | shared but **duplicated instance** |

Duplicated computations (same job, two sites): entity prep `model.js:100` / `replay.js:100`; `markDefeats` `:135`/`:164`; `prettify` `:14`/`:84`; `idxAt`/`alive`/`ownerAt`/`locate`/`hash01` exist in **three** places (`model.js:27,551,557,564,81`; `frame.js:72,89,94,101,81`; `replay.js:58,144,149,181,67`); `cameraAt`+`CAM_TICK` `model.js:491-525`/`replay.js:408-414,716-733`; `unitUpgrades` `:165`/`:817`; gate fix `:282`/`:805`; wall geometry `:187-223`/`:869-934`; gaia prep/locate `:227-270`/`:291-329`; `statsAt` `:620`/`analysis.js:8`; `armyAt` `:681`/`analysis.js:21`; `techTable` `app.js:768`/`analysis.js:33`; `killFeed` `app.js:718-732`/`analysis.js:44`; `jumpFight` `app.js:385-392`/`analysis.js:59`; water `model.js:335`/`viewer.js:1480`; sight/fog `model.js:87-98,630`/`viewer.js:5101-5182`; `footprint` `frame.js:123`/`replay.js:379`.

## C. Constant / threshold drift

Shared single sources (no drift): `PRIO_GOOD 0.8`/`PRIO_OK 0.4` and splash bands `[5, 6.25, 7.5]` (`frame.js:60-67`, exported `:68-69`, 3D only consumes them); Lanchester divisor/`AREA 1.5` (`fights.js:104,674+`); raid `RAID_MIN 150`, `ECO_RATE 0.6`, idle `4 m / 15 s / 20 s` (`fights.js:152-159`); micro weights `0.30/0.25/0.15/0.15/0.15` (`fights.js:106`); grades S≥90/A≥75/B≥60/C≥45 via `RV_FRAME.letter` (`fights.js:46`); eco `BENCH`/`WALK_SHARE` (`eco.js:80,91`); `WALL_LINK 6.6` in both (`model.js:186`, `replay.js:31`).

Values that **do** differ or are re-declared:

| Value | 2D | 3D |
|---|---|---|
| Fight lead-in | 5 s (`app.js:150`) | 3 s (`viewer.js:309,4137`) |
| `[`/`]` fight pick | `start > t+1` / `start < t-6` (`app.js:389-390`) | `start - lead > t + 0.5` / `start < t - 6` (`analysis.js:61-62`) |
| Fog cell / sight | 4 m, per-type table (`model.js:87-98,630`) | 2 m + catalog sight, stand-ins 52/15/41/28 (`viewer.js:5101,5120`) |
| Dock sight | 50 (`model.js:92`) | 50 from catalog sight (25/25 dock blueprints); the 15 stand-in at `viewer.js:5120` never applies |
| Wall / farm sight | 6 / 0 (`model.js:92`) | wall 6 from catalog sight (92/92); farm 15 — all 27 farm blueprints lack catalog sight and take the stand-in (`viewer.js:5120`) |
| Alert window | `ALERT_S 6`, merge 50 m (`model.js:407-408`) | toast quiet `15 s`, merge 50 m (`hud.js:13`) — same alerts, second threshold |
| Victory timers | none in 2D | `SACRED_WIN 600`, `WONDER_WIN 900` (`hud.js:9-10`) |
| Tier-I name / default tier | `" I"`, `0` | `""`, `1` (`replay.js:94,128`) |
| `SAMPLE 0.5` | `model.js:5`, `frame.js:42` | `replay.js:27`, `fights.js:103` |
| `CAM_TICK 1/8` | `model.js:505` | `replay.js:50` |
| `footprint` 9/7/3/6 | `frame.js:123` | `replay.js:379` |

## D. Data-contract drift

- Payload carries only `"format": 1` (`tools/convert.py:743`, validated on reuse `:702`). No collection-level schema version exists; `schemaVersion` belongs to the unrelated `harvest/` pipeline (`harvest/analyze_rlogs.mjs:34,793`).
- Missing-field handling is inconsistent **inside one engine pair**: `model.js:301` reads `d.attacks.times` unguarded, while `frame.js:317` guards `(d.attacks && …)` and `:344` uses `d.kills || []`; `replay.js` is fully `?.`/`??` tolerant (`:403-442`). A payload without `attacks` crashes both UIs at `RV.prepare` even though the 3D core alone would survive.
- 3D **mutates the payload**: `viewer.js:1020` sets `e.track = e.vision = null` on `window.REPLAY_DATA[...]` after both models are built. Any later consumer (e.g. `RV.explored`, `viewer.js:1020` ordering vs lazy fog) loses the source; 2D never mutates.
- Match list is shared (`viewer/data/index.js:1` `REPLAY_INDEX`, read by `app.js:37` and `portal.js:124`), but **notes discovery diverges**: 2D trusts the hand-maintained `REPLAY_NOTED` (`index.js:2`, `app.js:67`), 3D lists the directory at request time (`serve.mjs:137-141`, `viewer.js:975`). A new `notes/<name>.js` appears in 3D and not in 2D.
- Trends: both read `data/trends/games.js` (`trends.html:95-96`; `portal.js:124-126`) — shared.
- Links: 2D accepts `#<name>[/<moment>|/t<s>]` only (`app.js:44,100`) and reloads on `hashchange` (`:48`); 3D also accepts bare `#t<s>` (`viewer.js:929-934`) and has no `hashchange` handler. Default match agrees (`app.js:33`, `viewer.js:97`).

## E. Asset-coverage drift (from `docs/audit/roster.json`)

| Metric | Units (227) | Structures (164) |
|---|---|---|
| No 3D model at all (`age_models` empty) | **32 (14.1%)** | **1 (0.6%)** — `farm` (special-cased via `catalog.farms`) |
| Has a model but missing a per-age variant | 0 | 0 (all `ages` keys present) |
| No animation archetype | **86 (37.9%)** | **163 (99.4%)** — only `worker-elephant` |
| No icon | **26 (11.5%)**, all ⊂ the 32 | 0 |

No-model units cluster in navals (5), siege/springald (6), and civ variants (`civ`-suffixed `wynguard-*`, `hippodrome-*`, `hospitaller-*`, `demilancer`, `condottiero`, `dromon`). Fallbacks: 3D draws `FALLBACK_BY_CAT`/`FALLBACK_BY_BP` stand-ins (`viewer.js:251-278,827-833`), replaces them per type while GLBs load (`:1769-1792`), silently picks the nearest lower age (`:576-580`), and only admits it in the inspector (`:4644` "procedural model"). 2D has no models: unmatched blueprints get `unitType = null` and are drawn by category (`model.js:42-50`), `buildingKind` defaults `"other"` (`:81`).

## F. Parity-harness blind spots

Compared (`viewer3d/tools/parity-check.mjs`): entity count/ids (`:55-56`), kill rows (`:57-58`), gate-fixed bp (`:59`), tech table (`:62-76`), shots/melee blows (`:80-84`), damage numbers incl. type/bonus/splash flags (`:85-89`), heals (`:90-91`), eco rows + series (`:94-102`), fight list + per-fight rating/Lanchester/what-if/tug/idle/tags/heat/eco (`:104-117`), per-time alive/owner/position/HP (`:128-134`), vision masks (`:135`), tier for units only (`:137`), stats (`:140-141`), **army against the wrong 2D source** (`:143`), kill feed (`:146-153`), frame lists (`:154-168`), splash impacts at landings (`:170-178`).

Not compared: gaia (amounts, tracks, `killed`, `full`, scan quantization), wall shapes, `waterLevel`, sites/`siteState`, alerts, conversions/flips, orders/squads, cameras, villager jobs, garrisons, corpses, supervision, Mongol trips, `builtAt`, `place()` vs `locate()` (3D re-times motion, `replay.js:470-501`), fog cell/sight radii and explored grid, HUD victory/wonder/toasts, marks, panels (legend, army comp, unit labels, moments), `jumpFight`, asset selection/visual tier (`viewer.js:3289`), `summary`/APM, `type`/`bkind`/`sight`, `died`/`defeated`/`ups`, hash/notes/link handling.

## Synchronization plan

1. **One replay model.** Make `viewer/model.js` canonical and turn `viewer3d/core/replay.js` into a thin ESM adapter (`Replay` wrapping `RV.prepare`); delete `prepEntity`, `markDefeats`, `prettify`, `idxAt/alive/ownerAt/locate`, `cameraAt`, `unitUpgrades`, `fixGates`, `linkWalls`, `prepGaia` (`replay.js:100-329,805-934`). Keep only 3D-only derivations (`standToStrike`, `deathDrift`, `garrisons`, `villagerJobs`, `supervision`, `trips`, `wallAt`).
2. **Delete the double model in the page:** `viewer.js:973` M2 must become the same object as `R`; move `sites`/`alerts`/`conversions`/`flips`/`orders`/`squads`/`cameras`/`explored` into the one model so `marks.js`, `panels.js`, `hud.js` take `R`. Remove the `viewer.js:1020` payload mutation.
3. **Extract fog/sight** into `viewer/fog.js` exporting `sightOf(bp)`, `EXPLORE_CELL`, `exploredGrid(M, mask)`; 2D `map.js drawFog` and 3D `FogOfWar` (`viewer.js:5091-5182`) both consume it. One sight table — catalog when present, one stand-in fallback.
4. **Extract match state** (`SACRED_WIN`, `WONDER_WIN`, hold-all runs, toast thresholds) into `viewer/victory.js`; add it to the 2D header, delete `hud.js:9-16` constants and the duplicate alert filter (`hud.js:133-139` uses `RAID_QUIET 15` on top of `model.js:409-428`).
5. **Resolve `armyAt`:** make entity-derived `RV.armyAt` (`model.js:681`) canonical for both panels; keep `d.army` for charts only. Change `analysis.armyAt` to delegate, and fix `parity-check.mjs:143` to compare `RV.armyAt` against it.
6. **Delete `viewer3d/core/analysis.js`** after moving `statsAt`, `techTable`, `killFeed`, `jumpFight` into `model.js` as `RV.*`; unify the fight lead as one exported `RV.FIGHT_LEAD = 5` and one `jumpFight` rule.
7. **Generate the tables:** make `docs/audit/roster.json` the build input for `viewer3d/assets/asset-map.json` and `viewer/bkind.json` (building rules + icon types), so `RV.buildingKind`/`unitType` and 3D asset choice read generated data. Delete hand lists `model.js:54-78` and any `ASSET_MAP` literals.
8. **Extend parity-check** to cover gaia (amount, position, `killed`, `full`), `place()` vs `locate()`, wall rows, sites/`siteState`, alerts, conversions, cameras, `jumpFight`, fog sight per blueprint, HUD victory/toast numbers, and assert `ASSET_MAP` coverage for every blueprint in a recording. Stop normalizing names at `:136` once `prettify` is unified; drop the `|| 1` tier normalization at `:137`.
9. **CI gate:** run the harness over every name in `viewer/data/index.js`, not just the showcase; failing any MISMATCH blocks merge. Keep the current output contract (`parity OK` / `MISMATCH <check>: n`).
10. **One loader contract:** export `PAYLOAD_FORMAT = 1` from the converter, assert it in both loaders before `prepare`, guard `d.attacks` in `model.js:301`, and have `tools/convert.py` write `REPLAY_NOTED` from the `notes/` directory so 2D and 3D discovery cannot disagree.
