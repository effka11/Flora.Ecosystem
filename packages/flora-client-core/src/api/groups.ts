import { asRecord, readNum, readStr } from "../contracts/parse.js";
import {
  authDelete,
  authGetJson,
  authPatchJson,
  authPostForm,
  authPostJson,
  getApiClientConfig,
} from "./client.js";
import {
  parseGroupDetail,
  parseGroupMessagesPage,
  parseGroupSendResult,
  parseGroupsPage,
  type MsgGroupDetail,
  type MsgGroupListItem,
  type MsgGroupMessagesPage,
  type MsgGroupSendResult,
} from "../contracts/groups.js";
import type { UploadedMessageImageAsset } from "./messaging.js";
import type { UploadedMessageVoiceAsset } from "./voiceAssets.js";

function ctx() {
  return { onPascalFallback: getApiClientConfig().onPascalFallback };
}

export async function apiListGroups(): Promise<MsgGroupListItem[]> {
  const raw = await authGetJson("/api/messaging/groups");
  return parseGroupsPage(raw, ctx());
}

export async function apiCreateGroup(params: {
  title?: string;
  memberUserUuids: string[];
}): Promise<MsgGroupDetail> {
  const raw = await authPostJson("/api/messaging/groups", {
    title: params.title ?? null,
    memberUserUuids: params.memberUserUuids,
  });
  return parseGroupDetail(raw, ctx());
}

export async function apiGetGroup(conversationUuid: string): Promise<MsgGroupDetail> {
  const raw = await authGetJson(
    `/api/messaging/groups/${encodeURIComponent(conversationUuid.trim())}`,
  );
  return parseGroupDetail(raw, ctx());
}

export async function apiPatchGroupTitle(
  conversationUuid: string,
  title: string,
): Promise<MsgGroupDetail> {
  const raw = await authPatchJson(
    `/api/messaging/groups/${encodeURIComponent(conversationUuid.trim())}`,
    { title },
  );
  return parseGroupDetail(raw, ctx());
}

export async function apiAddGroupMember(
  conversationUuid: string,
  userUuid: string,
): Promise<MsgGroupDetail> {
  const raw = await authPostJson(
    `/api/messaging/groups/${encodeURIComponent(conversationUuid.trim())}/members`,
    { userUuid },
  );
  return parseGroupDetail(raw, ctx());
}

export async function apiRemoveGroupMember(
  conversationUuid: string,
  userUuid: string,
): Promise<void> {
  const conv = encodeURIComponent(conversationUuid.trim());
  const user = encodeURIComponent(userUuid.trim());
  await authDelete(`/api/messaging/groups/${conv}/members/${user}`);
}

export async function apiLeaveGroup(conversationUuid: string): Promise<void> {
  await authPostJson(
    `/api/messaging/groups/${encodeURIComponent(conversationUuid.trim())}/leave`,
    {},
  );
}

export async function apiGetGroupMessages(
  conversationUuid: string,
  cursor?: string,
): Promise<MsgGroupMessagesPage> {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const raw = await authGetJson(
    `/api/messaging/groups/${encodeURIComponent(conversationUuid.trim())}/messages${q}`,
  );
  const page = parseGroupMessagesPage(raw, ctx());
  // Server newest-first; UI expects oldest-first (parity with DM apiGetMessages).
  return { ...page, items: [...page.items].reverse() };
}

export async function apiUploadGroupVoiceAsset(params: {
  conversationUuid: string;
  encryptedBlob: Blob;
  durationMs: number;
}): Promise<UploadedMessageVoiceAsset> {
  const body = new FormData();
  body.set("durationMs", String(Math.max(1, Math.round(params.durationMs))));
  body.set("file", params.encryptedBlob, "voice-message.bin");
  const conv = encodeURIComponent(params.conversationUuid.trim());
  const raw = await authPostForm(`/api/messaging/groups/${conv}/voice-assets`, body);
  const o = asRecord(raw) ?? {};
  const fb = getApiClientConfig().onPascalFallback;
  const voiceAssetUuid = readStr(o, ["voiceAssetUuid", "VoiceAssetUuid"], fb);
  if (!voiceAssetUuid) throw new Error("Некорректный ответ сервера при загрузке голосового.");
  return {
    voiceAssetUuid,
    contentType: readStr(o, ["contentType", "ContentType"], fb) || "application/octet-stream",
    durationMs: readNum(o, ["durationMs", "DurationMs"], fb) || params.durationMs,
  };
}

export async function apiUploadGroupImageAsset(params: {
  conversationUuid: string;
  encryptedBlob: Blob;
  contentType: string;
}): Promise<UploadedMessageImageAsset> {
  const body = new FormData();
  body.set("contentType", params.contentType);
  body.set("file", params.encryptedBlob, "message-image.bin");
  const conv = encodeURIComponent(params.conversationUuid.trim());
  const raw = await authPostForm(`/api/messaging/groups/${conv}/image-assets`, body);
  const o = asRecord(raw) ?? {};
  const fb = getApiClientConfig().onPascalFallback;
  const imageAssetUuid = readStr(o, ["imageAssetUuid", "ImageAssetUuid"], fb);
  if (!imageAssetUuid) throw new Error("Некорректный ответ сервера при загрузке фото.");
  return {
    imageAssetUuid,
    contentType: readStr(o, ["contentType", "ContentType"], fb) || params.contentType,
  };
}

export async function apiSendGroupMessage(
  conversationUuid: string,
  encryptedWire: string,
  attachments?: {
    voiceAssetUuids?: string[];
    imageAssetUuids?: string[];
  },
): Promise<MsgGroupSendResult> {
  const body: Record<string, unknown> = { encryptedWire };
  if (attachments?.voiceAssetUuids?.length) {
    body.voiceAssetUuids = attachments.voiceAssetUuids;
  }
  if (attachments?.imageAssetUuids?.length) {
    body.imageAssetUuids = attachments.imageAssetUuids;
  }
  const raw = await authPostJson(
    `/api/messaging/groups/${encodeURIComponent(conversationUuid.trim())}/messages`,
    body,
  );
  return parseGroupSendResult(raw, ctx());
}

export async function apiMarkGroupRead(conversationUuid: string): Promise<void> {
  await authPostJson(
    `/api/messaging/groups/${encodeURIComponent(conversationUuid.trim())}/read`,
    {},
  );
}
