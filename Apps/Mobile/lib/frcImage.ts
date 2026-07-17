import { FRC_I_MIME } from "@flora/client-core/frc-i";
import { File, Paths } from "expo-file-system";
import { useEffect, useState } from "react";
import {
  decodeFrcFileToPng,
  encodeImageFileToFrc,
  isFloraFrcIAvailable,
} from "flora-frc-i";
import { writeExpoFileBytes } from "@/lib/expoFileBytes";

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

function normalizedMime(value: string | null): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function cacheName(prefix: string, extension: string): File {
  return new File(
    Paths.cache,
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`,
  );
}

export async function ensureFrcImageUri(url: string): Promise<string> {
  if (!url || !isFloraFrcIAvailable()) return url;
  const cached = cache.get(url);
  if (cached) return cached;
  const existing = inflight.get(url);
  if (existing) return existing;
  const request = (async () => {
    const response = await fetch(url, {
      headers: { Accept: FRC_I_MIME },
      cache: "no-cache",
    });
    if (!response.ok) throw new Error(`Image HTTP ${response.status}`);
    const mime = normalizedMime(response.headers.get("Content-Type"));
    if (mime !== FRC_I_MIME) {
      // Stale cache may still hold pre-FRI bytes for the same UUID.
      if (mime.startsWith("image/") && mime !== "image/svg+xml") return url;
      throw new Error("Сервер отдал не-FRI изображение");
    }
    const source = cacheName("flora-frc", "fri");
    const output = cacheName("flora-frc", "png");
    writeExpoFileBytes(source, new Uint8Array(await response.arrayBuffer()));
    await decodeFrcFileToPng(source.uri, output.uri);
    source.delete();
    cache.set(url, output.uri);
    return output.uri;
  })().finally(() => inflight.delete(url));
  inflight.set(url, request);
  return request;
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
  const [resolved, setResolved] = useState(uri);
  useEffect(() => {
    let cancelled = false;
    setResolved(uri);
    void ensureFrcImageUri(uri).then(
      (next) => {
        if (!cancelled) setResolved(next);
      },
      () => {
        if (!cancelled) setResolved("");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [uri]);
  return resolved;
}
