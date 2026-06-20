export const VOICE_INLINE_WAVE_BAR_COUNT = 84;
export const VOICE_BUBBLE_WAVE_BAR_COUNT = 48;
/** Полосок live-UI при записи — как в пузыре, без bucket (легче 84 View). */
export const VOICE_LIVE_WAVE_BAR_COUNT = VOICE_BUBBLE_WAVE_BAR_COUNT;
export const VOICE_WAVE_MIN_LEVEL = 0.12;
export const VOICE_LIVE_METER_INTERVAL_MS = 60;
/** Как часто обновлять только виджет волны (не весь экран чата). */
export const VOICE_LIVE_WAVE_UI_INTERVAL_MS = 120;
/** Усиление live-метра — как на Web, чтобы амплитуда совпадала с пузырём после extract. */
export const VOICE_LIVE_METER_GAIN = 2.4;

const VOICE_EXTRACT_DISPLAY_PEAK_TARGET = 0.78;

export function waveLevelFromPeakAbs(peakAbs: number): number {
  return Math.max(VOICE_WAVE_MIN_LEVEL, Math.min(1, peakAbs));
}

export function waveLevelFromMeter(metering: number | undefined): number {
  if (metering === undefined || Number.isNaN(metering)) return VOICE_WAVE_MIN_LEVEL;
  const normalized = Math.pow(10, metering / 20);
  return waveLevelFromPeakAbs(normalized * VOICE_LIVE_METER_GAIN);
}

/** Высота полоски в пузыре и при записи — одна формула. */
export function voiceWaveBarHeight(level: number): number {
  return Math.round(6 + level * 22);
}

/** Подтягивает live-волну к амплитуде extract (только отображение). */
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

export function buildScrollingInlineWaveform(
  source: number[],
  total: number,
  matchExtractSensitivity = false,
): number[] {
  if (source.length === 0) {
    return Array.from({ length: total }, () => VOICE_WAVE_MIN_LEVEL);
  }
  const visible = source.slice(-total);
  const padded = [
    ...Array.from({ length: total - visible.length }, () => VOICE_WAVE_MIN_LEVEL),
    ...visible,
  ];
  return matchExtractSensitivity ? boostLiveWaveformForDisplay(padded) : padded;
}

export function buildInlineComposeWaveform(source: number[], recording: boolean): number[] {
  const total = VOICE_INLINE_WAVE_BAR_COUNT;
  if (source.length === 0) {
    return Array.from({ length: total }, () => VOICE_WAVE_MIN_LEVEL);
  }
  if (recording) {
    return buildScrollingInlineWaveform(source, total, true);
  }
  if (source.length === total) return [...source];
  return bucketVoiceWaveformByMax(source, total);
}

/** Скроллинг live-волны для UI записи (48 полосок, без re-bucket). */
export function buildLiveDisplayWaveform(source: number[]): number[] {
  return buildScrollingInlineWaveform(source, VOICE_LIVE_WAVE_BAR_COUNT, true);
}

export function simpleWaveform(size: number, durationMs: number): number[] {
  const seed = Math.max(1, size + durationMs);
  return Array.from({ length: size }, (_, i) => {
    const v = Math.sin((seed % 97) * (i + 1)) * 0.5 + Math.cos((seed % 53) * (i + 2)) * 0.5;
    return Math.max(0.18, Math.min(1, Math.abs(v)));
  });
}

export function formatVoiceDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
