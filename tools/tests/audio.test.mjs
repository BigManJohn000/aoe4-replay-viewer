import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source = readFileSync(new URL('../../viewer/audio.js', import.meta.url), 'utf8');
function setup(fetcher) {
  const root = {localStorage: {getItem: () => null, setItem() {}}, RV_FRAME: {
    locate: e => ({x: e.x[0], z: e.z[0]}), ownerAt: e => e.owner,
    alive: () => true, idxAt: () => 0,
  }};
  vm.runInNewContext(source, {window: root, URL, fetch: fetcher || (async () => ({ok: true, arrayBuffer: async () => new ArrayBuffer(4)}))});
  const nodes = [];
  const param = () => ({value: 0, setTargetAtTime(v) {this.value = v;}, cancelScheduledValues() {}});
  const node = () => ({connect() {}, disconnect() {}, gain: param(), pan: param()});
  const ctx = {currentTime: 10, state: 'running', destination: {}, createGain: node, createStereoPanner: node,
    createAnalyser: () => ({...node(), getFloatTimeDomainData() {}}),
    createDynamicsCompressor: () => ({...node(), threshold: param(), knee: param(), ratio: param()}),
    createBufferSource() { const n = {...node(), start(t, offset) {this.at = t; this.offset = offset;}, stop(t) {this.stopped = t;}}; nodes.push(n); return n; },
    decodeAudioData: async () => ({duration: 5, length: 220500, numberOfChannels: 2}), resume: async () => {},
  };
  let s = {t: 100, playing: true, speed: 1, serial: 0}; let visible = true;
  const d = {players: [{idx: 1, civ: 'hre'}], techs: [], kills: []};
  const opts = {d, ents: [], combat: {lists: new Map(), heals: []}, base: new URL('http://localhost/audio/'),
    state: () => s, listener: () => ({x: 0, z: 0}), visible: () => visible, ownerVisible: () => visible};
  const manifest = {assets: {one: {url: 'one.ogg'}}, cues: {'bow': ['one'], 'music.hre.1.exp': ['one']}};
  const m = new root.RV_AUDIO.Mixer(opts, manifest, ctx); m.enabled = true;
  return {A: root.RV_AUDIO, m, ctx, nodes, s, manifest, hide() {visible = false;}};
}
test('handcannon is a gun, bombard is siege, crossbow and torch retain their cues', () => {
  const {A} = setup();
  for (const [bp, want] of [['unit_handcannon_3_hre','gun'], ['unit_bombard_4_hre','siege.cannon'], ['unit_crossbowman_3_hre','crossbow']])
    assert.equal(A.weapon({a: {bp}, shot: true}), want);
  assert.equal(A.weapon({a: {bp: 'unit_spearman'}, torch: true}), 'fire');
});
test('scheduled attack starts at its audio clock time without pitch acceleration', async () => {
  const {m, nodes} = setup();
  await m.play({t: 100.12, cue: 'bow'}, 10.12);
  assert.equal(nodes[0].at, 10.12); assert.equal(nodes[0].playbackRate, undefined);
  assert.equal(m.trace[0].delta, 0);
});
test('seek cancels pending fetch and already scheduled sources', async () => {
  let resolve;
  const {m, nodes} = setup(() => new Promise(r => {resolve = r;}));
  const play = m.play({t: 100, cue: 'bow'}, 10.1);
  m.cancel(); resolve({ok: true, arrayBuffer: async () => new ArrayBuffer(4)}); await play;
  assert.equal(nodes.length, 0);
  await m.play({t: 100, cue: 'bow'}, 10.1); m.cancel();
  assert.equal(nodes[0].stopped, 10); assert.equal(m.active.size, 0);
});
test('late decoding is dropped rather than producing stale attacks after a stall', async () => {
  let resolve;
  const {m, ctx, nodes} = setup(() => new Promise(r => {resolve = r;}));
  const p = m.play({t: 100, cue: 'bow'}, 10.1); ctx.currentTime = 10.5;
  resolve({ok: true, arrayBuffer: async () => new ArrayBuffer(4)}); await p;
  assert.equal(nodes.length, 0); assert.equal(m.counts.dropped, 1);
});
test('fog is checked again after asynchronous loading; hidden enemies never start', async () => {
  let resolve;
  const {m, hide, nodes} = setup(() => new Promise(r => {resolve = r;}));
  const p = m.play({t: 100, cue: 'bow', e: {x:[0],z:[0]}}, 10.1); hide();
  resolve({ok: true, arrayBuffer: async () => new ArrayBuffer(4)}); await p;
  assert.equal(nodes.length, 0);
});
test('loop position survives pause and sources stop on mute', async () => {
  const {m, ctx, nodes} = setup();
  await m.bed('music', 'music.hre.1.exp', 100); ctx.currentTime = 12;
  m.cancel(); await m.bed('music', 'music.hre.1.exp', 102);
  assert.equal(nodes[1].offset, 2);
  await m.enable(false); assert.equal(m.active.size, 0); assert.equal(nodes[1].stopped, 12);
});
test('voice concurrency cap is independent of effects', async () => {
  const {m} = setup();
  for (let i = 0; i < 5; i++) await m.play({t:100, cue:'bow', bus:'voices'});
  assert.equal(m.active.size, 2); assert.equal(m.counts.dropped, 3);
});
test('rapid music transitions retain and stop the original loop without an orphan', async () => {
  const {m, manifest, nodes} = setup();
  manifest.cues.second = ['one']; manifest.cues.third = ['one'];
  await m.bed('music', 'music.hre.1.exp', 100);
  const second = m.bed('music', 'second', 100), third = m.bed('music', 'third', 100);
  await Promise.all([second, third]);
  assert.equal(m.beds.get('music').key, 'third');
  assert.equal(nodes[0].stopped, 11.5); assert.equal(nodes[1].stopped, 10);
  assert.equal(nodes[2].stopped, undefined);
});
test('decode failures are contained and reported', async () => {
  const {m} = setup(async () => ({ok:false,status:404}));
  assert.equal(await m.play({t:100,cue:'bow'}), null); assert.equal(m.counts.failed, 1);
});
test('explicit small forward seek drops already queued sound window', () => {
  const {A} = setup(), c = new A.Cursor([{t:100.05,id:1},{t:100.15,id:2},{t:101,id:3}]);
  c.step({t:100,playing:true,speed:1,serial:0},0);
  const r = c.step({t:100.2,playing:true,speed:1,serial:1},.01);
  assert.equal(r.discontinuity,true); assert.equal(r.due.length,0);
});
test('result feedback occurs only at natural completion for a known player perspective', async () => {
  const {m, manifest, s, nodes} = setup();
  m.o.d.duration = 101; m.o.d.summary = {players: {1: {result:'win'}}};
  manifest.cues['ui.victory'] = ['one'];
  await m.buffer('one');
  m.cursor.step({...s}, 0); s.t = 101; s.playing = false;
  m.update(1); await Promise.resolve();
  assert.equal(nodes.length, 1); assert.equal(m.trace[0].cue, 'ui.victory');
  m.update(2); await Promise.resolve(); assert.equal(nodes.length, 1);
});
test('seeking to the end cannot trigger victory feedback', async () => {
  const {m, manifest, s, nodes} = setup();
  m.o.d.duration = 101; m.o.d.summary = {players: {1: {result:'win'}}};
  manifest.cues['ui.victory'] = ['one']; await m.buffer('one');
  m.cursor.step({...s},0); s.t = 101; s.playing = false; s.serial++;
  m.update(1); await Promise.resolve(); assert.equal(nodes.length,0);
});
