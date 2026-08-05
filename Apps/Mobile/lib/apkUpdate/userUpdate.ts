import { Linking } from "react-native";
import {
  canRequestPackageInstalls,
  getNativeUpdateDir,
  getNativeUpdateState,
} from "flora-apk-updater";
import { isApkUpdaterNativeReady } from "@/lib/apkUpdate/capabilities";
import { checkAndInstall, cancelInteractiveApkUpdate } from "@/lib/apkUpdate/checkAndInstall";
import {
  fetchDirectUpdateManifestForVersion,
  fetchUpdateManifestFromNotificationText,
  type AndroidUpdateManifest,
} from "@/lib/apkUpdate/channelRelease";
import type { ApkUpdateProgressListener } from "@/lib/apkUpdate/progress";
import {
  parseAppUpdateVersionFromText,
  resolveAppUpdateApkDownloadUrl,
} from "@/lib/appLinks";
import { getPendingApkUri, isApkUpdateCancelled } from "@/lib/apkUpdate/download";
import { getInfoAsync } from "expo-file-system/legacy";

export type UserUpdateResult =
  | {
      ok: true;
      status: "installed" | "pending_user_action" | "up_to_date" | "cancelled" | "opened_channel";
    }
  | { ok: false; error: string; code?: string };

/**
 * 2.4 — open direct Flora channel APK URL in the browser/downloader.
 * Never prompts REQUEST_INSTALL_PACKAGES; that permission is only for in-app PackageInstaller.
 */
async function openChannelApkFallback(notificationText: string): Promise<UserUpdateResult> {
  const url = resolveAppUpdateApkDownloadUrl(notificationText);
  await Linking.openURL(url);
  return { ok: true, status: "opened_channel" };
}

async function resolveManifest(notificationText: string): Promise<AndroidUpdateManifest | null> {
  const version = parseAppUpdateVersionFromText(notificationText);
  if (!version) return null;

  const fromJson = await fetchDirectUpdateManifestForVersion(version).catch(() => null);
  if (fromJson) return fromJson;

  return fetchUpdateManifestFromNotificationText(notificationText).catch(() => null);
}

