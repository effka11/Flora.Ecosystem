/** Лимиты загрузки видео к посту — синхронно с ImportedSocialController (AllowedPostVideoTypes, MaxPostVideoBytes). */
export const MAX_POST_VIDEO_BYTES = 200 * 1024 * 1024;
export const POST_VIDEO_ACCEPT = "video/mp4,video/quicktime,video/webm,video/x-matroska";

const ALLOWED_POST_VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"]);

function inferPostVideoMime(file: File): string | null {
  const type = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (ALLOWED_POST_VIDEO_TYPES.has(type)) return type;
  const name = file.name.trim().toLowerCase();
  if (name.endsWith(".mp4") || name.endsWith(".m4v")) return "video/mp4";
  if (name.endsWith(".mov")) return "video/quicktime";
  if (name.endsWith(".webm")) return "video/webm";
  if (name.endsWith(".mkv")) return "video/x-matroska";
  return null;
}

/** null — файл не подходит; иначе File с корректным MIME (Windows часто отдаёт пустой type). */
export function normalizePostVideoFile(file: File): File | null {
  const mime = inferPostVideoMime(file);
  if (!mime || file.size <= 0 || file.size > MAX_POST_VIDEO_BYTES) return null;
  if (file.type === mime) return file;
  return new File([file], file.name.trim().length > 0 ? file.name : "video.mp4", {
    type: mime,
    lastModified: file.lastModified,
  });
}

export function postVideoAttachError(file: File): string | null {
  if (file.size > MAX_POST_VIDEO_BYTES) return "Видео до 200 МБ.";
  if (!inferPostVideoMime(file)) return "Поддерживаются MP4, MOV, WebM и MKV.";
  return null;
}
