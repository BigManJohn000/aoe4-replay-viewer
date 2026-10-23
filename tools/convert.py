"""Convert a recorder log (.rlog) plus its .rec into a timeline the viewer loads.

Usage:
    python tools/convert.py recordings/aoe4_245598603.rlog [replays/aoe4world/aoe4_245598603.rec]

Writes viewer/data/<name>.js (assigns into window.REPLAY_DATA so it loads from file://)
and refreshes viewer/data/index.js and the trends page's numbers (tools/trends.py).
"""
from __future__ import annotations

import argparse
import bisect
import functools
import json
import math
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import recfile  # noqa: E402
import rlog  # noqa: E402
import trends  # noqa: E402

DATA_DIR = ROOT / "viewer" / "data"

PLAYER_COLORS = ["#3b82f6", "#ef4444", "#eab308", "#22c55e", "#14b8a6", "#a855f7", "#f97316", "#ec4899"]
RESOURCES = ("food", "wood", "gold", "stone", "oliveoil")


def load_units() -> dict:
    """The unit classification shared with the viewer: the JSON object viewer/units.js assigns to window.RV_UNITS."""
    text = (ROOT / "viewer" / "units.js").read_text(encoding="utf-8")
    return json.loads(text[text.index("= {") + 2:text.rindex("}") + 1])


UNITS = load_units()
ATTACHMENT = re.compile(UNITS["attachment"])
UNIT_RULES = [(re.compile(rx), cat) for rx, cat, _type in UNITS["rules"]]
NON_COMBAT = {"livestock", "attachment", "other"}
MILITARY = set(UNITS["military"])
APPROACH_LEAD = 30.0  # seconds before a fight over which each side's movement toward it is measured
AGES = {"feudal_age": "Feudal Age", "castle_age": "Castle Age", "imperial_age": "Imperial Age"}
# Economy techs shown in the viewers' tech table: key (attribName without upgrade_/econ_/town-center prefix and civ
# suffix) → the tier hint added to the name. The names come from the vendored game data (viewer/stats.js), so renamed
# techs follow the game (gold III, once Acid Distillation, is Shaft Mining in the current data).
ECO_TECHS = {
    "wheelbarrow_1": "",
    "villager_hunting_gear_1": "",
    "villager_health": "",
    "resource_food_harvest_rate_2": "food II",
    "resource_food_harvest_rate_3": "food III",
    "resource_food_harvest_rate_4": "food IV",
    "resource_wood_harvest_rate_2": "wood II",
    "resource_wood_harvest_rate_3": "wood III",
    "resource_wood_harvest_rate_4": "wood IV",
    "resource_gold_harvest_rate_2": "gold II",
    "resource_gold_harvest_rate_3": "gold III",
    "resource_gold_harvest_rate_4": "gold IV",
    "resource_wood_fell_rate_1": "",
}


def load_tech_names() -> dict:
    """Technology attribName → in-game name, from viewer/stats.js (window.RV_STATS, built by build-stats.mjs)."""
    text = (ROOT / "viewer" / "stats.js").read_text(encoding="utf-8")
    return {k: v["n"] for k, v in json.loads(text[text.index("= {") + 2:text.rindex("}") + 1])["techs"].items()}


TECH_NAMES = load_tech_names()


def tech_name(name: str) -> str | None:
    """In-game name of upgrade `name`, matching its longest known attribName prefix (civ variants share names)."""
    tk = name.split("_")
    for n in range(len(tk), 2, -1):
        hit = TECH_NAMES.get("_".join(tk[:n]))
        if hit:
            return hit
    return None


# Neutral map objects (recorder GN records), first match wins. Anything else with wood/food in it is a tree.
GAIA_RULES = [
    ("relic", r"relic"),
    ("sacred", r"holy_site|sacred"),
    ("trade", r"trade_post"),
    ("gold", r"gold"),
    ("stone", r"stone"),
    ("berry", r"berry|forage"),
    ("fish", r"fish"),
    ("boar", r"boar|elephant|rhino"),
    ("wolf", r"wolf|bear|tiger|leopard"),
    ("sheep", r"herdable|corpse"),  # carcasses of slaughtered sheep, cattle and reindeer, eaten where they fell
    ("deer", r"huntable"),
    ("stealth", r"stealth"),
]