async function pendingMatchesVersion(versionCode: number | null): Promise<boolean> {
  if (versionCode == null) return false;
  const state = getNativeUpdateState();
  const phaseOk =
    state?.phase === "READY" ||
    state?.phase === "INSTALL_SCHEDULED" ||
    state?.phase === "INSTALLING";
  if (phaseOk && state?.versionCode === versionCode) {
    const uri = getPendingApkUri();
    const info = await getInfoAsync(uri).catch(() => null);
    return !!info?.exists && (info.size ?? 0) > 0;
  }
  // Also accept JS download path pending file when native state lags.
  const dir = getNativeUpdateDir();
  if (!dir) return false;
  const info = await getInfoAsync(`file://${dir.replace(/\/+$/, "")}/pending.apk`).catch(
    () => null,
  );
  return !!info?.exists && (info.size ?? 0) > 0 && state?.versionCode === versionCode;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for native DownloadManager of the same versionCode to reach READY / install. */
async function waitForNativeDownloadReady(
  versionCode: number,
  onProgress?: ApkUpdateProgressListener,
): Promise<"ready" | "failed" | "cancelled"> {
  const report = onProgress ?? (() => undefined);
  report({ phase: "downloading", message: "Ожидание загрузки…" });

  for (let i = 0; i < 600; i++) {
    if (isApkUpdateCancelled()) return "cancelled";
    const state = getNativeUpdateState();
    if (!state || state.versionCode !== versionCode) {
      await sleep(500);
      continue;
    }
    if (
      state.phase === "READY" ||
      state.phase === "INSTALL_SCHEDULED" ||
      state.phase === "INSTALLING"
    ) {
      // INSTALLING: silent path already committing — treat as ready for 2.1 / UI.
      if (state.phase === "INSTALLING") {
        report({ phase: "installing", message: "Установка…" });
      }
      return "ready";
    }
    if (state.phase === "FAILED" || state.phase === "IDLE") {
      return "failed";
    }
    if (state.phase === "DOWNLOADING") {
      report({ phase: "downloading", message: "Загрузка обновления…" });
    }
    await sleep(500);
  }
  return "failed";
}

/**
 * Button «Обновить»: 2.1 install-only / 2.2 download+install /
 * 2.4 Flora channel APK download (no REQUEST_INSTALL_PACKAGES prompt).
 */
export async function runUserUpdateFromNotification(
  notificationText: string,
  onProgress?: ApkUpdateProgressListener,
): Promise<UserUpdateResult> {
  const report = onProgress ?? (() => undefined);

  if (!isApkUpdaterNativeReady()) {
    report({ phase: "checking", message: "Открытие загрузки APK…" });
    return openChannelApkFallback(notificationText);
  }

  report({ phase: "checking" });
  const manifest = await resolveManifest(notificationText);
  if (!manifest) {
    report({ phase: "checking", message: "Открытие загрузки APK…" });
    const fallback = await openChannelApkFallback(notificationText).catch(() => null);
    return (
      fallback ?? {
        ok: false,
        error: "Не удалось разобрать версию в уведомлении",
        code: "NO_MANIFEST",
      }
    );
  }

  const hasPerm = canRequestPackageInstalls();

  // Without install permission — browser/channel APK download only.
  if (!hasPerm) {
    report({ phase: "checking", message: "Открытие загрузки APK…" });
    return openChannelApkFallback(notificationText);
  }

  // Native auto path already in flight for this version → wait / join, don't start a second DM.
  const nativeState = getNativeUpdateState();
  if (
    manifest.versionCode != null &&
    nativeState?.versionCode === manifest.versionCode &&
    (nativeState.phase === "DOWNLOADING" ||
      nativeState.phase === "INSTALL_SCHEDULED" ||
      nativeState.phase === "INSTALLING")
  ) {
    if (nativeState.phase === "INSTALLING") {
      report({ phase: "installing", message: "Установка…" });
      return { ok: true, status: "pending_user_action" };
    }
    if (nativeState.phase === "DOWNLOADING") {
      const waited = await waitForNativeDownloadReady(manifest.versionCode, onProgress);
      if (waited === "cancelled") return { ok: true, status: "cancelled" };
      if (waited === "failed") {
        // Fall through to 2.2 interactive download.
      } else {
        const after = getNativeUpdateState();
        if (after?.phase === "INSTALLING" && after.versionCode === manifest.versionCode) {
          report({ phase: "installing", message: "Установка…" });
          return { ok: true, status: "pending_user_action" };
        }
        if (await pendingMatchesVersion(manifest.versionCode)) {
          report({ phase: "installing", message: "Установка…" });
          const uri = getPendingApkUri();
          const result = await checkAndInstall({
            allowUserAction: true,
            force: true,
            manifest,
            onProgress,
            installOnlyUri: uri,
            skipPermissionModal: true,
          });
          if (!result.ok) {
            if (result.code === "INSTALL" || result.code === "NO_PERMISSION") {
              return openChannelApkFallback(notificationText);
            }
            return result;
          }
          return {
            ok: true,
            status:
              result.status === "pending_user_action"
                ? "pending_user_action"
                : result.status === "cancelled"
                  ? "cancelled"
                  : result.status === "up_to_date"
                    ? "up_to_date"
                    : "installed",
          };
        }
      }
    }
    // INSTALL_SCHEDULED or READY after wait — fall through to 2.1.
  }

  // 2.1 — READY matching version → install only (interactive, foreground OK).
  if (await pendingMatchesVersion(manifest.versionCode)) {
    report({ phase: "installing", message: "Установка…" });
    const uri = getPendingApkUri();
    const result = await checkAndInstall({
      allowUserAction: true,
      force: true,
      manifest,
      onProgress,
      installOnlyUri: uri,
      skipPermissionModal: true,
    });
    if (!result.ok) {
      if (result.code === "INSTALL" || result.code === "NO_PERMISSION") {
        return openChannelApkFallback(notificationText);
      }
      return result;
    }
    return {
      ok: true,
      status:
        result.status === "pending_user_action"
          ? "pending_user_action"
          : result.status === "cancelled"
            ? "cancelled"
            : result.status === "up_to_date"
              ? "up_to_date"
              : "installed",
    };
  }

  // 2.2 — permission already granted: download + interactive install (channel URL).
  const result = await checkAndInstall({
    allowUserAction: true,
    force: true,
    manifest,
    onProgress,
    skipPermissionModal: true,
  });

  if (result.ok && result.status === "cancelled") {
    return { ok: true, status: "cancelled" };
  }

  if (!result.ok) {
    if (
      result.code === "DOWNLOAD" ||
      result.code === "INSTALL" ||
      result.code === "NO_PERMISSION" ||
      result.code === "SHA256" ||
      result.code === "NO_NATIVE" ||
      result.code === "CHANNEL"
    ) {
      try {
        return await openChannelApkFallback(notificationText);
      } catch {
        return result;
      }
    }
    return result;
  }

  return {
    ok: true,
    status:
      result.status === "pending_user_action"
        ? "pending_user_action"
        : result.status === "up_to_date"
          ? "up_to_date"
          : "installed",
  };
}

export { cancelInteractiveApkUpdate };
