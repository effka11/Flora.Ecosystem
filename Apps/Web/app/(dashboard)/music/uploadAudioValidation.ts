export const MUSIC_UPLOAD_MAX_BYTES = 70 * 1024 * 1024;
export const MUSIC_COVER_MAX_BYTES = 5 * 1024 * 1024;

export const MUSIC_AUDIO_ACCEPT =
  "audio/*,.mp3,.m4a,.mp4,.aac,.flac,.wav,.ogg,.opus,.webm,.wma,.aiff,.aif";
export const MUSIC_COVER_ACCEPT = "image/*";

const AUDIO_MIME_PREFIX = "audio/";

const KNOWN_AUDIO_MIMES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/x-m4a",
  "audio/m4a",
  "audio/aac",
  "audio/flac",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/opus",
  "audio/webm",
  "audio/x-ms-wma",
  "audio/aiff",
  "audio/x-aiff",
]);

const KNOWN_AUDIO_EXT = /\.(mp3|m4a|mp4|aac|flac|wav|ogg|opus|webm|wma|aiff|aif)$/i;

export function isSupportedMusicUploadFile(file: File): boolean {
  const type = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type && (KNOWN_AUDIO_MIMES.has(type) || type.startsWith(AUDIO_MIME_PREFIX)))
    return true;
  return KNOWN_AUDIO_EXT.test(file.name);
}

/** @deprecated используйте isSupportedMusicUploadFile */
export function isMp3File(file: File): boolean {
  return isSupportedMusicUploadFile(file);
}

export function validateMusicUploadFile(file: File): string | null {
  if (!isSupportedMusicUploadFile(file)) {
    return "Нужен поддерживаемый аудиофайл (MP3, M4A, FLAC, WAV и др.).";
  }
  if (file.size > MUSIC_UPLOAD_MAX_BYTES) {
    return "Размер файла не должен превышать 70 МБ.";
  }
  return null;
}

export function validateMusicCoverFile(file: File): string | null {
  const type = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!type.startsWith("image/")) {
    return "Обложка должна быть изображением.";
  }
  if (file.size > MUSIC_COVER_MAX_BYTES) {
    return "Обложка слишком большая (макс. 5 МБ).";
  }
  return null;
}

export function formatFileSizeRu(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(".", ",")} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} МБ`;
}

export function formatAudioFileLabel(file: File): string {
  const ext = file.name.includes(".") ? file.name.split(".").pop()?.toUpperCase() : "";
  if (ext) return ext;
  const type = file.type.split(";")[0]?.trim() ?? "";
  if (type.startsWith("audio/")) return type.slice("audio/".length).toUpperCase();
  return "AUDIO";
}
