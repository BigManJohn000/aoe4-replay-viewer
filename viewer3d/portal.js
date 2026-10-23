/**
 * portal.js: the match menu, the Replay Recorder panel and "Watch in game" for the 3D viewer.
 *
 * Recordings: every name in shared/data/index.js (kept by the 2D project's convert.py), labelled from
 * shared/data/trends/games.js (tools/trends.py: per recording its players, civilisations, teams, date, length and
 * size; per aoe4world game its map and results). Opening one reloads the viewer on #<name>.
 *
 * Replay Recorder: the 2D project's tools/recorder_app.py (127.0.0.1:47811), reached through serve.mjs's /api/
 * pass-through, which answers 502 {offline} while it isn't running. GET /api/state lists the matches it downloads and
 * records; POST /api/add {text} takes aoe4world links, /api/start, /api/stop, /api/clear, /api/pick {what: game |
 * replays | auto}. Finished recordings land in the shared data folder, so they open here like any other.
 *
 * Watch in game: POST /api/watch {name, t, x, z, players, force} opens Age of Empires IV on the replay at t seconds
 * with the camera on (x, z) in game coordinates; it answers {confirm} to ask before closing a running game, {error}
 * when it cannot; GET /api/watch then reports progress {state: running | …, text}.
 */
import { prettyCiv, fmtTime } from './core/replay.js';

const VIEWER_2D = 'http://127.0.0.1:47811/viewer/index.html'; // the 2D viewer as Replay Recorder serves it
const BIG_MB = 15;                                             // recordings this large take a while to open in 3D
const OFFLINE = 'Replay Recorder is not running. Double-click “Replay Recorder.bat” in the Fusion folder.';

const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const duration = (s) => (s >= 3600 ? `${(s / 3600).toFixed(1)} h` : `${Math.max(1, Math.round(s / 60))} min`);

/** The open match: set by initPortal; before that (a recording that failed to load) only the menu works. */
let ctx = { name: null, time: () => 0, view: () => null, players: [] };

// ── notice under the top bar ──
let noticeTimer = 0;
/** Show a message under the top bar for `ms` (0 keeps it until closed or replaced); empty text hides it. */
export function showNotice(text, { html = false, ms = 15000 } = {}) {
  const n = el('notice');
  clearTimeout(noticeTimer);
  if (!text) { n.classList.remove('show'); return; }
  n.innerHTML = `<button class="x" title="Close">×</button><div>${html ? text : esc(text)}</div>`;
  n.querySelector('.x').onclick = () => n.classList.remove('show');
  n.style.top = belowTopbar();
  n.classList.add('show');
  if (ms) noticeTimer = setTimeout(() => n.classList.remove('show'), ms);
}
/** CSS top just under the top bar (it wraps onto more lines in team games). */
const belowTopbar = () => `${Math.round(el('topbar').getBoundingClientRect().bottom + 8)}px`;

/** Replay Recorder call through serve.mjs (POST when `body` is given); null while it isn't running. */
async function api(path, body) {
  try {
    const r = await fetch(path, body === undefined ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    return j.offline ? null : j;
  } catch { return null; }
}

/**
 * One `window.<name> = <json>;` line of a classic data script, read without running it; null when missing or
 * unreadable. index.js holds several such lines (REPLAY_INDEX, REPLAY_NOTED), one per line.
 */
async function scriptData(url, name) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    const prefix = `window.${name} = `;
    const line = (await r.text()).split('\n').find((l) => l.startsWith(prefix));
    return line ? JSON.parse(line.slice(prefix.length).trim().replace(/;$/, '')) : null;
  } catch { return null; }
}

// ── recordings ──
/** Local calendar date of a timestamp (ms) as YYYY-MM-DD. */
const day = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/**
 * Menu rows, newest first: names from index.js, details from the trends file where it knows the recording. The date
 * is aoe4world's start time (the recording's own date text follows the PC's locale), else the file time (ns).
 */
