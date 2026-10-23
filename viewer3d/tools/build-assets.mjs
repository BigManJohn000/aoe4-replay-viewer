#!/usr/bin/env node
/**
 * build-assets.mjs — converts the real Age of Empires IV models used by a replay into
 * web-ready GLBs + icons for the replay viewer.
 *
 *   node tools/build-assets.mjs [--replay <name or file> | --all | --only bp1,bp2] [--force] [--no-icons] [--jobs 6]
 *
 * --replay defaults to aoe4_245598603. A bare recording name (aoe4_245598603) is read from the 2D viewer's data/ folder
 * (the shared recordings folder serve.mjs mounts); other paths resolve from the project folder.
 * --all builds the universal catalog instead of one recording's: every ebps of every playable civilisation (Attrib
 * ebps/races/<civ>, see UNIVERSE_RACES), neutral map buildings, weapon entities, gaia animals, trees, deposits, berries,
 * fish, relics, bridges … (UNIVERSE_DIRS), every age, with every civ archive unpacked. No recording is needed; the
 * viewer then finds a model for any blueprint any replay can contain. (Long: unpacks ~7 GB of archives, converts
 * thousands of models.) --only bp1,bp2 builds just those blueprints the same way (debugging).
 * Each run ADDS to what earlier runs built: catalog.json and combat.json keep every blueprint and unit already there
 * (a blueprint this run resolves again takes this run's models for the ages it reached and keeps the others), so
 * building another match's civilisations never loses may_vs_sas's models or weapon timings.
 * catalog.blueprints[bp].sight = the ebps line-of-sight radius in metres (first sight_ext package), for fog of war.
 *
 * Pipeline (all game files are read-only; extraction and caches live outside the project):
 *   1. read the replay → every entity blueprint (bp) + gaia type it uses (trees included)
 *   2. Attrib.sga (rgd → JSON via Essence) → ebps → tier/attachment lists → mesh art or stamps
 *   3. stamps (Data.sga, Relic Chunky .bin) → art parts with transforms
 *   4. Essence `model-export` per art (DX12Geo<Civ> + DX12Assets<Civ> archives) → every LOD geom of every visible
 *      mesh (selection_cube click proxies skipped)
 *   5. material pass (LOD0 geoms; distant levels reuse their LOD0 twin's material, see "LODs"):
 *        unit/object materials  → albedo kept; patternTex R (player colour) and G (skin) baked to a PNG in
 *                                 emissiveTexture (factor 0) + extras.rv.mask = true; normalMap / metalTex repacked
 *                                 into glTF normalTexture + metallicRoughnessTexture (factors 1) + extras.rv.pbr = true
 *                                 (channel packing under "PBR maps")
 *        vegetation materials   → own albedo decoded from the rrmaterial (Essence assigns these geoms the bark
 *                                 texture or none), alpha-cut, double-sided; tintColourLUT strip → extras.rv.tint
 *        layered materials      → runtime substance blends; replaced by the Gen7AssetsMaterials bakes: per model one
 *                                 atlas (RGB albedo, A = 255 − team mask) on one material with extras.rv.gen7 = true,
 *                                 UV0 remapped into each material's tile (structure tiles 512² = the bakes' native
 *                                 size; the bakes carry albedo + team mask only, no normal maps). Without a bake
 *                                 (missing archive) textures are dropped and extras.rv.layered = <shader type>
 *                                 (viewer stylises)
 *   6. parts merged with their stamp transforms → assets/models/<key>.glb; a single human/animal art with an
 *      ArtHigh .rgm becomes a skinned model (DATASKLN skeleton + per-batch bone palettes + DATALGEO weights, bind
 *      pose). Units also get their weapons, shields and villager tools as rigid props on extra joints under the rig's
 *      hand/back markers (see "equipment"; props that export no geometry are skipped); the key becomes <body>+<weapon art>.
 *      Distant LODs ride along in the same GLB (see "LODs"); every texture is written as KTX2 (see "KTX2")
 *   7. ebps ui_ext/icon_name (UIArt.sga) → assets/icons/<bp>.png
 *   8. Gen7 temperate terrain tile albedos → assets/terrain/<layer>.png (ground layers the viewer tiles: grass,
 *      lush, dry, forest floor, plus dirt and trodden mud for building footprints and worn paths); Gen7 grass blade
 *      cards → assets/terrain/blades.png + blades.json (atlas rects, card heights, weights); farm fields (see
 *      buildFarms) → assets/terrain/farm_<crop>_*.png and catalog.json `farms`
 *   9. assets/catalog.json (provenance, per-model props, the replays built so far) + assets/combat.json (per unit: main
 *      weapon and torch with damage type, range, wind-up/down, impact, cooldown, period, projectile speed and weapon
 *      art; per building weapon: the same for each wpn_* entity the replay attaches to a town centre, outpost, keep or
 *      landmark, through the weapon it wraps), both merged into the existing files. The viewer reads catalog.json at
 *      load: every built blueprint gets its models without code changes (viewer.js ASSET_MAP only holds hand-tuned
 *      entries, which win)
 *
 * Coordinates are left untouched (raw game space, +Z forward); the viewer mirrors the world.
 *
 * PBR maps (unit / object / object_collection materials; layout read off unit, prop, weapon and horse textures):
 *   normalMap (internal _emi; BC3nm-style): A = tangent X, G = tangent Y, B = 255, R = an auxiliary mask (on units a
 *     copy of patternTex R). Y is +up (OpenGL = glTF convention): slopes rebuilt from the maps are curl-free in that
 *     orientation and not in DirectX's. → normalTexture RGB = (A, G, √(1 − x² − y²)).
 *   metalTex (internal _mtl): R = metalness, G = dielectric specular level (exactly 0 wherever R marks metal), B = 0,
 *     A = roughness (not gloss: wet fish and horse hide low, cloth and skin high) → metallicRoughnessTexture
 *     (R 255, G = A, B = R). Neither map carries ambient occlusion, so no occlusionTexture is written. Maps are
 *     capped at 512² like the albedo; folded props (≤ 256²) get normal / metal-roughness atlases in the albedo
 *     atlas's layout, regions without a map filled neutral (normal 128,128,255; roughness 0.85, metalness 0 = the
 *     factors of a plain material). Gen7 bakes have no normal or metal maps (their rrmaterials carry albedoTex +
 *     teamMask only); vegetation / vegetation_billboard blocks carry a normalMap in the same A = X, G = Y packing, which
 *     is embedded too (they have no metalTex). A map that is one flat colour (a sheep's uniform roughness, a default
 *     normal) is folded into the material factors by gltf-transform's prune; that is not a lost channel.
 *
 * LODs: LOD0 is the default scene content. Each distant level n ≥ 1 is a top-level scene node `rv_lod<n>` (identity,
 * extras.rv.lod = n) holding a copy of every part holder (same TRS, node names + `_lod<n>`), so a level's meshes
 * have their LOD0 twins' world transforms; level primitives use LOD0's materials (same atlas UVs, same attribute
 * layout; Gen7 remap and prop folding applied per level). Levels come from the game where an art has them (units,
 * animals, weapons, trees, relics: rrgeom FOLDLOD n, skinned through the rgm's per-LOD palettes + DATALGEO weights; a
 * mesh with fewer levels repeats its last one; trees' low cards keep their own material) and extras.rv.dist = the
 * game's switch distance in metres (rgm DATALODD; the level shows beyond it). Structures, props and resource nodes
 * ship a single LOD: their levels are generated (meshoptimizer, normal- and UV-aware, ≈ 50 % and ≈ 25 % of LOD0;
 * extras.rv.error = largest simplification error in metres, model space) when the model has ≥ LOD_MIN_TRIS
 * triangles. catalog models[key].lods = number of extra levels, .tris = triangles per level (LOD0 first).
 *
 * KTX2: every model texture is Basis Universal in KTX2 (KHR_texture_basisu, required), full mip chain, base size
 * rounded up to multiples of 4. Albedo and Gen7 atlases: ETC1S quality 255, sRGB (a 512² albedo ≈ 37 dB PSNR at a
 * third of UASTC's size; differences invisible at unit scale). Masks and normal maps: UASTC level 2 + Zstandard,
 * linear (no RDO: it costs normals ~2–8 dB). Metal-roughness: UASTC level 2, RDO 1, Zstandard, linear. Encoding
 * runs in worker threads (one Basis encoder each); identical images encode once per run.
 *
 * Environment overrides: AOE4_REBUILD (the toolchain root, default the project's toolchain/ folder: tools/dotnet,
 * tools/essence, content-local/extracted; see toolchain.mjs), AOE4_EXTRACTED, ESSENCE_DOTNET and ESSENCE_CLI (each one
 * of its three paths), AOE4_ARCHIVES (default: the game's cardinal/archives folder, the game found through Steam as
 * the recorder finds it, see findGameDir), RV_CACHE, RV_2D_VIEWER (the 2D viewer folder holding data/, as for serve.mjs).
 * Requires the Essence CLI (AOEMods.Essence) and a .NET runtime.
 *
 *   node tools/build-assets.mjs --replay <name> --check
 * prints one JSON line { replay, total, missing: [{ bp, cat }] } — the blueprints and gaia types the recording uses
 * that catalog.json has no entry for — and builds nothing (needs neither the toolchain nor the game). The recorder runs
 * a build when that list is not empty.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { KHRTextureBasisu } from '@gltf-transform/extensions';
import { mergeDocuments, dedup, prune, unpartition } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import { PNG } from 'pngjs';
import { TOOLCHAIN, requireToolchain } from './toolchain.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const VIEWER_2D = path.resolve(process.env.RV_2D_VIEWER ?? path.join(PROJECT, '..', 'viewer'));
/** --replay value → recording file: a bare name is a recording in the 2D viewer's data/ folder. */
const replayPath = (v = 'aoe4_245598603') =>
  (/^[\w-]+$/.test(v) ? path.join(VIEWER_2D, 'data', `${v}.js`) : path.resolve(PROJECT, v));

/** The game's folder as the recorder finds it: tools/record_replay.py find_game_dir (Steam's library folders and the
 *  game's app manifest), run with the bundled python/ or else the Python on PATH; Steam's default library folder when
 *  that finds nothing. */
function findGameDir() {
  const root = path.resolve(PROJECT, '..');
  const bundled = path.join(root, 'python', 'python.exe');
  const r = spawnSync(fs.existsSync(bundled) ? bundled : 'python',
    ['-c', 'import record_replay as rr; print(rr.find_game_dir() or "")'],
    { cwd: path.join(root, 'tools'), encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  return (r.status === 0 && r.stdout.trim()) || 'C:/Program Files (x86)/Steam/steamapps/common/Age of Empires IV';
}

const CFG = {
  // KTX2 workers run this file too and never read archives: only the main thread looks the game up
  archives: process.env.AOE4_ARCHIVES ?? (isMainThread && !flag('--check') ? path.join(findGameDir(), 'cardinal', 'archives') : ''),
  extracted: TOOLCHAIN.extracted,
  dotnet: TOOLCHAIN.dotnet,
  essence: TOOLCHAIN.essence,
  cache: process.env.RV_CACHE ?? path.join(os.tmpdir(), 'rv-asset-cache'),
  replay: replayPath(opt('--replay')),
  out: path.join(PROJECT, 'assets'),
  force: flag('--force'),
  icons: !flag('--no-icons'),
  jobs: Number(opt('--jobs', 6)),
  maxTex: 512,
  ktxThreads: Math.max(1, Math.min(os.availableParallelism() - 2, 12)),
};

/** Art civ folder (art/civilizations/<civ>) → archive suffix (DX12Geo<X>.sga / DX12Assets<X>.sga). Folders with no suffix
 *  of their own (byzantine_ha_mac, japanese_ha_sen, mongols_ha_gol, sultanate_ha_tug, common, gaia) live in the base
 *  DX12Assets.sga, which is always indexed. Every civ folder the game has must be listed: a missing one means its
 *  archives are never unpacked and its blueprints get no model (Templar, Order of the Dragon, Lancaster, Abbasids …). */
const CIV_ARCHIVE = {
  abbasids: 'Abbasids', abbasids_ha_01: 'AbbasidsHA', byzantine: 'Byzantine', chinese: 'Chinese', chinese_ha_01: 'ChineseHA',
  english: 'English', french: 'French', french_ha_01: 'FrenchHA', hre: 'HRE', hre_ha_01: 'HREHA', japanese: 'Japanese',
  jin_dynasty: 'Jin', lancaster: 'Lancaster', malian: 'Malian', mongols: 'Mongols', ottoman: 'Ottoman', rus: 'Rus',
  sultanate: 'Sultanate', templar: 'Templar',
};
/** ebps race folder (ebps/races/<race>) → art civ folder, where the two differ. */
const ART_CIV = { abbasid: 'abbasids', abbasid_ha_01: 'abbasids_ha_01', mongol: 'mongols', mongol_ha_gol: 'mongols_ha_gol' };
/** Helper meshes in tree arts that are not part of the visible tree (click proxies). */
const HELPER_MESH = /^selection_cube/;
/** Stamp parts worth converting: civ structures/props and resource-node art (gold, stone, berries). */
const STAMP_ART = /^art\\(civilizations|environment\\nat_economy)\\/;
/** Stamp parts that are decoration noise or construction leftovers (scaffolding, build piles) rather than the building. */
const STAMP_SKIP = /\\(debris|splats|decals?)\\|scaffold|buildpile/i;
/** Material shader families without a usable single albedo (layered substances) → Gen7 bake or stylised in the viewer. */
const LAYERED = /^(structure|object_layered|sails|trunk|terrain)/;

// ───────────────────────────── small utils ─────────────────────────────
const log = (...a) => console.log(...a);
const exists = (p) => fs.existsSync(p);
const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });
const slug = (s) => s.replace(/[\\/:]+/g, '__');
const baseName = (art) => art.split('\\').pop();
const civOf = (art) => /^art\\civilizations\\([^\\]+)\\/.exec(art)?.[1] ?? null;
const round = (x) => Math.round(x * 1e4) / 1e4;

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env: { ...process.env, DOTNET_ROLL_FORWARD: 'Major' }, windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}
const essence = (...args) => run(CFG.dotnet, [CFG.essence, ...args]);

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i], i); }
  }));
}

function walkFiles(root, rel = '', out = []) {
  if (!exists(root)) return out;
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walkFiles(root, r, out); else out.push(r);
  }
  return out;
}

// ───────────────────────────── archives & file index ─────────────────────────────
async function ensureArchive(name) {
  const dir = path.join(CFG.extracted, name);
  if (exists(dir)) return true;
  const sga = path.join(CFG.archives, `${name}.sga`);
  if (!exists(sga)) return false;
  log(`  extracting ${name}.sga …`);
  const r = await essence('sga-unpack', sga, dir);
  if (r.code !== 0) throw new Error(`sga-unpack ${name} failed:\n${r.out.slice(-800)}`);
  return true;
}

