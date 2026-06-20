"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { formatAtHandle } from "@/app/_dashboard/userDisplay";
import {
  apiBlockUser,
  apiGetBlocklist,
  apiUnblockUser,
  ApiRequestError,
  type BlocklistEntryDto,
} from "@/lib/auth";
import styles from "./settings.module.css";

type SettingsBlocklistModalProps = {
  open: boolean;
  closing: boolean;
  onClose: () => void;
};

export function SettingsBlocklistModal({ open, closing, onClose }: SettingsBlocklistModalProps) {
  const titleId = useId();
  const inputId = useId();
  const [entries, setEntries] = useState<BlocklistEntryDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [usernameInput, setUsernameInput] = useState("");
  const [busyUsername, setBusyUsername] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadBlocklist = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEntries(await apiGetBlocklist());
    } catch (e) {
      const msg = e instanceof ApiRequestError ? e.message : "Не удалось загрузить чёрный список";
      setError(msg);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open || closing) return;
    void loadBlocklist();
  }, [open, closing, loadBlocklist]);

  const handleBlock = async () => {
    const username = usernameInput.trim().replace(/^@+/, "");
    if (!username) {
      setError("Укажите юзернейм.");
      return;
    }
    setBusyUsername(username);
    setError(null);
    try {
      await apiBlockUser(username);
      setUsernameInput("");
      await loadBlocklist();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Не удалось заблокировать пользователя");
    } finally {
      setBusyUsername(null);
    }
  };

  const handleUnblock = async (username: string) => {
    setBusyUsername(username);
    setError(null);
    try {
      await apiUnblockUser(username);
      await loadBlocklist();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Не удалось разблокировать пользователя");
    } finally {
      setBusyUsername(null);
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
              Чёрный список
            </h2>
            <button
              type="button"
              className={styles.settingsConfirmModalClose}
              aria-label="Закрыть"
              onClick={onClose}
            >
              ×
            </button>
          </div>
          <div className={styles.settingsConfirmModalBody}>
            <p className={styles.settingsConfirmModalText}>
              Заблокированные пользователи не смогут просматривать ваш профиль и писать вам сообщения.
            </p>
            <div className={styles.inlineFieldRow} style={{ marginTop: "calc(1 * var(--flora-grid-step))" }}>
              <input
                id={inputId}
                type="text"
                className={styles.input}
                placeholder="Юзернейм"
                value={usernameInput}
                disabled={busyUsername !== null}
                onChange={(e) => setUsernameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleBlock();
                  }
                }}
              />
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                disabled={busyUsername !== null}
                onClick={() => void handleBlock()}
              >
                Заблокировать
              </button>
            </div>
            {error ? (
              <p className={styles.settingsSidebarFeedbackError} role="alert" style={{ marginTop: "calc(1 * var(--flora-grid-step))" }}>
                {error}
              </p>
            ) : null}
            {loading ? (
              <p className={styles.listCardDesc} style={{ marginTop: "calc(2 * var(--flora-grid-step))" }}>
                Загрузка…
              </p>
            ) : entries.length === 0 ? (
              <p className={styles.listCardDesc} style={{ marginTop: "calc(2 * var(--flora-grid-step))" }}>
                Список пуст.
              </p>
            ) : (
              <ul
                style={{
                  marginTop: "calc(2 * var(--flora-grid-step))",
                  display: "flex",
                  flexDirection: "column",
                  gap: "calc(1 * var(--flora-grid-step))",
                  listStyle: "none",
                  padding: 0,
                }}
              >
                {entries.map((entry) => {
                  const label =
                    entry.displayName.trim().length > 0
                      ? entry.displayName
                      : entry.username.trim().length > 0
                        ? formatAtHandle(entry.username)
                        : "Пользователь";
                  const isBusy = busyUsername === entry.username;
                  return (
                    <li key={entry.userUuid} className={styles.listCard}>
                      <div className={styles.listCardInfo}>
                        <p className={styles.listCardTitle}>{label}</p>
                        {entry.username ? (
                          <p className={styles.listCardDesc}>{formatAtHandle(entry.username)}</p>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        className={`${styles.btn} ${styles.btnGhost}`}
                        disabled={isBusy || busyUsername !== null}
                        onClick={() => void handleUnblock(entry.username)}
                      >
                        Разблокировать
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
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
