"""Player mechanics inferred from a replay's orders and camera: selection, control groups, hotkeys.

Usage:
    python tools/mechanics.py path/to/replay.rec [...]    (needs recordings/<name>.rlog)

The .rec holds no selection, control-group or keystroke records (docs/rec-record-types.md), and replay playback does
not rebuild them: Misc_GetSelectedSquads and Misc_GetControlGroupContents report nothing (recorder/probes/fidelity.lua).
What the .rec does hold is every order with the squads or buildings that received it (part of the selection at that
moment) and each player's camera (DCMD_CameraTrack). With the recording's unit positions that gives, per player:

  prod_offscreen   new production selections (train, research, cancel, rally point) whose buildings were not in view
                   at any camera sample since the player's previous order: selected from the keyboard (a control group
                   or a building hotkey), since a building cannot be clicked off-screen.
  prod_multi       production selections of two or more buildings (control group, type select or shift-click).
  army_offscreen   new selections with military squads that were not in view since the previous order (up to a camera
                   jump onto them): a control group, a select-all hotkey or the HUD.
  recalls          new selections of 2+ receivers identical to an earlier, non-adjacent one: a control group recalled,
                   or the same group boxed again.
  minimap_orders   positional orders whose target lies more than 10 m outside the view: right-clicked on the minimap.
  jumps            view-centre moves of 40 m or more between two camera samples (a hotkey or a minimap click;
                   scrolling is slower), split by where they land: on the units of the next order (within 3 s), on the
                   player's own town centre, landmark or keep, elsewhere.
  idle_villager    single idle villagers selected (recorder v6 IS records; None for older recordings), and how many of
                   those selections followed a camera jump onto the villager (the idle-villager key centres on it).

A selection is new when the receivers differ from the previous order's and are not a subset of them (one selection
can issue orders to parts of itself). Orders of one player in one tick count as one.

Camera model: the view is the ground under a 16:9 screen with the record's vertical fov (viewer/model.js
viewFootprint), 4 ticks before the order executes (orders run a few ticks after they are issued). On aoe4_245598603,
321 of 329 build placements, which must be clicked on screen, fall inside that view and 327 within 5 m;
`placed_in_view` reports that check per player and game, and a wider screen than 16:9 lowers it.
"""
from __future__ import annotations

import argparse
import bisect
import math
import re
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import convert  # noqa: E402
import recfile  # noqa: E402
import rlog  # noqa: E402

LAG = 4  # ticks from the camera sample to the order's execution
ASPECT = 16 / 9
FAR = 400.0  # view rays at or above the horizon are cut here (metres)
UNIT_MARGIN = 2.0  # a unit this far outside the view still counts as visible (metres)
BUILDING_MARGIN = 8.0  # buildings: their centre may be off-screen while part of them shows
MINIMAP = 10.0  # an order target further outside the view was clicked on the minimap
JUMP = 40.0  # view-centre move between two camera samples that scrolling does not reach
NEAR = 25.0  # a jump lands on units or a base within this distance
JUMP_ORDER = 3 * recfile.TICKS_PER_SECOND  # the next order counts for a jump within this many ticks
BASE = re.compile(r"town_center|landmark|keep")
NO_SELECTION = {0x99, 0x9A, 0x8B, 0x8F}  # camera, visibility, AI player, broadcast message
PRODUCTION = {0x03, 0x05, 0x0C, 0x10}  # CMD_BuildSquad, CMD_CancelProduction, CMD_RallyPoint, CMD_Upgrade
BUILD = 0x7B  # PCMD_PlaceAndConstructEntities


def rotate(q: tuple[float, float, float, float], v: tuple[float, float, float]) -> tuple[float, float, float]:
    """v rotated by the unit quaternion q = (w, x, y, z)."""
    w, x, y, z = q
    vx, vy, vz = v
    tx, ty, tz = 2 * (y * vz - z * vy), 2 * (z * vx - x * vz), 2 * (x * vy - y * vx)
    return vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)


