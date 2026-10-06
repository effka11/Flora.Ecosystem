import { describe, expect, it } from "vitest";
import type { MsgMessageDto } from "@flora/client-core/contracts";
import type { ThreadBubbleItem } from "@/components/messages/ChatMessageBubble";
import {
  MESSAGE_DECRYPT_THREAD_LIMIT,
  hydrateDecryptWarm,
  messageDecryptThreadCount,
  messageThreadCache,
  messageThreadDecryptCache,
  retainMessageDecryptThreads,
  snapshotDecryptWarm,
} from "@/stores/messageThreadCache";

function bubble(messageUuid: string): ThreadBubbleItem {
  return {
    messageUuid,
    text: messageUuid,
    previewText: messageUuid,
    imageBlocks: [],
    isFromMe: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    decryptState: "ok",
    isRead: true,
  } as ThreadBubbleItem;
}

function dto(conversationUuid: string, messageUuid: string): MsgMessageDto {
  return {
    messageUuid,
    conversationUuid,
    senderUserUuid: "user",
    encryptedPayload: "wire",
    createdAt: "2026-01-01T00:00:00.000Z",
    isFromMe: false,
    isRead: false,
  };
}

function seedThread(conversationUuid: string): void {
  const messageUuid = `${conversationUuid}-m`;
  messageThreadDecryptCache.setMessage(`${messageUuid}|wire`, bubble(messageUuid));
  messageThreadDecryptCache.set(conversationUuid, [bubble(messageUuid)]);
}

describe("message decrypt thread limit", () => {
  it("keeps at most 32 threads and does not evict the open one", () => {
    messageThreadCache.clear();
    retainMessageDecryptThreads("open", ["t0"]);
    retainMessageDecryptThreads(
      "prefetch",
      Array.from({ length: 5 }, (_, index) => `t${index}`),
    );
    for (let index = 0; index < 40; index += 1) seedThread(`t${index}`);
    expect(messageDecryptThreadCount()).toBeLessThanOrEqual(MESSAGE_DECRYPT_THREAD_LIMIT);
    expect(messageThreadDecryptCache.get("t0")).toBeDefined();
    expect(messageThreadDecryptCache.getMessage("t0-m|wire")).toBeDefined();
    expect(messageThreadDecryptCache.get("t1")).toBeDefined();
    expect(messageThreadDecryptCache.get("t5")).toBeUndefined();
  });

  it("drops wire rows with the conversation and on anonymous clear", () => {
    messageThreadCache.clear();
    seedThread("gone");
    messageThreadCache.set("gone", [dto("gone", "gone-m")]);
    messageThreadDecryptCache.setMessage("gone-m|other", bubble("gone-m"));
    messageThreadCache.clearConversation("gone");
    expect(messageThreadCache.get("gone")).toBeUndefined();
    expect(messageThreadDecryptCache.get("gone")).toBeUndefined();
    expect(messageThreadDecryptCache.getMessage("gone-m|wire")).toBeUndefined();
    expect(messageThreadDecryptCache.getMessage("gone-m|other")).toBeUndefined();

    seedThread("kept");
    messageThreadDecryptCache.clearConversation("kept");
    expect(messageThreadDecryptCache.get("kept")).toBeUndefined();
    expect(messageThreadDecryptCache.getMessage("kept-m|wire")).toBeDefined();

    messageThreadCache.clear();
    seedThread("late");
    messageThreadDecryptCache.setMessage("late-m|after", bubble("late-m"));
    messageThreadDecryptCache.deleteMessage("late-m|wire");
    for (let index = 0; index < MESSAGE_DECRYPT_THREAD_LIMIT; index += 1) seedThread(`n${index}`);
    expect(messageThreadDecryptCache.getMessage("late-m|after")).toBeUndefined();
    expect(messageThreadDecryptCache.getMessage("late-m|wire")).toBeUndefined();

    messageThreadCache.clear();
    expect(messageDecryptThreadCount()).toBe(0);
    expect(messageThreadDecryptCache.get("kept")).toBeUndefined();
    expect(messageThreadDecryptCache.getMessage("kept-m|wire")).toBeUndefined();
  });

  it("restores a terminal tail from a snapshot without a second decrypt", () => {
    messageThreadCache.clear();
    messageThreadCache.set("warm", [dto("warm", "warm-m")]);
    seedThread("warm");
    const snap = snapshotDecryptWarm();
    messageThreadCache.clear();
    messageThreadCache.set("warm", [dto("warm", "warm-m")]);
    hydrateDecryptWarm(snap);
    expect(messageThreadDecryptCache.getMessage("warm-m|wire")?.text).toBe("warm-m");
    expect(messageThreadDecryptCache.getMessage("warm-m|wire")?.decryptState).toBe("ok");
    expect(messageThreadDecryptCache.get("warm")?.[0]?.messageUuid).toBe("warm-m");
  });
});
