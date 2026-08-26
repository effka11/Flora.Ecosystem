import { describe, expect, it } from "vitest";
import type { MsgConversationDto, MsgMessageDto } from "@flora/client-core/contracts";
import { optimisticPayloadSentinel } from "@/lib/messageBirthRegistry";
import {
  CHAT_DISK_MAX_THREADS,
  isThreadSnapshotFresh,
  parsePersistedConversations,
  parsePersistedGroupDetail,
  parsePersistedGroups,
  parsePersistedThread,
  parseThreadIndex,
  pruneThreadIndex,
  sanitizeConversationsForPersist,
  sanitizeThreadItemsForPersist,
  touchThreadIndex,
  type ThreadIndexEntry,
} from "@/lib/chatDiskCacheCore";

function conversation(overrides: Partial<MsgConversationDto> = {}): MsgConversationDto {
  return {
    conversationUuid: "conv-1",
    otherUserUuid: "user-2",
    otherUsername: "peer",
    otherDisplayName: "Peer",
    otherAvatarUuid: null,
    lastMessageEncryptedForMe: "fscp-wire-payload",
    lastMessageContent: null,
    lastMessageAt: "2026-08-24T10:00:00Z",
    lastMessageIsFromMe: false,
    unreadCount: 0,
    otherUserIsOnline: false,
    otherUserLastSeenAt: null,
    ...overrides,
  };
}

function message(overrides: Partial<MsgMessageDto> = {}): MsgMessageDto {
  return {
    messageUuid: "msg-1",
    conversationUuid: "conv-1",
    senderUserUuid: "user-2",
    encryptedPayload: "wire",
    createdAt: "2026-08-24T10:00:00Z",
    isFromMe: false,
    isRead: true,
    ...overrides,
  };
}

describe("sanitizeConversationsForPersist", () => {
  it("nulls plaintext preview when a wire is present (server parity)", () => {
    const page = {
      items: [conversation({ lastMessageContent: "decrypted preview" })],
      nextCursor: null,
    };
    const out = sanitizeConversationsForPersist(page);
    expect(out.items[0]!.lastMessageContent).toBeNull();
    expect(out.items[0]!.lastMessageEncryptedForMe).toBe("fscp-wire-payload");
  });

  it("drops optimistic sentinel wire and its preview", () => {
    const page = {
      items: [
        conversation({
          lastMessageEncryptedForMe: optimisticPayloadSentinel("client-key"),
          lastMessageContent: "optimistic preview",
        }),
      ],
      nextCursor: null,
    };
    const out = sanitizeConversationsForPersist(page);
    expect(out.items[0]!.lastMessageEncryptedForMe).toBeNull();
    expect(out.items[0]!.lastMessageContent).toBeNull();
  });

  it("keeps server plaintext when there is no wire (legacy non-E2E rows)", () => {
    const page = {
      items: [
        conversation({ lastMessageEncryptedForMe: null, lastMessageContent: "plain server text" }),
      ],
      nextCursor: null,
    };
    const out = sanitizeConversationsForPersist(page);
    expect(out.items[0]!.lastMessageContent).toBe("plain server text");
  });

  it("caps the number of persisted rows", () => {
    const page = {
      items: Array.from({ length: 100 }, (_, i) =>
        conversation({ conversationUuid: `conv-${i}` }),
      ),
      nextCursor: null,
    };
    expect(sanitizeConversationsForPersist(page, 60).items).toHaveLength(60);
  });
});

describe("sanitizeThreadItemsForPersist", () => {
  it("filters optimistic sentinels and keeps the newest tail", () => {
    const items = [
      message({ messageUuid: "m1" }),
      message({
        messageUuid: "temp",
        encryptedPayload: optimisticPayloadSentinel("temp"),
      }),
      message({ messageUuid: "m2" }),
      message({ messageUuid: "m3" }),
    ];
    const out = sanitizeThreadItemsForPersist(items, 2);
    expect(out.map((m) => m.messageUuid)).toEqual(["m2", "m3"]);
  });
});

