// Combat effects shared by the 2D and 3D viewers (window.RV_FX): the look of floating damage numbers, projectiles,
// siege muzzle flashes, splash rings and heals as plain functions of the frame state (frame.js controller) and t, so
// both viewers animate the same thing at the same moment. draw2d paints them on the 2D map; the 3D viewer
// (viewer3d/fx3d.js) builds pooled meshes from the same numbers.
(function () {
  "use strict";
  const X = (window.RV_FX = {});

  // Damage number colours by type: red melee, orange pierce, gold siege, purple when bonus damage was in the hit.
  X.DMG_COLOR = { melee: "#ef4444", pierce: "#fb923c", siege: "#facc15", fire: "#fdba74", other: "#e5e7eb", bonus: "#c084fc" };
  X.dmgColor = (n) => (n.bonus ? X.DMG_COLOR.bonus : X.DMG_COLOR[n.damageType] || X.DMG_COLOR.other);
  X.DMG_LIFE = window.RV_FRAME.DMG_SHOW; // s (0.6): the number drifts up and fades over it
  X.DMG_RISE = 1.6;   // world m (3D) a number climbs over its life; 2D uses DMG_RISE_PX
  X.DMG_RISE_PX = 20;
  // The anim helpers below return one reused object per helper (no per-frame allocation): read it before calling the
  // same helper again.
  const DA = { k: 0, rise: 0, alpha: 0 }, IA = { k: 0, alpha: 0 }, MA = { k: 0, alpha: 0 }, HP = { dx: 0, dz: 0, k: 0, alpha: 0 };
  /** Age-normalised animation of a damage number: { k 0..1, rise 0..1 (ease-out), alpha }. */
  X.dmgAnim = function (n, t) {
    const k = Math.max(0, Math.min(1, (t - n.timestamp) / X.DMG_LIFE));
    DA.k = k; DA.rise = 1 - (1 - k) * (1 - k); DA.alpha = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
    return DA;
  };
  const TEXT = new Map(); // tenths of a damage amount → its label, so steady frames build no strings
  X.dmgText = (n) => {
    const key = n.amount >= 10 ? Math.round(n.amount) * 10 : Math.round(n.amount * 10);
    let s = TEXT.get(key);
    if (s === undefined) TEXT.set(key, (s = String(key / 10)));
    return s;
  };

  X.SPLASH_COLOR = ["#ef4444", "#fb923c", "#facc15"]; // 100%, 50%, 25% bands (the last is dashed)
  X.IMPACT_LIFE = window.RV_FRAME.IMPACT_SHOW; // s a splash ring set shows after landing (frame.js activeImpacts)
  X.MUZZLE_LIFE = 0.25; // s a siege muzzle flash shows after the shot leaves
  X.HEAL_COLOR = "#34d399";
  X.HEAL_PERIOD = 0.9;  // s a heal particle takes to rise; the ring pulses with it
  X.HEAL_PARTICLES = 4;

  /** Arc height (world m) of a projectile of type ty flying dist m: siege lobs, arrows fly nearly flat. */
  X.arcHeight = (ty, dist) => (ty === "siege" ? Math.min(14, 0.3 * dist) : Math.min(3, 0.08 * dist));
  /** Height above the straight line at progress k (0..1) for an arc of height h. */
  X.arcAt = (h, k) => 4 * h * k * (1 - k);

  /** Splash ring state at t for an impact at t1: { k 0..1 grow, alpha } or null outside its life. */
  X.impactAnim = function (t1, t) {
    const age = t - t1;
    if (age < 0 || age >= X.IMPACT_LIFE) return null;
    IA.k = Math.min(1, age / 0.15); IA.alpha = 1 - age / X.IMPACT_LIFE;
    return IA;
  };
  /** Muzzle flash at t for a shot fired at t0: { k 0..1, alpha } or null. */
  X.muzzleAnim = function (t0, t) {
    const age = t - t0;
    if (age < 0 || age >= X.MUZZLE_LIFE) return null;
    MA.k = age / X.MUZZLE_LIFE; MA.alpha = 1 - MA.k;
    return MA;
  };
  const frac = (v) => v - Math.floor(v);
  const hash = (n) => frac(Math.sin(n * 127.1 + 311.7) * 43758.5453);
  /** Heal particle i (of HEAL_PARTICLES) around target id at t: { dx, dz -1..1 offsets, k 0..1 rise, alpha }. */
  X.healParticle = function (id, i, t) {
    const k = frac(t / X.HEAL_PERIOD + i / X.HEAL_PARTICLES + hash(id % 9973));
    const a = (hash(id % 7919 + i * 13.7) + i / X.HEAL_PARTICLES) * Math.PI * 2;
    HP.dx = Math.cos(a); HP.dz = Math.sin(a); HP.k = k; HP.alpha = k < 0.2 ? k / 0.2 : 1 - (k - 0.2) / 0.8;
    return HP;
  };
  /** Pulse 0..1 of the heal ring at t. */
  X.healPulse = (t) => 0.5 + 0.5 * Math.sin((t / X.HEAL_PERIOD) * Math.PI * 2);

  const tau = Math.PI * 2;
  function alpha(hex, a) {
    const v = parseInt(hex.slice(1), 16);
    return `rgba(${v >> 16},${(v >> 8) & 255},${v & 255},${Math.max(0, Math.min(1, a))})`;
  }

  /**
   * Paints this frame's combat effects on the 2D map (RV.MapView `map`) from M.view after map.draw ran V.frame(t):
   * projectiles (siege on an arc, with a muzzle flash), splash rings, heals and floating damage numbers. Shown when
   * either end is visible under the Vision mask.
   */
  X.draw2d = function (map, t, mask) {
    const g = map.g, M = map.M, V = M.view, k = map.scale;
    const vis = (e) => e && e.on && RV.visibleTo(e, t, mask);
    g.save();
    // heals: tether, pulsing ring and rising "+" around the target
    for (const h of V.activeHeals) {
      const a = M.byId.get(h.healerId), b = M.byId.get(h.targetId);
      if (!a || !b || !a.on || !b.on || (!vis(a) && !vis(b))) continue;
      const ax = map.sx(a.px, a.pz), ay = map.sy(a.px, a.pz), bx = map.sx(b.px, b.pz), by = map.sy(b.px, b.pz);
      const r = map.unitRadius(b) * 1.5 + 3, pulse = X.healPulse(t);
      g.setLineDash([4, 3]); g.lineDashOffset = -t * 20;
      g.strokeStyle = alpha(X.HEAL_COLOR, 0.65); g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
      g.setLineDash([]);
      g.strokeStyle = alpha(X.HEAL_COLOR, 0.45 + 0.45 * pulse); g.lineWidth = 1.5 + pulse;
      g.beginPath(); g.arc(bx, by, r * (1 + 0.18 * pulse), 0, tau); g.stroke();
      g.fillStyle = X.HEAL_COLOR; g.font = "bold 11px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      for (let i = 0; i < X.HEAL_PARTICLES; i++) {
        const p = X.healParticle(b.id, i, t);
        g.globalAlpha = p.alpha;
        g.fillText("+", bx + p.dx * r * 0.8, by + p.dz * r * 0.4 - p.k * 16);
      }
      g.globalAlpha = 1;
    }
    // projectiles and muzzle flashes
    for (const p of V.activeProjectiles) {
      const a = M.byId.get(p.attackerId), b = M.byId.get(p.targetId);
      if (!vis(a) && !vis(b)) continue;
      const x0 = map.sx(p.origin.x, p.origin.z), y0 = map.sy(p.origin.x, p.origin.z);
      const x1 = map.sx(p.target.x, p.target.z), y1 = map.sy(p.target.x, p.target.z);
      const dist = Math.hypot(p.target.x - p.origin.x, p.target.z - p.origin.z), h = X.arcHeight(p.damageType, dist) * k;
      const q = Math.max(0, Math.min(1, p.progress)), q0 = Math.max(0, q - 0.08);
      const px = x0 + (x1 - x0) * q, py = y0 + (y1 - y0) * q - X.arcAt(h, q);
      const tx = x0 + (x1 - x0) * q0, ty = y0 + (y1 - y0) * q0 - X.arcAt(h, q0);
      const col = p.torch ? "#f97316" : p.damageType === "siege" ? "#facc15" : "#fde68a";
      g.globalAlpha = p.miss ? 0.45 : 0.95;
      if (p.damageType === "siege") {
        g.fillStyle = col; g.beginPath(); g.arc(px, py, Math.max(2, Math.min(5, 0.6 * k)), 0, tau); g.fill();
        g.strokeStyle = alpha(col, 0.4); g.lineWidth = 1; g.beginPath(); g.moveTo(tx, ty); g.lineTo(px, py); g.stroke();
        const mz = X.muzzleAnim(p.t0, t);
        if (mz) {
          g.globalAlpha = mz.alpha;
          g.strokeStyle = "#fde047"; g.lineWidth = 2;
          g.beginPath(); g.arc(x0, y0, 4 + mz.k * Math.max(8, 1.5 * k), 0, tau); g.stroke();
          g.fillStyle = alpha("#fff7d6", 0.8 * mz.alpha); g.beginPath(); g.arc(x0, y0, 3 + 2 * (1 - mz.k), 0, tau); g.fill();
        }
      } else {
        g.strokeStyle = col; g.lineWidth = 1.4;
        g.beginPath(); g.moveTo(tx, ty); g.lineTo(px, py); g.stroke();
      }
      g.globalAlpha = 1;
    }
    // splash rings at landed siege shots: red 100%, orange 50%, dashed yellow 25%
    for (const im of V.activeImpacts) {
      const an = X.impactAnim(im.t1, t);
      if (!an) continue;
      const x = map.sx(im.x, im.z), y = map.sy(im.x, im.z);
      for (let i = 0; i < im.splashRadii.length; i++) {
        const [r] = im.splashRadii[i];
        g.setLineDash(i === 2 ? [5, 4] : []);
        g.strokeStyle = alpha(X.SPLASH_COLOR[i] || X.SPLASH_COLOR[2], an.alpha * (i ? 0.85 : 1));
        g.lineWidth = i ? 1.5 : 2.5;
        g.beginPath(); g.arc(x, y, Math.max(3, r * k * an.k), 0, tau); g.stroke();
      }
      g.setLineDash([]);
    }
    // floating damage numbers
    g.font = "bold 12px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.lineJoin = "round";
    for (const n of V.floatingDamageEvents) {
      const e = M.byId.get(n.unitId);
      if (e && !RV.visibleTo(e, n.timestamp, mask)) continue;
      const an = X.dmgAnim(n, t), x = map.sx(n.worldPos.x, n.worldPos.z), y = map.sy(n.worldPos.x, n.worldPos.z) - 8 - an.rise * X.DMG_RISE_PX;
      const s = X.dmgText(n);
      g.globalAlpha = an.alpha;
      g.strokeStyle = "rgba(11,14,20,0.85)"; g.lineWidth = 3; g.strokeText(s, x, y);
      g.fillStyle = X.dmgColor(n); g.fillText(s, x, y);
    }
    g.globalAlpha = 1;
    g.restore();
  };
})();
