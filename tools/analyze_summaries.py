"""Analyse harvested AoE4 summaries: python tools/analyze_summaries.py.

Reads a short, read-only SQLite snapshot; writes eco_summaries.json,
army_summaries.json, ECO_SUMMARY.md and ARMY_SUMMARY.md under harvest/analysis.
Only the standard library is used; technology/unit metadata is cached once.
"""
from __future__ import annotations

import bisect
import collections
import datetime as dt
import json
import math
import re
import sqlite3
import statistics
import sys
import time
import urllib.request
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from atomicio import atomic_write_text  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "harvest/aoe4.db"
CACHE = ROOT / "harvest/cache/technologies_all.json"
OUT = ROOT / "harvest/analysis"
TECH_URL = "https://data.aoe4world.com/technologies/all.json"
UNIT_URL = "https://data.aoe4world.com/units/all.json"
UNIT_CACHE = ROOT / "harvest/cache/units_all.json"
MAY = 10307814
RES = ("food", "wood", "gold", "stone")
WALK_SHARE = dict(food=.12, wood=.30, gold=.25, stone=.25)
# Definitions and multipliers audited in viewer/eco.js:1-200 and viewer/stats.js.
DEFS = {
    "wheelbarrow": ("Wheelbarrow", r"upgrade_unit_(?:town_center_)?wheelbarrow_(?:1|byz)(?:_(?!jpn)|$)"),
    "double-broadax": ("Double Broadax", r"upgrade_econ_resource_wood_harvest_rate_2(?:_|$)"),
    "horticulture": ("Horticulture", r"upgrade_econ_resource_food_harvest_rate_2(?:_|$)"),
    "specialized-pick": ("Specialized Pick", r"upgrade_econ_resource_gold_harvest_rate_2(?:_|$)"),
    "shaft-mining": ("Shaft Mining", r"upgrade_econ_resource_gold_harvest_rate_3(?:_|$)"),
}
CIV_CODES = dict(abbasid_dynasty="ab", ayyubids="ay", byzantines="by", chinese="ch",
                 delhi_sultanate="de", english="en", french="fr", golden_horde="gol",
                 holy_roman_empire="hr", house_of_lancaster="hl", japanese="ja",
                 jeanne_darc="je", jin_dynasty="jin", knights_templar="kt", malians="ma",
                 macedonian_dynasty="mac", mongols="mo", order_of_the_dragon="od",
                 ottomans="ot", rus="ru", sengoku_daimyo="sen", tughlaq_dynasty="tug",
                 zhu_xis_legacy="zx")
MMR_BUCKETS = ("<-200", "-200..-101", "-100..100", "101..200", ">200", "unknown")
NOTES = [
    "Observational associations, not causal effects; both players can appear in all-player rows. Wilson 95% binomial intervals do not account for repeated players or paired games.",
    "Benchmark is median completion minus age arrival among observed researchers; Feudal for four techs, Castle for Shaft Mining. Civ-specific at n>=30, otherwise global. On-time <= benchmark+60s, delayed >+60s; never researched is skipped only if game end >= benchmark+300s, else censored. Unavailable techs or missing required age are ineligible.",
    "Action times are checked against buildOrder Upgrade.finished by technology pbgid. First action timestamp is used; 0-1s differences are summary rounding. Actions represent completion, not click, when the comparison supports it.",
    "Missed value uses left-held PerMin samples /60 times (m-1): observed income in the delay window does not include the missing tech. Wheelbarrow m=1.5/(1.5*(1-walkShare)+walkShare/1.15), walk shares food .12, wood .30, gold/stone .25. No resource-specific gatherer counts are assumed.",
    "Multipliers use metadata effects; Shaft Mining's empty effects are filled from its description, matching audited stats.js (gold/stone x1.15, Mongol gold only). Civ variants retain their metadata costs and effects.",
    "Deficit = missed gather for completed research; subtract the unspent food+wood+gold+stone tech cost only for skipped research. No interest, opportunity discount, age-up cost or income causal attribution is modelled.",
    "Rates are held to the next sample and the final sample to game end; unobserved leading time or missing/invalid series make the affected resource estimate unavailable rather than zero.",
    "Unit costs come from units/all.json matched by pbgid and civ; values are food+wood+gold+stone catalogue costs, not actual discounted spend. Metadata classes identify military/villagers, with icon classification only for unmapped units. Missing unit costs propagate unavailable metrics and are counted, never silently valued at zero.",
    "Controls are ON-TIME players for the same tech whose benchmark is within +/-60s of the target benchmark, measured over the target's exact absolute [benchmark,min(actual,end)] interval. Controls must survive through its end. Baseline median/p75 and metric-specific sample counts are retained; no controls means no baseline-dependent classification.",
    "Labels, in precedence order: attacked if opponent destroyed value >=max(300,control p75); defended if positive own losses >=control p75 and opponent destroyed value >=0.8*own losses; boomed if positive villager production/min >=control p75 or an extra TC was built; none otherwise. Capitalised includes all three non-none labels. Paid off means opponent destroyed value minus own lost value >= missed gather (not net deficit).",
    "Destruction events have no killer attribution; in 1v1 opponent destructions proxy kills and can include noncombat loss. Missing values yield unknown paid-off status. Initial t=0 spawns are not production. Baseline metrics include military production value/min, villager rate, opponent destroyed value (villagers separately), and own lost value.",
    "Outcome tables show all player-games and a separate |player-opponent MMR|<=50 subset, May vs all. Shares O/D/S/C/I use all records; cap uses delayed+skipped; paid uses evaluable delayed+skipped. Median lateness uses delayed researched techs only; missed/net medians use delayed+skipped. Full signed-MMR strata and Wilson intervals remain in JSON.",
]


