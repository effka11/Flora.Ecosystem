import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canPrefetchContributeTab,
  createIdleContributeTabPreloadController,
  CONTRIBUTE_TAB_PRELOAD_HREF,
  CONTRIBUTE_TAB_PRELOAD_QUIET_MS,
  type ContributeTabPreloadGate,
  type IdleContributeTabPreloadSnapshot,
} from "./contributeTabPreload";
import {
  __resetIdleTabPreloadSerializer,
  beginIdleTabPreloadEpoch,
  getIdleTabPreloadCompleteAt,
  IDLE_TAB_PRELOAD_SERIAL_GAP_MS,
  markIdleTabPreloadComplete,
} from "./idleTabPreload";

const allow: ContributeTabPreloadGate = {
  platform: "android",
  appActive: true,
  scrollSettled: true,
  quietForMs: CONTRIBUTE_TAB_PRELOAD_QUIET_MS,
  contributeTabActive: false,
  alreadyPrefetched: false,
  settingsComplete: true,
  settingsCompleteForMs: IDLE_TAB_PRELOAD_SERIAL_GAP_MS,
};

describe("CONTRIBUTE_TAB_PRELOAD_HREF", () => {
  it("is the contribute tab index, not a nested contribute route", () => {
    expect(CONTRIBUTE_TAB_PRELOAD_HREF).toBe("/(tabs)/contribute");
  });
});

describe("canPrefetchContributeTab", () => {
  it("allows when all gates are open", () => {
    expect(canPrefetchContributeTab(allow)).toBe(true);
  });

  it("allows when quiet exceeds the window", () => {
    expect(
      canPrefetchContributeTab({ ...allow, quietForMs: CONTRIBUTE_TAB_PRELOAD_QUIET_MS + 1 }),
    ).toBe(true);
  });

  it.each([
    ["ios", { platform: "ios" }],
    ["web", { platform: "web" }],
    ["app inactive", { appActive: false }],
    ["scroll not settled", { scrollSettled: false }],
    ["quiet window", { quietForMs: CONTRIBUTE_TAB_PRELOAD_QUIET_MS - 1 }],
    ["quiet just started", { quietForMs: 0 }],
    ["contribute tab active", { contributeTabActive: true }],
    ["already prefetched", { alreadyPrefetched: true }],
    ["settings not complete", { settingsComplete: false }],
    ["settings gap", { settingsCompleteForMs: IDLE_TAB_PRELOAD_SERIAL_GAP_MS - 1 }],
  ] as const)("blocks when %s", (_label, override) => {
    expect(canPrefetchContributeTab({ ...allow, ...override })).toBe(false);
  });
});

describe("createIdleContributeTabPreloadController", () => {
  afterEach(() => {
    vi.useRealTimers();
    __resetIdleTabPreloadSerializer();
  });

  function makeController(
    overrides: {
      settled?: { value: boolean };
      snapshot?: IdleContributeTabPreloadSnapshot;
      skipSettingsComplete?: boolean;
    } = {},
  ) {
    if (!overrides.skipSettingsComplete) {
      markIdleTabPreloadComplete("settings");
    }
    const settled = overrides.settled ?? { value: true };
    const snapshot: IdleContributeTabPreloadSnapshot = overrides.snapshot ?? {
      platform: "android",
      appActive: true,
      contributeTabActive: false,
    };
    const prefetch = vi.fn();
    const controller = createIdleContributeTabPreloadController({
      quietMs: CONTRIBUTE_TAB_PRELOAD_QUIET_MS,
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
    vi.advanceTimersByTime(CONTRIBUTE_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).not.toHaveBeenCalled();
    expect(controller.hasPendingTimer()).toBe(false);
    settled.value = true;
    controller.onScrollSettled(true);
    vi.advanceTimersByTime(CONTRIBUTE_TAB_PRELOAD_QUIET_MS - 1);
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
    vi.advanceTimersByTime(CONTRIBUTE_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("does not latch prefetch if scroll is busy when the quiet timer fires", () => {
    vi.useFakeTimers();
    const { controller, prefetch, settled } = makeController();
    controller.evaluate();
    settled.value = false;
    vi.advanceTimersByTime(CONTRIBUTE_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).not.toHaveBeenCalled();
    expect(controller.hasPrefetched()).toBe(false);
  });

  it("prefetches once after the quiet window without waiting on queries", () => {
    vi.useFakeTimers();
    const { controller, prefetch } = makeController();
    controller.evaluate();
    vi.advanceTimersByTime(CONTRIBUTE_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).toHaveBeenCalledTimes(1);
    controller.evaluate();
    vi.advanceTimersByTime(CONTRIBUTE_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("does not prefetch until settings complete for 120ms", () => {
    vi.useFakeTimers();
    const { controller, prefetch } = makeController({ skipSettingsComplete: true });
    controller.evaluate();
    vi.advanceTimersByTime(CONTRIBUTE_TAB_PRELOAD_QUIET_MS * 4);
    expect(prefetch).not.toHaveBeenCalled();

    markIdleTabPreloadComplete("settings");
    controller.evaluate();
    vi.advanceTimersByTime(IDLE_TAB_PRELOAD_SERIAL_GAP_MS - 1);
    expect(prefetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("does not treat a previous settings stamp after a new settings epoch", () => {
    vi.useFakeTimers();
    markIdleTabPreloadComplete("settings");
    beginIdleTabPreloadEpoch("settings");
    const { controller, prefetch } = makeController({ skipSettingsComplete: true });
    controller.evaluate();
    vi.advanceTimersByTime(CONTRIBUTE_TAB_PRELOAD_QUIET_MS * 4);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("latches skip when the contribute tab is already active and does not stamp settings", () => {
    const { controller, prefetch } = makeController({
      skipSettingsComplete: true,
      snapshot: {
        platform: "android",
        appActive: true,
        contributeTabActive: true,
      },
    });
    controller.evaluate();
    expect(prefetch).not.toHaveBeenCalled();
    expect(controller.hasPrefetched()).toBe(true);
    expect(getIdleTabPreloadCompleteAt("settings")).toBeNull();
    expect(getIdleTabPreloadCompleteAt("communities")).toBeNull();
    expect(getIdleTabPreloadCompleteAt("people")).toBeNull();
    expect(getIdleTabPreloadCompleteAt("messages")).toBeNull();
    expect(getIdleTabPreloadCompleteAt("notifications")).toBeNull();
    expect(getIdleTabPreloadCompleteAt("profile")).toBeNull();
    expect(getIdleTabPreloadCompleteAt("music")).toBeNull();
  });

  it("does not change an existing settings stamp when contribute skip-latches", () => {
    markIdleTabPreloadComplete("settings", 42);
    const { controller, prefetch } = makeController({
      skipSettingsComplete: true,
      snapshot: {
        platform: "android",
        appActive: true,
        contributeTabActive: true,
      },
    });
    controller.evaluate();
    expect(prefetch).not.toHaveBeenCalled();
    expect(controller.hasPrefetched()).toBe(true);
    expect(getIdleTabPreloadCompleteAt("settings")).toBe(42);
  });
});
