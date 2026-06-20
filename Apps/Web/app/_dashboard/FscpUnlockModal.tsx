"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { useCurrentUser } from "@/app/_dashboard/CurrentUserContext";
import styles from "./fscpUnlockModal.module.css";

/**
 * Inline-модалка восстановления FSCP-ключей по паролю аккаунта (restore-only).
 * Открывается автоматически при `needs_restore` (новый браузер / нет ключей) и из баннеров.
 * Пароль используется один раз и нигде не сохраняется; backup на сервере НЕ перезаписывается.
 */
export function FscpUnlockModal() {
  const titleId = useId();
  const { fscpUnlockOpen, closeFscpUnlock, restoreFscpWithPassword, fscpStatus } = useCurrentUser();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!fscpUnlockOpen) {
      setPassword("");
      setError(null);
      setBusy(false);
    }
  }, [fscpUnlockOpen]);

  if (!fscpUnlockOpen) return null;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const status = await restoreFscpWithPassword(password);
      if (status === "ready") {
        setPassword("");
        return;
      }
      if (status === "wrong_password") {
        setError("Неверный пароль. Попробуйте ещё раз.");
      } else if (status === "backup_not_found") {
        setError("Резервная копия ключей не найдена на сервере для этого аккаунта.");
      } else {
        setError(`Не удалось восстановить ключи (${status}).`);
      }
    } catch (err) {
      // Сетевая/серверная ошибка — это не «неверный пароль»: предложить повтор.
      setError(err instanceof Error ? err.message : "Сбой восстановления. Повторите попытку.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={styles.backdrop}
        aria-label="Закрыть"
        onClick={closeFscpUnlock}
      />
      <div className={styles.modalLayer} role="presentation">
        <div className={styles.dialog} role="dialog" aria-modal aria-labelledby={titleId}>
          <div className={styles.header}>
            <h2 id={titleId} className={styles.title}>
              Восстановление ключей сообщений
            </h2>
            <button type="button" className={styles.close} aria-label="Закрыть" onClick={closeFscpUnlock}>
              ×
            </button>
          </div>
          <form className={styles.body} onSubmit={onSubmit}>
            <p className={styles.text}>
              На этом устройстве нет ключей шифрования. Введите пароль аккаунта один раз, чтобы
              восстановить доступ к зашифрованным сообщениям. Пароль не сохраняется.
            </p>
            <input
              type="password"
              className={styles.input}
              placeholder="Пароль аккаунта"
              value={password}
              disabled={busy}
              autoFocus
              autoComplete="current-password"
              onChange={(e) => {
                setPassword(e.target.value);
                if (error) setError(null);
              }}
            />
            {error ? (
              <p className={styles.error} role="alert">
                {error}
              </p>
            ) : null}
            <div className={styles.actions}>
              <button type="button" className={styles.btnGhost} onClick={closeFscpUnlock} disabled={busy}>
                Позже
              </button>
              <button type="submit" className={styles.btnPrimary} disabled={busy || !password.trim()}>
                {busy ? "Восстановление…" : "Восстановить"}
              </button>
            </div>
            {fscpStatus === "backup_not_found" ? (
              <p className={styles.hint}>
                Если резервной копии нет, создайте её на устройстве, где ключи доступны (вход с
                паролем), затем повторите здесь.
              </p>
            ) : null}
          </form>
        </div>
      </div>
    </>
  );
}
