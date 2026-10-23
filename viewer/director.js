"use strict";
// director.js: "Follow the action", the observer camera both viewers share. No DOM; runs after model.js (RV.idxAt,
// RV.alive, RV.FIGHT_LEAD) on the shared model M (RV.prepare: M.fights from convert.py's detect_fights, M.kills, M.byId).
//
// RV.director(M) → { shot(t) } where shot(t) = { x, z, r, fight, label } | null is where a caster would look at replay
// time t: x, z the view centre and r the radius (world units) to keep in view; the viewers ease their camera toward it.
//   1. A fight is on from RV.FIGHT_LEAD s before its first blow (the camera arrives as the armies meet, like the fight
//      list's lead-in) until LINGER s after its last. Its heat now = 1 + the value of its kills in [t − HEAT_BACK,
//      t + HEAT_AHEAD] (a unit counts at least MIN_KILL, so cheap kills still register).
//   2. The shot stays on the current fight while it is on. It cuts to another fight only after DWELL s on this one
//      and when the other is SWITCH times hotter; after a seek (t jumped back, or more than SEEK s ahead) the hottest
//      fight on is picked at once.
//   3. The view centre is the middle of the fight's units still alive within REACH × radius of the fight's centre, so
//      the camera moves with a chase; r is their spread, between MIN_R and the fight's radius. No unit in reach: the
//      fight's centre and radius.
//   4. No fight on: the latest kill outside every fight in the last SKIRMISH s (a raid, a picked-off scout), with the
//      kills within SKIRMISH_R of it. Nothing at all: the last shot (the camera stays put), null before the first.
(function (RV) {
  const LINGER = 4, HEAT_BACK = 8, HEAT_AHEAD = 3, MIN_KILL = 10;
  const DWELL = 6, SWITCH = 1.5, SEEK = 30;
  const REACH = 1.5, MIN_R = 20;
  const SKIRMISH = 10, SKIRMISH_R = 40;

  // The recorded position at t (RV.locate's interpolation) without touching e.px/e.pz, which the frame owns.
  function posAt(e, t) {
    let i = RV.idxAt(e.t, t);
    if (i < 0) i = 0;
    let x = e.x[i], z = e.z[i];
    if (i + 1 < e.t.length) {
      const t1 = e.t[i + 1], ts = Math.max(e.t[i], t1 - 0.5);
      if (t > ts) {
        const a = (t - ts) / (t1 - ts);
        x += (e.x[i + 1] - x) * a;
        z += (e.z[i + 1] - z) * a;
      }
    }
    return [x, z];
  }

  RV.director = function (M) {
    const fights = M.fights || [];
    const units = fights.map(f => (f.units || []).map(id => M.byId.get(id)).filter(e => e && e.t && e.t.length));
    const kills = []; // { t, x, z, w, f: index into fights or -1 }
    for (const k of M.kills) {
      const e = M.byId.get(k.victim);
      if (!e || !e.t || !e.t.length || e.cat === "livestock" || e.cat === "attachment") continue;
      const [x, z] = posAt(e, k.t);
      const f = fights.findIndex(g => k.t >= g.start - 2 && k.t <= g.end + 2 && Math.hypot(x - g.x, z - g.z) <= REACH * g.radius);
      kills.push({ t: k.t, x, z, w: Math.max(MIN_KILL, e.value || 0), f });
    }
    const killT = Float64Array.from(kills, k => k.t);
    const on = (f, t) => t >= f.start - RV.FIGHT_LEAD && t <= f.end + LINGER;

    function heat(fi, t) {
      let h = 1;
      for (let i = RV.idxAt(killT, t + HEAT_AHEAD); i >= 0 && kills[i].t >= t - HEAT_BACK; i--) if (kills[i].f === fi) h += kills[i].w;
      return h;
    }

    function fightShot(fi, t) {
      const f = fights[fi], reach = REACH * f.radius;
      let n = 0, sx = 0, sz = 0;
      const pts = [];
      for (const e of units[fi]) {
        if (!RV.alive(e, t)) continue;
        const p = posAt(e, t);
        if (Math.hypot(p[0] - f.x, p[1] - f.z) > reach) continue;
        pts.push(p); sx += p[0]; sz += p[1]; n++;
      }
      const label = `Fight ${f.id}`;
      if (!n) return { x: f.x, z: f.z, r: Math.max(MIN_R, f.radius), fight: f, label };
      const x = sx / n, z = sz / n;
      let spread = 0;
      for (const p of pts) spread = Math.max(spread, Math.hypot(p[0] - x, p[1] - z));
      return { x, z, r: Math.min(Math.max(MIN_R, f.radius), Math.max(MIN_R, spread)), fight: f, label };
    }

    function skirmishShot(t) {
      let i = RV.idxAt(killT, t);
      while (i >= 0 && kills[i].t >= t - SKIRMISH && kills[i].f >= 0) i--;
      if (i < 0 || kills[i].t < t - SKIRMISH) return null;
      const last = kills[i];
      let n = 0, sx = 0, sz = 0;
      for (let j = i; j >= 0 && kills[j].t >= t - SKIRMISH; j--) {
        const k = kills[j];
        if (k.f >= 0 || Math.hypot(k.x - last.x, k.z - last.z) > SKIRMISH_R) continue;
        sx += k.x; sz += k.z; n++;
      }
      return { x: sx / n, z: sz / n, r: MIN_R + 5, fight: null, label: "Skirmish" };
    }

    let cur = -1, since = 0, lastT = NaN, held = null;
    function shot(t) {
      const seeked = !(t >= lastT - 1e-6 && t - lastT <= SEEK);
      lastT = t;
      if (seeked || (cur >= 0 && !on(fights[cur], t))) cur = -1;
      let best = cur, bestHeat = cur >= 0 ? heat(cur, t) : 0;
      if (cur < 0 || t - since >= DWELL) {
        const need = cur >= 0 ? bestHeat * SWITCH : 0;
        for (let i = 0; i < fights.length; i++) {
          if (i === cur || !on(fights[i], t)) continue;
          const h = heat(i, t);
          if (h > need && h > (best === cur ? need : bestHeat)) { best = i; bestHeat = h; }
        }
      }
      if (best !== cur) { cur = best; since = t; }
      const s = cur >= 0 ? fightShot(cur, t) : skirmishShot(t);
      if (s) held = s;
      return held;
    }

    return { shot };
  };
})(window.RV);
