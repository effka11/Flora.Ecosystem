/**
 * Crash-safe, content-addressed FRC-I → PNG cache.
 *
 * The file protocol never treats a final cache path as a download or decode
 * destination: bytes stream into a unique `<hash>.<nonce>.fri.part`, decode
 * into `<hash>.<nonce>.png.part`, and are only published to the versioned
 * final path by an atomic move after a PNG signature check. On startup, stale
 * `.part` files (from a crash mid-download/decode) are swept.
 *
 * The core state machine (leases, LRU budget, invalidation on missing file)
 * is expressed against an injectable {@link FrcCacheBackend} so it can be
 * unit-tested without a device.
 */

// --- header sniffing (mirrors Products/FRC/crates/frc-i/src/format.rs) -------

export const FRC_HEADER_LEN = 20;
export const FRC_VERSION_MIN = 1;
export const FRC_VERSION_MAX = 7;
export const FRC_MAX_DIM = 32_768;
export const FRC_MAX_PIXELS = 1 << 26; // ~67 Mpx, matches DEFAULT_MAX_PIXELS
const FRC_MAGIC = [0x8f, 0x46, 0x52, 0x49] as const;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export type ImageSniffResult =
  | { kind: "frc-i"; version: number; width: number; height: number }
  | { kind: "legacy"; format: "jpeg" | "png" | "webp" }
  | { kind: "unknown" };

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

export function isPngSignature(bytes: Uint8Array): boolean {
  return startsWith(bytes, PNG_SIGNATURE);
}

/**
 * Classify an image by its leading bytes. FRC-I is accepted only when the
 * magic, version range and dimension/pixel limits all pass; JPEG/PNG/WebP are
 * legacy remote fallbacks; anything else is unknown (caller errors).
 */
export function sniffImageHeader(header: Uint8Array): ImageSniffResult {
  if (startsWith(header, FRC_MAGIC)) {
    if (header.length < FRC_HEADER_LEN) return { kind: "unknown" };
    const version = header[4];
    if (version < FRC_VERSION_MIN || version > FRC_VERSION_MAX) return { kind: "unknown" };
    const width = header[6] | (header[7] << 8) | (header[8] << 16) | (header[9] << 24);
    const height = header[10] | (header[11] << 8) | (header[12] << 16) | (header[13] << 24);
    if (width <= 0 || height <= 0 || width > FRC_MAX_DIM || height > FRC_MAX_DIM) {
      return { kind: "unknown" };
    }
    if (width * height > FRC_MAX_PIXELS) return { kind: "unknown" };
    return { kind: "frc-i", version, width, height };
  }
  if (startsWith(header, [0xff, 0xd8, 0xff])) return { kind: "legacy", format: "jpeg" };
  if (startsWith(header, PNG_SIGNATURE)) return { kind: "legacy", format: "png" };
  if (
    startsWith(header, [0x52, 0x49, 0x46, 0x46]) &&
    header.length >= 12 &&
    header[8] === 0x57 &&
    header[9] === 0x45 &&
    header[10] === 0x42 &&
    header[11] === 0x50
  ) {
    return { kind: "legacy", format: "webp" };
  }
  return { kind: "unknown" };
}

// --- injectable backend ------------------------------------------------------

export type FrcCacheEntryRecord = { hash: string; uri: string; size: number };

export interface FrcCacheBackend {
  ensureReady(): void;
  /** Existing valid final files as {hash, uri, size}. */
  listFinalEntries(): FrcCacheEntryRecord[];
  /** Remove leftover `*.part` files from a prior crash. */
  deleteStaleParts(): void;
  finalUri(hash: string): string;
  tempPartUri(hash: string, suffix: "fri" | "png"): string;
  fileExists(uri: string): boolean;
  fileSize(uri: string): number;
  deleteFile(uri: string): void;
  /** Download into `destUri` (a `.part`), sending the FRC-I Accept header. */
  download(url: string, destUri: string, signal?: AbortSignal): Promise<void>;
  /** First `length` bytes of a file without loading the whole thing. */
  readHeader(uri: string, length: number): Uint8Array;
  /** Native FRC-I → PNG decode (uncancellable). */
  decode(friUri: string, pngDestUri: string): Promise<void>;
  /** Atomic publish (rename within the cache directory). */
  moveFile(fromUri: string, toUri: string): void;
  hashUrl(url: string): string;
}

export type FrcResolveResult = {
  uri: string;
  /** True when the URL is a legacy (non-FRC) image served directly. */
  legacy: boolean;
};

export type FrcImageCacheOptions = {
  maxBytes?: number;
  maxEntries?: number;
};

const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 256;

type CacheEntry = { uri: string; size: number; lastUsed: number };

