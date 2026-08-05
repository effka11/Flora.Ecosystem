import { Linking } from "react-native";
import {
  canRequestPackageInstalls,
  cancelNativeUpdate,
  getNativeUpdateState,
} from "flora-apk-updater";
import { reconcileInstallPermissionWithOs } from "@/lib/apkUpdate/autoUpdatePreference";
import { isApkUpdaterNativeReady } from "@/lib/apkUpdate/capabilities";
import { checkAndInstall, cancelInteractiveApkUpdate } from "@/lib/apkUpdate/checkAndInstall";
import {
  fetchDirectUpdateManifestForVersion,
  fetchLatestUpdateManifest,
  fetchUpdateManifestFromNotificationText,
  getInstalledVersionCode,
  invalidateChannelManifestCache,
  type AndroidUpdateManifest,
} from "@/lib/apkUpdate/channelRelease";
import type { ApkUpdateProgressListener } from "@/lib/apkUpdate/progress";
import { openInstallPermissionPrompt } from "@/lib/apkUpdate/installPermissionPrompt";
import {
  parseAppUpdateVersionFromText,
  resolveAppUpdateApkDownloadUrl,
} from "@/lib/appLinks";
import { getPendingApkUri, isApkUpdateCancelled, clearPendingApk } from "@/lib/apkUpdate/download";
import { getInfoAsync } from "expo-file-system/legacy";

const NO_PERMISSION_ERROR = "Нужно разрешить установку из этого источника";

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

function noPermissionResult(): UserUpdateResult {
  return { ok: false, error: NO_PERMISSION_ERROR, code: "NO_PERMISSION" };
}

async function resolveManifest(notificationText: string): Promise<AndroidUpdateManifest | null> {
  const version = parseAppUpdateVersionFromText(notificationText);
  if (!version) return null;

  const fromJson = await fetchDirectUpdateManifestForVersion(version).catch(() => null);
  if (fromJson) return fromJson;

  return fetchUpdateManifestFromNotificationText(notificationText).catch(() => null);
}

async function pendingMatchesVersion(
  versionCode: number | null,
  expectedSizeBytes?: number,
): Promise<boolean> {
  if (versionCode == null) return false;
  const state = getNativeUpdateState();
  // Never treat an in-progress / failed partial file as installable (SHA would fail).
  const phaseOk =
    state?.phase === "READY" ||
    state?.phase === "INSTALL_SCHEDULED" ||
    state?.phase === "INSTALLING";
  if (!phaseOk || state?.versionCode !== versionCode) return false;

  const uri = getPendingApkUri();
  const info = await getInfoAsync(uri).catch(() => null);
  if (!info?.exists || (info.size ?? 0) <= 0) return false;

  const sizeHint = expectedSizeBytes ?? state.sizeBytes ?? undefined;
  if (typeof sizeHint === "number" && sizeHint > 0 && info.size !== sizeHint) {
    return false;
  }
  return true;
}

/**
 * When native already verified pending.apk, prefer its sha256 over a possibly stale
 * channel cache (304 / MMKV body with an old hash).
 */
