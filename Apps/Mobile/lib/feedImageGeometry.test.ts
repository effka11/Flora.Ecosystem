import { describe, expect, it } from "vitest";
import {
  collageCellWidth,
  feedRowContentWidth,
  firstImageDisplayWidth,
  threeImageLeftCellWidth,
} from "@/lib/feedImageGeometry";
import { floraFeedPost, floraSpacing } from "@/lib/theme";

describe("feedRowContentWidth", () => {
  it("subtracts the grid margins, the extra right content inset, the avatar and the column gap", () => {
    const windowWidth = 390;
    expect(feedRowContentWidth(windowWidth)).toBe(
      windowWidth -
        floraFeedPost.paddingHorizontal * 2 -
        floraFeedPost.contentInsetRight -
        floraFeedPost.avatarSize -
        floraFeedPost.columnGap,
    );
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
