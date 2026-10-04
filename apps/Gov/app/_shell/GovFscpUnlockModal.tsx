"use client";

import { useId, useState, type FormEvent } from "react";
import { useGovFscp } from "./GovFscpProvider";
import styles from "./govFscpUnlockModal.module.css";

/** Restore-only: never overwrites the server key-backup. */
export function GovFscpUnlockModal() {
  const titleId = useId();
  const { fscpUnlockOpen, closeFscpUnlock, restoreFscpWithPassword, fscpStatus } = useGovFscp();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetAndClose = () => {
    setPassword("");
    setError(null);
    setBusy(false);
    closeFscpUnlock();
  };

  if (!fscpUnlockOpen) return null;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
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
      setError(err instanceof Error ? err.message : "Сбой восстановления. Повторите попытку.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className={styles.backdrop} aria-label="Закрыть" onClick={resetAndClose} />
      <div className={styles.modalLayer} role="presentation">
        <div className={styles.dialog} role="dialog" aria-modal aria-labelledby={titleId}>
          <div className={styles.header}>
            <h2 id={titleId} className={styles.title}>
              Восстановление ключей
            </h2>
            <button type="button" className={styles.close} aria-label="Закрыть" onClick={resetAndClose}>
              ×
            </button>
          </div>
          <form className={styles.body} onSubmit={onSubmit}>
            <p className={styles.text}>
              На этом устройстве нет ключей для раскрытия заявок. Введите пароль аккаунта один раз.
              Пароль не сохраняется, резервная копия на сервере не перезаписывается.
            </p>
            <input
              type="password"
              className={styles.input}
              placeholder="Пароль аккаунта"
              value={password}
              disabled={busy}
              autoFocus
              autoComplete="current-password"
              onChange={(event) => {
                setPassword(event.target.value);
                if (error) setError(null);
              }}
            />
            {error ? (
              <p className={styles.error} role="alert">
                {error}
              </p>
            ) : null}
            <div className={styles.actions}>
              <button type="button" className={styles.btnGhost} onClick={resetAndClose} disabled={busy}>
                Позже
              </button>
              <button type="submit" className={styles.btnPrimary} disabled={busy || !password.trim()}>
                {busy ? "Восстановление" : "Восстановить"}
              </button>
            </div>
            {fscpStatus === "backup_not_found" ? (
              <p className={styles.hint}>
                Если резервной копии нет, создайте её на устройстве, где ключи доступны (вход с
                паролем в Social), затем повторите здесь.
              </p>
            ) : null}
          </form>
        </div>
      </div>
    </>
  );
}
