#!/usr/bin/env node
// Uses the viewers' reconstruction, not a second combat simulator. No replay tracks are printed.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'viewer/data');
const OUT = path.join(ROOT, 'harvest/analysis');
const VERSION = 5;
const MAY = 10307814;
const TILE_METRES = 4; // statsAt.range is tiles; recorded positions and timing ranges are metres (model.js CONVERT_R).
const scripts = ['units', 'stats', 'frame', 'model', 'fights', 'eco'].map(name =>
  new vm.Script(fs.readFileSync(path.join(ROOT, `viewer/${name}.js`), 'utf8'), { filename: `viewer/${name}.js` }));
const args = process.argv.slice(2);
const force = args.includes('--force');
const includeAll = args.includes('--all');
if (args.some(a => a.startsWith('--') && !['--force', '--all'].includes(a))) throw new Error('Usage: node tools/analyze_rlogs.mjs [--force] [--all] [names...]');
const names = [...new Set(args.filter(a => !a.startsWith('--')).map(a => path.basename(a).replace(/\.js$/, '')))];
if (!names.length) names.push(...fs.readdirSync(DATA).filter(n => /^aoe4_.*\.js$/.test(n)).map(n => n.slice(0, -3)).sort());
fs.mkdirSync(OUT, { recursive: true });
let logLines = 0;
// Reserve five of the 60 permitted output lines for final summaries; synchronous writes also flush correctly when stdout is piped on Windows.
const log = (text, final = false) => {
  if (logLines >= (final ? 60 : 55)) return;
  logLines++; fs.writeSync(1, `${String(text).replace(/[\r\n]+/g, ' ')}\n`);
};
const finite = n => Number.isFinite(n);
const ratio = (a, b) => b > 0 ? (a ?? 0) / b : null;
const round = n => finite(n) ? Math.round(n * 1000) / 1000 : null;
const plus = (o, key, n = 1) => { o[key] = (o[key] || 0) + n; };

async function loadHarvestMetadata() {
  const database = path.join(ROOT, 'harvest/aoe4.db');
  if (!fs.existsSync(database)) return new Map();
  const candidates = [...names, ...fs.readdirSync(OUT).filter(n => n.endsWith('.json')).map(n => n.replace(/\.json$/, ''))];
  const ids = [...new Set(candidates.map(n => /^aoe4_(\d+)$/.exec(n)?.[1]).filter(Boolean).map(Number))];
  if (!ids.length) return new Map();
  const sql = `SELECT game_id,started_at,map,p0,p1,p0_name,p1_name,p0_mmr,p1_mmr,p0_civ,p1_civ FROM games WHERE game_id IN (${ids.map(() => '?').join(',')})`;
  let rows;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(database, { readOnly: true });
    try { rows = db.prepare(sql).all(...ids); } finally { db.close(); }
  } catch (nodeError) {
    // Python's SQLite module is the supported fallback on Node versions without node:sqlite; mode=ro forbids writes.
    const code = 'import json,sqlite3,sys,pathlib; db=sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri()+\"?mode=ro\",uri=True); db.row_factory=sqlite3.Row; print(json.dumps([dict(r) for r in db.execute(sys.argv[2],json.loads(sys.argv[3]))])); db.close()';
    const result = spawnSync('python', ['-c', code, database, sql, JSON.stringify(ids)], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    if (result.status !== 0 || result.error) {
      log(`Harvest metadata unavailable: ${nodeError.message}; ${result.error?.message || result.stderr.trim()}`);
      return new Map();
    }
    rows = JSON.parse(result.stdout);
  }
  return new Map(rows.map(row => [String(row.game_id), row]));
}
const harvestMetadata = await loadHarvestMetadata();
function attachMetadata(record) {
  const gameId = /^aoe4_(\d+)$/.exec(record.name)?.[1], game = harvestMetadata.get(gameId);
  record.gameId = gameId ? Number(gameId) : null;
  record.map = game?.map ?? record.map ?? null;
  record.date = game?.started_at ?? record.date ?? null;
  record.metadataSource = game ? 'harvest/aoe4.db' : null;
  for (let index = 0; index < record.players.length; index++) {
    const player = record.players[index];
    // pid is a replay command-player id, NEVER an account/profile id. Harvest matching uses actual profile id, name, unique civ, then two-player order.
    let slot = game && player.profileId != null ? [0, 1].find(i => Number(game[`p${i}`]) === Number(player.profileId)) : undefined;
    if (game && slot === undefined) slot = [0, 1].find(i => game[`p${i}_name`] === player.name);
    if (game && slot === undefined && player.civ) {
      const normal = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const matching = [0, 1].filter(i => normal(game[`p${i}_civ`]) === normal(player.civ));
      if (matching.length === 1) slot = matching[0];
    }
    if (game && slot === undefined && record.players.length === 2) slot = index;
    player.profileId ??= slot === undefined ? null : game[`p${slot}`] ?? null;
    player.mmr = slot === undefined ? null : game[`p${slot}_mmr`] ?? null;
    player.cohort = Number(player.profileId) === MAY || (player.profileId == null && /^may$/i.test(player.name || '')) ? 'may' : 'rest';
  }
  return record;
}

// Distributions retain weighted frequency bins (0.001 units); pooled quantiles use observations, not means of medians.
function sample(row, key, n) {
  if (!finite(n)) return;
  const bins = row.histograms[key] ||= {};
  plus(bins, String(round(n)));
}
function distribution(bins = {}) {
  const entries = Object.entries(bins).map(([v, n]) => [+v, n]).sort((a, b) => a[0] - b[0]);
  const n = entries.reduce((s, e) => s + e[1], 0);
  function quantile(q) {
    if (!n) return null;
    const index = (n - 1) * q, lo = Math.floor(index), hi = Math.ceil(index);
    let seen = 0, a, b;
    for (const [v, count] of entries) {
      if (a === undefined && lo < seen + count) a = v;
      if (hi < seen + count) { b = v; break; }
      seen += count;
    }
    return a + (b - a) * (index - lo);
  }
  return { n, mean: ratio(entries.reduce((s, [v, count]) => s + v * count, 0), n),
    p10: quantile(.1), p25: quantile(.25), p50: quantile(.5), median: quantile(.5), p75: quantile(.75), p90: quantile(.9) };
}
function newControlSide() {
  return { units: 0, landingDrops: 0, controlDrops: 0, landingHp: 0, controlHp: 0, skippedOtherBlow: 0, skippedNoControl: 0 };
}
function newFalloffBin() {
  return { count: 0, enemyCount: 0, friendlyCount: 0, attributedCount: 0, totalDamage: 0, friendlyDamage: 0, ratioBins: {},
    control: { enemy: newControlSide(), friendly: newControlSide() } };
}
function controlMetrics(side) {
  // Both probabilities and unconditional HP means use the SAME matched unit-sample count; excess subtracts t-1 from t. Conditional HP means divide only by positive-drop samples.
  const landingProbability = ratio(side.landingDrops, side.units), controlProbability = ratio(side.controlDrops, side.units);
  const landingMeanHp = ratio(side.landingHp, side.units), controlMeanHp = ratio(side.controlHp, side.units);
  return { ...side, landingProbability, controlProbability, landingMeanHp, controlMeanHp,
    excessDropProbability: side.units ? landingProbability - controlProbability : null,
    excessMeanHp: side.units ? landingMeanHp - controlMeanHp : null,
    landingMeanWhenDamaged: ratio(side.landingHp, side.landingDrops), controlMeanWhenDamaged: ratio(side.controlHp, side.controlDrops) };
}
function newCounterCell(player, attacker, victim) {
  return { player, attacker, victim, damage: 0, valueEngagedSeconds: 0, engagedSeconds: 0,
    killedValue: 0, lostValue: 0, directKills: 0, directDeaths: 0, directFights: 0 };
}
function newRow(type, player) {
  const keys = ['unitCount', 'aliveSeconds', 'blows', 'shots', 'misses', 'shotMisses', 'kills', 'damageDealt', 'damageTaken',
    'bonusFlagDamage', 'splashDamage', 'theoreticalDpsSum', 'theoreticalBlows', 'engagedSeconds', 'afterDeathBlows',
    'wastedBlows', 'guessedBlows', 'estimatedKillingExcessHp', 'estimatedKillingDrops', 'killsWithVictim',
    'multiAttackerKills', 'targetChanges', 'priorityGood', 'priorityOk', 'priorityPoor', 'splashShots', 'splashVictims',
    'kitingShots', 'nearestMeleeShots', 'shotsWithin4m', 'shotsBeyondRange', 'healEvents', 'hpHealed', 'healingSeconds',
    'fightHealEvents', 'fightHealHp', 'healingReceivedHp', 'healingReceivedEvents', 'armourDpsSum', 'armourBlows',
    'blowActiveSeconds', 'shotsMoving', 'shotMovementObservations', 'projectileShots', 'instantRangedShots',
    'siegeIntervalObservations', 'sustainedSiegeShots', 'shotVictims', 'shotDamage', 'landedSplashShots',
    'volleys', 'volleyVictims', 'volleyDamage', 'sustainedVolleys', 'afterDeathShots', 'armourPaperDpsSum'];
  return { type, player, siege: false, healer: false, totals: Object.fromEntries(keys.map(k => [k, 0])),
    tiers: {}, tierAliveSeconds: {}, blueprints: {}, histograms: {}, splashFalloff: {} };
}
function finishRow(row) {
  const t = row.totals;
  // DPS uses summed credited damage / unioned per-entity engaged seconds; theoretical is the blow-weighted mean of (attack + applicable bonus)/period.
  const theoretical = ratio(t.theoreticalDpsSum, t.theoreticalBlows);
  const effective = ratio(t.damageDealt, t.engagedSeconds);
  const afterArmour = ratio(t.armourDpsSum, t.armourBlows);
  const priorities = t.priorityGood + t.priorityOk + t.priorityPoor;
  const distributions = Object.fromEntries(Object.entries(row.histograms).map(([key, bins]) => [key, distribution(bins)]));
  // Shares always retain their counted denominator; no observation is null, not a fabricated zero.
  return { ...row, metrics: {
    bonusDamageShare: ratio(t.bonusFlagDamage, t.damageDealt), theoreticalDps: theoretical,
    effectiveDps: effective, effectiveToTheoretical: theoretical > 0 && effective != null ? effective / theoretical : null,
    armourAdjustedDps: afterArmour, effectiveToArmourAdjusted: afterArmour > 0 && effective != null ? effective / afterArmour : null,
    // Mitigation compares summed after-armour and paper DPS on the SAME known-victim blow mix; median cadence ratio divides the two matched observation medians.
    armourMitigationShare: t.armourPaperDpsSum > 0 ? 1 - t.armourDpsSum / t.armourPaperDpsSum : null,
    cadenceMedianToPeriod: ratio(distributions.engagedCadenceSeconds?.median, distributions.engagedCadencePeriodSeconds?.median),
    // Blow-active time is unioned one-period attack-cycle occupancy, clipped to alive/engaged time; inferred uptime, not animation duration.
    uptimeShare: ratio(t.blowActiveSeconds, t.engagedSeconds),
    killingExcessShare: ratio(t.estimatedKillingExcessHp, t.damageDealt),
    // Post-death waste here counts SHOTS landing strictly after a known death, not ordinary misses; divide by all credited kills of this attacker type.
    postDeathShotsPerKill: ratio(t.afterDeathShots, t.kills),
    missShare: ratio(t.misses, t.blows), wasteBlowShare: ratio(t.wastedBlows, t.blows),
    multiAttackerKillShare: ratio(t.multiAttackerKills, t.killsWithVictim),
    targetChangesPerEngagedMinute: ratio((t.targetChanges || 0) * 60, t.engagedSeconds),
    splashDamageShare: ratio(t.splashDamage, t.damageDealt), splashVictimsPerShot: ratio(t.splashVictims, t.splashShots),
    siegeMissShare: ratio(t.shotMisses, t.shots),
    // Sustained share uses all shots (first shots cannot qualify); victims/shot counts distinct damaged primary/secondary victims, damage/shot uses credited shot damage.
    sustainedFireShare: ratio(t.sustainedSiegeShots, t.shots), sustainedIntervalShare: ratio(t.sustainedSiegeShots, t.siegeIntervalObservations),
    victimsPerShot: ratio(t.shotVictims, t.shots), damagePerShot: ratio(t.shotDamage, t.shots),
    // Per-volley means divide credited victim unions, HP, or shots by inferred volley count; coverage is matched volley credit / shot credit; sustained share includes first volleys in its denominator.
    victimsPerVolley: ratio(t.volleyVictims, t.volleys), damagePerVolley: ratio(t.volleyDamage, t.volleys),
    shotsPerVolley: ratio(t.shots, t.volleys), volleyDamageCoverage: ratio(t.volleyDamage, t.shotDamage),
    sustainedVolleyShare: ratio(t.sustainedVolleys, t.volleys),
    shotWithin4mShare: ratio(t.shotsWithin4m, t.kitingShots),
    shotBeyondOwnRangeShare: ratio(t.shotsBeyondRange, t.kitingShots),
    nearestMeleeObservedShare: ratio(t.nearestMeleeShots, t.kitingShots),
    movingShotShare: ratio(t.shotsMoving, t.kitingShots), shotMovementObservedShare: ratio(t.shotMovementObservations, t.kitingShots),
    priorityShares: { good: ratio(t.priorityGood, priorities), ok: ratio(t.priorityOk, priorities), poor: ratio(t.priorityPoor, priorities) },
    hpPerHealingSecond: ratio(t.hpHealed, t.healingSeconds),
    healingPerAliveMinute: ratio((t.hpHealed || 0) * 60, t.aliveSeconds),
    healsDuringFightsShare: ratio(t.fightHealEvents, t.healEvents),
    healingHpDuringFightsShare: ratio(t.fightHealHp, t.hpHealed),
    priority: { good: t.priorityGood || 0, ok: t.priorityOk || 0, poor: t.priorityPoor || 0 },
  }, distributions,
    splashFalloff: Object.fromEntries(Object.entries(row.splashFalloff).map(([key, bin]) => [key, {
      ...bin, dropRatio: distribution(bin.ratioBins),
      friendlyFireShare: ratio(bin.friendlyDamage, bin.totalDamage), friendlyVictimShare: ratio(bin.friendlyCount, bin.count),
      control: { enemy: controlMetrics(bin.control.enemy), friendly: controlMetrics(bin.control.friendly) },
      evidence: 'same-recorded-sample co-damage; friendly fire is not causally attributable',
    }])) };
}
// Time unions prevent overlapping attack flags, healing events or fight windows double-counting one entity's seconds.
function union(intervals) {
  const out = [];
  for (const [a, b] of intervals.filter(([a, b]) => finite(a) && finite(b) && b > a).sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out;
}
const seconds = intervals => intervals.reduce((s, [a, b]) => s + b - a, 0);
function overlap(intervals, a, b) {
  let s = 0;
  for (const [lo, hi] of intervals) s += Math.max(0, Math.min(hi, b) - Math.max(lo, a));
  return s;
}
const matches = (classes, selectors) => !!classes && !!selectors?.some(group => group.every(c => classes.includes(c)));
const weaponType = { melee: 'melee', pierce: 'ranged', siege: 'siege', fire: 'fire' };
// frame.js represents zero-flight crossbow/gun attacks as non-projectile blows; count these as instantaneous shots, without changing the reconstruction.
const isShot = bl => bl.shot || (!bl.torch && (bl.dtype === 'pierce' || bl.a.cat === 'ranged' || bl.a.type === 'horsearcher'));
function weapon(st, dtype) { return st?.wp?.find(w => w.ty === weaponType[dtype]) || st?.wp?.[0]; }
function bonus(w, st) {
  return (w?.mods || []).reduce((s, m) => s + (m.e === 'change' && (m.id?.includes(st?.b) || matches(st?.cls, m.c)) ? m.v : 0), 0);
}
function attack(sa, w, target) {
  return (sa?.atk?.[w.ty] ?? w.dmg) + bonus(w, target) + (sa?.vs || []).reduce((s, b) => s + (b.ty === w.ty && matches(target?.cls, b.c) ? b.v : 0), 0);
}
function hit(sa, w, sb, target) {
  if (!w) return 1;
  const armType = { melee: 'melee', ranged: 'ranged', fire: 'fire' }[w.ty];
  return Math.max(1, attack(sa, w, target) - (armType ? (sb?.arm?.[armType] ?? target?.arm?.[armType] ?? 0) : 0));
}
function firstAtOrAfter(times, t) {
  let lo = 0, hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < t) lo = mid + 1; else hi = mid; }
  return lo;
}
function lastPair(list, time) {
  let lo = 0, hi = list.length / 2 - 1, result = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid * 2] <= time) { result = mid * 2; lo = mid + 1; } else hi = mid - 1; }
  return result;
}

