import { apiUrl } from "../api/client.js";

/** Публичный URL изображения поста (GET без авторизации). */
export function postImageUrl(imageUuid: string): string {
  const id = imageUuid.trim();
  return apiUrl(`/api/auth/posts/images/${encodeURIComponent(id)}`);
}
