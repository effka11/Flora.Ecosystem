import { msgGetMessagesWithUser, type MsgMessagesPage } from "@/lib/messagingApi";

const TTL_MS = 60_000;
/** Ciphertext pages kept in the session. Oldest entries fall out first. */
export const CONVERSATION_THREAD_CACHE_LIMIT = 32;

type CacheEntry = {
  value: MsgMessagesPage;
  fetchedAt: number;
  /** Keep showing this page until the in-flight refresh replaces it. */
  heldForRefresh: boolean;
};

const entries = new Map<string, CacheEntry>();
const inFlights = new Map<string, Promise<MsgMessagesPage>>();
let epoch = 0;

function threadCacheKey(viewerNorm: string, peerUuid: string): string {
  return `${viewerNorm.trim().toLowerCase()}:${peerUuid.trim().toLowerCase()}`;
}

function isVisible(entry: CacheEntry): boolean {
  if (entry.heldForRefresh) return true;
  return Date.now() - entry.fetchedAt < TTL_MS;
}

function evictOverflow(): void {
  while (entries.size > CONVERSATION_THREAD_CACHE_LIMIT) {
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

function commitEntry(key: string, value: MsgMessagesPage, startedEpoch: number): void {
  if (startedEpoch !== epoch) return;
  entries.delete(key);
  entries.set(key, { value, fetchedAt: Date.now(), heldForRefresh: false });
  evictOverflow();
}

export function conversationThreadCacheSize(): number {
  return entries.size;
}

export function clearConversationThreadsCache(): void {
  epoch += 1;
  entries.clear();
  inFlights.clear();
}

export function peekConversationThreadEntry(
  viewerNorm: string,
  peerUuid: string,
): { value: MsgMessagesPage; fetchedAt: number } | null {
  const entry = entries.get(threadCacheKey(viewerNorm, peerUuid));
  if (!entry || !isVisible(entry)) return null;
  return { value: entry.value, fetchedAt: entry.fetchedAt };
}

export function peekConversationThread(viewerNorm: string, peerUuid: string): MsgMessagesPage | null {
  return peekConversationThreadEntry(viewerNorm, peerUuid)?.value ?? null;
}

export function rememberConversationThread(
  viewerNorm: string,
  peerUuid: string,
  value: MsgMessagesPage,
  fetchedAt = Date.now(),
): void {
  const key = threadCacheKey(viewerNorm, peerUuid);
  entries.delete(key);
  entries.set(key, { value, fetchedAt, heldForRefresh: false });
  evictOverflow();
}

function startFetch(
  key: string,
  norm: string,
  peerUuid: string,
  fetchPage: (viewerNorm: string, peerUuid: string) => Promise<MsgMessagesPage>,
): Promise<MsgMessagesPage> {
  const pending = inFlights.get(key);
  if (pending) return pending;
  const startedEpoch = epoch;
  const task = fetchPage(norm, peerUuid)
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

export function preloadConversationThreads(viewerNorm: string, peerUuids: string[]): void {
  const norm = viewerNorm.trim().toLowerCase();
  if (!norm) return;
  const unique = [...new Set(peerUuids.map((id) => id.trim().toLowerCase()).filter(Boolean))];
  for (const peerUuid of unique) {
    const key = threadCacheKey(norm, peerUuid);
    const entry = entries.get(key);
    if (entry && isVisible(entry) && !entry.heldForRefresh) continue;
    if (inFlights.has(key)) continue;
    void startFetch(key, norm, peerUuid, msgGetMessagesWithUser).catch(() => {});
  }
}

export async function getConversationThread(
  viewerNorm: string,
  peerUuid: string,
): Promise<MsgMessagesPage> {
  const norm = viewerNorm.trim().toLowerCase();
  const key = threadCacheKey(norm, peerUuid);
  const entry = entries.get(key);
  if (entry?.heldForRefresh) {
    const pending = inFlights.get(key);
    if (pending) return pending;
  }
  if (entry && isVisible(entry)) return entry.value;
  return startFetch(key, norm, peerUuid, msgGetMessagesWithUser);
}

/**
 * One background GET for a closed chat. The page already in memory stays
 * readable until this request resolves.
 */
export function revalidateConversationThread(
  viewerNorm: string,
  peerUuid: string,
  fetchPage: (viewerNorm: string, peerUuid: string) => Promise<MsgMessagesPage> = msgGetMessagesWithUser,
): void {
  const norm = viewerNorm.trim().toLowerCase();
  const peer = peerUuid.trim().toLowerCase();
  if (!norm || !peer) return;
  const key = threadCacheKey(norm, peer);
  const entry = entries.get(key);
  if (!entry || !isVisible(entry) || entry.heldForRefresh) return;
  if (inFlights.has(key)) return;
  entry.heldForRefresh = true;
  void startFetch(key, norm, peer, fetchPage).catch(() => {
    const current = entries.get(key);
    if (current) current.heldForRefresh = false;
  });
}

export function invalidateConversationThread(viewerNorm: string, peerUuid: string): void {
  const key = threadCacheKey(viewerNorm, peerUuid);
  entries.delete(key);
  inFlights.delete(key);
}
