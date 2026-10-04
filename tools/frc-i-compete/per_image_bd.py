#!/usr/bin/env python3
"""Per-image BD-rate из report.json харнесса run_ab_frc.py.

Используется при калибровке v10: агрегаты (mean/median) в отчёте есть,
per-image регрессии приходится восстанавливать из сырых точек.

    python per_image_bd.py <report.json> <metric> [metric...]

metric: psnr_rgb | psnr_y | ssimulacra2 | neg_butteraugli
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from run_compete import bjontegaard  # noqa: E402


def metric_value(point: dict, metric: str) -> float:
    if metric == "neg_butteraugli":
        return -point["butteraugli"]
    return point[metric]


def main() -> int:
    report = json.load(open(sys.argv[1], encoding="utf-8"))
    metrics = sys.argv[2:] or ["ssimulacra2", "neg_butteraugli"]
    sides = [s["name"] for s in report["sides"]]
    a_name, b_name = sides[0], sides[1]
    images = sorted({p["image"] for p in report["points"]})
    for metric in metrics:
        print(f"--- BD-rate {b_name} vs {a_name}: {metric} ---")
        rows = []
        for img in images:
            curves: dict[str, list[tuple[float, float]]] = {a_name: [], b_name: []}
            for p in report["points"]:
                if p["image"] == img:
                    curves[p["side"]].append((p["size"], metric_value(p, metric)))
            rate_a = [c[0] for c in curves[a_name]]
            dist_a = [c[1] for c in curves[a_name]]
            rate_b = [c[0] for c in curves[b_name]]
            dist_b = [c[1] for c in curves[b_name]]
            # BD-rate стороны B относительно A (отрицательное = B лучше).
            bd = bjontegaard(rate_b, dist_b, rate_a, dist_a)
            if bd is not None:
                rows.append((img, bd))
        for img, bd in sorted(rows, key=lambda r: -r[1]):
            print(f"  {img}: {bd:+.2f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
