const SHA256_HEX = /^[a-f0-9]{64}$/i;
const RELEASE_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/;
const RELEASE_APK_PATH =
  /^\/effka11\/Flora\.Ecosystem\/releases\/download\/social\/v([0-9A-Za-z][0-9A-Za-z._+-]{0,127})\/flora\.social-v\1-android\.apk$/;

export function normalizeTrustedSha256(value: unknown): string | null {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) return null;
  return value.toLowerCase();
}

export function isSafeReleaseVersion(value: string): boolean {
  return RELEASE_VERSION.test(value);
}

/** Only immutable Flora Social APK assets from the canonical GitHub repository. */
export function trustedFloraSocialApkVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const validOrigin =
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "";
    if (!validOrigin) return null;
    return url.pathname.match(RELEASE_APK_PATH)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function isTrustedFloraSocialApkUrl(value: unknown): value is string {
  return trustedFloraSocialApkVersion(value) !== null;
}
