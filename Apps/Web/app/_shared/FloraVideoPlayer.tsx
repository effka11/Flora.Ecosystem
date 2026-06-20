"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FlowPlayIcon } from "@/app/(dashboard)/music/FlowPlayIcon";
import { triggerVideoBlobDownload } from "@/lib/messageVideos";
import styles from "./FloraVideoPlayer.module.css";

type FloraVideoPlayerProps = {
  src: string;
  poster?: string;
  /** Компактный inline в пузыре чата: автозапуск, loop, по клику — просмотрщик TG. */
  compact?: boolean;
  width?: number;
  height?: number;
  className?: string;
  /** MIME для имени файла при скачивании (blob:-URL). */
  downloadContentType?: string;
};

type SurfaceProps = {
  src: string;
  poster?: string;
  compact: boolean;
  className?: string;
  width?: number;
  height?: number;
  autoplay?: boolean;
  loop?: boolean;
  defaultMuted?: boolean;
  startAt?: number;
  suspendPlayback?: boolean;
  onExpand?: () => void;
  onTime?: (seconds: number) => void;
  downloadContentType?: string;
};

function formatClock(seconds: number, padMinutes = false): string {
  if (!Number.isFinite(seconds) || seconds < 0) return padMinutes ? "00:00" : "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const ss = s.toString().padStart(2, "0");
  return padMinutes ? `${m.toString().padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Поддерживает ли браузер AV1 в MP4 (профиль Main, 8 бит). */
export function canPlayAv1(): boolean {
  if (typeof document === "undefined") return true;
  const probe = document.createElement("video");
  return probe.canPlayType('video/mp4; codecs="av01.0.08M.08"') !== "";
}

const CONTROLS_HIDE_DELAY_MS = 2400;

function IconVolume({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={styles.iconStroke} aria-hidden>
      <path d="M5 9.5v5h3.2L11.5 18V6L8.2 9.5H5z" fill="currentColor" />
      {muted ? (
        <path
          d="m14.8 9.2 4.2 4.2m0-4.2-4.2 4.2"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          fill="none"
        />
      ) : (
        <>
          <path
            d="M14.5 9a4.2 4.2 0 0 1 0 6"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            fill="none"
          />
          <path
            d="M17 6.8a7.5 7.5 0 0 1 0 10.4"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            fill="none"
          />
        </>
      )}
    </svg>
  );
}

function IconPip() {
  return (
    <svg viewBox="0 0 24 24" className={styles.iconStroke} aria-hidden>
      <rect x="4.5" y="7" width="10" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.6" fill="none" />
      <path
        d="M14.5 10h5v7h-5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z"
        stroke="currentColor"
        strokeWidth="1.6"
        fill="none"
      />
    </svg>
  );
}

function IconDownload() {
  return (
    <svg viewBox="0 0 24 24" className={styles.iconStroke} aria-hidden>
      <path
        d="M12 4.5v9.2m0 0 3.2-3.2M12 13.7 8.8 10.5M5.5 17.5h13"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function IconFullscreen({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={styles.iconStroke} aria-hidden>
      {active ? (
        <path
          d="M9.5 4.5v5h-5m15 0h-5v-5m0 15v-5h5m-15 0h5v5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      ) : (
        <path
          d="M4.5 9.5v-5h5m5 0h5v5m0 5v5h-5m-5 0h-5v-5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      )}
    </svg>
  );
}

function IconClose() {
  return (
    <svg viewBox="0 0 24 24" className={styles.viewerCloseIcon} aria-hidden>
      <path
        d="m7.5 7.5 9 9m0-9-9 9M16.5 7.5l-9 9"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Одна поверхность плеера (inline, лента или просмотрщик). */
function FloraVideoPlayerSurface({
  src,
  poster,
  compact,
  className,
  width,
  height,
  autoplay,
  loop,
  defaultMuted,
  startAt,
  suspendPlayback,
  onExpand,
  onTime,
  downloadContentType,
}: SurfaceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const progressRef = useRef<HTMLDivElement | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const wasPlayingRef = useRef(false);
  const startAtAppliedRef = useRef(false);

  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(Boolean(autoplay));
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [muted, setMuted] = useState(defaultMuted ?? false);
  const [volume, setVolume] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [pipActive, setPipActive] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [dragging, setDragging] = useState(false);

  const av1Supported = useMemo(() => canPlayAv1(), []);
  const pipSupported = useMemo(
    () => typeof document !== "undefined" && "pictureInPictureEnabled" in document && document.pictureInPictureEnabled,
    []
  );

  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setControlsVisible(false), CONTROLS_HIDE_DELAY_MS);
  }, []);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  useEffect(
    () => () => {
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    },
    []
  );

  useEffect(() => {
    if (!playing || compact) {
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
      setControlsVisible(true);
      return;
    }
    scheduleHide();
  }, [playing, compact, scheduleHide]);

  useEffect(() => {
    const onFsChange = () => setFullscreen(Boolean(document.fullscreenElement));
    const onPipChange = () => setPipActive(Boolean(document.pictureInPictureElement));
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("leavepictureinpicture", onPipChange);
    document.addEventListener("enterpictureinpicture", onPipChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("leavepictureinpicture", onPipChange);
      document.removeEventListener("enterpictureinpicture", onPipChange);
    };
  }, []);

  useEffect(() => {
    startAtAppliedRef.current = false;
  }, [src, startAt]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (suspendPlayback) {
      video.pause();
      return;
    }
    if (autoplay) {
      void video.play().catch(() => {});
    }
  }, [autoplay, suspendPlayback, src]);

  const refreshBuffered = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.duration) return;
    const ranges = video.buffered;
    let end = 0;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= video.currentTime && video.currentTime <= ranges.end(i)) {
        end = ranges.end(i);
        break;
      }
      end = Math.max(end, ranges.end(i));
    }
    setBuffered(Math.min(1, end / video.duration));
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || video.ended) {
      setStarted(true);
      void video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, []);

  const onVideoClick = useCallback(() => {
    if (onExpand) {
      onExpand();
      return;
    }
    togglePlay();
  }, [onExpand, togglePlay]);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  }, []);

  const onVolumeChange = useCallback((value: number) => {
    const video = videoRef.current;
    const next = Math.min(1, Math.max(0, value));
    setVolume(next);
    if (video) {
      video.volume = next;
      if (next > 0 && video.muted) {
        video.muted = false;
        setMuted(false);
      }
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void container.requestFullscreen().catch(() => {});
    }
  }, []);

  const downloadVideo = useCallback(() => {
    if (!src.startsWith("blob:")) return;
    triggerVideoBlobDownload(src, downloadContentType ?? "video/webm", "flora-video");
  }, [src, downloadContentType]);

  const togglePip = useCallback(() => {
    const video = videoRef.current;
    if (!video?.requestPictureInPicture) return;
    if (document.pictureInPictureElement) {
      void document.exitPictureInPicture().catch(() => {});
    } else {
      void video.requestPictureInPicture().catch(() => {});
    }
  }, []);

  const seekToClientX = useCallback((clientX: number) => {
    const video = videoRef.current;
    const bar = progressRef.current;
    if (!video || !bar || !video.duration) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    video.currentTime = ratio * video.duration;
    setCurrentTime(video.currentTime);
    onTime?.(video.currentTime);
  }, [onTime]);

  const onProgressPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const video = videoRef.current;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
      wasPlayingRef.current = Boolean(video && !video.paused && !video.ended);
      video?.pause();
      seekToClientX(e.clientX);
      showControls();
    },
    [seekToClientX, showControls]
  );

  const onProgressPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      seekToClientX(e.clientX);
    },
    [dragging, seekToClientX]
  );

  const onProgressPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      seekToClientX(e.clientX);
      setDragging(false);
      if (wasPlayingRef.current) void videoRef.current?.play().catch(() => {});
    },
    [dragging, seekToClientX]
  );

  const aspectRatio = width && height && width > 0 && height > 0 ? `${width} / ${height}` : undefined;
  const progressRatio = duration > 0 ? Math.min(1, currentTime / duration) : 0;
  const remaining = Math.max(0, duration - currentTime);
  const overlayVisible = controlsVisible || !playing || !started;
  const showBigPlay = !autoplay && !started;

  const rootClass = [
    styles.player,
    compact ? styles.playerCompact : styles.playerFull,
    overlayVisible ? styles.playerOverlayVisible : "",
    onExpand ? styles.playerExpandable : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const progressBar = (
    <div
      ref={progressRef}
      className={compact ? styles.compactProgress : styles.fullProgress}
      role="slider"
      aria-label="Перемотка"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(currentTime)}
      onPointerDown={onProgressPointerDown}
      onPointerMove={onProgressPointerMove}
      onPointerUp={onProgressPointerUp}
      onClick={(e) => e.stopPropagation()}
    >
      <div className={styles.progressTrack}>
        {!compact ? (
          <div className={styles.progressBuffer} style={{ width: `${buffered * 100}%` }} />
        ) : null}
        <div className={styles.progressFill} style={{ width: `${progressRatio * 100}%` }} />
        {!compact ? (
          <div className={styles.progressThumb} style={{ left: `${progressRatio * 100}%` }} />
        ) : null}
      </div>
    </div>
  );

  return (
    <div
      ref={containerRef}
      className={rootClass}
      style={aspectRatio ? { aspectRatio } : undefined}
      onPointerMove={compact ? undefined : showControls}
      onPointerLeave={compact ? undefined : () => playing && setControlsVisible(false)}
    >
      <video
        ref={videoRef}
        className={styles.video}
        src={src}
        poster={poster}
        playsInline
        preload="metadata"
        autoPlay={autoplay}
        loop={loop}
        muted={muted}
        onClick={onVideoClick}
        onPlay={() => {
          setPlaying(true);
          setStarted(true);
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          if (!loop) setPlaying(false);
        }}
        onTimeUpdate={(e) => {
          const t = e.currentTarget.currentTime;
          if (!dragging) setCurrentTime(t);
          onTime?.(t);
          refreshBuffered();
        }}
        onLoadedMetadata={(e) => {
          const video = e.currentTarget;
          setDuration(video.duration || 0);
          video.volume = volume;
          if (startAt != null && startAt > 0 && !startAtAppliedRef.current) {
            video.currentTime = startAt;
            setCurrentTime(startAt);
            startAtAppliedRef.current = true;
          }
        }}
        onDurationChange={(e) => setDuration(e.currentTarget.duration || 0)}
        onProgress={refreshBuffered}
        onVolumeChange={(e) => {
          setVolume(e.currentTarget.volume);
          setMuted(e.currentTarget.muted);
        }}
      />

      {showBigPlay ? (
        <button
          type="button"
          className={styles.bigPlay}
          onClick={(e) => {
            e.stopPropagation();
            togglePlay();
          }}
          aria-label="Воспроизвести видео"
        >
          <FlowPlayIcon className={styles.bigPlayIcon} playing={false} />
        </button>
      ) : null}

      {!av1Supported ? (
        <div className={styles.codecHint}>Браузер не поддерживает AV1 — обновите браузер для просмотра видео.</div>
      ) : null}

      {compact ? (
        <>
          <div className={styles.compactOverlay} aria-hidden={!overlayVisible}>
            <div className={styles.compactTopPill}>
              {started ? (
                <span className={styles.compactElapsed}>{formatClock(currentTime, true)}</span>
              ) : duration > 0 ? (
                <span className={styles.compactElapsed}>{formatClock(duration)}</span>
              ) : null}
              <button
                type="button"
                className={styles.compactIconBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleMute();
                }}
                aria-label={muted ? "Включить звук" : "Выключить звук"}
              >
                <IconVolume muted={muted} />
              </button>
            </div>
          </div>
          {started ? progressBar : null}
        </>
      ) : (
        <div className={styles.fullControls} onClick={(e) => e.stopPropagation()}>
          {progressBar}
          <div className={styles.fullControlsRow}>
            <div className={styles.fullControlsLeft}>
              <button
                type="button"
                className={styles.fullIconBtn}
                onClick={toggleMute}
                aria-label={muted ? "Включить звук" : "Выключить звук"}
              >
                <IconVolume muted={muted} />
              </button>
              <input
                type="range"
                className={styles.volumeSlider}
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onChange={(e) => onVolumeChange(Number(e.target.value))}
                aria-label="Громкость"
              />
              <span className={styles.fullTimeCurrent}>{formatClock(currentTime, true)}</span>
            </div>

            <button
              type="button"
              className={styles.fullCenterPlay}
              onClick={togglePlay}
              aria-label={playing ? "Пауза" : "Воспроизвести"}
            >
              <FlowPlayIcon className={styles.fullCenterPlayIcon} playing={playing} />
            </button>

            <div className={styles.fullControlsRight}>
              <span className={styles.fullTimeRemaining}>-{formatClock(remaining, true)}</span>
              {src.startsWith("blob:") ? (
                <button
                  type="button"
                  className={styles.fullIconBtn}
                  onClick={downloadVideo}
                  aria-label="Скачать видео"
                >
                  <IconDownload />
                </button>
              ) : null}
              {pipSupported ? (
                <button
                  type="button"
                  className={styles.fullIconBtn}
                  onClick={togglePip}
                  aria-label={pipActive ? "Закрыть PiP" : "Картинка в картинке"}
                >
                  <IconPip />
                </button>
              ) : null}
              <button
                type="button"
                className={styles.fullIconBtn}
                onClick={toggleFullscreen}
                aria-label={fullscreen ? "Выйти из полноэкранного режима" : "На весь экран"}
              >
                <IconFullscreen active={fullscreen} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Плеер Flora: inline в чате (autoplay+loop) + просмотрщик TG по клику; в ленте — полная панель. */
export function FloraVideoPlayer({
  src,
  poster,
  compact,
  width,
  height,
  className,
  downloadContentType,
}: FloraVideoPlayerProps) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerKey, setViewerKey] = useState(0);
  const [portalReady, setPortalReady] = useState(false);

  useEffect(() => setPortalReady(true), []);

  const openViewer = useCallback(() => {
    setViewerKey((k) => k + 1);
    setViewerOpen(true);
  }, []);

  const closeViewer = useCallback(() => setViewerOpen(false), []);

  useEffect(() => {
    if (!viewerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeViewer();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [viewerOpen, closeViewer]);

  if (!compact) {
    return (
      <FloraVideoPlayerSurface
        src={src}
        poster={poster}
        compact={false}
        width={width}
        height={height}
        className={className}
        downloadContentType={downloadContentType}
      />
    );
  }

  const viewer =
    viewerOpen && portalReady
      ? createPortal(
          <div
            className={styles.viewerBackdrop}
            role="dialog"
            aria-modal="true"
            aria-label="Просмотр видео"
            onClick={closeViewer}
          >
            <button
              type="button"
              className={styles.viewerClose}
              onClick={closeViewer}
              aria-label="Закрыть"
            >
              <IconClose />
            </button>
            <div className={styles.viewerStage} onClick={(e) => e.stopPropagation()}>
              <FloraVideoPlayerSurface
                key={viewerKey}
                src={src}
                poster={poster}
                compact={false}
                width={width}
                height={height}
                autoplay
                className={styles.viewerPlayer}
                downloadContentType={downloadContentType}
              />
            </div>
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <FloraVideoPlayerSurface
        src={src}
        poster={poster}
        compact
        width={width}
        height={height}
        className={className}
        autoplay
        loop
        defaultMuted
        suspendPlayback={viewerOpen}
        onExpand={openViewer}
        downloadContentType={downloadContentType}
      />
      {viewer}
    </>
  );
}
