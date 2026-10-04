import { useCallback, useRef, useState } from "react";
import {
  createMeterStreamFromCapture,
  createVoiceAnalyserGraph,
  createVoiceMediaRecorder,
  pickVoiceMimeType,
  requestVoiceCaptureStream,
  resumeVoiceAudioContext,
  stopMediaStream,
  VOICE_MAX_DURATION_MS,
  type VoiceAnalyserGraph,
} from "./voiceCapture";
import {
  extractVoiceWaveformFromBlob,
  measurePeakFromAnalyser,
  VOICE_INLINE_WAVE_BAR_COUNT,
  VOICE_LIVE_METER_INTERVAL_MS,
  VOICE_WAVE_MIN_LEVEL,
} from "./voiceWaveform";

export type RecordedVoiceDraft = {
  blob: Blob;
  durationMs: number;
  contentType: string;
  waveform: number[];
};

function simpleWaveform(size: number, durationMs: number): number[] {
  const seed = Math.max(1, size + durationMs);
  return Array.from({ length: size }, (_, i) => {
    const v = Math.sin((seed % 97) * (i + 1)) * 0.5 + Math.cos((seed % 53) * (i + 2)) * 0.5;
    return Math.max(0.18, Math.min(1, Math.abs(v)));
  });
}

export function useVoiceRecorder(onRecorded: (voice: RecordedVoiceDraft) => void) {
  const [recording, setRecording] = useState(false);
  const [recordingMs, setRecordingMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [liveWaveform, setLiveWaveform] = useState<number[]>([]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const startedAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const liveLevelsRef = useRef<number[]>([]);
  const captureStreamRef = useRef<MediaStream | null>(null);
  const meterStreamRef = useRef<MediaStream | null>(null);
  const analyserGraphRef = useRef<VoiceAnalyserGraph | null>(null);
  const analyserFrameRef = useRef<number | null>(null);
  const meterWindowPeakRef = useRef(VOICE_WAVE_MIN_LEVEL);
  const meterLastPushAtRef = useRef(0);
  const cancelledRef = useRef(false);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const stopAnalyserLoop = () => {
    if (analyserFrameRef.current !== null) {
      window.cancelAnimationFrame(analyserFrameRef.current);
      analyserFrameRef.current = null;
    }
  };

  const releaseCapture = () => {
    stopAnalyserLoop();
    const graph = analyserGraphRef.current;
    analyserGraphRef.current = null;
    graph?.dispose();
    void graph?.audioContext.close().catch(() => undefined);
    stopMediaStream(meterStreamRef.current);
    meterStreamRef.current = null;
    stopMediaStream(captureStreamRef.current);
    captureStreamRef.current = null;
  };

  const start = useCallback(async () => {
    if (recording) return;
    setError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("Браузер не дал доступ к записи аудио.");
      return;
    }

    try {
      const captureStream = await requestVoiceCaptureStream();
      captureStreamRef.current = captureStream;

      const meterStream = createMeterStreamFromCapture(captureStream);
      meterStreamRef.current = meterStream;

      let analyserGraph: VoiceAnalyserGraph | null = null;
      let floatSamples: Float32Array | null = null;
      let byteSamples: Uint8Array | null = null;
      if (meterStream) {
        analyserGraph = createVoiceAnalyserGraph(meterStream);
        analyserGraphRef.current = analyserGraph;
        await resumeVoiceAudioContext(analyserGraph.audioContext);
        floatSamples = new Float32Array(analyserGraph.analyser.fftSize);
        byteSamples = new Uint8Array(analyserGraph.analyser.fftSize);
      }

      const mimeType = pickVoiceMimeType();
      const recorder = createVoiceMediaRecorder(captureStream, mimeType);

      chunksRef.current = [];
      liveLevelsRef.current = [];
      setLiveWaveform([]);
      cancelledRef.current = false;
      startedAtRef.current = performance.now();
      meterWindowPeakRef.current = VOICE_WAVE_MIN_LEVEL;
      meterLastPushAtRef.current = startedAtRef.current;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        clearTimer();
        if (meterWindowPeakRef.current > VOICE_WAVE_MIN_LEVEL) {
          liveLevelsRef.current = [...liveLevelsRef.current, meterWindowPeakRef.current];
        }
        const durationMs = Math.max(1, Math.round(performance.now() - startedAtRef.current));
        const contentType = recorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: contentType });
        releaseCapture();
        setRecording(false);
        setRecordingMs(0);
        if (!cancelledRef.current && blob.size > 0) {
          const waveform = await extractVoiceWaveformFromBlob(blob, VOICE_INLINE_WAVE_BAR_COUNT);
          onRecorded({
            blob,
            durationMs,
            contentType,
            waveform:
              waveform.length > 0 ? waveform : simpleWaveform(VOICE_INLINE_WAVE_BAR_COUNT, durationMs),
          });
        }
        chunksRef.current = [];
        liveLevelsRef.current = [];
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);

      if (analyserGraph && floatSamples && byteSamples) {
        const pushMeterWindow = () => {
          const next = [...liveLevelsRef.current, meterWindowPeakRef.current];
          liveLevelsRef.current = next;
          setLiveWaveform(next);
          meterWindowPeakRef.current = VOICE_WAVE_MIN_LEVEL;
          meterLastPushAtRef.current = performance.now();
        };

        const tick = () => {
          const framePeak = measurePeakFromAnalyser(analyserGraph.analyser, floatSamples, byteSamples);
          meterWindowPeakRef.current = Math.max(meterWindowPeakRef.current, framePeak);
          const elapsedMs = performance.now() - startedAtRef.current;
          if (performance.now() - meterLastPushAtRef.current >= VOICE_LIVE_METER_INTERVAL_MS) {
            pushMeterWindow();
          }
          if (elapsedMs >= VOICE_MAX_DURATION_MS && recorderRef.current?.state === "recording") {
            pushMeterWindow();
          }
          analyserFrameRef.current = window.requestAnimationFrame(tick);
        };
        tick();
      }

      timerRef.current = window.setInterval(() => {
        const elapsedMs = Math.max(0, Math.round(performance.now() - startedAtRef.current));
        setRecordingMs(elapsedMs);
        if (elapsedMs >= VOICE_MAX_DURATION_MS && recorderRef.current?.state === "recording") {
          setError("Достигнут лимит 30 минут — запись остановлена.");
          recorderRef.current.stop();
        }
      }, 200);
    } catch {
      releaseCapture();
      setError("Не удалось начать запись. Проверьте доступ к микрофону.");
      setRecording(false);
      setRecordingMs(0);
    }
  }, [onRecorded, recording]);

  const stop = useCallback(() => {
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
    }
  }, []);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    cancelledRef.current = true;
    chunksRef.current = [];
    if (recorder?.state === "recording") {
      recorder.stop();
    } else {
      releaseCapture();
    }
    clearTimer();
    setRecording(false);
    setRecordingMs(0);
    setLiveWaveform([]);
    liveLevelsRef.current = [];
  }, []);

  return { recording, recordingMs, error, liveWaveform, start, stop, cancel };
}
