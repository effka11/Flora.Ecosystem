"use client";

import { FRC_I_MIME, acceptsFrcI } from "@flora/client-core/frc-i";
import { useEffect, useState } from "react";

type WorkerReply =
  | { id: number; ok: true; png: ArrayBuffer }
  | { id: number; ok: true; fri: ArrayBuffer }
  | { id: number; ok: false; error: string };

const MAX_CACHE_ENTRIES = 128;
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();
const pending = new Map<
  number,
  { resolve: (bytes: ArrayBuffer) => void; reject: (error: Error) => void }
>();
let worker: Worker | null = null;
let nextRequestId = 1;

function isNativeSource(url: string): boolean {
  return /^(blob:|data:|file:)/i.test(url);
}

function decoderWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./frcImageWorker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<WorkerReply>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if (event.data.ok) request.resolve("png" in event.data ? event.data.png : event.data.fri);
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

function decodeFrc(bytes: ArrayBuffer): Promise<Blob> {
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, {
      resolve: (png) => resolve(new Blob([png], { type: "image/png" })),
      reject,
    });
    decoderWorker().postMessage({ id, kind: "decode", bytes }, [bytes]);
  });
}

export function decodeFrcBlobToPng(blob: Blob): Promise<Blob> {
  return blob.arrayBuffer().then(decodeFrc);
}

export async function encodeImageBlobToFrc(blob: Blob, quality = 75): Promise<Blob> {
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
      pending.set(id, { resolve, reject });
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

async function fetchFri(url: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(url, {
    credentials: "include",
    headers: { Accept: FRC_I_MIME },
    cache: "no-cache",
    signal,
  });
  if (!response.ok) throw new Error(`Image HTTP ${response.status}`);
  const contentType = response.headers.get("Content-Type");
  if (acceptsFrcI(contentType)) {
    return decodeFrc(await response.arrayBuffer());
  }
  // Stale browser cache may still hold pre-FRI bytes for the same UUID.
  const mime = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mime.startsWith("image/") && mime !== "image/svg+xml") {
    return response.blob();
  }
  throw new Error("Сервер отдал не-FRI изображение");
}

async function loadSource(url: string): Promise<string> {
  const blob = await fetchFri(url);
  return URL.createObjectURL(blob);
}

function cacheSource(key: string, objectUrl: string): string {
  cache.delete(key);
  cache.set(key, objectUrl);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.entries().next().value as [string, string] | undefined;
    if (!oldest) break;
    cache.delete(oldest[0]);
    URL.revokeObjectURL(oldest[1]);
  }
  return objectUrl;
}

export function resolveFrcImageSource(url: string): Promise<string> {
  if (!url || isNativeSource(url)) return Promise.resolve(url);
  const cached = cache.get(url);
  if (cached) return Promise.resolve(cached);
  const existing = inflight.get(url);
  if (existing) return existing;
  const request = loadSource(url)
    .then((objectUrl) => cacheSource(url, objectUrl))
    .finally(() => inflight.delete(url));
  inflight.set(url, request);
  return request;
}

export function invalidateFrcImageSource(url: string): void {
  const objectUrl = cache.get(url);
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  cache.delete(url);
  inflight.delete(url);
}

export function useFrcImageSource(url: string): {
  source: string;
  loading: boolean;
  error: boolean;
} {
  const [state, setState] = useState(() => ({
    source: isNativeSource(url) ? url : "",
    loading: Boolean(url && !isNativeSource(url)),
    error: false,
  }));

  useEffect(() => {
    if (!url || isNativeSource(url)) {
      setState({ source: url, loading: false, error: false });
      return;
    }
    let cancelled = false;
    setState({ source: "", loading: true, error: false });
    void resolveFrcImageSource(url).then(
      (source) => {
        if (!cancelled) setState({ source, loading: false, error: false });
      },
      () => {
        if (!cancelled) setState({ source: "", loading: false, error: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [url]);

  return state;
}
