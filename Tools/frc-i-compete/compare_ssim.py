#!/usr/bin/env python3
"""Compare two run_compete reports by PSNR and windowed FFmpeg SSIM BD-rate."""

from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
from pathlib import Path

from run_compete import Point, aggregate_bd


def load_report_points(
    report_dir: Path, source_codec: str, output_codec: str
) -> list[Point]:
    report = json.loads((report_dir / "report.json").read_text(encoding="utf-8"))
    return [
        Point(
            output_codec,
            point["image"],
            point["knob"],
            point["size"],
            point["psnr"],
            point["enc_ms"],
        )
        for point in report["points"]
        if point["codec"] == source_codec
    ]


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
        knob = point["knob"].split("=", 1)[1]
        if source_codec.startswith("frc-v"):
            version = source_codec.removeprefix("frc-v")
            name = f"{point['image']}_frcv{version}_q{knob}.png"
        elif source_codec == "frc-i":
            name = f"{point['image']}_frc_q{knob}.png"
        elif source_codec == "avif":
            name = f"{point['image']}_avif_crf{knob}.avif"
        elif source_codec == "jpeg":
            name = f"{point['image']}_jpg_q{knob}.jpg"
        elif source_codec == "jxl":
            name = f"{point['image']}_jxl_d{knob}.jxl"
        else:
            raise ValueError(f"unsupported codec for SSIM: {source_codec}")
        decoded = report_dir / "work" / name
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
    parser.add_argument("--baseline-codec")
    parser.add_argument("--test-codec")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--psnr-only", action="store_true")
    args = parser.parse_args()

    baseline_codec = args.baseline_codec or args.codec
    test_codec = args.test_codec or args.codec
    psnr_baseline = load_report_points(args.baseline, baseline_codec, "baseline")
    psnr_test = load_report_points(args.test, test_codec, "test")
    result = {
        "psnr": aggregate_bd(psnr_baseline + psnr_test, "test", "baseline"),
    }
    if not args.psnr_only:
        ssim_baseline = load_points(
            args.ffmpeg, args.baseline, args.corpus, baseline_codec, "baseline"
        )
        ssim_test = load_points(
            args.ffmpeg, args.test, args.corpus, test_codec, "test"
        )
        result["ssim"] = aggregate_bd(
            ssim_baseline + ssim_test, "test", "baseline"
        )
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
