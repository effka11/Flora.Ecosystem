import { nativeBuildVersion } from "expo-application";
import { Platform } from "react-native";
import { mmkv } from "@/lib/mmkv";
import { parseAppUpdateVersionFromText } from "@/lib/appLinks";
import {
  FLORA_APK_CHANNEL_LATEST_UPDATE_URL,
  FLORA_APK_CHANNEL_RELEASES_URL,
  type FloraApkChannelCatalog,
  type FloraApkChannelRelease,
} from "@/lib/apkUpdate/apkChannel";
import {
  isSafeReleaseVersion,
  normalizeTrustedSha256,
  trustedFloraSocialApkVersion,
} from "@/lib/apkUpdate/manifestSecurity";

export type AndroidUpdateManifest = {
  version: string;
  /** Missing only for legacy interactive releases without update.json. */
  versionCode: number | null;
  apkFileName: string;
  apkUrl: string;
  /** Required SHA-256 of the APK bytes. */
  sha256: string;
  sizeBytes?: number;
};

const CHANNEL_FETCH_TIMEOUT_MS = 20_000;
const LATEST_ETAG_KEY = "apkUpdate.channelLatestEtag";
const LATEST_BODY_KEY = "apkUpdate.channelLatestBody";
const RELEASES_ETAG_KEY = "apkUpdate.channelReleasesEtag";
const RELEASES_BODY_KEY = "apkUpdate.channelReleasesBody";

function userAgent(): string {
  const build = nativeBuildVersion ?? "0";
  return `FloraSocial-Android/${build}`;
}

