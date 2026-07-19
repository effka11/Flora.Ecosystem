#!/usr/bin/env python3
"""Print a compact analysis of run_honest_jxl.py report.json."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> int:
    import sys

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser()
    ap.add_argument("report", type=Path)
    args = ap.parse_args()
    r = json.loads(args.report.read_text(encoding="utf-8"))
    print(f"n_images={r['n_images']}  n_points={len(r['points'])}")
    print("\n=== BD-RATE (mean / median; neg = FRC smaller) ===")
    for metric, pairs in r["bd_rate"].items():
        print(metric)
        for k, v in pairs.items():
            mean = v["mean"]
            med = v.get("median", float("nan"))
            per = v.get("per_image") or []
            wins = sum(1 for x in per if x < 0)
            losses = sum(1 for x in per if x > 0)
            print(
                f"  {k}: mean={mean:+.2f}% median={med:+.2f}% "
                f"frames FRC-better={wins}/{len(per)} worse={losses}"
            )
    print("\n=== ISO-SIZE (+ = FRC better) ===")
    for k, v in r["iso_size"].items():
        print(
            f"  {k}: mean d={v['mean_delta']:+.3f} med={v.get('median_delta', float('nan')):+.3f} "
            f"W/L/T={v.get('wins')}/{v.get('losses')}/{v.get('ties')} n={v['n']}"
        )
    print("\n=== SPEED ===")
    for k, v in r["encode_speed"].items():
        print(f"  {k}: {v['mpx_s']:.2f} Mpx/s  ({v['mean_enc_ms']:.0f} ms @ {v['knob']})")

    # Product profiles: FRC q=75/85 vs nearest JXL size
    print("\n=== PRODUCT PROFILES (FRC q vs nearest JXL-e7 by size) ===")
    by: dict[str, dict[str, list]] = {}
    for p in r["points"]:
        by.setdefault(p["image"], {}).setdefault(p["codec"], []).append(p)
    for q in (75, 85):
        # approximate: use q=70/80/85 ladder — pick exact if present else nearest
        rows_s2 = []
        rows_ba = []
        for img, codecs in by.items():
            frcs = codecs.get("frc-i", [])
            jxls = codecs.get("jxl-e7", [])
            if not frcs or not jxls:
                continue
            # exact q or closest among available
            frc = min(frcs, key=lambda x: abs(int(x["knob"].split("=")[1]) - q))
            if abs(int(frc["knob"].split("=")[1]) - q) > 5:
                continue
            jxl = min(jxls, key=lambda x: abs(x["size"] - frc["size"]))
            rows_s2.append(frc["ssimulacra2"] - jxl["ssimulacra2"])
            rows_ba.append(jxl["butteraugli"] - frc["butteraugli"])
            print(
                f"  q≈{q} {img}: FRC {frc['knob']} {frc['size']}B S2={frc['ssimulacra2']:.1f} BA={frc['butteraugli']:.3f} | "
                f"JXL {jxl['knob']} {jxl['size']}B S2={jxl['ssimulacra2']:.1f} BA={jxl['butteraugli']:.3f}"
            )
        if rows_s2:
            print(
                f"  >> q≈{q} mean ΔS2={sum(rows_s2)/len(rows_s2):+.2f}  "
                f"mean ΔBA(better+)= {sum(rows_ba)/len(rows_ba):+.3f}  n={len(rows_s2)}"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
