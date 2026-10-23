/**
 * core/replay.js — the replay model shared by every part of the 3D viewer: no Three.js, no DOM.
 *
 * Reads the recorder's data file (format 1, written by the 2D viewer's tools/convert.py) into typed-array tracks and
 * answers time queries. Sampling, ownership, vision, unit tiers/names, wall links and the gate fix follow the 2D
 * viewer's model.js (tools/parity-check.mjs compares the two through locate()); on top of that sit the 3D-only derived
 * events used by the animation: blows and hit moments from the shared combat index (the 2D viewer's frame.js,
 * RV_FRAME.combat: attacker/target pairs → timed melee strikes and shots, killing blows on the death tick, buildings'
 * guessed shots; this.combat), villager jobs from position, garrisons, sheep carcasses, and place(): locate()'s motion
 * re-timed so units plant their feet to strike and walk on to the spot where they die.
 *
 * Map objects (Replay.gaia, named as in the 2D viewer) carry their recorded amounts, which change only at the
 * recorder's neutral scans (every SCAN s at Replay.scanPhase: Replay.scanAt), the most they held (full: berry bushes
 * read above their start), the villager stands that work them (workersAt) and a tree's first chopping stand;
 * locateGaia(g, t) writes their amount and movers' position at t.
 *
 * Wall pieces carry shapes tabled over time (Replay.linkWalls → wallAt(e, t)): each straight piece and gate turns along
 * the links to its standing neighbours; straight pieces are trimmed or stretched to meet them, ending inside the posts
 * and gate towers, which keep their size.
 *
 * Per-frame contract: Replay.updateFrame(t) writes the frame facts of every entity that is alive at t (on, hid =
 * inside a building, pown, px/pz = place(), php, pi = track sample index). Entities that are not alive keep stale
 * facts; the renderer (viewer.js) owns the remaining per-entity slots (shown, gy, view, foe, us) and poses the fallen at
 * their death position itself.
 */

