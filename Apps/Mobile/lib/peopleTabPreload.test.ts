import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetIdleTabPreloadSerializer,
  beginIdleTabPreloadEpoch,
  getIdleTabPreloadCompleteAt,
  IDLE_TAB_PRELOAD_SERIAL_GAP_MS,
  markIdleTabPreloadComplete,
} from "./idleTabPreload";
import {
  PEOPLE_RECOMMENDED_QUERY_KEY,
  peopleFollowersQueryKey,
  peopleFollowingQueryKey,
} from "./people/peopleIndexQueries";
import {
  canPrefetchPeopleTab,
  createIdlePeopleTabPreloadController,
  isPeopleIndexQueryKey,
  PEOPLE_TAB_PRELOAD_HREF,
  PEOPLE_TAB_PRELOAD_QUIET_MS,
  type IdlePeopleTabPreloadSnapshot,
  type PeopleTabPreloadGate,
} from "./peopleTabPreload";

const allow: PeopleTabPreloadGate = {
  platform: "android",
  appActive: true,
  peopleIndexSuccess: true,
  scrollSettled: true,
  quietForMs: PEOPLE_TAB_PRELOAD_QUIET_MS,
  peopleTabActive: false,
  alreadyPrefetched: false,
  musicComplete: true,
  musicCompleteForMs: IDLE_TAB_PRELOAD_SERIAL_GAP_MS,
};

describe("PEOPLE_TAB_PRELOAD_HREF", () => {
  it("is the people tab index, not a nested people route", () => {
    expect(PEOPLE_TAB_PRELOAD_HREF).toBe("/(tabs)/people");
  });
});

describe("isPeopleIndexQueryKey", () => {
  it.each([
    ["recommended", PEOPLE_RECOMMENDED_QUERY_KEY],
    ["followers", peopleFollowersQueryKey("alice")],
    ["following", peopleFollowingQueryKey("alice")],
  ] as const)("is true for index key %s", (_label, queryKey) => {
    expect(isPeopleIndexQueryKey(queryKey)).toBe(true);
  });

  it.each([
    ["search", ["people", "search"]],
    ["search query", ["people", "search", "q"]],
  ] as const)("is false for %s", (_label, queryKey) => {
    expect(isPeopleIndexQueryKey(queryKey)).toBe(false);
  });

  it("shares followers and following cache keys for @alice and alice", () => {
    expect(peopleFollowersQueryKey("@alice")).toEqual(peopleFollowersQueryKey("alice"));
    expect(peopleFollowingQueryKey("@alice")).toEqual(peopleFollowingQueryKey("alice"));
  });
});

describe("canPrefetchPeopleTab", () => {
  it("allows when all gates are open", () => {
    expect(canPrefetchPeopleTab(allow)).toBe(true);
  });

  it("allows when quiet exceeds the window", () => {
    expect(
      canPrefetchPeopleTab({ ...allow, quietForMs: PEOPLE_TAB_PRELOAD_QUIET_MS + 1 }),
    ).toBe(true);
  });

  it.each([
    ["ios", { platform: "ios" }],
    ["web", { platform: "web" }],
    ["app inactive", { appActive: false }],
    ["people index not success", { peopleIndexSuccess: false }],
    ["scroll not settled", { scrollSettled: false }],
    ["quiet window", { quietForMs: PEOPLE_TAB_PRELOAD_QUIET_MS - 1 }],
    ["quiet just started", { quietForMs: 0 }],
    ["people tab active", { peopleTabActive: true }],
    ["already prefetched", { alreadyPrefetched: true }],
    ["music not complete", { musicComplete: false }],
    ["music gap", { musicCompleteForMs: IDLE_TAB_PRELOAD_SERIAL_GAP_MS - 1 }],
  ] as const)("blocks when %s", (_label, override) => {
    expect(canPrefetchPeopleTab({ ...allow, ...override })).toBe(false);
  });
});