def _frame(rot: tuple[float, float, float, float], fov: float, aspect: float):
    """The view's forward, up and right axes and the half-screen tangents (horizontal, vertical)."""
    n = math.sqrt(sum(v * v for v in rot))
    q = tuple(v / n for v in rot)
    tv = math.tan(math.radians(fov) / 2)
    return rotate(q, (0, 0, 1)), rotate(q, (0, 1, 0)), rotate(q, (1, 0, 0)), tv * aspect, tv


def _hit(eye: tuple[float, float, float], d: tuple[float, float, float], h: float) -> tuple[float, float]:
    """Where the ray from eye along d meets the plane y = h; rays at or above the horizon stop at FAR."""
    k = min(FAR, (eye[1] - h) / -d[1]) if d[1] < -1e-3 else FAR
    return eye[0] + d[0] * k, eye[2] + d[2] * k


def ground_view(eye: tuple[float, float, float], rot: tuple[float, float, float, float], fov: float,
                height=lambda x, z: 0.0, aspect: float = ASPECT) -> list[tuple[float, float]]:
    """The ground (x, z) at the screen's four corners, where the view rays meet the plane at the terrain height under
    the view centre (viewer/model.js viewFootprint)."""
    f, u, r, th, tv = _frame(rot, fov, aspect)
    h = height(*_hit(eye, f, height(eye[0], eye[2])))
    return [_hit(eye, tuple(f[i] + a * th * r[i] + b * tv * u[i] for i in range(3)), h)
            for a, b in ((-1, -1), (1, -1), (1, 1), (-1, 1))]


def ground_point(eye: tuple[float, float, float], rot: tuple[float, float, float, float], fov: float,
                 sx: float, sy: float, height=lambda x, z: 0.0, aspect: float = ASPECT) -> tuple[float, float]:
    """The ground (x, z) under the screen point (sx, sy), each -1..1 from left to right and bottom to top: the view ray
    meets the plane under the view centre, then three times the plane at the terrain height under the last hit."""
    f, u, r, th, tv = _frame(rot, fov, aspect)
    d = tuple(f[i] + sx * th * r[i] + sy * tv * u[i] for i in range(3))
    p = _hit(eye, d, height(*_hit(eye, f, height(eye[0], eye[2]))))
    for _ in range(3):
        p = _hit(eye, d, height(*p))
    return p


def outside(poly: list[tuple[float, float]], x: float, z: float) -> float:
    """How far (x, z) lies outside the convex quadrilateral poly, in metres along the worst edge; <= 0 inside."""
    area = sum(poly[i][0] * poly[i - 1][1] - poly[i - 1][0] * poly[i][1] for i in range(4))
    turn = 1 if area < 0 else -1
    worst = -math.inf
    for i in range(4):
        (ax, az), (bx, bz) = poly[i - 1], poly[i]
        ex, ez = bx - ax, bz - az
        worst = max(worst, -turn * (ex * (z - az) - ez * (x - ax)) / (math.hypot(ex, ez) or 1.0))
    return worst


@dataclass
class View:
    tick: int
    poly: list[tuple[float, float]]
    centre: tuple[float, float]
    sample: recfile.CameraSample


class Camera:
    """One player's views, in sample-tick order."""

    def __init__(self, samples: list[recfile.CameraSample], height):
        self.views = []
        for s in sorted(samples, key=lambda s: s.tick):
            poly = ground_view(s.eye, s.rot, s.fov, height)
            self.views.append(View(s.tick, poly, (sum(p[0] for p in poly) / 4, sum(p[1] for p in poly) / 4), s))
        self.ticks = [v.tick for v in self.views]

    def at(self, tick: int) -> View | None:
        i = bisect.bisect_right(self.ticks, tick) - 1
        return self.views[i] if i >= 0 else None

    def between(self, t0: int, t1: int) -> list[View]:
        """The view in effect at t0 and every later one sampled up to t1."""
        return self.views[max(0, bisect.bisect_right(self.ticks, t0) - 1):bisect.bisect_right(self.ticks, t1)]

    def jumps(self) -> list[tuple[View, View]]:
        return [(a, b) for a, b in zip(self.views, self.views[1:])
                if math.dist(a.centre, b.centre) >= JUMP]


