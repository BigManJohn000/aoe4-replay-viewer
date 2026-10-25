// The eco opportunity-cost panel both viewers show (window.RV_ECOPANEL), built from RV_ECO.analyze: per player, the
// audited villager techs with when they were researched vs the benchmark, the gathering missed by the delay (so far
// at t) and whether the delay bought an attack. The methodology sits in a closed "How is this calculated?" box at
// the bottom. Uses RV_CARD.el.
(function () {
  "use strict";
  const P = (window.RV_ECOPANEL = {});
  const CSS = `
.rve{font-size:12px}
.rve-p{display:flex;align-items:center;gap:6px;margin:10px 0 4px;font-weight:600}
.rve-p i{width:10px;height:10px;border-radius:2px;display:inline-block}
.rve table{width:100%;border-collapse:collapse;font-size:11px}
.rve th{font-weight:400;opacity:.6;text-align:right;padding:1px 3px}
.rve th:first-child,.rve td:first-child{text-align:left}
.rve td{padding:3px;text-align:right;vertical-align:top;font-variant-numeric:tabular-nums;border-top:1px solid rgba(127,127,127,.18)}
.rve td:first-child{font-size:12px}
.rve tr.rve-row{cursor:pointer}.rve tr.rve-row:hover td{background:rgba(127,127,127,.12)}
.rve .late{color:#fb923c}.rve .ontime{color:#4ade80}.rve .never{color:#f87171}
.rve-sub{display:block;opacity:.55;font-size:10px}
.rve-lose{color:#f87171}.rve-none{opacity:.5}
.rve-badge{display:inline-block;padding:1px 6px;border-radius:9px;font-size:10px;line-height:1.35;text-align:center;white-space:normal}
.rve-badge.yes{background:rgba(74,222,128,.18);color:#4ade80}
.rve-badge.no{background:rgba(248,113,113,.18);color:#f87171}
.rve-badge.neutral{background:rgba(127,127,127,.2);opacity:.8}
.rve-how{margin-top:10px;font-size:11px}
.rve-how summary{cursor:pointer;opacity:.7}
.rve-how p{margin:6px 0 0;opacity:.8;line-height:1.4}`;
  let styled = false;
  function style() {
    if (styled) return;
    styled = true;
    const s = document.createElement("style");
    s.textContent = CSS;
    document.head.append(s);
  }
  const clock = (t) => {
    if (t == null) return "–";
    const s = Math.max(0, Math.floor(t)); // floored like eco.js's reasons and the viewers' clocks
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const res = (v) => (v == null ? "–" : Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + "k" : String(Math.round(v)));
  const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  /** The resources a tech speeds up, in words ("Wood", "Gold and Stone", "all resources"). */
  const resWords = (rs) => (rs.length >= 4 ? "all resources" : rs.map(cap1).join(" and "));
  /** Cumulative missed at t from a series [[t, missed]] (linear between points). */
  function seriesAt(s, t) {
    if (!s.length || t <= s[0][0]) return 0;
    for (let i = 1; i < s.length; i++) {
      if (s[i][0] >= t) {
        const [t0, v0] = s[i - 1], [t1, v1] = s[i];
        return t1 > t0 ? v0 + (v1 - v0) * (t - t0) / (t1 - t0) : v1;
      }
    }
    return s[s.length - 1][1];
  }
  P.seriesAt = seriesAt;

  const HOW = [
    "Each row is a villager upgrade (Wheelbarrow, Double Broadax, Horticulture, Specialized Pick, Shaft Mining). Timing is when it finished researching; the line under it is the time to beat.",
    "The time to beat is an earlier opponent's research start, adjusted to this player's research time and age, or age arrival plus a measured median completion offset. The medians come from 1179 summaries / 1177 analysed ranked 1v1 games (2354 player-games), 2000+ MMR, patch 11308, analysed 2026-10-23 at 06:45 UTC by tools/analyze_summaries.py; global researcher counts are Wheelbarrow 1690, Double Broadax 1550, Horticulture 1356, Specialized Pick 1219 and Shaft Mining 573. Civ-specific medians require at least 30 researchers, otherwise the global median is used. Research time is not added to these completion offsets.",
    "Missed is an estimate: sum of gatherers × estimated extra resources per villager per second × seconds delayed, from the benchmark until research finished (or replay end if never). For example, 10 woodcutters × 0.65 wood/s × 15% × 60 seconds = 58.5 missed wood. Other completed gather upgrades adjust the base rate; Wheelbarrow uses an assumed carrying/travel model. The figure shown grows with the replay clock; hover it for the final total.",
    "Gather speeds are inferred from changes in the player's bank plus estimated spending, with default rates when there is too little evidence. Trade, relic income, refunds, and unrecorded spending can distort this estimate; it is not measured lost income. The benchmark describes comparison timing, not proof that earlier research was affordable or strategically best.",
    "The verdict checks for evidence that the delay bought military tempo: a low bank with spending mostly on army and defences, plus enemy disruption or a held defence 90 to 180 seconds after the benchmark. \"Used military tempo\" means both checks passed; \"No tempo evidence\" means they did not. These are heuristic labels, not proof of the player's intent or that no attack happened.",
    "Hover a row for research cost, the deficit and the reason for its verdict. Completed research: deficit equals missed gather because its cost was paid in both scenarios. Never researched: subtract the unspent upgrade cost; a negative deficit means that saving exceeds missed gather. Click a row to jump to the time to beat.",
    "In the 2D viewer, Layers → Eco debt toggles live caster chips and timeline delay lanes. Chips show at most two active/recent delays per player and retain their final missed amount and used/unused decision for 20 seconds after research. Timeline windows run from benchmark to research (or replay end); hatching means unused, and clicking a window seeks to its benchmark. Hover chips or lanes for lateness, cost, deficit and the recorded capitalized evidence.",
  ];
  // the how-it-works box keeps its open state across the viewers' once-a-second rebuilds
  let howOpen = false;

  /**
   * Builds the panel. A: RV_ECO.analyze result; opts: { d, C, t, color(idx) → css colour, seek(t) }. Clicking a row
   * seeks to the benchmark time.
   */
  P.render = function (A, opts) {
    style();
    const el = window.RV_CARD.el, box = el("div", { class: "rve" });
    const order = [...A.players.values()].sort((a, b) => (a.team ?? 0) - (b.team ?? 0) || a.idx - b.idx);
    for (const pl of order) {
      box.append(el("div", { class: "rve-p" }, el("i", { style: { background: opts.color(pl.idx) } }), pl.name,
        el("span", { style: { opacity: 0.6, fontWeight: 400 } }, ` ${pl.civ}`)));
      const tb = el("table", {}, el("tr", {}, el("th", {}, "Upgrade"), el("th", {}, "Timing"), el("th", {}, "Missed"), el("th", {}, "Verdict")));
      for (const r of pl.techs) {
        const delayed = r.status === "late" || r.status === "never";
        const s = delayed ? window.RV_ECO.series(opts.d, opts.C, pl.idx, r.id) : [];
        const now = s.length ? seriesAt(s, opts.t) : 0;
        const c = r.capitalized || {};
        const resName = resWords(r.resources);

        const timing = el("td", {}, el("span", { class: r.status === "never" ? "never" : r.status }, r.status === "never" ? "Never" : clock(r.tActual)));
        if (r.tBench != null) timing.append(el("span", { class: "rve-sub" }, `${r.benchSource === "opponent" ? "Opp." : "Typical"} ${clock(r.tBench)}`));

        const missed = el("td", {});
        if (delayed && now >= 0.5) {
          missed.append(el("span", { class: "rve-lose" }, `−${res(now)}`), ` ${r.resources.length >= 4 ? "res." : r.resources.map(cap1).join("/")}`);
          missed.title = `Missed ${res(r.missed)} ${resName} in total${r.status === "never" ? " so far (never researched)" : ""}`;
        } else {
          missed.append(el("span", { class: "rve-none" }, "—"));
          if (delayed) missed.title = `Missed ${res(r.missed)} ${resName} in total`;
        }

        const verdict = r.status === "ontime" ? ["neutral", "On time"] : !delayed ? ["neutral", "—"]
          : c.yes ? ["yes", "Used military tempo"] : ["no", "No tempo evidence"];

        const tip = [];
        if (Number.isFinite(r.rateBase)) tip.push(`Rate ${r.rateBase.toFixed(2)} → ${(Number.isFinite(r.rateUp) ? r.rateUp : r.rateBase).toFixed(2)} res per villager per second (${r.rateSource}).`);
        if (delayed) {
          tip.push(`Upgrade cost ${res(r.costTotal)}; deficit ${r.deficit < 0 ? "−" : ""}${res(Math.abs(r.deficit))} (${r.tActual == null ? "missed − unspent cost" : "missed; research paid"}).`);
          const win = (c.impact && c.impact.window) || (r.tempo && [r.tempo.t0, r.tempo.t1]);
          if (win) tip.push(`Tempo window ${clock(win[0])}–${clock(win[1])}.`);
          if (c.reason) tip.push(c.reason);
        } else if (c.reason) tip.push(c.reason);
        if (r.tBench != null) tip.push("Click: go to the time to beat.");

        tb.append(el("tr", { class: "rve-row", title: tip.join("\n"), onclick: () => r.tBench != null && opts.seek(r.tBench) },
          el("td", {}, r.name), timing, missed, el("td", {}, el("span", { class: `rve-badge ${verdict[0]}` }, verdict[1]))));
      }
      box.append(tb);
    }
    const how = el("details", { class: "rve-how", open: howOpen },
      el("summary", {}, "How is this calculated? (?)"), HOW.map((t) => el("p", {}, t)));
    how.addEventListener("toggle", () => { howOpen = how.open; });
    box.append(how);
    return box;
  };
})();
