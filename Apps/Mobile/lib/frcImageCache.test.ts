import { describe, expect, it, vi } from "vitest";
import {
  FRC_BUCKET_WIDTHS,
  FRC_HEADER_LEN,
  FrcImageCache,
  isJpegSignature,
  isPngSignature,
  matchesDecodedFormat,
  sniffImageHeader,
  type FrcCacheBackend,
  type FrcCacheEntryRecord,
  type FrcCacheIndexStore,
  type FrcDecodedFormat,
  type FrcImageCacheOptions,
} from "./frcImageCache";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

/** Rungs used by name so the tests do not hard-code the ladder's contents. */
const SMALL_BUCKET = FRC_BUCKET_WIDTHS[0];
const MID_BUCKET = FRC_BUCKET_WIDTHS[3];
const FULL_BUCKET = FRC_BUCKET_WIDTHS[FRC_BUCKET_WIDTHS.length - 1];

function friHeader(version: number, width: number, height: number): Uint8Array {
  const h = new Uint8Array(FRC_HEADER_LEN + 4);
  h.set([0x8f, 0x46, 0x52, 0x49], 0);
  h[4] = version;
  h[6] = width & 0xff;
  h[7] = (width >> 8) & 0xff;
  h[10] = height & 0xff;
  h[11] = (height >> 8) & 0xff;
  h[14] = 8;
  h[16] = 8;
  return h;
}

