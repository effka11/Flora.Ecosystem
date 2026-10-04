import { TrackOwnPlatformBadge } from "@/app/(dashboard)/music/TrackOwnPlatformBadge";
import styles from "./music.module.css";

type MusicTrackTitleRowProps = {
  title: string;
  showOwnPlatformBadge?: boolean;
};

export function MusicTrackTitleRow({ title, showOwnPlatformBadge = false }: MusicTrackTitleRowProps) {
  return (
    <div className={styles.myMusicTrackTitleRow}>
      <span className={`${styles.myMusicTrackTitle} flora-type-15`}>{title}</span>
      {showOwnPlatformBadge ? <TrackOwnPlatformBadge /> : null}
    </div>
  );
}