/** lower-case 'art/…' path → absolute path, across all extracted DX12 archives. */
const ART_INDEX = new Map();
const indexedArchives = new Set();
function indexArchive(name) {
  if (indexedArchives.has(name)) return;
  indexedArchives.add(name);
  const root = path.join(CFG.extracted, name);
  for (const rel of walkFiles(root)) ART_INDEX.set(rel.toLowerCase(), path.join(root, rel));
}
async function ensureCivArt(civ) {
  const suffix = CIV_ARCHIVE[ART_CIV[civ] ?? civ];
  if (!suffix) return;
  for (const a of [`DX12Geo${suffix}`, `DX12Assets${suffix}`]) if (await ensureArchive(a)) indexArchive(a);
}
async function locateArt(relWithExt) {
  const key = relWithExt.replace(/\\/g, '/').toLowerCase();
  if (!ART_INDEX.has(key)) { const civ = /^art\/civilizations\/([^/]+)\//.exec(key)?.[1]; if (civ) await ensureCivArt(civ); }
  return ART_INDEX.get(key) ?? null;
}

// ───────────────────────────── Relic Chunky ─────────────────────────────
function* chunks(buf, off, end) {
  while (off + 20 <= end) {
    const tag = buf.toString('latin1', off, off + 8);
    const size = buf.readUInt32LE(off + 12), nameLen = buf.readUInt32LE(off + 16);
    const name = buf.toString('latin1', off + 20, off + 20 + nameLen).replace(/\0.*$/, '');
    const data = off + 20 + nameLen;
    yield { tag, name, data, size };
    if (tag.startsWith('FOLD')) yield* chunks(buf, data, data + size);
    off = data + size;
  }
}
const printable = (buf, a, b) => (buf.toString('latin1', a, b).match(/[\x20-\x7e]{2,}/g) ?? []);

/** rrgeom → meshes[ lods[ geoms[ {strings, matName, type} ] ] ] in Essence export order. */
function rrgeomLayout(file) {
  const buf = fs.readFileSync(file);
  const meshes = [];
  let mesh = null, lod = null;
  for (const c of chunks(buf, 24, buf.length)) {
    if (c.tag === 'FOLDMESH') meshes.push((mesh = []));
    else if (c.tag.startsWith('FOLDLOD')) mesh?.push((lod = []));
    else if (c.tag === 'DATAGOHD') {
      const s = printable(buf, c.data, c.data + c.size);
      const matName = s.length >= 4 ? s[1] : s.length === 3 ? s[0] : null;
      lod?.push({ strings: s, matName, type: s[s.length - 2] ?? '' });
    }
  }
  return meshes;
}

/** rrmaterial → { blockName: { type, tex: {slot: artPath} } } */
function rrmaterialBlocks(file) {
  const buf = fs.readFileSync(file);
  const blocks = {};
  let cur = null;
  for (const c of chunks(buf, 24, buf.length)) {
    if (c.tag === 'FOLDGMat') blocks[c.name] = cur = { type: null, tex: {} };
    else if (c.tag === 'DATAMatD' && cur) cur.type = buf.toString('latin1', c.data + 4, c.data + 4 + buf.readUInt32LE(c.data));
    else if (c.tag === 'DATAPbTe' && cur) {
      let p = c.data;
      const n = buf.readUInt32LE(p); p += 4;
      for (let i = 0; i < n; i++) {
        const sl = buf.readUInt32LE(p); const slot = buf.toString('latin1', p + 4, p + 4 + sl); p += 4 + sl;
        const pl = buf.readUInt32LE(p); const tp = buf.toString('latin1', p + 4, p + 4 + pl); p += 4 + pl;
        cur.tex[slot] = tp;
      }
    }
  }
  return blocks;
}

/** Stamp .bin → [{art, quat[x,y,z,w], pos[x,y,z], scale[x,y,z]}] */
function parseStamp(file) {
  const buf = fs.readFileSync(file);
  for (const c of chunks(buf, 24, buf.length)) {
    if (c.tag !== 'DATARFCI') continue;
    const count = Number(buf.readBigUInt64LE(c.data + 44));
    const parts = [];
    for (let i = 0; i < count; i++) {
      const ptrPos = c.data + 52 + 8 * i;
      const r = ptrPos + Number(buf.readBigUInt64LE(ptrPos));
      const sPos = r + 32 + Number(buf.readBigUInt64LE(r + 32));
      const sLen = Number(buf.readBigUInt64LE(r + 40));
      const art = buf.toString('latin1', sPos, sPos + sLen).replace(/\0+$/, '');
      const f = Array.from({ length: 12 }, (_, k) => buf.readFloatLE(r + 52 + 4 * k));
      parts.push({ art, quat: f.slice(2, 6), pos: f.slice(6, 9), scale: f.slice(9, 12) });
    }
    return parts;
  }
  return [];
}

// ───────────────────────────── skeleton & skin (.rgm, ArtHigh.sga) ─────────────────────────────
// DATASKLN v6: u32 0, u32 n, n × {u32 len, name, i16 parent}, bone-group block, n × {quat xyzw, vec3 pos, vec3 scale} (local bind).
// FOLDSKMS v15 (skinned mesh, name = rrgeom mesh name): DATASKIN = u32 n, n × {u32 len, name, i16 parent, quat, pos, scale}
//   (model-space bind of the bones this mesh uses); per LOD (LOD order) a FOLDLODs/"DATA\0LOD" = u32 nb, nb × {u32 len,
//   name, 60 B bounds, u16 n, n × u16 DATASKIN index, u32 len, group, u32 len, "unit"}, u32 N, N × u16 (the union) —
//   one bone palette per render batch (= rrgeom slot of that LOD, ≤ 64 bones), and a FOLDGEO/DATALGEO = u32 nv, nv ×
//   {half x,y,z, u16 weightRow}, u32 nw, nw × 4 × {u8 bone, u8 weight/255}, index list. `bone` indexes the vertex's
//   batch palette; LGEO vertices are deduplicated per batch and stored batch after batch, so a position on a seam
//   between slots appears once per batch. DATALODD = u32 n, n × f32: per-LOD switch distances in metres (units
//   30/60/90, trees 150/250/350). Palettes skip unweighted bones (cloth, motion root) and shrink per LOD, so indexing
//   DATASKIN directly mis-binds every bone after the first gap (all 2148 skinned meshes of ArtHigh parse this way).
// FOLDSTMS v8 (static mesh riding one bone): the bone name is one of the strings in its DATAMISC.
// LGEO positions are bit-identical to the Essence render vertices of the same LOD (every vertex of every LOD of the
// sampled units and horses matches), so weights transfer by exact position.
const RIGGED_ART = /\\(humans|animals)\\/;
const halfToFloat = (h) => {
  const e = (h >> 10) & 31, m = h & 1023, v = e === 0 ? (m / 1024) * 2 ** -14 : (1 + m / 1024) * 2 ** (e - 15);
  return h & 0x8000 ? -v : v;
};
/** art → { bones:[{name,parent,rot,pos,scl}], index: Map(name → i), meshes: Map(meshName → {kind, skin, lods, pals, bone}) } | null.
 *  Only human/animal arts are rigged units; `skinPart` lifts that for an art that skins onto another's skeleton (weapons). */
function loadRig(art, skinPart = false) {
  if (!skinPart && !RIGGED_ART.test(art)) return null;
  const file = path.join(CFG.extracted, 'ArtHigh', `${art.replace(/\\/g, '/')}.rgm`);
  if (!exists(file)) return null;
  const buf = fs.readFileSync(file);
  let bones = null, cur = null;
  const meshes = new Map();
  const f32 = (p, n) => Array.from({ length: n }, (_, k) => buf.readFloatLE(p + 4 * k));
  for (const c of chunks(buf, 24, buf.length)) {
    if (c.tag === 'DATASKLN') {
      const n = buf.readUInt32LE(c.data + 4);
      bones = [];
      for (let i = 0, p = c.data + 8; i < n; i++) {
        const len = buf.readUInt32LE(p);
        bones.push({ name: buf.toString('latin1', p + 4, p + 4 + len), parent: buf.readInt16LE(p + 4 + len) });
        p += 6 + len;
      }
      bones.forEach((b, i) => { const t = c.data + c.size - (n - i) * 40; b.rot = f32(t, 4); b.pos = f32(t + 16, 3); b.scl = f32(t + 28, 3); });
    } else if (c.tag === 'FOLDSKMS' || c.tag === 'FOLDSTMS') {
      meshes.set(c.name, (cur = { kind: c.tag.slice(4), skin: [], lods: [], pals: [], bone: null, misc: [] }));
    } else if (c.tag === 'DATASKIN' && cur) {
      const n = buf.readUInt32LE(c.data);
      for (let i = 0, p = c.data + 4; i < n; i++) { const len = buf.readUInt32LE(p); cur.skin.push(buf.toString('latin1', p + 4, p + 4 + len)); p += 46 + len; }
    } else if (c.tag === 'DATA\0LOD' && cur?.kind === 'SKMS') { // FOLDSTMS LOD chunks carry no palette
      const batches = [];
      let p = c.data + 4;
      for (let b = buf.readUInt32LE(c.data); b > 0; b--) {
        p += 4 + buf.readUInt32LE(p) + 60;
        const n = buf.readUInt16LE(p);
        batches.push(Array.from({ length: n }, (_, k) => buf.readUInt16LE(p + 2 + 2 * k)));
        p += 2 + 2 * n;
        p += 4 + buf.readUInt32LE(p);
        p += 4 + buf.readUInt32LE(p);
      }
      cur.pals.push(batches);
    } else if (c.tag === 'DATALGEO' && cur) {
      const nv = buf.readUInt32LE(c.data), rows = c.data + 8 + nv * 8;
      const pos = new Float32Array(nv * 3), bi = new Uint8Array(nv * 4), wt = new Uint8Array(nv * 4);
      for (let i = 0; i < nv; i++) {
        const q = c.data + 4 + 8 * i, r = rows + 8 * buf.readUInt16LE(q + 6);
        for (let k = 0; k < 3; k++) pos[i * 3 + k] = halfToFloat(buf.readUInt16LE(q + 2 * k));
        for (let k = 0; k < 4; k++) { bi[i * 4 + k] = buf[r + 2 * k]; wt[i * 4 + k] = buf[r + 2 * k + 1]; }
      }
      cur.lods.push({ nv, pos, bi, wt });
    } else if (c.tag === 'DATAMISC' && cur) cur.misc.push(...printable(buf, c.data, c.data + c.size));
  }
  if (!bones?.length || ![...meshes.values()].some((m) => m.kind === 'SKMS')) return null;
  const index = new Map(bones.map((b, i) => [b.name, i]));
  for (const m of meshes.values()) if (m.kind === 'STMS') m.bone = m.misc.find((s) => index.has(s)) ?? bones[0].name;
  return { bones, index, meshes };
}

/** The art's per-LOD switch distances (rgm DATALODD, metres), or null. */
function lodDistances(art) {
  const file = path.join(CFG.extracted, 'ArtHigh', `${art.replace(/\\/g, '/')}.rgm`);
  if (!exists(file)) return null;
  const buf = fs.readFileSync(file);
  for (const c of chunks(buf, 24, buf.length)) {
    if (c.tag === 'DATALODD') return Array.from({ length: buf.readUInt32LE(c.data) }, (_, k) => round(buf.readFloatLE(c.data + 4 + 4 * k)));
  }
  return null;
}

// column-major 4×4 helpers (glTF layout)
function trsMatrix([qx, qy, qz, qw], [tx, ty, tz], [sx, sy, sz]) {
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz, xx = qx * x2, xy = qx * y2, xz = qx * z2, yy = qy * y2, yz = qy * z2, zz = qz * z2, wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return [(1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0, (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0, (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0, tx, ty, tz, 1];
}
function mulMatrix(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
/** (T·R·S)⁻¹ = S⁻¹·R⁻¹·T⁻¹ */
function trsInverse([qx, qy, qz, qw], t, s) {
  const sInv = [1 / s[0], 0, 0, 0, 0, 1 / s[1], 0, 0, 0, 0, 1 / s[2], 0, 0, 0, 0, 1];
  return mulMatrix(mulMatrix(sInv, trsMatrix([-qx, -qy, -qz, qw], [0, 0, 0], [1, 1, 1])), trsMatrix([0, 0, 0, 1], t.map((v) => -v), [1, 1, 1]));
}

/** Joint nodes (local bind TRS) under `holder` + a glTF skin whose inverse bind matrices undo the composed bind pose. */
function addSkeleton(doc, holder, rig, name) {
  const nodes = rig.bones.map((b) => doc.createNode(b.name).setTranslation(b.pos).setRotation(b.rot).setScale(b.scl));
  const inv = [];
  rig.bones.forEach((b, i) => {
    const local = trsInverse(b.rot, b.pos, b.scl);
    inv[i] = b.parent >= 0 ? mulMatrix(local, inv[b.parent]) : local; // parents precede children
    (b.parent >= 0 ? nodes[b.parent] : holder).addChild(nodes[i]);
  });
  const ibm = new Float32Array(rig.bones.length * 16);
  inv.forEach((m, i) => ibm.set(m, i * 16));
  const acc = doc.createAccessor(`${name}_ibm`).setType('MAT4').setArray(ibm).setBuffer(doc.getRoot().listBuffers()[0]);
  const skin = doc.createSkin(name).setSkeleton(nodes[0]).setInverseBindMatrices(acc);
  for (const n of nodes) skin.addJoint(n);
  return skin;
}

/**
 * JOINTS_0/WEIGHTS_0 for every primitive of an exported geom doc (rrgeom LOD `lod`, slot `slot`) from the rig mesh with
 * the same name. A seam position can sit in several batches' LGEO ranges; the slot's own batch range is the span of
 * its positions that occur only once, and a shared position takes its candidate inside that span.
 */
function skinGeom(src, rig, rm, lod, slot) {
  const buffer = src.getRoot().listBuffers()[0];
  const fixed = rig.index.get(rm.bone) ?? 0;
  const lg = rm.kind === 'SKMS' ? rm.lods[lod] : null, pal = lg && rm.pals[lod]?.[slot];
  if (lg && !pal) throw new Error(`skin ${[...rig.meshes].find(([, m]) => m === rm)[0]}: no bone palette for LOD ${lod} slot ${slot}`);
  const lut = new Map(); // position → LGEO indices, ascending
  if (lg) for (let i = 0; i < lg.nv; i++) {
    const key = `${lg.pos[i * 3]},${lg.pos[i * 3 + 1]},${lg.pos[i * 3 + 2]}`;
    (lut.get(key) ?? lut.set(key, []).get(key)).push(i);
  }
  const prims = src.getRoot().listMeshes().flatMap((m) => m.listPrimitives());
  const found = prims.map((prim) => {
    const P = prim.getAttribute('POSITION').getArray();
    return Array.from({ length: P.length / 3 }, (_, v) => lut.get(`${P[v * 3]},${P[v * 3 + 1]},${P[v * 3 + 2]}`));
  });
  let lo = 0, hi = Infinity;
  if (lg && rm.pals[lod].length > 1) {
    const single = found.flat().filter((c) => c?.length === 1).map((c) => c[0]);
    if (single.length) { lo = Math.min(...single); hi = Math.max(...single); }
  }
  let missed = 0;
  prims.forEach((prim, pi) => {
    const n = found[pi].length;
    const J = rig.bones.length > 255 ? new Uint16Array(n * 4) : new Uint8Array(n * 4), W = new Float32Array(n * 4);
    for (let v = 0; v < n; v++) {
      const c = found[pi][v];
      if (!c) { J[v * 4] = fixed; W[v * 4] = 1; if (lg) missed++; continue; }
      const s = c.find((i) => i >= lo && i <= hi) ?? c[0];
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += lg.wt[s * 4 + k];
      for (let k = 0; k < 4; k++) {
        const w = lg.wt[s * 4 + k];
        if (!w) continue;
        J[v * 4 + k] = rig.index.get(rm.skin[pal[lg.bi[s * 4 + k]]]) ?? 0;
        W[v * 4 + k] = w / sum;
      }
    }
    prim.setAttribute('JOINTS_0', src.createAccessor().setType('VEC4').setArray(J).setBuffer(buffer));
    prim.setAttribute('WEIGHTS_0', src.createAccessor().setType('VEC4').setArray(W).setBuffer(buffer));
  });
  return missed;
}

// ───────────────────────────── Attrib (rgd) ─────────────────────────────
const ATTRIB_ROOT = () => path.join(CFG.extracted, 'Attrib', 'attrib');
let attribIndex = null; // stem → [rel]
function attribFind(stem, prefix) {
  if (!attribIndex) {
    attribIndex = new Map();
    for (const rel of walkFiles(ATTRIB_ROOT())) {
      if (!rel.endsWith('.rgd')) continue;
      const s = path.posix.basename(rel, '.rgd');
      if (!attribIndex.has(s)) attribIndex.set(s, []);
      attribIndex.get(s).push(rel);
    }
  }
  return (attribIndex.get(stem) ?? []).find((r) => r.startsWith(prefix)) ?? null;
}
const rgdCache = (rel) => path.join(CFG.cache, 'rgd', `${slug(rel)}.json`);
async function rgd(rel) {
  const out = rgdCache(rel);
  if (!exists(out)) {
    mkdirp(path.dirname(out));
    const r = await essence('rgd-decode', '-f', 'json', path.join(ATTRIB_ROOT(), rel), out);
    if (!exists(out)) throw new Error(`rgd-decode ${rel} failed:\n${r.out.slice(-500)}`);
  }
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  return j.data.find((n) => n.key === 'default')?.value ?? [];
}
/** Flatten rgd nodes to [[path, value]] with '/'-joined keys. */
function flat(nodes, prefix = '', out = []) {
  for (const n of nodes) {
    const p = `${prefix}/${n.key}`;
    if (Array.isArray(n.value)) flat(n.value, p, out); else out.push([p, n.value]);
  }
  return out;
}
const firstValue = (fl, suffix) => fl.find(([p]) => p.endsWith(suffix))?.[1] ?? null;
/** Value at a key path below rgd nodes (undefined when absent). */
const child = (nodes, ...keys) => keys.reduce((ns, k) => (Array.isArray(ns) ? ns.find((n) => n.key === k)?.value : undefined), nodes);
/** Every list-valued node named `key` below `nodes`, depth-first. */
function findNodes(nodes, key, out = []) {
  for (const n of nodes) {
    if (!Array.isArray(n.value)) continue;
    if (n.key === key) out.push(n.value);
    else findNodes(n.value, key, out);
  }
  return out;
}

/**
 * Attachment list → { variants: [{category, meshes:[art], stamps:[stamp], props:[{art, marker, inv}]}] }. Meshes and
 * stamps come from the default inventory only; props are the animator_sim_attachment arts riding rig markers
 * (shields in the default inventory, villager tools and carried resources per inventory category).
 */
async function attachmentList(name) {
  const rel = attribFind(name, 'attachments/');
  if (!rel) return { variants: [] };
  const top = await rgd(rel);
  const node = top.find((n) => n.key === 'attachment_lists')?.value ?? [];
  const lists = node.find((n) => n.key === 'attachment_lists')?.value ?? [];
  const byCat = new Map();
  for (const entry of lists) {
    if (entry.key !== 'attachment_list') continue;
    const fl = flat(entry.value);
    const inv = firstValue(fl, '/inventory_category') || 'default';
    const cat = firstValue(fl, '/attachment_category') || 'default';
    if (!byCat.has(cat)) byCat.set(cat, { category: cat, meshes: [], stamps: [], props: [] });
    const v = byCat.get(cat);
    for (const sim of findNodes(entry.value, 'animator_sim_attachment')) {
      const art = child(sim, 'animator'), marker = child(sim, 'attach_data', 'marker_name_parent');
      if (art && marker && !v.props.some((p) => p.art === art && p.inv === inv)) v.props.push({ art, marker, inv });
    }
    if (inv !== 'default') continue;
    for (const [p, val] of fl) {
      if (typeof val !== 'string' || !val) continue;
      if (/\/animator_merge_mesh_attachment\/meshes\/animator\d+$/.test(p) || /\/animator_skin_attachment\/animator$/.test(p)) {
        if (!v.meshes.includes(val)) v.meshes.push(val);
      }
      else if (/\/attachment_list\/stamp_attachment\/stamp$/.test(p) && !/\\const_dest\\/.test(val)) v.stamps.push(val);
    }
  }
  let variants = [...byCat.values()].filter((v) => v.meshes.length || v.stamps.length);
  // Animal skins named after one another in a category (the Mongol herdable sheep: sheep, sheep_black, sheep_brown) are
  // alternative coats of one animal, not a flock: one variant per coat, other meshes (tusks) ride along on each.
  // Unrelated names (the Jin cart's jin_horse_a + jin_horse_b) are a team and stay one variant.
  variants = variants.flatMap((v) => {
    const coats = v.meshes.filter((m) => /\\animals\\/.test(m)), stem = coats.map(baseName).sort((a, b) => a.length - b.length)[0];
    return coats.length < 2 || !coats.every((m) => baseName(m).startsWith(stem)) ? [v]
      : coats.map((m) => ({ ...v, meshes: v.meshes.filter((x) => x === m || !coats.includes(x)) }));
  });
  // A list's parent_animator is the entity's own mesh (relics, berry bushes) unless it is a bare rig/layout. Such a
  // mesh alone is the entity's look: entries under another attachment category are swaps a gameplay state turns on
  // (berry bushes: the fence stamp under `sultante_improved`), so only the default category rides along.
  const parent = node.find((n) => n.key === 'parent_animator')?.value;
  if (parent && !/\\(layouts|archetypes)\\/.test(parent) && (await locateArt(`${parent}.rrgeom`))) {
    variants = variants.filter((v) => v.category === 'default');
    if (!variants.length) variants.push({ category: 'default', meshes: [], stamps: [], props: [] });
    for (const v of variants) if (!v.meshes.includes(parent)) v.meshes.unshift(parent);
  }
  return { variants };
}

/** bp → { civ, icon, ebps, ages: {age: variants[]}, weapons }  (several ages only for tiered buildings). */
async function resolveBlueprint(bp, maxAge) {
  const rel = attribFind(bp, 'ebps/');
  if (!rel) return null;
  const civ = /^ebps\/races\/([^/]+)\//.exec(rel)?.[1] ?? null;
  const tree = await rgd(rel), fl = flat(tree);
  // Units carry their icon on the squad blueprint (sbps/…/<bp>: squad_ui_ext/race_list/race_data/info/icon_name).
  let icon = firstValue(fl, '/ui_ext/icon_name') || null;
  const sbps = icon ? null : attribFind(bp, 'sbps/');
  if (sbps) icon = firstValue(flat(await rgd(sbps)), '/squad_ui_ext/race_list/race_data/info/icon_name') || null;
  const tierNames = fl.filter(([p, v]) => p.endsWith('/tier_ext/tier_group_list/tier_group/tier/attachments/$PBGNAME') && v).map(([, v]) => v);
  const ages = {};
  // When no attachment list names a mesh the entity may still carry its own art: alternate_sua (siege weapons that share
  // another civ's model, e.g. the Abbasid mangonel = eng_mangonel) or, for a farm, a mesh resource animator (the
  // Byzantine olive orchard; crop fields are FARM_CROPS, rendered as terrain).
  const ownArt = async () => {
    const alt = firstValue(fl, '/entity_blueprint_ext/alternate_sua');
    const anim = firstValue(fl, '/resource_spline_option/resource_animator_groups/resource_animator_group/resource_animator');
    const art = alt && !/\\(sua|archetypes)\\/.test(alt) && (await locateArt(`${alt}.rrgeom`)) ? alt
      : anim && !FARM_CROPS[baseName(anim)] && (await locateArt(`${anim}.rrgeom`)) ? anim : null;
    return art ? [{ category: 'default', meshes: [art], stamps: [], props: [] }] : [];
  };
  // A farm whose resource animator is a mesh (olive orchard) is that mesh; its stamp only paints soil.
  const farmMesh = /^building_resource_farm/.test(bp) ? await ownArt() : [];
  const numbered = tierNames.map((n) => [Number(/^tier(\d)_/.exec(n)?.[1] ?? 0), n]).filter(([a]) => a > 0);
  if (farmMesh.length) {
    for (let age = 1; age <= maxAge; age++) ages[age] = farmMesh;
  } else if (numbered.length) {
    for (let age = 1; age <= maxAge; age++) {
      const fit = numbered.filter(([a]) => a <= age).pop() ?? numbered[0];
      const v = (await attachmentList(fit[1])).variants;
      ages[age] = v.length ? v : await ownArt();
    }
  } else {
    for (const n of tierNames) { const v = (await attachmentList(n)).variants; if (v.length) { ages[1] = v; break; } }
    if (!ages[1]) {
      const base = firstValue(fl, '/entity_blueprint_ext/animator_attachments/$PBGNAME');
      if (base) { const v = (await attachmentList(base)).variants; if (v.length) ages[1] = v; }
    }
    if (!ages[1]) { const v = await ownArt(); if (v.length) ages[1] = v; }
  }
  const sight = Number(firstValue(fl, '/sight_ext/sight_package/outer_radius')) || 0; // metres, first sight package
  return { civ, icon, ages, ebps: rel, sight, weapons: await hardpointWeapons(tree) };
}

/** Variant → parts list with transforms (mesh arts at identity, stamps expanded). */
async function variantParts(variant, civ) {
  const parts = [];
  for (const art of variant.meshes) if (await locateArt(`${art}.rrgeom`)) parts.push({ art, quat: [0, 0, 0, 1], pos: [0, 0, 0], scale: [1, 1, 1] });
  for (const stamp of variant.stamps) {
    const file = path.join(CFG.extracted, 'Data', `${stamp.replace(/\\/g, '/')}.bin`);
    if (!exists(file)) continue;
    const ps = [];
    for (const p of parseStamp(file)) {
      if (STAMP_ART.test(p.art) && !STAMP_SKIP.test(p.art) && (await locateArt(`${p.art}.rrgeom`))) ps.push(p);
    }
    const artCiv = ART_CIV[civ] ?? civ;
    const own = ps.some((p) => /\\structures\\/.test(p.art) && civOf(p.art) === artCiv);
    parts.push(...(own ? ps.filter((p) => !/\\structures\\/.test(p.art) || civOf(p.art) === artCiv || civOf(p.art) === 'common') : ps));
  }
  return parts;
}
const variantKey = (v) => [...v.meshes, ...v.stamps].map(baseName).join('+');

/**
 * A wall blueprint's gap fillers (ebps territory_sector_layout_ext/placement_style/gap_fillers): the stakes the game
 * plants from a wall to an obstacle a unit could otherwise slip through. → { spec, visuals } or null: spec as the
 * viewer reads it (catalog.json blueprints[bp].gapFill: reach, offset, onlyCapless, radial { step, occupied } (posts:
 * a stake every step degrees outside the occupied degrees around each wall arm), capless { reach, count, range,
 * offset, radial } (a free wall end's fan), pieces [{ len, model }]); visuals [{ key, art }] the piece models to build.
 */
const GAP = '/territory_sector_layout_ext/placement_style/gap_fillers';
async function gapFillers(rel) {
  const fl = flat(await rgd(rel)).filter(([p]) => p.startsWith(GAP));
  if (!fl.length) return null;
  const num = (suffix) => Number(firstValue(fl, suffix));
  const pieces = [], visuals = [];
  for (const [p, v] of fl) {
    if (p.endsWith('/gap_filler_visual/visual_length')) pieces.push({ len: Number(v), model: null });
    else if (p.endsWith('/gap_filler_visual/visual') && pieces.length && v) {
      const art = `art\\${v}`;
      pieces.at(-1).model = baseName(art);
      visuals.push({ key: baseName(art), art });
    }
  }
  if (!pieces.some((x) => x.model)) return null;
  // the shorter stakes ship without a material of their own and wear the one piece's that has one (eng: the 4 m)
  const own = [];
  for (const v of visuals) if (await locateArt(`${v.art}.rrmaterial`)) own.push(v.art);
  for (const v of visuals) if (own.length && !own.includes(v.art)) MATERIAL_OF.set(v.art, own[0]);
  return {
    spec: {
      reach: num('/gap_fillers/gap_filler_length'), offset: num('/gap_fillers/gap_filler_offset'),
      onlyCapless: String(firstValue(fl, '/only_create_capless_wall_end_gap_fillers')).toLowerCase() === 'true',
      radial: { step: num('/spacing/desired_degrees_between_radial_gap_fillers'), occupied: num('/spacing/degrees_occupied_by_wall') },
      capless: {
        reach: num('/gap_filler_length_capless_wall_end'), count: num('/capless_wall_ends/desired_number_of_gap_fillers'),
        range: num('/capless_wall_ends/desired_degrees_range'), offset: num('/capless_wall_ends/offset_from_end_of_wall'),
        radial: num('/capless_wall_ends/radial_offset'),
      },
      pieces: pieces.filter((x) => x.model),
    },
    visuals,
  };
}

/**
 * What wall stakes reach for: a blueprint whose ebps impass_ext attach_gap_fillers is set (mines and berry bushes; not
 * trees or buildings) → its footprint [x, z] in metres (site_ext footprint_scale; axis-aligned, 0 = none), else null.
 */
async function gapTarget(rel) {
  const fl = flat(await rgd(rel));
  if (String(firstValue(fl, '/impass_ext/attach_gap_fillers')).toLowerCase() !== 'true') return null;
  return [Number(firstValue(fl, '/site_ext/footprint_scale/x')) || 0, Number(firstValue(fl, '/site_ext/footprint_scale/y')) || 0];
}

/**
 * A unit that can supervise a building (its sbps lists an official_supervise_building_target ability) shows the game's
 * floating eye over its head while it does: base_civilian's animator plays fx_bhv_supervise_eye on supervise_eye_state
 * (particlesystems\fx_ui\fx_gameplay\fx_floating_eye, whose particle file is not extracted; its mesh is fxmesh_eye).
 */
const SUPERVISE_FX = 'art\\fx\\particlesystems\\fx_meshes\\fxmesh_eye\\fxmesh_eye';
async function supervises(bp) {
  const sbps = attribFind(bp, 'sbps/');
  return !!sbps && flat(await rgd(sbps)).some(([, v]) => typeof v === 'string' && /supervise_building_target/.test(v));
}

// ───────────────────────────── equipment (weapons, shields, tools) ─────────────────────────────
// Units hold weapons, shields and tools as separate arts on rig markers (MetaRig_RArmPalmSocket, …): hardpoint
// weapons (ebps combat_ext non_entity_weapon_wrapper → its attachment list's parent_animator) and the
// animator_sim_attachment props of the unit's attachment lists. Each prop becomes a rigid part skinned 100 % to an
// extra joint under its marker, so it follows the posed hand; the viewer hides one by scaling its joint to 0. Joint
// names: rvwpn_main (primary weapon), rvwpn_torch (torch for attacking buildings), rvgear_<art> (always carried:
// shields), rvtool_<art> (villager tools and carried resources, shown while the matching work is under way).
const TOOL_INVENTORY = /^(axe_2hand_single|mining_gold_hammer_pick|mining_stone_hammer|sickle_farming|build_hammer|forage_basket_empty|knife|hunt_bow|fishing_net|res_(wood|gold|stone|meat|berries|wheat|fish)_carry)$/;
const PROP_TEX = 256; // prop albedo cap in the unit atlas
const UNIT_CATS = /^(villager|cavalry|infantry|ranged|religious)$/; // replay categories that get equipment and combat timings

/**
 * Weapon blueprint → attack timing/range for the viewer's combat animation, or null. A wpn_* weapon entity (what
 * buildings attach for each of their weapons: wpn_range_town_center_arrows, …) resolves through the weapon it wraps.
 */
async function weaponStats(pbg) {
  let rel = pbg && attribFind(pbg, 'weapon/');
  const ent = !rel && pbg && attribFind(pbg, 'ebps/');
  if (ent) rel = attribFind(firstValue(flat(await rgd(ent)), '/weapon_ext/weapon/$PBGNAME'), 'weapon/');
  if (!rel) return null;
  const fl = flat(await rgd(rel));
  const num = (s) => Number(firstValue(fl, `/weapon_bag/${s}`)) || 0;
  const out = {
    pbg, class: firstValue(fl, '/weapon_bag/weapon_class') || null, damage: firstValue(fl, '/weapon_bag/damage/damage_type') || null,
    range: num('range/max'), aim: num('aim/fire_aim_time/max'), windUp: num('fire/wind_up'), windDown: num('fire/wind_down'),
    impact: num('fire/animation_impact_frame_time'), cooldown: num('cooldown/duration/max'), reload: num('reload/duration/max'),
    moving: firstValue(fl, '/weapon_bag/moving/can_fire_while_moving') === true,
  };
  out.period = Math.round((out.aim + out.windUp + out.windDown + out.cooldown + out.reload) * 1000) / 1000; // one attack cycle (s)
  const proj = firstValue(fl, '/weapon_bag/projectile/projectile/$PBGNAME');
  const prel = proj && attribFind(proj, 'ebps/');
  if (prel) {
    const pf = flat(await rgd(prel));
    out.projectile = { pbg: proj, speedMin: Number(firstValue(pf, '/trajectory_option/speed_min')) || 0, speedMax: Number(firstValue(pf, '/trajectory_option/speed_max')) || 0 };
  }
  return out;
}

/** Attachment list → its parent_animator art (a weapon's own mesh), or null. */
async function propArt(list) {
  const rel = list && attribFind(list, 'attachments/');
  if (!rel) return null;
  const art = child((await rgd(rel)).find((n) => n.key === 'attachment_lists')?.value ?? [], 'parent_animator');
  return art && (await locateArt(`${art}.rrgeom`)) ? art : null;
}

/** ebps tree → { main, torch }: the primary hardpoint weapon and the torch, each { stats, art, marker } or null. */
async function hardpointWeapons(tree) {
  const all = findNodes(tree, 'non_entity_weapon_wrapper').map((w) => ({
    pbg: child(w, 'non_entity_weapon_wrapper_pbg', '$PBGNAME'), list: child(w, 'animator_attachments', '$PBGNAME'), marker: child(w, 'marker_name_parent'),
  })).filter((w) => w.pbg);
  const pick = async (w) => (w ? { stats: await weaponStats(w.pbg), art: await propArt(w.list), marker: w.marker || null } : null);
  return { main: await pick(all.find((w) => !/torch/.test(w.pbg))), torch: await pick(all.find((w) => /torch/.test(w.pbg))) };
}

/** Props a unit model carries: variant gear/tools plus its hardpoint weapons → [{art, marker, joint}] (unique joints). */
function unitProps(variant, weapons, cat) {
  const out = [];
  const add = (art, marker, joint) => { if (art && marker && !out.some((p) => p.joint === joint)) out.push({ art, marker, joint }); };
  for (const p of variant.props) {
    if (p.inv === 'default') add(p.art, p.marker, `rvgear_${baseName(p.art)}`);
    else if (TOOL_INVENTORY.test(p.inv)) add(p.art, p.marker, `rvtool_${baseName(p.art)}`);
  }
  if (cat !== 'villager') add(weapons?.main?.art, weapons?.main?.marker, 'rvwpn_main'); // villagers fight with their tools
  add(weapons?.torch?.art, weapons?.torch?.marker, 'rvwpn_torch');
  return out;
}

// ───────────────────────────── textures ─────────────────────────────
const decoding = new Map(); // art path → Promise<png file | null>: export workers and model builds share decodes
function decodeTexture(artPath) {
  if (!decoding.has(artPath)) decoding.set(artPath, (async () => {
    const out = path.join(CFG.cache, 'tex', `${slug(artPath)}.png`);
    if (exists(out)) return out;
    const src = await locateArt(artPath);
    if (!src) return null;
    mkdirp(path.dirname(out));
    await essence('rrtex-decode', src, out);
    return exists(out) ? out : null;
  })());
  return decoding.get(artPath);
}
const readPng = (bufOrFile) => PNG.sync.read(typeof bufOrFile === 'string' ? fs.readFileSync(bufOrFile) : Buffer.from(bufOrFile));
function downscale(png, max) {
  let { width: w, height: h, data } = png;
  while (w > max || h > max) {
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1), nd = Buffer.alloc(nw * nh * 4);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) for (let c = 0; c < 4; c++) {
      const a = ((2 * y) * w + 2 * x) * 4 + c, b = a + 4, d = a + w * 4, e = d + 4;
      nd[(y * nw + x) * 4 + c] = (data[a] + data[b] + data[d] + data[e] + 2) >> 2;
    }
    w = nw; h = nh; data = nd;
  }
  return { width: w, height: h, data };
}
function hasCutout(data) {
  for (let i = 3; i < data.length; i += 4) if (data[i] < 128) return true;
  return false;
}
function encodePng({ width, height, data }) {
  let opaque = true;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) { opaque = false; break; }
  const png = new PNG({ width, height });
  Buffer.from(data).copy(png.data);
  return PNG.sync.write(png, { colorType: opaque ? 2 : 6, inputColorType: 6 });
}
function sampleChannel(png, ch, u, v) {
  if (!png) return 0;
  const x = Math.min(png.width - 1, Math.floor(u * png.width)), y = Math.min(png.height - 1, Math.floor(v * png.height));
  return png.data[(y * png.width + x) * 4 + ch];
}
/** Tint mask from patternTex: R = player-colour cloth, G = skin (tinted by skinTintLUT in-game); B unused. */
async function buildMask(block, width, height) {
  const pattern = block.tex.patternTexture ?? block.tex.patternTex;
  const pPng = pattern ? await decodeTexture(pattern).then((f) => f && readPng(f)) : null;
  if (!pPng) return null;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = (x + 0.5) / width, v = (y + 0.5) / height, i = (y * width + x) * 4;
    data[i] = sampleChannel(pPng, 0, u, v);
    data[i + 1] = sampleChannel(pPng, 1, u, v);
    data[i + 3] = 255;
  }
  return encodePng({ width, height, data });
}

// ───────────────────────────── PBR maps (see header "PBR maps") ─────────────────────────────
/** Material families whose normalMap / metalTex use the unit/object packing (vegetation has a normalMap only). */
const PBR_TYPES = /^(unit|object|object_collection|vegetation|vegetation_billboard)$/;
/** Fill for atlas regions without a map: flat normal; roughness 0.85 / metalness 0 (the plain-material factors). */
const NEUTRAL = { nrm: [128, 128, 255, 255], orm: [255, 217, 0, 255] };
/** normalMap (A = X, G = Y) → glTF tangent-space normal (X, Y, rebuilt Z). */
function normalImage({ width, height, data }) {
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < out.length; i += 4) {
    const x = data[i + 3] / 127.5 - 1, y = data[i + 1] / 127.5 - 1;
    out[i] = data[i + 3]; out[i + 1] = data[i + 1];
    out[i + 2] = Math.round((Math.sqrt(Math.max(0, 1 - x * x - y * y)) * 0.5 + 0.5) * 255);
    out[i + 3] = 255;
  }
  return { width, height, data: out };
}
/** metalTex (R metalness, A roughness) → glTF metallicRoughness (G roughness, B metalness, R 255). */
function ormImage({ width, height, data }) {
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < out.length; i += 4) { out[i] = 255; out[i + 1] = data[i + 3]; out[i + 2] = data[i]; out[i + 3] = 255; }
  return { width, height, data: out };
}
/** A block's map slot → glTF-packed PNG (≤ CFG.maxTex), or null when the block has none or it does not decode. */
async function pbrMap(block, slot, convert) {
  const file = block.tex[slot] ? await decodeTexture(block.tex[slot]) : null;
  return file ? encodePng(convert(downscale(readPng(file), CFG.maxTex))) : null;
}