function analyze(name) {
  const started = performance.now();
  // A fresh window and context per recording isolate caches, prepared entities and globals completely.
  const context = vm.createContext({ window: {} });
  for (const script of scripts) script.runInContext(context);
  new vm.Script(fs.readFileSync(path.join(DATA, `${name}.js`), 'utf8'), { filename: `${name}.js` }).runInContext(context);
  const W = context.window, d = W.REPLAY_DATA?.[name];
  if (!d) throw new Error(`No REPLAY_DATA[${JSON.stringify(name)}]`);
  // Only absent optional fields are normalised; malformed/missing entity tracks remain a per-recording error.
  d.attacks ||= { times: [], pairs: [] }; d.attacks.times ||= []; d.attacks.pairs ||= [];
  d.players ||= []; d.fights ||= []; d.kills ||= []; d.entities ||= [];
  d.duration ??= Math.max(0, ...d.entities.map(e => e.track?.at(-4) || 0));
  const M = W.RV.prepare(d), C = M.combat, F = W.RV_FRAME;
  const players = d.players.map(p => {
    const summaryPlayers = d.summary?.players;
    const summary = Array.isArray(summaryPlayers)
      ? summaryPlayers.find(s => (p.profileId != null && s.profileId === p.profileId) || s.name === p.name || s.idx === p.idx)
      : summaryPlayers?.[p.idx];
    // May is profile 10307814, with a name fallback only if older recordings lack a usable profile id.
    const profileId = summary?.profileId ?? summary?.profile_id ?? null;
    return { idx: p.idx, pid: p.pid ?? null, profileId, name: p.name, civ: p.civ, team: p.team, result: summary?.result ?? null,
      cohort: Number(profileId) === MAY || (profileId == null && /^may$/i.test(p.name || '')) ? 'may' : 'rest' };
  });
  const playerIds = new Set(players.map(p => p.idx));
  const rows = new Map();
  const eligible = e => e && playerIds.has(e.owner) && !['attachment', 'livestock', 'other', 'building'].includes(e.cat);
  function typeOf(e) {
    // Strip tier adjectives/Roman tiers only; civ-specific units and meaningful names (Horse Archer, Warrior Monk) remain distinct.
    return (F.statOf(e.bp)?.n || e.name || W.RV.prettify(e.bp))
      .replace(/^(?:(?:Early|Veteran|Elite|Imperial|Hardened)\s+)+/i, '').replace(/\s+(?:I|II|III|IV|V)$/, '').trim();
  }
  function rowAt(e, t) {
    if (!e || ['attachment', 'livestock', 'other', 'building'].includes(e.cat)) return null;
    const owner = F.ownerAt(e, t);
    if (!playerIds.has(owner)) return null;
    const type = typeOf(e), key = `${owner}|${type}`;
    if (!rows.has(key)) rows.set(key, newRow(type, owner));
    const row = rows.get(key);
    row.siege ||= e.cat === 'siege' || /mangonel|springald|ribauldequin|trebuchet|bombard|culverin|nest.of.bees|hui.hui/i.test(e.bp);
    row.healer ||= e.cat === 'religious' || /monk|imam|scholar|prelate|priest|dervish|shaman/i.test(e.bp);
    return row;
  }
  const addAt = (e, t, key, n = 1) => { const r = rowAt(e, t); if (r) plus(r.totals, key, n); };
  const life = e => {
    const out = [];
    for (let i = 0; i < e.spans.length; i += 2) out.push([Math.max(0, e.spans[i]), Math.min(d.duration, e.spans[i + 1])]);
    return union(out);
  };
  const living = new Map();
  const counted = new Set();
  for (const e of M.ents) {
    if (!eligible(e) && !e.ownT) continue;
    const spans = life(e); living.set(e.id, spans);
    // Unit count is distinct entity-owner pairs; alive seconds and tier exposure split exactly at owner and tier changes.
    for (const [a, b] of spans) {
      const cuts = [...new Set([a, b, ...(e.ownT || []), ...(e.ups || []).map(u => u[0])].filter(t => t >= a && t <= b))].sort((x, y) => x - y);
      for (let i = 1; i < cuts.length; i++) {
        const t = cuts[i - 1], row = rowAt(e, t); if (!row) continue;
        const key = `${e.id}|${row.player}`;
        if (!counted.has(key)) { counted.add(key); plus(row.totals, 'unitCount'); plus(row.tiers, String(W.RV.tierAt(e, t))); plus(row.blueprints, e.bp); }
        plus(row.totals, 'aliveSeconds', cuts[i] - t);
        plus(row.tierAliveSeconds, String(W.RV.tierAt(e, t)), cuts[i] - t);
      }
    }
  }
  const counterCells = new Map(), counterCredits = [], shotCredits = new Map(), countedDirectKills = new Set(), directFightCells = new Set();
  const isPlayerUnit = (e, t) => e && !['building', 'attachment', 'livestock', 'other'].includes(e.cat) && playerIds.has(F.ownerAt(e, t));
  function entityValue(e, t) {
    const cost = F.statsAt(C, e, t)?.st?.cost;
    return e.value || cost?.total || ((cost?.f || 0) + (cost?.w || 0) + (cost?.g || 0) + (cost?.s || 0));
  }
  function counterForTypes(owner, attacker, victim) {
    const key = JSON.stringify([owner, attacker, victim]);
    if (!counterCells.has(key)) counterCells.set(key, newCounterCell(owner, attacker, victim));
    return counterCells.get(key);
  }
  function counterAt(attacker, victim, t) {
    if (!isPlayerUnit(attacker, t) || !isPlayerUnit(victim, t) || C.teamOf(attacker, t) === C.teamOf(victim, t)) return null;
    return counterForTypes(F.ownerAt(attacker, t), typeOf(attacker), typeOf(victim));
  }
  // C.dealt is authoritative damage credit; recorded HP drops are authoritative damage taken.
  for (const [id, credit] of C.dealt) for (let i = 0; i < credit.t.length; i++) addAt(C.byId.get(id), credit.t[i], 'damageDealt', credit.v[i]);
  const killingDrops = new Set();
  for (let k = 0; k < C.dmgT.length; k++) {
    const t = C.dmgT[k], victim = C.byId.get(C.dmgId[k]), amount = C.dmgAmt[k];
    addAt(victim, t, 'damageTaken', amount);
    let sources = C.dmgSrc[k];
    // Match frame.js's one-second fallback and base-stat hit weights, including its dominant-weapon dmgBonus flag.
    if (!sources) {
      const who = new Set(), drop = C.dmgDrop[k];
      for (let i = F.idxAt(C.atkT, drop); i >= 0 && C.atkT[i] > drop - 1; i--) {
        const pairs = C.atkP[i]; for (let j = 1; j < pairs.length; j += 2) if (pairs[j] === victim.id) who.add(pairs[j - 1]);
      }
      sources = [...who].map(id => C.byId.get(id)).filter(Boolean).map(a => ({ a, dtype: { Melee: 'melee', Ranged: 'pierce', Siege: 'siege', Fire: 'fire' }[F.statOf(a.bp)?.main?.damage] || 'melee' }));
    }
    const target = F.statOf(victim.bp);
    const weights = sources.map(bl => hit(null, weapon(F.statOf(bl.a.bp), bl.dtype), null, target));
    const total = weights.reduce((s, n) => s + n, 0);
    for (let j = 0; j < sources.length; j++) {
      const credit = total > 0 ? amount * weights[j] / total : 0;
      if (C.dmgBonus?.[k]) addAt(sources[j].a, t, 'bonusFlagDamage', credit);
      if (C.dmgSplash?.[k]) addAt(sources[j].a, t, 'splashDamage', credit);
      if (isShot(sources[j])) addAt(sources[j].a, t, 'shotDamage', credit);
      const counter = counterAt(sources[j].a, victim, t); if (counter) counter.damage += credit;
      if (counter && credit > 0) counterCredits.push({ source: sources[j], victim, t });
      if (isShot(sources[j])) {
        const item = shotCredits.get(sources[j]) || { damage: 0, victims: new Set() };
        item.damage += credit; if (credit > 0) item.victims.add(victim.id); shotCredits.set(sources[j], item);
      }
    }
    // Killing-drop excess is an ESTIMATE: sum upgraded expected hits minus pre-drop HP, not an observed uncapped damage value.
    const sampleIndex = F.idxAt(victim.t, C.dmgDrop[k]);
    const isKilling = victim.killed && victim.died != null && Math.abs(C.dmgDrop[k] - victim.died) <= .51 && sampleIndex > 0 && victim.hp[sampleIndex] <= 0;
    if (isKilling && sources.length && !killingDrops.has(victim.id)) {
      const expected = sources.map(bl => {
        const sa = F.statsAt(C, bl.a, t), sb = F.statsAt(C, victim, t);
        return sa ? hit(sa, weapon(sa.st, bl.dtype), sb, sb?.st || target) : null;
      });
      if (expected.every(finite)) {
        killingDrops.add(victim.id);
        const sum = expected.reduce((s, n) => s + n, 0), excess = Math.max(0, sum - victim.hp[sampleIndex - 1]);
        for (let j = 0; j < sources.length; j++) {
          addAt(sources[j].a, t, 'estimatedKillingExcessHp', excess * expected[j] / sum);
          addAt(sources[j].a, t, 'estimatedKillingDrops');
        }
      }
    }
  }
  const dropsBySample = new Map();
  for (let k = 0; k < C.dmgT.length; k++) {
    const sampleTime = C.dmgDrop[k], indices = dropsBySample.get(sampleTime) || [];
    indices.push(k); dropsBySample.set(sampleTime, indices);
  }
  const dropsPerUnit = new Map(), targetsBySample = new Map();
  for (const [sampleTime, indices] of dropsBySample) {
    const amounts = new Map(); for (const k of indices) amounts.set(C.dmgId[k], (amounts.get(C.dmgId[k]) || 0) + C.dmgAmt[k]);
    dropsPerUnit.set(sampleTime, amounts);
  }
  for (const blows of C.lists.values()) for (const bl of blows) if (!bl.miss && finite(bl.drop)) {
    const targets = targetsBySample.get(bl.drop) || new Map(), list = targets.get(bl.b.id) || [];
    list.push(bl); targets.set(bl.b.id, list); targetsBySample.set(bl.drop, targets);
  }
  // Empirical falloff counts shot/drop pairs at the SAME recorded HP sample, not retimed landings. Non-attributed drops (especially friendly) are candidates, not proven splash.
  const binEdges = Array.from({ length: 10 }, (_, i) => [i, i + 1]).concat([[10, 12]]);
  for (const shots of C.lists.values()) for (const bl of shots) {
    if (!bl.splash || bl.miss || !finite(bl.drop)) continue;
    const row = rowAt(bl.a, bl.t0); if (!row?.siege) continue;
    const indices = dropsBySample.get(bl.drop) || [];
    const primary = indices.filter(k => C.dmgId[k] === bl.b.id).reduce((sum, k) => sum + C.dmgAmt[k], 0);
    if (!(primary > 0)) continue;
    plus(row.totals, 'landedSplashShots');
    const point = F.locate(bl.b, bl.drop), x = point.x, z = point.z, team = C.teamOf(bl.a, bl.t0);
    for (const [lo, hi] of binEdges) row.splashFalloff[`${lo}-${hi}`] ||= newFalloffBin();
    for (const k of indices) {
      const victim = C.byId.get(C.dmgId[k]), victimTeam = victim && C.teamOf(victim, bl.drop);
      if (!victim || victimTeam == null || !playerIds.has(F.ownerAt(victim, bl.drop)) || ['building', 'attachment', 'livestock', 'other'].includes(victim.cat)) continue;
      const p = F.locate(victim, bl.drop), distance = Math.hypot(p.x - x, p.z - z);
      if (distance > 12) continue;
      const lo = Math.min(10, Math.floor(distance)), key = `${lo}-${lo === 10 ? 12 : lo + 1}`, bin = row.splashFalloff[key], damage = C.dmgAmt[k];
      bin.count++; bin.totalDamage += damage;
      if (victimTeam === team) { bin.friendlyCount++; bin.friendlyDamage += damage; } else bin.enemyCount++;
      if (C.dmgSrc[k]?.includes(bl)) bin.attributedCount++;
      plus(bin.ratioBins, String(round(damage / primary)));
    }
    // Matched control uses SAME landing-bin units at sample t and t-1 s, including zero drops; exclude targets of another landed blow and units not observable/alive at control.
    const landing = dropsPerUnit.get(bl.drop), controlTime = bl.drop - 1, before = dropsPerUnit.get(controlTime);
    for (const victim of M.ents) {
      if (!isPlayerUnit(victim, bl.drop)) continue;
      const landingHp = landing?.get(victim.id) || 0;
      if (!F.alive(victim, bl.drop) && !landingHp) continue;
      const p = F.locate(victim, bl.drop), distance = Math.hypot(p.x - x, p.z - z); if (distance > 12) continue;
      const lo = Math.min(10, Math.floor(distance)), bin = row.splashFalloff[`${lo}-${lo === 10 ? 12 : lo + 1}`];
      const side = bin.control[C.teamOf(victim, bl.drop) === team ? 'friendly' : 'enemy'];
      if ((targetsBySample.get(bl.drop)?.get(victim.id) || []).some(other => other !== bl)) { side.skippedOtherBlow++; continue; }
      if (!F.alive(victim, controlTime) || C.teamOf(victim, controlTime) !== C.teamOf(victim, bl.drop)) { side.skippedNoControl++; continue; }
      const controlHp = before?.get(victim.id) || 0;
      side.units++; side.landingHp += landingHp; side.controlHp += controlHp;
      if (landingHp > 0) side.landingDrops++; if (controlHp > 0) side.controlDrops++;
    }
  }
  const engagements = new Map();
  for (const [id, blows] of C.lists) {
    const e = C.byId.get(id), flags = C.per.get(id) || [], intervals = [], activeIntervals = [];
    // Engaged = alive time covered by an attack flag's 0.5 s window OR the trailing 2*upgraded-period memory after a blow.
    for (let i = 0; i < flags.length; i += 2) intervals.push([flags[i] - .5, flags[i]]);
    let previous = null, previousShot = null;
    for (const bl of blows) {
      const row = rowAt(e, bl.t0), sa = F.statsAt(C, e, bl.t0), period = sa?.period || bl.period || 0;
      intervals.push([bl.t0, bl.t0 + 2 * period]);
      if (period > 0) activeIntervals.push([bl.t0, bl.t0 + period]);
      if (!row) continue;
      const t = row.totals;
      // Blows include melee and shots; wasted is the union of miss:true and landing strictly after a recorded death.
      const shot = isShot(bl);
      plus(t, 'blows'); if (shot) { plus(t, 'shots'); plus(t, bl.shot ? 'projectileShots' : 'instantRangedShots'); }
      if (bl.miss) { plus(t, 'misses'); if (shot) plus(t, 'shotMisses'); }
      const late = bl.b.died != null && (bl.shot ? bl.t1 : bl.t0) > bl.b.died + 1e-6;
      if (late) plus(t, 'afterDeathBlows');
      if (late && shot) plus(t, 'afterDeathShots');
      if (late || bl.miss) plus(t, 'wastedBlows');
      if (bl.guess) plus(t, 'guessedBlows');
      const sb = F.statsAt(C, bl.b, bl.t0), target = sb?.st || F.statOf(bl.b.bp), w = weapon(sa?.st, bl.dtype);
      // Paper is upgraded attack/period; after-armour subtracts matching upgraded victim armour (min 1 HP/blow), both blow-weighted without burst multipliers.
      if (w && sa?.period > 0) {
        plus(t, 'theoreticalDpsSum', attack(sa, w, target) / sa.period); plus(t, 'theoreticalBlows'); sample(row, 'statsPeriodSeconds', sa.period);
        if (target) {
          plus(t, 'armourDpsSum', hit(sa, w, sb, target) / sa.period); plus(t, 'armourBlows');
          plus(t, 'armourPaperDpsSum', attack(sa, w, target) / sa.period);
        }
      }
      // Continuous-engagement cadence accepts consecutive same-owner entity blows on ANY target, with 0 < gap <= 3 later-blow periods; matched period uses statsAt, timing fallback if absent.
      if (previous && F.ownerAt(e, previous.t0) === row.player && period > 0) {
        const gap = bl.t0 - previous.t0;
        if (gap > 0 && gap <= 3 * period) {
          sample(row, 'engagedCadenceSeconds', gap); sample(row, 'engagedCadencePeriodSeconds', period);
          sample(row, 'engagedCadenceToPeriod', gap / period);
        }
      }
      // Same-target runs are consecutive blows on that target, including idle gaps; ratios use the later blow's upgraded period.
      if (previous && previous.b.id === bl.b.id && bl.t0 > previous.t0) {
        sample(row, 'sameTargetCadenceSeconds', bl.t0 - previous.t0);
        if (period > 0) sample(row, 'sameTargetCadenceToPeriod', (bl.t0 - previous.t0) / period);
      }
      if (shot && row.siege) {
        if (period > 0) sample(row, 'siegeStatsPeriodSeconds', period);
        if (w) sample(row, 'siegeStatsBurst', w.burst || 1);
        if (bl.period > 0) sample(row, 'siegeReconstructionPeriodSeconds', bl.period);
        if (previousShot && bl.t0 > previousShot.t0) {
          sample(row, 'siegeShotIntervalSeconds', bl.t0 - previousShot.t0);
          plus(t, 'siegeIntervalObservations');
          if (period > 0 && bl.t0 - previousShot.t0 <= 1.2 * period) plus(t, 'sustainedSiegeShots');
          if (period > 0) sample(row, 'siegeShotIntervalToPeriod', (bl.t0 - previousShot.t0) / period);
        }
        if (!bl.miss && (finite(bl.drop) || bl.kill)) plus(t, 'shotVictims', new Set([bl.b.id, ...(bl.splash?.victims || [])]).size);
        // Splash shots are shots with viewer splash metadata; victims include primary plus distinct secondary victims, even if no secondaries.
        if (bl.splash) { plus(t, 'splashShots'); plus(t, 'splashVictims', new Set([bl.b.id, ...(bl.splash.victims || [])]).size); }
      }
      previous = bl; if (shot) previousShot = bl;
    }
    // Attack-cycle occupancy unions one period after each blow, splitting ownership and clipping to the same alive spans as engaged time.
    const active = union(activeIntervals);
    for (const [a, b] of living.get(id) || life(e)) {
      const cuts = [...new Set([a, b, ...(e.ownT || [])].filter(t => t >= a && t <= b))].sort((x, y) => x - y);
      for (let i = 1; i < cuts.length; i++) addAt(e, cuts[i - 1], 'blowActiveSeconds', overlap(active, cuts[i - 1], cuts[i]));
    }
    engagements.set(id, union(intervals));
  }
  // Attack flags without any reconstructed blow still contribute engaged time and switching/priority observations.
  for (const [id, flags] of C.per) {
    if (!engagements.has(id)) engagements.set(id, union(Array.from({ length: flags.length / 2 }, (_, i) => [flags[2 * i] - .5, flags[2 * i]])));
    const e = C.byId.get(id); let previous = null;
    for (let i = 0; i < flags.length; i += 2) {
      const t = flags[i], row = rowAt(e, t); if (!row) continue;
      // Every observed target change between consecutive attack flags counts, including after an idle gap.
      if (previous && flags[i + 1] !== previous.target) plus(row.totals, 'targetChanges');
      previous = { t, target: flags[i + 1] };
    }
  }
  for (const [id, intervals] of engagements) {
    const e = C.byId.get(id); if (!e) continue;
    for (const [a, b] of living.get(id) || life(e)) {
      const cuts = [...new Set([a, b, ...(e.ownT || [])].filter(t => t >= a && t <= b))].sort((x, y) => x - y);
      for (let i = 1; i < cuts.length; i++) addAt(e, cuts[i - 1], 'engagedSeconds', overlap(intervals, cuts[i - 1], cuts[i]));
    }
  }
  // Counter exposure is value*time while targeting a victim TYPE: union that entity/type's flag windows and 2-period blow memory, then clip alive spans and split owner/tier changes.
  const pairWindows = new Map();
  function addPairWindow(attacker, victim, t, lo, hi) {
    if (!counterAt(attacker, victim, t)) return;
    const types = pairWindows.get(attacker.id) || new Map(), type = typeOf(victim), intervals = types.get(type) || [];
    intervals.push([lo, hi]); types.set(type, intervals); pairWindows.set(attacker.id, types);
  }
  for (const [id, flags] of C.per) {
    const e = C.byId.get(id);
    for (let i = 0; i < flags.length; i += 2) addPairWindow(e, C.byId.get(flags[i + 1]), flags[i], flags[i] - .5, flags[i]);
  }
  for (const blows of C.lists.values()) for (const bl of blows) {
    const period = F.statsAt(C, bl.a, bl.t0)?.period || bl.period || 0;
    addPairWindow(bl.a, bl.b, bl.t0, bl.t0, bl.t0 + 2 * period);
  }
  // Splash-secondary credited victims also get the source blow's engagement window; otherwise their damage would have no type-pair exposure denominator.
  for (const { source, victim, t } of counterCredits) {
    const start = finite(source.t0) ? source.t0 : t - .5, period = F.statsAt(C, source.a, start)?.period || source.period || 0;
    addPairWindow(source.a, victim, t, start, finite(source.t0) ? start + 2 * period : t);
  }
  for (const [id, types] of pairWindows) {
    const e = C.byId.get(id);
    for (const [type, raw] of types) {
      const intervals = union(raw);
      for (const [a, b] of living.get(id) || life(e)) {
        const cuts = [...new Set([a, b, ...(e.ownT || []), ...(e.ups || []).map(u => u[0])].filter(t => t >= a && t <= b))].sort((x, y) => x - y);
        for (let i = 1; i < cuts.length; i++) {
          const t = cuts[i - 1], dt = overlap(intervals, t, cuts[i]), row = rowAt(e, t); if (!row || !dt) continue;
          const cell = counterForTypes(row.player, row.type, type);
          cell.engagedSeconds += dt; cell.valueEngagedSeconds += dt * entityValue(e, t);
        }
      }
    }
  }
  // Inferred volleys group same-entity/same-owner shots no more than 1 s after the group's FIRST shot (not chain-linked); frame.js itself does not expand stats burst counts.
  for (const [id, blows] of C.lists) {
    const e = C.byId.get(id); let current = null, previousStart = null;
    function finishVolley() {
      if (!current) return;
      const row = rowAt(e, current.t); if (!row) return;
      plus(row.totals, 'volleys'); plus(row.totals, 'volleyDamage', current.damage); plus(row.totals, 'volleyVictims', current.victims.size);
      sample(row, 'volleyShots', current.shots);
      if (current.period > 0) sample(row, 'volleyStatsPeriodSeconds', current.period);
      if (previousStart != null) {
        const gap = current.t - previousStart;
        sample(row, 'volleyIntervalSeconds', gap);
        if (current.period > 0) {
          sample(row, 'volleyIntervalToPeriod', gap / current.period);
          if (gap <= 1.2 * current.period) plus(row.totals, 'sustainedVolleys');
        }
      }
      previousStart = current.t;
    }
    for (const bl of blows) {
      if (!isShot(bl) || !rowAt(e, bl.t0)?.siege) continue;
      const owner = F.ownerAt(e, bl.t0);
      if (!current || bl.t0 - current.t > 1 || current.owner !== owner) {
        finishVolley(); current = { t: bl.t0, owner, period: F.statsAt(C, e, bl.t0)?.period || bl.period || 0, shots: 0, damage: 0, victims: new Set() };
      }
      current.shots++;
      const credit = shotCredits.get(bl);
      if (credit) { current.damage += credit.damage; for (const victim of credit.victims) current.victims.add(victim); }
    }
    finishVolley();
  }
  // Priority counts each finite RV_FRAME.effAt attack-pair sample; thresholds are the viewer's exported PRIO_GOOD/PRIO_OK.
  for (let i = 0; i < C.atkT.length; i++) {
    const grades = F.effAt(C, i), pairs = C.atkP[i];
    for (let j = 0; j < grades.length; j++) if (finite(grades[j])) addAt(C.byId.get(pairs[j * 2]), C.atkT[i], grades[j] >= F.PRIO_GOOD ? 'priorityGood' : grades[j] >= F.PRIO_OK ? 'priorityOk' : 'priorityPoor');
  }
  const killDetails = [];
  for (const kill of C.kills) {
    const killer = C.byId.get(kill.killer), victim = C.byId.get(kill.victim);
    addAt(killer, kill.t, 'kills'); if (!victim || !killer) continue;
    addAt(killer, kill.t, 'killsWithVictim');
    let attackers = 0;
    // At death, attacker must be alive, latest target flag must be this victim, and flag or last blow within 2 periods.
    for (const [id, flags] of C.per) {
      const e = C.byId.get(id), index = lastPair(flags, kill.t);
      if (!e || index < 0 || flags[index + 1] !== victim.id || !F.alive(e, kill.t - .001) || C.teamOf(e, kill.t) === C.teamOf(victim, kill.t)) continue;
      const period = F.statsAt(C, e, kill.t)?.period || 0;
      const blows = C.lists.get(id) || [];
      let recent = flags[index] >= kill.t - .5;
      if (!recent) for (let i = blows.length - 1; i >= 0; i--) {
        if (blows[i].t0 > kill.t) continue;
        if (blows[i].t0 < kill.t - 2 * period) break;
        if (blows[i].b.id === victim.id) { recent = true; break; }
      }
      if (recent) attackers++;
    }
    if (attackers >= 3) addAt(killer, kill.t, 'multiAttackerKills');
    const p = F.locate(victim, kill.t - .001);
    killDetails.push({ t: kill.t, x: p.x, z: p.z, team: C.teamOf(killer, kill.t), multi: attackers >= 3 });
  }
  // Kiting: non-siege ranged weapons (including mounted archers), nearest living hostile melee-armed non-siege unit at shot time.
  const melee = M.ents.filter(e => !['building', 'attachment', 'livestock', 'other', 'siege'].includes(e.cat) && F.statOf(e.bp)?.wp?.some(w => w.ty === 'melee'));
  function nearest(e, t) {
    const p = F.locate(e, t), x = p.x, z = p.z; let best = null, distance = Infinity;
    for (const enemy of melee) {
      if (enemy === e || !F.alive(enemy, t) || C.teamOf(enemy, t) == null || C.teamOf(enemy, t) === C.teamOf(e, t)) continue;
      const q = F.locate(enemy, t), dd = Math.hypot(q.x - x, q.z - z);
      if (dd < distance) { best = enemy; distance = dd; }
    }
    return { enemy: best, distance };
  }
  const priorShots = new Map();
  const kitingEvents = [];
  for (const blows of C.lists.values()) for (const bl of blows) {
    if (!isShot(bl)) continue;
    const e = bl.a, row = rowAt(e, bl.t0), sa = F.statsAt(C, e, bl.t0);
    const main = sa?.st.wp?.find(w => w.ty !== 'fire');
    if (!row || row.siege || e.cat === 'villager' || e.cat === 'econ' || !(e.cat === 'ranged' || e.type === 'horsearcher' || main?.ty === 'ranged')) continue;
    const n = nearest(e, bl.t0), p = F.locate(e, bl.t0), x = p.x, z = p.z, t = row.totals;
    plus(t, 'kitingShots'); if (n.enemy) { plus(t, 'nearestMeleeShots'); sample(row, 'nearestEnemyMeleeMetres', n.distance); }
    if (n.distance <= 4) plus(t, 'shotsWithin4m');
    // No melee enemy means infinite separation and counts as beyond own range; unknown range is excluded from that count.
    if (sa?.range > 0 && n.distance > sa.range * TILE_METRES) plus(t, 'shotsBeyondRange');
    const prev = priorShots.get(e.id);
    let moving = false, chaseGain = null;
    if (prev && F.ownerAt(e, prev.t) === F.ownerAt(e, bl.t0)) {
      const displacement = Math.hypot(x - prev.x, z - prev.z);
      sample(row, 'distanceBetweenShotsMetres', displacement);
      // Moving-shot share counts >0.5 m since previous same-owner shot / all ranged shots; first shots have unknown movement (coverage reported).
      plus(t, 'shotMovementObservations'); if (displacement > .5) plus(t, 'shotsMoving');
      moving = displacement > .5;
      // Chasing = previous nearest melee within 8 m moving toward the shooter's shot location over the preceding 0.5 s.
      if (prev.enemy && prev.distance <= 8 && prev.chasing && F.alive(prev.enemy, bl.t0)) {
        const q = F.locate(prev.enemy, bl.t0);
        chaseGain = Math.hypot(q.x - x, q.z - z) - prev.distance;
        sample(row, 'chaseDistanceGainedMetres', chaseGain);
      }
    }
    let chasing = false;
    if (n.enemy && n.distance <= 8 && F.alive(n.enemy, bl.t0 - .5)) {
      const b = F.locate(n.enemy, bl.t0 - .5);
      chasing = Math.hypot(b.x - x, b.z - z) > n.distance + .01;
    }
    priorShots.set(e.id, { t: bl.t0, x, z, enemy: n.enemy, distance: n.distance, chasing });
    kitingEvents.push({ t: bl.t0, x, z, team: C.teamOf(e, bl.t0), moving, nearestMelee: n.distance, chaseGain,
      previous: prev ? { t: prev.t, x: prev.x, z: prev.z } : null });
  }
  const fightWindows = union(d.fights.map(f => [f.start ?? f.t0, f.end ?? f.t1]));
  const healIntervals = new Map();
  for (const h of C.heals) {
    const r = rowAt(h.healer, h.t0); if (!r) continue;
    r.healer = true;
    // Heal events are viewer-inferred episodes. HP during fights is time-prorated because individual heal ticks are not exposed.
    plus(r.totals, 'healEvents'); plus(r.totals, 'hpHealed', h.total);
    const inside = overlap(fightWindows, h.t0, h.t1);
    if (inside > 0) plus(r.totals, 'fightHealEvents');
    plus(r.totals, 'fightHealHp', h.total * (ratio(inside, h.t1 - h.t0) || 0));
    addAt(h.target, h.t0, 'healingReceivedHp', h.total);
    addAt(h.target, h.t0, 'healingReceivedEvents');
    const key = `${h.healer.id}|${r.player}`, item = healIntervals.get(key) || { e: h.healer, owner: r.player, intervals: [] };
    item.intervals.push([h.t0, h.t1]); healIntervals.set(key, item);
  }
  for (const item of healIntervals.values()) {
    const r = rows.get(`${item.owner}|${typeOf(item.e)}`);
    plus(r.totals, 'healingSeconds', seconds(union(item.intervals)));
  }
  function measureFight(a) {
    const { t0, t1, x, z } = a, radius = 1.5 * a.radius;
    const inArea = (px, pz) => Math.hypot(px - x, pz - z) <= radius;
    const winnerTeam = a.lanchester.actual === 'A' ? a.lanchester.A : a.lanchester.actual === 'B' && a.teams.length === 2 ? a.lanchester.B : null;
    const sides = Object.fromEntries(a.teams.map(team => [team, { team, won: winnerTeam == null ? null : team === winnerTeam,
      engagedValue: 0, components: { ...a.rating[team]?.components }, rangedShots: 0, movingNearMeleeShots: 0,
      chaseGains: {}, kills: 0, focusKills: 0 }]));
    const healing = Object.fromEntries(a.teams.map(team => [team, { hpHealed: 0, damageTaken: 0, healShare: null, healers: [] }]));
    const engaged = new Set(), healerPresence = new Set(), directed = new Set();
    function register(e, t) {
      if (!e || !['infantry', 'cavalry', 'ranged', 'siege', 'hero', 'ship', 'unit'].includes(e.cat)) return;
      if (!F.alive(e, t) && !F.alive(e, t - .001)) return;
      const team = C.teamOf(e, t), side = sides[team], key = `${team}|${e.id}`, p = F.locate(e, t);
      if (!side || engaged.has(key) || !inArea(p.x, p.z)) return;
      engaged.add(key);
      side.engagedValue += entityValue(e, t);
    }
    function registerDirect(attacker, victim, t) {
      if (!isPlayerUnit(attacker, t) || !isPlayerUnit(victim, t) || C.teamOf(attacker, t) === C.teamOf(victim, t)) return;
      const p = F.locate(attacker, t), ax = p.x, az = p.z, q = F.locate(victim, t);
      if (inArea(ax, az) && inArea(q.x, q.z)) directed.add(`${attacker.id}|${victim.id}`);
    }
    // Engaged resources count each military entity once per side if attacking/targeted/damaged in the window and 1.5*radius area; no idle nearby army is invented.
    for (let i = firstAtOrAfter(C.atkT, t0); i < C.atkT.length && C.atkT[i] <= t1; i++) {
      const pairs = C.atkP[i];
      for (let j = 0; j + 1 < pairs.length; j += 2) {
        const attacker = C.byId.get(pairs[j]), victim = C.byId.get(pairs[j + 1]);
        register(attacker, C.atkT[i]); register(victim, C.atkT[i]); registerDirect(attacker, victim, C.atkT[i]);
      }
    }
    for (const blows of C.lists.values()) for (const bl of blows) if (bl.t0 >= t0 && bl.t0 <= t1) {
      register(bl.a, bl.t0); register(bl.b, bl.t0);
      registerDirect(bl.a, bl.b, bl.t0);
    }
    // Healing impact is team-wide TEMPORAL: prorate each inferred heal episode by overlap; sum all team HP drops in the same window (no spatial filter).
    for (const h of C.heals) {
      const lo = Math.max(t0, h.t0), hi = Math.min(t1, h.t1), team = C.teamOf(h.healer, lo);
      if (hi > lo && healing[team]) healing[team].hpHealed += h.total * (hi - lo) / (h.t1 - h.t0);
    }
    for (let k = firstAtOrAfter(C.dmgT, t0); k < C.dmgT.length && C.dmgT[k] <= t1; k++) {
      const e = C.byId.get(C.dmgId[k]), team = C.teamOf(e, C.dmgT[k]);
      if (healing[team]) healing[team].damageTaken += C.dmgAmt[k];
      register(e, C.dmgT[k]);
    }
    // A healer is present when alive in the fight area at an endpoint or recorded position in its window; count each owner/type once, not once per monk.
    for (const e of M.ents) {
      if (!(e.cat === 'religious' || /monk|imam|scholar|prelate|priest|dervish|shaman/i.test(e.bp))) continue;
      const times = [t0, t1];
      for (let i = Math.max(0, F.idxAt(e.t, t0)); i < e.t.length && e.t[i] <= t1; i++) if (e.t[i] >= t0) times.push(e.t[i]);
      for (const t of times) {
        if (!F.alive(e, t)) continue;
        const p = F.locate(e, t), team = C.teamOf(e, t), owner = F.ownerAt(e, t), type = typeOf(e), key = `${team}|${owner}|${type}`;
        if (!healing[team] || !inArea(p.x, p.z) || healerPresence.has(key)) continue;
        healerPresence.add(key); healing[team].healers.push({ player: owner, type });
      }
    }
    // Fight kiting requires the shot AND previous shot inside the time/area window; denominator is all ranged shots inside it, numerator moving >0.5 m with melee <=8 m.
    for (const shot of kitingEvents) {
      const side = sides[shot.team];
      if (!side || shot.t < t0 || shot.t > t1 || !inArea(shot.x, shot.z)) continue;
      side.rangedShots++;
      const previousInside = shot.previous?.t >= t0 && inArea(shot.previous.x, shot.previous.z);
      if (previousInside && shot.moving && shot.nearestMelee <= 8) side.movingNearMeleeShots++;
      if (previousInside && finite(shot.chaseGain)) plus(side.chaseGains, String(round(shot.chaseGain)));
    }
    // Focus-fire kill share uses credited known-victim kills in the time/area window, with the same >=3 recent living attackers rule as unit totals.
    for (const kill of killDetails) if (kill.t >= t0 && kill.t <= t1 && inArea(kill.x, kill.z) && sides[kill.team]) {
      sides[kill.team].kills++; if (kill.multi) sides[kill.team].focusKills++;
    }
    for (const [team, side] of Object.entries(sides)) {
      side.components.kitingMovingShare = ratio(side.movingNearMeleeShots, side.rangedShots);
      side.components.kitingChaseGain = distribution(side.chaseGains).median;
      side.components.focusFire = ratio(side.focusKills, side.kills);
      delete side.chaseGains;
      const h = healing[team]; h.healShare = ratio(h.hpHealed, h.damageTaken);
      h.won = side.won;
      for (const healer of h.healers) {
        const row = rows.get(`${healer.player}|${healer.type}`);
        if (row && h.healShare != null) sample(row, 'fightHealShare', h.healShare);
      }
    }
    // Direct exchange requires the SAME two entities attacking one another in this time/area fight; count a credited kill only once across overlapping fights.
    for (const kill of C.kills) {
      const key = `${kill.t}|${kill.killer}|${kill.victim}`;
      if (kill.t < t0 || kill.t > t1 || countedDirectKills.has(key) || !directed.has(`${kill.killer}|${kill.victim}`) || !directed.has(`${kill.victim}|${kill.killer}`)) continue;
      const killer = C.byId.get(kill.killer), victim = C.byId.get(kill.victim), p = F.locate(victim, kill.t - .001);
      if (!inArea(p.x, p.z)) continue;
      const forward = counterAt(killer, victim, kill.t), reverse = counterAt(victim, killer, kill.t);
      if (!forward || !reverse) continue;
      countedDirectKills.add(key);
      const value = entityValue(victim, kill.t);
      forward.killedValue += value; forward.directKills++; reverse.lostValue += value; reverse.directDeaths++;
      for (const cell of [forward, reverse]) {
        const fightKey = JSON.stringify([a.index, cell.player, cell.attacker, cell.victim]);
        if (!directFightCells.has(fightKey)) { directFightCells.add(fightKey); cell.directFights++; }
      }
    }
    const values = Object.values(sides);
    return { healingByTeam: healing, micro: { sides: values, winnerTeam,
      eligible: values.length === 2 && winnerTeam != null && values.every(s => s.engagedValue >= 300) } };
  }
  // Fight metrics are copied from the shared analyser; max swing is max(tug difference)-min(tug difference), including zero.
  const fights = W.RV_FIGHTS.list(d, C).map(entry => {
    const a = W.RV_FIGHTS.analyze(d, C, entry.index), diffs = (a.tug?.series || []).map(r => r[1]);
    const measured = measureFight(a);
    return { index: entry.index, id: entry.id, start: entry.t0, end: entry.t1, duration: entry.duration, x: entry.x, z: entry.z,
      teams: entry.teams, ratings: a.rating, lanchester: { A: a.lanchester.A, B: a.lanchester.B, probabilityA: a.lanchester.p,
        predicted: a.lanchester.predicted, actual: a.lanchester.actual, correct: a.lanchester.correct },
      resourceValueLost: a.lost.total, tugFinalDifference: a.tug?.final?.diff ?? null,
      tugMaxSwing: diffs.length ? Math.max(...diffs) - Math.min(...diffs) : null, tags: a.tags, ...measured };
  });
  // Eco preserves engine status, benchmark provenance, opportunity cost and the capitalized evidence/decision without relabelling modelled values as observed.
  const eco = [...W.RV_ECO.analyze(d, C).players.values()].flatMap(p => p.techs.map(r => ({ player: p.idx, tech: r.id, key: r.key, name: r.name,
    status: r.status, actualTime: r.tActual, benchmarkTime: r.tBench, delaySeconds: r.tBench == null ? null : Math.max(0, (r.tActual ?? p.end) - r.tBench),
    benchmarkSource: r.benchSource, missedResources: r.missed, cost: r.cost, costTotal: r.costTotal, deficit: r.deficit,
    capitalized: r.capitalized, evidenceLabel: r.capitalized?.label ?? null, rateSource: r.rateSource, assumption: r.assumption })));
  const units = [...rows.values()].map(finishRow).sort((a, b) => a.player - b.player || a.type.localeCompare(b.type));
  return { schemaVersion: VERSION, name, duration: d.duration, players, units, map: d.summary?.map?.name ?? null, date: d.summary?.startedAt ?? d.replay?.date ?? null,
    siege: units.filter(r => r.siege),
    healers: units.filter(r => r.healer),
    fights, eco, counters: [...counterCells.values()], runtimeSeconds: (performance.now() - started) / 1000 };
}

