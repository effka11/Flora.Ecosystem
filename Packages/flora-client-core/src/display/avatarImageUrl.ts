import { apiUrl } from "../api/client.js";

export function avatarImageUrl(avatarUuid: string): string {
  const id = avatarUuid.trim();
  return apiUrl(`/api/auth/avatar/${encodeURIComponent(id)}`);
}
