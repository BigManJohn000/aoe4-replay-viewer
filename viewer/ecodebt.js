"use strict";
// 2D presentation index shared by the caster chips and timeline lanes; RV_ECO remains the analysis authority.
(function () {
  const cache = new WeakMap();
  const fmt = n => Math.round(n).toLocaleString();
  function prepare(M) {
    if (cache.has(M)) return cache.get(M);
    const analysis = RV_ECO.analyze(M.d, M.combat);
    const players = M.players.map(p => {
      const pl = analysis.players.get(p.idx), windows = [];
      for (const row of pl ? pl.techs : []) {
        const end = Math.min(row.tActual == null ? M.duration : row.tActual, M.duration);
        if (row.tBench == null || row.tBench >= end) continue;
        const rows = RV_ECO.series(M.d, M.combat, p.idx, row.id);
        windows.push({ p, row, start: row.tBench, end, rows, times: Float64Array.from(rows, r => r[0]) });
      }
      windows.sort((a, b) => a.start - b.start);
      return { p, windows };
    });
    const result = { players };
    cache.set(M, result);
    return result;
  }
  function amount(w, t) {
    if (t <= w.start) return 0;
    if (t >= w.end) return w.row.missed;
    const i = RV.idxAt(w.times, t);
    if (i < 0) return 0;
    const a = w.rows[i], b = w.rows[i + 1];
    if (!b || b[0] <= a[0]) return a[1];
    return a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]);
  }
  function label(w, t) {
    const elapsed = Math.max(0, Math.min(t, w.end) - w.start);
    const decision = t >= w.end ? (w.row.capitalized && w.row.capitalized.yes ? " · ⚔ used" : " · ✗ unused") : "";
    return w.row.name + " +" + RV.fmtTime(elapsed) + " · −" + fmt(amount(w, t)) + " res" + decision;
  }
  function tooltip(w, t) {
    const row = w.row, missed = amount(w, t), elapsed = Math.max(0, Math.min(t, w.end) - w.start);
    const deficit = missed - row.costTotal;
    const status = t < w.start ? "Not yet delayed" : t < w.end ? "Delay active" : "Delay closed";
    const cost = row.cost;
    return w.p.name + " · " + row.name + " — " + status + "\n" +
      "Benchmark " + RV.fmtTime(w.start) + " → " + (row.tActual == null ? "replay end " : "researched ") + RV.fmtTime(w.end) +
      " (" + (row.benchSource === "opponent" ? "opponent timing" : "measured completion median") + ")\n" +
      "Lateness +" + RV.fmtTime(elapsed) + "; missed " + fmt(missed) + " res (estimated)\n" +
      "Tech cost " + fmt(row.costTotal) + " res: " + cost.f + " food / " + cost.w + " wood / " + cost.g + " gold / " + cost.s + " stone\n" +
      "Deficit (missed − cost) " + (deficit < 0 ? "−" : "+") + fmt(Math.abs(deficit)) + " res\n" +
      "Capitalized evidence (whole recorded window): " + (row.capitalized ? row.capitalized.reason : "No applicable decision evidence") + "\n" +
      "Click a timeline window to seek to its benchmark start.";
  }
  window.RV_ECODEBT = { prepare, amount, label, tooltip };
})();
