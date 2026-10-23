# Icon style guide — 2D unit & structure icons with Tier 1–4 evolution

Audit date: 2026-10-23 · Scope: the custom icon set proposed for the 2D viewer (`viewer/`), usable by the 3D
viewer's selection tray and unit card as well. This document is the "art bible" that every prompt in
`docs/audit/ICON_PROMPTS.md` already embeds.

---

## 1. What the set covers

| Group | Count | Source of truth |
| --- | --- | --- |
| Unit types | 227 | `viewer/stats.js` base ids (`b`), deduplicated across civilizations |
| Structure types | 164 | same |
| **Total** | **391** | `docs/audit/roster.json` |
| Prompts | **1,564** | 391 × 4 tiers, `docs/audit/icon-prompts.json` |

The raw blueprint space is larger (2,094 stat entries / 3,013 catalogue blueprints) but collapses to 391 distinct
visual subjects: civilizations share a model for most units (e.g. every civ's `spearman`), while genuinely distinct
units already carry their own base id (`longbowman`, `janissary`, `yumi-ashigaru`, `tower-elephant`).

**Out of scope by design:** gaia (trees, mines, animals, relics), weapon attachments, projectiles and dummies. Those
already have real game icons in `viewer3d/assets/icons/` and map art in `viewer/map.js`.

## 2. Tier = Age

Tier 1 = Age I look, Tier 4 = Age IV / imperial look. This matches the data the engines already have:
`viewer3d/assets/catalog.json` carries per-age model variants (`ages` → `sul_town_house_a_age_01…04`), and the 2D map
already draws **age pips** above military units (`PIP_R` in `viewer/map.js`).

**The silhouette rule is absolute:** the outline, pose and footprint are identical at all four tiers. Only materials,
construction, ornament and one accent colour escalate. This is what makes a tier change readable at 32 px and what
keeps the set cohesive.

| Tier | Units | Structures |
| --- | --- | --- |
| **T1** | padded cloth, leather straps, plain wood shaft, no metal beyond a buckle; muted, dusty | rough timber, wattle-and-daub, thatch, rope lashings, bare earth plinth |
| **T2** | mail shirt or lamellar, dyed cloth, first steel helm, carved grips, small heraldic badge | dressed timber, stone footings, fired-tile or shingle roof, plaster infill, painted trim |
| **T3** | plate or brigandine, engraved fittings, tabard, banner pole, brighter accent, steel highlights | ashlar masonry, buttresses, carved capitals, glass, first tower banners, iron-bound doors |
| **T4** | gilded trim, enamel, heraldic crest, plume, subtle warm glow along edges, finest detail | imperial ashlar, gilded finials, heraldry over the gate, leaded glass, lanterns, warm interior glow |

**Units or buildings that do not exist in Age I** (e.g. `trebuchet`, most landmarks) still get four tiers: T1/T2 show the
same object in a plainer, pre-upgrade state (unpainted timber, unhardened steel). Never remove the subject's defining
feature to make a tier look early.

## 3. The style block (inside every prompt)

> hand-painted cel-shaded strategy-game icon, thick near-black casing outline, flat two-to-three-tone materials with
> soft gradients, warm rim light from the upper left, soft contact shadow, single subject centred, three-quarter view,
> filling 85 percent of a square frame, readable at 32 pixels, cohesive with the rest of the set, original design

Technical suffix (also inside every prompt):

> square 512x512 PNG, transparent background, no text, no letters, no numbers, no frame, no border, no watermark, no
> extra props, no scenery beyond the contact shadow

Negative prompt (pass to every generation as the generator's separate negative field; it is **not** embedded in the
1,564 prompts in `ICON_PROMPTS.md` / `icon-prompts.json`, which declare it once at the top level):

> text, letters, numbers, watermark, signature, border, frame, background scenery, multiple subjects, collage, UI
> chrome, photorealistic, 3D render, blurry, thin hairlines, low contrast, cropped subject

The near-black casing is `#0b0e14`, the 2D map's `CASING` constant — icons dropped onto the map and into the panels
then share one outline weight with the existing figures.

## 4. Colour system

| Role | Value | Notes |
| --- | --- | --- |
| Casing / outline | `#0b0e14` | same as `viewer/map.js` `CASING` |
| Leather | `#7a5233` | T1–T2 straps, gambesons |
| Wood | `#a87a46` | shafts, carts, timber, docks |
| Thatch / straw | `#d8b36a` | T1 roofs, sacking |
| Steel | `#c8ccd4` | blades, plate, mail highlights |
| Stone / limestone | `#cbc4b4` | T2–T4 masonry |
| Brick | `#9c6b52` | Islamic, Byzantine and Rus masonry |
| Slate | `#7d838c` | T3–T4 roofs |
| Gold | `#f3d27a` | **Tier ornament: T3–T4 only** — never a base colour. Exception: gold that is part of a unit's identity kit (named in its shared Gear/Palette line, e.g. Gilded Archer trim, Atabeg fittings) stays identical at all four tiers. 66 families use that exception. Two prompts add tier-specific gilding below T3 and must be revised before the full run: `prelate` T2 ("gilded book clasps") and `golden-tent` T1 ("gilded pole tips"). |
| Player accent | recolourable | one saturated area: sash, shield field, banner, roof stripe, awnings |

Every prompt should name exactly one recolourable accent region so the engine can tint it per owner (the 3D engine
already tints unit materials per player; the 2D map draws unit art in the player colour). Do not bake a specific civ's
colour into the accent. **Current prompts break this rule:** 105 of the 115 families whose Palette line names an accent
give it a fixed hue (e.g. `akinji` "indigo sash", `archer` "green armband"). Before the full run, change those to a
neutral, tintable value (e.g. "mid-grey shield field as recolourable player accent").

## 5. Output spec

- 512 × 512 PNG, transparent, sRGB, one subject, no padding artefacts.
- Safe margin ≥ 24 px (the casing must not touch the edge).
- Naming: `icon_<unit|structure>_<id>_t<tier>.png`, e.g. `icon_unit_man-at-arms_t3.png`,
  `icon_structure_archery-range_t4.png`. The id is exactly the roster id (kebab-case, ASCII).
- Suggested layout: `viewer/icons/<unit|structure>/<id>_t<tier>.png` (one flat folder per kind is also fine; the id
  already carries the kind).
- Provide a 64 px and 32 px export for the selection tray and legend; those two sizes decide whether the icon survives.
  The 2D key draws at **22 px** (`ICON_PX` in `viewer/app.js`), so 22 px is the real legibility gate. The selection
  tray displays at 32 × 32 inside 40 px buttons (`viewer/card.js:33-36`).

## 6. Generation workflow

1. **Per ID, generate T1 first.** Iterate on the silhouette alone until it is unmistakable at 128 px. Lock that image.
2. **Chain T2–T4 from the locked image** (image-to-image or "same silhouette, materials upgraded to …" with the
   reference attached). Keep the seed and the framing fixed. Never re-roll the pose between tiers.
3. **Silhouette test:** fill the icon black and shrink to 32 px. If a player cannot tell a `spearman` from a
   `pikeman`/`halberdier` at that size, the gear is wrong, not the shading.
4. **Set test:** put 20 finished icons on one sheet. Reject any that use a hue, outline weight, or light direction that
   the others do not.
5. **Tier continuity test:** show T1–T4 in a row at 96 px. The family resemblance must be obvious; the escalation must
   be obvious too.

## 7. Integration points (proposal only — not implemented)

| Where | Current behaviour | Proposed change |
| --- | --- | --- |
| 2D map figure | `viewer/map.js` draws one of **19** procedural silhouettes per `RV.unitType` (`RV.unitIcon`) | draw the per-id, per-tier icon; fall back to the current figure when an icon is missing |
| 2D legend / selection tray | `RV.unitIcon` / `RV.buildingIcon` (22 building kinds) | same per-id lookup |
| 2D unit card | `viewer/card.js` `portraitOf()` fetches `data.aoe4world.com/images/...` per age, online only | prefer the local tier icon; keep the online portrait as an upgrade |
| 3D selection tray / inspector | `viewer3d/viewer.js` `ICON_DIR = 'assets/icons/'` (real game icons per blueprint) | optionally switch to the generated set so both viewers match |
| Tier source | 2D pips from `RV_FRAME` age; 3D model swap per age | reuse the same age lookup for the icon tier |

**Interim option worth considering:** the 2D card already loads official per-age portraits from AoE4World when online.
Caching those locally would give every ID a *tiered* image today with zero art production — the custom set then becomes
a style upgrade, not a gap filler.

## 8. Resizing the set later

- **Civ flavour variants** (e.g. English vs Mongol `spearman`): keep the same silhouette and tier ladder, swap only the
  accent hue, helmet shape and one cultural prop. File them as `<id>_<civ>_t<tier>.png`.
- **Aged upgrades that change equipment** (e.g. a unit that gains a shield in Age III): treat it as the T3 tier, not a
  new ID.
- **Unique landmarks** already have their own ids — no special case needed.
