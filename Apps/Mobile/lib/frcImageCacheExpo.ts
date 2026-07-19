import { FRC_I_MIME } from "@flora/client-core/frc-i";
import { Directory, File, FileMode, Paths } from "expo-file-system";
import QuickCrypto from "react-native-quick-crypto";
import { decodeFrcFileToPng, isFloraFrcIAvailable } from "flora-frc-i";
import type { FrcCacheBackend, FrcCacheEntryRecord } from "@/lib/frcImageCache";

/**
 * expo-file-system / native backend for {@link FrcImageCache}. Kept separate
 * from the pure cache core so the core's protocol and budget logic can be
 * unit-tested without pulling in React Native.
 */

const CACHE_NAMESPACE = "frc-i-v1";
const FINAL_SUFFIX = ".png";
const PART_SUFFIX = ".part";

function nonce(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function createExpoFrcCacheBackend(): FrcCacheBackend {
  const dir = new Directory(Paths.cache, CACHE_NAMESPACE);
  const fileFor = (name: string) => new File(dir, name);

  return {
    ensureReady() {
      if (!dir.exists) dir.create({ intermediates: true });
    },
    listFinalEntries() {
      const out: FrcCacheEntryRecord[] = [];
      if (!dir.exists) return out;
      for (const entry of dir.list()) {
        if (!(entry instanceof File)) continue;
        const name = entry.name;
        if (name.endsWith(PART_SUFFIX)) continue;
        if (!name.endsWith(FINAL_SUFFIX)) continue;
        const hash = name.slice(0, -FINAL_SUFFIX.length);
        if (!/^[a-f0-9]{64}$/.test(hash)) continue;
        out.push({ hash, uri: entry.uri, size: entry.size ?? 0 });
      }
      return out;
    },
    deleteStaleParts() {
      if (!dir.exists) return;
      for (const entry of dir.list()) {
        if (entry instanceof File && entry.name.endsWith(PART_SUFFIX)) {
          try {
            entry.delete();
          } catch {
            /* best-effort sweep */
          }
        }
      }
    },
    finalUri(hash) {
      return fileFor(`${hash}${FINAL_SUFFIX}`).uri;
    },
    tempPartUri(hash, suffix) {
      return fileFor(`${hash}.${nonce()}.${suffix}${PART_SUFFIX}`).uri;
    },
    fileExists(uri) {
      return new File(uri).exists;
    },
    fileSize(uri) {
      return new File(uri).size ?? 0;
    },
    deleteFile(uri) {
      const file = new File(uri);
      if (file.exists) file.delete();
    },
    async download(url, destUri, signal) {
      await File.downloadFileAsync(url, new File(destUri), {
        headers: { Accept: FRC_I_MIME },
        idempotent: true,
        signal,
      });
    },
    readHeader(uri, length) {
      const handle = new File(uri).open(FileMode.ReadOnly);
      try {
        return handle.readBytes(length);
      } finally {
        handle.close();
      }
    },
    async decode(friUri, pngDestUri) {
      if (!isFloraFrcIAvailable()) {
        throw new Error(
          "FRC-I native decoder недоступен (нет libfrc_i_mobile_ffi). " +
            "npm run frc-i:native:android, затем reinstall Flora Dev (-ReplaceExisting).",
        );
      }
      await decodeFrcFileToPng(friUri, pngDestUri);
    },
    moveFile(fromUri, toUri) {
      new File(fromUri).moveSync(new File(toUri));
    },
    hashUrl(url) {
      return QuickCrypto.createHash("sha256").update(url).digest("hex");
    },
  };
}
