/** Pure check: installed build matches an entry in the Flora APK channel catalog. */

export function isOfficialChannelRelease(
  installedVersion: string,
  installedVersionCode: number,
  releases: readonly { version: string; versionCode: number }[],
): boolean {
  if (!installedVersion || installedVersionCode < 1 || releases.length === 0) {
    return false;
  }
  return releases.some(
    (r) => r.versionCode === installedVersionCode && r.version === installedVersion,
  );
}
