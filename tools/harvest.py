"""Harvest high-rated ranked 1v1 games from aoe4world into harvest/aoe4.db (SQLite), for fight and eco analysis.

  python tools/harvest.py games       list May's games, then the 2000+ ladder's (players found snowball);
                                      --refresh re-lists stored players for games played since their last listing
  python tools/harvest.py summaries   download aoe4world match summaries of the eligible games
  python tools/harvest.py replays N   download the N best eligible replays without one to replays/harvest/
  python tools/harvest.py status      counts
  python tools/harvest.py all         games, then summaries (resumable; run again to continue)

Eligible game: ranked 1v1 on the current patch (the installed game build unless --patch), started within --days,
at least --min-seconds long, both players' MMR >= --min-mmr (the rank-points rating when MMR is missing). Everything
fetched is cached: a second run only asks for what is new. aoe4world is asked at most once per --pause seconds and
rate limits (HTTP 429) wait for Retry-After with exponential backoff.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sqlite3
import sys
import time
import urllib.error
import urllib.request
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import fetch_replays  # noqa: E402  (unpack, REPLAY_URL)

DB = ROOT / "harvest" / "aoe4.db"
LOG = ROOT / "harvest" / "harvest.log"
REPLAYS = ROOT / "replays" / "harvest"
MAY = 10307814
UA = "aoe4-replay-tools/1.0 (personal replay viewer; fight analysis)"
API = "https://aoe4world.com/api/v0"
GAMES = API + "/players/{pid}/games?leaderboard=rm_1v1&limit=50&page={page}&since={since}"
LADDER = API + "/leaderboards/rm_solo?page={page}"
SUMMARY = "https://aoe4world.com/players/{pid}/games/{gid}/summary?camelize=true"

SCHEMA = """
create table if not exists games (
  game_id integer primary key, started_at text, duration integer, map text, patch integer, season integer,
  p0 integer, p1 integer, p0_name text, p1_name text, p0_civ text, p1_civ text,
  p0_mmr integer, p1_mmr integer, p0_rating integer, p1_rating integer, p0_result text, p1_result text,
  seed text, raw text);
create table if not exists players (
  profile_id integer primary key, name text, rating integer, source text, listed_at text, games_seen integer);
