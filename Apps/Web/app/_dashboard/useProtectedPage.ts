"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { getAccessToken, hasPendingProfileSetup } from "@/lib/auth";

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

  return { isClient, hasToken };
}
