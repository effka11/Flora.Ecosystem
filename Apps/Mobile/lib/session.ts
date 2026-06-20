import * as SecureStore from "expo-secure-store";
import type { SessionStore, SessionTokens } from "@flora/client-core/auth";

const ACCESS = "flora_access_token";
const REFRESH = "flora_refresh_token";
const EXPIRES = "flora_expires_at";
const PENDING_PROFILE = "flora_pending_profile_setup";

export function resolveApiBaseUrl(): string {
  // Metro / dev-client: always local Flora.API (JS bundle still from Metro on :8081).
  // USB: adb reverse tcp:5284 tcp:5284 (see Scripts/mobile-debug-usb.ps1).
  if (__DEV__) {
    return "http://localhost:5284";
  }

  const explicit = process.env.EXPO_PUBLIC_API_URL?.trim().replace(/\/+$/, "");
  if (explicit) return explicit;

  throw new Error("EXPO_PUBLIC_API_URL must be set for release builds.");
}

export const mobileSessionStore: SessionStore = {
  async getAccessToken() {
    return SecureStore.getItemAsync(ACCESS);
  },
  async getRefreshToken() {
    return SecureStore.getItemAsync(REFRESH);
  },
  async saveSession(tokens: SessionTokens) {
    await SecureStore.setItemAsync(ACCESS, tokens.accessToken);
    await SecureStore.setItemAsync(REFRESH, tokens.refreshToken);
    await SecureStore.setItemAsync(EXPIRES, tokens.expiresAt);
  },
  async clearSession(clearKeys = false) {
    await SecureStore.deleteItemAsync(ACCESS);
    await SecureStore.deleteItemAsync(REFRESH);
    await SecureStore.deleteItemAsync(EXPIRES);
    await SecureStore.deleteItemAsync(PENDING_PROFILE);
    if (clearKeys) {
      // FSCP keys cleared separately via fscp storage adapter
    }
  },
  async hasPendingProfileSetup() {
    return (await SecureStore.getItemAsync(PENDING_PROFILE)) === "1";
  },
  async setPendingProfileSetup(value: boolean) {
    if (value) await SecureStore.setItemAsync(PENDING_PROFILE, "1");
    else await SecureStore.deleteItemAsync(PENDING_PROFILE);
  },
};
