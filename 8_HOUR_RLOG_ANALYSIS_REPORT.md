# 8-hour .rlog analysis report

Autonomous run on 2026-10-23, 01:45–09:45 local. Build 11308 (current patch). Everything below came from local
scripts over cached data; only aggregated tables were read into model context.

## 1. Dataset

| Stage | Count | May | Expanded (other 2000+ players) |
|---|---:|---:|---:|
| Players listed (May + ladder rating ≥ 1 700 + snowballed 2000+ opponents) | 313 | 1 | 312 |
| Ranked 1v1 games listed (≤ 92 days) | 31 519 | | |
| **Eligible**: patch 11308, ≥ 5 min, both players MMR ≥ 2 000 | **1 719** | 65 | 1 654 |
| aoe4world summaries fetched OK (540 had none: HTTP 404) | 1 179 | 56 | 1 123 |
| Summaries analysed (2 non-1v1 shapes excluded) | 1 177 games / 2 354 player-games | 56 player-games | 2 298 |
| Replays downloaded (10–40 min games; 105 had no replay: HTTP 404) | 238 | 45 | 193 |
| `.rlog` recordings made in-game this run (26 downloaded replays left at the 09:05 cutoff, 1 unreadable) | 210 | 44 | 166 |
| `.rlog` recordings analysed (exactly 2 players; incl. the pre-existing May–Beasty showcase; 1 four-player recording excluded) | 211 | 45 | 166 |

- Game dates of the recorded set: 2026-07-23 → 2026-10-22. Mean MMR of the analysed set 2 199 (May 2 142, rest 2 206).
- Six recording batches, 1:54–2:29 per replay (playback runs at ≈ 17–19× real time), 0 recorder errors.
  Raw data: 1 078 MB of `.rlog`, 249 MB of `.rec` (git-ignored).
- `Scar_DoString("A4D_Speed(128)")` was tested as a faster playback switch: in build 11308's replay SCAR console both
  `Scar_DoString` and `A4D_Speed` are nil (the call errors). The recorder already requests `Game_SetSimRate(1000)`;
  playback is bound by one sim tick per rendered frame, so the speed ceiling is the game's frame rate.
- **Tables in §3–§7 come from the 151-recording snapshot (06:50)** and the summary set; §8 and the Micro Rating
  calibration use all 211 recordings. `harvest/analysis/SUMMARY.md` has the 211-recording versions of every table.
- Cohorts: "May" = games/sides involving May (profile 10307814, mostly Delhi Sultanate); "rest" = the other side or
  games without May. May plays almost only Delhi, so May-vs-rest differences are partly civ differences.

## 2. Method and limits

- Pipeline: `tools/harvest.py` (aoe4world index → SQLite `harvest/aoe4.db` → summaries → replays, 1.1 s pacing,
  429/5xx backoff, cached) → `tools/record_replay.py` (in-game recorder → `recordings/*.rlog` →
  `viewer/data/*.js`) → `tools/analyze_rlogs.mjs` (runs the viewer's own `RV_FRAME` combat index in `node:vm`,
  per-recording JSON cache, aggregate) and `tools/analyze_summaries.py` (eco and army statistics over summaries).
- `.rlog` attack samples give attacker → target only. Damage is the target's recorded HP drop, attributed by the
  viewer's blow reconstruction. There are no projectile or heal records: heals are HP rises within 8 m of a
  same-owner healer; splash is inferred around shot landings.
- Splash falloff uses a **matched control**: each unit's HP-drop probability and size in the landing sample minus the
  same unit's values 1 s earlier. Without the control, co-damage in big fights reads ≈ 1× primary out to 12 m.
- Summary timestamps are completion times (exact or +1 s against the build order). Win-rate associations are
  observational (Wilson 95 % CIs, unclustered); civ, MMR and game length confound them.

## 3. Findings: unit behaviour

### 3.1 DPS decomposition (151 recordings)

| Unit | Paper DPS | After armour | Uptime | 1 − waste | Effective (dealt / engaged s) | Effective ÷ after armour |
|---|---:|---:|---:|---:|---:|---:|
| Archer | 5.74 | 3.50 | 72.5 % | 81.0 % | 1.38 | 0.40 |
| Spearman | 7.98 | 7.09 | 66.5 % | 98.9 % | 5.66 | 0.80 |
| Crossbowman | 8.15 | 5.13 | 72.3 % | 100 % | 2.49 | 0.48 |
| Horseman | 7.39 | 6.52 | 65.9 % | 99.4 % | 4.67 | 0.72 |

- Ranged infantry delivers only 40–48 % of its after-armour DPS in fights; melee delivers 72–80 %. Ranged loses to
  armour (archer 39 %, longbow 50 %, yeoman 63 % mitigation vs spearman 12 %), missed/post-death shots
  (archer waste 19 %) and wide engagement windows.

