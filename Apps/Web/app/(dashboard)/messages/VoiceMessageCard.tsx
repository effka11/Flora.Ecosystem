"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FscpVoiceBlock } from "@/lib/fscp";
import {
  ensureMessageVoiceObjectUrl,
  peekMessageMediaObjectUrl,
  preloadMessageVoice,
} from "@/lib/messageMediaCache";
import styles from "./messages.module.css";
import { FlowPlayIcon } from "@/app/(dashboard)/music/FlowPlayIcon";
import { bucketVoiceWaveformByMax, VOICE_BUBBLE_WAVE_BAR_COUNT } from "./voiceWaveform";

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function waitForCanPlay(audio: HTMLAudioElement): Promise<void> {
  if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onFail = () => {
      cleanup();
      reject(new Error("decode"));
    };
    const cleanup = () => {
      audio.removeEventListener("canplay", onReady);
      audio.removeEventListener("error", onFail);
    };
    audio.addEventListener("canplay", onReady, { once: true });
    audio.addEventListener("error", onFail, { once: true });
  });
}

export function VoiceMessageCard({
  durationMs,
  waveform,
  localUrl,
  localBlob,
  voiceBlock,
  variant = "thread",
  onRemove,
}: {
  durationMs: number;
  waveform: number[];
  localUrl?: string;
  localBlob?: Blob;
  voiceBlock?: FscpVoiceBlock;
  variant?: "thread" | "composeForm";
  onRemove?: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [sourceUrl, setSourceUrl] = useState(
    () => localUrl ?? (voiceBlock ? peekMessageMediaObjectUrl(voiceBlock.assetUuid) ?? "" : ""),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (localUrl) {
      setSourceUrl(localUrl);
      return;
    }
    if (!localBlob) return;
    const url = URL.createObjectURL(localBlob);
    setSourceUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [localUrl, localBlob]);

  useEffect(() => {
    if (!voiceBlock || localUrl || localBlob) return;
    const cached = peekMessageMediaObjectUrl(voiceBlock.assetUuid);
    if (cached) setSourceUrl(cached);
  }, [voiceBlock, localUrl, localBlob]);

  useEffect(() => {
    if (variant !== "thread" || !voiceBlock || localUrl || localBlob) return;
    preloadMessageVoice(voiceBlock);
  }, [variant, voiceBlock, localUrl, localBlob]);

  const ensureSource = async () => {
    if (sourceUrl || localBlob || localUrl || !voiceBlock) return sourceUrl;
    setLoading(true);
    setError(null);
    try {
      const url = await ensureMessageVoiceObjectUrl(voiceBlock);
      setSourceUrl(url);
      return url;
    } catch {
      setError("Не удалось загрузить голосовое");
      return "";
    } finally {
      setLoading(false);
    }
  };

  const toggle = async () => {
    const url = sourceUrl || (await ensureSource()) || "";
    if (!url) return;
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
      return;
    }
    setError(null);
    if (audio.src !== url) {
      audio.src = url;
      audio.load();
    }
    try {
      await waitForCanPlay(audio);
      await audio.play();
    } catch {
      setError("Не удалось воспроизвести голосовое");
      setPlaying(false);
    }
  };

  const bars = useMemo(() => {
    if (waveform.length === 0) {
      return Array.from({ length: VOICE_BUBBLE_WAVE_BAR_COUNT }, () => 0.35);
    }
    return bucketVoiceWaveformByMax(waveform, VOICE_BUBBLE_WAVE_BAR_COUNT);
  }, [waveform]);

  const composeForm = variant === "composeForm";

  return (
    <div className={`${styles.voiceCard} ${composeForm ? styles.voiceCardComposeForm : ""}`}>
      <button
        type="button"
        className={styles.voicePlayButton}
        onClick={() => void toggle()}
        disabled={loading}
        aria-label={playing ? "Пауза" : "Воспроизвести голосовое"}
      >
        <FlowPlayIcon className={styles.voicePlayIcon} playing={playing} />
      </button>
      <div className={styles.voiceCardBody}>
        <div className={styles.voiceWaveform} aria-hidden>
          {bars.map((v, i) => (
            <span key={i} style={{ height: `${Math.round(6 + v * 22)}px` }} />
          ))}
        </div>
        <span className={styles.voiceDuration}>{error ?? (loading ? "Загрузка…" : formatDuration(durationMs))}</span>
      </div>
      {composeForm && onRemove ? (
        <button type="button" className={styles.voiceCardDelete} onClick={onRemove} aria-label="Удалить голосовое">
          ×
        </button>
      ) : null}
      <audio
        ref={audioRef}
        src={sourceUrl || undefined}
        preload="auto"
        playsInline
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => setError("Формат не поддерживается")}
      />
    </div>
  );
}