def normalized(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def tech_slot(attrib: str) -> str | None:
    return next((key for key, (_, pattern) in DEFS.items() if re.match(pattern, attrib)), None)


def metadata(cache: Path = CACHE, url: str = TECH_URL) -> list[dict]:
    if not cache.exists():
        cache.parent.mkdir(parents=True, exist_ok=True)
        request = urllib.request.Request(url, headers={"User-Agent": "aoe4-replay-tools/1.0"})
        with urllib.request.urlopen(request, timeout=45) as response:
            data = response.read()
        json.loads(data)
        cache.write_bytes(data)
    return json.loads(cache.read_text(encoding="utf-8"))["data"]


def snapshot() -> tuple[list[sqlite3.Row], dict]:
    # Fetch and close before JSON processing so a live harvester is not blocked.
    for attempt in range(9):
        con = None
        try:
            con = sqlite3.connect(DB.as_uri() + "?mode=ro", uri=True, timeout=2)
            con.row_factory = sqlite3.Row
            con.execute("begin")
            counts = {str(r[0]): r[1] for r in con.execute("select status,count(*) from summaries group by status")}
            rows = con.execute("select g.*,s.body from summaries s left join games g using(game_id) "
                               "where s.status=200 order by s.game_id").fetchall()
            return rows, counts
        except sqlite3.OperationalError as error:
            if not any(word in str(error).lower() for word in ("locked", "busy")) or attempt == 8:
                raise
            time.sleep(min(.25 * 2 ** attempt, 3))
        finally:
            if con is not None:
                con.close()
    raise AssertionError("unreachable")


def times(values) -> list[float]:
    if not isinstance(values, list):
        return []
    return sorted(float(v) for v in values if isinstance(v, (float, int)) and math.isfinite(v) and v >= 0)


def first(values) -> float | None:
    return min(times(values), default=None)


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    seq = sorted(values)
    position = (len(seq) - 1) * fraction
    lo = int(position)
    return seq[lo] + (seq[min(lo + 1, len(seq) - 1)] - seq[lo]) * (position - lo)


def median(values) -> float | None:
    seq = [v for v in values if v is not None]
    return statistics.median(seq) if seq else None


def bucket(diff: float | None) -> str:
    if diff is None:
        return "unknown"
    return MMR_BUCKETS[0 if diff < -200 else 1 if diff < -100 else 2 if diff <= 100 else 3 if diff <= 200 else 4]


def unit_kind(entry: dict) -> str | None:
    if entry.get("type") != "Unit":
        return None
    icon = entry.get("icon", "").lower().rsplit("/", 1)[-1]
    if "villager" in icon:
        return "villagers"
    if any(token in icon for token in ("trader", "trade_ship", "fishing", "transport", "monk", "scholar", "imam", "prelate", "priest", "shaman", "worker", "merchant")):
        return "other"
    return "military"


def event_index(player: dict, unit_by_pbgid: dict, missing_units: collections.Counter) -> dict:
    events = {f"{kind}_{event}": [] for kind in ("villagers", "military", "other") for event in ("finished", "destroyed")}
    events["town_centers"] = []
    weighted = {key: [] for key in events if key != "town_centers"}
    weighted["units_destroyed"] = []
    code = CIV_CODES.get(player["civilization"])
    for entry in player.get("buildOrder", []):
        kind = unit_kind(entry)
        if kind:
            candidates = unit_by_pbgid.get(int(entry["pbgid"]), [])
            unit = next((u for u in candidates if code in u.get("civs", [])), candidates[0] if candidates else None)
            if unit:
                classes = unit.get("classes", [])
                kind = "villagers" if "villager" in classes else "military" if "military" in classes or "land_military" in classes or "naval_military" in classes else "other"
                value = sum(unit["costs"].get(res, 0) for res in RES)
            else:
                value = None
                missing_units[int(entry["pbgid"])] += len(times(entry.get("finished"))) + len(times(entry.get("destroyed")))
            for event in ("finished", "destroyed"):
                key = f"{kind}_{event}"
                stamps = times(entry.get(event))
                events[key].extend(stamps)
                weighted[key].extend((stamp, value) for stamp in stamps)
                if event=="destroyed":
                    weighted["units_destroyed"].extend((stamp,value) for stamp in stamps)
        if entry.get("type") == "Building" and "town_center" in entry.get("icon", ""):
            events["town_centers"].extend(t for t in times(entry.get("finished")) if t > 0)
    result = {key: sorted(value) for key, value in events.items()}
    result["value_prefix"] = {}
    for key, values in weighted.items():
        ordered = sorted(values, key=lambda item: item[0])
        stamps, sums, unknown = [], [0.0], [0]
        for stamp, value in ordered:
            stamps.append(stamp)
            sums.append(sums[-1] + (value if value is not None else 0))
            unknown.append(unknown[-1] + (value is None))
        result["value_prefix"][key] = (stamps, sums, unknown)
    return result


def count(events: list, start: float, end: float) -> int:
    return bisect.bisect_right(events, end) - bisect.bisect_right(events, start)


def event_value(events: dict, key: str, start: float, end: float) -> float | None:
    stamps, sums, unknown = events["value_prefix"][key]
    a, b = bisect.bisect_right(stamps, start), bisect.bisect_right(stamps, end)
    return None if unknown[b] > unknown[a] else sums[b] - sums[a]


def window(player: dict, opponent: dict, start: float, end: float) -> dict:
    own, enemy = player["events"], opponent["events"]
    destroyed = {kind: event_value(enemy, f"{kind}_destroyed", start, end) for kind in ("villagers", "military", "other")}
    lost = {kind: event_value(own, f"{kind}_destroyed", start, end) for kind in ("villagers", "military", "other")}
    opponent_value = sum(destroyed.values()) if all(v is not None for v in destroyed.values()) else None
    lost_value = sum(lost.values()) if all(v is not None for v in lost.values()) else None
    production = event_value(own, "military_finished", start, end)
    minutes = (end-start)/60
    return dict(start=start, end=end, opponent_destroyed_value=opponent_value,
                opponent_villagers_destroyed_value=destroyed["villagers"], opponent_destroyed_by_kind=destroyed,
                own_losses_value=lost_value, own_losses_by_kind=lost,
                military_production_value_per_min=production/minutes if production is not None and minutes>0 else None,
                villagers_per_min=count(own["villagers_finished"],start,end)/minutes if minutes>0 else None,
                extra_town_centers=count(own["town_centers"],start,end))


BASELINE_METRICS = ("opponent_destroyed_value", "opponent_villagers_destroyed_value",
                    "own_losses_value", "military_production_value_per_min", "villagers_per_min")


def classify_windows(records: list[dict], player_index: dict) -> None:
    controls = collections.defaultdict(list)
    for row in records:
        if row["status"] == "on-time":
            controls[row["tech"]].append(row)
    control_starts = {}
    for tech, rows in controls.items():
        rows.sort(key=lambda r:r["benchmark"])
        control_starts[tech] = [r["benchmark"] for r in rows]
    cache = {}
    for row in records:
        if row["status"] not in ("delayed", "skipped"):
            continue
        w = row["window"]
        start, end = w["start"], w["end"]
        key = (row["tech"], start, end)
        if key not in cache:
            starts = control_starts.get(row["tech"], [])
            candidates = controls[row["tech"]][bisect.bisect_left(starts,start-60):bisect.bisect_right(starts,start+60)]
            eligible = [r for r in candidates if r["duration"] >= end]
            measurements = {metric:[] for metric in BASELINE_METRICS}
            minutes = (end-start)/60
            for control in eligible:
                player = player_index[(control["game_id"],control["profile_id"])]
                own, enemy = player["events"], player["opponent"]["events"]
                production = event_value(own,"military_finished",start,end)
                values = (event_value(enemy,"units_destroyed",start,end),
                          event_value(enemy,"villagers_destroyed",start,end),
                          event_value(own,"units_destroyed",start,end),
                          production/minutes if production is not None and minutes>0 else None,
                          count(own["villagers_finished"],start,end)/minutes if minutes>0 else None)
                for metric,value in zip(BASELINE_METRICS,values):
                    if value is not None:
                        measurements[metric].append(value)
            baseline = {metric:dict(n=len(values),median=median(values),p75=percentile(values,.75))
                        for metric,values in measurements.items()}
            cache[key] = dict(n=len(eligible), alignment_seconds=60, metrics=baseline)
        baseline = cache[key]
        w["baseline"] = baseline
        p75 = {key:value["p75"] for key,value in baseline["metrics"].items()}
        killed, lost = w["opponent_destroyed_value"], w["own_losses_value"]
        if killed is not None and p75["opponent_destroyed_value"] is not None and killed >= max(300,p75["opponent_destroyed_value"]):
            label = "attacked"
        elif lost is not None and killed is not None and lost>0 and p75["own_losses_value"] is not None and lost>=p75["own_losses_value"] and killed>=.8*lost:
            label = "defended"
        elif w["extra_town_centers"]>0 or (w["villagers_per_min"] is not None and w["villagers_per_min"]>0 and p75["villagers_per_min"] is not None and w["villagers_per_min"]>=p75["villagers_per_min"]):
            label = "boomed"
        else:
            label = "none"
        w["label"], w["capitalised"] = label, label != "none"
        w["paid_off"] = killed-lost>=row["missed_gather"] if killed is not None and lost is not None and row["missed_gather"] is not None else None


def multipliers(tech: dict, slot: str) -> dict[str, float]:
    factors = dict.fromkeys(RES, 1.0)
    effects = tech.get("effects", [])
    if slot == "wheelbarrow":
        carry = sum(e["value"] for e in effects if e.get("property") == "carryCapacity" and e.get("effect") == "change")
        speed = math.prod(e["value"] for e in effects if e.get("property") == "moveSpeed" and e.get("effect") == "multiply")
        capacity = (10 + carry) / 10
        return {res: capacity / (capacity * (1 - share) + share / speed) for res, share in WALK_SHARE.items()}
    for effect in effects:
        prop = effect.get("property", "")
        if effect.get("effect") == "multiply" and prop.endswith("GatherRate") and prop[:-10] in RES:
            factors[prop[:-10]] *= effect["value"]
    if slot == "shaft-mining" and all(v == 1 for v in factors.values()):
        # Metadata deliberately leaves these effects empty; its description and
        # viewer/stats.js both establish +15% (Mongol has no stone bonus).
        description = tech.get("description", "").lower()
        if "15%" not in description or "gold" not in description:
            raise ValueError(f"No audited Shaft Mining multiplier: {tech['attribName']}")
        factors["gold"] = 1.15
        if "stone" in description:
            factors["stone"] = 1.15
    return factors


def integrate(player: dict, res: str, start: float, end: float) -> float | None:
    if end <= start:
        return 0.0
    resources = player.get("resources", {})
    stamps, values = resources.get("timestamps", []), resources.get(res + "PerMin", [])
    if not stamps or stamps[0] > start or len(values) != len(stamps):
        return None
    total = 0.0
    for i in range(max(0, bisect.bisect_right(stamps, start) - 1), len(stamps)):
        left = max(start, stamps[i])
        right = min(end, stamps[i + 1] if i + 1 < len(stamps) else end)
        if right > left:
            value = values[i]
            if not isinstance(value, (float, int)) or not math.isfinite(value) or value < 0:
                return None
            total += value * (right - left) / 60
        if right >= end:
            break
    return total


def wilson(rows: list[dict]) -> dict:
    outcomes = [r["result"] for r in rows if r["result"] in ("win", "loss")]
    n, wins = len(outcomes), outcomes.count("win")
    if not n:
        return dict(n=0, wins=0, win_rate=None, ci95=None, records=len(rows))
    z = 1.959963984540054
    p = wins / n
    denominator = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denominator
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator
    return dict(n=n, wins=wins, win_rate=p, ci95=[max(0, centre - half), min(1, centre + half)], records=len(rows))


def aggregate(rows: list[dict]) -> dict:
    late = [r for r in rows if r["status"] in ("delayed", "skipped")]
    cap = [r for r in late if r["window"]["capitalised"]]
    delayed = [r for r in late if r["status"] == "delayed"]
    paid_known = [r for r in late if r["window"]["paid_off"] is not None]
    paid = [r for r in paid_known if r["window"]["paid_off"]]
    status = {key: wilson([r for r in rows if r["status"] == key]) for key in ("on-time", "delayed", "skipped", "censored", "ineligible")}
    status["delayed_or_skipped"] = wilson(late)
    groups = dict(on_time=status["on-time"],
                  delayed_capitalised=wilson([r for r in delayed if r["window"]["capitalised"]]),
                  delayed_not_capitalised=wilson([r for r in delayed if not r["window"]["capitalised"]]),
                  skipped=status["skipped"])
    return dict(n=len(rows), status=status,
                status_shares={key:value["records"]/len(rows) if rows else None for key,value in status.items()},
                win_groups=groups, median_lateness=median(r["delay"] for r in delayed),
                median_missed=median(r["missed_gather"] for r in late),
                median_net_deficit=median(r["net_deficit"] for r in late),
                valued_records=sum(r["missed_gather"] is not None for r in late),
                capitalised=dict(wilson(cap), share=len(cap)/len(late) if late else None),
                paid_off=dict(n=len(paid), evaluable=len(paid_known), unknown=len(late)-len(paid_known),
                              share=len(paid)/len(paid_known) if paid_known else None),
                not_capitalised=wilson([r for r in late if not r["window"]["capitalised"]]),
                labels={label:wilson([r for r in late if r["window"]["label"]==label]) for label in ("attacked","defended","boomed","none")})


def analyse(db_rows: list[sqlite3.Row], technologies: list[dict], units: list[dict]) -> tuple[dict, dict]:
    by_action = collections.defaultdict(list)
    variants = collections.defaultdict(list)
    unit_by_pbgid = collections.defaultdict(list)
    for unit in units:
        unit_by_pbgid[int(unit["pbgid"])].append(unit)
    missing_units = collections.Counter()
    for tech in technologies:
        slot = tech_slot(tech["attribName"])
        if slot:
            by_action[normalized(tech["attribName"])].append(tech)
            variants[slot].append(tech)
    players, mapping, errors = [], {}, []
    comparison = collections.Counter()
    global_samples, civ_samples = collections.defaultdict(list), collections.defaultdict(list)
    medians = collections.defaultdict(list)
    for db in db_rows:
        try:
            summary = json.loads(zlib.decompress(db["body"]))
        except (ValueError, zlib.error, TypeError) as error:
            errors.append(dict(game_id=db["game_id"], reason=str(error)))
            continue
        pair = summary.get("players", [])
        if len(pair) != 2:
            errors.append(dict(game_id=summary.get("gameId", db["game_id"]), reason="not two players"))
            continue
        current = []
        for source in pair:
            player = dict(source)
            pid = int(player["profileId"])
            side = 0 if db["p0"] == pid else 1 if db["p1"] == pid else None
            mmr = db[f"p{side}_mmr"] if side is not None else None
            opponent_mmr = db[f"p{1-side}_mmr"] if side is not None else None
            diff = mmr - opponent_mmr if mmr is not None and opponent_mmr is not None else None
            actions = player.get("actions", {})
            player.update(game_id=summary.get("gameId", db["game_id"]), profile_id=pid,
                          end=float(db["duration"] if db["duration"] is not None else summary["duration"]),
                          feudal=first(actions.get("feudalAge")), castle=first(actions.get("castleAge")),
                          mmr=mmr, mmr_diff=diff, mmr_bucket=bucket(diff), researched={},
                          events=event_index(player, unit_by_pbgid, missing_units))
            code = CIV_CODES.get(player["civilization"])
            upgrades = {int(e["pbgid"]): e for e in player.get("buildOrder", []) if e.get("type") == "Upgrade"}
            for action, timestamps in actions.items():
                candidates = by_action.get(normalized(action), [])
                if not candidates:
                    continue
                candidates = sorted(candidates, key=lambda t: code not in t.get("civs", []))
                tech = candidates[0]
                slot = tech_slot(tech["attribName"])
                actual = first(timestamps)
                if actual is None:
                    continue
                mapping[action] = dict(tech=slot, name=tech["name"], attribName=tech["attribName"], pbgid=tech["pbgid"])
                finished = first(upgrades.get(int(tech["pbgid"]), {}).get("finished"))
                if finished is not None:
                    comparison[round(actual - finished, 3)] += 1
                previous = player["researched"].get(slot)
                if previous is None or actual < previous[0]:
                    player["researched"][slot] = (actual, tech, action, finished)
            for slot, (actual, _, _, _) in player["researched"].items():
                age = player["castle"] if slot=="shaft-mining" else player["feudal"]
                if age is not None:
                    relative = actual-age
                    global_samples[slot].append(relative)
                    civ_samples[(slot,player["civilization"])].append(relative)
                if player["feudal"] is not None:
                    medians[(player["civilization"],slot)].append((actual,actual-player["feudal"],actual-age if age is not None else None))
            current.append(player)
        current[0]["opponent"], current[1]["opponent"] = current[1], current[0]
        players.extend(current)
    records = []
    benchmarks = []
    for player in players:
        civ = player["civilization"]
        code = CIV_CODES.get(civ)
        for slot in DEFS:
            actual_info = player["researched"].get(slot)
            candidates = [t for t in variants[slot] if code in t.get("civs", []) and "improved" not in t["attribName"]]
            tech = actual_info[1] if actual_info else (candidates[0] if candidates else None)
            actual = actual_info[0] if actual_info else None
            local = civ_samples[(slot, civ)]
            source = "civ" if len(local) >= 30 else "global"
            samples = local if source == "civ" else global_samples[slot]
            relative = median(samples)
            age_name = "castle" if slot=="shaft-mining" else "feudal"
            age = player[age_name]
            bench = age+relative if age is not None and relative is not None else None
            eligible = tech is not None and bench is not None and (slot != "shaft-mining" or player["castle"] is not None)
            if not eligible:
                status = "ineligible"
            elif actual is not None:
                status = "delayed" if actual>bench+60 else "on-time"
            else:
                status = "skipped" if player["end"] >= bench + 300 else "censored"
            row = dict(game_id=player["game_id"], profile_id=player["profile_id"], name=player.get("name"),
                       civ=civ, result=str(player.get("result", "")).lower(), mmr=player["mmr"],
                       mmr_diff=player["mmr_diff"], mmr_bucket=player["mmr_bucket"], duration=player["end"],
                       tech=slot, attribName=tech["attribName"] if tech else None,
                       pbgid=tech["pbgid"] if tech else None, action=actual_info[2] if actual_info else None,
                       finished_build_order=actual_info[3] if actual_info else None,
                       feudal=player["feudal"], castle=player["castle"], research_time=actual,
                       research_relative_feudal=actual-player["feudal"] if actual is not None and player["feudal"] is not None else None,
                       benchmark=bench, benchmark_age=age_name, benchmark_relative_age=relative, benchmark_source=source,
                       benchmark_samples=len(samples), status=status, delay=actual-bench if actual is not None and bench is not None else None,
                       missed_gather=None, net_deficit=None, window=None, missed_by_resource=None,
                       cost=tech["costs"] if tech else None, multipliers=multipliers(tech, slot) if tech else None)
            if status in ("delayed", "skipped"):
                end = min(actual if actual is not None else player["end"], player["end"])
                row["window"] = window(player, player["opponent"], bench, end)
                missed = {}
                for res, multiplier in row["multipliers"].items():
                    if multiplier == 1:
                        continue
                    income = integrate(player, res, bench, end)
                    missed[res] = income * (multiplier-1) if income is not None else None
                row["missed_by_resource"] = missed
                if all(value is not None for value in missed.values()):
                    row["missed_gather"] = sum(missed.values())
                    row["net_deficit"] = row["missed_gather"] - (sum(tech["costs"].get(res, 0) for res in RES) if status == "skipped" else 0)
            elif status == "on-time":
                row["missed_gather"] = 0.0
                row["net_deficit"] = 0.0  # No delay window: no hypothetical saved cost.
            records.append(row)
    classify_windows(records, {(p["game_id"],p["profile_id"]):p for p in players})
    for slot in DEFS:
        benchmarks.append(dict(tech=slot,civ=None,age="castle" if slot=="shaft-mining" else "feudal",
                               n=len(global_samples[slot]),median_seconds_after_age=median(global_samples[slot]),used=True))
    for (slot, civ), values in sorted(civ_samples.items()):
        benchmarks.append(dict(tech=slot,civ=civ,age="castle" if slot=="shaft-mining" else "feudal",
                               n=len(values),median_seconds_after_age=median(values),used=len(values)>=30))
    outcomes = {}
    for cohort in ("all", "May"):
        cohort_rows = [r for r in records if cohort == "all" or r["profile_id"] == MAY]
        outcomes[cohort] = {}
        for slot in DEFS:
            subset = [r for r in cohort_rows if r["tech"] == slot]
            outcomes[cohort][slot] = dict(overall=aggregate(subset),
                matched_mmr_50=aggregate([r for r in subset if r["mmr_diff"] is not None and abs(r["mmr_diff"])<=50]),
                mmr_buckets={b: aggregate([r for r in subset if r["mmr_bucket"] == b]) for b in MMR_BUCKETS})
    timing = [dict(civ=civ, tech=slot, n=len(values), median_game_start=median(v[0] for v in values),
                   median_relative_feudal=median(v[1] for v in values),
                   median_relative_age=median(v[2] for v in values),
                   age="castle" if slot=="shaft-mining" else "feudal") for (civ,slot),values in sorted(medians.items())]
    matched = sum(comparison.values())
    completion = matched > 0 and sum(n for delta,n in comparison.items() if abs(delta) <= 1)/matched >= .95
    data = dict(generated_at=dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                counts=dict(ok_summaries=len(db_rows), analysed_games=len(players)//2, player_games=len(players),
                            may_player_games=sum(p["profile_id"] == MAY for p in players), tech_records=len(records),
                            statuses=dict(collections.Counter(r["status"] for r in records))),
                assumptions=NOTES, mapping=dict(sorted(mapping.items())), errors=errors,
                unit_cost_coverage=dict(unmapped_pbgids={str(k):v for k,v in sorted(missing_units.items())},
                                        unmapped_events=sum(missing_units.values())),
                timestamp_evidence=dict(interpretation="completion" if completion else "undetermined", matched_upgrades=matched,
                    action_minus_finished_seconds={str(delta): n for delta,n in sorted(comparison.items())}),
                benchmarks=benchmarks, per_civ_medians=timing, outcomes=outcomes, records=records)
    return data, analyse_armies(players,unit_by_pbgid)


def rate_cell(stats: dict, ci: bool = True) -> str:
    if not stats["n"]:
        return "— (0)"
    value = f"{100*stats['win_rate']:.0f}% ({stats['wins']}/{stats['n']})"
    if ci:
        value += f" [{100*stats['ci95'][0]:.0f}–{100*stats['ci95'][1]:.0f}]"
    return value


def number(value: float | None) -> str:
    return "—" if value is None else f"{value:.0f}"


def share_cell(value: float | None) -> str:
    return "—" if value is None else f"{100*value:.0f}%"


def benchmark_cells(data: dict, tech: str) -> str:
    rows = [r for r in data["benchmarks"] if r["tech"]==tech and r["used"]]
    return "; ".join(f"{r['civ'] or 'global'}: {r['median_seconds_after_age']:.1f}s (n={r['n']})"
                     if r["median_seconds_after_age"] is not None else f"{r['civ'] or 'global'}: — (n=0)" for r in rows)


def report(data: dict) -> str:
    c = data["counts"]
    evidence = data["timestamp_evidence"]
    lines = ["# Economy summary analysis", "", f"Snapshot {data['generated_at']}; {c['analysed_games']} games, {c['player_games']} player-games; May {c['may_player_games']}; {c['tech_records']} tech records.",
             f"Timestamp check: **{evidence['interpretation']}**; {evidence['matched_upgrades']} matched pbgids; action − finished seconds: {json.dumps(evidence['action_minus_finished_seconds'])}.",
             f"Status counts: {json.dumps(c['statuses'], sort_keys=True)}. Decode/shape errors: {len(data['errors'])}.",
             f"Unmapped unit-cost events: {data['unit_cost_coverage']['unmapped_events']} (pbgids and metric-specific missing coverage in JSON).", "",
             "## Benchmark table",
             "Median completion seconds after age-up (n researchers); civ rows apply only at n>=30, all other civs use global.",
             "| Tech | Age | Scope: median seconds after age-up (n) |", "|---|---|---|"]
    for tech in DEFS:
        lines.append(f"| {tech} | {'Castle' if tech=='shaft-mining' else 'Feudal'} | {benchmark_cells(data,tech)} |")
    lines += ["", "## Outcomes",
              "O/D/S/C/I = on-time/delayed/skipped/censored/ineligible shares; late = delayed-only median lateness in seconds; miss/net = delayed+skipped medians. Cap includes attacked/defended/boomed; paid excludes unknown values. Win cells show wins/n and Wilson 95% CI.",
              "| Cohort / filter / tech | n | O/D/S/C/I | Late s | Miss/net | Cap | Paid | On-time WR | Delayed-cap WR | Delayed-not-cap WR | Skipped WR |",
              "|---|---|---|---|---|---|---|---|---|---|---|"]
    for cohort, techs in data["outcomes"].items():
        for filter_key, label in (("overall","all MMR"),("matched_mmr_50","abs MMR≤50")):
            for tech, info in techs.items():
                a = info[filter_key]
                shares = "/".join(share_cell(a["status_shares"][key]) for key in ("on-time","delayed","skipped","censored","ineligible"))
                wins = " | ".join(rate_cell(a["win_groups"][key]) for key in ("on_time","delayed_capitalised","delayed_not_capitalised","skipped"))
                lines.append(f"| {cohort} / {label} / {tech} | {a['n']} | {shares} | {number(a['median_lateness'])} | {number(a['median_missed'])}/{number(a['median_net_deficit'])} | {share_cell(a['capitalised']['share'])} | {share_cell(a['paid_off']['share'])} | {wins} |")
    lines += ["", "## Per-civ research medians", "Seconds from game start / relative to Feudal (n); — means no observed research. DB snapshot only, not a recommended build order.",
              "| Civ | Wheelbarrow | Double Broadax | Horticulture | Specialized Pick | Shaft Mining |", "|---|---|---|---|---|---|"]
    timing = {(r["civ"],r["tech"]):r for r in data["per_civ_medians"]}
    for civ in sorted({r["civ"] for r in data["records"]}):
        cells = []
        for tech in DEFS:
            value = timing.get((civ,tech))
            cells.append(f"{number(value['median_game_start'])}/{number(value['median_relative_feudal'])} ({value['n']})" if value else "—")
        lines.append(f"| {civ} | " + " | ".join(cells) + " |")
    lines += ["", "## Method and limits"] + [f"- {note}" for note in NOTES]
    lines += ["", "Re-run `python tools/analyze_summaries.py` as harvesting continues. `eco_summaries.json` contains action mappings, timing evidence, benchmarks, per-player windows, costs, multipliers, per-civ medians and all outcome/CI strata."]
    if len(lines) > 100:
        raise ValueError(f"Report exceeds 100 lines ({len(lines)})")
    return "\n".join(lines) + "\n"


AGE_EDGES = tuple(range(270,1231,60))
CASTLE_DIFF_BUCKETS = ("<-300","-300..-121","-120..-31","-30..30","31..120","121..300",">300")
ARMY_NOTES = [
    "Composition uses catalogue baseId by pbgid/civ; unmatched transformed pbgids retain the icon's last segment verbatim. Metadata military classes identify mapped units; icon exclusions identify civilians for unmatched units. Initial t=0 units are not produced. Main means >=15% of military completions.",
    "Composition table shows the 12 most frequent main types; full unit table, all qualifying counter pairs, player-game counts and mapping coverage are in JSON. Mean production and survival refer to main-unit appearances; survival=1-summed destroyed/summed produced, not matched individual lifetimes, so captures/initial units can make it negative.",
    "Counter pairs are ordered X-side player-games with both types main (n>=25 overall); multi-main armies contribute to multiple pairs. Top 15 are ranked by absolute WR-50%, not causal counters; repeated players, paired sides, civ/MMR, patch and game length confound associations. Wilson 95% CIs are unclustered.",
    "Military values are preferred only when both players expose the same value series, otherwise resources.military is used (a score, not resource cost). Samples are left-held on the union of timestamps through game end; ties are excluded from lead/swing win rates. Swing=max absolute lead change across any two samples <=60s apart; its beneficiary is the gaining side. Equal opposite maxima are ambiguous and excluded. Restricted variants require both samples strictly before game end-120s or before 15:00 respectively; no-swing/ambiguous games are excluded per variant. Lead changes ignore zero ties.",
    "Lead/swing May column means games containing May and asks whether the leading/benefiting side won; composition, pairs and age May columns instead mean May's player-games. Checkpoints require game duration>=time and recorded coverage. Age buckets use completion times; missing ages and unmatched Castle comparisons are censored and retained in JSON.",
]


def clock(seconds: float) -> str:
    return f"{int(seconds)//60}:{int(seconds)%60:02d}"


def age_labels() -> list[str]:
    return ["≤"+clock(AGE_EDGES[0])] + [clock(a)+"–"+clock(b) for a,b in zip(AGE_EDGES,AGE_EDGES[1:])] + [">"+clock(AGE_EDGES[-1])]


def arrival_bucket(moment: float | None) -> str:
    return "not reached" if moment is None else age_labels()[bisect.bisect_left(AGE_EDGES,moment)]


def castle_diff_bucket(difference: float) -> str:
    return CASTLE_DIFF_BUCKETS[0 if difference < -300 else 1 if difference < -120 else 2 if difference < -30 else 3 if difference<=30 else 4 if difference<=120 else 5 if difference<=300 else 6]


def composition(player: dict, unit_by_pbgid: dict, mappings: dict, coverage: collections.Counter) -> dict:
    units = collections.defaultdict(lambda:dict(produced=0,destroyed=0))
    code = CIV_CODES.get(player["civilization"])
    for entry in player.get("buildOrder",[]):
        kind = unit_kind(entry)
        if kind is None:
            continue
        candidates = unit_by_pbgid.get(int(entry["pbgid"]),[])
        unit = next((u for u in candidates if code in u.get("civs",[])),candidates[0] if candidates else None)
        if unit:
            classes = unit.get("classes",[])
            military = any(c in classes for c in ("military","land_military","naval_military"))
            base = unit["baseId"]
        else:
            military = kind=="military"
            base = entry.get("icon","").rsplit("/",1)[-1]
        if not military:
            continue
        source = "pbgid" if unit else "icon"
        produced = sum(0<t<=player["end"] for t in times(entry.get("finished")))
        destroyed = sum(0<t<=player["end"] for t in times(entry.get("destroyed")))
        units[base]["produced"] += produced
        units[base]["destroyed"] += destroyed
        coverage[source+"_produced"] += produced
        coverage[source+"_destroyed"] += destroyed
        mappings[str(entry["pbgid"])] = dict(base_id=base,source=source,icon=entry.get("icon"))
    total = sum(counts["produced"] for counts in units.values())
    main = sorted(base for base,counts in units.items() if total>0 and counts["produced"]/total>=.15)
    return dict(game_id=player["game_id"],profile_id=player["profile_id"],name=player.get("name"),
                civ=player["civilization"],result=player.get("result"),duration=player["end"],
                units=dict(sorted(units.items())),military_produced=total,main_units=main,
                feudal=player["feudal"],castle=player["castle"],
                feudal_bucket=arrival_bucket(player["feudal"]),castle_bucket=arrival_bucket(player["castle"]),
                castle_difference=player["castle"]-player["opponent"]["castle"] if player["castle"] is not None and player["opponent"]["castle"] is not None else None)


def army_score_series(player: dict, key: str) -> list[tuple[float,float]]:
    resources = player.get("resources",{})
    return sorted((float(t),float(v)) for t,v in zip(resources.get("timestamps",[]),resources.get(key,[]))
                  if isinstance(t,(int,float)) and isinstance(v,(int,float)) and math.isfinite(t) and math.isfinite(v) and 0<=t<=player["end"])


def biggest_swing(series: list, cutoff: float | None = None) -> dict:
    minima,maxima = collections.deque(),collections.deque()
    largest,beneficiary,ambiguous = 0.0,None,False
    result=dict(max_swing=None,swing_side=None,swing_start=None,swing_end=None,swing_tied=False,cutoff=cutoff)
    observed=False
    for stamp,lead in series:
        if cutoff is not None and stamp>=cutoff:
            break
        observed=True
        for queue in (minima,maxima):
            while queue and queue[0][0]<stamp-60:
                queue.popleft()
        for queue,side in ((minima,0),(maxima,1)):
            if not queue:
                continue
            old_stamp,old_lead=queue[0]
            gain=lead-old_lead if side==0 else old_lead-lead
            if gain>largest:
                largest,beneficiary,ambiguous=gain,side,False
                result["swing_start"],result["swing_end"]=old_stamp,stamp
            elif gain>0 and math.isclose(gain,largest,abs_tol=1e-9) and side!=beneficiary:
                ambiguous=True
        while minima and minima[-1][1]>=lead:
            minima.pop()
        while maxima and maxima[-1][1]<=lead:
            maxima.pop()
        minima.append((stamp,lead))
        maxima.append((stamp,lead))
    result.update(max_swing=largest if observed else None,
                  swing_side=beneficiary if largest>0 and not ambiguous else None,swing_tied=ambiguous)
    return result


def army_swing(a: dict, b: dict) -> dict:
    ar,br = a.get("resources",{}),b.get("resources",{})
    value_keys = sorted(k for k in ar.keys() & br.keys() if normalized(k) in ("militaryvalue","militaryresourcevalue","armyvalue"))
    source = next((key for key in value_keys if ar[key] and br[key]),"military")
    sa,sb = army_score_series(a,source),army_score_series(b,source)
    row = dict(game_id=a["game_id"],profiles=[a["profile_id"],b["profile_id"]],
               results=[a.get("result"),b.get("result")],duration=min(a["end"],b["end"]),
               has_may=MAY in (a["profile_id"],b["profile_id"]),source=source,
               max_swing=None,swing_side=None,swing_start=None,swing_end=None,swing_tied=False,
               lead_changes=None,checkpoint_leaders={},lead_series=[],
               swing_variants={key:biggest_swing([],cutoff) for key,cutoff in
                               (("excluding_last_120",min(a["end"],b["end"])-120),("before_15",900))})
    if not sa or not sb:
        return row
    stamps = sorted({t for t,_ in sa+sb})
    ia=ib=-1
    for stamp in stamps:
        while ia+1<len(sa) and sa[ia+1][0]<=stamp:
            ia+=1
        while ib+1<len(sb) and sb[ib+1][0]<=stamp:
            ib+=1
        if ia>=0 and ib>=0:
            row["lead_series"].append((stamp,sa[ia][1]-sb[ib][1]))
    row.update(biggest_swing(row["lead_series"]))
    row["swing_variants"]={key:biggest_swing(row["lead_series"],cutoff) for key,cutoff in
                           (("excluding_last_120",row["duration"]-120),("before_15",900))}
    last_sign,changes=0,0
    for _,lead in row["lead_series"]:
        sign=1 if lead>0 else -1 if lead<0 else 0
        if sign:
            changes+=bool(last_sign and sign!=last_sign)
            last_sign=sign
    row["lead_changes"]=changes
    series=row["lead_series"]
    stamps=[t for t,_ in series]
    for minute in (10,15,20):
        moment=minute*60
        i=bisect.bisect_right(stamps,moment)-1
        if row["duration"]<moment:
            state="not reached"
        elif i<0:
            state="missing"
        else:
            lead=series[i][1]
            state=0 if lead>0 else 1 if lead<0 else "tie"
        row["checkpoint_leaders"][str(minute)]=state
    return row


def analyse_armies(players: list[dict], unit_by_pbgid: dict) -> dict:
    mappings,coverage={},collections.Counter()
    records=[composition(p,unit_by_pbgid,mappings,coverage) for p in players]
    by_player={(r["game_id"],r["profile_id"]):r for r in records}
    for player in players:
        row=by_player[(player["game_id"],player["profile_id"])]
        row["opponent_main_units"]=by_player[(player["game_id"],player["opponent"]["profile_id"])]["main_units"]
        other=player["opponent"]["castle"]
        row["castle_difference_bucket"]=castle_diff_bucket(row["castle_difference"]) if row["castle_difference"] is not None else "only player Castle" if player["castle"] is not None else "only opponent Castle" if other is not None else "neither Castle"
    seen=set()
    games=[]
    for player in players:
        if player["game_id"] not in seen:
            seen.add(player["game_id"])
            games.append(army_swing(player,player["opponent"]))
    compositions,counter_pairs,ages,differences,swings={},{},{},{},{}
    for cohort in ("all","May"):
        selected=[r for r in records if cohort=="all" or r["profile_id"]==MAY]
        unit_rows=collections.defaultdict(list)
        pair_rows=collections.defaultdict(list)
        for row in selected:
            for base in row["main_units"]:
                unit_rows[base].append(row)
                for enemy in row["opponent_main_units"]:
                    pair_rows[(base,enemy)].append(row)
        compositions[cohort]=[]
        for base,rows in unit_rows.items():
            produced=sum(r["units"][base]["produced"] for r in rows)
            destroyed=sum(r["units"][base]["destroyed"] for r in rows)
            compositions[cohort].append(dict(unit=base,games_as_main=len(rows),outcome=wilson(rows),
                 mean_produced=produced/len(rows),produced=produced,destroyed=destroyed,
                 survival=1-destroyed/produced if produced else None))
        compositions[cohort].sort(key=lambda r:(-r["games_as_main"],r["unit"]))
        counter_pairs[cohort]=[dict(my_unit=x,opponent_unit=y,**wilson(rows)) for (x,y),rows in sorted(pair_rows.items())]
        ages[cohort]={age:{label:wilson([r for r in selected if r[age+"_bucket"]==label]) for label in age_labels()+["not reached"]} for age in ("feudal","castle")}
        differences[cohort]={label:wilson([r for r in selected if r["castle_difference_bucket"]==label]) for label in CASTLE_DIFF_BUCKETS+("only player Castle","only opponent Castle","neither Castle")}
        selected_games=[g for g in games if cohort=="all" or g["has_may"]]
        checkpoints={}
        for minute in (10,15,20):
            known=[g for g in selected_games if isinstance(g["checkpoint_leaders"].get(str(minute)),int)]
            checkpoints[str(minute)]=dict(outcome=wilson([dict(result=g["results"][g["checkpoint_leaders"][str(minute)]]) for g in known]),
                states=dict(collections.Counter(str(g["checkpoint_leaders"].get(str(minute),"missing")) for g in selected_games)))
        known_swings=[g for g in selected_games if g["swing_side"] is not None]
        variant_outcomes={}
        for key in ("excluding_last_120","before_15"):
            eligible=[g for g in selected_games if g["swing_variants"][key]["swing_side"] is not None]
            variant_outcomes[key]=dict(outcome=wilson([dict(result=g["results"][g["swing_variants"][key]["swing_side"]]) for g in eligible]),
                ambiguous=sum(g["swing_variants"][key]["swing_tied"] for g in selected_games),
                missing_series=sum(g["swing_variants"][key]["max_swing"] is None for g in selected_games))
        swings[cohort]=dict(games=len(selected_games),score_sources=dict(collections.Counter(g["source"] for g in selected_games)),
                           median_max_swing=median(g["max_swing"] for g in selected_games),
                           median_lead_changes=median(g["lead_changes"] for g in selected_games),
                           total_lead_changes=sum(g["lead_changes"] or 0 for g in selected_games),
                           biggest_swing_wins=wilson([dict(result=g["results"][g["swing_side"]]) for g in known_swings]),
                           restricted_biggest_swing_wins=variant_outcomes,
                           ambiguous_swings=sum(g["swing_tied"] for g in selected_games),
                           missing_series=sum(g["max_swing"] is None for g in selected_games),
                           checkpoints=checkpoints)
    qualifying=[r for r in counter_pairs["all"] if r["n"]>=25]
    qualifying.sort(key=lambda r:(-abs(r["win_rate"]-.5),-r["n"],r["my_unit"],r["opponent_unit"]))
    return dict(generated_at=dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                counts=dict(games=len(games),player_games=len(records),may_player_games=sum(r["profile_id"]==MAY for r in records),
                            military_mapping=dict(coverage),qualifying_counter_pairs=len(qualifying)),
                assumptions=ARMY_NOTES,unit_mapping=dict(sorted(mappings.items())),composition=compositions,
                counter_pairs=counter_pairs,top_counter_pairs=qualifying[:15],age_timing=ages,
                castle_time_difference=differences,army_swings=swings,player_games=records,games=games)


def army_report(data: dict) -> str:
    c=data["counts"]
    lines=["# Army summary analysis","",
           f"Snapshot {data['generated_at']}: {c['ok_summaries']} ok summaries, {c['games']} analysed games, {c['player_games']} player-games; May {c['may_player_games']}; excluded {c['excluded_summaries']} non-1v1/invalid summaries (details in JSON).",
           "Rates show wins/n [Wilson 95% CI]. May means May's player-games except lead/swing rows, which use games containing May."]
    lines += ["","## Main-unit composition","Top 12 by games as main; full table in JSON. Mean production and pooled survival use these main-unit appearances.",
              "| Unit | Main games: all / May | WR all | WR May | Mean produced: all / May | Survival: all / May |","|---|---|---|---|---|---|"]
    may={r["unit"]:r for r in data["composition"]["May"]}
    for row in data["composition"]["all"][:12]:
        m=may.get(row["unit"])
        lines.append(f"| {row['unit']} | {row['games_as_main']} / {m['games_as_main'] if m else 0} | {rate_cell(row['outcome'])} | {rate_cell(m['outcome']) if m else '— (0)'} | {row['mean_produced']:.1f} / {format(m['mean_produced'],'.1f') if m else '—'} | {share_cell(row['survival'])} / {share_cell(m['survival']) if m else '—'} |")
    lines += ["","## Counter pairs","Ordered main-unit pairs, n≥25 overall; top 15 by |WR−50%|. Not a causal matchup ranking.",
              "| My main unit | Opponent main unit | WR all | WR May |","|---|---|---|---|"]
    may_pairs={(r["my_unit"],r["opponent_unit"]):r for r in data["counter_pairs"]["May"]}
    for row in data["top_counter_pairs"]:
        m=may_pairs.get((row["my_unit"],row["opponent_unit"]))
        lines.append(f"| {row['my_unit']} | {row['opponent_unit']} | {rate_cell(row)} | {rate_cell(m) if m else '— (0)'} |")
    lines += ["","## Military lead and swings","| Measurement | All games | May games |","|---|---|---|"]
    a,m=data["army_swings"]["all"],data["army_swings"]["May"]
    for minute in (10,15,20):
        lines.append(f"| Leader at {minute} min wins | {rate_cell(a['checkpoints'][str(minute)]['outcome'])} | {rate_cell(m['checkpoints'][str(minute)]['outcome'])} |")
    swing_cells=[]
    for stats in (a,m):
        swing_cells.append("; ".join(rate_cell(outcome) for outcome in
            (stats["biggest_swing_wins"],stats["restricted_biggest_swing_wins"]["excluding_last_120"]["outcome"],
             stats["restricted_biggest_swing_wins"]["before_15"]["outcome"])))
    lines.append(f"| Biggest ≤60s swing beneficiary wins: full / excl. last 120s / before 15:00 | {swing_cells[0]} | {swing_cells[1]} |")
    lines.append(f"Median max swing: {number(a['median_max_swing'])} all / {number(m['median_max_swing'])} May; median lead changes: {number(a['median_lead_changes'])} / {number(m['median_lead_changes'])}; total changes: {a['total_lead_changes']} / {m['total_lead_changes']}.")
    lines += ["","## Age arrival timing","| Completion bucket | Feudal WR all | Feudal WR May | Castle WR all | Castle WR May |","|---|---|---|---|---|"]
    for label in age_labels():
        cells=[rate_cell(data["age_timing"][cohort][age][label]) for age in ("feudal","castle") for cohort in ("all","May")]
        lines.append(f"| {label} | "+" | ".join(cells)+" |")
    lines += ["","## Castle-time difference (player minus opponent seconds; both reached Castle)",
              "| Difference (s) | WR all | WR May |","|---|---|---|"]
    for label in CASTLE_DIFF_BUCKETS:
        lines.append(f"| {label} | {rate_cell(data['castle_time_difference']['all'][label])} | {rate_cell(data['castle_time_difference']['May'][label])} |")
    lines += ["","## Method and limits"]+["- "+note for note in ARMY_NOTES]
    if len(lines)>90:
        raise ValueError(f"Army report exceeds 90 lines ({len(lines)})")
    return "\n".join(lines)+"\n"


def main() -> None:
    start = time.perf_counter()
    technologies = metadata()
    units = metadata(UNIT_CACHE, UNIT_URL)
    rows, statuses = snapshot()
    data,army = analyse(rows, technologies, units)
    data["counts"]["summary_statuses"] = statuses
    data["analysis_seconds"] = round(time.perf_counter()-start, 3)
    markdown = report(data)
    army["counts"]["summary_statuses"] = statuses
    army["counts"].update(ok_summaries=len(rows),excluded_summaries=len(data["errors"]))
    army["errors"] = data["errors"]
    army_markdown = army_report(army)
    OUT.mkdir(parents=True, exist_ok=True)
    atomic_write_text(OUT / "eco_summaries.json", json.dumps(data, indent=2, allow_nan=False))
    atomic_write_text(OUT / "ECO_SUMMARY.md", markdown)
    atomic_write_text(OUT / "army_summaries.json", json.dumps(army,indent=2,allow_nan=False))
    atomic_write_text(OUT / "ARMY_SUMMARY.md", army_markdown)
    # Keep each run under 60 console lines even as new civ variants appear.
    items = list(data["mapping"].items())
    for i in range(0, len(items), 2):
        print(" | ".join(f"{key} -> {value['tech']}" for key,value in items[i:i+2]))
    print("Counts:", json.dumps(data["counts"], sort_keys=True))
    print("Timestamp evidence:", json.dumps(data["timestamp_evidence"], sort_keys=True))
    for tech in DEFS:
        print(f"Benchmark {tech} ({'Castle' if tech=='shaft-mining' else 'Feudal'}): {benchmark_cells(data,tech)}")
    print(f"Wrote {OUT.relative_to(ROOT)}/eco_summaries.json + ECO_SUMMARY.md ({len(markdown.splitlines())} lines), {time.perf_counter()-start:.3f}s including output")
    print(f"Army: {army['counts']['games']} games, {army['counts']['player_games']} player-games; {army['counts']['qualifying_counter_pairs']} qualifying pairs; ARMY_SUMMARY.md {len(army_markdown.splitlines())} lines")


if __name__ == "__main__":
    main()
