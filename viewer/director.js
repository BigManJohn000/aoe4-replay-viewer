"use strict";
// director.js: "Follow the action", the observer camera both viewers share. No DOM; runs after model.js (RV.idxAt,
// RV.alive, RV.cameraAt, RV.viewFootprint) on the shared model M (RV.prepare: M.byId hp/position tracks, M.kills,
// M.atkT/atkP, M.cameras, M.fights).
//
// RV.director(M) → { shot(t), cut() }. shot(t) = { x, z, pts, scene, label, fight } | null is what a caster would show at
// replay time t: pts the flat [x0, z0, x1, z1, …] ground points to keep on screen, x, z the middle of their box, scene a
// number that changes when the director cuts to another place. The viewers fit their camera to pts (dead zone, slow zoom
// in, quick zoom out) and cut instead of panning when the new scene is far. The viewers call cut() on every seek: the next
// shot picks afresh.
//   1. Interest comes from damage, not kills: every recorded HP drop is worth the victim's value (at least MIN_VALUE,
//      villagers, siege and buildings weighted up) × the share of its max HP lost; a kill adds KILL_W × the value. An
//      event counts fully from SURE s ahead of t (the replay knows what comes, so the camera gets there as the armies
//      meet) fading to 0 at AHEAD s ahead, and fades out over BACK s after it happened.
//   2. Scenes: the events are summed in CELL m cells, a place's interest is everything within SCENE_R of it, times
//      1 + CAM_BONUS for each player whose own recorded camera looks within CAM_R (a weak hint of what matters).
//   3. Choosing (every PICK s of replay time): the hottest place. The current scene is kept for DWELL s; then another
//      place takes over when it is SWITCH_HI times hotter, a bar that falls to SWITCH_LO over DECAY s. A scene where
//      nothing is happening any more gives way at once to any place with damage.
//   4. Tracking: the scene follows the units hit near it (their mean position now), and pts holds them, their attackers
//      within FRAME_R (M.atkP) and where all of them will be LEAD s from now, so a chase stays in frame.
(function (RV) {
  const BACK = 4, SURE = 2, AHEAD = 6;
  const SKIP = new Set(["livestock", "attachment", "other"]);
  const MIN_VALUE = 25, KILL_W = 0.5, CAT_W = { villager: 1.5, siege: 1.3, building: 1.3 };
  const CELL = 20, SCENE_R = 40, CAM_R = 50, CAM_BONUS = 0.25;
  const PICK = 0.5, DWELL = 4, SWITCH_HI = 1.5, SWITCH_LO = 1.2, DECAY = 8;
  const TRACK_R = 60, FRAME_R = 90, LEAD = 2;

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

  // How much an event dt s from now counts (dt < 0: in the past).
  const timeWeight = dt => (dt < 0 ? Math.max(0, 1 + dt / BACK) : dt <= SURE ? 1 : Math.max(0, 1 - (dt - SURE) / (AHEAD - SURE)));

  // How both viewers frame a shot (map.js chase, viewer3d updateCamera): pts fill the screen but margin of each side;
  // the camera stays put while the shot's centre is within dead × the view's half-size of the screen centre and eases
  // toward it at pan /s beyond that; zoom starts once it is off by zoomBand (log scale) and eases at zoomIn /s
  // inward, zoomOut /s outward (units leaving the frame matter more than empty space). A new scene more than a screen
  // away is a cut: the camera jumps there.
  RV.SHOT_FRAMING = { margin: 0.15, dead: 0.12, pan: 2.5, zoomBand: 0.1, zoomIn: 1.2, zoomOut: 4, minHalf: 20 };

  // Half extents of shot s's points around (s.x, s.z) along the unit ground axes a and b (the screen's right and up),
  // at least minHalf each; null when the shot has no points (the viewer keeps its zoom).
  RV.shotExtent = function (s, ax, az, bx, bz) {
    if (!s.pts.length) return null;
    let ha = RV.SHOT_FRAMING.minHalf, hb = ha;
    for (let i = 0; i < s.pts.length; i += 2) {
      const dx = s.pts[i] - s.x, dz = s.pts[i + 1] - s.z;
      ha = Math.max(ha, Math.abs(dx * ax + dz * az));
      hb = Math.max(hb, Math.abs(dx * bx + dz * bz));
    }
    return [ha, hb];
  };

  RV.director = function (M) {
    const worth = e => Math.max(MIN_VALUE, e.value || 0) * (CAT_W[e.cat] || 1);
    const ev = []; // { t, x, z, w, id }
    for (const e of M.byId.values()) {
      if (!e.hp || !e.t || e.t.length < 2 || SKIP.has(e.cat)) continue;
      let max = e.maxhp || 0;
      if (!max) for (const h of e.hp) max = Math.max(max, h);
      if (!(max > 0)) continue;
      const w = worth(e);
      for (let i = 1; i < e.hp.length; i++) {
        const drop = e.hp[i - 1] - e.hp[i];
        if (drop > 0) ev.push({ t: e.t[i], x: e.x[i], z: e.z[i], w: w * Math.min(1, drop / max), id: e.id });
      }
    }
    for (const k of M.kills || []) {
      const e = M.byId.get(k.victim);
      if (!e || !e.t || !e.t.length || SKIP.has(e.cat)) continue;
      const [x, z] = posAt(e, k.t);
      ev.push({ t: k.t, x, z, w: worth(e) * KILL_W, id: e.id });
    }
    ev.sort((a, b) => a.t - b.t);
    const evT = Float64Array.from(ev, e => e.t);
    const atkT = M.atkT || new Float64Array(0), atkP = M.atkP || [];
    const cams = M.cameras ? [...M.cameras.values()] : [];

    // Where each player's own camera looks at t.
    function camCentres(t) {
      const out = [];
      for (const cam of cams) {
        const c = RV.cameraAt(cam, t);
        if (c) out.push(RV.viewFootprint(c, M.terrain).centre);
      }
      return out;
    }
    const bonus = (x, z, looks) => 1 + CAM_BONUS * looks.filter(([cx, cz]) => Math.hypot(cx - x, cz - z) <= CAM_R).length;

    // The window of events that count at t: [lo, hi].
    const windowAt = t => [RV.idxAt(evT, t - BACK) + 1, RV.idxAt(evT, t + AHEAD)];

    function interest(x, z, t, lo, hi) {
      let s = 0;
      for (let i = lo; i <= hi; i++) {
        const e = ev[i];
        if (Math.hypot(e.x - x, e.z - z) <= SCENE_R) s += e.w * timeWeight(e.t - t);
      }
      return s;
    }

    // The hottest place at t: { x, z, heat } (its interest with the camera bonus), or null when nothing happens.
    function hottest(t, lo, hi, looks) {
      const cells = new Map();
      for (let i = lo; i <= hi; i++) {
        const e = ev[i], w = e.w * timeWeight(e.t - t);
        if (w <= 0) continue;
        const key = `${Math.floor(e.x / CELL)},${Math.floor(e.z / CELL)}`;
        const c = cells.get(key);
        if (c) { c.w += w; c.x += w * e.x; c.z += w * e.z; } else cells.set(key, { w, x: w * e.x, z: w * e.z });
      }
      const list = [...cells.values()].map(c => ({ w: c.w, x: c.x / c.w, z: c.z / c.w }));
      let best = null;
      for (const c of list) {
        let w = 0, x = 0, z = 0;
        for (const d of list) {
          if (Math.hypot(d.x - c.x, d.z - c.z) > SCENE_R) continue;
          w += d.w; x += d.w * d.x; z += d.w * d.z;
        }
        const heat = w * bonus(c.x, c.z, looks);
        if (!best || heat > best.heat) best = { x: x / w, z: z / w, heat };
      }
      return best;
    }

    let scene = null, seq = 0, fresh = true, pickT = NaN;
    const start = (p, t) => { scene = { x: p.x, z: p.z, id: ++seq, since: t }; };

    function choose(t, lo, hi) {
      const looks = camCentres(t), best = hottest(t, lo, hi, looks);
      if (!best) return;
      if (fresh || !scene) { start(best, t); return; }
      if (Math.hypot(best.x - scene.x, best.z - scene.z) <= SCENE_R) return;
      const cur = interest(scene.x, scene.z, t, lo, hi) * bonus(scene.x, scene.z, looks);
      const held = t - scene.since;
      const need = held < DWELL ? Infinity : SWITCH_HI - (SWITCH_HI - SWITCH_LO) * Math.min(1, (held - DWELL) / DECAY);
      if (cur <= 0 || best.heat > need * cur) start(best, t);
    }

    // Follow the scene's units; the shot frames them, their attackers and where they are headed.
    function track(t, lo, hi) {
      const hit = new Set();
      for (let i = lo; i <= hi; i++) {
        const e = ev[i];
        if (Math.hypot(e.x - scene.x, e.z - scene.z) <= TRACK_R) hit.add(e.id);
      }
      const by = new Set();
      for (let i = RV.idxAt(atkT, t - BACK) + 1, end = RV.idxAt(atkT, t + AHEAD); i <= end; i++) {
        const p = atkP[i];
        for (let k = 0; k + 1 < p.length; k += 2) if (hit.has(p[k + 1]) && !hit.has(p[k])) by.add(p[k]);
      }
      const pts = [];
      let n = 0, sx = 0, sz = 0;
      const add = (e, victim) => {
        if (!RV.alive(e, t)) return;
        const [x, z] = posAt(e, t);
        if (Math.hypot(x - scene.x, z - scene.z) > FRAME_R) return;
        pts.push(x, z);
        if (victim) { sx += x; sz += z; n++; }
        if (RV.alive(e, t + LEAD)) {
          const [fx, fz] = posAt(e, t + LEAD);
          if (Math.hypot(fx - scene.x, fz - scene.z) <= FRAME_R) pts.push(fx, fz);
        }
      };
      for (const id of hit) { const e = M.byId.get(id); if (e) add(e, true); }
      for (const id of by) { const e = M.byId.get(id); if (e && e.t && e.t.length) add(e, false); }
      if (n) { scene.x = sx / n; scene.z = sz / n; }
      return pts;
    }

    function shot(t) {
      const [lo, hi] = windowAt(t);
      if (fresh || !(Math.abs(t - pickT) < PICK)) { choose(t, lo, hi); pickT = t; fresh = false; }
      if (!scene) return null;
      const pts = track(t, lo, hi);
      let x = scene.x, z = scene.z;
      if (pts.length) {
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (let i = 0; i < pts.length; i += 2) {
          x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); z0 = Math.min(z0, pts[i + 1]); z1 = Math.max(z1, pts[i + 1]);
        }
        x = (x0 + x1) / 2; z = (z0 + z1) / 2;
      }
      const fight = (M.fights || []).find(f => t >= f.start - RV.FIGHT_LEAD && t <= f.end + BACK
        && Math.hypot(f.x - scene.x, f.z - scene.z) <= f.radius + 30) || null;
      return { x, z, pts, scene: scene.id, label: fight ? `Fight ${fight.id}` : "Skirmish", fight };
    }

    return { shot, cut() { fresh = true; } };
  };
})(window.RV);
