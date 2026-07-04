import { describe, expect, it } from "vitest";
import {
  MESSAGE_RECEIPT_INLINE_RESERVE_PX,
  TIME_INLINE_GAP_PX,
  resolveBubbleTimePlacementFromLineWidths,
} from "./messageBubbleTimePlacement.js";

describe("resolveBubbleTimePlacementFromLineWidths", () => {
  const maxWidth = 280;

  it("returns inline for empty line widths", () => {
    expect(resolveBubbleTimePlacementFromLineWidths([], 40, maxWidth)).toBe("inline");
  });

  it("returns inline for short single line without receipt", () => {
    const meta = 50 + TIME_INLINE_GAP_PX;
    expect(resolveBubbleTimePlacementFromLineWidths([40], meta, maxWidth)).toBe("inline");
  });

  it("returns inline for short single line with receipt reserve", () => {
    const meta = 50 + TIME_INLINE_GAP_PX + MESSAGE_RECEIPT_INLINE_RESERVE_PX;
    expect(resolveBubbleTimePlacementFromLineWidths([40], meta, maxWidth)).toBe("inline");
  });

  it("returns below when last line plus meta exceeds max width", () => {
    const meta = 60 + TIME_INLINE_GAP_PX;
    expect(resolveBubbleTimePlacementFromLineWidths([240], meta, maxWidth)).toBe("below");
  });

  it("returns inline for multiline text with short last line", () => {
    const meta = 55 + TIME_INLINE_GAP_PX + MESSAGE_RECEIPT_INLINE_RESERVE_PX;
    expect(resolveBubbleTimePlacementFromLineWidths([260, 30], meta, maxWidth)).toBe("inline");
  });

  it("returns below when bubble width with inline meta exceeds max width", () => {
    const meta = 40 + TIME_INLINE_GAP_PX;
    expect(resolveBubbleTimePlacementFromLineWidths([290, 20], meta, maxWidth)).toBe("below");
  });

  it("treats zero meta width as inline when last line fits", () => {
    expect(resolveBubbleTimePlacementFromLineWidths([100], 0, maxWidth)).toBe("inline");
  });

  it("uses unlimited width when maxBubbleInnerWidthPx is zero", () => {
    const meta = 500 + TIME_INLINE_GAP_PX;
    expect(resolveBubbleTimePlacementFromLineWidths([400], meta, 0)).toBe("inline");
  });
});
