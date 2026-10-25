"""Check tools/mechanics.py against your own logged input (tools/input_logger.py): how often each flagged event was
the real thing (precision) and how many of the real ones it caught (recall).

Usage:
    python tools/input_logger.py                          (play; each match's replay is saved next to the log)
    python tools/record_replay.py recordings/input/<log>_<time>.rec      (once per saved replay)
    python tools/validate_mechanics.py recordings/input/<log>.jsonl [...]
    python tools/validate_mechanics.py LOG --rec REPLAY.rec              (a replay the logger did not save)

Lining up. The log's clock and the replay's ticks are tied by right-clicks: each right-click in the game issues an
order a few ticks later. The offset with the most right-click/order pairs (within MATCH) wins if it pairs clearly
more than an offset tens of seconds wrong pairs by chance; pauses and slowdowns shift it, so further offsets are
searched among the clicks still unpaired, and each stretch of clicks takes the offset that pairs most of it (a change
of offset costs SWITCH unpaired clicks). The player is the one whose orders pair with most right-clicks.

What really happened, per flagged event:
  selections   the inputs between the previous order and this one, newest first: a left click or box whose ground
               point (through the replay's camera) lands on the receivers = mouse; a control-group recall = group.
               Failing both, the oldest key or left click decides: a key = hotkey, a left click elsewhere (portrait,
               HUD button) = unclear, left out of the scores. recalls are right when the input was a group;
               prod_offscreen and army_offscreen when group or hotkey; idle_villager when a hotkey selection used the
               idle-villager key (--idle-key, else the first key most flagged selections began with).
  minimap      a positional order paired with a right-click whose ground point lies more than mechanics.MINIMAP
               from the order's target was clicked on the minimap.
  jumps        the input in the moment before the camera jump, newest first: a double-tapped group, a key, a left
               click on the minimap (its screen area is learnt from the minimap right-clicks), another left click,
               or none. jumps_to_units is right for a double-tap or the idle-villager key; jumps_to_base for the base
               key (--base-key, else the key most base jumps followed).

Verdicts need 10 flagged and 10 real events: keep when precision and recall are both at least 0.8, fix from 0.6,
drop below. The camera line reports how far right-clicks in view land from their order's target, which tests the
camera model the offscreen and minimap measures stand on.
"""
from __future__ import annotations

import argparse
import bisect
import math
import statistics
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import input_logger as il  # noqa: E402
import mechanics as mx  # noqa: E402
import recfile  # noqa: E402

TPS = recfile.TICKS_PER_SECOND
MATCH = 0.25  # seconds between a right-click (after alignment) and its order
BIN = 1 / TPS
COARSE = 400  # right-clicks used to find an offset's peak
MAX_OFFSETS = 6  # pauses or slowdowns per game
MIN_SHARE = 0.1  # a further offset needs this share of the right-clicks
SWITCH = 8  # unpaired right-clicks a change of offset must explain
CLICK_UNIT, CLICK_BUILDING = 3.0, mx.BUILDING_MARGIN  # a left click this close to a receiver selected it (metres)
BOX = 0.02  # a left press and release further apart than this (screen -1..1) drew a box
BEFORE_JUMP = 0.5  # seconds before a camera jump in which its input is looked for
MIN_EVENTS = 10


# ---------------------------------------------------------------- lining up (pure)

