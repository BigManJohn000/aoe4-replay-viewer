// AoE4 animation library baker: Havok `.rhka` archetypes → `assets/anims/<archetype>.glb` + `assets/anims/index.json`.
//
//   node tools/havok/bake-anims.mjs          map catalog blueprints → archetypes, bake every used archetype
//   node tools/havok/bake-anims.mjs --dry    print the mapping table and selected clips, write nothing
//
// Inputs: assets/catalog.json (blueprints with skinned models), assets/combat.json (main weapon class/art → style),
// the unit GLBs (joint names), Attrib rgds (decoded through the Essence CLI into the shared rgd cache
// `%RV_CACHE%/rgd`, same file names as tools/build-assets.mjs) and the archetype `.rhka` files under
// <AOE4_EXTRACTED>/ArtCivilizations/art/civilizations/common/{humans,animals}/archetypes/ (the toolchain root is
// AOE4_REBUILD, see ../toolchain.mjs). Rerun after any
// `build-assets.mjs` run that adds animated blueprints; a new archetype needs a SPEC entry below (the bake warns).
//
// Blueprint → archetype chain (all from Attrib): ebps entity_blueprint_ext/animator_attachments names an attachment
// list whose `parent_animator` is the archetype (`base`). Its `animation_attachment` entries and those of the ebps
// tier lists add archetypes: in the default inventory they are `extra` clip sets layered under the base (monk: base_monk
// + base_civilian; handcannon: base_archer + base_swordsman), per inventory category they are villager job overlays
// (`jobs`, keyed by the viewer's job: farm wood gold stone berry meat fish herd). All overlays share the base skeleton.
//
// Output GLB per archetype: the archetype skeleton as plain nodes named exactly like the unit GLB joints (lower case
// today, e.g. `metarig_pelvis`, `gaia_root`, `root_m`), one animation per selected clip named by the Havok clip path
// with `/` separators, LINEAR, one key per decoded frame (frames spread evenly over the clip's duration, 30 fps),
// local TRS straight from the decoder (predictive.mjs). Every clip drives every skeleton bone: channels that never
// change collapse to a single key (bones missing from a clip's own skeleton hold the archetype reference pose).
// Rotations are normalized int16 (glTF core; three's GLTFLoader dequantizes), translation/scale float32.
//
// index.json:
//   archetypes[name] = { file, bones, clips: { clip: { dur, frames, part?, move?, hit? } }, states: { state: [clip, ...] } }
//     part 'rider': the clip only moves rider bones of a combined horse rig (play it over a horse locomotion clip).
//     move: forward root motion over the clip (m; locomotion and stop clips), so a gait plays at speed / (move / dur).
//     hit: the strike moment (s) of attack/fire/throw clips — impact, release — from the motion (strikeTime).
//     States: idle guard walk jog run sprint stop attack aim fire reload throw flinch death dead work dropoff
//     carry_{idle,walk,run} tool_{idle,walk,run} heal convert mount dismount. A variant `state@key` overrides
//     `state` for a blueprint style (weapon) or villager job: look up `${state}@${style ?? job}`, then `state`.
//   blueprints[bp] = { base, extra?, jobs?: { job: archetype }, style? }; resolve a state in jobs[job] ?? base,
//     then in each `extra`.   unmapped = animated catalog blueprints without an archetype.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { readTagfile } from './tagfile.mjs';
import { sampleClip } from './predictive.mjs';
import { TOOLCHAIN, requireToolchain } from '../toolchain.mjs';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
requireToolchain({ extracted: true });
const CFG = {
  extracted: TOOLCHAIN.extracted,
  dotnet: TOOLCHAIN.dotnet,
  essence: TOOLCHAIN.essence,
  cache: process.env.RV_CACHE ?? path.join(os.tmpdir(), 'rv-asset-cache'),
  assets: path.join(PROJECT, 'assets'),
  dry: process.argv.includes('--dry'),
};
const OUT = path.join(CFG.assets, 'anims');
const ARCHETYPES = path.join(CFG.extracted, 'ArtCivilizations/art/civilizations/common');
const ATTRIB = path.join(CFG.extracted, 'Attrib', 'attrib');
/** Constant-channel tolerance (m, quaternion units, scale): below int16 rotation precision (1/32767). */
const EPS = 1e-5;

// ───────────────────────────── clip selection ─────────────────────────────
// Per archetype: state → Havok clip paths ('/' separators), a few cheap variants each. Names are checked against the
// .rhka at bake time. Deaths favour short falls (the viewer holds the last frame), idles the shorter loops.
const DEATHS = ['reaction/death_stab_front_01', 'reaction/death_slash_front_r2l_up_01', 'reaction/death_slash_front_l2r_down_01'];
const FLINCH = ['knockback/rec_knockback_front_01', 'knockback/rec_knockback_back_01'];
const STOPS = ['navigation/walk_to_idle_quick_01', 'navigation/run_to_idle_quick_01'];
/** Crossbow / repeater / arquebus hold their weapon in every pose: full locomotion + ranged sets per style. */
const rangedStyle = (key, dir, { idle, guard, walk, jog, run, sprint, fire = [`${dir}/fire_center_middle`], reload = [`${dir}/reload_center_middle`] }) => ({
  [`idle@${key}`]: idle, [`guard@${key}`]: guard, [`walk@${key}`]: walk, [`jog@${key}`]: jog, [`run@${key}`]: run,
  [`sprint@${key}`]: sprint, [`aim@${key}`]: [`${dir}/aim_center_middle`], [`fire@${key}`]: fire, [`reload@${key}`]: reload,
});
const CROSSBOW = {
  idle: ['crossbow/idle_calm_basic_03'], guard: ['crossbow/idle_tense_01'], walk: ['crossbow/walk_calm_f_01'],
  jog: ['crossbow/jog_calm_f_01'], run: ['crossbow/run_calm_f_02'], sprint: ['crossbow/sprint_calm_f_01'],
};
/** Villager job overlays: work stroke, carried-load and tool-in-hand locomotion, drop-off. */
const job = (work, carry, tool) => ({
  work, dropoff: ['shared/dropoff_inplace_01'],
  ...(carry && { carry_idle: carry[0], carry_walk: carry[1], carry_run: carry[2] }),
  ...(tool && { tool_idle: tool[0], tool_walk: tool[1], tool_run: tool[2] }),
});
const one = (...a) => a.map((c) => (c ? [c] : undefined));

