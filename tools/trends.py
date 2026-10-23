"""Per-player numbers from every recorded match, for the trends page (viewer/trends.html).

Usage:
    python tools/trends.py

Reads every match in viewer/data, adds each game's result and ratings from aoe4world (api/v0/games/<id>) and writes
viewer/data/trends/games.js. Match caches include payload and analysis-source hashes plus a schema version, and aoe4world is asked only about
games it has not answered yet (a failed request is retried on the next run), so convert.py runs this after every
conversion. A match needs its game ID in its name (aoe4_<id>, may_<id>); others, such as temp, are left out, and when
two files hold the same game the newest counts. Players are matched to aoe4world's by name.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_replays  # noqa: E402
from atomicio import atomic_write_text

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "viewer" / "data"
OUT = DATA_DIR / "trends" / "games.js"
GAME_URL = "https://aoe4world.com/api/v0/games/{gid}"
PREFIX = "window.TRENDS = "
MINUTES = 40        # length of the per-minute villager and army value curves
BIG_FIGHT = 1000    # resources lost by all sides together that make a fight "big"
MIN_GAME = 300      # shorter games (someone left or dropped before anything happened) are left out of the page
AGES = {"Feudal Age": "feudal", "Castle Age": "castle", "Imperial Age": "imperial"}
VERSION = 2        # schema; source hashes invalidate math changes automatically


def engine_hash() -> str:
    digest = hashlib.sha256(str(VERSION).encode())
    for path in (Path(__file__), ROOT / "tools" / "fetch_replays.py"):
        digest.update(path.read_bytes())
    return digest.hexdigest()


def published_matches() -> list[Path]:
    text = (DATA_DIR / "index.js").read_text(encoding="utf-8")
    names = json.loads(re.search(r"window\.REPLAY_INDEX\s*=\s*(\[[^;]*\])\s*;", text)[1])
    return [DATA_DIR / f"{name}.js" for name in names if (DATA_DIR / f"{name}.js").is_file()]


def owner_at(entity: dict, t: float) -> int:
    owner = entity["owner"]
    for moment, value in entity.get("owners") or []:
        if moment > t:
            break
        owner = value
    return owner


def load_match(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    return json.loads(text[text.index('"] = ') + 5:text.rindex("}") + 1])


def match_metrics(d: dict) -> dict:
    """Per-player numbers of one match (times in seconds, values in resources)."""
    duration, army, step = d["duration"], d["army"], d["army"]["step"]
    team = {p["idx"]: p["team"] for p in d["players"]}
    first_tech: dict[tuple[int, str], float] = {}
    eco10 = Counter()
    for t, idx, label, kind in d["techs"]:
        if kind == "age":
            first_tech.setdefault((idx, label), t)
        elif t <= 600:
            eco10[idx] += 1
    fights = sorted(d["fights"], key=lambda f: f["start"])
    entities = {e["id"]: e for e in d.get("entities", [])}
    killed = Counter()
    for event in d.get("kills", []):
        victim, killer = entities.get(event["victim"]), entities.get(event.get("killer"))
        if victim is None or killer is None:
            continue
        vo, ko = owner_at(victim, event["t"]), owner_at(killer, event["t"])
        if vo in team and ko in team and team[vo] != team[ko]:
            killed[ko] += victim.get("value", 0)
    players = []
    for p in d["players"]:
        idx = p["idx"]
        series = army["players"].get(str(idx))
        minutes = [round(m * 60 / step) for m in range(MINUTES + 1) if m * 60 <= duration]
        vil = [series["villagers"][i] for i in minutes] if series else []
        value = [series["armyValue"][i] for i in minutes] if series else []
        banks = [(row[0], sum(row[1:5])) for row in d["stats"].get(str(idx), [])]  # [t, food, wood, gold, stone, pop]
        after5 = [b for t, b in banks if t >= 300]
        mine = [f for f in fights if idx in f["participants"]]
        big = next((f for f in mine if sum(lo["value"] for lo in f["losses"].values()) >= BIG_FIGHT), None)
        at_big = [b for t, b in banks if big and t <= big["start"]]
        players.append({
            "idx": idx, "name": p["name"], "civ": p["civ"], "team": p["team"],
            **{key: round(first_tech[(idx, label)]) if (idx, label) in first_tech else None
               for label, key in AGES.items()},
            "vil10": vil[10] if len(vil) > 10 else None,
            "army15": value[15] if len(value) > 15 else None,
            "eco10": eco10[idx],
            "bank": round(sum(after5) / len(after5)) if after5 else None,
            "fightAt": round(big["start"]) if big else None,
            "bankFight": at_big[-1] if at_big else None,
            "lost": sum(f["losses"].get(str(idx), {}).get("value", 0) for f in mine),
            "killed": killed[idx],
            "vilCurve": vil, "armyCurve": value,
        })
    return {"date": d["replay"].get("date"), "duration": round(duration), "players": players}


def game_info(gid: int) -> dict:
    g = json.loads(fetch_replays.fetch(GAME_URL.format(gid=gid)))
    return {
        "map": g.get("map"), "started": g.get("started_at"), "kind": g.get("kind"),
        "players": [{"name": p.get("name"), "profile": p.get("profile_id"), "civ": p.get("civilization"),
                     "result": p.get("result"), "rating": p.get("rating")} for team in g.get("teams", []) for p in team],
    }


def mode(players: list[dict]) -> str:
    sizes = sorted(Counter(p["team"] for p in players).values(), reverse=True)
    return "v".join(map(str, sizes)) if len(sizes) == 2 else f"{len(players)}-player FFA"


def pair(players: list[dict], aw: list[dict]) -> dict[int, dict]:
    """Each match player's aoe4world entry: by name, then the one player left on each side (players rename, and
    aoe4world shows today's name)."""
    by_name = {(a["name"] or "").casefold(): a for a in aw}
    pairs = {p["idx"]: by_name.get(p["name"].casefold(), {}) for p in players}
    left = [idx for idx, a in pairs.items() if not a]
    rest = [a for a in aw if all(a is not b for b in pairs.values())]
    if len(left) == 1 and len(rest) == 1:
        pairs[left[0]] = rest[0]
    return pairs


