/**
 * Pure schema + sanitizers for the chat disk snapshot (Telegram-style silent
 * cold start). Persisted payloads contain ONLY server-visible data: DTOs with
 * ciphertext wires and metadata the server already stores. Decrypted plaintext
 * never reaches disk — decrypt caches stay in memory and are re-warmed on boot.
 *
 * RN-free on purpose: unit-tested with vitest (binding lives in
 * `stores/chatDiskCache.ts`).
 */

import type {
  MsgConversationDto,
  MsgConversationsPage,
  MsgGroupDetail,
  MsgGroupListItem,
  MsgMessageDto,
} from "@flora/client-core/contracts";
import { isOptimisticPayloadSentinel } from "@/lib/messageBirthRegistry";

export const CHAT_DISK_SCHEMA_VERSION = 1;
export const CHAT_DISK_MAX_CONVERSATIONS = 60;
export const CHAT_DISK_MAX_GROUPS = 40;
/**
 * 64 треда × ≤40 сообщений: только шифротекст и метаданные, ~десятки КБ на
 * тред. Скупой потолок (30) давал сетевой фетч прямо на открытии чата за
 * пределами верхушки (симптом: data>1000мс в трассе открытия).
 */
export const CHAT_DISK_MAX_THREADS = 64;
export const CHAT_DISK_MAX_THREAD_MESSAGES = 40;
/** Треды старше — не гидрируем (шифротекст мог протухнуть по epoch, UX-ценность нулевая). */
export const CHAT_DISK_THREAD_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type PersistedConversations = {
  updatedAt: number;
  page: MsgConversationsPage;
};

export type PersistedGroups = {
  updatedAt: number;
  items: MsgGroupListItem[];
};

export type PersistedThreadKind = "dm" | "group";

export type PersistedThread = {
  updatedAt: number;
  kind: PersistedThreadKind;
  /** Оригинальный регистр — RQ-ключи экранов и `messageThreadCache` регистрозависимы. */
  conversationUuid: string;
  /** Пустая строка для групп; для DM — третий элемент RQ-ключа `["messages", conv, other]`. */
  otherUserUuid: string;
  /** Oldest-first, как в RQ-кэше треда. */
  items: MsgMessageDto[];
};

export type PersistedGroupDetail = {
  updatedAt: number;
  /** Оригинальный регистр RQ-ключа `["group", conversationUuid]`. */
  conversationUuid: string;
  detail: MsgGroupDetail;
};

export type ThreadIndexEntry = {
  conversationUuid: string;
  kind: PersistedThreadKind;
  touchedAt: number;
};

export function chatDiskOwnerNorm(ownerUserUuid: string): string {
  return ownerUserUuid.trim().toLowerCase();
}

/**
 * Server parity для списка чатов: у E2E-переписок сервер отдаёт
 * `lastMessageContent: null` (plaintext-превью появляется в RQ-кэше только из
 * optimistic-патчей). Запись на диск — строго серверный вид: если есть wire —
 * контент обнуляем; optimistic-сентинел не персистим вовсе.
 */
export function sanitizeConversationsForPersist(
  page: MsgConversationsPage,
  maxItems: number = CHAT_DISK_MAX_CONVERSATIONS,
): MsgConversationsPage {
  const items = page.items.slice(0, maxItems).map((item): MsgConversationDto => {
    const enc = item.lastMessageEncryptedForMe;
    if (isOptimisticPayloadSentinel(enc)) {
      return { ...item, lastMessageEncryptedForMe: null, lastMessageContent: null };
    }
    if (enc && enc.trim().length > 0) {
      return item.lastMessageContent === null ? item : { ...item, lastMessageContent: null };
    }
    return item;
  });
  return { items, nextCursor: page.nextCursor };
}

export function sanitizeGroupsForPersist(
  items: readonly MsgGroupListItem[],
  maxItems: number = CHAT_DISK_MAX_GROUPS,
): MsgGroupListItem[] {
  return items.slice(0, maxItems);
}

/**
 * Тред: без optimistic-сентинелов (in-flight отправки не переживают процесс),
 * хвост из последних N сообщений (oldest-first вход/выход).
 */
