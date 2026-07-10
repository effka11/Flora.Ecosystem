import { requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

export type InstallApkResult = {
  status: "success" | "pending_user_action";
  message: string;
};

type FloraApkUpdaterNativeModule = {
  isAvailable(): boolean;
  canRequestPackageInstalls(): boolean;
  sdkInt(): number;
  requestInstallPermission(): Promise<boolean>;
  sha256File(filePath: string): Promise<string>;
  installApk(filePath: string, allowUserAction: boolean): Promise<InstallApkResult>;
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

export default {
  isFloraApkUpdaterAvailable,
  canRequestPackageInstalls,
  getAndroidSdkInt,
  requestInstallPermission,
  sha256File,
  installApk,
};