def rows(matches: dict, games: dict) -> list[dict]:
    """One row per player and match, joined with aoe4world's result, civilization and rating. Players are keyed by
    aoe4world profile; a name aoe4world never matched takes that name's profile from other games when exactly one
    profile carries it (two people can share a name), else stays keyed by the name."""
    out = []
    for stem, m in matches.items():
        if m["duration"] < MIN_GAME:
            continue
        info = games.get(str(m["game"]), {})
        aw = pair(m["players"], info.get("players", []))
        for p in m["players"]:
            a = aw[p["idx"]]
            out.append({
                "stem": stem, "game": m["game"], "date": info.get("started") or m["date"], "map": info.get("map"),
                "duration": m["duration"], "mode": mode(m["players"]),
                "player": f"p{a['profile']}" if a.get("profile") else f"n{p['name']}",
                "name": a.get("name") or p["name"],
                "civ": a.get("civ") or p["civ"], "result": a.get("result"), "rating": a.get("rating"),
                "vs": [aw[q["idx"]].get("civ") or q["civ"] for q in m["players"] if q["team"] != p["team"]],
                **{k: v for k, v in p.items() if k not in ("idx", "name", "civ", "team")},
            })
    profiles: dict[str, set[str]] = {}
    for r in out:
        if r["player"].startswith("p"):
            profiles.setdefault(r["name"].casefold(), set()).add(r["player"])
    for r in out:
        ids = profiles.get(r["name"].casefold(), set())
        if r["player"].startswith("n") and len(ids) == 1:
            r["player"] = next(iter(ids))
    return out


def update() -> str:
    """Refresh viewer/data/trends/games.js; returns a one-line summary."""
    code_hash = engine_hash()
    old = {"version": VERSION, "engineHash": code_hash, "matches": {}, "games": {}}
    if OUT.exists():
        text = OUT.read_text(encoding="utf-8")
        old = json.loads(text[len(PREFIX):text.rindex("}") + 1])
    if old.get("version") != VERSION or old.get("engineHash") != code_hash:
        old["matches"] = {}
    newest: dict[int, Path] = {}
    for path in sorted(published_matches(), key=lambda p: p.stat().st_mtime):
        found = re.search(r"(\d{6,})", path.stem)
        if path.stem != "index" and found:
            newest[int(found[1])] = path
    matches, read, asked, failed = {}, 0, 0, 0
    for gid, path in newest.items():
        st = path.stat()
        m = old["matches"].get(path.stem)
        source_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        if not m or m.get("sourceHash") != source_hash:
            m = {"game": gid, "size": st.st_size, "mtime": st.st_mtime_ns, "sourceHash": source_hash, **match_metrics(load_match(path))}
            read += 1
        matches[path.stem] = m
    games = {gid: g for gid, g in old["games"].items() if int(gid) in newest}
    for gid in newest:
        if str(gid) in games:
            continue
        try:
            games[str(gid)] = game_info(gid)
            asked += 1
        except Exception as e:  # offline, or the game is not on aoe4world: no result for it this time
            print(f"aoe4world game {gid}: {e}")
            failed += 1
        time.sleep(fetch_replays.PAUSE)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {"version": VERSION, "engineHash": code_hash, "made": time.strftime("%Y-%m-%d %H:%M"), "rows": rows(matches, games),
               "matches": matches, "games": games}
    atomic_write_text(OUT, PREFIX + json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + ";\n")
    return (f"trends: {len(matches)} matches ({read} read), {asked} results from aoe4world"
            + (f", {failed} failed" if failed else "") + f" -> {OUT}")


if __name__ == "__main__":
    print(update())
