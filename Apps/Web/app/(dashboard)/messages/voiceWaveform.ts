/** Полосок в инлайн-волне записи (колонки 45–81). */
export const VOICE_INLINE_WAVE_BAR_COUNT = 84;

/** Полосок в волне голосового пузыря (ширина ~375px, play слева). */
export const VOICE_BUBBLE_WAVE_BAR_COUNT = 48;

export const VOICE_WAVE_MIN_LEVEL = 0.12;

/** Интервал live-метра (мс): близко к ширине сегмента при 84 полосках на ~5 с речи. */
export const VOICE_LIVE_METER_INTERVAL_MS = 60;

/** Analyser тише декодированного PCM — усиление только для live-метра. */
export const VOICE_LIVE_METER_GAIN = 2.4;

/** Типичный пик полосок после extractVoiceWaveformFromBlob (для выравнивания live-UI). */
const VOICE_EXTRACT_DISPLAY_PEAK_TARGET = 0.78;

/** Одна шкала для live-метра и waveform из файла. */
export function waveLevelFromPeakAbs(peakAbs: number): number {
  return Math.max(VOICE_WAVE_MIN_LEVEL, Math.min(1, peakAbs));
}

export function measurePeakFromFloatTimeDomain(samples: Float32Array): number {
  let peak = 0;
  for (let index = 0; index < samples.length; index++) {
    peak = Math.max(peak, Math.abs(samples[index]!));
  }
  return waveLevelFromPeakAbs(peak);
}

export function measurePeakFromTimeDomainBytes(samples: Uint8Array): number {
  let peak = 0;
  for (let index = 0; index < samples.length; index++) {
    peak = Math.max(peak, Math.abs((samples[index]! - 128) / 128));
  }
  return waveLevelFromPeakAbs(peak);
}

export function measurePeakFromAnalyser(
  analyser: AnalyserNode,
  floatScratch: Float32Array,
  byteScratch: Uint8Array,
): number {
  analyser.getFloatTimeDomainData(floatScratch as Float32Array<ArrayBuffer>);
  let peak = 0;
  for (let index = 0; index < floatScratch.length; index++) {
    peak = Math.max(peak, Math.abs(floatScratch[index]!));
  }
  if (peak <= 0.0001) {
    analyser.getByteTimeDomainData(byteScratch as Uint8Array<ArrayBuffer>);
    for (let index = 0; index < byteScratch.length; index++) {
      peak = Math.max(peak, Math.abs((byteScratch[index]! - 128) / 128));
    }
  }
  return waveLevelFromPeakAbs(peak * VOICE_LIVE_METER_GAIN);
}

/** Подтягивает видимую live-волну к амплитуде extract (только отображение). */
export function boostLiveWaveformForDisplay(levels: number[]): number[] {
  if (levels.length === 0) return levels;

  const max = Math.max(...levels);
  if (max <= VOICE_WAVE_MIN_LEVEL + 0.02) {
    return levels;
  }

  const headroom = VOICE_EXTRACT_DISPLAY_PEAK_TARGET - VOICE_WAVE_MIN_LEVEL;
  const sourceHeadroom = max - VOICE_WAVE_MIN_LEVEL;
  const scale = headroom / sourceHeadroom;

  return levels.map((level) => {
    if (level <= VOICE_WAVE_MIN_LEVEL + 0.01) {
      return VOICE_WAVE_MIN_LEVEL;
    }
    const lifted = VOICE_WAVE_MIN_LEVEL + (level - VOICE_WAVE_MIN_LEVEL) * scale;
    return waveLevelFromPeakAbs(lifted);
  });
}

/**
 * Дорожку режем на `size` сегментов; высота деления = пик громкости в сегменте (max, не avg).
 */
export function bucketVoiceWaveformByMax(values: number[], size: number): number[] {
  if (size <= 0) return [];
  if (values.length === 0) {
    return Array.from({ length: size }, () => VOICE_WAVE_MIN_LEVEL);
  }

  return Array.from({ length: size }, (_, index) => {
    const start = Math.floor((index * values.length) / size);
    const end = Math.max(start + 1, Math.floor(((index + 1) * values.length) / size));
    let peak = VOICE_WAVE_MIN_LEVEL;
    for (let i = start; i < end; i++) {
      peak = Math.max(peak, values[i]!);
    }
    return peak;
  });
}

/** Живая запись: последние `total` окон метра, новые справа (бегущая дорожка). */
export function buildScrollingInlineWaveform(
  source: number[],
  total: number,
  matchExtractSensitivity = false,
): number[] {
  if (source.length === 0) {
    return Array.from({ length: total }, () => VOICE_WAVE_MIN_LEVEL);
  }
  const visible = source.slice(-total);
  const padded = [...Array.from({ length: total - visible.length }, () => VOICE_WAVE_MIN_LEVEL), ...visible];
  return matchExtractSensitivity ? boostLiveWaveformForDisplay(padded) : padded;
}

/** Инлайн-волна: при записи — бегущая дорожка; после — 84 точки из файла или переразбивка. */
export function buildInlineComposeWaveform(source: number[], recording: boolean): number[] {
  const total = VOICE_INLINE_WAVE_BAR_COUNT;
  if (source.length === 0) {
    return Array.from({ length: total }, () => VOICE_WAVE_MIN_LEVEL);
  }
  if (recording) {
    return buildScrollingInlineWaveform(source, total, true);
  }
  if (source.length === total) {
    return [...source];
  }
  return bucketVoiceWaveformByMax(source, total);
}

function makeAudioContext(): AudioContext {
  const AudioContextCtor = window.AudioContext;
  return new AudioContextCtor();
}

/** Пики из декодированного файла — тот же max по сегментам, что у live после stop. */
export async function extractVoiceWaveformFromBlob(blob: Blob, size: number): Promise<number[]> {
  if (typeof window === "undefined" || typeof window.AudioContext === "undefined") {
    return [];
  }

  const audioContext = makeAudioContext();
  try {
    const audioBuffer = await audioContext.decodeAudioData(await blob.arrayBuffer());
    const channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, index) => audioBuffer.getChannelData(index));
    if (channels.length === 0 || audioBuffer.length === 0) return [];

    return Array.from({ length: size }, (_, index) => {
      const start = Math.floor((index * audioBuffer.length) / size);
      const end = Math.max(start + 1, Math.floor(((index + 1) * audioBuffer.length) / size));
      let peak = 0;
      for (let sampleIndex = start; sampleIndex < end; sampleIndex++) {
        for (const channel of channels) {
          peak = Math.max(peak, Math.abs(channel[sampleIndex] ?? 0));
        }
      }
      return waveLevelFromPeakAbs(peak);
    });
  } catch {
    return [];
  } finally {
    void audioContext.close().catch(() => undefined);
  }
}