def classify(bp: str, building: bool) -> str:
    name = bp.lower()
    if ATTACHMENT.search(name):
        return "attachment"
    if building or name.startswith("building_"):
        return "building"
    for rx, cat in UNIT_RULES:
        if rx.search(name):
            return cat
    return "unit"


def loss_bucket(kind: str) -> str | None:
    """Fight-loss category shown in the viewer: army, villagers or buildings."""
    if kind == "villager":
        return "vill"
    if kind == "building":
        return "bldg"
    return "army" if kind in MILITARY else None


def tech_info(name: str) -> tuple[str, str] | None:
    """(label, kind) for age-ups and economy techs; None for everything else."""
    if name in AGES:
        return AGES[name], "age"
    if not name.startswith("upgrade_"):
        return None
    key = re.sub(r"^upgrade_(econ_|unit_town_center_)?", "", name)
    key = re.sub(r"_[a-z]{3}(_ha_[a-z0-9]+)?$", "", key)  # civ suffix, e.g. _mon, _hre_ha_01, _mon_ha_gol
    if key in ECO_TECHS:
        label = tech_name(name) or key.replace("_", " ").capitalize()
        return (f"{label} ({ECO_TECHS[key]})" if ECO_TECHS[key] else label), "eco"
    if name.startswith("upgrade_econ_"):
        return tech_name(name) or key.replace("_", " ").capitalize(), "eco"
    return None


def tech_list(log: Log, by_id: dict[int, Ent]) -> list[list]:
    """[t, player, label, kind] for every age-up and eco tech whose researching building is known."""
    out = []
    for u in log.upgrades:
        info = tech_info(u["fields"].get("upgrade", "")[1:])
        ex = by_id.get(entity_ref(u["fields"].get("executer")))
        if info and ex:
            out.append([u["t"], ex.owner, *info])
    out.sort(key=lambda r: r[0])
    return out


def gaia_category(bp: str, amount: int) -> str:
    for kind, rx in GAIA_RULES:
        if re.search(rx, bp):
            return kind
    return "tree" if amount > 0 else "other"


@dataclass
class Ent:
    id: int
    owner: int
    bp: str
    maxhp: int
    building: bool
    squad: int
    spans: list[list] = field(default_factory=list)   # [start, end|None]
    track: list[float] = field(default_factory=list)  # t, x, z, hp repeated
    owners: list[list] = field(default_factory=list)
    vision: list[float] = field(default_factory=list)  # t, mask repeated
    killed: bool = False
    killer: int | None = None

    @property
    def born(self) -> float:
        return self.spans[0][0]

    @property
    def died(self) -> float | None:
        return self.spans[-1][1]

    @functools.cached_property
    def track_times(self) -> list[float]:
        return self.track[0::4]  # only read after parsing, when the track is complete

    def position_at(self, t: float) -> tuple[float, float, float]:
        tr = self.track
        i = max(0, bisect.bisect_right(self.track_times, t) - 1)
        return tr[4 * i + 1], tr[4 * i + 2], tr[4 * i + 3]

    def alive_at(self, t: float) -> bool:
        return any(s <= t and (e is None or t <= e) for s, e in self.spans)


@dataclass
class GaiaEnt:
    id: int
    bp: str
    x: float
    z: float
    amount: int                                         # at first sighting; -1 if unknown
    spans: list[list] = field(default_factory=list)     # [start, end|None]
    amounts: list[float] = field(default_factory=list)  # t, amount repeated
    track: list[float] = field(default_factory=list)    # t, x, z repeated (animals, relics)
    killed: float | None = None                         # K record time: animal killed, berry bush picked clean


@dataclass
class Log:
    header: dict
    players: dict[int, dict]
    ents: list[Ent]
    attacks: list[tuple[float, int, int]]
    kills: list[dict]
    upgrades: list[dict]
    constructions: list[dict]
    stats: dict[int, list[list]]
    costs: dict[tuple[int, str], dict]
    orders: dict[int, list]
    samples: list[float]
    errors: list[str]
    gaia: dict[int, GaiaEnt]
    terrain: dict | None
    jobs: dict[int, list[list]]    # idx -> [t, food, wood, gold, stone, other] villager counts (v4+)


