/**
 * Байтовые утилиты валютного слоя LIV (FEP).
 *
 * Родная кодировка контракта FEP — **hex lowercase** (JSONL-журнал и HTTP API,
 * Documents/fep/LIV.md, Приложение «Golden-векторы»). Все функции детерминированы
 * и не зависят от платформы.
 */

/** Ошибка кодека валютного слоя: некорректная форма данных на границе системы. */
export class EconomyCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EconomyCodecError";
  }
}

const encoder = new TextEncoder();

export function utf8Bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

const HEX_ALPHABET = "0123456789abcdef";

/** Байты → hex lowercase (контракт FEP). */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += HEX_ALPHABET[byte >> 4]! + HEX_ALPHABET[byte & 0x0f]!;
  }
  return out;
}

function hexNibble(code: number): number | null {
  if (code >= 0x30 && code <= 0x39) return code - 0x30; // 0-9
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10; // a-f
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10; // A-F (паритет с hexser)
  return null;
}

/** Hex → байты; `null` при нечётной длине или не-hex символе. */
export function tryFromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const hi = hexNibble(hex.charCodeAt(i * 2));
    const lo = hexNibble(hex.charCodeAt(i * 2 + 1));
    if (hi === null || lo === null) return null;
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/** Hex → байты фиксированной длины; бросает [`EconomyCodecError`] при неверной форме. */
export function fromHex(hex: string, expectedLength?: number): Uint8Array {
  const bytes = tryFromHex(hex);
  if (bytes === null) {
    throw new EconomyCodecError(`некорректная hex-строка (длина ${hex.length})`);
  }
  if (expectedLength !== undefined && bytes.length !== expectedLength) {
    throw new EconomyCodecError(
      `ожидалось ${expectedLength} байт, получено ${bytes.length}`,
    );
  }
  return bytes;
}

/** Побайтовое равенство (данные публичные — постоянное время не требуется). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Лексикографическое сравнение байтов (канонический порядок пар FEP §4.1). */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/**
 * JSON-число → bigint суммы grain. Граница системы: JSON.parse теряет точность выше
 * 2^53 − 1, поэтому небезопасные значения отвергаются, а не молча искажаются
 * (суммы одной записи журнала на порядки ниже этого предела; агрегаты уровня
 * состояния передаются строками — см. wasm-поверхность).
 */
export function grainsFromJsonNumber(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new EconomyCodecError(
      `сумма grain обязана быть целым числом в безопасном диапазоне JS: ${String(value)}`,
    );
  }
  return BigInt(value);
}

/** bigint grain → JSON-число (для тел запросов HTTP API, суммы — grain i64). */
export function grainsToJsonNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new EconomyCodecError(
      `сумма ${value} grain не представима JSON-числом без потери точности`,
    );
  }
  return Number(value);
}
