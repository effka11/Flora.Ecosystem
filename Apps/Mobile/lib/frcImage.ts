import { useRecyclingState } from "@shopify/flash-list";
import { File, Paths } from "expo-file-system";
import { useCallback, useEffect, useRef } from "react";
import { AppState, PixelRatio } from "react-native";
import {
  decodeFrcFileToPng,
  encodeImageFileToFrc,
  isFloraFrcIAvailable,
} from "flora-frc-i";
import { writeExpoFileBytes } from "@/lib/expoFileBytes";
import { useFrcRowMediaMode } from "@/lib/FrcImageDecodingScope";
import { FrcCommitBuffer } from "@/lib/frcCommitBuffer";
import { priorityForMode, shouldDecodeImage } from "@/lib/frcMediaMode";
import { FrcImageCache, type FrcPendingDecode } from "@/lib/frcImageCache";
import { createExpoFrcCacheBackend, createMmkvFrcCacheIndex } from "@/lib/frcImageCacheExpo";
import {
  FrcImagePipeline,
  type FrcImageLane,
  type FrcImagePipelineStats,
} from "@/lib/frcImagePipeline";
import {
  flushMediaBandwidth,
  initializeMediaBandwidthFromMmkv,
  reportFriDownload,
} from "@/lib/mediaBandwidth";
import { isScrollSettled, subscribeScrollSettled } from "@/lib/scrollActivity";
import {
  type QueuePauseReason,
  type QueuePriority,
  type QueueSubscription,
} from "@/lib/subscriberTaskQueue";

type FrcImageCounters = {
  completed: number;
  failed: number;
  decodeMs: number;
  /** Rows whose first frame came straight from the synchronous `peek()`, and those that did not. */
  peekHits: number;
  peekMisses: number;
  /** Non-empty → empty transitions under an unchanged `uri`: the flicker, target is zero. */
  blanked: number;
  /** Count and total of "row entered a decoding mode → first non-empty value" (perceived load). */
  firstPaintSamples: number;
  firstPaintTotalMs: number;
};

const diagnostics: FrcImageCounters = {
  completed: 0,
  failed: 0,
  decodeMs: 0,
  peekHits: 0,
  peekMisses: 0,
  blanked: 0,
  firstPaintSamples: 0,
  firstPaintTotalMs: 0,
};

export type FrcImageDiagnostics = FrcImagePipelineStats &
  FrcImageCounters & {
    cacheEntries: number;
    cacheBytes: number;
    commitBuffered: number;
  };

/** Remote post/avatar URLs need FRI decode; local file URIs (message cache) are already PNG. */
function needsRemoteFrcDecode(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

let cacheInstance: FrcImageCache | null = null;

/** Past the cold-start burst; the wait for a settled list happens on top of it. */
const RECONCILE_AFTER_START_MS = 5000;

/**
 * The full index↔directory reconciliation walks every cached file, so it must
 * not land inside a scroll gesture. After the startup delay it runs at once if
 * the list is already settled, otherwise on the next settle.
 */
function scheduleCacheReconcile(run: () => void): void {
  setTimeout(() => {
    if (isScrollSettled()) {
      run();
      return;
    }
    const unsubscribe = subscribeScrollSettled((settled) => {
      // Listeners fire on transitions only, never during subscribe.
      if (!settled) return;
      unsubscribe();
      run();
    });
  }, RECONCILE_AFTER_START_MS);
}

function imageCache(): FrcImageCache {
  if (!cacheInstance) {
    const cache = new FrcImageCache(createExpoFrcCacheBackend(), {
      index: createMmkvFrcCacheIndex(),
      // Buckets are device pixels; callers speak in logical points.
      pixelRatio: PixelRatio.get(),
      scheduleReconcile: scheduleCacheReconcile,
    });
    cacheInstance = cache;
    // Index writes and bandwidth samples both coalesce, so the tail of a
    // session would otherwise be lost when the process is killed in the
    // background. Process-lifetime subscription: the singleton it serves is
    // never torn down.
    AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        cache.flushIndex();
        void flushMediaBandwidth().catch(() => undefined);
      }
    });
    // Warm start: last session's throughput sizes the very first lookahead
    // window. Restoring resets the estimator, which costs nothing here — this
    // singleton is built before any download could have been sampled.
    void initializeMediaBandwidthFromMmkv().catch(() => undefined);
    try {
      cache.init();
    } catch {
      // Directory creation is retried by resolve(); resolution works cold.
    }
  }
  return cacheInstance;
}

