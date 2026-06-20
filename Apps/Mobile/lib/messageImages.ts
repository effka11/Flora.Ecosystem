import type { ImagePickerAsset } from "expo-image-picker";
import { getInfoAsync } from "expo-file-system";
import { Image } from "react-native-compressor";

/** Синхронно с Web `messageImages.ts` и `MaxMessageImageBytes` на API. */
export const MAX_MESSAGE_IMAGES = 10;
export const MAX_MESSAGE_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_PREPARE_MAX_LONG_SIDE = 2048;

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type PreparedMessageImage = {
  uri: string;
  contentType: string;
  fileName: string;
};

function normalizeMimeType(mimeType?: string | null, fileName?: string | null): string | null {
  const raw = (mimeType ?? "").toLowerCase().split(";")[0].trim();
  if (ALLOWED_TYPES.has(raw)) return raw;
  const ext = (fileName ?? "").split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return null;
}

function fileNameForType(type: string): string {
  if (type === "image/png") return "photo.png";
  if (type === "image/webp") return "photo.webp";
  return "photo.jpg";
}

async function fileSize(uri: string): Promise<number | null> {
  try {
    const info = await getInfoAsync(uri);
    if (!info.exists || typeof info.size !== "number") return null;
    return info.size;
  } catch {
    return null;
  }
}

export type MergeMessageImagesResult = {
  added: number;
  skippedInvalid: number;
  skippedLimit: number;
};

export function messageImageAttachError(result: MergeMessageImagesResult): string | null {
  if (result.added > 0) return null;
  if (result.skippedLimit > 0) return `Можно прикрепить не более ${MAX_MESSAGE_IMAGES} фото.`;
  if (result.skippedInvalid > 0) return "Поддерживаются JPEG, PNG и WebP до 5 МБ.";
  return null;
}

/** Сжимает фото перед E2E-отправкой (как prepareMessageImage на вебе). */
export async function prepareMessageImageFromAsset(asset: ImagePickerAsset): Promise<PreparedMessageImage> {
  const initialType = normalizeMimeType(asset.mimeType, asset.fileName);
  if (!initialType) throw new Error("Поддерживаются JPEG, PNG и WebP до 5 МБ.");

  const initialSize = await fileSize(asset.uri);
  const needsProcessing =
    initialSize == null || initialSize > MAX_MESSAGE_IMAGE_BYTES * 0.9 || (asset.width ?? 0) > IMAGE_PREPARE_MAX_LONG_SIDE;

  let uri = asset.uri;
  let type = initialType;

  if (needsProcessing) {
    try {
      uri = await Image.compress(asset.uri, {
        maxWidth: IMAGE_PREPARE_MAX_LONG_SIDE,
        maxHeight: IMAGE_PREPARE_MAX_LONG_SIDE,
        quality: 0.88,
        output: "jpg",
      });
      type = "image/jpeg";
    } catch {
      uri = asset.uri;
      type = initialType;
    }
  }

  const size = await fileSize(uri);
  if (size != null && size > MAX_MESSAGE_IMAGE_BYTES) {
    throw new Error("Фото слишком большое даже после сжатия.");
  }

  return {
    uri,
    contentType: type,
    fileName: fileNameForType(type),
  };
}
