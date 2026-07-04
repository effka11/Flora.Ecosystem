import { describe, expect, it } from "vitest";
import { floraRouteKeyframeEasing } from "./floraRouteEasing.js";

describe("floraRouteKeyframeEasing", () => {
  it("returns 0 at start and 1 at end", () => {
    expect(floraRouteKeyframeEasing(0)).toBe(0);
    expect(floraRouteKeyframeEasing(1)).toBe(1);
  });

  it("holds at 0 while eased timeline stays within the keyframe plateau", () => {
    expect(floraRouteKeyframeEasing(0)).toBe(0);
    expect(floraRouteKeyframeEasing(0.01)).toBe(0);
  });

  it("ramps monotonically after the hold window", () => {
    const samples = [0.2, 0.4, 0.6, 0.8, 0.95, 1];
    for (let i = 1; i < samples.length; i++) {
      expect(floraRouteKeyframeEasing(samples[i]!)).toBeGreaterThanOrEqual(
        floraRouteKeyframeEasing(samples[i - 1]!),
      );
    }
  });

  it("reaches full opacity before linear time ends", () => {
    expect(floraRouteKeyframeEasing(0.99)).toBeGreaterThan(0.9);
  });
});
