import { useEffect, useMemo } from "react";
import type { FeedPostImagePreviewItem } from "@/app/_shared/FeedPostImages";

/** Лимиты загрузки фото к посту — синхронно с ImportedSocialController. */
export const MAX_POST_IMAGES = 10;
export const MAX_POST_IMAGE_BYTES = 5 * 1024 * 1024;
export const POST_IMAGE_ACCEPT = "image/jpeg,image/png,image/webp";

const ALLOWED_POST_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function isAllowedPostImageFile(file: File): boolean {
  const type = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  return ALLOWED_POST_IMAGE_TYPES.has(type) && file.size > 0 && file.size <= MAX_POST_IMAGE_BYTES;
}

/** Добавляет файлы к уже выбранным, пропуская невалидные и сверх лимита. */
function postImageExtension(mime: string): string {
  switch (mime.split(";")[0]?.trim().toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    default:
      return "png";
  }
}

/** Извлекает JPEG/PNG/WebP из буфера обмена (Ctrl+V, скриншот и т.д.). */
export function extractPastedPostImages(clipboardData: DataTransfer): File[] {
  const out: File[] = [];

  for (const item of Array.from(clipboardData.items)) {
    if (!item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (!file || !isAllowedPostImageFile(file)) continue;
    const named =
      file.name.trim().length > 0
        ? file
        : new File([file], `pasted-${out.length + 1}.${postImageExtension(file.type)}`, {
            type: file.type,
            lastModified: file.lastModified,
          });
    out.push(named);
  }

  if (out.length > 0) return out;

  for (const file of Array.from(clipboardData.files)) {
    if (!isAllowedPostImageFile(file)) continue;
    out.push(file);
  }

  return out;
}

export function mergePostImageFiles(existing: File[], incoming: FileList | File[]): File[] {
  const next = [...existing];
  for (const file of Array.from(incoming)) {
    if (next.length >= MAX_POST_IMAGES) break;
    if (!isAllowedPostImageFile(file)) continue;
    next.push(file);
  }
  return next;
}

export function composePostImagePreviewId(file: File, index: number): string {
  return `${file.name}-${file.lastModified}-${index}`;
}

/** Object URL превью для сетки в compose; revoke при смене списка файлов. */
export function useComposePostImagePreviews(files: File[]): FeedPostImagePreviewItem[] {
  const previews = useMemo(
    () =>
      files.map((file, index) => ({
        id: composePostImagePreviewId(file, index),
        src: URL.createObjectURL(file),
      })),
    [files],
  );

  useEffect(
    () => () => {
      for (const { src } of previews) URL.revokeObjectURL(src);
    },
    [previews],
  );

  return previews;
}
