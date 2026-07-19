#!/usr/bin/env python3
"""
Честный head-to-head FRC-I (текущий default / v8) vs JPEG XL.

Почему отдельный полигон, а не run_compete.py:
  1. PSNR BD-rate занижает JXL (он целится в butteraugli) и завышает кодеки
     с SSE/PSNR-ориентированным RD — опубликованное «−12.6% vs JXL» нельзя
     принимать за перцептивный итог.
  2. out-v8-final-full сравнивал только FRC v8↔v7; цифра vs JXL склеивалась
     с freeze-gate кривыми другого прогона.
  3. ffmpeg -c:v libjxl ≠ native cjxl (effort/буферизация/декод-путь).
  4. Нужны SSIMULACRA2 + butteraugli + iso-size срезы на одном сеансе.

Метрики на каждую точку:
  - size (bytes)
  - PSNR RGB, PSNR Y (BT.709 luma)
  - ffmpeg SSIM → dB (−10·log10(1−ssim))
  - SSIMULACRA2 (выше = лучше)
  - butteraugli pnorm (ниже = лучше; в BD-rate берём −ba)

JXL: native cjxl effort=7 (default) и effort=9 (near-best lossy).
FRC-I: flora-codec release, default bitstream (v8).

Пример:
  python Tools/frc-i-compete/run_honest_jxl.py \\
      --corpus Local/frc-i-compete/kodak --fetch-kodak \\
      --out Local/frc-i-compete/out-honest-jxl-v8 \\
      --jxl-efforts 7,9
"""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path

try:
    import numpy as np
except ImportError:
    print("нужен numpy: pip install numpy", file=sys.stderr)
    sys.exit(1)

# Reuse BD-rate + Kodak fetch from the existing harness.
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


@dataclass
class RichPoint:
    codec: str
    image: str
    knob: str
    size: int
    enc_ms: float
    psnr_rgb: float
    psnr_y: float
    ssim_db: float
    ssimulacra2: float
    butteraugli: float
    megapixels: float


def which_or_exit(name: str) -> str:
    p = shutil.which(name)
    if not p:
        raise SystemExit(f"{name} не найден в PATH")
    return p


