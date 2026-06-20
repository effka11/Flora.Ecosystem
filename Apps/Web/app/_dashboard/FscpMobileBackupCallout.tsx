"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  fscpStatusNeedsPassword,
  useCurrentUser,
} from "@/app/_dashboard/CurrentUserContext";
import { msgGetKeyBackup } from "@/lib/messagingApi";
import styles from "./fscpMobileBackupCallout.module.css";

export function FscpMobileBackupCallout() {
  const { fscpMaterial, fscpBootstrapLoading, fscpStatus, openFscpUnlock } = useCurrentUser();
  const [hasBackup, setHasBackup] = useState<boolean | null>(null);

  useEffect(() => {
    if (!fscpMaterial || fscpBootstrapLoading) {
      setHasBackup(null);
      return;
    }
    let cancelled = false;
    void msgGetKeyBackup()
      .then(() => {
        if (!cancelled) setHasBackup(true);
      })
      .catch(() => {
        if (!cancelled) setHasBackup(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fscpMaterial, fscpBootstrapLoading]);

  if (fscpBootstrapLoading) {
    return null;
  }

  // Нет локальных ключей и статус требует пароля → inline-восстановление (не редирект в /login).
  if (!fscpMaterial) {
    if (!fscpStatusNeedsPassword(fscpStatus)) return null;
    return (
      <div className={styles.banner} role="status">
        <p className={styles.text}>
          На этом устройстве нет ключей шифрования сообщений.{" "}
          <button type="button" className={styles.linkButton} onClick={openFscpUnlock}>
            Ввести пароль
          </button>{" "}
          для восстановления.
        </p>
      </div>
    );
  }

  // Локальные ключи есть, но серверного backup нет: создаётся автоматически при следующем входе;
  // как ручной fallback — Настройки → Безопасность (явная авторитетная загрузка).
  if (hasBackup !== false) {
    return null;
  }

  return (
    <div className={styles.banner} role="status">
      <p className={styles.text}>
        Для мобильного приложения нужна резервная копия ключей на сервере. Она создастся при
        следующем входе с паролем, либо обновите её в{" "}
        <Link href="/settings" className={styles.link}>
          Настройках → Безопасность
        </Link>
        .
      </p>
    </div>
  );
}
