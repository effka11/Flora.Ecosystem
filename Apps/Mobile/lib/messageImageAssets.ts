import type { FscpImageBlock } from "@flora/client-core/fscp";
import { FRC_I_MIME, acceptsFrcI } from "@flora/client-core/frc-i";
import { File, Paths } from "expo-file-system";
import { isFloraFrcIAvailable } from "flora-frc-i";
import { encryptMediaBytes, decryptMediaBytes } from "@/lib/crypto/aesGcm";
import { readExpoFileBytes, writeExpoFileBytes } from "@/lib/expoFileBytes";
import { uploadMultipartFile } from "@/lib/multipartUpload";
import type { PreparedMessageImage } from "@/lib/messageImages";
import { decodeFrcBytesToFile, encodeImageUriToFrc } from "@/lib/frcImage";
import { apiDownloadMessageImageAsset } from "@flora/client-core/api";

const uriCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();
/**
 * Терминальные неудачи декода (например, legacy не-FRI): без этого кэша
 * каждый монтаж пузыря заново скачивал ассет из сети и пытался декодировать —
 * прямо в окне открытия чата. Сетевые ошибки сюда не попадают (ретраятся).
 */
const decodeFailed = new Map<string, Error>();

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

export type MessageImageUploadTarget =
  | { kind: "dm"; toUserUuid: string }
  | { kind: "group"; conversationUuid: string };

async function postEncryptedImageForm(params: {
  target: MessageImageUploadTarget;
  file: File;
  contentType: string;
}): Promise<{ imageAssetUuid: string; contentType: string }> {
  const raw =
    params.target.kind === "group"
      ? await uploadMultipartFile({
          path: `/api/messaging/groups/${encodeURIComponent(params.target.conversationUuid.trim())}/image-assets`,
          file: params.file,
          parameters: { contentType: params.contentType },
        })
      : await uploadMultipartFile({
          path: "/api/messaging/image-assets",
          file: params.file,
          parameters: {
            toUserUuid: params.target.toUserUuid,
            contentType: params.contentType,
          },
        });
  return parseUploadedImage(raw, params.contentType);
}

export async function uploadPreparedMessageImage(params: {
  toUserUuid?: string;
  uploadTarget?: MessageImageUploadTarget;
  prepared: PreparedMessageImage;
}): Promise<FscpImageBlock> {
  if (!isFloraFrcIAvailable()) {
    throw new Error("FRC-I недоступен на устройстве — отправка фото невозможна.");
  }
  const target: MessageImageUploadTarget =
    params.uploadTarget ??
    (params.toUserUuid
      ? { kind: "dm", toUserUuid: params.toUserUuid }
      : (() => {
          throw new Error("Нужен toUserUuid или uploadTarget для загрузки фото.");
        })());

  const friFile = await encodeImageUriToFrc(params.prepared.uri, 85);
  try {
    const friBytes = await readExpoFileBytes(friFile);
    const encryptedFrc = await encryptMediaBytes(friBytes);
    const encryptedFrcFile = await writeEncryptedUploadFile(encryptedFrc.cipher);
    try {
      const uploadedFrc = await postEncryptedImageForm({
        target,
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

/**
 * Детерминированный путь декодированного PNG: один asset — один файл, кэш
 * переживает рестарт процесса (раньше имя было случайным, и каждая сессия
 * заново качала и декодировала все фото).
 */
function decodedMessageImageFile(assetUuid: string): File {
  return new File(Paths.cache, `flora-frc-message-${normalizeAssetId(assetUuid)}.png`);
}

function peekDecodedMessageImageOnDisk(assetUuid: string): string | null {
  try {
    const file = decodedMessageImageFile(assetUuid);
    return file.exists && (file.size ?? 0) > 0 ? file.uri : null;
  } catch {
    return null;
  }
}

export function peekMessageImageUri(assetUuid: string): string | null {
  const id = normalizeAssetId(assetUuid);
  const cached = uriCache.get(id);
  if (cached) return cached;
  // Рестарт процесса: PNG декодирован прошлой сессией — первый кадр пузыря
  // берёт его с диска, без сети и повторного декода.
  const onDisk = peekDecodedMessageImageOnDisk(id);
  if (onDisk) uriCache.set(id, onDisk);
  return onDisk;
}

/**
 * Известная терминальная неудача декода — синхронно, для первого кадра пузыря:
 * ячейка сразу рендерит состояние ошибки, без «Загрузка…» → подмены на ошибку.
 */
export function peekMessageImageFailure(assetUuid: string): Error | null {
  return decodeFailed.get(normalizeAssetId(assetUuid)) ?? null;
}

/** Локальный URI для optimistic photo-пузыря до upload. */
export function seedMessageImageUri(assetUuid: string, uri: string): void {
  const trimmed = uri.trim();
  if (!trimmed) return;
  uriCache.set(normalizeAssetId(assetUuid), trimmed);
}

export async function ensureMessageImageUri(block: FscpImageBlock): Promise<string> {
  const id = normalizeAssetId(block.assetUuid);
  const knownFailure = decodeFailed.get(id);
  if (knownFailure) return Promise.reject(knownFailure);

  if (!acceptsFrcI(block.contentType)) {
    // Терминально: contentType сообщения не изменится — кэшируем, чтобы каждый
    // монтаж пузыря не проходил через throw/warn заново.
    const err = new Error(
      "Сообщение содержит не-FRI изображение (legacy больше не поддерживается).",
    );
    decodeFailed.set(id, err);
    return Promise.reject(err);
  }
  if (!isFloraFrcIAvailable()) {
    throw new Error("FRC-I недоступен на устройстве.");
  }

  const cached = peekMessageImageUri(block.assetUuid);
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
    let uri: string;
    try {
      uri = await decodeFrcBytesToFile(friBytes, decodedMessageImageFile(id));
    } catch (e) {
      decodeFailed.set(id, e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
    uriCache.set(id, uri);
    return uri;
  })().finally(() => {
    inflight.delete(id);
  });

  inflight.set(id, task);
  return task;
}
