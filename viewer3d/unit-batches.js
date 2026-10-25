/**
 * Unit batches: every animated unit drawn through GPU-instanced skinning, posed by the game's own clips.
 *
 *   Clips      assets/anims/<archetype>.glb (tools/havok/bake-anims.mjs; index.json maps blueprint + state → clip).
 *              Archetypes sharing a skeleton (the same bone names, so the same hierarchy) form a family. Each family
 *              bakes every clip it has loaded into one RGBA16F animation texture: one row per clip frame (the GLB's
 *              keys, uniform in time), three texels per bone = the rows of the bone's model-space 3×4 matrix. Rows of
 *              later archetypes append, so clip rows (and handles) never move. Frames are sampled with the texture's
 *              linear filter (one fetch = the lerp of two adjacent frames). A crossfade lerps the two clips' model-space
 *              matrices, columns rescaled to the lerped bone scale so limbs don't shrink mid-blend (it is a model-space
 *              blend: at w 0.5 between far-apart poses a long weapon's tip can sit ~1 m off a local-space blend).
 *              Rider clips (part 'rider', horse family) drive the rider: the metarig subtree seated on a horse bone
 *              (the saddle cloth's non-gaia_ bones stay with the gait). Their pose is re-seated on the gait's attach
 *              bone, as a local-space layer would hang it, then weighted by w over the gait's own rider pose.
 *              Root motion: every root bone is single-keyed and locomotion loops end where they start (checked over
 *              all archetypes, Step 3), so units stay on their replay positions; the bake still pins root bones' x/z
 *              to their first key in case a rebake brings root motion back. Death falls keep their pelvis travel
 *              (the body topples up to ~1.8 m off its spot, as in the game).
 *   Models     A unit GLB (one skin; LOD levels as top-level rv_lod<n> nodes sharing the LOD0 skin, switch distance in
 *              extras.rv.dist) maps each skin joint to a family bone: S_j = M_bone(frame) · C_j, C_j = inverse bind
 *              (· the fixed local offset of a prop joint from its socket bone). Prop joints (rv*, in skin joint order
 *              = props() bit order) collapse to their socket when their bit is off, like the old scale-0 joints.
 *              The per-model joint table is a small RGBA32F texture: C_j rows, (bone, prop bit, rider bone, attach
 *              bone), prop offset.
 *   Instances  One RGBA32F texture for all instances, 6 texels each: instance matrix rows (local to `parent`),
 *              team colour + flash, skin colour + rider flag, (row a, row b, weight, prop bits). Every update()
 *              compacts the instances set() since the previous update() into it, grouped per (model, LOD level)
 *              slot as [shadow-only | shown + shadow | shown only], so the colour pass draws one range and the shadow
 *              pass another (onBeforeRender / onBeforeShadow pick the instance count; the shaders offset
 *              gl_InstanceID by the slot's base). One Mesh (InstancedBufferGeometry, no instanced attributes) per
 *              slot × material: a model costs one draw per material per pass whatever its unit count. A part made
 *              only of prop vertices draws only while some instance in the slot shows that prop.
 *   Culling    Per instance: a model-origin sphere (family's farthest bone + the model's farthest vertex from its
 *              bone) scaled by the instance, against the camera frustum; shadow casters also against the sun's
 *              shadow box, and only when the sphere swept along the sun's direction (its shadow) reaches the view.
 *   LOD        Per instance by camera distance ÷ instance scale (a unit drawn larger switches later) against the
 *              model's rv_lod dist, with LOD_HYST hysteresis.
 *   Materials  The source GLB materials: team-mask units get MeshStandardMaterial with the albedo, PBR maps (pbrOf)
 *              and the patternTex mask tinted by TEAM_MASK_GLSL (shared with viewer.js makeMaskMaterial), others a
 *              matte clone (AssetRegistry.plain); team, skin and the hit flash come from instance data instead of
 *              per-owner/per-flash material clones. A MeshDepthMaterial with the same skinning casts the shadows.
 *
 * API (viewer.js):
 *   new UnitBatches({ parent, renderer, loader, index, base = 'assets/anims/', sun })
 *     parent: Object3D the instance matrices are local to; sun: the shadow-casting DirectionalLight (optional; without
 *     it every unit in view casts and nothing off-screen does).
 *   await prepare(modelKey, template, bp) → boolean   template = the GLB's scene as loaded (rv_lod* included; only
 *     its matrices are updated and its team-mask textures marked NoColorSpace, as AssetRegistry.maskMat does); loads
 *     the bp's archetypes once. false: not animatable (unknown bp, unmapped joint, unskinned part, mixed skeletons).
 *   clip(bp, state, key, n = 0) → handle | null   key = style or villager job; lookup `${state}@${style ?? key}`, then
 *     `state`, in jobs[key] ?? base, then each extra, then base; n picks clips[n % length]. Handle =
 *     { ...index clip entry (dur, frames, part, move, hit), id, name, archetype, rider }, stable; null until the
 *     archetype is baked.
 *   props(modelKey) → prop joint names in bit order.
 *   add(view, modelKey, owner) / remove(view)   add() needs prepare() resolved true; re-adding swaps the model.
 *   set(view, s) per frame for each unit to draw: s = { matrix, team, skin?, flash, a, ta, b, tb, w, props }.
 *     ta/tb: seconds into the clip, already wrapped (loops) or clamped (one-shots) by the caller; sampled linearly
 *     between frames, clamped to [0, dur]. b blends over a by w; a rider clip (handle.rider) in b replaces only the
 *     rider's bones (by w) over a's horse gait. Rider clips belong in b. Instances not set() since the previous
 *     update() are not drawn. Every input is plain data, so a paused replay draws a still frame.
 *   update(camera) once per frame after every set() and after the shadow box is fitted: culls, picks LODs, uploads.
 *   stats() → { instances, drawn, shadow, animBytes, jointBytes, instanceBytes }.
 *   Beyond the Step 3 contract: `sun`, set()'s `skin` (civ skin tone, default #c29572), clip()'s `n` and the handle's
 *   index fields; `dim` was dropped.
 * set() and update() allocate nothing per frame (buffers grow by doubling when needed).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Surface maps of a rebuilt GLB material (extras.rv.pbr): tangent-space normal map (GLTFLoader already flipped
 * normalScale.y for three's derivative tangent frame, which stays right under the mirrored world as it is solved in
 * view space), roughness (G) / metalness (B) and occlusion (R) of one ORM image, with the file's factors. Older GLBs
 * carry albedo only and keep the matte non-metal look tuned for them (null).
 */
