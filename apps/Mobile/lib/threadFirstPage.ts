/**
 * Первая страница треда: канонический RQ-ключ и фетч.
 *
 * Экран треда, фоновый прогрев (`chatThreadsPrefetch`) и сетевой добор по
 * касанию строки (`chatOpenLayoutWarm`) обязаны ходить в ОДИН ключ одним и
 * тем же запросом. Иначе prefetch по касанию не дедуплицируется с `useQuery`
 * экрана, и холодный чат открывается по второму сетевому запросу — то есть
 * добор не ускоряет открытие, а только тратит трафик.
 *
 * staleTime здесь не задаётся: он политика места вызова (экран держит минуту,
 * фоновый прогрев обновляет чаще).
 */
import { apiGetGroupMessages, apiGetMessages } from "@flora/client-core/api";
import { groupApiMessagesToThread } from "@/lib/groupChatMap";
import {
  applyMessagesPageToCaches,
  type MessagesQueryData,
} from "@/lib/messageThreadOutgoing";

/** Как staleTime тредовых `useQuery` — см. экран треда и `useGroupChatThread`. */
export const THREAD_FIRST_PAGE_STALE_MS = 60_000;

export type ThreadFirstPageTarget =
  | { kind: "dm"; conversationUuid: string; otherUserUuid: string }
  | { kind: "group"; conversationUuid: string };

export function threadFirstPageQueryKey(
  target: ThreadFirstPageTarget,
): readonly unknown[] {
  return target.kind === "dm"
    ? ["messages", target.conversationUuid, target.otherUserUuid.trim() || ""]
    : ["group-messages", target.conversationUuid];
}

export async function fetchThreadFirstPage(
  target: ThreadFirstPageTarget,
): Promise<MessagesQueryData> {
  if (target.kind === "group") {
    const page = await apiGetGroupMessages(target.conversationUuid);
    return {
      items: groupApiMessagesToThread(target.conversationUuid, page.items),
      nextCursor: page.nextCursor,
    };
  }
  const page = await apiGetMessages(
    target.conversationUuid,
    undefined,
    target.otherUserUuid.trim() || undefined,
  );
  return applyMessagesPageToCaches({
    conversationUuid: target.conversationUuid,
    otherUserUuid: target.otherUserUuid,
    page,
  });
}
