"""Parser for Age of Empires IV .rec replays (command log only, no unit state).

Layout (see aoe4world/replays-api docs/replayData.bt):
    u16 ?, u16 build, char[8] "AOE4_REP", wchar[32] date
    Relic Chunky header + FOLDPOST node
    Relic Chunky header + DATASDSC node
    FOLDINFO node (DATA:DATA game setup, PLAS, GRIF)
        game setup (Replay.setup, chunk version Replay.setup_version) is the engine's serialized ModDllSetup: the
        editor engine's own loader (Essence.Editor.Bridge.dll 0x6eb1a0, the savegame MDLL path's reader) reads it.
        It holds the map as three length-prefixed ASCII strings, each followed by 00 01 ?? 00:
        01 u32 n "map_size_416", 01 u32 n layout, 01 u32 n biome, then 01 00 00 00, u32 map seed.
        The DATASDSC summary repeats the strings with seed 0. Validated: 150 of 150 replays have it; for the 34
        in-game map generation logs (LogFiles/*/mapgen/map01/log.txt) with a matching replay, seed, size, layout
        and biome all agree.
        GRIF (version 2, 8 bytes): u32 1, u32 the sim's random seed (Replay.sim_seed). Validated: 150 of 150 replays
        have it; it equals the "randomseed" of the game's tick-0 sync dump (LogFiles/*/DataCRC000.txt) in all 21
        sessions with a matching replay.
    record stream: u32 type; 0 = game tick, 1 = chat message
    game tick: u32 size, u8 version, u32 tick, u32 sync checksum, u32 block count, blocks (u32 host, u32 ?, u32 size,
        payload). The checksum is what the game checks during playback: a copy of may_251632083.rec with tick 100's
        value changed by one made the real game log "REC -- SyncCmd Checksum Error - Frame=100
        sync->checksum=8F3D94F7m_nextChecksum=8F3D94F6", its own value being the original.

Commands (build 11308): each tick block payload holds one or more commands back to back, each starting with its own
    u16 length (docs/rec-record-types.md has the full table).
    u16 length, u8 type, u8 player index (| 0x80 when shift-queued), u32 sequence, ..., u32 @20 player (1000 + header
    player id), receivers @24, then u8 data type, u8 data length (0x80: a u8 length follows), data
    type 0x03 train (41 B, one unit per command; no count), 0x10 research (41 B): data 01, u32 pbgid
    0x7b build (85-290 B; data 01, u32 pbgid, f32 x, y, z; a wall line is one command, with a pbgid that names no
    blueprint)
    train/research: big-endian u24 @25 is the producing building; + 1000005000 = its SCAR entity id (20 of 20 games)
    0x99 DCMD_CameraTrack (53 B, data type 48): u32 sample tick, i32 eye x, y, z in cm, 4 x i16 rotation quaternion
    w, x, y, z / 16384, u16 3741. One per tick while the player's camera changes, else one per 16 ticks. The game's
    replay camera shows a sample at its sample tick, but only when it follows the previous sample by one tick: a jump
    from a still camera (control-group double tap, home key) is recorded and not shown.
Validated against 20 games recorded in-game: 1,318 of 1,361 non-wall buildings have a build command with the same
blueprint within 3 tiles at or before the building's birth (median lag 0 s), and every named non-wall build command
has such a building (1,377 of 1,377). Train commands are intents: a queued unit can be cancelled or never paid for
(villager commands = 1.36x villagers spawned). Unit tier upgrades are research commands whose pbgids are missing
from aoe4world's tables.
"""
from __future__ import annotations

import gzip
import re
import struct
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

TICKS_PER_SECOND = 8
_CHUNKY_HEADER = 24


@dataclass
class Player:
    slot: int
    name: str
    civ: str
    team: int
    human: bool
    pid: int  # header player id; commands carry 1000 + pid


@dataclass
class Tick:
    tick: int
    blocks: list[tuple[int, bytes]]  # (host computer id, command payload)
    checksum: int = 0  # the game's sync checksum for this tick


@dataclass
class Chat:
    tick: int
    sender: str
    message: str


