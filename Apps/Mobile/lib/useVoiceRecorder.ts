import {
  AudioModule,
  RecordingPresets,
  useAudioRecorder,
} from "expo-audio";

import { useCallback, useEffect, useRef, useState } from "react";

import { AppState, type AppStateStatus } from "react-native";

import {

  buildInlineComposeWaveform,

  simpleWaveform,

  VOICE_INLINE_WAVE_BAR_COUNT,

  VOICE_LIVE_METER_INTERVAL_MS,

  VOICE_LIVE_WAVE_UI_INTERVAL_MS,

  VOICE_WAVE_MIN_LEVEL,

  waveLevelFromMeter,

} from "@/lib/voiceWaveform";

import {

  publishLiveWaveformDisplay,

  resetLiveWaveformDisplay,

} from "@/lib/voiceWaveformLiveBus";

import { warmVoiceTranscodeEngine } from "@/lib/voiceTranscode";
import {
  ensureVoicePlaybackAudioMode,
  ensureVoiceRecordingAudioMode,
} from "@/lib/voicePlaybackAudio";

import { VOICE_MAX_DURATION_MS } from "@/lib/voiceLimits";



export type RecordedVoiceDraft = {

  uri: string;

  durationMs: number;

  contentType: string;

  waveform: number[];

};



type UseVoiceRecorderOptions = {

  onRecorded: (draft: RecordedVoiceDraft) => void;

};



function isRecorderActive(recorder: ReturnType<typeof useAudioRecorder>): boolean {

  try {

    return recorder.getStatus().isRecording;

  } catch {

    return false;

  }

}



