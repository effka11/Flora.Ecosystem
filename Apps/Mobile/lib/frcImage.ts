import { FRC_I_MIME } from "@flora/client-core/frc-i";
import { File, Paths } from "expo-file-system";
import { useEffect, useState } from "react";
import {
  decodeFrcFileToPng,
  encodeImageFileToFrc,
  isFloraFrcIAvailable,
} from "flora-frc-i";
import { writeExpoFileBytes } from "@/lib/expoFileBytes";
import { useFrcImageDecodingEnabled } from "@/lib/FrcImageDecodingScope";
import {
  SubscriberTaskQueue,
  type QueuePauseReason,
  type SubscriberTaskQueueStats,
} from "@/lib/subscriberTaskQueue";

const CACHE_LIMIT = 256;
const cache = new Map<string, string>();

const diagnostics = {
  completed: 0,
  failed: 0,
  fetchMs: 0,
  decodeMs: 0,
};

function normalizedMime(value: string | null): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/** Remote post/avatar URLs need FRI decode; local file URIs (message cache) are already PNG. */
function needsRemoteFrcDecode(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function cacheName(prefix: string, extension: string): File {
  return new File(
    Paths.cache,
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`,
  );
}

function cachedImageUri(url: string): string | undefined {
  const value = cache.get(url);
  if (!value) return undefined;
  cache.delete(url);
  cache.set(url, value);
  return value;
}

function rememberImageUri(url: string, uri: string): void {
  cache.delete(url);
  cache.set(url, uri);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    // Evict only the JS index. expo-image may still hold the local PNG.
    cache.delete(oldest);
  }
}

async function decodeRemoteFrcImage(url: string): Promise<string> {
  const fetchStarted = performance.now();
  try {
    const response = await fetch(url, {
      headers: { Accept: FRC_I_MIME },
      cache: "no-cache",
    });
    diagnostics.fetchMs += performance.now() - fetchStarted;
    if (!response.ok) throw new Error(`Image HTTP ${response.status}`);
    const mime = normalizedMime(response.headers.get("Content-Type"));
    if (mime !== FRC_I_MIME) {
      // Stale cache may still hold pre-FRI bytes for the same UUID.
      if (mime.startsWith("image/") && mime !== "image/svg+xml") {
        rememberImageUri(url, url);
        diagnostics.completed += 1;
        return url;
      }
      throw new Error("Сервер отдал не-FRI изображение");
    }
    if (!isFloraFrcIAvailable()) {
      throw new Error(
        "FRC-I native decoder недоступен (нет libfrc_i_mobile_ffi). " +
          "npm run frc-i:native:android, затем reinstall Flora Dev (-ReplaceExisting).",
      );
    }
    const source = cacheName("flora-frc", "fri");
    const output = cacheName("flora-frc", "png");
    try {
      writeExpoFileBytes(source, new Uint8Array(await response.arrayBuffer()));
      const decodeStarted = performance.now();
      await decodeFrcFileToPng(source.uri, output.uri);
      diagnostics.decodeMs += performance.now() - decodeStarted;
      rememberImageUri(url, output.uri);
      diagnostics.completed += 1;
      return output.uri;
    } finally {
      try {
        source.delete();
      } catch {
        // Cache maintenance can remove a temporary source first.
      }
    }
  } catch (error) {
    diagnostics.failed += 1;
    throw error;
  }
}

const decodeQueue = new SubscriberTaskQueue(decodeRemoteFrcImage, 1);

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

export function getFrcImageDiagnostics(): SubscriberTaskQueueStats & typeof diagnostics {
  return { ...diagnostics, ...decodeQueue.stats() };
}

export async function ensureFrcImageUri(url: string): Promise<string> {
  if (!url || !needsRemoteFrcDecode(url)) return url;
  return cachedImageUri(url) ?? decodeQueue.request(url);
}

export async function encodeImageUriToFrc(uri: string, quality = 85): Promise<File> {
  if (!isFloraFrcIAvailable()) throw new Error("FRC-I native encoder недоступен");
  const output = cacheName("flora-frc-upload", "fri");
  await encodeImageFileToFrc(uri, output.uri, quality);
  return output;
}

export async function decodeFrcBytesToCache(bytes: Uint8Array): Promise<string> {
  if (!isFloraFrcIAvailable()) throw new Error("FRC-I native decoder недоступен");
  const source = cacheName("flora-frc-message", "fri");
  const output = cacheName("flora-frc-message", "png");
  writeExpoFileBytes(source, bytes);
  await decodeFrcFileToPng(source.uri, output.uri);
  source.delete();
  return output.uri;
}

export function useFrcImageUri(uri: string): string {
  const decodeEnabled = useFrcImageDecodingEnabled();
  const [resolved, setResolved] = useState(() => {
    if (!uri || !needsRemoteFrcDecode(uri)) return uri;
    return cachedImageUri(uri) ?? "";
  });

  useEffect(() => {
    if (!uri || !needsRemoteFrcDecode(uri)) {
      setResolved(uri);
      return;
    }

    const cached = cachedImageUri(uri);
    setResolved(cached ?? "");
    if (cached || !decodeEnabled) return;

    return decodeQueue.subscribe(
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
    );
  }, [decodeEnabled, uri]);

  return resolved;
}
