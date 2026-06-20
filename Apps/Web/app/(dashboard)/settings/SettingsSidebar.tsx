"use client";

import { useDashboardHistoryBack } from "@/app/_dashboard/useDashboardHistoryBack";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "./settingsSections";
import { useSettings } from "./SettingsContext";
import styles from "./settings.module.css";
type SettingsSidebarProps = {
  activeSection: SettingsSectionId;
  onSectionChange: (section: SettingsSectionId) => void;
};

export function SettingsSidebar({ activeSection, onSectionChange }: SettingsSidebarProps) {
  const { saveAll, saving, hasUnsavedChanges, saveError, saveSuccess } = useSettings();
  const goBack = useDashboardHistoryBack();
  return (
    <aside className={styles.settingsSidebar} aria-label="Разделы настроек">
      <nav className={styles.settingsSidebarNav}>
        <ul className={styles.settingsNavList}>
          {SETTINGS_SECTIONS.map((section) => {
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
        </div>      </nav>
    </aside>
  );
}
