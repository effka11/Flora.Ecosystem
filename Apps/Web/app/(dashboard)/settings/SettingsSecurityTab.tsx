"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useAnimatedModal } from "@/app/(dashboard)/communities/useAnimatedModal";
import { useCurrentUser } from "@/app/_dashboard/CurrentUserContext";
import {
  ApiRequestError,
  apiBeginEmailChange,
  apiChangePassword,
  apiChangePhone,
  apiConfirmEmailChange,
  apiDeleteAccount,
  apiGetSecurityStatus,
  apiGetSessions,
  apiRevokeOtherSessions,
  clearPendingProfileSetup,
  clearSession,
  type SessionDto,
} from "@/lib/auth";
import { clearFscpMaterialForUser } from "@/lib/fscp/keys";
import { SettingsFscpKeysModal } from "./SettingsFscpKeysModal";
import { SettingsRecoveryPhraseModal } from "./SettingsRecoveryPhraseModal";
import { SettingsSecurity2FAModal } from "./SettingsSecurity2FAModal";
import styles from "./settings.module.css";

function formatSessionDate(value: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatSessionLocation(session: SessionDto): string {
  const parts = [session.city, session.countryCode].filter(Boolean);
  if (parts.length > 0) return parts.join(", ");
  return session.ipAddress || "Неизвестно";
}

export function SettingsSecurityTab() {
  const router = useRouter();
  const { me, loading, refresh } = useCurrentUser();
  const currentPasswordId = useId();
  const newPasswordId = useId();
  const confirmPasswordId = useId();
  const deletePasswordId = useId();

  const twoFaModal = useAnimatedModal();
  const recoveryModal = useAnimatedModal();
  const fscpModal = useAnimatedModal();

  const email = me?.email?.trim() ?? "";
  const phone = me?.phone?.trim() ?? "";

  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
  const [emailVerified, setEmailVerified] = useState(false);
  const [phoneVerified, setPhoneVerified] = useState(false);

  const [emailFormOpen, setEmailFormOpen] = useState(false);
  const [emailStep, setEmailStep] = useState<"form" | "confirm">("form");
  const [newEmail, setNewEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [emailChangeToken, setEmailChangeToken] = useState("");
  const [emailConfirmCode, setEmailConfirmCode] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailSuccess, setEmailSuccess] = useState<string | null>(null);

  const [phoneFormOpen, setPhoneFormOpen] = useState(false);
  const [newPhone, setNewPhone] = useState("");
  const [phonePassword, setPhonePassword] = useState("");
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [phoneSuccess, setPhoneSuccess] = useState<string | null>(null);

  const [passwordFormOpen, setPasswordFormOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);

  const [sessions, setSessions] = useState<SessionDto[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);

  const [deleteFormOpen, setDeleteFormOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const loadSecurityMeta = useCallback(async () => {
    try {
      const status = await apiGetSecurityStatus();
      setTwoFactorEnabled(status.twoFactorEnabled);
      setEmailVerified(status.emailVerified);
      setPhoneVerified(status.phoneVerified);
    } catch {
      setTwoFactorEnabled(false);
    }
  }, []);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    setSessionsError(null);
    try {
      const rows = await apiGetSessions();
      setSessions(rows);
    } catch (e) {
      setSessions([]);
      setSessionsError(
        e instanceof ApiRequestError || e instanceof Error ? e.message : "Не удалось загрузить сессии.",
      );
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSecurityMeta();
    void loadSessions();
  }, [loadSecurityMeta, loadSessions]);

  const resetEmailForm = useCallback(() => {
    setNewEmail("");
    setEmailPassword("");
    setEmailChangeToken("");
    setEmailConfirmCode("");
    setEmailStep("form");
    setEmailError(null);
  }, []);

  const onToggleEmailForm = useCallback(() => {
    setEmailFormOpen((open) => {
      if (open) resetEmailForm();
      return !open;
    });
    setEmailSuccess(null);
  }, [resetEmailForm]);

  const onBeginEmailChange = useCallback(async () => {
    setEmailError(null);
    setEmailSuccess(null);
    if (!newEmail.trim()) {
      setEmailError("Укажите новый email.");
      return;
    }
    if (!emailPassword.trim()) {
      setEmailError("Укажите пароль.");
      return;
    }
    setEmailBusy(true);
    try {
      const result = await apiBeginEmailChange(emailPassword, newEmail.trim());
      setEmailChangeToken(result.changeToken);
      setEmailStep("confirm");
      const devHint = result.devVerificationCode ? ` Код для разработки: ${result.devVerificationCode}` : "";
      setEmailSuccess(`Код отправлен на ${newEmail.trim()}.${devHint}`);
    } catch (e) {
      setEmailError(
        e instanceof ApiRequestError || e instanceof Error ? e.message : "Не удалось начать смену email.",
      );
    } finally {
      setEmailBusy(false);
    }
  }, [emailPassword, newEmail]);

  const onConfirmEmailChange = useCallback(async () => {
    setEmailError(null);
    if (!emailConfirmCode.trim()) {
      setEmailError("Введите код из письма.");
      return;
    }
    setEmailBusy(true);
    try {
      await apiConfirmEmailChange(emailChangeToken, emailConfirmCode.trim());
      setEmailSuccess("Email обновлён.");
      setEmailFormOpen(false);
      resetEmailForm();
      await refresh();
      await loadSecurityMeta();
    } catch (e) {
      setEmailError(
        e instanceof ApiRequestError || e instanceof Error ? e.message : "Не удалось подтвердить смену email.",
      );
    } finally {
      setEmailBusy(false);
    }
  }, [emailChangeToken, emailConfirmCode, loadSecurityMeta, refresh, resetEmailForm]);

  const resetPhoneForm = useCallback(() => {
    setNewPhone("");
    setPhonePassword("");
    setPhoneError(null);
  }, []);

  const onTogglePhoneForm = useCallback(() => {
    setPhoneFormOpen((open) => {
      if (open) resetPhoneForm();
      return !open;
    });
    setPhoneSuccess(null);
  }, [resetPhoneForm]);

  const onSubmitPhone = useCallback(async () => {
    setPhoneError(null);
    setPhoneSuccess(null);
    if (!newPhone.trim()) {
      setPhoneError("Укажите номер телефона.");
      return;
    }
    if (!phonePassword.trim()) {
      setPhoneError("Укажите пароль.");
      return;
    }
    setPhoneBusy(true);
    try {
      await apiChangePhone(phonePassword, newPhone.trim());
      setPhoneSuccess("Номер обновлён. SMS-подтверждение будет добавлено позже.");
      setPhoneFormOpen(false);
      resetPhoneForm();
      await refresh();
      await loadSecurityMeta();
    } catch (e) {
      setPhoneError(
        e instanceof ApiRequestError || e instanceof Error ? e.message : "Не удалось сменить номер телефона.",
      );
    } finally {
      setPhoneBusy(false);
    }
  }, [loadSecurityMeta, newPhone, phonePassword, refresh, resetPhoneForm]);

  const resetPasswordForm = useCallback(() => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setPasswordError(null);
  }, []);

  const onTogglePasswordForm = useCallback(() => {
    setPasswordFormOpen((open) => {
      if (open) resetPasswordForm();
      return !open;
    });
    setPasswordSuccess(null);
  }, [resetPasswordForm]);

  const onSubmitPassword = useCallback(async () => {
    setPasswordError(null);
    setPasswordSuccess(null);
    if (!currentPassword.trim()) {
      setPasswordError("Укажите текущий пароль.");
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError("Новый пароль должен быть не короче 8 символов.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("Новый пароль и подтверждение не совпадают.");
      return;
    }
    setPasswordBusy(true);
    try {
      await apiChangePassword(currentPassword, newPassword);
      setPasswordSuccess("Пароль изменён.");
      setPasswordFormOpen(false);
      resetPasswordForm();
      await loadSessions();
    } catch (e) {
      setPasswordError(
        e instanceof ApiRequestError || e instanceof Error ? e.message : "Не удалось сменить пароль.",
      );
    } finally {
      setPasswordBusy(false);
    }
  }, [confirmPassword, currentPassword, loadSessions, newPassword, resetPasswordForm]);

  const onRevokeOthers = useCallback(async () => {
    setSessionsError(null);
    setRevokingOthers(true);
    try {
      await apiRevokeOtherSessions();
      await loadSessions();
    } catch (e) {
      setSessionsError(
        e instanceof ApiRequestError || e instanceof Error
          ? e.message
          : "Не удалось завершить другие сессии.",
      );
    } finally {
      setRevokingOthers(false);
    }
  }, [loadSessions]);

  const resetDeleteForm = useCallback(() => {
    setDeletePassword("");
    setDeleteConfirm(false);
    setDeleteError(null);
  }, []);

  const onToggleDeleteForm = useCallback(() => {
    setDeleteFormOpen((open) => {
      if (open) resetDeleteForm();
      return !open;
    });
  }, [resetDeleteForm]);

  const onDeleteAccount = useCallback(async () => {
    setDeleteError(null);
    if (!deletePassword.trim()) {
      setDeleteError("Введите пароль для подтверждения.");
      return;
    }
    if (!deleteConfirm) {
      setDeleteError("Подтвердите, что понимаете последствия удаления.");
      return;
    }
    const ownerUuid = me?.userUuid?.trim();
    setDeleteBusy(true);
    try {
      await apiDeleteAccount(deletePassword);
      if (ownerUuid) clearFscpMaterialForUser(ownerUuid);
      clearPendingProfileSetup();
      clearSession();
      router.replace("/login");
      router.refresh();
    } catch (e) {
      setDeleteError(
        e instanceof ApiRequestError || e instanceof Error ? e.message : "Не удалось удалить аккаунт.",
      );
      setDeleteBusy(false);
    }
  }, [deleteConfirm, deletePassword, me?.userUuid, router]);

  const otherSessionsCount = sessions.filter((session) => !session.isCurrent).length;

  return (
    <div className={styles.tabContent}>
      <div className={styles.formSection}>
        <h3 className={styles.formSectionTitle}>Данные для входа</h3>
        {loading && !me ? <p className={styles.formHint}>Загрузка…</p> : null}
        <div className={styles.formRow}>
          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor="settings-email">
              Email
              {emailVerified ? <span className={styles.securityVerifiedBadge}>подтверждён</span> : null}
            </label>
            {emailFormOpen ? (
              <div className={styles.securityPasswordForm}>
                {emailStep === "form" ? (
                  <>
                    <input
                      id="settings-email"
                      type="email"
                      className={styles.input}
                      value={newEmail}
                      onChange={(e) => setNewEmail(e.target.value)}
                      placeholder="Новый email"
                      disabled={emailBusy}
                      autoComplete="email"
                    />
                    <input
                      type="password"
                      className={styles.input}
                      value={emailPassword}
                      onChange={(e) => setEmailPassword(e.target.value)}
                      placeholder="Текущий пароль"
                      disabled={emailBusy}
                      autoComplete="current-password"
                    />
                    <div className={styles.securityPasswordActions}>
                      <button
                        type="button"
                        className={`${styles.btn} ${styles.btnPrimary}`}
                        disabled={emailBusy}
                        onClick={() => void onBeginEmailChange()}
                      >
                        {emailBusy ? "Отправка…" : "Отправить код"}
                      </button>
                      <button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={emailBusy} onClick={onToggleEmailForm}>
                        Отмена
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <input
                      type="text"
                      className={styles.input}
                      value={emailConfirmCode}
                      onChange={(e) => setEmailConfirmCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      placeholder="Код из письма"
                      disabled={emailBusy}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                    />
                    <div className={styles.securityPasswordActions}>
                      <button
                        type="button"
                        className={`${styles.btn} ${styles.btnPrimary}`}
                        disabled={emailBusy}
                        onClick={() => void onConfirmEmailChange()}
                      >
                        {emailBusy ? "Проверка…" : "Подтвердить"}
                      </button>
                      <button
                        type="button"
                        className={`${styles.btn} ${styles.btnGhost}`}
                        disabled={emailBusy}
                        onClick={() => setEmailStep("form")}
                      >
                        Назад
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className={styles.inlineFieldRow}>
                <input
                  id="settings-email"
                  type="email"
                  className={styles.input}
                  value={email}
                  placeholder="Не указан"
                  readOnly
                />
                <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onToggleEmailForm}>
                  Изменить
                </button>
              </div>
            )}
            {emailError ? (
              <p className={styles.formFeedbackError} role="alert">
                {emailError}
              </p>
            ) : null}
            {emailSuccess ? (
              <p className={styles.formFeedbackSuccess} role="status">
                {emailSuccess}
              </p>
            ) : null}
          </div>
          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor="settings-phone">
              Номер телефона
              {phoneVerified ? <span className={styles.securityVerifiedBadge}>подтверждён</span> : null}
            </label>
            {phoneFormOpen ? (
              <div className={styles.securityPasswordForm}>
                <input
                  id="settings-phone"
                  type="tel"
                  className={styles.input}
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                  placeholder="Новый номер"
                  disabled={phoneBusy}
                  autoComplete="tel"
                />
                <input
                  type="password"
                  className={styles.input}
                  value={phonePassword}
                  onChange={(e) => setPhonePassword(e.target.value)}
                  placeholder="Текущий пароль"
                  disabled={phoneBusy}
                  autoComplete="current-password"
                />
                <div className={styles.securityPasswordActions}>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    disabled={phoneBusy}
                    onClick={() => void onSubmitPhone()}
                  >
                    {phoneBusy ? "Сохранение…" : "Сохранить"}
                  </button>
                  <button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={phoneBusy} onClick={onTogglePhoneForm}>
                    Отмена
                  </button>
                </div>
              </div>
            ) : (
              <div className={styles.inlineFieldRow}>
                <input
                  id="settings-phone"
                  type="tel"
                  className={styles.input}
                  value={phone}
                  placeholder="Не указан"
                  readOnly
                />
                <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onTogglePhoneForm}>
                  Изменить
                </button>
              </div>
            )}
            {phoneError ? (
              <p className={styles.formFeedbackError} role="alert">
                {phoneError}
              </p>
            ) : null}
            {phoneSuccess ? (
              <p className={styles.formFeedbackSuccess} role="status">
                {phoneSuccess}
              </p>
            ) : null}
          </div>
        </div>
        <div className={styles.formRow}>
          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor={passwordFormOpen ? currentPasswordId : undefined}>
              Пароль
            </label>
            {passwordFormOpen ? (
              <div className={styles.securityPasswordForm}>
                <input
                  id={currentPasswordId}
                  type="password"
                  className={styles.input}
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="Текущий пароль"
                  autoComplete="current-password"
                  disabled={passwordBusy}
                />
                <input
                  id={newPasswordId}
                  type="password"
                  className={styles.input}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Новый пароль"
                  autoComplete="new-password"
                  disabled={passwordBusy}
                />
                <input
                  id={confirmPasswordId}
                  type="password"
                  className={styles.input}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Подтверждение нового пароля"
                  autoComplete="new-password"
                  disabled={passwordBusy}
                />
                <div className={styles.securityPasswordActions}>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    disabled={passwordBusy}
                    onClick={() => void onSubmitPassword()}
                  >
                    {passwordBusy ? "Сохранение…" : "Сохранить пароль"}
                  </button>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnGhost}`}
                    disabled={passwordBusy}
                    onClick={onTogglePasswordForm}
                  >
                    Отмена
                  </button>
                </div>
              </div>
            ) : (
              <div className={styles.inlineFieldRow}>
                <input type="password" className={styles.input} value="********" disabled readOnly />
                <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onTogglePasswordForm}>
                  Изменить
                </button>
              </div>
            )}
            {passwordError ? (
              <p className={styles.formFeedbackError} role="alert">
                {passwordError}
              </p>
            ) : null}
            {passwordSuccess ? (
              <p className={styles.formFeedbackSuccess} role="status">
                {passwordSuccess}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <div className={styles.formSection}>
        <h3 className={styles.formSectionTitle}>Защита и шифрование</h3>
        <div className={styles.listCard}>
          <div className={styles.listCardInfo}>
            <p className={styles.listCardTitle}>
              Двухфакторная аутентификация (2FA)
              {twoFactorEnabled ? <span className={styles.securitySessionCurrentBadge}>включена</span> : null}
            </p>
            <p className={styles.listCardDesc}>TOTP через приложение-аутентификатор</p>
          </div>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={twoFaModal.openModal}>
            {twoFactorEnabled ? "Управление" : "Включить"}
          </button>
        </div>
        <div className={styles.listCard}>
          <div className={styles.listCardInfo}>
            <p className={styles.listCardTitle}>Ключ-фраза</p>
            <p className={styles.listCardDesc}>
              12 слов для восстановления доступа к зашифрованным данным
            </p>
          </div>
          <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={recoveryModal.openModal}>
            Настроить
          </button>
        </div>
        <div className={styles.listCard}>
          <div className={styles.listCardInfo}>
            <p className={styles.listCardTitle}>Ключ сообщений FSCP</p>
            <p className={styles.listCardDesc}>Управление ключами сквозного шифрования (E2EE)</p>
          </div>
          <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={fscpModal.openModal}>
            Управление
          </button>
        </div>
      </div>

      <div className={styles.formSection}>
        <div className={styles.formSectionHeader}>
          <h3 className={styles.formSectionTitle}>Активные сессии</h3>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnDanger}`}
            disabled={revokingOthers || sessionsLoading || otherSessionsCount === 0}
            onClick={() => void onRevokeOthers()}
          >
            {revokingOthers ? "Завершение…" : "Завершить все другие"}
          </button>
        </div>
        {sessionsError ? (
          <p className={styles.formFeedbackError} role="alert">
            {sessionsError}
          </p>
        ) : null}
        {sessionsLoading ? <p className={styles.formHint}>Загрузка сессий…</p> : null}
        {!sessionsLoading && sessions.length === 0 ? (
          <p className={styles.formHint}>Активных сессий нет.</p>
        ) : null}
        {!sessionsLoading && sessions.length > 0 ? (
          <div className={styles.securitySessionsList}>
            {sessions.map((session) => (
              <div key={session.sessionId} className={styles.listCard}>
                <div className={styles.listCardInfo}>
                  <p className={styles.listCardTitle}>
                    {formatSessionLocation(session)}
                    {session.isCurrent ? (
                      <span className={styles.securitySessionCurrentBadge}>Текущая</span>
                    ) : null}
                  </p>
                  <p className={styles.listCardDesc}>
                    Последняя активность: {formatSessionDate(session.lastActivity)}
                  </p>
                  <p className={styles.listCardDesc}>
                    Создана: {formatSessionDate(session.createdAt)}
                    {session.ipAddress ? ` · IP ${session.ipAddress}` : ""}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className={styles.formSection}>
        <h3 className={styles.formSectionTitle}>Удаление аккаунта</h3>
        <div className={styles.listCard}>
          <div className={styles.listCardInfo}>
            <p className={styles.listCardTitle}>Безвозвратное удаление</p>
            <p className={styles.listCardDesc}>
              Аккаунт, профиль и сессии будут удалены с сервера. Это действие нельзя отменить.
            </p>
          </div>
          {!deleteFormOpen ? (
            <button type="button" className={`${styles.btn} ${styles.btnDanger}`} onClick={onToggleDeleteForm}>
              Удалить аккаунт
            </button>
          ) : null}
        </div>
        {deleteFormOpen ? (
          <div className={styles.securityPasswordForm}>
            <label className={styles.label} htmlFor={deletePasswordId}>
              Пароль
            </label>
            <input
              id={deletePasswordId}
              type="password"
              className={styles.input}
              value={deletePassword}
              onChange={(e) => setDeletePassword(e.target.value)}
              placeholder="Текущий пароль"
              autoComplete="current-password"
              disabled={deleteBusy}
            />
            <label className={styles.securityDeleteConfirm}>
              <input
                type="checkbox"
                checked={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.checked)}
                disabled={deleteBusy}
              />
              <span>Я понимаю, что аккаунт и данные будут удалены без возможности восстановления</span>
            </label>
            <div className={styles.securityPasswordActions}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnDanger}`}
                disabled={deleteBusy}
                onClick={() => void onDeleteAccount()}
              >
                {deleteBusy ? "Удаление…" : "Удалить навсегда"}
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnGhost}`}
                disabled={deleteBusy}
                onClick={onToggleDeleteForm}
              >
                Отмена
              </button>
            </div>
            {deleteError ? (
              <p className={styles.formFeedbackError} role="alert">
                {deleteError}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <SettingsSecurity2FAModal
        open={twoFaModal.open}
        closing={twoFaModal.closing}
        enabled={twoFactorEnabled}
        onClose={twoFaModal.closeModal}
        onChanged={() => void loadSecurityMeta()}
      />
      <SettingsRecoveryPhraseModal
        open={recoveryModal.open}
        closing={recoveryModal.closing}
        onClose={recoveryModal.closeModal}
      />
      <SettingsFscpKeysModal open={fscpModal.open} closing={fscpModal.closing} onClose={fscpModal.closeModal} />
    </div>
  );
}