export const pbrOf = (src) => (src.userData.rv?.pbr ? {
  normalMap: src.normalMap, normalScale: src.normalScale.clone(), roughnessMap: src.roughnessMap, metalnessMap: src.metalnessMap,
  aoMap: src.aoMap, aoMapIntensity: src.aoMapIntensity, roughness: src.roughness, metalness: src.metalness,
} : null);

/**
 * The game's patternTex mask on a unit albedo c (GLSL): mk.r marks player-colour cloth, mk.g skin (the game tints it
 * through a skin LUT; one civ skin tone stands in). Both regions are greyscale in the albedo, so they keep its shading.
 */
export const TEAM_MASK_GLSL = `
vec3 rvTeamMask(vec3 c, vec2 mk, vec3 team, vec3 skin) {
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(c, team * (0.3 + 1.3 * l), clamp(mk.r, 0.0, 1.0));
  return mix(c, skin * clamp(l * 3.2, 0.25, 1.4), clamp(mk.g, 0.0, 1.0));
}`;

const FLASH = new THREE.Color(0xff2a14).multiplyScalar(0.35); // the hit flash: emissive #ff2a14 at intensity 0.35
const DEFAULT_SKIN = new THREE.Color('#c29572');
const STRIDE = 6, PER_ROW = 256;   // instance texels; instances per instance-texture row
const FLOATS = STRIDE * 4;         // floats per instance
const JOINT_TEXELS = 5;            // joint table texels per joint
const LOD_HYST = 1.1;              // a level switches in beyond dist × this and back out under dist ÷ this
const MAX_PROPS = 24;              // prop bits travel as an exact float
const ROOT_PIN = true;             // pin root bones' horizontal translation to their first key (no root motion)

