/**
 * Диск кэша замеров текста (см. `lib/messageTextMeasureCache`).
 *
 * Замер — это ключ вида «ширина|текст сообщения» и разбивка этого текста на
 * строки, то есть **plaintext**. Инвариант приложения (`stores/chatDiskCache`)
 * — plaintext не персистится; поэтому здесь отдельный инстанс MMKV, целиком
 * зашифрованный ключом из Keystore/Keychain (`expo-secure-store`), а не общий
 * `flora-mobile`. Ключ генерируется на устройстве при первом запуске и никуда
 * не уходит; logout стирает инстанс (`wipeTextMeasureDisk`).
 *
 * Снимок owner-scoped и привязан к масштабу системного шрифта: раскладка
 * текста от него зависит, а ключ кэша его не учитывает — иначе после смены
 * размера шрифта в настройках система вернула бы старые замеры.
 *
 * Всё fail-soft: недоступный Keystore, чужой ключ (переустановка), битый JSON —
 * это просто отсутствие прогрева, а не ошибка старта.
 */

import * as SecureStore from "expo-secure-store";
import { PixelRatio } from "react-native";
import { MMKV } from "react-native-mmkv";
import QuickCryptoModule from "react-native-quick-crypto";
import {
  hydrateMessageTextMeasures,
  snapshotMessageTextMeasures,
} from "@/lib/messageTextMeasureCache";

const QuickCrypto =
  (QuickCryptoModule as { default?: typeof QuickCryptoModule }).default ?? QuickCryptoModule;

const SCHEMA_VERSION = 1;
const KEYSTORE_ENTRY = "flora.text-measure-cache-key.v1";
/** MMKV шифрует AES-CFB и принимает не больше 16 байт ключа. */
const ENCRYPTION_KEY_LENGTH = 16;
/** 64 символа = 6 бит на символ; 256 делится на 64, так что байт uniform. */
const ENCRYPTION_KEY_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
/**
 * Сколько замеров тел уносить на диск. Полная ёмкость кэша (1200) — это уже
 * заметный JSON: гидрация парсит его на старте, а запись сериализует. Свежий
 * хвост закрывает то, что пользователь откроет с большей вероятностью.
 */
const PERSIST_MAX_BODY_ENTRIES = 800;

type Envelope = {
  v: number;
  fontScale: number;
  owner: string;
  body: unknown;
  time: unknown;
};

function ownerNorm(ownerUserUuid: string): string {
  return ownerUserUuid.trim().toLowerCase();
}

function snapshotKey(owner: string): string {
  return `v${SCHEMA_VERSION}.${owner}.measures`;
}

/** Бакет масштаба шрифта: сравниваем целыми, без дребезга плавающей точки. */
function fontScaleBucket(): number {
  return Math.round(PixelRatio.getFontScale() * 100);
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

let storage: MMKV | null | undefined;

function getStorage(): MMKV | null {
  if (storage !== undefined) return storage;
  const encryptionKey = readOrCreateEncryptionKey();
  if (!encryptionKey) {
    storage = null;
    return null;
  }
  try {
    storage = new MMKV({ id: "flora-text-measures", encryptionKey });
  } catch {
    storage = null;
  }
  return storage;
}

/** Читает снимок владельца в кэш замеров. Возвращает, случилась ли гидрация. */
export function hydrateTextMeasureDisk(ownerUserUuid: string): boolean {
  const owner = ownerNorm(ownerUserUuid);
  if (!owner) return false;
  const mmkv = getStorage();
  if (!mmkv) return false;
  const raw = mmkv.getString(snapshotKey(owner));
  if (!raw) return false;

  let parsed: Partial<Envelope>;
  try {
    parsed = JSON.parse(raw) as Partial<Envelope>;
  } catch {
    mmkv.delete(snapshotKey(owner));
    return false;
  }
  if (parsed.owner !== owner) return false;
  // Прошлая схема или другой масштаб шрифта: замеры больше не описывают эту
  // раскладку и никогда не станут читаемыми — снимок можно удалять.
  if (parsed.v !== SCHEMA_VERSION || parsed.fontScale !== fontScaleBucket()) {
    mmkv.delete(snapshotKey(owner));
    return false;
  }
  hydrateMessageTextMeasures({ body: parsed.body, time: parsed.time });
  return true;
}

export function writeTextMeasureDisk(ownerUserUuid: string): void {
  const owner = ownerNorm(ownerUserUuid);
  if (!owner) return;
  const mmkv = getStorage();
  if (!mmkv) return;
  const snapshot = snapshotMessageTextMeasures(PERSIST_MAX_BODY_ENTRIES);
  if (snapshot.body.length === 0 && snapshot.time.length === 0) return;
  const envelope: Envelope = {
    v: SCHEMA_VERSION,
    fontScale: fontScaleBucket(),
    owner,
    body: snapshot.body,
    time: snapshot.time,
  };
  try {
    mmkv.set(snapshotKey(owner), JSON.stringify(envelope));
  } catch {
    // Нет места / MMKV недоступен — прогрев переживёт, старт тоже.
  }
}

export function wipeTextMeasureDisk(): void {
  try {
    getStorage()?.clearAll();
  } catch {
    // Logout не должен падать из-за кэша раскладки.
  }
}
