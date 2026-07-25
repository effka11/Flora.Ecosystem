import { describe, expect, it } from "vitest";
import {
  backgroundPrefetchUrls,
  computeRowMediaModes,
  FrcPrefetchBand,
  nextScrollDirection,
  priorityForMode,
  shouldDecodeImage,
  type FrcBandRow,
  type FrcRowMediaMode,
} from "@/lib/frcMediaMode";

function indicesWithMode(
  modes: Map<number, FrcRowMediaMode>,
  mode: FrcRowMediaMode,
): number[] {
  return [...modes]
    .filter(([, value]) => value === mode)
    .map(([index]) => index)
    .sort((a, b) => a - b);
}

function singleImageRows(count: number): FrcBandRow[] {
  return Array.from({ length: count }, (_, index) => ({
    postUuid: `post-${index}`,
    imageUuids: [`image-${index}`],
  }));
}

function imageUrl(imageUuid: string): string {
  return `https://cdn.test/${imageUuid}`;
}

describe("nextScrollDirection", () => {
  it("follows a band that moved down", () => {
    expect(nextScrollDirection({ min: 5, max: 7 }, { min: 6, max: 8 }, "up")).toBe("down");
  });

  it("follows a band that moved up", () => {
    expect(nextScrollDirection({ min: 5, max: 7 }, { min: 3, max: 5 }, "down")).toBe("up");
  });

  it("keeps the previous direction when the band did not move", () => {
    expect(nextScrollDirection({ min: 5, max: 7 }, { min: 5, max: 7 }, "up")).toBe("up");
    expect(nextScrollDirection({ min: 5, max: 7 }, { min: 5, max: 7 }, "down")).toBe("down");
  });

  it("keeps the previous direction when the band only grew or shrank", () => {
    // Both edges moving apart (a taller viewport, a row that finished layout)
    // says nothing about where the user is going.
    expect(nextScrollDirection({ min: 5, max: 7 }, { min: 4, max: 8 }, "down")).toBe("down");
    expect(nextScrollDirection({ min: 4, max: 8 }, { min: 5, max: 7 }, "up")).toBe("up");
  });

  it("keeps the previous direction while an edge is still unknown", () => {
    expect(nextScrollDirection({ min: null, max: null }, { min: 4, max: 6 }, "down")).toBe(
      "down",
    );
    expect(nextScrollDirection({ min: 4, max: 6 }, { min: null, max: null }, "up")).toBe("up");
  });
});

describe("computeRowMediaModes", () => {
  it("returns empty for empty lists", () => {
    expect(
      computeRowMediaModes({ count: 0, minVisible: 0, maxVisible: 0, rowsAhead: 3 }).size,
    ).toBe(0);
  });

  it("marks visible band, adjacent near rows and the download band", () => {
    const modes = computeRowMediaModes({
      count: 20,
      minVisible: 5,
      maxVisible: 7,
      rowsAhead: 3,
      direction: "down",
    });
    expect(modes.get(5)).toBe("visible");
    expect(modes.get(6)).toBe("visible");
    expect(modes.get(7)).toBe("visible");
    expect(modes.get(4)).toBe("near");
    expect(modes.get(8)).toBe("near");
    expect(modes.get(9)).toBe("background");
    expect(modes.get(10)).toBe("background");
    expect(modes.get(11)).toBe("background");
    expect(modes.has(12)).toBe(false);
    // One row behind the gesture, and nothing past it.
    expect(modes.get(3)).toBe("background");
    expect(modes.has(2)).toBe(false);
  });

  it("takes the band depth from rowsAhead", () => {
    const narrow = computeRowMediaModes({
      count: 40,
      minVisible: 10,
      maxVisible: 10,
      rowsAhead: 2,
      direction: "down",
    });
    const wide = computeRowMediaModes({
      count: 40,
      minVisible: 10,
      maxVisible: 10,
      rowsAhead: 7,
      direction: "down",
    });
    expect(indicesWithMode(narrow, "background")).toEqual([8, 12, 13]);
    expect(indicesWithMode(wide, "background")).toEqual([8, 12, 13, 14, 15, 16, 17, 18]);
  });

  it("offsets the deep band downwards while scrolling down", () => {
    const modes = computeRowMediaModes({
      count: 40,
      minVisible: 10,
      maxVisible: 12,
      rowsAhead: 4,
      direction: "down",
    });
    expect(indicesWithMode(modes, "background")).toEqual([8, 14, 15, 16, 17]);
  });

  it("offsets the deep band upwards while scrolling up", () => {
    const modes = computeRowMediaModes({
      count: 40,
      minVisible: 10,
      maxVisible: 12,
      rowsAhead: 4,
      direction: "up",
    });
    expect(indicesWithMode(modes, "background")).toEqual([5, 6, 7, 8, 14]);
  });

  it("keeps exactly one row warm against the gesture in either direction", () => {
    const down = computeRowMediaModes({
      count: 40,
      minVisible: 20,
      maxVisible: 20,
      rowsAhead: 6,
      direction: "down",
    });
    const up = computeRowMediaModes({
      count: 40,
      minVisible: 20,
      maxVisible: 20,
      rowsAhead: 6,
      direction: "up",
    });
    expect(indicesWithMode(down, "background").filter((index) => index < 20)).toEqual([18]);
    expect(indicesWithMode(up, "background").filter((index) => index > 20)).toEqual([22]);
  });

  it("prewarms nothing when rowsAhead is zero (offline)", () => {
    const modes = computeRowMediaModes({
      count: 20,
      minVisible: 5,
      maxVisible: 7,
      rowsAhead: 0,
      direction: "down",
    });
    expect(modes.get(4)).toBe("near");
    expect(modes.get(8)).toBe("near");
    expect(indicesWithMode(modes, "background")).toEqual([]);
  });

  it("clamps to list bounds", () => {
    const modes = computeRowMediaModes({ count: 3, minVisible: 0, maxVisible: 2, rowsAhead: 3 });
    expect(modes.get(0)).toBe("visible");
    expect(modes.get(2)).toBe("visible");
    expect(modes.has(3)).toBe(false);
    expect(modes.has(-1)).toBe(false);
  });

  it("defaults to top-of-list when viewability is unknown", () => {
    const modes = computeRowMediaModes({
      count: 20,
      minVisible: null,
      maxVisible: null,
      rowsAhead: 3,
    });
    expect(modes.get(0)).toBe("visible");
    expect(modes.get(1)).toBe("near");
    expect(modes.get(2)).toBe("background");
  });
});