function recordings(names, trends) {
  return names.map((name) => {
    const m = trends?.matches?.[name];
    if (!m) return { name, when: 0, date: '', text: name.toLowerCase() };
    const g = trends.games?.[m.game];
    const known = new Map((g?.players ?? []).map((p) => [p.name, p]));
    const players = m.players ?? [];
    const teams = [...new Set(players.map((p) => p.team))].map((team) => players.filter((p) => p.team === team)
      .map((p) => ({ name: p.name, civ: prettyCiv(known.get(p.name)?.civ || p.civ || 'unknown'), win: known.get(p.name)?.result === 'win' })));
    const when = (g?.started && Date.parse(g.started)) || (m.mtime ? m.mtime / 1e6 : 0);
    const r = { name, when, date: when ? day(when) : '', teams, map: g?.map, mode: teams.map((t) => t.length).join('v'), duration: m.duration, mb: m.size / 1e6 };
    r.text = [name, r.date, r.map, ...teams.flat().flatMap((p) => [p.name, p.civ])].join(' ').toLowerCase();
    return r;
  }).sort((a, b) => b.when - a.when);
}

let list = [], recorderUp = false;

function matchRow(m) {
  const cur = m.name === ctx.name;
  const who = m.teams
    ? m.teams.map((team) => team.map((p) => `${esc(p.name)} <span class="civ">${esc(p.civ)}</span>${p.win ? ' <span class="win">won</span>' : ''}`)
      .join(', ')).join(' <span class="vs">vs</span> ')
    : `${esc(m.name)} <span class="civ">no match details</span>`;
  const meta = [m.map, m.mode, m.duration ? fmtTime(m.duration) : null].filter(Boolean).map(esc);
  if (m.mb) meta.push(m.mb > BIG_MB ? `<span class="big" title="Big recording: takes a while to open in 3D">${m.mb.toFixed(1)} MB</span>` : `${m.mb.toFixed(1)} MB`);
  const at = cur ? `/t${Math.floor(ctx.time())}` : '';
  const twoD = recorderUp
    ? `<a class="btn" href="${VIEWER_2D}#${encodeURIComponent(m.name)}${at}" target="_blank" rel="noopener" title="Open in the 2D viewer (new tab)">2D</a>`
    : '<span class="btn off" title="Start Replay Recorder.bat to open recordings in the 2D viewer">2D</span>';
  return `<div class="mrow${cur ? ' cur' : ''}">
    <span class="when">${esc(m.date)}</span>
    <span class="who">${who}</span>
    <span class="acts">${cur ? '<span class="now">Open now</span>' : `<button data-open="${esc(m.name)}">Open in 3D</button>`}${twoD}</span>
    <span class="meta">${meta.join(' · ')}</span>
  </div>`;
}

function renderList() {
  const words = el('mFind').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = list.filter((m) => words.every((w) => m.text.includes(w)));
  el('mList').innerHTML = rows.length ? rows.map(matchRow).join('')
    : `<p class="muted">${list.length ? 'No recording matches the filter.' : 'No recordings yet.'}</p>`;
}

async function loadRecordings() {
  const [names, trends] = await Promise.all([scriptData('shared/data/index.js', 'REPLAY_INDEX'),
    scriptData('shared/data/trends/games.js', 'TRENDS')]);
  if (!names) { el('mList').innerHTML = '<p class="warn">Could not read the recordings list (shared/data/index.js).</p>'; return; }
  list = recordings(names, trends);
  renderList();
}

function open3D(name) {
  if (name === ctx.name) { closeMatches(); return; }
  location.hash = encodeURIComponent(name);
  location.reload(); // also when the viewer stopped before its hashchange handler (a recording that failed to load)
}

// ── Replay Recorder panel ──
function check(ok, title, extra = '') {
  return `<div class="check"><span class="mark ${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'}</span><span>${title}</span>${extra}</div>`;
}

