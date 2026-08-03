import type { MsgGroupDetail, MsgGroupListItem } from "@flora/client-core/contracts";
import type { GroupChat, GroupMember } from "@/app/(dashboard)/messages/groupConversationTypes";

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
 * List endpoint does not include roster. Keep previously loaded `members` /
 * `createdByUserUuid` when refreshing previews so bubble avatars stay resolved.
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
    return {
      ...item,
      members: old.members,
      memberCount: Math.max(item.memberCount, old.members.length),
      createdByUserUuid: item.createdByUserUuid || old.createdByUserUuid,
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
