#!/usr/bin/env node
/**
 * build-stats.mjs — builds viewer/stats.js (window.RV_STATS), the unit / building / technology numbers both viewers read
 * (hit points, armor, cost, speed, weapons with their bonus-damage modifiers, technology effects, attack timings).
 *
 *   node viewer3d/tools/build-stats.mjs [--from <dir>] [--out <file>] [--no-combat]
 *
 * Sources: data.aoe4world.com units/buildings/technologies all.json (downloaded; --from <dir> reads units_all.json,
 * buildings_all.json, technologies_all.json copies instead), plus viewer3d/assets/combat.json (built locally by
 * build-assets.mjs from the game files, Git-ignored) when it exists. Node 18+, no packages.
 *
 * Entries are keyed by aoe4world attribName, which equals the blueprint name the recordings use (unit_archer_2_sul).
 * aoe4world lists a blueprint once per civilization variant: the first listing supplies the numbers, civs are merged.
 *
 * Attack timings (main / torch): a blueprint combat.json knows keeps the game's own numbers (src "combat"); any other
 * is derived from its aoe4world weapons (src "aoe4world"): main = first non-fire weapon (else the fire one), torch =
 * the fire weapon named Torch. Blueprints only combat.json has (building weapon attachments wpn_*, units aoe4world
 * lacks) become timing-only records { main, torch }. Ranges in a timing are game metres: aoe4world ranges × 4
 * (measured on every blueprint in both sources: 572 of 595 exactly 4.0, the other 23 at 5.7), and a derived period is
 * the weapon speed minus its attack duration (combat.json's value on 572 of 595). Fields aoe4world lacks (melee weapon
 * family, mounted attacks) come from the same base unit's combat.json timing when there is one, else from name rules.
 * Class words (cls): see "Class vocabulary" below.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };
const fromDir = opt('from');
const outFile = resolve(opt('out') ?? join(root, 'viewer', 'stats.js'));
const combatFile = join(root, 'viewer3d', 'assets', 'combat.json');
const BASE = 'https://data.aoe4world.com/';

async function load(name, dir) {
  if (fromDir) return JSON.parse(await readFile(join(fromDir, `${dir}_all.json`), 'utf8'));
  const r = await fetch(`${BASE}${dir}/all.json`);
  if (!r.ok) throw new Error(`${BASE}${dir}/all.json: HTTP ${r.status}`);
  return r.json();
}

const units = await load('units', 'units');
const buildings = await load('buildings', 'buildings');
const techs = await load('technologies', 'technologies');
const version = units.__version__ ?? '?';
const combat = existsSync(combatFile) && !args.includes('--no-combat') ? JSON.parse(await readFile(combatFile, 'utf8')).units ?? {} : {};

const num = x => (typeof x === 'number' ? Math.round(x * 1e4) / 1e4 : 0);
const median = a => { a = [...a].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

// Projectile speeds (m/s) per timing class, for derived timings. Medians over every combat.json main/torch timing that
// has a projectile (this machine's game build, 2026-10): bow 188 timings 27–36, crossbow 57 timings 0–0 (the bolt has no
// speed record), handcannon 16 timings 20–55 (36 more fire instantly, no projectile), javelin 16 timings 20–30,
// siege 143 timings 20–40, fire (torch / incendiary) 537 timings 3–40. Re-measured and printed on every run.
const SPEEDS = {
  cdn_bow: [27, 36], cdn_crossbow: [0, 0], cdn_handcannon: [20, 55], cdn_javelin: [20, 30],
  cdn_siege_projectile: [20, 40], cdn_fire: [3, 40],
};
const measured = {};
for (const v of Object.values(combat)) for (const s of ['main', 'torch']) {
  const t = v[s];
  if (!t?.projectile) continue;
  const m = measured[t.class] ??= { n: 0, lo: [], hi: [] };
  m.n++; m.lo.push(t.projectile.speedMin); m.hi.push(t.projectile.speedMax);
}
for (const [k, m] of Object.entries(measured)) if (SPEEDS[k]) console.log(`projectile ${k}: ${m.n} timings, median speed ${median(m.lo)}–${median(m.hi)} (hard-coded ${SPEEDS[k].join('–')})`);

/** Timing class by blueprint id and weapon (swingKind in core/replay.js reads bow/fire/2h_spear/1h_sword/1h_axe). */
function timingClass(d, w) {
  if (w.type === 'fire') return 'cdn_fire';
  if (w.type === 'siege') return 'cdn_siege_projectile';
  const id = `${d.baseId} ${w.name}`.toLowerCase();
  if (w.type === 'ranged') {
    if (/crossbow|arbalest|arbaletrier|springald/.test(id)) return 'cdn_crossbow';
    if (/handcannon|gun|musket|janissary|arquebus|ozutsu|cannon/.test(id)) return 'cdn_handcannon';
    if (/javelin|skirmisher|throw/.test(id)) return 'cdn_javelin';
    return 'cdn_bow';
  }
  if (/spear|pike|halberd/.test(id)) return 'cdn_2h_spear';
  if (/sword|man-at-arms/.test(id)) return 'cdn_1h_sword';
  if (/axe/.test(id)) return 'cdn_1h_axe';
  return 'cdn_melee';
}

