import { authDelete, authGetJson, authPatchJson, authPostJson } from "./client.js";
import { getApiClientConfig } from "./client.js";
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

export async function apiSendGroupMessage(
  conversationUuid: string,
  encryptedWire: string,
): Promise<MsgGroupSendResult> {
  const raw = await authPostJson(
    `/api/messaging/groups/${encodeURIComponent(conversationUuid.trim())}/messages`,
    { encryptedWire },
  );
  return parseGroupSendResult(raw, ctx());
}

export async function apiMarkGroupRead(conversationUuid: string): Promise<void> {
  await authPostJson(
    `/api/messaging/groups/${encodeURIComponent(conversationUuid.trim())}/read`,
    {},
  );
}
