import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ window: {} });
for (const name of ['units', 'stats', 'frame', 'model', 'director']) {
  new vm.Script(fs.readFileSync(new URL(`../../viewer/${name}.js`, import.meta.url), 'utf8')).runInContext(context);
}
const RV = context.window.RV;

// A unit sampled at times ts: hp[i] at (x, z) (or xs[i], zs[i] when given), alive until died.
const unit = (id, { ts, hp, x = 0, z = 0, xs, zs, value = 100, cat = 'infantry', maxhp = 100, died = null }) =>
  ({ id, cat, value, maxhp, t: ts, x: xs ?? ts.map(() => x), z: zs ?? ts.map(() => z), hp, spans: [0, died ?? Infinity] });
// hp losing `step` at each of the times in `hits` (sampled every second from 0 to end)
const bleeding = (hits, step, end = 60) => {
  const ts = [], hp = [];
  let h = 100;
  for (let t = 0; t <= end; t++) { if (hits.includes(t)) h = Math.max(1, h - step); ts.push(t); hp.push(h); }
  return { ts, hp };
};
const model = (ents, { kills = [], atk = [], cameras } = {}) => ({
  byId: new Map(ents.map(e => [e.id, e])), fights: [], kills,
  atkT: Float64Array.from(atk, a => a[0]), atkP: atk.map(a => a[1]), cameras,
});
const range = (a, b, step = 1) => Array.from({ length: Math.floor((b - a) / step) + 1 }, (_, i) => a + i * step);
const near = (s, x, z, tol = 5) => s && Math.hypot(s.x - x, s.z - z) <= tol;

test('the camera is at the damage from 2 s before it starts, not earlier than 6 s', () => {
  const M = model([unit(1, { ...bleeding(range(25, 35), 5), x: 100, z: 50 })]);
  assert.equal(RV.director(M).shot(18), null);
  const d = RV.director(M);
  assert.ok(near(d.shot(23), 100, 50));
});

test('damage to costly units outweighs a cheap kill elsewhere', () => {
  const M = model([
    unit(1, { ts: [0, 30], hp: [100, 0], value: 30, x: 200, died: 30 }),
    ...[2, 3, 4].map(id => unit(id, { ts: [0, 30], hp: [100, 50], value: 300, x: -200 })),
  ], { kills: [{ t: 30, victim: 1, killer: null }] });
  assert.ok(near(RV.director(M).shot(30), -200, 0, 20));
});

test('it holds a scene against one 1.15× hotter, and gives way to one 1.5× hotter after DWELL', () => {
  const steady = unit(1, { ...bleeding(range(1, 60), 1), value: 100 });
  for (const [k, stays] of [[1.15, true], [1.6, false]]) {
    const rival = unit(2, { ...bleeding(range(10, 60), 1), value: 100 * k, x: 300 });
    const d = RV.director(model([steady, rival]));
    for (let t = 2; t <= 40; t += 0.5) d.shot(t);
    assert.ok(near(d.shot(40), stays ? 0 : 300, 0, 20), `rival ${k}×`);
  }
});

test('a scene where nothing happens any more gives way at once to damage elsewhere', () => {
  const d = RV.director(model([
    unit(1, { ...bleeding(range(1, 10), 5), value: 1000 }),
    unit(2, { ...bleeding(range(13, 30), 1), value: 25, x: 300 }),
  ]));
  for (let t = 2; t < 14; t += 0.5) assert.ok(near(d.shot(t), 0, 0, 20), `t ${t}`); // its last hit at 10 fades out at 14
  assert.ok(near(d.shot(14.5), 300, 0, 20)); // then at once, although the small scene is not 1.5× hotter
});

test('after cut() (a seek) it picks the hottest place at once, even within DWELL', () => {
  const M = model([
    unit(1, { ...bleeding(range(1, 60), 1), value: 100 }),
    unit(2, { ...bleeding(range(20, 60), 2), value: 300, x: 300 }),
  ]);
  const d = RV.director(M);
  assert.ok(near(d.shot(10), 0, 0, 20));
  const before = d.shot(10).scene;
  d.cut();
  const s = d.shot(21);
  assert.ok(near(s, 300, 0, 20));
  assert.notEqual(s.scene, before);
});

test('the shot frames the units hit, their attackers in reach and where they are headed, not distant artillery', () => {
  const ts = range(0, 40);
  const M = model([
    unit(1, { ts, hp: ts.map(t => (t < 20 ? 100 : 100 - (t - 20) * 3)), xs: ts.map(t => t), zs: ts.map(() => 0) }), // fleeing east
    unit(2, { ts, hp: ts.map(() => 100), x: -30, z: 10 }),  // an archer shooting it
    unit(3, { ts, hp: ts.map(() => 100), x: -150, z: 0 }), // a trebuchet far away
  ], { atk: range(18, 40).map(t => [t, [2, 1, 3, 1]]) });
  const d = RV.director(M);
  const s = d.shot(25);
  const pts = [];
  for (let i = 0; i < s.pts.length; i += 2) pts.push([s.pts[i], s.pts[i + 1]]);
  assert.ok(pts.some(([x, z]) => Math.abs(x - 25) < 1 && z === 0), 'the victim now');
  assert.ok(pts.some(([x, z]) => Math.abs(x - 27) < 1 && z === 0), 'the victim in LEAD s');
  assert.ok(pts.some(([x, z]) => x === -30 && z === 10), 'its attacker');
  assert.ok(!pts.some(([x]) => x === -150), 'not the trebuchet 175 m away');
  assert.ok(Math.abs(d.shot(35).pts[0] - 35) < 1, 'the scene moves with the chase');
});

test("a player's own camera on one of two equal scenes tips the choice to it", () => {
  const ents = [
    unit(1, { ...bleeding(range(1, 30), 2), x: -300 }),
    unit(2, { ...bleeding(range(1, 30), 2), x: 300 }),
  ];
  const down = Math.SQRT1_2; // looking straight down: forward (0, 0, 1) turned onto (0, -1, 0)
  const cam = x => new Map([[1, { t: Float64Array.of(0), eye: Float32Array.of(x, 100, 0), rot: Uint16Array.of(0), rots: [[down, down, 0, 0]], fov: 40 }]]);
  for (const x of [-300, 300]) assert.ok(near(RV.director(model(ents, { cameras: cam(x) })).shot(10), x, 0, 20), `camera at ${x}`);
});

test('shotExtent measures the points along the screen axes, at least minHalf', () => {
  const s = { x: 0, z: 0, pts: [100, 0, -40, 30] };
  assert.deepEqual([...RV.shotExtent(s, 1, 0, 0, 1)], [100, 30]);
  assert.deepEqual([...RV.shotExtent(s, 0, 1, 1, 0)], [30, 100]); // turned a quarter
  assert.deepEqual([...RV.shotExtent({ x: 0, z: 0, pts: [1, 1] }, 1, 0, 0, 1)], [20, 20]);
  assert.equal(RV.shotExtent({ x: 0, z: 0, pts: [] }, 1, 0, 0, 1), null);
});
