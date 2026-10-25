import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function engines() {
  const context = vm.createContext({ window: {} });
  for (const name of ['units', 'stats', 'frame', 'model', 'fights', 'eco']) {
    let source = fs.readFileSync(new URL(`../../viewer/${name}.js`, import.meta.url), 'utf8');
    // Exercise private arithmetic with controlled observations, without production-only test APIs.
    if (name === 'eco') source = source.replace(/\}\)\(\);\s*$/, 'window.ecoMath = { ledger, integrate, measureRates, impactOf, buildEnv }; })();');
    if (name === 'frame') source = source.replace(/\}\)\(\);\s*$/, 'window.frameMath = { typeDamage }; })();');
    new vm.Script(source).runInContext(context);
  }
  return { W: context.window, context };
}
const players = (n = 2) => Array.from({ length: n }, (_, i) => ({ idx: i + 1, team: i + 1, name: `P${i + 1}`, civ: 'english', color: '#fff' }));
const unit = (id, owner, x = id) => ({ id, owner, bp: 'test_unit', cat: 'infantry', value: 100, maxhp: 100,
  born: 0, died: null, spans: [0, 1000], t: [0], x: [x], z: [0], hp: [100] });
function addStats(W, bp = 'test_unit', cost = 100) {
  W.RV_STATS.units[bp] = { b: bp, hp: 100, cls: [], arm: {}, cost: { f: cost, total: cost },
    main: { damage: 'Melee', range: 4, period: 1 }, wp: [{ ty: 'melee', dmg: 10, per: 1, rmax: 1 }] };
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);

test('fight what-if text reports the selected side probability, matching its losses and the A/B bar', () => {
  const { W, context } = engines(); addStats(W);
  const a = unit(1, 1, 0), b = unit(2, 2, 1);
  const f = { id: 'probability-perspective', start: 0, end: 10, x: 0, z: 0, radius: 20, units: [1, 2], losses: {} };
  const d = { duration: 20, players: players(), fights: [f], jobs: {}, stats: {}, techs: [], attacks: { times: [1], pairs: [[1, 2]] } };
  const C = W.RV_FRAME.combat([a, b], d), A = W.RV_FIGHTS.analyze(d, C, f);
  const nodes = [];
  const el = (tag, attrs = {}, ...children) => {
    const n = { tag, ...attrs, children: children.flat(Infinity).filter(x => x != null),
      append(...xs) { this.children.push(...xs.flat(Infinity)); }, replaceChildren(...xs) { this.children = xs.flat(Infinity); },
      addEventListener() {} };
    nodes.push(n); return n;
  };
  W.RV_CARD = { el, grade: x => x };
  context.document = { createElement: tag => el(tag), head: { append() {} } };
  context.requestAnimationFrame = () => {};
  new vm.Script(fs.readFileSync(new URL('../../viewer/fightpanel.js', import.meta.url), 'utf8')).runInContext(context);
  W.RV_FIGHTPANEL.render(A, { t: 0 });
  const radios = nodes.filter(n => n.tag === 'input' && n.type === 'radio');
  const armor = nodes.find(n => n.tag === 'input' && n.type === 'checkbox' && !n['data-heat']);
  radios[1].onchange(); armor.onchange({ target: { checked: true } });
  const r = A.whatIf({ side: 'B', armor: 1, attack: 0 });
  const out = nodes.find(n => typeof n.textContent === 'string' && n.textContent.includes('expected losses:'));
  assert.ok(out.textContent.startsWith(`P2 wins ${Math.round((1 - r.base) * 100)} % → ${Math.round((1 - r.p) * 100)} % (+`), out.textContent);
  radios[0].onchange();
  const ra = A.whatIf({ side: 'A', armor: 1, attack: 0 });
  assert.ok(out.textContent.startsWith(`P1 wins ${Math.round(ra.base * 100)} % → ${Math.round(ra.p * 100)} % (+`), out.textContent);
});

test('M-03: ledger uses first-birth resource quotes, including zero, with catalogue fallback', () => {
  const { W } = engines(); addStats(W, 'test_unit', 600);
  const ents = [1, 2, 3, 4].map(id => ({ ...unit(id, 1), born: 10, cat: 'building' }));
  const d = { entities: [{ id: 1, cost: [0, 510, 0, 0] }, { id: 2, cost: null }, { id: 3 }, { id: 4, cost: [0, 0, 0, 0] }] };
  const rows = W.ecoMath.ledger({ ents }, d, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(rows.map(r => r.c))), [[0, 510, 0, 0], [600, 0, 0, 0], [600, 0, 0, 0]]);
});

