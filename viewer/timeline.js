"use strict";
// Bottom timeline: per-player series, fight bands, playhead; click/drag to seek.
(function (RV) {
  const PAD_L = 44, PAD_R = 12, PAD_T = 8, BAND_H = 14;
  const TECH_TOP = 3, TECH_ROW = 4; // one strip row per player for age-up and eco tech marks

  class Timeline {
    constructor(canvas, M, state) {
      this.c = canvas;
      this.g = canvas.getContext("2d");
      this.M = M;
      this.S = state;
      this.metric = "armyValue";
      this.padT = M.techs.length ? TECH_TOP + M.players.length * TECH_ROW + 4 : PAD_T;
      this.resize();
      this.bind();
    }

    resize() {
      const r = this.c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      this.w = r.width; this.h = r.height;
      this.c.width = Math.round(r.width * dpr); this.c.height = Math.round(r.height * dpr);
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    tx(t) { return PAD_L + (t / this.M.duration) * (this.w - PAD_L - PAD_R); }
    xt(x) { return Math.min(this.M.duration, Math.max(0, (x - PAD_L) / (this.w - PAD_L - PAD_R) * this.M.duration)); }

    bind() {
      let down = false;
      const seek = ev => {
        const r = this.c.getBoundingClientRect();
        this.S.seek(this.xt(ev.clientX - r.left));
      };
      this.c.addEventListener("mousedown", ev => {
        const r = this.c.getBoundingClientRect(), y = ev.clientY - r.top;
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
        this.S.dirty = true;
      });
      window.addEventListener("mouseup", () => { down = false; });
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
      const top = this.padT, bottom = h - BAND_H - 4;
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

      if (this.hoverX != null) {
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
