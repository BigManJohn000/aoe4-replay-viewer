# 2D ↔ 3D parity audit — state, logic, data and features

Audit date: 2026-10-23 · Repo: `Fusion` · Scope: `viewer/` (2D, Canvas2D) vs `viewer3d/` (3D, three.js)
Method: static read with `path:line` evidence + one run of the project's parity harness. No code changed.

```
$ node viewer3d/tools/parity-check.mjs aoe4_245598603
aoe4_245598603: 790405 comparisons at 120 times, 1992 entities
parity OK                                            exit 0
```

---

## 1. Baseline — what already agrees

The two pages are **not** strangers: `viewer3d/index.html:440-451` loads the 2D folder's shared modules
(`units.js`, `stats.js`, `frame.js`, `fx.js`, `eco.js`, `ecopanel.js`, `fights.js`, `fightpanel.js`, `model.js`,
`card.js`, `map.js`) through `serve.mjs`'s `/shared/` mount. Both engines therefore agree on:

| Concern | Owner module | 2D call | 3D call |
| --- | --- | --- | --- |
| Unit classification rules | `viewer/units.js` (`RV_UNITS`) | via `model.js` | `viewer3d/viewer.js:957,1017` |
| Stats, weapons, upgrades | `viewer/stats.js` (`RV_STATS`) | via `frame.js` | `viewer.js:965` |
| Combat index, blows, damage typing, heals, target grades | `viewer/frame.js` (`RV_FRAME`) | `app.js` | `viewer.js:1023` `RV_FRAME.controller(R.combat)` |
| Frame lists (projectiles, impacts, heals, damage numbers, engagement lines) | `RV_FRAME.controller` | map drawing | `fx3d.js` |
| Eco opportunity cost | `viewer/eco.js` + `ecopanel.js` | Eco tab | `viewer.js:4427` |
| Fight analysis / Micro Rating | `viewer/fights.js` + `fightpanel.js` | Fights tab | `viewer.js:4276,4301,4317` |
| Unit card rows / selection tray | `viewer/card.js` | `app.js:813` | `viewer.js:4555-4635` |
| Map key art, gaia rules | `viewer/map.js`, `viewer/model.js` | direct | `viewer.js:971` (`RV.markIcon`, `RV.prepare`) |

The parity harness proves the **model layer** agrees (blows, damage numbers, heals, the five frame lists, splash
impacts, eco rows, fight analyses, entity position/HP/owner/vision/tier). That is a real achievement and it is the
right foundation — but it is also why the drift below went unnoticed: **every item in §3 is outside what the harness
compares.**

## 2. Root causes

1. **Two replay models for one recording.** The 3D page builds *both* the 2D model (`M2 = RV.prepare(...)`,
   `viewer3d/viewer.js:973`) and its own typed-array model (`R = new Replay(data, RV_UNITS, RV_FRAME)`,
   `viewer.js:1017`). The renderer reads `R`; marks/panels read `M2`. Two parsers, two derivations, one recording.
2. **Panel logic was ported, not shared.** `viewer3d/core/analysis.js:1-4` states it is "ported from the 2D viewer's
   app.js (renderPlayers, techTable, the kill feed filter, jumpFight)". Five functions now exist twice.
3. **Two UI shells.** 2D has a 5-tab sidebar (Fights, Players, Eco, Selection, +Moments) driven by `viewer/index.html`
   and `app.js`; 3D has a 3-tab drawer (Fights, Economy, Layers & settings) built in `index.html` + `viewer.js`.
   Labels, grouping, defaults and shortcuts are maintained separately.
4. **No shared ID registry.** `stats.js` (2,094 blueprints), `catalog.json` (3,013), `anims/index.json` (939) and the
   procedural 2D art (19 unit types, 22 building kinds) are joined ad hoc inside each engine.
5. **The harness scope is the model, not the product.** It never compares what the panels print, which option is on by
   default, or whether an ID has an icon/model/animation.

## 3. Discrepancy catalogue

### 3.1 State and logic (verified)

