import { profileInitials } from "@flora/client-core/display";

export function truncateUuid(uuid: string): string {
  const trimmed = uuid.trim();
  if (trimmed.length <= 13) return trimmed;
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-4)}`;
}

function normalizeUsername(username: string | null | undefined): string | null {
  if (!username) return null;
  const trimmed = username.trim().replace(/^@+/u, "");
  return trimmed || null;
}

/** Public handle: `@username`. */
export function formatFrankingHandle(username: string | null | undefined): string {
  const normalized = normalizeUsername(username);
  return normalized ? `@${normalized}` : "неизвестно";
}

/** Two letters for the peer avatar — same SoT as Social `FloraAvatar`. */
export function frankingPeerAvatarLetters(username: string | null | undefined): string {
  return profileInitials("", username ?? "");
}

export function formatFrankingTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export { readUserUuidFromAccessToken } from "@/lib/govAccessToken";
