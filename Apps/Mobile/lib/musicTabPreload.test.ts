import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetIdleTabPreloadSerializer,
  beginIdleTabPreloadEpoch,
  getIdleTabPreloadCompleteAt,
  IDLE_TAB_PRELOAD_SERIAL_GAP_MS,
  markIdleTabPreloadComplete,
} from "./idleTabPreload";
import {
  canPrefetchMusicTab,
  createIdleMusicTabPreloadController,
  isMusicIndexQueryKey,
  MUSIC_TAB_PRELOAD_HREF,
  MUSIC_TAB_PRELOAD_QUIET_MS,
  type IdleMusicTabPreloadSnapshot,
  type MusicTabPreloadGate,
} from "./musicTabPreload";

const allow: MusicTabPreloadGate = {
  platform: "android",
  appActive: true,
  musicIndexSuccess: true,
  scrollSettled: true,
  quietForMs: MUSIC_TAB_PRELOAD_QUIET_MS,
  musicTabActive: false,
  alreadyPrefetched: false,
  profileComplete: true,
  profileCompleteForMs: IDLE_TAB_PRELOAD_SERIAL_GAP_MS,
};

describe("MUSIC_TAB_PRELOAD_HREF", () => {
  it("is the music tab index, not a nested music route", () => {
    expect(MUSIC_TAB_PRELOAD_HREF).toBe("/(tabs)/music");
  });
});

describe("isMusicIndexQueryKey", () => {
  it.each([["music-library"], ["music-playlists"]] as const)(
    "is true for index key %s",
    (key) => {
      expect(isMusicIndexQueryKey([key])).toBe(true);
    },
  );

  it.each([
    ["nested playlist", ["music-playlist", "pl-1"]],
    ["genre", ["music-genre", "g1"]],
    ["genre nested", ["music-genre", "g1", "sg1"]],
    ["artist", ["music-artist", "uuid"]],
    ["artist tracks", ["music-artist-tracks", "uuid", 1]],
    ["artists search", ["music-artists-search", "q"]],
  ] as const)("is false for %s", (_label, queryKey) => {
    expect(isMusicIndexQueryKey(queryKey)).toBe(false);
  });
});

describe("canPrefetchMusicTab", () => {
  it("allows when all gates are open", () => {
    expect(canPrefetchMusicTab(allow)).toBe(true);
  });

  it("allows when quiet exceeds the window", () => {
    expect(
      canPrefetchMusicTab({ ...allow, quietForMs: MUSIC_TAB_PRELOAD_QUIET_MS + 1 }),
    ).toBe(true);
  });

  it.each([
    ["ios", { platform: "ios" }],
    ["web", { platform: "web" }],
    ["app inactive", { appActive: false }],
    ["music index not success", { musicIndexSuccess: false }],
    ["scroll not settled", { scrollSettled: false }],
    ["quiet window", { quietForMs: MUSIC_TAB_PRELOAD_QUIET_MS - 1 }],
    ["quiet just started", { quietForMs: 0 }],
    ["music tab active", { musicTabActive: true }],
    ["already prefetched", { alreadyPrefetched: true }],
    ["profile not complete", { profileComplete: false }],
    ["profile gap", { profileCompleteForMs: IDLE_TAB_PRELOAD_SERIAL_GAP_MS - 1 }],
  ] as const)("blocks when %s", (_label, override) => {
    expect(canPrefetchMusicTab({ ...allow, ...override })).toBe(false);
  });
});

describe("createIdleMusicTabPreloadController", () => {
  afterEach(() => {
    vi.useRealTimers();
    __resetIdleTabPreloadSerializer();
  });

  function makeController(
    overrides: {
      settled?: { value: boolean };
      snapshot?: IdleMusicTabPreloadSnapshot;
      skipProfileComplete?: boolean;
    } = {},
  ) {
    if (!overrides.skipProfileComplete) {
      markIdleTabPreloadComplete("profile");
    }
    const settled = overrides.settled ?? { value: true };
    const snapshot: IdleMusicTabPreloadSnapshot = overrides.snapshot ?? {
      platform: "android",
      appActive: true,
      musicIndexSuccess: true,
      musicTabActive: false,
    };
    const prefetch = vi.fn();
    const controller = createIdleMusicTabPreloadController({
      quietMs: MUSIC_TAB_PRELOAD_QUIET_MS,
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
    vi.advanceTimersByTime(MUSIC_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).not.toHaveBeenCalled();
    expect(controller.hasPendingTimer()).toBe(false);
    settled.value = true;
    controller.onScrollSettled(true);
    vi.advanceTimersByTime(MUSIC_TAB_PRELOAD_QUIET_MS - 1);
    expect(prefetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("does not prefetch before both index queries succeed", () => {
    vi.useFakeTimers();
    const { controller, prefetch } = makeController({
      snapshot: {
        platform: "android",
        appActive: true,
        musicIndexSuccess: false,
        musicTabActive: false,
      },
    });
    controller.evaluate();
    vi.advanceTimersByTime(MUSIC_TAB_PRELOAD_QUIET_MS);
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
    vi.advanceTimersByTime(MUSIC_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("does not latch prefetch if scroll is busy when the quiet timer fires", () => {
    vi.useFakeTimers();
    const { controller, prefetch, settled } = makeController();
    controller.evaluate();
    settled.value = false;
    vi.advanceTimersByTime(MUSIC_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).not.toHaveBeenCalled();
    expect(controller.hasPrefetched()).toBe(false);
  });

  it("prefetches once after the quiet window", () => {
    vi.useFakeTimers();
    const { controller, prefetch } = makeController();
    controller.evaluate();
    vi.advanceTimersByTime(MUSIC_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).toHaveBeenCalledTimes(1);
    controller.evaluate();
    vi.advanceTimersByTime(MUSIC_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("does not prefetch until profile complete for 120ms", () => {
    vi.useFakeTimers();
    const { controller, prefetch } = makeController({ skipProfileComplete: true });
    controller.evaluate();
    vi.advanceTimersByTime(MUSIC_TAB_PRELOAD_QUIET_MS * 4);
    expect(prefetch).not.toHaveBeenCalled();

    markIdleTabPreloadComplete("profile");
    controller.evaluate();
    vi.advanceTimersByTime(IDLE_TAB_PRELOAD_SERIAL_GAP_MS - 1);
    expect(prefetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("does not treat a previous profile stamp after a new profile epoch", () => {
    vi.useFakeTimers();
    markIdleTabPreloadComplete("profile");
    beginIdleTabPreloadEpoch("profile");
    const { controller, prefetch } = makeController({ skipProfileComplete: true });
    controller.evaluate();
    vi.advanceTimersByTime(MUSIC_TAB_PRELOAD_QUIET_MS * 4);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("latches skip when the music tab is already active without stamping profile or inventing a music stage", () => {
    const { controller, prefetch } = makeController({
      skipProfileComplete: true,
      snapshot: {
        platform: "android",
        appActive: true,
        musicIndexSuccess: true,
        musicTabActive: true,
      },
    });
    controller.evaluate();
    expect(prefetch).not.toHaveBeenCalled();
    expect(controller.hasPrefetched()).toBe(true);
    expect(getIdleTabPreloadCompleteAt("profile")).toBeNull();
  });
});
