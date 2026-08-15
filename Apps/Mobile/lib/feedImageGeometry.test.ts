import { describe, expect, it } from "vitest";
import {
  collageCellWidth,
  FEED_PAGE_WIDTH_EPS_PX,
  feedRowContentWidth,
  firstImageDisplayWidth,
  nextFeedPageWidth,
  threeImageLeftCellWidth,
} from "@/lib/feedImageGeometry";
import { floraFeedPost, floraSpacing } from "@/lib/theme";

describe("feedRowContentWidth", () => {
  it("subtracts the grid margins, the extra right content inset, the avatar, the column gap and the content nudge", () => {
    const windowWidth = 390;
    expect(feedRowContentWidth(windowWidth)).toBe(
      windowWidth -
        floraFeedPost.paddingHorizontal * 2 -
        floraFeedPost.contentInsetRight -
        floraFeedPost.avatarSize -
        floraFeedPost.columnGap -
        floraFeedPost.contentNudgeX,
    );
  });

  it("is 1×fine wider than the un-nudged box, matching PostCard contentNudgeX", () => {
    expect(floraFeedPost.contentNudgeX).toBe(-floraSpacing.gridFine);
  });

  it("never goes below 1, even for a window narrower than the fixed chrome", () => {
    expect(feedRowContentWidth(0)).toBe(1);
  });

  it("puts the content right edge 1×grid + 2×fine from the screen", () => {
    expect(
      floraFeedPost.paddingHorizontal + floraFeedPost.contentInsetRight,
    ).toBe(floraSpacing.grid + floraSpacing.gridFine * 2);
  });
});

describe("nextFeedPageWidth", () => {
  it("keeps the previous width while the keyboard is visible", () => {
    expect(nextFeedPageWidth(390, 380, true)).toBe(390);
  });

  it("does not lock an IME measurement when there is no previous width", () => {
    expect(nextFeedPageWidth(0, 380, true)).toBe(0);
  });

  it("takes the first positive measurement only when the keyboard is hidden", () => {
    expect(nextFeedPageWidth(0, 390, false)).toBe(390);
  });

  it("ignores jitter smaller than the epsilon", () => {
    expect(FEED_PAGE_WIDTH_EPS_PX).toBe(2);
    expect(nextFeedPageWidth(390, 391, false)).toBe(390);
  });

  it("accepts a rotation-scale change when the keyboard is hidden", () => {
    expect(nextFeedPageWidth(390, 844, false)).toBe(844);
  });

  it("keeps the previous width when the measurement is not positive", () => {
    expect(nextFeedPageWidth(390, 0, false)).toBe(390);
  });
});

describe("collageCellWidth", () => {
  it("splits the row evenly across columns, minus the gaps between them", () => {
    // 300 wide, 2 columns: one gap of 5 removed, then split in half.
    expect(collageCellWidth(300, 2)).toBe(Math.floor((300 - floraSpacing.gridFine) / 2));
  });
});

describe("threeImageLeftCellWidth", () => {
  it("is two thirds of the row, minus the gap to the right column", () => {
    expect(threeImageLeftCellWidth(300)).toBe(
      Math.floor(((300 - floraSpacing.gridFine) * 2) / 3),
    );
  });
});

describe("firstImageDisplayWidth", () => {
  const contentWidth = 300;

  it("uses the full content width for a single photo", () => {
    expect(firstImageDisplayWidth(contentWidth, 1)).toBe(contentWidth);
  });

  it("uses the two-column cell width for a two-image row, like FeedPostImages", () => {
    expect(firstImageDisplayWidth(contentWidth, 2)).toBe(collageCellWidth(contentWidth, 2));
  });

  it("uses the wide left cell for a three-image row, like FeedPostImages", () => {
    expect(firstImageDisplayWidth(contentWidth, 3)).toBe(threeImageLeftCellWidth(contentWidth));
  });

  it("uses the two-column cell width for a four-image row, like FeedPostImages", () => {
    expect(firstImageDisplayWidth(contentWidth, 4)).toBe(collageCellWidth(contentWidth, 2));
  });

  it("uses the two-column cell width for a six-image row, like FeedPostImages", () => {
    expect(firstImageDisplayWidth(contentWidth, 6)).toBe(collageCellWidth(contentWidth, 2));
  });

  it("agrees with FeedPostImages' own arithmetic at a concrete width", () => {
    // width = 295 (a typical feed row content width); values below are
    // FeedPostImages' inline formulas evaluated by hand, not re-derived from
    // the functions under test.
    const width = 295;
    expect(firstImageDisplayWidth(width, 2)).toBe(145); // Math.floor((295 - 5) / 2)
    expect(firstImageDisplayWidth(width, 3)).toBe(193); // Math.floor(((295 - 5) * 2) / 3)
    expect(firstImageDisplayWidth(width, 4)).toBe(145);
    expect(firstImageDisplayWidth(width, 6)).toBe(145);
  });
});
