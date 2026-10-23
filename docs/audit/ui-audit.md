# UI/UX audit — 2D and 3D replay viewers

**Scope.** Read-only review of `viewer/index.html`, `viewer/style.css`, `viewer/app.js`, `viewer/map.js`, `viewer/caster.js`, `viewer/timeline.js`, `viewer/fightpanel.js`, `viewer/ecopanel.js`, `viewer/card.js`, `viewer3d/index.html`, `viewer3d/panels.js`, `viewer3d/hud.js`, `viewer3d/marks.js`, the UI-construction parts of `viewer3d/viewer.js` (grep + line ranges), `viewer3d/portal.js`, `README.md:110-156`, and the four screenshots. No file was modified except this report; `viewer/data/*.js` and `viewer3d/viewer.js` were not read end-to-end.

**Screenshot caveat.** `docs/screenshots/viewer2d.png` and `reference/what-changed/*` show an older 2D chrome: one flat top-bar row with `Attacks / Target fire / Combat FX / Trails / Orders / Eco orders / Labels / Relief / Resources / Army comp / Cameras / Key`, no **Panels**, **HUD details**, **Combat** or **Layers** popovers, and a `Combat FX` checkbox that no longer exists (current 2D splits it into Damage, Heals, Projectiles, Splash rings). That screenshot is still useful for proportions and the map overlays, but its control labels are stale. `viewer3d.png` matches the current 3D shell.

---

## 1. Layout and information architecture

### 2D (`viewer/index.html`, grid in `viewer/style.css:3,23`)

- **Header (global):** recording select, Trends, player chips plus map metadata, Panels and HUD details (shown only ≤1100 px), Vision, **Combat** popover (8 boxes), **Layers** popover (11 boxes).
- **Caster strip:** a separate 84 px grid row (`style.css:156-157`), only for 2D 1v1, on by default (`app.js:24`).
- **Main:** map plus a fixed **410 px** tabbed sidebar (`style.css:23,62`): Moments (conditional), Fights (default), Players, Eco, Selection.
- **Footer:** a fixed **150 px** row (`style.css:3`) holding transport, clock, Watch in game, metric and a one-line 14-shortcut hint, then the timeline canvas (minimum 48 px).
- **Map overlays:** the full four-row map key bottom-left (default on), the “On screen” composition top-right, the compass bottom-right, and tooltip/notice/caption layers.

At 1920×1080 the map is 1510×808 with the caster strip on (1510×892 with it off); the sidebar is 21% of the width. At 1280×720 the sidebar becomes **32%**, the 150 px footer **21%** of the height and the caster strip another 12%, leaving the map **870×448**. The map key (≈460×170 at 1920, capped at 34% height below 1100) covers much of the lower-left view. The 410 px sidebar holds a 9-column players table and the full fight-composition card; at 1280 it is the largest single block on screen.

### 3D (`viewer3d/index.html`)

- **Top bar:** Matches, player chips **with final WIN/LOSS**, clock, victory conditions, `Player View: OFF`, `📊 Match Trends`, `Watch in game`, and a second centred row of map metadata (`index.html:56-63`, built in `viewer.js:4147-4162`).
- **Map:** full-bleed WebGL viewport.
- **Drawer:** **300 px** on the right (`index.html:83`), three tabs (⚔ Fights, Economy, Layers & settings). Layers alone has eight sections and 18 overlay checkboxes; five of them are inside a collapsed **Overlays** `<details>` (`index.html:380-402`). The fights pane nests a 260 px fight list and a 184 px kill feed (`index.html:108,133`).
- **Floating panels:** a 280 px unit inspector top-left (`index.html:143`), the one-row map key bottom-left, the “On screen” panel top-right, under-attack toasts bottom-left, the moment caption, and a ~70 px floating timeline.
- **Modals:** Matches (780 px) and Match Trends (iframe).

At 1920 the drawer is 16% and the inspector 15% of the width. At 1280 they are 23%/22%, and with both open only **680 px** of map is clear. At 768 that falls to about **168 px** (measured). The drawer is narrow for the shared fight card: its 280 px content area renders the five-column Micro Rating grid at 10 px and 4v4 player tables at 10.5 px.

