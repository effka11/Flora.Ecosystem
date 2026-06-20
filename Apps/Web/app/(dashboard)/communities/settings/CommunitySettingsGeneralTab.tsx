"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { normalizeCommunitySlug } from "@/app/(dashboard)/communities/communitySlug";
import { ApiRequestError, avatarImageUrl } from "@/lib/auth";
import { apiUploadCommunityAvatar } from "@/lib/socialApi";
import { useCommunitySettings } from "./CommunitySettingsContext";
import styles from "@/app/(dashboard)/settings/settings.module.css";

function communityAvatarLabel(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0]!.slice(0, 1) + parts[1]!.slice(0, 1)).toUpperCase();
  }
  return name.trim().slice(0, 2).toUpperCase() || "?";
}

export function CommunitySettingsGeneralTab() {
  const { community, draft, updateDraft, reload, clearSaveFeedback } = useCommunitySettings();
  const nameId = useId();
  const slugId = useId();
  const fileInputId = useId();

  const [avatarUuid, setAvatarUuid] = useState(community.avatarUuid ?? "");
  const [avatarVersion, setAvatarVersion] = useState(0);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [avatarSuccess, setAvatarSuccess] = useState<string | null>(null);

  useEffect(() => {
    setAvatarUuid(community.avatarUuid ?? "");
  }, [community.avatarUuid]);

  const resetAvatarFeedback = useCallback(() => {
    setAvatarError(null);
    setAvatarSuccess(null);
  }, []);

  const onPickAvatar = useCallback(() => {
    document.getElementById(fileInputId)?.click();
  }, [fileInputId]);

  const onAvatarSelected = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      resetAvatarFeedback();
      setAvatarBusy(true);
      try {
        const nextUuid = await apiUploadCommunityAvatar(community.communityId, file);
        setAvatarUuid(nextUuid);
        setAvatarVersion((v) => v + 1);
        await reload();
        setAvatarSuccess("Аватар обновлён.");
      } catch (e) {
        setAvatarError(
          e instanceof ApiRequestError || e instanceof Error ? e.message : "Не удалось загрузить аватар.",
        );
      } finally {
        setAvatarBusy(false);
      }
    },
    [community.communityId, reload, resetAvatarFeedback],
  );

  const avatarSrc = avatarUuid ? `${avatarImageUrl(avatarUuid)}?v=${avatarVersion}` : null;
  const initials = communityAvatarLabel(draft.name || community.name);

  return (
    <div className={styles.tabContent}>
      <div className={styles.formSection}>
        <h3 className={styles.formSectionTitle}>Основное</h3>
        <div className={styles.formRow}>
          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor={nameId}>
              Название
            </label>
            <input
              id={nameId}
              type="text"
              className={styles.input}
              value={draft.name}
              maxLength={100}
              onChange={(e) => {
                clearSaveFeedback();
                updateDraft({ name: e.target.value });
              }}
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor={slugId}>
              Ссылка
            </label>
            <input
              id={slugId}
              type="text"
              className={styles.input}
              value={draft.slug}
              maxLength={100}
              spellCheck={false}
              onChange={(e) => {
                clearSaveFeedback();
                updateDraft({ slug: normalizeCommunitySlug(e.target.value) });
              }}
            />
          </div>
        </div>
        <p className={styles.formHint}>
          Адрес сообщества: /communities/{draft.slug || "…"}
        </p>
      </div>

      <div className={styles.formSection}>
        <h3 className={styles.formSectionTitle}>Оформление</h3>
        <div className={styles.avatarBlock}>
          <div className={styles.avatarCircle} aria-hidden={Boolean(avatarSrc)}>
            {avatarSrc ? (
              // eslint-disable-next-line @next/next/no-img-element -- blob/CDN URL from API
              <img src={avatarSrc} alt="" className={styles.avatarImage} />
            ) : (
              initials
            )}
          </div>
          <div className={styles.avatarActions}>
            <input
              id={fileInputId}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className={styles.visuallyHidden}
              disabled={avatarBusy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                void onAvatarSelected(file);
              }}
            />
            <button type="button" className={styles.btnMain} disabled={avatarBusy} onClick={onPickAvatar}>
              {avatarBusy ? "Загрузка…" : "Изменить аватар"}
            </button>
          </div>
        </div>
        <p className={styles.formHint}>JPEG, PNG или WebP, до 2 МБ.</p>

        {avatarError ? (
          <p className={styles.formFeedbackError} role="alert">
            {avatarError}
          </p>
        ) : null}
        {avatarSuccess ? (
          <p className={styles.formFeedbackSuccess} role="status">
            {avatarSuccess}
          </p>
        ) : null}
      </div>
    </div>
  );
}
