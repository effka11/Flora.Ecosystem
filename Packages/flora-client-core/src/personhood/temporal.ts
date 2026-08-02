/**
 * NS-T1 / NS-T2 — темпоральные метрики натуральности на устройстве
 * (зеркало `fpp-core::temporal`, FPP-SIGNALS §2).
 *
 * Целочисленная арифметика бит-в-бит с Rust-ядром: BigInt вместо u128,
 * усечение к нулю при делении, floor-корень. Паритет зафиксирован вектором
 * `personhood-naturalness-v1.json`.
 *
 * Метрики нормированы **формой, не объёмом** (анти-дискриминационный инвариант
 * FPP-SIGNALS §6): при выборке ниже минимальной сигнал отсутствует (`null`),
 * отсутствие нейтрально — не штраф.
 */

import { PersonhoodCodecError } from "./registry.js";

/** Минимум межсобытийных интервалов для NS-T1; ниже — `null`. */
export const MIN_INTERVALS = 8;

/** Минимум событий суточного профиля для NS-T2; ниже — `null`. */
export const MIN_PROFILE_EVENTS = 24;

/** Зажим одного интервала: 10 лет в секундах (ограничивает разрядность). */
export const MAX_INTERVAL_S = 315_360_000;

/** Длина «окна отдыха» суточного профиля (часов подряд), NS-T2a. */
export const REST_WINDOW_HOURS = 6;

const MICRO = 1_000_000n;

/** Целочисленный floor-корень (метод Ньютона) — зеркало `u128::isqrt`. */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

function nonNegativeCount(value: number, what: string): bigint {
  if (!Number.isFinite(value) || value < 0) {
    throw new PersonhoodCodecError(`${what}: ожидалось неотрицательное число, получено ${value}`);
  }
  return BigInt(Math.trunc(value));
}

/**
 * NS-T1: burstiness Гоха–Барабаши `B = (σ − μ) / (σ + μ)` в промилле `[-1000, 1000]`.
 *
 * Человеческая активность bursty (`B > 0`); cron-подобная автоматика регулярна
 * (`B → −1000`). Интервалы — секунды, каждый зажимается [`MAX_INTERVAL_S`]
 * (поэтому значения выше 2^53 безопасно приходят уже зажатыми). Вырожденный
 * случай `σ + μ = 0` определён как `−1000`.
 */
export function burstinessPermille(intervalsS: readonly number[]): number | null {
  if (intervalsS.length < MIN_INTERVALS) return null;
  const n = BigInt(intervalsS.length);
  const clamped = intervalsS.map((x) =>
    nonNegativeCount(Math.min(x, MAX_INTERVAL_S), "интервал"),
  );
  let sum = 0n;
  for (const x of clamped) sum += x;
  const meanMicro = (sum * MICRO) / n;
  let varMicro2 = 0n;
  for (const x of clamped) {
    const scaled = x * MICRO;
    const d = scaled >= meanMicro ? scaled - meanMicro : meanMicro - scaled;
    varMicro2 += d * d;
  }
  varMicro2 /= n;
  const sigmaMicro = isqrt(varMicro2);
  const denom = sigmaMicro + meanMicro;
  if (denom === 0n) return -1000;
  // BigInt-деление усечено к нулю — как i128 в ядре.
  return Number(((sigmaMicro - meanMicro) * 1000n) / denom);
}

/** Суточная гистограмма: 24 часовых счётчика. Сырой профиль не покидает устройство. */
export type HourCounts = readonly number[];

function totalOf(counts: HourCounts): bigint {
  if (counts.length !== 24) {
    throw new PersonhoodCodecError(`суточный профиль: ожидалось 24 часа, получено ${counts.length}`);
  }
  let total = 0n;
  for (const c of counts) total += nonNegativeCount(c, "часовой счётчик");
  return total;
}

/**
 * NS-T2a: доля активности в самом тихом циклическом окне из
 * [`REST_WINDOW_HOURS`] часов, ‰ от общего объёма. У человека есть окно сна
 * (< 50‰); равномерная автоматика даёт 250‰ (максимум по Дирихле).
 * `null` при выборке < [`MIN_PROFILE_EVENTS`].
 */
export function restSharePermille(counts: HourCounts): number | null {
  const total = totalOf(counts);
  if (total < BigInt(MIN_PROFILE_EVENTS)) return null;
  let minWindow: bigint | null = null;
  for (let start = 0; start < 24; start += 1) {
    let window = 0n;
    for (let i = 0; i < REST_WINDOW_HOURS; i += 1) {
      window += BigInt(Math.trunc(counts[(start + i) % 24]!));
    }
    if (minWindow === null || window < minWindow) minWindow = window;
  }
  return Number((minWindow! * 1000n) / total);
}

/**
 * NS-T2b: доля пикового часа, ‰. Экстремумы неестественны с обеих сторон:
 * ≈ 42‰ — идеальная равномерность (машина), 1000‰ — весь объём в один час (cron).
 * `null` при выборке < [`MIN_PROFILE_EVENTS`].
 */
export function peakSharePermille(counts: HourCounts): number | null {
  const total = totalOf(counts);
  if (total < BigInt(MIN_PROFILE_EVENTS)) return null;
  let maxHour = 0n;
  for (const c of counts) {
    const x = BigInt(Math.trunc(c));
    if (x > maxHour) maxHour = x;
  }
  return Number((maxHour * 1000n) / total);
}

/**
 * NS-T2c: сходство двух профилей (эпоха-к-эпохе) — пересечение гистограмм
 * с симметричной нормировкой `Σ min(aᵢ, bᵢ) · 1000 / max(Σa, Σb)`, ‰.
 * Почти ноль — маркер передачи аккаунта; слишком высокое (replay шаблона) —
 * тоже аномалия. `null`, если хотя бы один профиль ниже минимальной выборки.
 */
export function similarityPermille(a: HourCounts, b: HourCounts): number | null {
  const totalA = totalOf(a);
  const totalB = totalOf(b);
  if (totalA < BigInt(MIN_PROFILE_EVENTS) || totalB < BigInt(MIN_PROFILE_EVENTS)) {
    return null;
  }
  let overlap = 0n;
  for (let i = 0; i < 24; i += 1) {
    overlap += BigInt(Math.trunc(Math.min(a[i]!, b[i]!)));
  }
  const denom = totalA > totalB ? totalA : totalB;
  return Number((overlap * 1000n) / denom);
}