### What competes for attention, what is wasted or cramped

- **2D:** the caster strip + 410 px sidebar + 150 px footer + two corner overlays leave the map as the majority of the screen, but the eye is pulled by the dense sidebar and the default-on key. The footer is fixed at 150 px even though the timeline needs only about 100; the shortcut hint is the only thing filling the extra row. The 410 px sidebar is generous at 1920 and cramped for its 9-column tables at 1280.
- **3D:** the map is the whole viewport, but the top bar, right drawer, left inspector, bottom key/toasts and timeline all float over it. At 1920 the empty margins around the 300 px drawer are the place to widen it; at 768 the overlays are the interface. The top bar duplicates the clock in the footer and carries a permanent `Player View: OFF` button even when no player camera exists.
- **Both:** the primary answer (“who won this fight”) is below the fold of the interaction: 2D requires selecting a fight and scanning past a composition table; 3D requires opening a closed drawer and selecting a fight.

---

## 2. Breakpoints and scale

There are exactly three media queries in the two viewers (verified by grep): `viewer/style.css:228` and `:240`, and `viewer3d/index.html:274`. There is no 768/480 query and no pointer/touch query.

| Query | File | What it changes |
| --- | --- | --- |
| `max-width: 1400px` | `viewer/style.css:228-237` | Header gap 10→8; hide the map-metadata text in the player strip; caster columns tighten (95/75/245 px), padding and gaps shrink, bank 14 px, civ name becomes a 9 px block with the “·” separator removed. |
| `max-width: 1100px` | `viewer/style.css:240-264` | Header wraps (`flex-wrap`), players get their own full-width row, replay select capped at 190 px, spacer removed, **Panels/HUD details** appear, option toggles lose their 112 px minimum; `main` becomes one column; the sidebar becomes a 410 px absolute drawer with a shadow; the caster strip auto-heights and stacks the two sides, hiding economy and research/debt rows until **HUD details**; controls wrap and the shortcut hint disappears; legend capped at 34% height with its own scroll; “On screen” capped at 280 px / 40%. |
| `max-width: 1100px` | `viewer3d/index.html:274-279` | Header left/right offsets reset to 10 px (so the top bar can use the full width), drawer and inspector move below the top bar, their max heights account for it, top-bar gap tightens, map metadata may break anywhere. Nothing changes width, tab count, touch behaviour or the floating inspector model. |

| Size | 2D | 3D |
| --- | --- | --- |
| **1920×1080** | Map 1510×808 with caster (892 without); sidebar 410 (21%); footer 150 (14%); caster 84 (8%). | Map full-bleed; drawer 300 (16%); inspector 280 when selected; top bar one row; timeline ≈70. |
| **1280×720** | No breakpoint fires. Map 870×448 with caster (532 without); sidebar 410 (32%); footer 150 (21%); caster 84 (12%). | Drawer 300 (23%); inspector 280 (22%); top bar wraps to two rows when the drawer is open; about 680 px clear with both panels. |
| **1024×768** | Header ≈70; caster ≈96; map ≈452; footer 150; sidebar is a 410 px overlay (40%). | Top bar ≈3 rows; drawer 300 (29%); inspector 280 (27%); about 424 px clear with both. |
| **768 wide** | Header ≈3 rows (Layers wraps); caster ≈96; footer 150; map ≈420 at 768 high; drawer min(410 px, 90vw) (53%). | Top bar wraps (row count depends on the match header); drawer 300 (39%); inspector 280 (36%); about 168 px clear with both (measured); caption overlaps the drawer. |
| **480 wide** | Header 4 rows; footer 150 + caster 96 leave under 200 px of map. The Layers popover lands on-screen here (measured x≈163); it is off-screen at ≈650-700 px (P0-4). | Top bar 5+ rows; drawer 300 (62%); fixed timeline controls alone need ≈420 px, so the track collapses. Neither viewer is phone-ready. |

