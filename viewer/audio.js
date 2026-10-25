/* Original AoE4 media, replay-driven Web Audio mixer. No game files are bundled with source.
 * The pure plan and cursor also run in the replay audit. Inferred events are explicitly marked.
 */
(function (root) {
  'use strict';
  const A = root.RV_AUDIO = {};
  const F = () => root.RV_FRAME;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const civs = { sultanate: 'sul', delhi: 'sul', hre: 'hre', english: 'eng', french: 'fre', chinese: 'chi',
    abbasid: 'abb', abbasid_dynasty: 'abb', mongols: 'mon', rus: 'rus', ottoman: 'ott', ottomans: 'ott',
    malians: 'mal', malian: 'mal', japanese: 'jpn', byzantines: 'byz', byzantine: 'byz',
    order_of_the_dragon: 'hre', ayyubids: 'abb', jeanne_darc: 'fre', zhu_xis_legacy: 'chi' };
  const speech = { sul: 'sultanate', hre: 'hre', eng: 'english', fre: 'french', chi: 'chinese', abb: 'abbasid',
    mon: 'mongols', rus: 'rus', ott: 'ottoman', mal: 'malian', jpn: 'japanese', byz: 'byzantine' };
  const jobCues = ['', 'work.build', 'work.food', 'work.wood', 'work.gold', 'work.stone', 'work.food', 'work.food', 'work.food'];
  const jobPeriods = [0, 1.1, 1.6, 1.5, 1.7, 1.7, 1.8, 1.3, 6.9];
  A.civ = p => civs[String(p?.civ || '').toLowerCase().replace(/[ -]/g, '_')] || null;
  A.age = (d, owner, t) => {
    let age = 1;
    for (const [at, p, label, kind] of d.techs || []) if (p === owner && at <= t && kind === 'age')
      age = Math.max(age, /imperial/i.test(label) ? 4 : /castle/i.test(label) ? 3 : /feudal/i.test(label) ? 2 : 1);
    return age;
  };
  A.weapon = b => {
    const bp = b.a.bp;
    if (b.torch) return 'fire';
    for (const [re, cue] of [[/trebuchet/, 'siege.trebuchet'], [/mangonel|nest_of_bees/, 'siege.mangonel'],
      [/bombard|unit_cannon|ribauldequin|great_bombard/, 'siege.cannon'], [/springald|ballista/, 'siege.springald'],
      [/ram/, 'siege.ram'], [/handcannon|hand_cannon|arquebus|musofadi_gunner|streltsy|janissary|ozutsu/, 'gun'],
      [/crossbow|arbaletrier/, 'crossbow'], [/longbow/, 'longbow']]) if (re.test(bp)) return cue;
    if (b.shot) return 'bow';
    return /spear|lance/.test(bp) || /^thrust/.test(b.kind) ? 'spear' : /axe|villager/.test(bp) ? 'axe' : 'sword';
  };
  A.voiceUnit = e => {
    const bp = e.bp || '';
    if (/villager/.test(bp)) return /female/.test(bp) ? 'villagerfemale' : 'villagermale';
    for (const [re, name] of [[/religious|monk|imam|scholar|prelate|warrior_monk|dervish/, 'monk'], [/crossbow|arbaletrier/, 'crossbowman'],
      [/handcannon|streltsy|janissary/, 'handcannon'], [/man_at_arms|manatarms|samurai|ghulam/, 'manatarms'],
      [/landsknecht/, 'landsknecht'], [/spearman|donso|limitanei/, 'spearman'], [/scout/, 'scout'],
      [/knight|lancer|cataphract/, 'knight'], [/horseman|sipahi/, 'horseman'], [/archer|longbow|zhuge/, 'archer']])
      if (re.test(bp) || (name === 'monk' && e.cat === 'religious')) return name;
    return null;
  };
  A.voiceCue = (manifest, d, e, t, context) => {
    const owner = F().ownerAt(e, t), civ = speech[A.civ((d.players || []).find(p => p.idx === owner))], unit = A.voiceUnit(e);
    if (!civ || !unit) return null;
    const age = A.age(d, owner, t), prefix = `voice.${civ}.${unit}.${context}.`;
    // Some civilizations do not have four language stages. Prefer the latest available earlier stage.
    for (const n of [...Array.from({length: age + 1}, (_, i) => age - i), ...Array.from({length: 4 - age}, (_, i) => age + i + 1)])
      if (manifest.cues[prefix + n]?.length) return prefix + n;
    return null;
  };
  A.plan = ({ d, ents, combat, conversions = [], gaia = [], alerts = [] }) => {
    const events = [], byId = new Map(ents.map(e => [e.id, e]));
    const add = (t, cue, e, extra = {}) => { if (Number.isFinite(t)) events.push({t, cue, e, bus: 'effects', ...extra}); };
    for (const list of combat.lists.values()) for (const b of list) {
      const cue = A.weapon(b);
      add(b.t0, cue, b.a, { inferred: true, priority: 2, combat: true });
      if (b.shot && !b.miss) add(b.t1, cue.startsWith('siege.') ? 'siege.impact' : cue === 'gun' ? 'bullet.impact' : 'arrow.impact', b.b,
        { inferred: true, priority: 2 });
    }
    for (const k of d.kills || []) {
      const e = byId.get(k.victim); if (!e || e.cat === 'attachment' || e.cat === 'other') continue;
      add(k.t, e.cat === 'building' ? 'death.building' : /ship/.test(e.bp) ? 'death.ship' : e.cat === 'cavalry' ? 'death.horse' : 'death', e, {priority: 3});
      if (e.cat !== 'building') add(k.t, 'voice', e, {bus: 'voices', context: 'effortdeath', priority: 3});
    }
    for (const h of combat.heals || []) add(h.t0 + 0.1, 'heal', h.healer, {inferred: true, until: h.t1});
    for (const c of conversions) {
      add(c.t, 'convert', c.caster, {until: c.end, priority: 4, gain: 0.42});
      if (c.end > c.t + 0.5) add(c.t + 0.5, 'convert.voice', c.caster, {until: c.end, priority: 4, gain: 0.5});
      if (c.end > c.t + 3) add(c.t + 3, 'convert.buildup', c.caster, {until: c.end, priority: 4, gain: 0.42});
      for (const v of c.targets) if (v.flip != null) add(v.flip, 'converted', v.e, {priority: 4});
    }
    // A carrying interval proves movement with a relic, not a deposit. Never invent a deposit at interval end.
    for (const g of gaia) if (g.kind === 'relic') {
      let previous = -Infinity;
      for (const r of g.relicCarries || []) {
        if (r.start - previous > 8 && (r.e.relicCarries || []).filter(x => x.start <= r.start && x.end > r.start).length === 1)
          add(r.start, 'relic.pickup', r.e, {inferred: true, priority: 4});
        previous = r.end;
      }
    }
    const notices = new Set();
    const lastAlert = new Map();
    for (const a of alerts) if (a.t - (lastAlert.get(a.owner) ?? -Infinity) >= 20) {
      add(a.t, 'alert', a.victim, {owner: a.owner, bus: 'ui', priority: 3, inferred: true, gain: .35});
      lastAlert.set(a.owner, a.t);
    }
    for (const [t, owner, label, kind] of d.techs || []) {
      add(t, kind === 'age' ? 'age' : 'research', null, {owner, bus: 'ui', priority: 4}); notices.add(`${t}|${owner}`);
    }
    for (const u of d.upgrades || []) {
      const id = /^e(\d+)$/.exec(u.fields?.executer || ''), e = id && byId.get(+id[1]);
      if (!e) continue;
      const owner = F().ownerAt(e, u.t), key = `${u.t}|${owner}`;
      if (!notices.has(key)) { add(u.t, 'research', null, {owner, bus: 'ui', priority: 3}); notices.add(key); }
    }
    for (const e of ents) if (e.cat === 'building' && Number.isFinite(e.builtAt))
      add(e.builtAt, 'building.complete', e, {inferred: true, priority: 3});
    events.sort((a, b) => a.t - b.t || (b.priority || 0) - (a.priority || 0));
    events.forEach((e, i) => { e.id = i; });
    return events;
  };
  /** Clock cursor never replays a seek's skipped interval. Explicit reset also handles small seeks. */
  A.Cursor = class {
    constructor(events) { this.events = events; this.last = null; this.serial = -1; this.i = 0; }
    reset(t) {
      let lo = 0, hi = this.events.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (this.events[m].t < t - 1e-7) lo = m + 1; else hi = m; }
      this.i = lo;
    }
    step(s, wall) {
      const old = this.last, discontinuity = !old || s.serial !== this.serial || s.playing !== old.playing || s.speed !== old.speed
        || s.t < old.t - 0.001 || Math.abs(s.t - old.t - (old.playing ? (wall - old.wall) * old.speed : 0)) > 0.3;
      if (discontinuity) this.reset(s.t);
      this.serial = s.serial; this.last = {...s, wall};
      const due = [], prefetch = [];
      if (s.playing) {
        const end = s.t + Math.min(0.12 * s.speed, 0.45);
        while (this.i < this.events.length && this.events[this.i].t <= end) {
          const e = this.events[this.i++]; if (e.t >= s.t - 0.15 * s.speed) due.push(e);
        }
        for (let i = this.i; i < this.events.length && this.events[i].t < s.t + 3 * s.speed; i++) prefetch.push(this.events[i]);
      }
      return {discontinuity, due, prefetch};
    }
  };
  A.biome = name => {
    const n = String(name || '').toLowerCase();
    for (const [re, key] of [[/gobi|eastern desert/, 'desert_eastern'], [/sahara|arabian|desert/, 'desert_sahara'],
      [/steppe|mongol/, 'steppes_eastern'], [/taiga/, 'taiga_north'], [/snow|winter|tundra/, 'taiga_winter'],
      [/autumn|fall/, 'temperate_fall'], [/rainforest/, 'tropical_rainforest'], [/swamp/, 'tropical_swamp'],
      [/mediterranean/, 'mediterranean'], [/savana|savanna/, 'savanna'], [/alpine/, 'alpine_spring'],
      [/japan|sakura/, 'japanese_spring'], [/coast/, 'coastal_western']]) if (re.test(n)) return key;
    return 'temperate_western';
  };

  A.Mixer = class {
    constructor(opts, manifest, ctx) {
      this.o = opts; this.manifest = manifest; this.ctx = ctx; this.events = A.plan(opts); this.cursor = new A.Cursor(this.events);
      this.cache = new Map(); this.pending = new Map(); this.bytes = 0; this.active = new Set(); this.beds = new Map();
      this.generation = 0; this.enabled = false; this.counts = {played: 0, dropped: 0, failed: 0}; this.trace = []; this.bedOffsets = new Map();
      this.lastContinuous = -Infinity; this.lastVoice = -Infinity; this.combatUntil = -Infinity;
      this.prefs = {master: .65, effects: .65, voices: .75, ambience: .4, music: .35, ui: .55};
      try { const saved = JSON.parse(root.localStorage.getItem('rv.audio.v1') || '{}'); for (const k in this.prefs) if (Number.isFinite(saved[k])) this.prefs[k] = clamp(saved[k], 0, 1); } catch {}
      this.master = ctx.createGain(); this.master.gain.value = this.prefs.master;
      const limiter = ctx.createDynamicsCompressor(); limiter.threshold.value = -12; limiter.knee.value = 12; limiter.ratio.value = 8;
      this.master.connect(limiter);
      this.meter = ctx.createAnalyser(); this.meter.fftSize = 256; this.meterData = new Float32Array(256);
      limiter.connect(this.meter); this.meter.connect(ctx.destination); this.buses = {};
      for (const k of ['effects', 'voices', 'ambience', 'music', 'ui']) {
        const g = ctx.createGain(); g.gain.value = this.prefs[k]; g.connect(this.master); this.buses[k] = g;
      }
    }
    volume(key, value) {
      this.prefs[key] = clamp(+value, 0, 1);
      (key === 'master' ? this.master : this.buses[key]).gain.setTargetAtTime(this.prefs[key], this.ctx.currentTime, .03);
      try { root.localStorage.setItem('rv.audio.v1', JSON.stringify(this.prefs)); } catch {}
    }
    idFor(cue, seed = 0) { const a = this.manifest.cues[cue]; return a?.length ? a[(seed >>> 0) % a.length] : null; }
    async buffer(id) {
      if (this.cache.has(id)) { const a = this.cache.get(id); this.cache.delete(id); this.cache.set(id, a); return a; }
      if (this.pending.has(id)) return this.pending.get(id);
      if (!id || this.pending.size >= 12) return null;
      const p = (async () => {
        try {
          const r = await fetch(new URL(this.manifest.assets[id].url, this.o.base)); if (!r.ok) throw Error(`Audio HTTP ${r.status}`);
          const b = await this.ctx.decodeAudioData(await r.arrayBuffer());
          this.cache.set(id, b); this.bytes += b.length * b.numberOfChannels * 4;
          while (this.bytes > 96 * 1024 * 1024 && this.cache.size > 1) {
            const [k, v] = this.cache.entries().next().value; this.cache.delete(k); this.bytes -= v.length * v.numberOfChannels * 4;
          }
          return b;
        } catch { this.counts.failed++; return null; } finally { this.pending.delete(id); }
      })();
      this.pending.set(id, p); return p;
    }
    audible(e, t) {
      if (e.owner && !this.o.ownerVisible(e.owner)) return false;
      return !e.e || this.o.visible(e.e, t);
    }
    spatial(e, t) {
      if (!e) return {gain: 1, pan: 0};
      const p = F().locate(e, t), l = this.o.listener(), dx = p.x - l.x, dz = p.z - l.z;
      const r = l.radius || 100, d = Math.hypot(dx, dz);
      return {gain: d >= r * 1.5 ? 0 : Math.pow(Math.max(0, 1 - d / (r * 1.5)), 1.6), pan: clamp((dx * (l.rightX ?? 1) + dz * (l.rightZ || 0)) / r, -.9, .9)};
    }
    cue(e) { return e.cue === 'voice' ? A.voiceCue(this.manifest, this.o.d, e.e, e.t, e.context) : e.cue; }
    cancel() {
      this.generation++;
      for (const a of [...this.active]) this.stop(a);
      this.beds.clear(); this.lastContinuous = -Infinity; this.lastVoice = -Infinity; this.combatUntil = -Infinity;
    }
    stop(a, fade = 0) {
      const now = this.ctx.currentTime;
      if (a.loop) this.bedOffsets.set(a.e.cue, (a.offset + Math.max(0, now - a.started)) % a.source.buffer.duration);
      try { if (fade) { a.gain.gain.cancelScheduledValues(now); a.gain.gain.setTargetAtTime(0, now, fade / 4); } a.source.stop(now + fade); } catch {}
      if (!fade) this.active.delete(a);
    }
    async play(e, when = this.ctx.currentTime, options = {}) {
      if (!this.enabled || this.ctx.state !== 'running' || !this.audible(e, e.t)) return null;
      const bus = e.bus || 'effects', pos = this.spatial(e.e, e.t), cue = this.cue(e), id = this.idFor(cue, e.id ?? Math.round(e.t * 10));
      if (!id || pos.gain < .015 || !this.prefs[bus]) return null;
      const generation = this.generation, speed = this.o.state().speed, b = await this.buffer(id);
      if (!b || generation !== this.generation || !this.enabled || !this.audible(e, e.t)) return null;
      const now = this.ctx.currentTime;
      if (!options.loop && now - when > .18) { this.counts.dropped++; return null; }
      const peers = [...this.active].filter(a => a.bus === bus && !a.loop);
      const cap = bus === 'voices' ? 2 : bus === 'ui' ? 4 : 28;
      if (!options.loop && peers.length >= cap) {
        const low = peers.sort((a, b) => a.priority - b.priority)[0];
        if (low.priority >= (e.priority || 0)) { this.counts.dropped++; return null; } this.stop(low, .025);
      }
      const source = this.ctx.createBufferSource(), gain = this.ctx.createGain(), pan = this.ctx.createStereoPanner();
      source.buffer = b; source.loop = !!options.loop;
      gain.gain.value = options.loop ? 0 : pos.gain * (e.gain ?? .55);
      pan.pan.value = pos.pan; source.connect(gain); gain.connect(pan); pan.connect(this.buses[bus]);
      const a = {source, gain, pan, bus, loop: source.loop, priority: e.priority || 0, e, id}; this.active.add(a);
      source.onended = () => { this.active.delete(a); source.disconnect(); gain.disconnect(); pan.disconnect(); };
      const at = Math.max(now, when), offset = options.loop ? (this.bedOffsets.get(e.cue) || 0) % b.duration : 0;
      a.offset = offset; a.started = at;
      source.start(at, offset);
      if (options.loop) gain.gain.setTargetAtTime(e.gain ?? .5, at, .5);
      if (e.until != null) source.stop(at + Math.max(.01, (e.until - e.t) / speed));
      this.counts.played++;
      this.trace.push({cue, t: e.t, when: at, requested: when, delta: at - when, bus, inferred: !!e.inferred});
      if (this.trace.length > 256) this.trace.shift();
      return a;
    }
    async enable(value) {
      this.enabled = value;
      if (value) { await this.ctx.resume(); this.cursor.last = null; this.prime(); }
      else this.cancel();
    }
    prime() {
      const s = this.o.state(), p = this.o.d.players.find(p => this.o.ownerVisible(p.idx)) || this.o.d.players[0];
      for (const cue of ['ui.click', 'ui.victory', 'ui.defeat', 'ambience.' + A.biome(this.o.d.summary?.map?.biome), `music.${A.civ(p)}.${A.age(this.o.d, p.idx, s.t)}.exp`])
        this.buffer(this.idFor(cue));
      this.cursor.reset(s.t);
      for (let i = this.cursor.i; i < this.events.length && this.events[i].t <= s.t + 3; i++) {
        const e = this.events[i]; if (this.audible(e, e.t) && this.spatial(e.e, e.t).gain > .1) this.buffer(this.idFor(this.cue(e), e.id));
      }
    }
    async bed(bus, key, t, slot = bus, gain = bus === 'music' ? .5 : .6) {
      if (this.beds.get(slot)?.key === key) return;
      // Keep the audible predecessor through overlapping asynchronous transitions.
      const old = this.beds.get(slot), marker = {key, node: old?.node || null}; this.beds.set(slot, marker);
      const node = await this.play({t, cue: key, bus, gain}, this.ctx.currentTime, {loop: true});
      if (this.beds.get(slot) !== marker) { if (node) this.stop(node); return; }
      if (!node) { if (old?.node) this.beds.set(slot, {key: old.node.e.cue, node: old.node}); else this.beds.delete(slot); return; }
      marker.node = node; if (old?.node) this.stop(old.node, 1.5);
    }
    update(wall = performance.now() / 1000) {
      const s = this.o.state(), hidden = !!root.document?.hidden;
      const old = this.cursor.last;
      const completed = old?.playing && old.t < this.o.d.duration && s.t >= this.o.d.duration && old.serial === s.serial;
      const step = this.cursor.step({...s, playing: s.playing && !hidden && this.enabled}, wall);
      if (step.discontinuity) this.cancel();
      if (completed && this.enabled && !hidden) this.finish(s.t);
      if (!this.enabled || !s.playing || hidden || this.ctx.state !== 'running') return;
      const speaking = [...this.active].some(a => a.bus === 'voices');
      this.buses.music.gain.setTargetAtTime(this.prefs.music * (speaking ? .45 : 1), this.ctx.currentTime, speaking ? .12 : .6);
      for (const e of step.prefetch) if (this.audible(e, e.t) && this.spatial(e.e, e.t).gain > .015) this.buffer(this.idFor(this.cue(e), e.id));
      for (const e of step.due) {
        if (e.combat && this.audible(e, e.t) && this.spatial(e.e, e.t).gain > .12) {
          this.combatUntil = s.t + 12;
          if (s.speed <= 2 && s.t - this.lastVoice > 9) {
            this.play({t: e.t, cue: 'voice', e: e.e, context: 'ambientcombat', bus: 'voices', priority: 2}, this.ctx.currentTime + Math.max(0, (e.t - s.t) / s.speed));
            this.lastVoice = s.t;
          }
        }
        this.play(e, this.ctx.currentTime + Math.max(0, (e.t - s.t) / s.speed));
      }
      // Re-evaluate ongoing emitters so a camera/vision change also silences an already-playing enemy.
      for (const a of this.active) if (a.e.e) {
        const p = this.spatial(a.e.e, s.t);
        a.gain.gain.setTargetAtTime(this.audible(a.e, s.t) ? p.gain * (a.e.gain ?? .55) : 0, this.ctx.currentTime, .05);
        a.pan.pan.setTargetAtTime(p.pan, this.ctx.currentTime, .05);
      }
      const player = this.o.d.players.find(p => p.idx === this.musicOwner) || this.o.d.players.find(p => this.o.ownerVisible(p.idx)) || this.o.d.players[0];
      const civ = A.civ(player), age = A.age(this.o.d, player.idx, s.t), mode = s.t < this.combatUntil ? 'com' : 'exp';
      let key = `music.${civ}.${age}.${mode}`;
      if (!this.manifest.cues[key]) key = `music.${civ}.${age}.exp`;
      if (this.manifest.cues[key]) this.bed('music', key, s.t);
      this.bed('ambience', 'ambience.' + A.biome(this.o.d.summary?.map?.biome), s.t);
      if (s.t - this.lastContinuous >= .25 || s.t < this.lastContinuous) {
        this.continuous(s); this.lastContinuous = s.t;
      }
    }
    finish(t) {
      // Playback-end feedback, not an invented timestamp for the game's victory event.
      const viewed = this.o.d.players.filter(p => this.o.ownerVisible(p.idx));
      const owner = this.musicOwner || (viewed.length === 1 ? viewed[0].idx : null);
      const result = this.o.d.summary?.players?.[owner]?.result;
      if (result === 'win' || result === 'loss') this.play({t, cue: result === 'win' ? 'ui.victory' : 'ui.defeat', bus: 'ui', priority: 5});
    }
    continuous(s) {
      // Fish locations establish recorded water sources; do not add water to a dry map.
      const listener = this.o.listener();
      const nearWater = (this.o.gaia || []).some(g => g.kind === 'fish' && Math.hypot(g.x - listener.x, g.z - listener.z) < 45);
      if (nearWater) this.bed('ambience', 'water', s.t, 'water', .2);
      else if (this.beds.has('water')) { const old = this.beds.get('water'); this.beds.delete('water'); if (old.node) this.stop(old.node, .5); }
      const candidates = [];
      for (const e of this.o.ents) {
        if (e.cat === 'building' || e.cat === 'attachment' || !F().alive(e, s.t) || !this.o.visible(e, s.t)) continue;
        const p = this.spatial(e, s.t); if (p.gain < .1) continue;
        const i = Math.max(0, F().idxAt(e.t, s.t)), j = i + 1;
        const moving = j < e.t.length && s.t > Math.max(e.t[i], e.t[j] - .5) && Math.hypot(e.x[j] - e.x[i], e.z[j] - e.z[i]) > .2;
        const job = e.job?.[i] || 0;
        if (/sheep/.test(e.bp)) candidates.push({e, cue: 'animal.sheep', period: 12, phase: e.id % 11, context: null, score: p.gain});
        else if (job > 0 && job < 9) candidates.push({e, cue: jobCues[job], period: jobPeriods[job], phase: e.jobT0[i], context: 'workingidle', score: p.gain});
        else if (moving) candidates.push({e, cue: e.cat === 'cavalry' ? 'move.horse' : e.cat === 'siege' ? 'move.siege' : 'move.foot', period: e.cat === 'siege' ? 2 : .55, phase: e.id % 17 / 17, context: 'marchingidle', score: p.gain});
      }
      for (const c of candidates.sort((a, b) => b.score - a.score).slice(0, 8)) {
        const tick = Math.floor((s.t - c.phase) / c.period), previous = Math.floor((this.lastContinuous - c.phase) / c.period);
        if (tick === previous) continue;
        this.play({t: s.t, cue: c.cue, e: c.e, id: c.e.id + tick, gain: .25, inferred: true});
      }
      if (s.speed <= 2 && s.t - this.lastVoice > 9 && candidates.length) {
        const c = candidates.sort((a, b) => b.score - a.score)[0];
        this.play({t: s.t, cue: 'voice', e: c.e, context: s.t < this.combatUntil ? 'ambientcombat' : c.context, bus: 'voices', gain: .7});
        this.lastVoice = s.t;
      }
    }
    select(e) {
      const t = this.o.state().t;
      if (!e || (e.kind !== 'relic' && !this.o.visible(e, t))) return;
      let cue = e.kind === 'relic' ? 'relic.select' : 'ui.select';
      if (e.cat === 'building') {
        const names = {barracks:'infantry', archery_range:'ranged', stable:'cavalry', siege_workshop:'siege', mining_camp:'mining', lumber_camp:'wood', mill:'food'};
        for (const name of ['town_center','barracks','archery_range','stable','siege_workshop','house','keep','market','mining_camp','lumber_camp','mill','monastery','mosque','outpost','farm','university','wonder','blacksmith','landmark'])
          if (e.bp.includes(name)) { const c = 'select.' + (names[name] || name); if (this.manifest.cues[c]) cue = c; break; }
      }
      this.play({t, cue, bus: 'ui'});
      if (e.bp && e.t) this.play({t, cue: 'voice', e, context: 'select', bus: 'voices', priority: 4, gain: .85});
    }
  };

  A.mount = function (opts) {
    let mixer = null, loading = null, serial = 0;
    const state = opts.state;
    opts = {...opts, state: () => ({...state(), serial}), base: new URL(opts.base, root.location.href)};
    const wrap = document.createElement('details'); wrap.className = 'rv-audio'; wrap.setAttribute('aria-label', 'Audio settings');
    wrap.innerHTML = '<summary>Audio</summary><div class="rv-audio-body"><button type="button" class="rv-audio-enable">Enable audio</button><p class="rv-audio-status" role="status">Original AoE4 sounds · enable to listen</p><div class="rv-audio-sliders"></div><label>Music civilization <select class="rv-audio-player"><option value="0">Viewed player</option></select></label><details class="rv-audio-diagnostics"><summary>Playback details</summary><output></output></details></div>';
    const style = document.createElement('style'); style.textContent = '.rv-audio{position:fixed;z-index:90;right:18px;bottom:78px;color:#e8e3d5;background:#182028ed;border:1px solid #73818a;border-radius:7px;font:12px system-ui;box-shadow:0 3px 16px #0006}.rv-audio>summary{cursor:pointer;padding:9px 14px}.rv-audio-body{width:250px;padding:2px 14px 14px}.rv-audio label{display:flex;align-items:center;justify-content:space-between;gap:9px;margin:9px 0}.rv-audio input{width:130px;accent-color:#d4b66e}.rv-audio p{font-size:11px;line-height:1.5}.rv-audio select{max-width:145px}.rv-audio button,.rv-audio select{color:inherit;background:#293741;border:1px solid #73818a;border-radius:4px;padding:5px}.rv-audio output{display:block;font-size:10px;white-space:pre-line;margin-top:8px}';
    document.head.append(style); document.body.append(wrap);
    const status = wrap.querySelector('.rv-audio-status'), button = wrap.querySelector('button'), sliders = wrap.querySelector('.rv-audio-sliders');
    const player = wrap.querySelector('select');
    for (const p of opts.d.players) { const o = document.createElement('option'); o.value = p.idx; o.textContent = p.name || p.civ; player.append(o); }
    player.onchange = () => { if (mixer) mixer.musicOwner = +player.value; };
    const ready = async () => {
      if (mixer) return mixer;
      if (loading) return loading;
      // Construct/resume in the click's user activation, before fetching the manifest.
      const ctx = new (root.AudioContext || root.webkitAudioContext)(); await ctx.resume();
      loading = (async () => {
        try {
          const r = await fetch(new URL('index.json', opts.base)); if (!r.ok) throw Error('Audio pack is missing');
          mixer = new A.Mixer(opts, await r.json(), ctx);
          for (const key of Object.keys(mixer.prefs)) {
            const label = document.createElement('label'); label.textContent = key === 'ui' ? 'UI' : key[0].toUpperCase() + key.slice(1);
            const input = document.createElement('input'); input.type = 'range'; input.min = 0; input.max = 100; input.value = Math.round(mixer.prefs[key] * 100); input.setAttribute('aria-label', key + ' volume');
            input.oninput = () => mixer.volume(key, +input.value / 100); label.append(input); sliders.append(label);
          }
          return mixer;
        } catch (e) { await ctx.close(); loading = null; throw e; }
      })(); return loading;
    };
    button.onclick = async () => {
      button.disabled = true;
      try {
        const m = await ready(); await m.enable(!m.enabled);
        button.textContent = m.enabled ? 'Mute audio' : 'Enable audio';
        status.textContent = m.enabled ? 'Audio on · follows replay playback' : 'Audio muted';
      } catch { status.textContent = 'Audio unavailable. Build the local audio pack with tools/setup_audio.ps1 and tools/build_audio.py, then open the viewer through its local server.'; }
      finally { button.disabled = false; }
    };
    const click = ev => {
      if (!mixer?.enabled || wrap.contains(ev.target) || !ev.target.closest('button,select,[role="tab"],summary')) return;
      const summary = ev.target.closest('summary');
      mixer.play({t: state().t, cue: summary ? (summary.parentElement.open ? 'ui.close' : 'ui.open') : 'ui.click', bus: 'ui', priority: 4});
    };
    document.addEventListener('click', click);
    const visibility = () => { serial++; mixer?.cancel(); }; document.addEventListener('visibilitychange', visibility);
    let lastStatus = 0;
    return {
      update() {
        mixer?.update();
        if (mixer && performance.now() - lastStatus > 1000) {
          lastStatus = performance.now();
          mixer.meter.getFloatTimeDomainData(mixer.meterData);
          const rms = Math.sqrt(mixer.meterData.reduce((a, b) => a + b * b, 0) / mixer.meterData.length);
          wrap.querySelector('output').textContent = `${mixer.events.length} replay cues · ${Object.keys(mixer.manifest.assets).length} original clips\nPlayed ${mixer.counts.played} · late/capped ${mixer.counts.dropped} · failed ${mixer.counts.failed}\nOutput: ${rms > .00001 ? (20 * Math.log10(rms)).toFixed(1) + ' dBFS' : 'silent'}\nMusic: ${mixer.beds.get('music')?.key || 'paused'}\nAmbience: ${mixer.beds.get('ambience')?.key || 'paused'}\n${mixer.trace.slice(-4).map(e => `${e.cue} @ ${e.t.toFixed(2)}s (${Math.round(e.delta * 1000)}ms late)`).join('\n')}`;
        }
      },
      reset() { serial++; mixer?.cancel(); if (mixer?.enabled) mixer.prime(); }, select(e) { mixer?.select(e); },
      get mixer() { return mixer; },
      dispose() { mixer?.cancel(); mixer?.ctx.close(); document.removeEventListener('click', click); document.removeEventListener('visibilitychange', visibility); wrap.remove(); style.remove(); },
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
