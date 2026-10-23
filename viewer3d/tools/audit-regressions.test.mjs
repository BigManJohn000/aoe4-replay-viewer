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
