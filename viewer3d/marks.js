/**
 * marks.js — the 2D viewer's lines and marks on the 3D ground (map.js drawOrders / drawTrail / drawCameras / drawAlerts /
 * drawSites / drawConversions), read from the 2D model (viewer/model.js, `RV.prepare` → M2: squads and their move
 * orders, alerts, sacred sites and their state, conversions and flips, player cameras) so both viewers show the same
 * facts. Entity positions and filters come from the 3D replay (core/replay.js: `on`, `px`, `pz`, `shown`), which shares
 * the 2D model's entity ids.
 *
 * Everything is one dynamic mesh of terrain-following ribbons and fans (Marks.batch): lines are drawn as ground quads
 * a constant number of screen pixels wide (like the 2D canvas strokes), rings and glows as annuli with per-vertex alpha
 * (the 2D radial gradients). Coordinates: replay (x, z); the mesh lives outside `world`, so z is negated.
 */
import * as THREE from 'three';
import { idxAt, visibleTo, TAU } from './core/replay.js';

// The 2D viewer's timings and sizes (map.js); the seconds are measured in game there, metres are scaled from its px.
const TRAIL_S = 6;       // seconds of path behind moving military units
const ORDER_FRESH = 8;   // seconds before a move-order line starts to fade
const ALERT_R = 12;      // metres: radius of an under-attack ring (the game's is ~7 px on its minimap, about 12 m)
const ALERT_PULSE = 2;   // seconds per swell of its glow
const SITE_FLASH = 5;    // seconds a sacred site flashes after a capture
const SITE_PULSE = 2.5;  // seconds per pulse while one team holds every site
const FLIP_FADE = 3;     // seconds the burst stays where a unit changed hands
const SITE_RING_R = 8.5; // metres: the site's ring (capturing units stand 4.5–8.1 m from its centre: model.js prepSite)
const FLIP_R0 = 1.5, FLIP_SPREAD = 5; // metres: a flip burst's start radius and how far it swells
const TRAIL_MIN = 2.5;   // metres a unit must have covered in TRAIL_S to get a trail (fighting jitter has none)
const LIFT = 0.35;       // metres above the ground (the fight rings' lift)
const MAX_QUADS = 40000;

const DARK = new THREE.Color('#0b0e14'), WHITE = new THREE.Color('#ffffff'), CREAM = new THREE.Color('#fef3c7');
const RED = new THREE.Color('#ef4444');

