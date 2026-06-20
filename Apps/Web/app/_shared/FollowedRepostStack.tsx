import Link from "next/link";
import { FloraAvatar } from "@/app/_shared/FloraAvatar";
import type { FollowedReposterDto } from "@/lib/socialApi";
import styles from "./FollowedRepostStack.module.css";

const VISIBLE_AVATAR_LIMIT = 3;

type FollowedRepostStackProps = {
  reposters: FollowedReposterDto[];
  profileHref: (username: string) => string;
  className?: string;
};

/** Стек мини-аватаров подписок, репостнувших пост (справа от кнопки репоста). */
export function FollowedRepostStack({ reposters, profileHref, className }: FollowedRepostStackProps) {
  if (reposters.length === 0) return null;

  const visible = reposters.slice(0, VISIBLE_AVATAR_LIMIT);
  const extraCount = reposters.length - visible.length;
  const wrapClass = className ? `${styles.wrap} ${className}` : styles.wrap;

  return (
    <div className={wrapClass} aria-label="Репосты от ваших подписок">
      <div className={styles.stack}>
        {visible.map((reposter, index) => (
          <FloraAvatar
            key={reposter.username}
            href={profileHref(reposter.username)}
            avatarUuid={reposter.avatarUuid}
            displayName={reposter.displayName}
            username={reposter.username}
            seed={reposter.userUuid ?? reposter.username}
            size={22}
            className={styles.avatar}
            style={{ zIndex: visible.length - index }}
          />
        ))}
      </div>
      {extraCount > 0 ? (
        <button
          type="button"
          className={styles.moreBtn}
          title={reposters.slice(VISIBLE_AVATAR_LIMIT).map((r) => r.displayName).join(", ")}
          aria-label={`И ещё ${extraCount} ${extraLabel(extraCount)}`}
        >
          <span className={`${styles.moreLabel} flora-type-15`}>и ещё {extraCount}</span>
          <svg className={styles.moreArrow} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}

function extraLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "репост";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "репоста";
  return "репостов";
}