// ───────────────────────────── KTX2 (see header "KTX2") ─────────────────────────────
/** Basis Universal settings per texture role (ktx2-encoder options). */
const KTX2 = {
  color: { isUASTC: false, qualityLevel: 255, compressionLevel: 2, isPerceptual: true, isSetKTX2SRGBTransferFunc: true },
  mask: { isUASTC: true, uastcLDRQualityLevel: 2, needSupercompression: true, isPerceptual: false, isSetKTX2SRGBTransferFunc: false },
  normal: { isUASTC: true, uastcLDRQualityLevel: 2, needSupercompression: true, isPerceptual: false, isSetKTX2SRGBTransferFunc: false },
  orm: { isUASTC: true, uastcLDRQualityLevel: 2, enableRDO: true, rdoQualityLevel: 1, needSupercompression: true, isPerceptual: false, isSetKTX2SRGBTransferFunc: false },
};
const ktxWorkers = [], ktxQueue = [], ktxDone = new Map(); // ktxDone: role + image hash → Promise<KTX2 bytes>
const texStats = Object.fromEntries(Object.keys(KTX2).map((r) => [r, { count: 0, bytes: 0, pngBytes: 0 }]));
/** RGBA image → KTX2 bytes for `role`, encoded on the worker pool (identical inputs once per run). */
function encodeKtx2(img, role) {
  const key = crypto.createHash('sha1').update(`${role} ${img.width}x${img.height}`).update(img.data).digest('hex');
  if (!ktxDone.has(key)) ktxDone.set(key, new Promise((resolve, reject) => { ktxQueue.push({ img, role, resolve, reject }); pumpKtx(); }));
  return ktxDone.get(key);
}
function pumpKtx() {
  while (ktxQueue.length) {
    let w = ktxWorkers.find((x) => !x.job);
    if (!w && ktxWorkers.length < CFG.ktxThreads) {
      w = { worker: new Worker(new URL(import.meta.url)), job: null };
      const self = w;
      w.worker.on('message', ({ ktx, error }) => {
        const job = self.job;
        self.job = null;
        if (error) job.reject(new Error(`KTX2 ${job.role} ${job.img.width}×${job.img.height}: ${error}`)); else job.resolve(ktx);
        pumpKtx();
      });
      w.worker.on('error', (e) => { ktxWorkers.splice(ktxWorkers.indexOf(self), 1); self.job?.reject(e); pumpKtx(); });
      ktxWorkers.push(w);
    }
    if (!w) return;
    w.job = ktxQueue.shift();
    w.worker.postMessage({ img: w.job.img, role: w.job.role });
  }
}
/** Worker thread: one Basis encoder, RGBA in → KTX2 out (mipmapped). */
async function ktxWorker() {
  console.log = () => {}; // the Basis wasm prints every slice to stdout whatever enableDebug says; errors still reach stderr
  const { encodeToKTX2 } = await import('ktx2-encoder');
  parentPort.on('message', async ({ img, role }) => {
    try {
      const ktx = await encodeToKTX2(img.data, { ...KTX2[role], isKTX2File: true, generateMipmap: true, enableDebug: false, imageDecoder: async () => img });
      parentPort.postMessage({ ktx }, [ktx.buffer]);
    } catch (e) { parentPort.postMessage({ error: e.message }); }
  });
}

