"""Log your own keyboard and mouse input while Age of Empires IV is the active window (Windows only).

Usage:
    python tools/input_logger.py                 log until Ctrl+C (or --minutes) to recordings/input/<start>.jsonl
    python tools/input_logger.py --summary LOG   what one log holds: control groups, keys, clicks, saved replays

The logger only listens: low-level keyboard and mouse hooks (SetWindowsHookEx WH_KEYBOARD_LL / WH_MOUSE_LL) see each
input on its way to the active window and pass it on unchanged. Nothing is sent to the game, its memory and files are
not touched, and input to any other window is not recorded. What it writes, one JSON array per line:

    ["k", t, vk, down, mods]           key press (1) or release (0); key repeats are left out
    ["m", t, button, down, x, y, mods] mouse button "L" "R" "M" "X1" "X2", screen pixels
    ["w", t, delta, x, y]              mouse wheel
    ["f", t, active]                   the game became the active window (1) or stopped being it (0)
    ["g", t, x, y, w, h]               the game window's client area on screen, whenever it changes
    ["c", t, open]                     the chat gate opened (Enter) or closed (Enter, or Esc while open)
    ["r", t, file]                     the game wrote a new playback/temp.rec, copied next to the log as <file>

t is milliseconds since the log started (the input's own timestamp), mods a bit set: 1 Ctrl, 2 Shift, 4 Alt, 8 Win,
16 injected by software rather than typed (tools/validate_mechanics.py ignores those). The first line is a header
object. Mouse movement is not recorded. Every match played while the logger runs gets its replay saved, so
tools/validate_mechanics.py can pair the two after recording the replay with tools/record_replay.py.

Chat is kept out on a best-effort basis only. The logger cannot see whether the chat box is open, so it assumes every
Enter opens or sends a chat message and drops the keys while its gate is open. An Enter that does neither (confirming a
menu or dialog) puts the gate out of step: hotkeys are dropped until the next Enter, and the chat message that Enter
opens is written in full, as is every later one, until an Esc while the gate is open puts it back in step. Read a
log before sharing it.
"""
from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wt
import json
import shutil
import sys
import threading
import time
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

from aoe4input import GAME_EXE  # noqa: E402

OUT_DIR = ROOT / "recordings" / "input"
FORMAT = 1

CTRL, SHIFT, ALT, WIN, INJECTED = 1, 2, 4, 8, 16
VK_RETURN, VK_ESCAPE = 0x0D, 0x1B
MODIFIER_VKS = {0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5}
DIGITS = {0x30 + d: d for d in range(10)}  # the top-row digit keys: control groups
DOUBLE_TAP_MS = 500  # a second recall of the same group this soon centres the camera on it


# ---------------------------------------------------------------- reading a log (pure; tests and the validator)

@dataclass
class Action:
    """One input decoded from a log. kind: "assign" (Ctrl+digit), "add" (Shift+digit), "recall" (digit), "double"
    (a recall repeating the same group within DOUBLE_TAP_MS), "key" (any other key), "click" (left button; a box when
    pressed and released at different points), "right", "middle". t in ms, positions -1..1 on the game window from
    left to right and bottom to top (None for keys)."""
    t: int
    kind: str
    key: int | None = None  # vk for keys; the group digit for control groups
    x: float | None = None
    y: float | None = None
    x1: float | None = None  # where a left button was released
    y1: float | None = None
    pixel: tuple[int, int] | None = None  # the press in window client pixels
    aspect: float | None = None  # the game window's width / height


def read_log(path: Path) -> tuple[dict, list[list]]:
    with open(path, encoding="utf-8") as f:
        header = json.loads(f.readline())
        return header, [json.loads(line) for line in f if line.strip()]


