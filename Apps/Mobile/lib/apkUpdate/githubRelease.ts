import { nativeBuildVersion } from "expo-application";
import { Platform } from "react-native";
import { mmkv } from "@/lib/mmkv";
import { parseAppUpdateVersionFromText, buildFloraSocialApkDownloadUrl } from "@/lib/appLinks";

export type AndroidUpdateManifest = {
  version: string;
  /** Missing only for legacy interactive releases without update.json. */
  versionCode: number | null;
  apkFileName: string;
  apkUrl: string;
  /** Empty string = skip integrity check (interactive notification direct URL). */
  sha256: string;
  sizeBytes?: number;
};

const GITHUB_REPO = "effka11/Flora.Ecosystem";
const RELEASES_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=30`;
const UPDATE_ASSET_NAME = "flora.social-android-update.json";
const GITHUB_FETCH_TIMEOUT_MS = 20_000;

const ETAG_KEY = "apkUpdate.releasesEtag";
const BODY_KEY = "apkUpdate.releasesBody";
const MANIFEST_ETAG_PREFIX = "apkUpdate.manifestEtag.";
const MANIFEST_BODY_PREFIX = "apkUpdate.manifestBody.";

type GitHubAsset = {
  name: string;
  /** API asset URL — use with Accept: application/octet-stream for binary download. */
  url?: string;
  browser_download_url: string;
  digest?: string | null;
  size?: number;
};

type GitHubRelease = {
  tag_name: string;
  assets: GitHubAsset[];
};

function userAgent(): string {
  const build = nativeBuildVersion ?? "0";
  return `FloraSocial-Android/${build}`;
}

async function githubFetch(
  url: string,
  etagKey: string,
  bodyKey: string,
  options?: { accept?: string },
): Promise<{ status: number; body: string | null }> {
  const headers: Record<string, string> = {
    Accept: options?.accept ?? "application/vnd.github+json",
    "User-Agent": userAgent(),
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const etag = mmkv.getString(etagKey);
  if (etag) headers["If-None-Match"] = etag;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: controller.signal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`GitHub timeout after ${GITHUB_FETCH_TIMEOUT_MS}ms for ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 304) {
    return { status: 304, body: mmkv.getString(bodyKey) ?? null };
  }
  if (!res.ok) {
    // Stale ETag / deleted asset — drop cache so the next attempt refetches.
    mmkv.delete(etagKey);
    mmkv.delete(bodyKey);
    throw new Error(`GitHub HTTP ${res.status} for ${url}`);
  }
  const body = await res.text();
  const newEtag = res.headers.get("etag");
  if (newEtag) mmkv.set(etagKey, newEtag);
  mmkv.set(bodyKey, body);
  return { status: res.status, body };
}

function pickSocialRelease(releases: GitHubRelease[]): GitHubRelease | null {
  for (const release of releases) {
    if (!release.tag_name?.startsWith("social/v")) continue;
    const hasManifest = (release.assets ?? []).some((a) => a.name === UPDATE_ASSET_NAME);
    if (hasManifest) return release;
  }
  return null;
}

async function fetchReleases(): Promise<GitHubRelease[]> {
  const list = await githubFetch(RELEASES_URL, ETAG_KEY, BODY_KEY);
  if (!list.body) return [];

  const parsed = JSON.parse(list.body.replace(/^\uFEFF/, "")) as unknown;
  return Array.isArray(parsed) ? (parsed as GitHubRelease[]) : [];
}

