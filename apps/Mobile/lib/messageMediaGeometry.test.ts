import { describe, expect, it } from "vitest";
import {
  COLLAGE_MAX_ITEMS,
  messageCollageHeight,
  messageSingleImageSize,
} from "@/lib/messageMediaGeometry";

describe("messageCollageHeight", () => {
  const rowHeight = 75; // 5 * floraSpacing.grid, gap = floraSpacing.gridFine = 5

  it("is 0 for zero or one photo (not a collage)", () => {
    expect(messageCollageHeight(0, rowHeight)).toBe(0);
    expect(messageCollageHeight(1, rowHeight)).toBe(0);
  });

  it("is two stacked rows for 2 and 3 photos", () => {
    expect(messageCollageHeight(2, rowHeight)).toBe(150);
    expect(messageCollageHeight(3, rowHeight)).toBe(150);
  });

  it("adds one gap for the wrapped two-row layout at 4 photos", () => {
    expect(messageCollageHeight(4, rowHeight)).toBe(155);
  });

  it("grows by full rest-rows for 5+ photos", () => {
    expect(messageCollageHeight(5, rowHeight)).toBe(310);
    expect(messageCollageHeight(6, rowHeight)).toBe(310);
    expect(messageCollageHeight(7, rowHeight)).toBe(390);
    expect(messageCollageHeight(10, rowHeight)).toBe(470);
  });

  it("clamps counts above COLLAGE_MAX_ITEMS to the same height as the max", () => {
    expect(messageCollageHeight(COLLAGE_MAX_ITEMS + 5, rowHeight)).toBe(
      messageCollageHeight(COLLAGE_MAX_ITEMS, rowHeight),
    );
  });
});

describe("messageSingleImageSize", () => {
  it("fits the container width when the height stays under the cap", () => {
    // ratio 4/3, width 300 -> height 225, under maxHeight 400.
    expect(messageSingleImageSize(300, 4 / 3, 400)).toEqual({ width: 300, height: 225 });
  });

  it("caps the height and recomputes width for a tall image", () => {
    // ratio 4/3, width 300 -> height 225 initially, but capped to 100 -> width 133.33.
    expect(messageSingleImageSize(300, 4 / 3, 100)).toEqual({
      width: 100 * (4 / 3),
      height: 100,
    });
  });

  it("applies the provided rounding function", () => {
    const result = messageSingleImageSize(300, 4 / 3, 100, Math.round);
    expect(result).toEqual({ width: 133, height: 100 });
  });

  it("defaults to the identity function when no rounding is provided", () => {
    const result = messageSingleImageSize(301, 1.37, 400);
    expect(result.width).toBe(301);
    expect(result.height).toBeCloseTo(301 / 1.37);
  });
});
