"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useProtectedPage } from "@/app/_dashboard/useProtectedPage";
import { communityHref, isOwnedCommunityId } from "@/app/(dashboard)/communities/communitiesSeed";
import { isCommunityUuid } from "@/app/(dashboard)/communities/communityProfile";
import { apiGetCommunityBySlug, apiListOwnedCommunities, type CommunityProfileDto } from "@/lib/socialApi";
import { CommunitySettingsSidebar } from "./CommunitySettingsSidebar";
import { CommunitySettingsProvider } from "./CommunitySettingsContext";
import { CommunitySettingsLeaveGuard } from "./CommunitySettingsLeaveGuard";
import { CommunitySettingsGeneralTab } from "./CommunitySettingsGeneralTab";
import { CommunitySettingsPrivacyTab } from "./CommunitySettingsPrivacyTab";
import { CommunitySettingsDangerTab } from "./CommunitySettingsDangerTab";
import {
  DEFAULT_COMMUNITY_SETTINGS_SECTION,
  parseCommunitySettingsSectionId,
  type CommunitySettingsSectionId,
} from "./communitySettingsSections";
import styles from "@/app/(dashboard)/settings/settings.module.css";

const SETTINGS_PANEL_TRANSITION_CLEAR_MS = 950;

type SettingsPanelTransition = null | "fade";

async function resolveCommunitySlug(routeKey: string): Promise<string> {
  const trimmed = routeKey.trim();
  if (!isCommunityUuid(trimmed)) return trimmed;

  const owned = await apiListOwnedCommunities();
  const match = owned.find((c) => c.communityId.toLowerCase() === trimmed.toLowerCase());
  if (!match?.slug) throw new Error("Сообщество не найдено.");
  return match.slug;
}

function CommunitySettingsSectionContent({ section }: { section: CommunitySettingsSectionId }) {
  switch (section) {
    case "general":
      return <CommunitySettingsGeneralTab />;
    case "privacy":
      return <CommunitySettingsPrivacyTab />;
    case "danger":
      return <CommunitySettingsDangerTab />;
    default:
      return <p className={styles.settingsPlaceholderCard}>Раздел в разработке.</p>;
  }
}

function CommunitySettingsPageInner({ routeKey }: { routeKey: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [community, setCommunity] = useState<CommunityProfileDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [activeSection, setActiveSection] = useState<CommunitySettingsSectionId>(() => {
    return parseCommunitySettingsSectionId(searchParams.get("section")) ?? DEFAULT_COMMUNITY_SETTINGS_SECTION;
  });
  const [panelTransition, setPanelTransition] = useState<SettingsPanelTransition>(null);
  const [panelAnimEpoch, setPanelAnimEpoch] = useState(0);
  const panelTransitionClearRef = useRef<number | null>(null);

  const loadCommunity = useCallback(async () => {
    setLoading(true);
    setForbidden(false);
    try {
      const slug = await resolveCommunitySlug(routeKey);
      const profile = await apiGetCommunityBySlug(slug);
      if (profile.role !== "Owner") {
        setForbidden(true);
        setCommunity(null);
        return;
      }
      if (isCommunityUuid(routeKey) && profile.slug) {
        router.replace(`${communityHref({ id: profile.communityId, slug: profile.slug })}/settings`);
      }
      setCommunity(profile);
    } catch {
      setCommunity(null);
    } finally {
      setLoading(false);
    }
  }, [routeKey, router]);

  useEffect(() => {
    void loadCommunity();
  }, [loadCommunity]);

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
    (next: CommunitySettingsSectionId) => {
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
    const section = parseCommunitySettingsSectionId(searchParams.get("section"));
    if (section) setActiveSection(section);
  }, [searchParams]);

  if (loading) {
    return <section className={styles.page} />;
  }

  if (forbidden) {
    return (
      <section className={styles.page}>
        <div className={styles.settingsFeed}>
          <div className={styles.settingsFeedInner}>
            <p className={styles.settingsPlaceholderCard}>Настройки доступны только владельцу сообщества.</p>
          </div>
        </div>
      </section>
    );
  }

  if (!community) {
    return (
      <section className={styles.page}>
        <div className={styles.settingsFeed}>
          <div className={styles.settingsFeedInner}>
            <p className={styles.settingsPlaceholderCard}>Сообщество не найдено.</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <CommunitySettingsProvider community={community} reload={loadCommunity}>
      <section className={styles.page}>
        <div className={styles.settingsFeed}>
          <div className={styles.settingsFeedInner}>
            <div
              key={`${activeSection}-${panelAnimEpoch}`}
              className={`${styles.settingsSectionPanel} ${
                panelTransition === "fade" ? styles.settingsSectionPanelFade : ""
              }`}
            >
              <CommunitySettingsSectionContent section={activeSection} />
            </div>
          </div>
        </div>
        <CommunitySettingsSidebar
          communitySlug={community.slug}
          communityId={community.communityId}
          activeSection={activeSection}
          onSectionChange={switchSection}
        />
        <CommunitySettingsLeaveGuard />
      </section>
    </CommunitySettingsProvider>
  );
}

export function CommunitySettingsView({ routeKey }: { routeKey: string }) {
  const { isClient, hasToken } = useProtectedPage();

  if (isOwnedCommunityId(routeKey)) {
    return <section className={styles.page} />;
  }

  if (!isClient || !hasToken) {
    return <section className={styles.page} />;
  }

  return (
    <Suspense fallback={<section className={styles.page} />}>
      <CommunitySettingsPageInner routeKey={routeKey} />
    </Suspense>
  );
}