def parse_rlog(path: Path) -> Log:
    header = None
    players: dict[int, dict] = {}
    live: dict[int, Ent] = {}
    removed: dict[int, Ent] = {}
    ents: list[Ent] = []
    attacks, kills, upgrades, constructions = [], [], [], []
    stats: dict[int, list[list]] = defaultdict(list)
    costs: dict[tuple[int, str], dict] = {}
    orders: dict[int, list] = defaultdict(list)
    samples: list[float] = []
    jobs: dict[int, list[list]] = defaultdict(list)
    errors: list[str] = []
    gaia: dict[int, GaiaEnt] = {}
    terrain: dict | None = None
    heights: dict[int, list[float]] = {}

    for kind, r in rlog.read(path):
        if kind == rlog.HDR:
            header = {"version": r.version, "start": r.start, "width": r.width, "length": r.length,
                      "players": r.players}
        elif kind == rlog.PLAYER:
            players[r.idx] = {"idx": r.idx, "pid": r.pid, "race": r.race, "team": r.team}
        elif kind == rlog.ENT_NEW:
            e = removed.pop(r.id, None)
            if e is None:
                e = Ent(r.id, r.owner, r.bp, r.maxhp, r.building, r.squad)
                e.owners.append([r.t, e.owner])
                ents.append(e)
            elif r.owner != e.owners[-1][1]:  # back under another player: a sacred site taken by the other side
                e.owners.append([r.t, r.owner])
            e.spans.append([r.t, None])
            e.track += [r.t, r.x, r.z, r.hp]
            live[r.id] = e
        elif kind == rlog.ENT_STATE:
            e = live.get(r.id)
            if e:
                e.track += [r.t, r.x, r.z, r.hp]
        elif kind == rlog.ENT_OWNER:
            e = live.get(r.id)
            if e:
                e.owners.append([r.t, r.owner])
        elif kind == rlog.ATTACK:
            attacks.append((r.t, r.attacker, r.target))
        elif kind == rlog.VISION:
            e = live.get(r.id)
            if e:
                e.vision += [r.t, r.mask]
        elif kind == rlog.ENT_GONE:
            e = live.pop(r.id, None)
            if e:
                e.spans[-1][1] = r.t
                removed[e.id] = e
        elif kind == rlog.DEST:
            orders[r.squad].append([r.t, r.x, r.z])
        elif kind == rlog.COST:
            costs[(r.owner, r.bp)] = {"squad": r.squad, "cost": rlog.cost_values(r.cost)}
        elif kind == rlog.STATS:
            stats[r.idx].append([r.t, *r.res, r.pop])
        elif kind == rlog.JOBS:
            jobs[r.idx].append([r.t, *r.counts])
        elif kind in (rlog.KILL, rlog.UPGRADE, rlog.CONSTRUCTION):
            {rlog.KILL: kills, rlog.UPGRADE: upgrades, rlog.CONSTRUCTION: constructions}[kind].append(
                {"t": r.t, "fields": r.fields})
        elif kind == rlog.SAMPLE:
            samples.append(r.t)
        elif kind == rlog.ERROR:
            errors.append(r.text)
        elif kind == rlog.GAIA_NEW:
            if rlog.GAIA_IGNORE.search(r.bp):
                continue
            g = gaia.get(r.id)
            if g is None:
                g = gaia[r.id] = GaiaEnt(r.id, r.bp, r.x, r.z, r.amount)
            elif (r.x, r.z) != (tuple(g.track[-2:]) if g.track else (g.x, g.z)):
                g.track += [r.t, r.x, r.z]  # back in the world elsewhere, e.g. a relic dropped by a dying monk
            g.spans.append([r.t, None])
        elif kind == rlog.GAIA_MOVED:
            g = gaia.get(r.id)
            if g:
                g.track += [r.t, r.x, r.z]
        elif kind == rlog.GAIA_AMOUNT:
            g = gaia.get(r.id)
            if g:
                g.amounts += [r.t, r.amount]
        elif kind == rlog.GAIA_GONE:
            g = gaia.get(r.id)
            if g and g.spans and g.spans[-1][1] is None:
                g.spans[-1][1] = r.t
        elif kind == rlog.HEIGHT_HEADER:
            terrain = {"x0": r.x0, "z0": r.z0, "step": r.step, "cols": r.cols, "rows": r.rows}
        elif kind == rlog.HEIGHT_ROW:
            heights[r.row] = r.heights

    if header is None:
        raise SystemExit(f"{path} has no HDR record; was the recorder injected?")
    if terrain:
        if len(heights) == terrain["rows"] and all(len(r) == terrain["cols"] for r in heights.values()):
            terrain["h"] = [h for row in range(terrain["rows"]) for h in heights[row]]
        else:
            errors.append(f"terrain: {len(heights)} of {terrain['rows']} height rows")
            terrain = None
    return Log(header, players, ents, attacks, kills, upgrades, constructions, stats, costs, orders, samples, errors,
               gaia, terrain, jobs)