const DAMAGE = { melee: 'Melee', ranged: 'Ranged', siege: 'Siege', fire: 'Fire' };

// Timing class a combat.json blueprint of the same base unit has per slot: the melee weapon families (one-handed spear,
// poleaxe, sword and shield …) are not in aoe4world's data, so a unit combat.json lacks (another civilization's variant,
// a newer blueprint) borrows its siblings' class before the name rules above.
const hint = {};
for (const d of [...units.data, ...buildings.data]) {
  const c = combat[d.attribName];
  for (const s of ['main', 'torch']) if (c?.[s]) hint[`${d.baseId}|${s}`] ??= c[s];
}

/**
 * Whether the weapon swings / shoots without stopping. Measured on combat.json (main timings): 139 of 163 melee cavalry
 * (not elephants), the horse archers and Mangudai (7 of 24 mounted archers; camel archers and keshiks stand to shoot), and
 * every torch (536 of 537), nothing on foot, on a ship or in a building.
 */
const movesWhileAttacking = (d, w) => w.type === 'fire'
  || (d.classes.includes('cavalry') && !d.classes.includes('elephant') && (w.type === 'melee' || /horse-?archer|mangudai/.test(d.baseId)));

/** Timing record from an aoe4world weapon. combat.json's period is aoe4world's weapon speed minus the attack duration (572 of 595 blueprints). */
function derive(d, w, slot) {
  const h = hint[`${d.baseId}|${slot}`], du = w.durations ?? {};
  const cls = h?.class ?? timingClass(d, w);
  const sp = w.type === 'melee' ? null : SPEEDS[cls];
  const name = w.name.toLowerCase();
  return {
    class: cls, damage: DAMAGE[w.type], range: num((w.range?.max ?? 0) * 4),
    aim: num(du.aim), windUp: num(du.windup), windDown: num(du.winddown),
    moving: h ? h.moving : movesWhileAttacking(d, w),
    period: num(w.speed - (du.attack ?? 0)),
    projectile: sp ? { speedMin: sp[0], speedMax: sp[1] } : null,
    art: /mace|axe|hammer|club/.test(name) ? name : null,
    src: 'aoe4world',
  };
}

const KEEP = ['class', 'damage', 'range', 'aim', 'windUp', 'windDown', 'moving', 'period', 'projectile', 'art'];
/** combat.json timing → record (its own numbers; pbg names, impact / reload / cooldown dropped). */
function fromCombat(t) {
  if (!t) return null;
  const o = {};
  for (const k of KEEP) if (k in t) o[k] = k === 'projectile' && t[k] ? { speedMin: t[k].speedMin, speedMax: t[k].speedMax } : t[k];
  o.src = 'combat';
  return o;
}

function timings(bp, d, weapons) {
  const c = combat[bp];
  if (c) return { main: fromCombat(c.main), torch: fromCombat(c.torch) };
  const first = weapons.find(w => w.type !== 'fire') ?? weapons.find(w => w.type === 'fire');
  const torch = weapons.find(w => w.type === 'fire' && w.name === 'Torch');
  return { main: first ? derive(d, first, 'main') : null, torch: torch ? derive(d, torch, 'torch') : null };
}

const mod = m => {
  const o = { p: m.property };
  o.c = m.target?.class ?? [];
  if (m.target?.id) o.id = m.target.id;
  o.e = m.effect; o.v = num(m.value);
  return o;
};

function weapon(w) {
  const du = w.durations ?? {};
  return {
    n: w.name, ty: w.type, dmg: num(w.damage), per: num(w.speed), rmin: num(w.range?.min), rmax: num(w.range?.max),
    burst: w.burst?.count ?? 1, mods: (w.modifiers ?? []).map(mod),
    aim: num(du.aim), wu: num(du.windup), wd: num(du.winddown), rel: num(du.reload),
  };
}

// Class vocabulary: every class word a weapon modifier (target.class) or a technology effect (select / target class) names.
// Those lists are all-of tuples (["light","melee","infantry"] = light melee infantry), any-of across the outer array, and
// their words come from both aoe4world `classes` and the words of `displayClasses` ("Light Melee Infantry"), so a unit's
// cls keeps the words of both that the vocabulary uses (the other ~12 housekeeping classes per unit are dropped for size),
// plus a few unit-kind classes the viewers test directly.
const vocab = new Set(['military', 'land_military', 'hero', 'villager', 'trader', 'monk']);
const addWords = g => { for (const t of g ?? []) for (const w of t) vocab.add(w); };
for (const d of [...units.data, ...buildings.data]) for (const w of d.weapons ?? []) for (const m of w?.modifiers ?? []) addWords(m.target?.class);
for (const d of techs.data) for (const e of d.effects ?? []) { addWords(e.select?.class); addWords(e.target?.class); }
const classWords = d => {
  const s = new Set((d.classes ?? []).filter(c => vocab.has(c)));
  for (const dc of d.displayClasses ?? []) for (const w of dc.toLowerCase().split(/\s+/)) if (vocab.has(w)) s.add(w);
  return [...s].sort();
};

