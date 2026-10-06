import { apiGetGroupMessages } from "@flora/client-core/api";
import type { MsgGroupMessage, MsgGroupMessagesPage } from "@flora/client-core/contracts";

const TTL_MS = 60_000;
/** Group ciphertext pages kept in the session. Oldest entries fall out first. */
export const GROUP_THREAD_CACHE_LIMIT = 32;

type CacheEntry = {
  value: MsgGroupMessagesPage;
  fetchedAt: number;
  heldForRefresh: boolean;
};

const entries = new Map<string, CacheEntry>();
const inFlights = new Map<string, Promise<MsgGroupMessagesPage>>();
let epoch = 0;

function threadCacheKey(viewerNorm: string, conversationUuid: string): string {
  return `group:${viewerNorm.trim().toLowerCase()}:${conversationUuid.trim().toLowerCase()}`;
}

function isVisible(entry: CacheEntry): boolean {
  if (entry.heldForRefresh) return true;
  return Date.now() - entry.fetchedAt < TTL_MS;
}

function evictOverflow(): void {
  while (entries.size > GROUP_THREAD_CACHE_LIMIT) {
    let oldest: string | undefined;
    for (const key of entries.keys()) {
      if (entries.get(key)?.heldForRefresh) continue;
      oldest = key;
      break;
    }
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

function commitEntry(key: string, value: MsgGroupMessagesPage, startedEpoch: number): void {
  if (startedEpoch !== epoch) return;
  entries.delete(key);
  entries.set(key, { value, fetchedAt: Date.now(), heldForRefresh: false });
  evictOverflow();
}

export function groupThreadCacheSize(): number {
  return entries.size;
}

export function clearGroupThreadsCache(): void {
  epoch += 1;
  entries.clear();
  inFlights.clear();
}

export function peekGroupConversationThreadEntry(
  viewerNorm: string,
  conversationUuid: string,
): { value: MsgGroupMessagesPage; fetchedAt: number } | null {
  const entry = entries.get(threadCacheKey(viewerNorm, conversationUuid));
  if (!entry || !isVisible(entry)) return null;
  return { value: entry.value, fetchedAt: entry.fetchedAt };
}

export function peekGroupConversationThread(
  viewerNorm: string,
  conversationUuid: string,
): MsgGroupMessagesPage | null {
  return peekGroupConversationThreadEntry(viewerNorm, conversationUuid)?.value ?? null;
}

export function rememberGroupConversationThread(
  viewerNorm: string,
  conversationUuid: string,
  value: MsgGroupMessagesPage,
  fetchedAt = Date.now(),
): void {
  const key = threadCacheKey(viewerNorm, conversationUuid);
  entries.delete(key);
  entries.set(key, { value, fetchedAt, heldForRefresh: false });
  evictOverflow();
}

function startFetch(
  key: string,
  conversationUuid: string,
  fetchPage: (conversationUuid: string) => Promise<MsgGroupMessagesPage>,
): Promise<MsgGroupMessagesPage> {
  const pending = inFlights.get(key);
  if (pending) return pending;
  const startedEpoch = epoch;
  const task = fetchPage(conversationUuid)
    .then((value) => {
      commitEntry(key, value, startedEpoch);
      return value;
    })
    .finally(() => {
      if (inFlights.get(key) === task) inFlights.delete(key);
    });
  inFlights.set(key, task);
  return task;
}

export function preloadGroupConversationThreads(
  viewerNorm: string,
  conversationUuids: string[],
): void {
  const norm = viewerNorm.trim().toLowerCase();
  if (!norm) return;
  const unique = [...new Set(conversationUuids.map((id) => id.trim().toLowerCase()).filter(Boolean))];
  for (const conversationUuid of unique) {
    const key = threadCacheKey(norm, conversationUuid);
    const entry = entries.get(key);
    if (entry && isVisible(entry) && !entry.heldForRefresh) continue;
    if (inFlights.has(key)) continue;
    void startFetch(key, conversationUuid, apiGetGroupMessages).catch(() => {});
  }
}

export async function getGroupConversationThread(
  viewerNorm: string,
  conversationUuid: string,
): Promise<MsgGroupMessagesPage> {
  const key = threadCacheKey(viewerNorm, conversationUuid);
  const entry = entries.get(key);
  if (entry?.heldForRefresh) {
    const pending = inFlights.get(key);
    if (pending) return pending;
  }
  if (entry && isVisible(entry)) return entry.value;
  return startFetch(key, conversationUuid.trim(), apiGetGroupMessages);
}

export function revalidateGroupConversationThread(
  viewerNorm: string,
  conversationUuid: string,
  fetchPage: (conversationUuid: string) => Promise<MsgGroupMessagesPage> = apiGetGroupMessages,
): void {
  const norm = viewerNorm.trim().toLowerCase();
  const conversation = conversationUuid.trim().toLowerCase();
  if (!norm || !conversation) return;
  const key = threadCacheKey(norm, conversation);
  const entry = entries.get(key);
  if (!entry || !isVisible(entry) || entry.heldForRefresh) return;
  if (inFlights.has(key)) return;
  entry.heldForRefresh = true;
  void startFetch(key, conversation, fetchPage).catch(() => {
    const current = entries.get(key);
    if (current) current.heldForRefresh = false;
  });
}

export function invalidateGroupConversationThread(
  viewerNorm: string,
  conversationUuid: string,
): void {
  const key = threadCacheKey(viewerNorm, conversationUuid);
  entries.delete(key);
  inFlights.delete(key);
}

export type { MsgGroupMessage, MsgGroupMessagesPage };
