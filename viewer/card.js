// Unit stat card and selection tray shared by the 2D and 3D viewers (window.RV_CARD). The data comes from
// RV_FRAME.cardData / telemetry; this file only builds DOM, with its own styles (classes rvc-*), so both pages look the
// same. The card is player-facing: cost, core combat stats and match impact; raw facts (ids, blueprints, telemetry)
// only behind C.debug, which the viewers show when their debug setting is on.
(function () {
  "use strict";
  const C = (window.RV_CARD = {});

  const CSS = `
.rvc-hp{position:relative;height:14px;border-radius:3px;background:rgba(127,127,127,.25);overflow:hidden;margin:6px 0}
.rvc-hp>i{position:absolute;left:0;top:0;bottom:0;border-radius:3px}
.rvc-hp>span{position:absolute;inset:0;font-size:11px;line-height:14px;text-align:center;color:#fff;text-shadow:0 0 2px #000}
.rvc-cost{display:flex;flex-wrap:wrap;gap:2px 10px;font-size:12px;margin:2px 0 6px}
.rvc-cost i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px}
.rvc-cost b{font-variant-numeric:tabular-nums}
.rvc-core{display:grid;grid-template-columns:repeat(auto-fit,minmax(58px,1fr));gap:4px;margin:4px 0}
.rvc-core>div{background:rgba(127,127,127,.15);border-radius:4px;padding:3px 5px;font-size:11px;line-height:1.25;white-space:nowrap;cursor:default}
.rvc-core b{display:block;font-size:13px;font-variant-numeric:tabular-nums}
.rvc-core .up{color:#4ade80;font-weight:600}.rvc-core .down{color:#f87171;font-weight:600}
.rvc-h{font-size:11px;text-transform:uppercase;letter-spacing:.05em;opacity:.65;margin:8px 0 2px}
.rvc-tel{display:grid;grid-template-columns:repeat(auto-fit,minmax(70px,1fr));gap:4px;margin:4px 0}
.rvc-tel>div{background:rgba(127,127,127,.15);border-radius:4px;padding:3px 5px;font-size:11px;line-height:1.25}
.rvc-tel b{display:block;font-size:14px;font-variant-numeric:tabular-nums}
.rvc-death{font-size:12px;margin:6px 0 2px;color:#f4a3a3}
.rvc-debug{margin-top:8px;font-size:11px}
.rvc-debug summary{cursor:pointer;opacity:.65}
.rvc-debug table{width:100%;border-collapse:collapse}
.rvc-debug td{padding:1px 4px 1px 0;vertical-align:top;word-break:break-all}
.rvc-debug td:first-child{opacity:.65;white-space:nowrap;word-break:normal}
.rvc-grade{display:inline-block;min-width:18px;text-align:center;border-radius:3px;font-weight:700;color:#111;padding:0 3px}
.rvc-g-S{background:#facc15}.rvc-g-A{background:#4ade80}.rvc-g-B{background:#60a5fa}.rvc-g-C{background:#fb923c}.rvc-g-F{background:#f87171}
.rvc-tray{display:flex;flex-wrap:wrap;gap:3px;margin:4px 0}
.rvc-tray button{position:relative;display:flex;align-items:center;justify-content:center;width:40px;height:40px;padding:0;
  border:1px solid rgba(127,127,127,.4);border-radius:4px;background:rgba(127,127,127,.12);cursor:pointer}
.rvc-tray button:hover{border-color:#f87171;background:rgba(248,113,113,.18)}
.rvc-tray button img{width:32px;height:32px;pointer-events:none}
.rvc-tray button b{position:absolute;right:1px;bottom:0;font-size:11px;color:#fff;text-shadow:0 0 2px #000,0 0 2px #000}
.rvc-tray button>i{position:absolute;left:2px;right:2px;bottom:2px;height:3px;border-radius:2px;background:rgba(0,0,0,.4)}
.rvc-tray button>i>i{display:block;height:100%;border-radius:2px;background:#4ade80}
.rvc-hint{font-size:11px;opacity:.6}`;
  let styled = false;
  function style() {
    if (styled || typeof document === "undefined") return;
    styled = true;
    const s = document.createElement("style");
    s.textContent = CSS;
    document.head.append(s);
  }

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (k === "style") Object.assign(n.style, v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c);
    return n;
  }
  C.el = el;

  const fmt = (v) => (v == null ? "-" : Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 100) / 100));
  const hpColor = (f) => (f > 0.6 ? "#4ade80" : f > 0.3 ? "#facc15" : "#f87171");

  /** HP bar: hp of max (alive false: "dead / gone"). */
  C.hpBar = function (hp, max, alive) {
    style();
    const f = alive && max ? Math.max(0, Math.min(1, hp / max)) : 0;
    return el("div", { class: "rvc-hp" }, el("i", { style: { width: `${f * 100}%`, background: hpColor(f) } }),
      el("span", {}, alive ? `${Math.round(hp)} / ${Math.round(max)}` : "dead / gone"));
  };

  C.grade = (g) => {
    style();
    return g ? el("span", { class: `rvc-grade rvc-g-${g}` }, g) : el("span", { class: "rvc-hint" }, "-");
  };

  const RES = [["f", "Food", "#e0785c"], ["w", "Wood", "#b8895a"], ["g", "Gold", "#e8c547"], ["s", "Stone", "#a3adb5"]];
  /** Resource cost badges from a stats cost ({ f, w, g, s }), e.g. "30 Food  50 Wood"; else total resources; else null. */
  C.cost = function (cost, total) {
    style();
    const parts = cost ? RES.filter(([k]) => cost[k] > 0) : [];
    const sum = parts.length ? parts.reduce((s, [k]) => s + cost[k], 0) : total;
    if (!sum) return null;
    const box = el("div", { class: "rvc-cost", title: `Costs ${sum} resources` });
    if (!parts.length) box.append(el("span", {}, el("b", {}, String(sum)), " resources"));
    for (const [k, label, col] of parts) box.append(el("span", {}, el("i", { style: { background: col } }), el("b", {}, String(cost[k])), ` ${label}`));
    return box;
  };

  /**
   * Core combat stats as one row of tiles: attack, range, speed as "base +upgrades" (green up, red down; lower reload is
   * not shown); armour as current melee / pierce, green or red where upgrades moved it (two "base +d" pairs don't fit a
   * tile). Bonus damage, armour base +d and the upgrades behind the numbers sit in the tiles' tooltips.
   * From RV_FRAME.cardData; null without it.
   */
  C.coreStats = function (cd) {
    style();
    if (!cd) return null;
    const row = (label) => cd.rows.find((r) => r.label === label);
    const delta = (r) => r.cur - r.base;
    const sgn = (r) => (Math.abs(delta(r)) > 1e-6 ? ` ${delta(r) > 0 ? "+" : "−"}${fmt(Math.abs(delta(r)))}` : "");
    const now = (r) => (Math.abs(delta(r)) > 1e-6 ? el("span", { class: delta(r) > 0 ? "up" : "down" }, fmt(r.cur)) : fmt(r.cur));
    const val = (r) => [fmt(r.base), sgn(r) ? el("span", { class: delta(r) > 0 ? "up" : "down" }, sgn(r)) : null];
    const ups = cd.upgrades.length ? `\nUpgrades: ${cd.upgrades.map((u) => `${u.name} (${clock(u.t)}): ${u.text}`).join("; ")}` : "";
    const tile = (icon, label, title, ...v) => el("div", { title: title + ups }, el("b", {}, ...v), `${icon} ${label}`);
    const atk = row("Attack"), mel = row("Melee armour"), pie = row("Pierce armour"), rng = row("Range"), spd = row("Speed");
    const bonus = cd.bonus.length ? `\nBonus: ${cd.bonus.map((b) => `+${fmt(b.v)} vs ${b.vs}${b.up ? " (upgrade)" : ""}`).join(", ")}` : "";
    return el("div", { class: "rvc-core" },
      atk && tile("⚔", "Attack", `Attack: ${fmt(atk.cur)} ${atk.unit} damage per hit${bonus}`, val(atk)),
      tile("🛡", "Armor", `Melee armour ${fmt(mel.base)}${sgn(mel)} / pierce armour ${fmt(pie.base)}${sgn(pie)}`, now(mel), " / ", now(pie)),
      rng && rng.cur >= 1 && tile("➶", "Range", `Range: ${fmt(rng.cur)} tiles`, val(rng)),
      spd && tile("➜", "Speed", `Move speed: ${fmt(spd.cur)} tiles/s`, val(spd)));
  };

  /** Match impact: kills and damage dealt so far (RV_FRAME.telemetry), then how it died (death: text or node). */
  C.impact = function (tel, death) {
    style();
    if (!tel && !death) return null;
    return el("div", {},
      tel && el("div", { class: "rvc-h" }, "Match impact"),
      tel && el("div", { class: "rvc-tel" },
        el("div", {}, el("b", {}, String(tel.kills)), "kills"),
        el("div", {}, el("b", {}, fmt(tel.dealt)), "damage dealt")),
      death && el("div", { class: "rvc-death" }, death));
  };

  /** Debug facts behind a collapsed toggle: rows [label, value] (values plain text), plus the unit's telemetry. */
  C.debug = function (rows, tel) {
    style();
    const all = rows.slice();
    if (tel) {
      all.push(["Damage taken", fmt(tel.taken)], ["DPS uptime", tel.uptime == null ? "-" : `${Math.round(tel.uptime * 100)}%`]);
      all.push(["Target priority", tel.prio == null ? "-" : `${Math.round(tel.prio * 100)}% (${tel.grade || "-"})`]);
    }
    return el("details", { class: "rvc-debug" }, el("summary", {}, "Debug info"),
      el("table", {}, all.map(([k, v]) => el("tr", {}, el("td", {}, k), el("td", {}, String(v))))));
  };

  function clock(t) {
    const s = Math.max(0, Math.floor(t));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  /**
   * Selection tray: one button per group { key, label, n, hp, maxhp, icon (element or null) }. Click (or onOne) drops
   * one unit of the group, right-click or Alt+click drops the whole group (onAll).
   */
  C.tray = function (groups, onOne, onAll) {
    style();
    const box = el("div", { class: "rvc-tray" });
    for (const g of groups) {
      const f = g.maxhp ? Math.max(0, Math.min(1, g.hp / g.maxhp)) : 0;
      box.append(el("button", {
        type: "button", title: `${g.label} ×${g.n}\nClick: deselect one · Right-click / Alt+click: deselect all ${g.label}`,
        onclick: (ev) => (ev.altKey ? onAll(g.key) : onOne(g.key)),
        oncontextmenu: (ev) => { ev.preventDefault(); onAll(g.key); },
      }, g.icon || el("span", { class: "rvc-hint" }, g.label.slice(0, 3)), g.n > 1 ? el("b", {}, String(g.n)) : null,
      el("i", {}, el("i", { style: { width: `${f * 100}%`, background: hpColor(f) } }))));
    }
    return box;
  };
  C.trayHint = () => el("div", { class: "rvc-hint" }, "Click an icon to deselect one · right-click to deselect that type · Shift+click the map toggles a unit · Alt+click drops its type");
})();
