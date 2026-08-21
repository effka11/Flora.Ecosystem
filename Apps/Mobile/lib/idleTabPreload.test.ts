import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetIdleTabPreloadSerializer,
  abortQueuedIdleTabPrefetch,
  beginIdleTabPreloadEpoch,
  beginMessagesIdlePreloadEpoch,
  canPrefetchIdleTab,
  canRunQueuedIdleTabPrefetch,
  createIdleTabPreloadController,
  createIdleTabPreloadSerializer,
  getIdleTabPreloadCompleteAt,
  getIdleTabPreloadSerializer,
  getMessagesIdlePreloadCompleteAt,
  IDLE_TAB_PRELOAD_QUIET_MS,
  IDLE_TAB_PRELOAD_SERIAL_GAP_MS,
  markIdleTabPreloadComplete,
  markMessagesIdlePreloadComplete,
  subscribeIdleTabPreloadComplete,
  subscribeMessagesIdlePreloadComplete,
  type IdleTabPreloadGate,
} from "./idleTabPreload";
import { __resetScrollActivity, isScrollSettled } from "./scrollActivity";

const allow: IdleTabPreloadGate = {
  platform: "android",
  appActive: true,
  dataSuccess: true,
  scrollSettled: true,
  quietForMs: IDLE_TAB_PRELOAD_QUIET_MS,
  tabActive: false,
  alreadyPrefetched: false,
  predecessorComplete: true,
  predecessorCompleteForMs: IDLE_TAB_PRELOAD_SERIAL_GAP_MS,
};

describe("canPrefetchIdleTab", () => {
  it("allows when all gates are open", () => {
    expect(canPrefetchIdleTab(allow)).toBe(true);
  });

  it("allows when quiet exceeds the window", () => {
    expect(canPrefetchIdleTab({ ...allow, quietForMs: IDLE_TAB_PRELOAD_QUIET_MS + 1 })).toBe(true);
  });

  it.each([
    ["ios", { platform: "ios" }],
    ["web", { platform: "web" }],
    ["app inactive", { appActive: false }],
    ["data not success", { dataSuccess: false }],
    ["scroll not settled", { scrollSettled: false }],
    ["quiet window", { quietForMs: IDLE_TAB_PRELOAD_QUIET_MS - 1 }],
    ["quiet just started", { quietForMs: 0 }],
    ["target tab active", { tabActive: true }],
    ["already prefetched", { alreadyPrefetched: true }],
    ["predecessor not complete", { predecessorComplete: false }],
    ["predecessor gap", { predecessorCompleteForMs: IDLE_TAB_PRELOAD_SERIAL_GAP_MS - 1 }],
  ] as const)("blocks when %s", (_label, override) => {
    expect(canPrefetchIdleTab({ ...allow, ...override })).toBe(false);
  });
});

