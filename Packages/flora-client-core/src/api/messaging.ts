import { authDelete, authGetArrayBuffer, authGetJson, authPostForm, authPostJson } from "./client.js";
import { getApiClientConfig } from "./client.js";
import { asRecord, readBool, readStr } from "../contracts/parse.js";
import {
  parseConversationsPage,
  parseMessagesPage,
  type MsgConversationsPage,
  type MsgMessagesPage,
} from "../contracts/messaging.js";

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

function ctx() {
  return { onPascalFallback: getApiClientConfig().onPascalFallback };
}

export async function apiGetConversations(cursor?: string): Promise<MsgConversationsPage> {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const raw = await authGetJson(`/api/messaging/conversations${q}`);
  return parseConversationsPage(raw, ctx());
}

/** Сервер отдаёт newest-first; UI чата ожидает oldest-first. */
export async function apiGetMessages(
  conversationUuid: string,
  cursor?: string,
  otherUserUuid?: string,
): Promise<MsgMessagesPage> {
  const q = new URLSearchParams();
  if (cursor) q.set("cursor", cursor);
  if (otherUserUuid?.trim()) q.set("otherUserUuid", otherUserUuid.trim());
  const qs = q.toString();
  const raw = await authGetJson(
    `/api/messaging/conversations/${conversationUuid}/messages${qs ? `?${qs}` : ""}`,
  );
  const page = parseMessagesPage(raw, ctx());
  return { ...page, items: [...page.items].reverse() };
}

export async function apiSendMessage(
  conversationUuid: string,
  encryptedForReceiver: string,
  encryptedForSender?: string,
): Promise<unknown> {
  const wire = encryptedForSender ?? encryptedForReceiver;
  return authPostJson(`/api/messaging/conversations/${conversationUuid}/messages`, {
    encryptedForReceiver,
    encryptedForSender: wire,
  });
}

export async function apiMarkConversationRead(conversationUuid: string): Promise<void> {
  await authPostJson(`/api/messaging/conversations/${conversationUuid}/read`, {});
}

export async function apiDeleteMessage(conversationUuid: string, messageUuid: string): Promise<void> {
  const conv = encodeURIComponent(conversationUuid.trim());
  const msg = encodeURIComponent(messageUuid.trim());
  await authDelete(`/api/messaging/conversations/${conv}/messages/${msg}`);
}

export async function apiGetE2EState(): Promise<MsgE2EState> {
  const raw = await authGetJson("/api/messaging/e2e/state");
  const o = asRecord(raw) ?? {};
  const fb = getApiClientConfig().onPascalFallback;
  return {
    state: (readStr(o, ["state", "State"], fb) || "not_initialized") as MsgE2EState["state"],
    freeze: readBool(o, ["freeze", "Freeze"], fb),
    updatedAt: readStr(o, ["updatedAt", "UpdatedAt"], fb),
  };
}

export type EpochIdentityPublicKeyEntry = {
  keyEpochId: string;
  epochAccountIdentityPublicKeyBase64Url: string;
};

export type PutKeyBackupRequest = {
  keyBackup: Record<string, unknown>;
  epochIdentityPublicKeys: EpochIdentityPublicKeyEntry[];
};

export async function apiPutKeyBackup(body: PutKeyBackupRequest): Promise<void> {
  // POST (not PUT): production CDN on social.* returns 405 for PUT on API routes.
  await authPostJson("/api/messaging/e2e/key-backup", body as unknown as Record<string, unknown>);
}

export async function apiGetKeyBackup(): Promise<unknown> {
  return authGetJson("/api/messaging/e2e/key-backup");
}

export async function apiPutRecoveryBackup(body: Record<string, unknown>): Promise<unknown> {
  return authPostJson("/api/messaging/e2e/recovery-backup", body);
}

export async function apiGetRecoveryBackup(): Promise<unknown> {
  return authGetJson("/api/messaging/e2e/recovery-backup");
}

export async function apiArchiveConversation(conversationUuid: string): Promise<void> {
  await authPostJson(`/api/messaging/conversations/${conversationUuid}/archive`, {});
}

export async function apiUnarchiveConversation(conversationUuid: string): Promise<void> {
  await authPostJson(`/api/messaging/conversations/${conversationUuid}/unarchive`, {});
}

export async function apiMuteConversation(conversationUuid: string): Promise<void> {
  await authPostJson(`/api/messaging/conversations/${conversationUuid}/mute`, {});
}

export async function apiUnmuteConversation(conversationUuid: string): Promise<void> {
  await authPostJson(`/api/messaging/conversations/${conversationUuid}/unmute`, {});
}

export type UploadedMessageImageAsset = {
  imageAssetUuid: string;
  contentType: string;
};

export async function apiUploadMessageImageAsset(params: {
  toUserUuid: string;
  encryptedBlob: Blob;
  contentType: string;
}): Promise<UploadedMessageImageAsset> {
  const body = new FormData();
  body.set("toUserUuid", params.toUserUuid);
  body.set("contentType", params.contentType);
  body.set("file", params.encryptedBlob, "message-image.bin");
  const raw = await authPostForm("/api/messaging/image-assets", body);
  const o = asRecord(raw) ?? {};
  const fb = getApiClientConfig().onPascalFallback;
  const imageAssetUuid = readStr(o, ["imageAssetUuid", "ImageAssetUuid"], fb);
  if (!imageAssetUuid) throw new Error("Некорректный ответ сервера при загрузке фото.");
  return {
    imageAssetUuid,
    contentType: readStr(o, ["contentType", "ContentType"], fb) || params.contentType,
  };
}

export async function apiDownloadMessageImageAsset(imageAssetUuid: string): Promise<ArrayBuffer> {
  const id = encodeURIComponent(imageAssetUuid.trim());
  return authGetArrayBuffer(`/api/messaging/image-assets/${id}`);
}

/** GET /api/messaging/unread-count — число чатов с непрочитанным (не сообщений). */
export async function apiMessagingUnreadCount(): Promise<number> {
  const raw = await authGetJson("/api/messaging/unread-count");
  const o = asRecord(raw) ?? {};
  const fb = getApiClientConfig().onPascalFallback;
  const count = o.unreadCount ?? o.UnreadCount ?? o.count ?? o.Count;
  return typeof count === "number" ? count : Number(count) || 0;
}
