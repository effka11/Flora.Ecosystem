import { describe, expect, it } from "vitest";
import { mergeEngagementCount } from "@/lib/mergeEngagementCount";

describe("mergeEngagementCount", () => {
  it("uses the post count when there is no override", () => {
    expect(mergeEngagementCount(12847, true, undefined, undefined)).toBe(12847);
  });

  it("does not keep a stale mutation snapshot once the feed caught up", () => {
    expect(mergeEngagementCount(12847, true, true, 1)).toBe(12847);
    expect(mergeEngagementCount(1842, true, true, 1)).toBe(1842);
  });

  it("keeps the mutation count while the feed flag has not caught up", () => {
    expect(mergeEngagementCount(12847, false, true, 12848)).toBe(12848);
    expect(mergeEngagementCount(1, true, false, 0)).toBe(0);
  });

  it("applies ±1 when only the flag flipped", () => {
    expect(mergeEngagementCount(10, false, true, undefined)).toBe(11);
    expect(mergeEngagementCount(10, true, false, undefined)).toBe(9);
  });
});
