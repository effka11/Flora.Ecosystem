import type { MsgConversationDto } from "@flora/client-core/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { messagePreviewCache, messagePreviewKey } from "@/stores/messagePreviewCache";
import { warmMessagesListPreviews } from "./useMessagesListPreviewDecrypt";

vi.mock("@/stores/fscpStore", () => ({
  useFscpStore: () => {
    throw new Error("useFscpStore is not used by warmMessagesListPreviews tests");
  },
}));

function conversation(
  conversationUuid: string,
  overrides: Partial<MsgConversationDto> = {},
): MsgConversationDto {
  return {
    conversationUuid,
    otherUserUuid: `user-${conversationUuid}`,
    otherUsername: `username-${conversationUuid}`,
    otherDisplayName: `Display ${conversationUuid}`,
    otherAvatarUuid: null,
    lastMessageEncryptedForMe: `enc-${conversationUuid}`,
    lastMessageContent: null,
    lastMessageAt: "2026-08-20T00:00:00.000Z",
    lastMessageIsFromMe: false,
    unreadCount: 0,
    otherUserIsOnline: false,
    otherUserLastSeenAt: null,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createScrollGate(initiallySettled: boolean) {
  let settled = initiallySettled;
  const listeners = new Set<(settled: boolean) => void>();
  return {
    isScrollSettled: () => settled,
    subscribeScrollSettled: (listener: (settled: boolean) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setSettled(next: boolean) {
      if (next === settled) return;
      settled = next;
      for (const listener of [...listeners]) listener(settled);
    },
  };
}

const alwaysSettled = {
  isScrollSettled: () => true,
  subscribeScrollSettled: () => () => {},
};

afterEach(() => {
  messagePreviewCache.clear();
});

describe("warmMessagesListPreviews", () => {
  it("skips decrypt on a messagePreviewKey cache hit", async () => {
    const item = conversation("c1");
    const mk = messagePreviewKey(item.lastMessageEncryptedForMe, item.lastMessageAt);
    messagePreviewCache.set(item.conversationUuid, mk, "cached preview");
    const decryptOne = vi.fn(() => Promise.resolve("should not run"));

    const { done } = warmMessagesListPreviews([item], {
      decryptOne,
      ...alwaysSettled,
      yieldBetweenSteps: () => Promise.resolve(),
    });

    await expect(done).resolves.toEqual({ c1: "cached preview" });
    expect(decryptOne).not.toHaveBeenCalled();
    expect(messagePreviewCache.get("c1")?.text).toBe("cached preview");
  });

  it("pauses decrypt while unsettled and resumes when scroll settles", async () => {
    const scroll = createScrollGate(false);
    const decryptOne = vi.fn((item: MsgConversationDto) => Promise.resolve(`d:${item.conversationUuid}`));

    const handle = warmMessagesListPreviews([conversation("a"), conversation("b")], {
      decryptOne,
      isScrollSettled: scroll.isScrollSettled,
      subscribeScrollSettled: scroll.subscribeScrollSettled,
      yieldBetweenSteps: () => Promise.resolve(),
    });

    await Promise.resolve();
    expect(decryptOne).not.toHaveBeenCalled();

    scroll.setSettled(true);
    await expect(handle.done).resolves.toEqual({ a: "d:a", b: "d:b" });
    expect(decryptOne).toHaveBeenCalledTimes(2);
  });

  it("cancels an in-flight run when a new conversations list starts warming", async () => {
    const firstDecrypt = deferred<string>();
    const decryptFirst = vi.fn((item: MsgConversationDto) => {
      if (item.conversationUuid === "old-1") return firstDecrypt.promise;
      return Promise.resolve("old-2");
    });
    const decryptSecond = vi.fn((item: MsgConversationDto) =>
      Promise.resolve(`new:${item.conversationUuid}`),
    );

    const first = warmMessagesListPreviews([conversation("old-1"), conversation("old-2")], {
      decryptOne: decryptFirst,
      ...alwaysSettled,
      yieldBetweenSteps: () => Promise.resolve(),
    });
    expect(decryptFirst).toHaveBeenCalledTimes(1);

    const second = warmMessagesListPreviews([conversation("new-1")], {
      decryptOne: decryptSecond,
      ...alwaysSettled,
      yieldBetweenSteps: () => Promise.resolve(),
    });

    firstDecrypt.resolve("late");
    await expect(first.done).resolves.toBeNull();
    expect(decryptFirst).toHaveBeenCalledTimes(1);

    await expect(second.done).resolves.toEqual({ "new-1": "new:new-1" });
    expect(decryptSecond).toHaveBeenCalledTimes(1);
  });

  it("yields between items so the second decrypt waits for the injected step", async () => {
    const firstDecrypt = deferred<string>();
    const between = deferred<void>();
    const decryptOne = vi.fn((item: MsgConversationDto) => {
      if (item.conversationUuid === "c1") return firstDecrypt.promise;
      return Promise.resolve("two");
    });

    const handle = warmMessagesListPreviews([conversation("c1"), conversation("c2")], {
      decryptOne,
      ...alwaysSettled,
      yieldBetweenSteps: () => between.promise,
    });
    expect(decryptOne.mock.calls.map(([item]) => item.conversationUuid)).toEqual(["c1"]);

    firstDecrypt.resolve("one");
    await Promise.resolve();
    await Promise.resolve();
    expect(decryptOne).toHaveBeenCalledTimes(1);

    between.resolve();
    await expect(handle.done).resolves.toEqual({ c1: "one", c2: "two" });
    expect(decryptOne.mock.calls.map(([item]) => item.conversationUuid)).toEqual(["c1", "c2"]);
  });

  it("does not start the next decrypt until scroll settles after an in-flight call", async () => {
    const scroll = createScrollGate(true);
    const firstDecrypt = deferred<string>();
    const decryptOne = vi.fn((item: MsgConversationDto) => {
      if (item.conversationUuid === "c1") return firstDecrypt.promise;
      return Promise.resolve("two");
    });

    const handle = warmMessagesListPreviews([conversation("c1"), conversation("c2")], {
      decryptOne,
      isScrollSettled: scroll.isScrollSettled,
      subscribeScrollSettled: scroll.subscribeScrollSettled,
      yieldBetweenSteps: () => Promise.resolve(),
    });
    expect(decryptOne).toHaveBeenCalledTimes(1);

    scroll.setSettled(false);
    firstDecrypt.resolve("one");
    await Promise.resolve();
    await Promise.resolve();
    expect(decryptOne).toHaveBeenCalledTimes(1);

    scroll.setSettled(true);
    await expect(handle.done).resolves.toEqual({ c1: "one", c2: "two" });
    expect(decryptOne).toHaveBeenCalledTimes(2);
  });
});
