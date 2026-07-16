#!/usr/bin/env python3
"""
Диагностический аудит принятого FRC-I v7 без изменения codec wire/API.

Для каждой точки quality скрипт:
- кодирует PNG через официальный `flora-codec --bitstream 7`;
- разбирает самоделимитированные DCT-секции и считает точные token/raw bytes
  отдельно для Y/Cb/Cr;
- декодирует поток и считает RGB и BT.601 Y/Cb/Cr distortion;
- пишет агрегаты и per-image точки в JSON.

Это аудит финального decoded RGB. Y/Cb/Cr distortion вычисляется повторным
BT.601-преобразованием decoded RGB и поэтому включает chroma upsampling,
deblock/CDEF и RGB clamp, а не только transform-domain ошибку кодера.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

from run_compete import (
    decode_frc_to_png,
    find_flora_codec,
    load_rgb_png,
    run,
)


MAGIC = b"\x8fFRI"
HEADER_LEN = 20
TILE = 256
FLAG_LOSSLESS = 0x01
FLAG_ALPHA = 0x02
FLAG_CHROMA420 = 0x04
FLAG_PALETTE = 0x10
FLAG_METADATA = 0x40
PLANE_NAMES = ("y", "cb", "cr")
RANGE_TOP = 1 << 24
RANGE_INIT = 0xFF00_0000
ADAPT_LIMIT = 1 << 13
CTX_BUCKETS = 4
CTX_SPLIT = 0
CTX_MODE = 1
CTX_DC_BASE = 2
CTX_RUN_BASE = 6
CTX_LEVEL_BASE = 30
CTX_EOB_BASE = 54
CTX_SPLIT32 = 78
CTX_SPLIT8 = 79
CTX_TX = 80
CTX_CDEF = 81
N_CTX = 82
N_POS_BUCKETS = 6


class RawBitReader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.pos = 0
        self.acc = 0
        self.nbits = 0
        self.bits_read = 0

    def read(self, nbits: int) -> int:
        while self.nbits < nbits:
            if self.pos >= len(self.data):
                raise ValueError("обрыв raw-bits")
            self.acc = (self.acc << 8) | self.data[self.pos]
            self.pos += 1
            self.nbits += 8
        self.nbits -= nbits
        self.bits_read += nbits
        if nbits == 0:
            return 0
        return (self.acc >> self.nbits) & ((1 << nbits) - 1)


class RangeDecoder:
    def __init__(self, data: bytes) -> None:
        if len(data) < 5 or data[0] != 0:
            raise ValueError("некорректная инициализация range stream")
        self.code = int.from_bytes(data[1:5], "big")
        self.range = RANGE_INIT
        self.r = 0
        self.data = data
        self.pos = 5

    def decode_freq(self, total: int) -> int:
        self.r = self.range // total
        return min(self.code // self.r, total - 1)

    def update(self, cumulative: int, frequency: int) -> None:
        self.code -= self.r * cumulative
        self.range = self.r * frequency
        while self.range < RANGE_TOP:
            if self.pos >= len(self.data):
                raise ValueError("обрыв range stream")
            self.code = ((self.code << 8) | self.data[self.pos]) & 0xFFFF_FFFF
            self.pos += 1
            self.range <<= 8


def alphabet(kind: str) -> int:
    return {
        "split": 2,
        "eob": 2,
        "mode": 15,
        "tx": 4,
        "cdef": 4,
        "dc": 32,
        "run": 22,
        "level": 32,
    }[kind]


def prior(kind: str) -> list[int]:
    n = alphabet(kind)
    if kind == "split":
        return [3, 2]
    if kind == "eob":
        return [1, 1]
    if kind == "mode":
        return [1] * n
    if kind == "tx":
        return [8, 2, 2, 1]
    if kind == "cdef":
        return [8, 3, 2, 1]
    if kind == "dc":
        return [max(16 - symbol // 2, 1) for symbol in range(n)]
    if kind == "run":
        return [
            32 if symbol == 0 else 16 if symbol == 1 else 8 if symbol == 2 else 4
            if symbol <= 7
            else 1
            for symbol in range(n)
        ]
    return [
        32 if symbol == 0 else 16 if symbol == 1 else 4 if symbol <= 3 else 1
        for symbol in range(n)
    ]


class AdaptiveModel:
    def __init__(self, kind: str) -> None:
        self.frequency = prior(kind)
        self.total = sum(self.frequency)
        self.updates = 0

    def clone(self) -> AdaptiveModel:
        clone = object.__new__(AdaptiveModel)
        clone.frequency = self.frequency.copy()
        clone.total = self.total
        clone.updates = self.updates
        return clone

    def adapt(self, symbol: int) -> None:
        if self.updates <= 15:
            increment = 256
        elif self.updates <= 63:
            increment = 128
        elif self.updates <= 255:
            increment = 64
        else:
            increment = 32
        self.updates += 1
        self.frequency[symbol] += increment
        self.total += increment
        if self.total >= ADAPT_LIMIT:
            self.frequency = [max(value >> 1, 1) for value in self.frequency]
            self.total = sum(self.frequency)

    def decode(self, decoder: RangeDecoder) -> tuple[int, float]:
        slot = decoder.decode_freq(self.total)
        cumulative = 0
        for symbol, frequency in enumerate(self.frequency):
            if cumulative + frequency > slot:
                cost = math.log2(self.total / frequency)
                decoder.update(cumulative, frequency)
                self.adapt(symbol)
                return symbol, cost
            cumulative += frequency
        raise ValueError("range symbol вне модели")

    def observe(self, symbol: int) -> float:
        frequency = self.frequency[symbol]
        cost = math.log2(self.total / frequency)
        self.adapt(symbol)
        return cost


def model_layout() -> tuple[list[int], list[str]]:
    groups = [0] * N_CTX
    kinds = ["level"] * N_CTX
    for context, group, kind in [
        (CTX_SPLIT, 0, "split"),
        (CTX_MODE, 1, "mode"),
        (CTX_SPLIT32, 0, "split"),
        (CTX_SPLIT8, 0, "split"),
        (CTX_TX, 21, "tx"),
        (CTX_CDEF, 22, "cdef"),
    ]:
        groups[context] = group
        kinds[context] = kind
    for dc_bucket in range(4):
        groups[CTX_DC_BASE + dc_bucket] = 2
        kinds[CTX_DC_BASE + dc_bucket] = "dc"
    for condition in range(4):
        for position in range(N_POS_BUCKETS):
            run = CTX_RUN_BASE + position + N_POS_BUCKETS * condition
            level = CTX_LEVEL_BASE + position + N_POS_BUCKETS * condition
            eob = CTX_EOB_BASE + position + N_POS_BUCKETS * condition
            groups[run], kinds[run] = 3 + position, "run"
            groups[level], kinds[level] = 3 + N_POS_BUCKETS + position, "level"
            groups[eob], kinds[eob] = 3 + 2 * N_POS_BUCKETS + position, "eob"
    return groups, kinds


class ModelBank:
    def __init__(
        self,
        layout: tuple[list[int], list[str]] | None = None,
    ) -> None:
        self.group_of, self.kind_of = layout or model_layout()
        parent_kinds = ["level"] * (max(self.group_of) + 1)
        for context, group in enumerate(self.group_of):
            parent_kinds[group] = self.kind_of[context]
        self.models = [
            AdaptiveModel(kind)
            for kind in self.kind_of
            for _ in range(CTX_BUCKETS)
        ]
        self.parents = [AdaptiveModel(kind) for kind in parent_kinds]
        self.previous = [0] * len(self.group_of)

    def prepare(self, context: int) -> tuple[AdaptiveModel, int, str]:
        kind = self.kind_of[context]
        bucket = min(self.previous[context] >> 3, CTX_BUCKETS - 1)
        if alphabet(kind) < 16:
            bucket = 0
        model_index = context * CTX_BUCKETS + bucket
        group = self.group_of[context]
        model = self.models[model_index]
        if model.updates == 0 and self.parents[group].updates > 0:
            model = self.parents[group].clone()
            model.updates = 0
            self.models[model_index] = model
        return model, group, kind

    def decode(
        self,
        decoder: RangeDecoder,
        context: int,
        entropy: dict[str, dict[str, float | int]],
    ) -> int:
        model, group, kind = self.prepare(context)
        symbol, cost = model.decode(decoder)
        self.parents[group].adapt(symbol)
        self.previous[context] = symbol
        entropy[kind]["symbols"] += 1
        entropy[kind]["ideal_bits"] += cost
        return symbol

    def observe(
        self,
        context: int,
        symbol: int,
        entropy: dict[str, dict[str, float | int]],
    ) -> None:
        model, group, kind = self.prepare(context)
        cost = model.observe(symbol)
        self.parents[group].adapt(symbol)
        self.previous[context] = symbol
        entropy[kind]["symbols"] += 1
        entropy[kind]["ideal_bits"] += cost


def conditioned_layout(copies: int) -> tuple[list[int], list[str]]:
    groups, kinds = model_layout()
    return groups * copies, kinds * copies


def empty_entropy() -> dict[str, dict[str, float | int]]:
    return {
        kind: {"symbols": 0, "ideal_bits": 0.0}
        for kind in ("split", "mode", "tx", "cdef", "dc", "run", "level", "eob")
    }


def detokenize(symbol: int, reader: RawBitReader) -> int:
    if symbol < 16:
        return symbol
    width = symbol - 16 + 5
    if width > 20:
        raise ValueError("hybrid-uint token вне диапазона")
    raw_bits = width - 1
    return (1 << raw_bits) + reader.read(raw_bits)


def tokenize_shape(value: int) -> tuple[int, int]:
    if value < 16:
        return value, 0
    width = value.bit_length()
    return 16 + width - 5, width - 1


class CoefficientSyntaxProbe:
    """Offline adaptive estimates for EOB/run alternatives."""

    def __init__(self) -> None:
        self.last_models: dict[tuple[int, int], AdaptiveModel] = {}
        self.forward_significance_models: dict[
            tuple[int, int, int], AdaptiveModel
        ] = {}
        self.reverse_significance_models: dict[
            tuple[int, int, int], AdaptiveModel
        ] = {}

    @staticmethod
    def observe_model(
        models: dict[tuple[int, ...], AdaptiveModel],
        key: tuple[int, ...],
        kind: str,
        symbol: int,
    ) -> float:
        model = models.get(key)
        if model is None:
            model = AdaptiveModel(kind)
            models[key] = model
        return model.observe(symbol)

    def observe(
        self,
        block_size: int,
        previous_nnz: int,
        positions: list[int],
        stats: dict[str, float | int],
    ) -> None:
        size_index = {4: 0, 8: 1, 16: 2, 32: 3}[block_size]
        last = positions[-1] if positions else 0
        last_symbol, last_raw_bits = tokenize_shape(last)
        stats["blocks"] += 1
        stats["last_symbol_bits"] += self.observe_model(
            self.last_models,
            (size_index, previous_nnz),
            "run",
            last_symbol,
        )
        stats["last_raw_bits"] += last_raw_bits

        if last <= 1:
            return
        position_set = set(positions)

        history = 0
        for position in range(1, last):
            significant = int(position in position_set)
            key = (
                position_bucket(block_size, position),
                previous_nnz,
                history,
            )
            stats["forward_significance_bits"] += self.observe_model(
                self.forward_significance_models,
                key,
                "eob",
                significant,
            )
            stats["significance_symbols"] += 1
            history = ((history << 1) | significant) & 0b11

        history = 0
        for position in range(last - 1, 0, -1):
            significant = int(position in position_set)
            key = (
                position_bucket(block_size, position),
                previous_nnz,
                history,
            )
            stats["reverse_significance_bits"] += self.observe_model(
                self.reverse_significance_models,
                key,
                "eob",
                significant,
            )
            history = ((history << 1) | significant) & 0b11


def unzigzag(value: int) -> int:
    return (value >> 1) ^ -(value & 1)


def pos_bucket8(position: int) -> int:
    if position == 1:
        return 0
    if position <= 3:
        return 1
    if position <= 7:
        return 2
    if position <= 15:
        return 3
    if position <= 31:
        return 4
    return 5


def position_bucket(block_size: int, position: int) -> int:
    if block_size == 4:
        return pos_bucket8(min(max(position << 2, 1), 63))
    if block_size == 16:
        return pos_bucket8(max(position >> 2, 1))
    if block_size == 32:
        return pos_bucket8(max(position >> 4, 1))
    return pos_bucket8(position)


def nnz_bucket(nonzero: int) -> int:
    if nonzero == 0:
        return 0
    if nonzero <= 3:
        return 1
    if nonzero <= 9:
        return 2
    return 3


def level_bucket(previous_magnitude: int) -> int:
    if previous_magnitude == 0:
        return 0
    if previous_magnitude == 1:
        return 1
    if previous_magnitude <= 3:
        return 2
    return 3


def empty_syntax_stats() -> dict[str, Any]:
    return {
        "cdef": [0, 0, 0, 0],
        "blocks": {"4": 0, "8": 0, "16": 0, "32": 0},
        "partitions": {
            "8": {"whole": 0, "split": 0},
            "16": {"whole": 0, "split": 0},
            "32": {"whole": 0, "split": 0},
        },
        "modes": [0] * 15,
        "transforms": [0] * 4,
        "dc_nonzero": 0,
        "dc_abs_sum": 0,
        "ac_nonzero": 0,
        "ac_abs_sum": 0,
        "ac_position_buckets": [0] * N_POS_BUCKETS,
        "eob_position_sum": 0,
        "raw_bits": {"dc": 0, "run": 0, "level_sign": 0},
        "coefficient_probe": {
            "blocks": 0,
            "last_symbol_bits": 0.0,
            "last_raw_bits": 0,
            "forward_significance_bits": 0.0,
            "reverse_significance_bits": 0.0,
            "significance_symbols": 0,
        },
        "entropy": empty_entropy(),
        "size_conditioned_entropy": empty_entropy(),
        "tx_conditioned_entropy": empty_entropy(),
        "size_tx_conditioned_entropy": empty_entropy(),
    }


class PlaneSyntaxDecoder:
    def __init__(
        self,
        bank: ModelBank,
        size_conditioned_bank: ModelBank,
        tx_conditioned_bank: ModelBank,
        size_tx_conditioned_bank: ModelBank,
        coefficient_probe: CoefficientSyntaxProbe,
        tokens: bytes,
        raw: bytes,
        width: int,
        height: int,
        stats: dict[str, Any],
    ) -> None:
        self.bank = bank
        self.size_conditioned_bank = size_conditioned_bank
        self.tx_conditioned_bank = tx_conditioned_bank
        self.size_tx_conditioned_bank = size_tx_conditioned_bank
        self.coefficient_probe = coefficient_probe
        self.range = RangeDecoder(tokens)
        self.raw = RawBitReader(raw)
        self.width = width
        self.height = height
        self.stats = stats
        self.previous_nnz = 0
        self.previous_dc = 0

    def symbol(
        self,
        context: int,
        block_size: int | None = None,
        transform: int | None = None,
    ) -> int:
        symbol = self.bank.decode(self.range, context, self.stats["entropy"])
        is_coefficient = (
            CTX_DC_BASE <= context < CTX_RUN_BASE
            or CTX_RUN_BASE <= context < CTX_LEVEL_BASE
            or CTX_LEVEL_BASE <= context < CTX_EOB_BASE
            or CTX_EOB_BASE <= context < CTX_SPLIT32
        )
        size_context = context
        tx_context = context
        size_tx_context = context
        if block_size is not None and is_coefficient:
            size_index = {4: 0, 8: 1, 16: 2, 32: 3}[block_size]
            size_context += size_index * N_CTX
            if transform is None:
                raise ValueError("coefficient context требует transform")
            tx_context += transform * N_CTX
            size_tx_context += (size_index * 4 + transform) * N_CTX
        self.size_conditioned_bank.observe(
            size_context,
            symbol,
            self.stats["size_conditioned_entropy"],
        )
        self.tx_conditioned_bank.observe(
            tx_context,
            symbol,
            self.stats["tx_conditioned_entropy"],
        )
        self.size_tx_conditioned_bank.observe(
            size_tx_context,
            symbol,
            self.stats["size_tx_conditioned_entropy"],
        )
        return symbol

    def decode_coefficients(self, block_size: int, transform: int) -> None:
        length = block_size * block_size
        self.stats["blocks"][str(block_size)] += 1
        before = self.raw.bits_read
        dc = unzigzag(
            detokenize(self.symbol(CTX_DC_BASE, block_size, transform), self.raw)
        )
        self.stats["raw_bits"]["dc"] += self.raw.bits_read - before
        self.previous_dc = abs(dc)
        if dc != 0:
            self.stats["dc_nonzero"] += 1
            self.stats["dc_abs_sum"] += abs(dc)

        nonzero = 0
        previous_magnitude = 0
        position = 1
        positions: list[int] = []
        while position < length:
            bucket = position_bucket(block_size, position)
            eob_context = CTX_EOB_BASE + bucket + N_POS_BUCKETS * self.previous_nnz
            if self.symbol(eob_context, block_size, transform) == 1:
                break
            run_context = CTX_RUN_BASE + bucket + N_POS_BUCKETS * self.previous_nnz
            before = self.raw.bits_read
            run = detokenize(self.symbol(run_context, block_size, transform), self.raw)
            self.stats["raw_bits"]["run"] += self.raw.bits_read - before
            position += run
            if position >= length:
                raise ValueError("AC run выходит за блок")
            level_context = (
                CTX_LEVEL_BASE
                + position_bucket(block_size, position)
                + N_POS_BUCKETS * level_bucket(previous_magnitude)
            )
            before = self.raw.bits_read
            magnitude = (
                detokenize(
                    self.symbol(level_context, block_size, transform),
                    self.raw,
                )
                + 1
            )
            self.raw.read(1)
            self.stats["raw_bits"]["level_sign"] += self.raw.bits_read - before
            previous_magnitude = magnitude
            nonzero += 1
            self.stats["ac_nonzero"] += 1
            self.stats["ac_abs_sum"] += magnitude
            positions.append(position)
            self.stats["ac_position_buckets"][
                position_bucket(block_size, position)
            ] += 1
            position += 1
        self.stats["eob_position_sum"] += position
        self.coefficient_probe.observe(
            block_size,
            self.previous_nnz,
            positions,
            self.stats["coefficient_probe"],
        )
        normalized = {
            4: nonzero * 4,
            8: nonzero,
            16: nonzero // 4,
            32: nonzero // 16,
        }[block_size]
        self.previous_nnz = nnz_bucket(normalized)

    def decode_leaf(self, block_size: int) -> None:
        mode = self.symbol(CTX_MODE)
        transform = self.symbol(CTX_TX)
        self.stats["modes"][mode] += 1
        self.stats["transforms"][transform] += 1
        self.decode_coefficients(block_size, transform)

    def decode_node8(self, block_x: int, block_y: int) -> None:
        split = self.symbol(CTX_SPLIT8)
        decision = "split" if split else "whole"
        self.stats["partitions"]["8"][decision] += 1
        if split == 0:
            self.decode_leaf(8)
            return
        for index in range(4):
            x = block_x * 2 + index % 2
            y = block_y * 2 + index // 2
            if x * 4 < self.width and y * 4 < self.height:
                self.decode_leaf(4)

    def decode_node16(self, block_x: int, block_y: int) -> None:
        split = self.symbol(CTX_SPLIT)
        decision = "split" if split else "whole"
        self.stats["partitions"]["16"][decision] += 1
        if split == 0:
            self.decode_leaf(16)
            return
        for index in range(4):
            x = block_x * 2 + index % 2
            y = block_y * 2 + index // 2
            if x * 8 < self.width and y * 8 < self.height:
                self.decode_node8(x, y)

    def decode(self) -> None:
        strength = self.symbol(CTX_CDEF)
        self.stats["cdef"][strength] += 1
        root_columns = math.ceil(self.width / 32)
        root_rows = math.ceil(self.height / 32)
        for root_y in range(root_rows):
            for root_x in range(root_columns):
                split = self.symbol(CTX_SPLIT32)
                decision = "split" if split else "whole"
                self.stats["partitions"]["32"][decision] += 1
                if split == 0:
                    self.decode_leaf(32)
                    continue
                for index in range(4):
                    x = root_x * 2 + index % 2
                    y = root_y * 2 + index // 2
                    if x * 16 < self.width and y * 16 < self.height:
                        self.decode_node16(x, y)
        if self.range.pos != len(self.range.data):
            raise ValueError("range stream потреблён не полностью")
        if self.raw.pos != len(self.raw.data):
            raise ValueError("raw stream потреблён не полностью")


def parse_qualities(value: str) -> list[int]:
    qualities = [int(item.strip()) for item in value.split(",") if item.strip()]
    if not qualities or any(not 1 <= quality <= 100 for quality in qualities):
        raise argparse.ArgumentTypeError("qualities должны быть списком значений 1..100")
    return qualities


def read_u32(data: bytes, offset: int) -> int:
    end = offset + 4
    if end > len(data):
        raise ValueError("обрыв u32")
    return struct.unpack_from("<I", data, offset)[0]


def parse_v7_plane_sections(data: bytes) -> dict[str, Any]:
    if len(data) < HEADER_LEN or data[:4] != MAGIC:
        raise ValueError("не FRC-I")
    version = data[4]
    flags = data[5]
    if version != 7:
        raise ValueError(f"ожидался bitstream v7, получен v{version}")
    if flags & (FLAG_LOSSLESS | FLAG_PALETTE):
        raise ValueError("кодер выбрал lossless/palette вместо lossy DCT")
    if flags & FLAG_METADATA:
        raise ValueError("metadata в diagnostic v7 не поддерживается")

    width = read_u32(data, 6)
    height = read_u32(data, 10)
    tile_columns = math.ceil(width / TILE)
    tile_count = tile_columns * math.ceil(height / TILE)
    table_end = HEADER_LEN + tile_count * 4
    if table_end > len(data):
        raise ValueError("обрыв таблицы длин тайлов")
    tile_lengths = [
        read_u32(data, HEADER_LEN + index * 4) for index in range(tile_count)
    ]

    planes = [
        {
            "section_bytes": 0,
            "token_bytes": 0,
            "raw_bytes": 0,
            "sections": 0,
            "syntax": empty_syntax_stats(),
        }
        for _ in PLANE_NAMES
    ]
    payload_offset = table_end
    alpha_bytes = 0
    for tile_index, tile_len in enumerate(tile_lengths):
        tile_end = payload_offset + tile_len
        if tile_end > len(data):
            raise ValueError("длина тайла выходит за конец файла")
        tile = data[payload_offset:tile_end]
        tile_x = (tile_index % tile_columns) * TILE
        tile_y = (tile_index // tile_columns) * TILE
        tile_width = min(TILE, width - tile_x)
        tile_height = min(TILE, height - tile_y)
        bank = ModelBank()
        size_conditioned_bank = ModelBank(conditioned_layout(4))
        tx_conditioned_bank = ModelBank(conditioned_layout(4))
        size_tx_conditioned_bank = ModelBank(conditioned_layout(16))
        coefficient_probe = CoefficientSyntaxProbe()
        pos = 0
        for plane_index, plane in enumerate(planes):
            if pos + 8 > len(tile):
                raise ValueError("обрыв заголовка DCT-секции")
            token_len, raw_len = struct.unpack_from("<II", tile, pos)
            section_len = 8 + token_len + raw_len
            if pos + section_len > len(tile):
                raise ValueError("DCT-секция выходит за границу тайла")
            token_start = pos + 8
            raw_start = token_start + token_len
            tokens = tile[token_start:raw_start]
            raw = tile[raw_start : raw_start + raw_len]
            if plane_index == 0 or not flags & FLAG_CHROMA420:
                plane_width, plane_height = tile_width, tile_height
            else:
                plane_width = math.ceil(tile_width / 2)
                plane_height = math.ceil(tile_height / 2)
            PlaneSyntaxDecoder(
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
            ).decode()
            plane["section_bytes"] += section_len
            plane["token_bytes"] += token_len
            plane["raw_bytes"] += raw_len
            plane["sections"] += 1
            pos += section_len
        if flags & FLAG_ALPHA:
            alpha_bytes += len(tile) - pos
        elif pos != len(tile):
            raise ValueError("лишние байты после Cr-секции")
        payload_offset = tile_end

    if payload_offset != len(data):
        raise ValueError("лишние байты после последнего тайла")
    return {
        "width": width,
        "height": height,
        "quality": data[15],
        "chroma420": bool(flags & FLAG_CHROMA420),
        "container_bytes": HEADER_LEN + tile_count * 4,
        "alpha_bytes": alpha_bytes,
        "planes": dict(zip(PLANE_NAMES, planes, strict=True)),
    }


def rgb_to_ycbcr(rgb: np.ndarray) -> np.ndarray:
    values = rgb.astype(np.int64)
    r, g, b = values[..., 0], values[..., 1], values[..., 2]
    half = 1 << 15
    y = (19_595 * r + 38_470 * g + 7_471 * b + half) >> 16
    cb = ((-11_059 * r - 21_709 * g + 32_768 * b + half) >> 16) + 128
    cr = ((32_768 * r - 27_439 * g - 5_329 * b + half) >> 16) + 128
    return np.stack(
        [np.clip(y, 0, 255), np.clip(cb, 0, 255), np.clip(cr, 0, 255)],
        axis=-1,
    )


def squared_error(reference: np.ndarray, decoded: np.ndarray) -> list[int]:
    delta = reference.astype(np.int64) - decoded.astype(np.int64)
    return [
        int(np.sum(delta[..., channel] * delta[..., channel], dtype=np.int64))
        for channel in range(delta.shape[-1])
    ]


def psnr_from_sse(sse: int, samples: int) -> float:
    if sse == 0:
        return 99.0
    mse = sse / samples
    return 10.0 * math.log10((255.0 * 255.0) / mse)


def encode_v7(
    flora: str,
    source: Path,
    output: Path,
    quality: int,
) -> float:
    started = time.perf_counter()
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
    return (time.perf_counter() - started) * 1000.0


def empty_aggregate(quality: int) -> dict[str, Any]:
    return {
        "quality": quality,
        "images": 0,
        "pixels": 0,
        "encoded_bytes": 0,
        "container_bytes": 0,
        "encode_ms": 0.0,
        "rgb_sse": [0, 0, 0],
        "ycbcr_sse": [0, 0, 0],
        "planes": {
            name: {
                "section_bytes": 0,
                "token_bytes": 0,
                "raw_bytes": 0,
                "sections": 0,
                "coded_samples": 0,
                "syntax": empty_syntax_stats(),
            }
            for name in PLANE_NAMES
        },
    }


def merge_syntax(target: dict[str, Any], source: dict[str, Any]) -> None:
    for key in ("cdef", "modes", "transforms", "ac_position_buckets"):
        for index, value in enumerate(source[key]):
            target[key][index] += value
    for key in ("blocks",):
        for name, value in source[key].items():
            target[key][name] += value
    for size, decisions in source["partitions"].items():
        for decision, value in decisions.items():
            target["partitions"][size][decision] += value
    for key in (
        "dc_nonzero",
        "dc_abs_sum",
        "ac_nonzero",
        "ac_abs_sum",
        "eob_position_sum",
    ):
        target[key] += source[key]
    for key, value in source["raw_bits"].items():
        target["raw_bits"][key] += value
    for key, value in source["coefficient_probe"].items():
        target["coefficient_probe"][key] += value
    for entropy_name in (
        "entropy",
        "size_conditioned_entropy",
        "tx_conditioned_entropy",
        "size_tx_conditioned_entropy",
    ):
        for kind, values in source[entropy_name].items():
            target[entropy_name][kind]["symbols"] += values["symbols"]
            target[entropy_name][kind]["ideal_bits"] += values["ideal_bits"]


def add_point(aggregate: dict[str, Any], point: dict[str, Any]) -> None:
    aggregate["images"] += 1
    aggregate["pixels"] += point["pixels"]
    aggregate["encoded_bytes"] += point["encoded_bytes"]
    aggregate["container_bytes"] += point["syntax"]["container_bytes"]
    aggregate["encode_ms"] += point["encode_ms"]
    for target, source in [
        (aggregate["rgb_sse"], point["rgb_sse"]),
        (aggregate["ycbcr_sse"], point["ycbcr_sse"]),
    ]:
        for index, value in enumerate(source):
            target[index] += value
    for name in PLANE_NAMES:
        target = aggregate["planes"][name]
        source = point["syntax"]["planes"][name]
        for key in ("section_bytes", "token_bytes", "raw_bytes", "sections"):
            target[key] += source[key]
        target["coded_samples"] += point["coded_samples"][name]
        merge_syntax(target["syntax"], source["syntax"])


def finalize_aggregate(aggregate: dict[str, Any]) -> None:
    pixels = aggregate["pixels"]
    encoded = aggregate["encoded_bytes"]
    aggregate["encode_mpps"] = (
        pixels / 1_000_000.0 / (aggregate["encode_ms"] / 1000.0)
    )
    aggregate["rgb_psnr"] = psnr_from_sse(sum(aggregate["rgb_sse"]), pixels * 3)
    aggregate["ycbcr_psnr"] = {
        name: psnr_from_sse(aggregate["ycbcr_sse"][index], pixels)
        for index, name in enumerate(PLANE_NAMES)
    }
    for name in PLANE_NAMES:
        plane = aggregate["planes"][name]
        plane["file_share"] = plane["section_bytes"] / encoded
        plane["bits_per_coded_sample"] = (
            plane["section_bytes"] * 8 / plane["coded_samples"]
        )
        syntax = plane["syntax"]
        block_areas = {
            size: count * int(size) ** 2 for size, count in syntax["blocks"].items()
        }
        total_block_area = sum(block_areas.values())
        syntax["block_area_share"] = {
            size: area / total_block_area for size, area in block_areas.items()
        }
        total_blocks = sum(syntax["blocks"].values())
        syntax["ac_nonzero_per_block"] = syntax["ac_nonzero"] / total_blocks
        syntax["mean_eob_fraction"] = syntax["eob_position_sum"] / total_block_area
        estimated_bits = {
            kind: values["ideal_bits"] for kind, values in syntax["entropy"].items()
        }
        estimated_bits["dc"] += syntax["raw_bits"]["dc"]
        estimated_bits["run"] += syntax["raw_bits"]["run"]
        estimated_bits["level"] += syntax["raw_bits"]["level_sign"]
        estimated_total = sum(estimated_bits.values())
        syntax["estimated_bits"] = estimated_bits
        syntax["estimated_bit_share"] = {
            kind: bits / estimated_total for kind, bits in estimated_bits.items()
        }
        probe = syntax["coefficient_probe"]
        last_bits = probe["last_symbol_bits"] + probe["last_raw_bits"]
        current_topology_bits = estimated_bits["run"] + estimated_bits["eob"]
        candidate_topologies = {
            "last_run": estimated_bits["run"] + last_bits,
            "last_forward_significance": (
                last_bits + probe["forward_significance_bits"]
            ),
            "last_reverse_significance": (
                last_bits + probe["reverse_significance_bits"]
            ),
        }
        syntax["coefficient_probe"]["current_run_eob_bits"] = (
            current_topology_bits
        )
        syntax["coefficient_probe"]["candidate_bits"] = candidate_topologies
        syntax["coefficient_probe"]["estimated_total_gain"] = {
            candidate: (current_topology_bits - bits) / estimated_total
            for candidate, bits in candidate_topologies.items()
        }
        for candidate in ("size", "tx", "size_tx"):
            candidate_bits = {
                kind: values["ideal_bits"]
                for kind, values in syntax[f"{candidate}_conditioned_entropy"].items()
            }
            candidate_bits["dc"] += syntax["raw_bits"]["dc"]
            candidate_bits["run"] += syntax["raw_bits"]["run"]
            candidate_bits["level"] += syntax["raw_bits"]["level_sign"]
            candidate_total = sum(candidate_bits.values())
            syntax[f"{candidate}_conditioned_estimated_bits"] = candidate_bits
            syntax[f"{candidate}_conditioned_estimated_gain"] = (
                1.0 - candidate_total / estimated_total
            )


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--flora-codec", default=None)
    parser.add_argument(
        "--qualities",
        type=parse_qualities,
        default=parse_qualities("30,40,50,60,70,80,85,90,95"),
    )
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    flora = find_flora_codec(args.flora_codec)
    images = sorted(args.corpus.glob("*.png"))
    if args.limit:
        images = images[: args.limit]
    if not images:
        raise SystemExit(f"нет PNG в {args.corpus}")

    args.out.mkdir(parents=True, exist_ok=True)
    work = args.out / "work"
    work.mkdir(exist_ok=True)
    points: list[dict[str, Any]] = []
    aggregates = {quality: empty_aggregate(quality) for quality in args.qualities}

    for source in images:
        reference_rgb = load_rgb_png(source)
        height, width, _ = reference_rgb.shape
        reference_ycbcr = rgb_to_ycbcr(reference_rgb)
        print(f"\n=== {source.stem} ===", flush=True)
        for quality in args.qualities:
            fri = work / f"{source.stem}_v7_q{quality}.fri"
            png = work / f"{source.stem}_v7_q{quality}.png"
            encode_ms = encode_v7(flora, source, fri, quality)
            decode_frc_to_png(flora, fri, png)
            decoded_rgb = load_rgb_png(png)
            syntax = parse_v7_plane_sections(fri.read_bytes())
            decoded_ycbcr = rgb_to_ycbcr(decoded_rgb)
            chroma_width = math.ceil(width / 2) if syntax["chroma420"] else width
            chroma_height = math.ceil(height / 2) if syntax["chroma420"] else height
            point = {
                "image": source.stem,
                "quality": quality,
                "pixels": width * height,
                "encoded_bytes": fri.stat().st_size,
                "encode_ms": encode_ms,
                "rgb_sse": squared_error(reference_rgb, decoded_rgb),
                "ycbcr_sse": squared_error(reference_ycbcr, decoded_ycbcr),
                "coded_samples": {
                    "y": width * height,
                    "cb": chroma_width * chroma_height,
                    "cr": chroma_width * chroma_height,
                },
                "syntax": syntax,
            }
            points.append(point)
            add_point(aggregates[quality], point)
            plane_bytes = "/".join(
                str(syntax["planes"][name]["section_bytes"]) for name in PLANE_NAMES
            )
            print(
                f"q={quality:2d} {point['encoded_bytes']:7d} B "
                f"Y/Cb/Cr={plane_bytes} enc={encode_ms:6.1f} ms",
                flush=True,
            )

    summary = []
    print("\nquality  total KiB  Y/Cb/Cr file share  Y/Cb/Cr PSNR  encode Mp/s")
    for quality in args.qualities:
        aggregate = aggregates[quality]
        finalize_aggregate(aggregate)
        summary.append(aggregate)
        shares = "/".join(
            f"{100 * aggregate['planes'][name]['file_share']:.1f}%"
            for name in PLANE_NAMES
        )
        psnrs = "/".join(
            f"{aggregate['ycbcr_psnr'][name]:.2f}" for name in PLANE_NAMES
        )
        print(
            f"q={quality:<2d} {aggregate['encoded_bytes'] / 1024:10.1f} "
            f"{shares:>20s} {psnrs:>18s} {aggregate['encode_mpps']:10.2f}",
            flush=True,
        )
    print(
        "\nquality  luma leaf-area 4/8/16/32  "
        "luma estimated bits split/mode/tx/dc/run/level/eob  "
        "context gain size/tx/both"
    )
    for aggregate in summary:
        syntax = aggregate["planes"]["y"]["syntax"]
        block_shares = "/".join(
            f"{100 * syntax['block_area_share'][size]:.1f}%"
            for size in ("4", "8", "16", "32")
        )
        bit_shares = "/".join(
            f"{100 * syntax['estimated_bit_share'][kind]:.1f}%"
            for kind in ("split", "mode", "tx", "dc", "run", "level", "eob")
        )
        print(
            f"q={aggregate['quality']:<2d} {block_shares:>27s} {bit_shares:>45s} "
            f"{100 * syntax['size_conditioned_estimated_gain']:+6.2f}%/"
            f"{100 * syntax['tx_conditioned_estimated_gain']:+6.2f}%/"
            f"{100 * syntax['size_tx_conditioned_estimated_gain']:+6.2f}%",
            flush=True,
        )

    print("\nquality  coefficient oracle gain: LAST+RUN / LAST+SIG forward / reverse")
    for aggregate in summary:
        gains = aggregate["planes"]["y"]["syntax"]["coefficient_probe"][
            "estimated_total_gain"
        ]
        print(
            f"q={aggregate['quality']:<2d} "
            f"{100 * gains['last_run']:+8.2f}% / "
            f"{100 * gains['last_forward_significance']:+8.2f}% / "
            f"{100 * gains['last_reverse_significance']:+8.2f}%",
            flush=True,
        )

    report = {
        "corpus": str(args.corpus),
        "n_images": len(images),
        "qualities": args.qualities,
        "points": points,
        "summary": summary,
    }
    report_path = args.out / "audit.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\nJSON: {report_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
