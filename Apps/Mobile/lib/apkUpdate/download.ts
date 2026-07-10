import {
  cacheDirectory,
  createDownloadResumable,
  getFreeDiskStorageAsync,
  makeDirectoryAsync,
  getInfoAsync,
  deleteAsync,
  type DownloadResumable,
} from "expo-file-system/legacy";
import { AppState, type AppStateStatus } from "react-native";
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
let appStateSub: { remove: () => void } | null = null;
let cancelRequested = false;

export function resetApkUpdateCancelFlag(): void {
  cancelRequested = false;
}

export function isApkUpdateCancelled(): boolean {
  return cancelRequested;
}

export function getPendingApkUri(): string {
  const base = cacheDirectory;
  if (!base) throw new Error("cacheDirectory unavailable");
  return `${base}${UPDATE_DIR}/${PENDING_NAME}`;
}

export function getUpdateDirUri(): string {
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

function detachAppState(): void {
  appStateSub?.remove();
  appStateSub = null;
}

export async function clearPendingApk(): Promise<void> {
  mmkv.delete(META_KEY);
  mmkv.delete(SAVABLE_KEY);
  activeDownload = null;
  detachAppState();
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
  const dl = activeDownload;
  activeDownload = null;
  detachAppState();
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

function attachAppStateHandlers(download: DownloadResumable): void {
  detachAppState();
  appStateSub = AppState.addEventListener("change", (state: AppStateStatus) => {
    if (state === "background" || state === "inactive") {
      void (async () => {
        try {
          await download.pauseAsync();
          mmkv.set(SAVABLE_KEY, JSON.stringify(download.savable()));
        } catch {
          // ignore pause errors
        }
      })();
    }
  });
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

type SavableState = {
  url: string;
  fileUri: string;
  options: object;
  resumeData?: string;
};

function readSavable(): SavableState | null {
  const raw = mmkv.getString(SAVABLE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SavableState;
  } catch {
    mmkv.delete(SAVABLE_KEY);
    return null;
  }
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

export async function downloadApkResumable(
  manifest: AndroidUpdateManifest,
  onProgress?: (fraction: number | undefined) => void,
): Promise<string> {
  if (cancelRequested) throw new Error("CANCELLED");

  await ensureUpdateDir();
  const dest = getPendingApkUri();

  const reportProgress = (written: number, expected: number) => {
    if (!onProgress || cancelRequested) return;
    if (expected > 0) {
      onProgress(Math.min(1, Math.max(0, written / expected)));
    } else {
      onProgress(undefined);
    }
  };

  const existing = readPendingMeta();
  if (existing) {
    const info = await getInfoAsync(dest);
    if (isCompletePending(info, manifest, existing)) {
      if (cancelRequested) throw new Error("CANCELLED");
      onProgress?.(1);
      return dest;
    }
  }

  const savable = readSavable();
  const canResume =
    savable != null &&
    savable.url === manifest.apkUrl &&
    savable.fileUri === dest &&
    Boolean(savable.resumeData);

  // Resume first — do NOT delete the partial APK while resumeData is valid.
  if (canResume && savable) {
    try {
      if (cancelRequested) throw new Error("CANCELLED");
      const download = createDownloadResumable(
        savable.url,
        savable.fileUri,
        savable.options ?? {},
        (data) => reportProgress(data.totalBytesWritten, data.totalBytesExpectedToWrite),
        savable.resumeData,
      );
      activeDownload = download;
      attachAppStateHandlers(download);
      try {
        const result = await download.resumeAsync();
        if (cancelRequested || !result?.uri) throw new Error("CANCELLED");
        onProgress?.(1);
        return await finishDownloadMeta(manifest, result.uri);
      } finally {
        detachAppState();
        if (activeDownload === download) activeDownload = null;
      }
    } catch (e) {
      if (cancelRequested || (e instanceof Error && e.message === "CANCELLED")) {
        throw new Error("CANCELLED");
      }
      mmkv.delete(SAVABLE_KEY);
      // Fall through to a clean download.
    }
  } else if (savable) {
    mmkv.delete(SAVABLE_KEY);
  }

  if (cancelRequested) throw new Error("CANCELLED");

  // Fresh download: wipe incomplete/wrong pending file.
  await clearPendingApk();
  if (cancelRequested) throw new Error("CANCELLED");
  await ensureUpdateDir();

  const download = createDownloadResumable(
    manifest.apkUrl,
    dest,
    {
      headers: { "User-Agent": "FloraSocial-Android" },
    },
    (data) => reportProgress(data.totalBytesWritten, data.totalBytesExpectedToWrite),
  );
  activeDownload = download;
  attachAppStateHandlers(download);
  try {
    const result = await download.downloadAsync();
    if (cancelRequested || !result?.uri) throw new Error("CANCELLED");
    onProgress?.(1);
    return await finishDownloadMeta(manifest, result.uri);
  } finally {
    detachAppState();
    if (activeDownload === download) activeDownload = null;
  }
}
