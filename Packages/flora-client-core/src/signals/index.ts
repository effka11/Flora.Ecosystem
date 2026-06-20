import { authGetJson } from "../api/client.js";
import { parseHasNewFeed } from "../contracts/feed.js";
import { parseUnreadCount } from "../contracts/notifications.js";
import { getApiClientConfig } from "../api/client.js";
import { asRecord } from "../contracts/parse.js";

export {
  connectSignalsStream,
  signalsStreamUrl,
  type ConnectSignalsStreamOptions,
  type MessageRealtimeSignal,
  type NotificationRealtimeSignal,
  type SignalsStreamHandle,
} from "./stream.js";

export type SignalsSnapshot = {
  feedHasNew: boolean;
  notificationsUnread: number;
  messagesUnread: number;
};

export type SignalsProvider = {
  poll(): Promise<SignalsSnapshot>;
  subscribe(listener: (snapshot: SignalsSnapshot) => void): () => void;
};

export type PollingSignalsConfig = {
  feedIntervalMs?: number;
  notificationsIntervalMs?: number;
  messagesIntervalMs?: number;
  enabled?: () => boolean;
  /** ISO 8601 UTC — без since feed/has-new не вызывается (API требует параметр). */
  feedSince?: () => string | null | undefined;
};

function parseMessagesUnread(raw: unknown): number {
  const o = asRecord(raw);
  if (!o) return 0;
  const fb = getApiClientConfig().onPascalFallback;
  const count = o.unreadCount ?? o.UnreadCount ?? o.count ?? o.Count;
  if (typeof count === "number") return count;
  const n = Number(count);
  return Number.isFinite(n) ? n : 0;
}

export function createPollingSignalsProvider(config: PollingSignalsConfig = {}): SignalsProvider {
  const feedIntervalMs = config.feedIntervalMs ?? 120_000;
  const notificationsIntervalMs = config.notificationsIntervalMs ?? 120_000;
  const messagesIntervalMs = config.messagesIntervalMs ?? 120_000;
  let snapshot: SignalsSnapshot = { feedHasNew: false, notificationsUnread: 0, messagesUnread: 0 };
  const listeners = new Set<(s: SignalsSnapshot) => void>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const emit = (next: SignalsSnapshot) => {
    snapshot = next;
    listeners.forEach((l) => l(next));
  };

  const poll = async (): Promise<SignalsSnapshot> => {
    if (config.enabled && !config.enabled()) return snapshot;
    const ctx = { onPascalFallback: getApiClientConfig().onPascalFallback };
    const since = config.feedSince?.() ?? null;
    const sinceQuery =
      typeof since === "string" && since.trim().length > 0
        ? `?since=${encodeURIComponent(since.trim())}`
        : null;

    const [feedResult, notifResult, msgResult] = await Promise.allSettled([
      sinceQuery
        ? authGetJson(`/api/auth/feed/has-new${sinceQuery}`)
        : Promise.resolve(null),
      authGetJson("/api/auth/notifications/unread-count"),
      authGetJson("/api/messaging/unread-count"),
    ]);

    const next: SignalsSnapshot = { ...snapshot };
    if (feedResult.status === "fulfilled" && feedResult.value !== null) {
      next.feedHasNew = parseHasNewFeed(feedResult.value, ctx);
    }
    if (notifResult.status === "fulfilled") {
      next.notificationsUnread = parseUnreadCount(notifResult.value, ctx);
    }
    if (msgResult.status === "fulfilled") {
      next.messagesUnread = parseMessagesUnread(msgResult.value);
    }

    emit(next);
    return snapshot;
  };

  const tickMs = Math.min(feedIntervalMs, notificationsIntervalMs, messagesIntervalMs);

  return {
    poll,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      if (!timer) {
        timer = setInterval(() => {
          void poll();
        }, tickMs);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
  };
}

/** Fallback polling when SSE/push unavailable. */
export function createPushSignalsProvider(): SignalsProvider {
  return createPollingSignalsProvider({
    feedIntervalMs: 120_000,
    notificationsIntervalMs: 120_000,
    messagesIntervalMs: 120_000,
  });
}