/**
 * Queue key for a (URL, bucket) pair: the same image at two display sizes is
 * two independent decodes and must not share a task. NUL never occurs in a
 * URL, so the split back is exact.
 */
const TASK_KEY_SEPARATOR = "\u0000";

function decodeTaskKey(url: string, bucket: number): string {
  return `${bucket}${TASK_KEY_SEPARATOR}${url}`;
}

function parseTaskKey(taskKey: string): { url: string; bucket: number } {
  const separator = taskKey.indexOf(TASK_KEY_SEPARATOR);
  return {
    bucket: Number(taskKey.slice(0, separator)),
    url: taskKey.slice(separator + 1),
  };
}

const commitBuffer = new FrcCommitBuffer({
  isSettled: isScrollSettled,
  subscribeSettled: subscribeScrollSettled,
});

const imagePipeline = new FrcImagePipeline<FrcPendingDecode, string>({
  async fetch(taskKey, context) {
    const { url, bucket } = parseTaskKey(taskKey);
    const startedAt = performance.now();
    try {
      const fetched = await imageCache().fetch(url, {
        bucket,
        signal: context.signal,
      });
      if (fetched.kind === "resolved") {
        // A cache hit or a legacy URL served directly: no `.fri` crossed the
        // wire, so there is nothing to time.
        diagnostics.completed += 1;
        return { kind: "ready", value: fetched.result.uri };
      }
      reportFriDownload({
        bytes: fetched.pending.bytes,
        durationMilliseconds: performance.now() - startedAt,
        interrupted: context.signal.aborted,
      });
      return { kind: "intermediate", value: fetched.pending };
    } catch (error) {
      // An abort or a network failure says nothing about throughput. It is
      // still reported, so that the rule for discarding such samples lives in
      // one place instead of being duplicated as a condition here.
      reportFriDownload({
        bytes: 0,
        durationMilliseconds: performance.now() - startedAt,
        interrupted: true,
      });
      diagnostics.failed += 1;
      throw error;
    }
  },
  async decode(_taskKey, pending, context) {
    const started = performance.now();
    try {
      const result = await imageCache().decode(pending, {
        onBeforeDecode: context.markUncancellable,
      });
      diagnostics.decodeMs += performance.now() - started;
      diagnostics.completed += 1;
      return result.uri;
    } catch (error) {
      diagnostics.failed += 1;
      throw error;
    }
  },
  discard(pending) {
    imageCache().discardFetched(pending);
  },
});

export function setFrcImageQueuePaused(
  owner: symbol,
  reason: QueuePauseReason,
  paused: boolean,
): void {
  commitBuffer.setPaused(owner, reason, paused);
}

export function clearFrcImageQueuePauseOwner(owner: symbol): void {
  commitBuffer.clearPauseOwner(owner);
}

export function getFrcImageDiagnostics(): FrcImageDiagnostics {
  const stats = imageCache().stats();
  const commits = commitBuffer.stats();
  return {
    ...diagnostics,
    ...imagePipeline.stats(),
    paused: commits.paused,
    cacheEntries: stats.entries,
    cacheBytes: stats.totalBytes,
    commitBuffered: commits.pending,
  };
}

export async function encodeImageUriToFrc(uri: string, quality = 85): Promise<File> {
  if (!isFloraFrcIAvailable()) throw new Error("FRC-I native encoder недоступен");
  const output = new File(
    Paths.cache,
    `flora-frc-upload-${Date.now()}-${Math.random().toString(36).slice(2)}.fri`,
  );
  await encodeImageFileToFrc(uri, output.uri, quality);
  return output;
}

/**
 * Декод FRI-байтов в конкретный PNG-файл (детерминированный кэш картинок
 * сообщений: переживает рестарт процесса). Декодируем во временный файл и
 * переименовываем: упавший посреди записи декод не должен оставить частичный
 * PNG, который позже сойдёт за валидное кэш-попадание.
 */
