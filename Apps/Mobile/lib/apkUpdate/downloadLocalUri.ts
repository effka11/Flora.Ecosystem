/**
 * Scheme contract for DownloadManager COLUMN_LOCAL_URI.
 * Mirrors Kotlin adoptDownloadManagerFile: content:// must not be treated as a filesystem
 * path (old bug: File(localUri.removePrefix("file://")) — prefix strip is a no-op on content://).
 */

export type DownloadLocalUriKind = "file" | "content" | "other";

export function downloadLocalUriKind(localUri: string): DownloadLocalUriKind {
  const trimmed = localUri.trim().toLowerCase();
  if (trimmed.startsWith("content:")) return "content";
  if (trimmed.startsWith("file:")) return "file";
  return "other";
}

/** True when the APK must be copied via ContentResolver, not java.io.File. */
export function shouldCopyViaContentResolver(localUri: string): boolean {
  return downloadLocalUriKind(localUri) === "content";
}

/**
 * Filesystem path for `file://` URIs only.
 * Returns null for `content://` so callers cannot open them as File.
 */
export function fileUriFilesystemPath(localUri: string): string | null {
  if (downloadLocalUriKind(localUri) !== "file") return null;
  try {
    const url = new URL(localUri.trim());
    return decodeURIComponent(url.pathname);
  } catch {
    const stripped = localUri.trim().replace(/^file:\/\//i, "");
    if (!stripped) return null;
    return stripped.startsWith("/") ? stripped : `/${stripped}`;
  }
}