**Touch.** 2D map input is `wheel` + `mousedown`/`mousemove`/`mouseup` only (`map.js:268-304`); the timeline is mouse-only too (`timeline.js:155-178`). 3D already has OrbitControls touch navigation (one-finger rotate, two-finger pan/zoom: `vendor/three/examples/jsm/controls/OrbitControls.js:371,1806-1814,1838-1846`), but its left-button marquee handler runs for any pointer with button 0, including touch, so a one-finger drag also draws a marquee (`viewer.js:4848-4865`, `3941`). Hover-only content (unit tooltips, the fight-loss bar titles, legend tips) has no touch or keyboard equivalent.

---

## 3. Type and contrast

| Element | Size | Evidence |
| --- | --- | --- |
| 2D base | 13 px | `style.css:2` |
| 2D header, tabs, fight rows, tooltip | 13 px | `style.css:2,64,70` |
| 2D player team, result, legend, hint, `.many` table | 11 px | `style.css:18,20-21,35,140,150` |
| 2D side lines, tables, kill feed, comp | 12 px | `style.css:69,77,124,144` |
| 2D caster strip (civ, counts, income, debt, tech, army title, killed) | 9-11 px | `style.css:171,174,176-179,193,197,201,207,211` |
| 2D stat card (base, labels, benchmark) | 9-12 px, value 15 px, name 16 px | `style.css:84,92,96-99,113-120`; `card.js:16-23` |
| 2D timeline / eco lanes | 9-10 px canvas text | `timeline.js:121,221,226,264` |
| 2D map labels / amounts | 10 px canvas text | `map.js:542,608,702` |
| 3D base | 12 px | `index.html:37` |
| 3D top bar / tabs / clock | 12-13 px | `index.html:56-57,67,84` |
| 3D drawer headings, notes, summaries | 11 px | `index.html:46,89-90,103` |
| 3D fight rows, kill feed, players table | 12 px; 4v4 table 10.5 px | `index.html:117,128,133` |
| 3D inspector (title 14, sub 11), key, timeline | 10-11 px | `index.html:145,151,261`; `viewer.js:4738,4746` |
| Shared fight panel | 12 px base, 10-11 px headings/labels, 16 px bar | `fightpanel.js:15-16,31,39,47` |

**Contrast (WCAG 2.1, computed from the hex values):**

| Pair | Ratio | Verdict |
| --- | --- | --- |
| 2D shortcut hint `#6b7280` on `#141820` | **3.68:1** at 11 px | fails AA (P1-6) |
| 2D “future” tech cells `#e5e7eb` at 35% over `#12161d` | **2.83:1** | fails; these are upcoming times users need |
| 2D disabled button text at 50% on `#1f2430` | 4.2:1 | fails AA, but disabled text is exempt |
| 2D muted `#8b93a3` on `#141820` | 5.76:1 | passes |
| 2D win/loss `#3fb950`/`#f85149` on `#141820` | 7.0:1 / 5.3:1 | passes |
| 2D caption tags `#bfdbfe` on `#1e3a5f`, `#fde68a` on `#3f3a1e` | 8.1:1 / 9.2:1 | passes |
| 3D muted `#a0aaa8` on panel `#13191c` | 7.44:1 | passes |
| 3D loss `#f85149` on `#13191c` | 5.29:1 | passes |
| 3D accent `#d2b66d` on `#13191c` | 9.0:1 | passes |

The main contrast failure is therefore the 2D shortcut hint; the main **size** problem is the 9-10.5 px data text (caster HUD, benchmark labels, 4v4 tables, timeline ticks, map labels). Icon sizes are 22 px in both legends and the composition grids, 32-40 px in the selection tray, 10 px chips/dots, 12 px sacred-site dots and 54 px for the 2D compass.

---

## 4. What is solid and should be preserved

