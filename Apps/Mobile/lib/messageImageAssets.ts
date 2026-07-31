import type { FscpImageBlock } from "@flora/client-core/fscp";
import { FRC_I_MIME, acceptsFrcI } from "@flora/client-core/frc-i";
import { File, Paths } from "expo-file-system";
import { isFloraFrcIAvailable } from "flora-frc-i";
import { encryptMediaBytes, decryptMediaBytes } from "@/lib/crypto/aesGcm";
import { readExpoFileBytes, writeExpoFileBytes } from "@/lib/expoFileBytes";
import { uploadMultipartFile } from "@/lib/multipartUpload";
import type { PreparedMessageImage } from "@/lib/messageImages";
import { decodeFrcBytesToCache, encodeImageUriToFrc } from "@/lib/frcImage";
import { apiDownloadMessageImageAsset } from "@flora/client-core/api";

const uriCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

function normalizeAssetId(assetUuid: string): string {
  return assetUuid.trim().toLowerCase();
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
  if (!isFloraFrcIAvailable()) {
    throw new Error("FRC-I недоступен на устройстве — отправка фото невозможна.");
  }

  const friFile = await encodeImageUriToFrc(params.prepared.uri, 85);
  try {
    const friBytes = await readExpoFileBytes(friFile);
    const encryptedFrc = await encryptMediaBytes(friBytes);
    const encryptedFrcFile = await writeEncryptedUploadFile(encryptedFrc.cipher);
    try {
      const uploadedFrc = await postEncryptedImageForm({
        toUserUuid: params.toUserUuid,
        file: encryptedFrcFile,
        contentType: FRC_I_MIME,
      });
      return {
        kind: "image",
        assetUuid: uploadedFrc.imageAssetUuid,
        contentType: FRC_I_MIME,
        encryption: {
          algorithm: "aes-gcm",
          keyBase64Url: encryptedFrc.keyBase64Url,
          nonceBase64Url: encryptedFrc.nonceBase64Url,
        },
      };
    } finally {
      if (encryptedFrcFile.exists) encryptedFrcFile.delete();
    }
  } finally {
    if (friFile.exists) friFile.delete();
  }
}

export function peekMessageImageUri(assetUuid: string): string | null {
  return uriCache.get(normalizeAssetId(assetUuid)) ?? null;
}

/** Локальный URI для optimistic photo-пузыря до upload. */
export function seedMessageImageUri(assetUuid: string, uri: string): void {
  const trimmed = uri.trim();
  if (!trimmed) return;
  uriCache.set(normalizeAssetId(assetUuid), trimmed);
}

export async function ensureMessageImageUri(block: FscpImageBlock): Promise<string> {
  if (!acceptsFrcI(block.contentType)) {
    throw new Error("Сообщение содержит не-FRI изображение (legacy больше не поддерживается).");
  }
  if (!isFloraFrcIAvailable()) {
    throw new Error("FRC-I недоступен на устройстве.");
  }

  const id = normalizeAssetId(block.assetUuid);
  const cached = uriCache.get(id);
  if (cached) return cached;

  const pending = inflight.get(id);
  if (pending) return pending;

  const task = (async () => {
    const encryptedFrc = await apiDownloadMessageImageAsset(block.assetUuid);
    const friBytes = await decryptMediaBytes({
      cipher: encryptedFrc,
      keyBase64Url: block.encryption.keyBase64Url,
      nonceBase64Url: block.encryption.nonceBase64Url,
    });
    const uri = await decodeFrcBytesToCache(friBytes);
    uriCache.set(id, uri);
    return uri;
  })().finally(() => {
    inflight.delete(id);
  });

  inflight.set(id, task);
  return task;
}