function manifestFromNativeReady(
  fallback: AndroidUpdateManifest,
): AndroidUpdateManifest {
  const state = getNativeUpdateState();
  if (
    !state ||
    (state.phase !== "READY" &&
      state.phase !== "INSTALL_SCHEDULED" &&
      state.phase !== "INSTALLING")
  ) {
    return fallback;
  }
  const sha = state.sha256?.trim().toLowerCase() ?? "";
  if (!/^[a-f0-9]{64}$/.test(sha)) return fallback;
  if (state.versionCode == null || state.versionCode !== fallback.versionCode) {
    return fallback;
  }
  const version =
    typeof state.version === "string" && state.version.trim().length > 0
      ? state.version.trim()
      : fallback.version;
  const apkUrl =
    typeof state.apkUrl === "string" && state.apkUrl.trim().length > 0
      ? state.apkUrl.trim()
      : fallback.apkUrl;
  return {
    ...fallback,
    version,
    versionCode: state.versionCode,
    apkUrl,
    sha256: sha,
    sizeBytes:
      typeof state.sizeBytes === "number" && state.sizeBytes > 0
        ? state.sizeBytes
        : fallback.sizeBytes,
  };
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
 * Button «Обновить»: soft OS permission prompt → 2.1 install-only / 2.2 download+install /
 * 2.4 Flora channel APK only for NO_NATIVE / missing manifest (not for permission decline).
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

  // Permission gate BEFORE any progress report (avoids double modal with InstallPermissionHost).
  let hasPerm = false;
  try {
    hasPerm = canRequestPackageInstalls();
  } catch {
    hasPerm = false;
  }

  if (!hasPerm) {
    const granted = await openInstallPermissionPrompt();
    try {
      hasPerm = granted && canRequestPackageInstalls();
    } catch {
      hasPerm = false;
    }
    if (!hasPerm) {
      return noPermissionResult();
    }
  }

  reconcileInstallPermissionWithOs();
  report({ phase: "checking" });

  // Prefer channel latest when newer than installed — inbox text may lag the live channel.
  const installed = getInstalledVersionCode();
  let fromNotif = await resolveManifest(notificationText);
  let latest = await fetchLatestUpdateManifest().catch(() => null);
  let manifest = fromNotif;
  if (
    latest?.versionCode != null &&
    latest.versionCode > installed &&
    (manifest?.versionCode == null || latest.versionCode >= manifest.versionCode)
  ) {
    manifest = latest;
  }
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

  // Join native auto download / READY for this versionCode.
  let nativeState = getNativeUpdateState();
  const nativeVc = nativeState?.versionCode ?? null;
  const joinNative =
    nativeVc != null &&
    manifest.versionCode != null &&
    nativeVc === manifest.versionCode &&
    (nativeState?.phase === "DOWNLOADING" ||
      nativeState?.phase === "INSTALL_SCHEDULED" ||
      nativeState?.phase === "INSTALLING" ||
      nativeState?.phase === "READY");

  if (joinNative) {
    if (nativeState?.phase === "INSTALLING") {
      report({ phase: "installing", message: "Установка…" });
      return { ok: true, status: "pending_user_action" };
    }
    if (nativeState?.phase === "DOWNLOADING") {
      const waited = await waitForNativeDownloadReady(manifest.versionCode!, onProgress);
      if (waited === "cancelled") return { ok: true, status: "cancelled" };
      if (waited === "failed") {
        // Fall through to 2.2.
      } else {
        const after = getNativeUpdateState();
        if (after?.phase === "INSTALLING" && after.versionCode === manifest.versionCode) {
          report({ phase: "installing", message: "Установка…" });
          return { ok: true, status: "pending_user_action" };
        }
      }
    }
  }

  nativeState = getNativeUpdateState();
  const nativeReady =
    nativeState?.phase === "READY" || nativeState?.phase === "INSTALL_SCHEDULED";
  // Native already hashed pending.apk — use that sha256 (avoids stale channel cache).
  if (nativeReady) {
    manifest = manifestFromNativeReady(manifest);
  }

  const tryInstallOnly = async (
    m: AndroidUpdateManifest,
  ): Promise<UserUpdateResult | "redownload" | null> => {
    if (!(await pendingMatchesVersion(m.versionCode, m.sizeBytes))) return null;
    report({ phase: "installing", message: "Установка…" });
    const uri = getPendingApkUri();
    const nativeVerified =
      getNativeUpdateState()?.phase === "READY" ||
      getNativeUpdateState()?.phase === "INSTALL_SCHEDULED";
    const result = await checkAndInstall({
      allowUserAction: true,
      force: true,
      manifest: m,
      onProgress,
      installOnlyUri: uri,
      skipPermissionModal: true,
      // Native UpdateCoordinator already SHA-checked this pending.apk.
      skipShaVerify: nativeVerified,
      keepPendingOnShaMismatch: true,
    });
    if (result.ok) {
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
    if (result.code === "NO_PERMISSION") {
      return noPermissionResult();
    }
    if (result.code === "SHA256") {
      invalidateChannelManifestCache();
      const fresh = await fetchLatestUpdateManifest().catch(() => null);
      try {
        cancelNativeUpdate();
      } catch {
        // ignore
      }
      await clearPendingApk().catch(() => undefined);
      if (fresh) manifest = fresh;
      return "redownload";
    }
    return result;
  };

  const installedOnly = await tryInstallOnly(manifest);
  if (installedOnly && installedOnly !== "redownload") return installedOnly;

  // Stop auto DownloadManager before interactive download (same pending.apk path).
  try {
    cancelNativeUpdate();
  } catch {
    // ignore
  }

  // 2.2 — fresh download + interactive install (one attempt; no install-only SHA dance).
  invalidateChannelManifestCache();
  latest = await fetchLatestUpdateManifest().catch(() => null);
  if (latest?.versionCode != null && latest.versionCode >= (manifest.versionCode ?? 0)) {
    manifest = latest;
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
    if (result.code === "NO_PERMISSION") {
      return noPermissionResult();
    }
    if (result.code === "NO_NATIVE" || result.code === "CHANNEL") {
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