### 3.2 Attack cadence

| Unit | Interval median (s) | Stats period (s) | Median ÷ period | Post-death shots per kill |
|---|---:|---:|---:|---:|
| Archer | 1.52 | 1.63 | 0.94 | 2.88 (May 3.67 / rest 2.40) |
| Crossbowman | 2.19 | 2.13 | 1.03 | 0 |
| Longbowman | 1.50 | 1.63 | 0.92 | 2.61 |
| Spearman | 2.31 | 1.88 | 1.23 | 0.06 |
| Horseman | 2.02 | 1.75 | 1.16 | 0.02 |
| Man-at-Arms | 1.67 | 1.38 | 1.22 | 0.08 |

- Ranged units fire at their stats period. Melee swings run 16–23 % slower than the period: chasing and retargeting.
- Overkill is mostly *post-death projectiles* (archers ≈ 3 per kill), not excess HP on killing blows (≤ 1.1 % of dealt).

### 3.3 Target switching and kiting

- Archers switch target 19.3× per engaged minute (spearmen 9.9×). Archer target choice is "good" 53 %, "poor"
  35 %; spearmen 84 % good.
- Ranged units fire 57–58 % of shots while moving > 0.5 m, but a melee unit is within 4 m for only 2.6–3.7 % of
  shots; median chase gain is 0 m per cycle. Kiting at 2000+ is positional (keep distance) rather than
  stutter-step.

### 3.4 Counters (direct exchanges in recordings, and main-unit win rates in summaries)

| Exchange (recordings) | HP per 100 res per engaged min | Direct killed / lost res |
|---|---:|---:|
| Horseman → Archer | 259.8 | 9 280 / 840 (11.0×) |
| Spearman → Horseman | 675.7 | 5 015 / 2 480 (2.0×) |
| Archer → Spearman | 126.6 | 2 000 / 1 360 (1.5×) |
| Crossbowman → Man-at-Arms | 167.7 | 1 100 / 2 880 (0.38×) |

- In summaries (1 177 games), main-unit pairs with n ≥ 25: archer vs Zhuge Nu 25 % (7/28), lancer vs spearman
  70 % (23/33), knight vs spearman 68 % (28/41), man-at-arms vs horseman 69 % (20/29), raider elephant vs spearman
  70 % (19/27). Main-unit win rates: knight 60 %, lancer 59 %, archer 51 %, spearman 46 %, longbow 42 %.

## 4. Findings: siege and splash

### 4.1 Firing intervals (inferred volleys = same shooter's shots within 1 s)

| Siege | Shots / volleys | Volley interval median (s) | Stats period (s) | HP per volley |
|---|---:|---:|---:|---:|
| Bombard | 907 / 842 | 5.50 | 5.38 | 192 |
| Clocktower battering ram | 754 / 750 | 5.09 | 5.13 | 162 |
| Battering ram | 176 / 176 | 5.05 | 5.13 | 178 |
| Culverin | 513 / 391 | 3.58 | 3.63 | 108 |
| Mangonel | 1 286 / 892 | 5.97 | 6.88 | 26 |
| Counterweight trebuchet | 646 / 504 | 10.17 | 11.38 | 191 |

- Siege fires at its stats period once engaged (0.87–1.02×). Mangonels shoot 1.4 recorded hits per volley (stats
  burst 3) for only 26 HP per volley and 0.88 victims.

### 4.2 Splash falloff (matched control; excess HP per enemy unit in the landing sample)

| Distance from landing | 0–1 m | 1–2 m | 2–3 m | 3–4 m | 4–5 m | 5–6 m | ≥ 6 m |
|---|---:|---:|---:|---:|---:|---:|---:|
| Mangonel ΔHP / unit | 16.9 | 16.8 | 9.2 | 5.0 | 1.2 | 0.1 | ≈ 0 |
| Mangonel ΔP(hit) | +46 % | +51 % | +24 % | +14 % | +5 % | +2 % | ≈ 0 |
| Nest of Bees ΔHP / unit | 3.0 | 4.6 | 4.3 | 3.2 | 2.7 | 0.6 | ≈ 0 |

- Mangonel: full effect ≤ 2 m, about half at 2–3 m, a third at 3–4 m, negligible beyond 5 m. Nest of Bees spreads
  thinly and evenly out to ~5 m. Trebuchets show no splash signal.
- No friendly-fire signal: friendly excess drops are ≤ 0 in every bin.

## 5. Findings: healing

