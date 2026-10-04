import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetIdleTabPreloadSerializer,
  beginIdleTabPreloadEpoch,
  getIdleTabPreloadCompleteAt,
  IDLE_TAB_PRELOAD_SERIAL_GAP_MS,
  markIdleTabPreloadComplete,
} from "./idleTabPreload";
import {
  canPrefetchSettingsTab,
  createIdleSettingsTabPreloadController,
  finishSettingsIdleTabPrefetch,
  SETTINGS_TAB_PRELOAD_HREF,
  SETTINGS_TAB_PRELOAD_QUIET_MS,
  type IdleSettingsTabPreloadSnapshot,
  type SettingsTabPreloadGate,
} from "./settingsTabPreload";

const allow: SettingsTabPreloadGate = {
  platform: "android",
  appActive: true,
  scrollSettled: true,
  quietForMs: SETTINGS_TAB_PRELOAD_QUIET_MS,
  settingsTabActive: false,
  alreadyPrefetched: false,
  communitiesComplete: true,
  communitiesCompleteForMs: IDLE_TAB_PRELOAD_SERIAL_GAP_MS,
};

describe("SETTINGS_TAB_PRELOAD_HREF", () => {
  it("is the settings tab index, not a nested settings route", () => {
    expect(SETTINGS_TAB_PRELOAD_HREF).toBe("/(tabs)/settings");
  });
});

describe("finishSettingsIdleTabPrefetch", () => {
  afterEach(() => {
    __resetIdleTabPreloadSerializer();
  });

  it("stamps settings then releases", () => {
    const release = vi.fn(() => {
      expect(getIdleTabPreloadCompleteAt("settings")).not.toBeNull();
    });
    expect(getIdleTabPreloadCompleteAt("settings")).toBeNull();
    finishSettingsIdleTabPrefetch(release);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("canPrefetchSettingsTab", () => {
  it("allows when all gates are open", () => {
    expect(canPrefetchSettingsTab(allow)).toBe(true);
  });

  it("allows when quiet exceeds the window", () => {
    expect(
      canPrefetchSettingsTab({ ...allow, quietForMs: SETTINGS_TAB_PRELOAD_QUIET_MS + 1 }),
    ).toBe(true);
  });

  it.each([
    ["ios", { platform: "ios" }],
    ["web", { platform: "web" }],
    ["app inactive", { appActive: false }],
    ["scroll not settled", { scrollSettled: false }],
    ["quiet window", { quietForMs: SETTINGS_TAB_PRELOAD_QUIET_MS - 1 }],
    ["quiet just started", { quietForMs: 0 }],
    ["settings tab active", { settingsTabActive: true }],
    ["already prefetched", { alreadyPrefetched: true }],
    ["communities not complete", { communitiesComplete: false }],
    ["communities gap", { communitiesCompleteForMs: IDLE_TAB_PRELOAD_SERIAL_GAP_MS - 1 }],
  ] as const)("blocks when %s", (_label, override) => {
    expect(canPrefetchSettingsTab({ ...allow, ...override })).toBe(false);
  });
});

describe("createIdleSettingsTabPreloadController", () => {
  afterEach(() => {
    vi.useRealTimers();
    __resetIdleTabPreloadSerializer();
  });

  function makeController(
    overrides: {
      settled?: { value: boolean };
      snapshot?: IdleSettingsTabPreloadSnapshot;
      skipCommunitiesComplete?: boolean;
    } = {},
  ) {
    if (!overrides.skipCommunitiesComplete) {
      markIdleTabPreloadComplete("communities");
    }
    const settled = overrides.settled ?? { value: true };
    const snapshot: IdleSettingsTabPreloadSnapshot = overrides.snapshot ?? {
      platform: "android",
      appActive: true,
      settingsTabActive: false,
    };
    const prefetch = vi.fn();
    const controller = createIdleSettingsTabPreloadController({
      quietMs: SETTINGS_TAB_PRELOAD_QUIET_MS,
      isScrollSettled: () => settled.value,
      getSnapshot: () => snapshot,
      prefetch,
    });
    return { controller, prefetch, settled, snapshot };
  }

  it("does not prefetch while scroll is unsettled", () => {
    vi.useFakeTimers();
    const { controller, prefetch, settled } = makeController({ settled: { value: false } });
    controller.evaluate();
    vi.advanceTimersByTime(SETTINGS_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).not.toHaveBeenCalled();
    expect(controller.hasPendingTimer()).toBe(false);
    settled.value = true;
    controller.onScrollSettled(true);
    vi.advanceTimersByTime(SETTINGS_TAB_PRELOAD_QUIET_MS - 1);
    expect(prefetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending quiet timer when scroll becomes busy", () => {
    vi.useFakeTimers();
    const { controller, prefetch, settled } = makeController();
    controller.evaluate();
    expect(controller.hasPendingTimer()).toBe(true);
    settled.value = false;
    controller.onScrollSettled(false);
    expect(controller.hasPendingTimer()).toBe(false);
    vi.advanceTimersByTime(SETTINGS_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("does not latch prefetch if scroll is busy when the quiet timer fires", () => {
    vi.useFakeTimers();
    const { controller, prefetch, settled } = makeController();
    controller.evaluate();
    settled.value = false;
    vi.advanceTimersByTime(SETTINGS_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).not.toHaveBeenCalled();
    expect(controller.hasPrefetched()).toBe(false);
  });

  it("prefetches once after the quiet window without waiting on queries", () => {
    vi.useFakeTimers();
    const { controller, prefetch } = makeController();
    controller.evaluate();
    vi.advanceTimersByTime(SETTINGS_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).toHaveBeenCalledTimes(1);
    controller.evaluate();
    vi.advanceTimersByTime(SETTINGS_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("does not prefetch until communities complete for 120ms", () => {
    vi.useFakeTimers();
    const { controller, prefetch } = makeController({ skipCommunitiesComplete: true });
    controller.evaluate();
    vi.advanceTimersByTime(SETTINGS_TAB_PRELOAD_QUIET_MS * 4);
    expect(prefetch).not.toHaveBeenCalled();

    markIdleTabPreloadComplete("communities");
    controller.evaluate();
    vi.advanceTimersByTime(IDLE_TAB_PRELOAD_SERIAL_GAP_MS - 1);
    expect(prefetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("does not treat a previous communities stamp after a new communities epoch", () => {
    vi.useFakeTimers();
    markIdleTabPreloadComplete("communities");
    beginIdleTabPreloadEpoch("communities");
    const { controller, prefetch } = makeController({ skipCommunitiesComplete: true });
    controller.evaluate();
    vi.advanceTimersByTime(SETTINGS_TAB_PRELOAD_QUIET_MS * 4);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("latches skip when the settings tab is already active and stamps settings", () => {
    const { controller, prefetch } = makeController({
      skipCommunitiesComplete: true,
      snapshot: {
        platform: "android",
        appActive: true,
        settingsTabActive: true,
      },
    });
    controller.evaluate();
    expect(prefetch).not.toHaveBeenCalled();
    expect(controller.hasPrefetched()).toBe(true);
    expect(getIdleTabPreloadCompleteAt("settings")).not.toBeNull();
    expect(getIdleTabPreloadCompleteAt("communities")).toBeNull();
    expect(getIdleTabPreloadCompleteAt("people")).toBeNull();
    expect(getIdleTabPreloadCompleteAt("messages")).toBeNull();
    expect(getIdleTabPreloadCompleteAt("notifications")).toBeNull();
    expect(getIdleTabPreloadCompleteAt("profile")).toBeNull();
    expect(getIdleTabPreloadCompleteAt("music")).toBeNull();
  });
});
