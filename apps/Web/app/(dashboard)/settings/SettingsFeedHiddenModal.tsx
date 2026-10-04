"use client";

import { useEffect, useId, useState } from "react";
import { formatAtHandle } from "@/app/_dashboard/userDisplay";
import { ApiRequestError } from "@/lib/auth";
import {
  apiGetDismissedCommunities,
  apiGetHiddenFeedAuthors,
  apiUndismissCommunity,
  apiUnhideFeedAuthor,
  type DismissedCommunityDto,
  type HiddenFeedAuthorDto,
} from "@/lib/socialApi";
import styles from "./settings.module.css";

type SettingsFeedHiddenModalProps = {
  open: boolean;
  closing: boolean;
  onClose: () => void;
};

/**
 * §User Controls (FIRA): управление скрытым контентом ленты —
 * скрытые авторы (рекомендации) и скрытые сообщества (FIRA-C).
 *
 * Обёртка размонтирует содержимое при закрытии: каждый показ модалки
 * монтирует контент заново и перезагружает списки без setState в эффекте.
 */
export function SettingsFeedHiddenModal({ open, closing, onClose }: SettingsFeedHiddenModalProps) {
  if (!open) return null;
  return <SettingsFeedHiddenModalContent closing={closing} onClose={onClose} />;
}

function SettingsFeedHiddenModalContent({ closing, onClose }: Omit<SettingsFeedHiddenModalProps, "open">) {
  const titleId = useId();
  const [authors, setAuthors] = useState<HiddenFeedAuthorDto[]>([]);
  const [communities, setCommunities] = useState<DismissedCommunityDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [a, c] = await Promise.all([apiGetHiddenFeedAuthors(), apiGetDismissedCommunities()]);
        if (cancelled) return;
        setAuthors(a);
        setCommunities(c);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof ApiRequestError ? e.message : "Не удалось загрузить список");
        setAuthors([]);
        setCommunities([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleUnhideAuthor = async (userUuid: string) => {
    setBusyId(userUuid);
    setError(null);
    try {
      await apiUnhideFeedAuthor(userUuid);
      setAuthors((prev) => prev.filter((a) => a.userUuid !== userUuid));
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Не удалось вернуть автора");
    } finally {
      setBusyId(null);
    }
  };

  const handleUndismissCommunity = async (communityId: string) => {
    setBusyId(communityId);
    setError(null);
    try {
      await apiUndismissCommunity(communityId);
      setCommunities((prev) => prev.filter((c) => c.communityId !== communityId));
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Не удалось вернуть сообщество");
    } finally {
      setBusyId(null);
    }
  };

  const listStyle: React.CSSProperties = {
    marginTop: "calc(1 * var(--flora-grid-step))",
    display: "flex",
    flexDirection: "column",
    gap: "calc(1 * var(--flora-grid-step))",
    listStyle: "none",
    padding: 0,
  };

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
              Скрытое в ленте
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
              Скрытые авторы не попадают в рекомендации; скрытые сообщества не предлагаются в подборках.
            </p>
            {error ? (
              <p
                className={styles.settingsSidebarFeedbackError}
                role="alert"
                style={{ marginTop: "calc(1 * var(--flora-grid-step))" }}
              >
                {error}
              </p>
            ) : null}
            {loading ? (
              <p className={styles.listCardDesc} style={{ marginTop: "calc(2 * var(--flora-grid-step))" }}>
                Загрузка…
              </p>
            ) : (
              <>
                <h3
                  className={styles.formSectionTitle}
                  style={{ marginTop: "calc(2 * var(--flora-grid-step))" }}
                >
                  Скрытые авторы
                </h3>
                {authors.length === 0 ? (
                  <p className={styles.listCardDesc} style={{ marginTop: "calc(1 * var(--flora-grid-step))" }}>
                    Нет скрытых авторов.
                  </p>
                ) : (
                  <ul style={listStyle}>
                    {authors.map((author) => {
                      const label =
                        author.displayName.trim().length > 0
                          ? author.displayName
                          : author.username.trim().length > 0
                            ? formatAtHandle(author.username)
                            : "Пользователь";
                      const isBusy = busyId === author.userUuid;
                      return (
                        <li key={author.userUuid} className={styles.listCard}>
                          <div className={styles.listCardInfo}>
                            <p className={styles.listCardTitle}>{label}</p>
                            {author.username ? (
                              <p className={styles.listCardDesc}>{formatAtHandle(author.username)}</p>
                            ) : null}
                          </div>
                          <button
                            type="button"
                            className={`${styles.btn} ${styles.btnGhost}`}
                            disabled={isBusy || busyId !== null}
                            onClick={() => void handleUnhideAuthor(author.userUuid)}
                          >
                            Вернуть
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}

                <h3
                  className={styles.formSectionTitle}
                  style={{ marginTop: "calc(2 * var(--flora-grid-step))" }}
                >
                  Скрытые сообщества
                </h3>
                {communities.length === 0 ? (
                  <p className={styles.listCardDesc} style={{ marginTop: "calc(1 * var(--flora-grid-step))" }}>
                    Нет скрытых сообществ.
                  </p>
                ) : (
                  <ul style={listStyle}>
                    {communities.map((community) => {
                      const isBusy = busyId === community.communityId;
                      return (
                        <li key={community.communityId} className={styles.listCard}>
                          <div className={styles.listCardInfo}>
                            <p className={styles.listCardTitle}>
                              {community.name.trim().length > 0 ? community.name : "Сообщество"}
                            </p>
                            {community.slug ? (
                              <p className={styles.listCardDesc}>{formatAtHandle(community.slug)}</p>
                            ) : null}
                          </div>
                          <button
                            type="button"
                            className={`${styles.btn} ${styles.btnGhost}`}
                            disabled={isBusy || busyId !== null}
                            onClick={() => void handleUndismissCommunity(community.communityId)}
                          >
                            Вернуть
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
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
