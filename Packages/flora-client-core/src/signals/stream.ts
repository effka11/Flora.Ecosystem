import { apiUrl, authFetch } from "../api/client.js";
import { asRecord, readStr } from "../contracts/parse.js";

export type MessageRealtimeSignal = {
  conversationUuid: string;
  senderUserUuid: string;
  sentAt: string;
  kind?: "dm" | "groupChat";
};

export type AppUpdateRealtimePayload = {
  version: string;
  versionCode: number;
  apkUrl: string;
  sha256: string;
  sizeBytes?: number;
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
  /** Sideload metadata when type is app_update (not stored in inbox DB). */
  update?: AppUpdateRealtimePayload | null;
};

export type ConnectedRealtimeSignal = {
  connectionId: string;
};

export type PresenceRealtimeSignal = {
  userUuid: string;
  isOnline: boolean;
  lastSeenAt: string | null;
};

export type TypingRealtimeSignal = {
  conversationUuid: string;
  userUuid: string;
  isTyping: boolean;
};

export type ReadRealtimeSignal = {
  conversationUuid: string;
  readerUserUuid: string;
};

export type NotificationRemovedRealtimeSignal = {
  notificationUuid: string;
  groupKey: string | null;
};

export type ConnectSignalsStreamOptions = {
  onMessage?: (signal: MessageRealtimeSignal) => void;
  onNotification?: (signal: NotificationRealtimeSignal) => void;
  onNotificationRemoved?: (signal: NotificationRemovedRealtimeSignal) => void;
  onConnected?: (signal: ConnectedRealtimeSignal) => void;
  onPresence?: (signal: PresenceRealtimeSignal) => void;
  onTyping?: (signal: TypingRealtimeSignal) => void;
  onRead?: (signal: ReadRealtimeSignal) => void;
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
  const kindRaw = readStr(o, ["kind", "Kind"]).trim().toLowerCase();
  const kind =
    kindRaw === "groupchat" || kindRaw === "group"
      ? ("groupChat" as const)
      : kindRaw === "dm"
        ? ("dm" as const)
        : undefined;
  return { conversationUuid, senderUserUuid, sentAt, kind };
}

function parseAppUpdatePayload(raw: unknown): AppUpdateRealtimePayload | null {
  const o = asRecord(raw);
  if (!o) return null;
  const version = readStr(o, ["version", "Version"]);
  const apkUrl = readStr(o, ["apkUrl", "ApkUrl"]);
  const sha256 = readStr(o, ["sha256", "Sha256"]).toLowerCase();
  const versionCodeRaw = o.versionCode ?? o.VersionCode;
  const versionCode =
    typeof versionCodeRaw === "number"
      ? versionCodeRaw
      : typeof versionCodeRaw === "string"
        ? Number.parseInt(versionCodeRaw, 10)
        : NaN;
  if (!version || !apkUrl || versionCode < 1 || !/^[a-f0-9]{64}$/.test(sha256)) return null;
  const sizeRaw = o.sizeBytes ?? o.SizeBytes;
  const sizeBytes =
    typeof sizeRaw === "number" && sizeRaw > 0
      ? sizeRaw
      : typeof sizeRaw === "string"
        ? Number.parseInt(sizeRaw, 10)
        : undefined;
  return {
    version,
    versionCode,
    apkUrl,
    sha256,
    sizeBytes: sizeBytes && sizeBytes > 0 ? sizeBytes : undefined,
  };
}

function parseNotificationSignal(raw: unknown): NotificationRealtimeSignal | null {
  const o = asRecord(raw);
  if (!o) return null;
  const notificationUuid = readStr(o, ["notificationUuid", "NotificationUuid"]);
  if (!notificationUuid) return null;
  const updateRaw = o.update ?? o.Update;
  return {
    notificationUuid,
    type: readStr(o, ["type", "Type"]) || "default",
    category: readStr(o, ["category", "Category"]) || "social",
    text: readStr(o, ["text", "Text"]),
    actorUserUuid: readStr(o, ["actorUserUuid", "ActorUserUuid"]) || null,
    postUuid: readStr(o, ["postUuid", "PostUuid"]) || null,
    commentUuid: readStr(o, ["commentUuid", "CommentUuid"]) || null,
    createdAt: readStr(o, ["createdAt", "CreatedAt"]),
    update: updateRaw ? parseAppUpdatePayload(updateRaw) : null,
  };
}

function parseConnectedSignal(raw: unknown): ConnectedRealtimeSignal | null {
  const o = asRecord(raw);
  if (!o) return null;
  const connectionId = readStr(o, ["connectionId", "ConnectionId"]);
  if (!connectionId) return null;
  return { connectionId };
}

function parsePresenceSignal(raw: unknown): PresenceRealtimeSignal | null {
  const o = asRecord(raw);
  if (!o) return null;
  const userUuid = readStr(o, ["userUuid", "UserUuid"]);
  if (!userUuid) return null;
  const onlineRaw = o.isOnline ?? o.IsOnline;
  return {
    userUuid,
    isOnline: onlineRaw === true || onlineRaw === "true",
    lastSeenAt: readStr(o, ["lastSeenAt", "LastSeenAt"]) || null,
  };
}

