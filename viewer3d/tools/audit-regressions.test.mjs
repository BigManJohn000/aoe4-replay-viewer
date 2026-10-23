import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as THREE from '../vendor/three/build/three.module.js';

// Run the renderer's real geometry method without creating a WebGL context or DOM atlas.
const fxSource = readFileSync(new URL('../fx3d.js', import.meta.url), 'utf8');
const fx = vm.runInNewContext(fxSource.replace(/^import .*;$/m, '').replace('export class CombatFx3D', 'class CombatFx3D') + '\nCombatFx3D;', { THREE });
test('ring inner and outer edges both conform to a slope', () => {
  const host = {
    hs: new Float32Array(260), hsIn: new Float32Array(260), cs: new Float32Array(260), sn: new Float32Array(260),
    heightAt: (x, z) => x + 2 * z, atlas: { solid: { u0: 0, u1: 1, v0: 0, v1: 1 } },
  };
  const vertices = [], batch = { room: () => true, vert: (...v) => vertices.push(v) };
  fx.prototype.ring.call(host, batch, 3, 4, 2, 0.2, { r: 1, g: 1, b: 1 }, 1);
  assert.ok(vertices.length > 0);
  for (const [x, y, z] of vertices) assert.ok(Math.abs(y - (x - 2 * z + 0.35)) < 2e-6);
});

// Isolate the pure validator from the asset-build entry point (which would invoke the game toolchain).
const builder = readFileSync(new URL('./build-assets.mjs', import.meta.url), 'utf8');
const start = builder.indexOf('function validateAnimations('), end = builder.indexOf('\nasync function main()', start);
const validate = vm.runInNewContext(builder.slice(start, end) + '\nvalidateAnimations;');
test('animation validation rejects dangling bases, overlays and jobs', () => {
  for (const entry of [{ base: 'missing' }, { base: 'horse', extra: ['missing'] }, { base: 'horse', jobs: { farm: 'missing' } }])
    assert.throws(() => validate({ archetypes: { horse: {} }, blueprints: { cavalry: entry } }), /Dangling animation archetype/);
  assert.doesNotThrow(() => validate({ archetypes: { horse: {} }, blueprints: { cavalry: { base: 'horse', extra: ['horse'], jobs: { farm: 'horse' } } } }));
});
test('published animation mappings all resolve, including noble cavalry', () => {
  const index = JSON.parse(readFileSync(new URL('../assets/anims/index.json', import.meta.url), 'utf8'));
  validate(index);
  assert.equal(index.blueprints.unit_noble_cavalry_cmp_eng.base, 'base_horse_combined');
});

// Run viewer.js's real unitAnim and its stop / drop-off / heal timing over hand-made tracks: the clip tables, props and
// pose mixer are stubbed (they need the baked GLBs), the motion (core place), gait and timing code is the shipped code.
const core = await import('../core/replay.js');
const viewerSrc = readFileSync(new URL('../viewer.js', import.meta.url), 'utf8');
const fnSrc = (n) => { const s = viewerSrc.indexOf(`\nfunction ${n}(`); assert.ok(s >= 0, n); return viewerSrc.slice(s, viewerSrc.indexOf('\n}\n', s) + 3); };
const constSrc = (n) => { const m = viewerSrc.match(new RegExp(`\\nconst ${n} = [^\\n]*;`)); assert.ok(m, n); return m[0]; };
const clip = (state, key, dur = 1, extra = {}) => ({ id: `${key}/${state}`, state, dur, ...extra });
const tableFor = (key) => {
  const T = { ranged: false };
  for (const st of ['idle', 'guard', 'aim', 'fire', 'reload', 'attack', 'convert', 'throw', 'flinch', 'death', 'dead', 'work',
    'tool_idle', 'carry_idle', 'stop', 'dropoff', 'heal', 'walk', 'jog', 'run', 'sprint', 'tool_walk', 'tool_run', 'carry_walk', 'carry_run']) T[st] = [];
  T.idle = [clip('idle', key, 4)]; T.walk = [clip('walk', key, 1, { move: 1.6 })]; T.stop = [clip('stop', key, 0.8)];
  T.heal = [clip('heal', key, 2)]; T.work = [clip('work', key, 1.5)]; T.dropoff = [clip('dropoff', key, 1.2)];
  return T;
};
const tables = new Map(), mixed = [], R3 = { combat: { heals: [] } }; // R3: the viewer's R (only its heals are read)
const anim = vm.runInNewContext(
  ['XF', 'BLOW_LEAD', 'BLOW_HOLD', 'JOB_KEY', 'GAITS', 'GAIT_U', 'STOP_LEAD', 'oneOf', 'nthOf', 'loopT', 'holdT', 'win', 'gaitAdd'].map(constSrc).join('\n')
  + ['gaitsOf', 'odoOf', 'unitOdo', 'cruiseOf', 'stopsOf', 'dropsOf', 'healsOf', 'gaitPos', 'unitAnim'].map(fnSrc).join('') + '\nunitAnim;',
  {
    ...core, R: R3, ANIMS: { blueprints: {} }, sstep: THREE.MathUtils.smoothstep,
    clipTable: (bp, key) => tables.get(key) ?? (tables.set(key, tableFor(key)), tables.get(key)),
    propsOf: () => ({ gear: 0, main: 0, torch: 0, tools: new Map() }), propOf: () => 0, fireClip: () => null,
    mixAdd: (h, tt, w) => (h && w > 1e-3 ? (mixed.push({ id: h.id, state: h.state, w }), w) : 0), mixOut: () => mixed.splice(0),
    _mix: { n: 0 }, _us: {},
  });
