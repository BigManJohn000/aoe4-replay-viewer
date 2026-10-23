// The engagement analysis panel both viewers show for a selected fight (window.RV_FIGHTPANEL), built from
// RV_FIGHTS.analyze. A compact card is always visible: who won and the value each side lost (army / villagers /
// buildings), pre-fight odds against the actual winner, each side's Micro Rating and percentile bars, army swing,
// eco windows and position tags. A closed "Details / ?" accordion holds the rest: what the Micro Rating parts mean,
// the what-if upgrades, the cost-efficiency tug-of-war chart (click seeks), idle army and late reinforcements, tag notes, target-fire shares and the eco
// casualties. DOM only (RV_CARD.el, RV_CARD.grade); styles are its own (classes rvf-*).
(function () {
  "use strict";
  const P = (window.RV_FIGHTPANEL = {});
  /** Target-fire line colours by RV_FRAME.gradeOf grade (the viewports colour attack lines with these too). */
  P.HEAT_COLOR = { good: "#22c55e", ok: "#eab308", bad: "#ef4444" };
  const LOST_COLOR = { army: null, vill: "#fbbf24", bldg: "#94a3b8" };

  const CSS = `
.rvf{font-size:12px;line-height:1.35}
.rvf-h{font-size:11px;text-transform:uppercase;letter-spacing:.05em;opacity:.65;margin:10px 0 3px}
.rvf-card .rvf-h{margin:8px 0 3px}.rvf-card .rvf-h:first-child{margin-top:0}
.rvf-side{display:flex;align-items:center;gap:5px;margin:2px 0;min-width:0}
.rvf-side>i{width:10px;height:10px;border-radius:2px;display:inline-block;flex:none}
.rvf-side .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rvf-badge{display:inline-flex;align-items:center;gap:3px;font-variant-numeric:tabular-nums;white-space:nowrap}
.rvf-na{opacity:.5}
.rvf-win{font-size:13px;font-weight:600;margin:0 0 3px}
.rvf-lost{margin:3px 0 5px}
.rvf-lost .top{display:flex;align-items:baseline;gap:6px}
.rvf-lost .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rvf-lost b{font-variant-numeric:tabular-nums;font-weight:600}
.rvf-lbar{height:8px;border-radius:3px;background:rgba(127,127,127,.15);margin-top:2px;overflow:hidden}
.rvf-lbar>div{display:flex;height:100%;min-width:2px}
.rvf-lbar>div>i{display:block;height:100%}
.rvf-key{display:flex;gap:10px;font-size:10px;opacity:.7}
.rvf-key i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:3px}
.rvf-odds{display:flex;height:6px;border-radius:3px;overflow:hidden;margin:3px 0 2px}
.rvf-comp{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:3px;margin:1px 0 7px 15px}
.rvf-comp>div{font-size:10px;opacity:.85}
.rvf-comp .rvf-na{color:#94a3b8}
.rvf-comp>div>i{display:block;height:4px;border-radius:2px;background:rgba(127,127,127,.25);margin-top:1px}
.rvf-comp>div>i>i{display:block;height:100%;border-radius:2px;background:#60a5fa}
.rvf-bar{display:flex;height:16px;border-radius:3px;overflow:hidden;margin:3px 0;position:relative}
.rvf-bar>div{display:flex;align-items:center;font-size:11px;color:#fff;text-shadow:0 0 2px #000;padding:0 4px;white-space:nowrap;overflow:hidden}
.rvf-bar>div:last-of-type{justify-content:flex-end}
.rvf-bar>b{position:absolute;top:0;bottom:0;width:2px;background:#fff;box-shadow:0 0 2px #000}
.rvf-muted{opacity:.65;font-size:11px}
.rvf-ok{color:#4ade80}.rvf-bad{color:#f87171}.rvf-up{color:#fbbf24}
.rvf-wi{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;margin:2px 0}
.rvf-wi label{display:inline-flex;align-items:center;gap:3px;cursor:pointer}
.rvf canvas{display:block;width:100%;height:96px;cursor:pointer;border-radius:3px;background:rgba(127,127,127,.08)}
.rvf-list{margin:1px 0 4px 15px;padding:0;list-style:none}
.rvf-list li{cursor:pointer;font-size:11px}
.rvf-list li:hover{text-decoration:underline}
.rvf-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
.rvf-tag{display:inline-flex;align-items:center;gap:4px;border:1px solid rgba(127,127,127,.45);border-radius:10px;padding:1px 8px;font-size:11px;cursor:help}
.rvf-tag>i{width:7px;height:7px;border-radius:50%;flex:none}
.rvf-heat{display:flex;height:8px;border-radius:2px;overflow:hidden;margin:2px 0 1px 15px}
.rvf-eco{margin:0 0 3px 15px;font-size:11px}
.rvf-expl{margin:2px 0 4px;padding:0;list-style:none;font-size:11px;opacity:.8}
.rvf-more{margin-top:8px;border-top:1px solid rgba(127,127,127,.25);padding-top:4px}
.rvf-more>summary{cursor:pointer;font-size:11px;text-transform:uppercase;letter-spacing:.05em;opacity:.75;user-select:none}
.rvf-more>summary:hover{opacity:1}`;
  let styled = false;
  function style() {
    if (styled) return;
    styled = true;
    const s = document.createElement("style");
    s.textContent = CSS;
    document.head.append(s);
  }
  const el = (...a) => window.RV_CARD.el(...a);
  const clock = (t) => {
    const s = Math.max(0, Math.floor(t));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const k = (v) => (v == null ? "–" : Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + "k" : String(Math.round(v)));
  const pct = (v) => `${Math.round(v * 100)} %`;
  const MICRO_MEDIAN = "50 = median 2000+ side (151 recorded games)";
  const MICRO_LABEL = { priority: "Priority", focus: "Focus", kiting: "Kiting", splash: "Splash", uptime: "Uptime" };
  const signed = (v) => `${v < 0 ? "−" : "+"}${k(Math.abs(v))}`;

  /** Rating badge for a list row: { score, letter } or null (the side never attacked). */
  P.badge = function (r) {
    style();
    if (!r || r.score == null) return el("span", { class: "rvf-badge rvf-na", title: "No attacks in this fight: no Micro Rating" }, "–");
    return el("span", { class: "rvf-badge", title: `Micro Rating ${Math.round(r.score)} / 100` }, window.RV_CARD.grade(r.letter), String(Math.round(r.score)));
  };

  // what-if choices per fight id survive the panel being rebuilt
  const WHAT_IF = new Map();

  /**
   * Builds the panel for analysis A (RV_FIGHTS.analyze). opts: { t, seek(t), heat (bool), onHeat(bool) }.
   * The returned element has setTime(t), which moves the tug-of-war cursor without a rebuild.
   */
  P.render = function (A, opts) {
    style();
    const side = new Map(A.sides.map((s) => [s.team, s]));
    const color = (tm) => (side.get(tm) && side.get(tm).colors[0]) || "#888";
    const name = (tm) => (side.get(tm) ? side.get(tm).names.join(" & ") : `Team ${tm + 1}`);
    const who = (tm) => el("span", { style: { color: color(tm), fontWeight: 600 } }, name(tm));
    const chip = (tm, ...rest) => el("div", { class: "rvf-side" }, el("i", { style: { background: color(tm) } }), el("span", { class: "nm" }, name(tm)), ...rest);
    const L = A.lanchester;
    const duel = !!(L && L.B !== undefined);
    const box = el("div", { class: "rvf" });
    const card = el("div", { class: "rvf-card" });
    box.append(card);

    // ── Main card 1: who won and the value lost ──
    card.append(el("div", { class: "rvf-h", title: "Resources (food + wood + gold + stone) of the units and buildings each side lost in this fight" }, "Who won · value lost"));
    if (duel) {
      card.append(el("div", { class: "rvf-win", title: "The winner is the side that lost less army + villager value; within 10 % counts as an even trade" },
        L.actual === null ? "Even trade" : [who(L.actual === "A" ? L.A : L.B), " won"]));
    }
    const maxLost = Math.max(1, ...A.teams.map((tm) => A.lost.total[tm] || 0));
    const present = new Set();
    for (const tm of A.teams) {
      const p = A.lost.parts[tm], tot = A.lost.total[tm] || 0;
      const segs = [["army", p.army, "Army"], ["vill", p.vill, "Villagers"], ["bldg", p.bldg, "Buildings"]].filter((s) => s[1] > 0);
      for (const s of segs) present.add(s[0]);
      card.append(el("div", { class: "rvf-lost" },
        el("div", { class: "top" }, el("span", { class: "nm", style: { color: color(tm), fontWeight: 600 } }, name(tm)),
          el("b", { title: `army ${k(p.army)} · villagers ${k(p.vill)} · buildings ${k(p.bldg)}` }, tot ? `${k(tot)} lost` : "no losses")),
        el("div", { class: "rvf-lbar" }, el("div", { style: { width: `${(tot / maxLost) * 100}%` } },
          segs.map(([key, v, label]) => el("i", { title: `${label}: ${k(v)} resources`, style: { flex: `${v} 1 0`, background: LOST_COLOR[key] || color(tm) } }))))));
    }
    if (present.has("vill") || present.has("bldg")) {
      card.append(el("div", { class: "rvf-key" }, el("span", {}, el("i", { style: { background: "#888" } }), "army (side colour)"),
        present.has("vill") ? el("span", {}, el("i", { style: { background: LOST_COLOR.vill } }), "villagers") : null,
        present.has("bldg") ? el("span", {}, el("i", { style: { background: LOST_COLOR.bldg } }), "buildings") : null));
    }

    // ── Main card 2: expected vs actual ──
    const odds = duel && L.predicted !== null;
    if (odds) {
      card.append(el("div", { class: "rvf-h", title: "Odds from each side's army at the start of the fight: damage per second × total hit points (a square-law estimate, calibrated on recorded fights)" }, "Expected vs actual"));
      card.append(el("div", {}, "Pre-fight odds: ", who(L.A), ` ${Math.round(L.p * 100)}% · `, who(L.B), ` ${Math.round((1 - L.p) * 100)}%`),
        el("div", { class: "rvf-odds" }, el("div", { style: { width: `${L.p * 100}%`, background: color(L.A) } }), el("div", { style: { flex: "1", background: color(L.B) } })),
        el("div", {}, "Actual winner: ", L.actual === null ? "even trade" : who(L.actual === "A" ? L.A : L.B),
          L.correct === null ? "" : L.correct ? el("span", { class: "rvf-ok" }, " (as expected)") : el("span", { class: "rvf-up" }, " (upset)")));
    }

    // ── Main card 3: Micro Rating and calibrated percentiles ──
    card.append(el("div", { class: "rvf-h", title: MICRO_MEDIAN }, "Micro Rating"));
    for (const tm of A.teams) {
      const r = A.rating[tm];
      const micro = r && r.score != null
        ? el("span", { class: "rvf-badge", title: MICRO_MEDIAN }, `Micro ${Math.round(r.score)} (`, window.RV_CARD.grade(r.letter), ")")
        : el("span", { class: "rvf-badge rvf-na", title: MICRO_MEDIAN }, "Micro –");
      card.append(chip(tm, micro), el("div", { class: "rvf-comp" }, Object.keys(MICRO_LABEL).map((c) => {
        const v = r && r.pct ? r.pct[c] : null;
        return el("div", { class: v == null ? "rvf-na" : null, title: MICRO_MEDIAN },
          `${MICRO_LABEL[c]} ${v == null ? "–" : Math.round(v)}`,
          el("i", {}, v == null ? null : el("i", { style: { width: `${v}%` } })));
      })));
    }

    if (A.swing) {
      card.append(el("div", { class: "rvf-h", title: `Change in army resource value from ${clock(A.swing.beforeTime)} to ${clock(A.swing.afterTime)}` }, "Army swing"));
      for (const tm of A.teams) {
        const s = A.swing.sides[tm];
        if (!s) continue;
        card.append(chip(tm, el("span", {
          class: s.delta > 0 ? "rvf-ok" : s.delta < 0 ? "rvf-bad" : "rvf-muted",
          title: `${k(s.before)} → ${k(s.after)} army resources`,
        }, `${signed(s.delta)} res`)));
      }
    }

    if (A.ecoWindows && A.ecoWindows.length) {
      card.append(el("div", { class: "rvf-h", title: "Fights during an overdue economy upgrade; estimated missed resources and the non-delayed side's trade outcome" }, "Eco window"));
      for (const w of A.ecoWindows) {
        const actor = w.capitalizedBy;
        const winner = duel && L.actual != null ? (L.actual === "A" ? L.A : L.B) : null;
        const outcome = actor == null ? null : winner === actor
          ? [" · punished by ", who(actor)]
          : [" · ", who(actor), winner == null ? " attacked the window but traded evenly" : " attacked the window but lost the trade"];
        card.append(el("div", { class: "rvf-eco", style: { marginLeft: 0 } },
          el("span", { style: { color: color(w.team), fontWeight: 600 } }, w.name),
          ` fought ${clock(w.overdue)} into an overdue ${w.techName} (−${k(w.missed)} res)`,
          outcome));
      }
    }

    // ── Main card 4: position tags ──
    if (A.tags.length) {
      card.append(el("div", { class: "rvf-tags" }, A.tags.map((tg) => el("span", { class: "rvf-tag", title: `${name(tg.side)}: ${tg.note || tg.tag}` },
        el("i", { style: { background: color(tg.side) } }), tg.tag))));
    }

    // ── Details accordion ──
    const more = el("details", { class: "rvf-more" }, el("summary", { title: "Micro Rating parts, what-if upgrades, tug of war, idle units, target fire, eco losses" }, "Details / ?"));
    card.append(more);

    // 1. Micro Rating parts
    more.append(el("div", { class: "rvf-h", title: MICRO_MEDIAN }, "Micro Rating v2 · percentile weighted mean"));
    more.append(el("div", { class: "rvf-muted" },
      "Micro = Σ(weight × percentile) / Σ(available weights). Priority 30%, Focus 25%, Kiting 15%, Splash 15%, Uptime 15%. ",
      "Absent parts are omitted and the remaining weights renormalised; grey bars mean unmeasured. ",
      "50 = median 2000+ side (151 recorded games). Letters: S ≥ 90, A ≥ 75, B ≥ 60, C ≥ 45, otherwise F."));
    const EXPLAIN = {
      priority: "percentile of target efficiency against the best target in reach",
      focus: "60% focus-kill-share percentile + 40% waste-control (overkill) percentile",
      kiting: "mean of moving-share and chase-gain percentiles, using the measured parts",
      splash: "percentile of the share of siege shots hitting two or more units",
      uptime: "percentile of attack-cycle occupancy relative to continuous attacking",
    };
    more.append(el("ul", { class: "rvf-expl" }, Object.keys(MICRO_LABEL).map((c) => el("li", {}, el("b", {}, MICRO_LABEL[c]), `: ${EXPLAIN[c]}`))));
    more.append(el("div", { class: "rvf-muted" }, "Descriptive, noncausal calibration from 151 recorded games, not a prediction of who should win."));
    if (A.ecoWindows && A.ecoWindows.length) more.append(el("div", { class: "rvf-muted" },
      "Eco window: an RV_ECO upgrade delay overlapping this fight; overdue time and estimated missed resources are measured at fight start. ",
      "A non-delayed opponent who won the trade (lost less army + villager value) punished the window; an opponent who attacked but lost is labelled explicitly. ",
      "This is separate from the Eco panel/HUD's capitalized-delay evidence, which asks whether the delayed player used the saved resources for military tempo."));

    // 2. What-if
    if (odds) {
      more.append(el("div", { class: "rvf-h", title: `Square law: strength = damage per second × total HP of each side's army at the start; win chance = logistic(ln(strength A / strength B) / ${L.tau})` }, "Win chance and what-if"));
      const bar = el("div", { class: "rvf-bar" });
      const drawBar = (p, base) => {
        bar.replaceChildren(el("div", { style: { width: `${p * 100}%`, background: color(L.A) } }, `${name(L.A)} ${pct(p)}`),
          el("div", { style: { width: `${(1 - p) * 100}%`, background: color(L.B) } }, pct(1 - p)));
        if (base != null) bar.append(el("b", { style: { left: `calc(${base * 100}% - 1px)` }, title: `Without the upgrade: ${pct(base)}` }));
      };
      drawBar(L.p, null);
      more.append(bar);

      const st = WHAT_IF.get(A.id) || { side: "A", armor: false, attack: false };
      WHAT_IF.set(A.id, st);
      const out = el("div", { class: "rvf-muted" });
      const apply = () => {
        const r = st.armor || st.attack ? A.whatIf({ side: st.side, armor: st.armor ? 1 : 0, attack: st.attack ? 1 : 0 }) : null;
        if (!r) { drawBar(L.p, null); out.textContent = "Tick an upgrade to see how the odds would move."; return; }
        drawBar(r.p, r.base);
        const s = r.side, o = s === "A" ? "B" : "A";
        out.textContent = `${name(r.team)} wins ${pct(r.base)} → ${pct(r.p)} (${r.dp >= 0 ? "+" : ""}${(r.dp * 100).toFixed(1)} pt); expected losses: ` +
          `${name(L[s])} ${k(r.baseExpected[s].lostValue)} → ${k(r.expected[s].lostValue)}, ${name(L[o])} ${k(r.baseExpected[o].lostValue)} → ${k(r.expected[o].lostValue)}`;
      };
      const radio = (s) => el("label", {}, el("input", { type: "radio", name: `rvf-wi-${A.id}`, checked: st.side === s, onchange: () => { st.side = s; apply(); } }), name(L[s]));
      const check = (key, label, title) => el("label", { title }, el("input", { type: "checkbox", checked: st[key], onchange: (ev) => { st[key] = ev.target.checked; apply(); } }), label);
      more.append(el("div", { class: "rvf-wi" }, el("span", { class: "rvf-muted" }, "What if"), radio("A"), radio("B"),
        check("armor", "+1 armour", "+1 melee and ranged armour on every unit of that side"),
        check("attack", "+1 attack", "+1 damage on every weapon of that side")), out);
      apply();
    }

    // 3. Tug-of-war
    const T = A.tug;
    more.append(el("div", { class: "rvf-h", title: "Resource value killed by side A minus side B over the fight; dots are deaths. Click to seek." }, "Who was killing more (tug of war)"));
    more.append(el("div", { class: "rvf-muted" }, A.teams.map((tm) => `${name(tm)} killed ${k(T.final[tm])}`).join(" · ")));
    const cv = el("canvas", { title: "Click a point to go to that moment" });
    more.append(cv);
    let cursor = opts.t;
    const t0 = A.t0, t1 = Math.max(A.t1, A.t0 + 1);
    const lim = Math.max(1, ...T.series.map((s) => Math.abs(s[1])));
    const geom = () => ({ w: cv.clientWidth || 300, h: cv.clientHeight || 96 });
    const X = (t, w) => 4 + ((t - t0) / (t1 - t0)) * (w - 8);
    const Y = (v, h) => h / 2 - (v / lim) * (h / 2 - 6);
    const draw = () => {
      const { w, h } = geom(), dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      const g = cv.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      g.strokeStyle = "rgba(127,127,127,.5)"; g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
      // step area: above the axis side A is ahead, below side B
      for (const [sgn, tm] of [[1, L ? L.A : A.teams[0]], [-1, L ? L.B : A.teams[1]]]) {
        g.save(); g.beginPath();
        if (sgn > 0) g.rect(0, 0, w, h / 2); else g.rect(0, h / 2, w, h / 2);
        g.clip();
        g.globalAlpha = 0.35; g.fillStyle = color(tm);
        g.beginPath(); g.moveTo(X(t0, w), h / 2);
        let prev = 0;
        for (const [t, v] of T.series) { g.lineTo(X(t, w), Y(prev, h)); g.lineTo(X(t, w), Y(v, h)); prev = v; }
        g.lineTo(X(t1, w), Y(prev, h)); g.lineTo(X(t1, w), h / 2); g.closePath(); g.fill();
        g.restore();
      }
      g.strokeStyle = "#e5e7eb"; g.lineWidth = 1.5; g.beginPath();
      let prev = 0;
      g.moveTo(X(t0, w), Y(0, h));
      for (const [t, v] of T.series) { g.lineTo(X(t, w), Y(prev, h)); g.lineTo(X(t, w), Y(v, h)); prev = v; }
      g.stroke();
      let run = 0;
      const runBy = {};
      for (const ev of T.events) {
        runBy[ev.by] = (runBy[ev.by] || 0) + ev.value;
        run = (runBy[L ? L.A : A.teams[0]] || 0) - Object.entries(runBy).filter(([tm]) => +tm !== (L ? L.A : A.teams[0])).reduce((s, [, v]) => s + v, 0);
        g.fillStyle = color(ev.by);
        g.beginPath(); g.arc(X(ev.t, w), Y(run, h), 2.5, 0, Math.PI * 2); g.fill();
      }
      if (cursor >= t0 && cursor <= t1) {
        g.strokeStyle = "rgba(255,255,255,.8)"; g.beginPath(); g.moveTo(X(cursor, w), 0); g.lineTo(X(cursor, w), h); g.stroke();
      }
    };
    // the canvas has no size while the accordion is closed: draw when it opens
    more.addEventListener("toggle", () => { if (more.open) draw(); });
    cv.addEventListener("click", (ev) => {
      const b = cv.getBoundingClientRect(), w = b.width, mx = ev.clientX - b.left;
      let best = null, bd = 8;
      for (const e of T.events) { const dx = Math.abs(X(e.t, w) - mx); if (dx < bd) { bd = dx; best = e; } }
      opts.seek(best ? Math.max(t0, best.t - 2) : t0 + ((mx - 4) / (w - 8)) * (t1 - t0));
    });
    box.setTime = (t) => { if (t !== cursor) { cursor = t; if (more.open) draw(); } };

    // 4. Idle army and late reinforcements
    more.append(el("div", { class: "rvf-h", title: "Idle: inside the fight, moved under 4 m over the trailing 15 s and did not attack. Late: first inside the fight over 20 s after it started." }, "Idle army · late reinforcements"));
    for (const tm of A.teams) {
      const r = A.idle[tm];
      if (!r) continue;
      more.append(chip(tm, el("span", { class: "rvf-muted" }, `idle ${r.idle.length} (${k(r.idleValue)} res, ${pct(r.idleShare)}) · late ${r.late.length} (${k(r.lateValue)} res)`)));
      const items = [...r.idle.slice(0, 3).map((u) => ({ t: u.since, text: `${u.name} idle ${Math.round(u.idleSecs)} s from ${clock(u.since)}` })),
        ...r.late.slice(0, 3).map((u) => ({ t: u.arrive, text: `${u.name} arrived +${Math.round(u.late)} s (${clock(u.arrive)})` }))];
      if (items.length) more.append(el("ul", { class: "rvf-list" }, items.map((it) => el("li", { onclick: () => opts.seek(it.t) }, it.text))));
    }

    // 5. Position notes
    more.append(el("div", { class: "rvf-h" }, "Position"));
    more.append(...(A.tags.length
      ? A.tags.map((tg) => el("div", { class: "rvf-eco", style: { marginLeft: 0 } }, el("b", {}, tg.tag), " – ", who(tg.side), `: ${tg.note || ""}`))
      : [el("div", { class: "rvf-muted" }, "No chokepoint, flank, tower or raid edge found.")]));

    // 6. Target-fire heat
    more.append(el("div", { class: "rvf-h", title: "Damage per side by the target choice it went to: good (best target in reach), ok, poor" }, "Target fire"));
    for (const tm of A.teams) {
      const s = A.heat.bySide[tm];
      if (!s || !s.total) continue;
      more.append(chip(tm, el("span", { class: "rvf-muted" }, `good ${pct(s.good / s.total)} · ok ${pct(s.ok / s.total)} · poor ${pct(s.bad / s.total)}`)),
        el("div", { class: "rvf-heat" }, ["good", "ok", "bad"].map((g) => el("div", { style: { width: `${(s[g] / s.total) * 100}%`, background: P.HEAT_COLOR[g] } }))));
    }
    more.append(el("label", { class: "rvf-wi", title: "Colour attack lines on the map by target choice: green good, yellow ok, red poor" },
      el("input", { type: "checkbox", "data-heat": true, checked: !!opts.heat, onchange: (ev) => opts.onHeat(ev.target.checked) }), "Target-fire lines on the map"));

    // 7. Eco casualties
    more.append(el("div", { class: "rvf-h", title: "Villagers and eco buildings lost in the fight area, villagers pulled into the fight, and gathering time lost after villagers were hit" }, "Eco casualties"));
    for (const tm of A.teams) {
      const e = A.eco[tm];
      if (!e) continue;
      more.append(chip(tm), el("div", { class: "rvf-eco" },
        `villagers lost ${e.villagerDeaths} (${k(e.villagerLost)} res) · eco buildings ${k(e.ecoBuildingLost)} res · ${e.villagersPulled} villagers pulled into the fight` +
        (e.villagersPulled ? ` (${k(e.villagerDamage)} dmg)` : "") + ` · gathering time lost ${k(e.forcedIdle)} villager-seconds`));
    }
    requestAnimationFrame(() => { if (more.open) draw(); });
    return box;
  };
})();