/**
 * Every texture of a finished model → KTX2 by the slot that uses it (baseColor → color, emissive → mask, normal →
 * normal, metallicRoughness / occlusion → orm), base size rounded up to multiples of 4 (bilinear; UVs are normalised).
 */
async function compressTextures(doc) {
  const roles = new Map();
  for (const m of doc.getRoot().listMaterials()) {
    for (const [t, r] of [[m.getNormalTexture(), 'normal'], [m.getMetallicRoughnessTexture(), 'orm'], [m.getOcclusionTexture(), 'orm'], [m.getEmissiveTexture(), 'mask'], [m.getBaseColorTexture(), 'color']]) {
      if (t && !roles.has(t)) roles.set(t, r);
    }
  }
  await Promise.all(doc.getRoot().listTextures().map(async (t) => {
    const role = roles.get(t) ?? 'color', png = t.getImage();
    let img = readPng(png);
    const w = (img.width + 3) & ~3, h = (img.height + 3) & ~3;
    if (w !== img.width || h !== img.height) img = resample(img, w, h);
    const ktx = await encodeKtx2({ width: img.width, height: img.height, data: new Uint8Array(img.data) }, role);
    t.setImage(ktx).setMimeType('image/ktx2');
    Object.assign(texStats[role], { count: texStats[role].count + 1, bytes: texStats[role].bytes + ktx.length, pngBytes: texStats[role].pngBytes + png.length });
  }));
  if (doc.getRoot().listTextures().length) doc.createExtension(KHRTextureBasisu).setRequired(true);
}

// ───────────────────────────── Gen7 bakes (Gen7AssetsMaterials.sga) ─────────────────────────────
// In-game, layered materials blend tiling substances at runtime. Gen7AssetsMaterials ships a pre-baked replacement
// per art: <art>.rrmaterial whose blocks name an albedoTex (BC1, UV0 atlas, alpha = island coverage) and a teamMask
// (BC4 256², or a 4×4 stub when nothing is tinted). Collection meshes (structures) carry no material name in the
// rrgeom; the ArtHigh .rgm FOLDMSCL DATADATA lists the collections as u32 n, n × lstr "<material>_collection",
// n × u32 mesh count, and the rrgeom's *_collection meshes follow that order.
const GEN7 = 'Gen7AssetsMaterials';
/** Layered types that have a Gen7 bake (terrain-shader parts stay stylised). */
const GEN7_TYPES = /^(structure|object_layered|sails|trunk)/;
const gen7File = (rel) => path.join(CFG.extracted, GEN7, rel.replace(/\\/g, '/'));
let gen7Available = false;
const gen7Blocks = (art) => {
  const file = gen7Available ? gen7File(`${art}.rrmaterial`) : null;
  return file && exists(file) ? rrmaterialBlocks(file) : null;
};

/** ArtHigh .rgm → material name per *_collection mesh (rrgeom order), or null. */
function collectionMaterials(art) {
  const file = path.join(CFG.extracted, 'ArtHigh', `${art.replace(/\\/g, '/')}.rgm`);
  if (!exists(file)) return null;
  const buf = fs.readFileSync(file);
  for (const c of chunks(buf, 24, buf.length)) {
    if (c.tag !== 'DATADATA') continue;
    const end = c.data + c.size;
    const lstr = (q) => {
      if (q + 4 > end) return null;
      const len = buf.readUInt32LE(q);
      return len && len <= 96 && q + 4 + len <= end ? buf.toString('latin1', q + 4, q + 4 + len) : null;
    };
    for (let p = c.data; p + 8 <= end; p++) {
      const n = buf.readUInt32LE(p);
      if (n < 1 || n > 32) continue;
      const names = [];
      let q = p + 4;
      for (let s; names.length < n && (s = lstr(q)) && /^\w+_collection$/.test(s); q += 4 + s.length) names.push(s.slice(0, -'_collection'.length));
      if (names.length < n || q + 4 * n > end) continue;
      return names.flatMap((name, i) => Array(buf.readUInt32LE(q + 4 * i)).fill(name));
    }
    return null;
  }
  return null;
}

/** .rrtex → largest mip as { width, height, data: RGBA } (RGBA8, BC1 / BC3 / BC4 → grey), or null for other formats. */
function decodeRrtex(file) {
  if (!exists(file)) return null;
  const buf = fs.readFileSync(file);
  let fmt = 0, pieces = null, mip = null;
  for (const c of chunks(buf, 24, buf.length)) {
    if (c.tag === 'DATATMAN') {
      // +0x14 format, +0x18 mip count, +0x29 per-mip piece counts, then per piece {u32 size, u32 stored size}
      fmt = buf.readUInt32LE(c.data + 0x14);
      const n = buf.readUInt32LE(c.data + 0x18);
      let p = c.data + 0x29 + 4 * n;
      pieces = Array.from({ length: n }, (_, m) => Array.from({ length: buf.readUInt32LE(c.data + 0x29 + 4 * m) }, () => {
        const s = [buf.readUInt32LE(p), buf.readUInt32LE(p + 4)];
        p += 8;
        return s;
      }));
    } else if (c.tag === 'DATATDAT' && pieces) {
      // mips smallest → largest; a piece is zlib unless both sizes match
      let p = c.data + 4;
      pieces.forEach((list, m) => {
        const parts = [];
        for (const [size, stored] of list) {
          if (m === pieces.length - 1) parts.push(size === stored ? buf.subarray(p, p + stored) : zlib.inflateSync(buf.subarray(p, p + stored)));
          p += stored;
        }
        if (parts.length) mip = Buffer.concat(parts);
      });
    }
  }
  const kind = { 2: 'rgba', 18: 1, 19: 1, 22: 3, 23: 3, 24: 4 }[fmt];
  if (!mip || !kind) return null;
  const w = mip.readUInt32LE(4), h = mip.readUInt32LE(8), src = mip.subarray(16); // u32 level, width, height, size
  if (kind === 'rgba') return { width: w, height: h, data: Buffer.from(src.subarray(0, w * h * 4)) };
  const out = Buffer.alloc(w * h * 4), bw = Math.ceil(w / 4), stride = kind === 3 ? 16 : 8;
  const pal = new Uint8Array(16), al = new Uint8Array(8);
  const alphaBlock = (o) => {
    const a0 = src[o], a1 = src[o + 1];
    al[0] = a0; al[1] = a1;
    if (a0 > a1) for (let i = 1; i < 7; i++) al[i + 1] = ((7 - i) * a0 + i * a1 + 3) / 7 | 0;
    else { for (let i = 1; i < 5; i++) al[i + 1] = ((5 - i) * a0 + i * a1 + 2) / 5 | 0; al[6] = 0; al[7] = 255; }
  };
  const colourBlock = (o, fourColour) => {
    const c0 = src.readUInt16LE(o), c1 = src.readUInt16LE(o + 2);
    for (const [c, i] of [[c0, 0], [c1, 4]]) {
      pal[i] = (((c >> 11) & 31) * 527 + 23) >> 6; pal[i + 1] = (((c >> 5) & 63) * 259 + 33) >> 6; pal[i + 2] = ((c & 31) * 527 + 23) >> 6; pal[i + 3] = 255;
    }
    if (fourColour || c0 > c1) {
      for (let k = 0; k < 3; k++) { pal[8 + k] = (2 * pal[k] + pal[4 + k] + 1) / 3 | 0; pal[12 + k] = (pal[k] + 2 * pal[4 + k] + 1) / 3 | 0; }
      pal[11] = pal[15] = 255;
    } else {
      for (let k = 0; k < 3; k++) { pal[8 + k] = (pal[k] + pal[4 + k]) >> 1; pal[12 + k] = 0; }
      pal[11] = 255; pal[15] = 0;
    }
  };
  for (let by = 0; by < Math.ceil(h / 4); by++) for (let bx = 0; bx < bw; bx++) {
    const o = (by * bw + bx) * stride;
    if (kind !== 1) alphaBlock(o);
    if (kind !== 4) colourBlock(kind === 3 ? o + 8 : o, kind === 3);
    const ci = kind === 4 ? 0 : src.readUInt32LE(kind === 3 ? o + 12 : o + 4);
    const lo = src[o + 2] | (src[o + 3] << 8) | (src[o + 4] << 16), hi = src[o + 5] | (src[o + 6] << 8) | (src[o + 7] << 16);
    for (let i = 0; i < 16; i++) {
      const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
      if (x >= w || y >= h) continue;
      const d = (y * w + x) * 4, a = al[(i < 8 ? lo >> (3 * i) : hi >> (3 * (i - 8))) & 7];
      if (kind === 4) { out[d] = out[d + 1] = out[d + 2] = a; out[d + 3] = 255; continue; }
      const k = ((ci >>> (2 * i)) & 3) * 4;
      out[d] = pal[k]; out[d + 1] = pal[k + 1]; out[d + 2] = pal[k + 2];
      out[d + 3] = kind === 3 ? a : pal[k + 3];
    }
  }
  return { width: w, height: h, data: out };
}

/** Bilinear resample to w×h. */
function resample(img, w, h) {
  const { width: sw, height: sh, data: s } = img, out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const fy = Math.max(0, ((y + 0.5) * sh) / h - 0.5), y0 = Math.min(sh - 1, fy | 0), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.max(0, ((x + 0.5) * sw) / w - 0.5), x0 = Math.min(sw - 1, fx | 0), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const top = s[(y0 * sw + x0) * 4 + c] * (1 - tx) + s[(y0 * sw + x1) * 4 + c] * tx;
        const bot = s[(y1 * sw + x0) * 4 + c] * (1 - tx) + s[(y1 * sw + x1) * 4 + c] * tx;
        out[(y * w + x) * 4 + c] = Math.round(top * (1 - ty) + bot * ty);
      }
    }
  }
  return { width: w, height: h, data: out };
}

const gen7Tiles = new Map();
/** Bake → size² RGBA tile: RGB = albedo, A = 255 − team mask (player-colour weight), or null when undecodable. */
function gen7Tile({ alb, team }, size) {
  const key = `${alb.toLowerCase()}|${size}`;
  if (gen7Tiles.has(key)) return gen7Tiles.get(key);
  let tile = null;
  const albedo = decodeRrtex(gen7File(alb));
  if (albedo) {
    tile = downscale(albedo, size);
    if (tile.width !== size || tile.height !== size) tile = resample(tile, size, size);
    tile = { ...tile, data: Buffer.from(tile.data) };
    const mask = team ? decodeRrtex(gen7File(team)) : null;
    const m = mask && mask.width >= 8 ? resample(mask, size, size).data : null;
    for (let i = 0; i < size * size; i++) tile.data[i * 4 + 3] = m ? 255 - m[i * 4] : 255;
  }
  gen7Tiles.set(key, tile);
  return tile;
}

/**
 * Replace every Gen7-backed layered material in a merged model by one shared material whose baseColorTexture packs
 * the bakes into an atlas (structures 512², props 256²) and remap each primitive's UV0 into its tile.
 * Undecodable bakes and UV-less primitives keep the stylised `extras.rv.layered` material.
 */
