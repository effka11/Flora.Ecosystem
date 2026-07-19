import { File, Paths } from "expo-file-system";
import { useEffect, useState } from "react";
import {
  decodeFrcFileToPng,
  encodeImageFileToFrc,
  isFloraFrcIAvailable,
} from "flora-frc-i";
import { writeExpoFileBytes } from "@/lib/expoFileBytes";
import { useFrcRowMediaMode } from "@/lib/FrcImageDecodingScope";
import { priorityForMode, shouldDecodeImage } from "@/lib/frcMediaMode";
import { FrcImageCache } from "@/lib/frcImageCache";
import { createExpoFrcCacheBackend } from "@/lib/frcImageCacheExpo";
import {
  SubscriberTaskQueue,
  type QueuePauseReason,
  type QueueWorkerContext,
  type SubscriberTaskQueueStats,
} from "@/lib/subscriberTaskQueue";

const diagnostics = {
  completed: 0,
  failed: 0,
  decodeMs: 0,
};

/** Remote post/avatar URLs need FRI decode; local file URIs (message cache) are already PNG. */
function needsRemoteFrcDecode(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

let cacheInstance: FrcImageCache | null = null;

function imageCache(): FrcImageCache {
  if (!cacheInstance) {
    cacheInstance = new FrcImageCache(createExpoFrcCacheBackend());
    try {
      cacheInstance.init();
    } catch {
      // Cache directory scan is best-effort; resolution still works cold.
    }
  }
  return cacheInstance;
}

async function resolveRemoteFrcImage(
  url: string,
  ctx: QueueWorkerContext,
): Promise<string> {
  const started = performance.now();
  try {
    const result = await imageCache().resolve(url, {
      signal: ctx.signal,
      onBeforeDecode: ctx.markUncancellable,
    });
    diagnostics.decodeMs += performance.now() - started;
    diagnostics.completed += 1;
    return result.uri;
  } catch (error) {
    diagnostics.failed += 1;
    throw error;
  }
}

const decodeQueue = new SubscriberTaskQueue(resolveRemoteFrcImage, 1);

export function setFrcImageQueuePaused(
  owner: symbol,
  reason: QueuePauseReason,
  paused: boolean,
): void {
  decodeQueue.setPaused(owner, reason, paused);
}

export function clearFrcImageQueuePauseOwner(owner: symbol): void {
  decodeQueue.clearPauseOwner(owner);
}

export function getFrcImageDiagnostics(): SubscriberTaskQueueStats &
  typeof diagnostics & { cacheEntries: number; cacheBytes: number } {
  const stats = imageCache().stats();
  return {
    ...diagnostics,
    ...decodeQueue.stats(),
    cacheEntries: stats.entries,
    cacheBytes: stats.totalBytes,
  };
}

export async function ensureFrcImageUri(url: string): Promise<string> {
  if (!url || !needsRemoteFrcDecode(url)) return url;
  return imageCache().peek(url) ?? decodeQueue.request(url);
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

export async function decodeFrcBytesToCache(bytes: Uint8Array): Promise<string> {
  if (!isFloraFrcIAvailable()) throw new Error("FRC-I native decoder недоступен");
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const source = new File(Paths.cache, `flora-frc-message-${stamp}.fri`);
  const output = new File(Paths.cache, `flora-frc-message-${stamp}.png`);
  writeExpoFileBytes(source, bytes);
  await decodeFrcFileToPng(source.uri, output.uri);
  source.delete();
  return output.uri;
}

/** True for an app-owned decoded PNG (`file://`) vs. a legacy remote image. */
export function isLocalDecodedUri(uri: string): boolean {
  return uri.startsWith("file:");
}

export type UseFrcImageUriOptions = {
  /** Position of this image within its row (0 = first). Controls near/background gating. */
  imageIndex?: number;
  /** Force decode regardless of row viewability mode (e.g. an opened lightbox). */
  force?: boolean;
};

export function useFrcImageUri(uri: string, options: UseFrcImageUriOptions = {}): string {
  const { imageIndex = 0, force = false } = options;
  const mode = useFrcRowMediaMode();
  const decodeAllowed = force || shouldDecodeImage(mode, imageIndex);
  const priority = force ? "visible" : priorityForMode(mode);

  const [resolved, setResolved] = useState(() => {
    if (!uri || !needsRemoteFrcDecode(uri)) return uri;
    return imageCache().peek(uri) ?? "";
  });

  useEffect(() => {
    if (!uri || !needsRemoteFrcDecode(uri)) {
      setResolved(uri);
      return;
    }

    // Hold a lease so the decoded file is not evicted while displayed.
    const cache = imageCache();
    cache.acquire(uri);

    const cached = cache.peek(uri);
    setResolved(cached ?? "");
    if (cached || !decodeAllowed) {
      // Already decoded, or this image is out of the current viewability band:
      // keep the cache hit (if any) but do not enqueue new decode work.
      return () => cache.release(uri);
    }

    const unsubscribe = decodeQueue.subscribe(
      uri,
      (next) => {
        setResolved(next);
      },
      (error) => {
        if (__DEV__) {
          console.warn("[frc-i] decode failed", uri, error);
        }
        setResolved("");
      },
      priority,
    );

    return () => {
      unsubscribe();
      cache.release(uri);
    };
  }, [decodeAllowed, priority, uri]);

  return resolved;
}
