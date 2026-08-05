import {
  canRequestPackageInstalls,
  getAndroidSdkInt,
  installApk,
  setNativeUiOwnsPending,
  sha256File,
} from "flora-apk-updater";
import { getInfoAsync } from "expo-file-system/legacy";
import {
  isApkUpdaterNativeReady,
  isSideloadUpdatesEnabled,
} from "@/lib/apkUpdate/capabilities";
import {
  assertEnoughDiskSpace,
  cancelApkUpdateAndClearCache,
  cleanupStalePending,
  clearPendingApk,
  downloadApkResumable,
  isApkUpdateCancelled,
  readPendingMeta,
  resetApkUpdateCancelFlag,
} from "@/lib/apkUpdate/download";
import {
  fetchLatestUpdateManifest,
  getInstalledVersionCode,
  type AndroidUpdateManifest,
} from "@/lib/apkUpdate/channelRelease";
import {
  normalizeTrustedSha256,
  trustedFloraSocialApkVersion,
} from "@/lib/apkUpdate/manifestSecurity";
import type { ApkUpdateProgressListener } from "@/lib/apkUpdate/progress";
import { compareFloraSocialVersions, getFloraSocialAppVersion } from "@/lib/appLinks";
import { mmkv } from "@/lib/mmkv";

const LAST_CHECK_KEY = "apkUpdate.lastCheckAt";
const THROTTLE_MS = 12 * 60 * 60 * 1000;

export type CheckAndInstallOptions = {
  allowUserAction: boolean;
  /** Skip throttle (notification tap). */
  force?: boolean;
  /** Optional manifest override (e.g. from notification when channel latest JSON misses the version). */
  manifest?: AndroidUpdateManifest | null;
  /** Interactive UI progress (ignored on silent path). */
  onProgress?: ApkUpdateProgressListener;
  /** 2.1: install existing pending APK only (skip download). */
  installOnlyUri?: string;
  /** Do not prompt for install permission; return NO_PERMISSION instead. */
  skipPermissionModal?: boolean;
};

export type CheckAndInstallResult =
  | {
      ok: true;
      status: "up_to_date" | "installed" | "pending_user_action" | "skipped" | "cancelled";
    }
  | { ok: false; error: string; code?: string };

let silentInFlight: Promise<CheckAndInstallResult> | null = null;
let interactiveInFlight: Promise<CheckAndInstallResult> | null = null;

export function canInstallSilently(): boolean {
  if (!isSideloadUpdatesEnabled()) return false;
  if (getAndroidSdkInt() < 31) return false;
  return canRequestPackageInstalls();
}

export async function checkAndInstall(
  options: CheckAndInstallOptions,
): Promise<CheckAndInstallResult> {
  if (options.allowUserAction) {
    if (interactiveInFlight) return interactiveInFlight;
    // Wait for silent to finish so we don't race the same pending.apk.
    if (silentInFlight) {
      await silentInFlight.catch(() => undefined);
    }
    resetApkUpdateCancelFlag();
    interactiveInFlight = runInteractiveOwned(options).finally(() => {
      interactiveInFlight = null;
    });
    return interactiveInFlight;
  }

  if (interactiveInFlight) {
    return { ok: true, status: "skipped" };
  }
  if (silentInFlight) return silentInFlight;
  silentInFlight = runCheckAndInstall(options).finally(() => {
    silentInFlight = null;
  });
  return silentInFlight;
}

function cancelledResult(): CheckAndInstallResult {
  return { ok: true, status: "cancelled" };
}

function isCancelError(e: unknown): boolean {
  return (
    isApkUpdateCancelled() || (e instanceof Error && e.message === "CANCELLED")
  );
}

/** Cancel interactive update: stop download + wipe pending APK cache. */
export async function cancelInteractiveApkUpdate(): Promise<void> {
  await cancelApkUpdateAndClearCache();
}

