"""Record full unit state from an AoE4 replay by driving the game's -dev SCAR console.

Usage:
    python tools/record_replay.py [path/to/replay.rec] [--speed N] [--keep-open]
    python tools/record_replay.py <folder or several .rec files> [--speed N]

A folder (searched recursively) or several files record every replay that has no complete recording yet, one after
another, closing the game in between. Replays from another game build are skipped, a failed replay is retried on the
next run, and three failures in a row stop the run. Running the same command again continues where it stopped.

Steps: copy the replay into the game's playback folder, launch it through Steam with
`-dev -replay playback:<name>`, open the SCAR console, load recorder/recorder.lua (one loadfile line;
typed in acknowledged + checksummed chunks if the game refuses file access), lift the sim rate, then
wait for playback to reach the end, extract every "R|" record into recordings/<name>.rlog and convert it
to viewer/data/<name>.js. The replay defaults to the game's playback/temp.rec (your last match).

Speed: the game advances at most one sim tick (1/8 s) per rendered frame, so playback runs at FPS / 8 whenever the
requested rate is higher. The default asks for more than any frame rate delivers, i.e. as fast as the game renders.
Recordings at 8x, 16x and uncapped give the same unit positions.

All console input is posted to the game window in the background; the script never
focuses the game. Launching the game brings it up once; switch away whenever you like.
"""
from __future__ import annotations

import argparse
import ctypes
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
import winreg
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import aoe4input as ai  # noqa: E402
import convert  # noqa: E402
import recfile  # noqa: E402
import runlock  # noqa: E402

APP_ID = "1466860"


def steam_exe() -> Path | None:
    """steam.exe as registered by the Steam installer."""
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as key:
            return Path(winreg.QueryValueEx(key, "SteamExe")[0])
    except OSError:
        return None


STEAM_EXE = steam_exe()


def find_game_dir() -> Path | None:
    """The game's install folder, from Steam's library list and the game's app manifest."""
    if STEAM_EXE is None:
        return None
    libraries = [STEAM_EXE.parent]
    vdf = STEAM_EXE.parent / "steamapps" / "libraryfolders.vdf"
    if vdf.exists():
        text = vdf.read_text(encoding="utf-8", errors="replace")
        libraries += [Path(p.replace("\\\\", "\\")) for p in re.findall(r'"path"\s+"([^"]+)"', text)]
    for lib in libraries:
        acf = lib / "steamapps" / f"appmanifest_{APP_ID}.acf"
        if not acf.exists():
            continue
        m = re.search(r'"installdir"\s+"([^"]+)"', acf.read_text(encoding="utf-8", errors="replace"))
        if m and (lib / "steamapps" / "common" / m.group(1) / ai.GAME_EXE).exists():
            return lib / "steamapps" / "common" / m.group(1)
    return None


RECORDER = ROOT / "recorder" / "recorder.lua"
CHUNK = 350
SIM_TICKS_PER_SECOND = 8
# Complete recordings can finish 1.0 s before the replay duration; allow one extra simulation tick of headroom.
END_SAMPLE_TOLERANCE = 1.125


def reached_end(last_t: float, duration: float) -> bool:
    """Whether the final sample is within the observed replay-end sampling tolerance."""
    return last_t >= duration - END_SAMPLE_TOLERANCE


def documents_dir() -> Path:
    folder_id = uuid.UUID("{FDD39AD0-238F-46AF-ADB4-6C85480369C7}")  # FOLDERID_Documents

    class GUID(ctypes.Structure):
        _fields_ = [("d1", ctypes.c_uint32), ("d2", ctypes.c_uint16), ("d3", ctypes.c_uint16), ("d4", ctypes.c_ubyte * 8)]

    guid = GUID(folder_id.fields[0], folder_id.fields[1], folder_id.fields[2],
                (ctypes.c_ubyte * 8)(*folder_id.bytes[8:]))
    out = ctypes.c_wchar_p()
    hr = ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(out))
    if hr != 0:
        raise OSError(hr, "SHGetKnownFolderPath failed")
    path = Path(out.value)
    ctypes.windll.ole32.CoTaskMemFree(out)
    return path


USER_DIR = documents_dir() / "My Games" / "Age of Empires IV"
PLAYBACK_DIR = USER_DIR / "playback"
LOG_DIR = USER_DIR / "LogFiles"


