import { configureApiClient, primeApiBaseUrl } from "@flora/client-core/api";
import { createPollingSignalsProvider } from "@flora/client-core/signals";
import { configureTelemetry, getTelemetry } from "@flora/client-core/telemetry";
import Constants from "expo-constants";
import { router } from "expo-router";
import { mobileSessionStore, resolveApiBaseUrl } from "./session";
import { useSessionStore } from "@/stores/sessionStore";

/** Повторный вызов безопасен (HMR сбрасывает _config в client-core, но не этот модуль). */
export function initFloraClient(): void {
  const apiBaseUrl = resolveApiBaseUrl();
  primeApiBaseUrl(apiBaseUrl);
  configureApiClient({
    apiBaseUrl,
    session: mobileSessionStore,
    clientIdentity: {
      platform: "android",
      appVersion: Constants.expoConfig?.version ?? "0.1.0-alpha",
    },
    onUnauthorized: () => {
      router.replace("/(auth)/login");
    },
    onUpgradeRequired: () => {
      router.replace("/upgrade-required");
    },
    onPascalFallback: (key) => {
      getTelemetry().capture({ type: "pascal_case_fallback", key });
      if (__DEV__) console.warn("[pascal-fallback]", key);
    },
  });
}

// До первого render/effect: avatarImageUrl/postImageUrl и прочие apiUrl() не падают.
initFloraClient();

export const signalsProvider = createPollingSignalsProvider({
  enabled: () => useSessionStore.getState().isAuthenticated,
});

export { configureTelemetry, getTelemetry };
