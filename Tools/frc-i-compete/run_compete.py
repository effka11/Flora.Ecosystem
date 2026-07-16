#!/usr/bin/env python3
"""
Честный RD-полигон FRC-I vs JPEG / AVIF / JPEG XL (FRC-I.md §11.2).

Корпус: Kodak (24 PNG, 768x512; скачивается `--fetch-kodak`).
Метрики: размер, PSNR(RGB), encode time; BD-rate (Bjontegaard) по парам кодеков.

Требования: ffmpeg с libaom-av1 и libjxl в PATH, numpy,
release-сборка CLI: `cargo build -p flora-codec-tools --release`.

Пример:
  python Tools/frc-i-compete/run_compete.py \
      --corpus Local/frc-i-compete/kodak --fetch-kodak \
      --out Local/frc-i-compete/out-kodak --avif-cpu 4

Пишет цифры в stdout и полный JSON-отчёт в --out/report.json.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path

try:
    import numpy as np
except ImportError:
    print("нужен numpy: pip install numpy", file=sys.stderr)
    sys.exit(1)


@dataclass
class Point:
    codec: str
    image: str
    knob: str
    size: int
    psnr: float
    enc_ms: float


def run(cmd: list[str], *, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(cmd, check=check, capture_output=True)


KODAK_BASE = "http://r0k.us/graphics/kodak/kodak"


def fetch_kodak(dest: Path) -> None:
    """Скачивает 24 кадра Kodak, пропуская уже существующие."""
    import urllib.request

    dest.mkdir(parents=True, exist_ok=True)
    for i in range(1, 25):
        name = f"kodim{i:02d}.png"
        out = dest / name
        if out.exists() and out.stat().st_size > 10_000:
            continue
        url = f"{KODAK_BASE}/{name}"
        print(f"fetch {url}", flush=True)
        with urllib.request.urlopen(url, timeout=120) as r:
            out.write_bytes(r.read())


def find_ffmpeg() -> str:
    p = shutil.which("ffmpeg")
    if not p:
        raise SystemExit("ffmpeg не найден в PATH")
    return p


def find_flora_codec(explicit: str | None) -> str:
    if explicit:
        return explicit
    root = Path(__file__).resolve().parents[2]
    candidates = [
        root / "Target" / "release" / "flora-codec.exe",
        root / "Target" / "release" / "flora-codec",
        root / "target" / "release" / "flora-codec.exe",
        root / "target" / "release" / "flora-codec",
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    raise SystemExit(
        "flora-codec release не найден; собери: cargo build -p flora-codec-tools --release"
    )


def load_rgb_png(path: Path) -> np.ndarray:
    """Декодирует PNG через ffmpeg в packed RGB24 numpy HxWx3."""
    ff = find_ffmpeg()
    # probe size
    probe = run(
        [
            ff,
            "-hide_banner",
            "-i",
            str(path),
            "-f",
            "null",
            "-",
        ],
        check=False,
    )
    # decode
    with tempfile.NamedTemporaryFile(suffix=".rgb", delete=False) as tmp:
        raw_path = Path(tmp.name)
    try:
        # get w/h via ffprobe-like parse from stderr of ffmpeg -i
        info = run([ff, "-hide_banner", "-i", str(path)], check=False)
        text = info.stderr.decode("utf-8", "replace")
        w = h = None
        for line in text.splitlines():
            if "Video:" in line and "x" in line:
                # ... 768x512 ...
                for tok in line.replace(",", " ").split():
                    if "x" in tok and tok[0].isdigit():
                        a, b = tok.split("x", 1)
                        if a.isdigit() and b.isdigit():
                            w, h = int(a), int(b)
                            break
            if w is not None:
                break
        if w is None or h is None:
            raise RuntimeError(f"не удалось прочитать размер {path}")
        run(
            [
                ff,
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(path),
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                str(raw_path),
            ]
        )
        data = np.frombuffer(raw_path.read_bytes(), dtype=np.uint8)
        if data.size != w * h * 3:
            raise RuntimeError(f"raw size mismatch for {path}: {data.size} vs {w*h*3}")
        return data.reshape(h, w, 3)
    finally:
        raw_path.unlink(missing_ok=True)


def psnr_rgb(ref: np.ndarray, dec: np.ndarray) -> float:
    if ref.shape != dec.shape:
        raise ValueError(f"shape {ref.shape} vs {dec.shape}")
    mse = np.mean((ref.astype(np.float64) - dec.astype(np.float64)) ** 2)
    if mse <= 1e-12:
        return 99.0
    return float(10.0 * math.log10((255.0 * 255.0) / mse))


def encode_frc(
    flora: str, src: Path, out: Path, quality: int, bitstream: int | None = None
) -> tuple[int, float]:
    cmd = [flora, "image", "encode", str(src), str(out), "--quality", str(quality)]
    if bitstream is not None:
        cmd += ["--bitstream", str(bitstream)]
    t0 = time.perf_counter()
    run(cmd)
    ms = (time.perf_counter() - t0) * 1000.0
    return out.stat().st_size, ms


def decode_frc_to_png(flora: str, fri: Path, png: Path) -> None:
    run([flora, "image", "decode", str(fri), str(png)])


def encode_jpeg(ff: str, src: Path, out: Path, quality: int) -> tuple[int, float]:
    # -q:v 2..31 (lower better). Map 1..100 → ~2..31.
    qv = max(2, min(31, int(round(31 - (quality / 100.0) * 29))))
    t0 = time.perf_counter()
    run(
        [
            ff,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(src),
            "-q:v",
            str(qv),
            str(out),
        ]
    )
    ms = (time.perf_counter() - t0) * 1000.0
    return out.stat().st_size, ms


def encode_avif(ff: str, src: Path, out: Path, crf: int, cpu_used: int) -> tuple[int, float]:
    t0 = time.perf_counter()
    run(
        [
            ff,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(src),
            "-c:v",
            "libaom-av1",
            "-still-picture",
            "1",
            "-cpu-used",
            str(cpu_used),
            "-crf",
            str(crf),
            "-row-mt",
            "1",
            "-tiles",
            "2x2",
            str(out),
        ]
    )
    ms = (time.perf_counter() - t0) * 1000.0
    return out.stat().st_size, ms


def encode_jxl(ff: str, src: Path, out: Path, distance: float) -> tuple[int, float]:
    # libjxl in ffmpeg: -distance 0..15 (0 lossless). Also -q:v 0..100.
    t0 = time.perf_counter()
    run(
        [
            ff,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(src),
            "-c:v",
            "libjxl",
            "-distance",
            str(distance),
            str(out),
        ]
    )
    ms = (time.perf_counter() - t0) * 1000.0
    return out.stat().st_size, ms


def decode_any_to_rgb(ff: str, path: Path) -> np.ndarray:
    with tempfile.TemporaryDirectory() as td:
        png = Path(td) / "d.png"
        run(
            [
                ff,
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(path),
                str(png),
            ]
        )
        return load_rgb_png(png)


def bjontegaard(rate1: list[float], dist1: list[float], rate2: list[float], dist2: list[float]) -> float:
    """
    BD-Rate (%): насколько rate1 больше/меньше rate2 при той же distortion.
    Отрицательное = rate1 лучше (меньше битрейт).
    Лог-rate, cubic poly fit по distortion (как в классическом BD-PSNR rate).
    """
    # sort by distortion ascending
    p1 = sorted(zip(dist1, rate1))
    p2 = sorted(zip(dist2, rate2))
    d1 = [p[0] for p in p1]
    r1 = [math.log(p[1]) for p in p1]
    d2 = [p[0] for p in p2]
    r2 = [math.log(p[1]) for p in p2]
    if len(d1) < 4 or len(d2) < 4:
        return float("nan")
    lo = max(min(d1), min(d2))
    hi = min(max(d1), max(d2))
    if hi <= lo + 0.1:
        return float("nan")
    # integrate exp(poly(d)) over overlapping PSNR range
    c1 = np.polyfit(d1, r1, min(3, len(d1) - 1))
    c2 = np.polyfit(d2, r2, min(3, len(d2) - 1))
    samples = np.linspace(lo, hi, 100)
    int1 = float(np.trapezoid(np.polyval(c1, samples), samples))
    int2 = float(np.trapezoid(np.polyval(c2, samples), samples))
    avg = (int1 - int2) / (hi - lo)
    return float((math.exp(avg) - 1.0) * 100.0)


def aggregate_bd(points: list[Point], test: str, ref: str) -> dict[str, float]:
    by_img: dict[str, dict[str, list[Point]]] = {}
    for p in points:
        by_img.setdefault(p.image, {}).setdefault(p.codec, []).append(p)
    rates = []
    for img, codecs in by_img.items():
        if test not in codecs or ref not in codecs:
            continue
        a = codecs[test]
        b = codecs[ref]
        if len(a) < 4 or len(b) < 4:
            continue
        bd = bjontegaard(
            [p.size for p in a],
            [p.psnr for p in a],
            [p.size for p in b],
            [p.psnr for p in b],
        )
        if not math.isnan(bd):
            rates.append(bd)
    if not rates:
        return {"mean": float("nan"), "n": 0}
    return {"mean": float(sum(rates) / len(rates)), "median": float(sorted(rates)[len(rates) // 2]), "n": len(rates), "per_image": rates}


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--flora-codec", default=None)
    ap.add_argument("--fetch-kodak", action="store_true", help="скачать корпус Kodak в --corpus")
    ap.add_argument("--limit", type=int, default=0, help="только первые N изображений (0=все)")
    ap.add_argument("--avif-cpu", type=int, default=4, help="libaom -cpu-used (0 slow/best .. 8 fast)")
    ap.add_argument("--skip-jxl", action="store_true")
    ap.add_argument("--skip-avif", action="store_true")
    ap.add_argument("--skip-jpeg", action="store_true")
    ap.add_argument(
        "--frc-bitstream",
        type=int,
        default=None,
        help="дополнительно прогнать FRC-I с явной версией битстрима (например 7) как кодек frc-vN",
    )
    args = ap.parse_args()

    if args.fetch_kodak:
        fetch_kodak(args.corpus)

    ff = find_ffmpeg()
    flora = find_flora_codec(args.flora_codec)
    images = sorted(args.corpus.glob("*.png"))
    if args.limit:
        images = images[: args.limit]
    if not images:
        raise SystemExit(f"нет PNG в {args.corpus}")

    args.out.mkdir(parents=True, exist_ok=True)
    work = args.out / "work"
    work.mkdir(exist_ok=True)

    # denser ladder so BD-rate overlaps AVIF/JXL mid-range honestly
    frc_qs = [30, 40, 50, 60, 70, 80, 85, 90, 95]
    jpeg_qs = [30, 40, 50, 60, 70, 80, 85, 90, 95]
    # libaom CRF: lower = better quality / larger. Still-picture CRF ~18..55.
    avif_crfs = [55, 48, 40, 34, 28, 22, 18]
    # JXL butteraugli distance: lower = better.
    jxl_dists = [3.5, 2.5, 2.0, 1.5, 1.0, 0.7, 0.5]

    points: list[Point] = []
    print(f"корпус: {len(images)} PNG | flora={flora}", flush=True)
    print(f"AVIF cpu-used={args.avif_cpu} (выше=быстрее/хуже; 0=лучше)", flush=True)

    for src in images:
        name = src.stem
        print(f"\n=== {name} ===", flush=True)
        ref = load_rgb_png(src)

        for q in frc_qs:
            fri = work / f"{name}_frc_q{q}.fri"
            png = work / f"{name}_frc_q{q}.png"
            size, ms = encode_frc(flora, src, fri, q)
            decode_frc_to_png(flora, fri, png)
            dec = load_rgb_png(png)
            p = psnr_rgb(ref, dec)
            points.append(Point("frc-i", name, f"q={q}", size, p, ms))
            print(f"  FRC-I  q={q:2d}  {size:7d} B  PSNR {p:5.2f}  enc {ms:7.0f} ms", flush=True)

        if args.frc_bitstream is not None:
            v = args.frc_bitstream
            codec = f"frc-v{v}"
            for q in frc_qs:
                fri = work / f"{name}_frcv{v}_q{q}.fri"
                png = work / f"{name}_frcv{v}_q{q}.png"
                size, ms = encode_frc(flora, src, fri, q, bitstream=v)
                decode_frc_to_png(flora, fri, png)
                dec = load_rgb_png(png)
                p = psnr_rgb(ref, dec)
                points.append(Point(codec, name, f"q={q}", size, p, ms))
                print(f"  FRCv{v}  q={q:2d}  {size:7d} B  PSNR {p:5.2f}  enc {ms:7.0f} ms", flush=True)

        for q in jpeg_qs if not args.skip_jpeg else []:
            jpg = work / f"{name}_jpg_q{q}.jpg"
            size, ms = encode_jpeg(ff, src, jpg, q)
            dec = decode_any_to_rgb(ff, jpg)
            p = psnr_rgb(ref, dec)
            points.append(Point("jpeg", name, f"q={q}", size, p, ms))
            print(f"  JPEG   q={q:2d}  {size:7d} B  PSNR {p:5.2f}  enc {ms:7.0f} ms", flush=True)

        if not args.skip_avif:
            for crf in avif_crfs:
                avif = work / f"{name}_avif_crf{crf}.avif"
                size, ms = encode_avif(ff, src, avif, crf, args.avif_cpu)
                dec = decode_any_to_rgb(ff, avif)
                p = psnr_rgb(ref, dec)
                points.append(Point("avif", name, f"crf={crf}", size, p, ms))
                print(f"  AVIF   crf={crf:2d} {size:7d} B  PSNR {p:5.2f}  enc {ms:7.0f} ms", flush=True)

        if not args.skip_jxl:
            for d in jxl_dists:
                jxl = work / f"{name}_jxl_d{d}.jxl"
                size, ms = encode_jxl(ff, src, jxl, d)
                dec = decode_any_to_rgb(ff, jxl)
                p = psnr_rgb(ref, dec)
                points.append(Point("jxl", name, f"d={d}", size, p, ms))
                print(f"  JXL    d={d:3.1f} {size:7d} B  PSNR {p:5.2f}  enc {ms:7.0f} ms", flush=True)

    # Summary at nearest PSNR to ~38 dB (typical mid quality)
    def pick_near(codec: str, target: float = 38.0) -> list[Point]:
        chosen = []
        by_img: dict[str, list[Point]] = {}
        for p in points:
            if p.codec == codec:
                by_img.setdefault(p.image, []).append(p)
        for img, ps in by_img.items():
            best = min(ps, key=lambda x: abs(x.psnr - target))
            chosen.append(best)
        return chosen

    extra_codec = f"frc-v{args.frc_bitstream}" if args.frc_bitstream is not None else None

    print("\n========== SNAPSHOT @ ~38 dB PSNR ==========", flush=True)
    snap = {}
    codec_list = ["frc-i", "jpeg", "avif", "jxl"]
    if extra_codec:
        codec_list.insert(1, extra_codec)
    for codec in codec_list:
        chosen = pick_near(codec, 38.0)
        if not chosen:
            continue
        total = sum(p.size for p in chosen)
        mean_psnr = sum(p.psnr for p in chosen) / len(chosen)
        mean_ms = sum(p.enc_ms for p in chosen) / len(chosen)
        snap[codec] = {"bytes": total, "mean_psnr": mean_psnr, "mean_enc_ms": mean_ms, "n": len(chosen)}
        print(
            f"{codec:6s}  sum={total:9d} B  mean PSNR={mean_psnr:5.2f}  mean enc={mean_ms:7.0f} ms  (n={len(chosen)})",
            flush=True,
        )

    print("\n========== BD-RATE (отрицательное = меньше битрейт = лучше) ==========", flush=True)
    bd_results = {}
    bd_pairs = [
        ("frc-i", "jpeg"),
        ("frc-i", "avif"),
        ("frc-i", "jxl"),
        ("avif", "jpeg"),
        ("jxl", "jpeg"),
        ("jxl", "avif"),
    ]
    if extra_codec:
        bd_pairs = [
            (extra_codec, "frc-i"),
            (extra_codec, "jpeg"),
            (extra_codec, "avif"),
            (extra_codec, "jxl"),
        ] + bd_pairs
    for test, ref in bd_pairs:
        if any(p.codec == test for p in points) and any(p.codec == ref for p in points):
            bd = aggregate_bd(points, test, ref)
            bd_results[f"{test}_vs_{ref}"] = bd
            mean = bd.get("mean", float("nan"))
            print(f"BD-Rate {test:5s} vs {ref:5s}: {mean:+7.1f}%  (n={bd.get('n', 0)})", flush=True)

    # Encode speed totals at mid knob
    print("\n========== ENCODE SPEED (mid quality point) ==========", flush=True)
    mid = {
        "frc-i": "q=70",
        "jpeg": "q=70",
        "avif": "crf=34",
        "jxl": "d=1.5",
    }
    if extra_codec:
        mid[extra_codec] = "q=70"
    for codec, knob in mid.items():
        subset = [p for p in points if p.codec == codec and p.knob == knob]
        if not subset:
            continue
        # Kodak is 768x512 = 0.393 MP
        mp = 768 * 512 / 1e6
        mean_ms = sum(p.enc_ms for p in subset) / len(subset)
        mps = mp / (mean_ms / 1000.0) if mean_ms > 0 else float("inf")
        print(f"{codec:6s} {knob:8s}  mean enc {mean_ms:7.0f} ms  → {mps:6.1f} Мп/с", flush=True)

    report = {
        "corpus": str(args.corpus),
        "n_images": len(images),
        "avif_cpu_used": args.avif_cpu,
        "points": [asdict(p) for p in points],
        "snapshot_38db": snap,
        "bd_rate": bd_results,
    }
    report_path = args.out / "report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\nJSON: {report_path}", flush=True)
    return 0


if __name__ == "__main__":
    # silence unused import warning for struct if any
    _ = struct
    raise SystemExit(main())