def actions(events: list[list], double_tap_ms: int = DOUBLE_TAP_MS) -> list[Action]:
    """The game input in a log: typed keys and clicks inside the game window; injected input and releases dropped."""
    out: list[Action] = []
    win = None
    last_recall: Action | None = None
    press: dict[str, tuple[int, int, int]] = {}

    def norm(x: int, y: int) -> tuple[float, float] | None:
        if win is None:
            return None
        left, top, w, h = win
        if not (left <= x < left + w and top <= y < top + h):
            return None
        return 2 * (x - left) / w - 1, 1 - 2 * (y - top) / h

    for e in events:
        kind = e[0]
        if kind == "g":
            win = tuple(e[2:6])
        elif kind == "k":
            _k, t, vk, down, mods = e
            if not down or mods & INJECTED or vk in MODIFIER_VKS:
                continue
            if vk in DIGITS:
                group = DIGITS[vk]
                if mods & CTRL:
                    out.append(Action(t, "assign", group))
                elif mods & SHIFT:
                    out.append(Action(t, "add", group))
                else:
                    double = (last_recall is not None and last_recall.key == group
                              and t - last_recall.t <= double_tap_ms)
                    a = Action(t, "double" if double else "recall", group)
                    out.append(a)
                    last_recall = None if double else a
                    continue
            else:
                out.append(Action(t, "key", vk))
            last_recall = None
        elif kind == "m":
            _m, t, button, down, x, y, mods = e
            if mods & INJECTED:
                continue
            if button == "L":
                if down:
                    press["L"] = (t, x, y)
                elif "L" in press:
                    t0, x0, y0 = press.pop("L")
                    a, b = norm(x0, y0), norm(x, y)
                    if a is not None:
                        b = b or a
                        out.append(Action(t0, "click", None, a[0], a[1], b[0], b[1], (x0 - win[0], y0 - win[1]),
                                          win[2] / win[3]))
            elif down and button in ("R", "M"):
                a = norm(x, y)
                if a is not None:
                    out.append(Action(t, "right" if button == "R" else "middle", None, a[0], a[1],
                                      pixel=(x - win[0], y - win[1]), aspect=win[2] / win[3]))
            last_recall = None
    out.sort(key=lambda a: a.t)  # a click is decoded at its release but dated by its press
    return out


def summary(path: Path) -> str:
    header, events = read_log(path)
    acts = actions(events)
    kinds = Counter(a.kind for a in acts)
    keys = Counter(a.key for a in acts if a.kind == "key")
    groups = Counter((a.kind, a.key) for a in acts if a.kind in ("assign", "add", "recall", "double"))
    span = (events[-1][1] - events[0][1]) / 60000 if events else 0
    lines = [f"{path.name}: started {header.get('started')}, {span:.1f} min of events, game {header.get('process')}"]
    lines.append("  " + ", ".join(f"{k} {n}" for k, n in sorted(kinds.items())))
    if keys:
        lines.append("  keys (vk): " + ", ".join(f"0x{vk:02X} {n}" for vk, n in keys.most_common(15)))
    if groups:
        lines.append("  groups: " + ", ".join(f"{k} {g}: {n}" for (k, g), n in sorted(groups.items())))
    lines.append(f"  chat opened {sum(1 for e in events if e[0] == 'c' and e[2])} times, "
                 f"replays saved: {[e[2] for e in events if e[0] == 'r'] or 'none'}")
    return "\n".join(lines)


# ---------------------------------------------------------------- recording (Windows hooks)

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

WH_KEYBOARD_LL, WH_MOUSE_LL = 13, 14
WM_QUIT = 0x12
WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP = 0x100, 0x101, 0x104, 0x105
MOUSE_MESSAGES = {0x201: ("L", 1), 0x202: ("L", 0), 0x204: ("R", 1), 0x205: ("R", 0), 0x207: ("M", 1),
                  0x208: ("M", 0), 0x20B: ("X", 1), 0x20C: ("X", 0)}
WM_MOUSEWHEEL = 0x20A
LLKHF_INJECTED, LLMHF_INJECTED = 0x10, 0x01
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
LRESULT = ctypes.c_ssize_t
HOOKPROC = ctypes.WINFUNCTYPE(LRESULT, ctypes.c_int, wt.WPARAM, wt.LPARAM)
CTRL_HANDLER = ctypes.WINFUNCTYPE(wt.BOOL, wt.DWORD)


class KBDLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [("vkCode", wt.DWORD), ("scanCode", wt.DWORD), ("flags", wt.DWORD), ("time", wt.DWORD),
                ("dwExtraInfo", ctypes.c_size_t)]


class MSLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [("pt", wt.POINT), ("mouseData", wt.DWORD), ("flags", wt.DWORD), ("time", wt.DWORD),
                ("dwExtraInfo", ctypes.c_size_t)]


user32.SetWindowsHookExW.argtypes = (ctypes.c_int, HOOKPROC, wt.HINSTANCE, wt.DWORD)
user32.SetWindowsHookExW.restype = wt.HHOOK
user32.CallNextHookEx.argtypes = (wt.HHOOK, ctypes.c_int, wt.WPARAM, wt.LPARAM)
user32.CallNextHookEx.restype = LRESULT
user32.UnhookWindowsHookEx.argtypes = (wt.HHOOK,)
user32.GetMessageW.argtypes = (ctypes.POINTER(wt.MSG), wt.HWND, wt.UINT, wt.UINT)
user32.PostThreadMessageW.argtypes = (wt.DWORD, wt.UINT, wt.WPARAM, wt.LPARAM)
user32.GetForegroundWindow.restype = wt.HWND
user32.GetWindowThreadProcessId.argtypes = (wt.HWND, ctypes.POINTER(wt.DWORD))
user32.GetClientRect.argtypes = (wt.HWND, ctypes.POINTER(wt.RECT))
user32.ClientToScreen.argtypes = (wt.HWND, ctypes.POINTER(wt.POINT))
user32.GetAsyncKeyState.argtypes = (ctypes.c_int,)
user32.GetAsyncKeyState.restype = ctypes.c_short
kernel32.GetModuleHandleW.argtypes = (wt.LPCWSTR,)
kernel32.GetModuleHandleW.restype = wt.HMODULE
kernel32.OpenProcess.argtypes = (wt.DWORD, wt.BOOL, wt.DWORD)
kernel32.OpenProcess.restype = wt.HANDLE
kernel32.GetTickCount.restype = wt.DWORD
kernel32.QueryFullProcessImageNameW.argtypes = (wt.HANDLE, wt.DWORD, wt.LPWSTR, ctypes.POINTER(wt.DWORD))
kernel32.CloseHandle.argtypes = (wt.HANDLE,)
kernel32.SetConsoleCtrlHandler.argtypes = (CTRL_HANDLER, wt.BOOL)


def process_name(hwnd: int) -> str:
    pid = wt.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
    if not handle:
        return ""
    try:
        buf, size = ctypes.create_unicode_buffer(1024), wt.DWORD(1024)
        if not kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return ""
        return Path(buf.value).name
    finally:
        kernel32.CloseHandle(handle)


def client_rect(hwnd: int) -> tuple[int, int, int, int] | None:
    r, p = wt.RECT(), wt.POINT(0, 0)
    if not user32.GetClientRect(hwnd, ctypes.byref(r)) or not user32.ClientToScreen(hwnd, ctypes.byref(p)):
        return None
    return p.x, p.y, r.right - r.left, r.bottom - r.top


def modifiers() -> int:
    held = lambda vk: user32.GetAsyncKeyState(vk) & 0x8000  # noqa: E731
    return ((CTRL if held(0x11) else 0) | (SHIFT if held(0x10) else 0) | (ALT if held(0x12) else 0)
            | (WIN if held(0x5B) or held(0x5C) else 0))


