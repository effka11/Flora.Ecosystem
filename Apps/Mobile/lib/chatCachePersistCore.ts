/**
 * Write-through персистер messaging-кэшей react-query на диск.
 *
 * Подписывается на QueryCache, коалесцирует изменения trailing-debounce'ом и
 * на flush читает АКТУАЛЬНОЕ состояние кэша (никогда не снапшотит в момент
 * события — иначе можно записать промежуточный optimistic-стейт). Санитизация
 * (plaintext/sentinel) — на стороне writer'а (`stores/chatDiskCache.ts`).
 *
 * RN-free: биндинг с AppState-flush живёт в `lib/chatCachePersist.ts`.
 */

import type { QueryClient } from "@tanstack/react-query";
import type {
  MsgConversationsPage,
  MsgGroupDetail,
  MsgGroupListItem,
  MsgMessageDto,
} from "@flora/client-core/contracts";
import type { PersistedThreadKind } from "@/lib/chatDiskCacheCore";

export const CHAT_CACHE_PERSIST_DEBOUNCE_MS = 800;

export type ChatDiskWriter = {
  writeConversations(page: MsgConversationsPage, updatedAt: number): void;
  writeGroups(items: readonly MsgGroupListItem[], updatedAt: number): void;
  writeThread(
    conversationUuid: string,
    snapshot: {
      updatedAt: number;
      kind: PersistedThreadKind;
      otherUserUuid: string;
      items: MsgMessageDto[];
    },
  ): void;
  writeGroupDetail(conversationUuid: string, detail: MsgGroupDetail, updatedAt: number): void;
};

type PendingTarget =
  | { type: "conversations" }
  | { type: "groups" }
  | { type: "thread"; kind: PersistedThreadKind; conversationUuid: string; otherUserUuid: string }
  | { type: "group-detail"; conversationUuid: string };

type ThreadPage = { items: MsgMessageDto[]; nextCursor: string | null };

export type ChatCachePersister = {
  flush(): void;
  stop(): void;
};

function targetFromQueryKey(queryKey: readonly unknown[]): PendingTarget | null {
  const head = queryKey[0];
  if (head === "conversations" && queryKey.length === 1) return { type: "conversations" };
  if (head === "groups" && queryKey.length === 1) return { type: "groups" };
  if (head === "messages" && typeof queryKey[1] === "string" && queryKey[1]) {
    return {
      type: "thread",
      kind: "dm",
      conversationUuid: queryKey[1],
      otherUserUuid: typeof queryKey[2] === "string" ? queryKey[2] : "",
    };
  }
  if (head === "group-messages" && typeof queryKey[1] === "string" && queryKey[1]) {
    return { type: "thread", kind: "group", conversationUuid: queryKey[1], otherUserUuid: "" };
  }
  if (head === "group" && typeof queryKey[1] === "string" && queryKey[1]) {
    return { type: "group-detail", conversationUuid: queryKey[1] };
  }
  return null;
}

function targetId(target: PendingTarget): string {
  switch (target.type) {
    case "conversations":
      return "conversations";
    case "groups":
      return "groups";
    case "thread":
      return `thread|${target.kind}|${target.conversationUuid}|${target.otherUserUuid}`;
    case "group-detail":
      return `group-detail|${target.conversationUuid}`;
  }
}

export function createChatCachePersister(params: {
  queryClient: QueryClient;
  writer: ChatDiskWriter;
  debounceMs?: number;
}): ChatCachePersister {
  const { queryClient, writer } = params;
  const debounceMs = params.debounceMs ?? CHAT_CACHE_PERSIST_DEBOUNCE_MS;

  const pending = new Map<string, PendingTarget>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const clearTimer = () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const persistTarget = (target: PendingTarget): void => {
    switch (target.type) {
      case "conversations": {
        const state = queryClient.getQueryState<MsgConversationsPage>(["conversations"]);
        if (state?.status === "success" && state.data) {
          writer.writeConversations(state.data, state.dataUpdatedAt);
        }
        return;
      }
      case "groups": {
        const state = queryClient.getQueryState<MsgGroupListItem[]>(["groups"]);
        if (state?.status === "success" && state.data) {
          writer.writeGroups(state.data, state.dataUpdatedAt);
        }
        return;
      }
      case "thread": {
        const queryKey =
          target.kind === "dm"
            ? ["messages", target.conversationUuid, target.otherUserUuid]
            : ["group-messages", target.conversationUuid];
        const state = queryClient.getQueryState<ThreadPage>(queryKey);
        if (state?.status === "success" && state.data) {
          writer.writeThread(target.conversationUuid, {
            updatedAt: state.dataUpdatedAt,
            kind: target.kind,
            otherUserUuid: target.otherUserUuid,
            items: state.data.items,
          });
        }
        return;
      }
      case "group-detail": {
        const state = queryClient.getQueryState<MsgGroupDetail>([
          "group",
          target.conversationUuid,
        ]);
        if (state?.status === "success" && state.data) {
          writer.writeGroupDetail(target.conversationUuid, state.data, state.dataUpdatedAt);
        }
        return;
      }
    }
  };

  const flush = (): void => {
    clearTimer();
    if (pending.size === 0) return;
    const batch = [...pending.values()];
    pending.clear();
    for (const target of batch) {
      try {
        persistTarget(target);
      } catch {
        // Диск не должен ронять UI; следующий апдейт повторит запись.
      }
    }
  };

  const schedule = (target: PendingTarget): void => {
    if (stopped) return;
    pending.set(targetId(target), target);
    clearTimer();
    timer = setTimeout(flush, debounceMs);
  };

  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "added" && event.type !== "updated") return;
    const target = targetFromQueryKey(event.query.queryKey as readonly unknown[]);
    if (target) schedule(target);
  });

  return {
    flush,
    stop() {
      // Без финального flush: logout-путь делает wipe, и поздняя запись
      // вернула бы стёртые данные на диск.
      stopped = true;
      unsubscribe();
      clearTimer();
      pending.clear();
    },
  };
}