describe("createIdlePeopleTabPreloadController", () => {
  afterEach(() => {
    vi.useRealTimers();
    __resetIdleTabPreloadSerializer();
  });

  function makeController(
    overrides: {
      settled?: { value: boolean };
      snapshot?: IdlePeopleTabPreloadSnapshot;
      skipMusicComplete?: boolean;
    } = {},
  ) {
    if (!overrides.skipMusicComplete) {
      markIdleTabPreloadComplete("music");
    }
    const settled = overrides.settled ?? { value: true };
    const snapshot: IdlePeopleTabPreloadSnapshot = overrides.snapshot ?? {
      platform: "android",
      appActive: true,
      peopleIndexSuccess: true,
      peopleTabActive: false,
    };
    const prefetch = vi.fn();
    const controller = createIdlePeopleTabPreloadController({
      quietMs: PEOPLE_TAB_PRELOAD_QUIET_MS,
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
    vi.advanceTimersByTime(PEOPLE_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).not.toHaveBeenCalled();
    expect(controller.hasPendingTimer()).toBe(false);
    settled.value = true;
    controller.onScrollSettled(true);
    vi.advanceTimersByTime(PEOPLE_TAB_PRELOAD_QUIET_MS - 1);
    expect(prefetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("does not prefetch before people index queries succeed", () => {
    vi.useFakeTimers();
    const { controller, prefetch } = makeController({
      snapshot: {
        platform: "android",
        appActive: true,
        peopleIndexSuccess: false,
        peopleTabActive: false,
      },
    });
    controller.evaluate();
    vi.advanceTimersByTime(PEOPLE_TAB_PRELOAD_QUIET_MS);
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
    vi.advanceTimersByTime(PEOPLE_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("does not latch prefetch if scroll is busy when the quiet timer fires", () => {
    vi.useFakeTimers();
    const { controller, prefetch, settled } = makeController();
    controller.evaluate();
    settled.value = false;
    vi.advanceTimersByTime(PEOPLE_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).not.toHaveBeenCalled();
    expect(controller.hasPrefetched()).toBe(false);
  });

  it("prefetches once after the quiet window", () => {
    vi.useFakeTimers();
    const { controller, prefetch } = makeController();
    controller.evaluate();
    vi.advanceTimersByTime(PEOPLE_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).toHaveBeenCalledTimes(1);
    controller.evaluate();
    vi.advanceTimersByTime(PEOPLE_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("does not prefetch until music complete for 120ms", () => {
    vi.useFakeTimers();
    const { controller, prefetch } = makeController({ skipMusicComplete: true });
    controller.evaluate();
    vi.advanceTimersByTime(PEOPLE_TAB_PRELOAD_QUIET_MS * 4);
    expect(prefetch).not.toHaveBeenCalled();

    markIdleTabPreloadComplete("music");
    controller.evaluate();
    vi.advanceTimersByTime(IDLE_TAB_PRELOAD_SERIAL_GAP_MS - 1);
    expect(prefetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("does not treat a previous music stamp after a new music epoch", () => {
    vi.useFakeTimers();
    markIdleTabPreloadComplete("music");
    beginIdleTabPreloadEpoch("music");
    const { controller, prefetch } = makeController({ skipMusicComplete: true });
    controller.evaluate();
    vi.advanceTimersByTime(PEOPLE_TAB_PRELOAD_QUIET_MS * 4);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("latches skip when the people tab is already active and does not stamp music", () => {
    const { controller, prefetch } = makeController({
      skipMusicComplete: true,
      snapshot: {
        platform: "android",
        appActive: true,
        peopleIndexSuccess: true,
        peopleTabActive: true,
      },
    });
    controller.evaluate();
    expect(prefetch).not.toHaveBeenCalled();
    expect(controller.hasPrefetched()).toBe(true);
    expect(getIdleTabPreloadCompleteAt("messages")).toBeNull();
    expect(getIdleTabPreloadCompleteAt("notifications")).toBeNull();
    expect(getIdleTabPreloadCompleteAt("profile")).toBeNull();
    expect(getIdleTabPreloadCompleteAt("music")).toBeNull();
  });
});
