import type { MsgConversationDto } from "@flora/client-core/contracts";
import { describe, expect, it } from "vitest";
import {
  applyOutgoingToConversations,
  type OutgoingConversationPatch,
} from "./messageThreadOutgoing";

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
});
