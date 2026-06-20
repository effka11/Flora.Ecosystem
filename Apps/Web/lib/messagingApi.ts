/**
 * Typed API client for /api/messaging — FSCP-compliant messaging endpoints.
 * Replaces the legacy /api/auth/conversations calls in socialApi.ts.
 * All functions require an active JWT session (same auth mechanics as socialApi.ts).
 */

import {
  ApiRequestError,
  clearSession,
  getAccessToken,
  refreshSessionIfPossible,
  resolvePublicApiRoot,
} from "@/lib/auth";
import { dmConversationUuid } from "@/lib/fscp/deriveIds";

// ── HTTP helpers (mirrors socialApi.ts pattern) ───────────────────────────────

function apiUrl(path: string): string {
  const root = resolvePublicApiRoot();
  return root ? `${root}${path}` : path;
}

type ApiError = { error?: string; detail?: string; Detail?: string };

async function parseErr(r: Response): Promise<string> {
  const data = (await r.json().catch(() => ({}))) as ApiError;
  const base =
    typeof data.error === "string" ? data.error : `Ошибка ${r.status}`;
  const detailRaw = data.detail ?? data.Detail;
  const detail =
    typeof detailRaw === "string" && detailRaw.trim().length > 0
      ? detailRaw.trim()
      : "";
  if (detail.length === 0) return base;
  if (base.includes(detail)) return base;
  return `${base} (${detail})`;
}

async function authGetJson(url: string): Promise<unknown> {
  let token = getAccessToken();
  if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");
  const headers = (t: string) => ({ Authorization: `Bearer ${t}` });
  let r = await fetch(url, { headers: headers(token) });
  if (r.status === 401) {
    if (await refreshSessionIfPossible()) {
      token = getAccessToken();
      if (token) r = await fetch(url, { headers: headers(token) });
    }
  }
  if (!r.ok) {
    if (r.status === 401) clearSession();
    throw new ApiRequestError(r.status, await parseErr(r));
  }
  return r.json().catch(() => ({}));
}