function bakeGen7(doc, key) {
  const users = [];
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
    const rv = prim.getMaterial()?.getExtras()?.rv;
    if (rv?.gen7 && prim.getAttribute('TEXCOORD_0')) users.push({ prim, rv });
  }
  const tiles = new Map(); // albedo path → { img, size, x, y }
  for (const { rv } of users) {
    const id = rv.gen7.alb.toLowerCase();
    if (tiles.has(id)) continue;
    const size = /^structure/.test(rv.layered) ? 512 : 256, img = gen7Tile(rv.gen7, size);
    if (img) tiles.set(id, { img, size });
  }
  if (tiles.size) {
    const big = [...tiles.values()].filter((t) => t.size === 512), small = [...tiles.values()].filter((t) => t.size === 256);
    const cell = big.length ? 512 : 256, perCell = (cell / 256) ** 2;
    const cells = big.length + Math.ceil(small.length / perCell);
    const cols = Math.ceil(Math.sqrt(cells)), rows = Math.ceil(cells / cols), W = cols * cell, H = rows * cell;
    const place = (t, c, sub) => { t.x = (c % cols) * cell + (sub & 1) * 256; t.y = Math.floor(c / cols) * cell + (sub >> 1) * 256; };
    big.forEach((t, i) => place(t, i, 0));
    small.forEach((t, i) => place(t, big.length + Math.floor(i / perCell), i % perCell));
    const data = Buffer.alloc(W * H * 4, 255);
    for (const t of tiles.values()) for (let y = 0; y < t.size; y++) t.img.data.copy(data, ((t.y + y) * W + t.x) * 4, y * t.size * 4, (y + 1) * t.size * 4);
    const atlas = doc.createTexture(`${key}_gen7`).setImage(encodePng({ width: W, height: H, data })).setMimeType('image/png');
    const mat = doc.createMaterial(`${key}_gen7`).setBaseColorTexture(atlas).setMetallicFactor(0).setRoughnessFactor(0.85).setExtras({ rv: { gen7: true } });
    const buffer = doc.getRoot().listBuffers()[0], e = [0, 0];
    for (const { prim, rv } of users) {
      const t = tiles.get(rv.gen7.alb.toLowerCase());
      if (!t) continue;
      const src = prim.getAttribute('TEXCOORD_0'), n = src.getCount(), uv = new Float32Array(n * 2);
      const lo = 0.5 / t.size, hi = 1 - lo; // half-texel inset: bilinear taps stay inside the tile
      for (let i = 0; i < n; i++) {
        src.getElement(i, e);
        uv[2 * i] = (t.x + Math.min(hi, Math.max(lo, e[0])) * t.size) / W;
        uv[2 * i + 1] = (t.y + Math.min(hi, Math.max(lo, e[1])) * t.size) / H;
      }
      prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(uv).setBuffer(buffer));
      prim.setMaterial(mat);
    }
  }
  for (const m of doc.getRoot().listMaterials()) {
    const rv = m.getExtras()?.rv;
    if (rv?.gen7 && rv.gen7 !== true) { const { gen7, ...rest } = rv; m.setExtras({ rv: rest }); }
  }
}

// ───────────────────────────── model export ─────────────────────────────
/**
 * Stage rrgeom + rrmaterial + textures into one folder and run Essence → per-geom GLBs (once per art per run) →
 * { levels, blocks, dist }: levels[n] = the LOD-n geoms of every visible mesh in export order ({ file, geom, mesh,
 * slot, lod, gen7 }; a mesh with fewer LODs repeats its last, lod = the level it comes from), dist = rgm DATALODD.
 * The PBR maps of the LOD0 materials are decoded here, in the parallel export phase.
 */
const exported = new Map();
function exportArt(art) {
  if (!exported.has(art)) exported.set(art, exportArtOnce(art));
  return exported.get(art);
}
/** Arts that ship without their own .rrmaterial → the art whose material they wear (gapFillers: shorter stakes). */
const MATERIAL_OF = new Map();
async function exportArtOnce(art) {
  const dir = path.join(CFG.cache, 'export', slug(art)), matArt = MATERIAL_OF.get(art) ?? art;
  const geomSrc = await locateArt(`${art}.rrgeom`), matSrc = await locateArt(`${matArt}.rrmaterial`);
  if (!geomSrc || !matSrc) return null;
  const layout = rrgeomLayout(geomSrc);
  const blocks = rrmaterialBlocks(matSrc);
  const total = layout.flat(2).length;
  const name = baseName(art);
  const files = Array.from({ length: total }, (_, i) => path.join(dir, `${i}_${name}.glb`));
  if (CFG.force || !files.every(exists)) {
    const stage = path.join(CFG.cache, 'stage');
    const rel = art.replace(/\\/g, '/');
    mkdirp(path.dirname(path.join(stage, rel)));
    fs.copyFileSync(geomSrc, path.join(stage, `${rel}.rrgeom`));
    fs.copyFileSync(matSrc, path.join(stage, `${rel}.rrmaterial`));
    for (const b of Object.values(blocks)) for (const t of Object.values(b.tex)) {
      if (!t.endsWith('.rrtex')) continue;
      const src = await locateArt(t);
      if (!src) continue;
      const dst = path.join(stage, t.replace(/\\/g, '/'));
      if (!exists(dst)) { mkdirp(path.dirname(dst)); fs.copyFileSync(src, dst); }
    }
    mkdirp(dir);
    const r = await essence('model-export', '-m', '--texture-path', stage, path.join(stage, `${rel}.rrgeom`), path.join(dir, `${name}.glb`));
    if (!files.every(exists)) throw new Error(`model-export ${art} failed (code ${r.code}):\n${r.out.slice(-800)}`);
  }
  // every geom of every visible mesh, each with the Gen7 bake of its material (if any)
  const gen7 = gen7Blocks(matArt);
  const isColl = (mesh) => /_collection/.test(mesh[0]?.[0]?.type ?? '');
  let coll = gen7 && layout.some(isColl) ? collectionMaterials(art) : null;
  if (coll?.length !== layout.filter(isColl).length) coll = null;
  const geoms = []; // per visible mesh: per LOD: geoms
  let i = 0, ci = 0;
  layout.forEach((mesh, mi) => {
    const collName = isColl(mesh) ? coll?.[ci++] : null;
    const helper = HELPER_MESH.test(mesh[0]?.[0]?.strings[0] ?? '');
    const lods = mesh.map((lod, li) => lod.map((geom, slot) => {
      const b = gen7?.[collName ?? geom.matName];
      return { file: files[i++], geom, mesh: mi, slot, lod: li, gen7: b?.tex.albedoTex ? { alb: b.tex.albedoTex, team: b.tex.teamMask ?? null } : null };
    }));
    if (!helper && lods.length) geoms.push(lods);
  });
  const count = Math.max(1, ...geoms.map((m) => m.length));
  const levels = Array.from({ length: count }, (_, n) => geoms.flatMap((m) => m[Math.min(n, m.length - 1)]));
  const maps = new Set(levels[0].flatMap(({ geom }) => {
    const b = geom.matName && blocks[geom.matName];
    return b && PBR_TYPES.test(b.type) ? ['normalMap', 'metalTex', 'patternTexture', 'patternTex'].map((s) => b.tex[s]).filter(Boolean) : [];
  }));
  await Promise.all([...maps].map(decodeTexture));
  return { levels, blocks, dist: count > 1 ? lodDistances(art) : null };
}

const io = new NodeIO().registerExtensions([KHRTextureBasisu]); // the writer drops unregistered extensions

/**
 * Vegetation tintColourLUT (RGBA8 strip of 10–50 texels spanning a species' colour range, mostly greens with a few
 * yellow/orange entries) → its sRGB hex colours, or null. #7f7f7f is neutral: berry bushes, whose albedo is already
 * green, ship a flat #7f7f7f strip, while tree leaf albedos are grey and take their colour from the strip (the viewer
 * multiplies by colour / #7f7f7f, picking one entry per tree).
 */
async function tintColours(rel) {
  const file = rel ? await locateArt(rel) : null;
  const lut = file ? decodeRrtex(file) : null;
  if (!lut) return null;
  return Array.from({ length: lut.width * lut.height }, (_, i) => `#${[0, 1, 2].map((c) => lut.data[i * 4 + c].toString(16).padStart(2, '0')).join('')}`);
}

/** A material block's albedo slot (vegetation and Gen7 blocks name it albedoTex, unit and object blocks albedoTexture). */
const albedoOf = (block) => block?.tex.albedoTex ?? block?.tex.albedoTexture ?? null;

/** Load one exported geom GLB and normalise its material for the viewer. */
async function loadGeom({ file, geom, gen7 }, blocks) {
  const doc = await io.read(file);
  const block = (geom.matName && blocks[geom.matName]) || null;
  const type = block?.type ?? geom.type ?? '';
  // Essence gives every geom the art's first material's textures: vegetation geoms the tree bark or none, the deer's
  // live body (material lod1) its carcass skin (deer_resource). Vegetation and any geom on another material with its
  // own albedo decode that albedo instead.
  const own = LAYERED.test(type) ? null : albedoOf(block);
  const decodeOwn = own && (/^vegetation/.test(type) || own !== albedoOf(Object.values(blocks)[0]));
  for (const mat of doc.getRoot().listMaterials()) {
    let base = mat.getBaseColorTexture();
    if (decodeOwn) {
      const img = decodeRrtex(await locateArt(own));
      if (img) mat.setBaseColorTexture((base = doc.createTexture(geom.matName).setImage(encodePng(img)).setMimeType('image/png')));
    }
    mat.setNormalTexture(null).setMetallicRoughnessTexture(null).setOcclusionTexture(null);
    mat.setMetallicFactor(0).setRoughnessFactor(0.85);
    mat.setName(geom.matName || type);
    if (LAYERED.test(type) || !base) {
      mat.setBaseColorTexture(null).setBaseColorFactor([1, 1, 1, 1]);
      const rv = { layered: type || 'structure', part: geom.strings[0] ?? '' };
      if (gen7 && GEN7_TYPES.test(type)) rv.gen7 = gen7; // atlas-baked by bakeGen7 once the model is merged
      mat.setExtras({ rv });
      continue;
    }
    const png = downscale(readPng(base.getImage()), CFG.maxTex);
    base.setImage(encodePng(png)).setMimeType('image/png');
    const extras = { rv: { type } };
    if (block) {
      const mask = await buildMask(block, png.width, png.height);
      if (mask) {
        mat.setEmissiveTexture(doc.createTexture(`${geom.matName}_mask`).setImage(mask).setMimeType('image/png'));
        mat.setEmissiveFactor([0, 0, 0]);
        extras.rv.mask = true;
      }
      if (PBR_TYPES.test(type)) {
        const nrm = await pbrMap(block, 'normalMap', normalImage), orm = await pbrMap(block, 'metalTex', ormImage);
        if (nrm) mat.setNormalTexture(doc.createTexture(`${geom.matName}_nrm`).setImage(nrm).setMimeType('image/png'));
        if (orm) mat.setMetallicRoughnessTexture(doc.createTexture(`${geom.matName}_orm`).setImage(orm).setMimeType('image/png')).setMetallicFactor(1).setRoughnessFactor(1);
        if (nrm || orm) extras.rv.pbr = true;
      }
    }
    if (hasCutout(png.data)) mat.setAlphaMode('MASK').setAlphaCutoff(0.5);
    if (/^vegetation/.test(type)) {
      mat.setDoubleSided(true); // leaf cards are seen from both sides
      const tint = await tintColours(block?.tex.tintColourLUT);
      if (tint) extras.rv.tint = tint;
    }
    mat.setExtras(extras);
  }
  return doc;
}

/** Extra joints under each prop's marker (identity local bind) → [{...prop, bone, world (marker bind matrix)}]. */
function rigProps(rig, props, key) {
  const lower = new Map(rig.bones.map((b, i) => [b.name.toLowerCase(), i]));
  const world = (i) => { const b = rig.bones[i], m = trsMatrix(b.rot, b.pos, b.scl); return b.parent >= 0 ? mulMatrix(world(b.parent), m) : m; };
  const out = [];
  for (const p of props) {
    const parent = lower.get(p.marker.toLowerCase());
    if (parent === undefined) { log(`  ! ${key}: no marker ${p.marker} for ${baseName(p.art)}`); continue; }
    rig.index.set(p.joint, rig.bones.length);
    rig.bones.push({ name: p.joint, parent, rot: [0, 0, 0, 1], pos: [0, 0, 0], scl: [1, 1, 1] });
    out.push({ ...p, bone: rig.bones.length - 1, world: world(parent), prims: [] });
  }
  return out;
}

/** Bake a prop geom doc into model space at its marker's bind matrix M (node transforms folded in) and skin it to `bone`. */
function bakeRigid(src, M, bone, wide) {
  const root = src.getRoot(), buffer = root.listBuffers()[0], nodes = root.listNodes();
  const worlds = new Map(nodes.map((n) => [n, mulMatrix(M, Array.from(n.getWorldMatrix()))]));
  for (const n of nodes) {
    const m = worlds.get(n);
    for (const prim of n.getMesh()?.listPrimitives() ?? []) {
      const P = prim.getAttribute('POSITION'), N = prim.getAttribute('NORMAL'), cnt = P.getCount();
      const p = new Float32Array(cnt * 3), q = new Float32Array(cnt * 3), v = [0, 0, 0];
      for (let i = 0; i < cnt; i++) {
        P.getElement(i, v);
        for (let r = 0; r < 3; r++) p[i * 3 + r] = m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r];
        if (!N) continue;
        N.getElement(i, v);
        let l = 0;
        for (let r = 0; r < 3; r++) { q[i * 3 + r] = m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2]; l += q[i * 3 + r] ** 2; }
        l = Math.sqrt(l) || 1;
        for (let r = 0; r < 3; r++) q[i * 3 + r] /= l;
      }
      prim.setAttribute('POSITION', src.createAccessor().setType('VEC3').setArray(p).setBuffer(buffer));
      if (N) prim.setAttribute('NORMAL', src.createAccessor().setType('VEC3').setArray(q).setBuffer(buffer));
      prim.setAttribute('TANGENT', null);
      const J = wide ? new Uint16Array(cnt * 4) : new Uint8Array(cnt * 4), W = new Float32Array(cnt * 4);
      for (let i = 0; i < cnt; i++) { J[i * 4] = bone; W[i * 4] = 1; }
      prim.setAttribute('JOINTS_0', src.createAccessor().setType('VEC4').setArray(J).setBuffer(buffer));
      prim.setAttribute('WEIGHTS_0', src.createAccessor().setType('VEC4').setArray(W).setBuffer(buffer));
    }
  }
  for (const n of nodes) n.setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]);
}

/** Whole texture repeats a primitive's UVs cover → { u0, v0, rx, ry } (u0/v0 = first repeat), or null without UVs. */
function uvSpan(prim) {
  const uv = prim.getAttribute('TEXCOORD_0'), e = [0, 0];
  if (!uv) return null;
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (let i = 0; i < uv.getCount(); i++) { uv.getElement(i, e); u0 = Math.min(u0, e[0]); u1 = Math.max(u1, e[0]); v0 = Math.min(v0, e[1]); v1 = Math.max(v1, e[1]); }
  if (!Number.isFinite(u0 + u1 + v0 + v1)) return null;
  u0 = Math.floor(u0 + 1e-3); v0 = Math.floor(v0 + 1e-3);
  return { u0, v0, rx: Math.max(1, Math.ceil(u1 - 1e-3) - u0), ry: Math.max(1, Math.ceil(v1 - 1e-3) - v0) };
}
/** im repeated rx × ry times. */
function tileImage(im, rx, ry) {
  if (rx === 1 && ry === 1) return im;
  const out = { width: im.width * rx, height: im.height * ry, data: Buffer.alloc(im.width * rx * im.height * ry * 4) };
  for (let j = 0; j < ry; j++) for (let i = 0; i < rx; i++) blit(out, im, i * im.width, j * im.height, 0);
  return out;
}
/** Copy src into dst at (x0, y0), extending its edge texels `pad` texels outwards (mip gutters). */
function blit(dst, src, x0, y0, pad) {
  for (let y = -pad; y < src.height + pad; y++) for (let x = -pad; x < src.width + pad; x++) {
    const dx = x0 + x, dy = y0 + y;
    if (dx < 0 || dy < 0 || dx >= dst.width || dy >= dst.height) continue;
    const s = ((Math.min(src.height - 1, Math.max(0, y)) * src.width) + Math.min(src.width - 1, Math.max(0, x))) * 4;
    src.data.copy ? src.data.copy(dst.data, (dy * dst.width + dx) * 4, s, s + 4) : dst.data.set(src.data.subarray(s, s + 4), (dy * dst.width + dx) * 4);
  }
}

/**
 * Fold rigid props into the skinned body primitive that holds them (one draw call per unit): body and prop albedos
 * share one atlas, the body on top at its own size, props shelf-packed below at ≤ PROP_TEX (a prop whose UVs wrap
 * gets its texture repeated over the covered range, up to 4 repeats); tint mask, normal and metal-roughness maps get
 * atlases in the same layout (missing regions neutral, see NEUTRAL), sizes rounded up to multiples of 4 for KTX2.
 * Props with cut-outs (or a body without a texture) stay separate primitives. `levels` = [{ body, props }] primitives
 * of the distant LODs (sharing LOD0's materials): each level folds its own props into its own body primitive with
 * the same atlas placement. Returns the folded LOD0 prop primitives.
 */
