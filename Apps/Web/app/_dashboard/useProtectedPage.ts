"use client";

import { useEffect, useSyncExternalStore } from "react";
import {
  getAccessToken,
  hasPendingProfileSetup,
  SESSION_CLEARED_EVENT,
  STORAGE_ACCESS,
  STORAGE_REFRESH,
  STORAGE_SESSION,
} from "@/lib/auth";
import { redirectToLogin } from "@/lib/loginRedirect";
import { webSessionStore } from "@/lib/sessionStore";

function subscribeSessionToken(onStoreChange: () => void): () => void {
  const unsubCleared = webSessionStore.subscribeSessionCleared(onStoreChange);

  const onSessionClearedEvent = () => onStoreChange();
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
    onStoreChange();
  };

  window.addEventListener(SESSION_CLEARED_EVENT, onSessionClearedEvent);
  window.addEventListener("storage", onStorage);
  return () => {
    unsubCleared();
    window.removeEventListener(SESSION_CLEARED_EVENT, onSessionClearedEvent);
    window.removeEventListener("storage", onStorage);
  };
}

function getHasTokenSnapshot(): boolean {
  return Boolean(getAccessToken());
}

function getServerHasTokenSnapshot(): boolean {
  return false;
}

export function useProtectedPage() {
  const isClient = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const hasToken = useSyncExternalStore(
    subscribeSessionToken,
    getHasTokenSnapshot,
    getServerHasTokenSnapshot,
  );

  useEffect(() => {
    if (!isClient) return;
    if (!hasToken) redirectToLogin();
  }, [hasToken, isClient]);

  useEffect(() => {
    if (!isClient || !hasToken) return;
    if (!hasPendingProfileSetup()) return;
    redirectToLogin();
  }, [hasToken, isClient]);

  return { isClient, hasToken: isClient && hasToken };
}
