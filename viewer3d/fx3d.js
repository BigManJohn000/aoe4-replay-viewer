/**
 * fx3d.js — the shared combat effects (viewer/fx.js, window.RV_FX) as pooled 3D geometry: floating damage numbers, siege
 * muzzle flashes, splash rings (the 25 % band dashed) and heals (tether, pulsing base ring, rising "+"). Like the 2D
 * viewer (RV_FX.draw2d) it is stateless: every frame it redraws from the FrameRenderState lists (viewer/frame.js
 * activeProjectiles, activeImpacts, activeHeals, floatingDamageEvents) and t, so both viewers show the same effects at
 * the same moment. Projectile flight itself stays in viewer.js (updateOverlays), which shares RV_FX.arcHeight / arcAt.
 *
 * Pooling: three fixed-capacity quad batches over ONE glyph/sprite atlas canvas (digits, soft glow, "+", beam, a solid
 * texel): no texture or mesh is created per effect, buffers are rewritten each frame and only the used range uploads.
 *   text  — damage numbers: camera-facing glyph quads, normal blend, drawn over everything
 *   rings — terrain-following ribbons (splash rings), normal blend
 *   glow  — additive: muzzle flash, heal ring / "+" / tether
 * Coordinates: replay (x, z); the meshes live outside `world`, so scene z = −z.
 */
import * as THREE from 'three';

const TAU = Math.PI * 2;
const GLYPHS = '0123456789.-';
const CELL = 64;            // atlas cell size (px)
const ATLAS_W = 1024, ATLAS_H = 128;
const MAX_NUMBERS = 256;    // damage numbers drawn at most
const MAX_GLYPHS = 8;       // characters per number
const LIFT = 0.35;          // m above the ground for rings (the fight rings' lift)
const RING_QUADS = 14000, GLOW_QUADS = 10000;
const MUZZLE = new THREE.Color('#fde047'), MUZZLE_CORE = new THREE.Color('#ffe98a'), WHITE = new THREE.Color('#ffffff');
const frac = (v) => v - Math.floor(v);
const hash1 = (n) => frac(Math.sin(n * 127.1 + 311.7) * 43758.5453);

