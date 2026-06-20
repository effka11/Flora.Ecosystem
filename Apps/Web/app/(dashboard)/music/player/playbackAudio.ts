import { ApiRequestError } from "@/lib/auth";

function inferAudioMimeType(blob: Blob): string {
  if (blob.type) {
    return blob.type;
  }
  return "audio/mp4";
}

export async function normalizeAudioBlob(blob: Blob): Promise<Blob> {
  if (blob.size === 0) {
    throw new Error("EMPTY_AUDIO_BLOB");
  }

  const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  let mime = blob.type;
  if (!mime) {
    const isId3 = header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33;
    const isMp3Frame = header[0] === 0xff && (header[1] & 0xe0) === 0xe0;
    const isMp4 =
      header.length >= 8 &&
      header[4] === 0x66 &&
      header[5] === 0x74 &&
      header[6] === 0x79 &&
      header[7] === 0x70;
    mime = isId3 || isMp3Frame ? "audio/mpeg" : isMp4 ? "audio/mp4" : inferAudioMimeType(blob);
  }

  if (blob.type === mime) {
    return blob;
  }
  return blob.slice(0, blob.size, mime);
}

export async function waitForAudioElementReady(audio: HTMLAudioElement): Promise<void> {
  if (audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      detach();
      resolve();
    };
    const onError = () => {
      detach();
      reject(new Error("AUDIO_DECODE_ERROR"));
    };
    const detach = () => {
      audio.removeEventListener("canplay", onReady);
      audio.removeEventListener("error", onError);
    };
    audio.addEventListener("canplay", onReady, { once: true });
    audio.addEventListener("error", onError, { once: true });
    audio.load();
  });
}

export function formatPlaybackError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    return error.message;
  }
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") {
      return "Браузер заблокировал автозапуск. Нажмите play ещё раз.";
    }
    if (error.name === "NotSupportedError") {
      return "Формат аудио не поддерживается в этом браузере.";
    }
  }
  if (error instanceof Error) {
    if (error.message === "EMPTY_AUDIO_BLOB") {
      return "Сервер вернул пустой аудиофайл.";
    }
    if (error.message === "AUDIO_DECODE_ERROR") {
      return "Не удалось декодировать аудио.";
    }
  }
  return "Не удалось запустить трек.";
}
