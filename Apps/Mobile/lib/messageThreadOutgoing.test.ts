import type { MsgConversationDto, MsgMessageDto } from "@flora/client-core/contracts";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyOutgoingToConversations,
  clearPendingOutgoing,
  insertOptimisticOutgoingThreadMessage,
  mergePendingOutgoingIntoMessages,
  removeOptimisticOutgoingThreadMessage,
  replaceOptimisticOutgoingThreadMessage,
  type OutgoingConversationPatch,
} from "./messageThreadOutgoing";
import { optimisticPayloadSentinel } from "./messageBirthRegistry";
import { messageThreadCache, messageThreadDecryptCache } from "@/stores/messageThreadCache";

function conversation(conversationUuid: string): MsgConversationDto {
  return {
    conversationUuid,
    otherUserUuid: `user-${conversationUuid}`,
    otherUsername: `username-${conversationUuid}`,
    otherDisplayName: `Display ${conversationUuid}`,
    otherAvatarUuid: `avatar-${conversationUuid}`,
    lastMessageEncryptedForMe: `old-encrypted-${conversationUuid}`,
    lastMessageContent: `old content ${conversationUuid}`,
    lastMessageAt: "2026-07-24T12:00:00.000Z",
    lastMessageIsFromMe: false,
    unreadCount: 3,
    otherUserIsOnline: false,
    otherUserLastSeenAt: "2026-07-24T11:00:00.000Z",
  };
}

const patch: OutgoingConversationPatch = {
  conversationUuid: "b",
  encryptedForMe: "new-encrypted",
  createdAt: "2026-07-25T12:00:00.000Z",
};

describe("applyOutgoingToConversations", () => {
  it("moves the updated conversation to the front", () => {
    const items = [conversation("a"), conversation("b"), conversation("c")];

    const result = applyOutgoingToConversations(items, patch);

    expect(result.map((item) => item.conversationUuid)).toEqual(["b", "a", "c"]);
  });

  it("updates only outgoing preview fields", () => {
    const original = {
      ...conversation("b"),
      otherUsername: "peer",
      otherDisplayName: "Peer Name",
      otherAvatarUuid: "avatar-peer",
      otherUserIsOnline: true,
      otherUserLastSeenAt: "2026-07-25T11:00:00.000Z",
      unreadCount: 7,
    };

    const [result] = applyOutgoingToConversations([original], patch);

    expect(result).toMatchObject({
      lastMessageEncryptedForMe: patch.encryptedForMe,
      lastMessageContent: null,
      lastMessageAt: patch.createdAt,
      lastMessageIsFromMe: true,
      otherUsername: "peer",
      otherDisplayName: "Peer Name",
      otherAvatarUuid: "avatar-peer",
      otherUserIsOnline: true,
      otherUserLastSeenAt: "2026-07-25T11:00:00.000Z",
      unreadCount: 7,
    });
  });

  it("returns the original array when the conversation is absent", () => {
    const items = [conversation("a"), conversation("c")];

    expect(applyOutgoingToConversations(items, patch)).toBe(items);
  });

  it("keeps an already first conversation first", () => {
    const items = [conversation("b"), conversation("a"), conversation("c")];

    const result = applyOutgoingToConversations(items, patch);

    expect(result.map((item) => item.conversationUuid)).toEqual(["b", "a", "c"]);
  });

  it("does not mutate the input array or its items", () => {
    const items = [conversation("a"), conversation("b"), conversation("c")];
    const originalItems = structuredClone(items);

    applyOutgoingToConversations(items, patch);

    expect(items).toEqual(originalItems);
    expect(items[1]).toEqual(originalItems[1]);
  });

  it("can set lastMessageContent for optimistic preview", () => {
    const [result] = applyOutgoingToConversations([conversation("b")], {
      ...patch,
      lastMessageContent: "hello",
    });
    expect(result.lastMessageContent).toBe("hello");
  });
});

