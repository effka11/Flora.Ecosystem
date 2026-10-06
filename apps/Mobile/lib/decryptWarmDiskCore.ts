/**
 * Снимок уже расшифрованного хвоста чатов.
 *
 * Чистый модуль: без RN и без MMKV. На диск его кладёт зашифрованный контейнер
 * (`stores/decryptWarmDiskCache`). Нешифрованный снапшот чатов сюда не пишет.
 */

import type { FscpImageBlock, FscpMessageReplyRef, FscpVoiceBlock } from "@flora/client-core/fscp";

export const DECRYPT_WARM_SCHEMA_VERSION = 1;
/** Столько тредов держит и память (`MESSAGE_DECRYPT_THREAD_LIMIT`). */
export const DECRYPT_WARM_MAX_THREADS = 32;
/**
 * Первая страница на диске — до 40 сообщений. Хвост показа короче, но в
 * контейнер кладём страницу целиком, чтобы после входа не осталось «дырки»
 * над уже расшифрованным низом.
 */
export const DECRYPT_WARM_MAX_ROWS = 40;

export type PersistedWarmRow = {
  cacheKey: string;
  messageUuid: string;
  text: string;
  previewText: string;
  imageBlocks: FscpImageBlock[];
  voiceBlock?: FscpVoiceBlock;
  replyTo?: FscpMessageReplyRef;
  isFromMe: boolean;
  createdAt: string;
  decryptState: "ok" | "failed";
  isRead?: boolean;
  senderUserUuid?: string | null;
  missingFrankReceipt?: boolean;
};

export type PersistedWarmThread = {
  conversationUuid: string;
  entries: PersistedWarmRow[];
};

type WarmRowInput = {
  messageUuid: string;
  text: string;
  previewText: string;
  imageBlocks: unknown;
  voiceBlock?: unknown;
  replyTo?: unknown;
  isFromMe: boolean;
  createdAt: string;
  decryptState: string;
  isRead?: boolean;
  senderUserUuid?: string | null;
  missingFrankReceipt?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object";
}

function parseEncryption(
  value: unknown,
): { algorithm: "aes-gcm"; keyBase64Url: string; nonceBase64Url: string } | null {
  if (!isRecord(value)) return null;
  if (value.algorithm !== "aes-gcm") return null;
  if (typeof value.keyBase64Url !== "string" || typeof value.nonceBase64Url !== "string") return null;
  return {
    algorithm: "aes-gcm",
    keyBase64Url: value.keyBase64Url,
    nonceBase64Url: value.nonceBase64Url,
  };
}

function parseImageBlock(value: unknown): FscpImageBlock | null {
  if (!isRecord(value) || value.kind !== "image") return null;
  if (typeof value.assetUuid !== "string" || typeof value.contentType !== "string") return null;
  const encryption = parseEncryption(value.encryption);
  if (!encryption) return null;
  return { kind: "image", assetUuid: value.assetUuid, contentType: value.contentType, encryption };
}

function parseVoiceBlock(value: unknown): FscpVoiceBlock | null {
  if (!isRecord(value) || value.kind !== "voice") return null;
  if (typeof value.assetUuid !== "string" || typeof value.contentType !== "string") return null;
  if (typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs)) return null;
  if (!Array.isArray(value.waveform) || !value.waveform.every((n) => typeof n === "number")) return null;
  const encryption = parseEncryption(value.encryption);
  if (!encryption) return null;
  return {
    kind: "voice",
    assetUuid: value.assetUuid,
    durationMs: value.durationMs,
    waveform: value.waveform,
    contentType: value.contentType,
    encryption,
  };
}

function parseReply(value: unknown): FscpMessageReplyRef | null {
  if (!isRecord(value)) return null;
  if (typeof value.messageUuid !== "string") return null;
  if (typeof value.authorDisplayName !== "string" || typeof value.preview !== "string") return null;
  return {
    messageUuid: value.messageUuid,
    authorDisplayName: value.authorDisplayName,
    preview: value.preview,
  };
}

