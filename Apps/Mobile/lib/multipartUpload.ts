import {
  apiUrl,
  ApiRequestError,
  getApiClientConfig,
  refreshSessionIfPossible,
} from "@flora/client-core/api";
import { File, UploadType } from "expo-file-system";
import { assertExpoFileUpload } from "@/lib/expoFileBytes";

function parseUploadError(status: number, body: string): string {
  let message = `Ошибка ${status}`;
  try {
    const data = JSON.parse(body) as { error?: string };
    if (typeof data.error === "string" && data.error.trim()) message = data.error;
  } catch {
    if (body.trim()) message = body.trim();
  }
  return message;
}

/** Multipart upload через expo-file-system (RN fetch FormData с uri ненадёжен). */
export async function uploadMultipartFile(params: {
  path: string;
  file: File;
  fieldName?: string;
  mimeType?: string;
  parameters?: Record<string, string>;
}): Promise<unknown> {
  const uploadOnce = async () => {
    const { session, clientIdentity } = getApiClientConfig();
    const token = await session.getAccessToken();
    if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");

    assertExpoFileUpload(params.file);
    const result = await params.file.upload(apiUrl(params.path), {
      uploadType: UploadType.MULTIPART,
      httpMethod: "POST",
      fieldName: params.fieldName ?? "file",
      mimeType: params.mimeType ?? "application/octet-stream",
      parameters: params.parameters,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "X-Flora-Client": `${clientIdentity.platform}/${clientIdentity.appVersion}`,
      },
    });

    if (result.status >= 200 && result.status < 300) {
      try {
        return JSON.parse(result.body) as unknown;
      } catch {
        return {};
      }
    }

    throw new ApiRequestError(result.status, parseUploadError(result.status, result.body));
  };

  try {
    return await uploadOnce();
  } catch (err) {
    if (!(err instanceof ApiRequestError) || err.status !== 401) throw err;
    if (!(await refreshSessionIfPossible())) throw err;
    return await uploadOnce();
  }
}