- The 2D caster strip is a separate grid row, so it never covers the map, and it degrades to two stacked rows below 1100 (`style.css:156-157,250-260`).
- The shared unit card, fight analysis and eco panel already give one visual language inside both shells (`card.js`, `fightpanel.js`, `ecopanel.js`); the remaining differences are in the containers, not the cards.
- Tooltips, `title` attributes and legends are unusually complete on desktop; almost every icon and grade has an explanation.
- 3D’s under-attack toasts are clickable, time out and are capped at four (`hud.js:164-175`), which is a good pattern to reuse for other notices.
- Both viewers keep playback anchored to wall time and preserve the 2D camera framing across dock/layout changes (`README.md:139-146`).

## 5. Prioritized recommendations

IDs are stable for review. Effort: S = under a day, M = 1-3 days, L = more. Risk is implementation/dependency risk, not severity.

### P0 — blocks comprehension or breaks at common sizes (6)

| ID | Theme | Problem | Evidence | Proposed change | Effort | Risk | Applies to |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P0-1 | Hierarchy / feedback | 3D shows no fight list or fight winner at first load (a tab the user left open is restored); choosing a fight or pressing `[`/`]` seeks, moves the camera and fills the detail pane, but does not open the drawer or start playback. | `viewer3d/index.html:303` (`drawer-closed`); `viewer3d/viewer.js:4436-4453` (default tab `''`, saved tab restored); `viewer3d/viewer.js:4136-4141` (seek/focus/detail only); `viewer3d/viewer.js:5019-5022`; 2D contrast: `viewer/app.js:150-160` opens Fights and sets `playing = true`. | Open Fights on first load (remember an explicit close); on any fight selection open the drawer, seek and start playback, as 2D does. | S-M | Low | 3D |
| P0-2 | Responsiveness | At ≤1100 px any map selection, fight or moment auto-opens a min(410 px, 90vw) drawer over the map. The only way to close it is the **Panels** toggle; there is no close ×, backdrop or Escape-to-close. Introduced on 2026-10-23 by the responsive 2D pass (V-07); before that the sidebar was always docked. | `viewer/app.js:395-399` (`switchTab` adds `side-open`); `viewer/app.js:115-121,131` (select), `:468` (moments), `:158` (fight); `viewer/app.js:283-285` (Panels toggle); `viewer/style.css:248`; `viewer/app.js:308` (Esc clears selection, not the drawer). | Do not auto-open on map selection; show a compact card in place, or open the drawer only from Panels/tabs. Add a close ×, a backdrop and Esc. | S-M | Low | 2D |
| P0-3 | Responsiveness / accessibility | The 2D map has no touch pan/zoom (mouse and wheel only). 3D has OrbitControls touch pan/zoom, but a one-finger drag starts the selection marquee while the camera also rotates. | `viewer/map.js:268-304`; `viewer/timeline.js:155-178`; `viewer3d/viewer.js:4848-4865` (marquee on any button-0 pointer); `viewer3d/viewer.js:3941` (OrbitControls); OrbitControls touch `:1806-1814,1838-1846`. | 2D: add pinch zoom and two-finger pan. 3D: suppress the marquee for touch/long-press. Both: size touch controls for fingers. | L | Medium | Both (2D touch nav; 3D marquee conflict) |
| P0-4 | Responsiveness | At about 650-700 px wide the wrapped **Layers** button sits near the left edge, so its 200 px+ right-aligned popover opens off-screen (measured x≈−92) and the overlay controls are unreachable. It stays on-screen at 768, 950 and 480 px (measured x≈508, 508, 163). The wrapping came from the 2026-10-23 responsive pass. | `viewer/style.css:221-223` (`right:0; min-width:200px`); `viewer/style.css:240-246` (wrap, min-width 0); `viewer/index.html:31-33` (Layers last). | Align popovers to the viewport (open right when near the left edge) or use a full-width sheet under the top bar at narrow widths. | S | Low | 2D |
| P0-5 | Feedback / hierarchy | 3D’s in-app Controls help says right-drag pans, but right-drag orbits; left-drag box-selects and middle/Shift+right pans. | `viewer3d/index.html:411` (“Right-drag pan”); `viewer3d/viewer.js:3941` (`MIDDLE: PAN`, `RIGHT: ROTATE`); `viewer3d/viewer.js:4842-4843`; correct description in `README.md:122`. | Correct the help to: left-drag select, right-drag orbit, middle or Shift+right pan, wheel zoom, WASD pan, Q/E rotate. | S | Low | 3D |
| P0-6 | Responsiveness | At 768 px the 300 px drawer plus 280 px inspector leave about 168 px of map (measured); there is no narrow mode. The top-bar width cap was already fixed on 2026-10-23 (narrow rule now `calc(100% - 20px)`, was `calc(100% - 620px)`); how many rows the bar wraps to depends on the match header. | `viewer3d/index.html:83` (drawer 300), `:143` (inspector 280), `:274-279` (narrow rule: repositions, full-width top bar); `:176-184` (timeline controls at 480). | Below 1100, make the drawer a full-width overlay or bottom sheet with a backdrop, collapse the inspector to a title bar, and move secondary top-bar actions into one menu. | M-L | Medium | 3D |