/** Терминальная строка, которую можно положить в контейнер. Иначе `null`. */
export function persistWarmRow(cacheKey: string, row: WarmRowInput): PersistedWarmRow | null {
  const key = cacheKey.trim();
  if (!key || !row.messageUuid) return null;
  if (row.decryptState !== "ok" && row.decryptState !== "failed") return null;
  if (typeof row.text !== "string" || typeof row.previewText !== "string") return null;
  if (typeof row.createdAt !== "string" || typeof row.isFromMe !== "boolean") return null;
  if (!Array.isArray(row.imageBlocks)) return null;
  const imageBlocks: FscpImageBlock[] = [];
  for (const block of row.imageBlocks) {
    const parsed = parseImageBlock(block);
    if (!parsed) return null;
    imageBlocks.push(parsed);
  }
  let voiceBlock: FscpVoiceBlock | undefined;
  if (row.voiceBlock != null) {
    const parsed = parseVoiceBlock(row.voiceBlock);
    if (!parsed) return null;
    voiceBlock = parsed;
  }
  let replyTo: FscpMessageReplyRef | undefined;
  if (row.replyTo != null) {
    const parsed = parseReply(row.replyTo);
    if (!parsed) return null;
    replyTo = parsed;
  }
  return {
    cacheKey: key,
    messageUuid: row.messageUuid,
    text: row.text,
    previewText: row.previewText,
    imageBlocks,
    voiceBlock,
    replyTo,
    isFromMe: row.isFromMe,
    createdAt: row.createdAt,
    decryptState: row.decryptState,
    isRead: row.isRead === true ? true : undefined,
    senderUserUuid: typeof row.senderUserUuid === "string" ? row.senderUserUuid : row.senderUserUuid ?? undefined,
    missingFrankReceipt: row.missingFrankReceipt === true ? true : undefined,
  };
}

function parseStoredRow(value: unknown): PersistedWarmRow | null {
  if (!isRecord(value)) return null;
  if (typeof value.cacheKey !== "string") return null;
  if (typeof value.messageUuid !== "string") return null;
  if (value.decryptState !== "ok" && value.decryptState !== "failed") return null;
  if (typeof value.text !== "string" || typeof value.previewText !== "string") return null;
  if (typeof value.isFromMe !== "boolean" || typeof value.createdAt !== "string") return null;
  return persistWarmRow(value.cacheKey, {
    messageUuid: value.messageUuid,
    text: value.text,
    previewText: value.previewText,
    imageBlocks: value.imageBlocks,
    voiceBlock: value.voiceBlock,
    replyTo: value.replyTo,
    isFromMe: value.isFromMe,
    createdAt: value.createdAt,
    decryptState: value.decryptState,
    isRead: value.isRead === true ? true : undefined,
    senderUserUuid: typeof value.senderUserUuid === "string" ? value.senderUserUuid : undefined,
    missingFrankReceipt: value.missingFrankReceipt === true ? true : undefined,
  });
}

/** Новейшие строки треда, не больше потолка. Порядок входа тредов сохраняется. */
export function capWarmThreads(
  threads: readonly PersistedWarmThread[],
  maxThreads: number = DECRYPT_WARM_MAX_THREADS,
  maxRows: number = DECRYPT_WARM_MAX_ROWS,
): PersistedWarmThread[] {
  const out: PersistedWarmThread[] = [];
  for (const thread of threads) {
    if (out.length >= maxThreads) break;
    const conversationUuid = thread.conversationUuid.trim();
    if (!conversationUuid) continue;
    const entries = thread.entries
      .filter((entry) => entry.messageUuid && entry.cacheKey)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    const tail = entries.length > maxRows ? entries.slice(entries.length - maxRows) : entries;
    if (tail.length === 0) continue;
    out.push({ conversationUuid, entries: tail });
  }
  return out;
}

/** `null` — чужой владелец, другая схема или битый JSON. Контейнер тогда просто пуст. */
export function parseDecryptWarmEnvelope(
  raw: string | null,
  owner: string,
): PersistedWarmThread[] | null {
  if (!raw || !owner) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.v !== DECRYPT_WARM_SCHEMA_VERSION) return null;
  if (parsed.owner !== owner) return null;
  if (!Array.isArray(parsed.threads)) return null;
  const threads: PersistedWarmThread[] = [];
  for (const thread of parsed.threads) {
    if (!isRecord(thread) || typeof thread.conversationUuid !== "string") continue;
    if (!Array.isArray(thread.entries)) continue;
    const entries: PersistedWarmRow[] = [];
    for (const entry of thread.entries) {
      const row = parseStoredRow(entry);
      if (row) entries.push(row);
    }
    if (entries.length === 0) continue;
    threads.push({ conversationUuid: thread.conversationUuid, entries });
  }
  return capWarmThreads(threads);
}
