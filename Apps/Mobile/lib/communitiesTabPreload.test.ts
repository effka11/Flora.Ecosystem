import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMMUNITIES_OWNED_QUERY_KEY,
  COMMUNITIES_RECOMMENDED_QUERY_KEY,
  communitiesSubscriptionsQueryKey,
} from "./communities/communitiesIndexQueries";
import {
  canPrefetchCommunitiesTab,
  createIdleCommunitiesTabPreloadController,
  isCommunitiesIndexQueryKey,
  COMMUNITIES_TAB_PRELOAD_HREF,
  COMMUNITIES_TAB_PRELOAD_QUIET_MS,
  type CommunitiesTabPreloadGate,
  type IdleCommunitiesTabPreloadSnapshot,
} from "./communitiesTabPreload";
import {
  __resetIdleTabPreloadSerializer,
  beginIdleTabPreloadEpoch,
  getIdleTabPreloadCompleteAt,
  IDLE_TAB_PRELOAD_SERIAL_GAP_MS,
  markIdleTabPreloadComplete,
} from "./idleTabPreload";

const allow: CommunitiesTabPreloadGate = {
  platform: "android",
  appActive: true,
  communitiesIndexSuccess: true,
  scrollSettled: true,
  quietForMs: COMMUNITIES_TAB_PRELOAD_QUIET_MS,
  communitiesTabActive: false,
  alreadyPrefetched: false,
  peopleComplete: true,
  peopleCompleteForMs: IDLE_TAB_PRELOAD_SERIAL_GAP_MS,
};

describe("COMMUNITIES_TAB_PRELOAD_HREF", () => {
  it("is the communities tab index, not a nested communities route", () => {
    expect(COMMUNITIES_TAB_PRELOAD_HREF).toBe("/(tabs)/communities");
  });
});

describe("isCommunitiesIndexQueryKey", () => {
  it.each([
    ["recommended", COMMUNITIES_RECOMMENDED_QUERY_KEY],
    ["owned", COMMUNITIES_OWNED_QUERY_KEY],
    ["subscriptions", communitiesSubscriptionsQueryKey("alice")],
  ] as const)("is true for index key %s", (_label, queryKey) => {
    expect(isCommunitiesIndexQueryKey(queryKey)).toBe(true);
  });

  it.each([
    ["search", ["communities", "search"]],
    ["search query", ["communities", "search", "q"]],
  ] as const)("is false for %s", (_label, queryKey) => {
    expect(isCommunitiesIndexQueryKey(queryKey)).toBe(false);
  });

  it("treats @alice subscriptions as an index key", () => {
    expect(isCommunitiesIndexQueryKey(communitiesSubscriptionsQueryKey("@alice"))).toBe(true);
  });
});

describe("canPrefetchCommunitiesTab", () => {
  it("allows when all gates are open", () => {
    expect(canPrefetchCommunitiesTab(allow)).toBe(true);
  });

  it("allows when quiet exceeds the window", () => {
    expect(
      canPrefetchCommunitiesTab({ ...allow, quietForMs: COMMUNITIES_TAB_PRELOAD_QUIET_MS + 1 }),
    ).toBe(true);
  });

  it.each([
    ["ios", { platform: "ios" }],
    ["web", { platform: "web" }],
    ["app inactive", { appActive: false }],
    ["communities index not success", { communitiesIndexSuccess: false }],
    ["scroll not settled", { scrollSettled: false }],
    ["quiet window", { quietForMs: COMMUNITIES_TAB_PRELOAD_QUIET_MS - 1 }],
    ["quiet just started", { quietForMs: 0 }],
    ["communities tab active", { communitiesTabActive: true }],
    ["already prefetched", { alreadyPrefetched: true }],
    ["people not complete", { peopleComplete: false }],
    ["people gap", { peopleCompleteForMs: IDLE_TAB_PRELOAD_SERIAL_GAP_MS - 1 }],
  ] as const)("blocks when %s", (_label, override) => {
    expect(canPrefetchCommunitiesTab({ ...allow, ...override })).toBe(false);
  });
});

