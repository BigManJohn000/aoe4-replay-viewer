"""The recorder's .rlog grammar, read in one place: recorder/recorder.lua prints it (see the top of that file for the
record types), and tools/convert.py reads it from here.

records(lines, kinds) yields (record type, record) with one typed NamedTuple per record; a line holding several
records (N, S, O, A, V, X, D, GN, GS, GA, GX: fields separated by "|", records inside the last field by ";") yields one
item per record, in file order. Record types this module does not know (R|SUM and the like) are skipped.
Constants mirror recorder.lua, so a change there is made here only.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Callable, Iterable, Iterator, NamedTuple

# Record types (the first field of a line)
HDR = "HDR"
PLAYER = "PL"
ENT_NEW = "N"
ENT_STATE = "S"
ENT_OWNER = "O"
ATTACK = "A"
VISION = "V"
ENT_GONE = "X"
STATS = "P"
JOBS = "J"
KILL = "K"
UPGRADE = "U"
CONSTRUCTION = "C"
COST = "B"
DEST = "D"
SAMPLE = "T"
GAIA_NEW = "GN"
GAIA_MOVED = "GS"
GAIA_AMOUNT = "GA"
GAIA_GONE = "GX"
HEIGHT_HEADER = "HMH"
HEIGHT_ROW = "HM"
ERROR = "ERR"

# Recorder constants
VERSION = 5                # RR_VERSION
MAX_RECS = 60              # RR_MAXREC: records per line
TICKS_PER_SECOND = 8       # sim ticks; the recorder samples every RR_INTERVAL = 0.5 s
TICKS_PER_SAMPLE = 4
STATS_EVERY = 4            # P every 4th sample (RR_SampleBody: RR_N % 4)
GAIA_SCAN_SAMPLES = 20     # RR_Gaia: a full neutral scan (GN/GA/GX) every 20th sample
MOVE_MIN = 0.25            # RR_SampleBody: S when x or z moved more than this
GAIA_MOVE_MIN = 0.5        # RR_GaiaMove
PID_BASE = 1000            # PL|i|1000+pid|...: the field holds the replay's player id (recfile Player.pid) + 1000

# World-owned leftovers that the recorder's neutral scan also sees: corpses, rubble, projectiles in flight.
GAIA_IGNORE = re.compile(r"^(unit|projectile|wpn)_|^building_(?!trade_post)")
GAIA_UNTRACKED, GAIA_STATIC, GAIA_MOVING = 0, 1, 2
_GAIA_UNTRACKED_WORDS = ("dummy", "spawn_marker", "splat")
_GAIA_MOVING_WORDS = ("huntable", "herdable", "relic")


def gaia_kind(bp: str) -> int:
    """recorder.lua RR_GaiaKind: GAIA_UNTRACKED never recorded, GAIA_STATIC, GAIA_MOVING (animals, relics)."""
    if any(w in bp for w in _GAIA_UNTRACKED_WORDS):
        return GAIA_UNTRACKED
    return GAIA_MOVING if any(w in bp for w in _GAIA_MOVING_WORDS) else GAIA_STATIC


def gaia_tracked(bp: str) -> bool:
    """Whether the recorder's neutral scan records this blueprint and readers keep it."""
    return gaia_kind(bp) != GAIA_UNTRACKED and not GAIA_IGNORE.search(bp)


# Records
class Header(NamedTuple):
    version: int
    start: float
    width: float
    length: float
    players: int


class Player(NamedTuple):
    idx: int    # recorder's player number, from 1
    pid: int    # the replay's player id
    race: str
    team: int
    name: str


class NewEnt(NamedTuple):
    t: float
    id: int
    owner: int
    bp: str
    maxhp: int
    building: bool
    squad: int
    x: float
    z: float
    hp: float


class EntState(NamedTuple):
    t: float
    id: int
    x: float
    z: float
    hp: float


class EntOwner(NamedTuple):
    t: float
    id: int
    owner: int


class Attack(NamedTuple):
    t: float
    attacker: int
    target: int


class Vision(NamedTuple):
    t: float
    id: int
    mask: int


class Gone(NamedTuple):
    t: float
    id: int


class Dest(NamedTuple):
    t: float
    squad: int
    x: float | None  # None: destination cleared
    z: float | None


class Cost(NamedTuple):
    owner: int
    bp: str
    squad: int   # squad size; 0 for a single entity
    cost: str    # "key=value,..." as printed; cost_values() parses it
    t: float = float("-inf")  # v4 quotes have no timestamp; valid for the whole recording


class Stats(NamedTuple):
    t: float
    idx: int
    res: tuple[int, ...]  # food, wood, gold, stone (and more in later versions)
    pop: int


class Jobs(NamedTuple):
    t: float
    idx: int
    counts: tuple[int, ...]  # villagers gathering food, wood, gold, stone, other


class Context(NamedTuple):
    t: float
    fields: dict[str, str]  # K, U and C records: key=value pairs of the game event


class Sample(NamedTuple):
    t: float


class GaiaNew(NamedTuple):
    t: float
    id: int
    bp: str
    x: float
    z: float
    amount: int


class GaiaMoved(NamedTuple):
    t: float
    id: int
    x: float
    z: float


