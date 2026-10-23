"""Cheap cross-process markers: which kinds of run are active ("recording": tools/record_replay.py playing a replay in
the game).

A marker is %TEMP%/fusion_locks/<kind>-<pid>.json holding the process id and its start time; one whose process is gone
(or whose pid was reused by another process) is stale and is ignored and deleted. Nothing blocks: a caller that must not
run beside another kind checks active() and refuses.
"""
from __future__ import annotations

import contextlib
import json
import os
import tempfile
from pathlib import Path

import psutil

LOCK_DIR = Path(tempfile.gettempdir()) / "fusion_locks"


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
    """Marks this process as running `kind` for the duration of the with block (nests: the outermost block owns the marker)."""
    LOCK_DIR.mkdir(parents=True, exist_ok=True)
    path = LOCK_DIR / f"{kind}-{os.getpid()}.json"
    owner = os.getpid() not in active(kind)
    if owner:
        path.write_text(json.dumps({"pid": os.getpid(), "started": psutil.Process().create_time()}), encoding="utf-8")
    try:
        yield
    finally:
        if owner:
            path.unlink(missing_ok=True)
