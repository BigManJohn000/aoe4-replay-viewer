"use strict";
// 2D tactical map: world x to the right, world z up.
(function (RV) {
  const CASING = "#0b0e14";  // dark outline around units and map objects so they stand off the ground
  const UNIT_RADIUS = { livestock: 0.7, econ: 1.1 };
  // Unit icons by RV.unitType (model.js). Every type is drawn as its UNIT_ART figure at any zoom: the soldier, rider,
  // engine or boat itself, villagers smaller and in a darker shade of the player colour so the army stands out. Below
  // FIGURE_R a figure drops its inner outlines and gets a heavier casing so it still reads as a silhouette. wr: world
  // radius; label/tip: legend text. Key order is legend order.
  const UNIT_TYPES = {
    villager: { wr: 0.9, label: "villager", tip: "Worker: gathers resources and builds" },
    spear: { label: "spearman", tip: "Infantry with spears, strong against cavalry" },
    maa: { label: "man-at-arms", tip: "Heavily armoured infantry with sword and shield" },
    sword: { label: "melee infantry", tip: "Other sword and close-combat infantry (samurai, landsknecht, ...)" },
    archer: { label: "archer", tip: "Foot soldier with a bow" },
    crossbow: { label: "crossbowman", tip: "Foot soldier with a crossbow, strong against armour" },
    gun: { label: "gunpowder", tip: "Handcannons and other gunpowder infantry" },
    horseman: { label: "light cavalry", tip: "Fast horsemen, strong against archers" },
    knight: { label: "heavy cavalry", tip: "Armoured horsemen (knights, lancers, ...)" },
    horsearcher: { label: "horse archer", tip: "Archers on horseback" },
    elephant: { wr: 2, label: "war elephant", tip: "Big, slow and very strong" },
    scout: { wr: 1.15, label: "scout", tip: "Fast rider that explores the map" },
    monk: { label: "monk", tip: "Heals units, carries relics" },
    siege: { wr: 1.9, label: "siege engine", tip: "Catapults, cannons and other machines that break buildings" },
    ram: { wr: 1.9, label: "ram", tip: "Battering ram against buildings" },
    ship: { wr: 2.2, label: "ship", tip: "Warships, transports and fire ships" },
    fishboat: { wr: 1.5, label: "fishing boat", tip: "Gathers food from fish" },
    trader: { wr: 1.3, label: "trader", tip: "Carries goods to trade posts and markets for gold" },
    hero: { wr: 1.6, label: "hero", tip: "Unique leader unit" },
  };
  const ARMY_MIN_R = 5;      // smallest screen radius of non-villager units from scale 3 (3.2 further out), so figures read
  const FIGURE_R = 6;        // screen radius from which figures get their inner outlines (about 15 px tall)
  const PIP_R = 10;          // screen radius from which military units show their tier (age I-IV) as pips above them
  const UNIT_MAX_R = 15;     // icons stop growing here (bigger units proportionally more), so zooming in separates them
  // Buildings by RV.buildingKind (model.js): footprint side in world units, legend text. Footprints are the in-game
  // ones, read off how tightly buildings pack in recorded games (farms, houses, camps, towers and docks 8; barracks,
  // ranges, stables and workshops 12; town centres, landmarks, keeps and tech buildings 16), so a ring of farms
  // closes around its mill and a wall meets what it was built against. At every zoom each kind is drawn as seen from
  // above on its footprint (BUILDING_PLAN: roofs in the owner's colour, small props only once PLAN_DETAIL_PX big);
  // kinds with `badge` add their pictogram (GLYPH) in a small disc from BADGE_PX, since their plan alone is easy to
  // mistake. Farms and houses are drawn faint so bases read as their important buildings. Wall-like kinds (line) are
  // drawn as joined lines. Key order is legend order.
  const BUILDING_TYPES = {
    tc: { size: 16, label: "town center", tip: "Main base building: trains villagers, takes in all resources" },
    landmark: { size: 16, label: "landmark", tip: "Age-up building with a civilization bonus" },
    keep: { size: 16, label: "keep / castle", tip: "Strong defensive building that shoots" },
    tower: { size: 8, label: "tower / outpost", tip: "Small defensive tower" },
    wall: { size: 2, line: true, label: "wall", tip: "Palisade or stone wall" },
    gate: { size: 3, line: true, label: "gate", tip: "Gate: the door in a wall that the owner's units walk through" },
    aqueduct: { size: 2, line: true, label: "aqueduct", tip: "Byzantine water line" },
    barracks: { size: 12, glyph: "sword", badge: true, label: "barracks", tip: "Trains infantry" },
    range: { size: 12, glyph: "bow", badge: true, label: "archery range", tip: "Trains archers and crossbowmen" },
    stable: { size: 12, glyph: "horseshoe", badge: true, label: "stable", tip: "Trains cavalry" },
    workshop: { size: 12, glyph: "wheel", badge: true, label: "siege workshop", tip: "Builds siege engines" },
    dock: { size: 8, glyph: "sail", badge: true, label: "dock", tip: "Builds ships" },
    monastery: { size: 16, glyph: "cross", badge: true, label: "monastery", tip: "Trains monks, holds relics" },
    blacksmith: { size: 16, glyph: "anvil", badge: true, label: "blacksmith", tip: "Weapon and armour upgrades" },
    university: { size: 16, glyph: "book", badge: true, label: "university", tip: "Technology upgrades" },
    market: { size: 16, glyph: "bag", badge: true, label: "market", tip: "Buys and sells resources, trains traders" },
    mill: { size: 8, label: "mill", tip: "Villagers drop off food here" },
    lumber: { size: 8, label: "lumber camp", tip: "Villagers drop off wood here" },
    mining: { size: 8, label: "mining camp", tip: "Villagers drop off gold and stone here" },
    house: { size: 8, label: "house", tip: "Raises the population limit" },
    farm: { size: 8, label: "farm", tip: "Field worked by villagers for food" },
    other: { size: 6.5, label: "other building", tip: "Other building" },
  };
  const PLAN_DETAIL_PX = 24; // footprint side on screen from which plans show small props, drop shadows, full outline
  const BADGE_PX = 12;       // footprint side on screen from which kinds with `badge` show their pictogram
  // Map objects by kind (tools/convert.py GAIA_RULES): colour, world radius, factor for "small" blueprints, minimum
  // and maximum screen radius, legend text. `art`: screen radius from which the kind is drawn as its GAIA_ART
  // picture (an animal about as big as a unit figure, a rocky outcrop filling a mine) instead of its symbol. Mines
  // are half their square footprint (16, small ones 12) so walls and camps built against them touch them. Trees are
  // not drawn one by one: r is how close the pointer must be to hover one, crown the disc each stamps on the forest
  // mask (forestImage); "chopped" is the stump drawn on a tree whose wood has started to go. Symbol colours follow
  // the in-game minimap: dark forests, gold and grey mines, green bushes, white game. Key order is legend order.
  const GAIA_STYLE = {
    tree: { color: "#262d1c", r: 3.6, crown: 2.4, min: 1.6, max: Infinity, label: "forest", tip: "Trees: wood" },
    stealth: { color: "#3c4a29", r: 3.6, crown: 3.8, min: 1.6, max: Infinity, label: "stealth forest", tip: "Forest that hides the units inside it" },
    chopped: { color: "#e2b878", r: 1.4, min: 2.6, max: 6, label: "tree being chopped", tip: "A tree villagers are cutting; the light part shrinks as its wood runs out" },
    gold: { color: "#e8b62c", r: 8, small: 0.75, min: 3.5, max: Infinity, art: 30, label: "gold", tip: "Gold mine (number = gold left)" },
    stone: { color: "#b9bcc0", r: 8, small: 0.75, min: 3.5, max: Infinity, art: 30, label: "stone", tip: "Stone mine (number = stone left)" },
    berry: { color: "#5cb84a", r: 1.3, min: 2.2, max: 13, art: 8, label: "berries", tip: "Berry bushes: food" },
    fish: { color: "#38bdf8", r: 1.3, min: 2.2, max: 13, art: 8, label: "fish", tip: "Fish: food for fishing boats" },
    deer: { color: "#f2efe8", r: 1.0, min: 2.2, max: 12, art: 8, label: "deer", tip: "Animal to hunt for food" },
    boar: { color: "#c2410c", r: 1.5, min: 3.2, max: 14, art: 8, label: "boar", tip: "Animal to hunt for food; fights back" },
    wolf: { color: "#94a3b8", r: 1.1, min: 2.5, max: 12, art: 8, label: "wolf", tip: "Wild animal that attacks" },
    sheep: { color: "#f5f5f4", r: 0.9, min: 2.0, max: 13, art: 8, label: "sheep", tip: "Herd animal: food. Outlined in a player's colour once claimed" },
    relic: { color: "#fde68a", r: 1.6, min: 4.0, max: 12, art: 8, label: "relic", tip: "Monks carry relics to a monastery for gold" },
    sacred: { color: "#fbbf24", r: 6.0, min: 6.0, max: Infinity, art: 30, label: "sacred site", tip: "Holding it with a monk earns gold; drawn in the holder's colour once captured. A turning dashed ring and an arc show religious units taking it (30 s), a cream flash a capture; all sites pulse while one team holds them all" },
    trade: { color: "#d97706", r: 5.0, min: 4.0, max: Infinity, art: 25, label: "trade post", tip: "Traders bring goods here for gold" },
  };
  const TREES = ["tree", "stealth"];
  // Forests as the in-game minimap draws them: every standing tree stamps a disc (GAIA_STYLE crown) on a world-space
  // mask, which is blurred and cut at a soft alpha threshold, so dense woods fill in as one flat canopy with smooth
  // edges, small clumps shrink, lone trees all but vanish (they stay hoverable) and felled trees open clearings.
  const FOREST_PX = 4;              // mask pixels per world unit
  const FOREST_BLUR = 2.2;          // blur radius, world units
  const FOREST_CUT = [0.33, 0.45];  // blurred cover where the canopy starts to show and where it is solid
  // Canvas filter for the mask: CSS blur, then FOREST_CUT on alpha as an SVG table (a canvas has no other GPU alpha
  // threshold). The colour survives because all discs of a kind are filled in the same colour.
  let forestFilterCss = null;
  function forestFilter() {
    if (forestFilterCss) return forestFilterCss;
    const [a, b] = FOREST_CUT, table = [];
    for (let i = 0; i <= 64; i++) {
      const u = Math.min(1, Math.max(0, (i / 64 - a) / (b - a)));
      table.push((u * u * (3 - 2 * u)).toFixed(4));
    }
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.style.cssText = "position:absolute;width:0;height:0";
    svg.innerHTML = `<filter id="rvForestCut" color-interpolation-filters="sRGB"><feComponentTransfer>` +
      `<feFuncA type="table" tableValues="${table.join(" ")}"/></feComponentTransfer></filter>`;
    document.body.append(svg);
    return forestFilterCss = `blur(${FOREST_BLUR * FOREST_PX}px) url(#rvForestCut)`;
  }
  // Lines and marks, for the legend (markIcon draws them).
  const MARKS = {
    attack: { label: "attack", tip: "Line from attacker; the bright end with the arrow points at the target" },
    order: { label: "move order", tip: "Where a group was ordered to go (fades as the order gets older)" },
    trail: { label: "path", tip: "Where military units walked in the last few seconds" },
    death: { label: "death", tip: "A unit or building died here (fades after a few seconds)" },
    alert: { label: "under attack", tip: "A player's units or buildings came under enemy attack here: a pulsing ring in their colour for a few seconds, like the game's minimap alert" },
    convert: { label: "conversion", tip: "A monk converting: a ticked white ring at its reach while it channels, the enemy units in reach ringed in its colour; a burst in the new colour where a unit changed hands" },
    hp: { label: "health", tip: "Shown under damaged units and buildings" },
    ghost: { label: "last seen", tip: "Enemy building seen earlier but not visible now (Vision setting)" },
    fight: { label: "fight area", tip: "The fight picked in the Fights list" },
    fog: { label: "fog of war", tip: "Vision set to a player or team: dim = outside their sight now, black = never explored" },
  };
  const FOG_RES = 0.25;      // fog layer resolution relative to the screen; scaling it up softens the sight edges
  const FOG_DIM = 0.5;       // darkness of explored ground outside sight
  const FOG_DARK = 1;        // darkness of ground never explored (black, as in game)
  const TRAIL_S = 6;         // seconds of path behind moving military units
  const ORDER_FRESH = 8;     // seconds before a move-order line starts to fade
  const DEATH_FADE = 8;      // seconds a death mark stays
  const ALERT_R = 12;        // metres: radius of an under-attack ring (the game's is ~7 px on its minimap, about 12 m)
  const ALERT_PULSE = 2;     // seconds per swell of its glow (measured in game)
  const SITE_FLASH = 5;      // seconds a sacred site flashes after a capture (measured in game)
  const SITE_PULSE = 2.5;    // seconds per pulse while one team holds every site (2-3 s in game)
  const FLIP_FADE = 3;       // seconds the burst stays where a unit changed hands
  const HIGHLIGHT = "#fde047"; // drag box and the rings around what it highlighted
  const RELIEF_PX = 4;       // relief image pixels per height-grid cell
  const RELIEF_EXAG = 2.5;   // vertical exaggeration for hill shading
  const GROUND = "#685033";  // land colour where there is no height grid, and behind legend swatches
  // The map turns like the in-game minimap. A turn is the angle (radians, counter-clockwise) from world x/z (z north)
  // to the screen. DEFAULT_TURN, -45°, is the game's view: its cameras start at yaw 135° (instances/camera/
  // default_*.xml), with the world's north-west corner at the top. The compass (app.js) turns the map further.
  const DEFAULT_TURN = -Math.PI / 4;
  const turnReach = a => Math.abs(Math.cos(a)) + Math.abs(Math.sin(a)); // half-height of a turned square, per half-side

  function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // `hex` moved toward `to` by a (0..1), as #rrggbb; cached since villagers and attacks ask every frame.
  const mixCache = new Map();
  function mix(hex, to, a) {
    const key = hex + to + a;
    let out = mixCache.get(key);
    if (!out) {
      const p = parseInt(hex.slice(1), 16), q = parseInt(to.slice(1), 16);
      const ch = sh => Math.round(((p >> sh) & 255) * (1 - a) + ((q >> sh) & 255) * a);
      out = "#" + ((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0");
      mixCache.set(key, out);
    }
    return out;
  }

  function bsize(e) {
    return (BUILDING_TYPES[e.bkind] || BUILDING_TYPES.other).size;
  }

  // Health bar centred at cx with its top at y, w px wide.
  function hpBar(g, cx, y, w, frac) {
    g.fillStyle = "rgba(0,0,0,0.7)";
    g.fillRect(cx - w / 2 - 1, y - 1, w + 2, 4.5);
    g.fillStyle = frac > 0.5 ? "#4ade80" : frac > 0.25 ? "#facc15" : "#f87171";
    g.fillRect(cx - w / 2, y, w * Math.max(0, frac), 2.5);
  }

  class MapView {
    constructor(canvas, M, state) {
      this.c = canvas;
      this.g = canvas.getContext("2d");
      this.M = M;
      this.S = state;
      this.scale = 1;
      this.camX = 0;
      this.camZ = 0;
      this.hits = [];
      this.gaiaBy = new Map();
      for (const o of M.gaia) {
        if (!this.gaiaBy.has(o.kind)) this.gaiaBy.set(o.kind, []);
        this.gaiaBy.get(o.kind).push(o);
      }
      this.setTurn(DEFAULT_TURN);
      this.relief = M.terrain ? buildRelief(M.terrain, M.waterLevel, this.turn) : null;
      this.resize();
      this.fit();
      this.bindInput();
    }

    resize() {
      const r = this.c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      this.w = r.width; this.h = r.height;
      this.c.width = Math.round(r.width * dpr); this.c.height = Math.round(r.height * dpr);
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // Whole map in view: the world rectangle turned, a diamond when the world is square and the turn ±45°.
    fit() {
      const W = this.M.world.width, L = this.M.world.length, c = Math.abs(this.tc), s = Math.abs(this.ts);
      this.scale = Math.min(this.w / (W * c + L * s), this.h / (W * s + L * c)) * 0.95;
      this.camX = 0; this.camZ = 0;
    }

    // Turn the map to `a` radians (see DEFAULT_TURN) about the middle of the screen. The relief is lit from the
    // screen's upper left, so it is lit again once the turning stops.
    setTurn(a) {
      a = Math.atan2(Math.sin(a), Math.cos(a));
      this.turn = a; this.tc = Math.cos(a); this.ts = Math.sin(a);
      this.reach = turnReach(a);
      this.S.dirty = true;
      if (!this.relief) return;
      clearTimeout(this.relight);
      this.relight = setTimeout(() => {
        this.relief = buildRelief(this.M.terrain, this.M.waterLevel, this.turn);
        this.S.dirty = true;
      }, 150);
    }

    resetTurn() { this.setTurn(DEFAULT_TURN); }

    focus(x, z, radius) {
      this.camX = x; this.camZ = z;
      this.scale = Math.min(this.w, this.h) / (2 * Math.max(20, radius) * 1.6);
    }

    // World (x, z) -> screen: the offset from the camera turned, z up.
    sx(x, z) { return this.w / 2 + ((x - this.camX) * this.tc - (z - this.camZ) * this.ts) * this.scale; }
    sy(x, z) { return this.h / 2 - ((x - this.camX) * this.ts + (z - this.camZ) * this.tc) * this.scale; }
    // Screen -> world.
    wx(sx, sy) { return this.camX + ((sx - this.w / 2) * this.tc + (this.h / 2 - sy) * this.ts) / this.scale; }
    wz(sx, sy) { return this.camZ + ((this.h / 2 - sy) * this.tc - (sx - this.w / 2) * this.ts) / this.scale; }

    // Move the camera so the map shifts dx, dy screen pixels.
    pan(dx, dy) {
      const p = dx / this.scale, q = dy / this.scale;
      this.camX += q * this.ts - p * this.tc;
      this.camZ += p * this.ts + q * this.tc;
    }

    // Canvas transform from world units (z up) to screen pixels, times k (the fog layer is drawn at FOG_RES).
    worldTransform(g, k = 1) {
      g.translate(this.w / 2 * k, this.h / 2 * k);
      g.rotate(-this.turn);
      g.scale(this.scale * k, -this.scale * k);
      g.translate(-this.camX, -this.camZ);
    }

    // Wheel zooms about the pointer. Left-drag draws a box that highlights the units inside it (buildings when it
    // holds no units; S.highlight in app.js), left-click selects one thing, right- or middle-drag moves the map.
    bindInput() {
      let drag = null;
      const at = ev => { const r = this.c.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
      this.c.addEventListener("wheel", ev => {
        ev.preventDefault();
        const [mx, my] = at(ev), wx = this.wx(mx, my), wz = this.wz(mx, my);
        this.scale = Math.min(60, Math.max(0.3, this.scale * Math.exp(-ev.deltaY * 0.0015)));
        this.camX = wx; this.camZ = wz;
        this.pan(mx - this.w / 2, my - this.h / 2); // the point under the pointer stays there
        this.S.follow = false;
        this.S.dirty = true;
      }, { passive: false });
      this.c.addEventListener("contextmenu", ev => ev.preventDefault()); // right-drag moves the map
      this.c.addEventListener("mousedown", ev => {
        if (drag) return;
        if (ev.button === 1) ev.preventDefault(); // no autoscroll
        const [mx, my] = at(ev);
        drag = { button: ev.button, x: ev.clientX, y: ev.clientY, mx, my, cx: this.camX, cz: this.camZ, moved: false };
      });
      window.addEventListener("mousemove", ev => {
        const [mx, my] = at(ev);
        if (drag) {
          const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
          if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
          if (drag.moved && drag.button === 0) {
            this.box = { x0: drag.mx, y0: drag.my, x1: Math.min(this.w, Math.max(0, mx)), y1: Math.min(this.h, Math.max(0, my)) };
            this.S.dirty = true;
          } else if (drag.moved) {
            this.camX = drag.cx; this.camZ = drag.cz;
            this.pan(dx, dy);
            this.S.follow = false;
            this.S.dirty = true;
          }
        }
        const inside = ev.target === this.c && mx >= 0 && my >= 0 && mx <= this.w && my <= this.h; // not over panels
        const hover = inside ? this.pick(mx, my) : null;
        if (hover !== this.S.hover) { this.S.hover = hover; this.S.dirty = true; }
        this.S.mouse = inside ? { x: mx, y: my } : null;
      });
      window.addEventListener("mouseup", ev => {
        if (!drag || ev.button !== drag.button) return;
        if (drag.button === 0 && drag.moved && this.box) {
          const got = this.boxed(this.box), had = ev.shiftKey ? (this.S.group || (this.S.selected ? [this.S.selected] : [])) : [];
          this.S.highlight(had.length ? [...new Set([...had, ...got])] : got); // Shift+drag adds to the selection
          this.box = null;
          this.S.dirty = true;
        } else if (drag.button === 0 && !drag.moved && ev.target === this.c) {
          const [mx, my] = at(ev), hit = this.pick(mx, my), e = hit && hit.gaia ? null : hit; // map objects only get a hover tooltip
          if (e && ev.altKey) this.S.dropBp(e.bp);   // Alt+click: drop every selected one of its blueprint
          else if (e && ev.shiftKey) this.S.toggle(e); // Shift+click: add or drop it
          else this.S.select(e);
        }
        drag = null;
      });
    }

    // What a highlight box holds: the units drawn inside it in the last frame (so only what the Vision setting
    // shows), or its buildings when it holds no units.
    boxed(b) {
      const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1), y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
      const inside = this.hits.filter(h => !h.e.gaia && h.e.on && h.sx >= x0 && h.sx <= x1 && h.sy >= y0 && h.sy <= y1)
        .map(h => h.e);
      const units = inside.filter(e => e.cat !== "building");
      return [...new Set(units.length ? units : inside)];
    }

    pick(mx, my) {
      let best = null, bestD = 12;
      for (const h of this.hits) {
        const d = Math.hypot(h.sx - mx, h.sy - my) - h.r;
        if (d < bestD) { best = h.e; bestD = d; }
      }
      if (best || !this.S.showResources) return best;
      // Trees are not in `hits` (thousands per frame); look one up only when nothing else is under the pointer.
      const wx = this.wx(mx, my), wz = this.wz(mx, my);
      for (const kind of TREES) {
        const st = GAIA_STYLE[kind], r = Math.min(st.max, Math.max(st.min, st.r * this.scale)) / this.scale;
        for (const o of this.gaiaBy.get(kind) || []) {
          if (o.on && Math.abs(o.px - wx) <= r && Math.abs(o.pz - wz) <= r) return o;
        }
      }
      return null;
    }

    draw(t) {
      const g = this.g, M = this.M, S = this.S;
      // the shared FrameRenderState (frame.js) for t: selection and hover in, this frame's combat lists out
      const V = M.view;
      V.hoveredUnitId = S.hover ? S.hover.id : null;
      V.select(S.group ? Array.from(S.group, (e) => e.id) : S.selected ? [S.selected.id] : []);
      V.frame(t);
      if (S.follow && S.selected && S.selected.on) {
        this.camX = S.selected.px; this.camZ = S.selected.pz;
      }
      g.clearRect(0, 0, this.w, this.h);
      this.drawGround();
      this.hits = [];
      if (S.showResources) this.drawGaia();
      const mask = S.viewMask;
      const visible = [];
      const ghosts = [];
      for (const e of M.ents) {
        if (!e.on || e.cat === "attachment" || e.cat === "other") continue;
        if (RV.visibleTo(e, t, mask)) visible.push(e);
        else if (e.cat === "building" && RV.seenBefore(e, t, mask)) ghosts.push(e);
      }
      const shown = new Set(visible);
      for (const e of ghosts) this.drawBuilding(e, true);
      if (mask !== M.allMask) this.drawFog(t, mask);
      for (const e of visible) if (e.bkind === "farm") this.drawBuilding(e, false); // fields go under everything
      this.drawWalls(visible, shown);
      for (const e of visible) {
        if (e.cat === "building" && e.bkind !== "farm" && !BUILDING_TYPES[e.bkind].line) this.drawBuilding(e, false);
      }
      if (S.fight) this.drawFightRing(S.fight, t);
      if (S.showOrders) this.drawOrders(t, shown);
      if (S.showTrails) for (const e of visible) if (RV.isMilitary(e.cat)) this.drawTrail(e, t);
      if (S.showCams) this.drawCameras(t, mask);
      for (const e of visible) if (e.cat !== "building") this.drawUnit(e);
      if (S.showAttacks) this.drawAlerts(t, mask);
      if (S.showResources && M.sites.length) this.drawSites(t, mask);
      this.tallyOnScreen(visible);
      if (S.showAttacks) this.drawAttacks(t, mask);
      if (S.showFx) RV_FX.draw2d(this, t, mask);
      this.drawDeaths(t, mask);
      this.drawConversions(t, mask);
      if (S.group) this.drawHighlight(S.group, shown);
      if (S.selected && S.selected.on && shown.has(S.selected)) this.drawRing(S.selected, "#ffffff", 2);
      if (S.hover && S.hover.on && S.hover !== S.selected) this.drawRing(S.hover, "rgba(255,255,255,0.6)", 1);
      if (this.box) {
        const b = this.box, x = Math.min(b.x0, b.x1), y = Math.min(b.y0, b.y1), w = Math.abs(b.x1 - b.x0), h = Math.abs(b.y1 - b.y0);
        g.fillStyle = "rgba(253,224,71,0.08)"; g.fillRect(x, y, w, h);
        g.strokeStyle = HIGHLIGHT; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, w, h);
      }
    }

    // Rings around highlighted units (close to the icon, so a crowd stays readable) and buildings, in one path: a
    // dark casing under the HIGHLIGHT colour so they show on any ground.
    drawHighlight(group, shown) {
      const g = this.g, p = new Path2D();
      for (const e of group) {
        if (!e.on || !shown.has(e)) continue;
        const x = this.sx(e.px, e.pz), y = this.sy(e.px, e.pz);
        const r = e.cat === "building" ? Math.max(4, bsize(e) * this.scale) * 0.75 : this.unitRadius(e) * 1.2 + 2;
        if (x < -r || y < -r || x > this.w + r || y > this.h + r) continue;
        p.moveTo(x + r, y); p.arc(x, y, r, 0, Math.PI * 2);
      }
      g.strokeStyle = CASING; g.lineWidth = 3; g.stroke(p);
      g.strokeStyle = HIGHLIGHT; g.lineWidth = 1.5; g.stroke(p);
    }

    // Fog of war for the players in mask: unexplored ground FOG_DARK, explored ground FOG_DIM, and the sight circles
    // (model.js sightOf) of their units and buildings clear. Drawn over the ground, map objects and last-seen
    // buildings; what the players see now is drawn after it.
    drawFog(t, mask) {
      const fw = Math.ceil(this.w * FOG_RES), fh = Math.ceil(this.h * FOG_RES), k = this.scale * FOG_RES;
      if (!this.fog || this.fog.width !== fw || this.fog.height !== fh) {
        this.fog = document.createElement("canvas");
        this.fog.width = fw; this.fog.height = fh;
        this.fogG = this.fog.getContext("2d");
      }
      const f = this.fogG, ex = this.exploredImage(t, mask);
      f.globalCompositeOperation = "copy";
      f.fillStyle = `rgba(0,0,0,${FOG_DIM})`;
      f.fillRect(0, 0, fw, fh);
      f.globalCompositeOperation = "source-over";
      f.imageSmoothingEnabled = true;
      f.save();
      this.worldTransform(f, FOG_RES);
      f.translate(ex.x0, ex.z1);
      f.scale(1, -1); // the image is north up
      f.drawImage(ex.canvas, 0, 0, ex.w, ex.h);
      f.restore();
      f.globalCompositeOperation = "destination-out";
      f.beginPath();
      for (const e of this.M.ents) {
        if (!e.on || !e.sight || !((1 << (e.pown - 1)) & mask)) continue;
        const x = this.sx(e.px, e.pz) * FOG_RES, y = this.sy(e.px, e.pz) * FOG_RES, r = e.sight * k;
        if (x < -r || y < -r || x > fw + r || y > fh + r) continue;
        f.moveTo(x + r, y);
        f.arc(x, y, r, 0, Math.PI * 2);
      }
      f.fill();
      f.globalCompositeOperation = "source-over";
      this.g.imageSmoothingEnabled = true;
      this.g.drawImage(this.fog, 0, 0, fw / FOG_RES, fh / FOG_RES);
    }

    // The never-explored cells of RV.explored as a small image (one pixel per cell, north up), opaque enough that over
    // the FOG_DIM layer they reach FOG_DARK; redrawn only when the number of explored cells changes.
    exploredImage(t, mask) {
      const E = RV.explored(this.M, mask);
      let ex = this.ex;
      if (!ex || ex.grid !== E) {
        const canvas = document.createElement("canvas");
        canvas.width = E.cols; canvas.height = E.rows;
        const g = canvas.getContext("2d"), img = g.createImageData(E.cols, E.rows);
        ex = this.ex = { grid: E, canvas, g, img, px: new Uint32Array(img.data.buffer), n: -1,
          x0: E.x0, z1: E.z0 + E.rows * E.cell, w: E.cols * E.cell, h: E.rows * E.cell };
      }
      const n = RV.idxAt(E.times, t) + 1;
      if (ex.n !== n) {
        const a = Math.round(255 * (1 - (1 - FOG_DARK) / (1 - FOG_DIM))), dark = (a << 24) >>> 0; // black, alpha a
        const { first, cols, rows } = E;
        for (let r = 0; r < rows; r++) {
          const src = r * cols, dst = (rows - 1 - r) * cols;
          for (let c = 0; c < cols; c++) ex.px[dst + c] = first[src + c] > t ? dark : 0;
        }
        ex.g.putImageData(ex.img, 0, 0);
        ex.n = n;
      }
      return ex;
    }

    // Ground, relief, contours, shoreline, a faint 64 m (16 m close up) grid and the map's edge, in world space.
    drawGround() {
      const g = this.g, W = this.M.world.width, L = this.M.world.length, R = this.relief;
      g.save();
      this.worldTransform(g);
      g.lineWidth = 1 / this.scale;
      g.fillStyle = GROUND;
      g.fillRect(-W / 2, -L / 2, W, L);
      if (R && this.S.showTerrain) {
        g.imageSmoothingEnabled = true;
        g.save();
        g.translate(R.xmin, R.zmax);
        g.scale(1, -1); // the image is north up
        g.drawImage(R.canvas, 0, 0, R.width, R.length);
        g.restore();
        g.strokeStyle = "rgba(40,26,12,0.22)";
        g.stroke(R.contours);
        if (R.shore) {
          g.strokeStyle = "rgba(170,225,240,0.6)";
          g.stroke(R.shore);
        }
      }
      const step = this.scale > 4 ? 16 : 64;
      g.strokeStyle = "rgba(0,0,0,0.07)";
      g.beginPath();
      for (let v = -W / 2; v <= W / 2; v += step) { g.moveTo(v, -L / 2); g.lineTo(v, L / 2); }
      for (let v = -L / 2; v <= L / 2; v += step) { g.moveTo(-W / 2, v); g.lineTo(W / 2, v); }
      g.stroke();
      g.strokeStyle = "rgba(214,178,110,0.85)";
      g.lineWidth = 1.5 / this.scale;
      g.strokeRect(-W / 2, -L / 2, W, L);
      g.restore();
    }

    // Forests from the world-space mask (forestImage) with a stump on each tree being chopped, then every other map
    // object individually. All are hoverable (standing trees through pick).
    drawGaia() {
      const g = this.g;
      g.font = "10px system-ui";
      if (TREES.some(kind => this.gaiaBy.has(kind))) {
        const W = this.M.world.width, L = this.M.world.length, cv = this.forestImage();
        g.save();
        this.worldTransform(g);
        g.translate(-W / 2, L / 2);
        g.scale(1, -1); // the image is north up
        g.drawImage(cv, 0, 0, W, L);
        g.restore();
        for (const kind of TREES) {
          for (const o of this.gaiaBy.get(kind) || []) {
            if (o.on && o.amT && o.amount < o.amount0) this.drawGaiaObject(o, GAIA_STYLE.chopped, "chopped");
          }
        }
      }
      for (const [kind, list] of this.gaiaBy) {
        const st = GAIA_STYLE[kind];
        if (!st || TREES.includes(kind)) continue;
        for (const o of list) if (o.on) this.drawGaiaObject(o, st, kind);
      }
    }

    // The forest canopy of the standing trees, FOREST_PX per world unit, north up: one filtered fill of all crowns per
    // kind, stealth forest over normal forest. Rebuilt only when the standing trees change (felling, seeking).
    forestImage() {
      let n = 0, hash = 0;
      for (const kind of TREES) {
        const list = this.gaiaBy.get(kind) || [];
        for (let i = 0; i < list.length; i++) if (list[i].on) { n++; hash = (hash * 31 + i) | 0; }
        hash = (hash * 31 + 7) | 0; // kind separator
      }
      const key = n + ":" + hash, f = this.forest;
      if (f && f.key === key) return f.cv;
      const W = this.M.world.width, L = this.M.world.length, cv = f ? f.cv : document.createElement("canvas");
      if (!f) { cv.width = Math.ceil(W * FOREST_PX); cv.height = Math.ceil(L * FOREST_PX); }
      const fg = cv.getContext("2d");
      fg.clearRect(0, 0, cv.width, cv.height);
      fg.filter = forestFilter();
      for (const kind of TREES) {
        const st = GAIA_STYLE[kind], cr = st.crown * FOREST_PX, path = new Path2D();
        for (const o of this.gaiaBy.get(kind) || []) {
          if (!o.on) continue;
          const x = (o.px + W / 2) * FOREST_PX, y = (L / 2 - o.pz) * FOREST_PX;
          path.moveTo(x + cr, y);
          path.arc(x, y, cr, 0, Math.PI * 2);
        }
        fg.fillStyle = st.color;
        fg.fill(path);
      }
      this.forest = { key, cv };
      return cv;
    }

    drawGaiaObject(o, st, kind) {
      const g = this.g, x = this.sx(o.px, o.pz), y = this.sy(o.px, o.pz);
      const r = Math.min(st.max, Math.max(st.min, st.r * (/small|sml/.test(o.bp) ? st.small || 0.7 : 1) * this.scale));
      const reach = 1.5 * r + 12; // turned footprints, wide animals and the amount label stick out of r
      if (x < -reach || y < -reach || x > this.w + reach || y > this.h + reach) return;
      const holder = o.holder ? this.M.playerByIdx.get(o.holder) : null;
      paintGaia(g, x, y, r, kind, o.amount0 > 0 ? Math.max(0, o.amount) / o.amount0 : 1, holder && holder.color, this.turn,
        r >= st.art);
      if ((o.kind === "gold" || o.kind === "stone") && this.scale > 3 && o.amount > 0) {
        // under the pile, inside the footprint: walls and camps built against the mine cover anything outside
        const s = o.amount >= 1000 ? (o.amount / 1000).toFixed(1) + "k" : String(Math.round(o.amount));
        const ly = y + Math.min(mineIconR(r) + 11, r * this.reach - 6);
        g.textAlign = "center"; g.lineWidth = 3; g.strokeStyle = CASING; g.fillStyle = "rgba(255,255,255,0.9)";
        g.strokeText(s, x, ly); g.fillText(s, x, ly);
        g.textAlign = "start";
      }
      this.hits.push({ e: o, sx: x, sy: y, r });
    }

    color(e) {
      const p = this.M.playerByIdx.get(e.pown);
      return p ? p.color : "#9ca3af";
    }

    drawBuilding(e, ghost) {
      const bt = BUILDING_TYPES[e.bkind] || BUILDING_TYPES.other;
      const g = this.g, x = this.sx(e.px, e.pz), y = this.sy(e.px, e.pz), s = Math.max(4, bt.size * this.scale);
      if (x < -s || y < -s || x > this.w + s || y > this.h + s) return;
      const quarter = e.bkind === "dock" ? dockQuarter(this.M, e) : 0;
      drawPlan(g, x, y, s, e.bkind, this.color(e), ghost, this.turn, this.scale, quarter);
      if (ghost) return;
      const frac = e.maxhp > 0 ? e.php / e.maxhp : 1;
      if (frac < 0.999 && s >= 6 && e.bkind !== "farm") hpBar(g, x, y + s / 2 * this.reach + 3, s, frac);
      this.hits.push({ e, sx: x, sy: y, r: s / 2 });
    }

    // Walls, gates and aqueducts: a line between neighbouring pieces (model.js wallLinks), batched per colour, then
    // each piece as a node (towers on walls bigger, gates as an opening along the wall) so lone pieces still show and
    // can be hovered.
    drawWalls(visible, shown) {
      const g = this.g, L = this.M.wallLinks, w = Math.min(7, Math.max(2.5, 1.1 * this.scale)), paths = new Map();
      for (let i = 0; i < L.length; i += 2) {
        const a = L[i], b = L[i + 1];
        if (!shown.has(a) || !shown.has(b)) continue;
        const key = this.color(a) + (a.bkind === "aqueduct" ? "~" : "");
        let p = paths.get(key);
        if (!p) paths.set(key, p = new Path2D());
        p.moveTo(this.sx(a.px, a.pz), this.sy(a.px, a.pz));
        p.lineTo(this.sx(b.px, b.pz), this.sy(b.px, b.pz));
      }
      g.lineCap = "round";
      for (const [key, p] of paths) {
        const aq = key.endsWith("~"), col = aq ? key.slice(0, -1) : key;
        g.strokeStyle = CASING; g.lineWidth = w + 2; g.stroke(p);
        g.strokeStyle = aq ? mix(col, "#7dd3fc", 0.55) : col; g.lineWidth = w; g.stroke(p);
      }
      g.lineCap = "butt";
      for (const e of visible) {
        if (e.cat !== "building" || !BUILDING_TYPES[e.bkind].line) continue;
        const x = this.sx(e.px, e.pz), y = this.sy(e.px, e.pz);
        if (x < -20 || y < -20 || x > this.w + 20 || y > this.h + 20) continue;
        const gate = e.bkind === "gate";
        const s = gate ? Math.min(26, Math.max(12, 5 * this.scale))
          : e.bp.includes("bastion") ? Math.min(16, Math.max(w + 4, 3 * this.scale)) : w + 1;
        if (gate) paintGate(g, x, y, s, w, (e.wallAng || 0) - this.turn, this.color(e)); // wallAng is for an unturned map
        else paintWallNode(g, x, y, s, e.bkind, this.color(e), this.turn);
        const frac = e.maxhp > 0 ? e.php / e.maxhp : 1;
        if (frac < 0.999 && this.scale > 2) hpBar(g, x, y + s / 2 + 3, Math.max(8, s), frac);
        this.hits.push({ e, sx: x, sy: y, r: Math.max(3, s / 2) });
      }
    }

    // Screen radius: grows with zoom, then ever more slowly up to UNIT_MAX_R, so close-ups pull crowds apart.
    unitRadius(e) {
      const ty = UNIT_TYPES[e.type], wr = (ty && ty.wr) || UNIT_RADIUS[e.cat] || 1.3;
      const min = e.cat === "villager" || e.cat === "livestock" ? 2 : this.scale >= 3 ? ARMY_MIN_R : 3.2;
      let r = wr * this.scale;
      if (r > 8) r = 8 + Math.sqrt(r - 8) * 1.5;
      return Math.max(min, Math.min(UNIT_MAX_R * Math.max(1, wr / 1.3), r));
    }

    // Army units and villagers inside the view per owner and unit name, for the "On screen" panel (app.js renderComp).
    tallyOnScreen(visible) {
      const comp = new Map();
      for (const e of visible) {
        if (!e.type || (e.type !== "villager" && !RV.isMilitary(e.cat))) continue;
        const x = this.sx(e.px, e.pz), y = this.sy(e.px, e.pz);
        if (x < 0 || y < 0 || x > this.w || y > this.h) continue;
        let m = comp.get(e.pown);
        if (!m) comp.set(e.pown, m = new Map());
        const c = m.get(e.pname);
        if (c) { c.n++; c.value += e.value; } else m.set(e.pname, { n: 1, type: e.type, value: e.value });
      }
      this.onScreen = comp;
    }

    drawUnit(e) {
      const g = this.g, x = this.sx(e.px, e.pz), y = this.sy(e.px, e.pz), r = this.unitRadius(e), col = this.color(e);
      const m = r * 1.5 + 12; // figures reach about 1.3 r sideways; pips and bars a little more
      if (x < -m || y < -m || x > this.w + m || y > this.h + m) return;
      stampUnit(g, x, y, r, e.type, e.cat, col);
      if (r >= PIP_R && e.ptier && RV.isMilitary(e.cat)) tierPips(g, x, y - unitReach(e.type, r) - 2, r, e.ptier);
      const frac = e.maxhp > 0 ? e.php / e.maxhp : 1;
      if (frac < 0.999 && e.cat !== "livestock") hpBar(g, x, y + unitReach(e.type, r, true) + 1, Math.max(8, 2 * r), frac);
      if (this.S.showLabels && this.scale > 5 && RV.isMilitary(e.cat)) {
        g.fillStyle = "rgba(255,255,255,0.8)";
        g.font = "10px system-ui";
        g.fillText(e.pname, x + r * 1.3 + 3, y + 3);
      }
      this.hits.push({ e, sx: x, sy: y, r });
    }

    drawRing(e, color, width) {
      const g = this.g, x = this.sx(e.px, e.pz), y = this.sy(e.px, e.pz);
      const r = e.cat === "building" ? Math.max(4, bsize(e) * this.scale) * 0.75 : this.unitRadius(e) * 1.3 + 4;
      g.strokeStyle = color; g.lineWidth = width;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
    }

    // Path over the last TRAIL_S seconds, skipped for units that stayed in place (fighting jitter).
    drawTrail(e, t) {
      const g = this.g, i1 = RV.idxAt(e.t, t);
      if (i1 < 1) return;
      const i0 = Math.max(0, RV.idxAt(e.t, t - TRAIL_S));
      if (Math.hypot(e.px - e.x[i0], e.pz - e.z[i0]) < 2.5) return;
      g.strokeStyle = rgba(this.color(e), 0.25);
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(this.sx(e.x[i0], e.z[i0]), this.sy(e.x[i0], e.z[i0]));
      for (let i = i0 + 1; i <= i1; i++) g.lineTo(this.sx(e.x[i], e.z[i]), this.sy(e.x[i], e.z[i]));
      g.lineTo(this.sx(e.px, e.pz), this.sy(e.px, e.pz));
      g.stroke();
    }

    // The ground each player's screen showed (the replay's camera records), outlined in the player's colour, for the
    // players the vision choice covers.
    drawCameras(t, mask) {
      const g = this.g, M = this.M;
      for (const [idx, cam] of M.cameras) {
        const p = M.playerByIdx.get(idx), c = p && (mask & (1 << (idx - 1))) ? RV.cameraAt(cam, t) : null;
        if (!c) continue;
        const { corners, centre } = RV.viewFootprint(c, M.terrain);
        g.beginPath();
        corners.forEach(([x, z], i) => (i ? g.lineTo : g.moveTo).call(g, this.sx(x, z), this.sy(x, z)));
        g.closePath();
        g.fillStyle = rgba(p.color, 0.06);
        g.fill();
        g.strokeStyle = rgba(p.color, 0.85);
        g.lineWidth = 1.5;
        g.stroke();
        g.fillStyle = rgba(p.color, 0.85);
        g.beginPath();
        g.arc(this.sx(centre[0], centre[1]), this.sy(centre[0], centre[1]), 3, 0, 2 * Math.PI);
        g.fill();
      }
    }

    // Dashed line from each squad to its current move target, ending in a small target ring (military only, one per
    // spot). Hidden once the squad is there; orders older than ORDER_FRESH seconds fade to a quarter.
    drawOrders(t, shown) {
      const g = this.g, M = this.M, marks = new Set();
      g.setLineDash([4, 4]);
      g.lineWidth = 1;
      for (const [sid, members] of M.squads) {
        const lead = members.find(m => m.on && shown.has(m));
        if (!lead || !RV.isUnit(lead.cat) || lead.cat === "livestock") continue;
        const o = RV.orderAt(M, sid, t);
        if (!o) continue;
        const military = RV.isMilitary(lead.cat);
        if (!military && !this.S.showEcoOrders) continue;
        const lx = this.sx(lead.px, lead.pz), ly = this.sy(lead.px, lead.pz), x = this.sx(o.x, o.z), y = this.sy(o.x, o.z);
        if (Math.abs(x - lx) + Math.abs(y - ly) < 8) continue;
        const age = t - o.since, fade = age > ORDER_FRESH ? Math.max(0.3, 1 - (age - ORDER_FRESH) / 12) : 1;
        g.strokeStyle = rgba(this.color(lead), (military ? 0.55 : 0.25) * fade);
        g.beginPath(); g.moveTo(lx, ly); g.lineTo(x, y); g.stroke();
        const spot = Math.round(x / 12) + "," + Math.round(y / 12);
        if (!military || marks.has(spot)) continue;
        marks.add(spot);
        g.setLineDash([]);
        g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.stroke();
        g.fillStyle = g.strokeStyle;
        g.beginPath(); g.arc(x, y, 1.2, 0, Math.PI * 2); g.fill();
        g.setLineDash([4, 4]);
      }
      g.setLineDash([]);
    }

    // Attacker -> target (FrameRenderState engagement lines): faint line, bright last stretch and an arrowhead touching
    // the target; batched per colour. With S.showHeat the colour is the target choice instead (RV_FIGHTPANEL.HEAT_COLOR
    // by the line's priority grade: green good, yellow ok, red poor).
    drawAttacks(t, mask) {
      const g = this.g, M = this.M, paths = new Map(), heat = this.S.showHeat && window.RV_FIGHTPANEL;
      for (const l of M.view.activeEngagementLines) {
        const a = M.byId.get(l.unitId), b = M.byId.get(l.targetId);
        if (!a || !b || !a.on || !b.on) continue;
        if (!RV.visibleTo(a, t, mask) && !RV.visibleTo(b, t, mask)) continue;
        if (b.cat === "livestock") continue;
        const x0 = this.sx(a.px, a.pz), y0 = this.sy(a.px, a.pz), x1 = this.sx(b.px, b.pz), y1 = this.sy(b.px, b.pz);
        const len = Math.hypot(x1 - x0, y1 - y0), rb = b.cat === "building" ? 0 : this.unitRadius(b) + 1;
        if (len < rb + 6) continue;
        const ux = (x1 - x0) / len, uy = (y1 - y0) / len, tx = x1 - ux * rb, ty = y1 - uy * rb;
        const bl = Math.min((len - rb) * 0.4, 28), col = heat ? heat.HEAT_COLOR[l.grade] || heat.HEAT_COLOR.ok : this.color(a);
        let p = paths.get(col);
        if (!p) paths.set(col, p = { faint: new Path2D(), bold: new Path2D(), head: new Path2D() });
        p.faint.moveTo(x0, y0); p.faint.lineTo(tx - ux * bl, ty - uy * bl);
        p.bold.moveTo(tx - ux * bl, ty - uy * bl); p.bold.lineTo(tx - ux * 4, ty - uy * 4);
        p.head.moveTo(tx, ty);
        p.head.lineTo(tx - ux * 6 - uy * 3, ty - uy * 6 + ux * 3);
        p.head.lineTo(tx - ux * 6 + uy * 3, ty - uy * 6 - ux * 3);
        p.head.closePath();
      }
      for (const [col, p] of paths) {
        const hot = mix(col, "#ffffff", 0.35);
        g.strokeStyle = rgba(col, 0.3); g.lineWidth = 1; g.stroke(p.faint);
        g.strokeStyle = hot; g.lineWidth = 1.8; g.stroke(p.bold);
        g.fillStyle = hot; g.fill(p.head);
      }
    }

    // Under-attack alerts (model.js prepAlerts) in the attacked player's colour, drawn like the game's minimap: a
    // ring of ALERT_R m with a glow that swells to three times its size every ALERT_PULSE s, for ALERT_S s. Shown for
    // the players in the Vision setting and their allies, as the game shows its viewer's and allies' alerts.
    drawAlerts(t, mask) {
      const M = this.M, g = this.g, tau = Math.PI * 2;
      let teams = 0;
      for (const p of M.d.players) if ((1 << (p.idx - 1)) & mask) teams |= M.teamMask.get(p.team);
      const r = Math.min(40, Math.max(9, ALERT_R * this.scale));
      for (let i = RV.idxAt(M.alertT, t); i >= 0 && t - M.alertT[i] < RV.ALERT_S; i--) {
        const al = M.alerts[i];
        if (!((1 << (al.owner - 1)) & teams)) continue;
        const x = this.sx(al.x, al.z), y = this.sy(al.x, al.z), col = M.playerByIdx.get(al.owner)?.color || "#ef4444";
        const age = t - al.t, fade = Math.min(1, RV.ALERT_S - age), p = (age % ALERT_PULSE) / ALERT_PULSE;
        const rg = r * (1 + 2 * p), glow = g.createRadialGradient(x, y, 0, x, y, rg);
        glow.addColorStop(0, rgba(col, 0.45 * (1 - p) * fade)); glow.addColorStop(1, rgba(col, 0));
        g.fillStyle = glow; g.beginPath(); g.arc(x, y, rg, 0, tau); g.fill();
        g.strokeStyle = `rgba(11,14,20,${0.7 * fade})`; g.lineWidth = 4;
        g.beginPath(); g.arc(x, y, r, 0, tau); g.stroke();
        g.strokeStyle = rgba(col, fade); g.lineWidth = 2; g.stroke();
      }
    }

    // Sacred-site states, drawn like the game's minimap (measured on aoe4_256829909): SITE_FLASH s of a swelling cream
    // glow ringed in the new holder's colour after a capture (13:39-13:44); while religious units take a site (model.js
    // siteState), a turning dashed ring in their colour over a dark halo, plus a progress arc ours alone shows; and
    // while one team holds every site, all of them pulse in its colour (from 25:37).
    drawSites(t, mask) {
      const M = this.M, g = this.g, tau = Math.PI * 2, st = GAIA_STYLE.sacred;
      const r = Math.min(st.max, Math.max(st.min, st.r * this.scale)) + 3;
      const color = idx => M.playerByIdx.get(idx)?.color || "#ffffff";
      const teamOf = idx => M.playerByIdx.get(idx)?.team;
      const all = M.sites.every(o => o.holder && teamOf(o.holder) === teamOf(M.sites[0].holder));
      for (const o of M.sites) {
        if (!o.on) continue;
        const x = this.sx(o.px, o.pz), y = this.sy(o.px, o.pz);
        if (all) {
          const p = (t % SITE_PULSE) / SITE_PULSE, rg = r * (1.2 + 1.3 * p);
          const glow = g.createRadialGradient(x, y, r * 0.8, x, y, rg);
          glow.addColorStop(0, rgba(color(o.holder), 0.55 * (1 - p))); glow.addColorStop(1, rgba(color(o.holder), 0));
          g.fillStyle = glow; g.beginPath(); g.arc(x, y, rg, 0, tau); g.fill();
        }
        const ci = RV.idxAt(o.capT, t);
        const cap = ci >= 0 ? o.caps[ci] : null;
        if (cap && t - cap.t < SITE_FLASH) {
          const age = t - cap.t, p = (age % 1.25) / 1.25, fade = Math.min(1, SITE_FLASH - age), rg = r * (1.1 + 1.6 * p);
          const glow = g.createRadialGradient(x, y, r * 0.6, x, y, rg);
          glow.addColorStop(0, `rgba(254,243,199,${0.8 * fade})`); glow.addColorStop(1, "rgba(254,243,199,0)");
          g.fillStyle = glow; g.beginPath(); g.arc(x, y, rg, 0, tau); g.fill();
          g.strokeStyle = rgba(color(cap.owner), fade * (1 - p)); g.lineWidth = 3;
          g.beginPath(); g.arc(x, y, rg, 0, tau); g.stroke();
        }
        const s = RV.siteState(M, o, t);
        if (!s || (!((1 << (s.capturer - 1)) & mask) && !RV.visibleTo(s.unit, t, mask))) continue;
        const col = color(s.capturer), rr = r * 1.45, halo = 0.35 + 0.25 * Math.sin((t / 1.5) * tau);
        const dark = g.createRadialGradient(x, y, r * 0.7, x, y, rr * 1.2);
        dark.addColorStop(0, `rgba(11,14,20,${halo})`); dark.addColorStop(1, "rgba(11,14,20,0)");
        g.fillStyle = dark; g.beginPath(); g.arc(x, y, rr * 1.2, 0, tau); g.fill();
        g.setLineDash([rr * 0.5, rr * 0.28]); g.lineDashOffset = -t * rr * 0.6;
        g.strokeStyle = "rgba(255,255,255,0.9)"; g.lineWidth = 3.5;
        g.beginPath(); g.arc(x, y, rr, 0, tau); g.stroke();
        g.strokeStyle = col; g.lineWidth = 2; g.stroke();
        g.setLineDash([]); g.lineDashOffset = 0;
        if (!s.contested) {
          g.strokeStyle = col; g.lineWidth = 3;
          g.beginPath(); g.arc(x, y, rr + 4, -Math.PI / 2, -Math.PI / 2 + s.progress * tau); g.stroke();
        }
      }
    }

    // Deaths in the last DEATH_FADE seconds: an X in the victim's colour with a dark outline.
    drawDeaths(t, mask) {
      const M = this.M, g = this.g;
      const hi = RV.idxAt(M.killT, t);
      for (let i = hi; i >= 0 && t - M.killT[i] < DEATH_FADE; i--) {
        const k = M.kills[i], e = M.byId.get(k.victim);
        if (!e || e.cat === "livestock" || e.cat === "attachment") continue;
        if (!((1 << (e.owner - 1)) & mask) && !RV.visibleTo(e, k.t - 0.5, mask)) continue;
        const j = Math.max(0, RV.idxAt(e.t, k.t));
        paintCross(g, this.sx(e.x[j], e.z[j]), this.sy(e.x[j], e.z[j]), 4.5, this.color(e), 1 - (t - k.t) / DEATH_FADE);
      }
    }

    // Conversions (model.js prepConversions), drawn like the game's ring: while the monk channels, a white ring with
    // tick marks at CONVERT_R around it over a glow in its colour, and a ring in its colour around each target still
    // alive. Then FLIP_FADE s of an expanding double ring in the new owner's colour wherever a unit changed hands.
    drawConversions(t, mask) {
      const M = this.M, g = this.g, tau = Math.PI * 2;
      for (const cv of M.conversions) {
        if (cv.t > t) break;
        if (t >= cv.end) continue;
        const c = cv.caster;
        if (!((1 << (cv.owner - 1)) & mask) && !RV.visibleTo(c, t, mask)) continue;
        const j = Math.max(0, RV.idxAt(c.t, t)), x = this.sx(c.x[j], c.z[j]), y = this.sy(c.x[j], c.z[j]);
        const col = M.playerByIdx.get(cv.owner)?.color || "#ffffff", r = Math.max(8, RV.CONVERT_R * this.scale);
        const a = Math.min(1, (t - cv.t) / 0.3);
        const glow = g.createRadialGradient(x, y, r * 0.7, x, y, r * 1.08);
        glow.addColorStop(0, rgba(col, 0)); glow.addColorStop(0.75, rgba(col, 0.35 * a)); glow.addColorStop(1, rgba(col, 0));
        g.fillStyle = glow;
        g.beginPath(); g.arc(x, y, r * 1.08, 0, tau); g.fill();
        g.strokeStyle = `rgba(11,14,20,${0.6 * a})`; g.lineWidth = 3.5;
        g.beginPath(); g.arc(x, y, r, 0, tau); g.stroke();
        g.strokeStyle = `rgba(255,255,255,${0.95 * a})`; g.lineWidth = 1.5;
        g.beginPath(); g.arc(x, y, r, 0, tau);
        const ticks = r > 40 ? 48 : 24;
        for (let i = 0; i < ticks; i++) {
          const ang = (i / ticks) * tau, len = (i % 4 === 0 ? 0.16 : 0.08) * Math.min(r, 60);
          g.moveTo(x + Math.cos(ang) * r, y + Math.sin(ang) * r);
          g.lineTo(x + Math.cos(ang) * (r + len), y + Math.sin(ang) * (r + len));
        }
        g.stroke();
        g.setLineDash([3, 2]); g.strokeStyle = col; g.lineWidth = 1.5;
        for (const { e, flip } of cv.targets) {
          if (!RV.alive(e, t) || (flip != null && flip <= t)) continue;
          const k = Math.max(0, RV.idxAt(e.t, t));
          g.beginPath(); g.arc(this.sx(e.x[k], e.z[k]), this.sy(e.x[k], e.z[k]), this.unitRadius(e) + 3, 0, tau); g.stroke();
        }
        g.setLineDash([]);
      }
      for (const f of M.flips) {
        if (f.t > t) break;
        const age = t - f.t;
        if (age >= FLIP_FADE || !RV.alive(f.e, t)) continue;
        if (!(((1 << (f.to - 1)) | (1 << (f.from - 1))) & mask) && !RV.visibleTo(f.e, t, mask)) continue;
        const k = Math.max(0, RV.idxAt(f.e.t, t)), x = this.sx(f.e.x[k], f.e.z[k]), y = this.sy(f.e.x[k], f.e.z[k]);
        const col = M.playerByIdx.get(f.to)?.color || "#ffffff", a = 1 - age / FLIP_FADE, r0 = this.unitRadius(f.e) + 3;
        for (const off of [0, 0.35]) {
          const p = ((age / 1.2) + off) % 1;
          g.strokeStyle = rgba(col, a * (1 - p)); g.lineWidth = 2.5;
          g.beginPath(); g.arc(x, y, r0 + p * 14, 0, tau); g.stroke();
        }
      }
    }

    // The selected fight: orange dashed circle labelled with its number (sacred sites are solid gold rings).
    drawFightRing(f, t) {
      const g = this.g, active = t >= f.start - 3 && t <= f.end + 3, x = this.sx(f.x, f.z), y = this.sy(f.x, f.z);
      const r = f.radius * this.scale, col = active ? "rgba(251,146,60,0.95)" : "rgba(251,146,60,0.45)";
      g.setLineDash([8, 5]);
      g.strokeStyle = col;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
      const label = `Fight #${f.id}`;
      g.font = "bold 11px system-ui";
      const w = g.measureText(label).width + 10, ly = Math.max(10, y - r);
      g.fillStyle = "rgba(10,12,16,0.85)";
      g.fillRect(x - w / 2, ly - 9, w, 17);
      g.fillStyle = col;
      g.fillText(label, x - w / 2 + 5, ly + 4);
    }
  }

  // Shaded relief from the recorder's height grid, in the in-game minimap's colours: tan land, darker brown in the
  // hollows and lighter sand on the heights, with hill shading lit from the screen's upper left; rendered once at
  // RELIEF_PX pixels per cell and scaled with the map, plus contour lines as a world-space Path2D. Below `water`
  // (model.js waterLevel, null on dry maps) cells are blue, light in the shallows, with a shoreline path.
  function buildRelief(T, water, turn) {
    const { cols, rows, step, h, x0, z0 } = T, K = RELIEF_PX, W = cols * K, H = rows * K;
    let lo = Infinity, hi = -Infinity;
    for (const v of h) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const landLo = water != null ? Math.max(lo, water) : lo, span = Math.max(0.5, hi - landLo);
    const at = (fx, fz) => {
      fx = Math.min(cols - 1, Math.max(0, fx)); fz = Math.min(rows - 1, Math.max(0, fz));
      const c = Math.min(cols - 2, Math.floor(fx)), r = Math.min(rows - 2, Math.floor(fz)), ax = fx - c, az = fz - r;
      const i = r * cols + c;
      return (h[i] * (1 - ax) + h[i + 1] * ax) * (1 - az) + (h[i + cols] * (1 - ax) + h[i + cols + 1] * ax) * az;
    };
    const la = -0.6, lb = 0.6, tc = Math.cos(turn), ts = Math.sin(turn); // light from the screen's upper left, in world x/z
    const L = [la * tc + lb * ts, lb * tc - la * ts, 1], ln = Math.hypot(...L), lx = L[0] / ln, lz = L[1] / ln, lu = L[2] / ln;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const img = cv.getContext("2d").createImageData(W, H), px = img.data;
    for (let py = 0; py < H; py++) {
      const fz = (H - py - 0.5) / K - 0.5;
      for (let qx = 0; qx < W; qx++) {
        const fx = (qx + 0.5) / K - 0.5, v = at(fx, fz), o = 4 * (py * W + qx);
        px[o + 3] = 255;
        if (water != null && v < water) {
          const d = Math.pow(Math.min(1, (water - v) / 3), 0.6);
          px[o] = 110 - 88 * d; px[o + 1] = 188 - 132 * d; px[o + 2] = 212 - 138 * d;
          continue;
        }
        const dx = (at(fx + 0.5, fz) - at(fx - 0.5, fz)) / step * RELIEF_EXAG;
        const dz = (at(fx, fz + 0.5) - at(fx, fz - 0.5)) / step * RELIEF_EXAG;
        const shade = Math.min(1.3, Math.max(0.5, (-dx * lx - dz * lz + lu) / Math.hypot(dx, dz, 1) / lu));
        const e = (v - landLo) / span;
        px[o] = (70 + 68 * e) * shade; px[o + 1] = (54 + 52 * e) * shade; px[o + 2] = (36 + 30 * e) * shade;
      }
    }
    cv.getContext("2d").putImageData(img, 0, 0);
    const interval = [1, 2, 2.5, 5, 10, 20, 25, 50].find(v => span / v <= 10) || 100;
    const levels = [];
    for (let lv = (Math.floor(landLo / interval) + 1) * interval; lv < hi; lv += interval) levels.push(lv);
    return {
      canvas: cv, contours: isolines(T, levels), shore: water != null ? isolines(T, [water]) : null,
      xmin: x0 - step / 2, zmax: z0 - step / 2 + rows * step, width: cols * step, length: rows * step,
    };
  }

  // Marching squares over the height grid's points (cell centres) for each level, as one world-space Path2D. Saddle
  // cells pair crossings in edge order.
  function isolines(T, levels) {
    const { cols, rows, step, h, x0, z0 } = T, path = new Path2D(), cross = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const i = r * cols + c, v = [h[i], h[i + 1], h[i + cols + 1], h[i + cols]];
        const corner = [[c, r], [c + 1, r], [c + 1, r + 1], [c, r + 1]];
        const vmin = Math.min(...v), vmax = Math.max(...v);
        for (const lv of levels) {
          if (lv <= vmin || lv >= vmax) continue;
          cross.length = 0;
          for (let k = 0; k < 4; k++) {
            const a = v[k], b = v[(k + 1) % 4];
            if ((a < lv) !== (b < lv)) {
              const f = (lv - a) / (b - a), [ca, ra] = corner[k], [cb, rb] = corner[(k + 1) % 4];
              cross.push(x0 + (ca + (cb - ca) * f) * step, z0 + (ra + (rb - ra) * f) * step);
            }
          }
          for (let k = 0; k + 3 < cross.length; k += 4) {
            path.moveTo(cross[k], cross[k + 1]);
            path.lineTo(cross[k + 2], cross[k + 3]);
          }
        }
      }
    }
    return path;
  }

  // Pictograms (the badges of BUILDING_TYPES with `badge`; ROCK is also the stone pile's boulder), drawn in the
  // current fill/stroke colour around (x, y) within roughly s pixels.
  function poly(g, x, y, s, pts) {
    g.beginPath();
    g.moveTo(x + pts[0] * s, y + pts[1] * s);
    for (let i = 2; i < pts.length; i += 2) g.lineTo(x + pts[i] * s, y + pts[i + 1] * s);
    g.closePath();
  }
  const ROCK = [-0.9, 0.35, -0.55, -0.45, 0.05, -0.8, 0.7, -0.45, 0.95, 0.3, 0.5, 0.75, -0.45, 0.72];
  const GLYPH = {
    sword(g, x, y, s) {
      g.beginPath(); g.moveTo(x, y - s * 0.9); g.lineTo(x, y + s * 0.85);
      g.moveTo(x - s * 0.5, y + s * 0.3); g.lineTo(x + s * 0.5, y + s * 0.3); g.stroke();
    },
    bow(g, x, y, s) {
      g.beginPath(); g.arc(x - s * 0.55, y, s * 0.95, -Math.PI / 3, Math.PI / 3);
      g.moveTo(x - s * 0.08, y - s * 0.82); g.lineTo(x - s * 0.08, y + s * 0.82);
      g.moveTo(x - s * 0.75, y); g.lineTo(x + s * 0.55, y); g.stroke();
      poly(g, x, y, s, [0.9, 0, 0.5, -0.25, 0.5, 0.25]); g.fill();
    },
    horseshoe(g, x, y, s) {
      const w = g.lineWidth;
      g.lineWidth = w * 1.3;
      g.beginPath(); g.moveTo(x - s * 0.55, y + s * 0.6); g.arc(x, y - s * 0.05, s * 0.55, Math.PI, Math.PI * 2);
      g.lineTo(x + s * 0.55, y + s * 0.6); g.stroke();
      g.lineWidth = w;
    },
    cross(g, x, y, s) {
      g.beginPath(); g.moveTo(x - s * 0.5, y - s * 0.3); g.lineTo(x + s * 0.5, y - s * 0.3);
      g.moveTo(x, y - s * 0.8); g.lineTo(x, y + s * 0.8); g.stroke();
    },
    wheel(g, x, y, s) {
      g.beginPath(); g.arc(x, y, s * 0.68, 0, Math.PI * 2);
      for (let k = 0; k < 3; k++) {
        const a = Math.PI / 6 + k * Math.PI / 3, dx = Math.cos(a) * s * 0.68, dy = Math.sin(a) * s * 0.68;
        g.moveTo(x - dx, y - dy); g.lineTo(x + dx, y + dy);
      }
      g.stroke();
    },
    sail(g, x, y, s) {
      g.beginPath(); g.moveTo(x - s * 0.02, y - s * 0.9); g.lineTo(x - s * 0.02, y + s * 0.55); g.stroke();
      poly(g, x, y, s, [0.1, -0.85, 0.7, 0.4, 0.1, 0.4]); g.fill();
      poly(g, x, y, s, [-0.12, -0.5, -0.55, 0.4, -0.12, 0.4]); g.fill();
      poly(g, x, y, s, [-0.75, 0.55, 0.75, 0.55, 0.45, 0.85, -0.45, 0.85]); g.fill();
    },
    bag(g, x, y, s) {
      g.beginPath(); g.arc(x, y + s * 0.25, s * 0.58, 0, Math.PI * 2); g.fill();
      poly(g, x, y, s, [-0.3, -0.75, 0.3, -0.75, 0.12, -0.3, -0.12, -0.3]); g.fill();
    },
    anvil(g, x, y, s) {
      poly(g, x, y, s, [-0.95, -0.45, 0.8, -0.45, 0.8, -0.05, 0.3, 0.05, 0.25, 0.35, 0.6, 0.7, -0.6, 0.7, -0.25, 0.35,
        -0.3, 0.05, -0.55, 0.0]);
      g.fill();
    },
    book(g, x, y, s) {
      g.beginPath(); g.moveTo(x, y - s * 0.5); g.lineTo(x - s * 0.85, y - s * 0.7); g.lineTo(x - s * 0.85, y + s * 0.55);
      g.lineTo(x, y + s * 0.75); g.lineTo(x + s * 0.85, y + s * 0.55); g.lineTo(x + s * 0.85, y - s * 0.7); g.closePath();
      g.moveTo(x, y - s * 0.5); g.lineTo(x, y + s * 0.75); g.stroke();
    },
  };

  function glyph(g, name, x, y, s, ink) {
    g.fillStyle = g.strokeStyle = ink;
    g.lineWidth = Math.max(1.1, s * 0.2);
    g.lineCap = "round"; g.lineJoin = "round";
    GLYPH[name](g, x, y, s);
    g.lineCap = "butt"; g.lineJoin = "miter";
  }

  // Unit art on a 64 px grid, as [Path2D, tone], one entry per UNIT_TYPES key. Tones: b = player colour,
  // B = player colour with its own thin outline (cloth laid over a horse or cart), d = the player colour darkened
  // (helmets, shields, hulls' stripes), w = steel, k = dark detail (strings, manes, hubs; no casing), and the neutral
  // ART_TONES h = horse brown, o = wood, t = straw, s = canvas/smoke, y = gold, e = elephant grey. The player colour
  // stays the biggest area so ownership reads at a glance. `figure` is the whole unit (soldier, rider on horse,
  // engine, boat), facing right, drawn so that the grid spans `size` x r px (default FIGURE_SIZE) at screen radius r,
  // centred FIGURE_DY x r below the unit: standing figures fill the grid's height, wide ones (riders, engines,
  // boats) its width.
  const FIGURE_SIZE = 2.5, FIGURE_DY = 0.1;
  const ART_TONES = { h: "#7a5233", o: "#a87a46", t: "#d8b36a", s: "#e9e4d8", y: "#f3d27a", e: "#a29b93", k: CASING };
  const circ = (cx, cy, r) => `M${cx - r} ${cy} A${r} ${r} 0 1 0 ${cx + r} ${cy} A${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;
  // Straight bar w wide from (x1, y1) to (x2, y2): poles, shafts, legs, strings.
  const bar = (x1, y1, x2, y2, w) => {
    const l = Math.hypot(x2 - x1, y2 - y1), nx = (y1 - y2) / l * w / 2, ny = (x2 - x1) / l * w / 2;
    return `M${x1 + nx} ${y1 + ny} L${x2 + nx} ${y2 + ny} L${x2 - nx} ${y2 - ny} L${x1 - nx} ${y1 - ny} Z`;
  };
  const artParts = list => list.map(([d, tone]) => [new Path2D(d), tone]);
  // Horse facing right with its hooves on the grid's bottom (legs, tail, body with neck and head, ear, mane, eye),
  // shared by the riders; its back, where the saddle goes, is at y 27.
  const HORSE = [
    [bar(16, 37, 10, 57, 4.5), "h"], [bar(22, 39, 23, 59, 4.5), "h"], [bar(40, 39, 40, 59, 4.5), "h"],
    [bar(45, 37, 52, 55, 4.5), "h"], ["M13 29 Q2 30 3 47 Q8 40 14 36 Z", "k"],
    ["M18 27 L38 27 Q42 27 44 24 L48 14 Q50 9 54 10 L61 18 Q63 21 60 23 L55 22 L51 31 Q50 43 41 43 L19 43 " +
      "Q11 43 11 35 Q11 27 18 27 Z", "h"],
    ["M51 11 L53 5 L56 11 Z", "h"], ["M43 24 L48 13 L51 12 L46 25 Z", "k"], [circ(55, 15, 1.2), "k"],
  ];
  // Rider from the hips up, sitting on HORSE's back over a saddle cloth, leg down the horse's side.
  const RIDER = [
    ["M18 25 L39 25 L38 41 L19 41 Z", "B"], [bar(32, 26, 34, 39, 6), "d"],
    ["M24 27 L37 27 L36 15 Q36 11 32 11 L28 11 Q24 11 24 15 Z", "b"],
  ];
  const UNIT_ART = {
    villager: { // straw hat, sledgehammer; drawn smaller and in the darker villager colour (paintUnit)
      size: 2.3,
      figure: artParts([
        [bar(43, 14, 47, 52, 4), "o"], ["M36 9 L52 7 L53 16 L37 18 Z", "w"],
        ["M20 24 Q20 21 24 21 L33 21 Q37 21 37 24 L38 45 L19 45 Z", "b"], ["M34 23 L44 28 L43 33 L33 30 Z", "b"],
        ["M21 44 L27.5 44 L27 61 L20.5 61 Z", "b"], ["M29.5 44 L36 44 L36.5 61 L30 61 Z", "b"],
        [circ(28.5, 15, 6), "b"], ["M16 12 L41 12 Q38 9 34 8.5 Q33 3 28.5 3 Q24 3 23 8.5 Q19 9 16 12 Z", "t"],
        ["M19 32 L38 32 L38 35 L19 35 Z", "k"]]),
    },
    spear: {
      figure: artParts([
        ["M19 24 Q19 20 23.5 20 L33.5 20 Q38 20 38 24 L36.5 44 L20.5 44 Z", "b"], ["M15.5 23 L20 21.5 L21 38 L16.5 39 Z", "b"],
        ["M35 23 L46 29 L45 34.5 L34 30 Z", "b"], ["M21 43 L27.5 43 L27 61 L20.5 61 Z", "b"], ["M29.5 43 L36 43 L36.5 61 L30 61 Z", "b"],
        [circ(28.5, 14.5, 6.5), "b"], ["M28.5 1.5 L37.5 12.5 L19.5 12.5 Z", "d"],
        ["M44.5 12 L49.5 12 L49.5 63 L44.5 63 Z", "w"], ["M47 0 L52.5 10 L47 16 L41.5 10 Z", "w"]]),
    },
    maa: {
      figure: artParts([
        ["M9 27 Q9 20 17 20 L40 20 Q48 20 48 27 L42 46 L15 46 Z", "b"], ["M40 22 L50 32 L46 37 L36 28 Z", "b"],
        ["M15.5 45 L26.5 45 L26.5 62 L14.5 62 Z", "b"], ["M30.5 45 L41.5 45 L42.5 62 L30.5 62 Z", "b"],
        ["M18 3.5 Q28.5 0 39 3.5 L39 18.5 Q28.5 21 18 18.5 Z", "d"],
        ["M21.5 9.5 L35.5 9.5 L35.5 12.5 L21.5 12.5 Z", "k"],
        ["M2 24 L25 24 L25 37 Q24 50 13.5 57 Q3 50 2 37 Z", "d"], ["M11.5 27 L15.5 27 L15.5 52 L11.5 52 Z", "b"],
        ["M51 1 L54.5 7.5 L54.5 33 L47.5 33 L47.5 7.5 Z", "w"], ["M42 32.5 L60 32.5 L60 37.5 L42 37.5 Z", "w"],
        ["M49 37 L53 37 L53 42 L49 42 Z", "w"], [circ(51, 44.5, 3), "w"]]),
    },
    sword: { // no shield: round helmet, skirt, long sword raised forward
      figure: artParts([
        ["M19 24 Q19 20 23.5 20 L33.5 20 Q38 20 38 24 L37 44 L20 44 Z", "b"], ["M17 42 L40 42 L42 49 L15 49 Z", "d"],
        ["M21 47 L27.5 47 L27 61 L20.5 61 Z", "b"], ["M29.5 47 L36 47 L36.5 61 L30 61 Z", "b"],
        ["M35 22 L45 25 L44 30.5 L34 28 Z", "b"],
        [bar(44, 27, 59, 3, 4), "w"], ["M57 1 L61.5 0 L60 5 Z", "w"], [bar(40, 23, 48, 30, 3), "w"],
        [circ(28.5, 13.5, 6.5), "b"], ["M19 12 Q19 3 28.5 3 Q38 3 38 12 L42 14 L15 14 Z", "d"]]),
    },
    archer: { // hood, bow drawn with the arrow nocked
      figure: artParts([
        ["M21 24 Q21 20 25.5 20 L33.5 20 Q37 20 37 24 L37 44 L21 44 Z", "b"],
        ["M22 43 L28 43 L27.5 61 L21.5 61 Z", "b"], ["M30 43 L36 43 L36.5 61 L30.5 61 Z", "b"],
        ["M46 5 Q62 29 46 53 L43 51 Q56 29 43 7 Z", "o"],
        [bar(45, 7, 29, 28, 1.3), "k"], [bar(29, 28, 45, 51, 1.3), "k"],
        [bar(34, 24, 50, 27, 4.5), "b"], [bar(22, 28, 58, 28, 2), "w"], ["M55 24 L62 28 L55 32 Z", "w"],
        [circ(29, 13.5, 6.5), "b"], ["M21 16 Q20 4 29 4 Q37 4 37 11 L33 11 Q30 9 24 13 L24 19 Z", "d"]]),
    },
    crossbow: { // kettle hat, crossbow held level: stock forward, steel bow across it
      figure: artParts([
        ["M19 24 Q19 20 23.5 20 L33.5 20 Q38 20 38 24 L37 44 L20 44 Z", "b"],
        ["M21 43 L27.5 43 L27 61 L20.5 61 Z", "b"], ["M29.5 43 L36 43 L36.5 61 L30 61 Z", "b"],
        [bar(20, 28, 61, 28, 4.5), "o"], [bar(48, 15, 40, 28, 1.3), "k"], [bar(40, 28, 48, 41, 1.3), "k"],
        ["M48 13 Q58 28 48 43 L45.5 41.5 Q54 28 45.5 14.5 Z", "w"], [bar(34, 25, 44, 29, 4.5), "b"],
        [circ(28.5, 13.5, 6.5), "b"], ["M14 13 L43 13 L38 10 Q36 2 28.5 2 Q21 2 19 10 Z", "d"]]),
    },
    gun: { // brimmed hat, handcannon on a wooden pole, smoke at the muzzle
      figure: artParts([
        ["M19 24 Q19 20 23.5 20 L33.5 20 Q38 20 38 24 L37 44 L20 44 Z", "b"],
        ["M21 43 L27.5 43 L27 61 L20.5 61 Z", "b"], ["M29.5 43 L36 43 L36.5 61 L30 61 Z", "b"],
        [bar(14, 38, 36, 30, 4), "o"], [bar(34, 31, 53, 24, 6), "w"], [bar(52, 21, 54, 27, 8), "w"],
        [bar(30, 23, 40, 30, 4.5), "b"],
        [circ(60, 19, 3.5), "s"], [circ(57, 14, 3.5), "s"], [circ(61, 11, 2.5), "s"],
        [circ(28.5, 13.5, 6.5), "b"], ["M17 12 L40 12 L37 9 Q34 4 28.5 4 Q23 4 20 9 Z", "d"]]),
    },
    horseman: { // rider with a sword raised forward
      size: 2.6,
      figure: artParts([...HORSE, ...RIDER,
        [bar(34, 16, 42, 13, 4), "b"], [bar(43, 12, 57, 0, 3.2), "w"], [bar(40, 9.5, 45, 15.5, 2.5), "w"],
        [circ(31, 7, 5), "b"], ["M25.5 7 Q26 1 31 1 Q36 1 36.5 7 Z", "d"]]),
    },
    knight: { // horse in a caparison with a dark chanfron, great helm, couched lance
      size: 2.6,
      figure: artParts([...HORSE,
        ["M15 26 L41 26 Q45 25 47 21 L52 29 Q53 47 50 48 L46 45 L42 49 L37 45 L32 49 L27 45 L22 49 L17 45 L12 48 " +
          "Q9 38 11 31 Q12 26 15 26 Z", "B"], ["M47 13 L55 9 L61 18 L56 21 Z", "d"],
        [bar(32, 26, 34, 38, 6), "d"],
        ["M24 27 L37 27 L36 14 Q36 11 32 11 L28 11 Q24 11 24 14 Z", "b"],
        ["M27 15 L37 15 L37 22 Q37 29 32 31 Q27 29 27 22 Z", "d"],
        [bar(30, 21, 63, 6, 3), "w"], ["M37 14 L43 13.5 L42 20 Z", "w"],
        ["M26 0 L36 0 L36 11 L26 11 Z", "d"], ["M28 5 L36 5 L36 7 L28 7 Z", "k"]]),
    },
    horsearcher: { // rider shooting backwards over the horse's rump
      size: 2.6,
      figure: artParts([...HORSE, ...RIDER,
        ["M14 -1 Q1 14 14 29 L16 27 Q6 14 16 1 Z", "o"],
        [bar(15, 0, 30, 13, 1.2), "k"], [bar(30, 13, 15, 28, 1.2), "k"],
        [bar(28, 15, 10, 14, 4), "b"], [bar(4, 13, 36, 13, 2), "w"], ["M6 9 L0 13 L6 17 Z", "w"],
        [circ(31, 7, 5), "b"], ["M25 9 Q25 1 31 1 Q37 1 37 7 L31 5 L28 10 Z", "d"]]),
    },
    scout: { // smaller, galloping, unarmed rider leaning forward with a flying cloak
      size: 2.4,
      figure: artParts([
        [bar(14, 37, 4, 50, 4.5), "h"], [bar(19, 39, 12, 56, 4.5), "h"], [bar(42, 39, 50, 55, 4.5), "h"],
        [bar(45, 37, 57, 45, 4.5), "h"], ["M13 29 Q2 26 1 35 Q8 34 14 35 Z", "k"],
        ["M18 27 L38 27 Q42 27 45 24 L51 16 Q53 12 57 14 L62 21 Q63 24 60 25 L56 24 L51 31 Q50 43 41 43 L19 43 " +
          "Q11 43 11 35 Q11 27 18 27 Z", "h"],
        ["M53 14 L57 8 L58 15 Z", "h"], ["M43 24 L50 15 L52 16 L46 25 Z", "k"],
        ["M30 12 Q16 10 6 20 Q16 22 26 26 Z", "d"], [bar(32, 26, 35, 38, 6), "d"],
        ["M25 27 L38 27 L40 16 Q40 12 36 12 L31 12 Q27 13 26 17 Z", "b"], [bar(38, 17, 46, 23, 4), "b"],
        [circ(37, 8, 5), "b"], ["M31 10 Q31 2 37 2 Q43 2 43 8 L37 6 L34 12 Z", "d"]]),
    },
    elephant: { // grey elephant with tusk and ear, player-colour blanket, howdah with a rider and pennant
      size: 2.6,
      figure: artParts([
        [bar(15, 40, 15, 59, 8), "e"], [bar(42, 40, 44, 59, 8), "e"],
        ["M10 30 Q3 30 3 42 Q6 38 10 37 Z", "k"],
        ["M14 22 Q30 16 46 22 Q54 22 58 30 Q62 38 60 48 Q59 56 62 60 L57 61 Q53 55 54 46 L51 44 Q46 49 36 48 " +
          "L28 50 Q12 51 8 40 Q6 26 14 22 Z", "e"],
        ["M44 25 Q36 28 39 39 Q43 44 49 40 Z", "e"], [bar(52, 41, 58, 43, 3), "w"], [circ(52, 31, 1.3), "k"],
        [bar(22, 42, 22, 59, 8), "e"], [bar(36, 42, 37, 59, 8), "e"],
        ["M16 21 L42 21 L40 37 L18 37 Z", "B"], ["M16 36 L42 36 L40 40 L18 40 Z", "y"],
        ["M17 8 L41 8 L40 22 L18 22 Z", "d"], ["M14 6 L44 6 L42 10 L16 10 Z", "b"],
        [circ(29, 4, 4.5), "b"], [bar(34, 3, 38, -6, 2), "o"], ["M38 -6 L46 -3 L38 0 Z", "b"]]),
    },
    monk: { // hooded robe with a gold belt, staff topped with a gold cross
      figure: artParts([
        [bar(46, 8, 46, 62, 3.5), "o"], ["M42 7 L50 7 L50 10 L42 10 Z", "y"],
        ["M44.5 2 L47.5 2 L47.5 16 L44.5 16 Z", "y"],
        ["M21 24 Q21 20 26 20 L32 20 Q37 20 37 24 L42 61 L16 61 Z", "b"],
        ["M34 23 L45 29 L44 34 L33 30 Z", "b"], [circ(46, 31, 3), "b"],
        ["M22 34 L37 34 L37.5 37 L21.5 37 Z", "y"], [bar(25, 36, 23, 46, 2), "y"],
        [circ(29, 13.5, 6.5), "b"], ["M20 18 Q19 5 29 5 Q39 5 38 18 L35 21 L35 13 Q29 11 23 13 L23 21 Z", "d"]]),
    },
    siege: { // mangonel: painted base and frame on two wheels, wooden arm with a loaded bucket
      size: 2.6,
      figure: artParts([
        ["M5 37 L59 37 L59 47 L5 47 Z", "b"], ["M25 38 L33 16 L41 16 L49 38 Z", "b"], [bar(29, 17, 45, 17, 4.5), "d"],
        [bar(12, 40, 47, 7, 4.5), "o"], ["M41 3 Q46 -2 52 3 L50 10 L42 9 Z", "d"], [circ(47, 2, 4), "e"],
        [circ(17, 52, 8), "o"], [circ(17, 52, 2.5), "k"], [circ(47, 52, 8), "o"], [circ(47, 52, 2.5), "k"]]),
    },
    ram: { // peaked roof over a shed on wheels, iron-headed log poking out in front
      size: 2.6,
      figure: artParts([
        [bar(4, 36, 62, 36, 6), "o"], ["M54 31 L63 33 L63 39 L54 41 Z", "w"],
        ["M6 34 L32 10 L58 34 Z", "b"], ["M10 34 L54 34 L54 46 L10 46 Z", "d"],
        [bar(19, 22, 45, 22, 1.5), "k"], [bar(13, 28, 51, 28, 1.5), "k"],
        [circ(17, 50, 8), "o"], [circ(17, 50, 2.5), "k"], [circ(47, 50, 8), "o"], [circ(47, 50, 2.5), "k"]]),
    },
    ship: { // wooden hull with raised stern and bow and a coloured stripe, big bellied sail on yards, pennant
      size: 2.6,
      figure: artParts([
        [bar(32, 2, 32, 42, 3.5), "o"], ["M32 0 L43 3 L32 6 Z", "d"],
        ["M16 10 L48 10 Q56 22 48 34 L16 34 Q23 22 16 10 Z", "b"], [bar(13, 9, 51, 9, 3), "o"],
        [bar(14, 35, 50, 35, 3), "o"],
        ["M1 29 L12 31 L13 40 L52 40 L63 30 Q60 52 47 57 L15 57 Q3 52 1 29 Z", "o"],
        ["M3 43 L59 43 L57 47.5 L5 47.5 Z", "d"]]),
    },
    fishboat: { // small painted boat, triangular sail, net hanging from a pole
      size: 2.4,
      figure: artParts([
        [bar(24, 6, 24, 42, 3), "o"], ["M26 8 L42 36 L26 36 Z", "b"],
        [bar(38, 42, 60, 22, 2.5), "o"], ["M58 23 Q64 36 56 46 L46 46 Z", "s"],
        [bar(52, 32, 60, 32, 1), "k"], [bar(50, 38, 60, 38, 1), "k"], [bar(52, 28, 54, 46, 1), "k"],
        ["M4 40 L54 40 Q50 54 40 56 L16 56 Q8 54 4 40 Z", "b"], ["M6 44 L52 44 L51 47 L7 47 Z", "d"]]),
    },
    trader: { // covered cart pulled by a mule
      size: 2.6,
      figure: artParts([
        [bar(44, 44, 42, 59, 4), "h"], [bar(55, 44, 58, 59, 4), "h"],
        [bar(30, 42, 52, 38, 2.5), "o"],
        ["M41 34 L54 34 L57 26 Q58 20 61 22 L63 28 L60 30 L58 40 Q56 46 48 46 L44 46 Q40 46 41 34 Z", "h"],
        ["M4 20 Q4 8 18 8 L22 8 Q36 8 36 20 L36 32 L4 32 Z", "B"],
        [bar(12, 8, 12, 32, 1.5), "d"], [bar(26, 8, 26, 32, 1.5), "d"],
        ["M2 30 L38 30 L38 42 L2 42 Z", "o"],
        [circ(20, 50, 9), "o"], [circ(20, 50, 3), "k"]]),
    },
    hero: { // crown, cape, raised sword, banner flying behind
      figure: artParts([
        [bar(12, 1, 12, 62, 3.5), "o"], ["M11 2 L-3 4 L1 12 L-3 21 L11 20 Z", "b"], [circ(5, 11, 2.8), "y"],
        ["M17 24 Q17 20 22 20 L35 20 Q40 20 40 24 L44 52 L13 52 Z", "d"],
        ["M19 24 Q19 20 23.5 20 L33.5 20 Q38 20 38 24 L37 46 L20 46 Z", "b"],
        ["M21 45 L27.5 45 L27 61 L20.5 61 Z", "b"], ["M29.5 45 L36 45 L36.5 61 L30 61 Z", "b"],
        ["M19 30 L38 30 L38 33.5 L19 33.5 Z", "y"],
        ["M35 22 L45 27 L44 32 L34 28 Z", "b"], [bar(46, 28, 54, 3, 3.5), "w"], [bar(41, 27, 49, 31, 2.5), "y"],
        ["M13 23 L19 21 L19 30 L14 30 Z", "b"],
        [circ(28.5, 14, 6.5), "b"], ["M21 9 L21 2 L25 6 L28.5 0 L32 6 L36 2 L36 9 Z", "y"]]),
    },
  };

  // UNIT_ART parts with the grid's centre at (cx, cy), k px per grid unit: every part but dark details outlined lw px
  // wide in CASING, then filled; all but plain player-colour parts get an outline of their own `inner` px wide (none
  // when 0) so weapons, helmets, animals and wood stand off the body.
  function paintArt(g, cx, cy, k, parts, col, lw, inner) {
    g.save();
    g.translate(cx - 32 * k, cy - 32 * k); g.scale(k, k);
    g.lineJoin = "round"; g.lineCap = "round"; g.strokeStyle = CASING; g.lineWidth = lw / k;
    for (const [p, tone] of parts) if (tone !== "k") g.stroke(p);
    const dark = mix(col, "#000000", 0.5);
    g.lineWidth = inner / k;
    for (const [p, tone] of parts) {
      if (inner && tone !== "b" && tone !== "k") g.stroke(p);
      g.fillStyle = tone === "b" || tone === "B" ? col : tone === "d" ? dark : tone === "w" ? "#eef0f2" : ART_TONES[tone];
      g.fill(p);
    }
    g.restore();
  }

  // A unit's tier (I-IV: the age its blueprint belongs to) as four pips centred on cx just above `bottom`, the first
  // `tier` lit gold, on one dark bar.
  function tierPips(g, cx, bottom, r, tier) {
    const w = Math.round(Math.max(2, r * 0.38)), h = Math.round(Math.max(2, r * 0.22)), gap = Math.max(1, Math.round(r * 0.1));
    const x0 = Math.round(cx - (4 * w + 3 * gap) / 2), top = Math.round(bottom - h);
    g.fillStyle = CASING;
    g.fillRect(x0 - 1, top - 1, 4 * w + 3 * gap + 2, h + 2);
    for (let i = 0; i < 4; i++) {
      g.fillStyle = i < tier ? "#f3d27a" : "#3a3f4a";
      g.fillRect(x0 + i * (w + gap), top, w, h);
    }
  }

  // One unit at screen radius r: its UNIT_ART figure (a unit without a type as a swordsman when military, else as a
  // villager), villagers in a darker shade of the player colour. Below FIGURE_R the casing gets relatively heavier
  // and the inner outlines go, which would only muddy a figure a dozen pixels tall.
  function paintUnit(g, x, y, r, type, cat, col) {
    if (cat === "livestock") { paintClaimedSheep(g, x, y, r, col); return; }
    const art = UNIT_ART[type] || UNIT_ART[RV.isMilitary(cat) ? "sword" : "villager"];
    const fill = type === "villager" ? mix(col, CASING, 0.35) : col, k = r * (art.size || FIGURE_SIZE) / 64;
    const lw = r >= FIGURE_R ? Math.max(2, r / 5) : Math.max(1, r * 0.3);
    paintArt(g, x, y + r * FIGURE_DY, k, art.figure, fill, lw, r >= FIGURE_R ? lw * 0.55 : 0);
  }

  // Units are stamped from sprites, as a figure is 10-20 paths and a big game shows hundreds: each type, category,
  // colour and radius (to a quarter pixel) is painted once by paintUnit into a canvas at the screen's pixel ratio,
  // centred on a device pixel, and drawn from there snapped to device pixels. The cache is emptied when it passes
  // UNIT_SPRITES (zooming makes new radii) or the pixel ratio changes.
  const UNIT_SPRITES = 400;
  const unitSprites = new Map();
  let spriteDpr = 0;
  function stampUnit(g, x, y, r, type, cat, col) {
    const dpr = window.devicePixelRatio || 1, q4 = Math.round(r * 4), key = `${type}|${cat}|${col}|${q4}`;
    if (dpr !== spriteDpr || unitSprites.size >= UNIT_SPRITES) { unitSprites.clear(); spriteDpr = dpr; }
    let sp = unitSprites.get(key);
    if (!sp) {
      const q = q4 / 4, h = Math.ceil((1.8 * q + 3) * dpr), cv = document.createElement("canvas"); // half-side in device px
      cv.width = cv.height = 2 * h;
      const sg = cv.getContext("2d");
      sg.setTransform(dpr, 0, 0, dpr, h, h);
      paintUnit(sg, 0, 0, q, type, cat, col);
      unitSprites.set(key, sp = { cv, h: h / dpr });
    }
    g.drawImage(sp.cv, Math.round(x * dpr) / dpr - sp.h, Math.round(y * dpr) / dpr - sp.h, 2 * sp.h, 2 * sp.h);
  }

  // Path of a square with half-side h centred on (x, y), turned by `turn` like the map.
  function squarePath(g, x, y, h, turn) {
    const c = Math.cos(turn) * h, s = Math.sin(turn) * h;
    g.beginPath();
    g.moveTo(x + c - s, y - s - c);
    g.lineTo(x - c - s, y + s - c);
    g.lineTo(x - c + s, y + s + c);
    g.lineTo(x + c + s, y + c - s);
    g.closePath();
  }

  // Buildings as seen from above (paintPlan), on a 64-unit grid laid over the footprint: 0..64 both ways, the top
  // edge facing world north before the map turns. Each plan is a list of parts { p: Path2D, t: tone, fine } painted
  // in order; `fine` parts are small props left out below PLAN_DETAIL_PX. Tones in the owner's colour: 0-3 roof
  // facets sloping down to the north, east, south and west (shaded by BUILDING_LIGHT), t flat top, d and D darker
  // tops (wall walks, floors inside parapets), R a cone or dome (lit off-centre toward the light; `lit` is its
  // highlight), s cloth stripes, f the footprint tinted. Other tones: G gold dome, x drop shadow (drawn away from the
  // light), materials (PLAN_MAT) and stroked lines (L dark seam, T gold trim, F wooden fence or frame, B crop rows,
  // O the footprint's edge in the owner's colour). Ground-level tones (PLAN_FLAT) have no outline; everything raised
  // gets a CASING outline so roofs stand off each other. `alpha` fades a whole plan (fields).
  const PLAN_MAT = {
    p: "#8a8173", y: "#6e5940", v: "#5d7a3c", c: "#76603d", k: CASING, r: "#ff7b1c", m: "#c3bdb0", o: "#7b5532",
    l: "#d6ad72", a: "#f2c14e", z: "#efe7d4", h: "#d9c26b", e: "#c8322b",
  };
  const PLAN_FLAT = new Set(["f", "x", "p", "y", "v", "c", "k", "r", "s"]);
  const BUILDING_PLAN = (() => {
    const rc = (x, y, w, h) => `M${x} ${y}h${w}v${h}h${-w}Z`;
    const pg = (...p) => `M${p.join(" ")}Z`;
    const hip = (x0, y0, x1, y1) => { // hipped roof, ridge along the longer side (a pyramid when square)
      const w = x1 - x0, h = y1 - y0;
      if (w >= h) {
        const m = (y0 + y1) / 2, a = x0 + h / 2, b = x1 - h / 2;
        return [[pg(x0, y0, x1, y0, b, m, a, m), 0], [pg(x0, y1, x1, y1, b, m, a, m), 2],
          [pg(x1, y0, x1, y1, b, m), 1], [pg(x0, y0, a, m, x0, y1), 3]];
      }
      const m = (x0 + x1) / 2, a = y0 + w / 2, b = y1 - w / 2;
      return [[pg(x1, y0, x1, y1, m, b, m, a), 1], [pg(x0, y0, m, a, m, b, x0, y1), 3],
        [pg(x0, y0, x1, y0, m, a), 0], [pg(x0, y1, x1, y1, m, b), 2]];
    };
    const gable = (x0, y0, x1, y1) => { // two slopes, ridge along the longer side
      if (x1 - x0 >= y1 - y0) {
        const m = (y0 + y1) / 2;
        return [[rc(x0, y0, x1 - x0, m - y0), 0], [rc(x0, m, x1 - x0, y1 - m), 2]];
      }
      const m = (x0 + x1) / 2;
      return [[rc(x0, y0, m - x0, y1 - y0), 3], [rc(m, y0, x1 - m, y1 - y0), 1]];
    };
    const round = (cx, cy, r, t = "R") => ({ round: [cx, cy, r], t });
    const battlements = (x0, y0, x1, y1, n, m) => { // n merlons a side along a rectangle, m wide
      let d = "";
      for (let i = 0; i <= n; i++) {
        const fx = x0 + (x1 - x0) * i / n, fy = y0 + (y1 - y0) * i / n;
        d += rc(fx - m / 2, y0 - m / 2, m, m) + rc(fx - m / 2, y1 - m / 2, m, m);
        if (i > 0 && i < n) d += rc(x0 - m / 2, fy - m / 2, m, m) + rc(x1 - m / 2, fy - m / 2, m, m);
      }
      return d;
    };
    const ring = (cx, cy, r, n, m) => { // n merlons around a circle
      let d = "";
      for (let i = 0; i < n; i++) {
        const a = i * Math.PI * 2 / n;
        d += rc(cx + r * Math.cos(a) - m / 2, cy + r * Math.sin(a) - m / 2, m, m);
      }
      return d;
    };
    const fine = (d, t) => [d, t, true];
    const sails = () => { // four mill sails along the diagonals: cloth either side of the spar, laths across it
      let cloth = "", lines = "";
      for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const ux = dx * Math.SQRT1_2, uy = dy * Math.SQRT1_2;
        const at = (r, w) => [32 + ux * r - uy * w, 32 + uy * r + ux * w];
        cloth += pg(...at(6, -2.5), ...at(30, -4.5), ...at(30, 4.5), ...at(6, 2.5));
        lines += `M32 32L${at(31, 0).join(" ")}`;
        for (const r of [14, 22]) lines += `M${at(r, -4).join(" ")}L${at(r, 4).join(" ")}`;
      }
      return [[cloth, "z"], fine(lines, "L")];
    };
    const make = (list, { foot = true, alpha = 1 } = {}) => ({
      alpha,
      parts: (foot ? [[rc(0, 0, 64, 64), "f"], ...list] : list).map(it => {
        if (!it.round) return { p: new Path2D(it[0]), t: it[1], fine: !!it[2] };
        const [cx, cy, r] = it.round;
        return { p: new Path2D(circ(cx, cy, r)), t: it.t, fine: false, lit: new Path2D(circ(cx, cy, r * 0.62)), r };
      }),
    });
    const corners = (r, t, f) => [[9, 9], [55, 9], [9, 55], [55, 55]].map(([x, y]) => [circ(x, y, r), t, f]);
    const STALLS = [[7, 7], [25, 7], [43, 7], [7, 43], [25, 43], [43, 43]]; // market stalls, 14 square
    const stalls = STALLS.map(([x, y]) => rc(x, y, 14, 14)).join("");
    return {
      // walled compound: corner towers with cone roofs, paved yard, gate to the south, central hall and porch
      tc: make([
        [rc(3, 3, 58, 58), "x"], [rc(3, 3, 58, 58), "d"], [rc(10, 10, 44, 44), "p"],
        fine(battlements(6.5, 6.5, 57.5, 57.5, 8, 2.6), "t"), fine(rc(27, 55, 10, 6), "o"),
        [rc(15, 16, 34, 34), "x"], ...gable(26, 34, 38, 50), ...hip(15, 16, 49, 40),
        round(8, 8, 7), round(56, 8, 7), round(8, 56, 7), round(56, 56, 7),
      ]),
      // stone terrace with gold trim, four corner pavilions, cross-shaped hall under a gold dome
      landmark: make([
        [rc(3, 3, 58, 58), "x"], [rc(3, 3, 58, 58), "m"], [rc(6.5, 6.5, 51, 51), "T"],
        ...hip(6, 6, 22, 22), ...hip(42, 6, 58, 22), ...hip(6, 42, 22, 58), ...hip(42, 42, 58, 58),
        ...gable(23, 8, 41, 56), ...gable(8, 23, 56, 41), fine("M32 8V20M32 44V56M8 32H20M44 32H56", "T"),
        round(32, 32, 12, "G"),
      ]),
      // crenellated curtain wall with flat corner towers around a square donjon
      keep: make([
        [rc(4, 4, 56, 56), "x"], [rc(4, 4, 56, 56), "t"], [rc(13, 13, 38, 38), "p"],
        fine(battlements(5.8, 5.8, 58.2, 58.2, 9, 3), "d"),
        [rc(20, 20, 24, 24), "x"], [rc(20, 20, 24, 24), "t"], fine(battlements(21.6, 21.6, 42.4, 42.4, 4, 3), "d"),
        [rc(25, 25, 14, 14), "D"], ...corners(9.5, "t"), ...corners(5, "D", true),
      ]),
      // round tower: parapet of merlons around its floor, a hatch in the middle
      tower: make([
        [circ(32, 32, 27), "x"], [circ(32, 32, 27), "t"], fine(ring(32, 32, 23.5, 10, 5.5), "d"),
        [circ(32, 32, 16), "D"], fine(rc(28.5, 28.5, 7, 7), "k"),
      ]),
      // long hall to the north, fenced training yard with dummies to the south
      barracks: make([
        [rc(4, 34, 56, 26), "y"], fine(rc(4, 34, 56, 26), "F"),
        fine(circ(16, 48, 3.2) + circ(32, 52, 3.2) + circ(48, 48, 3.2), "o"),
        [rc(4, 5, 56, 28), "x"], ...gable(4, 5, 60, 33),
      ]),
      // narrow hall to the west, shooting yard with three targets to the east
      range: make([
        [rc(28, 4, 32, 56), "y"], fine(rc(28, 4, 32, 56), "F"),
        [circ(51, 13, 5.5) + circ(51, 32, 5.5) + circ(51, 51, 5.5), "z"],
        fine(circ(51, 13, 2.6) + circ(51, 32, 2.6) + circ(51, 51, 2.6), "e"),
        [rc(4, 4, 22, 56), "x"], ...gable(4, 4, 26, 60),
      ]),
      // three stable wings around a yard open to the south, hay bales in it
      stable: make([
        [rc(20, 20, 24, 40), "y"], fine(rc(23, 47, 8, 9) + rc(33, 50, 8, 8), "h"),
        [pg(4, 4, 60, 4, 60, 60, 44, 60, 44, 20, 20, 20, 20, 60, 4, 60), "x"],
        ...gable(4, 20, 20, 60), ...gable(44, 20, 60, 60), ...gable(4, 4, 60, 21),
      ]),
      // big square workshop under a pyramid roof, timber and a wheel in the yard around it
      workshop: make([
        [pg(44, 4, 60, 4, 60, 60, 4, 60, 4, 44, 44, 44), "y"],
        fine(rc(47, 9, 4, 28) + rc(53, 9, 4, 28), "o"), fine(circ(51, 52, 6) + "M45 52H57M51 46V58", "F"),
        [rc(4, 4, 40, 40), "x"], ...hip(4, 4, 44, 44),
      ]),
      // plank pier reaching into the water (turned by dockQuarter), boathouse on the shore side
      dock: make([
        [rc(6, 4, 52, 58), "x"], [rc(6, 4, 52, 58), "o"], fine("M6 12H58M6 20H58M6 28H58M6 36H58M6 44H58M6 52H58", "L"),
        fine(circ(9, 60, 2.6) + circ(55, 60, 2.6) + circ(9, 42, 2.6) + circ(55, 42, 2.6), "k"),
        [rc(12, 4, 40, 22), "x"], ...gable(12, 4, 52, 26),
      ], { foot: false }),
      // church with a cross-shaped roof and a tower over the crossing, in a garden
      monastery: make([
        [rc(4, 4, 56, 56), "v"],
        [pg(24, 4, 40, 4, 40, 18, 56, 18, 56, 32, 40, 32, 40, 60, 24, 60, 24, 32, 8, 32, 8, 18, 24, 18), "x"],
        ...gable(24, 4, 40, 60), ...gable(8, 18, 56, 32), ...hip(25, 17, 39, 33),
      ]),
      // forge hall, stone chimney glowing, anvil and coal in the yard
      blacksmith: make([
        [rc(4, 4, 56, 56), "y"], fine(circ(15, 54, 4.5) + circ(23, 55, 3.5), "k"),
        fine(pg(37, 52, 44, 49, 57, 49, 57, 55, 44, 55), "m"),
        [rc(4, 4, 38, 42), "x"], ...hip(4, 4, 42, 46),
        [rc(44, 8, 14, 14), "x"], [rc(44, 8, 14, 14), "m"], fine(rc(47, 11, 8, 8), "r"), fine(rc(49, 13, 4, 4), "a"),
      ]),
      // four wings around a garden court, a dome over the north wing
      university: make([
        [pg(4, 4, 60, 4, 60, 60, 4, 60), "x"], [rc(17, 17, 30, 30), "v"],
        ...gable(4, 16, 17, 48), ...gable(47, 16, 60, 48), ...gable(4, 47, 60, 60), ...gable(4, 4, 60, 17),
        round(32, 10.5, 9),
      ]),
      // paved square with six striped stalls and crates
      market: make([
        [rc(3, 3, 58, 58), "p"], fine(rc(28, 28, 8, 8) + rc(9, 27, 6, 6) + rc(50, 31, 6, 6), "o"),
        [stalls, "x"], [stalls, "z"],
        [STALLS.map(([x, y]) => rc(x + 2.5, y, 3, 14) + rc(x + 8.5, y, 3, 14)).join(""), "s"],
      ]),
      // small mill house with its four sails
      mill: make([[rc(17, 17, 30, 30), "x"], ...hip(17, 17, 47, 47), ...sails(), fine(circ(32, 32, 3.5), "k")]),
      // shed, stacks of logs
      lumber: make([
        [rc(6, 5, 52, 24), "x"], ...gable(6, 5, 58, 29),
        [rc(8, 34, 48, 6.5) + rc(8, 42, 48, 6.5) + rc(8, 50, 48, 6.5), "o"],
        fine([37.25, 45.25, 53.25].map(y => circ(8, y, 3.25) + circ(56, y, 3.25)).join(""), "l"),
      ]),
      // shed, piles of stone and gold ore, an ore cart
      mining: make([
        [rc(10, 5, 44, 24), "x"], ...hip(10, 5, 54, 29),
        [pg(5, 60, 8, 46, 16, 38, 25, 41, 31, 51, 31, 60) + pg(38, 36, 46, 33, 57, 36, 59, 43, 41, 44), "m"],
        fine(pg(11, 49, 15, 45, 19, 48, 16, 52) + pg(21, 55, 25, 51, 28, 55, 24, 58) + pg(47, 37, 51, 35, 53, 39, 49, 41),
          "a"),
        fine(rc(37, 48, 20, 9), "o"), fine(circ(40, 59, 2.4) + circ(54, 59, 2.4), "k"),
      ]),
      // small gabled house with a chimney (paintPlan mutes its colour)
      house: make([[rc(10, 14, 44, 36), "x"], ...gable(10, 14, 54, 50), fine(rc(40, 18, 6, 6), "m")]),
      // tilled field with crop rows, faint
      farm: make([
        [rc(1.5, 1.5, 61, 61), "c"], ["M9 6V58M18.5 6V58M28 6V58M37.5 6V58M47 6V58M56 6V58", "B"],
        [rc(1.5, 1.5, 61, 61), "O"],
      ], { foot: false, alpha: 0.55 }),
      // small hut
      other: make([[rc(14, 14, 36, 36), "x"], ...hip(14, 14, 50, 50)]),
    };
  })();

  // Lighting of building roofs: from the screen's upper left (a little nearer the top than the relief's diagonal, so
  // the four slopes of a hipped roof all differ at the default turn). For the current map turn: brightness of each
  // facet (north, east, south, west, -1..1) and the direction toward the light on the grid (lx, ly). Palettes are the
  // owner's colour shaded per tone, cached per colour until the turn changes.
  const BUILDING_LIGHT = { turn: NaN, facet: [0, 0, 0, 0], lx: 0, ly: 0, sx: -0.5, sy: -Math.sqrt(0.75) };
  const planPalettes = new Map();
  function planPalette(col, turn) {
    const L = BUILDING_LIGHT;
    if (turn !== L.turn) {
      const c = Math.cos(turn), s = Math.sin(turn);
      // the grid is drawn rotated by -turn: a grid vector (x, y) shows on screen as (x c + y s, y c - x s)
      L.turn = turn;
      L.lx = L.sx * c - L.sy * s; L.ly = L.sx * s + L.sy * c;
      L.facet = [-L.ly, L.lx, L.ly, -L.lx];
      planPalettes.clear();
    }
    let p = planPalettes.get(col);
    if (!p) {
      // brightness eased (|b|^0.6) so slopes half turned from the light still stand apart
      const q = v => Math.round(Math.pow(v, 0.6) * 50) / 50;
      const shade = b => b >= 0 ? mix(col, "#ffffff", q(b) * 0.34) : mix(col, "#000000", q(-b) * 0.42);
      p = {
        facet: L.facet.map(shade), t: col, s: col, d: mix(col, "#000000", 0.3), D: mix(col, "#000000", 0.55),
        R: mix(col, "#000000", 0.28), Rlit: mix(col, "#ffffff", 0.3), f: rgba(col, 0.22), O: rgba(col, 0.5),
      };
      planPalettes.set(col, p);
    }
    return p;
  }

  // One building as seen from above (BUILDING_PLAN), footprint side s px centred on (x, y), turned by `turn` like the
  // map and by `quarter` more quarter turns (docks face the water), shaded so the light stays at the screen's upper
  // left. Below PLAN_DETAIL_PX only its main shapes are drawn (no props or drop shadows, a thinner outline). Houses
  // are drawn in a muted owner's colour so bases read by their important buildings. Kinds with `badge` carry their
  // pictogram upright in a dark disc in the middle from BADGE_PX. Ghosts (last seen, not visible now) are faded with
  // a dashed footprint.
  function paintPlan(g, x, y, s, kind, col, ghost, turn, quarter = 0) {
    const plan = BUILDING_PLAN[kind] || BUILDING_PLAN.other, bt = BUILDING_TYPES[kind] || BUILDING_TYPES.other;
    const pal = planPalette(kind === "house" ? mix(col, "#9a8a70", 0.4) : col, turn), L = BUILDING_LIGHT;
    const detail = s >= PLAN_DETAIL_PX, k = s / 64, lw = Math.min(2.2, Math.max(detail ? 0.8 : 0.5, s / 40)) / k;
    let lx = L.lx, ly = L.ly;
    for (let i = 0; i < quarter; i++) [lx, ly] = [ly, -lx]; // the light as seen on a grid turned a quarter more
    g.save();
    g.translate(x, y); g.rotate(quarter * Math.PI / 2 - turn); g.scale(k, k); g.translate(-32, -32);
    g.globalAlpha = plan.alpha * (ghost ? 0.35 : 1);
    g.lineJoin = "round"; g.lineCap = "round";
    for (const part of plan.parts) {
      const t = part.t, p = part.p;
      if (part.fine && !detail) continue;
      switch (t) {
        case "x":
          if (!detail) continue;
          g.translate(-lx * 3.5, -ly * 3.5); g.fillStyle = "rgba(0,0,0,0.3)"; g.fill(p);
          g.translate(lx * 3.5, ly * 3.5);
          continue;
        case "L": g.strokeStyle = "rgba(11,14,20,0.55)"; g.lineWidth = lw * 0.6; g.stroke(p); continue;
        case "T": g.strokeStyle = PLAN_MAT.a; g.lineWidth = lw * 1.1; g.stroke(p); continue;
        case "F": g.strokeStyle = "#5a3d22"; g.lineWidth = lw * 1.3; g.stroke(p); continue;
        case "B": g.strokeStyle = "#b9b25a"; g.lineWidth = 3.2; g.stroke(p); continue;
        case "O": g.strokeStyle = pal.O; g.lineWidth = lw; g.stroke(p); continue;
      }
      if (!PLAN_FLAT.has(t)) { g.strokeStyle = CASING; g.lineWidth = lw; g.stroke(p); }
      g.fillStyle = typeof t === "number" ? pal.facet[(t + quarter) & 3] : t === "R" ? pal.R : t === "G" ? "#b8862a"
        : pal[t] || PLAN_MAT[t];
      g.fill(p);
      if (part.lit) {
        const o = part.r * 0.28;
        g.translate(lx * o, ly * o); g.fillStyle = t === "G" ? "#ffe08a" : pal.Rlit; g.fill(part.lit);
        g.translate(-lx * o, -ly * o);
      }
    }
    g.restore();
    if (ghost) {
      squarePath(g, x, y, s / 2, turn);
      g.setLineDash([4, 3]); g.strokeStyle = rgba(col, 0.75); g.lineWidth = 1.2; g.stroke(); g.setLineDash([]);
    }
    if (!bt.badge || s < BADGE_PX) return;
    const r = Math.min(10, Math.max(4.5, s * 0.12));
    g.globalAlpha = ghost ? 0.4 : 1;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = "rgba(11,14,20,0.72)"; g.fill();
    glyph(g, bt.glyph, x, y, r * 0.66, "#f3f4f6");
    g.globalAlpha = 1;
  }

  // Quarter turns that point a dock's pier (grid south) at the water: the lowest of the four terrain samples around
  // it, cached on the entity. 0 without a height grid.
  function dockQuarter(M, e) {
    if (e.dockQuarter != null) return e.dockQuarter;
    const T = M.terrain;
    if (!T) return e.dockQuarter = 0;
    const at = (x, z) => {
      const c = Math.min(T.cols - 1, Math.max(0, Math.round((x - T.x0) / T.step)));
      const r = Math.min(T.rows - 1, Math.max(0, Math.round((z - T.z0) / T.step)));
      return T.h[r * T.cols + c];
    };
    // grid south turned 0..3 quarters clockwise points to world -z, -x, +z, +x
    const depth = [at(e.px, e.pz - 8), at(e.px - 8, e.pz), at(e.px, e.pz + 8), at(e.px + 8, e.pz)];
    return e.dockQuarter = depth.indexOf(Math.min(...depth));
  }

  // Plans on the map (paintPlan) pre-rendered at devicePixelRatio into atlas pages (packed in rows), so a late game's
  // hundreds of farms and houses are a drawImage each from one canvas. Sprites are kept for one turn and zoom
  // (dropped when either changes) and only made once those have held for PLAN_SPRITE_SETTLE_MS, so turning the
  // compass or zooming draws plans directly. Plans bigger than PLAN_SPRITE_MAX_PX are always drawn directly (few fit
  // on screen), and so is any plan once PLAN_ATLAS_PAGES pages are full.
  const PLAN_SPRITE_MAX_PX = 64;
  const PLAN_SPRITE_SETTLE_MS = 150;
  const PLAN_ATLAS_PX = 1024;  // atlas page side in device pixels
  const PLAN_ATLAS_PAGES = 4;
  // sprites by colour then kind; atlas page contexts, the one being filled and the free spot in its current row
  const planSprites = { turn: NaN, scale: NaN, dpr: NaN, since: 0, map: new Map(), pages: [], page: -1, x: 0, y: 0,
    row: 0 };
  function drawPlan(g, x, y, s, kind, col, ghost, turn, scale, quarter) {
    const S = planSprites, now = performance.now(), dpr = window.devicePixelRatio || 1;
    if (turn !== S.turn || scale !== S.scale || dpr !== S.dpr) {
      S.turn = turn; S.scale = scale; S.dpr = dpr; S.since = now; S.map.clear();
      S.page = -1; S.x = S.y = S.row = PLAN_ATLAS_PX;
    }
    if (s > PLAN_SPRITE_MAX_PX || now - S.since < PLAN_SPRITE_SETTLE_MS) {
      paintPlan(g, x, y, s, kind, col, ghost, turn, quarter);
      return;
    }
    // one map per colour; the size follows from kind and zoom
    let byCol = S.map.get(col);
    if (!byCol) S.map.set(col, byCol = new Map());
    const key = ghost || quarter ? kind + quarter + (ghost ? "g" : "") : kind;
    let sp = byCol.get(key);
    if (!sp) {
      // the turned footprint, its outline and drop shadow, centred on a whole device pixel; 1 px apart
      const n = 2 * Math.ceil((s / 2 * turnReach(turn) + 2 + s * 0.06) * dpr);
      if (S.x + n > PLAN_ATLAS_PX) { S.x = 0; S.y += S.row + 1; S.row = 0; }
      if (S.y + n > PLAN_ATLAS_PX) {
        if (S.page + 1 >= PLAN_ATLAS_PAGES) { paintPlan(g, x, y, s, kind, col, ghost, turn, quarter); return; }
        if (++S.page === S.pages.length) {
          const cv = document.createElement("canvas");
          cv.width = cv.height = PLAN_ATLAS_PX;
          S.pages.push(cv.getContext("2d"));
        } else S.pages[S.page].clearRect(0, 0, PLAN_ATLAS_PX, PLAN_ATLAS_PX);
        S.x = S.y = S.row = 0;
      }
      const c = S.pages[S.page];
      c.save();
      c.setTransform(dpr, 0, 0, dpr, S.x, S.y);
      c.beginPath(); c.rect(0, 0, n / dpr, n / dpr); c.clip();
      paintPlan(c, n / 2 / dpr, n / 2 / dpr, s, kind, col, ghost, turn, quarter);
      c.restore();
      byCol.set(key, sp = { cv: c.canvas, sx: S.x, sy: S.y, n, w: n / dpr });
      S.x += n + 1; S.row = Math.max(S.row, n);
    }
    const dx = Math.round((x - sp.w / 2) * dpr) / dpr, dy = Math.round((y - sp.w / 2) * dpr) / dpr;
    g.drawImage(sp.cv, sp.sx, sp.sy, sp.n, sp.n, dx, dy, sp.w, sp.w);
  }

  // One wall piece on top of the wall lines, turned by `turn` like the map.
  function paintWallNode(g, x, y, s, kind, col, turn = 0) {
    squarePath(g, x, y, s / 2, turn);
    g.fillStyle = kind === "aqueduct" ? mix(col, "#7dd3fc", 0.55) : col;
    g.fill();
    g.strokeStyle = CASING; g.lineWidth = 1;
    g.stroke();
  }

  // A gate: a pale opening of length len across a wall line of width w, between two posts in the owner's colour, with
  // a seam between the two doors; ang turns it along the wall.
  const GATE_FILL = "#f3e3c3";
  function paintGate(g, x, y, len, w, ang, col) {
    const h = len / 2, t = w + 4, p = t + 1;
    g.save();
    g.translate(x, y);
    g.rotate(ang);
    g.fillStyle = CASING; g.fillRect(-h - 1, -t / 2 - 1, len + 2, t + 2);
    g.fillStyle = GATE_FILL; g.fillRect(-h, -t / 2, len, t);
    g.fillStyle = CASING; g.fillRect(-0.5, -t / 2, 1, t);
    g.strokeStyle = CASING; g.lineWidth = 1;
    for (const px of [-h, h]) {
      g.fillStyle = col; g.fillRect(px - p / 2, -p / 2, p, p);
      g.strokeRect(px - p / 2, -p / 2, p, p);
    }
    g.restore();
  }

  // Half-size of a mine's pile icon on a footprint of half-side r: about the in-game icon's size at any zoom.
  function mineIconR(r) {
    return Math.min(13, Math.max(5, r * 0.6));
  }

  // Gold mine icon: a pile of three bars, half-size k.
  function paintGoldPile(g, x, y, k) {
    const hb = k * 0.475, ht = k * 0.3, bh = k * 0.62;
    g.lineWidth = Math.max(1, k * 0.13); g.lineJoin = "round"; g.strokeStyle = CASING;
    for (const [dx, dy] of [[-0.5, 0.71], [0.5, 0.71], [0, 0.01]]) { // bar feet; the top bar rests on the two below
      const bx = x + dx * k, by = y + dy * k;
      g.beginPath();
      g.moveTo(bx - hb, by); g.lineTo(bx - ht, by - bh); g.lineTo(bx + ht, by - bh); g.lineTo(bx + hb, by);
      g.closePath();
      g.fillStyle = "#e8b62c"; g.fill(); g.stroke();
      if (k >= 7) {
        g.strokeStyle = "#fff1b8";
        g.beginPath(); g.moveTo(bx - ht + 1.5, by - bh + 2); g.lineTo(bx + ht - 1.5, by - bh + 2); g.stroke();
        g.strokeStyle = CASING;
      }
    }
    g.lineJoin = "miter";
  }

  // Stone mine icon: a pile of three grey rocks, half-size k.
  function paintStonePile(g, x, y, k) {
    g.lineWidth = Math.max(1, k * 0.12); g.lineJoin = "round"; g.strokeStyle = CASING;
    for (const [dx, dy, s, fill] of [[0.05, -0.28, 0.62, "#a2a6ab"], [-0.45, 0.3, 0.5, "#c3c6ca"], [0.48, 0.32, 0.46, "#b5b9bd"]]) {
      const rx = x + dx * k, ry = y + dy * k;
      poly(g, rx, ry, s * k, ROCK); g.fillStyle = fill; g.fill(); g.stroke();
      if (k >= 7) {
        g.strokeStyle = "rgba(255,255,255,0.65)";
        g.beginPath(); g.moveTo(rx - s * k * 0.45, ry - s * k * 0.05); g.lineTo(rx - s * k * 0.05, ry - s * k * 0.5); g.stroke();
        g.strokeStyle = CASING;
      }
    }
    g.lineJoin = "miter";
  }

  // One map object of `kind` with screen radius r. With `art` (big enough), its GAIA_ART picture: animals, bushes,
  // fish and relics alone, upright and facing right; outcrops on mines', the stall on the trade post's footprint
  // and the shrine in the sacred site's ring. Otherwise a symbol styled like the in-game minimap: a pile of gold bars
  // or grey rocks on the mine's square footprint (turned by `turn` like the map), a green bush, white deer and sheep,
  // all outlined in dark, and a cut stump on a tree being chopped. `left` (0..1) fades mines and bushes and shrinks
  // the stump's light part as they are gathered; `owner` (a player colour) marks a captured sacred site.
  function paintGaia(g, x, y, r, kind, left, owner, turn = 0, art = false) {
    const st = GAIA_STYLE[kind], col = st.color, tau = Math.PI * 2, pic = art ? GAIA_ART[kind] : null;
    if (pic && !pic.ground) {
      if (kind === "berry") g.globalAlpha = 0.4 + 0.6 * left;
      paintGaiaArt(g, x, y, r, pic, pic.tones, kind === "wolf" ? HOSTILE : null);
      g.globalAlpha = 1;
      return;
    }
    g.lineWidth = 1;
    g.strokeStyle = CASING;
    switch (kind) {
      case "chopped":
        // a stump: dark wood, its light cut face a pie of the wood left (just a light dot when small)
        g.beginPath(); g.arc(x, y, r, 0, tau);
        g.fillStyle = r < 3.5 ? col : mix(col, "#000000", 0.55); g.fill(); g.stroke();
        if (r >= 3.5 && left > 0) {
          g.beginPath(); g.moveTo(x, y); g.arc(x, y, r - 1, -Math.PI / 2, -Math.PI / 2 + tau * left); g.closePath();
          g.fillStyle = col; g.fill();
        }
        break;
      case "gold": case "stone":
        // the mine's footprint (r = half its side) as darkened ground, with the pile or outcrop on it
        squarePath(g, x, y, r, turn);
        g.fillStyle = rgba(mix(col, "#000000", 0.5), 0.2 + 0.3 * left);
        g.fill();
        g.strokeStyle = rgba(CASING, 0.6); g.stroke();
        g.globalAlpha = 0.45 + 0.55 * left;
        if (pic) paintGaiaArt(g, x, y, r, pic, pic.tones);
        else (kind === "gold" ? paintGoldPile : paintStonePile)(g, x, y, mineIconR(r));
        g.globalAlpha = 1;
        break;
      case "berry":
        // a bush: a dome on a flat foot (a dot when small)
        g.fillStyle = rgba(col, 0.4 + 0.6 * left);
        g.beginPath();
        if (r < 3) g.arc(x, y, r, 0, tau);
        else { g.arc(x, y + r * 0.4, r * 1.05, Math.PI, 0); g.closePath(); }
        g.fill(); g.stroke();
        break;
      case "fish":
        g.fillStyle = col;
        g.beginPath(); g.ellipse(x - r * 0.25, y, r * 0.95, r * 0.55, 0, 0, tau);
        g.moveTo(x + r * 0.5, y); g.lineTo(x + r * 1.15, y - r * 0.55); g.lineTo(x + r * 1.15, y + r * 0.55); g.closePath();
        g.fill(); g.stroke();
        break;
      case "relic":
        g.lineCap = "square";
        g.beginPath(); g.moveTo(x, y - r); g.lineTo(x, y + r); g.moveTo(x - r * 0.6, y - r * 0.35); g.lineTo(x + r * 0.6, y - r * 0.35);
        g.lineWidth = r * 0.5 + 2; g.stroke();
        g.strokeStyle = col; g.lineWidth = r * 0.5; g.stroke();
        g.lineCap = "butt";
        break;
      case "sacred": {
        // captured: filled and ringed in the holder's colour, the gold star outlined so it still reads as a site;
        // big, a shrine instead of the star, roofed in the holder's colour
        const c = owner || col;
        g.fillStyle = rgba(c, owner ? 0.28 : 0.12);
        g.beginPath(); g.arc(x, y, r, 0, tau); g.fill();
        g.lineWidth = owner ? 6 : 4.5; g.stroke();
        g.strokeStyle = c; g.lineWidth = owner ? 3.5 : 2.5; g.stroke();
        if (pic) { paintGaiaArt(g, x, y, r, pic, ownTones(pic, c)); break; }
        const k = Math.min(7, r * 0.4);
        g.beginPath();
        for (let i = 0; i < 10; i++) {
          const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? k * 0.45 : k;
          i ? g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr) : g.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
        }
        g.closePath(); g.fillStyle = c; g.fill();
        if (owner) { g.strokeStyle = col; g.lineWidth = 1.5; g.stroke(); }
        break;
      }
      case "trade": {
        squarePath(g, x, y, r, turn);
        g.fillStyle = rgba(col, 0.35); g.fill();
        g.strokeStyle = col; g.lineWidth = 1.5; g.stroke();
        if (pic) { paintGaiaArt(g, x, y, r, pic, pic.tones); break; }
        const k = Math.min(r * 0.7, 12);
        g.fillStyle = g.strokeStyle = "#fef3c7"; g.lineWidth = Math.max(1, k * 0.15);
        g.beginPath(); g.moveTo(x - k * 0.35, y + k * 0.8); g.lineTo(x - k * 0.35, y - k * 0.8); g.stroke();
        poly(g, x, y, k, [-0.35, -0.8, 0.6, -0.5, -0.35, -0.2]); g.fill();
        break;
      }
      case "deer":
        // white, with antlers once big enough to draw them
        if (r >= 3.5) {
          g.beginPath();
          for (const d of [-1, 1]) {
            g.moveTo(x + d * r * 0.3, y - r * 0.5); g.lineTo(x + d * r * 0.8, y - r * 1.3);
            g.moveTo(x + d * r * 0.55, y - r * 0.9); g.lineTo(x + d * r * 1.1, y - r * 0.85);
          }
          g.lineCap = "round";
          g.lineWidth = 3; g.stroke();
          g.strokeStyle = col; g.lineWidth = 1.2; g.stroke();
          g.lineCap = "butt";
          g.strokeStyle = CASING; g.lineWidth = 1;
        }
        g.fillStyle = col;
        g.beginPath(); g.ellipse(x, y, r * 0.75, r * 0.95, 0, 0, tau); g.fill(); g.stroke();
        break;
      case "sheep":
        // white fleece with a dark head
        g.fillStyle = col;
        g.beginPath(); g.ellipse(x, y, r * 1.2, r * 0.85, 0, 0, tau); g.fill(); g.stroke();
        if (r >= 3) { g.fillStyle = "#3f3f46"; g.beginPath(); g.arc(x + r * 1.1, y - r * 0.2, r * 0.4, 0, tau); g.fill(); g.stroke(); }
        break;
      default: // boar, wolf
        g.fillStyle = col;
        g.beginPath(); g.ellipse(x, y, r * 1.2, r * 0.8, 0, 0, tau); g.fill();
        if (kind === "wolf") { g.strokeStyle = HOSTILE; g.lineWidth = 1.5; }
        g.stroke();
        if (kind === "boar" && r >= 4) {
          g.strokeStyle = "#f5f5f4"; g.lineWidth = 1.2;
          g.beginPath(); g.moveTo(x + r * 0.9, y - r * 0.3); g.lineTo(x + r * 1.4, y - r * 0.6);
          g.moveTo(x + r * 0.9, y + r * 0.3); g.lineTo(x + r * 1.4, y + r * 0.6); g.stroke();
        }
    }
  }

  // Map-object art on UNIT_ART's 64 px grid, as [Path2D, tone] with tones named per kind (`tones`; b = the main
  // colour, no thin outline of its own; k = dark detail, no casing). The grid spans `size` x r px centred on the
  // object: animals (facing right, hooves on the grid's bottom), bushes, fish and relics fill its width; `ground`
  // kinds are drawn by paintGaia on their footprint or ring (mines' outcrops, the trade post's stall, the sacred
  // site's shrine). ownTones sets c to an owner's colour (sacred site's roof, claimed sheep's collar) and d to its shade.
  const HOSTILE = "#ef4444"; // rim around wolves
  const ROCKS = [ // three boulders, front faces r and lit tops l, shared by both mines
    ["M14 42 L17 26 L29 15 L42 18 L51 30 L49 42 Z", "r"], ["M17 26 L29 15 L42 18 L35 25 Z", "l"],
    ["M3 55 L7 40 L19 33 L30 40 L29 56 Z", "r"], ["M7 40 L19 33 L30 40 L18 44 Z", "l"],
    ["M29 56 L31 41 L45 34 L58 40 L61 55 Z", "r"], ["M31 41 L45 34 L58 40 L45 45 Z", "l"],
  ];
  const SHEEP = [ // dark legs and face, woolly cloud of a body
    [bar(20, 40, 20, 57, 3.6), "f"], [bar(26, 41, 27, 57, 3.6), "f"], [bar(40, 41, 40, 57, 3.6), "f"],
    [bar(46, 40, 47, 57, 3.6), "f"],
    ["M12 34 Q8 28 14 24 Q16 18 23 19 Q28 14 34 18 Q40 14 45 19 Q51 19 52 25 Q56 32 50 37 Q48 44 40 43 " +
      "Q34 46 28 43 Q21 46 17 41 Q10 40 12 34 Z", "b"],
    ["M47 24 Q48 17 54 17 L61 24 Q63 28 59 30 L54 30 Q47 30 47 24 Z", "f"], ["M49 20 L42 21 L47 25 Z", "f"],
  ];
  const GAIA_ART = {
    gold: { // dark boulders banded with gold veins, nuggets on top and at their foot
      size: 1.9, ground: true, tones: { r: "#7a7166", l: "#9b9184", b: "#e8b62c", y: "#fde68a" },
      parts: artParts([...ROCKS,
        ["M17 30 L25 26 L32 29 L40 25 L50 30 L50.5 34 L40 29.5 L32 33.5 L25 30.5 L16.5 34.5 Z", "b"],
        ["M6 46 L13 43 L19 46 L29.3 44 L29.2 48.5 L19 50.5 L13 47.5 L5 50.5 Z", "b"],
        ["M30.6 47 L38 44 L45 47 L53 44 L60.6 47 L60.7 51 L53 48.5 L45 51.5 L38 48.5 L30.2 51.5 Z", "b"],
        ["M24 19 L29 17 L30.5 21 L25 22.5 Z", "y"], ["M45 38 L50 37 L50 40.5 Z", "y"],
        [circ(20, 58, 3.2), "b"], [circ(27, 59.5, 2.6), "y"], [circ(47, 58.5, 3), "b"], [circ(54, 59.5, 2.4), "y"]]),
    },
    stone: { // pale grey boulders, cracked, rubble at their foot
      size: 1.9, ground: true, tones: { r: "#9ea3a9", l: "#cfd2d6", b: "#b9bcc0" },
      parts: artParts([...ROCKS,
        [bar(29, 26, 33, 36, 1.3), "k"], [bar(14, 47, 20, 52, 1.3), "k"], [bar(47, 45, 44, 52, 1.3), "k"],
        [circ(25, 58, 2.8), "b"], [circ(33, 59, 2.2), "l"], [circ(52, 58, 2.6), "b"]]),
    },
    berry: { // round bush, darker leaf clumps, red berries
      size: 2.4, tones: { b: "#4f9a3c", d: "#2f6b2a", w: "#d9344a" },
      parts: artParts([
        ["M6 50 Q3 39 11 35 Q10 24 22 23 Q26 12 37 15 Q49 12 52 25 Q61 29 58 41 Q61 50 54 52 L10 52 Q6 52 6 50 Z", "b"],
        ["M12 46 Q18 37 27 42 Q20 49 12 46 Z", "d"], ["M35 29 Q44 24 49 33 Q41 37 35 29 Z", "d"],
        ["M21 30 Q25 24 31 28 Q26 33 21 30 Z", "d"],
        [circ(18, 36, 3.4), "w"], [circ(29, 23, 3.4), "w"], [circ(42, 21, 3.4), "w"], [circ(50, 38, 3.4), "w"],
        [circ(32, 39, 3.4), "w"], [circ(42, 46, 3.4), "w"], [circ(18, 47, 3.2), "w"], [circ(40, 32, 3), "w"]]),
    },
    fish: { // blue fish over a ripple
      size: 2.5, tones: { b: "#38bdf8", d: "#0e7490", l: "#bae6fd" },
      parts: artParts([
        ["M4 46 Q32 57 60 46 Q32 52 4 46 Z", "l"], ["M3 16 L18 30 L3 44 L9 30 Z", "d"],
        ["M27 19 L35 9 L44 18 Z", "d"], ["M32 41 L36 49 L43 42 Z", "d"],
        ["M14 30 Q24 16 42 17 Q57 19 62 30 Q57 41 42 43 Q24 44 14 30 Z", "b"],
        ["M24 35 Q40 43 57 35 Q50 41 42 42 Q30 42 24 35 Z", "l"], [bar(47, 22, 46, 37, 1.4), "k"], [circ(53, 26, 2), "k"]]),
    },
    deer: { // tan, white tail, antlers
      size: 2.6, tones: { b: "#a8703e", s: "#efe6d4", w: "#e8dcc0" },
      parts: artParts([
        [bar(17, 38, 14, 59, 3.4), "b"], [bar(23, 39, 24, 59, 3.4), "b"], [bar(42, 38, 41, 59, 3.4), "b"],
        [bar(47, 37, 50, 59, 3.4), "b"], ["M16 27 L9 24 L12 32 Z", "s"],
        ["M14 31 Q14 24 22 24 L41 24 L46 20 L50 9 Q51 6 54 7 L60 11 Q63 13 61 16 L55 17 L52 28 Q50 41 41 41 " +
          "L22 41 Q14 41 14 33 Z", "b"],
        ["M49 9 L43 6 L47 13 Z", "b"],
        [bar(50, 8, 45, 0.5, 2), "w"], [bar(47.5, 4, 42, 2.5, 1.8), "w"], [bar(53, 7, 58, 0.5, 2), "w"],
        [bar(55.5, 3.5, 60.5, 4.5, 1.8), "w"], [circ(55.5, 11, 1.3), "k"], [circ(61.5, 14, 1.1), "k"]]),
    },
    boar: { // dark bristly back, white tusk
      size: 2.6, tones: { b: "#6e4a32", d: "#3f2a1d", s: "#f1ece0" },
      parts: artParts([
        [bar(17, 40, 16, 57, 4.6), "b"], [bar(24, 41, 25, 57, 4.6), "b"], [bar(40, 41, 39, 57, 4.6), "b"],
        [bar(46, 40, 47, 57, 4.6), "b"], [bar(9, 29, 4, 35, 1.6), "k"],
        ["M8 33 Q8 21 22 19 L38 19 Q47 19 52 26 L60 30 Q63 32 62 36 L59 40 L50 41 Q45 46 36 46 L19 46 Q8 46 8 33 Z", "b"],
        ["M13 23 L18 15 L22 19 L27 13 L31 18 L36 13 L39 19 L45 18 L44 24 Q30 20 13 26 Z", "d"],
        ["M59 30 L63 32 L62 38 L58 38 Z", "d"], ["M45 22 L46 14 L51 22 Z", "d"],
        ["M53 39 Q60 38 59 30 Q57 36 52 35 Z", "s"], [circ(51, 27, 1.4), "k"]]),
    },
    wolf: { // grey, darker back and bushy tail, red eye; paintGaia rims it in HOSTILE
      size: 2.6, tones: { b: "#8f98a3", d: "#59616c", w: HOSTILE },
      parts: artParts([
        ["M16 26 Q5 25 1 37 Q0 44 4 44 Q8 37 17 34 Z", "d"],
        [bar(18, 37, 16, 58, 3.4), "b"], [bar(23, 38, 24, 58, 3.4), "b"], [bar(41, 37, 41, 58, 3.4), "b"],
        [bar(46, 36, 48, 58, 3.4), "b"],
        ["M13 31 Q13 24 21 24 L40 24 Q44 24 47 19 Q49 15 53 15 L56 16 L63 21 Q64 25 60 25 L55 25 Q53 27 52 31 " +
          "Q49 40 40 40 L21 40 Q13 40 13 33 Z", "b"],
        ["M20 24 L40 24 Q44 24 46 21 L44 29 L22 29 Z", "d"], ["M49 17 L51 8 L56 15 Z", "d"],
        [bar(57, 24.5, 62, 24, 1), "k"], [circ(55.5, 19, 1.6), "w"]]),
    },
    sheep: { size: 2.6, tones: { b: "#f2f1ec", f: "#3a3a40" }, parts: artParts(SHEEP) },
    relic: { // golden reliquary: gabled lid, cross, gems
      size: 2.2, tones: { b: "#e8b62c", y: "#f8dc7a", d: "#9a6b12", w: "#c0392b", g: "#2563eb" },
      parts: artParts([
        ["M8 50 L56 50 L58 58 L6 58 Z", "d"], ["M13 30 L51 30 L51 50 L13 50 Z", "b"], ["M13 43 L51 43 L51 46 L13 46 Z", "d"],
        ["M9 32 L32 16 L55 32 Z", "y"], [bar(32, 3, 32, 17, 3.6), "y"], [bar(26.5, 8, 37.5, 8, 3.6), "y"],
        [circ(21, 37, 2.6), "w"], [circ(32, 37, 3), "g"], [circ(43, 37, 2.6), "w"]]),
    },
    sacred: { // small temple: stone steps and pillars, roof (holder's colour once captured), flame on top
      size: 1.25, ground: true, tones: { c: "#fbbf24", d: "#a8760f", s: "#e4dccb", e: "#a29b93", y: "#f3d27a" },
      parts: artParts([
        ["M8 52 L56 52 L58 60 L6 60 Z", "e"], ["M15 30 L22 30 L22 52 L15 52 Z", "s"],
        ["M28.5 30 L35.5 30 L35.5 52 L28.5 52 Z", "s"], ["M42 30 L49 30 L49 52 L42 52 Z", "s"],
        ["M11 26 L53 26 L53 31 L11 31 Z", "d"], ["M9 26 L32 10 L55 26 Z", "c"], [circ(32, 6, 3.6), "y"]]),
    },
    trade: { // market stall: striped awning on poles, counter with a sack, a jar and coins
      size: 1.8, ground: true, tones: { b: "#d97706", s: "#e9e4d8", o: "#a87a46", t: "#d8b36a", y: "#f3d27a", c: "#b45309" },
      parts: artParts([
        [bar(12, 20, 12, 58, 3), "o"], [bar(52, 20, 52, 58, 3), "o"], ["M8 41 L56 41 L56 56 L8 56 Z", "o"],
        ["M14 41 Q14 30 21 30 Q28 30 28 41 Z", "t"], ["M32 41 L31 34 Q31 29 36 29 Q41 29 41 34 L40 41 Z", "c"],
        [circ(48, 38, 3), "y"], ["M4 24 L12 12 L52 12 L60 24 Z", "b"],
        ["M20 12 L27 12 L25 24 L16 24 Z", "s"], ["M37 12 L44 12 L48 24 L39 24 Z", "s"]]),
    },
  };
  // A claimed sheep (paintUnit, at unit radius r): the sheep art with a collar and rim in the owner's colour, so even
  // a tiny one reads as a coloured blob with a white middle. Drawn a little wider than wild sheep, whose world radius
  // is bigger but which stop growing sooner, so the two look about the same size at any zoom.
  const CLAIMED_SHEEP = {
    size: 2.9, tones: GAIA_ART.sheep.tones,
    parts: artParts([...SHEEP, [bar(49.5, 18, 50.5, 31, 3.6), "c"]]),
  };

  // Tones of `pic` with c set to the owner colour `col` and d to its darker shade, cached per colour.
  const ownToneCache = new Map();
  function ownTones(pic, col) {
    let by = ownToneCache.get(pic);
    if (!by) ownToneCache.set(pic, by = new Map());
    let t = by.get(col);
    if (!t) by.set(col, t = { ...pic.tones, c: col, d: mix(col, "#000000", 0.45) });
    return t;
  }

  // GAIA_ART `pic` at screen radius r centred on (x, y) in `tones`, outlined like paintArt: every part but dark
  // details in CASING (with a wider `rim` in that colour around it all, if given), parts but the main colour also
  // with a thin outline of their own. The outline scales with the picture up to 3 px.
  function paintGaiaArt(g, x, y, r, pic, tones, rim = null) {
    const k = r * pic.size / 64, lw = Math.min(3, Math.max(1, k * 5));
    g.save();
    g.translate(x - 32 * k, y - 32 * k); g.scale(k, k);
    g.lineJoin = "round"; g.lineCap = "round";
    if (rim) {
      g.strokeStyle = rim; g.lineWidth = (lw + 3) / k;
      for (const [p, tone] of pic.parts) if (tone !== "k") g.stroke(p);
    }
    g.strokeStyle = CASING; g.lineWidth = lw / k;
    for (const [p, tone] of pic.parts) if (tone !== "k") g.stroke(p);
    g.lineWidth = lw * 0.55 / k;
    for (const [p, tone] of pic.parts) {
      if (tone !== "b" && tone !== "k") g.stroke(p);
      g.fillStyle = tone === "k" ? CASING : tones[tone];
      g.fill(p);
    }
    g.restore();
  }

  // A claimed sheep in the owner's colour `col` (see CLAIMED_SHEEP).
  function paintClaimedSheep(g, x, y, r, col) {
    paintGaiaArt(g, x, y, r, CLAIMED_SHEEP, ownTones(CLAIMED_SHEEP, col), col);
  }

  // Death mark: X with a dark outline, alpha a.
  function paintCross(g, x, y, s, col, a) {
    g.beginPath(); g.moveTo(x - s, y - s); g.lineTo(x + s, y + s); g.moveTo(x + s, y - s); g.lineTo(x - s, y + s);
    g.lineCap = "round";
    g.strokeStyle = `rgba(11,14,20,${0.85 * a})`; g.lineWidth = 4.5; g.stroke();
    g.strokeStyle = rgba(col, a); g.lineWidth = 2; g.stroke();
    g.lineCap = "butt";
  }

  // Data URLs of icons drawn like the map, for the legend and panels; cached by key.
  const iconCache = new Map();
  function iconURL(key, px, paint) {
    let url = iconCache.get(key);
    if (!url) {
      const dpr = window.devicePixelRatio || 1, cv = document.createElement("canvas");
      cv.width = cv.height = Math.ceil(px * dpr);
      const g = cv.getContext("2d");
      g.scale(dpr, dpr);
      paint(g, px / 2, px);
      url = cv.toDataURL();
      iconCache.set(key, url);
    }
    return url;
  }

  // How far above (or with `below`, under) its position a unit drawn at screen radius r reaches: its art grid's edge.
  function unitReach(type, r, below) {
    const half = ((UNIT_ART[type] || {}).size || FIGURE_SIZE) / 2;
    return (below ? half + FIGURE_DY : half - FIGURE_DY) * r;
  }
  // The figure fitted to the icon, casing included (wide figures and standing ones alike fill their grid, so it fits
  // by its size).
  RV.unitIcon = (type, color, px) => iconURL(`u|${type}|${color}|${px}`, px, (g, c, n) => {
    const r = (n - 1) / ((UNIT_ART[type] || {}).size || FIGURE_SIZE);
    paintUnit(g, c, c - r * FIGURE_DY, r, type, null, color);
  });

  // Buildings as on the map: the plan seen from above at the default turn, its turned footprint fitted to the icon;
  // wall-like kinds as a short line.
  RV.buildingIcon = (kind, color, px) => iconURL(`b|${kind}|${color}|${px}`, px, (g, c, n) => {
    if (!BUILDING_TYPES[kind].line) {
      paintPlan(g, c, c, (n - 2) / turnReach(DEFAULT_TURN), kind, color, false, DEFAULT_TURN);
      return;
    }
    const path = new Path2D(), w = kind === "aqueduct" ? 2.5 : 3;
    path.moveTo(2, n - 4); path.lineTo(n - 2, 4);
    g.lineCap = "round";
    g.strokeStyle = CASING; g.lineWidth = w + 2; g.stroke(path);
    g.strokeStyle = kind === "aqueduct" ? mix(color, "#7dd3fc", 0.55) : color; g.lineWidth = w; g.stroke(path);
    g.lineCap = "butt";
    if (kind === "gate") paintGate(g, c, c, n * 0.62, w, -Math.PI / 4, color);
    else paintWallNode(g, c, c, w + 1, kind, color);
  });

  RV.gaiaIcon = (kind, px) => iconURL(`g|${kind}|${px}`, px, (g, c, n) => {
    if (TREES.includes(kind)) { // a flat patch of canopy on ground, as drawGaia draws forests
      const k = n * 0.24;
      g.fillStyle = GROUND;
      g.beginPath(); g.roundRect(0.5, 0.5, n - 1, n - 1, 3); g.fill();
      g.fillStyle = GAIA_STYLE[kind].color;
      g.beginPath();
      for (const [dx, dy] of [[-0.17, 0.12], [0.17, 0.12], [0, -0.16]]) {
        g.moveTo(c + dx * n + k, c + dy * n); g.arc(c + dx * n, c + dy * n, k, 0, Math.PI * 2);
      }
      g.fill();
      return;
    }
    // from 20 px the GAIA_ART picture (free-standing ones filling the icon's width), smaller the symbol
    const turned = kind === "gold" || kind === "stone" || kind === "trade"; // footprints turn like the map
    const pic = px >= 20 ? GAIA_ART[kind] : null;
    if (pic && !pic.ground) { paintGaia(g, c, c, (n - 1) / pic.size, kind, 1, null, 0, true); return; }
    const r = kind === "sacred" ? c - 1.5 : kind === "trade" ? (c - 1.5) / turnReach(DEFAULT_TURN) : turned ? n * 0.33 : kind === "sheep" ? n * 0.3 : n * 0.36;
    paintGaia(g, kind === "fish" || kind === "sheep" ? c - 1 : c, c, r, kind, kind === "chopped" ? 0.6 : 1, null,
      turned ? DEFAULT_TURN : 0, !!pic);
  });

  RV.markIcon = (kind, px) => iconURL(`m|${kind}|${px}`, px, (g, c, n) => {
    const ink = "#e5e7eb";
    switch (kind) {
      case "attack":
        g.strokeStyle = rgba(ink, 0.35); g.lineWidth = 1;
        g.beginPath(); g.moveTo(1, n - 2); g.lineTo(n * 0.45, n * 0.55); g.stroke();
        g.strokeStyle = ink; g.lineWidth = 1.8;
        g.beginPath(); g.moveTo(n * 0.45, n * 0.55); g.lineTo(n - 5, 5); g.stroke();
        poly(g, n - 2, 2, 1, [0, 0, -6.4, 2.1, -2.1, 6.4]); g.fillStyle = ink; g.fill();
        break;
      case "order":
        g.strokeStyle = ink; g.lineWidth = 1; g.setLineDash([3, 2]);
        g.beginPath(); g.moveTo(2, n - 2); g.lineTo(n - 7, 7); g.stroke();
        g.setLineDash([]);
        g.beginPath(); g.arc(n - 5, 5, 3.5, 0, Math.PI * 2); g.stroke();
        g.fillStyle = ink; g.beginPath(); g.arc(n - 5, 5, 1.1, 0, Math.PI * 2); g.fill();
        break;
      case "trail":
        g.strokeStyle = rgba(ink, 0.5); g.lineWidth = 1.2;
        g.beginPath(); g.moveTo(1, n - 3); g.bezierCurveTo(n * 0.4, n * 0.2, n * 0.6, n, n - 2, 3); g.stroke();
        break;
      case "death": paintCross(g, c, c, n * 0.28, ink, 1); break;
      case "alert": {
        const glow = g.createRadialGradient(c, c, 0, c, c, c - 1);
        glow.addColorStop(0, "rgba(239,68,68,0.5)"); glow.addColorStop(1, "rgba(239,68,68,0)");
        g.fillStyle = glow; g.fillRect(0, 0, n, n);
        g.strokeStyle = "#ef4444"; g.lineWidth = 2;
        g.beginPath(); g.arc(c, c, n * 0.22, 0, Math.PI * 2); g.stroke();
        break;
      }
      case "convert": {
        const r = n * 0.3;
        g.strokeStyle = "#ffffff"; g.lineWidth = 1.3;
        g.beginPath(); g.arc(c, c, r, 0, Math.PI * 2);
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          g.moveTo(c + Math.cos(a) * r, c + Math.sin(a) * r); g.lineTo(c + Math.cos(a) * (r + 2.5), c + Math.sin(a) * (r + 2.5));
        }
        g.stroke();
        g.setLineDash([2, 1.5]); g.strokeStyle = "#60a5fa";
        g.beginPath(); g.arc(c + r * 0.35, c - r * 0.1, 2.5, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
        break;
      }
      case "hp": hpBar(g, c, c - 1, n - 4, 0.6); break;
      case "ghost": paintPlan(g, c, c, (n - 3) / turnReach(DEFAULT_TURN), "barracks", "#9ca3af", true, DEFAULT_TURN); break;
      case "fight":
        g.setLineDash([4, 2.5]); g.strokeStyle = "#fb923c"; g.lineWidth = 2;
        g.beginPath(); g.arc(c, c, c - 2, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
        break;
      case "fog": // ground with a sight circle clear, the rest dimmed, the left edge never explored
        g.fillStyle = GROUND; g.fillRect(1, 1, n - 2, n - 2);
        g.fillStyle = `rgba(0,0,0,${FOG_DIM})`;
        g.beginPath(); g.rect(1, 1, n - 2, n - 2); g.arc(c + 2, c, n * 0.3, 0, Math.PI * 2); g.fill("evenodd");
        g.fillStyle = `rgba(0,0,0,${FOG_DARK})`; g.fillRect(1, 1, (n - 2) * 0.3, n - 2);
        break;
    }
  });

  RV.MapView = MapView;
  RV.rgba = rgba;
  RV.UNIT_TYPES = UNIT_TYPES;
  RV.BUILDING_TYPES = BUILDING_TYPES;
  RV.GAIA_STYLE = GAIA_STYLE;
  RV.MARKS = MARKS;
})(window.RV);
