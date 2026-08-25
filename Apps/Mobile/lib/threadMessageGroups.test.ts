import { describe, expect, it } from "vitest";
import type { ThreadBubbleItem } from "@/components/messages/ChatMessageBubble";
import {
  buildThreadListItems,
  reuseThreadListItems,
  shouldHoldTrailingPeerAvatar,
  trailingPeerRunMessages,
  type ThreadListItem,
} from "./threadMessageGroups";

function msg(
  partial: Partial<ThreadBubbleItem> & { messageUuid: string; isFromMe: boolean },
): ThreadBubbleItem {
  return {
    text: "",
    previewText: "",
    imageBlocks: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    decryptState: "ok",
    ...partial,
  };
}

/** Компактная проекция item'а для сравнения. */
function shape(item: ThreadListItem): string {
  if (item.kind === "own") return `own:${item.message.messageUuid}`;
  return `peer:${item.message.messageUuid}@${item.groupKey}${item.isGroupTail ? "*" : ""}`;
}

describe("buildThreadListItems", () => {
  it("keeps groupKey of first raw uuid when start of run is hidden", () => {
    const a = msg({ messageUuid: "a", isFromMe: false });
    const b = msg({ messageUuid: "b", isFromMe: false });
    const items = buildThreadListItems([a, b], (m) => m.messageUuid !== "a");
    expect(items.map(shape)).toEqual(["peer:b@a*"]);
  });

  it("keeps same groupKey with decrypting hole in the middle", () => {
    const a = msg({ messageUuid: "a", isFromMe: false });
    const b = msg({ messageUuid: "b", isFromMe: false });
    const c = msg({ messageUuid: "c", isFromMe: false });
    const items = buildThreadListItems([a, b, c], (m) => m.messageUuid !== "b");
    expect(items.map(shape)).toEqual(["peer:a@a", "peer:c@a*"]);
  });

  it("breaks peer runs on own message; only run tail carries avatar", () => {
    const a = msg({ messageUuid: "a", isFromMe: false });
    const me = msg({ messageUuid: "me", isFromMe: true });
    const b = msg({ messageUuid: "b", isFromMe: false });
    const items = buildThreadListItems([a, me, b], () => true);
    expect(items.map(shape)).toEqual(["peer:a@a*", "own:me", "peer:b@b*"]);
  });

  it("splits consecutive peer runs by senderUserUuid", () => {
    const a = msg({ messageUuid: "a", isFromMe: false, senderUserUuid: "u1" });
    const b = msg({ messageUuid: "b", isFromMe: false, senderUserUuid: "u2" });
    const c = msg({ messageUuid: "c", isFromMe: false, senderUserUuid: "u2" });
    const items = buildThreadListItems([a, b, c], () => true);
    expect(items.map(shape)).toEqual(["peer:a@a*", "peer:b@b", "peer:c@b*"]);
  });

  it("splits when sender uuid is missing mid-run", () => {
    const a = msg({ messageUuid: "a", isFromMe: false, senderUserUuid: "u1" });
    const hole = msg({ messageUuid: "hole", isFromMe: false });
    const b = msg({ messageUuid: "b", isFromMe: false, senderUserUuid: "u1" });
    const items = buildThreadListItems([a, hole, b], () => true);
    expect(items.map(shape)).toEqual(["peer:a@a*", "peer:hole@hole*", "peer:b@b*"]);
  });

  it("keeps dm peers without sender uuid in one run", () => {
    const a = msg({ messageUuid: "a", isFromMe: false });
    const b = msg({ messageUuid: "b", isFromMe: false });
    const items = buildThreadListItems([a, b], () => true);
    expect(items.map(shape)).toEqual(["peer:a@a", "peer:b@a*"]);
  });

  it("omits peer run when all hidden", () => {
    const a = msg({ messageUuid: "a", isFromMe: false });
    expect(buildThreadListItems([a], () => false)).toEqual([]);
  });
});

