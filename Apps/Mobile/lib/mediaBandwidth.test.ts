import { afterEach, describe, expect, it } from "vitest";
import {
  calculateRowsAhead,
  DEFAULT_AVERAGE_IMAGE_KILOBYTES,
  DEFAULT_BANDWIDTH_KILOBYTES_PER_SECOND,
  getMediaBandwidthEstimate,
  initializeMediaBandwidth,
  MediaBandwidthEstimator,
  resetMediaBandwidth,
} from "./mediaBandwidth";

describe("MediaBandwidthEstimator", () => {
  it("converges its EWMA toward a stable download speed", () => {
    const estimator = new MediaBandwidthEstimator();

    for (let index = 0; index < 20; index += 1) {
      estimator.reportDownload({
        bytes: 200 * 1024,
        durationMilliseconds: 1000,
        interrupted: false,
      });
    }

    expect(estimator.getEstimate().kilobytesPerSecond).toBeCloseTo(200, 5);
    expect(estimator.getEstimate().averageImageKilobytes).toBeCloseTo(200, 5);
  });

  it("discards samples smaller than 16 KB", () => {
    const estimator = new MediaBandwidthEstimator();

    expect(
      estimator.reportDownload({
        bytes: 16 * 1024 - 1,
        durationMilliseconds: 100,
        interrupted: false,
      }),
    ).toBe(false);
    expect(estimator.getEstimate().hasValidSamples).toBe(false);
  });

  it("discards interrupted samples", () => {
    const estimator = new MediaBandwidthEstimator();

    expect(
      estimator.reportDownload({
        bytes: 64 * 1024,
        durationMilliseconds: 100,
        interrupted: true,
      }),
    ).toBe(false);
    expect(estimator.getEstimate().hasValidSamples).toBe(false);
  });

  it.each([0, -1])("discards a %i ms duration", (durationMilliseconds) => {
    const estimator = new MediaBandwidthEstimator();

    expect(
      estimator.reportDownload({
        bytes: 64 * 1024,
        durationMilliseconds,
        interrupted: false,
      }),
    ).toBe(false);
    expect(estimator.getEstimate().hasValidSamples).toBe(false);
  });

  it("clamps rows ahead to the lower bound", () => {
    expect(calculateRowsAhead(1, 1000)).toBe(2);
  });

  it("clamps rows ahead to the upper bound", () => {
    expect(calculateRowsAhead(10_000, 10)).toBe(10);
  });

  it("uses conservative defaults on a cold start", () => {
    const estimator = new MediaBandwidthEstimator();

    expect(estimator.getEstimate()).toEqual({
      kilobytesPerSecond: DEFAULT_BANDWIDTH_KILOBYTES_PER_SECOND,
      averageImageKilobytes: DEFAULT_AVERAGE_IMAGE_KILOBYTES,
      rowsAhead: 5,
      hasValidSamples: false,
    });
  });
});

describe("initializeMediaBandwidth", () => {
  afterEach(() => {
    resetMediaBandwidth();
  });

  it("restores the last estimate from injected storage without MMKV", async () => {
    const storage = {
      getString: async () =>
        JSON.stringify({
          version: 1,
          kilobytesPerSecond: 500,
          averageImageKilobytes: 250,
        }),
      setString: async () => undefined,
    };

    await expect(initializeMediaBandwidth(storage)).resolves.toBe(true);
    expect(getMediaBandwidthEstimate()).toEqual({
      kilobytesPerSecond: 500,
      averageImageKilobytes: 250,
      rowsAhead: 8,
      hasValidSamples: true,
    });
  });
});