export function sanitizeThreadItemsForPersist(
  items: readonly MsgMessageDto[],
  maxItems: number = CHAT_DISK_MAX_THREAD_MESSAGES,
): MsgMessageDto[] {
  const real = items.filter((m) => !isOptimisticPayloadSentinel(m.encryptedPayload));
  return real.length > maxItems ? real.slice(real.length - maxItems) : real;
}

export function isThreadSnapshotFresh(
  updatedAt: number,
  now: number,
  ttlMs: number = CHAT_DISK_THREAD_TTL_MS,
): boolean {
  return Number.isFinite(updatedAt) && updatedAt > 0 && now - updatedAt <= ttlMs;
}

/** LRU: сортировка по touchedAt desc; хвост за пределами cap — на удаление. */
export function pruneThreadIndex(
  entries: readonly ThreadIndexEntry[],
  maxThreads: number = CHAT_DISK_MAX_THREADS,
): { keep: ThreadIndexEntry[]; evict: ThreadIndexEntry[] } {
  const dedup = new Map<string, ThreadIndexEntry>();
  for (const entry of entries) {
    const key = entry.conversationUuid.trim().toLowerCase();
    const prev = dedup.get(key);
    if (!prev || entry.touchedAt > prev.touchedAt) dedup.set(key, entry);
  }
  const sorted = [...dedup.values()].sort((a, b) => b.touchedAt - a.touchedAt);
  return { keep: sorted.slice(0, maxThreads), evict: sorted.slice(maxThreads) };
}

export function touchThreadIndex(
  entries: readonly ThreadIndexEntry[],
  entry: ThreadIndexEntry,
  maxThreads: number = CHAT_DISK_MAX_THREADS,
): { keep: ThreadIndexEntry[]; evict: ThreadIndexEntry[] } {
  return pruneThreadIndex([...entries, entry], maxThreads);
}

// ── Parse helpers (диск может быть повреждён/чужой версии — никогда не бросаем) ──

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function parsePersistedConversations(raw: string | null): PersistedConversations | null {
  if (!raw) return null;
  try {
    const o = asRecord(JSON.parse(raw));
    if (!o || !isPositiveNumber(o.updatedAt)) return null;
    const page = asRecord(o.page);
    if (!page || !Array.isArray(page.items)) return null;
    return o as unknown as PersistedConversations;
  } catch {
    return null;
  }
}

export function parsePersistedGroups(raw: string | null): PersistedGroups | null {
  if (!raw) return null;
  try {
    const o = asRecord(JSON.parse(raw));
    if (!o || !isPositiveNumber(o.updatedAt) || !Array.isArray(o.items)) return null;
    return o as unknown as PersistedGroups;
  } catch {
    return null;
  }
}

export function parsePersistedThread(raw: string | null): PersistedThread | null {
  if (!raw) return null;
  try {
    const o = asRecord(JSON.parse(raw));
    if (!o || !isPositiveNumber(o.updatedAt) || !Array.isArray(o.items)) return null;
    if (o.kind !== "dm" && o.kind !== "group") return null;
    if (typeof o.conversationUuid !== "string" || o.conversationUuid.length === 0) return null;
    if (typeof o.otherUserUuid !== "string") return null;
    return o as unknown as PersistedThread;
  } catch {
    return null;
  }
}

export function parsePersistedGroupDetail(raw: string | null): PersistedGroupDetail | null {
  if (!raw) return null;
  try {
    const o = asRecord(JSON.parse(raw));
    if (!o || !isPositiveNumber(o.updatedAt)) return null;
    if (typeof o.conversationUuid !== "string" || o.conversationUuid.length === 0) return null;
    const detail = asRecord(o.detail);
    if (!detail || typeof detail.conversationUuid !== "string") return null;
    return o as unknown as PersistedGroupDetail;
  } catch {
    return null;
  }
}

export function parseThreadIndex(raw: string | null): ThreadIndexEntry[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.filter((entry): entry is ThreadIndexEntry => {
      const o = asRecord(entry);
      return (
        !!o &&
        typeof o.conversationUuid === "string" &&
        o.conversationUuid.length > 0 &&
        (o.kind === "dm" || o.kind === "group") &&
        isPositiveNumber(o.touchedAt)
      );
    });
  } catch {
    return [];
  }
}
