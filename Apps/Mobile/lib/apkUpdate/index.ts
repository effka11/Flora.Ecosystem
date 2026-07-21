export {
  isApkUpdaterNativeReady,
  isPlayStoreBuildRuntime,
  isSideloadUpdatesEnabled,
} from "@/lib/apkUpdate/capabilities";
export {
  runAppUpdateCatchUp,
  runAutoUpdateFromManifest,
  runAutoUpdateFromRealtime,
} from "@/lib/apkUpdate/autoUpdate";
export {
  canInstallSilently,
  cancelInteractiveApkUpdate,
  checkAndInstall,
  runSilentUpdateCheck,
} from "@/lib/apkUpdate/checkAndInstall";
export {
  fetchLatestUpdateManifest,
  fetchUpdateManifestFromNotificationText,
  fetchDirectUpdateManifestForVersion,
  getInstalledVersionCode,
} from "@/lib/apkUpdate/githubRelease";
export {
  labelForApkUpdatePhase,
  type ApkUpdatePhase,
  type ApkUpdateProgress,
  type ApkUpdateProgressListener,
} from "@/lib/apkUpdate/progress";
export { runUserUpdateFromNotification } from "@/lib/apkUpdate/userUpdate";
