import { describe, expect, it } from "vitest";
import { neighborExpandDeferMs } from "./useDeferredPagerMount";

describe("neighborExpandDeferMs", () => {
  it("does not defer when quiet is not required", () => {
    expect(neighborExpandDeferMs(false, 0)).toBeNull();
  });

  it("returns remaining quiet ms until the window elapses", () => {
    expect(neighborExpandDeferMs(true, 0, 400)).toBe(400);
    expect(neighborExpandDeferMs(true, 250, 400)).toBe(150);
  });

  it("clears once the quiet window has elapsed", () => {
    expect(neighborExpandDeferMs(true, 400, 400)).toBeNull();
    expect(neighborExpandDeferMs(true, 401, 400)).toBeNull();
  });
});