COMMAND_KINDS = {0x03: "train", 0x10: "research", 0x7B: "build"}
COMMAND_NAMES = {
    0x03: "CMD_BuildSquad", 0x05: "CMD_CancelProduction", 0x07: "CMD_Move",
    0x0C: "CMD_RallyPoint", 0x0E: "CMD_Ability", 0x10: "CMD_Upgrade",
    0x14: "CMD_UnloadSquads", 0x16: "CMD_AttackForced", 0x38: "CMD_CancelConstruction",
    0x3E: "SCMD_Move", 0x3F: "SCMD_Stop", 0x41: "SCMD_BuildStructure",
    0x42: "SCMD_Capture", 0x43: "SCMD_Attack", 0x47: "SCMD_AttackMove",
    0x48: "SCMD_Ability", 0x49: "SCMD_Load", 0x4C: "SCMD_Unload",
    0x69: "SCMD_Gather", 0x6C: "SCMD_Trade", 0x6D: "SCMD_HoldPosition",
    0x72: "SCMD_StopAbility", 0x74: "SCMD_AddPatrolPoint",
    0x7B: "PCMD_PlaceAndConstructEntities", 0x82: "PCMD_Upgrade",
    0x8B: "PCMD_AIPlayer", 0x8F: "PCMD_BroadcastMessage",
    0x92: "PCMD_FormationSquadGroupCreateBegin", 0x94: "PCMD_FormationSquadGroupCreateEnd",
    0x99: "DCMD_CameraTrack", 0x9A: "DCMD_VisibilityInfo",
}
CAMERA_TRACK = 0x99
ABILITY_COMMANDS = {0x0E: "entity", 0x48: "squad"}  # CMD_Ability (entity receivers), SCMD_Ability (squad receivers)
ENTITY_ID_BASE = 1000005000  # receiver entity index + this = SCAR entity id
SQUAD_ID_BASE = 50000  # receiver squad index + this = SCAR squad id (each conversion cast: a monk of the caster)


@dataclass
class Command:
    tick: int
    pid: int  # header player id (Player.pid)
    kind: str  # "train" | "research" | "build"
    pbgid: int
    pos: tuple[float, float] | None = None  # (x, z) ground position of a build

    @property
    def time(self) -> float:
        return self.tick / TICKS_PER_SECOND


@dataclass
class CameraSample:
    tick: int  # sample tick: when the player's camera was here (the record itself runs 2-9 ticks later)
    pid: int  # header player id (Player.pid)
    eye: tuple[float, float, float]  # camera position, metres (world x, y up, z)
    rot: tuple[float, float, float, float]  # orientation quaternion w, x, y, z; the view looks along +z rotated by it
    fov: float  # the record's last u16 / 100 (37.41): taken as the vertical field of view in degrees


@dataclass
class AbilityUse:
    tick: int
    pid: int  # header player id (Player.pid)
    pbgid: int  # the ability's PBG (aoe4world abilities/all.json pbgid)
    casters: list[int]  # SCAR entity ids (CMD_Ability) or squad ids (SCMD_Ability) that received the order
    squads: bool  # casters are squad ids
    target: tuple | None  # ("entity", id) / ("squad", id) with SCAR ids, ("pos", x, z), or None (no target)

    @property
    def time(self) -> float:
        return self.tick / TICKS_PER_SECOND


def receivers(c: bytes) -> list[tuple[int, int]]:
    """(kind, index) of each receiver of one command: kind 0 player, 1 entity, 2 squad."""
    o = 24
    if c[o] == 0x80:
        ids = struct.unpack_from(f"<{c[o + 1]}I", c, o + 2)
    elif c[o] & 0x40:
        ids = struct.unpack_from(f"<{c[o] & 0x3F}I", c, o + 1)
    else:
        ids = struct.unpack_from(">I", c, o)
    return [(i >> 28, i & 0x0FFFFFFF) for i in ids]


def block_commands(payload: bytes) -> Iterator[bytes]:
    """The commands in one tick block payload, each prefixed with its own u16 length."""
    p = 0
    while p + 2 <= len(payload):
        (n,) = struct.unpack_from("<H", payload, p)
        if n < 2:
            break
        yield payload[p:p + n]
        p += n


def command_data(c: bytes) -> tuple[int, bytes]:
    """(data type, data) of one command: skips the 24-byte header and the receiver list."""
    o = 24
    if c[o] == 0x80:
        o += 2 + 4 * c[o + 1]
    elif c[o] & 0x40:
        o += 1 + 4 * (c[o] & 0x3F)
    else:
        o += 4
    dtype = c[o]
    if dtype == 0xFF:
        return dtype, b""
    n, o = c[o + 1], o + 2
    if n == 0x80:
        n, o = c[o], o + 1
    return dtype, c[o:o + n]