describe("backgroundPrefetchUrls", () => {
  const modes = computeRowMediaModes({
    count: 20,
    minVisible: 5,
    maxVisible: 7,
    rowsAhead: 3,
    direction: "down",
  });

  it("takes one image per background row and nothing from the rest of the band", () => {
    const targets = backgroundPrefetchUrls({
      rows: singleImageRows(20),
      modes,
      urlForImage: imageUrl,
      enabled: true,
    });
    // The visible rows and their near neighbours are mounted and ask for
    // themselves; only the deep band has no component behind it.
    expect(targets.map((target) => target.url).sort()).toEqual(
      [3, 9, 10, 11].map((index) => imageUrl(`image-${index}`)).sort(),
    );
  });

  it("carries the image count of the row each url came from", () => {
    const rows = singleImageRows(20);
    rows[9] = { postUuid: "post-9", imageUuids: ["image-9", "image-9b", "image-9c"] };
    const targets = backgroundPrefetchUrls({ rows, modes, urlForImage: imageUrl, enabled: true });
    expect(targets.find((target) => target.url === imageUrl("image-9"))?.imageCount).toBe(3);
    expect(targets.find((target) => target.url === imageUrl("image-3"))?.imageCount).toBe(1);
  });

  it("warms only the first image of a collage, like shouldDecodeImage", () => {
    const rows = singleImageRows(20);
    rows[9] = { postUuid: "post-9", imageUuids: ["image-9", "image-9b", "image-9c"] };
    const urls = backgroundPrefetchUrls({ rows, modes, urlForImage: imageUrl, enabled: true }).map(
      (target) => target.url,
    );
    expect(urls).toContain(imageUrl("image-9"));
    expect(urls).not.toContain(imageUrl("image-9b"));
    expect(urls).not.toContain(imageUrl("image-9c"));
  });

  it("skips rows that carry no image", () => {
    const rows = singleImageRows(20);
    rows[10] = { postUuid: "post-10", imageUuids: [] };
    const urls = backgroundPrefetchUrls({ rows, modes, urlForImage: imageUrl, enabled: true }).map(
      (target) => target.url,
    );
    expect(urls).not.toContain(imageUrl("image-10"));
    expect(urls).toHaveLength(3);
  });

  it("asks for a shared image once (a repost of a post in the same band)", () => {
    const rows = singleImageRows(20);
    rows[10] = { postUuid: "post-10", imageUuids: ["image-9"] };
    const urls = backgroundPrefetchUrls({ rows, modes, urlForImage: imageUrl, enabled: true }).map(
      (target) => target.url,
    );
    expect(urls.filter((url) => url === imageUrl("image-9"))).toHaveLength(1);
  });

  it("warms nothing in a disabled pane", () => {
    expect(
      backgroundPrefetchUrls({
        rows: singleImageRows(20),
        modes,
        urlForImage: imageUrl,
        enabled: false,
      }),
    ).toEqual([]);
  });
});

