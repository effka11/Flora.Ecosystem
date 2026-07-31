import { describe, expect, it } from "vitest";
import type { ThreadBubbleItem } from "@/components/messages/ChatMessageBubble";
import { buildThreadListItems } from "./threadMessageGroups";

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

describe("buildThreadListItems", () => {
  it("keeps groupKey of first raw uuid when start of run is hidden", () => {
    const a = msg({ messageUuid: "a", isFromMe: false });
    const b = msg({ messageUuid: "b", isFromMe: false });
    const items = buildThreadListItems([a, b], (m) => m.messageUuid !== "a");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "peerGroup", groupKey: "a" });
    if (items[0]?.kind === "peerGroup") {
      expect(items[0].messages.map((m) => m.messageUuid)).toEqual(["b"]);
    }
  });

  it("keeps same groupKey with decrypting hole in the middle", () => {
    const a = msg({ messageUuid: "a", isFromMe: false });
    const b = msg({ messageUuid: "b", isFromMe: false });
    const c = msg({ messageUuid: "c", isFromMe: false });
    const items = buildThreadListItems([a, b, c], (m) => m.messageUuid !== "b");
    expect(items[0]).toMatchObject({ kind: "peerGroup", groupKey: "a" });
    if (items[0]?.kind === "peerGroup") {
      expect(items[0].messages.map((m) => m.messageUuid)).toEqual(["a", "c"]);
    }
  });

  it("breaks peer groups on own message", () => {
    const a = msg({ messageUuid: "a", isFromMe: false });
    const me = msg({ messageUuid: "me", isFromMe: true });
    const b = msg({ messageUuid: "b", isFromMe: false });
    const items = buildThreadListItems([a, me, b], () => true);
    expect(items.map((i) => i.kind)).toEqual(["peerGroup", "own", "peerGroup"]);
    expect(items[0]).toMatchObject({ kind: "peerGroup", groupKey: "a" });
    expect(items[2]).toMatchObject({ kind: "peerGroup", groupKey: "b" });
  });

  it("omits peer run when all hidden", () => {
    const a = msg({ messageUuid: "a", isFromMe: false });
    expect(buildThreadListItems([a], () => false)).toEqual([]);
  });
});