describe("trailingPeerRunMessages", () => {
  it("collects the newest-first peer prefix of one run", () => {
    const a = msg({ messageUuid: "a", isFromMe: false });
    const b = msg({ messageUuid: "b", isFromMe: false });
    const me = msg({ messageUuid: "me", isFromMe: true });
    // Хронологический порядок [me, a, b] → newest-first [b*, a, me].
    const newestFirst = [...buildThreadListItems([me, a, b], () => true)].reverse();
    expect(trailingPeerRunMessages(newestFirst).map((m) => m.messageUuid)).toEqual([
      "b",
      "a",
    ]);
  });

  it("returns empty when newest item is own", () => {
    const a = msg({ messageUuid: "a", isFromMe: false });
    const me = msg({ messageUuid: "me", isFromMe: true });
    const newestFirst = [...buildThreadListItems([a, me], () => true)].reverse();
    expect(trailingPeerRunMessages(newestFirst)).toEqual([]);
  });

  it("stops at the previous run boundary", () => {
    const a = msg({ messageUuid: "a", isFromMe: false, senderUserUuid: "u1" });
    const b = msg({ messageUuid: "b", isFromMe: false, senderUserUuid: "u2" });
    const newestFirst = [...buildThreadListItems([a, b], () => true)].reverse();
    expect(trailingPeerRunMessages(newestFirst).map((m) => m.messageUuid)).toEqual(["b"]);
  });
});

describe("reuseThreadListItems", () => {
  it("returns prev array by reference when nothing changed", () => {
    const a = msg({ messageUuid: "a", isFromMe: false });
    const b = msg({ messageUuid: "b", isFromMe: true });
    const prev = buildThreadListItems([a, b], () => true);
    const next = buildThreadListItems([a, b], () => true);
    expect(reuseThreadListItems(prev, next)).toBe(prev);
  });

  it("reuses untouched item objects when a new message is prepended", () => {
    const a = msg({ messageUuid: "a", isFromMe: true });
    const b = msg({ messageUuid: "b", isFromMe: true });
    const prev = buildThreadListItems([a], () => true);
    const next = buildThreadListItems([a, b], () => true);
    const reused = reuseThreadListItems(prev, next);
    expect(reused).not.toBe(prev);
    expect(reused[0]).toBe(prev[0]);
    expect(reused[1]!.message.messageUuid).toBe("b");
  });

  it("does not reuse when message row identity changed", () => {
    const a1 = msg({ messageUuid: "a", isFromMe: true });
    const a2 = msg({ messageUuid: "a", isFromMe: true, isRead: true });
    const prev = buildThreadListItems([a1], () => true);
    const next = buildThreadListItems([a2], () => true);
    const reused = reuseThreadListItems(prev, next);
    expect(reused).not.toBe(prev);
    expect(reused[0]).not.toBe(prev[0]);
    expect(reused[0]!.message).toBe(a2);
  });

  it("does not reuse peer item when isGroupTail flips", () => {
    const a = msg({ messageUuid: "a", isFromMe: false });
    const b = msg({ messageUuid: "b", isFromMe: false });
    // Был хвостом run'а — стал серединой: item пересоздаётся, аватар уезжает.
    const prev = buildThreadListItems([a], () => true);
    const next = buildThreadListItems([a, b], () => true);
    const reused = reuseThreadListItems(prev, next);
    expect(reused[0]!.message).toBe(a);
    expect(reused[0]).not.toBe(prev[0]);
    expect((reused[0] as { isGroupTail: boolean }).isGroupTail).toBe(false);
  });
});

describe("shouldHoldTrailingPeerAvatar", () => {
  it("lets new group avatar ride with message", () => {
    expect(shouldHoldTrailingPeerAvatar([{ messageUuid: "b" }], new Set(["b"]))).toBe(
      false,
    );
  });

  it("holds avatar when appending to existing group", () => {
    expect(
      shouldHoldTrailingPeerAvatar(
        [{ messageUuid: "a" }, { messageUuid: "b" }],
        new Set(["b"]),
      ),
    ).toBe(true);
  });
});
