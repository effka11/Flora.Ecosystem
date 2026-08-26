import { beforeEach, describe, expect, it } from "vitest";
import {
  BODY_MEASURE_CACHE_CAPACITY,
  getCachedBodyMeasure,
  getCachedTimeLabelWidth,
  resetMessageTextMeasureCache,
  setCachedBodyMeasure,
  setCachedTimeLabelWidth,
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

describe("resetMessageTextMeasureCache", () => {
  it("clears both the body and time label caches", () => {
    setCachedBodyMeasure("hello", 200, { lineWidths: [42], lines: ["hello"] });
    setCachedTimeLabelWidth("12:34", 30);

    resetMessageTextMeasureCache();

    expect(getCachedBodyMeasure("hello", 200)).toBeNull();
    expect(getCachedTimeLabelWidth("12:34")).toBeNull();
  });
});