function mergeRow(target, row) {
  target.siege ||= row.siege; target.healer ||= row.healer;
  for (const key of ['totals', 'tiers', 'tierAliveSeconds', 'blueprints']) for (const [k, n] of Object.entries(row[key] || {})) plus(target[key], k, n);
  for (const [key, bins] of Object.entries(row.histograms || {})) {
    target.histograms[key] ||= {}; for (const [v, count] of Object.entries(bins)) plus(target.histograms[key], v, count);
  }
  for (const [key, bin] of Object.entries(row.splashFalloff || {})) {
    const dest = target.splashFalloff[key] ||= newFalloffBin();
    for (const field of ['count', 'enemyCount', 'friendlyCount', 'attributedCount', 'totalDamage', 'friendlyDamage']) dest[field] += bin[field] || 0;
    for (const [v, count] of Object.entries(bin.ratioBins || {})) plus(dest.ratioBins, v, count);
    for (const side of ['enemy', 'friendly']) for (const field of ['units', 'landingDrops', 'controlDrops', 'landingHp', 'controlHp', 'skippedOtherBlow', 'skippedNoControl']) dest.control[side][field] += bin.control[side][field] || 0;
  }
}
function counterMatrix(records, cohort) {
  const counts = new Map();
  for (const record of records) for (const row of record.units) counts.set(row.type, (counts.get(row.type) || 0) + row.totals.unitCount);
  // Axes are the 12 most common entity-owner unit types across this dataset, unchanged between player cohorts; all 144 ordered cells are retained.
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12), types = ranked.map(([type]) => type), cells = new Map();
  for (const attacker of types) for (const victim of types) cells.set(JSON.stringify([attacker, victim]), newCounterCell(null, attacker, victim));
  for (const record of records) {
    const ids = new Set(record.players.filter(p => cohort === 'all' || p.cohort === cohort).map(p => p.idx));
    for (const row of record.counters || []) {
      const cell = cells.get(JSON.stringify([row.attacker, row.victim]));
      if (!cell || !ids.has(row.player)) continue;
      for (const field of ['damage', 'valueEngagedSeconds', 'engagedSeconds', 'killedValue', 'lostValue', 'directKills', 'directDeaths', 'directFights']) cell[field] += row[field] || 0;
    }
  }
  // Cost-normalized rate = credited HP * (100 resources * 60 s/min) / summed attacker resource-seconds against this victim type; direct exchange ratio is credited kill value / own lost value, null with no loss.
  return { types, unitCounts: Object.fromEntries(ranked), cells: [...cells.values()].map(cell => ({ ...cell,
    damagePer100ResourcesPerEngagedMinute: ratio(cell.damage * 6000, cell.valueEngagedSeconds),
    killValuePerResourceLost: ratio(cell.killedValue, cell.lostValue) })) };
}

