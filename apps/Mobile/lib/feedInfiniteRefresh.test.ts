import { describe, expect, it } from "vitest";
import { trimFeedInfiniteDataToFirstPage } from "./feedInfiniteRefresh";

describe("trimFeedInfiniteDataToFirstPage", () => {
  it("returns undefined when data is undefined", () => {
    expect(trimFeedInfiniteDataToFirstPage(undefined)).toBeUndefined();
  });

  it("keeps exactly one page and one pageParam", () => {
    const trimmed = trimFeedInfiniteDataToFirstPage({
      pages: [{ items: [1] }, { items: [2] }, { items: [3] }],
      pageParams: [undefined, "c1", "c2"],
    });
    expect(trimmed).toEqual({
      pages: [{ items: [1] }],
      pageParams: [undefined],
    });
  });

  it("preserves other fields on the data object", () => {
    const input = {
      pages: [{ items: [] as number[] }],
      pageParams: [undefined] as unknown[],
      generatedAt: "t0",
    };
    const trimmed = trimFeedInfiniteDataToFirstPage(input);
    expect(trimmed).toEqual({
      pages: [{ items: [] }],
      pageParams: [undefined],
      generatedAt: "t0",
    });
  });
});
