"""Background keyboard input for the AoE4 SCAR console (Windows only).

Text and Enter are posted straight to the game window's message queue
(WM_CHAR / WM_KEYDOWN), so the game never needs to be in the foreground and
the user's focus is never changed.

The console toggle (Alt+Shift+`) is a hotkey chord. It is posted the same way,
with Alt/Shift injected into the game thread's key state. If the game ignores
posted chords, the only fallback is a real SendInput chord, sent ONLY while the
user already has the game in the foreground; this module never activates,
restores or focuses the game window itself.
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import subprocess
import time

GAME_EXE = "RelicCardinal.exe"

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

WM_KEYDOWN, WM_KEYUP, WM_CHAR = 0x100, 0x101, 0x102
WM_SYSKEYDOWN, WM_SYSKEYUP = 0x104, 0x105
VK_BACK, VK_RETURN, VK_SHIFT, VK_MENU = 0x08, 0x0D, 0x10, 0x12
VK_LSHIFT, VK_LMENU, VK_OEM_3 = 0xA0, 0xA4, 0xC0
SC_BACK, SC_RETURN, SC_LSHIFT, SC_LALT, SC_GRAVE = 0x0E, 0x1C, 0x2A, 0x38, 0x29

INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x2
KEYEVENTF_SCANCODE = 0x8


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wt.WORD), ("wScan", wt.WORD), ("dwFlags", wt.DWORD), ("time", wt.DWORD),
                ("dwExtraInfo", ctypes.c_size_t)]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wt.LONG), ("dy", wt.LONG), ("mouseData", wt.DWORD), ("dwFlags", wt.DWORD),
                ("time", wt.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wt.DWORD), ("u", _INPUTUNION)]


user32.SendInput.argtypes = (wt.UINT, ctypes.POINTER(INPUT), ctypes.c_int)
user32.SendInput.restype = wt.UINT
user32.GetForegroundWindow.restype = wt.HWND
user32.GetWindowThreadProcessId.argtypes = (wt.HWND, ctypes.POINTER(wt.DWORD))
user32.GetWindowThreadProcessId.restype = wt.DWORD
user32.IsWindowVisible.argtypes = (wt.HWND,)
user32.GetWindowTextLengthW.argtypes = (wt.HWND,)
user32.PostMessageW.argtypes = (wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM)
user32.PostMessageW.restype = wt.BOOL
user32.AttachThreadInput.argtypes = (wt.DWORD, wt.DWORD, wt.BOOL)
user32.GetKeyboardState.argtypes = (ctypes.POINTER(ctypes.c_ubyte),)
user32.SetKeyboardState.argtypes = (ctypes.POINTER(ctypes.c_ubyte),)

_EnumProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)


def game_pid() -> int | None:
    out = subprocess.run(
        ["tasklist", "/FI", f"IMAGENAME eq {GAME_EXE}", "/FO", "CSV", "/NH"],
        capture_output=True, text=True, check=False,
    ).stdout
    for line in out.splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if parts and parts[0].lower() == GAME_EXE.lower():
            return int(parts[1])
    return None


def game_window() -> int | None:
    pid = game_pid()
    if pid is None:
        return None
    found: list[int] = []

    def cb(hwnd, _):
        owner = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid and user32.IsWindowVisible(hwnd) and user32.GetWindowTextLengthW(hwnd) > 0:
            found.append(hwnd)
        return True

    user32.EnumWindows(_EnumProc(cb), 0)
    return found[0] if found else None


def is_foreground(hwnd: int) -> bool:
    return user32.GetForegroundWindow() == hwnd


def _lparam(scancode: int, up: bool = False, alt: bool = False) -> int:
    lp = 1 | (scancode << 16)
    if alt:
        lp |= 1 << 29
    if up:
        lp |= (1 << 30) | (1 << 31)
    return lp


def _post(hwnd: int, msg: int, wparam: int, lparam: int) -> None:
    if not user32.PostMessageW(hwnd, msg, wparam, lparam):
        raise OSError(ctypes.get_last_error(), "PostMessageW failed (game window gone?)")


def post_text(hwnd: int, text: str, delay: float = 0.001) -> None:
    for i, ch in enumerate(text):
        _post(hwnd, WM_CHAR, ord(ch), 1)
        if delay and i % 50 == 49:
            time.sleep(delay * 50)


def post_key(hwnd: int, vk: int, scancode: int, count: int = 1) -> None:
    for _ in range(count):
        _post(hwnd, WM_KEYDOWN, vk, _lparam(scancode))
        if vk == VK_RETURN:
            _post(hwnd, WM_CHAR, 0x0D, _lparam(scancode))
        elif vk == VK_BACK:
            _post(hwnd, WM_CHAR, 0x08, _lparam(scancode))
        _post(hwnd, WM_KEYUP, vk, _lparam(scancode, up=True))


def post_console_toggle(hwnd: int, sys_keys: bool) -> None:
    """Post Alt+Shift+` to the game while its thread's key state reports Alt and Shift held."""
    game_tid = user32.GetWindowThreadProcessId(hwnd, None)
    my_tid = kernel32.GetCurrentThreadId()
    attached = bool(user32.AttachThreadInput(my_tid, game_tid, True))
    state = (ctypes.c_ubyte * 256)()
    user32.GetKeyboardState(state)
    saved = bytes(state)
    try:
        for vk in (VK_MENU, VK_LMENU, VK_SHIFT, VK_LSHIFT):
            state[vk] = 0x80
        user32.SetKeyboardState(state)
        down, upmsg = (WM_SYSKEYDOWN, WM_SYSKEYUP) if sys_keys else (WM_KEYDOWN, WM_KEYUP)
        _post(hwnd, down, VK_MENU, _lparam(SC_LALT, alt=True))
        _post(hwnd, down, VK_SHIFT, _lparam(SC_LSHIFT, alt=True))
        _post(hwnd, down, VK_OEM_3, _lparam(SC_GRAVE, alt=True))
        time.sleep(0.15)
        _post(hwnd, upmsg, VK_OEM_3, _lparam(SC_GRAVE, up=True, alt=True))
        _post(hwnd, upmsg, VK_SHIFT, _lparam(SC_LSHIFT, up=True, alt=True))
        _post(hwnd, WM_SYSKEYUP if sys_keys else WM_KEYUP, VK_MENU, _lparam(SC_LALT, up=True))
        time.sleep(0.3)
    finally:
        restore = (ctypes.c_ubyte * 256)(*saved)
        user32.SetKeyboardState(restore)
        if attached:
            user32.AttachThreadInput(my_tid, game_tid, False)


def send_console_toggle_if_foreground(hwnd: int) -> bool:
    """Real Alt+Shift+` via SendInput, only if the user already has the game in front."""
    if not is_foreground(hwnd):
        return False
    codes = (SC_LALT, SC_LSHIFT, SC_GRAVE)
    for sc in codes:
        if not is_foreground(hwnd):
            break
        _send_scan(sc, up=False)
        time.sleep(0.02)
    time.sleep(0.05)
    for sc in reversed(codes):
        _send_scan(sc, up=True)
        time.sleep(0.02)
    return True


def _send_scan(scancode: int, up: bool) -> None:
    flags = KEYEVENTF_SCANCODE | (KEYEVENTF_KEYUP if up else 0)
    inp = INPUT(INPUT_KEYBOARD, _INPUTUNION(ki=KEYBDINPUT(0, scancode, flags, 0, 0)))
    if user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT)) != 1:
        raise OSError(ctypes.get_last_error(), "SendInput blocked")
