import { msgGetMessagesWithUser, type MsgMessagesPage } from "@/lib/messagingApi";

const TTL_MS = 60_000;

type CacheEntry = {
  value: MsgMessagesPage;
  fetchedAt: number;
};

const entries = new Map<string, CacheEntry>();
const inFlights = new Map<string, Promise<MsgMessagesPage>>();

function threadCacheKey(viewerNorm: string, peerUuid: string): string {
  return `${viewerNorm.trim().toLowerCase()}:${peerUuid.trim().toLowerCase()}`;
}

function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt < TTL_MS;
}

export function peekConversationThread(viewerNorm: string, peerUuid: string): MsgMessagesPage | null {
  const key = threadCacheKey(viewerNorm, peerUuid);
  const entry = entries.get(key);
  if (!entry || !isFresh(entry)) return null;
  return entry.value;
}

export function preloadConversationThreads(viewerNorm: string, peerUuids: string[]): void {
  const norm = viewerNorm.trim().toLowerCase();
  if (!norm) return;
  const unique = [...new Set(peerUuids.map((id) => id.trim().toLowerCase()).filter(Boolean))];
  for (const peerUuid of unique) {
    const key = threadCacheKey(norm, peerUuid);
    const entry = entries.get(key);
    if (entry && isFresh(entry)) continue;
    if (inFlights.has(key)) continue;
    const task = msgGetMessagesWithUser(norm, peerUuid)
      .then((value) => {
        entries.set(key, { value, fetchedAt: Date.now() });
        return value;
      })
      .finally(() => {
        inFlights.delete(key);
      });
    inFlights.set(key, task);
    void task.catch(() => {});
  }
}

export async function getConversationThread(
  viewerNorm: string,
  peerUuid: string,
): Promise<MsgMessagesPage> {
  const norm = viewerNorm.trim().toLowerCase();
  const key = threadCacheKey(norm, peerUuid);
  const entry = entries.get(key);
  if (entry && isFresh(entry)) return entry.value;
  const pending = inFlights.get(key);
  if (pending) return pending;
  const task = msgGetMessagesWithUser(norm, peerUuid)
    .then((value) => {
      entries.set(key, { value, fetchedAt: Date.now() });
      return value;
    })
    .finally(() => {
      inFlights.delete(key);
    });
  inFlights.set(key, task);
  return task;
}

export function invalidateConversationThread(viewerNorm: string, peerUuid: string): void {
  const key = threadCacheKey(viewerNorm, peerUuid);
  entries.delete(key);
  inFlights.delete(key);
}
