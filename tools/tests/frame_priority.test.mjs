import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture() {
  const context = vm.createContext({ window: {} });
  for (const name of ['units', 'stats', 'frame', 'model', 'fights', 'eco']) {
    let source = fs.readFileSync(new URL(`../../viewer/${name}.js`, import.meta.url), 'utf8');
    // Expose the private damage function only inside this test VM; production exports stay unchanged.
    if (name === 'frame') source = source.replace(/\}\)\(\);\s*$/, 'window.testHitDamage = hitDamage; })();');
    new vm.Script(source).runInContext(context);
  }
  const W = context.window, F = W.RV_FRAME;
  const stats = (b, arm = 0, damage = 10, mods = []) => ({ b, hp: 100, cls: [b], arm: { ranged: arm },
    main: { damage: 'Ranged', range: 10 }, wp: [{ ty: 'ranged', dmg: damage, per: 1, rmax: 10, mods }] });
  Object.assign(W.RV_STATS.units, {
    test_archer_2: stats('archer'), test_defender_2: stats('defender'), test_reference_2: stats('reference'),
    test_archer_3: stats('archer', 0, 14, [{ e: 'change', c: [['defender']], v: 4 }]),
    test_defender_3: stats('defender', 3),
  });
  W.RV_STATS.techs.test_ranged_armour = { n: 'Ranged armour +2', eff: [{ p: 'rangedArmor', e: 'change', v: 2, id: ['defender'] }] };
  const entity = (id, bp, owner, x) => ({ id, bp, owner, cat: 'ranged', value: 100, maxhp: 100,
    born: 0, died: null, spans: [0, 100], t: [0], x: [x], z: [0], hp: [100] });
  const ents = [entity(1, 'test_archer_2', 1, 0), entity(2, 'test_defender_2', 2, 1), entity(3, 'test_reference_2', 2, 2)];
  const C = F.combat(ents, { players: [{ idx: 1, team: 1 }, { idx: 2, team: 2 }],
    upgrades: [{ t: 10, fields: { upgrade: 'btest_ranged_armour', executer: 'e2' } }] });
  C.atkT = [5, 10, 15]; C.atkP = [[1, 2], [1, 2], [1, 2]];
  return { W, F, C, ents };
}

test('B09: +2 researched ranged armour lowers archer hit damage and target priority by exactly 2', () => {
  const { W, F, C, ents: [a, b] } = fixture();
  const sa = F.statsAt(C, a, 10), before = F.statsAt(C, b, 5), after = F.statsAt(C, b, 10);
  const weapon = sa.st.wp[0];
  const oldDamage = W.testHitDamage(weapon, before.st, sa, before);
  const newDamage = W.testHitDamage(weapon, after.st, sa, after);
  assert.equal(after.arm.ranged - before.arm.ranged, 2);
  assert.equal(oldDamage - newDamage, 2);
  assert.equal(F.effAt(C, 0)[0], 1);
  assert.ok(Math.abs(F.effAt(C, 1)[0] - newDamage / oldDamage) < 1e-7);
});

test('B09: priority uses upgraded attacker weapon bonuses and defender tier armour', () => {
  const { F, C, ents: [a, b] } = fixture();
  a.ups = [[10, 3, 'Veteran']]; b.ups = [[10, 3, 'Veteran']];
  // At tier 3 the target takes 14 + 4 bonus - (3 base + 2 researched) = 13, versus 14 on the reference.
  assert.equal(F.effAt(C, 0)[0], 1);
  assert.ok(Math.abs(F.effAt(C, 1)[0] - 13 / 14) < 1e-7);
});

test('B09: candidate scoring resolves stats once per unit per sample, including reverse seeks', () => {
  const { F, C } = fixture();
  C.atkP[1] = [1, 2, 1, 3, 1, 2];
  let calls = 0;
  const statsAt = F.statsAt;
  F.statsAt = (...args) => { calls++; return statsAt(...args); };
  F.effAt(C, 1);
  assert.equal(calls, 3);
  F.effAt(C, 1);
  assert.equal(calls, 3);
  F.effAt(C, 2);
  assert.equal(calls, 6);
  assert.equal(F.effAt(C, 0)[0], 1);
  assert.equal(calls, 9);
});