function parseAssetSha256(digest: string | null | undefined): string | null {
  const match = digest?.match(/^sha256:([a-f0-9]{64})$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

export async function fetchLatestUpdateManifest(): Promise<AndroidUpdateManifest | null> {
  if (Platform.OS !== "android") return null;

  const releases = await fetchReleases();
  const release = pickSocialRelease(releases);
  if (!release) return null;

  const asset = release.assets.find((a) => a.name === UPDATE_ASSET_NAME);
  if (!asset?.browser_download_url) return null;

  const tagKey = release.tag_name.replace(/[^\w.-]+/g, "_");
  // Release asset download URLs are not the GitHub REST API — use */* so CDN
  // redirects work (application/vnd.github+json can hang on browser_download_url).
  const manifestRes = await githubFetch(
    asset.browser_download_url,
    `${MANIFEST_ETAG_PREFIX}${tagKey}`,
    `${MANIFEST_BODY_PREFIX}${tagKey}`,
    { accept: "*/*" },
  );
  if (!manifestRes.body) return null;

  const parsed = JSON.parse(manifestRes.body.replace(/^\uFEFF/, "")) as Partial<AndroidUpdateManifest>;
  if (
    typeof parsed.version !== "string" ||
    typeof parsed.versionCode !== "number" ||
    !Number.isInteger(parsed.versionCode) ||
    parsed.versionCode < 1 ||
    typeof parsed.apkUrl !== "string" ||
    typeof parsed.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(parsed.sha256)
  ) {
    return null;
  }

  return {
    version: parsed.version,
    versionCode: parsed.versionCode,
    apkFileName: parsed.apkFileName ?? `flora.social-v${parsed.version}-android.apk`,
    apkUrl: parsed.apkUrl,
    sha256: parsed.sha256.toLowerCase(),
    sizeBytes: typeof parsed.sizeBytes === "number" ? parsed.sizeBytes : undefined,
  };
}

/** Direct CDN URL for update.json (no GitHub list API). */
export function buildFloraSocialUpdateJsonUrl(version: string): string {
  const v = version.trim();
  return `https://github.com/effka11/Flora.Ecosystem/releases/download/social/v${v}/flora.social-android-update.json`;
}

/**
 * Fetch flora.social-android-update.json via release CDN (not api.github.com).
 */
export async function fetchDirectUpdateManifestForVersion(
  version: string,
): Promise<AndroidUpdateManifest | null> {
  if (Platform.OS !== "android") return null;
  const v = version.trim();
  if (!v) return null;
  const url = buildFloraSocialUpdateJsonUrl(v);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "*/*", "User-Agent": userAgent() },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.text();
    const parsed = JSON.parse(body.replace(/^\uFEFF/, "")) as Partial<AndroidUpdateManifest>;
    if (
      typeof parsed.version !== "string" ||
      typeof parsed.versionCode !== "number" ||
      !Number.isInteger(parsed.versionCode) ||
      parsed.versionCode < 1 ||
      typeof parsed.apkUrl !== "string" ||
      typeof parsed.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(parsed.sha256)
    ) {
      return null;
    }
    return {
      version: parsed.version,
      versionCode: parsed.versionCode,
      apkFileName: parsed.apkFileName ?? `flora.social-v${parsed.version}-android.apk`,
      apkUrl: parsed.apkUrl,
      sha256: parsed.sha256.toLowerCase(),
      sizeBytes: typeof parsed.sizeBytes === "number" ? parsed.sizeBytes : undefined,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Interactive notification path: build APK URL from notification text with
 * zero network calls (no api.github.com). Avoids infinite "checking" when the
 * GitHub API is slow/blocked while release CDN still works.
 */
export function buildDirectUpdateManifestFromNotificationText(
  text: string,
): AndroidUpdateManifest | null {
  if (Platform.OS !== "android") return null;
  const version = parseAppUpdateVersionFromText(text);
  if (!version) return null;
  return {
    version,
    versionCode: null,
    apkFileName: `flora.social-v${version}-android.apk`,
    apkUrl: buildFloraSocialApkDownloadUrl(version),
    sha256: "",
  };
}

/**
 * Legacy interactive fallback for releases created before update.json existed.
 * Integrity still comes from GitHub's immutable release-asset SHA-256 metadata;
 * versionCode remains unknown, so this result must never be used silently.
 */
export async function fetchUpdateManifestFromNotificationText(
  text: string,
): Promise<AndroidUpdateManifest | null> {
  if (Platform.OS !== "android") return null;

  const version = parseAppUpdateVersionFromText(text);
  if (!version) return null;

  const releases = await fetchReleases();
  const release = releases.find((candidate) => candidate.tag_name === `social/v${version}`);
  if (!release) return null;

  const expectedName = `flora.social-v${version}-android.apk`;
  const asset = (release.assets ?? []).find((candidate) => candidate.name === expectedName);
  const sha256 = parseAssetSha256(asset?.digest);
  if (!asset?.browser_download_url || !sha256) return null;

  return {
    version,
    versionCode: null,
    apkFileName: expectedName,
    apkUrl: asset.browser_download_url,
    sha256,
    sizeBytes:
      typeof asset.size === "number" && asset.size > 0 ? asset.size : undefined,
  };
}

export function getInstalledVersionCode(): number {
  if (Platform.OS !== "android") return 0;
  const raw = nativeBuildVersion;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? n : 0;
}