function aggregate(records) {
  const result = { schemaVersion: VERSION, recordings: records.map(r => ({ name: r.name, runtimeSeconds: r.runtimeSeconds, players: r.players, map: r.map, date: r.date })), cohorts: {} };
  for (const cohort of ['all', 'may', 'rest']) {
    const rows = new Map(), scores = newRow('fight ratings', null), techs = new Map();
    let fights = 0, decided = 0, correct = 0, brierSum = 0, brierCount = 0, playerGames = 0;
    let mmrSum = 0, mmrCount = 0;
    const letters = {}, tagCounts = {};
    const healingOutcomes = Object.fromEntries(['high', 'low'].map(key => [key, { n: 0, wins: 0, withHealersN: 0, withHealersWins: 0 }]));
    for (const record of records) {
      const selected = record.players.filter(p => cohort === 'all' || p.cohort === cohort), ids = new Set(selected.map(p => p.idx));
      playerGames += selected.length;
      // Mean MMR weights each known player-recording once; missing harvest ratings do not become zero.
      for (const p of selected) if (finite(p.mmr)) { mmrSum += p.mmr; mmrCount++; }
      for (const row of record.units || []) if (ids.has(row.player)) {
        if (!rows.has(row.type)) rows.set(row.type, newRow(row.type, null)); mergeRow(rows.get(row.type), row);
      }
      for (const fight of record.fights || []) {
        const teams = new Set(selected.map(p => p.team));
        if (!fight.teams?.some(tm => teams.has(tm))) continue;
        fights++;
        for (const [team, r] of Object.entries(fight.ratings || {})) if (teams.has(+team) && r?.score != null) {
          sample(scores, 'score', r.score); plus(letters, r.letter);
          for (const [key, value] of Object.entries(r.components || {})) if (value != null) sample(scores, key, value);
        }
        // Lanchester accuracy counts each eligible decided fight once per cohort, not once per player; draws/unavailable predictions are excluded.
        const l = fight.lanchester;
        if (typeof l?.correct === 'boolean') { decided++; if (l.correct) correct++; }
        if (finite(l?.probabilityA) && ['A', 'B'].includes(l.actual)) { brierSum += (l.probabilityA - (l.actual === 'A' ? 1 : 0)) ** 2; brierCount++; }
        for (const tag of fight.tags || []) plus(tagCounts, tag.tag);
        // Heal-outcome groups include decided sides with known damage >0; additionally retain the subset with a healer present in the fight area.
        for (const [team, h] of Object.entries(fight.healingByTeam || {})) if (teams.has(+team) && h.healShare != null && typeof h.won === 'boolean') {
          const group = healingOutcomes[h.healShare >= .1 ? 'high' : 'low'];
          group.n++; if (h.won) group.wins++;
          if (h.healers.length) { group.withHealersN++; if (h.won) group.withHealersWins++; }
        }
      }
      for (const tech of record.eco || []) if (ids.has(tech.player)) {
        if (!techs.has(tech.tech)) techs.set(tech.tech, { tech: tech.tech, rows: 0, eligible: 0, skipped: 0, delayed: 0, missedSum: 0, deficitSum: 0, delaySum: 0, capitalized: 0, capitalizedApplicable: 0, statuses: {}, evidenceLabels: {} });
        const t = techs.get(tech.tech); t.rows++; plus(t.statuses, tech.status);
        // Eco skip/delay rates exclude na/no benchmark; missed mean includes eligible on-time zeroes; capitalized share uses applies:true decisions only.
        if (tech.status !== 'na' && tech.benchmarkTime != null) {
          t.eligible++; t.skipped += tech.status === 'never' ? 1 : 0; t.delayed += tech.status === 'late' ? 1 : 0;
          t.missedSum += tech.missedResources || 0; t.deficitSum += tech.deficit || 0; t.delaySum += tech.delaySeconds || 0;
        }
        if (tech.capitalized?.applies) { t.capitalizedApplicable++; if (tech.capitalized.yes) t.capitalized++; }
        if (tech.evidenceLabel) plus(t.evidenceLabels, tech.evidenceLabel);
      }
    }
    const units = [...rows.values()].map(finishRow).sort((a, b) => (b.totals.damageDealt || 0) - (a.totals.damageDealt || 0));
    result.cohorts[cohort] = { playerGames, meanMmr: ratio(mmrSum, mmrCount), mmrCount, units, siege: units.filter(r => r.siege), healers: units.filter(r => r.healer), counterMatrix: counterMatrix(records, cohort),
      fights: { count: fights, ratings: Object.fromEntries(Object.entries(scores.histograms).map(([k, bins]) => [k, distribution(bins)])), letters,
        lanchester: { decided, correct, accuracy: ratio(correct, decided), brier: ratio(brierSum, brierCount) }, tags: tagCounts,
        healingOutcomes: Object.fromEntries(Object.entries(healingOutcomes).map(([key, g]) => [key, { ...g, winRate: ratio(g.wins, g.n), withHealersWinRate: ratio(g.withHealersWins, g.withHealersN) }])) },
      eco: [...techs.values()].map(t => ({ ...t, skipRate: ratio(t.skipped, t.eligible), delayRate: ratio(t.delayed, t.eligible),
        meanMissedResources: ratio(t.missedSum, t.eligible), meanDeficit: ratio(t.deficitSum, t.eligible), meanDelaySeconds: ratio(t.delaySum, t.eligible),
        capitalizedShare: ratio(t.capitalized, t.capitalizedApplicable) })) };
  }
  return result;
}

