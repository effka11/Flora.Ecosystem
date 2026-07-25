import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FrcCacheBackend, FrcDecodedFormat } from "@/lib/frcImageCache";

/**
 * `frcImage.ts` is the composition layer, so the only way to test what it
 * composes is to import it with its platform bindings replaced. Everything
 * below the seam — the cache core, the pipeline, the bandwidth estimator — is
 * the real implementation; the fakes are the file system, the native decoder
 * and MMKV, exactly the parts a node test cannot have.
 */
const harness = vi.hoisted(() => {
  const FRI_SIZE_BYTES = 32 * 1024;
  const files = new Map<string, Uint8Array>();
  const downloads: string[] = [];
  const decodes: string[] = [];
  const releases: (() => void)[] = [];
  let held = false;
  let nonce = 0;

  return {
    friKilobytes: FRI_SIZE_BYTES / 1024,
    files,
    downloads,
    decodes,
    releases,
    nextNonce: () => (nonce += 1),
    friBytes(): Uint8Array {
      const bytes = new Uint8Array(FRI_SIZE_BYTES);
      bytes.set([0x8f, 0x46, 0x52, 0x49]);
      bytes[4] = 9;
      bytes[6] = 64;
      bytes[10] = 64;
      return bytes;
    },
    /** Holds every download open until {@link release}, to keep a task in flight. */
    hold(next: boolean) {
      held = next;
    },
    isHeld: () => held,
    release() {
      for (const resolve of releases.splice(0)) resolve();
    },
    reset() {
      files.clear();
      downloads.length = 0;
      decodes.length = 0;
      releases.length = 0;
      held = false;
    },
  };
});

vi.mock("@shopify/flash-list", () => ({
  useRecyclingState: () => ["", () => {}],
}));

vi.mock("expo-file-system", () => ({
  File: class {},
  Paths: { cache: "cache://" },
  FileMode: { ReadOnly: "r" },
}));

vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
  PixelRatio: { get: () => 1 },
}));

vi.mock("flora-frc-i", () => ({
  decodeFrcFileToPng: async () => {},
  encodeImageFileToFrc: async () => {},
  isFloraFrcIAvailable: () => false,
}));

vi.mock("@/lib/mmkv", () => ({
  mmkv: { getString: () => undefined, set: () => {}, delete: () => {} },
  mmkvStore: {
    getString: async () => null,
    setString: async () => {},
    delete: async () => {},
  },
}));

vi.mock("@/lib/frcImageCacheExpo", () => {
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const FINAL_NAME = /^final:\/\/(.+)\.(?:png|jpg)$/;

  const backend: FrcCacheBackend = {
    ensureReady() {},
    listFinalEntries() {
      return [...harness.files]
        .map(([uri, bytes]) => ({ match: FINAL_NAME.exec(uri), uri, bytes }))
        .filter((entry) => entry.match !== null)
        .map((entry) => ({ key: entry.match![1], uri: entry.uri, size: entry.bytes.length }));
    },
    listPartUris() {
      return [...harness.files.keys()].filter((uri) => uri.startsWith("part://"));
    },
    deleteLegacyNamespace() {},
    finalUri: (key, format) => `final://${key}.${format === "png" ? "png" : "jpg"}`,
    tempPartUri: (key, suffix) => `part://${key}.${harness.nextNonce()}.${suffix}`,
    fileExists: (uri) => harness.files.has(uri),
    fileSize: (uri) => harness.files.get(uri)?.length ?? 0,
    deleteFile: (uri) => void harness.files.delete(uri),
    async download(url, destUri, signal) {
      harness.downloads.push(url);
      if (harness.isHeld()) {
        await new Promise<void>((resolve) => harness.releases.push(resolve));
      }
      if (signal?.aborted) throw new Error("aborted");
      harness.files.set(destUri, harness.friBytes());
    },
    readHeader: (uri, length) =>
      (harness.files.get(uri) ?? new Uint8Array()).subarray(0, length),
    async decode(friUri, destUri): Promise<FrcDecodedFormat> {
      harness.decodes.push(friUri);
      harness.files.set(destUri, PNG_BYTES);
      return "png";
    },
    moveFile(fromUri, toUri) {
      const bytes = harness.files.get(fromUri);
      if (!bytes) throw new Error("missing source");
      harness.files.set(toUri, bytes);
      harness.files.delete(fromUri);
    },
    hashUrl: (url) => url.replace(/[^a-z0-9]/gi, "").padEnd(64, "0").slice(0, 64).toLowerCase(),
  };

  return {
    createExpoFrcCacheBackend: () => backend,
    createMmkvFrcCacheIndex: () => undefined,
  };
});

