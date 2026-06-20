let activeConversationUuid: string | null = null;

export function setActiveMessageThread(conversationUuid: string | null): void {
  const norm = conversationUuid?.trim().toLowerCase() ?? "";
  activeConversationUuid = norm.length > 0 ? norm : null;
}

export function getActiveMessageThread(): string | null {
  return activeConversationUuid;
}
