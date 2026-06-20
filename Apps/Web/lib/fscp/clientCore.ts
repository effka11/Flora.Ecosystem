import { configureApiClient, getApiClientConfig } from "@flora/client-core/api";
import { configureSodiumLoader, type SodiumModule } from "@flora/client-core/fscp";
import {
  clearPendingProfileSetup,
  clearSession,
  getAccessToken,
  hasPendingProfileSetup,
  resolvePublicApiRoot,
  saveSession,
  setPendingProfileSetup,
} from "@/lib/auth";

function isApiClientConfigured(): boolean {
  try {
    getApiClientConfig();
    return true;
  } catch {
    return false;
  }
}

const webSessionStore = {
  async getAccessToken() {
    return getAccessToken();
  },
  async getRefreshToken() {
    if (typeof window === "undefined") return null;
    return localStorage.getItem("flora_refresh_token");
  },
  async saveSession(tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
  }) {
    saveSession(tokens);
  },
  async clearSession() {
    clearSession();
  },
  async hasPendingProfileSetup() {
    return hasPendingProfileSetup();
  },
  async setPendingProfileSetup(value: boolean) {
    if (value) setPendingProfileSetup();
    else clearPendingProfileSetup();
  },
};

export async function initWebClientCore(): Promise<void> {
  if (isApiClientConfigured()) return;

  configureApiClient({
    apiBaseUrl: resolvePublicApiRoot(),
    session: webSessionStore,
    clientIdentity: {
      platform: "web",
      appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? "0.1.0-alpha",
    },
    onUnauthorized: () => {
      clearSession();
      if (typeof window !== "undefined") {
        window.location.href = "/login";
      }
    },
  });

  configureSodiumLoader(async () => {
    const mod = await import("libsodium-wrappers-sumo");
    await mod.default.ready;
    return mod.default as unknown as SodiumModule;
  });
}
