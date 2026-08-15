import { FRC_I_BITSTREAM_VERSION } from "@flora/client-core/frc-i";

/**
 * Crash-safe, content-addressed FRC-I → display-sized image cache.
 *
 * A cache entry is a (URL, bucket) pair: the same photo decoded for an avatar
 * and for a full-width cell are two independent files. Decoding at the size
 * that is actually on screen is what makes the budget below hold thousands of
 * images instead of the few dozen full-size PNGs that used to fit.
 *
 * The file protocol never treats a final cache path as a download or decode
 * destination: bytes stream into a unique `<key>.<nonce>.fri.part`, decode
 * into `<key>.<nonce>.out.part`, and are only published to the final path by
 * an atomic move once the written signature matches the format the decoder
 * reported.
 *
 * The index is persisted through an injectable {@link FrcCacheIndexStore} and
 * restored without touching the directory, so a first paint costs one store
 * read instead of a stat per cached file. Drift between index and directory is
 * repaired lazily in `peek()` and, once per session, by `reconcile()` off the
 * critical path.
 *
 * The core state machine (leases and on-screen pins, LRU budget, invalidation
 * on missing file) is expressed against an injectable {@link FrcCacheBackend}
 * so it can be unit-tested without a device.
 */

// --- header sniffing (mirrors Products/FRC/crates/frc-i/src/format.rs) -------

export const FRC_HEADER_LEN = 20;
export const FRC_VERSION_MIN = 1;
/** Mirrors `frc_i::format::VERSION_MAX` via the TS gate (v11 hierarchical AQ). */
export const FRC_VERSION_MAX = FRC_I_BITSTREAM_VERSION;
export const FRC_MAX_DIM = 32_768;
export const FRC_MAX_PIXELS = 1 << 26; // ~67 Mpx, matches DEFAULT_MAX_PIXELS
const FRC_MAGIC = [0x8f, 0x46, 0x52, 0x49] as const;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;

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

export function isJpegSignature(bytes: Uint8Array): boolean {
  return startsWith(bytes, JPEG_SIGNATURE);
}

