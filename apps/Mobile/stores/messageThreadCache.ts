import type { MsgMessageDto } from "@flora/client-core/contracts";
import type { ThreadBubbleItem } from "@/components/messages/ChatMessageBubble";
import {
  capWarmThreads,
  persistWarmRow,
  type PersistedWarmThread,
} from "@/lib/decryptWarmDiskCore";

const cache = new Map<string, MsgMessageDto[]>();
const wireDecryptCache = new Map<string, ThreadBubbleItem>();
const conversationDecryptCache = new Map<string, ThreadBubbleItem[]>();

/** conversationUuid → wire keys (`messageUuid|payload prefix`) of that thread. */
const wireKeysByConversation = new Map<string, Set<string>>();
/** Oldest plaintext thread first. Stored ids are exact, not lowercased. */
const decryptThreadLru: string[] = [];
const retainedDecryptThreads = new Map<string, Set<string>>();

/** Plaintext threads kept in memory. Open thread and prefetch candidates are pinned. */
export const MESSAGE_DECRYPT_THREAD_LIMIT = 32;

/** Late-bound: outgoing module restores optimistic decrypt seeds after wipe. */
let afterClearDecryptCaches: (() => void) | null = null;
/** Персист зашифрованного контейнера. Гидрация его не зовёт. */
let warmDirtyListener: (() => void) | null = null;
let warmHydrating = false;

function noteWarmDirty(): void {
  if (warmHydrating) return;
  warmDirtyListener?.();
}

export function setDecryptWarmDirtyListener(listener: (() => void) | null): void {
  warmDirtyListener = listener;
}

export function onAfterClearDecryptCaches(fn: () => void): void {
  afterClearDecryptCaches = fn;
}

export function messageDecryptThreadCount(): number {
  return decryptThreadLru.length;
}

/**
 * Threads this owner must not evict. A later call replaces that owner's set.
 * Empty ids release the pin. Keys stay as passed (no case folding).
 */
export function retainMessageDecryptThreads(owner: string, ids: readonly string[]): void {
  const next = new Set(ids.map((id) => id.trim()).filter(Boolean));
  if (next.size === 0) retainedDecryptThreads.delete(owner);
  else retainedDecryptThreads.set(owner, next);
}

function retainedDecryptIds(): Set<string> {
  const ids = new Set<string>();
  for (const pinned of retainedDecryptThreads.values()) {
    for (const id of pinned) ids.add(id);
  }
  return ids;
}

function touchDecryptThread(conversationUuid: string): void {
  const at = decryptThreadLru.indexOf(conversationUuid);
  if (at >= 0) decryptThreadLru.splice(at, 1);
  decryptThreadLru.push(conversationUuid);
}

function forgetDecryptThread(conversationUuid: string): void {
  const at = decryptThreadLru.indexOf(conversationUuid);
  if (at >= 0) decryptThreadLru.splice(at, 1);
}

function wireUuid(cacheKey: string): string {
  const bar = cacheKey.indexOf("|");
  return bar >= 0 ? cacheKey.slice(0, bar) : "";
}

function deleteWireKeysForUuids(uuids: ReadonlySet<string>): void {
  if (uuids.size === 0) return;
  for (const cacheKey of wireDecryptCache.keys()) {
    const uuid = wireUuid(cacheKey);
    if (uuid && uuids.has(uuid)) wireDecryptCache.delete(cacheKey);
  }
}

function dropDecryptThread(conversationUuid: string, extraUuids?: ReadonlySet<string>): void {
  const indexed = wireKeysByConversation.get(conversationUuid);
  if (indexed) {
    for (const cacheKey of indexed) wireDecryptCache.delete(cacheKey);
  }
  if (extraUuids) deleteWireKeysForUuids(extraUuids);
  wireKeysByConversation.delete(conversationUuid);
  conversationDecryptCache.delete(conversationUuid);
  forgetDecryptThread(conversationUuid);
}

function evictDecryptOverflow(): void {
  const pinned = retainedDecryptIds();
  while (decryptThreadLru.length > MESSAGE_DECRYPT_THREAD_LIMIT) {
    const victim = decryptThreadLru.find((id) => !pinned.has(id));
    if (!victim) break;
    dropDecryptThread(victim);
  }
}

function conversationOwningMessage(messageUuid: string): string | undefined {
  if (!messageUuid) return undefined;
  for (const [conversationUuid, keys] of wireKeysByConversation) {
    for (const cacheKey of keys) {
      if (wireUuid(cacheKey) === messageUuid) return conversationUuid;
    }
  }
  for (const [conversationUuid, rows] of conversationDecryptCache) {
    if (rows.some((row) => row.messageUuid === messageUuid)) return conversationUuid;
  }
  for (const [conversationUuid, messages] of cache) {
    if (messages.some((message) => message.messageUuid === messageUuid)) return conversationUuid;
  }
  return undefined;
}

function indexWireKey(cacheKey: string, messageUuid: string): void {
  const owner = conversationOwningMessage(messageUuid);
  if (!owner) return;
  let keys = wireKeysByConversation.get(owner);
  if (!keys) {
    keys = new Set();
    wireKeysByConversation.set(owner, keys);
  }
  keys.add(cacheKey);
}

function unindexWireKey(cacheKey: string): void {
  for (const keys of wireKeysByConversation.values()) keys.delete(cacheKey);
}

