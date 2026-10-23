"""Replay Recorder: a page in the browser where you paste aoe4world match links; it downloads each replay and records
it in the game, one after another, ready to open in the viewer.

Usage:
    python tools/recorder_app.py        (or double-click "Replay Recorder.bat")

Opens http://127.0.0.1:47811/. The page shows where the game is (found through Steam, or a folder you pick), whether
Steam is running and signed in, and the folder downloaded replays are saved in (pick any). A match link is the address
of a match page on aoe4world.com (https://aoe4world.com/players/<player>/games/<game>...). Each link downloads, in one
step, everything it provides: the replay (<stem>.rec, from the official Age of Empires server) and aoe4world's match
summary that the link's page shows (<stem>.summary.json next to it: build orders, resources and scores over time,
APM, map seed). Replays are recorded with tools/record_replay.py; the game pops up while each one records.
The list and the chosen folders are kept in recorder_app.json, so closing and reopening continues where it stopped;
Clear list empties the list (downloaded replays and recordings stay on disk).
It also serves the 2D viewer at /viewer/, whose "Watch in game" button (POST /api/watch, progress from GET /api/watch)
opens the game on that replay and fast-forwards it to the moment and place the viewer shows; a game it opened that
still shows the replay fast-forwards in place for later moments. The 3D viewer (viewer3d/serve.mjs, port 8080) is
started with it unless it already runs, so finished matches open in 3D from the list.
After a recording is converted, the blueprints it uses that viewer3d/assets/catalog.json has no models for are built in the
background (viewer3d/tools/build-assets.mjs, then havok/bake-anims.mjs); the match's row shows how that goes and a failure
there leaves the recording done. "toolchain_dir" in recorder_app.json sets AOE4_REBUILD for those scripts (the folder
holding the Essence CLI, the .NET runtime and the unpacked archives; default the project's toolchain folder).
Close the console window to quit.
"""
from __future__ import annotations

import ctypes
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import winreg
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import aoe4input as ai  # noqa: E402
import convert  # noqa: E402
import fetch_replays  # noqa: E402
import recfile  # noqa: E402
import record_replay as rr  # noqa: E402
import runlock  # noqa: E402
from atomicio import atomic_write_text  # noqa: E402

PORT = 47811
PAGE = ROOT / "tools" / "recorder_app.html"
VIEWER = ROOT / "viewer"
STATE_FILE = ROOT / "recorder_app.json"
MATCH_LINK = re.compile(r"aoe4world\.com/players/(\d+)[^/\s]*/games/(\d+)")
SUMMARY_URL = "https://aoe4world.com/players/{pid}/games/{gid}/summary?camelize=true"  # what the link's page loads
VIEWER3D_PORT = 8080  # viewer3d/serve.mjs's default port
VIEWER3D = f"http://127.0.0.1:{VIEWER3D_PORT}/"
viewer3d_ok = False  # the 3D viewer answered at startup
ASSET_TOOLS = ROOT / "viewer3d" / "tools"
FAIL_LIMIT = 3  # recordings failing in a row before recording pauses (Steam signed out, game updating)
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml"}
PICK_SCRIPT = (
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; "
    "$owner = New-Object System.Windows.Forms.Form -Property @{TopMost = $true}; "
    "$d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = $env:PICK_TITLE; "
    "$d.SelectedPath = $env:PICK_START; $d.ShowNewFolderButton = $true; "
    "if ($d.ShowDialog($owner) -eq 'OK') { $d.SelectedPath }"
)
WATCH_FAST = rr.SIM_TICKS_PER_SECOND * 125  # fast-forward sim rate: record_replay.py's default, effectively uncapped
# Typed into the replay's -dev SCAR console after a header setting RW_TARGET, RW_X, RW_Z, RW_FAST and RW_NORMAL; the
# same rules as recorder/recorder.lua (named global functions, errors caught, no tilde). Fast-forwards to RW_TARGET
# seconds of game time, then plays on at normal speed with the camera on RW_X, RW_Z. Loading it again in the same game
# replaces the previous run's rule.
WATCH_LUA = """
if RW_Seek then pcall(Rule_Remove, RW_Seek) end
RW_DONE = false
RW_NEXT = 0
function RW_SetRate(rate)
  local f = Game_SetSimRate or Misc_SetSimRate
  f(rate)
end
function RW_Camera()
  local p = Util_ScarPos and Util_ScarPos(RW_X, RW_Z) or World_Pos(RW_X, 0, RW_Z)
  Camera_MoveTo(p)
end
function RW_Arrive(t)
  RW_DONE = true
  RW_SetRate(RW_NORMAL)
  local ok, err = pcall(RW_Camera)
  if not ok then print("R|WATCH|CAM|" .. tostring(err)) end
  print("R|WATCH|AT|" .. string.format("%.1f", t))
  pcall(Rule_Remove, RW_Seek)
end
function RW_Step()
  local t = World_GetGameTime()
  if t >= RW_TARGET then
    RW_Arrive(t)
  elseif t >= RW_NEXT then
    RW_NEXT = t + 2
    print("R|WATCH|T|" .. string.format("%.1f", t))
  end
end
function RW_Seek()
  if RW_DONE then return end
  local ok, err = pcall(RW_Step)
  if not ok then
    RW_DONE = true
    print("R|WATCH|ERR|" .. tostring(err))
  end
end
if World_GetGameTime() < RW_TARGET then RW_SetRate(RW_FAST) end
Rule_AddInterval(RW_Seek, 0.125)
"""