def minify(src: str) -> str:
    """Join the recorder into one console line. Strips "--" comments outside strings."""
    out_lines = []
    for raw in src.splitlines():
        line, in_str = [], None
        i = 0
        while i < len(raw):
            ch = raw[i]
            if in_str:
                line.append(ch)
                if ch == "\\":
                    line.append(raw[i + 1])
                    i += 1
                elif ch == in_str:
                    in_str = None
            elif ch in "\"'":
                in_str = ch
                line.append(ch)
            elif raw.startswith("--", i):
                break
            else:
                line.append(ch)
            i += 1
        stripped = "".join(line).strip()
        if stripped:
            out_lines.append(stripped)
    code = " ".join(out_lines)
    for bad in ("~", "]==]", "]===]"):
        if bad in code:
            raise ValueError(f"recorder contains {bad!r}, which breaks console injection")
    return code


def lua_hash(s: str) -> int:
    h = 0
    for b in s.encode("utf-8"):
        h = (h * 31 + b) % 2147483647
    return h


class ScarLog:
    """Tails the scarlog of the newest game session."""

    def __init__(self, path: Path):
        self.path = path
        self.offset = 0
        self.lines: list[str] = []

    @classmethod
    def wait_for_session(cls, after: float, timeout: float) -> "ScarLog":
        deadline = time.time() + timeout
        while time.time() < deadline:
            for d in sorted(LOG_DIR.glob("AoE4_*"), key=lambda p: p.stat().st_mtime, reverse=True):
                if d.stat().st_ctime >= after - 5:
                    logs = list(d.glob("scarlog.*.txt"))
                    if logs:
                        return cls(logs[0])
            time.sleep(1)
        raise TimeoutError("game session log folder never appeared")

    def poll(self) -> list[str]:
        with open(self.path, "rb") as f:
            f.seek(self.offset)
            data = f.read()
        cut = data.rfind(b"\n")
        if cut < 0:
            return []
        self.offset += cut + 1
        new = data[: cut + 1].decode("utf-8", errors="replace").splitlines()
        self.lines.extend(new)
        return new

    def wait_for(self, pattern: str, timeout: float) -> str | None:
        rx = re.compile(pattern)
        deadline = time.time() + timeout
        while time.time() < deadline:
            for line in self.poll():
                if rx.search(line):
                    return line
            time.sleep(0.15)
        return None


class ConsoleError(RuntimeError):
    pass


