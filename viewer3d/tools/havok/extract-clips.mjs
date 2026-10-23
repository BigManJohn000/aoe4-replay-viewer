// AoE4 animation clip extractor (Havok 2018 `.rhka` → sampled local bone transforms).
//
//   node tools/havok/extract-clips.mjs --list                          list archetypes with clip counts
//   node tools/havok/extract-clips.mjs --list base_spearman            list the clips of one archetype
//   node tools/havok/extract-clips.mjs base_spearman [clip ...] [--out file.json]
//        sample clips (all when none given) to JSON: { clipName: { frames, duration, bones, data[] } }
//   node tools/havok/extract-clips.mjs --verify [archetype]            decode every clip and check block continuity
//
// Archetypes live in <AOE4_EXTRACTED>/ArtCivilizations/art/civilizations/common/{humans,animals}/archetypes/
// (AOE4_EXTRACTED defaults to <AOE4_REBUILD>/content-local/extracted, AOE4_REBUILD to the project's toolchain/ folder).
import fs from 'node:fs';
import path from 'node:path';
import { readTagfile } from './tagfile.mjs';
import { decodeClip, sampleClip } from './predictive.mjs';
import { TOOLCHAIN } from '../toolchain.mjs';

const EXTRACTED = TOOLCHAIN.extracted;
const COMMON = path.join(EXTRACTED, 'ArtCivilizations/art/civilizations/common');

function archetypes() {
  const out = new Map();
  for (const kind of ['humans', 'animals']) {
    const dir = path.join(COMMON, kind, 'archetypes');
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name, `${name}.rhka`);
      if (fs.existsSync(file)) out.set(name, file);
    }
  }
  if (!out.size) throw new Error(`no archetypes under ${COMMON}: put the toolchain in the project's toolchain/ folder or set AOE4_REBUILD (or AOE4_EXTRACTED to the extracted archives)`);
  return out;
}

const loadSet = (file) => readTagfile(fs.readFileSync(file)).root().animations;

function verify(only) {
  let clips = 0, errors = 0, overlaps = 0, matched = 0;
  for (const [name, file] of archetypes()) {
    if (only && name !== only) continue;
    for (const entry of loadSet(file)) {
      clips++;
      try {
        const { blocks, nDyn } = decodeClip(entry.animationBinding.animation);
        for (let c = 0; c + 1 < blocks.length; c++) for (let k = 0; k < nDyn; k++) {
          overlaps++;
          if (blocks[c][k >> 4][(k & 15) * 16 + 15] === blocks[c + 1][k >> 4][(k & 15) * 16]) matched++;
        }
      } catch (e) {
        errors++;
        console.error(`${name} ${entry.name}: ${e.message}`);
      }
    }
  }
  console.log(`clips ${clips}, errors ${errors}, overlap frames matched ${matched}/${overlaps}`);
  if (errors || matched !== overlaps) process.exitCode = 1;
}

const args = process.argv.slice(2);
const flag = (f) => { const i = args.indexOf(f); if (i < 0) return undefined; const [, v] = args.splice(i, 2); return v ?? ''; };
const out = flag('--out');
if (args[0] === '--verify') verify(args[1]);
else if (args[0] === '--list') {
  const sets = archetypes();
  if (args[1]) {
    if (!sets.has(args[1])) throw new Error(`unknown archetype ${args[1]}`);
    for (const e of loadSet(sets.get(args[1]))) {
      const A = e.animationBinding.animation;
      console.log(`${e.name}\t${A.numFrames} frames\t${A.duration.toFixed(3)} s`);
    }
  } else for (const [name, file] of sets) console.log(`${name}\t${loadSet(file).length} clips`);
} else if (args[0]) {
  const [arch, ...wanted] = args;
  const file = archetypes().get(arch);
  if (!file) throw new Error(`unknown archetype ${arch}`);
  const entries = loadSet(file);
  const picked = wanted.length ? wanted.map((n) => entries.find((e) => e.name === n) ?? (() => { throw new Error(`no clip ${n} in ${arch}`); })()) : entries;
  const result = {};
  for (const e of picked) { const s = sampleClip(e); result[e.name] = { ...s, data: Array.from(s.data, (v) => +v.toFixed(5)) }; }
  const json = JSON.stringify(result);
  if (out) { fs.writeFileSync(out, json); console.log(`wrote ${picked.length} clips to ${out} (${json.length} bytes)`); }
  else process.stdout.write(json);
} else {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n'));
}
