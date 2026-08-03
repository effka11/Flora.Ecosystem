/** Server-backed FSCP-G group chat model (Apps/Mobile). Not FSCP-ORG folder `kind: "group"`. */

import { FSCP_GROUP_MAX_MEMBERS } from "@flora/client-core/fscp";
import type { MsgConversationDto } from "@flora/client-core/contracts";

export const GROUP_CHAT_MAX_MEMBERS = FSCP_GROUP_MAX_MEMBERS;

/** Max peers selectable on create (creator added separately). */
export const GROUP_CHAT_MAX_PEER_SELECTION = GROUP_CHAT_MAX_MEMBERS - 1;

export type GroupMember = {
  userUuid: string;
  username: string;
  displayName: string;
  avatarUuid?: string | null;
};

export type GroupChat = {
  conversationUuid: string;
  title: string;
  createdByUserUuid: string;
  members: GroupMember[];
  memberCount: number;
  lastMessagePreview: string | null;
  lastMessageEncryptedWire: string | null;
  lastMessageAt: string | null;
  lastMessageIsFromMe: boolean;
  /** Display name of last sender when not from me. */
  lastMessageSenderDisplayName: string | null;
  unreadCount: number;
  createdAt: string;
};

/** Unified messages list row — do not fake group as MsgConversationDto. */
export type MessagesListRow =
  | { kind: "dm"; conversation: MsgConversationDto }
  | { kind: "groupChat"; group: GroupChat };

/** Russian plural for «N участник(а/ов)». */
export function formatGroupMembersLabel(count: number): string {
  const n = Math.max(0, Math.floor(count));
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} участник`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} участника`;
  return `${n} участников`;
}

export function normalizeGroupTitleInput(raw: string): { ok: true; title: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, title: "Группа" };
  }
  if (trimmed.includes("\n") || trimmed.includes("\r")) {
    return { ok: false, error: "Название группы не должно содержать переносы строк." };
  }
  if ([...trimmed].length > 40) {
    return { ok: false, error: "Название группы не длиннее 40 символов." };
  }
  return { ok: true, title: trimmed };
}

export function normalizeGroupTitlePatch(raw: string): { ok: true; title: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Название группы не может быть пустым." };
  }
  if (trimmed.includes("\n") || trimmed.includes("\r")) {
    return { ok: false, error: "Название группы не должно содержать переносы строк." };
  }
  if ([...trimmed].length > 40) {
    return { ok: false, error: "Название группы не длиннее 40 символов." };
  }
  return { ok: true, title: trimmed };
}

export function groupSortAt(group: GroupChat): string {
  return group.lastMessageAt || group.createdAt || "";
}
