"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useRouter } from "next/navigation";
import { GridOverlay } from "@/app/_shared/GridOverlay";
import type { MeResponse } from "@/lib/auth";
import { isReservedUsername, RESERVED_USERNAME_MESSAGE } from "@/lib/reservedUsernames";
import {
  apiCancelRegistration,
  authPublicFetchUrl,
  apiGetMe,
  apiLogin,
  apiRegister,
  apiUpdateProfile,
  apiVerifyRegistration,
  clearPendingProfileSetup,
  clearSession,
  getAccessToken,
  hasPendingProfileSetup,
  isTwoFactorChallenge,
  saveSession,
  setPendingProfileSetup,
} from "@/lib/auth";
import { useGridBindings } from "./useGridBindings";
import styles from "./login.module.css";

// Offline "войти без авторизации" button: dev-only, and never in a production build even if the
// flag is set (NODE_ENV is "production" under next build/start, so this is compiled out there).
const DEV_AUTO_AUTH_ENABLED =
  process.env.NEXT_PUBLIC_DEV_AUTO_AUTH === "1" && process.env.NODE_ENV !== "production";

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

function IconUser() {
  return (
    <svg className={styles.iconSvg} viewBox="0 0 18 18" fill="none" aria-hidden>
      <path
        d="M9 9.1a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3.7 15.5c.8-2.4 2.6-3.7 5.3-3.7s4.5 1.3 5.3 3.7"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconAt() {
  return (
    <svg className={styles.iconSvg} viewBox="0 0 18 18" fill="none" aria-hidden>
      <path
        d="M11.6 7.7v2.5c0 1 .6 1.6 1.5 1.6 1.2 0 2.3-1.2 2.3-3.3a6.4 6.4 0 1 0-2.6 5.2M11.6 9A2.6 2.6 0 1 1 9 6.4 2.6 2.6 0 0 1 11.6 9Z"
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

async function provisionFscpBackupAfterAuth(
  userUuid: string,
  accountPassword: string,
): Promise<{ ok: boolean; reason?: string }> {
  const { webSyncFscpOnLogin } = await import("@/lib/fscp/syncOnLogin");
  const res = await webSyncFscpOnLogin(userUuid, accountPassword, { authoritativeOverwrite: true });
  if (res.backupUploaded || res.bootstrap.status !== "ready") {
    return { ok: res.backupUploaded };
  }
  return { ok: false, reason: res.backupSkippedReason ?? "upload_error" };
}

export default function LoginPage() {
  type BindTarget = "panel" | "logo" | "form";
  type FormMode = "login" | "register" | "verify" | "profileSetup";
  type ModeAnim = "none" | "exitToLeft" | "enterFromRight" | "exitToRight" | "enterFromLeft";

  const router = useRouter();
  const emailId = useId();
  const passwordId = useId();
  const profileNameId = useId();
  const profileNicknameId = useId();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [awaitingTwoFactor, setAwaitingTwoFactor] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [verificationToken, setVerificationToken] = useState("");
  const [devVerificationHint, setDevVerificationHint] = useState<string | null>(null);
  const [profileName, setProfileName] = useState("");
  const [profileNickname, setProfileNickname] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [focusEmail, setFocusEmail] = useState(false);
  const [focusPassword, setFocusPassword] = useState(false);
  const [focusConfirmPassword, setFocusConfirmPassword] = useState(false);
  const [focusVerificationCode, setFocusVerificationCode] = useState(false);
  const [focusProfileName, setFocusProfileName] = useState(false);
  const [focusProfileNickname, setFocusProfileNickname] = useState(false);
  const [mode, setMode] = useState<FormMode>("login");
  const [modeAnim, setModeAnim] = useState<ModeAnim>("none");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exitTimerRef = useRef<number | null>(null);
  const enterTimerRef = useRef<number | null>(null);
  const transitionTokenRef = useRef(0);
  const innerRef = useRef<HTMLDivElement>(null);
  const logoRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const bindingRefs = useMemo(
    () => ({
      panel: innerRef as RefObject<HTMLElement>,
      logo: logoRef as RefObject<HTMLElement>,
      form: formRef as RefObject<HTMLElement>
    }),
    []
  );
  const bindingPreset: Record<BindTarget, "none" | "grid15" | "grid5"> = {
    panel: "none",
    logo: "none",
    form: "none"
  };
  const {
    gridBinding,
    panelSnapPosition,
    offsets
  } = useGridBindings<BindTarget>({
    gridEnabled: false,
    refs: bindingRefs,
    panelTarget: "panel",
    initialBinding: bindingPreset,
    effectDeps: [mode]
  });

  const enterProfileSetupSync = useCallback(() => {
    if (exitTimerRef.current !== null) {
      window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    if (enterTimerRef.current !== null) {
      window.clearTimeout(enterTimerRef.current);
      enterTimerRef.current = null;
    }
    transitionTokenRef.current += 1;
    setModeAnim("none");
    setMode("profileSetup");
  }, []);

  function loginWithoutAuthorization() {
    clearPendingProfileSetup();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
    saveSession({
      accessToken: "dev-token",
      refreshToken: "dev-refresh-token",
      expiresAt
    });
    router.push("/feed");
    router.refresh();
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === "register" && password !== confirmPassword) {
      setError("Пароли не совпадают");
      return;
    }

    if (mode === "verify" && !verificationCode.trim()) {
      setError("Введите код из сообщения");
      return;
    }
    if (mode === "verify" && !verificationToken) {
      setError("Сессия верификации истекла. Зарегистрируйтесь снова.");
      return;
    }
    if (mode === "profileSetup") {
      const name = profileName.trim();
      const nickname = profileNickname.trim().replace(/^@+/, "");
      if (!name) {
        setError("Введите имя");
        return;
      }
      if (!nickname) {
        setError("Введите никнейм");
        return;
      }
      if (!/^[a-zA-Z0-9_]{3,50}$/.test(nickname)) {
        setError("Никнейм: латиница, цифры и _, от 3 до 50 символов");
        return;
      }
    }

    setLoading(true);
    try {
      if (mode === "login") {
        const result = await apiLogin(
          email.trim(),
          password,
          awaitingTwoFactor ? twoFactorCode.trim() : undefined
        );
        if (isTwoFactorChallenge(result)) {
          setAwaitingTwoFactor(true);
          setError(result.error ?? "Введите код двухфакторной аутентификации (2FA).");
          return;
        }
        const res = result;
        setAwaitingTwoFactor(false);
        setTwoFactorCode("");
        saveSession(res);

        let me: MeResponse | null = null;
        try {
          me = await apiGetMe();
        } catch {
          if (!res.requiresProfileCompletion) {
            setProfileName("");
            setProfileNickname("");
            setError("Не удалось проверить профиль — укажите имя и ник для продолжения.");
            setPendingProfileSetup();
            enterProfileSetupSync();
            return;
          }
          me = null;
        }

        const needsProfile = Boolean(res.requiresProfileCompletion) || !me?.displayName?.trim();

        if (needsProfile) {
          setProfileName("");
          setProfileNickname("");
          setPendingProfileSetup();
          enterProfileSetupSync();
          return;
        }

        clearPendingProfileSetup();

        if (me?.userUuid && password.trim()) {
          try {
            const backup = await provisionFscpBackupAfterAuth(me.userUuid, password);
            if (!backup.ok && typeof console !== "undefined") {
              console.warn("[fscp] login backup not uploaded", backup.reason);
            }
          } catch (syncErr) {
            if (typeof console !== "undefined") {
              console.warn("[fscp] login sync failed", syncErr);
            }
          }
        }

        router.push("/feed");
        router.refresh();
        return;
      }

      if (mode === "register") {
        const registration = await apiRegister(email.trim(), password);
        setVerificationToken(registration.verificationToken);
        setVerificationCode(registration.devVerificationCode ?? "");
        setDevVerificationHint(registration.devVerificationCode ?? null);
        switchMode("verify");
        return;
      }

      const res = await apiVerifyRegistration(verificationToken, verificationCode.trim());
      saveSession(res);
      setVerificationToken("");
      setProfileName("");
      setProfileNickname("");
      setPendingProfileSetup();

      // Create keys + server backup while the registration password is still in form state.
      if (password.trim()) {
        try {
          const me = await apiGetMe();
          if (me?.userUuid) {
            const backup = await provisionFscpBackupAfterAuth(me.userUuid, password);
            if (!backup.ok && typeof console !== "undefined") {
              console.warn("[fscp] registration backup not uploaded after verify", backup.reason);
            }
          }
        } catch (syncErr) {
          if (typeof console !== "undefined") {
            console.warn("[fscp] registration sync after verify failed", syncErr);
          }
        }
      }

      enterProfileSetupSync();
      return;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Неизвестная ошибка");
    } finally {
      setLoading(false);
    }
  }

  async function onProfileSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const displayName = profileName.trim();
    const username = profileNickname.trim().replace(/^@+/, "");
    if (!displayName) {
      setError("Введите имя");
      return;
    }
    if (!/^[a-zA-Z0-9_]{3,50}$/.test(username)) {
      setError("Никнейм: латиница, цифры и _, от 3 до 50 символов");
      return;
    }
    if (isReservedUsername(username)) {
      setError(RESERVED_USERNAME_MESSAGE);
      return;
    }

    setLoading(true);
    try {
      await apiUpdateProfile({ displayName, username });
      clearPendingProfileSetup();

      // Provision the FSCP identity backup at registration so other devices can restore
      // automatically. Password is still in form state and was proven at register/verify.
      if (password.trim()) {
        try {
          const me = await apiGetMe();
          if (me?.userUuid) {
            const backup = await provisionFscpBackupAfterAuth(me.userUuid, password);
            if (!backup.ok && typeof console !== "undefined") {
              console.warn("[fscp] registration backup not uploaded after profile", backup.reason);
            }
          }
        } catch (syncErr) {
          if (typeof console !== "undefined") {
            console.warn("[fscp] registration backup failed", syncErr);
          }
        }
      }

      router.push("/feed");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Неизвестная ошибка");
    } finally {
      setLoading(false);
    }
  }

  async function cancelPendingVerification() {
    if (!verificationToken) return;
    try {
      await apiCancelRegistration(verificationToken);
    } catch {
      // ignore cancel errors on navigation/unload paths
    } finally {
      setVerificationToken("");
    }
  }

  function switchMode(nextMode: FormMode) {
    if (nextMode === mode && modeAnim === "none") return;
    if (mode === "verify" && nextMode !== "verify" && nextMode !== "profileSetup") {
      void cancelPendingVerification();
      setVerificationCode("");
      setDevVerificationHint(null);
    }

    if (mode === "login" && nextMode !== "login") {
      setAwaitingTwoFactor(false);
      setTwoFactorCode("");
    }

    if (exitTimerRef.current !== null) {
      window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    if (enterTimerRef.current !== null) {
      window.clearTimeout(enterTimerRef.current);
      enterTimerRef.current = null;
    }

    const token = ++transitionTokenRef.current;
    const modeOrder: Record<FormMode, number> = { login: 0, register: 1, verify: 2, profileSetup: 3 };
    const goLeft = modeOrder[nextMode] > modeOrder[mode];
    setModeAnim(goLeft ? "exitToLeft" : "exitToRight");

    exitTimerRef.current = window.setTimeout(() => {
      if (token !== transitionTokenRef.current) return;
      setMode(nextMode);
      setModeAnim(goLeft ? "enterFromRight" : "enterFromLeft");
      enterTimerRef.current = window.setTimeout(() => {
        if (token !== transitionTokenRef.current) return;
        setModeAnim("none");
      }, 850);
    }, 150);
  }

  function backFromProfileToLogin() {
    clearSession();
    clearPendingProfileSetup();
    setProfileName("");
    setProfileNickname("");
    setError(null);
    switchMode("login");
    router.refresh();
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!getAccessToken() || !hasPendingProfileSetup()) return;
    if (mode === "profileSetup" || mode === "verify" || mode === "register") return;

    let cancelled = false;
    void (async () => {
      try {
        const me = await apiGetMe();
        if (cancelled) return;
        if (me.displayName?.trim()) {
          clearPendingProfileSetup();
          return;
        }
        setProfileName("");
        setProfileNickname("");
      } catch {
        if (cancelled) return;
        setProfileName("");
        setProfileNickname("");
      }
      if (cancelled) return;
      enterProfileSetupSync();
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, enterProfileSetupSync]);

  useEffect(() => {
    return () => {
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
      }
      if (enterTimerRef.current !== null) {
        window.clearTimeout(enterTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const onBeforeUnload = () => {
      if (!verificationToken) return;
      void fetch(authPublicFetchUrl("/api/auth/cancel-registration"), {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verificationToken })
      });
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      if (mode === "verify" && verificationToken) {
        void apiCancelRegistration(verificationToken);
      }
    };
  }, [mode, verificationToken]);

  const twoFactorField = mode === "login" && awaitingTwoFactor;

  return (
    <main
      className={`${styles.page} ${mode === "register" ? styles.registerMode : ""} ${mode === "verify" ? styles.verifyMode : ""} ${mode === "profileSetup" ? styles.profileSetupMode : ""} ${
        modeAnim === "exitToLeft"
          ? styles.modeExitLeft
          : modeAnim === "enterFromRight"
            ? styles.modeEnterLeft
            : modeAnim === "exitToRight"
              ? styles.modeExitRight
              : modeAnim === "enterFromLeft"
                ? styles.modeEnterRight
                : ""
      }`}
    >
      <GridOverlay />
      {DEV_AUTO_AUTH_ENABLED ? (
        <button type="button" className={styles.devBypassButton} onClick={loginWithoutAuthorization}>
          Войти без авторизации
        </button>
      ) : null}
      <div className={styles.logoRow} aria-label="FLORA ID">
        {"FLORA".split("").map((ch, i) => (
          <span key={`flora-title-${i}`} className={styles.logoLetter}>
            {ch}
          </span>
        ))}
        {"ID".split("").map((ch, i) => (
          <span key={`id-title-${i}`} className={styles.logoLetter} style={i === 0 ? { marginLeft: 27 } : undefined}>
            {ch}
          </span>
        ))}
      </div>

      {loading ? (
        <div className={styles.busyOverlay} aria-busy="true">
          <div className={styles.busyDot} />
        </div>
      ) : null}

      <div
        ref={innerRef}
        className={`${styles.inner} ${gridBinding.panel !== "none" ? styles.snapBound : ""}`}
        style={gridBinding.panel !== "none" && panelSnapPosition ? { left: panelSnapPosition.left, top: panelSnapPosition.top } : undefined}
      >
        <form
          ref={formRef}
          className={styles.formStack}
          style={offsets.form ? { transform: `translate(${offsets.form.x}px, ${offsets.form.y}px)` } : undefined}
          onSubmit={mode === "profileSetup" ? onProfileSubmit : onSubmit}
          autoComplete="off"
          noValidate
        >
          <div className={styles.fieldBlock}>
            <div className={styles.fieldRow}>
              <div className={`${styles.iconCell} ${styles.emailIconCell}`}>
                {mode === "profileSetup" ? <IconUser /> : <IconEnvelope />}
              </div>
              <div className={styles.fieldInputWrap}>
                <input
                  id={mode === "profileSetup" ? profileNameId : emailId}
                  type="text"
                  autoComplete="off"
                  className={styles.fieldInput}
                  placeholder={mode === "profileSetup" ? "Имя" : "Email"}
                  value={mode === "profileSetup" ? profileName : email}
                  onChange={(e) => (mode === "profileSetup" ? setProfileName(e.target.value) : setEmail(e.target.value))}
                  onFocus={() => (mode === "profileSetup" ? setFocusProfileName(true) : setFocusEmail(true))}
                  onBlur={() => (mode === "profileSetup" ? setFocusProfileName(false) : setFocusEmail(false))}
                />
              </div>
            </div>
            <div className={`${styles.underlineTrack} ${styles.emailUnderlineTrack}`}>
              <span className={`${styles.underlineActive} ${focusEmail || focusProfileName ? styles.on : ""}`} />
            </div>
          </div>

          <div className={styles.fieldBlock}>
            <div className={styles.fieldRow}>
              <div className={`${styles.iconCell} ${styles.passwordIconCell}`}>
                {mode === "profileSetup" ? <IconAt /> : <IconLock />}
              </div>
              <div className={styles.fieldInputWrap}>
                <input
                  id={mode === "profileSetup" ? profileNicknameId : passwordId}
                  type={twoFactorField || mode === "verify" || mode === "profileSetup" ? "text" : showPassword ? "text" : "password"}
                  inputMode={twoFactorField || mode === "verify" ? "numeric" : undefined}
                  autoComplete={twoFactorField || mode === "verify" ? "one-time-code" : mode === "profileSetup" ? "off" : "new-password"}
                  className={styles.fieldInput}
                  placeholder={twoFactorField ? "Код 2FA из приложения" : mode === "verify" ? "Код из сообщения" : mode === "profileSetup" ? "Никнейм" : "Пароль"}
                  value={twoFactorField ? twoFactorCode : mode === "verify" ? verificationCode : mode === "profileSetup" ? profileNickname : password}
                  onChange={(e) => {
                    if (twoFactorField) {
                      setTwoFactorCode(e.target.value);
                      return;
                    }
                    if (mode === "verify") {
                      setVerificationCode(e.target.value);
                      return;
                    }
                    if (mode === "profileSetup") {
                      setProfileNickname(e.target.value.replace(/^@+/, ""));
                      return;
                    }
                    setPassword(e.target.value);
                  }}
                  onFocus={() =>
                    mode === "verify"
                      ? setFocusVerificationCode(true)
                      : mode === "profileSetup"
                        ? setFocusProfileNickname(true)
                        : setFocusPassword(true)
                  }
                  onBlur={() =>
                    mode === "verify"
                      ? setFocusVerificationCode(false)
                      : mode === "profileSetup"
                        ? setFocusProfileNickname(false)
                        : setFocusPassword(false)
                  }
                />
                {mode !== "verify" && mode !== "profileSetup" && !twoFactorField ? (
                  <button
                    type="button"
                    className={`${styles.passwordToggle} ${password ? styles.visible : ""}`}
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"}
                  >
                    {showPassword ? <IconEyeOpen /> : <IconEyeOff />}
                  </button>
                ) : null}
              </div>
            </div>
            <div className={`${styles.underlineTrack} ${styles.passwordUnderlineTrack}`}>
              <span className={`${styles.underlineActive} ${focusPassword || focusVerificationCode || focusProfileNickname ? styles.on : ""}`} />
            </div>
          </div>

          {mode === "register" ? (
            <div className={styles.fieldBlock}>
              <div className={styles.fieldRow}>
                <div className={`${styles.iconCell} ${styles.confirmPasswordIconCell}`}>
                  <IconLock />
                </div>
                <div className={styles.fieldInputWrap}>
                  <input
                    type="password"
                    autoComplete="new-password"
                    className={styles.fieldInput}
                    placeholder="Подтверждение пароля"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    onFocus={() => setFocusConfirmPassword(true)}
                    onBlur={() => setFocusConfirmPassword(false)}
                  />
                </div>
              </div>
              <div className={`${styles.underlineTrack} ${styles.confirmPasswordUnderlineTrack}`}>
                <span className={`${styles.underlineActive} ${focusConfirmPassword ? styles.on : ""}`} />
              </div>
            </div>
          ) : null}

          {devVerificationHint && mode === "verify" ? (
            <p className={styles.devVerificationHint} role="status">
              Локальная разработка: код подтверждения <strong>{devVerificationHint}</strong> (SMTP не настроен).
            </p>
          ) : null}

          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}

          <button type="submit" className={`${styles.submit} ${styles.submitGrid}`} disabled={loading}>
            {mode === "login" ? (awaitingTwoFactor ? "Подтвердить" : "Войти") : mode === "register" ? "Создать аккаунт" : mode === "verify" ? "Подтвердить" : "Продолжить"}
          </button>
        </form>

        <div className={styles.links}>
          {mode === "login" ? (
            <>
              <button type="button" className={styles.linkMuted} onClick={() => { switchMode("register"); setError(null); }}>
                У меня нет аккаунта
              </button>
              <span className={styles.linkMuted} aria-hidden>
                →
              </span>
              <button type="button" className={styles.linkAccent} onClick={() => { switchMode("register"); setError(null); }}>
                Создать
              </button>
            </>
          ) : mode === "register" ? (
            <>
              <button type="button" className={styles.linkMuted} onClick={() => { switchMode("login"); setError(null); }}>
                Уже есть аккаунт
              </button>
              <span className={styles.linkMuted} aria-hidden>
                →
              </span>
              <button type="button" className={styles.linkAccent} onClick={() => { switchMode("login"); setError(null); }}>
                Войти
              </button>
            </>
          ) : mode === "verify" ? (
            <>
              <button type="button" className={styles.linkMuted} onClick={() => { switchMode("register"); setError(null); }}>
                Неверный email
              </button>
              <span className={styles.linkMuted} aria-hidden>
                →
              </span>
              <button type="button" className={styles.linkAccent} onClick={() => { switchMode("login"); setError(null); }}>
                На вход
              </button>
            </>
          ) : (
            <button type="button" className={styles.backToLoginFooter} onClick={backFromProfileToLogin} aria-label="Назад к аутентификации">
              <span className={styles.backToLoginLabel}>Назад к аутентификации</span>
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
