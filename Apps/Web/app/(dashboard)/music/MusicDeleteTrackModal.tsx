"use client";

import { useEffect, useId } from "react";
import styles from "./music.module.css";

type MusicDeleteTrackModalProps = {
  open: boolean;
  closing: boolean;
  busy: boolean;
  error: string | null;
  trackTitle: string;
  removesFromPlatform: boolean;
  onClose: () => void;
  onConfirm: () => void;
};

export function MusicDeleteTrackModal({
  open,
  closing,
  busy,
  error,
  trackTitle,
  removesFromPlatform,
  onClose,
  onConfirm,
}: MusicDeleteTrackModalProps) {
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose, open]);

  if (!open) return null;

  const description = removesFromPlatform
    ? `Трек «${trackTitle}» будет удалён с публичной площадки и из вашей музыки. Это действие нельзя отменить.`
    : `Трек «${trackTitle}» будет удалён из вашей музыки. Это действие нельзя отменить.`;

  return (
    <>
      <div
        className={`${styles.musicDeleteModalBackdrop}${closing ? ` ${styles.musicDeleteModalBackdropClosing}` : ""}`}
        onClick={busy ? undefined : onClose}
        aria-hidden
      />
      <div className={styles.musicDeleteModal} role="presentation">
        <div
          className={`${styles.musicDeleteModalDialog}${closing ? ` ${styles.musicDeleteModalDialogClosing}` : ""}`}
          role="alertdialog"
          aria-modal
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          onClick={(e) => e.stopPropagation()}
        >
          <div className={styles.musicDeleteModalHeader}>
            <h2 id={titleId} className={styles.musicDeleteModalTitle}>
              Удалить трек?
            </h2>
            <button
              type="button"
              className={styles.musicDeleteModalClose}
              onClick={onClose}
              disabled={busy}
              aria-label="Закрыть"
            >
              &times;
            </button>
          </div>
          <div className={styles.musicDeleteModalBody}>
            <p id={descriptionId} className={styles.musicDeleteModalText}>
              {description}
            </p>
            {error ? (
              <p className={styles.musicDeleteModalError} role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <div className={styles.musicDeleteModalActions}>
            <button
              type="button"
              className={styles.musicDeleteModalBtnDanger}
              disabled={busy}
              onClick={onConfirm}
            >
              {busy ? "Удаление…" : "Удалить"}
            </button>
            <button
              type="button"
              className={styles.musicDeleteModalBtnCancel}
              disabled={busy}
              onClick={onClose}
            >
              Отмена
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
