import { describe, expect, it } from "vitest";
import {
  canIssueChatPushPlay,
  canScrollChatList,
  CHAT_PUSH_OFF_EDGE,
  chatPushBackAction,
  chatPushEnterKickoff,
  chatPushHostIgnoresHits,
  chatPushOffEdgeNotifies,
  chatPushShellShouldPop,
  chatPushIsOffEdge,
  chatPushPressBlockedByPlay,
  chatPushRepeatBackKeepsIntercept,
  chatPushSlideStartOnCarpet,
  chatPushSlideStartOnRelease,
  chatPushTabBarOffEdgeCommit,
  chatBenchHostRaised,
  chatBenchPromoteKeepsReveal,
  chatBenchSlotTranslateX,
  chatWarmMountedIds,
  chatListHiddenUntilReveal,
  chatThreadListRevealInput,
  layoutChatBenchSlots,
  nextChatListMounted,
  selectChatWarmMeasureIds,
  shouldRevealMeasuredWindow,
  warmLayoutEffectMayReveal,
  warmLayoutRevealAction,
} from "@/lib/chatListEnterMount";

describe("warm layout effect", () => {
  it("does not reveal before measured heights close the window", () => {
    expect(
      warmLayoutRevealAction({ gateOn: false, listMounted: true, diagnosisWarm: true }),
    ).toBe("gate-off");
    expect(
      warmLayoutRevealAction({ gateOn: true, listMounted: false, diagnosisWarm: true }),
    ).toBe("wait-mount");
    expect(
      warmLayoutRevealAction({ gateOn: true, listMounted: true, diagnosisWarm: true }),
    ).toBe("hold");
    expect(
      warmLayoutRevealAction({ gateOn: true, listMounted: true, diagnosisWarm: false }),
    ).toBe("hold");

    expect(
      warmLayoutEffectMayReveal({
        gateOn: true,
        listMounted: true,
        diagnosisWarm: true,
        parked: false,
        windowClosedByHeights: true,
      }),
    ).toBe(false);
    expect(
      warmLayoutEffectMayReveal({
        gateOn: true,
        listMounted: false,
        diagnosisWarm: true,
        parked: true,
        windowClosedByHeights: true,
      }),
    ).toBe(false);
    expect(
      warmLayoutEffectMayReveal({
        gateOn: true,
        listMounted: true,
        diagnosisWarm: true,
        parked: true,
        windowClosedByHeights: false,
      }),
    ).toBe(false);
    expect(
      warmLayoutEffectMayReveal({
        gateOn: false,
        listMounted: true,
        diagnosisWarm: true,
        parked: true,
        windowClosedByHeights: true,
      }),
    ).toBe(false);
    expect(
      warmLayoutEffectMayReveal({
        gateOn: true,
        listMounted: true,
        diagnosisWarm: false,
        parked: true,
        windowClosedByHeights: true,
      }),
    ).toBe(true);
    expect(
      warmLayoutEffectMayReveal({
        gateOn: true,
        listMounted: true,
        diagnosisWarm: true,
        parked: true,
        windowClosedByHeights: true,
      }),
    ).toBe(true);

    expect(
      shouldRevealMeasuredWindow({
        windowClosedByHeights: false,
        threadReady: true,
        textMeasuresWarm: true,
      }),
    ).toBe(false);
    expect(
      shouldRevealMeasuredWindow({
        windowClosedByHeights: true,
        threadReady: false,
        textMeasuresWarm: true,
      }),
    ).toBe(false);
    expect(
      shouldRevealMeasuredWindow({
        windowClosedByHeights: true,
        threadReady: true,
        textMeasuresWarm: false,
      }),
    ).toBe(false);
    expect(
      shouldRevealMeasuredWindow({
        windowClosedByHeights: true,
        threadReady: true,
        textMeasuresWarm: true,
      }),
    ).toBe(true);
  });
});

