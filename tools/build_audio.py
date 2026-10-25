"""Build a local browser audio pack from the user's installed AoE4 (never modifies the game).
Run with the bundled Python after tools/setup_audio.ps1. Output is ignored game art.
Names come from shipped SoundbanksInfo.xml and speech archive paths, not guessed WEM IDs.
"""
from __future__ import annotations
import argparse, concurrent.futures, hashlib, json, os, re, struct, subprocess, tempfile
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
CUES = {
    'ui.click': r'sfx_ui_frontend_button\.wav$',
    'ui.select': r'sfx_ui_frontend_button\.wav$',
    'ui.open': r'sfx_ui_hud_ingame_radial_menu_open',
    'ui.close': r'sfx_ui_hud_ingame_radial_menu_close',
    'ui.victory': r'sfx_ui_screen_victory_01\.wav$',
    'ui.defeat': r'sfx_ui_screen_defeat_01\.wav$',
    'bow': r'sfx_attack_bow_recurve_\d', 'longbow': r'sfx_attack_bow_longbow_\d',
    'crossbow': r'sfx_attack_crossbow3_\d',
    'gun': r'sfx_weapons_hand_cannon_fire_close_\d',
    'sword': r'sfx_impacts_sword_broad_b_\d',
    'spear': r'sfx_impacts_shared_spear_hit_armor_plated_\d',
    'axe': r'sfx_impacts.*axe.*\d',
    'arrow.impact': r'sfx_arrow_hit_armor_\d',
    'bullet.impact': r'sfx_bullet_hit_metal_\d',
    'siege.mangonel': r'sfx_siege_.*(?:mangonel|catapult).*fire_\d',
    'siege.trebuchet': r'sfx_siege_attack_treb_cw_\d',
    'siege.cannon': r'sfx_weapons_cannon_fire_\d',
    'siege.springald': r'sfx_siege_.*springald.*fire_\d',
    'siege.ram': r'sfx_siege_attack_mechanics_\d',
    'siege.impact': r'sfx_siege_impact.*(?:boulder|stone).*\d',
    'fire': r'sfx_.*torch.*(?:throw|impact)',
    'death': r'sfx_foley_bodyfall_chainmail_soft_\d',
    'death.horse': r'sfx_horse_foley_bodyfall_long_\d',
    'death.ship': r'sfx_naval_ship_death_lrg_\d',
    'death.building': r'sfx_destruction_stone_.*\d',
    'move.foot': r'sfx_fol_fts_robe_dirt_\d',
    'move.horse': r'sfx_fol_footsteps_horse_trot_grass_\d',
    'move.siege': r'sfx_siege_movement_mangonel_dirt_\d',
    'work.wood': r'sfx_foley_shared_villager_logging_\d',
    'work.gold': r'sfx_foley_shared_villager_mining_impacts_gold_\d',
    'work.stone': r'sfx_foley_shared_villager_mining_impacts_stone_\d',
    'work.build': r'sfx_fol_shared_villager_building_hammer_wood_\d',
    'work.food': r'sfx_.*(?:farm|harvest|forag).*\d',
    'heal': r'sfx_monk_healing_start_\d',
    'convert': r'sfx_monk_conversion_cast\.wav$',
    'convert.buildup': r'sfx_monk_conversion_buildup\.wav$',
    'convert.voice': r'crd_sfx_ability_wololo_01\.wav$',
    'converted': r'sfx_monk_conversion_converted.*\.wav$',
    'relic.pickup': r'sfx_ui_relic_pickup_positive\.wav$',
    'relic.select': r'sfx_ui_relic_selection\.wav$',
    'building.complete': r'sfx_ui_shared_building_complete_medium',
    'research': r'sfx_ui_unit_upgrade_click\.wav$',
    'age': r'sfx_ui_age_up_ready',
    'alert': r'sfx_ui_shared_attack_horn_under_attack_scripted',
    'animal.sheep': r'sfx_animals_neutral_sheep_.*(?:idle|baa|bleat)',
    'water': r'sfx_ambs_environment_point_source_river_small_\d',
}
ARCHIVES = ['Abbasid','Byzantine','Chinese','English','French','HRE','Japanese','Malian','Mongols','Ottoman','Rus','Sultanate']

def run(args):
    p = subprocess.run([str(x) for x in args], capture_output=True, text=True, env={**os.environ, 'DOTNET_ROLL_FORWARD': 'Major'})
    if p.returncode: raise RuntimeError(p.stderr[-1200:] or p.stdout[-1200:])
    return p.stdout

