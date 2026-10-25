# Original AoE4 replay audio

Implemented October 23, 2026. The 3D viewer and the served 2D viewer share `viewer/audio.js` and the same combat, work and relic timelines. Open **Audio → Enable audio**, then play the replay. Master, effects, voices, ambience, music and UI have separate saved volume controls. Music can follow the viewed player or a chosen civilization. The browser requires the initial enable click.

## Local asset pack

The installed game's `cardinal/audiohigh/SoundbanksInfo.xml` supplies media IDs and original source names. Bank DIDX entries identify embedded streams; loose WEMs and the twelve `SoundSpeech*.sga` archives supply other media. The importer selects named variants and decodes them to Ogg Vorbis. It does not modify the game installation. Generated audio remains under the ignored `viewer3d/assets/audio/` directory.

Current pack: **3,927 clips, 1,964 cue groups, zero decoding failures**. It includes 13 music civilization codes, speech from 12 civilization archives, 21 biome beds, weapons, impact and destruction sounds, locomotion, gathering/building, healing/conversion, relic pickup/selection, upgrades, building selection/completion, match-end feedback, and UI interactions. Multiple variants are selected deterministically. This is a curated replay pack covering the implemented categories, not a copy of every Wwise event in the game.

To rebuild on this installation:

```powershell
powershell -ExecutionPolicy Bypass -File tools/setup_audio.ps1
python/python.exe tools/build_audio.py
```

The speech extractor uses the existing `$env:AOE4_REBUILD` Essence/.NET toolchain. Game location and output paths can be overridden with `--game-dir`, `--tools-dir`, and `--output`. Rebuilds reuse decoded files when the source size, modification time, bank subsong and encoding settings match. `build-report.json` records the original sources and any unavailable groups. The legacy prairie-cut bank has no usable front/near bed; unknown biomes use the temperate bed.

Tools: [vgmstream](https://github.com/vgmstream/vgmstream), [wwiser](https://github.com/bnnm/wwiser), and FFmpeg. Wwise event inspection verified the HUD click, healing start and conversion layers. The conversion starts its cast at the order, voice at +0.5 seconds and buildup at +3 seconds, bounded by the viewer's channel end.

## Timing and behavior

| Category | Replay trigger |
| --- | --- |
| Weapons and impacts | Shared combat `t0` for the release/strike and `t1` for a successful projectile impact |
| Deaths | Recorded kill timestamp; no death sound for an unexplained disappearance |
| Completion notices | Recorded age/economic and other upgrade completion events, deduplicated per player/time |
| Building completion | Existing inferred `builtAt` time |
| Healing/conversion | Shared healing intervals and conversion channels; successful conversions require an owner change |
| Relics | Start of a uniquely confirmed carrying interval, suppressing short tracking breaks; selection when clicked |
| Work and movement | Existing inferred jobs and recorded motion; nearest emitters limited to eight |
| Voices | Civilization/unit/language-stage selection, death, combat, marching and work contexts; two concurrent voices |
| Music | Civilization and completed age; exploration/combat segments crossfade when nearby visible fighting changes |
| Environment/UI | Map biome, nearby recorded fish/water locations, sheep, buttons, details panels and selections |
| Match end | Victory/defeat feedback at natural replay completion, only with a known result and chosen player perspective; never on a seek to the end |

The audio clock schedules ahead of the replay clock. Pause, mute, speed changes, seeking and backgrounding cancel active/pending emitters. Seeking discards skipped events. Music and voices keep their normal pitch at increased replay speed; incidental chatter is suppressed above 2×. Music remembers its position across pauses. A bounded decoded-buffer cache, effect/voice limits, camera attenuation, stereo panning, fog checks and an output compressor keep battles manageable.

## Verification

- **64 automated tests passed**, including twelve audio mixer tests covering timing, gun/siege mapping, asynchronous cancellation, stale sound rejection, fog, pause/mute, voice caps, overlapping music transitions, match-end feedback and decoding failures.
- **13 real-replay audit checks passed** on `aoe4_245598603`: 23,302 planned events, 12,983 releases, 7,086 projectile impacts, 1,009 deaths, 114 deduplicated notices, eight inferred relic starts, four conversion channels and 114 cooldown-limited horns. Every static cue resolves to imported media.
- The first battle's 201 events were delivered exactly once at 0.25×, 1×, 2× and 8×; forward/backward seeks and pause/resume did not replay skipped events.
- Browser playback in both viewers produced nonzero output, matched Delhi Castle Age combat music and the Gobi Desert bed, and reported zero decoding errors. HRE music selection also worked. Sampled release/impact scheduling showed 0 ms lateness; live frame-triggered movement cues typically showed 0–29 ms. Pausing produced silence and stable counters. High-density/late cues are capped or skipped rather than played in a backlog.
- Parity: exit code 0.

Run `node --test tools/tests/audio.test.mjs` and `node viewer3d/tools/audio-replay-audit.mjs` for focused checks. **Audio → Playback details** shows output level, scheduling lateness and errors for manual replay checks.

## Evidence limits

The recording contains no original audio stream, Wwise events, individual resource-gather orders or confirmed relic deposits. Combat placement uses the viewer's existing reconstruction within recording sample windows; work/footstep cadence and some activity sounds are inferred. The importer uses culture filename stages (`lowest`, `low`, `med`, `high`) as age stages, with available-stage fallback when a civilization lacks four sets. Research uses the original upgrade UI cue. These are replay mappings, not a claim to reproduce the game's complete Wwise mix. No deposit sound or command acknowledgement is invented when its triggering event is absent.
