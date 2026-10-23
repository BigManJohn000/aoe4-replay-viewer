# AoE4 `.rec` record types (build 11308)

Decoded from three replays: `aoe4_256767395` (1v1, 880 s), `aoe4_256829909` (2v2, 1766 s), `aoe4_245598603` (1v1, 2102 s).
Names come from the command name tables in `RelicCardinal.exe` (CMD/SCMD at VA 0x146076160, PCMD at 0x146076070) and, for
DCMD, from `Essence.Editor.Bridge.dll`. Items marked *inferred* are not verified.

## Stream

- Top-level chunks: kind 0 is a tick (8 per second; version byte 32, tick u32, then blocks of host id, u32 0, size,
  payload). Kind 1 is a chat/lobby event (subtype 0: player left; subtype 1: chat, UTF-16 sender and text, each message
  stored twice).
- A block payload holds several commands back to back, each prefixed with its own u16 length. `tools/recfile.py`
  `block_commands()` splits them; `commands()` and `cameras()` read every command of every block.

## Command header (24 bytes)

| Offset | Field |
|---|---|
| 0 | u16 length of the whole command |
| 2 | u8 type (table below) |
| 3 | u8 player index, plus 0x80 when queued (shift) |
| 4 | u32 per-player order sequence, 1..n with no gaps; 0 for DCMD |
| 8 | u32, 0–47. Not a time: it is not monotonic inside a tick. Meaning unknown |
| 12 | u8 2 for orders, 0xff for DCMD/0x8f, 3 for 0x8b |
| 13–15, 18–19 | padding; uninitialised stack bytes |
| 16 | u8 player index; 17: u8 1 |
| 20 | u32 player id (1000 + index; 0 for 0x8f) |

Receivers start at 24:
- If bit 0x40 is set: the low 6 bits are a count, then that many u32 LE.
- `0x80`, then a u8 count (64 or more), then that many u32 LE.
- Otherwise a single u32 BE.

Each id is `kind << 28 | id`: kind 0 = player, kind 1 = entity (id + 1000005000), kind 2 = squad.

After the receivers: u8 data type, u8 length (`0x80` means a u8 length follows), then the data. Data type 0xff has no
length.

| Data type | Content |
|---|---|
| 1 | target: u8 kind (2 = position f32 x,y,z; 3 = entity id; 4 = squad uid) |
| 3 | two targets: position + facing (right-drag move) |
| 5 | u32 flag/index |
| 6 | u32 flag + target |
| 7 | bool + target + u32 plan |
| 20 | 01 + u32 PBG |
| 21 | 01 + u32 PBG + u32 player id + u16 flags |
| 23 | u32 + u32 length + ASCII text |
| 27 | placement |
| 30 | target kind (2 = position f32 x,y,z), then direction |
| 32 | entity load |
| 36 | 01 + u32 ability PBG |
| 37 | ability + target |
| 42 | ability + target + direction |
| 48 | camera |
| 49 | visibility |
| 55 | formation move |
| 56 | gather |

## Types seen

Counts are per replay: 256767395 / 256829909 / 245598603. Every type carries the issuing player at byte 3.

