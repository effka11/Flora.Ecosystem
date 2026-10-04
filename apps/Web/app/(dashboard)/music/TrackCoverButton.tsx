"use client";

import type { CSSProperties } from "react";
import { TrackDefaultCoverArt } from "@/app/(dashboard)/music/TrackDefaultCoverArt";
import type { MusicTrackKindId } from "@/app/(dashboard)/music/musicTrackKinds";
import styles from "./music.module.css";

type TrackCoverButtonProps = {
  coverColor: string;
  trackKindId: MusicTrackKindId;
  coverUrl: string | null;
  title: string;
  isPlaying: boolean;
  isLoading: boolean;
  onClick: () => void;
};

export function TrackCoverButton({
  coverColor,
  trackKindId,
  coverUrl,
  title,
  isPlaying,
  isLoading,
  onClick,
}: TrackCoverButtonProps) {
  const imageStyle: CSSProperties | undefined = coverUrl
    ? {
        backgroundImage: `url(${coverUrl})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }
    : undefined;

  return (
    <button
      type="button"
      className={styles.myMusicTrackCoverBtn}
      data-playing={isPlaying ? "" : undefined}
      data-loading={isLoading ? "" : undefined}
      aria-label={isPlaying ? `Пауза «${title}»` : `Слушать «${title}»`}
      aria-pressed={isPlaying}
      disabled={isLoading}
      onClick={onClick}
    >
      {coverUrl ? (
        <span className={styles.myMusicTrackCoverArt} style={imageStyle} aria-hidden />
      ) : (
        <TrackDefaultCoverArt
          coverColor={coverColor}
          trackKindId={trackKindId}
          className={styles.myMusicTrackCoverArt}
        />
      )}
      <span className={styles.myMusicTrackCoverOverlay} aria-hidden>
        <span className={styles.myMusicTrackCoverTransport}>
          {isLoading ? (
            <span className={styles.myMusicTrackCoverLoading} />
          ) : (
            <span className={styles.myMusicTrackCoverIcon} data-playing={isPlaying ? "" : undefined}>
              <span className={styles.myMusicTrackCoverPlayMark} />
              <span className={styles.myMusicTrackCoverPauseMark}>
                <span />
                <span />
              </span>
            </span>
          )}
        </span>
        <span className={styles.myMusicTrackCoverEqualizer}>
          <span />
          <span />
          <span />
          <span />
        </span>
      </span>
    </button>
  );
}