function renderRecorder(s) {
  el('rOn').hidden = !s;
  if (!s) { el('rChecks').innerHTML = `<p class="warn">${esc(OFFLINE)} This panel connects by itself once it runs.</p>`; return; }
  const g = s.game, st = s.steam;
  el('rChecks').innerHTML = (g.found
    ? check(true, 'Age of Empires IV found', `<span class="path">${esc(g.dir)} · version ${esc(g.build ?? '?')} · ${g.picked ? 'picked by you' : 'found through Steam'}</span>
        <button data-pick="game">Change…</button>${g.picked ? '<button data-pick="auto">Find automatically</button>' : ''}`)
    : check(false, g.dir ? 'Age of Empires IV is not in the picked folder' : 'Age of Empires IV not found',
      `${g.dir ? `<span class="path">${esc(g.dir)}</span>` : ''}<button class="primary" data-pick="game">Pick its folder…</button>`))
    + check(st.signedIn, st.signedIn ? 'Steam running and signed in' : st.running ? 'Steam is running but not signed in' : 'Steam is not running',
      st.signedIn ? '' : '<span class="muted">Recording needs Steam open and signed in.</span>')
    + check(true, 'Replays are saved in', `<span class="path">${esc(s.replaysDir)}</span><button data-pick="replays">Change…</button>`);

  const cls = { done: 'ok', recording: 'warn', error: 'bad', failed: 'bad', downloading: 'muted', waiting: 'muted' };
  el('rRows').innerHTML = s.items.length ? s.items.slice().reverse().map((it) => {
    const stem = it.view?.split('#')[1];
    return `<div class="rrow">
      <a class="title" href="${esc(it.link)}" target="_blank" rel="noopener">${esc(it.title)}</a>
      <span class="muted">${esc([it.map, it.length].filter(Boolean).join(' · '))}</span>
      <span class="status"><span class="${cls[it.status] ?? 'muted'}">${esc(it.detail)}</span>${it.status === 'recording'
        ? `<span class="bar"><span style="width:${((it.progress ?? 0) * 100).toFixed(1)}%"></span></span>` : ''}</span>
      <span class="acts">${stem ? `<button data-open="${esc(stem)}">Open in 3D</button><a class="btn" href="${VIEWER_2D}#${encodeURIComponent(stem)}" target="_blank" rel="noopener">2D</a>` : ''}</span>
    </div>`;
  }).join('') : '<p class="muted">No matches yet.</p>';

  const c = s.counts;
  el('rSummary').textContent = [`${c.done} done`, c.recording && '1 recording', `${c.waiting} waiting`,
    !s.paused && (c.recording || c.waiting) && `about ${duration(s.secondsLeft)} left`].filter(Boolean).join(' · ');
  const toggle = el('rToggle');
  toggle.textContent = s.paused ? 'Start' : 'Stop';
  toggle.className = s.paused ? 'primary' : '';
  toggle.dataset.api = s.paused ? '/api/start' : '/api/stop';
  el('rClear').hidden = s.items.length <= c.recording; // the match being recorded stays in the list
  el('rNote').textContent = s.note ?? '';
}

let pollTimer = 0, polling = false, lastDone = null;
/** Refresh the Replay Recorder state while the menu is open; new finished recordings refresh the list. */
async function poll() {
  clearTimeout(pollTimer);
  if (polling) return;
  polling = true;
  const s = await api('/api/state');
  polling = false;
  if (!menuOpen()) return;
  renderRecorder(s);
  if (!!s !== recorderUp) { recorderUp = !!s; renderList(); }
  const done = s?.counts?.done ?? null;
  if (done != null && lastDone != null && done > lastDone) loadRecordings();
  if (done != null) lastDone = done;
  pollTimer = setTimeout(poll, s ? 1500 : 3000);
}

async function addLinks() {
  const r = await api('/api/add', { text: el('rLinks').value });
  const msg = el('rMsg');
  if (!r) { msg.className = 'bad'; msg.textContent = OFFLINE; return; }
  if (!r.links) {
    msg.className = 'bad';
    msg.textContent = 'No match link found. A match link looks like https://aoe4world.com/players/…/games/…';
    return;
  }
  msg.className = 'ok';
  msg.textContent = [r.added && `Added ${r.added} match${r.added > 1 ? 'es' : ''}.`, r.known && `${r.known} already in the list.`].filter(Boolean).join(' ');
  el('rLinks').value = '';
  poll();
}

async function onMenuClick(e) {
  const b = e.target.closest('button');
  if (!b) return;
  b.blur(); // keep Space for play/pause
  if (b.dataset.open) open3D(b.dataset.open);
  else if (b.dataset.tab) showTab(b.dataset.tab);
  else if (b.hasAttribute('data-close')) closeMatches();
  else if (b.dataset.pick) {
    const r = await api('/api/pick', { what: b.dataset.pick });
    if (r?.error) alert(r.error);
    poll();
  } else if (b.id === 'rAdd') addLinks();
  else if (b.id === 'rToggle') { await api(b.dataset.api, {}); poll(); }
  else if (b.id === 'rClear') {
    if (!confirm('Remove all matches from the list? Downloaded replays and recordings stay on disk, and the viewer still '
      + 'opens them. A match being recorded right now stays in the list.')) return;
    await api('/api/clear', {});
    poll();
  }
}

