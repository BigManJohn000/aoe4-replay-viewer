#!/usr/bin/env node
/**
 * parity-check.mjs — checks that the 3D viewer's core/ reports the same game facts as the 2D viewer's model.js.
 *
 *   node tools/parity-check.mjs [name]          (default aoe4_245598603; exit code 1 on any mismatch)
 *
 * Runs the 2D viewer's units.js, stats.js, frame.js, model.js and data/<name>.js (its folder: RV_2D_VIEWER, default
 * ../viewer, as for serve.mjs) in a sandbox, prepares the same recording with core/replay.js, and compares the shared
 * combat index (frame.js RV_FRAME.combat over each side's entity table: shots, melee blows, typed damage numbers,
 * heals) and, at 120 times across the replay: per entity alive / owner / position (core.locate: the recorded motion,
 * not the re-timed place() the viewer draws) / HP, vision for every player, team and all players, display name (the 2D
 * one ends tier-I names in " I" and keeps the Tech/Defense/Viz/Resource tokens the 3D one leaves out) and unit tier; per
 * player banked resources, population and the army series; the kill order, kill feed and age-up/eco tech table (2D
 * app.js rules restated below); the FrameRenderState lists (projectiles, impacts, heals, damage numbers, engagement
 * lines); the eco opportunity-cost rows (eco.js) over each side's combat index; the engagement analysis (fights.js: list
 * rows, Micro Ratings, Lanchester and what-if, tug of war, idle/late, position tags, target-fire lines, eco casualties).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEWER_2D = path.resolve(process.env.RV_2D_VIEWER ?? path.join(PROJECT, '..', 'viewer'));
const NAME = process.argv[2] ?? 'aoe4_245598603';
const STEPS = 120;

const sandbox = { window: {} };
vm.createContext(sandbox);
for (const f of ['units.js', 'stats.js', 'frame.js', 'eco.js', 'fights.js', 'model.js', `data/${NAME}.js`]) {
  vm.runInContext(fs.readFileSync(path.join(VIEWER_2D, f), 'utf8'), sandbox, { filename: path.join(VIEWER_2D, f) });
}
const { RV, RV_UNITS, RV_FRAME, RV_ECO, RV_FIGHTS, REPLAY_DATA } = sandbox.window;
const data = REPLAY_DATA?.[NAME];
if (!data) throw new Error(`${NAME}: no REPLAY_DATA in ${VIEWER_2D}/data/${NAME}.js`);

const core = await import(pathToFileURL(path.join(PROJECT, 'core', 'replay.js')).href);
const ana = await import(pathToFileURL(path.join(PROJECT, 'core', 'analysis.js')).href);
const M = RV.prepare(structuredClone(data));
const R = new core.Replay(structuredClone(data), RV_UNITS, RV_FRAME);
const V3 = RV_FRAME.controller(R.combat);

const bad = new Map(); // check → { n, examples }
function fail(check, detail) {
  const b = bad.get(check) ?? { n: 0, examples: [] };
  b.n++;
  if (b.examples.length < 5) b.examples.push(detail);
  bad.set(check, b);
}
let checks = 0;
const same = (check, a, b, detail) => { checks++; if (a !== b) fail(check, `${detail}: 2D ${JSON.stringify(a)} vs 3D ${JSON.stringify(b)}`); };
const near = (check, a, b, detail) => { checks++; if (!(Math.abs(a - b) <= 1e-4)) fail(check, `${detail}: 2D ${a} vs 3D ${b}`); };

// --- static facts ---
same('entities', M.ents.length, R.ents.length, 'entity count');
M.ents.forEach((a, i) => same('entities', a.id, R.ents[i]?.id, `entity ${i} id`));
same('kills', M.kills.length, R.kills.length, 'kill count');
M.kills.forEach((k, i) => same('kills', `${k.t}|${k.victim}|${k.killer}`, `${R.kills[i]?.t}|${R.kills[i]?.victim}|${R.kills[i]?.killer}`, `kill ${i}`));
M.ents.forEach((a, i) => same('gate fix', a.bp, R.ents[i].bp, `entity ${a.id} bp`));

// 2D app.js techTable (first research per player; best = earliest)
const techs2 = new Map();
for (const [t, idx, label, kind] of M.techs) {
  if (!techs2.has(label)) techs2.set(label, { kind, at: new Map() });
  const r = techs2.get(label);
  if (!r.at.has(idx)) r.at.set(idx, t);
}
const techs3 = ana.techTable(R);
same('tech table', [...techs2.keys()].join('|'), techs3.map((r) => r.label).join('|'), 'rows');
for (const r3 of techs3) {
  const r2 = techs2.get(r3.label);
  if (!r2) continue;
  same('tech table', r2.kind, r3.kind, `${r3.label} kind`);
  same('tech table', Math.min(...r2.at.values()), r3.best, `${r3.label} best`);
  for (const p of data.players) same('tech table', r2.at.get(p.idx), r3.at.get(p.idx), `${r3.label} p${p.idx}`);
}

// shared combat index (frame.js RV_FRAME.combat) over each viewer's entity table
const C2 = M.combat, C3 = R.combat;
const blowKey = (b) => `${b.a.id}>${b.b.id}|${b.t0.toFixed(4)}|${b.t1.toFixed(4)}|${b.dtype}|${+b.miss}${+b.kill}${+b.guess}`;
same('blows', C2.shots.length, C3.shots.length, 'shot count');
C2.shots.forEach((b, i) => same('blows', blowKey(b), C3.shots[i] && blowKey(C3.shots[i]), `shot ${i}`));
same('blows', C2.melee.length, C3.melee.length, 'melee count');
C2.melee.forEach((b, i) => same('blows', blowKey(b), C3.melee[i] && blowKey(C3.melee[i]), `melee ${i}`));
same('damage', C2.dmgT.length, C3.dmgT.length, 'damage count');
for (let k = 0; k < C2.dmgT.length; k++) {
  same('damage', `${C2.dmgT[k].toFixed(4)}|${C2.dmgId[k]}|${C2.dmgAmt[k]}|${C2.dmgType[k]}|${+!!C2.dmgBonus[k]}|${+!!C2.dmgSplash[k]}`,
    `${C3.dmgT[k]?.toFixed(4)}|${C3.dmgId[k]}|${C3.dmgAmt[k]}|${C3.dmgType[k]}|${+!!C3.dmgBonus[k]}|${+!!C3.dmgSplash[k]}`, `damage ${k}`);
}
same('heals', C2.heals.length, C3.heals.length, 'heal count');
C2.heals.forEach((h, i) => { const g = C3.heals[i]; same('heals', `${h.healer.id}>${h.target.id}|${h.t0}|${h.t1}|${h.total}`, g && `${g.healer.id}>${g.target.id}|${g.t0}|${g.t1}|${g.total}`, `heal ${i}`); });

// eco opportunity cost (eco.js) over each side's combat index
const ecoKey = (r) => [r.id, r.key, r.status, r.tActual, r.tBench, r.benchSource, r.costTotal, r.rateBase?.toFixed(4), r.rateUp?.toFixed(4),
  r.missed.toFixed(2), r.deficit.toFixed(2), r.capitalized.label, r.capitalized.reason].join('|');
const eco2 = RV_ECO.analyze(data, C2), eco3 = RV_ECO.analyze(data, C3);
for (const p of data.players) {
  const a = eco2.players.get(p.idx).techs, b = eco3.players.get(p.idx).techs;
  same('eco', a.length, b.length, `p${p.idx} rows`);
  a.forEach((r, i) => same('eco', ecoKey(r), b[i] && ecoKey(b[i]), `p${p.idx} ${r.id}`));
  for (const r of a) same('eco series', JSON.stringify(RV_ECO.series(data, C2, p.idx, r.id)), JSON.stringify(RV_ECO.series(data, C3, p.idx, r.id)), `p${p.idx} ${r.id}`);
}

// engagement analysis (fights.js) over each side's combat index; all of one side first (fights.js caches one index
// per fight). Floats rounded to 4 places, far below what the panels print.
const fkey = (v) => JSON.stringify(v, (k, x) => (typeof x === 'number' && !Number.isInteger(x) ? +x.toFixed(4) : x));
const fightKeys = (C) => data.fights.map((f, i) => {
  const A = RV_FIGHTS.analyze(data, C, i);
  const idle = Object.fromEntries(A.teams.map((tm) => [tm, [A.idle[tm].idle.length, A.idle[tm].late.length, A.idle[tm].idleValue, A.idle[tm].lateValue]]));
  return fkey({ rating: A.rating, l: A.lanchester, wa: A.whatIf({ side: 'A', armor: 1, attack: 1 }), wb: A.whatIf({ side: 'B', armor: 1 }),
    tug: [A.tug.series.length, A.tug.events.length, A.tug.final], idle, tags: A.tags, heat: [A.heat.lines.length, A.heat.total, A.heat.bySide],
    eco: A.eco });
});
const list2 = fkey(RV_FIGHTS.list(data, C2)), fights2 = fightKeys(C2);
const list3 = fkey(RV_FIGHTS.list(data, C3)), fights3 = fightKeys(C3);
same('fights list', list2, list3, 'RV_FIGHTS.list');
fights2.forEach((k, i) => same('fights', k, fights3[i], `fight ${data.fights[i].id}`));

// --- per-time facts ---
const masks = [...data.players.map((p) => [`p${p.idx}`, 1 << (p.idx - 1)]), ...[...M.teamMask].map(([tm, m]) => [`team${tm}`, m]), ['all', M.allMask]];
for (let s = 0; s < STEPS; s++) {
  const t = R.t0 + ((R.t1 - R.t0) * (s + 0.5)) / STEPS + 0.137; // off the sample grid, so interpolation is exercised
  RV.updateFrame(M, t);
  R.updateFrame(t);
  const at = `t=${t.toFixed(2)}`;
  for (let i = 0; i < M.ents.length; i++) {
    const a = M.ents[i], b = R.ents[i], who = `${at} ${a.id} ${a.bp}`;
    same('alive', a.on, b.on, who);
    if (!a.on || !b.on) continue;
    same('owner', a.pown, b.pown, who);
    const L = core.locate(b, t);
    near('position', a.px, L.x, `${who} x`);
    near('position', a.pz, L.z, `${who} z`);
    same('hp', a.php, b.php, who);
    for (const [label, m] of masks) same('vision', RV.visibleTo(a, t, m), core.visibleTo(b, t, m), `${who} ${label}`);
    same('name', RV.nameAt(a, t).replace(/ I$/, '').replace(/\b(Tech|Defense|Viz|Resource) /g, ''), R.nameAt(b, t), who);
    if (b.isUnit && !b.followsAge) same('tier', RV.tierAt(a, t) || 1, R.tierAt(b, t), who);
  }
  for (const p of data.players) {
    const s2 = RV.statsAt(M, p.idx, t), s3 = ana.statsAt(R, p.idx, t);
    same('stats', s2 ? s2.slice(1, 6).join(',') : null, s3 ? [s3.food, s3.wood, s3.gold, s3.stone, s3.pop].join(',') : null, `${at} p${p.idx}`);
    // 2D app.js renderPlayers army columns
    const a2 = M.army.players[String(p.idx)] || {}, k = Math.min(Math.floor(t / M.army.step), (a2.military || []).length - 1), a3 = ana.armyAt(R, p.idx, t);
    same('army', `${a2.villagers?.[k]}|${a2.military?.[k]}|${a2.armyValue?.[k]}`, `${a3?.villagers}|${a3?.military}|${a3?.value}`, `${at} p${p.idx}`);
  }
  // 2D app.js kill feed: newest first, up to 25, no livestock/attachments
  const feed2 = [];
  for (let j = RV.idxAt(M.killT, t); j >= 0 && feed2.length < 25; j--) {
    const v = M.byId.get(M.kills[j].victim);
    if (!v || v.cat === 'livestock' || v.cat === 'attachment') continue;
    feed2.push(j);
  }
  same('kill feed', feed2.join(','), ana.killFeed(R, t, 25).join(','), at);
  // FrameRenderState lists (frame.js controller) at t
  const f2 = M.view.frame(t), f3 = V3.frame(t);
  const list = (S) => [
    S.activeProjectiles.map((p) => `${p.attackerId}>${p.targetId}@${p.progress.toFixed(4)}:${p.damageType}`).join(','),
    S.activeHeals.map((h) => `${h.healerId}>${h.targetId}:${h.healRatePerSec.toFixed(3)}`).join(','),
    S.floatingDamageEvents.map((d) => `${d.unitId}:${d.amount}:${d.damageType}:${d.worldPos.x.toFixed(3)},${d.worldPos.z.toFixed(3)}`).join(','),
    S.activeEngagementLines.map((l) => `${l.unitId}>${l.targetId}:${l.efficiencyScore.toFixed(4)}`).join(','),
    S.activeImpacts.map((m) => `${m.attackerId}@${m.t1.toFixed(3)}:${m.x.toFixed(3)},${m.z.toFixed(3)}:${m.victims.length}`).join(','),
  ];
  const [p2, h2, d2, l2, m2] = list(f2), [p3, h3, d3, l3, m3] = list(f3);
  same('frame projectiles', p2, p3, at);
  same('frame heals', h2, h3, at);
  same('frame damage numbers', d2, d3, at);
  same('frame engagement lines', l2, l3, at);
  same('frame impacts', m2, m3, at);
}
// splash impacts are short (frame.js IMPACT_SHOW): also compare just after every splash landing
for (const s of M.combat.shots) {
  if (!s.splash) continue;
  const t = s.t1 + 0.1, at = `t=${t.toFixed(2)}`;
  const key = (S) => S.activeImpacts.map((m) => `${m.attackerId}@${m.t1.toFixed(3)}:${m.x.toFixed(3)},${m.z.toFixed(3)}:${m.victims.join('/')}`).join(',');
  const k2 = key(M.view.frame(t)), k3 = key(V3.frame(t));
  same('frame impacts at landings', k2, k3, at);
  if (!k2) same('impact shown at landing', 'impact', '', at);
}

console.log(`${NAME}: ${checks} comparisons at ${STEPS} times, ${M.ents.length} entities`);
if (!bad.size) console.log('parity OK');
for (const [check, b] of bad) {
  console.log(`MISMATCH ${check}: ${b.n}`);
  for (const e of b.examples) console.log(`  ${e}`);
}
process.exitCode = bad.size ? 1 : 0;
