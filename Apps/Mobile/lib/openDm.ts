import { apiGetConversations } from "@flora/client-core/api";
import type { MsgConversationDto } from "@flora/client-core/contracts";
import { dmConversationUuid } from "@flora/client-core/fscp";
import { router } from "expo-router";
import { getQueryClientRef } from "@/lib/queryClientRef";
import { messageThreadCache, messageThreadDecryptCache } from "@/stores/messageThreadCache";
import { useSessionStore } from "@/stores/sessionStore";

export type DmPeerParams = {
  otherUserUuid: string;
  otherUsername?: string;
  otherDisplayName?: string;
  otherAvatarUuid?: string | null;
  otherUserIsOnline?: boolean;
  otherUserLastSeenAt?: string | null;
};

function threadParamsFromConversation(item: MsgConversationDto): Record<string, string> {
  return threadParamsFromPeer(item.conversationUuid, {
    otherUserUuid: item.otherUserUuid,
    otherUsername: item.otherUsername,
    otherDisplayName: item.otherDisplayName,
    otherAvatarUuid: item.otherAvatarUuid,
    otherUserIsOnline: item.otherUserIsOnline,
    otherUserLastSeenAt: item.otherUserLastSeenAt,
  });
}

export function threadParamsFromPeer(
  conversationUuid: string,
  peer: DmPeerParams,
): Record<string, string> {
  return {
    conversationUuid,
    otherUserUuid: peer.otherUserUuid,
    otherDisplayName: peer.otherDisplayName ?? "",
    otherUsername: peer.otherUsername ?? "",
    otherAvatarUuid: peer.otherAvatarUuid ?? "",
    otherUserIsOnline: peer.otherUserIsOnline ? "1" : "0",
    otherUserLastSeenAt: peer.otherUserLastSeenAt ?? "",
  };
}

export function openDmWithUser(meUserUuid: string, peer: DmPeerParams): void {
  const conversationUuid = dmConversationUuid(meUserUuid, peer.otherUserUuid);
  router.push({
    pathname: "/(tabs)/messages/[conversationUuid]",
    params: threadParamsFromPeer(conversationUuid, peer),
  });
}

/** Deep link from FCM / cold start: needs sender as otherUserUuid + fresh thread fetch. */
export async function openMessageFromPush(data: unknown): Promise<void> {
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const type = typeof record?.type === "string" ? record.type : "message";

  if (type === "notification") {
    router.push("/(tabs)/notifications");
    return;
  }

  const conversationUuid =
    typeof record?.conversationUuid === "string" ? record.conversationUuid.trim() : "";
  const senderUserUuid =
    typeof record?.senderUserUuid === "string" ? record.senderUserUuid.trim() : "";

  if (!conversationUuid) {
    router.push("/(tabs)/messages");
    return;
  }

  messageThreadCache.clearConversation(conversationUuid);
  messageThreadDecryptCache.set(conversationUuid, []);

  const meUuid = useSessionStore.getState().me?.userUuid?.trim() ?? "";
  const otherUserUuid =
    senderUserUuid && meUuid && senderUserUuid.toLowerCase() !== meUuid.toLowerCase()
      ? senderUserUuid
      : "";

  const qc = getQueryClientRef();
  if (qc) {
    try {
      const page = await qc.fetchQuery({
        queryKey: ["conversations"],
        queryFn: () => apiGetConversations(),
        staleTime: 30_000,
      });
      const row = page.items.find(
        (c) => c.conversationUuid.toLowerCase() === conversationUuid.toLowerCase(),
      );
      if (row) {
        router.push({
          pathname: "/(tabs)/messages/[conversationUuid]",
          params: threadParamsFromConversation(row),
        });
        return;
      }
    } catch {
      /* navigate with push payload below */
    }
  }

  if (!otherUserUuid) {
    router.push("/(tabs)/messages");
    return;
  }

  if (meUuid) {
    const expected = dmConversationUuid(meUuid, otherUserUuid);
    if (expected.toLowerCase() !== conversationUuid.toLowerCase()) {
      router.push("/(tabs)/messages");
      return;
    }
  }

  router.push({
    pathname: "/(tabs)/messages/[conversationUuid]",
    params: threadParamsFromPeer(conversationUuid, { otherUserUuid }),
  });
}