class Recorder:
    """Writes the game's input to one log. The hook callbacks only check the active window and queue a line; a
    second thread writes the queue, follows the game window's position and saves new replays."""

    def __init__(self, path: Path, process: str, playback: Path | None):
        self.path, self.process, self.playback = path, process.lower(), playback
        self.tick0 = kernel32.GetTickCount()
        self.lock = threading.Lock()
        self.queue: list[list] = []
        self.counts: Counter[str] = Counter()
        self.held: set[int] = set()
        self.chat = False
        self.last: tuple[int, bool] = (0, False)  # the last active window and whether it is the game's
        self.active = False
        self.rect = None
        self.stop = threading.Event()

    def t(self, stamp: int | None = None) -> int:
        return ((kernel32.GetTickCount() if stamp is None else stamp) - self.tick0) & 0xFFFFFFFF

    def put(self, line: list) -> None:
        with self.lock:
            self.queue.append(line)
            self.counts[line[0]] += 1

    def game_window(self) -> int | None:
        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return None
        if hwnd != self.last[0]:
            self.last = (hwnd, process_name(hwnd).lower() == self.process)
        return hwnd if self.last[1] else None

    def on_key(self, msg: int, k: KBDLLHOOKSTRUCT) -> None:
        down = msg in (WM_KEYDOWN, WM_SYSKEYDOWN)
        vk = k.vkCode
        if down and vk in self.held:
            return  # auto-repeat
        (self.held.add if down else self.held.discard)(vk)
        if self.game_window() is None:
            return
        mods = modifiers() | (INJECTED if k.flags & LLKHF_INJECTED else 0)
        t = self.t(k.time)
        if vk == VK_RETURN or (vk == VK_ESCAPE and self.chat):
            if down:
                self.chat = vk == VK_RETURN and not self.chat
                self.put(["c", t, int(self.chat)])
            return
        if not self.chat:
            self.put(["k", t, vk, int(down), mods])

    def on_mouse(self, msg: int, m: MSLLHOOKSTRUCT) -> None:
        if self.game_window() is None:
            return
        t, inj = self.t(m.time), INJECTED if m.flags & LLMHF_INJECTED else 0
        if msg in MOUSE_MESSAGES:
            button, down = MOUSE_MESSAGES[msg]
            if button == "X":
                button = "X1" if (m.mouseData >> 16) == 1 else "X2"
            self.put(["m", t, button, down, m.pt.x, m.pt.y, modifiers() | inj])
        elif msg == WM_MOUSEWHEEL:
            self.put(["w", t, ctypes.c_short(m.mouseData >> 16).value, m.pt.x, m.pt.y])

    def watch(self, out) -> None:
        """Every 0.25 s: the game window's state; every second: write the queue; every 5 s: a new temp.rec."""
        seen = self._replay_state()
        pending = None
        n = 0
        while not self.stop.wait(0.25):
            hwnd = self.game_window()
            if (hwnd is not None) != self.active:
                self.active = hwnd is not None
                self.put(["f", self.t(), int(self.active)])
            if hwnd is not None and (rect := client_rect(hwnd)) and rect != self.rect:
                self.rect = rect
                self.put(["g", self.t(), *rect])
            n += 1
            if n % 20 == 0 and self.playback is not None:
                seen, pending = self.poll_replay(seen, pending)
            if n % 4 == 0:
                self.flush(out)
        self.flush(out)

    def poll_replay(self, seen, pending):
        """One replay check: temp.rec is copied once it differs from the last copy and has not changed since the
        previous check, so the game has finished writing it. Returns the new (seen, pending) states. The chat gate is
        left alone: a chat open across the end of a match stays unlogged."""
        state = self._replay_state()
        if state is None or state == seen:
            return seen, pending
        if state != pending:
            return seen, state
        name = f"{self.path.stem}_{datetime.now():%H%M%S}.rec"
        shutil.copyfile(self.playback, self.path.with_name(name))
        self.put(["r", self.t(), name])
        return state, None

    def _replay_state(self):
        try:
            st = self.playback.stat()
            return st.st_mtime_ns, st.st_size
        except (OSError, AttributeError):
            return None

    def flush(self, out) -> None:
        with self.lock:
            lines, self.queue = self.queue, []
        if lines:
            out.write("".join(json.dumps(line, separators=(",", ":")) + "\n" for line in lines))
            out.flush()