def run(cmd: list[str], *, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(cmd, check=check, capture_output=True)


def psnr_y_bt709(ref: np.ndarray, dec: np.ndarray) -> float:
    """Luma PSNR after BT.709 RGB→Y (full-range 0..255)."""
    r = ref.astype(np.float64)
    d = dec.astype(np.float64)
    y_r = 0.2126 * r[..., 0] + 0.7152 * r[..., 1] + 0.0722 * r[..., 2]
    y_d = 0.2126 * d[..., 0] + 0.7152 * d[..., 1] + 0.0722 * d[..., 2]
    mse = float(np.mean((y_r - y_d) ** 2))
    if mse <= 1e-12:
        return 99.0
    return float(10.0 * math.log10((255.0 * 255.0) / mse))


def ssim_db(ffmpeg: str, distorted: Path, reference: Path) -> float:
    proc = run(
        [
            ffmpeg,
            "-hide_banner",
            "-i",
            str(distorted),
            "-i",
            str(reference),
            "-lavfi",
            "[0:v][1:v]ssim",
            "-f",
            "null",
            "-",
        ],
        check=False,
    )
    text = proc.stderr.decode("utf-8", "replace")
    match = re.search(r"All:([0-9.]+)", text)
    if proc.returncode != 0 or match is None:
        raise RuntimeError(f"SSIM failed for {distorted}:\n{text[-800:]}")
    value = float(match.group(1))
    return -10.0 * math.log10(max(1e-12, 1.0 - value))


def ssimulacra2_score(tool: str, reference: Path, distorted: Path) -> float:
    proc = run([tool, str(reference), str(distorted)], check=False)
    text = (proc.stdout + proc.stderr).decode("utf-8", "replace").strip()
    # Last floating token is the score.
    nums = re.findall(r"[-+]?\d*\.\d+|\d+", text)
    if proc.returncode != 0 or not nums:
        raise RuntimeError(f"ssimulacra2 failed:\n{text}")
    return float(nums[-1])


def butteraugli_score(tool: str, reference: Path, distorted: Path) -> float:
    proc = run([tool, str(reference), str(distorted)], check=False)
    text = (proc.stdout + proc.stderr).decode("utf-8", "replace")
    # Prefer 3-norm / pnorm line if present, else first float on last non-empty line.
    m = re.search(r"(?:3-norm|pnorm|PNorm)\s*[:=]?\s*([0-9.eE+-]+)", text, re.I)
    if m:
        return float(m.group(1))
    for line in reversed(text.splitlines()):
        line = line.strip()
        if not line:
            continue
        nums = re.findall(r"[-+]?\d*\.\d+(?:[eE][-+]?\d+)?|\d+(?:\.\d+)?", line)
        if nums:
            return float(nums[0])
    raise RuntimeError(f"butteraugli parse failed:\n{text[-800:]}")


def encode_frc(flora: str, src: Path, out: Path, quality: int) -> tuple[int, float]:
    t0 = time.perf_counter()
    run([flora, "image", "encode", str(src), str(out), "--quality", str(quality)])
    return out.stat().st_size, (time.perf_counter() - t0) * 1000.0


def decode_frc(flora: str, fri: Path, png: Path) -> None:
    run([flora, "image", "decode", str(fri), str(png)])


def encode_cjxl(
    cjxl: str, src: Path, out: Path, distance: float, effort: int
) -> tuple[int, float]:
    t0 = time.perf_counter()
    run(
        [
            cjxl,
            str(src),
            str(out),
            "--distance",
            str(distance),
            "--effort",
            str(effort),
            "--quiet",
        ]
    )
    return out.stat().st_size, (time.perf_counter() - t0) * 1000.0


def decode_djxl(djxl: str, jxl: Path, png: Path) -> None:
    run([djxl, str(jxl), str(png), "--quiet"], check=False)
    # djxl --quiet may still exit 0; ensure output exists.
    if not png.exists():
        run([djxl, str(jxl), str(png)])


def measure(
    ffmpeg: str,
    ssimu: str,
    ba: str,
    reference: Path,
    distorted_png: Path,
    ref_rgb: np.ndarray,
) -> tuple[float, float, float, float, float]:
    dec = load_rgb_png(distorted_png)
    pr = psnr_rgb(ref_rgb, dec)
    py = psnr_y_bt709(ref_rgb, dec)
    sd = ssim_db(ffmpeg, distorted_png, reference)
    s2 = ssimulacra2_score(ssimu, reference, distorted_png) if ssimu else float("nan")
    bav = butteraugli_score(ba, reference, distorted_png) if ba else float("nan")
    return pr, py, sd, s2, bav


def to_points(rich: list[RichPoint], metric: str) -> list[Point]:
    """Map a quality metric onto Point.psnr for BD-rate reuse (higher = better)."""
    out: list[Point] = []
    for r in rich:
        if metric == "psnr_rgb":
            q = r.psnr_rgb
        elif metric == "psnr_y":
            q = r.psnr_y
        elif metric == "ssim_db":
            q = r.ssim_db
        elif metric == "ssimulacra2":
            q = r.ssimulacra2
        elif metric == "neg_butteraugli":
            q = -r.butteraugli
        else:
            raise ValueError(metric)
        out.append(Point(r.codec, r.image, r.knob, r.size, q, r.enc_ms))
    return out


def iso_size_table(
    rich: list[RichPoint], test: str, ref: str, metric: str
) -> list[dict]:
    """
    For each test point, pick the ref point on the same image with closest size,
    report metric delta (positive = test better for higher-is-better metrics).
    """
    by: dict[str, dict[str, list[RichPoint]]] = {}
    for r in rich:
        by.setdefault(r.image, {}).setdefault(r.codec, []).append(r)
    rows = []
    for img, codecs in by.items():
        if test not in codecs or ref not in codecs:
            continue
        refs = codecs[ref]
        for t in codecs[test]:
            best = min(refs, key=lambda x: abs(x.size - t.size))
            size_err = (best.size - t.size) / max(1, t.size)
            if abs(size_err) > 0.12:
                # skip if no close size match within 12%
                continue
            if metric == "ssimulacra2":
                delta = t.ssimulacra2 - best.ssimulacra2
                tq, rq = t.ssimulacra2, best.ssimulacra2
            elif metric == "butteraugli":
                delta = best.butteraugli - t.butteraugli  # + = test lower BA = better
                tq, rq = t.butteraugli, best.butteraugli
            elif metric == "psnr_rgb":
                delta = t.psnr_rgb - best.psnr_rgb
                tq, rq = t.psnr_rgb, best.psnr_rgb
            else:
                raise ValueError(metric)
            rows.append(
                {
                    "image": img,
                    "test_knob": t.knob,
                    "ref_knob": best.knob,
                    "test_size": t.size,
                    "ref_size": best.size,
                    "size_rel_err": size_err,
                    "test_metric": tq,
                    "ref_metric": rq,
                    "delta": delta,
                }
            )
    return rows


def summarize_iso(rows: list[dict]) -> dict:
    if not rows:
        return {"n": 0, "mean_delta": float("nan")}
    deltas = [r["delta"] for r in rows]
    return {
        "n": len(rows),
        "mean_delta": float(sum(deltas) / len(deltas)),
        "median_delta": float(sorted(deltas)[len(deltas) // 2]),
        "wins": int(sum(1 for d in deltas if d > 0)),
        "losses": int(sum(1 for d in deltas if d < 0)),
        "ties": int(sum(1 for d in deltas if d == 0)),
    }


def fetch_webphotos(dest: Path) -> None:
    """
    Небольшой «реалистичный» корпус: 8 публичных фото ~1.5–3 Мп
    (Wikimedia Commons), ближе к web/social, чем Kodak 768×512.
    """
    import urllib.request

    dest.mkdir(parents=True, exist_ok=True)
    # Wikimedia requires a descriptive User-Agent (anonymous Python UA → 403).
    urls = [
        (
            "web01_berlin.jpg",
            "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4b/Berlin_fernsehturm_abend.jpg/1280px-Berlin_fernsehturm_abend.jpg",
        ),
        (
            "web02_cat.jpg",
            "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/1280px-Cat03.jpg",
        ),
        (
            "web03_forest.jpg",
            "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e5/Forest_near_Fridingen_an_der_Donau.jpg/1280px-Forest_near_Fridingen_an_der_Donau.jpg",
        ),
        (
            "web04_market.jpg",
            "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4e/Mercado_de_La_Boqueria_-_Barcelona.jpg/1280px-Mercado_de_La_Boqueria_-_Barcelona.jpg",
        ),
        (
            "web05_portrait.jpg",
            "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/Young_woman_smiling.jpg/960px-Young_woman_smiling.jpg",
        ),
        (
            "web06_food.jpg",
            "https://upload.wikimedia.org/wikipedia/commons/thumb/6/6d/Good_Food_Display_-_NCI_Visuals_Online.jpg/1280px-Good_Food_Display_-_NCI_Visuals_Online.jpg",
        ),
        (
            "web07_city.jpg",
            "https://upload.wikimedia.org/wikipedia/commons/thumb/d/d7/Tokyo_Tower_and_around_Skyscrapers.jpg/1280px-Tokyo_Tower_and_around_Skyscrapers.jpg",
        ),
        (
            "web08_night.jpg",
            "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e3/Hong_Kong_Night_Skyline.jpg/1280px-Hong_Kong_Night_Skyline.jpg",
        ),
    ]
    ff = find_ffmpeg()
    ua = "Flora.Ecosystem-frc-i-compete/1.0 (codec benchmark; local research)"
    for name, url in urls:
        stem = Path(name).stem
        png = dest / f"{stem}.png"
        if png.exists() and png.stat().st_size > 50_000:
            continue
        raw = dest / name
        print(f"fetch {url}", flush=True)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": ua})
            with urllib.request.urlopen(req, timeout=180) as r:
                raw.write_bytes(r.read())
        except Exception as e:
            print(f"  skip {name}: {e}", flush=True)
            continue
        run(
            [
                ff,
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(raw),
                str(png),
            ]
        )
        raw.unlink(missing_ok=True)


def fetch_picsum(dest: Path) -> None:
    """12 фото 1600×1067 (~1.7 Мп) с picsum.photos — ближе к web/social, чем Kodak."""
    import urllib.request

    dest.mkdir(parents=True, exist_ok=True)
    ids = [10, 11, 16, 17, 25, 28, 29, 48, 49, 65, 70, 76]
    ff = find_ffmpeg()
    ua = "Flora.Ecosystem-frc-i-compete/1.0 (codec benchmark; local research)"
    for i in ids:
        png = dest / f"pic{i:02d}.png"
        if png.exists() and png.stat().st_size > 50_000:
            continue
        url = f"https://picsum.photos/id/{i}/1600/1067"
        raw = dest / f"pic{i:02d}.jpg"
        print(f"fetch {url}", flush=True)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": ua})
            with urllib.request.urlopen(req, timeout=180) as r:
                raw.write_bytes(r.read())
        except Exception as e:
            print(f"  skip pic{i:02d}: {e}", flush=True)
            continue
        run(
            [
                ff,
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(raw),
                str(png),
            ]
        )
        raw.unlink(missing_ok=True)


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--flora-codec", default=None)
    ap.add_argument("--fetch-kodak", action="store_true")
    ap.add_argument("--fetch-webphotos", action="store_true", help="скачать 8 web-фото ~1–3 Мп (Wikimedia)")
    ap.add_argument(
        "--fetch-picsum",
        action="store_true",
        help="скачать 12 фото ~1.7 Мп с picsum.photos (стабильные id)",
    )
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument(
        "--jxl-efforts",
        default="7,9",
        help="список effort для cjxl (default: 7,9)",
    )
    ap.add_argument("--skip-butteraugli", action="store_true")
    ap.add_argument("--skip-ssimulacra2", action="store_true")
    args = ap.parse_args()

    if args.fetch_kodak:
        fetch_kodak(args.corpus)
    if args.fetch_webphotos:
        fetch_webphotos(args.corpus)
    if args.fetch_picsum:
        fetch_picsum(args.corpus)

    ff = find_ffmpeg()
    flora = find_flora_codec(args.flora_codec)
    cjxl = which_or_exit("cjxl")
    djxl = which_or_exit("djxl")
    ssimu = which_or_exit("ssimulacra2") if not args.skip_ssimulacra2 else ""
    ba = which_or_exit("butteraugli_main") if not args.skip_butteraugli else ""

    images = sorted(args.corpus.glob("*.png"))
    if args.limit:
        images = images[: args.limit]
    if not images:
        raise SystemExit(f"нет PNG в {args.corpus}")

    efforts = [int(x) for x in args.jxl_efforts.split(",") if x.strip()]
    # Include product defaults (posts q=75, avatars q=85) in the ladder.
    frc_qs = [30, 40, 50, 60, 70, 75, 80, 85, 90, 95]
    jxl_dists = [3.5, 2.5, 2.0, 1.5, 1.0, 0.7, 0.5]

    args.out.mkdir(parents=True, exist_ok=True)
    work = args.out / "work"
    work.mkdir(exist_ok=True)

    rich: list[RichPoint] = []
    print(f"корпус: {len(images)} PNG", flush=True)
    print(f"flora={flora}", flush=True)
    print(f"cjxl={cjxl}", flush=True)
    print(f"jxl efforts={efforts}  distances={jxl_dists}", flush=True)
    print(f"frc q={frc_qs}", flush=True)

    for src in images:
        name = src.stem
        print(f"\n=== {name} ===", flush=True)
        ref_rgb = load_rgb_png(src)
        mp = (ref_rgb.shape[1] * ref_rgb.shape[0]) / 1e6

        for q in frc_qs:
            fri = work / f"{name}_frc_q{q}.fri"
            png = work / f"{name}_frc_q{q}.png"
            size, ms = encode_frc(flora, src, fri, q)
            decode_frc(flora, fri, png)
            pr, py, sd, s2, bav = measure(
                ff, ssimu, ba, src, png, ref_rgb
            )
            rich.append(
                RichPoint("frc-i", name, f"q={q}", size, ms, pr, py, sd, s2, bav, mp)
            )
            print(
                f"  FRC-I  q={q:2d}  {size:7d} B  PSNR {pr:5.2f}  Y {py:5.2f}  "
                f"SSIM {sd:5.2f}  S2 {s2:6.2f}  BA {bav:6.3f}  enc {ms:7.0f} ms",
                flush=True,
            )

        for effort in efforts:
            codec = f"jxl-e{effort}"
            for d in jxl_dists:
                jxl = work / f"{name}_{codec}_d{d}.jxl"
                png = work / f"{name}_{codec}_d{d}.png"
                size, ms = encode_cjxl(cjxl, src, jxl, d, effort)
                decode_djxl(djxl, jxl, png)
                pr, py, sd, s2, bav = measure(
                    ff, ssimu, ba, src, png, ref_rgb
                )
                rich.append(
                    RichPoint(codec, name, f"d={d}", size, ms, pr, py, sd, s2, bav, mp)
                )
                print(
                    f"  {codec:7s} d={d:3.1f} {size:7d} B  PSNR {pr:5.2f}  Y {py:5.2f}  "
                    f"SSIM {sd:5.2f}  S2 {s2:6.2f}  BA {bav:6.3f}  enc {ms:7.0f} ms",
                    flush=True,
                )

    metrics = ["psnr_rgb", "psnr_y", "ssim_db"]
    if not args.skip_ssimulacra2:
        metrics.append("ssimulacra2")
    if not args.skip_butteraugli:
        metrics.append("neg_butteraugli")

    codecs = sorted({r.codec for r in rich})
    print("\n========== BD-RATE (отриц. = меньше битрейт при том же качестве = лучше) ==========", flush=True)
    bd_all: dict[str, dict] = {}
    for metric in metrics:
        pts = to_points(rich, metric)
        bd_all[metric] = {}
        print(f"\n--- metric: {metric} ---", flush=True)
        for effort in efforts:
            jxl_c = f"jxl-e{effort}"
            if jxl_c not in codecs:
                continue
            bd = aggregate_bd(pts, "frc-i", jxl_c)
            bd_all[metric][f"frc-i_vs_{jxl_c}"] = {
                k: v for k, v in bd.items() if k != "per_image"
            }
            bd_all[metric][f"frc-i_vs_{jxl_c}"]["per_image"] = bd.get("per_image", [])
            mean = bd.get("mean", float("nan"))
            med = bd.get("median", float("nan"))
            print(
                f"BD-Rate FRC-I vs {jxl_c}: mean {mean:+7.2f}%  median {med:+7.2f}%  (n={bd.get('n', 0)})",
                flush=True,
            )

    print("\n========== ISO-SIZE (ближайший размер ±12%, delta>0 = FRC лучше) ==========", flush=True)
    iso_all: dict[str, dict] = {}
    for effort in efforts:
        jxl_c = f"jxl-e{effort}"
        for metric in ("ssimulacra2", "butteraugli", "psnr_rgb"):
            if metric == "ssimulacra2" and args.skip_ssimulacra2:
                continue
            if metric == "butteraugli" and args.skip_butteraugli:
                continue
            rows = iso_size_table(rich, "frc-i", jxl_c, metric)
            summary = summarize_iso(rows)
            key = f"frc-i_vs_{jxl_c}_{metric}"
            iso_all[key] = {"summary": summary, "rows": rows}
            s = summary
            print(
                f"iso-size {metric:12s} vs {jxl_c}: meanΔ {s['mean_delta']:+.3f}  "
                f"med {s.get('median_delta', float('nan')):+.3f}  "
                f"W/L/T {s.get('wins',0)}/{s.get('losses',0)}/{s.get('ties',0)}  n={s['n']}",
                flush=True,
            )

    print("\n========== ENCODE SPEED (mid knob, Мп/с) ==========", flush=True)
    speed = {}
    for codec, knob in [("frc-i", "q=70")] + [(f"jxl-e{e}", "d=1.5") for e in efforts]:
        subset = [r for r in rich if r.codec == codec and r.knob == knob]
        if not subset:
            continue
        mean_ms = sum(r.enc_ms for r in subset) / len(subset)
        mean_mp = sum(r.megapixels for r in subset) / len(subset)
        mps = mean_mp / (mean_ms / 1000.0) if mean_ms > 0 else float("inf")
        speed[codec] = {"knob": knob, "mean_enc_ms": mean_ms, "mpx_s": mps, "n": len(subset)}
        print(f"{codec:8s} {knob:8s}  {mean_ms:7.0f} ms  → {mps:6.2f} Мп/с", flush=True)

    biases = [
        "PSNR/SSIM BD-rate: FRC RD ближе к SSE → может выглядеть лучше, чем на глаз.",
        "SSIMULACRA2/butteraugli: родная цель JXL; честнее для перцептивного сравнения.",
        "cjxl effort=9 — почти лучший lossy JXL; effort=7 — default / ffmpeg default.",
        "Декод: flora-codec / djxl → PNG, затем метрики (без ffmpeg-декода JXL).",
        "Корпус Kodak — устаревшие 768×512 film scans; webphotos ближе к product.",
        "Encode time включает spawn процесса (одинаково для всех).",
        "Iso-size: матч ±12% размера; при редкой лестнице часть точек отбрасывается.",
    ]

    report = {
        "methodology": {
            "frc": "flora-codec image encode default bitstream (v8)",
            "jxl": "native cjxl --distance --effort + djxl decode",
            "metrics": metrics,
            "frc_ladder": frc_qs,
            "jxl_distances": jxl_dists,
            "jxl_efforts": efforts,
            "biases": biases,
            "tools": {
                "flora": flora,
                "cjxl": cjxl,
                "djxl": djxl,
                "ffmpeg": ff,
                "ssimulacra2": ssimu or None,
                "butteraugli_main": ba or None,
            },
        },
        "corpus": str(args.corpus),
        "n_images": len(images),
        "points": [asdict(r) for r in rich],
        "bd_rate": bd_all,
        "iso_size": {k: v["summary"] for k, v in iso_all.items()},
        "iso_size_detail": iso_all,
        "encode_speed": speed,
    }
    report_path = args.out / "report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    # Human summary markdown
    md = ["# Honest FRC-I v8 vs JXL", "", "## BD-rate (mean %, negative = FRC smaller)", ""]
    md.append("| Metric | " + " | ".join(f"vs jxl-e{e}" for e in efforts) + " |")
    md.append("| --- |" + " ---: |" * len(efforts))
    for metric in metrics:
        cells = []
        for e in efforts:
            key = f"frc-i_vs_jxl-e{e}"
            cell = bd_all.get(metric, {}).get(key, {})
            mean = cell.get("mean", float("nan"))
            cells.append(f"{mean:+.1f}%" if mean == mean else "n/a")
        md.append(f"| {metric} | " + " | ".join(cells) + " |")
    md.append("")
    md.append("## Iso-size (mean delta, + = FRC better)")
    md.append("")
    for k, s in report["iso_size"].items():
        md.append(
            f"- `{k}`: meanΔ={s['mean_delta']:+.3f}, W/L={s.get('wins',0)}/{s.get('losses',0)}, n={s['n']}"
        )
    md.append("")
    md.append("## Biases")
    for b in biases:
        md.append(f"- {b}")
    (args.out / "SUMMARY.md").write_text("\n".join(md) + "\n", encoding="utf-8")

    print(f"\nJSON: {report_path}", flush=True)
    print(f"SUMMARY: {args.out / 'SUMMARY.md'}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
