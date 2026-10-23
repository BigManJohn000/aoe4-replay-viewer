"use strict";
// Bottom timeline: per-player series, fight bands, playhead; click/drag to seek.
(function (RV) {
  const PAD_L = 44, PAD_R = 12, PAD_T = 8, BAND_H = 14;
  const TECH_TOP = 3, TECH_ROW = 4; // one strip row per player for age-up and eco tech marks
  const ECO_TRACK = 4, ECO_GAP = 2;

  class Timeline {
    constructor(canvas, M, state) {
      this.c = canvas;
      this.g = canvas.getContext("2d");
      this.M = M;
      this.S = state;
      this.metric = "armyValue";
      this.padT = M.techs.length ? TECH_TOP + M.players.length * TECH_ROW + 4 : PAD_T;
      this.ecoData = RV_ECODEBT.prepare(M);
      this.ecoLanes = this.ecoData.players.map(({ p, windows }) => {
        const tracks = [], ends = [];
        for (const win of windows.slice().sort((a, b) => a.start - b.start || a.end - b.end || a.row.id.localeCompare(b.row.id))) {
          let track = ends.findIndex(end => end <= win.start);
          if (track < 0) { track = tracks.length; tracks.push([]); }
          tracks[track].push(win); ends[track] = win.end;
        }
        return { p, tracks, y: 0, h: 0 };
      });
      this.baseTitle = canvas.title;
      this.resize();
      this.bind();
    }

    resize() {
      const r = this.c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      this.w = r.width; this.h = r.height;
      this.c.width = Math.round(r.width * dpr); this.c.height = Math.round(r.height * dpr);
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.layoutEcoDebt();
    }

    tx(t) { return PAD_L + (t / this.M.duration) * (this.w - PAD_L - PAD_R); }
    xt(x) { return Math.min(this.M.duration, Math.max(0, (x - PAD_L) / (this.w - PAD_L - PAD_R) * this.M.duration)); }

    // CSS-pixel geometry shared by drawing and hit testing; rebuilt only on resize/toggle.
    layoutEcoDebt() {
      this.ecoShown = !!this.S.showEcoDebt;
      this.ecoRects = [];
      this.ecoBottom = this.h - BAND_H - 4;
      this.ecoTop = this.ecoBottom;
      this.graphBottom = this.ecoBottom;
      this.c.title = this.ecoShown
        ? "Eco debt: hover a player’s shaded delay for details; click to seek to its benchmark. Hatching means unused capital."
        : this.baseTitle;
      if (!this.ecoShown || !this.ecoLanes.length) {
        this.hideEcoTooltip();
        return;
      }
      const desired = this.ecoLanes.reduce((sum, lane) => sum + Math.max(10, lane.tracks.length * ECO_TRACK) + ECO_GAP, 0);
      // Keep room for the army graph even in many-player replays or a short footer.
      const scale = Math.min(1, Math.max(0, this.ecoBottom - this.padT) * 0.6 / desired);
      this.ecoTop = this.ecoBottom - desired * scale;
      this.graphBottom = this.ecoTop - 3;
      let y = this.ecoTop;
      for (const lane of this.ecoLanes) {
        lane.y = y;
        lane.h = Math.max(10, lane.tracks.length * ECO_TRACK) * scale;
        const trackTop = y + (lane.h - lane.tracks.length * ECO_TRACK * scale) / 2;
        lane.tracks.forEach((windows, track) => {
          for (const win of windows) {
            const x = this.tx(win.start);
            this.ecoRects.push({
              w: win, p: lane.p, track, x, y: trackTop + track * ECO_TRACK * scale,
              width: Math.max(1, this.tx(win.end) - x), height: (ECO_TRACK - 1) * scale,
            });
          }
        });
        y += lane.h + ECO_GAP * scale;
      }
    }

    ecoAt(x, y) {
      if (this.ecoShown !== !!this.S.showEcoDebt) this.layoutEcoDebt();
      if (!this.ecoShown || x < PAD_L || x > this.w - PAD_R) return null;
      return this.ecoRects.find(r => x >= r.x && x <= r.x + r.width && y >= r.y && y < r.y + r.height) || null;
    }

    hideEcoTooltip() {
      if (this.ecoTooltip) this.ecoTooltip.hidden = true;
    }

    updateEcoTooltip() {
      const point = this.hoverPoint;
      const hit = point && this.ecoAt(point.x, point.y);
      if (!hit) { this.hideEcoTooltip(); return; }
      if (!this.ecoTooltip) {
        const tip = document.createElement("div");
        tip.setAttribute("role", "tooltip");
        tip.dataset.timelineEcoDebt = "";
        Object.assign(tip.style, {
          position: "fixed", zIndex: "10000", pointerEvents: "none",
          whiteSpace: "pre-line", maxWidth: "min(480px, calc(100vw - 16px))",
          boxSizing: "border-box", padding: "8px 10px", border: "1px solid",
          borderRadius: "4px", background: "rgba(10,12,16,0.97)",
          color: "#e5e7eb", font: "12px/1.4 system-ui", overflow: "hidden",
        });
        document.body.appendChild(tip);
        this.ecoTooltip = tip;
      }
      const tip = this.ecoTooltip;
      const text = RV_ECODEBT.tooltip(hit.w, this.S.t);
      if (tip.textContent !== text) tip.textContent = text;
      tip.style.borderColor = hit.p.color;
      tip.style.maxHeight = `${Math.max(0, window.innerHeight - 16)}px`;
      tip.hidden = false;
      const bounds = this.c.getBoundingClientRect();
      tip.style.left = `${Math.max(8, Math.min(point.clientX + 10, window.innerWidth - tip.offsetWidth - 8))}px`;
      tip.style.top = `${Math.max(8, bounds.top - tip.offsetHeight - 8)}px`;
    }

    drawEcoDebt() {
      if (!this.ecoShown) return;
      const g = this.g;
      g.font = "9px system-ui";
      for (const lane of this.ecoLanes) {
        g.fillStyle = lane.p.color;
        if (lane.h >= 7) g.fillText(`Eco ${lane.p.idx}`, 3, lane.y + lane.h / 2 + 3);
        g.fillStyle = "rgba(255,255,255,0.035)";
        g.fillRect(PAD_L, lane.y, this.w - PAD_L - PAD_R, lane.h);
      }
      for (const r of this.ecoRects) {
        g.fillStyle = r.p.color;
        g.globalAlpha = 0.45;
        g.fillRect(r.x, r.y, r.width, r.height);
        g.globalAlpha = 1;
        g.fillRect(r.x, r.y, 1, r.height);
        if (!r.w.row.capitalized?.yes) {
          g.save();
          g.beginPath(); g.rect(r.x, r.y, r.width, r.height); g.clip();
          g.strokeStyle = "rgba(255,255,255,0.65)";
          g.lineWidth = 1;
          g.beginPath();
          for (let x = r.x - r.height; x < r.x + r.width; x += 5) {
            g.moveTo(x, r.y + r.height); g.lineTo(x + r.height, r.y);
          }
          g.stroke();
          g.restore();
        }
      }
    }

    bind() {
      let down = false;
      const seek = ev => {
        const r = this.c.getBoundingClientRect();
        this.S.seek(this.xt(ev.clientX - r.left));
      };
      this.c.addEventListener("mousedown", ev => {
        const r = this.c.getBoundingClientRect(), y = ev.clientY - r.top;
        const debt = this.ecoAt(ev.clientX - r.left, y);
        if (debt) {
          ev.preventDefault();
          this.S.seek(debt.w.start);
          return;
        }
        if (y > this.h - BAND_H) {
          const f = this.fightAt(ev.clientX - r.left);
          if (f) { this.S.focusFight(f); return; }
        }
        down = true; seek(ev);
      });
      window.addEventListener("mousemove", ev => {
        if (down) seek(ev);
        const r = this.c.getBoundingClientRect();
        const x = ev.clientX - r.left, y = ev.clientY - r.top;
        this.hoverX = x >= PAD_L && x <= this.w - PAD_R && y >= 0 && y <= this.h ? x : null;
        this.hoverPoint = this.hoverX == null ? null : { x, y, clientX: ev.clientX };
        if (!this.hoverPoint) this.hideEcoTooltip();
        this.S.dirty = true;
      });
      window.addEventListener("mouseup", () => { down = false; });
      this.c.addEventListener("mouseleave", () => {
        this.hoverX = null;
        this.hoverPoint = null;
        this.hideEcoTooltip();
        this.S.dirty = true;
      });
    }

    fightAt(x) {
      for (const f of this.M.fights) {
        const x0 = this.tx(f.start) - 2, x1 = Math.max(this.tx(f.end) + 2, x0 + 5);
        if (x >= x0 && x <= x1) return f;
      }
      return null;
    }

    series() {
      const A = this.M.army;
      let max = 1;
      const out = [];
      for (const p of this.M.players) {
        const s = A.players[String(p.idx)];
        if (!s) continue;
        const arr = s[this.metric];
        for (const v of arr) if (v > max) max = v;
        out.push({ p, arr });
      }
      return { out, max, step: A.step };
    }

    draw(t) {
      const g = this.g, M = this.M, w = this.w, h = this.h;
      if (this.ecoShown !== !!this.S.showEcoDebt) this.layoutEcoDebt();
      const top = this.padT, bottom = this.graphBottom;
      g.clearRect(0, 0, w, h);
      g.fillStyle = "#11141a";
      g.fillRect(0, 0, w, h);

      const { out, max, step } = this.series();
      const y = v => bottom - (v / max) * (bottom - top);
      g.strokeStyle = "rgba(255,255,255,0.08)";
      g.fillStyle = "rgba(255,255,255,0.45)";
      g.font = "10px system-ui";
      g.lineWidth = 1;
      for (let k = 0; k <= 3; k++) {
        const v = (max * k) / 3, yy = y(v);
        g.beginPath(); g.moveTo(PAD_L, yy); g.lineTo(w - PAD_R, yy); g.stroke();
        g.fillText(v >= 1000 ? (v / 1000).toFixed(1) + "k" : Math.round(v), 4, yy + 3);
      }
      for (let m = 0; m <= M.duration; m += 300) {
        const xx = this.tx(m);
        g.fillText(RV.fmtTime(m), xx - 10, h - 1);
      }
      for (const { p, arr } of out) {
        g.strokeStyle = p.color;
        g.lineWidth = 1.5;
        g.beginPath();
        arr.forEach((v, i) => { const xx = this.tx(i * step), yy = y(v); i ? g.lineTo(xx, yy) : g.moveTo(xx, yy); });
        g.stroke();
      }
      this.drawTechs(bottom);
      this.drawEcoDebt();

      const maxValue = Math.max(1, ...M.fights.map(f => Object.values(f.losses).reduce((a, l) => a + l.value, 0)));
      for (const f of M.fights) {
        const value = Object.values(f.losses).reduce((a, l) => a + l.value, 0);
        const x0 = this.tx(f.start), x1 = Math.max(this.tx(f.end), x0 + 3);
        const a = 0.35 + 0.65 * Math.sqrt(value / maxValue);
        g.fillStyle = f === this.S.fight ? "rgba(255,220,120,1)" : `rgba(255,170,60,${a.toFixed(2)})`;
        g.fillRect(x0, h - BAND_H - 2, x1 - x0, BAND_H - 6);
      }

      const px = this.tx(t);
      g.strokeStyle = "#fff";
      g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(px, 0); g.lineTo(px, h - 4); g.stroke();

      if (this.hoverX != null && !(this.hoverPoint && this.ecoAt(this.hoverPoint.x, this.hoverPoint.y))) {
        const ht = this.xt(this.hoverX);
        g.strokeStyle = "rgba(255,255,255,0.3)";
        g.beginPath(); g.moveTo(this.hoverX, 0); g.lineTo(this.hoverX, h); g.stroke();
        const i = Math.min(Math.round(ht / step), (out[0] ? out[0].arr.length : 1) - 1);
        const near = M.techs.filter(([tt]) => Math.abs(this.tx(tt) - this.hoverX) <= 4);
        const boxW = near.length ? 230 : 150;
        let ty = 14;
        g.font = "11px system-ui";
        const lx = this.hoverX + 6 > w - boxW - 10 ? this.hoverX - boxW - 10 : this.hoverX + 6;
        g.fillStyle = "rgba(0,0,0,0.7)";
        g.fillRect(lx - 3, 2, boxW, 14 * (out.length + 1 + near.length) + 4);
        g.fillStyle = "#fff";
        g.fillText(RV.fmtTime(ht), lx, ty);
        for (const { p, arr } of out) {
          ty += 14;
          g.fillStyle = p.color;
          g.fillText(`${p.name.slice(0, 14)}: ${arr[i] ?? "-"}`, lx, ty);
        }
        for (const [tt, idx, label] of near) {
          ty += 14;
          const p = M.playerByIdx.get(idx);
          g.fillStyle = p ? p.color : "#fff";
          g.fillText(`${RV.fmtTime(tt)} ${label}`, lx, ty);
        }
      }
      this.updateEcoTooltip();
    }

    // Age-ups: block + dashed line through the graph; eco techs: small tick. Row order follows M.players.
    drawTechs(bottom) {
      const g = this.g, M = this.M;
      M.players.forEach((p, row) => {
        const y = TECH_TOP + row * TECH_ROW;
        g.fillStyle = p.color;
        g.strokeStyle = p.color;
        for (const [t, idx, , kind] of M.techs) {
          if (idx !== p.idx) continue;
          const x = this.tx(t);
          if (kind === "age") {
            g.globalAlpha = 0.5;
            g.setLineDash([2, 3]);
            g.lineWidth = 1;
            g.beginPath(); g.moveTo(x, y); g.lineTo(x, bottom); g.stroke();
            g.setLineDash([]);
            g.globalAlpha = 1;
            g.fillRect(x - 2.5, y, 5, TECH_ROW);
          } else {
            g.fillRect(x - 1, y, 2, TECH_ROW - 1);
          }
        }
      });
    }
  }

  RV.Timeline = Timeline;
})(window.RV);
