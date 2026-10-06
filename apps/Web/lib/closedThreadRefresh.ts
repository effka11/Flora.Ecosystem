import { conversationsCache } from "@/lib/dashboardPreload";
import { dmConversationUuid } from "@/lib/fscp/deriveIds";
import {
  revalidateConversationThread,
} from "@/lib/conversationThreadsCache";
import { revalidateGroupConversationThread } from "@/lib/groupThreadsCache";
import { getOpenMessagesConversation } from "@/lib/messagesOpenConversation";

export type ClosedThreadMessageSignal = {
  conversationUuid?: string | null;
  senderUserUuid?: string | null;
  kind?: "dm" | "groupChat" | null;
};

function peerFromConversationList(conversationUuid: string, viewerUuid: string): string | null {
  const page = conversationsCache.peek();
  if (!page) return null;
  const target = conversationUuid.trim().toLowerCase();
  const viewer = viewerUuid.trim().toLowerCase();
  for (const item of page.items) {
    const peer = item.otherUserUuid.trim().toLowerCase();
    if (!peer) continue;
    if (dmConversationUuid(viewer, peer).toLowerCase() === target) return peer;
    if (item.conversationUuid.trim().toLowerCase() === target) return peer;
  }
  return null;
}

/**
 * Closed chat: keep the cached page and replace it with one background GET.
 * Open chat is left to the messages screen. Own messages from another device
 * fall back to TTL when the peer cannot be resolved.
 */
export function refreshClosedThreadOnMessageSignal(
  signal: ClosedThreadMessageSignal,
  viewerUuid: string | null | undefined,
  deps: {
    revalidateDm?: (viewerNorm: string, peerUuid: string) => void;
    revalidateGroup?: (viewerNorm: string, conversationUuid: string) => void;
  } = {},
): void {
  const viewer = viewerUuid?.trim().toLowerCase() ?? "";
  const conversationUuid = signal.conversationUuid?.trim().toLowerCase() ?? "";
  if (!viewer || !conversationUuid) return;
  if (getOpenMessagesConversation() === conversationUuid) return;

  const revalidateDm = deps.revalidateDm ?? revalidateConversationThread;
  const revalidateGroup = deps.revalidateGroup ?? revalidateGroupConversationThread;

  if (signal.kind === "groupChat") {
    revalidateGroup(viewer, conversationUuid);
    return;
  }
  if (signal.kind !== "dm") return;

  const sender = signal.senderUserUuid?.trim().toLowerCase() ?? "";
  const peer = sender && sender !== viewer ? sender : peerFromConversationList(conversationUuid, viewer);
  if (!peer) return;
  revalidateDm(viewer, peer);
}