/** The one texture every batch samples: outlined white digits (tinted by vertex colour), then sprite cells. */
function buildAtlas() {
  const cv = document.createElement('canvas');
  cv.width = ATLAS_W; cv.height = ATLAS_H;
  const g = cv.getContext('2d');
  const uv = (x, y, w, h, inset = 1) => ({
    u0: (x + inset) / ATLAS_W, u1: (x + w - inset) / ATLAS_W,
    v0: 1 - (y + h - inset) / ATLAS_H, v1: 1 - (y + inset) / ATLAS_H,
  });
  g.font = 'bold 46px "Segoe UI", system-ui, Arial, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
  const glyph = {}; // char → { w (cell px), adv (advance px), uv }
  let x = 0;
  for (const ch of GLYPHS) {
    const adv = g.measureText(ch).width, w = Math.ceil(adv) + 12;
    g.strokeStyle = 'rgba(11,14,20,0.92)'; g.lineWidth = 8; g.strokeText(ch, x + w / 2, CELL / 2 + 2);
    g.fillStyle = '#ffffff'; g.fillText(ch, x + w / 2, CELL / 2 + 2);
    glyph[ch] = { w, adv: adv + 2, uv: uv(x, 0, w, CELL, 0) };
    x += w;
  }
  const y = CELL;
  g.fillStyle = '#ffffff'; g.fillRect(8, y + 8, 48, 48); // solid: flat colour for the ribbons
  const rg = g.createRadialGradient(96, y + 32, 0, 96, y + 32, 32); // glow: soft round flash
  rg.addColorStop(0, 'rgba(255,255,255,1)'); rg.addColorStop(0.3, 'rgba(255,255,255,0.55)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = rg; g.fillRect(64, y, CELL, CELL);
  g.save(); g.shadowColor = '#ffffff'; g.shadowBlur = 7; g.fillStyle = '#ffffff'; // plus: the heal "+"
  g.fillRect(128 + 25, y + 10, 14, 44); g.fillRect(128 + 10, y + 25, 44, 14);
  g.restore();
  const lg = g.createLinearGradient(0, y, 0, y + CELL); // beam: bright across its middle, soft edges
  lg.addColorStop(0, 'rgba(255,255,255,0)'); lg.addColorStop(0.5, 'rgba(255,255,255,1)'); lg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = lg; g.fillRect(192, y, CELL, CELL);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return {
    tex, glyph,
    solid: uv(0, y, CELL, CELL, 16), glow: uv(64, y, CELL, CELL, 0), plus: uv(128, y, CELL, CELL, 1), beam: uv(192, y, CELL, CELL, 0),
  };
}

/** A fixed-capacity dynamic quad mesh (every 4 vertices one quad), rewritten each frame: begin → vert… → end. */
class QuadBatch {
  constructor(scene, map, maxQuads, { additive = false, depthTest = true, order = 5, offset = false } = {}) {
    this.max = maxQuads * 4;
    this.pos = new Float32Array(this.max * 3);
    this.uv = new Float32Array(this.max * 2);
    this.col = new Float32Array(this.max * 4);
    const idx = new Uint32Array(maxQuads * 6);
    for (let i = 0; i < maxQuads; i++) idx.set([4 * i, 4 * i + 1, 4 * i + 2, 4 * i + 1, 4 * i + 3, 4 * i + 2], 6 * i);
    const g = new THREE.BufferGeometry();
    this.attrs = [[new THREE.BufferAttribute(this.pos, 3), 3], [new THREE.BufferAttribute(this.uv, 2), 2], [new THREE.BufferAttribute(this.col, 4), 4]];
    g.setAttribute('position', this.attrs[0][0].setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', this.attrs[1][0].setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', this.attrs[2][0].setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      map, vertexColors: true, transparent: true, depthWrite: false, depthTest, side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      polygonOffset: offset, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.nv = 0;
  }
  begin() { this.nv = 0; }
  /** True while q more quads fit. */
  room(q) { return this.nv + 4 * q <= this.max; }
  vert(x, y, z, u, v, r, g, b, a) {
    const i = this.nv++, p = i * 3, k = i * 4;
    this.pos[p] = x; this.pos[p + 1] = y; this.pos[p + 2] = z;
    this.uv[i * 2] = u; this.uv[i * 2 + 1] = v;
    this.col[k] = r; this.col[k + 1] = g; this.col[k + 2] = b; this.col[k + 3] = a;
  }
  end() {
    const geo = this.mesh.geometry;
    geo.setDrawRange(0, (this.nv >> 2) * 6);
    for (const [a, size] of this.attrs) {
      a.clearUpdateRanges();
      if (this.nv) { a.addUpdateRange(0, this.nv * size); a.needsUpdate = true; }
    }
    this.mesh.visible = this.nv > 0;
  }
}

export class CombatFx3D {
  /**
   * host: { ent(id) → entity, passes(e, t) → fog/filter visibility at t, topOf(e) → unit height (m), radiusOf(e) → footprint
   * radius (m), chest(e, out), muzzle(shot, out) → scene point the shot leaves from, worldPerPx(vec3) }.
   */
  constructor({ scene, camera, heightAt, FX, host }) {
    this.camera = camera; this.heightAt = heightAt; this.FX = FX; this.host = host;
    this.atlas = buildAtlas();
    const A = this.atlas.tex;
    this.text = new QuadBatch(scene, A, MAX_NUMBERS * MAX_GLYPHS, { depthTest: false, order: 16 });
    this.rings = new QuadBatch(scene, A, RING_QUADS, { order: 4.5, offset: true });
    this.glow = new QuadBatch(scene, A, GLOW_QUADS, { additive: true, order: 6, offset: true });
    this.colors = new Map(); // hex → Color (the handful RV_FX returns)
    this.splash = FX.SPLASH_COLOR.map((h) => new THREE.Color(h));
    this.heal = new THREE.Color(FX.HEAL_COLOR);
    this.healSpark = this.heal.clone().lerp(WHITE, 0.4);
    this.camPos = new THREE.Vector3();
    this.R = new THREE.Vector3(); this.U = new THREE.Vector3();
    this.p = new THREE.Vector3(); this.q = new THREE.Vector3(); this.a = new THREE.Vector3(); this.b = new THREE.Vector3();
    this.side = new THREE.Vector3(); this.tmp = new THREE.Vector3();
    this.mz = new THREE.Color();
    this.hs = new Float32Array(260); this.cs = new Float32Array(260); this.sn = new Float32Array(260);
    this.seenTargets = new Set(); this.seenHealers = new Set();
  }

  colorOf(hex) {
    let c = this.colors.get(hex);
    if (!c) this.colors.set(hex, (c = new THREE.Color(hex)));
    return c;
  }

  /** Camera-facing quad of half-size (hw, hh) at p, sampling cell uv. */
  billboard(batch, p, hw, hh, uv, c, a) {
    if (!batch.room(1)) return;
    const R = this.R, U = this.U;
    const rx = R.x * hw, ry = R.y * hw, rz = R.z * hw, ux = U.x * hh, uy = U.y * hh, uz = U.z * hh;
    batch.vert(p.x - rx - ux, p.y - ry - uy, p.z - rz - uz, uv.u0, uv.v0, c.r, c.g, c.b, a);
    batch.vert(p.x + rx - ux, p.y + ry - uy, p.z + rz - uz, uv.u1, uv.v0, c.r, c.g, c.b, a);
    batch.vert(p.x - rx + ux, p.y - ry + uy, p.z - rz + uz, uv.u0, uv.v1, c.r, c.g, c.b, a);
    batch.vert(p.x + rx + ux, p.y + ry + uy, p.z + rz + uz, uv.u1, uv.v1, c.r, c.g, c.b, a);
  }

  /** Terrain-following ring (replay x, z), w m wide inward from radius r; dashed: two segments on, two off. */
  ring(batch, cx, cz, r, w, c, a, dashed = false, segs = Math.max(32, Math.min(128, Math.round(r * 6)))) {
    if (!(r > 0.02) || !batch.room(segs)) return;
    const r0 = Math.max(0, r - w), { hs, cs, sn, heightAt } = this, uv = this.atlas.solid, u = (uv.u0 + uv.u1) / 2, v = (uv.v0 + uv.v1) / 2;
    for (let i = 0; i <= segs; i++) {
      const ang = (i / segs) * TAU, co = Math.cos(ang), si = Math.sin(ang);
      cs[i] = co; sn[i] = si;
      hs[i] = heightAt(cx + co * r, cz + si * r) + LIFT;
    }
    for (let i = 0; i < segs; i++) {
      if (dashed && (i & 3) >= 2) continue;
      const j = i + 1;
      batch.vert(cx + cs[i] * r0, hs[i], -(cz + sn[i] * r0), u, v, c.r, c.g, c.b, a);
      batch.vert(cx + cs[i] * r, hs[i], -(cz + sn[i] * r), u, v, c.r, c.g, c.b, a);
      batch.vert(cx + cs[j] * r0, hs[j], -(cz + sn[j] * r0), u, v, c.r, c.g, c.b, a);
      batch.vert(cx + cs[j] * r, hs[j], -(cz + sn[j] * r), u, v, c.r, c.g, c.b, a);
    }
  }

  /** Metres per CSS pixel at replay ground point (x, z): rings keep a constant on-screen width. */
  pxAt(x, z) {
    return this.host.worldPerPx(this.q.set(x, this.heightAt(x, z), -z));
  }

  /** Redraws every effect for t from the FrameRenderState `view`; on = false (Combat FX off) draws nothing. */
  update(t, view, on, numbers) {
    const { text, rings, glow } = this;
    text.begin(); rings.begin(); glow.begin();
    if (on) {
      const m = this.camera.matrixWorld.elements;
      this.R.set(m[0], m[1], m[2]); this.U.set(m[4], m[5], m[6]);
      this.camPos.setFromMatrixPosition(this.camera.matrixWorld);
      this.muzzles(t, view);
      this.impacts(t, view);
      this.heals(t, view);
      if (numbers) this.damageNumbers(t, view);
    }
    text.end(); rings.end(); glow.end();
  }

  /** Siege muzzle flash: a ring on the ground around the engine and a bright flash at the barrel, expanding and fading. */
  muzzles(t, view) {
    const { FX, host, p } = this;
    for (const P of view.activeProjectiles) {
      if (P.damageType !== 'siege') continue;
      const mz = FX.muzzleAnim(P.t0, t);
      if (!mz) continue;
      const s = P.shot;
      if (!(s.a.shown || s.b.shown)) continue;
      host.muzzle(s, p);
      const w = Math.max(0.2, 3 * this.pxAt(p.x, -p.z));
      this.ring(this.glow, p.x, -p.z, 1 + 3.2 * mz.k, w, this.mz.copy(MUZZLE).lerp(WHITE, 0.5 * (1 - mz.k)), 0.95 * mz.alpha);
      const sz = 0.9 + 1.9 * mz.k;
      this.billboard(this.glow, p, sz, sz, this.atlas.glow, MUZZLE_CORE, 0.9 * mz.alpha);
    }
  }

  /** Splash rings at landed siege shots: red 100 %, orange 50 %, dashed yellow 25 %. */
  impacts(t, view) {
    const { FX, rings } = this;
    for (const im of view.activeImpacts) {
      const an = FX.impactAnim(im.t1, t);
      if (!an) continue;
      const s = im.shot;
      if (!(s.a.shown || s.b.shown)) continue;
      const px = this.pxAt(im.x, im.z);
      for (let i = 0; i < im.splashRadii.length; i++) {
        const r = im.splashRadii[i][0] * an.k;
        this.ring(rings, im.x, im.z, r, Math.max(0.15, (i ? 2 : 3) * px), this.splash[i] ?? this.splash[2], an.alpha * (i ? 0.85 : 1), i === 2);
      }
    }
  }

  /** Heals: tether healer → target, pulsing emerald ring at the target's feet, "+" rising around it. */
  heals(t, view) {
    const { FX, host, glow, atlas, a, b, p, side, tmp } = this;
    const pulse = FX.healPulse(t);
    this.seenTargets.clear(); this.seenHealers.clear();
    for (const h of view.activeHeals) {
      const A = host.ent(h.healerId), B = host.ent(h.targetId);
      if (!A || !B || !A.on || !B.on || A.hid || B.hid || !(A.shown || B.shown)) continue;
      if (!this.seenHealers.has(h.healerId)) { // tether: a pulse travels from the healer to the target
        this.seenHealers.add(h.healerId);
        host.chest(A, a); host.chest(B, b);
        const len = a.distanceTo(b);
        if (len > 0.05 && glow.room(8)) {
          const wid = Math.max(0.14, 2.4 * host.worldPerPx(tmp.copy(a).add(b).multiplyScalar(0.5)));
          tmp.copy(a).add(b).multiplyScalar(0.5).sub(this.camPos);
          side.subVectors(b, a).cross(tmp).setLength(wid);
          const bm = atlas.beam, u = (bm.u0 + bm.u1) / 2, c = this.healSpark;
          for (let j = 0; j < 8; j++) {
            const f0 = j / 8, f1 = (j + 1) / 8;
            const w0 = 0.35 + 0.4 * (0.5 + 0.5 * Math.sin(f0 * len * 1.3 - t * 7)), w1 = 0.35 + 0.4 * (0.5 + 0.5 * Math.sin(f1 * len * 1.3 - t * 7));
            glow.vert(a.x + (b.x - a.x) * f0 - side.x, a.y + (b.y - a.y) * f0 - side.y, a.z + (b.z - a.z) * f0 - side.z, u, bm.v0, c.r, c.g, c.b, w0);
            glow.vert(a.x + (b.x - a.x) * f0 + side.x, a.y + (b.y - a.y) * f0 + side.y, a.z + (b.z - a.z) * f0 + side.z, u, bm.v1, c.r, c.g, c.b, w0);
            glow.vert(a.x + (b.x - a.x) * f1 - side.x, a.y + (b.y - a.y) * f1 - side.y, a.z + (b.z - a.z) * f1 - side.z, u, bm.v0, c.r, c.g, c.b, w1);
            glow.vert(a.x + (b.x - a.x) * f1 + side.x, a.y + (b.y - a.y) * f1 + side.y, a.z + (b.z - a.z) * f1 + side.z, u, bm.v1, c.r, c.g, c.b, w1);
          }
        }
      }
      if (this.seenTargets.has(h.targetId)) continue;
      this.seenTargets.add(h.targetId);
      const R = host.radiusOf(B) * 1.3 + 0.5, px = this.pxAt(B.px, B.pz);
      this.ring(this.rings, B.px, B.pz, R * (1 + 0.12 * pulse), Math.max(0.18, 2 * px) * (1 + 0.6 * pulse), this.heal, 0.5 + 0.45 * pulse, false, 40);
      this.ring(glow, B.px, B.pz, R * (1 + 0.12 * pulse) + 0.2, Math.max(0.5, 5 * px), this.heal, 0.07 + 0.1 * pulse, false, 40); // the glow around it
      const sz = Math.max(0.4, 7 * px);
      for (let i = 0; i < FX.HEAL_PARTICLES; i++) {
        const pt = FX.healParticle(h.targetId, i, t);
        p.set(B.px + pt.dx * R * 0.8, B.gy + 0.2 + pt.k * 2, -(B.pz + pt.dz * R * 0.8));
        this.billboard(glow, p, sz, sz, atlas.plus, this.heal, pt.alpha);
      }
    }
  }

  /** Floating damage numbers: rise over the hit unit, tinted by RV_FX.dmgColor, fading. */
  damageNumbers(t, view) {
    const { FX, host, text, atlas, R, U, p } = this;
    let n = 0;
    for (const d of view.floatingDamageEvents) {
      if (n >= MAX_NUMBERS) break;
      const e = host.ent(d.unitId);
      if (e && !host.passes(e, d.timestamp)) continue;
      const an = FX.dmgAnim(d, t), str = FX.dmgText(d), len = Math.min(str.length, MAX_GLYPHS);
      if (!text.room(len)) break;
      n++;
      const x = d.worldPos.x, z = d.worldPos.z, jit = (hash1(d.id) - 0.5) * 0.9; // spreads numbers landing together
      p.set(x + R.x * jit, this.heightAt(x, z) + (e ? host.topOf(e) : 2) + 0.3 + an.rise * FX.DMG_RISE + R.y * jit, -z + R.z * jit);
      const px = host.worldPerPx(p), h = Math.max(0.7, 18 * px) * (d.amount >= 20 ? 1.25 : 1), s = h / CELL;
      const c = this.colorOf(FX.dmgColor(d));
      let total = 0;
      for (let i = 0; i < len; i++) total += (atlas.glyph[str[i]] ?? atlas.glyph['.']).adv;
      let cx = -total * s / 2;
      for (let i = 0; i < len; i++) {
        const gl = atlas.glyph[str[i]] ?? atlas.glyph['.'], x0 = cx + (gl.adv - gl.w) * s / 2, x1 = x0 + gl.w * s, y0 = -h / 2, y1 = h / 2, uv = gl.uv;
        cx += gl.adv * s;
        text.vert(p.x + R.x * x0 + U.x * y0, p.y + R.y * x0 + U.y * y0, p.z + R.z * x0 + U.z * y0, uv.u0, uv.v0, c.r, c.g, c.b, an.alpha);
        text.vert(p.x + R.x * x1 + U.x * y0, p.y + R.y * x1 + U.y * y0, p.z + R.z * x1 + U.z * y0, uv.u1, uv.v0, c.r, c.g, c.b, an.alpha);
        text.vert(p.x + R.x * x0 + U.x * y1, p.y + R.y * x0 + U.y * y1, p.z + R.z * x0 + U.z * y1, uv.u0, uv.v1, c.r, c.g, c.b, an.alpha);
        text.vert(p.x + R.x * x1 + U.x * y1, p.y + R.y * x1 + U.y * y1, p.z + R.z * x1 + U.z * y1, uv.u1, uv.v1, c.r, c.g, c.b, an.alpha);
      }
    }
  }
}
