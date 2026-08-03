import type {
  MsgGroupDetail,
  MsgGroupListItem,
  MsgGroupMessage,
  MsgMessageDto,
} from "@flora/client-core/contracts";
import type { GroupChat, GroupMember } from "@/lib/groupChatTypes";

export function mapGroupListItem(item: MsgGroupListItem, preview?: string | null): GroupChat {
  return {
    conversationUuid: item.conversationUuid,
    title: item.title,
    createdByUserUuid: item.createdByUserUuid,
    members: [],
    memberCount: item.memberCount,
    lastMessagePreview: preview ?? null,
    lastMessageEncryptedWire: item.lastMessageEncryptedWire,
    lastMessageAt: item.lastMessageAt,
    lastMessageIsFromMe: item.lastMessageIsFromMe,
    lastMessageSenderDisplayName: item.lastMessageSenderDisplayName,
    unreadCount: item.unreadCount,
    createdAt: item.createdAt,
  };
}

export function mapGroupDetailMembers(detail: MsgGroupDetail): GroupMember[] {
  return detail.members.map((m) => ({
    userUuid: m.userUuid,
    username: m.username.replace(/^@+/, "") || "user",
    displayName: m.displayName || m.username || "Участник",
    avatarUuid: m.avatarUuid,
  }));
}

export function mergeGroupDetail(listItem: GroupChat, detail: MsgGroupDetail): GroupChat {
  return {
    ...listItem,
    title: detail.title,
    createdByUserUuid: detail.createdByUserUuid,
    members: mapGroupDetailMembers(detail),
    memberCount: detail.members.length,
    createdAt: detail.createdAt,
  };
}

/**
 * List endpoint omits roster. Keep previously loaded members when refreshing
 * previews. If server memberCount diverges from cached roster length, drop the
 * cache so the next detail fetch becomes source-of-truth (exact recipients).
 */
export function mergeGroupListRefresh(
  previous: readonly GroupChat[],
  next: readonly GroupChat[],
): GroupChat[] {
  if (previous.length === 0) return [...next];
  const prevById = new Map(
    previous.map((g) => [g.conversationUuid.trim().toLowerCase(), g] as const),
  );
  return next.map((item) => {
    const old = prevById.get(item.conversationUuid.trim().toLowerCase());
    if (!old?.members.length) return item;
    if (item.memberCount > 0 && item.memberCount !== old.members.length) {
      return { ...item, members: [], createdByUserUuid: item.createdByUserUuid || old.createdByUserUuid };
    }
    return {
      ...item,
      members: old.members,
      memberCount: item.memberCount || old.members.length,
      createdByUserUuid: item.createdByUserUuid || old.createdByUserUuid,
      lastMessageIsFromMe: item.lastMessageIsFromMe,
      lastMessageSenderDisplayName: item.lastMessageSenderDisplayName,
    };
  });
}

export function findGroupMember(
  members: readonly GroupMember[],
  userUuid: string | null | undefined,
): GroupMember | undefined {
  const norm = userUuid?.trim().toLowerCase();
  if (!norm) return undefined;
  return members.find((m) => m.userUuid.trim().toLowerCase() === norm);
}

/** Roster needs refresh before encrypt (empty or count mismatch). */
export function groupRosterNeedsRefresh(group: GroupChat | null | undefined): boolean {
  if (!group) return true;
  if (group.members.length < 2) return true;
  if (group.memberCount > 0 && group.members.length !== group.memberCount) return true;
  return false;
}

/** Map group API messages into the DM thread DTO shape used by decrypt/UI. */
export function groupApiMessagesToThread(
  conversationUuid: string,
  items: readonly MsgGroupMessage[],
): MsgMessageDto[] {
  return items.map((m) => ({
    messageUuid: m.messageUuid,
    conversationUuid,
    senderUserUuid: m.senderUserUuid,
    encryptedPayload: m.encryptedWire,
    createdAt: m.createdAt,
    isFromMe: m.isFromMe,
    isRead: false,
  }));
}
