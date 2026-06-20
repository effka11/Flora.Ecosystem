"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiRequestError } from "@/lib/auth";
import { apiDeleteCommunity } from "@/lib/socialApi";
import { notifyOwnedCommunitiesChanged } from "@/app/(dashboard)/communities/ownedCommunitiesEvents";
import { useCommunitySettings } from "./CommunitySettingsContext";
import styles from "@/app/(dashboard)/settings/settings.module.css";

export function CommunitySettingsDangerTab() {
  const router = useRouter();
  const { community } = useCommunitySettings();
  const [confirmName, setConfirmName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canDelete = confirmName.trim() === community.name.trim();

  const onDelete = useCallback(async () => {
    if (!canDelete || deleting) return;
    setError(null);
    setDeleting(true);
    try {
      await apiDeleteCommunity(community.communityId);
      notifyOwnedCommunitiesChanged();
      router.replace("/communities");
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiRequestError || e instanceof Error ? e.message : "Не удалось удалить сообщество.");
      setDeleting(false);
    }
  }, [canDelete, community.communityId, deleting, router]);

  return (
    <div className={styles.tabContent}>
      <div className={styles.formSection}>
        <h3 className={styles.formSectionTitle}>Удаление сообщества</h3>
        <p className={styles.formHint}>
          Это действие необратимо. Все участники, посты и настройки сообщества будут удалены.
        </p>
        <div className={styles.formGroup}>
          <label className={styles.label} htmlFor="community-delete-confirm">
            Введите название сообщества для подтверждения
          </label>
          <input
            id="community-delete-confirm"
            type="text"
            className={styles.input}
            value={confirmName}
            placeholder={community.name}
            onChange={(e) => {
              setError(null);
              setConfirmName(e.target.value);
            }}
          />
        </div>

        {error ? (
          <p className={styles.formFeedbackError} role="alert">
            {error}
          </p>
        ) : null}

        <div className={styles.formActions}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnDanger}`}
            disabled={!canDelete || deleting}
            onClick={() => void onDelete()}
          >
            {deleting ? "Удаление…" : "Удалить сообщество"}
          </button>
        </div>
      </div>
    </div>
  );
}
