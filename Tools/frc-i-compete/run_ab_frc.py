#!/usr/bin/env python3
"""
A/B двух конфигураций FRC-I на перцептивном полигоне (S2/BA/PSNR/SSIM).

Сторона задаётся версией битстрима и env-переменными кодера
(например, FRC_I_DQ_LUMA / FRC_I_DQ_CHROMA для v9 AQ):

  python Tools/frc-i-compete/run_ab_frc.py \\
      --corpus Local/frc-i-compete/kodak \\
      --out Local/frc-i-compete/ab-v9-aq1 \\
      --a-bitstream 8 --b-bitstream 9 \\
      --b-env FRC_I_DQ_LUMA=1.0,FRC_I_DQ_CHROMA=1.0

BD-rate B vs A считается по каждой метрике (отрицательное = B лучше);
скорость кодирования меряется отдельным последовательным проходом.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_compete import (  # noqa: E402
    Point,
    aggregate_bd,
    fetch_kodak,
    find_ffmpeg,
    find_flora_codec,
    load_rgb_png,
    psnr_rgb,
)
from run_honest_jxl import (  # noqa: E402
    butteraugli_score,
    psnr_y_bt709,
    ssim_db,
    ssimulacra2_score,
    which_or_exit,
)


@dataclass
class AbPoint:
    side: str
    image: str
    quality: int
    size: int
    psnr_rgb: float
    psnr_y: float
    ssim_db: float
    ssimulacra2: float
    butteraugli: float


@dataclass(frozen=True)
class Side:
    name: str
    bitstream: int | None
    env: dict[str, str]


def parse_env(spec: str | None) -> dict[str, str]:
    if not spec:
        return {}
    out: dict[str, str] = {}
    for pair in spec.split(","):
        pair = pair.strip()
        if not pair:
            continue
        k, _, v = pair.partition("=")
        out[k.strip()] = v.strip()
    return out


def encode_side(flora: str, side: Side, src: Path, out: Path, quality: int) -> tuple[int, float]:
    cmd = [flora, "image", "encode", str(src), str(out), "--quality", str(quality)]
    if side.bitstream is not None:
        cmd += ["--bitstream", str(side.bitstream)]
    env = dict(os.environ)
    env.update(side.env)
    t0 = time.perf_counter()
    subprocess.run(cmd, check=True, capture_output=True, env=env)
    return out.stat().st_size, (time.perf_counter() - t0) * 1000.0


def decode_frc(flora: str, side: Side, fri: Path, png: Path) -> None:
    # env стороны и на декоде: нормативные A/B (например, формы qmatrix)
    # обязаны читаться одинаковой конфигурацией с обеих сторон.
    env = dict(os.environ)
    env.update(side.env)
    subprocess.run(
        [flora, "image", "decode", str(fri), str(png)],
        check=True,
        capture_output=True,
        env=env,
    )


def to_points(rich: list[AbPoint], metric: str) -> list[Point]:
    out: list[Point] = []
    for r in rich:
        q = {
            "psnr_rgb": r.psnr_rgb,
            "psnr_y": r.psnr_y,
            "ssim_db": r.ssim_db,
            "ssimulacra2": r.ssimulacra2,
            "neg_butteraugli": -r.butteraugli,
        }[metric]
        out.append(Point(r.side, r.image, f"q={r.quality}", r.size, q, 0.0))
    return out


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--corpus", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--flora-codec", default=None)
    ap.add_argument("--fetch-kodak", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--a-bitstream", type=int, default=8)
    ap.add_argument("--b-bitstream", type=int, default=9)
    ap.add_argument("--a-env", default=None, help="k=v[,k=v...] для стороны A")
    ap.add_argument("--b-env", default=None, help="k=v[,k=v...] для стороны B")
    ap.add_argument("--a-name", default=None)
    ap.add_argument("--b-name", default=None)
    # ≥4 точек на кривую требует BD-fit (кубический полином).
    ap.add_argument("--qs", default="30,40,50,60,70,80,90")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--skip-ssim", action="store_true", help="пропустить ffmpeg SSIM (медленный)")
    ap.add_argument("--skip-butteraugli", action="store_true")
    ap.add_argument("--skip-ssimulacra2", action="store_true")
    ap.add_argument("--skip-speed", action="store_true")
    args = ap.parse_args()

    if args.fetch_kodak:
        fetch_kodak(args.corpus)

    ff = find_ffmpeg()
    flora = find_flora_codec(args.flora_codec)
    ssimu = which_or_exit("ssimulacra2") if not args.skip_ssimulacra2 else ""
    ba = which_or_exit("butteraugli_main") if not args.skip_butteraugli else ""

    sides = [
        Side(args.a_name or f"A-v{args.a_bitstream}", args.a_bitstream, parse_env(args.a_env)),
        Side(args.b_name or f"B-v{args.b_bitstream}", args.b_bitstream, parse_env(args.b_env)),
    ]
    if sides[0].name == sides[1].name:
        raise SystemExit("стороны должны иметь разные имена (--a-name/--b-name)")

    images = sorted(args.corpus.glob("*.png"))
    if args.limit:
        images = images[: args.limit]
    if not images:
        raise SystemExit(f"нет PNG в {args.corpus}")
    qs = [int(x) for x in args.qs.split(",") if x.strip()]

    args.out.mkdir(parents=True, exist_ok=True)
    work = args.out / "work"
    work.mkdir(exist_ok=True)

    print(f"корпус: {len(images)} PNG; q={qs}")
    for s in sides:
        print(f"  {s.name}: bitstream={s.bitstream} env={s.env}")

    def eval_image(src: Path) -> list[AbPoint]:
        ref_rgb = load_rgb_png(src)
        rows: list[AbPoint] = []
        for side in sides:
            for q in qs:
                fri = work / f"{src.stem}_{side.name}_q{q}.fri"
                png = work / f"{src.stem}_{side.name}_q{q}.png"
                size, _ = encode_side(flora, side, src, fri, q)
                decode_frc(flora, side, fri, png)
                dec = load_rgb_png(png)
                pr = psnr_rgb(ref_rgb, dec)
                py = psnr_y_bt709(ref_rgb, dec)
                sd = ssim_db(ff, png, src) if not args.skip_ssim else float("nan")
                s2 = ssimulacra2_score(ssimu, src, png) if ssimu else float("nan")
                bav = butteraugli_score(ba, src, png) if ba else float("nan")
                rows.append(AbPoint(side.name, src.stem, q, size, pr, py, sd, s2, bav))
        print(f"  done {src.stem}", flush=True)
        return rows

    rich: list[AbPoint] = []
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for rows in pool.map(eval_image, images):
            rich.extend(rows)

    metrics = ["psnr_rgb", "psnr_y"]
    if not args.skip_ssim:
        metrics.append("ssim_db")
    if not args.skip_ssimulacra2:
        metrics.append("ssimulacra2")
    if not args.skip_butteraugli:
        metrics.append("neg_butteraugli")

    print(f"\n===== BD-RATE {sides[1].name} vs {sides[0].name} (отриц. = B лучше) =====")
    bd_all: dict[str, dict] = {}
    for metric in metrics:
        pts = to_points(rich, metric)
        bd = aggregate_bd(pts, sides[1].name, sides[0].name)
        bd_all[metric] = {k: v for k, v in bd.items() if k != "per_image"}
        print(
            f"{metric:15s}: mean {bd.get('mean', float('nan')):+7.2f}%  "
            f"median {bd.get('median', float('nan')):+7.2f}%  (n={bd.get('n', 0)})"
        )

    # Средний размер лестницы (грубая прикидка плотности).
    size_by_side = {
        s.name: sum(r.size for r in rich if r.side == s.name) for s in sides
    }
    ratio = size_by_side[sides[1].name] / max(1, size_by_side[sides[0].name])
    print(f"\nсумма байт лестницы: B/A = {ratio:.4f}")

    speed: dict[str, dict] = {}
    if not args.skip_speed:
        print("\n===== ENCODE SPEED (q=70, последовательный проход) =====")
        for side in sides:
            total_ms = 0.0
            total_mp = 0.0
            for src in images:
                ref = load_rgb_png(src)
                fri = work / f"{src.stem}_{side.name}_speed.fri"
                _, ms = encode_side(flora, side, src, fri, 70)
                total_ms += ms
                total_mp += ref.shape[0] * ref.shape[1] / 1e6
            mps = total_mp / (total_ms / 1000.0)
            speed[side.name] = {"total_ms": total_ms, "mpx_s": mps}
            print(f"{side.name:12s}: {total_ms:7.0f} ms  → {mps:6.2f} Мп/с (включая spawn)")

    report = {
        "sides": [asdict(s) for s in sides],
        "qs": qs,
        "n_images": len(images),
        "bd_rate_b_vs_a": bd_all,
        "ladder_size_ratio_b_over_a": ratio,
        "encode_speed": speed,
        "points": [asdict(r) for r in rich],
    }
    (args.out / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\nJSON: {args.out / 'report.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
