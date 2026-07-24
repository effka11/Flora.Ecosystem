import { describe, expect, it, vi } from "vitest";
import {
  createMobileSessionStore,
  LEGACY_ACCESS_KEY,
  LEGACY_EXPIRES_KEY,
  LEGACY_PENDING_PROFILE_KEY,
  LEGACY_REFRESH_KEY,
  MOBILE_SESSION_KEY,
  MOBILE_SESSION_MAX_UTF8_BYTES,
  SessionStorageBudgetError,
  SessionStorageCorruptError,
  SessionStorageUnavailableError,
  SessionStorageVerificationError,
  type SecureStoreLike,
} from "./session";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

class MemorySecureStore implements SecureStoreLike {
  readonly values = new Map<string, string>();
  readonly operations: string[] = [];
  failReads = false;
  failWrites = false;
  tamperNextCanonicalReadAfterWrite = false;
  private canonicalWasWritten = false;

  async getItemAsync(key: string): Promise<string | null> {
    this.operations.push(`get:${key}`);
    if (this.failReads) throw new Error("keychain locked");
    const value = this.values.get(key) ?? null;
    if (
      key === MOBILE_SESSION_KEY &&
      this.canonicalWasWritten &&
      this.tamperNextCanonicalReadAfterWrite &&
      value !== null
    ) {
      this.tamperNextCanonicalReadAfterWrite = false;
      this.canonicalWasWritten = false;
      return `${value} `;
    }
    this.canonicalWasWritten = false;
    return value;
  }

  async setItemAsync(key: string, value: string): Promise<void> {
    this.operations.push(`set:${key}`);
    if (this.failWrites) throw new Error("keychain write failed");
    this.values.set(key, value);
    if (key === MOBILE_SESSION_KEY) this.canonicalWasWritten = true;
  }

  async deleteItemAsync(key: string): Promise<void> {
    this.operations.push(`delete:${key}`);
    this.values.delete(key);
  }
}

const firstTokens = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: "2030-01-01T00:00:00.000Z",
};

