"use client";

import Link from "next/link";
import { profilePathFromUsername } from "@/app/_dashboard/userDisplay";
import { PeopleRowActions, type PeopleRowUser } from "./PeopleRowActions";
import styles from "./people.module.css";

type PeopleListRowProps = {
  user: PeopleRowUser;
  isSubscribed: boolean;
  actionAnimEpoch: number;
  onToggleSubscribe: () => void;
};

export function PeopleListRow({ user, isSubscribed, actionAnimEpoch, onToggleSubscribe }: PeopleListRowProps) {
  return (
    <li className={styles.item}>
      <Link href={profilePathFromUsername(user.username)} className={styles.userMain}>
        <div className={styles.avatar} aria-hidden>
          {user.displayName.slice(0, 1)}
        </div>
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
      />
    </li>
  );
}