create table if not exists summaries (game_id integer primary key, fetched_at text, status integer, body blob);
create table if not exists replays (game_id integer primary key, path text, status integer, build integer, fetched_at text);
"""

_last = 0.0


def log(msg: str) -> None:
    line = f"{dt.datetime.now():%H:%M:%S} {msg}"
    print(line, flush=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def get(url: str, pause: float) -> bytes:
    """GET politely: one request per `pause` s; 429 and 5xx back off (Retry-After or 30 s, doubling, 6 tries)."""
    global _last
    wait = 30.0
    for attempt in range(6):
        delay = _last + pause - time.time()
        if delay > 0:
            time.sleep(delay)
        _last = time.time()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=90) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code != 429 and e.code < 500:
                raise
            retry = e.headers.get("Retry-After", "")
            w = float(retry) if retry.isdigit() else wait
            log(f"  HTTP {e.code} on {url[:90]}; waiting {w:.0f} s")
            time.sleep(w)
            wait = min(wait * 2, 600)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            log(f"  network error {e} on {url[:90]}; waiting {wait:.0f} s")
            time.sleep(wait)
            wait = min(wait * 2, 600)
    raise RuntimeError(f"gave up on {url}")


def connect() -> sqlite3.Connection:
    DB.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB)
    con.executescript(SCHEMA)
    return con


def mmr(p: dict) -> int | None:
    return p.get("mmr") if p.get("mmr") is not None else p.get("rating")


def store_game(con: sqlite3.Connection, g: dict, seed: str) -> list[dict]:
    players = [t["player"] for team in g.get("teams", []) for t in team]
    if g.get("kind") != "rm_1v1" or len(players) != 2 or g.get("duration") is None:
        return []
    a, b = players
    con.execute(
        "insert or ignore into games values (?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?)",
        (g["game_id"], g["started_at"], g["duration"], g.get("map"), g.get("patch"), g.get("season"),
         a["profile_id"], b["profile_id"], a.get("name"), b.get("name"), a.get("civilization"), b.get("civilization"),
         mmr(a), mmr(b), a.get("rating"), b.get("rating"), a.get("result"), b.get("result"),
         seed, json.dumps(g, separators=(",", ":"))))
    return players


def list_player(con: sqlite3.Connection, pid: int, name: str, seed: str, a: argparse.Namespace,
                since_iso: str | None = None) -> list[dict]:
    """A player's ranked 1v1 games since the cut-off (or since_iso, when refreshing). Returns the opponents met in
    eligible games."""
    cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=a.days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    since = max(cutoff, since_iso or "")
    found, opponents = 0, []
    for page in range(1, 60):
        data = json.loads(get(GAMES.format(pid=pid, page=page, since=since), a.pause))
        games = data.get("games", [])
        for g in games:
            if g.get("started_at", "") < since:
                continue
            players = store_game(con, g, seed)
            found += 1
            if players and eligible_row(g, players, a):
                opponents += [p for p in players if p["profile_id"] != pid]
        con.commit()
        if not data.get("next_page") or not games or games[-1].get("started_at", "") < since:
            break
    con.execute("insert or replace into players values (?,?,?,?,?,?)",
                (pid, name, None, seed, dt.datetime.now().isoformat(timespec="seconds"), found))
    con.commit()
    return opponents


def eligible_row(g: dict, players: list[dict], a: argparse.Namespace) -> bool:
    return (g.get("patch") == a.patch and (g.get("duration") or 0) >= a.min_seconds
            and all((mmr(p) or 0) >= a.min_mmr for p in players))


def eligible_sql(a: argparse.Namespace) -> str:
    return (f"patch = {int(a.patch)} and duration >= {int(a.min_seconds)} "
            f"and p0_mmr >= {int(a.min_mmr)} and p1_mmr >= {int(a.min_mmr)} "
            f"and started_at >= '{(dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=a.days)):%Y-%m-%d}'")


def cmd_games(con: sqlite3.Connection, a: argparse.Namespace) -> None:
    """Lists unlisted players; with --refresh, also re-lists every stored player from a day before their last listing."""
    listed = dict(con.execute("select profile_id, listed_at from players"))
    done = set() if a.refresh else set(listed)
    queue: list[tuple[int, str, str]] = []
    if MAY not in done:
        queue.append((MAY, "May", "may"))
    page = 1
    while True:  # the ladder down to --ladder-min rank points
        data = json.loads(get(LADDER.format(page=page), a.pause))
        ps = data.get("players", [])
        queue += [(p["profile_id"], p["name"], "ladder") for p in ps
                  if p.get("rating", 0) >= a.ladder_min and p["profile_id"] not in done]
        if not ps or ps[-1].get("rating", 0) < a.ladder_min or not data.get("next_page"):
            break
        page += 1
    log(f"games: {len(queue)} players queued from May + ladder (rating >= {a.ladder_min}); {len(done)} already listed")
    seen = {q[0] for q in queue} | done
    t0, n = time.time(), 0
    while queue:
        if a.budget and time.time() - t0 > a.budget:
            log("games: time budget used; run again to continue")
            break
        pid, name, seed = queue.pop(0)
        if pid in done:
            continue
        since_iso = None
        if pid in listed:  # refresh: only what is new since the last listing (a day of overlap for late processing)
            since_iso = (dt.datetime.fromisoformat(listed[pid]) - dt.timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
        opp = list_player(con, pid, name, seed, a, since_iso)
        done.add(pid)
        n += 1
        for p in opp:  # snowball: 2000+ opponents not on the ladder slice yet
            if p["profile_id"] not in seen:
                seen.add(p["profile_id"])
                queue.append((p["profile_id"], p.get("name") or "?", "opponent"))
        if n % 10 == 0:
            el = con.execute(f"select count(*) from games where {eligible_sql(a)}").fetchone()[0]
            log(f"games: {n} players listed, {len(queue)} queued, {el} eligible games so far")
    status(con, a)


def cmd_summaries(con: sqlite3.Connection, a: argparse.Namespace) -> None:
    rows = con.execute(
        f"select game_id, p0, p1 from games where {eligible_sql(a)} and game_id not in "
        f"(select game_id from summaries where status between 200 and 499) "  # network/5xx failures are retried
        f"order by (p0 = {MAY} or p1 = {MAY}) desc, (p0_mmr + p1_mmr) desc").fetchall()
    log(f"summaries: {len(rows)} to fetch")
    t0 = time.time()
    for n, (gid, p0, p1) in enumerate(rows, 1):
        if a.budget and time.time() - t0 > a.budget:
            log("summaries: time budget used; run again to continue")
            break
        status_code, body = 200, None
        try:
            body = zlib.compress(get(SUMMARY.format(pid=p0, gid=gid), a.pause), 6)
        except urllib.error.HTTPError as e:
            status_code = e.code
        except RuntimeError:
            status_code = -1
        con.execute("insert or replace into summaries values (?,?,?,?)",
                    (gid, dt.datetime.now().isoformat(timespec="seconds"), status_code, body))
        con.commit()
        if n % 50 == 0:
            log(f"summaries: {n}/{len(rows)} ({(time.time() - t0) / n:.1f} s each)")
    status(con, a)


def cmd_replays(con: sqlite3.Connection, a: argparse.Namespace) -> None:
    """The best eligible games (May's first, then highest MMR) with a summary and no replay yet, 10-40 min long."""
    rows = con.execute(
        f"select g.game_id, g.p0 from games g join summaries s using (game_id) where s.status = 200 and {eligible_sql(a)} "
        f"and g.duration between 600 and 2400 "
        f"and g.game_id not in (select game_id from replays where status between 200 and 499) "
        f"order by (g.p0 = {MAY} or g.p1 = {MAY}) desc, (g.p0_mmr + g.p1_mmr) desc limit ?", (a.count,)).fetchall()
    REPLAYS.mkdir(parents=True, exist_ok=True)
    for n, (gid, pid) in enumerate(rows, 1):
        path = REPLAYS / f"aoe4_{gid}.rec"
        status_code = 200
        try:
            path.write_bytes(fetch_replays.unpack(get(fetch_replays.REPLAY_URL.format(gid=gid, pid=pid), a.pause)))
            body = con.execute("select body from summaries where game_id = ?", (gid,)).fetchone()[0]
            path.with_suffix(".summary.json").write_bytes(zlib.decompress(body))
        except urllib.error.HTTPError as e:
            status_code = e.code
        except RuntimeError:
            status_code = -1
        con.execute("insert or replace into replays values (?,?,?,?,?)",
                    (gid, str(path.relative_to(ROOT)) if status_code == 200 else None, status_code, None,
                     dt.datetime.now().isoformat(timespec="seconds")))
        con.commit()
        log(f"replays: {n}/{len(rows)} game {gid}: HTTP {status_code}")


def status(con: sqlite3.Connection, a: argparse.Namespace) -> None:
    q = lambda s: con.execute(s).fetchone()[0]  # noqa: E731
    el = eligible_sql(a)
    log(f"status: {q('select count(*) from players')} players listed, {q('select count(*) from games')} games, "
        f"{q(f'select count(*) from games where {el}')} eligible "
        f"({q(f'select count(*) from games where {el} and (p0 = {MAY} or p1 = {MAY})')} May's), "
        f"{q('select count(*) from summaries where status = 200')} summaries, "
        f"{q('select count(*) from replays where status = 200')} replays")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["games", "summaries", "replays", "status", "all"])
    ap.add_argument("count", nargs="?", type=int, default=20, help="replays: how many to download")
    ap.add_argument("--patch", type=int, default=11308, help="game build to keep (default 11308, the installed one)")
    ap.add_argument("--days", type=int, default=92, help="games started within this many days")
    ap.add_argument("--min-mmr", type=int, default=2000)
    ap.add_argument("--min-seconds", type=int, default=300)
    ap.add_argument("--ladder-min", type=int, default=1700, help="ladder players listed down to these rank points")
    ap.add_argument("--pause", type=float, default=1.1, help="seconds between requests")
    ap.add_argument("--budget", type=float, default=0, help="stop a step after this many seconds (0: no limit)")
    ap.add_argument("--refresh", action="store_true", help="games: re-list stored players for their new games")
    a = ap.parse_args()
    con = connect()
    if a.cmd in ("games", "all"):
        cmd_games(con, a)
    if a.cmd in ("summaries", "all"):
        cmd_summaries(con, a)
    if a.cmd == "replays":
        cmd_replays(con, a)
    if a.cmd == "status":
        status(con, a)


if __name__ == "__main__":
    main()