function indexDecryptThread(conversationUuid: string, messageUuids: readonly string[]): void {
  const uuids = new Set(messageUuids);
  const found = new Set<string>();
  if (uuids.size > 0) {
    for (const cacheKey of wireDecryptCache.keys()) {
      const uuid = wireUuid(cacheKey);
      if (uuid && uuids.has(uuid)) found.add(cacheKey);
    }
  }
  wireKeysByConversation.set(conversationUuid, found);
  touchDecryptThread(conversationUuid);
  evictDecryptOverflow();
}

function resetDecryptData(): void {
  wireDecryptCache.clear();
  conversationDecryptCache.clear();
  wireKeysByConversation.clear();
  decryptThreadLru.length = 0;
}

export const messageThreadCache = {
  get(conversationUuid: string): MsgMessageDto[] | undefined {
    return cache.get(conversationUuid);
  },
  set(conversationUuid: string, messages: MsgMessageDto[]): void {
    cache.set(conversationUuid, messages);
  },
  append(conversationUuid: string, message: MsgMessageDto): void {
    const prev = cache.get(conversationUuid) ?? [];
    cache.set(conversationUuid, [...prev, message]);
  },
  clear(): void {
    cache.clear();
    resetDecryptData();
    retainedDecryptThreads.clear();
  },
  clearConversation(conversationUuid: string): void {
    const uuids = new Set<string>();
    for (const message of cache.get(conversationUuid) ?? []) uuids.add(message.messageUuid);
    for (const row of conversationDecryptCache.get(conversationUuid) ?? []) uuids.add(row.messageUuid);
    cache.delete(conversationUuid);
    dropDecryptThread(conversationUuid, uuids);
    noteWarmDirty();
  },
  clearDecryptCaches(): void {
    resetDecryptData();
    afterClearDecryptCaches?.();
  },
};

export const messageThreadDecryptCache = {
  get(conversationUuid: string): ThreadBubbleItem[] | undefined {
    return conversationDecryptCache.get(conversationUuid);
  },
  set(conversationUuid: string, rows: ThreadBubbleItem[]): void {
    conversationDecryptCache.set(conversationUuid, rows);
    indexDecryptThread(
      conversationUuid,
      rows.map((row) => row.messageUuid),
    );
    noteWarmDirty();
  },
  /**
   * Сбрасывает только массив fast-path. Wire-ключи остаются: optimistic send
   * пересобирает массив из них после этого вызова.
   */
  clearConversation(conversationUuid: string): void {
    conversationDecryptCache.delete(conversationUuid);
  },
  getMessage(cacheKey: string): ThreadBubbleItem | undefined {
    return wireDecryptCache.get(cacheKey);
  },
  setMessage(cacheKey: string, row: ThreadBubbleItem): void {
    wireDecryptCache.set(cacheKey, row);
    indexWireKey(cacheKey, wireUuid(cacheKey) || row.messageUuid);
    noteWarmDirty();
  },
  deleteMessage(cacheKey: string): void {
    wireDecryptCache.delete(cacheKey);
    unindexWireKey(cacheKey);
    noteWarmDirty();
  },
};

function sealCoveredPage(conversationUuid: string): void {
  const messages = cache.get(conversationUuid);
  if (!messages || messages.length === 0) return;
  const keys = wireKeysByConversation.get(conversationUuid);
  if (!keys) return;
  const byUuid = new Map<string, ThreadBubbleItem>();
  for (const cacheKey of keys) {
    const row = wireDecryptCache.get(cacheKey);
    if (!row || (row.decryptState !== "ok" && row.decryptState !== "failed")) continue;
    byUuid.set(row.messageUuid, row);
  }
  const sealed: ThreadBubbleItem[] = [];
  for (const message of messages) {
    const row = byUuid.get(message.messageUuid);
    if (!row) return;
    sealed.push(row);
  }
  conversationDecryptCache.set(conversationUuid, sealed);
}

/** Хвост, который уже терминален. Новые треды — в конце LRU, в снимок идут первыми. */
export function snapshotDecryptWarm(): PersistedWarmThread[] {
  const newestFirst = [...decryptThreadLru].reverse();
  const threads: PersistedWarmThread[] = [];
  for (const conversationUuid of newestFirst) {
    const keys = wireKeysByConversation.get(conversationUuid);
    if (!keys || keys.size === 0) continue;
    const entries = [];
    for (const cacheKey of keys) {
      const row = wireDecryptCache.get(cacheKey);
      if (!row) continue;
      const persisted = persistWarmRow(cacheKey, row);
      if (persisted) entries.push(persisted);
    }
    if (entries.length === 0) continue;
    threads.push({ conversationUuid, entries });
  }
  return capWarmThreads(threads);
}

/** Поднять снимок в память, не помечая контейнер грязным. */
export function hydrateDecryptWarm(threads: readonly PersistedWarmThread[]): void {
  warmHydrating = true;
  try {
    for (const thread of threads) {
      const uuids: string[] = [];
      for (const entry of thread.entries) {
        const row: ThreadBubbleItem = {
          messageUuid: entry.messageUuid,
          text: entry.text,
          previewText: entry.previewText,
          imageBlocks: entry.imageBlocks,
          voiceBlock: entry.voiceBlock,
          replyTo: entry.replyTo,
          isFromMe: entry.isFromMe,
          createdAt: entry.createdAt,
          decryptState: entry.decryptState,
          isRead: entry.isRead,
          senderUserUuid: entry.senderUserUuid,
          missingFrankReceipt: entry.missingFrankReceipt,
        };
        wireDecryptCache.set(entry.cacheKey, row);
        uuids.push(row.messageUuid);
      }
      if (uuids.length === 0) continue;
      indexDecryptThread(thread.conversationUuid, uuids);
      sealCoveredPage(thread.conversationUuid);
    }
  } finally {
    warmHydrating = false;
  }
}
