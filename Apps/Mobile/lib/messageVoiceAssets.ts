import {
  apiDownloadMessageVoiceAsset,
} from "@flora/client-core/api";
import type { FscpVoiceBlock } from "@flora/client-core/fscp";
import { File, Paths } from "expo-file-system";
import { decryptMediaBytes, encryptMediaBytes } from "@/lib/crypto/aesGcm";
import { readExpoFileBytes, writeExpoFileBytes } from "@/lib/expoFileBytes";
import { uploadMultipartFile } from "@/lib/multipartUpload";
import { clearPendingVoiceUri } from "@/lib/pendingVoiceOutgoing";
import { VOICE_HE_AAC_CONTENT_TYPE } from "@/lib/voiceLimits";
import { normalizePlayableAudioUri } from "@/lib/voicePlaybackAudio";

const uriCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

function normalizeAssetId(assetUuid: string): string {
  return assetUuid.trim().toLowerCase();
}

/** Flora voice is HE-AAC in MP4; expo-audio often refuses opaque `.bin` cache files. */
function voiceCacheExtension(contentType: string): string {
  const ct = contentType.trim().toLowerCase();
  if (
    ct.includes("webm") ||
    ct.includes("ogg") ||
    ct.includes("3gp") ||
    ct.includes("caf")
  ) {
    if (ct.includes("webm")) return "webm";
    if (ct.includes("ogg")) return "ogg";
    if (ct.includes("3gp")) return "3gp";
    return "caf";
  }
  return "m4a";
}

async function writeBytesToCachePath(
  bytes: Uint8Array,
  assetUuid: string,
  contentType: string,
): Promise<string> {
  const ext = voiceCacheExtension(contentType);
  const name = `msg-voice-${normalizeAssetId(assetUuid)}.${ext}`;
  const file = new File(Paths.cache, name);
  if (file.exists) file.delete();
  file.create();
  // Copy into a fresh ArrayBuffer-backed view — some RN TypedArray bridges
  // write 0 bytes when the source is a sliced/detached buffer from WebCrypto.
  const copy = Uint8Array.from(bytes);
  writeExpoFileBytes(file, copy);
  if (!file.exists || (file.size ?? 0) < 64) {
    // Fallback: base64 round-trip via string write is unavailable for binary;
    // retry once after recreate.
    if (file.exists) file.delete();
    file.create();
    writeExpoFileBytes(file, new Uint8Array(copy.buffer.slice(0)));
  }
  return normalizePlayableAudioUri(file.uri);
}

async function writeEncryptedUploadFile(bytes: Uint8Array): Promise<File> {
  const file = new File(Paths.cache, `voice-upload-${Date.now()}.bin`);
  if (file.exists) file.delete();
  file.create();
  writeExpoFileBytes(file, bytes);
  return file;
}

function parseUploadedVoice(
  raw: unknown,
  fallbackContentType: string,
  fallbackDurationMs: number,
): { voiceAssetUuid: string; contentType: string; durationMs: number } {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const voiceAssetUuid =
    (typeof o.voiceAssetUuid === "string" && o.voiceAssetUuid) ||
    (typeof o.VoiceAssetUuid === "string" && o.VoiceAssetUuid) ||
    "";
  if (!voiceAssetUuid) throw new Error("Некорректный ответ сервера при загрузке голосового.");
  const contentType =
    (typeof o.contentType === "string" && o.contentType) ||
    (typeof o.ContentType === "string" && o.ContentType) ||
    fallbackContentType;
  const durationMs =
    (typeof o.durationMs === "number" && o.durationMs) ||
    (typeof o.DurationMs === "number" && o.DurationMs) ||
    fallbackDurationMs;
  return { voiceAssetUuid, contentType, durationMs };
}

export type MessageVoiceUploadTarget =
  | { kind: "dm"; toUserUuid: string }
  | { kind: "group"; conversationUuid: string };

async function postEncryptedVoiceForm(params: {
  target: MessageVoiceUploadTarget;
  durationMs: number;
  file: File;
}): Promise<{ voiceAssetUuid: string; contentType: string; durationMs: number }> {
  const durationMs = String(Math.max(1, Math.round(params.durationMs)));
  const raw =
    params.target.kind === "group"
      ? await uploadMultipartFile({
          path: `/api/messaging/groups/${encodeURIComponent(params.target.conversationUuid.trim())}/voice-assets`,
          file: params.file,
          parameters: { durationMs },
        })
      : await uploadMultipartFile({
          path: "/api/messaging/voice-assets",
          file: params.file,
          parameters: {
            toUserUuid: params.target.toUserUuid,
            durationMs,
          },
        });
  return parseUploadedVoice(raw, VOICE_HE_AAC_CONTENT_TYPE, params.durationMs);
}

