import { describe, expect, it } from "vitest";
import {
  buildChatPickPending,
  CHAT_PICK_PENDING_TTL_MS,
  CHAT_PICK_PENDING_VERSION,
  isChatPickPendingFresh,
  parseChatPickPending,
} from "@/lib/chatPickPendingCore";

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);

describe("chat pick pending marker", () => {
  it("stores a trimmed uuid with the moment the picker opened", () => {
    expect(buildChatPickPending(" conv-1 ", NOW)).toEqual({
      v: CHAT_PICK_PENDING_VERSION,
      conversationUuid: "conv-1",
      at: NOW,
    });
  });

  it("refuses a marker without a uuid", () => {
    expect(buildChatPickPending("   ", NOW)).toBeNull();
    expect(buildChatPickPending("conv-1", NaN)).toBeNull();
  });

  it("round-trips through JSON while fresh", () => {
    const pending = buildChatPickPending("conv-1", NOW)!;
    expect(parseChatPickPending(JSON.stringify(pending), NOW + 1000)).toEqual(pending);
  });

  it("rejects a marker older than the picker window", () => {
    const pending = buildChatPickPending("conv-1", NOW)!;
    expect(isChatPickPendingFresh(pending, NOW + CHAT_PICK_PENDING_TTL_MS)).toBe(true);
    expect(
      parseChatPickPending(
        JSON.stringify(pending),
        NOW + CHAT_PICK_PENDING_TTL_MS + 1,
      ),
    ).toBeNull();
    expect(parseChatPickPending(JSON.stringify(pending), NOW - 1)).toBeNull();
  });

  it("rejects malformed payloads", () => {
    expect(parseChatPickPending(null, NOW)).toBeNull();
    expect(parseChatPickPending("{", NOW)).toBeNull();
    expect(parseChatPickPending(JSON.stringify({ v: CHAT_PICK_PENDING_VERSION }), NOW)).toBeNull();
    expect(parseChatPickPending(JSON.stringify({ v: 99, conversationUuid: "a", at: NOW }), NOW)).toBeNull();
  });
});
