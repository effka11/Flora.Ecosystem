const SHA256_HEX = /^[a-f0-9]{64}$/i;
const RELEASE_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/;

/** Official Flora APK channel (social.flora-s.net/apk). Keep in sync with UpdateUrlAllowlist.kt and Apps/Web/lib/apkChannel.ts. */
const CHANNEL_APK_PATHS = [
  /^\/apk\/flora-v([0-9A-Za-z][0-9A-Za-z._+-]{0,127})\.apk$/i,
  /** Legacy sideload name; optional `-{hex}` after `-android` busts CDN. */
  /^\/apk\/flora\.social-v([0-9A-Za-z][0-9A-Za-z._+-]{0,127})-android(?:-[a-f0-9]{6,16})?\.apk$/i,
];

export function normalizeTrustedSha256(value: unknown): string | null {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) return null;
  return value.toLowerCase();
}

export function isSafeReleaseVersion(value: string): boolean {
  return RELEASE_VERSION.test(value);
}

function trustedVersionFromUrl(
  value: string,
  hostname: string,
  pathRe: RegExp,
): string | null {
  try {
    const url = new URL(value);
    const validOrigin =
      url.protocol === "https:" &&
      url.hostname === hostname &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "";
    if (!validOrigin) return null;
    const match = url.pathname.match(pathRe);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Only immutable Flora APK assets from the official channel. */
export function trustedFloraSocialApkVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  for (const pathRe of CHANNEL_APK_PATHS) {
    const version = trustedVersionFromUrl(value, "social.flora-s.net", pathRe);
    if (version) return version;
  }
  return null;
}

export function isTrustedFloraSocialApkUrl(value: unknown): value is string {
  return trustedFloraSocialApkVersion(value) !== null;
}
