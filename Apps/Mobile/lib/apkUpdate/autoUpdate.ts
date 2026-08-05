import { apiListNotifications } from "@flora/client-core/api";
import {
  canRequestPackageInstalls,
  cancelNativeUpdate,
  getNativeUpdateState,
  startNativeAutoUpdate,
  type NativeUpdateManifest,
} from "flora-apk-updater";
import {
  isApkUpdaterNativeReady,
  isSideloadUpdatesEnabled,
} from "@/lib/apkUpdate/capabilities";
import {
  CATCH_UP_THROTTLE_MS,
  getCatchUpAt,
  isAutoUpdateEnabled,
  isInAppUpdatesEnabled,
  markCatchUpAt,
} from "@/lib/apkUpdate/autoUpdatePreference";
import {
  fetchDirectUpdateManifestForVersion,
  fetchLatestUpdateManifest,
  getInstalledVersionCode,
  invalidateChannelManifestCache,
} from "@/lib/apkUpdate/channelRelease";
import { parseAppUpdateVersionFromText } from "@/lib/appLinks";

function toNativeManifest(input: {
  version: string;
  versionCode: number;
  apkUrl: string;
  sha256: string;
  sizeBytes?: number;
  notificationUuid?: string;
  text?: string;
}): NativeUpdateManifest {
  return {
    version: input.version,
    versionCode: input.versionCode,
    apkUrl: input.apkUrl,
    sha256: input.sha256.toLowerCase(),
    sizeBytes: input.sizeBytes ?? null,
    notificationUuid: input.notificationUuid ?? null,
    text: input.text ?? null,
  };
}

function canRunAuto(): boolean {
  return (
    isSideloadUpdatesEnabled() &&
    isApkUpdaterNativeReady() &&
    isInAppUpdatesEnabled() &&
    isAutoUpdateEnabled() &&
    canRequestPackageInstalls()
  );
}

/** Path 1.1: enqueue native auto download from Flora channel (install gated in Kotlin). */
export async function runAutoUpdateFromManifest(
  manifest: NativeUpdateManifest,
): Promise<void> {
  if (!canRunAuto()) return;
  if (manifest.versionCode <= getInstalledVersionCode()) return;
  if (!/^[a-f0-9]{64}$/i.test(manifest.sha256)) return;
  await startNativeAutoUpdate(manifest);
}

/** SSE / push with structured update payload (apkUrl must be Flora channel). */
export async function runAutoUpdateFromRealtime(input: {
  version: string;
  versionCode: number;
  apkUrl: string;
  sha256: string;
  sizeBytes?: number;
  notificationUuid?: string;
  text?: string;
}): Promise<void> {
  await runAutoUpdateFromManifest(toNativeManifest(input));
}

/**
 * Catch-up: channel latest first, then unread inbox app_update.
 * Retries when background opt-in is on even after a missed/failed push.
 */
export async function runAppUpdateCatchUp(options?: {
  /**
   * Skip 15m throttle — only for explicit user enable of background toggle.
   * Other skips: FAILED, or one retry after stale READY cleanup when latest is newer.
   */
  force?: boolean;
}): Promise<void> {
  if (!canRunAuto()) return;

  const installed = getInstalledVersionCode();
  const state = getNativeUpdateState();
  const phase = state?.phase ?? "IDLE";
  const stateVc = state?.versionCode ?? null;

  // Don't interrupt an in-flight newer update (download / ready / install).
  const inFlightNewer =
    stateVc != null &&
    stateVc > installed &&
    (phase === "DOWNLOADING" ||
      phase === "READY" ||
      phase === "INSTALL_SCHEDULED" ||
      phase === "INSTALLING");
  if (inFlightNewer) return;

  let didStaleCleanup = false;
  if (
    stateVc != null &&
    stateVc <= installed &&
    (phase === "READY" || phase === "INSTALL_SCHEDULED")
  ) {
    try {
      cancelNativeUpdate();
    } catch {
      // ignore
    }
    didStaleCleanup = true;
  }

  const phaseNow = getNativeUpdateState()?.phase ?? "IDLE";
  const failed = phaseNow === "FAILED";
  const lastError = (getNativeUpdateState()?.lastError ?? "").toLowerCase();
  const shaFailed = failed && lastError.includes("sha-256");
  if (shaFailed) {
    invalidateChannelManifestCache();
  }

  // SHA mismatch used to skip throttle every time → endless re-download. Cap retries.
  if (!options?.force && !didStaleCleanup) {
    if (shaFailed) {
      const last = getCatchUpAt();
      // Allow one retry soon after first SHA failure, then normal throttle.
      if (last > 0 && Date.now() - last < CATCH_UP_THROTTLE_MS) return;
    } else if (!failed) {
      const last = getCatchUpAt();
      if (Date.now() - last < CATCH_UP_THROTTLE_MS) return;
    }
  }

  const latest = await fetchLatestUpdateManifest().catch(() => null);
  const latestNewer =
    latest?.versionCode != null && latest.versionCode > installed;

  // Post-cleanup with no newer build: still respect throttle for inbox path next times.
  if (
    !options?.force &&
    !failed &&
    didStaleCleanup &&
    !latestNewer &&
    Date.now() - getCatchUpAt() < CATCH_UP_THROTTLE_MS
  ) {
    return;
  }

  markCatchUpAt();

  if (latest && latest.versionCode != null && latest.versionCode > installed) {
    await runAutoUpdateFromManifest(
      toNativeManifest({
        version: latest.version,
        versionCode: latest.versionCode,
        apkUrl: latest.apkUrl,
        sha256: latest.sha256,
        sizeBytes: latest.sizeBytes,
      }),
    );
    return;
  }

  let items: Awaited<ReturnType<typeof apiListNotifications>>;
  try {
    items = await apiListNotifications({ category: "developer", take: 30 });
  } catch {
    return;
  }

  for (const item of items) {
    if (item.type !== "app_update" || item.isRead) continue;
    const version = parseAppUpdateVersionFromText(item.text);
    if (!version) continue;
    const manifest = await fetchDirectUpdateManifestForVersion(version).catch(() => null);
    if (!manifest || manifest.versionCode == null) continue;
    if (manifest.versionCode <= installed) continue;
    await runAutoUpdateFromManifest(
      toNativeManifest({
        version: manifest.version,
        versionCode: manifest.versionCode,
        apkUrl: manifest.apkUrl,
        sha256: manifest.sha256,
        sizeBytes: manifest.sizeBytes,
        notificationUuid: item.notificationUuid,
        text: item.text,
      }),
    );
    return;
  }
}
