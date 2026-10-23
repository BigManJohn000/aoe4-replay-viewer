"""Compare the unit categories in viewer/units.js with aoe4world's unit classes.

Usage:
    python tools/check_units.py

Downloads aoe4world's unit table (data.aoe4world.com) and lists every unit whose category from viewer/units.js
differs from the one its aoe4world classes describe; exits 1 if any does. Run it after a game update that adds units
and extend the rules in viewer/units.js until nothing is listed. Left out: heroes (this project's own category, which
aoe4world files under cavalry or infantry), dummy placeholders (attachments here) and the Wynguard Palace army
bundles (a purchase, not a unit).
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import convert  # noqa: E402
import fetch_replays  # noqa: E402


def aoe4world_category(unit: dict) -> str:
    """The units.js category that a unit's aoe4world classes and display classes describe."""
    classes, display = set(unit["classes"]), " ".join(unit.get("displayClasses") or [])
    if "villager" in classes or "villager" in unit["attribName"]:
        return "villager"
    if "worker" in classes or "Economic" in display or display == "Worker":
        return "econ"
    if "ship" in classes or "naval_unit" in classes:
        return "ship"
    if "siege" in classes:
        return "siege"
    if "monk" in classes or "Religious" in display:
        return "religious"
    if "cavalry" in classes:
        return "cavalry"
    if "infantry" in classes:
        return "ranged" if "ranged" in classes else "infantry"
    return f"unknown ({display})"


def main() -> int:
    units = json.loads(fetch_replays.fetch(fetch_replays.DATA_URL.format(kind="units")))["data"]
    diffs: dict[tuple[str, str], set[str]] = defaultdict(set)
    for u in units:
        bp = u["attribName"]
        ours = convert.classify(bp, False)
        if ours in ("hero", "building") or "dummy" in bp or bp.startswith("unit_wynguard_"):
            continue
        theirs = aoe4world_category(u)
        if ours != theirs:
            diffs[(ours, theirs)].add(bp)
    for (ours, theirs), bps in sorted(diffs.items()):
        print(f"{ours} here, {theirs} on aoe4world: {', '.join(sorted(bps))}")
    print(f"{len(units)} aoe4world units, {sum(map(len, diffs.values()))} classified differently")
    return 1 if diffs else 0


if __name__ == "__main__":
    sys.exit(main())
