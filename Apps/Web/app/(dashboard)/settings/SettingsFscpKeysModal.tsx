"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { useCurrentUser } from "@/app/_dashboard/CurrentUserContext";
import { ApiRequestError } from "@/lib/auth";
import {
  clearFscpMaterialForUser,
} from "@/lib/fscp";
import { webEnsureKeyBackupOnServer } from "@/lib/fscp/ensureBackup";
import { msgGetE2EState, msgGetKeyBackup, msgGetRecoveryBackups } from "@/lib/messagingApi";
import styles from "./settings.module.css";

type SettingsFscpKeysModalProps = {
  open: boolean;
  closing: boolean;
  onClose: () => void;
};

function readBackupRevision(raw: unknown): number {
  if (!raw || typeof raw !== "object") return 0;
  const o = raw as Record<string, unknown>;
  const v = o.backupRevision ?? o.BackupRevision;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function SettingsFscpKeysModal({ open, closing, onClose }: SettingsFscpKeysModalProps) {
  const titleId = useId();
  const { me, fscpMaterial, fscpBootstrapLoading, fscpBootstrapError, refresh } = useCurrentUser();
  const [e2eState, setE2eState] = useState("");
  const [hasPasswordBackup, setHasPasswordBackup] = useState(false);
  const [backupRevision, setBackupRevision] = useState(0);
  const [recoveryCount, setRecoveryCount] = useState(0);
  const [backupPassword, setBackupPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [state, backup, recoveries] = await Promise.all([
        msgGetE2EState(),
        msgGetKeyBackup().catch(() => null),
        msgGetRecoveryBackups(),
      ]);
      setE2eState(state.state);
      setHasPasswordBackup(backup != null);
      setBackupRevision(readBackupRevision(backup));
      setRecoveryCount(recoveries.length);
    } catch {
      setE2eState("unknown");
      setHasPasswordBackup(false);
      setBackupRevision(0);
      setRecoveryCount(0);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      setBackupPassword("");
      setError(null);
      setSuccess(null);
      return;
    }
    void load();
  }, [open, load]);

  const onUploadPasswordBackup = async () => {
    if (!me?.userUuid || !fscpMaterial) {
      setError("Ключи FSCP ещё не готовы.");
      return;
    }
    if (!backupPassword.trim()) {
      setError("Введите пароль для шифрования резервной копии.");
      return;
    }
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await webEnsureKeyBackupOnServer(me.userUuid, backupPassword, fscpMaterial);
      if (result.uploaded) {
        setSuccess("Резервная копия по паролю загружена на сервер.");
        setBackupPassword("");
        await load();
      } else if (result.skippedReason === "unchanged") {
        setSuccess("Резервная копия уже актуальна.");
        setBackupPassword("");
      } else if (result.skippedReason === "conflict") {
        setError("Конфликт epoch identity на сервере. Войдите с паролем заново.");
      } else {
        setError(`Не удалось обновить backup (${result.skippedReason ?? "unknown"}).`);
      }
    } catch (e) {
      setError(
        e instanceof ApiRequestError || e instanceof Error
          ? e.message
          : "Не удалось загрузить резервную копию ключей.",
      );
    } finally {
      setBusy(false);
    }
  };

  const onClearLocalKeys = () => {
    if (!me?.userUuid) return;
    const ok = window.confirm(
      "Удалить ключи FSCP с этого устройства? История сообщений здесь перестанет расшифровываться до повторной настройки.",
    );
    if (!ok) return;
    clearFscpMaterialForUser(me.userUuid);
    setSuccess("Локальные ключи удалены. Перезагрузите страницу для повторной инициализации.");
    void refresh();
  };

  if (!open) return null;

  const deviceUuid = fscpMaterial?.deviceUuidFromServer ?? "—";

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
              Ключи сообщений FSCP
            </h2>
            <button type="button" className={styles.settingsConfirmModalClose} aria-label="Закрыть" onClick={onClose}>
              ×
            </button>
          </div>
          <div className={styles.settingsConfirmModalBody}>
            <div className={styles.listCard}>
              <div className={styles.listCardInfo}>
                <p className={styles.listCardTitle}>Состояние E2E</p>
                <p className={styles.listCardDesc}>{e2eState || "—"}</p>
              </div>
            </div>
            <div className={styles.listCard}>
              <div className={styles.listCardInfo}>
                <p className={styles.listCardTitle}>Устройство</p>
                <p className={styles.listCardDesc}>{deviceUuid}</p>
              </div>
            </div>
            <div className={styles.listCard}>
              <div className={styles.listCardInfo}>
                <p className={styles.listCardTitle}>Резервные копии</p>
                <p className={styles.listCardDesc}>
                  По паролю: {hasPasswordBackup ? `ревизия ${backupRevision}` : "нет"} · По ключ-фразе: {recoveryCount}
                </p>
              </div>
            </div>
            {fscpBootstrapLoading ? <p className={styles.formHint}>Инициализация ключей…</p> : null}
            {fscpBootstrapError ? (
              <p className={styles.formFeedbackError} role="alert">
                {fscpBootstrapError}
              </p>
            ) : null}
            <p className={styles.settingsConfirmModalText}>
              Загрузите на сервер резервную копию ключей паролем аккаунта — это нужно для мобильного приложения.
            </p>
            <input
              type="password"
              className={styles.input}
              placeholder="Пароль аккаунта"
              value={backupPassword}
              disabled={busy || fscpBootstrapLoading || !fscpMaterial}
              onChange={(e) => setBackupPassword(e.target.value)}
              autoComplete="new-password"
            />
            <div className={styles.securityPasswordActions}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                disabled={busy || fscpBootstrapLoading || !fscpMaterial}
                onClick={() => void onUploadPasswordBackup()}
              >
                {busy ? "Загрузка…" : "Обновить backup сейчас"}
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnGhost}`}
                disabled={!me?.userUuid}
                onClick={onClearLocalKeys}
              >
                Удалить ключи с устройства
              </button>
            </div>
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
