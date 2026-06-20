"use client";

import { useCallback, useEffect, useId, useState } from "react";
import {
  ApiRequestError,
  apiBeginTwoFactorSetup,
  apiDisableTwoFactor,
  apiEnableTwoFactor,
} from "@/lib/auth";
import styles from "./settings.module.css";

type SettingsSecurity2FAModalProps = {
  open: boolean;
  closing: boolean;
  enabled: boolean;
  onClose: () => void;
  onChanged: () => void;
};

export function SettingsSecurity2FAModal({
  open,
  closing,
  enabled,
  onClose,
  onChanged,
}: SettingsSecurity2FAModalProps) {
  const titleId = useId();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [secret, setSecret] = useState("");
  const [otpAuthUri, setOtpAuthUri] = useState("");
  const [step, setStep] = useState<"idle" | "setup" | "confirm">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const reset = useCallback(() => {
    setPassword("");
    setCode("");
    setSecret("");
    setOtpAuthUri("");
    setStep("idle");
    setError(null);
    setSuccess(null);
    setBusy(false);
  }, []);

  useEffect(() => {
    if (!open) reset();
    else if (enabled) setStep("idle");
  }, [open, enabled, reset]);

  const onBeginSetup = async () => {
    setError(null);
    setSuccess(null);
    setBusy(true);
    try {
      const result = await apiBeginTwoFactorSetup(password);
      setSecret(result.secret);
      setOtpAuthUri(result.otpAuthUri);
      setStep("confirm");
    } catch (e) {
      setError(e instanceof ApiRequestError || e instanceof Error ? e.message : "Не удалось начать настройку 2FA.");
    } finally {
      setBusy(false);
    }
  };

  const onEnable = async () => {
    setError(null);
    setSuccess(null);
    setBusy(true);
    try {
      await apiEnableTwoFactor(code);
      setSuccess("2FA включена.");
      onChanged();
      setTimeout(() => onClose(), 800);
    } catch (e) {
      setError(e instanceof ApiRequestError || e instanceof Error ? e.message : "Не удалось включить 2FA.");
    } finally {
      setBusy(false);
    }
  };

  const onDisable = async () => {
    setError(null);
    setSuccess(null);
    setBusy(true);
    try {
      await apiDisableTwoFactor(password, code);
      setSuccess("2FA отключена.");
      onChanged();
      setTimeout(() => onClose(), 800);
    } catch (e) {
      setError(e instanceof ApiRequestError || e instanceof Error ? e.message : "Не удалось отключить 2FA.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <>
      <button
        type="button"
        className={`${styles.settingsConfirmModalBackdrop}${closing ? ` ${styles.settingsConfirmModalBackdropClosing}` : ""}`}
        aria-label="Закрыть"
        onClick={onClose}
      />
      <div className={styles.settingsConfirmModal} role="presentation">
        <div
          className={`${styles.settingsConfirmModalDialog}${closing ? ` ${styles.settingsConfirmModalDialogClosing}` : ""}`}
          role="dialog"
          aria-modal
          aria-labelledby={titleId}
        >
          <div className={styles.settingsConfirmModalHeader}>
            <h2 id={titleId} className={styles.settingsConfirmModalTitle}>
              Двухфакторная аутентификация
            </h2>
            <button type="button" className={styles.settingsConfirmModalClose} aria-label="Закрыть" onClick={onClose}>
              ×
            </button>
          </div>
          <div className={styles.settingsConfirmModalBody}>
            {enabled ? (
              <>
                <p className={styles.settingsConfirmModalText}>
                  Для отключения 2FA введите пароль и текущий код из приложения-аутентификатора.
                </p>
                <div className={styles.securityPasswordForm}>
                  <input
                    type="password"
                    className={styles.input}
                    placeholder="Пароль"
                    value={password}
                    disabled={busy}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                  />
                  <input
                    type="text"
                    className={styles.input}
                    placeholder="Код из приложения"
                    value={code}
                    disabled={busy}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                  />
                </div>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnDanger}`}
                  disabled={busy}
                  onClick={() => void onDisable()}
                >
                  {busy ? "Отключение…" : "Отключить 2FA"}
                </button>
              </>
            ) : step === "confirm" ? (
              <>
                <p className={styles.settingsConfirmModalText}>
                  Добавьте ключ в Google Authenticator, 1Password или другое TOTP-приложение. Секрет:
                </p>
                <p className={styles.securityMonospaceBlock}>{secret}</p>
                {otpAuthUri ? (
                  <p className={styles.listCardDesc} style={{ wordBreak: "break-all" }}>
                    {otpAuthUri}
                  </p>
                ) : null}
                <input
                  type="text"
                  className={styles.input}
                  placeholder="Код из приложения"
                  value={code}
                  disabled={busy}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                />
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  disabled={busy || code.length < 6}
                  onClick={() => void onEnable()}
                >
                  {busy ? "Проверка…" : "Подтвердить и включить"}
                </button>
              </>
            ) : (
              <>
                <p className={styles.settingsConfirmModalText}>
                  Подключите приложение-аутентификатор. Для начала настройки введите пароль.
                </p>
                <input
                  type="password"
                  className={styles.input}
                  placeholder="Пароль"
                  value={password}
                  disabled={busy}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  disabled={busy || !password.trim()}
                  onClick={() => void onBeginSetup()}
                >
                  {busy ? "Подготовка…" : "Продолжить"}
                </button>
              </>
            )}
            {error ? (
              <p className={styles.formFeedbackError} role="alert">
                {error}
              </p>
            ) : null}
            {success ? (
              <p className={styles.formFeedbackSuccess} role="status">
                {success}
              </p>
            ) : null}
          </div>
          <div className={styles.settingsConfirmModalActions}>
            <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onClose}>
              Закрыть
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