def bank_index(p):
    """Wwise DIDX gives IDs in the same order as vgmstream's one-based subsongs."""
    out = {}
    with p.open('rb') as f:
        while header := f.read(8):
            if len(header) != 8: raise ValueError(f'truncated bank {p}')
            tag, size = struct.unpack('<4sI', header)
            if tag == b'DIDX':
                data = f.read(size)
                if size % 12: raise ValueError(f'invalid DIDX {p}')
                for i in range(0, size, 12): out[str(struct.unpack_from('<I', data, i)[0])] = i // 12 + 1
            else: f.seek(size, 1)
    return out

def build(args):
    game = Path(args.game_dir) / 'cardinal'
    work = Path(args.tools_dir); out = Path(args.output); out.mkdir(parents=True, exist_ok=True)
    vgm = work / 'vgmstream/vgmstream-cli.exe'; ffmpeg = work / 'ffmpeg/package/ffmpeg.exe'
    if not vgm.exists() or not ffmpeg.exists(): raise SystemExit('Run tools/setup_audio.ps1 first')
    metadata = ET.parse(game / 'audiohigh/SoundbanksInfo.xml').getroot()
    media = {e.attrib['Id']: e.findtext('ShortName') for e in metadata.findall('.//Media/File') if e.attrib.get('Language') == 'SFX'}
    banks = {}
    for folder in ['audiohigh', 'audio']:
        for p in (game / folder).glob('*.bnk'):
            for id, sub in bank_index(p).items(): banks.setdefault(id, (p, sub))
    def source(id):
        for folder in ['audiohigh', 'audio']:
            p = game / folder / 'Media' / (id + '.wem')
            if p.exists(): return p, None
        return banks.get(id)
    candidates = sorted([(id, name, source(id)) for id, name in media.items()], key=lambda x: x[1].lower())
    groups = {}; missing = []
    def group(key, rows, limit=4):
        chosen = [r for r in rows if r[2]][:limit]
        if chosen: groups[key] = chosen
        else: missing.append(key)
    for key, pattern in CUES.items(): group(key, [r for r in candidates if re.search(pattern, r[1], re.I)])
    for name in ['town_center','infantry','ranged','cavalry','siege','house','keep','landmark','market','mining','monastery','mosque','outpost','farm','food','wood','university','wonder','blacksmith']:
        group('select.' + name, [r for r in candidates if re.search(r'sfx_ui_' + name + r'_building_selection(?:_\d+)?\.wav$', r[1], re.I)], 1)
    # Original fully mixed music segments, grouped by civilization, age and intensity.
    music = {}
    for row in candidates:
        m = re.search(r'mus_([a-z]+)_age([1-4])_(?:\d_)?seg_[a-d]_(exp|com)\.wav$', row[1], re.I)
        if m: music.setdefault('music.' + '.'.join(m.groups()).lower(), []).append(row)
    for key, rows in music.items(): group(key, rows, 2)
    # The bank itself supplies the biome name. Prefer a front/near bed over surround/distant layers.
    for b in metadata.findall('./SoundBanks/SoundBank'):
        name = b.findtext('ShortName') or ''
        if not name.startswith('card_media_env_biome_'): continue
        biome = name.removeprefix('card_media_env_biome_').lower()
        ids = {e.attrib['Id'] for e in b.findall('./Media/File')}
        rows = [r for r in candidates if r[0] in ids and re.search(r'(plateau|shroud).*front_near', r[1], re.I)]
        if not rows: rows = [r for r in candidates if r[0] in ids and re.search('front_near', r[1], re.I)]
        group('ambience.' + biome, rows, 2)
    # Civ voice filenames preserve unit, context, intensity and culture/age tokens.
    rebuild = Path(os.environ.get('AOE4_REBUILD', ROOT / 'toolchain'))
    wanted = ARCHIVES if args.civs == 'all' else args.civs.split(',')
    for civ in wanted:
        folder = work / 'speech' / civ
        marker = folder / '.complete'
        if not marker.exists():
            print(f'Extracting speech {civ}', flush=True)
            run([rebuild/'tools/dotnet/dotnet.exe', rebuild/'tools/essence/AOEMods.Essence.CLI.dll', 'sga-unpack', game/'archives'/f'SoundSpeech{civ}.sga', folder])
            marker.write_text('complete')
        voice = {}
        for p in sorted(folder.rglob('*.wem')):
            m = re.match(r'([a-z]+)_([^_]+)_(select|ambientcombat|effortdeath|workingidle|marchingidle)_i(?:low|norm|high)_c(lowest|low|med|high|highest|none)_', p.name, re.I)
            if not m: continue
            ci, unit, context, culture = m.groups()
            age = {'none':'0','lowest':'1','low':'2','med':'3','high':'4','highest':'4'}[culture.lower()]
            key = f'voice.{ci.lower()}.{unit.lower()}.{context.lower()}.{age}'
            voice.setdefault(key, []).append(('voice-' + hashlib.sha256(str(p.relative_to(folder)).encode()).hexdigest()[:20], p.name, (p, None)))
        for key, rows in voice.items(): group(key, rows, 2)
    assets = {}; jobs = {}
    for rows in groups.values():
        for id, name, src in rows: jobs[id] = (name, src)
    report = {'missingCues': missing, 'decodeFailures': [], 'source': str(game), 'quality': 'audiohigh', 'decoder': 'vgmstream r2117',
              'method': 'Original named media from shipped XML and speech paths; replay mix reconstructed, not a Wwise runtime clone.'}
    def decode(item):
        id, (name, (p, sub)) = item
        dest = out / f'{id}.ogg'; cache = out / f'{id}.json'
        fingerprint = f'{p.stat().st_size}:{p.stat().st_mtime_ns}:{sub}:vorbis-q4-44100-v1'
        if dest.exists() and cache.exists():
            cached = json.loads(cache.read_text())
            if cached.get('fingerprint') == fingerprint: return id, cached
        opts = ['-s', str(sub)] if sub else []
        meta = json.loads(run([vgm, '-I', '-m', *opts, p]))
        with tempfile.TemporaryDirectory(prefix='fusion-audio-') as temp:
            wav = Path(temp)/'clip.wav'
            run([vgm, '-i', '-o', wav, *opts, p])
            tempout = out / f'{id}.tmp.ogg'
            run([ffmpeg, '-v', 'error', '-y', '-i', wav, '-ac', '2', '-ar', '44100', '-c:a', 'libvorbis', '-q:a', '4', tempout])
            tempout.replace(dest)
        info = {'url': dest.name, 'name': name, 'duration': meta['numberOfSamples']/meta['sampleRate'],
                'loop': meta.get('loopingInfo'), 'source': str(p), 'subsong': sub, 'fingerprint': fingerprint}
        cache.write_text(json.dumps(info))
        return id, info
    print(f'Decoding {len(jobs)} media for {len(groups)} cue groups', flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(decode,item):item[0] for item in jobs.items()}
        for n,f in enumerate(concurrent.futures.as_completed(futures),1):
            try:
                id,info=f.result(); assets[id]=info
            except Exception as e: report['decodeFailures'].append({'id':futures[f], 'error':str(e)})
            if n % 200 == 0: print(f'{n}/{len(jobs)} decoded',flush=True)
    cues = {k:[r[0] for r in rows if r[0] in assets] for k,rows in groups.items()}
    # Do not expose installation paths in the browser pack; retain those in the local build report.
    manifest = {'version':1, 'assets':{id:{k:v for k,v in a.items() if k not in ('source','subsong','fingerprint')} for id,a in assets.items()}, 'cues':cues}
    report.update({'assets':len(assets),'cueGroups':len(cues),'sourceMap':assets})
    (out/'build-report.json').write_text(json.dumps(report,indent=2))
    # A failed rebuild must not replace a working pack with a partially decoded index.
    if report['decodeFailures'] or any(k in CUES for k in missing):
        print(json.dumps({'missingCues':missing,'decodeFailures':report['decodeFailures']},indent=2))
        return True
    tmp=out/'index.json.tmp';tmp.write_text(json.dumps(manifest,separators=(',',':')));tmp.replace(out/'index.json')
    print(json.dumps({k:report[k] for k in ['assets','cueGroups','missingCues','decodeFailures']},indent=2))
    return bool(report['decodeFailures'])

if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--game-dir',default='C:/Program Files (x86)/Steam/steamapps/common/Age of Empires IV')
    p.add_argument('--tools-dir',default=str(ROOT/'.audio-tools'));p.add_argument('--output',default=str(ROOT/'viewer3d/assets/audio'))
    p.add_argument('--civs',default='all');p.add_argument('--workers',type=int,default=6)
    raise SystemExit(build(p.parse_args()))
