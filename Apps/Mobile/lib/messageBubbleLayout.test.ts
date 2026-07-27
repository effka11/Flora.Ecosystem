import { describe, expect, it } from "vitest";

import { bubbleMetaWidth, resolveBubbleMetaLayout } from "./messageBubbleLayout";

describe("resolveBubbleMetaLayout", () => {
  const maxInnerWidthPx = 280;

  it("keeps time inline when the last line plus meta fits", () => {
    const layout = resolveBubbleMetaLayout({
      lineWidths: [40],
      timeLabelWidthPx: 30,
      hasReceipt: false,
      maxInnerWidthPx,
    });

    expect(layout.placement).toBe("inline");
    expect(layout.inlineBlockWidthPx).toBe(87);
  });

  it("drops time below when the last line plus meta overflows the bubble", () => {
    const layout = resolveBubbleMetaLayout({
      lineWidths: [250],
      timeLabelWidthPx: 30,
      hasReceipt: false,
      maxInnerWidthPx,
    });

    expect(layout.placement).toBe("below");
  });

  it("drops time below when it fits only exactly (rounding guard)", () => {
    const exactFit = maxInnerWidthPx - bubbleMetaWidth(30, false);

    expect(
      resolveBubbleMetaLayout({
        lineWidths: [exactFit],
        timeLabelWidthPx: 30,
        hasReceipt: false,
        maxInnerWidthPx,
      }).placement,
    ).toBe("below");
    expect(
      resolveBubbleMetaLayout({
        lineWidths: [exactFit - 2],
        timeLabelWidthPx: 30,
        hasReceipt: false,
        maxInnerWidthPx,
      }).placement,
    ).toBe("inline");
  });

  it("re-evaluates placement when read receipts appear (sent → read)", () => {
    const line = 225;

    expect(
      resolveBubbleMetaLayout({
        lineWidths: [line],
        timeLabelWidthPx: 30,
        hasReceipt: false,
        maxInnerWidthPx,
      }).placement,
    ).toBe("inline");
    expect(
      resolveBubbleMetaLayout({
        lineWidths: [line],
        timeLabelWidthPx: 30,
        hasReceipt: true,
        maxInnerWidthPx,
      }).placement,
    ).toBe("below");
  });

  it("sizes the last row by the widest line for multiline text", () => {
    const layout = resolveBubbleMetaLayout({
      lineWidths: [270, 40],
      timeLabelWidthPx: 30,
      hasReceipt: false,
      maxInnerWidthPx,
    });

    expect(layout.placement).toBe("inline");
    expect(layout.inlineBlockWidthPx).toBe(270);
  });

  it("keeps the rounding slack when the last line drives the width", () => {
    const layout = resolveBubbleMetaLayout({
      lineWidths: [190, 149.4],
      timeLabelWidthPx: 30.2,
      hasReceipt: false,
      maxInnerWidthPx,
    });

    expect(layout.inlineBlockWidthPx).toBe(197);
  });

  it("never sizes the last row wider than the bubble", () => {
    const layout = resolveBubbleMetaLayout({
      lineWidths: [277.4],
      timeLabelWidthPx: 0.3,
      hasReceipt: false,
      maxInnerWidthPx,
    });

    expect(layout.inlineBlockWidthPx).toBe(maxInnerWidthPx);
  });

  it("treats a zero bubble width as unmeasured and keeps time inline", () => {
    const layout = resolveBubbleMetaLayout({
      lineWidths: [400],
      timeLabelWidthPx: 30,
      hasReceipt: true,
      maxInnerWidthPx: 0,
    });

    expect(layout.placement).toBe("inline");
  });
});
