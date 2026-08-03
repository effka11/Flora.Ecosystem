import { router } from "expo-router";

/** Open an FSCP-G group thread (SSE-only; no FCM in v1). */
export function openGroupChat(conversationUuid: string, title?: string): void {
  const uuid = conversationUuid.trim();
  if (!uuid) return;
  router.push({
    pathname: "/(tabs)/messages/[conversationUuid]",
    params: {
      conversationUuid: uuid,
      kind: "groupChat",
      title: (title ?? "").trim() || "Группа",
    },
  });
}
