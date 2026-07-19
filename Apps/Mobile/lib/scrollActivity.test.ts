import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetScrollActivity,
  clearScrollActivityOwner,
  isScrollSettled,
  setScrollActivity,
  subscribeScrollSettled,
} from "./scrollActivity";

afterEach(() => __resetScrollActivity());

describe("scrollActivity", () => {
  it("starts settled", () => {
    expect(isScrollSettled()).toBe(true);
  });

  it("is not settled while any owner reports drag or momentum", () => {
    const a = Symbol("a");
    setScrollActivity(a, "drag", true);
    expect(isScrollSettled()).toBe(false);
    setScrollActivity(a, "drag", false);
    expect(isScrollSettled()).toBe(true);
  });

  it("requires all reasons cleared before settling", () => {
    const a = Symbol("a");
    setScrollActivity(a, "drag", true);
    setScrollActivity(a, "momentum", true);
    setScrollActivity(a, "drag", false);
    expect(isScrollSettled()).toBe(false);
    setScrollActivity(a, "momentum", false);
    expect(isScrollSettled()).toBe(true);
  });

  it("notifies subscribers only on settled-state transitions", () => {
    const listener = vi.fn();
    const unsub = subscribeScrollSettled(listener);
    const a = Symbol("a");
    setScrollActivity(a, "drag", true);
    setScrollActivity(a, "momentum", true); // still active, no transition
    setScrollActivity(a, "drag", false); // still active
    setScrollActivity(a, "momentum", false); // settled
    expect(listener.mock.calls).toEqual([[false], [true]]);
    unsub();
  });

  it("clearScrollActivityOwner settles when it was the only active owner", () => {
    const a = Symbol("a");
    setScrollActivity(a, "momentum", true);
    expect(isScrollSettled()).toBe(false);
    clearScrollActivityOwner(a);
    expect(isScrollSettled()).toBe(true);
  });
});
