import { clearConversationThreadsCache } from "@/lib/conversationThreadsCache";
import { clearGroupThreadsCache } from "@/lib/groupThreadsCache";
import { clearAllMessageMedia } from "@/lib/messageMediaCache";
import { clearMessagePlaintextSessionCache } from "@/lib/messagePlaintextSessionCache";
import { cancelAllHoverThreadWarms } from "@/lib/threadWarmIntent";
import { setOpenMessagesConversation } from "@/lib/messagesOpenConversation";

export function resetMessagingSessionCaches(): void {
  cancelAllHoverThreadWarms();
  setOpenMessagesConversation(null);
  clearConversationThreadsCache();
  clearGroupThreadsCache();
  clearMessagePlaintextSessionCache();
  clearAllMessageMedia();
}
