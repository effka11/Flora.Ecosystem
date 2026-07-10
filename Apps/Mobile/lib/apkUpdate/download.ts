import {
  cacheDirectory,
  createDownloadResumable,
  getFreeDiskStorageAsync,
  makeDirectoryAsync,
  getInfoAsync,
  deleteAsync,
  type DownloadResumable,
} from "expo-file-system/legacy";
import {
  addDownloadProgressListener,
  canNativeDownload,
  cancelNativeDownload,
  downloadFile as nativeDownloadFile,
  getNativeUpdateDir,
} from "flora-apk-updater";
import { mmkv } from "@/lib/mmkv";
import type { AndroidUpdateManifest } from "@/lib/apkUpdate/githubRelease";

const UPDATE_DIR = "flora-update";
const PENDING_NAME = "pending.apk";
const META_KEY = "apkUpdate.pendingMeta";
const SAVABLE_KEY = "apkUpdate.downloadSavable";
const DISK_MARGIN_BYTES = 40 * 1024 * 1024;

export type PendingMeta = {
  versionCode: number | null;
  sha256: string;
  apkUrl: string;
  sizeBytes?: number;
};

let activeDownload: DownloadResumable | null = null;
let cancelRequested = false;

export function resetApkUpdateCancelFlag(): void {
  cancelRequested = false;
}

export function isApkUpdateCancelled(): boolean {
  return cancelRequested;
}

export function getPendingApkUri(): string {
  const nativeDir = getNativeUpdateDir();
  if (nativeDir) {
    return `file://${nativeDir.replace(/\/+$/, "")}/pending.apk`;
  }
  const base = cacheDirectory;
  if (!base) throw new Error("cacheDirectory unavailable");
  return `${base}${UPDATE_DIR}/${PENDING_NAME}`;
}

export function getUpdateDirUri(): string {
  const nativeDir = getNativeUpdateDir();
  if (nativeDir) {
    return `file://${nativeDir.replace(/\/+$/, "")}`;
  }
  const base = cacheDirectory;
  if (!base) throw new Error("cacheDirectory unavailable");
  return `${base}${UPDATE_DIR}`;
}

export async function ensureUpdateDir(): Promise<void> {
  const dir = getUpdateDirUri();
  const info = await getInfoAsync(dir);
  if (!info.exists) {
    await makeDirectoryAsync(dir, { intermediates: true });
  }
}

export function readPendingMeta(): PendingMeta | null {
  const raw = mmkv.getString(META_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingMeta;
  } catch {
    return null;
  }
}

export function writePendingMeta(meta: PendingMeta): void {
  mmkv.set(META_KEY, JSON.stringify(meta));
}

export async function clearPendingApk(): Promise<void> {
  mmkv.delete(META_KEY);
  mmkv.delete(SAVABLE_KEY);
  activeDownload = null;
  try {
    const uri = getPendingApkUri();
    const info = await getInfoAsync(uri);
    if (info.exists) await deleteAsync(uri, { idempotent: true });
  } catch {
    // ignore
  }
}

/**
 * Stop in-flight download (if any) and delete pending APK + resume metadata.
 * Safe to call from the update modal close button.
 */
export async function cancelApkUpdateAndClearCache(): Promise<void> {
  cancelRequested = true;
  cancelNativeDownload();
  const dl = activeDownload;
  activeDownload = null;
  if (dl) {
    try {
      await dl.cancelAsync();
    } catch {
      // ignore — task may already be finished
    }
  }
  mmkv.delete(META_KEY);
  mmkv.delete(SAVABLE_KEY);
  try {
    const uri = getPendingApkUri();
    const info = await getInfoAsync(uri);
    if (info.exists) await deleteAsync(uri, { idempotent: true });
  } catch {
    // ignore
  }
}

export async function cleanupStalePending(installedVersionCode: number): Promise<void> {
  const meta = readPendingMeta();
  if (meta?.versionCode != null && meta.versionCode <= installedVersionCode) {
    await clearPendingApk();
  }
}

export async function assertEnoughDiskSpace(sizeBytes: number | undefined): Promise<void> {
  if (sizeBytes == null || sizeBytes <= 0) {
    throw new Error("MISSING_SIZE");
  }
  const free = await getFreeDiskStorageAsync();
  if (free < sizeBytes + DISK_MARGIN_BYTES) {
    throw new Error("NO_DISK_SPACE");
  }
}

