"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { useCurrentUser } from "@/app/_dashboard/CurrentUserContext";
import { ApiRequestError } from "@/lib/auth";
import {
  bootstrapPlaintextFromLocalMaterial,
  createRecoveryBackup,
  generateRecoveryPhrase,
  RECOVERY_WORDLIST_ID,
} from "@/lib/fscp";
import { msgGetRecoveryBackups, msgPutRecoveryBackup } from "@/lib/messagingApi";
import styles from "./settings.module.css";

type SettingsRecoveryPhraseModalProps = {
  open: boolean;
  closing: boolean;
  onClose: () => void;
};

export function SettingsRecoveryPhraseModal({ open, closing, onClose }: SettingsRecoveryPhraseModalProps) {
  const titleId = useId();
  const { me, fscpMaterial, fscpBootstrapLoading } = useCurrentUser();
  const [existingCount, setExistingCount] = useState(0);
  const [phrase, setPhrase] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const reset = useCallback(() => {
    setPhrase("");
    setConfirmed(false);
    setError(null);
    setSuccess(null);
    setBusy(false);
  }, []);

  const loadMeta = useCallback(async () => {
    try {
      const rows = await msgGetRecoveryBackups();
      setExistingCount(rows.length);
    } catch {
      setExistingCount(0);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    void loadMeta();
  }, [open, reset, loadMeta]);

  const onGenerate = () => {
    setError(null);
    setSuccess(null);
    setConfirmed(false);
    setPhrase(generateRecoveryPhrase());
  };

  const onSave = async () => {
    if (!me?.userUuid || !fscpMaterial) {
      setError("Ключи FSCP ещё не готовы. Откройте сообщения и повторите попытку.");
      return;
    }
    if (!phrase) {
      setError("Сначала сгенерируйте ключ-фразу.");
      return;
    }
    if (!confirmed) {
      setError("Подтвердите, что вы сохранили фразу в надёжном месте.");
      return;
    }

    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const plaintext = await bootstrapPlaintextFromLocalMaterial(
        fscpMaterial.agreementPrivateKey,
        fscpMaterial.signingPrivateKey,
      );
      const recoveryKeyId = crypto.randomUUID();
      const recoveryRevision = existingCount + 1;
      const payload = await createRecoveryBackup({
        userUuid: me.userUuid,
        recoveryPhrase: phrase,
        plaintext,
        recoveryRevision,
        epochSetRevision: 1,
        recoveryKeyId,
        wordlistId: RECOVERY_WORDLIST_ID,
      });
      await msgPutRecoveryBackup(payload);
      setSuccess("Ключ-фраза сохранена на сервере в зашифрованном виде.");
      await loadMeta();
      setPhrase("");
      setConfirmed(false);
    } catch (e) {
      setError(
        e instanceof ApiRequestError || e instanceof Error
          ? e.message
          : "Не удалось сохранить резервную копию с ключ-фразой.",
      );
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
              Ключ-фраза восстановления
            </h2>
            <button type="button" className={styles.settingsConfirmModalClose} aria-label="Закрыть" onClick={onClose}>
              ×
            </button>
          </div>
          <div className={styles.settingsConfirmModalBody}>
            <p className={styles.settingsConfirmModalText}>
              12 слов для восстановления доступа к зашифрованным сообщениям. Храните фразу отдельно от пароля.
              {existingCount > 0 ? ` На сервере уже ${existingCount} резервных копий.` : ""}
            </p>
            {fscpBootstrapLoading ? <p className={styles.formHint}>Инициализация ключей FSCP…</p> : null}
            {phrase ? (
              <p className={styles.securityMonospaceBlock} role="status">
                {phrase}
              </p>
            ) : null}
            <div className={styles.securityPasswordActions}>
              <button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={busy} onClick={onGenerate}>
                {phrase ? "Сгенерировать заново" : "Сгенерировать фразу"}
              </button>
              {phrase ? (
                <label className={styles.securityCheckboxRow}>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={busy}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  <span>Я записал(а) фразу в надёжном месте</span>
                </label>
              ) : null}
            </div>
            {phrase ? (
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                disabled={busy || !confirmed || fscpBootstrapLoading || !fscpMaterial}
                onClick={() => void onSave()}
              >
                {busy ? "Сохранение…" : "Сохранить на сервере"}
              </button>
            ) : null}
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