// GLSL: instance + skinning. rvSkin() leaves the rows of (instance · skin matrix) in rvT0..2.
const VERT_PARS = /* glsl */ `
uniform highp sampler2D rvAnim;   // family: row = frame, 3 texels per bone (model-space 3x4 rows)
uniform highp sampler2D rvJoint;  // model: per skin joint C rows 0..2, (bone, prop bit or -1, rider bone, attach bone), prop offset
uniform highp sampler2D rvInst;   // instances: ${STRIDE} texels each, ${PER_ROW} per row
uniform int rvBase;               // this draw's first instance
attribute vec4 skinIndex;
attribute vec4 skinWeight;
#ifdef RV_COLOR
varying vec3 vRvTeam;
varying vec3 vRvSkin;
varying float vRvFlash;
#endif
vec2 rvAnimTexel;
mat4 rvMat(vec4 r0, vec4 r1, vec4 r2) { return transpose(mat4(r0, r1, r2, vec4(0.0, 0.0, 0.0, 1.0))); }
void rvBone(float row, float bone, out vec4 r0, out vec4 r1, out vec4 r2) {
  float v = (row + 0.5) * rvAnimTexel.y, u = (bone * 3.0 + 0.5) * rvAnimTexel.x;
  r0 = textureLod(rvAnim, vec2(u, v), 0.0);
  r1 = textureLod(rvAnim, vec2(u + rvAnimTexel.x, v), 0.0);
  r2 = textureLod(rvAnim, vec2(u + 2.0 * rvAnimTexel.x, v), 0.0);
}
void rvSkin(out vec4 t0, out vec4 t1, out vec4 t2) {
  int n = rvBase + gl_InstanceID;
  ivec2 at = ivec2((n & ${PER_ROW - 1}) * ${STRIDE}, n >> ${Math.log2(PER_ROW)});
  vec4 i0 = texelFetch(rvInst, at, 0), i1 = texelFetch(rvInst, at + ivec2(1, 0), 0), i2 = texelFetch(rvInst, at + ivec2(2, 0), 0);
  vec4 fx = texelFetch(rvInst, at + ivec2(3, 0), 0), sk = texelFetch(rvInst, at + ivec2(4, 0), 0), an = texelFetch(rvInst, at + ivec2(5, 0), 0);
#ifdef RV_COLOR
  vRvTeam = fx.rgb; vRvFlash = fx.a; vRvSkin = sk.rgb;
#endif
  rvAnimTexel = 1.0 / vec2(textureSize(rvAnim, 0));
  uint props = uint(an.w);
  vec4 s0 = vec4(0.0), s1 = vec4(0.0), s2 = vec4(0.0);
  for (int k = 0; k < 4; k++) {
    float wt = skinWeight[k];
    if (wt <= 0.0) continue;
    int j = int(skinIndex[k]);
    vec4 info = texelFetch(rvJoint, ivec2(3, j), 0);
    vec4 m0, m1, m2;
    rvBone(an.x, info.x, m0, m1, m2);
    float wb = sk.a > 0.5 && info.z < 0.5 ? 0.0 : an.z; // a rider layer leaves the horse's bones alone
    if (wb > 0.0) {
      vec4 b0, b1, b2;
      rvBone(an.y, info.x, b0, b1, b2);
      mat4 A = rvMat(m0, m1, m2), B = rvMat(b0, b1, b2);
      if (sk.a > 0.5) {
        // the rider clip's pose re-seated on the gait's attach bone (the horse moves under the rider)
        vec4 p0, p1, p2, q0, q1, q2;
        rvBone(an.x, info.w, p0, p1, p2);
        rvBone(an.y, info.w, q0, q1, q2);
        B = rvMat(p0, p1, p2) * inverse(rvMat(q0, q1, q2)) * B;
      }
      // matrix lerp, columns rescaled to the lerped bone scale: rotations far apart don't shrink the limb
      mat4 M = A * (1.0 - wb) + B * wb;
      for (int c = 0; c < 3; c++) M[c].xyz *= mix(length(A[c].xyz), length(B[c].xyz), wb) / max(length(M[c].xyz), 1e-4);
      M = transpose(M);
      m0 = M[0]; m1 = M[1]; m2 = M[2];
    }
    if (info.y >= 0.0 && ((props >> uint(info.y)) & 1u) == 0u) {
      // hidden prop: its vertices collapse onto the joint (scale 0 about it)
      vec4 o = vec4(texelFetch(rvJoint, ivec2(4, j), 0).xyz, 1.0);
      s0.w += wt * dot(m0, o); s1.w += wt * dot(m1, o); s2.w += wt * dot(m2, o);
    } else {
      vec4 c0 = texelFetch(rvJoint, ivec2(0, j), 0), c1 = texelFetch(rvJoint, ivec2(1, j), 0), c2 = texelFetch(rvJoint, ivec2(2, j), 0);
      s0 += wt * (m0.x * c0 + m0.y * c1 + m0.z * c2 + vec4(0.0, 0.0, 0.0, m0.w));
      s1 += wt * (m1.x * c0 + m1.y * c1 + m1.z * c2 + vec4(0.0, 0.0, 0.0, m1.w));
      s2 += wt * (m2.x * c0 + m2.y * c1 + m2.z * c2 + vec4(0.0, 0.0, 0.0, m2.w));
    }
  }
  t0 = i0.x * s0 + i0.y * s1 + i0.z * s2 + vec4(0.0, 0.0, 0.0, i0.w);
  t1 = i1.x * s0 + i1.y * s1 + i1.z * s2 + vec4(0.0, 0.0, 0.0, i1.w);
  t2 = i2.x * s0 + i2.y * s1 + i2.z * s2 + vec4(0.0, 0.0, 0.0, i2.w);
}
`;

/** Patch a three vertex shader (standard or depth) to skin and place by instance data. */
function patchVertex(vs, color) {
  return vs
    .replace('#include <common>', `#include <common>\n${color ? '#define RV_COLOR\n' : ''}${VERT_PARS}`)
    .replace('#include <skinbase_vertex>', 'vec4 rvT0, rvT1, rvT2;\nrvSkin(rvT0, rvT1, rvT2);')
    .replace('#include <skinnormal_vertex>', 'objectNormal = vec3(dot(rvT0.xyz, objectNormal), dot(rvT1.xyz, objectNormal), dot(rvT2.xyz, objectNormal));')
    .replace('#include <skinning_vertex>', `{ vec4 p = vec4(transformed, 1.0); transformed = vec3(dot(rvT0, p), dot(rvT1, p), dot(rvT2, p)); }`);
}