def entity_ref(v: str | None) -> int | None:
    if v and v[0] == "e" and v[1:].isdigit():
        return int(v[1:])
    return None


def resolve_kills(log: Log, by_id: dict[int, Ent]) -> list[dict]:
    """Mark killed entities and credit each kill to the killer the game reports (killer= in the K record). Kills
    without one go to the last unit seen attacking the victim within 3 s; units that died by their own hand (deleted,
    a fire ship exploding) get no killer, nor do killers the recorder never saw.

    Map objects die too: a wolf when it is shot; a hunted deer when its carcass is eaten up (no killer, ~2–10 s
    before GX; its shot leaves no record but its first amount drop, ~40–360 s earlier in aoe4_256829909); a berry bush
    when its last food is picked (the empty bush lingers before GX, ~300 s in aoe4_256829909). Their K time goes on the
    GaiaEnt (`killed`); they stay out of the returned list, which is player units."""
    attackers_of: dict[int, list[tuple[float, int]]] = defaultdict(list)
    for t, a, b in log.attacks:
        attackers_of[b].append((t, a))
    out = []
    for k in log.kills:
        victim = entity_ref(k["fields"].get("victim"))
        e = by_id.get(victim) if victim is not None else None
        if e is None:
            g = log.gaia.get(victim) if victim is not None else None
            if g is not None and g.killed is None:
                g.killed = k["t"]
            continue  # otherwise a victim the recorder never kept (GAIA_IGNORE, never sighted)
        e.killed = True
        if e.spans[-1][1] is None or e.spans[-1][1] > k["t"]:
            e.spans[-1][1] = k["t"]
        if "killer" in k["fields"]:
            killer = entity_ref(k["fields"]["killer"])
            if killer == victim or killer not in by_id:
                killer = None
        else:
            killer = None
            for t, a in reversed(attackers_of.get(victim, ())):
                if t <= k["t"] + 0.01 and k["t"] - t <= 3.0:
                    killer = a
                    break
        e.killer = killer
        out.append({"t": k["t"], "victim": victim, "killer": killer})
    return out


def entity_value(e: Ent, costs: dict[tuple[int, str], dict]) -> float:
    c = costs.get((e.owner, e.bp))
    if not c:
        return 0.0
    total = sum(v for k, v in c["cost"].items() if k.lower() in RESOURCES)
    return total / c["squad"] if c["squad"] > 0 else total


