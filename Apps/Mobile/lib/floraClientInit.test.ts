import { afterEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("__DEV__", false);
vi.stubEnv("EXPO_PUBLIC_API_URL", "https://api.test");

vi.mock("expo-constants", () => ({
  default: { expoConfig: { version: "0.0.0-test" } },
}));

vi.mock("expo-router", () => ({
  router: { replace: vi.fn() },
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

vi.mock("@/stores/sessionStore", () => ({
  handleSessionUnauthorized: vi.fn(),
  useSessionStore: { getState: () => ({ isAuthenticated: false }) },
}));

describe("initFloraClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("enables retry-safe refresh", async () => {
    const { initFloraClient } = await import("./api");
    const { getApiClientConfig } = await import("@flora/client-core/api");
    initFloraClient();
    expect(getApiClientConfig().retrySafeRefreshBackend).toBe(true);
  });
});