@dataclass
class MapSettings:
    size: str  # "map_size_416"
    layout: str  # "highview"
    biome: str  # "tropical_rainforest"
    seed: int  # map generator seed, as in the game's mapgen log


@dataclass
class Replay:
    path: Path
    data: bytes
    version: int
    date: str
    players: list[Player]
    stream_offset: int
    last_tick: int = 0
    chats: list[Chat] = field(default_factory=list)
    map: MapSettings | None = None
    sim_seed: int | None = None  # the game's sim random seed (FOLDINFO GRIF)
    setup: bytes | None = None  # FOLDINFO DATA:DATA content, the serialized game setup
    setup_version: int | None = None  # its chunk version (60 in build 11308)

    @property
    def duration_seconds(self) -> float:
        return self.last_tick / TICKS_PER_SECOND

    def ticks(self) -> Iterator[Tick]:
        b, o = self.data, self.stream_offset
        last = 0
        self.chats.clear()  # chats are collected per pass; a second pass must not duplicate them
        while o + 4 <= len(b):
            (kind,) = struct.unpack_from("<I", b, o)
            o += 4
            if kind == 0:
                (size,) = struct.unpack_from("<I", b, o)
                o += 4
                end = o + size
                _ver, tick, checksum, nblk = struct.unpack_from("<BIII", b, o)
                p = o + 13
                blocks = []
                for _ in range(nblk):
                    host, _u, bsz = struct.unpack_from("<III", b, p)
                    p += 12
                    blocks.append((host, b[p:p + bsz]))
                    p += bsz
                o = end
                last = tick
                yield Tick(tick, blocks, checksum)
            elif kind == 1:
                size, subtype = struct.unpack_from("<II", b, o)
                end = o + 4 + size
                # subtype 1 is a text message; subtype 0 carries 8 bytes (a u64 such as 1000..1006, likely a player
                # id) and appears in the last few KB of won games, so it is read as a leave/resign event, not chat;
                # subtype 2 carries u32 4 + u32 player id (1000 + pid), seen in 8 of 128 May replays, meaning unknown
                if subtype == 1:
                    sender, message = _chat_strings(b, o + 4, end)
                    self.chats.append(Chat(last, sender, message))
                elif subtype not in (0, 2):
                    raise ValueError(f"unknown chat-stream subtype {subtype} at offset {o - 4}")
                o = end
            else:
                raise ValueError(f"unknown record type {kind} at offset {o - 4}")

    def commands(self) -> list[Command]:
        """Train, research and build commands of every player, in game order."""
        out = []
        for t in self.ticks():
            for _host, payload in t.blocks:
                for c in block_commands(payload):
                    kind = COMMAND_KINDS.get(c[2]) if len(c) >= 35 else None
                    if kind is None:
                        continue
                    player = struct.unpack_from("<I", c, 20)[0]
                    _dtype, data = command_data(c)
                    pbgid = struct.unpack_from("<I", data, 1)[0]
                    pos = None
                    if kind == "build" and len(data) >= 17:
                        x, _y, z = struct.unpack_from("<fff", data, 5)
                        pos = (x, z)
                    out.append(Command(t.tick, player - 1000, kind, pbgid, pos))
        return out

    def orders(self) -> Iterator[tuple[int, int, int, bool, int, str | None, tuple[float, float] | None]]:
        """Yield (tick, pid, type, queued, n_receivers, receiver_kind, target_pos) for every command type.

        Types are raw bytes (known names in COMMAND_NAMES), including camera/UI commands. The player and queue
        flag come from byte 3, not the optional player id at 20; the order sequence occupies bytes 4–7.
        Receiver kinds are player/entity/squad, mixed, or None for an empty list. Receiver indices use the
        ENTITY_ID_BASE and SQUAD_ID_BASE offsets; this summary returns their count, not their ids.
        Positions are ground (x, z); absent, non-position and undocumented targets return None.
        """
        kinds = {0: "player", 1: "entity", 2: "squad"}
        target_offsets = {1: 0, 3: 0, 6: 4, 30: 0, 37: 10, 42: 6}
        for t in self.ticks():
            for _host, payload in t.blocks:
                for c in block_commands(payload):
                    if len(c) < 26:
                        continue
                    recv = receivers(c)
                    receiver_kinds = {kind for kind, _index in recv}
                    receiver_kind = (kinds.get(next(iter(receiver_kinds)), "unknown")
                                     if len(receiver_kinds) == 1 else "mixed" if receiver_kinds else None)
                    dtype, data = command_data(c)
                    pos = None
                    offset = target_offsets.get(dtype)
                    if offset is not None and len(data) >= offset + 13 and data[offset] == 2:
                        x, _y, z = struct.unpack_from("<fff", data, offset + 1)
                        pos = (x, z)
                    elif dtype == 27 and len(data) >= 17:
                        x, _y, z = struct.unpack_from("<fff", data, 5)
                        pos = (x, z)
                    yield t.tick, c[3] & 0x7F, c[2], bool(c[3] & 0x80), len(recv), receiver_kind, pos

    def cameras(self) -> list[CameraSample]:
        """Every player's DCMD_CameraTrack samples, in stream order (sample ticks rise per player)."""
        out = []
        for t in self.ticks():
            for _host, payload in t.blocks:
                for c in block_commands(payload):
                    if len(c) < 53 or c[2] != CAMERA_TRACK:
                        continue
                    pid = c[3] & 0x7F  # the u32 player @20 is 0 in DCMD records
                    tick, x, y, z = struct.unpack_from("<Iiii", c, 27)
                    w, qx, qy, qz, fov = struct.unpack_from("<4hH", c, 43)
                    out.append(CameraSample(tick, pid, (x / 100, y / 100, z / 100),
                                            (w / 16384, qx / 16384, qy / 16384, qz / 16384), fov / 100))
        return out

    def abilities(self) -> list[AbilityUse]:
        """Every CMD_Ability / SCMD_Ability order, in game order. Data type 36 is 01 + u32 ability PBG; types 37 and 42
        add a target at data offsets 10 and 6 respectively: u8 kind (2 position f32 x, y, z; 3 entity id; 4 squad id,
        both full SCAR ids). A self-centred ability such as monk_conversion targets the caster's own squad."""
        out = []
        for t in self.ticks():
            for _host, payload in t.blocks:
                for c in block_commands(payload):
                    kind = ABILITY_COMMANDS.get(c[2]) if len(c) >= 30 else None
                    if kind is None:
                        continue
                    dtype, data = command_data(c)
                    if dtype not in (36, 37, 42) or len(data) < 5:
                        continue
                    target = None
                    offset = 6 if dtype == 42 else 10
                    if dtype != 36 and len(data) >= offset + 5:
                        tk = data[offset]
                        if tk == 2 and len(data) >= offset + 13:
                            x, _y, z = struct.unpack_from("<fff", data, offset + 1)
                            target = ("pos", x, z)
                        elif tk in (3, 4):
                            target = ("entity" if tk == 3 else "squad", struct.unpack_from("<I", data, offset + 1)[0])
                    base = SQUAD_ID_BASE if kind == "squad" else ENTITY_ID_BASE
                    out.append(AbilityUse(t.tick, struct.unpack_from("<I", c, 20)[0] - 1000,
                                          struct.unpack_from("<I", data, 1)[0],
                                          [base + i for _k, i in receivers(c)], kind == "squad", target))
        return out


