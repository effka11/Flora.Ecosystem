"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import {
  getAccessToken,
  hasPendingProfileSetup,
  SESSION_CLEARED_EVENT,
  STORAGE_ACCESS,
  STORAGE_REFRESH,
  STORAGE_SESSION,
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
    let redirected = false;

    const redirectIfCleared = () => {
      if (redirected || getAccessToken()) return;
      redirected = true;
      router.replace("/login");
    };

    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== localStorage) return;
      if (
        event.key !== STORAGE_SESSION &&
        event.key !== STORAGE_ACCESS &&
        event.key !== STORAGE_REFRESH &&
        event.key !== null
      ) {
        return;
      }
      redirectIfCleared();
    };

    window.addEventListener(SESSION_CLEARED_EVENT, redirectIfCleared);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(SESSION_CLEARED_EVENT, redirectIfCleared);
      window.removeEventListener("storage", onStorage);
    };
  }, [isClient, router]);

  return { isClient, hasToken };
}
