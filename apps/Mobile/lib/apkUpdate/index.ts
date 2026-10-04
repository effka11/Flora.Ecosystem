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
export { isOfficialChannelRelease } from "@/lib/apkUpdate/channelOfficiality";
export {
  fetchChannelCatalog,
  fetchLatestUpdateManifest,
  fetchUpdateManifestFromNotificationText,
  fetchDirectUpdateManifestForVersion,
  getInstalledVersionCode,
  invalidateChannelManifestCache,
  resolveInstalledBuildOfficiality,
  type AndroidUpdateManifest,
  type InstalledBuildOfficiality,
} from "@/lib/apkUpdate/channelRelease";
export {
  labelForApkUpdatePhase,
  type ApkUpdatePhase,
  type ApkUpdateProgress,
  type ApkUpdateProgressListener,
} from "@/lib/apkUpdate/progress";
export {
  runUserUpdateCheck,
  runUserUpdateFromNotification,
} from "@/lib/apkUpdate/userUpdate";
export { openInstallPermissionPrompt } from "@/lib/apkUpdate/installPermissionPrompt";
export {
  FLORA_APK_UPDATE_CHANNELS,
  getUpdateChannelId,
  labelForUpdateChannel,
  setUpdateChannelId,
  type FloraApkUpdateChannelId,
  type FloraApkUpdateChannelOption,
} from "@/lib/apkUpdate/updateChannel";
