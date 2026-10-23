"use strict";
// Compact docked 2D caster strip. Time indices are prepared once; only changed DOM values are patched.
(function () {
  const RES = ["food", "wood", "gold", "stone"];
  const DEFAULT_RATE = [0.75, 0.65, 0.6, 0.6]; // RV_ECO's res/villager/second defaults
  const CIV = {
    english: "English", french: "French", hre: "Holy Roman Empire", rus: "Rus", chinese: "Chinese",
    sultanate: "Delhi Sultanate", mongol: "Mongols", abbasid: "Abbasid Dynasty", ottoman: "Ottomans",
    malian: "Malians", japanese: "Japanese", byzantine: "Byzantines", macedonian: "Macedonian Dynasty",
    templar: "Knights Templar", sengoku: "Sengoku Daimyo", tughlaq: "Tughlaq Dynasty", jin: "Jin Dynasty",
    chinese_ha_01: "Zhu Xi's Legacy", abbasid_ha_01: "Ayyubids", french_ha_01: "Jeanne d'Arc", hre_ha_01: "Order of the Dragon",
  };
  const AGES = ["I", "II", "III", "IV"];
  function el(tag, cls, text, parent) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    if (parent) parent.append(n);
    return n;
  }
  function text(n, v) { v = String(v); if (n.textContent !== v) n.textContent = v; }
  function width(n, v) { const s = v.toFixed(1) + "%"; if (n.style.width !== s) n.style.width = s; }
  function series(rows) { return { rows, times: Float64Array.from(rows, r => r[0]) }; }
  function at(s, t) { const i = RV.idxAt(s.times, t); return i < 0 ? null : s.rows[i]; }
  function number(v) { return Number.isFinite(v) && v >= 0 ? Math.round(v).toLocaleString() : "—"; }
  function ageOf(label) { return /imperial/i.test(label) ? 3 : /castle/i.test(label) ? 2 : /feudal/i.test(label) ? 1 : 0; }

  function create(root, M) {
    const d = M.d;
    root.replaceChildren();
    root.hidden = true;
    if (d.players.length !== 2) return { update() {} };
    const eco = window.RV_ECO ? RV_ECO.analyze(d, M.combat) : null;
    const sides = [], columns = el("div", "caster-sides", null, root);
    const debtPlayers = RV_ECODEBT.prepare(M).players;
    const byId = M.byId, dead = new Set(), loss = new Map(d.players.map(p => [p.idx, []]));
    for (const k of M.kills) {
      const e = byId.get(k.victim);
      if (!e || dead.has(e.id) || e.cat === "building" || e.cat === "livestock" || e.cat === "attachment") continue;
      dead.add(e.id);
      const owner = RV.ownerAt(e, k.t), rows = loss.get(owner);
      if (rows) rows.push([k.t, (rows.length ? rows[rows.length - 1][1] : 0) + (e.value || 0)]);
    }
    for (let side = 0; side < 2; side++) {
      const p = d.players[side], box = el("section", "caster-side caster-side-" + side, null, columns);
      box.style.setProperty("--caster-player", p.color);
      box.setAttribute("aria-label", p.name + " caster statistics");
      const head = el("div", "caster-header", null, box);
      const badge = el("span", "caster-age", "I", head);
      badge.title = "Current age";
      const identity = el("div", "caster-identity", null, head);
      el("b", "caster-name", p.name, identity);
      // The data.aoe4world.com flags/civs PNG endpoints return 404; use civilization names, not broken images.
      el("span", "caster-civ", CIV[p.civ] || p.civ.replaceAll("_", " "), identity);
      identity.title = p.name + " · " + (CIV[p.civ] || p.civ.replaceAll("_", " "));
      const result = d.summary && d.summary.players && d.summary.players[p.idx];
      const resultBadge = result && result.result ? el("span", "caster-result", result.result, head) : null;
      if (resultBadge) { resultBadge.title = "Final match result"; resultBadge.hidden = true; }
      const population = el("div", "caster-population", null, box);
      const counts = el("div", "caster-counts", null, population);
      const vil = el("span", "caster-villagers", null, counts), mil = el("span", "caster-military", null, counts);
      const pop = el("span", "caster-pop", null, counts);
      pop.title = "Recorded population; population cap is not recorded";
      const split = el("div", "caster-pop-bar", null, population);
      split.title = "Living villagers (gold) versus military units (player colour); unit counts, not population slots";
      const vilBar = el("i", "caster-vil-fill", null, split), milBar = el("i", "caster-mil-fill", null, split);
      const economy = el("div", "caster-economy", null, box), resources = [];
      const ep = eco && eco.players.get(p.idx);
      for (let r = 0; r < 4; r++) {
        const cell = el("div", "caster-resource caster-" + RES[r], null, economy);
        const main = el("span", "caster-resource-main", null, cell);
        const label = el("span", "caster-resource-label", null, main);
        el("i", "caster-resource-dot", null, label);
        label.title = RES[r];
        const bank = el("b", "caster-bank", "—", main);
        const income = el("span", "caster-income", "+—/min · — v", cell);
        const rate = ep && ep.rates[RES[r]] ? ep.rates[RES[r]].rate : DEFAULT_RATE[r];
        cell.title = "Unspent " + RES[r] + "; villagers gathering; estimated income/min = gatherers × " +
          (rate * 60).toFixed(1) + " per villager/min (" + (ep && ep.rates[RES[r]] ? ep.rates[RES[r]].source : "default") +
          " no-tech rate from RV_ECO). Estimate excludes trade, relics and other income; not a recorded income rate.";
        resources.push({ bank, income, rate });
      }
      const bottom = el("div", "caster-bottom", null, box);
      const ticker = el("div", "caster-research", null, bottom);
      const idle = el("span", "caster-research-idle", "No recent research", ticker);
      ticker.title = "Estimated research in progress first, then completions in the last 40 seconds; up to 3 chips, with overflow counted. Starts = completion minus stats.js research time; cancelled research is not recorded.";
      const upgrades = ((M.combat.upgrades && M.combat.upgrades.get(p.idx)) || []).map(u => ({
        t: u.t, start: Math.max(d.recordStart, u.t - ((u.tech.cost && u.tech.cost.t) || 0)), name: u.tech.n || u.key,
      }));
      const starts = upgrades.slice().sort((a, b) => a.start - b.start);
      const ageRows = (d.techs || []).filter(r => r[1] === p.idx && r[3] === "age").sort((a, b) => a[0] - b[0]);
      const overflow = el("span", "caster-overflow", "", ticker);
      overflow.hidden = true;
      const debts = el("div", "caster-debts", null, bottom);
      debts.hidden = true;
      const debtSlots = [el("span", "caster-debt", "", debts), el("span", "caster-debt", "", debts)];
      for (const slot of debtSlots) slot.hidden = true;
      sides.push({ p, badge, resultBadge, vil, mil, pop, vilBar, milBar, resources, ticker, idle, overflow, slots: [],
        debts, debtSlots, windows: debtPlayers.find(pl => pl.p.idx === p.idx).windows,
        stats: series((d.stats && d.stats[p.idx]) || []), jobs: series((d.jobs && d.jobs[p.idx]) || []),
        ages: series(ageRows),
        completed: { rows: upgrades, times: Float64Array.from(upgrades, u => u.t) },
        starts: { rows: starts, times: Float64Array.from(starts, u => u.start) },
        maxResearch: upgrades.reduce((m, u) => Math.max(m, u.t - u.start), 0),
        killed: series(loss.get(d.players[1 - side].idx)), value: 0,
      });
    }
    const army = el("div", "caster-army", null, root);
    el("span", "caster-army-title", "ARMY VALUE", army);
    const labels = el("div", "caster-army-labels", null, army);
    for (const s of sides) {
      const label = el("span", "", null, labels);
      s.armyLabel = el("b", "", "", label);
      s.killLabel = el("span", "caster-killed", "", label);
      s.killLabel.title = "Resources in opposing dead units up to the replay time (buildings excluded); deaths without a recorded killer are included.";
    }
    const tug = el("div", "caster-tug", null, army);
    tug.title = "Living army resource value; both halves use the same scale, growing outwards from the centre";
    for (const s of sides) {
      const half = el("div", "caster-tug-half", null, tug);
      s.valueBar = el("i", "", null, half);
      s.valueBar.style.background = s.p.color;
    }
    let last = -Infinity, visible = false, previousTime = NaN, previousDebt;
    function research(s, t) {
      const items = [], done = RV.idxAt(s.completed.times, t);
      const end = RV.idxAt(s.starts.times, t), begin = RV.idxAt(s.starts.times, t - s.maxResearch);
      for (let i = Math.max(0, begin); i <= end; i++) {
        const u = s.starts.rows[i];
        if (u.t > t && u.start <= t) items.push({ u, progress: (t - u.start) / (u.t - u.start), active: true });
      }
      items.sort((a, b) => a.u.t - b.u.t);
      for (let i = done, n = 0; i >= 0 && n < 3; i--, n++) {
        const u = s.completed.rows[i];
        if (u.t < t - 40) break;
        items.push({ u, progress: 1, active: false });
      }
      const extra = Math.max(0, items.length - 3);
      if (s.overflow.hidden !== !extra) s.overflow.hidden = !extra;
      if (extra) {
        text(s.overflow, "+" + extra);
        const title = items.slice(3).map(item => (item.active ? "Researching: " : "Completed: ") + item.u.name).join("\n");
        if (s.overflow.title !== title) s.overflow.title = title;
      }
      if (items.length > 3) items.length = 3;
      if (s.idle.hidden !== !!items.length) s.idle.hidden = !!items.length;
      for (let i = 0; i < Math.max(items.length, s.slots.length); i++) {
        let slot = s.slots[i];
        if (!slot) {
          const row = el("div", "caster-tech", null, s.ticker);
          s.ticker.insertBefore(row, s.overflow);
          slot = { row, name: el("span", "", "", row), progress: el("i", "caster-tech-progress", null, row) };
          s.slots.push(slot);
        }
        const item = items[i];
        if (slot.row.hidden !== !item) slot.row.hidden = !item;
        if (!item) continue;
        const cls = "caster-tech" + (item.active ? " caster-tech-active" : "");
        if (slot.row.className !== cls) slot.row.className = cls;
        text(slot.name, (item.active ? "↻ " : "✓ ") + item.u.name);
        const title = item.active ? "Estimated completion " + RV.fmtTime(item.u.t) : "Completed " + RV.fmtTime(item.u.t);
        if (slot.row.title !== title) slot.row.title = title;
        width(slot.progress, item.active ? item.progress * 100 : 0);
      }
    }
    function debt(s, t, enabled) {
      const windows = enabled ? s.windows.filter(w => t >= w.start && t <= w.end + 20) : [];
      windows.sort((a, b) => Number(t >= a.end) - Number(t >= b.end) || RV_ECODEBT.amount(b, t) - RV_ECODEBT.amount(a, t));
      const count = Math.min(2, windows.length);
      if (s.debts.hidden !== !count) s.debts.hidden = !count;
      for (let i = 0; i < 2; i++) {
        const slot = s.debtSlots[i], w = i < count ? windows[i] : null;
        if (slot.hidden !== !w) slot.hidden = !w;
        if (!w) continue;
        text(slot, RV_ECODEBT.label(w, t));
        const title = RV_ECODEBT.tooltip(w, t);
        if (slot.title !== title) slot.title = title;
        const cls = "caster-debt" + (t >= w.end ? (w.row.capitalized && w.row.capitalized.yes ? " caster-debt-used" : " caster-debt-unused") : "");
        if (slot.className !== cls) slot.className = cls;
      }
    }
    return { update(t, on, now, showDebt) {
      if (now - last < 200) return;
      last = now;
      if (showDebt !== previousDebt) { previousDebt = showDebt; previousTime = NaN; }
      if (visible !== on) {
        visible = on;
        root.hidden = !on;
        previousTime = NaN;
      }
      if (!on || t === previousTime) return;
      previousTime = t;
      let maxValue = 1;
      const army = RV.armyAt(M, t);
      for (const s of sides) {
        const a = army.get(s.p.idx), v = a.villagers, m = a.military;
        const st = at(s.stats, t), job = at(s.jobs, t), age = at(s.ages, t), kills = at(s.killed, t);
        text(s.badge, AGES[age ? ageOf(age[2]) : 0]);
        if (s.resultBadge) {
          const hide = t < d.duration - 1;
          if (s.resultBadge.hidden !== hide) s.resultBadge.hidden = hide;
        }
        text(s.vil, number(v) + " v"); text(s.mil, number(m) + " m");
        // convert.py appends current pop after the resource columns (four in current recordings, possibly more later).
        text(s.pop, "Pop " + number(st ? st[st.length - 1] : null));
        const total = (v || 0) + (m || 0) || 1;
        width(s.vilBar, (v || 0) / total * 100); width(s.milBar, (m || 0) / total * 100);
        for (let r = 0; r < 4; r++) {
          const res = s.resources[r], g = job ? job[r + 1] : null;
          text(res.bank, number(st ? st[r + 1] : null));
          text(res.income, "+" + number(g == null ? null : g * res.rate * 60) + "/min · " + number(g) + " v");
        }
        research(s, t);
        debt(s, t, showDebt);
        s.value = a.armyValue;
        maxValue = Math.max(maxValue, s.value);
        text(s.armyLabel, number(s.value));
        text(s.killLabel, "Killed " + number(kills ? kills[1] : 0));
      }
      for (const s of sides) width(s.valueBar, s.value / maxValue * 100);
    } };
  }
  window.RV_CASTER = { create };
})();
