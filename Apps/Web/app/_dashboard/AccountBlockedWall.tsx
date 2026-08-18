"use client";

import { useCallback, useId, useState } from "react";
import { apiLogout, ApiRequestError } from "@/lib/auth";
import { redirectToLogin } from "@/lib/loginRedirect";
import styles from "./accountBlockedWall.module.css";

export type AccountBlockedWallProps = {
  accountBlockedUntil?: string | null;
};

function blockedUntilMessage(until: string | null | undefined): string | null {
  if (until === null) return "Блокировка бессрочная.";
  if (until === undefined) return null;
  const parsed = new Date(until);
  if (Number.isNaN(parsed.getTime())) return `Блокировка действует до ${until}.`;
  const formatted = parsed.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return `Блокировка действует до ${formatted}.`;
}

export function AccountBlockedWall({ accountBlockedUntil }: AccountBlockedWallProps) {
  const headingId = useId();
  const [loggingOut, setLoggingOut] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const untilMessage = blockedUntilMessage(accountBlockedUntil);

  const onLogout = useCallback(async () => {
    setSessionError(null);
    setLoggingOut(true);
    try {
      await apiLogout();
      redirectToLogin();
    } catch (e) {
      setSessionError(
        e instanceof ApiRequestError || e instanceof Error ? e.message : "Не удалось выйти из аккаунта.",
      );
      setLoggingOut(false);
    }
  }, []);

  return (
    <section className={styles.wall} aria-labelledby={headingId}>
      <div className={styles.wallInner}>
        <h1 className={styles.heading} id={headingId}>
          Аккаунт заблокирован
        </h1>
        <p className={styles.intro}>
          Доступ к Flora Social для этого аккаунта ограничен. Вы не можете пользоваться лентой, сообщениями и
          другими функциями, пока действует блокировка.
        </p>
        {untilMessage ? <p className={styles.until}>{untilMessage}</p> : null}
        {sessionError ? (
          <p className={styles.error} role="alert">
            {sessionError}
          </p>
        ) : null}
        <div className={styles.actions}>
          <button type="button" className={styles.logout} disabled={loggingOut} onClick={() => void onLogout()}>
            {loggingOut ? "Выход…" : "Выйти"}
          </button>
        </div>
      </div>
    </section>
  );
}