/** Patch a standard fragment shader: team mask (mask role) and the instance's hit flash. */
function patchFragment(fs, mask) {
  return fs
    .replace('#include <common>', `#include <common>\nvarying vec3 vRvTeam;\nvarying vec3 vRvSkin;\nvarying float vRvFlash;\n${mask ? `uniform sampler2D rvMask;\n${TEAM_MASK_GLSL}` : ''}`)
    .replace('#include <map_fragment>', mask ? '#include <map_fragment>\ndiffuseColor.rgb = rvTeamMask(diffuseColor.rgb, texture2D(rvMask, vMapUv).rg, vRvTeam, vRvSkin);' : '#include <map_fragment>')
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance += vRvFlash * vec3(${FLASH.r.toFixed(6)}, ${FLASH.g.toFixed(6)}, ${FLASH.b.toFixed(6)});`);
}

const isMask = (src) => !!(src.userData.rv?.mask && src.emissiveMap && src.map);

/** Colour-pass material for a source GLB material (the AssetRegistry looks: makeMaskMaterial / plain). */
function unitMaterial(src, U) {
  const mask = isMask(src);
  let mat;
  if (mask) {
    mat = new THREE.MeshStandardMaterial({ map: src.map, roughness: 0.82, metalness: 0, alphaTest: src.alphaTest || 0, side: src.side, ...pbrOf(src) });
    const m = src.emissiveMap;
    if (m.colorSpace !== THREE.NoColorSpace) { m.colorSpace = THREE.NoColorSpace; m.needsUpdate = true; } // data, not colour
    U = { ...U, rvMask: { value: m } };
  } else {
    mat = src.clone();
    if (!pbrOf(src)) { mat.metalness = 0; mat.roughness = Math.max(0.6, mat.roughness ?? 1); } // albedo-only GLBs stay matte
    mat.emissive?.set(0);
    mat.emissiveMap = null;
  }
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = patchVertex(sh.vertexShader, true);
    sh.fragmentShader = patchFragment(sh.fragmentShader, mask);
  };
  mat.customProgramCacheKey = () => (mask ? 'rv-unit-mask' : 'rv-unit-plain');
  return mat;
}

function depthMaterial(U) {
  const mat = new THREE.MeshDepthMaterial();
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = patchVertex(sh.vertexShader, false);
  };
  mat.customProgramCacheKey = () => 'rv-unit-depth';
  return mat;
}

const LOD_RE = /^rv_lod(\d+)$/;
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _frustum = new THREE.Frustum(), _pv = new THREE.Matrix4(), _sph = new THREE.Sphere();
/** Value offset of key f in a track (n values per key); single-key (constant) tracks hold one. */
const keyAt = (t, f, n) => (t.times.length > 1 ? Math.min(f, t.times.length - 1) * n : 0);

export class UnitBatches {
  constructor({ parent, renderer, loader, index, base = 'assets/anims/', sun = null }) {
    this.parent = parent;
    this.renderer = renderer;
    this.loader = loader;
    this.index = index;
    this.base = base;
    this.sun = sun;
    this.families = new Map();   // sorted bone names → family
    this.archetypes = new Map(); // archetype → Promise<family>
    this.clipIds = new Map();    // `${archetype}|${clip}` → handle id
    this.clipRecs = [];          // id → { fam, row0, frames, span } (row0 −1 until baked)
    this.handles = [];           // id → handle
    this.lookups = new Map();    // bp → state → key → handles[] | null
    this.models = new Map();     // model key → Promise<model | null>
    this.ready = new Map();      // model key → model
    this.recs = new Map();       // view → instance record
    this.list = [];              // instance records, dense
    this.slots = [];             // every (model, LOD level) slot
    this.frame = 0;
    this.instU = { value: null };
    this.instCap = 0;
    this.drawn = 0;
    this.shadowed = 0;
    this.growInstances(PER_ROW);
  }

  // ── animation families ──

  /** Promise of the family holding archetype `name`'s baked clips. */
  archetype(name) {
    let p = this.archetypes.get(name);
    if (!p) {
      const file = this.index.archetypes[name].file.split('/').pop();
      p = this.loader.loadAsync(this.base + file).then((g) => this.bake(name, g));
      this.archetypes.set(name, p);
    }
    return p;
  }

  /** Bake one loaded archetype GLB's clips into its family's animation texture. */
  bake(name, gltf) {
    const nodes = [];
    gltf.scene.traverse((o) => { if (o !== gltf.scene) nodes.push(o); }); // parents before children
    const key = nodes.map((o) => o.name).sort().join(',');
    let fam = this.families.get(key);
    if (!fam) {
      const bones = nodes.map((o) => o.name), idx = new Map(bones.map((b, i) => [b, i]));
      const parent = nodes.map((o) => (o.parent === gltf.scene ? -1 : idx.get(o.parent.name)));
      // the rider (horse families): the metarig subtree seated on a horse bone; the horse's own non-gaia_ bones
      // (saddle cloth) stay with the gait. attach = the horse bone the rider's subtree hangs from.
      const attach = bones.map(() => -1);
      for (let i = 0; i < bones.length; i++) {
        const p = parent[i];
        if (p < 0) continue;
        if (attach[p] >= 0) attach[i] = attach[p];
        else if (bones[i].startsWith('metarig_') && bones[p].startsWith('gaia_')) attach[i] = p;
      }
      fam = {
        bones, index: idx, parent, attach, rider: attach.map((a) => a >= 0), // bones a rider clip layers over the gait
        width: bones.length * 3, rows: 0, data: new Uint16Array(0), tex: null, u: { value: null }, reach: 0,
      };
      this.families.set(key, fam);
    }
    const B = fam.bones.length, byName = new Map(nodes.map((o) => [o.name, o]));
    const rest = fam.bones.map((b) => byName.get(b));
    const entries = this.index.archetypes[name].clips;
    const clips = gltf.animations.filter((c) => entries[c.name]);
    const frames = clips.map((c) => Math.max(1, ...c.tracks.map((t) => t.times.length)));
    const total = frames.reduce((a, b) => a + b, 0);
    const max = this.renderer.capabilities.maxTextureSize;
    if (fam.rows + total > max) throw new Error(`[units] ${name}: animation texture would need ${fam.rows + total} rows (max ${max})`);
    const data = new Uint16Array((fam.rows + total) * fam.width * 4);
    data.set(fam.data);
    const local = fam.bones.map(() => new THREE.Matrix4()), world = fam.bones.map(() => new THREE.Matrix4());
    const toHalf = THREE.DataUtils.toHalfFloat;
    let row = fam.rows;
    clips.forEach((clip, ci) => {
      const F = frames[ci], tracks = fam.bones.map(() => ({ p: null, q: null, s: null }));
      for (const t of clip.tracks) {
        const dot = t.name.lastIndexOf('.'), b = fam.index.get(t.name.slice(0, dot)), path = t.name.slice(dot + 1);
        if (b === undefined) continue;
        if (path === 'position') tracks[b].p = t; else if (path === 'quaternion') tracks[b].q = t; else if (path === 'scale') tracks[b].s = t;
      }
      const id = this.clipId(name, clip.name);
      Object.assign(this.clipRecs[id], { fam, row0: row, frames: F, span: clip.duration });
      for (let f = 0; f < F; f++, row++) {
        for (let i = 0; i < B; i++) {
          const T = tracks[i], o = rest[i];
          if (T.p) _p.fromArray(T.p.values, keyAt(T.p, f, 3)); else _p.copy(o.position);
          if (ROOT_PIN && fam.parent[i] < 0 && T.p && T.p.times.length > 1) { _p.x = T.p.values[0]; _p.z = T.p.values[2]; }
          if (T.q) _q.fromArray(T.q.values, keyAt(T.q, f, 4)).normalize(); else _q.copy(o.quaternion);
          if (T.s) _s.fromArray(T.s.values, keyAt(T.s, f, 3)); else _s.copy(o.scale);
          local[i].compose(_p, _q, _s);
          const p = fam.parent[i];
          if (p < 0) world[i].copy(local[i]); else world[i].multiplyMatrices(world[p], local[i]);
          const e = world[i].elements, o4 = (row * fam.width + i * 3) * 4;
          for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) data[o4 + r * 4 + c] = toHalf(e[c * 4 + r]);
          fam.reach = Math.max(fam.reach, Math.hypot(e[12], e[13], e[14]));
        }
      }
    });
    fam.rows = row;
    fam.data = data;
    fam.tex?.dispose();
    const tex = new THREE.DataTexture(data, fam.width, fam.rows, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.magFilter = tex.minFilter = THREE.LinearFilter; // the vertical lerp between frames
    tex.needsUpdate = true;
    fam.tex = fam.u.value = tex;
    return fam;
  }

  clipId(arch, clip) {
    const k = `${arch}|${clip}`;
    let id = this.clipIds.get(k);
    if (id === undefined) {
      id = this.clipRecs.length;
      const e = this.index.archetypes[arch].clips[clip];
      this.clipIds.set(k, id);
      this.clipRecs.push({ fam: null, row0: -1, frames: e.frames, span: e.dur });
      this.handles.push({ ...e, id, name: clip, archetype: arch, rider: e.part === 'rider' });
    }
    return id;
  }

  /** Clip handle for a blueprint's state (see the header for the lookup), or null. */
  clip(bp, state, key, n = 0) {
    let byState = this.lookups.get(bp);
    if (!byState) this.lookups.set(bp, (byState = new Map()));
    let byKey = byState.get(state);
    if (!byKey) byState.set(state, (byKey = new Map()));
    let list = byKey.get(key);
    if (list === undefined) {
      list = this.resolve(bp, state, key);
      if (list && list.some((id) => this.clipRecs[id].row0 < 0)) return null; // not baked yet: retry later
      byKey.set(key, list);
    }
    return list ? this.handles[list[n % list.length]] : null;
  }

  resolve(bp, state, key) {
    const b = this.index.blueprints[bp];
    if (!b) return null;
    const v = b.style ?? key;
    for (const a of [b.jobs?.[key] ?? b.base, ...(b.extra ?? []), b.base]) {
      const s = this.index.archetypes[a].states, names = (v != null && s[`${state}@${v}`]) || s[state];
      if (names) return names.map((c) => this.clipId(a, c));
    }
    return null;
  }

  // ── models ──

  /** Bake a unit model for instanced drawing; resolves false when it can't be animated here. */
  async prepare(modelKey, template, bp) {
    let p = this.models.get(modelKey);
    if (!p) {
      p = this.build(modelKey, template, bp).catch((err) => { console.warn(`[units] ${modelKey}:`, err); return null; });
      this.models.set(modelKey, p);
    }
    return (await p) !== null;
  }

  props(modelKey) {
    return this.ready.get(modelKey)?.props ?? [];
  }

  async build(key, template, bp) {
    const b = this.index.blueprints[bp];
    if (!b) return null;
    const fams = await Promise.all([...new Set([b.base, ...Object.values(b.jobs ?? {}), ...(b.extra ?? [])])].map((a) => this.archetype(a)));
    const fam = fams[0];
    if (fams.some((f) => f !== fam)) { console.warn(`[units] ${bp}: archetypes of different skeletons`); return null; }

    template.updateMatrixWorld(true);
    const levels = [{ dist: 0, meshes: [] }];
    for (const c of template.children) {
      const m = LOD_RE.exec(c.name);
      if (m) levels[+m[1]] = { dist: c.userData.rv?.dist ?? 0, meshes: [] };
    }
    let unskinned = false;
    template.traverse((o) => {
      if (!o.isMesh) return;
      if (!o.isSkinnedMesh) { unskinned = true; return; }
      let lv = 0;
      for (let p = o; p && p !== template; p = p.parent) { const m = LOD_RE.exec(p.name); if (m) lv = +m[1]; }
      levels[lv].meshes.push(o);
    });
    const lods = levels.filter((l) => l?.meshes.length);
    if (unskinned || !lods.length || lods[0] !== levels[0]) return null;
    for (let i = 1; i < lods.length; i++) lods[i].dist = Math.max(lods[i].dist || lods[i - 1].dist * 2 || 30, lods[i - 1].dist);

    // joint table: every mesh of every level is bound to the same skin
    const sk = levels[0].meshes[0].skeleton, joints = sk.bones;
    const ident = (m) => m.equals(_m.identity());
    for (const l of lods) for (const o of l.meshes) {
      if (o.skeleton.bones.length !== joints.length || o.skeleton.bones.some((j, i) => j.name !== joints[i].name)) return null;
      if (!ident(o.matrixWorld) || !ident(o.bindMatrix)) { console.warn(`[units] ${key}: mesh not at the model origin`); return null; }
    }
    const props = [], jt = new Float32Array(joints.length * JOINT_TEXELS * 4), jointPos = [];
    for (let j = 0; j < joints.length; j++) {
      const name = joints[j].name;
      let bone = fam.index.get(name);
      _m2.identity(); // local offset from the family bone (props: socket → prop joint)
      if (bone === undefined) {
        let o = joints[j];
        for (; o && !fam.index.has(o.name); o = o.parent) _m2.premultiply(o.matrix);
        if (!o) { console.warn(`[units] ${key}: joint ${name} has no animated ancestor`); return null; }
        bone = fam.index.get(o.name);
      } else if (joints[j].parent && !joints[j].parent.isBone && !ident(joints[j].parent.matrixWorld)) {
        console.warn(`[units] ${key}: skeleton not at the model origin`); return null;
      }
      const prop = name.startsWith('rv') && !fam.index.has(name) && props.length < MAX_PROPS ? props.push(name) - 1 : -1;
      const off = _p.setFromMatrixPosition(_m2);
      _m.multiplyMatrices(_m2, sk.boneInverses[j]); // C = offset · inverse bind (bind matrices are identity)
      const e = _m.elements, o = j * JOINT_TEXELS * 4;
      for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) jt[o + r * 4 + c] = e[c * 4 + r];
      jt.set([bone, prop, fam.rider[bone] ? 1 : 0, Math.max(0, fam.attach[bone]), off.x, off.y, off.z, 0], o + 12);
      jointPos.push(new THREE.Vector3().setFromMatrixPosition(_m.copy(sk.boneInverses[j]).invert()));
    }
    const jointTex = new THREE.DataTexture(jt, JOINT_TEXELS, joints.length, THREE.RGBAFormat, THREE.FloatType);
    jointTex.needsUpdate = true;

    const model = { key, fam, props, jointTex, jointU: { value: jointTex }, reach: 0, slots: [], dists: lods.map((l) => l.dist) };
    // farthest vertex from its main joint (rest pose): with the family's farthest bone, the culling radius
    for (const o of levels[0].meshes) {
      const P = o.geometry.attributes.position, J = o.geometry.attributes.skinIndex, W = o.geometry.attributes.skinWeight;
      for (let i = 0; i < P.count; i++) {
        let best = 0;
        for (let k = 1; k < 4; k++) if (W.getComponent(i, k) > W.getComponent(i, best)) best = k;
        model.reach = Math.max(model.reach, _p.fromBufferAttribute(P, i).distanceTo(jointPos[J.getComponent(i, best)]));
      }
    }
    for (let lv = 0; lv < lods.length; lv++) model.slots.push(this.slot(model, lv, lods[lv].meshes, jt));
    this.ready.set(key, model);
    return model;
  }

  /** One (model, LOD level) slot: a Mesh per material over the level's skinned meshes. */
  slot(model, lv, meshes, jt) {
    const slot = { model, lv, parts: [], nA: 0, nB: 0, nC: 0, start: 0, cur: [0, 0, 0], bits: 0, baseU: { value: 0 }, shadowBaseU: { value: 0 } };
    const byMat = new Map();
    for (const o of meshes) byMat.set(o.material, [...(byMat.get(o.material) ?? []), o]);
    for (const [src, list] of byMat) {
      const groups = [];
      const sig = (g) => `${g.index ? 'i' : ''}|${Object.keys(g.attributes).sort().join()}`;
      for (const o of list) {
        const g = groups.find((x) => sig(x[0].geometry) === sig(o.geometry));
        if (g) g.push(o); else groups.push([o]);
      }
      for (const g of groups) {
        const src0 = g.length > 1 ? mergeGeometries(g.map((o) => o.geometry)) : g[0].geometry;
        const geo = new THREE.InstancedBufferGeometry();
        for (const [n, a] of Object.entries(src0.attributes)) geo.setAttribute(n, a);
        if (src0.index) geo.setIndex(src0.index);
        geo.instanceCount = 0;
        const U = { rvAnim: model.fam.u, rvJoint: model.jointU, rvInst: this.instU };
        const mesh = new THREE.Mesh(geo, unitMaterial(src, { ...U, rvBase: slot.baseU }));
        mesh.customDepthMaterial = depthMaterial({ ...U, rvBase: slot.shadowBaseU });
        mesh.name = `units:${model.key}:lod${lv}`;
        mesh.frustumCulled = false; // culled per instance
        mesh.matrixAutoUpdate = false;
        mesh.castShadow = true;
        mesh.receiveShadow = g.some((o) => o.receiveShadow);
        mesh.visible = false;
        mesh.onBeforeRender = () => { geo.instanceCount = slot.nB + slot.nC; };
        mesh.onBeforeShadow = () => { geo.instanceCount = slot.nA + slot.nB; };
        this.parent.add(mesh);
        slot.parts.push({ mesh, need: this.propOnly(geo, jt) });
      }
    }
    this.slots.push(slot);
    return slot;
  }

  /** Prop bits a part needs shown to be drawn at all: all its vertices ride prop joints (else 0: always drawn). */
  propOnly(geo, jt) {
    const J = geo.attributes.skinIndex, W = geo.attributes.skinWeight;
    let need = 0;
    for (let i = 0; i < J.count; i++) {
      for (let k = 0; k < 4; k++) {
        if (W.getComponent(i, k) <= 0) continue;
        const bit = jt[J.getComponent(i, k) * JOINT_TEXELS * 4 + 13];
        if (bit < 0) return 0;
        need |= 1 << bit;
      }
    }
    return need;
  }

  // ── instances ──

  add(view, modelKey, owner) {
    const model = this.ready.get(modelKey);
    if (!model) throw new Error(`[units] ${modelKey} is not prepared`);
    let r = this.recs.get(view);
    if (r) { r.model = model; r.owner = owner; r.lod = -1; return; }
    r = { view, model, owner, data: new Float32Array(FLOATS), stamp: -1, lod: -1, slot: null, cls: 0, at: this.list.length };
    this.recs.set(view, r);
    this.list.push(r);
  }

  remove(view) {
    const r = this.recs.get(view);
    if (!r) return;
    this.recs.delete(view);
    const last = this.list.pop();
    if (last !== r) { this.list[r.at] = last; last.at = r.at; }
  }

  /** Texture row (fractional frame) of clip handle h at t s. */
  row(h, t) {
    const c = this.clipRecs[h.id];
    if (c.frames < 2 || !(t > 0)) return c.row0;
    return c.row0 + Math.min(t / c.span, 1) * (c.frames - 1);
  }

  set(view, s) {
    const r = this.recs.get(view);
    if (!r) return;
    r.stamp = this.frame;
    const d = r.data, e = s.matrix.elements, team = s.team, skin = s.skin ?? DEFAULT_SKIN;
    for (let i = 0; i < 3; i++) { d[i * 4] = e[i]; d[i * 4 + 1] = e[i + 4]; d[i * 4 + 2] = e[i + 8]; d[i * 4 + 3] = e[i + 12]; }
    d[12] = team.r; d[13] = team.g; d[14] = team.b; d[15] = s.flash || 0;
    d[16] = skin.r; d[17] = skin.g; d[18] = skin.b; d[19] = s.b?.rider ? 1 : 0;
    const ra = this.row(s.a, s.ta);
    d[20] = ra; d[21] = s.b ? this.row(s.b, s.tb) : ra; d[22] = s.b ? s.w : 0; d[23] = s.props & 0xffffff;
  }

  /** Socket origin in parent coordinates, sampled from the same frames and blend as GPU skinning.
   * Foot units only: rider re-seating needs the shader's extra transform and is deliberately unsupported here.
   */
  socketPosition(view, bone, out) {
    const r = this.recs.get(view);
    if (!r || r.stamp !== this.frame || r.data[19]) return false;
    const f = r.model.fam, b = f.index.get(bone.toLowerCase());
    if (b === undefined) return false;
    const d = r.data, half = THREE.DataUtils.fromHalfFloat;
    const coord = (row, axis) => {
      const lo = Math.floor(row), hi = Math.min(lo + 1, f.rows - 1), a = row - lo;
      const offset = b * 12 + axis * 4 + 3;
      return half(f.data[lo * f.width * 4 + offset]) * (1 - a) + half(f.data[hi * f.width * 4 + offset]) * a;
    };
    const x = coord(d[20], 0) * (1 - d[22]) + coord(d[21], 0) * d[22];
    const y = coord(d[20], 1) * (1 - d[22]) + coord(d[21], 1) * d[22];
    const z = coord(d[20], 2) * (1 - d[22]) + coord(d[21], 2) * d[22];
    out.set(d[0] * x + d[1] * y + d[2] * z + d[3], d[4] * x + d[5] * y + d[6] * z + d[7], d[8] * x + d[9] * y + d[10] * z + d[11]);
    return true;
  }

  /** Instance texture with room for at least n instances (contents are rewritten every update). */
  growInstances(n) {
    let cap = Math.max(PER_ROW, this.instCap);
    while (cap < n) cap *= 2;
    if (cap === this.instCap) return;
    this.instCap = cap;
    this.instU.value?.dispose();
    const tex = new THREE.DataTexture(new Float32Array(cap * FLOATS), PER_ROW * STRIDE, cap / PER_ROW, THREE.RGBAFormat, THREE.FloatType);
    tex.needsUpdate = true;
    this.instU.value = tex;
  }

  update(camera) {
    const stamp = this.frame++, sun = this.sun;
    camera.updateMatrixWorld();
    _frustum.setFromProjectionMatrix(_pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    let shadowFrustum = null, sx = 0, sy = 1, sz = 0;
    if (sun) {
      sun.updateMatrixWorld();
      sun.target.updateMatrixWorld();
      sun.shadow.updateMatrices(sun);
      shadowFrustum = sun.shadow.getFrustum();
      const se = sun.matrixWorld.elements, te = sun.target.matrixWorld.elements;
      sx = se[12] - te[12]; sy = se[13] - te[13]; sz = se[14] - te[14];
      const l = Math.hypot(sx, sy, sz) || 1;
      sx /= l; sy = Math.max(0.2, sy / l); sz /= l; // towards the sun
    }
    const ce = camera.matrixWorld.elements, cx = ce[12], cy = ce[13], cz = ce[14];
    const pe = this.parent.matrixWorld.elements;
    const slots = this.slots;
    for (let i = 0; i < slots.length; i++) { const sl = slots[i]; sl.nA = sl.nB = sl.nC = 0; sl.bits = 0; }

    // classify: [0] shadow only, [1] shown + shadow, [2] shown only
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      r.slot = null;
      if (r.stamp !== stamp) continue;
      const d = r.data, m = r.model;
      const lx = d[3], ly = d[7], lz = d[11]; // the instance origin in parent space
      const wx = pe[0] * lx + pe[4] * ly + pe[8] * lz + pe[12];
      const wy = pe[1] * lx + pe[5] * ly + pe[9] * lz + pe[13];
      const wz = pe[2] * lx + pe[6] * ly + pe[10] * lz + pe[14];
      const s = Math.sqrt(Math.max(d[0] * d[0] + d[4] * d[4] + d[8] * d[8], d[1] * d[1] + d[5] * d[5] + d[9] * d[9], d[2] * d[2] + d[6] * d[6] + d[10] * d[10]));
      if (!(s > 1e-6)) continue;
      const rad = (m.fam.reach + m.reach) * s;
      _sph.center.set(wx, wy, wz);
      _sph.radius = rad;
      const shown = _frustum.intersectsSphere(_sph);
      let cast = shown;
      if (shadowFrustum) {
        cast = shadowFrustum.intersectsSphere(_sph);
        if (cast && !shown) {
          // its shadow: the sphere swept away from the sun down to the ground (~ its own height below its top)
          const len = (2 * rad) / sy;
          _sph.center.set(wx - sx * len * 0.5, wy - sy * len * 0.5, wz - sz * len * 0.5);
          _sph.radius = rad + len * 0.5;
          cast = _frustum.intersectsSphere(_sph);
        }
      }
      if (!shown && !cast) continue;
      // LOD by distance ÷ scale, with hysteresis
      const dist = Math.hypot(wx - cx, wy - cy, wz - cz) / s, D = m.dists;
      let lv = r.lod;
      if (lv < 0 || lv >= D.length) { lv = 0; while (lv + 1 < D.length && dist > D[lv + 1]) lv++; } else {
        while (lv + 1 < D.length && dist > D[lv + 1] * LOD_HYST) lv++;
        while (lv > 0 && dist < D[lv] / LOD_HYST) lv--;
      }
      r.lod = lv;
      const sl = m.slots[lv];
      r.slot = sl;
      r.cls = shown ? (cast ? 1 : 2) : 0;
      if (r.cls === 0) sl.nA++; else if (r.cls === 1) sl.nB++; else sl.nC++;
      sl.bits |= d[23];
    }

    // lay the slots out: [A | B | C] each; the colour pass draws B + C, the shadow pass A + B
    let n = 0, drawn = 0, shadowed = 0;
    for (let i = 0; i < slots.length; i++) {
      const sl = slots[i];
      const total = sl.nA + sl.nB + sl.nC;
      sl.start = n;
      sl.cur[0] = n; sl.cur[1] = n + sl.nA; sl.cur[2] = n + sl.nA + sl.nB;
      sl.baseU.value = n + sl.nA;
      sl.shadowBaseU.value = n;
      for (let k = 0; k < sl.parts.length; k++) { const p = sl.parts[k]; p.mesh.visible = total > 0 && (!p.need || (sl.bits & p.need) !== 0); }
      n += total;
      drawn += sl.nB + sl.nC;
      shadowed += sl.nA + sl.nB;
    }
    this.drawn = drawn;
    this.shadowed = shadowed;
    if (n > this.instCap) this.growInstances(n);
    const out = this.instU.value.image.data;
    for (let i = 0; i < list.length; i++) {
      const r = list[i], sl = r.slot;
      if (!sl) continue;
      out.set(r.data, sl.cur[r.cls]++ * FLOATS);
    }
    if (n) this.instU.value.needsUpdate = true;
  }

  /** Instance counts and GPU bytes of the animation, joint and instance textures. */
  stats() {
    let animBytes = 0, jointBytes = 0;
    for (const f of this.families.values()) animBytes += f.width * f.rows * 8;
    for (const m of this.ready.values()) jointBytes += m.jointTex.image.data.byteLength;
    return { instances: this.list.length, drawn: this.drawn, shadow: this.shadowed, animBytes, jointBytes, instanceBytes: this.instCap * FLOATS * 4 };
  }
}
