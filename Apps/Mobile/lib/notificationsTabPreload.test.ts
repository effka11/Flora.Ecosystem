import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetIdleTabPreloadSerializer,
  beginMessagesIdlePreloadEpoch,
  IDLE_TAB_PRELOAD_SERIAL_GAP_MS,
  markMessagesIdlePreloadComplete,
} from "./idleTabPreload";
import {
  canPrefetchNotificationsTab,
  createIdleNotificationsTabPreloadController,
  NOTIFICATIONS_TAB_PRELOAD_QUIET_MS,
  type IdleNotificationsTabPreloadSnapshot,
  type NotificationsTabPreloadGate,
} from "./notificationsTabPreload";

const allow: NotificationsTabPreloadGate = {
  platform: "android",
  appActive: true,
  notificationsSuccess: true,
  scrollSettled: true,
  quietForMs: NOTIFICATIONS_TAB_PRELOAD_QUIET_MS,
  notificationsTabActive: false,
  alreadyPrefetched: false,
  messagesComplete: true,
  messagesCompleteForMs: IDLE_TAB_PRELOAD_SERIAL_GAP_MS,
};

describe("canPrefetchNotificationsTab", () => {
  it("allows when all gates are open", () => {
    expect(canPrefetchNotificationsTab(allow)).toBe(true);
  });

  it("allows when quiet exceeds the window", () => {
    expect(
      canPrefetchNotificationsTab({ ...allow, quietForMs: NOTIFICATIONS_TAB_PRELOAD_QUIET_MS + 1 }),
    ).toBe(true);
  });

  it.each([
    ["ios", { platform: "ios" }],
    ["web", { platform: "web" }],
    ["app inactive", { appActive: false }],
    ["notifications not success", { notificationsSuccess: false }],
    ["scroll not settled", { scrollSettled: false }],
    ["quiet window", { quietForMs: NOTIFICATIONS_TAB_PRELOAD_QUIET_MS - 1 }],
    ["quiet just started", { quietForMs: 0 }],
    ["notifications tab active", { notificationsTabActive: true }],
    ["already prefetched", { alreadyPrefetched: true }],
    ["messages not complete", { messagesComplete: false }],
    ["messages gap", { messagesCompleteForMs: IDLE_TAB_PRELOAD_SERIAL_GAP_MS - 1 }],
  ] as const)("blocks when %s", (_label, override) => {
    expect(canPrefetchNotificationsTab({ ...allow, ...override })).toBe(false);
  });
});

describe("createIdleNotificationsTabPreloadController", () => {
  afterEach(() => {
    vi.useRealTimers();
    __resetIdleTabPreloadSerializer();
  });

  function makeController(
    overrides: {
      settled?: { value: boolean };
      snapshot?: IdleNotificationsTabPreloadSnapshot;
      skipMessagesComplete?: boolean;
    } = {},
  ) {
    if (!overrides.skipMessagesComplete) {
      markMessagesIdlePreloadComplete();
    }
    const settled = overrides.settled ?? { value: true };
    const snapshot: IdleNotificationsTabPreloadSnapshot = overrides.snapshot ?? {
      platform: "android",
      appActive: true,
      notificationsSuccess: true,
      notificationsTabActive: false,
    };
    const prefetch = vi.fn();
    const controller = createIdleNotificationsTabPreloadController({
      quietMs: NOTIFICATIONS_TAB_PRELOAD_QUIET_MS,
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
    vi.advanceTimersByTime(NOTIFICATIONS_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).not.toHaveBeenCalled();
    expect(controller.hasPendingTimer()).toBe(false);
    settled.value = true;
    controller.onScrollSettled(true);
    vi.advanceTimersByTime(NOTIFICATIONS_TAB_PRELOAD_QUIET_MS - 1);
    expect(prefetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("does not prefetch before notifications success", () => {
    vi.useFakeTimers();
    const { controller, prefetch } = makeController({
      snapshot: {
        platform: "android",
        appActive: true,
        notificationsSuccess: false,
        notificationsTabActive: false,
      },
    });
    controller.evaluate();
    vi.advanceTimersByTime(NOTIFICATIONS_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).not.toHaveBeenCalled();
    expect(controller.hasPendingTimer()).toBe(false);
  });

  it("cancels a pending quiet timer when scroll becomes busy", () => {
    vi.useFakeTimers();
    const { controller, prefetch, settled } = makeController();
    controller.evaluate();
    expect(controller.hasPendingTimer()).toBe(true);
    settled.value = false;
    controller.onScrollSettled(false);
    expect(controller.hasPendingTimer()).toBe(false);
    vi.advanceTimersByTime(NOTIFICATIONS_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("does not latch prefetch if scroll is busy when the quiet timer fires", () => {
    vi.useFakeTimers();
    const { controller, prefetch, settled } = makeController();
    controller.evaluate();
    settled.value = false;
    vi.advanceTimersByTime(NOTIFICATIONS_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).not.toHaveBeenCalled();
    expect(controller.hasPrefetched()).toBe(false);
  });

  it("prefetches once after the quiet window", () => {
    vi.useFakeTimers();
    const { controller, prefetch } = makeController();
    controller.evaluate();
    vi.advanceTimersByTime(NOTIFICATIONS_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).toHaveBeenCalledTimes(1);
    controller.evaluate();
    vi.advanceTimersByTime(NOTIFICATIONS_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("does not prefetch until messages preload has been complete for 120ms", () => {
    vi.useFakeTimers();
    const { controller, prefetch } = makeController({ skipMessagesComplete: true });
    controller.evaluate();
    vi.advanceTimersByTime(NOTIFICATIONS_TAB_PRELOAD_QUIET_MS * 4);
    expect(prefetch).not.toHaveBeenCalled();

    markMessagesIdlePreloadComplete();
    controller.evaluate();
    vi.advanceTimersByTime(IDLE_TAB_PRELOAD_SERIAL_GAP_MS - 1);
    expect(prefetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("does not treat a previous messages-complete stamp after a new epoch", () => {
    vi.useFakeTimers();
    markMessagesIdlePreloadComplete();
    beginMessagesIdlePreloadEpoch();
    const { controller, prefetch } = makeController({ skipMessagesComplete: true });
    controller.evaluate();
    vi.advanceTimersByTime(NOTIFICATIONS_TAB_PRELOAD_QUIET_MS * 4);
    expect(prefetch).not.toHaveBeenCalled();
  });
});