def detect_fights(log: Log, values: dict[int, float], world: float) -> list[dict]:
    """Cluster damage and deaths in space-time into fights."""
    events = []  # (t, x, z, owner, damage, entity id, died)
    for e in log.ents:
        if classify(e.bp, e.building) in NON_COMBAT:
            continue
        tr = e.track
        for i in range(4, len(tr), 4):
            dmg = tr[i - 1] - tr[i + 3]
            if dmg > 0.5 and tr[i] - tr[i - 4] <= 1.01:
                events.append((tr[i], tr[i + 1], tr[i + 2], e.owner, dmg, e.id, False))
        if e.killed:
            x, z, _ = e.position_at(e.died)
            events.append((e.died, x, z, e.owner, 0.0, e.id, True))
    events.sort()

    radius = world * 0.07
    gap = 15.0
    clusters: list[dict] = []
    active: list[dict] = []
    for ev in events:
        t, x, z = ev[0], ev[1], ev[2]
        active = [f for f in active if t - f["end"] <= gap]
        best, best_d = None, radius
        for f in active:
            d = math.hypot(f["cx"] - x, f["cz"] - z)
            if d <= best_d:
                best, best_d = f, d
        if best is None:
            best = {"start": t, "end": t, "cx": x, "cz": z, "w": 0.0, "events": []}
            active.append(best)
            clusters.append(best)
        w = max(1.0, ev[4]) + (100.0 if ev[6] else 0.0)
        best["w"] += w
        best["cx"] += (x - best["cx"]) * w / best["w"]
        best["cz"] += (z - best["cz"]) * w / best["w"]
        best["end"] = t
        best["events"].append(ev)

    by_id = {e.id: e for e in log.ents}
    military_by_owner: dict[int, list[Ent]] = defaultdict(list)
    for e in log.ents:
        if classify(e.bp, e.building) in MILITARY:
            military_by_owner[e.owner].append(e)
    attacks_by_time = sorted(log.attacks)
    times = [a[0] for a in attacks_by_time]
    fights = []
    for f in clusters:
        evs = f["events"]
        unit_deaths = [ev for ev in evs if ev[6] and classify(by_id[ev[5]].bp, by_id[ev[5]].building) != "building"]
        dmg_total = sum(ev[4] for ev in evs)
        if len(unit_deaths) < 2 and dmg_total < 500:
            continue
        losses: dict[int, dict] = defaultdict(lambda: {"damage": 0.0, "deaths": 0, "value": 0.0, "units": defaultdict(int),
                                                       "army": 0.0, "vill": 0.0, "bldg": 0.0})
        for t, x, z, owner, dmg, eid, died in evs:
            L = losses[owner]
            L["damage"] += dmg
            if died:
                L["deaths"] += 1
                L["value"] += values.get(eid, 0.0)
                L["units"][by_id[eid].bp] += 1
                bucket = loss_bucket(classify(by_id[eid].bp, by_id[eid].building))
                if bucket:
                    L[bucket] += values.get(eid, 0.0)
        lo = bisect.bisect_left(times, f["start"] - 2)
        hi = bisect.bisect_right(times, f["end"] + 2)
        participants = {ev[3] for ev in evs}
        units = set()
        for t, a, b in attacks_by_time[lo:hi]:
            ea, eb = by_id.get(a), by_id.get(b)
            if ea is None or eb is None:
                continue
            bx, bz, _ = eb.position_at(t)
            if math.hypot(bx - f["cx"], bz - f["cz"]) <= radius * 1.5:
                participants.add(ea.owner)
                units.add(a)
                units.add(b)
        r = max(15.0, max(math.hypot(ev[1] - f["cx"], ev[2] - f["cz"]) for ev in evs))
        engaged: dict[int, float] = defaultdict(float)  # value of each side's army units that dealt or took damage
        for u in units:
            eu = by_id[u]
            if classify(eu.bp, eu.building) in MILITARY:
                engaged[eu.owner] += values.get(u, 0.0)
        moved = {}  # average distance each side's nearby army closed toward the fight in the lead-up
        t0 = f["start"]
        for o in participants:
            closed = []
            for e in military_by_owner.get(o, ()):
                if not (e.alive_at(t0) and e.alive_at(t0 - APPROACH_LEAD)):
                    continue
                x1, z1, _ = e.position_at(t0)
                d1 = math.hypot(x1 - f["cx"], z1 - f["cz"])
                if d1 > r * 2:
                    continue
                x0, z0, _ = e.position_at(t0 - APPROACH_LEAD)
                closed.append(math.hypot(x0 - f["cx"], z0 - f["cz"]) - d1)
            if closed:
                moved[str(o)] = [len(closed), round(sum(closed) / len(closed), 1)]
        fights.append({
            "start": round(f["start"], 3), "end": round(f["end"], 3),
            "x": round(f["cx"], 1), "z": round(f["cz"], 1), "radius": round(r, 1),
            "participants": sorted(participants),
            "units": sorted(units),
            "losses": {str(o): {"damage": round(v["damage"]), "deaths": v["deaths"], "value": round(v["value"]),
                                "army": round(v["army"]), "vill": round(v["vill"]), "bldg": round(v["bldg"]),
                                "units": dict(v["units"])} for o, v in losses.items()},
            "engaged": {str(o): round(v) for o, v in engaged.items()},
            "moved": moved,
            "deaths": sum(v["deaths"] for v in losses.values()),
            "damage": round(dmg_total),
        })
    fights.sort(key=lambda fi: fi["start"])
    for i, fi in enumerate(fights, 1):
        fi["id"] = i
    return fights


