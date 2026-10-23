"use strict";
// Timeline data model: typed arrays per entity plus time queries used by the map, timeline and panels.
window.RV = window.RV || {};
(function (RV) {
  const SAMPLE = 0.5; // recorder sample interval (s)
  const ROMAN = ["", "I", "II", "III", "IV", "V"];
  const DROP = new Set(["unit", "building", "control", "econ", "naval", "landmark", "capital", "gaia", "herdable",
    "eng", "fre", "hre", "ha", "mon", "chi", "rus", "abb", "del", "sul", "mal", "ott", "byz", "jpn", "ayy", "kte",
    "zxl", "hol", "lan", "jdk", "tug", "hoj", "mac", "sen", "jin", "grassland", "dragon", "01", "02", "03"]);
  const ALIAS = { manatarms: "Man-at-Arms", maa: "Man-at-Arms" };
  // wpn_range_town_center_arrows_garrison_non_capital_additional_tc -> "Town Center Arrows"
  const WPN_DROP = new Set(["wpn", "range", "garrison", "non", "capital", "additional", "tc", "a", "b", "incen"]);

  RV.prettify = function (bp) {
    let tokens = bp.toLowerCase().split("_");
    if (tokens[0] === "wpn") tokens = tokens.filter(tok => !WPN_DROP.has(tok));
    let age = "";
    const out = [];
    for (const tok of tokens) {
      if (/^[1-5]$/.test(tok) && !age) { age = ROMAN[+tok]; continue; }
      if (/^age\d$/.test(tok) || DROP.has(tok)) continue;
      out.push(ALIAS[tok] || tok.charAt(0).toUpperCase() + tok.slice(1));
    }
    return (out.join(" ") || bp) + (age ? " " + age : "");
  };

  RV.idxAt = function (arr, t) {
    let lo = 0, hi = arr.length - 1, r = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (arr[m] <= t) { r = m; lo = m + 1; } else hi = m - 1;
    }
    return r;
  };

  RV.fmtTime = function (t) {
    t = Math.max(0, t);
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
  };

  // Unit icon type for the map figures (map.js UNIT_TYPES): the type of the first rule in the classification shared
  // with tools/convert.py (units.js) that matches the blueprint; null for unmatched ones, drawn by their category.
  const UNIT_RULES = window.RV_UNITS.rules.map(([rx, , type]) => [new RegExp(rx), type]);
  RV.unitType = function (bp, cat) {
    if (!RV.isUnit(cat) || cat === "livestock") return null;
    const name = bp.toLowerCase();
    for (const [re, type] of UNIT_RULES) if (re.test(name)) return type;
    return null;
  };

  // Building kind for map icons (map.js BUILDING_TYPES), first match wins. Production buildings are named after what
  // they train (building_unit_infantry_control = barracks); tech_unit_infantry is the blacksmith.
  const BUILDING_RULES = [
    [/viz_|pavise|grassland|marker|dropped_banner/, "other"],
    [/town_center/, "tc"],
    [/landmark|wonder/, "landmark"],
    [/keep|fortress|wooden_fort|castle/, "keep"],
    [/aqueduct/, "aqueduct"],
    [/gate/, "gate"],
    [/wall|palisade/, "wall"],
    [/outpost|tower/, "tower"],
    [/farm|pasture|ranch/, "farm"],
    [/mercenary_house|warcamp/, "barracks"],
    [/house|manor|dynasty_village/, "house"],
    [/tech_unit_infantry|blacksmith/, "blacksmith"],
    [/university|military_school/, "university"],
    [/market/, "market"],
    [/unit_infantry|barracks/, "barracks"],
    [/unit_range|archery_range/, "range"],
    [/unit_cavalry|stable/, "stable"],
    [/unit_siege|siege_workshop|machine_workshop/, "workshop"],
    [/unit_religious|monastery|mosque|shrine/, "monastery"],
    [/unit_naval|dock/, "dock"],
    [/econ_food|mill|hunting_cabin/, "mill"],
    [/econ_wood|lumber/, "lumber"],
    [/mining|open_pit|deposit/, "mining"],
  ];
  RV.buildingKind = function (bp) {
    for (const [re, kind] of BUILDING_RULES) if (re.test(bp)) return kind;
    return "other";
  };

  // Line of sight in world units per map kind: the most common sight.line in aoe4world's unit and building data
  // (data.aoe4world.com) among the blueprints of that kind in the recorded games. Fog of war (map.js drawFog) clears
  // this radius around the viewed players' units and buildings; elevation bonuses and sight upgrades are left out.
  const UNIT_SIGHT = {
    villager: 28, spear: 36, maa: 36, sword: 36, archer: 36, crossbow: 40, gun: 32, horseman: 28, knight: 28, horsearcher: 36,
    elephant: 36, scout: 41, monk: 30, siege: 56, ram: 30, ship: 32, fishboat: 33, trader: 35, hero: 41,
  };
  const BUILDING_SIGHT = {
    tc: 52, landmark: 25, keep: 41, tower: 60, dock: 50, wall: 6, gate: 20, aqueduct: 6, farm: 0, house: 15, mill: 15,
    lumber: 15, mining: 15,
  };
  function sightOf(e) {
    if (e.bkind) return BUILDING_SIGHT[e.bkind] ?? 25;
    return e.type ? UNIT_SIGHT[e.type] : 0;
  }

  function prepEnt(r) {
    const n = r.track.length / 4;
    const t = new Float64Array(n), x = new Float32Array(n), z = new Float32Array(n), hp = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      t[i] = r.track[4 * i]; x[i] = r.track[4 * i + 1]; z[i] = r.track[4 * i + 2]; hp[i] = r.track[4 * i + 3];
    }
    const spans = new Float64Array(r.spans.length * 2);
    r.spans.forEach((s, i) => { spans[2 * i] = s[0]; spans[2 * i + 1] = s[1] == null ? Infinity : s[1]; });
    let ownT = null, ownV = null;
    if (r.owners) { ownT = Float64Array.from(r.owners.map(o => o[0])); ownV = Int32Array.from(r.owners.map(o => o[1])); }
    let visT = null, visM = null;
    if (r.vision) {
      const k = r.vision.length / 2;
      visT = new Float64Array(k); visM = new Int32Array(k);
      for (let i = 0; i < k; i++) { visT[i] = r.vision[2 * i]; visM[i] = r.vision[2 * i + 1]; }
    }
    const tier = TIER.exec(r.bp), name = RV.prettify(r.bp);
    return {
      id: r.id, owner: r.owner, bp: r.bp, cat: r.cat, type: RV.unitType(r.bp, r.cat), name,
      bkind: r.cat === "building" ? RV.buildingKind(r.bp) : null,
      maxhp: r.maxhp, squad: r.squad,
      spans, killed: r.killed, killer: r.killer, value: r.value || 0,
      born: spans[0], died: r.killed ? spans[spans.length - 1] : null, defeated: false,
      t, x, z, hp, ownT, ownV, visT, visM,
      line: tier ? tier[1] : null, tier: tier ? +tier[2] : 0, ups: null,
      on: false, px: 0, pz: 0, php: 0, pown: r.owner, ptier: tier ? +tier[2] : 0, pname: name, seen: false, sight: 0,
    };
  }

  // A defeated player's whole estate leaves the game at one tick without a single kill: the recorder's scan stops
  // seeing it (killed is false, the span just closes ~10 s before the game ends). When DEFEAT_MIN or more entities of
  // one owner close at the same tick without a kill and that owner has nothing left standing afterwards, they were
  // destroyed then: died is the close time and defeated is set. Garrison, despawn and upgrade closes are single or
  // scattered, and the owner keeps other entities. (viewer3d/core/replay.js markDefeats is the 3D twin.)
  const DEFEAT_MIN = 5;
  function markDefeats(ents) {
    const groups = new Map(); // "close time|owner at close" -> entities closing then without a kill
    for (const e of ents) {
      const end = e.spans[e.spans.length - 1];
      if (e.killed || end === Infinity) continue;
      const key = end + "|" + RV.ownerAt(e, end), l = groups.get(key);
      if (l) l.push(e); else groups.set(key, [e]);
    }
    for (const [key, list] of groups) {
      if (list.length < DEFEAT_MIN) continue;
      const end = list[0].spans[list[0].spans.length - 1], owner = +key.slice(key.indexOf("|") + 1);
      if (ents.some(e => RV.alive(e, end) && RV.ownerAt(e, end) === owner)) continue;
      for (const e of list) { e.died = end; e.defeated = true; }
    }
  }

  // Tier (age) of a unit at time t, and its name with that tier: the recorder keeps each entity's first blueprint
  // (unit_spearman_2_sul), but a unit upgrade (bupgrade_unit_spearman_3_sul) raises every unit of that line its player
  // owns. e.ups: [time, tier, name] of the owner's later upgrades of the unit's line (RV.prepare).
  const TIER = /^(.*?)_([1-5])(?=_|$)/;
  RV.tierAt = function (e, t) {
    let tier = e.tier;
    if (e.ups) for (const u of e.ups) if (u[0] <= t && u[1] > tier) tier = u[1];
    return tier;
  };
  RV.nameAt = function (e, t) {
    let tier = e.tier, name = e.name;
    if (e.ups) for (const u of e.ups) if (u[0] <= t && u[1] > tier) { tier = u[1]; name = u[2]; }
    return name;
  };
  function unitUpgrades(M, upgrades) {
    const by = new Map(); // "owner|line" -> [[t, tier]]
    for (const u of upgrades || []) {
      const f = u.fields || {}, m = /^bupgrade_(unit_.*)$/.exec(f.upgrade || ""), tm = m && TIER.exec(m[1]);
      const ex = tm && /^e\d+$/.test(f.executer || "") ? M.byId.get(+f.executer.slice(1)) : null;
      if (!ex) continue;
      const key = RV.ownerAt(ex, u.t) + "|" + tm[1];
      if (!by.has(key)) by.set(key, []);
      by.get(key).push([u.t, +tm[2]]);
    }
    for (const e of M.ents) {
      const list = e.tier && by.get(e.owner + "|" + e.line);
      if (!list) continue;
      const ups = list.filter(u => u[1] > e.tier).sort((a, b) => a[0] - b[0])
        .map(([t, tier]) => [t, tier, RV.prettify(e.bp.replace(/_[1-5](?=_|$)/, "_" + tier))]);
      if (ups.length) e.ups = ups;
    }
  }

  // Wall pieces (walls, gates, aqueducts) of one owner within WALL_LINK world units of each other, as a flat list of
  // entity pairs; the map joins each pair with a line while both stand. Palisade pieces sit about 6 apart.
  const WALL_LINK = 6.6;
  function wallLinks(ents) {
    const cells = new Map(), cell = (x, z) => Math.floor(x / WALL_LINK) * 65536 + Math.floor(z / WALL_LINK);
    const walls = ents.filter(e => e.bkind === "wall" || e.bkind === "gate" || e.bkind === "aqueduct");
    for (const e of walls) {
      const k = cell(e.x[0], e.z[0]);
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(e);
    }
    const links = [];
    for (const a of walls) {
      const cx = Math.floor(a.x[0] / WALL_LINK), cz = Math.floor(a.z[0] / WALL_LINK);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        for (const b of cells.get((cx + dx) * 65536 + cz + dz) || []) {
          if (b.id <= a.id || b.owner !== a.owner || (a.bkind === "aqueduct") !== (b.bkind === "aqueduct")) continue;
          const d = Math.hypot(a.x[0] - b.x[0], a.z[0] - b.z[0]);
          if (d > 0.5 && d <= WALL_LINK) links.push(a, b);
        }
      }
    }
    return links;
  }

  // Screen angle (radians, z drawn upwards) of the wall line through each gate, from its links: doubled angles average
  // the two directions of a straight wall into one, so a gate between two pieces lies along them.
  function gateAngles(links) {
    const acc = new Map();
    for (let i = 0; i < links.length; i += 2) {
      const a = links[i], b = links[i + 1], th = Math.atan2(-(b.z[0] - a.z[0]), b.x[0] - a.x[0]);
      for (const e of [a, b]) {
        if (e.bkind !== "gate") continue;
        const v = acc.get(e) || [0, 0];
        v[0] += Math.cos(2 * th); v[1] += Math.sin(2 * th);
        acc.set(e, v);
      }
    }
    for (const [e, [c, s]] of acc) e.wallAng = Math.atan2(s, c) / 2;
  }

  // Neutral map objects (trees, mines, berries, animals, relics, sacred sites) from d.gaia; see tools/convert.py gaia_data.
  const GAIA_PREFIX = /^(resource_food_forage_|resource_|gaia_huntable_|gaia_herdable_|gaia_)/;
  function prepGaia(g) {
    if (!g) return [];
    const types = g.types.map(([bp, kind]) => ({ bp, kind, name: RV.prettify(bp.replace(GAIA_PREFIX, "")) }));
    return g.ents.map(([id, ti, x, z, amount, spans, amounts, track]) => {
      const ty = types[ti];
      const sp = Float64Array.from(spans, v => (v == null ? Infinity : v));
      let amT = null, amV = null, trT = null, trX = null, trZ = null;
      if (amounts) {
        const k = amounts.length / 2;
        amT = new Float64Array(k); amV = new Float32Array(k);
        for (let i = 0; i < k; i++) { amT[i] = amounts[2 * i]; amV[i] = amounts[2 * i + 1]; }
      }
      if (track) {
        const k = track.length / 3;
        trT = new Float64Array(k); trX = new Float32Array(k); trZ = new Float32Array(k);
        for (let i = 0; i < k; i++) { trT[i] = track[3 * i]; trX[i] = track[3 * i + 1]; trZ[i] = track[3 * i + 2]; }
      }
      return {
        gaia: true, id, bp: ty.bp, kind: ty.kind, name: ty.name, x, z, amount0: amount, spans: sp,
        amT, amV, trT, trX, trZ, on: false, px: x, pz: z, amount,
      };
    });
  }

  const GAIA_MOVE = 1; // recorder samples neutral movers every second
  function locateGaia(g, t) {
    if (g.amT) {
      const i = RV.idxAt(g.amT, t);
      g.amount = i < 0 ? g.amount0 : g.amV[i];
    }
    if (!g.trT) return;
    const i = RV.idxAt(g.trT, t);
    if (i < 0) { g.px = g.x; g.pz = g.z; return; }
    let x = g.trX[i], z = g.trZ[i];
    if (i + 1 < g.trT.length) {
      const t1 = g.trT[i + 1], ts = Math.max(g.trT[i], t1 - GAIA_MOVE);
      if (t > ts) {
        const a = (t - ts) / (t1 - ts);
        x += (g.trX[i + 1] - x) * a;
        z += (g.trZ[i + 1] - z) * a;
      }
    }
    g.px = x; g.pz = z;
  }

  RV.prepare = function (d, opts) {
    const M = { d, duration: d.duration, world: d.world, players: d.players, fights: d.fights, army: d.army, techs: d.techs || [] };
    M.playerByIdx = new Map(d.players.map(p => [p.idx, p]));
    M.teams = [...new Set(d.players.map(p => p.team))].sort((a, b) => a - b);
    M.teamMask = new Map(M.teams.map(tm => [tm, d.players.filter(p => p.team === tm).reduce((m, p) => m | (1 << (p.idx - 1)), 0)]));
    M.allMask = d.players.reduce((m, p) => m | (1 << (p.idx - 1)), 0);
    M.ents = d.entities.map(prepEnt);
    markDefeats(M.ents);
    M.byId = new Map(M.ents.map(e => [e.id, e]));
    // A gate placed inside a wall line is first seen as a plain wall foundation; its construction event names the gate.
    for (const c of d.constructions || []) {
      const f = c.fields || {}, pbg = f.pbg || "";
      const e = pbg.includes("gate") && f.entity ? M.byId.get(+f.entity.slice(1)) : null;
      if (!e || e.bkind === "gate") continue;
      e.bp = pbg.replace(/^b(?=building_)/, "");
      e.name = e.pname = RV.prettify(e.bp);
      e.bkind = "gate";
    }
    unitUpgrades(M, d.upgrades);
    M.wallLinks = wallLinks(M.ents);
    gateAngles(M.wallLinks);
    for (const e of M.ents) e.sight = sightOf(e);
    M.explored = new Map();
    M.squads = new Map();
    for (const e of M.ents) {
      if (!e.squad) continue;
      if (!M.squads.has(e.squad)) M.squads.set(e.squad, []);
      M.squads.get(e.squad).push(e);
    }
    M.atkT = Float64Array.from(d.attacks.times);
    M.atkP = d.attacks.pairs;
    M.alerts = prepAlerts(M);
    M.alertT = Float64Array.from(M.alerts.map(a => a.t));
    M.orders = new Map();
    for (const [sid, flat] of Object.entries(d.orders || {})) {
      const k = flat.length / 3, t = new Float64Array(k), x = new Float32Array(k), z = new Float32Array(k);
      for (let i = 0; i < k; i++) {
        t[i] = flat[3 * i];
        x[i] = flat[3 * i + 1] == null ? NaN : flat[3 * i + 1];
        z[i] = flat[3 * i + 2] == null ? NaN : flat[3 * i + 2];
      }
      M.orders.set(+sid, { t, x, z });
    }
    M.kills = (d.kills || []).slice().sort((a, b) => a.t - b.t);
    M.killT = Float64Array.from(M.kills.map(k => k.t));
    M.stats = new Map();
    for (const [idx, rows] of Object.entries(d.stats || {})) {
      M.stats.set(+idx, { t: Float64Array.from(rows.map(r => r[0])), rows });
    }
    M.terrain = d.terrain || null;
    M.cameras = prepCameras(d.cameras);
    M.conversions = prepConversions(M, d.conversions);
    M.flips = prepFlips(M);
    M.gaia = prepGaia(d.gaia);
    // A captured sacred site leaves the map objects and becomes a building (cat "other") of its holder with the same id,
    // until it is lost and turns neutral again. Sites are never destroyed, so each stays one object: on from its
    // first sighting, `holder` the player owning it (0 = neutral).
    for (const o of M.gaia) if (o.kind === "sacred") { o.held = M.byId.get(o.id) || null; o.holder = 0; }
    M.sites = M.gaia.filter(o => o.kind === "sacred");
    for (const o of M.sites) prepSite(M, o);
    // The game exposes no water flag (World_GetTerrainCellType and the cover type are constant), so water is inferred:
    // below the highest fish + 0.2 is sea. On Continental fish reach height 5.1 and land units stay above 5.3.
    const fish = M.terrain ? M.gaia.filter(o => o.kind === "fish") : [];
    M.waterLevel = fish.length ? Math.max(...fish.map(o => RV.heightAt(M.terrain, o.x, o.z))) + 0.2 : null;
    // Shared combat index and FrameRenderState (frame.js): the same blows, damage numbers, heals and target-priority
    // grades the 3D viewer builds over its own entity table (it prepares this model with { combat: false }).
    if (!opts || opts.combat !== false) {
      M.combat = window.RV_FRAME.combat(M.ents, d);
      M.view = window.RV_FRAME.controller(M.combat);
    }
    return M;
  };

  // Sacred-site states. The recording has holders but no capture progress, so that is inferred from religious units
  // within SITE_R of the site. In aoe4_256829909 and aoe4_245598603, 21 holder changes have such a unit there; 18 come
  // SITE_CAPTURE ±0.5 s after it arrived, or after the site's previous change if it was already there (neutralising and
  // capturing take 30 s each); the others after 8, 26.5 and 36 s. Capturing units stand 4.5-8.1 m from the centre.
  // The other 10 changes are losses with no religious unit within 30 m (cause not in the data). Each site gets `caps`,
  // its captures [{t, owner}], `changes`, every holder change time, and `near`, the stays of religious units within
  // SITE_R: [{e, owner, team, a, b}].
  RV.SITE_CAPTURE = 30;
  const SITE_R = 10;
  function prepSite(M, o) {
    o.caps = []; o.changes = [];
    const h = o.held;
    if (h) for (let i = 0; i < h.spans.length; i += 2) {
      o.caps.push({ t: h.spans[i], owner: RV.ownerAt(h, h.spans[i]) });
      o.changes.push(h.spans[i]);
      if (h.spans[i + 1] !== Infinity) o.changes.push(h.spans[i + 1]);
    }
    o.capT = o.caps.map(c => c.t);
    o.near = [];
    for (const e of M.ents) {
      if (e.cat !== "religious") continue;
      for (let s = 0; s < e.spans.length; s += 2) {
        const s1 = e.spans[s + 1];
        let k = Math.max(0, RV.idxAt(e.t, e.spans[s])), u = e.spans[s], a = null;
        for (;;) {
          const inside = Math.hypot(e.x[k] - o.x, e.z[k] - o.z) <= SITE_R;
          if (inside && a == null) a = u;
          else if (!inside && a != null) { o.near.push(stay(M, e, a, u)); a = null; }
          if (++k >= e.t.length || e.t[k] >= s1) break;
          u = e.t[k];
        }
        if (a != null) o.near.push(stay(M, e, a, s1));
      }
    }
  }
  function stay(M, e, a, b) {
    const owner = RV.ownerAt(e, a);
    return { e, owner, team: M.playerByIdx.get(owner)?.team, a, b };
  }

  // A site's state at t: `capturer`, the player whose religious units are taking it (the first to arrive of a team
  // other than the holder's), with `progress` 0..1 to the next change; `contested` when the holder's team or a third
  // team has religious units there too (no progress shown: how the game counts that was not measured).
  RV.siteState = function (M, o, t) {
    const holderTeam = o.holder ? M.playerByIdx.get(o.holder)?.team : null;
    let cap = null, contested = false;
    for (const s of o.near) {
      if (t < s.a || t >= s.b) continue;
      if (s.team === holderTeam) { contested = true; continue; }
      if (!cap) cap = s;
      else if (s.team !== cap.team) contested = true;
      else if (s.a < cap.a) cap = s;
    }
    if (!cap) return null;
    const i = RV.idxAt(o.changes, t), from = Math.max(cap.a, i >= 0 ? o.changes[i] : -Infinity);
    return { capturer: cap.owner, unit: cap.e, contested, progress: Math.min(1, (t - from) / RV.SITE_CAPTURE) };
  };

  // "Under attack" alerts, as the game's minimap pulses them: measured on aoe4_256829909, a mark at the attacked unit
  // that pulses for ALERT_S s (8:05-8:10), repeating while the fight goes on. The rule that raises one is inferred: an
  // enemy player hits a unit or building of a player with no alert of that player within ALERT_MERGE m in the last
  // ALERT_S s. {t, owner, x, z, by: the attacking player, victim: the entity hit}, by time.
  RV.ALERT_S = 6;
  const ALERT_MERGE = RV.ALERT_MERGE = 50;
  function prepAlerts(M) {
    const out = [], last = new Map(); // owner -> alerts still running
    for (let i = 0; i < M.atkT.length; i++) {
      const t = M.atkT[i], pairs = M.atkP[i];
      for (let k = 0; k < pairs.length; k += 2) {
        const a = M.byId.get(pairs[k]), b = M.byId.get(pairs[k + 1]);
        if (!a || !b || b.cat === "livestock" || b.cat === "attachment" || b.cat === "other") continue;
        const ao = RV.ownerAt(a, t), bo = RV.ownerAt(b, t), ap = M.playerByIdx.get(ao), bp = M.playerByIdx.get(bo);
        if (!ap || !bp || ap.team === bp.team) continue;
        let live = last.get(bo);
        if (!live) last.set(bo, live = []);
        while (live.length && t - live[0].t >= RV.ALERT_S) live.shift();
        const j = sampleAt(b, t), x = b.x[j], z = b.z[j];
        if (live.some(l => Math.hypot(l.x - x, l.z - z) < ALERT_MERGE)) continue;
        const al = { t, owner: bo, x, z, by: ao, victim: b };
        live.push(al); out.push(al);
      }
    }
    return out;
  }

  // Conversions. A cast (d.conversions, tools/convert.py conversion_casts) channels for CONVERT_CHANNEL s, measured in
  // game (aoe4_256829909 13:36.0-13:42.0, the ring around the monk), ending early if the monk dies; an area cast
  // (target 0) reaches CONVERT_R m around it: monk_conversion's auraRange, 4.75 tiles of 4 m. Its targets are the
  // enemy units within reach at the cast, or the one it was aimed at; `flip` is when a target's owner turned to the
  // caster's during the channel or right after (null: resisted or died).
  RV.CONVERT_CHANNEL = 6;
  RV.CONVERT_R = 19;
  const sampleAt = (e, t) => Math.max(0, RV.idxAt(e.t, t));
  function spanEnd(e, t) {
    for (let i = 0; i < e.spans.length; i += 2) if (t >= e.spans[i] && t < e.spans[i + 1]) return e.spans[i + 1];
    return t;
  }
  function prepConversions(M, rows) {
    const out = [];
    for (const [t, cid, tid] of rows || []) {
      const c = M.byId.get(cid);
      if (!c) continue;
      const owner = RV.ownerAt(c, t), team = M.playerByIdx.get(owner)?.team;
      const end = Math.min(t + RV.CONVERT_CHANNEL, spanEnd(c, t));
      const j = sampleAt(c, t), cx = c.x[j], cz = c.z[j];
      const pool = tid ? [M.byId.get(tid)].filter(Boolean) : M.ents.filter(e => {
        if (e.cat === "building" || e.cat === "other" || e.cat === "attachment" || !RV.alive(e, t)) return false;
        if (M.playerByIdx.get(RV.ownerAt(e, t))?.team === team) return false;
        const k = sampleAt(e, t);
        return Math.hypot(e.x[k] - cx, e.z[k] - cz) <= RV.CONVERT_R;
      });
      const targets = pool.map(e => {
        let flip = null;
        if (e.ownT) for (let i = 0; i < e.ownT.length; i++) {
          if (e.ownT[i] >= t && e.ownT[i] <= end + 1 && e.ownV[i] === owner) { flip = e.ownT[i]; break; }
        }
        return { e, flip };
      });
      out.push({ t, end, caster: c, owner, targets });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  // Every owner change of a unit or building (sacred sites, cat "other", have their own marks): {t, e, from, to}.
  function prepFlips(M) {
    const out = [];
    for (const e of M.ents) {
      if (!e.ownT || e.cat === "other") continue;
      let from = e.owner;
      for (let i = 0; i < e.ownT.length; i++) {
        if (e.ownV[i] !== from) out.push({ t: e.ownT[i], e, from, to: e.ownV[i] });
        from = e.ownV[i];
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }

  // Bilinear terrain height at world (x, z) from the recorder's grid (samples at cell centres).
  RV.heightAt = function (T, x, z) {
    const fx = Math.min(T.cols - 1, Math.max(0, (x - T.x0) / T.step)), fz = Math.min(T.rows - 1, Math.max(0, (z - T.z0) / T.step));
    const c = Math.min(T.cols - 2, Math.floor(fx)), r = Math.min(T.rows - 2, Math.floor(fz)), ax = fx - c, az = fz - r;
    const h = T.h, i = r * T.cols + c;
    return (h[i] * (1 - ax) + h[i + 1] * ax) * (1 - az) + (h[i + T.cols] * (1 - ax) + h[i + T.cols + 1] * ax) * az;
  };

  // Each player's camera (convert.py camera_tracks): sample times, eyes (x, y, z per sample), orientation indices.
  function prepCameras(cams) {
    const out = new Map();
    for (const [idx, c] of Object.entries(cams || {})) {
      const n = c.track.length / 5, t = new Float64Array(n), eye = new Float32Array(3 * n), rot = new Uint16Array(n);
      for (let i = 0; i < n; i++) {
        t[i] = c.track[5 * i];
        eye[3 * i] = c.track[5 * i + 1]; eye[3 * i + 1] = c.track[5 * i + 2]; eye[3 * i + 2] = c.track[5 * i + 3];
        rot[i] = c.track[5 * i + 4];
      }
      out.set(+idx, { fov: c.fov, rots: c.rots, t, eye, rot });
    }
    return out;
  }

  const CAM_TICK = 1 / 8 + 1e-6;
  // A player's camera at t: { x, y, z, q: [w, x, y, z], fov }, or null before the first sample. A sample one tick
  // after the last is continuous movement and is eased into; after a longer gap the camera jumped (a hotkey, the
  // minimap) and holds until the new sample's time. The game's own replay camera skips those jumps.
  RV.cameraAt = function (cam, t) {
    const i = RV.idxAt(cam.t, t);
    if (i < 0) return null;
    const e = cam.eye, qa = cam.rots[cam.rot[i]];
    let x = e[3 * i], y = e[3 * i + 1], z = e[3 * i + 2], q = qa;
    if (i + 1 < cam.t.length && cam.t[i + 1] - cam.t[i] <= CAM_TICK) {
      const a = (t - cam.t[i]) / (cam.t[i + 1] - cam.t[i]);
      x += (e[3 * i + 3] - x) * a; y += (e[3 * i + 4] - y) * a; z += (e[3 * i + 5] - z) * a;
      const qb = cam.rots[cam.rot[i + 1]];
      if (qb !== qa) {
        const s = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3] < 0 ? -1 : 1;
        const m = qa.map((v, k) => v + (s * qb[k] - v) * a), n = Math.hypot(...m);
        q = m.map(v => v / n);
      }
    }
    return { x, y, z, q, fov: cam.fov };
  };

  // v rotated by the unit quaternion q = [w, x, y, z].
  RV.rotate = function (q, vx, vy, vz) {
    const [w, x, y, z] = q;
    const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
    return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
  };

  // The ground a camera sees: [x, z] at its four screen corners and the centre, where the view rays meet the plane at
  // the terrain height under the view centre. The record holds no screen shape, so a 16:9 screen is assumed, with the
  // record's fov as the vertical angle. Rays at or above the horizon are cut at `far` metres.
  RV.viewFootprint = function (c, T, aspect = 16 / 9, far = 400) {
    const f = RV.rotate(c.q, 0, 0, 1), u = RV.rotate(c.q, 0, 1, 0), r = RV.rotate(c.q, 1, 0, 0);
    const tv = Math.tan(c.fov * Math.PI / 360), th = tv * aspect;
    const hit = (dx, dy, dz, h) => {
      const k = dy < -1e-3 ? Math.min(far, (c.y - h) / -dy) : far;
      return [c.x + dx * k, c.z + dz * k];
    };
    let h = T ? RV.heightAt(T, c.x, c.z) : 0;
    const mid = hit(f[0], f[1], f[2], h);
    if (T) h = RV.heightAt(T, mid[0], mid[1]);
    const corner = (a, b) => hit(f[0] + a * th * r[0] + b * tv * u[0], f[1] + a * th * r[1] + b * tv * u[1], f[2] + a * th * r[2] + b * tv * u[2], h);
    return { corners: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], centre: hit(f[0], f[1], f[2], h) };
  };

  RV.alive = function (e, t) {
    const s = e.spans;
    for (let i = 0; i < s.length; i += 2) if (t >= s[i] && t < s[i + 1]) return true;
    return false;
  };

  RV.ownerAt = function (e, t) {
    if (!e.ownT) return e.owner;
    const i = RV.idxAt(e.ownT, t);
    return i < 0 ? e.owner : e.ownV[i];
  };

  // Position/HP at time t, interpolating over the final sample interval before each recorded change.
  RV.locate = function (e, t) {
    let i = RV.idxAt(e.t, t);
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
    e.px = x; e.pz = z; e.php = e.hp[i];
  };

  RV.visibleTo = function (e, t, mask) {
    if ((1 << (e.pown - 1)) & mask) return true;
    if (!e.visT) return false;
    const i = RV.idxAt(e.visT, t);
    return i >= 0 && (e.visM[i] & mask) !== 0;
  };

  RV.seenBefore = function (e, t, mask) {
    if (!e.visT) return false;
    const n = RV.idxAt(e.visT, t);
    for (let i = 0; i <= n; i++) if (e.visM[i] & mask) return true;
    return false;
  };

  // Updates the per-frame cache on every entity: on (alive), px/pz/php, pown, ptier/pname; map objects get
  // on/px/pz/amount.
  RV.updateFrame = function (M, t) {
    for (const e of M.ents) {
      e.on = RV.alive(e, t);
      if (!e.on) continue;
      e.pown = RV.ownerAt(e, t);
      RV.locate(e, t);
      if (e.ups) { e.ptier = RV.tierAt(e, t); e.pname = RV.nameAt(e, t); }
    }
    for (const g of M.gaia) {
      if (g.kind === "sacred") { g.on = t >= g.spans[0]; g.holder = g.held && g.held.on ? g.held.pown : 0; continue; }
      g.on = RV.alive(g, t);
      if (g.on) locateGaia(g, t);
      // Gathered out means gone in the game, but the recorder never sees exhausted mines removed (and sees bushes go late).
      if (g.on && g.amT && g.amount <= 0) g.on = false;
    }
  };

  RV.orderAt = function (M, sid, t) {
    const o = M.orders.get(sid);
    if (!o) return null;
    const i = RV.idxAt(o.t, t);
    if (i < 0 || Number.isNaN(o.x[i])) return null;
    return { x: o.x[i], z: o.z[i], since: o.t[i] };
  };

  RV.statsAt = function (M, idx, t) {
    const s = M.stats.get(idx);
    if (!s) return null;
    const i = RV.idxAt(s.t, t);
    return i < 0 ? null : s.rows[i];
  };

  // Panel queries both viewers call on this model (the 3D page builds it as M2), so the Players tab, the tech table,
  // the kill feed and the [ / ] fight jump cannot drift between them.

  /** Seconds before its start that both viewers show a fight from (fight list, [ / ] keys). */
  RV.FIGHT_LEAD = 5;

  /**
   * Age-ups and eco upgrades: one row per tech label in first-research order, with each player's first research time
   * (at: Map idx → t) and the earliest of them (best).
   */
  RV.techTable = function (M) {
    const rows = new Map();
    for (const [t, idx, label, kind] of M.techs) {
      if (!rows.has(label)) rows.set(label, { label, kind, at: new Map(), best: Infinity });
      const r = rows.get(label);
      if (!r.at.has(idx)) { r.at.set(idx, t); r.best = Math.min(r.best, t); }
    }
    return [...rows.values()];
  };

  /** Indices into M.kills of the latest kills up to t, newest first, leaving out livestock and attachments. */
  RV.killFeed = function (M, t, max) {
    const out = [];
    for (let i = RV.idxAt(M.killT, t); i >= 0 && out.length < max; i--) {
      const v = M.byId.get(M.kills[i].victim);
      if (!v || v.cat === "livestock" || v.cat === "attachment") continue;
      out.push(i);
    }
    return out;
  };

  /**
   * The fight to jump to from t ([ / ] keys), shown from RV.FIGHT_LEAD s before its start. Next: the first fight whose
   * lead-in is still ahead (else the last). Previous: the last fight started more than 6 s before t, so pressing it
   * during a fight restarts that fight and pressing it again goes further back (else the first). null without fights.
   */
  RV.jumpFight = function (fights, t, dir) {
    if (!fights.length) return null;
    if (dir > 0) return fights.find(f => f.start - RV.FIGHT_LEAD > t + 0.5) || fights[fights.length - 1];
    for (let i = fights.length - 1; i >= 0; i--) if (fights[i].start < t - 6) return fights[i];
    return fights[0];
  };

  // Explored ground for fog of war: per EXPLORE_CELL cell, the first time any unit or building of the players in mask
  // had it in sight (Infinity: never). Built from each entity's recorded positions, stamping its sight circle again
  // only after it moved a cell; cached per player, teams take the earliest of their members.
  const EXPLORE_CELL = 4;
  function exploredBy(M, idx) {
    const W = M.world.width, L = M.world.length, cols = Math.ceil(W / EXPLORE_CELL), rows = Math.ceil(L / EXPLORE_CELL);
    const first = new Float32Array(cols * rows).fill(Infinity);
    for (const e of M.ents) {
      if (!e.sight || (e.owner !== idx && !e.ownT)) continue;
      const r = e.sight / EXPLORE_CELL, r2 = r * r;
      let lx = Infinity, lz = Infinity;
      for (let i = 0; i < e.t.length; i++) {
        const t = e.t[i], x = e.x[i], z = e.z[i];
        if (Math.abs(x - lx) + Math.abs(z - lz) < EXPLORE_CELL) continue;
        if (e.ownT && RV.ownerAt(e, t) !== idx) continue;
        lx = x; lz = z;
        const cx = (x + W / 2) / EXPLORE_CELL, cz = (z + L / 2) / EXPLORE_CELL;
        const z0 = Math.max(0, Math.ceil(cz - r - 0.5)), z1 = Math.min(rows - 1, Math.floor(cz + r - 0.5));
        for (let k = z0; k <= z1; k++) {
          const dz = k + 0.5 - cz, half = Math.sqrt(r2 - dz * dz);
          const x0 = Math.max(0, Math.ceil(cx - half - 0.5)), x1 = Math.min(cols - 1, Math.floor(cx + half - 0.5));
          for (let j = k * cols + x0, end = k * cols + x1; j <= end; j++) if (first[j] > t) first[j] = t;
        }
      }
    }
    return first;
  }

  // { first, times, cols, rows, cell, x0, z0 }; times: the finite first-seen times sorted, so the number explored by t
  // is one binary search.
  RV.explored = function (M, mask) {
    let grid = M.explored.get(mask);
    if (grid) return grid;
    const W = M.world.width, L = M.world.length, cols = Math.ceil(W / EXPLORE_CELL), rows = Math.ceil(L / EXPLORE_CELL);
    const first = new Float32Array(cols * rows).fill(Infinity);
    for (const p of M.players) {
      if (!((1 << (p.idx - 1)) & mask)) continue;
      let own = M.explored.get(-p.idx);
      if (!own) M.explored.set(-p.idx, own = exploredBy(M, p.idx));
      for (let j = 0; j < first.length; j++) if (own[j] < first[j]) first[j] = own[j];
    }
    grid = { first, times: first.filter(Number.isFinite).sort(), cols, rows, cell: EXPLORE_CELL, x0: -W / 2, z0: -L / 2 };
    M.explored.set(mask, grid);
    return grid;
  };

  RV.isUnit = cat => cat !== "building" && cat !== "attachment" && cat !== "other";
  const MILITARY = new Set(window.RV_UNITS.military);
  RV.isMilitary = cat => MILITARY.has(cat);

  /**
   * Living villagers, military units and army value per player index at time t, from the entities themselves (the
   * 5 s army series is for charts: its first bucket is time 0, before the recording starts). Cached for the last t.
   */
  RV.armyAt = function (M, t) {
    if (M.armyAtT === t) return M.armyAtV;
    if (!M.armyEnts) M.armyEnts = M.ents.filter(e => e.cat === "villager" || MILITARY.has(e.cat));
    const out = new Map(M.players.map(p => [p.idx, { villagers: 0, military: 0, armyValue: 0 }]));
    for (const e of M.armyEnts) {
      if (!RV.alive(e, t)) continue;
      const a = out.get(RV.ownerAt(e, t));
      if (!a) continue;
      if (e.cat === "villager") a.villagers++;
      else { a.military++; a.armyValue += e.value; }
    }
    M.armyAtT = t; M.armyAtV = out;
    return out;
  };
})(window.RV);