### P1 — high value, low risk (10)

| ID | Theme | Problem | Evidence | Proposed change | Effort | Risk | Applies to |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1-1 | Hierarchy / accessibility | 3D fight rows show one total loss and a colour-only bar, with per-team losses and the winner available only on hover. | `viewer3d/viewer.js:4296-4297`; `viewer3d/index.html:108-115` (4 px bar, `title`); `viewer3d.png`; 2D contrast `viewer/app.js:566-572` (per-team text, damage, duration). | Add “Team A 3.2k vs Team B 3.8k” text and a “won by” chip to each row; keep the bar as a secondary, labelled cue. | S-M | Low | 3D |
| P1-2 | HUD readability | The 3D drawer is 300 px versus 2D’s 410 px, so the shared fight card and player tables render at 10-10.5 px inside 280 px. | `viewer3d/index.html:83,108,128`; `viewer/fightpanel.js:34-35` (five 10 px cells); `viewer/style.css:23,62`. | Widen the drawer to 340-380 px at ≥1400, allow a drag handle, and reflow the five-micro grid to 3+2 below 320 px. | S-M | Low | 3D |
| P1-3 | Consistency | The same overlays default differently: attack lines off/on, alert rings off/on, splash rings off/on; heals and splash are not separable in 3D. | `viewer/app.js:22-24`; `viewer3d/viewer.js:1031-1033`; corroborated by `docs/audit/parity-2d-3d.md:97-118`. | Adopt one shared default table (recommend attack lines off, alerts separate and off, splash off) and split 3D Combat FX so heals/splash can be turned off. | S-M | Low | Both |
| P1-4 | Accessibility / feedback | Target-fire grades are encoded only as red/yellow/green lines, and Target fire can be enabled while Attack lines is off, producing no visible change. | `viewer/fightpanel.js:11` (`HEAT_COLOR`); `viewer/map.js:787`; `viewer3d/viewer.js:3784-3794`; `viewer/index.html:22`; `viewer3d/index.html:386`; `viewer/app.js:186-196`; `viewer3d/viewer.js:4245-4246`. | Add a non-colour cue per grade (line style, thickness or tick marks) with a key; disable Target fire or auto-enable Attack lines with an inline note. | M | Medium | Both |
| P1-5 | Consistency / hierarchy | 2D’s match picker is a raw-filename select with no players, map, date or result; 3D opens a searchable Matches list. | `viewer/index.html:11`; `viewer/app.js:43-47`; `docs/screenshots/viewer2d.png` (`aoe4_245598603`); `viewer3d/portal.js:239-263`; `viewer3d.png`. | Use the 3D Matches list in 2D, or at minimum label options with players/map/date and keep the recording ID secondary. | M | Medium | 2D |
| P1-6 | HUD readability / consistency | The 2D shortcut cheat sheet is 11 px at 3.68:1 on one dense line; 3D hides the same information in a collapsed Controls box. | `viewer/style.css:150`; `viewer/index.html:118`; `viewer3d/index.html:410-414` and `:103` (11 px); computed contrast 3.68:1. | Add a “?” shortcut sheet in both at ≥12 px and ≥4.5:1, keep a 2-3 shortcut hint visible, and use one shared shortcut list. | S | Low | Both |
| P1-7 | Consistency / feedback | 3D shows the final WIN/LOSS from the first frame, while 2D hides it until the replay ends. | `viewer3d/viewer.js:4151-4153` (result always rendered); `viewer/app.js:171` (hidden), `:960` (revealed at `duration - 1`); `viewer3d.png` (WIN/LOSS at 21:23 of 35:02). | Hide the result until the end, or add a spoiler toggle, and use the same reveal rule in both. | S | Low | Both |
| P1-8 | Layout | The full four-row map key is on by default and covers the lower-left map; at ≤1100 it is capped at 34% height and scrolls internally. | `viewer/index.html:44` (checked); `viewer/app.js:204` (default on); `viewer/style.css:35,263`; `viewer/app.js:207-223` (four rows); `viewer2d.png`; `reference/what-changed/12_key_and_panels.png`. | Default it closed below 1100 (or remember per width), keep the Show key button, and collapse it to the Lines & marks row with a “more” row. | S | Low | 2D |
| P1-9 | Accessibility | 3D has no ARIA for its tabs/drawer state, no custom focus ring, and no dialog semantics or focus restore for Matches; 2D declares only a few ARIA attributes. | `viewer3d/index.html:324-329` (tabs), `:306-314` (DOM order puts the legend before the top bar); `viewer3d/viewer.js:4437-4444` (class only); no `aria-*`/`role` in `viewer3d`; `viewer3d/portal.js:241-263` (no dialog), `:282` (focus search), `:285-288` (close without restore); 2D: `viewer/index.html:15-19,50,65`; only `style.css:54` has `:focus-visible`. | Add tablist/tab/`aria-selected`/`aria-controls`, `aria-expanded` for the drawer, a visible `:focus-visible` ring, dialog + focus trap/restore for Matches, and `aria-live` for notices/toasts. | M | Low | Both |
| P1-10 | Accessibility | Neither viewer can select a unit, and 2D cannot pan or zoom, from the keyboard; the map canvas is not focusable or named. | `viewer/map.js:268-304`; `viewer/index.html:52`; `viewer3d/viewer.js:5009-5029` (no select); `viewer3d/index.html:411` (WASD/QE only). | Make the viewport focusable with a visible ring; add arrow-key pan and zoom in 2D and a keyboard way to cycle/select units (or an accessible unit list) in both. | M-L | Medium | Both |