function foldProps(doc, rig, bodyPrims, propPrims, levels) {
  const onRider = (prim) => {
    const J = prim.getAttribute('JOINTS_0'), e = [0, 0, 0, 0];
    let n = 0;
    for (let i = 0; J && i < J.getCount(); i++) { J.getElement(i, e); if (rig.bones[e[0]]?.name.startsWith('metarig_')) n++; }
    return n;
  };
  const pick = (prims) => prims.reduce((a, b) => (onRider(b) > onRider(a) ? b : a), prims[0]);
  const body = pick(bodyPrims);
  const bodyMat = body?.getMaterial(), bodyTex = bodyMat?.getBaseColorTexture(), bs = body && uvSpan(body);
  if (!bodyTex || !bs || bs.u0 || bs.v0 || bs.rx > 1 || bs.ry > 1 || !body.getAttribute('NORMAL')) return [];
  const items = [];
  for (const prim of propPrims) {
    const m = prim.getMaterial(), span = uvSpan(prim);
    if (!m?.getBaseColorTexture() || m.getAlphaMode() !== 'OPAQUE' || m.getExtras()?.rv?.layered || !prim.getAttribute('NORMAL') || !span || span.rx * span.ry > 4) continue;
    const tex = downscale(readPng(m.getBaseColorTexture().getImage()), PROP_TEX / Math.max(span.rx, span.ry));
    const fit = (t) => (t ? tileImage(resample(readPng(t.getImage()), tex.width, tex.height), span.rx, span.ry) : null);
    items.push({ prim, mat: m, ...span, tw: tex.width, th: tex.height, img: tileImage(tex, span.rx, span.ry),
      mask: m.getExtras()?.rv?.mask ? fit(m.getEmissiveTexture()) : null, nrm: fit(m.getNormalTexture()), orm: fit(m.getMetallicRoughnessTexture()) });
  }
  if (!items.length) return [];
  const img = readPng(bodyTex.getImage()), PAD = 2, up4 = (v) => (v + 3) & ~3;
  const W = up4(Math.max(img.width, ...items.map((it) => it.img.width + 2 * PAD)));
  let x = 0, y = img.height, rowH = 0;
  for (const it of [...items].sort((a, b) => b.img.height - a.img.height)) { // shelf packing, tallest first
    const w = it.img.width + 2 * PAD, h = it.img.height + 2 * PAD;
    if (x + w > W) { x = 0; y += rowH; rowH = 0; }
    it.x = x + PAD; it.y = y + PAD; x += w; rowH = Math.max(rowH, h);
  }
  const H = up4(y + rowH);
  /** One map kind in the atlas layout: body region from the body's texture, prop shelves from theirs, rest `fill`. */
  const atlas = (bodyMap, key, fill) => {
    const a = { width: W, height: H, data: Buffer.alloc(W * H * 4) };
    for (let i = 0; i < a.data.length; i += 4) a.data.set(fill, i);
    if (bodyMap) blit(a, bodyMap === bodyTex ? img : resample(readPng(bodyMap.getImage()), img.width, img.height), 0, 0, 0);
    for (const it of items) if (it[key]) blit(a, it[key], it.x, it.y, PAD);
    return encodePng(a);
  };
  bodyTex.setImage(atlas(bodyTex, 'img', [255, 255, 255, 255])).setMimeType('image/png');
  const rv = { ...bodyMat.getExtras()?.rv };
  const maps = [
    ['mask', rv.mask ? bodyMat.getEmissiveTexture() : null, [0, 0, 0, 255], (t) => { bodyMat.setEmissiveTexture(t).setEmissiveFactor([0, 0, 0]); rv.mask = true; }],
    ['nrm', bodyMat.getNormalTexture(), NEUTRAL.nrm, (t) => { bodyMat.setNormalTexture(t); rv.pbr = true; }],
    ['orm', bodyMat.getMetallicRoughnessTexture(), NEUTRAL.orm, (t) => { bodyMat.setMetallicRoughnessTexture(t).setMetallicFactor(1).setRoughnessFactor(1); rv.pbr = true; }],
  ];
  for (const [key, own, fill, attach] of maps) {
    if (!own && !items.some((it) => it[key])) continue;
    const png = atlas(own, key, fill);
    if (own) own.setImage(png).setMimeType('image/png'); else attach(doc.createTexture(key).setImage(png).setMimeType('image/png'));
  }
  bodyMat.setExtras({ ...bodyMat.getExtras(), rv });
  // fold targets: LOD0's body, and per distant level its own primitive of the body material with the most rider
  // vertices, taking the level's prop primitives whose material and UV range match a folded LOD0 prop
  const groups = [{ body, items }];
  for (const lv of levels) {
    const bodies = lv.body.filter((p) => p.getMaterial() === bodyMat && p.getAttribute('NORMAL'));
    if (!bodies.length) continue;
    const its = [];
    for (const prim of lv.props) {
      const span = uvSpan(prim);
      const it = span && prim.getAttribute('NORMAL') && items.find((i) => i.mat === prim.getMaterial()
        && span.u0 >= i.u0 && span.v0 >= i.v0 && span.u0 + span.rx <= i.u0 + i.rx && span.v0 + span.ry <= i.v0 + i.ry);
      if (it) its.push({ ...it, prim });
    }
    groups.push({ body: pick(bodies), items: its });
  }
  const targets = new Set(groups.map((g) => g.body));
  const buffer = doc.getRoot().listBuffers()[0], e = [0, 0, 0, 0];
  const remapUV = (prim, ox, oy, sw, sh, u0 = 0, v0 = 0) => {
    const uv = prim.getAttribute('TEXCOORD_0'), out = new Float32Array(uv.getCount() * 2);
    for (let i = 0; i < uv.getCount(); i++) { uv.getElement(i, e); out[i * 2] = (ox + (e[0] - u0) * sw) / W; out[i * 2 + 1] = (oy + (e[1] - v0) * sh) / H; }
    return out;
  };
  // other primitives sampling the body texture (a combined horse sharing the rider's, at every level) keep their texels
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
    if (!targets.has(prim) && prim.getMaterial()?.getBaseColorTexture() === bodyTex) {
      prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(remapUV(prim, 0, 0, img.width, img.height)).setBuffer(buffer));
    }
  }
  for (const g of groups) {
    const all = [{ prim: g.body, x: 0, y: 0, tw: img.width, th: img.height, u0: 0, v0: 0 }, ...g.items];
    const nv = all.reduce((s, it) => s + it.prim.getAttribute('POSITION').getCount(), 0);
    const wide = all.some((it) => it.prim.getAttribute('JOINTS_0').getArray() instanceof Uint16Array);
    const streams = { POSITION: [3, new Float32Array(nv * 3)], NORMAL: [3, new Float32Array(nv * 3)], TEXCOORD_0: [2, new Float32Array(nv * 2)], JOINTS_0: [4, wide ? new Uint16Array(nv * 4) : new Uint8Array(nv * 4)], WEIGHTS_0: [4, new Float32Array(nv * 4)] };
    const idx = [];
    let base = 0;
    for (const it of all) {
      const n = it.prim.getAttribute('POSITION').getCount();
      const uv = remapUV(it.prim, it.x, it.y, it.tw, it.th, it.u0, it.v0);
      for (const [sem, [k, arr]] of Object.entries(streams)) {
        if (sem === 'TEXCOORD_0') { arr.set(uv, base * 2); continue; }
        const a = it.prim.getAttribute(sem);
        for (let i = 0; i < n; i++) { a.getElement(i, e); for (let c = 0; c < k; c++) arr[(base + i) * k + c] = e[c]; }
      }
      const I = it.prim.getIndices();
      if (I) for (let i = 0; i < I.getCount(); i++) idx.push(base + I.getScalar(i));
      else for (let i = 0; i < n; i++) idx.push(base + i);
      base += n;
    }
    for (const s of g.body.listSemantics()) if (!(s in streams)) g.body.setAttribute(s, null);
    for (const [sem, [k, arr]] of Object.entries(streams)) g.body.setAttribute(sem, doc.createAccessor().setType(k === 2 ? 'VEC2' : k === 3 ? 'VEC3' : 'VEC4').setArray(arr).setBuffer(buffer));
    g.body.setIndices(doc.createAccessor().setType('SCALAR').setArray(nv > 65535 ? Uint32Array.from(idx) : Uint16Array.from(idx)).setBuffer(buffer));
    for (const it of g.items) {
      for (const mesh of doc.getRoot().listMeshes()) {
        if (!mesh.listPrimitives().includes(it.prim)) continue;
        mesh.removePrimitive(it.prim);
        if (!mesh.listPrimitives().length) { for (const n of doc.getRoot().listNodes()) if (n.getMesh() === mesh) n.dispose(); mesh.dispose(); }
      }
      it.prim.dispose();
    }
  }
  return items.map((it) => it.prim);
}

// ───────────────────────────── generated LODs (see header "LODs") ─────────────────────────────
/**
 * Generated level steps: target triangle ratio vs LOD0 and absolute error budget (metres, model space). Measured on
 * Sultanate town centre / house / monastery and the Chinese granary: level 1 ≈ 50–60 % and level 2 ≈ 25–35 % of LOD0.
 */
const LOD_GEN = [{ ratio: 0.5, error: 0.08 }, { ratio: 0.2, error: 0.3 }];
/** Static models below this many LOD0 triangles get no generated levels (they cost less than a level switch). */
const LOD_MIN_TRIS = 2000;
/**
 * Simplifier attribute weights: normal xyz, UV0. Seams may collapse (UV islands and Gen7 tiles split nearly every
 * building, locking them leaves 60–75 % of the triangles) only while the UV drift stays a quarter of the error
 * budget, so a collapse never drags texels across Gen7 atlas tiles.
 */
const LOD_WEIGHTS = [0.5, 0.5, 0.5, 4, 4];
const triCount = (prim) => ((prim.getIndices() ?? prim.getAttribute('POSITION'))?.getCount() ?? 0) / 3 | 0;

/**
 * A triangle primitive simplified towards `ratio` of its triangles within `error` (its local units; see LOD_WEIGHTS;
 * disconnected pieces below the error pruned), vertices compacted → { prim (null when nothing survives), tris,
 * error }, or null when it does not shrink.
 */
function simplifyPrim(doc, prim, ratio, error) {
  const P = prim.getAttribute('POSITION'), N = prim.getAttribute('NORMAL'), T = prim.getAttribute('TEXCOORD_0'), I = prim.getIndices();
  if (!P || prim.getMode() !== 4) return null;
  const idx = I ? Uint32Array.from(I.getArray()) : Uint32Array.from({ length: P.getCount() }, (_, i) => i);
  const nv = P.getCount(), attrs = new Float32Array(nv * 5), e = [0, 0, 0];
  for (let i = 0; i < nv; i++) {
    if (N) { N.getElement(i, e); attrs.set(e, i * 5); }
    if (T) { T.getElement(i, e); attrs[i * 5 + 3] = e[0]; attrs[i * 5 + 4] = e[1]; }
  }
  const [out, err] = MeshoptSimplifier.simplifyWithAttributes(idx, Float32Array.from(P.getArray()), 3, attrs, 5, LOD_WEIGHTS, null,
    Math.floor((idx.length * ratio) / 3) * 3, error, ['ErrorAbsolute', 'Prune', 'Permissive']);
  if (out.length >= idx.length) return null;
  if (!out.length) return { prim: null, tris: 0, error: err };
  const [remap, n] = MeshoptSimplifier.compactMesh(out);
  const buffer = doc.getRoot().listBuffers()[0], res = doc.createPrimitive().setMaterial(prim.getMaterial());
  for (const sem of prim.listSemantics()) {
    const a = prim.getAttribute(sem), k = a.getElementSize(), src = a.getArray(), dst = new src.constructor(n * k);
    for (let v = 0; v < remap.length; v++) if (remap[v] !== 0xffffffff) for (let c = 0; c < k; c++) dst[remap[v] * k + c] = src[v * k + c];
    res.setAttribute(sem, doc.createAccessor().setType(a.getType()).setNormalized(a.getNormalized()).setArray(dst).setBuffer(buffer));
  }
  res.setIndices(doc.createAccessor().setType('SCALAR').setArray(n > 65535 ? out : Uint16Array.from(out)).setBuffer(buffer));
  return { prim: res, tris: out.length / 3, error: err };
}

/**
 * Generated distant levels of a static part: every node under `holder` mirrored into `levels[n − 1]` (names +
 * `_lod<n>`, same local TRS) with its mesh simplified from LOD0 by LOD_GEN[n − 1] (error budget divided by the node's
 * world scale). A mesh that would not lose ≥ 15 % of the previous level's triangles keeps that level's mesh (shared).
 * Returns the largest error reached per level (metres).
 */
function simplifyLevels(doc, holder, levels) {
  const errors = levels.map(() => 0), last = new Map(); // LOD0 mesh → mesh of the previous level
  levels.forEach((dst, li) => {
    const { ratio, error } = LOD_GEN[Math.min(li, LOD_GEN.length - 1)], n = li + 1;
    const mirror = (src, into) => {
      for (const c of src.listChildren()) {
        const m = doc.createNode(`${c.getName()}_lod${n}`).setTranslation(c.getTranslation()).setRotation(c.getRotation()).setScale(c.getScale());
        into.addChild(m);
        const mesh = c.getMesh();
        if (mesh) {
          const w = c.getWorldMatrix(), s = Math.max(...[0, 4, 8].map((o) => Math.hypot(w[o], w[o + 1], w[o + 2]))) || 1;
          const prev = last.get(mesh) ?? mesh, before = prev.listPrimitives().reduce((t, p) => t + triCount(p), 0);
          const out = mesh.listPrimitives().map((p) => simplifyPrim(doc, p, ratio, error / s) ?? { prim: p.clone(), tris: triCount(p), error: 0 });
          if (out.reduce((t, r) => t + r.tris, 0) > 0.85 * before) {
            for (const r of out) r.prim?.dispose();
            last.set(mesh, prev);
          } else {
            const lm = doc.createMesh(`${mesh.getName()}_lod${n}`);
            for (const r of out) if (r.prim) lm.addPrimitive(r.prim);
            errors[li] = Math.max(errors[li], ...out.map((r) => r.error * s));
            last.set(mesh, lm);
          }
          if (last.get(mesh).listPrimitives().length) m.setMesh(last.get(mesh));
        }
        mirror(c, m);
      }
    };
    mirror(holder, dst);
  });
  return errors;
}

/**
 * Merge all parts (each with its stamp transform) into one GLB. A single human/animal art with an .rgm rig
 * becomes a skinned model (full skeleton in bind pose); its `_resource` / `_corpse` mesh (the carcass) is left out.
 * Rigged models also carry their props (unitProps) on extra joints, folded into the body's draw call where possible.
 * Distant levels go under rv_lod<n> (see header "LODs"); textures leave as KTX2.
 */
