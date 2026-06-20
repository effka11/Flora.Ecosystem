"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useProtectedPage } from "@/app/_dashboard/useProtectedPage";
import { SettingsProvider } from "./SettingsContext";
import { SettingsLeaveGuard } from "./SettingsLeaveGuard";
import { SettingsSidebar } from "./SettingsSidebar";
import { SettingsAccountTab } from "./SettingsAccountTab";
import { SettingsPrivacyTab } from "./SettingsPrivacyTab";
import { SettingsSecurityTab } from "./SettingsSecurityTab";
import { SettingsNotificationsTab } from "./SettingsNotificationsTab";
import { SettingsCustomizationTab } from "./SettingsCustomizationTab";
import { DEFAULT_SETTINGS_SECTION, parseSettingsSectionId, type SettingsSectionId } from "./settingsSections";
import styles from "./settings.module.css";

/** Синхронно с `--flora-duration-6` (как FEED_LIST_TRANSITION_CLEAR_MS). */
const SETTINGS_PANEL_TRANSITION_CLEAR_MS = 950;

type SettingsPanelTransition = null | "fade";

function SettingsSectionContent({ section }: { section: SettingsSectionId }) {
  switch (section) {
    case "account":
      return <SettingsAccountTab />;
    case "privacy":
      return <SettingsPrivacyTab />;
    case "security":
      return <SettingsSecurityTab />;
    case "notifications":
      return <SettingsNotificationsTab />;
    case "customization":
      return <SettingsCustomizationTab />;
    default:
      return (
        <p className={styles.settingsPlaceholderCard}>Раздел в разработке.</p>
      );
  }
}

function SettingsPageContent() {
  const { isClient, hasToken } = useProtectedPage();
  const searchParams = useSearchParams();
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(() => {
    return parseSettingsSectionId(searchParams.get("section")) ?? DEFAULT_SETTINGS_SECTION;
  });
  const [panelTransition, setPanelTransition] = useState<SettingsPanelTransition>(null);
  const [panelAnimEpoch, setPanelAnimEpoch] = useState(0);
  const panelTransitionClearRef = useRef<number | null>(null);

  const applyPanelTransition = useCallback(() => {
    if (panelTransitionClearRef.current !== null) {
      window.clearTimeout(panelTransitionClearRef.current);
      panelTransitionClearRef.current = null;
    }

    const reduced =
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (!reduced) {
      setPanelAnimEpoch((epoch) => epoch + 1);
      setPanelTransition("fade");
      panelTransitionClearRef.current = window.setTimeout(() => {
        setPanelTransition(null);
        panelTransitionClearRef.current = null;
      }, SETTINGS_PANEL_TRANSITION_CLEAR_MS);
    } else {
      setPanelTransition(null);
    }
  }, []);

  const switchSection = useCallback(
    (next: SettingsSectionId) => {
      if (next === activeSection) return;
      applyPanelTransition();
      setActiveSection(next);
    },
    [activeSection, applyPanelTransition],
  );

  useEffect(
    () => () => {
      if (panelTransitionClearRef.current !== null) {
        window.clearTimeout(panelTransitionClearRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const section = parseSettingsSectionId(searchParams.get("section"));
    if (section) setActiveSection(section);
  }, [searchParams]);

  if (!isClient || !hasToken) return <div className={styles.page} />;

  return (
    <SettingsProvider>
      <section className={styles.page}>
        <div className={styles.settingsFeed}>
          <div className={styles.settingsFeedInner}>
            <div
              key={`${activeSection}-${panelAnimEpoch}`}
              className={`${styles.settingsSectionPanel} ${
                panelTransition === "fade" ? styles.settingsSectionPanelFade : ""
              }`}
            >
              <SettingsSectionContent section={activeSection} />
            </div>
          </div>
        </div>
        <SettingsSidebar activeSection={activeSection} onSectionChange={switchSection} />
        <SettingsLeaveGuard />
      </section>
    </SettingsProvider>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className={styles.page} />}>
      <SettingsPageContent />
    </Suspense>
  );
}
