import { apiListNotifications } from "@flora/client-core/api";
import {
  canRequestPackageInstalls,
  getNativeUpdateState,
  startNativeAutoUpdate,
  type NativeUpdateManifest,
} from "flora-apk-updater";
import {
  isApkUpdaterNativeReady,
  isSideloadUpdatesEnabled,
} from "@/lib/apkUpdate/capabilities";
import {
  fetchDirectUpdateManifestForVersion,
  getInstalledVersionCode,
} from "@/lib/apkUpdate/githubRelease";
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

/** Path 1.1: enqueue native auto download (install gated in Kotlin). */
export async function runAutoUpdateFromManifest(
  manifest: NativeUpdateManifest,
): Promise<void> {
  if (!isSideloadUpdatesEnabled() || !isApkUpdaterNativeReady()) return;
  if (!canRequestPackageInstalls()) return;
  if (manifest.versionCode <= getInstalledVersionCode()) return;
  if (!/^[a-f0-9]{64}$/i.test(manifest.sha256)) return;
  await startNativeAutoUpdate(manifest);
}

/** SSE / push with structured update payload. */
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
 * Catch-up when FCM was missed: unread app_update → direct update.json → native auto.
 * Download only; silent install stays in native foreground gate.
 */
export async function runAppUpdateCatchUp(): Promise<void> {
  if (!isSideloadUpdatesEnabled() || !isApkUpdaterNativeReady()) return;
  if (!canRequestPackageInstalls()) return;

  const state = getNativeUpdateState();
  if (
    state &&
    (state.phase === "DOWNLOADING" ||
      state.phase === "READY" ||
      state.phase === "INSTALL_SCHEDULED" ||
      state.phase === "INSTALLING")
  ) {
    return;
  }

  let items: Awaited<ReturnType<typeof apiListNotifications>>;
  try {
    items = await apiListNotifications({ category: "developer", take: 30 });
  } catch {
    return;
  }

  const installed = getInstalledVersionCode();
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
