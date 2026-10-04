import { FRC_I_MIME } from "@flora/client-core/frc-i";
import { Directory, File, FileMode, Paths } from "expo-file-system";
import QuickCrypto from "react-native-quick-crypto";
import { decodeFrcFileScaled, isFloraFrcIAvailable } from "flora-frc-i";
import type {
  FrcCacheBackend,
  FrcCacheEntryRecord,
  FrcCacheIndexStore,
  FrcDecodedFormat,
} from "@/lib/frcImageCache";
import { mmkv } from "@/lib/mmkv";

/**
 * Device bindings for {@link FrcImageCache}: expo-file-system for the files,
 * the native FRC-I decoder, and MMKV for the persisted index. Kept separate
 * from the pure cache core so the core's protocol and budget logic can be
 * unit-tested without pulling in React Native.
 */

const CACHE_NAMESPACE = "frc-i-v2";
/** Pre-bucket full-size PNGs. Wiped once by the core; see `deleteLegacyNamespace`. */
const LEGACY_CACHE_NAMESPACE = "frc-i-v1";
const PART_SUFFIX = ".part";
const EXTENSIONS: Record<FrcDecodedFormat, string> = { jpeg: ".jpg", png: ".png" };
/** `<sha256>@<bucket>.<ext>` — anything else in the directory is not ours. */
const FINAL_NAME = /^([0-9a-f]{64}@\d+)\.(?:jpg|png)$/;

function nonce(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Listing names may arrive percent-encoded (`hash%40128.jpg`). */
function finalCacheKey(name: string): string | undefined {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    decoded = name;
  }
  return FINAL_NAME.exec(decoded)?.[1];
}

function fileExistsAtUri(uri: string): boolean {
  if (new File(uri).exists) return true;
  const alt = uri.includes("%40") ? uri.replace(/%40/gi, "@") : uri.replace(/@/g, "%40");
  return alt !== uri && new File(alt).exists;
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
        const key = finalCacheKey(entry.name);
        if (!key) continue;
        out.push({ key, uri: entry.uri, size: entry.size ?? 0 });
      }
      return out;
    },
    listPartUris() {
      const out: string[] = [];
      if (!dir.exists) return out;
      for (const entry of dir.list()) {
        if (entry instanceof File && entry.name.endsWith(PART_SUFFIX)) out.push(entry.uri);
      }
      return out;
    },
    deleteLegacyNamespace() {
      const legacy = new Directory(Paths.cache, LEGACY_CACHE_NAMESPACE);
      if (legacy.exists) legacy.delete();
    },
    finalUri(key, format) {
      return fileFor(`${key}${EXTENSIONS[format]}`).uri;
    },
    tempPartUri(key, suffix) {
      return fileFor(`${key}.${nonce()}.${suffix}${PART_SUFFIX}`).uri;
    },
    fileExists(uri) {
      return fileExistsAtUri(uri);
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
    async decode(friUri, destUri, maxDimension, quality) {
      if (!isFloraFrcIAvailable()) {
        throw new Error(
          "FRC-I native decoder недоступен (нет libfrc_i_mobile_ffi). " +
            "npm run frc-i:native:android, затем reinstall Flora Dev (-ReplaceExisting).",
        );
      }
      return decodeFrcFileScaled(friUri, destUri, maxDimension, quality);
    },
    moveFile(fromUri, toUri) {
      new File(fromUri).moveSync(new File(toUri));
    },
    hashUrl(url) {
      return QuickCrypto.createHash("sha256").update(url).digest("hex");
    },
  };
}

/** The persisted index lives in the app's MMKV instance, not in the cache directory. */
export function createMmkvFrcCacheIndex(): FrcCacheIndexStore {
  return {
    getString: (key) => mmkv.getString(key),
    set: (key, value) => {
      mmkv.set(key, value);
    },
    delete: (key) => {
      mmkv.delete(key);
    },
  };
}