/** Terrain-following ribbons and fans in one buffer, rebuilt every frame (begin → primitives → end). */
class Batch {
  constructor(scene, heightAt) {
    this.heightAt = heightAt;
    this.pos = new Float32Array(MAX_QUADS * 12);
    this.col = new Float32Array(MAX_QUADS * 16);
    const idx = new Uint32Array(MAX_QUADS * 6);
    for (let i = 0; i < MAX_QUADS; i++) idx.set([4 * i, 4 * i + 1, 4 * i + 2, 4 * i + 1, 4 * i + 3, 4 * i + 2], 6 * i);
    const g = new THREE.BufferGeometry();
    this.pa = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.ca = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pa);
    g.setAttribute('color', this.ca);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    scene.add(this.mesh);
    this.n = 0;
    this.maxed = false;
  }

  begin() { this.n = 0; }

  end() {
    this.mesh.geometry.setDrawRange(0, this.n * 6);
    for (const [a, size] of [[this.pa, 12], [this.ca, 16]]) {
      a.clearUpdateRanges();
      if (this.n) { a.addUpdateRange(0, this.n * size); a.needsUpdate = true; }
    }
  }

  /** Quad (A0, A1, B0, B1) of ground points with their own alpha, all of colour c; false once the buffer is full. */
  quad(x0, z0, a0, x1, z1, a1, x2, z2, a2, x3, z3, a3, c) {
    if (this.n >= MAX_QUADS) return false;
    const p = this.n * 12, k = this.n * 16, h = this.heightAt;
    this.n++;
    const xs = [x0, x1, x2, x3], zs = [z0, z1, z2, z3], as = [a0, a1, a2, a3];
    for (let v = 0; v < 4; v++) {
      this.pos[p + 3 * v] = xs[v];
      this.pos[p + 3 * v + 1] = h(xs[v], zs[v]) + LIFT;
      this.pos[p + 3 * v + 2] = -zs[v];
      this.col[k + 4 * v] = c.r; this.col[k + 4 * v + 1] = c.g; this.col[k + 4 * v + 2] = c.b; this.col[k + 4 * v + 3] = as[v];
    }
    return true;
  }

  /** A straight ground stroke w metres wide. */
  ribbon(x0, z0, x1, z1, w, c, a) {
    const dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz);
    if (len < 1e-6) return;
    const nx = (-dz / len) * w / 2, nz = (dx / len) * w / 2;
    this.quad(x0 - nx, z0 - nz, a, x0 + nx, z0 + nz, a, x1 - nx, z1 - nz, a, x1 + nx, z1 + nz, a, c);
  }

  /** A stroke following the ground in steps of at most `seg` metres; dashed: every other step is drawn. */
  line(x0, z0, x1, z1, w, c, a, seg, dashed = false) {
    const len = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.ceil(len / seg));
    for (let i = 0; i < n; i += dashed ? 2 : 1) {
      const u0 = i / n, u1 = (i + 1) / n;
      this.ribbon(x0 + (x1 - x0) * u0, z0 + (z1 - z0) * u0, x0 + (x1 - x0) * u1, z0 + (z1 - z0) * u1, w, c, a);
    }
  }

  /** The ring sector between radii r0 and r1 from angle ang0 to ang1 (radians from +x), alpha al0 inside → al1 outside. */
  arc(x, z, r0, r1, ang0, ang1, c, al0, al1) {
    const segs = Math.max(2, Math.min(64, Math.ceil(((ang1 - ang0) / TAU) * Math.max(12, r1 * 3))));
    let px0 = 0, pz0 = 0, px1 = 0, pz1 = 0;
    for (let i = 0; i <= segs; i++) {
      const ang = ang0 + ((ang1 - ang0) * i) / segs, ca = Math.cos(ang), sa = Math.sin(ang);
      const ix = x + ca * r0, iz = z + sa * r0, ox = x + ca * r1, oz = z + sa * r1;
      if (i) this.quad(px0, pz0, al0, px1, pz1, al1, ix, iz, al0, ox, oz, al1, c);
      px0 = ix; pz0 = iz; px1 = ox; pz1 = oz;
    }
  }

  ring(x, z, r, w, c, a, ang0 = 0, ang1 = TAU) { this.arc(x, z, r - w / 2, r + w / 2, ang0, ang1, c, a, a); }

  /** `count` dashes round a ring, each covering `duty` of its period, the pattern turned by `phase` radians. */
  dashedRing(x, z, r, w, c, a, count, duty, phase) {
    const step = TAU / count;
    for (let k = 0; k < count; k++) this.ring(x, z, r, w, c, a, phase + k * step, phase + (k + duty) * step);
  }

  disc(x, z, r, c, aCentre, aEdge) { this.arc(x, z, 0, r, 0, TAU, c, aCentre, aEdge); }

  /** Triangle fan from (cx, cz) over the ground polygon `pts` ([x, z, …], closed), alpha a. */
  fan(cx, cz, pts, c, a) {
    for (let i = 0; i < pts.length; i += 2) {
      const j = (i + 2) % pts.length;
      this.quad(cx, cz, a, cx, cz, a, pts[i], pts[i + 1], a, pts[j], pts[j + 1], a, c);
    }
  }
}

export class Marks {
  /**
   * RV: the 2D viewer's model namespace (window.RV); M2 its prepared model of this replay; R the 3D replay; teamColor
   * (owner) → THREE.Color; opt: the overlay toggles (state.opt); vision: () => player bit mask in force (0: everyone).
   */
  constructor({ RV, M2, R, scene, camera, renderer, terrain, teamColor, opt, vision }) {
    Object.assign(this, { RV, M2, R, camera, renderer, terrain, teamColor, opt, vision });
    this.batch = new Batch(scene, (x, z) => terrain.heightAt(x, z));
    // squads with a recorded order, as 3D entities
    this.squads = [];
    for (const [sid, ms] of M2.squads) {
      if (!M2.orders.has(sid)) continue;
      const ents = ms.map((m) => R.byId.get(m.id)).filter(Boolean);
      if (ents.length) this.squads.push({ sid, ents });
    }
    this.army = R.ents.filter((e) => R.isMilitary(e.cat));
    this.flipT = Float64Array.from(M2.flips, (f) => f.t);
    this.vp = new THREE.Matrix4();
    this.k = 0;
    this.nx = 0; this.ny = 0;
  }

