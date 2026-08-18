"use client";

import {
  ACCOUNT_BLOCK_LABEL,
  setAccountBlockDays,
  setAccountBlockMode,
  type AccountBlockMode,
  type SanctionDraft,
} from "./moderationSanctions";
import styles from "./moderation.module.css";

type SanctionMatrixProps = {
  draft: SanctionDraft;
  disabled?: boolean;
  onChange: (draft: SanctionDraft) => void;
};

export function SanctionMatrix({ draft, disabled = false, onChange }: SanctionMatrixProps) {
  const selectMode = (mode: Exclude<AccountBlockMode, "none">) => {
    if (disabled) return;
    onChange(setAccountBlockMode(draft, mode));
  };

  const timed = draft.mode === "timed";
  const forever = draft.mode === "forever";
  const kindClass =
    draft.mode === "none" ? styles.matrixKind : `${styles.matrixKind} ${styles.matrixKindActive}`;

  return (
    <section className={styles.matrix} aria-label="Решение">
      <div className={kindClass}>{ACCOUNT_BLOCK_LABEL}</div>
      <div className={styles.matrixOptions} role="radiogroup" aria-label={ACCOUNT_BLOCK_LABEL}>
        <div className={styles.matrixOption}>
          <button
            type="button"
            role="radio"
            className={timed ? `${styles.matrixCell} ${styles.matrixCellSelected}` : styles.matrixCell}
            aria-checked={timed}
            disabled={disabled}
            onClick={() => selectMode("timed")}
          >
            <span className={styles.matrixDot} aria-hidden="true" />
          </button>
          <span
            className={timed ? styles.matrixOptionLabelActive : styles.matrixOptionLabel}
            onClick={() => selectMode("timed")}
          >
            Время
          </span>
          <input
            className={styles.matrixDaysInput}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            aria-label="Срок в днях"
            value={draft.daysText}
            disabled={disabled}
            onChange={(event) => onChange(setAccountBlockDays(draft, event.target.value))}
            onFocus={() => {
              if (disabled || draft.mode === "timed") return;
              onChange({ ...draft, mode: "timed" });
            }}
          />
          <span className={styles.matrixDaysUnit}>дней</span>
        </div>
        <div className={styles.matrixOption}>
          <button
            type="button"
            role="radio"
            className={
              forever ? `${styles.matrixCell} ${styles.matrixCellSelected}` : styles.matrixCell
            }
            aria-checked={forever}
            disabled={disabled}
            onClick={() => selectMode("forever")}
          >
            <span className={styles.matrixDot} aria-hidden="true" />
          </button>
          <span
            className={forever ? styles.matrixOptionLabelActive : styles.matrixOptionLabel}
            onClick={() => selectMode("forever")}
          >
            Навсегда
          </span>
        </div>
      </div>
    </section>
  );
}
