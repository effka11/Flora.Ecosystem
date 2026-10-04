import { describe, expect, it } from "vitest";
import {
  createVisibleRangePublisher,
  type VisibleIndexRange,
} from "./visibleRangePublisher";

function harness(windowMs = 100) {
  let now = 0;
  const timers: { run: () => void; cancelled: boolean; dueAt: number }[] = [];
  const published: VisibleIndexRange[] = [];
  const publisher = createVisibleRangePublisher({
    windowMs,
    publish: (range) => published.push(range),
    schedule: (run, delayMs) => {
      const timer = { run, cancelled: false, dueAt: now + delayMs };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });

  return {
    publisher,
    published,
    activeTimers: () => timers.filter((t) => !t.cancelled).length,
    runNextTimer() {
      const timer = timers
        .filter((candidate) => !candidate.cancelled)
        .sort((a, b) => a.dueAt - b.dueAt)[0];
      if (!timer) throw new Error("No scheduled timer");
      timer.cancelled = true;
      now = timer.dueAt;
      timer.run();
    },
  };
}

describe("createVisibleRangePublisher", () => {
  it("publishes the leading edge immediately", () => {
    const h = harness();
    h.publisher.update({ min: 0, max: 2 });
    expect(h.published).toEqual([{ min: 0, max: 2 }]);
  });

  it("coalesces a burst inside the window into a single trailing publish", () => {
    const h = harness();
    h.publisher.update({ min: 0, max: 2 }); // leading edge, publishes now
    h.publisher.update({ min: 1, max: 3 });
    h.publisher.update({ min: 2, max: 4 });
    h.publisher.update({ min: 3, max: 5 });
    expect(h.published).toEqual([{ min: 0, max: 2 }]);

    h.runNextTimer(); // window elapses: trailing publish
    expect(h.published).toEqual([
      { min: 0, max: 2 },
      { min: 3, max: 5 },
    ]);
  });

  it("does not lose the latest value even under a continuous stream", () => {
    const h = harness();
    for (let i = 0; i < 50; i += 1) {
      h.publisher.update({ min: i, max: i });
    }
    expect(h.published).toEqual([{ min: 0, max: 0 }]);
    h.runNextTimer();
    // The trailing publish carries the very last value seen, not an
    // intermediate one.
    expect(h.published).toEqual([
      { min: 0, max: 0 },
      { min: 49, max: 49 },
    ]);
  });

  it("publishes no more often than the window under a steady stream", () => {
    const h = harness(100);
    // Simulate viewability firing on every frame (~16ms) for half a second.
    let elapsedSinceLastTimer = 0;
    for (let frame = 0; frame < 30; frame += 1) {
      h.publisher.update({ min: frame, max: frame });
      elapsedSinceLastTimer += 16;
      if (elapsedSinceLastTimer >= 100) {
        h.runNextTimer();
        elapsedSinceLastTimer = 0;
      }
    }
    // ~500ms of frames at a 100ms window bounds publishes to roughly one
    // per window, never one per frame.
    expect(h.published.length).toBeLessThanOrEqual(6);
    expect(h.published.length).toBeGreaterThanOrEqual(4);
  });

  it("flush publishes immediately and resets the window, even mid-burst", () => {
    const h = harness();
    h.publisher.update({ min: 0, max: 0 }); // opens a window
    h.publisher.update({ min: 1, max: 1 }); // buffered as pending

    h.publisher.flush({ min: 9, max: 9 });
    expect(h.published).toEqual([{ min: 0, max: 0 }, { min: 9, max: 9 }]);
    expect(h.activeTimers()).toBe(0);

    // The buffered pending value from before the flush must not fire later.
    const nextUpdate = () => h.publisher.update({ min: 10, max: 10 });
    nextUpdate();
    expect(h.published).toEqual([
      { min: 0, max: 0 },
      { min: 9, max: 9 },
      { min: 10, max: 10 },
    ]);
  });

  it("flush works even when idle (no open window)", () => {
    const h = harness();
    h.publisher.flush({ min: 5, max: 5 });
    expect(h.published).toEqual([{ min: 5, max: 5 }]);
    expect(h.activeTimers()).toBe(0);
  });

  it("dispose cancels the pending timer without firing it", () => {
    const h = harness();
    h.publisher.update({ min: 0, max: 0 });
    h.publisher.update({ min: 1, max: 1 }); // pending, awaiting the window

    h.publisher.dispose();
    expect(h.activeTimers()).toBe(0);
    expect(h.published).toEqual([{ min: 0, max: 0 }]);
  });

  it("opens a fresh window after an idle gap (leading edge again)", () => {
    const h = harness();
    h.publisher.update({ min: 0, max: 0 });
    h.runNextTimer(); // window elapses with nothing pending; timer not renewed
    expect(h.activeTimers()).toBe(0);

    h.publisher.update({ min: 1, max: 1 });
    // A fresh leading edge: published immediately, not delayed.
    expect(h.published).toEqual([
      { min: 0, max: 0 },
      { min: 1, max: 1 },
    ]);
  });
});
