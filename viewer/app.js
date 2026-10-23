"use strict";
(function (RV) {
  const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16, 32];
  const $ = s => document.querySelector(s);

  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "style" && typeof v === "object") Object.assign(n.style, v);
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : String(kid));
    return n;
  }

  const fmtK = v => (v >= 1000 ? (v / 1000).toFixed(1) + "k" : String(Math.round(v)));
  const ICON_PX = 22; // key and panel icons (the map's own art; style.css shows them at this size)

  const S = {
    t: 0, playing: false, speedIdx: 2, viewMask: 0,
    showAttacks: false, showHeat: false, showAlerts: false, showDmg: true, showHeals: true, showShots: true, showSplash: false, showRange: false,
    showTrails: true, showOrders: true, showEcoOrders: false, showLabels: false,
    showTerrain: true, showResources: true, showComp: true, showCams: false, showCaster: true, showEcoDebt: true,
    selected: null, group: null, hover: null, follow: false, fight: null, dirty: true, mouse: null,
  };
  let M, map, tl, caster;

  const DEFAULT_REPLAY = "aoe4_245598603"; // opened when the link names no recording (the showcase match)

  // ---------- boot / loading ----------
  function boot() {
    const names = window.REPLAY_INDEX || [];
    const sel = $("#replay");
    if (!names.length) {
      showNotice("No recordings yet. Run tools/record_replay.py, then tools/convert.py.");
      return;
    }
    for (const n of names) sel.append(h("option", { value: n }, n));
    const [wantName, wantMoment] = decodeURIComponent(location.hash.slice(1)).split("/"); // #<replay>[/<moment>|/t<s>]
    const fallback = names.includes(DEFAULT_REPLAY) ? DEFAULT_REPLAY : names[names.length - 1];
    sel.value = names.includes(wantName) ? wantName : fallback;
    sel.addEventListener("change", () => { location.hash = sel.value; });
    window.addEventListener("hashchange", () => location.reload());
    load(sel.value, wantMoment || "");
  }

  function loadScript(src) {
    return new Promise(resolve => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.body.append(s);
    });
  }

  async function load(name, moment) {
    showNotice(`Loading ${name}...`);
    const file = encodeURIComponent(name);
    if (!await loadScript(`data/${file}.js`)) { showNotice(`Could not load data/${name}.js`); return; }
    // optional key-moment annotations, listed in data/index.js by tools/convert.py
    if ((window.REPLAY_NOTED || []).includes(name)) await loadScript(`notes/${file}.js`);
    start(window.REPLAY_DATA[name], (window.REPLAY_NOTES || {})[name], moment);
  }

  function showNotice(text) {
    const n = $("#notice");
    n.textContent = text;
    n.hidden = !text;
  }

  function start(d, notes, moment) {
    M = RV.prepare(d);
    S.viewMask = M.allMask;
    S.t = d.recordStart;
    buildHeader();
    caster = RV_CASTER.create($("#casterHud"), M);
    map = new RV.MapView($("#map"), M, S);
    // Alt is a selection modifier, not the browser's menu/link action.
    for (const event of ["mousedown", "mouseup", "click"]) $("#map").addEventListener(event, ev => {
      if (ev.altKey) ev.preventDefault();
    }, { capture: true });
    tl = new RV.Timeline($("#timeline"), M, S);
    buildFightList();
    bindControls();
    showNotice(d.recorderErrors && d.recorderErrors.length ? `Recorder reported ${d.recorderErrors.length} errors` : "");
    window.addEventListener("resize", () => { map.resize(); tl.resize(); S.dirty = true; });
    // Dock/layout changes resize the canvas without discarding its current focus, zoom or caption offset.
    new ResizeObserver(() => { map.resize(); S.dirty = true; }).observe($("#mapWrap"));
    if (notes && notes.moments && notes.moments.length) {
      buildMoments(notes);
      if (+moment) showMoment(moment - 1);
    }
    if (/^t\d+$/.test(moment)) { // from watchInGame outside Replay Recorder
      S.seek(+moment.slice(1));
      showNotice(`Press “Watch in game” to open the game at ${RV.fmtTime(S.t)}.`);
    }
    requestAnimationFrame(frame);
    RV.app = { M, S, map, tl, notes }; // console access for debugging
  }

  // ---------- state actions ----------
  S.seek = t => {
    S.t = Math.max(0, Math.min(M.duration, t));
    S.dirty = true;
  };
  // One unit or building (click), or clear with null; either ends a highlight.
  S.select = e => {
    S.selected = e;
    S.group = null;
    if (!e) S.follow = false;
    S.dirty = true;
    if (e) switchTab("unit");
    else renderUnit(true);
  };
  // What a drag box held (map.js boxed): ringed on the map and summed up in the Selection tab.
  S.highlight = list => {
    if (!list.length) return S.select(null);
    if (list.length === 1) return S.select(list[0]);
    S.selected = null;
    S.follow = false;
    S.group = list;
    S.dirty = true;
    switchTab("unit");
  };
  const selection = () => (S.group ? S.group.slice() : S.selected ? [S.selected] : []);
  // Shift+click: add e to the selection, or drop it when already in.
  S.toggle = e => {
    const list = selection(), i = list.indexOf(e);
    if (i >= 0) list.splice(i, 1); else list.push(e);
    S.highlight(list);
  };
  // Alt+click on the map or right-click in the tray: drop every selected entity with that blueprint.
  S.dropBp = bp => S.highlight(selection().filter(x => x.bp !== bp));
  // A click in the tray: drop one entity with that blueprint (the last one selected that is on the map).
  S.dropOne = bp => {
    const list = selection();
    let k = -1;
    for (let i = list.length - 1; i >= 0 && k < 0; i--) if (list[i].bp === bp && list[i].on) k = i;
    if (k >= 0) list.splice(k, 1);
    S.highlight(list);
  };
  S.focusFight = f => {
    S.fight = f;
    S.seek(Math.max(0, f.start - 5));
    map.focus(f.x, f.z, f.radius);
    S.speedIdx = SPEEDS.indexOf(1);
    S.playing = true;
    S.follow = false;
    switchTab("fights");
    renderFightDetail();
    highlightFightList();
  };

  // ---------- header ----------
  function buildHeader() {
    const box = $("#players");
    const SM = M.d.summary; // aoe4world match summary: absent when there's no .summary.json beside the replay
    for (const p of M.players) {
      const r = SM && SM.players && SM.players[String(p.idx)];
      box.append(h("span", { class: "chip" }, h("i", { style: { background: p.color } }), p.name,
        h("span", { class: "team" }, `${p.civ} · T${p.team + 1}`),
        r && r.result ? h("span", { class: "res " + r.result, hidden: true }, r.result) : null));
    }
    if (SM) {
      const info = [SM.map && SM.map.name, SM.map && SM.map.biome, SM.map && SM.map.size, SM.mode, SM.winReason,
        SM.startedAt && new Date(SM.startedAt * 1000).toLocaleDateString()].filter(Boolean).join(" · ");
      if (info) box.append(h("span", { class: "muted", title: "Map · biome · size · mode · how it ended · played" }, info));
    }
    const view = $("#view");
    view.append(h("option", { value: M.allMask }, "Everything"));
    for (const tm of M.teams) {
      const names = M.players.filter(p => p.team === tm).map(p => p.name).join(" + ");
      view.append(h("option", { value: M.teamMask.get(tm) }, `Team ${tm + 1}: ${names}`));
    }
    for (const p of M.players) view.append(h("option", { value: 1 << (p.idx - 1) }, `${p.name} only`));
    view.addEventListener("change", () => { S.viewMask = +view.value; S.dirty = true; });
    for (const [id, key] of [["optAttacks", "showAttacks"], ["optHeat", "showHeat"], ["optAlerts", "showAlerts"],
      ["optDmg", "showDmg"], ["optHeals", "showHeals"], ["optShots", "showShots"], ["optSplash", "showSplash"], ["optRange", "showRange"],
      ["optTrails", "showTrails"], ["optOrders", "showOrders"],
      ["optEcoOrders", "showEcoOrders"], ["optLabels", "showLabels"], ["optTerrain", "showTerrain"],
      ["optResources", "showResources"], ["optComp", "showComp"], ["optCams", "showCams"], ["optCaster", "showCaster"], ["optEcoDebt", "showEcoDebt"]]) {
      const cb = $("#" + id);
      cb.checked = S[key];
      cb.addEventListener("change", () => { S[key] = cb.checked; S.dirty = true; });
    }
    // the Target fire box and the fight panel's own box are one setting
    $("#optHeat").addEventListener("change", () => { for (const n of document.querySelectorAll("#fightDetail .rvf input[data-heat]")) n.checked = S.showHeat; });
    $("#optTerrain").disabled = !M.terrain;
    $("#optResources").disabled = !M.gaia.length;
    $("#optCams").disabled = !M.cameras.size;
    // The key hides from its own button, the top bar or K and comes back from "Show key"; the choice is kept.
    $("#optLegend").addEventListener("change", ev => showKey(ev.target.checked));
    $("#legendHide").onclick = () => showKey(false);
    $("#legendShow").onclick = () => showKey(true);
    showKey(localStorage.getItem("rv.key") !== "0");
    // Legend: one row per group, listing only what this replay contains, with the map's own icons (grey stands in
    // for player colours); hovering an item explains it.
    const legend = (id, title, items) => {
      const row = $(id);
      row.append(h("b", {}, title), ...items.map(([src, it]) => h("span", { title: it.tip }, h("img", { src }), it.label)));
      row.hidden = !items.length;
    };
    const present = (keys, table) => Object.entries(table).filter(([k]) => keys.has(k));
    const grey = "#9ca3af";
    legend("#legendUnits", "Units", present(new Set(M.ents.map(e => e.type)), RV.UNIT_TYPES)
      .map(([k, it]) => [RV.unitIcon(k, grey, ICON_PX), it]));
    legend("#legendBuildings", "Buildings", present(new Set(M.ents.map(e => e.bkind)), RV.BUILDING_TYPES)
      .map(([k, it]) => [RV.buildingIcon(k, grey, ICON_PX), it]));
    const gaiaKinds = new Set(M.gaia.map(o => o.kind));
    if (M.gaia.some(o => o.amT && (o.kind === "tree" || o.kind === "stealth"))) gaiaKinds.add("chopped"); // recorded wood left
    legend("#legendMap", "Map", present(gaiaKinds, RV.GAIA_STYLE)
      .map(([k, it]) => [RV.gaiaIcon(k, ICON_PX), it]));
    legend("#legendMarks", "Lines & marks", Object.entries(RV.MARKS).filter(([k]) => k !== "fight" || M.fights.length)
      .map(([k, it]) => [RV.markIcon(k, ICON_PX), it]));
  }

  function showKey(on) {
    $("#legend").hidden = !on;
    $("#legendShow").hidden = on;
    $("#optLegend").checked = on;
    updateOptionMenus();
    localStorage.setItem("rv.key", on ? "1" : "0");
  }

  function updateOptionMenus() {
    for (const button of document.querySelectorAll(".option-toggle")) {
      const menu = $("#" + button.getAttribute("aria-controls"));
      const boxes = menu.querySelectorAll("input");
      button.textContent = `${button.dataset.options} ${menu.querySelectorAll("input:checked").length}/${boxes.length} ▾`;
    }
  }

  function bindOptionMenus() {
    const buttons = document.querySelectorAll(".option-toggle");
    const close = () => {
      let open = false;
      for (const button of buttons) {
        const menu = $("#" + button.getAttribute("aria-controls"));
        if (!menu.hidden) open = true;
        menu.hidden = true;
        button.setAttribute("aria-expanded", "false");
      }
      return open;
    };
    for (const button of buttons) button.addEventListener("click", () => {
      const menu = $("#" + button.getAttribute("aria-controls")), open = menu.hidden;
      close();
      menu.hidden = !open;
      button.setAttribute("aria-expanded", String(open));
    });
    $("#top").addEventListener("change", updateOptionMenus);
    document.addEventListener("click", ev => { if (!ev.target.closest(".option-menu")) close(); });
    document.addEventListener("keydown", ev => {
      if (ev.key === "Escape" && close()) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    });
    updateOptionMenus();
  }

  // ---------- controls ----------
  function bindControls() {
    $("#play").onclick = togglePlay;
    $("#back").onclick = () => S.seek(S.t - 5);
    $("#fwd").onclick = () => S.seek(S.t + 5);
    $("#slower").onclick = () => setSpeed(S.speedIdx - 1);
    $("#faster").onclick = () => setSpeed(S.speedIdx + 1);
    $("#metric").onchange = ev => { tl.metric = ev.target.value; S.dirty = true; };
    $("#watchGame").onclick = () => watchInGame(false);
    $("#fightSort").onchange = buildFightList;
    bindOptionMenus();
    bindCompass();
    for (const b of document.querySelectorAll(".tabs button")) b.onclick = () => switchTab(b.dataset.tab);
    window.addEventListener("keydown", ev => {
      if (ev.key !== "Escape" && ev.target.closest("button, input, select, textarea, [contenteditable]")) return;
      const step = ev.shiftKey ? 30 : 5;
      switch (ev.key) {
        case " ": togglePlay(); break;
        case "ArrowLeft": S.seek(S.t - step); break;
        case "ArrowRight": S.seek(S.t + step); break;
        case "+": case "=": setSpeed(S.speedIdx + 1); break;
        case "-": case "_": setSpeed(S.speedIdx - 1); break;
        case "[": jumpFight(-1); break;
        case "]": jumpFight(1); break;
        case "n": case "N": stepMoment(1); break;
        case "p": case "P": stepMoment(-1); break;
        case "f": case "F": if (S.selected) { S.follow = !S.follow; S.dirty = true; renderUnit(true); } break;
        case "k": case "K": showKey($("#legend").hidden); break;
        case "h": case "H": $("#optCaster").click(); break;
        case "Escape": S.select(null); S.fight = null; renderFightDetail(); highlightFightList(); closeCaption(); break;
        default: return;
      }
      ev.preventDefault();
    });
  }

  // Compass: its needle and N point to the map's north. Dragging it turns the map with the needle, snapping to the
  // nearest 45° within 4°; activating it (click, Enter, Space) turns the map back to the in-game view (map.js
  // DEFAULT_TURN). Focused from the keyboard, ←/→ turn it 15° (Shift 45°) instead of seeking.
  function bindCompass() {
    const el = $("#compass"), rose = $("#compassRose"), label = $("#compassN"), snapTo = Math.PI / 4, snapIn = 4 * Math.PI / 180;
    const show = () => {
      const deg = -map.turn * 180 / Math.PI; // the needle's bearing, clockwise from up
      rose.setAttribute("transform", `rotate(${deg})`);
      label.setAttribute("transform", `rotate(${deg}) translate(0 -16) rotate(${-deg})`);
    };
    const bearing = ev => {
      const r = el.getBoundingClientRect();
      return Math.atan2(ev.clientX - r.left - r.width / 2, r.top + r.height / 2 - ev.clientY);
    };
    let drag = null, skipClick = false; // skipClick: the click that ends a drag is not a reset
    el.addEventListener("mousedown", ev => ev.preventDefault()); // a mouse click must not focus it: Space stays play
    el.addEventListener("keydown", ev => {
      if (ev.key === "Enter" || ev.key === " ") { skipClick = false; ev.stopPropagation(); return; } // not play/pause
      const step = (ev.shiftKey ? 45 : 15) * Math.PI / 180;
      if (ev.key === "ArrowLeft") map.setTurn(map.turn + step);
      else if (ev.key === "ArrowRight") map.setTurn(map.turn - step);
      else return;
      ev.preventDefault();
      ev.stopPropagation();
      show();
    });
    el.addEventListener("click", () => {
      if (skipClick) { skipClick = false; return; }
      map.resetTurn();
      show();
    });
    el.addEventListener("pointerdown", ev => {
      if (drag) return; // a second finger does not take over the drag
      skipClick = false;
      el.setPointerCapture(ev.pointerId);
      drag = { id: ev.pointerId, b: bearing(ev), turn: map.turn, x: ev.clientX, y: ev.clientY, moved: false };
    });
    el.addEventListener("pointermove", ev => {
      if (!drag || ev.pointerId !== drag.id) return;
      if (Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y) > 3) drag.moved = true;
      if (!drag.moved) return;
      let a = drag.turn - (bearing(ev) - drag.b);
      const snap = Math.round(a / snapTo) * snapTo;
      if (Math.abs(a - snap) < snapIn) a = snap;
      map.setTurn(a);
      show();
    });
    el.addEventListener("pointerup", ev => {
      if (!drag || ev.pointerId !== drag.id) return;
      skipClick = drag.moved;
      drag = null;
    });
    el.addEventListener("pointercancel", ev => { // no click follows a cancel, so nothing to skip
      if (drag && ev.pointerId === drag.id) drag = null;
    });
    show();
  }

  function togglePlay() {
    if (S.t >= M.duration) S.t = M.d.recordStart;
    S.playing = !S.playing;
  }

  function setSpeed(i) {
    S.speedIdx = Math.max(0, Math.min(SPEEDS.length - 1, i));
  }

  function jumpFight(dir) {
    const fs = M.fights;
    if (!fs.length) return;
    let f;
    if (dir > 0) f = fs.find(x => x.start > S.t + 1) || fs[fs.length - 1];
    else f = [...fs].reverse().find(x => x.start < S.t - 6) || fs[0];
    S.focusFight(f);
  }

  function switchTab(name) {
    for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("active", b.dataset.tab === name);
    for (const s of document.querySelectorAll("#side section")) s.hidden = s.id !== "tab-" + name;
    if (name === "players") renderPlayers();
    else if (name === "eco") renderEco(true);
    else if (name === "unit") renderUnit(true);
  }

  // ---------- watch in the game ----------
  // tools/recorder_app.py serves this viewer at APP_URL/viewer/ and opens the game there (POST /api/watch, progress
  // from GET /api/watch). Opened any other way (as a file, another server), the button reopens the replay there.
  const APP_URL = "http://127.0.0.1:47811";
  let watchTimer = 0;

  async function watchInGame(force) {
    const inApp = location.protocol.startsWith("http") && await fetch("/api/watch", { cache: "no-store" })
      .then(r => r.ok && (r.headers.get("Content-Type") || "").startsWith("application/json"), () => false);
    if (!inApp) {
      if (location.origin === APP_URL) { // served by a Replay Recorder started before it had /api/watch
        showNotice("Close the Replay Recorder window and start “Replay Recorder.bat” again, then press “Watch in game”.");
        return;
      }
      const appUp = await fetch(APP_URL + "/api/state", { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(3000) })
        .then(() => true, () => false);
      if (appUp) location.href = `${APP_URL}/viewer/index.html#${encodeURIComponent(M.d.name)}/t${Math.floor(S.t)}`;
      else showNotice("To watch in the game, start Replay Recorder first (double-click “Replay Recorder.bat”), then press “Watch in game” again.");
      return;
    }
    const body = { name: M.d.name, t: S.t, x: map.camX, z: map.camZ, players: M.d.players.map(p => p.name), force };
    let r;
    try {
      r = await (await fetch("/api/watch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
    } catch {
      showNotice("Replay Recorder is not running any more. Start it again (Replay Recorder.bat).");
      return;
    }
    if (r.confirm) { if (window.confirm(r.confirm)) watchInGame(true); return; }
    if (r.error) { showNotice(r.error); return; }
    pollWatch();
  }

  // Shows the game's progress (r.text) until it is ready or failed; that message stays 15 s.
  function pollWatch() {
    clearTimeout(watchTimer);
    fetch("/api/watch", { cache: "no-store" }).then(r => r.json()).then(w => {
      const running = w.state === "running";
      $("#watchGame").disabled = running;
      showNotice(w.text || "");
      watchTimer = running ? setTimeout(pollWatch, 1000)
        : setTimeout(() => { if ($("#notice").textContent === w.text) showNotice(""); }, 15000);
    }, () => {
      $("#watchGame").disabled = false;
      showNotice("Replay Recorder stopped while opening the game.");
    });
  }

  // ---------- key moments (optional notes/<name>.js) ----------
  let notesData = null, momentIdx = -1;

  function buildMoments(notes) {
    notesData = notes;
    $(".tabs button[data-tab=moments]").hidden = false;
    $("#momentsTitle").textContent = notes.title || "Key moments";
    const list = $("#momentList");
    notes.moments.forEach((m, i) => {
      list.append(h("div", { class: "moment", "data-i": i, onclick: () => showMoment(i) },
        h("div", { class: "row1" }, h("span", {}, h("b", {}, `${i + 1}. `), m.title), h("span", { class: "muted" }, RV.fmtTime(m.t)))));
    });
    list.append(h("p", { class: "muted" }, "Data = measured from the recording. My read = interpretation (game knowledge + comparison with the other players)."));
    switchTab("moments");
  }

  function visionMask(v) {
    const [kind, n] = (v || "all").split(":");
    if (kind === "team" && M.teamMask.has(+n)) return M.teamMask.get(+n);
    if (kind === "player" && M.playerByIdx.has(+n)) return 1 << (+n - 1);
    return M.allMask;
  }

  function showMoment(i) {
    const ms = notesData.moments;
    momentIdx = Math.max(0, Math.min(ms.length - 1, i));
    const m = ms[momentIdx];
    S.viewMask = visionMask(m.vision);
    $("#view").value = String(S.viewMask);
    const f = m.fight != null ? M.fights.find(x => x.id === m.fight) : null;
    S.fight = f || null;
    S.selected = null;
    S.follow = false;
    S.seek(m.t);
    if (m.x != null) map.focus(m.x, m.z, m.r || 40);
    else if (f) map.focus(f.x, f.z, f.radius);
    S.speedIdx = Math.max(0, SPEEDS.indexOf(m.speed || 1));
    S.playing = true;
    renderFightDetail();
    highlightFightList();
    if (m.tab) switchTab(m.tab); // e.g. "fights" shows the inspector, "players" the tech table
    for (const n of document.querySelectorAll(".moment")) n.classList.toggle("sel", +n.dataset.i === momentIdx);
    renderCaption();
    map.pan(($("#caption").offsetWidth + 20) / 2, 0); // centre the action right of the caption
    history.replaceState(null, "", `#${encodeURIComponent($("#replay").value)}/${momentIdx + 1}`); // no hashchange, no reload
  }

  function renderCaption() {
    const box = $("#caption");
    box.textContent = "";
    if (momentIdx < 0) { box.hidden = true; return; }
    const ms = notesData.moments, m = ms[momentIdx];
    box.append(
      h("div", { class: "capHead" },
        h("b", {}, `${momentIdx + 1}/${ms.length} · ${m.title}`),
        h("button", { class: "x", title: "Close (Esc)", onclick: closeCaption }, "×")),
      h("p", {}, h("span", { class: "tag" }, "Data"), m.data),
      m.read ? h("p", {}, h("span", { class: "tag read" }, "My read"), m.read) : null,
      h("div", { class: "actions" },
        h("button", { onclick: () => showMoment(momentIdx - 1), disabled: momentIdx === 0 }, "Prev (P)"),
        h("button", { onclick: () => showMoment(momentIdx) }, "Replay"),
        h("button", { onclick: () => showMoment(momentIdx + 1), disabled: momentIdx === ms.length - 1 }, "Next (N)")));
    box.hidden = false;
  }

  function closeCaption() {
    momentIdx = -1;
    renderCaption();
    for (const n of document.querySelectorAll(".moment")) n.classList.remove("sel");
    history.replaceState(null, "", `#${encodeURIComponent($("#replay").value)}`);
  }

  function stepMoment(dir) {
    if (notesData) showMoment(momentIdx < 0 ? 0 : momentIdx + dir);
  }

  // ---------- fights ----------
  const MOVE_IN = 15; // world units of average approach in the 30 s before a fight that count as "moved in"
  function teamLosses(f) {
    const out = new Map(M.teams.map(tm => [tm, { value: 0, deaths: 0, damage: 0 }]));
    for (const [idx, l] of Object.entries(f.losses)) {
      const p = M.playerByIdx.get(+idx);
      if (!p) continue;
      const o = out.get(p.team);
      o.value += l.value; o.deaths += l.deaths; o.damage += l.damage;
    }
    return out;
  }

  function tradeBar(f) {
    const tl = teamLosses(f);
    const total = [...tl.values()].reduce((a, v) => a + v.value, 0) || 1;
    return h("div", { class: "trade", title: "Resource value lost per team" },
      ...M.teams.map(tm => {
        const p = M.players.find(pp => pp.team === tm);
        return h("div", { style: { width: (100 * tl.get(tm).value / total) + "%", background: p ? p.color : "#888" } });
      }));
  }

  function buildFightList() {
    const list = $("#fightList");
    list.textContent = "";
    const fights = [...M.fights];
    if ($("#fightSort").value === "value") {
      const v = f => Object.values(f.losses).reduce((a, l) => a + l.value + l.damage * 0.01, 0);
      fights.sort((a, b) => v(b) - v(a));
    }
    $("#fightCount").textContent = `${M.fights.length} fights detected`;
    for (const f of fights) {
      const tlv = teamLosses(f);
      const item = h("div", { class: "fight", "data-id": f.id, onclick: () => S.focusFight(f) },
        h("div", { class: "row1" },
          h("span", {}, h("b", {}, `#${f.id} `), `${RV.fmtTime(f.start)} – ${RV.fmtTime(f.end)}`),
          h("span", { class: "muted" }, `${f.deaths} dead · ${fmtK([...tlv.values()].reduce((a, v) => a + v.damage, 0))} dmg · ${Math.round(f.end - f.start)}s`)),
        h("div", { class: "sideLine" }, ...M.teams.map(tm =>
          h("span", { "data-team": tm }, `T${tm + 1} lost ${tlv.get(tm).deaths} (${fmtK(tlv.get(tm).value)} res) `))),
        tradeBar(f));
      list.append(item);
    }
    fillRatings();
    highlightFightList();
  }

  function highlightFightList() {
    for (const n of document.querySelectorAll(".fight")) n.classList.toggle("sel", S.fight && +n.dataset.id === S.fight.id);
  }

  // Per owner, how many of each unit name in `ids` were alive at t; `types` collects each name's unit type (icons).
  function composition(ids, t, types) {
    const by = new Map(); // owner -> Map(name -> count)
    for (const id of ids) {
      const e = M.byId.get(id);
      if (!e || !RV.isUnit(e.cat) || e.cat === "livestock" || !RV.alive(e, t)) continue;
      const owner = RV.ownerAt(e, t);
      if (!by.has(owner)) by.set(owner, new Map());
      const m = by.get(owner);
      const name = RV.nameAt(e, t);
      m.set(name, (m.get(name) || 0) + 1);
      if (e.type) types.set(name, e.type);
    }
    return by;
  }

  function renderFightDetail() {
    const box = $("#fightDetail");
    box.textContent = "";
    const f = S.fight;
    if (!f) return;
    const types = new Map();
    const before = composition(f.units, f.start - 1, types);
    const after = composition(f.units, f.end + 1, types);
    const tlv = teamLosses(f);
    const card = h("div", { class: "card" },
      h("h3", {}, `Fight #${f.id} · ${RV.fmtTime(f.start)} – ${RV.fmtTime(f.end)} (${Math.round(f.end - f.start)}s)`),
      h("div", { class: "actions" },
        h("button", { onclick: () => S.focusFight(f) }, "Replay from start"),
        h("button", { onclick: () => jumpFight(-1) }, "Prev"),
        h("button", { onclick: () => jumpFight(1) }, "Next")),
      tradeBar(f));
    for (const tm of M.teams) {
      const players = M.players.filter(p => p.team === tm);
      const team = h("div", { class: "team" },
        h("div", { class: "tname" }, `Team ${tm + 1}: lost ${tlv.get(tm).deaths} units, ${fmtK(tlv.get(tm).value)} res, ${fmtK(tlv.get(tm).damage)} dmg taken`));
      for (const p of players) {
        const b = before.get(p.idx) || new Map(), a = after.get(p.idx) || new Map();
        const names = [...new Set([...b.keys(), ...a.keys()])].sort((x, y) => (b.get(y) || 0) - (b.get(x) || 0));
        const key = String(p.idx), loss = f.losses[key];
        if (!names.length && !loss) continue;
        const rows = names.map(n => {
          const nb = b.get(n) || 0, na = a.get(n) || 0;
          const icon = types.get(n) && h("img", { src: RV.unitIcon(types.get(n), p.color, ICON_PX) });
          return h("tr", {}, h("td", {}, icon, n), h("td", {}, nb), h("td", {}, na), h("td", { class: nb > na ? "lost" : "" }, nb > na ? `-${nb - na}` : ""));
        });
        const facts = [];
        const mv = (f.moved || {})[key], eng = (f.engaged || {})[key];
        if (mv) facts.push(mv[1] >= MOVE_IN ? `moved in (${Math.round(mv[1])} closer over the 30 s before)` : mv[1] <= -MOVE_IN ? "pulled back before it" : "held position");
        if (eng) facts.push(`${fmtK(eng)} army engaged`);
        if (loss) facts.push(`lost ${loss.deaths} · ${fmtK(loss.value)} res` +
          (loss.army != null && (loss.vill || loss.bldg) ? ` (army ${fmtK(loss.army)}, villagers ${fmtK(loss.vill)}, buildings ${fmtK(loss.bldg)})` : ""));
        team.append(h("div", { style: { marginTop: "4px" } }, h("span", { class: "chip" }, h("i", { style: { background: p.color } }), p.name)),
          facts.length ? h("div", { class: "muted pfacts" }, facts.join(" · ")) : null,
          rows.length ? h("table", { class: "comp" }, h("tr", {}, h("th", {}, "Unit"), h("th", {}, "Before"), h("th", {}, "After"), h("th", {}, "")), rows) : null);
      }
      card.append(team);
    }
    const vals = M.teams.map(tm => ({ tm, v: tlv.get(tm).value }));
    if (vals.length === 2 && (vals[0].v || vals[1].v)) {
      const [x, y] = vals;
      const winner = x.v < y.v ? x : y, loser = winner === x ? y : x;
      const engaged = tm => M.players.filter(p => p.team === tm).reduce((s, p) => s + ((f.engaged || {})[String(p.idx)] || 0), 0);
      const ex = engaged(x.tm), ey = engaged(y.tm);
      card.append(h("div", { class: "verdict" },
        winner.v === loser.v ? "Even trade" : `Team ${winner.tm + 1} won the trade by ${fmtK(loser.v - winner.v)} resources`,
        ex && ey ? h("div", { class: "muted" }, `Army engaged: Team ${x.tm + 1} ${fmtK(ex)} vs Team ${y.tm + 1} ${fmtK(ey)} (${(ex / ey).toFixed(2)}x)`) : null));
    }
    box.append(card);
    const A = fightAnalysis(f);
    fightPanel = A && RV_FIGHTPANEL.render(A, {
      t: S.t, seek: t => S.seek(t), heat: S.showHeat,
      onHeat: v => { S.showHeat = v; $("#optHeat").checked = v; S.dirty = true; },
    });
    if (fightPanel) box.append(h("div", { class: "card" }, h("h3", {}, "Engagement analysis"), fightPanel));
  }

  // RV_FIGHTS analysis of a model fight (cached by fights.js per fight); the list's Micro Rating badges are filled a few
  // fights per tick after the list is built, so the first paint does not wait for all of them.
  let fightPanel = null, ratingJob = 0;
  const fightAnalysis = f => {
    const i = M.d.fights.findIndex(x => x.id === f.id);
    return i < 0 ? null : RV_FIGHTS.analyze(M.d, M.combat, i);
  };
  function fillRatings() {
    const job = ++ratingJob, items = [...document.querySelectorAll("#fightList .fight")];
    const step = () => {
      if (job !== ratingJob) return;
      for (const item of items.splice(0, 4)) {
        const A = fightAnalysis(M.fights.find(f => f.id === +item.dataset.id));
        if (!A) continue;
        for (const span of item.querySelectorAll(".sideLine [data-team]")) span.append(RV_FIGHTPANEL.badge(A.rating[+span.dataset.team]));
      }
      if (items.length) setTimeout(step, 0);
    };
    setTimeout(step, 0);
  }

  // ---------- players / kills ----------
  function renderPlayers() {
    const box = $("#playerStats");
    const step = M.army.step, i = Math.floor(S.t / step);
    const rows = M.players.map(p => {
      const st = RV.statsAt(M, p.idx, S.t);
      const a = M.army.players[String(p.idx)] || {};
      const k = Math.min(i, (a.military || []).length - 1);
      return h("tr", {},
        h("td", { class: "pname", title: p.name }, h("i", { class: "dot", style: { background: p.color } }), " ", p.name),
        h("td", {}, st ? st[1] : "-"), h("td", {}, st ? st[2] : "-"), h("td", {}, st ? st[3] : "-"), h("td", {}, st ? st[4] : "-"),
        h("td", {}, st ? st[5] : "-"), h("td", {}, a.villagers ? a.villagers[k] : "-"), h("td", {}, a.military ? a.military[k] : "-"),
        h("td", {}, a.armyValue ? fmtK(a.armyValue[k]) : "-"));
    });
    box.textContent = "";
    box.append(h("table", {},
      h("tr", {}, ...["Player", "Food", "Wood", "Gold", "Stone", "Pop", "Vils", "Army", "Value"].map(x => h("th", {}, x))),
      rows));
    box.append(h("p", { class: "muted" }, "Resources are banked (unspent) amounts; Army counts living military units."));
    const sm = M.d.summary && M.d.summary.players;
    if (sm) {
      const num = v => (v == null ? "-" : MANY() ? fmtK(v) : v.toLocaleString());
      const row = (label, f) => ({ label, cells: M.players.map(p => ({ v: sm[String(p.idx)] ? f(sm[String(p.idx)]) : "-" })) });
      box.append(h("h4", {}, "Match result"),
        playerGrid([
          row("Result", r => h("span", { class: "res " + r.result }, r.result || "-")),
          row("APM", r => num(r.apm)),
          row("Score", r => num(r.scores && r.scores.total)),
          row("Military", r => num(r.scores && r.scores.military)),
          row("Economy", r => num(r.scores && r.scores.economy)),
          row("Technology", r => num(r.scores && r.scores.technology)),
          row("Society", r => num(r.scores && r.scores.society)),
          row("Gathered", r => num(r.gathered && r.gathered.total)),
          row("Spent", r => num(r.spent && r.spent.total))]),
        h("p", { class: "muted" }, "From the aoe4world match summary (final figures, not time-dependent)."));
    }
    if (M.techs.length) box.append(techTable());

    const feed = $("#killFeed");
    feed.textContent = "";
    const hi = RV.idxAt(M.killT, S.t);
    let shown = 0;
    for (let j = hi; j >= 0 && shown < 25; j--) {
      const k = M.kills[j], v = M.byId.get(k.victim);
      if (!v || v.cat === "livestock" || v.cat === "attachment") continue;
      const kl = k.killer != null ? M.byId.get(k.killer) : null;
      const vp = M.playerByIdx.get(v.owner), kp = kl ? M.playerByIdx.get(kl.owner) : null;
      feed.append(h("div", { class: "kill", style: { cursor: "pointer" }, onclick: () => { S.seek(k.t - 3); map.focus(...posAt(v, k.t), 30); } },
        h("span", { class: "t" }, RV.fmtTime(k.t)),
        kl ? h("span", { style: { color: kp ? kp.color : "#aaa" } }, RV.nameAt(kl, k.t)) : h("span", { class: "muted" }, "?"),
        " killed ",
        h("span", { style: { color: vp ? vp.color : "#aaa" } }, RV.nameAt(v, k.t))));
      shown++;
    }
  }

  // Eco tab: the shared opportunity-cost panel (ecopanel.js over eco.js), rebuilt once per second of replay time.
  let ecoKey = null;
  function renderEco(force) {
    const key = Math.floor(S.t);
    if (!force && key === ecoKey) return;
    ecoKey = key;
    const box = $("#ecoPanel");
    box.textContent = "";
    box.append(RV_ECOPANEL.render(RV_ECO.analyze(M.d, M.combat), {
      d: M.d, C: M.combat, t: S.t, seek: t => S.seek(t),
      color: idx => (M.players.find(p => p.idx === idx) || {}).color || "#888",
    }));
  }

  // More than 4 players (3v3, 4v4) don't fit a label column beside theirs: each row's label goes on its own line.
  const MANY = () => M.players.length > 4;

  /**
   * A players table, one column per player with a rule between teams. rows: [{ label, cls, cells: [{ v, cls, title }] }]
   * (v text or a node).
   */
  function playerGrid(rows, cls = "") {
    const many = MANY(), sep = M.players.map((p, j) => (j > 0 && p.team !== M.players[j - 1].team ? " tsep" : ""));
    const head = M.players.map((p, j) => h("th", { class: sep[j], title: p.name }, h("i", { class: "dot", style: { background: p.color } }), many ? "" : " " + p.name.slice(0, 6)));
    const cells = r => r.cells.map((c, j) => h("td", { class: (c.cls || "") + sep[j], title: `${M.players[j].name} · ${r.label}${c.title ? ": " + c.title : ""}` }, c.v));
    if (!many) return h("table", { class: cls }, h("tr", {}, h("th", {}, ""), ...head), ...rows.map(r => h("tr", { class: r.cls || "" }, h("td", {}, r.label), ...cells(r))));
    const trs = [];
    for (const r of rows) trs.push(h("tr", { class: "lbl " + (r.cls || "") }, h("td", { colspan: M.players.length }, r.label)), h("tr", {}, ...cells(r)));
    return h("table", { class: cls + " many" }, h("tr", {}, ...head), ...trs);
  }

  // Age-ups and eco techs: one row per tech, one column per player; earliest time highlighted, future times dimmed.
  function techTable() {
    const rows = new Map();
    for (const [t, idx, label, kind] of M.techs) {
      if (!rows.has(label)) rows.set(label, { kind, at: new Map() });
      const r = rows.get(label);
      if (!r.at.has(idx)) r.at.set(idx, t);
    }
    const grid = [...rows].map(([label, r]) => {
      const best = Math.min(...r.at.values());
      return { label, cls: r.kind === "age" ? "age" : "", cells: M.players.map(p => {
        const t = r.at.get(p.idx);
        return { v: t == null ? "–" : RV.fmtTime(t), cls: t == null ? "muted" : t > S.t ? "future" : t === best ? "best" : "", title: t == null ? "not researched" : RV.fmtTime(t) };
      }) };
    });
    return h("div", {}, h("h4", {}, "Age-ups and eco upgrades"), playerGrid(grid, "techs"),
      h("p", { class: "muted" }, "Green = first player to get it. Dimmed = not researched yet at the current time."));
  }

  function posAt(e, t) {
    const j = Math.max(0, RV.idxAt(e.t, t));
    return [e.x[j], e.z[j]];
  }

  // ---------- selection ----------
  let unitKey = "";
  function renderUnit(force) {
    if (S.group) return renderGroup(force);
    const e = S.selected, box = $("#unitCard");
    const key = e ? `${e.id}|${e.on}|${Math.round(e.php)}|${e.pname}|${S.follow}|${Math.floor(S.t)}` : "";
    if (!force && key === unitKey) return;
    unitKey = key;
    box.textContent = "";
    if (!e) {
      box.append(h("p", { class: "muted" }, "Click a unit or building on the map, or drag a box around units to select them. Shift+click adds or drops one, Alt+click drops its type."));
      return;
    }
    const p = M.playerByIdx.get(e.pown);
    const killer = e.killer != null ? M.byId.get(e.killer) : null;
    const tAt = Math.min(S.t, e.died ?? S.t);
    const cd = RV_FRAME.cardData(M.combat, e, tAt);
    const kp = killer && M.playerByIdx.get(RV.ownerAt(killer, e.died));
    const death = e.died == null || S.t < e.died ? null
      : e.defeated ? `Lost when ${p ? p.name : "its owner"} was defeated at ${RV.fmtTime(e.died)}`
      : killer ? `Slain by ${kp ? `${kp.name}'s ` : ""}${RV.nameAt(killer, e.died)} at ${RV.fmtTime(e.died)}`
      : `Died at ${RV.fmtTime(e.died)}`;
    box.append(h("div", { class: "card rvc-unit-card" },
      RV_CARD.explorer(M.combat, e, tAt, cd, p, iconOf(e, p ? p.color : "#9ca3af", 56), death),
      h("div", { class: "actions" },
        h("button", { onclick: () => { S.follow = !S.follow; S.dirty = true; renderUnit(true); } }, S.follow ? "Stop following" : "Follow (F)"),
        h("button", { onclick: () => S.seek(e.born) }, "Go to creation"),
        e.died != null ? h("button", { onclick: () => S.seek(e.died - 5) }, "Go to death") : null),
      RV_CARD.debug([["ID", e.id], ["Blueprint", e.bp], ["Category", e.cat], ["Squad", e.squad || "-"],
        ["Lifetime", `${RV.fmtTime(e.born)} – ${e.died != null ? RV.fmtTime(e.died) : "end"}`], ["Value", e.value || "-"]], cd && cd.tel)));
    const dbg = box.querySelector(".rvc-debug");
    dbg.open = debugOpen;
    dbg.addEventListener("toggle", () => { debugOpen = dbg.open; });
  }
  let debugOpen = false;

  // The map's art for a unit, building or claimed sheep as an <img> px wide (null for anything without art).
  function iconOf(e, color, px) {
    const src = e.cat === "building" ? RV.buildingIcon(e.bkind, color, px)
      : e.cat === "livestock" ? RV.gaiaIcon("sheep", px) : e.type ? RV.unitIcon(e.type, color, px) : null;
    return src && h("img", { src, width: px, height: px });
  }

  // A drag-box highlight: how many are on the map now and, per owner, what they are (by name with the map icon),
  // their health and cost. Members that died since, or don't exist yet at this time, are counted apart.
  function renderGroup(force) {
    const box = $("#unitCard"), byOwner = new Map();
    let on = 0, lost = 0, later = 0;
    for (const e of S.group) {
      if (!e.on) { if (S.t < e.born) later++; else lost++; continue; }
      on++;
      let o = byOwner.get(e.pown);
      if (!o) byOwner.set(e.pown, o = { hp: 0, maxhp: 0, value: 0, army: 0, vil: 0, bld: 0, other: 0, names: new Map() });
      o.hp += e.php; o.maxhp += e.maxhp; o.value += e.value || 0;
      if (e.cat === "building") o.bld++;
      else if (e.type === "villager") o.vil++;
      else if (e.type && RV.isMilitary(e.cat)) o.army++;
      else o.other++;
      const c = o.names.get(e.bp);
      if (c) { c.n++; c.hp += e.php; c.maxhp += e.maxhp; } else o.names.set(e.bp, { n: 1, e, hp: e.php, maxhp: e.maxhp });
    }
    const key = `g|${on}|${lost}|${later}|` + [...byOwner].map(([p, o]) =>
      `${p}:${Math.round(o.hp)}:` + [...o.names].map(([n, c]) => n + c.n + ":" + Math.round(c.hp)).join(",")).join("|");
    if (!force && key === unitKey) return;
    unitKey = key;
    box.textContent = "";
    const gone = [lost && `${lost} dead or gone`, later && `${later} not made yet`].filter(Boolean).join(" · ");
    const card = h("div", { class: "card" }, h("h3", {}, `${on} selected`), gone ? h("div", { class: "muted" }, gone) : null);
    for (const p of M.players) {
      const o = byOwner.get(p.idx);
      if (!o) continue;
      const what = [o.army && `${o.army} army`, o.vil && `${o.vil} villagers`, o.bld && `${o.bld} buildings`, o.other && `${o.other} other`];
      if (o.maxhp) what.push(`${Math.round(o.hp / o.maxhp * 100)}% health`);
      if (o.value) what.push(`${fmtK(o.value)} res`);
      card.append(h("div", { class: "cp" }, h("i", { style: { background: p.color } }), h("b", {}, p.name),
        h("span", { class: "muted" }, what.filter(Boolean).join(" · "))));
      const groups = [...o.names].sort((a, b) => b[1].n - a[1].n || a[1].e.pname.localeCompare(b[1].e.pname))
        .map(([bp, c]) => ({ key: bp, label: c.e.pname, n: c.n, hp: c.hp, maxhp: c.maxhp, icon: iconOf(c.e, p.color, ICON_PX) }));
      card.append(RV_CARD.tray(groups, S.dropOne, S.dropBp));
    }
    card.append(RV_CARD.trayHint());
    card.append(h("div", { class: "actions" }, h("button", { onclick: () => S.select(null) }, "Clear (Esc)")));
    box.append(card);
  }

  // ---------- army on screen ----------
  // Per player, the units inside the current view (map.tallyOnScreen, already filtered by Vision), grouped by unit
  // name with the map icon. Rebuilt only when the counts change.
  let compKey = null;
  function renderComp() {
    const box = $("#comp");
    const rows = [];
    if (S.showComp && map.onScreen) {
      for (const p of M.players) {
        const m = map.onScreen.get(p.idx);
        if (m) rows.push([p, [...m].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))]);
      }
    }
    const key = rows.map(([p, items]) => p.idx + ":" + items.map(([name, c]) => name + c.n).join(",")).join("|");
    if (key === compKey) return;
    compKey = key;
    const scroll = box.scrollTop; // rebuilding empties the box, which would reset a scrolled panel to the top
    box.textContent = "";
    box.hidden = !rows.length;
    if (!rows.length) return;
    box.append(h("div", { class: "ch" }, "On screen"));
    for (const [p, items] of rows) {
      let army = 0, value = 0, vil = 0;
      for (const [, c] of items) if (c.type === "villager") vil += c.n; else { army += c.n; value += c.value; }
      box.append(h("div", { class: "cp" }, h("i", { style: { background: p.color } }), h("b", {}, p.name),
        h("span", { class: "muted" }, `${army} army` + (value ? ` · ${fmtK(value)}` : "") + (vil ? ` · ${vil} villagers` : ""))));
      const grid = h("div", { class: "cg" });
      for (const [name, c] of items) {
        if (c.type === "villager") continue;
        grid.append(h("span", { title: `${name} (${RV.UNIT_TYPES[c.type].label})` },
          h("img", { src: RV.unitIcon(c.type, p.color, ICON_PX) }), h("b", {}, c.n), name));
      }
      if (grid.childElementCount) box.append(grid);
    }
    box.scrollTop = scroll;
  }

  // ---------- tooltip ----------
  function renderTooltip() {
    const tip = $("#tooltip"), e = S.hover;
    if (!e || !e.on || !S.mouse) { tip.hidden = true; return; }
    tip.hidden = false;
    tip.textContent = "";
    if (e.gaia) {
      const chopped = (e.kind === "tree" || e.kind === "stealth") && e.amount < e.amount0;
      const st = RV.GAIA_STYLE[chopped ? "chopped" : e.kind], holder = e.holder ? M.playerByIdx.get(e.holder) : null;
      tip.append(h("b", {}, e.name), h("br"), (st ? st.label : e.kind) +
        (e.amount0 > 0 ? ` · ${Math.round(Math.max(0, e.amount)).toLocaleString()} / ${e.amount0.toLocaleString()} left` : ""));
      if (e.kind === "sacred") tip.append(" · ", holder ? h("span", { style: { color: holder.color } }, `held by ${holder.name}`) : "neutral");
    } else {
      const p = M.playerByIdx.get(e.pown), role = (RV.UNIT_TYPES[e.type] || RV.BUILDING_TYPES[e.bkind] || {}).label;
      tip.append(h("b", {}, e.pname), role && role.toLowerCase() !== e.pname.toLowerCase() ? ` (${role})` : "", h("br"),
        h("span", { style: { color: p ? p.color : "#aaa" } }, p ? p.name : "?"),
        ` · ${Math.round(e.php)}/${e.maxhp} HP` + (e.value ? ` · ${e.value} res` : ""));
    }
    const x = Math.min(S.mouse.x + 14, map.w - tip.offsetWidth - 4), y = Math.min(S.mouse.y + 14, map.h - tip.offsetHeight - 4);
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  }

  // ---------- main loop ----------
  let last = performance.now(), lastPanel = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (S.playing) {
      S.t = Math.min(M.duration, S.t + dt * SPEEDS[S.speedIdx]);
      if (S.t >= M.duration) S.playing = false;
      S.dirty = true;
    }
    caster.update(S.t, S.showCaster, now, S.showEcoDebt);
    if (S.dirty) {
      S.dirty = false;
      RV.updateFrame(M, S.t);
      map.draw(S.t);
      tl.draw(S.t);
      renderTooltip();
      renderComp();
      $("#clock").textContent = `${RV.fmtTime(S.t)} / ${RV.fmtTime(M.duration)}`;
      if (S.t < M.d.recordStart) showNotice(`Recording starts at ${RV.fmtTime(M.d.recordStart)}`);
      else if ($("#notice").textContent.startsWith("Recording starts")) showNotice("");
    }
    $("#play").textContent = S.playing ? "Pause" : "Play";
    $("#speed").textContent = SPEEDS[S.speedIdx] + "x";
    if (now - lastPanel > 250) {
      lastPanel = now;
      for (const result of document.querySelectorAll("#players .res")) result.hidden = S.t < M.duration - 1;
      if (!$("#tab-players").hidden) renderPlayers();
      if (!$("#tab-eco").hidden) renderEco(false);
      if (fightPanel && !$("#tab-fights").hidden) fightPanel.setTime(S.t);
      if (!$("#tab-unit").hidden) renderUnit(false);
    }
    requestAnimationFrame(frame);
  }

  boot();
})(window.RV);
