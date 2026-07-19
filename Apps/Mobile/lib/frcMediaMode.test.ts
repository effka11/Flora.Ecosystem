import { describe, expect, it } from "vitest";
import {
  backgroundLookaheadForNetwork,
  computeRowMediaModes,
  priorityForMode,
  shouldDecodeImage,
} from "@/lib/frcMediaMode";

describe("backgroundLookaheadForNetwork", () => {
  it("is generous on wifi, minimal on metered, zero otherwise", () => {
    expect(backgroundLookaheadForNetwork("wifi")).toBe(3);
    expect(backgroundLookaheadForNetwork("metered")).toBe(1);
    expect(backgroundLookaheadForNetwork("unknown")).toBe(0);
  });
});

describe("computeRowMediaModes", () => {
  it("returns empty for empty lists", () => {
    expect(computeRowMediaModes({ count: 0, minVisible: 0, maxVisible: 0, lookahead: 3 }).size).toBe(0);
  });

  it("marks visible band, adjacent near rows and lookahead background", () => {
    const modes = computeRowMediaModes({ count: 20, minVisible: 5, maxVisible: 7, lookahead: 3 });
    expect(modes.get(5)).toBe("visible");
    expect(modes.get(6)).toBe("visible");
    expect(modes.get(7)).toBe("visible");
    expect(modes.get(4)).toBe("near");
    expect(modes.get(8)).toBe("near");
    expect(modes.get(9)).toBe("background");
    expect(modes.get(10)).toBe("background");
    expect(modes.get(11)).toBe("background");
    expect(modes.has(12)).toBe(false);
    expect(modes.has(3)).toBe(false);
  });

  it("does not prewarm background when lookahead is zero (metered/offline)", () => {
    const modes = computeRowMediaModes({ count: 20, minVisible: 5, maxVisible: 7, lookahead: 0 });
    expect(modes.get(8)).toBe("near");
    expect(modes.has(9)).toBe(false);
  });

  it("clamps to list bounds", () => {
    const modes = computeRowMediaModes({ count: 3, minVisible: 0, maxVisible: 2, lookahead: 3 });
    expect(modes.get(0)).toBe("visible");
    expect(modes.get(2)).toBe("visible");
    expect(modes.has(3)).toBe(false);
    expect(modes.has(-1)).toBe(false);
  });

  it("defaults to top-of-list when viewability is unknown", () => {
    const modes = computeRowMediaModes({ count: 20, minVisible: null, maxVisible: null, lookahead: 3 });
    expect(modes.get(0)).toBe("visible");
    expect(modes.get(1)).toBe("near");
    expect(modes.get(2)).toBe("background");
  });
});

describe("priorityForMode / shouldDecodeImage", () => {
  it("maps modes to queue priority", () => {
    expect(priorityForMode("visible")).toBe("visible");
    expect(priorityForMode("near")).toBe("near");
    expect(priorityForMode("background")).toBe("background");
    expect(priorityForMode(undefined)).toBe("background");
  });

  it("decodes all images only when visible; first image only when near/background", () => {
    expect(shouldDecodeImage("visible", 0)).toBe(true);
    expect(shouldDecodeImage("visible", 3)).toBe(true);
    expect(shouldDecodeImage("near", 0)).toBe(true);
    expect(shouldDecodeImage("near", 1)).toBe(false);
    expect(shouldDecodeImage("background", 0)).toBe(true);
    expect(shouldDecodeImage("background", 2)).toBe(false);
    expect(shouldDecodeImage(undefined, 0)).toBe(false);
  });
});