def army_series(log: Log, values: dict[int, float], duration: float, step: float = 5.0) -> dict:
    n = int(duration // step) + 1
    series = {str(p): {"military": [0] * n, "villagers": [0] * n, "armyValue": [0] * n} for p in log.players}
    for e in log.ents:
        cat = classify(e.bp, e.building)
        if cat not in MILITARY and cat != "villager":
            continue
        s = series.get(str(e.owner))
        if s is None:
            continue
        for start, end in e.spans:
            end = duration if end is None else end
            i0 = max(0, math.ceil(start / step))
            i1 = min(n - 1, int(end // step))
            for i in range(i0, i1 + 1):
                if cat == "villager":
                    s["villagers"][i] += 1
                else:
                    s["military"][i] += 1
                    s["armyValue"][i] += values.get(e.id, 0.0)
    for s in series.values():
        s["armyValue"] = [round(v) for v in s["armyValue"]]
    return {"step": step, "players": series}


def match_players(log: Log, rep: recfile.Replay) -> list[dict]:
    """SCAR player index -> .rec player: by the replay player id the recorder logs, else by civ and team (display
    names are not readable in SCAR)."""
    unused = list(rep.players)
    out = []
    for idx in sorted(log.players):
        p = log.players[idx]
        pick = next((r for r in unused if r.pid == p["pid"]), None) \
            or next((r for r in unused if r.civ == p["race"] and r.team == p["team"]), None) \
            or next((r for r in unused if r.civ == p["race"]), None) \
            or (unused[0] if unused else None)
        if pick:
            unused.remove(pick)
        out.append({
            "idx": idx,
            "pid": pick.pid if pick else None,
            "name": pick.name if pick else f"Player {idx}",
            "civ": pick.civ if pick else p["race"],
            "team": p["team"],
            "color": PLAYER_COLORS[(idx - 1) % len(PLAYER_COLORS)],
        })
    return out


def camera_tracks(rep: recfile.Replay, players: list[dict]) -> dict:
    """Each player's camera from the replay's DCMD_CameraTrack records, keyed by SCAR player index:
    {"fov": the record's u16 / 100, "rots": distinct [w, x, y, z] orientations, "track": flat [t, x, y, z, rot index]}
    with t the sample time in seconds and x, y, z the eye in metres (world x, y up, z). Every sample is kept,
    including the jumps the game's own replay camera skips (recfile.py)."""
    idx_of = {p["pid"]: p["idx"] for p in players if p["pid"] is not None}
    out: dict[str, dict] = {}
    rot_index: dict[str, dict[tuple, int]] = {}
    for s in sorted(rep.cameras(), key=lambda s: (s.pid, s.tick)):  # records run 2-9 ticks late, unevenly
        idx = idx_of.get(s.pid)
        if idx is None:
            continue
        cam = out.setdefault(str(idx), {"fov": s.fov, "rots": [], "track": []})
        rots = rot_index.setdefault(str(idx), {})
        rot = tuple(round(v, 4) for v in s.rot)
        if rot not in rots:
            rots[rot] = len(cam["rots"])
            cam["rots"].append(list(rot))
        cam["track"] += [s.tick / recfile.TICKS_PER_SECOND, round(s.eye[0], 2), round(s.eye[1], 2),
                         round(s.eye[2], 2), rots[rot]]
    return out


# Conversion abilities (aoe4world abilities/all.json pbgid): the monk's area conversion, cast on itself, and the
# Abbasid imam's single-target one.
CONVERSION_ABILITIES = {192685: "area", 2035316: "target"}


def conversion_casts(rep: recfile.Replay, log: Log) -> list[list]:
    """[t, caster entity id, target entity id or 0 (area)] for every conversion order in the replay. Casters are the
    living members of the ordered squads; a squad target resolves to its first member alive at t."""
    by_squad: dict[int, list] = defaultdict(list)
    for e in log.ents:
        if e.squad:
            by_squad[e.squad].append(e)
    by_id = {e.id: e for e in log.ents}

    def alive(e, t: float) -> bool:
        return any(a <= t and (b is None or t < b) for a, b in e.spans)

    out = []
    for a in rep.abilities():
        kind = CONVERSION_ABILITIES.get(a.pbgid)
        if kind is None:
            continue
        t = a.time
        casters = [e for c in a.casters for e in (by_squad.get(c, []) if a.squads else [by_id.get(c)]) if e and alive(e, t)]
        target = 0
        if kind == "target" and a.target and a.target[0] in ("entity", "squad"):
            pool = [by_id.get(a.target[1])] if a.target[0] == "entity" else by_squad.get(a.target[1], [])
            target = next((e.id for e in pool if e and alive(e, t)), 0)
        out += [[t, e.id, target] for e in casters]
    return out


def flat_track(e: Ent) -> list:
    out = []
    tr = e.track
    for i in range(0, len(tr), 4):
        out += [round(tr[i], 3), tr[i + 1], tr[i + 2], int(tr[i + 3])]
    return out


def gaia_data(log: Log) -> dict:
    """Neutral map objects as compact rows: [id, type, x, z, amount, spans, amounts|0, track|0, killed|0]."""
    types: dict[str, int] = {}
    kinds: list[list[str]] = []
    rows = []
    for g in log.gaia.values():
        if g.bp not in types:
            types[g.bp] = len(kinds)
            kinds.append([g.bp, gaia_category(g.bp, g.amount)])
        rows.append([g.id, types[g.bp], g.x, g.z, g.amount, [v for s in g.spans for v in s],
                     g.amounts or 0, g.track or 0, g.killed or 0])
    return {"types": kinds, "ents": rows}


SUMMARY_DIR = ROOT / "replays" / "aoe4world"
SCORE_KEYS = ("total", "military", "economy", "technology", "society")


def load_summary(rlog: Path, rec_path: Path, players: list[dict]) -> dict | None:
    """The compact slice of the aoe4world match summary (<stem>.summary.json beside the .rec, else in
    replays/aoe4world/ under the rlog's stem) that the recording itself lacks: how the game ended, map and mode,
    wall-clock times, and per player the account id, result, APM, scores and resource totals. Players are keyed by the
    SCAR index used everywhere else, matched by display name, then by team. None when there is no summary file."""
    path = next((p for p in (rec_path.with_suffix(".summary.json"), SUMMARY_DIR / f"{rlog.stem}.summary.json")
                 if p.is_file()), None)
    if not path:
        return None
    s = json.loads(path.read_text(encoding="utf-8"))
    sp = list(s.get("players") or [])
    picked: dict[int, dict] = {}
    for by in (lambda a, b: a["name"] == b.get("name"), lambda a, b: a["team"] == b.get("team")):
        for p in players:
            if p["idx"] in picked:
                continue
            hits = [q for q in sp if by(p, q) and not any(q is r for r in picked.values())]
            if len(hits) == 1:
                picked[p["idx"]] = hits[0]
    out_players = {}
    for idx, q in picked.items():
        row = {"profileId": q.get("profileId"), "result": q.get("result"), "apm": q.get("apm"),
               "scores": {k: q["scores"][k] for k in SCORE_KEYS if k in (q.get("scores") or {})},
               "gathered": q.get("totalResourcesGathered"), "spent": q.get("totalResourcesSpent")}
        out_players[str(idx)] = {k: v for k, v in row.items() if v not in (None, {})}
    block = {"winReason": s.get("winReason"), "mode": s.get("leaderboard"),
             "map": {k: s.get(f) for k, f in (("name", "mapName"), ("biome", "mapBiome"), ("size", "mapSize"))},
             "startedAt": s.get("startedAt"), "finishedAt": s.get("finishedAt"), "players": out_players}
    return {k: v for k, v in block.items() if v not in (None, {})}


def convert(rlog: Path, rec_path: Path) -> Path:
    """Build viewer/data/<rlog stem>.js from a recorder log and its replay; returns the output path."""
    rep = recfile.load(rec_path)
    log = parse_rlog(rlog)
    by_id = {e.id: e for e in log.ents}
    kills = resolve_kills(log, by_id)
    values = {e.id: entity_value(e, log.costs) for e in log.ents}
    duration = max(rep.duration_seconds, log.samples[-1] if log.samples else 0.0)
    world = max(log.header["width"], log.header["length"])

    attack_times: list[float] = []
    attack_pairs: list[list[int]] = []
    for t, a, b in log.attacks:
        if not attack_times or attack_times[-1] != t:
            attack_times.append(t)
            attack_pairs.append([])
        attack_pairs[-1] += [a, b]

    squad_owner = {}
    for e in log.ents:
        if e.squad:
            squad_owner[e.squad] = e.owner

    players = match_players(log, rep)
    data = {
        "format": 1,
        "name": rlog.stem,
        "replay": {"file": rec_path.name, "date": rep.date, "build": rep.version},
        "duration": duration,
        "recordStart": log.header["start"],
        "world": {"width": log.header["width"], "length": log.header["length"]},
        "players": players,
        "entities": [{
            "id": e.id, "owner": e.owner, "bp": e.bp, "cat": classify(e.bp, e.building), "maxhp": e.maxhp,
            "squad": e.squad, "spans": e.spans, "killed": e.killed, "killer": e.killer,
            "value": round(values[e.id]), "track": flat_track(e),
            "owners": e.owners if len(e.owners) > 1 else None,
            "vision": e.vision or None,
        } for e in log.ents],
        "attacks": {"times": attack_times, "pairs": attack_pairs},
        "orders": {str(sid): [v for o in seq for v in o] for sid, seq in log.orders.items() if sid in squad_owner},
        "kills": kills,
        "upgrades": log.upgrades,
        "techs": tech_list(log, by_id),
        "constructions": log.constructions,
        "stats": {str(k): v for k, v in log.stats.items()},
        # J records, per player: [t, villagers gathering food, wood, gold, stone, other] every 2 s
        "jobs": {str(k): v for k, v in log.jobs.items()},
        "army": army_series(log, values, duration),
        "fights": detect_fights(log, values, world),
        "chats": [{"t": c.tick / recfile.TICKS_PER_SECOND, "sender": c.sender, "message": c.message} for c in rep.chats],
        "cameras": camera_tracks(rep, players),
        "conversions": conversion_casts(rep, log),
        "terrain": log.terrain,
        "gaia": gaia_data(log) if log.gaia else None,
        "recorderErrors": log.errors[:50],
    }
    summary = load_summary(rlog, rec_path, data["players"])
    if summary:
        data["summary"] = summary

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    out = DATA_DIR / f"{rlog.stem}.js"
    payload = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    out.write_text(f"(window.REPLAY_DATA = window.REPLAY_DATA || {{}})[{json.dumps(rlog.stem)}] = {payload};\n",
                   encoding="utf-8")
    names = sorted(p.stem for p in DATA_DIR.glob("*.js") if p.stem != "index")
    # recordings with key-moment notes (viewer/notes/<name>.js): the 2D viewer loads only these, so a missing one is
    # never probed (a 404 in the console)
    noted = sorted(p.stem for p in (DATA_DIR.parent / "notes").glob("*.js"))
    (DATA_DIR / "index.js").write_text(f"window.REPLAY_INDEX = {json.dumps(names)};\n"
                                       f"window.REPLAY_NOTED = {json.dumps(noted)};\n", encoding="utf-8")

    print(f"{len(log.ents)} entities, {len(log.gaia)} map objects, {len(log.attacks)} attack samples, "
          f"{len(kills)} kills, {len(data['fights'])} fights, {len(log.costs)} costs, "
          f"{len(log.errors)} recorder errors -> {out} ({out.stat().st_size // 1024} KB)")
    print(trends.update())
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("rlog")
    ap.add_argument("rec", nargs="?", help="replay file (default: the game's playback/<name>.rec)")
    args = ap.parse_args()
    rlog = Path(args.rlog)
    if args.rec:
        rec_path = Path(args.rec)
    else:
        from record_replay import PLAYBACK_DIR
        rec_path = PLAYBACK_DIR / (rlog.stem + ".rec")
    convert(rlog, rec_path)


if __name__ == "__main__":
    main()
