import { describe, expect, it } from "vitest";
import {
  CHAT_WARM_REVEAL_TAIL,
  diagnoseChatWarmOpen,
  formatChatWarmOpenDiagnosis,
  isChatThreadFullyWarm,
  isChatWarmBenchPageReady,
} from "@/lib/chatWarmReveal";

type Message = { messageUuid: string };
type Row = { decryptState: "ok" | "failed" | "decrypting"; text: string };

function messages(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({ messageUuid: `m-${index}` }));
}

describe("isChatThreadFullyWarm", () => {
  it("requires a cached page and a terminal measured tail", () => {
    expect(
      isChatThreadFullyWarm({
        messages: null,
        readDecrypt: () => undefined,
        hasMeasure: () => true,
      }),
    ).toBe(false);

    expect(
      isChatThreadFullyWarm({
        messages: [],
        readDecrypt: () => undefined,
        hasMeasure: () => true,
      }),
    ).toBe(true);

    const page = messages(20);
    const rows = new Map<string, Row>(
      page.map((message) => [message.messageUuid, { decryptState: "ok", text: message.messageUuid }]),
    );
    rows.set("m-0", { decryptState: "decrypting", text: "old" });
    const measured = new Set(page.slice(-CHAT_WARM_REVEAL_TAIL).map((message) => message.messageUuid));
    expect(
      isChatThreadFullyWarm({
        messages: page,
        readDecrypt: (message) => rows.get(message.messageUuid),
        hasMeasure: (row) => measured.has(row.text),
      }),
    ).toBe(true);

    const tail = page.slice(-CHAT_WARM_REVEAL_TAIL);
    rows.set(tail[0]!.messageUuid, { decryptState: "decrypting", text: "wait" });
    expect(
      isChatThreadFullyWarm({
        messages: page,
        readDecrypt: (message) => rows.get(message.messageUuid),
        hasMeasure: () => true,
      }),
    ).toBe(false);

    rows.set(tail[0]!.messageUuid, { decryptState: "failed", text: "x" });
    expect(
      isChatThreadFullyWarm({
        messages: page,
        readDecrypt: (message) => rows.get(message.messageUuid),
        hasMeasure: () => false,
      }),
    ).toBe(false);
  });
});

describe("diagnoseChatWarmOpen", () => {
  it("counts the tail and names why the warm path cannot show", () => {
    const missing = diagnoseChatWarmOpen({
      messages: null,
      readDecrypt: () => undefined,
      hasMeasure: () => true,
    });
    expect(missing.blocker).toBe("page");
    expect(missing.warm).toBe(false);
    expect(formatChatWarmOpenDiagnosis(missing)).toContain("page=нет");

    const page = messages(20);
    const tail = page.slice(-CHAT_WARM_REVEAL_TAIL);
    const rows = new Map<string, Row>();
    rows.set(tail[0]!.messageUuid, { decryptState: "decrypting", text: "wait" });
    rows.set(tail[1]!.messageUuid, { decryptState: "ok", text: "a" });
    const diagnosis = diagnoseChatWarmOpen({
      messages: page,
      readDecrypt: (message) => rows.get(message.messageUuid),
      hasMeasure: () => false,
    });
    expect(diagnosis.blocker).toBe("decrypt");
    expect(diagnosis.pageItems).toBe(20);
    expect(diagnosis.tail).toBe(CHAT_WARM_REVEAL_TAIL);
    expect(diagnosis.decryptPending).toBe(1);
    expect(diagnosis.decryptTerminal).toBe(1);
    expect(diagnosis.decryptMissing).toBe(CHAT_WARM_REVEAL_TAIL - 2);
    expect(diagnosis.textRows).toBe(1);
    expect(diagnosis.measureMisses).toBe(1);

    for (const message of tail) {
      rows.set(message.messageUuid, { decryptState: "ok", text: message.messageUuid });
    }
    const warm = diagnoseChatWarmOpen({
      messages: page,
      readDecrypt: (message) => rows.get(message.messageUuid),
      hasMeasure: () => true,
    });
    expect(warm.warm).toBe(true);
    expect(warm.blocker).toBeNull();
    expect(warm.decryptTerminal).toBe(CHAT_WARM_REVEAL_TAIL);
    expect(warm.measureHits).toBe(CHAT_WARM_REVEAL_TAIL);
  });
});

describe("isChatWarmBenchPageReady", () => {
  it("starts a bench once the tail is decrypted, without text measures", () => {
    expect(
      isChatWarmBenchPageReady({ messages: null, readDecrypt: () => undefined }),
    ).toBe(false);
    expect(isChatWarmBenchPageReady({ messages: [], readDecrypt: () => undefined })).toBe(true);

    const page = messages(4);
    const rows = new Map<string, Row>(
      page.map((message) => [message.messageUuid, { decryptState: "ok", text: "body" }]),
    );
    expect(
      isChatWarmBenchPageReady({
        messages: page,
        readDecrypt: (message) => rows.get(message.messageUuid),
      }),
    ).toBe(true);

    rows.set(page[3]!.messageUuid, { decryptState: "decrypting", text: "wait" });
    expect(
      isChatWarmBenchPageReady({
        messages: page,
        readDecrypt: (message) => rows.get(message.messageUuid),
      }),
    ).toBe(false);
  });
});