export class FrcImageCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly leases = new Map<string, number>();
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private totalBytes = 0;
  private tick = 0;
  private initialized = false;

  constructor(
    private readonly backend: FrcCacheBackend,
    options: FrcImageCacheOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.backend.ensureReady();
    this.backend.deleteStaleParts();
    for (const record of this.backend.listFinalEntries()) {
      this.entries.set(record.hash, { uri: record.uri, size: record.size, lastUsed: ++this.tick });
      this.totalBytes += record.size;
    }
    this.enforceBudget();
  }

  acquire(url: string): void {
    const hash = this.backend.hashUrl(url);
    this.leases.set(hash, (this.leases.get(hash) ?? 0) + 1);
  }

  release(url: string): void {
    const hash = this.backend.hashUrl(url);
    const next = (this.leases.get(hash) ?? 0) - 1;
    if (next <= 0) this.leases.delete(hash);
    else this.leases.set(hash, next);
  }

  /** Synchronous cache hit for a still-present final file, or undefined. */
  peek(url: string): string | undefined {
    const hash = this.backend.hashUrl(url);
    const entry = this.entries.get(hash);
    if (!entry) return undefined;
    if (!this.backend.fileExists(entry.uri)) {
      this.invalidate(hash);
      return undefined;
    }
    entry.lastUsed = ++this.tick;
    return entry.uri;
  }

  async resolve(
    url: string,
    options: { signal?: AbortSignal; onBeforeDecode?: () => void } = {},
  ): Promise<FrcResolveResult> {
    const { signal, onBeforeDecode } = options;
    const hash = this.backend.hashUrl(url);
    const existing = this.entries.get(hash);
    if (existing) {
      if (this.backend.fileExists(existing.uri)) {
        existing.lastUsed = ++this.tick;
        return { uri: existing.uri, legacy: false };
      }
      this.invalidate(hash);
    }

    const friPart = this.backend.tempPartUri(hash, "fri");
    try {
      await this.backend.download(url, friPart, signal);
      const header = this.backend.readHeader(friPart, FRC_HEADER_LEN);
      const sniff = sniffImageHeader(header);
      if (sniff.kind === "legacy") {
        // Stale cache may still hold pre-FRI bytes; expo-image reads these directly.
        return { uri: url, legacy: true };
      }
      if (sniff.kind !== "frc-i") {
        throw new Error("Сервер отдал не-FRI изображение");
      }

      const pngPart = this.backend.tempPartUri(hash, "png");
      try {
        // Native decode is uncancellable; signal that before starting it.
        onBeforeDecode?.();
        await this.backend.decode(friPart, pngPart);
        const pngHeader = this.backend.readHeader(pngPart, PNG_SIGNATURE.length);
        if (!isPngSignature(pngHeader)) {
          throw new Error("Декодер вернул не-PNG");
        }
        const finalUri = this.backend.finalUri(hash);
        if (this.backend.fileExists(finalUri)) this.backend.deleteFile(finalUri);
        this.backend.moveFile(pngPart, finalUri);
        const size = this.backend.fileSize(finalUri);
        this.entries.set(hash, { uri: finalUri, size, lastUsed: ++this.tick });
        this.totalBytes += size;
        this.enforceBudget();
        return { uri: finalUri, legacy: false };
      } finally {
        if (this.backend.fileExists(pngPart)) this.backend.deleteFile(pngPart);
      }
    } finally {
      if (this.backend.fileExists(friPart)) this.backend.deleteFile(friPart);
    }
  }

  stats() {
    return {
      entries: this.entries.size,
      totalBytes: this.totalBytes,
      leases: this.leases.size,
      maxBytes: this.maxBytes,
      maxEntries: this.maxEntries,
    };
  }

  private invalidate(hash: string): void {
    const entry = this.entries.get(hash);
    if (!entry) return;
    this.entries.delete(hash);
    this.totalBytes -= entry.size;
  }

  private enforceBudget(): void {
    while (this.totalBytes > this.maxBytes || this.entries.size > this.maxEntries) {
      let victimHash: string | null = null;
      let victimUsed = Infinity;
      for (const [hash, entry] of this.entries) {
        if ((this.leases.get(hash) ?? 0) > 0) continue;
        if (entry.lastUsed < victimUsed) {
          victimUsed = entry.lastUsed;
          victimHash = hash;
        }
      }
      if (victimHash === null) break; // everything remaining is leased
      const victim = this.entries.get(victimHash)!;
      this.entries.delete(victimHash);
      this.totalBytes -= victim.size;
      try {
        this.backend.deleteFile(victim.uri);
      } catch {
        // File may already be gone; the JS index is authoritative.
      }
    }
  }
}
