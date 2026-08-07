import { describe, expect, it } from "vitest";
import {
  clampStripOffset,
  expandMountedAround,
  mountedSetsEqual,
  reconcileMountedIds,
} from "./settingsMountedSections";

const ALL = ["account", "privacy", "security", "notifications", "customization"] as const;

describe("clampStripOffset", () => {
  it("clamps to edges and passes mid values", () => {
    expect(clampStripOffset(-10, 100)).toBe(0);
    expect(clampStripOffset(0, 100)).toBe(0);
    expect(clampStripOffset(40, 100)).toBe(40);
    expect(clampStripOffset(100, 100)).toBe(100);
    expect(clampStripOffset(150, 100)).toBe(100);
  });

  it("treats negative max as zero span", () => {
    expect(clampStripOffset(5, -1)).toBe(0);
  });
});

describe("expandMountedAround", () => {
  it("returns empty for empty section list", () => {
    expect([...expandMountedAround([], 0)]).toEqual([]);
  });

  it("clamps to edges for first and last index", () => {
    expect([...expandMountedAround(ALL, 0)].sort()).toEqual(["account", "privacy"]);
    expect([...expandMountedAround(ALL, ALL.length - 1)].sort()).toEqual([
      "customization",
      "notifications",
    ]);
  });

  it("includes active±1 in the middle", () => {
    expect([...expandMountedAround(ALL, 2)].sort()).toEqual([
      "notifications",
      "privacy",
      "security",
    ]);
  });
});

describe("reconcileMountedIds", () => {
  it("cold: only active when expandNeighbors is false", () => {
    const next = reconcileMountedIds({
      prev: new Set<(typeof ALL)[number]>(),
      visibleIds: ALL,
      activeIndex: 0,
      expandNeighbors: false,
    });
    expect([...next]).toEqual(["account"]);
  });

  it("expand: active±1 with clamp on edges", () => {
    const atStart = reconcileMountedIds({
      prev: new Set(["account"] as const),
      visibleIds: ALL,
      activeIndex: 0,
      expandNeighbors: true,
    });
    expect([...atStart].sort()).toEqual(["account", "privacy"]);

    const atEnd = reconcileMountedIds({
      prev: new Set(["customization"] as const),
      visibleIds: ALL,
      activeIndex: ALL.length - 1,
      expandNeighbors: true,
    });
    expect([...atEnd].sort()).toEqual(["customization", "notifications"]);
  });

  it("sticky: prev survives active change while still visible", () => {
    const prev = new Set(["account", "privacy"] as const);
    const next = reconcileMountedIds({
      prev,
      visibleIds: ALL,
      activeIndex: 2,
      expandNeighbors: true,
    });
    expect(next.has("account")).toBe(true);
    expect(next.has("privacy")).toBe(true);
    expect(next.has("security")).toBe(true);
    expect(next.has("notifications")).toBe(true);
  });

  it("search: drops ids outside visible; keeps active and neighbors when expanded", () => {
    const visible = ["security", "notifications", "customization"] as const;
    const prev = new Set(["account", "privacy", "security"] as const);
    const sync = reconcileMountedIds({
      prev,
      visibleIds: visible,
      activeIndex: 0,
      expandNeighbors: false,
    });
    expect([...sync].sort()).toEqual(["security"]);

    const expanded = reconcileMountedIds({
      prev: sync,
      visibleIds: visible,
      activeIndex: 0,
      expandNeighbors: true,
    });
    expect([...expanded].sort()).toEqual(["notifications", "security"]);
  });
});

describe("mountedSetsEqual", () => {
  it("compares membership regardless of insertion order", () => {
    const a = new Set(["a", "b"] as const);
    const b = new Set(["b", "a"] as const);
    expect(mountedSetsEqual(a, b)).toBe(true);
    expect(mountedSetsEqual(a, new Set(["a"] as const))).toBe(false);
  });
});
