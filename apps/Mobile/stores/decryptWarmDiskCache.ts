/**
 * Зашифрованный контейнер расшифрованных хвостов.
 *
 * Отдельный MMKV `flora-decrypt-warm`. Ключ — в Keystore/Keychain, как у
 * замеров текста: контейнер открывается при успешном входе и целиком стирается
 * на logout. Нешифрованный `flora-chat-cache` plaintext не получает.
 *
 * Всё fail-soft: нет Keystore, чужой ключ, битый JSON — это холодный старт,
 * не ошибка входа.
 */

import * as SecureStore from "expo-secure-store";
import { MMKV } from "react-native-mmkv";
import QuickCryptoModule from "react-native-quick-crypto";
import { DECRYPT_WARM_SCHEMA_VERSION, parseDecryptWarmEnvelope } from "@/lib/decryptWarmDiskCore";
import { hydrateDecryptWarm, snapshotDecryptWarm } from "@/stores/messageThreadCache";

const QuickCrypto =
  (QuickCryptoModule as { default?: typeof QuickCryptoModule }).default ?? QuickCryptoModule;

const KEYSTORE_ENTRY = "flora.decrypt-warm-cache-key.v1";
/** MMKV шифрует AES-CFB и принимает не больше 16 байт ключа. */
const ENCRYPTION_KEY_LENGTH = 16;
const ENCRYPTION_KEY_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";

let hydratedOwner: string | null = null;
let storage: MMKV | null | undefined;

function ownerNorm(ownerUserUuid: string): string {
  return ownerUserUuid.trim().toLowerCase();
}

function snapshotKey(owner: string): string {
  return `v${DECRYPT_WARM_SCHEMA_VERSION}.${owner}.warm`;
}

function randomBytes(length: number): Uint8Array {
  if (typeof QuickCrypto.randomBytes === "function") {
    return new Uint8Array(QuickCrypto.randomBytes(length));
  }
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

function createEncryptionKey(): string {
  let key = "";
  for (const byte of randomBytes(ENCRYPTION_KEY_LENGTH)) {
    key += ENCRYPTION_KEY_ALPHABET[byte % ENCRYPTION_KEY_ALPHABET.length];
  }
  return key;
}

function readOrCreateEncryptionKey(): string | null {
  try {
    const existing = SecureStore.getItem(KEYSTORE_ENTRY);
    if (existing && existing.length > 0) return existing;
    const created = createEncryptionKey();
    SecureStore.setItem(KEYSTORE_ENTRY, created);
    return created;
  } catch {
    return null;
  }
}

function getStorage(): MMKV | null {
  if (storage !== undefined) return storage;
  const encryptionKey = readOrCreateEncryptionKey();
  if (!encryptionKey) {
    storage = null;
    return null;
  }
  try {
    storage = new MMKV({ id: "flora-decrypt-warm", encryptionKey });
  } catch {
    storage = null;
  }
  return storage;
}

export function decryptWarmHydratedOwner(): string | null {
  return hydratedOwner;
}

/** Снимок владельца → память decrypt-кэша. Пустой контейнер — тоже успешное открытие. */
export function hydrateDecryptWarmDisk(ownerUserUuid: string): boolean {
  const owner = ownerNorm(ownerUserUuid);
  if (!owner) return false;
  const mmkv = getStorage();
  if (!mmkv) return false;
  hydratedOwner = owner;
  const threads = parseDecryptWarmEnvelope(mmkv.getString(snapshotKey(owner)) ?? null, owner);
  if (!threads || threads.length === 0) return false;
  hydrateDecryptWarm(threads);
  return true;
}

export function writeDecryptWarmDisk(ownerUserUuid: string): void {
  const owner = ownerNorm(ownerUserUuid);
  if (!owner) return;
  const mmkv = getStorage();
  if (!mmkv) return;
  const threads = snapshotDecryptWarm();
  const key = snapshotKey(owner);
  if (threads.length === 0) {
    mmkv.delete(key);
    return;
  }
  try {
    mmkv.set(
      key,
      JSON.stringify({
        v: DECRYPT_WARM_SCHEMA_VERSION,
        owner,
        threads,
      }),
    );
  } catch {
    // Нет места или MMKV недоступен — следующий вход прогреет хвост заново.
  }
}

export function wipeDecryptWarmDisk(): void {
  hydratedOwner = null;
  try {
    getStorage()?.clearAll();
  } catch {
    // Logout не должен падать из-за кэша хвостов.
  }
}