describe("FrcPrefetchBand", () => {
  function recordingBand() {
    const started: string[] = [];
    const cancelled: string[] = [];
    const band = new FrcPrefetchBand((url) => {
      started.push(url);
      return () => cancelled.push(url);
    });
    return { band, started, cancelled };
  }

  it("starts a warm-up for a url that entered the band", () => {
    const { band, started } = recordingBand();
    band.sync(["a", "b"]);
    expect(started).toEqual(["a", "b"]);
    expect(band.activeUrls()).toEqual(["a", "b"]);
  });

  it("cancels the warm-up of a url that left the band", () => {
    const { band, started, cancelled } = recordingBand();
    band.sync(["a", "b"]);
    band.sync(["b", "c"]);
    expect(cancelled).toEqual(["a"]);
    expect(started).toEqual(["a", "b", "c"]);
    expect(band.activeUrls()).toEqual(["b", "c"]);
  });

  it("leaves a url that stayed in the band alone", () => {
    const { band, started, cancelled } = recordingBand();
    band.sync(["a"]);
    band.sync(["a"]);
    band.sync(["a"]);
    expect(started).toEqual(["a"]);
    expect(cancelled).toEqual([]);
  });

  it("cancels everything on stop and can be used again after it", () => {
    const { band, started, cancelled } = recordingBand();
    band.sync(["a", "b"]);
    band.stop();
    expect(cancelled).toEqual(["a", "b"]);
    expect(band.activeUrls()).toEqual([]);
    band.sync(["a"]);
    expect(started).toEqual(["a", "b", "a"]);
  });

  it("cancels everything when the pane is switched off mid-flight", () => {
    const { band, cancelled } = recordingBand();
    band.sync(["a", "b"]);
    band.sync([]);
    expect(cancelled).toEqual(["a", "b"]);
    expect(band.activeUrls()).toEqual([]);
  });
});

describe("download band over a moving list", () => {
  const rows = singleImageRows(40);

  function bandAt(visible: number, enabled = true): string[] {
    return backgroundPrefetchUrls({
      rows,
      modes: computeRowMediaModes({
        count: rows.length,
        minVisible: visible,
        maxVisible: visible,
        rowsAhead: 3,
        direction: "down",
      }),
      urlForImage: imageUrl,
      enabled,
    }).map((target) => target.url);
  }

  it("warms rows as they enter the band, drops them as they leave, and stops when the pane is off", () => {
    const started: string[] = [];
    const cancelled: string[] = [];
    const prefetch = new FrcPrefetchBand((url) => {
      started.push(url);
      return () => cancelled.push(url);
    });

    prefetch.sync(bandAt(10));
    expect(started).toContain(imageUrl("image-13"));
    // Still four rows away from the viewport: no row is mounted for it, which
    // is the whole point of warming it from here.
    expect(started).toContain(imageUrl("image-14"));

    prefetch.sync(bandAt(14));
    expect(cancelled).toContain(imageUrl("image-13"));
    expect(started).toContain(imageUrl("image-17"));
    expect(prefetch.activeUrls()).not.toContain(imageUrl("image-13"));

    const startedBefore = started.length;
    prefetch.sync(bandAt(14, false));
    expect(prefetch.activeUrls()).toEqual([]);
    expect(started).toHaveLength(startedBefore);
  });
});

describe("priorityForMode", () => {
  it("maps each decode state to a queue priority", () => {
    expect(priorityForMode("visible")).toBe("visible");
    expect(priorityForMode("near")).toBe("near");
    expect(priorityForMode("background")).toBe("background");
    expect(priorityForMode("gated-out")).toBe("background");
    expect(priorityForMode("out-of-band")).toBe("background");
    expect(priorityForMode(undefined)).toBe("background");
  });
});

describe("shouldDecodeImage", () => {
  it('"visible" decodes every image in the row', () => {
    expect(shouldDecodeImage("visible", 0)).toBe(true);
    expect(shouldDecodeImage("visible", 3)).toBe(true);
  });

  it('"near" decodes every image in the row, not just the first', () => {
    expect(shouldDecodeImage("near", 0)).toBe(true);
    expect(shouldDecodeImage("near", 1)).toBe(true);
    expect(shouldDecodeImage("near", 9)).toBe(true);
  });

  it('"background" decodes only the first image', () => {
    expect(shouldDecodeImage("background", 0)).toBe(true);
    expect(shouldDecodeImage("background", 1)).toBe(false);
    expect(shouldDecodeImage("background", 2)).toBe(false);
  });

  it('"gated-out" (pane intentionally disabled) never decodes', () => {
    expect(shouldDecodeImage("gated-out", 0)).toBe(false);
    expect(shouldDecodeImage("gated-out", 3)).toBe(false);
  });

  it('"out-of-band" (row outside the visible band) never decodes', () => {
    expect(shouldDecodeImage("out-of-band", 0)).toBe(false);
    expect(shouldDecodeImage("out-of-band", 3)).toBe(false);
  });

  it("undefined (no scope managing this row) never decodes", () => {
    expect(shouldDecodeImage(undefined, 0)).toBe(false);
  });
});