export async function uploadPreparedMessageVoice(params: {
  toUserUuid?: string;
  uploadTarget?: MessageVoiceUploadTarget;
  sourceUri: string;
  contentType: string;
  durationMs: number;
  waveform: number[];
}): Promise<FscpVoiceBlock> {
  const target: MessageVoiceUploadTarget =
    params.uploadTarget ??
    (params.toUserUuid
      ? { kind: "dm", toUserUuid: params.toUserUuid }
      : (() => {
          throw new Error("Нужен toUserUuid или uploadTarget для загрузки голосового.");
        })());
  const source = new File(params.sourceUri);
  const audioBytes = await readExpoFileBytes(source);
  const encrypted = await encryptMediaBytes(audioBytes);
  const encryptedFile = await writeEncryptedUploadFile(encrypted.cipher);
  const uploaded = await postEncryptedVoiceForm({
    target,
    durationMs: params.durationMs,
    file: encryptedFile,
  });

  return {
    kind: "voice",
    assetUuid: uploaded.voiceAssetUuid,
    durationMs: uploaded.durationMs || params.durationMs,
    waveform: params.waveform,
    contentType: params.contentType,
    encryption: {
      algorithm: "aes-gcm",
      keyBase64Url: encrypted.keyBase64Url,
      nonceBase64Url: encrypted.nonceBase64Url,
    },
  };
}

function isUsableVoiceFileUri(uri: string): boolean {
  if (!uri || uri.toLowerCase().endsWith(".bin")) return false;
  try {
    const file = new File(uri);
    return Boolean(file.exists && (file.size ?? 0) >= 64);
  } catch {
    return false;
  }
}

export function peekMessageVoiceUri(assetUuid: string): string | null {
  const id = normalizeAssetId(assetUuid);
  const cached = uriCache.get(id);
  if (!cached) return null;
  // Drop stale in-memory URIs (Fast Refresh / failed writes / OS cache eviction).
  if (!isUsableVoiceFileUri(cached)) {
    uriCache.delete(id);
    return null;
  }
  return cached;
}

export async function ensureMessageVoiceUri(block: FscpVoiceBlock): Promise<string> {
  const id = normalizeAssetId(block.assetUuid);
  const cached = peekMessageVoiceUri(block.assetUuid);
  if (cached) return cached;

  const pending = inflight.get(id);
  if (pending) return pending;

  const task = (async () => {
    const encryptedBuffer = await apiDownloadMessageVoiceAsset(block.assetUuid);
    if (!(encryptedBuffer instanceof ArrayBuffer) || encryptedBuffer.byteLength < 64) {
      throw new Error(`Пустой ответ сервера (${encryptedBuffer?.byteLength ?? 0} B)`);
    }
    let plainBytes: Uint8Array;
    try {
      plainBytes = await decryptMediaBytes({
        cipher: encryptedBuffer,
        keyBase64Url: block.encryption.keyBase64Url,
        nonceBase64Url: block.encryption.nonceBase64Url,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Расшифровка не удалась: ${detail}`);
    }
    if (plainBytes.byteLength < 64) {
      throw new Error(`Расшифровка дала ${plainBytes.byteLength} B`);
    }
    // Validate MP4/AAC container when content looks like m4a.
    const head = String.fromCharCode(
      plainBytes[4] ?? 0,
      plainBytes[5] ?? 0,
      plainBytes[6] ?? 0,
      plainBytes[7] ?? 0,
    );
    if (head !== "ftyp" && !block.contentType.toLowerCase().includes("webm")) {
      throw new Error(`После расшифровки не m4a (marker=${JSON.stringify(head)})`);
    }
    const uri = await writeBytesToCachePath(plainBytes, block.assetUuid, block.contentType);
    if (!isUsableVoiceFileUri(uri)) {
      throw new Error(`Не удалось сохранить голосовой файл (${uri})`);
    }
    const written = new File(uri);
    console.warn("[chat-voice] cached", { uri, size: written.size, head });
    uriCache.set(id, uri);
    clearPendingVoiceUri(block.assetUuid);
    return uri;
  })().finally(() => {
    inflight.delete(id);
  });

  inflight.set(id, task);
  return task;
}
