import {
  canRequestPackageInstalls,
  getAndroidSdkInt,
  installApk,
  sha256File,
} from "flora-apk-updater";
import {
  canPromptInstallPermission,
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
  resetApkUpdateCancelFlag,
} from "@/lib/apkUpdate/download";
import {
  fetchLatestUpdateManifest,
  getInstalledVersionCode,
  type AndroidUpdateManifest,
} from "@/lib/apkUpdate/githubRelease";
import { openInstallPermissionPrompt } from "@/lib/apkUpdate/installPermissionPrompt";
import {
  wasInstallPermissionDeclined,
  wasInstallPermissionPrompted,
} from "@/lib/apkUpdate/permissionState";
import type { ApkUpdateProgressListener } from "@/lib/apkUpdate/progress";
import { mmkv } from "@/lib/mmkv";

const LAST_CHECK_KEY = "apkUpdate.lastCheckAt";
const THROTTLE_MS = 12 * 60 * 60 * 1000;

export type CheckAndInstallOptions = {
  allowUserAction: boolean;
  /** Skip throttle (notification tap / resume after permission). */
  force?: boolean;
  /** Optional manifest override (e.g. from notification when GitHub has no JSON). */
  manifest?: AndroidUpdateManifest | null;
  /** Interactive UI progress (ignored on silent path). */
  onProgress?: ApkUpdateProgressListener;
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

/**
 * Post-login / interactive: Flora-styled modal → Settings if needed.
 * Does not download APK.
 */
export async function ensureInstallPackagesPermission(
  options?: { force?: boolean },
): Promise<boolean> {
  if (!canPromptInstallPermission()) return false;
  if (canRequestPackageInstalls()) return true;
  // «Нет, спасибо» — never ask again (including interactive force).
  if (wasInstallPermissionDeclined()) return false;
  if (!options?.force && wasInstallPermissionPrompted()) return false;

  return openInstallPermissionPrompt();
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
    interactiveInFlight = runCheckAndInstall(options).finally(() => {
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

async function runCheckAndInstall(
  options: CheckAndInstallOptions,
): Promise<CheckAndInstallResult> {
  const report = (progress: Parameters<ApkUpdateProgressListener>[0]) => {
    if (options.allowUserAction) options.onProgress?.(progress);
  };

  // Silent GitHub self-update: production sideload only.
  // Interactive (notification «Обновить»): any build with the native module.
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
  await cleanupStalePending(installed);
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

  if (options.allowUserAction && !canRequestPackageInstalls()) {
    report({ phase: "permission" });
    const granted = await ensureInstallPackagesPermission({ force: true });
    if (isApkUpdateCancelled()) return cancelledResult();
    if (!granted || !canRequestPackageInstalls()) {
      report({ phase: "error", message: "Нужно разрешить установку из этого источника" });
      return { ok: false, error: "Нужно разрешить установку из этого источника", code: "NO_PERMISSION" };
    }
    report({ phase: "checking" });
  }

  if (isApkUpdateCancelled()) return cancelledResult();

  let manifest = options.manifest ?? null;
  if (!manifest) {
    try {
      manifest = await fetchLatestUpdateManifest();
    } catch {
      if (isApkUpdateCancelled()) return cancelledResult();
      if (options.allowUserAction) {
        // Caller may retry with notification fallback — don't paint error yet.
        return { ok: false, error: "Не удалось проверить обновление", code: "GITHUB" };
      }
      return { ok: true, status: "skipped" };
    }
  }

  if (isApkUpdateCancelled()) return cancelledResult();

  if (!manifest) {
    if (options.allowUserAction) {
      return { ok: false, error: "Манифест обновления не найден", code: "NO_MANIFEST" };
    }
    return { ok: true, status: "skipped" };
  }

  if (!/^[a-f0-9]{64}$/i.test(manifest.sha256)) {
    if (options.allowUserAction) {
      report({ phase: "error", message: "У релиза нет контрольной суммы APK" });
      return {
        ok: false,
        error: "У релиза нет контрольной суммы APK",
        code: "INVALID_MANIFEST",
      };
    }
    return { ok: true, status: "skipped" };
  }

  // A legacy GitHub asset has no trustworthy versionCode. It is allowed only
  // after an explicit notification-button tap, never on the silent path.
  if (!options.allowUserAction && manifest.versionCode == null) {
    return { ok: true, status: "skipped" };
  }

  mmkv.set(LAST_CHECK_KEY, String(Date.now()));

  if (manifest.versionCode != null && manifest.versionCode <= installed) {
    report({ phase: "done", message: "Уже установлена актуальная версия" });
    return { ok: true, status: "up_to_date" };
  }

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
      } else {
        // Best-effort size probe; do not block install if HEAD fails (GitHub redirects / CDN).
        try {
          const head = await fetch(manifest.apkUrl, { method: "HEAD" });
          const len = Number(head.headers.get("content-length") ?? "0");
          if (len > 0) await assertEnoughDiskSpace(len);
        } catch {
          // skip disk preflight
        }
      }
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

  let fileUri: string;
  try {
    report({ phase: "downloading", fraction: 0 });
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
      report({ phase: "error", message: "Ошибка загрузки APK" });
      return { ok: false, error: "Ошибка загрузки APK", code: "DOWNLOAD" };
    }
    return { ok: true, status: "skipped" };
  }

  if (isApkUpdateCancelled()) return cancelledResult();

  try {
    report({ phase: "verifying" });
    const hash = await sha256File(fileUri);
    if (isApkUpdateCancelled()) return cancelledResult();
    if (hash.toLowerCase() !== manifest.sha256.toLowerCase()) {
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
    // System confirm UI takes over — no in-app "confirm" modal.
    // PackageInstaller owns a full session copy now; source APK can be removed.
    await clearPendingApk();
    return { ok: true, status: "pending_user_action" };
  } catch (e) {
    if (isCancelError(e)) return cancelledResult();
    await clearPendingApk();
    const code =
      e && typeof e === "object" && "code" in e ? String((e as { code?: string }).code) : "";
    if (!options.allowUserAction) {
      return { ok: true, status: "skipped" };
    }
    if (code === "E_NO_PERMISSION") {
      report({ phase: "error", message: "Нужно разрешить установку из этого источника" });
      return {
        ok: false,
        error: "Нужно разрешить установку из этого источника",
        code,
      };
    }
    if (code === "E_USER_ACTION_REQUIRED") {
      report({ phase: "error", message: "Не удалось открыть системную установку" });
      return {
        ok: false,
        error: "Не удалось открыть системную установку",
        code: "INSTALL",
      };
    }
    report({ phase: "error", message: "Установка не удалась" });
    return { ok: false, error: "Установка не удалась", code: "INSTALL" };
  }
}

/** Silent path used after login / on resume when permission is already granted. */
export async function runSilentUpdateCheck(force = false): Promise<void> {
  if (!canInstallSilently()) return;
  await checkAndInstall({ allowUserAction: false, force });
}