@dataclass
class Order:
    tick: int
    receivers: frozenset  # ("e", entity id) / ("s", squad id), SCAR ids
    types: frozenset  # command type bytes (recfile.COMMAND_NAMES)


def player_orders(rep: recfile.Replay) -> dict[int, list[Order]]:
    """Each player's orders with receivers, one per tick (that tick's commands merged), keyed by header player id."""
    out: dict[int, list[Order]] = defaultdict(list)
    for t in rep.ticks():
        tick: dict[int, tuple[set, set]] = {}
        for _host, payload in t.blocks:
            for c in recfile.block_commands(payload):
                if len(c) < 26 or c[2] in NO_SELECTION:
                    continue
                ids = {("e", recfile.ENTITY_ID_BASE + i) if k == 1 else ("s", recfile.SQUAD_ID_BASE + i)
                       for k, i in recfile.receivers(c) if k in (1, 2)}
                if ids:
                    recv, types = tick.setdefault(c[3] & 0x7F, (set(), set()))
                    recv |= ids
                    types.add(c[2])
        for pid, (recv, types) in tick.items():
            out[pid].append(Order(t.tick, frozenset(recv), frozenset(types)))
    return out


def selections(orders: list[Order]) -> list[tuple[int, bool]]:
    """(order index, recall) for every order that makes a new selection: receivers that are not a subset of the
    current selection, the last new selection's receivers (one selection can order parts of itself in turn).
    recall: 2+ receivers identical to an earlier order's."""
    out = []
    seen: set[frozenset] = set()
    current = None
    for k, o in enumerate(orders):
        if current is None or not o.receivers <= current:
            out.append((k, len(o.receivers) >= 2 and o.receivers in seen))
            current = o.receivers
        seen.add(o.receivers)
    return out


def _share(n: int, d: int) -> float | None:
    return round(n / d, 3) if d else None


@dataclass
class Selection:
    """A new selection, made for the order at `order` (an index into Player.orders)."""
    order: int
    recall: bool
    production: bool  # a production command to buildings only
    army: bool  # military squads among the receivers
    offscreen: bool  # no receiver in view since the previous order (up to a camera jump onto them)
    jumped: bool  # a camera jump onto the receivers since the previous order
    idle_villager: bool  # a single villager that was idle (always False before recorder v6)


@dataclass
class Jump:
    before: View
    after: View
    lands: str | None  # "units" of the next order, own "base", or None


@dataclass
class Target:
    """A positional order's target, and how far outside the view it lay (None without a view)."""
    tick: int
    pos: tuple[float, float]
    outside: float | None

    @property
    def minimap(self) -> bool:
        return self.outside is not None and self.outside > MINIMAP


@dataclass
class Player:
    name: str
    civ: str
    pid: int  # header player id
    idx: int  # recording player index
    camera: Camera
    orders: list[Order]
    selections: list[Selection]
    jumps: list[Jump]
    targets: list[Target]
    placements: list[tuple[int, tuple[float, float], bool]]  # tick, position, inside the view


