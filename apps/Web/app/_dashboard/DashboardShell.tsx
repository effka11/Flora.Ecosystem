"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { flushSync } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { FloraLogoMark } from "@/app/_shared/FloraLogoMark";
import { GridOverlay } from "@/app/_shared/GridOverlay";
import { useViewportFrameCssVars } from "@/app/_shared/viewportFrame";
import { CurrentUserProvider, useCurrentUser } from "@/app/_dashboard/CurrentUserContext";
import { FscpMobileBackupCallout } from "@/app/_dashboard/FscpMobileBackupCallout";
import { FscpUnlockModal } from "@/app/_dashboard/FscpUnlockModal";
import {
  canInstantRenderDashboardPath,
  DashboardRouteViews
} from "@/app/_dashboard/DashboardRouteViews";
import {
  tryDashboardNavigation,
  setDashboardNavigationPerform,
} from "@/app/_dashboard/dashboardLeaveGuard";
import {
  DASHBOARD_COMPOSE_PATH,
  DASHBOARD_INSTANT_PREFETCH,
  DASHBOARD_ROUTE_TRANSITION_CLEAR_MS,
  type DashboardRouteTransition,
  contentRoutePanelKey,
  isDashboardNavHref,
  isDashboardRouteActive,
  isDashboardSettingsLayoutPath,
  isMusicSectionPath,
  prefersReducedDashboardMotion,
  routeTransitionDirection,
  stripDashboardHref
} from "@/app/_dashboard/dashboardRouteTransition";
import { useDashboardDataPrefetch } from "@/app/_dashboard/useDashboardDataPrefetch";
import { useSessionKeepAlive } from "@/app/_dashboard/useSessionKeepAlive";
import { startTabPrefetch } from "@/lib/dashboardPreload";
import { useDashboardRealtime } from "@/app/_dashboard/useDashboardRealtime";
import { useMessagesUnreadCount } from "@/app/_dashboard/useMessagesUnreadCount";
import { useNotificationsUnreadCount } from "@/app/_dashboard/useNotificationsUnreadCount";
import { notifyMessagesPopToList } from "@/lib/messagingApi";
import { formatNavBadge } from "@/lib/formatNavBadge";
import { formatAtHandle, profileDisplayName } from "@/app/_dashboard/userDisplay";
import { AccountBlockedWall } from "@/app/_dashboard/AccountBlockedWall";
import { FloraAvatar } from "@/app/_shared/FloraAvatar";
import { FloraDocumentTitleProvider } from "@/app/_shared/useFloraDocumentTitle";
import { MusicNavIcon } from "@/app/_dashboard/icons/MusicNavIcon";
import { MusicMiniPlayer } from "@/app/(dashboard)/music/player/MusicMiniPlayer";
import { MusicPlayerProvider } from "@/app/(dashboard)/music/player/MusicPlayerProvider";
import styles from "./dashboardShell.module.css";

type DashboardShellProps = {
  children: React.ReactNode;
};

type NavItem = {
  href: string;
  label: string;
  icon: React.ReactNode | null;
  iconClassName?: string;
};

