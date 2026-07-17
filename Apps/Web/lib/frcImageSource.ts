"use client";

import { FRC_I_MIME, acceptsFrcI } from "@flora/client-core/frc-i";
import { useEffect, useState } from "react";

type WorkerDecodeOk = { id: number; ok: true; rgba: ArrayBuffer; width: number; height: number };
type WorkerEncodeOk = { id: number; ok: true; fri: ArrayBuffer };
type WorkerReply = WorkerDecodeOk | WorkerEncodeOk | { id: number; ok: false; error: string };

export type FrcResolvedSource =
  | { kind: "url"; url: string }
  | { kind: "bitmap"; bitmap: ImageBitmap };

const MAX_CACHE_ENTRIES = 128;
const cache = new Map<string, FrcResolvedSource>();
const inflight = new Map<string, Promise<FrcResolvedSource>>();
const pending = new Map<
  number,
  {
    resolve: (value: WorkerDecodeOk | WorkerEncodeOk) => void;
    reject: (error: Error) => void;
  }
>();
let worker: Worker | null = null;
let nextRequestId = 1;

function isPassthroughUrl(url: string): boolean {
  return /^(data:image\/|file:)/i.test(url);
}

function decoderWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./frcImageWorker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<WorkerReply>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if (event.data.ok) request.resolve(event.data);
    else request.reject(new Error(event.data.error));
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || "FRC-I worker failed");
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

async function decodeFrcBytesToBitmap(bytes: ArrayBuffer): Promise<ImageBitmap> {
  const id = nextRequestId++;
  const reply = await new Promise<WorkerDecodeOk>((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => {
        if ("rgba" in value) resolve(value);
        else reject(new Error("Unexpected encode reply"));
      },
      reject,
    });
    decoderWorker().postMessage({ id, kind: "decode", bytes }, [bytes]);
  });
  const pixels = new Uint8ClampedArray(reply.rgba);
  const imageData = new ImageData(pixels, reply.width, reply.height);
  return createImageBitmap(imageData);
}

/** Decode FRI ciphertext/plaintext blob to ImageBitmap (no PNG re-encode). */
export async function decodeFrcBlobToBitmap(blob: Blob): Promise<ImageBitmap> {
  return decodeFrcBytesToBitmap(await blob.arrayBuffer());
}

export async function encodeImageBlobToFrc(blob: Blob, quality = 85): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas 2D недоступен");
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const transfer = pixels.buffer.slice(
      pixels.byteOffset,
      pixels.byteOffset + pixels.byteLength,
    ) as ArrayBuffer;
    const id = nextRequestId++;
    const fri = await new Promise<ArrayBuffer>((resolve, reject) => {
      pending.set(id, {
        resolve: (value) => {
          if ("fri" in value) resolve(value.fri);
          else reject(new Error("Unexpected decode reply"));
        },
        reject,
      });
      decoderWorker().postMessage(
        {
          id,
          kind: "encode",
          pixels: transfer,
          width: bitmap.width,
          height: bitmap.height,
          quality,
        },
        [transfer],
      );
    });
    return new Blob([fri], { type: FRC_I_MIME });
  } finally {
    bitmap.close();
  }
}

async function loadResolved(url: string): Promise<FrcResolvedSource> {
  const response = await fetch(url, {
    credentials: "include",
    headers: { Accept: FRC_I_MIME },
    cache: "no-cache",
  });
  if (!response.ok) throw new Error(`Image HTTP ${response.status}`);
  const contentType = response.headers.get("Content-Type");
  if (acceptsFrcI(contentType)) {
    const bitmap = await decodeFrcBytesToBitmap(await response.arrayBuffer());
    return { kind: "bitmap", bitmap };
  }
  const mime = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mime.startsWith("image/") && mime !== "image/svg+xml") {
    return { kind: "url", url };
  }
  // blob: of FRI may omit useful Content-Type through some proxies — sniff magic.
  const bytes = await response.arrayBuffer();
  const header = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  if (
    header.length >= 4 &&
    header[0] === 0x8f &&
    header[1] === 0x46 &&
    header[2] === 0x52 &&
    header[3] === 0x49
  ) {
    const bitmap = await decodeFrcBytesToBitmap(bytes);
    return { kind: "bitmap", bitmap };
  }
  throw new Error("Сервер отдал не-FRI изображение");
}

function releaseCached(entry: FrcResolvedSource): void {
  if (entry.kind === "bitmap") entry.bitmap.close();
}

function cacheSource(key: string, source: FrcResolvedSource): FrcResolvedSource {
  const previous = cache.get(key);
  if (previous) releaseCached(previous);
  cache.delete(key);
  cache.set(key, source);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.entries().next().value as [string, FrcResolvedSource] | undefined;
    if (!oldest) break;
    cache.delete(oldest[0]);
    releaseCached(oldest[1]);
  }
  return source;
}

export function resolveFrcImageSource(url: string): Promise<FrcResolvedSource> {
  if (!url) return Promise.resolve({ kind: "url", url: "" });
  if (isPassthroughUrl(url)) return Promise.resolve({ kind: "url", url });
  const cached = cache.get(url);
  if (cached) return Promise.resolve(cached);
  const existing = inflight.get(url);
  if (existing) return existing;
  const request = loadResolved(url)
    .then((source) => cacheSource(url, source))
    .finally(() => inflight.delete(url));
  inflight.set(url, request);
  return request;
}

export function invalidateFrcImageSource(url: string): void {
  const entry = cache.get(url);
  if (entry) releaseCached(entry);
  cache.delete(url);
  inflight.delete(url);
}

export function useFrcImageSource(url: string): {
  source: FrcResolvedSource | null;
  loading: boolean;
  error: boolean;
} {
  const [state, setState] = useState<{
    source: FrcResolvedSource | null;
    loading: boolean;
    error: boolean;
  }>(() => ({
    source: isPassthroughUrl(url) ? { kind: "url", url } : null,
    loading: Boolean(url && !isPassthroughUrl(url)),
    error: false,
  }));

  useEffect(() => {
    if (!url) {
      setState({ source: null, loading: false, error: false });
      return;
    }
    if (isPassthroughUrl(url)) {
      setState({ source: { kind: "url", url }, loading: false, error: false });
      return;
    }
    let cancelled = false;
    setState({ source: null, loading: true, error: false });
    void resolveFrcImageSource(url).then(
      (source) => {
        if (!cancelled) setState({ source, loading: false, error: false });
      },
      () => {
        if (!cancelled) setState({ source: null, loading: false, error: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [url]);

  return state;
}