const SPEC = {
  base_spearman: {
    idle: ['navigation/idle_calm_basic_07', 'navigation/idle_calm_basic_09'], guard: ['navigation/idle_tense_01'],
    walk: ['navigation/walk_calm_f_02', 'navigation/walk_calm_f_05'], jog: ['navigation/jog_calm_f_01', 'navigation/jog_calm_f_02'],
    run: ['navigation/run_calm_f_01'], sprint: ['navigation/sprint_calm_f_01'], stop: STOPS,
    attack: ['attack/stab_center_middle_01', 'attack/stab_center_middle_02'],
    'attack@swing': ['attack/attack_r2l_up_01', 'attack/attack_r2l_down_01'],
    throw: ['torch/fire_center_middle'], flinch: FLINCH, death: DEATHS,
  },
  base_archer: {
    idle: ['navigation/idle_calm_basic_05', 'navigation/idle_calm_basic_03'], guard: ['navigation/idle_tense_02'],
    walk: ['navigation/walk_calm_f_01', 'navigation/walk_calm_f_04'], jog: ['navigation/jog_calm_f_01', 'navigation/jog_calm_f_02'],
    run: ['navigation/run_calm_f_02'], sprint: ['navigation/sprint_calm_f_01'], stop: STOPS,
    attack: ['attack/attack_stab_01', 'attack/attack_r2l_down_01'],
    aim: ['ranged/aim_center_middle'], fire: ['ranged/fire_center_middle', 'ranged/fire_center_middle_01'],
    reload: ['ranged/reload_center_middle', 'ranged/reload_center_middle_01'],
    ...rangedStyle('crossbow', 'crossbow', CROSSBOW),
    ...rangedStyle('repeater', 'crossbow', { ...CROSSBOW, fire: ['repeater/fire_center_middle'] }),
    ...rangedStyle('arquebus', 'arquebus', {
      idle: ['arquebus/idle_calm_basic_01'], guard: ['arquebus/idle_tense_01'], walk: ['arquebus/walk_calm_f_01'],
      jog: ['arquebus/jog_calm_f_01'], run: ['arquebus/run_calm_f_01'], sprint: ['arquebus/sprint_calm_f_01'],
    }),
    'stop@arquebus': ['arquebus/walk_to_idle_quick_01'],
    // Grenadiers throw from the torch set; between throws they stand guard instead of drawing a bow.
    'aim@grenade': ['navigation/idle_tense_02'], 'fire@grenade': ['torch/fire_center_middle'], 'reload@grenade': ['navigation/idle_tense_02'],
    throw: ['torch/fire_center_middle'], flinch: FLINCH, death: DEATHS,
  },
  base_axe2h: {
    idle: ['navigation/idle_calm_basic_03', 'navigation/idle_calm_basic_02'], guard: ['navigation/idle_tense_01'],
    walk: ['navigation/walk_calm_f_01', 'navigation/walk_calm_f_04'], jog: ['navigation/jog_calm_f_01', 'navigation/jog_calm_f_02'],
    run: ['navigation/run_calm_f_01'], sprint: ['navigation/sprint_calm_f_01'], stop: STOPS,
    attack: ['attack/attack_r2l_down_01', 'attack/attack_r2l_down_02', 'attack/attack_r2l_up_03'],
    throw: ['torch/fire_center_middle'], flinch: FLINCH,
    death: ['reaction/death_slash_front_r2l_down_01', 'reaction/death_slash_front_l2r_down_01', 'reaction/death_stab_back_01'],
  },
  base_swordsman: {
    idle: ['navigation/idle_calm_basic_02'], guard: ['navigation/idle_tense_01'], walk: ['navigation/walk_calm_f_05'],
    jog: ['navigation/jog_calm_f_01'], run: ['navigation/run_calm_f_02'], sprint: ['navigation/sprint_calm_f_01'], stop: STOPS,
    attack: ['attack/attack_r2l_down_01', 'attack/attack_l2r_down_01', 'attack/attack_stab_01'],
    throw: ['torch/fire_center_middle'], flinch: FLINCH, death: DEATHS,
  },
  base_civilian: {
    idle: ['navigation/idles/idle_calm', 'navigation/idles/idle_calm_wipe_nose'], guard: ['navigation/idles/tense_idle_01'],
    walk: ['navigation/walks/calm_walk_01_f_fast_slide', 'navigation/walks/calm_walk_02_f_fast_slide'],
    jog: ['navigation/jogs/calm_jog_13_f', 'navigation/jogs/calm_jog_14_f'], run: ['navigation/runs/calm_run_01_f'],
    sprint: ['navigation/sprints/calm_sprint_02_f'],
    stop: ['navigation/transitions/calm_walk_to_stop_short_01', 'navigation/transitions/calm_run_to_stop_01'],
    attack: ['attack/slash_r2l_down_01', 'attack/slash_l2r_down_01', 'attack/stab_01'],
    aim: ['ranged/aim_center_middle'], fire: ['ranged/fire_center_middle'], reload: ['ranged/reload_center_middle'],
    throw: ['torch/fire_center_middle'], flinch: FLINCH,
    death: ['reaction/death_slash_front_static_01', 'reaction/death_slash_front_static_03', 'reaction/death_stab_back_01'],
    // Building has no overlay archetype: the hammer set lives in the base.
    ...job(['builder/builder_hammer_kneeling_01'], null,
      one('builder/builder_hammer_idle_01', 'builder/builder_hammer_walk_01_slide', 'builder/builder_hammer_jog_01')),
    dropoff: ['dropoff/dropoff_01'],
  },
  base_farmer: job(['sickle/harvesting_01', 'sickle/harvesting_02'],
    one('wheat/wheat_idle_01', 'wheat/wheat_walk_f_01_slide', 'wheat/wheat_jog_f_01'),
    one('sickle/idle_01', 'sickle/walk_f_01_slide', 'sickle/jog_f_01')),
  base_logger: job(['chopping/logger_axe_chop_tree_01', 'chopping/logger_axe_chop_tree_02'],
    one('wood/wood_idle_01', 'wood/wood_walk_01_slide', 'wood/wood_jog_01'),
    one('navigation/logger_axe_idle_01', 'navigation/logger_axe_walk_01_slide', 'navigation/logger_axe_jog_01')),
  base_miner: job(['mining/miner_hammer_ground_01'],
    one(undefined, 'carrying/carry_walk_01_slide', 'carrying/carry_jog_01'),
    one('mining/miner_hammer_idle_01', 'mining/miner_hammer_walk_01_slide', 'mining/miner_hammer_jog_01')),
  base_forager: job(['foraging/forager_berries_kneeling_01'],
    one('berry/berry_idle_01', 'berry/berry_walk_01_slide', 'berry/berry_jog_01')),
  base_butcher: {
    ...job(['killing/gathering_meat_01'], one('meat/meat_idle_01', 'meat/meat_walk_01_slide', 'meat/meat_jog_01')),
    'tool_idle@herd': ['navigation/shepherd_idle_01'], 'tool_walk@herd': ['navigation/shepherd_walk_01_slide'],
    'tool_run@herd': ['navigation/shepherd_jog_01'],
  },
  base_fisherman: job(['fishing/casting_01'],
    one('navigation/carry_fish_idle_01', 'navigation/carry_fish_walk_01', 'navigation/carry_fish_jog_01')),
  base_monk: {
    idle: ['navigation/monk_idle_01'], walk: ['navigation/monk_walk_01_slide'], jog: ['navigation/monk_jog_01'],
    run: ['navigation/monk_jog_01'], stop: ['navigation/monk_jog_to_stop_short_01'],
    heal: ['healing/healing_01'], convert: ['conversion/monk_conversion_01'],
    carry_idle: ['navigation/monk_relic_idle_01'], carry_walk: ['navigation/monk_relic_walk_01_slide'],
    carry_run: ['navigation/monk_relic_jog_01'],
  },
  base_horse_combined: {
    idle: ['calm_idle_weapons/idle_calm_01_checkers', 'calm_idle_weapons/idle_calm_02_checkers_b'],
    guard: ['tense_idle/tense_idle_long_01'],
    walk: ['walk_weapons/walk_f_01_dave', 'walk_weapons/walk_f_04_dave'], jog: ['trot_weapons/trot_f_02_cribber'],
    run: ['canter_weapon/canter_f_01_cribber', 'canter_weapon/canter_f_02_cribber'],
    sprint: ['gallop_weapons/gallop_f_01_cribber', 'gallop_weapons/gallop_f_03_dave'],
    stop: ['walk_weapons/walk_to_stop_short', 'canter_transitions_weapon/canter_to_stop_short'],
    attack: ['rider_sword_shield_attack/attack_forward_01', 'rider_sword_shield_attack/attack_forward_02'],
    'attack@spear': ['rider_spearman_attack/attack_forward_01', 'rider_spearman_attack/attack_forward_02'],
    'attack@pandao': ['rider_pandao/rider_swing', 'rider_pandao/rider_slam', 'rider_pandao/rider_jab'],
    'attack@mehter': ['mehter/drumming_01'],
    'guard@bow': ['rider_archer_idles/tense_idle_01'], 'aim@bow': ['rider_archer_aim/aim_straight'],
    'fire@bow': ['rider_archer_shoot/shoot_straight', 'rider_archer_shoot/shoot_left90', 'rider_archer_shoot/shoot_right90'],
    'reload@bow': ['rider_archer_reload/reload_straight'],
    throw: ['torch/attack_r_0'],
    flinch: ['rider_sword_shield_reaction/r_front_01', 'rider_sword_shield_reaction/l_front_01'],
    death: ['death/death_c', 'death/death_d'],
    // Mounted villagers dismount to work.
    mount: ['mount_dismount/mount'], dismount: ['mount_dismount/dismount'], dropoff: ['mount_dismount/resource_dropoff'],
    'work@build': ['mount_dismount/builder_hammer_kneeling'], 'work@farm': ['mount_dismount/harvesting_01'],
    'work@wood': ['mount_dismount/logger_axe_chop_tree_01'], 'work@gold': ['mount_dismount/dismounted_mining'],
    'work@stone': ['mount_dismount/dismounted_mining'], 'work@berry': ['mount_dismount/forager_berries_kneeling'],
    'work@meat': ['mount_dismount/gathering_meat'], 'work@fish': ['mount_dismount/casting'],
  },
  base_sheep: {
    idle: ['navigation/calm_idle_01'], walk: ['navigation/walk_01'], jog: ['navigation/trot_01'], run: ['navigation/run_01'],
    sprint: ['navigation/sprint_01'], stop: ['navigation/walk_to_stop_01'], death: ['reaction/death_01'],
    dead: ['reaction/sheep_death_pose_01'],
  },
  base_deer: {
    idle: ['navigation/deer_idle_02'], walk: ['navigation/deer_walk_01'], jog: ['navigation/deer_trot_01'],
    run: ['navigation/deer_run_01'], sprint: ['navigation/deer_sprint_01'], stop: ['navigation/deer_walk_to_idle_01'],
    death: ['reaction/deer_death_01'], dead: ['reaction/deer_death_pose_01'],
  },
  base_reindeer: {
    idle: ['navigation/reindeer_idle_02'], walk: ['navigation/reindeer_walk_01'], run: ['navigation/reindeer_sprint_02'],
    sprint: ['navigation/reindeer_sprint_01'], stop: ['navigation/reindeer_walk_to_idle_01'],
    death: ['reaction/reindeer_death_01'], dead: ['reaction/reindeer_death_pose_01'],
  },
  base_boar: {
    idle: ['navigation/boar_idle_01'], guard: ['navigation/boar_idle_tense_01'], walk: ['navigation/boar_walk_01'],
    jog: ['navigation/boar_trot_01'], run: ['navigation/boar_run_01'], sprint: ['navigation/boar_sprint_01'],
    stop: ['navigation/boar_walk_to_stop_01'], attack: ['attack/boar_attack_01', 'attack/boar_charge_attack_01'],
    death: ['reaction/boar_death_01'], dead: ['reaction/boar_death_pose_01'],
  },
  base_wolf: {
    idle: ['navigation/calm_idle_01'], guard: ['navigation/tense_idle_01'], walk: ['navigation/calm_walk_01'],
    jog: ['navigation/trot_01'], run: ['navigation/run_01'], sprint: ['navigation/sprint_01'], stop: ['navigation/walk_to_stop'],
    attack: ['attack/attack_center_01', 'attack/attack_right_01'], death: ['reaction/death_l2r'],
  },
  // ── melee infantry rigs: same state layout as base_spearman / base_swordsman, clips taken from each rig's own sets ──
  base_spearshield: {
    idle: ['navigation/idle_calm_basic_01', 'navigation/idle_calm_basic_02'], guard: ['navigation/idle_tense_01'],
    walk: ['navigation/walk_calm_f_01'], jog: ['navigation/jog_calm_f_01', 'navigation/jog_calm_f_02'],
    run: ['navigation/run_calm_f_01'], sprint: ['navigation/sprint_calm_f_01'], stop: STOPS,
    attack: ['attack/stab_center_middle_01'], throw: ['torch/fire_center_middle'], flinch: FLINCH, death: DEATHS,
  },
  base_heavy_spearman: {
    idle: ['navigation/idle_calm_basic_01', 'navigation/idle_calm_basic_02'], guard: ['navigation/idle_tense_01'],
    walk: ['navigation/walk_calm_f_01', 'navigation/walk_calm_f_02'], jog: ['navigation/jog_calm_f_01', 'navigation/jog_calm_f_02'],
    run: ['navigation/run_calm_f_01'], sprint: ['navigation/sprint_calm_f_01'], stop: STOPS,
    attack: ['attack/stab_center_middle_01', 'attack/stab_center_middle_02'],
    'attack@swing': ['attack/attack_r2l_up_01', 'attack/attack_r2l_down_01'],
    throw: ['torch/fire_center_middle'], flinch: FLINCH, death: DEATHS,
  },
  base_sword_2hand: {
    idle: ['navigation/idle_tense_01', 'navigation/idle_tense_03'], guard: ['navigation/idle_tense_02'],
    walk: ['navigation/walk_calm_f_01', 'navigation/walk_calm_f_02'], jog: ['navigation/jog_calm_f_01', 'navigation/jog_calm_f_02'],
    run: ['navigation/run_calm_f_01'], sprint: ['navigation/sprint_calm_f_01'], stop: STOPS,
    attack: ['attack/attack_r2l_down_01', 'attack/attack_l2r_down_01', 'attack/attack_stab_01'],
    throw: ['torch/fire_center_middle'], flinch: FLINCH,
    death: ['reaction/death_slash_front_r2l_up_01', 'reaction/death_slash_front_l2r_down_01'],
  },
  base_spearman_samurai: {
    idle: ['navigation/idle_calm_basic_01', 'navigation/idle_calm_basic_02'], guard: ['navigation/idle_tense_01'],
    walk: ['navigation/walk_calm_f_01', 'navigation/walk_calm_f_02'], jog: ['navigation/jog_calm_f_01', 'navigation/jog_calm_f_02'],
    run: ['navigation/run_calm_f_01'], sprint: ['navigation/sprint_calm_f_01'], stop: STOPS,
    attack: ['attack/attack_r2l_down_01', 'attack/attack_l2r_down_01'],
    throw: ['torch/fire_center_middle'], flinch: FLINCH, death: DEATHS,
  },
  base_sword_samurai: {
    idle: ['navigation/idle_calm_basic_01', 'navigation/idle_calm_basic_02'], guard: ['navigation/idle_tense_01'],
    walk: ['navigation/walk_calm_f_01'], jog: ['navigation/jog_calm_f_01', 'navigation/jog_calm_f_02'],
    run: ['navigation/run_calm_f_01'], sprint: ['navigation/sprint_calm_f_01'], stop: STOPS,
    attack: ['attack/attack_r2l_down_01', 'attack/attack_l2r_down_01', 'attack/attack_stab_01'],
    throw: ['torch/fire_center_middle'], flinch: FLINCH, death: DEATHS,
  },
  base_shaolin: {
    idle: ['navigation/monk_idle_01'], guard: ['navigation/monk_idle_tense_01'], walk: ['navigation/monk_walk_01_slide'],
    jog: ['navigation/monk_jog_01'], run: ['navigation/monk_run_tense_01'], sprint: ['navigation/monk_sprint_tense_01'],
    stop: ['navigation/monk_jog_to_stop_short_01'], attack: ['attack/attack_r2l_down_01', 'attack/attack_l2r_down_01'],
    heal: ['healing/healing_01'], convert: ['conversion/monk_conversion_01'], death: DEATHS,
    carry_idle: ['navigation/monk_relic_idle_01'], carry_walk: ['navigation/monk_relic_walk_01_slide'],
    carry_run: ['navigation/monk_relic_jog_01'],
  },
  // ── elephants: the combined rig carries rider + mount; the tower archer rig only animates the crew ──
  base_elephant_combined: {
    idle: ['navigation/idle_01', 'navigation/idle_02'], guard: ['navigation/tense_idle_01'], walk: ['navigation/walk_01'],
    jog: ['navigation/trot_01'], run: ['navigation/run_01'], sprint: ['navigation/sprint_01'],
    stop: ['navigation/walk_to_idle_short_01', 'navigation/run_to_idle_short_01'],
    attack: ['attacks/attack_01', 'attacks/attack_02'], flinch: ['reaction/rec_r_01', 'reaction/rec_l_01'], death: ['reaction/death_01'],
  },
  base_elephant_spearman: {
    idle: ['navigation/idle_01', 'navigation/idle_02'], guard: ['navigation/idle_tense_01'], walk: ['navigation/walk_01'],
    jog: ['navigation/trot_01'], run: ['navigation/run_01'], sprint: ['navigation/sprint_01'],
    stop: ['navigation/walk_to_idle_short_01', 'navigation/run_to_idle_short_01'],
    attack: ['attacks/attack_01', 'attacks/attack_02'], flinch: ['reaction/rec_front_01', 'reaction/rec_l_01'],
    death: ['reaction/death_01', 'reaction/death_02'],
  },
  base_elephant_archer: {
    idle: ['navigation/idle_calm_basic_01', 'navigation/idle_calm_basic_02'], guard: ['navigation/idle_tense_01'],
    aim: ['ranged/aim_center_middle'], fire: ['ranged/fire_center_middle'], reload: ['ranged/reload_center_middle'],
    flinch: ['reaction/rec_stab_front_01'], death: ['reaction/death_01'],
  },
  // ── camels: horse-style combined rig (rider + mount); bow riders take the shoot/aim/reload sets ──
  base_camel_combined: {
    idle: ['calm_idle_weapons/idle_calm_02_checkers_a', 'calm_idle_weapons/idle_head_nod_01_soldier_a'],
    guard: ['tense_idle/tense_idle_01'], walk: ['walk_weapons/walk_f_02', 'walk/walk_camel_01'],
    jog: ['trot_weapons/d1_trot_f_06_dave'], run: ['canter_weapon/canter_f_06_cribber'],
    sprint: ['charge/canter_f_06_cribber_charging'],
    stop: ['walk_weapons/walk_to_stop_short', 'trot_weapons/trot_to_stop_short'],
    attack: ['attack/attack_forward_01', 'attack/attack_forward_02'],
    'guard@bow': ['tense_idle/tense_idle_01'], 'aim@bow': ['aim/aim_straight'], 'fire@bow': ['shoot/shoot_straight'],
    'reload@bow': ['reload/reload_straight'],
    throw: ['torch/attack_r_0'], flinch: ['reaction/r_front_01', 'reaction/l_front_01'], death: ['death/death_fallright'],
  },
  // ── gaia animals ──
  base_cattle: {
    idle: ['navigation/idle_01', 'navigation/idle_02'], walk: ['navigation/walk_01'], jog: ['navigation/trot_01'],
    run: ['navigation/run_01'], sprint: ['navigation/sprint_01'], stop: ['navigation/walk_to_stop_01'],
    death: ['reaction/death_01'], dead: ['reaction/death_pose_01'],
  },
  base_bigcat: {
    idle: ['navigation/calm_idle_01'], guard: ['navigation/tense_idle_01'], walk: ['navigation/calm_walk_01'],
    jog: ['navigation/trot_01'], run: ['navigation/sprint_01'], sprint: ['navigation/sprint_01'],
    attack: ['attack/attack_center_01', 'attack/attack_right_01'], death: ['reaction/death_l2r'],
  },
  base_crocodile: {
    idle: ['navigation/calm_idle_01'], guard: ['navigation/tense_idle_01'], walk: ['navigation/calm_walk_01'],
    jog: ['navigation/trot_01'], run: ['navigation/sprint_01'], sprint: ['navigation/sprint_01'], stop: ['navigation/walk_to_stop'],
    attack: ['attack/attack_center_01', 'attack/attack_left_01'], death: ['reaction/death_l2r'],
  },
  base_fox: {
    idle: ['navigation/calm_idle_01'], guard: ['navigation/tense_idle_01'], walk: ['navigation/calm_walk_01'],
    jog: ['navigation/trot_01'], run: ['navigation/run_01'], sprint: ['navigation/sprint_01'], stop: ['navigation/walk_to_stop'],
    attack: ['attack/attack_center_01', 'attack/attack_right_01'], death: ['reaction/death_l2r'],
  },
  base_horse_gaia: {
    idle: ['navigation/horse_calm_idle_01'], guard: ['navigation/horse_tense_idle_01'], walk: ['navigation/horse_calm_walk_01'],
    jog: ['navigation/horse_trot_01'], run: ['navigation/horse_sprint_01'], sprint: ['navigation/horse_sprint_01'],
    stop: ['navigation/horse_walk_to_stop'], death: ['reaction/horse_death_01'], dead: ['reaction/horse_death_pose_01'],
  },
  base_land_monster: {
    idle: ['navigation/idles/idle_calm'], walk: ['navigation/walks/calm_walk_01'], jog: ['navigation/jogs/calm_jog_01'],
    run: ['navigation/jogs/calm_jog_01'], stop: ['navigation/transitions/calm_walk_to_stop_01'],
  },
  base_reindeer_combined: {
    idle: ['idle_calm_01_checkers'], walk: ['walk_f_01_cribber'], jog: ['trot_f_02_cribber'], run: ['trot_f_22_checkers'],
    death: ['death_b'],
  },
  base_water_monster: { idle: ['idle_01'], walk: ['swim_01'], jog: ['swim_01'], run: ['swim_01'] },
};

