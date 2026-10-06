/** Conversation currently on screen. Closed-chat refresh must not touch it. */
let openConversationUuid: string | null = null;

export function setOpenMessagesConversation(conversationUuid: string | null): void {
  const next = conversationUuid?.trim().toLowerCase() ?? "";
  openConversationUuid = next.length > 0 ? next : null;
}

export function getOpenMessagesConversation(): string | null {
  return openConversationUuid;
}
