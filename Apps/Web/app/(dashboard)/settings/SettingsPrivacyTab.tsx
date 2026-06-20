"use client";

import { useAnimatedModal } from "@/app/(dashboard)/communities/useAnimatedModal";
import { useSettings } from "./SettingsContext";
import { SettingsBlocklistModal } from "./SettingsBlocklistModal";
import type { MessagesFrom, OnlineVisibility, PrivacyVisibility } from "./settingsDraft";
import styles from "./settings.module.css";

function VisibilitySelect({
  id,
  value,
  onChange,
  includeNone = true,
}: {
  id: string;
  value: PrivacyVisibility;
  onChange: (value: PrivacyVisibility) => void;
  includeNone?: boolean;
}) {
  return (
    <select
      id={id}
      className={styles.select}
      value={value}
      onChange={(e) => onChange(e.target.value as PrivacyVisibility)}
    >
      <option value="all">Все пользователи</option>
      <option value="friends">Только друзья</option>
      {includeNone ? <option value="none">Никто</option> : null}
    </select>
  );
}

export function SettingsPrivacyTab() {
  const { draft, updatePrivacy, clearSaveFeedback } = useSettings();
  const { privacy } = draft;
  const blocklistModal = useAnimatedModal();

  const patch = (next: Partial<typeof privacy>) => {
    clearSaveFeedback();
    updatePrivacy(next);
  };

  return (
    <div className={styles.tabContent}>
      <div className={styles.formSection}>
        <h3 className={styles.formSectionTitle}>Видимость профиля</h3>
        <div className={styles.formRow}>
          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor="privacy-friends">
              Кто видит моих друзей
            </label>
            <VisibilitySelect
              id="privacy-friends"
              value={privacy.friendsVisibility}
              onChange={(friendsVisibility) => patch({ friendsVisibility })}
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor="privacy-subscriptions">
              Кто видит мои подписки
            </label>
            <VisibilitySelect
              id="privacy-subscriptions"
              value={privacy.subscriptionsVisibility}
              onChange={(subscriptionsVisibility) => patch({ subscriptionsVisibility })}
            />
          </div>
        </div>
        <div className={styles.formRow}>
          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor="privacy-posts">
              Кто видит мои публикации
            </label>
            <VisibilitySelect
              id="privacy-posts"
              value={privacy.postsVisibility}
              onChange={(postsVisibility) => patch({ postsVisibility })}
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor="privacy-likes">
              Кто видит мои лайки
            </label>
            <VisibilitySelect
              id="privacy-likes"
              value={privacy.likesVisibility}
              onChange={(likesVisibility) => patch({ likesVisibility })}
            />
          </div>
        </div>
        <div className={styles.formRow}>
          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor="privacy-reposts">
              Кто видит мои репосты
            </label>
            <VisibilitySelect
              id="privacy-reposts"
              value={privacy.repostsVisibility}
              onChange={(repostsVisibility) => patch({ repostsVisibility })}
            />
          </div>
        </div>
      </div>

      <div className={styles.formSection}>
        <h3 className={styles.formSectionTitle}>Взаимодействие</h3>
        <div className={styles.formRow}>
          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor="privacy-messages">
              Кто может мне писать
            </label>
            <select
              id="privacy-messages"
              className={styles.select}
              value={privacy.messagesFrom}
              onChange={(e) => patch({ messagesFrom: e.target.value as MessagesFrom })}
            >
              <option value="all">Все пользователи</option>
              <option value="friends">Только друзья</option>
            </select>
          </div>
          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor="privacy-comments">
              Кто может комментировать мои посты
            </label>
            <VisibilitySelect
              id="privacy-comments"
              value={privacy.commentsFrom}
              onChange={(commentsFrom) => patch({ commentsFrom })}
            />
          </div>
        </div>
      </div>

      <div className={styles.formSection}>
        <h3 className={styles.formSectionTitle}>Видимость онлайна</h3>
        <div className={styles.formRow}>
          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor="privacy-online-friends">
              Для друзей
            </label>
            <select
              id="privacy-online-friends"
              className={styles.select}
              value={privacy.onlineFriends}
              onChange={(e) => patch({ onlineFriends: e.target.value as OnlineVisibility })}
            >
              <option value="visible">Виден</option>
              <option value="hidden">Не виден</option>
            </select>
          </div>
          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor="privacy-online-strangers">
              Для незнакомых
            </label>
            <select
              id="privacy-online-strangers"
              className={styles.select}
              value={privacy.onlineStrangers}
              onChange={(e) => patch({ onlineStrangers: e.target.value as OnlineVisibility })}
            >
              <option value="visible">Виден</option>
              <option value="hidden">Не виден</option>
            </select>
          </div>
        </div>
      </div>

      <div className={styles.formSection}>
        <h3 className={styles.formSectionTitle}>Черный список</h3>
        <div className={styles.formGroup}>
          <p className={styles.listCardDesc} style={{ marginBottom: "calc(1 * var(--flora-grid-step))" }}>
            Пользователи из черного списка не смогут просматривать ваш профиль и писать вам сообщения.
          </p>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            style={{ alignSelf: "flex-start" }}
            onClick={blocklistModal.openModal}
          >
            Управление черным списком
          </button>
        </div>
      </div>
      <SettingsBlocklistModal
        open={blocklistModal.open}
        closing={blocklistModal.closing}
        onClose={blocklistModal.closeModal}
      />
    </div>
  );
}
