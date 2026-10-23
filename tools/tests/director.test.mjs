import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ window: {} });
for (const name of ['units', 'stats', 'frame', 'model', 'director']) {
  new vm.Script(fs.readFileSync(new URL(`../../viewer/${name}.js`, import.meta.url), 'utf8')).runInContext(context);
}
const RV = context.window.RV;

// Two fights: A (#1) around the origin from 20 to 60 s, B (#2) 200 m east from 30 to 50 s with much costlier kills,
// and one lone kill (a raid) far away at 80 s.
const unit = (id, x, z, died = null, value = 100) =>
  ({ id, cat: 'infantry', value, t: [0], x: [x], z: [z], hp: [100], spans: [0, died ?? Infinity] });
const ents = [
  unit(1, -5, 0), unit(2, 15, 0), unit(3, 100, 0), // A's units; 3 is out of A's reach
  unit(4, 195, 0), unit(5, 205, 0),                 // B's units
  unit(10, 0, 5, 25, 50),                           // killed in A
  unit(11, 200, 5, 32, 400), unit(12, 200, 5, 33, 400), unit(13, 200, 5, 34, 400), // killed in B
  unit(20, -300, 100, 80, 50),                      // the raid
];
const M = {
  byId: new Map(ents.map(e => [e.id, e])),
  fights: [
    { id: 1, start: 20, end: 60, x: 0, z: 0, radius: 20, units: [1, 2, 3] },
    { id: 2, start: 30, end: 50, x: 200, z: 0, radius: 20, units: [4, 5] },
  ],
  kills: [[25, 10], [32, 11], [33, 12], [34, 13], [80, 20]].map(([t, victim]) => ({ t, victim, killer: null })),
};
const play = (director, from, to) => {
  const labels = {};
  for (let t = from; t <= to; t++) labels[t] = director.shot(t)?.label ?? null;
  return labels;
};

test('the camera gets to a fight RV.FIGHT_LEAD s before its first blow, not earlier', () => {
  const labels = play(RV.director(M), 10, 16);
  assert.equal(labels[14], null);
  assert.equal(labels[15], 'Fight 1');
});

test('it stays on the current fight and cuts away only to one SWITCH times hotter', () => {
  const labels = play(RV.director(M), 15, 30);
  assert.equal(labels[28], 'Fight 1'); // B is on from 25 but has no kills yet
  assert.equal(labels[29], 'Fight 2'); // B's first 400-resource kill enters the 3 s look-ahead
});

test('it holds a fight for DWELL s before cutting away, however hot the other gets', () => {
  const director = RV.director(M);
  assert.equal(director.shot(27).label, 'Fight 1');
  assert.equal(play(director, 28, 32)[32], 'Fight 1');
  assert.equal(director.shot(33).label, 'Fight 2');
});

test('after cut() (a seek, even +5 s) it picks the hottest fight at once', () => {
  const director = RV.director(M);
  assert.equal(director.shot(27).label, 'Fight 1');
  director.cut(); // the viewer seeks 27 → 32: within DWELL, which would otherwise hold Fight 1
  assert.equal(director.shot(32).label, 'Fight 2');
});

test("the view centres on the fight's units in reach and frames their spread", () => {
  const s = RV.director(M).shot(55); // B is over: A alone
  assert.equal(s.label, 'Fight 1');
  assert.deepEqual([s.x, s.z, s.r], [5, 0, 20]); // unit 3 at x = 100 is out of reach; spread 10 m → MIN_R
});

test('between fights it shows a lone kill, then holds that shot once nothing happens', () => {
  const director = RV.director(M);
  director.shot(78);
  const raid = director.shot(82);
  assert.equal(raid.label, 'Skirmish');
  assert.deepEqual([raid.x, raid.z], [-300, 100]);
  const later = play(director, 83, 95);
  assert.equal(later[95], 'Skirmish');
  assert.deepEqual(director.shot(96), raid);
});
