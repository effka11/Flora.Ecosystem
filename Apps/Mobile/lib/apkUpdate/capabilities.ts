import Constants from "expo-constants";
import { Platform } from "react-native";
import { isFloraApkUpdaterAvailable } from "flora-apk-updater";

type ApkUpdateExtra = {
  sideloadUpdates?: boolean;
  playStoreBuild?: boolean;
};

function readExtra(): ApkUpdateExtra {
  return (Constants.expoConfig?.extra as ApkUpdateExtra | undefined) ?? {};
}

/** EAS Play / AAB build (`FLORA_DISABLE_SIDELOAD_UPDATES=1` → extra.playStoreBuild). */
export function isPlayStoreBuildRuntime(): boolean {
  return readExtra().playStoreBuild === true;
}

function readSideloadExtra(): boolean {
  return readExtra().sideloadUpdates === true;
}

/** Native PackageInstaller module is linked (Dev or sideload release). */
export function isApkUpdaterNativeReady(): boolean {
  if (isPlayStoreBuildRuntime()) return false;
  return Platform.OS === "android" && isFloraApkUpdaterAvailable();
}

/**
 * Full GitHub sideload update path (production sideload APK only).
 * Used by interactive inbox «Обновить»; background auto-update is disabled.
 */
export function isSideloadUpdatesEnabled(): boolean {
  if (!isApkUpdaterNativeReady()) return false;
  return readSideloadExtra();
}

