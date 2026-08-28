import { describe, expect, it } from "vitest";
import {
  downloadLocalUriKind,
  fileUriFilesystemPath,
  shouldCopyViaContentResolver,
} from "@/lib/apkUpdate/downloadLocalUri";

describe("DownloadManager local URI scheme contract", () => {
  it("does not treat content:// as a file path (old removePrefix('file://') bug)", () => {
    const uri = "content://downloads/my_downloads/42";
    expect(uri.startsWith("file://")).toBe(false);
    // Kotlin removePrefix("file://") is a no-op; File("content://...") never exists.
    expect(uri.replace(/^file:\/\//, "")).toBe(uri);
    expect(downloadLocalUriKind(uri)).toBe("content");
    expect(shouldCopyViaContentResolver(uri)).toBe(true);
    expect(fileUriFilesystemPath(uri)).toBeNull();
  });

  it("parses file:// to a filesystem path", () => {
    const uri = "file:///storage/emulated/0/Android/data/social.flora.mobile/files/flora-update/pending.apk";
    expect(downloadLocalUriKind(uri)).toBe("file");
    expect(shouldCopyViaContentResolver(uri)).toBe(false);
    expect(fileUriFilesystemPath(uri)).toBe(
      "/storage/emulated/0/Android/data/social.flora.mobile/files/flora-update/pending.apk",
    );
  });

  it("rejects other schemes as neither file copy nor ContentResolver", () => {
    expect(downloadLocalUriKind("https://example/pending.apk")).toBe("other");
    expect(shouldCopyViaContentResolver("https://example/pending.apk")).toBe(false);
    expect(fileUriFilesystemPath("https://example/pending.apk")).toBeNull();
  });
});
