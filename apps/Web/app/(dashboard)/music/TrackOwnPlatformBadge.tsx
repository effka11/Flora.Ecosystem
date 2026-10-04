import styles from "./music.module.css";

const TOOLTIP = "Это ваш трек, публично загруженный на площадку";

function IconPlatformOwn() {
  return (
    <svg className={styles.myMusicTrackOwnBadgeIcon} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.45" />
      <path
        d="M4.5 11h13M11 4c2 1.9 3 4.2 3 7s-1 5.1-3 7M11 4c-2 1.9-3 4.2-3 7s1 5.1 3 7"
        stroke="currentColor"
        strokeWidth="1.15"
        strokeLinecap="round"
        opacity="0.78"
      />
      <path
        className={styles.myMusicTrackOwnBadgeCheck}
        d="m15.3 17.1 2 2 3.6-4.4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TrackOwnPlatformBadge() {
  return (
    <span className={styles.myMusicTrackOwnBadgeWrap} tabIndex={0} aria-label={TOOLTIP}>
      <span className={styles.myMusicTrackOwnBadge} aria-hidden>
        <IconPlatformOwn />
      </span>
      <span className={styles.myMusicTrackOwnBadgeTooltip} role="tooltip">
        {TOOLTIP}
      </span>
    </span>
  );
}