/**
 * Hold native uiOwnsPending for the whole interactive download/install so FCM
 * startAuto cannot delete pending.apk. Keep ownership only while system
 * installer / confirm UI is still open (`pending_user_action`).
 */
async function runInteractiveOwned(
  options: CheckAndInstallOptions,
): Promise<CheckAndInstallResult> {
  setNativeUiOwnsPending(true);
  let keepOwnership = false;
  try {
    const result = await runCheckAndInstall(options);
    if (result.ok && result.status === "pending_user_action") {
      keepOwnership = true;
    }
    return result;
  } finally {
    if (!keepOwnership) {
      setNativeUiOwnsPending(false);
    }
  }
}

async function runCheckAndInstall(
  options: CheckAndInstallOptions,
): Promise<CheckAndInstallResult> {
  const report = (progress: Parameters<ApkUpdateProgressListener>[0]) => {
    if (options.allowUserAction) options.onProgress?.(progress);
  };

  // Interactive (notification «Обновить»): any build with the native module.
  // Silent/auto path: production sideload only.
  if (options.allowUserAction) {
    if (!isApkUpdaterNativeReady()) {
      return { ok: false, error: "Модуль обновления недоступен в этой сборке", code: "NO_NATIVE" };
    }
  } else if (!isSideloadUpdatesEnabled()) {
    return { ok: true, status: "skipped" };
  }

  report({ phase: "checking" });
  if (isApkUpdateCancelled()) return cancelledResult();

  const installed = getInstalledVersionCode();
  // Don't wipe a pending older APK when the user explicitly requested install.
  if (!options.allowUserAction) {
    await cleanupStalePending(installed);
  }
  if (isApkUpdateCancelled()) return cancelledResult();

  if (!options.force && !options.allowUserAction) {
    const last = Number(mmkv.getString(LAST_CHECK_KEY) ?? "0");
    if (Date.now() - last < THROTTLE_MS) {
      return { ok: true, status: "skipped" };
    }
  }

  if (!options.allowUserAction && !canInstallSilently()) {
    return { ok: true, status: "skipped" };
  }

  if (options.allowUserAction && !canRequestPackageInstalls() && !options.skipPermissionModal) {
    report({
      phase: "error",
      message: "Нужно разрешить установку из этого источника",
      code: "NO_PERMISSION",
    });
    return { ok: false, error: "Нужно разрешить установку из этого источника", code: "NO_PERMISSION" };
  }

  if (isApkUpdateCancelled()) return cancelledResult();

  let manifest = options.manifest ?? null;
  if (!manifest && !options.installOnlyUri) {
    try {
      manifest = await fetchLatestUpdateManifest();
    } catch {
      if (isApkUpdateCancelled()) return cancelledResult();
      if (options.allowUserAction) {
        // Caller may retry with notification fallback — don't paint error yet.
        return { ok: false, error: "Не удалось проверить обновление", code: "CHANNEL" };
      }
      return { ok: true, status: "skipped" };
    }
  }

  if (isApkUpdateCancelled()) return cancelledResult();

  if (!manifest && !options.installOnlyUri) {
    if (options.allowUserAction) {
      return { ok: false, error: "Манифест обновления не найден", code: "NO_MANIFEST" };
    }
    return { ok: true, status: "skipped" };
  }

  // Synthetic manifest for install-only when caller already resolved version.
  if (!manifest && options.installOnlyUri) {
    const pending = readPendingMeta();
    if (!pending) {
      return { ok: false, error: "Метаданные ожидающего APK не найдены", code: "INVALID_MANIFEST" };
    }
    manifest = {
      version: pending.version ?? "pending",
      versionCode: pending.versionCode,
      apkFileName: "pending.apk",
      apkUrl: pending.apkUrl,
      sha256: pending.sha256,
      sizeBytes: pending.sizeBytes,
    };
  }
  if (!manifest) {
    return { ok: false, error: "Манифест обновления не найден", code: "NO_MANIFEST" };
  }

  const trustedSha256 = normalizeTrustedSha256(manifest.sha256);
  const trustedUrlVersion = trustedFloraSocialApkVersion(manifest.apkUrl);
  if (
    !trustedSha256 ||
    !trustedUrlVersion ||
    (manifest.version !== "pending" && trustedUrlVersion !== manifest.version)
  ) {
    if (!options.allowUserAction) return { ok: true, status: "skipped" };
    report({ phase: "error", message: "Манифест APK не прошёл проверку безопасности" });
    return {
      ok: false,
      error: "Манифест APK не прошёл проверку безопасности",
      code: "INVALID_MANIFEST",
    };
  }
  manifest = { ...manifest, sha256: trustedSha256 };

  // Channel assets without versionCode are not trusted on the silent/auto path.
  if (!options.allowUserAction && manifest.versionCode == null) {
    return { ok: true, status: "skipped" };
  }

  mmkv.set(LAST_CHECK_KEY, String(Date.now()));

  // Never offer a same-version or rollback APK, including notification-driven
  // interactive updates. Older builds may contain already-fixed vulnerabilities.
  if (manifest.versionCode != null && manifest.versionCode <= installed) {
    report({ phase: "done", message: "Уже установлена актуальная версия" });
    return { ok: true, status: "up_to_date" };
  }
  if (
    manifest.versionCode == null &&
    manifest.version !== "pending" &&
    compareFloraSocialVersions(getFloraSocialAppVersion(), manifest.version) >= 0
  ) {
    report({ phase: "done", message: "Уже установлена актуальная версия" });
    return { ok: true, status: "up_to_date" };
  }

  let fileUri: string;

  if (options.installOnlyUri) {
    fileUri = options.installOnlyUri;
  } else {
    if (!options.allowUserAction) {
      if (manifest.sizeBytes == null) {
        return { ok: true, status: "skipped" };
      }
      try {
        await assertEnoughDiskSpace(manifest.sizeBytes);
      } catch {
        return { ok: true, status: "skipped" };
      }
    } else {
      try {
        if (manifest.sizeBytes != null) {
          await assertEnoughDiskSpace(manifest.sizeBytes);
        }
        // No HEAD probe: some CDNs hang on HEAD from the device.
      } catch (e) {
        if (isApkUpdateCancelled()) return cancelledResult();
        const msg = e instanceof Error ? e.message : "";
        if (msg === "NO_DISK_SPACE" || msg === "MISSING_SIZE") {
          report({ phase: "error", message: "Недостаточно места на устройстве" });
          return { ok: false, error: "Недостаточно места на устройстве", code: "NO_DISK_SPACE" };
        }
        report({ phase: "error", message: "Не удалось проверить свободное место" });
        return { ok: false, error: "Не удалось проверить свободное место", code: "DISK" };
      }
    }

    if (isApkUpdateCancelled()) return cancelledResult();

    try {
      report({ phase: "downloading" });
      let lastPct = -1;
      fileUri = await downloadApkResumable(manifest, (fraction) => {
        if (isApkUpdateCancelled()) return;
        if (fraction == null) {
          report({ phase: "downloading" });
          return;
        }
        const pct = Math.floor(fraction * 100);
        if (pct === lastPct) return;
        lastPct = pct;
        report({ phase: "downloading", fraction });
      });
    } catch (e) {
      if (isCancelError(e)) return cancelledResult();
      await clearPendingApk();
      if (options.allowUserAction) {
        const detail = e instanceof Error ? e.message : "";
        const message =
          detail === "DOWNLOAD_STALLED"
            ? "Загрузка зависла. Проверьте сеть и попробуйте снова"
            : detail && detail !== "DOWNLOAD_FAILED"
              ? `Ошибка загрузки: ${detail}`
              : "Ошибка загрузки APK";
        report({ phase: "error", message });
        return { ok: false, error: message, code: "DOWNLOAD" };
      }
      return { ok: true, status: "skipped" };
    }
  }

  if (isApkUpdateCancelled()) return cancelledResult();

  try {
    report({ phase: "verifying" });
    // Incomplete download only — stale channel sizeBytes must not fail a matching SHA.
    if (
      typeof manifest.sizeBytes === "number" &&
      manifest.sizeBytes > 0 &&
      !options.installOnlyUri
    ) {
      const info = await getInfoAsync(fileUri).catch(() => null);
      if (info?.exists && typeof info.size === "number" && info.size < manifest.sizeBytes) {
        await clearPendingApk();
        if (options.allowUserAction) {
          const message =
            "Файл обновления повреждён при загрузке (размер не совпал). Попробуйте ещё раз";
          report({ phase: "error", message });
          return { ok: false, error: message, code: "SHA256" };
        }
        return { ok: true, status: "skipped" };
      }
    }
    const hash = await sha256File(fileUri);
    if (isApkUpdateCancelled()) return cancelledResult();
    if (hash.toLowerCase() !== manifest.sha256) {
      await clearPendingApk();
      if (options.allowUserAction) {
        report({ phase: "error", message: "Контрольная сумма APK не совпала" });
        return { ok: false, error: "Контрольная сумма APK не совпала", code: "SHA256" };
      }
      return { ok: true, status: "skipped" };
    }
  } catch (e) {
    if (isCancelError(e)) return cancelledResult();
    await clearPendingApk();
    if (options.allowUserAction) {
      report({ phase: "error", message: "Не удалось проверить APK" });
      return { ok: false, error: "Не удалось проверить APK", code: "SHA256" };
    }
    return { ok: true, status: "skipped" };
  }

  if (isApkUpdateCancelled()) return cancelledResult();

  try {
    report({ phase: "installing" });
    const result = await installApk(fileUri, options.allowUserAction);
    if (isApkUpdateCancelled()) return cancelledResult();
    if (result.status === "success") {
      await clearPendingApk();
      report({ phase: "done", message: "Обновление установлено" });
      return { ok: true, status: "installed" };
    }
    // System installer UI opened (API < 31 Intent path, or PackageInstaller confirm).
    report({
      phase: "installing",
      message: "Подтвердите установку в системном окне",
    });
    return { ok: true, status: "pending_user_action" };
  } catch (e) {
    if (isCancelError(e)) return cancelledResult();
    // Keep pending.apk — user can retry from the notification button.
    const code =
      e && typeof e === "object" && "code" in e ? String((e as { code?: string }).code) : "";
    const detail =
      e instanceof Error && e.message.trim().length > 0 ? e.message.trim() : "";
    if (!options.allowUserAction) {
      return { ok: true, status: "skipped" };
    }
    if (code === "E_NO_PERMISSION") {
      report({
        phase: "error",
        message: "Нужно разрешить установку из этого источника",
        code: "NO_PERMISSION",
      });
      return {
        ok: false,
        error: "Нужно разрешить установку из этого источника",
        code: "NO_PERMISSION",
      };
    }
    if (code === "E_USER_ACTION_REQUIRED" || code === "E_CONFIRM") {
      report({ phase: "error", message: "Не удалось открыть системную установку" });
      return {
        ok: false,
        error: "Не удалось открыть системную установку",
        code: "INSTALL",
      };
    }
    const downgrade =
      /version.?downgrade|INSTALL_FAILED_VERSION_DOWNGRADE/i.test(detail) ||
      /downgrade/i.test(detail);
    // Android itself rejects lower versionCode for non-privileged installers.
    // Our app does not block — surface a short actionable message.
    const message = downgrade
      ? "Android запретил установку: versionCode APK ниже установленного"
      : detail || "Установка не удалась";
    report({ phase: "error", message, code: "INSTALL" });
    return { ok: false, error: message, code: "INSTALL" };
  }
}

/**
 * @deprecated Background silent update removed — use inbox «Обновить».
 */
export async function runSilentUpdateCheck(_force = false): Promise<void> {
  return;
}
