"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import {
  getAccessToken,
  hasPendingProfileSetup,
  SESSION_CLEARED_EVENT,
  STORAGE_ACCESS,
  STORAGE_REFRESH,
} from "@/lib/auth";

function useIsClient() {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );
}

export function useProtectedPage() {
  const router = useRouter();
  const isClient = useIsClient();
  const hasToken = isClient && Boolean(getAccessToken());

  useEffect(() => {
    if (!isClient) return;
    if (!hasToken) router.replace("/login");
  }, [hasToken, isClient, router]);

  useEffect(() => {
    if (!isClient || !hasToken) return;
    if (!hasPendingProfileSetup()) return;
    router.replace("/login");
  }, [hasToken, isClient, router]);

  useEffect(() => {
    if (!isClient) return;

    const onSessionCleared = () => {
      if (!getAccessToken()) router.replace("/login");
    };

    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== localStorage) return;
      if (event.key !== STORAGE_ACCESS && event.key !== STORAGE_REFRESH && event.key !== null) {
        return;
      }
      if (!getAccessToken()) router.replace("/login");
    };

    window.addEventListener(SESSION_CLEARED_EVENT, onSessionCleared);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(SESSION_CLEARED_EVENT, onSessionCleared);
      window.removeEventListener("storage", onStorage);
    };
  }, [isClient, router]);

  return { isClient, hasToken };
}