describe("thread index LRU", () => {
  const entry = (uuid: string, touchedAt: number): ThreadIndexEntry => ({
    conversationUuid: uuid,
    kind: "dm",
    touchedAt,
  });

  it("evicts the least recently touched beyond the cap", () => {
    const entries = Array.from({ length: CHAT_DISK_MAX_THREADS + 2 }, (_, i) =>
      entry(`conv-${i}`, i + 1),
    );
    const { keep, evict } = pruneThreadIndex(entries);
    expect(keep).toHaveLength(CHAT_DISK_MAX_THREADS);
    expect(evict.map((e) => e.conversationUuid)).toEqual(["conv-1", "conv-0"]);
    expect(keep[0]!.conversationUuid).toBe(`conv-${CHAT_DISK_MAX_THREADS + 1}`);
  });

  it("dedupes by conversation keeping the freshest touch", () => {
    const { keep } = touchThreadIndex(
      [entry("conv-a", 10), entry("conv-b", 20)],
      entry("conv-a", 30),
    );
    expect(keep.map((e) => e.conversationUuid)).toEqual(["conv-a", "conv-b"]);
    expect(keep[0]!.touchedAt).toBe(30);
  });
});

describe("isThreadSnapshotFresh", () => {
  it("accepts within ttl and rejects beyond", () => {
    const now = 1_000_000;
    expect(isThreadSnapshotFresh(now - 5, now, 10)).toBe(true);
    expect(isThreadSnapshotFresh(now - 11, now, 10)).toBe(false);
    expect(isThreadSnapshotFresh(0, now, 10)).toBe(false);
    expect(isThreadSnapshotFresh(Number.NaN, now, 10)).toBe(false);
  });
});

describe("parse helpers never throw on corrupt input", () => {
  it.each([
    ["not json", "{"],
    ["wrong shape", JSON.stringify({ foo: 1 })],
    ["null", null],
  ])("conversations: %s", (_label, raw) => {
    expect(parsePersistedConversations(raw)).toBeNull();
  });

  it("roundtrips a valid conversations snapshot", () => {
    const raw = JSON.stringify({
      updatedAt: 123,
      page: { items: [conversation()], nextCursor: null },
    });
    const parsed = parsePersistedConversations(raw);
    expect(parsed?.updatedAt).toBe(123);
    expect(parsed?.page.items).toHaveLength(1);
  });

  it("roundtrips groups / thread / detail / index", () => {
    expect(
      parsePersistedGroups(JSON.stringify({ updatedAt: 1, items: [] }))?.items,
    ).toEqual([]);
    const thread = parsePersistedThread(
      JSON.stringify({
        updatedAt: 1,
        kind: "dm",
        conversationUuid: "Conv-Original-Case",
        otherUserUuid: "u",
        items: [message()],
      }),
    );
    expect(thread?.items).toHaveLength(1);
    expect(thread?.conversationUuid).toBe("Conv-Original-Case");
    expect(
      parsePersistedThread(
        JSON.stringify({
          updatedAt: 1,
          kind: "bogus",
          conversationUuid: "c",
          otherUserUuid: "u",
          items: [],
        }),
      ),
    ).toBeNull();
    expect(
      parsePersistedThread(
        JSON.stringify({ updatedAt: 1, kind: "dm", otherUserUuid: "u", items: [] }),
      ),
    ).toBeNull();
    expect(
      parsePersistedGroupDetail(
        JSON.stringify({
          updatedAt: 1,
          conversationUuid: "c",
          detail: { conversationUuid: "c" },
        }),
      )?.detail.conversationUuid,
    ).toBe("c");
    expect(parseThreadIndex(JSON.stringify([{ conversationUuid: "c", kind: "group", touchedAt: 5 }]))).toHaveLength(1);
    expect(parseThreadIndex(JSON.stringify([{ conversationUuid: "", kind: "dm", touchedAt: 5 }]))).toHaveLength(0);
    expect(parseThreadIndex("oops")).toEqual([]);
  });
});