test('M-04: caster income changes at completion and reverses correctly when seeking', () => {
  const { W, context } = engines();
  const nodes = [];
  const node = () => {
    const n = { children: [], style: { setProperty() {} }, setAttribute() {}, append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; }, insertBefore() {} };
    nodes.push(n); return n;
  };
  context.document = { createElement: node };
  context.RV = W.RV; context.RV_ECO = W.RV_ECO;
  const d = { duration: 1000, capturedEnd: 1000, recordStart: 0, players: players(), techs: [],
    jobs: { 1: [[0, 0, 10, 0, 0, 0]], 2: [] }, stats: { 1: [], 2: [] } };
  const C = W.RV_FRAME.combat([], d), key = 'upgrade_econ_resource_wood_harvest_rate_2';
  C.upgrades.set(1, [{ t: 100, key, tech: W.RV_FRAME.techOf(key) }]);
  const M = { d, combat: C, byId: C.byId, kills: [] };
  W.RV.armyAt = () => new Map(d.players.map(p => [p.idx, { villagers: 10, military: 0, armyValue: 0 }]));
  context.RV_ECODEBT = { prepare: () => ({ players: d.players.map(p => ({ p, windows: [] })) }) };
  new vm.Script(fs.readFileSync(new URL('../../viewer/caster.js', import.meta.url), 'utf8')).runInContext(context);
  const caster = W.RV_CASTER.create(node(), M);
  const income = () => nodes.filter(n => n.className === 'caster-income')[1].textContent;
  caster.update(99, true, 0, false); assert.equal(income(), '+390/min · 10 v');
  near(W.RV_ECO.multiplierAt(d, C, 1, 'wood', 100), 1.15);
  caster.update(100, true, 250, false); assert.equal(income(), `+${Math.round(10 * 0.65 * 1.15 * 60)}/min · 10 v`);
  caster.update(99, true, 500, false); assert.equal(income(), '+390/min · 10 v');
});

test('M-05: tempo kill and building damage follow converted actor and victim owners', () => {
  const { W } = engines();
  const attacker = { ...unit(1, 1), ownT: [0, 100], ownV: [1, 2] };
  const victim = unit(2, 1), building = { ...unit(3, 2), cat: 'building', ownT: [0, 100], ownV: [2, 1] };
  const d = { duration: 200, players: players(), fights: [], jobs: {}, stats: {}, kills: [{ t: 150, killer: 1, victim: 2 }] };
  const C = W.RV_FRAME.combat([attacker, victim, building], d);
  C.dmgT = [150]; C.dmgId = [3]; C.dmgAmt = [600];
  const env = W.ecoMath.buildEnv(d, C);
  const result = W.ecoMath.impactOf(env, 2, 50);
  assert.equal(result.kills, 1); assert.equal(result.killValue, 100); assert.equal(result.structureDamage, 600);
  const other = W.ecoMath.impactOf(env, 1, 50);
  assert.equal(other.kills, 0); assert.equal(other.structureDamage, 0);
});

test('M-06: upgraded hit weights divide a 30 HP drop 20/10 and conserve damage', () => {
  const { W } = engines(); addStats(W); addStats(W, 'test_upgraded');
  const a = { ...unit(1, 1), bp: 'test_upgraded' }, b = unit(2, 1), victim = unit(3, 2);
  const C = W.RV_FRAME.combat([a, b, victim], { players: players() });
  C.upgrades.set(1, [{ t: 10, key: 'attack', tech: { n: 'Attack', eff: [{ p: 'meleeAttack', e: 'change', v: 10, id: ['test_upgraded'] }] } }]);
  C.dmgT = [15]; C.dmgId = [3]; C.dmgAmt = [30]; C.dmgSrc = [[{ a, dtype: 'melee' }, { a: b, dtype: 'melee' }]];
  W.frameMath.typeDamage(C);
  near(C.dealt.get(1).v[0], 20); near(C.dealt.get(2).v[0], 10);
  near(C.dealt.get(1).v[0] + C.dealt.get(2).v[0], 30);
});

test('M-07: upgraded range admits a better target nine metres away', () => {
  const { W } = engines(); addStats(W);
  const a = unit(1, 1, 0), b = unit(2, 2, 3), c = unit(3, 2, 9); c.hp = [10];
  const C = W.RV_FRAME.combat([a, b, c], { players: players(), attacks: { times: [5, 15], pairs: [[1, 2], [1, 2]] } });
  C.upgrades.set(1, [{ t: 10, key: 'range', tech: { n: 'Range', eff: [{ p: 'maxRange', e: 'change', v: 2, id: ['test_unit'] }] } }]);
  near(W.RV_FRAME.effAt(C, 0)[0], 1);
  near(W.RV_FRAME.effAt(C, 1)[0], 0.1);
});

test('M-08: telemetry unions overlapping zones and clips actual occupancy to the seek time', () => {
  const { W } = engines(); addStats(W);
  const a = unit(1, 1, 0), b = unit(2, 2, 1);
  const fight = { start: 0, end: 2, x: 0, z: 0, radius: 5 };
  const d = { players: players(), fights: [fight, { ...fight }], attacks: { times: [0.5, 1], pairs: [[1, 2], [1, 2]] } };
  const C = W.RV_FRAME.combat([a, b], d);
  near(W.RV_FRAME.telemetry(C, a, 2).uptime, 0.5);
  near(W.RV_FRAME.telemetry(C, a, 1).uptime, 1);
  assert.equal(W.RV_FRAME.telemetry(C, a, 0).uptime, null);
  a.t = [0, 0.5, 1, 2]; a.x = [100, 100, 0, 0]; a.z = [0, 0, 0, 0]; a.hp = [100, 100, 100, 100];
  const moving = W.RV_FRAME.combat([a, b], d);
  assert.equal(W.RV_FRAME.telemetry(moving, a, 0.5).uptime, null);
  near(W.RV_FRAME.telemetry(moving, a, 2).uptime, 0); // both attack windows precede entry
});