/** Villager inventory category → viewer job key (only categories carrying an animation overlay matter). */
const JOB_OF = [[/wheat|seed|sickle|scythe/, 'farm'], [/wood|axe_2hand/, 'wood'], [/gold/, 'gold'], [/stone/, 'stone'],
  [/berr|forage/, 'berry'], [/meat|knife/, 'meat'], [/fish/, 'fish'], [/herd/, 'herd']];

/** Main weapon (combat.json) → state variant key, per archetype family; undefined = the archetype's default set. */
function styleOf(base, w) {
  if (!w) return undefined;
  const art = w.art ?? '';
  if (base === 'base_horse_combined') {
    if (/mehter/.test(w.pbg)) return 'mehter';
    if (w.class === 'cdn_bow') return 'bow';
    if (w.class === 'cdn_1h_spear') return 'spear';
    if (/podao|pandao/.test(art)) return 'pandao';
    return undefined;
  }
  if (base === 'base_camel_combined') return w.class === 'cdn_bow' ? 'bow' : undefined;
  if (base === 'base_archer') {
    if (w.class === 'cdn_crossbow') return /repeat/.test(art) ? 'repeater' : 'crossbow';
    if (w.class === 'cdn_handcannon') return /arquebus/.test(art) ? 'arquebus' : undefined;
    return /grenade/.test(art) ? 'grenade' : undefined;
  }
  if (base === 'base_spearman') return /spear/.test(w.class) ? undefined : 'swing';
  return undefined;
}