| # | Item | 2D | 3D | Evidence | Severity |
| --- | --- | --- | --- | --- | --- |
| L1 | Army numbers in the Players panel | entity-derived live count (`RV.armyAt(M,t)`) | 5 s converter series (`ana.armyAt(R,...)`) | `viewer/app.js:684`, `viewer3d/core/analysis.js:21`; the harness compares the **series** (`parity-check.mjs:143`, comment "2D app.js renderPlayers army columns") | **High** — `parity OK` does not cover the number the 2D panel actually shows |
| L2 | What counts as a unit | `RV.isUnit` excludes `building`, `attachment`, **`other`** | `isUnit` excludes only `building`, `attachment` → `other` is a unit | `viewer/model.js:673` vs `viewer3d/core/replay.js:130`; 3D patches around it at `viewer.js:1223,3479` | Medium — a classification difference (3 `other` entities in the aggregate). It does not reach army or "On screen" totals: `panels.js:70-72` filters military/villager types and Players uses the converter series |
| L3 | Fight jump (`[` / `]`) | lead 5 s, "next if `start > t+1`" | lead 3 s, "next if `start − lead > t+0.5`" | `viewer/app.js:150,389` vs `viewer3d/viewer.js:309,4137`, `core/analysis.js:59` | Medium — same key lands on a different fight near edges |
| L4 | Fight list ranking | `value + 0.01·damage` | `RV_FIGHTS.impact` (resources + forced idle + swing) | `viewer/app.js:559-562` vs `viewer3d/viewer.js:4286-4288` | Medium — "by size" ≠ "Most impactful" |
| L5 | Water level | `M.waterLevel` computed once in the model | recomputed independently from `R.gaia` fish | `viewer/model.js:332-335` vs `viewer3d/viewer.js:1477-1481` (same constant, duplicated logic) | Low — but two formulas to keep in sync |
| L6 | Gaia `killed` flag | dropped | kept on the entity | `viewer3d/core/replay.js:294` (`killed: r.killed`); `viewer/model.js:230` drops it | Low — 3D-only affordance (killed map objects) |
| L7 | Display names | keeps trailing " I" and `Tech/Defense/Viz/Resource` tokens | strips them (`prettify`) | `viewer/model.js:7-25` vs `viewer3d/core/replay.js:77-95`; `parity-check.mjs:136` normalises the difference away | Medium — tooltip/labels read differently for the same entity |
| L8 | Kill feed behaviour | Players tab, seeks to `t−3`, no selection | Fights pane, seeks to `t−4`, selects the victim | `viewer/app.js:718-733` vs `viewer3d/viewer.js:4408-4416,4455-4464` | Medium — same data, different interaction |
| L9 | Moments | own tab, applies `m.tab`, pans the map clear of the caption | box inside Fights, ignores `m.tab`, no caption pan, focus radius ×2.4 | `viewer/app.js:458-530` vs `viewer3d/panels.js:168-235` | Medium |
| L10 | Under-attack alert source | ring only, drawn by the map | rings + toasts; rings re-gated on the **attack lines** toggle | `viewer/map.js:818-`, `viewer3d/marks.js:178-182,262-276`, `hud.js:128-177` | Medium — turning attacks off silently kills alert rings in 3D |
| L11 | Sight / fog radii | one hand table per unit type and building kind, 4 m explore cell (`UNIT_SIGHT`/`BUILDING_SIGHT`, `viewer/model.js:87-98`) | catalog `sight` first, regex stand-ins only when the blueprint has none, 2 m fog cell (`viewer3d/viewer.js:5091-5122`) | farm **0 vs 15** (all 27 farm blueprints lack catalog sight and fall to the 15 stand-in). Docks (25/25 → 50) and walls (92/92 → 6) resolve to the same radius in both viewers (`model.js:92` vs `viewer.js:5120`) | Medium — farms reveal ground in 3D only |
| L12 | Alert / victory thresholds | `ALERT_S 6` merge logic in the model | own constants: `SACRED_WIN 600`, `WONDER_WIN 900`, `RAID_QUIET 15`, `TOAST_MS 5000` | `viewer/model.js:407-408` vs `viewer3d/hud.js:9-15` | Medium — two "quiet period" rules over the same alerts |
| L13 | Payload health | 2D reads `d.attacks.times` unguarded (`model.js:301`) | 3D is tolerant, but **mutates** the shared payload (`viewer.js:1020`) | `viewer/model.js:301`, `viewer3d/viewer.js:1020` | Medium — one missing field crashes both; 3D's mutation breaks later readers |
| L14 | Notes discovery | trusts hand-maintained `REPLAY_NOTED` (`viewer/data/index.js:2`, `app.js:67`) | lists `notes/` at request time (`serve.mjs:137-141`) | same | Low — a new note appears in 3D but not 2D |
| L15 | Tier defaults and names | tier default `0`, names keep " I" / Tech tokens | tier default `1`, names stripped | `viewer/model.js:124` vs `viewer3d/core/replay.js:128`; `model.js:7-25` vs `replay.js:77-95` | Low |

