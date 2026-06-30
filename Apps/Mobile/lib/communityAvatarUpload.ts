import {
  ApiRequestError,
  apiUrl,
  getApiClientConfig,
  isApiRequestError,
  refreshSessionIfPossible,
} from "@flora/client-core/api";
import { parseCommunityAvatarUploadResponse } from "@flora/client-core/contracts";
import Constants from "expo-constants";
import { File, UploadType } from "expo-file-system";
import type { ImagePickerAsset } from "expo-image-picker";
import {
  avatarUploadErrorMessage,
  prepareAvatarUploadFile,
  type AvatarUploadFile,
} from "@/lib/avatarUpload";

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

async function uploadCommunityAvatarFile(communityId: string, prepared: AvatarUploadFile): Promise<string> {
  const path = `/api/auth/communities/${encodeURIComponent(communityId.trim())}/avatar`;

  const uploadOnce = async () => {
    const { session, clientIdentity } = getApiClientConfig();
    const token = await session.getAccessToken();
    if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");

    const file = new File(prepared.uri);
    return file.upload(apiUrl(path), {
      httpMethod: "POST",
      uploadType: UploadType.MULTIPART,
      fieldName: "file",
      mimeType: prepared.type,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "X-Flora-Client": `${clientIdentity.platform}/${clientIdentity.appVersion ?? Constants.expoConfig?.version ?? "0.2.0-alpha"}`,
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

  let parsedBody: unknown = result.body;
  try {
    parsedBody = JSON.parse(result.body);
  } catch {
    // keep raw string
  }
  const avatarUuid = parseCommunityAvatarUploadResponse(parsedBody);
  if (!avatarUuid) throw new ApiRequestError(500, "Некорректный ответ сервера.");
  return avatarUuid;
}

export async function uploadCommunityAvatarFromPickerAsset(
  communityId: string,
  asset: ImagePickerAsset,
): Promise<string> {
  const prepared = await prepareAvatarUploadFile(asset);
  return uploadCommunityAvatarFile(communityId, prepared);
}

export const communityAvatarUploadErrorMessage = avatarUploadErrorMessage;
