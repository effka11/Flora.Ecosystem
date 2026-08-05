const SHA256_HEX = /^[a-f0-9]{64}$/i;
const RELEASE_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/;

/** Official Flora Social APK channel (social.flora-s.net/apk). */
const CHANNEL_APK_PATH =
  /^\/apk\/flora\.social-v([0-9A-Za-z][0-9A-Za-z._+-]{0,127})-android\.apk$/;

/**
 * Legacy GitHub Releases path — dual-trust for one migration release.
 * TODO(apk-channel): remove after clients with channel trust are widely installed.
 */
const GITHUB_APK_PATH =
  /^\/effka11\/Flora\.Ecosystem\/releases\/download\/social\/v([0-9A-Za-z][0-9A-Za-z._+-]{0,127})\/flora\.social-v\1-android\.apk$/;

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
    return url.pathname.match(pathRe)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Only immutable Flora Social APK assets from the official channel
 * (plus legacy GitHub URLs during dual-trust migration).
 */
export function trustedFloraSocialApkVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return (
    trustedVersionFromUrl(value, "social.flora-s.net", CHANNEL_APK_PATH) ??
    trustedVersionFromUrl(value, "github.com", GITHUB_APK_PATH)
  );
}

export function isTrustedFloraSocialApkUrl(value: unknown): value is string {
  return trustedFloraSocialApkVersion(value) !== null;
}
