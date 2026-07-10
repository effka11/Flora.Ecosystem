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
 * Full GitHub silent self-update path (production sideload APK only).
 * Dev client has the native module for permission testing, but not silent updates.
 */
export function isSideloadUpdatesEnabled(): boolean {
  if (!isApkUpdaterNativeReady()) return false;
  return readSideloadExtra();
}

/**
 * Post-login / interactive install-unknown-apps prompt.
 * Never on Play Store builds; Dev + sideload release only (native module present).
 */
export function canPromptInstallPermission(): boolean {
  if (Platform.OS !== "android") return false;
  if (isPlayStoreBuildRuntime()) return false;
  return isApkUpdaterNativeReady();
}