describe("mobile atomic session storage", () => {
  it("migrates refresh-only legacy state before deleting legacy keys", async () => {
    const secureStore = new MemorySecureStore();
    secureStore.values.set(LEGACY_REFRESH_KEY, "legacy-refresh");
    secureStore.values.set(LEGACY_PENDING_PROFILE_KEY, "1");
    const store = createMobileSessionStore(secureStore);

    const snapshot = await store.readSession();

    expect(snapshot).toEqual({
      revision: 1,
      session: {
        accessToken: null,
        refresh: { kind: "token", token: "legacy-refresh" },
        expiresAt: null,
      },
    });
    const canonical = JSON.parse(
      secureStore.values.get(MOBILE_SESSION_KEY) ?? "",
    ) as Record<string, unknown>;
    expect(canonical).toMatchObject({
      kind: "active",
      revision: 1,
      accessToken: null,
      refreshToken: "legacy-refresh",
      pendingProfileSetup: true,
    });
    expect(secureStore.values.has(LEGACY_REFRESH_KEY)).toBe(false);
    const writeIndex = secureStore.operations.indexOf(`set:${MOBILE_SESSION_KEY}`);
    const readBackIndex = secureStore.operations.indexOf(`get:${MOBILE_SESSION_KEY}`, writeIndex);
    const deleteIndex = secureStore.operations.indexOf(`delete:${LEGACY_REFRESH_KEY}`);
    expect(writeIndex).toBeGreaterThanOrEqual(0);
    expect(readBackIndex).toBeGreaterThan(writeIndex);
    expect(deleteIndex).toBeGreaterThan(readBackIndex);
  });

  it("never falls back to legacy credentials when canonical JSON is corrupt", async () => {
    const secureStore = new MemorySecureStore();
    secureStore.values.set(MOBILE_SESSION_KEY, "{broken");
    secureStore.values.set(LEGACY_ACCESS_KEY, "legacy-access");
    secureStore.values.set(LEGACY_REFRESH_KEY, "legacy-refresh");
    secureStore.values.set(LEGACY_EXPIRES_KEY, firstTokens.expiresAt);
    const store = createMobileSessionStore(secureStore);

    await expect(store.readSession()).rejects.toBeInstanceOf(
      SessionStorageCorruptError,
    );
    expect(secureStore.values.get(LEGACY_REFRESH_KEY)).toBe("legacy-refresh");
  });

  it("serializes rotation CAS so only one writer advances a revision", async () => {
    const secureStore = new MemorySecureStore();
    const store = createMobileSessionStore(secureStore);
    await store.saveSession(firstTokens);
    const baseline = await store.readSession();

    const [first, second] = await Promise.all([
      store.compareAndSetSession(baseline.revision, {
        accessToken: "access-2a",
        refresh: { kind: "token", token: "refresh-2a" },
        expiresAt: "2030-01-01T00:15:00.000Z",
      }),
      store.compareAndSetSession(baseline.revision, {
        accessToken: "access-2b",
        refresh: { kind: "token", token: "refresh-2b" },
        expiresAt: "2030-01-01T00:15:00.000Z",
      }),
    ]);

    expect([first, second].sort()).toEqual([false, true]);
    expect((await store.readSession()).revision).toBe(baseline.revision + 1);
  });

  it("rejects over-budget UTF-8 without replacing existing credentials", async () => {
    const secureStore = new MemorySecureStore();
    const store = createMobileSessionStore(secureStore);
    await store.saveSession(firstTokens);
    const before = secureStore.values.get(MOBILE_SESSION_KEY);

    await expect(
      store.saveSession({
        ...firstTokens,
        accessToken: "🌿".repeat(MOBILE_SESSION_MAX_UTF8_BYTES),
      }),
    ).rejects.toBeInstanceOf(SessionStorageBudgetError);
    expect(secureStore.values.get(MOBILE_SESSION_KEY)).toBe(before);
    expect(await store.getRefreshToken()).toBe("refresh-1");
  });

  it("keeps credentials and legacy material when a tombstone write throws", async () => {
    const secureStore = new MemorySecureStore();
    const store = createMobileSessionStore(secureStore);
    await store.saveSession(firstTokens);
    secureStore.values.set(LEGACY_REFRESH_KEY, "legacy-refresh");
    const before = secureStore.values.get(MOBILE_SESSION_KEY);
    secureStore.failWrites = true;

    await expect(store.clearSession()).rejects.toBeInstanceOf(
      SessionStorageUnavailableError,
    );
    expect(secureStore.values.get(MOBILE_SESSION_KEY)).toBe(before);
    expect(secureStore.values.get(LEGACY_REFRESH_KEY)).toBe("legacy-refresh");
    expect(await store.getAccessToken()).toBe("access-1");
  });

  it("keeps a failed rotation as an in-memory pending credential pair", async () => {
    const secureStore = new MemorySecureStore();
    const store = createMobileSessionStore(secureStore);
    await store.saveSession(firstTokens);
    const baseline = await store.readSession();
    const canonicalBefore = secureStore.values.get(MOBILE_SESSION_KEY);
    secureStore.failWrites = true;

    await expect(
      store.compareAndSetSession(baseline.revision, {
        accessToken: "access-r2",
        refresh: { kind: "token", token: "refresh-r2" },
        expiresAt: "2030-01-01T00:15:00.000Z",
      }),
    ).rejects.toBeInstanceOf(SessionStorageUnavailableError);

    expect(secureStore.values.get(MOBILE_SESSION_KEY)).toBe(canonicalBefore);
    expect(await store.getAccessToken()).toBe("access-r2");
    expect(await store.getRefreshToken()).toBe("refresh-r2");
  });

  it("requires exact read-back before confirming logout", async () => {
    const secureStore = new MemorySecureStore();
    const store = createMobileSessionStore(secureStore);
    await store.saveSession(firstTokens);
    secureStore.values.set(LEGACY_REFRESH_KEY, "legacy-refresh");
    secureStore.tamperNextCanonicalReadAfterWrite = true;

    await expect(store.clearSession()).rejects.toBeInstanceOf(
      SessionStorageVerificationError,
    );
    expect(secureStore.values.get(LEGACY_REFRESH_KEY)).toBe("legacy-refresh");
  });

  it("surfaces read exceptions instead of treating them as anonymous", async () => {
    const secureStore = new MemorySecureStore();
    secureStore.failReads = true;
    const store = createMobileSessionStore(secureStore);

    await expect(store.readSession()).rejects.toBeInstanceOf(
      SessionStorageUnavailableError,
    );
  });
});
