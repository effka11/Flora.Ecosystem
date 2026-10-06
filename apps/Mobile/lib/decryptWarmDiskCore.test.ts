import { describe, expect, it } from "vitest";
import {
  capWarmThreads,
  parseDecryptWarmEnvelope,
  persistWarmRow,
  type PersistedWarmThread,
} from "@/lib/decryptWarmDiskCore";

function row(createdAt: string, messageUuid = "m") {
  return {
    messageUuid,
    text: "hello",
    previewText: "hello",
    imageBlocks: [],
    isFromMe: false,
    createdAt,
    decryptState: "ok" as const,
  };
}

describe("decrypt warm envelope", () => {
  it("keeps a terminal row and drops one that is still decrypting", () => {
    expect(persistWarmRow("m|wire", row("2026-01-01T00:00:00.000Z"))?.cacheKey).toBe("m|wire");
    expect(
      persistWarmRow("m|wire", { ...row("2026-01-01T00:00:00.000Z"), decryptState: "decrypting" }),
    ).toBeNull();
    expect(persistWarmRow("  ", row("2026-01-01T00:00:00.000Z"))).toBeNull();
  });

  it("rejects a foreign owner, a bad schema, and corrupt json", () => {
    const body = JSON.stringify({
      v: 1,
      owner: "user-a",
      threads: [
        {
          conversationUuid: "conv",
          entries: [persistWarmRow("m|wire", row("2026-01-02T00:00:00.000Z"))],
        },
      ],
    });
    expect(parseDecryptWarmEnvelope(body, "user-a")).toHaveLength(1);
    expect(parseDecryptWarmEnvelope(body, "user-b")).toBeNull();
    expect(parseDecryptWarmEnvelope(body.replace('"v":1', '"v":2'), "user-a")).toBeNull();
    expect(parseDecryptWarmEnvelope("{", "user-a")).toBeNull();
    expect(parseDecryptWarmEnvelope(null, "user-a")).toBeNull();
  });

  it("keeps the newest rows when the page is over the cap", () => {
    const entries = [0, 1, 2].map((index) =>
      persistWarmRow(`m-${index}|wire`, row(`2026-01-0${index + 1}T00:00:00.000Z`, `m-${index}`)),
    );
    const threads: PersistedWarmThread[] = [
      { conversationUuid: "conv", entries: entries.filter((entry) => entry != null) },
    ];
    const capped = capWarmThreads(threads, 1, 2);
    expect(capped[0]?.entries.map((entry) => entry.messageUuid)).toEqual(["m-1", "m-2"]);
  });
});
