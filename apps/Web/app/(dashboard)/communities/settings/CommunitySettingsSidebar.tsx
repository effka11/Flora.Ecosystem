"use client";

import Link from "next/link";
import { useDashboardHistoryBack } from "@/app/_dashboard/useDashboardHistoryBack";
import { communityHref } from "@/app/(dashboard)/communities/communitiesSeed";
import { COMMUNITY_SETTINGS_SECTIONS, type CommunitySettingsSectionId } from "./communitySettingsSections";
import { useCommunitySettings } from "./CommunitySettingsContext";
import styles from "@/app/(dashboard)/settings/settings.module.css";

type CommunitySettingsSidebarProps = {
  communitySlug: string;
  communityId: string;
  activeSection: CommunitySettingsSectionId;
  onSectionChange: (section: CommunitySettingsSectionId) => void;
};

export function CommunitySettingsSidebar({
  communitySlug,
  communityId,
  activeSection,
  onSectionChange,
}: CommunitySettingsSidebarProps) {
  const backHref = communityHref({ id: communityId, slug: communitySlug });
  const { saveAll, saving, hasUnsavedChanges, saveError, saveSuccess } = useCommunitySettings();
  const goBack = useDashboardHistoryBack();

  return (
    <aside className={styles.settingsSidebar} aria-label="Разделы настроек сообщества">
      <nav className={styles.settingsSidebarNav}>
        <ul className={styles.settingsNavList}>
          {COMMUNITY_SETTINGS_SECTIONS.map((section) => {
            const active = section.id === activeSection;
            return (
              <li key={section.id}>
                <button
                  type="button"
                  className={`${styles.settingsNavItem} ${active ? styles.settingsNavItemActive : ""}`}
                  onClick={() => onSectionChange(section.id)}
                  aria-current={active ? "page" : undefined}
                >
                  {section.label}
                </button>
              </li>
            );
          })}
        </ul>
        <div className={styles.settingsSidebarActions}>
          <button
            type="button"
            className={`${styles.settingsNavItem} ${styles.settingsNavItemGreen}`}
            disabled={saving || !hasUnsavedChanges}
            onClick={() => void saveAll()}
          >
            {saving ? "Сохранение…" : "Сохранить"}
          </button>
          {saveError ? (
            <p className={styles.settingsSidebarFeedbackError} role="alert">
              {saveError}
            </p>
          ) : null}
          {saveSuccess ? (
            <p className={styles.settingsSidebarFeedbackSuccess} role="status">
              {saveSuccess}
            </p>
          ) : null}
          <button type="button" className={styles.settingsNavItem} onClick={goBack}>
            Назад
          </button>
          <Link href={backHref} className={styles.settingsNavItem}>
            К сообществу
          </Link>
        </div>
      </nav>
    </aside>
  );
}