describe("chat list mount", () => {
  const base = {
    parked: false,
    sliding: false,
    enterArmed: false,
    enterProgress: 0,
    mounted: false,
  };

  it("mounts in parking and stays mounted once the list is in the tree", () => {
    expect(nextChatListMounted({ ...base, parked: true })).toBe(true);
    expect(nextChatListMounted({ ...base, parked: true, mounted: true })).toBe(true);
    // Слайд уже едет, ленты ещё нет — коммит не начинать.
    expect(nextChatListMounted({ ...base, sliding: true, enterProgress: 0.4 })).toBe(false);
    expect(
      nextChatListMounted({ ...base, sliding: true, enterProgress: 0.4, mounted: true }),
    ).toBe(true);
    // Выход: progress падает, уже смонтированная лента остаётся.
    expect(nextChatListMounted({ ...base, enterProgress: 0.2, mounted: true })).toBe(true);
    expect(nextChatListMounted({ ...base, enterArmed: true, enterProgress: 0 })).toBe(false);
    expect(nextChatListMounted({ ...base, enterArmed: true, enterProgress: 0, mounted: true })).toBe(
      true,
    );
    expect(nextChatListMounted({ ...base, enterProgress: 1 })).toBe(true);
    expect(nextChatListMounted(base)).toBe(false);
  });

  it("keeps an off-screen bench list opaque so cells and avatars can paint", () => {
    const hidden = {
      listRevealed: false,
      overlayHost: true,
      preparingWindow: false,
      sliding: false,
    };
    expect(chatListHiddenUntilReveal({ ...hidden, preparingWindow: true })).toBe(false);
    expect(chatListHiddenUntilReveal({ ...hidden, sliding: true })).toBe(false);
    expect(chatListHiddenUntilReveal(hidden)).toBe(true);
    expect(
      chatListHiddenUntilReveal({
        listRevealed: false,
        overlayHost: false,
        preparingWindow: false,
        sliding: false,
      }),
    ).toBe(true);
    expect(
      chatListHiddenUntilReveal({ ...hidden, listRevealed: true, preparingWindow: false }),
    ).toBe(false);
  });

  it("feeds the screen JSX arguments so a resting bench list is not hidden", () => {
    const bench = chatThreadListRevealInput({
      listRevealed: false,
      overlayHost: true,
      bench: true,
      holding: false,
      sliding: false,
    });
    expect(bench.preparingWindow).toBe(true);
    expect(bench.sliding).toBe(false);
    expect(chatListHiddenUntilReveal(bench)).toBe(false);

    const finger = chatThreadListRevealInput({
      listRevealed: false,
      overlayHost: true,
      bench: false,
      holding: true,
      sliding: false,
    });
    expect(finger.preparingWindow).toBe(true);
    expect(chatListHiddenUntilReveal(finger)).toBe(false);

    const route = chatThreadListRevealInput({
      listRevealed: false,
      overlayHost: false,
      bench: false,
      holding: false,
      sliding: false,
    });
    expect(route.preparingWindow).toBe(false);
    expect(chatListHiddenUntilReveal(route)).toBe(true);
  });
});