/** The decoder picks the container per image (alpha → PNG), so both are valid results. */
export function matchesDecodedFormat(bytes: Uint8Array, format: FrcDecodedFormat): boolean {
  return format === "png" ? isPngSignature(bytes) : isJpegSignature(bytes);
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
  if (startsWith(header, JPEG_SIGNATURE)) return { kind: "legacy", format: "jpeg" };
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

// --- decode buckets ----------------------------------------------------------

/**
 * Decode widths in **device pixels**, ascending. A display width is served by
 * the narrowest rung that covers it; the last rung is the ingest cap (a
 * source is never wider than 2048 px), so asking for it means "full size" and
 * the decoder — which only ever scales down — writes the image untouched.
 *
 * Rungs are ~1.3–2× apart, which keeps the number of variants per image small
 * while the tolerance below makes the common cell widths land on a rung
 * instead of one step above it. Callers never see these numbers: they pass a
 * logical width and get an opaque bucket from {@link FrcImageCache.bucketForWidth}.
 */
export const FRC_BUCKET_WIDTHS = [128, 256, 384, 512, 768, 1024, 2048] as const;

const FULL_BUCKET = FRC_BUCKET_WIDTHS[FRC_BUCKET_WIDTHS.length - 1];

/**
 * A rung up to 8% narrower than the display width still serves it. Without
 * this the 3× densities (45 pt avatar → 135 px, 180 pt collage cell → 540 px,
 * 360 pt photo → 1080 px) would each miss their rung by ~5% and jump to the
 * next one, paying twice the pixels for an upscale nobody can see on a photo.
 */
const BUCKET_UPSCALE_TOLERANCE = 1.08;

/**
 * Scaled variants re-encode at the ingest quality: the downscale low-passes
 * away most of FRI's coding noise, so a second lossy generation costs nothing
 * visible. The full-size rung keeps every artifact 1:1 and re-quantises it,
 * which is exactly where generation loss shows — it pays ~2× the bytes for a
 * visually lossless q95, and it is also the rarest rung (lightbox only).
 */
function qualityForBucket(bucket: number): number {
  return bucket >= FULL_BUCKET ? 95 : 85;
}

/**
 * The native decoder fits an image into a `max × max` box, so scaling a
 * portrait source by its long side would land it narrower than the cell. A
 * bucket is a *width*, hence the aspect correction; the result is clamped to
 * the source's own long side to keep the number honest (the decoder never
 * upscales anyway).
 */
function maxDimensionForBucket(bucket: number, source: { width: number; height: number }): number {
  const longSide = Math.max(source.width, source.height);
  if (source.width <= 0 || source.height <= 0) return longSide;
  const scaled = Math.ceil(bucket * Math.max(1, source.height / source.width));
  return Math.max(1, Math.min(scaled, longSide));
}

// --- injectable backend ------------------------------------------------------

export type FrcDecodedFormat = "jpeg" | "png";

export type FrcCacheEntryRecord = { key: string; uri: string; size: number };

export interface FrcCacheBackend {
  ensureReady(): void;
  /** Final files as `{key, uri, size}`. Walks the directory — deferred maintenance only. */
  listFinalEntries(): FrcCacheEntryRecord[];
  /** Leftover `*.part` files from a crash mid-download/decode. Walks the directory. */
  listPartUris(): string[];
  /** Drop the pre-bucket `frc-i-v1` directory and everything in it. */
  deleteLegacyNamespace(): void;
  finalUri(key: string, format: FrcDecodedFormat): string;
  tempPartUri(key: string, suffix: "fri" | "out"): string;
  fileExists(uri: string): boolean;
  fileSize(uri: string): number;
  deleteFile(uri: string): void;
  /** Download into `destUri` (a `.part`), sending the FRC-I Accept header. */
  download(url: string, destUri: string, signal?: AbortSignal): Promise<void>;
  /** First `length` bytes of a file without loading the whole thing. */
  readHeader(uri: string, length: number): Uint8Array;
  /**
   * Native FRC-I decode scaled to `maxDimension` px on the long side
   * (uncancellable). Returns the container it actually wrote.
   */
  decode(
    friUri: string,
    destUri: string,
    maxDimension: number,
    quality: number,
  ): Promise<FrcDecodedFormat>;
  /** Atomic publish (rename within the cache directory). */
  moveFile(fromUri: string, toUri: string): void;
  hashUrl(url: string): string;
}

/** Synchronous key–value storage for the persisted index (MMKV's shape). */
export interface FrcCacheIndexStore {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export type FrcResolveResult = {
  uri: string;
  /** True when the URL is a legacy (non-FRC) image served directly. */
  legacy: boolean;
};

/** Downloaded FRI owned by the cache until `decode()` or `discardFetched()`. */
export type FrcPendingDecode = {
  readonly url: string;
  readonly bucket: number;
  readonly hash: string;
  readonly key: string;
  readonly uri: string;
  readonly width: number;
  readonly height: number;
  /**
   * Size of the downloaded `.fri`. The cache has no use for it; it is reported
   * here so the composition layer can measure throughput without the core
   * having to know that bandwidth estimation exists.
   */
  readonly bytes: number;
};

export type FrcFetchResult =
  | { kind: "resolved"; result: FrcResolveResult }
  | { kind: "pending"; pending: FrcPendingDecode };

export type FrcPeekResult = {
  uri: string;
  /**
   * True when this is the requested bucket (or a legacy passthrough) and
   * nothing better can be decoded; false for a smaller variant standing in
   * until the requested one is ready.
   */
  exact: boolean;
};

export type FrcImageCacheOptions = {
  maxBytes?: number;
  maxEntries?: number;
  /** Persisted index; omitted → the index lives for this session only. */
  index?: FrcCacheIndexStore;
  /** Device pixels per logical point; maps a display width onto the bucket ladder. */
  pixelRatio?: number;
  /** Runs {@link FrcImageCache.reconcile} off the critical path; tests drive it by hand. */
  scheduleReconcile?: (run: () => void) => void;
};

/**
 * ~200 KB per display-sized entry, so the byte budget stops being the binding
 * constraint and `maxEntries` becomes the real ceiling. Half a gigabyte of
 * phone cache would buy nothing here — Android reclaims `Paths.cache` under
 * pressure long before that.
 */
const DEFAULT_MAX_BYTES = 192 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 2000;
/**
 * Legacy hits only record a hash (no file, no size), so the memory cost per
 * entry is negligible; a separate cap still bounds growth without hurting
 * `peek()` hit rate for this fallback path.
 */
const DEFAULT_MAX_LEGACY_ENTRIES = 512;

const INDEX_STORE_KEY = "frc-i-cache.index.v2";
const LEGACY_PURGED_STORE_KEY = "frc-i-cache.legacy-v1-purged";
/** Writes coalesce: a lost tail becomes orphan files, which `reconcile()` collects. */
const INDEX_FLUSH_EVERY = 8;
const RECONCILE_DELAY_MS = 5000;

type CacheEntry = { uri: string; size: number; format: FrcDecodedFormat; lastUsed: number };

/**
 * `[key, "j" | "p", size]`, oldest first — array order restores the LRU. The
 * URI is rebuilt from the backend instead of being stored: the sandbox path
 * can change between launches (iOS container UUID), the key cannot.
 */
type PersistedEntry = [string, string, number];

function entryKey(hash: string, bucket: number): string {
  return `${hash}@${bucket}`;
}

export class FrcImageCache {
  private readonly entries = new Map<string, CacheEntry>();
  /** Hashes of URLs sniffed as legacy (non-FRC) images, so `peek()` can hit them too. */
  private readonly legacyHashes = new Map<string, number>();
  private readonly leases = new Map<string, number>();
  /** Files a consumer has on screen right now, by file URI (see {@link pinFile}). */
  private readonly pins = new Map<string, number>();
  /** `.part` files of running downloads/decodes, protected from the stale sweep. */
  private readonly inFlightParts = new Set<string>();
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly maxLegacyEntries: number;
  private readonly index: FrcCacheIndexStore | null;
  private readonly pixelRatio: number;
  private readonly scheduleReconcile: (run: () => void) => void;
  private totalBytes = 0;
  private tick = 0;
  private initialized = false;
  private reconciled = false;
  private legacyNamespacePurged = false;
  private indexDirty = false;
  private pendingIndexWrites = 0;

  constructor(
    private readonly backend: FrcCacheBackend,
    options: FrcImageCacheOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxLegacyEntries = DEFAULT_MAX_LEGACY_ENTRIES;
    this.index = options.index ?? null;
    this.pixelRatio = options.pixelRatio && options.pixelRatio > 0 ? options.pixelRatio : 1;
    this.scheduleReconcile =
      options.scheduleReconcile ??
      ((run) => {
        setTimeout(run, RECONCILE_DELAY_MS);
      });
  }

  init(): void {
    this.ensureInitialized();
  }

  /**
   * Fatal (directory creation) vs. best-effort (index restore) are deliberately
   * split: `initialized` is only set once `ensureReady()` has actually
   * succeeded, and only that failure re-throws. A failed restore leaves the
   * cache cold (empty index) but usable. Called from both the public `init()`
   * and from `resolve()` — the latter is what lets a single startup failure
   * heal on the next resolve instead of disabling the cache for the rest of
   * the session, since callers only invoke `init()` once.
   *
   * Nothing here walks the directory: this sits on the first-paint path, and
   * a stat per cached file is exactly what the persisted index replaces.
   */
  private ensureInitialized(): void {
    if (this.initialized) return;
    this.backend.ensureReady();
    this.initialized = true;
    try {
      this.restoreIndex();
    } catch {
      // Best-effort restore; unlike ensureReady() above, this must not undo
      // `initialized` or block resolve() from serving cache misses.
    }
    this.scheduleReconcile(() => {
      this.reconcile();
    });
  }

  /**
   * Bucket for a logical display width, in device pixels. `undefined` (a
   * caller that does not know or care how wide it draws) means full size.
   */
  bucketForWidth(displayWidth?: number): number {
    if (displayWidth === undefined || !(displayWidth > 0)) return FULL_BUCKET;
    const needed = displayWidth * this.pixelRatio;
    for (const rung of FRC_BUCKET_WIDTHS) {
      if (rung * BUCKET_UPSCALE_TOLERANCE >= needed) return rung;
    }
    return FULL_BUCKET;
  }

  acquire(url: string, bucket: number = FULL_BUCKET): void {
    const key = entryKey(this.backend.hashUrl(url), bucket);
    this.leases.set(key, (this.leases.get(key) ?? 0) + 1);
  }

  release(url: string, bucket: number = FULL_BUCKET): void {
    const key = entryKey(this.backend.hashUrl(url), bucket);
    const next = (this.leases.get(key) ?? 0) - 1;
    if (next <= 0) this.leases.delete(key);
    else this.leases.set(key, next);
  }

  /**
   * Protect the file that is on screen *right now*, whichever variant it is.
   * A lease covers the variant a consumer asked for; a consumer that fell back
   * to a smaller variant is displaying a file no lease of its own covers, and
   * eviction must not delete it out from under the image view. Keyed by file
   * URI because that is all the displaying side knows.
   */
  pinFile(uri: string): void {
    this.pins.set(uri, (this.pins.get(uri) ?? 0) + 1);
  }

  unpinFile(uri: string): void {
    const next = (this.pins.get(uri) ?? 0) - 1;
    if (next <= 0) this.pins.delete(uri);
    else this.pins.set(uri, next);
  }

  /**
   * Synchronous cache hit: the requested variant, a URL previously sniffed as
   * legacy (served directly, no local file), or — as a stopgap — the largest
   * smaller variant of the same URL, which the caller can stretch while the
   * requested one decodes. No directory scans happen here; this sits on the
   * first-paint critical path.
   */
  peek(url: string, bucket: number = FULL_BUCKET): FrcPeekResult | undefined {
    const hash = this.backend.hashUrl(url);
    const exact = this.hit(entryKey(hash, bucket));
    if (exact) return { uri: exact, exact: true };
    if (this.legacyHashes.has(hash)) {
      this.legacyHashes.set(hash, ++this.tick);
      return { uri: url, exact: true };
    }
    for (let i = FRC_BUCKET_WIDTHS.length - 1; i >= 0; i -= 1) {
      const rung = FRC_BUCKET_WIDTHS[i];
      if (rung >= bucket) continue;
      const smaller = this.hit(entryKey(hash, rung));
      if (smaller) return { uri: smaller, exact: false };
    }
    return undefined;
  }

  /**
   * Download/sniff stage. A returned pending FRI remains protected from the
   * deferred stale-part sweep until it is decoded or explicitly discarded.
   */
  async fetch(
    url: string,
    options: { signal?: AbortSignal; bucket?: number } = {},
  ): Promise<FrcFetchResult> {
    this.ensureInitialized();
    const { signal, bucket = FULL_BUCKET } = options;
    const hash = this.backend.hashUrl(url);
    const key = entryKey(hash, bucket);
    const existing = this.hit(key);
    if (existing) {
      return { kind: "resolved", result: { uri: existing, legacy: false } };
    }
    if (this.legacyHashes.has(hash)) {
      this.legacyHashes.set(hash, ++this.tick);
      return { kind: "resolved", result: { uri: url, legacy: true } };
    }

    const friPart = this.backend.tempPartUri(key, "fri");
    this.inFlightParts.add(friPart);
    let retainedForDecode = false;
    try {
      await this.backend.download(url, friPart, signal);
      const header = this.backend.readHeader(friPart, FRC_HEADER_LEN);
      const sniff = sniffImageHeader(header);
      if (sniff.kind === "legacy") {
        // Stale cache may still hold pre-FRI bytes; expo-image reads these directly.
        this.rememberLegacy(hash);
        return { kind: "resolved", result: { uri: url, legacy: true } };
      }
      if (sniff.kind !== "frc-i") {
        throw new Error("Сервер отдал не-FRI изображение");
      }

      retainedForDecode = true;
      return {
        kind: "pending",
        pending: {
          url,
          bucket,
          hash,
          key,
          uri: friPart,
          width: sniff.width,
          height: sniff.height,
          bytes: this.backend.fileSize(friPart),
        },
      };
    } finally {
      if (!retainedForDecode) {
        this.inFlightParts.delete(friPart);
        if (this.backend.fileExists(friPart)) this.backend.deleteFile(friPart);
      }
    }
  }

  /** Native decode/publish stage. It always consumes the pending FRI. */
  async decode(
    pending: FrcPendingDecode,
    options: { onBeforeDecode?: () => void } = {},
  ): Promise<FrcResolveResult> {
    this.ensureInitialized();
    try {
      const existing = this.hit(pending.key);
      if (existing) return { uri: existing, legacy: false };

      const outPart = this.backend.tempPartUri(pending.key, "out");
      this.inFlightParts.add(outPart);
      try {
        // Native decode is uncancellable; signal that before starting it.
        options.onBeforeDecode?.();
        const format = await this.backend.decode(
          pending.uri,
          outPart,
          maxDimensionForBucket(pending.bucket, pending),
          qualityForBucket(pending.bucket),
        );
        const written = this.backend.readHeader(outPart, PNG_SIGNATURE.length);
        if (!matchesDecodedFormat(written, format)) {
          throw new Error(`Декодер вернул не ${format}`);
        }
        const finalUri = this.backend.finalUri(pending.key, format);
        if (this.backend.fileExists(finalUri)) this.backend.deleteFile(finalUri);
        this.backend.moveFile(outPart, finalUri);
        this.put(pending.key, {
          uri: finalUri,
          size: this.backend.fileSize(finalUri),
          format,
          lastUsed: ++this.tick,
        });
        // A URL can't be both a decoded entry and a legacy fallback.
        this.legacyHashes.delete(pending.hash);
        this.enforceBudget();
        return { uri: finalUri, legacy: false };
      } finally {
        this.inFlightParts.delete(outPart);
        if (this.backend.fileExists(outPart)) this.backend.deleteFile(outPart);
      }
    } finally {
      this.discardFetched(pending);
    }
  }

  /** Release a downloaded FRI that will not enter the decode stage. Idempotent. */
  discardFetched(pending: FrcPendingDecode): void {
    this.inFlightParts.delete(pending.uri);
    try {
      if (this.backend.fileExists(pending.uri)) this.backend.deleteFile(pending.uri);
    } catch {
      // Cache cleanup is best-effort; reconciliation retries any survivor.
    }
  }

  /** Convenience path for non-pipelined callers and cache unit tests. */
  async resolve(
    url: string,
    options: { signal?: AbortSignal; onBeforeDecode?: () => void; bucket?: number } = {},
  ): Promise<FrcResolveResult> {
    const fetched = await this.fetch(url, options);
    if (fetched.kind === "resolved") return fetched.result;
    return this.decode(fetched.pending, { onBeforeDecode: options.onBeforeDecode });
  }

  /**
   * Deferred maintenance, once per session and never on the first-paint path:
   * the one-time `frc-i-v1` wipe, the stale `.part` sweep, and the full
   * index ↔ directory reconciliation (index entries whose file is gone, files
   * no index entry claims). Synchronous on purpose — a `resolve()` publishes
   * its entry between two statements with no `await` in between, so nothing
   * can interleave and be mistaken for an orphan.
   */
  reconcile(): void {
    if (this.reconciled) return;
    try {
      this.ensureInitialized();
    } catch {
      return; // directory still unavailable; stays pending, resolve() retries it
    }
    this.reconciled = true;
    this.purgeLegacyNamespace();
    this.sweepStaleParts();
    this.reconcileIndexWithDirectory();
    this.flushIndex();
  }

  /** Persist the index now; mutations otherwise coalesce (see INDEX_FLUSH_EVERY). */
  flushIndex(): void {
    if (!this.index || !this.indexDirty) return;
    const ordered = [...this.entries].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const payload: PersistedEntry[] = ordered.map(([key, entry]) => [
      key,
      entry.format === "png" ? "p" : "j",
      entry.size,
    ]);
    try {
      this.index.set(INDEX_STORE_KEY, JSON.stringify(payload));
      this.indexDirty = false;
      this.pendingIndexWrites = 0;
    } catch {
      // Storage full or unavailable: the in-memory index still works, and the
      // directory reconciliation will collect whatever this run leaves behind.
    }
  }

  stats() {
    return {
      entries: this.entries.size,
      legacyEntries: this.legacyHashes.size,
      totalBytes: this.totalBytes,
      leases: this.leases.size,
      pinnedFiles: this.pins.size,
      maxBytes: this.maxBytes,
      maxEntries: this.maxEntries,
    };
  }

  /** Touch and verify a key; drops the entry when its file is gone (lazy repair). */
  private hit(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.backend.fileExists(entry.uri)) {
      entry.lastUsed = ++this.tick;
      return entry.uri;
    }
    this.invalidate(key);
    return undefined;
  }

  private put(key: string, entry: CacheEntry): void {
    this.invalidate(key);
    this.entries.set(key, entry);
    this.totalBytes += entry.size;
    this.markIndexDirty();
  }

  private invalidate(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalBytes -= entry.size;
    this.markIndexDirty();
  }

  private markIndexDirty(): void {
    this.indexDirty = true;
    this.pendingIndexWrites += 1;
    if (this.pendingIndexWrites >= INDEX_FLUSH_EVERY) this.flushIndex();
  }

  private restoreIndex(): void {
    const raw = this.index?.getString(INDEX_STORE_KEY);
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.index?.delete(INDEX_STORE_KEY);
      return;
    }
    if (!Array.isArray(parsed)) {
      this.index?.delete(INDEX_STORE_KEY);
      return;
    }
    for (const row of parsed) {
      if (!Array.isArray(row) || row.length !== 3) continue;
      const [key, marker, size] = row as [unknown, unknown, unknown];
      if (typeof key !== "string" || !key.includes("@")) continue;
      if (marker !== "j" && marker !== "p") continue;
      if (typeof size !== "number" || !Number.isFinite(size) || size < 0) continue;
      const format: FrcDecodedFormat = marker === "p" ? "png" : "jpeg";
      this.entries.set(key, {
        uri: this.backend.finalUri(key, format),
        size,
        format,
        lastUsed: ++this.tick,
      });
      this.totalBytes += size;
    }
    // A build that lowered the budget must not start over it; the files this
    // drops are deleted right here, not left for the reconciliation to find.
    this.enforceBudget();
  }

  private purgeLegacyNamespace(): void {
    if (this.legacyNamespacePurged) return;
    if (this.index?.getString(LEGACY_PURGED_STORE_KEY) === "1") {
      this.legacyNamespacePurged = true;
      return;
    }
    try {
      this.backend.deleteLegacyNamespace();
    } catch {
      return; // flag stays unset: retry on the next start rather than leak up to 128 MB
    }
    this.legacyNamespacePurged = true;
    try {
      this.index?.set(LEGACY_PURGED_STORE_KEY, "1");
    } catch {
      // Without the flag the wipe is retried next start; deleting a missing
      // directory is a no-op, so that costs one extra `exists` check.
    }
  }

  private sweepStaleParts(): void {
    let parts: string[];
    try {
      parts = this.backend.listPartUris();
    } catch {
      return;
    }
    for (const uri of parts) {
      if (this.inFlightParts.has(uri)) continue;
      try {
        this.backend.deleteFile(uri);
      } catch {
        // Best-effort sweep.
      }
    }
  }

  private reconcileIndexWithDirectory(): void {
    let onDisk: Map<string, FrcCacheEntryRecord>;
    try {
      onDisk = new Map(this.backend.listFinalEntries().map((record) => [record.key, record]));
    } catch {
      return;
    }
    for (const [key, entry] of [...this.entries]) {
      const record = onDisk.get(key);
      // A different file under the same key (the decoder switched container)
      // counts as missing: the entry goes, and the loop below collects the file.
      if (!record || record.uri !== entry.uri) {
        this.invalidate(key);
        continue;
      }
      if (record.size !== entry.size) {
        this.totalBytes += record.size - entry.size;
        entry.size = record.size;
        this.markIndexDirty();
      }
    }
    for (const [key, record] of onDisk) {
      if (this.entries.has(key)) continue;
      try {
        this.backend.deleteFile(record.uri);
      } catch {
        // Best-effort; the file will be offered again on the next start.
      }
    }
    this.enforceBudget();
  }

  /** Records a legacy hit and evicts the LRU legacy hash once over budget. */
  private rememberLegacy(hash: string): void {
    this.legacyHashes.set(hash, ++this.tick);
    if (this.legacyHashes.size <= this.maxLegacyEntries) return;
    let victimHash: string | null = null;
    let victimUsed = Infinity;
    for (const [candidate, used] of this.legacyHashes) {
      if (used < victimUsed) {
        victimUsed = used;
        victimHash = candidate;
      }
    }
    if (victimHash !== null) this.legacyHashes.delete(victimHash);
  }

  private enforceBudget(): void {
    while (this.totalBytes > this.maxBytes || this.entries.size > this.maxEntries) {
      let victimKey: string | null = null;
      let victimUsed = Infinity;
      for (const [key, entry] of this.entries) {
        if ((this.leases.get(key) ?? 0) > 0) continue;
        if ((this.pins.get(entry.uri) ?? 0) > 0) continue;
        if (entry.lastUsed < victimUsed) {
          victimUsed = entry.lastUsed;
          victimKey = key;
        }
      }
      if (victimKey === null) break; // everything remaining is leased or on screen
      const victim = this.entries.get(victimKey)!;
      this.invalidate(victimKey);
      try {
        this.backend.deleteFile(victim.uri);
      } catch {
        // File may already be gone; the JS index is authoritative.
      }
    }
  }
}
