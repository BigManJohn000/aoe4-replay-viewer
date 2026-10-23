/**
 * panels.js — the 2D viewer's side panels in the 3D page (app.js): the map key, the "On screen" army composition, unit
 * name labels, and the key-moments list with its caption (optional notes/<name>.js). They read the 2D model (M2, from
 * viewer/model.js) and its icon art (viewer/map.js: RV.markIcon, RV.unitIcon …), and the 3D replay `R` for what is on
 * screen now.
 */
import { fmtTime } from './core/replay.js';

const ICON_PX = 22; // key and panel icons (the map's own art; the page shows them at this size)
const $ = (id) => document.getElementById(id);
const fmtK = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)));

/** Element with attributes (`style` object, `on…` handlers, `title`, `class`) and children (strings, nodes, null). */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids) if (k != null) el.append(k);
  return el;
}

/**
 * The map key (2D app.js buildHeader), its "Lines & marks" row: what the lines and rings drawn on the ground mean, with
 * the 2D map's own icons; hovering an item explains it. (The 2D key's unit, building and map-object rows show its icon
 * art, which the 3D models replace, so they are left out.) Hidden from its own button, the Key checkbox or K; the choice
 * is kept in localStorage.
 */
export class Legend {
  constructor(RV, M2) {
    this.box = $('legend');
    this.show = $('legendShow');
    this.opt = $('optLegend');
    const row = (id, title, items) => {
      const el = $(id);
      el.append(h('b', {}, title), ...items.map(([src, it]) => h('span', { title: it.tip }, h('img', { src }), it.label)));
      el.hidden = !items.length;
    };
    row('legendMarks', 'Lines & marks', Object.entries(RV.MARKS).filter(([k]) => k !== 'fight' || M2.fights.length)
      .map(([k, it]) => [RV.markIcon(k, ICON_PX), it]));
    this.opt.addEventListener('change', () => this.set(this.opt.checked));
    $('legendHide').onclick = () => this.set(false);
    this.show.onclick = () => this.set(true);
    this.set(localStorage.getItem('rv3d.key') !== '0');
  }

  set(on) {
    this.box.hidden = !on;
    this.show.hidden = on;
    this.opt.checked = on;
    localStorage.setItem('rv3d.key', on ? '1' : '0');
  }

  toggle() { this.set(this.box.hidden); }
}

/**
 * "On screen" (2D map.tallyOnScreen + app.js renderComp): per player, the army units and villagers inside the view that
 * the filters and Vision show, grouped by unit name with the map icon; rebuilt only when the counts change.
 */
export class ArmyComp {
  constructor(RV, M2, R, camera, nameAt) {
    Object.assign(this, { RV, M2, R, camera, nameAt });
    this.box = $('comp');
    this.key = null;
    // 2D type of each tallied entity (its 3D twin has the same id): villagers and military units only
    this.rows = R.ents.flatMap((e) => {
      const m2 = M2.byId.get(e.id);
      return m2?.type && (m2.type === 'villager' || RV.isMilitary(e.cat)) ? [{ e, type: m2.type, value: m2.value }] : [];
    });
  }

  /** `on`: the Army comp option; t: replay time (unit names follow the tier its owner's upgrades reached). */
  update(on, t, vec3) {
    const { RV, M2, R, camera } = this, rows = [];
    if (on) {
      const comp = new Map();
      for (const r of this.rows) {
        const e = r.e;
        if (!e.on || !e.shown) continue;
        vec3.set(e.px, e.gy, -e.pz).project(camera);
        if (vec3.z > 1 || Math.abs(vec3.x) > 1 || Math.abs(vec3.y) > 1) continue;
        let m = comp.get(e.pown);
        if (!m) comp.set(e.pown, m = new Map());
        const name = this.nameAt(e, t), c = m.get(name);
        if (c) { c.n++; c.value += r.value; } else m.set(name, { n: 1, type: r.type, value: r.value });
      }
      for (const p of M2.d.players) {
        const m = comp.get(p.idx);
        if (m) rows.push([p, [...m].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))]);
      }
    }
    const key = rows.map(([p, items]) => `${p.idx}:${items.map(([name, c]) => name + c.n).join(',')}`).join('|');
    if (key === this.key) return;
    this.key = key;
    const box = this.box, scroll = box.scrollTop; // rebuilding empties the box, which would reset a scrolled panel
    box.textContent = '';
    box.hidden = !rows.length;
    if (!rows.length) return;
    box.append(h('div', { class: 'ch' }, 'On screen'));
    for (const [p, items] of rows) {
      let army = 0, value = 0, vil = 0;
      for (const [, c] of items) if (c.type === 'villager') vil += c.n; else { army += c.n; value += c.value; }
      const col = R.players.get(p.idx)?.color ?? p.color;
      box.append(h('div', { class: 'cp' }, h('i', { style: { background: col } }), h('b', {}, p.name),
        h('span', { class: 'muted' }, `${army} army${value ? ` · ${fmtK(value)}` : ''}${vil ? ` · ${vil} villagers` : ''}`)));
      const grid = h('div', { class: 'cg' });
      for (const [name, c] of items) {
        if (c.type === 'villager') continue;
        grid.append(h('span', { title: `${name} (${RV.UNIT_TYPES[c.type].label})` },
          h('img', { src: RV.unitIcon(c.type, col, ICON_PX) }), h('b', {}, c.n), name));
      }
      if (grid.childElementCount) box.append(grid);
    }
    box.scrollTop = scroll;
  }
}

/**
 * Military unit names beside the units (2D "Labels": shown once zoomed in past 5 px per metre), as pooled DOM labels
 * in #labels.
 */
