import {
  FLORA_APK_CHANNEL_RELEASES_URL,
  parseFloraApkChannelCatalog,
  type FloraApkChannelRelease,
} from "@/lib/apkChannel";

export async function fetchFloraApkChannelReleases(): Promise<FloraApkChannelRelease[]> {
  try {
    const res = await fetch(FLORA_APK_CHANNEL_RELEASES_URL, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Flora.Web/download",
      },
      next: { revalidate: 60 },
    });
    if (!res.ok) return [];
    const raw: unknown = await res.json();
    return parseFloraApkChannelCatalog(raw)?.releases ?? [];
  } catch {
    return [];
  }
}