// ───────────────────────────── Attrib (rgd) ─────────────────────────────
const slug = (s) => s.replace(/[\\/:]+/g, '__');
const leaf = (art) => art.split('\\').pop();
function walkFiles(root, rel = '', out = []) {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walkFiles(root, r, out); else if (r.endsWith('.rgd')) out.push(r);
  }
  return out;
}
let attribIndex = null; // stem → [rel]
function attribFind(stem, prefix) {
  if (!attribIndex) {
    attribIndex = new Map();
    for (const rel of walkFiles(ATTRIB)) {
      const s = path.posix.basename(rel, '.rgd');
      if (!attribIndex.has(s)) attribIndex.set(s, []);
      attribIndex.get(s).push(rel);
    }
  }
  return (attribIndex.get(stem) ?? []).find((r) => r.startsWith(prefix)) ?? null;
}
/** Decoded rgd tree ('default' table), cached as JSON exactly where build-assets.mjs caches it. */
function rgd(rel) {
  const out = path.join(CFG.cache, 'rgd', `${slug(rel)}.json`);
  if (!fs.existsSync(out)) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const r = spawnSync(CFG.dotnet, [CFG.essence, 'rgd-decode', '-f', 'json', path.join(ATTRIB, rel), out],
      { env: { ...process.env, DOTNET_ROLL_FORWARD: 'Major' }, windowsHide: true, encoding: 'utf8' });
    if (!fs.existsSync(out)) throw new Error(`rgd-decode ${rel} failed:\n${(r.stdout + r.stderr).slice(-500)}`);
  }
  return JSON.parse(fs.readFileSync(out, 'utf8')).data.find((n) => n.key === 'default')?.value ?? [];
}
function flat(nodes, prefix = '', out = []) {
  for (const n of nodes) {
    const p = `${prefix}/${n.key}`;
    if (Array.isArray(n.value)) flat(n.value, p, out); else out.push([p, n.value]);
  }
  return out;
}

