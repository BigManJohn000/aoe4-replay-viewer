// Read-only structural audit of the locally built animation pack (no replay data required).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../assets/anims/', import.meta.url));
const index = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'));
const errors = [], warnings = [];
let clips = 0;
for (const [name, arch] of Object.entries(index.archetypes)) {
  const file = path.join(root, `${name}.glb`);
  if (!fs.existsSync(file)) { errors.push(`${name}: missing GLB`); continue; }
  const bytes = fs.readFileSync(file);
  if (bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(16) !== 0x4e4f534a) { errors.push(`${name}: invalid GLB JSON chunk`); continue; }
  const gltf = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)));
  const actual = new Map((gltf.animations ?? []).map(a => [a.name, a]));
  const used = new Set();
  for (const [state, list] of Object.entries(arch.states)) for (const clip of list) {
    used.add(clip);
    if (!arch.clips[clip]) errors.push(`${name}/${state}: missing metadata for ${clip}`);
  }
  for (const [clip, meta] of Object.entries(arch.clips)) {
    clips++;
    if (!actual.has(clip)) errors.push(`${name}: missing animation ${clip}`);
    else if (!actual.get(clip).channels?.length) errors.push(`${name}/${clip}: no channels`);
    if (!(meta.dur > 0) || !(meta.frames > 0)) errors.push(`${name}/${clip}: invalid timing`);
    if (!used.has(clip)) warnings.push(`${name}/${clip}: not referenced by a state`);
  }
}
for (const [bp, spec] of Object.entries(index.blueprints)) {
  for (const a of [spec.base, ...(spec.extra ?? []), ...Object.values(spec.jobs ?? {})]) {
    if (!index.archetypes[a]) errors.push(`${bp}: missing archetype ${a}`);
  }
}
console.log(JSON.stringify({ archetypes: Object.keys(index.archetypes).length, clips,
  blueprints: Object.keys(index.blueprints).length, errors, warnings }, null, 2));
process.exitCode = errors.length ? 1 : 0;