def pick_folder(title: str, start: Path) -> Path | None:
    """Windows' folder picker, on top of the browser; None when cancelled."""
    out = subprocess.run(["powershell", "-NoProfile", "-STA", "-Command", PICK_SCRIPT], capture_output=True,
                         text=True, encoding="utf-8", env={**os.environ, "PICK_TITLE": title, "PICK_START": str(start)})
    return Path(out.stdout.strip()) if out.stdout.strip() else None


def process_alive(pid: int) -> bool:
    k32 = ctypes.windll.kernel32
    handle = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return False
    code = ctypes.c_ulong()
    ok = k32.GetExitCodeProcess(handle, ctypes.byref(code))
    k32.CloseHandle(handle)
    return bool(ok) and code.value == 259  # STILL_ACTIVE


def steam_status() -> tuple[bool, bool]:
    """(running, signed in), from the registry values Steam keeps while it runs."""
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam\ActiveProcess") as key:
            pid = winreg.QueryValueEx(key, "pid")[0]
            user = winreg.QueryValueEx(key, "ActiveUser")[0]
    except OSError:
        return False, False
    running = bool(pid) and process_alive(pid)
    return running, running and user != 0


def nice(name: str) -> str:
    return name.replace("_", " ").title()


def describe(rep: recfile.Replay) -> tuple[str, str]:
    """("Wam01 (Lancaster) vs Tikm (Templar)", "Dry Arabia")"""
    teams: dict[int, list[str]] = {}
    for p in rep.players:
        teams.setdefault(p.team, []).append(f"{p.name} ({nice(p.civ)})")
    return " vs ".join(", ".join(t) for t in teams.values()), nice(rep.map.layout) if rep.map else ""