/** Attachment list → { parent: archetype|null, anims: [{ inv, arch }] } from parent_animator and animation_attachments. */
function animList(stem) {
  const rel = stem && attribFind(stem, 'attachments/');
  if (!rel) return { parent: null, anims: [] };
  const node = rgd(rel).find((n) => n.key === 'attachment_lists')?.value ?? [];
  const parent = node.find((n) => n.key === 'parent_animator')?.value;
  const anims = [];
  for (const entry of node.find((n) => n.key === 'attachment_lists')?.value ?? []) {
    if (entry.key !== 'attachment_list') continue;
    const fl = flat(entry.value);
    const inv = fl.find(([p]) => p.endsWith('/inventory_category'))?.[1] || 'default';
    for (const [p, v] of fl) if (p.endsWith('/animation_attachment/animator') && /\\archetypes\\/.test(v)) anims.push({ inv, arch: leaf(v) });
  }
  return { parent: parent && /\\archetypes\\/.test(parent) ? leaf(parent) : null, anims };
}

/** Blueprint (ebps rel) → { base, extra?, jobs? } or null when no list names an archetype. */
function resolveBlueprint(ebps) {
  const fl = flat(rgd(ebps));
  const main = fl.find(([p]) => p.endsWith('/entity_blueprint_ext/animator_attachments/$PBGNAME'))?.[1];
  const tiers = fl.filter(([p, v]) => p.endsWith('/tier_ext/tier_group_list/tier_group/tier/attachments/$PBGNAME') && v).map(([, v]) => v);
  const lists = [main, ...tiers].map(animList);
  const base = lists.find((l) => l.parent)?.parent;
  if (!base) return null;
  const extra = [], jobs = {};
  for (const { inv, arch } of lists.flatMap((l) => l.anims)) {
    if (arch === base) continue;
    if (inv === 'default') { if (!extra.includes(arch)) extra.push(arch); continue; }
    const key = JOB_OF.find(([re]) => re.test(inv))?.[1];
    if (key && !jobs[key]) jobs[key] = arch;
  }
  return { base, ...(extra.length && { extra }), ...(Object.keys(jobs).length && { jobs }) };
}

