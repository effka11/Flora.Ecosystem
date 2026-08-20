import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetIdleTabPreloadSerializer, getMessagesIdlePreloadCompleteAt } from "./idleTabPreload";
import {
  canPrefetchMessagesTab,
  createIdleMessagesTabPreloadController,
  MESSAGES_TAB_PRELOAD_QUIET_MS,
  type IdleMessagesTabPreloadSnapshot,
  type MessagesTabPreloadGate,
} from "./messagesTabPreload";

const allow: MessagesTabPreloadGate = {
  platform: "android",
  appActive: true,
  conversationsSuccess: true,
  scrollSettled: true,
  quietForMs: MESSAGES_TAB_PRELOAD_QUIET_MS,
  messagesTabActive: false,
  alreadyPrefetched: false,
};

describe("canPrefetchMessagesTab", () => {
  it("allows when all gates are open", () => {
    expect(canPrefetchMessagesTab(allow)).toBe(true);
  });

  it("allows when quiet exceeds the window", () => {
    expect(canPrefetchMessagesTab({ ...allow, quietForMs: MESSAGES_TAB_PRELOAD_QUIET_MS + 1 })).toBe(
      true,
    );
  });

  it.each([
    ["ios", { platform: "ios" }],
    ["web", { platform: "web" }],
    ["app inactive", { appActive: false }],
    ["conversations not success", { conversationsSuccess: false }],
    ["scroll not settled", { scrollSettled: false }],
    ["quiet window", { quietForMs: MESSAGES_TAB_PRELOAD_QUIET_MS - 1 }],
    ["quiet just started", { quietForMs: 0 }],
    ["messages tab active", { messagesTabActive: true }],
    ["already prefetched", { alreadyPrefetched: true }],
  ] as const)("blocks when %s", (_label, override) => {
    expect(canPrefetchMessagesTab({ ...allow, ...override })).toBe(false);
  });
});

describe("createIdleMessagesTabPreloadController", () => {
  afterEach(() => {
    vi.useRealTimers();
    __resetIdleTabPreloadSerializer();
  });

  function makeController(
    overrides: {
      settled?: { value: boolean };
      snapshot?: IdleMessagesTabPreloadSnapshot;
    } = {},
  ) {
    const settled = overrides.settled ?? { value: true };
    const snapshot: IdleMessagesTabPreloadSnapshot = overrides.snapshot ?? {
      platform: "android",
      appActive: true,
      conversationsSuccess: true,
      messagesTabActive: false,
    };
    const prefetch = vi.fn();
    const controller = createIdleMessagesTabPreloadController({
      quietMs: MESSAGES_TAB_PRELOAD_QUIET_MS,
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
    vi.advanceTimersByTime(MESSAGES_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).not.toHaveBeenCalled();
    expect(controller.hasPendingTimer()).toBe(false);
    settled.value = true;
    controller.onScrollSettled(true);
    vi.advanceTimersByTime(MESSAGES_TAB_PRELOAD_QUIET_MS - 1);
    expect(prefetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("does not prefetch before conversations success", () => {
    vi.useFakeTimers();
    const { controller, prefetch } = makeController({
      snapshot: {
        platform: "android",
        appActive: true,
        conversationsSuccess: false,
        messagesTabActive: false,
      },
    });
    controller.evaluate();
    vi.advanceTimersByTime(MESSAGES_TAB_PRELOAD_QUIET_MS);
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
    vi.advanceTimersByTime(MESSAGES_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("does not latch prefetch if scroll is busy when the quiet timer fires", () => {
    vi.useFakeTimers();
    const { controller, prefetch, settled } = makeController();
    controller.evaluate();
    settled.value = false;
    vi.advanceTimersByTime(MESSAGES_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).not.toHaveBeenCalled();
    expect(controller.hasPrefetched()).toBe(false);
  });

  it("prefetches once after the quiet window", () => {
    vi.useFakeTimers();
    const { controller, prefetch } = makeController();
    controller.evaluate();
    vi.advanceTimersByTime(MESSAGES_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).toHaveBeenCalledTimes(1);
    controller.evaluate();
    vi.advanceTimersByTime(MESSAGES_TAB_PRELOAD_QUIET_MS);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("marks messages preload complete when the messages tab is already active", () => {
    const { controller, prefetch } = makeController({
      snapshot: {
        platform: "android",
        appActive: true,
        conversationsSuccess: true,
        messagesTabActive: true,
      },
    });
    controller.evaluate();
    expect(prefetch).not.toHaveBeenCalled();
    expect(controller.hasPrefetched()).toBe(true);
    expect(getMessagesIdlePreloadCompleteAt()).not.toBeNull();
  });
});
