/**
 * RN-биндинг `chatCachePersistCore`: MMKV-writer конкретного владельца +
 * немедленный flush при уходе приложения в фон (процесс могут убить).
 */

import type { QueryClient } from "@tanstack/react-query";
import { AppState } from "react-native";
import { createChatCachePersister, type ChatDiskWriter } from "@/lib/chatCachePersistCore";
import { chatDiskStore } from "@/stores/chatDiskCache";

export function startChatCachePersist(
  queryClient: QueryClient,
  ownerUserUuid: string,
): () => void {
  const writer: ChatDiskWriter = {
    writeConversations(page, updatedAt) {
      chatDiskStore.writeConversationsSnapshot(ownerUserUuid, page, updatedAt);
    },
    writeGroups(items, updatedAt) {
      chatDiskStore.writeGroupsSnapshot(ownerUserUuid, items, updatedAt);
    },
    writeThread(conversationUuid, snapshot) {
      chatDiskStore.writeThreadSnapshot(ownerUserUuid, conversationUuid, snapshot);
    },
    writeGroupDetail(conversationUuid, detail, updatedAt) {
      chatDiskStore.writeGroupDetailSnapshot(ownerUserUuid, conversationUuid, detail, updatedAt);
    },
  };

  const persister = createChatCachePersister({ queryClient, writer });

  const appSub = AppState.addEventListener("change", (state) => {
    if (state !== "active") persister.flush();
  });

  return () => {
    appSub.remove();
    persister.stop();
  };
}
