"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { sharedPresenceStore } from "@flora/client-core/presence";
import { profilePathFromUsername } from "@/app/_dashboard/userDisplay";
import { FloraAvatar } from "@/app/_shared/FloraAvatar";
import { PeopleRowActions, type PeopleRowUser } from "./PeopleRowActions";
import styles from "./people.module.css";

type PeopleListRowProps = {
  user: PeopleRowUser;
  isSubscribed: boolean;
  actionAnimEpoch: number;
  onToggleSubscribe: () => void;
  /** §User Controls (FIRA-P): «не интересно» — только в рекомендациях. */
  onDismiss?: () => void;
};

export function PeopleListRow({
  user,
  isSubscribed,
  actionAnimEpoch,
  onToggleSubscribe,
  onDismiss,
}: PeopleListRowProps) {
  const [presenceTick, setPresenceTick] = useState(0);
  useEffect(() => sharedPresenceStore.subscribe(() => setPresenceTick((n) => n + 1)), []);

  const overlay = user.userUuid
    ? sharedPresenceStore.overlayOnline(user.userUuid, user.isOnline ?? false, user.lastSeenAt)
    : { isOnline: user.isOnline ?? false, lastSeenAt: user.lastSeenAt ?? null };
  void presenceTick;

  return (
    <li className={styles.item}>
      <Link href={profilePathFromUsername(user.username)} className={styles.userMain}>
        <span className={styles.avatarWrap}>
          <FloraAvatar
            plain
            size={45}
            avatarUuid={user.avatarUuid}
            displayName={user.displayName}
            username={user.username}
            seed={user.id}
            className={styles.avatar}
          />
          <span
            className={`${styles.onlineBadge}${overlay.isOnline ? ` ${styles.onlineBadgeVisible}` : ""}`}
            title={overlay.isOnline ? "В сети" : undefined}
            aria-hidden
          />
        </span>
        <div className={styles.userBody}>
          <span className={styles.userPrimaryLine}>
            <span className={styles.displayName}>{user.displayName}</span>
            <span className={styles.userName}>{user.username}</span>
          </span>
          <span className={styles.userSecondaryLine}>
            <strong className={styles.followersCountValue}>{user.followers.toLocaleString("ru-RU")}</strong>
            <span>подписчиков</span>
          </span>
        </div>
      </Link>
      <PeopleRowActions
        user={user}
        isSubscribed={isSubscribed}
        actionAnimEpoch={actionAnimEpoch}
        onToggleSubscribe={onToggleSubscribe}
        onDismiss={onDismiss}
      />
    </li>
  );
}
