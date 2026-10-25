#!/usr/bin/env node
// Real-recording audio contract audit; no browser or audio device required.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {fileURLToPath, pathToFileURL} from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viewer = path.resolve(process.env.RV_2D_VIEWER ?? path.join(project, '..', 'viewer'));
const name = process.argv[2] ?? 'aoe4_245598603';
const sandbox = {window: {}};
vm.createContext(sandbox);
for (const file of ['units.js', 'stats.js', 'frame.js', 'eco.js', 'fights.js', 'model.js', 'audio.js', `data/${name}.js`])
  vm.runInContext(fs.readFileSync(path.join(viewer, file), 'utf8'), sandbox, {filename: file});
const {RV, RV_UNITS, RV_FRAME, RV_AUDIO: A, REPLAY_DATA} = sandbox.window;
const d = REPLAY_DATA[name];
assert(d, `Recording missing: ${name}`);
const {Replay} = await import(pathToFileURL(path.join(project, 'core/replay.js')).href);
const R = new Replay(structuredClone(d), RV_UNITS, RV_FRAME);
const M = RV.prepare(structuredClone(d));
const manifest = JSON.parse(fs.readFileSync(path.join(project, 'assets/audio/index.json'), 'utf8'));
const events = A.plan({d, ents: R.ents, combat: R.combat, conversions: M.conversions, gaia: R.gaia, alerts: M.alerts});
const failures = [], results = [];
function check(label, fn) {
  try { const detail = fn(); results.push(`PASS ${label}${detail ? `: ${detail}` : ''}`); }
  catch (error) { failures.push(`FAIL ${label}: ${error.message.split('\n')[0]}`); }
}
const key = e => `${e.t}|${e.cue}|${e.e?.id ?? ''}`;
const bag = rows => {
  const counts = new Map();
  for (const e of rows) counts.set(key(e), (counts.get(key(e)) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a.localeCompare(b));
};
const blows = [...R.combat.lists.values()].flat();
check('release t0 and target impact t1', () => {
  assert.deepEqual(bag(events.filter(e => e.combat)), bag(blows.map(b => ({t:b.t0, cue:A.weapon(b), e:b.a}))));
  const impact = b => A.weapon(b).startsWith('siege.') ? 'siege.impact' : A.weapon(b) === 'gun' ? 'bullet.impact' : 'arrow.impact';
  const expected = blows.filter(b => b.shot && !b.miss).map(b => ({t:b.t1, cue:impact(b), e:b.b}));
  assert.deepEqual(bag(events.filter(e => /^(siege|bullet|arrow)\.impact$/.test(e.cue))), bag(expected));
  return `${blows.length} releases, ${expected.length} impacts`;
});
check('recorded kill timestamps', () => {
  const expected = d.kills.flatMap(k => {
    const e = R.byId.get(k.victim);
    return !e || ['attachment','other'].includes(e.cat) ? [] : [{t:k.t, cue:e.cat === 'building' ? 'death.building' : /ship/.test(e.bp) ? 'death.ship' : e.cat === 'cavalry' ? 'death.horse' : 'death', e}];
  });
  assert.deepEqual(bag(events.filter(e => /^death(?:\.|$)/.test(e.cue))), bag(expected));
  return `${expected.length} deaths`;
});
check('upgrade completion coverage and deduplication', () => {
  const notices = events.filter(e => e.cue === 'age' || e.cue === 'research');
  const expected = new Set(d.techs.map(([t,owner]) => `${t}|${owner}`));
  for (const u of d.upgrades) {
    const id = /^e(\d+)$/.exec(u.fields?.executer ?? ''), e = id && R.byId.get(+id[1]);
    if (e) expected.add(`${u.t}|${RV_FRAME.ownerAt(e,u.t)}`);
  }
  const actual = notices.map(e => `${e.t}|${e.owner}`);
  assert.equal(new Set(actual).size, actual.length, 'duplicate completion notice');
  assert.deepEqual([...new Set(actual)].sort(), [...expected].sort());
  for (const [t,owner,,kind] of d.techs) assert(notices.some(e => e.t === t && e.owner === owner && e.cue === (kind === 'age' ? 'age' : 'research')));
  return `${notices.length} notices from ${d.upgrades.length} upgrades and ${d.techs.length} tech rows`;
});
check('inferred relic starts without fabricated deposits', () => {
  const pickups = events.filter(e => e.cue === 'relic.pickup');
  assert(pickups.length, 'no pickup cues');
  for (const e of pickups) {
    assert.equal(e.inferred, true);
    assert(e.e.relicCarries.some(r => r.start === e.t && r.samples >= 2), 'pickup lacks confirmed moving interval');
  }
  assert(!events.some(e => /relic.*deposit/.test(e.cue)));
  return `${pickups.length} inferred starts`;
});
check('conversion stage offsets and channel limits', () => {
  for (const c of M.conversions) {
    for (const [cue, offset] of [['convert',0],['convert.voice',.5],['convert.buildup',3]]) {
      const matches = events.filter(e => e.cue === cue && e.e.id === c.caster.id && e.t === c.t + offset);
      assert.equal(matches.length, offset === 0 || c.end > c.t + offset ? 1 : 0, `${cue} at ${c.t}`);
      for (const e of matches) assert.equal(e.until,c.end);
    }
  }
  return `${M.conversions.length} channels`;
});
check('under-attack alert timing and per-player cooldown', () => {
  const horns = events.filter(e => e.cue === 'alert');
  assert(horns.length, 'no under-attack cues');
  for (const e of horns) {
    assert(M.alerts.some(a => a.t === e.t && a.owner === e.owner && a.victim.id === e.e.id), 'horn lacks matching attack alert');
    assert.equal(e.inferred,true); assert.equal(e.bus,'ui');
  }
  for (const p of d.players) {
    const own = horns.filter(e => e.owner === p.idx);
    for (let i=1;i<own.length;i++) assert(own[i].t-own[i-1].t >= 20, 'player cooldown shorter than 20 seconds');
    for (const alert of M.alerts.filter(a => a.owner === p.idx))
      assert(own.some(e => e.t === alert.t || (e.t < alert.t && alert.t-e.t < 20)), 'eligible attack alert was omitted');
  }
  return `${horns.length} horns from ${M.alerts.length} alerts; ${d.players.map(p => `${p.idx}=${horns.filter(e => e.owner === p.idx).length}`).join(', ')}`;
});
check('manifest coverage', () => {
  const cues = [...new Set(events.filter(e => e.cue !== 'voice').map(e => e.cue))];
  assert.deepEqual(cues.filter(cue => !manifest.cues[cue]?.length), [], 'missing cue');
  for (const cue of cues) for (const id of manifest.cues[cue]) assert(manifest.assets[id], `missing asset metadata ${id}`);
  return `${cues.length} static plan cues`;
});
check('music age and monk civilization voices', () => {
  for (const [t,owner,label,kind] of d.techs) if (kind === 'age') {
    const expected = /Imperial/.test(label) ? 4 : /Castle/.test(label) ? 3 : 2;
    assert.equal(A.age(d,owner,t),expected); assert.equal(A.age(d,owner,t-.001),expected-1);
    const civ = A.civ(d.players.find(p => p.idx === owner));
    for (const mode of ['exp','com']) assert(manifest.cues[`music.${civ}.${expected}.${mode}`]?.length);
  }
  if (name === 'aoe4_245598603') for (const [id,civ] of [[1000006237,'hre'],[1000006354,'sultanate']])
    assert.equal(A.voiceCue(manifest,d,R.byId.get(id),720,'select'),`voice.${civ}.monk.select.3`);
  return 'completion boundaries, music stems, HRE/Delhi age-3 selection';
});
const start = 675.75, end = 699.375;
for (const speed of [.25,1,2,8]) check(`battle cursor ${speed}x`, () => {
  const cursor = new A.Cursor(events), ids = [], expected = Array.from(events).filter(e => e.t >= start && e.t <= end).map(e => e.id);
  const duration = (end-start)/speed, steps = Math.ceil(duration*60);
  for (let i=0;i<=steps;i++) {
    const wall = Math.min(i/60,duration), t = start+wall*speed;
    ids.push(...cursor.step({t,playing:true,speed,serial:0},wall).due.filter(e => e.t <= end).map(e => e.id));
  }
  assert.equal(new Set(ids).size,ids.length,'duplicate event IDs');
  assert.deepEqual(ids,expected,'lost or extra event IDs');
  return `${ids.length} events exactly once`;
});
check('seek and pause exclude skipped audio', () => {
  const cursor = new A.Cursor(events);
  cursor.step({t:start,playing:true,speed:1,serial:0},0);
  for (const [t,wall,serial,playing] of [[695,1,1,true],[680,2,2,true],[680,3,2,false],[680,10,2,false],[680,11,2,true]]) {
    const out = cursor.step({t,playing,speed:1,serial},wall);
    if (!playing) assert.equal(out.due.length,0,'paused audio burst');
    else for (const e of out.due) assert(e.t >= t-1e-7 && e.t <= t+.12,'seek/resume replayed skipped events');
  }
  return 'forward/backward seek, pause, resume';
});
console.log(`Audio replay audit ${name}: ${events.length} planned events`);
for (const result of [...results,...failures]) console.log(result);
console.log(`${results.length} passed, ${failures.length} failed`);
process.exitCode = failures.length ? 1 : 0;