class Game:
    """One recorded replay with every player's flagged events (the module docstring defines them)."""

    def __init__(self, rec_path: Path, rlog_path: Path):
        self.rep = rep = recfile.load(rec_path)
        self.log = log = convert.parse_rlog(rlog_path)
        self.minutes = rep.duration_seconds / 60
        self._by_id = {e.id: e for e in log.ents}
        self._by_squad: dict[int, list[convert.Ent]] = defaultdict(list)
        for e in log.ents:
            if e.squad:
                self._by_squad[e.squad].append(e)
        self.idle_known = bool(log.header and log.header["version"] >= 6)
        self._idle: dict[int, list[tuple[float, bool]]] = defaultdict(list)
        if self.idle_known:
            for _kind, r in rlog.read(rlog_path, [rlog.IDLE]):
                self._idle[r.squad].append((r.t, r.idle))

        cams: dict[int, list[recfile.CameraSample]] = defaultdict(list)
        for s in rep.cameras():
            cams[s.pid].append(s)
        orders = player_orders(rep)
        placed: dict[int, list[tuple[int, tuple[float, float]]]] = defaultdict(list)
        for c in rep.commands():
            if c.kind == "build" and c.pos:
                placed[c.pid].append((c.tick, c.pos))
        targets: dict[int, list[tuple[int, tuple[float, float]]]] = defaultdict(list)
        for tick, pid, typ, _queued, n, _kind, pos in rep.orders():
            if pos and n and typ != BUILD:
                targets[pid].append((tick, pos))
        bases = [e for e in log.ents if e.building and BASE.search(e.bp)]
        self.players = []
        for p in convert.match_players(log, rep):
            pid = p["pid"]
            if pid is not None and cams.get(pid):
                self.players.append(self._player(p, Camera(cams[pid], self.height), orders.get(pid, []),
                                                 targets[pid], placed[pid], bases))

    def height(self, x: float, z: float) -> float:
        T = self.log.terrain
        if not T:
            return 0.0
        fx = min(T["cols"] - 1, max(0, (x - T["x0"]) / T["step"]))
        fz = min(T["rows"] - 1, max(0, (z - T["z0"]) / T["step"]))
        c, r = min(T["cols"] - 2, int(fx)), min(T["rows"] - 2, int(fz))
        ax, az, h, i = fx - c, fz - r, T["h"], r * T["cols"] + c
        return ((h[i] * (1 - ax) + h[i + 1] * ax) * (1 - az)
                + (h[i + T["cols"]] * (1 - ax) + h[i + T["cols"] + 1] * ax) * az)

    def members(self, receivers, t: float) -> list[convert.Ent]:
        """The receivers' entities alive at t seconds (squads expanded to their members)."""
        es = (self._by_id.get(i) if k == "e" else None for k, i in receivers)
        out = [e for e in es if e is not None]
        out += [e for k, i in receivers if k == "s" for e in self._by_squad.get(i, ())]
        return [e for e in out if e.alive_at(t)]

    def _idle_at(self, squad: int, t: float) -> bool:
        v = self._idle.get(squad, ())
        i = bisect.bisect_right(v, (t, True)) - 1
        return i >= 0 and v[i][1]

    def _player(self, p: dict, cam: Camera, own: list[Order], targets, placed, bases) -> Player:
        idx, members = p["idx"], self.members

        def visible(receivers, t0: int, t1: int) -> bool:
            for v in cam.between(t0, t1):
                t = max(v.tick, t0) / recfile.TICKS_PER_SECOND
                for e in members(receivers, t):
                    x, z, _hp = e.position_at(t)
                    if outside(v.poly, x, z) <= (BUILDING_MARGIN if e.building else UNIT_MARGIN):
                        return True
            return False

        def lands_on(view: View, es: list[convert.Ent], t: float) -> bool:
            return any(math.dist(view.centre, e.position_at(t)[:2]) < NEAR for e in es)

        order_ticks = [o.tick for o in own]
        jumps = []
        for a, b in cam.jumps():
            t = b.tick / recfile.TICKS_PER_SECOND
            j = bisect.bisect_left(order_ticks, b.tick + LAG)
            lands = None
            if (j < len(own) and own[j].tick - b.tick - LAG <= JUMP_ORDER
                    and lands_on(b, members(own[j].receivers, own[j].tick / recfile.TICKS_PER_SECOND), t)):
                lands = "units"
            elif lands_on(b, [e for e in bases if e.alive_at(t) and e.owner_at(t) == idx], t):
                lands = "base"
            jumps.append(Jump(a, b, lands))
        jump_ticks = [j.after.tick for j in jumps]

        sels = []
        for k, recall in selections(own):
            o = own[k]
            t = o.tick / recfile.TICKS_PER_SECOND
            prev = own[k - 1].tick if k else 0
            es = members(o.receivers, t)
            # a camera jump onto the selection since the previous order: it was selected before the jump
            end = o.tick - LAG
            for j in range(bisect.bisect_right(jump_ticks, end) - 1, bisect.bisect_right(jump_ticks, prev) - 1, -1):
                if lands_on(jumps[j].after, es, t):
                    end = jumps[j].before.tick
                    break
            sels.append(Selection(
                order=k, recall=recall,
                production=bool(o.types & PRODUCTION) and all(kind == "e" for kind, _i in o.receivers),
                army=any(convert.classify(e.bp, e.building) in convert.MILITARY for e in es),
                offscreen=not visible(o.receivers, prev - LAG, end),
                jumped=end < o.tick - LAG,
                idle_villager=(self.idle_known and len(o.receivers) == 1 and len(es) == 1
                               and convert.classify(es[0].bp, False) == "villager"
                               and self._idle_at(es[0].squad, t - 0.5))))

        def off_view(tick: int, pos: tuple[float, float]) -> float | None:
            v = cam.at(tick - LAG)
            return outside(v.poly, *pos) if v else None

        return Player(
            name=p["name"], civ=p["civ"], pid=p["pid"], idx=idx, camera=cam, orders=own, selections=sels, jumps=jumps,
            targets=[Target(tick, pos, off_view(tick, pos)) for tick, pos in targets],
            placements=[(tick, pos, (d := off_view(tick, pos)) is not None and d <= 0) for tick, pos in placed])


