export {
  canPromptInstallPermission,
  isApkUpdaterNativeReady,
  isPlayStoreBuildRuntime,
  isSideloadUpdatesEnabled,
} from "@/lib/apkUpdate/capabilities";
export {
  canInstallSilently,
  cancelInteractiveApkUpdate,
  checkAndInstall,
  ensureInstallPackagesPermission,
  runSilentUpdateCheck,
} from "@/lib/apkUpdate/checkAndInstall";
export {
  fetchLatestUpdateManifest,
  fetchUpdateManifestFromNotificationText,
  getInstalledVersionCode,
} from "@/lib/apkUpdate/githubRelease";
export {
  labelForApkUpdatePhase,
  type ApkUpdatePhase,
  type ApkUpdateProgress,
  type ApkUpdateProgressListener,
} from "@/lib/apkUpdate/progress";