  /** Clip-space position of ground point (x, y, z): sets nx/ny (NDC) and returns the view depth (≤ 0: behind the camera). */
  clip(x, y, z) {
    const e = this.vp.elements, zz = -z;
    const w = e[3] * x + e[7] * y + e[11] * zz + e[15];
    this.nx = (e[0] * x + e[4] * y + e[8] * zz + e[12]) / w;
    this.ny = (e[1] * x + e[5] * y + e[9] * zz + e[13]) / w;
    return w;
  }

  /** World metres per CSS pixel at ground point (x, z), for strokes of a constant screen width. */
  wpp(x, z) { return Math.max(0.1, this.clip(x, this.terrain.heightAt(x, z), z)) * this.k; }

  /** Whether (x, z) lies within the view, with `margin` (1 = exactly the screen) of slack. */
  onScreen(x, z, margin = 1.25) {
    const w = this.clip(x, this.terrain.heightAt(x, z), z);
    return w > 0 && Math.abs(this.nx) < margin && Math.abs(this.ny) < margin;
  }

  update(t) {
    const { camera, renderer, opt, batch } = this;
    this.vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.k = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / renderer.domElement.clientHeight;
    const vis = this.vision(), mask = vis || this.R.allMask;
    this.see = (e) => !vis || visibleTo(e, t, vis); // e: a 3D entity
    batch.begin();
    if (opt.cams) this.cameras(t, mask);
    if (opt.orders) this.orders(t);
    if (opt.trails) this.trails(t);
    if (opt.attacks) this.alerts(t, mask);
    if (opt.gaia && this.M2.sites.length) this.sites(t, mask);
    this.conversions(t, mask);
    batch.end();
  }

  color(owner) { return this.teamColor(this.R, owner); }

  /** The ground each player's screen showed (the replay's camera records), outlined in the player's colour. */
  cameras(t, mask) {
    const { RV, M2, batch: b } = this;
    for (const [idx, cam] of M2.cameras) {
      if (!(mask & (1 << (idx - 1)))) continue;
      const c = RV.cameraAt(cam, t);
      if (!c) continue;
      const { corners, centre } = RV.viewFootprint(c, M2.terrain), col = this.color(idx);
      const wp = this.wpp(centre[0], centre[1]);
      const edge = [];
      corners.forEach(([x, z], i) => {
        const [x1, z1] = corners[(i + 1) % 4], n = Math.max(1, Math.ceil(Math.hypot(x1 - x, z1 - z) / 8));
        for (let s = 0; s < n; s++) edge.push(x + ((x1 - x) * s) / n, z + ((z1 - z) * s) / n);
      });
      b.fan(centre[0], centre[1], edge, col, 0.06);
      for (let i = 0; i < edge.length; i += 2) {
        const j = (i + 2) % edge.length;
        b.ribbon(edge[i], edge[i + 1], edge[j], edge[j + 1], 1.5 * wp, col, 0.85);
      }
      b.disc(centre[0], centre[1], 3 * wp, col, 0.85, 0.85);
    }
  }

  /**
   * Dashed line from each squad to its current move target, ending in a small target ring (military only, one per spot).
   * Hidden once the squad is there; orders older than ORDER_FRESH seconds fade to a quarter. Eco (villager) orders only
   * with opt.ecoOrders.
   */
  orders(t) {
    const { RV, M2, R, batch: b } = this, marks = new Set();
    for (const { sid, ents } of this.squads) {
      let lead = null;
      for (const e of ents) if (e.on && e.shown) { lead = e; break; }
      if (!lead || !RV.isUnit(lead.cat) || lead.cat === 'livestock') continue;
      const o = RV.orderAt(M2, sid, t);
      if (!o) continue;
      const military = R.isMilitary(lead.cat);
      if (!military && !this.opt.ecoOrders) continue;
      if (!this.onScreen(lead.px, lead.pz) && !this.onScreen(o.x, o.z)) continue;
      const wp = this.wpp(lead.px, lead.pz);
      if (Math.abs(o.x - lead.px) + Math.abs(o.z - lead.pz) < 8 * wp) continue;
      const age = t - o.since, fade = age > ORDER_FRESH ? Math.max(0.3, 1 - (age - ORDER_FRESH) / 12) : 1;
      const col = this.color(lead.pown), a = (military ? 0.55 : 0.25) * fade;
      b.line(lead.px, lead.pz, o.x, o.z, 1.5 * wp, col, a, THREE.MathUtils.clamp(4 * wp, 1.2, 6), true);
      const spot = `${Math.round(o.x / (12 * wp))},${Math.round(o.z / (12 * wp))}`;
      if (!military || marks.has(spot)) continue;
      marks.add(spot);
      b.ring(o.x, o.z, Math.max(0.6, 4 * wp), 1.5 * wp, col, a);
      b.disc(o.x, o.z, 1.2 * wp, col, a, a);
    }
  }

