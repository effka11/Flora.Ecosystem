/**
 * Эпохальный тег устройства NS-D2 (зеркало `fpp-crypto::device_tag_epoch`,
 * FPP-SIGNALS §2, §3; примитив — FGP-CRYPTO §1.1).
 *
 * Вычисляется **на устройстве**; сервер видит и хранит только тег:
 * один девайс + одна эпоха → один тег (конкурентность личностей наблюдаема),
 * смена эпохи меняет тег (кросс-эпохный трекинг исключён по построению),
 * `pkDevice` серверу не предъявляется.
 */

import { blake3 } from "@noble/hashes/blake3.js";

import { PersonhoodCodecError } from "./registry.js";

/** Доменная метка деривации тега (FGP-CRYPTO §1.1, реестр `governance-ds-tags-v1`). */
export const DEVICE_TAG_CONTEXT = "flora/device/v1/tag";

const CONTEXT_BYTES = new TextEncoder().encode(DEVICE_TAG_CONTEXT);

/**
 * `BLAKE3 derive_key("flora/device/v1/tag", pkDevice || epochId)` → 32 байта.
 * `epochId` — канонические 16 байт из `epochIdBytes` (epoch.ts).
 */
export function deviceTagEpoch(pkDevice: Uint8Array, epochId: Uint8Array): Uint8Array {
  if (pkDevice.length !== 32) {
    throw new PersonhoodCodecError(`pkDevice: ожидалось 32 байта, получено ${pkDevice.length}`);
  }
  if (epochId.length !== 16) {
    throw new PersonhoodCodecError(`epochId: ожидалось 16 байт, получено ${epochId.length}`);
  }
  const material = new Uint8Array(48);
  material.set(pkDevice, 0);
  material.set(epochId, 32);
  return blake3(material, { context: CONTEXT_BYTES });
}
