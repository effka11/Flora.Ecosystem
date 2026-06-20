import { decryptVoiceBlob } from "@/app/(dashboard)/messages/voiceCrypto";
import type { FscpImageBlock, FscpMessagePlaintext, FscpVideoBlock, FscpVoiceBlock } from "@/lib/fscp";
import {
  apiDownloadMessageImageAsset,
  apiDownloadMessageVideoAsset,
  apiDownloadMessageVoiceAsset,
} from "@/lib/socialApi";

const TTL_MS = 300_000;
const MAX_IDLE_PRELOAD_ASSETS = 16;

type EncryptedMediaBlock = {
  assetUuid: string;
  contentType: string;
  encryption: { keyBase64Url: string; nonceBase64Url: string };
};

type CachedMedia = {
  blob: Blob;
  objectUrl: string;
  fetchedAt: number;
};

const cache = new Map<string, CachedMedia>();
const inflight = new Map<string, Promise<string>>();

function normalizeAssetId(assetUuid: string): string {
  return assetUuid.trim().toLowerCase();
}

function isFresh(entry: CachedMedia): boolean {
  return Date.now() - entry.fetchedAt < TTL_MS;
}

function storeBlob(assetUuid: string, blob: Blob): string {
  const id = normalizeAssetId(assetUuid);
  const existing = cache.get(id);
  if (existing && isFresh(existing)) return existing.objectUrl;
  if (existing) URL.revokeObjectURL(existing.objectUrl);
  const objectUrl = URL.createObjectURL(blob);
  cache.set(id, { blob, objectUrl, fetchedAt: Date.now() });
  return objectUrl;
}

async function downloadAndDecrypt(
  block: EncryptedMediaBlock,
  download: (assetUuid: string) => Promise<Blob>,
): Promise<Blob> {
  const encryptedBlob = await download(block.assetUuid);
  return decryptVoiceBlob({
    encryptedBlob,
    keyBase64Url: block.encryption.keyBase64Url,
    nonceBase64Url: block.encryption.nonceBase64Url,
    contentType: block.contentType,
  });
}

async function ensureObjectUrl(
  block: EncryptedMediaBlock,
  download: (assetUuid: string) => Promise<Blob>,
): Promise<string> {
  const cached = peekMessageMediaObjectUrl(block.assetUuid);
  if (cached) return cached;
  const id = normalizeAssetId(block.assetUuid);
  const pending = inflight.get(id);
  if (pending) return pending;
  const task = downloadAndDecrypt(block, download)
    .then((blob) => storeBlob(block.assetUuid, blob))
    .finally(() => {
      inflight.delete(id);
    });
  inflight.set(id, task);
  return task;
}

export function peekMessageMediaObjectUrl(assetUuid: string): string | null {
  const id = normalizeAssetId(assetUuid);
  const entry = cache.get(id);
  if (!entry || !isFresh(entry)) return null;
  return entry.objectUrl;
}

export function peekMessageMediaBlob(assetUuid: string): Blob | null {
  const id = normalizeAssetId(assetUuid);
  const entry = cache.get(id);
  if (!entry || !isFresh(entry)) return null;
  return entry.blob;
}

export function ensureMessageImageObjectUrl(block: FscpImageBlock): Promise<string> {
  return ensureObjectUrl(block, apiDownloadMessageImageAsset);
}

export function ensureMessageVideoObjectUrl(block: FscpVideoBlock): Promise<string> {
  return ensureObjectUrl(block, apiDownloadMessageVideoAsset);
}

export function ensureMessageVoiceObjectUrl(block: FscpVoiceBlock): Promise<string> {
  return ensureObjectUrl(block, apiDownloadMessageVoiceAsset);
}

function preloadBlock(block: EncryptedMediaBlock, download: (assetUuid: string) => Promise<Blob>): void {
  const id = normalizeAssetId(block.assetUuid);
  if (peekMessageMediaObjectUrl(block.assetUuid) || inflight.has(id)) return;
  void ensureObjectUrl(block, download).catch(() => {});
}

export function preloadMessageImage(block: FscpImageBlock): void {
  preloadBlock(block, apiDownloadMessageImageAsset);
}

export function preloadMessageVideo(block: FscpVideoBlock): void {
  preloadBlock(block, apiDownloadMessageVideoAsset);
}

export function preloadMessageVoice(block: FscpVoiceBlock): void {
  preloadBlock(block, apiDownloadMessageVoiceAsset);
}

export function preloadMessageMediaFromPlaintexts(
  plaintexts: FscpMessagePlaintext[],
  maxAssets = MAX_IDLE_PRELOAD_ASSETS,
): void {
  let count = 0;
  for (const plain of plaintexts) {
    for (const block of plain.blocks) {
      if (count >= maxAssets) return;
      if (block.kind === "image") {
        preloadMessageImage(block);
        count++;
      } else       if (block.kind === "video") {
        preloadMessageVideo(block);
        count++;
      } else if (block.kind === "voice") {
        preloadMessageVoice(block);
        count++;
      }
    }
  }
}

export function invalidateMessageMediaAsset(assetUuid: string): void {
  const id = normalizeAssetId(assetUuid);
  const entry = cache.get(id);
  if (entry) URL.revokeObjectURL(entry.objectUrl);
  cache.delete(id);
  inflight.delete(id);
}
