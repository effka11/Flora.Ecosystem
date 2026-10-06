import { describe, expect, it } from "vitest";
import { shouldRefetchThreadAfterReveal } from "@/lib/threadRevealRefresh";

describe("shouldRefetchThreadAfterReveal", () => {
  it("refetches only an invalidated page or a newer list preview", () => {
    expect(
      shouldRefetchThreadAfterReveal({
        isInvalidated: false,
        lastMessageAt: "2026-02-02T00:00:00.000Z",
        newestCreatedAt: "2026-02-02T00:00:00.000Z",
      }),
    ).toBe(false);
    expect(
      shouldRefetchThreadAfterReveal({
        isInvalidated: true,
        lastMessageAt: "2026-02-02T00:00:00.000Z",
        newestCreatedAt: "2026-02-02T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      shouldRefetchThreadAfterReveal({
        isInvalidated: false,
        lastMessageAt: "2026-02-03T00:00:00.000Z",
        newestCreatedAt: "2026-02-02T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      shouldRefetchThreadAfterReveal({
        isInvalidated: false,
        lastMessageAt: null,
        newestCreatedAt: null,
      }),
    ).toBe(false);
  });
});