class Console:
    """SCAR console driven purely by posted window messages."""

    def __init__(self, log: ScarLog, hwnd: int):
        self.log = log
        self.hwnd = hwnd
        self.seq = 0
        self.sys_keys = True

    def _send_line(self, line: str) -> None:
        ai.post_key(self.hwnd, ai.VK_BACK, ai.SC_BACK, count=40)
        ai.post_text(self.hwnd, line)
        ai.post_key(self.hwnd, ai.VK_RETURN, ai.SC_RETURN)

    def run(self, code: str, timeout: float = 5.0, retries: int = 2) -> None:
        """Execute one line of Lua. Errors are caught in-game (an uncaught console error kills the game)."""
        if "]===]" in code or "~" in code:
            raise ValueError("line contains ']===]' or '~'")
        self.seq += 1
        n = self.seq
        line = (f'local f,e=load([===[{code}]===],"c") if f then f,e=pcall(f) end '
                f'print(f and "R|".."ACK|{n}" or "R|".."NAK|{n}|"..tostring(e))')
        rx = re.compile(rf"R\|(ACK|NAK)\|{n}(\||$)")
        for _ in range(retries):
            self._send_line(line)
            hit = self.log.wait_for(rx.pattern, timeout)
            if hit and "R|NAK|" in hit:
                raise ConsoleError(hit.split(f"R|NAK|{n}|", 1)[1])
            if hit:
                return
        raise TimeoutError(f"console did not answer line {n}")

    def ping(self) -> bool:
        try:
            self.run("", timeout=2.5, retries=1)
            return True
        except TimeoutError:
            return False

    def open(self, probe_first: bool = True) -> None:
        """probe_first=False skips the initial ping: in a live match a closed console would receive the test line
        as game hotkeys."""
        if probe_first and self.ping():
            return
        for sys_keys in (True, False):
            ai.post_console_toggle(self.hwnd, sys_keys)
            if self.ping():
                self.sys_keys = sys_keys
                return
        print("  The game ignores background console hotkeys. Click into the game window once;\n"
              "  the console opens automatically and you can switch away again right after.")
        deadline = time.time() + 600
        while time.time() < deadline:
            if ai.send_console_toggle_if_foreground(self.hwnd):
                if self.ping():
                    return
                time.sleep(1.5)
            time.sleep(0.25)
        raise TimeoutError("could not open the SCAR console")

    def close(self) -> None:
        """Toggle with the hotkey variant that opened it; no ping afterwards for the same hotkey reason."""
        ai.post_console_toggle(self.hwnd, self.sys_keys)

    def set_sim_rate(self, rate: float) -> None:
        self.run(f"local f=Game_SetSimRate or Misc_SetSimRate f({rate})")

    def inject(self, code: str) -> None:
        chunks, i = [], 0
        while i < len(code):
            j = min(i + CHUNK, len(code))
            while j < len(code) and code[j - 1] in "]=":
                j -= 1
            chunks.append(code[i:j])
            i = j
        self.run("_RC={}")
        for k, chunk in enumerate(chunks, 1):
            self.run(f"_RC[{k}]=[==[{chunk}]==]")
        self.run('local s=table.concat(_RC) local h=0 for i=1,#s do h=(h*31+s:byte(i))%2147483647 end '
                 'print("R|".."SUM|"..#s.."|"..h)')
        sums = [l for l in self.log.lines if "R|SUM|" in l]
        length, h = sums[-1].split("R|SUM|", 1)[1].split("|")[:2]
        if int(length) != len(code.encode("utf-8")) or int(h) != lua_hash(code):
            raise ConsoleError(f"chunk corruption: game has {length} bytes/{h}, "
                               f"expected {len(code)}/{lua_hash(code)}")
        self.run('local f,e=load(table.concat(_RC),"recorder") _RC=nil if not f then error(e) end f()')

    def load(self, src: str, name: str) -> None:
        """Run Lua source: write it to %TEMP%/<name> and loadfile it in one console line. Typing it in chunks is
        the fallback when compiling through loadfile fails (no file access); errors while running it are raised."""
        path = Path(os.environ["TEMP"]) / name
        path.write_text(src, encoding="utf-8")
        try:
            self.run(f'local f,e=loadfile("{path.as_posix()}") if not f then error(e) end _RF=f', timeout=8)
        except (ConsoleError, ValueError) as e:
            print(f"  loadfile unavailable ({e}); typing the code in chunks instead")
            self.inject(minify(src))
            return
        self.run("local f=_RF _RF=nil f()", timeout=8)


def stage_replay(src: Path) -> str:
    PLAYBACK_DIR.mkdir(parents=True, exist_ok=True)
    if src.resolve().parent == PLAYBACK_DIR.resolve():
        return src.name
    dst = PLAYBACK_DIR / src.name
    shutil.copyfile(src, dst)
    return dst.name


def installed_build(game_dir: Path) -> int | None:
    out = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         f"(Get-Item '{game_dir / ai.GAME_EXE}').VersionInfo.FileBuildPart"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return int(out) if out else None


def clock(t: float) -> str:
    return f"{int(t // 60)}:{int(t % 60):02d}"


def hours(s: float) -> str:
    return f"{s / 3600:.1f} h" if s >= 3600 else f"{s / 60:.0f} min"


def log_clock(line: str) -> float | None:
    """Seconds since midnight from a scarlog line's "HH:MM:SS.mmm" stamp: when the game wrote it. Python reads the log
    in bursts, so its own read time can lag the stamp by tens of game-seconds."""
    m = re.match(r"(\d\d):(\d\d):(\d\d\.\d+)", line)
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else None


class RecordError(RuntimeError):
    pass


def close_game() -> None:
    subprocess.run(["taskkill", "/F", "/IM", ai.GAME_EXE], capture_output=True)
    # the process can outlive taskkill by several seconds; a back-to-back run would then refuse to start
    deadline = time.time() + 60
    while ai.game_pid() is not None and time.time() < deadline:
        time.sleep(1)


def is_complete(rlog: Path, duration: float) -> bool:
    """Whether a recording reached the replay's end: its last T record, read from the file's tail."""
    if not rlog.exists():
        return False
    with open(rlog, "rb") as f:
        f.seek(0, os.SEEK_END)
        f.seek(max(0, f.tell() - 262144))
        tail = f.read().decode("utf-8", errors="replace")
    times = re.findall(r"(?m)^T\|([\d.]+)", tail)
    return bool(times) and reached_end(float(times[-1]), duration)