def run_node(node: str, args: list[str], env: dict, on_line=None) -> tuple[int, list[str]]:
    """Runs a node script with viewer3d/ as the working directory; (exit code, its output lines)."""
    proc = subprocess.Popen([node, *args], cwd=ROOT / "viewer3d", stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace", env=env)
    lines = []
    for line in proc.stdout:
        line = line.rstrip()
        if line:
            lines.append(line)
            if on_line:
                on_line(line)
    return proc.wait(), lines


def node_error(lines: list[str]) -> str:
    """The message of a failed node script: its last output line that is not a stack frame."""
    return next((l for l in reversed(lines) if not l.startswith((" ", "\t", "Node.js v", "^"))), "no output")


def build_3d_assets(stem: str, report, toolchain: Path | None = None) -> bool:
    """Makes sure viewer3d/assets/catalog.json has models for every blueprint and gaia type recording `stem` uses:
    build-assets.mjs --check lists what is missing, and when that is not empty build-assets.mjs --replay builds it and
    bake-anims.mjs bakes the animations of the new units. report(state, text) is told how it goes (state: checking,
    building, baking, done, skipped, error). Returns True when the catalog covers the recording afterwards. Never raises;
    without node or viewer3d/tools/node_modules nothing is run (state skipped)."""
    try:
        node = shutil.which("node")
        if node is None:
            report("skipped", "3D models not checked: Node.js was not found")
            return False
        if not (ASSET_TOOLS / "node_modules").is_dir():
            report("skipped", "3D models not checked: run npm ci in viewer3d/tools first")
            return False
        env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
        if toolchain:
            env["AOE4_REBUILD"] = str(toolchain)
        report("checking", "Checking 3D models…")
        code, lines = run_node(node, ["tools/build-assets.mjs", "--replay", stem, "--check"], env)
        try:
            missing = json.loads(next(l for l in reversed(lines) if l.startswith("{")))["missing"]
        except (StopIteration, ValueError, KeyError):
            report("error", f"3D models check failed: {node_error(lines)}")
            return False
        if code != 0:
            report("error", f"3D models check failed: {node_error(lines)}")
            return False
        if not missing:
            report("done", "3D models up to date")
            return True
        what = f"{len(missing)} new blueprint{'s' if len(missing) != 1 else ''}"
        report("building", f"Building 3D models for {what}…")
        progress = {"total": 0, "done": 0}

        def on_line(line: str) -> None:
            m = re.match(r"building (\d+) models", line)
            if m:
                progress["total"] = int(m.group(1))
            elif line.startswith(("  ✓", "  ! ")) and progress["total"]:
                progress["done"] += 1
                report("building", f"Building 3D models for {what}… {progress['done']}/{progress['total']}")

        code, lines = run_node(node, ["tools/build-assets.mjs", "--replay", stem], env, on_line)
        if code != 0:
            report("error", f"3D models failed: {node_error(lines)}")
            return False
        report("baking", "Baking 3D animations…")
        code, lines = run_node(node, ["tools/havok/bake-anims.mjs"], env)
        if code != 0:
            report("error", f"3D animations failed: {node_error(lines)}")
            return False
        report("done", f"3D models built ({what})")
        return True
    except Exception as e:  # a viewer asset problem must never touch the recording
        report("error", f"3D models failed: {e}")
        return False


class WatchError(RuntimeError):
    pass


class App:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        saved = json.loads(STATE_FILE.read_text(encoding="utf-8")) if STATE_FILE.exists() else {}
        self.picked_game = Path(saved["game_dir"]) if saved.get("game_dir") else None
        # Paths inside this folder are saved relative to it, so the folder can move to another PC; ROOT / an absolute
        # path is that path.
        self.replays_dir = ROOT / (saved.get("replays_dir") or Path("replays") / "aoe4world")
        self.items: list[dict] = saved.get("items", [])
        # AOE4_REBUILD for the 3D asset scripts
        self.toolchain = ROOT / saved["toolchain_dir"] if saved.get("toolchain_dir") else None
        self.assets: dict[str, dict] = {}  # stem -> {state, text}: the 3D models built after the recording
        self.asset_jobs: queue.Queue[str] = queue.Queue()
        for it in self.items:
            if it.get("file"):
                it["file"] = str(ROOT / it["file"])
        self.game_dir: Path | None = None
        self.build: int | None = None
        self.refresh_game()
        self.done = {it["stem"] for it in self.items if self.is_done(it)}
        self.failed: dict[str, str] = {}  # stem -> why; tried again when recording is (re)started
        self.current: dict | None = None  # the recording in progress
        self.proc: subprocess.Popen | None = None
        self.paused = False
        self.pause_reason = ""
        self.stopping = False
        self.note = ""  # why recording is waiting (game open, Steam signed out)
        self.watch: dict | None = None  # the viewer's "Watch in game": state running/ready/error, text, name
        self.watch_game: dict | None = None  # the game Watch in game opened: pid, src, log, console; reused while open
        self.downloads: queue.Queue[dict] = queue.Queue()
        for it in self.items:
            # the app closed during the download, or the summary is still missing (only what is missing is fetched)
            if not it.get("error") and (not it.get("file") or not self.summary_path(it).exists()):
                self.downloads.put(it)
        self.wake = threading.Event()
        threading.Thread(target=self.download_loop, daemon=True).start()
        threading.Thread(target=self.record_loop, daemon=True).start()
        threading.Thread(target=self.asset_loop, daemon=True).start()

    def refresh_game(self) -> None:
        if self.picked_game and not (self.picked_game / ai.GAME_EXE).exists():
            self.picked_game = None  # picked on another PC, or uninstalled: find the game through Steam again
        game_dir = self.picked_game or rr.find_game_dir()
        found = game_dir is not None and (game_dir / ai.GAME_EXE).exists()
        self.game_dir = game_dir if found else None
        self.build = rr.installed_build(game_dir) if found else None

    def save(self) -> None:
        def portable(p: Path | str) -> str:
            p = Path(p)
            return str(p.relative_to(ROOT)) if p.is_relative_to(ROOT) else str(p)

        data = {"game_dir": str(self.picked_game) if self.picked_game else None,
                "replays_dir": portable(self.replays_dir),
                "toolchain_dir": portable(self.toolchain) if self.toolchain else None,
                "items": [{**it, "file": portable(it["file"])} if it.get("file") else it for it in self.items]}
        atomic_write_text(STATE_FILE, json.dumps(data, indent=1, ensure_ascii=False))

    @staticmethod
    def summary_path(it: dict) -> Path:
        return Path(it["file"]).with_suffix(".summary.json")

    @staticmethod
    def is_done(it: dict) -> bool:
        return (bool(it.get("seconds")) and rr.is_complete(ROOT / "recordings" / f"{it['stem']}.rlog", it["seconds"])
                and convert.payload_valid(convert.DATA_DIR / f"{it['stem']}.js"))

    def is_waiting(self, it: dict) -> bool:
        return (bool(it.get("file")) and not it.get("error") and it["stem"] not in self.done
                and it["stem"] not in self.failed and (self.build is None or it["build"] == self.build))

    # ---- actions from the page

    def add(self, text: str) -> dict:
        added = known = 0
        links = list(MATCH_LINK.finditer(text))
        with self.lock:
            by_id = {it["game_id"]: it for it in self.items}
            for m in links:
                gid = int(m.group(2))
                if gid in by_id:
                    it = by_id[gid]
                    if it.get("error") or it.get("summary_error"):  # adding it again retries the download
                        it.pop("error", None)
                        self.downloads.put(it)
                    known += 1
                    continue
                it = {"stem": f"aoe4_{gid}", "game_id": gid, "profile_id": int(m.group(1)), "link": "https://" + m.group(0)}
                self.items.append(it)
                by_id[gid] = it
                self.downloads.put(it)
                added += 1
            self.save()
        return {"links": len(links), "added": added, "known": known}

    def pick(self, what: str) -> dict:
        if what == "auto":
            with self.lock:
                self.picked_game = None
                self.refresh_game()
                self.save()
        elif what == "game":
            folder = pick_folder("Pick the Age of Empires IV folder (the one that contains RelicCardinal.exe)",
                                 self.game_dir or Path("C:/"))
            if folder is None:
                return {}
            if not (folder / ai.GAME_EXE).exists():
                return {"error": f"{folder} does not contain {ai.GAME_EXE}. Pick the folder Age of Empires IV is "
                                 "installed in, for example ...\\steamapps\\common\\Age of Empires IV."}
            with self.lock:
                self.picked_game = folder
                self.refresh_game()
                self.save()
        elif what == "replays":
            folder = pick_folder("Pick the folder downloaded replays are saved in", self.replays_dir)
            if folder is None:
                return {}
            with self.lock:
                self.replays_dir = folder
                self.save()
        self.wake.set()
        return {}

    def start(self) -> None:
        with self.lock:
            self.paused = False
            self.pause_reason = ""
            self.failed.clear()
        self.wake.set()

    def stop(self) -> None:
        with self.lock:
            self.paused = True
            self.pause_reason = "Stopped. Press Start to continue."
            if self.proc is not None:
                self.stopping = True
                self.proc.kill()

    def clear(self) -> dict:
        """Empty the list, except the match being recorded right now. Downloaded replays and recordings stay on disk."""
        with self.lock:
            keep = self.current["stem"] if self.current else None
            gone = {it["stem"] for it in self.items if it["stem"] != keep}
            self.items = [it for it in self.items if it["stem"] == keep]
            self.done -= gone
            for stem in gone:
                self.failed.pop(stem, None)
            self.save()
        return {"removed": len(gone)}

    # ---- background work

    def download_loop(self) -> None:
        while True:
            it = self.downloads.get()
            with self.lock:
                if not any(i is it for i in self.items):  # cleared from the list while waiting for its turn
                    continue
            path = Path(it["file"]) if it.get("file") else self.replays_dir / f"{it['stem']}.rec"
            rep = fetch_replays.existing_replay(path)
            fresh = rep is None
            error = None
            try:
                if fresh:
                    url = fetch_replays.REPLAY_URL.format(gid=it["game_id"], pid=it["profile_id"])
                    path.parent.mkdir(parents=True, exist_ok=True)
                    rep = fetch_replays.publish_replay(path, fetch_replays.fetch(url))
                    time.sleep(fetch_replays.PAUSE)
            except urllib.error.HTTPError as e:
                error = ("No replay on the server for this match (it is too old, or the player does not share match "
                         "history)" if e.code == 404 else f"Download failed (HTTP {e.code})")
            except Exception as e:  # no network, disk full, the server sent something that is not a replay
                error = f"Download failed: {e}"
                if fresh:
                    path.unlink(missing_ok=True)
            summary_error = self.download_summary(it, path.with_suffix(".summary.json"))
            with self.lock:
                if error:
                    it["error"] = error
                else:
                    title, map_name = describe(rep)
                    it.update(file=str(path), seconds=rep.duration_seconds, build=rep.version, title=title,
                              map=map_name)
                    if self.is_done(it):
                        self.done.add(it["stem"])
                if summary_error:
                    it["summary_error"] = summary_error
                else:
                    it.pop("summary_error", None)
                self.save()
            print(f"[{it['stem']}] " + (error or f"downloaded: {it['title']}")
                  + (f"; aoe4world summary failed: {summary_error}" if summary_error else ""))
            self.wake.set()

    @staticmethod
    def download_summary(it: dict, dest: Path) -> str | None:
        """aoe4world's summary of the match (the JSON the link's page shows), saved as dest unless it is there.
        Returns why it failed, or None. A missing summary does not hold up recording; adding the link again retries."""
        if dest.exists():
            return None
        try:
            data = fetch_replays.fetch(SUMMARY_URL.format(gid=it["game_id"], pid=it["profile_id"]))
            json.loads(data)  # an error page is not a summary
            dest.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_text(dest, data.decode("utf-8"))
            time.sleep(fetch_replays.PAUSE)
            return None
        except urllib.error.HTTPError as e:
            return f"HTTP {e.code}"
        except Exception as e:  # no network, disk full, not JSON
            return str(e)

    def blocker(self) -> str:
        """Why recording cannot start right now, or ""."""
        holders = runlock.active("recording")
        if holders:
            return f"Another controller is using the game (PIDs: {holders})."
        if self.watching():
            return ("Opening a replay in the game for the viewer. Close the game afterwards and recording starts by "
                    "itself.")
        if self.game_dir is None:
            return "Age of Empires IV was not found. Pick its folder above."
        running, signed_in = steam_status()
        if not running:
            return "Steam is not running. Start Steam and sign in; recording starts by itself."
        if not signed_in:
            return "Steam is not signed in. Sign in; recording starts by itself."
        if ai.game_pid() is not None:
            return "Age of Empires IV is open. Close it and recording starts by itself."
        return ""

    def record_loop(self) -> None:
        in_a_row = 0
        while True:
            self.wake.wait(5)
            self.wake.clear()
            with self.lock:
                it = None if self.paused else next((i for i in self.items if self.is_waiting(i)), None)
            if it is None:
                self.note = ""
                continue
            self.note = self.blocker()
            if self.note:
                continue
            result = self.run_recording(it)
            if result is False:
                in_a_row += 1
                if in_a_row >= FAIL_LIMIT:
                    in_a_row = 0
                    with self.lock:
                        self.paused = True
                        self.pause_reason = (f"{FAIL_LIMIT} recordings in a row failed, so recording is paused. Check "
                                             "that Steam is signed in and the game is not updating, then press Start.")
            elif result is True:
                in_a_row = 0
            self.wake.set()

    def run_recording(self, it: dict) -> bool | None:
        """Record one replay in a record_replay.py process. True: done; False: failed; None: stopped by the user."""
        cmd = [sys.executable, "-u", str(ROOT / "tools" / "record_replay.py"), it["file"],
               "--game-dir", str(self.game_dir)]
        with self.lock:
            if self.paused or self.watching() or not any(i is it for i in self.items):  # stopped, or list cleared
                return None
            self.current = {"stem": it["stem"], "phase": "Starting the game", "t": 0, "speed": 0.0}
            self.proc = subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                         encoding="utf-8", errors="replace",
                                         env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        print(f"[{it['stem']}] recording {it['title']}")
        last = ""
        identity = None
        for line in self.proc.stdout:  # text mode turns the progress line's \r into line breaks
            line = line.strip()
            match = re.fullmatch(r"Game process: (\d+)\|([\d.]+)", line)
            if match:
                identity = (int(match[1]), float(match[2]))
            if line:
                last = line
                self.progress(it, line)
        code = self.proc.wait()
        with self.lock:
            stopped = self.stopping
            self.proc = self.current = None
            self.stopping = False
        if stopped:
            rr.close_game(identity)
            print(f"[{it['stem']}] stopped")
            return None
        if self.is_done(it):
            with self.lock:
                self.done.add(it["stem"])
            print(f"[{it['stem']}] done")
            self.queue_assets(it["stem"])
            return True
        why = "playback stopped before the end of the match" if code == 0 else last
        with self.lock:
            self.failed[it["stem"]] = why
        print(f"[{it['stem']}] failed: {why}")
        return False

    def progress(self, it: dict, line: str) -> None:
        m = re.search(r"(\d+):(\d\d) / \d+:\d\d\s+\(([\d.]+)x\)", line)
        with self.lock:
            cur = self.current
            if m:
                cur.update(phase="Recording", t=int(m.group(1)) * 60 + int(m.group(2)), speed=float(m.group(3)))
                return
            if line.startswith("Loading recorder"):
                cur["phase"] = "Loading the recorder"
            elif line.startswith("Wrote "):
                cur["phase"] = "Saving"
            elif "playback stopped advancing" in line:
                cur["phase"] = "Playback stopped advancing; saving what was recorded"
            elif "ignores background console hotkeys" in line:
                cur["phase"] = "Click into the game window once so the recorder can start"
        print(f"[{it['stem']}] {line}")

    # ---- the 3D models of finished recordings (in the background, so the next recording starts at once)

    def queue_assets(self, stem: str) -> None:
        with self.lock:
            self.assets[stem] = {"state": "queued", "text": "3D models: waiting"}
        self.asset_jobs.put(stem)

    def asset_loop(self) -> None:
        while True:
            stem = self.asset_jobs.get()

            def report(state: str, text: str, stem: str = stem) -> None:
                with self.lock:
                    changed = self.assets.get(stem, {}).get("state") != state
                    self.assets[stem] = {"state": state, "text": text}
                if changed:
                    print(f"[{stem}] {text}")

            build_3d_assets(stem, report, self.toolchain)

    # ---- the viewer's "Watch in game"

    def watching(self) -> bool:
        return self.watch is not None and self.watch["state"] == "running"

    def find_replay(self, name: str, players: list[str]) -> tuple[Path, recfile.Replay] | None:
        """The replay file recording `name` was made from: this app's download, the replays folders or the game's
        playback folder. Checked by its player names, because playback\\temp.rec holds whichever match was last."""
        with self.lock:
            files = [Path(it["file"]) for it in self.items if it["stem"] == name and it.get("file")]
        files += [self.replays_dir / f"{name}.rec", *sorted((ROOT / "replays").rglob(f"{name}.rec")),
                  rr.PLAYBACK_DIR / f"{name}.rec"]
        for f in dict.fromkeys(files):
            try:
                rep = recfile.load(f)
            except Exception:  # missing, empty, or not a replay
                continue
            if sorted(p.name for p in rep.players) == sorted(players):
                return f, rep
        return None

    def reusable_game(self, src: Path) -> dict | None:
        """The game an earlier Watch in game opened, while it still shows src's replay: same process, and its log shows
        no match loaded since (loading a match registers its script modules again)."""
        g = self.watch_game
        if g is None or g["src"] != src or g["pid"] != ai.game_pid():
            return None
        g["log"].poll()
        if any(re.search(r"Registering module|PostInit", line) for line in g["log"].lines[g["seen"]:]):
            return None
        return g

    def replay_time(self, g: dict) -> float | None:
        """Game time of the replay in g, asked through its console, or None when the console doesn't answer or the
        game no longer shows a replay. The console is left open on success; otherwise toggled back to how it was."""
        con = g["console"]
        con.hwnd = ai.game_window() or con.hwnd
        try:
            ai.post_console_toggle(con.hwnd, con.sys_keys)  # the hotkey variant that worked; no click-into-game wait
            con.run('print("R|".."WATCH|NOW|"..tostring(World_IsReplay()).."|"..World_GetGameTime())',
                    timeout=2.5, retries=1)
        except (TimeoutError, rr.ConsoleError, OSError):  # OSError: the window is gone
            try:
                ai.post_console_toggle(con.hwnd, con.sys_keys)
            except OSError:
                pass
            return None
        replay, t = [l for l in con.log.lines if "R|WATCH|NOW|" in l][-1].split("R|WATCH|NOW|", 1)[1].split("|")[:2]
        if replay != "true":
            con.close()
            return None
        return float(t)

    def start_watch(self, name: str, at: float, x: float, z: float, players: list[str], force: bool) -> dict:
        """Open the game on recording `name`'s replay at `at` seconds with the camera on x, z. A game an earlier
        Watch in game opened on the same replay fast-forwards in place; going back in it, or any other open game,
        returns {"confirm": question}; asked again with force, the game is closed and started again."""
        if not re.fullmatch(r"[\w.-]+", name):
            return {"error": "Unknown recording."}
        if self.game_dir is None:
            return {"error": "Age of Empires IV was not found. Pick its folder on the Replay Recorder page."}
        if not steam_status()[1]:
            return {"error": "Steam is not running or not signed in. Start Steam, sign in and try again."}
        found = self.find_replay(name, players)
        if found is None:
            return {"error": f"The replay file of this match ({name}.rec) is gone or now holds another match "
                             "(the game reuses temp.rec for every new match), so the game can't show it."}
        src, rep = found
        if self.build is not None and rep.version != self.build:
            return {"error": f"This match was played on game version {rep.version}; yours is {self.build}, so the game "
                             "can't play it."}
        at = max(0.0, min(at, rep.duration_seconds - 1))
        close_it = {"confirm": f"Age of Empires IV is open. Close it and open this replay at {rr.clock(at)} instead?"}
        with self.lock:
            if self.current:
                return {"error": "Replay Recorder is recording a match in the game right now. Press Stop on its page "
                                 "first, or wait until it is done."}
            if self.watching():
                return {"error": "The game is already being opened. Wait until it is ready."}
            game = None if force else self.reusable_game(src)
            if game is None and ai.game_pid() is not None and not force:
                return close_it
            before = self.watch
            self.watch = {"name": name, "state": "running",
                          "text": "Checking the open game..." if game else "Starting Age of Empires IV..."}
        now = None
        if game is not None:
            now = self.replay_time(game)
            if now is None or at < now - 1:
                if now is not None:
                    game["console"].close()
                with self.lock:
                    self.watch = before
                    if now is None:
                        self.watch_game = None
                if now is None:
                    return close_it
                return {"confirm": f"The game is already at {rr.clock(now)}. A replay can't go back, so it starts "
                                   f"again and fast-forwards to {rr.clock(at)}. Restart it?"}
        print(f"[watch] {name} at {rr.clock(at)}" + (" in the open game" if game else ""))
        threading.Thread(target=self.run_watch, args=(src, at, x, z, game, now), daemon=True).start()
        return {"ok": True}

    def run_watch(self, src: Path, at: float, x: float, z: float, game: dict | None, now: float | None) -> None:
        try:
            with runlock.hold("recording"):
                self._run_watch(src, at, x, z, game, now)
        except runlock.LockError as e:
            self.watch_text(str(e), "error")
            self.wake.set()

    def _run_watch(self, src: Path, at: float, x: float, z: float, game: dict | None, now: float | None) -> None:
        """game/now: the open game to fast-forward in place (its console already open) and its replay time."""
        try:
            if game is not None:
                log, console = game["log"], game["console"]
            else:
                with self.lock:
                    self.watch_game = None
                log, console = self.launch_watch(src)
                now = 0.0
            header = (f"RW_TARGET={at:.3f} RW_X={x:.2f} RW_Z={z:.2f} RW_FAST={WATCH_FAST} "
                      f"RW_NORMAL={rr.SIM_TICKS_PER_SECOND}")
            seen = len(log.lines)  # Console.run also reads the log; scan from here, not just what poll() returns
            console.load(header + WATCH_LUA, "aoe4_watch.lua")
            console.close()
            with self.lock:
                self.watch_game = {"pid": ai.game_pid(), "src": src, "log": log, "console": console, "seen": seen}
            self.watch_text(f"Fast-forwarding in the game: {rr.clock(now)} / {rr.clock(at)}")
            last = time.time()
            while True:
                log.poll()
                lines, seen = log.lines[seen:], len(log.lines)
                for line in lines:
                    m = re.search(r"R\|WATCH\|(T|AT|CAM|ERR)\|(.*)", line)
                    if not m:
                        continue
                    kind, value = m.groups()
                    if kind == "T":
                        last = time.time()
                        self.watch_text(f"Fast-forwarding in the game: {rr.clock(float(value))} / {rr.clock(at)}")
                    elif kind == "CAM":
                        print(f"[watch] could not move the camera: {value}")
                    elif kind == "ERR":
                        raise WatchError(f"The game could not fast-forward ({value}).")
                    else:
                        self.watch_text(f"Ready: the game is at {rr.clock(float(value))}.", "ready")
                        return
                if ai.game_pid() is None:
                    raise WatchError("The game was closed.")
                if time.time() - last > 90:
                    raise WatchError("The replay stopped moving forward in the game. Is it paused there?")
                time.sleep(0.5)
        except WatchError as e:
            self.watch_text(str(e), "error")
        except (TimeoutError, rr.ConsoleError) as e:
            self.watch_text(f"The game did not get ready ({e}).", "error")
        except Exception as e:
            self.watch_text(f"Opening the game failed: {e}", "error")
        finally:
            self.wake.set()

    def launch_watch(self, src: Path) -> tuple[rr.ScarLog, rr.Console]:
        """(Re)start the game on src's replay; returns its log and its open console."""
        if ai.game_pid() is not None:
            self.watch_text("Closing Age of Empires IV...")
            # Watch's explicit restart confirmation attaches to this one process, never all game processes.
            rr.close_game(rr.game_identity(ai.game_pid()))
            self.watch_text("Starting Age of Empires IV...")
        rr.restore_graphics()  # Watch shows the player's own settings, also after a recording that died mid-run
        name = rr.stage_replay(src)
        started = time.time()
        subprocess.Popen([str(rr.STEAM_EXE), "-applaunch", rr.APP_ID, "-dev", "-replay", f"playback:{name}"])
        log = rr.ScarLog.wait_for_session(started, timeout=180)
        self.watch_text("Loading the replay in the game...")
        if not log.wait_for(r"ClassicStart_PostInit|Starting mission|CoreTrainingGoals_OnInit", timeout=240):
            raise WatchError("The replay never started in the game.")
        hwnd = ai.game_window()
        if hwnd is None:
            raise WatchError("The game window was not found.")
        # Console.open polls the ACK protocol; no fixed post-mission delay is needed.
        self.watch_text("Getting the game ready... (if this takes long, click into the game window once)")
        console = rr.Console(log, hwnd)
        console.open(probe_first=False)  # a probe would type into the replay's controls
        return log, console

    def watch_text(self, text: str, state: str = "running") -> None:
        with self.lock:
            self.watch.update(text=text, state=state)
        if state != "running" or not text.startswith("Fast-forwarding"):
            print(f"[watch] {text}")

    # ---- what the page shows

    def row(self, it: dict) -> dict:
        stem = it["stem"]
        row = {"id": it["game_id"], "link": it["link"], "title": it.get("title") or f"Match {it['game_id']}",
               "map": it.get("map", ""), "length": rr.clock(it["seconds"]) if it.get("seconds") else ""}
        if it.get("error"):
            row.update(status="error", detail=it["error"])
        elif not it.get("file"):
            row.update(status="downloading", detail="Downloading")
        elif self.build is not None and it["build"] != self.build:
            row.update(status="error", detail=f"Played on game version {it['build']}; yours is {self.build}, so the "
                                              "game cannot play it")
        elif self.current and self.current["stem"] == stem:
            cur = self.current
            detail = cur["phase"]
            if cur["phase"] == "Recording":
                detail = f"Recording {rr.clock(cur['t'])} / {row['length']} · {cur['speed']:.0f}x"
            row.update(status="recording", detail=detail, progress=min(1.0, cur["t"] / it["seconds"]))
        elif stem in self.done:
            row.update(status="done", detail="Done", view=f"/viewer/index.html#{stem}")
            if viewer3d_ok:
                row["view3d"] = f"{VIEWER3D}#{stem}"
        elif stem in self.failed:
            row.update(status="failed", detail=f"Failed: {self.failed[stem]}")
        else:
            row.update(status="waiting", detail="Waiting")
        if it.get("summary_error"):
            row["detail"] += f" · aoe4world summary not downloaded ({it['summary_error']}; add the link again to retry)"
        if stem in self.assets:
            row["assets"] = self.assets[stem]
        return row

    def snapshot(self) -> dict:
        running, signed_in = steam_status()
        with self.lock:
            waiting = [it for it in self.items if self.is_waiting(it)
                       and not (self.current and self.current["stem"] == it["stem"])]
            left = sum(it["seconds"] / 15 + 35 for it in waiting)  # ~15x playback plus ~35 s launch each
            if self.current:
                cur_it = next(it for it in self.items if it["stem"] == self.current["stem"])
                left += (cur_it["seconds"] - self.current["t"]) / max(self.current["speed"], 10.0)
            return {
                "game": {"dir": str(self.game_dir or self.picked_game or ""), "found": self.game_dir is not None,
                         "picked": self.picked_game is not None, "build": self.build},
                "steam": {"running": running, "signedIn": signed_in},
                "replaysDir": str(self.replays_dir),
                "paused": self.paused,
                "note": self.pause_reason if self.paused else self.note,
                "items": [self.row(it) for it in self.items],
                "counts": {"done": sum(it["stem"] in self.done for it in self.items),
                           "waiting": len(waiting), "recording": int(self.current is not None)},
                "secondsLeft": left,
            }


APP: App


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args) -> None:
        pass

    def send(self, code: int, body: bytes, ctype: str = "text/plain; charset=utf-8") -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, obj: dict) -> None:
        self.send(200, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def from_this_pc(self) -> bool:
        """Only this app's own page: other websites can't reach it by DNS tricks or by posting forms to it."""
        return self.headers.get("Host", "") in (f"127.0.0.1:{PORT}", f"localhost:{PORT}")

    def do_GET(self) -> None:
        if not self.from_this_pc():
            return self.send(403, b"forbidden")
        path = urllib.parse.urlsplit(self.path).path
        if path == "/":
            return self.send(200, PAGE.read_bytes(), TYPES[".html"])
        if path == "/api/state":
            return self.send_json(APP.snapshot())
        if path == "/api/watch":
            with APP.lock:
                watch = dict(APP.watch or {})
            return self.send_json(watch)
        if path.startswith("/viewer/"):
            f = (VIEWER / urllib.parse.unquote(path[len("/viewer/"):])).resolve()
            if f.is_file() and f.is_relative_to(VIEWER.resolve()):
                return self.send(200, f.read_bytes(), TYPES.get(f.suffix, "application/octet-stream"))
        self.send(404, b"not found")

    def do_POST(self) -> None:
        if not self.from_this_pc() or self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            return self.send(403, b"forbidden")
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/add":
            return self.send_json(APP.add(str(body.get("text", ""))))
        if path == "/api/pick":
            return self.send_json(APP.pick(str(body.get("what", ""))))
        if path == "/api/start":
            APP.start()
            return self.send_json({})
        if path == "/api/stop":
            APP.stop()
            return self.send_json({})
        if path == "/api/clear":
            return self.send_json(APP.clear())
        if path == "/api/watch":
            return self.send_json(APP.start_watch(str(body.get("name", "")), float(body.get("t") or 0),
                                                  float(body.get("x") or 0), float(body.get("z") or 0),
                                                  [str(p) for p in body.get("players") or []], bool(body.get("force"))))
        self.send(404, b"not found")


class Server(ThreadingHTTPServer):
    allow_reuse_address = False  # on Windows, reuse would let a second copy share the port instead of failing
    daemon_threads = True


def viewer3d_up() -> bool:
    try:
        with urllib.request.urlopen(VIEWER3D + "shared/units.js", timeout=2) as r:
            return r.status == 200
    except OSError:
        return False


def start_viewer3d() -> subprocess.Popen | None:
    """Starts viewer3d/serve.mjs unless the 3D viewer already answers. It shares this console, so closing the window
    ends it too. Returns the process it started, or None."""
    if viewer3d_up():
        return None
    node = shutil.which("node")
    if node is None:
        print("Node.js (20 or later) was not found, so the 3D viewer is not started; the 2D viewer works without it.")
        return None
    proc = subprocess.Popen([node, str(ROOT / "viewer3d" / "serve.mjs"), str(VIEWER3D_PORT)], cwd=ROOT)
    for _ in range(100):
        if viewer3d_up() or proc.poll() is not None:
            break
        time.sleep(0.1)
    return proc


def main() -> None:
    global APP, viewer3d_ok
    url = f"http://127.0.0.1:{PORT}/"
    try:
        server = Server(("127.0.0.1", PORT), Handler)
    except OSError:  # already running: show that one
        webbrowser.open(url)
        return
    APP = App()
    viewer3d = start_viewer3d()
    viewer3d_ok = viewer3d_up()
    print(f"Replay Recorder: {url}\n3D viewer: " + (VIEWER3D if viewer3d_ok else "not running (see above)")
          + "\nKeep this window open while it records; close it to quit.")
    webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if viewer3d is not None and viewer3d.poll() is None:
            viewer3d.terminate()


if __name__ == "__main__":
    main()