// ── the menu ──
const menuOpen = () => el('matches').classList.contains('open');

function showTab(tab) {
  for (const b of el('matches').querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === tab);
  for (const p of el('matches').querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== tab;
}

function buildMenu() {
  const box = el('matches');
  box.innerHTML = `
    <div class="mhead">
      <b>Matches</b>
      <button data-tab="list" class="on">Recordings</button>
      <button data-tab="rec">Record new</button>
      <button class="x" data-close title="Close (Esc)">×</button>
    </div>
    <section data-pane="list">
      <input id="mFind" type="search" placeholder="Filter by player, civilisation, map or date" autocomplete="off">
      <div id="mList"><p class="muted">Loading…</p></div>
    </section>
    <section data-pane="rec" hidden>
      <div id="rChecks"><p class="muted">Connecting to Replay Recorder…</p></div>
      <div id="rOn" hidden>
        <p class="muted">Paste aoe4world.com match links (one or many) and press Add. Replay Recorder downloads each match,
          records it with the game (one at a time) and it then appears under Recordings.</p>
        <textarea id="rLinks" placeholder="https://aoe4world.com/players/…/games/…"></textarea>
        <div class="row"><button id="rAdd" class="primary">Add</button><span id="rMsg"></span></div>
        <div id="rRows"></div>
        <div class="row"><span id="rSummary"></span><span class="grow"></span><button id="rClear">Clear list</button><button id="rToggle"></button></div>
        <div id="rNote" class="warn"></div>
      </div>
    </section>`;
  box.addEventListener('click', onMenuClick);
  el('mFind').addEventListener('input', renderList);
  // Esc or a click outside closes it
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && menuOpen()) closeMatches(); });
  addEventListener('pointerdown', (e) => {
    if (menuOpen() && !box.contains(e.target) && !e.target.closest?.('#matchesBtn')) closeMatches();
  });
}

/** Open the match menu (the Matches button; also offered when a recording fails to load). */
export function openMatches() {
  if (!el('matches').firstElementChild) buildMenu();
  const top = belowTopbar();
  Object.assign(el('matches').style, { top, maxHeight: `calc(100% - ${top} - 96px)` }); // clear of the timeline
  el('matches').classList.add('open');
  lastDone = null;
  loadRecordings();
  poll();
  el('mFind').focus();
}

function closeMatches() {
  el('matches').classList.remove('open');
  clearTimeout(pollTimer);
}

// ── Watch in game ──
let watchTimer = 0;
async function watchInGame(force = false) {
  const r = await api('/api/watch', { name: ctx.name, t: ctx.time(), ...ctx.view(), players: ctx.players, force });
  if (!r) { showNotice(OFFLINE); return; }
  if (r.confirm) { if (confirm(r.confirm)) watchInGame(true); return; }
  if (r.error) { showNotice(r.error, { ms: 0 }); return; }
  watchProgress();
}

/** Follow the game opening: the button stays off and the message stays up while it runs; the last one stays 15 s. */
async function watchProgress() {
  clearTimeout(watchTimer);
  const w = await api('/api/watch');
  const running = w?.state === 'running';
  el('watchGame').disabled = running;
  if (!w) showNotice(OFFLINE);
  else showNotice(w.text, { ms: running ? 0 : 15000 });
  if (running) watchTimer = setTimeout(watchProgress, 1000);
}

/**
 * Wire the top bar's Matches and Watch in game buttons for the open match.
 * time() → replay seconds; view() → {x, z} camera target in game coordinates; players: the recording's player names.
 */
export function initPortal({ name, time, view, players }) {
  ctx = { name, time, view, players };
  el('matchesBtn').onclick = (e) => { e.currentTarget.blur(); menuOpen() ? closeMatches() : openMatches(); };
  el('watchGame').onclick = (e) => { e.currentTarget.blur(); watchInGame(); };
}
