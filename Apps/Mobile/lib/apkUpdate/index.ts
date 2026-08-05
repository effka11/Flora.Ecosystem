export {
  isApkUpdaterNativeReady,
  isPlayStoreBuildRuntime,
  isSideloadUpdatesEnabled,
} from "@/lib/apkUpdate/capabilities";
export {
  isAutoUpdateEnabled,
  isInAppUpdatesEnabled,
  reconcileInstallPermissionWithOs,
  setAutoUpdateEnabled,
  setInAppUpdatesEnabled,
  subscribeUpdatePreferences,
} from "@/lib/apkUpdate/autoUpdatePreference";
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
  invalidateChannelManifestCache,
} from "@/lib/apkUpdate/channelRelease";
export {
  labelForApkUpdatePhase,
  type ApkUpdatePhase,
  type ApkUpdateProgress,
  type ApkUpdateProgressListener,
} from "@/lib/apkUpdate/progress";
export { runUserUpdateFromNotification } from "@/lib/apkUpdate/userUpdate";
export { openInstallPermissionPrompt } from "@/lib/apkUpdate/installPermissionPrompt";
