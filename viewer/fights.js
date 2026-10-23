"use strict";
// fights.js: pure fight analysis shared by the 2D and 3D viewers' Fights tab. No DOM; runs in a bare node vm after
// units.js, stats.js and frame.js (RV_FRAME). Everything is derived from the combat index C (RV_FRAME.combat) and the
// replay data d (d.fights, d.terrain, d.gaia, d.jobs); nothing is read from the viewers.
//
// RV_FIGHTS.analyze(d, C, fight) → analysis, cached per fight object (fight: an index into d.fights or the fight object).
// RV_FIGHTS.list(d, C)           → one summary row per fight for the tab's list (calls analyze, so the first call analyses every fight):
//   { index, id, t0, t1, duration, x, z, radius, teams, ratings: { team: { score, letter } }, winner ("A"|"B"|null), winnerTeam,
//     p, predicted, correct, deaths, damage, lost: { team: resources lost }, impact, tags: [tag name] }.
//   lost[team] = army + villagers + buildings value lost by that side in d.fights[i].losses (players summed per team).
//   impact (resources) = Σ lost over both sides + economic idle damage + army swing, where economic idle damage =
//   Σ forcedIdle (villager-seconds, see Eco) × ECO_RATE (0.6 resources per villager-second) and army swing =
//   |lost[A] − Σ lost[other teams]|. Bigger means a more decisive fight; use it to rank fights.
//
// Vocabulary. A "side" is a team (d.players[].team); in 1v1 that is the player. out.teams = [A, B, …] sorted by team
// number (A = lowest). Per-side results are objects keyed by team number. The fight window is [t0, t1] = [start, end]
// of d.fights[i] and its area is the disc of radius R = 1.5 × fight.radius around (x, z) (the same reach convert.py
// uses to collect the fight's units, and RV_FRAME.telemetry uses for its fight zones). Distances are metres (world units).
//
// analysis = {
//   id, index, t0, t1, x, z, radius, area, teams, sides: [{ team, players, names, civs, colors, army }],
//   rating:     { team: { score (0–100), letter, components: { priority, overkill, uptime, splash }, weights, n } }
//   lanchester: { A, B, p (side A wins), predicted, actual, correct, strength, expected }
//   tug:        { series: [[t, killedValueA − killedValueB]], cum: { team: [[t, v]] }, events, final }
//   whatIf(opts): see below
//   idle:       { team: { idle: [...], late: [...], idleValue, lateValue, idleShare, lateShare } }
//   tags:       [{ tag, side, bonusDamage, damage, share, note, … }]   (tag: Under TC/Keep Fire | Chokepoint | Surround/Flank | Raid / Eco Hit)
//   lost:       { total: { team: resources }, parts: { team: { army, vill, bldg } } }; impact, ecoDamage (resources): see list()
//   heat:       { lines: [{ a, b, team, victimTeam, eff, grade, damage, n, ax, az, bx, bz, t0, t1 }], bySide }
//   eco:        { team: { militaryLost, villagerLost, ecoBuildingLost, otherBuildingLost, villagersPulled, …, forcedIdle } }
// }
//
// ── Micro Rating (0–100, per side) ──
// A weighted mean of four components, each 0–1 (letter: RV_FRAME.letter on score/100, S ≥ 90, A ≥ 75, B ≥ 60, C ≥ 45, else F):
//   priority 35 %  mean RV_FRAME.effAt efficiency over the side's unit-vs-enemy attack pairs inside the window and area
//                  (efficiency = Damage(A→B)·Cost(B)/CurHP(B) over the best such score within A's reach; 1 = optimal).
//   overkill 25 %  1 − wasted share, scaled: wasted = (a) the surplus at killing drops: the credited blows' expected damage
//                  Σx, divided by KAPPA[n] (mid-fight drops with n credited blows show Σx/drop of 1.19 / 1.38 / 1.47 for
//                  n = 2 / 3 / 4+, since not every credited blow lands), minus the HP the victim had left, summed per side
//                  and clamped at 0; plus (b) shots whose target died before the projectile landed (frame.js blow.miss
//                  with the target dead at landing). share = wasted / (dealt + wasted), typically 1 % (p90 32 % in small
//                  fights), so score = 1 − min(1, share / OVERKILL_CAP), OVERKILL_CAP = 0.20.
//   uptime   25 %  DPS uptime. Per armed unit: attack-flagged samples (C.per) × 0.5 s over its engaged time (from its first
//                  attack or damage taken in the window until it dies or the fight ends). Normalised by the uptime a
//                  continuously attacking unit shows: REF = 0.75 s / weapon period (a flagged pulse spans ~1.5 samples;
//                  measured in aoe4_245598603: p90 of ranged uptimes 0.34–0.56 against refs 0.35–0.46). Value × engaged
//                  time weighted. Ranged (non-siege) units only; a side with none uses all its armed units (basis: "all").
//   splash   15 %  siege/splash units (SPLASH, the frame.js set): share of their shots landing on ≥ 2 targets over SPLASH_REF
//                  (0.25, capped at 1; p90 of showcase sides is 0.18). A side with no such unit has no splash component
//                  and the other three weights are renormalised (no neutral 0.5).
// A side with no attack pair, no engaged unit and no splash has rating null.
//
// ── Lanchester square law ──
// At t0 each side's armed units (cat infantry/cavalry/ranged/siege) alive within 2 × fight.radius of the centre are
// grouped by their RV_FRAME.statsAt record. dps(g→h) = best non-fire weapon of g vs h: max(1, attack + bonus-vs-class −
// armour) × burst / (period); against the other side's count-weighted mix. P_X = (Σ dps_X) · (Σ HP_X), HP the current HP at t0.
// Buildings that shot in the window add their dps (no HP: nobody trades units for them in this model). The square law
// says X wins iff P_X > P_Y; the winner keeps sqrt(1 − P_loser/P_winner) of its army, the loser all of it (fight to the
// death). p = 1 / (1 + exp(−ln(P_A/P_B) / TAU)) clamped to [0.01, 0.99]; TAU = 1.5 is a calibration, not theory: the Brier
// score over the 39 decided fights of aoe4_245598603 is lowest for TAU 1.5–2 (0.198 vs 0.250 for coin flips; 28 of 39
// winners called). Since P grows with army size squared, a 2:1 army (4:1 P) gives p ≈ 0.72. Actual outcome: the side
// losing less army+villager value in d.fights[i].losses (null when
// within 10 %, a draw). Teams beyond the first two: A is the lowest team, B all others combined.
//
// ── whatIf({ side, armor, attack }) ──
// side: "A" | "B" | team number. armor: +n melee AND ranged armour on every unit of that side; attack: +n damage on every
// weapon. Returns the recomputed Lanchester p, delta p vs the base, and the expected losses.
//
// ── Positional tags (the `tag` string is the name the UI shows; bonusDamage is the damage the position applied to, `damage` the damage in play) ──
//   Chokepoint        narrowest free cross-section of the engagement (perpendicular to the axis between the two sides'
//                     centroids, sampled every 4 m within ±20 m along it): obstacles are live buildings (not farms), trees
//                     and deposits in d.gaia, terrain steeper than CLIFF; a cross-section counts only when obstacles close
//                     it on both sides within the area, CHOKE_MIN (3) ≤ width ≤ CHOKE_W (16 m). bonusDamage = the damage the
//                     side dealing most of it inflicted on victims within CHOKE_ZONE (8 m) along / width + 6 m across that
//                     cross-section; tagged when that is ≥ 30 % of the fight's damage.
//   Surround/Flank    attackers on one victim inside a FLANK_BUCKET (2 s) bucket of attack pairs; groups of ≥ 3 unit attackers
//                     are tested: attackers outside the densest FRONT (90°) arc around the victim are flankers and
//                     bonusDamage = the victim's damage in the bucket × flanker share, summed per side; tagged from
//                     FLANK_SHARE (12 % of the side's damage: ≈ the top tenth of the showcase's sides, max 29 %). A victim
//                     attacked over ≥ 270° of bearing by ≥ 4 attackers counts as surrounded (`surrounded` counts those).
//   Under TC/Keep Fire damage dealt by buildings (towers, keeps, TCs: attackers with cat building) = bonusDamage = damage.
//   Raid / Eco Hit   credited to the attacking side (the other side that dealt most damage) when the victim side's losses in the
//                     fight area (eco: villagers + eco/trade buildings, ECO_BLD) are ≥ RAID_MIN (150 resources) AND more than
//                     RAID_SHARE (50 %) of everything that side lost there (army + villagers + all buildings), and exceed the
//                     attacker's own economic losses. bonusDamage = the attacker's damage on villagers and eco buildings;
//                     also ecoLost and ecoShare.
//
// ── Idle army and late reinforcements ──
// Army units (infantry/cavalry/ranged/siege) of a side that were inside the area, alive, moved < IDLE_MOVE (4 m) over the
// trailing IDLE_WIN (15 s) and did not attack in it, checked every IDLE_STEP (2.5 s) from t0 to t1; idle seconds = checks
// × step, reported from IDLE_MIN (5 s). Late: first time inside the area after t0 + LATE_AFTER (20 s) and before t1.
//
// ── Eco ──
// Per side: value of units lost in the area by class (military = anything not villager/building), villagers lost, eco
// buildings (bp econ|farm|mill|camp|market|trade|dock) vs other buildings lost; villagers pulled = villagers with
// attack samples in the window (and the damage they dealt); forced idle = villager-seconds below the t0 gatherer count
// (d.jobs food+wood+gold+stone, player-wide, from t0 to t1 + FLEE s) after removing villagers that died and the count's own
// wobble (std dev over the 60 s before t0, gatherersNoise), counted only when a villager of that side was hit or killed in
// the area during the fight. d.jobs is not per area, so this also catches villagers pulled away elsewhere.
// Tug/eco/overlap: deaths are counted in the window inside the area, so two fights that overlap in time and place share some.
(function () {
  const R = {};
  window.RV_FIGHTS = R;

  const F = () => window.RV_FRAME;
  const SAMPLE = 0.5;
  const AREA = 1.5;                 // × fight.radius
  const STRENGTH_R = 2;             // × fight.radius, units counted in the Lanchester strength
  const W = { priority: 0.35, overkill: 0.25, uptime: 0.25, splash: 0.15 };
  const OVERKILL_CAP = 0.2;
  // Σ expected blow damage / recorded HP drop over mid-fight drops with n credited blows in aoe4_245598603 (n = 1…4+); the
  // kill drop's surplus over this baseline is overkill
  const KAPPA = [1, 1, 1.19, 1.38, 1.47];
  const UPTIME_FLAG_S = 0.75;
  const TAU = 1.5;
  const SPLASH = /mangonel|nest_of_bees|ribauldequin|trebuchet/;
  const RAID_MIN = 150, RAID_SHARE = 0.5; // Raid / Eco Hit: economic losses ≥ 150 resources and over half of the side's losses
  const ECO_RATE = 0.6;             // resources a gathering villager brings in per second (the AoE4 gather rates span ≈ 0.5–0.8); prices forced idle time
  const CHOKE_MIN = 3, CHOKE_W = 16, CHOKE_ZONE = 8, CHOKE_SHARE = 0.3, CLIFF = 0.9;
  const FRONT = 90, FLANK_SHARE = 0.12, SURROUND = 270, FLANK_BUCKET = 2;
  const SPLASH_REF = 0.25;          // share of shots on ≥ 2 targets that scores 1 (p90 of the showcase's sides is 0.18)
  const IDLE_MOVE = 4, IDLE_WIN = 15, IDLE_STEP = 2.5, IDLE_MIN = 5, LATE_AFTER = 20;
  const FLEE = 20;
  const HEAT_MAX = 250;
  const ARMED = new Set(["infantry", "cavalry", "ranged", "siege"]);
  const SKIP_CAT = new Set(["livestock", "attachment", "other"]);
  const WP_TYPE = { melee: "melee", pierce: "ranged", siege: "siege", fire: "fire" };
  const ARMOR_OF = { melee: "melee", ranged: "ranged", fire: "fire" };
  const ECO_BLD = /econ|farm|mill|camp|market|trade|dock|pasture|resource/;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const fin = (v, d) => (Number.isFinite(v) ? v : d === undefined ? 0 : d);
  const isBld = (e) => e.cat === "building";
  const hasClasses = (cls, groups) => groups.some((g) => g.every((c) => cls.includes(c)));
  const valueOf = (e) => {
    if (e.value > 0) return e.value;
    const st = F().statOf(e.bp), c = st && st.cost;
    return c ? (c.f || 0) + (c.w || 0) + (c.g || 0) + (c.s || 0) : 0;
  };
  function lowerBound(arr, t) { // first index with arr[i] >= t
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < t) lo = m + 1; else hi = m; }
    return lo;
  }
  function pos(e, t) { const L = F().locate(e, t); return { x: L.x, z: L.z, hp: L.hp }; }

  // ── damage model (mirrors frame.js hitDamage, with explicit attack / armour offsets for whatIf) ──
  function bonusOf(w, tst) {
    if (!w.mods) return 0;
    let b = 0;
    for (const m of w.mods) {
      if (m.e !== "change") continue;
      if ((m.id && m.id.includes(tst.b)) || (m.c && tst.cls && hasClasses(tst.cls, m.c))) b += m.v;
    }
    return b;
  }
  /** Damage of one hit of weapon w of unit stats sa on unit stats sb (attack + bonus − armour, at least 1). */
  function hit(sa, w, sb, atkAdd, armAdd) {
    const tst = sb.st;
    let atk = (sa.atk[w.ty] != null ? sa.atk[w.ty] : w.dmg) + (atkAdd || 0) + bonusOf(w, tst);
    if (tst.cls) for (const b of sa.vs) if (b.ty === w.ty && hasClasses(tst.cls, b.c)) atk += b.v;
    const at = ARMOR_OF[w.ty];
    return Math.max(1, atk - (at ? sb.arm[at] + (armAdd || 0) : 0));
  }
  const fwCache = new WeakMap(); // stats record → its non-fire weapons (the shared RV_STATS records stay untouched)
  function weaponsOf(sa) {
    let l = fwCache.get(sa.st);
    if (!l) fwCache.set(sa.st, (l = (sa.st.wp || []).filter((w) => w.ty !== "fire")));
    return l;
  }
  /** Best sustained dps of sa against sb (burst × hit / period; the main weapon's upgraded period scales all). */
  function dps(sa, sb, atkAdd, armAdd) {
    const ws = weaponsOf(sa);
    if (!ws.length) return 0;
    const mainPer = ws[0].per, scale = mainPer && sa.period ? sa.period / mainPer : 1;
    let best = 0;
    for (const w of ws) { if (!w.per) continue; const v = (hit(sa, w, sb, atkAdd, armAdd) * (w.burst || 1)) / (w.per * scale); if (v > best) best = v; }
    return best;
  }
  /** Expected damage of one blow of blow.dtype by attacker stats sa on stats sb (frame.js weaponOf). */
  function blowDamage(sa, dtype, sb) {
    const wp = sa.st.wp || [];
    if (!wp.length) return 1;
    const ty = WP_TYPE[dtype], w = wp.find((x) => x.ty === ty) || wp[0];
    return hit(sa, w, sb, 0, 0);
  }

  // ── per-C caches (derived once from the combat index) ──
  const cCache = new WeakMap();
  function cInfo(C) {
    let I = cCache.get(C);
    if (I) return I;
    I = { army: C.ents.filter((e) => ARMED.has(e.cat)), perT: new Map(), deaths: [], deadShots: [] };
    for (const e of C.ents) if (e.died != null && !SKIP_CAT.has(e.cat) && !e.defeated) I.deaths.push(e);
    I.deaths.sort((a, b) => a.died - b.died);
    I.deathT = Float64Array.from(I.deaths, (e) => e.died);
    for (const mine of C.lists.values()) {
      for (const bl of mine) if (bl.shot && bl.miss && !bl.guess && bl.b.died != null && bl.b.died <= bl.t1 + 0.05 && bl.t0 - bl.b.died < 3) I.deadShots.push(bl);
    }
    I.deadShots.sort((a, b) => a.t0 - b.t0);
    I.deadShotT = Float64Array.from(I.deadShots, (b) => b.t0);
    cCache.set(C, I);
    return I;
  }
  /** Attack-flag times of unit id (Float64Array) from C.per. */
  function attackTimes(C, id) {
    const I = cInfo(C);
    let a = I.perT.get(id);
    if (!a) {
      const l = C.per.get(id) || [];
      a = new Float64Array(l.length >> 1);
      for (let k = 0; k < a.length; k++) a[k] = l[2 * k];
      I.perT.set(id, a);
    }
    return a;
  }

  // ── terrain / obstacles ──
  function heightAt(T, x, z) {
    const fx = Math.min(T.cols - 1, Math.max(0, (x - T.x0) / T.step)), fz = Math.min(T.rows - 1, Math.max(0, (z - T.z0) / T.step));
    const c = Math.min(T.cols - 2, Math.floor(fx)), r = Math.min(T.rows - 2, Math.floor(fz)), ax = fx - c, az = fz - r;
    const h = T.h, i = r * T.cols + c;
    return (h[i] * (1 - ax) + h[i + 1] * ax) * (1 - az) + (h[i + T.cols] * (1 - ax) + h[i + T.cols + 1] * ax) * az;
  }
  const gaiaCache = new WeakMap();
  function gaiaObstacles(d) {
    let g = gaiaCache.get(d);
    if (g) return g;
    g = [];
    const G = d.gaia;
    if (G && G.ents && G.types) {
      for (const r of G.ents) {
        const kind = (G.types[r[1]] || [])[1], rad = kind === "tree" ? 1 : kind === "gold" || kind === "stone" ? 3 : 0;
        if (rad) g.push({ x: r[2], z: r[3], r: rad, from: r[5] && r[5][0] != null ? r[5][0] : 0, to: r[5] && r[5][1] != null ? r[5][1] : Infinity, amt: r[6] });
      }
    }
    gaiaCache.set(d, g);
    return g;
  }
  function gaiaLive(o, t) {
    if (o.from > t || o.to <= t) return false;
    if (Array.isArray(o.amt)) { let a = null; for (let k = 0; k + 1 < o.amt.length && o.amt[k] <= t; k += 2) a = o.amt[k + 1]; if (a === 0) return false; }
    return true;
  }

  // ── building the analysis ──
  const cache = new WeakMap();
  R.analyze = function (d, C, fight) {
    const fo = typeof fight === "number" ? d.fights[fight] : fight;
    if (!fo) return null;
    const hit0 = cache.get(fo);
    if (hit0 && hit0.C === C) return hit0.out;
    const out = build(d, C, fo, d.fights.indexOf(fo));
    cache.set(fo, { C, out });
    return out;
  };

  function build(d, C, f, index) {
    const Fr = F(), I = cInfo(C), byId = C.byId;
    const t0 = f.start, t1 = f.end, cx = f.x, cz = f.z, area = f.radius * AREA;
    const inArea = (x, z, r) => Math.hypot(x - cx, z - cz) <= (r || area);

    // sides
    const teamOfPlayer = (idx) => (C.players.get(idx) || {}).team;
    // participants lists the owners of damage events; a side that only soaked (or was out of the events) shows in f.units
    const tset = new Set((f.participants || []).map(teamOfPlayer).filter((t) => t != null));
    for (const id of f.units || []) { const e = byId.get(id), tm = e ? C.teamOf(e, (t0 + t1) / 2) : null; if (tm != null) tset.add(tm); }
    const teams = [...tset].sort((a, b) => a - b);
    const tA = teams[0], tB = teams[1];
    const sides = teams.map((tm) => {
      const ps = d.players.filter((p) => p.team === tm);
      return { team: tm, players: ps.map((p) => p.idx), names: ps.map((p) => p.name), civs: ps.map((p) => p.civ), colors: ps.map((p) => p.color), army: 0 };
    });
    const sideOf = (e, t) => C.teamOf(e, t);
    const perTeam = (init) => { const o = {}; for (const tm of teams) o[tm] = init(); return o; };

    // attack pairs of the window (units' target priority, heat)
    const pairs = [];
    for (let i = lowerBound(C.atkT, t0); i < C.atkT.length && C.atkT[i] <= t1; i++) {
      const t = C.atkT[i], p = C.atkP[i];
      let g = null;
      for (let k = 0; k + 1 < p.length; k += 2) {
        const a = byId.get(p[k]), b = byId.get(p[k + 1]);
        if (!a || !b) continue;
        const at = sideOf(a, t), bt = sideOf(b, t);
        if (at == null || bt == null || at === bt) continue;
        const lb = pos(b, t);
        if (!inArea(lb.x, lb.z)) continue;
        const la = pos(a, t);
        if (!g) g = Fr.effAt(C, i);
        const eff = g[k >> 1];
        pairs.push({ t, a, b, at, bt, ax: la.x, az: la.z, bx: lb.x, bz: lb.z, eff: eff === eff ? eff : null });
      }
    }

    // damage events of the window with their attackers' shares
    const events = [], evAt = new Map(), dealt = perTeam(() => 0), dealtBy = new Map();
    const flagged = (v, drop) => {
      const who = [];
      for (let i = Fr.idxAt(C.atkT, drop); i >= 0 && C.atkT[i] > drop - 1; i--) {
        const p = C.atkP[i];
        for (let j = 1; j < p.length; j += 2) if (p[j] === v.id && !who.includes(p[j - 1])) who.push(p[j - 1]);
      }
      return who.map((id) => byId.get(id)).filter(Boolean);
    };
    for (let k = lowerBound(C.dmgT, t0); k < C.dmgT.length && C.dmgT[k] <= t1 + SAMPLE; k++) {
      const v = byId.get(C.dmgId[k]);
      if (!v) continue;
      const t = C.dmgT[k], vt = sideOf(v, t);
      if (vt == null) continue;
      const lv = pos(v, t);
      if (!inArea(lv.x, lv.z)) continue;
      const blows = C.dmgSrc[k];
      const atkers = blows ? blows.map((bl) => ({ a: bl.a, dtype: bl.dtype })) : flagged(v, C.dmgDrop[k]).map((a) => ({ a, dtype: "melee" }));
      const sv = Fr.statsAt(C, v, t);
      const sh = [];
      let tot = 0;
      for (const r of atkers) {
        const at = sideOf(r.a, t);
        if (at == null || at === vt) continue;
        const sa = Fr.statsAt(C, r.a, t), x = sa && sv ? blowDamage(sa, r.dtype, sv) : 1;
        sh.push({ a: r.a, team: at, x, f: 0 });
        tot += x;
      }
      if (!sh.length) continue;
      for (const s of sh) s.f = s.x / tot;
      const ev = { k, t, amt: C.dmgAmt[k], v, vt, vx: lv.x, vz: lv.z, sh };
      events.push(ev);
      evAt.set(k, ev);
      for (const s of sh) {
        dealt[s.team] = (dealt[s.team] || 0) + ev.amt * s.f;
        dealtBy.set(s.a.id, (dealtBy.get(s.a.id) || 0) + ev.amt * s.f);
      }
    }

    let flankStats = null;
    const rating = ratings();
    const lanch = lanchester();
    const ecoR = eco();
    // resources lost per side (d.fights[i].losses, the same accounting as the actual winner, plus buildings) and the fight's impact
    const lost = { total: perTeam(() => 0), parts: perTeam(() => ({ army: 0, vill: 0, bldg: 0 })) };
    for (const [pi, l] of Object.entries(f.losses || {})) {
      const tm = teamOfPlayer(+pi);
      if (tm == null || !lost.parts[tm]) continue;
      const p = lost.parts[tm];
      p.army += l.army || 0; p.vill += l.vill || 0; p.bldg += l.bldg || 0;
    }
    for (const tm of teams) { const p = lost.parts[tm]; lost.total[tm] = p.army + p.vill + p.bldg; }
    const ecoDamage = teams.reduce((s, tm) => s + ecoR[tm].forcedIdle * ECO_RATE, 0);
    const rest = teams.slice(1).reduce((s, tm) => s + lost.total[tm], 0);
    const impact = teams.reduce((s, tm) => s + lost.total[tm], 0) + ecoDamage + Math.abs((lost.total[tA] || 0) - rest);
    const out = {
      id: f.id, index, t0, t1, x: cx, z: cz, radius: f.radius, area, teams, sides, A: tA, B: tB,
      rating, lanchester: lanch.result, whatIf: lanch.whatIf,
      tug: tug(), idle: idleScan(), tags: tags(ecoR), heat: heat(), eco: ecoR, lost, impact, ecoDamage,
    };
    out.flank = flankStats;
    for (const s of sides) { s.army = fin(lanch.result.strength[s.team] && lanch.result.strength[s.team].value); }
    return out;

    // ── Micro Rating ──
    function ratings() {
      const res = {};
      // priority
      const prio = perTeam(() => ({ sum: 0, n: 0 }));
      for (const p of pairs) if (p.eff !== null && !isBld(p.a) && prio[p.at]) { prio[p.at].sum += p.eff; prio[p.at].n++; }
      // overkill
      const waste = perTeam(() => 0), wasteN = perTeam(() => ({ final: 0, shots: 0 }));
      for (let i = lowerBound(I.deathT, t0); i < I.deaths.length && I.deathT[i] <= t1 + SAMPLE; i++) {
        const v = I.deaths[i], dl = C.dmgOf.get(v.id);
        if (!dl) continue;
        let k = -1;
        for (let j = dl.length - 1; j >= 0; j--) if (C.dmgT[dl[j]] <= v.died + 0.6) { k = dl[j]; break; }
        const ev = evAt.get(k);
        if (!ev || ev.sh.length < 2) continue;
        let tx = 0;
        for (const s of ev.sh) tx += s.x;
        // expected damage of n credited blows runs above the recorded drop in mid-fight too (not every blow lands): scaled by
        // the measured mid-fight ratio so only the surplus at the killing drop counts; summed per side, then clamped at 0
        const net = tx / KAPPA[Math.min(ev.sh.length, KAPPA.length - 1)] - ev.amt;
        for (const s of ev.sh) wasteN[s.team].final += net * s.f;
      }
      for (const tm of teams) { wasteN[tm].final = Math.max(0, wasteN[tm].final); waste[tm] += wasteN[tm].final; }
      for (let i = lowerBound(I.deadShotT, t0); i < I.deadShots.length && I.deadShotT[i] <= t1; i++) {
        const bl = I.deadShots[i], t = bl.t0, at = sideOf(bl.a, t), bt = sideOf(bl.b, Math.min(t, bl.b.died - 0.01));
        if (at == null || bt == null || at === bt || !waste.hasOwnProperty(at)) continue;
        const lb = pos(bl.b, Math.min(t, bl.b.died - 0.01));
        if (!inArea(lb.x, lb.z)) continue;
        const sa = Fr.statsAt(C, bl.a, t), sb = Fr.statsAt(C, bl.b, t);
        const x = sa && sb ? blowDamage(sa, bl.dtype, sb) : 1;
        waste[at] += x; wasteN[at].shots += x;
      }
      // uptime
      const up = perTeam(() => ({ ranged: { s: 0, w: 0 }, all: { s: 0, w: 0 } }));
      for (const e of I.army) {
        if (!e.spans.length || e.spans[0] > t1 || e.spans[e.spans.length - 1] < t0) continue;
        const times = attackTimes(C, e.id);
        const lo = lowerBound(times, t0), hi = lowerBound(times, t1 + 1e-9);
        if (hi <= lo) continue;
        const dl = C.dmgOf.get(e.id);
        let e0 = times[lo];
        if (dl) for (const k of dl) if (C.dmgT[k] >= t0) { e0 = Math.min(e0, C.dmgT[k]); break; }
        const e1 = Math.min(t1, e.died != null ? e.died : t1), dur = e1 - e0;
        if (dur < 3) continue;
        const tm = sideOf(e, e0);
        if (tm == null || !up[tm]) continue;
        const sa = Fr.statsAt(C, e, e0);
        if (!sa || !sa.period) continue;
        const u = Math.min(1, ((hi - lo) * SAMPLE) / dur / clamp(UPTIME_FLAG_S / sa.period, 0.05, 1)), wgt = Math.max(1, valueOf(e)) * dur;
        const mainW = weaponsOf(sa)[0];
        up[tm].all.s += u * wgt; up[tm].all.w += wgt;
        if (mainW && mainW.ty === "ranged") { up[tm].ranged.s += u * wgt; up[tm].ranged.w += wgt; }
      }
      // splash
      const spl = perTeam(() => ({ shots: 0, multi: 0, targets: 0 }));
      for (const [id, mine] of C.lists) {
        const a = byId.get(id);
        if (!a || !SPLASH.test(a.bp)) continue;
        for (const bl of mine) {
          if (bl.t0 < t0 || bl.t0 > t1 || bl.guess) continue;
          const at = sideOf(a, bl.t0);
          if (at == null || !spl[at]) continue;
          const n = bl.miss ? 0 : 1 + (bl.splash ? bl.splash.victims.length : 0);
          spl[at].shots++; spl[at].targets += n; if (n >= 2) spl[at].multi++;
        }
      }
      for (const tm of teams) {
        const comp = { priority: null, overkill: null, uptime: null, splash: null };
        const pr = prio[tm];
        if (pr.n) comp.priority = pr.sum / pr.n;
        const dl = dealt[tm] || 0;
        const wasted = waste[tm];
        if (dl + wasted > 0) comp.overkill = 1 - Math.min(1, wasted / (dl + wasted) / OVERKILL_CAP);
        const u = up[tm], basis = u.ranged.w > 0 ? "ranged" : "all", ub = u[basis];
        if (ub.w > 0) comp.uptime = ub.s / ub.w;
        const sp = spl[tm];
        if (sp.shots > 0) comp.splash = Math.min(1, sp.multi / sp.shots / SPLASH_REF);
        let sw = 0, sc = 0;
        for (const key of Object.keys(W)) if (comp[key] !== null) { sw += W[key]; sc += W[key] * clamp(comp[key], 0, 1); }
        const score = sw > 0 ? (100 * sc) / sw : null;
        res[tm] = {
          score, letter: score === null ? null : Fr.letter(score / 100), components: comp, weights: W,
          n: { pairs: pr.n, dealt: dl, wasted, wasteFinal: wasteN[tm].final, wasteShots: wasteN[tm].shots, uptimeBasis: ub.w > 0 ? basis : null, splashShots: sp.shots, splashMulti: sp.multi, splashTargets: sp.targets },
        };
      }
      return res;
    }

    // ── Lanchester ──
    function lanchester() {
      const groups = new Map(); // sa → { sa, team, n, hp, value, building }
      const add = (e, t, building) => {
        const sa = Fr.statsAt(C, e, t);
        if (!sa || !weaponsOf(sa).length) return;
        const tm = sideOf(e, t);
        if (tm == null || !teams.includes(tm)) return;
        const key = building ? sa.bp + "|b" + tm : sa;
        let g = groups.get(key);
        if (!g) groups.set(key, (g = { sa, team: tm, n: 0, hp: 0, value: 0, building }));
        g.n++; if (!building) { g.hp += pos(e, t).hp; g.value += valueOf(e); }
      };
      const sr = f.radius * STRENGTH_R, inFight = new Set(f.units || []);
      for (const e of I.army) {
        if (!Fr.alive(e, t0)) continue;
        const L = pos(e, t0);
        // en route counts too: a unit alive at t0 that the fight's attack pairs later name is committed to it
        if (inFight.has(e.id) || Math.hypot(L.x - cx, L.z - cz) <= sr) add(e, t0, false);
      }
      const shooters = new Set();
      for (const ev of events) for (const s of ev.sh) if (isBld(s.a) || s.a.cat === "attachment") shooters.add(s.a);
      for (const b of shooters) if (isBld(b) && Fr.alive(b, t0)) add(b, t0, true);
      const list = [...groups.values()];
      const isA = (g) => g.team === tA;
      const GA = list.filter(isA), GB = list.filter((g) => !isA(g));
      const unitsOf = (G) => G.filter((g) => !g.building);
      const sum = (G, fn) => G.reduce((s, g) => s + fn(g), 0);
      const baseStrength = () => ({
        A: { n: sum(unitsOf(GA), (g) => g.n), hp: sum(unitsOf(GA), (g) => g.hp), value: sum(unitsOf(GA), (g) => g.value) },
        B: { n: sum(unitsOf(GB), (g) => g.n), hp: sum(unitsOf(GB), (g) => g.hp), value: sum(unitsOf(GB), (g) => g.value) },
      });
      const power = (mod) => {
        const side = (G, H, atkAdd, armAdd, hArm) => {
          const nH = sum(unitsOf(H), (h) => h.n), hp = sum(unitsOf(G), (g) => g.hp);
          let dp = 0;
          if (nH) for (const g of G) { let m = 0; for (const h of unitsOf(H)) m += h.n * dps(g.sa, h.sa, atkAdd, hArm); dp += (g.n * m) / nH; }
          return { dps: dp, hp, P: dp * hp };
        };
        return { A: side(GA, GB, mod.attackA, mod.armorA, mod.armorB), B: side(GB, GA, mod.attackB, mod.armorB, mod.armorA) };
      };
      const outcome = (mod) => {
        const pw = power(mod), a = pw.A.P, b = pw.B.P, st = baseStrength();
        let p = 0.5, ratio = null;
        if (a > 0 && b > 0) { ratio = a / b; p = 1 / (1 + Math.exp(-Math.log(ratio) / TAU)); }
        else if (a > 0) p = 0.99; else if (b > 0) p = 0.01;
        p = clamp(p, 0.01, 0.99);
        // square law survivors: winner keeps sqrt(1 − P_loser/P_winner), loser none
        const lostFrac = (own, other) => (own > other ? 1 - Math.sqrt(Math.max(0, 1 - other / own)) : 1);
        const lf = { A: a + b > 0 ? lostFrac(a, b) : 0, B: a + b > 0 ? lostFrac(b, a) : 0 };
        return { p, ratio, power: pw, expected: { A: { lostFrac: lf.A, lostValue: lf.A * st.A.value }, B: { lostFrac: lf.B, lostValue: lf.B * st.B.value } } };
      };
      const none = { attackA: 0, attackB: 0, armorA: 0, armorB: 0 };
      const base = outcome(none), st = baseStrength();
      // actual winner: less army + villager value lost (d.fights[i].losses is keyed by player)
      const lost = perTeam(() => 0);
      for (const [pi, l] of Object.entries(f.losses || {})) {
        const tm = teamOfPlayer(+pi);
        if (tm != null && lost[tm] !== undefined) lost[tm] += (l.army || 0) + (l.vill || 0);
      }
      const la = lost[tA] || 0, lb = teams.slice(1).reduce((s, tm) => s + lost[tm], 0), mx = Math.max(la, lb);
      const actual = mx === 0 || Math.abs(la - lb) < 0.1 * mx ? null : la < lb ? "A" : "B";
      const predicted = base.power.A.P > 0 || base.power.B.P > 0 ? (base.p > 0.5 ? "A" : "B") : null;
      const toSide = (s) => (s === "A" || s === "B" ? s : teams.length > 2 ? (s === tA ? "A" : "B") : s === tA ? "A" : s === tB ? "B" : null);
      const result = {
        A: tA, B: tB, p: base.p, ratio: base.ratio, predicted, actual, correct: actual === null || predicted === null ? null : actual === predicted,
        lost: { A: la, B: lb },
        strength: { [tA]: { ...st.A, dps: base.power.A.dps, power: base.power.A.P } },
        expected: base.expected, tau: TAU,
      };
      if (tB !== undefined) result.strength[tB] = { ...st.B, dps: base.power.B.dps, power: base.power.B.P };
      const whatIf = (opts) => {
        const o = opts || {}, s = toSide(o.side), arm = +o.armor || 0, atk = +o.attack || 0;
        if (!s) return null;
        const mod = { attackA: s === "A" ? atk : 0, attackB: s === "B" ? atk : 0, armorA: s === "A" ? arm : 0, armorB: s === "B" ? arm : 0 };
        const r = outcome(mod);
        return { side: s, team: s === "A" ? tA : tB, armor: arm, attack: atk, p: r.p, base: base.p, dp: r.p - base.p, ratio: r.ratio, expected: r.expected, baseExpected: base.expected };
      };
      return { result, whatIf };
    }

    // ── tug of war ──
    function tug() {
      const evs = [], cum = perTeam(() => [[t0, 0]]), tot = perTeam(() => 0);
      for (let i = lowerBound(I.deathT, t0); i < I.deaths.length && I.deathT[i] <= t1; i++) {
        const v = I.deaths[i], td = v.died - 0.01, lv = pos(v, td);
        if (!inArea(lv.x, lv.z)) continue;
        const vt = sideOf(v, td);
        if (vt == null || !teams.includes(vt)) continue;
        const k = v.killer != null ? byId.get(v.killer) : null;
        let by = k ? sideOf(k, td) : null;
        if (by == null || by === vt || !teams.includes(by)) by = teams.length === 2 ? teams.find((x) => x !== vt) : null;
        if (by == null) continue;
        const value = valueOf(v);
        tot[by] += value;
        cum[by].push([v.died, tot[by]]);
        evs.push({ t: v.died, id: v.id, bp: v.bp, value, victimTeam: vt, by, x: lv.x, z: lv.z });
      }
      const diff = () => tot[tA] - teams.slice(1).reduce((s, x) => s + tot[x], 0);
      const series = [[t0, 0]];
      const run = perTeam(() => 0);
      for (const ev of evs) { run[ev.by] += ev.value; series.push([ev.t, run[tA] - teams.slice(1).reduce((s, x) => s + run[x], 0)]); }
      series.push([t1, diff()]);
      for (const tm of teams) cum[tm].push([t1, tot[tm]]);
      return { series, cum, events: evs, final: { ...tot, diff: diff() } };
    }

    // ── idle army / late reinforcements ──
    function idleScan() {
      const res = perTeam(() => ({ idle: [], late: [], idleValue: 0, lateValue: 0, idleShare: 0, lateShare: 0, armyValue: 0 }));
      const steps = [];
      for (let s = t0; s <= t1 + 1e-9; s += IDLE_STEP) steps.push(s);
      const near = area + 30, mid = (t0 + t1) / 2;
      for (const e of I.army) {
        const life0 = e.spans[0], life1 = e.spans[e.spans.length - 1];
        if (life0 > t1 || life1 < t0) continue;
        const probe = [Math.max(t0, life0), clamp(mid, life0, life1), Math.min(t1, life1)];
        let close = false;
        for (const t of probe) { if (!Fr.alive(e, t)) continue; const L = pos(e, t); if (Math.hypot(L.x - cx, L.z - cz) <= near) { close = true; break; } }
        if (!close) continue;
        const times = attackTimes(C, e.id);
        let idleSecs = 0, since = null, firstIn = null, firstPos = null, any = false;
        for (const s of steps) {
          if (!Fr.alive(e, s)) continue;
          const L = pos(e, s), x = L.x, z = L.z;
          if (!inArea(x, z)) continue;
          any = true;
          if (firstIn === null) { firstIn = s; firstPos = { x, z }; }
          const back = s - IDLE_WIN;
          if (back < e.spans[0] || !Fr.alive(e, back)) continue;
          const q = pos(e, back);
          if (Math.hypot(q.x - x, q.z - z) >= IDLE_MOVE) continue;
          const j = lowerBound(times, back + 1e-9);
          if (j < times.length && times[j] <= s) continue; // attacked in the trailing window
          idleSecs += IDLE_STEP; if (since === null) since = s;
        }
        if (!any) continue;
        const tm = sideOf(e, firstIn);
        if (tm == null || !res[tm]) continue;
        const r = res[tm], value = valueOf(e);
        r.armyValue += value;
        if (idleSecs >= IDLE_MIN) {
          const L = pos(e, since);
          r.idle.push({ id: e.id, bp: e.bp, name: (Fr.statOf(e.bp) || {}).n || e.name || e.bp, idleSecs, since, value, x: L.x, z: L.z });
          r.idleValue += value;
        }
        if (firstIn > t0 + LATE_AFTER && firstIn <= t1) {
          r.late.push({ id: e.id, bp: e.bp, name: (Fr.statOf(e.bp) || {}).n || e.name || e.bp, arrive: firstIn, late: firstIn - t0, value, x: firstPos.x, z: firstPos.z, attacked: times.length > 0 && lowerBound(times, firstIn) < times.length && times[lowerBound(times, firstIn)] <= t1 });
          r.lateValue += value;
        }
      }
      for (const tm of teams) {
        const r = res[tm];
        r.idle.sort((a, b) => b.idleSecs * b.value - a.idleSecs * a.value);
        r.late.sort((a, b) => a.arrive - b.arrive);
        r.idleShare = r.armyValue ? r.idleValue / r.armyValue : 0;
        r.lateShare = r.armyValue ? r.lateValue / r.armyValue : 0;
      }
      return res;
    }

    // ── tags ──
    function tags(ecoR) {
      const res = [];
      const sideDealt = (tm) => dealt[tm] || 0;
      // Under TC/Keep fire
      const st = perTeam(() => ({ dmg: 0, ids: new Set() }));
      for (const ev of events) for (const s of ev.sh) if (isBld(s.a) || s.a.cat === "attachment") { const h = st[s.team]; if (h) { h.dmg += ev.amt * s.f; h.ids.add(s.a.id); } }
      for (const tm of teams) {
        const h = st[tm];
        if (h.dmg > 0) res.push({ tag: "Under TC/Keep Fire", side: tm, bonusDamage: h.dmg, damage: h.dmg, share: sideDealt(tm) ? h.dmg / sideDealt(tm) : 0, buildings: h.ids.size,
          note: `${Math.round(h.dmg)} damage from ${h.ids.size} building${h.ids.size === 1 ? "" : "s"} (towers, keeps, town centres)` });
      }
      // Flank / surround: attackers on one victim inside a FLANK_BUCKET s bucket (attack pairs); groups of ≥ 3 unit attackers
      // are tested for angular spread around the victim. flankers = attackers outside the densest FRONT° arc (by count);
      // the victim's damage in the bucket is split by attacker count (flanker share of it goes to the flankers' side).
      const fl = perTeam(() => ({ dmg: 0, groups: 0, surrounded: 0 }));
      const bucketDmg = new Map(), groups = new Map();
      const bk = (id, t) => id + "|" + Math.floor(t / FLANK_BUCKET);
      for (const ev of events) bucketDmg.set(bk(ev.v.id, ev.t), (bucketDmg.get(bk(ev.v.id, ev.t)) || 0) + ev.amt);
      for (const p of pairs) {
        if (isBld(p.a)) continue;
        const key = bk(p.b.id, p.t);
        let g = groups.get(key);
        if (!g) groups.set(key, (g = { bx: p.bx, bz: p.bz, att: new Map() }));
        g.bx = p.bx; g.bz = p.bz;
        g.att.set(p.a.id, { team: p.at, x: p.ax, z: p.az });
      }
      for (const [key, g] of groups) {
        if (g.att.size < 3) continue;
        const dmg = bucketDmg.get(key) || 0;
        const angs = [];
        for (const a of g.att.values()) angs.push({ a: (Math.atan2(a.z - g.bz, a.x - g.bx) * 180) / Math.PI, team: a.team });
        angs.sort((x, y) => x.a - y.a);
        const n = angs.length;
        let maxGap = 0;
        for (let i = 0; i < n; i++) maxGap = Math.max(maxGap, i + 1 < n ? angs[i + 1].a - angs[i].a : angs[0].a + 360 - angs[n - 1].a);
        let best = 0, bi = 0;
        const inFront = (j, i) => { let dd = angs[j].a - angs[i].a; if (dd < 0) dd += 360; return dd <= FRONT; };
        for (let i = 0; i < n; i++) { let c = 0; for (let j = 0; j < n; j++) if (inFront(j, i)) c++; if (c > best) { best = c; bi = i; } }
        for (let j = 0; j < n; j++) {
          const h = fl[angs[j].team];
          if (!h) continue;
          if (j === 0) h.groups++;
          if (!inFront(j, bi)) h.dmg += dmg / n;
        }
        if (n >= 4 && 360 - maxGap >= SURROUND) { const h = fl[angs[0].team]; if (h) h.surrounded++; }
      }
      for (const tm of teams) {
        const h = fl[tm], tot = sideDealt(tm);
        if (tot > 0 && h.dmg / tot >= FLANK_SHARE) res.push({ tag: "Surround/Flank", side: tm, bonusDamage: h.dmg, damage: tot, share: h.dmg / tot, surrounded: h.surrounded,
          note: `${Math.round(h.dmg)} damage (${Math.round((100 * h.dmg) / tot)} %) dealt by attackers outside the densest ${FRONT}° arc around the victim${h.surrounded ? `; ${h.surrounded} victim-window${h.surrounded === 1 ? "" : "s"} attacked over ≥ ${SURROUND}°` : ""}` });
      }
      flankStats = fl;
      // Chokepoint
      const ck = choke(events);
      if (ck) res.push(...ck);
      // Raid / eco hit: the victim side's losses are mostly economic (villagers + eco/trade buildings), credited to the attacker
      for (const vt of teams) {
        const v = ecoR[vt];
        if (!v) continue;
        const econ = v.villagerLost + v.ecoBuildingLost, total = econ + v.militaryLost + v.otherBuildingLost;
        let by = null;
        for (const tm of teams) if (tm !== vt && (by === null || sideDealt(tm) > sideDealt(by))) by = tm;
        if (by === null || econ < RAID_MIN || econ <= RAID_SHARE * total) continue;
        const mine = ecoR[by] ? ecoR[by].villagerLost + ecoR[by].ecoBuildingLost : 0;
        if (econ <= mine) continue;
        let dmg = 0;
        for (const ev of events) if (ev.vt === vt && (ev.v.cat === "villager" || (isBld(ev.v) && ECO_BLD.test(ev.v.bp)))) for (const s of ev.sh) if (s.team === by) dmg += ev.amt * s.f;
        res.push({ tag: "Raid / Eco Hit", side: by, bonusDamage: dmg, damage: sideDealt(by), share: sideDealt(by) ? dmg / sideDealt(by) : 0, ecoLost: econ, ecoShare: total ? econ / total : 0,
          note: `${Math.round(econ)} of the ${Math.round(total)} resources the other side lost (${Math.round((100 * econ) / total)} %) were villagers (${v.villagerDeaths}) and economy buildings` });
      }
      return res;
    }

    function choke(evs) {
      const cen = perTeam(() => ({ x: 0, z: 0, n: 0 }));
      for (const p of pairs) { const c = cen[p.at]; if (c) { c.x += p.ax; c.z += p.az; c.n++; } }
      if (tB === undefined) return null;
      const a = cen[tA], b = cen[tB];
      if (!a || !b || !a.n || !b.n) return null;
      let ux = b.x / b.n - a.x / a.n, uz = b.z / b.n - a.z / a.n;
      const len = Math.hypot(ux, uz);
      if (len < 1) return null;
      ux /= len; uz /= len;
      const px = -uz, pz = ux, range = area + 15;
      const obst = [];
      for (const e of C.ents) {
        if (!isBld(e) || e.spans.length === 0 || !Fr.alive(e, t0) || /farm|marker/.test(e.bp)) continue;
        const L = pos(e, t0);
        if (Math.hypot(L.x - cx, L.z - cz) <= range + 10) obst.push({ x: L.x, z: L.z, r: Fr.bodyR(e) });
      }
      for (const o of gaiaObstacles(d)) if (Math.hypot(o.x - cx, o.z - cz) <= range && gaiaLive(o, t0)) obst.push(o);
      const T = d.terrain;
      const free = (x, z) => {
        for (const o of obst) if (Math.hypot(o.x - x, o.z - z) < o.r + 0.5) return false;
        if (T && T.h) {
          const g = Math.hypot(heightAt(T, x + 2, z) - heightAt(T, x - 2, z), heightAt(T, x, z + 2) - heightAt(T, x, z - 2)) / Math.SQRT2;
          if (g > CLIFF) return false;
        }
        return true;
      };
      const S = area, STEP = 1.5;
      let minW = Infinity, minO = 0, minC = 0;
      for (let o = -20; o <= 20; o += 4) {
        const bx = cx + ux * o, bz = cz + uz * o;
        // free span through the free cell nearest the line centre
        let s0 = null;
        for (let s = 0; s <= S && s0 === null; s += STEP) { if (free(bx + px * s, bz + pz * s)) s0 = s; else if (free(bx - px * s, bz - pz * s)) s0 = -s; }
        if (s0 === null) continue;
        let lo = s0, hi = s0;
        while (hi < S && free(bx + px * (hi + STEP), bz + pz * (hi + STEP))) hi += STEP;
        while (lo > -S && free(bx + px * (lo - STEP), bz + pz * (lo - STEP))) lo -= STEP;
        if (hi >= S || lo <= -S) continue; // open on a side: not a pass between obstacles
        const w = hi - lo + STEP;
        if (w >= CHOKE_MIN && w < minW) { minW = w; minO = o; minC = (hi + lo) / 2; }
      }
      if (!(minW <= CHOKE_W)) return null;
      const zone = perTeam(() => 0);
      let zoneDmg = 0, total = 0;
      for (const ev of evs) {
        total += ev.amt;
        const ax = (ev.vx - cx) * ux + (ev.vz - cz) * uz, lat = (ev.vx - cx) * px + (ev.vz - cz) * pz;
        if (Math.abs(ax - minO) > CHOKE_ZONE || Math.abs(lat - minC) > minW / 2 + 3) continue;
        zoneDmg += ev.amt;
        for (const s of ev.sh) zone[s.team] += ev.amt * s.f;
      }
      if (!total || zoneDmg / total < CHOKE_SHARE) return null;
      let side = teams[0];
      for (const tm of teams) if (zone[tm] > zone[side]) side = tm;
      return [{ tag: "Chokepoint", side, bonusDamage: zone[side], damage: zoneDmg, share: zoneDmg / total, width: minW,
        note: `narrowest passable cross-section ${minW.toFixed(1)} m (${CHOKE_MIN}–${CHOKE_W} m, obstacles on both sides); ${Math.round(zone[side])} of ${Math.round(zoneDmg)} damage inside it (${CHOKE_ZONE} m along, ${(minW + 6).toFixed(0)} m across) was inflicted by this side` }];
    }

    // ── target-fire lines ──
    function heat() {
      const m = new Map();
      const line = (a, b, at, bt) => {
        const key = a.id + ">" + b.id;
        let l = m.get(key);
        if (!l) m.set(key, (l = { a: a.id, b: b.id, aBp: a.bp, bBp: b.bp, team: at, victimTeam: bt, damage: 0, n: 0, effSum: 0, effN: 0, ax: 0, az: 0, bx: 0, bz: 0, t0: Infinity, t1: -Infinity }));
        return l;
      };
      for (const p of pairs) {
        const l = line(p.a, p.b, p.at, p.bt);
        l.n++; l.ax += p.ax; l.az += p.az; l.bx += p.bx; l.bz += p.bz;
        if (p.t < l.t0) l.t0 = p.t; if (p.t > l.t1) l.t1 = p.t;
        if (p.eff !== null) { l.effSum += p.eff; l.effN++; }
      }
      for (const ev of events) {
        for (const s of ev.sh) {
          const l = m.get(s.a.id + ">" + ev.v.id) || (() => {
            const nl = line(s.a, ev.v, s.team, ev.vt);
            const la = pos(s.a, ev.t);
            nl.n = 0; nl.ax = la.x; nl.az = la.z; nl.bx = ev.vx; nl.bz = ev.vz; nl.t0 = nl.t1 = ev.t; nl.noPair = true;
            return nl;
          })();
          l.damage += ev.amt * s.f;
          if (ev.t < l.t0) l.t0 = ev.t; if (ev.t > l.t1) l.t1 = ev.t;
        }
      }
      const all = [...m.values()].map((l) => {
        const n = l.noPair ? 1 : l.n || 1, eff = l.effN ? l.effSum / l.effN : null;
        return { a: l.a, b: l.b, aBp: l.aBp, bBp: l.bBp, team: l.team, victimTeam: l.victimTeam, eff, grade: eff === null ? "ok" : Fr.gradeOf(eff), damage: l.damage, n: l.n,
          ax: l.ax / n, az: l.az / n, bx: l.bx / n, bz: l.bz / n, t0: l.t0, t1: l.t1 };
      }).filter((l) => l.damage > 0 || l.n >= 2);
      all.sort((x, y) => y.damage - x.damage || y.n - x.n);
      const bySide = perTeam(() => ({ good: 0, ok: 0, bad: 0, total: 0 }));
      for (const l of all) { const s = bySide[l.team]; if (s) { s[l.grade] += l.damage; s.total += l.damage; } }
      return { lines: all.slice(0, HEAT_MAX), total: all.length, bySide };
    }

    // ── eco ──
    function eco() {
      const res = perTeam(() => ({ militaryLost: 0, villagerLost: 0, ecoBuildingLost: 0, otherBuildingLost: 0, militaryDeaths: 0, villagerDeaths: 0, villagersPulled: 0, pulledIds: [], villagerDamage: 0, forcedIdle: 0, gatherersBase: 0, gatherersNoise: 0, villagersHit: false }));
      for (let i = lowerBound(I.deathT, t0); i < I.deaths.length && I.deathT[i] <= t1; i++) {
        const v = I.deaths[i], td = v.died - 0.01, lv = pos(v, td);
        if (!inArea(lv.x, lv.z)) continue;
        const tm = sideOf(v, td);
        if (tm == null || !res[tm]) continue;
        const r = res[tm], value = valueOf(v);
        if (v.cat === "villager") { r.villagerLost += value; r.villagerDeaths++; r.villagersHit = true; }
        else if (isBld(v)) { if (ECO_BLD.test(v.bp)) r.ecoBuildingLost += value; else r.otherBuildingLost += value; }
        else { r.militaryLost += value; r.militaryDeaths++; }
      }
      for (const ev of events) if (ev.v.cat === "villager" && res[ev.vt]) res[ev.vt].villagersHit = true;
      // villagers fighting
      for (const e of C.ents) {
        if (e.cat !== "villager") continue;
        const times = attackTimes(C, e.id);
        const lo = lowerBound(times, t0), hi = lowerBound(times, t1 + 1e-9);
        if (hi <= lo) continue;
        const tm = sideOf(e, times[lo]);
        if (tm == null || !res[tm]) continue;
        res[tm].villagersPulled++; res[tm].pulledIds.push(e.id);
        res[tm].villagerDamage += dealtBy.get(e.id) || 0;
      }
      // forced idle: gatherers below the t0 count, villagers that died removed
      for (const s of sides) {
        const r = res[s.team];
        if (!r.villagersHit) continue;
        // gatherers per player as step functions, summed over the side at the union of their sample times
        const per = s.players.map((pi) => {
          const rows = ((d.jobs && d.jobs[pi]) || []).slice().sort((a, b) => a[0] - b[0]);
          return { t: rows.map((x) => x[0]), v: rows.map((x) => x[1] + x[2] + x[3] + x[4]) };
        }).filter((p) => p.t.length);
        if (!per.length) continue;
        const ts = [...new Set(per.flatMap((p) => p.t))].sort((a, b) => a - b);
        const at = (t) => per.reduce((sum, p) => { const i = Fr.idxAt(p.t, t); return sum + (i < 0 ? p.v[0] : p.v[i]); }, 0);
        const val = ts.map(at);
        const base = at(t0);
        r.gatherersBase = base;
        // the count wobbles by itself (job changes, walks to drop-offs): its spread over the 60 s before t0 is the noise
        // floor, the shortfall below it is the fight's
        const pre = ts.filter((t) => t >= t0 - 60 && t < t0).map(at);
        const mean = pre.length ? pre.reduce((a, b) => a + b, 0) / pre.length : base;
        const noise = pre.length > 1 ? Math.sqrt(pre.reduce((a, b) => a + (b - mean) * (b - mean), 0) / pre.length) : 0;
        r.gatherersNoise = noise;
        const deaths = [];
        for (const e of I.deaths) if (e.cat === "villager" && e.died >= t0 && e.died <= t1 + FLEE && sideOf(e, e.died - 0.01) === s.team) deaths.push(e.died);
        let idle = 0;
        for (let i = 0; i < ts.length; i++) {
          if (ts[i] < t0 || ts[i] > t1 + FLEE) continue;
          const nxt = i + 1 < ts.length ? Math.min(ts[i + 1], t1 + FLEE) : ts[i];
          const dead = deaths.filter((x) => x <= ts[i]).length;
          idle += Math.max(0, base - dead - val[i] - noise) * Math.max(0, nxt - ts[i]);
        }
        r.forcedIdle = idle;
      }
      return res;
    }
  }

  // ── list ──
  R.list = function (d, C) {
    return (d.fights || []).map((f, i) => {
      const a = R.analyze(d, C, i);
      const ratings = {};
      for (const tm of a.teams) { const r = a.rating[tm]; ratings[tm] = { score: r.score, letter: r.letter }; }
      const L = a.lanchester;
      return { index: i, id: f.id, t0: a.t0, t1: a.t1, duration: a.t1 - a.t0, x: a.x, z: a.z, radius: a.radius, teams: a.teams, ratings,
        winner: L.actual, winnerTeam: L.actual === "A" ? a.A : L.actual === "B" ? a.B : null, p: L.p, predicted: L.predicted, correct: L.correct,
        deaths: f.deaths, damage: f.damage, lost: a.lost.total, impact: a.impact, tags: a.tags.map((t) => t.tag) };
    });
  };
})();