def record(out_dir: Path, process: str, minutes: float | None, save_replays: bool) -> Path:
    from record_replay import PLAYBACK_DIR

    user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))  # per-monitor v2: the screen pixels the game sees
    out_dir.mkdir(parents=True, exist_ok=True)
    started = datetime.now()
    path = out_dir / f"{started:%Y-%m-%d_%H%M%S}.jsonl"
    rec = Recorder(path, process, PLAYBACK_DIR / "temp.rec" if save_replays else None)

    def keyboard(code, wparam, lparam):
        if code == 0:
            try:
                rec.on_key(wparam, ctypes.cast(lparam, ctypes.POINTER(KBDLLHOOKSTRUCT)).contents)
            except Exception as e:  # never let a logging bug hold up the input
                print(f"keyboard hook: {e!r}", file=sys.stderr)
        return user32.CallNextHookEx(None, code, wparam, lparam)

    def mouse(code, wparam, lparam):
        if code == 0:
            try:
                rec.on_mouse(wparam, ctypes.cast(lparam, ctypes.POINTER(MSLLHOOKSTRUCT)).contents)
            except Exception as e:
                print(f"mouse hook: {e!r}", file=sys.stderr)
        return user32.CallNextHookEx(None, code, wparam, lparam)

    procs = HOOKPROC(keyboard), HOOKPROC(mouse)  # kept referenced while the hooks are installed
    module = kernel32.GetModuleHandleW(None)
    hooks = [user32.SetWindowsHookExW(WH_KEYBOARD_LL, procs[0], module, 0),
             user32.SetWindowsHookExW(WH_MOUSE_LL, procs[1], module, 0)]
    if not all(hooks):
        raise OSError(ctypes.get_last_error(), "SetWindowsHookExW failed")
    main_thread = kernel32.GetCurrentThreadId()
    quit_now = lambda: user32.PostThreadMessageW(main_thread, WM_QUIT, 0, 0)  # noqa: E731
    on_ctrl = CTRL_HANDLER(lambda _event: bool(quit_now()) or True)
    kernel32.SetConsoleCtrlHandler(on_ctrl, True)
    timer = threading.Timer(minutes * 60, quit_now) if minutes else None
    if timer:
        timer.start()

    with open(path, "w", encoding="utf-8") as out:
        out.write(json.dumps({"input_log": FORMAT, "started": started.isoformat(timespec="seconds"),
                              "epoch": time.time(), "process": process,
                              "replays": str(PLAYBACK_DIR) if save_replays else None}) + "\n")
        out.flush()
        watcher = threading.Thread(target=rec.watch, args=(out,), daemon=True)
        watcher.start()
        print(f"Logging input to {process} while it is the active window -> {path}\nCtrl+C stops.", flush=True)
        try:
            msg = wt.MSG()
            while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
                pass
        finally:
            for h in hooks:
                user32.UnhookWindowsHookEx(h)
            if timer:
                timer.cancel()
            rec.stop.set()
            watcher.join()
    kernel32.SetConsoleCtrlHandler(on_ctrl, False)
    print(f"Stopped. {dict(rec.counts)} lines written to {path}")
    return path


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--summary", type=Path, metavar="LOG", help="print what a log holds instead of recording")
    ap.add_argument("--out", type=Path, default=OUT_DIR, help=f"log folder (default {OUT_DIR})")
    ap.add_argument("--process", default=GAME_EXE, help=f"game executable (default {GAME_EXE})")
    ap.add_argument("--minutes", type=float, help="stop after this long")
    ap.add_argument("--no-replays", action="store_true", help="do not copy the game's new temp.rec files")
    args = ap.parse_args()
    if args.summary:
        print(summary(args.summary))
    else:
        record(args.out, args.process, args.minutes, not args.no_replays)


if __name__ == "__main__":
    main()