def best_offset(clicks: list[float], orders: list[float]) -> tuple[float, int]:
    """The offset d (order = click + d) that pairs most clicks with an order within MATCH, refined to the pairs'
    median, and how many clicks it pairs. The peak is found among at most COARSE clicks spread over the game."""
    if not clicks or not orders:
        return 0.0, 0
    sample = clicks[::max(1, len(clicks) // COARSE)]
    bins = Counter(math.floor((o - r) / BIN) for r in sample for o in orders)
    peak = max(bins, key=lambda b: (bins[b - 1] + bins[b] + bins[b + 1], -abs(b)))
    d = (peak + 0.5) * BIN
    diffs = [o - r for r in clicks if (o := nearest(orders, r + d)) is not None and abs(o - r - d) <= MATCH]
    if diffs:
        d = statistics.median(diffs)
    return d, sum(1 for r in clicks if paired(orders, r, d))


def paired(orders: list[float], r: float, d: float) -> bool:
    o = nearest(orders, r + d)
    return o is not None and abs(o - r - d) <= MATCH


def chance(clicks: list[float], orders: list[float], d: float) -> float:
    """How many clicks pair with an order at an offset tens of seconds wrong, on average."""
    return statistics.mean(sum(1 for r in clicks if paired(orders, r, d + w)) for w in (-53.1, -17.3, 23.9, 61.7))


def nearest(sorted_values: list[float], x: float) -> float | None:
    i = bisect.bisect_left(sorted_values, x)
    near = [sorted_values[j] for j in (i - 1, i) if 0 <= j < len(sorted_values)]
    return min(near, key=lambda v: abs(v - x)) if near else None


@dataclass
class Clock:
    """Game seconds = log seconds + offset, the offset changing at pauses: pieces of (log second it starts, offset)."""
    pieces: list[tuple[float, float]]
    paired: int = 0  # right-clicks paired with an order
    clicks: int = 0

    def offset(self, s: float) -> float:
        i = bisect.bisect_right([p[0] for p in self.pieces], s) - 1
        return self.pieces[max(0, i)][1]

    def game(self, s: float) -> float:
        return s + self.offset(s)

    def log(self, g: float) -> float:
        """The log second of game second g (the last piece already running at g)."""
        best = self.pieces[0]
        for p in self.pieces:
            if p[0] + p[1] <= g:
                best = p
        return g - best[1]


def align(clicks: list[float], orders: list[float]) -> Clock | None:
    """Offsets for sorted right-click and order times (seconds); None when nothing pairs. With a busy player a
    click pairs with some order by chance half the time, so an offset counts only the pairs above chance, and each
    stretch of clicks takes the offset that pairs most of them: the cheapest path through the clicks, one unpaired
    click costing 1 and a change of offset SWITCH."""
    left, found = list(clicks), []
    while len(found) < MAX_OFFSETS and left:
        d, n = best_offset(left, orders)
        luck = chance(left, orders, d)
        if n - luck < max(MIN_EVENTS, MIN_SHARE * len(clicks), 6 * math.sqrt(luck)):
            break
        found.append(d)
        left = [r for r in left if not paired(orders, r, d)]
    if not found:
        return None
    hits = [[paired(orders, r, d) for d in found] for r in clicks]
    cost = [0.0] * len(found)
    back: list[list[int]] = []
    for h in hits:
        k_best = min(range(len(found)), key=cost.__getitem__)
        step, came = [], []
        for k in range(len(found)):
            stay, switch = cost[k], cost[k_best] + SWITCH
            step.append(min(stay, switch) + (not h[k]))
            came.append(k if stay <= switch else k_best)
        cost = step
        back.append(came)
    k = min(range(len(found)), key=cost.__getitem__)
    path = [0] * len(clicks)
    for i in range(len(clicks) - 1, -1, -1):
        path[i] = k
        k = back[i][k]
    pieces: list[tuple[float, float]] = []
    for r, k in zip(clicks, path):
        if not pieces or pieces[-1][1] != found[k]:
            pieces.append((r if pieces else -math.inf, found[k]))
    return Clock(pieces, sum(h[k] for h, k in zip(hits, path)), len(clicks))


# ---------------------------------------------------------------- what really happened (pure)

def selection_input(window: list[il.Action], on_receivers: Callable[[il.Action], bool]) -> tuple[str, list[int]]:
    """How a selection was made, from the inputs between the previous order and its own (oldest first), and the keys
    pressed in order. Newest first, a left click or box on the receivers is "click" and a control-group recall
    "group". Failing both, the selection came first and the commands after it: "key" when the oldest key or left
    click is a key, "unclear" when it is a left click elsewhere (a HUD portrait, the idle-villager button), "none"
    without either."""
    keys = [a.key for a in window if a.kind == "key"]
    for a in reversed(window):
        if a.kind in ("recall", "double"):
            return "group", keys
        if a.kind == "click" and on_receivers(a):
            return "click", keys
    first = next((a for a in window if a.kind in ("key", "click")), None)
    if first is None:
        return "none", keys
    return ("key" if first.kind == "key" else "unclear"), keys


def jump_cause(window: list[il.Action], on_minimap: Callable[[il.Action], bool]) -> tuple[str, int | None]:
    """The input behind a camera jump, newest first: ("double", group), ("key", vk), ("minimap", None),
    ("click", None) or ("none", None)."""
    for a in reversed(window):
        if a.kind == "double":
            return "double", a.key
        if a.kind == "key":
            return "key", a.key
        if a.kind == "click":
            return ("minimap" if on_minimap(a) else "click"), None
    return "none", None


@dataclass
class Score:
    flagged: int = 0
    real: int = 0
    both: int = 0
    unclear: int = 0

    def add(self, flagged: bool, real: bool | None) -> None:
        if real is None:
            self.unclear += flagged
            return
        self.flagged += flagged
        self.real += real
        self.both += flagged and real

    def __iadd__(self, o: Score) -> Score:
        self.flagged += o.flagged
        self.real += o.real
        self.both += o.both
        self.unclear += o.unclear
        return self

    @property
    def precision(self) -> float | None:
        return self.both / self.flagged if self.flagged else None

    @property
    def recall(self) -> float | None:
        return self.both / self.real if self.real else None

    @property
    def verdict(self) -> str:
        if self.flagged < MIN_EVENTS or self.real < MIN_EVENTS:
            return "too few"
        worst = min(self.precision, self.recall)
        return "keep" if worst >= 0.8 else "fix" if worst >= 0.6 else "drop"


MEASURES = ["recalls", "prod_offscreen", "army_offscreen", "idle_villager", "minimap_orders", "jumps",
            "jumps_to_units", "jumps_to_base"]


# ---------------------------------------------------------------- one game

@dataclass
class Result:
    name: str
    player: str = ""
    clock: Clock | None = None
    scores: dict[str, Score] = field(default_factory=lambda: {m: Score() for m in MEASURES})
    how: Counter = field(default_factory=Counter)
    causes: Counter = field(default_factory=Counter)  # (lands, cause) for jumps
    camera_error: tuple[float, float] | None = None  # median metres, mirrored screen x
    mirrored: bool = False
    minimap_area: tuple[int, int, int, int] | None = None
    idle_key: int | None = None
    base_key: int | None = None
    note: str = ""


def validate(acts: list[il.Action], rec: Path, rlog: Path, player: str | None, idle_key: int | None,
             base_key: int | None) -> Result:
    res = Result(rec.stem)
    if not rlog.exists():
        res.note = f"not recorded yet: python tools/record_replay.py {rec}"
        return res
    game = mx.Game(rec, rlog)
    rights = [a.t / 1000 for a in acts if a.kind == "right"]
    best = None
    for p in game.players:
        if player and p.name != player:
            continue
        clock = align(rights, [o.tick / TPS for o in p.orders])
        if clock and (best is None or clock.paired > best[1].paired):
            best = (p, clock)
    if best is None:
        res.note = "no player's orders line up with the logged right-clicks"
        return res
    p, clock = best
    res.player, res.clock = p.name, clock
    cam, height = p.camera, game.height
    order_s = [o.tick / TPS for o in p.orders]

    def ground(a: il.Action, x: float, y: float, mirror: bool, tick: int | None = None) -> tuple[float, float] | None:
        """The ground under screen point (x, y) of click a, through the camera at `tick` (default: the click's)."""
        v = cam.at(round(clock.game(a.t / 1000) * TPS) - mx.LAG if tick is None else tick)
        if v is None:
            return None
        s = v.sample
        return mx.ground_point(s.eye, s.rot, s.fov, -x if mirror else x, y, height, a.aspect)

    # the camera model: right-clicks paired with an in-view positional order, with either screen handedness; the
    # camera is the one mechanics uses for that order (a click's own tick is a tick or two off, and a moving camera
    # covers metres in a tick)
    targets = {t.tick: t for t in p.targets}
    clicked = []  # (right-click, the positional order it issued)
    for a in acts:
        if a.kind != "right":
            continue
        g = clock.game(a.t / 1000)
        o = nearest(order_s, g)
        if o is not None and abs(o - g) <= MATCH and (t := targets.get(round(o * TPS))):
            clicked.append((a, t))
    errors = {}
    for mirror in (False, True):
        e = [math.dist(gp, t.pos) for a, t in clicked
             if t.outside is not None and t.outside <= 0 and (gp := ground(a, a.x, a.y, mirror, t.tick - mx.LAG))]
        errors[mirror] = statistics.median(e) if e else math.inf
    res.mirrored = mirror = errors[True] < errors[False]
    if errors[mirror] < math.inf:
        res.camera_error = (round(errors[mirror], 1), round(errors[not mirror], 1))

    minimap_px = []
    for a, t in clicked:
        gp = ground(a, a.x, a.y, mirror, t.tick - mx.LAG)
        real = gp is not None and math.dist(gp, t.pos) > mx.MINIMAP
        res.scores["minimap_orders"].add(t.minimap, real)
        if real:
            minimap_px.append(a.pixel)
    if len(minimap_px) >= 5:
        xs, ys = sorted(px[0] for px in minimap_px), sorted(px[1] for px in minimap_px)
        q = lambda v, f: v[min(len(v) - 1, int(f * len(v)))]  # noqa: E731
        res.minimap_area = (q(xs, 0.05) - 10, q(ys, 0.05) - 10, q(xs, 0.95) + 10, q(ys, 0.95) + 10)

    def on_minimap(a: il.Action) -> bool:
        m = res.minimap_area
        return m is not None and m[0] <= a.pixel[0] <= m[2] and m[1] <= a.pixel[1] <= m[3]

    act_s = [a.t / 1000 for a in acts]

    def window(g0: float, g1: float) -> list[il.Action]:
        return acts[bisect.bisect_right(act_s, clock.log(g0)):bisect.bisect_right(act_s, clock.log(g1))]

    def on_receivers(a: il.Action, receivers) -> bool:
        t = clock.game(a.t / 1000)
        es = game.members(receivers, t)
        if not es:
            return False
        if math.hypot(a.x1 - a.x, a.y1 - a.y) > BOX:
            corners = [ground(a, x, y, mirror) for x, y in ((a.x, a.y), (a.x1, a.y), (a.x1, a.y1), (a.x, a.y1))]
            return None not in corners and any(
                mx.outside(corners, *e.position_at(t)[:2]) <= mx.UNIT_MARGIN for e in es)
        gp = ground(a, a.x, a.y, mirror)
        return gp is not None and any(
            math.dist(gp, e.position_at(t)[:2]) <= (CLICK_BUILDING if e.building else CLICK_UNIT) for e in es)

    sel_truth = []
    for s in p.selections:
        o = p.orders[s.order]
        g0 = p.orders[s.order - 1].tick / TPS if s.order else 0.0
        how, keys = selection_input(window(g0, o.tick / TPS + MATCH), lambda a: on_receivers(a, o.receivers))
        res.how[how] += 1
        sel_truth.append((s, how, keys))

    known = {"click", "group", "key"}
    res.idle_key = idle_key if idle_key is not None else _most_common(
        keys[0] for s, how, keys in sel_truth if s.idle_villager and how == "key")
    for s, how, keys in sel_truth:
        real_kb = (how in ("group", "key")) if how in known else None
        res.scores["recalls"].add(s.recall, how == "group" if how in known else None)
        if s.production:
            res.scores["prod_offscreen"].add(s.offscreen, real_kb)
        if s.army:
            res.scores["army_offscreen"].add(s.offscreen, real_kb)
        if game.idle_known:
            res.scores["idle_villager"].add(
                s.idle_villager, (how == "key" and res.idle_key in keys) if how in known else None)

    # camera jumps
    jumps = []
    for j in p.jumps:
        g0 = (j.before.tick + mx.LAG) / TPS - BEFORE_JUMP
        g1 = (j.after.tick + mx.LAG) / TPS
        cause, key = jump_cause(window(g0, g1), on_minimap)
        jumps.append((j, cause, key))
        res.causes[(j.lands, cause if cause != "key" else f"key 0x{key:02X}")] += 1
    res.base_key = base_key if base_key is not None else _most_common(
        key for j, cause, key in jumps if j.lands == "base" and cause == "key")
    for j, cause, key in jumps:
        res.scores["jumps"].add(True, cause != "none")
        res.scores["jumps_to_units"].add(j.lands == "units",
                                         cause == "double" or (cause == "key" and key == res.idle_key))
        res.scores["jumps_to_base"].add(j.lands == "base", cause == "key" and key == res.base_key)
    # double-taps the jumps missed count against jumps' recall
    jump_s = sorted(clock.log((j.after.tick + mx.LAG) / TPS) for j in p.jumps)
    for a in acts:
        if a.kind == "double" and order_s and clock.log(order_s[0]) <= a.t / 1000 <= clock.log(order_s[-1]):
            i = bisect.bisect_left(jump_s, a.t / 1000)
            if not (i < len(jump_s) and jump_s[i] - a.t / 1000 <= 1.0):
                res.scores["jumps"].real += 1
    return res


def _most_common(values) -> int | None:
    c = Counter(values)
    return c.most_common(1)[0][0] if c else None


# ---------------------------------------------------------------- report

def _pct(v: float | None) -> str:
    return "-" if v is None else f"{v:.0%}"


def table(scores: dict[str, Score]) -> list[str]:
    rows = [f"  {'measure':16} {'flagged':>8} {'real':>6} {'both':>6} {'precision':>10} {'recall':>8} "
            f"{'unclear':>8}  verdict"]
    for m, s in scores.items():
        rows.append(f"  {m:16} {s.flagged:>8} {s.real:>6} {s.both:>6} {_pct(s.precision):>10} {_pct(s.recall):>8} "
                    f"{s.unclear:>8}  {s.verdict}")
    return rows


def report(r: Result) -> list[str]:
    if r.note:
        return [f"{r.name}: {r.note}"]
    c = r.clock
    out = [f"{r.name}: player {r.player}; {c.paired}/{c.clicks} right-clicks paired with orders; "
           f"{len(c.pieces)} clock offset(s) {[round(d, 2) for _s, d in c.pieces]}"]
    if r.camera_error:
        out.append(f"  camera: right-clicks in view land a median {r.camera_error[0]} m from their target "
                   f"({r.camera_error[1]} m with the screen mirrored{'; mirrored is better' if r.mirrored else ''})")
    out.append(f"  minimap area (window pixels): {r.minimap_area or 'unknown (fewer than 5 minimap right-clicks)'}")
    out.append("  selections made by: " + ", ".join(f"{k} {n}" for k, n in r.how.most_common()))
    out.append(f"  keys: idle villager {_vk(r.idle_key)}, base {_vk(r.base_key)}")
    out.append("  jump causes: " + ", ".join(f"{lands or 'elsewhere'}/{cause} {n}"
                                             for (lands, cause), n in r.causes.most_common(12)))
    return out + table(r.scores)


def _vk(vk: int | None) -> str:
    if vk is None:
        return "unknown"
    return f"0x{vk:02X}" + (f" '{chr(vk)}'" if 0x30 <= vk <= 0x5A else "")


def games_in(log: Path, events: list[list]) -> list[tuple[Path, float, float]]:
    """(saved replay, log ms after the previous one, log ms when saved) for each replay the logger copied."""
    out, start = [], -math.inf
    for e in events:
        if e[0] == "r":
            out.append((log.with_name(e[2]), start, e[1]))
            start = e[1]
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("logs", nargs="+", type=Path, help="input logs from tools/input_logger.py")
    ap.add_argument("--rec", type=Path, help="check this replay against the whole (single) log")
    ap.add_argument("--player", help="player name (default: the one whose orders pair with the right-clicks)")
    ap.add_argument("--idle-key", type=lambda s: int(s, 0), help="idle-villager key as a virtual-key code, e.g. 0xBE")
    ap.add_argument("--base-key", type=lambda s: int(s, 0), help="town-centre key as a virtual-key code, e.g. 0x48")
    args = ap.parse_args()
    if args.rec and len(args.logs) != 1:
        ap.error("--rec takes one log")
    total = {m: Score() for m in MEASURES}
    for log in args.logs:
        _header, events = il.read_log(log)
        acts = il.actions(events)
        games = [(args.rec, -math.inf, math.inf)] if args.rec else games_in(log, events)
        if not games:
            print(f"{log.name}: no replay saved while logging (pass --rec)")
        for rec, t0, t1 in games:
            r = validate([a for a in acts if t0 < a.t <= t1], rec, ROOT / "recordings" / f"{rec.stem}.rlog",
                         args.player, args.idle_key, args.base_key)
            print("\n".join(report(r)))
            for m, s in r.scores.items():
                total[m] += s
    print("all games")
    print("\n".join(table(total)))


if __name__ == "__main__":
    main()
