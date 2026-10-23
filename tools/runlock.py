"""Cheap cross-process markers: which kinds of run are active ("recording": tools/record_replay.py playing a replay in
the game).

A marker is %TEMP%/fusion_locks/<kind>-<pid>.json holding the process id and its start time; stale markers are deleted.
hold() also takes a kernel-backed file lock, so competing controllers cannot race the marker check.
"""
from __future__ import annotations

import contextlib
import json
import os
import tempfile
import msvcrt
import threading
from pathlib import Path

import psutil

LOCK_DIR = Path(tempfile.gettempdir()) / "fusion_locks"
_guard = threading.RLock()
_holders = {}


class LockError(RuntimeError):
    pass


def _alive(pid: int, started: float) -> bool:
    try:
        return abs(psutil.Process(pid).create_time() - started) < 1.0
    except psutil.Error:
        return False


def active(kind: str) -> list[int]:
    """Process ids of the live holders of `kind` (stale markers are removed)."""
    out = []
    for f in LOCK_DIR.glob(f"{kind}-*.json"):
        try:
            info = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if _alive(info["pid"], info["started"]):
            out.append(info["pid"])
        else:
            f.unlink(missing_ok=True)
    return sorted(out)


@contextlib.contextmanager
def hold(kind: str):
    """Exclusively hold a run kind; nested calls in this process share the outermost lock."""
    with _guard:
        if kind in _holders:
            _holders[kind][1] += 1
        else:
            LOCK_DIR.mkdir(parents=True, exist_ok=True)
            stream = (LOCK_DIR / f"{kind}.lock").open("a+b")
            stream.seek(0)
            try:
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                stream.close()
                raise LockError(f"Another live process holds the {kind} lock (PIDs: {active(kind)})") from None
            try:
                others = [pid for pid in active(kind) if pid != os.getpid()]
                if others:
                    raise LockError(f"Another live process holds the {kind} lock (PIDs: {others})")
                path = LOCK_DIR / f"{kind}-{os.getpid()}.json"
                path.write_text(json.dumps({"pid": os.getpid(), "started": psutil.Process().create_time()}),
                                encoding="utf-8")
                _holders[kind] = [stream, 1, path]
            except BaseException:
                stream.close()
                raise
    try:
        yield
    finally:
        with _guard:
            holder = _holders[kind]
            holder[1] -= 1
            if holder[1] == 0:
                holder[2].unlink(missing_ok=True)
                holder[0].close()
                del _holders[kind]
