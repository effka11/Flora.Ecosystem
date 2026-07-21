/**
 * Детерминированная байтовая сериализация FEP (FEP.md §9.3) — зеркало
 * `flora-economy-crypto::canonical::CanonicalWriter`.
 *
 * Консенсусные байты (входы хешей и подписей): целые — big-endian фиксированной ширины;
 * байтовые срезы — `u32`-длина + байты; списки — `u32`-количество + элементы; варианты
 * enum — ведущий `u8`-тег. Один вход → один байтовый образ на любой платформе, поэтому
 * хеши клиента совпадают с сервером бит-в-бит.
 */

import { EconomyCodecError } from "./encoding.js";

const U64_MAX = 2n ** 64n - 1n;
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

function asBigInt(value: bigint | number, what: string): bigint {
  if (typeof value === "bigint") return value;
  if (!Number.isSafeInteger(value)) {
    throw new EconomyCodecError(`${what}: не целое или вне безопасного диапазона JS`);
  }
  return BigInt(value);
}

/** Аккумулятор канонических байт. */
export class CanonicalWriter {
  private chunks: Uint8Array[] = [];
  private length = 0;

  private push(bytes: Uint8Array): this {
    this.chunks.push(bytes);
    this.length += bytes.length;
    return this;
  }

  u8(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new EconomyCodecError(`u8 вне диапазона: ${value}`);
    }
    return this.push(Uint8Array.of(value));
  }

  u16(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw new EconomyCodecError(`u16 вне диапазона: ${value}`);
    }
    return this.push(Uint8Array.of((value >> 8) & 0xff, value & 0xff));
  }

  u32(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new EconomyCodecError(`u32 вне диапазона: ${value}`);
    }
    return this.push(
      Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff),
    );
  }

  u64(value: bigint | number): this {
    const v = asBigInt(value, "u64");
    if (v < 0n || v > U64_MAX) {
      throw new EconomyCodecError(`u64 вне диапазона: ${v}`);
    }
    return this.pushBigUint64(v);
  }

  i64(value: bigint | number): this {
    const v = asBigInt(value, "i64");
    if (v < I64_MIN || v > I64_MAX) {
      throw new EconomyCodecError(`i64 вне диапазона: ${v}`);
    }
    // Дополнительный код (two's complement) — как `to_be_bytes` в Rust.
    return this.pushBigUint64(BigInt.asUintN(64, v));
  }

  private pushBigUint64(v: bigint): this {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, v, false);
    return this.push(out);
  }

  /** Длиннопрефиксный байтовый срез (`u32` длина + байты). */
  bytes(value: Uint8Array): this {
    this.u32(value.length);
    return this.push(value.slice());
  }

  str(value: string): this {
    return this.bytes(new TextEncoder().encode(value));
  }

  /** 32-байтовый хеш — сырые байты без префикса длины (зеркало `CanonicalWriter::hash`). */
  hash32(value: Uint8Array): this {
    if (value.length !== 32) {
      throw new EconomyCodecError(`хеш обязан быть 32 байта, получено ${value.length}`);
    }
    return this.push(value.slice());
  }

  /** 16-байтовый идентификатор аккаунта — сырые байты (зеркало `CanonicalWriter::account`). */
  account(value: Uint8Array): this {
    if (value.length !== 16) {
      throw new EconomyCodecError(`AccountId обязан быть 16 байт, получено ${value.length}`);
    }
    return this.push(value.slice());
  }

  /** Сумма grain (i64 BE). */
  grains(value: bigint): this {
    return this.i64(value);
  }

  /** Метка времени Unix-мс (i64 BE). */
  timestamp(value: bigint | number): this {
    return this.i64(value);
  }

  /** Список аккаунтов: `u32`-количество + элементы по порядку. */
  accountList(value: readonly Uint8Array[]): this {
    this.u32(value.length);
    for (const account of value) {
      this.account(account);
    }
    return this;
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}
