import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetScrollActivity,
  clearScrollActivityOwner,
  createIdleMountHold,
  isScrollSettled,
  setPagerBusyActivity,
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

  it("is not settled while a pager reports touch, pager, or strip", () => {
    const a = Symbol("pager");
    setScrollActivity(a, "touch", true);
    expect(isScrollSettled()).toBe(false);
    setScrollActivity(a, "touch", false);
    setScrollActivity(a, "pager", true);
    expect(isScrollSettled()).toBe(false);
    setScrollActivity(a, "pager", false);
    setScrollActivity(a, "strip", true);
    expect(isScrollSettled()).toBe(false);
    setScrollActivity(a, "strip", false);
    expect(isScrollSettled()).toBe(true);
  });

  it("is not settled while a tab-switch overlay reports route", () => {
    const a = Symbol("route");
    setScrollActivity(a, "route", true);
    expect(isScrollSettled()).toBe(false);
    setScrollActivity(a, "route", false);
    expect(isScrollSettled()).toBe(true);
  });

  it("maps a pager busy snapshot onto the shared registry", () => {
    const a = Symbol("snapshot");
    setPagerBusyActivity(a, { touch: true, pager: false, strip: false });
    expect(isScrollSettled()).toBe(false);
    setPagerBusyActivity(a, { touch: false, pager: true, strip: true });
    expect(isScrollSettled()).toBe(false);
    setPagerBusyActivity(a, { touch: false, pager: false, strip: false });
    expect(isScrollSettled()).toBe(true);
  });

  it("does not flap settled when a pager snapshot swaps touch for pager", () => {
    const listener = vi.fn();
    const unsub = subscribeScrollSettled(listener);
    const a = Symbol("swap");
    setPagerBusyActivity(a, { touch: true, pager: false, strip: false });
    setPagerBusyActivity(a, { touch: false, pager: true, strip: false });
    expect(listener.mock.calls).toEqual([[false]]);
    expect(isScrollSettled()).toBe(false);
    unsub();
  });

  it("holds mount across nested idle Fabric commits until every clear", () => {
    const owner = Symbol("mount");
    const pending: (() => void)[] = [];
    const hold = createIdleMountHold(owner, (release) => {
      pending.push(release);
    });
    hold.run(() => {});
    expect(isScrollSettled()).toBe(false);
    hold.run(() => {});
    expect(isScrollSettled()).toBe(false);
    pending.shift()?.();
    expect(isScrollSettled()).toBe(false);
    pending.shift()?.();
    expect(isScrollSettled()).toBe(true);
    hold.dispose();
  });

  it("reset drops mount so a late clear cannot re-hold", () => {
    const owner = Symbol("reset");
    const pending: (() => void)[] = [];
    const hold = createIdleMountHold(owner, (release) => {
      pending.push(release);
    });
    hold.run(() => {});
    hold.reset();
    expect(isScrollSettled()).toBe(true);
    pending.shift()?.();
    expect(isScrollSettled()).toBe(true);
    hold.dispose();
  });

  it("ignores a late clear after reset so a new hold stays up", () => {
    const owner = Symbol("gen");
    const pending: (() => void)[] = [];
    const hold = createIdleMountHold(owner, (release) => {
      pending.push(release);
    });
    hold.run(() => {});
    hold.reset();
    hold.run(() => {});
    expect(isScrollSettled()).toBe(false);
    pending.shift()?.();
    expect(isScrollSettled()).toBe(false);
    pending.shift()?.();
    expect(isScrollSettled()).toBe(true);
    hold.dispose();
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
