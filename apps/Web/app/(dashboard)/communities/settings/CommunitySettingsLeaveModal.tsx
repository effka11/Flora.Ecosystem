"use client";

import { useEffect, useId } from "react";
import styles from "@/app/(dashboard)/settings/settings.module.css";

type CommunitySettingsLeaveModalProps = {
  open: boolean;
  closing: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: () => void;
  onDiscard: () => void;
};

export function CommunitySettingsLeaveModal({
  open,
  closing,
  busy,
  error,
  onClose,
  onSave,
  onDiscard,
}: CommunitySettingsLeaveModalProps) {
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose, open]);

  if (!open) return null;

  return (
    <>
      <div
        className={`${styles.settingsConfirmModalBackdrop}${closing ? ` ${styles.settingsConfirmModalBackdropClosing}` : ""}`}
        onClick={busy ? undefined : onClose}
      />
      <div className={styles.settingsConfirmModal} role="presentation">
        <div
          className={`${styles.settingsConfirmModalDialog}${closing ? ` ${styles.settingsConfirmModalDialogClosing}` : ""}`}
          role="alertdialog"
          aria-modal
          aria-labelledby={titleId}
          onClick={(e) => e.stopPropagation()}
        >
          <div className={styles.settingsConfirmModalHeader}>
            <h2 id={titleId} className={styles.settingsConfirmModalTitle}>
              Несохранённые изменения
            </h2>
            <button
              type="button"
              className={styles.settingsConfirmModalClose}
              onClick={onClose}
              disabled={busy}
              aria-label="Закрыть"
            >
              &times;
            </button>
          </div>
          <div className={styles.settingsConfirmModalBody}>
            <p className={styles.settingsConfirmModalText}>
              Есть несохранённые изменения в настройках сообщества. Сохранить их перед уходом?
            </p>
            {error ? (
              <p className={styles.formFeedbackError} role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <div className={styles.settingsConfirmModalActions}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              disabled={busy}
              onClick={onSave}
            >
              {busy ? "Сохранение…" : "Сохранить"}
            </button>
            <button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={busy} onClick={onDiscard}>
              Не сохранять
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
