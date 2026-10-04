"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { FrankingReportCategory } from "@flora/client-core/contracts";
import { FRANKING_REPORT_CATEGORY_OPTIONS } from "./messageReport";
import styles from "./messages.module.css";

type MessagesReportMessageModalProps = {
  open: boolean;
  closing: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (category: FrankingReportCategory) => void;
};

export function MessagesReportMessageModal({
  open,
  closing,
  busy,
  error,
  onClose,
  onConfirm,
}: MessagesReportMessageModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const groupId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [category, setCategory] = useState<FrankingReportCategory>("abuse");

  useEffect(() => {
    if (!open || closing) return;
    setCategory("abuse");
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
          role="dialog"
          aria-modal
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          onClick={(e) => e.stopPropagation()}
        >
          <div className={styles.messagesDeleteModalHeader}>
            <h2 id={titleId} className={styles.messagesDeleteModalTitle}>
              Пожаловаться
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
              Жалоба отправит это сообщение модераторам. Сервер не увидит текст: содержимое
              шифруется на устройстве.
            </p>
            <fieldset className={styles.messagesReportCategoryFieldset}>
              <legend className={styles.messagesReportCategoryLegend}>Причина</legend>
              <div className={styles.messagesReportCategoryList}>
                {FRANKING_REPORT_CATEGORY_OPTIONS.map((option) => {
                  const optionId = `${groupId}-${option.value}`;
                  return (
                    <label key={option.value} htmlFor={optionId} className={styles.messagesReportCategoryOption}>
                      <input
                        id={optionId}
                        type="radio"
                        name={groupId}
                        value={option.value}
                        checked={category === option.value}
                        disabled={busy}
                        onChange={() => setCategory(option.value)}
                      />
                      <span>{option.label}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
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
              onClick={() => onConfirm(category)}
            >
              {busy ? "Отправка…" : "Отправить"}
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