def _ustring(b: bytes, o: int) -> tuple[str, int]:
    (n,) = struct.unpack_from("<I", b, o)
    o += 4
    return b[o:o + 2 * n].decode("utf-16le", errors="replace"), o + 2 * n


def _chat_strings(b: bytes, start: int, end: int) -> tuple[str, str]:
    """Chat record body: a header (20 bytes in build 11308: u32 1, u32 0x1e, u32 0, u64 sender profile id),
    then sender and message as length-prefixed UTF-16 strings that end the record. The header is not
    relied on: the strings are the two that end exactly at the record boundary."""
    for p in range(start, end - 8 + 1):
        (n1,) = struct.unpack_from("<I", b, p)
        q = p + 4 + 2 * n1
        if q + 4 > end:
            continue
        (n2,) = struct.unpack_from("<I", b, q)
        if q + 4 + 2 * n2 == end:
            return _ustring(b, p)[0], _ustring(b, q)[0]
    raise ValueError(f"chat record at {start - 8} has no sender/message strings")


def _node(b: bytes, o: int) -> tuple[str, str, int, int, int]:
    """Returns (type, id, content_offset, content_end, version) for a chunky node at o."""
    typ = b[o:o + 4].decode("ascii")
    cid = b[o + 4:o + 8].decode("ascii")
    ver, length, name_len = struct.unpack_from("<III", b, o + 8)
    start = o + 20 + name_len
    return typ, cid, start, start + length, ver


