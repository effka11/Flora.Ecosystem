import { apiUrl } from "../api/client.js";

/** Публичный URL изображения поста (GET без авторизации). */
export function postImageUrl(imageUuid: string): string {
  const id = imageUuid.trim();
  // `fmt=fri` сбрасывает immutable browser/CDN cache от эпохи WebP/AVIF/ImageSet.
  return apiUrl(`/api/auth/posts/images/${encodeURIComponent(id)}?fmt=fri`);
}
