/**
 * Flora Social Android APK distribution channel (independent of GitHub Releases).
 * Keep in sync with Apps/Mobile/lib/apkUpdate/apkChannel.ts.
 */
export const FLORA_APK_CHANNEL_ORIGIN = "https://social.flora-s.net";
export const FLORA_APK_CHANNEL_BASE = `${FLORA_APK_CHANNEL_ORIGIN}/apk`;
export const FLORA_APK_CHANNEL_RELEASES_URL = `${FLORA_APK_CHANNEL_BASE}/releases.json`;
export const FLORA_APK_CHANNEL_LATEST_UPDATE_URL = `${FLORA_APK_CHANNEL_BASE}/flora.social-android-update.json`;

const SHA256_HEX = /^[a-f0-9]{64}$/i;
const RELEASE_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/;
const CHANNEL_APK_PATH =
  /^\/apk\/flora\.social-v([0-9A-Za-z][0-9A-Za-z._+-]{0,127})-android\.apk$/;

export type FloraApkChannelRelease = {
  version: string;
  versionCode: number;
  apkFileName: string;
  apkUrl: string;
  sha256: string;
  sizeBytes: number;
  publishedAt?: string;
};

export type FloraApkChannelCatalog = {
  updatedAt?: string;
  releases: FloraApkChannelRelease[];
};

export function isSafeReleaseVersion(value: string): boolean {
  return RELEASE_VERSION.test(value);
}

export function normalizeTrustedSha256(value: unknown): string | null {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) return null;
  return value.toLowerCase();
}

/** Only immutable Flora Social APK assets from the official channel. */
export function trustedFloraSocialApkVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const validOrigin =
      url.protocol === "https:" &&
      url.hostname === "social.flora-s.net" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "";
    if (!validOrigin) return null;
    return url.pathname.match(CHANNEL_APK_PATH)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function isTrustedFloraSocialApkUrl(value: unknown): value is string {
  return trustedFloraSocialApkVersion(value) !== null;
}

export function parseFloraApkChannelCatalog(raw: unknown): FloraApkChannelCatalog | null {
  if (!raw || typeof raw !== "object") return null;
  const releasesRaw = (raw as { releases?: unknown }).releases;
  if (!Array.isArray(releasesRaw)) return null;

  const releases: FloraApkChannelRelease[] = [];
  for (const entry of releasesRaw) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const version = typeof r.version === "string" ? r.version.trim() : "";
    const apkUrl = typeof r.apkUrl === "string" ? r.apkUrl : "";
    const sha256 = normalizeTrustedSha256(r.sha256);
    const versionCode =
      typeof r.versionCode === "number" && Number.isInteger(r.versionCode) ? r.versionCode : NaN;
    const sizeBytes =
      typeof r.sizeBytes === "number" && Number.isFinite(r.sizeBytes) && r.sizeBytes >= 0
        ? r.sizeBytes
        : NaN;
    if (
      !version ||
      !isSafeReleaseVersion(version) ||
      !sha256 ||
      versionCode < 1 ||
      !Number.isFinite(sizeBytes) ||
      trustedFloraSocialApkVersion(apkUrl) !== version
    ) {
      continue;
    }
    releases.push({
      version,
      versionCode,
      apkFileName:
        typeof r.apkFileName === "string" && r.apkFileName.trim()
          ? r.apkFileName.trim()
          : `flora.social-v${version}-android.apk`,
      apkUrl,
      sha256,
      sizeBytes,
      publishedAt: typeof r.publishedAt === "string" ? r.publishedAt : undefined,
    });
  }

  return {
    updatedAt: typeof (raw as { updatedAt?: unknown }).updatedAt === "string"
      ? (raw as { updatedAt: string }).updatedAt
      : undefined,
    releases,
  };
}
