import { describe, expect, it } from "vitest";
import {
  buildChatSurfaceRecord,
  chatSurfaceRecordKey,
  chatSurfaceRouteParams,
  CHAT_SURFACE_RECORD_TTL_MS,
  CHAT_SURFACE_RECORD_VERSION,
  isChatSurfaceRecordFresh,
  parseChatSurfaceRecord,
} from "@/lib/chatSurfaceRecordCore";

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);

describe("chat surface record", () => {
  it("keeps only non-empty route params", () => {
    const record = buildChatSurfaceRecord(
      {
        conversationUuid: " conv-1 ",
        kind: "groupChat",
        title: "  ",
        otherUserUuid: "peer-1",
      },
      NOW,
    );
    expect(record).toEqual({
      v: CHAT_SURFACE_RECORD_VERSION,
      savedAt: NOW,
      conversationUuid: "conv-1",
      kind: "groupChat",
      otherUserUuid: "peer-1",
    });
  });

  it("refuses a record without a conversation uuid", () => {
    expect(buildChatSurfaceRecord({ conversationUuid: "  " }, NOW)).toBeNull();
  });

  it("round-trips through JSON and restores route params", () => {
    const record = buildChatSurfaceRecord(
      { conversationUuid: "conv-1", kind: "groupChat", title: "Team", otherUserUuid: "peer-1" },
      NOW,
    )!;
    const parsed = parseChatSurfaceRecord(JSON.stringify(record), NOW + 1000);
    expect(parsed).toEqual(record);
    expect(chatSurfaceRouteParams(parsed!)).toEqual({
      conversationUuid: "conv-1",
      kind: "groupChat",
      title: "Team",
      otherUserUuid: "peer-1",
    });
  });

  it("drops a stale record and rejects malformed payloads", () => {
    const record = buildChatSurfaceRecord({ conversationUuid: "conv-1" }, NOW)!;
    expect(parseChatSurfaceRecord(JSON.stringify(record), NOW)).toEqual(record);
    expect(
      parseChatSurfaceRecord(
        JSON.stringify(record),
        NOW + CHAT_SURFACE_RECORD_TTL_MS + 1,
      ),
    ).toBeNull();
    expect(parseChatSurfaceRecord("not json", NOW)).toBeNull();
    expect(parseChatSurfaceRecord(JSON.stringify({ v: 999 }), NOW)).toBeNull();
    expect(isChatSurfaceRecordFresh(record, NOW)).toBe(true);
  });

  it("keys differ by chat and by route params", () => {
    const a = buildChatSurfaceRecord({ conversationUuid: "a" }, NOW)!;
    const b = buildChatSurfaceRecord({ conversationUuid: "b" }, NOW)!;
    const aWithTitle = buildChatSurfaceRecord({ conversationUuid: "a", title: "T" }, NOW)!;
    expect(chatSurfaceRecordKey(a)).not.toBe(chatSurfaceRecordKey(b));
    expect(chatSurfaceRecordKey(a)).not.toBe(chatSurfaceRecordKey(aWithTitle));
  });
});
