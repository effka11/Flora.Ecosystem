"use client";

import type { ReactNode } from "react";
import CommunitiesPage from "@/app/(dashboard)/communities/page";
import { CommunityProfileView } from "@/app/(dashboard)/communities/CommunityProfileView";
import { CommunitySettingsView } from "@/app/(dashboard)/communities/settings/CommunitySettingsView";
import CommunityOwnPage from "@/app/(dashboard)/communities/own/page";
import ComposePostPage from "@/app/(dashboard)/compose/page";
import FeedPage from "@/app/(dashboard)/feed/page";
import MessagesPage from "@/app/(dashboard)/messages/page";
import MusicPage from "@/app/(dashboard)/music/page";
import { MusicPlaylistView } from "@/app/(dashboard)/music/MusicPlaylistView";
import NotificationsPage from "@/app/(dashboard)/notifications/page";
import PeoplePage from "@/app/(dashboard)/people/page";
import ProfilePage from "@/app/(dashboard)/profile/page";
import { UserPublicProfileView } from "@/app/(dashboard)/profile/[username]/UserPublicProfileView";
import SettingsPage from "@/app/(dashboard)/settings/page";

function cleanDashboardPath(path: string): string {
  return path.split("?")[0]?.split("#")[0] ?? path;
}

function profileSlugFromPath(path: string): string | null {
  const match = path.match(/^\/profile\/([^/]+)/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]).trim().replace(/^@+/, "");
  } catch {
    return null;
  }
}

function communityIdFromPath(path: string): string | null {
  const match = path.match(/^\/communities\/([^/]+)/);
  return match?.[1] ?? null;
}

function communitySettingsRouteKeyFromPath(path: string): string | null {
  const match = path.match(/^\/communities\/([^/]+)\/settings$/);
  return match?.[1] ?? null;
}

function musicPlaylistIdFromPath(path: string): string | null {
  const match = path.match(/^\/music\/playlist\/([^/]+)/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function resolveDashboardRouteView(path: string): ReactNode | null {
  const clean = cleanDashboardPath(path);

  switch (clean) {
    case "/feed":
      return <FeedPage />;
    case "/compose":
      return <ComposePostPage />;
    case "/messages":
      return <MessagesPage />;
    case "/people":
      return <PeoplePage />;
    case "/communities":
      return <CommunitiesPage />;
    case "/communities/own":
      return <CommunityOwnPage />;
    case "/music":
      return <MusicPage />;
    case "/notifications":
      return <NotificationsPage />;
    case "/profile":
      return <ProfilePage />;
    case "/settings":
      return <SettingsPage />;
    default:
      break;
  }

  const playlistId = musicPlaylistIdFromPath(clean);
  if (playlistId) {
    return <MusicPlaylistView playlistId={playlistId} />;
  }

  const profileSlug = profileSlugFromPath(clean);
  if (profileSlug) {
    return <UserPublicProfileView usernameSlug={profileSlug} />;
  }

  const communitySettingsRouteKey = communitySettingsRouteKeyFromPath(clean);
  if (communitySettingsRouteKey && communitySettingsRouteKey !== "own") {
    return <CommunitySettingsView routeKey={communitySettingsRouteKey} />;
  }

  const communityRouteKey = communityIdFromPath(clean);
  if (communityRouteKey && communityRouteKey !== "own" && !clean.endsWith("/settings")) {
    return <CommunityProfileView routeKey={communityRouteKey} />;
  }

  return null;
}

export function canInstantRenderDashboardPath(path: string): boolean {
  return resolveDashboardRouteView(path) !== null;
}

export function DashboardRouteViews({ path }: { path: string }) {
  return resolveDashboardRouteView(path);
}