function isCompletePending(
  info: { exists: boolean; size?: number },
  manifest: AndroidUpdateManifest,
  meta: PendingMeta,
): boolean {
  if (!info.exists || !info.size || info.size <= 0) return false;
  if (meta.sha256 !== manifest.sha256) return false;
  if (manifest.sizeBytes != null && manifest.sizeBytes > 0) {
    return info.size === manifest.sizeBytes;
  }
  return false;
}

async function finishDownloadMeta(manifest: AndroidUpdateManifest, uri: string): Promise<string> {
  writePendingMeta({
    versionCode: manifest.versionCode,
    sha256: manifest.sha256,
    apkUrl: manifest.apkUrl,
    sizeBytes: manifest.sizeBytes,
  });
  mmkv.delete(SAVABLE_KEY);
  return uri;
}

async function downloadWithNativeOkHttp(
  manifest: AndroidUpdateManifest,
  dest: string,
  onProgress?: (fraction: number | undefined) => void,
): Promise<string> {
  const expected =
    typeof manifest.sizeBytes === "number" && manifest.sizeBytes > 0 ? manifest.sizeBytes : 0;

  // DownloadManager progress comes from native events (file may not exist until done).
  const subscription = addDownloadProgressListener((event) => {
    if (!onProgress || cancelRequested) return;
    const total = event.total > 0 ? event.total : expected;
    if (total > 0 && event.written >= 0) {
      onProgress(Math.min(1, Math.max(0, event.written / total)));
    } else if (event.written > 0) {
      onProgress(undefined);
    }
  });

  try {
    const result = await nativeDownloadFile(manifest.apkUrl, dest);
    if (cancelRequested) throw new Error("CANCELLED");
    onProgress?.(1);
    return result.uri;
  } catch (e) {
    if (cancelRequested) throw new Error("CANCELLED");
    const code =
      e && typeof e === "object" && "code" in e ? String((e as { code?: string }).code) : "";
    if (code === "E_CANCELLED") throw new Error("CANCELLED");
    const detail =
      e instanceof Error && e.message.trim().length > 0
        ? e.message.trim()
        : e && typeof e === "object" && "message" in e
          ? String((e as { message?: string }).message ?? "")
          : "";
    throw new Error(detail || "DOWNLOAD_FAILED");
  } finally {
    subscription.remove();
  }
}

async function downloadWithExpoResumable(
  manifest: AndroidUpdateManifest,
  dest: string,
  onProgress?: (fraction: number | undefined) => void,
): Promise<string> {
  const expected =
    typeof manifest.sizeBytes === "number" && manifest.sizeBytes > 0 ? manifest.sizeBytes : 0;

  const download = createDownloadResumable(
    manifest.apkUrl,
    dest,
    {
      headers: {
        Accept: "*/*",
        "User-Agent": "FloraSocial-Android",
      },
    },
    (data) => {
      if (!onProgress || cancelRequested) return;
      const total =
        data.totalBytesExpectedToWrite > 0 ? data.totalBytesExpectedToWrite : expected;
      if (total > 0) {
        onProgress(Math.min(1, Math.max(0, data.totalBytesWritten / total)));
      } else if (data.totalBytesWritten > 0) {
        onProgress(undefined);
      }
    },
  );

  activeDownload = download;
  try {
    const result = await download.downloadAsync();
    if (cancelRequested || !result?.uri) throw new Error("CANCELLED");
    onProgress?.(1);
    return result.uri;
  } finally {
    if (activeDownload === download) activeDownload = null;
  }
}

export async function downloadApkResumable(
  manifest: AndroidUpdateManifest,
  onProgress?: (fraction: number | undefined) => void,
): Promise<string> {
  if (cancelRequested) throw new Error("CANCELLED");

  await ensureUpdateDir();
  const dest = getPendingApkUri();

  const existing = readPendingMeta();
  if (existing) {
    const info = await getInfoAsync(dest);
    if (isCompletePending(info, manifest, existing)) {
      if (cancelRequested) throw new Error("CANCELLED");
      onProgress?.(1);
      return dest;
    }
  }

  mmkv.delete(SAVABLE_KEY);
  await clearPendingApk();
  if (cancelRequested) throw new Error("CANCELLED");
  await ensureUpdateDir();

  // Prefer native OkHttp — Expo DownloadResumable stalls on GitHub redirects.
  const uri = canNativeDownload()
    ? await downloadWithNativeOkHttp(manifest, dest, onProgress)
    : await downloadWithExpoResumable(manifest, dest, onProgress);

  return finishDownloadMeta(manifest, uri);
}
