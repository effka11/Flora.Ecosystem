import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getImageRatio,
  hydrateImageRatios,
  resetImageRatioCache,
  serializeImageRatios,
  setImageRatio,
  setImageRatioDirtyListener,
} from "@/lib/imageRatioCache";

beforeEach(() => {
  resetImageRatioCache();
});

describe("getImageRatio / setImageRatio", () => {
  it("misses on an unknown id", () => {
    expect(getImageRatio("a")).toBeNull();
  });

  it("hits after a write", () => {
    setImageRatio("a", 1.5);
    expect(getImageRatio("a")).toBe(1.5);
  });

  it("ignores non-finite ratios", () => {
    setImageRatio("a", Number.NaN);
    setImageRatio("b", Number.POSITIVE_INFINITY);
    expect(getImageRatio("a")).toBeNull();
    expect(getImageRatio("b")).toBeNull();
  });

  it("ignores zero and negative ratios", () => {
    setImageRatio("a", 0);
    setImageRatio("b", -2);
    expect(getImageRatio("a")).toBeNull();
    expect(getImageRatio("b")).toBeNull();
  });
});

describe("hydrateImageRatios / serializeImageRatios round-trip", () => {
  it("restores a previously serialized snapshot", () => {
    setImageRatio("a", 1.5);
    setImageRatio("b", 0.8);
    const snapshot = serializeImageRatios();

    resetImageRatioCache();
    expect(getImageRatio("a")).toBeNull();

    hydrateImageRatios(snapshot);
    expect(getImageRatio("a")).toBe(1.5);
    expect(getImageRatio("b")).toBe(0.8);
  });

  it("ignores a null snapshot", () => {
    hydrateImageRatios(null);
    expect(serializeImageRatios()).toBe("[]");
  });

  it("silently ignores malformed JSON", () => {
    hydrateImageRatios("{not json");
    expect(serializeImageRatios()).toBe("[]");
  });

  it("silently ignores a well-formed JSON value that is not an array", () => {
    hydrateImageRatios('{"a": 1.5}');
    expect(serializeImageRatios()).toBe("[]");
  });

  it("drops garbage entries while keeping the valid ones", () => {
    hydrateImageRatios(
      JSON.stringify([
        ["a", 1.5],
        ["b", "not-a-number"],
        ["c", Number.NaN],
        ["d", -1],
        ["e"],
        "not-a-pair",
        ["f", 2],
      ]),
    );

    expect(getImageRatio("a")).toBe(1.5);
    expect(getImageRatio("f")).toBe(2);
    expect(getImageRatio("b")).toBeNull();
    expect(getImageRatio("c")).toBeNull();
    expect(getImageRatio("d")).toBeNull();
    expect(getImageRatio("e")).toBeNull();
  });
});

describe("capacity eviction", () => {
  it("evicts the least-recently-used entry once capacity overflows", () => {
    const capacity = 300;
    for (let i = 0; i < capacity; i += 1) {
      setImageRatio(`id-${i}`, 1 + i / 1000);
    }
    // Note: intentionally not reading "id-0" here — `getImageRatio` refreshes
    // LRU recency as a side effect, which would make it survive the eviction
    // below and defeat the point of this test.

    setImageRatio("id-overflow", 1.234);

    expect(getImageRatio("id-0")).toBeNull();
    expect(getImageRatio("id-1")).not.toBeNull();
    expect(getImageRatio("id-overflow")).toBe(1.234);

    const serialized = JSON.parse(serializeImageRatios()) as [string, number][];
    expect(serialized).toHaveLength(capacity);
  });

  it("preserves LRU recency when serializing", () => {
    const capacity = 300;
    for (let i = 0; i < capacity; i += 1) {
      setImageRatio(`id-${i}`, 1 + i / 1000);
    }

    serializeImageRatios();
    setImageRatio("id-overflow", 1.234);

    expect(getImageRatio("id-0")).toBeNull();
    expect(getImageRatio("id-1")).not.toBeNull();
    expect(getImageRatio("id-overflow")).toBe(1.234);
  });
});

describe("setImageRatioDirtyListener", () => {
  it("fires when a new value is written", () => {
    const listener = vi.fn();
    setImageRatioDirtyListener(listener);

    setImageRatio("a", 1.5);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not fire when re-writing the same value", () => {
    const listener = vi.fn();
    setImageRatio("a", 1.5);
    setImageRatioDirtyListener(listener);

    setImageRatio("a", 1.5);

    expect(listener).not.toHaveBeenCalled();
  });

  it("does not fire for a rejected (invalid) value", () => {
    const listener = vi.fn();
    setImageRatioDirtyListener(listener);

    setImageRatio("a", -1);

    expect(listener).not.toHaveBeenCalled();
  });

  it("fires again when an existing id's value actually changes", () => {
    const listener = vi.fn();
    setImageRatio("a", 1.5);
    setImageRatioDirtyListener(listener);

    setImageRatio("a", 1.6);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stops firing once the listener is cleared", () => {
    const listener = vi.fn();
    setImageRatioDirtyListener(listener);
    setImageRatioDirtyListener(null);

    setImageRatio("a", 1.5);

    expect(listener).not.toHaveBeenCalled();
  });
});