class GaiaAmount(NamedTuple):
    t: float
    id: int
    amount: int


class HeightHeader(NamedTuple):
    x0: float
    z0: float
    step: float
    cols: int
    rows: int


class HeightRow(NamedTuple):
    row: int
    heights: list[float]


class Error(NamedTuple):
    text: str


def parse_kv(text: str, sep: str) -> dict[str, str]:
    out = {}
    for kv in text.split(sep):
        if "=" in kv:
            k, v = kv.split("=", 1)
            out[k] = v
    return out


def cost_values(text: str) -> dict[str, float]:
    """A Cost record's "food=50,wood=25" as numbers."""
    return {k: float(v) for k, v in parse_kv(text, ",").items()}


def _recs(p: list[str]) -> list[list[str]]:
    return [rec.split(",") for rec in p[2].split(";")]


def _header(p):
    return [Header(int(p[1]), float(p[2]), float(p[3]), float(p[4]), int(p[5]))]


def _player(p):
    return [Player(int(p[1]), int(p[2]) - PID_BASE, p[3], int(float(p[4])), "|".join(p[5:]))]


def _new_ent(p):
    t = float(p[1])
    return [NewEnt(t, int(f[0]), int(f[1]), f[2], int(f[3]), f[4] == "1", int(f[5]), float(f[6]), float(f[7]),
                   float(f[8])) for f in _recs(p)]


def _ent_state(p):
    t = float(p[1])
    return [EntState(t, int(f[0]), float(f[1]), float(f[2]), float(f[3])) for f in _recs(p)]


def _ent_owner(p):
    t = float(p[1])
    return [EntOwner(t, int(f[0]), int(f[1])) for f in _recs(p)]


def _attack(p):
    t = float(p[1])
    return [Attack(t, int(f[0]), int(f[1])) for f in _recs(p)]


def _vision(p):
    t = float(p[1])
    return [Vision(t, int(f[0]), int(f[1])) for f in _recs(p)]


def _gone(p):
    t = float(p[1])
    return [Gone(t, int(rec)) for rec in p[2].split(";")]


def _dest(p):
    t = float(p[1])
    return [Dest(t, int(f[0]), *((float(f[1]), float(f[2])) if len(f) == 3 else (None, None))) for f in _recs(p)]


def _cost(p):
    return [Cost(int(p[1]), p[2], int(p[3]), p[4], float(p[5]) if len(p) > 5 else float("-inf"))]


def _stats(p):
    res = tuple(int(x) for x in p[3].split(",")) if p[3] else ()
    return [Stats(float(p[1]), int(p[2]), res, int(p[4]))]


def _jobs(p):
    return [Jobs(float(p[1]), int(p[2]), tuple(int(x) for x in p[3].split(",")))]


def _context(p):
    return [Context(float(p[1]), parse_kv("|".join(p[2:]), ";"))]


def _sample(p):
    return [Sample(float(p[1]))]


def _gaia_new(p):
    t = float(p[1])
    return [GaiaNew(t, int(f[0]), f[1], float(f[2]), float(f[3]), int(f[4])) for f in _recs(p)]


def _gaia_moved(p):
    t = float(p[1])
    return [GaiaMoved(t, int(f[0]), float(f[1]), float(f[2])) for f in _recs(p)]


def _gaia_amount(p):
    t = float(p[1])
    return [GaiaAmount(t, int(f[0]), int(f[1])) for f in _recs(p)]


def _height_header(p):
    return [HeightHeader(float(p[1]), float(p[2]), float(p[3]), int(p[4]), int(p[5]))]


def _height_row(p):
    return [HeightRow(int(p[1]), [float(v) for v in p[2].split(",")])]


def _error(p):
    return [Error("|".join(p[1:]))]


_DECODERS: dict[str, Callable[[list[str]], list]] = {
    HDR: _header, PLAYER: _player, ENT_NEW: _new_ent, ENT_STATE: _ent_state, ENT_OWNER: _ent_owner,
    ATTACK: _attack, VISION: _vision, ENT_GONE: _gone, STATS: _stats, JOBS: _jobs, KILL: _context,
    UPGRADE: _context, CONSTRUCTION: _context, COST: _cost, DEST: _dest, SAMPLE: _sample, GAIA_NEW: _gaia_new,
    GAIA_MOVED: _gaia_moved, GAIA_AMOUNT: _gaia_amount, GAIA_GONE: _gone, HEIGHT_HEADER: _height_header,
    HEIGHT_ROW: _height_row, ERROR: _error,
}



def records(lines: Iterable[str], kinds: Iterable[str] | None = None) -> Iterator[tuple[str, tuple]]:
    """(record type, record) for every record of the lines, or only of the given record types; the rest of the
    lines are not decoded."""
    wanted = None if kinds is None else frozenset(kinds)
    for raw in lines:
        p = raw.rstrip("\r\n").split("|")
        kind = p[0]
        if wanted is not None and kind not in wanted:
            continue
        decode = _DECODERS.get(kind)
        if decode:
            for rec in decode(p):
                yield kind, rec


def read(path: Path, kinds: Iterable[str] | None = None) -> Iterator[tuple[str, tuple]]:
    with path.open(encoding="utf-8", errors="replace") as stream:
        yield from records(stream, kinds)
