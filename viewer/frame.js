"use strict";
// frame.js: the view-model layer both viewers share. The 2D viewer (model.js RV.prepare → M.combat, M.view) and the 3D
// viewer (viewer3d/core/replay.js Replay → R.combat, viewer.js) build it from their own entity tables. Both tables hold
// the same recorded tracks (viewer3d/tools/parity-check.mjs compares them, and compares this layer's output across the
// two), so both views draw one set of combat events and one FrameRenderState at every t.
//
// RV_FRAME.combat(ents, d) → C, the combat index of a replay:
// - blows: attack samples → timed melee strikes and shots (C.lists per attacker, C.melee, C.shots). The recorder flags
//   whether a unit attacked in the last 0.5 s, paired with its current target, so one swing or shot shows as a pulse of
//   1–2 flagged samples about a weapon period apart: each pulse start (or target change) is a blow, plus one per period
//   through longer runs; units torch buildings when they carry a torch. Where in its 0.5 s window a blow fell is not
//   recorded:
//   - a melee strike lands inside the window of the target's HP drop (else the flag's) at a moment when the attacker is
//     within reach (weapon range + both body radii + REACH_SLACK) of a living target; failing that on another enemy hit
//     within reach then; failing that nowhere (no swing);
//   - a shot is loosed inside the flag's window so its flight (distance / projectile speed) ends inside the window of
//     the target's HP drop within a second; with no drop, or a target dead by then, it misses (miss: true).
//   Inside those windows each unit keeps an even cadence (its recorded pulse spacing) from its own phase, so neighbours
//   do not strike in lockstep. A killed unit's killer lands a blow on the death tick (kill: true). Buildings shoot
//   guessed shots (guess: true, shooter = the building) from their wpn_* weapon attachments: see the fort pass.
//   mobile: the weapon is used on the move (timing.moving); the 3D viewer plants the others' feet (Replay.standToStrike).
// - damage: every recorded HP drop (C.dmgT/dmgId/dmgAmt, ordered by the moment it shows: the landing of the blows that
//   explain it, else a per-target moment inside its window), typed by those blows' weapons (C.dmgType: melee, pierce,
//   siege, fire; C.dmgBonus: the weapon carries a bonus against the victim's classes), with each attacker's share
//   (C.dealt). Damage within the 0.5 s sample window merges into one drop: a number is one window's loss, not one hit.
// - heals (C.heals): HP rises within HEAL_R of a still religious unit of the same owner. The recorder keeps no heal
//   event; this is inferred from where rises happen (see HEAL_R).
// - splash (shot.splash): drops on the victim's side next to an area shooter's landing that no other blow explains.
//
// RV_FRAME.controller(C) → the FrameRenderState controller: selectedUnitIds, hoveredUnitId and frame(t, ents), which
// fills pooled arrays (no per-frame allocation) with what is happening at t: activeProjectiles, activeImpacts (landed
// splash shots, IMPACT_SHOW s), activeHeals, floatingDamageEvents and activeEngagementLines (attack pairs scored for
// target priority).
//
// RV_FRAME.statOf(bp) / statsAt(C, e, t): a blueprint's aoe4world stats (stats.js) and an entity's stats at t with its
// owner's researched upgrades applied. RV_FRAME.telemetry(C, e, t): damage dealt and taken, kills, DPS uptime and
// target-priority grade up to t.
(function () {
  const F = {};
  window.RV_FRAME = F;

  const SAMPLE = 0.5;            // recorder sample interval (s)
  const MAX_FLIGHT = 2;          // longest projectile flight (s)
  const ARROW_SPEED = 30;        // m/s for shooters without weapon timings (town centres, outposts)
  const RANGED = /archer|mohe|crossbow|horse_archer|town_center|outpost|wpn_range|tower/; // shooters without weapon timings
  const STEP = 1 / 16;           // s: candidate strike times inside a recorded 0.5 s window
  const REACH_SLACK = 2;         // m a recorded strike may land beyond weapon range + body radii (positions lag and round)
  const FORT_RANGE = 24;         // m a building's weapon reaches without timings (an outpost's arrows, the shortest)
  const FORT_QUIET = 1;          // s: an HP drop this close to an attack flagged on the victim is not a building's guessed shot
  // Heals: in aoe4_245598603, 2388 of the 2774 unit HP rises have a religious unit of the same owner within 30 m, and
  // 2042 of those within 8 m (the count per metre falls from 129 at 7–8 m to 79, 43, 39 beyond); 81 % of them with the
  // monk standing still. Rises farther out or with no monk are regeneration (aoe4_256829909: 3948 of 4798 rises).
  const HEAL_R = 8;              // m from a religious unit within which a rise is its heal
  const HEAL_GAP = 2;            // s between two heal ticks of one monk on one unit that are still one heal
  // Splash: around 68 mangonel landings with a target drop in aoe4_245598603, enemy units that were not attacked lost HP
  // in the same sample at 1–5 m (n = 124, median loss 1.00 × the target's) and rarely beyond (n = 16 at 5–11 m). So 5 m
  // is the measured full-damage reach. The data cannot separate a 50 % from a 25 % band; the outer two rings are a
  // display convention at 1.25 and 1.5 × that reach.
  const SPLASH = /mangonel|nest_of_bees|ribauldequin|trebuchet/;
  const SPLASH_R = 5;
  const SPLASH_BANDS = [[SPLASH_R, 1], [1.25 * SPLASH_R, 0.5], [1.5 * SPLASH_R, 0.25]];
  const DMG_SHOW = 0.6;          // s a floating damage number lives
  const IMPACT_SHOW = 0.5;       // s a landed splash shot's rings show
  const LINE_HOLD = 0.75;        // s an attack sample stays drawn (2D RV.attacksAt)
  // target priority: a pair scores Damage(A→B)·Cost(B)/CurHP(B) over the best such value among the enemies within A's
  // reach; these split the pair lines into optimal / neutral / suboptimal
  const PRIO_GOOD = 0.8, PRIO_OK = 0.4;
  F.SAMPLE = SAMPLE; F.MAX_FLIGHT = MAX_FLIGHT; F.DMG_SHOW = DMG_SHOW; F.SPLASH_BANDS = SPLASH_BANDS; F.IMPACT_SHOW = IMPACT_SHOW;
  F.HEAL_R = HEAL_R; F.PRIO_GOOD = PRIO_GOOD; F.PRIO_OK = PRIO_OK;

  // ── shared math (the same rules as model.js and core/replay.js; parity-check.mjs holds them together) ──
  function idxAt(arr, t) {
    let lo = 0, hi = arr.length - 1, r = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= t) { r = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return r;
  }
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  function hash01(n) {
    let x = (n ^ 0x9e3779b9) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
    x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
  }
  const hash3 = (a, b, c) => hash01((a * 73856093) ^ (b * 19349663) ^ (c * 83492791));
  function alive(e, t) {
    const s = e.spans;
    for (let i = 0; i < s.length; i += 2) if (t >= s[i] && t < s[i + 1]) return true;
    return false;
  }
  function ownerAt(e, t) {
    if (!e.ownT) return e.owner;
    const i = idxAt(e.ownT, t);
    return i < 0 ? e.owner : e.ownV[i];
  }
  const _loc = { x: 0, z: 0, hp: 0, i: 0 };
  /** Position/HP at t: hold each sample, interpolating over the final SAMPLE before the next recorded change. */
  function locate(e, t) {
    let i = idxAt(e.t, t);
    if (i < 0) i = 0;
    let x = e.x[i], z = e.z[i];
    if (i + 1 < e.t.length) {
      const t1 = e.t[i + 1], ts = Math.max(e.t[i], t1 - SAMPLE);
      if (t > ts) {
        const a = (t - ts) / (t1 - ts);
        x += (e.x[i + 1] - x) * a;
        z += (e.z[i + 1] - z) * a;
      }
    }
    _loc.x = x; _loc.z = z; _loc.hp = e.hp[i]; _loc.i = i;
    return _loc;
  }
  F.idxAt = idxAt; F.alive = alive; F.ownerAt = ownerAt; F.locate = locate; F.hash01 = hash01; F.hash3 = hash3;

  const isBld = (e) => e.cat === "building";
  const isUnit = (e) => e.cat !== "building" && e.cat !== "attachment";
  const seeds = new Map();
  const seedOf = (e) => { let s = seeds.get(e.id); if (s === undefined) seeds.set(e.id, (s = hash01(e.id))); return s; };
  /** Rough building radius (m) (core/replay.js footprint). */
  const footprint = (bp) => (/town_center|landmark/.test(bp) ? 9 : /farm/.test(bp) ? 7 : /house|outpost|palisade|bastion|marker/.test(bp) ? 3 : 6);
  const bodyR = (e) => (isBld(e) ? footprint(e.bp) : e.cat === "cavalry" || /mounted/.test(e.bp) ? 1.2 : e.cat === "siege" ? 1.5 : 0.5);
  F.bodyR = bodyR;

  /** Weapon timing class (stats.js main/torch) → swing pose (viewer3d POSES key). */
  function swingKind(w, e) {
    if (!w) return /archer|bow|mohe|crossbow/.test(e.bp) ? "bow" : "swipe";
    switch (w.class) {
      case "cdn_bow": return "bow";
      case "cdn_fire": return "throw";
      case "cdn_2h_spear": return "thrust2";
      case "cdn_1h_sword": return "slash";
      case "cdn_1h_axe": return "chop";
    }
    if (/mace|axe|hammer|club/.test(w.art || "")) return "smash";
    return w.class === "cdn_1h_spear" ? "thrust1" : "swipe";
  }

  // ── stats (stats.js, built from data.aoe4world.com by viewer3d/tools/build-stats.mjs) ──
  const statCache = new Map();
  let prefixIndex = null; // blueprint prefix (whole "_" tokens) → first stats key with it, for blueprints aoe4world lacks
  /** A blueprint's stats record, or null. Unknown blueprints fall back to the longest token prefix aoe4world has
   *  (unit_ram_3_hre → a unit_ram_3 of another civ); such records carry approx: true. */
  F.statOf = function (bp) {
    if (statCache.has(bp)) return statCache.get(bp);
    const S = window.RV_STATS && window.RV_STATS.units;
    let r = null;
    if (S) {
      r = S[bp] || null;
      if (!r) {
        if (!prefixIndex) {
          prefixIndex = new Map();
          for (const k of Object.keys(S).sort()) {
            if (!S[k].b) continue;
            const tk = k.split("_");
            for (let n = 2; n < tk.length; n++) { const p = tk.slice(0, n).join("_"); if (!prefixIndex.has(p)) prefixIndex.set(p, k); }
          }
        }
        const tk = bp.split("_");
        for (let n = tk.length - 1; n >= 2 && !r; n--) {
          const k = prefixIndex.get(tk.slice(0, n).join("_"));
          if (k) r = Object.assign({}, S[k], { approx: k });
        }
      }
    }
    statCache.set(bp, r);
    return r;
  };
  const timingOf = (bp) => F.statOf(bp) || {};
  F.swingKind = swingKind;

  const DTYPE = { Melee: "melee", Ranged: "pierce", Siege: "siege", Fire: "fire" };
  const WP_TYPE = { melee: "melee", pierce: "ranged", siege: "siege", fire: "fire" };
  /** The aoe4world weapon a timing uses (by damage type), or the first. */
  function weaponOf(st, dtype) {
    if (!st || !st.wp || !st.wp.length) return null;
    const ty = WP_TYPE[dtype];
    return st.wp.find((w) => w.ty === ty) || st.wp[0];
  }
  const hasClasses = (cls, groups) => groups.some((g) => g.every((c) => cls.includes(c)));
  /** Bonus damage weapon w carries against a target with stats tst (Σ of the mods that select it), 0 when none. */
  function bonusOf(w, tst) {
    if (!w || !w.mods || !tst) return 0;
    let b = 0;
    for (const m of w.mods) {
      if (m.e !== "change") continue;
      if ((m.id && m.id.includes(tst.b)) || (m.c && tst.cls && hasClasses(tst.cls, m.c))) b += m.v;
    }
    return b;
  }
  const ARMOR_OF = { melee: "melee", ranged: "ranged", fire: "fire" };
  /** Expected damage of one hit of A's weapon w on B (base + bonus − armour, at least 1); upgrades from sa/sb (statsAt). */
  function hitDamage(w, tst, sa, sb) {
    if (!w) return 1;
    let atk = (sa && sa.atk[w.ty] != null ? sa.atk[w.ty] : w.dmg) + bonusOf(w, tst);
    if (sa && tst && tst.cls) for (const b of sa.vs) if (b.ty === w.ty && hasClasses(tst.cls, b.c)) atk += b.v;
    const at = ARMOR_OF[w.ty], arm = at ? (sb ? sb.arm[at] : (tst && tst.arm && tst.arm[at]) || 0) : 0;
    return Math.max(1, atk - arm);
  }

  // Upgrades a player researched: d.upgrades rows { t, fields: { upgrade: "b" + tech attribName (+ civ suffix), executer } }.
  function techOf(name) {
    const T = window.RV_STATS && window.RV_STATS.techs;
    if (!T) return null;
    if (T[name]) return T[name];
    const tk = name.split("_");
    for (let n = tk.length - 1; n >= 3; n--) { const k = tk.slice(0, n).join("_"); if (T[k]) return T[k]; }
    return null;
  }
  function prepUpgrades(d, byId) {
    const by = new Map(); // player idx → [{ t, tech, name }] in time order
    for (const u of d.upgrades || []) {
      const f = u.fields || {}, up = (f.upgrade || "").replace(/^b/, ""), ex = /^e(\d+)$/.exec(f.executer || "");
      const ee = ex ? byId.get(+ex[1]) : null, tech = techOf(up);
      if (!ee || !tech) continue;
      const p = ownerAt(ee, u.t);
      if (!by.has(p)) by.set(p, []);
      by.get(p).push({ t: u.t, tech, key: up });
    }
    for (const l of by.values()) l.sort((a, b) => a.t - b.t);
    return by;
  }
  F.techOf = techOf;
  const selects = (eff, st) => (eff.id && eff.id.length && eff.id.includes(st.b)) || (eff.c && eff.c.length && st.cls && hasClasses(st.cls, eff.c));

  /** Blueprint e plays at t: its line's upgraded tier (e.ups [t, tier, name]) swapped into the bp. */
  function bpAt(e, t) {
    if (!e.ups) return e.bp;
    let tier = 0;
    for (const u of e.ups) if (u[0] <= t && u[1] > tier) tier = u[1];
    return tier ? e.bp.replace(/_([1-5])(?=_|$)/, "_" + tier) : e.bp;
  }
  /**
   * e's stats at t: base stats of its blueprint (upgraded tier) with every upgrade its owner finished by t applied.
   * → { st, bp, hp, arm: { melee, ranged, fire }, atk: { melee, ranged, siege, fire }, range, speed, period, bonuses:
   *     [{ name, t, text }], approx } or null when the blueprint has no stats.
   */
  F.statsAt = function (C, e, t) {
    const bp = bpAt(e, t), st = F.statOf(bp);
    if (!st || !st.b) return null;
    const pown = ownerAt(e, t), ups = C.upgrades.get(pown) || [];
    let n = 0;
    while (n < ups.length && ups[n].t <= t) n++;
    const key = bp + "|" + pown + "|" + n;
    const hit = C.statMemo.get(key);
    if (hit) return hit;
    const arm = { melee: (st.arm && st.arm.melee) || 0, ranged: (st.arm && st.arm.ranged) || 0, fire: (st.arm && st.arm.fire) || 0 };
    const atk = {};
    for (const w of st.wp || []) if (atk[w.ty] == null) atk[w.ty] = w.dmg;
    const main = (st.wp || []).find((w) => w.ty !== "fire") || (st.wp || [])[0] || null;
    const r = { st, bp, hp: st.hp || e.maxhp, arm, atk, range: main ? main.rmax : 0, speed: st.spd || 0, period: main ? main.per : 0,
      bonuses: [], approx: st.approx || null, gather: {}, vs: [] };
    const PROP = { meleeAttack: "melee", rangedAttack: "ranged", siegeAttack: "siege", fireAttack: "fire" };
    const ARM = { meleeArmor: "melee", rangedArmor: "ranged", fireArmor: "fire" };
    for (let k = 0; k < n; k++) {
      const u = ups[k], parts = [];
      for (const eff of u.tech.eff || []) {
        // abilities (Forced March) and auras last only while active or nearby, which the recording does not tell
        if (eff.k === "ability" || eff.k === "influence" || !selects(eff, st)) continue;
        const v = eff.v, mul = eff.e === "multiply";
        if (eff.tc) { // bonus damage against target classes, like a weapon modifier
          if (PROP[eff.p]) { r.vs.push({ ty: PROP[eff.p], v, c: eff.tc }); parts.push(`+${v} ${PROP[eff.p]} attack vs ${eff.tc.map((g) => g.join(" ")).join(" / ")}`); }
          continue;
        }
        if (PROP[eff.p] && atk[PROP[eff.p]] != null) {
          const ty = PROP[eff.p]; atk[ty] = mul ? atk[ty] * v : atk[ty] + v; parts.push(`${mul ? "×" + v : "+" + v} ${ty} attack`);
        } else if (ARM[eff.p]) {
          const ty = ARM[eff.p]; arm[ty] = mul ? arm[ty] * v : arm[ty] + v; parts.push(`${mul ? "×" + v : "+" + v} ${ty} armour`);
        } else if (eff.p === "hitpoints") { r.hp = mul ? r.hp * v : r.hp + v; parts.push(`${mul ? "×" + v : "+" + v} HP`); }
        else if (eff.p === "moveSpeed") { r.speed = mul ? r.speed * v : r.speed + v; parts.push(`${mul ? "×" + v : "+" + v} speed`); }
        else if (eff.p === "maxRange" && r.range) { r.range = mul ? r.range * v : r.range + v; parts.push(`${mul ? "×" + v : "+" + v} range`); }
        else if (eff.p === "attackSpeed" && r.period) { r.period = mul ? r.period * v : r.period + v; parts.push(`${mul ? "×" + v : v} reload`); }
        else if (/GatherRate$/.test(eff.p)) { r.gather[eff.p] = (r.gather[eff.p] || 1) * (mul ? v : 1); parts.push(`×${v} ${eff.p.replace(/GatherRate$/, "")} gather`); }
      }
      if (parts.length) r.bonuses.push({ name: u.tech.n, t: u.t, text: parts.join(", ") });
    }
    C.statMemo.set(key, r);
    return r;
  };

  const ATK_LABEL = { melee: "melee", ranged: "pierce", siege: "siege", fire: "fire" };
  /**
   * What a unit stat card shows for e at t: its display name and cost ({ f, w, g, s, … } from stats.js), rows of
   * { label, base, cur, unit } (base: the blueprint's own value; cur: with the owner's upgrades finished by t), the main
   * weapon's bonus damage (vs: the classes or units it selects), the upgrades that changed anything, and telemetry
   * (F.telemetry). Null without stats.
   */
  F.cardData = function (C, e, t) {
    const s = F.statsAt(C, e, t);
    if (!s) return null;
    const st = s.st, wp = st.wp || [], main = wp.find((w) => w.ty !== "fire") || null, rows = [];
    if (main) rows.push({ label: "Attack", base: main.dmg, cur: s.atk[main.ty], unit: ATK_LABEL[main.ty] + (main.burst > 1 ? ` ×${main.burst}` : "") });
    rows.push({ label: "Melee armour", base: (st.arm && st.arm.melee) || 0, cur: s.arm.melee, unit: "" });
    rows.push({ label: "Pierce armour", base: (st.arm && st.arm.ranged) || 0, cur: s.arm.ranged, unit: "" });
    if (main) rows.push({ label: "Range", base: main.rmax, cur: s.range, unit: "tiles" });
    if (st.spd) rows.push({ label: "Speed", base: st.spd, cur: s.speed, unit: "tiles/s" });
    if (main) rows.push({ label: "Reload", base: main.per, cur: s.period, unit: "s" });
    rows.push({ label: "Max HP", base: st.hp || e.maxhp, cur: s.hp, unit: "" });
    const vsText = (c, id) => (c && c.length ? c.map((g) => g.join(" ")).join(" / ") : (id || []).join(" / "));
    const bonus = main ? (main.mods || []).filter((m) => m.e === "change" && m.v).map((m) => ({ v: m.v, vs: vsText(m.c, m.id) })) : [];
    if (main) for (const b of s.vs) if (b.ty === main.ty) bonus.push({ v: b.v, vs: vsText(b.c), up: true });
    const armed = !!main || C.per.has(e.id);
    return { name: st.n, bp: s.bp, approx: s.approx, cost: st.cost || null, rows, bonus, upgrades: s.bonuses, tel: armed ? F.telemetry(C, e, t) : null };
  };

  // ── the combat index ──
  F.combat = function (ents, d) {
    const byId = new Map(ents.map((e) => [e.id, e]));
    const players = new Map((d.players || []).map((p) => [p.idx, p]));
    const teamOf = (e, t) => { const p = players.get(ownerAt(e, t)); return p ? p.team : null; };
    const C = { ents, byId, players, teamOf, statMemo: new Map() };
    C.upgrades = prepUpgrades(d, byId);

    // attacks: each sample lists every [attacker, target] pair attacking then, flattened (a0, b0, a1, b1, …)
    const atk = (d.attacks && d.attacks.times || []).map((t, i) => [t, d.attacks.pairs[i]]).sort((a, b) => a[0] - b[0]);
    C.atkT = Float64Array.from(atk, (a) => a[0]);
    C.atkP = atk.map((a) => a[1]);
    const per = new Map(); // attacker id → [t0, target0, t1, target1, …] in time order
    for (const [t, p] of atk) {
      for (let k = 0; k + 1 < p.length; k += 2) {
        let list = per.get(p[k]);
        if (!list) per.set(p[k], (list = []));
        list.push(t, p[k + 1]);
      }
    }
    C.per = per;
    // damage events = HP drops between samples (livestock HP is food, attachments are weapons)
    const dmg = [];
    for (const e of ents) {
      if (e.cat === "livestock" || e.cat === "attachment" || e.cat === "other") continue;
      for (let i = 1; i < e.hp.length; i++) { const dd = e.hp[i - 1] - e.hp[i]; if (dd >= 1) dmg.push([e.t[i], e.id, dd]); }
    }
    dmg.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    buildBlows(C, per, dmg);
    typeDamage(C);
    C.heals = buildHeals(ents);
    C.healT = Float64Array.from(C.heals, (h) => h.t0);
    C.healMax = C.heals.reduce((m, h) => Math.max(m, h.t1 - h.t0), 0);
    C.kills = (d.kills || []).slice().sort((a, b) => a.t - b.t);
    C.fights = d.fights || [];
    C.telemetry = new Map();
    // damage indices per victim, in time order (telemetry's damage taken)
    C.dmgOf = new Map();
    for (let k = 0; k < C.dmgT.length; k++) { const id = C.dmgId[k], l = C.dmgOf.get(id); if (l) l.push(k); else C.dmgOf.set(id, [k]); }
    // target-priority scratch (factsAt / F.effAt)
    C.fighters = ents.filter((e) => (isUnit(e) || isBld(e)) && e.cat !== "livestock" && e.cat !== "attachment" && e.cat !== "other");
    C.facts = new Map(); C.grid = new Map(); C.factsT = NaN; C.effCache = new Map();
    return C;
  };

  function buildBlows(C, per, dmg) {
    const { byId, ents, teamOf } = C;
    const dropsOf = new Map(); // id → recorded HP drop times, in order
    for (const [t, id] of dmg) { const l = dropsOf.get(id); if (l) l.push(t); else dropsOf.set(id, [t]); }
    const dropT = Float64Array.from(dmg, (v) => v[0]);
    const firstDrop = (b, lo, hi) => {
      for (const t of dropsOf.get(b.id) || []) if (t >= lo) return t <= hi ? t : NaN;
      return NaN;
    };
    // where a drop no blow explains shows inside its window: a per-target moment (a guessed fort shot lands there too)
    const dropMoment = (t, id) => t - 0.45 * hash3(id, Math.round(t * 8), 11);
    const reachOf = (a, b, w) => ((w && w.range) || 1.2) + bodyR(a) + bodyR(b);
    const speedOf = (a, w) => (w && w.projectile ? (w.projectile.speedMin + w.projectile.speedMax) / 2 : !w && RANGED.test(a.bp) ? ARROW_SPEED : 0);
    const flightOf = (a, b, t, speed) => {
      const la = locate(a, t), ax = la.x, az = la.z, lb = locate(b, t);
      return clamp(Math.hypot(lb.x - ax, lb.z - az) / speed, 0.05, MAX_FLIGHT);
    };
    // a wanted moment held inside (lo, hi] by a per-unit inset, so units pressed against one edge stay apart
    const inWin = (a, t, lo, hi) => clamp(t, lo + 0.05 + 0.15 * seedOf(a), hi - 0.2 * seedOf(a));
    // strike moment in (lo, hi] (on a per-unit sub-grid) with both alive and a within reach (+ slack) of c: nearest
    // `want`, then nearest in
    const strikeIn = (a, c, w, lo, hi, want0) => {
      const ideal = reachOf(a, c, w), want = inWin(a, want0, lo, hi);
      let best = NaN, cost = Infinity;
      for (let s = hi - STEP * seedOf(a); s > lo + 1e-6; s -= STEP) {
        if (!alive(c, s) || !alive(a, s)) continue;
        const la = locate(a, s), ax = la.x, az = la.z, lc = locate(c, s);
        const over = Math.hypot(lc.x - ax, lc.z - az) - ideal;
        if (over > REACH_SLACK) continue;
        const k = Math.abs(s - want) + 0.5 * Math.max(0, over);
        if (k < cost) { cost = k; best = s; }
      }
      return best;
    };
    const blow = (a, b, w, torch, period) => {
      const kind = swingKind(w, a);
      return {
        a, b, kind, torch, period, t0: 0, t1: 0, shot: false, miss: false, kill: false, guess: false, drop: NaN, mobile: !!(w && w.moving),
        up: kind === "bow" ? 0.6 : clamp(((w && w.aim) || 0) + (w && w.windUp != null ? w.windUp : 0.4), 0.3, 0.8),
        fol: clamp((w && w.windDown) || 0.4, 0.3, 0.6),
        dtype: w ? DTYPE[w.damage] || "melee" : speedOf(a, w) > 0 ? "pierce" : "melee", splash: null,
      };
    };

    const lists = new Map(); // attacker id → its blows
    for (const [id, list] of per) {
      const e = byId.get(id);
      if (!e) continue;
      const wp = timingOf(e.bp), mine = [];
      let last = -Infinity, prevTs = -Infinity, prevS = NaN, gap = 0;
      for (let k = 0; k < list.length; k += 2) {
        const ts = list[k], b = byId.get(list[k + 1]);
        if (!b) continue;
        const torch = !!wp.torch && isBld(b), w = (torch ? wp.torch : wp.main) || null, period = (w && w.period) || 1.5;
        const fresh = k === 0 || list[k + 1] !== list[k - 1] || ts - list[k - 2] > SAMPLE + 0.05;
        if (!fresh && ts - last < period - 0.05) continue;
        last = ts;
        // cadence: the engagement's running pulse spacing after the previous blow, else the unit's own phase
        const engaged = ts - prevTs <= 2 * period + 1 && prevS === prevS;
        gap = engaged ? (gap > 0 ? 0.6 * gap + 0.4 * (ts - prevTs) : ts - prevTs) : 0;
        prevTs = ts;
        const want = (hi) => (engaged ? prevS + gap : hi - SAMPLE * (0.15 + 0.7 * seedOf(e)));
        const bl = blow(e, b, w, torch, period), speed = speedOf(e, w);
        if (speed > 0) {
          const drop = firstDrop(b, ts - 0.01, ts + 1.01), flight = flightOf(e, b, ts, speed);
          let r = inWin(e, want(ts), ts - SAMPLE, ts), land = r + flight;
          if (drop === drop) {
            land = inWin(e, land, drop - SAMPLE, drop);
            r = clamp(land - flight, ts - 1, ts);
            land = clamp(land, r + 0.05, r + MAX_FLIGHT);
          }
          bl.shot = true; bl.t0 = r; bl.t1 = land;
          if (drop === drop && alive(b, land)) bl.drop = drop; else bl.miss = true;
          prevS = r;
        } else {
          let drop = firstDrop(b, ts - 0.01, ts + SAMPLE + 0.01), tg = b;
          const hi = drop === drop ? drop : ts;
          let s = strikeIn(e, b, w, hi - SAMPLE, hi, want(hi));
          if (s !== s) {
            // the paired target is out of reach: the swing fell on another enemy hit within reach then
            const team = teamOf(e, ts);
            let bestOver = Infinity;
            for (let j = idxAt(dropT, ts - 0.011) + 1; j < dmg.length && dropT[j] <= ts + SAMPLE + 0.01; j++) {
              const c = byId.get(dmg[j][1]), th = dropT[j];
              if (!c || c === b || c === e || teamOf(c, th) === team) continue;
              const s2 = strikeIn(e, c, w, th - SAMPLE, th, want(th));
              if (s2 !== s2) continue;
              const la = locate(e, s2), ax = la.x, az = la.z, lc = locate(c, s2);
              const over = Math.hypot(lc.x - ax, lc.z - az) - reachOf(e, c, w);
              if (over < bestOver) { bestOver = over; s = s2; tg = c; drop = th; }
            }
            // else the paired target, struck without a recorded drop, inside the flag's window
            if (s !== s && drop === drop) { drop = NaN; s = strikeIn(e, b, w, ts - SAMPLE, ts, want(ts)); }
          }
          if (s !== s) { prevS = engaged ? prevS + gap : NaN; continue; } // nobody within reach: no swing
          bl.b = tg; bl.t0 = bl.t1 = s; bl.drop = drop;
          prevS = s;
        }
        mine.push(bl);
      }
      if (mine.length) lists.set(id, mine);
    }

    // killing blows: the killer's nearest blow on its victim moves onto the death tick, else one in reach is added
    for (const v of ents) {
      const k = v.died != null && v.cat !== "livestock" && v.killer != null ? byId.get(v.killer) : null;
      if (!k || k === v || isBld(k) || k.cat === "attachment") continue; // buildings' weapons: the fort pass below
      const mine = lists.get(k.id) || [], died = v.died;
      let best = null, bd = Infinity;
      for (const bl of mine) {
        const dd = (bl.shot ? bl.t1 : bl.t0) - died;
        if (bl.b !== v || dd < -2.5 || dd > 0.6 || (dd < -0.6 && bl.drop === bl.drop)) continue; // an earlier hit that told stays
        if (Math.abs(dd) < bd) { bd = Math.abs(dd); best = bl; }
      }
      if (best) {
        const shift = died - (best.shot ? best.t1 : best.t0);
        best.t0 += shift; best.t1 += shift;
      } else {
        const wp = timingOf(k.bp), torch = !!wp.torch && isBld(v), w = (torch ? wp.torch : wp.main) || null;
        if (!w || !alive(k, died - 0.01) || mine.some((bl) => Math.abs(bl.t0 - died) < 0.6)) continue;
        const speed = speedOf(k, w);
        best = blow(k, v, w, torch, w.period || 1.5);
        if (speed > 0) {
          best.shot = true; best.t1 = died; best.t0 = died - flightOf(k, v, died - 0.01, speed);
        } else {
          const la = locate(k, died - 0.01), ax = la.x, az = la.z, lv = locate(v, died - 0.01);
          if (Math.hypot(lv.x - ax, lv.z - az) - reachOf(k, v, w) > REACH_SLACK) continue;
          best.t0 = best.t1 = died;
        }
        mine.push(best);
        lists.set(k.id, mine);
      }
      best.kill = true; best.miss = false;
    }

    // Buildings' weapons (wpn_* attachments sitting on them) never carry attack flags, so their arrows are guessed
    // (guess: true): a unit HP drop no blow explains, with no attack flagged on the victim within FORT_QUIET s, is a
    // shot from the nearest enemy building with a live weapon that reaches it (weapon range + both body radii +
    // REACH_SLACK), landing where that drop shows anyway (hit moments and damage numbers stay put). A unit killed with
    // no killing blow and no recorded killer, or a building or its weapon as killer, takes one on the death tick.
    const arms = new Map(), hostOf = new Map(); // building → [{ a: weapon attachment, w: its timings, reach }]
    const blds = ents.filter(isBld);
    for (const a of ents) {
      if (a.cat !== "attachment" || !/^wpn_/.test(a.bp)) continue;
      const f = blds.find((b) => {
        if (!alive(b, a.spans[0])) return false;
        const lb = locate(b, a.spans[0]), x = lb.x, z = lb.z, la = locate(a, a.spans[0]); // a building that moved (Mongol) carries its weapon along
        return Math.hypot(x - la.x, z - la.z) < 0.5;
      });
      if (!f) continue;
      const w = timingOf(a.bp).main || null;
      (arms.get(f) || arms.set(f, []).get(f)).push({ a, w, reach: ((w && w.range) || FORT_RANGE) + bodyR(f) + REACH_SLACK });
      hostOf.set(a, f);
    }
    C.arms = arms;
    const flagged = new Map(); // target id → times it was flagged as attacked, in order
    for (const list of per.values()) for (let k = 0; k < list.length; k += 2) (flagged.get(list[k + 1]) || flagged.set(list[k + 1], []).get(list[k + 1])).push(list[k]);
    for (const l of flagged.values()) l.sort((x, y) => x - y);
    C.flagged = flagged;
    const quiet = (id, t) => { const l = flagged.get(id), i = l ? idxAt(l, t + FORT_QUIET) : -1; return i < 0 || l[i] < t - FORT_QUIET; };
    const fortAt = (v, t) => { // nearest enemy building whose weapon, live at t, reaches v → { f, w } or null
      const tv = teamOf(v, t), lv = locate(v, t), vx = lv.x, vz = lv.z;
      let best = null, bd = Infinity;
      for (const [f, ws] of arms) {
        if (!alive(f, t) || teamOf(f, t) === tv) continue;
        const lf = locate(f, t), dd = Math.hypot(lf.x - vx, lf.z - vz);
        if (dd >= bd) continue;
        const s = ws.find((s) => alive(s.a, t - 0.01) && dd <= s.reach + bodyR(v));
        if (s) { best = { f, w: s.w }; bd = dd; }
      }
      return best;
    };
    const fortShot = (f, w, v, land) => {
      const bl = blow(f, v, w, false, (w && w.period) || 2);
      bl.shot = bl.mobile = bl.guess = true; bl.t1 = land; bl.t0 = land - flightOf(f, v, land - 0.01, speedOf(f, w) || ARROW_SPEED);
      if (!w) bl.dtype = "pierce";
      (lists.get(f.id) || lists.set(f.id, []).get(f.id)).push(bl);
      return bl;
    };
    const told = new Set(), slain = new Set();
    for (const mine of lists.values()) for (const bl of mine) { if (!bl.miss && bl.drop === bl.drop) told.add(`${bl.b.id}|${bl.drop}`); if (bl.kill) slain.add(bl.b); }
    for (const [t, id] of dmg) {
      const v = byId.get(id), hit = isBld(v) || told.has(`${id}|${t}`) || !quiet(id, t) ? null : fortAt(v, t);
      if (hit) fortShot(hit.f, hit.w, v, dropMoment(t, id)).drop = t;
    }
    for (const v of ents) {
      if (v.died == null || v.defeated || !isUnit(v) || v.cat === "livestock" || slain.has(v)) continue; // a defeat has no blow
      const k = v.killer == null ? null : byId.get(v.killer), at = v.died - 0.01;
      if (k && !isBld(k) && k.cat !== "attachment") continue;
      const kf = k && isBld(k) ? k : k && hostOf.get(k), named = kf && alive(kf, at) ? arms.get(kf) : null;
      const hit = named ? { f: kf, w: (named.find((s) => alive(s.a, at)) || named[0]).w } : fortAt(v, at);
      if (hit) fortShot(hit.f, hit.w, v, v.died).kill = true;
    }

    // splash: an area shooter's landing takes the drops at its drop time on the victim's side within SPLASH_R of the
    // landing spot that no blow told
    const dmgAt = new Map(); // drop time → [dmg index]
    dmg.forEach(([t], k) => { const l = dmgAt.get(t); if (l) l.push(k); else dmgAt.set(t, [k]); });
    const splashOf = new Map(); // dmg index → the shot whose splash it is
    for (const mine of lists.values()) for (const bl of mine) {
      if (!bl.shot || bl.miss || bl.drop !== bl.drop || !SPLASH.test(bl.a.bp)) continue;
      bl.splash = { bands: SPLASH_BANDS, victims: [] };
      const lb = locate(bl.b, bl.drop), bx = lb.x, bz = lb.z, team = teamOf(bl.b, bl.drop);
      for (const k of dmgAt.get(bl.drop) || []) {
        const v = byId.get(dmg[k][1]);
        if (v === bl.b || isBld(v) || told.has(`${v.id}|${bl.drop}`) || splashOf.has(k) || teamOf(v, bl.drop) !== team) continue;
        const lv = locate(v, bl.drop);
        if (Math.hypot(lv.x - bx, lv.z - bz) > SPLASH_R + bodyR(v)) continue;
        splashOf.set(k, bl);
        bl.splash.victims.push(v.id);
      }
    }

    // hit moments: each recorded drop shows at the landings it is attributed to, else at a per-target moment inside
    // its window; a killing blow's victim also reels on the death tick
    const att = new Map(), hits = new Map(), src = new Map(); // drop key → landings / blows that explain it
    const addHit = (id, t) => { const l = hits.get(id); if (l) l.push(t); else hits.set(id, [t]); };
    for (const mine of lists.values()) {
      for (const bl of mine) {
        if (bl.kill) addHit(bl.b.id, bl.b.died);
        if (bl.miss || bl.drop !== bl.drop) continue;
        const key = `${bl.b.id}|${bl.drop}`, land = bl.shot ? bl.t1 : bl.t0, l = att.get(key);
        if (l) { l.push(land); src.get(key).push(bl); } else { att.set(key, [land]); src.set(key, [bl]); }
      }
    }
    const shownAt = dmg.map(([t, id], k) => {
      const sp = splashOf.get(k), l = att.get(`${id}|${t}`) || (sp ? [sp.t1] : [dropMoment(t, id)]);
      for (const h of l) addHit(id, h);
      return Math.min(...l);
    });
    C.hitT = new Map();
    for (const [id, l] of hits) C.hitT.set(id, Float64Array.from(l).sort());
    const order = dmg.map((_, k) => k).sort((x, y) => shownAt[x] - shownAt[y] || x - y);
    C.dmgT = Float64Array.from(order, (k) => shownAt[k]);
    C.dmgId = order.map((k) => dmg[k][1]);
    C.dmgAmt = Float32Array.from(order, (k) => dmg[k][2]);
    C.dmgDrop = Float64Array.from(order, (k) => dmg[k][0]); // the recorded sample of the drop
    C.dmgSrc = order.map((k) => { const sp = splashOf.get(k); return src.get(`${dmg[k][1]}|${dmg[k][0]}`) || (sp ? [sp] : null); });
    C.dmgSplash = Uint8Array.from(order, (k) => (splashOf.has(k) ? 1 : 0));

    const melee = [], shots = [];
    C.lists = lists;
    for (const mine of lists.values()) {
      mine.sort((x, y) => x.t0 - y.t0);
      for (const bl of mine) (bl.shot ? shots : melee).push(bl);
    }
    melee.sort((x, y) => x.t1 - y.t1);
    shots.sort((x, y) => x.t0 - y.t0);
    C.melee = melee;
    C.meleeT = Float64Array.from(melee, (m) => m.t1);
    C.shots = shots;
    C.shotT = Float64Array.from(shots, (m) => m.t0);
  }

  /** Damage types and attacker shares of each drop (C.dmgType, C.dmgBonus, C.dealt: attacker id → { t: [], v: [] }). */
  function typeDamage(C) {
    const n = C.dmgT.length;
    C.dmgType = new Array(n);
    C.dmgBonus = new Uint8Array(n);
    C.dealt = new Map();
    const credit = (id, t, v) => { let r = C.dealt.get(id); if (!r) C.dealt.set(id, (r = { t: [], v: [] })); r.t.push(t); r.v.push(v); };
    for (let k = 0; k < n; k++) {
      const v = C.byId.get(C.dmgId[k]), tst = F.statOf(v.bp), t = C.dmgT[k], amt = C.dmgAmt[k];
      let blows = C.dmgSrc[k];
      if (!blows) {
        // nothing timed explains it: the units flagged on the victim in its window, each a plain hit of its weapon
        const drop = C.dmgDrop[k], who = [];
        for (let i = idxAt(C.atkT, drop); i >= 0 && C.atkT[i] > drop - 1; i--) {
          const p = C.atkP[i];
          for (let j = 1; j < p.length; j += 2) if (p[j] === v.id && !who.includes(p[j - 1])) who.push(p[j - 1]);
        }
        blows = who.map((id) => C.byId.get(id)).filter(Boolean).map((a) => {
          const w = timingOf(a.bp).main;
          return { a, dtype: w ? DTYPE[w.damage] || "melee" : "melee" };
        });
      }
      if (!blows.length) { C.dmgType[k] = "other"; continue; }
      let best = 0, total = 0;
      const ws = blows.map((bl) => {
        const w = weaponOf(F.statOf(bl.a.bp), bl.dtype), x = hitDamage(w, tst, null, null), bonus = bonusOf(w, tst) > 0;
        total += x;
        return { bl, x, bonus };
      });
      for (const r of ws) {
        credit(r.bl.a.id, t, (amt * r.x) / total);
        if (r.x > best) { best = r.x; C.dmgType[k] = r.bl.dtype; C.dmgBonus[k] = r.bonus ? 1 : 0; }
      }
    }
  }

  function buildHeals(ents) {
    const rel = ents.filter((e) => e.cat === "religious");
    const open = new Map(), heals = [];
    const rises = [];
    for (const e of ents) {
      if (!isUnit(e) || e.cat === "livestock" || e.cat === "other") continue;
      for (let i = 1; i < e.hp.length; i++) if (e.hp[i] > e.hp[i - 1]) rises.push([e.t[i], e, e.hp[i] - e.hp[i - 1]]);
    }
    rises.sort((a, b) => a[0] - b[0] || a[1].id - b[1].id);
    for (const [t, e, amt] of rises) {
      const p = locate(e, t), x = p.x, z = p.z, own = ownerAt(e, t);
      let best = null, bd = HEAL_R;
      for (const m of rel) {
        if (m === e || !alive(m, t) || ownerAt(m, t) !== own) continue;
        const q = locate(m, t), dd = Math.hypot(q.x - x, q.z - z);
        if (dd <= bd) { bd = dd; best = m; }
      }
      if (!best) continue;
      const key = best.id + "|" + e.id, h = open.get(key);
      if (h && t - h.t1 <= HEAL_GAP) { h.t1 = t; h.total += amt; continue; }
      const nh = { healer: best, target: e, t0: t - SAMPLE, t1: t, total: amt, rate: 0 };
      open.set(key, nh);
      heals.push(nh);
    }
    for (const h of heals) h.rate = h.total / (h.t1 - h.t0);
    heals.sort((a, b) => a.t0 - b.t0);
    return heals;
  }

  // ── target priority ──
  // Scores use the recorded positions and HP at the attack sample's own time (locate, not a viewer's re-timed draw
  // position), so both viewers grade every pair the same; C.effAt caches each sample's grades.
  const GRID = 16; // m per spatial cell
  const cellKey = (i, j) => i * 65536 + j;
  /** Every combatant alive at t → C.facts (id → { e, px, pz, php, pown, team }) and C.grid (cell → facts). */
  function factsAt(C, t) {
    if (C.factsT === t) return;
    C.factsT = t;
    C.grid.clear();
    for (const e of C.fighters) {
      let f = C.facts.get(e.id);
      if (!alive(e, t)) { if (f) f.on = false; continue; }
      if (!f) C.facts.set(e.id, (f = { e, on: false, px: 0, pz: 0, php: 0, pown: 0, team: null,
        statT: NaN, stats: null, st: null, weapon: null }));
      const L = locate(e, t);
      f.on = true; f.px = L.x; f.pz = L.z; f.php = L.hp; f.pown = ownerAt(e, t);
      const p = C.players.get(f.pown); f.team = p ? p.team : null;
      const k = cellKey(Math.floor(f.px / GRID), Math.floor(f.pz / GRID)), l = C.grid.get(k);
      if (l) l.push(f); else C.grid.set(k, [f]);
    }
  }
  const costOf = (e) => e.value || ((F.statOf(e.bp) || {}).cost || {}).total || 50;
  // Resolve each participating unit only once per sample, not once per attacker × candidate. In particular,
  // statsAt's blueprint/owner/upgrade-count key and tier substitution stay out of the candidate hot path.
  function priorityStats(C, f, t) {
    if (f.statT === t) return;
    f.statT = t;
    f.stats = F.statsAt(C, f.e, t);
    const bp = f.stats ? f.stats.bp : bpAt(f.e, t);
    f.st = F.statOf(bp);
    const wa = timingOf(bp);
    f.weapon = weaponOf(f.st, wa.main ? DTYPE[wa.main.damage] : "melee");
  }
  /** A's priority on B: Damage(A→B)·Cost(B)/CurHP(B). a, b: facts. */
  function prioScore(C, a, b, t) {
    priorityStats(C, a, t); priorityStats(C, b, t);
    const D = hitDamage(a.weapon, b.st, a.stats, b.stats);
    return (D * costOf(b.e)) / Math.max(1, b.php);
  }
  /**
   * Efficiency of A attacking B (facts at t): its score over the best score among the enemies within A's reach
   * (weapon range + bodies + REACH_SLACK), 1 when B is the best. A unit target is weighed against units only.
   */
  function efficiency(C, a, b, t) {
    const w = timingOf(a.e.bp).main, reach = ((w && w.range) || 1.2) + REACH_SLACK;
    const sb = prioScore(C, a, b, t), bb = isBld(b.e);
    let best = sb;
    const cx = Math.floor(a.px / GRID), cz = Math.floor(a.pz / GRID), rc = Math.ceil((reach + 10) / GRID);
    for (let i = cx - rc; i <= cx + rc; i++) for (let j = cz - rc; j <= cz + rc; j++) {
      const l = C.grid.get(cellKey(i, j));
      if (!l) continue;
      for (const c of l) {
        if (c === b || c === a || c.team === a.team || (isBld(c.e) && !bb)) continue;
        if (Math.hypot(c.px - a.px, c.pz - a.pz) > reach + bodyR(a.e) + bodyR(c.e)) continue;
        const s = prioScore(C, a, c, t);
        if (s > best) best = s;
      }
    }
    return best > 0 ? sb / best : 1;
  }
  /** Grades of every pair of attack sample i (Float32Array, one per pair; NaN when a side is gone). */
  F.effAt = function (C, i) {
    let r = C.effCache.get(i);
    if (r) return r;
    const t = C.atkT[i], p = C.atkP[i];
    factsAt(C, t);
    r = new Float32Array(p.length >> 1);
    for (let k = 0; k + 1 < p.length; k += 2) {
      const a = C.facts.get(p[k]), b = C.facts.get(p[k + 1]);
      r[k >> 1] = a && b && a.on && b.on ? efficiency(C, a, b, t) : NaN;
    }
    C.effCache.set(i, r);
    return r;
  };
  F.gradeOf = (eff) => (eff >= PRIO_GOOD ? "good" : eff >= PRIO_OK ? "ok" : "bad");
  F.letter = (p) => (p == null ? null : p >= 0.9 ? "S" : p >= 0.75 ? "A" : p >= 0.6 ? "B" : p >= 0.45 ? "C" : "F");

  /**
   * Telemetry of e up to t: { dealt, taken, kills, uptime (0–1: time flagged attacking over time spent inside fight
   * zones, null when never in one), prio (mean grade of its attack samples, null without), grade (S/A/B/C/F) }.
   * The per-unit pass (attack samples, fight-zone time) runs once, on first ask.
   */
  F.telemetry = function (C, e, t) {
    let T = C.telemetry.get(e.id);
    if (!T) {
      T = { atkT: [], eff: [], zones: [] };
      const list = C.per.get(e.id) || [];
      for (let k = 0; k < list.length; k += 2) {
        const i = idxAt(C.atkT, list[k]), p = C.atkP[i], g = F.effAt(C, i);
        for (let j = 0; j + 1 < p.length; j += 2) {
          if (p[j] !== e.id || p[j + 1] !== list[k + 1]) continue;
          if (g[j >> 1] === g[j >> 1]) { T.atkT.push(list[k]); T.eff.push(g[j >> 1]); }
          break;
        }
      }
      // time inside fight zones (1.5 × the fight radius, the fights' own pairing reach) while alive
      for (const f of C.fights) {
        const s = Math.max(f.start, e.spans[0]), en = Math.min(f.end, e.spans[e.spans.length - 1]);
        if (en <= s) continue;
        let inside = 0;
        for (let ts = s; ts < en; ts += SAMPLE) { if (!alive(e, ts)) continue; const L = locate(e, ts); if (Math.hypot(L.x - f.x, L.z - f.z) <= f.radius * 1.5) inside++; }
        if (inside) T.zones.push([s, en, inside * SAMPLE]);
      }
      C.telemetry.set(e.id, T);
    }
    const r = C.dealt.get(e.id);
    let dealt = 0;
    if (r) for (let i = 0; i < r.t.length && r.t[i] <= t; i++) dealt += r.v[i];
    let taken = 0;
    const own = C.dmgOf.get(e.id);
    if (own) for (const k of own) { if (C.dmgT[k] > t) break; taken += C.dmgAmt[k]; }
    let kills = 0;
    for (const k of C.kills) { if (k.t > t) break; if (k.killer === e.id) kills++; }
    let attacking = 0, prio = 0, np = 0;
    for (let i = 0; i < T.atkT.length && T.atkT[i] <= t; i++) { attacking += SAMPLE; prio += T.eff[i]; np++; }
    let zone = 0;
    for (const [s, en, secs] of T.zones) if (s <= t) zone += t >= en ? secs : (secs * (t - s)) / (en - s);
    const p = np ? prio / np : null;
    return { dealt, taken, kills, uptime: zone > 0 ? Math.min(1, attacking / zone) : null, prio: p, grade: F.letter(p) };
  };

  // ── the FrameRenderState controller ──
  const pool = (make) => ({ items: [], n: 0, make, take() { const it = this.items[this.n] || (this.items[this.n] = make()); this.n++; return it; } });
  /**
   * The per-viewer FrameRenderState: selection and hover (written by the viewer's input handling) and frame(t), which
   * refills the five lists from C for time t from the recorded tracks alone (no viewer frame facts), so the 2D and 3D
   * states at one t are equal. The lists are pooled: read them until the next frame call, do not keep their items.
   */
  F.controller = function (C) {
    const proj = pool(() => ({ id: 0, attackerId: 0, targetId: 0, origin: { x: 0, z: 0 }, target: { x: 0, z: 0 }, t0: 0, t1: 0, progress: 0,
      splashRadii: null, damageType: "pierce", miss: false, guess: false, torch: false, shot: null }));
    const heals = pool(() => ({ healerId: 0, targetId: 0, healRatePerSec: 0, t0: 0, t1: 0, heal: null }));
    const nums = pool(() => ({ id: 0, unitId: 0, worldPos: { x: 0, z: 0 }, amount: 0, damageType: "melee", bonus: false, splash: false, timestamp: 0 }));
    const lines = pool(() => ({ unitId: 0, targetId: 0, efficiencyScore: 1, grade: "good" }));
    const hits = pool(() => ({ id: 0, attackerId: 0, x: 0, z: 0, t1: 0, splashRadii: null, victims: null, shot: null }));
    const S = {
      t: 0, selectedUnitIds: new Set(), hoveredUnitId: null,
      activeProjectiles: [], activeHeals: [], floatingDamageEvents: [], activeEngagementLines: [], activeImpacts: [],
      combat: C,
      /** mode: "set" (replace), "add", "remove", "toggle". */
      select(ids, mode = "set") {
        const sel = S.selectedUnitIds;
        if (mode === "set") sel.clear();
        for (const id of ids) {
          if (mode === "remove" || (mode === "toggle" && sel.has(id))) sel.delete(id); else sel.add(id);
        }
      },
      frame(t) {
        S.t = t;
        proj.n = heals.n = nums.n = lines.n = hits.n = 0;
        for (let i = idxAt(C.shotT, t); i >= 0 && t - C.shotT[i] < MAX_FLIGHT + IMPACT_SHOW; i--) {
          const s = C.shots[i];
          if (t > s.t1) { // landed: a splash shot's rings show for IMPACT_SHOW s
            if (!s.splash || t - s.t1 >= IMPACT_SHOW) continue;
            const r = hits.take(), lb = locate(s.b, s.t1);
            r.id = i; r.attackerId = s.a.id; r.x = lb.x; r.z = lb.z; r.t1 = s.t1;
            r.splashRadii = s.splash.bands; r.victims = s.splash.victims; r.shot = s;
            continue;
          }
          if (t - s.t0 >= MAX_FLIGHT) continue;
          const p = proj.take();
          p.id = i; p.attackerId = s.a.id; p.targetId = s.b.id; p.t0 = s.t0; p.t1 = s.t1;
          const la = locate(s.a, s.t0); p.origin.x = la.x; p.origin.z = la.z;
          const lb = locate(s.b, s.t1); p.target.x = lb.x; p.target.z = lb.z;
          p.progress = (t - s.t0) / (s.t1 - s.t0);
          p.splashRadii = s.splash ? s.splash.bands : null;
          p.damageType = s.dtype; p.miss = s.miss; p.guess = s.guess; p.torch = s.torch; p.shot = s;
        }
        for (let i = idxAt(C.healT, t); i >= 0 && t - C.healT[i] <= C.healMax + SAMPLE; i--) {
          const h = C.heals[i];
          if (t > h.t1 + SAMPLE || !alive(h.healer, t) || !alive(h.target, t)) continue;
          const r = heals.take();
          r.healerId = h.healer.id; r.targetId = h.target.id; r.healRatePerSec = h.rate; r.t0 = h.t0; r.t1 = h.t1; r.heal = h;
        }
        for (let i = idxAt(C.dmgT, t); i >= 0 && t - C.dmgT[i] < DMG_SHOW; i--) {
          const e = C.byId.get(C.dmgId[i]), r = nums.take(), L = locate(e, C.dmgT[i]);
          r.id = i; r.unitId = e.id; r.worldPos.x = L.x; r.worldPos.z = L.z; r.amount = C.dmgAmt[i];
          r.damageType = C.dmgType[i]; r.bonus = !!C.dmgBonus[i]; r.splash = !!C.dmgSplash[i]; r.timestamp = C.dmgT[i];
        }
        const ai = idxAt(C.atkT, t);
        if (ai >= 0 && t - C.atkT[ai] <= LINE_HOLD) {
          const p = C.atkP[ai], g = F.effAt(C, ai);
          for (let k = 0; k + 1 < p.length; k += 2) {
            if (g[k >> 1] !== g[k >> 1] || !alive(C.byId.get(p[k]), t) || !alive(C.byId.get(p[k + 1]), t)) continue;
            const r = lines.take();
            r.unitId = p[k]; r.targetId = p[k + 1];
            r.efficiencyScore = g[k >> 1];
            r.grade = F.gradeOf(r.efficiencyScore);
          }
        }
        fill(S.activeProjectiles, proj); fill(S.activeHeals, heals); fill(S.floatingDamageEvents, nums); fill(S.activeEngagementLines, lines);
        fill(S.activeImpacts, hits);
        return S;
      },
    };
    return S;
  };
  function fill(arr, p) { arr.length = p.n; for (let i = 0; i < p.n; i++) arr[i] = p.items[i]; }
})();