function microCalibration(records) {
  const keys = ['priority', 'overkill', 'uptime', 'splash', 'kitingMovingShare', 'kitingChaseGain', 'focusFire'];
  const states = Object.fromEntries(keys.map(key => [key, { bins: {}, higherWins: 0, n: 0, ties: 0, count: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 }]));
  for (const record of records) for (const fight of record.fights || []) {
    const micro = fight.micro;
    if (!micro) continue;
    // Percentiles include every finite fight/team component, even small/undecided fights; each side-fight is one observation.
    for (const side of micro.sides) for (const key of keys) {
      const value = side.components[key];
      if (finite(value)) plus(states[key].bins, String(round(value)));
    }
    if (!micro.eligible || micro.sides.length !== 2) continue;
    const [a, b] = micro.sides;
    for (const key of keys) {
      const x = a.components[key], y = b.components[key], state = states[key];
      if (!finite(x) || !finite(y)) continue;
      // Higher-value win rate excludes ties, requires both sides >=300 unique engaged resources and a decided two-team winner.
      if (Math.abs(x - y) > 1e-9) { state.n++; if ((x > y ? a : b).won) state.higherWins++; } else state.ties++;
      // Point-biserial is Pearson(component, won 0/1), using both finite sides of each eligible fight, including component ties.
      for (const side of [a, b]) {
        const v = side.components[key], win = side.won ? 1 : 0;
        state.count++; state.sx += v; state.sy += win; state.sxx += v * v; state.syy += win * win; state.sxy += v * win;
      }
    }
  }
  return Object.fromEntries(keys.map(key => {
    const s = states[key], d = distribution(s.bins), covariance = s.count * s.sxy - s.sx * s.sy;
    const variance = (s.count * s.sxx - s.sx * s.sx) * (s.count * s.syy - s.sy * s.sy);
    return [key, { p10: d.p10, p25: d.p25, p50: d.p50, p75: d.p75, p90: d.p90,
      winRateHigher: ratio(s.higherWins, s.n), n: s.n, corr: variance > 0 ? Math.max(-1, Math.min(1, covariance / Math.sqrt(variance))) : null,
      nValues: d.n, higherWins: s.higherWins, ties: s.ties, corrN: s.count }];
  }));
}

