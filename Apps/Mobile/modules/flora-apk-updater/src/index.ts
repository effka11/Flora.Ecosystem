import { requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

export type InstallApkResult = {
  status: "success" | "pending_user_action";
  message: string;
};

export type DownloadFileResult = {
  uri: string;
  bytes: number;
};

export type DownloadProgressEvent = {
  written: number;
  total: number;
};

export type NativeUpdateState = {
  phase: string;
  version?: string | null;
  versionCode?: number | null;
  apkUrl?: string | null;
  sha256?: string | null;
  sizeBytes?: number | null;
  lastError?: string | null;
  downloadId?: number | null;
};

export type NativeUpdateManifest = {
  version: string;
  versionCode: number;
  apkUrl: string;
  sha256: string;
  sizeBytes?: number | null;
  notificationUuid?: string | null;
  text?: string | null;
};

type FloraApkUpdaterNativeModule = {
  isAvailable(): boolean;
  canRequestPackageInstalls(): boolean;
  sdkInt(): number;
  getUpdateDir(): string;
  getUpdateState(): NativeUpdateState;
  startAutoUpdate(manifest: NativeUpdateManifest): Promise<NativeUpdateState>;
  cancelUpdate(): boolean;
  requestInstallPermission(): Promise<boolean>;
  sha256File(filePath: string): Promise<string>;
  installApk(filePath: string, allowUserAction: boolean): Promise<InstallApkResult>;
  downloadFile(url: string, filePath: string): Promise<DownloadFileResult>;
  cancelDownload(): boolean;
  addListener?(
    eventName: "onDownloadProgress",
    listener: (event: DownloadProgressEvent) => void,
  ): { remove: () => void };
};

const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<FloraApkUpdaterNativeModule>("FloraApkUpdater")
    : null;

export function isFloraApkUpdaterAvailable(): boolean {
  return native != null && native.isAvailable();
}

export function canRequestPackageInstalls(): boolean {
  if (!native) return false;
  return native.canRequestPackageInstalls();
}

export function getAndroidSdkInt(): number {
  if (!native) return 0;
  return native.sdkInt();
}

export function getNativeUpdateDir(): string | null {
  if (!native || typeof native.getUpdateDir !== "function") return null;
  try {
    const dir = native.getUpdateDir();
    return dir && dir.length > 0 ? dir : null;
  } catch {
    return null;
  }
}

export function getNativeUpdateState(): NativeUpdateState | null {
  if (!native || typeof native.getUpdateState !== "function") return null;
  try {
    return native.getUpdateState();
  } catch {
    return null;
  }
}

export async function startNativeAutoUpdate(
  manifest: NativeUpdateManifest,
): Promise<NativeUpdateState | null> {
  if (!native || typeof native.startAutoUpdate !== "function") return null;
  return native.startAutoUpdate(manifest);
}

export function cancelNativeUpdate(): void {
  if (native && typeof native.cancelUpdate === "function") {
    native.cancelUpdate();
    return;
  }
  native?.cancelDownload();
}

export async function requestInstallPermission(): Promise<boolean> {
  if (!native) return false;
  return native.requestInstallPermission();
}

export async function sha256File(filePath: string): Promise<string> {
  if (!native) throw new Error("FloraApkUpdater is Android-only");
  return native.sha256File(filePath);
}

export async function installApk(
  filePath: string,
  allowUserAction: boolean,
): Promise<InstallApkResult> {
  if (!native) throw new Error("FloraApkUpdater is Android-only");
  return native.installApk(filePath, allowUserAction);
}

export function canNativeDownload(): boolean {
  return native != null && typeof native.downloadFile === "function";
}

export async function downloadFile(
  url: string,
  filePath: string,
): Promise<DownloadFileResult> {
  if (!native) throw new Error("FloraApkUpdater is Android-only");
  return native.downloadFile(url, filePath);
}

export function cancelNativeDownload(): void {
  native?.cancelDownload();
}

export function addDownloadProgressListener(
  listener: (event: DownloadProgressEvent) => void,
): { remove: () => void } {
  if (!native || typeof native.addListener !== "function") {
    return { remove: () => undefined };
  }
  return native.addListener("onDownloadProgress", listener);
}

export default {
  isFloraApkUpdaterAvailable,
  canRequestPackageInstalls,
  getAndroidSdkInt,
  getNativeUpdateDir,
  getNativeUpdateState,
  startNativeAutoUpdate,
  cancelNativeUpdate,
  requestInstallPermission,
  sha256File,
  installApk,
  canNativeDownload,
  downloadFile,
  cancelNativeDownload,
  addDownloadProgressListener,
};
