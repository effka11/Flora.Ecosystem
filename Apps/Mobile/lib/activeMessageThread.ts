import { setSecurePushActiveConversation } from "flora-secure-push";

let activeConversationUuid: string | null = null;

export function setActiveMessageThread(conversationUuid: string | null): void {
  const norm = conversationUuid?.trim().toLowerCase() ?? "";
  activeConversationUuid = norm.length > 0 ? norm : null;
  setSecurePushActiveConversation(activeConversationUuid);
}

export function getActiveMessageThread(): string | null {
  return activeConversationUuid;
}
