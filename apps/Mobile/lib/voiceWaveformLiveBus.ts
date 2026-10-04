import { buildLiveDisplayWaveform } from "@/lib/voiceWaveform";

type Listener = () => void;

let snapshot = buildLiveDisplayWaveform([]);
const listeners = new Set<Listener>();

export function publishLiveWaveformDisplay(source: number[]): void {
  snapshot = buildLiveDisplayWaveform(source);
  listeners.forEach((listener) => listener());
}

export function resetLiveWaveformDisplay(): void {
  snapshot = buildLiveDisplayWaveform([]);
  listeners.forEach((listener) => listener());
}

export function getLiveWaveformDisplay(): number[] {
  return snapshot;
}

export function subscribeLiveWaveformDisplay(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