export const SAMPLE = 0.5;     // recorder sample interval (s): movement is interpolated over the last interval
// (MAX_FLIGHT, the longest projectile flight, lives with the blows in frame.js: RV_FRAME.MAX_FLIGHT)
const GAIA_MOVE = 1;           // gaia movers are sampled every second
const SCAN = 10;               // s between the recorder's neutral scans (gaia amounts only change at a scan)
const WALL_LINK = 6.6;         // wall pieces closer than this belong to the same wall line (palisade pieces sit ~6 m apart)
const WALL_TUCK = 0.15;        // m a straight wall piece runs on into the post or gate tower it ends at (no daylight)
const WALL_MIN = 0.3;          // m: a straight piece left shorter than this sits inside a gate tower (not drawn)
const WALL_SIDE = 0.5;         // m off the line between two linked wall pieces that a third piece still stands between them
const WALL_ALONG = Math.cos(Math.PI / 12); // a link within 15° of a wall piece's line runs along it (recorded lines bend < 2°)
const WALL_FREE = 0.25;        // a link within ~75° of a wall piece's line holds that end (a corner's other line too)
// m, s, m, m: a unit standing by a building supervising it (supervision); recorded tax stops last 12–17 s, and a unit
// at a building's very centre is inside it (garrisoned, dropping off)
const SUP_STILL = 1, SUP_MIN = 30, SUP_REACH = 3, SUP_INSIDE = 1;
// Tower crews (Replay.seatCrews) and the war elephants they ride
const CREW_BP = /^unit_war_elephant_tower_(archer|handcannoneer|monk)_/, MOUNT_BP = /^unit_war_elephant_/;
// Mongol buildings on the move (Replay.trips) pack for PACK_SECS, roll as a cart (sample steps over ROLL_STEP m) and
// stand again at their next construction event within UNPACK_MAX s of arriving (the recorder logs one as an unpacking
// completes: 1.1–5.6 s after arriving in aoe4_256767395), else UNPACK_SECS after it. A stop stays inside one trip
// unless such an event falls in it or it lasts PACK_SECS + UNPACK_SECS. [inference] PACK_SECS: buildings there roll
// 2.0–3.5 s after completing, so the pack is at most ~2 s (pack_building_mon's channeling_time_second, 10, cannot be it).
const PACK_SECS = 2, ROLL_STEP = 0.3, UNPACK_MAX = 8, UNPACK_SECS = 5;
const PLANT_VMAX = 9;          // m/s: fastest a unit may cover a move squeezed around a planted swing or shot
const CORPSE_FALL = 0.7;       // s a slaughtered sheep falls before its carcass object takes over
const CARRY_MIN = 4;           // s of gathering before a villager walks off carrying the load
const HOLD_MAX = 1.5;          // s: a villager keeps its tool through a break this short between two stands of one job
const CAM_TICK = 1 / 8 + 1e-6; // s: camera samples this close are one continuous move (one sim tick apart)
export const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];
export const TAU = Math.PI * 2;

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const fmtTime = (t) => { const s = Math.max(0, Math.floor(t)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** Largest i with arr[i] <= t, or -1. */
export function idxAt(arr, t) {
  let lo = 0, hi = arr.length - 1, r = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= t) { r = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return r;
}

export function hash01(n) {
  let x = (n ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}
export const hash3 = (a, b, c) => hash01((a * 73856093) ^ (b * 19349663) ^ (c * 83492791));

// Blueprint tokens dropped from display names: the 2D viewer's list (every civ) plus tech/defense/viz/com and the gaia
// prefixes ("Palisade", not the 2D "Defense Palisade"). Not "food": the mill (building_econ_food_control) is "Food".
const DROP = new Set(['unit', 'building', 'control', 'econ', 'naval', 'landmark', 'capital', 'gaia', 'herdable', 'huntable',
  'resource', 'forage', 'tech', 'defense', 'viz', 'grassland', 'dragon', '01', '02', '03',
  'eng', 'fre', 'hre', 'ha', 'mon', 'chi', 'rus', 'abb', 'del', 'sul', 'mal', 'ott', 'byz', 'jpn', 'ayy', 'kte', 'zxl',
  'hol', 'lan', 'jdk', 'tug', 'hoj', 'mac', 'sen', 'jin', 'com']);
const ALIAS = { manatarms: 'Man-at-Arms', maa: 'Man-at-Arms' };
const WPN_DROP = new Set(['wpn', 'range', 'garrison', 'non', 'capital', 'additional', 'tc', 'a', 'b', 'incen']);
/** unit_horseman_2_jin_grassland → "Horseman II" (tier I is left off). */
export function prettify(bp) {
  let tokens = bp.toLowerCase().split('_');
  if (tokens[0] === 'wpn') tokens = tokens.filter((t) => !WPN_DROP.has(t));
  let tier = '';
  const out = [];
  for (const tok of tokens) {
    if (/^[1-5]$/.test(tok) && !tier) { tier = ROMAN[+tok]; continue; }
    if (/^age\d$/.test(tok) || DROP.has(tok)) continue;
    out.push(ALIAS[tok] ?? tok.charAt(0).toUpperCase() + tok.slice(1));
  }
  return (out.join(' ') || bp) + (tier && tier !== 'I' ? ` ${tier}` : '');
}
export const prettyCiv = (civ) => civ.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

const TIER = /^(.*?)_([1-5])(?=_|$)/;

function prepEntity(r) {
  const n = r.track.length / 4;
  const t = new Float64Array(n), x = new Float32Array(n), z = new Float32Array(n), hp = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    t[i] = r.track[4 * i]; x[i] = r.track[4 * i + 1]; z[i] = r.track[4 * i + 2]; hp[i] = r.track[4 * i + 3];
  }
  // seg[i]: heading of the move i → i+1 (NaN when stationary); hd[i]: heading after arriving at sample i.
  const seg = new Float32Array(n).fill(NaN), hd = new Float32Array(n).fill(NaN);
  for (let i = 0; i + 1 < n; i++) {
    const dx = x[i + 1] - x[i], dz = z[i + 1] - z[i];
    if (dx * dx + dz * dz > 0.0025) seg[i] = Math.atan2(dx, dz);
  }
  for (let i = 1; i < n; i++) hd[i] = Number.isNaN(seg[i - 1]) ? hd[i - 1] : seg[i - 1];
  const spans = new Float64Array(r.spans.length * 2);
  r.spans.forEach((s, i) => { spans[2 * i] = s[0]; spans[2 * i + 1] = s[1] ?? Infinity; });
  let ownT = null, ownV = null;
  if (r.owners?.length) { ownT = Float64Array.from(r.owners, (o) => o[0]); ownV = Int32Array.from(r.owners, (o) => o[1]); }
  let visT = null, visM = null;
  if (r.vision?.length) {
    const k = r.vision.length / 2;
    visT = new Float64Array(k); visM = new Int32Array(k);
    for (let i = 0; i < k; i++) { visT[i] = r.vision[2 * i]; visM[i] = r.vision[2 * i + 1]; }
  }
  const tm = TIER.exec(r.bp);
  return {
    id: r.id, owner: r.owner, bp: r.bp, cat: r.cat, maxhp: r.maxhp || 1, squad: r.squad,
    killed: r.killed, killer: r.killer, value: r.value || 0, name: prettify(r.bp),
    t, x, z, hp, seg, hd, spans, ownT, ownV, visT, visM,
    line: tm ? tm[1] : null, tier: tm ? +tm[2] : 1, ups: null,
    born: spans[0], died: r.killed ? spans[spans.length - 1] : null, defeated: false,
    isBuilding: r.cat === 'building', isUnit: r.cat !== 'building' && r.cat !== 'attachment',
    followsAge: r.cat === 'villager' || /scout|monk/.test(r.bp),
    builtAt: -Infinity, wall: null, arms: null, sup: null, cons: null, trips: null, seed: hash01(r.id),
    // combat and work (blows from the shared combat index, frame.js RV_FRAME.combat / villagerJobs)
    blows: null, stT: null, hitT: null, job: null, jobX: null, jobZ: null, jobT0: null, jobT1: null, jobOut: null,
    // animation timing (Replay.standToStrike / deathDrift / garrisons / sheepCorpses); mount: the war elephant a tower
    // crew rides (Replay.seatCrews)
    mv: null, exV: null, garr: null, corpseT: null, corpseH: null, mount: null,
    // frame facts (Replay.updateFrame)
    on: false, hid: false, px: x[0], pz: z[0], php: hp[0], pown: r.owner, pi: 0,
    // renderer-owned slots (viewer.js): per frame, and the stop / drop-off / heal clip timings it memoizes
    shown: false, gy: 0, view: null, foe: null, us: 1, stopT: null, drops: null, heal: null,
  };
}

export function alive(e, t) {
  const s = e.spans;
  for (let i = 0; i < s.length; i += 2) if (t >= s[i] && t < s[i + 1]) return true;
  return false;
}
export function ownerAt(e, t) {
  if (!e.ownT) return e.owner;
  const i = idxAt(e.ownT, t);
  return i < 0 ? e.owner : e.ownV[i];
}

const DEFEAT_MIN = 5; // entities that close together, unkilled, for it to be a defeat rather than a few despawns
/**
 * A defeated player's whole estate leaves the game at one tick without a single kill: the recorder's scan stops seeing
 * it (killed is false, the span just closes ~10 s before the game ends). When ≥ DEFEAT_MIN entities of one owner close at
 * the same tick without a kill and that owner has nothing left standing afterwards, they were destroyed then: died is the
 * close time and defeated is set, so the viewer lets them fall like killed ones instead of popping out. Garrison,
 * despawn and upgrade closes are single or scattered, and the owner keeps other entities.
 * (viewer/model.js markDefeats is the 2D twin.)
 */
function markDefeats(ents) {
  const groups = new Map(); // "close time|owner at close" → entities closing then without a kill
  for (const e of ents) {
    const end = e.spans[e.spans.length - 1];
    if (e.killed || end === Infinity) continue;
    const key = `${end}|${ownerAt(e, end)}`, l = groups.get(key);
    if (l) l.push(e); else groups.set(key, [e]);
  }
  for (const [key, list] of groups) {
    if (list.length < DEFEAT_MIN) continue;
    const end = list[0].spans[list[0].spans.length - 1], owner = +key.slice(key.indexOf('|') + 1);
    if (ents.some((e) => alive(e, end) && ownerAt(e, end) === owner)) continue;
    for (const e of list) { e.died = end; e.defeated = true; }
  }
}
const _loc = { x: 0, z: 0, hp: 0, i: 0 };
/** Position/HP at t: hold each sample, interpolating over the final SAMPLE before the next recorded change. */
export function locate(e, t) {
  let i = idxAt(e.t, t);
  if (i < 0) i = 0;
  let x = e.x[i], z = e.z[i];
  if (i + 1 < e.t.length) {
    const t1 = e.t[i + 1], ts = Math.max(e.t[i], t1 - SAMPLE);
    if (t > ts) {
      const a = (t - ts) / (t1 - ts);
      x += (e.x[i + 1] - x) * a;
      z += (e.z[i + 1] - z) * a;
    }
  }
  _loc.x = x; _loc.z = z; _loc.hp = e.hp[i]; _loc.i = i;
  return _loc;
}

// Wall pieces (Replay.linkWalls): the 2D viewer's wall and gate kinds; bastions and towers are a line's posts. Half
// lengths along the wall (m) of what the viewer draws: the com/rus palisade bastion and eng/rus palisade gate GLBs, and
// its stand-ins for stone towers ([4, 8, 4]) and gates ([10.3, 7, 3]); a straight piece is the 6.27 m palisade.
const WALL_BP = /palisade|wall|gate/, WALL_NODE = /bastion|tower/, WALL_GATE = /gate/, RUN_HALF = 3.13;
const wallHalf = (bp) => (WALL_GATE.test(bp) ? (/palisade_gate_rus/.test(bp) ? 5.4 : 5.15)
  : /palisade_bastion_rus/.test(bp) ? 1.1 : /palisade/.test(bp) ? 0.46 : 2);
const _wall = { a: 0, len: 0, off: 0, free: 0, row: 0 };
/**
 * Wall piece e's shape at t (e.wall, from Replay.linkWalls): turn a (the model's +X along the wall, as group rotation.y),
 * the length len (m) to draw its model at along that axis (0: covered by a gate, not drawn), its centre's offset
 * off (m) along the axis, its free ends (bit 1: +axis, 2: −axis; no wall goes on there) and row, the shape's index.
 */
export function wallAt(e, t) {
  const w = e.wall, k = Math.max(0, idxAt(w.T, t));
  _wall.a = w.A[k]; _wall.len = w.L[k]; _wall.off = w.O[k]; _wall.free = w.F[k]; _wall.row = k;
  return _wall;
}
const _pl = { x: 0, z: 0, hp: 0, i: 0 };
/**
 * Where the viewer draws e at t: locate()'s motion, except that a unit which cannot attack on the move stands still
 * through each swing or shot that falls inside a move window (e.mv: sample index → [window start, plant start, plant
 * end], the move squeezed into the rest of the window), and a unit killed while walking walks on from its last sample
 * to the death tick (e.exV: [vx, vz, until]). Sample times and positions are untouched.
 */
export function place(e, t) {
  let i = idxAt(e.t, t);
  if (i < 0) i = 0;
  let x = e.x[i], z = e.z[i];
  if (i + 1 < e.t.length) {
    const t1 = e.t[i + 1], w = e.mv?.get(i), ts = w ? w[0] : Math.max(e.t[i], t1 - SAMPLE);
    if (t > ts) {
      const plant = w ? w[2] - w[1] : 0;
      const a = (t - ts - (w ? clamp(t - w[1], 0, plant) : 0)) / (t1 - ts - plant);
      x += (e.x[i + 1] - x) * a;
      z += (e.z[i + 1] - z) * a;
    }
  } else if (e.exV && t > e.t[i]) {
    const d = Math.min(t, e.exV[2]) - e.t[i];
    x += e.exV[0] * d;
    z += e.exV[1] * d;
  }
  _pl.x = x; _pl.z = z; _pl.hp = e.hp[i]; _pl.i = i;
  return _pl;
}
const _trip = { r: null, phase: '', k: 0 };
/** Where a building is on its trips (Replay.trips) at t: null, or { r: the trip, phase: 'pack' | 'roll' | 'unpack', k:
 *  0 → 1 through the phase } (one shared object). */
export function tripAt(trips, t) {
  for (const r of trips) {
    if (t < r.p0) return null;
    if (t >= r.u1) continue;
    _trip.r = r;
    if (t < r.t0) { _trip.phase = 'pack'; _trip.k = (t - r.p0) / (r.t0 - r.p0); }
    else if (t <= r.t1) { _trip.phase = 'roll'; _trip.k = (t - r.t0) / (r.t1 - r.t0); }
    else { _trip.phase = 'unpack'; _trip.k = (t - r.t1) / (r.u1 - r.t1); }
    return _trip;
  }
  return null;
}
/** Whether e is inside a building at t (Replay.garrisons). */
export function insideAt(e, t) {
  const g = e.garr;
  if (!g) return false;
  for (let k = 0; k < g.length; k += 2) if (t >= g[k] && t < g[k + 1]) return true;
  return false;
}
/** Whether the players in mask see e at t (own units always; others by the recorded per-player vision). */
export function visibleTo(e, t, mask) {
  if ((1 << (e.pown - 1)) & mask) return true;
  if (!e.visT) return false;
  const i = idxAt(e.visT, t);
  return i >= 0 && (e.visM[i] & mask) !== 0;
}

// Gaia name prefixes the 2D viewer drops ("Berry Bush", not "Food Berry Bush").
const GAIA_PREFIX = /^(resource_food_forage_|resource_|gaia_huntable_|gaia_herdable_|gaia_)/;
/** A map object (one shape for recorded objects and made carcasses); prepGaia/sheepCorpses fill in its time series. */
function gaiaObject(id, bp, kind, x, z, amount, seed) {
  return {
    gaia: true, id, bp, kind, name: prettify(bp.replace(GAIA_PREFIX, '')), x, z, amount0: amount, amount, seed,
    full: amount, // the most it holds: worked berry bushes report more than their recorded start from the first scan
    spans: null, amT: null, amV: null, trT: null, trX: null, trZ: null, px: x, pz: z, heading: hash01(id + 7) * TAU,
    // the game's K for it (Infinity without one): a wolf's death; a hunted deer's comes when its carcass is eaten up,
    // ~2–10 s before it goes (its shot shows only as its first amount drop), a berry bush's when its last food is picked
    killT: Infinity,
    // work (Replay.villagerJobs): the stands at it ([workT0, workT1) by villager workBy, by start) and a tree's first
    // chopping stand (start chopT0 by villager chopBy, standing at chopX/chopZ)
    workT0: null, workT1: null, workBy: null, chopT0: Infinity, chopBy: 0, chopX: 0, chopZ: 0,
    on: false, // frame fact (locateGaia callers)
    // renderer-owned slots (viewer.js): drawn now, ground height, view, tree instance, when a felled tree falls, when an
    // animal dies (deathOf)
    shown: false, gy: 0, view: null, tree: null, fellT: Infinity, deadT: null,
  };
}
function prepGaia(g) {
  if (!g) return [];
  const types = g.types.map(([bp, kind]) => ({ bp, kind }));
  return g.ents.map(([id, ti, x, z, amount, spans, amounts, track, killed]) => {
    const ty = types[ti];
    // the data files sheep carcasses as trees: they are meat
    const o = gaiaObject(id, ty.bp, /corpse/.test(ty.bp) ? 'carcass' : ty.kind, x, z, amount, hash01(id));
    o.spans = Float64Array.from(spans, (v) => v ?? Infinity);
    if (killed) o.killT = killed;
    if (amounts) {
      const k = amounts.length / 2;
      o.amT = new Float64Array(k); o.amV = new Float32Array(k);
      for (let i = 0; i < k; i++) { o.amT[i] = amounts[2 * i]; o.amV[i] = amounts[2 * i + 1]; o.full = Math.max(o.full, o.amV[i]); }
    }
    if (track) {
      const k = track.length / 3;
      o.trT = new Float64Array(k); o.trX = new Float32Array(k); o.trZ = new Float32Array(k);
      for (let i = 0; i < k; i++) { o.trT[i] = track[3 * i]; o.trX[i] = track[3 * i + 1]; o.trZ[i] = track[3 * i + 2]; }
    }
    return o;
  });
}
/** Map object state at t: amount left, position and heading of movers (written onto g). */
export function locateGaia(g, t) {
  if (g.amT) {
    const i = idxAt(g.amT, t);
    g.amount = i < 0 ? g.amount0 : g.amV[i];
  }
  if (!g.trT) return;
  const i = idxAt(g.trT, t);
  if (i < 0) { g.px = g.x; g.pz = g.z; return; }
  let x = g.trX[i], z = g.trZ[i];
  if (i + 1 < g.trT.length) {
    const t1 = g.trT[i + 1], ts = Math.max(g.trT[i], t1 - GAIA_MOVE);
    if (t > ts) {
      const a = (t - ts) / (t1 - ts);
      const dx = g.trX[i + 1] - x, dz = g.trZ[i + 1] - z;
      x += dx * a; z += dz * a;
      if (dx * dx + dz * dz > 0.01) g.heading = Math.atan2(dx, dz);
    }
  }
  g.px = x; g.pz = z;
}
/** How many villagers work g at t (its Replay.villagerJobs stands); out, when given, gets their ids. */
export function workersAt(g, t, out) {
  if (out) out.length = 0;
  if (!g.workT0) return 0;
  let n = 0;
  for (let k = idxAt(g.workT0, t); k >= 0; k--) {
    if (t >= g.workT1[k]) continue;
    n++;
    out?.push(g.workBy[k]);
  }
  return n;
}
/** The neutral scan's phase in its SCAN period: the commonest amount-row time mod SCAN (all rows share one), or null. */
function scanPhase(gaia) {
  const n = new Map();
  let best = null, most = 0;
  for (const g of gaia) {
    if (!g.amT) continue;
    for (const t of g.amT) {
      const p = Math.round((((t % SCAN) + SCAN) % SCAN) * 8) / 8, c = (n.get(p) ?? 0) + 1;
      n.set(p, c);
      if (c > most) { most = c; best = p; }
    }
  }
  return best;
}

// Villager work, per JOBS index: swing pose, tool in hand, load carried away, stroke period (s). Codes above HOLD are
// a short walk between two stands of job (code − HOLD) with its tool in hand; codes above CARRY the walk to a drop-off
// with JOBS[code − CARRY]'s load.
const J_BUILD = 1, J_GOLD = 4, J_STONE = 5, J_BERRY = 6, J_MEAT = 7, J_FISH = 8;
export const J_FARM = 2, J_WOOD = 3, CARRY = 16, HOLD = 32;
export const JOBS = [null,
  { pose: 'hammer', tool: 'hammer_construction', carry: null, period: 1.1 },
  { pose: 'reap', tool: 'sickle_farming', carry: 'res_wheat_carry', period: 1.6 },
  { pose: 'chop', tool: 'axe_2hand', carry: 'res_wood_carry', period: 1.5 },
  { pose: 'chop', tool: 'hammer_pick', carry: 'res_gold_backpack', period: 1.7 },
  { pose: 'chop', tool: 'hammer_mining', carry: 'res_stone_backpack', period: 1.7 },
  { pose: 'pick', tool: 'res_berry_empty', carry: 'res_berry_carry', period: 1.8 },
  { pose: 'skin', tool: 'knife_skinning', carry: 'res_meat_carry', period: 1.3 },
  { pose: 'cast', tool: 'net_fishing', carry: 'res_fish_carry', period: 6.9 },
];
const GAIA_JOB = { tree: J_WOOD, stealth: J_WOOD, gold: J_GOLD, stone: J_STONE, berry: J_BERRY, deer: J_MEAT, boar: J_MEAT, sheep: J_MEAT, carcass: J_MEAT, fish: J_FISH };
const DROPOFF = /town_center|lumber|econ_wood|mining_camp|econ_mining|mill|econ_food/;
/** Rough building radius (m) for "is this villager working on it". */
const footprint = (bp) => (/town_center|landmark/.test(bp) ? 9 : /farm/.test(bp) ? 7 : /house|outpost|palisade|bastion|marker/.test(bp) ? 3 : 6);
/** Reach (m) from a villager to a gatherable's centre while working it (from where recorded gatherers stand; shore fish
 * lie in the water, their fishers ~4.2 m off on the bank). */
const reach = (g) => (g.kind === 'gold' || g.kind === 'stone' ? (/small/.test(g.bp) ? 6.5 : 8.5) : g.kind === 'berry' ? 3.2 : g.kind === 'fish' ? 5 : GAIA_JOB[g.kind] === J_MEAT ? 3 : 2.4);

export class Replay {
  /**
   * d: recorder data; units: the unit classification shared with tools/convert.py (2D viewer units.js, window.RV_UNITS);
   * frame: the shared view-model layer (2D viewer frame.js, window.RV_FRAME) whose combat index times the blows.
   */
  constructor(d, units, frame) {
    this.d = d;
    this.t0 = d.recordStart ?? 0;
    this.t1 = d.duration;
    this.players = new Map(d.players.map((p) => [p.idx, { ...p }]));
    this.teams = [...new Set(d.players.map((p) => p.team))]; // in player order, so the first player's team leads
    this.teamMask = new Map(this.teams.map((tm) => [tm, d.players.filter((p) => p.team === tm).reduce((m, p) => m | (1 << (p.idx - 1)), 0)]));
    this.allMask = d.players.reduce((m, p) => m | (1 << (p.idx - 1)), 0);
    this.military = new Set(units.military);
    this.ents = d.entities.map(prepEntity);
    markDefeats(this.ents);
    this.byId = new Map(this.ents.map((e) => [e.id, e]));

    this.ageT = new Map([...this.players.keys()].map((k) => [k, []]));
    for (const [t, p, , type] of d.techs ?? []) if (type === 'age') this.ageT.get(p)?.push(t);
    for (const a of this.ageT.values()) a.sort((x, y) => x - y);
    // each player's camera (convert.py camera_tracks): sample times, eyes (x, y, z per sample), orientation indices
    this.cameras = new Map(Object.entries(d.cameras ?? {}).map(([idx, c]) => {
      const n = c.track.length / 5, k = Array.from({ length: n }, (_, i) => 5 * i);
      return [+idx, {
        fov: c.fov, rots: c.rots, t: Float64Array.from(k, (i) => c.track[i]), rot: Uint16Array.from(k, (i) => c.track[i + 4]),
        eye: Float32Array.from({ length: 3 * n }, (_, j) => c.track[5 * Math.floor(j / 3) + 1 + (j % 3)]),
      }];
    }));

    this.fixGates(d.constructions ?? []);
    this.unitUpgrades(d.upgrades ?? []);
    this.constructionTimes(d.constructions ?? []);
    this.linkWalls();

    // blows, hit moments and damage numbers: the shared combat index over this model's entities (frame.js)
    const C = frame.combat(this.ents, d);
    this.combat = C;
    for (const [id, mine] of C.lists) {
      const e = this.byId.get(id);
      e.blows = mine;
      e.stT = Float64Array.from(mine, (m) => m.t0);
    }
    for (const [id, l] of C.hitT) this.byId.get(id).hitT = l;
    this.kills = (d.kills ?? []).slice().sort((a, b) => a.t - b.t);
    this.killT = Float64Array.from(this.kills, (k) => k.t);
    this.melee = C.melee; this.meleeT = C.meleeT;
    this.shots = C.shots; this.shotT = C.shotT;
    this.dmgT = C.dmgT; this.dmgId = C.dmgId; this.dmgAmt = C.dmgAmt;
    this.standToStrike();
    this.deathDrift();
    this.garrisons();
    this.seatCrews();

    this.fights = d.fights ?? [];
    this.army = d.army ?? null;
    this.terrain = d.terrain ?? null;
    this.gaia = prepGaia(d.gaia);
    this.sheepCorpses();
    this.villagerJobs();
    this.scanPhase = scanPhase(this.gaia);
  }

  isMilitary(cat) { return this.military.has(cat); }

  /**
   * Tower crews: a tower elephant's archers, handcannoneers or monks are entities of their own (ebps
   * attachment_child_ext) recorded within ~0.6 m of their mount, with the two ids after it (aoe4_256564163: 13 archer
   * pairs, 5 monk pairs). Sets e.mount on each crew member.
   */
  seatCrews() {
    for (const e of this.ents) {
      if (!CREW_BP.test(e.bp)) continue;
      for (let k = 1; k <= 2 && !e.mount; k++) {
        const m = this.byId.get(e.id - k);
        if (m && MOUNT_BP.test(m.bp) && !CREW_BP.test(m.bp)) e.mount = m;
      }
    }
  }

  /** Time of the last neutral scan at or before t (the SCAN cadence at the recorded phase), or null without amounts. */
  scanAt(t) { return this.scanPhase == null ? null : this.scanPhase + SCAN * Math.floor((t - this.scanPhase) / SCAN); }

  /** Frame facts of every entity alive at t (see the module header). */
  updateFrame(t) {
    for (const e of this.ents) {
      e.on = alive(e, t);
      if (!e.on) continue;
      e.pown = ownerAt(e, t);
      const L = place(e, t);
      e.px = L.x; e.pz = L.z; e.php = L.hp; e.pi = L.i;
      e.hid = e.garr !== null && insideAt(e, t);
    }
  }

  /**
   * Units whose weapon is not used on the move plant their feet for each swing or shot: where a blow's last wind-up
   * and impact fall inside a move window, the move is squeezed into the rest of the window (e.mv, read by place()),
   * never faster than PLANT_VMAX — the plant shortens instead.
   */
  standToStrike() {
    for (const e of this.ents) {
      if (!e.blows) continue;
      for (const b of e.blows) {
        if (b.mobile) continue;
        const s = b.t0, p0 = s - Math.min(b.up, 0.3), p1 = s + 0.12;
        for (let i = Math.max(0, idxAt(e.t, p0)); i + 1 < e.t.length && e.t[i] < p1; i++) {
          if (Number.isNaN(e.seg[i])) continue;
          const t1 = e.t[i + 1], ws = Math.max(e.t[i], t1 - SAMPLE), old = e.mv?.get(i);
          let q0 = Math.max(p0, ws), q1 = Math.min(p1, t1);
          if (old) { q0 = Math.min(q0, old[1]); q1 = Math.max(q1, old[2]); }
          if (q1 - q0 < 0.02) continue;
          const room = t1 - ws - Math.max(0.1, Math.hypot(e.x[i + 1] - e.x[i], e.z[i + 1] - e.z[i]) / PLANT_VMAX);
          if (room < 0.05) continue;
          if (q1 - q0 > room) { q0 = clamp(s - 0.7 * room, ws, t1 - room); q1 = q0 + room; }
          (e.mv ??= new Map()).set(i, [ws, q0, q1]);
        }
      }
    }
  }

  /** A unit killed within a sample interval of arriving from a move keeps walking at that pace to the death tick. */
  deathDrift() {
    for (const e of this.ents) {
      const n = e.t.length;
      if (e.died == null || !e.isUnit || n < 2 || Number.isNaN(e.seg[n - 2])) continue;
      const tl = e.t[n - 1];
      if (!(e.died > tl && e.died - tl < SAMPLE + 1e-6)) continue;
      const dur = tl - Math.max(e.t[n - 2], tl - SAMPLE);
      e.exV = [(e.x[n - 1] - e.x[n - 2]) / dur, (e.z[n - 1] - e.z[n - 2]) / dur, e.died];
    }
  }

  /**
   * Garrisoned units are reported at the centre of their building *as it stands then* (Mongol buildings pack and move,
   * so a town centre is not where it first appeared): e.garr = [enter, leave, …] intervals with the unit inside — from
   * the start of its move in (it vanishes at the door) to the end of its move out (it appears at the door); a unit
   * first seen inside (trained there) starts inside.
   */
  garrisons() {
    const cellOf = (v) => Math.round(v * 10);
    const centres = new Map(); // cell → buildings that ever stood there (candidates; locate(b, t) says where at t)
    for (const b of this.ents) {
      if (!b.isBuilding || /farm|palisade|wall|gate|grassland|marker/.test(b.bp)) continue;
      for (let i = 0; i < b.t.length; i++) {
        if (i && b.x[i] === b.x[i - 1] && b.z[i] === b.z[i - 1]) continue;
        const k = `${cellOf(b.x[i])},${cellOf(b.z[i])}`, l = centres.get(k);
        if (!l) centres.set(k, [b]); else if (!l.includes(b)) l.push(b);
      }
    }
    const inside = (x, z, t) => {
      const cx = cellOf(x), cz = cellOf(z);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        for (const b of centres.get(`${cx + i},${cz + j}`) ?? []) {
          if (!alive(b, t)) continue;
          const L = locate(b, t); // where the building stands at t
          if (Math.abs(cellOf(L.x) - cx) <= 1 && Math.abs(cellOf(L.z) - cz) <= 1) return true;
        }
      }
      return false;
    };
    for (const e of this.ents) {
      if (!e.isUnit || e.cat === 'livestock' || e.cat === 'other') continue;
      const n = e.t.length, out = [];
      for (let i = 0; i < n; i++) {
        if (!inside(e.x[i], e.z[i], e.t[i])) continue;
        let j = i;
        while (j + 1 < n && inside(e.x[j + 1], e.z[j + 1], e.t[j + 1])) j++;
        out.push(i === 0 ? -Infinity : Math.max(e.t[i - 1], e.t[i] - SAMPLE), j + 1 < n ? e.t[j + 1] : Infinity);
        i = j;
      }
      if (out.length) e.garr = Float64Array.from(out);
    }
  }

  /**
   * A slaughtered sheep leaves its carcass where it fell until eaten up (its kill event). The 10 s neutral scan
   * reports some carcasses late (same id as the sheep) and misses others (made here, at place()'s death spot): every
   * carcass spans from the end of the sheep's fall (e.corpseT, where the viewer hands over) to the kill event, facing
   * the way the sheep fell (e.corpseH: its last walk, else its recorded heading).
   */
  sheepCorpses() {
    const byId = new Map(this.gaia.map((g) => [g.id, g]));
    const eaten = new Map(this.kills.map((k) => [k.victim, k.t]));
    for (const s of this.ents) {
      const end = s.cat === 'livestock' && s.died != null && /herdable_sheep/.test(s.bp) ? eaten.get(s.id) : undefined;
      if (!(end > s.died + CORPSE_FALL)) continue;
      const n = s.t.length - 1;
      let g = byId.get(s.id);
      if (!g || g.kind !== 'carcass') {
        const L = place(s, s.died);
        g = gaiaObject(s.id, `${s.bp.replace('gaia_herdable_', 'gaia_food_')}_corpse`, 'carcass', L.x, L.z, 1, s.seed);
        this.gaia.push(g);
      }
      g.spans = Float64Array.of(s.died + CORPSE_FALL, end);
      g.heading = s.exV ? Math.atan2(s.exV[0], s.exV[1]) : Number.isNaN(s.hd[n]) ? s.seed * TAU : s.hd[n];
      s.corpseT = s.died + CORPSE_FALL;
      s.corpseH = g.heading;
    }
  }

  /**
   * What each villager is doing, per track sample (e.job, JOBS codes). A stand — samples at one spot; HP-only samples
   * do not end it — of ≥ 1 s next to an unfinished or repaired building, a farm, a mine, berries, a carcass or a tree
   * is work there (jobX/jobZ = the spot to face; jobT0/jobT1 = when the stand starts and when the move off it ends).
   * Walking off after ≥ CARRY_MIN s of gathering carries the load (code + CARRY) until the trip's closest approach to
   * an own drop-off; a break of ≤ HOLD_MAX s between two stands of one job keeps the tool in hand (code + HOLD).
   * jobOut: what a stand's samples hold while walking off it (a CARRY or HOLD code, else 0).
   * A gathering stand also counts at the map object it works (g.workT0/workT1/workBy: one interval per stand, from its
   * start to the move off it, sorted by start; g.chopT0/chopBy/chopX/chopZ: a tree's first chopping stand).
   */
  villagerJobs() {
    const grid = new Map(), cell = (x, z) => `${Math.floor(x / 8)},${Math.floor(z / 8)}`;
    const movers = [];
    for (const g of this.gaia) {
      if (!GAIA_JOB[g.kind]) continue;
      if (g.trT) { movers.push(g); continue; }
      const k = cell(g.x, g.z);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(g);
    }
    const herd = this.ents.filter((e) => e.cat === 'livestock');
    const blds = this.ents.filter((e) => e.isBuilding);
    const drops = blds.filter((b) => DROPOFF.test(b.bp));
    const spot = { code: 0, x: 0, z: 0, g: null }; // g: the map object worked (null for buildings, farms, livestock)
    const jobAt = (x, z, t, end) => {
      let farm = null, fx = 0, fz = 0;
      spot.g = null;
      for (const b of blds) {
        if (!alive(b, t)) continue;
        const lb = locate(b, t), bx = lb.x, bz = lb.z, d = Math.hypot(bx - x, bz - z), r = footprint(b.bp); // where b stands at t (Mongol buildings move)
        if (d > r + 1.8) continue;
        const hp0 = locate(b, t).hp, hp1 = locate(b, end - 0.01).hp;
        if (t < b.builtAt || hp1 > hp0) { spot.code = J_BUILD; spot.x = bx; spot.z = bz; return spot; }
        if (!farm && d <= r && /farm/.test(b.bp)) { farm = b; fx = bx; fz = bz; }
      }
      if (farm) { spot.code = J_FARM; spot.x = fx; spot.z = fz; return spot; }
      let best = 0, bestRank = 9, bestD = Infinity; // mines over berries over meat over trees, then nearest
      const consider = (job, gx, gz, r, src) => {
        const d = Math.hypot(gx - x, gz - z), rank = job === J_GOLD || job === J_STONE ? 0 : job === J_BERRY || job === J_FISH ? 1 : job === J_MEAT ? 2 : 3;
        if (d > r || rank > bestRank || (rank === bestRank && d >= bestD)) return;
        best = job; bestRank = rank; bestD = d; spot.x = gx; spot.z = gz; spot.g = src;
      };
      const cx = Math.floor(x / 8), cz = Math.floor(z / 8);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        for (const g of grid.get(`${cx + i},${cz + j}`) ?? []) if (alive(g, t)) consider(GAIA_JOB[g.kind], g.x, g.z, reach(g), g);
      }
      for (const g of movers) {
        if (!alive(g, t)) continue;
        const i = Math.max(0, idxAt(g.trT, t));
        consider(GAIA_JOB[g.kind], g.trX[i], g.trZ[i], reach(g), g);
      }
      for (const s of herd) {
        if (!alive(s, t)) continue;
        const L = locate(s, t);
        consider(J_MEAT, L.x, L.z, 3, null);
      }
      if (!best) return null;
      spot.code = best;
      return spot;
    };
    // how far inside (−) or outside the nearest own drop-off's unloading radius a spot is
    const dropGap = (x, z, t, own) => {
      let best = Infinity;
      for (const b of drops) {
        if (alive(b, t) && ownerAt(b, t) === own) {
          const lb = locate(b, t);
          best = Math.min(best, Math.hypot(lb.x - x, lb.z - z) - (/town_center/.test(b.bp) ? 13 : 8.5));
        }
      }
      return best;
    };
    const work = new Map(); // map object → [start, end, villager id, …] of the stands at it
    for (const v of this.ents) {
      if (v.cat !== 'villager' || /mounted/.test(v.bp)) continue;
      const n = v.t.length, job = new Uint8Array(n), jx = new Float32Array(n), jz = new Float32Array(n);
      const t0s = new Float64Array(n), t1s = new Float64Array(n), out = new Uint8Array(n), stands = [];
      for (let i = 0; i < n;) {
        let j = i;
        while (j + 1 < n && Number.isNaN(v.seg[j])) j++;
        const t = v.t[i], end = j + 1 < n ? v.t[j + 1] : v.died ?? this.t1;
        const w = end - t >= 1 ? jobAt(v.x[i], v.z[i], t, end) : null;
        for (let k = i; k <= j; k++) {
          t0s[k] = t; t1s[k] = end;
          if (w) { job[k] = w.code; jx[k] = w.x; jz[k] = w.z; }
        }
        stands.push({ i, j, t, end, code: w ? w.code : 0 });
        const g = w?.g;
        if (g) {
          const l = work.get(g);
          if (l) l.push(t, end - SAMPLE, v.id); else work.set(g, [t, end - SAMPLE, v.id]);
          if (w.code === J_WOOD && t < g.chopT0) { g.chopT0 = t; g.chopBy = v.id; g.chopX = v.x[i]; g.chopZ = v.z[i]; }
        }
        i = j + 1;
      }
      // the trip from each work stand to the next: the load to the drop-off, or the tool through a short break
      let carry = 0, worked = 0;
      for (let s = 0; s < stands.length; s++) {
        const A = stands[s];
        if (!A.code) continue;
        if (JOBS[A.code].carry) { if (carry !== A.code) worked = 0; carry = A.code; worked += A.end - A.t - SAMPLE; }
        let nb = s + 1;
        while (nb < stands.length && !stands[nb].code) nb++;
        const B = stands[nb], j0 = A.j + 1, j1 = (B ? B.i : n) - 1;
        if (B && j0 > j1) { // stepped straight to the next spot
          if (B.code === A.code) out.fill(HOLD + A.code, A.i, A.j + 1);
        } else if (carry && worked >= CARRY_MIN) {
          const own = ownerAt(v, A.t);
          let drop = j1 + 1;
          for (let k = j0; k <= j1; k++) {
            const g = dropGap(v.x[k], v.z[k], v.t[k], own);
            if (g <= 0 && (k === j1 || dropGap(v.x[k + 1], v.z[k + 1], v.t[k + 1], own) >= g - 0.05)) { drop = k; break; }
          }
          out.fill(CARRY + carry, A.i, A.j + 1);
          job.fill(CARRY + carry, j0, drop);
          if (drop <= j1) { carry = 0; worked = 0; }
        } else if (B && B.code === A.code && B.t - (A.end - SAMPLE) <= HOLD_MAX) {
          out.fill(HOLD + A.code, A.i, A.j + 1);
          job.fill(HOLD + A.code, j0, j1 + 1);
        }
        s = nb - 1;
      }
      v.job = job; v.jobX = jx; v.jobZ = jz; v.jobT0 = t0s; v.jobT1 = t1s; v.jobOut = out;
    }
    for (const [g, l] of work) {
      const ord = Array.from({ length: l.length / 3 }, (_, k) => 3 * k).sort((a, b) => l[a] - l[b]);
      g.workT0 = Float64Array.from(ord, (k) => l[k]);
      g.workT1 = Float64Array.from(ord, (k) => l[k + 1]);
      g.workBy = Int32Array.from(ord, (k) => l[k + 2]);
    }
  }

  ageOf(player, t) {
    const a = this.ageT.get(player);
    if (!a) return 1;
    let n = 1;
    for (const at of a) if (at <= t) n++;
    return n;
  }

  /**
   * Player idx's camera at t: { x, y, z, q: [w, x, y, z], fov } in world coordinates (z not mirrored), or null before
   * its first sample or without camera records. A sample one tick after the last is continuous movement and is eased
   * into; after a longer gap the camera jumped (a hotkey, the minimap) and holds until the new sample's time. The
   * game's own replay camera skips those jumps.
   */
  cameraAt(idx, t) {
    const cam = this.cameras.get(idx);
    const i = cam ? idxAt(cam.t, t) : -1;
    if (i < 0) return null;
    const e = cam.eye, qa = cam.rots[cam.rot[i]];
    let x = e[3 * i], y = e[3 * i + 1], z = e[3 * i + 2], q = qa;
    if (i + 1 < cam.t.length && cam.t[i + 1] - cam.t[i] <= CAM_TICK) {
      const a = (t - cam.t[i]) / (cam.t[i + 1] - cam.t[i]);
      x += (e[3 * i + 3] - x) * a; y += (e[3 * i + 4] - y) * a; z += (e[3 * i + 5] - z) * a;
      const qb = cam.rots[cam.rot[i + 1]];
      if (qb !== qa) {
        const s = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3] < 0 ? -1 : 1;
        const m = qa.map((v, j) => v + (s * qb[j] - v) * a), n = Math.hypot(...m);
        q = m.map((v) => v / n);
      }
    }
    return { x, y, z, q, fov: cam.fov };
  }

  /** Visual tier: buildings follow the owner's age; units their bp tier, age (villagers/scouts/monks), upgrades. */
  tierAt(e, t) {
    if (e.isBuilding) return this.ageOf(e.pown, t);
    let tier = e.tier;
    if (e.followsAge) tier = Math.max(tier, this.ageOf(e.pown, t));
    if (e.ups) for (const [ut, ti] of e.ups) if (ut <= t && ti > tier) tier = ti;
    return tier;
  }

  /**
   * Where unit e supervises a building ([inference] the replay records no ability use, so a stay reads as one):
   * spans { t0, t1, b } where e stays within SUP_STILL m of where it stopped for at least SUP_MIN s, next to the nearest
   * of its owner's finished buildings (centre within footprint + SUP_REACH m; not walls or farms) but not at its centre
   * (inside it). Memoized on e.sup.
   */
  supervision(e) {
    if (e.sup) return e.sup;
    const out = [], blds = this.ents.filter((b) => b.isBuilding && b.owner === e.owner && !/farm|palisade|wall|gate|bastion|marker/.test(b.bp));
    for (let i = 0; i < e.t.length;) {
      let j = i;
      while (j + 1 < e.t.length && Math.hypot(e.x[j + 1] - e.x[i], e.z[j + 1] - e.z[i]) <= SUP_STILL) j++;
      const t0 = e.t[i], t1 = j + 1 < e.t.length ? e.t[j + 1] : (e.died ?? e.t[j]);
      if (t1 - t0 >= SUP_MIN) {
        let best = null, bd = Infinity;
        for (const b of blds) {
          if (!alive(b, t0) || b.builtAt > t0) continue;
          const L = locate(b, t0), d = Math.hypot(L.x - e.x[i], L.z - e.z[i]);
          if (d < bd && d <= footprint(b.bp) + SUP_REACH) { best = b; bd = d; }
        }
        if (best && bd >= SUP_INSIDE) out.push({ t0, t1: Math.min(t1, best.died ?? Infinity), b: best });
      }
      i = j + 1;
    }
    return (e.sup = out);
  }

  /**
   * A building's trips (Mongol buildings pack into a cart, roll and unpack; the recording keeps the one entity and
   * blueprint and only its position changes): [{ p0, t0, t1, u1, h0, h1 }], packing from p0, rolling from t0 to t1,
   * unpacking until u1, h0/h1 the headings (atan2(dx, dz)) it sets off and arrives on. See PACK_SECS; a pack starts
   * no earlier than the building stood complete, and one first seen rolling (a Mongol start) did not pack. Memoized on
   * e.trips ([] for one that never moves).
   */
  trips(e) {
    if (e.trips) return e.trips;
    const out = [], unpacked = (a, b) => b - a >= PACK_SECS + UNPACK_SECS || !!e.cons?.some((c) => c > a && c < b);
    if (e.isBuilding) for (let i = 1; i < e.t.length; i++) {
      const dx = e.x[i] - e.x[i - 1], dz = e.z[i] - e.z[i - 1];
      if (Math.hypot(dx, dz) <= ROLL_STEP) continue;
      const h = Math.atan2(dx, dz), t0 = Math.max(e.t[i - 1], e.t[i] - SAMPLE), last = out[out.length - 1]; // locate() moves over the last SAMPLE
      if (last && !unpacked(last.t1, t0)) { last.t1 = e.t[i]; last.h1 = h; continue; }
      out.push({ p0: t0, t0, t1: e.t[i], u1: 0, h0: h, h1: h });
    }
    let free = e.spans[0];
    for (const r of out) {
      if (r.t0 - free >= 1) r.p0 = Math.min(r.t0, Math.max(free, e.builtAt, r.t0 - PACK_SECS));
      r.u1 = e.cons?.find((c) => c > r.t1 && c <= r.t1 + UNPACK_MAX) ?? r.t1 + UNPACK_SECS;
      free = r.u1;
    }
    return (e.trips = out);
  }

  /** Display name at t: the blueprint's name with the tier its owner's unit upgrades reached (2D model.js nameAt). */
  nameAt(e, t) {
    let tier = e.tier, name = e.name;
    if (e.ups) for (const u of e.ups) if (u[0] <= t && u[1] > tier) { tier = u[1]; name = u[2]; }
    return name;
  }

  // A gate placed inside a wall line is first seen as a plain wall foundation; its construction event names the gate.
  fixGates(constructions) {
    for (const c of constructions) {
      const f = c.fields ?? {}, pbg = f.pbg ?? '';
      const e = pbg.includes('gate') && f.entity ? this.byId.get(+f.entity.slice(1)) : null;
      if (!e || /gate/.test(e.bp)) continue;
      e.bp = pbg.replace(/^b(?=building_)/, '');
      e.name = prettify(e.bp);
    }
  }

  // bupgrade_unit_spearman_2 raises every unit_spearman_* of the researching player to tier 2.
  // e.ups: [time, tier, name] of the owner's later upgrades of the unit's line.
  unitUpgrades(upgrades) {
    const by = new Map();
    for (const u of upgrades) {
      const f = u.fields ?? {}, mm = /^bupgrade_(unit_.*)$/.exec(f.upgrade ?? ''), tm = mm && TIER.exec(mm[1]);
      const ex = tm && /^e\d+$/.test(f.executer ?? '') ? this.byId.get(+f.executer.slice(1)) : null;
      if (!ex) continue;
      const key = `${ownerAt(ex, u.t)}|${tm[1]}`;
      if (!by.has(key)) by.set(key, []);
      by.get(key).push([u.t, +tm[2]]);
    }
    for (const e of this.ents) {
      const list = e.line && by.get(`${e.owner}|${e.line}`);
      if (!list) continue;
      const ups = list.filter((u) => u[1] > e.tier).sort((a, b) => a[0] - b[0])
        .map(([t, tier]) => [t, tier, prettify(e.bp.replace(/_[1-5](?=_|$)/, `_${tier}`))]);
      if (ups.length) e.ups = ups;
    }
  }

  // Completion time: first full-HP sample, else the (last) construction event, else never (still a construction site).
  // Every entity's construction event times go on e.cons (Replay.trips: a Mongol building logs one as it unpacks).
  constructionTimes(constructions) {
    for (const c of constructions) {
      const id = /^e(\d+)$/.exec(c.fields?.entity ?? ''), e = id && this.byId.get(+id[1]);
      if (e) (e.cons ??= []).push(c.t);
    }
    for (const e of this.ents) {
      if (!e.isBuilding) continue;
      let full = -1;
      for (let i = 0; i < e.hp.length; i++) if (e.hp[i] >= e.maxhp - 0.5) { full = i; break; }
      if (full === 0) e.builtAt = -Infinity;
      else if (full > 0) e.builtAt = e.t[full];
      else e.builtAt = e.cons ? e.cons[e.cons.length - 1] : Infinity;
    }
  }

  /**
   * Wall shapes (e.wall, read through wallAt) for straight pieces and gates; posts keep their own. Pieces of one owner
   * closer than WALL_LINK are linked, except across a third piece nearer to both on the line between them (the short
   * piece before a line's end post, the post where a line goes on); a link holds while both ends and nothing between
   * them stand. A piece lies along its most opposite pair of holding links (a third link is another line meeting it),
   * else along the doubled-angle mean of them (the 2D gate rule; of all its links while none hold). A straight piece
   * reaches each way to its nearest joint along both pieces' lines: halfway to the next straight piece, WALL_TUCK into a
   * post or a gate's tower (stretching over a short recorded gap), RUN_HALF with no joint that way; a link that holds
   * only because the piece between fell never lengthens it past RUN_HALF (the gap stays open). Gates keep their size,
   * so the pieces beside them end at their towers; a slot's foundation left inside a tower, or under a gate built over
   * it, is not drawn. An end with no standing link on its side (none within WALL_FREE of the line) is free: no wall
   * goes on there, so the game plants gap-filler stakes from it to a nearby obstacle (F bit 1: +axis end, 2: −axis).
   * Posts keep their links as e.arms ({ o, ux, uz, L, sh }; one holds at t while o and none of sh stand): the walls
   * leaving a post, around which it plants no stakes. Shapes change only when a wall piece appears or goes, so they
   * are tabled per change.
   */
  linkWalls() {
    const W = this.ents.filter((e) => e.isBuilding && WALL_BP.test(e.bp)), S = W.filter((e) => !WALL_NODE.test(e.bp));
    const dist = (a, b) => Math.hypot(b.x[0] - a.x[0], b.z[0] - a.z[0]);
    const links = new Map(W.map((e) => [e, []])); // piece → [{ o: other end, ux, uz: unit direction to it, L, sh: pieces between }]
    for (let i = 0; i < W.length; i++) for (let j = i + 1; j < W.length; j++) {
      const a = W[i], b = W[j], L = dist(a, b);
      if (a.owner !== b.owner || L <= 0.5 || L > WALL_LINK || (WALL_NODE.test(a.bp) && WALL_NODE.test(b.bp))) continue;
      const ux = (b.x[0] - a.x[0]) / L, uz = (b.z[0] - a.z[0]) / L;
      const sh = W.filter((c) => c !== a && c !== b && c.owner === a.owner && Math.min(dist(a, c), dist(b, c)) > 0.5
        && Math.max(dist(a, c), dist(b, c)) < L && Math.abs(ux * (c.z[0] - a.z[0]) - uz * (c.x[0] - a.x[0])) < WALL_SIDE);
      links.get(a).push({ o: b, ux, uz, L, sh });
      links.get(b).push({ o: a, ux: -ux, uz: -uz, L, sh });
    }
    for (const e of W) if (WALL_NODE.test(e.bp)) e.arms = links.get(e);
    // the line through a piece: its most opposite pair of links (a third link is another line meeting it), else all
    const axis = (list) => {
      let best = -WALL_ALONG, use = list;
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const d = list[i].ux * list[j].ux + list[i].uz * list[j].uz;
        if (d < best) { best = d; use = [list[i], list[j]]; }
      }
      let c = 0, s = 0;
      for (const n of use) { const th = Math.atan2(-n.uz, n.ux); c += Math.cos(2 * th); s += Math.sin(2 * th); }
      return Math.hypot(c, s) > 1e-6 ? Math.atan2(s, c) / 2 : null; // model +X along (dx, dz) is rotation.y atan2(-dz, dx)
    };
    const along = (n, a) => n.ux * Math.cos(a) - n.uz * Math.sin(a); // link direction · the axis at turn a
    const a0 = new Map(S.map((e) => [e, axis(links.get(e)) ?? 0])), rows = new Map(S.map((e) => [e, []]));
    const under = new Map(S.map((e) => [e, WALL_GATE.test(e.bp) ? [] : W.filter((g) => WALL_GATE.test(g.bp) && g.owner === e.owner && dist(e, g) <= 0.5)]));
    const T = [...new Set(W.flatMap((e) => [...e.spans]))].filter(Number.isFinite).sort((p, q) => p - q);
    const on = new Map(), turn = new Map();
    for (const t of T) {
      on.clear(); turn.clear();
      for (const e of S) {
        if (!alive(e, t)) continue;
        const l = links.get(e).filter((n) => alive(n.o, t) && !n.sh.some((c) => alive(c, t)));
        on.set(e, l); turn.set(e, axis(l) ?? a0.get(e));
      }
      for (const [e, l] of on) {
        const a = turn.get(e);
        let len = 2 * wallHalf(e.bp), off = 0, free = 3;
        for (const n of l) { const dot = along(n, a); if (dot > WALL_FREE) free &= ~1; else if (dot < -WALL_FREE) free &= ~2; }
        if (!WALL_GATE.test(e.bp)) {
          let p = Infinity, m = Infinity;
          for (const n of l) {
            // a joint needs the link along both pieces' lines; across it is a corner, where the recorded lines put a post
            const dot = along(n, a);
            if (Math.abs(dot) < WALL_ALONG || (turn.has(n.o) && Math.abs(along(n, turn.get(n.o))) < WALL_ALONG)) continue;
            const run = turn.has(n.o) && !WALL_GATE.test(n.o.bp), far = Math.abs(dot) * n.L; // far: the other end's centre on the axis
            const j = Math.min(run ? far / 2 : far - wallHalf(n.o.bp) + WALL_TUCK, n.sh.length ? RUN_HALF : Infinity);
            if (dot > 0) p = Math.min(p, j); else m = Math.min(m, j);
          }
          if (p === Infinity) p = RUN_HALF;
          if (m === Infinity) m = RUN_HALF;
          len = p + m < WALL_MIN || under.get(e).some((g) => alive(g, t)) ? 0 : p + m; off = (p - m) / 2;
        }
        const r = rows.get(e), last = r.at(-1);
        if (!last || last[1] !== a || last[2] !== len || last[3] !== off || last[4] !== free) r.push([t, a, len, off, free]);
      }
    }
    for (const [e, r] of rows) {
      e.wall = {
        T: Float64Array.from(r, (x) => x[0]), A: Float64Array.from(r, (x) => x[1]), L: Float64Array.from(r, (x) => x[2]),
        O: Float64Array.from(r, (x) => x[3]), F: Uint8Array.from(r, (x) => x[4]),
      };
    }
  }
}
