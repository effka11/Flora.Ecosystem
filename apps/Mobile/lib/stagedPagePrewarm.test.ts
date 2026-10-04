import { describe, expect, it } from "vitest";
import { selectStagedPagePrewarmTargets } from "./stagedPagePrewarm";

function imageUrl(imageUuid: string): string {
  return `https://cdn.test/${imageUuid}`;
}

function post(imageUuids: string[]) {
  return { imageUuids };
}

describe("selectStagedPagePrewarmTargets", () => {
  it("warms the first image of the first rowsAhead posts", () => {
    const posts = Array.from({ length: 20 }, (_, i) => post([`image-${i}`]));
    const targets = selectStagedPagePrewarmTargets({
      posts,
      rowsAhead: 4,
      urlForImage: imageUrl,
    });
    expect(targets.map((t) => t.url)).toEqual([
      imageUrl("image-0"),
      imageUrl("image-1"),
      imageUrl("image-2"),
      imageUrl("image-3"),
    ]);
  });

  it("takes only the first image of a collage, not the rest", () => {
    const posts = [post(["a", "b", "c"]), post(["d"])];
    const targets = selectStagedPagePrewarmTargets({
      posts,
      rowsAhead: 2,
      urlForImage: imageUrl,
    });
    expect(targets.map((t) => t.url)).toEqual([imageUrl("a"), imageUrl("d")]);
    expect(targets[0]?.imageCount).toBe(3);
    expect(targets[1]?.imageCount).toBe(1);
  });

  it("dedupes a shared image (a repost) within the window", () => {
    const posts = [post(["shared"]), post(["shared"]), post(["other"])];
    const targets = selectStagedPagePrewarmTargets({
      posts,
      rowsAhead: 3,
      urlForImage: imageUrl,
    });
    expect(targets.map((t) => t.url)).toEqual([imageUrl("shared"), imageUrl("other")]);
  });

  it("returns nothing for an empty page", () => {
    expect(
      selectStagedPagePrewarmTargets({ posts: [], rowsAhead: 5, urlForImage: imageUrl }),
    ).toEqual([]);
  });

  it("returns nothing when rowsAhead is zero (gate closed / offline)", () => {
    const posts = [post(["a"]), post(["b"])];
    expect(
      selectStagedPagePrewarmTargets({ posts, rowsAhead: 0, urlForImage: imageUrl }),
    ).toEqual([]);
  });

  it("clamps depth to the page length instead of reading past it", () => {
    const posts = [post(["a"]), post(["b"])];
    const targets = selectStagedPagePrewarmTargets({
      posts,
      rowsAhead: 20,
      urlForImage: imageUrl,
    });
    expect(targets.map((t) => t.url)).toEqual([imageUrl("a"), imageUrl("b")]);
  });

  it("a post with no image still occupies its slot in the window", () => {
    const posts = [post(["a"]), post([]), post(["c"]), post(["d"])];
    // rowsAhead 3 covers indices 0..2: "a", the imageless post (no target),
    // and "c" — index 3 ("d") is outside the window and must not backfill.
    const targets = selectStagedPagePrewarmTargets({
      posts,
      rowsAhead: 3,
      urlForImage: imageUrl,
    });
    expect(targets.map((t) => t.url)).toEqual([imageUrl("a"), imageUrl("c")]);
  });

  it("floors a fractional rowsAhead", () => {
    const posts = [post(["a"]), post(["b"]), post(["c"])];
    const targets = selectStagedPagePrewarmTargets({
      posts,
      rowsAhead: 1.9,
      urlForImage: imageUrl,
    });
    expect(targets.map((t) => t.url)).toEqual([imageUrl("a")]);
  });
});
