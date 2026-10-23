import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function techRow({ age = 100, delay = 0, researched = true } = {}) {
  const context = vm.createContext({ window: {} });
  for (const name of ['units', 'stats', 'frame', 'model', 'fights', 'eco']) {
    new vm.Script(fs.readFileSync(new URL(`../../viewer/${name}.js`, import.meta.url), 'utf8')).runInContext(context);
  }
  const W = context.window;
  const key = 'upgrade_econ_resource_wood_harvest_rate_2';
  const benchmark = (age ?? 100) + W.RV_ECO.BENCH['double-broadax'].civ.english;
  const d = { duration: 1200, capturedEnd: 1200, players: [{ idx: 1, team: 1, civ: 'english' }],
    techs: age == null ? [] : [[age, 1, 'Feudal Age', 'age']],
    jobs: { 1: [[0, 0, 10, 0, 0, 0], [1200, 0, 10, 0, 0, 0]] }, stats: { 1: [] } };
  const C = W.RV_FRAME.combat([], d);
  if (researched) C.upgrades.set(1, [{ t: benchmark + delay, key, tech: W.RV_FRAME.techOf(key) }]);
  return W.RV_ECO.analyze(d, C).players.get(1).techs.find(row => row.id === 'double-broadax');
}

test('B11: paid on-time technology has zero deficit and no capitalization verdict', () => {
  const row = techRow();
  assert.equal(row.status, 'ontime');
  assert.ok(row.costTotal > 0);
  assert.equal(row.missed, 0);
  assert.equal(row.deficit, 0);
  assert.equal(row.capitalized.applies, false);
  assert.equal(row.capitalized.label, 'On time');
});

test('B11: no benchmark produces null deficit, not a fictitious cost saving', () => {
  const row = techRow({ age: null, researched: false });
  assert.equal(row.status, 'na');
  assert.ok(row.costTotal > 0);
  assert.equal(row.deficit, null);
  assert.equal(row.capitalized.applies, false);
  assert.equal(row.capitalized.label, 'n/a');
});

test('B11: late technology retains missed minus cost, including negative opportunity costs', () => {
  const row = techRow({ delay: 100 });
  assert.equal(row.status, 'late');
  assert.ok(Math.abs(row.missed - 10 * 0.65 * 0.15 * 100) < 1e-9);
  assert.equal(row.deficit, row.missed - row.costTotal);
  assert.ok(row.deficit < 0);
  assert.equal(row.capitalized.applies, true);
});

test('B11: never-researched technology retains missed minus cost', () => {
  const row = techRow({ researched: false });
  assert.equal(row.status, 'never');
  assert.ok(row.missed > 0);
  assert.equal(row.deficit, row.missed - row.costTotal);
});