describe("chat push slide start", () => {
  it("starts enter on release when the carpet is already down, without a route or focus frames", () => {
    expect(
      chatPushSlideStartOnRelease({ scrollCancelled: false, carpetDown: true }),
    ).toEqual({ runEnter: true, waitFrames: 0, pushRoute: false });
  });

  it("does not start enter on release while the window is still open", () => {
    expect(
      chatPushSlideStartOnRelease({ scrollCancelled: false, carpetDown: false }),
    ).toEqual({ runEnter: false, waitFrames: 0, pushRoute: false });
  });

  it("schedules the next frame when the carpet drops after release, not the same call", () => {
    expect(chatPushSlideStartOnCarpet({ playRequested: true })).toEqual({
      runEnter: true,
      waitFrames: 1,
      pushRoute: false,
    });
    expect(chatPushSlideStartOnCarpet({ playRequested: false })).toEqual({
      runEnter: false,
      waitFrames: 0,
      pushRoute: false,
    });
  });

  it("does not start enter when scroll cancels before release", () => {
    expect(chatPushSlideStartOnRelease({ scrollCancelled: true, carpetDown: true })).toEqual({
      runEnter: false,
      waitFrames: 0,
      pushRoute: false,
    });
    expect(chatPushSlideStartOnRelease({ scrollCancelled: true, carpetDown: false }).runEnter).toBe(
      false,
    );
  });

  it("starts enter on the first release and publishes before timing, not at complete", () => {
    expect(
      chatPushEnterKickoff({ scrollCancelled: false, carpetDown: true }),
    ).toEqual({
      runEnter: true,
      publishBeforeTiming: true,
      timingNextFrame: true,
      deferPublishToComplete: false,
    });
  });

  it("does not start enter on release while the warm window is still open", () => {
    expect(chatPushEnterKickoff({ scrollCancelled: false, carpetDown: false }).runEnter).toBe(
      false,
    );
    expect(
      chatPushEnterKickoff({ scrollCancelled: false, carpetDown: false }).publishBeforeTiming,
    ).toBe(false);
  });
});

describe("chat push off-edge subscribers", () => {
  it("does not wake subscribers when the 0.01 edge clears during enter timing", () => {
    expect(
      chatPushOffEdgeNotifies({ prevOff: true, nextOff: false, enterTiming: true }),
    ).toBe(false);
  });

  it("wakes subscribers when the exit flag returns list hits", () => {
    expect(
      chatPushOffEdgeNotifies({ prevOff: false, nextOff: true, enterTiming: false }),
    ).toBe(true);
    expect(
      chatPushOffEdgeNotifies({ prevOff: false, nextOff: true, enterTiming: true }),
    ).toBe(true);
  });
});

describe("chat push tab bar off-edge reaction", () => {
  it("does not commit chatOffEdge when enter crosses 0.01", () => {
    expect(chatPushTabBarOffEdgeCommit(0, 0.02)).toBe(false);
    expect(chatPushTabBarOffEdgeCommit(0, 1)).toBe(false);
    expect(chatPushTabBarOffEdgeCommit(CHAT_PUSH_OFF_EDGE, 0.5)).toBe(false);
  });

  it("commits offEdge when progress falls to the edge", () => {
    expect(chatPushTabBarOffEdgeCommit(1, 0)).toBe(true);
    expect(chatPushTabBarOffEdgeCommit(0.5, CHAT_PUSH_OFF_EDGE)).toBe(true);
    expect(chatPushTabBarOffEdgeCommit(0.02, 0)).toBe(true);
  });

  it("does not commit when the edge side does not change", () => {
    expect(chatPushTabBarOffEdgeCommit(null, 0)).toBe(false);
    expect(chatPushTabBarOffEdgeCommit(0, CHAT_PUSH_OFF_EDGE)).toBe(false);
    expect(chatPushTabBarOffEdgeCommit(1, 0.4)).toBe(false);
  });
});

describe("chat push play gate", () => {
  it("does not issue play until the list is mounted and the window is closed", () => {
    expect(canIssueChatPushPlay({ listMounted: false, windowClosedByHeights: true })).toBe(false);
    expect(canIssueChatPushPlay({ listMounted: true, windowClosedByHeights: false })).toBe(false);
    expect(canIssueChatPushPlay({ listMounted: false, windowClosedByHeights: false })).toBe(false);
    expect(canIssueChatPushPlay({ listMounted: true, windowClosedByHeights: true })).toBe(true);
  });
});