  /** Path over the last TRAIL_S seconds behind moving military units, skipped for units that stayed in place. */
  trails(t) {
    const b = this.batch;
    for (const e of this.army) {
      if (!e.on || !e.shown) continue;
      const i1 = idxAt(e.t, t);
      if (i1 < 1) continue;
      const i0 = Math.max(0, idxAt(e.t, t - TRAIL_S));
      if (Math.hypot(e.px - e.x[i0], e.pz - e.z[i0]) < TRAIL_MIN || !this.onScreen(e.px, e.pz)) continue;
      const col = this.color(e.pown), w = 1.5 * this.wpp(e.px, e.pz);
      let x = e.x[i0], z = e.z[i0];
      for (let i = i0 + 1; i <= i1; i++) { b.ribbon(x, z, e.x[i], e.z[i], w, col, 0.25); x = e.x[i]; z = e.z[i]; }
      b.ribbon(x, z, e.px, e.pz, w, col, 0.25);
    }
  }

  /**
   * Under-attack alerts (model.js prepAlerts) in the attacked player's colour, like the game's minimap: a ring with a
   * glow that swells to three times its size every ALERT_PULSE s, for RV.ALERT_S s. Shown for the players in the Vision
   * setting and their allies, as the game shows its viewer's and allies' alerts.
   */
  alerts(t, mask) {
    const { RV, M2, batch: b } = this;
    let teams = 0;
    for (const p of M2.d.players) if ((1 << (p.idx - 1)) & mask) teams |= M2.teamMask.get(p.team);
    for (let i = idxAt(M2.alertT, t); i >= 0 && t - M2.alertT[i] < RV.ALERT_S; i--) {
      const al = M2.alerts[i];
      if (!((1 << (al.owner - 1)) & teams) || !this.onScreen(al.x, al.z, 1.6)) continue;
      const col = this.R.players.has(al.owner) ? this.color(al.owner) : RED, wp = this.wpp(al.x, al.z);
      const age = t - al.t, fade = Math.min(1, RV.ALERT_S - age), p = (age % ALERT_PULSE) / ALERT_PULSE;
      const r = Math.max(ALERT_R, 9 * wp);
      b.disc(al.x, al.z, r * (1 + 2 * p), col, 0.45 * (1 - p) * fade, 0);
      b.ring(al.x, al.z, r, 4 * wp, DARK, 0.7 * fade);
      b.ring(al.x, al.z, r, 2 * wp, col, fade);
    }
  }

  /**
   * Sacred-site states, drawn like the game's minimap (measured on aoe4_256829909): SITE_FLASH s of a swelling cream glow
   * ringed in the new holder's colour after a capture; while religious units take a site (RV.siteState), a turning
   * dashed ring in their colour over a dark halo, plus a progress arc ours alone shows; and while one team holds every
   * site, all of them pulse in its colour.
   */
  sites(t, mask) {
    const { RV, M2, R, batch: b } = this;
    const color = (idx) => (R.players.has(idx) ? this.color(idx) : WHITE);
    const teamOf = (idx) => M2.playerByIdx.get(idx)?.team;
    for (const o of M2.sites) { // the frame facts RV.updateFrame keeps for them
      o.on = t >= o.spans[0];
      o.holder = o.held && RV.alive(o.held, t) ? RV.ownerAt(o.held, t) : 0;
    }
    const all = M2.sites.every((o) => o.holder && teamOf(o.holder) === teamOf(M2.sites[0].holder));
    const r = SITE_RING_R;
    for (const o of M2.sites) {
      if (!o.on || !this.onScreen(o.x, o.z, 1.6)) continue;
      const wp = this.wpp(o.x, o.z);
      if (all) {
        const p = (t % SITE_PULSE) / SITE_PULSE, rg = r * (1.2 + 1.3 * p), col = color(o.holder);
        b.arc(o.x, o.z, r * 0.8, rg, 0, TAU, col, 0.55 * (1 - p), 0);
      }
      const ci = idxAt(o.capT, t), cap = ci >= 0 ? o.caps[ci] : null;
      if (cap && t - cap.t < SITE_FLASH) {
        const age = t - cap.t, p = (age % 1.25) / 1.25, fade = Math.min(1, SITE_FLASH - age), rg = r * (1.1 + 1.6 * p);
        b.arc(o.x, o.z, r * 0.6, rg, 0, TAU, CREAM, 0.8 * fade, 0);
        b.ring(o.x, o.z, rg, 3 * wp, color(cap.owner), fade * (1 - p));
      }
      const s = RV.siteState(M2, o, t);
      if (!s || (!((1 << (s.capturer - 1)) & mask) && !this.see(R.byId.get(s.unit.id)))) continue;
      const col = color(s.capturer), rr = r * 1.45, halo = 0.35 + 0.25 * Math.sin((t / 1.5) * TAU);
      b.arc(o.x, o.z, rr * 0.5, rr * 1.2, 0, TAU, DARK, halo, 0);
      b.dashedRing(o.x, o.z, rr, 3.5 * wp, WHITE, 0.9, 8, 0.64, 0.6 * t);
      b.dashedRing(o.x, o.z, rr, 2 * wp, col, 1, 8, 0.64, 0.6 * t);
      // progress runs clockwise from north; +z is north (up-screen), so game angles from +x towards +z run anticlockwise:
      // the swept sector spans from (north − progress turns) up to north
      if (!s.contested) b.ring(o.x, o.z, rr + 4 * wp, 3 * wp, col, 1, Math.PI / 2 - s.progress * TAU, Math.PI / 2);
    }
  }