export async function decodeFrcBytesToFile(bytes: Uint8Array, output: File): Promise<string> {
  if (!isFloraFrcIAvailable()) throw new Error("FRC-I native decoder недоступен");
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const source = new File(Paths.cache, `flora-frc-message-${stamp}.fri`);
  const tmp = new File(Paths.cache, `flora-frc-message-${stamp}.tmp.png`);
  writeExpoFileBytes(source, bytes);
  let moved = false;
  try {
    await decodeFrcFileToPng(source.uri, tmp.uri);
    if (output.exists) output.delete();
    tmp.move(output);
    moved = true;
  } finally {
    if (source.exists) source.delete();
    // После move() tmp.uri указывает на output — удалять только не-перемещённый.
    if (!moved && tmp.exists) tmp.delete();
  }
  return output.uri;
}

/** True for an app-owned decoded PNG (`file://`) vs. a legacy remote image. */
export function isLocalDecodedUri(uri: string): boolean {
  return uri.startsWith("file:");
}

const NOOP_PREFETCH = (): void => {};

/**
 * Warm an image no component is displaying yet: the row it belongs to is not
 * mounted, so there is no state to commit and no commit buffer involved — the
 * result lands in the cache, and the row that mounts later takes it from
 * `peek()` in its first render.
 *
 * The work is a plain `background` subscription, which is what makes this
 * cheap: it joins an existing task for the same (URL, bucket) pair instead of
 * starting a second one, it queues behind everything a visible row wants, and
 * it is dropped first when downloads outrun decoding. Failures are silent — a
 * prewarm nobody is waiting for must not report an error, and the row that
 * eventually mounts retries on its own.
 *
 * The returned function cancels the subscription. Calling it is what keeps a
 * caller that lost interest from holding the task alive; it is safe to call
 * more than once and after completion.
 */
export function prefetchFrcImage(
  uri: string,
  options: { displayWidth?: number; lane?: FrcImageLane } = {},
): () => void {
  if (!uri || !needsRemoteFrcDecode(uri)) return NOOP_PREFETCH;
  const cache = imageCache();
  const bucket = cache.bucketForWidth(options.displayWidth);
  // A smaller variant is not enough for a row that will ask for this bucket,
  // so only an exact hit skips the work.
  if (cache.peek(uri, bucket)?.exact) return NOOP_PREFETCH;

  const subscription = imagePipeline.subscribe(
    decodeTaskKey(uri, bucket),
    options.lane ?? "post",
    () => {},
    () => {},
    "background",
  );
  return () => {
    subscription.unsubscribe();
  };
}

export type UseFrcImageUriOptions = {
  /** Position of this image within its row (0 = first). Controls near/background gating. */
  imageIndex?: number;
  /** Force decode regardless of row viewability mode (e.g. an opened lightbox). */
  force?: boolean;
  /** Ширина показа в логических точках; определяет bucket декода. Не задана — полный размер. */
  displayWidth?: number;
  /** Полоса конвейера: мелкие аватары не должны стоять в FIFO перед картинками постов. */
  lane?: FrcImageLane;
};

/**
 * First frame for a `uri`: a warm cache paints in the very first render, a
 * cold one starts empty. A smaller already-decoded variant counts as a hit —
 * the row shows a stretched image rather than a hole, and the requested bucket
 * lands on top of it later. Counted once per key, so the hit rate reads as
 * "share of rows that never showed a hole".
 */
function seedResolvedUri(uri: string, bucket: number): string {
  if (!uri || !needsRemoteFrcDecode(uri)) return uri;
  const cached = imageCache().peek(uri, bucket);
  if (cached) {
    diagnostics.peekHits += 1;
    return cached.uri;
  }
  diagnostics.peekMisses += 1;
  return "";
}

/**
 * Sticky decoded URI for a remote FRI image.
 *
 * The value is cleared only when `uri` itself changes, and then synchronously
 * in the render phase, so a recycled row never paints the previous post's
 * image and nothing else can blank a frame that is already on screen — not a
 * re-run of the effects, not a failed decode, not a lost race between an
 * unsubscribe and its immediate re-subscribe.
 */
