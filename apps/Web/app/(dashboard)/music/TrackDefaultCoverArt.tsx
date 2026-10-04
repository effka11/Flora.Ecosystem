import { MusicTrackKindIcon } from "@/app/(dashboard)/music/MusicTrackKindIcon";
import type { MusicTrackKindId } from "@/app/(dashboard)/music/musicTrackKinds";
import styles from "./music.module.css";

type TrackDefaultCoverArtProps = {
  coverColor: string;
  trackKindId: MusicTrackKindId;
  className?: string;
};

/** Базовая обложка: готовый цвет палитры + SVG-иконка типа (без растрового PNG). */
export function TrackDefaultCoverArt({ coverColor, trackKindId, className }: TrackDefaultCoverArtProps) {
  return (
    <span
      className={className ? `${styles.trackDefaultCoverArt} ${className}` : styles.trackDefaultCoverArt}
      style={{ background: coverColor }}
      aria-hidden
    >
      <MusicTrackKindIcon kind={trackKindId} className={styles.trackDefaultCoverKindIcon} />
    </span>
  );
}