async function authPostJson(
  url: string,
  body: Record<string, unknown>
): Promise<unknown> {
  let token = getAccessToken();
  if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");
  const init = (t: string): RequestInit => ({
    method: "POST",
    headers: {
      Authorization: `Bearer ${t}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  let r = await fetch(url, init(token));
  if (r.status === 401) {
    if (await refreshSessionIfPossible()) {
      token = getAccessToken();
      if (token) r = await fetch(url, init(token));
    }
  }
  if (!r.ok) {
    if (r.status === 401) clearSession();
    throw new ApiRequestError(r.status, await parseErr(r));
  }
  return r.json().catch(() => ({}));
}

async function authPost204(url: string): Promise<void> {
  let token = getAccessToken();
  if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");
  const init = (t: string): RequestInit => ({
    method: "POST",
    headers: { Authorization: `Bearer ${t}` },
  });
  let r = await fetch(url, init(token));
  if (r.status === 401) {
    if (await refreshSessionIfPossible()) {
      token = getAccessToken();
      if (token) r = await fetch(url, init(token));
    }
  }
  if (!r.ok) {
    if (r.status === 401) clearSession();
    throw new ApiRequestError(r.status, await parseErr(r));
  }
}

async function authDelete(url: string): Promise<void> {
  let token = getAccessToken();
  if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");
  const init = (t: string): RequestInit => ({
    method: "DELETE",
    headers: { Authorization: `Bearer ${t}` },
  });
  let r = await fetch(url, init(token));
  if (r.status === 401) {
    if (await refreshSessionIfPossible()) {
      token = getAccessToken();
      if (token) r = await fetch(url, init(token));
    }
  }
  if (!r.ok) {
    if (r.status === 401) clearSession();
    throw new ApiRequestError(r.status, await parseErr(r));
  }
}

function readStr(o: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string") return v;
  }
  return "";
}

function readNum(o: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return 0;
}

function readBool(o: Record<string, unknown>, keys: string[]): boolean {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "boolean") return v;
  }
  return false;
}

// ── DTOs ──────────────────────────────────────────────────────────────────────

/** Entry in the conversation list (GET /api/messaging/conversations). */
export type MsgConversationDto = {
  /** Deterministic UuidV5(A, B, "fscp-dm-v1"). */
  conversationUuid: string;
  otherUserUuid: string;
  otherUsername: string;
  otherDisplayName: string;
  otherAvatarUuid: string | null;
  lastMessageEncryptedForMe: string | null;
  lastMessageContent: string | null;
  lastMessageAt: string;
  lastMessageIsFromMe: boolean;
  unreadCount: number;
  otherUserIsOnline: boolean;
  otherUserLastSeenAt: string | null;
};

/** Paged response for conversation list. */
export type MsgConversationsPage = {
  items: MsgConversationDto[];
  nextCursor: string | null;
  hasMore: boolean;
};

/** A single message in a thread (GET /api/messaging/conversations/{id}/messages). */
export type MsgMessageDto = {
  messageUuid: string;
  senderUserUuid: string;
  encryptedForMe: string | null;
  content: string | null;
  createdAt: string;
  isRead: boolean;
  isFromMe: boolean;
  voiceAssetUuids: string[];
  imageAssetUuids: string[];
  videoAssetUuids: string[];
};

/** Paged response for a message thread. */
export type MsgMessagesPage = {
  items: MsgMessageDto[];
  nextCursor: string | null;
  hasMore: boolean;
};

/** Response after successfully sending a message. */
export type MsgSentMessageDto = {
  messageUuid: string;
  createdAt: string;
  encryptedForMe: string;
};

// ── Parsers ───────────────────────────────────────────────────────────────────

function parseConversation(raw: unknown): MsgConversationDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const conversationUuid = readStr(o, ["conversationUuid"]);
  const otherUserUuid = readStr(o, ["otherUserUuid"]);
  if (!conversationUuid || !otherUserUuid) return null;
  const enc = readStr(o, ["lastMessageEncryptedForMe"]);
  const content = readStr(o, ["lastMessageContent"]);
  const avatar = readStr(o, ["otherAvatarUuid"]);
  return {
    conversationUuid,
    otherUserUuid,
    otherUsername: readStr(o, ["otherUsername"]),
    otherDisplayName: readStr(o, ["otherDisplayName"]),
    otherAvatarUuid: avatar.length > 0 ? avatar : null,
    lastMessageEncryptedForMe: enc.length > 0 ? enc : null,
    lastMessageContent: content.length > 0 ? content : null,
    lastMessageAt: readStr(o, ["lastMessageAt"]),
    lastMessageIsFromMe: readBool(o, ["lastMessageIsFromMe"]),
    unreadCount: readNum(o, ["unreadCount"]),
    otherUserIsOnline: readBool(o, ["otherUserIsOnline", "OtherUserIsOnline"]),
    otherUserLastSeenAt: (() => {
      const v = readStr(o, ["otherUserLastSeenAt", "OtherUserLastSeenAt"]);
      return v.length > 0 ? v : null;
    })(),
  };
}

function parseMessage(raw: unknown): MsgMessageDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const messageUuid = readStr(o, ["messageUuid"]);
  if (!messageUuid) return null;
  const enc = readStr(o, ["encryptedForMe"]);
  const content = readStr(o, ["content"]);
  const voiceAssetUuids: string[] = [];
  if (Array.isArray(o["voiceAssetUuids"])) {
    for (const v of o["voiceAssetUuids"]) {
      if (typeof v === "string") voiceAssetUuids.push(v);
    }
  }
  const imageAssetUuids: string[] = [];
  if (Array.isArray(o["imageAssetUuids"])) {
    for (const v of o["imageAssetUuids"]) {
      if (typeof v === "string") imageAssetUuids.push(v);
    }
  }
  const videoAssetUuids: string[] = [];
  if (Array.isArray(o["videoAssetUuids"])) {
    for (const v of o["videoAssetUuids"]) {
      if (typeof v === "string") videoAssetUuids.push(v);
    }
  }
  return {
    messageUuid,
    senderUserUuid: readStr(o, ["senderUserUuid"]),
    encryptedForMe: enc.length > 0 ? enc : null,
    content: content.length > 0 ? content : null,
    createdAt: readStr(o, ["createdAt"]),
    isRead: readBool(o, ["isRead"]),
    isFromMe: readBool(o, ["isFromMe"]),
    voiceAssetUuids,
    imageAssetUuids,
    videoAssetUuids,
  };
}

// ── API functions ─────────────────────────────────────────────────────────────

/**
 * GET /api/messaging/conversations
 * Returns cursor-paged conversation list, newest first.
 */
export async function msgGetConversations(
  cursor?: string | null,
  take = 50
): Promise<MsgConversationsPage> {
  const q = new URLSearchParams({ take: String(take) });
  if (cursor) q.set("cursor", cursor);
  const raw = (await authGetJson(
    apiUrl(`/api/messaging/conversations?${q}`)
  )) as Record<string, unknown>;

  const items: MsgConversationDto[] = [];
  if (Array.isArray(raw["items"])) {
    for (const x of raw["items"]) {
      const p = parseConversation(x);
      if (p) items.push(p);
    }
  }
  const nextCursor = readStr(raw, ["nextCursor"]);
  return {
    items,
    nextCursor: nextCursor.length > 0 ? nextCursor : null,
    hasMore: readBool(raw, ["hasMore"]),
  };
}

/**
 * GET /api/messaging/conversations/{conversationUuid}/messages
 * Returns cursor-paged messages for a conversation, newest first.
 * Call with the UUID of the other participant to derive conversationUuid automatically.
 */
export async function msgGetMessages(
  conversationUuid: string,
  cursor?: string | null,
  take = 50,
  otherUserUuid?: string | null
): Promise<MsgMessagesPage> {
  const q = new URLSearchParams({ take: String(take) });
  if (cursor) q.set("cursor", cursor);
  if (otherUserUuid?.trim()) q.set("otherUserUuid", otherUserUuid.trim());
  const raw = (await authGetJson(
    apiUrl(
      `/api/messaging/conversations/${encodeURIComponent(conversationUuid)}/messages?${q}`
    )
  )) as Record<string, unknown>;

  const items: MsgMessageDto[] = [];
  if (Array.isArray(raw["items"])) {
    for (const x of raw["items"]) {
      const p = parseMessage(x);
      if (p) items.push(p);
    }
  }
  const nextCursor = readStr(raw, ["nextCursor"]);
  return {
    items: items.reverse(), // server returns newest-first; UI wants oldest-first
    nextCursor: nextCursor.length > 0 ? nextCursor : null,
    hasMore: readBool(raw, ["hasMore"]),
  };
}

/**
 * POST /api/messaging/conversations/{conversationUuid}/messages
 * Sends an E2E-encrypted message (FSCP v1 dual-wire).
 */
export type MsgSendAttachments = {
  voiceAssetUuids?: string[];
  imageAssetUuids?: string[];
  videoAssetUuids?: string[];
};

export async function msgSendMessage(
  conversationUuid: string,
  encryptedForReceiver: string,
  encryptedForSender: string,
  attachments: MsgSendAttachments = {},
  pushPreview?: string
): Promise<MsgSentMessageDto> {
  const voiceAssetUuids = attachments.voiceAssetUuids ?? [];
  const imageAssetUuids = attachments.imageAssetUuids ?? [];
  const videoAssetUuids = attachments.videoAssetUuids ?? [];
  const body: Record<string, unknown> = {
    encryptedForReceiver,
    encryptedForSender,
    voiceAssetUuids,
    imageAssetUuids,
    videoAssetUuids,
  };
  const preview = pushPreview?.trim();
  if (preview) body.pushPreview = preview;
  const raw = (await authPostJson(
    apiUrl(
      `/api/messaging/conversations/${encodeURIComponent(conversationUuid)}/messages`
    ),
    body
  )) as Record<string, unknown>;
  return {
    messageUuid: readStr(raw, ["messageUuid"]),
    createdAt: readStr(raw, ["createdAt"]),
    encryptedForMe: readStr(raw, ["encryptedForMe"]),
  };
}

/**
 * POST /api/messaging/conversations/{conversationUuid}/read
 * Marks all incoming messages in the conversation as read.
 */
export async function msgMarkRead(
  conversationUuid: string,
  otherUserUuid?: string | null
): Promise<void> {
  const q = otherUserUuid?.trim()
    ? `?otherUserUuid=${encodeURIComponent(otherUserUuid.trim())}`
    : "";
  await authPost204(
    apiUrl(
      `/api/messaging/conversations/${encodeURIComponent(conversationUuid)}/read${q}`
    )
  );
}

/**
 * Convenience: derives conversationUuid from two user UUIDs and sends the message.
 * Equivalent to calling dmConversationUuid then msgSendMessage.
 */
export async function msgSendMessageToUser(
  myUuid: string,
  otherUserUuid: string,
  wire: string,
  attachments: MsgSendAttachments = {},
  pushPreview?: string
): Promise<MsgSentMessageDto> {
  const conversationUuid = dmConversationUuid(myUuid, otherUserUuid);
  return msgSendMessage(conversationUuid, wire, wire, attachments, pushPreview);
}

/**
 * Convenience: derives conversationUuid and marks the conversation as read.
 */
export async function msgMarkReadForUser(
  myUuid: string,
  otherUserUuid: string
): Promise<void> {
  const conversationUuid = dmConversationUuid(myUuid, otherUserUuid);
  return msgMarkRead(conversationUuid, otherUserUuid);
}

/** DELETE /api/messaging/conversations/{conversationUuid}/messages/{messageUuid} */
export async function msgDeleteMessage(
  conversationUuid: string,
  messageUuid: string,
): Promise<void> {
  await authDelete(
    apiUrl(
      `/api/messaging/conversations/${encodeURIComponent(conversationUuid)}/messages/${encodeURIComponent(messageUuid)}`,
    ),
  );
}

export async function msgDeleteMessageForUser(
  myUuid: string,
  otherUserUuid: string,
  messageUuid: string,
): Promise<void> {
  const conversationUuid = dmConversationUuid(myUuid, otherUserUuid);
  return msgDeleteMessage(conversationUuid, messageUuid);
}

/**
 * Convenience: derives conversationUuid and fetches messages for an (otherUserUuid) conversation.
 */
export async function msgGetMessagesWithUser(
  myUuid: string,
  otherUserUuid: string,
  cursor?: string | null,
  take = 50
): Promise<MsgMessagesPage> {
  const conversationUuid = dmConversationUuid(myUuid, otherUserUuid);
  return msgGetMessages(conversationUuid, cursor, take, otherUserUuid);
}

// ── E2E account state & key backup ───────────────────────────────────────────

export type MsgE2EState = {
  state:
    | "not_initialized"
    | "active"
    | "locked"
    | "active_new_epoch"
    | "recovering"
    | "rotating"
    | "frozen";
  freeze: boolean;
  updatedAt: string;
};

async function authPutJson(
  url: string,
  body: Record<string, unknown>
): Promise<unknown> {
  let token = getAccessToken();
  if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");
  const init = (t: string): RequestInit => ({
    method: "PUT",
    headers: {
      Authorization: `Bearer ${t}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  let r = await fetch(url, init(token));
  if (r.status === 401) {
    if (await refreshSessionIfPossible()) {
      token = getAccessToken();
      if (token) r = await fetch(url, init(token));
    }
  }
  if (!r.ok) {
    if (r.status === 401) clearSession();
    throw new ApiRequestError(r.status, await parseErr(r));
  }
  return r.json().catch(() => ({}));
}

/** GET /api/messaging/e2e/state */
export async function msgGetE2EState(): Promise<MsgE2EState> {
  const raw = (await authGetJson(apiUrl("/api/messaging/e2e/state"))) as Record<
    string,
    unknown
  >;
  return {
    state: (readStr(raw, ["state"]) || "not_initialized") as MsgE2EState["state"],
    freeze: readBool(raw, ["freeze"]),
    updatedAt: readStr(raw, ["updatedAt"]),
  };
}

/** GET /api/messaging/e2e/key-backup */
export async function msgGetKeyBackup(): Promise<unknown> {
  return authGetJson(apiUrl("/api/messaging/e2e/key-backup"));
}

/** POST /api/messaging/e2e/key-backup (POST: CDN blocks PUT on social.*) */
export async function msgPutKeyBackup(request: {
  keyBackup: unknown;
  epochIdentityPublicKeys?: { keyEpochId: string; epochAccountIdentityPublicKeyBase64Url: string }[];
}): Promise<void> {
  await authPostJson(
    apiUrl("/api/messaging/e2e/key-backup"),
    request as Record<string, unknown>
  );
}

/** GET /api/messaging/e2e/recovery-backups */
export async function msgGetRecoveryBackups(): Promise<unknown[]> {
  const raw = (await authGetJson(
    apiUrl("/api/messaging/e2e/recovery-backups")
  )) as unknown[];
  return Array.isArray(raw) ? raw : [];
}

/** GET /api/messaging/e2e/recovery-backup/{recoveryKeyId} */
export async function msgGetRecoveryBackup(recoveryKeyId: string): Promise<unknown> {
  return authGetJson(
    apiUrl(
      `/api/messaging/e2e/recovery-backup/${encodeURIComponent(recoveryKeyId)}`
    )
  );
}

/** PUT /api/messaging/e2e/recovery-backup */
export async function msgPutRecoveryBackup(payload: unknown): Promise<void> {
  await authPutJson(
    apiUrl("/api/messaging/e2e/recovery-backup"),
    payload as Record<string, unknown>
  );
}

/** POST /api/messaging/e2e/lock */
export async function msgLockE2E(): Promise<void> {
  await authPost204(apiUrl("/api/messaging/e2e/lock"));
}

// ── Phase 3: epochs & unlock ─────────────────────────────────────────────────

/** POST /api/messaging/e2e/unlock-complete/challenge */
export async function msgRequestUnlockChallenge(): Promise<{
  challengeId: string;
  resetRequestId: string;
  expiresAt: string;
  canonicalPayloadPreview: string;
}> {
  const raw = (await authPostJson(
    apiUrl("/api/messaging/e2e/unlock-complete/challenge"),
    {}
  )) as Record<string, unknown>;
  return {
    challengeId: readStr(raw, ["challengeId"]),
    resetRequestId: readStr(raw, ["resetRequestId"]),
    expiresAt: readStr(raw, ["expiresAt"]),
    canonicalPayloadPreview: readStr(raw, ["canonicalPayloadPreview"]),
  };
}

/** POST /api/messaging/e2e/unlock-complete */
export async function msgUnlockComplete(body: Record<string, unknown>): Promise<void> {
  await authPostJson(apiUrl("/api/messaging/e2e/unlock-complete"), body);
}

/** POST /api/messaging/e2e/epochs */
export async function msgCreateEpoch(body: Record<string, unknown>): Promise<void> {
  await authPostJson(apiUrl("/api/messaging/e2e/epochs"), body);
}

/** GET /api/messaging/unread-count — число чатов с непрочитанным (не сообщений). */
export async function apiGetMessagingUnreadCount(): Promise<number> {
  const raw = (await authGetJson(apiUrl("/api/messaging/unread-count"))) as Record<string, unknown>;
  const count = raw.unreadCount ?? raw.UnreadCount ?? raw.count ?? raw.Count;
  return typeof count === "number" ? count : Number(count) || 0;
}

export const MESSAGES_UNREAD_CHANGED_EVENT = "flora:messages-changed";

export type MessagesChangedDetail = {
  conversationUuid?: string;
  senderUserUuid?: string;
};

export function notifyMessagesUnreadChanged(detail?: MessagesChangedDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<MessagesChangedDetail>(MESSAGES_UNREAD_CHANGED_EVENT, { detail }));
}