export function useVoiceRecorder({ onRecorded }: UseVoiceRecorderOptions) {

  const recorder = useAudioRecorder({

    ...RecordingPresets.HIGH_QUALITY,

    isMeteringEnabled: true,

    extension: ".m4a",

  });

  const [recording, setRecording] = useState(false);

  const [starting, setStarting] = useState(false);

  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);

  const [error, setError] = useState<string | null>(null);

  const liveLevelsRef = useRef<number[]>([]);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const meterIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const meterWindowPeakRef = useRef(VOICE_WAVE_MIN_LEVEL);

  const meterLastPushAtRef = useRef(0);

  const startedAtRef = useRef(0);

  const cancelledRef = useRef(false);

  const recordingRef = useRef(false);

  const startingRef = useRef(false);

  const stoppingRef = useRef(false);

  const stopRequestedRef = useRef(false);

  const stopRef = useRef<(() => Promise<void>) | null>(null);



  const clearTimer = useCallback(() => {

    if (timerRef.current) {

      clearInterval(timerRef.current);

      timerRef.current = null;

    }

  }, []);



  const clearMeterInterval = useCallback(() => {

    if (meterIntervalRef.current) {

      clearInterval(meterIntervalRef.current);

      meterIntervalRef.current = null;

    }

  }, []);



  const pushMeterWindow = useCallback(() => {

    const next = [...liveLevelsRef.current, meterWindowPeakRef.current];

    liveLevelsRef.current =

      next.length > VOICE_INLINE_WAVE_BAR_COUNT * 4

        ? next.slice(-VOICE_INLINE_WAVE_BAR_COUNT * 4)

        : next;

    meterWindowPeakRef.current = VOICE_WAVE_MIN_LEVEL;

    publishLiveWaveformDisplay(liveLevelsRef.current);

  }, []);



  const startMeterLoop = useCallback(() => {

    clearMeterInterval();

    meterWindowPeakRef.current = VOICE_WAVE_MIN_LEVEL;

    meterLastPushAtRef.current = Date.now();

    resetLiveWaveformDisplay();

    meterIntervalRef.current = setInterval(() => {

      if (!recordingRef.current) return;

      const status = recorder.getStatus();

      const framePeak = waveLevelFromMeter(status.metering);

      meterWindowPeakRef.current = Math.max(meterWindowPeakRef.current, framePeak);

      const now = Date.now();

      if (now - meterLastPushAtRef.current >= VOICE_LIVE_WAVE_UI_INTERVAL_MS) {

        meterLastPushAtRef.current = now;

        pushMeterWindow();

      }

      if (now - startedAtRef.current >= VOICE_MAX_DURATION_MS) {

        void stopRef.current?.();

      }

    }, VOICE_LIVE_METER_INTERVAL_MS);

  }, [clearMeterInterval, pushMeterWindow, recorder]);



  useEffect(() => {

    if (!recording) return;

    const onAppState = (state: AppStateStatus) => {

      if (state !== "active") {

        cancelledRef.current = true;

        void stopRef.current?.();

      }

    };

    const sub = AppState.addEventListener("change", onAppState);

    return () => sub.remove();

  }, [recording]);



  const ensureAudioMode = useCallback(async () => {
    const status = await AudioModule.requestRecordingPermissionsAsync();
    if (!status.granted) {
      throw new Error("Нет доступа к микрофону.");
    }
    await ensureVoiceRecordingAudioMode();
  }, []);



  const start = useCallback(async () => {

    if (recordingRef.current || startingRef.current) return;

    setError(null);

    cancelledRef.current = false;

    stopRequestedRef.current = false;

    warmVoiceTranscodeEngine();

    startingRef.current = true;

    setStarting(true);

    try {

      await ensureAudioMode();

      liveLevelsRef.current = [];

      resetLiveWaveformDisplay();

      await recorder.prepareToRecordAsync({

        ...RecordingPresets.HIGH_QUALITY,

        isMeteringEnabled: true,

        extension: ".m4a",

      });

      if (stopRequestedRef.current || cancelledRef.current) {

        try {

          if (isRecorderActive(recorder)) await recorder.stop();

        } catch {

          // ignore

        }

        return;

      }

      recorder.record();

      recordingRef.current = true;

      startedAtRef.current = Date.now();

      setRecordingStartedAt(startedAtRef.current);

      setRecording(true);

      clearTimer();

      startMeterLoop();

    } catch (err) {

      const message = err instanceof Error ? err.message : "Не удалось начать запись.";

      setError(message);

      recordingRef.current = false;

      setRecording(false);

      setRecordingStartedAt(null);

      clearMeterInterval();

    } finally {

      startingRef.current = false;

      setStarting(false);

    }

  }, [clearMeterInterval, clearTimer, ensureAudioMode, recorder, startMeterLoop]);



  const stop = useCallback(async () => {

    if (startingRef.current) {

      stopRequestedRef.current = true;

      cancelledRef.current = true;

      return;

    }

    if (stoppingRef.current) return;

    if (!recordingRef.current && !isRecorderActive(recorder)) return;



    stoppingRef.current = true;

    recordingRef.current = false;

    clearTimer();

    clearMeterInterval();

    setRecording(false);

    setRecordingStartedAt(null);

    try {

      pushMeterWindow();

      if (isRecorderActive(recorder)) {

        await recorder.stop();

      }

      if (cancelledRef.current) return;

      const uri = recorder.uri;

      if (!uri) throw new Error("Запись пуста.");

      const durationMs = Math.max(1, Date.now() - startedAtRef.current);

      const waveform =

        liveLevelsRef.current.length > 0

          ? buildInlineComposeWaveform(liveLevelsRef.current, false)

          : simpleWaveform(VOICE_INLINE_WAVE_BAR_COUNT, durationMs);

      onRecorded({

        uri,

        durationMs,

        contentType: "audio/mp4",

        waveform,

      });

    } catch (err) {

      const message = err instanceof Error ? err.message : "Не удалось сохранить запись.";

      setError(message);

    } finally {

      stoppingRef.current = false;
      void ensureVoicePlaybackAudioMode();

    }

  }, [clearMeterInterval, clearTimer, onRecorded, pushMeterWindow, recorder]);



  stopRef.current = stop;



  const discard = useCallback(async () => {

    cancelledRef.current = true;

    stopRequestedRef.current = true;

    recordingRef.current = false;

    startingRef.current = false;

    setStarting(false);

    clearTimer();

    clearMeterInterval();

    setRecording(false);

    setRecordingStartedAt(null);

    liveLevelsRef.current = [];

    resetLiveWaveformDisplay();

    try {

      if (isRecorderActive(recorder)) await recorder.stop();

    } catch {

      // ignore

    }

    void ensureVoicePlaybackAudioMode();

  }, [clearMeterInterval, clearTimer, recorder]);



  const showStopControl = recording || starting;



  return {

    recording,

    starting,

    showStopControl,

    recordingStartedAt,

    error,

    start,

    stop,

    discard,

    setError,

  };

}


