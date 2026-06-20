import {
  apiDownloadMessageImageAsset,
} from "@flora/client-core/api";
import type { FscpImageBlock } from "@flora/client-core/fscp";
import { File, Paths } from "expo-file-system";
import { decryptMediaBytes, encryptMediaBytes } from "@/lib/crypto/aesGcm";
import { readExpoFileBytes, writeExpoFileBytes } from "@/lib/expoFileBytes";
import { uploadMultipartFile } from "@/lib/multipartUpload";
import type { PreparedMessageImage } from "@/lib/messageImages";

const uriCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

function normalizeAssetId(assetUuid: string): string {
  return assetUuid.trim().toLowerCase();
}

function extForContentType(contentType: string): string {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  return "jpg";
}

async function writeBytesToCachePath(
  bytes: Uint8Array,
  assetUuid: string,
  contentType: string,
): Promise<string> {
  const name = `msg-img-${normalizeAssetId(assetUuid)}.${extForContentType(contentType)}`;
  const file = new File(Paths.cache, name);
  if (file.exists) file.delete();
  file.create();
  writeExpoFileBytes(file, bytes);
  return file.uri;
}

function parseUploadedImage(raw: unknown, fallbackContentType: string): { imageAssetUuid: string; contentType: string } {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const imageAssetUuid =
    (typeof o.imageAssetUuid === "string" && o.imageAssetUuid) ||
    (typeof o.ImageAssetUuid === "string" && o.ImageAssetUuid) ||
    "";
  if (!imageAssetUuid) throw new Error("Некорректный ответ сервера при загрузке фото.");
  const contentType =
    (typeof o.contentType === "string" && o.contentType) ||
    (typeof o.ContentType === "string" && o.ContentType) ||
    fallbackContentType;
  return { imageAssetUuid, contentType };
}

async function writeEncryptedUploadFile(bytes: Uint8Array): Promise<File> {
  const file = new File(Paths.cache, `image-upload-${Date.now()}.bin`);
  if (file.exists) file.delete();
  file.create();
  writeExpoFileBytes(file, bytes);
  return file;
}

async function postEncryptedImageForm(params: {
  toUserUuid: string;
  file: File;
  contentType: string;
}): Promise<{ imageAssetUuid: string; contentType: string }> {
  const raw = await uploadMultipartFile({
    path: "/api/messaging/image-assets",
    file: params.file,
    parameters: {
      toUserUuid: params.toUserUuid,
      contentType: params.contentType,
    },
  });
  return parseUploadedImage(raw, params.contentType);
}

export async function uploadPreparedMessageImage(params: {
  toUserUuid: string;
  prepared: PreparedMessageImage;
}): Promise<FscpImageBlock> {
  const source = new File(params.prepared.uri);
  const imageBytes = await readExpoFileBytes(source);
  const encrypted = await encryptMediaBytes(imageBytes);
  const encryptedFile = await writeEncryptedUploadFile(encrypted.cipher);
  const uploaded = await postEncryptedImageForm({
    toUserUuid: params.toUserUuid,
    file: encryptedFile,
    contentType: params.prepared.contentType,
  });

  return {
    kind: "image",
    assetUuid: uploaded.imageAssetUuid,
    contentType: uploaded.contentType,
    encryption: {
      algorithm: "aes-gcm",
      keyBase64Url: encrypted.keyBase64Url,
      nonceBase64Url: encrypted.nonceBase64Url,
    },
  };
}

export function peekMessageImageUri(assetUuid: string): string | null {
  return uriCache.get(normalizeAssetId(assetUuid)) ?? null;
}

export async function ensureMessageImageUri(block: FscpImageBlock): Promise<string> {
  const id = normalizeAssetId(block.assetUuid);
  const cached = uriCache.get(id);
  if (cached) return cached;

  const pending = inflight.get(id);
  if (pending) return pending;

  const task = (async () => {
    const encryptedBuffer = await apiDownloadMessageImageAsset(block.assetUuid);
    const plainBytes = await decryptMediaBytes({
      cipher: encryptedBuffer,
      keyBase64Url: block.encryption.keyBase64Url,
      nonceBase64Url: block.encryption.nonceBase64Url,
    });
    const uri = await writeBytesToCachePath(plainBytes, block.assetUuid, block.contentType);
    uriCache.set(id, uri);
    return uri;
  })().finally(() => {
    inflight.delete(id);
  });

  inflight.set(id, task);
  return task;
}