const navItems: NavItem[] = [
  {
    href: "/feed",
    label: "Главная",
    icon: (
      <path d="M12 2L2 10v12h7v-6h6v6h7V10L12 2z" />
    )
  },
  {
    href: "/messages",
    label: "Сообщения",
    iconClassName: styles.navIconMessages,
    icon: <path d="M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3l2.5 4.5 2.5-4.5H19a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z" />
  },
  {
    href: "/people",
    label: "Люди",
    iconClassName: styles.navIconPeople,
    icon: <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z" />
  },
  {
    href: "/communities",
    label: "Сообщества",
    iconClassName: styles.navIconCommunities,
    icon: (
      <>
        <path d="m 468.5,-0.5 c 10.182,15.7071 17.682,32.7071 22.5,51 14.82,49.839 18.82,100.505 12,152 -6.136,38.781 -23.636,71.281 -52.5,97.5 -9.791,8.726 -20.125,16.726 -31,24 -20.012,11.674 -40.346,22.841 -61,33.5 -5.047,-17.639 -8.68359,-31.79237 -16.30359,-48.48637 C 339.86777,303.31115 331.667,290.833 331.5,290.5 c 9.47518,-15.50394 38.41171,-12.81385 111.45787,-132.58612 0.50434,-0.89875 1.00561,-1.7994 1.5038,-2.70195 4.03394,-7.30798 7.86648,-14.74043 11.4962,-22.29805 0.671,-5.644 -1.829,-8.977 -7.5,-10 -2.714,0.44 -4.88,1.774 -6.5,4 -15.271,29.414 -33.105,57.081 -53.5,83 -25.19441,31.18979 -32.32882,38.7519 -66.95787,66.58612 -13.701,-16.698 -29.367,-31.365 -47,-44 7.594,-19.09 18.927,-35.59 34,-49.5 28.25,-22.246 55.917,-45.246 83,-69 20.072,-18.7261 37.906,-39.2261 53.5,-61.5 10.063,-16.3586 23.5,-53 23.5,-53 z" />
        <path d="m 343.5,511.5 c -0.131,-0.003 -6.05445,-1.45517 -7,-6.5 C 341.493,447.648 320.74463,394.69938 282.62548,352.56801 257.38782,325.52523 224.85509,308.94062 194.5,286 159.954,259.123 115.91525,238.95695 87.128253,205.83395 c -8.9478,-4.274 -13.1145,-1.44 -12.5,8.5 1.6667,2.333 3.3333,4.667 5,7 C 111.66125,256.37295 158.867,278.373 196.5,307 c 28.6749,21.53576 43.3548,27.8791 70.21437,54.93494 C 307.44723,410.21666 322.915,454.58 322.5,491.5 305.571,477.862 286.904,467.029 266.5,459 232.891,448.514 199.224,438.181 165.5,428 132.779,416.312 102.779,399.979 75.5,379 59.1627,363.179 46.6627,344.679 38,323.5 23.0021,285.508 13.3355,246.175 9,205.5 4.93041,170.273 3.59708,134.939 5,99.5 c 0.54659,-14.4663 2.21326,-28.7997 5,-43 6.712144,-32.483659 -7.5907512,-10.117391 49,58 30.49,30.814 64.657,56.647 102.5,77.5 33.657,17.829 67.657,35.162 102,52 42.174,28.24 68.674,67.407 79.5,117.5 11.123,49.974 11.29,99.974 0.5,150 z" />
      </>
    )
  },
  {
    href: "/music",
    label: "Музыка",
    iconClassName: styles.navIconMusic,
    icon: null
  },
  {
    href: "/notifications",
    label: "Уведомления",
    iconClassName: styles.navIconNotifications,
    icon: <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z" />
  }
];

function myProfileHrefFromMe(_username: string | undefined): string {
  return "/profile";
}

type DashboardSidebarProps = {
  displayPath: string;
  onNavigateDashboard: (href: string) => void;
};

function navUnreadBadgeCount(
  href: string,
  unreadMessages: number,
  unreadNotifications: number
): number {
  if (href === "/messages") return unreadMessages;
  if (href === "/notifications") return unreadNotifications;
  return 0;
}