def _children(b: bytes, start: int, end: int) -> Iterator[tuple[str, str, int, int, int]]:
    o = start
    while o < end:
        node = _node(b, o)
        yield node
        o = node[3]


def _parse_players(b: bytes, start: int, end: int) -> list[Player]:
    (count,) = struct.unpack_from("<I", b, start + 10)
    players: list[Player] = []
    o = start + 14
    while len(players) < count and o < end - 16:
        human = b[o]
        if human in (0, 1):
            (n,) = struct.unpack_from("<I", b, o + 1)
            if 1 <= n <= 64:
                p = o + 5 + 2 * n
                if p + 13 <= end:
                    team, pid = struct.unpack_from("<II", b, p)
                    (cl,) = struct.unpack_from("<I", b, p + 9)
                    civ = b[p + 13:p + 13 + cl]
                    if team < 16 and 3 <= cl <= 40 and all(48 <= c < 123 for c in civ) and not civ.startswith(b"map_"):
                        name = b[o + 5:p].decode("utf-16le", errors="replace")
                        players.append(Player(len(players), name, civ.decode(), team, bool(human), pid))
                        o = p + 13 + cl
                        continue
        o += 1
    return players


_MAP = re.compile(rb"\x01(....)(map_size_\w+)\x00\x01.\x00\x01(....)(\w+)\x00\x01.\x00\x01(....)(\w+)\x00\x01.\x00"
                  rb"\x01\x00\x00\x00(....)", re.S)


def _parse_map(b: bytes, start: int, end: int) -> MapSettings | None:
    for m in _MAP.finditer(b, start, end):
        if all(struct.unpack("<I", m.group(g))[0] == len(m.group(g + 1)) for g in (1, 3, 5)):
            return MapSettings(m.group(2).decode(), m.group(4).decode(), m.group(6).decode(),
                               struct.unpack("<I", m.group(7))[0])
    return None


def load(path: str | Path) -> Replay:
    path = Path(path)
    data = path.read_bytes()
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    if data[4:11] != b"AOE4_RE":
        raise ValueError(f"{path} is not an AoE4 replay")
    version = data[2] | (data[3] << 8)
    date = data[12:76].decode("utf-16le", errors="replace").split("\x00", 1)[0]

    o = 76 + _CHUNKY_HEADER
    o = _node(data, o)[3]                 # FOLDPOST
    o += _CHUNKY_HEADER
    o = _node(data, o)[3]                 # DATASDSC
    typ, cid, info_start, info_end, _ = _node(data, o)
    if (typ, cid) != ("FOLD", "INFO"):
        raise ValueError(f"expected FOLDINFO at {o}, found {typ}{cid}")
    players: list[Player] = []
    map_settings = None
    sim_seed = None
    setup = setup_version = None
    for ctyp, ccid, cstart, cend, cver in _children(data, info_start, info_end):
        if (ctyp, ccid) == ("DATA", "DATA"):
            players = _parse_players(data, cstart, cend)
            map_settings = _parse_map(data, cstart, cend)
            setup, setup_version = data[cstart:cend], cver
        elif (ctyp, ccid) == ("DATA", "GRIF") and cend - cstart == 8:
            sim_seed = struct.unpack_from("<I", data, cstart + 4)[0]

    rep = Replay(path, data, version, date, players, info_end, map=map_settings, sim_seed=sim_seed,
                 setup=setup, setup_version=setup_version)
    for t in rep.ticks():
        rep.last_tick = t.tick
    return rep


if __name__ == "__main__":
    import sys

    r = load(sys.argv[1])
    print(f"build {r.version}  {r.date}  {int(r.duration_seconds // 60)}:{int(r.duration_seconds % 60):02d}")
    if r.map:
        print(f"  map {r.map.layout}  {r.map.biome}  {r.map.size}  seed {r.map.seed} ({r.map.seed:#010x})")
    if r.sim_seed is not None:
        print(f"  sim random seed {r.sim_seed} ({r.sim_seed:#010x})")
    for p in r.players:
        print(f"  slot {p.slot}  team {p.team}  {p.civ:12s} {p.name}")
    for c in r.chats:
        print(f"  chat @{c.tick / TICKS_PER_SECOND:.0f}s {c.sender}: {c.message}")
