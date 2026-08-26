import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BODY_MEASURE_CACHE_CAPACITY,
  clearMessageTextMeasures,
  getCachedBodyMeasure,
  getCachedTimeLabelWidth,
  hydrateMessageTextMeasures,
  resetMessageTextMeasureCache,
  setCachedBodyMeasure,
  setCachedTimeLabelWidth,
  setMessageTextMeasureDirtyListener,
  snapshotMessageTextMeasures,
  type CachedBodyMeasure,
} from "./messageTextMeasureCache";

beforeEach(() => {
  resetMessageTextMeasureCache();
});

describe("body measure cache", () => {
  it("misses on an unknown body", () => {
    expect(getCachedBodyMeasure("hello", 200)).toBeNull();
  });

  it("hits after a write for the same body and width", () => {
    const measure: CachedBodyMeasure = { lineWidths: [42], lines: ["hello"] };
    setCachedBodyMeasure("hello", 200, measure);
    expect(getCachedBodyMeasure("hello", 200)).toEqual(measure);
  });

  it("misses for the same body at a different maxInnerWidthPx", () => {
    setCachedBodyMeasure("hello", 200, { lineWidths: [42], lines: ["hello"] });
    expect(getCachedBodyMeasure("hello", 201)).toBeNull();
  });

  it("misses for a different body at the same width", () => {
    setCachedBodyMeasure("hello", 200, { lineWidths: [42], lines: ["hello"] });
    expect(getCachedBodyMeasure("goodbye", 200)).toBeNull();
  });

  it("evicts the least-recently-used entry once capacity overflows", () => {
    const capacity = BODY_MEASURE_CACHE_CAPACITY;
    for (let i = 0; i < capacity; i += 1) {
      setCachedBodyMeasure(`body-${i}`, 200, { lineWidths: [i], lines: [`body-${i}`] });
    }

    // "body-0" is the oldest entry and hasn't been read since, so writing one
    // more entry past capacity must evict it rather than any other entry.
    setCachedBodyMeasure("body-overflow", 200, {
      lineWidths: [1],
      lines: ["body-overflow"],
    });

    expect(getCachedBodyMeasure("body-0", 200)).toBeNull();
    expect(getCachedBodyMeasure("body-1", 200)).not.toBeNull();
    expect(getCachedBodyMeasure("body-overflow", 200)).not.toBeNull();
  });
});

describe("time label width cache", () => {
  it("misses on an unknown time label", () => {
    expect(getCachedTimeLabelWidth("12:34")).toBeNull();
  });

  it("hits after a write for the same time label", () => {
    setCachedTimeLabelWidth("12:34", 30);
    expect(getCachedTimeLabelWidth("12:34")).toBe(30);
  });

  it("misses for a different time label", () => {
    setCachedTimeLabelWidth("12:34", 30);
    expect(getCachedTimeLabelWidth("12:35")).toBeNull();
  });
});

describe("snapshot and hydrate", () => {
  it("round-trips body and time label measurements", () => {
    setCachedBodyMeasure("hello", 200, { lineWidths: [42], lines: ["hello"] });
    setCachedTimeLabelWidth("12:34", 30);

    const snapshot = snapshotMessageTextMeasures(10);
    clearMessageTextMeasures();
    expect(getCachedBodyMeasure("hello", 200)).toBeNull();

    hydrateMessageTextMeasures(snapshot);
    expect(getCachedBodyMeasure("hello", 200)).toEqual({ lineWidths: [42], lines: ["hello"] });
    expect(getCachedTimeLabelWidth("12:34")).toBe(30);
  });

  it("keeps only the newest body entries within the persist cap", () => {
    for (let i = 0; i < 5; i += 1) {
      setCachedBodyMeasure(`body-${i}`, 200, { lineWidths: [i], lines: [`body-${i}`] });
    }

    const snapshot = snapshotMessageTextMeasures(2);
    expect(snapshot.body.map(([key]) => key)).toEqual(["200|body-3", "200|body-4"]);
  });

  it("skips malformed entries instead of throwing", () => {
    hydrateMessageTextMeasures({
      body: [
        ["200|ok", { lineWidths: [10], lines: ["ok"] }],
        ["200|bad-widths", { lineWidths: ["10"], lines: ["bad"] }],
        ["200|missing-lines", { lineWidths: [10] }],
        [42, { lineWidths: [10], lines: ["not a string key"] }],
        "not an entry",
      ],
      time: [
        ["12:34", 30],
        ["12:35", "30"],
        ["12:36", Number.NaN],
      ],
    });

    expect(getCachedBodyMeasure("ok", 200)).toEqual({ lineWidths: [10], lines: ["ok"] });
    expect(getCachedBodyMeasure("bad-widths", 200)).toBeNull();
    expect(getCachedBodyMeasure("missing-lines", 200)).toBeNull();
    expect(getCachedTimeLabelWidth("12:34")).toBe(30);
    expect(getCachedTimeLabelWidth("12:35")).toBeNull();
    expect(getCachedTimeLabelWidth("12:36")).toBeNull();
  });

  it("ignores a payload that is not a snapshot", () => {
    expect(() => hydrateMessageTextMeasures(null)).not.toThrow();
    expect(() => hydrateMessageTextMeasures("nope")).not.toThrow();
    expect(() => hydrateMessageTextMeasures({ body: 1, time: 2 })).not.toThrow();
  });

  it("marks the cache dirty on writes but not on hydration", () => {
    const dirty = vi.fn();
    setMessageTextMeasureDirtyListener(dirty);

    hydrateMessageTextMeasures({
      body: [["200|hydrated", { lineWidths: [10], lines: ["hydrated"] }]],
      time: [],
    });
    expect(dirty).not.toHaveBeenCalled();

    setCachedBodyMeasure("fresh", 200, { lineWidths: [10], lines: ["fresh"] });
    expect(dirty).toHaveBeenCalledTimes(1);
  });
});

describe("resetMessageTextMeasureCache", () => {
  it("clears both the body and time label caches", () => {
    setCachedBodyMeasure("hello", 200, { lineWidths: [42], lines: ["hello"] });
    setCachedTimeLabelWidth("12:34", 30);

    resetMessageTextMeasureCache();

    expect(getCachedBodyMeasure("hello", 200)).toBeNull();
    expect(getCachedTimeLabelWidth("12:34")).toBeNull();
  });
});
