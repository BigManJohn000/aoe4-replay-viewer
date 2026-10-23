"use strict";
// eco.js: the economy opportunity-cost and tempo engine both viewers share. Pure analysis (no DOM; runs in a node vm):
// load it after units.js, stats.js and frame.js, then call RV_ECO.analyze(d, C) with the replay data and the combat
// index (2D: M.combat from RV.prepare; 3D: R.combat). The villager techs it audits:
//   Wheelbarrow, Double Broadax (wood II), Horticulture (food II), Specialized Pick (gold II, stone too),
//   Shaft Mining (gold III; stats.js has no tech named "Acid Distillation"). Names, costs, research times and
//   effects come from stats.js (RV_FRAME.techOf), resolved by attribName prefix so civ variants (_sul Delhi: free but
//   slow, _mon, _byz, ...) are the very tech the player researched.
//
// RV_ECO.analyze(d, C, opts) → { players: Map idx → { idx, name, civ, team, end, rates, techs: [row] }, thresholds }
//   cached on C (opts.fresh = true recomputes). Row fields:
//     id, key (the attribName researched, or the one the civ would have), name, resource(s), resources[],
//     status: "ontime" | "late" | "never" | "na" (no benchmark: the age it needs was never reached),
//     tActual   completion time of the research (null: never researched),
//     tStart    tActual − research time (the moment the bank paid; null when never researched),
//     tBench    completion time the benchmark expects, benchSource "opponent" | "benchmark" (+ benchOpponent idx),
//     cost {f,w,g,s}, costTotal, researchTime,
//     rateBase / rateUp (res per villager per second, average over the delay, weighted by gatherers), multiplier,
//     rates { resource: { rate, source, n } } (the player's measured no-tech rates, see "Base rate"),
//     rateSource "measured" | "default" | "mixed",
//     missed    resources not gathered because of the delay,
//     deficit   missed − costTotal (negative: the delay saved more than it cost),
//     tempo     { t0: tBench+90, t1: tBench+180 },
//     capitalized { yes, label, applies, bank{...}, impact{...}, reason },
//     assumption text.
//
// RV_ECO.series(d, C, idx, key) → [[t, cumulative missed]] for charting. key: a tech id ("wheelbarrow", "double-broadax",
//   "horticulture", "specialized-pick", "shaft-mining": the stats.js `b`) or an attribName prefix of the row's key.
// RV_ECO.TECHS → [{ id, name, key, resources, match, needs, kind }], names read from stats.js.
// RV_ECO.BENCH, RV_ECO.IMPACT, RV_ECO.ASSUMPTIONS → the documented constants.
//
// ── Formulas ──
// Gatherers g_r(t): d.jobs[idx] rows [t, food, wood, gold, stone, other] (villagers on each resource, held to the next row).
//
// Missed = Σ over t in [T_bench, T_actual) of  g_r(t) · rate_base_r(t) · (m − 1) · dt, summed over the resources r the
//   tech speeds up. rate_base_r(t) = r0_r · M_other_r(t): r0_r the player's no-tech rate and M_other_r(t) the product of
//   the multipliers of every OTHER gather tech the player had finished by t (stacked techs are the base: a Double
//   Broadax delayed past Lumber Preservation loses 1.15 of the already-1.15 rate). m is the tech's own multiplier from
//   stats.js (×1.15, ×1.10, Mongol "improved" variants ×1.17/×1.18 ...). Never researched: integrated to the end of the
//   replay. T_actual ≤ T_bench: missed 0 (on time).
//
// Wheelbarrow has no gather-rate multiplier (carryCapacity +5, moveSpeed ×1.15), so its value is an effective rate gain
//   from shorter and fewer drop-off trips (model below): ASSUMPTIONS.wheelbarrow.
//
// Benchmark T_bench (a completion time) answers "when would a competent player have had it":
//   - the opponent's: when an enemy-team player researched the same tech with an earlier START than this player did,
//     T_bench = that enemy's start + this player's own research time (so Delhi's 157–300 s research is not charged for
//     a civ trait, only for starting late); a free tech (Delhi: cost 0) is not a timing against a player who pays for
//     it; the start is never earlier than the age the tech needs (NEEDS) was reached. Several enemies: the earliest.
//   - otherwise BENCH: age arrival (own Feudal/Castle completion, d.techs kind "age") + the measured median COMPLETION
//     offset for this civ (n >= 30 researchers), else the global median; research time is already included.
//
// Base rate (not in the data): per player and resource, the effective rate per villager is
//   r0 = Σ income / Σ g·M(t)·dt over sliding 90 s windows (step 30 s), income = Δbank + spend. Bank: d.stats[idx]
//   (food, wood, gold, stone). Spend is a ledger: units (cost at born − production time), buildings (cost when placed),
//   researched techs (cost at completion − research time; Delhi's cost 0 is 0), all from stats.js. The windows' rates are
//   divided by the stacked multiplier so r0 is the no-tech rate; the median of windows with ≥ 250 villager-seconds is
//   clamped to [0.3, 1.5]. Fewer than 4 windows: DEFAULT_RATE (rateSource "default"). Unrecorded income (relics, sacred
//   sites, trade, herdables) and unledgered spend (conversions) make the gold rate noisy; the median absorbs them.
//
// Capitalized (the delay bought tempo) needs BOTH:
//   (a) bank: during the decision window [T_bench − researchTime, T_actual − researchTime] (when the player could have
//       queued it vs when it did; at most its first IMPACT.bankWindow = 180 s) the bank rarely afforded the tech (affordable < 25 % of samples) and ≥ 50 % of what
//       was spent went to military units/buildings and defences, at least as much as the tech cost (min 100);
//   (b) impact in the tempo window [T_bench + 90, T_bench + 180]: any of IMPACT's thresholds: enemy gatherer drop
//       (idle villager-seconds against the 60 s before), kills, damage dealt to enemy buildings, or a held defence
//       (a fight at the player's base where the enemy team lost more than the player's team).
//   Otherwise "NO (Pure Eco Deficit)" with the deficit. Combat measures are team-level (allies share a fight).
(function () {
  const E = {};
  window.RV_ECO = E;

  const RES = ["food", "wood", "gold", "stone"];

  // ── documented assumptions ──
  const BASE_CARRY = 10;                 // villager carry capacity before Wheelbarrow (stats.js: carryCapacity change +5 → 15)
  // Share of one gather trip (gather + walk + drop) spent walking and dropping at the base carry capacity. Not
  // recorded; typical placements: farms touch their mill/TC, lumber and mines sit a short walk from a camp.
  const WALK_SHARE = { food: 0.12, wood: 0.3, gold: 0.25, stone: 0.25 };
  const DEFAULT_RATE = { food: 0.75, wood: 0.65, gold: 0.6, stone: 0.6 }; // res/villager/s, used when too few windows
  const RATE_CLAMP = [0.3, 1.5];
  const MEASURE = { win: 90, step: 30, minGatherSec: 250, minWindows: 4 };
  const TEMPO = [90, 180];               // s after T_bench
  // Measured median COMPLETION seconds after age arrival from harvest/analysis/eco_summaries.json, generated by
  // tools/analyze_summaries.py on 2026-10-23 at 06:45 UTC: 1179 summaries, 1177 analysed ranked1v1 patch11308 games,
  // 2354 player-games, 2000+ MMR. Global researcher n: Wheelbarrow 1690, Double Broadax 1550, Horticulture 1356,
  // Specialized Pick 1219, Shaft Mining 573.
  // Civ overrides use recording civ names and only samples with n >= 30; all other civs use the global median.
  // completion = age arrival + (civ override ?? done), with no added research time; negative offsets precede age-up.
  const BENCH = {
    wheelbarrow: {
      age: "feudal", done: 329,
      civ: { abbasid: 420, abbasid_ha_01: 323, byzantine: 324, chinese: 387, sultanate: 22, english: 389.5,
        french: -87, mongol_ha_01: 289, hre: 486, english_ha_01: 617, french_ha_01: 55, jin: 159.5,
        templar: 532, macedonian: 479, malian: 414, mongol: 209, hre_ha_01: 477.5, ottoman: 154.5,
        rus: 412, chinese_ha_01: 149 },
    },
    "double-broadax": {
      age: "feudal", done: 312.5,
      civ: { abbasid: 369.5, abbasid_ha_01: 371, byzantine: 661, chinese: 349, sultanate: 137, english: 359,
        french: 121, mongol_ha_01: 212, hre: 369.5, english_ha_01: 487, jin: 447, macedonian: 307.5,
        malian: 110, mongol: 363, hre_ha_01: 484.5, ottoman: 274, rus: 347.5, sengoku: 333, chinese_ha_01: 277 },
    },
    horticulture: {
      age: "feudal", done: 503,
      civ: { abbasid: 488.5, abbasid_ha_01: 510.5, byzantine: 457, chinese: 559, sultanate: 409, english: 352,
        french: 246, hre: 473.5, english_ha_01: 678, jin: 651, templar: 535, macedonian: 700, malian: 508.5,
        mongol: 635, hre_ha_01: 544.5, ottoman: 565.5, rus: 529 },
    },
    "specialized-pick": {
      age: "feudal", done: 514,
      civ: { abbasid: 477, abbasid_ha_01: 496, byzantine: 716, chinese: 602, sultanate: 159, english: 460.5,
        french: 87, mongol_ha_01: 558, hre: 572.5, english_ha_01: 630.5, japanese: 615, jin: 723.5,
        templar: 647.5, macedonian: 442, malian: 558, mongol: 479, hre_ha_01: 603, rus: 654.5 },
    },
    "shaft-mining": {
      age: "castle", done: 494,
      civ: { sultanate: 248, english: 586, french: 325, english_ha_01: 561.5, jin: 683, templar: 449.5, rus: 556 },
    },
  };
  const NEEDS = { wheelbarrow: null, "double-broadax": "feudal", horticulture: "feudal", "specialized-pick": "feudal", "shaft-mining": "castle" };
  const IMPACT = {
    idleVilSec: 270,     // enemy gatherers below their pre-window level, villager-seconds (≈ 3 villagers for 90 s)
    killValue: 200,      // resource value of enemy units killed (≈ 4 villagers)
    kills: 3,            // or this many kills
    structureHp: 600,    // HP lost by enemy buildings
    heldRadius: 40,      // m beyond the fight radius that still counts as "at the player's base"
    affordable: 0.25,    // bank counts as below cost when it afforded the tech in under this share of the delay
    milShare: 0.5,       // share of the spend in the decision window that is military + defence
    bankWindow: 180,     // s: the bank/spend check covers at most the first 3 minutes of a long delay
    milMin: 100,         // and at least this many resources (or the tech's cost, if more)
  };
  const ASSUMPTIONS = {
    wheelbarrow: "No gather-rate multiplier: modelled as trips of " + BASE_CARRY + " → " + BASE_CARRY + "+carry resources with walking " +
      "×speed; walk share of a base trip " + JSON.stringify(WALK_SHARE) + " (not recorded; farms sit at their mill, wood and mines farther).",
    rate: "Rate = player's measured no-tech rate × the other gather techs already researched; multiplier from stats.js.",
    bench: "Benchmark = enemy start (same tech, earlier than this player's) re-timed to this player's research time, else " +
      "own age arrival + measured median completion offset (civ n>=30, otherwise global; no added research time). " +
      "Source: harvest/analysis/eco_summaries.json from tools/analyze_summaries.py, generated 2026-10-23 at 06:45 UTC; " +
      "1179 summaries, 1177 analysed ranked1v1 patch11308 games, 2354 player-games, 2000+ MMR; global researcher n: " +
      "Wheelbarrow 1690, Double Broadax 1550, Horticulture 1356, Specialized Pick 1219, Shaft Mining 573.",
  };
  E.BENCH = BENCH; E.IMPACT = IMPACT; E.ASSUMPTIONS = ASSUMPTIONS; E.TEMPO = TEMPO; E.WALK_SHARE = WALK_SHARE; E.DEFAULT_RATE = DEFAULT_RATE;

  // replay civ name → stats.js civ code, for the variant of a tech a player never researched
  const CIV_CODE = {
    english: "en", french: "fr", hre: "hr", rus: "ru", chinese: "ch", sultanate: "de", mongol: "mo", abbasid: "ab",
    ottoman: "ot", malian: "ma", japanese: "ja", byzantine: "by", macedonian: "mac", templar: "kt", sengoku: "sen",
    tughlaq: "tug", jin: "jin", chinese_ha_01: "zx", abbasid_ha_01: "ay", french_ha_01: "je", hre_ha_01: "od",
    english_ha_01: "hl", mongol_ha_01: "gol",
  };

  const DEFS = [
    { id: "wheelbarrow", base: "upgrade_unit_town_center_wheelbarrow_1", kind: "trip", match: /^upgrade_unit_(town_center_)?wheelbarrow_(1|byz)(_(?!jpn)|$)/ },
    { id: "double-broadax", base: "upgrade_econ_resource_wood_harvest_rate_2", kind: "rate", match: /^upgrade_econ_resource_wood_harvest_rate_2(_|$)/ },
    { id: "horticulture", base: "upgrade_econ_resource_food_harvest_rate_2", kind: "rate", match: /^upgrade_econ_resource_food_harvest_rate_2(_|$)/ },
    { id: "specialized-pick", base: "upgrade_econ_resource_gold_harvest_rate_2", kind: "rate", match: /^upgrade_econ_resource_gold_harvest_rate_2(_|$)/ },
    { id: "shaft-mining", base: "upgrade_econ_resource_gold_harvest_rate_3", kind: "rate", match: /^upgrade_econ_resource_gold_harvest_rate_3(_|$)/ },
  ];
  const TECHS = [];
  E.TECHS = TECHS;
  const RATE_P = /^(food|wood|gold|stone)GatherRate$/;

  const F = () => window.RV_FRAME;
  function init() {
    if (TECHS.length || !F() || !window.RV_STATS) return;
    const T = window.RV_STATS.techs;
    for (const def of DEFS) {
      def.variants = Object.keys(T).filter((k) => def.match.test(k));
      const t = F().techOf(def.base);
      const f = factors(def, t, null);
      def.res = RES.filter((r) => f[r] !== 1 || def.kind === "trip");
      def.needs = NEEDS[def.id];
      TECHS.push({ id: def.id, name: t ? t.n : def.id, key: def.base, kind: def.kind, resources: def.res.slice(), match: def.match, needs: def.needs, multiplier: t ? { food: f.food, wood: f.wood, gold: f.gold, stone: f.stone } : null });
    }
  }

  // ── math helpers ──
  function idxAt(arr, t) {
    let lo = 0, hi = arr.length - 1, r = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] <= t) { r = m; lo = m + 1; } else hi = m - 1; }
    return r;
  }
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const sum4 = (c) => (c ? (c.f || 0) + (c.w || 0) + (c.g || 0) + (c.s || 0) : 0);
  function median(a) {
    if (!a.length) return NaN;
    const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
    return s.length & 1 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /** Per-resource speed-up a researched tech gives: gather-rate multipliers, or the Wheelbarrow trip model. */
  function factors(def, tech, _p) {
    const f = { food: 1, wood: 1, gold: 1, stone: 1 };
    if (!tech) return f;
    if (def && def.kind === "trip") {
      let carry = 0, speed = 1;
      for (const e of tech.eff || []) {
        if (e.p === "carryCapacity" && e.e === "change") carry += e.v;
        else if (e.p === "moveSpeed" && e.e === "multiply") speed *= e.v;
      }
      for (const r of RES) f[r] = tripFactor(r, carry, speed);
      return f;
    }
    for (const e of tech.eff || []) {
      const m = RATE_P.exec(e.p);
      if (m && e.e === "multiply" && !e.k) f[m[1]] *= e.v;
    }
    return f;
  }
  /**
   * Wheelbarrow as an effective rate multiplier. A base trip of BASE_CARRY resources takes 1 time unit: gather share
   * 1−s, walking-and-dropping share s (s = WALK_SHARE[r]). With carry c = (BASE_CARRY+carry)/BASE_CARRY the gather part
   * grows c-fold and walking is v times faster, the trip carries c times as much:
   *     m = c / (c·(1−s) + s/v).         (carry +5, speed ×1.15, s = 0.30 → 1.144; s = 0.12 → 1.053)
   */
  function tripFactor(r, carry, speed) {
    const s = WALK_SHARE[r], c = (BASE_CARRY + carry) / BASE_CARRY, v = speed || 1;
    return c / (c * (1 - s) + s / v);
  }
  const slotOf = (key) => { for (const d of DEFS) if (d.match.test(key)) return d.id; return key; };
  function defOf(key) { for (const d of DEFS) if (d.id === key || d.match.test(key)) return d; for (const d of DEFS) if (key && d.base.indexOf(key) === 0) return d; return null; }

  /** The tech a player would have researched: the civ's variant, else the generic one. */
  function variantFor(def, civ) {
    const T = window.RV_STATS.techs, code = CIV_CODE[civ];
    const ok = def.variants.filter((k) => T[k].civs && T[k].civs.includes(code));
    ok.sort((a, b) => /improved/.test(a) - /improved/.test(b));
    const key = ok.length ? ok[0] : def.base;
    return { key, tech: T[key] };
  }

  // ── per-player series ──
  function bldClass(bp) {
    if (/defense|palisade|wall|tower|outpost|keep|fortress|gate|bastion|castle|fort_/.test(bp)) return "def";
    if (/barracks|archery|stable|siege|workshop|military|arsenal|dock_mil/.test(bp)) return "mil";
    return "eco";
  }
  const MIL_CAT = new Set(["infantry", "cavalry", "ranged", "siege", "religious", "naval"]);

  /** Spend ledger of one player: [{ t, c: [f,w,g,s], k: "eco"|"mil"|"def"|"tech"|"other" }] sorted by time. */
  function ledger(C, d, idx) {
    const rows = [], rs = d.recordStart || 0;
    const FR = F();
    for (const e of C.ents) {
      if (e.owner !== idx || e.born <= rs + 0.01) continue;
      if (e.cat === "attachment" || e.cat === "livestock" || e.cat === "gaia") continue;
      const st = FR.statOf(e.bp);
      if (!st || !st.cost) continue;
      const c = st.cost;
      if (!sum4(c)) continue;
      let t, k;
      if (e.cat === "building") { t = e.born; k = bldClass(e.bp); }
      else {
        t = Math.max(rs, e.born - (c.t || 0));
        // scouts by blueprint: the 3D entity table has no `type` field
        k = e.cat === "villager" ? "eco" : (MIL_CAT.has(e.cat) && !/^unit_scout/.test(e.bp)) ? "mil" : "other";
      }
      rows.push({ t, c: [c.f || 0, c.w || 0, c.g || 0, c.s || 0], k });
    }
    for (const u of (C.upgrades && C.upgrades.get(idx)) || []) {
      const c = u.tech.cost;
      if (!c || !sum4(c)) continue;
      rows.push({ t: Math.max(rs, u.t - (c.t || 0)), c: [c.f || 0, c.w || 0, c.g || 0, c.s || 0], k: "tech" });
    }
    rows.sort((a, b) => a.t - b.t);
    return rows;
  }

  /** Everything per player the tech rows need. */
  function prep(d, C, idx, end) {
    const jobs = d.jobs[idx] || [], stats = d.stats[idx] || [], n = jobs.length;
    const T = new Float64Array(n), G = RES.map(() => new Float32Array(n));
    for (let i = 0; i < n; i++) { T[i] = jobs[i][0]; for (let r = 0; r < 4; r++) G[r][i] = jobs[i][1 + r]; }
    const st = new Float64Array(stats.length);
    for (let i = 0; i < stats.length; i++) st[i] = stats[i][0];
    const B = RES.map(() => new Float64Array(n));
    for (let i = 0; i < n; i++) {
      let j = i < stats.length && st[i] === T[i] ? i : idxAt(st, T[i]);
      if (j < 0) j = 0;
      if (stats.length) for (let r = 0; r < 4; r++) B[r][i] = stats[j][1 + r];
    }
    // multiplier events: each finished tech that changes a gather rate
    const ev = [];
    for (const u of (C.upgrades && C.upgrades.get(idx)) || []) {
      const def = defOf(u.key), f = factors(def, u.tech, null);
      if (RES.some((r) => f[r] !== 1)) ev.push({ t: u.t, slot: slotOf(u.key), f: RES.map((r) => f[r]) });
    }
    const P = { idx, n, T, G, B, ev, end, led: ledger(C, d, idx), up: (C.upgrades && C.upgrades.get(idx)) || [] };
    P.dt = new Float64Array(n);
    for (let i = 0; i < n; i++) P.dt[i] = Math.max(0, Math.min(i + 1 < n ? T[i + 1] : end, end) - T[i]);
    // spend prefix sums per resource and class
    P.lt = P.led.map((x) => x.t);
    P.lc = RES.map(() => new Float64Array(P.led.length + 1));
    P.lk = { eco: new Float64Array(P.led.length + 1), mil: new Float64Array(P.led.length + 1), def: new Float64Array(P.led.length + 1), tech: new Float64Array(P.led.length + 1), other: new Float64Array(P.led.length + 1) };
    for (let i = 0; i < P.led.length; i++) {
      const x = P.led[i];
      for (let r = 0; r < 4; r++) P.lc[r][i + 1] = P.lc[r][i] + x.c[r];
      for (const k in P.lk) P.lk[k][i + 1] = P.lk[k][i] + (x.k === k ? x.c[0] + x.c[1] + x.c[2] + x.c[3] : 0);
    }
    return P;
  }
  /** Stacked multiplier on resource r at t from every tech but `excl`. */
  function stack(P, r, t, excl) {
    let m = 1;
    for (const e of P.ev) if (e.t <= t && e.slot !== excl) m *= e.f[r];
    return m;
  }
  const spendTo = (P, t) => idxAt(P.lt, t) + 1; // number of ledger rows with time ≤ t
  function spendBetween(P, a, b, r) { return P.lc[r][spendTo(P, b)] - P.lc[r][spendTo(P, a)]; }
  function spendClass(P, a, b, k) { return P.lk[k][spendTo(P, b)] - P.lk[k][spendTo(P, a)]; }

  /** Per resource: the player's no-tech effective rate (see header "Base rate"). */
  function measureRates(P) {
    const out = {};
    const { n, T } = P;
    // Σ g·M·dt prefix per resource
    for (let r = 0; r < 4; r++) {
      const cum = new Float64Array(n + 1);
      for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + P.G[r][i] * stack(P, r, T[i], null) * P.dt[i];
      const rates = [];
      if (n) {
        for (let t = T[0]; t + MEASURE.win <= P.end; t += MEASURE.step) {
          const ia = Math.max(0, idxAt(T, t)), ib = Math.max(0, idxAt(T, t + MEASURE.win));
          const gs = cum[ib] - cum[ia];
          if (gs < MEASURE.minGatherSec) continue;
          const inc = P.B[r][ib] - P.B[r][ia] + spendBetween(P, T[ia], T[ib], r);
          const v = inc / gs;
          if (v > 0.05 && v < 3) rates.push(v);
        }
      }
      const name = RES[r];
      if (rates.length >= MEASURE.minWindows) out[name] = { rate: clamp(median(rates), RATE_CLAMP[0], RATE_CLAMP[1]), source: "measured", n: rates.length };
      else out[name] = { rate: DEFAULT_RATE[name], source: "default", n: rates.length };
    }
    return out;
  }

  /**
   * Integrates the missed resources of one tech over [t0, t1]: the Σ of the header. Returns the missed amount, the
   * gatherer-weighted base (res without the tech) and per-resource detail; collect pushes the cumulative curve.
   */
  function integrate(P, rates, slot, f, resIdx, t0, t1, collect) {
    let missed = 0, base = 0, gsec = 0;
    const per = {};
    for (const r of resIdx) per[RES[r]] = { gatherSec: 0, missed: 0, base: 0 };
    if (collect) collect.push([t0, 0]);
    for (let i = Math.max(0, idxAt(P.T, t0)); i < P.n && P.T[i] < t1; i++) {
      const a = Math.max(P.T[i], t0), b = Math.min(i + 1 < P.n ? P.T[i + 1] : P.end, t1);
      const dt = b - a;
      if (dt <= 0) continue;
      for (const r of resIdx) {
        const g = P.G[r][i] * dt;
        if (!g) continue;
        const rb = rates[RES[r]].rate * stack(P, r, a, slot);
        const m = g * rb * (f[RES[r]] - 1);
        missed += m; base += g * rb; gsec += g;
        const p = per[RES[r]]; p.gatherSec += g; p.missed += m; p.base += g * rb;
      }
      if (collect) collect.push([b, missed]);
    }
    return { missed, base, gsec, per };
  }

  function ageTime(d, idx, age) {
    if (!age) return null;
    const re = age === "feudal" ? /^Feudal/ : age === "castle" ? /^Castle/ : /^Imperial/;
    for (const x of d.techs || []) if (x[3] === "age" && x[1] === idx && re.test(x[2])) return x[0];
    return null;
  }

  // ── tempo window ──
  function impactOf(env, p, tb) {
    const { d, C, teamOf, bldPos } = env;
    const t0 = tb + TEMPO[0], t1 = Math.min(env.end, tb + TEMPO[1]);
    const mine = teamOf.get(p), res = { window: [t0, t1], enemyIdle: 0, kills: 0, villagerKills: 0, killValue: 0, structureDamage: 0, heldDefense: 0, hits: [] };
    if (t1 <= t0) return res;
    const enemy = [...teamOf.keys()].filter((q) => teamOf.get(q) !== mine);
    // enemy gatherers below their level of the 60 s before the window
    for (const q of enemy) {
      const Q = env.P.get(q);
      if (!Q || !Q.n) continue;
      const tot = (i) => Q.G[0][i] + Q.G[1][i] + Q.G[2][i] + Q.G[3][i];
      let bs = 0, bt = 0;
      for (let i = Math.max(0, idxAt(Q.T, t0 - 60)); i < Q.n && Q.T[i] < t0; i++) { bs += tot(i) * Q.dt[i]; bt += Q.dt[i]; }
      if (!bt) continue;
      const base = bs / bt;
      for (let i = Math.max(0, idxAt(Q.T, t0)); i < Q.n && Q.T[i] < t1; i++) {
        const dt = Math.min(Q.T[i] + Q.dt[i], t1) - Math.max(Q.T[i], t0);
        if (dt > 0) res.enemyIdle += Math.max(0, base - tot(i)) * dt;
      }
    }
    // kills of enemy units (killer known, on the player's team)
    for (const k of C.kills || []) {
      if (k.t < t0 || k.t > t1 || k.killer == null) continue;
      const v = C.byId.get(k.victim), a = C.byId.get(k.killer);
      if (!v || !a || teamOf.get(v.owner) === undefined || teamOf.get(a.owner) !== mine || teamOf.get(v.owner) === mine) continue;
      res.kills++;
      if (v.cat === "villager") res.villagerKills++;
      res.killValue += v.value || sum4((F().statOf(v.bp) || {}).cost);
    }
    // HP lost by enemy buildings
    for (let i = 0; i < C.dmgT.length; i++) {
      const t = C.dmgT[i];
      if (t < t0 || t > t1) continue;
      const v = C.byId.get(C.dmgId[i]);
      if (v && v.cat === "building" && teamOf.has(v.owner) && teamOf.get(v.owner) !== mine) res.structureDamage += C.dmgAmt[i];
    }
    // held defence: a fight around the player's buildings that the enemy team lost
    const bl = bldPos.get(p) || [];
    for (const f of d.fights || []) {
      if (f.end < t0 || f.start > t1) continue;
      const parts = f.participants || [];
      if (!parts.some((q) => teamOf.get(q) === mine) || !parts.some((q) => teamOf.has(q) && teamOf.get(q) !== mine)) continue;
      const reach = (f.radius || 0) + IMPACT.heldRadius;
      let near = false;
      for (const b of bl) {
        if (b.born > f.end || (b.died && b.died < f.start)) continue;
        const dx = b.x - f.x, dz = b.z - f.z;
        if (dx * dx + dz * dz <= reach * reach) { near = true; break; }
      }
      if (!near) continue;
      let own = 0, foe = 0;
      for (const q in f.losses || {}) { const v = f.losses[q].value || 0; if (teamOf.get(+q) === mine) own += v; else foe += v; }
      if (foe > own) res.heldDefense++;
    }
    for (const k of ["enemyIdle", "kills", "killValue", "structureDamage", "heldDefense", "villagerKills"]) res[k] = Math.round(res[k]);
    if (res.enemyIdle >= IMPACT.idleVilSec) res.hits.push("enemyIdle");
    if (res.killValue >= IMPACT.killValue || res.kills >= IMPACT.kills) res.hits.push("kills");
    if (res.structureDamage >= IMPACT.structureHp) res.hits.push("structureDamage");
    if (res.heldDefense > 0) res.hits.push("heldDefense");
    return res;
  }

  function bankOf(P, row, a, b) {
    const cost = [row.cost.f, row.cost.w, row.cost.g, row.cost.s];
    let aff = 0, tot = 0;
    for (let i = Math.max(0, idxAt(P.T, a)); i < P.n && P.T[i] < b; i++) {
      tot++;
      if (cost.every((c, r) => P.B[r][i] >= c)) aff++;
    }
    const share = tot ? aff / tot : 1;
    const mil = spendClass(P, a, b, "mil"), def = spendClass(P, a, b, "def"), eco = spendClass(P, a, b, "eco"), tech = spendClass(P, a, b, "tech"), other = spendClass(P, a, b, "other");
    const total = mil + def + eco + tech + other;
    const need = Math.max(IMPACT.milMin, row.costTotal);
    return {
      window: [a, b], affordableShare: +share.toFixed(2), belowCost: row.costTotal > 0 && share < IMPACT.affordable,
      spentMilitary: Math.round(mil), spentDefense: Math.round(def), spentEco: Math.round(eco + tech), spentTotal: Math.round(total),
      mostlyMilitary: total > 0 && mil + def >= IMPACT.milShare * total && mil + def >= need,
    };
  }

  const fmt = (v) => (Math.round(v)).toString();
  const fmtT = (t) => { const m = Math.floor(t / 60), s = Math.floor(t % 60); return m + ":" + (s < 10 ? "0" : "") + s; };

  function capitalize(env, P, row) {
    const cap = { yes: false, applies: true, label: "NO (Pure Eco Deficit)", bank: null, impact: null, reason: "" };
    if (row.status === "ontime" || row.status === "na") {
      cap.applies = false; cap.label = row.status === "ontime" ? "On time" : "n/a";
      cap.reason = row.status === "ontime" ? "Researched by the benchmark: no delay to capitalize on." : "No benchmark: the age this tech needs was never reached.";
      return cap;
    }
    const tr = row.researchTime, end = row.tActual != null ? row.tActual : env.end;
    const w0 = row.tBench - tr;
    cap.bank = bankOf(P, row, w0, Math.min(Math.max(w0, end - tr), w0 + IMPACT.bankWindow));
    cap.impact = impactOf(env, P.idx, row.tBench);
    const a = cap.bank.belowCost && cap.bank.mostlyMilitary, b = cap.impact.hits.length > 0;
    cap.yes = a && b;
    const why = [];
    if (row.costTotal <= 0) why.push("tech is free (" + fmt(row.researchTime) + " s research): no bank to trade for it");
    else if (!cap.bank.belowCost) why.push("bank afforded it " + Math.round(cap.bank.affordableShare * 100) + " % of the " + fmt(cap.bank.window[1] - cap.bank.window[0]) + " s checked");
    else if (!cap.bank.mostlyMilitary) why.push("only " + fmt(cap.bank.spentMilitary + cap.bank.spentDefense) + " of " + fmt(cap.bank.spentTotal) + " res went to military/defence");
    if (!b) why.push("no tempo gain in " + fmtT(cap.impact.window[0]) + "–" + fmtT(cap.impact.window[1]));
    if (cap.yes) {
      cap.label = "YES";
      cap.reason = "Bank below cost with " + fmt(cap.bank.spentMilitary + cap.bank.spentDefense) + " res on military/defence; tempo " + cap.impact.hits.join(", ") + " in " + fmtT(cap.impact.window[0]) + "–" + fmtT(cap.impact.window[1]) + ".";
    } else {
      cap.reason = (row.deficit >= 0 ? "Pure eco deficit of " + fmt(row.deficit) + " res" : "Pure eco delay, net +" + fmt(-row.deficit) + " res (the unspent cost outweighs the loss)") +
        " (missed " + fmt(row.missed) + " − cost " + fmt(row.costTotal) + "): " + why.join("; ") + ".";
    }
    return cap;
  }

  // ── a tech row ──
  function techRow(env, P, def, rates, civ) {
    const idx = P.idx, d = env.d;
    const mine = P.up.find((u) => def.match.test(u.key));
    const V = mine ? { key: mine.key, tech: mine.tech } : variantFor(def, civ);
    const tech = V.tech, f = factors(def, tech, null);
    const resIdx = RES.map((r, i) => i).filter((i) => def.kind === "trip" || f[RES[i]] !== 1);
    const cost = { f: (tech.cost || {}).f || 0, w: (tech.cost || {}).w || 0, g: (tech.cost || {}).g || 0, s: (tech.cost || {}).s || 0 };
    const tr = (tech.cost || {}).t || 0;
    const tActual = mine ? mine.t : null, tStart = mine ? mine.t - tr : null;
    const row = {
      id: def.id, key: V.key, name: tech.n, resources: resIdx.map((i) => RES[i]), resource: resIdx.map((i) => RES[i]).join("+"),
      status: "na", tActual, tStart, tBench: null, benchSource: null, benchOpponent: null, cost, costTotal: sum4(cost), researchTime: tr,
      rateBase: NaN, rateUp: NaN, multiplier: NaN, rates: {}, rateSource: "default", missed: 0, deficit: 0, tempo: null, capitalized: null,
      assumption: "",
    };
    // benchmark
    const ageNeed = ageTime(d, idx, def.needs), agePro = ageTime(d, idx, (BENCH[def.id] || {}).age);
    let oppStart = Infinity, oppIdx = null;
    for (const q of env.enemies.get(idx)) {
      const Q = env.P.get(q);
      const u = Q && Q.up.find((x) => def.match.test(x.key));
      if (!u) continue;
      // a civ-trait free tech (Delhi) starts the moment the game does: not a timing this player's bank could match
      if (sum4(u.tech.cost) === 0 && row.costTotal > 0) continue;
      const us = u.t - (u.tech.cost.t || 0);
      if (us < oppStart) { oppStart = us; oppIdx = q; }
    }
    const myStart = tStart == null ? Infinity : tStart;
    if (oppStart < myStart && (def.needs == null || ageNeed != null)) {
      row.tBench = Math.max(oppStart, ageNeed != null ? ageNeed : -Infinity) + tr; row.benchSource = "opponent"; row.benchOpponent = oppIdx;
    } else if (agePro != null) {
      row.tBench = agePro + (BENCH[def.id].civ[civ] ?? BENCH[def.id].done); row.benchSource = "benchmark";
    }
    row.tempo = row.tBench == null ? null : { t0: row.tBench + TEMPO[0], t1: row.tBench + TEMPO[1] };
    // rates and the integral
    let lo = row.tBench != null ? row.tBench : (tActual != null ? tActual : 0), hi = tActual != null ? tActual : env.end;
    const late = row.tBench != null && hi > row.tBench;
    row.status = row.tBench == null ? "na" : !late ? "ontime" : mine ? "late" : "never";
    const ref = late ? integrate(P, rates, def.id, f, resIdx, lo, hi, null) : integrate(P, rates, def.id, f, resIdx, lo, Math.min(env.end, lo + 60), null);
    row.missed = late ? ref.missed : 0;
    if (ref.gsec > 0) {
      row.rateBase = ref.base / ref.gsec; row.multiplier = (ref.base + ref.missed) / ref.base; row.rateUp = row.rateBase * row.multiplier;
    } else {
      let b = 0, mm = 0;
      for (const i of resIdx) { b += rates[RES[i]].rate * stack(P, i, lo, def.id); mm += f[RES[i]]; }
      row.rateBase = b / resIdx.length; row.multiplier = mm / resIdx.length; row.rateUp = row.rateBase * row.multiplier;
    }
    let meas = 0;
    for (const i of resIdx) { row.rates[RES[i]] = rates[RES[i]]; if (rates[RES[i]].source === "measured") meas++; }
    row.rateSource = meas === resIdx.length ? "measured" : meas ? "mixed" : "default";
    row.deficit = row.missed - row.costTotal;
    row.capitalized = capitalize(env, P, row);
    const tail = mine ? "" : " Never researched: integrated to the end of the replay (" + fmtT(env.end) + ").";
    row.assumption = (def.kind === "trip"
      ? "Wheelbarrow has no gather multiplier (carry +" + (f && tech.eff ? (tech.eff.find((e) => e.p === "carryCapacity") || { v: 0 }).v : 0) + ", move speed ×" + ((tech.eff || []).find((e) => e.p === "moveSpeed") || { v: 1 }).v + "). " + ASSUMPTIONS.wheelbarrow
      : ASSUMPTIONS.rate) + " " + ASSUMPTIONS.bench + tail;
    return row;
  }

  function buildEnv(d, C, opts) {
    const end = d.capturedEnd ?? d.duration;  // held jobs are only known up to the last sample
    const teamOf = new Map(), enemies = new Map();
    for (const p of d.players) teamOf.set(p.idx, p.team);
    for (const p of d.players) enemies.set(p.idx, d.players.filter((q) => q.team !== p.team || p.team == null).map((q) => q.idx).filter((q) => q !== p.idx));
    const P = new Map();
    for (const p of d.players) P.set(p.idx, prep(d, C, p.idx, end));
    const bldPos = new Map();
    for (const e of C.ents) {
      if (e.cat !== "building" || !teamOf.has(e.owner)) continue;
      if (!bldPos.has(e.owner)) bldPos.set(e.owner, []);
      bldPos.get(e.owner).push({ x: e.x[0], z: e.z[0], born: e.born, died: e.died });
    }
    return { d, C, end, teamOf, enemies, P, bldPos };
  }

  E.analyze = function (d, C, opts) {
    init();
    if (!TECHS.length) throw new Error("RV_ECO: RV_STATS / RV_FRAME not loaded");
    if (C.eco && !(opts && opts.fresh)) return C.eco;
    const env = buildEnv(d, C, opts);
    const players = new Map();
    for (const p of d.players) {
      const P = env.P.get(p.idx), rates = measureRates(P);
      P.rates = rates;
      players.set(p.idx, { idx: p.idx, name: p.name, civ: p.civ, team: p.team, end: env.end, rates, techs: DEFS.map((def) => techRow(env, P, def, rates, p.civ)) });
    }
    C.eco = { players, thresholds: { BENCH, IMPACT, TEMPO, MEASURE, WALK_SHARE, DEFAULT_RATE, RATE_CLAMP }, _env: env };
    return C.eco;
  };

  E.series = function (d, C, idx, key) {
    const A = E.analyze(d, C), pl = A.players.get(idx);
    if (!pl) return [];
    const row = pl.techs.find((r) => r.id === key || r.key === key || (key && r.key.indexOf(key) === 0));
    if (!row || row.tBench == null) return [];
    const env = A._env, P = env.P.get(idx), def = DEFS.find((x) => x.id === row.id);
    const f = factors(def, F().techOf(row.key), null);
    const resIdx = RES.map((r, i) => i).filter((i) => def.kind === "trip" || f[RES[i]] !== 1);
    const hi = row.tActual != null ? row.tActual : env.end;
    const out = [];
    if (hi > row.tBench) integrate(P, P.rates, def.id, f, resIdx, row.tBench, hi, out);
    else out.push([row.tBench, 0]);
    if (hi < env.end) out.push([env.end, out[out.length - 1][1]]);
    return out;
  };
})();
