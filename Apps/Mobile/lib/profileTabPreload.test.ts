import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetIdleTabPreloadSerializer,
  beginIdleTabPreloadEpoch,
  getIdleTabPreloadCompleteAt,
  IDLE_TAB_PRELOAD_SERIAL_GAP_MS,
  markIdleTabPreloadComplete,
} from "./idleTabPreload";
import {
  canPrefetchProfileTab,
  createIdleProfileTabPreloadController,
  isOwnProfilePostsQueryKey,
  PROFILE_TAB_PRELOAD_QUIET_MS,
  type IdleProfileTabPreloadSnapshot,
  type ProfileTabPreloadGate,
} from "./profileTabPreload";

const allow: ProfileTabPreloadGate = {
  platform: "android",
  appActive: true,
  profilePostsSuccess: true,
  scrollSettled: true,
  quietForMs: PROFILE_TAB_PRELOAD_QUIET_MS,
  profileTabActive: false,
  alreadyPrefetched: false,
  notificationsComplete: true,
  notificationsCompleteForMs: IDLE_TAB_PRELOAD_SERIAL_GAP_MS,
};

describe("isOwnProfilePostsQueryKey", () => {
  it("is true for exact own profile-posts key", () => {
    expect(isOwnProfilePostsQueryKey(["profile-posts", "alice"], "alice")).toBe(true);
  });

  it.each([
    ["other user's profile-posts", ["profile-posts", "bob"], "alice"],
    ["prefix only", ["profile-posts"], "alice"],
    ["empty username", ["profile-posts", "alice"], ""],
    ["notifications key", ["notifications", "all", ""], "alice"],
  ] as const)("is false for %s", (_label, queryKey, username) => {
    expect(isOwnProfilePostsQueryKey(queryKey, username)).toBe(false);
  });
});

describe("canPrefetchProfileTab", () => {
  it("allows when all gates are open", () => {
    expect(canPrefetchProfileTab(allow)).toBe(true);
  });

  it("allows when quiet exceeds the window", () => {
    expect(
      canPrefetchProfileTab({ ...allow, quietForMs: PROFILE_TAB_PRELOAD_QUIET_MS + 1 }),
    ).toBe(true);
  });

  it.each([
    ["ios", { platform: "ios" }],
    ["web", { platform: "web" }],
    ["app inactive", { appActive: false }],
    ["profile posts not success", { profilePostsSuccess: false }],
    ["scroll not settled", { scrollSettled: false }],
    ["quiet window", { quietForMs: PROFILE_TAB_PRELOAD_QUIET_MS - 1 }],
    ["quiet just started", { quietForMs: 0 }],
    ["profile tab active", { profileTabActive: true }],
    ["already prefetched", { alreadyPrefetched: true }],
    ["notifications not complete", { notificationsComplete: false }],
    ["notifications gap", { notificationsCompleteForMs: IDLE_TAB_PRELOAD_SERIAL_GAP_MS - 1 }],
  ] as const)("blocks when %s", (_label, override) => {
    expect(canPrefetchProfileTab({ ...allow, ...override })).toBe(false);
  });
});

describe("createIdleProfileTabPreloadController", () => {
  afterEach(() => {
    vi.useRealTimers();
    __resetIdleTabPreloadSerializer();
  });

  function makeController(
    overrides: {
      settled?: { value: boolean };
      snapshot?: IdleProfileTabPreloadSnapshot;
      skipNotificationsComplete?: boolean;
    } = {},
  ) {
    if (!overrides.skipNotificationsComplete) {
      markIdleTabPreloadComplete("notifications");
    }
    const settled = overrides.settled ?? { value: true };
    const snapshot: IdleProfileTabPreloadSnapshot = overrides.snapshot ?? {
      platform: "android",
      appActive: true,
      profilePostsSuccess: true,
      profileTabActive: false,
    };
    const prefetch = vi.fn();
    const controller = createIdleProfileTabPreloadController({
      quietMs: PROFILE_TAB_PRELOAD_QUIET_MS,
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
    vi.advanceTimersByTime(PROFILE_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).not.toHaveBeenCalled();
    expect(controller.hasPendingTimer()).toBe(false);
    settled.value = true;
    controller.onScrollSettled(true);
    vi.advanceTimersByTime(PROFILE_TAB_PRELOAD_QUIET_MS - 1);
    expect(prefetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("does not prefetch before profile posts success", () => {
    vi.useFakeTimers();
    const { controller, prefetch } = makeController({
      snapshot: {
        platform: "android",
        appActive: true,
        profilePostsSuccess: false,
        profileTabActive: false,
      },
    });
    controller.evaluate();
    vi.advanceTimersByTime(PROFILE_TAB_PRELOAD_QUIET_MS);
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
    vi.advanceTimersByTime(PROFILE_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("does not latch prefetch if scroll is busy when the quiet timer fires", () => {
    vi.useFakeTimers();
    const { controller, prefetch, settled } = makeController();
    controller.evaluate();
    settled.value = false;
    vi.advanceTimersByTime(PROFILE_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).not.toHaveBeenCalled();
    expect(controller.hasPrefetched()).toBe(false);
  });

  it("prefetches once after the quiet window", () => {
    vi.useFakeTimers();
    const { controller, prefetch } = makeController();
    controller.evaluate();
    vi.advanceTimersByTime(PROFILE_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).toHaveBeenCalledTimes(1);
    controller.evaluate();
    vi.advanceTimersByTime(PROFILE_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("does not prefetch until notifications complete for 120ms", () => {
    vi.useFakeTimers();
    const { controller, prefetch } = makeController({ skipNotificationsComplete: true });
    controller.evaluate();
    vi.advanceTimersByTime(PROFILE_TAB_PRELOAD_QUIET_MS * 4);
    expect(prefetch).not.toHaveBeenCalled();

    markIdleTabPreloadComplete("notifications");
    controller.evaluate();
    vi.advanceTimersByTime(IDLE_TAB_PRELOAD_SERIAL_GAP_MS - 1);
    expect(prefetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("does not treat a previous notifications stamp after a new notifications epoch", () => {
    vi.useFakeTimers();
    markIdleTabPreloadComplete("notifications");
    beginIdleTabPreloadEpoch("notifications");
    const { controller, prefetch } = makeController({ skipNotificationsComplete: true });
    controller.evaluate();
    vi.advanceTimersByTime(PROFILE_TAB_PRELOAD_QUIET_MS * 4);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("latches skip when the profile tab is already active without stamping", () => {
    const { controller, prefetch } = makeController({
      skipNotificationsComplete: true,
      snapshot: {
        platform: "android",
        appActive: true,
        profilePostsSuccess: true,
        profileTabActive: true,
      },
    });
    controller.evaluate();
    expect(prefetch).not.toHaveBeenCalled();
    expect(controller.hasPrefetched()).toBe(true);
    expect(getIdleTabPreloadCompleteAt("notifications")).toBeNull();
  });
});
