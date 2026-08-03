import { apiGetGroupMessages } from "@flora/client-core/api";
import type { MsgGroupMessage, MsgGroupMessagesPage } from "@flora/client-core/contracts";

const TTL_MS = 60_000;

type CacheEntry = {
  value: MsgGroupMessagesPage;
  fetchedAt: number;
};

const entries = new Map<string, CacheEntry>();
const inFlights = new Map<string, Promise<MsgGroupMessagesPage>>();

function threadCacheKey(viewerNorm: string, conversationUuid: string): string {
  return `group:${viewerNorm.trim().toLowerCase()}:${conversationUuid.trim().toLowerCase()}`;
}

function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt < TTL_MS;
}

export async function getGroupConversationThread(
  viewerNorm: string,
  conversationUuid: string,
): Promise<MsgGroupMessagesPage> {
  const norm = viewerNorm.trim().toLowerCase();
  const key = threadCacheKey(norm, conversationUuid);
  const entry = entries.get(key);
  if (entry && isFresh(entry)) return entry.value;
  const pending = inFlights.get(key);
  if (pending) return pending;
  const task = apiGetGroupMessages(conversationUuid)
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

export function invalidateGroupConversationThread(
  viewerNorm: string,
  conversationUuid: string,
): void {
  const key = threadCacheKey(viewerNorm, conversationUuid);
  entries.delete(key);
  inFlights.delete(key);
}

export type { MsgGroupMessage, MsgGroupMessagesPage };
