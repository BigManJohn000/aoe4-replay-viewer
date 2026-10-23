import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function analyze({ end = 30, death = null, spans, jobs = null, capturedEnd = 40, duration = 100 } = {}) {
  const context = vm.createContext({ window: {} });
  for (const name of ['units', 'stats', 'frame', 'model', 'fights', 'eco']) {
    new vm.Script(fs.readFileSync(new URL(`../../viewer/${name}.js`, import.meta.url), 'utf8')).runInContext(context);
  }
  const W = context.window;
  W.RV_STATS.units.test_idle_unit = { b: 'idle-unit', hp: 100, cls: [], arm: {}, cost: { f: 100 },
    main: { damage: 'Melee', range: 2, period: 1 }, wp: [{ ty: 'melee', dmg: 10, per: 1, rmax: 2 }] };
  const unit = (id, owner) => ({ id, owner, bp: 'test_idle_unit', cat: 'infantry', value: 100,
    maxhp: 100, born: 0, died: null, spans: [0, 100], t: [0], x: [id], z: [0], hp: [100] });
  const victim = unit(1, 1), enemy = unit(2, 2);
  victim.died = death;
  victim.spans = spans || [0, death ?? 100];
  if (jobs) {
    victim.cat = 'villager';
    victim.t = [0, 21]; victim.x = [1, 1]; victim.z = [0, 0]; victim.hp = [100, 90];
  }
  const fight = { id: 1, start: 20, end, x: 0, z: 0, radius: 10, participants: [1, 2], units: [1, 2], losses: {} };
  const d = { duration, capturedEnd, players: [{ idx: 1, team: 1, civ: 'english' }, { idx: 2, team: 2, civ: 'english' }],
    fights: [fight], jobs: { 1: jobs || [], 2: [] }, stats: { 1: [], 2: [] },
    attacks: jobs ? { times: [21], pairs: [[2, 1]] } : { times: [], pairs: [] } };
  const C = W.RV_FRAME.combat([victim, enemy], d);
  return W.RV_FIGHTS.analyze(d, C, 0);
}

const idle = opts => analyze(opts).idle[1].idle.find(row => row.id === 1)?.idleSecs ?? 0;
const forced = opts => {
  const result = analyze(opts).eco[1];
  assert.equal(result.villagersHit, true);
  assert.equal(result.gatherersNoise, 0);
  return result.forcedIdle;
};
const job = (t, gatherers) => [t, gatherers, 0, 0, 0, 0];

test('B08: exactly ten idle seconds is 10, not 12.5', () => {
  assert.equal(idle(), 10);
});

test('B08: fractional final interval is clipped to the fight end', () => {
  assert.equal(idle({ end: 28.25 }), 8.25);
});

test('B08: death between 2.5-second checks clips the alive interval', () => {
  assert.equal(idle({ death: 28.25 }), 8.25);
});

test('B08: gaps between alive spans are not credited', () => {
  assert.equal(idle({ spans: [0, 26, 27, 100] }), 9);
});

test('B08: endpoint alone cannot create a five-second idle row', () => {
  assert.equal(idle({ end: 22.5 }), 0);
});

test('B10: one villager pulled over [25, 35) contributes exactly ten villager-seconds', () => {
  assert.equal(forced({ jobs: [job(0, 1), job(25, 0), job(35, 1)] }), 10);
});

test('B10: final held job interval runs to the observed data end, not the last job sample', () => {
  assert.equal(forced({ jobs: [job(0, 1), job(25, 0)] }), 15);
});

test('B10: villager death between samples removes the shortfall from its exact time', () => {
  assert.equal(forced({ jobs: [job(0, 1), job(25, 0)], death: 28.25 }), 3.25);
});

test('B10: simultaneous death and job change do not double-count the interval', () => {
  assert.equal(forced({ jobs: [job(0, 1), job(25, 0)], death: 25 }), 0);
});

test('B10: flee allowance is bounded by fight end plus twenty seconds', () => {
  assert.equal(forced({ jobs: [job(0, 1), job(25, 0)], capturedEnd: 100 }), 25);
});

test('B10: legacy recordings without capturedEnd use duration as their upper bound', () => {
  assert.equal(forced({ jobs: [job(0, 1), job(25, 0)], capturedEnd: null, duration: 32 }), 7);
});
