/**
 * viewer.js — Age of Empires IV 3D replay viewer (Three.js ES module, loaded by index.html).
 *
 * Game facts come from core/ (no Three.js, no DOM): core/replay.js is the replay model; the Players tab queries the
 * shared model.js (RV.statsAt/armyAt/techTable/killFeed/jumpFight) over M2, the 2D viewer's model of the same
 * recording. `node tools/parity-check.mjs [name]` checks the core model against the 2D one.
 * This file renders and animates what they report and runs the UI; one clock (state.t) drives both, and
 * Replay.updateFrame(t) runs once per frame before anything reads the entities.
 *
 *   1. CONFIG        ASSET_MAP (blueprint → GLB url / per-age swaps / scale / yOffset), fallbacks, palettes, UI constants
 *   2. HELPERS       renderer-side helpers (the replay model itself is core/replay.js: typed-array tracks, sampling,
 *                    spans, vision, ages, damage events, blows from every attacker/target pair, villager jobs)
 *   3. ASSETS        GLB cache (KTX2/Basis textures via KTX2Loader), team-colour mask shader with the GLB's normal/
 *                    roughness/metal/AO maps, Gen7 atlas material, structure stylisation, distant LODs, fallbacks
 *   4. SCENE         replay loading (#<name>[/t<seconds>], the 2D viewer's link format; data from the 2D viewer's
 *                    folder through serve.mjs /shared/), terrain (game ground layers, extends TERRAIN_MARGIN past the
 *                    arena into the shroud) + ground wear (building footprints, replay foot traffic) + tactical grid +
 *                    flat coordinate labels, atmospheric sky dome (three's Sky: scattering, clouds, sun disc; fog to its horizon), lights (sun + a procedural sky as PMREM environment light, built once)
 *                    + sun shadow fitted to the view centre (capped at SHADOW_HALF, fading at its edge), gaia
 *                    (instanced real trees with wind sway; chopped trees fall away from the first chopper at its first
 *                    axe impact and leave instanced stumps; resources, mines and bushes shrinking as they empty),
 *                    near-camera grass blades, water (its level inferred from the fish: the replay records none) with
 *                    ripples, sky reflection and shore foam
 *   5. ENTITIES      per-entity views: standing buildings drawn from shared per-material batches (BuildingBatches,
 *                    switching each building between its LODs by size on screen), model swap per age/tier
 *                    (staggered across a town), wall pieces turned along their line and stretched to meet (gates and
 *                    posts at full size, the foundation inside a gate tower hidden: core wallAt), facing (turning at a capped
 *                    rate in replay time: along the move, toward the foe while planted or striking ahead, toward the
 *                    work while gathering), construction sites rising out of scaffolds, ruins, garrisons hidden at the
 *                    door, damage flash; units and animals play the game's own animation clips (assets/anims, baked by
 *                    tools/havok/bake-anims.mjs) chosen per state from replay time (gaits phased by ground covered,
 *                    blows aligned on the clip's strike frame, reloads, flinches, death, villager work loops, props in
 *                    hand), drawn GPU-instanced by UnitBatches (unit-batches.js: skinning, two-clip blend, team colour,
 *                    flash and LOD per instance); unit scale adapts to camera distance (ADAPT_NEAR → 1×, ADAPT_FAR → slider),
 *                    capped per unit in crowds so grown neighbours do not overlap (CrowdCap; animals too)
 *   6. OVERLAYS      health bars, attack lines, arrows/torches flying from the loose to the hit (or into the ground
 *                    beside a missed target; buildings' guessed arrows greyed, without lines), melee strike flashes,
 *                    kill markers, fight zones, damage numbers, amounts left on gold/stone when zoomed in
 *   7. CAMERA        OrbitControls + WASD panning + Q/E rotate + follow lock
 *   8. UI            top bar, filters, playback (0.25–32×, the 2D viewer's keys), Players panel (banked resources,
 *                    pop, villagers, army, army value, age-up/eco tech table, kill feed), engagements, inspector,
 *                    timeline, picking (units and buildings first, then map objects: amount left, workers, felling),
 *                    keyboard, the Vision selector (everyone, a team or a player: fog of war), the Graphics selector
 *                    (High / Low (fast): applyQuality). Map object amounts show in every vision mode, like the 2D
 *                    viewer (the neutral scans see through fog)
 *   9. LOOP          RenderPass → depth-only GTAO → fog of war → OutputPass (ACES); everything time-driven (wind, grass sway, tree falls,
 *                    clip times, ground wear, damage numbers and flashes) reads replay time, so a paused replay is a
 *                    still frame
 *
 * Coordinates: replay (x, z) are game ground coordinates (left-handed, +z = north). Everything spatial lives in
 * `world`, a group mirrored on Z, so GLB models (exported in raw game space) and positions stay untouched while
 * north points up-screen. Overlays outside `world` (bars, lines, DOM labels) use world-space (x, y, -z).
 *
 * Models: assets/models/*.glb are produced from the local AoE IV install by `node tools/build-assets.mjs`, which
 * lists them per blueprint in assets/catalog.json (read at load: catalogEntry) and writes assets/combat.json (per
 * unit or building weapon attachment, per weapon: damage type, range, wind-up/down, impact, cooldown, period,
 * moving fire, projectile speed, weapon art). Units are built with their weapons, shields and villager tools attached as extra
 * joints (model keys `<body>+<weapon art>`). Unit materials carry a player-colour/skin mask in emissiveTexture
 * (extras.rv.mask); rebuilt GLBs (extras.rv.pbr) add standard normal, metallic-roughness (+ occlusion) maps, all
 * images as KTX2 (KHR_texture_basisu); older PNG GLBs load the same way and keep a matte look. Structures use the
 * game's Gen7 bakes as one atlas per model with the team mask in alpha (extras.rv.gen7), or are vertex-coloured
 * from a per-civ palette when no bake exists (extras.rv.layered). Distant levels ride in the same GLB as top-level
 * `rv_lod<n>` nodes: never shown as part of the model, static models keep them per material part (AssetRegistry
 * bakeLods) for BuildingBatches; UnitBatches switches skinned units between them by distance. Tree leaves carry
 * their tint strip (extras.rv.tint) and are tinted per instance. assets/terrain/*.png are the ground layers; the
 * replay holds only heights, so
 * grass/lush/dry/forest are placed by noise, slope and tree density,
 * while dirt and trodden mud follow GroundWear (where buildings stood and units walked up to the current time).
 * assets/terrain/blades.{png,json} are the game's grass blade cards for GrassField. Missing assets fall back to
 * procedural trees / ground.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { mergeGeometries, deinterleaveGeometry } from 'three/addons/utils/BufferGeometryUtils.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { Sky } from 'three/addons/objects/Sky.js';
import {
  Replay, idxAt, alive, ownerAt, place, tripAt, visibleTo, locateGaia, workersAt, wallAt, prettyCiv, fmtTime, clamp, hash01, hash3,
  SAMPLE, ROMAN, TAU, JOBS, J_FARM, J_WOOD, CARRY, HOLD,
} from './core/replay.js';
import { initPortal, openMatches, showNotice } from './portal.js';
import { Marks } from './marks.js';
import { Legend, ArmyComp, UnitLabels, Moments } from './panels.js';
import { UnitBatches, pbrOf, TEAM_MASK_GLSL } from './unit-batches.js';
import { CombatFx3D } from './fx3d.js';
import { Victory, RaidToasts } from './hud.js';

// ═══════════════════════════════════════ 1. CONFIG ═══════════════════════════════════════

const DEFAULT_REPLAY = 'aoe4_245598603'; // opened when the link names no recording
const SHARED = 'shared/';            // the 2D viewer's data/, notes/ and units.js (served by serve.mjs)
const m = (name) => `assets/models/${name}.glb`;
const ICON_DIR = 'assets/icons/';

/**
 * Blueprint (entity bp or gaia type) → model.
 *   url      GLB path, or an array of variants picked per entity id (male/female villagers, house a/b/c)
 *   ages     { tier: url | url[] } swaps for later ages/unit tiers (buildings follow the owner's age; units their
 *            tier: villagers/scouts/monks follow the age, other units their bp tier plus unit-line upgrades)
 *   scale    extra scale (units are additionally multiplied by the unit-scale slider)
 *   yOffset  vertical offset in metres
 *   palette  structure palette key (default: owner civ)
 *   kind     'corpse' = lie on its side
 *   icon     optional icon override (default assets/icons/<bp>.png when present)
 * Hand-tuned entries; at load every other blueprint built into assets/catalog.json is added (catalogEntry).
 * Blueprints with neither (TC weapon attachments, unbuilt civs; farms without a built field, see FarmFields) use the
 * procedural fallbacks below.
 */
export const ASSET_MAP = {
  // ── Delhi Sultanate ──
  building_town_center_capital_sul: { url: m('sul_town_center_age_01'), ages: { 2: m('sul_town_center_age_02'), 3: m('sul_town_center_age_03') } },
  building_house_control_sul: {
    url: [m('sul_house_a_age_01'), m('sul_house_b_age_01'), m('sul_house_c_age_01')],
    ages: {
      2: [m('sul_house_a_age_02+west_house_a'), m('sul_house_b_age_02+west_house_b'), m('sul_house_c_age_02+west_house_c')],
      3: [m('sul_house_a_age_03+west_house_a'), m('sul_house_b_age_03+west_house_b'), m('sul_house_c_age_03+west_house_c')],
    },
  },
  building_unit_religious_control_sul: { url: m('sul_monastery_age_01'), ages: { 2: m('sul_monastery_age_02'), 3: m('sul_monastery_age_03') } },
  building_econ_food_control_sul: { url: m('chi_grismill') },
  building_econ_mining_camp_control_sul: { url: m('com_mining_camp'), palette: 'timber' },
  building_econ_wood_control_sul: { url: m('com_lumber_camp'), palette: 'timber' },
  building_landmark_age1_quwwat_ul_islam_control_sul: { url: m('sul_wonder_quwwat_ul_islam') },
  building_landmark_age2_khiji_mosque_control_sul: { url: m('sul_wonder_khiji_mosque') },
  building_unit_cavalry_control_sul: { url: m('sul_stable_age_02'), ages: { 3: m('sul_stable_age_03') } },
  building_unit_ranged_control_sul: { url: m('sul_archery_range_age_02'), ages: { 3: m('sul_archery_range_age_03') } },
  building_tech_unit_infantry_control_sul: { url: m('sul_blacksmith_age_02'), ages: { 3: m('sul_blacksmith_age_03') } },
  building_defense_palisade_sul: { url: m('eng_palisade_straight_6m_age01'), palette: 'timber' },
  building_defense_palisade_bastion_sul: { url: m('com_palisade_bastion'), palette: 'timber' },
  unit_villager_1_sul: {
    url: [m('sul_villager_male_age01'), m('sul_villager_female_age01')],
    ages: { 2: [m('sul_villager_male_age02'), m('sul_villager_female_age02')], 3: [m('sul_villager_male_age03'), m('sul_villager_female_age03')] },
  },
  unit_scout_1_sul: { url: m('sul_horse_combined_scout_age01'), ages: { 2: m('sul_horse_combined_scout_age02'), 3: m('sul_horse_combined_scout_age03') } },
  unit_horseman_2_sul: { url: m('sul_horse_combined_light_age02+mace_flanged'), ages: { 3: m('sul_horse_combined_light_age03+mace_flanged') } },
  unit_archer_2_sul: { url: m('sul_ranged_bow_age02+bow_short'), ages: { 3: m('sul_ranged_bow_age03+bow_short') } },
  unit_monk_2_sul: { url: m('sul_infantry_monk_age01'), ages: { 2: m('sul_infantry_monk_age02'), 3: m('sul_infantry_monk_age03') } },

  // ── Jin Dynasty ──
  building_town_center_capital_jin: { url: m('jin_town_center_age_01'), ages: { 2: m('jin_town_center_age_02'), 3: m('jin_town_center_age_03') } },
  building_house_1_jin: {
    url: [m('jin_house_a_age_01'), m('jin_house_b_age_01'), m('jin_house_c_age_01')],
    ages: {
      2: [m('jin_house_a_age_02+chi_house_a'), m('jin_house_b_age_02+chi_house_b'), m('jin_house_c_age_02+chi_house_c')],
      3: [m('jin_house_a_age_03+chi_house_a'), m('jin_house_b_age_03+chi_house_b'), m('jin_house_c_age_03+chi_house_c')],
    },
  },
  building_barracks_1_jin: { url: m('jin_barracks_age_01'), ages: { 2: m('jin_barracks_age_02'), 3: m('jin_barracks_age_03') } },
  building_mining_camp_1_jin: { url: m('com_mining_camp'), palette: 'timber' },
  building_lumbercamp_1_jin: { url: m('com_lumber_camp'), palette: 'timber' },
  building_mill_1_jin: { url: m('jin_grismill') },
  building_landmark_age1_great_pasture_jin: { url: m('jin_landmark_great_pasture') },
  building_grasslandmarker_2_jin: { url: m('jin_grassland_marker') },
  building_grassland_2_jin: { url: m('jin_grassland_a') },
  building_outpost_1_jin: { url: m('jin_outpost') },
  building_stable_2_jin: { url: m('jin_stable_age_02'), ages: { 3: m('jin_stable_age_03') } },
  building_blacksmith_2_jin: { url: m('jin_blacksmith_age_02'), ages: { 3: m('jin_blacksmith_age_03') } },
  unit_villager_1_jin: {
    url: [m('jin_villager_male_age01'), m('jin_villager_female_age01')],
    ages: { 2: [m('jin_villager_male_age02'), m('jin_villager_female_age02')], 3: [m('jin_villager_male_age03'), m('jin_villager_female_age03')] },
  },
  unit_mounted_villager_1_jin: {
    url: [m('jin_horse_combined_villager_male_age01'), m('jin_horse_combined_villager_female_age01')],
    ages: {
      2: [m('jin_horse_combined_villager_male_age02'), m('jin_horse_combined_villager_female_age02')],
      3: [m('jin_horse_combined_villager_male_age03'), m('jin_horse_combined_villager_female_age03')],
    },
  },
  unit_scout_1_jin: { url: m('jin_horse_combined_scout_age01'), ages: { 2: m('jin_horse_combined_scout_age02'), 3: m('jin_horse_combined_scout_age03') } },
  unit_spearman_1_jin: { url: m('jin_infantry_light_age01+spear_basic'), ages: { 2: m('jin_infantry_light_age02+spear_basic'), 3: m('jin_infantry_light_age03+spear_basic') } },
  unit_spearman_2_jin: { url: m('jin_infantry_light_age02+spear_basic'), ages: { 3: m('jin_infantry_light_age03+spear_basic') } },
  unit_horseman_2_jin: { url: m('jin_horse_combined_light_age02+jin_light_spear_age02'), ages: { 3: m('jin_horse_combined_light_age03+jin_light_spear_age02') } },
  unit_horseman_2_jin_grassland: { url: m('jin_horse_combined_light_age02+jin_light_spear_age02'), ages: { 3: m('jin_horse_combined_light_age03+jin_light_spear_age02') } },
  unit_mohe_tribesman_2_jin: { url: m('jin_horse_combined_bow_age02+bow_recurve'), ages: { 3: m('jin_horse_combined_bow_age03+bow_recurve') } },
  unit_mohe_tribesman_2_jin_grassland: { url: m('jin_horse_combined_bow_age02+bow_recurve'), ages: { 3: m('jin_horse_combined_bow_age03+bow_recurve') } },
  unit_iron_pagoda_2_jin: { url: m('jin_horse_combined_armor_age02+jin_podao_age02'), ages: { 3: m('jin_horse_combined_armor_age03+jin_podao_age02') } },
  unit_iron_pagoda_2_jin_grassland: { url: m('jin_horse_combined_armor_age02+jin_podao_age02'), ages: { 3: m('jin_horse_combined_armor_age03+jin_podao_age02') } },
  grassland_viz_horse_1: { url: [m('jin_horse_a'), m('jin_horse_b')] },
  grassland_viz_horse_2: { url: [m('jin_horse_a'), m('jin_horse_b')] },
  grassland_viz_horse_3: { url: [m('jin_horse_a'), m('jin_horse_b')] },
  grassland_viz_horse_4: { url: [m('jin_horse_a'), m('jin_horse_b')] },

  // ── Livestock, wildlife, resources, map objects ──
  gaia_herdable_sheep: { url: m('sheep') },
  gaia_herdable_sheep_black: { url: m('sheep_black') },
  gaia_herdable_sheep_brown: { url: m('sheep_brown') },
  gaia_food_sheep_corpse: { url: m('sheep'), kind: 'corpse' },
  gaia_food_sheep_black_corpse: { url: m('sheep_black'), kind: 'corpse' },
  gaia_food_sheep_brown_corpse: { url: m('sheep_brown'), kind: 'corpse' },
  gaia_huntable_deer: { url: m('deer') },
  gaia_huntable_reindeer: { url: m('jin_reindeer') },
  gaia_huntable_boar: { url: m('boar') },
  gaia_huntable_wolf: { url: m('wolf') },
  resource_gold_deposit: { url: m('gold_lrg_deposit') },
  resource_gold_deposit_small: { url: m('gold_sml_deposit') },
  resource_stone_deposit: { url: m('stone_lrg_deposit') },
  resource_stone_deposit_small: { url: m('stone_sml_deposit') },
  resource_food_forage_berry_bush: { url: m('berry_bush_med') }, // the fenced look is a state swap (build-assets attachmentList)
  resource_food_forage_berry_bush_sml: { url: m('berry_bush_small') },
  relic: { url: m('relic') },
  holy_site: { url: m('com_religious_victory+com_holy_site') },
  building_trade_post_west: { url: m('com_trading_post_west') },

  // ── Trees (instanced per type by GaiaLayer; `_untouched` = scatter/stealth art without undergrowth) ──
  birch_tall_wild: { url: m('birch_tall_wild_untouched_dense') },
  birch_med_wild: { url: m('birch_med_wild_untouched_dense') },
  birch_small_wild: { url: m('birch_small_wild_untouched_dense') },
  birch_small_wild_stealth: { url: m('birch_small_wild_untouched') },
  birch_tall_dead: { url: m('birch_tall_dead_untouched_dense') },
  birch_tall_dead_stealth: { url: m('birch_tall_dead_untouched') },
  birch_med_dead: { url: m('birch_med_dead_untouched_dense') },
  birch_med_dead_stealth: { url: m('birch_med_dead_untouched') },
  spruce_tall_wild: { url: m('spruce_tall_wild_untouched_dense') },
  spruce_med_wild: { url: m('spruce_med_wild_untouched_dense') },
  spruce_med_wild_scatter: { url: m('spruce_med_wild_untouched') },
  spruce_small_wild: { url: m('spruce_small_wild_untouched_dense') },
  spruce_small_wild_stealth: { url: m('spruce_small_wild_untouched') },
  spruce_tall_dead: { url: m('spruce_tall_dead_untouched_dense') },
  spruce_tall_dead_scatter: { url: m('spruce_tall_dead_untouched') },
  elm_small_dead_scatter: { url: m('elm_small_dead_untouched') },
  elm_med_dead_scatter: { url: m('elm_med_dead_untouched') },
};

/**
 * ASSET_MAP entry for a blueprint tools/build-assets.mjs built into assets/catalog.json (null when it found no model):
 * the first age's models are `url`, later ages appear where the models change, variants stay arrays.
 */
function catalogEntry(catalog, bp, e) {
  const ages = Object.entries(e.ages ?? {})
    .map(([age, keys]) => [age, keys.map((k) => catalog.models?.[k]?.file).filter(Boolean)])
    .filter(([, files]) => files.length);
  if (!ages.length) return null;
  const one = (files) => (files.length === 1 ? files[0] : files);
  const entry = { url: one(ages[0][1]) };
  const changes = ages.filter(([, f], i) => i > 0 && f.join() !== ages[i - 1][1].join());
  if (changes.length) entry.ages = Object.fromEntries(changes.map(([age, f]) => [age, one(f)]));
  if (e.icon) entry.icon = e.icon;
  if (/palisade/.test(bp)) entry.palette = 'timber'; // as the hand-tuned palisade pieces
  if (/_corpse$/.test(bp)) entry.kind = 'corpse';
  if (e.pack) entry.pack = e.pack; // { building, cart }: a Mongol building's two looks (core Replay.trips)
  return entry;
}

/** Procedural stand-ins (owner-tinted) by category, refined by bp pattern; also shown while a GLB loads. */
const FALLBACK_BY_CAT = {
  building: { shape: 'building', size: [8, 5, 8] },
  cavalry: { shape: 'mounted' },
  infantry: { shape: 'foot', weapon: 'spear' },
  ranged: { shape: 'foot', weapon: 'bow' },
  religious: { shape: 'foot', weapon: 'staff' },
  villager: { shape: 'foot', weapon: 'tool' },
  livestock: { shape: 'animal', color: '#e9e3d5' },
  other: { shape: 'animal', color: '#7a5a3e' },
  attachment: { shape: 'marker' },
};
/** A farm field's side (m): recorded farms stand this far apart, and farmers work within ±4 m of the centre. */
const FARM_SIZE = 8;
const FALLBACK_BY_BP = [
  [/farm/, { shape: 'field', size: [FARM_SIZE, 0.3, FARM_SIZE] }],
  [/town_center/, { shape: 'building', size: [16, 9, 16] }],
  [/landmark|wonder/, { shape: 'building', size: [18, 13, 18] }],
  [/house/, { shape: 'building', size: [6, 5, 6] }],
  [/bastion|outpost|^building_.*tower/, { shape: 'tower', size: [4, 8, 4] }],
  [/gate/, { shape: 'gate', size: [10.3, 7, 3] }], // as wide as the palisade gate GLB (core wallHalf)
  [/palisade|wall/, { shape: 'wall', size: [6.2, 4, 0.7] }],
  [/mining|lumber|mill|econ/, { shape: 'building', size: [8, 4.5, 8] }],
];
const GAIA_FALLBACK = {
  gold: { shape: 'rock', color: '#d6ab34' }, stone: { shape: 'rock', color: '#9d9a90' },
  berry: { shape: 'bush', color: '#3c6b2a' }, relic: { shape: 'marker', color: '#e2c35a' },
  sacred: { shape: 'tower', size: [3, 6, 3], color: '#d9cba4' }, trade: { shape: 'building', size: [14, 8, 14], color: '#b0a089' },
  deer: { shape: 'animal', color: '#8a6446' }, wolf: { shape: 'animal', color: '#6d6d6d' },
  boar: { shape: 'animal', color: '#4b3a2e' }, sheep: { shape: 'animal', color: '#e9e3d5' },
};

/** Structure palettes (layered materials have no single albedo in the game data). */
const PALETTES = Object.fromEntries(Object.entries({
  sultanate: { wall: '#bca583', roof: '#dbd0b8', base: '#8b806d', wood: '#74604b', woodTop: '#91795a', shade: '#625747', leaf: '#5f7f3a' },
  jin_dynasty: { wall: '#beb7a5', roof: '#566269', base: '#827e72', wood: '#755743', woodTop: '#927557', shade: '#484b47', leaf: '#5f7f3a' },
  timber: { wall: '#8d775c', roof: '#6f5337', base: '#8a8072', wood: '#806a50', woodTop: '#978163', shade: '#4a3a2a', leaf: '#5f7f3a' },
  neutral: { wall: '#bfb4a2', roof: '#7c6a58', base: '#8f877b', wood: '#7b5a3a', woodTop: '#957552', shade: '#4d443a', leaf: '#4f7a34' },
}).map(([k, p]) => [k, Object.fromEntries(Object.entries(p).map(([n, hex]) => [n, new THREE.Color(hex)]))]));
const BARK = new THREE.Color('#6b4f35');
const SKIN = { sultanate: '#9a6a4c', jin_dynasty: '#d2a585' };
const NEUTRAL_COLOR = '#a8a29a';

const BLOW_FLASH = 0.35;      // a landed melee blow's strike line fades over this (replay s)
const FLASH_SECS = 0.11;      // a struck unit flashes red this long after the recorded HP drop (replay s)
const TETHER_MAX = 45;         // engaged attackers get a faint line to their target unless further apart than this (m)
const TURN_RATE = 2.5 * Math.PI; // fastest turn on foot (rad per replay s); riders turn at 0.6×, siege engines 0.4×
const DOOR_FADE = 0.25;        // a unit shrinks into / grows out of a building's door over this (replay s)
const RUIN_FALL = 2.5;         // a destroyed building sinks into its rubble over this (replay s)
const RUIN_SECS = 12;          // the rubble stays this long after the destruction, sinking away over its last 1.5 s
const CREW_SEAT = 3.37;        // a tower crew stands this high on its war elephant (m at model scale): the basket_m
                               // bind height in the sul armour, armour upgrade and tug healer GLBs alike
const KILL_MARK_SECS = 2.5;    // kill marker lifetime (replay seconds)
const KILL_COLOR = '#ed7965';
const ADAPT_NEAR = 60, ADAPT_FAR = 280; // adaptive unit scale: true size at ≤ NEAR m camera distance, slider value at ≥ FAR
// sky dome edge (m; its corners stay inside the camera's far 6000); SKY_GAIN scales the dome's radiance to this renderer's
// ACES exposure 1.15 (unscaled it burns to white: zenith 233,242,248); SKY_FOG = the dome's horizon colour at that gain
// (sampled 197,218,225); cloud drift per replay second
const SKY_SIZE = 3000, SKY_GAIN = 0.12, SKY_FOG = '#c5dae1', SKY_CLOUD_RATE = 1;
const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16, 32]; // the 2D viewer's playback speeds
const KILL_FEED = 25;          // kill feed length (the 2D viewer's)
const CAT_LABELS = {
  villager: 'Villagers', cavalry: 'Cavalry', infantry: 'Infantry', ranged: 'Ranged', religious: 'Religious', siege: 'Siege',
  hero: 'Heroes', ship: 'Ships', unit: 'Other units', econ: 'Traders & boats', building: 'Buildings', livestock: 'Livestock',
  other: 'Pasture horses', attachment: 'Attachments (TC weapons)',
};
const CAT_ORDER = ['villager', 'cavalry', 'infantry', 'ranged', 'religious', 'siege', 'hero', 'ship', 'unit', 'econ', 'building',
  'livestock', 'other', 'attachment'];

// ═══════════════════════════════════════ 2. HELPERS ═══════════════════════════════════════

const wrapAngle = (a) => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ═══════════════════════════════════════ 3. ASSETS ═══════════════════════════════════════

let dirty = true;
const invalidate = () => { dirty = true; };
// Input may change hover, selection, options or layout without advancing replay time.
for (const event of ['pointermove', 'pointerdown', 'pointerup', 'pointerleave', 'wheel', 'keydown', 'keyup', 'click', 'input', 'change', 'toggle'])
  document.addEventListener(event, invalidate, true);
window.addEventListener('resize', invalidate);
THREE.DefaultLoadingManager.onProgress = invalidate;
THREE.DefaultLoadingManager.onLoad = invalidate;
const gltfLoader = new GLTFLoader();
// Geometry clones otherwise de-interleave repeatedly (and warn for every attribute).
// Do it once before any template/instance is built, including animation GLBs.
gltfLoader.register(() => ({
  name: 'ReplayDeinterleave',
  afterRoot(gltf) {
    for (const scene of gltf.scenes) scene.traverse((o) => {
      if (o.geometry) deinterleaveGeometry(o.geometry);
    });
    invalidate();
  },
}));

/**
 * Unit material: albedo plus the game's patternTex mask (TEAM_MASK_GLSL: player-colour cloth, skin). Normal,
 * roughness/metal and AO maps come along when the GLB has them (pbrOf). Units UnitBatches draws get the same look
 * there, with team, skin and flash per instance; this one serves static models with a mask.
 */
function makeMaskMaterial(src, team, skin, flash) {
  const mat = new THREE.MeshStandardMaterial({
    map: src.map, roughness: 0.82, metalness: 0, alphaTest: src.alphaTest || 0, side: src.side, ...pbrOf(src),
  });
  const u = {
    rvMask: { value: src.emissiveMap },
    rvTeam: { value: team.clone() },
    rvSkin: { value: skin.clone() },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform sampler2D rvMask;\nuniform vec3 rvTeam, rvSkin;\n${TEAM_MASK_GLSL}`)
      .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb = rvTeamMask(diffuseColor.rgb, texture2D(rvMask, vMapUv).rg, rvTeam, rvSkin);');
  };
  mat.customProgramCacheKey = () => 'rv-mask';
  if (flash) { mat.emissive.set(0xff2a14); mat.emissiveIntensity = 0.35; }
  mat.userData.rvMake = (f) => makeMaskMaterial(src, team, skin, f);
  return mat;
}

/**
 * Structure material: the game's Gen7 bake atlas (build-assets) — RGB albedo, A = 255 − team mask. Team-marked texels
 * become the owner's colour carrying the albedo's light/dark detail; the rest is the painted building.
 */
function makeGen7Material(src, team, flash) {
  const mat = new THREE.MeshStandardMaterial({ map: src.map, roughness: 0.85, metalness: 0 });
  const u = { rvTeam: { value: team.clone() } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 rvTeam;')
      .replace('#include <map_fragment>', `#include <map_fragment>
{
  float l = pow(dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114)), 1.0 / 2.2);
  diffuseColor.rgb = mix(diffuseColor.rgb, rvTeam * pow(clamp(2.0 * l, 0.0, 1.0), 2.2), 1.0 - sampledDiffuseColor.a);
  diffuseColor.a = 1.0;
}`);
  };
  mat.customProgramCacheKey = () => 'rv-gen7';
  if (flash) { mat.emissive.set(0xff2a14); mat.emissiveIntensity = 0.35; }
  mat.userData.rvMake = (f) => makeGen7Material(src, team, f);
  return mat;
}

/**
 * Paint a layered-material mesh from its own geometry (roofs, walls, base, timber, foliage) and bake it into
 * template space with only position/normal/color, so all stylised parts of a model merge into one draw call.
 */
function stylize(src, matrix, box, kind, pal) {
  const g = new THREE.BufferGeometry();
  const flatSrc = src.index ? src.toNonIndexed() : src;
  g.setAttribute('position', flatSrc.attributes.position.clone());
  if (flatSrc.attributes.normal) g.setAttribute('normal', flatSrc.attributes.normal.clone());
  else g.computeVertexNormals();
  g.applyMatrix4(matrix);
  const pos = g.attributes.position, nor = g.attributes.normal, n = pos.count;
  const col = new Float32Array(n * 3);
  const p = new THREE.Vector3(), q = new THREE.Vector3(), c = new THREE.Color(), cw = new THREE.Color();
  const H = Math.max(2, box.max.y), smooth = THREE.MathUtils.smoothstep;
  for (let f = 0; f + 2 < n; f += 3) {
    p.set(0, 0, 0); q.set(0, 0, 0);
    for (let k = 0; k < 3; k++) {
      p.x += pos.getX(f + k); p.y += pos.getY(f + k); p.z += pos.getZ(f + k);
      q.x += nor.getX(f + k); q.y += nor.getY(f + k); q.z += nor.getZ(f + k);
    }
    p.multiplyScalar(1 / 3);
    q.normalize();
    const h = clamp(p.y / H, 0, 1);
    let fixed = null;
    if (kind.startsWith('vegetation')) fixed = pal.leaf;
    else if (kind.startsWith('trunk')) fixed = BARK;
    else if (kind.startsWith('terrain')) fixed = pal.base;
    else if (kind.startsWith('object')) fixed = q.y > 0.7 ? pal.woodTop : pal.wood;
    const noise = 0.98 + 0.04 * hash3(Math.floor(p.x * 1.5), Math.floor(p.y * 1.5), Math.floor(p.z * 1.5));
    const shade = (0.78 + 0.22 * Math.min(1, h * 2.2)) * noise;
    for (let k = 0; k < 3; k++) {
      if (fixed) c.copy(fixed);
      else {
        // structures: blend wall → roof per vertex by its normal so smooth domes don't step per triangle
        const ny = nor.getY(f + k);
        cw.copy(h < 0.1 ? pal.base : pal.wall).lerp(pal.shade, smooth(-ny, 0.3, 0.6));
        c.copy(cw).lerp(h > 0.28 ? pal.roof : pal.base, smooth(ny, 0.35, 0.75));
      }
      c.multiplyScalar(shade);
      const o = (f + k) * 3;
      col[o] = c.r; col[o + 1] = c.g; col[o + 2] = c.b;
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/**
 * Shadow-pass depth material for skinned meshes. three's shared shadow depth material re-resolves its program
 * (getProgram) every time the pass alternates skinned and static meshes, as every unit's parts do; giving skinned
 * meshes their own keeps both programs settled. Alpha-tested materials keep three's per-material variants.
 */
const SKINNED_DEPTH = new THREE.MeshDepthMaterial();

/**
 * LOD0 part geometry of a static template → { geos, cut }: its distant levels (geos[n − 1] = rv_lod<n>; null: no
 * part there) and the model's switch specs (cut[n − 1] = rv_lod<n>'s extras.rv: `dist`, the game's switch distance
 * in m, or `error`, a generated level's simplification error in m; see BuildingBatches.level).
 */
const LODS = new WeakMap();
/** A copy of mesh o's geometry in model space (o's world matrix in its template). */
const modelGeo = (o) => o.geometry.clone().applyMatrix4(o.matrixWorld);
/** Geometries merged into one (mixed indexing made non-indexed), or null when their attribute sets differ. */
function mergeParts(geos) {
  if (geos.length === 1) return geos[0];
  const names = (g) => Object.keys(g.attributes).sort().join();
  if (geos.some((g) => names(g) !== names(geos[0]) || Object.keys(g.morphAttributes).length)) return null;
  return mergeGeometries(geos.every((g) => g.index) ? geos : geos.map((g) => (g.index ? g.toNonIndexed() : g)));
}
/** g in ref's vertex layout (attributes, their types, indexing), as one BatchedMesh needs, or null when it can't be. */
function conform(g, ref) {
  if (!g) return null;
  if (!ref.index && g.index) g = g.toNonIndexed();
  else if (ref.index && !g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
  for (const name of Object.keys(g.attributes)) if (!ref.attributes[name]) g.deleteAttribute(name);
  for (const [name, a] of Object.entries(ref.attributes)) {
    const b = g.attributes[name];
    if (!b || b.itemSize !== a.itemSize || b.normalized !== a.normalized || b.array.constructor !== a.array.constructor) return null;
  }
  return g;
}
/** A new geometry of geo's triangles `tris` (indices into its triangle list), vertices compacted, same attribute layout. */
function pickTris(geo, tris) {
  const I = geo.index, map = new Map(), out = new Uint32Array(tris.length * 3);
  tris.forEach((t, j) => {
    for (let k = 0; k < 3; k++) {
      const v = I ? I.getX(3 * t + k) : 3 * t + k;
      let n = map.get(v);
      if (n === undefined) map.set(v, (n = map.size));
      out[3 * j + k] = n;
    }
  });
  const g = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(geo.attributes)) {
    const src = a.isInterleavedBufferAttribute ? a.data.array : a.array, stride = a.isInterleavedBufferAttribute ? a.data.stride : a.itemSize;
    const off = a.isInterleavedBufferAttribute ? a.offset : 0, arr = new src.constructor(map.size * a.itemSize);
    for (const [v, n] of map) for (let c = 0; c < a.itemSize; c++) arr[n * a.itemSize + c] = src[v * stride + off + c]; // raw (normalized stays)
    g.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
  }
  g.setIndex(new THREE.BufferAttribute(out, 1));
  return I ? g : g.toNonIndexed();
}

/**
 * Palisade gate leaves. The game swings them on the layout_palisade_gate rig (bones door_left / door_right, hinged at
 * x = ±2.057 m on the gate's line; the art's const_p_gate_left / _right pieces ride them), but the exported art is
 * merged per material, so the leaves are found again: connected pieces (vertices welded by position) lying inside the
 * opening (|x| ≤ the hinge, standing on the ground below 3.3 m, within 0.25 m of the line). Each side's triangles leave
 * their LOD0 mesh for a mesh under a pivot node rv_door_l (x > 0: door_left) / rv_door_r at its hinge. The distant
 * levels keep the closed leaves (a batched gate is a closed one), so the leaf meshes have no levels there.
 */
const GATE_MODEL = /palisade_gate\.glb$/, GATE_HINGE = 2.057;
function splitDoors(root) {
  root.updateMatrixWorld(true);
  const meshes = [], pivots = [null, null];
  root.traverse((o) => { if (o.isMesh && !o.isSkinnedMesh && !o.isInstancedMesh && o.matrixWorld.determinant() > 0) meshes.push(o); });
  for (const o of meshes) {
    const geo = modelGeo(o), P = geo.attributes.position, I = geo.index, n = P.count, nt = (I ? I.count : n) / 3;
    const vi = (t, k) => (I ? I.getX(3 * t + k) : 3 * t + k);
    const par = new Int32Array(n).map((_, i) => i), weld = new Map();
    const find = (i) => { while (par[i] !== i) i = par[i] = par[par[i]]; return i; };
    for (let i = 0; i < n; i++) {
      const k = `${Math.round(P.getX(i) * 1e4)},${Math.round(P.getY(i) * 1e4)},${Math.round(P.getZ(i) * 1e4)}`, j = weld.get(k);
      if (j === undefined) weld.set(k, i); else par[find(i)] = find(j);
    }
    for (let t = 0; t < nt; t++) { const a = find(vi(t, 0)); par[find(vi(t, 1))] = a; par[find(vi(t, 2))] = a; }
    const box = new Map(); // piece root → [x0, x1, y0, y1, z0, z1]
    for (let i = 0; i < n; i++) {
      const r = find(i), x = P.getX(i), y = P.getY(i), z = P.getZ(i), b = box.get(r);
      if (!b) { box.set(r, [x, x, y, y, z, z]); continue; }
      b[0] = Math.min(b[0], x); b[1] = Math.max(b[1], x); b[2] = Math.min(b[2], y); b[3] = Math.max(b[3], y);
      b[4] = Math.min(b[4], z); b[5] = Math.max(b[5], z);
    }
    const keep = [], sides = [[], []];
    for (let t = 0; t < nt; t++) {
      const b = box.get(find(vi(t, 0)));
      const leaf = b[0] >= -GATE_HINGE - 0.02 && b[1] <= GATE_HINGE + 0.02 && b[2] >= -0.05 && b[3] <= 3.3 && b[4] >= -0.25 && b[5] <= 0.25;
      (leaf ? sides[b[0] + b[1] > 0 ? 0 : 1] : keep).push(t);
    }
    if (!sides[0].length && !sides[1].length) continue;
    const lods = LODS.get(o.geometry);
    const rest = pickTris(o.geometry, keep);
    if (lods) LODS.set(rest, lods);
    o.geometry = rest;
    sides.forEach((tris, s) => {
      if (!tris.length) return;
      const hx = s ? -GATE_HINGE : GATE_HINGE;
      if (!pivots[s]) {
        pivots[s] = new THREE.Object3D();
        pivots[s].name = s ? 'rv_door_r' : 'rv_door_l';
        pivots[s].position.set(hx, 0, 0);
        root.add(pivots[s]);
      }
      const g = pickTris(geo, tris).translate(-hx, 0, 0), leaf = new THREE.Mesh(g, o.material);
      leaf.userData.rvRole = o.userData.rvRole;
      leaf.castShadow = o.castShadow; leaf.receiveShadow = o.receiveShadow;
      if (lods) LODS.set(g, { geos: lods.geos.map(() => null), cut: lods.cut });
      pivots[s].add(leaf);
    });
  }
  return pivots.some(Boolean);
}

class AssetRegistry {
  constructor(replay) {
    this.R = replay;
    this.loading = new Map();   // url → Promise
    this.loaded = new Map();    // url → gltf | null (failed)
    this.templates = new Map(); // `${url}|${palette}` → template
    this.mats = new Map();      // per-owner / shared material cache
    this.flash = new Map();     // material → flash variant
    this.total = 0;
    this.done = 0;
    this.onProgress = null;
    this.styledMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  }

  /** Url for a map entry at a visual tier, choosing a variant by seed. */
  urlFor(entry, tier, seed) {
    if (!entry) return null;
    let u = entry.url;
    if (entry.ages) for (const k of Object.keys(entry.ages).map(Number).sort((a, b) => a - b)) if (k <= tier) u = entry.ages[k];
    return Array.isArray(u) ? u[Math.floor(seed * u.length) % u.length] : u;
  }

  request(url) {
    if (this.loading.has(url)) return;
    this.total++;
    const p = gltfLoader.loadAsync(url).then(
      (g) => {
        // Templates and unit preparation only consume scene. The completed parser retains
        // compressed buffers, texture-source promises and JSON; none is needed to instantiate.
        g.parser = null;
        this.loaded.set(url, g);
      },
      (err) => { console.warn(`[assets] ${url} failed, using procedural fallback`, err); this.loaded.set(url, null); },
    ).finally(() => { this.done++; this.onProgress?.(); invalidate(); });
    this.loading.set(url, p);
  }

  /** Template for url+palette: object when ready, null while loading, false when the GLB failed. */
  template(url, palette) {
    const key = `${url}|${palette}`;
    const hit = this.templates.get(key);
    if (hit) return hit;
    if (!this.loaded.has(url)) { this.request(url); return null; }
    const g = this.loaded.get(url);
    if (!g) return false;
    const tpl = this.build(g, PALETTES[palette] ?? PALETTES.neutral, url);
    this.templates.set(key, tpl);
    return tpl;
  }

  build(gltf, pal, url) {
    const root = cloneSkinned(gltf.scene); // rebinds skinned meshes to the cloned bones
    // distant levels (rv_lod<n> scene nodes) are never part of the shown model; static models keep them (bakeLods),
    // UnitBatches takes skinned ones from the loaded scene itself
    const lodRoots = root.children.filter((o) => /^rv_lod\d+$/.test(o.name)).sort((a, b) => a.name.slice(6) - b.name.slice(6));
    for (const o of lodRoots) { o.removeFromParent(); o.updateMatrixWorld(true); }
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    let rigged = false;
    root.traverse((o) => { rigged ||= !!o.isSkinnedMesh; });
    const { styled, baked, bakedSrc, kept, drop } = this.sortParts(root, box, pal);
    let still = !rigged; // static: what BuildingBatches can draw, so what distant levels are kept for
    for (const { o, role, mat } of kept) {
      o.material = mat;
      o.userData.rvRole = role; // mask/team meshes keep their source material; instantiate() swaps per owner
      o.castShadow = true;
      still &&= !o.isSkinnedMesh && !o.isInstancedMesh;
    }
    for (const o of drop) o.removeFromParent();
    // every stylised part shares one vertex-coloured material → bake them into a single draw call
    let styledMesh = null, bakedMesh = null;
    if (styled.length) {
      styledMesh = new THREE.Mesh(styled.length > 1 ? mergeGeometries(styled) : styled[0], this.styledMat);
      styledMesh.castShadow = styledMesh.receiveShadow = true;
      styledMesh.userData.rvRole = 'styled';
      root.add(styledMesh);
    }
    if (baked.length) {
      const geos = baked.every((g) => g.index) ? baked : baked.map((g) => (g.index ? g.toNonIndexed() : g));
      bakedMesh = new THREE.Mesh(geos.length > 1 ? mergeGeometries(geos) : geos[0], bakedSrc);
      bakedMesh.castShadow = bakedMesh.receiveShadow = true;
      bakedMesh.userData.rvRole = 'gen7';
      bakedSrc.map.anisotropy = renderer.capabilities.getMaxAnisotropy();
      root.add(bakedMesh);
    }
    if (still && lodRoots.length) {
      this.bakeLods(root, kept, styledMesh, bakedMesh, lodRoots.map((l) => this.sortParts(l, box, pal)), lodRoots.map((l) => l.userData.rv ?? {}));
    }
    if (still && GATE_MODEL.test(url)) splitDoors(root);
    const size = box.getSize(new THREE.Vector3());
    return { root, box, rigged, height: Math.max(0.5, box.max.y), radius: Math.max(0.4, Math.max(size.x, size.z) / 2) };
  }

  /**
   * The meshes under sub (the model, or one of its rv_lod levels) sorted the way build() treats them: Gen7 parts
   * for the atlas bake and layered parts for the stylised bake (both in model space, their meshes to drop), the
   * rest kept with their role and template material.
   */
  sortParts(sub, box, pal) {
    const styled = [], baked = [], kept = [], drop = [];
    let bakedSrc = null;
    sub.traverse((o) => {
      if (!o.isMesh) return;
      const src = o.material, rv = src.userData?.rv ?? {};
      if (rv.gen7 === true && src.map) {
        // one atlas material per model → bake every textured structure part into a single draw call
        const g = new THREE.BufferGeometry();
        for (const a of ['position', 'normal', 'uv']) if (o.geometry.attributes[a]) g.setAttribute(a, o.geometry.attributes[a].clone());
        if (o.geometry.index) g.setIndex(o.geometry.index.clone());
        if (!g.attributes.normal) g.computeVertexNormals();
        baked.push(g.applyMatrix4(o.matrixWorld));
        bakedSrc = src;
        drop.push(o);
        return;
      }
      const sails = typeof rv.layered === 'string' && rv.layered.startsWith('sails');
      if (rv.layered && !sails) {
        styled.push(stylize(o.geometry, o.matrixWorld, box, rv.layered, pal));
        drop.push(o);
        return;
      }
      const role = sails ? 'team' : rv.mask && src.emissiveMap ? 'mask' : 'plain';
      kept.push({ o, role, mat: role === 'plain' ? this.plain(src) : src });
    });
    return { styled, baked, bakedSrc, kept, drop };
  }

  /**
   * Distant levels of a static model (C2) for BuildingBatches, which switches a building's geometry per part by
   * distance. A level's meshes need not match LOD0's one for one, so the kept LOD0 meshes merge per material and
   * role into model space (as the Gen7 and stylised parts already are) and every level merges the same way, in the
   * LOD0 part's vertex layout; LODS maps each LOD0 part geometry to its levels and the levels' switch specs (cut).
   */
  bakeLods(root, kept, styledMesh, bakedMesh, levels, cut) {
    if (kept.some(({ o }) => o.matrixWorld.determinant() < 0)) return; // a mirrored part can't be baked into model space
    const keyOf = ({ role, mat }) => `${mat.uuid}|${role}`;
    const groups = new Map(), parts = new Map(); // key → kept LOD0 meshes / the LOD0 part mesh
    for (const k of kept) groups.set(keyOf(k), [...(groups.get(keyOf(k)) ?? []), k]);
    for (const [key, list] of groups) {
      const geo = mergeParts(list.map(({ o }) => modelGeo(o)));
      if (!geo) continue; // parts of mixed layouts keep their own meshes and stay at LOD0
      const first = list[0].o, mesh = new THREE.Mesh(geo, first.material);
      mesh.name = first.name;
      mesh.userData.rvRole = list[0].role;
      mesh.castShadow = true;
      mesh.receiveShadow = first.receiveShadow;
      for (const { o } of list) o.removeFromParent();
      root.add(mesh);
      parts.set(key, mesh);
    }
    if (styledMesh) parts.set('styled', styledMesh);
    if (bakedMesh) parts.set('gen7', bakedMesh);
    const out = new Map([...parts.values()].map((m) => [m, []]));
    for (const lv of levels) {
      const geos = new Map([['styled', lv.styled], ['gen7', lv.baked]]); // key → this level's model-space geometries
      for (const k of lv.kept) geos.set(keyOf(k), [...(geos.get(keyOf(k)) ?? []), modelGeo(k.o)]);
      for (const [key, mesh] of parts) {
        const list = geos.get(key), l = out.get(mesh);
        if (!list?.length) { l.push(null); continue; } // the part is gone at this distance
        const g = conform(mergeParts(list), mesh.geometry);
        if (!g) console.warn(`[assets] ${mesh.name || key}: LOD ${l.length + 1} differs from LOD0's vertex layout; keeping the nearer level`);
        l.push(g ?? (l.length ? l[l.length - 1] : mesh.geometry));
      }
    }
    for (const [mesh, geos] of out) LODS.set(mesh.geometry, { geos, cut });
  }

  plain(src) {
    const key = `plain|${src.uuid}`;
    let mat = this.mats.get(key);
    if (!mat) {
      mat = src.clone();
      if (!pbrOf(src)) { mat.metalness = 0; mat.roughness = Math.max(0.6, mat.roughness ?? 1); } // albedo-only GLBs stay matte
      mat.emissive?.set(0);
      mat.emissiveMap = null;
      const tint = src.userData.rv?.tint; // single models (berry bushes) take the strip's middle; forests vary per tree
      if (tint) tintAt(tint, 0.5, mat.color);
      this.mats.set(key, mat);
    }
    return mat;
  }

  /**
   * Clone a template for an owner: team/skin-tinted unit materials, team-coloured banners, own skeleton. A rigged
   * model drawn this way (no clips for its blueprint) stands in its bind pose with the torch and tools stowed.
   */
  instantiate(tpl, owner) {
    const root = tpl.rigged ? cloneSkinned(tpl.root) : tpl.root.clone(true);
    root.traverse((o) => {
      if (o.isBone && /^rv(tool_|wpn_torch$)/.test(o.name)) o.scale.setScalar(0);
      if (!o.isMesh) return;
      const role = o.userData.rvRole, src = o.material; // clone() shares materials but deep-copies userData as JSON
      if (role === 'mask') o.material = this.maskMat(src, owner);
      else if (role === 'gen7') o.material = this.gen7Mat(src, owner);
      else if (role === 'team') o.material = this.teamMat(owner);
      if (o.isSkinnedMesh && !(o.material.alphaTest > 0) && !o.material.alphaToCoverage) o.customDepthMaterial = SKINNED_DEPTH;
    });
    return { root, height: tpl.height, radius: tpl.radius };
  }

  maskMat(src, owner) {
    const key = `mask|${src.uuid}|${owner}`;
    let mat = this.mats.get(key);
    if (!mat) {
      const mask = src.emissiveMap;
      if (mask.colorSpace !== THREE.NoColorSpace) { mask.colorSpace = THREE.NoColorSpace; mask.needsUpdate = true; }
      const civ = this.R.players.get(owner)?.civ;
      mat = makeMaskMaterial(src, teamColor(this.R, owner), new THREE.Color(SKIN[civ] ?? '#c29572'), false);
      this.mats.set(key, mat);
    }
    return mat;
  }

  gen7Mat(src, owner) {
    const key = `gen7|${src.uuid}|${owner}`;
    let mat = this.mats.get(key);
    if (!mat) this.mats.set(key, (mat = makeGen7Material(src, teamColor(this.R, owner), false)));
    return mat;
  }

  teamMat(owner) {
    const key = `team|${owner}`;
    let mat = this.mats.get(key);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({ color: teamColor(this.R, owner), roughness: 0.8, side: THREE.DoubleSide });
      this.mats.set(key, mat);
    }
    return mat;
  }

  flashOf(mat) {
    let f = this.flash.get(mat);
    if (!f) {
      if (mat.userData.rvMake) f = mat.userData.rvMake(true);
      else {
        f = mat.clone();
        if (f.emissive) { f.emissive.set(0xff2a14); f.emissiveIntensity = 0.35; }
      }
      this.flash.set(mat, f);
    }
    return f;
  }
}

const NEUTRAL3 = new THREE.Color(NEUTRAL_COLOR);
const teamColor = (R, owner) => R.players.get(owner)?.color3 ?? NEUTRAL3; // color3: set right after loading (section 4)
const paletteFor = (R, entry, owner) => entry?.palette ?? R.players.get(owner)?.civ ?? 'neutral';

// ── procedural fallbacks ──
const fbGeo = new Map();
const geo = (key, make) => { let g = fbGeo.get(key); if (!g) fbGeo.set(key, g = make()); return g; };
const fbMats = new Map();
function fbMat(color) {
  const key = typeof color === 'string' ? color : `#${color.getHexString()}`;
  let mm = fbMats.get(key);
  if (!mm) fbMats.set(key, mm = new THREE.MeshStandardMaterial({ color: key, roughness: 0.85, flatShading: true }));
  return mm;
}
function part(g, mat, x, y, z, rx = 0, ry = 0, rz = 0) {
  const o = new THREE.Mesh(g, mat);
  o.position.set(x, y, z);
  o.rotation.set(rx, ry, rz);
  o.castShadow = true;
  o.receiveShadow = true;
  return o;
}
function fallbackConfig(bp, cat) {
  for (const [re, cfg] of FALLBACK_BY_BP) if (re.test(bp)) return cfg;
  return FALLBACK_BY_CAT[cat] ?? { shape: 'marker' };
}

/** Owner-tinted stand-in: boxes for buildings, mounted shapes for cavalry, capsules for infantry. */
function buildFallback(cfg, team, skin) {
  const g = new THREE.Group();
  const T = fbMat(team), S = fbMat(skin);
  let height = 2, radius = 0.5;
  switch (cfg.shape) {
    case 'building': {
      const [sx, sy, sz] = cfg.size;
      g.add(part(geo(`box${sx},${sy},${sz}`, () => new THREE.BoxGeometry(sx, sy * 0.65, sz)), fbMat(cfg.color ?? '#b7a88f'), 0, sy * 0.325, 0));
      g.add(part(geo(`roof${sx},${sy}`, () => new THREE.ConeGeometry(Math.max(sx, sz) * 0.72, sy * 0.45, 4)), T, 0, sy * 0.875, 0, 0, Math.PI / 4));
      height = sy; radius = Math.max(sx, sz) / 2;
      break;
    }
    case 'tower': {
      const [sx, sy] = cfg.size;
      g.add(part(geo(`tower${sx},${sy}`, () => new THREE.CylinderGeometry(sx / 2, sx * 0.55, sy * 0.8, 8)), fbMat(cfg.color ?? '#8a6a46'), 0, sy * 0.4, 0));
      g.add(part(geo(`troof${sx},${sy}`, () => new THREE.ConeGeometry(sx * 0.65, sy * 0.3, 8)), T, 0, sy * 0.95, 0));
      height = sy * 1.1; radius = sx / 2;
      break;
    }
    case 'wall': {
      const [sx, sy, sz] = cfg.size;
      g.add(part(geo(`wall${sx}`, () => new THREE.BoxGeometry(sx, sy, sz)), fbMat('#7b5a3a'), 0, sy / 2, 0));
      height = sy; radius = sx / 2;
      break;
    }
    case 'gate': { // two towers and a lintel: the opening reads as a gate before (or without) its model
      const [sx, sy, sz] = cfg.size, tw = 3, wood = fbMat('#7b5a3a'), tower = geo(`gtower${sy},${sz}`, () => new THREE.BoxGeometry(tw, sy, sz));
      g.add(part(tower, wood, (tw - sx) / 2, sy / 2, 0), part(tower, wood, (sx - tw) / 2, sy / 2, 0));
      g.add(part(geo(`lintel${sx},${sz}`, () => new THREE.BoxGeometry(sx - 2 * tw, sy * 0.15, sz * 0.6)), T, 0, sy * 0.85, 0));
      height = sy; radius = sx / 2;
      break;
    }
    case 'field': {
      const [sx, sy, sz] = cfg.size;
      g.add(part(geo(`field${sx}`, () => new THREE.BoxGeometry(sx, sy, sz)), fbMat('#85724f'), 0, sy / 2, 0));
      for (let i = -2; i <= 2; i++) g.add(part(geo(`furrow${sz}`, () => new THREE.BoxGeometry(0.5, 0.25, sz * 0.9)), fbMat('#a08d58'), i * sx / 5.5, sy, 0));
      const rail = geo(`rail${sx}`, () => new THREE.BoxGeometry(sx, 0.12, 0.12)), wood = fbMat('#77634b');
      g.add(part(rail, wood, 0, 0.3, sz / 2), part(rail, wood, 0, 0.3, -sz / 2), part(rail, wood, sx / 2, 0.3, 0, 0, Math.PI / 2), part(rail, wood, -sx / 2, 0.3, 0, 0, Math.PI / 2));
      height = 1; radius = sx / 2;
      break;
    }
    case 'mounted': {
      const horse = fbMat('#6b4a32');
      g.add(part(geo('hbody', () => new THREE.BoxGeometry(0.6, 0.7, 1.9)), horse, 0, 1.25, 0));
      g.add(part(geo('hneck', () => new THREE.BoxGeometry(0.32, 0.85, 0.35)), horse, 0, 1.7, 0.85, -0.5));
      g.add(part(geo('hhead', () => new THREE.BoxGeometry(0.28, 0.3, 0.62)), horse, 0, 2.0, 1.2));
      const leg = geo('hleg', () => new THREE.BoxGeometry(0.14, 0.9, 0.14));
      for (const [lx, lz] of [[0.2, 0.7], [-0.2, 0.7], [0.2, -0.7], [-0.2, -0.7]]) g.add(part(leg, horse, lx, 0.45, lz));
      g.add(part(geo('rider', () => new THREE.CapsuleGeometry(0.22, 0.55, 4, 8)), T, 0, 2.0, -0.1));
      g.add(part(geo('head', () => new THREE.SphereGeometry(0.16, 10, 8)), S, 0, 2.55, -0.1));
      height = 2.75; radius = 1.0;
      break;
    }
    case 'foot': {
      g.add(part(geo('legs', () => new THREE.BoxGeometry(0.32, 0.8, 0.22)), fbMat('#3d342b'), 0, 0.4, 0));
      g.add(part(geo('torso', () => new THREE.CapsuleGeometry(0.24, 0.45, 4, 8)), T, 0, 1.15, 0));
      g.add(part(geo('head', () => new THREE.SphereGeometry(0.16, 10, 8)), S, 0, 1.68, 0));
      const w = cfg.weapon;
      if (w === 'spear') g.add(part(geo('spear', () => new THREE.CylinderGeometry(0.03, 0.03, 2.5, 5)), fbMat('#8b7355'), 0.32, 1.25, 0.1));
      if (w === 'staff') g.add(part(geo('staff', () => new THREE.CylinderGeometry(0.04, 0.04, 1.9, 5)), fbMat('#8b7355'), 0.32, 0.95, 0.1));
      if (w === 'bow') g.add(part(geo('bow', () => new THREE.TorusGeometry(0.5, 0.03, 4, 12, Math.PI)), fbMat('#6e5236'), 0.3, 1.2, 0.15, 0, Math.PI / 2, Math.PI / 2));
      if (w === 'tool') g.add(part(geo('tool', () => new THREE.BoxGeometry(0.08, 0.08, 0.9)), fbMat('#8b7355'), 0.3, 0.95, 0.25, 0.6));
      height = 1.9; radius = 0.4;
      break;
    }
    case 'animal': {
      const c = fbMat(cfg.color ?? '#e9e3d5');
      g.add(part(geo('abody', () => new THREE.BoxGeometry(0.45, 0.45, 0.9)), c, 0, 0.6, 0));
      g.add(part(geo('ahead', () => new THREE.BoxGeometry(0.25, 0.28, 0.32)), c, 0, 0.82, 0.55));
      const leg = geo('aleg', () => new THREE.BoxGeometry(0.1, 0.4, 0.1));
      for (const [lx, lz] of [[0.14, 0.32], [-0.14, 0.32], [0.14, -0.32], [-0.14, -0.32]]) g.add(part(leg, c, lx, 0.2, lz));
      height = 1.0; radius = 0.55;
      break;
    }
    case 'rock': {
      const c = fbMat(cfg.color);
      const r = geo('rock', () => new THREE.DodecahedronGeometry(1.4, 0));
      g.add(part(r, c, 0, 0.8, 0), part(r, c, 1.6, 0.5, 0.6, 0.4, 0.8), part(r, c, -1.3, 0.5, -0.8, 1.1, 0.2));
      height = 2.2; radius = 2.5;
      break;
    }
    case 'bush': {
      g.add(part(geo('bush', () => new THREE.IcosahedronGeometry(1.0, 0)), fbMat(cfg.color), 0, 0.8, 0));
      height = 1.8; radius = 1.0;
      break;
    }
    default: { // marker
      g.add(part(geo('marker', () => new THREE.OctahedronGeometry(0.6)), cfg.color ? fbMat(cfg.color) : T, 0, 3, 0));
      height = 3.6; radius = 0.6;
    }
  }
  return { root: g, height, radius };
}

// ═══════════════════════════════════════ 4. SCENE ═══════════════════════════════════════

/** Replay, start time and key moment from the URL: #<name>[/t<seconds> | /<moment>] (the 2D viewer's links) or #t<seconds>. */
function parseHash() {
  const parts = decodeURIComponent(location.hash.slice(1)).split('/').filter(Boolean);
  const time = parts.length && /^t\d+(\.\d+)?$/.test(parts[parts.length - 1]) ? +parts.pop().slice(1) : null;
  const moment = parts.length > 1 && /^\d+$/.test(parts[parts.length - 1]) ? +parts.pop() : null; // #<name>/<n>: key moment n (1-based)
  return { name: parts[0] || DEFAULT_REPLAY, time, moment };
}
function fatal(msg) {
  const f = document.getElementById('fatal');
  f.style.display = 'flex';
  f.textContent = msg;
  const pick = document.createElement('button');
  pick.textContent = 'Choose another match';
  pick.onclick = openMatches;
  f.append(pick);
  document.getElementById('loading').style.display = 'none';
  throw new Error(msg);
}
/** Classic-script data files (window.REPLAY_DATA[name]) the way the 2D viewer loads them. */
const loadScript = (src) => new Promise((resolve) => {
  const s = document.createElement('script');
  s.src = src;
  s.onload = () => resolve(true);
  s.onerror = () => resolve(false);
  document.head.appendChild(s);
});
const LINK = parseHash();
const REPLAY_NAME = LINK.name;
if (!window.RV_UNITS) fatal(`${SHARED}units.js did not load: open the viewer through node serve.mjs, which serves the 2D viewer's folder under /${SHARED}`);
if (!await loadScript(`${SHARED}data/${encodeURIComponent(REPLAY_NAME)}.js`) || !window.REPLAY_DATA?.[REPLAY_NAME]) {
  fatal(`Could not load the replay "${REPLAY_NAME}" (${SHARED}data/${REPLAY_NAME}.js from the 2D viewer's data folder)`);
}
// built models (tools/build-assets.mjs): catalog.json fills in every built blueprint ASSET_MAP has no hand-tuned entry
// for. Weapon timings come from the shared unit statistics (the 2D viewer's stats.js, RV_FRAME.statOf).
const getJson = (url) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null).finally(invalidate);
const [CATALOG, SAVED_TWEAKS] = await Promise.all([getJson('assets/catalog.json'), getJson('tweaks.json')]);
if (!window.RV_FRAME || !window.RV_STATS || !window.RV_FX) fatal(`${SHARED}stats.js / frame.js / fx.js did not load: open the viewer through node serve.mjs`);
for (const [bp, e] of Object.entries(CATALOG?.blueprints ?? {})) {
  const entry = bp in ASSET_MAP ? null : catalogEntry(CATALOG, bp, e);
  if (entry) ASSET_MAP[bp] = entry;
}
// the 2D viewer's model of the same recording: move orders, alerts, sacred sites, conversions, cameras (marks.js, panels.js)
const RV = window.RV;
if (!RV?.prepare || !RV.markIcon) fatal(`${SHARED}model.js / map.js did not load: open the viewer through node serve.mjs`);
const M2 = RV.prepare(window.REPLAY_DATA[REPLAY_NAME], { combat: false }); // combat: the Replay's own (frame.js over R.ents)
// optional key-moment notes (the 2D viewer's notes/<name>.js); serve.mjs lists which recordings have any
if ((await getJson(`${SHARED}notes.json`))?.includes(REPLAY_NAME)) await loadScript(`${SHARED}notes/${encodeURIComponent(REPLAY_NAME)}.js`);

/**
 * Model tweaks from the inspector's sliders: a scale on top of the entry's (and the unit scale) and metres added to the
 * seat, { key: { scale, y } } keyed by blueprint (every instance) or by objKey (one entity of this replay, on top of its
 * blueprint's). Applied to the instance's own transform (group, batch slot or tree matrix), never to shared geometry.
 * Saved to serve.mjs /tweaks.json (the shared copy) and localStorage (this browser's, kept when the server can't be
 * reached; it wins on load, as the newer edit).
 */
const TWEAK_KEY = 'rv3d.tweaks', NO_TWEAK = Object.freeze({ scale: 1, y: 0 });
const TWEAKS = { ...(SAVED_TWEAKS ?? {}), ...(() => { try { return JSON.parse(localStorage.getItem(TWEAK_KEY)) ?? {}; } catch { return {}; } })() };
const objKey = (id) => `#${REPLAY_NAME.replace(/[^\w.-]/g, '_')}/${id}`; // serve.mjs validTweaks accepts this form
const _tw = { scale: 1, y: 0 };
/** The tweak to draw instance id of bp with: its blueprint's, times (scale) / plus (y) its own (a shared object then). */
function tweakOf(bp, id) {
  const b = TWEAKS[bp] ?? NO_TWEAK, o = id == null ? undefined : TWEAKS[objKey(id)];
  if (!o) return b;
  _tw.scale = b.scale * o.scale; _tw.y = b.y + o.y;
  return _tw;
}
let tweakSave = 0;
/** Store the tweaks at once locally and send them to the server after delay ms (coalescing a slider drag). */
function saveTweaks(delay) {
  localStorage.setItem(TWEAK_KEY, JSON.stringify(TWEAKS));
  clearTimeout(tweakSave);
  tweakSave = setTimeout(() => {
    fetch('tweaks.json', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(TWEAKS) })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); })
      .catch((err) => console.warn('viewer: tweaks not saved to the server (kept in this browser):', err.message));
  }, delay);
}
/** Set (or with the defaults, drop) the tweak under key (a blueprint or objKey). */
function setTweak(key, scale, y) {
  if (scale === 1 && y === 0) delete TWEAKS[key];
  else TWEAKS[key] = { scale, y };
  saveTweaks(400);
}
/** Drop every tweak, of every blueprint and object (all replays), here and on the server. */
function clearTweaks() {
  for (const k of Object.keys(TWEAKS)) delete TWEAKS[k];
  saveTweaks(0);
}
const R = new Replay(window.REPLAY_DATA[REPLAY_NAME], window.RV_UNITS, window.RV_FRAME);
// Both prepEnt (model.js) and prepEntity (core/replay.js) copy these into typed arrays;
// neither model aliases them. Keep all other raw fields for the shared economy engine.
for (const e of window.REPLAY_DATA[REPLAY_NAME].entities) e.track = e.vision = null;
// the shared FrameRenderState (frame.js): selection, hover and this frame's projectiles, heals, damage numbers and
// engagement lines, the same lists the 2D viewer draws from
const VIEW = window.RV_FRAME.controller(R.combat);
for (const p of R.players.values()) p.color3 = new THREE.Color(p.color); // renderer slot read by teamColor
const assets = new AssetRegistry(R);

const state = {
  t: R.t0, playing: false, speed: 1, unitScale: 2.5, adaptiveScale: true, scaleNow: 2.5,
  cats: new Set(R.ents.map((e) => e.cat).filter((c) => c !== 'attachment')),
  players: new Set(R.players.keys()), vision: 0, ghosts: false, // vision: player bit mask whose fog applies (0: none)
  opt: { bars: true, barMode: 'auto', dmg: true, combatFx: true, attacks: true, heat: false, projectiles: true, kills: true, fights: true, grid: true, gaia: true, grass: true, shadows: true, ao: true,
    orders: true, ecoOrders: false, trails: true, cams: false, labels: false, comp: true, // the 2D viewer's defaults for what they share
    toasts: true, debugCard: false }, // under-attack notices (hud.js); raw facts on the unit card
  selected: null, hovered: null, follow: false, quality: 'high', // quality: 'high' | 'low' (applyQuality); selected: the lone selected entity (section 8)
  camPlayer: 0, // player index whose recorded camera drives the view (0: free camera)
  followAction: false, // Follow action (G): the camera goes where the fighting is (shared director.js)
};
let anchorWall = performance.now(), anchorT = state.t;
const reanchor = (now = performance.now()) => { anchorWall = now; anchorT = state.t; invalidate(); };
const clockTime = (now) => Math.min(R.t1, anchorT + (now - anchorWall) / 1000 * state.speed);
document.addEventListener('visibilitychange', () => reanchor());
const selection = new Set(); // selected entities (section 8: setSelection)
let selVer = 0, selSynced = 0;

const viewport = document.getElementById('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping; // applied by the composer's OutputPass (or directly with AO off)
renderer.toneMappingExposure = 1.15;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.localClippingEnabled = true; // construction sites reveal their building bottom-up (setSite)
viewport.appendChild(renderer.domElement);
// rebuilt GLBs carry KTX2 (Basis) textures, transcoded in workers to a format this GPU samples; PNG GLBs load as before
gltfLoader.setKTX2Loader(new KTX2Loader().setTranscoderPath('vendor/three/examples/jsm/libs/basis/').detectSupport(renderer));

// Shadows fade out over the outer tenth of the sun's shadow box on each side instead of stopping at a hard line
// (fitShadow caps the box around the view centre). Patched into three's PCF lookup before any material compiles.
{
  const chunk = THREE.ShaderChunk.shadowmap_pars_fragment, pcf = chunk.indexOf('float getShadow( sampler2DShadow');
  const at = pcf < 0 ? -1 : chunk.indexOf('return mix( 1.0, shadow, shadowIntensity );', pcf);
  if (at < 0) console.warn('viewer: three\'s shadow shader changed; the shadow box keeps hard edges');
  else THREE.ShaderChunk.shadowmap_pars_fragment = `${chunk.slice(0, at)}shadow = mix( shadow, 1.0, smoothstep( 0.8, 1.0, max( abs( shadowCoord.x * 2.0 - 1.0 ), abs( shadowCoord.y * 2.0 - 1.0 ) ) ) );\n\t\t\t${chunk.slice(at)}`;
}

const scene = new THREE.Scene();
const world = new THREE.Group();
world.scale.z = -1; // game space is left-handed: mirror Z so +z (north) is up-screen
scene.add(world);

// warm sun, cool sky fill: lit faces read warm, shadowed faces cool
const sun = new THREE.DirectionalLight(0xffe6c4, 2.6);
sun.position.set(-160, 260, 140);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
const SHADOW_HALF = 120; // m: the shadow box never reaches further than this from the view centre (fitShadow)
Object.assign(sun.shadow.camera, { left: -SHADOW_HALF, right: SHADOW_HALF, top: SHADOW_HALF, bottom: -SHADOW_HALF, near: 10, far: 700 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.6;
scene.add(sun, sun.target);

/**
 * The sky: three's Sky dome (Preetham atmospheric scattering, procedural clouds, the sun's disc where the sun light
 * shines from), kept centred on the camera so its horizon stays at infinity. The fog fades the far ground into the
 * dome's horizon colour (SKY_FOG, read off a rendered frame at the horizon), so the map's edge blends into the sky.
 * Clouds drift with replay time, so a paused replay stays a still frame.
 */
const sky = new Sky();
sky.scale.setScalar(SKY_SIZE);
sky.frustumCulled = false;
Object.entries({ turbidity: 3.2, rayleigh: 1.3, mieCoefficient: 0.004, mieDirectionalG: 0.82, cloudCoverage: 0.38, cloudDensity: 0.45, cloudElevation: 0.55 })
  .forEach(([k, v]) => { sky.material.uniforms[k].value = v; });
sky.material.uniforms.sunPosition.value.copy(sun.position).normalize();
sky.material.uniforms.skyGain = { value: SKY_GAIN };
{
  const fs = sky.material.fragmentShader, out = 'gl_FragColor = vec4( texColor, 1.0 );';
  if (!fs.includes(out)) console.warn('viewer: three\'s Sky shader changed; the sky keeps its unscaled (white) radiance');
  else sky.material.fragmentShader = `uniform float skyGain;\n${fs.replace(out, 'gl_FragColor = vec4( texColor * skyGain, 1.0 );')}`;
}
scene.add(sky);
scene.fog = new THREE.Fog(SKY_FOG, 560, 1300);
/** Each frame: the dome follows the camera; clouds move with the replay clock. */
function updateSky(t) {
  sky.position.copy(camera.position);
  sky.material.uniforms.time.value = t * SKY_CLOUD_RATE;
  waterTime.value = t;
  waterSun.value.copy(sun.position).sub(sun.target.position).normalize();
}

/**
 * The sky fill as image-based light: a procedural outdoor sky (cool zenith, pale neutral horizon, the olive ground
 * of the hemisphere light it replaces, a soft warm glow toward the sun) prefiltered once by PMREM. Its diffuse fill
 * matches the old hemisphere (intensity 1.1) at environmentIntensity ≈ 1.1 / π, less the sky's specular share, so
 * terrain, buildings and team colours look as before (frame means within ~1/255); metal and glossy parts (normal/ORM
 * maps) now have a sky to reflect. Built once, so a paused replay stays a still frame.
 */
function skyEnvironment() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: {
      zenith: { value: new THREE.Color(0xc8d8f8) }, horizon: { value: new THREE.Color(0xe6e8e4) },
      ground: { value: new THREE.Color(0x6b6a50) }, sunCol: { value: sun.color }, sunDir: { value: sun.position.clone().normalize() },
    },
    vertexShader: 'varying vec3 vDir;\nvoid main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 zenith, horizon, ground, sunCol, sunDir;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  vec3 c = d.y > 0.0 ? mix(horizon, zenith, pow(d.y, 0.6)) : mix(horizon, ground, smoothstep(0.0, 0.15, -d.y));
  float s = max(dot(d, sunDir), 0.0);
  gl_FragColor = vec4(c + sunCol * (3.0 * pow(s, 64.0) + 0.25 * pow(s, 6.0)), 1.0);
}`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), mat), pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new THREE.Scene().add(dome), 0).texture;
  pmrem.dispose();
  dome.geometry.dispose();
  mat.dispose();
  return env;
}
scene.environment = skyEnvironment();
scene.environmentIntensity = 0.3;

/** Seamless 256² fractal value noise (scalar, repeat-wrapped) for ground detail. */
function groundNoise() {
  const N = 256, data = new Uint8Array(N * N);
  const lattice = (x, y, p, o) => hash3(((x % p) + p) % p, ((y % p) + p) % p, o);
  const smooth = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let v = 0, amp = 0.5, norm = 0;
    for (let o = 0, p = 4; o < 5; o++, p *= 2, amp *= 0.55) {
      const fx = (x / N) * p, fy = (y / N) * p, ix = Math.floor(fx), iy = Math.floor(fy);
      const ax = smooth(fx - ix), ay = smooth(fy - iy);
      const a = lattice(ix, iy, p, o), b = lattice(ix + 1, iy, p, o), c = lattice(ix, iy + 1, p, o), d = lattice(ix + 1, iy + 1, p, o);
      v += amp * ((a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay);
      norm += amp;
    }
    data[y * N + x] = Math.round((v / norm) * 255);
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const isTree = (g) => (g.kind === 'tree' || g.kind === 'stealth') && !/corpse/.test(g.bp);
/** 256² tree-density map over the arena (Gaussian σ 2 m per tree, saturating at 1): where the forest floor goes. */
function forestMask(trees, half) {
  const N = 256, cell = (2 * half) / N, acc = new Float32Array(N * N), data = new Uint8Array(N * N), r = 3;
  for (const g of trees) {
    const cx = (g.x + half) / cell - 0.5, cz = (g.z + half) / cell - 0.5;
    for (let j = Math.max(0, Math.floor(cz) - r); j <= Math.min(N - 1, Math.ceil(cz) + r); j++) {
      for (let i = Math.max(0, Math.floor(cx) - r); i <= Math.min(N - 1, Math.ceil(cx) + r); i++) {
        acc[j * N + i] += Math.exp(-(((i - cx) ** 2 + (j - cz) ** 2) * cell * cell) / (2 * 2 * 2));
      }
    }
  }
  for (let k = 0; k < N * N; k++) data[k] = Math.round(255 * Math.min(1, acc[k]));
  const tex = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
/** Smooth 2-D value noise in [0, 1] (lattice spacing 1). */
function valueNoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const ax = fx * fx * (3 - 2 * fx), az = fz * fz * (3 - 2 * fz);
  const a = hash3(ix, iz, seed), b = hash3(ix + 1, iz, seed), c = hash3(ix, iz + 1, seed), d = hash3(ix + 1, iz + 1, seed);
  return (a * (1 - ax) + b * ax) * (1 - az) + (c * (1 - ax) + d * ax) * az;
}
/** Ground layers from build-assets (Gen7 temperate terrain tiles), each tiled every TERRAIN_TILE metres. */
const TERRAIN_LAYERS = ['grass', 'lush', 'dry', 'forest', 'dirt', 'trodden'];
const TERRAIN_TILE = 10;
/** Ground continues this far past the arena edge and darkens into the shroud (as the game's map border). */
const TERRAIN_MARGIN = 240;
/** Metres walked through a wear cell at which its traffic wear reaches 1 − 1/e. */
const WEAR_WALK = 25;

/**
 * Ground worn by the replay, an RG 256² map over the arena (sampled like the forest mask): R = footprints of the
 * buildings standing at t (dirt patch), G = unit traffic up to t (metres walked per cell along the recorded tracks;
 * busy routes wear to trodden mud). Livestock and pasture animals don't count. Refreshed once replay time has moved
 * ≥ 1 s; traffic accumulates while time runs forward and is re-walked from the start after a backward jump.
 */
class GroundWear {
  constructor(half) {
    const N = (this.N = 256);
    this.half = half;
    this.cell = (2 * half) / N;
    this.walked = new Float32Array(N * N);
    this.built = new Float32Array(N * N);
    this.data = new Uint8Array(N * N * 2);
    this.tex = new THREE.DataTexture(this.data, N, N, THREE.RGFormat);
    this.tex.magFilter = this.tex.minFilter = THREE.LinearFilter;
    this.tex.needsUpdate = true;
    this.uniform = { value: this.tex };
    this.movers = R.ents.filter((e) => e.isUnit && e.cat !== 'livestock' && e.cat !== 'other' && e.t.length > 1);
    this.next = new Int32Array(this.movers.length); // first track segment not yet walked, per mover
    this.t = -Infinity;
    this.version = 0; // bumped on every refresh
  }

  update(t) {
    if (t < this.t) { this.walked.fill(0); this.next.fill(0); this.t = -Infinity; }
    if (t - this.t < 1) return;
    this.t = t;
    this.movers.forEach((e, k) => {
      let i = this.next[k];
      for (; i + 1 < e.t.length && e.t[i + 1] <= t; i++) this.walk(e.x[i], e.z[i], e.x[i + 1], e.z[i + 1]);
      this.next[k] = i;
    });
    this.built.fill(0);
    for (const e of R.ents) {
      if (!e.isBuilding || !alive(e, t)) continue;
      const { x, z } = place(e, t); // where it stands now (Mongol buildings move)
      if (/farm/.test(e.bp)) { this.square(x, z, FARM_SIZE / 2); continue; } // no grass through the field
      const r = e.view?.model ? e.view.radius * (ASSET_MAP[e.bp]?.scale ?? 1) : (fallbackConfig(e.bp, e.cat).size?.[0] ?? 8) / 2;
      this.stamp(x, z, e.wall ? 1.6 : 0.95 * r);
    }
    // the map's own structures clear their ground too (grass blades otherwise bury a holy site's steps or a trade post's
    // wares); they stand where the map placed them
    for (const g of R.gaia) if ((g.kind === 'sacred' || g.kind === 'trade') && gaiaOn(g, t)) this.stamp(g.x, g.z, 0.95 * (g.view?.radius ?? 7));
    const { walked, built, data } = this;
    for (let k = 0; k < walked.length; k++) {
      data[2 * k] = 255 * Math.min(1, built[k]);
      data[2 * k + 1] = 255 * (1 - Math.exp(-walked[k] / WEAR_WALK));
    }
    this.tex.needsUpdate = true;
    this.version++;
  }

  /** Redo the footprints on the next update (a model's real size arrived); walks carry on where they were. */
  refresh() {
    this.t = -Infinity;
  }

  /** One recorded track segment, splatted every half cell; standing still or teleports (garrison) don't wear. */
  walk(x0, z0, x1, z1) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 0.3 || len > 20) return;
    const n = Math.ceil(len / (0.5 * this.cell)), w = len / n;
    for (let s = 0.5; s < n; s++) this.splat(x0 + ((x1 - x0) * s) / n, z0 + ((z1 - z0) * s) / n, w);
  }

  splat(x, z, w) {
    const N = this.N, fx = (x + this.half) / this.cell - 0.5, fz = (z + this.half) / this.cell - 0.5;
    const i = Math.floor(fx), j = Math.floor(fz), ax = fx - i, az = fz - j;
    if (i < 0 || j < 0 || i >= N - 1 || j >= N - 1) return;
    const W = this.walked, k = j * N + i;
    W[k] += w * (1 - ax) * (1 - az); W[k + 1] += w * ax * (1 - az);
    W[k + N] += w * (1 - ax) * az; W[k + N + 1] += w * ax * az;
  }

  /** Building footprint: solid out to 0.55 r, fading out by 1.1 r + 2 m. */
  stamp(x, z, r) {
    const N = this.N, cell = this.cell, reach = 1.1 * r + 2;
    const cx = (x + this.half) / cell - 0.5, cz = (z + this.half) / cell - 0.5, rc = Math.ceil(reach / cell);
    for (let j = Math.max(0, Math.floor(cz) - rc); j <= Math.min(N - 1, Math.ceil(cz) + rc); j++) {
      for (let i = Math.max(0, Math.floor(cx) - rc); i <= Math.min(N - 1, Math.ceil(cx) + rc); i++) {
        const d = Math.hypot(i - cx, j - cz) * cell, k = j * N + i;
        this.built[k] = Math.max(this.built[k], 1 - THREE.MathUtils.smoothstep(d, 0.55 * r, reach));
      }
    }
  }

  /** Axis-aligned square footprint of half side h: solid inside, fading out over 1 m past its edge. */
  square(x, z, h) {
    const N = this.N, cell = this.cell, reach = h + 1;
    const cx = (x + this.half) / cell - 0.5, cz = (z + this.half) / cell - 0.5, rc = Math.ceil(reach / cell);
    for (let j = Math.max(0, Math.floor(cz) - rc); j <= Math.min(N - 1, Math.ceil(cz) + rc); j++) {
      for (let i = Math.max(0, Math.floor(cx) - rc); i <= Math.min(N - 1, Math.ceil(cx) + rc); i++) {
        const d = Math.max(Math.abs(i - cx), Math.abs(j - cz)) * cell, k = j * N + i;
        this.built[k] = Math.max(this.built[k], 1 - THREE.MathUtils.smoothstep(d, h - 0.5, reach));
      }
    }
  }
}

class Terrain {
  constructor(T, half, trees) {
    this.T = T;
    this.half = half;
    this.grid = { value: 1 };
    this.forest = { value: forestMask(trees, half) };
    this.wear = new GroundWear(half);
    this.layers = Object.fromEntries(TERRAIN_LAYERS.map((n) => [n, { value: null }]));
    this.textured = { value: 0 };
    this.mesh = this.build();
    this.loadLayers();
  }

  /** Textured ground once every layer has loaded; without built layers the procedural colouring stays. */
  loadLayers() {
    const loader = new THREE.TextureLoader(), aniso = renderer.capabilities.getMaxAnisotropy();
    Promise.all(TERRAIN_LAYERS.map((n) => loader.loadAsync(`assets/terrain/${n}.png`))).then((texs) => {
      texs.forEach((tex, i) => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = aniso;
        this.layers[TERRAIN_LAYERS[i]].value = tex;
      });
      this.textured.value = 1;
    }, () => console.info('terrain layers not built (tools/build-assets.mjs): procedural ground'));
  }

  /** Bilinear terrain height at game (x, z) from the recorder grid (samples at cell centres). */
  heightAt(x, z) {
    const T = this.T;
    if (!T) return 0;
    const fx = clamp((x - T.x0) / T.step, 0, T.cols - 1), fz = clamp((z - T.z0) / T.step, 0, T.rows - 1);
    const c = Math.min(T.cols - 2, Math.floor(fx)), r = Math.min(T.rows - 2, Math.floor(fz)), ax = fx - c, az = fz - r;
    const h = T.h, i = r * T.cols + c;
    return (h[i] * (1 - ax) + h[i + 1] * ax) * (1 - az) + (h[i + T.cols] * (1 - ax) + h[i + T.cols + 1] * ax) * az;
  }

  /** Ground height at game (x, z): recorded terrain in the arena; outside, the edge height plus hills that rise with distance. */
  groundAt(x, z) {
    const h = this.heightAt(x, z), out = Math.max(Math.abs(x), Math.abs(z)) - this.half;
    if (out <= 0) return h;
    const hills = 0.7 * valueNoise(x / 60, z / 60, 7) + 0.3 * valueNoise(x / 23, z / 23, 11);
    return h + THREE.MathUtils.smoothstep(out, 0, 50) * (hills - 0.3) * 14;
  }

  build() {
    const half = this.half, step = 4, ext = half + TERRAIN_MARGIN, n = Math.round((ext * 2) / step) + 1;
    const pos = new Float32Array(n * n * 3);
    let hmin = Infinity, hmax = -Infinity;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = -ext + i * step, z = -ext + j * step, h = this.groundAt(x, z), o = (j * n + i) * 3;
      pos[o] = x; pos[o + 1] = h; pos[o + 2] = z;
      if (Math.abs(x) <= half && Math.abs(z) <= half) { hmin = Math.min(hmin, h); hmax = Math.max(hmax, h); }
    }
    const idx = [];
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = (j + 1) * n + i, c = a + 1, d = b + 1;
      idx.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const nor = g.attributes.normal, col = new Float32Array(n * n * 3);
    const lo = new THREE.Color('#5e754d'), mid = new THREE.Color('#7a8b57'), hi = new THREE.Color('#899064'), dirt = new THREE.Color('#8b785e');
    const c = new THREE.Color();
    for (let k = 0; k < n * n; k++) {
      const u = clamp((pos[k * 3 + 1] - hmin) / Math.max(1, hmax - hmin), 0, 1);
      if (u < 0.5) c.copy(lo).lerp(mid, u * 2); else c.copy(mid).lerp(hi, (u - 0.5) * 2);
      c.lerp(dirt, clamp((1 - nor.getY(k)) * 4, 0, 0.7));
      c.multiplyScalar(0.98 + 0.04 * hash3(pos[k * 3] | 0, pos[k * 3 + 2] | 0, 1));
      col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    const grid = this.grid, noise = { value: (this.noise = groundNoise()) };
    const green = { value: new THREE.Color('#6b8550') }, dry = { value: new THREE.Color('#a49668') };
    mat.onBeforeCompile = (sh) => {
      const L = this.layers;
      Object.assign(sh.uniforms, {
        uGrid: grid, uNoise: noise, uGreen: green, uDry: dry, uTextured: this.textured, uForestMask: this.forest, uWear: this.wear.uniform,
        uGrassTex: L.grass, uLushTex: L.lush, uDryTex: L.dry, uForestTex: L.forest, uDirtTex: L.dirt, uTroddenTex: L.trodden,
        uTile: { value: TERRAIN_TILE }, uHalf: { value: this.half },
      });
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vRaw;\nvarying float vSlope;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRaw = position;\nvSlope = 1.0 - normal.y;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec3 vRaw;
varying float vSlope;
uniform float uGrid, uTextured, uTile, uHalf;
uniform sampler2D uNoise, uForestMask, uWear, uGrassTex, uLushTex, uDryTex, uForestTex, uDirtTex, uTroddenTex;
uniform vec3 uGreen, uDry;
float rvLine(vec2 p, float s, float w) {
  vec2 q = p / s;
  vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
  return 1.0 - min(min(g.x, g.y) / w, 1.0);
}
// one ground layer: the tile, or (sel → 1) a rotated 2.7× copy, so the repeat does not show from afar
vec3 rvLayer(sampler2D t, vec2 p, float sel) {
  vec3 a = texture(t, p / uTile).rgb;
  vec3 b = texture(t, mat2(0.8, -0.6, 0.6, 0.8) * p / (uTile * 2.7) + 0.31).rgb;
  return mix(a, b, sel);
}`)
        .replace('#include <color_fragment>', `#include <color_fragment>
vec2 p = vRaw.xz;
float rvOut = max(abs(p.x), abs(p.y)) - uHalf; // metres past the arena edge
// trampled ground (GroundWear): dirt where buildings stand and units walk, trodden mud on the busiest routes
vec2 wr = texture(uWear, p / (2.0 * uHalf) + 0.5).rg;
float wn = 0.35 * (texture(uNoise, p / 7.0 + 0.19).r - 0.5), wIn = step(rvOut, 0.0);
float wDirt = max(smoothstep(0.3, 0.8, wr.r + wn), smoothstep(0.2, 0.75, wr.g + wn)) * wIn;
float wMud = smoothstep(0.55, 1.0, max(wr.r, wr.g) + wn) * wIn;
if (uTextured > 0.5) {
  // short grass ↔ lush patchy grass (~40 m patches), dry grass on dry patches and slopes, forest floor under trees
  float sel = smoothstep(0.4, 0.6, texture(uNoise, p / 96.0 + 0.71).r);
  vec3 g = mix(rvLayer(uGrassTex, p, sel), rvLayer(uLushTex, p, sel), smoothstep(0.35, 0.65, texture(uNoise, p / 160.0 + 0.13).r));
  float dryW = max(smoothstep(0.58, 0.74, texture(uNoise, p / 192.0 + 0.37).r), smoothstep(0.06, 0.22, vSlope));
  g = mix(g, rvLayer(uDryTex, p, sel), dryW);
  float fm = texture(uForestMask, p / (2.0 * uHalf) + 0.5).r + 0.3 * (texture(uNoise, p / 16.0 + 0.53).r - 0.5);
  g = mix(g, rvLayer(uForestTex, p, sel), 0.85 * smoothstep(0.62, 0.95, fm) * (1.0 - smoothstep(0.0, 8.0, rvOut)));
  g = mix(g, rvLayer(uDirtTex, p, sel), 0.9 * wDirt);
  g = mix(g, rvLayer(uTroddenTex, p, sel), 0.8 * wMud);
  diffuseColor.rgb = g * (0.95 + 0.1 * texture(uNoise, p / 40.0).r);
} else {
  // procedural ground: fine brightness noise (~3 m features) + greener / drier grass patches (~48 m)
  diffuseColor.rgb *= 0.94 + 0.12 * texture(uNoise, p / 12.0).r;
  diffuseColor.rgb = mix(diffuseColor.rgb, mix(uGreen, uDry, smoothstep(0.30, 0.70, texture(uNoise, p / 192.0 + 0.37).r)), 0.22);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.52, 0.44, 0.33), 0.7 * max(wDirt, wMud));
}
if (uGrid > 0.5 && rvOut < 0.0) {
  // faint: 8 m lines only up close (they fade out once a cell is under ~10 px), 32 m lines and the axes everywhere
  float mn = rvLine(p, 8.0, 1.0) * (1.0 - smoothstep(0.06, 0.12, length(fwidth(p / 8.0))));
  float mj = rvLine(p, 32.0, 1.0);
  float ax = 1.0 - min(min(abs(vRaw.x), abs(vRaw.z)) / 0.18, 1.0);
  diffuseColor.rgb *= 1.0 - 0.025 * mn;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 0.86), 0.055 * mj);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.98, 0.85, 0.45), 0.07 * ax);
}
diffuseColor.rgb *= 1.0 - 0.85 * smoothstep(0.0, 70.0, rvOut);`);
    };
    const mesh = new THREE.Mesh(g, mat);
    mesh.receiveShadow = true;
    return mesh;
  }
}

const HALF = (R.d.world?.width ?? 416) / 2;
const terrain = new Terrain(R.terrain, HALF, R.gaia.filter(isTree));
world.add(terrain.mesh);
{
  // arena frame following the terrain edge
  const pts = [];
  const edge = (x, z) => pts.push(new THREE.Vector3(x, terrain.heightAt(x, z) + 0.4, z));
  for (let v = -HALF; v <= HALF; v += 4) edge(v, -HALF);
  for (let v = -HALF; v <= HALF; v += 4) edge(HALF, v);
  for (let v = HALF; v >= -HALF; v -= 4) edge(v, HALF);
  for (let v = HALF; v >= -HALF; v -= 4) edge(-HALF, v);
  world.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#b4b69b', transparent: true, opacity: 0.2 })));
}

/**
 * Water. The replay records none (the game exposes no water flag), so its level is the 2D viewer's inference (model.js
 * waterLevel): the highest fish's ground + WATER_LIFT m; a map without fish has no water. One plane over the arena at
 * that level; the depth under it comes from the recorded height grid (a half-float texture), so shallows, opacity and
 * the shoreline foam need no depth pre-pass. Colours: the game's lake water (lake_water_temperate.rrmaterial
 * g_waterColour, g_deepWaterColour, linear). Ripples are two scrolling octaves of the terrain's noise read as a height
 * field (normals by finite differences), reflecting a sky gradient by Fresnel (Schlick, F0 0.02) plus the sun's glint;
 * foam bands run up sloping banks only (one level for the whole map floods flat lowland a little on river maps; there
 * it stays clear shallow water). Everything moves with replay time, so a paused replay is still. Low graphics
 * (waterLow): flat surface, no glint, still foam.
 */
const WATER_LIFT = 0.2, WATER_DRAFT = 0.15; // m; a boat floats this deep
const WATER_LEVEL = (() => {
  const fish = R.terrain ? R.gaia.filter((g) => g.kind === 'fish') : [];
  return fish.length ? Math.max(...fish.map((g) => terrain.heightAt(g.x, g.z))) + WATER_LIFT : null;
})();
const waterTime = { value: 0 }, waterLow = { value: 0 }, waterSun = { value: new THREE.Vector3(0, 1, 0) };
function makeWater(level) {
  const T = R.terrain, half = new Uint16Array(T.h.length);
  for (let i = 0; i < half.length; i++) half[i] = THREE.DataUtils.toHalfFloat(T.h[i]);
  const hTex = new THREE.DataTexture(half, T.cols, T.rows, THREE.RedFormat, THREE.HalfFloatType);
  hTex.magFilter = hTex.minFilter = THREE.LinearFilter;
  hTex.needsUpdate = true;
  const lin = (hex) => new THREE.Color(hex); // three's Color is linear: hex strings convert from sRGB
  const mat = new THREE.ShaderMaterial({
    transparent: true, fog: true,
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      hTex: { value: hTex }, noise: { value: terrain.noise }, level: { value: level },
      hGrid: { value: new THREE.Vector4(T.x0, T.z0, T.step, 0) }, hSize: { value: new THREE.Vector2(T.cols, T.rows) },
      time: waterTime, low: waterLow, sunDir: waterSun, sunCol: { value: sun.color },
      shallow: { value: new THREE.Color().setRGB(0.0137, 0.0931, 0.1046) }, deep: { value: new THREE.Color().setRGB(0.013, 0.0437, 0.0823) },
      skyH: { value: lin(SKY_FOG) }, skyZ: { value: lin('#86a9d4') },
    },
    vertexShader: `
      varying vec3 vW;
      #include <fog_pars_vertex>
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vec4 mvPosition = viewMatrix * w;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform sampler2D hTex, noise; uniform vec4 hGrid; uniform vec2 hSize;
      uniform float level, time, low; uniform vec3 sunDir, sunCol, shallow, deep, skyH, skyZ;
      varying vec3 vW;
      #include <fog_pars_fragment>
      float ground(vec2 g) { return texture2D(hTex, ((g - hGrid.xy) / hGrid.z + 0.5) / hSize).r; }
      float wave(vec2 p) {
        return texture2D(noise, p * 0.045 + time * vec2(0.011, 0.007)).r + 0.6 * texture2D(noise, p * 0.11 - time * vec2(0.013, -0.009)).r;
      }
      void main() {
        vec2 g = vec2(vW.x, -vW.z); // world z mirrors game z
        float depth = level - ground(g);
        if (depth < -0.05) discard;
        float slope = length(vec2(ground(g + vec2(2.0, 0.0)) - ground(g - vec2(2.0, 0.0)), ground(g + vec2(0.0, 2.0)) - ground(g - vec2(0.0, 2.0)))) / 4.0;
        vec3 n = vec3(0.0, 1.0, 0.0);
        if (low < 0.5) {
          float h0 = wave(vW.xz), e = 0.5;
          n = normalize(vec3((h0 - wave(vW.xz + vec2(e, 0.0))) / e * 0.6, 1.0, (h0 - wave(vW.xz + vec2(0.0, e))) / e * 0.6));
        }
        vec3 V = normalize(cameraPosition - vW), r = reflect(-V, n);
        float F = 0.02 + 0.98 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
        vec3 body = mix(shallow, deep, smoothstep(0.3, 5.0, depth)) * (0.5 + 0.8 * max(sunDir.y, 0.0)) * sunCol;
        vec3 col = mix(body, mix(skyH, skyZ, clamp(r.y, 0.0, 1.0)), F);
        col += (1.0 - low) * 3.0 * sunCol * pow(max(dot(r, sunDir), 0.0), 180.0);
        float shore = (1.0 - smoothstep(0.0, 0.4, depth)) * smoothstep(0.03, 0.1, slope); // a bank, not a flooded flat
        float foam = shore * (low > 0.5 ? 0.25 : smoothstep(0.6, 0.9, 0.7 * wave(vW.xz * 2.5) + 0.2 + 0.25 * sin(depth * 18.0 - time * 1.6)));
        col = mix(col, vec3(0.7, 0.74, 0.72), foam * 0.6);
        float a = max(max(clamp(1.0 - exp(-depth * 0.9), 0.0, 0.9), F * 0.9), foam * 0.8) * smoothstep(-0.05, 0.08, depth);
        gl_FragColor = vec4(col, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(2 * HALF, 2 * HALF).rotateX(-Math.PI / 2), mat);
  m.position.y = level;
  m.name = 'water';
  return m;
}
if (WATER_LEVEL != null) world.add(makeWater(WATER_LEVEL));

/** Text lying flat on the ground just outside the arena at game (x, z), upright from the default south-facing camera. */
function groundLabel(text, x, z, { size = 4.5, color = '#f5f0e0', bg = 'rgba(10,14,18,0.55)', bold = false } = {}) {
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');
  const font = `${bold ? '700' : '600'} 44px system-ui, sans-serif`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 24;
  cv.width = w; cv.height = 64;
  ctx.font = font;
  if (bg) { ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(0, 4, w, 56, 12); ctx.fill(); }
  ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, 34);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const hw = (size * w) / 128, hh = size / 2;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(2 * hw, size), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  let y = terrain.groundAt(x, z); // rest above the highest ground under the label
  for (const [dx, dz] of [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]]) y = Math.max(y, terrain.groundAt(x + dx, z + dz));
  m.position.set(x, y + 0.3, -z);
  return m;
}
// coordinate markers every 32 m along the south (x) and west (z) edges, plus a north arrow, flat on the ground
const coordLabels = new THREE.Group();
scene.add(coordLabels);
for (let v = -192; v <= 192; v += 32) coordLabels.add(groundLabel(String(v), v, -HALF - 6), groundLabel(String(v), -HALF - 8, v));
coordLabels.add(
  groundLabel('N ▲', 0, HALF + 10, { size: 8, color: '#ffd166', bold: true }),
  groundLabel('x →', HALF + 12, -HALF - 6, { size: 5.5, color: '#ffd166' }),
  groundLabel('z ↑', -HALF - 8, HALF + 10, { size: 5.5, color: '#ffd166' }),
);

// ── gaia: instanced trees (real GLBs per type, procedural stand-ins until loaded) + GLB resources/animals ──
function colored(g0, hex) {
  const g = g0.index ? g0.toNonIndexed() : g0;
  g.deleteAttribute('uv');
  const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
/** Darken crown undersides (baked into vertex colours): ×0.76 facing down → ×1 facing up. */
function shadeCrown(g) {
  const nor = g.attributes.normal, col = g.attributes.color;
  for (let i = 0; i < col.count; i++) {
    const k = 0.76 + 0.24 * THREE.MathUtils.smoothstep(nor.getY(i), -0.35, 0.65);
    col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k);
  }
  return g;
}
/** ±amp radial wobble, continuous in position so coincident vertices of the shared crown stay welded. */
function lumpy(g, amp) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const f = 1 + amp * Math.sin(x * 1.9 + z * 0.7) * Math.cos(y * 2.1 - z * 1.3);
    p.setXYZ(i, x * f, y * f, z * f);
  }
  return g;
}
function treeGeometry(kind) {
  const trunk = (h, r, hex) => colored(new THREE.CylinderGeometry(r * 0.6, r, h, 6).translate(0, h / 2, 0), hex);
  const crown = (g, hex) => shadeCrown(colored(g, hex));
  const parts = [];
  if (kind === 'conifer') {
    parts.push(trunk(3, 0.32, '#5a4030'),
      crown(lumpy(new THREE.ConeGeometry(2.7, 4.4, 10), 0.08).translate(0, 4.3, 0), '#3e5140'),
      crown(lumpy(new THREE.ConeGeometry(2.1, 3.8, 10), 0.08).rotateY(0.4).translate(0.22, 6.6, -0.15), '#4a6048'),
      crown(lumpy(new THREE.ConeGeometry(1.35, 3.1, 10), 0.08).rotateY(0.9).translate(-0.18, 8.8, 0.24), '#587151'));
  } else if (kind === 'conifer_dead') {
    parts.push(trunk(9.5, 0.3, '#6a5a4a'),
      colored(new THREE.ConeGeometry(1.6, 3, 5).translate(0, 4.8, 0), '#5d5040'),
      colored(new THREE.ConeGeometry(1.0, 2.6, 5).translate(0, 7.2, 0), '#66594a'));
  } else if (kind === 'birch') {
    parts.push(trunk(6, 0.24, '#bbb7a3'),
      crown(lumpy(new THREE.IcosahedronGeometry(2.5, 1), 0.2).scale(1.1, 1.05, 0.9).translate(0, 6.8, 0), '#6e8454'),
      crown(lumpy(new THREE.IcosahedronGeometry(1.45, 1), 0.2).translate(1.35, 8.0, -0.55), '#849764'));
  } else {
    parts.push(trunk(7, 0.26, '#6e6050'));
    for (const [rz, ry, y] of [[0.8, 0, 4.6], [-0.7, 1.9, 5.4], [0.9, 3.8, 6.1]]) {
      parts.push(colored(new THREE.CylinderGeometry(0.06, 0.12, 2.6, 4).translate(0, 1.3, 0).rotateZ(rz).rotateY(ry).translate(0, y, 0), '#6e6050'));
    }
  }
  return mergeGeometries(parts);
}
const treeKind = (bp) => (/^spruce/.test(bp) ? (/dead/.test(bp) ? 'conifer_dead' : 'conifer') : /dead/.test(bp) ? 'dead' : 'birch');
const treeSize = (bp) => (/tall/.test(bp) ? 1 : /med/.test(bp) ? 0.82 : 0.64);
const ANIMALS = new Set(['deer', 'wolf', 'boar', 'sheep']);
// share of its width and height a mine or bush has lost once empty (the height: the 2D viewer's pile alpha). The game
// has no depleted look for them (resource_*_deposit ebps: no depleted_resource_animator_blueprint or dca states; the
// deposit art's 9–19 meshes are the rock pieces of one collection, not stages), so this shrink is ours.
const DEPLETE = { gold: [0.15, 0.55], stone: [0.15, 0.55], berry: [0.3, 0.6] };
/** Map objects whose rocks follow the ground under each vertex (drape). */
const DRAPED = new Set(['gold', 'stone']);
const _dv = new THREE.Vector3(), _dRel = new THREE.Matrix4(), _dInv = new THREE.Matrix3(), _dRoot = new THREE.Matrix4();
/**
 * Lay a deposit's rocks onto the ground: each vertex of the instance's own copy of its geometry (the template's stays
 * shared and untouched) rises by the ground height under it at heading and scale s, less the height at the centre.
 * The game's deposit art sits at its stamp's origin with most of each rock below it (gold_lrg_deposit y −3.0..2.4) —
 * buried by design — so lifting by the box bottom would float it; a single centre height on a slope instead buries the
 * uphill rocks. Redone from the template geometry (userData.drapeSrc) when the scale changes.
 */
function drape(root, g, s) {
  root.updateMatrixWorld(true);
  _dRoot.copy(root.matrixWorld).invert();
  const c = terrain.heightAt(g.x, g.z), cos = Math.cos(g.heading), sin = Math.sin(g.heading);
  root.traverse((o) => {
    if (!o.isMesh) return;
    const src = (o.userData.drapeSrc ??= o.geometry), pos = src.attributes.position;
    if (o.geometry !== src) o.geometry.dispose();
    const geo = src.clone(), out = new Float32Array(pos.count * 3);
    _dRel.multiplyMatrices(_dRoot, o.matrixWorld); // mesh → model space
    _dInv.setFromMatrix4(_dRel).invert();
    for (let i = 0; i < pos.count; i++) {
      _dv.fromBufferAttribute(pos, i);
      out[3 * i] = _dv.x; out[3 * i + 1] = _dv.y; out[3 * i + 2] = _dv.z;
      _dv.applyMatrix4(_dRel);
      const x = g.x + s * (_dv.x * cos + _dv.z * sin), z = g.z + s * (-_dv.x * sin + _dv.z * cos); // Object3D rotation.y
      _dv.set(0, (terrain.heightAt(x, z) - c) / s, 0).applyMatrix3(_dInv);
      out[3 * i] += _dv.x; out[3 * i + 1] += _dv.y; out[3 * i + 2] += _dv.z;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
    geo.computeBoundingBox(); geo.computeBoundingSphere();
    o.geometry = geo;
  });
}
/**
 * Vegetation tint (build-assets extras.rv.tint = the material's tintColourLUT strip): #7f7f7f is neutral, so the
 * linear multiplier is colour / #7f7f7f (grey tree leaves take the entry's colour, green berry bushes stay as is).
 * The tree strips run autumn → summer (birch: hue 34° orange … 90° green). u ∈ [0, 1) picks one entry, weighted to
 * the green entries so a forest stays green with scattered yellow/orange highlights; neutral strips pick uniformly.
 */
const NEUTRAL_TINT = new THREE.Color('#7f7f7f').r;
const tintCdf = new WeakMap(); // strip → cumulative pick weights
function tintAt(tint, u, out) {
  let cdf = tintCdf.get(tint);
  if (!cdf) {
    const hsl = {}, c = new THREE.Color();
    let sum = 0;
    cdf = tint.map((hex) => {
      c.set(hex).getHSL(hsl, THREE.SRGBColorSpace);
      sum += hsl.s < 0.05 ? 1 : 0.06 + THREE.MathUtils.smoothstep(hsl.h * 360, 50, 72);
      return sum;
    });
    for (let i = 0; i < cdf.length; i++) cdf[i] /= sum;
    tintCdf.set(tint, cdf);
  }
  let i = 0;
  while (i < cdf.length - 1 && cdf[i] <= u) i++;
  return out.set(tint[i]).multiplyScalar(1 / NEUTRAL_TINT);
}

/** Wind on planted trees, driven by replay time (it freezes with the replay): bend ∝ height², leaves also flutter. */
const windTime = { value: 0 };
function windMaterial(src, leaf) {
  const m = src.clone(), prev = src.onBeforeCompile, key = src.customProgramCacheKey();
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    sh.uniforms.rvWind = windTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float rvWind;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  float ph = rvWind * 1.4 + dot(instanceMatrix[3].xz, vec2(0.13, 0.09)); // planted trees are always instanced
  float bend = 0.0012 * transformed.y * max(transformed.y, 0.0);
  transformed.x += bend * (sin(ph) + 0.3 * sin(2.6 * ph + 1.7));
  transformed.z += bend * 0.5 * cos(1.2 * ph);
  ${leaf ? 'transformed += objectNormal * 0.05 * sin(rvWind * 5.0 + dot(position, vec3(2.1, 1.7, 2.9)));' : ''}
}`);
  };
  m.customProgramCacheKey = () => `${key}|wind${leaf ? '-leaf' : ''}`;
  return m;
}

// Felled trees: a tree chopped by villagers (Replay.villagerJobs' first chopping stand) tips over away from the first
// chopper at its first axe impact and lies until the data removes it; a stump stays from the fall, or from the removal
// of a tree nobody was seen chopping.
const STROKE_AT = 0.55;  // the axe lands at this share of either logger chop clip (where the palm's swing stops)
const FELL_EASE = 0.3;   // s into the stand before a stroke counts: unitAnim's work clip has eased in by then
const FALL_SECS = 1.2, FALL_ANGLE = 1.52; // the fall (accelerating) and the angle it comes to rest at (rad)
/** The first chopper's first axe impact, as unitAnim loops its work clip (from the stand's start, phased by seed). */
function fellTime(g) {
  const v = R.byId.get(g.chopBy), s = g.chopT0 + FELL_EASE;
  const ids = v && units.resolve(v.bp, 'work', ANIMS.blueprints[v.bp]?.style ?? JOB_KEY[J_WOOD]);
  const n = ids ? Math.min(ids.length, 8) : 0; // clipTable's variants: oneOf(T.work, seed)
  const dur = n ? units.handles[ids[Math.floor(v.seed * n) % n]].dur : JOBS[J_WOOD].period;
  return s + ((((STROKE_AT - (v?.seed ?? 0)) * dur - (s - g.chopT0)) % dur) + dur) % dur;
}
/** How far over (rad) a felled tree is at t. */
const fallAt = (g, t) => (t < g.fellT ? 0 : FALL_ANGLE * Math.min(1, (t - g.fellT) / FALL_SECS) ** 2);
const _fp = new THREE.Vector3(), _fs = new THREE.Vector3(), _fk = new THREE.Vector3(), _gp = new THREE.Vector3();
const _fq = new THREE.Quaternion(), _fr = new THREE.Quaternion(), _fm = new THREE.Matrix4();
const _seatP = new THREE.Vector3(), _seatS = new THREE.Vector3(), _seatQ = new THREE.Quaternion(), _seatUp = new THREE.Vector3(0, 1, 0);
/** Unit vector (data space) a felled tree falls along: away from its first chopper (a hashed way if on top of it). */
function fallDir(g, out) {
  const dx = g.x - g.chopX, dz = g.z - g.chopZ, d = Math.hypot(dx, dz);
  return d > 0.01 ? out.set(dx / d, 0, dz / d) : out.set(Math.cos(TAU * g.seed), 0, Math.sin(TAU * g.seed));
}

class GaiaLayer {
  constructor(parent) {
    this.group = new THREE.Group();
    parent.add(this.group);
    this.trees = [];
    this.objs = [];
    this.forests = new Map(); // tree bp → { url, list } until its GLB is planted
    const byKind = new Map();
    for (const g of R.gaia) {
      if (isTree(g)) {
        const k = treeKind(g.bp);
        if (!byKind.has(k)) byKind.set(k, []);
        byKind.get(k).push(g);
        const url = assets.urlFor(ASSET_MAP[g.bp], 1, 0);
        if (url && !this.forests.has(g.bp)) this.forests.set(g.bp, { url, list: [] });
        this.forests.get(g.bp)?.list.push(g);
      } else this.objs.push(g);
    }
    // procedural stand-ins: shown while a type's GLB loads, and for good without assets
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
    const tint = new THREE.Color();
    const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    this.standIns = new Map(); // stand-in mesh → instances not yet replaced by a planted model
    for (const [kind, list] of byKind) {
      const geo = treeGeometry(kind);
      geo.computeBoundingBox();
      const box = geo.boundingBox, bh = box.max.y, br = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2;
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      list.forEach((g, i) => {
        const sc = treeSize(g.bp) * (0.88 + 0.24 * g.seed), sxz = sc * (0.85 + 0.25 * hash01(g.id ?? i));
        q.setFromAxisAngle(up, g.heading);
        g.gy = terrain.heightAt(g.x, g.z);
        p.set(g.x, g.gy - 0.2, g.z);
        s.set(sxz, sc, sxz);
        g.tree = { meshes: [mesh], i, matrix: mtx.compose(p, q, s).clone(), shown: true, th: 0, h: bh * sc, r: br * sxz };
        mesh.setMatrixAt(i, g.tree.matrix);
        mesh.setColorAt(i, tint.setScalar(0.94 + 0.12 * hash01((g.id ?? i) + 7919)));
      });
      this.group.add(mesh);
      this.standIns.set(mesh, list.length);
      this.trees.push(...list);
    }
    this.zero = new THREE.Matrix4().makeScale(0, 0, 0);
    this.lastT = NaN;
  }

  /** Swap stand-ins for real models as their GLBs arrive (a failed GLB keeps its stand-ins). */
  plantReady() {
    for (const [bp, f] of this.forests) {
      const tpl = assets.template(f.url, 'neutral');
      if (tpl === null) continue;
      this.forests.delete(bp);
      if (tpl) this.plant(tpl, f.list);
    }
  }

  /**
   * One InstancedMesh per material of a tree type (Gen7 bark atlas, leaf cards, undergrowth), all swaying in the
   * wind. Leaf materials take one tint-strip entry per tree (instanceColor); bark gets a slight brightness jitter.
   */
  plant(tpl, list) {
    const byMat = new Map();
    tpl.root.updateMatrixWorld(true);
    tpl.root.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry.clone();
      for (const a of Object.keys(g.attributes)) if (a !== 'position' && a !== 'normal' && a !== 'uv') g.deleteAttribute(a);
      if (!byMat.has(o.material)) byMat.set(o.material, []);
      byMat.get(o.material).push(g.applyMatrix4(o.matrixWorld));
    });
    const c = new THREE.Color();
    const meshes = [...byMat].map(([src, geos]) => {
      const tint = src.userData.rv?.tint;
      const mat = windMaterial(src, !!tint);
      if (tint) mat.color.set(0xffffff); // the per-tree tint goes in instanceColor
      if (!geos.every((g) => g.index)) geos = geos.map((g) => (g.index ? g.toNonIndexed() : g));
      const mesh = new THREE.InstancedMesh(geos.length > 1 ? mergeGeometries(geos) : geos[0], mat, list.length);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      list.forEach((g, i) => mesh.setColorAt(i, tint
        ? tintAt(tint, hash01((g.id ?? i) + 104729), c)
        : c.setScalar(0.9 + 0.2 * hash01((g.id ?? i) + 7919))));
      this.group.add(mesh);
      return mesh;
    });
    list.forEach((g, i) => {
      const old = g.tree;
      g.tree = { meshes, i, matrix: new THREE.Matrix4(), shown: old.shown, th: old.th, h: 0, r: 0, tplH: tpl.height, tplR: tpl.radius };
      this.seat(g);
      const m = !old.shown ? this.zero : old.th ? this.tipped(g, old.th) : g.tree.matrix;
      for (const mesh of meshes) mesh.setMatrixAt(i, m);
      const stand = old.meshes[0];
      stand.setMatrixAt(old.i, this.zero);
      stand.instanceMatrix.needsUpdate = true;
      const left = this.standIns.get(stand) - 1;
      this.standIns.set(stand, left);
      if (!left) { stand.removeFromParent(); stand.geometry.dispose(); this.standIns.delete(stand); }
    });
  }

  /** A planted tree's upright matrix, height and radius: its seat, heading, size jitter and its (blueprint's) tweak. */
  seat(g) {
    const T = g.tree, tw = tweakOf(g.bp, g.id), sc = (0.9 + 0.2 * g.seed) * tw.scale;
    _seatQ.setFromAxisAngle(_seatUp, g.heading);
    _seatP.set(g.x, terrain.heightAt(g.x, g.z) + tw.y, g.z);
    _seatS.set(sc, sc * (0.95 + 0.1 * hash01((g.id ?? T.i) + 31)), sc);
    T.matrix.compose(_seatP, _seatQ, _seatS);
    T.h = T.tplH * _seatS.y; T.r = T.tplR * sc;
  }

  /** Re-seat the planted trees a tweak changed (test(g)); the next update redraws every map object. */
  retune(test) {
    for (const g of this.trees) if (g.tree?.tplH != null && test(g)) this.seat(g);
    this.lastT = NaN;
  }

  /**
   * Felled trees (chopped, or removed before the end), at the first update once unit clips are indexed: each chopped
   * tree's fall time (g.fellT), and a stump instance per felled tree from its fall, else its removal, on.
   */
  fell() {
    const list = [], p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    for (const g of this.trees) {
      const end = g.spans[g.spans.length - 1];
      if (g.chopT0 < Infinity) g.fellT = fellTime(g);
      const at = Math.min(g.fellT, end < R.t1 ? end : Infinity), k = treeSize(g.bp) * (0.9 + 0.2 * g.seed);
      if (at < Infinity) list.push({ at, on: false, m: new THREE.Matrix4().compose(p.set(g.x, g.gy, g.z), q.setFromAxisAngle(up, g.heading), s.setScalar(k)) });
    }
    if (!list.length) return list;
    // bark sides, a pale cut face on top; sunk 5 cm so it meets sloped ground
    const geo = new THREE.CylinderGeometry(0.24, 0.32, 0.5, 7).translate(0, 0.2, 0), nor = geo.attributes.normal;
    const cut = new THREE.Color('#c9a878'), col = new Float32Array(nor.count * 3);
    for (let i = 0; i < nor.count; i++) (nor.getY(i) > 0.5 ? cut : BARK).toArray(col, 3 * i);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.stumps = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), list.length);
    this.stumps.castShadow = this.stumps.receiveShadow = true;
    this.stumps.frustumCulled = false;
    for (let i = 0; i < list.length; i++) this.stumps.setMatrixAt(i, this.zero);
    this.group.add(this.stumps);
    return list;
  }

  /** A felled tree's matrix th rad into its fall: its upright matrix tipped over about the trunk base. */
  tipped(g, th) {
    g.tree.matrix.decompose(_fp, _fq, _fs);
    fallDir(g, _fk).set(_fk.z, 0, -_fk.x); // the axis that tips +y toward the fall
    return _fm.compose(_fp, _fr.setFromAxisAngle(_fk, th).multiply(_fq), _fs);
  }

  update(t, dt) {
    this.group.visible = state.opt.gaia;
    if (!state.opt.gaia) return;
    if (this.forests.size) this.plantReady();
    this.felled ??= this.fell();
    windTime.value = t;
    if (t !== this.lastT) {
      const dirty = new Set();
      for (const g of this.trees) {
        let on = alive(g, t);
        if (on && g.amT) { locateGaia(g, t); on = g.amount > 0; }
        g.shown = on;
        const T = g.tree, th = on ? fallAt(g, t) : 0;
        if (on === T.shown && th === T.th) continue;
        T.shown = on; T.th = th;
        const m = !on ? this.zero : th ? this.tipped(g, th) : T.matrix;
        for (const mesh of T.meshes) { mesh.setMatrixAt(T.i, m); dirty.add(mesh); }
      }
      this.felled.forEach((f, i) => {
        const on = t >= f.at;
        if (on === f.on) return;
        f.on = on;
        this.stumps.setMatrixAt(i, on ? f.m : this.zero);
        dirty.add(this.stumps);
      });
      for (const mesh of dirty) mesh.instanceMatrix.needsUpdate = true;
      this.lastT = t;
    }
    for (const g of this.objs) this.updateObject(g, t, dt);
  }

  updateObject(g, t, dt) {
    let on = g.kind === 'sacred' ? t >= g.spans[0] : alive(g, t);
    if (on) { locateGaia(g, t); if (g.amT && g.amount <= 0) on = false; }
    g.on = g.shown = on;
    if (!on) { if (g.view) g.view.group.visible = false; return; }
    const v = g.view ?? (g.view = { group: new THREE.Group(), key: undefined, heading: g.heading, height: 1, radius: 1 });
    if (!v.group.parent) this.group.add(v.group);
    v.group.visible = true;
    const entry = ASSET_MAP[g.bp];
    const url = assets.urlFor(entry, 1, g.seed);
    if (v.key !== url) {
      const tpl = url ? assets.template(url, 'neutral') : false;
      const anim = tpl?.rigged ? unitReady(url, g.bp) : false; // null while its clips load: keep what is shown
      if ((tpl && anim !== null) || (!v.model && !v.unit)) {
        if (v.model) { v.group.remove(v.model); v.model = null; }
        if (v.unit) { units.remove(v); v.unit = null; }
        if (anim) { v.unit = url; units.add(v, url, 0); v.height = tpl.height; v.radius = tpl.radius; } else {
          const obj = tpl ? assets.instantiate(tpl, 0) : buildFallback(GAIA_FALLBACK[g.kind] ?? { shape: 'rock', color: '#888' }, NEUTRAL_COLOR, '#c29572');
          v.model = obj.root;
          v.height = obj.height; v.radius = obj.radius;
          v.lift = 0.2 * (tpl?.height ?? 1); // a carcass without clips lies on its side
          v.group.add(obj.root);
          if (tpl && (g.kind === 'sacred' || g.kind === 'trade')) terrain.wear.refresh(); // GroundWear sizes their ground by the model
        }
        if ((tpl && anim !== null) || tpl === false || !url) v.key = url;
      }
    }
    // a carcass takes over from the fallen sheep at its scale and pose; live gaia animals show at 0.8×
    const corpse = entry?.kind === 'corpse', side = corpse && !v.unit;
    const tw = tweakOf(g.bp, g.id), beast = corpse || ANIMALS.has(g.kind), s = (beast ? (corpse ? 1 : 0.8) * g.us : 1) * tw.scale; // g.us: CrowdCap
    g.gy = terrain.heightAt(g.px, g.pz);
    v.group.position.set(g.px, g.gy + tw.y + (side ? v.lift * s : 0), g.pz);
    v.group.scale.setScalar(s);
    if (v.model && DRAPED.has(g.kind) && (v.draped !== v.model || v.drapeS !== s)) { drape(v.model, g, s); v.draped = v.model; v.drapeS = s; }
    // mines and bushes shrink as they empty (scale, not fade: their materials are shared)
    const dep = DEPLETE[g.kind];
    if (dep && g.amT && g.full > 0) {
      const used = 1 - clamp(g.amount / g.full, 0, 1), w = s * (1 - dep[0] * used);
      v.group.scale.set(w, s * (1 - dep[1] * used), w);
    }
    v.heading += wrapAngle(g.heading - v.heading) * Math.min(1, dt * 6);
    v.group.rotation.set(0, v.heading, side ? Math.PI / 2 : 0);
    if (v.unit) {
      v.group.updateMatrix();
      // an animal falls at its death (deathOf); a carcass model lies dead from the start
      const since = corpse ? Infinity : t - deathOf(g);
      if (animalAnim(g, v, t, since, s / (beast ? g.us : state.scaleNow))) units.set(v, _us);
    }
  }

  /**
   * The map object under ray (a sphere test over each drawn one; mines, bushes, animals and relics before trees), or
   * null. A tree is tested at its trunk's middle, wherever it has fallen to.
   */
  pick(ray) {
    let best = null, bestD = Infinity;
    for (const g of this.objs) {
      const v = g.view;
      if (!g.shown || !v) continue;
      _gp.set(g.px, g.gy + v.height * v.group.scale.y * 0.5, -g.pz);
      const r = Math.max(1, v.radius * v.group.scale.x * 0.8), d = ray.origin.distanceToSquared(_gp); // as its ring
      if (d < bestD && ray.distanceSqToPoint(_gp) <= r * r) { bestD = d; best = g; }
    }
    if (best) return best;
    for (const g of this.trees) {
      if (!g.shown) continue;
      const T = g.tree, r = Math.max(1, T.r);
      if (T.th) fallDir(g, _gp).multiplyScalar(0.5 * T.h * Math.sin(T.th)); else _gp.set(0, 0, 0);
      _gp.set(g.x + _gp.x, g.gy + 0.5 * T.h * Math.cos(T.th), -(g.z + _gp.z));
      const d = ray.origin.distanceToSquared(_gp);
      if (d < bestD && ray.distanceSqToPoint(_gp) <= r * r) { bestD = d; best = g; }
    }
    return best;
  }
  /** Height of g's top as drawn (tooltip and label anchor). */
  topOf(g) { return g.tree ? g.gy + Math.max(1.5, g.tree.h * Math.cos(g.tree.th)) : g.gy + g.view.height * g.view.group.scale.y; }
  /** g's radius on the ground as drawn (rings). */
  radiusOf(g) { return g.tree ? g.tree.r : g.view.radius * g.view.group.scale.x; }
}
const gaia = new GaiaLayer(world);

/**
 * Grass around the orbit target: Gen7 blade cards (build-assets assets/terrain/blades.*) as crossed quads on a fixed
 * GRASS_CELL jittered grid within GRASS_R, so clumps stay put while the view moves (re-laid once the target has moved
 * GRASS_RELAY metres or the ground wear refreshed). Patchy by noise; none on worn ground, forest floor, building
 * footprints or past the arena edge; clumps shrink away over the outer quarter of the radius. Hidden from
 * GRASS_MAX_DIST camera distance (blades would be sub-pixel). Up normals light it like the ground; it sways with the
 * replay-time wind and casts no shadow.
 */
const GRASS_R = 60, GRASS_CELL = 1, GRASS_RELAY = 6, GRASS_MAX_DIST = 150;
class GrassField {
  constructor(parent) {
    this.parent = parent;
    this.mesh = null;
    this.at = new THREE.Vector2(Infinity, Infinity); // game (x, z) of the last layout
    this.wearVersion = -1;
    Promise.all([
      fetch('assets/terrain/blades.json').then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText)))),
      new THREE.TextureLoader().loadAsync('assets/terrain/blades.png'),
    ]).then(([meta, tex]) => this.init(meta, tex), () => console.info('grass blades not built (tools/build-assets.mjs): no grass'));
  }

  init(meta, tex) {
    const S = meta.size, total = meta.cards.reduce((a, c) => a + c.weight, 0);
    let acc = 0;
    this.cards = meta.cards.map((c) => ({
      height: c.height, width: (c.height * c.w) / c.h, upTo: (acc += c.weight) / total,
      rect: [c.x / S, 1 - (c.y + c.h) / S, (c.x + c.w) / S, 1 - c.y / S], // u0, v0 (bottom), u1, v1 (top)
    }));
    const geo = bladeCardGeometry();
    const max = Math.ceil(Math.PI * (GRASS_R / GRASS_CELL + 2) ** 2); // jittered points within R lie in cells within R + √2 cells
    this.rect = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    geo.setAttribute('aRect', this.rect);
    const mat = bladeMaterial(tex, true);
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.setColorAt(0, new THREE.Color());
    this.parent.add(this.mesh);
  }

  update() {
    if (!this.mesh) return;
    this.mesh.visible = state.opt.grass && state.quality !== 'low' && camera.position.distanceTo(controls.target) < GRASS_MAX_DIST;
    if (!this.mesh.visible) return;
    const x = controls.target.x, z = -controls.target.z; // world mirrors Z
    if (this.at.distanceTo(_grassAt.set(x, z)) < GRASS_RELAY && this.wearVersion === terrain.wear.version) return;
    this.at.set(x, z);
    this.wearVersion = terrain.wear.version;
    this.layout(x, z);
  }

  layout(cx, cz) {
    const c = GRASS_CELL, wear = terrain.wear, N = wear.N, forest = terrain.forest.value.image.data;
    const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color(), rect = this.rect.array, lim = HALF - 1;
    let n = 0;
    for (let j = Math.floor((cz - GRASS_R) / c); j <= Math.ceil((cz + GRASS_R) / c); j++) {
      for (let i = Math.floor((cx - GRASS_R) / c); i <= Math.ceil((cx + GRASS_R) / c); i++) {
        const x = (i + hash3(i, j, 23)) * c, z = (j + hash3(i, j, 29)) * c, d = Math.hypot(x - cx, z - cz);
        if (d > GRASS_R || Math.abs(x) > lim || Math.abs(z) > lim || valueNoise(x / 11, z / 11, 5) < 0.38) continue;
        const k = Math.floor(((z + HALF) / (2 * HALF)) * N) * N + Math.floor(((x + HALF) / (2 * HALF)) * N);
        if (Math.max(wear.data[2 * k], wear.data[2 * k + 1]) > 75 || forest[k] > 115) continue;
        const h = hash3(i, j, 31), card = this.cards.find((cd) => h <= cd.upTo) ?? this.cards[0];
        const sc = (0.85 + 0.6 * hash3(i, j, 37)) * (1 - THREE.MathUtils.smoothstep(d, 0.75 * GRASS_R, GRASS_R));
        q.setFromAxisAngle(up, hash3(i, j, 41) * Math.PI);
        p.set(x, terrain.heightAt(x, z) - 0.03, z);
        s.set(card.width * sc, card.height * sc, card.width * sc);
        this.mesh.setMatrixAt(n, mtx.compose(p, q, s));
        this.mesh.setColorAt(n, col.setScalar(1 + 0.25 * hash3(i, j, 43)));
        rect.set(card.rect, 4 * n);
        n++;
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
    this.rect.needsUpdate = true;
  }
}
const _grassAt = new THREE.Vector2();

/** Two crossed unit cards rooted at y 0, normals up (blades light like the ground under them). */
function bladeCardGeometry() {
  const card = (rot) => new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0).rotateY(rot);
  const geo = mergeGeometries([card(0), card(Math.PI / 2)]);
  const nor = geo.attributes.normal;
  for (let i = 0; i < nor.count; i++) nor.setXYZ(i, 0, 1, 0);
  return geo;
}

/**
 * Material for instanced blade cards: alpha-cut tex, swaying with the replay-time wind. atlas: each instance reads its
 * card's rect (u0, v0, u1, v1) from the aRect attribute.
 */
function bladeMaterial(tex, atlas) {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.9 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.rvWind = windTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${atlas ? 'attribute vec4 aRect;\n' : ''}uniform float rvWind;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>${atlas ? '\nvMapUv = mix(aRect.xy, aRect.zw, uv);' : ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
transformed.x += uv.y * uv.y * 0.12 * sin(rvWind * 2.3 + dot(instanceMatrix[3].xz, vec2(0.35, 0.21)));`);
    // both faces keep the up normal (DoubleSide would flip it on back faces); alpha grows with the mip level so thin
    // blades survive minification instead of averaging away under the cut-off
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('gl_FrontFacing ? 1.0 : - 1.0', '1.0'))
      .replace('#include <alphatest_fragment>', `{
  vec2 texel = vMapUv * vec2(textureSize(map, 0));
  diffuseColor.a *= 1.0 + 0.3 * max(0.0, log2(max(length(dFdx(texel)), length(dFdy(texel)))));
}
#include <alphatest_fragment>`);
  };
  mat.customProgramCacheKey = () => (atlas ? 'rv-grass' : 'rv-blade');
  return mat;
}

/**
 * Farm fields as the game paints them (build-assets catalog.json `farms`): no mesh, a soil splat over the field and the
 * crop as blade cards in rows. A field is FARM_SIZE square and axis-aligned (ebps site_ext forced_axis_aligned_footprint;
 * recorded farms stand 8 m apart); soil and crops follow the ground under it. The crop card follows the game's
 * resource_state: sprout while the field is being built (rising with its progress), mature once built, damaged while a
 * destroyed field goes; a crop without a card for a state shows its mature one. Around each recorded farming stand
 * (a villager's J_FARM stop on the field) the crop within FARM_CUT_R shows the game's harvest card (reaped stubble)
 * from the first sickle swing until FARM_REGROW s after the farmer leaves.
 */
const FARM_ROW = 0.8, FARM_STEP = 0.45, FARM_EDGE = 0.3, FARM_GROW_STEPS = 12; // m: rows wide enough to show the soil
// m a farmer reaps about its stand; s its stubble stays after it leaves ([inference]: the game regrows reaped crop, its
// rate is not decoded)
const FARM_CUT_R = 0.9, FARM_REGROW = 30;
const FARM_HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0), NO_STANDS = [];
class FarmFields {
  constructor(spec) {
    this.spec = spec;
    this.card = bladeCardGeometry();
    this.mats = new Map(); // `${crop}|${state}` → blade material
    this.soils = new Map(); // crop → soil material
    const n = Math.floor((FARM_SIZE - 2 * FARM_EDGE) / FARM_ROW) + 1, m = Math.floor((FARM_SIZE - 2 * FARM_EDGE) / FARM_STEP) + 1;
    this.rows = n;
    this.per = m;
  }

  has(bp) {
    const crop = this.spec?.blueprints?.[bp];
    return !!(crop && this.spec.crops?.[crop]?.cards?.mature);
  }

  mat(crop, state) {
    const k = `${crop}|${state}`;
    let m = this.mats.get(k);
    if (!m) this.mats.set(k, (m = bladeMaterial(new THREE.TextureLoader().load(this.spec.crops[crop].cards[state].file), false)));
    return m;
  }

  soil(crop) {
    let m = this.soils.get(crop);
    if (!m) {
      const s = this.spec.crops[crop].soil, tex = new THREE.TextureLoader().load(s.file);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(s.tile[0], s.tile[1]);
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      // the splat's alpha is its soft edge onto the ground (drawn just above it, after the opaque pass)
      m = new THREE.MeshStandardMaterial({ map: tex, roughness: 1, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      this.soils.set(crop, m);
    }
    return m;
  }

  /**
   * Farming stands on field e: { x, z (from its centre), t0, t1 } per recorded J_FARM stop of a villager standing on
   * it; all fields' lists are gathered on first use.
   */
  standsOf(e) {
    if (!this.byField) {
      this.byField = new Map();
      const fields = R.ents.filter((f) => f.isBuilding && this.has(f.bp)), h = FARM_SIZE / 2;
      for (const u of R.ents) {
        if (!u.job) continue;
        for (let i = 0, last = NaN; i < u.t.length; i++) {
          if (u.job[i] !== J_FARM || u.jobT0[i] === last) continue;
          const x = u.x[i], z = u.z[i], t0 = (last = u.jobT0[i]);
          const f = fields.find((f) => Math.abs(x - f.x[0]) <= h && Math.abs(z - f.z[0]) <= h && f.spans[0] <= t0 && (f.died ?? Infinity) > t0);
          if (!f) continue;
          let l = this.byField.get(f);
          if (!l) this.byField.set(f, (l = []));
          l.push({ x: x - f.x[0], z: z - f.z[0], t0, t1: u.jobT1[i] });
        }
      }
    }
    return this.byField.get(e) ?? NO_STANDS;
  }

  /** The field model for farm e standing at (e.px, e.pz): { root, height, radius, farm } (farm: setCrop's state). */
  field(e) {
    const crop = this.spec.blueprints[e.bp], h = FARM_SIZE / 2, y0 = terrain.heightAt(e.px, e.pz);
    const geo = new THREE.PlaneGeometry(FARM_SIZE, FARM_SIZE, 16, 16).rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, terrain.heightAt(e.px + pos.getX(i), e.pz + pos.getZ(i)) - y0 + 0.04);
    geo.computeVertexNormals();
    const soil = new THREE.Mesh(geo, this.soil(crop));
    soil.receiveShadow = true;
    const count = this.rows * this.per, at = new Float32Array(count * 5); // x, y, z, yaw, size jitter per plant
    for (let r = 0, k = 0; r < this.rows; r++) {
      for (let c = 0; c < this.per; c++, k++) {
        const x = -h + FARM_EDGE + r * FARM_ROW + 0.12 * (hash3(e.id, k, 51) - 0.5), z = -h + FARM_EDGE + c * FARM_STEP + 0.2 * (hash3(e.id, k, 53) - 0.5);
        at.set([x, terrain.heightAt(e.px + x, e.pz + z) - y0, z, hash3(e.id, k, 57) * Math.PI, 0.85 + 0.3 * hash3(e.id, k, 59)], 5 * k);
      }
    }
    const crops = new THREE.InstancedMesh(this.card, this.mat(crop, 'mature'), count);
    crops.receiveShadow = true;
    const root = new THREE.Group();
    root.add(soil, crops);
    let cut = null; // the reaped plants (harvest card), where the crop has one
    if (this.spec.crops[crop].cards.harvest) {
      cut = new THREE.InstancedMesh(this.card, this.mat(crop, 'harvest'), count);
      cut.receiveShadow = true;
      root.add(cut);
    }
    const farm = { crop, crops, cut, reaped: new Uint8Array(count), cutKey: '', at, state: null, grow: -1 };
    this.layout(farm, 'mature', 1);
    return { root, height: this.spec.crops[crop].cards.mature.height, radius: h * Math.SQRT2, farm };
  }

  /**
   * Show view v's field (farm e) in crop state at grow (0–1, construction progress) of the card's height, mature
   * plants about the stands active at t reaped.
   */
  setCrop(v, state, grow, e, t) {
    const f = v.farm, st = this.spec.crops[f.crop].cards[state] ? state : 'mature', g = Math.round(grow * FARM_GROW_STEPS) / FARM_GROW_STEPS;
    let key = '';
    if (f.cut && st === 'mature') {
      const S = this.standsOf(e);
      for (let k = 0; k < S.length; k++) if (t >= S[k].t0 + 0.4 && t < S[k].t1 + FARM_REGROW) key += `${k},`;
    }
    if (f.state === st && f.grow === g && f.cutKey === key) return;
    if (f.state !== st) {
      const m = this.mat(f.crop, st), mm = v.meshes.find((x) => x.mesh === f.crops);
      if (mm) mm.base = m;
      f.crops.material = v.flashOn ? assets.flashOf(m) : m;
    }
    if (f.cutKey !== key) {
      f.cutKey = key;
      f.reaped.fill(0);
      if (key) {
        const S = this.standsOf(e), on = key.split(',').slice(0, -1).map((k) => S[k]), a = f.at;
        for (let k = 0; k < f.reaped.length; k++) f.reaped[k] = on.some((s) => Math.hypot(a[5 * k] - s.x, a[5 * k + 2] - s.z) < FARM_CUT_R) ? 1 : 0;
      }
    }
    this.layout(f, st, g);
  }

  layout(f, st, g) {
    const cards = this.spec.crops[f.crop].cards, card = cards[st], ch = card.height * Math.max(0.15, g), cw = card.height * card.aspect;
    const hc = f.cut && st === 'mature' ? cards.harvest : null;
    const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    for (let k = 0, a = f.at; k < a.length / 5; k++) {
      const j = a[5 * k + 4], reaped = hc && f.reaped[k];
      p.set(a[5 * k], a[5 * k + 1] - 0.02, a[5 * k + 2]);
      q.setFromAxisAngle(up, a[5 * k + 3]);
      f.crops.setMatrixAt(k, reaped ? FARM_HIDDEN : mtx.compose(p, q, s.set(cw * j, ch * j, cw * j)));
      if (f.cut) f.cut.setMatrixAt(k, reaped ? mtx.compose(p, q, s.set(hc.height * hc.aspect * j, hc.height * j, hc.height * hc.aspect * j)) : FARM_HIDDEN);
    }
    f.crops.instanceMatrix.needsUpdate = true;
    f.crops.computeBoundingSphere();
    if (f.cut) { f.cut.instanceMatrix.needsUpdate = true; f.cut.computeBoundingSphere(); }
    f.state = st;
    f.grow = g;
  }
}
const farms = new FarmFields(CATALOG?.farms);
const grass = new GrassField(world);

// ═══════════════════════════════════════ 5. ENTITIES ═══════════════════════════════════════

const entityRoot = new THREE.Group();
world.add(entityRoot);

/**
 * Gap-filler stakes (build-assets gapFillers → catalog.json blueprints[bp].gapFill), so infantry can't slip between a
 * wall and an obstacle next to it. A post (core linkWalls e.arms) plants one every radial.step degrees around it outside
 * radial.occupied degrees about each wall leaving it, reaching gf.reach; a wall piece's free end (no wall goes on
 * there) fans capless.count over capless.range degrees about its line, reaching capless.reach. A ray that meets an
 * obstacle in reach gets a stake to it: the shortest piece model that spans the gap (the longest ones first past
 * that), along the ray. The game spreads a post's stakes over each free arc [inference: centred, step apart].
 * Obstacles are the map objects whose blueprint takes stakes (catalog gapTarget, ebps attach_gap_fillers: mines and
 * berry bushes) as their axis-aligned footprint box, FILL_HALF × the model radius across where it has none (berry
 * bushes). Laid out again when the shown walls or their shapes change, and once per replay second (walls fall, mines
 * run out). Not drawn: the parallel stakes the game spaces along a wall's sides (gap_fillers spacing), whose layout
 * is unknown.
 */
const FILL_HALF = 0.6; // [inference] a footprint-less obstacle's half width per metre of model radius
class WallFillers {
  constructor(parent) {
    this.group = new THREE.Group();
    this.group.name = 'gap fillers';
    parent.add(this.group);
    this.walls = R.ents.filter((e) => (e.wall || e.arms) && CATALOG?.blueprints?.[e.bp]?.gapFill);
    this.targets = R.gaia.filter((g) => CATALOG?.blueprints?.[g.bp]?.gapTarget);
    this.key = '';
  }

  update(t) {
    if (!this.walls.length) return;
    const shown = (e) => e.shown && e.view?.group.visible && t >= e.builtAt;
    let key = `${Math.floor(t)}`;
    for (const e of this.walls) if (shown(e)) key += `|${e.id}:${e.wall ? wallAt(e, t).row : ''}`;
    if (key === this.key) return;
    this.key = key;
    this.group.clear();
    for (const e of this.walls) {
      if (!shown(e)) continue;
      const gf = CATALOG.blueprints[e.bp].gapFill;
      if (e.arms) { if (!gf.onlyCapless) this.post(e, gf, t); continue; }
      const w = wallAt(e, t);
      if (!w.len || !w.free) continue;
      const c = gf.capless, ax = Math.cos(w.a), az = -Math.sin(w.a);
      for (const s of [1, -1]) {
        if (!(w.free & (s > 0 ? 1 : 2))) continue;
        const at = s * (w.off + (s * w.len) / 2) + c.offset; // the end, along the outward axis
        const x = e.px + ax * s * at, z = e.pz + az * s * at, discs = this.obstacles(x, z, c.reach + 12, t);
        for (let i = 0; discs.length && i < c.count; i++) {
          const ang = Math.atan2(s * az, s * ax) + THREE.MathUtils.degToRad(c.count > 1 ? -c.range / 2 + (i * c.range) / (c.count - 1) : 0);
          this.ray(e, gf, discs, x, z, ang, c.radial, c.reach);
        }
      }
    }
  }

  /** A post's stakes: step apart over each arc its holding walls leave free. */
  post(e, gf, t) {
    const discs = this.obstacles(e.px, e.pz, gf.reach + 12, t);
    if (!discs.length) return;
    const step = THREE.MathUtils.degToRad(gf.radial.step), occ = THREE.MathUtils.degToRad(gf.radial.occupied);
    const arms = e.arms.filter((n) => alive(n.o, t) && !n.sh.some((c) => alive(c, t))).map((n) => Math.atan2(n.uz, n.ux)).sort((p, q) => p - q);
    if (!arms.length) {
      for (let k = 0; k < Math.floor((2 * Math.PI) / step + 1e-6); k++) this.ray(e, gf, discs, e.px, e.pz, k * step, gf.offset, gf.reach);
      return;
    }
    arms.forEach((a, i) => {
      const next = i + 1 < arms.length ? arms[i + 1] : arms[0] + 2 * Math.PI, arc = next - a - occ; // free arc after arm a
      if (arc < 0) return;
      const n = Math.floor(arc / step + 1e-6) + 1, from = a + occ / 2 + (arc - (n - 1) * step) / 2;
      for (let k = 0; k < n; k++) this.ray(e, gf, discs, e.px, e.pz, from + k * step, gf.offset, gf.reach);
    });
  }

  /** A stake from (x, z) at angle ang (atan2 of dz, dx) to the nearest obstacle box within reach, if any. */
  ray(e, gf, boxes, x, z, ang, start, reach) {
    const dx = Math.cos(ang), dz = Math.sin(ang), x0 = x + dx * start, z0 = z + dz * start;
    let hit = Infinity;
    for (const [ox, oz, hx, hz] of boxes) { // ray–box entry distance (slabs)
      let lo = 0, hi = Infinity;
      for (const [o, d, c, h] of [[x0, dx, ox, hx], [z0, dz, oz, hz]]) {
        if (Math.abs(d) < 1e-9) { if (Math.abs(o - c) > h) hi = -1; continue; }
        const a = (c - h - o) / d, b = (c + h - o) / d;
        lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b));
      }
      if (lo <= hi && lo > 0) hit = Math.min(hit, lo); // a start inside the box leaves no gap
    }
    if (hit <= reach) this.stakes(e, gf, x0, z0, dx, dz, hit + 0.2);
  }

  /** Standing obstacle boxes [x, z, half x, half z] within d of (x, z) at t. */
  obstacles(x, z, d, t) {
    const out = [];
    for (const g of this.targets) {
      if (Math.abs(g.x - x) > d || Math.abs(g.z - z) > d || !gaiaOn(g, t)) continue;
      const [fx, fz] = CATALOG.blueprints[g.bp].gapTarget, r = FILL_HALF * (g.view?.radius ?? 1.5);
      out.push([g.x, g.z, fx ? fx / 2 : r, fz ? fz / 2 : r]);
    }
    return out;
  }

  /** Piece models covering len metres from (x, z) along (dx, dz). */
  stakes(e, gf, x, z, dx, dz, len) {
    const pieces = [...gf.pieces].sort((p, q) => p.len - q.len), longest = pieces.at(-1);
    for (let s = 0; s < len - 0.05;) {
      const rest = len - s, p = pieces.find((q) => q.len >= rest) ?? longest;
      const file = CATALOG.models?.[p.model]?.file, tpl = file && assets.template(file, paletteFor(R, null, e.pown));
      if (tpl === null) this.key = ''; // still loading: lay out again next frame
      if (!tpl) return;
      const m = assets.instantiate(tpl, e.pown).root, cx = x + dx * (s + p.len / 2), cz = z + dz * (s + p.len / 2);
      m.position.set(cx, terrain.heightAt(cx, cz), cz);
      m.rotation.y = Math.atan2(-dz, dx); // piece models run along their +X, as the wall models
      this.group.add(m);
      s += p.len;
    }
  }
}
const fillers = new WallFillers(entityRoot);

/**
 * The floating eye over a unit supervising a building (catalog.json blueprints[bp].supervise: the game's fxmesh_eye,
 * shown by base_civilian's supervise_eye_state effect; core Replay.supervision reads when). The mesh is a 0.2 × 0.1 m
 * card in its XY plane that the particle system sizes and turns; here it faces the camera EYE_SIZE times larger,
 * EYE_LIFT m above the head, bobbing gently [inference: the particle file is not extracted]. Lives in the scene, not
 * the Z-mirrored world, so the camera's rotation applies as is.
 */
const EYE_SIZE = 5, EYE_LIFT = 0.4, EYE_BOB = 0.1, EYE_PERIOD = 2.4; // ×, m, m, s
class SuperviseEyes {
  constructor(parent) {
    this.parent = parent;
    this.units = R.ents.filter((e) => CATALOG?.blueprints?.[e.bp]?.supervise);
    this.eyes = new Map(); // unit → eye root
  }

  update(t) {
    for (const e of this.units) {
      const v = e.view, on = e.on && e.shown && v?.group.visible && R.supervision(e).some((s) => t >= s.t0 && t < s.t1);
      let eye = this.eyes.get(e);
      if (!on) { if (eye) eye.visible = false; continue; }
      if (!eye) {
        const file = CATALOG.models?.[CATALOG.blueprints[e.bp].supervise]?.file, tpl = file && assets.template(file, paletteFor(R, null, e.pown));
        if (!tpl) continue; // loading (or missing)
        eye = assets.instantiate(tpl, e.pown).root;
        this.parent.add(eye);
        this.eyes.set(e, eye);
      }
      eye.visible = true;
      eye.position.set(e.px, e.gy + v.height * v.group.scale.y + EYE_LIFT + EYE_BOB * Math.sin((2 * Math.PI * t) / EYE_PERIOD), -e.pz);
      eye.quaternion.copy(camera.quaternion);
      eye.scale.setScalar(EYE_SIZE);
    }
  }
}
const eyes = new SuperviseEyes(scene);

// ── unit animation: the game's own clips ──
// Rigged units and animals play the game's animation clips (decoded from its Havok files by
// tools/havok/bake-anims.mjs into assets/anims/: one GLB per skeleton archetype, index.json mapping blueprints and
// states to clips), drawn by UnitBatches (unit-batches.js: GPU-instanced skinning, two clips blended per instance,
// team colour, flash, props and LOD per instance). What plays is a pure function of replay time and the entity
// (unitAnim, animalAnim) with nothing carried between frames, so a paused replay is a still frame and a seek lands
// on the pose straight playback shows:
//   locomotion  idle ↔ gait by speed (walk/jog/run/sprint; a villager's tool_/carry_ forms while it holds a tool or
//               a load), phased by the ground covered (odometer over the track) over the clip's root motion (index
//               `move`), so the feet keep pace with the ground at any speed and stop when the unit does; an arrival
//               that pauses plays the stop clip as the unit settles;
//   combat      guard (shooters: aim) while engaged (combatAt); every blow (Replay.buildBlows) plays its attack,
//               torch throw or fire clip placed so that the clip's strike frame (index `hit`) lands on the blow's
//               impact or loose, and shooters reload after each shot; rider clips (`part: 'rider'`) move only the
//               rider, over the horse's own gait;
//   reactions   a flinch at each recorded HP drop; the death clip from the recorded death, then the body sinks;
//   work        a villager at a stand loops its job's clip and plays its load's dropoff clip where a load walk ends; a
//               monk loops its heal clip through the heals it gives (frame.js C.heals); weapon, torch, tool or load
//               (prop joints) follow the state. A tower crew (Replay.seatCrews) stands CREW_SEAT up, in its elephant.

const DEATH_SECS = 10; // a killed unit lies this long (replay s), sinking away over the last 1.5 s
const XF = 0.12;       // crossfade between consecutive clips of a sequence (replay s)
const BLOW_LEAD = 1.5; // latest a blow's clip starts before its strike (the longest clip `hit` plus a crossfade)
const BLOW_HOLD = 1;   // an attack or throw clip plays at most this long past its strike (long rider combos are cut)
const SIDE_SHOT = 0.8; // a horse archer looses sideways (fire@bow variants 1 left, 2 right) past this angle (rad)
const JOB_KEY = [null, 'build', 'farm', 'wood', 'gold', 'stone', 'berry', 'meat', 'fish']; // JOBS index → index.json job
const GAITS = { '': ['walk', 'jog', 'run', 'sprint'], tool_: ['tool_walk', 'tool_run'], carry_: ['carry_walk', 'carry_run'] };
const GAIT_U = { walk: 1.6, jog: 3, run: 4.2, sprint: 6 }; // m/s for gait clips without root motion (reindeer)
const CLIP_STATES = ['idle', 'guard', 'aim', 'fire', 'reload', 'attack', 'convert', 'throw', 'flinch', 'death', 'dead',
  'work', 'tool_idle', 'carry_idle', 'stop', 'dropoff', 'heal', ...Object.values(GAITS).flat()];
const STOP_LEAD = 0.15; // a stop clip starts this long before the arrival, as the ground speed (over ±0.15 s) falls
const sstep = THREE.MathUtils.smoothstep;

const ANIMS = (await getJson('assets/anims/index.json')) ?? { archetypes: {}, blueprints: {} };
if (!Object.keys(ANIMS.archetypes).length) console.info('assets/anims not built (tools/havok/bake-anims.mjs): units stand in their bind pose');
const units = new UnitBatches({ parent: world, renderer, loader: gltfLoader, index: ANIMS, sun });

const unitPrep = new Map(); // `${url}|${bp}` → whether UnitBatches can animate it; null while it prepares
/**
 * Can the loaded rigged model at url play bp's clips? true/false once known, null while UnitBatches loads and bakes
 * them (callers keep what they show meanwhile, as while a GLB loads). Without clips a model stands in its bind pose.
 */
function unitReady(url, bp) {
  const k = `${url}|${bp}`;
  let r = unitPrep.get(k);
  if (r !== undefined) return r;
  r = ANIMS.blueprints[bp] ? null : false;
  unitPrep.set(k, r);
  if (r === null) {
    units.prepare(url, assets.loaded.get(url).scene, bp).then(
      (ok) => unitPrep.set(k, ok && clipTable(bp, ANIMS.blueprints[bp].style).idle.length > 0),
      (err) => { console.warn(`[units] ${url} (${bp}): clips failed, standing in bind pose`, err); unitPrep.set(k, false); },
    ).finally(invalidate);
  }
  return r;
}

const oneOf = (list, x) => (list.length ? list[Math.floor(x * list.length) % list.length] : null); // variant by seed
const nthOf = (list, n) => (list.length ? list[n % list.length] : null);                          // variant by count
const clipTables = new Map();
/**
 * Clip handles per state (CLIP_STATES → variants in index order) for a blueprint and index key (its style, or a
 * villager's job); states the key has none of come from the blueprint's own style. ranged: shoots (combat.json) and
 * has fire clips (a mehter drums its attack clip instead).
 */
function clipTable(bp, key) {
  const id = `${bp}|${key}`;
  let T = clipTables.get(id);
  if (T) return T;
  const style = ANIMS.blueprints[bp]?.style;
  const variants = (st, k) => {
    const list = [];
    for (let n = 0; n < 8; n++) {
      const h = units.clip(bp, st, k, n);
      if (!h || (n && h.id === list[0].id)) break;
      list.push(h);
    }
    return list;
  };
  T = {};
  for (const st of CLIP_STATES) {
    T[st] = variants(st, key);
    if (!T[st].length && key !== style) T[st] = variants(st, style);
  }
  T.ranged = window.RV_FRAME.statOf(bp)?.main?.damage === 'Ranged' && T.fire.length > 0;
  clipTables.set(id, T);
  return T;
}

/**
 * The gaits a unit picks from for prefix pre ('', 'tool_', 'carry_'; the plain ones when it has none of those), one
 * variant per unit (seed), sorted by natural speed u (root motion per second, model units): [{ h, move, u }].
 * Cached on the view per clip table and prefix.
 */
function gaitsOf(v, T, pre, seed) {
  const c = v.gait;
  if (c && c.T === T && c.pre === pre) return c.G;
  let names = GAITS[pre].filter((st) => T[st].length);
  if (!names.length) names = GAITS[''].filter((st) => T[st].length);
  const G = [];
  for (const st of names) {
    const h = oneOf(T[st], seed);
    if (G.some((g) => g.h.id === h.id)) continue; // a monk's run is its jog
    const move = h.move ?? GAIT_U[st.replace(/^(tool|carry)_/, '')] * h.dur;
    G.push({ h, move, u: move / h.dur });
  }
  G.sort((a, b) => a.u - b.u);
  v.gait = { T, pre, G };
  return G;
}

/** Ground covered along a track up to each sample (summed once per entity or animal). */
function odoOf(o, X, Z) {
  if (o.odo) return o.odo;
  const c = (o.odo = new Float64Array(X.length));
  for (let i = 1; i < X.length; i++) c[i] = c[i - 1] + Math.hypot(X[i] - X[i - 1], Z[i] - Z[i - 1]);
  return c;
}
/** Ground e has covered by t, moving as place() draws it (plants and the walk on to a death included). */
function unitOdo(e, t) {
  const L = place(e, t);
  return odoOf(e, e.x, e.z)[L.i] + Math.hypot(L.x - e.x[L.i], L.z - e.z[L.i]);
}
/** Ground a gaia animal has covered by t (locateGaia writes g's position: the caller restores it). */
function gaiaOdo(g, t) {
  const i = idxAt(g.trT, t);
  if (i < 0) return 0;
  locateGaia(g, t);
  return odoOf(g, g.trX, g.trZ)[i] + Math.hypot(g.px - g.trX[i], g.pz - g.trZ[i]);
}
/** A track's usual moving speed: the median over its moving sample windows (interpolated over win s). */
function cruiseOf(o, T, X, Z, win) {
  if (o.cruise !== undefined) return o.cruise;
  const sp = [];
  for (let i = 0; i + 1 < T.length; i++) {
    const d = Math.hypot(X[i + 1] - X[i], Z[i + 1] - Z[i]);
    if (d > 0.3) sp.push(d / Math.min(T[i + 1] - T[i], win));
  }
  sp.sort((a, b) => a - b);
  return (o.cruise = sp.length ? sp[sp.length >> 1] : 0);
}
/**
 * Arrivals that pause (memoized on e.stopT): the sample times ending a move of over 0.3 m after which e stands for at
 * least 0.25 s, off any villager job (a work stand plays its work clip, a drop-off its dropoff clip).
 */
function stopsOf(e) {
  if (e.stopT) return e.stopT;
  const out = [], n = e.t.length;
  for (let k = 1; k < n; k++) {
    if (e.job?.[k] || Math.hypot(e.x[k] - e.x[k - 1], e.z[k] - e.z[k - 1]) <= 0.3) continue;
    let j = k + 1;
    while (j < n && Math.hypot(e.x[j] - e.x[j - 1], e.z[j] - e.z[j - 1]) <= 0.1) j++;
    if (j === n || Math.max(e.t[j - 1], e.t[j] - SAMPLE) - e.t[k] >= 0.25) out.push(e.t[k]);
  }
  return (e.stopT = Float64Array.from(out));
}
/**
 * A villager's drop-offs (memoized on e.drops): T, the sample times its load walk (a CARRY code) ends at a drop-off,
 * and J, the JOBS index of the load.
 */
function dropsOf(e) {
  if (e.drops) return e.drops;
  const T = [], J = [], carry = (c) => c > CARRY && c < HOLD;
  for (let k = 1; k < e.t.length; k++) if (carry(e.job[k - 1]) && !carry(e.job[k])) { T.push(e.t[k]); J.push(e.job[k - 1] - CARRY); }
  return (e.drops = { T: Float64Array.from(T), J });
}
/**
 * The heals e gives (frame.js C.heals: HP rising beside a still religious unit), merged into spans less than 1 s
 * apart and memoized on e.heal: { T0, T1 } sorted by start.
 */
function healsOf(e) {
  if (e.heal) return e.heal;
  const T0 = [], T1 = [];
  for (const h of R.combat.heals) {
    if (h.healer !== e) continue;
    const k = T0.length - 1;
    if (k >= 0 && h.t0 - T1[k] < 1) T1[k] = Math.max(T1[k], h.t1);
    else { T0.push(h.t0); T1.push(h.t1); }
  }
  return (e.heal = { T0: Float64Array.from(T0), T1: Float64Array.from(T1) });
}
/**
 * Gait blend position at ground speed v for gaits G drawn at entry scale es: k = gait k, a fraction blends k and k + 1
 * within ±4% of a boundary. Boundaries sit at the geometric mean of neighbouring natural speeds, but at least 25% off
 * the cruise speed vc (cruiseOf), whose gait is the nearest one played up to ~15% fast: a unit marching at its usual
 * pace never hovers between two gaits, and a sprint-paced villager runs quickly rather than sprinting slowly.
 */
function gaitPos(G, v, vc, es) {
  let kc = 0, best = Infinity;
  for (let k = 0; k < G.length; k++) {
    const d = Math.abs(Math.log(vc / (1.15 * es * G[k].u)));
    if (d < best) { best = d; kc = k; }
  }
  let p = 0;
  for (let k = 0; k + 1 < G.length; k++) {
    let m = es * Math.sqrt(G[k].u * G[k + 1].u);
    if (vc > 0) m = k < kc ? Math.min(m, vc / 1.25 / 1.1 ** (kc - 1 - k)) : Math.max(m, vc * 1.25 * 1.1 ** (k - kc));
    p += sstep(v, m / 1.04, m * 1.04);
  }
  return p;
}

// The frame's candidate clips (unitAnim, animalAnim → mixOut): the two heaviest full-body clips crossfade, or the
// heaviest rider clip layers over the heaviest full-body one when it weighs more than the crossfade's lighter side.
const _mix = { n: 0, h: [], t: new Float64Array(12), w: new Float64Array(12) };
/** Add clip h at time tt (already wrapped or clamped) with weight w; returns the weight added. */
function mixAdd(h, tt, w) {
  const m = _mix;
  if (!h || !(w > 1e-3) || m.n === 12) return 0;
  m.h[m.n] = h; m.t[m.n] = tt; m.w[m.n++] = w;
  return w;
}
const loopT = (h, x) => (h.dur > 0 ? ((x % h.dur) + h.dur) % h.dur : 0);
const holdT = (h, x) => clamp(x, 0, h.dur);
/** Weight of a clip in its window [s, e]: faded in over the XF before s, out over the XF before e. */
const win = (t, s, e) => sstep(t, s - XF, s) * (1 - sstep(t, e - XF, e));
/** Gait g at weight w, phased by the ground covered od (entry scale es); seed staggers units walking together. */
const gaitAdd = (g, od, seed, es, w) => mixAdd(g.h, loopT(g.h, (od / (es * g.move) + seed) * g.h.dur), w);

const SKIN0 = new THREE.Color('#c29572'), skins = new Map();
const skinOf = (owner) => {
  let c = skins.get(owner);
  if (!c) skins.set(owner, (c = new THREE.Color(SKIN[R.players.get(owner)?.civ] ?? '#c29572')));
  return c;
};
/** UnitBatches.set() input, shared: matrix, team, skin, flash from the caller; clips and props from unitAnim/animalAnim. */
const _us = { matrix: null, team: NEUTRAL3, skin: SKIN0, flash: 0, a: null, ta: 0, b: null, tb: 0, w: 0, props: 0 };
/** Resolve the frame's candidates into _us; false when there is nothing to play. */
function mixOut() {
  const m = _mix, s = _us;
  let a = -1, b = -1, r = -1;
  for (let i = 0; i < m.n; i++) {
    if (m.h[i].rider) { if (r < 0 || m.w[i] > m.w[r]) r = i; } else if (a < 0 || m.w[i] > m.w[a]) { b = a; a = i; } else if (b < 0 || m.w[i] > m.w[b]) b = i;
  }
  if (a < 0) return false;
  s.a = m.h[a]; s.ta = m.t[a];
  const wb = b >= 0 ? m.w[b] / (m.w[a] + m.w[b]) : 0;
  if (r >= 0 && m.w[r] >= wb) { s.b = m.h[r]; s.tb = m.t[r]; s.w = Math.min(1, m.w[r]); }
  else if (b >= 0) { s.b = m.h[b]; s.tb = m.t[b]; s.w = wb; }
  else { s.b = null; s.tb = 0; s.w = 0; }
  return true;
}

const propSets = new Map();
/** A model's prop bits (UnitBatches.props order): gear always shown, main weapon, torch, tools and loads by JOBS name. */
function propsOf(key) {
  let P = propSets.get(key);
  if (P) return P;
  P = { gear: 0, main: 0, torch: 0, tools: new Map() };
  units.props(key).forEach((name, i) => {
    const bit = 1 << i;
    if (name === 'rvwpn_main') P.main = bit;
    else if (name === 'rvwpn_torch') P.torch = bit;
    else if (name.startsWith('rvtool_')) P.tools.set(name.slice(7).replace('res_rice_', 'res_wheat_'), bit); // Jin farms carry rice
    else P.gear |= bit; // shields, staffs, saddle baskets
  });
  propSets.set(key, P);
  return P;
}

const _cb = { blow: null, ref: null, a: NaN, eng: 0 };
/**
 * Combat state at t (shared object): blow = the blow whose wind-up or follow-through is under way (a = s from its
 * strike/loose moment); ref = the blow the unit is engaged around (the next one when closing in or between blows less
 * than two periods apart, else the last); eng = guard weight (fades in over the second before a blow, out ~2 s after
 * the last), so a fighting unit holds its stance and target through the gaps between recorded pulses.
 */
function combatAt(e, t) {
  const c = _cb;
  c.blow = c.ref = null; c.a = NaN; c.eng = 0;
  const B = e.blows;
  if (!B || !e.on) return c;
  const i = idxAt(e.stT, t), prev = i >= 0 ? B[i] : null, next = i + 1 < B.length ? B[i + 1] : null;
  const dp = prev ? t - prev.t0 : Infinity, dn = next ? next.t0 - t : Infinity;
  if (next && dn <= next.up + 0.12 && !(dp < 0.15)) c.blow = next;
  else if (prev && dp < prev.fol + 0.15) c.blow = prev;
  if (c.blow) c.a = t - c.blow.t0;
  const bridged = prev && next && next.t0 - prev.t0 < 2 * prev.period + 1;
  c.eng = bridged ? 1 : Math.max(1 - sstep(dn, 0.8, 1.6), 1 - sstep(dp, 1.6, 2.6));
  c.ref = c.blow ?? (bridged || dn < dp ? next : prev);
  return c;
}

/** The prop a walking villager holds for a non-work job code: the load (CARRY) or the job's tool (HOLD). */
const propOf = (code) => (code > HOLD ? JOBS[code - HOLD].tool : code > CARRY ? JOBS[code - CARRY].carry : null);

/** A shot's fire clip: horse archers loose ahead, to the left or to the right of their heading (fire@bow 0/1/2). */
function fireClip(T, bl, e, v, k) {
  const F = T.fire;
  if (F.length !== 3 || !F[0].rider) return nthOf(F, k);
  const rel = wrapAngle(Math.atan2(bl.b.px - e.px, bl.b.pz - e.pz) - v.heading);
  return F[rel < -SIDE_SHOT ? 1 : rel > SIDE_SHOT ? 2 : 0];
}

/**
 * What entity e plays at t, into _us (clips, times, blend, props); false when it has nothing to play. c = combatAt(e,
 * t), i = its track sample, es = its entry scale (the gait phase ignores the adaptive unit scale, so zooming a paused
 * replay leaves the feet where they are). Blows, the flinch and work take full-body weight first; stance and
 * locomotion share the rest. The stance drops once the target is gone, and while running with a weapon not used on
 * the move.
 */
function unitAnim(e, v, t, c, i, es) {
  const seed = e.seed, style = ANIMS.blueprints[e.bp]?.style, P = propsOf(v.unit);
  _mix.n = 0;
  if (!e.on) { // the death clip from the recorded death, holding its last frame
    const T = clipTable(e.bp, style), h = oneOf(T.death, hash01(e.id + 3)) ?? oneOf(T.idle, seed);
    mixAdd(h, h && holdT(h, t - e.died), 1);
    _us.props = P.gear | P.main;
    return mixOut();
  }
  const code = e.job ? e.job[i] : 0, job = code > HOLD ? code - HOLD : code > CARRY ? code - CARRY : code;
  const T = clipTable(e.bp, style ?? JOB_KEY[job]);
  const od = unitOdo(e, t), vs = (unitOdo(e, t + 0.15) - unitOdo(e, t - 0.15)) / 0.3; // ground speed over 0.3 s
  let b = c.blow ?? (c.eng > 0 ? c.ref : null), eng = c.eng;
  if (b && !b.b.on) eng = 0;
  else if (b && !b.mobile) eng *= 1 - sstep(vs, 1.5, 3);
  if (b && !c.blow && eng < 0.02) b = null;
  let act = 0;
  // blows: each one's clip placed by its strike frame and cut where the next one's starts; a shot's reload follows it
  const B = e.blows;
  if (B) {
    let next = Infinity;
    for (let k = idxAt(e.stT, t + BLOW_LEAD), k0 = k; k >= 0 && k > k0 - 4 && B[k].t0 > t - 8; k--) {
      const bl = B[k], shot = T.ranged && !bl.torch;
      const h = bl.torch ? nthOf(T.throw, k) : shot ? fireClip(T, bl, e, v, k) : nthOf(T.attack, k) ?? nthOf(T.convert, k);
      if (!h) continue;
      const s0 = bl.t0 - (h.hit ?? 0), end = Math.min(s0 + h.dur, shot ? Infinity : s0 + (h.hit ?? 0) + BLOW_HOLD, next);
      if (t > s0 - XF && t < end) { const w = mixAdd(h, holdT(h, t - s0), win(t, s0, end)); if (!h.rider) act += w; }
      const r = shot ? nthOf(T.reload, k) : null, rs = s0 + h.dur;
      if (r && t > rs - XF && rs < next) { // quickened (up to 1.6×) to fit before the next shot
        const rate = clamp(r.dur / (next - rs), 1, 1.6), re = Math.min(rs + r.dur / rate, next);
        const w = mixAdd(r, holdT(r, (t - rs) * rate), win(t, rs, re));
        if (!r.rider) act += w;
      }
      next = s0;
    }
  }
  // a flinch at each recorded HP drop: partial over a fight's stance, the rider's own on a horse
  const hi = e.hitT ? idxAt(e.hitT, t) : -1;
  if (hi >= 0 && t - e.hitT[hi] < 1) {
    const h = nthOf(T.flinch, hi), h0 = e.hitT[hi];
    if (h) {
      const w = mixAdd(h, holdT(h, t - h0), (h.rider ? 0.8 : 0.5 * (1 - Math.min(1, act))) * win(t, h0 + XF, h0 + Math.min(h.dur, 0.9)));
      if (!h.rider) act += w;
    }
  }
  // villager work: at a stand the job's clip loops from the arrival (jobT0), easing in after it and out before the move
  // off it (jobT1 − SAMPLE), when the villager takes up what it walks away with (jobOut: its load, or its tool)
  let tool = code > CARRY ? propOf(code) : null;
  if (code && code < CARRY) {
    const leave = e.jobT1[i] - SAMPLE, h = b ? null : oneOf(T.work, seed);
    tool = t > leave - 0.15 && e.jobOut[i] ? propOf(e.jobOut[i]) : JOBS[code].tool;
    const w = mixAdd(h, h && loopT(h, t - e.jobT0[i] + seed * h.dur), sstep(t - e.jobT0[i], 0, 0.4) * (1 - sstep(t, leave - 0.3, leave)) * (1 - Math.min(1, act)));
    if (h && !h.rider) act += w;
  }
  if (b && !b.torch && e.job) tool = JOBS[J_WOOD].tool; // villagers fight with the axe
  const pre = code > HOLD ? 'tool_' : code > CARRY ? 'carry_' : '';
  const G = gaitsOf(v, T, pre, seed), mv = G.length ? sstep(vs, 0.2, 0.8) : 0;
  // pauses off a fight: a monk's heal loops through the heals it gives (easing in and out), a villager's dropoff plays
  // from the end of its load walk and anyone's stop clip from an arrival, each only as far as the unit stands still
  if (!b) {
    let h = null, w = 0, x = 0;
    const H = T.heal.length ? healsOf(e) : null, hk = H ? idxAt(H.T0, t + 0.3) : -1;
    if (hk >= 0 && t < H.T1[hk] + 0.4) {
      h = oneOf(T.heal, seed); x = loopT(h, t - H.T0[hk] + seed * h.dur);
      w = sstep(t, H.T0[hk] - 0.3, H.T0[hk]) * (1 - sstep(t, H.T1[hk], H.T1[hk] + 0.4));
    } else if (e.job && !(code && code < CARRY)) {
      const D = dropsOf(e), dk = idxAt(D.T, t), d0 = dk >= 0 ? D.T[dk] : -Infinity;
      h = t - d0 < 3 ? oneOf(clipTable(e.bp, style ?? JOB_KEY[D.J[dk]]).dropoff, seed) : null; // the load's job set
      if (h) { x = holdT(h, t - d0); w = win(t, d0, d0 + h.dur); }
    }
    if (!h && !code && T.stop.length) {
      const S = stopsOf(e), sk = idxAt(S, t + STOP_LEAD);
      if (sk >= 0 && t - S[sk] < 3) { h = oneOf(T.stop, seed); const s0 = S[sk] - STOP_LEAD; x = holdT(h, t - s0); w = win(t, s0, s0 + h.dur); }
    }
    if (h && w > 0) {
      w = mixAdd(h, x, w * (1 - mv) * (1 - Math.min(1, act)));
      if (!h.rider) act += w;
    }
  }
  // stance and locomotion share the rest: idle (guard, or aim for shooters, while engaged) ↔ gait by speed
  const rest = 1 - Math.min(1, act);
  const idle = oneOf(T[`${pre}idle`].length ? T[`${pre}idle`] : T.idle, seed);
  const st = pre ? null : oneOf(T.ranged && T.aim.length ? T.aim : T.guard, seed), ge = st ? eng : 0;
  if (st?.rider) mixAdd(st, loopT(st, t + seed * st.dur), ge); // a horse archer's rider aims over the horse
  mixAdd(idle, idle && loopT(idle, t + seed * idle.dur), rest * (1 - mv) * (st?.rider ? 1 : 1 - ge));
  if (st && !st.rider) mixAdd(st, loopT(st, t + seed * st.dur), rest * (1 - mv) * ge);
  if (mv > 0) {
    const p = gaitPos(G, vs, cruiseOf(e, e.t, e.x, e.z, SAMPLE), es), k = Math.min(G.length - 1, Math.floor(p)), x = p - k;
    gaitAdd(G[k], od, seed, es, rest * mv * (1 - x));
    if (x > 0) gaitAdd(G[k + 1], od, seed, es, rest * mv * x);
  }
  _us.props = P.gear | (b?.torch && P.torch ? P.torch : P.main) | (tool ? P.tools.get(tool) ?? 0 : 0);
  return mixOut();
}

/**
 * When gaia animal g dies: its K (a wolf's death), else its first amount drop (a hunted deer is gathered from once shot;
 * its K only comes when the carcass is eaten up), else never. Memoized in g.deadT.
 */
function deathOf(g) {
  if (g.deadT !== null) return g.deadT;
  let d = g.killT;
  if (g.amT) for (let i = 0; i < g.amT.length && g.amT[i] < d; i++) if (g.amV[i] < g.amount0) { d = g.amT[i]; break; }
  return (g.deadT = d);
}

/**
 * What a gaia animal (view v, entry scale es) plays at t, into _us: dead for `since` s (≥ 0) its death clip, then its
 * dead pose; alive (since < 0), idle ↔ gait by its speed along its track (locateGaia moves g, so its current state is
 * restored after sampling around t).
 */
function animalAnim(g, v, t, since, es) {
  const T = clipTable(g.bp, undefined), seed = g.seed;
  _mix.n = 0;
  _us.matrix = v.group.matrix; _us.team = NEUTRAL3; _us.skin = SKIN0; _us.flash = 0; _us.props = 0;
  if (since >= 0) {
    const k = oneOf(T.death, seed);
    if (k && since < k.dur) mixAdd(k, since, 1);
    else { const h = oneOf(T.dead, seed) ?? k; mixAdd(h, h && h.dur, 1); }
    return mixOut();
  }
  let od = 0, vs = 0;
  if (g.trT) {
    const { px, pz, heading, amount } = g;
    od = gaiaOdo(g, t);
    vs = (gaiaOdo(g, t + 0.15) - gaiaOdo(g, t - 0.15)) / 0.3;
    g.px = px; g.pz = pz; g.heading = heading; g.amount = amount;
  }
  const G = gaitsOf(v, T, '', seed), mv = G.length ? sstep(vs, 0.2, 0.8) : 0, idle = oneOf(T.idle, seed);
  mixAdd(idle, idle && loopT(idle, t + seed * idle.dur), 1 - mv);
  if (mv > 0) {
    const p = gaitPos(G, vs, cruiseOf(g, g.trT, g.trX, g.trZ, 1), es), k = Math.min(G.length - 1, Math.floor(p)), x = p - k;
    gaitAdd(G[k], od, seed, es, mv * (1 - x));
    if (x > 0) gaitAdd(G[k + 1], od, seed, es, mv * x);
  }
  return mixOut();
}

let _pxPerM = 1; // screen px per metre at 1 m depth (set by updateEntities)

// buildings without a scaffold or rubble heap (they still rise and sink)
const FLAT_BP = /palisade|wall|gate|farm|marker|grassland/;
const SIEGE_BP = /siege|ram_|mangonel|trebuchet|springald|ballista|bombard|cannon|culverin|cart/;

class EntityView {
  constructor(e) {
    this.e = e;
    this.group = new THREE.Group();
    this.group.name = `e${e.id}`;
    entityRoot.add(this.group);
    this.model = null;
    this.unit = null; // model url while UnitBatches draws it (setUnit); its clips then come from unitAnim
    this.gait = null; // gaitsOf cache
    this.key = undefined;
    this.meshes = [];
    this.height = 2;
    this.radius = 0.6;
    this.heading = e.isUnit ? e.seed * TAU : 0;
    this.ht = NaN; // replay time of the last heading update
    this.turn = TURN_RATE * (SIEGE_BP.test(e.bp) ? 0.4 : e.cat === 'cavalry' || /mounted|_horse|camel|elephant/.test(e.bp) ? 0.6 : 1);
    this.flat = e.isBuilding && FLAT_BP.test(e.bp);
    this.site = null; // construction site (setSite)
    this.ruin = null; // rubble heap mesh (showRuin)
    this.flashOn = false;
    this.batchable = false; // a static building model that can draw from BuildingBatches
    this.batched = null; // its batch slots while it does (BuildingBatches.attach)
    this.cartH = null; // a rolling Mongol cart's heading, and the replay time it was set (packPose)
    this.cartT = NaN;
    this.seatX = NaN; this.seatZ = NaN; this.seatS = NaN; this.seatY = 0; this.seatBox = null; // buildingSeat cache
    this.doors = null; // a gate's leaf pivots [rv_door_l, rv_door_r] (splitDoors) and their swing (swingGates)
    this.doorDir = -1; this.doorP = 1; this.doorT = NaN;
  }

  setModel(obj, key) {
    if (this.batched) batches.detach(this);
    if (this.site) clearSite(this);
    if (this.model) this.group.remove(this.model);
    if (this.unit) { units.remove(this); this.unit = null; }
    this.model = obj.root;
    this.key = key;
    this.group.add(obj.root);
    this.height = obj.height;
    this.radius = obj.radius;
    this.farm = obj.farm ?? null; // a farm field's crop state (FarmFields)
    this.meshes = [];
    obj.root.traverse((o) => { if (o.isMesh) this.meshes.push({ mesh: o, base: o.material, rel: null }); });
    const l = obj.root.getObjectByName('rv_door_l'), r = obj.root.getObjectByName('rv_door_r');
    this.doors = l || r ? [l, r] : null;
    this.doorDir = -1; this.doorP = 1; this.doorT = NaN;
    this.batchable = this.e.isBuilding && batches.fits(this);
    if (this.e.isBuilding) terrain.wear.refresh(); // its footprint now has the model's size
    this.flashOn = false;
  }

  /** Draw as the animated instance of rigged model url (template tpl) in UnitBatches instead of a scene model. */
  setUnit(url, tpl, key) {
    if (this.model) { this.group.remove(this.model); this.model = null; this.meshes = []; this.doors = null; }
    if (this.unit !== url) {
      if (this.unit) units.remove(this);
      units.add(this, url, this.e.pown);
      this.unit = url;
    }
    this.key = key;
    this.height = tpl.height;
    this.radius = tpl.radius;
    this.batchable = false;
    this.flashOn = false;
  }

  setFlash(on) {
    this.flashOn = on;
    const st = this.site;
    for (const mm of this.meshes) mm.mesh.material = st ? siteMat(st, mm.base, on) : on ? assets.flashOf(mm.base) : mm.base;
  }
}

const hideView = (v) => {
  if (v.batched) batches.detach(v);
  v.group.visible = false;
  if (v.ruin) v.ruin.visible = false;
};

const _bb = new THREE.Box3(), _m4 = new THREE.Matrix4(), boxes = new WeakMap();
/** A view's model bounds in model units (the group's space before its own transform), cached per model instance. */
function modelBox(v) {
  const m = v.model;
  let box = boxes.get(m);
  if (box) return box;
  box = new THREE.Box3();
  m.traverse((o) => {
    if (!o.isMesh) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    o.updateMatrix();
    _m4.copy(o.matrix);
    for (let p = o.parent; p && p !== v.group; p = p.parent) { p.updateMatrix(); _m4.premultiply(p.matrix); }
    box.union(_bb.copy(o.geometry.boundingBox).applyMatrix4(_m4));
  });
  if (box.isEmpty()) box.set(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 3, 2));
  boxes.set(m, box);
  return box;
}

/**
 * Ground height a building stands at: its footprint's highest point (the model box's corners, edge midpoints and
 * centre at scale s, inset 10%), so no side of it is buried on a slope, but only as high as its foundation skirt (the
 * box's depth below the model origin; building models carry 1–4 m of it) still reaches the lowest point, and never
 * below the centre's height (as before, for a model without a skirt). Cached per view while position, scale and model
 * hold.
 */
function buildingSeat(e, v, s) {
  const box = modelBox(v);
  if (v.seatX === e.px && v.seatZ === e.pz && v.seatS === s && v.seatBox === box) return v.seatY;
  let lo = Infinity, hi = -Infinity;
  for (const fx of [-0.9, 0, 0.9]) for (const fz of [-0.9, 0, 0.9]) {
    const h = terrain.heightAt(e.px + s * (fx < 0 ? -fx * box.min.x : fx * box.max.x), e.pz + s * (fz < 0 ? -fz * box.min.z : fz * box.max.z));
    lo = Math.min(lo, h); hi = Math.max(hi, h);
  }
  v.seatX = e.px; v.seatZ = e.pz; v.seatS = s; v.seatBox = box;
  return (v.seatY = Math.max(e.gy, Math.min(hi, lo + Math.max(0, -box.min.y * s))));
}

const BATCHED_DEPTH = new THREE.MeshDepthMaterial(); // the batches' own shadow-pass program (as SKINNED_DEPTH)
const _bmM = new THREE.Matrix4(), _camW = new THREE.Vector3();
/**
 * Building LOD switching (BuildingBatches.level): level n shows beyond its switch distance — the game's own (`dist`)
 * or, for generated levels, where their simplification error (`error`) projects under LOD_ERR_PX screen px, so the
 * swap moves no edge by a visible amount — and gives way to the nearer level only within that distance / LOD_HYST,
 * so a building on a boundary does not flicker while the camera eases.
 */
const LOD_ERR_PX = 1, LOD_HYST = 1.15;
/**
 * Standing buildings draw from shared BatchedMeshes, one per material, shadow flags and vertex layout: all of one
 * owner's houses, or every farm field, is one multi-draw, culled building by building against both the view and the
 * shadow box. A building's distant levels live in the same batches as its LOD0 parts, and each instance switches
 * geometry by camera distance (level), which the shadow pass draws too. A building leaves its batch, showing its
 * own (LOD0) meshes again, while it is under construction, flashing from a hit, falling, hidden, or changing model
 * (age-up, new owner), so those effects keep working per building. While batched its model is out of the scene
 * graph (the per-frame matrix update skips it); its group stays for picking, bars and overlays.
 */
class BuildingBatches {
  constructor(parent) {
    this.parent = parent;
    this.batches = new Map(); // key → { mesh: BatchedMesh, ids: Map(geometry → geometry id), verts, index }
  }

  /** Whether v's model can draw batched (static, one material per mesh, not mirrored); notes each mesh's matrix in the group. */
  fits(v) {
    if (!v.meshes.length) return false;
    for (const mm of v.meshes) {
      const { mesh, base } = mm;
      if (mesh.isSkinnedMesh || mesh.isInstancedMesh || Array.isArray(base) || Object.keys(mesh.geometry.morphAttributes).length) return false;
      const rel = new THREE.Matrix4();
      let shown = true;
      for (let o = mesh; o !== v.group; o = o.parent) { o.updateMatrix(); rel.premultiply(o.matrix); shown &&= o.visible; }
      if (rel.determinant() < 0) return false; // a batch can't flip one instance's winding
      mm.rel = shown ? rel : null;
    }
    return true;
  }

  /**
   * Batch v (want) or give it back its own meshes; a batched building that moved, turned or rescaled is re-placed,
   * and one with distant levels draws the level for its camera distance.
   */
  sync(v, want) {
    if (!want) { if (v.batched) this.detach(v); return; }
    v.group.updateMatrix();
    if (!v.batched) this.attach(v);
    else if (!v.batched.at.equals(v.group.matrix)) this.place(v);
    if (v.batched.cut) {
      const e = v.group.matrix.elements;
      this.level(v, Math.hypot(e[12] - _camW.x, e[13] + 0.5 * v.height * v.group.scale.y - _camW.y, e[14] - _camW.z));
    }
  }

  attach(v) {
    const slots = []; // flat [batch, instance id, mesh matrix in the group, geometry id per level or null] per mesh
    let cut = null;
    for (const { mesh, base, rel } of v.meshes) {
      if (!rel) continue;
      const b = this.batchFor(mesh, base), gid = this.geometryId(b, mesh.geometry), lods = LODS.get(mesh.geometry);
      slots.push(b.mesh, this.addInstance(b, gid), rel, lods ? [gid, ...lods.geos.map((g) => (g ? this.geometryId(b, g) : -1))] : null);
      cut ??= lods?.cut ?? null;
    }
    v.batched = { slots, at: new THREE.Matrix4(), cut, lod: 0 };
    v.group.remove(v.model);
    this.place(v);
  }

  place(v) {
    const { slots, at } = v.batched;
    at.copy(v.group.matrix);
    for (let i = 0; i < slots.length; i += 4) slots[i].setMatrixAt(slots[i + 1], _bmM.multiplyMatrices(at, slots[i + 2]));
  }

  /** Draw v at the level for camera distance d (LOD_ERR_PX); a part missing from a level hides at it. */
  level(v, d) {
    const bt = v.batched, { cut } = bt, { x, y, z } = v.group.scale, s = Math.max(x, y, z); // wall pieces stretch along X
    const at = (n) => cut[n - 1].dist ?? (cut[n - 1].error * s * _pxPerM) / LOD_ERR_PX; // level n's switch distance
    let n = bt.lod;
    while (n < cut.length && d > at(n + 1)) n++;
    while (n > 0 && d < at(n) / LOD_HYST) n--;
    if (n === bt.lod) return;
    bt.lod = n;
    const { slots } = bt;
    for (let i = 0; i < slots.length; i += 4) {
      const gids = slots[i + 3];
      if (!gids) continue;
      slots[i].setVisibleAt(slots[i + 1], gids[n] >= 0);
      if (gids[n] >= 0) slots[i].setGeometryIdAt(slots[i + 1], gids[n]);
    }
  }

  detach(v) {
    const { slots } = v.batched;
    for (let i = 0; i < slots.length; i += 4) slots[i].deleteInstance(slots[i + 1]);
    v.batched = null;
    v.group.add(v.model);
  }

  batchFor(mesh, mat) {
    const g = mesh.geometry;
    let key = `${mat.uuid}|${+mesh.castShadow}${+mesh.receiveShadow}|${g.index ? 'i' : ''}`;
    for (const name in g.attributes) {
      const a = g.attributes[name];
      key += `|${name}${a.itemSize}${a.normalized ? 'n' : ''}${a.array.constructor.name}`;
    }
    let b = this.batches.get(key);
    if (!b) {
      const verts = Math.max(1024, g.attributes.position.count), index = Math.max(1024, g.index?.count ?? 0);
      const bm = new THREE.BatchedMesh(64, verts, index, mat);
      bm.castShadow = mesh.castShadow;
      bm.receiveShadow = mesh.receiveShadow;
      bm.frustumCulled = false; // instances come and go: culled one by one instead (perObjectFrustumCulled)
      bm.sortObjects = false;
      if (!(mat.alphaTest > 0) && !mat.alphaToCoverage) bm.customDepthMaterial = BATCHED_DEPTH;
      this.parent.add(bm);
      this.batches.set(key, (b = { mesh: bm, ids: new Map(), verts, index }));
    }
    return b;
  }

  /** Geometry g's id in batch b, adding it (growing the batch's buffers by half as needed) on first use. */
  geometryId(b, g) {
    const bm = b.mesh;
    let gid = b.ids.get(g);
    if (gid === undefined) {
      const nv = g.attributes.position.count, ni = g.index?.count ?? 0;
      if (bm.unusedVertexCount < nv || bm.unusedIndexCount < ni) {
        b.verts = Math.max(Math.ceil(b.verts * 1.5), b.verts - bm.unusedVertexCount + nv);
        b.index = Math.max(Math.ceil(b.index * 1.5), b.index - bm.unusedIndexCount + ni);
        bm.setGeometrySize(b.verts, b.index);
      }
      b.ids.set(g, (gid = bm.addGeometry(g)));
    }
    return gid;
  }

  /** A new instance of geometry gid in batch b. */
  addInstance(b, gid) {
    const bm = b.mesh;
    if (bm.instanceCount >= bm.maxInstanceCount) bm.setInstanceCount(bm.maxInstanceCount * 2);
    return bm.addInstance(gid);
  }
}
const batches = new BuildingBatches(entityRoot);

const SITE_MAT = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
const siteGeos = new Map();
/** Boxes (w × h × d at x, y, z, tilted rz about Z, rx about X, turned ry) baked into one vertex-coloured geometry. */
function boxGeo(list) {
  return mergeGeometries(list.map(([w, h, d, x, y, z, col, rz = 0, rx = 0, ry = 0]) => {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rz) g.rotateZ(rz);
    if (rx) g.rotateX(rx);
    if (ry) g.rotateY(ry);
    return colored(g.translate(x, y, z), col);
  }));
}
const boundsKey = (b, kind) => `${kind}|${[b.min.x, b.max.x, b.min.z, b.max.z, b.max.y].map((x) => Math.round(x * 2) / 2).join(',')}`;

/** Scaffold around bounds b (model units): a trodden earth pad, poles every ~4 m, rails every ~2.2 m up, braces. */
function scaffoldGeo(b) {
  const key = boundsKey(b, 's');
  let g = siteGeos.get(key);
  if (g) return g;
  const x0 = b.min.x - 0.5, x1 = b.max.x + 0.5, z0 = b.min.z - 0.5, z1 = b.max.z + 0.5, h = Math.max(2, b.max.y);
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, wx = x1 - x0, wz = z1 - z0;
  const L = [[wx + 1.2, 0.3, wz + 1.2, cx, -0.1, cz, '#6b5a44']]; // the pad is mostly sunk, so slopes do not float it
  const nx = Math.max(1, Math.round(wx / 4)), nz = Math.max(1, Math.round(wz / 4)), dx = wx / nx, dz = wz / nz;
  for (let i = 0; i <= nx; i++) for (const z of [z0, z1]) L.push([0.16, h, 0.16, x0 + i * dx, h / 2, z, '#7a5a3a']);
  for (let j = 1; j < nz; j++) for (const x of [x0, x1]) L.push([0.16, h, 0.16, x, h / 2, z0 + j * dz, '#7a5a3a']);
  for (let y = 1.1; y < h; y += 2.2) {
    for (const z of [z0, z1]) L.push([wx, 0.1, 0.1, cx, y, z, '#9a7a52']);
    for (const x of [x0, x1]) L.push([0.1, 0.1, wz, x, y, cz, '#9a7a52']);
  }
  // a diagonal brace across the first bay of each face
  for (const z of [z0, z1]) L.push([Math.hypot(dx, h), 0.08, 0.08, x0 + dx / 2, h / 2, z, '#8a6a46', Math.atan2(h, dx)]);
  for (const x of [x0, x1]) L.push([0.08, 0.08, Math.hypot(dz, h), x, h / 2, z0 + dz / 2, '#8a6a46', 0, -Math.atan2(h, dz)]);
  siteGeos.set(key, (g = boxGeo(L)));
  return g;
}

/** A rubble heap over bounds b (model units): a dust pad, tumbled blocks piled toward the middle, broken beams. */
function rubbleGeo(b) {
  const key = boundsKey(b, 'r');
  let g = siteGeos.get(key);
  if (g) return g;
  const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
  const hx = Math.max(1, (b.max.x - b.min.x) / 2), hz = Math.max(1, (b.max.z - b.min.z) / 2), lo = Math.min(hx, hz);
  // a low earth mound (half buried, so it never floats on a slope) with tumbled blocks resting on it
  const hm = 0.4 + 0.15 * lo;
  const L = [
    [1.3 * hx, hm, 1.3 * hz, cx, 0, cz, '#766b5c', 0, 0, 0.6],
    [0.8 * hx, 0.8 * hm, 0.8 * hz, cx + 0.2 * hx, 0, cz - 0.15 * hz, '#6a5f51', 0, 0, -0.4],
  ];
  const n = clamp(Math.round((hx * hz) / 1.2), 14, 60), COLS = ['#8a8378', '#6f675d', '#9b9283', '#5c4430', '#3d3732'];
  for (let k = 0; k < n; k++) {
    const u = 2 * hash3(k, 1, 17) - 1, w = 2 * hash3(k, 2, 17) - 1, r = hash3(k, 3, 17), q = hash3(k, 4, 17);
    const mid = 1 - Math.max(Math.abs(u), Math.abs(w)), sz = 0.4 + 1.2 * r * (0.5 + 0.5 * mid);
    const y = 0.2 * sz + 0.5 * hm * Math.min(1, 2 * mid) + 0.2 * lo * mid * q;
    L.push([sz, 0.55 * sz, 0.8 * sz, cx + 0.95 * u * hx, y, cz + 0.95 * w * hz, COLS[k % 5], (q - 0.5) * 0.9, (r - 0.5) * 0.5, 3 * r]);
  }
  for (let k = 0; k < 6; k++) {
    const u = hash3(k, 5, 17) - 0.5, w = hash3(k, 6, 17) - 0.5, len = Math.min(2 * Math.max(hx, hz), 2 + 4 * hash3(k, 7, 17));
    L.push([len, 0.22, 0.22, cx + u * hx, 0.3 + 0.25 * lo * hash3(k, 8, 17), cz + w * hz, '#4a3626', (u - w) * 0.6, 0, TAU * hash3(k, 9, 17)]);
  }
  siteGeos.set(key, (g = boxGeo(L)));
  return g;
}

/** A site's clipped copy of base material (flash = the hit-flash variant), made on first use. */
function siteMat(st, base, flash) {
  let m = st.mats.get(base);
  if (!m) st.mats.set(base, (m = [null, null]));
  const k = flash ? 1 : 0;
  if (!m[k]) {
    const c = base.userData.rvMake ? base.userData.rvMake(flash) : base.clone();
    if (flash && !base.userData.rvMake && c.emissive) { c.emissive.set(0xff2a14); c.emissiveIntensity = 0.35; }
    c.clippingPlanes = [st.plane];
    c.clipShadows = true;
    c.side = THREE.DoubleSide; // the cut shows the inside walls rather than a hole
    m[k] = c;
  }
  return m[k];
}

/** Construction at progress p (HP share): the model clipped at p of its height (world y), the scaffold growing ahead. */
function setSite(v, p, s, y0) {
  let st = v.site;
  if (!st) {
    const box = modelBox(v);
    st = v.site = { plane: new THREE.Plane(new THREE.Vector3(0, -1, 0), 0), mats: new Map(), box, scaffold: null };
    if (!v.flat) {
      st.scaffold = new THREE.Mesh(scaffoldGeo(box), SITE_MAT);
      st.scaffold.castShadow = st.scaffold.receiveShadow = true;
      v.group.add(st.scaffold);
    }
    v.setFlash(v.flashOn);
  }
  const lo = Math.max(0, st.box.min.y);
  st.plane.constant = y0 + s * (lo + (0.03 + 0.97 * p) * (st.box.max.y - lo));
  if (st.scaffold) st.scaffold.scale.y = clamp(0.2 + p, 0.2, 1);
}

function clearSite(v) {
  const st = v.site;
  v.site = null;
  for (const m of st.mats.values()) for (const c of m) c?.dispose();
  if (st.scaffold) v.group.remove(st.scaffold);
  v.setFlash(v.flashOn);
}

/** The rubble heap of a building destroyed age s ago: it rises as the building comes down, sinks before removal. */
function showRuin(e, v, age, s, y0) {
  if (!v.ruin) {
    v.ruin = new THREE.Mesh(rubbleGeo(modelBox(v)), SITE_MAT);
    v.ruin.castShadow = v.ruin.receiveShadow = true;
    entityRoot.add(v.ruin);
  }
  const r = v.ruin;
  r.visible = true;
  r.position.set(e.px, y0 - 5 * s * sstep(age, RUIN_SECS - 1.5, RUIN_SECS), e.pz);
  r.scale.set(s, s * (0.25 + 0.75 * sstep(age, 0, RUIN_FALL)), s);
}

/**
 * Building states. Under construction (t < builtAt) the model rises out of its foundation inside a scaffold, clipped at
 * its HP share of its height. Destroyed, it sinks and tilts into a rubble heap over RUIN_FALL; the heap stays
 * RUIN_SECS. Walls, palisades, farms and markers (v.flat) get neither scaffold nor rubble. A farm field (v.farm) shows
 * its crop state instead: sprouts rising with construction progress, then mature; destroyed, damaged until it goes.
 */
function updateBuilding(e, v, t, s, y0) {
  if (e.on) {
    v.group.visible = true;
    v.group.rotation.x = v.group.rotation.z = 0;
    if (v.ruin) v.ruin.visible = false;
    const p = clamp(e.php / e.maxhp, 0, 1);
    if (v.farm) farms.setCrop(v, t < e.builtAt ? 'sprout' : 'mature', t < e.builtAt ? p : 1, e, t);
    else if (t < e.builtAt) setSite(v, p, s, y0);
    else if (v.site) clearSite(v);
    return;
  }
  if (v.site) clearSite(v);
  const age = t - e.died, f = sstep(age, 0, RUIN_FALL);
  v.group.visible = age < RUIN_FALL && e.died >= e.builtAt; // an unfinished site just collapses into rubble
  if (v.farm) { if (v.group.visible) farms.setCrop(v, 'damaged', 1, e, t); return; } // a field lies flat
  if (v.group.visible) {
    v.group.position.y = y0 - f * f * (modelBox(v).max.y + 0.5) * s;
    v.group.rotation.x = (e.seed - 0.5) * 0.25 * f;
    v.group.rotation.z = (hash01(e.id) - 0.5) * 0.25 * f;
  }
  if (!v.flat) showRuin(e, v, age, s, y0);
}

/**
 * A Mongol building on a trip (core Replay.trips / tripAt; syncModel shows the cart while cartShown). Packing, the
 * building folds down over PACK_FOLD of the phase and the cart grows in; rolling, the cart turns (CART_TURN rad/s)
 * onto its way and rocks; unpacking, the cart shrinks away over CART_IN and the building rises. Off a trip it stands
 * square. [inference] the game's own fold and unfold are state-tree animation the built models do not carry, and the
 * cart's wheels are merged into its mesh, so they do not turn.
 */
const PACK_FOLD = 0.75, CART_IN = 0.25, CART_TURN = 2.5;
const cartShown = (tr) => tr.phase === 'roll' || (tr.phase === 'pack' ? tr.k >= PACK_FOLD : tr.k < CART_IN);
function packPose(e, v, tr, t, s) {
  const g = v.group;
  g.rotation.set(0, 0, 0);
  if (!tr) return;
  const { r, phase, k } = tr;
  if (!cartShown(tr)) { // the building folding down (pack) or rising (unpack)
    const f = phase === 'pack' ? 1 - sstep(k, 0, PACK_FOLD) : sstep(k, CART_IN, 1);
    g.scale.set(s * (0.7 + 0.3 * f), s * Math.max(0.03, f), s * (0.7 + 0.3 * f));
    return;
  }
  g.scale.setScalar(s * Math.max(0.03, phase === 'pack' ? sstep(k, PACK_FOLD, 1) : phase === 'unpack' ? 1 - sstep(k, 0, CART_IN) : 1));
  let h = phase === 'pack' ? r.h0 : r.h1;
  if (phase === 'roll') {
    const a = place(e, t - 0.3), ax = a.x, az = a.z, b = place(e, t + 0.3), dx = b.x - ax, dz = b.z - az;
    const want = Math.hypot(dx, dz) > 0.05 ? Math.atan2(dx, dz) : v.cartH ?? r.h0, rdt = t - v.cartT;
    h = v.cartH == null || !(rdt >= 0 && rdt < 0.5) ? want : v.cartH + clamp(wrapAngle(want - v.cartH), -CART_TURN * rdt, CART_TURN * rdt);
    const w = (t - r.t0) * 5 + e.seed * TAU; // rocking on the ruts
    g.rotation.z = 0.012 * Math.sin(w);
    g.position.y += 0.025 * Math.abs(Math.sin(0.5 * w));
  }
  v.cartH = h; v.cartT = t;
  g.rotation.y = h;
}

/** Garrison door fade: 0 inside, easing back to 1 over DOOR_FADE before going in and after coming out. */
function doorScale(e, t) {
  const g = e.garr;
  let k = 1;
  for (let i = 0; i < g.length; i += 2) k = Math.min(k, sstep(g[i] - t, 0, DOOR_FADE) + sstep(t - g[i + 1], 0, DOOR_FADE));
  return k;
}

function fallbackFor(e) {
  const p = R.players.get(e.pown);
  return buildFallback(fallbackConfig(e.bp, e.cat), p?.color ?? NEUTRAL_COLOR, SKIN[p?.civ] ?? '#c29572');
}

/**
 * Pick/refresh the entity's model: GLB for its current tier when loaded, fallback otherwise. An age-up reaches each
 * building and age-following unit up to 1.5 s apart (per seed), so a town does not change in a single frame. A rigged
 * GLB with clips draws from UnitBatches (setUnit); without clips it stands as a scene model in its bind pose. bp: the
 * blueprint whose models to show (a Mongol building's cart or standing look, entry.pack), its own by default.
 */
function syncModel(e, v, t, bp = e.bp) {
  if (farms.has(e.bp)) { if (v.key !== 'farm') v.setModel(farms.field(e), 'farm'); return; }
  const entry = ASSET_MAP[bp] ?? ASSET_MAP[e.bp];
  const url = assets.urlFor(entry, R.tierAt(e, e.isBuilding || e.followsAge ? t - 1.5 * e.seed : t), e.seed);
  if (url) {
    const pal = paletteFor(R, entry, e.pown);
    const key = `${url}|${pal}|${e.pown}`;
    if (v.key === key) return;
    const tpl = assets.template(url, pal);
    if (tpl === false) { v.setModel(fallbackFor(e), key); return; }
    const anim = tpl ? tpl.rigged && unitReady(url, e.bp) : null;
    if (anim) { v.setUnit(url, tpl, key); return; }
    if (anim === false) { v.setModel(assets.instantiate(tpl, e.pown), key); return; }
    if (!v.model && !v.unit) v.setModel(fallbackFor(e), undefined); // loading: keep what is shown
    return;
  }
  const key = `fallback|${e.pown}`;
  if (v.key !== key) v.setModel(fallbackFor(e), key);
}

function passesFilters(e, t) {
  if (!state.cats.has(e.cat)) return false;
  if (R.players.has(e.pown) && !state.players.has(e.pown)) return false;
  if (state.vision && !state.ghosts && !visibleTo(e, t, state.vision)) return false;
  return true;
}

/**
 * Crowd cap on the adaptive unit scale. Grown to the overview scale S, packed units would interpenetrate, so every
 * drawn unit (and gaia animal or carcass) is capped to what its neighbours leave room for: per pair
 * CROWD_MARGIN·d / (CROWD_K·(r_i + r_j)), the scale at which the two bodies (CROWD_K of radius r solid) touch, so with
 * margin 1 no pair apart at true size overlaps grown (a larger margin lets most of the crowd overlap again). A
 * neighbour fading through a door weighs in by its fade; never below true size, and isolated units keep S.
 * Recomputed every frame from positions at t and S alone (a typed spatial hash, no smoothing), so a paused frame
 * holds still and a seek lands on the same sizes. Writes e.us / g.us: the unit's scale before its entry scale.
 * Also poses fallen units where they died (R.updateFrame poses only the living), as their neighbours need them.
 */
const CROWD_K = 0.7, CROWD_MARGIN = 1, CROWD_RMAX = 1.2, CROWD_MASK = 4095;
class CrowdCap {
  constructor() {
    this.units = R.ents.filter((e) => e.isUnit && !e.mount); // a tower crew takes its mount's scale (updateEntities)
    this.unitR = Float32Array.from(this.units, (e) =>
      e.cat === 'cavalry' || /mounted|scout/.test(e.bp) ? 0.9 : e.cat === 'siege' ? CROWD_RMAX : e.cat === 'livestock' ? 0.5 : 0.4);
    // live gaia animals show at 0.8× (body 0.5 → 0.4), a carcass at the fallen sheep's size (GaiaLayer.updateObject)
    this.beasts = gaia.objs.filter((g) => ANIMALS.has(g.kind) || ASSET_MAP[g.bp]?.kind === 'corpse');
    const n = this.units.length + this.beasts.length;
    this.x = new Float32Array(n); this.z = new Float32Array(n); this.r = new Float32Array(n); this.w = new Float32Array(n);
    this.who = new Array(n); this.next = new Int32Array(n); this.head = new Int32Array(CROWD_MASK + 1);
  }
  update(t) {
    const S = state.scaleNow, cap = state.adaptiveScale && S > 1.001, { x, z, r, w, who, next, head } = this;
    let n = 0;
    const add = (o, px, pz, ro, wo) => { x[n] = px; z[n] = pz; r[n] = ro; w[n] = wo; who[n++] = o; };
    for (let k = 0; k < this.units.length; k++) {
      const e = this.units[k];
      e.us = S;
      if (!e.on) {
        if (e.died == null || t < e.died || t >= (e.corpseT ?? e.died + DEATH_SECS)) continue;
        const at = e.died - 1e-3, L = place(e, at);
        e.pown = ownerAt(e, at); e.px = L.x; e.pz = L.z; e.php = L.hp; e.pi = L.i;
      } else if (e.hid) continue;
      if (cap && passesFilters(e, e.on ? t : e.died - 1e-3)) add(e, e.px, e.pz, this.unitR[k], e.garr ? doorScale(e, t) : 1);
    }
    for (const g of this.beasts) {
      g.us = S;
      if (!cap || !state.opt.gaia || !alive(g, t)) continue;
      locateGaia(g, t);
      if (!(g.amT && g.amount <= 0)) add(g, g.px, g.pz, ASSET_MAP[g.bp]?.kind === 'corpse' ? 0.5 : 0.4, 1);
    }
    if (!cap) return;
    // a pair caps below S only closer than CROWD_K·(r_i + r_j)·S / CROWD_MARGIN ≤ one cell: the 3×3 cells suffice
    const inv = CROWD_MARGIN / (CROWD_K * 2 * CROWD_RMAX * S), cell = (cx, cz) => (Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663)) & CROWD_MASK;
    head.fill(-1);
    for (let i = 0; i < n; i++) { const b = cell(Math.floor(x[i] * inv), Math.floor(z[i] * inv)); next[i] = head[b]; head[b] = i; }
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(x[i] * inv), cz = Math.floor(z[i] * inv);
      let c = S;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (let j = head[cell(cx + dx, cz + dz)]; j >= 0; j = next[j]) {
            const k = (CROWD_K * (r[i] + r[j])) / CROWD_MARGIN, ex = x[j] - x[i], ez = z[j] - z[i], d2 = ex * ex + ez * ez;
            if (j === i || d2 >= k * k * S * S) continue;
            const pc = S + (Math.sqrt(d2) / k - S) * w[j];
            if (pc < c) c = pc;
          }
        }
      }
      who[i].us = Math.max(1, c);
    }
  }
}
const crowd = new CrowdCap();

/**
 * Facing (vx, vz, spd = velocity from place()): toward the target while standing, or while moving mid-swing at a
 * target within ~75° of the move (no backwards strikes on the run); otherwise along the move; toward the next move in
 * the 0.3 s before it starts; toward the work while gathering; else the recorded heading.
 */
function desiredHeading(e, v, t, i, c, vx, vz, spd) {
  const moving = spd > 0.4;
  const ref = c.blow ?? (c.eng > 0.3 ? c.ref : null), tg = ref?.b;
  if (tg?.on && !tg.hid) {
    const a = Math.atan2(tg.px - e.px, tg.pz - e.pz);
    if (!moving || (c.blow && Math.abs(wrapAngle(a - Math.atan2(vx, vz))) < 1.3)) return a;
  }
  if (moving) return Math.atan2(vx, vz);
  if (i + 1 < e.t.length && !Number.isNaN(e.seg[i]) && t > e.t[i + 1] - SAMPLE - 0.3) return e.seg[i];
  const j = e.job ? e.job[i] : 0;
  if (j && j < CARRY && j !== J_FARM) return Math.atan2(e.jobX[i] - e.px, e.jobZ[i] - e.pz);
  return Number.isNaN(e.hd[i]) ? v.heading : e.hd[i];
}

// The game's gate swing (layout_palisade_gate gate_open / gate_close, 1 s each): the leaf angle in degrees every 1/15 s.
// Both start slow and end at full speed; door_left turns +, door_right −.
const GATE_OPEN = [0, 1, 3, 6, 10, 16, 22, 28, 35, 43, 51, 59, 67, 75, 83, 90];
const GATE_CLOSE = [90, 89, 87, 84, 80, 75, 70, 64, 57, 51, 43, 35, 27, 19, 10, 0];
const GATE_SECS = 1, GATE_REACH = 3.5, GATE_WALK = 0.3; // clip length (s), opening reach (m), moving above (m/s)
const _walkers = [], _gates = []; // per frame: live units, shown gates with leaves (updateEntities → swingGates)
const gateAngle = (dir, p) => {
  const tab = dir > 0 ? GATE_OPEN : GATE_CLOSE, x = p * 15, i = Math.min(14, Math.floor(x));
  return tab[i] + (tab[i + 1] - tab[i]) * (x - i);
};
/** Phase of the dir clip at leaf angle deg (both clips are monotonic), so a swing reversed midway carries on from there. */
function gatePhase(dir, deg) {
  const tab = dir > 0 ? GATE_OPEN : GATE_CLOSE;
  for (let i = 0; i < 15; i++) {
    const a = tab[i], b = tab[i + 1];
    if ((deg - a) * (deg - b) <= 0) return (i + (a === b ? 0 : (deg - a) / (b - a))) / 15;
  }
  return 0;
}
/**
 * Gates open while a live unit of their owner's team moves within GATE_REACH of them and close behind it, playing the
 * game's clips in replay time (paused holds; a seek or jump lands settled). A swinging gate draws its own meshes.
 */
function swingGates(t) {
  for (const e of _gates) {
    const v = e.view, team = R.players.get(e.pown)?.team, gx = v.group.position.x, gz = v.group.position.z;
    let want = false;
    for (const u of _walkers) {
      const d = Math.hypot(u.px - gx, u.pz - gz);
      if (d > GATE_REACH || (u.pown !== e.pown && (team == null || R.players.get(u.pown)?.team !== team))) continue;
      const P = place(u, t - 0.25);
      if (Math.hypot(u.px - P.x, u.pz - P.z) > GATE_WALK * 0.25) { want = true; break; }
    }
    const dir = want ? 1 : -1, dt = t - v.doorT;
    v.doorT = t;
    if (!(dt >= 0 && dt < 0.5)) { v.doorDir = dir; v.doorP = 1; }
    else {
      if (dir !== v.doorDir) { v.doorP = gatePhase(dir, gateAngle(v.doorDir, v.doorP)); v.doorDir = dir; }
      v.doorP = Math.min(1, v.doorP + dt / GATE_SECS);
    }
    const a = THREE.MathUtils.degToRad(gateAngle(v.doorDir, v.doorP));
    if (v.doors[0]) v.doors[0].rotation.y = a;
    if (v.doors[1]) v.doors[1].rotation.y = -a;
    if (a > 0 && v.batched) batches.detach(v);
  }
}

/** Low graphics: a unit beyond LOW_ANIM_NEAR m of the camera or out of view re-poses every LOW_ANIM_EVERY frames. */
const LOW_ANIM_NEAR = 90, LOW_ANIM_EVERY = 3;
const _lowFrustum = new THREE.Frustum(), _lowPV = new THREE.Matrix4(), _lowS = new THREE.Sphere(new THREE.Vector3(), 4);
let frameNo = 0;
/** Whether v keeps its last pose this frame (Low graphics; set() still needs it every frame to draw it). */
function animHeld(e, v) {
  if (state.quality !== 'low' || !v.us || v.usKey !== v.key || !e.on || (frameNo + e.id) % LOW_ANIM_EVERY === 0) return false;
  const y = v.group.position.y;
  if (Math.hypot(e.px - _camW.x, y - _camW.y, e.pz - _camW.z) > LOW_ANIM_NEAR) return true;
  _lowS.center.set(e.px, y, -e.pz);
  return !_lowFrustum.intersectsSphere(_lowS);
}

function updateEntities(t) {
  _pxPerM = renderer.domElement.clientHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  _camW.set(camera.position.x, camera.position.y, -camera.position.z); // the camera in world-group space (Z mirrored)
  if (state.quality === 'low') {
    camera.updateMatrixWorld();
    _lowFrustum.setFromProjectionMatrix(_lowPV.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  }
  crowd.update(t);
  _walkers.length = 0; _gates.length = 0;
  for (const e of R.ents) {
    const c = combatAt(e, t);
    e.foe = c.ref && (c.blow || c.eng > 0.5) && !c.ref.guess ? c.ref.b : null; // tether target (none for a guessed fort shot)
    const until = e.died == null ? -Infinity : e.isBuilding ? e.died + RUIN_SECS : e.corpseT ?? e.died + DEATH_SECS;
    const dying = !e.on && !e.mount && (e.isUnit || e.isBuilding) && t >= e.died && t < until; // crews go with the mount
    if ((!e.on && !dying) || (e.on && e.hid)) { // gone, or garrisoned
      e.shown = false;
      if (e.hid) e.foe = null;
      if (e.view) hideView(e.view);
      continue;
    }
    const at = e.on ? t : e.died - 1e-3; // the fallen lie where they died (fallen units: posed by crowd.update)
    if (!e.on && !e.isUnit) {
      const L = place(e, at);
      e.pown = ownerAt(e, at); e.px = L.x; e.pz = L.z; e.php = L.hp; e.pi = L.i;
    }
    const li = e.pi;
    e.gy = terrain.heightAt(e.px, e.pz);
    if (WATER_LEVEL != null && e.gy < WATER_LEVEL - WATER_DRAFT && /naval|boat/.test(e.bp)) e.gy = WATER_LEVEL - WATER_DRAFT; // ships float
    if (e.mount) { // a tower crew stands in its elephant's basket (bars, picking and shots follow e.gy)
      e.us = e.mount.us;
      e.gy += CREW_SEAT * (ASSET_MAP[e.mount.bp]?.scale ?? 1) * tweakOf(e.mount.bp, e.mount.id).scale * e.us;
    }
    if (e.isUnit && e.on) _walkers.push(e);
    const vis = passesFilters(e, at);
    e.shown = vis && e.on; // corpses get no bars, picking or counts
    if (!vis) { if (e.view) hideView(e.view); continue; }
    const v = e.view ?? (e.view = new EntityView(e));
    const entry = ASSET_MAP[e.bp], tw = tweakOf(e.bp, e.id), trip = entry?.pack ? tripAt(R.trips(e), at) : null;
    syncModel(e, v, at, entry?.pack ? (trip && cartShown(trip) ? entry.pack.cart : entry.pack.building) : e.bp);
    let s = (entry?.scale ?? 1) * tw.scale;
    if (e.isUnit) s *= e.us;
    const y0 = (e.isBuilding && !v.flat && v.model ? buildingSeat(e, v, s) : e.gy) + (entry?.yOffset ?? 0) + tw.y;
    v.group.position.set(e.px, y0, e.pz);
    v.group.scale.setScalar(e.garr ? s * doorScale(e, t) : s);
    if (entry?.pack) packPose(e, v, trip, at, s);
    if (e.wall) { // a wall piece turned along its line, a straight piece stretched to meet its neighbours (core linkWalls)
      const w = wallAt(e, at), box = modelBox(v);
      if (!w.len) { e.shown = false; hideView(v); continue; } // a foundation inside a gate tower: nothing to draw or pick
      v.group.rotation.y = w.a;
      v.group.scale.x = w.len / (box.max.x - box.min.x); // every wall model runs along its +X
      v.group.position.x += w.off * Math.cos(w.a);
      v.group.position.z -= w.off * Math.sin(w.a);
    }
    if (e.isBuilding) updateBuilding(e, v, t, s, y0);
    else v.group.visible = (e.on || !!v.unit) && v.group.scale.x > 0; // only animated models fall
    if (!v.group.visible) { if (v.batched) batches.detach(v); continue; }
    let spd = 0;
    if (e.isUnit && e.on) {
      const P = place(e, t - 0.05), vx = (e.px - P.x) / 0.05, vz = (e.pz - P.z) / 0.05;
      spd = Math.hypot(vx, vz);
      // turn at a capped rate in replay time: paused holds still, a seek or a fast-forward jump snaps
      const want = desiredHeading(e, v, t, li, c, vx, vz, spd), rdt = t - v.ht;
      v.ht = t;
      if (!(rdt >= 0 && rdt < 0.5)) v.heading = want;
      else if (rdt > 0) {
        const lim = v.turn * rdt;
        v.heading += clamp(wrapAngle(want - v.heading) * Math.min(1, rdt * 12), -lim, lim);
      }
      v.group.rotation.y = v.heading;
    } else if (e.isUnit) {
      // the fallen keep the heading they died with; a seek straight into a fall takes the last walk or recorded
      // heading (paused frames never depend on what was watched before); a sheep turns onto its carcass's heading
      if (!(v.ht > e.died - 0.6 && v.ht <= e.died)) {
        v.heading = e.exV ? Math.atan2(e.exV[0], e.exV[1]) : Number.isNaN(e.hd[li]) ? v.heading : e.hd[li];
        v.ht = e.died;
      }
      v.group.rotation.y = e.corpseH == null ? v.heading
        : v.heading + wrapAngle(e.corpseH - v.heading) * sstep(t - e.died, 0, e.corpseT - e.died);
    }
    const hi = e.hitT ? idxAt(e.hitT, t) : -1, sinceHit = hi >= 0 ? t - e.hitT[hi] : Infinity;
    const flash = state.opt.dmg && e.on && sinceHit < FLASH_SECS; // red for a moment after each recorded HP drop
    if (v.unit) {
      // the body sinks away over the last 1.5 s it lies
      if (!e.on) v.group.position.y -= 0.35 * v.height * s * sstep(t - e.died, DEATH_SECS - 1.5, DEATH_SECS);
      v.group.updateMatrix();
      if (animHeld(e, v)) { v.us.flash = flash ? 1 : 0; units.set(v, v.us); continue; } // v.us.matrix is v.group.matrix
      if (unitAnim(e, v, t, c, li, (entry?.scale ?? 1) * tw.scale)) {
        _us.matrix = v.group.matrix; _us.team = teamColor(R, e.pown); _us.skin = skinOf(e.pown); _us.flash = flash ? 1 : 0;
        units.set(v, _us);
        if (state.quality === 'low') { v.us = Object.assign(v.us ?? {}, _us); v.usKey = v.key; }
      }
      continue;
    }
    if (flash !== v.flashOn) v.setFlash(flash);
    if (v.doors && e.on && !v.site) _gates.push(e);
    if (v.batchable) batches.sync(v, e.on && !v.site && !flash && !(v.doors && (v.doorDir > 0 || v.doorP < 1)));
  }
  swingGates(t);
}

// ═══════════════════════════════════════ 6. OVERLAYS ═══════════════════════════════════════

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _right = new THREE.Vector3();

const _vp = new THREE.Vector3();
/** World units per CSS pixel at world point p (camera-space depth), for screen-sized overlays. */
function worldPerPx(p) {
  const depth = Math.max(0.1, -_vp.copy(p).applyMatrix4(camera.matrixWorldInverse).z);
  return (2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / renderer.domElement.clientHeight;
}

class HealthBars {
  constructor(max = 768) {
    const g = new THREE.PlaneGeometry(1, 1);
    const mk = (opacity, order) => {
      const mesh = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ transparent: true, opacity, depthTest: false, depthWrite: false }), max);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
      mesh.frustumCulled = false;
      mesh.renderOrder = order;
      mesh.count = 0;
      scene.add(mesh);
      return mesh;
    };
    this.bg = mk(0.85, 20);
    this.fg = mk(1, 21);
    this.max = max;
    this.n = 0;
    this.m4 = new THREE.Matrix4();
    this.s = new THREE.Vector3();
    this.p = new THREE.Vector3();
    this.c = new THREE.Color();
  }
  begin() { this.n = 0; }
  /** Bar of size w × h centred at pos with a `pad`-wide owner-tinted rim (all in world units). */
  add(pos, w, h, pad, frac, owner, quat, right) {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.s.set(w + 2 * pad, h + 2 * pad, 1);
    this.m4.compose(pos, quat, this.s);
    this.bg.setMatrixAt(i, this.m4);
    this.c.copy(teamColor(R, owner)).multiplyScalar(0.3);
    this.bg.setColorAt(i, this.c);
    const fw = Math.max(1e-4, w * frac);
    this.p.copy(pos).addScaledVector(right, -(w - fw) / 2);
    this.s.set(fw, h, 1);
    this.m4.compose(this.p, quat, this.s);
    this.fg.setMatrixAt(i, this.m4);
    this.c.setHSL(0.33 * clamp(frac, 0, 1), 0.85, 0.5);
    this.fg.setColorAt(i, this.c);
  }
  end() {
    for (const mesh of [this.bg, this.fg]) {
      mesh.count = this.n;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
    }
  }
}

class LineFX {
  constructor(max = 1024) {
    this.max = max;
    this.pos = new Float32Array(max * 6);
    this.col = new Float32Array(max * 8);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 5;
    scene.add(this.lines);
    this.dots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.22, 8, 6), new THREE.MeshBasicMaterial(), 512);
    this.dots.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(512 * 3), 3);
    this.dots.frustumCulled = false;
    scene.add(this.dots);
    this.n = 0;
    this.nd = 0;
    this.m4 = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.s = new THREE.Vector3();
  }
  begin() { this.n = 0; this.nd = 0; }
  line(a, b, c, alpha, c2 = c, alpha2 = alpha) {
    if (this.n >= this.max) return;
    const i = this.n++, p = i * 6, k = i * 8;
    this.pos[p] = a.x; this.pos[p + 1] = a.y; this.pos[p + 2] = a.z;
    this.pos[p + 3] = b.x; this.pos[p + 4] = b.y; this.pos[p + 5] = b.z;
    this.col[k] = c.r; this.col[k + 1] = c.g; this.col[k + 2] = c.b; this.col[k + 3] = alpha;
    this.col[k + 4] = c2.r; this.col[k + 5] = c2.g; this.col[k + 6] = c2.b; this.col[k + 7] = alpha2;
  }
  dot(p, c, size) {
    if (this.nd >= 512) return;
    this.s.setScalar(size);
    this.m4.compose(p, this.q, this.s);
    this.dots.setMatrixAt(this.nd, this.m4);
    this.dots.setColorAt(this.nd, c);
    this.nd++;
  }
  end() {
    const g = this.lines.geometry;
    g.setDrawRange(0, this.n * 2);
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    this.dots.count = this.nd;
    this.dots.instanceMatrix.needsUpdate = true;
    this.dots.instanceColor.needsUpdate = true;
  }
}

/** Terrain-hugging flat ring (fight zones). */
function groundRing(x, z, r, w, segs = 96) {
  const pos = [], idx = [];
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * TAU, ca = Math.cos(a), sa = Math.sin(a);
    for (const rr of [r - w, r]) {
      const px = x + ca * rr, pz = z + sa * rr;
      pos.push(px, terrain.heightAt(px, pz) + 0.35, pz);
    }
    if (i < segs) { const b = i * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

const bars = new HealthBars();
const fx = new LineFX();
const fightRings = R.fights.map((f) => {
  const mesh = new THREE.Mesh(groundRing(f.x, f.z, f.radius, 0.6), new THREE.MeshBasicMaterial({
    color: '#d2b66d', transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide,
  }));
  mesh.renderOrder = 3;
  world.add(mesh);
  return mesh;
});

const killTex = (() => {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const ctx = cv.getContext('2d');
  ctx.lineCap = 'round';
  for (const [w, c] of [[11, 'rgba(0,0,0,0.75)'], [7, KILL_COLOR]]) {
    ctx.strokeStyle = c; ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(10, 10); ctx.lineTo(54, 54); ctx.moveTo(54, 10); ctx.lineTo(10, 54); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
})();
const killSprites = Array.from({ length: 24 }, () => {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: killTex, transparent: true, depthTest: false, depthWrite: false }));
  sp.renderOrder = 15;
  sp.visible = false;
  scene.add(sp);
  return sp;
});

const ringGeo = new THREE.RingGeometry(0.82, 1, 48).rotateX(-Math.PI / 2);
const SEL_MAX = 4096; // selection rings drawn at most
const selRings = new THREE.InstancedMesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }), SEL_MAX);
selRings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
selRings.setColorAt(0, new THREE.Color('#ffffff')); // allocates the per-ring colours
selRings.instanceColor.setUsage(THREE.DynamicDrawUsage);
selRings.frustumCulled = false;
selRings.count = 0;
const _selM = new THREE.Matrix4(), _selC = new THREE.Color();
const hovRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide }));
selRings.renderOrder = hovRing.renderOrder = 4;
scene.add(selRings, hovRing);

/**
 * Amount left on each gold and stone mine (`1.2k`), a DOM label over it once the view is closer than AMT_PX px per
 * metre (the 2D viewer's rule). Like the 2D viewer it shows in every vision mode: the neutral scan sees through fog.
 */
const AMT_PX = 3;
class AmountLabels {
  constructor(el) {
    this.items = R.gaia.filter((g) => (g.kind === 'gold' || g.kind === 'stone') && g.amount0 > 0).map((g) => {
      const d = document.createElement('div');
      d.className = 'amt';
      el.appendChild(d);
      return { g, el: d, text: '', on: false };
    });
  }
  update(w, h) {
    for (const it of this.items) {
      const g = it.g;
      let on = state.opt.gaia && g.shown && g.amount > 0 && !!g.view;
      if (on) {
        _v.set(g.px, gaia.topOf(g) + 1, -g.pz);
        on = worldPerPx(_v) * AMT_PX < 1;
        if (on) { _v.project(camera); on = _v.z < 1 && Math.abs(_v.x) < 1.05 && Math.abs(_v.y) < 1.05; }
      }
      if (on !== it.on) { it.on = on; it.el.style.display = on ? 'block' : 'none'; }
      if (!on) continue;
      const text = g.amount >= 1000 ? `${(g.amount / 1000).toFixed(1)}k` : String(Math.round(g.amount));
      if (text !== it.text) { it.text = text; it.el.textContent = text; }
      it.el.style.transform = `translate(${((_v.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-_v.y * 0.5 + 0.5) * h).toFixed(1)}px) translate(-50%, -100%)`;
    }
  }
}
const amtLabels = new AmountLabels(document.getElementById('labels'));
const GAIA_RING = new THREE.Color('#f3e7c6');

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _p = new THREE.Vector3(), _c = new THREE.Color(), _white = new THREE.Color('#ffffff');
const SHAFT = new THREE.Color('#e8dcc0'), TORCH_FIRE = new THREE.Color('#ffa640'), GUESS_GREY = new THREE.Color('#9a9a9a');
const SIEGE_STONE = new THREE.Color(window.RV_FX.DMG_COLOR.siege), SIEGE_TRAIL = new THREE.Color('#fff7d6');
const _gc = new THREE.Color();

/**
 * Height above the ground that lines and missiles attach to: a unit's chest; a building's upper storey, at most its
 * roof (its arrows leave from there); attachments (no view) ~6 m up.
 */
const chestY = (e) => {
  const h = e.view ? e.view.height * e.view.group.scale.y : 2.5;
  return e.isBuilding ? Math.min(h, 0.6 * h + 6) : 0.6 * h + (e.cat === 'attachment' ? 6 : 0);
};
const chest = (e, out) => out.set(e.px, e.gy + chestY(e), -e.pz);
/** Overlay point (z negated) y above the ground under e where the viewer draws it at t. */
function groundAt(e, t, y, out) {
  const L = place(e, t);
  return out.set(L.x, terrain.heightAt(L.x, L.z) + y, -L.z);
}

const HEAT_COL = Object.fromEntries(Object.entries(window.RV_FIGHTPANEL.HEAT_COLOR).map(([g, c]) => [g, new THREE.Color(c)]));
function updateOverlays(t) {
  camera.updateMatrixWorld(); // worldPerPx needs this frame's view matrix (updateCamera just moved it)
  fx.begin();
  // attack lines: tethers and melee strike flashes
  if (state.opt.attacks && state.opt.heat) {
    // target fire: the FrameRenderState engagement lines coloured by target choice (the 2D viewer's Target fire)
    for (const l of VIEW.activeEngagementLines) {
      const a = R.byId.get(l.unitId), b = R.byId.get(l.targetId);
      if (!a?.on || !b?.on || !(a.shown || b.shown) || b.cat === 'livestock') continue;
      chest(a, _a); chest(b, _b);
      const c = HEAT_COL[l.grade] ?? HEAT_COL.ok;
      fx.line(_a, _b, c, 0.55, c, 0.12);
    }
  }
  if (state.opt.attacks) {
    // tethers: engaged attacker → its target (combatAt holds them through the gaps between blows)
    if (!state.opt.heat) for (const a of R.ents) {
      const b = a.foe;
      if (!b?.on || !a.on || !(a.shown || b.shown)) continue;
      chest(a, _a); chest(b, _b);
      if (_a.distanceToSquared(_b) > TETHER_MAX * TETHER_MAX) continue;
      fx.line(_a, _b, teamColor(R, a.pown), 0.28, teamColor(R, a.pown), 0.06);
    }
    // melee blows: a strike line flashing as each lands
    for (let i = idxAt(R.meleeT, t); i >= 0 && t - R.meleeT[i] < BLOW_FLASH; i--) {
      const m = R.melee[i], a = m.a, b = m.b;
      if (!(a.shown || b.shown) || !a.view?.group.visible || !b.view?.group.visible) continue;
      const k = 1 - (t - m.t1) / BLOW_FLASH;
      chest(a, _a); chest(b, _b);
      fx.line(_a, _b, teamColor(R, a.pown), 0.6 * k, _white, 0.9 * k);
    }
  }
  // projectiles in flight (FrameRenderState): from the shooter where it stood at the release to the target where it
  // stood at the hit (fixed ends, so each flies one clean arc); a miss comes down in the ground 1–2.5 m beside the target
  if (state.opt.projectiles) {
    for (const P of VIEW.activeProjectiles) {
      const s = P.shot, a = s.a, b = s.b;
      if (!(a.shown || b.shown)) continue;
      const u = P.progress;
      groundAt(a, s.t0, chestY(a), _a);
      groundAt(b, s.t1, s.miss ? 0 : chestY(b), _b);
      if (s.miss) {
        const k = Math.round(s.t0 * 64), r = 1 + 1.5 * hash3(a.id, b.id, k), ang = TAU * hash3(b.id, a.id, k);
        _b.x += r * Math.sin(ang);
        _b.z += r * Math.cos(ang);
        _b.y = terrain.heightAt(_b.x, -_b.z) + 0.05;
      }
      const h = window.RV_FX.arcHeight(P.damageType, Math.hypot(_b.x - _a.x, _b.z - _a.z)); // apex height of the arc (siege lobs high, arrows nearly flat)
      _p.lerpVectors(_a, _b, u);
      _p.y += window.RV_FX.arcAt(h, u);
      if (s.torch) { fx.dot(_p, TORCH_FIRE, 0.8 + 0.3 * state.scaleNow); continue; }
      if (P.damageType === 'siege') { // a lobbed stone or bolt: a bold gold shot trailing up its arc (the 2D viewer's colour)
        const u0 = Math.max(0, u - 0.07);
        _v.lerpVectors(_a, _b, u0);
        _v.y += window.RV_FX.arcAt(h, u0);
        fx.line(_v, _p, SIEGE_TRAIL, 0.15, SIEGE_STONE, 0.9);
        fx.dot(_p, SIEGE_STONE, 1.0 + 0.3 * state.scaleNow);
        continue;
      }
      _w.subVectors(_b, _a);
      _w.y += 4 * h * (1 - 2 * u); // arc tangent
      _v.copy(_p).sub(_w.setLength(0.6 + 0.35 * state.scaleNow));
      // a building's arrow is guessed (core fort pass: no flag recorded it), so it flies greyed and fainter
      const col = s.guess ? _gc.copy(teamColor(R, a.pown)).lerp(GUESS_GREY, 0.5) : teamColor(R, a.pown), al = s.guess ? 0.6 : 0.95;
      fx.line(_v, _p, SHAFT, al, col, al);
      fx.dot(_p, _c.copy(col).lerp(_white, 0.4), 0.35 + 0.2 * state.scaleNow);
    }
  }
  // kill markers: ✖ at the victim, killer → victim line
  let ks = 0;
  if (state.opt.kills) {
    for (let i = idxAt(R.killT, t); i >= 0 && t - R.killT[i] < KILL_MARK_SECS && ks < killSprites.length; i--) {
      const k = R.kills[i], v = R.byId.get(k.victim);
      if (!v || !state.cats.has(v.cat)) continue;
      const age = (t - k.t) / KILL_MARK_SECS;
      const lv = place(v, k.t);
      const vx = lv.x, vz = lv.z, vy = terrain.heightAt(vx, vz);
      const sp = killSprites[ks++];
      sp.visible = true;
      sp.position.set(vx, vy + 2 + (v.isUnit ? v.us : state.scaleNow), -vz);
      const sz = (v.isBuilding ? 28 : 24) * worldPerPx(sp.position) * (1 + 0.15 * Math.max(0, 1 - age * 8));
      sp.scale.set(sz, sz, 1);
      sp.material.opacity = 0.95 * (1 - THREE.MathUtils.smoothstep(age, 0.35, 1));
      const kk = k.killer != null ? R.byId.get(k.killer) : null;
      if (kk && age < 0.6) {
        const lk = place(kk, k.t);
        _a.set(lk.x, terrain.heightAt(lk.x, lk.z) + 2, -lk.z);
        _b.set(vx, vy + 2, -vz);
        fx.line(_a, _b, teamColor(R, ownerAt(kk, k.t)), 0.95 * (1 - age / 0.6), _c.set(KILL_COLOR), 0.95 * (1 - age / 0.6));
      }
    }
  }
  for (let i = ks; i < killSprites.length; i++) killSprites[i].visible = false;
  fx.end();

  // fight zones
  R.fights.forEach((f, i) => {
    fightRings[i].visible = state.opt.fights && t >= f.start - 2 && t <= f.end + 2;
  });

  // health bars
  bars.begin();
  if (state.opt.bars) {
    const quat = camera.quaternion;
    _right.setFromMatrixColumn(camera.matrixWorld, 0);
    // CSS-px size: 32×4 (units) / 40×4 (buildings) when zoomed in (≤ 70 m) → 28×3 / 40×3 at overview (≥ 140 m)
    const zoomK = THREE.MathUtils.smoothstep(camera.position.distanceTo(controls.target), 70, 140);
    const unitW = 32 - 4 * zoomK, barH = 4 - zoomK;
    for (const e of R.ents) {
      if (!e.shown || !e.view || e.cat === 'attachment' || e.cat === 'other') continue; // other = decorative pasture horses (hp 0/1)
      const sel = selection.has(e) || e === state.hovered;
      if (!sel && state.opt.barMode === 'auto' && e.php >= e.maxhp) continue;
      const v = e.view;
      _w.set(e.px, e.gy + v.height * v.group.scale.y + (e.isBuilding ? 1.5 : 0.6), -e.pz);
      const px = worldPerPx(_w);
      bars.add(_w, (e.isBuilding ? 40 : unitW) * px, barH * px, px, e.php / e.maxhp, e.pown, quat, _right);
    }
  }
  bars.end();

  // selection rings (one instanced mesh, a ring per selected entity) and the hover ring
  let nSel = 0;
  for (const e of selection) {
    if (nSel >= SEL_MAX) break;
    if (!(e.gaia ? state.opt.gaia && e.shown : e.shown && e.view)) continue;
    // map objects' boxes take in their ground decals and scatter: ring the body inside
    const r = e.gaia ? Math.max(0.9, gaia.radiusOf(e) * 0.8)
      : e.isBuilding ? e.view.radius * 1.05 : Math.max(0.9, e.view.radius * e.view.group.scale.x * 1.1);
    _selM.makeScale(r, r, r).setPosition(e.px, e.gy + 0.25, -e.pz);
    selRings.setMatrixAt(nSel, _selM);
    selRings.setColorAt(nSel, e.gaia ? GAIA_RING : _selC.copy(teamColor(R, e.pown)).lerp(_white, 0.55));
    nSel++;
  }
  selRings.count = nSel;
  selRings.visible = nSel > 0;
  selRings.instanceMatrix.needsUpdate = true;
  selRings.instanceColor.needsUpdate = true;
  {
    const e = state.hovered;
    hovRing.visible = !!(e?.gaia ? state.opt.gaia && e.shown : e?.shown && e.view) && !selection.has(e);
    if (hovRing.visible) {
      const r = e.gaia ? Math.max(0.9, gaia.radiusOf(e) * 0.8)
        : e.isBuilding ? e.view.radius * 1.05 : Math.max(0.9, e.view.radius * e.view.group.scale.x * 1.1);
      hovRing.position.set(e.px, e.gy + 0.25, -e.pz);
      hovRing.scale.setScalar(r);
      if (e.gaia) hovRing.material.color.copy(GAIA_RING);
      else hovRing.material.color.copy(teamColor(R, e.pown)).lerp(_white, 0.55);
    }
  }
  // the 2D viewer's ground marks: orders, trails, cameras, alerts, sacred sites, conversions (marks.js)
  marks.update(t);
  // the shared combat effects (fx3d.js): damage numbers, siege muzzle flashes, splash rings, heals
  combatFx.update(t, VIEW, state.opt.combatFx, state.opt.dmg);
}

// ═══════════════════════════════════════ 7. CAMERA ═══════════════════════════════════════

const FREE_FOV = 45;
const camera = new THREE.PerspectiveCamera(FREE_FOV, window.innerWidth / window.innerHeight, 0.5, 6000);
camera.position.set(0, 300, 270);
const controls = new OrbitControls(camera, renderer.domElement);
controls.mouseButtons = { LEFT: -1, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }; // the left button selects (marquee, section 8)
controls.target.set(0, 20, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = 1.45;
controls.minDistance = 6;
controls.maxDistance = 1100;
controls.screenSpacePanning = false;
controls.zoomToCursor = true;
controls.update();
controls.addEventListener('change', invalidate); // includes every damping step, not only pointer input

const keys = new Set();
const _fwd = new THREE.Vector3(), _side = new THREE.Vector3(), _move = new THREE.Vector3(), _off = new THREE.Vector3();
const _camQ = new THREE.Quaternion(), _camF = new THREE.Vector3(), _camU = new THREE.Vector3(), _camR = new THREE.Vector3();
const _camM = new THREE.Matrix4();
const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE'];
const director = RV.director(M2); // Follow action: where a caster would look at each moment (shared director.js)

/** Follow action on or off (button, G). It owns the camera: a player's recorded camera and a unit follow end. */
function setFollowAction(on) {
  state.followAction = on;
  if (on) {
    setCamPlayer(0);
    if (state.follow) { state.follow = false; renderInspector(true); }
  }
  syncPov();
}

/** Drive the view from player idx's recorded camera (R.cameraAt), or hand it back to the free camera (0). */
function setCamPlayer(idx) {
  if (idx === state.camPlayer) return;
  state.camPlayer = idx;
  $('camView').value = String(idx);
  controls.enabled = !idx;
  if (idx) { state.follow = false; state.followAction = false; }
  else { camera.fov = FREE_FOV; camera.updateProjectionMatrix(); }
}

/** Put the camera at a recorded one (world coordinates; the scene mirrors z), aiming the orbit target at the ground
 * under the view centre so the unit scale, shadow box and a later free camera all start from what it shows. */
function playerView(c) {
  _camQ.set(c.q[1], c.q[2], c.q[3], c.q[0]);
  _camF.set(0, 0, 1).applyQuaternion(_camQ); _camF.z = -_camF.z; // the game camera looks down its +z
  _camU.set(0, 1, 0).applyQuaternion(_camQ); _camU.z = -_camU.z;
  _camR.crossVectors(_camF, _camU);
  camera.position.set(c.x, c.y, -c.z);
  const k = _camF.y < -1e-3 ? (c.y - terrain.heightAt(c.x, c.z)) / -_camF.y : 100;
  controls.target.copy(camera.position).addScaledVector(_camF, k);
  camera.quaternion.setFromRotationMatrix(_camM.makeBasis(_camR, _camU, _camF.negate())); // a three camera looks down -z
  if (camera.fov !== c.fov) { camera.fov = c.fov; camera.updateProjectionMatrix(); }
}

function updateCamera(dt) {
  if (state.camPlayer) {
    const c = !state.follow && !MOVE_KEYS.some((k) => keys.has(k)) && R.cameraAt(state.camPlayer, state.t);
    if (c) { playerView(c); return; }
    if (c !== null) setCamPlayer(0); // a move key or a unit follow takes the camera back
  }
  _move.set(0, 0, 0);
  camera.getWorldDirection(_fwd);
  _fwd.y = 0;
  _fwd.normalize();
  _side.crossVectors(_fwd, camera.up).normalize();
  if (keys.has('KeyW')) _move.add(_fwd); // arrow keys seek (the 2D viewer's keys)
  if (keys.has('KeyS')) _move.sub(_fwd);
  if (keys.has('KeyD')) _move.add(_side);
  if (keys.has('KeyA')) _move.sub(_side);
  const dist = camera.position.distanceTo(controls.target);
  if (_move.lengthSq() > 0) {
    state.follow = false; state.followAction = false;
    _move.normalize().multiplyScalar(dist * 0.9 * dt * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 2.5 : 1));
    controls.target.add(_move);
    camera.position.add(_move);
  }
  const rot = (keys.has('KeyQ') ? 1 : 0) - (keys.has('KeyE') ? 1 : 0);
  if (rot) {
    _off.subVectors(camera.position, controls.target).applyAxisAngle(camera.up, rot * dt * 1.4);
    camera.position.copy(controls.target).add(_off);
  }
  if (state.followAction && state.follow && state.selected) state.followAction = false; // a unit follow (F, double-click) takes over
  if (state.followAction) {
    const s = director.shot(state.t);
    if (s) {
      const k = 1 - Math.exp(-dt * 2.5); // wall-clock rate: the same pan at every playback speed
      _v.set(s.x, terrain.heightAt(s.x, s.z), -s.z).sub(controls.target);
      _off.subVectors(camera.position, controls.target);
      const zoom = Math.log(clamp(s.r * 6, 70, 500) / _off.length()); // focusFight's framing of a fight's radius
      if (_v.lengthSq() > 0.0025 || Math.abs(zoom) > 1e-3) {
        controls.target.addScaledVector(_v, k);
        camera.position.copy(controls.target).addScaledVector(_off, Math.exp(zoom * k));
      }
    }
  }
  const e = state.selected;
  if (state.follow && e) {
    if (!e.on) state.follow = false;
    else {
      _v.set(e.px, e.gy, -e.pz).sub(controls.target).multiplyScalar(1 - Math.exp(-dt * 6));
      controls.target.add(_v);
      camera.position.add(_v);
    }
  }
  controls.target.x = clamp(controls.target.x, -HALF - 40, HALF + 40);
  controls.target.z = clamp(controls.target.z, -HALF - 40, HALF + 40);
  controls.update();
}

const SUN_OFFSET = sun.position.clone(); // sun position relative to the shadow centre
const _shF = SUN_OFFSET.clone().normalize(), _shR = new THREE.Vector3(), _shU = new THREE.Vector3(), _shC = new THREE.Vector3();
const _shRay = new THREE.Raycaster(), _shPlane = new THREE.Plane(), _shHit = new THREE.Vector3(), _shNdc = new THREE.Vector2();
const _shUp = new THREE.Vector3(0, 1, 0);
{
  const m = new THREE.Matrix4().lookAt(SUN_OFFSET, new THREE.Vector3(), _shUp); // the shadow camera's basis: right, up, _shF
  _shR.setFromMatrixColumn(m, 0);
  _shU.setFromMatrixColumn(m, 1);
}
/**
 * Fit the sun's shadow box to the ground in view, at most SHADOW_HALF from the view centre: up close it shrinks to the
 * view, so shadows get sharper; from overview zoom only the middle of the view casts shadows (fading out toward the
 * box edge, see the shader patch at the renderer), which keeps far casters out of the shadow pass. The centre snaps
 * to whole shadow texels in light space so shadows don't crawl while panning.
 */
function fitShadow() {
  const c = controls.target, sc = sun.shadow.camera;
  _shPlane.setFromNormalAndCoplanarPoint(_shUp, c);
  let r = 0;
  for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    _shRay.setFromCamera(_shNdc.set(x, y), camera);
    const hit = _shRay.ray.intersectPlane(_shPlane, _shHit);
    r = Math.max(r, hit ? hit.distanceTo(c) : Infinity);
  }
  const half = Math.min(SHADOW_HALF, Math.ceil((r + 20) / 10) * 10); // + 20 m for tall casters at the edge
  const texel = (2 * half) / sun.shadow.mapSize.x;
  const a = Math.round(c.dot(_shR) / texel) * texel, b = Math.round(c.dot(_shU) / texel) * texel;
  _shC.copy(_shR).multiplyScalar(a).addScaledVector(_shU, b).addScaledVector(_shF, c.dot(_shF));
  sun.target.position.copy(_shC);
  sun.position.copy(_shC).add(SUN_OFFSET);
  if (sc.right !== half) {
    Object.assign(sc, { left: -half, right: half, top: half, bottom: -half });
    sc.updateProjectionMatrix();
  }
}

function focusOn(x, z, dist) {
  setCamPlayer(0);
  _off.subVectors(camera.position, controls.target).normalize().multiplyScalar(dist);
  controls.target.set(x, terrain.heightAt(x, z), -z);
  camera.position.copy(controls.target).add(_off);
}

// ═══════════════════════════════════════ 8. UI ═══════════════════════════════════════

const $ = (id) => document.getElementById(id);
const playerName = (idx) => R.players.get(idx)?.name ?? 'Gaia';
const playerColor = (idx) => R.players.get(idx)?.color ?? NEUTRAL_COLOR;
const iconFor = (bp) => ASSET_MAP[bp]?.icon ?? `${ICON_DIR}${bp}.png`;
/** An entity's icon: the extracted game icon when the catalog has one, else the 2D map's art for it (no request, so no 404). */
function iconSrc(e, px) {
  const a = ASSET_MAP[e.bp]?.icon;
  if (a) return a;
  const col = playerColor(e.pown);
  if (e.isBuilding) return RV.BUILDING_TYPES[e.bkind] ? RV.buildingIcon(e.bkind, col, px) : null;
  return RV.UNIT_TYPES[e.type] ? RV.unitIcon(e.type, col, px) : null;
}

function seek(t) {
  state.t = clamp(t, R.t0, R.t1);
  reanchor();
  raidToasts.clear();
  raidToasts.last = state.t;
}

function setPlaying(p) {
  if (state.playing) state.t = clockTime(performance.now());
  if (p && state.t >= R.t1) seek(R.t0);
  state.playing = p;
  reanchor();
  $('play').textContent = p ? '❚❚' : '▶';
}

function setSpeed(s) {
  if (state.playing) state.t = clockTime(performance.now());
  state.speed = s;
  reanchor();
  $('speed').textContent = `${s}×`;
  $('slower').disabled = s <= SPEEDS[0];
  $('faster').disabled = s >= SPEEDS[SPEEDS.length - 1];
}
/** One step along SPEEDS (− / + buttons and keys). */
const stepSpeed = (dir) => setSpeed(SPEEDS[clamp(SPEEDS.indexOf(state.speed) + dir, 0, SPEEDS.length - 1)]);

/**
 * The selection is a Set of entities (units and buildings, or one map object); state.selected is its only member (null
 * for none or several). selVer counts changes, so the controller sync and the group inspector only redo work on one.
 */
function setSelection(list, follow = false) {
  selection.clear();
  const gaiaE = list.find((e) => e?.gaia);
  if (gaiaE) selection.add(gaiaE); // a map object is never part of a group
  else for (const e of list) if (e) selection.add(e);
  afterSelection(follow);
}
function afterSelection(follow = false) {
  invalidate();
  selVer++;
  state.selected = selection.size === 1 ? selection.values().next().value : null;
  state.follow = !!(follow && state.selected);
  renderInspector(true);
}
const select = (e, follow = false) => setSelection(e ? [e] : [], follow);
const selectIds = (ids) => setSelection(ids.map((id) => R.byId.get(id)));
/** Units that left the map drop out of a group (a single selected corpse stays inspectable). */
function pruneSelection() {
  let n = selection.size;
  for (const e of selection) if (!e.on) selection.delete(e);
  if (selection.size !== n) afterSelection();
}

/** Show a fight (Engagements list, [ / ] keys): from RV.FIGHT_LEAD s before its start, framed on its area. */
function focusFight(f) {
  seek(f.start - RV.FIGHT_LEAD);
  state.follow = false;
  focusOn(f.x, f.z, Math.max(70, f.radius * 6));
  renderFightPanel(f);
}

const TEAM_ORDER = R.teams.flatMap((tm) => [...R.players.values()].filter((p) => p.team === tm)); // players grouped by team
const CAM_ORDER = [0, ...TEAM_ORDER.map((p) => p.idx).filter((idx) => R.cameras.has(idx))]; // C cycles: free, then each player's
const chip = (color) => `<span class="chip" style="background:${color}"></span>`;

// top bar: Matches, teams side by side ("vs" between teams), the clock, victory conditions (hud.js), Player View, Match
// trends, Watch in game (portal.js)
{
  const SM = R.d.summary; // aoe4world match summary: absent when there's no .summary.json beside the replay
  const result = (p) => SM?.players?.[p.idx]?.result;
  const pl = (p) => `<div class="pl">${chip(p.color)}${esc(p.name)}
    <span class="civ">${esc(prettyCiv(p.civ))}</span><span class="age" id="age${p.idx}">I</span>${result(p) ? `<span class="res ${esc(result(p))}">${esc(result(p))}</span>` : ''}</div>`;
  const info = SM && [SM.map?.name, SM.map?.biome, SM.map?.size, SM.mode, SM.winReason,
    SM.startedAt && new Date(SM.startedAt * 1000).toLocaleDateString()].filter(Boolean).join(' · ');
  $('topbar').innerHTML = '<button id="matchesBtn" title="Open another recording or record new matches">Matches</button>'
    + R.teams.map((tm) => TEAM_ORDER.filter((p) => p.team === tm).map(pl).join('')).join('<span class="vs">vs</span>')
    + '<div id="clock">0:00</div><div id="victory" hidden></div>'
    + '<button id="povBtn"></button>'
    + '<button id="trendsBtn" title="Every recorded match compared: economy, army and fights over time">📊 Match Trends</button>'
    + '<button id="watchGame" title="Open this replay in Age of Empires IV at this moment, camera where yours is">Watch in game</button>'
    + (info ? `<div class="match" title="Map · biome · size · mode · how it ended · played">${esc(info)}</div>` : '');
  document.title = `AoE IV Replay — ${R.teams.map((tm) => TEAM_ORDER.filter((p) => p.team === tm).map((p) => p.name).join(' & ')).join(' vs ')}`;
  initPortal({
    name: REPLAY_NAME, players: [...R.players.values()].map((p) => p.name),
    time: () => state.t, view: () => ({ x: controls.target.x, z: -controls.target.z }), // world z is mirrored game z
  });
  // the top bar wraps on narrow screens (and grows with victory timers): panels under it (#comp) follow its bottom edge
  new ResizeObserver(() => document.body.style.setProperty('--below-top', `${Math.round($('topbar').getBoundingClientRect().bottom + 6)}px`))
    .observe($('topbar'));
}

// blueprints no asset build has covered (not in catalog.json, no hand-tuned entry) show procedural stand-ins: say so
{
  const built = (bp) => ASSET_MAP[bp] || CATALOG?.blueprints?.[bp];
  const civs = new Set(), types = new Set(), objects = new Set();
  for (const e of R.ents) {
    if (e.cat === 'attachment' || built(e.bp)) continue;
    const civ = R.players.get(e.owner)?.civ;
    if (civ) { types.add(e.bp); civs.add(prettyCiv(civ)); } else objects.add(e.bp);
  }
  for (const g of R.gaia) if (!built(g.bp)) objects.add(g.bp);
  const n = (k, word) => `${k} ${word}${k > 1 ? 's' : ''}`;
  const what = [types.size && `${n(types.size, 'unit/building type')} (${[...civs].join(', ')})`,
    objects.size && n(objects.size, 'map object type')].filter(Boolean);
  if (what.length) {
    showNotice(`3D models for ${what.join(' and ')} aren't built yet, so they show as simple stand-in shapes. To build them `
      + '(needs the game installed), run <code>node tools/build-assets.mjs --all</code> in the viewer folder once (every civ, '
      + `about 45 minutes; later replays then need no build) or <code>node tools/build-assets.mjs --replay ${esc(REPLAY_NAME)}</code> `
      + 'for just this replay (a few minutes), then <code>node tools/havok/bake-anims.mjs</code>, and reload this page.', { html: true, ms: 30000 });
  }
}

// filters
{
  const counts = {};
  for (const e of R.ents) counts[e.cat] = (counts[e.cat] ?? 0) + 1;
  const cats = [...CAT_ORDER, ...Object.keys(counts).filter((c) => !CAT_ORDER.includes(c))].filter((c) => counts[c]);
  const mil = cats.filter((c) => R.isMilitary(c)); // units.js military categories (the 2D viewer's)
  const row = (id, label, checked, cls = '') => `<label class="${cls}"><input type="checkbox" data-cat="${id}" ${checked ? 'checked' : ''}> ${label} <span class="n" data-n="${id}"></span></label>`;
  let html = counts.villager ? row('villager', CAT_LABELS.villager, true) : '';
  if (mil.length) html += `<label><input type="checkbox" id="milAll" checked> Military</label>`;
  for (const c of mil) html += row(c, CAT_LABELS[c] ?? c, true, 'sub');
  for (const c of cats.filter((c) => c !== 'villager' && !mil.includes(c))) html += row(c, CAT_LABELS[c] ?? c, state.cats.has(c));
  $('cats').innerHTML = html;
  const milAll = $('milAll');
  const syncMil = () => {
    if (!milAll) return;
    const on = mil.filter((c) => state.cats.has(c)).length;
    milAll.checked = on === mil.length;
    milAll.indeterminate = on > 0 && on < mil.length;
  };
  $('cats').addEventListener('change', (ev) => {
    const el = ev.target;
    if (el === milAll) for (const c of mil) { if (milAll.checked) state.cats.add(c); else state.cats.delete(c); }
    else if (el.dataset.cat) { if (el.checked) state.cats.add(el.dataset.cat); else state.cats.delete(el.dataset.cat); }
    for (const box of $('cats').querySelectorAll('[data-cat]')) box.checked = state.cats.has(box.dataset.cat);
    syncMil();
  });
  $('playerFilter').innerHTML = TEAM_ORDER.map((p) =>
    `<label><input type="checkbox" data-p="${p.idx}" checked>${chip(p.color)}${esc(p.name)}</label>`).join('');
  $('playerFilter').addEventListener('change', (ev) => {
    const p = +ev.target.dataset.p;
    if (ev.target.checked) state.players.add(p); else state.players.delete(p);
  });
  // values are player bit masks (visibleTo's): a team option for each team of two or more, then each player
  const bit = (p) => 1 << (p.idx - 1);
  const teamOpts = R.teams.map((tm, i) => {
    const ps = TEAM_ORDER.filter((p) => p.team === tm);
    return ps.length < 2 ? '' : `<option value="${ps.reduce((m, p) => m | bit(p), 0)}">Team ${i + 1} (${ps.map((p) => esc(p.name)).join(', ')})</option>`;
  }).join('');
  $('vision').innerHTML = '<option value="0">Everyone (free view)</option>'
    + (teamOpts && `<optgroup label="Teams">${teamOpts}</optgroup>`)
    + `<optgroup label="Players">${TEAM_ORDER.map((p) => `<option value="${bit(p)}">${esc(p.name)}</option>`).join('')}</optgroup>`;
  $('vision').addEventListener('change', (ev) => { state.vision = +ev.target.value; });
  $('camView').innerHTML = '<option value="0">Free camera</option>'
    + CAM_ORDER.slice(1).map((idx) => `<option value="${idx}">${esc(playerName(idx))}'s camera</option>`).join('');
  $('camView').disabled = CAM_ORDER.length < 2;
  $('camView').addEventListener('change', (ev) => { setCamPlayer(+ev.target.value); ev.target.blur(); });
  $('optGhosts').addEventListener('change', (ev) => { state.ghosts = ev.target.checked; });
  const bind = (id, key, apply) => $(id).addEventListener('change', (ev) => { state.opt[key] = ev.target.checked; apply?.(); });
  bind('optBars', 'bars');
  bind('optDmg', 'dmg');
  bind('optCombatFx', 'combatFx');
  bind('optAttacks', 'attacks');
  bind('optHeat', 'heat', () => { for (const n of document.querySelectorAll('#fightPanel input[data-heat]')) n.checked = state.opt.heat; });
  bind('optProjectiles', 'projectiles');
  bind('optKills', 'kills');
  bind('optFights', 'fights');
  bind('optGrid', 'grid', () => { terrain.grid.value = state.opt.grid ? 1 : 0; coordLabels.visible = state.opt.grid; });
  bind('optGaia', 'gaia', () => { hoverDirty = true; });
  bind('optShadows', 'shadows', () => { sun.castShadow = state.opt.shadows && state.quality !== 'low'; });
  bind('optGrass', 'grass');
  bind('optAO', 'ao');
  bind('optOrders', 'orders');
  bind('optEcoOrders', 'ecoOrders');
  bind('optTrails', 'trails');
  bind('optCams', 'cams');
  bind('optLabels', 'labels');
  bind('optComp', 'comp');
  bind('optToasts', 'toasts', () => { if (!state.opt.toasts) raidToasts.clear(); });
  bind('optDebug', 'debugCard', () => renderInspector(true));
  $('optBarMode').addEventListener('change', (ev) => { state.opt.barMode = ev.target.value; });
  const scale = $('unitScale');
  const showScale = () => { $('scaleMax').textContent = `${state.unitScale.toFixed(2)}×`; };
  scale.value = String(state.unitScale);
  showScale();
  scale.addEventListener('input', () => { state.unitScale = +scale.value; showScale(); });
  $('optAdaptive').checked = state.adaptiveScale;
  $('optAdaptive').addEventListener('change', (ev) => { state.adaptiveScale = ev.target.checked; });
}

// engagements: the list, Most impactful first (fights.js `impact`: resources both sides lost, forced villager idle time
// and the army swing) or Chronological, each row with its Micro Rating badges and a bar of what each side lost. The
// analyses (fights.js, cached per fight) run a few fights per tick after load; the impact order applies once all are in.
const fightA = R.fights.map(() => null); // RV_FIGHTS.analyze per R.fights index, as they come in
let fightsReady = !R.fights.length, curFight = -1;
const fightAnalysis = (f) => {
  const i = R.d.fights.findIndex((x) => x.id === f.id);
  return i < 0 ? null : window.RV_FIGHTS.analyze(R.d, R.combat, i);
};
const teamCol = (tm) => TEAM_ORDER.find((p) => p.team === tm)?.color ?? NEUTRAL_COLOR;
const teamNames = (tm) => TEAM_ORDER.filter((p) => p.team === tm).map((p) => p.name).join(' & ');
const lostOf = (A, tm) => A.lost.total[tm] ?? 0;
function renderFightList() {
  const byImpact = $('fightSort').value === 'impact';
  const order = R.fights.map((_, i) => i);
  if (byImpact && fightsReady) order.sort((a, b) => (fightA[b]?.impact ?? 0) - (fightA[a]?.impact ?? 0) || a - b);
  const done = fightA.filter(Boolean).length;
  $('fights').innerHTML = (byImpact && !fightsReady ? `<span class="muted">Ranking fights… ${done} / ${R.fights.length}</span>` : '')
    + order.map((i) => {
      const f = R.fights[i], A = fightA[i];
      const lost = A ? A.teams.map((tm) => [tm, lostOf(A, tm)]) : [], total = lost.reduce((s, [, v]) => s + v, 0);
      const bar = total > 0 ? `<div class="lost" title="${esc(lost.map(([tm, v]) => `${teamNames(tm)} lost ${Math.round(v)}`).join(' · '))} resources">`
        + lost.map(([tm, v]) => `<i style="width:${((v / total) * 100).toFixed(1)}%;background:${teamCol(tm)}"></i>`).join('') + '</div>' : '';
      return `<div data-i="${i}" class="${i === curFight ? 'cur' : ''}"><span class="t">${fmtTime(f.start)}</span> Fight #${f.id ?? i + 1}<span class="rate"></span>`
        + `<span class="d">${A ? `${fmtK(total)} lost · ` : ''}${f.deaths} †</span>${bar}</div>`;
    }).join('') || '<span class="muted">none</span>';
  for (const row of $('fights').querySelectorAll('[data-i]')) {
    const A = fightA[+row.dataset.i];
    if (A) row.querySelector('.rate').replaceChildren(...A.teams.map((tm) => window.RV_FIGHTPANEL.badge(A.rating[tm])));
  }
}
$('fightSort').addEventListener('change', renderFightList);
$('fights').addEventListener('click', (ev) => {
  const row = ev.target.closest('[data-i]');
  if (row) focusFight(R.fights[+row.dataset.i]);
});
let fightPanel = null;
function renderFightPanel(f) {
  curFight = R.fights.indexOf(f);
  for (const row of $('fights').querySelectorAll('[data-i]')) row.classList.toggle('cur', +row.dataset.i === curFight);
  const A = fightAnalysis(f);
  $('fightBox').hidden = !A;
  if (!A) { fightPanel = null; return; }
  $('fightTitle').textContent = `Fight #${f.id} · ${fmtTime(f.start)}–${fmtTime(f.end)}`;
  fightPanel = window.RV_FIGHTPANEL.render(A, {
    t: state.t, seek: (tt) => seek(tt), heat: state.opt.heat,
    onHeat: (v) => { state.opt.heat = v; $('optHeat').checked = v; },
  });
  $('fightPanel').replaceChildren(fightPanel);
  $('fightBox').open = true;
  const side = $('side');
  if (!side.hidden) side.scrollTop += $('fightBox').getBoundingClientRect().top - side.getBoundingClientRect().top - 8;
}
{
  let k = 0;
  const step = () => {
    for (const end = Math.min(R.fights.length, k + 4); k < end; k++) fightA[k] = fightAnalysis(R.fights[k]);
    fightsReady = k >= R.fights.length;
    renderFightList();
    if (!fightsReady) setTimeout(step, 0);
  };
  renderFightList();
  setTimeout(step, 0);
}

// players panel: the 2D viewer's numbers (banked resources, pop, army series), age-up/eco tech table, kill feed
const fmtK = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)));
const STAT_ROWS = ['Food', 'Wood', 'Gold', 'Stone', 'Pop', 'Villagers', 'Army', 'Army value'];
// Players tab facts come from the shared model.js queries over M2, the 2D viewer's model of this recording
const TECHS = RV.techTable(M2);
// more than 4 players (3v3, 4v4) don't fit a label column beside theirs: each row's label goes on its own line
const MANY = TEAM_ORDER.length > 4;
const TEAM_SEP = TEAM_ORDER.map((p, j) => j > 0 && p.team !== TEAM_ORDER[j - 1].team); // a rule between teams
/** Big numbers compact (6.1k) when 8 columns share the side column. */
const fmtN = (v) => (v == null ? '–' : MANY ? fmtK(v) : v.toLocaleString());
/**
 * A players table, one column per player in team order. rows: [{ label, cls, cells: [{ html, cls, title }] }] (label
 * and title plain text, html escaped by the caller).
 */
function playerTable(rows) {
  const sep = (j) => (TEAM_SEP[j] ? ' tsep' : '');
  const head = TEAM_ORDER.map((p, j) => `<th class="${sep(j)}" title="${esc(p.name)}">${chip(p.color)}${MANY ? '' : esc(p.name)}</th>`).join('');
  const cells = (r) => r.cells.map((c, j) => `<td class="${c.cls ?? ''}${sep(j)}" title="${esc(`${TEAM_ORDER[j].name} · ${r.label}${c.title ? `: ${c.title}` : ''}`)}">${c.html}</td>`).join('');
  if (!MANY) return `<table class="ptab"><tr><th></th>${head}</tr>${rows.map((r) => `<tr class="${r.cls ?? ''}"><td title="${esc(r.label)}">${esc(r.label)}</td>${cells(r)}</tr>`).join('')}</table>`;
  return `<table class="ptab many"><tr>${head}</tr>${rows.map((r) =>
    `<tr class="lbl ${r.cls ?? ''}"><td colspan="${TEAM_ORDER.length}">${esc(r.label)}</td></tr><tr>${cells(r)}</tr>`).join('')}</table>`;
}
let statsKey = '', techKey = '', killTop = null;
{
  // the match summary's final figures: one column per player, built once (nothing in it depends on the clock)
  const sm = R.d.summary?.players;
  const rows = sm && [
    ['Result', (r) => (r.result ? `<span class="res ${esc(r.result)}">${esc(r.result)}</span>` : '–')],
    ['APM', (r) => fmtN(r.apm)],
    ['Score', (r) => fmtN(r.scores?.total)],
    ['Military', (r) => fmtN(r.scores?.military)],
    ['Economy', (r) => fmtN(r.scores?.economy)],
    ['Technology', (r) => fmtN(r.scores?.technology)],
    ['Society', (r) => fmtN(r.scores?.society)],
    ['Gathered', (r) => fmtN(r.gathered?.total)],
    ['Spent', (r) => fmtN(r.spent?.total)],
  ];
  if (rows) {
    $('psummary').innerHTML = playerTable(rows.map(([label, f]) => ({ label, cells: TEAM_ORDER.map((p) => ({ html: sm[p.idx] ? f(sm[p.idx]) : '–' })) })));
    $('summaryBox').hidden = false;
  }
}
function renderPlayers(t, fresh) {
  // one column per player, so 2v2 fits the side column
  const army = RV.armyAt(M2, t);
  const vals = TEAM_ORDER.map((p) => {
    const st = RV.statsAt(M2, p.idx, t), a = army.get(p.idx);
    return [st?.[1], st?.[2], st?.[3], st?.[4], st?.[5], a?.villagers, a?.military, a == null ? null : fmtK(a.armyValue)]
      .map((v) => (v == null ? '–' : MANY && typeof v === 'number' ? fmtK(v) : String(v)));
  });
  const sk = vals.join('|');
  if (sk !== statsKey) {
    statsKey = sk;
    $('pstats').innerHTML = playerTable(STAT_ROWS.map((label, r) => ({ label, cells: vals.map((v) => ({ html: v[r] })) })));
  }
  // first research per player: earliest green, not yet researched at t dimmed
  const cls = TECHS.map((r) => TEAM_ORDER.map((p) => {
    const at = r.at.get(p.idx);
    return at == null ? 'muted' : at > t ? 'future' : at === r.best ? 'best' : '';
  }));
  const tk = cls.join('|');
  if (tk !== techKey) {
    techKey = tk;
    $('techs').innerHTML = TECHS.length ? playerTable(TECHS.map((r, i) => ({
      label: r.label, cls: r.kind === 'age' ? 'age' : '',
      cells: TEAM_ORDER.map((p, j) => {
        const at = r.at.get(p.idx);
        return { html: at == null ? '–' : fmtTime(at), cls: cls[i][j], title: at == null ? 'not researched' : fmtTime(at) };
      }),
    }))) : '<div class="empty">No techs recorded</div>';
  }
  // kill feed: the list is fixed by its newest kill
  const ks = RV.killFeed(M2, t, KILL_FEED), top = ks.length ? ks[0] : -1; // M2.kills and R.kills share one order
  if (top === killTop) return;
  const grew = fresh && killTop !== null && top > killTop;
  killTop = top;
  $('kills').innerHTML = ks.map((i) => {
    const k = R.kills[i], v = R.byId.get(k.victim), kk = k.killer != null ? R.byId.get(k.killer) : null;
    const who = (e) => (e ? `<span class="nm" style="color:${playerColor(ownerAt(e, k.t))}">${esc(R.nameAt(e, k.t))}</span>` : '<span class="nm" style="color:var(--muted)">—</span>');
    return `<div class="k${grew && i === top ? ' fresh' : ''}" data-i="${i}"><span class="t">${fmtTime(k.t)}</span>${who(kk)}<span class="arrow">➜</span>${who(v)}</div>`;
  }).join('') || '<div class="empty">No kills yet</div>';
}
// Upgrade timing (shared ecopanel.js over eco.js): built while the Economy tab shows its box, once per second of replay time.
let ecoKey = null;
let ecoAnalysis;
function renderEco(t, force) {
  if (drawerTab !== 'eco' || !$('ecoBox').open) return;
  const key = Math.floor(t);
  if (!force && key === ecoKey) return;
  ecoKey = key;
  const d = window.REPLAY_DATA[REPLAY_NAME];
  $('ecoCost').replaceChildren(window.RV_ECOPANEL.render(ecoAnalysis ??= window.RV_ECO.analyze(d, R.combat), {
    d, C: R.combat, t, seek: (tt) => seek(tt), color: playerColor,
  }));
}
$('ecoBox').addEventListener('toggle', () => renderEco(state.t, true));

// The drawer (#right): Fights, Economy, Layers & settings, one pane at a time; the open tab's button collapses it so the
// map has the screen. The last choice is kept in localStorage.
const TAB_KEY = 'rv3d.drawer';
let drawerTab = '';
function setTab(name) {
  drawerTab = name;
  try { localStorage.setItem(TAB_KEY, name); } catch { /* storage off: the choice lasts this page */ }
  $('side').hidden = !name;
  document.body.classList.toggle('drawer-closed', !name);
  for (const b of $('tabs').querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === name);
  for (const p of $('side').querySelectorAll('.pane')) p.hidden = p.dataset.pane !== name;
  renderEco(state.t, true);
}
$('tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-tab]');
  if (b) setTab(b.dataset.tab === drawerTab ? '' : b.dataset.tab);
});
{
  let saved = '';
  try { saved = localStorage.getItem(TAB_KEY) ?? ''; } catch { /* no storage */ }
  setTab(['fights', 'eco', 'layers'].includes(saved) ? saved : '');
}
$('kills').addEventListener('click', (ev) => {
  const row = ev.target.closest('[data-i]');
  if (!row) return;
  const k = R.kills[+row.dataset.i], v = R.byId.get(k.victim);
  seek(k.t - 4);
  if (!v) return;
  const lv = place(v, k.t - 1e-3);
  focusOn(lv.x, lv.z, 70);
  select(v);
});

/** Which filter hides a living entity (passesFilters order). */
const hiddenBy = (e) => (!state.cats.has(e.cat) ? 'unit filter' : R.players.has(e.pown) && !state.players.has(e.pown) ? 'player filter' : 'vision');

// inspector: a re-rendered body, then the model tweak sliders under a ⚙ toggle (one element kept across re-renders, so
// a drag survives playback updating the body)
let inspectorKey = '';
const inspBody = document.createElement('div'), tweakEl = document.createElement('details');
tweakEl.className = 'tweak';
tweakEl.innerHTML = `<summary title="Resize or lift this 3D model">⚙ 3D model size</summary>
  <div class="trow"><span>Applies to</span><select id="twScope"><option value="obj">This object only</option><option value="bp">Every one of this type</option></select></div>
  <div class="trow"><span>Scale</span><input type="range" id="twScale" min="0.25" max="3" step="0.05"><output id="twScaleOut"></output></div>
  <div class="trow"><span>Y offset</span><input type="range" id="twY" min="-2" max="2" step="0.05"><output id="twYOut"></output></div>
  <div class="trow"><span class="note" id="twWho"></span><button id="btnTweakReset">Reset this object</button></div>
  <div class="trow"><span class="note" id="twCount"></span><button class="resetAll">Reset all scales</button></div>`;
$('inspector').append(inspBody, tweakEl);
let tweakSel = null;
/** The tweak key the sliders edit for the selection: its objKey (default), or its blueprint (scope, or no id). */
const tweakKey = (e) => ($('twScope').value === 'obj' && e.id != null ? objKey(e.id) : e.bp);
/** Show selection e's tweak (in the chosen scope) in the sliders. */
function showTweak(e) {
  tweakSel = e;
  if (e.id == null) $('twScope').value = 'bp';
  $('twScope').options[0].disabled = e.id == null;
  const obj = $('twScope').value === 'obj', tw = TWEAKS[tweakKey(e)] ?? NO_TWEAK;
  $('twScale').value = tw.scale;
  $('twY').value = tw.y;
  $('twScaleOut').textContent = `${tw.scale.toFixed(2)}×`;
  $('twYOut').textContent = `${tw.y >= 0 ? '+' : ''}${tw.y.toFixed(2)} m`;
  $('twWho').textContent = obj ? 'This one only' : `Every ${e.name}`;
  $('btnTweakReset').textContent = obj ? 'Reset this object' : 'Reset this type';
  showTweakCount();
}
function showTweakCount() {
  const n = Object.keys(TWEAKS).length;
  $('twCount').textContent = n ? `${n} override${n > 1 ? 's' : ''} saved` : 'no overrides';
  for (const b of document.querySelectorAll('.resetAll')) b.disabled = !n;
}
/** Re-seat the instanced trees a change under the selection's key touched (other models take it next frame). */
function retuneFor(e) {
  if ($('twScope').value === 'obj' && e.id != null) gaia.retune((g) => g === e);
  else gaia.retune((g) => g.bp === e.bp);
}
/** A slider moved: tweak the selected object (or every instance of its blueprint). */
function onTweak() {
  const e = tweakSel;
  if (!e) return;
  setTweak(tweakKey(e), +$('twScale').value, +$('twY').value);
  retuneFor(e);
  showTweak(e);
}
$('twScale').addEventListener('input', onTweak);
$('twY').addEventListener('input', onTweak);
$('twScope').addEventListener('change', () => tweakSel && showTweak(tweakSel));
$('btnTweakReset').addEventListener('click', () => { $('twScale').value = 1; $('twY').value = 0; onTweak(); });
/** Reset all scales: every override of every object and blueprint back to 1× / 0 m, saved at once. */
function resetAllTweaks() {
  clearTweaks();
  gaia.retune(() => true);
  if (tweakSel) showTweak(tweakSel); else showTweakCount();
}
for (const b of document.querySelectorAll('.resetAll')) b.addEventListener('click', resetAllTweaks);
showTweakCount();

/**
 * Map objects in the tooltip and inspector: the amount left as of the last neutral scan (amounts only change at
 * scans, every SCAN s at Replay.scanPhase) out of the most it held, and who works it (Replay.villagerJobs' stands).
 * Amounts are tracked for mines, bushes and huntables; other map objects with a store say so; the rest hold none.
 */
const AMOUNT_KINDS = new Set(['gold', 'stone', 'berry', 'deer', 'boar']);
const gaiaAmount = (g) => (g.amT || AMOUNT_KINDS.has(g.kind)
  ? `${Math.round(Math.max(0, g.amount)).toLocaleString()} / ${g.full.toLocaleString()} left`
  : g.amount0 > 0 ? 'amount not tracked' : '');
/** Whether g is on the map at t (as GaiaLayer draws it; also when the layer is off). */
function gaiaOn(g, t) {
  const on = g.kind === 'sacred' ? t >= g.spans[0] : alive(g, t);
  if (on) locateGaia(g, t);
  return on && !(g.amT && g.amount <= 0);
}
const canFollow = (e) => e.on && (!e.gaia || !!e.trT); // map objects only while they move about
const _workers = [];
function gaiaTip(g, t) {
  const am = gaiaAmount(g), n = workersAt(g, t);
  return `${esc(g.name)}${am ? ` · ${am}` : ''}${n ? ` · worked by ${n}` : ''}`;
}
const villagerLink = (v, t) => `${chip(playerColor(ownerAt(v, t)))}<a data-sel="${v.id}">${esc(R.nameAt(v, t))}</a>`;
/** The debug facts (Layers & settings › Debug) under the card, its open state kept across re-renders. */
let debugOpen = false;
function appendDebug(rows, tel) {
  if (!state.opt.debugCard) return;
  const d = window.RV_CARD.debug(rows, tel);
  d.open = debugOpen;
  d.addEventListener('toggle', () => { debugOpen = d.open; });
  inspBody.append(d);
}
function renderGaiaInspector(g, force) {
  const t = state.t, on = gaiaOn(g, t), n = workersAt(g, t, _workers);
  const scan = g.amT ? R.scanAt(t) : null, k = g.amT ? idxAt(g.amT, t) : -1, felled = g.fellT <= t;
  const key = `${g.id}|${on}|${Math.round(g.amount)}|${_workers.join(',')}|${scan}|${felled}|${state.follow}|${state.opt.debugCard}|${on && g.trT ? `${g.px.toFixed(0)},${g.pz.toFixed(0)}` : ''}`;
  if (!force && key === inspectorKey) return;
  inspectorKey = key;
  const am = gaiaAmount(g), frac = g.full > 0 ? clamp(g.amount / g.full, 0, 1) : 0, end = g.spans[g.spans.length - 1];
  const workers = _workers.slice(0, 6).map((id) => villagerLink(R.byId.get(id), t)).join('<br>') + (n > 6 ? `<br>+${n - 6} more` : '');
  const chopper = felled && R.byId.get(g.chopBy);
  inspBody.innerHTML = `
    <div class="head"><img src="${esc(iconFor(g.bp))}" alt="" onerror="this.style.visibility='hidden'">
      <div><div class="title">${esc(g.name)}</div>
      <div class="owner">${chip(NEUTRAL_COLOR)}Neutral</div>
      ${on ? '' : `<div class="sub">${t < g.spans[0] ? `Appears at ${fmtTime(g.spans[0])}` : 'Gone'}</div>`}</div></div>
    <table>
      ${am ? `<tr><td>Amount</td><td>${am}${am.endsWith('left') ? `<div class="hpbar"><div style="width:${(frac * 100).toFixed(1)}%;background:hsl(42,70%,48%)"></div></div>` : ''}</td></tr>` : ''}
      ${n ? `<tr><td>Worked by</td><td>${workers}</td></tr>` : ''}
      ${felled ? `<tr><td>Felled</td><td>${fmtTime(g.fellT)}${chopper ? ` by ${villagerLink(chopper, g.fellT)}` : ''}</td></tr>` : ''}
    </table>
    <div class="btns">
      ${g.trT ? `<button id="btnFollow" class="${state.follow ? 'on' : ''}" ${canFollow(g) ? '' : 'disabled'}>${state.follow ? 'Following' : 'Follow'} (F)</button>` : ''}
      <button id="btnFocus" ${on ? '' : 'disabled'}>Focus</button>
      <button id="btnClose">Close</button>
    </div>`;
  appendDebug([['ID', g.id], ['Blueprint', g.bp], ['Kind', g.kind],
    ['Last scan', scan != null && scan >= R.t0 ? `≈ ${fmtTime(scan)}${k >= 0 ? ` · changed ${fmtTime(g.amT[k])}` : ''}` : '-'],
    ['Lifetime', `${fmtTime(g.spans[0])} – ${g.kind !== 'sacred' && end < R.t1 ? fmtTime(end) : 'end'}`],
    ['Position', `x ${g.px.toFixed(1)}, z ${g.pz.toFixed(1)}`]]);
}

/**
 * The unit card: name (stats.js display name, e.g. "Elite Archer"), owner, HP, cost, core combat stats (RV_CARD), what
 * it did this match (kills, damage dealt) and how it died; raw facts only with the debug setting on.
 */
function renderInspector(force = false) {
  const el = $('inspector');
  if (!selection.size) { el.classList.add('hidden'); inspectorKey = ''; return; }
  el.classList.remove('hidden');
  tweakEl.style.display = selection.size > 1 ? 'none' : '';
  if (selection.size > 1) return renderGroupInspector(force);
  const e = state.selected;
  if (tweakSel !== e) showTweak(e);
  if (e.gaia) return renderGaiaInspector(e, force);
  const t = state.t, dead = e.died != null && t >= e.died;
  const owner = e.on ? e.pown : ownerAt(e, Math.min(t, e.died ?? t));
  let sub = '';
  if (e.on && e.isBuilding && t < e.builtAt) sub = `Under construction (${Math.round((e.php / e.maxhp) * 100)}%)`;
  else if (e.on && e.hid) sub = 'Garrisoned';
  else if (e.on && !e.shown) sub = `Hidden by the ${hiddenBy(e)}`;
  else if (!e.on && t < e.born) sub = `Appears at ${fmtTime(e.born)}`;
  else if (!e.on && !dead) sub = 'Not on the map';
  const killer = e.killer != null ? R.byId.get(e.killer) : null, killerOwner = killer && ownerAt(killer, e.died);
  const hp = e.on ? e.php : (dead ? 0 : e.hp[0]);
  const key = `${e.id}|${sub}|${dead}|${Math.round(hp)}|${owner}|${state.follow}|${state.opt.debugCard}|${R.tierAt(e, t)}|${Math.floor(t)}`;
  if (!force && key === inspectorKey) return;
  inspectorKey = key;
  const cd = window.RV_FRAME.cardData(R.combat, e, t);
  const death = !dead ? ''
    : e.defeated ? `Lost when ${esc(playerName(owner))} was defeated at ${fmtTime(e.died)}`
    : e.killed && killer ? `Slain by <span style="color:${playerColor(killerOwner)}">${esc(playerName(killerOwner))}'s</span> `
      + `<a data-sel="${killer.id}">${esc(window.RV_FRAME.cardData(R.combat, killer, e.died)?.name ?? R.nameAt(killer, e.died))}</a> at ${fmtTime(e.died)}`
    : e.killed ? `Slain at ${fmtTime(e.died)}` : `Left the map at ${fmtTime(e.died)}`;
  inspBody.innerHTML = `
    <div class="head"><img src="${esc(iconSrc(e, 48) ?? '')}" alt="" onerror="this.style.visibility='hidden'">
      <div><div class="title">${esc(cd?.name ?? R.nameAt(e, t))}</div>
      <div class="owner"><span class="chip" style="background:${playerColor(owner)}"></span>${esc(playerName(owner))}</div>
      ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div></div>
    <div data-slot="card"></div>
    <div class="btns">
      <button id="btnFollow" class="${state.follow ? 'on' : ''}" ${e.on ? '' : 'disabled'}>${state.follow ? 'Following' : 'Follow'} (F)</button>
      <button id="btnFocus" ${e.on ? '' : 'disabled'}>Focus</button>
      ${t < e.born ? '<button id="btnBorn" title="Seek to the moment it appeared">Go to creation</button>' : ''}
      ${e.died != null ? `<button id="btnDied" title="Seek to 5 s before it ${e.defeated ? 'was defeated' : 'died'}">Go to death</button>` : ''}
      <button id="btnClose">Close</button>
    </div>`;
  // the shared card pieces (RV_CARD, from RV_FRAME.cardData at t): HP bar, cost, core stats, match impact
  const mhp = cd?.rows.find((r) => r.label === 'Max HP')?.cur ?? e.maxhp;
  let deathEl = null;
  if (death) { deathEl = document.createElement('span'); deathEl.innerHTML = death; }
  inspBody.querySelector('[data-slot=card]').append(...[window.RV_CARD.hpBar(hp, Math.max(hp, mhp), e.on),
    window.RV_CARD.cost(cd?.cost, e.value), window.RV_CARD.coreStats(cd), window.RV_CARD.impact(cd?.tel, deathEl)].filter(Boolean));
  const status = e.on ? (e.hid ? 'Garrisoned' : e.shown ? 'Alive' : `Alive (hidden by ${hiddenBy(e)})`)
    : t < e.born ? `Appears at ${fmtTime(e.born)}` : e.died != null ? `${e.defeated ? 'Defeated' : 'Killed'} at ${fmtTime(e.died)}` : 'Not on the map';
  appendDebug([['ID', e.id], ['Blueprint', e.bp], ['Category', `${CAT_LABELS[e.cat] ?? e.cat}${e.squad ? ` · squad ${e.squad}` : ''}`],
    ['Status', status], ['Visual tier', `${ROMAN[R.tierAt(e, t)] ?? R.tierAt(e, t)}${ASSET_MAP[e.bp] ? '' : ' · procedural model'}`],
    ['Lifetime', `${fmtTime(e.born)} – ${e.died != null ? fmtTime(e.died) : 'end'}`],
    ['Position', e.on ? `x ${e.px.toFixed(1)}, z ${e.pz.toFixed(1)}` : '-'], ['Value', e.value || '-']], cd?.tel);
}

const selIcon = (e, label) => {
  const im = document.createElement('img');
  im.src = iconSrc(e, 32) ?? ''; im.alt = '';
  im.onerror = () => { const s = document.createElement('span'); s.className = 'rvc-hint'; s.textContent = label.slice(0, 3); im.replaceWith(s); };
  return im;
};
/** Several units selected: a summary and the tray (one button per blueprint; click drops one unit, right-click all). */
function renderGroupInspector(force) {
  const t = state.t, groups = new Map(), owners = new Map(), mx = new Map();
  let live = 0, hp = 0, max = 0;
  for (const e of selection) {
    // recorded max HP can sit below the current HP of an upgraded unit: take the stats' max (upgrades at t) when higher
    const k = `${e.bp}|${e.pown}`;
    let m = mx.get(k);
    if (m === undefined) mx.set(k, (m = window.RV_FRAME.statsAt(R.combat, e, t)?.hp ?? 0));
    const emax = Math.max(e.php, m || e.maxhp);
    let g = groups.get(e.bp);
    if (!g) groups.set(e.bp, (g = { key: e.bp, e, label: R.nameAt(e, t), n: 0, hp: 0, maxhp: 0 }));
    g.n++; g.hp += e.php; g.maxhp += emax;
    hp += e.php; max += emax; live++;
    owners.set(e.pown, (owners.get(e.pown) ?? 0) + 1);
  }
  const key = `g|${selVer}|${Math.round(hp)}`;
  if (!force && key === inspectorKey) return;
  inspectorKey = key;
  const list = [...groups.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
  for (const g of list) g.icon = selIcon(g.e, g.label);
  const who = [...owners].map(([idx, n]) => `<span class="chip" style="background:${playerColor(idx)}"></span>${esc(playerName(idx))} ×${n}`).join(' · ');
  inspBody.innerHTML = `
    <div class="title">${live} units selected</div>
    <div class="grp">${list.length} type${list.length > 1 ? 's' : ''} · ${who}</div>
    <div data-slot="hp"></div>
    <div data-slot="tray"></div>
    <div class="btns"><button id="btnClose">Clear</button></div>`;
  inspBody.querySelector('[data-slot=hp]').append(window.RV_CARD.hpBar(hp, max, true));
  inspBody.querySelector('[data-slot=tray]').append(window.RV_CARD.tray(list, dropOne, dropAll), window.RV_CARD.trayHint());
}
/** Tray click: drop the last selected living unit of that blueprint. */
function dropOne(bp) {
  let last = null;
  for (const e of selection) if (e.bp === bp && e.on) last = e;
  if (last) { selection.delete(last); afterSelection(); }
}
/** Tray right-click / Alt+click: drop every selected unit of that blueprint. */
function dropAll(bp) {
  for (const e of [...selection]) if (e.bp === bp) selection.delete(e);
  afterSelection();
}
$('inspector').addEventListener('click', (ev) => {
  const a = ev.target.closest('[data-sel]');
  if (a) { const k = R.byId.get(+a.dataset.sel); if (k) { if (!k.on && k.died != null) seek(Math.min(state.t, k.died - 0.5)); select(k); } return; }
  const e = state.selected;
  if (ev.target.id === 'btnFollow' && e) { state.follow = !state.follow; renderInspector(true); }
  if (ev.target.id === 'btnFocus' && e && (e.gaia ? gaiaOn(e, state.t) : e.on)) focusOn(e.px, e.pz, e.isBuilding ? 80 : 45);
  if (ev.target.id === 'btnBorn' && e) seek(e.born);
  if (ev.target.id === 'btnDied' && e?.died != null) seek(e.died - 5);
  if (ev.target.id === 'btnClose') select(null);
});

// timeline
$('slower').addEventListener('click', () => stepSpeed(-1));
$('faster').addEventListener('click', () => stepSpeed(1));
$('play').addEventListener('click', () => setPlaying(!state.playing));
$('followAction').addEventListener('click', () => setFollowAction(!state.followAction));
setSpeed(1);

const track = $('track');
const tctx = track.getContext('2d');
let trackBg = null;
const TRACK_PAD_L = 44, TRACK_PAD_R = 12; // room for the curves' scale on the left (the 2D timeline's padding)
let metric = 'armyValue'; // what the curves plot: armyValue | military | villagers (army.players[idx][metric])
const tToX = (t, w) => TRACK_PAD_L + ((t - R.t0) / (R.t1 - R.t0)) * (w - TRACK_PAD_L - TRACK_PAD_R);
$('metric').addEventListener('change', (ev) => { metric = ev.target.value; trackBg = null; });
function drawTrackBg() {
  const dpr = Math.min(window.devicePixelRatio, 2);
  const w = track.clientWidth, h = track.clientHeight;
  track.width = Math.round(w * dpr);
  track.height = Math.round(h * dpr);
  trackBg = document.createElement('canvas');
  trackBg.width = track.width; trackBg.height = track.height;
  const c = trackBg.getContext('2d');
  c.scale(dpr, dpr);
  c.fillStyle = '#0b1016';
  c.fillRect(0, 0, w, h);
  // per-player curves of the chosen metric (the 2D timeline's): one scale for all players, gridlines at thirds of it
  const army = R.army;
  if (army?.players) {
    let max = 1;
    for (const p of Object.values(army.players)) for (const v of p[metric] ?? []) max = Math.max(max, v);
    const y = (v) => h - 8 - (v / max) * (h - 18);
    c.font = '10px system-ui, sans-serif';
    c.lineWidth = 1;
    for (let k = 0; k <= 3; k++) {
      const v = (max * k) / 3, yy = y(v);
      c.strokeStyle = 'rgba(255,255,255,0.08)'; c.beginPath(); c.moveTo(TRACK_PAD_L, yy); c.lineTo(w - TRACK_PAD_R, yy); c.stroke();
      c.fillStyle = 'rgba(255,255,255,0.45)'; c.fillText(v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)), 4, yy + 3);
    }
    c.fillStyle = 'rgba(255,255,255,0.35)';
    for (let m = 300; m <= R.t1; m += 300) c.fillText(fmtTime(m), tToX(m, w) + 2, h - 10);
    for (const [idx, p] of Object.entries(army.players)) {
      const vals = p[metric] ?? [];
      const col = playerColor(+idx);
      c.beginPath();
      vals.forEach((v, i) => {
        const x = tToX(i * army.step, w);
        if (i === 0) c.moveTo(x, y(v)); else c.lineTo(x, y(v));
      });
      c.strokeStyle = col; c.lineWidth = 1.5; c.globalAlpha = 0.9; c.stroke();
      c.lineTo(tToX((vals.length - 1) * army.step, w), h - 8); c.lineTo(tToX(0, w), h - 8); c.closePath();
      c.fillStyle = col; c.globalAlpha = 0.12; c.fill();
      c.globalAlpha = 1;
    }
  }
  // fights
  c.fillStyle = 'rgba(255,176,32,0.85)';
  for (const f of R.fights) c.fillRect(tToX(f.start, w), h - 5, Math.max(2, tToX(f.end, w) - tToX(f.start, w)), 4);
  // kills
  for (const k of R.kills) {
    const v = R.byId.get(k.victim);
    c.fillStyle = v ? playerColor(ownerAt(v, k.t)) : '#888';
    c.fillRect(tToX(k.t, w) - 0.5, 0, 1.5, 6);
  }
  // age-ups: each player's dashed line, its age numeral in the first free lane right of it (a numeral finding no room
  // in a crowded match, 4v4, keeps only its line and a dot)
  c.font = '700 10px system-ui, sans-serif';
  const ups = [];
  for (const [idx, list] of R.ageT) list.forEach((at, i) => ups.push({ x: tToX(at, w), idx, label: ROMAN[i + 2] ?? '' }));
  ups.sort((a, b) => a.x - b.x);
  const lanes = new Array(Math.max(1, Math.floor((h - 12) / 11))).fill(-Infinity);
  for (const u of ups) {
    c.strokeStyle = playerColor(u.idx); c.lineWidth = 1; c.setLineDash([3, 3]);
    c.beginPath(); c.moveTo(u.x, 8); c.lineTo(u.x, h); c.stroke(); c.setLineDash([]);
    c.fillStyle = playerColor(u.idx);
    const k = lanes.findIndex((end) => end <= u.x + 2);
    if (k < 0) { c.fillRect(u.x - 1.5, 7, 3, 3); continue; }
    c.fillText(u.label, u.x + 3, 17 + k * 11);
    lanes[k] = u.x + 5 + c.measureText(u.label).width;
  }
}
function drawTrack() {
  if (!trackBg) drawTrackBg();
  const dpr = track.width / track.clientWidth, w = track.clientWidth, h = track.clientHeight;
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.drawImage(trackBg, 0, 0);
  tctx.scale(dpr, dpr);
  const x = tToX(state.t, w);
  tctx.fillStyle = 'rgba(255,255,255,0.06)';
  tctx.fillRect(0, 0, x, h);
  tctx.fillStyle = '#ffffff';
  tctx.fillRect(x - 1, 0, 2, h);
  tctx.beginPath(); tctx.arc(x, h / 2, 4, 0, TAU); tctx.fill();
}
{
  let drag = false;
  const at = (ev) => { const r = track.getBoundingClientRect(); return R.t0 + clamp((ev.clientX - r.left - TRACK_PAD_L) / (r.width - TRACK_PAD_L - TRACK_PAD_R), 0, 1) * (R.t1 - R.t0); };
  track.addEventListener('pointerdown', (ev) => { drag = true; track.setPointerCapture(ev.pointerId); seek(at(ev)); });
  track.addEventListener('pointermove', (ev) => {
    if (drag) seek(at(ev));
    const tip = $('tooltip');
    tip.style.display = 'block';
    const ht = at(ev), players = Object.entries(R.army?.players ?? {}), j = Math.round(ht / (R.army?.step ?? 1));
    tip.innerHTML = `${fmtTime(ht)}${players.map(([idx, p]) =>
      `<div style="color:${playerColor(+idx)}">${esc(playerName(+idx).slice(0, 14))}: ${p[metric]?.[j] ?? '-'}</div>`).join('')}`;
    tip.style.left = `${ev.clientX + 10}px`;
    tip.style.top = `${ev.clientY - 30 - 16 * players.length}px`;
  });
  track.addEventListener('pointerup', () => { drag = false; });
  track.addEventListener('pointerleave', () => { $('tooltip').style.display = 'none'; });
}

// picking
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let mouseIn = false, downAt = null;
function pick() {
  raycaster.setFromCamera(mouse, camera);
  const ray = raycaster.ray;
  let best = null, bestScore = Infinity;
  for (const e of R.ents) {
    if (!e.shown || !e.view || e.cat === 'attachment') continue;
    const v = e.view, s = v.group.scale;
    _v.set(e.px, e.gy + v.height * s.y * 0.5, -e.pz);
    const r = e.isBuilding ? v.radius * 0.8 : Math.max(1.0, v.radius * s.x * 0.9, v.height * s.y * 0.45);
    if (ray.distanceSqToPoint(_v) > r * r) continue;
    const score = ray.origin.distanceTo(_v) + (e.isBuilding ? 1e4 : 0); // units win over the building behind them
    if (score < bestScore) { bestScore = score; best = e; }
  }
  // map objects only where no unit or building is: those always win
  return best ?? (state.opt.gaia ? gaia.pick(ray) : null);
}
const canvas = renderer.domElement;
const setMouse = (ev) => mouse.set((ev.clientX / window.innerWidth) * 2 - 1, -(ev.clientY / window.innerHeight) * 2 + 1);
canvas.addEventListener('pointermove', (ev) => { setMouse(ev); mouseIn = true; hoverDirty = true; });
canvas.addEventListener('pointerleave', () => { mouseIn = false; state.hovered = null; $('tooltip').style.display = 'none'; });
// Left button: a press that moves < 5 px is a click (pick), a longer drag draws the selection box (marquee). The camera
// orbits on the right button and pans on the middle one (controls.mouseButtons); the left button never reaches it.
const marquee = document.createElement('div');
marquee.id = 'marquee';
document.body.append(marquee);
let drag = null; // { x, y, on } while the left button is down on the canvas
canvas.addEventListener('pointerdown', (ev) => {
  downAt = [ev.clientX, ev.clientY, ev.button];
  drag = ev.button === 0 ? { x: ev.clientX, y: ev.clientY, on: false } : null;
});
function endMarquee() { drag = null; marquee.style.display = 'none'; }
canvas.addEventListener('pointermove', (ev) => {
  if (!drag) return;
  if (!(ev.buttons & 1)) return endMarquee();
  if (!drag.on) {
    if (Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) <= 5) return;
    drag.on = true;
    canvas.setPointerCapture(ev.pointerId);
    marquee.style.display = 'block';
  }
  const s = marquee.style;
  s.left = `${Math.min(drag.x, ev.clientX)}px`; s.top = `${Math.min(drag.y, ev.clientY)}px`;
  s.width = `${Math.abs(ev.clientX - drag.x)}px`; s.height = `${Math.abs(ev.clientY - drag.y)}px`;
});
canvas.addEventListener('pointercancel', endMarquee);
// a drag or the wheel takes a recorded player camera back to the free one
canvas.addEventListener('pointermove', (ev) => {
  if (!(ev.buttons & ~1) || !downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) <= 5) return;
  if (state.camPlayer) setCamPlayer(0);
  if (state.followAction) setFollowAction(false);
});
canvas.addEventListener('wheel', () => { setCamPlayer(0); if (state.followAction) setFollowAction(false); }, { passive: true });
/**
 * Every shown unit whose body centre projects inside the screen box (the same fog / filter test as picking); buildings
 * only when the box holds no unit (the 2D map's boxed). Shift adds to the selection.
 */
function boxSelect(x0, y0, x1, y1, add) {
  const W = window.innerWidth, H = window.innerHeight;
  const xa = Math.min(x0, x1), xb = Math.max(x0, x1), ya = Math.min(y0, y1), yb = Math.max(y0, y1);
  const us = [], bs = [];
  camera.updateMatrixWorld();
  for (const e of R.ents) {
    if (!e.shown || !e.view || e.hid || !(e.isUnit || e.isBuilding) || e.cat === 'attachment' || e.cat === 'other') continue;
    const v = e.view;
    _v.set(e.px, e.gy + v.height * v.group.scale.y * 0.5, -e.pz).project(camera);
    if (_v.z < -1 || _v.z > 1) continue;
    const sx = (_v.x + 1) * 0.5 * W, sy = (1 - _v.y) * 0.5 * H;
    if (sx < xa || sx > xb || sy < ya || sy > yb) continue;
    (e.isBuilding ? bs : us).push(e);
  }
  const hit = us.length ? us : bs;
  if (add) setSelection([...[...selection].filter((e) => !e.gaia), ...hit]);
  else setSelection(hit);
}
// pick at the event position rather than trusting the per-frame hover (a fast click can land between frames)
canvas.addEventListener('pointerup', (ev) => {
  const d = drag;
  endMarquee();
  if (!d || !downAt || downAt[2] !== 0) return;
  if (d.on) return boxSelect(d.x, d.y, ev.clientX, ev.clientY, ev.shiftKey);
  if (Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 5) return;
  setMouse(ev);
  const e = pick();
  if (ev.altKey) { // drop every selected unit of the clicked blueprint
    if (e && !e.gaia) setSelection([...selection].filter((k) => k.bp !== e.bp));
  } else if (ev.shiftKey) { // toggle one unit
    if (e && !e.gaia) setSelection(selection.has(e) ? [...selection].filter((k) => k !== e) : [...[...selection].filter((k) => !k.gaia), e]);
  } else select(e);
});
canvas.addEventListener('dblclick', (ev) => { setMouse(ev); const e = pick(); if (e) select(e, canFollow(e)); });
// the hover pick (a ray test against every shown entity, then map object) reruns only when the pointer, camera, time or
// scale moved
let hoverDirty = true, hoverT = NaN, hoverS = NaN;
const _hoverPos = new THREE.Vector3(), _hoverQuat = new THREE.Quaternion();
function updateHover() {
  const tip = $('tooltip');
  const previous = state.hovered;
  if (!mouseIn) state.hovered = null;
  else if (hoverDirty || state.t !== hoverT || state.scaleNow !== hoverS || !camera.position.equals(_hoverPos)
    || !camera.quaternion.equals(_hoverQuat) || (state.hovered && !state.hovered.shown)) {
    hoverDirty = false; hoverT = state.t; hoverS = state.scaleNow;
    _hoverPos.copy(camera.position); _hoverQuat.copy(camera.quaternion);
    state.hovered = pick();
  }
  const e = state.hovered;
  if (e !== previous) invalidate(); // VIEW/overlays sampled the previous hover earlier in this frame
  canvas.style.cursor = e ? 'pointer' : '';
  if (!e) { if (mouseIn) tip.style.display = 'none'; return; }
  _v.set(e.px, e.gaia ? gaia.topOf(e) : e.gy + e.view.height * e.view.group.scale.y, -e.pz).project(camera);
  tip.style.display = 'block';
  tip.innerHTML = e.gaia ? gaiaTip(e, state.t)
    : `${chip(playerColor(e.pown))}${esc(R.nameAt(e, state.t))} · ${Math.round(e.php)}/${e.maxhp}`;
  tip.style.left = `${(_v.x * 0.5 + 0.5) * window.innerWidth + 12}px`;
  tip.style.top = `${(-_v.y * 0.5 + 0.5) * window.innerHeight - 28}px`;
}

// ─── the 2D viewer's marks and panels (marks.js, panels.js): orders, trails, alerts, sites, conversions, cameras; the map
// key, army on screen, unit names, key moments. All read the 2D model M2 of the same recording.
const marks = new Marks({
  RV, M2, R, scene, camera, renderer, terrain, teamColor, opt: state.opt, vision: () => state.vision,
});
const combatFx = new CombatFx3D({
  scene, camera, heightAt: (x, z) => terrain.heightAt(x, z), FX: window.RV_FX,
  host: {
    ent: (id) => R.byId.get(id),
    passes: passesFilters,
    topOf: (e) => (e.view ? e.view.height * e.view.group.scale.y : 2.5),
    radiusOf: (e) => (e.view ? Math.max(0.9, e.view.radius * e.view.group.scale.x) : 0.9),
    chest,
    muzzle: (s, out) => groundAt(s.a, s.t0, chestY(s.a), out),
    worldPerPx,
  },
});
const legend = new Legend(RV, M2);
const armyComp = new ArmyComp(RV, M2, R, camera, (e, t) => R.nameAt(e, t));
const unitLabels = new UnitLabels(RV, R, camera, (e, t) => R.nameAt(e, t));
$('optCams').disabled = !M2.cameras.size;
$('optGaia').disabled = !R.gaia.length;
const NOTES = window.REPLAY_NOTES?.[REPLAY_NAME];
const moments = NOTES?.moments?.length ? new Moments(M2, R, NOTES, {
  name: REPLAY_NAME, speeds: SPEEDS, seek, setSpeed, play: () => setPlaying(true), clearSelection: () => select(null),
  setVision(mask) {
    state.vision = mask;
    if ([...$('vision').options].some((o) => o.value === String(mask))) $('vision').value = String(mask);
  },
  focus: (x, z, r) => focusOn(x, z, r * 2.4), // r: half-width of the ground to show; the camera looks down at ~45° (45° field of view)
}) : null;
// match state (hud.js): victory conditions in the top bar, under-attack notices on the left edge
const victory = new Victory({ RV, M2, R, color: playerColor, teamName: teamNames });
const raidToasts = new RaidToasts({
  RV, M2, R, color: playerColor, focus: (x, z) => focusOn(x, z, 70), enabled: () => state.opt.toasts, vision: () => state.vision,
});

// Player View: whose vision, camera or unit the view follows; one click hands it back to the free spectator view (no
// fog, free camera, no follow). While already free it opens Layers & settings, where the vision and camera are chosen.
const povFree = () => !state.vision && !state.camPlayer && !state.followAction && !(state.follow && state.selected);
let povKey = '';
function syncPov() {
  const vis = state.vision ? $('vision').selectedOptions[0]?.textContent ?? 'custom' : '';
  const parts = [vis && `${vis} vision`, state.camPlayer && `${playerName(state.camPlayer)}'s camera`,
    state.follow && state.selected && `following ${R.nameAt(state.selected, state.t)}`,
    state.followAction && 'following the action'].filter(Boolean);
  const key = parts.join('|');
  if (key === povKey && $('povBtn').textContent) return;
  povKey = key;
  const b = $('povBtn');
  b.classList.toggle('on', !!parts.length);
  $('followAction').classList.toggle('on', state.followAction);
  b.textContent = parts.length ? `👁 POV: ${parts[0].replace(/ vision$/, '')}${parts.length > 1 ? ' +' : ''} ✕` : '👁 Player View: OFF';
  b.title = parts.length ? `Viewing as: ${parts.join(' · ')}. Click for the free spectator view`
    : 'Free spectator view: no fog, free camera. Click to choose a player\'s vision or camera (Layers & settings)';
}
$('povBtn').addEventListener('click', () => {
  if (povFree()) { setTab('layers'); return; }
  state.vision = 0; $('vision').value = '0';
  setCamPlayer(0);
  state.follow = false; state.followAction = false;
  renderInspector(true);
  syncPov();
});

// Match Trends: every recorded match compared (shared trends.html), in a modal loaded the first time it opens
function showTrends(open) {
  const frame = $('trendsFrame');
  if (open && !frame.getAttribute('src')) frame.src = `${SHARED}trends.html`;
  $('trendsModal').classList.toggle('open', open);
}
$('trendsBtn').addEventListener('click', () => showTrends(true));
$('trendsClose').addEventListener('click', () => showTrends(false));
$('trendsModal').addEventListener('click', (ev) => { if (ev.target === $('trendsModal')) showTrends(false); });

// keyboard
window.addEventListener('keydown', (ev) => {
  if (ev.target.closest?.('input, select, textarea')) return;
  keys.add(ev.code);
  if (ev.code === 'Space') { ev.preventDefault(); setPlaying(!state.playing); }
  else if (ev.code === 'ArrowLeft' || ev.code === 'ArrowRight') {
    ev.preventDefault();
    seek(state.t + (ev.code === 'ArrowRight' ? 1 : -1) * (ev.shiftKey ? 30 : 5));
  } else if (ev.key === '+' || ev.key === '=' || ev.code === 'NumpadAdd') stepSpeed(1);
  else if (ev.key === '-' || ev.key === '_' || ev.code === 'NumpadSubtract') stepSpeed(-1);
  else if (ev.code === 'BracketLeft' || ev.code === 'BracketRight') {
    const f = RV.jumpFight(R.fights, state.t, ev.code === 'BracketRight' ? 1 : -1);
    if (f) focusFight(f);
  } else if (ev.code === 'KeyF' && state.selected && canFollow(state.selected)) { state.follow = !state.follow; renderInspector(true); }
  else if (ev.code === 'Escape') { if ($('trendsModal').classList.contains('open')) showTrends(false); else { moments?.close(); select(null); } }
  else if (ev.code === 'KeyK') legend.toggle();
  else if (ev.code === 'KeyG') setFollowAction(!state.followAction);
  else if ((ev.code === 'KeyN' || ev.code === 'KeyP') && moments) moments.step(ev.code === 'KeyN' ? 1 : -1);
  else if (ev.code === 'Home') { setCamPlayer(0); state.follow = false; state.followAction = false; controls.target.set(0, 20, 0); camera.position.set(0, 300, 270); }
  else if (ev.code === 'KeyC') setCamPlayer(CAM_ORDER[(CAM_ORDER.indexOf(state.camPlayer) + 1) % CAM_ORDER.length]);
  else if (ev.code === 'ArrowUp' || ev.code === 'ArrowDown') ev.preventDefault();
});
// deep links (#<name>/t<seconds>, the 2D viewer's): a new time seeks, another replay reloads the page with it
window.addEventListener('hashchange', () => {
  const l = parseHash();
  if (l.name !== REPLAY_NAME) location.reload();
  else if (l.time != null) seek(l.time);
  else if (l.moment != null && moments) moments.show(l.moment - 1);
});
window.addEventListener('keyup', (ev) => keys.delete(ev.code));
window.addEventListener('blur', () => keys.clear());

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  trackBg = null;
});

// asset preload (everything this replay references) + progress
{
  const urls = new Set();
  const addEntry = (entry) => {
    if (!entry) return;
    for (const u of [entry.url, ...Object.values(entry.ages ?? {})].flat()) urls.add(u);
  };
  for (const bp of new Set(R.ents.map((e) => e.bp))) addEntry(ASSET_MAP[bp]);
  for (const bp of new Set(R.gaia.map((g) => g.bp))) addEntry(ASSET_MAP[bp]);
  $('loadText').textContent = 'Loading models';
  assets.onProgress = () => {
    $('loadBar').value = assets.done / Math.max(1, assets.total);
    if (assets.done >= assets.total) $('loading').style.display = 'none';
  };
  for (const u of urls) assets.request(u);
  if (!urls.size) $('loading').style.display = 'none'; // nothing built for this replay: stand-ins only
}

// ═══════════════════════════════════════ 9. LOOP ═══════════════════════════════════════

/**
 * Ambient occlusion (GTAO) from the colour pass's own depth, with normals reconstructed from it: no second geometry
 * pass (which cost ~3.5 ms of CPU per frame here), and alpha-cut foliage and hidden objects are already right in it.
 * The composer ping-pongs two targets, so the depth is taken from whichever one the colour pass just filled.
 */
class DepthGTAOPass extends GTAOPass {
  constructor(scene, camera, width, height, depthTexture) {
    super(scene, camera, width, height);
    this.setGBuffer(depthTexture); // → NORMAL_VECTOR_TYPE 0 and no G-buffer render
    this.normalRenderTarget.setSize(1, 1);
  }

  setSize(width, height) {
    super.setSize(width, height);
    this.normalRenderTarget.setSize(1, 1); // allocated by the stock pass, never drawn here
  }

  render(renderer, writeBuffer, readBuffer, ...rest) {
    this.gtaoMaterial.uniforms.tDepth.value = this.pdMaterial.uniforms.tDepth.value = readBuffer.depthTexture;
    super.render(renderer, writeBuffer, readBuffer, ...rest);
  }
}

/**
 * Fog of war for the Vision selector (state.vision, a player bit mask): what those players see at t (R) and have seen
 * by t (G) on a FOG_CELL m grid over the arena, stamped from each of their living units and buildings with its line of
 * sight: catalog.json blueprints[bp].sight (the ebps sight_package outer radius), else a per-kind stand-in (28 m units,
 * 41 m scouts, 15 m buildings, 52 m town centres, keeps, outposts, towers). Explored ground comes from FOG_STEP-second
 * samples, kept as a checkpoint every FOG_CP samples, so a seek or scrub redoes at most FOG_CP of them (the first look
 * at a late time builds the checkpoints before it once per vision choice; scrubbing redoes at most every FOG_REDO_MS of
 * wall time); while playing it grows from the current view. Which entities show stays with the recorded vision
 * (passesFilters).
 */
const FOG_CELL = 2, FOG_FEATHER = 4, FOG_STEP = 10, FOG_CP = 6, FOG_EVERY = 0.2, FOG_REDO_MS = 250;
class FogOfWar {
  constructor(half) {
    this.x0 = -half; this.size = 2 * half;
    this.n = Math.ceil(this.size / FOG_CELL);
    this.vis = new Float32Array(this.n * this.n);
    this.seen = new Float32Array(this.n * this.n);
    this.data = new Uint8Array(this.n * this.n * 4);
    this.tex = new THREE.DataTexture(this.data, this.n, this.n, THREE.RGBAFormat);
    this.tex.magFilter = this.tex.minFilter = THREE.LinearFilter;
    this.sights = new Map(); // bp → m
    this.discs = new Map(); // m → disc()
    this.mask = 0; this.t = NaN; this.seenT = NaN; this.redoAt = 0;
    this.cps = []; // cps[k]: explored ground (×255) from the samples before R.t0 + k · FOG_CP · FOG_STEP
  }

  sight(bp) {
    let r = this.sights.get(bp);
    if (r === undefined) {
      r = CATALOG?.blueprints?.[bp]?.sight ?? (/town_center|keep|outpost|tower|wonder/.test(bp) ? 52 : /^building/.test(bp) ? 15 : /scout/.test(bp) ? 41 : 28);
      this.sights.set(bp, r);
    }
    return r;
  }

  /** A sight radius's soft disc on the grid (full inside r − FOG_FEATHER): { c: half width in cells, v: values }. */
  disc(r) {
    let d = this.discs.get(r);
    if (!d) {
      const c = Math.ceil(r / FOG_CELL), w = 2 * c + 1, v = new Float32Array(w * w);
      for (let j = 0; j < w; j++) {
        for (let i = 0; i < w; i++) v[j * w + i] = clamp((r - Math.hypot(i - c, j - c) * FOG_CELL) / FOG_FEATHER, 0, 1);
      }
      this.discs.set(r, d = { c, v });
    }
    return d;
  }

  /**
   * Each sighted entity's disc into out; at = null reads the frame facts. once: buildings already stamped (they don't
   * move, so the explored samples stamp each one once).
   */
  stamp(out, at, once) {
    const { n, x0 } = this, mask = this.mask;
    for (const e of R.ents) {
      let x, z, own;
      if (at == null) { if (!e.on || e.hid) continue; x = e.px; z = e.pz; own = e.pown; } else {
        if (once?.has(e) || !alive(e, at)) continue;
        own = ownerAt(e, at);
        if (!((1 << (own - 1)) & mask)) continue;
        if (e.isBuilding && !e.bp.includes('_moving_')) once?.add(e); // packed Mongol buildings roll elsewhere
        const P = place(e, at); x = P.x; z = P.z;
      }
      if (!(own > 0 && (1 << (own - 1)) & mask) || e.cat === 'attachment') continue;
      const { c, v } = this.disc(this.sight(e.bp)), w = 2 * c + 1;
      const ci = Math.floor((x - x0) / FOG_CELL), cj = Math.floor((z - x0) / FOG_CELL);
      const i0 = Math.max(0, ci - c), i1 = Math.min(n - 1, ci + c), j0 = Math.max(0, cj - c), j1 = Math.min(n - 1, cj + c);
      for (let j = j0; j <= j1; j++) {
        const row = j * n, krow = (j - cj + c) * w - ci + c;
        for (let i = i0; i <= i1; i++) {
          const val = v[krow + i];
          if (val > out[row + i]) out[row + i] = val;
        }
      }
    }
  }

  /** seen ← the ground explored by t, from the last checkpoint before it (building the missing ones). */
  explore(t) {
    const seen = this.seen, span = FOG_STEP * FOG_CP, k = Math.max(0, Math.floor((t - R.t0) / span)), once = new Set();
    if (!this.cps.length) this.cps.push(new Uint8Array(seen.length));
    let j = Math.min(k, this.cps.length - 1);
    const cp = this.cps[j];
    for (let i = 0; i < seen.length; i++) seen[i] = cp[i] / 255;
    for (; j < k; j++) {
      for (let s = 0; s < FOG_CP; s++) this.stamp(seen, R.t0 + (j * FOG_CP + s) * FOG_STEP, once);
      const next = new Uint8Array(seen.length);
      for (let i = 0; i < seen.length; i++) next[i] = seen[i] * 255;
      this.cps.push(next);
    }
    for (let s = R.t0 + k * span; s < t; s += FOG_STEP) this.stamp(seen, s, once);
  }

  update(t, mask) {
    if (!mask) { this.mask = 0; return; }
    const fresh = mask !== this.mask;
    if (fresh) this.cps.length = 0;
    this.mask = mask;
    const jumped = fresh || !(t >= this.seenT - 0.01 && t <= this.seenT + 3 * FOG_STEP);
    if (!jumped && !(Math.abs(t - this.t) >= FOG_EVERY)) return;
    const now = performance.now();
    if (jumped && !fresh && now < this.redoAt) return; // scrubbing: the last redo stands until the drag rests
    this.t = t;
    const { vis, seen, data } = this;
    vis.fill(0);
    this.stamp(vis, null);
    if (jumped) { this.redoAt = now + FOG_REDO_MS; this.explore(t); }
    this.seenT = t;
    for (let k = 0, o = 0; k < vis.length; k++, o += 4) {
      if (vis[k] > seen[k]) seen[k] = vis[k];
      data[o] = vis[k] * 255; data[o + 1] = seen[k] * 255;
    }
    this.tex.needsUpdate = true;
  }
}
const fog = new FogOfWar(HALF);

/** The colour pass, noting the depth texture it drew into (the composer ping-pongs two targets) for FogPass. */
class DepthRenderPass extends RenderPass {
  render(renderer, writeBuffer, readBuffer, ...rest) {
    this.depth = readBuffer.depthTexture;
    super.render(renderer, writeBuffer, readBuffer, ...rest);
  }
}
/**
 * Darkens what fog hides, by each pixel's ground position (from the colour pass's depth): unexplored ground nearly
 * black, explored ground grey and dim, seen ground as is. The sky keeps its colour.
 */
class FogPass extends Pass {
  constructor(colorPass) {
    super();
    this.colorPass = colorPass;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, tDepth: { value: null }, tFog: { value: fog.tex },
        invProj: { value: new THREE.Matrix4() }, camWorld: { value: new THREE.Matrix4() },
        origin: { value: fog.x0 }, size: { value: fog.size },
      },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform sampler2D tDiffuse, tDepth, tFog; uniform mat4 invProj, camWorld; uniform float origin, size;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          float d = texture2D(tDepth, vUv).x;
          if (d >= 1.0) { gl_FragColor = c; return; }
          vec4 v = invProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
          vec3 w = (camWorld * vec4(v.xyz / v.w, 1.0)).xyz;
          vec2 uv = (vec2(w.x, -w.z) - origin) / size; // world z mirrors game z
          vec2 f = any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0))) ? vec2(0.0) : texture2D(tFog, uv).rg;
          vec3 grey = vec3(dot(c.rgb, vec3(0.299, 0.587, 0.114)));
          vec3 dark = mix(grey * 0.12, mix(grey, c.rgb, 0.35) * 0.45, f.g);
          gl_FragColor = vec4(mix(dark, c.rgb, f.r), c.a);
        }`,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  render(renderer, writeBuffer, readBuffer) {
    const u = this.material.uniforms;
    u.tDiffuse.value = readBuffer.texture; u.tDepth.value = this.colorPass.depth;
    u.invProj.value.copy(camera.projectionMatrixInverse); u.camWorld.value.copy(camera.matrixWorld);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
}

renderer.info.autoReset = false; // several passes per frame: the HUD counts all of them
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, {
  type: THREE.HalfFloatType, samples: 4, depthTexture: new THREE.DepthTexture(1, 1),
}));
composer.setPixelRatio(renderer.getPixelRatio());
composer.setSize(window.innerWidth, window.innerHeight);
const colorPass = new DepthRenderPass(scene, camera);
composer.addPass(colorPass);
const aoPass = new DepthGTAOPass(scene, camera, window.innerWidth, window.innerHeight, composer.readBuffer.depthTexture);
aoPass.updateGtaoMaterial({ radius: 3, distanceExponent: 1.5, thickness: 2, scale: 1.2, samples: 16 });
aoPass.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
aoPass.blendIntensity = 0.9;
composer.addPass(aoPass);
const fogPass = new FogPass(colorPass);
composer.addPass(fogPass);
composer.addPass(new OutputPass());

/**
 * Graphics quality (state.quality, kept in localStorage). Low (fast): device pixels at 1 per CSS pixel, no sun shadows,
 * no GTAO and no MSAA on the composer's targets (it still runs for fog of war), no grass, a hemisphere light in place
 * of the PMREM sky fill (its colours, at 0.6: the 1.1 the environment replaced read brighter than High without
 * shadows and GTAO; 0.6 matches High's mean frame brightness), the plain water shader (waterLow), and units far away
 * or out of view re-posed every LOW_ANIM_EVERY frames (animHeld). The Overlays checkboxes keep their values for High.
 */
const SKY_ENV = scene.environment;
const lowFill = new THREE.HemisphereLight(0xc8d8f8, 0x6b6a50, 0.6);
function applyQuality(q) {
  const low = q === 'low';
  state.quality = q;
  localStorage.setItem('rv3d.quality', q);
  const dpr = low ? 1 : Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(dpr); composer.setPixelRatio(dpr);
  for (const rt of [composer.renderTarget1, composer.renderTarget2]) if (rt.samples !== (low ? 0 : 4)) { rt.samples = low ? 0 : 4; rt.dispose(); }
  renderer.setSize(window.innerWidth, window.innerHeight); composer.setSize(window.innerWidth, window.innerHeight);
  sun.castShadow = state.opt.shadows && !low;
  scene.environment = low ? null : SKY_ENV;
  waterLow.value = low ? 1 : 0;
  if (low) scene.add(lowFill); else scene.remove(lowFill);
  for (const id of ['optShadows', 'optAO', 'optGrass']) $(id).disabled = low;
  $('quality').value = q;
  trackBg = null;
}
$('quality').addEventListener('change', (ev) => applyQuality(ev.target.value));
applyQuality(localStorage.getItem('rv3d.quality') === 'low' ? 'low' : 'high');

let last = performance.now(), uiTimer = 0, fpsFrames = 0, fpsTimer = 0;
const frameMs = new Float64Array(240);
let frameSamples = 0;
/** Unit scale actually applied: the slider value at overview zoom, easing to true size (1×) up close when adaptive. */
function effectiveUnitScale() {
  if (!state.adaptiveScale) return state.unitScale;
  const k = THREE.MathUtils.smoothstep(camera.position.distanceTo(controls.target), ADAPT_NEAR, ADAPT_FAR);
  return 1 + (state.unitScale - 1) * k;
}
function frame(now) {
  requestAnimationFrame(frame);
  const rawDt = (now - last) / 1000, dt = Math.min(0.1, rawDt);
  last = now;
  if (state.playing) {
    state.t = clockTime(now);
    if (state.t >= R.t1) setPlaying(false);
  }
  const t = state.t;
  // Wall-clock motion while paused: OrbitControls damping, WASD/QE and follow easing.
  // The only deferred scene work is fog's scrub debounce; retry until its time catches up.
  // Toast expiry/fades, sacred-site blinking and kill-feed highlights use DOM timers/CSS:
  // they continue independently of WebGL. Wind, water, FX and poses use replay time.
  updateCamera(dt);
  const fogPending = state.vision && (!Number.isFinite(fog.t) || Math.abs(t - fog.t) >= FOG_EVERY);
  if (!state.playing && !dirty && !fogPending) return;
  const wasDirty = dirty;
  dirty = false;
  state.scaleNow = effectiveUnitScale();
  R.updateFrame(t);
  VIEW.hoveredUnitId = state.hovered?.id ?? null;
  if (selSynced !== selVer) { // the controller's selection follows the viewer's set (units only: map objects have no id)
    selSynced = selVer;
    VIEW.select([...selection].filter((e) => !e.gaia && e.id != null).map((e) => e.id));
  }
  VIEW.frame(t);
  updateEntities(t);
  gaia.update(t, dt);
  fillers.update(t); // after both: it reads the shown walls and the standing map objects
  eyes.update(t);
  terrain.wear.update(t);
  updateSky(t);
  fitShadow();
  units.update(camera); // after every set() (updateEntities, gaia.update) and the shadow box it culls against
  grass.update();
  updateOverlays(t);
  updateHover();
  fog.update(t, state.vision);
  const ao = state.opt.ao && state.quality !== 'low';
  fogPass.enabled = !!state.vision; aoPass.enabled = ao;
  renderer.info.reset();
  if (ao || state.vision) composer.render(dt); else renderer.render(scene, camera);
  frameNo++;
  amtLabels.update(window.innerWidth, window.innerHeight);
  unitLabels.update(state.opt.labels, t, window.innerWidth, window.innerHeight, _v, worldPerPx);
  drawTrack();
  raidToasts.update(t); // every frame: it skips steps longer than playback makes (seeks)

  uiTimer += rawDt;
  if (wasDirty || uiTimer > 0.12) {
    uiTimer = 0;
    $('clock').textContent = fmtTime(t);
    $('scaleVal').textContent = `${state.scaleNow.toFixed(2)}×`;
    $('time').textContent = `${fmtTime(t)} / ${fmtTime(R.t1)}`;
    for (const idx of R.players.keys()) $(`age${idx}`).textContent = ROMAN[R.ageOf(idx, t)];
    victory.update(t);
    syncPov();
    renderPlayers(t, state.playing);
    renderEco(t, false);
    if (fightPanel && !$('fightBox').hidden && $('fightBox').open) fightPanel.setTime(t);
    if (selection.size > 1) pruneSelection();
    renderInspector();
    armyComp.update(state.opt.comp, t, _v);
    const live = {};
    for (const e of R.ents) if (e.on) live[e.cat] = (live[e.cat] ?? 0) + 1;
    for (const n of document.querySelectorAll('[data-n]')) n.textContent = live[n.dataset.n] ?? 0;
  }
  fpsFrames++;
  fpsTimer += rawDt;
  frameMs[frameSamples++ % frameMs.length] = rawDt * 1000;
  if (fpsTimer > 0.5) {
    const samples = frameMs.slice(0, Math.min(frameSamples, frameMs.length)).sort();
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
    $('fps').textContent = `${Math.round(fpsFrames / fpsTimer)} fps · p95 ${p95.toFixed(1)} ms · ${renderer.info.render.calls} draws · ${(renderer.info.render.triangles / 1e6).toFixed(2)}M tris`;
    fpsFrames = 0; fpsTimer = 0;
  }
}

// start at the linked time, else the first moment both town centres stand, framed on the whole arena
seek(LINK.time ?? R.t0);
if (moments && LINK.moment != null) moments.show(LINK.moment - 1);
requestAnimationFrame(frame);

// debug/automation handle (console: viewer.seek(300), viewer.select(viewer.R.byId.get(id)))
window.viewer = { R, M2, VIEW, marks, combatFx, moments, state, seek, select, selection, setSelection, selectIds, setPlaying, setSpeed, focusOn, camera, controls, assets, renderer, composer, aoPass, fog, fogPass, scene, sun, terrain, grass, units, gaia, fillers, JOBS, victory, raidToasts };
