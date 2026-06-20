import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import NetInfo from "@react-native-community/netinfo";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { OfflineBanner } from "@/components/OfflineBanner";
import { initFloraClient } from "@/lib/api";
import {
  handleColdStartPushNavigation,
  installPushNotificationListeners,
  registerPushTokenWithServer,
  unregisterPushTokenFromServer,
} from "@/lib/pushNotifications";
import { isNativePushEnabled } from "@/lib/pushCapabilities";
import { FloraAppServices, QueryClientRefBridge } from "@/providers/FloraAppServices";
import { initMobileSodium } from "@/lib/fscp/sodium";
import { initStorageMigrations } from "@/lib/mmkv";
import { initSentry, initTelemetry } from "@/lib/sentry";
import { useSessionStore } from "@/stores/sessionStore";
import { useFscpStore } from "@/stores/fscpStore";

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 15_000,
    },
  },
});

export function FloraProviders({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const bootstrapSession = useSessionStore((s) => s.bootstrap);
  const isAuthenticated = useSessionStore((s) => s.isAuthenticated);
  const userUuid = useSessionStore((s) => s.me?.userUuid ?? null);
  const prevUserUuidRef = useRef<string | null>(null);
  const coldStartPushHandledRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const started = Date.now();
      initSentry();
      initTelemetry();
      initFloraClient();
      await initStorageMigrations();
      await initMobileSodium();
      await bootstrapSession();
      const session = useSessionStore.getState();
      if (session.isAuthenticated && session.me?.userUuid) {
        const fscp = useFscpStore.getState();
        const norm = session.me.userUuid.trim().toLowerCase();
        const alreadyReady =
          fscp.passwordSyncedForOwner === norm ||
          (fscp.ownerUserUuid === norm && fscp.status === "ready");
        if (!alreadyReady) {
          await useFscpStore.getState().bootstrap(session.me.userUuid);
        }
      }
      if (!cancelled) {
        setReady(true);
        if (__DEV__) console.debug("[bootstrap]", Date.now() - started, "ms");
        void SplashScreen.hideAsync().catch(() => undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bootstrapSession]);

  useEffect(() => {
    if (!ready || !isAuthenticated || !userUuid) return;

    const norm = userUuid.trim().toLowerCase();
    if (prevUserUuidRef.current !== null && prevUserUuidRef.current !== norm) {
      useFscpStore.getState().clearRuntimeState();
      void useFscpStore.getState().bootstrap(userUuid);
    }
    prevUserUuidRef.current = norm;
  }, [ready, isAuthenticated, userUuid]);

  useEffect(() => {
    if (!ready) return;

    const retryIfPending = () => {
      const fscp = useFscpStore.getState();
      if (fscp.status === "registration_pending") {
        void fscp.retryPendingOperation();
      }
    };

    const appSub = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state === "active") retryIfPending();
    });

    const netSub = NetInfo.addEventListener((state) => {
      if (state.isConnected) retryIfPending();
    });

    return () => {
      appSub.remove();
      netSub();
    };
  }, [ready]);

  useEffect(() => {
    if (!ready || !isAuthenticated || !isNativePushEnabled()) return;

    const syncPush = () => {
      void registerPushTokenWithServer().catch(() => undefined);
    };

    syncPush();
    if (!coldStartPushHandledRef.current) {
      coldStartPushHandledRef.current = true;
      void handleColdStartPushNavigation().catch(() => undefined);
    }
    const removePushListeners = installPushNotificationListeners();

    const appSub = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state === "active") syncPush();
    });

    return () => {
      removePushListeners();
      appSub.remove();
    };
  }, [ready, isAuthenticated]);

  useEffect(() => {
    if (ready && !isAuthenticated) {
      void unregisterPushTokenFromServer().catch(() => undefined);
    }
  }, [ready, isAuthenticated]);

  if (!ready) return null;

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <QueryClientRefBridge client={queryClient} />
        <FloraAppServices enabled={isAuthenticated} />
        <OfflineBanner />
        {children}
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