function writeViewerBenchmark(a) {
  const grouped = new Map();
  for (const row of a.cohorts.all.units) {
    // type is already tier-stripped by typeOf; lowercasing preserves internal spaces and hyphens. Merge case-equivalent names before applying the population cutoff.
    const key = row.type.toLowerCase();
    if (!grouped.has(key)) grouped.set(key, newRow(key, null));
    mergeRow(grouped.get(key), row);
  }
  const rows = [...grouped].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, row]) => finishRow(row)).filter(row => row.totals.unitCount >= 20);
  const units = {}, siege = {}, splash = {}, heal = {};
  for (const row of rows) {
    const key = row.type, m = row.metrics, d = row.distributions;
    // Browser metrics use the all-player aggregate definitions above; period is the cadence-matched median, falling back to all-blow stats when no eligible gap exists.
    units[key] = { n: row.totals.unitCount, paperDps: m.theoreticalDps, afterArmourDps: m.armourAdjustedDps,
      effDps: m.effectiveDps, uptime: m.uptimeShare, waste: m.wasteBlowShare,
      intervalMedian: d.engagedCadenceSeconds?.median ?? null, period: d.engagedCadencePeriodSeconds?.median ?? d.statsPeriodSeconds?.median ?? null,
      armourMitigation: m.armourMitigationShare, excessShare: m.killingExcessShare, postDeathShotsPerKill: m.postDeathShotsPerKill,
      switchesPerMin: m.targetChangesPerEngagedMinute, priorityGood: m.priorityShares.good };
    if (row.siege) siege[key] = { volleyMedian: d.volleyIntervalSeconds?.median ?? null, period: d.siegeStatsPeriodSeconds?.median ?? null,
      victimsPerVolley: m.victimsPerVolley, hpPerVolley: m.damagePerVolley };
    if (row.healer) heal[key] = { hpPerSec: m.hpPerHealingSecond, hpPerAliveMin: m.healingPerAliveMinute };
    // Browser mangonel falloff is ENEMY landing-minus-matched-control probability and unconditional HP/unit, not friendly-fire evidence or a damage formula.
    if (key === 'mangonel') splash.mangonel = Object.entries(row.splashFalloff).map(([bin, value]) => {
      const [r0, r1] = bin.split('-').map(Number);
      return { r0, r1, excessP: value.control.enemy.excessDropProbability, excessHp: value.control.enemy.excessMeanHp };
    }).sort((a, b) => a.r0 - b.r0);
  }
  const bench = { source: { recordings: a.recordings.length, mayGames: a.gameRecordingCounts.mayGames,
    restGames: a.gameRecordingCounts.restGames, meanMmr: a.cohorts.all.meanMmr, generated: new Date().toISOString().slice(0, 10) },
    units, siege, splash, heal };
  const header = [
    '// Generated by tools/analyze_rlogs.mjs; all-player aggregates, n >= 20, numbers rounded to 3 significant digits.',
    String.raw`// Normaliser: name.replace(/^(?:(?:Early|Veteran|Elite|Imperial|Hardened)\s+)+/i, '').replace(/\s+(?:I|II|III|IV|V)$/, '').trim().toLowerCase(); preserve internal spaces/hyphens.`,
  ].join('\n');
  // Fixed field order and lexical type / numeric distance order make the export deterministic for the same aggregate and UTC date; nonfinite/absent metrics remain null.
  const json = JSON.stringify(bench, (_key, value) => typeof value === 'number' ? finite(value) ? Number(value.toPrecision(3)) : null : value ?? null);
  const text = `${header}\nwindow.RV_BENCH = ${json};\n`, bytes = Buffer.byteLength(text);
  if (bytes >= 40000) throw new Error(`viewer/rv_bench.js exceeds the 40 KB limit (${bytes} bytes)`);
  fs.writeFileSync(path.join(ROOT, 'viewer/rv_bench.js'), text);
  log(`Benchmark: viewer/rv_bench.js; ${bytes} bytes; ${rows.length} unit types`, true);
}