| Healer | HP/s while healing | HP per healer alive-minute | Side-fights with the healer |
|---|---:|---:|---:|
| Scholar | 12.1 | 10.0 | 374 |
| Warrior monk | 7.2 | 38.6 | 120 |
| Ikko-ikki monk | 13.3 | 15.6 | 7 |

- Healing is rarely decisive in fight windows (typical heal share 0.4–2 % of damage taken), but sides that healed
  ≥ 10 % of the damage they took won 68 % of fights (167/245) vs 48 % (2 406/4 993) below 10 %.

## 6. Findings: eco-upgrade opportunity cost

Benchmarks = median completion seconds after the age-up (1 179 summaries; civ medians where n ≥ 30).

| Tech | Global | Notable civs | On-time WR | Delayed WR | Skipped WR | Median late | Median missed / net res |
|---|---:|---|---:|---:|---:|---:|---:|
| Wheelbarrow | 329 s | Delhi 22, French −87 | 53 % | 49 % | 37 % | 244 s | 647 / 447 |
| Double Broadax | 312.5 s | French 121, Byzantines 661 | 52 % | 48 % | 44 % | 210 s | 221 / 76 |
| Horticulture | 503 s | French 246, English 352 | 53 % | 48 % | 39 % | 198 s | 320 / 179 |
| Specialized Pick | 514 s | French 87, Delhi 159 | 54 % | 51 % | 39 % | 286 s | 466 / 319 |
| Shaft Mining | 494 s (Castle) | Delhi 248 | 62 % | 58 % | 37 % | 259 s | 945 / 603 |

- Skipping an eco tech is the costly mistake (37–44 % WR); a late tech costs 3–5 points of win rate. Delayed
  players who used the window (attacked, defended or boomed) won 50–57 %, close to on-time players (52–62 %);
  those who didn't use it won 45–50 % (Shaft Mining 58 %).
- Shaft Mining is the strongest signal (62 % on-time vs 37 % skipped), partly because only winning/long games reach it.
- May: on time for Wheelbarrow, Double Broadax and Specialized Pick in 86–96 % of games (Delhi researches eco techs
  early), Horticulture only 48 %; median lateness 73–346 s when late.

## 7. Findings: macro context (summaries)

- The military leader wins 58 % at 10 min, 65 % at 15, 68 % at 20.
- The side with the biggest 60 s army swing wins 89 %, 76 % excluding the last 2 min and 70 % for swings before
  15:00 (the raw figure is inflated by end-of-game collapse).
- Castle arrival 2–5 min before the opponent: 61 % WR; 2–5 min after: 39 %. Feudal timing alone barely matters
  (47–52 %).

## 8. Micro: what predicts winning a fight (211 recordings, 4 898 fights, 3 405 decided)

| Component (per side per fight) | p25 | p50 | p75 | Higher side wins | n |
|---|---:|---:|---:|---:|---:|
| Target priority | .62 | .81 | .96 | 55.1 % | 2 628 |
| Uptime | .38 | .57 | .78 | 55.5 % | 2 431 |
| Focus fire (kills with ≥ 3 own-team attackers) | .18 | .60 | 1 | 52.5 % | 2 007 |
| Kiting (shots while moving with melee ≤ 8 m) | 0 | 0 | .07 | 47.5 % | 1 031 |
| Splash (multi-hit siege shots) | 0 | .13 | .67 | 74.1 % | 27 |
| "Low overkill" alone | .65 | 1 | 1 | **36.6 %** | 1 986 |

- The old Micro Rating rewarded low overkill, but winners overkill more because they finish more kills. v2 judges
  waste together with focus fire.
- Lanchester (square-law) fight prediction is right in 60.8 % of decided fights (2 071 / 3 405).

Micro Rating v2 (score = weighted 2000+ percentile, 50 = median side), calibrated on and applied to all 211
recordings. v1 columns are from the 151-recording run.

| Cohort | v1 p25 / median / p75 | v2 p25 / median / p75 | Higher v2 side won the fight |
|---|---|---|---:|
| All sides | 58.7 / 71.4 / 81.5 | 39.3 / 48.7 / 59.7 | 52.0 % (1 763 / 3 389) |
| May sides / May games | 53.2 / 68.4 / 79.8 | 40.6 / 50.2 / 61.6 | 51.2 % (371 / 725) |
| Rest sides / rest-only games | 59.7 / 71.9 / 81.7 | 39.1 / 48.6 / 59.5 | 52.3 % (1 392 / 2 664) |

- v2 is centred where intended (median ≈ 49–50), so a grade now means "vs a 2000+ side", not "vs perfection". v1
  graded the median side B–A.
- Micro explains little of who wins a fight: the better-micro side wins 52 %, while army strength (Lanchester) gets
  61 %. At 2000+ micro differences are small next to army size, composition and upgrades. The rating is a
  quality score, not a predictor.
