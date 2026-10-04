import { asRecord, readStr } from "@flora/client-core/contracts";
import { File } from "expo-file-system";
import { uploadMultipartFile } from "@/lib/multipartUpload";

export type ComposeUploadFile = {
  uri: string;
  fileName: string;
  mimeType: string;
};

function parseImageUuids(raw: unknown): string[] {
  const o = asRecord(raw) ?? {};
  const uuidsRaw = o.imageUuids ?? o.ImageUuids;
  if (!Array.isArray(uuidsRaw)) return [];
  const out: string[] = [];
  for (const item of uuidsRaw) {
    if (typeof item === "string" && item.trim()) out.push(item.trim());
  }
  return out;
}

/** Загрузка фото по одному (поле `files`) — надёжнее FormData+uri на RN. */
export async function uploadPostImagesNative(
  postUuid: string,
  files: ComposeUploadFile[],
): Promise<string[]> {
  const id = postUuid.trim();
  if (!id || files.length === 0) return [];
  const all: string[] = [];
  for (const file of files) {
    const raw = await uploadMultipartFile({
      path: `/api/auth/posts/${encodeURIComponent(id)}/images`,
      file: new File(file.uri),
      fieldName: "files",
      mimeType: file.mimeType,
    });
    all.push(...parseImageUuids(raw));
  }
  return all;
}

export async function uploadPostVideoNative(
  postUuid: string,
  file: ComposeUploadFile,
): Promise<{ videoUuid: string }> {
  const id = postUuid.trim();
  if (!id) throw new Error("Не указан пост.");
  const raw = await uploadMultipartFile({
    path: `/api/auth/posts/${encodeURIComponent(id)}/video`,
    file: new File(file.uri),
    fieldName: "file",
    mimeType: file.mimeType,
  });
  const o = asRecord(raw) ?? {};
  const videoUuid = readStr(o, ["videoUuid", "VideoUuid"]);
  if (!videoUuid) throw new Error("Некорректный ответ сервера при загрузке видео.");
  return { videoUuid };
}
