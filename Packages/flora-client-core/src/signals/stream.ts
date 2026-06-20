import { apiUrl, authFetch } from "../api/client.js";
import { asRecord, readStr } from "../contracts/parse.js";

export type MessageRealtimeSignal = {
  conversationUuid: string;
  senderUserUuid: string;
  sentAt: string;
};

export type NotificationRealtimeSignal = {
  notificationUuid: string;
  type: string;
  category: string;
  text: string;
  actorUserUuid: string | null;
  postUuid: string | null;
  commentUuid: string | null;
  createdAt: string;
};

export type ConnectSignalsStreamOptions = {
  onMessage?: (signal: MessageRealtimeSignal) => void;
  onNotification?: (signal: NotificationRealtimeSignal) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: unknown) => void;
  enabled?: () => boolean;
  /** Override API host for SSE only (e.g. https://origin.flora-s.net to bypass CDN buffering). */
  streamBaseUrl?: string;
};

export type SignalsStreamHandle = {
  close(): void;
  get connected(): boolean;
};

function parseMessageSignal(raw: unknown): MessageRealtimeSignal | null {
  const o = asRecord(raw);
  if (!o) return null;
  const conversationUuid = readStr(o, ["conversationUuid", "ConversationUuid"]);
  const senderUserUuid = readStr(o, ["senderUserUuid", "SenderUserUuid"]);
  const sentAt = readStr(o, ["sentAt", "SentAt"]);
  if (!conversationUuid || !senderUserUuid) return null;
  return { conversationUuid, senderUserUuid, sentAt };
}

function parseNotificationSignal(raw: unknown): NotificationRealtimeSignal | null {
  const o = asRecord(raw);
  if (!o) return null;
  const notificationUuid = readStr(o, ["notificationUuid", "NotificationUuid"]);
  if (!notificationUuid) return null;
  return {
    notificationUuid,
    type: readStr(o, ["type", "Type"]) || "default",
    category: readStr(o, ["category", "Category"]) || "social",
    text: readStr(o, ["text", "Text"]),
    actorUserUuid: readStr(o, ["actorUserUuid", "ActorUserUuid"]) || null,
    postUuid: readStr(o, ["postUuid", "PostUuid"]) || null,
    commentUuid: readStr(o, ["commentUuid", "CommentUuid"]) || null,
    createdAt: readStr(o, ["createdAt", "CreatedAt"]),
  };
}

function dispatchSseEvent(
  eventName: string,
  data: string,
  options: ConnectSignalsStreamOptions,
): void {
  if (!data.trim()) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }
  if (eventName === "message") {
    const signal = parseMessageSignal(parsed);
    if (signal) options.onMessage?.(signal);
    return;
  }
  if (eventName === "notification") {
    const signal = parseNotificationSignal(parsed);
    if (signal) options.onNotification?.(signal);
  }
}

function parseSseChunk(
  buffer: string,
  options: ConnectSignalsStreamOptions,
): string {
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() ?? "";

  for (const block of blocks) {
    if (!block.trim() || block.trimStart().startsWith(":")) continue;
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length > 0) {
      dispatchSseEvent(eventName, dataLines.join("\n"), options);
    }
  }

  return rest;
}

export function connectSignalsStream(options: ConnectSignalsStreamOptions = {}): SignalsStreamHandle {
  let closed = false;
  let connected = false;
  let reconnectAttempt = 0;
  let abortController: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleReconnect = () => {
    if (closed) return;
    if (options.enabled && !options.enabled()) return;
    const delayMs = Math.min(30_000, 1_000 * 2 ** reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void run();
    }, delayMs);
  };

  const run = async () => {
    if (closed) return;
    if (options.enabled && !options.enabled()) return;

    abortController?.abort();
    abortController = new AbortController();

    try {
      const response = await authFetch(
        "/api/auth/signals/stream",
        {
          method: "GET",
          headers: { Accept: "text/event-stream" },
          signal: abortController.signal,
        },
        options.streamBaseUrl ? { baseUrl: options.streamBaseUrl } : undefined,
      );

      if (!response.ok || !response.body) {
        throw new Error(`signals stream HTTP ${response.status}`);
      }

      connected = true;
      reconnectAttempt = 0;
      options.onOpen?.();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = parseSseChunk(buffer, options);
      }
    } catch (error) {
      if (closed || (error instanceof DOMException && error.name === "AbortError")) return;
      options.onError?.(error);
    } finally {
      const wasConnected = connected;
      connected = false;
      if (wasConnected) options.onClose?.();
      if (!closed) scheduleReconnect();
    }
  };

  void run();

  return {
    close() {
      closed = true;
      connected = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      abortController?.abort();
    },
    get connected() {
      return connected;
    },
  };
}

/** @deprecated use authFetch path via connectSignalsStream */
export function signalsStreamUrl(): string {
  return apiUrl("/api/auth/signals/stream");
}
