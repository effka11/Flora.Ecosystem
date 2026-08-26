import { describe, expect, it } from "vitest";
import type { MsgConversationDto, MsgGroupListItem } from "@flora/client-core/contracts";
import type { FscpImageBlock, FscpVoiceBlock } from "@flora/client-core/fscp";
import {
  CHAT_PREFETCH_MIN_REFRESH_AGE_MS,
  createThreadMediaWarmBudget,
  selectThreadMediaWarmTargets,
  selectThreadPrefetchCandidates,
  threadNeedsMessagesFetch,
  type ThreadFreshnessProbe,
  type ThreadMediaRow,
} from "@/lib/chatPrefetchPolicy";

const NOW = 1_700_000_000_000;

function conversation(overrides: Partial<MsgConversationDto> = {}): MsgConversationDto {
  return {
    conversationUuid: "conv-1",
    otherUserUuid: "user-1",
    otherUsername: "peer",
    otherDisplayName: "Peer",
    otherAvatarUuid: null,
    lastMessageEncryptedForMe: "wire",
    lastMessageContent: null,
    lastMessageAt: "2026-08-24T10:00:00Z",
    lastMessageIsFromMe: false,
    unreadCount: 0,
    otherUserIsOnline: false,
    otherUserLastSeenAt: null,
    ...overrides,
  };
}

function group(overrides: Partial<MsgGroupListItem> = {}): MsgGroupListItem {
  return {
    conversationUuid: "group-1",
    title: "Группа",
    createdByUserUuid: "user-9",
    createdAt: "2026-08-01T00:00:00Z",
    memberCount: 3,
    lastMessageEncryptedWire: "wire",
    lastMessageAt: "2026-08-24T09:00:00Z",
    lastMessageIsFromMe: false,
    lastMessageSenderDisplayName: null,
    unreadCount: 0,
    ...overrides,
  };
}

function probe(overrides: Partial<ThreadFreshnessProbe> = {}): ThreadFreshnessProbe {
  return {
    hasData: true,
    newestCreatedAt: "2026-08-24T10:00:00Z",
    dataUpdatedAt: NOW - CHAT_PREFETCH_MIN_REFRESH_AGE_MS - 1_000,
    isInvalidated: false,
    isFetching: false,
    ...overrides,
  };
}

describe("threadNeedsMessagesFetch", () => {
  it("fetches when there is no cached data", () => {
    expect(threadNeedsMessagesFetch(null, "2026-08-24T10:00:00Z", NOW)).toBe(true);
    expect(
      threadNeedsMessagesFetch(probe({ hasData: false }), "2026-08-24T10:00:00Z", NOW),
    ).toBe(true);
  });

  it("skips while a fetch is already in flight", () => {
    expect(
      threadNeedsMessagesFetch(probe({ isFetching: true, isInvalidated: true }), null, NOW),
    ).toBe(false);
  });

  it("respects the refresh cooldown", () => {
    expect(
      threadNeedsMessagesFetch(
        probe({ dataUpdatedAt: NOW - 1_000, newestCreatedAt: "2026-08-24T09:00:00Z" }),
        "2026-08-24T10:00:00Z",
        NOW,
      ),
    ).toBe(false);
  });

  it("fetches when invalidated or when the list shows a newer message", () => {
    expect(threadNeedsMessagesFetch(probe({ isInvalidated: true }), null, NOW)).toBe(true);
    expect(
      threadNeedsMessagesFetch(
        probe({ newestCreatedAt: "2026-08-24T09:59:59Z" }),
        "2026-08-24T10:00:00Z",
        NOW,
      ),
    ).toBe(true);
    expect(
      threadNeedsMessagesFetch(
        probe({ newestCreatedAt: "2026-08-24T10:00:00Z" }),
        "2026-08-24T10:00:00Z",
        NOW,
      ),
    ).toBe(false);
  });
});

