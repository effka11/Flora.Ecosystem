/**
 * Система папок списка чатов (клиентский слой).
 * Portable: Apps/Mobile и Apps/Web используют одни правила видимости/фильтрации.
 */

export type ChatListFolderId = "all" | "archived";

export type ChatListFolderDef = {
  id: Exclude<ChatListFolderId, "all">;
  label: string;
};

/** Папки, которые показываются в UI (не включая основной список «все»). */
export const CHAT_LIST_FOLDER_ARCHIVE: ChatListFolderDef = {
  id: "archived",
  label: "Архив",
};

export function countArchivedPeers(
  archivedByPeer: Readonly<Record<string, true>>,
  knownPeerUuids?: ReadonlySet<string>,
): number {
  const keys = Object.keys(archivedByPeer);
  if (!knownPeerUuids) return keys.length;
  return keys.reduce((n, uuid) => (knownPeerUuids.has(uuid) ? n + 1 : n), 0);
}

/** Какие папки показывать справа от фильтра. */
export function listVisibleChatFolders(archivedCount: number): readonly ChatListFolderDef[] {
  if (archivedCount <= 0) return [];
  return [CHAT_LIST_FOLDER_ARCHIVE];
}

/** Если активная папка исчезла (последний архивный чат убран) — вернуться к «всем». */
export function normalizeChatListFolder(
  folder: ChatListFolderId,
  archivedCount: number,
): ChatListFolderId {
  if (folder === "archived" && archivedCount <= 0) return "all";
  return folder;
}

export function isPeerArchived(
  peerUuid: string,
  archivedByPeer: Readonly<Record<string, true>>,
): boolean {
  return peerUuid in archivedByPeer;
}

export function filterConversationsByFolder<T extends { otherUserUuid: string }>(
  items: readonly T[],
  folder: ChatListFolderId,
  archivedByPeer: Readonly<Record<string, true>>,
): T[] {
  if (folder === "archived") {
    return items.filter((item) => isPeerArchived(item.otherUserUuid, archivedByPeer));
  }
  return items.filter((item) => !isPeerArchived(item.otherUserUuid, archivedByPeer));
}

/** Убрать из карты архива пиров, которых больше нет в списке (удалённый чат). */
export function pruneArchivedPeers(
  archivedByPeer: Readonly<Record<string, true>>,
  knownPeerUuids: ReadonlySet<string>,
): Record<string, true> {
  let changed = false;
  const next: Record<string, true> = {};
  for (const uuid of Object.keys(archivedByPeer)) {
    if (knownPeerUuids.has(uuid)) {
      next[uuid] = true;
    } else {
      changed = true;
    }
  }
  return changed ? next : (archivedByPeer as Record<string, true>);
}

export function setPeerArchivedFlag(
  archivedByPeer: Readonly<Record<string, true>>,
  peerUuid: string,
  archived: boolean,
): Record<string, true> {
  if (archived) {
    if (peerUuid in archivedByPeer) return archivedByPeer as Record<string, true>;
    return { ...archivedByPeer, [peerUuid]: true };
  }
  if (!(peerUuid in archivedByPeer)) return archivedByPeer as Record<string, true>;
  const next = { ...archivedByPeer };
  delete next[peerUuid];
  return next;
}