### 3.2 Data and asset coverage (counted from `docs/audit/roster.json`, `stats.js`, `catalog.json`, `anims/index.json`)

| Coverage | Count | Consequence |
| --- | --- | --- |
| Distinct unit types / structure types | 227 / 164 | the real visual roster (3,013 raw blueprints; 2,094 stat entries) |
| Stat blueprints with **no** `catalog.json` row | 65 | 3D falls back to procedural stand-in (`viewer.js:251-278,827-833`) |
| Unit types with **no** 3D model at all | 32 by exact stats ↔ catalogue join; **20** after the 13 alias corrections (12 of the 32 have a model under an alias) | stand-in shapes only, e.g. `baghlah`, `camel-rider`, `condottiero`, `dromon`, `war-cog` |
| Structure types with no model | 1 (`farm`) | drawn procedurally |
| Unit types with **no** animation archetype | 86 (37.9 %), of which 13 are stats-id ↔ catalogue alias misses that *are* animated | 32 ships + 26 siege are static by design; 8 army/tech tokens need no rig; ~6 alias gaps |
| Structure types with skeletal animation | 0 (the one entry, `worker-elephant`, is a unit-classed building) | structures animate only via construction/ruin/flash (`viewer.js:1053`) |
| Unit types with **no** icon in `assets/icons` | 26 by exact join; **24** after aliases (`earls-retinue`, `kharash` have icons) | 2D card falls back to map art; 3D selection tray has no image |
| `anims/index.json` blueprint mappings | 939 of 3,013 | 2,074 catalogue blueprints never resolve to clips |
| Unmapped animation blueprints | 9 | `unit_siege_crew_*`, `unit_logistics_wagon`, `unit_archer_tower_ram_*`, `gaia_*_enchanted_stag*` |

### 3.3 User-facing features present in one engine only

