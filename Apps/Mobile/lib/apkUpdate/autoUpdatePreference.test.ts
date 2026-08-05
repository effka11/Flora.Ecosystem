import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const canRequest = vi.fn(() => false);
const setNative = vi.fn();

vi.mock("flora-apk-updater", () => ({
  canRequestPackageInstalls: () => canRequest(),
  isFloraApkUpdaterAvailable: () => true,
  setNativeAutoUpdateEnabled: (v: boolean) => setNative(v),
}));

const store = new Map<string, string>();

vi.mock("@/lib/mmkv", () => ({
  mmkv: {
    getString: (k: string) => store.get(k),
    set: (k: string, v: string) => {
      store.set(k, v);
    },
    contains: (k: string) => store.has(k),
    delete: (k: string) => {
      store.delete(k);
    },
  },
}));

describe("reconcileInstallPermissionWithOs", () => {
  beforeEach(() => {
    store.clear();
    canRequest.mockReturnValue(false);
    setNative.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("clears inApp and auto when OS permission is revoked", async () => {
    store.set("apkUpdate.inAppUpdatesEnabled", "1");
    store.set("apkUpdate.autoUpdateEnabled", "1");
    canRequest.mockReturnValue(false);

    const { reconcileInstallPermissionWithOs, isInAppUpdatesEnabled, isAutoUpdateEnabled } =
      await import("@/lib/apkUpdate/autoUpdatePreference");

    const r = reconcileInstallPermissionWithOs();
    expect(r.hasOs).toBe(false);
    expect(r.inApp).toBe(false);
    expect(r.auto).toBe(false);
    expect(isInAppUpdatesEnabled()).toBe(false);
    expect(isAutoUpdateEnabled()).toBe(false);
    expect(setNative).toHaveBeenCalledWith(false);
  });

  it("mirrors OS grant onto inApp (external grant enables toggle)", async () => {
    store.set("apkUpdate.inAppUpdatesEnabled", "0");
    store.set("apkUpdate.autoUpdateEnabled", "0");
    canRequest.mockReturnValue(true);

    const { reconcileInstallPermissionWithOs, isInAppUpdatesEnabled, isAutoUpdateEnabled } =
      await import("@/lib/apkUpdate/autoUpdatePreference");

    const r = reconcileInstallPermissionWithOs();
    expect(r.hasOs).toBe(true);
    expect(r.inApp).toBe(true);
    expect(isInAppUpdatesEnabled()).toBe(true);
    // Auto stays opt-in OFF.
    expect(r.auto).toBe(false);
    expect(isAutoUpdateEnabled()).toBe(false);
  });
});