def summary(p: Player, minutes: float, idle_known: bool) -> dict:
    """One player's mechanics (the module docstring defines each field)."""
    sels = p.selections
    prod = [s for s in sels if s.production]
    army = [s for s in sels if s.army]
    idle = [s for s in sels if s.idle_villager]
    return {
        "name": p.name, "civ": p.civ, "minutes": round(minutes, 1),
        "orders_per_min": round(len(p.orders) / minutes, 1),
        "selections_per_min": round(len(sels) / minutes, 1),
        "prod_selections": len(prod),
        "prod_offscreen": _share(sum(s.offscreen for s in prod), len(prod)),
        "prod_multi": _share(sum(len(p.orders[s.order].receivers) >= 2 for s in prod), len(prod)),
        "army_selections": len(army),
        "army_offscreen": _share(sum(s.offscreen for s in army), len(army)),
        "recalls_per_min": round(sum(s.recall for s in sels) / minutes, 1),
        "positional_orders": len(p.targets),
        "minimap_orders": _share(sum(t.minimap for t in p.targets), len(p.targets)),
        "jumps_per_min": round(len(p.jumps) / minutes, 1),
        "jumps_to_units": _share(sum(j.lands == "units" for j in p.jumps), len(p.jumps)),
        "jumps_to_base": _share(sum(j.lands == "base" for j in p.jumps), len(p.jumps)),
        "idle_villager": len(idle) if idle_known else None,
        "idle_villager_jump": _share(sum(s.jumped for s in idle), len(idle)) if idle_known else None,
        "placed": len(p.placements),
        "placed_in_view": _share(sum(inside for _t, _p, inside in p.placements), len(p.placements)),
    }


def profile(rec_path: Path, rlog_path: Path) -> list[dict]:
    """Mechanics per player of one recorded replay (the module docstring defines each field)."""
    game = Game(rec_path, rlog_path)
    return [summary(p, game.minutes, game.idle_known) for p in game.players]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("replays", nargs="+", type=Path, help=".rec files recorded to recordings/<name>.rlog")
    args = ap.parse_args()
    for rec in args.replays:
        rows = profile(rec, ROOT / "recordings" / (rec.stem + ".rlog"))
        print(rec.stem)
        if not rows:
            print("  no player with a camera track")
            continue
        keys = [k for k in rows[0] if k not in ("name", "civ")]
        width = max(len(k) for k in keys)
        print(f"  {'':{width}}  " + "  ".join(f"{r['name'][:14]:>14}" for r in rows))
        print(f"  {'':{width}}  " + "  ".join(f"{r['civ'][:14]:>14}" for r in rows))
        for k in keys:
            print(f"  {k:{width}}  " + "  ".join(f"{'-' if r[k] is None else r[k]!s:>14}" for r in rows))


if __name__ == "__main__":
    main()