| Only in 2D | Only in 3D |
| --- | --- |
| Caster HUD (broadcast strip, income estimates, research ticker, army-value tug) `viewer/caster.js` | Victory conditions: sacred-site dots + 10:00 countdown, wonder construction + 15:00 countdown `viewer3d/hud.js:28-116` |
| Eco debt chips + timeline delay lanes `viewer/ecodebt.js`, `timeline.js:43-147` | Under-attack notifications `hud.js:128-177` |
| "vs 2000+" benchmark card (`rv_bench.js` is not loaded by 3D) `card.js:275-307` | Player-camera possession (watch through a player's recorded view, `C`) `viewer.js:3960-3981` |
| Range rings (max 40) `map.js:381,403` | Graphics quality High/Low, AO, shadows, grass, health-bar mode, tactical grid, kill markers, engagement zones `index.html:374-418` |
| Clickable fight bands + tech ticks on the timeline `timeline.js:163-166,286-308` | Unit-scale slider + "true size up close" + per-object scale/Y tweaks `viewer.js:4474-4527` |
| Compass map rotation `app.js:318-371` | Matches/recording portal + 2D cross-link at the current time `portal.js` |
| Fight composition before/after table + trade verdict `app.js:599-658` | Floating gold/stone amount labels when zoomed in `viewer.js:3730-3756` |
| Full four-row map key (units, buildings, map, marks) `app.js:207-223` | Trends modal (2D navigates away to `trends.html`) |
| Unavoidable "last seen" building ghosts `map.js:370-373` | "Ghost unseen enemies" opt-in for every entity type `viewer.js:3306-3311` |

### 3.4 Option defaults (the same checkbox, different promise)

| Option | 2D default | 3D default | Note |
| --- | --- | --- | --- |
| Attack lines | **off** (`index.html:21`) | **on** (`index.html:385`) | 3D also bundles alert rings into it |
| Target fire | off | off | consistent |
| Alerts | own box, off | welded to attacks | cannot show rings without lines |
| Damage numbers | on | on | 2D "Damage", 3D "Damage numbers & flash" |
| Heals | own box, on | inside "Combat FX", on | not separable in 3D |
| Projectiles | on | on | consistent |
| Splash rings | **off** | **on** (inside Combat FX) | 3D cannot turn splash off alone |
| Range rings | off | — | missing in 3D |
| Trails / Orders | on / on | on / on | consistent |
| Eco orders | off | off | consistent |
| Unit labels | off | off | consistent |
| Cameras | off | off | consistent |
| Key | on | on | 3D key lists lines/marks only |
| Army comp | on | on | consistent |
| Caster HUD | on | — | 2D only |
| Eco debt | on | — | 2D only, but the shared eco panel's help text still mentions it (`ecopanel.js:64`) |
| Health bars | always | on (+ damaged/all) | 3D only setting |
| Kill markers / zones / grid | always | on | 3D only settings |

## 4. Synchronization plan (proposal — nothing implemented)

Ordered by leverage per unit of risk. Steps 1-4 remove the *cause*; 5-8 stop recurrence; 9-10 close the
product gaps.

1. **Declare one replay model.** Make `viewer/model.js` (`RV.prepare`) the single source; turn
   `viewer3d/core/replay.js` into a typed-array *view* built from `RV` entities (keep its arrays for rendering) — or
   delete it once a perf comparison on the biggest recording passes. Keep `parity-check.mjs` green during the change;
   it is the migration safety net. This kills L1, L2, L5, L6, L7, L15 at the root. Move the facts the 3D model owns
   alone (`sites`, `conversions`, `flips`, `explored`, `garrisons`, `corpses`, `trips`, `builtAt`) into the one model
   so `marks.js`/`panels.js`/`hud.js` stop borrowing `M2` while the renderer reads `R`.
2. **Lift `core/analysis.js` into the shared folder** (`viewer/paneldata.js`): `statsAt`, `armyAt`, `techTable`,
   `killFeed`, `jumpFight`. Both engines import it; delete the 2D copies in `app.js` or re-export them. Fixes L1 and
   L3/L8 inconsistency by construction.
3. **One option/shortcut registry** (`viewer/ui-options.js` or `.json`): id, label, group, default, applies-to,
   shortcut, mutually-exclusive group. Both pages render their controls from it, so §3.4 cannot drift again, and a
   test asserts both pages expose the same ids/defaults.
4. **One ID registry** (`viewer/ids.js`, generated): blueprint → family, kind, categories, per-age model, per-age icon,
   animation archetype, tier. Generated by a tool that joins `stats.js` + `catalog.json` + `anims/index.json`, so the
   asset coverage in §3.2 becomes a build error instead of a silent fallback. This is also the lookup the new icon set
   needs (see `ICON_STYLE_GUIDE.md`).
5. **Extend the parity gate.** Add to `parity-check.mjs` (or a sibling `parity-ui.mjs`): the panel numbers at sampled
   times (Players row, On-screen counts, fight ranking order, victory timers), the option defaults, the shortcut map,
   and ID coverage (every roster id → icon, model, clip where applicable). Exit non-zero on any gap; run it in
   `tools/tests` and before a release.
6. **Resolve defaults deliberately.** Pick one truth per option (recommend: attack lines off, splash off, alerts its own
   toggle in both) and apply it through step 3. Keep 3D-only rendering options (AO, grass, grid) out of the comparison.
7. **Consolidate duplicated renderers.** Card, timeline, players/tech tables, kill feed, selection summary, map key and
   moments are each written twice (see `docs/audit/parity-state-logic.md` appendix). Move the DOM-building parts of
   `card.js`/`fightpanel.js` pattern outward: one builder module + a thin per-engine adapter.
8. **Make "view-specific" explicit.** Add a capability table (feature → 2D / 3D / both) in the shared folder, consumed
   by the UI to grey out or link what the other engine has. That is the cheap answer for features that genuinely belong
   to one view (caster HUD, camera possession).
9. **Close the product gaps in priority order** (each independent, all cheap):
   a. Extract fog/sight and match state first (one `sightOf()` table, one `SACRED_WIN`/`WONDER_WIN`/quiet-window
      module), then add victory conditions to 2D and the toasts to 2D from that shared module (fixes L11, L12 too).
   b. Eco debt → 3D (shared `ecodebt.js`/`ecopanel.js` already exist; needs the timeline layer + chips).
   c. "vs 2000+" benchmarks → 3D (load `shared/rv_bench.js`, one call site in the card).
   d. Range rings → 3D (selection already has `RV_FRAME` reach; `map.js:403` is the reference).
   e. Caster HUD: keep 2D-only (broadcast layout does not fit the 3D drawer) but state it in the capability table.
10. **Documentation gate.** README's parity claims, the screenshots in `docs/screenshots/` (the 2D screenshot predates
    the current Combat/Layers popovers) and the "what is shared" table must be regenerated from the same registry, or
    they become the next source of drift.

---

## Appendix

- Full state/logic/data evidence, including fog/sight radii, walls, sacred sites and the harness blind-spot list:
  `docs/audit/parity-state-logic.md`.
- Icon coverage, tier rules and integration points: `docs/audit/ICON_STYLE_GUIDE.md`, `docs/audit/ICON_PROMPTS.md`.
- Animation coverage: `docs/audit/animation-audit.md`.