describe("selectThreadPrefetchCandidates", () => {
  const freshProbe = () => probe({ newestCreatedAt: "2099-01-01T00:00:00Z" });

  it("prioritizes unread, then recency, and caps the count", () => {
    const conversations = [
      conversation({ conversationUuid: "old-read", lastMessageAt: "2026-08-01T00:00:00Z" }),
      conversation({ conversationUuid: "new-read", lastMessageAt: "2026-08-24T00:00:00Z" }),
      conversation({
        conversationUuid: "old-unread",
        lastMessageAt: "2026-07-01T00:00:00Z",
        unreadCount: 3,
      }),
    ];
    const out = selectThreadPrefetchCandidates({
      conversations,
      groups: [],
      probeDm: () => null,
      probeGroup: () => null,
      hasGroupDetail: () => true,
      now: NOW,
      maxDm: 2,
    });
    expect(out.map((c) => c.conversationUuid)).toEqual(["old-unread", "new-read"]);
    expect(out.every((c) => c.needsMessages)).toBe(true);
  });

  it("excludes the active thread and rows without a peer uuid", () => {
    const conversations = [
      conversation({ conversationUuid: "Conv-Active" }),
      conversation({ conversationUuid: "conv-b", otherUserUuid: "" }),
      conversation({ conversationUuid: "conv-c", otherUserUuid: "user-c" }),
    ];
    const out = selectThreadPrefetchCandidates({
      conversations,
      groups: [],
      probeDm: () => null,
      probeGroup: () => null,
      hasGroupDetail: () => true,
      activeThreadUuid: "conv-active",
      now: NOW,
    });
    expect(out.map((c) => c.conversationUuid)).toEqual(["conv-c"]);
  });

  it("marks fresh threads as warm-only (needsMessages false)", () => {
    const out = selectThreadPrefetchCandidates({
      conversations: [conversation()],
      groups: [],
      probeDm: freshProbe,
      probeGroup: () => null,
      hasGroupDetail: () => true,
      now: NOW,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.needsMessages).toBe(false);
  });

  it("adds groups with needsDetail when roster is not cached", () => {
    const out = selectThreadPrefetchCandidates({
      conversations: [],
      groups: [
        group({ conversationUuid: "g-with-detail" }),
        group({ conversationUuid: "g-without-detail", unreadCount: 2 }),
      ],
      probeDm: () => null,
      probeGroup: freshProbe,
      hasGroupDetail: (uuid) => uuid === "g-with-detail",
      now: NOW,
    });
    expect(out.map((c) => [c.conversationUuid, c.needsDetail])).toEqual([
      ["g-without-detail", true],
      ["g-with-detail", false],
    ]);
    expect(out.every((c) => c.kind === "group" && c.otherUserUuid === "")).toBe(true);
  });

  it("sorts groups by lastMessageAt falling back to createdAt", () => {
    const out = selectThreadPrefetchCandidates({
      conversations: [],
      groups: [
        group({
          conversationUuid: "g-old",
          lastMessageAt: null,
          createdAt: "2026-08-10T00:00:00Z",
        }),
        group({
          conversationUuid: "g-new",
          lastMessageAt: "2026-08-24T12:00:00Z",
        }),
      ],
      probeDm: () => null,
      probeGroup: () => null,
      hasGroupDetail: () => true,
      now: NOW,
      maxGroups: 1,
    });
    expect(out.map((c) => c.conversationUuid)).toEqual(["g-new"]);
  });
});

function imageBlock(assetUuid: string): FscpImageBlock {
  return {
    kind: "image",
    assetUuid,
    contentType: "image/x-flora-frc-i",
    encryption: { algorithm: "aes-gcm", keyBase64Url: "k", nonceBase64Url: "n" },
  };
}

function voiceBlock(assetUuid: string): FscpVoiceBlock {
  return {
    kind: "voice",
    assetUuid,
    durationMs: 1200,
    waveform: [1, 2, 3],
    contentType: "audio/mp4",
    encryption: { algorithm: "aes-gcm", keyBase64Url: "k", nonceBase64Url: "n" },
  };
}

describe("selectThreadMediaWarmTargets", () => {
  it("picks newest media first (rows oldest-first) and decrements the budget", () => {
    const rows: ThreadMediaRow[] = [
      { imageBlocks: [imageBlock("img-old")] },
      { voiceBlock: voiceBlock("v-old") },
      { imageBlocks: [imageBlock("img-new-a"), imageBlock("img-new-b")] },
      { voiceBlock: voiceBlock("v-new") },
    ];
    const budget = createThreadMediaWarmBudget();
    const out = selectThreadMediaWarmTargets(rows, budget, {
      imagesPerThread: 2,
      voicesPerThread: 1,
    });
    expect(out.images.map((b) => b.assetUuid)).toEqual(["img-new-a", "img-new-b"]);
    expect(out.voices.map((b) => b.assetUuid)).toEqual(["v-new"]);
    expect(budget.images).toBe(22);
    expect(budget.voices).toBe(11);
  });

  it("clamps to the remaining run budget and never goes negative", () => {
    const rows: ThreadMediaRow[] = [
      { imageBlocks: [imageBlock("a"), imageBlock("b"), imageBlock("c")] },
      { voiceBlock: voiceBlock("v1") },
      { voiceBlock: voiceBlock("v2") },
    ];
    const budget = { images: 1, voices: 0 };
    const out = selectThreadMediaWarmTargets(rows, budget);
    // Новые первыми: v2 новее v1, но voices-бюджет исчерпан; картинок — одна.
    expect(out.images.map((b) => b.assetUuid)).toEqual(["a"]);
    expect(out.voices).toEqual([]);
    expect(budget).toEqual({ images: 0, voices: 0 });

    const drained = selectThreadMediaWarmTargets(rows, budget);
    expect(drained.images).toEqual([]);
    expect(drained.voices).toEqual([]);
    expect(budget).toEqual({ images: 0, voices: 0 });
  });

  it("collects voice and images from the same row", () => {
    const rows: ThreadMediaRow[] = [
      { imageBlocks: [imageBlock("img")], voiceBlock: voiceBlock("v") },
    ];
    const out = selectThreadMediaWarmTargets(rows, createThreadMediaWarmBudget());
    expect(out.images.map((b) => b.assetUuid)).toEqual(["img"]);
    expect(out.voices.map((b) => b.assetUuid)).toEqual(["v"]);
  });
});