test('M-09: missed integral splits a held two-second job at a modifier completion', () => {
  const { W } = engines();
  const P = { n: 2, T: [0, 2], end: 2, G: [[0, 0], [10, 10], [0, 0], [0, 0]], ev: [{ t: 1, slot: 'other', f: [1, 2, 1, 1] }] };
  const curve = [];
  const result = W.ecoMath.integrate(P, { wood: { rate: 1 } }, 'delayed', { wood: 2 }, [1], 0, 2, curve);
  near(result.missed, 30);
  assert.deepEqual(JSON.parse(JSON.stringify(curve)), [[0, 0], [1, 10], [2, 30]]);
});

test('M-09: base-rate calibration splits every modifier within held jobs', () => {
  const { W } = engines();
  const T = [0, 30, 60, 90, 120, 150, 180], ev = T.slice(0, -1).map(t => ({ t: t + 15, slot: `mod${t}`, f: [1, 1.1, 1, 1] }));
  const bank = [0];
  for (let i = 0; i < 6; i++) bank.push(bank[i] + 10 * 15 * (1.1 ** i + 1.1 ** (i + 1)));
  const P = { n: T.length, T, end: 180, ev, dt: [30, 30, 30, 30, 30, 30, 0], G: [T.map(() => 0), T.map(() => 10), T.map(() => 0), T.map(() => 0)],
    B: [T.map(() => 0), bank, T.map(() => 0), T.map(() => 0)], lt: [], lc: [[0], [0], [0], [0]] };
  const result = W.ecoMath.measureRates(P).wood;
  assert.equal(result.source, 'measured'); near(result.rate, 1);
});

test('M-10: three teams have per-team losses but no two-sided winner, odds or what-if', () => {
  const { W } = engines(); addStats(W);
  const ents = [unit(1, 1), unit(2, 2), unit(3, 3)];
  const fight = { id: 1, start: 10, end: 20, x: 0, z: 0, radius: 10, participants: [1, 2, 3], units: [1, 2, 3],
    losses: { 1: { army: 100, value: 100 }, 2: { army: 60, value: 60 }, 3: { army: 0, value: 0 } } };
  const d = { duration: 30, capturedEnd: 30, players: players(3), fights: [fight], jobs: { 1: [], 2: [], 3: [] }, stats: { 1: [], 2: [], 3: [] }, techs: [] };
  const C = W.RV_FRAME.combat(ents, d), result = W.RV_FIGHTS.analyze(d, C, 0), row = W.RV_FIGHTS.list(d, C)[0];
  assert.equal(result.lanchester.p, null); assert.equal(result.lanchester.actual, null);
  assert.equal(result.whatIf({ side: 2, attack: 1 }), null); assert.equal(row.winnerTeam, null);
  assert.deepEqual(JSON.parse(JSON.stringify(row.lost)), { 1: 100, 2: 60, 3: 0 });
});

test('M-11: neither damage nor healing bridges an absence; death-endpoint drops still count', () => {
  const { W } = engines(); addStats(W);
  const target = { ...unit(1, 1), spans: [0, 1, 10, 20], t: [0, 10], x: [0, 0], z: [0, 0], hp: [100, 40] };
  const healer = { ...unit(2, 1), cat: 'religious' };
  let C = W.RV_FRAME.combat([target, healer], { players: players() });
  assert.equal(C.dmgT.length, 0);
  target.hp = [40, 100]; C = W.RV_FRAME.combat([target, healer], { players: players() });
  assert.equal(C.heals.length, 0);
  target.spans = [0, 10]; target.died = 10; target.hp = [100, 0];
  C = W.RV_FRAME.combat([target], { players: players() });
  near(Array.from(C.dmgAmt).reduce((a, b) => a + b, 0), 100);
});

test('M-13: warships and heroes use the military category policy, scouts stay excluded', () => {
  const { W } = engines(); addStats(W, 'ship_test', 200); addStats(W, 'hero_test', 100); addStats(W, 'unit_scout_test', 50);
  const ents = [
    { ...unit(1, 1), bp: 'ship_test', cat: 'ship', born: 10 },
    { ...unit(2, 1), bp: 'hero_test', cat: 'hero', born: 10 },
    { ...unit(3, 1), bp: 'unit_scout_test', cat: 'cavalry', born: 10 },
  ];
  const rows = W.ecoMath.ledger({ ents }, {}, 1);
  assert.deepEqual(Array.from(rows, r => r.k), ['mil', 'mil', 'other']);
  assert.equal(rows.filter(r => r.k === 'mil').reduce((s, r) => s + r.c[0], 0), 300);
});