def record(src: Path, rec: recfile.Replay, speed: float, keep_open: bool) -> tuple[Path, bool]:
    """Play one replay in the game and write recordings/<name>.rlog. Returns the .rlog and whether playback reached
    the end (False: it stopped advancing, the recording is cut short). Unless keep_open, the game is closed
    afterwards, also when recording fails."""
    duration = rec.duration_seconds
    print(f"Replay: {src.name}  build {rec.version}  {clock(duration)}  "
          + ", ".join(f"{p.name} ({p.civ})" for p in rec.players))

    if ai.game_pid() is not None:
        raise RecordError("Age of Empires IV is already running; close it first")
    if STEAM_EXE is None:
        raise RecordError("Steam is not installed (no SteamExe in the registry)")
    name = stage_replay(src)
    started = time.time()
    subprocess.Popen([str(STEAM_EXE), "-applaunch", APP_ID, "-dev", "-replay", f"playback:{name}"])
    print("Launching game (it will pop up once; feel free to switch away)...")
    try:
        log = ScarLog.wait_for_session(started, timeout=180)
        if not log.wait_for(r"ClassicStart_PostInit|Starting mission|CoreTrainingGoals_OnInit", timeout=240):
            raise RecordError("replay never reached the match")
        hwnd = ai.game_window()
        if hwnd is None:
            raise RecordError("game window not found")
        time.sleep(2)

        console = Console(log, hwnd)
        console.open(probe_first=False)  # fresh launch: the console is closed, and a probe would type into the replay UI
        try:
            console.set_sim_rate(1)
        except ConsoleError as e:
            print(f"  could not slow the sim during injection: {e}")
        print("Loading recorder...")
        console.load(RECORDER.read_text(encoding="utf-8"), "aoe4_recorder_run.lua")
        status = [l for l in log.lines if re.search(r"R\|(READY|ALREADY|ERR\|install)", l)]
        if not status or "R|READY|" not in status[-1]:
            raise RecordError(f"recorder failed to start: {status[-1] if status else 'no status line'}")
        rate = SIM_TICKS_PER_SECOND * speed
        console.set_sim_rate(rate)
        print(f"Recording at sim rate {rate:g} ({speed:g}x requested)...")

        last_t, last_progress = 0.0, time.time()
        rate_t0 = rate_w0 = last_w = None  # game time and scarlog stamp of the first and latest T records
        while True:
            for line in log.poll():
                m = re.search(r"R\|T\|([\d.]+)", line)
                if m:
                    last_t, last_w = float(m.group(1)), log_clock(line)
                    last_progress = time.time()
                    if rate_t0 is None:
                        rate_t0, rate_w0 = last_t, last_w
                elif "R|ERR|" in line:
                    print("\n  recorder error:", line.split("R|ERR|", 1)[1][:200])
            if reached_end(last_t, duration):
                break
            if time.time() - last_progress > 90:
                print("\n  playback stopped advancing; finishing early")
                break
            span = (last_w - rate_w0) % 86400 if rate_w0 is not None and last_w is not None else 0  # wraps at midnight
            rate_x = (last_t - rate_t0) / span if span else 0
            print(f"\r  {clock(last_t)} / {clock(duration)}  ({rate_x:.1f}x)   ", end="", flush=True)
            time.sleep(2)
        print()

        out_dir = ROOT / "recordings"
        out_dir.mkdir(exist_ok=True)
        out = out_dir / (src.stem + ".rlog")
        skip = ("ACK", "NAK", "SUM")
        records = [l.split("R|", 1)[1] for l in log.lines if "R|" in l]
        records = [r for r in records if r.split("|", 1)[0] not in skip]
        out.write_text("\n".join(records) + "\n", encoding="utf-8")
        print(f"Wrote {len(records)} records to {out}")
    finally:
        if not keep_open:
            close_game()
    return out, reached_end(last_t, duration)