async function buildModel(key, parts, props = []) {
  const outFile = path.join(CFG.out, 'models', `${key}.glb`);
  const doc = new Document();
  doc.createBuffer();
  const scene = doc.createScene(key);
  doc.getRoot().setDefaultScene(scene);
  const sources = [];
  // Parts that skin onto the first part's skeleton (an animator_skin_attachment such as the raider elephant's tusks) share
  // its joints; any part that does not fit leaves the whole model static.
  let rig = loadRig(parts[0]?.art ?? '');
  for (const p of parts.slice(1)) {
    if (!rig) break;
    const r2 = loadRig(p.art, true);
    if (r2 && r2.bones.every((b) => rig.index.has(b.name)) && [...r2.meshes.keys()].every((id) => !rig.meshes.has(id))) for (const [id, m] of r2.meshes) rig.meshes.set(id, m);
    else rig = null;
  }
  const rigged = rig ? rigProps(rig, props, key) : [];
  const body = [], levels = [], missed = []; // levels[n − 1] = { body, props } primitives of level n (prop folding)
  const roots = []; // rv_lod<n> scene nodes
  const lodRoot = (n) => {
    if (!roots[n - 1]) { roots[n - 1] = doc.createNode(`rv_lod${n}`); scene.addChild(roots[n - 1]); }
    return roots[n - 1];
  };
  const mergeInto = (holder, src, skin, suffix) => {
    const out = [], map = mergeDocuments(doc, src);
    for (const s of src.getRoot().listScenes()) {
      const ts = map.get(s);
      for (const n of ts.listChildren()) {
        holder.addChild(n);
        n.traverse((x) => {
          if (suffix) x.setName(`${x.getName()}${suffix}`);
          if (x.getMesh()) { if (skin) x.setSkin(skin); out.push(...x.getMesh().listPrimitives()); }
        });
      }
      ts.dispose();
    }
    return out;
  };
  /** A geom GLB without its material (the level reuses its LOD0 twin's). */
  const bare = async (file) => {
    const d = await io.read(file);
    for (const m of d.getRoot().listMaterials()) m.dispose();
    for (const t of d.getRoot().listTextures()) t.dispose();
    return d;
  };
  /**
   * One level of an export into `holder` → { body (skinned), all } primitives. Level n ≥ 1 geoms take their LOD0
   * twin's material: same material name, else same mesh and slot with the same albedo (unit blocks lod2 / lod3 only
   * swap in per-LOD baked normal maps); the rest (trees' low cards) load their own. `rigid` = prop on its joint.
   */
  const addLevel = async (exp, n, holder, twins, skin, rigid) => {
    const res = { body: [], all: [] };
    for (const g of exp.levels[Math.min(n, exp.levels.length - 1)]) {
      const id = g.geom.strings[0] ?? '';
      if (rig && /_(resource|corpse)$/.test(id)) continue;
      const rm = rigid ? null : rig?.meshes.get(id);
      const alb = exp.blocks[g.geom.matName]?.tex.albedoTexture ?? null, slot = `${g.mesh}:${g.slot}`;
      const twin = n ? ((g.geom.matName && twins.name.get(g.geom.matName)) || (alb && twins.slot.get(slot)?.alb === alb ? twins.slot.get(slot).mat : null)) : null;
      const src = twin ? await bare(g.file) : await loadGeom(g, exp.blocks);
      if (rm) missed[n] = (missed[n] ?? 0) + skinGeom(src, rig, rm, g.lod, g.slot);
      if (rigid) bakeRigid(src, rigid.world, rigid.bone, rig.bones.length > 255);
      const prims = mergeInto(holder, src, rm || rigid ? skin : null, n ? `_lod${n}` : '');
      const mat = prims[0]?.getMaterial();
      if (twin) for (const p of prims) p.setMaterial(twin);
      else if (!n && mat) { if (g.geom.matName) twins.name.set(g.geom.matName, mat); twins.slot.set(slot, { mat, alb }); }
      res.all.push(...prims);
      if (rm) res.body.push(...prims);
    }
    return res;
  };
  const done = []; // per merged part: { exp, holder, place, skin, twins }
  let skeleton = null, first = true; // the skeleton and prop set belong to the first part; skin-attachment parts reuse the skin
  for (const part of parts) {
    const exp = await exportArt(part.art);
    if (!exp) continue;
    const place = (node) => node.setTranslation(part.pos).setRotation(part.quat).setScale(part.scale);
    const holder = place(doc.createNode(baseName(part.art)));
    scene.addChild(holder);
    const skin = rig ? (skeleton ??= addSkeleton(doc, holder, rig, key)) : null, twins = { name: new Map(), slot: new Map() };
    body.push(...(await addLevel(exp, 0, holder, twins, skin)).body);
    for (const p of first ? rigged : []) {
      p.exp = await exportArt(p.art);
      if (!p.exp) { log(`  ! ${key}: prop ${p.art} did not export`); continue; }
      p.twins = { name: new Map(), slot: new Map() };
      p.prims.push(...(await addLevel(p.exp, 0, holder, p.twins, skin, p)).all);
    }
    first = false;
    done.push({ exp, holder, place, skin, twins });
    sources.push({ art: part.art, pos: part.pos.map(round), quat: part.quat.map(round), scale: part.scale.map(round) });
  }
  if (!sources.length) return null;
  // level count: the game's where any part has LODs; single-LOD static parts of a big enough model are generated
  const lod0Tris = doc.getRoot().listMeshes().reduce((t, m) => t + m.listPrimitives().reduce((u, p) => u + triCount(p), 0), 0);
  const generate = !rig && lod0Tris >= LOD_MIN_TRIS ? done.filter((d) => d.exp.levels.length === 1) : [];
  const count = Math.max(generate.length ? LOD_GEN.length : 0, ...done.map((d) => d.exp.levels.length - 1));
  const levelHolder = (d, n) => { const lh = d.place(doc.createNode(`${d.holder.getName()}_lod${n}`)); lodRoot(n).addChild(lh); return lh; };
  for (const d of done) {
    if (generate.includes(d)) continue;
    for (let n = 1; n <= count; n++) {
      const lh = levelHolder(d, n), lv = (levels[n - 1] ??= { body: [], props: [] });
      lv.body.push(...(await addLevel(d.exp, n, lh, d.twins, d.skin)).body);
      if (d === done[0]) for (const p of rigged) if (p.exp) lv.props.push(...(await addLevel(p.exp, n, lh, p.twins, d.skin, p)).all);
    }
  }
  const folded = rigged.length && body.length ? foldProps(doc, rig, body, rigged.flatMap((p) => p.prims), levels) : [];
  bakeGen7(doc, key);
  const errors = [];
  for (const d of generate) {
    const lhs = Array.from({ length: count }, (_, i) => levelHolder(d, i + 1));
    simplifyLevels(doc, d.holder, lhs).forEach((e, i) => { errors[i] = Math.max(errors[i] ?? 0, e); });
  }
  const dist = generate.length ? null : done.find((d) => d.exp.dist)?.exp.dist;
  roots.forEach((r, i) => {
    const rv = { lod: i + 1 };
    if (dist?.[i] !== undefined) rv.dist = dist[i];
    if (errors[i] !== undefined) rv.error = round(errors[i]);
    r.setExtras({ rv });
  });
  await doc.transform(unpartition(), dedup(), prune());
  await compressTextures(doc);
  mkdirp(path.dirname(outFile));
  await io.write(outFile, doc);
  const trisUnder = (node) => { let t = 0; node.traverse((x) => { for (const p of x.getMesh()?.listPrimitives() ?? []) t += triCount(p); }); return t; };
  const lodNodes = scene.listChildren().filter((n) => n.getExtras()?.rv?.lod).sort((a, b) => a.getExtras().rv.lod - b.getExtras().rv.lod);
  const tris = [scene.listChildren().filter((n) => !lodNodes.includes(n)).reduce((t, n) => t + trisUnder(n), 0), ...lodNodes.map(trisUnder)];
  const out = { file: `assets/models/${key}.glb`, bytes: fs.statSync(outFile).size, sources, lods: lodNodes.length, tris };
  if (rig) { out.bones = rig.bones.length; if (missed[0]) out.unmatchedSkinVerts = missed[0]; }
  if (missed.some((m, n) => n && m)) log(`  ! ${key}: unmatched skin vertices per level ${Array.from(missed, (m) => m ?? 0).join('/')}`);
  const withGeom = rigged.filter((p) => p.prims.length);
  if (withGeom.length) out.props = withGeom.map((p) => ({ joint: p.joint, art: p.art, marker: p.marker, folded: p.prims.every((q) => folded.includes(q)) }));
  return out;
}

// ───────────────────────────── icons ─────────────────────────────
let uiIndex = null;
async function buildIcon(bp, iconName) {
  if (!iconName || !CFG.icons) return null;
  if (!uiIndex) {
    if (!(await ensureArchive('UIArt'))) return null;
    uiIndex = new Map();
    for (const rel of walkFiles(path.join(CFG.extracted, 'UIArt'))) if (rel.endsWith('.rrtex')) uiIndex.set(rel.toLowerCase(), rel);
  }
  const want = `/${iconName.replace(/\\/g, '/').toLowerCase()}.rrtex`;
  const rel = [...uiIndex.keys()].find((k) => k.endsWith(want));
  if (!rel) return null;
  const out = path.join(CFG.out, 'icons', `${bp}.png`);
  if (!CFG.force && exists(out)) return `assets/icons/${bp}.png`;
  const tmp = path.join(CFG.cache, 'icons', `${bp}.png`);
  mkdirp(path.dirname(tmp));
  await essence('rrtex-decode', path.join(CFG.extracted, 'UIArt', uiIndex.get(rel)), tmp);
  if (!exists(tmp)) return null;
  mkdirp(path.dirname(out));
  fs.writeFileSync(out, encodePng(downscale(readPng(tmp), 128)));
  return `assets/icons/${bp}.png`;
}

// ───────────────────────────── replay ─────────────────────────────
function readReplay(file) {
  const window = { REPLAY_DATA: {} };
  new Function('window', fs.readFileSync(file, 'utf8'))(window);
  const [name, data] = Object.entries(window.REPLAY_DATA)[0];
  return { name, data };
}

