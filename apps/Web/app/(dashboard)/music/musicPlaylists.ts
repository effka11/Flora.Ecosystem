export type PlaylistVariant =
  | "playlistCardUploaded"
  | "playlistCardUploadedPlatform"
  | "playlistCardLiked"
  | "playlistCardUser";

export type PlaylistKind = "system" | "user";

export type PlaylistItem = {
  id: string;
  title: string;
  trackCount: number;
  kind: PlaylistKind;
  variant: PlaylistVariant;
  canDelete: boolean;
  coverColorId: string | null;
};

export function formatPlaylistTrackCount(count: number): string {
  const n = Math.max(0, Math.floor(count));
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} трек`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} трека`;
  return `${n} треков`;
}

export function playlistVariantToClass(variant: string): PlaylistVariant {
  if (variant === "uploaded-personal" || variant === "uploaded") return "playlistCardUploaded";
  if (variant === "uploaded-platform") return "playlistCardUploadedPlatform";
  if (variant === "favorites") return "playlistCardLiked";
  return "playlistCardUser";
}

export function mapPlaylistSummaryDto(raw: {
  id: string;
  title: string;
  trackCount: number;
  kind: string;
  variant: string;
  canDelete: boolean;
  coverColorId: string | null;
}): PlaylistItem {
  return {
    id: raw.id,
    title: raw.title,
    trackCount: raw.trackCount,
    kind: raw.kind === "user" ? "user" : "system",
    variant: playlistVariantToClass(raw.variant),
    canDelete: raw.canDelete,
    coverColorId: raw.coverColorId,
  };
}