| Type | Name | Class | Count | Size (B) | Frequency |
|---|---|---|---|---|---|
| 0x03 | CMD_BuildSquad | order | 230 / 1355 / 1486 | 41 | irregular |
| 0x05 | CMD_CancelProduction | order | 25 / 111 / 265 | 34 | irregular |
| 0x07 | CMD_Move (entity) | order | 1 / 0 / 0 | 43 | rare |
| 0x0c | CMD_RallyPoint | order | 198 / 635 / 412 | 35–124 | irregular |
| 0x0e | CMD_Ability | order | 20 / 88 / 82 | 36–45 | irregular |
| 0x10 | CMD_Upgrade | order | 7 / 95 / 141 | 41 | irregular |
| 0x14 | CMD_UnloadSquads | order | 24 / 27 / 82 | 29 | irregular |
| 0x16 | CMD_AttackForced | order | 0 / 3 / 13 | 35 | rare |
| 0x38 | CMD_CancelConstruction | order | 4 / 17 / 2 | 29 | rare |
| 0x3e | SCMD_Move | order | 993 / 6467 / 3013 | 35–401 | bursts, 68–220/min |
| 0x3f | SCMD_Stop | order | 1 / 4 / 0 | 34–58 | rare |
| 0x41 | SCMD_BuildStructure | order | 20 / 107 / 60 | 35–156 | irregular |
| 0x42 | SCMD_Capture | order | 0 / 5 / 14 | 35–232 | rare |
| 0x43 | SCMD_Attack | order | 152 / 335 / 567 | 35–393 | irregular |
| 0x47 | SCMD_AttackMove | order | 36 / 682 / 527 | 43–401 | irregular |
| 0x48 | SCMD_Ability | order | 189 / 419 / 253 | 35–370 | irregular |
| 0x49 | SCMD_Load | order | 10 / 26 / 38 | 35–309 | rare |
| 0x4c | SCMD_Unload | order | 1 / 0 / 11 | 43–148 | rare |
| 0x69 | SCMD_Gather | order | 161 / 526 / 248 | 35–216 | irregular |
| 0x6c | SCMD_Trade | order | 6 / 0 / 0 | 72–100 | rare |
| 0x6d | SCMD_HoldPosition | order | 0 / 5 / 2 | 34–235 | rare |
| 0x72 | SCMD_StopAbility | order | 0 / 11 / 4 | 36–314 | rare |
| 0x74 | SCMD_AddPatrolPoint | order | 0 / 15 / 11 | 43–329 | rare |
| 0x7b | PCMD_PlaceAndConstructEntities | order | 74 / 479 / 329 | 85–290 | irregular |
| 0x82 | PCMD_Upgrade | order | 0 / 8 / 0 | 35 | rare |
| 0x8b | PCMD_AIPlayer | other | 1 / 0 / 1 | 34 | once, after a player leaves (*inferred*: AI takeover) |
| 0x8f | PCMD_BroadcastMessage | UI-other | 0 / 6 / 0 | 38–84 | rare |
| 0x92 | PCMD_FormationSquadGroupCreateBegin | order bracket | 1348 / 8102 / 4457 | 29 | before each squad order |
| 0x94 | PCMD_FormationSquadGroupCreateEnd | order bracket | same as 0x92 | 29 | after each squad order |
| 0x99 | DCMD_CameraTrack | camera | 3998 / 11835 / 7498 | 53 | one per tick in which the camera changed; otherwise one every 16 ticks; 1–2.5/s per player |
| 0x9a | DCMD_VisibilityInfo | UI-other | 874 / 3532 / 2097 | 41 | every 16 ticks per player |

Notes on individual types:
- 0x8b PCMD_AIPlayer: data is u32 4.
- 0x8f PCMD_BroadcastMessage: ASCII text such as `500,300,0,0,3|0,0,0,0,2|…`, i.e. four resource amounts and a
  player slot per entry (*inferred*: tribute panel state). It is not a ping or a flare.
- 0x0e CMD_Ability / 0x48 SCMD_Ability: receivers @24 are entities (index + 1000005000 = SCAR entity id) or squads
  (index + 50000 = SCAR squad id: 672 of 672 data-type 36/37/42 casts in aoe4_256829909 and aoe4_245598603 name
  units of the casting player). Data type 36 is `01`, u32 ability PBG. Type 37 adds a target at data offset
  10; type 42 puts it at offset 6: u8 kind, then 2 = position (f32 x, y, z), 3 = entity, 4 = squad (u32 full SCAR ids).
  Verified from replay command payloads: all 324 type-42 casts in the corpus have kind 2 at offset 6; sampled type-30
  commands likewise begin with kind 2 before their position floats.
  The monk's area conversion (`monk_conversion`, PBG 192685) targets the caster's own squad.
  `Replay.abilities()` reads casts; `Replay.orders()` summarizes every command type, including queued flags,
  receiver counts/kinds and known target positions. `tools/convert.py` writes conversion casts into viewer data
  (`conversions`).
- 0x99 DCMD_CameraTrack (data type 48, 26 bytes):
  - u32 sample tick
  - i32 eye x, y, z in cm
  - 4×i16 rotation quaternion w,x,y,z / 16384
  - u16 3741/3742: FOV × 100, taken as the vertical angle. Build placements, which are clicked on screen, projected
    into the placing player's camera reach tan 0.60 sideways and stay within tan 0.34 vertically (≤2% outside), which
    fits a 37.41° vertical FOV on a 16:9 screen; a horizontal 37.41° would put 10–17% of them off screen.

  The record is executed 2–9 ticks after its sample tick. The game shows each sample at its sample tick.
  `tools/convert.py` writes these tracks into the viewer data (`cameras`), every sample included.
- 0x9a DCMD_VisibilityInfo (data type 49, 14 bytes): u32 tick, then 5×u16. Fields 1 and 4 are the same for every
  player (*inferred*: world totals); fields 2, 3 and 5 differ per player.

Absent as record types: selection, control-group assign/recall, non-order clicks, minimap clicks, keystrokes,
pings/flares. Chat exists only as kind-1 chunks.