### P2 — polish (10)

| ID | Theme | Problem | Evidence | Proposed change | Effort | Risk | Applies to |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P2-1 | Layout | 3D’s 280 px unit inspector floats over the map, covers the selected fight, and has no collapsed state; 2D keeps the same card in a docked Selection tab. | `viewer3d/index.html:143`; `viewer3d/viewer.js:4596-4599`; `viewer3d.png`; 2D `viewer/index.html:97-99`. | Dock it into the drawer or make it collapsible with a remembered state, and avoid overlapping the selected fight. | M | Medium | 3D |
| P2-2 | Layout / responsiveness | The 3D moment caption is fixed at left 300/top 64, so it overlaps the drawer at narrow widths and floats over empty space when no inspector is open. | `viewer3d/index.html:288`; `:274-279` (media moves the drawer/inspector, not the caption); at 768 the drawer starts at ≈458 and the caption can reach 760. | Anchor the caption to the inspector/drawer edges or centre it below the top bar; clamp it to the free map area. | S | Low | 3D |
| P2-3 | Feedback | Choosing Low quality leaves Shadows, Grass and Ambient occlusion checked and enabled although they no longer apply. | `viewer3d/index.html:374-401`; `viewer3d/viewer.js:5290-5300`. | Disable and dim the overridden controls with a “Low quality turns these off” note, or have the preset update the boxes. | S | Low | 3D |
| P2-4 | Accessibility / responsiveness | Transport and speed buttons are 24-34 px and checkbox labels ≈16-24 px, below the 40-44 px touch target. | `viewer/style.css:4,64`; `viewer3d/index.html:47-49,177-180`; screenshots. | Raise interactive targets to ≥40 px on coarse pointers and space them; keep the compact size for mouse only. | S-M | Low | Both |
| P2-5 | Feedback / hierarchy | The top bar shows “Combat 3/8” and “Layers 8/11” without saying whether the count is on or off. | `viewer/app.js:234-239`; `viewer/index.html:19,32`; `viewer/style.css:222`. | Label it “3 on” with a small dot row or icons, or show the count only when something is off. | S | Low | 2D |
| P2-6 | Accessibility | There is no reduced-motion path for infinite sacred-site blinking, toast pings and canvas alert pulses. | `viewer3d/index.html:75-76,191-199`; `:136-137`; 2D pulses in `map.js` (alerts/sites); no `prefers-reduced-motion` in the repository (grep). | Honour `prefers-reduced-motion` by keeping static rings/dots and removing infinite pulses. | S | Low | Both |
| P2-7 | HUD readability / consistency | Timeline labels are 10 px in both; 2D fight bands are clickable but 3D’s 4 px bands only seek. | `viewer/timeline.js:221,228-230`; `viewer3d/viewer.js:4738,4746,4763`; 2D click `viewer/timeline.js:163-166`; 3D seek-only `viewer3d/viewer.js:4800-4815`. | Raise tick/label sizes to 11-12 px and let 3D fight bands select the fight; add a band legend. | S | Low | Both |
| P2-8 | Feedback | Missing notes and failed GLB loads are silent; the 2D load error is a non-dismissible notice with no retry. | `viewer/app.js:65-67` (note load result ignored), `:71-75` (no dismiss/retry); `viewer3d/viewer.js:593` (GLB failure console only), `:975` (notes ignored); `viewer3d/portal.js:33-37`. | Show a dismissible, non-blocking notice with retry/choose-match, and report stand-in assets once per type. | S | Low | Both |
| P2-9 | HUD readability | Caster HUD, benchmark labels and 4v4 tables use 9-10.5 px data text that is hard to read at 1280. | `viewer/style.css:116,174,193,197,201,207,211`; `viewer3d/index.html:128`; `viewer3d.png`, `viewer2d.png`. | Set an 11 px floor for data text and drop columns or shorten labels instead of shrinking type. | M | Medium | Both |
| P2-10 | Consistency | The same concepts have different names: Fights/Engagements, Eco/Economy, Key/Map key, Labels/Unit names, Army comp/Army on screen, Orders/Move orders, Cameras/Player cameras. | `viewer/index.html:15-44,70-76,103-121`; `viewer3d/index.html:326-343,352-400`; matrix below; `docs/audit/parity-2d-3d.md:44-46`. | Pick one word per concept and use it for tabs, checkboxes, headers, tooltips and help; see the matrix. | M | Low | Both |

