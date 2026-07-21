"use client";

import { useState } from "react";
import { useAnimatedModal } from "@/app/(dashboard)/communities/useAnimatedModal";
import { ApiRequestError } from "@/lib/auth";
import { apiClearFeedNotInterested } from "@/lib/socialApi";
import { useSettings } from "./SettingsContext";
import { SettingsFeedHiddenModal } from "./SettingsFeedHiddenModal";
import type {
  FeedAuthorDiversity,
  FeedExploration,
  FeedFreshness,
  FeedSeenPostsMode,
} from "./settingsDraft";
import styles from "./settings.module.css";

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={styles.toggle}>
      <input
        type="checkbox"
        className={styles.toggleInput}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div className={styles.toggleTrack}>
        <div className={styles.toggleThumb} />
      </div>
    </label>
  );
}

/**
 * §User Controls (FIRA-F): вкладка настроек ленты рекомендаций.
 * Значения enum'ов синхронизированы с fira-contracts (lowercase wire-format).
 */
export function SettingsFeedTab() {
  const { draft, updateFeed, clearSaveFeedback } = useSettings();
  const { feed } = draft;
  const hiddenModal = useAnimatedModal();
  const [clearState, setClearState] = useState<"idle" | "busy" | "done">("idle");
  const [clearError, setClearError] = useState<string | null>(null);

  const patch = (next: Partial<typeof feed>) => {
    clearSaveFeedback();
    updateFeed(next);
  };

  const handleClearNotInterested = async () => {
    setClearState("busy");
    setClearError(null);
    try {
      await apiClearFeedNotInterested();
      setClearState("done");
    } catch (e) {
      setClearError(e instanceof ApiRequestError ? e.message : "Не удалось сбросить отметки");
      setClearState("idle");
    }
  };

  return (
    <div className={styles.tabContent}>
      <div className={styles.formSection}>
        <h3 className={styles.formSectionTitle}>Рекомендации</h3>
        <div className={styles.formRow}>
          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor="feed-freshness">
              Баланс свежести
            </label>
            <select
              id="feed-freshness"
              className={styles.select}
              value={feed.freshness}
              onChange={(e) => patch({ freshness: e.target.value as FeedFreshness })}
            >
              <option value="fresh">Свежее — приоритет новым постам</option>
              <option value="balanced">Сбалансированно</option>
              <option value="popular">Популярное — лучшие за неделю</option>
            </select>
          </div>
          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor="feed-exploration">
              Открытие нового
            </label>
            <select
              id="feed-exploration"
              className={styles.select}
              value={feed.exploration}
              onChange={(e) => patch({ exploration: e.target.value as FeedExploration })}
            >
              <option value="off">Выкл — только знакомые темы</option>
              <option value="low">Меньше нового</option>
              <option value="standard">Стандартно</option>
              <option value="high">Больше нового</option>
            </select>
          </div>
        </div>
        <div className={styles.formRow}>
          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor="feed-author-diversity">
              Разнообразие авторов
            </label>
            <select
              id="feed-author-diversity"
              className={styles.select}
              value={feed.authorDiversity}
              onChange={(e) => patch({ authorDiversity: e.target.value as FeedAuthorDiversity })}
            >
              <option value="strict">Строгое — не чаще 1 поста подряд</option>
              <option value="standard">Стандартное — до 2 постов подряд</option>
              <option value="off">Выкл — как ранжирует алгоритм</option>
            </select>
          </div>
          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor="feed-seen-posts">
              Просмотренные посты
            </label>
            <select
              id="feed-seen-posts"
              className={styles.select}
              value={feed.seenPosts}
              onChange={(e) => patch({ seenPosts: e.target.value as FeedSeenPostsMode })}
            >
              <option value="show">Показывать как обычно</option>
              <option value="demote">Показывать реже</option>
              <option value="hide">Скрывать</option>
            </select>
          </div>
        </div>
      </div>

      <div className={styles.formSection}>
        <h3 className={styles.formSectionTitle}>Содержимое ленты</h3>
        <div className={styles.listCard}>
          <div className={styles.listCardInfo}>
            <p className={styles.listCardTitle}>Репосты</p>
            <p className={styles.listCardDesc}>Показывать репосты в рекомендациях и подписках</p>
          </div>
          <Toggle checked={feed.showReposts} onChange={(showReposts) => patch({ showReposts })} />
        </div>
        <div className={styles.listCard}>
          <div className={styles.listCardInfo}>
            <p className={styles.listCardTitle}>Посты сообществ</p>
            <p className={styles.listCardDesc}>Показывать посты сообществ в рекомендациях</p>
          </div>
          <Toggle
            checked={feed.communityPosts}
            onChange={(communityPosts) => patch({ communityPosts })}
          />
        </div>
      </div>

      <div className={styles.formSection}>
        <h3 className={styles.formSectionTitle}>Скрытое и «не интересно»</h3>
        <div className={styles.formGroup}>
          <p className={styles.listCardDesc} style={{ marginBottom: "calc(1 * var(--flora-grid-step))" }}>
            Скрытые авторы и сообщества не попадают в рекомендации. Отметки «не интересно» мягко
            снижают похожие посты в ленте.
          </p>
          <div style={{ display: "flex", gap: "calc(1 * var(--flora-grid-step))", flexWrap: "wrap" }}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnGhost}`}
              onClick={hiddenModal.openModal}
            >
              Скрытые авторы и сообщества
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnGhost}`}
              disabled={clearState !== "idle"}
              onClick={() => void handleClearNotInterested()}
            >
              {clearState === "done" ? "Отметки сброшены" : "Сбросить отметки «не интересно»"}
            </button>
          </div>
          {clearError ? (
            <p
              className={styles.settingsSidebarFeedbackError}
              role="alert"
              style={{ marginTop: "calc(1 * var(--flora-grid-step))" }}
            >
              {clearError}
            </p>
          ) : null}
        </div>
      </div>

      <SettingsFeedHiddenModal
        open={hiddenModal.open}
        closing={hiddenModal.closing}
        onClose={hiddenModal.closeModal}
      />
    </div>
  );
}
