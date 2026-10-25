import test from 'node:test';
import assert from 'node:assert/strict';
import { linkRelicCarriers, relicCarryAt } from '../core/replay.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from '../vendor/three/build/three.module.js';
const source = readFileSync(new URL('../unit-batches.js', import.meta.url), 'utf8');
const socketStart = source.indexOf('  socketPosition('), socketEnd = source.indexOf('\n  }', socketStart) + 4;
const socketPosition = vm.runInNewContext(`({${source.slice(socketStart, socketEnd)}}).socketPosition`, { THREE });

const monk = (id = 1) => ({ id, cat: 'religious', spans: [0, 20], t: [0, 1, 2, 3, 4, 5],
  x: [0, 1, 2, 3, 4, 5], z: [0, 0, 0, 0, 0, 0], hp: [100, 100, 100, 100, 100, 100] });
const relic = () => ({ kind: 'relic', spans: [0, 20], trT: [0, 1, 2, 3, 4, 5], trX: [0, 1, 2, 3, 4, 5], trZ: [0, 0, 0, 0, 0, 0] });
test('relic follows a uniquely matched monk, is seekable and stops at the last observed motion', () => {
  const e = monk(), g = relic(); linkRelicCarriers([e], [g]);
  assert.equal(relicCarryAt(e, 2).g, g);
  assert.equal(relicCarryAt(g, 4).e, e);
  assert.equal(relicCarryAt(g, 5), null);
  assert.equal(relicCarryAt(g, 2).e, e);
});
test('static proximity, ambiguous monks, one segment and sampling gaps never imply pickup', () => {
  for (const setup of [
    (e, g) => { g.trX.fill(0); e.x.fill(0); return [e]; },
    (e) => [e, monk(2)],
    (e, g) => { g.trT = [0, 1]; g.trX = [0, 1]; g.trZ = [0, 0]; return [e]; },
    (e, g) => { g.trT = [0, 1, 4, 5]; g.trX = [0, 1, 4, 5]; g.trZ = [0, 0, 0, 0]; return [e]; },
    (e) => { e.spans = [0, 1, 4, 6]; return [e]; },
  ]) {
    const e = monk(), g = relic(); linkRelicCarriers(setup(e, g), [g]);
    assert.equal(relicCarryAt(g, 0.5), null);
    assert.equal(relicCarryAt(g, 3), null);
  }
});
test('overlapping relic claims are rejected; later carrier transfer is independent', () => {
  const e = monk(), g = relic(), h = relic(); linkRelicCarriers([e], [g, h]);
  assert.equal(relicCarryAt(e, 2), null); assert.equal(relicCarryAt(g, 2), null);
  const next = monk(2); next.spans = [3, 20]; e.spans = [0, 3];
  linkRelicCarriers([e, next], [g]);
  assert.equal(relicCarryAt(g, 1).e, e);
  assert.equal(relicCarryAt(g, 4).e, next);
});
test('socket attachment interpolates both frames and clips and applies the instance transform', () => {
  const data = new Float32Array(24); data[0] = data[5] = data[10] = 2; data[3] = 10;
  data[20] = 0.5; data[21] = 1; data[22] = 0.5;
  const bytes = new Uint16Array(24); bytes[3] = THREE.DataUtils.toHalfFloat(2); bytes[15] = THREE.DataUtils.toHalfFloat(6);
  const view = {}, r = { stamp: 1, data, model: { fam: { index: new Map([['hand', 0]]), width: 3, rows: 2, data: bytes } } };
  const host = { frame: 1, recs: new Map([[view, r]]) }, out = new THREE.Vector3();
  assert.equal(socketPosition.call(host, view, 'Hand', out), true);
  assert.equal(out.x, 20); // blend 4 and 6 = 5, scale ×2, translate +10
  assert.equal(socketPosition.call(host, view, 'missing', out), false);
  r.data[19] = 1; assert.equal(socketPosition.call(host, view, 'hand', out), false);
});
