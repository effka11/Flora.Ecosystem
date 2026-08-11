import assert from "node:assert/strict";
import test from "node:test";

import {
  BELOW_TIME_RESERVE_PX,
  CHAT_INSERT_LIFT_EASING,
  CHAT_INSERT_LIFT_MS,
  COMPOSE_LIST_GROWTH_MS,
  TEXT_BASE_INSERT_LIFT_PX,
  estimateTextInsertLiftPx,
  estimateTextVisualLineCount,
  maxTextBubbleInnerWidthFromChatInner,
  playChatListInsertLift,
  playComposeListGrowthRelease,
  resetChatListInsertLift,
} from "./chatListInsertLift";

const BUBBLE_LINE_HEIGHT_PX = 25;

type FakeEl = HTMLElement & {
  style: Record<string, string>;
  contains: (node: Node) => boolean;
  animate: (keyframes: Keyframe[], options?: KeyframeAnimationOptions) => Animation;
  querySelectorAll: (sel: string) => NodeListOf<HTMLElement>;
};

type AnimCall = {
  el: FakeEl;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions | undefined;
  /** `el.style.transform` в момент вызова `animate` (порядок sync→WAAPI). */
  transformAtAnimate: string;
};

function installMatchMedia(matches = false): () => void {
  const prev = globalThis.matchMedia;
  globalThis.matchMedia = (() => ({
    matches,
    media: "",
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof matchMedia;
  return () => {
    globalThis.matchMedia = prev;
  };
}

function makeTrackedEl(allCalls: AnimCall[], cancelCount?: { n: number }): FakeEl {
  const style: Record<string, string> = {};
  const tracked = {
    style,
    contains: () => true,
    querySelectorAll: () => [] as unknown as NodeListOf<HTMLElement>,
    animate(keyframes: Keyframe[], options?: KeyframeAnimationOptions) {
      let rejectFinished!: (reason?: unknown) => void;
      let resolveFinished!: () => void;
      const finished = new Promise<void>((resolve, reject) => {
        resolveFinished = resolve;
        rejectFinished = reject;
      });
      void finished.catch(() => {});
      allCalls.push({
        el: tracked as FakeEl,
        keyframes,
        options,
        transformAtAnimate: style.transform ?? "",
      });
      return {
        finished,
        cancel: () => {
          if (cancelCount) cancelCount.n += 1;
          rejectFinished(new DOMException("Aborted", "AbortError"));
        },
        finishForTest: resolveFinished,
      } as unknown as Animation;
    },
  } as unknown as FakeEl;
  return tracked;
}

test("playChatListInsertLift starts WAAPI on inner and hold; onLiftStarted sync; no pre-paint transform", () => {
  const restoreMm = installMatchMedia(false);
  const allCalls: AnimCall[] = [];
  const innerEl = makeTrackedEl(allCalls);
  const holdEl = makeTrackedEl(allCalls);
  let startedCalls = 0;

  try {
    playChatListInsertLift(innerEl, 80, {
      holdViewportEls: [holdEl],
      onLiftStarted: () => {
        startedCalls += 1;
      },
    });

    assert.equal(innerEl.style.transform ?? "", "");
    assert.equal(holdEl.style.transform ?? "", "");
    assert.equal(startedCalls, 1);
    assert.equal(allCalls.length, 2);

    const innerAnim = allCalls.find((c) => c.el === innerEl);
    const holdAnim = allCalls.find((c) => c.el === holdEl);
    assert.ok(innerAnim);
    assert.ok(holdAnim);
    assert.deepEqual(innerAnim!.keyframes, [
      { transform: "translateY(80px)" },
      { transform: "translateY(0px)" },
    ]);
    assert.deepEqual(holdAnim!.keyframes, [
      { transform: "translateY(-80px)" },
      { transform: "translateY(0px)" },
    ]);
    assert.equal(innerAnim!.options?.duration, CHAT_INSERT_LIFT_MS);
    assert.equal(innerAnim!.options?.easing, CHAT_INSERT_LIFT_EASING);
    assert.equal(innerAnim!.options?.fill, "forwards");
  } finally {
    restoreMm();
  }
});

test("playChatListInsertLift reduced motion still fires onLiftStarted", () => {
  const restoreMm = installMatchMedia(true);
  const allCalls: AnimCall[] = [];
  const innerEl = makeTrackedEl(allCalls);
  let startedCalls = 0;

  try {
    playChatListInsertLift(innerEl, 60, {
      onLiftStarted: () => {
        startedCalls += 1;
      },
    });
    assert.equal(startedCalls, 1);
    assert.equal(allCalls.length, 0);
  } finally {
    restoreMm();
  }
});

test("playChatListInsertLift zero height still fires onLiftStarted", () => {
  const restoreMm = installMatchMedia(false);
  const allCalls: AnimCall[] = [];
  const innerEl = makeTrackedEl(allCalls);
  let startedCalls = 0;

  try {
    playChatListInsertLift(innerEl, 0, {
      onLiftStarted: () => {
        startedCalls += 1;
      },
    });
    assert.equal(startedCalls, 1);
    assert.equal(allCalls.length, 0);
  } finally {
    restoreMm();
  }
});

test("resetChatListInsertLift cancels in-flight WAAPI", () => {
  const restoreMm = installMatchMedia(false);
  const allCalls: AnimCall[] = [];
  const cancelCount = { n: 0 };
  const inner = makeTrackedEl(allCalls, cancelCount);

  try {
    playChatListInsertLift(inner, 60);
    assert.equal(cancelCount.n, 0);
    assert.equal(allCalls.length, 1);
    resetChatListInsertLift(inner);
    assert.equal(cancelCount.n, 1);
    assert.equal(inner.style.transform, "");
  } finally {
    restoreMm();
  }
});

test("playComposeListGrowthRelease syncs -collapse then WAAPI -collapse→0", () => {
  const restoreMm = installMatchMedia(false);
  const allCalls: AnimCall[] = [];
  const host = makeTrackedEl(allCalls);

  try {
    playComposeListGrowthRelease(host, 50);
    assert.equal(allCalls.length, 1);
    assert.equal(allCalls[0]!.transformAtAnimate, "translateY(-50px)");
    assert.equal(host.style.transform, "translateY(-50px)");
    assert.deepEqual(allCalls[0]!.keyframes, [
      { transform: "translateY(-50px)" },
      { transform: "translateY(0px)" },
    ]);
    assert.equal(allCalls[0]!.options?.duration, COMPOSE_LIST_GROWTH_MS);
    assert.equal(allCalls[0]!.options?.easing, CHAT_INSERT_LIFT_EASING);
  } finally {
    restoreMm();
  }
});

test("playComposeListGrowthRelease reduced motion is no-op", () => {
  const restoreMm = installMatchMedia(true);
  const allCalls: AnimCall[] = [];
  const host = makeTrackedEl(allCalls);

  try {
    playComposeListGrowthRelease(host, 40);
    assert.equal(allCalls.length, 0);
  } finally {
    restoreMm();
  }
});

test("resetChatListInsertLift cancels growth host WAAPI", () => {
  const restoreMm = installMatchMedia(false);
  const allCalls: AnimCall[] = [];
  const cancelCount = { n: 0 };
  const host = makeTrackedEl(allCalls, cancelCount);
  const inner = makeTrackedEl(allCalls, cancelCount);

  try {
    playComposeListGrowthRelease(host, 40);
    assert.equal(cancelCount.n, 0);
    resetChatListInsertLift(inner, host);
    assert.equal(cancelCount.n, 1);
    assert.equal(host.style.transform, "");
  } finally {
    restoreMm();
  }
});

test("estimateTextVisualLineCount counts hard-breaks without width", () => {
  assert.equal(estimateTextVisualLineCount("a\nb\nc"), 3);
});

test("estimateTextVisualLineCount soft-wraps a long line when maxInnerWidth is narrow", () => {
  const long = "x".repeat(40);
  assert.ok(estimateTextVisualLineCount(long, 40) > 1);
});

test("estimateTextInsertLiftPx short single-line is base", () => {
  assert.equal(estimateTextInsertLiftPx("hi"), TEXT_BASE_INSERT_LIFT_PX);
});

test("estimateTextInsertLiftPx three hard-lines adds steps and below-reserve", () => {
  const expected =
    TEXT_BASE_INSERT_LIFT_PX + 2 * BUBBLE_LINE_HEIGHT_PX + BELOW_TIME_RESERVE_PX;
  assert.equal(estimateTextInsertLiftPx("a\nb\nc"), expected);
});

test("maxTextBubbleInnerWidthFromChatInner clamps width", () => {
  assert.equal(
    maxTextBubbleInnerWidthFromChatInner({ clientWidth: 200 } as HTMLElement),
    Math.floor(200 * 0.78) - 30,
  );
  assert.equal(
    maxTextBubbleInnerWidthFromChatInner({ clientWidth: 0 } as HTMLElement),
    0,
  );
});
