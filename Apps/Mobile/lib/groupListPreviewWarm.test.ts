import { describe, expect, it, vi } from "vitest";
import type { GroupChat } from "./groupChatTypes";
import { warmGroupListPreviews } from "./groupListPreviewWarm";

function group(conversationUuid: string, wire: string | null = "fscpg1:x"): GroupChat {
  return {
    conversationUuid,
    title: "G",
    createdByUserUuid: "u1",
    members: [],
    memberCount: 2,
    lastMessagePreview: "plain",
    lastMessageEncryptedWire: wire,
    lastMessageAt: "2026-08-20T00:00:00.000Z",
    lastMessageIsFromMe: false,
    lastMessageSenderDisplayName: null,
    unreadCount: 0,
    createdAt: "2026-08-20T00:00:00.000Z",
  };
}

describe("warmGroupListPreviews", () => {
  it("maps decrypt results by conversation uuid", async () => {
    const decryptOne = vi.fn(async (g: GroupChat) => `d:${g.conversationUuid}`);
    const { done } = warmGroupListPreviews([group("g1"), group("g2")], {
      decryptOne,
      isScrollSettled: () => true,
      subscribeScrollSettled: () => () => {},
      yieldBetweenSteps: () => Promise.resolve(),
    });
    await expect(done).resolves.toEqual({ g1: "d:g1", g2: "d:g2" });
    expect(decryptOne).toHaveBeenCalledTimes(2);
  });
});
