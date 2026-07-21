/**
 * Канонический формат сумм LIV (Documents/fep/LIV.md §2.2).
 *
 * 1 liv = 10^6 grain; все консенсусные суммы — целые grain в диапазоне i64.
 * Плавающая точка запрещена на любом слое (LIV.md §2.2), поэтому суммы — `bigint`.
 * Реализация — бит-в-бит паритет с `flora-economy-crypto::amount`
 * (golden-вектор `fep-liv-amounts-v1.json`).
 */

export const LIV_TICKER = "LIV";
export const LIV_DECIMALS = 6;
export const LIV_IN_GRAINS = 1_000_000n;

/** Границы i64 — допустимый диапазон сумм grain (паритет с ядром). */
export const GRAINS_MIN = -(2n ** 63n);
export const GRAINS_MAX = 2n ** 63n - 1n;

/** Сумма в диапазоне i64 ядра? */
export function isValidGrains(grains: bigint): boolean {
  return grains >= GRAINS_MIN && grains <= GRAINS_MAX;
}

/**
 * Каноническая запись суммы: целая часть без ведущих нулей, точка, **ровно 6** знаков
 * дроби (`1.500000`, `0.000001`, `-2.250000`). Никаких локалей, экспонент, знака `+`.
 * Зеркало `Grains::format_liv`.
 */
export function formatLiv(grains: bigint): string {
  if (!isValidGrains(grains)) {
    throw new RangeError(`сумма ${grains} вне диапазона i64 grain`);
  }
  const negative = grains < 0n;
  const abs = negative ? -grains : grains; // |i64::MIN| представим в bigint без спецслучая
  const whole = abs / LIV_IN_GRAINS;
  const frac = abs % LIV_IN_GRAINS;
  return `${negative ? "-" : ""}${whole}.${frac.toString().padStart(LIV_DECIMALS, "0")}`;
}

function isAsciiDigits(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return false;
  }
  return true;
}

/**
 * Разбор канонической записи (обратная к [`formatLiv`]); зеркало `Grains::parse_liv`.
 *
 * Принимает и сокращённые формы (`5`, `5.1`, `.5`), но не более 6 знаков дроби и без
 * экспонент/пробелов/разделителей групп. `null` — некорректная форма или переполнение i64.
 */
export function parseLiv(input: string): bigint | null {
  let negative = false;
  let rest = input;
  if (rest.startsWith("-")) {
    negative = true;
    rest = rest.slice(1);
  }
  if (rest.length === 0) return null;

  const dot = rest.indexOf(".");
  const wholeStr = dot >= 0 ? rest.slice(0, dot) : rest;
  const fracStr = dot >= 0 ? rest.slice(dot + 1) : "";

  if (wholeStr.length === 0 && fracStr.length === 0) return null;
  if (fracStr.length > LIV_DECIMALS) return null;
  if (!isAsciiDigits(wholeStr) || !isAsciiDigits(fracStr)) return null;

  const whole = wholeStr.length === 0 ? 0n : BigInt(wholeStr);
  let frac = fracStr.length === 0 ? 0n : BigInt(fracStr);
  // Дополняем дробь до 6 знаков: "5.1" → 100000 grain дроби.
  for (let i = fracStr.length; i < LIV_DECIMALS; i += 1) {
    frac *= 10n;
  }
  // Величина без знака; знак применяем до проверки диапазона (|i64::MIN| валиден).
  const magnitude = whole * LIV_IN_GRAINS + frac;
  const signed = negative ? -magnitude : magnitude;
  return isValidGrains(signed) ? signed : null;
}