const definitions = [
  'Scope: player-owned non-building units; entity-owner counts split conversions. Alive seconds union recorded visibility spans, clipped to replay duration. Tier counts use first ownership tier; tier seconds include upgrades. Names ignore tier adjectives/Roman suffixes, not civ-specific unit identities.',
  'Blows = all viewer-reconstructed attacks. Shots include bl.shot projectiles AND non-torch pierce/ranged-category/horse-archer blows (crossbow/gun zero-flight attacks are instantaneous shots); projectileShots/instantRangedShots separate these. Misses/guesses use viewer flags. Kills use C.kills; dealt uses C.dealt; taken sums recorded HP drops; no invented credit.',
  'Bonus share = credited damage on drops with C.dmgBonus=1 / dealt; this is a dominant-weapon bonus flag, NOT the fraction of HP attributable to a bonus. Attribution repeats frame.js base-hit weights/fallback. Splash share uses C.dmgSplash / dealt.',
  'Theoretical DPS = blow-weighted mean of upgraded (weapon attack + matching target class/unit bonuses) / statsAt.period, before armour, without burst multiplier. Unknown stats excluded. Effective DPS = dealt / engaged unit-seconds; ratio divides by theoretical mean.',
  'Armour-adjusted DPS = blow-weighted max(1, upgraded attack + applicable bonuses - upgraded victim armour of matching damage type)/period; unknown victim stats excluded. Effective/after-armour divides effective DPS by that mean. Armour mitigation=1-summed after-armour DPS/summed paper DPS using the SAME known-victim blows and target mix.',
  'Unit uptime = union of [blow, blow+period] attack-cycle seconds / engaged seconds, clipped to alive spans and split by owner (timing-period fallback if stats absent). This inferred cycle occupancy is not measured animation time. 1-waste uses unioned missed/post-death blows; killing-excess share is estimated excess HP/dealt.',
  'DPS factors diagnose, but need not multiply exactly to effective DPS: burst/splash, blow-weighted victim mix, attribution and recorded cadence differ from paper assumptions. DPS/kiting/switching tables pool selected players; JSON also retains complete May/rest splits.',
  'Engaged seconds = alive intersection with union of [attack flag-0.5, flag] and [blow, blow+2 upgraded periods (timing fallback if unknown)]. Overlap is counted once per entity; ownership splits time. Same-target cadence uses consecutive blows on same target including idle gaps; gap/period uses the later blow period.',
  'Attack-cadence table uses consecutive blows by the same entity and owner on ANY target, accepting only positive gaps <=3 later-blow periods as continuous engagement. Periods are statsAt (reconstruction timing fallback if absent). Pool eligible gaps and their matched periods for p25/median/p75; median/period divides median gap by median matched period, not median individual ratios (also in JSON). Top 10 types rank by all blows; May/rest medians pool their own eligible observations.',
  'Waste = union of miss:true blows and blows landing strictly after target died; shares divide by all blows. Post-death shots/kill=shots landing strictly after a known death / credited kills (not all misses, null with no kills). Estimated killing excess=max(0, summed upgraded expected hits after armour-pre-drop HP), apportioned by expected hit; requires recorded zero-HP killing drop. Excess/dealt is estimated, not observed uncapped damage.',
  'Multi-attacker kill share: credited kills with known victim where >=3 living hostile attackers last targeted victim, with a flag in previous 0.5 s or blow in previous 2 periods; denominator is credited kills with a known victim.',
  'Target switches = changes between consecutive attack flags, including after idle gaps; divide by engaged minutes. Priority distribution counts finite attack-pair effAt scores: good >= PRIO_GOOD (0.8), ok >= PRIO_OK (0.4), poor below.',
  'Priority good/ok/poor shares divide each grade count by all finite graded attack-pair samples; ungraded pairs do not become poor.',
  'Kiting covers non-siege ranged-category, horse-archer, or primary-ranged-weapon units (including instantaneous crossbow/gun shots, excluding villagers hunting with a secondary bow). Movement is straight-line displacement between consecutive same-owner shots. Nearest melee is living hostile non-siege with a melee weapon; centre distances are metres. Stats ranges are tiles x4.',
  'Kiting shares divide by ranged shots: nearest melee <=4 m; separation > shooter own range (no melee counts as infinite). Unknown range cannot count beyond-range; nearest-observed share reports coverage. Distance distributions exclude absent melee.',
  'Moving-shot share = shots displaced >0.5 m since previous same-owner shot / all ranged shots; first shots are unobserved movement, not positive. Movement-observed share gives the fraction with a previous shot.',
  'Chase gain = separation at next shot minus previous separation to SAME melee enemy, if previous distance <=8 m and enemy moved toward the previous shot location by >0.01 m in preceding 0.5 s; enemy must survive next shot. This is an inferred chase, not a recorded order.',
  'Siege intervals use consecutive shots by same entity, regardless of target or idle gap; compare gap/later-shot stats period; siegeStatsPeriodSeconds samples each shot period. Splash shot has viewer splash metadata; victims/shot includes primary plus distinct secondaries, even if none. Siege miss share = missed shots / shots.',
  'Siege sustained-fire share = shots with previous same-unit shot gap <=1.2 later-shot periods / all shots; interval-conditioned share is separate. Inferred volleys group same-owner entity shots within 1 s of FIRST shot, not chaining; cadence is start-to-start with pooled p25/median/p75 and later period ratios. Sustained volley share applies the same 1.2-period rule / all volleys (first cannot qualify); shots/volley=shots/volleys. Victims/volley unions credited positive-HP victims; HP/volley sums source-attributed HP; coverage=volley HP/credited shot HP. Stats burst and reconstruction periods sample every shot; frame.js does not expand burst counts, so rapid pulses are not proof of projectile bursts.',
  'Splash matched control: for each landed splash shot with a primary drop, bin ALL player units by landing position [0,1),...,[9,10),[10,12] m. Enemy/friendly unit samples require alive at landing (or its killing drop), alive 1 s earlier, unchanged team, and no OTHER non-missed blow targeting that unit at landing sample. Keep skip counts. Compare the SAME units sampled exactly 1 s earlier, wherever they were; probability=positive HP-drop samples/n, mean HP=all HP drops/n including zeroes (conditional mean divides by positive drops), excess=landing minus control.',
  'Friendly positive excess is POSSIBLE friendly fire, not proof: unrelated area damage and time trends remain. Enemy excess is likewise descriptive, not a measured damage formula. JSON retains raw same-sample shot/drop counts, median HP/primary-drop ratios, attribution counts and friendly co-damage share; these are confounded by armour, HP caps and other attackers.',
  'Healing uses C.heals inferred episodes (not regeneration): events, HP sum, HP / unioned per-healer healing seconds, and HP / healer alive-minutes. Received HP/events group by target type. Fight-event share requires temporal overlap; fight HP is time-prorated over union of d.fights windows, with no spatial filter.',
  'Per-fight healing impact prorates C.heals by temporal window overlap, team-wide, and divides by same-window team HP drops (also team-wide, no area filter). A healer type is present if alive inside 1.5*radius at a window endpoint or recorded position; typical share is median side-fight heal share where that owner/type is present. Win groups >=10% vs <10% exclude zero-damage/undecided sides; counts include all sides plus healer-present subset.',
  'Fights copy RV_FIGHTS outputs: per-team 0-100 score/components, Lanchester P(A)/prediction/actual/correct, recorded resource losses, tags. Tug final = side A killed value minus others; max swing = max difference - min difference including initial zero. Overlapping fights can share losses.',
  'Viewer fight priority is mean target efficiency; overkill is 1-min(1,wasteShare/0.20) using calibrated killing surplus/dead-target shots; uptime normalises flags by 0.75/period, value-time weighted (ranged preferred); splash is multi-victim shot share/0.25 capped. Weights 35/25/25/15%, renormalised for absent components.',
  'Calibration preserves four viewer components per fight/team; kitingMovingShare = ranged shots moving >0.5 m with nearest melee <=8 m / ranged shots inside time and 1.5*radius area, requiring previous shot also inside; kitingChaseGain is median eligible chase gain; focusFire = >=3-attacker credited kills / credited known-victim kills in area/window.',
  'Micro calibration percentiles use all finite side-fight values. Higher-component win rate uses decided two-team fights with both sides >=300 unique military value attacking/targeted/damaged in area/window, excludes component ties (n), and needs both finite components. Corr is point-biserial Pearson(value,win) over those paired sides including ties (corrN); descriptive, not causal or independent observations. Output: micro_calibration.json.',
  'Lanchester uses upgraded DPS vs enemy mix x current HP at fight start, P(A)=logistic(log(powerA/powerB)/1.5), bounded .01-.99; outcome is lower army+villager value loss (within 10% draws). Accuracy excludes draws/null; Brier is mean squared probability error on decided A/B fights.',
  'Eco copies RV_ECO: ontime/late/never/na; completion actual vs opponent-start-adjusted or own-age benchmark. Missed = delayed gatherer-seconds x base rate x incremental multiplier (Wheelbarrow trip model); never integrates to replay end. Deficit = missed - cost.',
  'Eco capitalized/evidence copies engine decision: constrained bank plus military spending AND tempo-window combat impact; not causal proof. Skip=never/eligible; delay=late/eligible (never separate); eligible excludes na/no benchmark. Mean missed/deficit/delay includes eligible on-time zeroes; capitalized share uses applies:true.',
  'Aggregation sums counts/time/HP and recomputes ratios; theoretical is blow-weighted, distributions pool observation-weighted 0.001-unit histograms with interpolated p10/p25/p50/p75/p90. May=profile 10307814 (name only if id absent); rest=other player sides. Fight cohorts count participating fights once, ratings only selected teams. viewer/rv_bench.js exports all-player types with >=20 entity-owner units, lowercase tier-stripped keys (normaliser in header), sorted type/bin keys, numbers to 3 significant digits, missing metrics null and UTC generation date. Unit period is cadence-matched median with all-blow stats fallback; mangonel splash is enemy matched-control excess.',
  'Counter matrix: top 12 types by summed entity-owner count; ordered attacker/victim cells sum frame-weighted credited HP. Denominator sums attacker unit resource value x pair-type engaged seconds (union flag/blow windows plus credited splash victims, alive/owner/tier split); rate=HP*6000/resource-seconds. Different victim-type windows may overlap after switches. Direct K/L requires reciprocal SAME-ENTITY attacks inside the same fight time and 1.5*radius area; each credited kill counted once across overlapping fights, directFights counts windows with such a kill/death for this cell. Resource value=recorded entity value or stats cost; zero-loss ratios are null. Game cohorts partition all participants into May games vs no-May games.',
  'Dataset default includes exactly two-player recordings; --all includes other counts. Exclusions listed. MMR/map/date join harvest/aoe4.db read-only by game id; profile id comes ONLY from d.summary profile fields or DB, never replay command pid. DB slot matches profile, exact name, unique civ, then two-player order. May name fallback applies only without profile id. Mean MMR averages known player-recordings without zeroes.',
  'Missing data: unknown ratios/quantiles are null; empty counters show zero in tables. Older absent optional collections become empty; failed recordings log once and do not stop batch. All compatible per-recording JSON files feed dataset selection, including cached/unselected recordings; failed selected names are excluded this run.',
];
const fmt = n => n == null || !finite(n) ? '—' : Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-US') : Number(n.toFixed(2)).toString();
const pct = n => !finite(n) ? '—' : `${fmt(n * 100)}%`;
const cell = text => String(text ?? '').replace(/\|/g, '/').replace(/[\r\n]/g, ' ');
function summary(a) {
  const all = a.cohorts.all, may = a.cohorts.may, rest = a.cohorts.rest;
  const lines = ['# Replay batch analysis', '',
    `Recordings: ${a.recordings.length} (${a.gameRecordingCounts.mayGames} May games; ${a.gameRecordingCounts.restGames} rest). Mean MMR: ${fmt(all.meanMmr)} (${all.mmrCount}/${all.playerGames} player-games known); May ${fmt(may.meanMmr)}, rest ${fmt(rest.meanMmr)}.`,
    `Excluded (${includeAll ? '--all enabled' : 'not exactly 2 players'}): ${a.excludedRecordings.length ? a.excludedRecordings.map(r => `${cell(r.name)} (${r.players} players)`).join(', ') : 'none'}.`,
    'JSON contains every type/cohort; tables cap 4 DPS, 10 attack cadence/composition, 2 kiting/switching/unit comparisons, 6 siege, 4 falloff, 3 healers, 10 counter pairs. Components and calibration: micro_calibration.json.', '',
    '| Recording | Seconds | Players (MMR) |', '|---|---:|---|',
    ...a.recordings.slice(0, 4).map(r => `| ${cell(r.name)} | ${fmt(r.runtimeSeconds)} | ${r.players.map(p => `${cell(p.name)} (${fmt(p.mmr)})`).join(' vs ')} |`)];
  if (a.recordings.length > 4) lines.push(`| ${a.recordings.length - 4} more (see aggregate.json) | | |`);
  lines.push('', '## DPS decomposition', '| Type | Paper | After armour | ×uptime | ×(1−waste) | Effective | Effective/after-armour | Excess/dealt (est.) |', '|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of all.units.filter(r => r.totals.blows > 0).slice(0, 4)) {
    const m = r.metrics;
    lines.push(`| ${cell(r.type)} | ${fmt(m.theoreticalDps)} | ${fmt(m.armourAdjustedDps)} | ${pct(m.uptimeShare)} | ${pct(m.wasteBlowShare == null ? null : 1 - m.wasteBlowShare)} | ${fmt(m.effectiveDps)} | ${fmt(m.effectiveToArmourAdjusted)} | ${pct(m.killingExcessShare)} |`);
  }
  lines.push('', '## Attack cadence and damage composition', '| Type | Interval p25 / median / p75 (s) | Period (s) | Median/period | Armour mitigation | Bonus-flagged share | Excess/dealt (est.) | Post-death shots/kill | May / rest interval median (s) | May / rest excess/dealt | May / rest post-death shots/kill |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of all.units.filter(r => r.totals.blows > 0).sort((a, b) => b.totals.blows - a.totals.blows || a.type.localeCompare(b.type)).slice(0, 10)) {
    const gap = r.distributions.engagedCadenceSeconds, m = may.units.find(x => x.type === r.type), o = rest.units.find(x => x.type === r.type);
    lines.push(`| ${cell(r.type)} | ${fmt(gap?.p25)} / ${fmt(gap?.median)} / ${fmt(gap?.p75)} | ${fmt(r.distributions.engagedCadencePeriodSeconds?.median)} | ${fmt(r.metrics.cadenceMedianToPeriod)} | ${pct(r.metrics.armourMitigationShare)} | ${pct(r.metrics.bonusDamageShare)} | ${pct(r.metrics.killingExcessShare)} | ${fmt(r.metrics.postDeathShotsPerKill)} | ${fmt(m?.distributions.engagedCadenceSeconds?.median)} / ${fmt(o?.distributions.engagedCadenceSeconds?.median)} | ${pct(m?.metrics.killingExcessShare)} / ${pct(o?.metrics.killingExcessShare)} | ${fmt(m?.metrics.postDeathShotsPerKill)} / ${fmt(o?.metrics.postDeathShotsPerKill)} |`);
  }
  lines.push('', '## Kiting', '| Ranged type | Shots | Melee ≤4 m | Chase gain median (m/cycle) | Shots moving >0.5 m |', '|---|---:|---:|---:|---:|');
  for (const r of all.units.filter(r => r.totals.kitingShots > 0).slice(0, 2)) {
    lines.push(`| ${cell(r.type)} | ${r.totals.kitingShots} | ${pct(r.metrics.shotWithin4mShare)} | ${fmt(r.distributions.chaseDistanceGainedMetres?.median)} | ${pct(r.metrics.movingShotShare)} |`);
  }
  lines.push('', '## Target switching', '| Type | Switches/engaged-min | Priority good | Priority ok | Priority poor |', '|---|---:|---:|---:|---:|');
  for (const r of all.units.filter(r => r.totals.blows > 0).slice(0, 2)) {
    const p = r.metrics.priorityShares;
    lines.push(`| ${cell(r.type)} | ${fmt(r.metrics.targetChangesPerEngagedMinute)} | ${pct(p.good)} | ${pct(p.ok)} | ${pct(p.poor)} |`);
  }
  lines.push('', '## Units (May player vs other players)', '| Type | May n / rest n | May damage / rest | May effective DPS / rest |', '|---|---:|---:|---:|');
  for (const r of all.units.slice(0, 2)) {
    const m = may.units.find(x => x.type === r.type), o = rest.units.find(x => x.type === r.type);
    lines.push(`| ${cell(r.type)} | ${m?.totals.unitCount || 0} / ${o?.totals.unitCount || 0} | ${fmt(m?.totals.damageDealt ?? 0)} / ${fmt(o?.totals.damageDealt ?? 0)} | ${fmt(m?.metrics.effectiveDps)} / ${fmt(o?.metrics.effectiveDps)} |`);
  }
  lines.push('', '## Splash falloff (matched 1 s control)', '| Siege type | Enemy bin m → n:excess P:excess HP | Friendly bin m → n:excess P:excess HP (possible FF, not proof) |', '|---|---|---|');
  for (const r of all.siege.filter(r => Object.keys(r.splashFalloff).length).slice(0, 4)) {
    const bins = Object.entries(r.splashFalloff);
    const show = side => bins.map(([key, b]) => `${key}: ${b.control[side].units}:${pct(b.control[side].excessDropProbability)}:${fmt(b.control[side].excessMeanHp)}`).join('; ');
    lines.push(`| ${cell(r.type)} | ${show('enemy')} | ${show('friendly')} |`);
  }
  lines.push('', '## Siege shot and inferred-volley cadence', '| Type | Shots / volleys | Shot gap median (s) | Volley gap p25 / median / p75 (s) | Stats period (s) | Shots/volley | Victims/volley | HP/volley |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of all.siege.slice(0, 6)) {
    const gap = r.distributions.volleyIntervalSeconds, period = r.distributions.siegeStatsPeriodSeconds?.median;
    lines.push(`| ${cell(r.type)} | ${r.totals.shots} / ${r.totals.volleys} | ${fmt(r.distributions.siegeShotIntervalSeconds?.median)} | ${fmt(gap?.p25)} / ${fmt(gap?.median)} / ${fmt(gap?.p75)} | ${fmt(period)} | ${fmt(r.metrics.shotsPerVolley)} | ${fmt(r.metrics.victimsPerVolley)} | ${fmt(r.metrics.damagePerVolley)} |`);
  }
  lines.push('', '## Counter performance', '| Attacker → victim | HP/100 res/engaged-min | May / rest | Direct killed / lost res | Direct K/L |', '|---|---:|---:|---:|---:|');
  const mayCounters = new Map(may.counterMatrix.cells.map(r => [JSON.stringify([r.attacker, r.victim]), r])), restCounters = new Map(rest.counterMatrix.cells.map(r => [JSON.stringify([r.attacker, r.victim]), r]));
  for (const r of all.counterMatrix.cells.filter(r => r.damage > 0).sort((a, b) => b.damage - a.damage).slice(0, 10)) {
    const key = JSON.stringify([r.attacker, r.victim]);
    lines.push(`| ${cell(r.attacker)} → ${cell(r.victim)} | ${fmt(r.damagePer100ResourcesPerEngagedMinute)} | ${fmt(mayCounters.get(key)?.damagePer100ResourcesPerEngagedMinute)} / ${fmt(restCounters.get(key)?.damagePer100ResourcesPerEngagedMinute)} | ${fmt(r.killedValue)} / ${fmt(r.lostValue)} | ${fmt(r.killValuePerResourceLost)} |`);
  }
  lines.push('', '## Healing impact', '| Healer type | HP/s healing | HP/healer alive-min | Typical fight heal share | Side-fights with healer |', '|---|---:|---:|---:|---:|');
  for (const r of all.healers.slice(0, 3)) {
    const h = r.distributions.fightHealShare;
    lines.push(`| ${cell(r.type)} | ${fmt(r.metrics.hpPerHealingSecond)} | ${fmt(r.metrics.healingPerAliveMinute)} | ${pct(h?.median)} | ${h?.n || 0} |`);
  }
  lines.push('', '## Healing and fight outcomes', '| Heal share | All-side wins / n | Win rate | Healer-present wins / n | Win rate |', '|---|---:|---:|---:|---:|');
  for (const key of ['high', 'low']) {
    const h = all.fights.healingOutcomes[key];
    lines.push(`| ${key === 'high' ? '≥10%' : '<10%'} | ${h.wins} / ${h.n} | ${pct(h.winRate)} | ${h.withHealersWins} / ${h.withHealersN} | ${pct(h.withHealersWinRate)} |`);
  }
  lines.push('', '## Fights', '| Cohort | Fights | Rating p25 / median / p75 | Lanchester correct / decided | Accuracy |', '|---|---:|---:|---:|---:|---:|');
  for (const [key, c] of Object.entries(a.cohorts)) {
    const r = c.fights.ratings.score, l = c.fights.lanchester;
    lines.push(`| ${key} | ${c.fights.count} | ${fmt(r?.p25)} / ${fmt(r?.median)} / ${fmt(r?.p75)} | ${l.correct} / ${l.decided} | ${pct(l.accuracy)} |`);
  }
  lines.push('', '## Eco (May vs rest)', '| Tech | May skip / rest | May late / rest | May missed / rest | May capitalized / rest |', '|---|---:|---:|---:|---:|---:|');
  for (const t of all.eco) {
    const m = may.eco.find(x => x.tech === t.tech), o = rest.eco.find(x => x.tech === t.tech);
    lines.push(`| ${cell(t.tech)} | ${pct(m?.skipRate)} / ${pct(o?.skipRate)} | ${pct(m?.delayRate)} / ${pct(o?.delayRate)} | ${fmt(m?.meanMissedResources)} / ${fmt(o?.meanMissedResources)} | ${pct(m?.capitalizedShare)} / ${pct(o?.capitalizedShare)} |`);
  }
  lines.push('', '## Definitions', ...definitions.map(d => `- ${d}`), '');
  return lines.join('\n');
}
const failed = new Set();
for (const name of names) {
  try {
    const source = path.join(DATA, `${name}.js`), target = path.join(OUT, `${name}.json`);
    const sourceStat = fs.statSync(source);
    if (!force && fs.existsSync(target) && fs.statSync(target).mtimeMs > sourceStat.mtimeMs) {
      const cachedText = fs.readFileSync(target, 'utf8'), cached = JSON.parse(cachedText);
      if (cached.schemaVersion === VERSION) {
        const refreshed = JSON.stringify(attachMetadata(cached));
        if (refreshed !== cachedText) fs.writeFileSync(target, refreshed);
        log(`${name}: cached`); continue;
      }
    }
    const recording = attachMetadata(analyze(name));
    fs.writeFileSync(target, JSON.stringify(recording));
    log(`${name}: ${recording.runtimeSeconds.toFixed(3)} s; ${recording.units.length} unit rows, ${recording.fights.length} fights`);
  } catch (error) { failed.add(name); log(`${name}: ERROR ${error.message}`); }
}
const records = [];
for (const file of fs.readdirSync(OUT).filter(n => n.endsWith('.json') && !['aggregate.json', 'micro_calibration.json'].includes(n)).sort()) {
  if (failed.has(file.slice(0, -5))) continue;
  try {
    const r = JSON.parse(fs.readFileSync(path.join(OUT, file), 'utf8'));
    if (r.schemaVersion === VERSION && Array.isArray(r.players) && Array.isArray(r.units)) records.push(attachMetadata(r));
  } catch (error) { log(`${file}: ERROR ${error.message}`); }
}
// Default dataset is strictly two-player; --all opts into team/FFA recordings without discarding their per-recording analyses.
const selectedRecords = records.filter(r => includeAll || r.players.length === 2);
const combined = aggregate(selectedRecords);
combined.dataset = includeAll ? 'all-player-counts' : 'two-player';
combined.counterMatrix = combined.cohorts.all.counterMatrix;
combined.excludedRecordings = records.filter(r => !selectedRecords.includes(r)).map(r => ({ name: r.name, players: r.players.length }));
// Exclusive game cohorts answer the recording-level comparison separately from May-player vs other-player sides.
const mayGames = selectedRecords.filter(r => r.players.some(p => p.cohort === 'may'));
const restGames = selectedRecords.filter(r => !r.players.some(p => p.cohort === 'may'));
combined.gameRecordingCounts = { mayGames: mayGames.length, restGames: restGames.length };
combined.gameCohorts = { mayGames: aggregate(mayGames).cohorts.all, restGames: aggregate(restGames).cohorts.all };
combined.microCalibration = microCalibration(selectedRecords);
fs.writeFileSync(path.join(OUT, 'micro_calibration.json'), JSON.stringify(combined.microCalibration, null, 2));
fs.writeFileSync(path.join(OUT, 'aggregate.json'), JSON.stringify(combined));
writeViewerBenchmark(combined);
fs.writeFileSync(path.join(OUT, 'SUMMARY.md'), summary(combined));
log(`Aggregate: ${selectedRecords.length} recordings; excluded ${combined.excludedRecordings.length}; harvest/analysis/{aggregate.json,SUMMARY.md}`, true);
if (failed.size) process.exitCode = 1;
