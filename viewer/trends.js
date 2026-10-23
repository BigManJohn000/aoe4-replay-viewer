"use strict";
// Trends page: one player's numbers across every recorded match, from data/trends/games.js (tools/trends.py).
(function () {
  const $ = s => document.querySelector(s);
  const DATA = window.TRENDS;
  const COLOR = { win: "var(--win)", loss: "var(--loss)" };

  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) n.setAttribute(k, v);
    for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : String(kid));
    return n;
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const clock = s => {
    if (s == null) return "–";
    const t = Math.round(s);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
  };
  const num = v => (v == null ? "–" : Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + "k" : String(Math.round(v)));
  const ratio = v => (v == null ? "–" : v.toFixed(2));
  const civName = c => c.replace(/_/g, " ").replace(/\b\w/g, ch => ch.toUpperCase());
  const resultOf = r => (r.result === "win" || r.result === "loss" ? r.result : "unknown");

  const METRICS = [
    { key: "feudal", label: "Reached Feudal Age", fmt: clock },
    { key: "castle", label: "Reached Castle Age", fmt: clock },
    { key: "imperial", label: "Reached Imperial Age", fmt: clock },
    { key: "vil10", label: "Villagers at 10:00", fmt: num },
    { key: "eco10", label: "Economy upgrades by 10:00", fmt: num },
    { key: "army15", label: "Army value at 15:00 (resources)", fmt: num },
    { key: "bank", label: "Unspent resources, average after 5:00", fmt: num },
    { key: "fightAt", label: "First big fight (1,000+ resources lost) at", fmt: clock },
    { key: "bankFight", label: "Unspent resources when the first big fight starts", fmt: num },
    { key: "trade", label: "Fights: resources killed per resource lost", fmt: ratio },
  ];

  function median(values) {
    const v = values.filter(x => x != null).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  // ---------- page ----------
  function boot() {
    if (!DATA || !DATA.rows.length) {
      $("#content").hidden = true;
      $("#empty").hidden = false;
      return;
    }
    for (const r of DATA.rows) r.trade = r.lost > 0 ? r.killed / r.lost : null;
    $("#made").textContent = `Updated ${DATA.made}`;

    const byPlayer = new Map();
    for (const r of DATA.rows) {
      if (!byPlayer.has(r.player)) byPlayer.set(r.player, []);
      byPlayer.get(r.player).push(r);
    }
    const players = [...byPlayer.entries()].map(([key, rows]) => {
      rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      return { key, rows, name: rows[rows.length - 1].name };
    }).sort((a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name));
    const sel = $("#player");
    for (const p of players) sel.append(h("option", { value: p.key }, `${p.name} (${p.rows.length} game${p.rows.length > 1 ? "s" : ""})`));
    const fromHash = decodeURIComponent(location.hash.slice(1));
    if (byPlayer.has(fromHash)) sel.value = fromHash;
    for (const m of METRICS) $("#metric").append(h("option", { value: m.key }, m.label));

    const render = () => {
      history.replaceState(null, "", "#" + encodeURIComponent(sel.value));
      const mode = $("#mode").value;
      const rows = byPlayer.get(sel.value).filter(r => mode === "all" || (mode === "1v1") === (r.mode === "1v1"));
      renderAll(rows);
    };
    sel.addEventListener("change", render);
    $("#mode").addEventListener("change", render);
    $("#metric").addEventListener("change", render);
    render();
  }

  function renderAll(rows) {
    const wins = rows.filter(r => r.result === "win"), losses = rows.filter(r => r.result === "loss");
    const unknown = rows.length - wins.length - losses.length;
    $("#summary").textContent = !rows.length ? "No games of this kind."
      : `${rows.length} game${rows.length > 1 ? "s" : ""}: ${wins.length} won, ${losses.length} lost`
        + (wins.length + losses.length ? ` (${Math.round(100 * wins.length / (wins.length + losses.length))}% won)` : "")
        + (unknown ? `, ${unknown} without a result on aoe4world` : "") + ".";
    $("#content").hidden = !rows.length;
    if (!rows.length) return;
    renderCompare(wins, losses);
    renderByGame(rows, METRICS.find(m => m.key === $("#metric").value));
    renderCurve($("#vilCurve"), wins, losses, "vilCurve", num);
    renderCurve($("#armyCurve"), wins, losses, "armyCurve", num);
    renderGames(rows);
  }

  function renderCompare(wins, losses) {
    const cell = (group, m) => {
      const have = group.filter(r => r[m.key] != null).length;
      return h("td", { class: "num" }, m.fmt(median(group.map(r => r[m.key]))),
        have && have < group.length ? h("span", { class: "count" }, ` · ${have} of ${group.length}`) : null);
    };
    $("#compare").replaceChildren(
      h("tr", null, h("th"), h("th", { class: "num win" }, `Won (${wins.length})`), h("th", { class: "num loss" }, `Lost (${losses.length})`)),
      ...METRICS.map(m => h("tr", null, h("td", null, m.label), cell(wins, m), cell(losses, m))));
  }

  // Dots for one number in every game, oldest first.
  function renderByGame(rows, metric) {
    const W = 1100, H = 240, L = 56, R = 12, T = 12, B = 26;
    const pts = rows.map((r, i) => ({ r, i, v: r[metric.key] })).filter(p => p.v != null);
    if (!pts.length) {
      $("#byGame").innerHTML = `<p class="muted">None of these games has this number.</p>`;
      return;
    }
    let lo = Math.min(...pts.map(p => p.v)), hi = Math.max(...pts.map(p => p.v));
    if (hi === lo) { lo -= Math.max(1, lo * 0.1); hi += Math.max(1, hi * 0.1); }
    const pad = (hi - lo) * 0.08;
    lo = Math.max(0, lo - pad); hi += pad;
    const x = i => L + (rows.length > 1 ? (i / (rows.length - 1)) * (W - L - R) : (W - L - R) / 2);
    const y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    let svg = "";
    for (let k = 0; k <= 4; k++) {
      const v = lo + ((hi - lo) * k) / 4;
      svg += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`
        + `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${esc(metric.fmt(v))}</text>`;
    }
    const mid = median(pts.map(p => p.v));
    svg += `<line class="median" x1="${L}" x2="${W - R}" y1="${y(mid)}" y2="${y(mid)}"/>`;
    svg += `<text x="${L}" y="${H - 6}">${esc(rows[0].date.slice(0, 10))}</text>`
      + `<text x="${W - R}" y="${H - 6}" text-anchor="end">${esc(rows[rows.length - 1].date.slice(0, 10))}</text>`;
    for (const { r, i, v } of pts) {
      const tip = `${r.date.slice(0, 10)} · ${r.map || ""} · ${civName(r.civ)} vs ${r.vs.map(civName).join(", ")} · `
        + `${resultOf(r)}: ${metric.fmt(v)}`;
      svg += `<a href="index.html#${encodeURIComponent(r.stem)}"><circle cx="${x(i)}" cy="${y(v)}" r="5.5" `
        + `fill="${COLOR[r.result] || "var(--unknown)"}"><title>${esc(tip)}</title></circle></a>`;
    }
    $("#byGame").innerHTML = `<svg viewBox="0 0 ${W} ${H}">${svg}</svg>`;
  }

  // Per-minute middle value of a curve (villagers, army value) in the games won and in the games lost.
  function renderCurve(box, wins, losses, key, fmt) {
    const W = 540, H = 220, L = 44, R = 20, T = 10, B = 24;
    const line = group => {
      const out = [];
      for (let m = 0; ; m++) {
        const vals = group.map(r => r[key][m]).filter(v => v != null);
        if (!vals.length || vals.length < Math.min(2, group.length)) break;
        out.push(median(vals));
      }
      return out;
    };
    const lines = [[wins, "win"], [losses, "loss"]].map(([g, res]) => ({ res, pts: line(g) }));
    const minutes = Math.max(1, ...lines.map(l => l.pts.length - 1));
    const hi = Math.max(1, ...lines.flatMap(l => l.pts)) * 1.05;
    const x = m => L + (m / minutes) * (W - L - R);
    const y = v => T + (1 - v / hi) * (H - T - B);
    let svg = "";
    for (let k = 0; k <= 4; k++) {
      const v = (hi * k) / 4;
      svg += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`
        + `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${esc(fmt(v))}</text>`;
    }
    for (let m = 0; m <= minutes; m += 5) svg += `<text x="${x(m)}" y="${H - 6}" text-anchor="middle">${m}:00</text>`;
    for (const { res, pts } of lines) {
      if (pts.length < 2) continue;
      svg += `<polyline fill="none" stroke="${COLOR[res]}" stroke-width="2" points="${pts.map((v, m) => `${x(m)},${y(v)}`).join(" ")}"/>`;
    }
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}">${svg}</svg>`;
  }

  function renderGames(rows) {
    const cols = [ // [heading, cell, cell class]
      ["Date", r => r.date.slice(0, 10)],
      ["Map", r => r.map || ""],
      ["Mode", r => r.mode],
      ["Civilization", r => civName(r.civ)],
      ["Against", r => r.vs.map(civName).join(", "), "wrap"],
      ["Result", r => h("span", { class: resultOf(r) }, r.result || "unknown")],
      ["Rating", r => r.rating ?? "–", "num"],
      ["Length", r => clock(r.duration), "num"],
      ["Feudal", r => clock(r.feudal), "num"],
      ["Castle", r => clock(r.castle), "num"],
      ["Villagers 10:00", r => num(r.vil10), "num"],
      ["Army 15:00", r => num(r.army15), "num"],
      ["Unspent avg", r => num(r.bank), "num"],
      ["Fight trade", r => ratio(r.trade), "num"],
      ["", r => h("a", { href: `index.html#${encodeURIComponent(r.stem)}` }, "Open")],
    ];
    $("#games").replaceChildren(
      h("tr", null, cols.map(([name, , cls]) => h("th", { class: cls }, name))),
      ...rows.slice().reverse().map(r => h("tr", null, cols.map(([, f, cls]) => h("td", { class: cls }, f(r))))));
  }

  boot();
})();
