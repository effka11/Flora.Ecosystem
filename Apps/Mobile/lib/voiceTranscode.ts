import { FFmpegKit, ReturnCode } from "ffmpeg-kit-react-native";
import { File, Paths } from "expo-file-system";
import { NativeModules } from "react-native";
import { readExpoFileBytes } from "@/lib/expoFileBytes";
import { VOICE_HE_AAC_CONTENT_TYPE, VOICE_MAX_UPLOAD_BYTES } from "@/lib/voiceLimits";

const MIN_VALID_M4A_BYTES = 256;

const ENCODE_ATTEMPTS: { label: string; args: string }[] = [
  {
    label: "AAC-LC",
    args: "-c:a aac -profile:a aac_low -b:a 48k -ac 1 -ar 44100",
  },
];

let warmStarted = false;
let ffmpegNativeAvailable: boolean | null = null;

function stripFileUri(uri: string): string {
  return uri.replace(/^file:\/\//, "");
}

function quotePath(path: string): string {
  return `"${path.replace(/"/g, '\\"')}"`;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  const end = Math.min(bytes.length, offset + length);
  for (let i = offset; i < end; i++) out += String.fromCharCode(bytes[i]!);
  return out;
}

function isValidM4aContainer(bytes: Uint8Array): boolean {
  return bytes.length >= MIN_VALID_M4A_BYTES && readAscii(bytes, 4, 4) === "ftyp";
}

function contentTypeFromUri(uri: string): string {
  const lower = uri.toLowerCase();
  if (lower.includes(".caf")) return "audio/x-caf";
  if (lower.includes(".3gp")) return "audio/3gpp";
  if (lower.includes(".webm")) return "audio/webm";
  if (lower.includes(".ogg")) return "audio/ogg";
  return VOICE_HE_AAC_CONTENT_TYPE;
}

/** Нативный модуль ffmpeg-kit (нужен rebuild dev client после добавления пакета). */
export function isFfmpegNativeAvailable(): boolean {
  if (ffmpegNativeAvailable !== null) return ffmpegNativeAvailable;
  ffmpegNativeAvailable = Boolean(
    (NativeModules as { FFmpegKitReactNativeModule?: unknown }).FFmpegKitReactNativeModule,
  );
  return ffmpegNativeAvailable;
}

function isFfmpegRuntimeError(message: string): boolean {
  return /ffmpegSession/i.test(message) || /FFmpegKitReactNativeModule/i.test(message);
}

export function normalizeVoiceTranscodeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (isFfmpegRuntimeError(raw) || (!isFfmpegNativeAvailable() && raw.includes("null"))) {
    return "Сжатие голосового недоступно в этой сборке. Пересоберите dev client: npm run mobile:android";
  }
  if (raw.trim()) return raw.trim();
  return "Не удалось обработать запись.";
}

async function passthroughRecordedVoice(inputUri: string): Promise<TranscodedVoice> {
  const source = new File(inputUri);
  const size = source.size ?? 0;
  if (size <= 0) throw new Error("Запись пуста.");
  if (size > VOICE_MAX_UPLOAD_BYTES) {
    throw new Error(
      "Голосовое слишком большое без сжатия. Пересоберите приложение с FFmpeg (npm run mobile:android).",
    );
  }

  const head = await readExpoFileBytes(source);
  if (!isValidM4aContainer(head) && !inputUri.toLowerCase().includes(".webm")) {
    throw new Error("Запись повреждена или пуста.");
  }

  return { uri: inputUri, contentType: contentTypeFromUri(inputUri) };
}

/** Прогрев ffmpeg при tap mic — сокращает задержку send. */
export function warmVoiceTranscodeEngine(): void {
  if (warmStarted || !isFfmpegNativeAvailable()) return;
  warmStarted = true;
  void FFmpegKit.execute("-version").catch(() => undefined);
}

export type TranscodedVoice = {
  uri: string;
  contentType: string;
};

async function validateTranscodedOutput(outputFile: File): Promise<TranscodedVoice | null> {
  const size = outputFile.size ?? 0;
  if (size < MIN_VALID_M4A_BYTES) return null;
  const bytes = await readExpoFileBytes(outputFile);
  if (!isValidM4aContainer(bytes)) return null;
  return { uri: outputFile.uri, contentType: VOICE_HE_AAC_CONTENT_TYPE };
}

async function transcodeWithFfmpeg(inputUri: string): Promise<TranscodedVoice> {
  const stamp = Date.now();
  const outputFile = new File(Paths.cache, `voice-out-${stamp}.m4a`);
  if (outputFile.exists) outputFile.delete();
  outputFile.create();

  const inputPath = stripFileUri(inputUri);
  const outputPath = stripFileUri(outputFile.uri);
  let lastLog = "";

  for (const attempt of ENCODE_ATTEMPTS) {
    if (outputFile.exists) {
      outputFile.delete();
      outputFile.create();
    }
    const command = [
      "-y",
      "-i",
      quotePath(inputPath),
      "-vn",
      "-map_metadata",
      "-1",
      attempt.args,
      "-movflags",
      "+faststart",
      quotePath(outputPath),
    ].join(" ");

    const session = await FFmpegKit.execute(command);
    const returnCode = await session.getReturnCode();
    lastLog = (await session.getAllLogsAsString()) ?? "";
    if (ReturnCode.isSuccess(returnCode)) {
      const validated = await validateTranscodedOutput(outputFile);
      if (validated) return validated;
    }
  }

  throw new Error(lastLog.trim() || "Не удалось перекодировать голосовое сообщение.");
}

/**
 * Нативная запись expo-audio (AAC-LC .m4a) — основной путь.
 * FFmpeg только для сжатия слишком больших файлов; при сомнении — оригинал.
 */
export async function transcodeVoiceToHeAac(inputUri: string): Promise<TranscodedVoice> {
  const source = new File(inputUri);
  const size = source.size ?? 0;
  if (size <= 0) throw new Error("Запись пуста.");

  const head = await readExpoFileBytes(source);
  const nativeOk = isValidM4aContainer(head) && size <= VOICE_MAX_UPLOAD_BYTES;
  if (nativeOk) {
    return { uri: inputUri, contentType: contentTypeFromUri(inputUri) };
  }

  if (!isFfmpegNativeAvailable() || size <= VOICE_MAX_UPLOAD_BYTES) {
    return passthroughRecordedVoice(inputUri);
  }

  try {
    const transcoded = await transcodeWithFfmpeg(inputUri);
    const out = new File(transcoded.uri);
    if ((out.size ?? 0) > VOICE_MAX_UPLOAD_BYTES) {
      return passthroughRecordedVoice(inputUri);
    }
    return transcoded;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isFfmpegRuntimeError(message)) {
      return passthroughRecordedVoice(inputUri);
    }
    if (size <= VOICE_MAX_UPLOAD_BYTES) {
      return passthroughRecordedVoice(inputUri);
    }
    throw err;
  }
}