// ───────────────────────────── rigs ─────────────────────────────
function rhkaPath(name) {
  for (const kind of ['humans', 'animals']) {
    const f = path.join(ARCHETYPES, kind, 'archetypes', name, `${name}.rhka`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}
/** Joint node names of a skinned GLB (JSON chunk only). */
function glbJoints(file) {
  const b = fs.readFileSync(file);
  const gl = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString());
  return (gl.skins ?? []).flatMap((s) => s.joints.map((i) => gl.nodes[i].name));
}

// ───────────────────────────── bake ─────────────────────────────
/** Max abs difference of each frame's n-vector from frame 0. */
function spread(v, n) {
  let m = 0;
  for (let i = n; i < v.length; i++) m = Math.max(m, Math.abs(v[i] - v[i % n]));
  return m;
}

/** Forward root motion over a clip (m, extracted motion), or undefined for in-place clips. */
function rootMove(entry) {
  const s = entry.animationBinding.animation.extractedMotion?.referenceFrameSamples;
  const z = s?.length ? +s[s.length - 1][2] : 0;
  return z > 0.01 ? +z.toFixed(3) : undefined;
}

/**
 * The strike moment of an attack/fire/throw clip (s): the frame where the striking joint (right palm; the head for
 * beasts) moves fastest in model space, which is the impact of a thrust or cut, the release of a shot or throw. The
 * clips carry no event annotations (only foot strikes), so the motion itself tells.
 */
function strikeTime(s, sk, bones, own) {
  let j = bones.indexOf('metarig_rarmpalm');
  if (j < 0) j = bones.indexOf('head_m');
  if (j < 0) return undefined;
  const chain = [];
  for (let i = j; i >= 0; i = sk.parentIndices[i]) chain.push(i);
  const nB = s.bones.length, P = new Float64Array(s.frames * 3);
  for (let f = 0; f < s.frames; f++) {
    let x = 0, y = 0, z = 0;
    for (const i of chain) { // p ← T + R·(S∘p), from the striking joint up to the root
      const k = own.get(bones[i]), rp = sk.referencePose[i], o = (f * nB + k) * 10;
      const t = k === undefined ? rp.translation : s.data.subarray(o, o + 3);
      const q = k === undefined ? rp.rotation : s.data.subarray(o + 3, o + 7);
      const sc = k === undefined ? rp.scale : s.data.subarray(o + 7, o + 10);
      const px = x * sc[0], py = y * sc[1], pz = z * sc[2], [qx, qy, qz, qw] = q;
      const cx = qy * pz - qz * py, cy = qz * px - qx * pz, cz = qx * py - qy * px; // v + 2w(q×v) + 2q×(q×v)
      x = px + 2 * (qw * cx + qy * cz - qz * cy) + t[0];
      y = py + 2 * (qw * cy + qz * cx - qx * cz) + t[1];
      z = pz + 2 * (qw * cz + qx * cy - qy * cx) + t[2];
    }
    P.set([x, y, z], f * 3);
  }
  let best = 0, at = 0;
  for (let f = 1; f + 1 < s.frames; f++) {
    const v = Math.hypot(P[f * 3 + 3] - P[f * 3 - 3], P[f * 3 + 4] - P[f * 3 - 2], P[f * 3 + 5] - P[f * 3 - 1]);
    if (v > best) { best = v; at = f; }
  }
  return +((at * s.duration) / (s.frames - 1)).toFixed(4);
}

/**
 * Bake one archetype: { glb: Uint8Array, clips: {name: {dur, frames, part?, move?, hit?}}, bones, rawBytes, f32Bytes }.
 * `names` maps lower-case Havok bone names to unit GLB joint names; `strikes` = clips that get a `hit` (strikeTime).
 */
function bakeArchetype(arch, clipNames, names, strikes) {
  const entries = readTagfile(fs.readFileSync(rhkaPath(arch))).root().animations;
  // Hierarchy from the skeleton most clips share (a few clips carry a sibling rig with extra/missing sockets).
  const bySkel = new Map();
  for (const e of entries) { const k = e.skeleton.bones.map((b) => b.name).join(','); bySkel.set(k, [...(bySkel.get(k) ?? []), e]); }
  const sk = [...bySkel.values()].sort((a, b) => b.length - a.length)[0][0].skeleton;
  const bones = sk.bones.map((b) => b.name.toLowerCase());
  const boneIndex = new Map(bones.map((b, i) => [b, i]));

  const doc = new Document();
  const buffer = doc.createBuffer();
  const nodes = bones.map((b, i) => {
    const rp = sk.referencePose[i];
    return doc.createNode(names.get(b) ?? b).setTranslation([...rp.translation.slice(0, 3)])
      .setRotation([...rp.rotation.slice(0, 4)]).setScale([...rp.scale.slice(0, 3)]);
  });
  const scene = doc.createScene(arch).setExtras({ rv: { archetype: arch } });
  sk.parentIndices.forEach((p, i) => (p < 0 ? scene.addChild(nodes[i]) : nodes[p].addChild(nodes[i])));

  const acc = (type, array, normalized = false) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer).setNormalized(normalized);
  const constTime = acc('SCALAR', new Float32Array([0]));
  // Single-key outputs repeat across clips (unit scale, reference-pose sockets): one accessor per distinct value keeps
  // the JSON chunk, which dominates for thousands of tiny channels, from doubling the file.
  const constCache = new Map();
  const output = (rotation, keys, still) => {
    const array = rotation ? Int16Array.from(keys, (x) => Math.round(Math.max(-1, Math.min(1, x)) * 32767)) : Float32Array.from(keys);
    if (!still) return acc(rotation ? 'VEC4' : 'VEC3', array, rotation);
    const k = `${rotation}:${array.join(',')}`;
    if (!constCache.has(k)) constCache.set(k, acc(rotation ? 'VEC4' : 'VEC3', array, rotation));
    return constCache.get(k);
  };
  const timeCache = new Map();
  const times = (frames, dur) => {
    const k = `${frames}:${dur}`;
    if (!timeCache.has(k)) timeCache.set(k, acc('SCALAR', Float32Array.from({ length: frames }, (_, f) => (f * dur) / (frames - 1))));
    return timeCache.get(k);
  };
  const isHorse = bones.some((b) => b.startsWith('gaia_'));
  const clips = {};
  let rawBytes = 0, f32Bytes = 0;
  for (const name of clipNames) {
    const entry = entries.find((e) => e.name === name.replace(/\//g, '\\'));
    if (!entry) throw new Error(`${arch}: no clip ${name} (fix SPEC; list clips with extract-clips.mjs --list ${arch})`);
    const s = sampleClip(entry);
    const nB = s.bones.length;
    rawBytes += s.frames * bones.length * 10 * 4;
    const anim = doc.createAnimation(name);
    const input = times(s.frames, s.duration);
    let movedHorse = false, movedRider = false;
    const own = new Map(s.bones.map((b, k) => [b, k]));
    bones.forEach((b, i) => {
      const k = own.get(b);
      const rp = sk.referencePose[i];
      const T = new Float32Array(s.frames * 3), R = new Float32Array(s.frames * 4), S = new Float32Array(s.frames * 3);
      for (let f = 0; f < s.frames; f++) {
        const o = (f * nB + k) * 10;
        if (k === undefined) { T.set(rp.translation.slice(0, 3), f * 3); R.set(rp.rotation.slice(0, 4), f * 4); S.set(rp.scale.slice(0, 3), f * 3); continue; }
        T.set(s.data.subarray(o, o + 3), f * 3); R.set(s.data.subarray(o + 3, o + 7), f * 4); S.set(s.data.subarray(o + 7, o + 10), f * 3);
        // Keep consecutive keys in one hemisphere so LINEAR (slerp) never takes the long way round.
        if (f && R[f * 4] * R[f * 4 - 4] + R[f * 4 + 1] * R[f * 4 - 3] + R[f * 4 + 2] * R[f * 4 - 2] + R[f * 4 + 3] * R[f * 4 - 1] < 0) {
          for (let c = 0; c < 4; c++) R[f * 4 + c] = -R[f * 4 + c];
        }
      }
      let moved = false;
      for (const [pathName, v, n] of [['translation', T, 3], ['rotation', R, 4], ['scale', S, 3]]) {
        const still = spread(v, n) < EPS;
        moved ||= !still;
        const keys = still ? v.subarray(0, n) : v;
        f32Bytes += keys.length * 4;
        const out = output(pathName === 'rotation', keys, still);
        const sampler = doc.createAnimationSampler().setInput(still ? constTime : input).setOutput(out).setInterpolation('LINEAR');
        anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(nodes[i]).setTargetPath(pathName).setSampler(sampler));
      }
      if (moved) { if (b.startsWith('gaia_')) movedHorse = true; else if (b.startsWith('metarig_')) movedRider = true; }
    });
    f32Bytes += s.frames * 4;
    const move = rootMove(entry), hit = strikes.has(name) ? strikeTime(s, sk, bones, own) : undefined;
    clips[name] = {
      dur: +s.duration.toFixed(4), frames: s.frames, ...(isHorse && movedRider && !movedHorse && { part: 'rider' }),
      ...(move && { move }), ...(hit !== undefined && { hit }),
    };
  }
  return { doc, clips, bones: bones.length, rawBytes, f32Bytes, boneIndex };
}

// ───────────────────────────── main ─────────────────────────────
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(CFG.assets, f), 'utf8'));
const catalog = readJson('catalog.json');
const combat = readJson('combat.json').units ?? {};