const { prefetchFrcImage } = await import("@/lib/frcImage");
const { getMediaBandwidthEstimate, resetMediaBandwidth } = await import(
  "@/lib/mediaBandwidth"
);

/** The two pipeline stages are promise-driven; no timer has to advance. */
async function settlePipeline(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
}

describe("prefetchFrcImage", () => {
  beforeEach(() => {
    // `performance` is faked as well: the throughput sample is measured with
    // it, and a download that takes zero milliseconds is not a measurement.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    harness.reset();
    resetMediaBandwidth();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("joins an existing task for the same (url, bucket) pair", async () => {
    harness.hold(true);
    const cancelFirst = prefetchFrcImage("https://cdn/join.fri");
    const cancelSecond = prefetchFrcImage("https://cdn/join.fri");
    await settlePipeline();

    expect(harness.downloads).toEqual(["https://cdn/join.fri"]);

    // The same picture at another display size is a different decode, so it is
    // a different task rather than a join.
    const cancelSmall = prefetchFrcImage("https://cdn/join.fri", { displayWidth: 90 });
    await settlePipeline();
    expect(harness.downloads).toHaveLength(2);

    cancelFirst();
    cancelSecond();
    cancelSmall();
    harness.hold(false);
    harness.release();
    await settlePipeline();
  });

  it("cancels the subscription it handed out, so an unobserved download never decodes", async () => {
    harness.hold(true);
    const cancel = prefetchFrcImage("https://cdn/cancel.fri");
    await settlePipeline();
    expect(harness.downloads).toEqual(["https://cdn/cancel.fri"]);

    cancel();
    cancel(); // idempotent: a caller may cancel after completion too
    vi.advanceTimersByTime(120);
    harness.release();
    await settlePipeline();

    expect(harness.decodes).toEqual([]);
    // An aborted download says nothing about throughput.
    expect(getMediaBandwidthEstimate().hasValidSamples).toBe(false);
  });

  it("does nothing for a local URI or for a variant already decoded at that bucket", async () => {
    expect(typeof prefetchFrcImage("file:///already/decoded.png")).toBe("function");
    expect(harness.downloads).toEqual([]);

    prefetchFrcImage("https://cdn/warm.fri", { displayWidth: 90 });
    await settlePipeline();
    expect(harness.downloads).toEqual(["https://cdn/warm.fri"]);
    expect(harness.decodes).toHaveLength(1);

    prefetchFrcImage("https://cdn/warm.fri", { displayWidth: 90 });
    await settlePipeline();
    expect(harness.downloads).toHaveLength(1);
  });

  it("feeds every completed .fri download into the lookahead depth", async () => {
    harness.hold(true);
    const cancel = prefetchFrcImage("https://cdn/measured.fri");
    await settlePipeline();

    vi.advanceTimersByTime(250);
    harness.hold(false);
    harness.release();
    await settlePipeline();

    const estimate = getMediaBandwidthEstimate();
    expect(estimate.hasValidSamples).toBe(true);
    expect(estimate.averageImageKilobytes).toBe(harness.friKilobytes);
    // 32 KB in 250 ms = 128 KB/s, which covers far more than ten rows in the
    // four-second lead, hence the clamp.
    expect(estimate.kilobytesPerSecond).toBeCloseTo(128, 6);
    expect(estimate.rowsAhead).toBe(10);

    cancel();
  });
});