describe("chat push return", () => {
  it("drops overlay hits once the chat is off the right edge", () => {
    expect(chatPushIsOffEdge(0)).toBe(true);
    expect(chatPushIsOffEdge(0.01)).toBe(true);
    expect(chatPushIsOffEdge(0.2)).toBe(false);
    expect(chatPushHostIgnoresHits({ holding: true, offEdge: false })).toBe(true);
    expect(chatPushHostIgnoresHits({ holding: false, offEdge: true })).toBe(true);
    expect(chatPushHostIgnoresHits({ holding: false, offEdge: false })).toBe(false);
  });

  it("does not swallow the next press after the exit has cleared the screen", () => {
    expect(chatPushPressBlockedByPlay({ playCommitted: true, offEdge: false })).toBe(true);
    expect(chatPushPressBlockedByPlay({ playCommitted: true, offEdge: true })).toBe(false);
    expect(chatPushPressBlockedByPlay({ playCommitted: false, offEdge: true })).toBe(false);
  });

  it("reverses a close before the shell exists and keeps a second back on the same exit", () => {
    expect(
      chatPushBackAction({
        shellPushed: false,
        shellInStack: false,
        active: true,
        offEdge: false,
        exiting: false,
      }),
    ).toBe("reverse");
    expect(
      chatPushBackAction({
        shellPushed: false,
        shellInStack: false,
        active: true,
        offEdge: true,
        exiting: false,
      }),
    ).toBe("release");
    expect(
      chatPushBackAction({
        shellPushed: false,
        shellInStack: false,
        active: true,
        offEdge: false,
        exiting: true,
      }),
    ).toBe("keep");
    expect(
      chatPushBackAction({
        shellPushed: true,
        shellInStack: false,
        active: true,
        offEdge: false,
        exiting: false,
      }),
    ).toBe("pop-route");
    expect(
      chatPushBackAction({
        shellPushed: true,
        shellInStack: true,
        active: true,
        offEdge: true,
        exiting: true,
      }),
    ).toBe("keep");
    expect(
      chatPushBackAction({
        shellPushed: false,
        shellInStack: false,
        active: false,
        offEdge: true,
        exiting: false,
      }),
    ).toBe("pop-route");
    expect(chatPushRepeatBackKeepsIntercept(true)).toBe(true);
    expect(chatPushRepeatBackKeepsIntercept(false)).toBe(false);
  });

  it("pops a shell that is still in the stack after shellPushed was cleared", () => {
    expect(
      chatPushBackAction({
        shellPushed: false,
        shellInStack: true,
        active: true,
        offEdge: true,
        exiting: false,
      }),
    ).toBe("pop-route");
    expect(
      chatPushBackAction({
        shellPushed: false,
        shellInStack: false,
        active: true,
        offEdge: true,
        exiting: false,
      }),
    ).toBe("release");
  });
});

describe("chat push shell pop", () => {
  it("does not pop when progress is 0 in the parked phase", () => {
    expect(
      chatPushShellShouldPop({
        exitStarted: false,
        phase: "parked",
        progress: 0,
        crossedDown: true,
        shellFocused: true,
        shellInStack: true,
      }),
    ).toBe(false);
    expect(
      chatPushShellShouldPop({
        exitStarted: true,
        phase: "parked",
        progress: 0,
        crossedDown: true,
        shellFocused: true,
        shellInStack: true,
      }),
    ).toBe(false);
    expect(
      chatPushShellShouldPop({
        exitStarted: true,
        phase: "play-wait",
        progress: 0,
        crossedDown: true,
        shellFocused: true,
        shellInStack: true,
      }),
    ).toBe(false);
  });

  it("pops once when an exit has started, the frame is off the edge, and the shell is still in the stack", () => {
    const exitAtEdge = {
      exitStarted: true,
      phase: "playing" as const,
      progress: 0,
      crossedDown: true,
      shellFocused: true,
      shellInStack: true,
    };
    expect(chatPushShellShouldPop(exitAtEdge)).toBe(true);
    expect(chatPushShellShouldPop({ ...exitAtEdge, shellInStack: false })).toBe(false);
    expect(chatPushShellShouldPop({ ...exitAtEdge, shellFocused: false })).toBe(false);
    expect(chatPushShellShouldPop({ ...exitAtEdge, exitStarted: false })).toBe(false);
    expect(
      chatPushShellShouldPop({
        exitStarted: false,
        phase: "idle",
        progress: 0,
        crossedDown: true,
        shellFocused: true,
        shellInStack: true,
      }),
    ).toBe(false);
  });
});

