import { describe, expect, it, vi } from "vitest";
import {
  FRC_HEADER_LEN,
  FrcImageCache,
  isPngSignature,
  sniffImageHeader,
  type FrcCacheBackend,
  type FrcCacheEntryRecord,
} from "./frcImageCache";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

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
});

type FakeFile = { bytes: Uint8Array; part: boolean; final: boolean; hash?: string };

function fakeBackend(config?: {
  friBytes?: (url: string) => Uint8Array;
  pngSize?: number;
  onDownload?: (url: string) => void;
}) {
  const files = new Map<string, FakeFile>();
  const decode = vi.fn(async (friUri: string, pngUri: string) => {
    const bytes = new Uint8Array(config?.pngSize ?? PNG_BYTES.length);
    bytes.set(PNG_BYTES.subarray(0, Math.min(PNG_BYTES.length, bytes.length)));
    files.set(pngUri, { bytes, part: true, final: false });
  });
  const download = vi.fn(async (url: string, destUri: string, signal?: AbortSignal) => {
    if (signal?.aborted) throw new Error("aborted");
    config?.onDownload?.(url);
    const bytes = config?.friBytes ? config.friBytes(url) : friHeader(7, 64, 64);
    files.set(destUri, { bytes, part: true, final: false });
  });

  const backend: FrcCacheBackend = {
    ensureReady: vi.fn(),
    listFinalEntries() {
      const out: FrcCacheEntryRecord[] = [];
      for (const [uri, f] of files) {
        if (f.final && f.hash) out.push({ hash: f.hash, uri, size: f.bytes.length });
      }
      return out;
    },
    deleteStaleParts() {
      for (const [uri, f] of files) if (f.part) files.delete(uri);
    },
    finalUri: (hash) => `final://${hash}.png`,
    tempPartUri: (hash, suffix) => `part://${hash}.${Math.random().toString(36).slice(2)}.${suffix}.part`,
    fileExists: (uri) => files.has(uri),
    fileSize: (uri) => files.get(uri)?.bytes.length ?? 0,
    deleteFile: (uri) => void files.delete(uri),
    download,
    readHeader: (uri, length) => (files.get(uri)?.bytes ?? new Uint8Array()).subarray(0, length),
    decode,
    moveFile: (fromUri, toUri) => {
      const f = files.get(fromUri);
      if (!f) throw new Error("missing source");
      const hash = toUri.replace("final://", "").replace(".png", "");
      files.set(toUri, { bytes: f.bytes, part: false, final: true, hash });
      files.delete(fromUri);
    },
    hashUrl: (url) => url.replace(/[^a-z0-9]/gi, "").padEnd(64, "0").slice(0, 64).toLowerCase(),
  };
  return { backend, files, decode, download };
}

describe("FrcImageCache", () => {
  it("decodes, publishes atomically, and serves a cached hit next time", async () => {
    const { backend, decode, files } = fakeBackend();
    const cache = new FrcImageCache(backend);
    const first = await cache.resolve("https://x/a");
    expect(first.legacy).toBe(false);
    expect(first.uri.startsWith("final://")).toBe(true);
    // No .part files remain.
    expect([...files.values()].some((f) => f.part)).toBe(false);

    const second = await cache.resolve("https://x/a");
    expect(second.uri).toBe(first.uri);
    expect(decode).toHaveBeenCalledTimes(1); // served from cache, not re-decoded
  });

  it("returns legacy fallback for non-FRC bytes without caching a file", async () => {
    const { backend } = fakeBackend({
      friBytes: () => new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
    });
    const cache = new FrcImageCache(backend);
    const res = await cache.resolve("https://x/legacy.jpg");
    expect(res).toEqual({ uri: "https://x/legacy.jpg", legacy: true });
    expect(cache.stats().entries).toBe(0);
  });

  it("sweeps stale parts and rebuilds ready entries on init", () => {
    const { backend, files } = fakeBackend();
    files.set("part://orphan.fri.part", { bytes: new Uint8Array(3), part: true, final: false });
    files.set("final://deadbeef.png", { bytes: new Uint8Array(10), part: false, final: true, hash: "deadbeef" });
    const cache = new FrcImageCache(backend);
    cache.init();
    expect(files.has("part://orphan.fri.part")).toBe(false);
    expect(cache.stats().entries).toBe(1);
  });

  it("invalidates and re-decodes when the final file vanished", async () => {
    const { backend, files, decode } = fakeBackend();
    const cache = new FrcImageCache(backend);
    const first = await cache.resolve("https://x/a");
    files.delete(first.uri); // simulate external cache cleanup
    const again = await cache.resolve("https://x/a");
    expect(again.uri.startsWith("final://")).toBe(true);
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it("evicts by LRU under the entry budget but never a leased entry", async () => {
    const { backend } = fakeBackend();
    const cache = new FrcImageCache(backend, { maxEntries: 2, maxBytes: 1 << 30 });
    await cache.resolve("https://x/a");
    cache.acquire("https://x/a"); // leased → protected
    await cache.resolve("https://x/b");
    await cache.resolve("https://x/c"); // exceeds maxEntries → evict LRU non-leased (b)

    expect(cache.stats().entries).toBe(2);
    expect(cache.peek("https://x/a")).toBeTruthy(); // leased survivor
    expect(cache.peek("https://x/b")).toBeUndefined(); // evicted
    expect(cache.peek("https://x/c")).toBeTruthy();
  });

  it("aborts download via signal without publishing", async () => {
    const { backend } = fakeBackend();
    const cache = new FrcImageCache(backend);
    const controller = new AbortController();
    controller.abort();
    await expect(cache.resolve("https://x/a", { signal: controller.signal })).rejects.toThrow();
    expect(cache.stats().entries).toBe(0);
  });
});