const out = { units: {}, techs: {} };
for (const d of [...units.data, ...buildings.data]) {
  const bp = d.attribName;
  if (!bp) continue;
  if (out.units[bp]) { for (const c of d.civs ?? []) if (!out.units[bp].civs.includes(c)) out.units[bp].civs.push(c); continue; }
  const weapons = (d.weapons ?? []).filter(Boolean);
  const arm = { melee: 0, ranged: 0 };
  for (const a of d.armor ?? []) if (a.type === 'melee' || a.type === 'ranged' || (a.type === 'fire' && a.value)) arm[a.type] = num(a.value);
  const c = d.costs ?? {};
  out.units[bp] = {
    b: d.baseId, n: d.name, age: d.age ?? 0, civs: [...(d.civs ?? [])], cls: classWords(d), hp: num(d.hitpoints), arm,
    spd: num(d.movement?.speed), cost: { f: num(c.food), w: num(c.wood), g: num(c.gold), s: num(c.stone), t: num(c.time), pop: num(c.popcap) },
    wp: weapons.map(weapon), ...timings(bp, d, weapons),
  };
}
for (const e of Object.values(out.units)) e.civs.sort();

let combatOnly = 0;
for (const [bp, c] of Object.entries(combat)) {
  if (out.units[bp]) continue;
  out.units[bp] = { main: fromCombat(c.main), torch: fromCombat(c.torch) };
  combatOnly++;
}

const sel = s => {
  const o = {};
  if (s?.id?.length) o.id = s.id;
  if (s?.class?.length) o.c = s.class;
  return o;
};
const GATHER_DESC = [
  /Villagers' gathering rate for ([A-Z][a-z]+(?: and [A-Z][a-z]+)?) by \+?(\d+)%/,
  /Villagers' ([A-Z][a-z]+) gather rate by \+?(\d+)%/,
];
const descGather = (text) => {
  for (const rx of GATHER_DESC) {
    const m = rx.exec(text);
    if (m) return m[1].split(' and ').map(r => ({ p: `${r.toLowerCase()}GatherRate`, id: ['villager'], e: 'multiply', v: 1 + +m[2] / 100, src: 'desc' }));
  }
  return [];
};
for (const d of techs.data) {
  const bp = d.attribName;
  if (!bp) continue;
  if (out.techs[bp]) { for (const c of d.civs ?? []) if (!out.techs[bp].civs.includes(c)) out.techs[bp].civs.push(c); continue; }
  // k: the effect's kind when not passive ("ability": only while an ability runs; "influence": near a building or
  // unit; "bonus": against tc targets). Techs without effects (age-ups, unlocks) stay for their cost.
  const eff = (d.effects ?? []).filter(e => e.property && e.property !== 'unknown').map(e => {
    const o = { p: e.property, ...sel(e.select), e: e.effect, v: num(e.value) };
    if (e.target?.class?.length) o.tc = e.target.class;
    if (e.type && e.type !== 'passive') o.k = e.type;
    return o;
  });
  // aoe4world leaves some villager gather techs without structured effects (Shaft Mining: "Increase Villagers'
  // gathering rate for Gold and Stone by 15%."); their description gives the rate (src: "desc").
  if (!eff.length) eff.push(...descGather(d.description ?? ''));
  const c = d.costs ?? {};
  out.techs[bp] = { b: d.baseId, n: d.name, civs: [...(d.civs ?? [])], cost: { f: num(c.food), w: num(c.wood), g: num(c.gold), s: num(c.stone), t: num(c.time) }, eff };
}
for (const e of Object.values(out.techs)) e.civs.sort();

const lines = obj => Object.keys(obj).sort().map(k => `    ${JSON.stringify(k)}: ${JSON.stringify(obj[k])}`).join(',\n');
// The object literal is strict JSON, so tools/convert.py can read it (tech names) the way it reads units.js.
const text = `// Generated by \`node viewer3d/tools/build-stats.mjs\` from data.aoe4world.com ${version} and viewer3d/assets/combat.json.
// Do not edit by hand; rerun the command (README.md, "Unit statistics").
window.RV_STATS = {
  "source": ${JSON.stringify('data.aoe4world.com ' + version)},
  "units": {
${lines(out.units)}
  },
  "techs": {
${lines(out.techs)}
  }
};
`;
await writeFile(outFile, text);
console.log(`${outFile}: ${(text.length / 1e6).toFixed(2)} MB, ${Object.keys(out.units).length} units/buildings (${combatOnly} timing-only from combat.json), ${Object.keys(out.techs).length} techs, aoe4world ${version}`);
