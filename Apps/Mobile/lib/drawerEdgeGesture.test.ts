import { describe, expect, it } from "vitest";
import {
  classifyDrawerEdgeIntent,
  shouldClaimDrawerEdgeTouch,
  shouldOpenDrawer,
} from "./drawerEdgeGesture";

describe("drawer edge gesture", () => {
  it("does not claim chrome taps or touches outside the edge strip", () => {
    expect(shouldClaimDrawerEdgeTouch(30, 80, 60, 120)).toBe(false);
    expect(shouldClaimDrawerEdgeTouch(30, 120, 60, 120)).toBe(false);
    expect(shouldClaimDrawerEdgeTouch(70, 200, 60, 120)).toBe(false);
  });

  it("claims feed touches inside the edge strip below chrome", () => {
    expect(shouldClaimDrawerEdgeTouch(30, 121, 60, 120)).toBe(true);
    expect(shouldClaimDrawerEdgeTouch(60, 400, 60, 120)).toBe(true);
  });

  it("fails vertical and leftward intent at the 8px edge axis", () => {
    expect(classifyDrawerEdgeIntent(2, 9, 8)).toBe("fail");
    expect(classifyDrawerEdgeIntent(6, 10, 8)).toBe("fail");
    expect(classifyDrawerEdgeIntent(-5, 1, 8)).toBe("fail");
  });

  it("activates rightward intent and leaves touch slop pending", () => {
    expect(classifyDrawerEdgeIntent(5, 2, 8)).toBe("activate");
    expect(classifyDrawerEdgeIntent(3, 2, 8)).toBe("pending");
  });

  it("opens from a slow partial drag or a short fast flick", () => {
    expect(shouldOpenDrawer(0.13, 300, 0, 0.12, 30, 220)).toBe(true);
    expect(shouldOpenDrawer(0.1, 300, 0, 0.12, 30, 220)).toBe(true);
    expect(shouldOpenDrawer(0.02, 300, 221, 0.12, 30, 220)).toBe(true);
    expect(shouldOpenDrawer(0.02, 300, 100, 0.12, 30, 220)).toBe(false);
  });
});