describe("optimistic pending merge", () => {
  const conversationUuid = "conv-opt";
  const otherUserUuid = "peer-1";
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient();
    clearPendingOutgoing(conversationUuid);
    messageThreadCache.clear();
  });

  it("keeps temp row across server page without that uuid (refetch clobber)", () => {
    insertOptimisticOutgoingThreadMessage({
      queryClient,
      conversationUuid,
      otherUserUuid,
      senderUserUuid: "me",
      clientMessageKey: "temp-1",
      blocks: [{ kind: "text", body: "hi" }],
    });

    const serverPage: MsgMessageDto[] = [
      {
        messageUuid: "server-old",
        conversationUuid,
        senderUserUuid: "peer-1",
        encryptedPayload: "fscp1:old",
        createdAt: "2026-07-25T10:00:00.000Z",
        isFromMe: false,
        isRead: true,
      },
    ];

    const merged = mergePendingOutgoingIntoMessages(conversationUuid, serverPage);
    expect(merged).toHaveLength(2);
    expect(merged[1]?.messageUuid).toBe("temp-1");
    expect(merged[1]?.encryptedPayload).toBe(optimisticPayloadSentinel("temp-1"));
    expect(merged).not.toBe(serverPage);
  });

  it("replace swaps temp for real and clears pending", () => {
    insertOptimisticOutgoingThreadMessage({
      queryClient,
      conversationUuid,
      otherUserUuid,
      senderUserUuid: "me",
      clientMessageKey: "temp-2",
      blocks: [{ kind: "text", body: "yo" }],
    });

    replaceOptimisticOutgoingThreadMessage({
      queryClient,
      conversationUuid,
      otherUserUuid,
      senderUserUuid: "me",
      clientMessageKey: "temp-2",
      sent: {
        messageUuid: "real-2",
        createdAt: "2026-07-25T12:00:00.000Z",
        encryptedForMe: "fscp1:wire",
      },
      wire: "fscp1:wire",
      blocks: [{ kind: "text", body: "yo" }],
    });

    const afterServer = mergePendingOutgoingIntoMessages(conversationUuid, [
      {
        messageUuid: "real-2",
        conversationUuid,
        senderUserUuid: "me",
        encryptedPayload: "fscp1:wire",
        createdAt: "2026-07-25T12:00:00.000Z",
        isFromMe: true,
        isRead: false,
      },
    ]);
    expect(afterServer).toHaveLength(1);
    expect(afterServer[0]?.messageUuid).toBe("real-2");

    const cached = messageThreadDecryptCache.getMessage("real-2|fscp1:wire");
    expect(cached?.sendStatus).toBeUndefined();
    expect(cached?.clientMessageKey).toBe("temp-2");
    expect(cached?.text).toBe("yo");
  });

  it("rehydrate restores decrypt seed after clearDecryptCaches", () => {
    insertOptimisticOutgoingThreadMessage({
      queryClient,
      conversationUuid,
      otherUserUuid,
      senderUserUuid: "me",
      clientMessageKey: "temp-rehydrate",
      blocks: [{ kind: "text", body: "keep" }],
    });

    messageThreadCache.clearDecryptCaches();
    const key = `${"temp-rehydrate"}|${optimisticPayloadSentinel("temp-rehydrate").slice(0, 96)}`;
    const restored = messageThreadDecryptCache.getMessage(key);
    expect(restored?.text).toBe("keep");
    expect(restored?.sendStatus).toBe("sending");
  });

  it("remove drops temp from pending and query data", () => {
    insertOptimisticOutgoingThreadMessage({
      queryClient,
      conversationUuid,
      otherUserUuid,
      senderUserUuid: "me",
      clientMessageKey: "temp-3",
      blocks: [{ kind: "text", body: "bye" }],
    });

    removeOptimisticOutgoingThreadMessage({
      queryClient,
      conversationUuid,
      otherUserUuid,
      clientMessageKey: "temp-3",
    });

    expect(mergePendingOutgoingIntoMessages(conversationUuid, [])).toEqual([]);
    const data = queryClient.getQueryData<{ items: MsgMessageDto[] }>([
      "messages",
      conversationUuid,
      otherUserUuid,
    ]);
    expect(data?.items ?? []).toEqual([]);
  });
});
