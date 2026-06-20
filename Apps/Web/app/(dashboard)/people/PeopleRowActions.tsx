"use client";

import type { MouseEvent } from "react";
import Link from "next/link";
import { messagesOpenChatQuery } from "@/lib/messagesUrl";
import styles from "./people.module.css";

export type PeopleRowUser = {
  id: string;
  displayName: string;
  username: string;
  followers: number;
};

type PeopleRowActionsProps = {
  user: PeopleRowUser;
  isSubscribed: boolean;
  actionAnimEpoch: number;
  onToggleSubscribe: () => void;
};

function IconUnsubscribe() {
  return (
    <svg className={styles.btnIconSvg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="9" cy="7" r="4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M22 11 18 7M18 11l4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PeopleRowActions({ user, isSubscribed, actionAnimEpoch, onToggleSubscribe }: PeopleRowActionsProps) {
  const messagesHref = messagesOpenChatQuery({
    userUuid: user.id,
    username: user.username,
    displayName: user.displayName,
  });

  const stopRowNav = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const unsubscribeControl = (
    <button
      type="button"
      className={`${styles.btnIcon} ${styles.btnIconUnsubscribe}`}
      onClick={(e) => {
        stopRowNav(e);
        onToggleSubscribe();
      }}
      aria-label="Отписаться"
    >
      <IconUnsubscribe />
    </button>
  );

  const subscribeControl = (
    <button
      type="button"
      className={styles.btnMain}
      onClick={(e) => {
        stopRowNav(e);
        onToggleSubscribe();
      }}
    >
      Подписаться
    </button>
  );

  const writeControl = (
    <Link href={messagesHref} className={styles.btnMain}>
      Написать
    </Link>
  );

  return (
    <div
      key={`${isSubscribed ? "sub" : "unsub"}-${actionAnimEpoch}`}
      className={`${styles.rowActions} ${actionAnimEpoch > 0 ? styles.rowActionsFadeIn : ""}`}
    >
      {isSubscribed ? (
        <>
          {unsubscribeControl}
          {writeControl}
        </>
      ) : (
        subscribeControl
      )}
    </div>
  );
}