describe("createIdleCommunitiesTabPreloadController", () => {
  afterEach(() => {
    vi.useRealTimers();
    __resetIdleTabPreloadSerializer();
  });

  function makeController(
    overrides: {
      settled?: { value: boolean };
      snapshot?: IdleCommunitiesTabPreloadSnapshot;
      skipPeopleComplete?: boolean;
    } = {},
  ) {
    if (!overrides.skipPeopleComplete) {
      markIdleTabPreloadComplete("people");
    }
    const settled = overrides.settled ?? { value: true };
    const snapshot: IdleCommunitiesTabPreloadSnapshot = overrides.snapshot ?? {
      platform: "android",
      appActive: true,
      communitiesIndexSuccess: true,
      communitiesTabActive: false,
    };
    const prefetch = vi.fn();
    const controller = createIdleCommunitiesTabPreloadController({
      quietMs: COMMUNITIES_TAB_PRELOAD_QUIET_MS,
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
    vi.advanceTimersByTime(COMMUNITIES_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).not.toHaveBeenCalled();
    expect(controller.hasPendingTimer()).toBe(false);
    settled.value = true;
    controller.onScrollSettled(true);
    vi.advanceTimersByTime(COMMUNITIES_TAB_PRELOAD_QUIET_MS - 1);
    expect(prefetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("does not prefetch before communities index queries succeed", () => {
    vi.useFakeTimers();
    const { controller, prefetch } = makeController({
      snapshot: {
        platform: "android",
        appActive: true,
        communitiesIndexSuccess: false,
        communitiesTabActive: false,
      },
    });
    controller.evaluate();
    vi.advanceTimersByTime(COMMUNITIES_TAB_PRELOAD_QUIET_MS);
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
    vi.advanceTimersByTime(COMMUNITIES_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("does not latch prefetch if scroll is busy when the quiet timer fires", () => {
    vi.useFakeTimers();
    const { controller, prefetch, settled } = makeController();
    controller.evaluate();
    settled.value = false;
    vi.advanceTimersByTime(COMMUNITIES_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).not.toHaveBeenCalled();
    expect(controller.hasPrefetched()).toBe(false);
  });

  it("prefetches once after the quiet window", () => {
    vi.useFakeTimers();
    const { controller, prefetch } = makeController();
    controller.evaluate();
    vi.advanceTimersByTime(COMMUNITIES_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).toHaveBeenCalledTimes(1);
    controller.evaluate();
    vi.advanceTimersByTime(COMMUNITIES_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("does not prefetch until people complete for 120ms", () => {
    vi.useFakeTimers();
    const { controller, prefetch } = makeController({ skipPeopleComplete: true });
    controller.evaluate();
    vi.advanceTimersByTime(COMMUNITIES_TAB_PRELOAD_QUIET_MS * 4);
    expect(prefetch).not.toHaveBeenCalled();

    markIdleTabPreloadComplete("people");
    controller.evaluate();
    vi.advanceTimersByTime(IDLE_TAB_PRELOAD_SERIAL_GAP_MS - 1);
    expect(prefetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("does not treat a previous people stamp after a new people epoch", () => {
    vi.useFakeTimers();
    markIdleTabPreloadComplete("people");
    beginIdleTabPreloadEpoch("people");
    const { controller, prefetch } = makeController({ skipPeopleComplete: true });
    controller.evaluate();
    vi.advanceTimersByTime(COMMUNITIES_TAB_PRELOAD_QUIET_MS * 4);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("latches skip when the communities tab is already active and does not stamp people", () => {
    const { controller, prefetch } = makeController({
      skipPeopleComplete: true,
      snapshot: {
        platform: "android",
        appActive: true,
        communitiesIndexSuccess: true,
        communitiesTabActive: true,
      },
    });
    controller.evaluate();
    expect(prefetch).not.toHaveBeenCalled();
    expect(controller.hasPrefetched()).toBe(true);
    expect(getIdleTabPreloadCompleteAt("people")).toBeNull();
    expect(getIdleTabPreloadCompleteAt("messages")).toBeNull();
    expect(getIdleTabPreloadCompleteAt("notifications")).toBeNull();
    expect(getIdleTabPreloadCompleteAt("profile")).toBeNull();
    expect(getIdleTabPreloadCompleteAt("music")).toBeNull();
  });
});
