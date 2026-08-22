import { describe, expect, it } from "vitest";
import { ENERGETIC_SNAP_VX, snapPagerOffset } from "./energeticPagerSnap";

describe("snapPagerOffset", () => {
  const width = 300;

  it("flicks to the next page on a strong leftward finger swipe", () => {
    expect(snapPagerOffset(0.02 * width, width, 2, -(ENERGETIC_SNAP_VX + 1))).toBe(width);
  });

  it("flicks to the previous page on a strong rightward finger swipe", () => {
    expect(snapPagerOffset(0.98 * width, width, 2, ENERGETIC_SNAP_VX + 1)).toBe(0);
  });

  it("rounds to the nearest page without a flick", () => {
    expect(snapPagerOffset(0.4 * width, width, 2, 0)).toBe(0);
    expect(snapPagerOffset(0.6 * width, width, 2, 0)).toBe(width);
  });

  it("clamps to the last page", () => {
    expect(snapPagerOffset(width * 1.5, width, 2, -500)).toBe(width);
  });
});
