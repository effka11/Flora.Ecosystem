const HE_AAC_MP4 = 'audio/mp4; codecs="mp4a.40.2"';

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  const end = Math.min(bytes.length, offset + length);
  for (let i = offset; i < end; i++) out += String.fromCharCode(bytes[i]!);
  return out;
}

/** Определяет MIME аудиоконтейнера по magic bytes (после AES-GCM decrypt). */
export function sniffVoicePlaybackMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 12 && readAscii(bytes, 4, 4) === "ftyp") return HE_AAC_MP4;
  if (bytes.length >= 4 && readAscii(bytes, 0, 4) === "OggS") return "audio/ogg";
  if (bytes.length >= 12 && readAscii(bytes, 0, 4) === "RIFF" && readAscii(bytes, 8, 4) === "WAVE") {
    return "audio/wav";
  }
  if (bytes.length >= 12 && readAscii(bytes, 0, 4) === "RIFF" && readAscii(bytes, 8, 4) === "WEBM") {
    return "audio/webm";
  }
  if (bytes.length >= 4 && readAscii(bytes, 0, 4) === "fLaC") return "audio/flac";
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return "audio/mpeg";
  return null;
}

function normalizeDeclaredMime(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

function sniffFamily(mime: string): string {
  const base = normalizeDeclaredMime(mime);
  if (base.includes("mp4") || base.includes("m4a")) return "mp4";
  if (base.includes("webm")) return "webm";
  if (base.includes("ogg")) return "ogg";
  if (base.includes("wav")) return "wav";
  if (base.includes("mpeg") || base.includes("mp3")) return "mpeg";
  return base;
}

/** Выбирает MIME для Blob: sniff при расхождении с FSCP contentType. */
export function resolveVoicePlaybackMime(bytes: Uint8Array, declaredContentType?: string): string {
  const sniffed = sniffVoicePlaybackMime(bytes);
  const declared = declaredContentType?.trim() ?? "";
  if (!sniffed) return declared || "audio/mp4";
  if (!declared) return sniffed;
  if (sniffFamily(declared) === sniffFamily(sniffed)) {
    return declared.includes("codecs=") ? declared : sniffed;
  }
  return sniffed;
}