function DashboardSidebar({ displayPath, onNavigateDashboard }: DashboardSidebarProps) {
  const { me, loading } = useCurrentUser();
  const unreadMessages = useMessagesUnreadCount(!loading && Boolean(me));
  const unreadNotifications = useNotificationsUnreadCount(!loading && Boolean(me));

  const handleLabel = me ? formatAtHandle(me.username) : loading ? "…" : "@…";
  const displayNameLabel = me ? profileDisplayName(me.displayName, me.username) : loading ? "…" : "Профиль";
  const myProfileHref = myProfileHrefFromMe(me?.username);

  const handleDashboardNavClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const href = event.currentTarget.getAttribute("href");
    if (!href || !isDashboardNavHref(href)) return;
    event.preventDefault();
  };

  const handleSidebarPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const anchor = (event.target as HTMLElement).closest("a[href]");
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (!href || !isDashboardNavHref(href)) return;
    startTabPrefetch(href, { username: me?.username, viewerUuid: me?.userUuid });
    onNavigateDashboard(href);
  };

  const handleNavPointerOver = (href: string) => {
    startTabPrefetch(href, { username: me?.username, viewerUuid: me?.userUuid });
  };

  return (
    <aside className={styles.sidebar} onPointerDownCapture={handleSidebarPointerDown}>
      <Link href="/feed" className={styles.logo} aria-label="Flora главная">
        <FloraLogoMark />
        <span className={styles.logoText}>FLORA</span>
      </Link>

      <ul className={styles.navList}>
        {navItems.map((item) => {
          const isActive =
            isDashboardRouteActive(displayPath, item.href);
          const badgeCount = navUnreadBadgeCount(
            item.href,
            unreadMessages,
            unreadNotifications
          );
          const badgeLabel = formatNavBadge(badgeCount);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={`${styles.navLink} flora-type-16 ${isActive ? styles.navLinkActive : ""}`}
                onClick={handleDashboardNavClick}
                onPointerOver={() => handleNavPointerOver(item.href)}
              >
                <span className={styles.navIconWrap}>
                  {item.href === "/music" ? (
                    <MusicNavIcon className={`${styles.navIcon} ${item.iconClassName ?? ""}`} />
                  ) : (
                    <svg
                      className={`${styles.navIcon} ${item.iconClassName ?? ""}`}
                      viewBox={item.href === "/communities" ? "0 0 512 512" : "0 0 24 24"}
                      fill="currentColor"
                      aria-hidden
                    >
                      {item.icon}
                    </svg>
                  )}
                  {badgeLabel ? (
                    <span className={styles.navIconBadge} aria-label={`Непрочитанных: ${badgeCount}`}>
                      {badgeLabel}
                    </span>
                  ) : null}
                </span>
                <span className={styles.navText}>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>

      <Link
        href={DASHBOARD_COMPOSE_PATH}
        className={`${styles.postCta} flora-type-16 ${isDashboardRouteActive(displayPath, DASHBOARD_COMPOSE_PATH) ? styles.navLinkActive : ""}`}
        onClick={handleDashboardNavClick}
        aria-label="Создать пост"
      >
        <svg className={styles.navIcon} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zm18-11.5a1 1 0 0 0 0-1.41l-1.34-1.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75L21 5.75z" />
        </svg>
        <span className={styles.navText}>Создать пост</span>
      </Link>

      <div className={styles.sidebarBottom}>
        <Link
          href="/settings"
          className={styles.settingsLink}
          aria-label="Настройки"
          onClick={handleDashboardNavClick}
          onPointerOver={() => handleNavPointerOver("/settings")}
        >
          <svg className={styles.settingsIcon} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.04.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
          </svg>
        </Link>
        <div className={styles.userCard}>
          <FloraAvatar
            href={myProfileHref}
            avatarUuid={me?.avatarUuid}
            displayName={displayNameLabel}
            username={me?.username ?? ""}
            seed={me?.userUuid}
            accountBlocked={me?.accountBlocked}
            className={`${styles.avatar} ${styles.avatarLink}`}
            onLinkClick={handleDashboardNavClick}
          />
          <div className={styles.userMeta}>
            <Link
              href={myProfileHref}
              className={styles.userProfileStackLink}
              aria-label={me ? `Профиль: ${displayNameLabel}, ${handleLabel}` : "Мой профиль"}
              onClick={handleDashboardNavClick}
              onPointerOver={() => handleNavPointerOver("/profile")}
            >
              <span className={`${styles.userDisplayName} flora-type-15`}>{displayNameLabel}</span>
              <span className={`${styles.userAtHandle} flora-type-15`}>{handleLabel}</span>
            </Link>
          </div>
        </div>
      </div>
    </aside>
  );
}

type DashboardMainContentProps = {
  children: React.ReactNode;
  displayPath: string;
  useInstantViews: boolean;
  routeTransition: DashboardRouteTransition | null;
};

function DashboardMainContent({
  children,
  displayPath,
  useInstantViews,
  routeTransition
}: DashboardMainContentProps) {
  const allowVerticalOverflow =
    displayPath === "/messages" ||
    displayPath.startsWith("/messages/") ||
    isDashboardSettingsLayoutPath(displayPath) ||
    isDashboardRouteActive(displayPath, DASHBOARD_COMPOSE_PATH);

  const panelClassName =
    routeTransition === "fromLeft"
      ? styles.contentInnerRouteInFromLeft
      : routeTransition === "fromRight"
        ? styles.contentInnerRouteInFromRight
        : "";

  const instantView =
    useInstantViews &&
    !isMusicSectionPath(displayPath) &&
    canInstantRenderDashboardPath(displayPath) ? (
      <DashboardRouteViews path={displayPath} />
    ) : null;

  return (
    <section
      className={`${styles.content} ${allowVerticalOverflow ? styles.contentMessagesOverflow : ""}`}
    >
      <div className={styles.contentInner}>
        {displayPath === "/messages" || displayPath.startsWith("/messages/") ? (
          <FscpMobileBackupCallout />
        ) : null}
        <div key={contentRoutePanelKey(displayPath)} className={`${styles.contentRoutePanel} ${panelClassName}`}>
          {instantView ?? children}
        </div>
      </div>
    </section>
  );
}

function DashboardShellInner({ children }: DashboardShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { me, loading } = useCurrentUser();
  useDashboardRealtime(!loading && Boolean(me) && me?.accountBlocked !== true, me?.userUuid);
  useDashboardDataPrefetch();
  useSessionKeepAlive();
  useViewportFrameCssVars(true);

  const [displayPath, setDisplayPath] = useState(() => stripDashboardHref(pathname));
  const [useInstantViews, setUseInstantViews] = useState(false);
  const [routeTransition, setRouteTransition] = useState<DashboardRouteTransition | null>(null);
  const routeTransitionClearRef = useRef<number | null>(null);

  useEffect(() => {
    setDisplayPath(stripDashboardHref(pathname));
  }, [pathname]);

  useEffect(() => {
    for (const href of DASHBOARD_INSTANT_PREFETCH) {
      router.prefetch(href);
    }
    const slug = (me?.username ?? "").trim().replace(/^@+/, "");
    if (slug) {
      router.prefetch(`/profile/${encodeURIComponent(slug)}`);
    }
  }, [router, me?.username]);

  const scheduleClearRouteTransition = useCallback(() => {
    if (routeTransitionClearRef.current !== null) {
      window.clearTimeout(routeTransitionClearRef.current);
    }
    routeTransitionClearRef.current = window.setTimeout(() => {
      setRouteTransition(null);
      routeTransitionClearRef.current = null;
    }, DASHBOARD_ROUTE_TRANSITION_CLEAR_MS);
  }, []);

  const applyRouteTransition = useCallback(
    (next: DashboardRouteTransition) => {
      if (routeTransitionClearRef.current !== null) {
        window.clearTimeout(routeTransitionClearRef.current);
        routeTransitionClearRef.current = null;
      }
      flushSync(() => setRouteTransition(next));
      scheduleClearRouteTransition();
    },
    [scheduleClearRouteTransition]
  );

  const performDashboardNavigation = useCallback(
    (href: string) => {
      const path = stripDashboardHref(href);
      if (isDashboardRouteActive(displayPath, href)) return;

      const dir = routeTransitionDirection(displayPath, href);

      flushSync(() => {
        setUseInstantViews(true);
        setDisplayPath(path);
        if (!prefersReducedDashboardMotion()) {
          applyRouteTransition(dir);
        }
      });

      router.push(href, { scroll: false });
    },
    [applyRouteTransition, displayPath, router],
  );

  useEffect(() => {
    setDashboardNavigationPerform(performDashboardNavigation);
    return () => setDashboardNavigationPerform(null);
  }, [performDashboardNavigation]);

  const navigateDashboard = useCallback(
    (href: string) => {
      const path = stripDashboardHref(href);
      if (isDashboardRouteActive(displayPath, href)) {
        // Re-tap «Сообщения» while a thread is open → always return to chat list root.
        if (path === "/messages") notifyMessagesPopToList();
        return;
      }

      tryDashboardNavigation(path, () => performDashboardNavigation(href));
    },
    [displayPath, performDashboardNavigation],
  );

  useEffect(
    () => () => {
      if (routeTransitionClearRef.current !== null) {
        window.clearTimeout(routeTransitionClearRef.current);
      }
    },
    []
  );

  const showAccountBlockWall = !loading && me?.accountBlocked === true;

  return (
    <main className={styles.page}>
      <GridOverlay />

      <div className={styles.appRoot}>
        {showAccountBlockWall ? (
          <AccountBlockedWall accountBlockedUntil={me?.accountBlockedUntil} />
        ) : (
          <>
            <DashboardSidebar displayPath={displayPath} onNavigateDashboard={navigateDashboard} />
            <DashboardMainContent
              displayPath={displayPath}
              useInstantViews={useInstantViews}
              routeTransition={routeTransition}
            >
              {children}
            </DashboardMainContent>
            <MusicMiniPlayer />
          </>
        )}
      </div>
      {!showAccountBlockWall ? <FscpUnlockModal /> : null}
    </main>
  );
}

export function DashboardShell({ children }: DashboardShellProps) {
  return (
    <CurrentUserProvider>
      <MusicPlayerProvider>
        <FloraDocumentTitleProvider>
          <DashboardShellInner>{children}</DashboardShellInner>
        </FloraDocumentTitleProvider>
      </MusicPlayerProvider>
    </CurrentUserProvider>
  );
}
