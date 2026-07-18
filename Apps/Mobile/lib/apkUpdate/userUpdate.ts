import { Linking } from "react-native";
import {
  canRequestPackageInstalls,
  getNativeUpdateDir,
  getNativeUpdateState,
  requestInstallPermission,
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
  resolveAppUpdateReleasePageUrl,
} from "@/lib/appLinks";
import { getPendingApkUri } from "@/lib/apkUpdate/download";
import { getInfoAsync } from "expo-file-system/legacy";

export type UserUpdateResult =
  | { ok: true; status: "installed" | "pending_user_action" | "up_to_date" | "cancelled" | "opened_github" }
  | { ok: false; error: string; code?: string };

async function openGitHubFallback(notificationText: string): Promise<UserUpdateResult> {
  await Linking.openURL(resolveAppUpdateReleasePageUrl(notificationText));
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
 * Button «Обновить»: 2.1 install-only / 2.2 download+install / 2.3 interactive /
 * 2.4 GitHub fallback.
 */
export async function runUserUpdateFromNotification(
  notificationText: string,
  onProgress?: ApkUpdateProgressListener,
): Promise<UserUpdateResult> {
  const report = onProgress ?? (() => undefined);

  if (!isApkUpdaterNativeReady()) {
    report({ phase: "checking", message: "Открытие страницы релиза…" });
    return openGitHubFallback(notificationText);
  }

  report({ phase: "checking" });
  const manifest = await resolveManifest(notificationText);
  if (!manifest) {
    report({ phase: "error", message: "Не удалось разобрать версию в уведомлении" });
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

  // 2.1 — READY matching version → install only (interactive, foreground OK).
  if (hasPerm && (await pendingMatchesVersion(manifest.versionCode))) {
    report({ phase: "installing", message: "Установка…" });
    const uri = getPendingApkUri();
    const result = await checkAndInstall({
      allowUserAction: true,
      force: true,
      manifest,
      onProgress,
      installOnlyUri: uri,
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

  // 2.2 (with perm) / 2.3 (without): download + interactive install.
  // 2.3: do not show Flora auto-update permission modal; open Settings only on E_NO_PERMISSION.
  if (!hasPerm) {
    report({ phase: "permission" });
    const granted = await requestInstallPermission();
    if (!granted && !canRequestPackageInstalls()) {
      report({
        phase: "error",
        message: "Нужно разрешить установку из этого источника",
        code: "NO_PERMISSION",
      });
      // One Settings attempt already done by requestInstallPermission; fallback GitHub.
      return openGitHubFallback(notificationText);
    }
  }

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