- May's sides score slightly above the rest (median 50.2 vs 48.6).
- Engine fixes after the run (audit B08–B11, N1; analysis schema 7) moved these numbers: fights 4 680 → 4 898
  (hits after a quiet second were dropped from fight detection: +2.24 M damage HP, 23 % of all damage),
  decided 3 379 → 3 405, Lanchester 61.0 % → 60.8 %, higher-v2 side 52.0 % → 52.0 % (1 741 / 3 347 →
  1 763 / 3 389), v2 median 48.6 → 48.7. Component percentiles shifted by ≤ .06 (splash p50 .18 → .13);
  CAL in `viewer/fights.js` was recalibrated on the new values. Conclusions unchanged.

## 9. 2D viewer upgrades (this run)

| Feature | Where | Default |
|---|---|---|
| Combat toggles split and grouped in a "Combat n/8 ▾" dropdown: Attacks (lines), Alerts, Target fire, Splash rings, Range rings | `viewer/index.html`, `app.js`, `map.js`, `fx.js` | **off** |
| Damage numbers, Heals ("+" and pulse ring), Projectiles (incl. siege firing cue) | same | on |
| Caster-mode 1v1 HUD: age, villagers/military, bank and /min, research chips, army-value tug, eco-debt chips | `viewer/caster.js`, key H | on |
| AoE4 World Explorer-style unit card: official portrait and description, upgraded stats ↗, bonus rows, live impact, **vs 2000+** benchmarks from `viewer/rv_bench.js` | `viewer/card.js` | on selection |
| Shift+click drops one unit, Alt+click drops a type (map and tray) | `viewer/app.js` | — |
| Measured mangonel splash bands (≤ 2 m full, 2–4 m ≈ 40 %, 4–5.5 m edge) | `viewer/fx.js` (2D `draw2d` only) | under Splash rings (off) |
| Siege reload arcs (weapon period) and shot flash | `viewer/fx.js`, `map.js` | under Projectiles (on) |
| Eco opportunity-cost indicator: live "missed" chips, ⚔ used / ✗ unused badge, timeline delay lanes, measured benchmarks | `viewer/eco.js`, `ecodebt.js`, `timeline.js`, `ecopanel.js` | on ("Eco debt") |
| Review fixes: offline portrait failures cached, resize keeps camera framing, Space on focused controls, stepwise healing totals | `card.js`, `app.js` | — |

No `viewer3d/` file was edited. The shared engines (`fx.js` exports, `eco.js`, `fights.js`) keep their APIs; the
parity check passed after every change (exit 0, 790 398 comparisons).

## 10. Fights tab upgrades

| Upgrade | Detail |
|---|---|
| Micro Rating v2 (`viewer/fights.js`) | Five parts as 2000+ percentiles: Priority 30 %, Focus 25 % (60 % focus-kill share + 40 % waste control), Kiting 15 % (moving share + chase gain; ranged vs melee only), Splash 15 % (siege sides only), Uptime 15 %; absent parts renormalised. Calibration constants embedded with their source. Raw component values kept under the old names, so the 3D list, parity check and analyser keep working. |
| Area fix | Uptime and splash now only count blows inside the fight area (v1 counted simultaneous distant combat). |
| Card breakdown (`viewer/fightpanel.js`) | "Micro N (grade)" per side with five percentile bars (absent parts grey) and a tooltip on the 2000+ baseline. |
| Army swing | Each side's army-value change from 10 s before to 10 s after the fight, signed and coloured. |
| Eco window | Fights during an overdue eco upgrade (RV_ECO benchmarks): who was delayed, how far into the delay, missed resources so far, and whether the opponent used the window and won or lost the trade. |
| Analyser | `ratingHigherWins` per cohort; v1 aggregate kept as `harvest/analysis/aggregate_v1.json`. |

Toggle checklist (2D, defaults): Attacks off · Alerts off · Target fire off · Splash rings off · Range rings off ·
Damage numbers on · Heals on · Projectiles on · Caster HUD on · Eco debt on.

## 11. Re-running

```
python tools/harvest.py games --refresh   # new games for every listed player
python tools/harvest.py summaries
python tools/harvest.py replays 40
python/python.exe tools/record_replay.py replays/harvest
node tools/analyze_rlogs.mjs              # → harvest/analysis/SUMMARY.md, micro_calibration.json, viewer/rv_bench.js
python tools/analyze_summaries.py         # → ECO_SUMMARY.md, ARMY_SUMMARY.md
node viewer3d/tools/parity-check.mjs
```

Progress log: `harvest/RUN_LOG.md`. Screenshots: `harvest/shots/`.