export class UnitLabels {
  static MAX = 80;
  constructor(RV, R, camera, nameAt) {
    Object.assign(this, { R, camera, nameAt });
    this.army = R.ents.filter((e) => R.isMilitary(e.cat));
    this.pool = Array.from({ length: UnitLabels.MAX }, () => {
      const el = h('div', { class: 'ulabel' });
      el.style.display = 'none';
      $('labels').append(el);
      return { el, text: '' };
    });
    this.used = 0;
  }

  /** `wpp`: world metres per CSS pixel at the camera's target (labels show below 1/5 m, the 2D viewer's 5 px/m). */
  update(on, t, w, h_, vec3, wppAt) {
    let n = 0;
    if (on) {
      for (const e of this.army) {
        if (n >= UnitLabels.MAX) break;
        if (!e.on || !e.shown) continue;
        vec3.set(e.px, e.gy + 1, -e.pz);
        if (wppAt(vec3) >= 0.2) continue;
        vec3.project(this.camera);
        if (vec3.z > 1 || Math.abs(vec3.x) > 1.02 || Math.abs(vec3.y) > 1.02) continue;
        const l = this.pool[n++], text = this.nameAt(e, t);
        if (l.text !== text) { l.text = text; l.el.textContent = text; }
        l.el.style.display = 'block';
        l.el.style.transform = `translate(${((vec3.x * 0.5 + 0.5) * w + 10).toFixed(1)}px, ${((-vec3.y * 0.5 + 0.5) * h_).toFixed(1)}px) translate(0, -50%)`;
      }
    }
    for (let i = n; i < this.used; i++) this.pool[i].el.style.display = 'none';
    this.used = n;
  }
}

/**
 * Key moments (2D app.js buildMoments / showMoment): notes/<name>.js lists moments {t, title, data, read?, vision?,
 * fight?, x?, z?, r?, speed?, tab?}; one is shown by stepping to its time, setting the Vision, framing it and playing
 * from there, with a caption of what the data show and the author's read. `api` supplies the viewer's controls:
 * { seek, play, setSpeed, speeds, setVision(mask), clearSelection, focus(x, z, r), name }.
 */
export class Moments {
  constructor(M2, R, notes, api) {
    Object.assign(this, { M2, R, notes, api });
    this.idx = -1;
    $('momentsBox').hidden = false;
    $('momentsTitle').textContent = notes.title || 'Key moments';
    const list = $('momentList');
    notes.moments.forEach((m, i) => {
      list.append(h('div', { class: 'moment', 'data-i': i, onclick: () => this.show(i) },
        h('div', { class: 'row1' }, h('span', {}, h('b', {}, `${i + 1}. `), m.title), h('span', { class: 'muted' }, fmtTime(m.t)))));
    });
    list.append(h('p', { class: 'muted' }, 'Data = measured from the recording. My read = interpretation (game knowledge + comparison with the other players).'));
  }

  /** The Vision mask a note's vision string ("all", "team:n", "player:n") stands for; 0 = everyone. */
  visionMask(v) {
    const [kind, n] = (v || 'all').split(':');
    if (kind === 'team' && this.M2.teamMask.has(+n)) return this.M2.teamMask.get(+n);
    if (kind === 'player' && this.M2.playerByIdx.has(+n)) return 1 << (+n - 1);
    return 0;
  }

  show(i) {
    const { notes, api } = this, ms = notes.moments;
    this.idx = Math.max(0, Math.min(ms.length - 1, i));
    const m = ms[this.idx];
    api.setVision(this.visionMask(m.vision));
    const f = m.fight != null ? this.R.fights.find((x) => x.id === m.fight) : null;
    api.clearSelection();
    api.seek(m.t);
    if (m.x != null) api.focus(m.x, m.z, m.r || 40);
    else if (f) api.focus(f.x, f.z, f.radius);
    api.setSpeed(api.speeds.includes(m.speed || 1) ? (m.speed || 1) : 1);
    api.play();
    for (const n of document.querySelectorAll('.moment')) n.classList.toggle('sel', +n.dataset.i === this.idx);
    this.render();
    history.replaceState(null, '', `#${encodeURIComponent(api.name)}/${this.idx + 1}`); // no hashchange, no reload
  }

  render() {
    const box = $('caption');
    box.textContent = '';
    if (this.idx < 0) { box.hidden = true; return; }
    const ms = this.notes.moments, m = ms[this.idx];
    box.append(
      h('div', { class: 'capHead' },
        h('b', {}, `${this.idx + 1}/${ms.length} · ${m.title}`),
        h('button', { class: 'x', title: 'Close (Esc)', onclick: () => this.close() }, '×')),
      h('p', {}, h('span', { class: 'tag' }, 'Data'), m.data),
      m.read ? h('p', {}, h('span', { class: 'tag read' }, 'My read'), m.read) : null,
      h('div', { class: 'actions' },
        h('button', { onclick: () => this.show(this.idx - 1), disabled: this.idx === 0 }, 'Prev (P)'),
        h('button', { onclick: () => this.show(this.idx) }, 'Replay'),
        h('button', { onclick: () => this.show(this.idx + 1), disabled: this.idx === ms.length - 1 }, 'Next (N)')));
    box.hidden = false;
  }

  /** Close the caption; true if one was open. */
  close() {
    if (this.idx < 0) return false;
    this.idx = -1;
    this.render();
    for (const n of document.querySelectorAll('.moment')) n.classList.remove('sel');
    history.replaceState(null, '', `#${encodeURIComponent(this.api.name)}`);
    return true;
  }

  step(dir) { this.show(this.idx < 0 ? 0 : this.idx + dir); }
}