/** A unit at x along a straight line, one sample per 0.5 s; job codes optional. */
function walker(xs, job) {
  const n = xs.length, e = {
    id: 7, bp: 'u', seed: 0, on: true, died: null, t: Float64Array.from(xs, (_, k) => k * core.SAMPLE),
    x: Float64Array.from(xs), z: new Float64Array(n), hp: new Float64Array(n).fill(100), mv: null, exV: null,
    blows: null, stT: null, hitT: null, stopT: null, drops: null, heal: null, job: null,
  };
  if (job) Object.assign(e, { job: Uint8Array.from(job), jobT0: new Float64Array(n), jobT1: new Float64Array(n).fill(1e9), jobOut: new Uint8Array(n) });
  return e;
}
const pose = (e, t, c = { eng: 0 }) => {
  const L = core.place(e, t);
  e.px = L.x; e.pz = L.z;
  return anim(e, {}, t, c, Math.max(0, core.idxAt(e.t, t)), 1);
};
const weight = (mix, state) => mix.filter((m) => m.state === state).reduce((s, m) => s + m.w, 0);

test('an arrival that pauses plays the stop clip, never while walking, the same after a seek', () => {
  const xs = [0, 1, 2, 3, 4, 5, 5, 5, 5, 5, 5, 5, 5]; // walks 2 m/s until 2.5 s, then stands
  const e = walker(xs), times = [1, 1.5, 2.2, 2.6, 2.85, 3.1, 4.5];
  const play = times.map((t) => pose(e, t));
  assert.equal(weight(play[0], 'stop'), 0);
  assert.ok(weight(play[0], 'walk') > 0.9);
  assert.ok(weight(play[4], 'stop') > 0.5);
  assert.equal(weight(play[6], 'stop'), 0); // the clip (0.8 s) is over: idle
  const seek = times.slice().reverse().map((t) => pose(walker(xs), t)).reverse();
  assert.deepEqual(seek, play);
});

test('a drop-off plays the load\'s dropoff clip, but not when the villager goes straight to work', () => {
  const carry = core.CARRY + core.J_WOOD, xs = [0, 1, 2, 3, 3, 3, 3, 3, 3];
  const idle = walker(xs, [carry, carry, carry, carry, 0, 0, 0, 0, 0]); // the load walk ends at 2 s
  const m = pose(idle, 2.3);
  assert.ok(weight(m, 'dropoff') > 0.5);
  assert.equal(m.find((x) => x.state === 'dropoff').id, 'wood/dropoff');
  const work = walker(xs, [carry, carry, carry, carry, core.J_WOOD, core.J_WOOD, core.J_WOOD, core.J_WOOD, core.J_WOOD]);
  assert.equal(weight(pose(work, 2.3), 'dropoff'), 0);
  const through = walker([0, 1, 2, 3, 4, 5, 6, 7], [carry, carry, carry, carry, 0, 0, 0, 0]); // walks on past the drop
  for (const t of [2.1, 2.3, 2.6]) assert.equal(weight(pose(through, t), 'dropoff'), 0);
});

test('a healer loops its heal clip through its heals, not after them nor while it fights', () => {
  const e = walker([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  R3.combat.heals = [{ healer: e, t0: 2, t1: 3 }, { healer: e, t0: 3.5, t1: 4 }]; // under 1 s apart: one span
  try {
    assert.ok(weight(pose(e, 2.5), 'heal') > 0.9);
    assert.ok(weight(pose(e, 3.25), 'heal') > 0.9);
    assert.equal(weight(pose(e, 5), 'heal'), 0);
    assert.equal(weight(pose(e, 2.5, { eng: 1, ref: { b: { on: true }, mobile: true } }), 'heal'), 0);
  } finally { R3.combat.heals = []; }
});