// ───────────────────────────── adding to earlier builds ─────────────────────────────
/** An earlier build's catalog.json / combat.json, or null when there is none. A damaged file stops the build. */
function readBuilt(file) {
  if (!exists(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message}); repair or delete it, then build again`);
  }
}
/** Replays an earlier build covered (files from before merging name one in `replay`). */
const replaysOf = (built) => built?.replays ?? (built?.replay ? [built.replay] : []);

/**
 * This run's catalog added to the earlier one. A blueprint both cover keeps the earlier models for ages this run did
 * not reach (a match that ended in age II must not drop a castle-age model built from a longer one) and for ages it
 * found no model for, and its earlier icon when this run made none (e.g. --no-icons).
 */
function mergeCatalog(prev, next) {
  if (!prev) return next;
  const blueprints = { ...prev.blueprints };
  for (const [bp, e] of Object.entries(next.blueprints)) {
    const old = blueprints[bp];
    blueprints[bp] = old ? { ...e, ebps: e.ebps ?? old.ebps, icon: e.icon ?? old.icon, ages: { ...old.ages, ...e.ages } } : e;
  }
  return {
    replays: [...new Set([...replaysOf(prev), ...next.replays])], generated: next.generated, universe: next.universe || prev.universe || undefined,
    blueprints, models: { ...prev.models, ...next.models },
    terrain: next.terrain ?? prev.terrain, grass: next.grass ?? prev.grass,
    farms: next.farms || prev.farms
      ? { crops: { ...prev.farms?.crops, ...next.farms?.crops }, blueprints: { ...prev.farms?.blueprints, ...next.farms?.blueprints } }
      : undefined,
  };
}

/** This run's weapon timings added to the earlier ones (units this run resolved replace theirs). */
const mergeCombat = (prev, next) => ({
  replays: [...new Set([...replaysOf(prev), ...next.replays])], units: { ...prev?.units, ...next.units },
});

// ───────────────────────────── terrain layers ─────────────────────────────
/**
 * Ground layers the viewer tiles over the replay heightmap (the replay records heights, not the map's painted
 * layers, so the viewer places them by noise, slope, tree density and replay traffic): Gen7 temperate terrain tile
 * albedos → assets/terrain/<layer>.png (≤1024², opaque). dirt / trodden go where buildings stand and units walk.
 */
const TERRAIN_TILES = 'art/scenarios/textures/tiles/biome_temperate_deciduous';
const TERRAIN_LAYERS = {
  grass: 'grass/grass_short_a', lush: 'grass/grass_lush_patchy', dry: 'grass/grass_dry_b', forest: 'detritus/detritus_forestbed_a',
  dirt: 'dirt/dirt_grass_patch_a', trodden: 'mud/mud_trodden_a',
};
/** Decoded albedo of the first material block in a Gen7 .rrmaterial, or null. */
function gen7Albedo(rel) {
  const file = gen7File(rel);
  const albedo = exists(file) ? Object.values(rrmaterialBlocks(file))[0]?.tex.albedoTex : null;
  return albedo ? decodeRrtex(gen7File(albedo)) : null;
}
function buildTerrain() {
  const out = {};
  mkdirp(path.join(CFG.out, 'terrain'));
  for (const [layer, mat] of Object.entries(TERRAIN_LAYERS)) {
    const img = gen7Albedo(`${TERRAIN_TILES}/${mat}.rrmaterial`);
    if (!img) { log(`  ! terrain layer ${layer}: ${mat} missing or undecodable`); continue; }
    const rel = `terrain/${layer}.png`;
    fs.writeFileSync(path.join(CFG.out, rel), encodePng(downscale(img, 1024)));
    out[layer] = { file: `assets/${rel}`, source: `${TERRAIN_TILES}/${mat}` };
  }
  return out;
}

/**
 * Grass blade cards for the viewer's near-camera grass: Gen7 terraingrassbladematerial albedos (alpha-cut, blades
 * rooted on the bottom edge) at native size in one 512² atlas → assets/terrain/blades.png + blades.json
 * { size, cards: [{ name, x, y, w, h, height, weight }] } (pixel rect from the top-left, card height in metres,
 * relative frequency). Transparent texels take the card's mean opaque colour so mips don't fringe dark.
 */
const GRASS_BLADES = 'art/scenarios/grass/blades';
const GRASS_CARDS = [ // name, atlas x, y, w, h, height m, weight
  ['grass_wild_green', 0, 0, 512, 256, 0.75, 3],
  ['grass_tall_green_a', 0, 256, 256, 128, 0.6, 3],
  ['grass_tall_green_b', 256, 256, 256, 128, 0.6, 3],
  ['flower_clover', 0, 384, 256, 128, 0.35, 1],
  ['grass_fallen_green', 256, 384, 128, 64, 0.3, 2],
  ['flower_daisy', 384, 384, 128, 128, 0.4, 0.3],
];
function buildGrass() {
  const S = 512, atlas = { width: S, height: S, data: Buffer.alloc(S * S * 4) };
  const cards = [];
  for (const [name, x, y, w, h, height, weight] of GRASS_CARDS) {
    const img = gen7Albedo(`${GRASS_BLADES}/${name}.rrmaterial`);
    if (!img || img.width !== w || img.height !== h) { log(`  ! grass card ${name}: missing, undecodable or not ${w}×${h}`); continue; }
    const d = img.data, mean = [0, 0, 0];
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] >= 128) { mean[0] += d[i]; mean[1] += d[i + 1]; mean[2] += d[i + 2]; n++; }
    for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
      const s = (row * w + col) * 4, o = ((y + row) * S + x + col) * 4;
      for (let c = 0; c < 3; c++) atlas.data[o + c] = d[s + 3] >= 8 ? d[s + c] : Math.round(mean[c] / Math.max(1, n));
      atlas.data[o + 3] = d[s + 3];
    }
    cards.push({ name, x, y, w, h, height, weight });
  }
  if (!cards.length) return null;
  mkdirp(path.join(CFG.out, 'terrain'));
  fs.writeFileSync(path.join(CFG.out, 'terrain/blades.png'), encodePng(atlas));
  fs.writeFileSync(path.join(CFG.out, 'terrain/blades.json'), JSON.stringify({ size: S, source: GRASS_BLADES, cards }, null, 1));
  return { file: 'assets/terrain/blades.png', cards: cards.map((c) => c.name) };
}

/**
 * Farm fields. A farm has no mesh: its ebps names a resource animator (resource_deposit_ext/resource_spline_option/…/
 * resource_animator: farm_wheat_a or farm_rice_a) whose resource stamp (art/stamps/resources/<animator>.bin) paints
 * the ground with a soil splat, and the crop grows as Gen7 terrain grass blades (resource_food_<crop>_<state>) that
 * have a card per crop state. → assets/terrain/farm_<crop>_soil.png and farm_<crop>_<state>.png (native size),
 * catalog.json `farms` { crops: { crop: { soil: { file, tile, source }, cards: { state: { file, height, aspect, source } } } },
 * blueprints: { bp: crop } }. Card height is the blade material's zScale × GRASS_CARDS' 0.75 m for zScale 1
 * (grass_wild_green); `tile` [across, along] is the soil splat's repeats over a field (alpha-edged splats).
 */
const FARM_CROPS = {
  farm_wheat_a: { // its stamp lays three soil_field_tilled_a strips (512 × 1024, soft long edges) side by side
    crop: 'wheat', soil: 'civilizations/soil/soil_field_tilled_a', tile: [3, 1],
    states: { sprout: 'resource_food_wheat_sprout', mature: 'resource_food_wheat_mature', harvest: 'resource_food_wheat_harvest', damaged: 'resource_food_wheat_damaged' },
  },
  farm_rice_a: { // its stamp floods the field with muddy water (water_muddy_5m_sqr, soft square edge)
    crop: 'rice', soil: 'civilizations/water/water_muddy_5m_sqr', tile: [1, 1],
    states: { mature: 'resource_food_rice_mature', damaged: 'resource_food_rice_damaged' },
  },
};
const FARM_SPLATS = 'art/scenarios/textures/splats';
/** A Gen7 terrain blade material's zScale (card height factor), or 1. */
function bladeZScale(file) {
  const buf = fs.readFileSync(file), at = buf.indexOf('zScale\0');
  if (at < 0) return 1;
  const f = buf.indexOf('Float', at); // u32 5 "Float", u32 1, u32 n, n chars
  const n = buf.readUInt32LE(f + 9), v = Number(buf.toString('latin1', f + 13, f + 13 + n));
  return Number.isFinite(v) && v > 0 ? v : 1;
}
async function buildFarms(targets) {
  const blueprints = {}, crops = {};
  for (const [bp] of targets) {
    if (!/^building_resource_farm/.test(bp)) continue;
    const rel = attribFind(bp, 'ebps/');
    const animator = rel && firstValue(flat(await rgd(rel)), '/resource_spline_option/resource_animator_groups/resource_animator_group/resource_animator');
    const spec = animator && FARM_CROPS[baseName(animator)];
    if (!spec) { if (animator && !(await locateArt(`${animator}.rrgeom`))) log(`  ! farm ${bp}: crop of ${animator} unknown`); continue; }
    blueprints[bp] = spec.crop;
    if (crops[spec.crop]) continue;
    const soil = gen7Albedo(`${FARM_SPLATS}/${spec.soil}.rrmaterial`);
    if (!soil) { log(`  ! farm soil ${spec.soil} missing or undecodable`); delete blueprints[bp]; continue; }
    const out = { soil: { file: `assets/terrain/farm_${spec.crop}_soil.png`, tile: spec.tile, source: `${FARM_SPLATS}/${spec.soil}` }, cards: {} };
    fs.writeFileSync(path.join(CFG.out, 'terrain', `farm_${spec.crop}_soil.png`), encodePng(downscale(soil, 1024)));
    for (const [st, mat] of Object.entries(spec.states)) {
      const file = gen7File(`${GRASS_BLADES}/${mat}.rrmaterial`), img = exists(file) ? gen7Albedo(`${GRASS_BLADES}/${mat}.rrmaterial`) : null;
      if (!img) { log(`  ! crop card ${mat}: missing or undecodable`); continue; }
      fs.writeFileSync(path.join(CFG.out, 'terrain', `farm_${spec.crop}_${st}.png`), encodePng(img));
      out.cards[st] = { file: `assets/terrain/farm_${spec.crop}_${st}.png`, height: 0.75 * bladeZScale(file), aspect: img.width / img.height, source: `${GRASS_BLADES}/${mat}` };
    }
    if (!out.cards.mature) { log(`  ! farm ${spec.crop}: no mature crop card`); delete blueprints[bp]; continue; }
    crops[spec.crop] = out;
  }
  return { crops, blueprints };
}

// ───────────────────────────── main ─────────────────────────────
const CATALOG_FILE = path.join(CFG.out, 'catalog.json'), COMBAT_FILE = path.join(CFG.out, 'combat.json');

/** bp → cat of everything a recording needs models for: its entities, gates (recorded as wall foundations, renamed
 *  by the viewer from their construction event, core fixGates) and gaia types. */
function replayTargets(data) {
  const targets = new Map();
  for (const e of data.entities) if (!targets.has(e.bp)) targets.set(e.bp, e.cat);
  for (const c of data.constructions ?? []) {
    const pbg = c.fields?.pbg ?? '';
    if (pbg.includes('gate')) { const bp = pbg.replace(/^b(?=building_)/, ''); if (!targets.has(bp)) targets.set(bp, 'building'); }
  }
  for (const [gname, kind] of data.gaia?.types ?? []) targets.set(gname, `gaia:${kind}`);
  return targets;
}

// ───────────────────────────── --all: the universal catalog ─────────────────────────────
// A replay build only converts the blueprints that one recording used, so a civilisation or map object it never met had
// no model until a recording showed it. --all enumerates them from the game's own entity tree instead: every ebps
// (Attrib ebps/) of the playable civilisations, neutral map buildings and the weapon entities buildings carry, plus the
// gaia/environment/gameplay folders (trees, animals, deposits, berries, fish, relics, holy sites, bridges, loot piles).
/** ebps/races/<folder> of the civilisations a match can use (campaign, cheat, rogue and *_cmp folders are single-player). */
const UNIVERSE_RACES = ['abbasid', 'abbasid_ha_01', 'byzantine', 'byzantine_ha_mac', 'chinese', 'chinese_ha_01', 'core', 'english', 'french',
  'french_ha_01', 'hre', 'hre_ha_01', 'japanese', 'japanese_ha_sen', 'jin_dynasty', 'lancaster', 'malian', 'mongol', 'mongol_ha_gol',
  'neutral', 'ottoman', 'rus', 'sultanate', 'sultanate_ha_tug', 'templar'];
/** ebps folders outside races that hold visible map objects. */
const UNIVERSE_DIRS = ['gaia', 'environment', 'gameplay/resources', 'gameplay/relics', 'gameplay/misc', 'gameplay/resource_pickups', 'dev/units'];
/** Decode every rgd below an Attrib folder in one Essence run (rgd-decode --batch, ~200 files/s) into the per-file rgd cache. */
async function warmRgd(dirRel) {
  const src = path.join(ATTRIB_ROOT(), dirRel);
  const files = walkFiles(src).filter((f) => f.endsWith('.rgd'));
  if (!files.some((f) => !exists(rgdCache(`${dirRel}/${f}`)))) return files.length;
  const stage = path.join(CFG.cache, 'rgd-batch', slug(dirRel));
  fs.rmSync(stage, { recursive: true, force: true });
  const r = await essence('rgd-decode', '--batch', '-f', 'json', src, stage);
  let n = 0;
  for (const f of files) {
    const out = rgdCache(`${dirRel}/${f}`), tmp = path.join(stage, f.replace(/\.rgd$/, '.json'));
    if (!exists(out) && exists(tmp)) { mkdirp(path.dirname(out)); fs.copyFileSync(tmp, out); n++; }
  }
  fs.rmSync(stage, { recursive: true, force: true });
  log(`  rgd cache: ${dirRel} +${n}/${files.length} decoded${r.code ? ` (essence exit ${r.code})` : ''}`);
  return files.length;
}

/** Replay-style category of an ebps (what the recorder writes in entity.cat), from its folder and unit-type list. */
async function universeCat(rel) {
  const name = path.posix.basename(rel, '.rgd');
  if (/^wpn_/.test(name) || /\/weapons\//.test(rel)) return 'attachment';
  if (/\/buildings\//.test(rel) || /^building_/.test(name)) return 'building';
  const gaia = (k) => `gaia:${k}`;
  if (/\/resources\/wood\//.test(rel)) return gaia(/\/stealth\//.test(rel) ? 'stealth' : 'tree');
  if (/\/resources\/gold\//.test(rel)) return gaia('gold');
  if (/\/resources\/stone\//.test(rel)) return gaia('stone');
  if (/\/resources\/food\//.test(rel)) return gaia(/fish/.test(name) ? 'fish' : /forage|berry/.test(name) ? 'berry' : 'other');
  if (/\/relics\//.test(rel)) return gaia(/holy_site/.test(name) ? 'sacred' : /relic/.test(name) ? 'relic' : 'other');
  if (/\/units\/viz_only\//.test(rel) || /\/misc\//.test(rel)) return gaia('other');
  if (/\/animals\//.test(rel)) {
    const k = /sheep/.test(name) ? 'sheep' : /reindeer|deer/.test(name) ? 'deer' : /boar/.test(name) ? 'boar' : /wolf/.test(name) ? 'wolf' : null;
    return /cattle/.test(name) ? 'livestock' : /^gaia_/.test(name) && k ? gaia(k) : 'other';
  }
  if (!/\/units\//.test(rel) && !/^unit_/.test(name)) return gaia('other');
  const types = new Set(flat(await rgd(rel)).filter(([p]) => p.endsWith('/type_ext/unit_type_list/unit_type')).map(([, v]) => v));
  const has = (...t) => t.some((x) => types.has(x));
  if (has('villager')) return 'villager';
  if (has('siege')) return 'siege';
  if (has('naval') || /^unit_naval_/.test(name)) return /fishing|trade|transport/.test(name) ? 'econ' : 'ship';
  if (has('hero', 'khan', 'king')) return 'hero';
  if (has('monk')) return 'religious';
  if (has('cavalry', 'horse', 'camel', 'elephant')) return 'cavalry';
  if (has('ranged')) return 'ranged';
  if (has('infantry')) return 'infantry';
  if (has('worker', 'trade_caravan', 'pilgrim') || /trade|official|caravan|pilgrim/.test(name)) return 'econ';
  return 'other';
}

/** bp → cat for the universe above (a cat an earlier catalog already holds for the bp, written from a recording, is kept). */
async function universeTargets(prev) {
  const dirs = [...UNIVERSE_RACES.map((r) => `ebps/races/${r}`), ...UNIVERSE_DIRS.map((d) => `ebps/${d}`)];
  await warmRgd('ebps');
  const targets = new Map();
  for (const d of dirs) {
    for (const f of walkFiles(path.join(ATTRIB_ROOT(), d))) {
      if (!f.endsWith('.rgd')) continue;
      const rel = `${d}/${f}`, bp = path.posix.basename(f, '.rgd');
      if (!targets.has(bp)) targets.set(bp, prev?.blueprints?.[bp]?.cat ?? (await universeCat(rel)));
    }
  }
  return targets;
}

/** --check: the replay's blueprints that catalog.json lacks (a blueprint it lists without models was resolved and has
 *  none; building again would not change that). */
function checkMissing() {
  const { name, data } = readReplay(CFG.replay);
  const built = readBuilt(CATALOG_FILE);
  const targets = replayTargets(data);
  const missing = [...targets].filter(([bp]) => !built?.blueprints?.[bp]).map(([bp, cat]) => ({ bp, cat }));
  console.log(JSON.stringify({ replay: name, total: targets.size, missing }));
}

async function main() {
  if (flag('--check')) return checkMissing();
  requireToolchain();
  const t0 = Date.now();
  mkdirp(CFG.cache);
  const ALL = flag('--all'), ONLY = opt('--only');
  const builtCatalog = readBuilt(CATALOG_FILE), builtCombat = readBuilt(COMBAT_FILE); // read first: a damaged file stops here
  const catalogFile = CATALOG_FILE, combatFile = COMBAT_FILE;
  let name, data = null, maxAge = 4, targets; // bp → cat
  if (ALL || ONLY) {
    // not tied to a recording: every blueprint of the universe (or the listed ones, for debugging), up to the last age
    name = ALL ? 'all' : 'only';
    for (const a of ['Attrib', 'Data']) if (!(await ensureArchive(a))) throw new Error(`missing archive ${a}.sga in ${CFG.archives}`);
    targets = await universeTargets(builtCatalog);
    if (ONLY) {
      const want = ONLY.split(',').map((s) => s.trim()).filter(Boolean), all = targets;
      targets = new Map(want.map((bp) => [bp, all.get(bp) ?? 'other']));
      for (const w of want) if (!all.has(w)) log(`  ! --only ${w}: not in the universe, built as 'other'`);
    }
    log(`${name}: ${targets.size} blueprints, max age ${maxAge}`);
  } else {
    ({ name, data } = readReplay(CFG.replay));
    const ageUps = {};
    for (const [, player, , type] of data.techs ?? []) if (type === 'age') ageUps[player] = (ageUps[player] ?? 0) + 1;
    maxAge = 1 + Math.max(0, ...Object.values(ageUps));
    targets = replayTargets(data);
    log(`replay ${name}: ${targets.size} blueprints, max age ${maxAge}`);
  }
  log(`game archives: ${CFG.archives}`);

  for (const a of ['Attrib', 'Data', 'DX12Assets', 'ArtHigh']) if (!(await ensureArchive(a))) throw new Error(`missing archive ${a}.sga in ${CFG.archives}`);
  indexArchive('DX12Assets');
  gen7Available = await ensureArchive(GEN7);
  if (!gen7Available) log(`  ${GEN7}.sga not found: structures fall back to the viewer's stylised look, ground to procedural`);
  for (const civ of ALL || ONLY ? Object.keys(CIV_ARCHIVE) : new Set(data.players.map((p) => p.civ))) await ensureCivArt(civ);
  // A Mongol building and its packed cart (the `_moving_` ebps, a cart chassis carrying the folded building) are one
  // recorded entity under either blueprint: build both, and name the pair on each (entry.pack) for the viewer's trips.
  const packs = new Map();
  for (const [bp, cat] of [...targets]) {
    if (cat !== 'building' || !/_mon$/.test(bp)) continue;
    const building = bp.replace(/_moving_mon$/, '_mon'), cart = building.replace(/_mon$/, '_moving_mon');
    if (!attribFind(building, 'ebps/') || !attribFind(cart, 'ebps/')) continue;
    for (const b of [building, cart]) { packs.set(b, { building, cart }); if (!targets.has(b)) targets.set(b, 'building'); }
  }

  const catalog = { replays: data ? [name] : [], generated: new Date().toISOString(), blueprints: {}, models: {} };
  if (ALL) catalog.universe = true; // every blueprint of the game's civilisations and map objects was enumerated, not just a recording's
  const combat = { replays: data ? [name] : [], units: {} }; // bp → hardpoint weapon timings for the viewer's combat animation
  const models = new Map(); // key → { parts, props }
  const resolved = new Map();
  for (const [bp, cat] of targets) {
    const r = await resolveBlueprint(bp, maxAge);
    resolved.set(bp, r);
    const entry = (catalog.blueprints[bp] = { cat, ebps: r?.ebps ?? null, icon: null, ages: {} });
    if (r?.sight) entry.sight = r.sight; // line-of-sight radius (m) for the viewer's fog of war
    if (packs.has(bp)) entry.pack = packs.get(bp);
    if (!r) continue;
    const unit = UNIT_CATS.test(cat);
    const timing = (w) => (w?.stats ? { ...w.stats, art: w.art ? baseName(w.art) : null } : null); // art picks the viewer's swing pose
    if (unit) combat.units[bp] = { main: timing(r.weapons.main), torch: timing(r.weapons.torch) };
    // a building's weapons are attachment entities on it (core Replay.buildBlows reads their range, period and speed);
    // wpn_range_dummy is a placeholder (period 10002 s) a landmark carries off-centre, not a weapon
    else if (cat === 'attachment' && /^wpn_/.test(bp) && !/dummy/.test(bp)) {
      const stats = await weaponStats(bp);
      if (stats?.range > 0) combat.units[bp] = { main: timing({ stats }), torch: null };
    }
    for (const [age, variants] of Object.entries(r.ages)) {
      const keys = [];
      for (const v of variants) {
        const props = unit ? unitProps(v, r.weapons, cat) : [];
        const main = props.find((p) => p.joint === 'rvwpn_main');
        const key = variantKey(v) + (main ? `+${baseName(main.art)}` : ''); // the same body can carry different weapons
        if (!models.has(key)) models.set(key, { parts: await variantParts(v, r.civ), props });
        if (models.get(key).parts.length) keys.push(key);
      }
      if (keys.length) entry.ages[age] = keys;
    }
    // a wall's gap-filler stakes: their piece models are built like any other, the viewer plants them (WallFillers)
    const gf = cat === 'building' && /palisade|wall|gate|bastion/.test(bp) ? await gapFillers(r.ebps) : null;
    if (gf) {
      entry.gapFill = gf.spec;
      for (const { key, art } of gf.visuals) {
        if (!models.has(key)) models.set(key, { parts: (await locateArt(`${art}.rrgeom`)) ? [{ art, quat: [0, 0, 0, 1], pos: [0, 0, 0], scale: [1, 1, 1] }] : [], props: [] });
      }
    }
    const target = await gapTarget(r.ebps);
    if (target) entry.gapTarget = target;
    if (cat !== 'building' && cat !== 'attachment' && (await supervises(bp))) { // officials are recorded as `econ`
      entry.supervise = baseName(SUPERVISE_FX);
      if (!models.has(entry.supervise)) models.set(entry.supervise, { parts: [{ art: SUPERVISE_FX, quat: [0, 0, 0, 1], pos: [0, 0, 0], scale: [1, 1, 1] }], props: [] });
    }
  }
  const arts = [...new Set([...models.values()].flatMap((m) => [...m.parts, ...m.props]).map((p) => p.art))];
  log(`${models.size} unique models from ${arts.length} art meshes; exporting with ${CFG.jobs} workers …`);

  // Essence is the slow part: export every art in parallel first, then build models concurrently (their textures
  // encode on the KTX2 worker pool, LOD simplification and atlases run here).
  let done = 0;
  await pool(arts, CFG.jobs, async (art) => {
    try { await exportArt(art); } catch (e) { log(`  ! ${art}: ${e.message.split('\n')[0]}`); }
    if (++done % 20 === 0) log(`  exported ${done}/${arts.length}`);
  });
  await MeshoptSimplifier.ready;
  const entries = [...models].filter(([, m]) => m.parts.length), built = new Map();
  log(`building ${entries.length} models (${CFG.ktxThreads} KTX2 encoder threads) …`);
  await pool(entries, CFG.jobs, async ([key, { parts, props }]) => {
    try {
      const m = await buildModel(key, parts, props);
      const pr = m?.props ? `, props ${m.props.map((p) => `${p.joint}${p.folded ? '' : ' (own draw)'}`).join(' ')}` : '';
      if (m) { built.set(key, m); log(`  ✓ ${key} (${(m.bytes / 1024).toFixed(0)} KB, ${m.sources.length} parts, tris ${m.tris.join('/')}${pr})`); }
    } catch (e) { log(`  ! ${key}: ${e.stack}`); }
  });
  for (const w of ktxWorkers) w.worker.terminate();
  for (const [key] of entries) if (built.has(key)) catalog.models[key] = built.get(key);
  const mb = (b) => (b / 1048576).toFixed(1);
  log(`KTX2 textures: ${Object.entries(texStats).map(([r, s]) => `${r} ${s.count} × → ${mb(s.bytes)} MB (PNG ${mb(s.pngBytes)} MB)`).join(', ')}`);

  for (const [bp, r] of resolved) if (r?.icon) catalog.blueprints[bp].icon = await buildIcon(bp, r.icon).catch(() => null);

  mkdirp(CFG.out);
  if (gen7Available) { catalog.terrain = buildTerrain(); catalog.grass = buildGrass(); catalog.farms = await buildFarms(targets); }
  const allCatalog = mergeCatalog(builtCatalog, catalog), allCombat = mergeCombat(builtCombat, combat);
  fs.writeFileSync(catalogFile, JSON.stringify(allCatalog, null, 1));
  fs.writeFileSync(combatFile, JSON.stringify(allCombat, null, 1));
  const missing = Object.entries(catalog.blueprints).filter(([, e]) => !Object.keys(e.ages).length).map(([bp]) => bp);
  log(`\n${Object.keys(catalog.models).length} models written for ${name}; no model for: ${missing.join(', ') || 'none'}`);
  log(`catalog.json now: ${Object.keys(allCatalog.blueprints).length} blueprints, ${Object.keys(allCatalog.models).length} models, `
    + `${Object.keys(allCombat.units).length} units with weapon timings, from ${allCatalog.replays.join(', ')}`);
  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

if (isMainThread) main().catch((e) => { console.error(e); process.exit(1); });
else ktxWorker();
