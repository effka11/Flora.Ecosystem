import Link from "next/link";
import { useState, type CSSProperties, type MouseEvent } from "react";
import {
  communityInitials,
  profileInitials,
  resolveDefaultAvatarColor,
} from "@flora/client-core/display";
import { avatarImageUrl } from "@/lib/auth";
import styles from "./FloraAvatar.module.css";

/** Внутренний диаметр аватара в profile.module.css (98px ring − 4px border × 2). */
export const FLORA_PROFILE_AVATAR_INNER_PX = 90;

export type FloraAvatarProps = {
  size?: number;
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

function avatarRootStyle(size: number, style?: CSSProperties): CSSProperties {
  return {
    width: size,
    height: size,
    ["--flora-avatar-size" as string]: `${size}px`,
    ...style,
  };
}

export function FloraAvatar({
  size = 45,
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
}: FloraAvatarProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const trimmedUuid = avatarUuid?.trim() ?? "";
  const showImage = trimmedUuid.length > 0 && !imageFailed;
  const colorSeed = seed?.trim() || username.trim() || displayName.trim();
  const initials = communityName
    ? communityInitials(communityName)
    : profileInitials(displayName, username);
  const backgroundColor = resolveDefaultAvatarColor(colorSeed);
  const rootClass = className ? `${styles.root} ${className}` : styles.root;
  const rootStyle = avatarRootStyle(size, style);

  const content = showImage ? (
    // eslint-disable-next-line @next/next/no-img-element -- CDN/API avatar URL
    <img
      src={`${avatarImageUrl(trimmedUuid)}${cacheVersion > 0 ? `?v=${cacheVersion}` : ""}`}
      alt=""
      className={styles.image}
      onError={() => setImageFailed(true)}
    />
  ) : (
    <DefaultAvatarArt initials={initials} backgroundColor={backgroundColor} />
  );

  const wrapped = href ? (
    <Link
      href={href}
      className={`${rootClass} ${styles.link}`}
      style={rootStyle}
      onClick={onLinkClick}
    >
      {content}
    </Link>
  ) : (
    <span className={rootClass} style={rootStyle}>
      {content}
    </span>
  );

  return wrapped;
}
