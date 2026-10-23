"""Download May's ranked 1v1 replays into replays/may/ and list them in replays/may/manifest.json.

Usage:
    python tools/fetch_replays.py [--patch 11308] [--min-seconds 300]

Game ids come from the aoe4world API (one request per 50 games); each replay comes from the official Age of Empires
stats download (api.ageofempires.com GetMatchReplay), about 0.2-1 MB each. Requests are spaced 1 s apart and identify
this tool in the User-Agent; on HTTP 429 the script waits (Retry-After, default 60 s) and stops after 3 refusals.
Replays already on disk are skipped, so a rerun resumes. Old replays expire on the server (404). replays/may/ is made
on the first run.

Also caches tools/blueprints.json: aoe4world's static pbgid -> blueprint name table (data.aoe4world.com), which
recfile.Replay.commands() needs to name what a player built, trained or researched.
"""
from __future__ import annotations

import argparse
import gzip
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import recfile  # noqa: E402
from atomicio import atomic_write_text  # noqa: E402

MAY = 10307814
DST = ROOT / "replays" / "may"
MANIFEST = DST / "manifest.json"
BLUEPRINTS = ROOT / "tools" / "blueprints.json"
USER_AGENT = "aoe4-replay-tools/1.0 (personal replay viewer)"
GAMES_URL = "https://aoe4world.com/api/v0/players/{pid}/games?leaderboard=rm_1v1&limit=50&page={page}"
REPLAY_URL = "https://api.ageofempires.com/api/GameStats/AgeIV/GetMatchReplay/?gameId={gid}&profileId={pid}&matchId={gid}"
DATA_URL = "https://data.aoe4world.com/{kind}/all.json"
PAUSE = 1.0


def fetch(url: str) -> bytes:
    """GET with this tool's User-Agent. HTTP 429 (rate limited) waits Retry-After (default 60 s), 3 tries at most."""
    for attempt in range(3):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == 2:
                raise
            retry = e.headers.get("Retry-After", "")
            wait = int(retry) if retry.isdigit() else 60
            print(f"\n  rate limited; waiting {wait} s", flush=True)
            time.sleep(wait)
    raise AssertionError("unreachable")


def list_games(patch: int | None) -> tuple[int, list[dict]]:
    """May's 1v1 games on the patch, newest first. Pages are newest first, so listing stops at an older patch."""
    out: list[dict] = []
    page = 1
    while True:
        games = json.loads(fetch(GAMES_URL.format(pid=MAY, page=page))).get("games", [])
        if patch is None and games:
            patch = games[0]["patch"]
        out += [g for g in games if g["patch"] == patch]
        if len(games) < 50 or any(g["patch"] < patch for g in games):
            return patch, out
        page += 1
        time.sleep(PAUSE)


def sides(game: dict) -> tuple[dict, dict]:
    players = [p["player"] for team in game["teams"] for p in team]
    return (next(p for p in players if p["profile_id"] == MAY),
            next(p for p in players if p["profile_id"] != MAY))


def unpack(raw: bytes) -> bytes:
    """The endpoint answers with a ZIP or a gzip stream depending on the game."""
    if raw[:2] == b"PK":
        z = zipfile.ZipFile(io.BytesIO(raw))
        return z.read(z.namelist()[0])
    if raw[:2] == b"\x1f\x8b":
        return gzip.decompress(raw)
    return raw


class InvalidReplay(ValueError):
    pass


def publish_replay(path: Path, raw: bytes) -> recfile.Replay:
    """Validate a temporary download before publication; retain bad responses as .rec.bad."""
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_bytes(raw)
        try:
            data = unpack(raw)
            with temporary.open("wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            replay = recfile.load(temporary)
        except Exception as e:
            os.replace(temporary, path.with_suffix(".rec.bad"))
            raise InvalidReplay(f"invalid replay quarantined: {e}") from e
        os.replace(temporary, path)
        return replay
    finally:
        temporary.unlink(missing_ok=True)


def existing_replay(path: Path) -> recfile.Replay | None:
    if not path.exists():
        return None
    try:
        return recfile.load(path)
    except Exception:
        os.replace(path, path.with_suffix(".rec.bad"))
        return None


def blueprint_table() -> None:
    table = {}
    for kind in ("units", "buildings", "technologies"):
        data = json.loads(fetch(DATA_URL.format(kind=kind)))
        for x in data["data"] if isinstance(data, dict) else data:
            if x.get("pbgid") and x.get("attribName"):
                table[str(x["pbgid"])] = x["attribName"]
        time.sleep(PAUSE)
    atomic_write_text(BLUEPRINTS, json.dumps(table, sort_keys=True))
    print(f"Wrote {len(table)} blueprint names to {BLUEPRINTS}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--patch", type=int, help="game patch to collect (default: patch of May's latest game)")
    ap.add_argument("--min-seconds", type=int, default=300, help="skip games shorter than this")
    ap.add_argument("--refresh-blueprints", action="store_true", help="re-download tools/blueprints.json")
    args = ap.parse_args()
    DST.mkdir(parents=True, exist_ok=True)

    if args.refresh_blueprints or not BLUEPRINTS.exists():
        blueprint_table()
    patch, games = list_games(args.patch)
    games = [g for g in games if (g.get("duration") or 0) >= args.min_seconds]
    print(f"{len(games)} ranked 1v1 games of May on patch {patch} lasting at least {args.min_seconds} s")

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else []
    known = {m["game_id"] for m in manifest if m.get("status") != -2}
    added, missing, unreadable = 0, [], []
    for n, game in enumerate(games, 1):
        print(f"\r  {n}/{len(games)}", end="", flush=True)
        gid = game["game_id"]
        path = DST / f"may_{gid}.rec"
        replay = existing_replay(path)
        if replay is None:
            known.discard(gid)
            manifest = [m for m in manifest if m["game_id"] != gid]
            manifest.append({"game_id": gid, "file": path.name, "date": game["started_at"][:10],
                             "status": -2, "build": None})
            try:
                replay = publish_replay(path, fetch(REPLAY_URL.format(gid=gid, pid=MAY)))
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    print(f"\n  still rate limited after retries; stopping at game {n}, run again later")
                    break
                missing.append(f"{gid} (HTTP {e.code})")
                continue
            except InvalidReplay as e:
                unreadable.append(f"{gid} ({e})")
                continue
            finally:
                time.sleep(PAUSE)
        if gid in known:
            for entry in manifest:
                if entry["game_id"] == gid:
                    entry.update(build=replay.version, status=200)
            continue
        build = replay.version
        manifest = [m for m in manifest if m["game_id"] != gid]
        me, opp = sides(game)
        manifest.append({
            "game_id": gid, "file": path.name, "date": game["started_at"][:10], "map": game["map"],
            "minutes": round(game["duration"] / 60, 1), "result": me.get("result"),
            "may_civ": me.get("civilization"), "opponent": opp.get("name"),
            "opponent_civ": opp.get("civilization"), "opponent_rating": opp.get("rating"),
            "build": build, "status": 200,
        })
        known.add(gid)
        added += 1
    manifest.sort(key=lambda m: m["date"], reverse=True)
    atomic_write_text(MANIFEST, json.dumps(manifest, indent=1, ensure_ascii=False))
    print(f"\nManifest: {len(manifest)} games ({added} new); no replay on the server for {len(missing)}"
          + (": " + ", ".join(missing) if missing else ""))
    if unreadable:
        print("Downloaded but recfile cannot parse: " + "; ".join(unreadable))


if __name__ == "__main__":
    main()
