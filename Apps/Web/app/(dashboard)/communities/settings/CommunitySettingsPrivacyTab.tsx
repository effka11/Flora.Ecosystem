"use client";

import { useCommunitySettings } from "./CommunitySettingsContext";
import styles from "@/app/(dashboard)/settings/settings.module.css";

export function CommunitySettingsPrivacyTab() {
  const { draft, updateDraft, clearSaveFeedback } = useCommunitySettings();

  return (
    <div className={styles.tabContent}>
      <div className={styles.formSection}>
        <h3 className={styles.formSectionTitle}>Видимость</h3>
        <div className={styles.listCard}>
          <div className={styles.listCardInfo}>
            <p className={styles.listCardTitle}>Публичное сообщество</p>
            <p className={styles.listCardDesc}>
              Если включено — сообщество видно в поиске и рекомендациях, на него можно подписаться. Если выключено —
              доступ только для участников.
            </p>
          </div>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              className={styles.toggleInput}
              checked={!draft.isPrivate}
              onChange={(e) => {
                clearSaveFeedback();
                updateDraft({ isPrivate: !e.target.checked });
              }}
            />
            <span className={styles.toggleTrack}>
              <span className={styles.toggleThumb} />
            </span>
          </label>
        </div>
      </div>
    </div>
  );
}
