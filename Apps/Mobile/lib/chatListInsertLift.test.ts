import { describe, expect, it } from "vitest";
import type { FscpMessageBlock } from "@flora/client-core/fscp";

import {
  BELOW_TIME_RESERVE_PX,
  TEXT_BASE_INSERT_LIFT_PX,
  estimateBlocksInsertLiftPx,
  estimateRowInsertLiftPx,
  estimateTextInsertLiftPx,
  estimateTextVisualLineCount,
} from "./chatListInsertLiftEstimate";
import { floraMessages } from "./theme";

describe("estimateTextVisualLineCount", () => {
  it("counts hard-breaks without width", () => {
    expect(estimateTextVisualLineCount("a\nb\nc")).toBe(3);
  });

  it("soft-wraps a long line when maxInnerWidth is narrow", () => {
    const long = "x".repeat(40);
    expect(estimateTextVisualLineCount(long, 40)).toBeGreaterThan(1);
  });

  it("keeps hard-break floor even with width", () => {
    expect(estimateTextVisualLineCount("a\nb\nc", 10_000)).toBe(3);
  });
});

describe("estimateTextInsertLiftPx", () => {
  it("returns base for short single-line text", () => {
    expect(estimateTextInsertLiftPx("hi")).toBe(TEXT_BASE_INSERT_LIFT_PX);
  });

  it("returns base for empty body", () => {
    expect(estimateTextInsertLiftPx("")).toBe(TEXT_BASE_INSERT_LIFT_PX);
    expect(estimateTextInsertLiftPx(undefined)).toBe(TEXT_BASE_INSERT_LIFT_PX);
  });

  it("adds line steps and below-reserve for 3 hard-lines", () => {
    const expected =
      TEXT_BASE_INSERT_LIFT_PX +
      2 * floraMessages.bubbleLineHeight +
      BELOW_TIME_RESERVE_PX;
    expect(estimateTextInsertLiftPx("a\nb\nc")).toBe(expected);
  });

  it("soft-wrap long line lifts above base", () => {
    const long = "word ".repeat(40).trim();
    expect(
      estimateTextInsertLiftPx(long, { maxInnerWidthPx: 120 }),
    ).toBeGreaterThan(TEXT_BASE_INSERT_LIFT_PX);
  });

  it("without width still floors on hard-breaks", () => {
    const expected =
      TEXT_BASE_INSERT_LIFT_PX +
      2 * floraMessages.bubbleLineHeight +
      BELOW_TIME_RESERVE_PX;
    expect(estimateTextInsertLiftPx("a\nb\nc")).toBe(expected);
  });
});

describe("estimateBlocksInsertLiftPx", () => {
  it("keeps voice / image constants", () => {
    expect(
      estimateBlocksInsertLiftPx([
        { kind: "voice" } as FscpMessageBlock,
      ]),
    ).toBe(72);
    expect(
      estimateBlocksInsertLiftPx([{ kind: "image" } as FscpMessageBlock]),
    ).toBe(220);
    expect(
      estimateBlocksInsertLiftPx([
        { kind: "image" } as FscpMessageBlock,
        { kind: "image" } as FscpMessageBlock,
      ]),
    ).toBe(280);
  });

  it("estimates text body with ctx", () => {
    expect(
      estimateBlocksInsertLiftPx([{ kind: "text", body: "hi" }], { maxInnerWidthPx: 280 }),
    ).toBe(TEXT_BASE_INSERT_LIFT_PX);
  });
});

describe("estimateRowInsertLiftPx", () => {
  it("keeps media constants and estimates text", () => {
    expect(estimateRowInsertLiftPx({ voiceBlock: {} })).toBe(72);
    expect(estimateRowInsertLiftPx({ imageBlocks: [{}] })).toBe(220);
    expect(estimateRowInsertLiftPx({ imageBlocks: [{}, {}] })).toBe(280);
    expect(estimateRowInsertLiftPx({ text: "hi" })).toBe(TEXT_BASE_INSERT_LIFT_PX);
    expect(estimateRowInsertLiftPx({ text: "a\nb\nc" })).toBe(
      TEXT_BASE_INSERT_LIFT_PX +
        2 * floraMessages.bubbleLineHeight +
        BELOW_TIME_RESERVE_PX,
    );
  });
});
