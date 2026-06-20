import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

export const VOICE_HE_AAC_CONTENT_TYPE = "audio/mp4";

let ffmpegInstance: FFmpeg | null = null;
let ffmpegLoadPromise: Promise<FFmpeg> | null = null;

const FFMPEG_LOAD_TIMEOUT_MS = 20_000;

const ENCODE_ATTEMPTS: { label: string; args: string[] }[] = [
  {
    label: "AAC-LC",
    args: ["-c:a", "aac", "-profile:a", "aac_low", "-b:a", "48k", "-ac", "1", "-ar", "44100"],
  },
];

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Загрузка ffmpeg.wasm без транскода — для фонового прогрева при записи голоса. */
export function warmVoiceTranscodeEngine(): void {
  void loadVoiceFfmpeg().catch(() => undefined);
}

async function loadVoiceFfmpeg(): Promise<FFmpeg> {
  if (ffmpegInstance?.loaded) return ffmpegInstance;

  if (!ffmpegLoadPromise) {
    ffmpegLoadPromise = (async () => {
      const ffmpeg = new FFmpeg();
      const base = `${window.location.origin}/ffmpeg`;

      try {
        await withTimeout(
          ffmpeg.load({
            coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
            wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
            classWorkerURL: await toBlobURL(`${base}/worker.js`, "text/javascript"),
          }),
          FFMPEG_LOAD_TIMEOUT_MS,
          "ffmpeg.wasm load timeout",
        );
      } catch (error) {
        ffmpegLoadPromise = null;
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Не удалось загрузить ffmpeg.wasm: ${detail}`);
      }

      ffmpegInstance = ffmpeg;
      return ffmpeg;
    })();
  }

  return ffmpegLoadPromise;
}

function inputExtensionFromBlob(blob: Blob): string {
  const type = blob.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type.includes("ogg")) return ".ogg";
  if (type.includes("mp4") || type.includes("m4a")) return ".m4a";
  if (type.includes("mpeg") || type.includes("mp3")) return ".mp3";
  return ".webm";
}

async function tryEncode(
  ffmpeg: FFmpeg,
  inputName: string,
  outputName: string,
  encodeArgs: string[],
): Promise<{ exitCode: number; log: string }> {
  const logs: string[] = [];
  const onLog = ({ message }: { message: string }) => {
    logs.push(message);
  };
  ffmpeg.on("log", onLog);
  try {
    const exitCode = await ffmpeg.exec([
      "-i",
      inputName,
      "-vn",
      "-map_metadata",
      "-1",
      ...encodeArgs,
      "-movflags",
      "+faststart",
      outputName,
    ]);
    return { exitCode, log: logs.slice(-8).join("\n") };
  } finally {
    ffmpeg.off("log", onLog);
  }
}

/** WebM/Opus (MediaRecorder) → HE-AAC v1 48k mono M4A перед E2E-шифрованием. */
export async function transcodeVoiceToHeAac(input: Blob): Promise<Blob> {
  const ffmpeg = await loadVoiceFfmpeg();
  const stamp = Date.now();
  const inputName = `voice-in-${stamp}${inputExtensionFromBlob(input)}`;
  const outputName = `voice-out-${stamp}.m4a`;

  await ffmpeg.writeFile(inputName, await fetchFile(input));

  let lastLog = "";

  try {
    let encoded = false;
    for (const attempt of ENCODE_ATTEMPTS) {
      await ffmpeg.deleteFile(outputName).catch(() => undefined);
      const { exitCode, log } = await tryEncode(ffmpeg, inputName, outputName, attempt.args);
      lastLog = log;
      if (exitCode === 0) {
        encoded = true;
        break;
      }
    }

    if (!encoded) {
      throw new Error(lastLog || "ffmpeg encode failed");
    }

    const data = await ffmpeg.readFile(outputName);
    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new Blob([copy], { type: VOICE_HE_AAC_CONTENT_TYPE });
  } finally {
    await ffmpeg.deleteFile(inputName).catch(() => undefined);
    await ffmpeg.deleteFile(outputName).catch(() => undefined);
  }
}
