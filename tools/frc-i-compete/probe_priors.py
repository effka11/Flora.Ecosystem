#!/usr/bin/env python3
"""
Offline estimate: смена начальных приоров адаптивных моделей FRC-I v7+
(plan part 8a, "Этап 3"). Read-only; ни кодер, ни декодер не меняются.

Вопрос: сэкономит ли ретюнинг начального состояния (`prior(kind)` в
audit_v7.py / `arith.rs::prior`) хотя бы 1% закодированных бит? Ожидание
плана — нет: prior вымывается за первые символы контекста.

Метод
-----
1. Кодируем реальные корпуса `flora-codec --bitstream 7` (единственная
   версия, которую понимает `audit_v7.parse_v7_plane_sections`; см.
   `--help` вывод и заметку в отчёте о том, почему v11-по-умолчанию тут ни
   при чём).
2. Декодируем каждый поток **один раз** немодифицированным
   `audit_v7.ModelBank`/`RangeDecoder` (побитово точно — так же, как
   сделал бы настоящий декодер), но подклассом `PlaneSyntaxDecoder`,
   который попутно записывает точную последовательность
   `(context, symbol)` в порядке декодирования, отдельно по тайлам
   (тайл сбрасывает состояние моделей — TILE=256 в audit_v7.py).
   Этот шаг даёт бит-точный prior=текущий результат бесплатно (совпадает
   с `audit_v7.parse_v7_plane_sections`, что и есть validation, см. ниже).
3. Повторно проигрываем записанный trace через `ModelBank.observe()` —
   тот же самый offline-oracle приём, которым audit_v7.py уже считает
   `size_conditioned_entropy` и т.п., — но с альтернативными начальными
   частотными таблицами вместо `prior(kind)`. Это не симуляция: та же
   функция адаптации (`AdaptiveModel.adapt`, тот же `ADAPT_LIMIT`), тот же
   порядок символов, тот же сброс на границе тайла. Поскольку итоговый
   символ уже известен из шага 2 (независимо от того, каким было бы
   начальное состояние — это восстановленный decoder-side символ, а не
   вывод какой-то другой модели), подмена prior не требует повторного
   кодирования/декодирования битов.

Альтернативы (см. `--out/FINDINGS.md`):
  - `current`      — как в проде (`prior(kind)`), для sanity-check.
  - `per_kind`      — одна таблица на "вид" контекста (split/mode/tx/cdef/
    dc/run/level/eob), подогнанная под измеренное эмпирическое
    распределение символов этого вида, тот же суммарный вес счётчиков,
    что и у текущего prior (сравнима "форма", не "сила").
  - `per_context`   — отдельная таблица на каждый из 82 контекстов
    (практический потолок для *любого* фиксированного prior на уровне
    контекста, см. бриф).
  - `oracle_bits`   — не прогон модели, а аналитическая энтропия Шеннона
    пула символов контекста (или вида) на этом корпусе/качестве. Это
    строгая нижняя граница числа бит, которую не может побить НИКАКОЙ
    fixed-prior адаптивный кодер (адаптация и разогрев тайла только
    увеличивают стоимость относительно этого предела) — отсюда "upper
    bound на выигрыш от ретюнинга prior'ов" в отчёте.

Не трогает `tools/frc-i-compete/audit_v7.py` и никакой Rust; импортирует
только.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Callable

import audit_v7
from run_compete import find_flora_codec, run


class TracingPlaneDecoder(audit_v7.PlaneSyntaxDecoder):
    """`PlaneSyntaxDecoder`, но пишет (context, symbol) в общий trace тайла.

    Не переопределяет ничего, кроме `symbol()`: дерево блоков
    (`decode`, `decode_node16/8`, `decode_leaf`, `decode_coefficients`)
    наследуется без изменений, поэтому порядок и семантика декодирования
    побитово совпадают с `audit_v7.PlaneSyntaxDecoder`.
    """

    def __init__(self, *args: Any, trace: list[tuple[int, int]], **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.trace = trace

    def symbol(
        self,
        context: int,
        block_size: int | None = None,
        transform: int | None = None,
    ) -> int:
        value = super().symbol(context, block_size, transform)
        self.trace.append((context, value))
        return value


def parse_v7_with_trace(data: bytes) -> tuple[dict[str, Any], list[list[tuple[int, int]]]]:
    """Копия структуры цикла тайлов `audit_v7.parse_v7_plane_sections`,
    но с `TracingPlaneDecoder` вместо `PlaneSyntaxDecoder`, и попутно строит
    тот же самый `real_syntax`-словарь (planes/entropy/raw_bits), которым
    оперируют `real_*_bits_by_kind`. Один проход вместо двух — второй полный
    декод того же потока был бы избыточен (первый уже бит-точно
    воспроизводит настоящий декодер). Битовые/арифметические алгоритмы
    (RangeDecoder, RawBitReader, detokenize, position_bucket, ...) не
    переопределяются — используются как есть из audit_v7."""
    if len(data) < audit_v7.HEADER_LEN or data[:4] != audit_v7.MAGIC:
        raise ValueError("не FRC-I")
    version = data[4]
    flags = data[5]
    if version != 7:
        raise ValueError(f"ожидался bitstream v7, получен v{version}")
    if flags & (audit_v7.FLAG_LOSSLESS | audit_v7.FLAG_PALETTE):
        raise ValueError("кодер выбрал lossless/palette вместо lossy DCT")
    if flags & audit_v7.FLAG_METADATA:
        raise ValueError("metadata не поддерживается")

    width = audit_v7.read_u32(data, 6)
    height = audit_v7.read_u32(data, 10)
    tile_columns = math.ceil(width / audit_v7.TILE)
    tile_count = tile_columns * math.ceil(height / audit_v7.TILE)
    table_end = audit_v7.HEADER_LEN + tile_count * 4
    tile_lengths = [
        audit_v7.read_u32(data, audit_v7.HEADER_LEN + index * 4) for index in range(tile_count)
    ]

    planes = [
        {
            "section_bytes": 0,
            "token_bytes": 0,
            "raw_bytes": 0,
            "sections": 0,
            "syntax": audit_v7.empty_syntax_stats(),
        }
        for _ in audit_v7.PLANE_NAMES
    ]

    payload_offset = table_end
    traces: list[list[tuple[int, int]]] = []
    for tile_index, tile_len in enumerate(tile_lengths):
        tile_end = payload_offset + tile_len
        tile = data[payload_offset:tile_end]
        tile_x = (tile_index % tile_columns) * audit_v7.TILE
        tile_y = (tile_index // tile_columns) * audit_v7.TILE
        tile_width = min(audit_v7.TILE, width - tile_x)
        tile_height = min(audit_v7.TILE, height - tile_y)
        bank = audit_v7.ModelBank()
        size_conditioned_bank = audit_v7.ModelBank(audit_v7.conditioned_layout(4))
        tx_conditioned_bank = audit_v7.ModelBank(audit_v7.conditioned_layout(4))
        size_tx_conditioned_bank = audit_v7.ModelBank(audit_v7.conditioned_layout(16))
        coefficient_probe = audit_v7.CoefficientSyntaxProbe()
        tile_trace: list[tuple[int, int]] = []
        pos = 0
        for plane_index, plane in enumerate(planes):
            token_len, raw_len = struct.unpack_from("<II", tile, pos)
            section_len = 8 + token_len + raw_len
            token_start = pos + 8
            raw_start = token_start + token_len
            tokens = tile[token_start:raw_start]
            raw = tile[raw_start : raw_start + raw_len]
            if plane_index == 0 or not flags & audit_v7.FLAG_CHROMA420:
                plane_width, plane_height = tile_width, tile_height
            else:
                plane_width = math.ceil(tile_width / 2)
                plane_height = math.ceil(tile_height / 2)
            TracingPlaneDecoder(
                bank,
                size_conditioned_bank,
                tx_conditioned_bank,
                size_tx_conditioned_bank,
                coefficient_probe,
                tokens,
                raw,
                plane_width,
                plane_height,
                plane["syntax"],
                trace=tile_trace,
            ).decode()
            plane["section_bytes"] += section_len
            plane["token_bytes"] += token_len
            plane["raw_bytes"] += raw_len
            plane["sections"] += 1
            pos += section_len
        traces.append(tile_trace)
        payload_offset = tile_end

    if payload_offset != len(data):
        raise ValueError("лишние байты после последнего тайла")
    real_syntax = {
        "width": width,
        "height": height,
        "tile_count": tile_count,
        "planes": dict(zip(audit_v7.PLANE_NAMES, planes, strict=True)),
    }
    return real_syntax, traces


def encode_v7(flora: str, source: Path, output: Path, quality: int) -> None:
    run(
        [
            flora,
            "image",
            "encode",
            str(source),
            str(output),
            "--quality",
            str(quality),
            "--bitstream",
            "7",
        ]
    )


STRONG_PRIOR_TOTAL = audit_v7.ADAPT_LIMIT // 4  # 2048: ~30-50x текущего веса,
# но всё ещё ниже ADAPT_LIMIT=8192 (после первого halving ведёт себя как
# обычная адаптивная модель) -- самый "сильный" разумный fixed prior.


def scaled_freq(counter: Counter[int], kind: str, target_total: int | None = None) -> list[int]:
    """Эмпирическая таблица частот заданного суммарного веса ("силы").
    `target_total=None` -> тот же вес, что у текущего prior(kind) (меняем
    только "форму", § "Сила/форма" плана); `target_total=STRONG_PRIOR_TOTAL`
    -> самый настойчивый ("сильный") fixed prior, который остаётся
    осмысленным (не ломает ADAPT_LIMIT-полуделение)."""
    n = audit_v7.alphabet(kind)
    original = audit_v7.prior(kind)
    if target_total is None:
        target_total = sum(original)
    counts = [counter.get(symbol, 0) for symbol in range(n)]
    total_count = sum(counts)
    if total_count == 0:
        return list(original)
    smoothed = [c + 0.5 for c in counts]
    s = sum(smoothed)
    freq = [max(1, round(target_total * value / s)) for value in smoothed]
    return freq


def shannon_bits(counter: Counter[int], n: int) -> float:
    """Суммарная информационно-теоретическая нижняя граница (бит) для всех
    вхождений контекста по его собственному эмпирическому распределению —
    предел, который не может побить НИКАКОЙ fixed-prior адаптивный кодер."""
    total = sum(counter.values())
    if total == 0:
        return 0.0
    bits = 0.0
    for symbol in range(n):
        count = counter.get(symbol, 0)
        if count == 0:
            continue
        p = count / total
        bits += count * -math.log2(p)
    return bits


def model_from_freq(kind: str, freq: list[int]) -> audit_v7.AdaptiveModel:
    model = audit_v7.AdaptiveModel(kind)
    model.frequency = list(freq)
    model.total = sum(model.frequency)
    model.updates = 0
    return model


def make_variant_bank_factory(
    own_prior: Callable[[int, str], list[int]],
    parent_prior: Callable[[int, str], list[int]],
) -> Callable[[], audit_v7.ModelBank]:
    group_of, kind_of = audit_v7.model_layout()
    parent_kinds = ["level"] * (max(group_of) + 1)
    for context, group in enumerate(group_of):
        parent_kinds[group] = kind_of[context]

    def factory() -> audit_v7.ModelBank:
        bank = audit_v7.ModelBank.__new__(audit_v7.ModelBank)
        bank.group_of = group_of
        bank.kind_of = kind_of
        bank.models = []
        for context, kind in enumerate(kind_of):
            freq = own_prior(context, kind)
            for _ in range(audit_v7.CTX_BUCKETS):
                bank.models.append(model_from_freq(kind, freq))
        bank.parents = [
            model_from_freq(parent_kinds[group], parent_prior(group, parent_kinds[group]))
            for group in range(len(parent_kinds))
        ]
        bank.previous = [0] * len(group_of)
        return bank

    return factory


def replay_per_context(
    traces: list[list[tuple[int, int]]],
    bank_factory: Callable[[], audit_v7.ModelBank],
) -> tuple[dict[int, float], dict[int, int]]:
    """Проигрывает записанный (context, symbol) trace через `bank_factory()`
    (свежий банк на каждый тайл — модели тайла сбрасываются), считая
    ideal_bits отдельно на каждый context id (не только на "вид" — нужно
    для per_context oracle/variant разбивки)."""
    bits_by_context: dict[int, float] = defaultdict(float)
    symbols_by_context: dict[int, int] = defaultdict(int)
    for tile_trace in traces:
        bank = bank_factory()
        for context, symbol in tile_trace:
            model, group, _kind = bank.prepare(context)
            cost = model.observe(symbol)
            bank.parents[group].adapt(symbol)
            bank.previous[context] = symbol
            bits_by_context[context] += cost
            symbols_by_context[context] += 1
    return bits_by_context, symbols_by_context


def collect_corpus(
    flora: str,
    corpus_dir: Path,
    qualities: list[int],
    work_dir: Path,
    limit: int,
) -> dict[int, list[tuple[str, dict[str, Any], list[list[tuple[int, int]]], int]]]:
    """encode+decode-with-trace каждое изображение на каждом quality.
    Возвращает {quality: [(image_stem, real_syntax, traces, encoded_bytes), ...]}."""
    images = sorted(corpus_dir.glob("*.png"))
    if limit:
        images = images[:limit]
    if not images:
        raise SystemExit(f"нет PNG в {corpus_dir}")
    work_dir.mkdir(parents=True, exist_ok=True)
    by_quality: dict[int, list[tuple[str, dict[str, Any], list[list[tuple[int, int]]], int]]] = {
        quality: [] for quality in qualities
    }
    validated_once = False
    for source in images:
        for quality in qualities:
            fri = work_dir / f"{source.stem}_q{quality}.fri"
            t0 = time.perf_counter()
            encode_v7(flora, source, fri, quality)
            data = fri.read_bytes()
            real_syntax, traces = parse_v7_with_trace(data)
            if not validated_once:
                # Один раз перепроверяем наш single-pass разбор против
                # немодифицированного audit_v7.parse_v7_plane_sections —
                # оба должны дать одинаковый ideal_bits (см. FINDINGS.md).
                reference = audit_v7.parse_v7_plane_sections(data)
                for name in audit_v7.PLANE_NAMES:
                    ours = real_syntax["planes"][name]["syntax"]["entropy"]
                    theirs = reference["planes"][name]["syntax"]["entropy"]
                    for kind in ours:
                        assert ours[kind]["symbols"] == theirs[kind]["symbols"]
                        assert abs(ours[kind]["ideal_bits"] - theirs[kind]["ideal_bits"]) < 1e-6
                validated_once = True
            elapsed = time.perf_counter() - t0
            print(
                f"  {source.stem:>10s} q={quality:2d} "
                f"{len(data):7d} B  tiles={len(traces):3d}  {elapsed:5.2f}s",
                flush=True,
            )
            by_quality[quality].append((source.stem, real_syntax, traces, len(data)))
    return by_quality


def real_ideal_bits_by_kind(real_syntax: dict[str, Any]) -> dict[str, float]:
    """Чистый арифметический ideal_bits (без raw-бит), суммарно по Y/Cb/Cr —
    используется только для валидации trace-replay против настоящего декодера."""
    bits = {kind: 0.0 for kind in audit_v7.empty_entropy()}
    for name in audit_v7.PLANE_NAMES:
        entropy = real_syntax["planes"][name]["syntax"]["entropy"]
        for kind, values in entropy.items():
            bits[kind] += values["ideal_bits"]
    return bits


def real_estimated_bits_by_kind(real_syntax: dict[str, Any]) -> dict[str, float]:
    """`estimated_bits` в терминах audit_v7/`finalize_aggregate`: ideal_bits
    арифметической части + raw-биты (dc magnitude, run/level hybrid-uint raw,
    level sign), суммарно по Y/Cb/Cr. Это "estimated bits" из FRC-I.md §11.3,
    а НЕ размер файла (см. traps #3 в брифе)."""
    bits = real_ideal_bits_by_kind(real_syntax)
    for name in audit_v7.PLANE_NAMES:
        raw = real_syntax["planes"][name]["syntax"]["raw_bits"]
        bits["dc"] += raw["dc"]
        bits["run"] += raw["run"]
        bits["level"] += raw["level_sign"]
    return bits


def build_family_histograms(
    context_hist: dict[int, Counter[int]],
    group_of: list[int],
    kind_of: list[str],
) -> tuple[dict[str, Counter[int]], dict[int, Counter[int]]]:
    kind_hist: dict[str, Counter[int]] = defaultdict(Counter)
    group_hist: dict[int, Counter[int]] = defaultdict(Counter)
    for context, counter in context_hist.items():
        kind = kind_of[context]
        kind_hist[kind].update(counter)
        group_hist[group_of[context]].update(counter)
    return kind_hist, group_hist


FAMILIES = ("split", "mode", "tx", "cdef", "dc", "run", "level", "eob")


def to_kind_totals(
    bits_by_context: dict[int, float], kind_of: list[str]
) -> dict[str, float]:
    out: dict[str, float] = defaultdict(float)
    for context, bits in bits_by_context.items():
        out[kind_of[context]] += bits
    return out


def run_corpus(
    corpus_name: str,
    corpus_dir: Path,
    qualities: list[int],
    flora: str,
    work_root: Path,
    limit: int,
) -> dict[str, Any]:
    print(f"\n=== corpus: {corpus_name} ({corpus_dir}) ===", flush=True)
    group_of, kind_of = audit_v7.model_layout()
    by_quality = collect_corpus(flora, corpus_dir, qualities, work_root / corpus_name, limit)

    context_hist_pooled: dict[int, Counter[int]] = defaultdict(Counter)
    context_hist_by_quality: dict[int, dict[int, Counter[int]]] = {}
    # 2-fold split по чётности индекса изображения (стабильный порядок из
    # collect_corpus) -- нужен для held-out проверки "strong"/per_context:
    # приор строится на одной половине картинок, стоимость считается на
    # другой, чтобы отличить реальный эффект от переобучения на маленьком
    # корпусе (см. FINDINGS.md "held-out").
    context_hist_fold: dict[int, dict[int, Counter[int]]] = {
        0: defaultdict(Counter),
        1: defaultdict(Counter),
    }
    for quality, entries in by_quality.items():
        local_hist: dict[int, Counter[int]] = defaultdict(Counter)
        for image_index, (_stem, _real, traces, _bytes) in enumerate(entries):
            fold = image_index % 2
            for tile_trace in traces:
                for context, symbol in tile_trace:
                    local_hist[context][symbol] += 1
                    context_hist_pooled[context][symbol] += 1
                    context_hist_fold[fold][context][symbol] += 1
        context_hist_by_quality[quality] = local_hist

    kind_hist_pooled, group_hist_pooled = build_family_histograms(
        context_hist_pooled, group_of, kind_of
    )
    group_hist_fold = {}
    for fold in (0, 1):
        _kind_fold, group_hist_fold[fold] = build_family_histograms(
            context_hist_fold[fold], group_of, kind_of
        )

    def fold_factory(fold: int, target_total: int | None) -> Callable[[], audit_v7.ModelBank]:
        ctx_hist = context_hist_fold[fold]
        grp_hist = group_hist_fold[fold]
        return make_variant_bank_factory(
            lambda c, k: scaled_freq(ctx_hist.get(c, Counter()), k, target_total),
            lambda g, k: scaled_freq(grp_hist.get(g, Counter()), k, target_total),
        )

    current_factory = make_variant_bank_factory(
        lambda c, k: audit_v7.prior(k),
        lambda g, k: audit_v7.prior(k),
    )
    per_kind_factory = make_variant_bank_factory(
        lambda c, k: scaled_freq(kind_hist_pooled.get(k, Counter()), k),
        lambda g, k: scaled_freq(kind_hist_pooled.get(k, Counter()), k),
    )
    per_context_factory = make_variant_bank_factory(
        lambda c, k: scaled_freq(context_hist_pooled.get(c, Counter()), k),
        lambda g, k: scaled_freq(group_hist_pooled.get(g, Counter()), k),
    )
    strong_context_factory = make_variant_bank_factory(
        lambda c, k: scaled_freq(context_hist_pooled.get(c, Counter()), k, STRONG_PRIOR_TOTAL),
        lambda g, k: scaled_freq(group_hist_pooled.get(g, Counter()), k, STRONG_PRIOR_TOTAL),
    )

    corpus_report: dict[str, Any] = {
        "n_images": len(next(iter(by_quality.values()))) if by_quality else 0,
        "qualities": {},
    }

    for quality, entries in by_quality.items():
        traces_all = [t for _s, _r, traces, _b in entries for t in traces]
        traces_by_fold: dict[int, list[list[tuple[int, int]]]] = {0: [], 1: []}
        for image_index, (_s, _r, traces, _b) in enumerate(entries):
            traces_by_fold[image_index % 2].extend(traces)
        real_estimated_by_kind: dict[str, float] = defaultdict(float)
        real_ideal_by_kind: dict[str, float] = defaultdict(float)
        total_file_bytes = 0
        total_pixels = 0
        total_tiles = 0
        for _stem, real_syntax, traces, encoded_bytes in entries:
            est = real_estimated_bits_by_kind(real_syntax)
            ideal = real_ideal_bits_by_kind(real_syntax)
            for kind in FAMILIES:
                real_estimated_by_kind[kind] += est[kind]
                real_ideal_by_kind[kind] += ideal[kind]
            total_file_bytes += encoded_bytes
            total_pixels += real_syntax["width"] * real_syntax["height"]
            total_tiles += len(traces)

        base_bits_ctx, _base_syms = replay_per_context(traces_all, current_factory)
        kind_bits_ctx, _ks = replay_per_context(traces_all, per_kind_factory)
        ctx_bits_ctx, _cs = replay_per_context(traces_all, per_context_factory)
        strong_bits_ctx, _ss = replay_per_context(traces_all, strong_context_factory)

        base_by_kind = to_kind_totals(base_bits_ctx, kind_of)
        per_kind_by_kind = to_kind_totals(kind_bits_ctx, kind_of)
        per_context_by_kind = to_kind_totals(ctx_bits_ctx, kind_of)
        strong_by_kind = to_kind_totals(strong_bits_ctx, kind_of)

        # held-out: приор строится на fold X, стоимость -- на fold (1-X);
        # обе половины суммируются, denominator (current_total_estimated)
        # тот же, что и у in-sample вариантов (те же traces_all в сумме).
        holdout_context_by_kind: dict[str, float] = defaultdict(float)
        holdout_strong_by_kind: dict[str, float] = defaultdict(float)
        for train_fold, eval_fold in ((0, 1), (1, 0)):
            eval_traces = traces_by_fold[eval_fold]
            ctx_bits, _ = replay_per_context(eval_traces, fold_factory(train_fold, None))
            strong_bits, _ = replay_per_context(
                eval_traces, fold_factory(train_fold, STRONG_PRIOR_TOTAL)
            )
            for kind, bits in to_kind_totals(ctx_bits, kind_of).items():
                holdout_context_by_kind[kind] += bits
            for kind, bits in to_kind_totals(strong_bits, kind_of).items():
                holdout_strong_by_kind[kind] += bits

        local_hist = context_hist_by_quality[quality]
        oracle_by_context = {
            context: shannon_bits(counter, audit_v7.alphabet(kind_of[context]))
            for context, counter in local_hist.items()
        }
        oracle_by_kind = to_kind_totals(oracle_by_context, kind_of)

        current_total_estimated = sum(real_estimated_by_kind[k] for k in FAMILIES)

        validation = {
            "max_relative_diff": max(
                (
                    abs(base_by_kind.get(k, 0.0) - real_ideal_by_kind[k])
                    / real_ideal_by_kind[k]
                    for k in FAMILIES
                    if real_ideal_by_kind[k] > 0
                ),
                default=0.0,
            )
        }

        variants: dict[str, Any] = {}
        for variant_name, variant_by_kind in (
            ("per_kind", per_kind_by_kind),
            ("per_context", per_context_by_kind),
            ("strong_per_context", strong_by_kind),
            ("per_context_holdout", holdout_context_by_kind),
            ("strong_per_context_holdout", holdout_strong_by_kind),
            ("oracle", oracle_by_kind),
        ):
            per_family: dict[str, Any] = {}
            total_delta = 0.0
            for kind in FAMILIES:
                current_ideal = base_by_kind.get(kind, 0.0)
                variant_ideal = variant_by_kind.get(kind, 0.0)
                delta = current_ideal - variant_ideal
                total_delta += delta
                per_family[kind] = {
                    "current_ideal_bits": current_ideal,
                    "variant_ideal_bits": variant_ideal,
                    "delta_bits": delta,
                    "delta_pct_of_total_estimated": (
                        100.0 * delta / current_total_estimated
                        if current_total_estimated
                        else 0.0
                    ),
                }
            variants[variant_name] = {
                "per_family": per_family,
                "total_delta_bits": total_delta,
                "total_delta_pct_of_estimated": (
                    100.0 * total_delta / current_total_estimated
                    if current_total_estimated
                    else 0.0
                ),
                "total_delta_pct_of_file_bytes": (
                    100.0 * total_delta / (total_file_bytes * 8)
                    if total_file_bytes
                    else 0.0
                ),
            }

        corpus_report["qualities"][quality] = {
            "images": len(entries),
            "total_pixels": total_pixels,
            "total_tiles": total_tiles,
            "total_file_bytes": total_file_bytes,
            "total_estimated_bits": current_total_estimated,
            "real_estimated_bits_by_family": dict(real_estimated_by_kind),
            "validation": validation,
            "variants": variants,
        }

        print(
            f"  q={quality:2d}  file={total_file_bytes/1024:8.1f} KiB  "
            f"est={current_total_estimated/8/1024:8.1f} KiB  "
            f"tiles={total_tiles:4d}  validate(max rel diff)={validation['max_relative_diff']:.2e}",
            flush=True,
        )
        for variant_name in (
            "per_kind",
            "per_context",
            "strong_per_context",
            "per_context_holdout",
            "strong_per_context_holdout",
            "oracle",
        ):
            v = variants[variant_name]
            print(
                f"    {variant_name:26s} Δ={v['total_delta_bits']/8:9.1f} B "
                f"({v['total_delta_pct_of_estimated']:+6.3f}% of estimated, "
                f"{v['total_delta_pct_of_file_bytes']:+6.3f}% of file bytes)",
                flush=True,
            )

    return corpus_report


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("local/frc-i-compete"))
    parser.add_argument("--out", type=Path, default=Path("local/frc-i-compete/priors"))
    parser.add_argument("--flora-codec", default=None)
    parser.add_argument("--qualities", default="30,50,70,90")
    parser.add_argument("--limit-kodak", type=int, default=0)
    parser.add_argument("--limit-picsum", type=int, default=0)
    args = parser.parse_args()

    qualities = [int(value) for value in args.qualities.split(",") if value.strip()]
    flora = find_flora_codec(args.flora_codec)
    args.out.mkdir(parents=True, exist_ok=True)
    work_root = args.out / "work"

    report: dict[str, Any] = {
        "flora_codec": flora,
        "qualities": qualities,
        "corpora": {},
    }

    corpora = {
        "kodak": (args.root / "kodak", args.limit_kodak),
        "picsum": (args.root / "picsum", args.limit_picsum),
    }
    for corpus_name, (corpus_dir, limit) in corpora.items():
        report["corpora"][corpus_name] = run_corpus(
            corpus_name, corpus_dir, qualities, flora, work_root, limit
        )

    report_path = args.out / "priors_report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\nJSON: {report_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
