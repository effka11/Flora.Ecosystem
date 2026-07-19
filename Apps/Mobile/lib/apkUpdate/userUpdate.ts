import { Linking } from "react-native";
import {
  canRequestPackageInstalls,
  getNativeUpdateDir,
  getNativeUpdateState,
} from "flora-apk-updater";
import { isApkUpdaterNativeReady } from "@/lib/apkUpdate/capabilities";
import { checkAndInstall, cancelInteractiveApkUpdate } from "@/lib/apkUpdate/checkAndInstall";
import {
  buildDirectUpdateManifestFromNotificationText,
  fetchDirectUpdateManifestForVersion,
  type AndroidUpdateManifest,
} from "@/lib/apkUpdate/githubRelease";
import type { ApkUpdateProgressListener } from "@/lib/apkUpdate/progress";
import {
  parseAppUpdateVersionFromText,
  resolveAppUpdateApkDownloadUrl,
} from "@/lib/appLinks";
import { getPendingApkUri } from "@/lib/apkUpdate/download";
import { getInfoAsync } from "expo-file-system/legacy";

export type UserUpdateResult =
  | { ok: true; status: "installed" | "pending_user_action" | "up_to_date" | "cancelled" | "opened_github" }
  | { ok: false; error: string; code?: string };

/**
 * 2.4 — browser/APK CDN download. Never prompts REQUEST_INSTALL_PACKAGES
 * (unknown-sources); that permission is only for in-app PackageInstaller.
 */
async function openGitHubFallback(notificationText: string): Promise<UserUpdateResult> {
  const url = resolveAppUpdateApkDownloadUrl(notificationText);
  await Linking.openURL(url);
  return { ok: true, status: "opened_github" };
}

async function resolveManifest(notificationText: string): Promise<AndroidUpdateManifest | null> {
  const version = parseAppUpdateVersionFromText(notificationText);
  if (!version) return null;

  const fromJson = await fetchDirectUpdateManifestForVersion(version).catch(() => null);
  if (fromJson) return fromJson;

  return buildDirectUpdateManifestFromNotificationText(notificationText);
}

async function pendingMatchesVersion(versionCode: number | null): Promise<boolean> {
  if (versionCode == null) return false;
  const state = getNativeUpdateState();
  if (state?.phase === "READY" && state.versionCode === versionCode) {
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

/**
 * Button «Обновить»: 2.1 install-only / 2.2 download+install /
 * 2.4 GitHub APK download (no REQUEST_INSTALL_PACKAGES prompt).
 */
export async function runUserUpdateFromNotification(
  notificationText: string,
  onProgress?: ApkUpdateProgressListener,
): Promise<UserUpdateResult> {
  const report = onProgress ?? (() => undefined);

  if (!isApkUpdaterNativeReady()) {
    report({ phase: "checking", message: "Открытие загрузки APK…" });
    return openGitHubFallback(notificationText);
  }

  report({ phase: "checking" });
  const manifest = await resolveManifest(notificationText);
  if (!manifest) {
    report({ phase: "checking", message: "Открытие загрузки APK…" });
    const fallback = await openGitHubFallback(notificationText).catch(() => null);
    return (
      fallback ?? {
        ok: false,
        error: "Не удалось разобрать версию в уведомлении",
        code: "NO_MANIFEST",
      }
    );
  }

  const hasPerm = canRequestPackageInstalls();

  // Without install permission — browser APK download only (no Settings / unknown-sources).
  if (!hasPerm) {
    report({ phase: "checking", message: "Открытие загрузки APK…" });
    return openGitHubFallback(notificationText);
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
        return openGitHubFallback(notificationText);
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

  // 2.2 — permission already granted: download + interactive install.
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
      result.code === "GITHUB"
    ) {
      try {
        return await openGitHubFallback(notificationText);
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
