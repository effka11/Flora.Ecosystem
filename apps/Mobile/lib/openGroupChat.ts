import { router } from "expo-router";
import { warmChatOpenTextLayoutAtTap } from "@/lib/chatOpenLayoutWarm";
import { markChatOpenTap } from "@/lib/chatOpenTrace";
import { armChatPushEnter } from "@/lib/chatPushTransition";

/** Open an FSCP-G group thread (SSE-only; no FCM in v1). */
export function openGroupChat(conversationUuid: string, title?: string): void {
  const uuid = conversationUuid.trim();
  if (!uuid) return;
  // Отклик в тот же кадр: список начинает отъезжать ещё до маунта чата.
  armChatPushEnter();
  markChatOpenTap(uuid);
  warmChatOpenTextLayoutAtTap({ kind: "group", conversationUuid: uuid });
  router.push({
    pathname: "/(tabs)/messages/[conversationUuid]",
    params: {
      conversationUuid: uuid,
      kind: "groupChat",
      title: (title ?? "").trim() || "Группа",
    },
  });
}
