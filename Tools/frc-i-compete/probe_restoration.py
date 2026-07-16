#!/usr/bin/env python3
"""
Offline-falsification tile-local luma restoration для FRC-I v7.

Скрипт использует сохранённые `.fri`/decoded PNG из `audit_v7.py`, подбирает
на каждом 256×256 tile два Q8-коэффициента DC-preserving 3×3 Wiener-класса:

  Y' = Y + a * (N + S + W + E - 4Y)
         + d * (NW + NE + SW + SE - 4Y)

Фильтр включается только при снижении RGB SSE после fixed-point BT.601
inverse. В rate добавляется консервативная цена: один enable-byte на tile и
два signed coefficient bytes на включённый tile. Это не normative codec code,
а дешёвая проверка потенциального BD-rate до изменения wire/decoder.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

import numpy as np

from audit_v7 import TILE, parse_qualities, psnr_from_sse, rgb_to_ycbcr
from run_compete import bjontegaard, load_rgb_png


def ycbcr_to_rgb(ycbcr: np.ndarray) -> np.ndarray:
    values = ycbcr.astype(np.int64)
    y = values[..., 0]
    cb = values[..., 1] - 128
    cr = values[..., 2] - 128
    half = 1 << 15
    r = y + ((91_881 * cr + half) >> 16)
    g = y + ((-22_553 * cb - 46_802 * cr + half) >> 16)
    b = y + ((116_130 * cb + half) >> 16)
    return np.stack(
        [np.clip(r, 0, 255), np.clip(g, 0, 255), np.clip(b, 0, 255)],
        axis=-1,
    ).astype(np.uint8)


def restoration_features(luma: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    center = luma.astype(np.int64)
    padded = np.pad(center, 1, mode="edge")
    axial = (
        padded[:-2, 1:-1]
        + padded[2:, 1:-1]
        + padded[1:-1, :-2]
        + padded[1:-1, 2:]
        - 4 * center
    )
    diagonal = (
        padded[:-2, :-2]
        + padded[:-2, 2:]
        + padded[2:, :-2]
        + padded[2:, 2:]
        - 4 * center
    )
    return axial, diagonal


def fit_q8(
    reference_luma: np.ndarray,
    decoded_luma: np.ndarray,
    coefficient_limit: int,
) -> tuple[int, int]:
    axial, diagonal = restoration_features(decoded_luma)
    features = np.column_stack([axial.ravel(), diagonal.ravel()]).astype(np.float64)
    target = (
        reference_luma.astype(np.float64) - decoded_luma.astype(np.float64)
    ).ravel()
    coefficients, _, _, _ = np.linalg.lstsq(features, target, rcond=None)
    quantized = np.rint(coefficients * 256.0).astype(np.int64)
    quantized = np.clip(quantized, -coefficient_limit, coefficient_limit)
    return int(quantized[0]), int(quantized[1])


def apply_q8(luma: np.ndarray, axial_q8: int, diagonal_q8: int) -> np.ndarray:
    axial, diagonal = restoration_features(luma)
    correction = (axial_q8 * axial + diagonal_q8 * diagonal + 128) >> 8
    return np.clip(luma.astype(np.int64) + correction, 0, 255)


def rgb_sse(reference: np.ndarray, decoded: np.ndarray) -> int:
    delta = reference.astype(np.int64) - decoded.astype(np.int64)
    return int(np.sum(delta * delta, dtype=np.int64))


def restore_image(
    reference_rgb: np.ndarray,
    decoded_rgb: np.ndarray,
    coefficient_limit: int,
) -> tuple[np.ndarray, list[dict[str, int]]]:
    reference_ycbcr = rgb_to_ycbcr(reference_rgb)
    decoded_ycbcr = rgb_to_ycbcr(decoded_rgb)
    output = decoded_rgb.copy()
    height, width, _ = decoded_rgb.shape
    decisions: list[dict[str, int]] = []
    for y0 in range(0, height, TILE):
        for x0 in range(0, width, TILE):
            y1 = min(y0 + TILE, height)
            x1 = min(x0 + TILE, width)
            reference_tile = reference_rgb[y0:y1, x0:x1]
            decoded_tile = decoded_rgb[y0:y1, x0:x1]
            ycbcr_tile = decoded_ycbcr[y0:y1, x0:x1].copy()
            axial_q8, diagonal_q8 = fit_q8(
                reference_ycbcr[y0:y1, x0:x1, 0],
                ycbcr_tile[..., 0],
                coefficient_limit,
            )
            ycbcr_tile[..., 0] = apply_q8(
                ycbcr_tile[..., 0],
                axial_q8,
                diagonal_q8,
            )
            candidate = ycbcr_to_rgb(ycbcr_tile)
            baseline_sse = rgb_sse(reference_tile, decoded_tile)
            candidate_sse = rgb_sse(reference_tile, candidate)
            enabled = candidate_sse < baseline_sse
            if enabled:
                output[y0:y1, x0:x1] = candidate
            decisions.append(
                {
                    "x": x0,
                    "y": y0,
                    "enabled": int(enabled),
                    "axial_q8": axial_q8 if enabled else 0,
                    "diagonal_q8": diagonal_q8 if enabled else 0,
                    "sse_delta": candidate_sse - baseline_sse if enabled else 0,
                }
            )
    return output, decisions


def summarize_bd(points: list[dict[str, Any]]) -> dict[str, Any]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for point in points:
        grouped.setdefault(point["image"], []).append(point)
    rates = []
    for image_points in grouped.values():
        image_points.sort(key=lambda point: point["quality"])
        rate = bjontegaard(
            [point["restored_size"] for point in image_points],
            [point["restored_psnr"] for point in image_points],
            [point["baseline_size"] for point in image_points],
            [point["baseline_psnr"] for point in image_points],
        )
        if not math.isnan(rate):
            rates.append(rate)
    rates.sort()
    return {
        "mean": float(sum(rates) / len(rates)),
        "median": float(rates[len(rates) // 2]),
        "min": float(rates[0]),
        "max": float(rates[-1]),
        "improved": sum(rate < 0 for rate in rates),
        "n": len(rates),
        "per_image": rates,
    }


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument(
        "--audit-out",
        type=Path,
        required=True,
        help="каталог предыдущего audit_v7.py с подкаталогом work",
    )
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument(
        "--qualities",
        type=parse_qualities,
        default=parse_qualities("30,50,70,85,95"),
    )
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument(
        "--coefficient-limit",
        type=int,
        default=64,
        help="максимальный |Q8 coefficient| (64 = 0.25)",
    )
    args = parser.parse_args()

    images = sorted(args.corpus.glob("*.png"))
    if args.limit:
        images = images[: args.limit]
    if not images:
        raise SystemExit(f"нет PNG в {args.corpus}")
    work = args.audit_out / "work"
    if not work.is_dir():
        raise SystemExit(f"нет audit work: {work}")
    args.out.mkdir(parents=True, exist_ok=True)

    points: list[dict[str, Any]] = []
    for source in images:
        reference = load_rgb_png(source)
        print(f"\n=== {source.stem} ===", flush=True)
        for quality in args.qualities:
            fri = work / f"{source.stem}_v7_q{quality}.fri"
            decoded_path = work / f"{source.stem}_v7_q{quality}.png"
            if not fri.is_file() or not decoded_path.is_file():
                raise SystemExit(f"нет audit point q={quality}: {source.stem}")
            decoded = load_rgb_png(decoded_path)
            restored, decisions = restore_image(
                reference,
                decoded,
                args.coefficient_limit,
            )
            pixels = reference.shape[0] * reference.shape[1]
            baseline_sse = rgb_sse(reference, decoded)
            restored_sse = rgb_sse(reference, restored)
            enabled = sum(decision["enabled"] for decision in decisions)
            signaling_bytes = len(decisions) + 2 * enabled
            point = {
                "image": source.stem,
                "quality": quality,
                "baseline_size": fri.stat().st_size,
                "restored_size": fri.stat().st_size + signaling_bytes,
                "signaling_bytes": signaling_bytes,
                "baseline_psnr": psnr_from_sse(baseline_sse, pixels * 3),
                "restored_psnr": psnr_from_sse(restored_sse, pixels * 3),
                "enabled_tiles": enabled,
                "tiles": len(decisions),
                "decisions": decisions,
            }
            points.append(point)
            print(
                f"q={quality:2d} ΔPSNR="
                f"{point['restored_psnr'] - point['baseline_psnr']:+.4f} dB "
                f"tiles={enabled}/{len(decisions)} signal={signaling_bytes} B",
                flush=True,
            )

    bd_rate = summarize_bd(points)
    quality_summary = []
    for quality in args.qualities:
        selected = [point for point in points if point["quality"] == quality]
        quality_summary.append(
            {
                "quality": quality,
                "mean_psnr_delta": float(
                    sum(
                        point["restored_psnr"] - point["baseline_psnr"]
                        for point in selected
                    )
                    / len(selected)
                ),
                "enabled_tiles": sum(point["enabled_tiles"] for point in selected),
                "tiles": sum(point["tiles"] for point in selected),
                "signaling_bytes": sum(point["signaling_bytes"] for point in selected),
            }
        )

    print(
        "\nBD-rate restored vs accepted v7: "
        f"{bd_rate['mean']:+.2f}% mean, {bd_rate['median']:+.2f}% median, "
        f"range {bd_rate['min']:+.2f}…{bd_rate['max']:+.2f}%, "
        f"improved {bd_rate['improved']}/{bd_rate['n']}",
        flush=True,
    )
    report = {
        "corpus": str(args.corpus),
        "audit_out": str(args.audit_out),
        "coefficient_limit": args.coefficient_limit,
        "bd_rate": bd_rate,
        "quality_summary": quality_summary,
        "points": points,
    }
    report_path = args.out / "restoration.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"JSON: {report_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
