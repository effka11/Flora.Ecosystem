#!/usr/bin/env python3
"""Compare two existing run_compete reports by windowed FFmpeg SSIM."""

from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
from pathlib import Path

from run_compete import Point, aggregate_bd


def ssim_db(ffmpeg: str, decoded: Path, reference: Path) -> float:
    proc = subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-i",
            str(decoded),
            "-i",
            str(reference),
            "-lavfi",
            "[0:v][1:v]ssim",
            "-f",
            "null",
            "-",
        ],
        check=False,
        capture_output=True,
    )
    text = proc.stderr.decode("utf-8", "replace")
    match = re.search(r"All:([0-9.]+)", text)
    if proc.returncode != 0 or match is None:
        raise RuntimeError(f"SSIM failed for {decoded}:\n{text}")
    value = float(match.group(1))
    return -10.0 * math.log10(max(1e-12, 1.0 - value))


def load_points(
    ffmpeg: str,
    report_dir: Path,
    corpus: Path,
    source_codec: str,
    output_codec: str,
) -> list[Point]:
    report = json.loads((report_dir / "report.json").read_text(encoding="utf-8"))
    points: list[Point] = []
    for point in report["points"]:
        if point["codec"] != source_codec:
            continue
        quality = point["knob"].split("=", 1)[1]
        stem = "frcv7" if source_codec == "frc-v7" else "frc"
        decoded = report_dir / "work" / f"{point['image']}_{stem}_q{quality}.png"
        reference = corpus / f"{point['image']}.png"
        points.append(
            Point(
                output_codec,
                point["image"],
                point["knob"],
                point["size"],
                ssim_db(ffmpeg, decoded, reference),
                point["enc_ms"],
            )
        )
    return points


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--test", type=Path, required=True)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--codec", default="frc-v7")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    args = parser.parse_args()

    baseline = load_points(
        args.ffmpeg, args.baseline, args.corpus, args.codec, "baseline"
    )
    test = load_points(args.ffmpeg, args.test, args.corpus, args.codec, "test")
    result = aggregate_bd(baseline + test, "test", "baseline")
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
