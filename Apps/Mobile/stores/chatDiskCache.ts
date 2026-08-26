/**
 * MMKV-биндинг дискового снапшота чатов (см. `lib/chatDiskCacheCore.ts`).
 *
 * Отдельный инстанс `flora-chat-cache`: полный wipe на logout не задевает
 * настройки приложения. На диске — только server-visible DTO (шифротексты и
 * метаданные, которые сервер и так хранит); plaintext не персистится, ключи
 * остаются в SecureStore.
 */

import type { QueryClient } from "@tanstack/react-query";
import type {
  MsgConversationsPage,
  MsgGroupDetail,
  MsgGroupListItem,
} from "@flora/client-core/contracts";
import { MMKV } from "react-native-mmkv";
import {
  CHAT_DISK_SCHEMA_VERSION,
  chatDiskOwnerNorm,
  isThreadSnapshotFresh,
  parsePersistedConversations,
  parsePersistedGroupDetail,
  parsePersistedGroups,
  parsePersistedThread,
  parseThreadIndex,
  pruneThreadIndex,
  sanitizeConversationsForPersist,
  sanitizeGroupsForPersist,
  sanitizeThreadItemsForPersist,
  touchThreadIndex,
  type PersistedThread,
  type PersistedThreadKind,
  type ThreadIndexEntry,
} from "@/lib/chatDiskCacheCore";
import { messageThreadCache } from "@/stores/messageThreadCache";

const chatDiskMmkv = new MMKV({ id: "flora-chat-cache" });

function prefix(ownerUserUuid: string): string {
  return `v${CHAT_DISK_SCHEMA_VERSION}.${chatDiskOwnerNorm(ownerUserUuid)}.`;
}

function conversationsKey(owner: string): string {
  return `${prefix(owner)}conversations`;
}

function groupsKey(owner: string): string {
  return `${prefix(owner)}groups`;
}

function threadKey(owner: string, conversationUuid: string): string {
  return `${prefix(owner)}thread.${conversationUuid.trim().toLowerCase()}`;
}

function groupDetailKey(owner: string, conversationUuid: string): string {
  return `${prefix(owner)}group-detail.${conversationUuid.trim().toLowerCase()}`;
}

function threadIndexKey(owner: string): string {
  return `${prefix(owner)}thread-index`;
}

function readThreadIndex(owner: string): ThreadIndexEntry[] {
  return parseThreadIndex(chatDiskMmkv.getString(threadIndexKey(owner)) ?? null);
}

function writeThreadIndex(owner: string, entries: readonly ThreadIndexEntry[]): void {
  chatDiskMmkv.set(threadIndexKey(owner), JSON.stringify(entries));
}

function deleteThreadKeys(owner: string, conversationUuid: string): void {
  chatDiskMmkv.delete(threadKey(owner, conversationUuid));
  chatDiskMmkv.delete(groupDetailKey(owner, conversationUuid));
}

export const chatDiskStore = {
  writeConversationsSnapshot(
    owner: string,
    page: MsgConversationsPage,
    updatedAt: number,
  ): void {
    chatDiskMmkv.set(
      conversationsKey(owner),
      JSON.stringify({ updatedAt, page: sanitizeConversationsForPersist(page) }),
    );
  },

  writeGroupsSnapshot(
    owner: string,
    items: readonly MsgGroupListItem[],
    updatedAt: number,
  ): void {
    chatDiskMmkv.set(
      groupsKey(owner),
      JSON.stringify({ updatedAt, items: sanitizeGroupsForPersist(items) }),
    );
  },

  writeThreadSnapshot(
    owner: string,
    conversationUuid: string,
    snapshot: {
      updatedAt: number;
      kind: PersistedThreadKind;
      otherUserUuid: string;
      items: PersistedThread["items"];
    },
  ): void {
    const payload: PersistedThread = {
      updatedAt: snapshot.updatedAt,
      kind: snapshot.kind,
      conversationUuid,
      otherUserUuid: snapshot.otherUserUuid,
      items: sanitizeThreadItemsForPersist(snapshot.items),
    };
    chatDiskMmkv.set(threadKey(owner, conversationUuid), JSON.stringify(payload));
    const { keep, evict } = touchThreadIndex(readThreadIndex(owner), {
      conversationUuid: conversationUuid.trim().toLowerCase(),
      kind: snapshot.kind,
      touchedAt: Date.now(),
    });
    for (const entry of evict) deleteThreadKeys(owner, entry.conversationUuid);
    writeThreadIndex(owner, keep);
  },

  writeGroupDetailSnapshot(
    owner: string,
    conversationUuid: string,
    detail: MsgGroupDetail,
    updatedAt: number,
  ): void {
    chatDiskMmkv.set(
      groupDetailKey(owner, conversationUuid),
      JSON.stringify({ updatedAt, conversationUuid, detail }),
    );
  },
};

