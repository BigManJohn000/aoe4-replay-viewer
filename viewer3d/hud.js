/**
 * hud.js — match state over the map: AoE IV's victory conditions in the top bar (Victory: sacred sites in their
 * holder's colour, the 10:00 countdown while one team holds every site; Age IV wonders under construction and the 15:00
 * countdown once one stands) and the under-attack notices on the left edge (RaidToasts). Both read the 2D model M2
 * (viewer/model.js: sites, alerts) and the 3D replay R (wonder entities, what is on the map at t).
 */
import { fmtTime, idxAt, alive, ownerAt } from './core/replay.js';

export const SACRED_WIN = 600; // AoE IV sacred victory: one team holds every sacred site for 10 minutes
export const WONDER_WIN = 900; // AoE IV wonder victory: a finished wonder stands for 15 minutes
// Age IV wonders (stats.js blueprints). Mongol landmarks are building_wonder_age1-3_* and stay out.
const WONDER_BP = /^building_wonder_(?:age4_|4_|tem$)/;
const RAID_QUIET = 15; // s without an alert of that player within RV.ALERT_MERGE m before a notice is raised
const TOAST_MS = 5000;  // a notice stays this long (real time), then fades
const TOAST_MAX = 4;    // notices on screen at once; the oldest goes first
const TOAST_JUMP = 4;   // a step of more game seconds than this is a seek, not playback: no notices for what it skipped

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = (s) => { const k = Math.max(0, Math.ceil(s)); return `${String(Math.floor(k / 60)).padStart(2, '0')}:${String(k % 60).padStart(2, '0')}`; };

/**
 * Top-bar victory conditions (#victory). Sacred sites: one dot per site in its holder's colour (blinking while
 * religious units take it, RV.siteState), and while one team holds every site the countdown from the moment it took
 * the last one; losing any site (neutralised or taken) ends that run, as in game. Wonders: a badge while one is built,
 * then its countdown from completion and its HP while it stands.
 */
export class Victory {
  constructor({ RV, M2, R, color, teamName }) {
    Object.assign(this, { RV, M2, R, color, teamName });
    this.el = $('victory');
    this.sites = M2.sites;
    this.wonders = R.ents.filter((e) => WONDER_BP.test(e.bp));
    this.holds = this.holdRuns();
    this.t0 = this.sites.length ? Math.min(...this.sites.map((o) => o.spans[0])) : Infinity; // sites appear
    this.el.innerHTML = '<span class="sites"></span><span class="cd sacred" hidden></span><span class="wonders"></span>';
    this.dots = this.sites.map(() => this.el.querySelector('.sites').appendChild(document.createElement('i')));
    for (const d of this.dots) d.className = 'site';
    this.key = '';
  }

  holderAt(o, t) { return o.held && this.RV.alive(o.held, t) ? this.RV.ownerAt(o.held, t) : 0; }
  /** The team holding every site at t, or null. */
  teamAll(t) {
    let team = null;
    for (const o of this.sites) {
      const h = this.holderAt(o, t), tm = h ? this.M2.playerByIdx.get(h)?.team : null;
      if (tm == null || (team != null && tm !== team)) return null;
      team = tm;
    }
    return team;
  }
  /** Runs [{ a, b, team }] in which one team held every site: evaluated between consecutive holder changes. */
  holdRuns() {
    if (!this.sites.length) return [];
    const ts = [...new Set(this.sites.flatMap((o) => [o.spans[0], ...o.changes]))].sort((a, b) => a - b);
    const runs = [];
    for (let i = 0; i < ts.length; i++) {
      const team = this.teamAll(ts[i] + 1e-3), b = i + 1 < ts.length ? ts[i + 1] : Infinity;
      const prev = runs[runs.length - 1];
      if (team == null) continue;
      if (prev && prev.team === team && prev.b === ts[i]) prev.b = b;
      else runs.push({ a: ts[i], b, team });
    }
    return runs;
  }

  update(t) {
    const { RV, M2, R } = this;
    const on = t >= this.t0;
    this.sites.forEach((o, i) => {
      const h = this.holderAt(o, t), cap = RV.siteState(M2, o, t);
      const d = this.dots[i];
      d.style.background = h ? this.color(h) : 'transparent';
      d.style.borderColor = cap ? this.color(cap.capturer) : '#d9cba4';
      d.classList.toggle('cap', !!cap);
      d.title = `Sacred site ${i + 1}: ${h ? `held by ${R.players.get(h)?.name ?? 'Gaia'}` : 'neutral'}${cap ? ` · ${R.players.get(cap.capturer)?.name} capturing` : ''}`;
    });
    this.el.querySelector('.sites').title = `Sacred sites: hold all ${this.sites.length} for 10:00 to win`;
    const run = this.holds.find((r) => t >= r.a && t < r.b);
    const sc = this.el.querySelector('.sacred');
    sc.hidden = !run;
    if (run) {
      const left = SACRED_WIN - (t - run.a), col = this.teamColor(run.team);
      sc.style.color = col; sc.style.borderColor = col;
      sc.textContent = left > 0 ? `Sacred victory ${clock(left)}` : 'Sacred victory!';
      sc.title = `${this.teamName(run.team)} hold every sacred site since ${fmtTime(run.a)}: they win at ${fmtTime(run.a + SACRED_WIN)} unless a site is lost`;
    }
    // wonders standing (or being built) at t
    const ws = this.wonders.filter((w) => t >= w.born && alive(w, t));
    const wk = ws.map((w) => `${w.id}|${Math.round((w.on ? w.php : 0) / Math.max(1, w.maxhp) * 50)}|${Math.ceil(t)}`).join(',');
    if (wk !== this.key) {
      this.key = wk;
      this.el.querySelector('.wonders').innerHTML = ws.map((w) => this.wonderHtml(w, t)).join('');
    }
    this.el.hidden = !on && !ws.length;
    this.el.querySelector('.sites').hidden = !on;
  }

