/**
 * Отчёт эпохи устройства (зеркало `fpp-contracts::NaturalnessEpochReport`,
 * FPP-SIGNALS §3, §7) — единственное, что клиент отправляет серверу по NS-слою,
 * раз в эпоху: эпохальный девайс-тег + самоотчётные темпоральные bucket'ы.
 * Сырые значения и гистограммы не покидают устройство.
 *
 * Класса аттестации NS-D1 в отчёте нет намеренно: самодекларация
 * «hardware_backed» ничего не стоила бы — класс присваивает Verification
 * по верифицированной регистрации девайс-ключа.
 */

import { deviceTagEpoch } from "./deviceTag.js";
import { epochIdBytes } from "./epoch.js";
import {
  quantizeRaw,
  toReportBuckets,
  type RawTemporalMetrics,
  type ReportedBucket,
} from "./profile.js";

/** Отчёт эпохи: индекс, 32-байтовый девайс-тег, канонические строки bucket'ов. */
export type NaturalnessEpochReport = {
  epochIndex: number;
  deviceTag: Uint8Array;
  temporalBuckets: ReportedBucket[];
};

/** Входы клиентской сборки отчёта эпохи. */
export type BuildEpochReportInput = {
  /** Публичный ключ девайс-пары (32 байта; не покидает устройство). */
  pkDevice: Uint8Array;
  /** Genesis инсталляции (публичный R2-параметр), секунды Unix. */
  genesisUnixS: number;
  /** Индекс отчётной эпохи (из `epochIndexAt`). */
  epochIndex: number;
  /** Сырые значения темпоральных метрик (выходы `temporal.ts`). */
  raw: RawTemporalMetrics;
};

/**
 * Собрать отчёт эпохи: квантование сырых метрик → канонические строки +
 * эпохальный девайс-тег. Детерминированно; паритет с ядром зафиксирован
 * секцией `epochReport` вектора `personhood-naturalness-v1.json`.
 */
export function buildEpochReport(input: BuildEpochReportInput): NaturalnessEpochReport {
  return {
    epochIndex: input.epochIndex,
    deviceTag: deviceTagEpoch(
      input.pkDevice,
      epochIdBytes(input.genesisUnixS, input.epochIndex),
    ),
    temporalBuckets: toReportBuckets(quantizeRaw(input.raw)),
  };
}
