import { describe, expect, it } from "vitest";
import { floraRouteTransitionClearMs } from "./floraRouteEnterFade.js";
import {
  floraRouteKeyframeEasing,
  floraRouteRevealEasing,
} from "./floraRouteEasing.js";
import { floraMotion } from "./theme.js";

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

describe("floraRouteRevealEasing", () => {
  it("returns 0 at start and 1 at end", () => {
    expect(floraRouteRevealEasing(0)).toBe(0);
    expect(floraRouteRevealEasing(1)).toBe(1);
  });

  it("starts immediately without dumping the fade", () => {
    expect(floraRouteRevealEasing(0.2)).toBeCloseTo(0.36, 5);
  });

  it("has already cleared most of the veil by 80%", () => {
    expect(floraRouteRevealEasing(0.8)).toBeCloseTo(0.96, 5);
  });

  it("is ease-out quad, not a symmetric S-curve", () => {
    expect(floraRouteRevealEasing(0.5)).toBeCloseTo(0.75, 5);
  });

  it("ramps monotonically", () => {
    const samples = [0, 0.2, 0.4, 0.6, 0.8, 1];
    for (let i = 1; i < samples.length; i++) {
      expect(floraRouteRevealEasing(samples[i]!)).toBeGreaterThan(
        floraRouteRevealEasing(samples[i - 1]!),
      );
    }
  });
});

describe("tab route fade duration", () => {
  it("uses duration-2, not the subtab slide settle", () => {
    expect(floraMotion.tabTransitionDurationMs).toBe(floraMotion.baseMs * 2);
    expect(floraMotion.tabTransitionDurationMs).toBeLessThan(floraMotion.baseMs * 3);
  });

  it("keeps the busy-clear slack above the fade", () => {
    expect(floraRouteTransitionClearMs).toBe(floraMotion.tabTransitionDurationMs + 50);
  });
});
