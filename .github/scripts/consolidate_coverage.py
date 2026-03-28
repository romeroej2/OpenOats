from __future__ import annotations

import json
import sys
from pathlib import Path


METRICS = ("lines", "functions", "regions")
DISPLAY_NAMES = {
    "linux": "Linux",
    "windows": "Windows",
    "macos": "macOS",
}


def pct(covered: int, count: int) -> float:
    if count == 0:
        return 100.0
    return covered * 100.0 / count


def load_totals(path: Path) -> dict[str, dict[str, int]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    totals = payload["data"][0]["totals"]
    return {
        metric: {
            "covered": int(totals[metric]["covered"]),
            "count": int(totals[metric]["count"]),
        }
        for metric in METRICS
    }


def display_name(path: Path) -> str:
    parent = path.parent.name
    if parent.startswith("coverage-"):
        suffix = parent.removeprefix("coverage-")
        return DISPLAY_NAMES.get(suffix, suffix)
    return DISPLAY_NAMES.get(parent, parent)


def format_row(name: str, totals: dict[str, dict[str, int]]) -> str:
    cells = [name]
    for metric in METRICS:
        covered = totals[metric]["covered"]
        count = totals[metric]["count"]
        cells.append(f"{pct(covered, count):.2f}% ({covered}/{count})")
    return "| " + " | ".join(cells) + " |"


def main() -> int:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".")
    reports = sorted(root.rglob("coverage-summary.json"))
    if not reports:
        raise SystemExit("No coverage-summary.json files found.")

    combined = {
        metric: {"covered": 0, "count": 0}
        for metric in METRICS
    }

    lines = [
        "## Coverage Summary",
        "",
        "| OS | Lines | Functions | Regions |",
        "| --- | --- | --- | --- |",
    ]

    for report in reports:
        totals = load_totals(report)
        for metric in METRICS:
            combined[metric]["covered"] += totals[metric]["covered"]
            combined[metric]["count"] += totals[metric]["count"]
        lines.append(format_row(display_name(report), totals))

    lines.append(format_row("Combined", combined))
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