---

## Consistency matrix

Only controls that exist in both viewers with at least one difference are listed. `✗` = differs, `=` = same, `—` = no shortcut in either. Rows where all four aspects match (timeline metric, the caption’s Prev/Replay/Next, default speed 1×, default pause) are omitted.

| Control | 2D | 3D | Label | Default | Position | Shortcut | Note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Match picker | “Recording” select, raw file id | “Matches” button + searchable modal | ✗ | = | = | — | 2D has no map/players/date metadata. |
| Match Trends | “Trends” text link | “📊 Match Trends” button | ✗ | = | ✗ | — | 2D navigates away; 3D opens an iframe modal. |
| Watch in game | Footer button | Top-bar button | = | = | ✗ | — | Same action in different regions. |
| Vision | “Vision” select, “Everything”, top bar | “Vision” select, “Everyone (free view)”, Layers, plus “Player View: OFF” in the top bar | ✗ | = | ✗ | — | 3D splits fog, camera and follow across two controls. |
| Play / pause | Text “Play” / “Pause” | Icon ▶ / ❚❚ | ✗ | = | = | = | |
| Seek 5 s | −5s / +5s buttons | Keys only | ✗ | = | ✗ | = | Arrow keys work in both. |
| Speed | − / + and “1x” | − / + and “1×” | ✗ | = | = | = | |
| Fight sort | “by time” / “by size”, default time | “Most impactful” / “Chronological”, default impact | ✗ | ✗ | = | — | The list order changes between viewers. |
| Side panel / drawer | 410 px docked panel, five tabs, Fights active | 300 px drawer, three tabs, closed | ✗ | ✗ | ✗ | — | Primary 3D content starts hidden. |
| Fights tab | “Fights” | “⚔ Fights”, pane title “Engagements” | ✗ | ✗ | ✗ | — | |
| Fight list row | `#id`, time, per-team losses, damage, duration | time, “Fight #id”, badges, total lost + deaths, colour bar | ✗ | ✗ | = | — | 3D per-team losses are hover-only. |
| Fight detail controls | “Replay from start”, “Prev”, “Next” | No buttons; `[`/`]` only | ✗ | = | = | = | Same keys, different affordance. |
| Players | “Players” tab | “Players” section inside Economy | = | = | ✗ | — | |
| Eco | “Eco” | “Economy” | ✗ | = | ✗ | — | |
| Selection / stat card | “Selection” tab | Floating inspector | ✗ | = | ✗ | — | |
| Moments | “Moments” tab | “Key moments” inside Fights | ✗ | = | ✗ | — | |
| Option group | “Combat” / “Layers” popovers | “Layers & settings” drawer | ✗ | = | ✗ | — | |
| Attack lines | “Attacks”, off | “Attack lines & alert rings”, on | ✗ | ✗ | ✗ | — | 3D welds alert rings into the same box. |
| Target fire | “Target fire”, off, Combat | “Target fire”, off, Overlays | = | = | ✗ | — | |
| Alerts | “Alerts” (rings), off | “Under-attack notifications”, on, plus rings under attacks | ✗ | ✗ | ✗ | — | |
| Damage | “Damage”, on | “Damage numbers & flash”, on | ✗ | = | ✗ | — | |
| Heals | “Heals”, on | Inside Combat FX, on | ✗ | = | ✗ | — | Not separable in 3D. |
| Projectiles | “Projectiles”, on | “Projectiles”, on | = | = | ✗ | — | |
| Splash | “Splash rings”, off | Inside Combat FX, on | ✗ | ✗ | ✗ | — | Opposite defaults. |
| Trails | “Trails”, on | “Trails”, on | = | = | ✗ | — | |
| Orders | “Orders”, on | “Move orders”, on | ✗ | = | ✗ | — | |
| Eco orders | “Eco orders”, off | “Eco orders”, off | = | = | ✗ | — | |
| Unit names | “Labels”, off | “Unit names”, off | ✗ | = | ✗ | — | |
| Cameras | “Cameras”, off | “Player cameras”, off | ✗ | = | ✗ | — | 3D also has a separate “Camera” follow select (C). |
| Army on screen | “Army comp”, on | “Army on screen”, on | ✗ | = | ✗ | — | The panel itself is titled “On screen” in both. |
| Map key | “Key”, on | “Map key”, on | ✗ | = | ✗ | = | `K` works in both. |
| Resources | “Resources”, on | “Nature & resources”, on | ✗ | = | ✗ | — | |
| Player result | WIN/LOSS only at the end | WIN/LOSS from the first frame | = | ✗ | = | — | 3D spoils the outcome. |
| Follow | “Follow (F)” / “Stop following” | “Follow (F)” / “Following” | ✗ | = | ✗ | = | |
| Clear (Esc) | Clears selection, fight, caption and popovers | Closes modal/moment, clears selection; leaves the fight | = | = | = | = | Behaviour differs. |
| Timeline fight bands | Clickable | Seek only | ✗ | = | = | — | 2D focuses the fight; 3D does not. |