  /**
   * Conversions (model.js prepConversions), like the game's ring: while the monk channels, a white ring with tick marks
   * at RV.CONVERT_R around it over a glow in its colour, and a dashed ring in its colour around each target still its
   * own; then FLIP_FADE s of an expanding double ring in the new owner's colour wherever a unit changed hands.
   */
  conversions(t, mask) {
    const { RV, M2, R, batch: b } = this;
    for (const cv of M2.conversions) {
      if (cv.t > t) break;
      if (t >= cv.end) continue;
      const c = R.byId.get(cv.caster.id);
      if (!c || !c.on) continue;
      if (!((1 << (cv.owner - 1)) & mask) && !this.see(c)) continue;
      if (!this.onScreen(c.px, c.pz, 1.8)) continue;
      const col = this.color(cv.owner), r = RV.CONVERT_R, wp = this.wpp(c.px, c.pz), a = Math.min(1, (t - cv.t) / 0.3);
      b.arc(c.px, c.pz, r * 0.7, r * 0.985, 0, TAU, col, 0, 0.35 * a);
      b.arc(c.px, c.pz, r * 0.985, r * 1.08, 0, TAU, col, 0.35 * a, 0);
      b.ring(c.px, c.pz, r, 3.5 * wp, DARK, 0.6 * a);
      b.ring(c.px, c.pz, r, 1.5 * wp, WHITE, 0.95 * a);
      for (let i = 0; i < 48; i++) {
        const ang = (i / 48) * TAU, len = (i % 4 === 0 ? 0.16 : 0.08) * r, ca = Math.cos(ang), sa = Math.sin(ang);
        b.ribbon(c.px + ca * r, c.pz + sa * r, c.px + ca * (r + len), c.pz + sa * (r + len), 1.5 * wp, WHITE, 0.95 * a);
      }
      for (const { e, flip } of cv.targets) {
        if (!RV.alive(e, t) || (flip != null && flip <= t)) continue;
        const k = Math.max(0, idxAt(e.t, t));
        b.dashedRing(e.x[k], e.z[k], 1 + 3 * wp, 1.5 * wp, col, 1, 8, 0.6, 0);
      }
    }
    for (let i = idxAt(this.flipT, t); i >= 0 && t - this.flipT[i] < FLIP_FADE; i--) {
      const f = M2.flips[i], age = t - f.t;
      if (!RV.alive(f.e, t)) continue;
      const e = R.byId.get(f.e.id);
      if (!e || !(((1 << (f.to - 1)) | (1 << (f.from - 1))) & mask || this.see(e))) continue;
      const k = Math.max(0, idxAt(f.e.t, t)), x = f.e.x[k], z = f.e.z[k];
      if (!this.onScreen(x, z, 1.6)) continue;
      const col = R.players.has(f.to) ? this.color(f.to) : WHITE, al = 1 - age / FLIP_FADE, wp = this.wpp(x, z);
      for (const off of [0, 0.35]) {
        const p = (age / 1.2 + off) % 1;
        b.ring(x, z, FLIP_R0 + p * FLIP_SPREAD, 2.5 * wp, col, al * (1 - p));
      }
    }
  }
}