async function channelFetch(
  url: string,
  etagKey: string,
  bodyKey: string,
): Promise<{ status: number; body: string | null }> {
  const headers: Record<string, string> = {
    Accept: "application/json, */*",
    "User-Agent": userAgent(),
  };
  const etag = mmkv.getString(etagKey);
  if (etag) headers["If-None-Match"] = etag;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHANNEL_FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: controller.signal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`APK channel timeout after ${CHANNEL_FETCH_TIMEOUT_MS}ms for ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 304) {
    return { status: 304, body: mmkv.getString(bodyKey) ?? null };
  }
  if (!res.ok) {
    mmkv.delete(etagKey);
    mmkv.delete(bodyKey);
    throw new Error(`APK channel HTTP ${res.status} for ${url}`);
  }
  const body = await res.text();
  const newEtag = res.headers.get("etag");
  if (newEtag) mmkv.set(etagKey, newEtag);
  mmkv.set(bodyKey, body);
  return { status: res.status, body };
}

function parseManifestObject(parsed: Partial<AndroidUpdateManifest>): AndroidUpdateManifest | null {
  const sha256 = normalizeTrustedSha256(parsed.sha256);
  if (
    typeof parsed.version !== "string" ||
    !isSafeReleaseVersion(parsed.version) ||
    typeof parsed.versionCode !== "number" ||
    !Number.isInteger(parsed.versionCode) ||
    parsed.versionCode < 1 ||
    typeof parsed.apkUrl !== "string" ||
    trustedFloraSocialApkVersion(parsed.apkUrl) !== parsed.version ||
    !sha256
  ) {
    return null;
  }
  return {
    version: parsed.version,
    versionCode: parsed.versionCode,
    apkFileName: parsed.apkFileName ?? `flora.social-v${parsed.version}-android.apk`,
    apkUrl: parsed.apkUrl,
    sha256,
    sizeBytes: typeof parsed.sizeBytes === "number" ? parsed.sizeBytes : undefined,
  };
}

function releaseEntryToManifest(entry: FloraApkChannelRelease): AndroidUpdateManifest | null {
  return parseManifestObject({
    version: entry.version,
    versionCode: entry.versionCode,
    apkFileName: entry.apkFileName,
    apkUrl: entry.apkUrl,
    sha256: entry.sha256,
    sizeBytes: entry.sizeBytes,
  });
}

function parseCatalog(body: string): FloraApkChannelCatalog | null {
  try {
    const parsed = JSON.parse(body.replace(/^\uFEFF/, "")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const releasesRaw = (parsed as { releases?: unknown }).releases;
    if (!Array.isArray(releasesRaw)) return null;
    const releases: FloraApkChannelRelease[] = [];
    for (const item of releasesRaw) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      const version = typeof r.version === "string" ? r.version.trim() : "";
      const apkUrl = typeof r.apkUrl === "string" ? r.apkUrl : "";
      const sha256 = normalizeTrustedSha256(r.sha256);
      const versionCode =
        typeof r.versionCode === "number" && Number.isInteger(r.versionCode) ? r.versionCode : NaN;
      const sizeBytes =
        typeof r.sizeBytes === "number" && Number.isFinite(r.sizeBytes) ? r.sizeBytes : 0;
      if (
        !version ||
        !isSafeReleaseVersion(version) ||
        !sha256 ||
        versionCode < 1 ||
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
        publishedAt: typeof r.publishedAt === "string" ? r.publishedAt : new Date(0).toISOString(),
      });
    }
    return {
      updatedAt:
        typeof (parsed as { updatedAt?: unknown }).updatedAt === "string"
          ? (parsed as { updatedAt: string }).updatedAt
          : new Date(0).toISOString(),
      releases,
    };
  } catch {
    return null;
  }
}

async function fetchChannelCatalog(): Promise<FloraApkChannelCatalog | null> {
  const res = await channelFetch(
    FLORA_APK_CHANNEL_RELEASES_URL,
    RELEASES_ETAG_KEY,
    RELEASES_BODY_KEY,
  );
  if (!res.body) return null;
  return parseCatalog(res.body);
}

export async function fetchLatestUpdateManifest(): Promise<AndroidUpdateManifest | null> {
  if (Platform.OS !== "android") return null;

  try {
    const res = await channelFetch(
      FLORA_APK_CHANNEL_LATEST_UPDATE_URL,
      LATEST_ETAG_KEY,
      LATEST_BODY_KEY,
    );
    if (res.body) {
      const parsed = JSON.parse(res.body.replace(/^\uFEFF/, "")) as Partial<AndroidUpdateManifest>;
      const manifest = parseManifestObject(parsed);
      if (manifest) return manifest;
    }
  } catch {
    // Fall through to catalog latest.
  }

  try {
    const catalog = await fetchChannelCatalog();
    const first = catalog?.releases[0];
    return first ? releaseEntryToManifest(first) : null;
  } catch {
    return null;
  }
}

/** @deprecated Prefer catalog lookup; latest update.json is unversioned on the channel. */
export function buildFloraSocialUpdateJsonUrl(_version: string): string {
  return FLORA_APK_CHANNEL_LATEST_UPDATE_URL;
}

/**
 * Resolve update manifest for a specific version from the channel catalog.
 */
export async function fetchDirectUpdateManifestForVersion(
  version: string,
): Promise<AndroidUpdateManifest | null> {
  if (Platform.OS !== "android") return null;
  const v = version.trim();
  if (!v || !isSafeReleaseVersion(v)) return null;

  try {
    const catalog = await fetchChannelCatalog();
    const entry = catalog?.releases.find((r) => r.version === v);
    return entry ? releaseEntryToManifest(entry) : null;
  } catch {
    return null;
  }
}

export async function fetchUpdateManifestFromNotificationText(
  text: string,
): Promise<AndroidUpdateManifest | null> {
  if (Platform.OS !== "android") return null;

  const version = parseAppUpdateVersionFromText(text);
  if (!version || !isSafeReleaseVersion(version)) return null;
  return fetchDirectUpdateManifestForVersion(version);
}

export function getInstalledVersionCode(): number {
  if (Platform.OS !== "android") return 0;
  const raw = nativeBuildVersion;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? n : 0;
}