describe("chat warm windows", () => {
  it("fills free slots with cached chats before a cold one at the head of the list", () => {
    expect(
      selectChatWarmMeasureIds({
        order: ["cold", "hot-a", "hot-b", "hot-c"],
        cachedIds: ["hot-a", "hot-b", "hot-c"],
        closedIds: [],
        yieldedIds: [],
        inFlightIds: [],
        slideBusy: false,
        assemblyEnabled: true,
        parkedMeasuringId: null,
        limit: 3,
      }),
    ).toEqual(["hot-a", "hot-b", "hot-c"]);
  });

  it("does not start another window while the slide is on screen", () => {
    expect(
      selectChatWarmMeasureIds({
        order: ["a", "b"],
        cachedIds: ["a", "b"],
        closedIds: [],
        yieldedIds: [],
        inFlightIds: ["a"],
        slideBusy: true,
        assemblyEnabled: true,
        parkedMeasuringId: null,
      }),
    ).toEqual(["a"]);
  });

  it("keeps a finger-parked chat even when assembly is paused", () => {
    expect(
      selectChatWarmMeasureIds({
        order: ["a", "b"],
        cachedIds: [],
        closedIds: ["a"],
        yieldedIds: [],
        inFlightIds: [],
        slideBusy: false,
        assemblyEnabled: false,
        parkedMeasuringId: "b",
      }),
    ).toEqual(["b"]);
  });

  it("does not let a cold in-flight chat take a slot from a cached one still waiting", () => {
    expect(
      selectChatWarmMeasureIds({
        order: ["cold", "hot-a", "hot-b", "hot-c"],
        cachedIds: ["hot-a", "hot-b", "hot-c"],
        closedIds: [],
        yieldedIds: [],
        inFlightIds: ["cold"],
        slideBusy: false,
        assemblyEnabled: true,
        parkedMeasuringId: null,
        limit: 3,
      }),
    ).toEqual(["hot-a", "hot-b", "hot-c"]);
  });

  it("does not start a cold chat until uncached fill is allowed", () => {
    expect(
      selectChatWarmMeasureIds({
        order: ["a", "b"],
        cachedIds: [],
        closedIds: [],
        yieldedIds: [],
        inFlightIds: [],
        slideBusy: false,
        assemblyEnabled: true,
        parkedMeasuringId: null,
        allowUncached: false,
      }),
    ).toEqual([]);
    expect(
      selectChatWarmMeasureIds({
        order: ["a", "b"],
        cachedIds: [],
        closedIds: [],
        yieldedIds: [],
        inFlightIds: ["a"],
        slideBusy: false,
        assemblyEnabled: true,
        parkedMeasuringId: null,
        allowUncached: false,
        limit: 3,
      }),
    ).toEqual(["a"]);
  });

  it("does not start a cold chat while a decrypted window is still open", () => {
    const yieldedHot = {
      order: ["hot", "cold"],
      cachedIds: ["hot"],
      closedIds: [],
      yieldedIds: ["hot"],
      inFlightIds: [],
      slideBusy: false,
      assemblyEnabled: true,
      parkedMeasuringId: null,
      allowUncached: true,
    };
    expect(selectChatWarmMeasureIds(yieldedHot)).toEqual([]);
    // Повтор yielded-окна тоже не открывает дорогу холодному.
    expect(selectChatWarmMeasureIds({ ...yieldedHot, retryIds: ["hot"] })).toEqual(["hot"]);
  });

  it("does not mount a page that is still decrypting when cold fill is on", () => {
    expect(
      selectChatWarmMeasureIds({
        order: ["pending", "cold"],
        cachedIds: [],
        closedIds: [],
        yieldedIds: [],
        inFlightIds: [],
        slideBusy: false,
        assemblyEnabled: true,
        parkedMeasuringId: null,
        allowUncached: true,
        heldIds: ["pending"],
      }),
    ).toEqual(["cold"]);
    expect(
      selectChatWarmMeasureIds({
        order: ["pending"],
        cachedIds: [],
        closedIds: [],
        yieldedIds: [],
        inFlightIds: [],
        slideBusy: false,
        assemblyEnabled: true,
        parkedMeasuringId: "pending",
        allowUncached: true,
        heldIds: ["pending"],
      }),
    ).toEqual(["pending"]);
  });

  it("does not put a yielded chat back into a free slot", () => {
    expect(
      selectChatWarmMeasureIds({
        order: ["a", "b"],
        cachedIds: [],
        closedIds: [],
        yieldedIds: ["a"],
        inFlightIds: [],
        slideBusy: false,
        assemblyEnabled: true,
        parkedMeasuringId: null,
        limit: 1,
      }),
    ).toEqual(["b"]);
  });

  it("gives a yielded chat with a warm tail a slot again once the queue is free", () => {
    const base = {
      order: ["retry", "hot", "cold"],
      cachedIds: ["retry", "hot"],
      closedIds: [],
      yieldedIds: ["retry"],
      inFlightIds: [],
      slideBusy: false,
      assemblyEnabled: true,
      parkedMeasuringId: null,
      allowUncached: true,
      retryIds: ["retry"],
    };
    // Тот, кто ещё не пробовал, идёт первым; повтор — только в оставшийся слот.
    expect(selectChatWarmMeasureIds({ ...base, limit: 1 })).toEqual(["hot"]);
    expect(selectChatWarmMeasureIds({ ...base, limit: 2 })).toEqual(["hot", "retry"]);
    // Закрытые соседи: очередь свободна — слот снова у yielded-чата.
    expect(
      selectChatWarmMeasureIds({ ...base, closedIds: ["hot"], limit: 3 }),
    ).toEqual(["retry"]);
    // Дедлайн исчерпан (нет в retryIds) — чат больше не трогаем.
    expect(
      selectChatWarmMeasureIds({ ...base, closedIds: ["hot"], retryIds: [], limit: 3 }),
    ).toEqual([]);
    // Холодный yielded ждёт свою страницу, даже если повтор разрешён:
    // слот уходит холодному соседу, не ему.
    expect(
      selectChatWarmMeasureIds({
        ...base,
        cachedIds: ["hot"],
        closedIds: ["hot"],
        limit: 3,
      }),
    ).toEqual(["cold"]);
    // Палец без разрешённой сборки берёт свой слот и тёплых соседей, но
    // повторов не раздаёт.
    expect(
      selectChatWarmMeasureIds({
        ...base,
        assemblyEnabled: false,
        parkedMeasuringId: "cold",
        limit: 3,
      }),
    ).toEqual(["cold", "hot"]);
    // Слайд на экране: только уже начатые, повторов нет.
    expect(selectChatWarmMeasureIds({ ...base, slideBusy: true, limit: 3 })).toEqual([]);
  });

  it("keeps a closed window mounted and includes the chat being opened", () => {
    expect(
      chatWarmMountedIds({
        order: ["a", "b", "c"],
        startedIds: ["a"],
        measuringId: "b",
        activeId: "c",
      }),
    ).toEqual(["a", "b", "c"]);
    expect(
      chatWarmMountedIds({
        order: ["a"],
        startedIds: ["a"],
        measuringId: null,
        activeId: null,
      }),
    ).toEqual(["a"]);
  });
});