describe("sniffImageHeader", () => {
  it("accepts a valid FRC-I header with dimensions", () => {
    expect(sniffImageHeader(friHeader(7, 1920, 1080))).toEqual({
      kind: "frc-i",
      version: 7,
      width: 1920,
      height: 1080,
    });
  });

  it("accepts current wire versions including v10", () => {
    expect(sniffImageHeader(friHeader(8, 100, 100)).kind).toBe("frc-i");
    expect(sniffImageHeader(friHeader(9, 1080, 1430)).kind).toBe("frc-i");
    expect(sniffImageHeader(friHeader(10, 1080, 1430))).toEqual({
      kind: "frc-i",
      version: 10,
      width: 1080,
      height: 1430,
    });
  });

  it("rejects out-of-range version", () => {
    expect(sniffImageHeader(friHeader(11, 100, 100)).kind).toBe("unknown");
    expect(sniffImageHeader(friHeader(0, 100, 100)).kind).toBe("unknown");
  });

  it("rejects zero / oversized dimensions", () => {
    expect(sniffImageHeader(friHeader(3, 0, 100)).kind).toBe("unknown");
    expect(sniffImageHeader(friHeader(3, 40000, 100)).kind).toBe("unknown");
  });

  it("classifies legacy formats", () => {
    expect(sniffImageHeader(new Uint8Array([0xff, 0xd8, 0xff, 0x00])).kind).toBe("legacy");
    expect(sniffImageHeader(PNG_BYTES)).toEqual({ kind: "legacy", format: "png" });
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(sniffImageHeader(webp)).toEqual({ kind: "legacy", format: "webp" });
  });

  it("marks anything else unknown", () => {
    expect(sniffImageHeader(new Uint8Array([1, 2, 3, 4])).kind).toBe("unknown");
  });

  it("isPngSignature detects PNG", () => {
    expect(isPngSignature(PNG_BYTES)).toBe(true);
    expect(isPngSignature(new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it("checks a decoded file against the container the decoder reported", () => {
    expect(isJpegSignature(JPEG_BYTES)).toBe(true);
    expect(isJpegSignature(PNG_BYTES)).toBe(false);
    expect(matchesDecodedFormat(JPEG_BYTES, "jpeg")).toBe(true);
    expect(matchesDecodedFormat(PNG_BYTES, "png")).toBe(true);
    expect(matchesDecodedFormat(JPEG_BYTES, "png")).toBe(false);
    expect(matchesDecodedFormat(PNG_BYTES, "jpeg")).toBe(false);
  });
});

type FakeFile = { bytes: Uint8Array; part: boolean; final: boolean; key?: string };

type DecodeCall = { friUri: string; destUri: string; maxDimension: number; quality: number };

function fakeBackend(config?: {
  friBytes?: (url: string) => Uint8Array;
  outSize?: number;
  outFormat?: FrcDecodedFormat;
  /** Bytes actually written by the decoder, when they must not match `outFormat`. */
  outBytes?: Uint8Array;
  onDownload?: (url: string) => void;
  /** Held open after the bytes have landed in the `.part`, to keep a download in flight. */
  gate?: () => Promise<void>;
}) {
  const files = new Map<string, FakeFile>();
  const decodeCalls: DecodeCall[] = [];
  const decode = vi.fn(
    async (friUri: string, destUri: string, maxDimension: number, quality: number) => {
      decodeCalls.push({ friUri, destUri, maxDimension, quality });
      const format = config?.outFormat ?? "png";
      const template = config?.outBytes ?? (format === "png" ? PNG_BYTES : JPEG_BYTES);
      const bytes = new Uint8Array(config?.outSize ?? template.length);
      bytes.set(template.subarray(0, Math.min(template.length, bytes.length)));
      files.set(destUri, { bytes, part: true, final: false });
      return format;
    },
  );
  const download = vi.fn(async (url: string, destUri: string, signal?: AbortSignal) => {
    if (signal?.aborted) throw new Error("aborted");
    config?.onDownload?.(url);
    const bytes = config?.friBytes ? config.friBytes(url) : friHeader(7, 64, 64);
    files.set(destUri, { bytes, part: true, final: false });
    if (config?.gate) {
      await config.gate();
      if (signal?.aborted) throw new Error("aborted");
    }
  });
  const deleteLegacyNamespace = vi.fn();

  const backend: FrcCacheBackend = {
    ensureReady: vi.fn(),
    listFinalEntries: vi.fn(() => {
      const out: FrcCacheEntryRecord[] = [];
      for (const [uri, f] of files) {
        if (f.final && f.key) out.push({ key: f.key, uri, size: f.bytes.length });
      }
      return out;
    }),
    listPartUris: vi.fn(() => {
      const out: string[] = [];
      for (const [uri, f] of files) if (f.part) out.push(uri);
      return out;
    }),
    deleteLegacyNamespace,
    finalUri: (key, format) => `final://${key}.${format === "png" ? "png" : "jpg"}`,
    tempPartUri: (key, suffix) =>
      `part://${key}.${Math.random().toString(36).slice(2)}.${suffix}.part`,
    fileExists: (uri) => files.has(uri),
    fileSize: (uri) => files.get(uri)?.bytes.length ?? 0,
    deleteFile: (uri) => void files.delete(uri),
    download,
    readHeader: (uri, length) => (files.get(uri)?.bytes ?? new Uint8Array()).subarray(0, length),
    decode,
    moveFile: (fromUri, toUri) => {
      const f = files.get(fromUri);
      if (!f) throw new Error("missing source");
      const key = toUri.replace("final://", "").replace(/\.(?:png|jpg)$/, "");
      files.set(toUri, { bytes: f.bytes, part: false, final: true, key });
      files.delete(fromUri);
    },
    hashUrl: (url) => url.replace(/[^a-z0-9]/gi, "").padEnd(64, "0").slice(0, 64).toLowerCase(),
  };
  return { backend, files, decode, decodeCalls, download, deleteLegacyNamespace };
}

function fakeStore() {
  const data = new Map<string, string>();
  const store: FrcCacheIndexStore = {
    getString: (key) => data.get(key),
    set: (key, value) => void data.set(key, value),
    delete: (key) => void data.delete(key),
  };
  return { store, data };
}

/**
 * The deferred reconciliation is driven by hand: production schedules it on a
 * timer, tests run it at a known point.
 */
function makeCache(backend: FrcCacheBackend, options: FrcImageCacheOptions = {}) {
  const scheduled: (() => void)[] = [];
  const cache = new FrcImageCache(backend, {
    scheduleReconcile: (run) => void scheduled.push(run),
    ...options,
  });
  return {
    cache,
    runDeferred: () => {
      for (const run of scheduled.splice(0)) run();
    },
  };
}

describe("FrcImageCache", () => {
  it("decodes, publishes atomically, and serves a cached hit next time", async () => {
    const { backend, decode, files } = fakeBackend();
    const { cache } = makeCache(backend);
    const first = await cache.resolve("https://x/a");
    expect(first.legacy).toBe(false);
    expect(first.uri.startsWith("final://")).toBe(true);
    // No .part files remain.
    expect([...files.values()].some((f) => f.part)).toBe(false);

    const second = await cache.resolve("https://x/a");
    expect(second.uri).toBe(first.uri);
    expect(decode).toHaveBeenCalledTimes(1); // served from cache, not re-decoded
  });

  it("keeps a fetched FRI alive between stages and through deferred reconciliation", async () => {
    const { backend, files } = fakeBackend();
    const { cache, runDeferred } = makeCache(backend);

    const fetched = await cache.fetch("https://x/staged", { bucket: MID_BUCKET });
    expect(fetched.kind).toBe("pending");
    if (fetched.kind !== "pending") throw new Error("expected pending FRI");
    expect(files.has(fetched.pending.uri)).toBe(true);

    // The stage gap may span a scroll gesture; maintenance must not mistake
    // the owned intermediate for a crash leftover.
    runDeferred();
    expect(files.has(fetched.pending.uri)).toBe(true);

    const decoded = await cache.decode(fetched.pending);
    expect(files.has(decoded.uri)).toBe(true);
    expect(files.has(fetched.pending.uri)).toBe(false);
    expect([...files.values()].some((file) => file.part)).toBe(false);
  });

  it("reports the downloaded size of the FRI it hands over", async () => {
    const friBytes = new Uint8Array(48 * 1024);
    friBytes.set(friHeader(9, 1080, 1440));
    const { backend } = fakeBackend({ friBytes: () => friBytes });
    const { cache } = makeCache(backend);

    const fetched = await cache.fetch("https://x/measured", { bucket: MID_BUCKET });
    if (fetched.kind !== "pending") throw new Error("expected pending FRI");

    // The composition layer times the download and needs its size; the cache
    // itself makes no use of the number.
    expect(fetched.pending.bytes).toBe(friBytes.length);
    cache.discardFetched(fetched.pending);
  });

  it("discards an unneeded fetched FRI idempotently", async () => {
    const { backend, files } = fakeBackend();
    const { cache } = makeCache(backend);
    const fetched = await cache.fetch("https://x/overflow");
    if (fetched.kind !== "pending") throw new Error("expected pending FRI");

    cache.discardFetched(fetched.pending);
    cache.discardFetched(fetched.pending);

    expect(files.has(fetched.pending.uri)).toBe(false);
    expect([...files.values()].some((file) => file.part)).toBe(false);
  });

  it("returns legacy fallback for non-FRC bytes without caching a file", async () => {
    const { backend } = fakeBackend({
      friBytes: () => new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
    });
    const { cache } = makeCache(backend);
    const res = await cache.resolve("https://x/legacy.jpg");
    expect(res).toEqual({ uri: "https://x/legacy.jpg", legacy: true });
    expect(cache.stats().entries).toBe(0);
  });

  it("keeps the directory untouched on init and sweeps stale parts only when deferred", () => {
    const { backend, files } = fakeBackend();
    files.set("part://orphan.fri.part", { bytes: new Uint8Array(3), part: true, final: false });
    const { cache, runDeferred } = makeCache(backend);
    cache.init();

    // First paint must not pay for a directory walk.
    expect(backend.listPartUris).not.toHaveBeenCalled();
    expect(backend.listFinalEntries).not.toHaveBeenCalled();
    expect(files.has("part://orphan.fri.part")).toBe(true);

    runDeferred();
    expect(files.has("part://orphan.fri.part")).toBe(false);
  });

  it("invalidates and re-decodes when the final file vanished", async () => {
    const { backend, files, decode } = fakeBackend();
    const { cache } = makeCache(backend);
    const first = await cache.resolve("https://x/a");
    files.delete(first.uri); // simulate external cache cleanup
    expect(cache.peek("https://x/a")).toBeUndefined(); // lazy invalidation, no directory walk
    expect(cache.stats().entries).toBe(0);
    const again = await cache.resolve("https://x/a");
    expect(again.uri.startsWith("final://")).toBe(true);
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it("evicts by LRU under the entry budget but never a leased entry", async () => {
    const { backend } = fakeBackend();
    const { cache } = makeCache(backend, { maxEntries: 2, maxBytes: 1 << 30 });
    await cache.resolve("https://x/a");
    cache.acquire("https://x/a"); // leased → protected
    await cache.resolve("https://x/b");
    await cache.resolve("https://x/c"); // exceeds maxEntries → evict LRU non-leased (b)

    expect(cache.stats().entries).toBe(2);
    expect(cache.peek("https://x/a")).toBeTruthy(); // leased survivor
    expect(cache.peek("https://x/b")).toBeUndefined(); // evicted
    expect(cache.peek("https://x/c")).toBeTruthy();
  });

  it("leases one variant without protecting the others", async () => {
    const { backend } = fakeBackend();
    const { cache } = makeCache(backend, { maxEntries: 2, maxBytes: 1 << 30 });
    await cache.resolve("https://x/a", { bucket: SMALL_BUCKET });
    await cache.resolve("https://x/a", { bucket: MID_BUCKET });
    cache.acquire("https://x/a", MID_BUCKET);
    await cache.resolve("https://x/b", { bucket: MID_BUCKET }); // evicts the unleased small variant

    expect(cache.peek("https://x/a", SMALL_BUCKET)).toBeUndefined();
    expect(cache.peek("https://x/a", MID_BUCKET)).toMatchObject({ exact: true });
  });

  it("never evicts the file a consumer has on screen, and evicts it once unpinned", async () => {
    const { backend, files } = fakeBackend();
    const { cache } = makeCache(backend, { maxEntries: 2, maxBytes: 1 << 30 });
    // The row is showing the smaller variant while its own bucket decodes, so
    // its (url, bucket) lease covers a different file than the one on screen.
    const shown = await cache.resolve("https://x/a", { bucket: SMALL_BUCKET });
    cache.pinFile(shown.uri);
    const requested = await cache.resolve("https://x/a", { bucket: MID_BUCKET });
    await cache.resolve("https://x/b", { bucket: MID_BUCKET }); // over the entry budget

    expect(files.has(shown.uri)).toBe(true); // on screen, and the LRU, and unleased
    expect(files.has(requested.uri)).toBe(false); // the unpinned LRU went instead
    expect(cache.stats().pinnedFiles).toBe(1);

    // Two rows can show one file; the first to leave must not unprotect it.
    cache.pinFile(shown.uri);
    cache.unpinFile(shown.uri);
    expect(cache.stats().pinnedFiles).toBe(1);

    cache.unpinFile(shown.uri);
    expect(cache.stats().pinnedFiles).toBe(0);
    await cache.resolve("https://x/c", { bucket: MID_BUCKET });
    expect(files.has(shown.uri)).toBe(false);
    expect(cache.peek("https://x/a", SMALL_BUCKET)).toBeUndefined();
  });

  it("aborts download via signal without publishing", async () => {
    const { backend } = fakeBackend();
    const { cache } = makeCache(backend);
    const controller = new AbortController();
    controller.abort();
    await expect(cache.resolve("https://x/a", { signal: controller.signal })).rejects.toThrow();
    expect(cache.stats().entries).toBe(0);
  });

  it("retries the fatal ensureReady() on the next resolve() after a startup failure", async () => {
    const { backend, download } = fakeBackend();
    let calls = 0;
    backend.ensureReady = vi.fn(() => {
      calls += 1;
      if (calls === 1) throw new Error("disk not mounted yet");
    });
    const { cache } = makeCache(backend);

    // Mirrors the real call site: init() is called once, in a try/catch, and
    // never retried by the caller.
    expect(() => cache.init()).toThrow("disk not mounted yet");

    await expect(cache.resolve("https://x/a")).resolves.toEqual(
      expect.objectContaining({ legacy: false }),
    );
    expect(backend.ensureReady).toHaveBeenCalledTimes(2); // 1 failed (init) + 1 succeeded (resolve)
    expect(download).toHaveBeenCalledTimes(1); // no download attempted while still fatally unready

    // Directory is ready now; a further resolve() must not call ensureReady() again.
    await cache.resolve("https://x/b");
    expect(backend.ensureReady).toHaveBeenCalledTimes(2);
  });

  it("treats a failed index restore as non-fatal and keeps the cache usable cold", async () => {
    const { backend } = fakeBackend();
    const { store } = fakeStore();
    store.getString = vi.fn(() => {
      throw new Error("mmkv read failed");
    });
    const { cache } = makeCache(backend, { index: store });

    expect(() => cache.init()).not.toThrow();
    expect(cache.stats().entries).toBe(0);

    const result = await cache.resolve("https://x/a");
    expect(result.legacy).toBe(false);
    expect(cache.stats().entries).toBe(1);
  });

  it("indexes legacy URLs so a synchronous peek() hits them after resolve()", async () => {
    const { backend } = fakeBackend({
      friBytes: () => new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
    });
    const { cache } = makeCache(backend);

    expect(cache.peek("https://x/legacy.jpg")).toBeUndefined();
    const result = await cache.resolve("https://x/legacy.jpg");
    expect(result).toEqual({ uri: "https://x/legacy.jpg", legacy: true });

    expect(cache.peek("https://x/legacy.jpg")).toEqual({
      uri: "https://x/legacy.jpg",
      exact: true,
    });
    // Legacy hits never occupy the byte/entry-budgeted main index.
    expect(cache.stats().entries).toBe(0);
    expect(cache.stats().legacyEntries).toBe(1);
  });

  it("keys entries by bucket, so two display sizes are independent", async () => {
    const { backend, decode } = fakeBackend();
    const { cache } = makeCache(backend);
    const small = await cache.resolve("https://x/a", { bucket: SMALL_BUCKET });
    const mid = await cache.resolve("https://x/a", { bucket: MID_BUCKET });

    expect(small.uri).toContain(`@${SMALL_BUCKET}.`);
    expect(mid.uri).toContain(`@${MID_BUCKET}.`);
    expect(small.uri).not.toBe(mid.uri);
    expect(decode).toHaveBeenCalledTimes(2);
    expect(cache.stats().entries).toBe(2);
    expect(cache.peek("https://x/a", SMALL_BUCKET)).toEqual({ uri: small.uri, exact: true });
    expect(cache.peek("https://x/a", MID_BUCKET)).toEqual({ uri: mid.uri, exact: true });
  });

  it("serves the largest smaller variant until the requested bucket is decoded", async () => {
    const { backend } = fakeBackend();
    const { cache } = makeCache(backend);
    const small = await cache.resolve("https://x/a", { bucket: SMALL_BUCKET });
    const mid = await cache.resolve("https://x/a", { bucket: MID_BUCKET });

    // The lightbox asks for full size and gets the best smaller variant to stretch.
    expect(cache.peek("https://x/a", FULL_BUCKET)).toEqual({ uri: mid.uri, exact: false });

    // Its file vanishing falls through to the next smaller one, not to a hole.
    backend.deleteFile(mid.uri);
    expect(cache.peek("https://x/a", FULL_BUCKET)).toEqual({ uri: small.uri, exact: false });

    // A bigger variant is never offered downwards: it would blow up row memory.
    const full = await cache.resolve("https://x/a", { bucket: FULL_BUCKET });
    expect(cache.peek("https://x/a", MID_BUCKET)).toEqual({ uri: small.uri, exact: false });
    expect(full.uri).toContain(`@${FULL_BUCKET}.`);
  });

  it("decodes at the bucket width, correcting for the source aspect ratio", async () => {
    const { backend, decodeCalls } = fakeBackend({ friBytes: () => friHeader(9, 1080, 1440) });
    const { cache } = makeCache(backend);

    await cache.resolve("https://x/a", { bucket: MID_BUCKET });
    // A portrait source scaled by its long side would land narrower than the
    // cell, so the long side is stretched by the aspect ratio.
    expect(decodeCalls[0].maxDimension).toBe(Math.ceil((MID_BUCKET * 1440) / 1080));
    expect(decodeCalls[0].quality).toBe(85);

    await cache.resolve("https://x/a", { bucket: FULL_BUCKET });
    // Top rung: never more than the source's own long side, and a quality that
    // does not add a visible second generation.
    expect(decodeCalls[1].maxDimension).toBe(1440);
    expect(decodeCalls[1].quality).toBe(95);
  });

  it("publishes a JPEG result under its own extension and rejects a mismatched container", async () => {
    const jpeg = fakeBackend({ outFormat: "jpeg" });
    const { cache } = makeCache(jpeg.backend);
    const result = await cache.resolve("https://x/a", { bucket: MID_BUCKET });
    expect(result.uri.endsWith(".jpg")).toBe(true);

    const lying = fakeBackend({ outFormat: "jpeg", outBytes: PNG_BYTES });
    const second = makeCache(lying.backend);
    await expect(second.cache.resolve("https://x/a")).rejects.toThrow(/jpeg/);
    expect(second.cache.stats().entries).toBe(0);
    expect([...lying.files.values()].some((f) => f.part)).toBe(false);
  });

  it("maps logical widths onto the ladder using the device pixel ratio", () => {
    const { backend } = fakeBackend();
    const { cache } = makeCache(backend, { pixelRatio: 3 });

    // 45 pt avatar, 180 pt collage cell, 360 pt full-width photo at 3×.
    expect(cache.bucketForWidth(45)).toBe(128);
    expect(cache.bucketForWidth(180)).toBe(512);
    expect(cache.bucketForWidth(360)).toBe(1024);
    // No width given (lightbox, unmeasured callers) → full size.
    expect(cache.bucketForWidth()).toBe(FULL_BUCKET);
    expect(cache.bucketForWidth(0)).toBe(FULL_BUCKET);
    // Anything wider than the ladder is full size too.
    expect(cache.bucketForWidth(4000)).toBe(FULL_BUCKET);

    const dense = makeCache(backend, { pixelRatio: 2 }).cache;
    expect(dense.bucketForWidth(45)).toBe(128);
    expect(dense.bucketForWidth(180)).toBe(384);
    expect(dense.bucketForWidth(360)).toBe(768);
  });

  it("restores the index from the store without walking the directory", async () => {
    const { store } = fakeStore();
    const first = fakeBackend();
    const warm = makeCache(first.backend, { index: store });
    const published = await warm.cache.resolve("https://x/a", { bucket: MID_BUCKET });
    warm.cache.flushIndex();

    // A new session over the same directory and the same store.
    const second = fakeBackend();
    second.files.set(published.uri, {
      bytes: new Uint8Array(PNG_BYTES.length),
      part: false,
      final: true,
      key: published.uri.replace("final://", "").replace(/\.(?:png|jpg)$/, ""),
    });
    const cold = makeCache(second.backend, { index: store });
    cold.cache.init();

    expect(second.backend.listFinalEntries).not.toHaveBeenCalled();
    expect(cold.cache.stats().entries).toBe(1);
    expect(cold.cache.peek("https://x/a", MID_BUCKET)).toEqual({
      uri: published.uri,
      exact: true,
    });
    expect(second.decode).not.toHaveBeenCalled();
  });

  it("drops ghost entries and deletes orphan files in the deferred reconciliation", async () => {
    const { store } = fakeStore();
    const first = fakeBackend();
    const warm = makeCache(first.backend, { index: store });
    const ghost = await warm.cache.resolve("https://x/gone", { bucket: MID_BUCKET });
    const kept = await warm.cache.resolve("https://x/kept", { bucket: MID_BUCKET });
    warm.cache.flushIndex();

    // New session: `kept` is still on disk, `ghost` is not, and an unknown
    // file from a lost index tail sits in the directory.
    const second = fakeBackend();
    second.files.set(kept.uri, {
      bytes: new Uint8Array(PNG_BYTES.length),
      part: false,
      final: true,
      key: kept.uri.replace("final://", "").replace(/\.(?:png|jpg)$/, ""),
    });
    second.files.set("final://orphan@512.png", {
      bytes: new Uint8Array(4),
      part: false,
      final: true,
      key: "orphan@512",
    });
    const cold = makeCache(second.backend, { index: store });
    cold.cache.init();
    expect(cold.cache.stats().entries).toBe(2); // the ghost is still believed in
    expect(second.files.has(ghost.uri)).toBe(false);

    cold.runDeferred();
    expect(cold.cache.stats().entries).toBe(1);
    expect(cold.cache.peek("https://x/gone", MID_BUCKET)).toBeUndefined();
    expect(cold.cache.peek("https://x/kept", MID_BUCKET)).toMatchObject({ exact: true });
    expect(second.files.has("final://orphan@512.png")).toBe(false);
    expect(second.files.has(kept.uri)).toBe(true);
    expect(cold.cache.stats().totalBytes).toBe(PNG_BYTES.length);
  });

  it("never sweeps the part file of a download that is still in flight", async () => {
    let releaseDownload = () => {};
    const pending = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const { backend, files } = fakeBackend({ gate: () => pending });
    const { cache, runDeferred } = makeCache(backend);

    const inFlight = cache.resolve("https://x/a");
    await Promise.resolve(); // let resolve() reach the gated download
    const streaming = [...files.keys()].filter((uri) => files.get(uri)?.part);
    expect(streaming).toHaveLength(1);

    files.set("part://stale.fri.part", { bytes: new Uint8Array(3), part: true, final: false });
    runDeferred(); // maintenance lands mid-download

    expect(files.has("part://stale.fri.part")).toBe(false); // crash leftovers go
    expect(files.has(streaming[0])).toBe(true); // live work stays

    releaseDownload();
    const result = await inFlight;
    expect(files.has(result.uri)).toBe(true);
  });

  it("wipes the frc-i-v1 directory exactly once across restarts", () => {
    const { store } = fakeStore();
    const first = fakeBackend();
    const warm = makeCache(first.backend, { index: store });
    warm.cache.init();
    expect(first.deleteLegacyNamespace).not.toHaveBeenCalled(); // not on the critical path
    warm.runDeferred();
    expect(first.deleteLegacyNamespace).toHaveBeenCalledTimes(1);

    const second = fakeBackend();
    const cold = makeCache(second.backend, { index: store });
    cold.cache.init();
    cold.runDeferred();
    expect(second.deleteLegacyNamespace).not.toHaveBeenCalled();
  });

  it("retries the frc-i-v1 wipe on the next start when it failed", () => {
    const { store } = fakeStore();
    const first = fakeBackend();
    first.deleteLegacyNamespace.mockImplementation(() => {
      throw new Error("directory busy");
    });
    const warm = makeCache(first.backend, { index: store });
    warm.cache.init();
    warm.runDeferred();
    expect(first.deleteLegacyNamespace).toHaveBeenCalledTimes(1);

    const second = fakeBackend();
    const cold = makeCache(second.backend, { index: store });
    cold.cache.init();
    cold.runDeferred();
    expect(second.deleteLegacyNamespace).toHaveBeenCalledTimes(1);
  });
});