function parseTypingSignal(raw: unknown): TypingRealtimeSignal | null {
  const o = asRecord(raw);
  if (!o) return null;
  const conversationUuid = readStr(o, ["conversationUuid", "ConversationUuid"]);
  const userUuid = readStr(o, ["userUuid", "UserUuid"]);
  if (!conversationUuid || !userUuid) return null;
  const typingRaw = o.isTyping ?? o.IsTyping;
  return {
    conversationUuid,
    userUuid,
    isTyping: typingRaw === true || typingRaw === "true",
  };
}

function parseReadSignal(raw: unknown): ReadRealtimeSignal | null {
  const o = asRecord(raw);
  if (!o) return null;
  const conversationUuid = readStr(o, ["conversationUuid", "ConversationUuid"]);
  const readerUserUuid = readStr(o, ["readerUserUuid", "ReaderUserUuid"]);
  if (!conversationUuid || !readerUserUuid) return null;
  return { conversationUuid, readerUserUuid };
}

function parseNotificationRemovedSignal(
  raw: unknown,
): NotificationRemovedRealtimeSignal | null {
  const o = asRecord(raw);
  if (!o) return null;
  const notificationUuid = readStr(o, ["notificationUuid", "NotificationUuid"]);
  if (!notificationUuid) return null;
  return {
    notificationUuid,
    groupKey: readStr(o, ["groupKey", "GroupKey"]) || null,
  };
}

/** @internal exported for unit tests */
export function parseReadSignalForTest(raw: unknown): ReadRealtimeSignal | null {
  return parseReadSignal(raw);
}

/** @internal exported for unit tests */
export function parseNotificationRemovedSignalForTest(
  raw: unknown,
): NotificationRemovedRealtimeSignal | null {
  return parseNotificationRemovedSignal(raw);
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
  if (eventName === "connected") {
    const signal = parseConnectedSignal(parsed);
    if (signal) options.onConnected?.(signal);
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
    return;
  }
  if (eventName === "notification_removed") {
    const signal = parseNotificationRemovedSignal(parsed);
    if (signal) options.onNotificationRemoved?.(signal);
    return;
  }
  if (eventName === "presence") {
    const signal = parsePresenceSignal(parsed);
    if (signal) options.onPresence?.(signal);
    return;
  }
  if (eventName === "typing") {
    const signal = parseTypingSignal(parsed);
    if (signal) options.onTyping?.(signal);
    return;
  }
  if (eventName === "read") {
    const signal = parseReadSignal(parsed);
    if (signal) options.onRead?.(signal);
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

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { name?: string }).name === "AbortError";
}

/** Never let run() surface as unhandledRejection (devtools / Next overlay). */
function kick(run: () => Promise<void>): void {
  let pending: Promise<void>;
  try {
    pending = run();
  } catch {
    return;
  }
  void pending.catch(() => undefined);
}

export function connectSignalsStream(options: ConnectSignalsStreamOptions = {}): SignalsStreamHandle {
  let closed = false;
  let connected = false;
  let reconnectAttempt = 0;
  let abortController: AbortController | null = null;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleReconnect = () => {
    if (closed) return;
    if (options.enabled && !options.enabled()) return;
    const delayMs = Math.min(30_000, 1_000 * 2 ** reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      kick(run);
    }, delayMs);
  };

  const run = async () => {
    // Entire body sealed — kick() .catch is belt-and-suspenders only.
    try {
      if (closed) return;
      if (options.enabled && !options.enabled()) return;

      const prevAbort = abortController;
      const prevReader = activeReader;
      activeReader = null;
      abortController = new AbortController();
      const signal = abortController.signal;

      // Abort previous after new controller exists so close()/Strict Mode races
      // always have a current signal; swallow prev fetch via its own run() catch.
      void prevReader?.cancel().catch(() => undefined);
      prevAbort?.abort();

      try {
        const response = await authFetch(
          "/api/auth/signals/stream",
          {
            method: "GET",
            headers: { Accept: "text/event-stream" },
            signal,
          },
          options.streamBaseUrl ? { baseUrl: options.streamBaseUrl } : undefined,
        );

        if (closed || signal.aborted) {
          void response.body?.cancel().catch(() => undefined);
          return;
        }

        if (!response.ok || !response.body) {
          throw new Error(`signals stream HTTP ${response.status}`);
        }

        connected = true;
        reconnectAttempt = 0;
        try {
          options.onOpen?.();
        } catch (error) {
          options.onError?.(error);
        }

        const reader = response.body.getReader();
        activeReader = reader;
        const decoder = new TextDecoder();
        let buffer = "";

        while (!closed && !signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          buffer = parseSseChunk(buffer, options);
        }
      } catch (error) {
        if (!closed && !signal.aborted && !isAbortError(error)) {
          try {
            options.onError?.(error);
          } catch {
            // Caller onError must not break reconnect.
          }
        }
      } finally {
        if (activeReader) {
          void activeReader.cancel().catch(() => undefined);
          activeReader = null;
        }
        const wasConnected = connected;
        connected = false;
        if (wasConnected) {
          try {
            options.onClose?.();
          } catch {
            // ignore
          }
        }
        if (!closed) scheduleReconnect();
      }
    } catch {
      // Outer seal: authFetch/proxy/network must never reject the kick() promise.
    }
  };

  kick(run);

  return {
    close() {
      closed = true;
      connected = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      void activeReader?.cancel().catch(() => undefined);
      activeReader = null;
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
