/**
 * Каноническая эпоха NS-слоя (зеркало `fpp-core::epoch`, FPP-SIGNALS §2, Приложение A).
 *
 * Эпоха — общий такт девайс-тегов, самоотчётов и поручительств (90 дней, FPP §4.1).
 * Деривация обязана совпадать байт-в-байт с сервером: девайс-тег
 * `deviceTagEpoch(pkDevice, epochId)` сойдётся у обеих сторон только при
 * каноническом `epochId = LE64(genesisUnixS) || LE64(epochIndex)`.
 */

import { PersonhoodCodecError } from "./registry.js";

/** Длина эпохи по умолчанию: 90 дней в секундах (R2-параметр). */
export const EPOCH_LEN_S = 90 * 86_400;

function requireUnsignedInt(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PersonhoodCodecError(
      `${what}: ожидалось неотрицательное целое в безопасном диапазоне JS, получено ${value}`,
    );
  }
}

/**
 * Индекс эпохи для момента `unixS` (секунды Unix) относительно genesis.
 * `null` до genesis и при вырожденной длине эпохи (некорректный конфиг
 * отклоняется, а не «чинится»). Деление — floor на неотрицательных.
 */
export function epochIndexAt(
  unixS: number,
  genesisUnixS: number,
  epochLenS: number = EPOCH_LEN_S,
): number | null {
  requireUnsignedInt(unixS, "unixS");
  requireUnsignedInt(genesisUnixS, "genesisUnixS");
  requireUnsignedInt(epochLenS, "epochLenS");
  if (epochLenS === 0 || unixS < genesisUnixS) return null;
  return Math.floor((unixS - genesisUnixS) / epochLenS);
}

/** Начало эпохи `epochIndex` (секунды Unix); `null` вне безопасного диапазона JS. */
export function epochStartS(
  genesisUnixS: number,
  epochIndex: number,
  epochLenS: number = EPOCH_LEN_S,
): number | null {
  requireUnsignedInt(genesisUnixS, "genesisUnixS");
  requireUnsignedInt(epochIndex, "epochIndex");
  requireUnsignedInt(epochLenS, "epochLenS");
  const start = genesisUnixS + epochIndex * epochLenS;
  return Number.isSafeInteger(start) ? start : null;
}

/**
 * Канонические 16 байт `epochId`: `LE64(genesisUnixS) || LE64(epochIndex)`.
 * Включение genesis разводит теги разных инсталляций по построению.
 * Потребитель — `deviceTagEpoch`.
 */
export function epochIdBytes(genesisUnixS: number, epochIndex: number): Uint8Array {
  requireUnsignedInt(genesisUnixS, "genesisUnixS");
  requireUnsignedInt(epochIndex, "epochIndex");
  const id = new Uint8Array(16);
  const view = new DataView(id.buffer);
  view.setBigUint64(0, BigInt(genesisUnixS), true);
  view.setBigUint64(8, BigInt(epochIndex), true);
  return id;
}