describe("chat bench slot frame", () => {
  const width = 400;

  it("keeps a single measuring slot in the window and uncovered", () => {
    const frames = layoutChatBenchSlots({
      slots: [
        { id: "a", closed: false },
        { id: "b", closed: false },
      ],
      activeId: null,
      hostRaised: false,
    });
    const measuring = frames.filter((frame) => frame.layer === "measure");
    expect(measuring).toHaveLength(1);
    expect(measuring[0]?.id).toBe("a");
    expect(measuring[0]?.occluded).toBe(false);
    expect(frames[frames.length - 1]?.id).toBe("a");
    expect(
      chatBenchSlotTranslateX({
        measureFrame: true,
        slideOwned: false,
        slideDriven: false,
        slideProgress: 0,
        screenWidth: width,
      }),
    ).toBeNull();
    expect(frames.every((frame) => frame.remount === false)).toBe(true);
  });

  it("parks a closed slot at screenWidth on the same list instance", () => {
    const frames = layoutChatBenchSlots({
      slots: [
        { id: "a", closed: true },
        { id: "b", closed: false },
      ],
      activeId: null,
      hostRaised: false,
    });
    const closed = frames.find((frame) => frame.id === "a");
    expect(closed?.layer).toBe("parked");
    expect(closed?.remount).toBe(false);
    expect(
      chatBenchSlotTranslateX({
        measureFrame: false,
        slideOwned: false,
        slideDriven: false,
        slideProgress: 0,
        screenWidth: width,
      }),
    ).toBe(width);
    expect(frames.find((frame) => frame.id === "b")?.layer).toBe("measure");
  });

  it("lets the next slot into the measure frame only after the current one is closed", () => {
    const open = layoutChatBenchSlots({
      slots: [
        { id: "a", closed: false },
        { id: "b", closed: false },
      ],
      activeId: null,
      hostRaised: false,
    });
    expect(open.find((frame) => frame.layer === "measure")?.id).toBe("a");
    expect(open.find((frame) => frame.id === "b")?.layer).toBe("parked");
    const next = layoutChatBenchSlots({
      slots: [
        { id: "a", closed: true },
        { id: "b", closed: false },
      ],
      activeId: null,
      hostRaised: false,
    });
    expect(next.find((frame) => frame.layer === "measure")?.id).toBe("b");
    expect(next.find((frame) => frame.id === "b")?.occluded).toBe(false);
  });

  it("holds the active slot at screenWidth until runEnter", () => {
    const frames = layoutChatBenchSlots({
      slots: [
        { id: "closed", closed: true },
        { id: "open", closed: false },
      ],
      activeId: "closed",
      hostRaised: true,
    });
    expect(frames.some((frame) => frame.layer === "measure")).toBe(false);
    expect(frames[frames.length - 1]?.id).toBe("closed");
    expect(frames[frames.length - 1]?.layer).toBe("active");
    expect(
      chatBenchSlotTranslateX({
        measureFrame: false,
        slideOwned: true,
        slideDriven: true,
        slideProgress: 0,
        screenWidth: width,
      }),
    ).toBe(width);
    expect(
      chatBenchHostRaised({
        holding: true,
        offEdge: true,
        exiting: false,
        enterPaint: false,
      }),
    ).toBe(true);
    expect(
      chatBenchHostRaised({
        holding: false,
        offEdge: true,
        exiting: false,
        enterPaint: false,
      }),
    ).toBe(false);
    expect(
      chatBenchHostRaised({
        holding: false,
        offEdge: true,
        exiting: true,
        enterPaint: false,
      }),
    ).toBe(true);
    expect(
      chatBenchHostRaised({
        holding: false,
        offEdge: true,
        exiting: false,
        enterPaint: true,
      }),
    ).toBe(true);
  });

  it("does not reset reveal when a closed bench slot is promoted", () => {
    expect(chatBenchPromoteKeepsReveal(true)).toBe(true);
    expect(chatBenchPromoteKeepsReveal(false)).toBe(false);
  });
});

describe("chat list scroll ref", () => {
  it("does not scroll until the animated ref is attached", () => {
    expect(canScrollChatList(null)).toBe(false);
    expect(canScrollChatList(undefined)).toBe(false);
    expect(canScrollChatList(0)).toBe(false);
    expect(canScrollChatList(12)).toBe(true);
  });
});