  teamColor(team) {
    const p = this.M2.d.players.find((q) => q.team === team);
    return p ? this.color(p.idx) : '#d9cba4';
  }

  wonderHtml(w, t) {
    const owner = ownerAt(w, t), who = esc(this.R.players.get(owner)?.name ?? 'Gaia'), col = this.color(owner);
    const built = w.builtAt > -Infinity ? w.builtAt : w.born, frac = w.on ? Math.max(0, Math.min(1, w.php / w.maxhp)) : 0;
    if (t < built) {
      return `<span class="won" title="${who} is building a wonder: it wins the game if it stands 15:00 once finished">🏛 <span style="color:${col}">Wonder constructing (${who})</span> ${Math.round(frac * 100)}%</span>`;
    }
    const left = WONDER_WIN - (t - built);
    return `<span class="won" title="${who}'s wonder finished at ${fmtTime(built)}: they win at ${fmtTime(built + WONDER_WIN)} unless it is destroyed. HP ${Math.round(w.php)} / ${Math.round(w.maxhp)}">`
      + `<span class="cd" style="color:${col};border-color:${col}">🏛 ${left > 0 ? `Wonder victory ${clock(left)}` : 'Wonder victory!'}</span>`
      + `<span class="whp"><i style="width:${(frac * 100).toFixed(1)}%"></i></span></span>`;
  }
}

const VICTIM = { villager: 'Villagers', ship: 'Ships', siege: 'Siege', religious: 'Monks', hero: 'Hero', livestock: 'Livestock' };
const ECON = { trader: 'Traders', fishboat: 'Fishing boats', ship: 'Trade ships' };

/**
 * Under-attack notices (#toasts): when an enemy hits a player's units or buildings where that player had no alert
 * (M2.alerts, model.js prepAlerts) within RV.ALERT_MERGE m for RAID_QUIET s, a notice on the left edge names attacker,
 * victim and what was hit; clicking it jumps the camera there, and the map's alert ring (marks.js) pulses at the spot.
 * Raised during playback only (not for what a seek skips), for the sides the Vision setting shows; fades after
 * TOAST_MS of real time.
 */
export class RaidToasts {
  constructor({ RV, M2, R, color, focus, enabled, vision }) {
    Object.assign(this, { RV, M2, R, color, focus, enabled, vision });
    this.box = $('toasts');
    const al = M2.alerts, merge = RV.ALERT_MERGE;
    this.raids = al.filter((a, i) => {
      for (let j = i - 1; j >= 0 && a.t - al[j].t <= RAID_QUIET; j--) {
        const b = al[j];
        if (b.owner === a.owner && Math.hypot(b.x - a.x, b.z - a.z) < merge) return false;
      }
      return true;
    });
    this.raidT = Float64Array.from(this.raids, (r) => r.t);
    this.last = null;
  }

  update(t) {
    const last = this.last;
    this.last = t;
    if (!this.enabled() || last == null || !(t > last) || t - last > TOAST_JUMP) return;
    const vis = this.vision();
    let teams = 0;
    if (vis) for (const p of this.M2.d.players) if ((1 << (p.idx - 1)) & vis) teams |= this.M2.teamMask.get(p.team);
    for (let i = idxAt(this.raidT, last) + 1; i < this.raids.length && this.raidT[i] <= t; i++) {
      const r = this.raids[i];
      if (!vis || (1 << (r.owner - 1)) & teams) this.show(r);
    }
  }

  what(r) {
    const v = r.victim;
    if (v.cat === 'building') return this.RV.nameAt(v, r.t);
    if (v.cat === 'econ') return ECON[v.type] ?? 'Workers';
    return VICTIM[v.cat] ?? 'Army';
  }

  show(r) {
    const name = (idx) => esc(this.R.players.get(idx)?.name ?? 'Gaia');
    const el = document.createElement('div');
    el.className = 'toast panel';
    el.title = 'Jump to the attack';
    el.innerHTML = `<span class="tt">${fmtTime(r.t)}</span>⚔️ <b style="color:${this.color(r.by)}">${name(r.by)}</b> attacking `
      + `<b style="color:${this.color(r.owner)}">${name(r.owner)}</b>'s ${esc(this.what(r))}`;
    el.addEventListener('click', () => { this.focus(r.x, r.z); el.remove(); });
    while (this.box.children.length >= TOAST_MAX) this.box.firstElementChild.remove();
    this.box.append(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 700); }, TOAST_MS);
  }

  clear() { this.box.replaceChildren(); }
}
