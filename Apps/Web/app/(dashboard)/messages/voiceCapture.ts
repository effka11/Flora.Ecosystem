/** Захват голосовых: MediaRecorder пишет исходный поток микрофона без Web Audio в цепи записи. */

/** Макс. длительность голосового (30 мин). */
export const VOICE_MAX_DURATION_MS = 30 * 60 * 1000;

/** MediaRecorder: исходный захват (до wasm HE-AAC 48k на отправке). */
export const VOICE_RECORD_BITS_PER_SECOND = 128_000;

/** HE-AAC v1 48 kbps mono — целевой профиль после клиентского транскода. */
export const VOICE_HE_AAC_BITS_PER_SECOND = 48_000;

/** Верхняя граница upload: 30 мин @ 48 kbps HE-AAC + 25% на контейнер (см. API MaxVoiceAssetBytes). */
export const VOICE_MAX_UPLOAD_BYTES = Math.ceil(
  (VOICE_MAX_DURATION_MS / 1000) * (VOICE_HE_AAC_BITS_PER_SECOND / 8) * 1.25,
);

const VOICE_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
] as const;

/** Без browser voice processing: echo/NS/AGC часто дают «бульканье» и обрывы на Windows. */
export const VOICE_CAPTURE_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: { ideal: 1 },
  echoCancellation: { ideal: false },
  noiseSuppression: { ideal: false },
  autoGainControl: { ideal: false },
};

export function pickVoiceMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  return VOICE_MIME_CANDIDATES.find((mime) => MediaRecorder.isTypeSupported(mime)) ?? "";
}

export function requestVoiceCaptureStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio: VOICE_CAPTURE_CONSTRAINTS });
}

/** Ставим высокий, но умеренный битрейт; если браузер не принимает опцию — откатываемся. */
export function createVoiceMediaRecorder(stream: MediaStream, mimeType: string): MediaRecorder {
  if (mimeType) {
    try {
      return new MediaRecorder(stream, { mimeType, audioBitsPerSecond: VOICE_RECORD_BITS_PER_SECOND });
    } catch {
      /* fallback */
    }
  }
  try {
    return new MediaRecorder(stream, { audioBitsPerSecond: VOICE_RECORD_BITS_PER_SECOND });
  } catch {
    return new MediaRecorder(stream);
  }
}

export function stopMediaStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}

/** Клон трека для метра — запись на исходном потоке не затрагивается. */
export function createMeterStreamFromCapture(captureStream: MediaStream): MediaStream | null {
  const track = captureStream.getAudioTracks()[0];
  if (!track) return null;
  return new MediaStream([track.clone()]);
}

export type VoiceAnalyserGraph = {
  audioContext: AudioContext;
  analyser: AnalyserNode;
  dispose: () => void;
};

export function createVoiceAnalyserGraph(meterStream: MediaStream): VoiceAnalyserGraph {
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(meterStream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 8192;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);

  return {
    audioContext,
    analyser,
    dispose: () => {
      source.disconnect();
      analyser.disconnect();
    },
  };
}

export async function resumeVoiceAudioContext(ctx: AudioContext): Promise<void> {
  if (ctx.state === "suspended") {
    await ctx.resume();
  }
}
