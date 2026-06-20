"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useCurrentUser } from "@/app/_dashboard/CurrentUserContext";
import { FloraAvatar } from "@/app/_shared/FloraAvatar";
import {
  ApiRequestError,
  apiDeleteAvatar,
  apiLogout,
  apiUploadAvatar,
} from "@/lib/auth";
import { BirthDateInput } from "./BirthDateInput";
import { useSettings } from "./SettingsContext";
import styles from "./settings.module.css";

export function SettingsAccountTab() {
  const router = useRouter();
  const { me, loading, refresh } = useCurrentUser();
  const { ready, draft, updateAccount, clearSaveFeedback } = useSettings();
  const fileInputId = useId();

  const [avatarUuid, setAvatarUuid] = useState("");
  const [avatarVersion, setAvatarVersion] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [avatarSuccess, setAvatarSuccess] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);

  useEffect(() => {
    setAvatarUuid(me?.avatarUuid?.trim() ?? "");
  }, [me?.avatarUuid]);

  const resetAvatarFeedback = useCallback(() => {
    setAvatarError(null);
    setAvatarSuccess(null);
  }, []);

  const onPickAvatar = useCallback(() => {
    document.getElementById(fileInputId)?.click();
  }, [fileInputId]);

  const onAvatarSelected = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      resetAvatarFeedback();
      setAvatarBusy(true);
      try {
        const nextUuid = await apiUploadAvatar(file);
        setAvatarUuid(nextUuid);
        setAvatarVersion((v) => v + 1);
        await refresh();
        setAvatarSuccess("Аватар обновлён.");
      } catch (e) {
        setAvatarError(e instanceof ApiRequestError || e instanceof Error ? e.message : "Не удалось загрузить аватар.");
      } finally {
        setAvatarBusy(false);
      }
    },
    [refresh, resetAvatarFeedback],
  );

  const onLogout = useCallback(async () => {
    setSessionError(null);
    setLoggingOut(true);
    try {
      await apiLogout();
      router.replace("/login");
      router.refresh();
    } catch (e) {
      setSessionError(e instanceof ApiRequestError || e instanceof Error ? e.message : "Не удалось выйти из аккаунта.");
      setLoggingOut(false);
    }
  }, [router]);

  const onDeleteAvatar = useCallback(async () => {
    if (!avatarUuid) return;
    resetAvatarFeedback();
    setAvatarBusy(true);
    try {
      await apiDeleteAvatar();
      setAvatarUuid("");
      setAvatarVersion((v) => v + 1);
      await refresh();
      setAvatarSuccess("Аватар удалён.");
    } catch (e) {
      setAvatarError(e instanceof ApiRequestError || e instanceof Error ? e.message : "Не удалось удалить аватар.");
    } finally {
      setAvatarBusy(false);
    }
  }, [avatarUuid, refresh, resetAvatarFeedback]);

  const { displayName, username, birthDate, status } = draft.account;

  if ((loading && !me) || !ready) {
    return (
      <div className={styles.tabContent}>
        <p className={styles.formHint}>Загрузка профиля…</p>
      </div>
    );
  }

  return (
    <div className={styles.tabContent}>
      <div className={styles.formSection}>
        <h3 className={styles.formSectionTitle}>Аватар</h3>
        <div className={styles.avatarBlock}>
          <FloraAvatar
            size={105}
            avatarUuid={avatarUuid || null}
            displayName={displayName}
            username={username}
            seed={me?.userUuid ?? username}
            cacheVersion={avatarVersion}
            className={styles.avatarCircle}
          />
          <div className={styles.avatarActions}>
            <input
              id={fileInputId}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className={styles.visuallyHidden}
              disabled={avatarBusy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                void onAvatarSelected(file);
              }}
            />
            <button type="button" className={styles.btnMain} disabled={avatarBusy} onClick={onPickAvatar}>
              {avatarBusy ? "Загрузка…" : "Изменить аватар"}
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnGhost}`}
              disabled={avatarBusy || !avatarUuid}
              onClick={() => void onDeleteAvatar()}
            >
              Удалить аватар
            </button>
          </div>
        </div>
        {avatarError ? (
          <p className={styles.formFeedbackError} role="alert">
            {avatarError}
          </p>
        ) : null}
        {avatarSuccess ? (
          <p className={styles.formFeedbackSuccess} role="status">
            {avatarSuccess}
          </p>
        ) : null}
      </div>

      <div className={styles.formSection}>
        <h3 className={styles.formSectionTitle}>Личная информация</h3>
        <div className={styles.formRow}>
          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor="settings-display-name">
              Имя
            </label>
            <input
              id="settings-display-name"
              type="text"
              className={styles.input}
              value={displayName}
              onChange={(e) => {
                clearSaveFeedback();
                updateAccount({ displayName: e.target.value });
              }}
              autoComplete="name"
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor="settings-username">
              Никнейм
            </label>
            <input
              id="settings-username"
              type="text"
              className={styles.input}
              value={username}
              onChange={(e) => {
                clearSaveFeedback();
                updateAccount({ username: e.target.value.replace(/^@+/, "") });
              }}
              autoComplete="username"
              spellCheck={false}
            />
          </div>
        </div>
        <div className={styles.formRow}>
          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor="settings-birth-date">
              Дата рождения
            </label>
            <BirthDateInput
              id="settings-birth-date"
              value={birthDate}
              onChange={(next) => {
                clearSaveFeedback();
                updateAccount({ birthDate: next });
              }}
            />
          </div>
        </div>
        <div className={styles.formGroup}>
          <label className={styles.label} htmlFor="settings-status">
            Описание
          </label>
          <textarea
            id="settings-status"
            className={styles.textarea}
            value={status}
            onChange={(e) => {
              clearSaveFeedback();
              updateAccount({ status: e.target.value });
            }}
            rows={4}
          />
        </div>
      </div>

      <div className={styles.formSection}>
        <h3 className={styles.formSectionTitle}>Сессия</h3>
        {sessionError ? (
          <p className={styles.formFeedbackError} role="alert">
            {sessionError}
          </p>
        ) : null}
        <div className={styles.listCard}>
          <div className={styles.listCardInfo}>
            <p className={styles.listCardTitle}>Выйти из аккаунта</p>
            <p className={styles.listCardDesc}>Завершить текущую сессию на этом устройстве</p>
          </div>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnDanger}`}
            disabled={loggingOut}
            onClick={() => void onLogout()}
          >
            {loggingOut ? "Выход…" : "Выйти"}
          </button>
        </div>
      </div>
    </div>
  );
}