/** Animated blueprints: any age model with skin joints. */
const animated = Object.entries(catalog.blueprints)
  .map(([bp, v]) => [bp, v, [...new Set(Object.values(v.ages).flat())].filter((m) => catalog.models[m]?.bones)])
  .filter(([, , models]) => models.length);

const blueprints = {}, unmapped = [], modelsOf = new Map();
for (const [bp, v, models] of animated) {
  const r = resolveBlueprint(v.ebps);
  if (!r) { unmapped.push(bp); continue; }
  const style = styleOf(r.base, combat[bp]?.main);
  blueprints[bp] = { ...r, ...(style && { style }) };
  for (const a of [r.base, ...(r.extra ?? []), ...Object.values(r.jobs ?? {})]) {
    if (!modelsOf.has(a)) modelsOf.set(a, new Set());
    for (const m of models) modelsOf.get(a).add(m);
  }
}

console.log('blueprint → archetype');
for (const [bp, r] of Object.entries(blueprints)) {
  const jobs = r.jobs ? Object.entries(r.jobs).map(([k, a]) => `${k}:${a}`).join(' ') : '';
  console.log(`  ${bp.padEnd(40)} ${r.base}${r.extra ? ` +${r.extra.join('+')}` : ''}${r.style ? ` @${r.style}` : ''}${jobs ? `  jobs ${jobs}` : ''}`);
}
if (unmapped.length) console.log(`no archetype: ${unmapped.join(', ')}`);

