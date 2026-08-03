/** Server-backed FSCP-G group chat model (Apps/Web). Not FSCP-ORG folder `kind: "group"`. */

export const GROUP_CHAT_MAX_MEMBERS = 128;

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
  unreadCount: number;
  createdAt: string;
};

export type GroupThreadMessage = {
  messageUuid: string;
  conversationUuid: string;
  senderUserUuid: string;
  body: string;
  createdAt: string;
  encryptedWire?: string;
};

export type MessagesListItem =
  | { kind: "dm"; conversation: import("@/lib/socialApi").ConversationListItemDto }
  | { kind: "groupChat"; group: GroupChat };

export type SelectedTarget =
  | { kind: "dm"; otherUserUuid: string }
  | { kind: "groupChat"; conversationUuid: string };

/** Russian plural for «N участник(а/ов)». */
export function formatGroupMembersLabel(count: number): string {
  const n = Math.max(0, Math.floor(count));
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} участник`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} участника`;
  return `${n} участников`;
}
