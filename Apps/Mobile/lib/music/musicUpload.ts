import type { TrackArtistCreditInput } from "@flora/client-core/contracts";
import { File } from "expo-file-system";
import { uploadMultipartFile } from "@/lib/multipartUpload";

export const MUSIC_UPLOAD_MAX_BYTES = 70 * 1024 * 1024;
export const MUSIC_COVER_MAX_BYTES = 5 * 1024 * 1024;

const KNOWN_AUDIO_EXT = /\.(mp3|m4a|mp4|aac|flac|wav|ogg|opus|webm|wma|aiff|aif)$/i;

export type PickedMusicFile = {
  uri: string;
  name: string;
  mimeType?: string | null;
  size?: number | null;
};

export function validateMusicUploadFile(file: PickedMusicFile): string | null {
  const mime = file.mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";
  const isAudio = mime.startsWith("audio/") || KNOWN_AUDIO_EXT.test(file.name);
  if (!isAudio) return "Нужен поддерживаемый аудиофайл (MP3, M4A, FLAC, WAV и др.).";
  if ((file.size ?? 0) > MUSIC_UPLOAD_MAX_BYTES) return "Размер файла не должен превышать 70 МБ.";
  return null;
}

export function validateMusicCoverFile(file: PickedMusicFile): string | null {
  const mime = file.mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime && !mime.startsWith("image/")) return "Обложка должна быть изображением.";
  if ((file.size ?? 0) > MUSIC_COVER_MAX_BYTES) return "Обложка слишком большая (макс. 5 МБ).";
  return null;
}

export function formatFileSizeRu(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(".", ",")} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} МБ`;
}

function parseUploadedTrack(raw: unknown): string {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const trackUuid =
    (typeof o.trackUuid === "string" && o.trackUuid) ||
    (typeof o.TrackUuid === "string" && o.TrackUuid) ||
    "";
  if (!trackUuid) throw new Error("Некорректный ответ сервера при загрузке трека.");
  return trackUuid;
}

export async function uploadMusicTrackSelf(params: {
  file: PickedMusicFile;
  title: string;
  artist?: string;
  tags: string;
  coverColorId: string;
  trackKindId: string;
  durationMs?: number;
}): Promise<string> {
  const raw = await uploadMultipartFile({
    path: "/api/music/tracks/self",
    file: new File(params.file.uri),
    mimeType: params.file.mimeType ?? "audio/mpeg",
    parameters: {
      title: params.title,
      artist: params.artist ?? "",
      tags: params.tags,
      coverColorId: params.coverColorId,
      trackKindId: params.trackKindId,
      durationMs: String(Math.max(1, Math.round(params.durationMs ?? 1))),
    },
  });
  return parseUploadedTrack(raw);
}

export async function uploadMusicTrackPlatform(params: {
  file: PickedMusicFile;
  title: string;
  artistCredits: TrackArtistCreditInput[];
  genreId: string;
  licenseId: string;
  termsAccepted: boolean;
  cover?: PickedMusicFile | null;
  durationMs?: number;
}): Promise<string> {
  const parameters: Record<string, string> = {
    title: params.title,
    artistCredits: JSON.stringify(params.artistCredits),
    genreId: params.genreId,
    licenseId: params.licenseId,
    termsAccepted: params.termsAccepted ? "true" : "false",
    durationMs: String(Math.max(1, Math.round(params.durationMs ?? 1))),
  };

  // Current mobile multipart helper supports one file field. Platform cover can be added later
  // by extending it to multi-file upload; Web already sends the optional cover.
  if (params.cover) {
    parameters.coverFileName = params.cover.name;
  }

  const raw = await uploadMultipartFile({
    path: "/api/music/tracks/platform",
    file: new File(params.file.uri),
    mimeType: params.file.mimeType ?? "audio/mpeg",
    parameters,
  });
  return parseUploadedTrack(raw);
}