const archetypes = {};
let totalRaw = 0, totalF32 = 0, totalGlb = 0;
if (!CFG.dry) fs.mkdirSync(OUT, { recursive: true });
for (const [arch, models] of [...modelsOf].sort(([a], [b]) => a.localeCompare(b))) {
  const spec = SPEC[arch];
  if (!spec || !rhkaPath(arch)) { console.warn(`! ${arch}: ${spec ? 'no .rhka' : 'no SPEC entry'} — not baked`); continue; }
  const states = Object.fromEntries(Object.entries(spec).filter(([, c]) => c?.length));
  const clipNames = [...new Set(Object.values(states).flat())];
  // Unit GLB joint names (exact case) for every Havok bone; report bones the models lack.
  const names = new Map();
  const joints = [...models].map((m) => [m, glbJoints(path.join(PROJECT, catalog.models[m].file))]);
  for (const [, js] of joints) for (const j of js) names.set(j.toLowerCase(), j);
  if (CFG.dry) { console.log(`${arch}: ${clipNames.length} clips\n  ${Object.entries(states).map(([s, c]) => `${s}: ${c.join(' ')}`).join('\n  ')}`); continue; }

  const strikes = new Set(Object.entries(states).filter(([st]) => /^(attack|fire|throw)(@|$)/.test(st)).flatMap(([, c]) => c));
  const { doc, clips, bones, rawBytes, f32Bytes, boneIndex } = bakeArchetype(arch, clipNames, names, strikes);
  const coverage = joints.map(([m, js]) => {
    const lower = new Set(js.map((j) => j.toLowerCase()));
    const missing = [...boneIndex.keys()].filter((b) => !lower.has(b)).length;
    const unanimated = js.filter((j) => !boneIndex.has(j.toLowerCase()) && !/^rv(wpn|tool|gear)_/.test(j)).length;
    return missing || unanimated ? `${m} (${missing} rig bones absent, ${unanimated} joints unanimated)` : null;
  }).filter(Boolean);
  const file = `assets/anims/${arch}.glb`;
  const glb = await new NodeIO().writeBinary(doc);
  fs.writeFileSync(path.join(PROJECT, file), glb);
  archetypes[arch] = { file, bones, clips, states };
  totalRaw += rawBytes; totalF32 += f32Bytes; totalGlb += glb.byteLength;
  const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
  console.log(`${arch.padEnd(20)} ${String(bones).padStart(3)} bones ${String(clipNames.length).padStart(3)} clips  raw ${kb(rawBytes)}  collapsed f32 ${kb(f32Bytes)}  glb ${kb(glb.byteLength)}  models ${models.size}${coverage.length ? `\n    rig mismatch: ${coverage.join('; ')}` : ''}`);
}
if (!CFG.dry) {
  const index = { archetypes, blueprints, ...(unmapped.length && { unmapped }) };
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index));
  const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
  console.log(`total: raw ${mb(totalRaw)}, constant-collapsed float32 ${mb(totalF32)}, GLBs (int16 rotations) ${mb(totalGlb)}`);
}