describe("createIdleTabPreloadSerializer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeSerializer() {
    vi.useFakeTimers();
    let clock = 0;
    const serializer = createIdleTabPreloadSerializer({ now: () => clock });
    const advance = (ms: number) => {
      clock += ms;
      vi.advanceTimersByTime(ms);
    };
    return { serializer, advance };
  }

  it("runs the first job immediately", () => {
    const { serializer } = makeSerializer();
    const job = vi.fn();
    serializer.enqueue(Symbol("first"), job);
    expect(job).toHaveBeenCalledTimes(1);
    expect(serializer.isInFlight()).toBe(true);
  });

  it("holds the next job until the running one releases plus the gap", () => {
    const { serializer, advance } = makeSerializer();
    let releaseFirst = () => {};
    serializer.enqueue(Symbol("first"), (release) => {
      releaseFirst = release;
    });
    const second = vi.fn();
    serializer.enqueue(Symbol("second"), second);

    advance(IDLE_TAB_PRELOAD_SERIAL_GAP_MS * 2);
    expect(second).not.toHaveBeenCalled();

    releaseFirst();
    expect(second).not.toHaveBeenCalled();
    advance(IDLE_TAB_PRELOAD_SERIAL_GAP_MS - 1);
    expect(second).not.toHaveBeenCalled();
    advance(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("stays in flight while a job waits on the gap", () => {
    const { serializer, advance } = makeSerializer();
    let releaseFirst = () => {};
    let releaseSecond = () => {};
    serializer.enqueue(Symbol("first"), (release) => {
      releaseFirst = release;
    });
    serializer.enqueue(Symbol("second"), (release) => {
      releaseSecond = release;
    });

    expect(serializer.isInFlight()).toBe(true);
    releaseFirst();
    expect(serializer.isInFlight()).toBe(true);
    advance(IDLE_TAB_PRELOAD_SERIAL_GAP_MS);
    expect(serializer.isInFlight()).toBe(true);
    releaseSecond();
    expect(serializer.isInFlight()).toBe(false);
  });

  it("ignores a release from an owner that is not inflight", () => {
    const { serializer, advance } = makeSerializer();
    serializer.enqueue(Symbol("first"), () => {});
    const second = vi.fn();
    serializer.enqueue(Symbol("second"), second);

    serializer.release(Symbol("stranger"));
    advance(IDLE_TAB_PRELOAD_SERIAL_GAP_MS * 2);
    expect(second).not.toHaveBeenCalled();
    expect(serializer.isInFlight()).toBe(true);
  });

  it("keeps the gap when release is called twice", () => {
    const { serializer, advance } = makeSerializer();
    let releaseFirst = () => {};
    serializer.enqueue(Symbol("first"), (release) => {
      releaseFirst = release;
    });
    const second = vi.fn();
    serializer.enqueue(Symbol("second"), second);

    releaseFirst();
    advance(IDLE_TAB_PRELOAD_SERIAL_GAP_MS - 10);
    releaseFirst();
    expect(second).not.toHaveBeenCalled();
    advance(10);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("drops a queued job when its owner releases before it starts", () => {
    const { serializer, advance } = makeSerializer();
    let releaseFirst = () => {};
    serializer.enqueue(Symbol("first"), (release) => {
      releaseFirst = release;
    });
    const secondOwner = Symbol("second");
    const second = vi.fn();
    serializer.enqueue(secondOwner, second);

    serializer.release(secondOwner);
    releaseFirst();
    advance(IDLE_TAB_PRELOAD_SERIAL_GAP_MS * 2);
    expect(second).not.toHaveBeenCalled();
    expect(serializer.isInFlight()).toBe(false);
  });

  it("unsticks the lock when the inflight owner is released by cleanup", () => {
    const { serializer, advance } = makeSerializer();
    const firstOwner = Symbol("first");
    serializer.enqueue(firstOwner, () => {});
    const second = vi.fn();
    serializer.enqueue(Symbol("second"), second);

    serializer.release(firstOwner);
    advance(IDLE_TAB_PRELOAD_SERIAL_GAP_MS);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("honours the gap for a job enqueued after the previous release", () => {
    const { serializer, advance } = makeSerializer();
    let releaseFirst = () => {};
    serializer.enqueue(Symbol("first"), (release) => {
      releaseFirst = release;
    });
    releaseFirst();

    const second = vi.fn();
    serializer.enqueue(Symbol("second"), second);
    expect(second).not.toHaveBeenCalled();
    advance(IDLE_TAB_PRELOAD_SERIAL_GAP_MS - 1);
    expect(second).not.toHaveBeenCalled();
    advance(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("drops queued work on dispose", () => {
    const { serializer, advance } = makeSerializer();
    let releaseFirst = () => {};
    serializer.enqueue(Symbol("first"), (release) => {
      releaseFirst = release;
    });
    const second = vi.fn();
    serializer.enqueue(Symbol("second"), second);

    serializer.dispose();
    releaseFirst();
    advance(IDLE_TAB_PRELOAD_SERIAL_GAP_MS * 2);
    expect(second).not.toHaveBeenCalled();
    expect(serializer.isInFlight()).toBe(false);
  });

  it("aborts a queued job when shouldRun is false after the gap", () => {
    const { serializer, advance } = makeSerializer();
    let releaseFirst = () => {};
    serializer.enqueue(Symbol("first"), (release) => {
      releaseFirst = release;
    });
    const second = vi.fn();
    const onAbort = vi.fn();
    let canRun = true;
    serializer.enqueue(Symbol("second"), second, {
      shouldRun: () => canRun,
      onAbort,
    });

    releaseFirst();
    canRun = false;
    advance(IDLE_TAB_PRELOAD_SERIAL_GAP_MS);
    expect(second).not.toHaveBeenCalled();
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(serializer.isInFlight()).toBe(false);
  });

  it("dropQueued removes a waiting job without running it", () => {
    const { serializer, advance } = makeSerializer();
    let releaseFirst = () => {};
    serializer.enqueue(Symbol("first"), (release) => {
      releaseFirst = release;
    });
    const secondOwner = Symbol("second");
    const second = vi.fn();
    serializer.enqueue(secondOwner, second);

    serializer.dropQueued(secondOwner);
    releaseFirst();
    advance(IDLE_TAB_PRELOAD_SERIAL_GAP_MS * 2);
    expect(second).not.toHaveBeenCalled();
    expect(serializer.isInFlight()).toBe(false);
  });

  it("notifies onInFlight around the running job", () => {
    const inflight = vi.fn();
    const tracked = createIdleTabPreloadSerializer({
      now: () => 0,
      onInFlight: inflight,
    });
    const owner = Symbol("owner");
    let release = () => {};
    tracked.enqueue(owner, (next) => {
      release = next;
    });
    expect(inflight).toHaveBeenCalledWith(owner, true);
    release();
    expect(inflight).toHaveBeenCalledWith(owner, false);
    tracked.dispose();
  });
});

describe("createIdleTabPreloadController predecessor barrier", () => {
  afterEach(() => {
    vi.useRealTimers();
    __resetIdleTabPreloadSerializer();
  });

  it("waits for predecessorComplete plus the serial gap before prefetch", () => {
    vi.useFakeTimers();
    let clock = 0;
    let predecessorComplete = false;
    let predecessorCompleteAt = 0;
    const prefetch = vi.fn();
    const controller = createIdleTabPreloadController({
      now: () => clock,
      isScrollSettled: () => true,
      getSnapshot: () => ({
        platform: "android",
        appActive: true,
        dataSuccess: true,
        tabActive: false,
        predecessorComplete,
        predecessorCompleteForMs: predecessorComplete ? clock - predecessorCompleteAt : 0,
      }),
      prefetch,
    });

    controller.evaluate();
    clock += IDLE_TAB_PRELOAD_QUIET_MS * 4;
    vi.advanceTimersByTime(IDLE_TAB_PRELOAD_QUIET_MS * 4);
    expect(prefetch).not.toHaveBeenCalled();

    predecessorComplete = true;
    predecessorCompleteAt = clock;
    controller.evaluate();
    clock += IDLE_TAB_PRELOAD_SERIAL_GAP_MS - 1;
    vi.advanceTimersByTime(IDLE_TAB_PRELOAD_SERIAL_GAP_MS - 1);
    expect(prefetch).not.toHaveBeenCalled();
    clock += 1;
    vi.advanceTimersByTime(1);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("reports quiet elapsed only while scroll is settled", () => {
    vi.useFakeTimers();
    let clock = 0;
    const settled = { value: true };
    const controller = createIdleTabPreloadController({
      now: () => clock,
      isScrollSettled: () => settled.value,
      getSnapshot: () => ({
        platform: "android",
        appActive: true,
        dataSuccess: true,
        tabActive: false,
        predecessorComplete: true,
        predecessorCompleteForMs: IDLE_TAB_PRELOAD_SERIAL_GAP_MS,
      }),
      prefetch: vi.fn(),
    });

    controller.evaluate();
    expect(controller.quietForMs()).toBe(0);
    clock += IDLE_TAB_PRELOAD_QUIET_MS;
    expect(controller.quietForMs()).toBe(IDLE_TAB_PRELOAD_QUIET_MS);
    settled.value = false;
    controller.onScrollSettled(false);
    expect(controller.quietForMs()).toBe(0);
  });
});

describe("getIdleTabPreloadSerializer", () => {
  afterEach(() => {
    __resetIdleTabPreloadSerializer();
    __resetScrollActivity();
  });

  it("returns one shared lock", () => {
    expect(getIdleTabPreloadSerializer()).toBe(getIdleTabPreloadSerializer());
  });

  it("hands out a fresh lock after reset", () => {
    const first = getIdleTabPreloadSerializer();
    first.enqueue(Symbol("owner"), () => {});
    expect(first.isInFlight()).toBe(true);

    __resetIdleTabPreloadSerializer();
    const next = getIdleTabPreloadSerializer();
    expect(next).not.toBe(first);
    expect(next.isInFlight()).toBe(false);
  });

  it("holds scrollActivity mount while a shared job is inflight", () => {
    const serializer = getIdleTabPreloadSerializer();
    const owner = Symbol("owner");
    serializer.enqueue(owner, () => {});
    expect(isScrollSettled()).toBe(false);
    serializer.release(owner);
    expect(isScrollSettled()).toBe(true);
  });
});

describe("canRunQueuedIdleTabPrefetch", () => {
  const fireAllow = {
    cancelled: false,
    platform: "android",
    appActive: true,
    dataSuccess: true,
    scrollSettled: true,
    quietForMs: IDLE_TAB_PRELOAD_QUIET_MS,
    tabActive: false,
    predecessorComplete: true,
    predecessorCompleteForMs: IDLE_TAB_PRELOAD_SERIAL_GAP_MS,
  };

  it("allows when fire gates are open", () => {
    expect(canRunQueuedIdleTabPrefetch(fireAllow)).toBe(true);
  });

  it("allows when quiet exceeds the window", () => {
    expect(
      canRunQueuedIdleTabPrefetch({ ...fireAllow, quietForMs: IDLE_TAB_PRELOAD_QUIET_MS + 1 }),
    ).toBe(true);
  });

  it.each([
    ["cancelled", { cancelled: true }],
    ["ios", { platform: "ios" }],
    ["web", { platform: "web" }],
    ["scroll busy", { scrollSettled: false }],
    ["app background", { appActive: false }],
    ["data not success", { dataSuccess: false }],
    ["quiet window", { quietForMs: IDLE_TAB_PRELOAD_QUIET_MS - 1 }],
    ["quiet just started", { quietForMs: 0 }],
    ["target tab active", { tabActive: true }],
    ["predecessor not complete", { predecessorComplete: false }],
    ["predecessor gap", { predecessorCompleteForMs: IDLE_TAB_PRELOAD_SERIAL_GAP_MS - 1 }],
  ] as const)("blocks when %s", (_label, override) => {
    expect(canRunQueuedIdleTabPrefetch({ ...fireAllow, ...override })).toBe(false);
  });
});

describe("messages idle epoch", () => {
  afterEach(() => {
    __resetIdleTabPreloadSerializer();
  });

  it("invalidates a previous complete stamp", () => {
    markMessagesIdlePreloadComplete(1);
    expect(getMessagesIdlePreloadCompleteAt()).toBe(1);
    beginMessagesIdlePreloadEpoch();
    expect(getMessagesIdlePreloadCompleteAt()).toBeNull();
    markMessagesIdlePreloadComplete(2);
    expect(getMessagesIdlePreloadCompleteAt()).toBe(2);
  });

  it("notifies waiters when a new epoch starts", () => {
    const listener = vi.fn();
    const unsub = subscribeMessagesIdlePreloadComplete(listener);
    beginMessagesIdlePreloadEpoch();
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
  });
});

describe("notifications idle epoch", () => {
  afterEach(() => {
    __resetIdleTabPreloadSerializer();
  });

  it("begin resets a previous complete stamp", () => {
    markIdleTabPreloadComplete("notifications", 1);
    expect(getIdleTabPreloadCompleteAt("notifications")).toBe(1);
    beginIdleTabPreloadEpoch("notifications");
    expect(getIdleTabPreloadCompleteAt("notifications")).toBeNull();
  });

  it("mark sets getAt for the current epoch", () => {
    beginIdleTabPreloadEpoch("notifications");
    expect(getIdleTabPreloadCompleteAt("notifications")).toBeNull();
    markIdleTabPreloadComplete("notifications", 3);
    expect(getIdleTabPreloadCompleteAt("notifications")).toBe(3);
  });

  it("begin after mark invalidates the previous stamp", () => {
    markIdleTabPreloadComplete("notifications", 1);
    expect(getIdleTabPreloadCompleteAt("notifications")).toBe(1);
    beginIdleTabPreloadEpoch("notifications");
    expect(getIdleTabPreloadCompleteAt("notifications")).toBeNull();
    markIdleTabPreloadComplete("notifications", 2);
    expect(getIdleTabPreloadCompleteAt("notifications")).toBe(2);
  });

  it("notifies waiters when a new epoch starts", () => {
    const listener = vi.fn();
    const unsub = subscribeIdleTabPreloadComplete("notifications", listener);
    beginIdleTabPreloadEpoch("notifications");
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("does not stamp notifications when messages is marked", () => {
    markIdleTabPreloadComplete("messages", 4);
    expect(getIdleTabPreloadCompleteAt("messages")).toBe(4);
    expect(getIdleTabPreloadCompleteAt("notifications")).toBeNull();
  });
});

describe("profile idle epoch", () => {
  afterEach(() => {
    __resetIdleTabPreloadSerializer();
  });

  it("begin resets a previous complete stamp", () => {
    markIdleTabPreloadComplete("profile", 1);
    expect(getIdleTabPreloadCompleteAt("profile")).toBe(1);
    beginIdleTabPreloadEpoch("profile");
    expect(getIdleTabPreloadCompleteAt("profile")).toBeNull();
  });

  it("mark sets getAt for the current epoch", () => {
    beginIdleTabPreloadEpoch("profile");
    expect(getIdleTabPreloadCompleteAt("profile")).toBeNull();
    markIdleTabPreloadComplete("profile", 3);
    expect(getIdleTabPreloadCompleteAt("profile")).toBe(3);
  });

  it("begin after mark invalidates the previous stamp", () => {
    markIdleTabPreloadComplete("profile", 1);
    expect(getIdleTabPreloadCompleteAt("profile")).toBe(1);
    beginIdleTabPreloadEpoch("profile");
    expect(getIdleTabPreloadCompleteAt("profile")).toBeNull();
    markIdleTabPreloadComplete("profile", 2);
    expect(getIdleTabPreloadCompleteAt("profile")).toBe(2);
  });

  it("notifies waiters when a new epoch starts", () => {
    const listener = vi.fn();
    const unsub = subscribeIdleTabPreloadComplete("profile", listener);
    beginIdleTabPreloadEpoch("profile");
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("does not stamp profile when messages or notifications is marked", () => {
    markIdleTabPreloadComplete("messages", 4);
    markIdleTabPreloadComplete("notifications", 5);
    expect(getIdleTabPreloadCompleteAt("messages")).toBe(4);
    expect(getIdleTabPreloadCompleteAt("notifications")).toBe(5);
    expect(getIdleTabPreloadCompleteAt("profile")).toBeNull();
  });
});

describe("music idle epoch", () => {
  afterEach(() => {
    __resetIdleTabPreloadSerializer();
  });

  it("begin resets a previous complete stamp", () => {
    markIdleTabPreloadComplete("music", 1);
    expect(getIdleTabPreloadCompleteAt("music")).toBe(1);
    beginIdleTabPreloadEpoch("music");
    expect(getIdleTabPreloadCompleteAt("music")).toBeNull();
  });

  it("mark sets getAt for the current epoch", () => {
    beginIdleTabPreloadEpoch("music");
    expect(getIdleTabPreloadCompleteAt("music")).toBeNull();
    markIdleTabPreloadComplete("music", 3);
    expect(getIdleTabPreloadCompleteAt("music")).toBe(3);
  });

  it("begin after mark invalidates the previous stamp", () => {
    markIdleTabPreloadComplete("music", 1);
    expect(getIdleTabPreloadCompleteAt("music")).toBe(1);
    beginIdleTabPreloadEpoch("music");
    expect(getIdleTabPreloadCompleteAt("music")).toBeNull();
    markIdleTabPreloadComplete("music", 2);
    expect(getIdleTabPreloadCompleteAt("music")).toBe(2);
  });

  it("notifies waiters when a new epoch starts", () => {
    const listener = vi.fn();
    const unsub = subscribeIdleTabPreloadComplete("music", listener);
    beginIdleTabPreloadEpoch("music");
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("does not stamp music when messages, notifications, or profile is marked", () => {
    markIdleTabPreloadComplete("messages", 4);
    markIdleTabPreloadComplete("notifications", 5);
    markIdleTabPreloadComplete("profile", 6);
    expect(getIdleTabPreloadCompleteAt("messages")).toBe(4);
    expect(getIdleTabPreloadCompleteAt("notifications")).toBe(5);
    expect(getIdleTabPreloadCompleteAt("profile")).toBe(6);
    expect(getIdleTabPreloadCompleteAt("music")).toBeNull();
  });
});

describe("people idle epoch", () => {
  afterEach(() => {
    __resetIdleTabPreloadSerializer();
  });

  it("begin resets a previous complete stamp", () => {
    markIdleTabPreloadComplete("people", 1);
    expect(getIdleTabPreloadCompleteAt("people")).toBe(1);
    beginIdleTabPreloadEpoch("people");
    expect(getIdleTabPreloadCompleteAt("people")).toBeNull();
  });

  it("mark sets getAt for the current epoch", () => {
    beginIdleTabPreloadEpoch("people");
    expect(getIdleTabPreloadCompleteAt("people")).toBeNull();
    markIdleTabPreloadComplete("people", 3);
    expect(getIdleTabPreloadCompleteAt("people")).toBe(3);
  });

  it("begin after mark invalidates the previous stamp", () => {
    markIdleTabPreloadComplete("people", 1);
    expect(getIdleTabPreloadCompleteAt("people")).toBe(1);
    beginIdleTabPreloadEpoch("people");
    expect(getIdleTabPreloadCompleteAt("people")).toBeNull();
    markIdleTabPreloadComplete("people", 2);
    expect(getIdleTabPreloadCompleteAt("people")).toBe(2);
  });

  it("notifies waiters when a new epoch starts", () => {
    const listener = vi.fn();
    const unsub = subscribeIdleTabPreloadComplete("people", listener);
    beginIdleTabPreloadEpoch("people");
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("does not stamp people when messages, notifications, profile, or music is marked", () => {
    markIdleTabPreloadComplete("messages", 4);
    markIdleTabPreloadComplete("notifications", 5);
    markIdleTabPreloadComplete("profile", 6);
    markIdleTabPreloadComplete("music", 7);
    expect(getIdleTabPreloadCompleteAt("messages")).toBe(4);
    expect(getIdleTabPreloadCompleteAt("notifications")).toBe(5);
    expect(getIdleTabPreloadCompleteAt("profile")).toBe(6);
    expect(getIdleTabPreloadCompleteAt("music")).toBe(7);
    expect(getIdleTabPreloadCompleteAt("people")).toBeNull();
    expect(getIdleTabPreloadCompleteAt("communities")).toBeNull();
  });
});

describe("communities idle epoch", () => {
  afterEach(() => {
    __resetIdleTabPreloadSerializer();
  });

  it("begin resets a previous complete stamp", () => {
    markIdleTabPreloadComplete("communities", 1);
    expect(getIdleTabPreloadCompleteAt("communities")).toBe(1);
    beginIdleTabPreloadEpoch("communities");
    expect(getIdleTabPreloadCompleteAt("communities")).toBeNull();
  });

  it("mark sets getAt for the current epoch", () => {
    beginIdleTabPreloadEpoch("communities");
    expect(getIdleTabPreloadCompleteAt("communities")).toBeNull();
    markIdleTabPreloadComplete("communities", 3);
    expect(getIdleTabPreloadCompleteAt("communities")).toBe(3);
  });

  it("begin after mark invalidates the previous stamp", () => {
    markIdleTabPreloadComplete("communities", 1);
    expect(getIdleTabPreloadCompleteAt("communities")).toBe(1);
    beginIdleTabPreloadEpoch("communities");
    expect(getIdleTabPreloadCompleteAt("communities")).toBeNull();
    markIdleTabPreloadComplete("communities", 2);
    expect(getIdleTabPreloadCompleteAt("communities")).toBe(2);
  });

  it("notifies waiters when a new epoch starts", () => {
    const listener = vi.fn();
    const unsub = subscribeIdleTabPreloadComplete("communities", listener);
    beginIdleTabPreloadEpoch("communities");
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("does not stamp communities when messages, notifications, profile, music, or people is marked", () => {
    markIdleTabPreloadComplete("messages", 4);
    markIdleTabPreloadComplete("notifications", 5);
    markIdleTabPreloadComplete("profile", 6);
    markIdleTabPreloadComplete("music", 7);
    markIdleTabPreloadComplete("people", 8);
    expect(getIdleTabPreloadCompleteAt("messages")).toBe(4);
    expect(getIdleTabPreloadCompleteAt("notifications")).toBe(5);
    expect(getIdleTabPreloadCompleteAt("profile")).toBe(6);
    expect(getIdleTabPreloadCompleteAt("music")).toBe(7);
    expect(getIdleTabPreloadCompleteAt("people")).toBe(8);
    expect(getIdleTabPreloadCompleteAt("communities")).toBeNull();
    expect(getIdleTabPreloadCompleteAt("settings")).toBeNull();
  });
});

describe("settings idle epoch", () => {
  afterEach(() => {
    __resetIdleTabPreloadSerializer();
  });

  it("begin resets a previous complete stamp", () => {
    markIdleTabPreloadComplete("settings", 1);
    expect(getIdleTabPreloadCompleteAt("settings")).toBe(1);
    beginIdleTabPreloadEpoch("settings");
    expect(getIdleTabPreloadCompleteAt("settings")).toBeNull();
  });

  it("mark sets getAt for the current epoch", () => {
    beginIdleTabPreloadEpoch("settings");
    expect(getIdleTabPreloadCompleteAt("settings")).toBeNull();
    markIdleTabPreloadComplete("settings", 3);
    expect(getIdleTabPreloadCompleteAt("settings")).toBe(3);
  });

  it("begin after mark invalidates the previous stamp", () => {
    markIdleTabPreloadComplete("settings", 1);
    expect(getIdleTabPreloadCompleteAt("settings")).toBe(1);
    beginIdleTabPreloadEpoch("settings");
    expect(getIdleTabPreloadCompleteAt("settings")).toBeNull();
    markIdleTabPreloadComplete("settings", 2);
    expect(getIdleTabPreloadCompleteAt("settings")).toBe(2);
  });

  it("notifies waiters when a new epoch starts", () => {
    const listener = vi.fn();
    const unsub = subscribeIdleTabPreloadComplete("settings", listener);
    beginIdleTabPreloadEpoch("settings");
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("does not stamp settings when messages, notifications, profile, music, people, or communities is marked", () => {
    markIdleTabPreloadComplete("messages", 4);
    markIdleTabPreloadComplete("notifications", 5);
    markIdleTabPreloadComplete("profile", 6);
    markIdleTabPreloadComplete("music", 7);
    markIdleTabPreloadComplete("people", 8);
    markIdleTabPreloadComplete("communities", 9);
    expect(getIdleTabPreloadCompleteAt("messages")).toBe(4);
    expect(getIdleTabPreloadCompleteAt("notifications")).toBe(5);
    expect(getIdleTabPreloadCompleteAt("profile")).toBe(6);
    expect(getIdleTabPreloadCompleteAt("music")).toBe(7);
    expect(getIdleTabPreloadCompleteAt("people")).toBe(8);
    expect(getIdleTabPreloadCompleteAt("communities")).toBe(9);
    expect(getIdleTabPreloadCompleteAt("settings")).toBeNull();
  });
});

describe("idle tab preload stage reset", () => {
  afterEach(() => {
    __resetIdleTabPreloadSerializer();
  });

  it("clears messages, notifications, profile, music, people, communities, and settings stages", () => {
    markIdleTabPreloadComplete("messages", 1);
    markIdleTabPreloadComplete("notifications", 2);
    markIdleTabPreloadComplete("profile", 3);
    markIdleTabPreloadComplete("music", 4);
    markIdleTabPreloadComplete("people", 5);
    markIdleTabPreloadComplete("communities", 6);
    markIdleTabPreloadComplete("settings", 7);
    expect(getIdleTabPreloadCompleteAt("messages")).toBe(1);
    expect(getIdleTabPreloadCompleteAt("notifications")).toBe(2);
    expect(getIdleTabPreloadCompleteAt("profile")).toBe(3);
    expect(getIdleTabPreloadCompleteAt("music")).toBe(4);
    expect(getIdleTabPreloadCompleteAt("people")).toBe(5);
    expect(getIdleTabPreloadCompleteAt("communities")).toBe(6);
    expect(getIdleTabPreloadCompleteAt("settings")).toBe(7);
    __resetIdleTabPreloadSerializer();
    expect(getIdleTabPreloadCompleteAt("messages")).toBeNull();
    expect(getIdleTabPreloadCompleteAt("notifications")).toBeNull();
    expect(getIdleTabPreloadCompleteAt("profile")).toBeNull();
    expect(getIdleTabPreloadCompleteAt("music")).toBeNull();
    expect(getIdleTabPreloadCompleteAt("people")).toBeNull();
    expect(getIdleTabPreloadCompleteAt("communities")).toBeNull();
    expect(getIdleTabPreloadCompleteAt("settings")).toBeNull();
  });
});

describe("abortQueuedIdleTabPrefetch", () => {
  it("drops a queued job and unlatches when the owner is not inflight", () => {
    const serializer = createIdleTabPreloadSerializer();
    serializer.enqueue(Symbol("first"), () => {});
    const second = Symbol("second");
    const job = vi.fn();
    serializer.enqueue(second, job);
    const unlatch = vi.fn();
    abortQueuedIdleTabPrefetch(serializer, second, unlatch);
    expect(job).not.toHaveBeenCalled();
    expect(unlatch).toHaveBeenCalledTimes(1);
    serializer.dispose();
  });
});
