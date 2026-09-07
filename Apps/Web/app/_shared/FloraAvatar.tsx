import Link from "next/link";
import { useState, type CSSProperties, type MouseEvent } from "react";
import {
  communityInitials,
  profileInitials,
  resolveDefaultAvatarColor,
} from "@flora/client-core/display";
import { avatarImageUrl } from "@/lib/auth";
import { FrcImage } from "./FrcImage";
import styles from "./FloraAvatar.module.css";

export type FloraAvatarProps = {
  avatarUuid?: string | null;
  displayName: string;
  username?: string;
  seed?: string;
  cacheVersion?: number;
  className?: string;
  href?: string;
  style?: CSSProperties;
  onLinkClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  /** Сообщество: инициалы из name, seed для цвета. */
  communityName?: string;
  /** Без inset-обводки и text-shadow (лента, compose, люди). */
  plain?: boolean;
  /** Мини-аватары (стек репостов): сдвиг кириллицы в круге. */
  compact?: boolean;
  /** Заполнить родителя (шапка профиля: кольцо − border). */
  fill?: boolean;
  /** Заблокированный пользователь: дефолтный аватар и красная диагональ (не для сообществ). */
  accountBlocked?: boolean;
};

type DefaultAvatarArtProps = {
  initials: string;
  backgroundColor: string;
};

function DefaultAvatarArt({ initials, backgroundColor }: DefaultAvatarArtProps) {
  return (
    <span
      className={styles.defaultArt}
      style={{ backgroundColor }}
      aria-hidden
    >
      <span className={styles.initials}>{initials}</span>
    </span>
  );
}

export function FloraAvatar({
  avatarUuid,
  displayName,
  username = "",
  seed,
  cacheVersion = 0,
  className,
  href,
  style,
  onLinkClick,
  communityName,
  plain = false,
  compact = false,
  fill = false,
  accountBlocked = false,
}: FloraAvatarProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const trimmedUuid = avatarUuid?.trim() ?? "";
  const isCommunity = Boolean(communityName?.trim());
  const showBlockedTreatment = accountBlocked && !isCommunity;
  const showImage = !showBlockedTreatment && trimmedUuid.length > 0 && !imageFailed;
  const colorSeed = seed?.trim() || username.trim() || displayName.trim();
  const initials = communityName
    ? communityInitials(communityName)
    : profileInitials(displayName, username);
  const backgroundColor = resolveDefaultAvatarColor(colorSeed);
  const rootClass = [
    styles.root,
    plain ? styles.plain : null,
    compact ? styles.smallInitials : null,
    fill ? styles.fill : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const content = (
    <span className={styles.art}>
      {showImage ? (
        <FrcImage
          src={`${avatarImageUrl(trimmedUuid)}${cacheVersion > 0 ? `&v=${cacheVersion}` : ""}`}
          alt=""
          className={styles.image}
          onError={() => setImageFailed(true)}
        />
      ) : (
        <DefaultAvatarArt initials={initials} backgroundColor={backgroundColor} />
      )}
      {showBlockedTreatment ? <span className={styles.blockedLine} aria-hidden /> : null}
    </span>
  );

  const wrapped = href ? (
    <Link
      href={href}
      className={`${rootClass} ${styles.link}`}
      style={style}
      onClick={onLinkClick}
    >
      {content}
    </Link>
  ) : (
    <span className={rootClass} style={style}>
      {content}
    </span>
  );

  return wrapped;
}
