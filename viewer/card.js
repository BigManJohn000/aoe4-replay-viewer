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

  // Explorer presentation is opt-in for the 2D page; the shared 3D card keeps its existing API and layout.
  const explorerInfo = new Map(), explorerIcons = new Map(), healingByCombat = new WeakMap();
  function infoOf(base, building) {
    const key = `${building ? "buildings" : "units"}/${base}`;
    if (!explorerInfo.has(key)) explorerInfo.set(key, (async () => {
      for (const kind of building ? ["buildings", "units"] : ["units", "buildings"]) {
        try {
          // The unified endpoint contains the per-age, per-civilization variations.
          const res = await fetch(`https://data.aoe4world.com/${kind}/unified/${encodeURIComponent(base)}.json`);
          if (res.ok) return await res.json();
        } catch (_) { return null; } // Offline: the local stats and map icon still work.
      }
      return null;
    })());
    return explorerInfo.get(key);
  }
  function portraitOf(st, building) {
    const kind = building ? "buildings" : "units", key = `${kind}/${st.b}/${st.age}`;
    if (!explorerIcons.has(key)) explorerIcons.set(key, new Promise(resolve => {
      const ages = [st.age, 1, 2, 3, 4].filter((a, i, all) => a >= 1 && a <= 4 && all.indexOf(a) === i);
      const img = new Image();
      let i = 0;
      img.onload = () => resolve(img.src);
      img.onerror = () => {
        if (i < ages.length) next();
        else resolve(null); // Keep exhausted failures, as well as in-flight lookups, for this session.
      };
      const next = () => { img.src = `https://data.aoe4world.com/images/${kind}/${encodeURIComponent(st.b)}-${ages[i++]}.png`; };
      if (ages.length) next();
      else resolve(null);
    }));
    return explorerIcons.get(key);
  }
  function officialIcon(st, building, fallback) {
    if (!st || !st.b) return fallback;
    // Local map art is usable immediately, including while a shared lookup is still pending or has failed.
    const placeholder = fallback || el("span", { class: "rvc-official-icon" });
    portraitOf(st, building).then(src => {
      if (src) placeholder.replaceWith(el("img", { class: "rvc-official-icon", src, alt: st.n || "", width: 56, height: 56 }));
    });
    return placeholder;
  }
  function healedAt(combat, e, t) {
    let byTarget = healingByCombat.get(combat);
    if (!byTarget) {
      byTarget = new Map();
      for (const heal of combat.heals || []) {
        const id = typeof heal.target === "object" ? heal.target.id : heal.target;
        let list = byTarget.get(id);
        if (!list) byTarget.set(id, list = []);
        list.push({ heal, times: null, totals: null });
      }
      healingByCombat.set(combat, byTarget);
    }
    let total = 0;
    for (const entry of byTarget.get(e.id) || []) {
      const heal = entry.heal;
      if (heal.t0 > t) continue;
      if (!entry.times) {
        entry.times = []; entry.totals = [];
        let amount = 0;
        // Merged sessions retain no per-tick amounts; recover the recorded rises, not an average heal rate.
        for (let i = Math.max(1, RV.idxAt(e.t, heal.t0)); i < e.t.length && e.t[i] <= heal.t1; i++) {
          if (e.t[i] < heal.t0 || e.hp[i] <= e.hp[i - 1]) continue;
          amount = Math.min(heal.total, amount + e.hp[i] - e.hp[i - 1]);
          entry.times.push(e.t[i]); entry.totals.push(amount);
        }
      }
      const i = RV.idxAt(entry.times, t);
      if (i >= 0) total += entry.totals[i];
    }
    return total;
  }
  const classText = classes => (classes || []).map(g => g.map(c => c.replace(/_/g, " ")).join(" ")).join(" / ");
  const titleCase = text => text.replace(/\b[a-z]/g, c => c.toUpperCase());
  function statValue(base, cur, suffix = "") {
    return el("span", { class: "rvc-stat-value" }, fmt(base),
      Math.abs(cur - base) > 1e-6 ? el("span", { class: "rvc-upgrade" }, ` ↗ ${fmt(cur)}`) : null, suffix);
  }
  function statRow(icon, label, base, cur, title, bonus) {
    const max = Math.max(base, cur, 0), share = max ? Math.min(base, cur) / max * 100 : 0;
    return el("div", { class: `rvc-stat-row${bonus ? " rvc-bonus-row" : ""}`, title },
      el("span", { class: "rvc-stat-icon", "aria-hidden": "true" }, icon),
      el("div", {}, el("div", { class: "rvc-stat-line" }, statValue(base, cur), el("span", { class: "rvc-stat-label" }, label)),
        el("div", { class: "rvc-stat-bar", "aria-hidden": "true" },
          el("i", { style: { width: `${share}%` } }),
          el("i", { class: "rvc-stat-up", style: { width: `${max ? 100 - share : 0}%` } }))));
  }
  const benchmarkTimes = new WeakMap();
  function benchmarkSeconds(combat, e, t) {
    let units = benchmarkTimes.get(combat);
    if (!units) benchmarkTimes.set(combat, units = new Map());
    let times = units.get(e.id);
    if (!times) {
      const engaged = [], active = [], flags = combat.per.get(e.id) || [];
      for (let i = 0; i < flags.length; i += 2) engaged.push([flags[i] - 0.5, flags[i]]);
      for (const blow of combat.lists.get(e.id) || []) {
        const stats = RV_FRAME.statsAt(combat, e, blow.t0), period = (stats && stats.period) || blow.period || 0;
        engaged.push([blow.t0, blow.t0 + 2 * period]);
        if (period > 0) active.push([blow.t0, blow.t0 + period]);
      }
      const union = intervals => {
        intervals.sort((a, b) => a[0] - b[0]);
        const result = [];
        for (const interval of intervals) {
          const last = result[result.length - 1];
          if (interval[1] <= interval[0]) continue;
          if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
          else result.push(interval);
        }
        return result;
      };
      times = { engaged: union(engaged), active: union(active) };
      units.set(e.id, times);
    }
    const aliveSeconds = intervals => {
      let seconds = 0;
      for (const [start, end] of intervals) {
        if (start >= t) break;
        for (let i = 0; i < e.spans.length; i += 2) {
          if (e.spans[i] >= Math.min(t, end)) break;
          seconds += Math.max(0, Math.min(end, t, e.spans[i + 1]) - Math.max(start, 0, e.spans[i]));
        }
      }
      return seconds;
    };
    return { engaged: aliveSeconds(times.engaged), active: aliveSeconds(times.active) };
  }

  function benchmarkOf(combat, e, t, name, stats, tel) {
    const data = window.RV_BENCH;
    const key = name.replace(/^(?:(?:Early|Veteran|Elite|Imperial|Hardened)\s+)+/i, "")
      .replace(/\s+(?:I|II|III|IV|V)$/, "").trim().toLowerCase();
    const bench = data && data.units && data.units[key], memo = combat.telemetry.get(e.id);
    if (!bench || !stats || !memo) return null;
    const seconds = benchmarkSeconds(combat, e, t);
    if (seconds.engaged < 10) return null;
    const dps = tel.dealt / seconds.engaged, uptime = seconds.active / seconds.engaged;
    let samples = 0, good = 0;
    for (let i = 0; i < memo.atkT.length && memo.atkT[i] <= t; i++) {
      samples++;
      if (memo.eff[i] >= RV_FRAME.PRIO_GOOD) good++;
    }
    const goodShare = samples ? good / samples : null;
    const source = `median of ${bench.n} units in ${data.source.recordings} recorded 2000+ games`;
    const pct = v => `${Math.round(v * 100)}%`;
    const compare = (label, value, median, format, explanation, grade) => {
      const known = Number.isFinite(value) && Number.isFinite(median);
      const direction = known && Math.abs(value - median) > 1e-6 ? (value > median ? "up" : "down") : "";
      return el("div", { title: `${source}\n${explanation}` },
        el("span", { class: "rvc-bench-label" }, label),
        el("b", {}, grade ? `${grade} · ` : "", value == null ? "–" : format(value),
          el("span", { class: "rvc-bench-median" }, ` / ${median == null ? "–" : format(median)}`),
          direction ? el("span", { class: `rvc-bench-${direction}`, "aria-label": `${direction === "up" ? "above" : "below"} benchmark` }, direction === "up" ? " ▲" : " ▼") : null));
    };
    return el("div", { class: "rvc-benchmark", "data-unit-type": key },
      el("div", { class: "rvc-h", title: source }, "vs 2000+"),
      el("div", { class: "rvc-bench-values" },
        compare("Effective DPS", dps, bench.effDps, fmt, "Credited damage / engaged seconds; engaged = alive time in unioned [attack flag − 0.5 s, flag] and [blow, blow + 2 upgraded attack periods]."),
        compare("Uptime", uptime, bench.uptime, pct, "Unioned [blow, blow + upgraded attack period] alive seconds / engaged seconds, matching the benchmark's inferred attack-cycle occupancy."),
        compare("Target grade", goodShare, bench.priorityGood, pct, "Live letter grade and share of graded attack samples rated good / benchmark good-sample share.", tel.grade)));
  }

  C.explorer = function (combat, e, t, cd, player, fallback, death) {
    style();
    const s = RV_FRAME.statsAt(combat, e, t), st = s && s.st;
    const name = cd ? cd.name : RV.nameAt(e, t), age = st && ["", "I", "II", "III", "IV"][st.age];
    const classes = el("div", { class: "rvc-classes" }, st ? titleCase((st.cls || []).filter(c => ["heavy", "light", "melee", "ranged", "infantry", "cavalry", "siege", "building"].includes(c)).join(" ")) : "");
    const desc = el("p", { class: "rvc-description", hidden: true });
    const box = el("div", { class: "rvc-explorer" },
      el("header", { class: "rvc-explorer-header" },
        officialIcon(st, e.cat === "building", fallback),
        el("div", {}, el("div", { class: "rvc-name-line" }, el("h3", {}, name),
          age ? el("span", { class: "rvc-age", title: `Age ${age}` }, age) : null), classes)),
      desc,
      el("span", { class: "chip" }, el("i", { style: { background: player ? player.color : "#888" } }), player ? player.name : "?"),
      C.hpBar(e.php, Math.max(e.php, s ? s.hp : e.maxhp), e.on),
      C.cost(cd && cd.cost, e.value));
    if (st) {
      infoOf(st.b, e.cat === "building").then(data => {
        if (!data) return;
        const variations = data.variations || [data];
        const civMatch = v => (v.civs || []).some(c => (st.civs || []).includes(c));
        const v = variations.find(v => v.age === st.age && civMatch(v))
          || variations.find(v => v.age === st.age) || variations.find(civMatch) || variations[0] || data;
        if (v.displayClasses || data.displayClasses) classes.textContent = (v.displayClasses || data.displayClasses).join(" · ");
        const text = v.description || data.description;
        if (text) { desc.textContent = text; desc.hidden = false; }
      });
      const ups = cd.upgrades.map(u => `${u.name} (${clock(u.t)}): ${u.text}`).join("\n");
      const rows = el("div", { class: "rvc-stat-rows" },
        statRow("♥", "Hitpoints", st.hp || e.maxhp, s.hp, ups));
      const weapons = st.wp || [], main = weapons.find(w => w.ty !== "fire") || weapons[0];
      for (const w of weapons) {
        const first = weapons.find(x => x.ty === w.ty);
        const cur = w.dmg + (s.atk[w.ty] - first.dmg);
        const label = `${w.ty} attack${weapons.length > 1 ? ` · ${w.n}` : ""}`;
        rows.append(statRow(w.ty === "ranged" ? "➶" : w.ty === "fire" ? "♨" : "⚔", label, w.dmg, cur, `${w.n}: damage per hit${w.burst > 1 ? ` × ${w.burst}` : ""}\n${ups}`));
        const bonuses = new Map();
        for (const mod of w.mods || []) {
          if (mod.e !== "change" || !mod.v) continue;
          const vs = classText(mod.c) || (mod.id || []).join(" / ");
          const old = bonuses.get(vs) || { base: 0, cur: 0 };
          old.base += mod.v; old.cur += mod.v; bonuses.set(vs, old);
        }
        for (const mod of s.vs) {
          if (mod.ty !== w.ty) continue;
          const vs = classText(mod.c), old = bonuses.get(vs) || { base: 0, cur: 0 };
          old.cur += mod.v; bonuses.set(vs, old);
        }
        for (const [vs, b] of bonuses) rows.append(statRow("+", `vs ${titleCase(vs)}`, b.base, b.cur, `Bonus damage: ${w.n}\n${ups}`, true));
      }
      rows.append(statRow("⬟", "Melee armor", (st.arm && st.arm.melee) || 0, s.arm.melee, ups),
        statRow("◈", "Ranged armor", (st.arm && st.arm.ranged) || 0, s.arm.ranged, ups));
      const summary = el("div", { class: "rvc-summary" });
      const tile = (label, base, cur, suffix) => el("div", {}, el("span", { class: "rvc-summary-label" }, label), statValue(base, cur, suffix));
      if (main) summary.append(tile("Damage (DPS)", main.per ? main.dmg * (main.burst || 1) / main.per : 0,
        s.period ? s.atk[main.ty] * (main.burst || 1) / s.period : 0, ""));
      summary.append(tile("Move speed", st.spd || 0, s.speed, " tiles/s"));
      if (main) summary.append(tile("Attack speed", main.per, s.period, " s"), tile("Range", main.rmax, s.range, " tiles"));
      box.append(rows, summary);
    }
    const tel = cd && cd.tel || RV_FRAME.telemetry(combat, e, t);
    const metric = (label, value) => el("div", {}, el("b", {}, value), label);
    box.append(el("div", { class: "rvc-h" }, "Live match impact"),
      el("div", { class: "rvc-tel rvc-live" },
        metric("damage dealt", fmt(tel.dealt)), metric("damage taken", fmt(tel.taken)),
        metric("kills", String(tel.kills)), metric("healing received", fmt(healedAt(combat, e, t))),
        metric("fight-zone uptime", tel.uptime == null ? "–" : `${Math.round(tel.uptime * 100)}%`),
        metric("target grade", C.grade(tel.grade))));
    const benchmark = benchmarkOf(combat, e, t, name, s, tel);
    if (benchmark) box.append(benchmark);
    if (death) box.append(el("div", { class: "rvc-death" }, death));
    return box;
  };

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
        onclick: (ev) => { ev.preventDefault(); ev.altKey ? onAll(g.key) : onOne(g.key); },
        oncontextmenu: (ev) => { ev.preventDefault(); onAll(g.key); },
      }, g.icon || el("span", { class: "rvc-hint" }, g.label.slice(0, 3)), g.n > 1 ? el("b", {}, String(g.n)) : null,
      el("i", {}, el("i", { style: { width: `${f * 100}%`, background: hpColor(f) } }))));
    }
    return box;
  };
  C.trayHint = () => el("div", { class: "rvc-hint" }, "Click an icon to deselect one · right-click to deselect that type · Shift+click the map toggles a unit · Alt+click drops its type");
})();
