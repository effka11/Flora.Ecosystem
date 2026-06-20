"use client";

import type { CSSProperties } from "react";
import { FlowPlayIcon } from "@/app/(dashboard)/music/FlowPlayIcon";
import { MusicTrackArtistLine } from "@/app/(dashboard)/music/MusicTrackArtistLine";
import { TrackDefaultCoverArt } from "@/app/(dashboard)/music/TrackDefaultCoverArt";
import { coverColorIdToColor } from "@/app/(dashboard)/music/musicDefaultCovers";
import { MUSIC_DEFAULT_TRACK_KIND_ID } from "@/app/(dashboard)/music/musicTrackKinds";
import { formatTrackDuration } from "@/app/(dashboard)/music/musicTracks";
import { useMusicPlayer } from "@/app/(dashboard)/music/player/MusicPlayerProvider";
import styles from "@/app/(dashboard)/music/music.module.css";

function IconPrev() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M16.5 6.75 9.5 12l7 5.25V6.75Z" fill="currentColor" />
      <path d="M7.25 6.75v10.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

function IconNext() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M7.5 6.75 14.5 12l-7 5.25V6.75Z" fill="currentColor" />
      <path d="M16.75 6.75v10.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function MusicMiniPlayer() {
  const {
    currentTrack,
    currentIndex,
    playing,
    busy,
    currentTime,
    duration,
    coverUrl,
    canPlayNext,
    error,
    togglePlay,
    playNext,
    playPrevious,
    seekByClientX,
    stop,
  } = useMusicPlayer();

  if (!currentTrack) return null;

  const coverStyle: CSSProperties | undefined = coverUrl
    ? {
        backgroundImage: `url(${coverUrl})`,
        backgroundPosition: "center",
        backgroundSize: "cover",
      }
    : undefined;

  const playbackProgress = duration > 0 ? Math.min(1, currentTime / duration) : 0;
  const canPlayPrevious = currentIndex > 0 || currentTime > 3;

  return (
    <div className={styles.flowMiniDock}>
      <div
        className={styles.flowMiniProgress}
        role="slider"
        aria-label="Прогресс трека"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(currentTime)}
        onPointerDown={(event) => {
          seekByClientX(event.clientX, event.currentTarget);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            seekByClientX(event.clientX, event.currentTarget);
          }
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
      >
        <div className={styles.flowMiniProgressTrack}>
          <div
            className={styles.flowMiniProgressFill}
            style={{ width: `${playbackProgress * 100}%` }}
          />
        </div>
      </div>
      <span className={`${styles.flowMiniTimer} flora-type-15`} aria-label="Осталось">
        −{formatTrackDuration(Math.max(0, duration - currentTime))}
      </span>
      <aside className={styles.flowMiniPlayer} aria-label="Музыкальный плеер">
        <div className={styles.flowMiniCover} style={coverStyle}>
          {!coverUrl ? (
            <TrackDefaultCoverArt
              coverColor={currentTrack.coverColor ?? coverColorIdToColor(null)}
              trackKindId={currentTrack.trackKindId ?? MUSIC_DEFAULT_TRACK_KIND_ID}
              className={styles.flowMiniCoverArt}
            />
          ) : null}
        </div>
        <div className={styles.flowMiniInfo}>
          <span className={`${styles.flowMiniTitle} flora-type-15`}>{currentTrack.title}</span>
          {error ? (
            <span className={`${styles.flowMiniMeta} flora-type-15`}>{error}</span>
          ) : (
            <MusicTrackArtistLine
              artist={currentTrack.artist}
              artistCredits={currentTrack.artistCredits}
              className={`${styles.flowMiniMeta} flora-type-15`}
            />
          )}
        </div>
      </aside>
      <div className={styles.flowMiniControls}>
        <button
          type="button"
          className={`${styles.flowMiniIconBtn} ${styles.flowMiniControlAt113}`}
          aria-label="Предыдущий трек"
          disabled={busy || !canPlayPrevious}
          onClick={() => void playPrevious()}
        >
          <IconPrev />
        </button>
        <button
          type="button"
          className={`${styles.flowMiniRoundBtn} ${styles.flowMiniControlAt116}`}
          aria-label={playing ? "Пауза" : "Продолжить"}
          aria-pressed={playing}
          disabled={busy}
          onClick={() => togglePlay()}
        >
          <FlowPlayIcon className={styles.flowMiniPlayIcon} playing={playing} />
        </button>
        <button
          type="button"
          className={`${styles.flowMiniIconBtn} ${styles.flowMiniControlAt119}`}
          aria-label="Следующий трек"
          disabled={busy || !canPlayNext}
          onClick={() => void playNext()}
        >
          <IconNext />
        </button>
        <button
          type="button"
          className={`${styles.flowMiniCloseBtn} ${styles.flowMiniControlAt122}`}
          aria-label="Скрыть плеер"
          onClick={() => stop()}
        >
          <IconClose />
        </button>
      </div>
    </div>
  );
}