export function useFrcImageUri(uri: string, options: UseFrcImageUriOptions = {}): string {
  const { imageIndex = 0, force = false, displayWidth, lane = "post" } = options;
  const mode = useFrcRowMediaMode();
  const decodeAllowed = force || shouldDecodeImage(mode, imageIndex);
  const priority: QueuePriority = force ? "visible" : priorityForMode(mode);
  const bucket = imageCache().bucketForWidth(displayWidth);

  const shownRef = useRef("");
  const waitingSinceRef = useRef<number | null>(null);
  const priorityRef = useRef(priority);
  const subscriptionRef = useRef<QueueSubscription | null>(null);

  // Only `uri` resets the value: a bucket change is an upgrade of the same
  // picture and must not blank the cell while the new variant decodes.
  const [resolved, setResolved] = useRecyclingState<string>(
    () => {
      const seeded = seedResolvedUri(uri, bucket);
      shownRef.current = seeded;
      return seeded;
    },
    [uri],
    () => {
      waitingSinceRef.current = null;
    },
  );

  const commit = useCallback(
    (next: string) => {
      const shown = shownRef.current;
      if (shown === next) return;
      if (shown !== "" && next === "") {
        // The bug this hook exists to prevent: keep the pixels, count the attempt.
        diagnostics.blanked += 1;
        return;
      }
      if (next !== "" && waitingSinceRef.current !== null) {
        diagnostics.firstPaintSamples += 1;
        diagnostics.firstPaintTotalMs += performance.now() - waitingSinceRef.current;
        waitingSinceRef.current = null;
      }
      shownRef.current = next;
      // skipParentLayout: the cell is sized from the aspect ratio, never from
      // the decoded URI, so a delivered image must not relayout the whole list.
      setResolved(next, true);
    },
    [setResolved],
  );

  // Lease: hold the decoded variant for as long as this row can display it.
  useEffect(() => {
    if (!uri || !needsRemoteFrcDecode(uri)) return;
    const cache = imageCache();
    cache.acquire(uri, bucket);
    return () => cache.release(uri, bucket);
  }, [bucket, uri]);

  // Pin: the lease covers the variant this row asked for, which is not always
  // the one on screen — a row that fell back to a smaller variant would have
  // its pixels deleted under it by eviction. Keyed on the displayed value, so
  // the pin moves with every commit and is released on unmount, whatever the
  // order of key, bucket and delivery changes.
  useEffect(() => {
    if (!resolved || !isLocalDecodedUri(resolved)) return;
    const cache = imageCache();
    cache.pinFile(resolved);
    return () => cache.unpinFile(resolved);
  }, [resolved]);

  // Pipeline subscription: torn down for a new key or a closed gate, never for
  // a priority change. Cache hits discovered after render and pipeline results
  // share the same commit gate; only the render-phase seed above bypasses it.
  useEffect(() => {
    if (!uri || !needsRemoteFrcDecode(uri)) return;

    let active = true;
    let cancelPendingCommit: (() => void) | null = null;
    const deliver = (next: string) => {
      cancelPendingCommit?.();
      cancelPendingCommit = commitBuffer.enqueue(() => {
        cancelPendingCommit = null;
        if (active) commit(next);
      });
    };

    const cached = imageCache().peek(uri, bucket);
    // A smaller variant only fills a hole: it is stretched by expo-image until
    // the requested bucket arrives, and it never replaces a better frame.
    if (cached && (cached.exact || !shownRef.current)) deliver(cached.uri);

    let subscription: QueueSubscription | null = null;
    if (!cached?.exact && decodeAllowed) {
      // Perceived-load window opens only while the cell has nothing to show.
      waitingSinceRef.current = shownRef.current ? null : performance.now();

      subscription = imagePipeline.subscribe(
        decodeTaskKey(uri, bucket),
        lane,
        deliver,
        (error) => {
          // Failure leaves the last good frame in place; a retry comes with the
          // next mode change or remount.
          if (__DEV__) {
            console.warn("[frc-i] decode failed", uri, error);
          }
        },
        priorityRef.current,
      );
      subscriptionRef.current = subscription;
    }

    return () => {
      active = false;
      cancelPendingCommit?.();
      if (subscriptionRef.current === subscription) subscriptionRef.current = null;
      subscription?.unsubscribe();
      waitingSinceRef.current = null;
    };
  }, [bucket, commit, decodeAllowed, lane, uri]);

  // Re-rank in place: a row moving between viewability bands changes where its
  // decode sits in the queue, not whether it is queued at all.
  useEffect(() => {
    priorityRef.current = priority;
    subscriptionRef.current?.setPriority(priority);
  }, [priority]);

  return resolved;
}
