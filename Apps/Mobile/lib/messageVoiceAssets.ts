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

const uriCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

function normalizeAssetId(assetUuid: string): string {
  return assetUuid.trim().toLowerCase();
}

async function writeBytesToCachePath(
  bytes: Uint8Array,
  assetUuid: string,
  contentType: string,
): Promise<string> {
  const ext = contentType.includes("mp4") || contentType.includes("m4a") ? "m4a" : "bin";
  const name = `msg-voice-${normalizeAssetId(assetUuid)}.${ext}`;
  const file = new File(Paths.cache, name);
  if (file.exists) file.delete();
  file.create();
  writeExpoFileBytes(file, bytes);
  return file.uri;
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

async function postEncryptedVoiceForm(params: {
  toUserUuid: string;
  durationMs: number;
  file: File;
}): Promise<{ voiceAssetUuid: string; contentType: string; durationMs: number }> {
  const raw = await uploadMultipartFile({
    path: "/api/messaging/voice-assets",
    file: params.file,
    parameters: {
      toUserUuid: params.toUserUuid,
      durationMs: String(Math.max(1, Math.round(params.durationMs))),
    },
  });
  return parseUploadedVoice(raw, VOICE_HE_AAC_CONTENT_TYPE, params.durationMs);
}

export async function uploadPreparedMessageVoice(params: {
  toUserUuid: string;
  sourceUri: string;
  contentType: string;
  durationMs: number;
  waveform: number[];
}): Promise<FscpVoiceBlock> {
  const source = new File(params.sourceUri);
  const audioBytes = await readExpoFileBytes(source);
  const encrypted = await encryptMediaBytes(audioBytes);
  const encryptedFile = await writeEncryptedUploadFile(encrypted.cipher);
  const uploaded = await postEncryptedVoiceForm({
    toUserUuid: params.toUserUuid,
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

export function peekMessageVoiceUri(assetUuid: string): string | null {
  return uriCache.get(normalizeAssetId(assetUuid)) ?? null;
}

export async function ensureMessageVoiceUri(block: FscpVoiceBlock): Promise<string> {
  const id = normalizeAssetId(block.assetUuid);
  const cached = uriCache.get(id);
  if (cached) return cached;

  const pending = inflight.get(id);
  if (pending) return pending;

  const task = (async () => {
    const encryptedBuffer = await apiDownloadMessageVoiceAsset(block.assetUuid);
    const plainBytes = await decryptMediaBytes({
      cipher: encryptedBuffer,
      keyBase64Url: block.encryption.keyBase64Url,
      nonceBase64Url: block.encryption.nonceBase64Url,
    });
    const uri = await writeBytesToCachePath(plainBytes, block.assetUuid, block.contentType);
    uriCache.set(id, uri);
    clearPendingVoiceUri(block.assetUuid);
    return uri;
  })().finally(() => {
    inflight.delete(id);
  });

  inflight.set(id, task);
  return task;
}