export function wipeChatDiskCache(): void {
  chatDiskMmkv.clearAll();
}

function hasQueryData(queryClient: QueryClient, queryKey: readonly unknown[]): boolean {
  return (queryClient.getQueryState(queryKey)?.dataUpdatedAt ?? 0) > 0;
}

/**
 * Синхронная гидрация под сплэшем: списки + треды из MMKV в react-query
 * (с честным `updatedAt` — staleness-машинерия сама сделает тихий рефетч)
 * и в module-level `messageThreadCache` (DM `initialData`-путь).
 */
export function hydrateChatDiskCache(
  queryClient: QueryClient,
  ownerUserUuid: string,
  now: number = Date.now(),
): void {
  const owner = chatDiskOwnerNorm(ownerUserUuid);
  if (!owner) return;

  const conversations = parsePersistedConversations(
    chatDiskMmkv.getString(conversationsKey(owner)) ?? null,
  );
  if (conversations && !hasQueryData(queryClient, ["conversations"])) {
    queryClient.setQueryData(["conversations"], conversations.page, {
      updatedAt: conversations.updatedAt,
    });
  }

  const groups = parsePersistedGroups(chatDiskMmkv.getString(groupsKey(owner)) ?? null);
  if (groups && !hasQueryData(queryClient, ["groups"])) {
    queryClient.setQueryData(["groups"], groups.items, { updatedAt: groups.updatedAt });
  }

  const index = readThreadIndex(owner);
  const { keep } = pruneThreadIndex(index);
  const alive: ThreadIndexEntry[] = [];
  for (const entry of keep) {
    const snapshot = parsePersistedThread(
      chatDiskMmkv.getString(threadKey(owner, entry.conversationUuid)) ?? null,
    );
    if (!snapshot || !isThreadSnapshotFresh(snapshot.updatedAt, now)) {
      deleteThreadKeys(owner, entry.conversationUuid);
      continue;
    }
    alive.push(entry);
    // Регистр RQ-ключей — из снапшота (index нормализован в lowercase).
    const conversationUuid = snapshot.conversationUuid;

    if (snapshot.kind === "dm") {
      const queryKey = ["messages", conversationUuid, snapshot.otherUserUuid];
      if (!hasQueryData(queryClient, queryKey)) {
        queryClient.setQueryData(
          queryKey,
          { items: snapshot.items, nextCursor: null },
          { updatedAt: snapshot.updatedAt },
        );
      }
      messageThreadCache.set(conversationUuid, snapshot.items);
      continue;
    }

    const queryKey = ["group-messages", conversationUuid];
    if (!hasQueryData(queryClient, queryKey)) {
      queryClient.setQueryData(
        queryKey,
        { items: snapshot.items, nextCursor: null },
        { updatedAt: snapshot.updatedAt },
      );
    }
    const detail = parsePersistedGroupDetail(
      chatDiskMmkv.getString(groupDetailKey(owner, entry.conversationUuid)) ?? null,
    );
    if (detail && !hasQueryData(queryClient, ["group", detail.conversationUuid])) {
      queryClient.setQueryData(["group", detail.conversationUuid], detail.detail, {
        updatedAt: detail.updatedAt,
      });
    }
  }
  if (alive.length !== index.length) writeThreadIndex(owner, alive);
}
