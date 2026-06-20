"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { apiCreateCommunity } from "@/lib/socialApi";
import { isReservedCommunitySlug, RESERVED_COMMUNITY_SLUG_MESSAGE } from "@/lib/communityReservedSlugs";
import {
  COMMUNITY_SLUG_FORMAT_MESSAGE,
  hasOnlyCommunitySlugChars,
  normalizeCommunitySlug,
} from "./communitySlug";
import { notifyOwnedCommunitiesChanged } from "./ownedCommunitiesEvents";
import styles from "./communities.module.css";
import settingsStyles from "@/app/(dashboard)/settings/settings.module.css";

export type CreatedCommunity = {
  communityId: string;
  name: string;
  slug: string;
  memberCount: number;
};

type CreateCommunityModalProps = {
  open: boolean;
  closing: boolean;
  onClose: () => void;
  onCreated: (community: CreatedCommunity) => void;
};

export function CreateCommunityModal({ open, closing, onClose, onCreated }: CreateCommunityModalProps) {
  const titleId = useId();
  const nameId = useId();
  const slugId = useId();
  const nameRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [isPublic, setIsPublic] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setName("");
    setSlug("");
    setSlugTouched(false);
    setIsPublic(false);
    setSubmitting(false);
    setError(null);
  }, []);

  useEffect(() => {
    if (!open || closing) return;
    resetForm();
    const t = window.setTimeout(() => nameRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open, closing, resetForm]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const onNameChange = (value: string) => {
    setName(value);
    setError(null);
    if (!slugTouched) {
      setSlug(normalizeCommunitySlug(value));
    }
  };

  const onSlugChange = (value: string) => {
    setSlugTouched(true);
    setSlug(normalizeCommunitySlug(value));
    setError(null);
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Укажите название сообщества.");
      return;
    }
    if (trimmedName.length > 100) {
      setError("Название не более 100 символов.");
      return;
    }

    if (slugTouched && !hasOnlyCommunitySlugChars(slug)) {
      setError(COMMUNITY_SLUG_FORMAT_MESSAGE);
      return;
    }

    const normalizedSlug = normalizeCommunitySlug(slugTouched ? slug : trimmedName);
    if (!normalizedSlug) {
      setError("Ссылка не может быть пустой. Используйте латиницу, цифры, дефис или подчёркивание.");
      return;
    }
    if (isReservedCommunitySlug(normalizedSlug)) {
      setError(RESERVED_COMMUNITY_SLUG_MESSAGE);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const created = await apiCreateCommunity({
        name: trimmedName,
        slug: slugTouched ? normalizedSlug : undefined,
        isPrivate: !isPublic,
      });
      notifyOwnedCommunitiesChanged();
      onCreated(created);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось создать сообщество.");
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <>
      <div
        className={`${styles.createCommunityModalBackdrop}${closing ? ` ${styles.createCommunityModalBackdropClosing}` : ""}`}
        onClick={onClose}
      />
      <div className={styles.createCommunityModal} role="presentation">
        <div
          className={`${styles.createCommunityModalDialog}${closing ? ` ${styles.createCommunityModalDialogClosing}` : ""}`}
          role="dialog"
          aria-modal
          aria-labelledby={titleId}
          onClick={(e) => e.stopPropagation()}
        >
          <div className={styles.createCommunityModalHeader}>
            <h2 id={titleId} className={styles.createCommunityModalTitle}>
              Новое сообщество
            </h2>
            <button type="button" className={styles.createCommunityModalClose} onClick={onClose} aria-label="Закрыть">
              &times;
            </button>
          </div>

          <form className={styles.createCommunityForm} onSubmit={(e) => void onSubmit(e)}>
            <div className={styles.createCommunityModalBody}>
              <div className={styles.createCommunityField}>
                <label className={styles.createCommunityLabel} htmlFor={nameId}>
                  Название
                </label>
                <input
                  ref={nameRef}
                  id={nameId}
                  type="text"
                  className={styles.createCommunityInput}
                  value={name}
                  onChange={(e) => onNameChange(e.target.value)}
                  placeholder="Например, Flora Design"
                  maxLength={100}
                  autoComplete="off"
                  disabled={submitting}
                />
              </div>

              <div className={styles.createCommunityField}>
                <label className={styles.createCommunityLabel} htmlFor={slugId}>
                  Ссылка
                </label>
                <div className={styles.createCommunitySlugRow}>
                  <span className={styles.createCommunitySlugPrefix} aria-hidden>
                    communities/
                  </span>
                  <input
                    id={slugId}
                    type="text"
                    className={styles.createCommunityInput}
                    value={slug}
                    onChange={(e) => onSlugChange(e.target.value)}
                    placeholder="flora-design"
                    maxLength={100}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={submitting}
                  />
                </div>
              </div>

              <div className={settingsStyles.listCard}>
                <div className={settingsStyles.listCardInfo}>
                  <p className={settingsStyles.listCardTitle}>Публичное сообщество</p>
                  <p className={settingsStyles.listCardDesc}>
                    Публичные сообщества видны в рекомендациях, на них можно подписаться.
                  </p>
                </div>
                <label className={settingsStyles.toggle}>
                  <input
                    type="checkbox"
                    className={settingsStyles.toggleInput}
                    checked={isPublic}
                    disabled={submitting}
                    onChange={(e) => {
                      setIsPublic(e.target.checked);
                      setError(null);
                    }}
                  />
                  <span className={settingsStyles.toggleTrack}>
                    <span className={settingsStyles.toggleThumb} />
                  </span>
                </label>
              </div>

              {error ? (
                <p className={styles.createCommunityError} role="alert">
                  {error}
                </p>
              ) : null}
            </div>

            <div className={styles.createCommunityActions}>
              <button type="button" className={styles.createCommunityCancelBtn} onClick={onClose} disabled={submitting}>
                Отмена
              </button>
              <button type="submit" className={styles.createCommunitySubmitBtn} disabled={submitting}>
                {submitting ? "Создание…" : "Создать"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
