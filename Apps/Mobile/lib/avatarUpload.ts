import {
  ApiRequestError,
  apiUrl,
  getApiClientConfig,
  isApiRequestError,
  refreshSessionIfPossible,
} from "@flora/client-core/api";
import Constants from "expo-constants";
import { File, UploadType, getInfoAsync } from "expo-file-system";
import type { ImagePickerAsset } from "expo-image-picker";
import { Image } from "react-native-compressor";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type AvatarUploadFile = {
  uri: string;
  name: string;
  type: string;
};

function normalizeMimeType(mimeType?: string | null, fileName?: string | null): string {
  const raw = (mimeType ?? "").toLowerCase().split(";")[0].trim();
  if (ALLOWED_TYPES.has(raw)) return raw;
  const ext = (fileName ?? "").split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

function fileNameForType(type: string): string {
  if (type === "image/png") return "avatar.png";
  if (type === "image/webp") return "avatar.webp";
  return "avatar.jpg";
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

function parseUploadError(body: string, status: number): string {
  try {
    const data = JSON.parse(body) as { error?: string; detail?: string; Detail?: string };
    const base = typeof data.error === "string" ? data.error : `Ошибка ${status}`;
    const detailRaw = data.detail ?? data.Detail;
    const detail = typeof detailRaw === "string" && detailRaw.trim().length > 0 ? detailRaw.trim() : "";
    if (!detail || base.includes(detail)) return base;
    return `${base} (${detail})`;
  } catch {
    return `Ошибка ${status}`;
  }
}

function parseAvatarUuid(body: string): string {
  const raw = JSON.parse(body) as Record<string, unknown>;
  const avatarUuid =
    (typeof raw.avatarUuid === "string" && raw.avatarUuid) ||
    (typeof raw.AvatarUuid === "string" && raw.AvatarUuid) ||
    (typeof raw.avatar_uuid === "string" && raw.avatar_uuid) ||
    "";
  if (!avatarUuid) throw new Error("Некорректный ответ загрузки аватара.");
  return avatarUuid;
}

/** Сжимает/конвертирует изображение перед загрузкой аватара. */
export async function prepareAvatarUploadFile(asset: ImagePickerAsset): Promise<AvatarUploadFile> {
  const initialType = normalizeMimeType(asset.mimeType, asset.fileName);
  const initialSize = await fileSize(asset.uri);
  const rawMime = (asset.mimeType ?? "").toLowerCase().split(";")[0].trim();
  const isAllowedMime = ALLOWED_TYPES.has(rawMime);
  const needsProcessing = !isAllowedMime || initialSize == null || initialSize > MAX_AVATAR_BYTES;

  let uri = asset.uri;
  let type = initialType;

  if (needsProcessing) {
    try {
      uri = await Image.compress(asset.uri, {
        maxWidth: 512,
        maxHeight: 512,
        quality: 0.85,
        output: "jpg",
      });
      type = "image/jpeg";
    } catch {
      uri = asset.uri;
      type = initialType;
    }
  }

  const size = await fileSize(uri);
  if (size != null && size > MAX_AVATAR_BYTES) {
    throw new Error("Файл не должен превышать 2 МБ.");
  }

  return {
    uri,
    name: fileNameForType(type),
    type,
  };
}

async function uploadPreparedAvatarFile(prepared: AvatarUploadFile): Promise<string> {
  const uploadOnce = async () => {
    const { session, clientIdentity } = getApiClientConfig();
    const token = await session.getAccessToken();
    if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");

    const file = new File(prepared.uri);
    return file.upload(apiUrl("/api/auth/profile/avatar"), {
      httpMethod: "POST",
      uploadType: UploadType.MULTIPART,
      fieldName: "file",
      mimeType: prepared.type,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "X-Flora-Client": `${clientIdentity.platform}/${clientIdentity.appVersion ?? Constants.expoConfig?.version ?? "0.3.0-alpha"}`,
      },
    });
  };

  let result = await uploadOnce();
  if (result.status === 401 && (await refreshSessionIfPossible())) {
    result = await uploadOnce();
  }

  if (result.status === 401) {
    throw new ApiRequestError(401, parseUploadError(result.body, result.status));
  }
  if (result.status < 200 || result.status >= 300) {
    throw new ApiRequestError(result.status, parseUploadError(result.body, result.status));
  }

  return parseAvatarUuid(result.body);
}

export async function uploadAvatarFromPickerAsset(asset: ImagePickerAsset): Promise<string> {
  const prepared = await prepareAvatarUploadFile(asset);
  return uploadPreparedAvatarFile(prepared);
}

export function avatarUploadErrorMessage(err: unknown): string {
  if (isApiRequestError(err)) return err.message;
  if (err instanceof Error && err.message.trim().length > 0) return err.message;
  return "Не удалось загрузить аватар.";
}
