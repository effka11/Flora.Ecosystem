"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { apiGetSecurityStatus, apiLogin, saveLoginResponse } from "@flora/client-core/auth";
import { isTwoFactorChallenge } from "@flora/client-core/contracts";
import { GridOverlay } from "@/app/_shell/GridOverlay";
import { GOV_NAV_ITEMS } from "@/app/_shell/govNavigation";
import { useViewportFrameCssVars } from "@/app/_shell/viewportFrame";
import { initGovApiClient } from "@/lib/govApiClient";
import { decideGovGate, serverErrorText } from "@/lib/govAuthGate";
import { govSessionStore } from "@/lib/govSessionStore";
import styles from "./login.module.css";

const SOCIAL_LOGIN_URL =
  process.env.NODE_ENV === "production"
    ? "https://social.flora-s.net/login"
    : "http://localhost:3000/login";
const FIRST_CIVIC_HREF = GOV_NAV_ITEMS[0].href;

type LoginStage = "credentials" | "twoFactor";

function IconEnvelope() {
  return (
    <svg className={styles.iconSvg} viewBox="0 0 18 18" fill="none" aria-hidden>
      <path
        d="M1 3h16v12H1V3Zm0 0 8 6 8-6"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconLock() {
  return (
    <svg className={`${styles.iconSvg} ${styles.passwordIconSvg}`} viewBox="0 0 18 18" fill="none" aria-hidden>
      <path
        d="M5 8h8c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H5c-.6 0-1-.4-1-1V9c0-.6.4-1 1-1Zm1 0V6.2C6 4.5 7.3 3.2 9 3.2s3 1.3 3 2.8V8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconEyeOpen() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M1 12s4.5-7.5 11-7.5S23 12 23 12s-4.5 7.5-11 7.5S1 12 1 12Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15.5 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconEyeOff() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M1 12s4.5-7.5 11-7.5S23 12 23 12s-4.5 7.5-11 7.5S1 12 1 12Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15.5 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M3.5 3.5 20.5 20.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function LoginPageInner() {
  const emailId = useId();
  const passwordId = useId();
  const router = useRouter();
  useViewportFrameCssVars(true);

  const [stage, setStage] = useState<LoginStage>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [focusEmail, setFocusEmail] = useState(false);
  const [focusPassword, setFocusPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const twoFactorField = stage === "twoFactor";

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setError(null);

    try {
      initGovApiClient();
      const code = twoFactorCode.trim();
      const result = await apiLogin(
        email.trim(),
        password,
        twoFactorField && code ? code : undefined,
      );

      if (isTwoFactorChallenge(result)) {
        setStage("twoFactor");
        setError(result.error ?? null);
        setBusy(false);
        return;
      }

      await saveLoginResponse(govSessionStore, result);
      const security = await apiGetSecurityStatus();
      const decision = decideGovGate({
        hasAccessToken: Boolean(govSessionStore.getAccessTokenSync()),
        security,
      });

      if (decision === "login") {
        setError("Сессия не сохранена в этом браузере. Повторите вход.");
        setBusy(false);
        return;
      }

      router.replace(FIRST_CIVIC_HREF);
    } catch (caught) {
      setError(serverErrorText(caught));
      setBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.logoRow} aria-label="FLORA ID">
        {"FLORA".split("").map((ch, index) => (
          <span key={`flora-${index}`} className={styles.logoLetter}>
            {ch}
          </span>
        ))}
        {"ID".split("").map((ch, index) => (
          <span
            key={`id-${index}`}
            className={styles.logoLetter}
            style={index === 0 ? { marginLeft: 27 } : undefined}
          >
            {ch}
          </span>
        ))}
      </div>

      {busy ? (
        <div className={styles.busyOverlay} aria-busy="true">
          <div className={styles.busyDot} />
        </div>
      ) : null}

      <div className={styles.inner}>
        <form className={styles.formStack} onSubmit={onSubmit} autoComplete="off" noValidate>
          <div className={styles.fieldBlock}>
            <div className={styles.fieldRow}>
              <div className={`${styles.iconCell} ${styles.emailIconCell}`}>
                <IconEnvelope />
              </div>
              <div className={styles.fieldInputWrap}>
                <input
                  id={emailId}
                  type="text"
                  autoComplete="off"
                  className={styles.fieldInput}
                  placeholder="Email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  onFocus={() => setFocusEmail(true)}
                  onBlur={() => setFocusEmail(false)}
                />
              </div>
            </div>
            <div className={`${styles.underlineTrack} ${styles.emailUnderlineTrack}`}>
              <span className={`${styles.underlineActive} ${focusEmail ? styles.on : ""}`} />
            </div>
          </div>

          <div className={styles.fieldBlock}>
            <div className={styles.fieldRow}>
              <div className={`${styles.iconCell} ${styles.passwordIconCell}`}>
                <IconLock />
              </div>
              <div className={styles.fieldInputWrap}>
                <input
                  id={passwordId}
                  type={twoFactorField ? "text" : showPassword ? "text" : "password"}
                  inputMode={twoFactorField ? "numeric" : undefined}
                  autoComplete={twoFactorField ? "one-time-code" : "current-password"}
                  className={styles.fieldInput}
                  placeholder={twoFactorField ? "Код 2FA из приложения" : "Пароль"}
                  value={twoFactorField ? twoFactorCode : password}
                  onChange={(event) => {
                    if (twoFactorField) {
                      setTwoFactorCode(event.target.value);
                      return;
                    }
                    setPassword(event.target.value);
                  }}
                  onFocus={() => setFocusPassword(true)}
                  onBlur={() => setFocusPassword(false)}
                />
                {!twoFactorField ? (
                  <button
                    type="button"
                    className={`${styles.passwordToggle} ${password ? styles.visible : ""}`}
                    onClick={() => setShowPassword((value) => !value)}
                    aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"}
                  >
                    {showPassword ? <IconEyeOpen /> : <IconEyeOff />}
                  </button>
                ) : null}
              </div>
            </div>
            <div className={`${styles.underlineTrack} ${styles.passwordUnderlineTrack}`}>
              <span className={`${styles.underlineActive} ${focusPassword ? styles.on : ""}`} />
            </div>
          </div>

          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}

          <button type="submit" className={`${styles.submit} ${styles.submitGrid}`} disabled={busy}>
            {twoFactorField ? "Подтвердить" : "Войти"}
          </button>
        </form>

        <div className={styles.links}>
          <a className={styles.linkAccent} href={SOCIAL_LOGIN_URL}>
            Создать аккаунт
          </a>
          <span className={styles.linkMuted} aria-hidden>
            ·
          </span>
          <a className={styles.linkMuted} href={SOCIAL_LOGIN_URL}>
            Восстановить пароль
          </a>
        </div>
      </div>

      <GridOverlay />
    </main>
  );
}

export default function LoginPage() {
  return <LoginPageInner />;
}
