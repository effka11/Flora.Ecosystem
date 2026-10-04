"use client";

import { useEffect, useId, useRef } from "react";
import styles from "./messages.module.css";

type MessagesDeleteConversationModalProps = {
  open: boolean;
  closing: boolean;
  busy: boolean;
  error: string | null;
  peerDisplayName: string;
  /** dm (default) vs group leave. */
  targetKind?: "dm" | "group";
  onClose: () => void;
  onConfirm: () => void;
};

export function MessagesDeleteConversationModal({
  open,
  closing,
  busy,
  error,
  peerDisplayName,
  targetKind = "dm",
  onClose,
  onConfirm,
}: MessagesDeleteConversationModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const isGroup = targetKind === "group";

  useEffect(() => {
    if (!open || closing) return;
    cancelRef.current?.focus();
  }, [closing, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose, open]);

  if (!open) return null;

  const name = peerDisplayName.trim() || (isGroup ? "этой группы" : "этим пользователем");

  return (
    <>
      <div
        className={`${styles.messagesDeleteModalBackdrop}${closing ? ` ${styles.messagesDeleteModalBackdropClosing}` : ""}`}
        onClick={busy ? undefined : onClose}
        aria-hidden
      />
      <div className={styles.messagesDeleteModal} role="presentation">
        <div
          className={`${styles.messagesDeleteModalDialog}${closing ? ` ${styles.messagesDeleteModalDialogClosing}` : ""}`}
          role="alertdialog"
          aria-modal
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          onClick={(e) => e.stopPropagation()}
        >
          <div className={styles.messagesDeleteModalHeader}>
            <h2 id={titleId} className={styles.messagesDeleteModalTitle}>
              {isGroup ? "Выйти из группы?" : "Удалить чат?"}
            </h2>
            <button
              type="button"
              className={styles.messagesDeleteModalClose}
              onClick={onClose}
              disabled={busy}
              aria-label="Закрыть"
            >
              &times;
            </button>
          </div>
          <div className={styles.messagesDeleteModalBody}>
            <p id={descriptionId} className={styles.messagesDeleteModalText}>
              {isGroup
                ? `Вы покинете группу «${name}». История у остальных участников сохранится; новые сообщения вам не придут.`
                : `Переписка с ${name} и все медиа будут удалены у обоих участников. Это действие нельзя отменить.`}
            </p>
            {error ? (
              <p className={styles.messagesDeleteModalError} role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <div className={styles.messagesDeleteModalActions}>
            <button
              type="button"
              className={styles.messagesDeleteModalBtnDanger}
              disabled={busy}
              onClick={onConfirm}
            >
              {busy ? (isGroup ? "Выход…" : "Удаление…") : isGroup ? "Выйти" : "Удалить"}
            </button>
            <button
              type="button"
              className={styles.messagesDeleteModalBtnCancel}
              ref={cancelRef}
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
