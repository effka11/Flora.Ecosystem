"use client";

import { useId, useState } from "react";
import {
  apiBeginEmailChange,
  apiConfirmEmailChange,
  apiGetSecurityStatus,
  type SecurityStatusDto,
} from "@flora/client-core/auth";
import { initGovApiClient } from "@/lib/govApiClient";
import {
  completeEmailVerification,
  type GovEmailChangePending,
  type GovEmailVerificationDeps,
} from "@/lib/govAuthGate";
import styles from "./govEmailWall.module.css";

const wallDeps: GovEmailVerificationDeps = {
  beginEmailChange: apiBeginEmailChange,
  confirmEmailChange: apiConfirmEmailChange,
  getSecurityStatus: apiGetSecurityStatus,
};

export type GovEmailWallProps = {
  /** Called with the fresh security status once Auth reports the email as verified. */
  onVerified: (security: SecurityStatusDto) => void;
};

/**
 * Replaces every civic function until Auth reports a confirmed email.
 *
 * The change plus confirm pair is the only path that sets `email_verified` for an
 * account that is already signed in, so the confirmation is completed here instead
 * of sending the citizen back to Flora Social.
 */
export function GovEmailWall({ onVerified }: GovEmailWallProps) {
  const headingId = useId();
  const passwordId = useId();
  const emailId = useId();
  const codeId = useId();

  const [password, setPassword] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<GovEmailChangePending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setError(null);
    setNotice(null);
    initGovApiClient();

    const outcome = await completeEmailVerification(wallDeps, {
      password,
      newEmail: newEmail.trim(),
      code,
      pending,
    });

    if (outcome.kind === "code-sent") {
      setPending(outcome.pending);
      setNotice(`Код отправлен на ${newEmail.trim()}. Введите его ниже.`);
      setBusy(false);
      return;
    }

    if (outcome.kind === "failed") {
      // Auth wrote this text; showing anything else would hide why the request failed.
      setError(outcome.message);
      setPending(outcome.pending);
      if (!outcome.pending) setCode("");
      setBusy(false);
      return;
    }

    if (outcome.decision === "shell") {
      setPassword("");
      setCode("");
      setPending(null);
      onVerified(outcome.security);
      return;
    }

    setPending(null);
    setCode("");
    setNotice(
      `Адрес изменён на ${outcome.email}, но проверка ещё не отмечена. Повторите подтверждение.`,
    );
    setBusy(false);
  }

  function onUseAnotherAddress() {
    if (busy) return;
    setPending(null);
    setCode("");
    setError(null);
    setNotice(null);
  }

  const awaitingCode = pending !== null;
  const submitLabel = awaitingCode
    ? busy
      ? "Подтверждаем"
      : "Подтвердить"
    : busy
      ? "Отправляем код"
      : "Отправить код";

  return (
    <section className={styles.wall} aria-labelledby={headingId}>
      <h1 className={styles.heading} id={headingId}>
        Требуется подтверждённый email
      </h1>

      <p className={styles.intro}>
        Гражданский портал открывает функции только для подтверждённого адреса. Регистрация
        и смена профиля живут в Flora Social, а подтверждение адреса завершается здесь.
      </p>
      <p className={styles.intro}>
        Укажите пароль и адрес, получите код и введите его. После подтверждения портал
        перечитает статус безопасности и откроет функции.
      </p>

      <form className={styles.form} onSubmit={onSubmit} noValidate autoComplete="off">
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={passwordId}>
            Пароль
          </label>
          <input
            id={passwordId}
            name="password"
            type="password"
            autoComplete="current-password"
            className={styles.fieldInput}
            value={password}
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={emailId}>
            Email для подтверждения
          </label>
          <input
            id={emailId}
            name="newEmail"
            type="email"
            autoComplete="email"
            className={styles.fieldInput}
            value={newEmail}
            disabled={busy || awaitingCode}
            onChange={(event) => setNewEmail(event.target.value)}
          />
        </div>

        {awaitingCode ? (
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor={codeId}>
              Код из письма
            </label>
            <input
              id={codeId}
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              className={styles.fieldInput}
              value={code}
              disabled={busy}
              onChange={(event) => setCode(event.target.value)}
            />
          </div>
        ) : null}

        <div className={styles.actions}>
          <button type="submit" className={styles.submit} disabled={busy}>
            {submitLabel}
          </button>
          {awaitingCode ? (
            <button
              type="button"
              className={styles.secondary}
              disabled={busy}
              onClick={onUseAnotherAddress}
            >
              Указать другой адрес
            </button>
          ) : null}
        </div>
      </form>

      {pending?.devVerificationCode ? (
        <p className={styles.devCode}>
          Код разработки от dev-сборки API: <b>{pending.devVerificationCode}</b>. В боевой
          сборке код приходит только письмом.
        </p>
      ) : null}

      {notice ? (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      ) : null}

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