def record_many(paths: list[Path], speed: float, game_dir: Path) -> None:
    """Record every replay under paths (folders searched recursively) without a complete recording, one at a time."""
    files = sorted({f.resolve() for p in paths for f in (p.rglob("*.rec") if p.is_dir() else [p])})
    build = installed_build(game_dir)
    todo: list[Path] = []
    done = other_build = 0
    skipped: list[str] = []
    names: dict[str, Path] = {}
    for f in files:
        if f.stem in names:  # the recording is named after the file, so the second one would overwrite the first
            skipped.append(f"{f}: same name as {names[f.stem]}")
            continue
        names[f.stem] = f
        try:
            rec = recfile.load(f)
        except Exception as e:  # not a replay, truncated download, ...
            skipped.append(f"{f}: {e}")
            continue
        if build is not None and rec.version != build:
            other_build += 1
            continue
        rlog = ROOT / "recordings" / (f.stem + ".rlog")
        if is_complete(rlog, rec.duration_seconds):
            if not (convert.DATA_DIR / (f.stem + ".js")).exists():
                convert.convert(rlog, f)
            done += 1
            continue
        todo.append(f)
    print(f"{len(files)} replays: {done} already recorded, {other_build} from another game build "
          f"(installed: {build}), {len(skipped)} unreadable, {len(todo)} to record")
    for s in skipped:
        print("  skipped", s)
    if not todo:
        return
    if ai.game_pid() is not None:
        raise SystemExit("Age of Empires IV is already running; close it first")

    recorded, failed = 0, []
    in_a_row = 0
    t0 = time.time()
    try:
        for n, f in enumerate(todo, 1):
            print(f"\n[{n}/{len(todo)}] ", end="")
            try:
                rlog, complete = record(f, recfile.load(f), speed, keep_open=False)
                if complete:
                    convert.convert(rlog, f)
                else:
                    print("  recording is incomplete; this replay is retried on the next run")
            except Exception as e:  # one replay failing must not end the run; the game is already closed
                print(f"\n  failed: {e}")
                complete = False
            if complete:
                recorded += 1
                in_a_row = 0
            else:
                failed.append(f.name)
                in_a_row += 1
                if in_a_row == 3:
                    print("\nThree replays in a row failed; stopping. "
                          "Check that Steam is running and logged in and that the game is not updating.")
                    break
            left = len(todo) - n
            if left:
                print(f"  {left} left, about {hours((time.time() - t0) / n * left)} to go")
    except KeyboardInterrupt:
        print("\nStopped. Run the same command again to continue where it left off.")
        raise SystemExit(130) from None
    total = time.time() - t0
    print(f"\nRecorded {recorded} of {len(todo)} in {hours(total)} ({clock(total / n)} per replay)")
    if failed:
        print(f"Not finished ({len(failed)}); they are retried on the next run: " + ", ".join(failed))
    if recorded:
        print("Open viewer/index.html in a browser and pick a recording.")
    if failed:
        raise SystemExit(1)


def main() -> None:
    with runlock.hold("recording"):  # other tools that use the game or many cores can wait for this marker
        record_main()


def record_main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("replays", nargs="*", type=Path,
                    help="a replay file (default: the game's playback/temp.rec), or folders / several files to record "
                         "every replay in them that has no complete recording yet")
    ap.add_argument("--speed", type=float, default=125.0,
                    help="requested playback speed (sim rate = 8 x speed); the default is effectively uncapped")
    ap.add_argument("--keep-open", action="store_true", help="leave the game running afterwards (single replay)")
    ap.add_argument("--game-dir", type=Path, help="the game's install folder (default: found through Steam)")
    args = ap.parse_args()

    game_dir = args.game_dir or find_game_dir()
    if game_dir is None or not (game_dir / ai.GAME_EXE).exists():
        raise SystemExit(f"{ai.GAME_EXE} not found " + (f"in {game_dir}" if game_dir else "in Steam's game folders")
                         + "; pass the game's folder with --game-dir")
    paths = args.replays or [PLAYBACK_DIR / "temp.rec"]
    if len(paths) > 1 or paths[0].is_dir():
        if args.keep_open:
            ap.error("--keep-open works with a single replay only")
        record_many(paths, args.speed, game_dir)
        return

    src = paths[0]
    rec = recfile.load(src)
    build = installed_build(game_dir)
    if build is not None and build != rec.version:
        raise SystemExit(f"replay was recorded on build {rec.version}, installed game is build {build}; it will not play")
    try:
        rlog, complete = record(src, rec, args.speed, args.keep_open)
    except RecordError as e:
        raise SystemExit(str(e)) from None
    if not complete:
        raise SystemExit(f"Recording is incomplete (stopped before the replay's end); kept {rlog} but not converted")
    data = convert.convert(rlog, src)
    print(f"Open viewer/index.html#{data.stem} in a browser.")


if __name__ == "__main__":
    main()
