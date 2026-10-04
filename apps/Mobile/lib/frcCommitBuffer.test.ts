import { describe, expect, it } from "vitest";
import { FrcCommitBuffer } from "./frcCommitBuffer";

function makeHarness(maxBatchSize = 8, maxHoldMs = 150) {
  let now = 0;
  let settled = true;
  let settledListener: ((value: boolean) => void) | null = null;
  const timers: { run: () => void; cancelled: boolean; dueAt: number }[] = [];
  const buffer = new FrcCommitBuffer({
    isSettled: () => settled,
    subscribeSettled: (listener) => {
      settledListener = listener;
      return () => {
        settledListener = null;
      };
    },
    schedule: (run, delayMs) => {
      const timer = { run, cancelled: false, dueAt: now + delayMs };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    now: () => now,
    delayMs: maxHoldMs,
    maxBatchSize,
  });

  return {
    buffer,
    emitSettled(value: boolean) {
      settled = value;
      settledListener?.(value);
    },
    runNextTimer() {
      const timer = timers
        .filter((candidate) => !candidate.cancelled)
        .sort((a, b) => a.dueAt - b.dueAt)[0];
      if (!timer) throw new Error("No scheduled timer");
      timer.cancelled = true;
      now = timer.dueAt;
      timer.run();
    },
    activeTimers() {
      return timers.filter((timer) => !timer.cancelled).length;
    },
  };
}

describe("FrcCommitBuffer", () => {
  it("commits immediately when no pause is active", () => {
    const { buffer } = makeHarness();
    const seen: string[] = [];

    buffer.enqueue(() => seen.push("ready"));

    expect(seen).toEqual(["ready"]);
    expect(buffer.stats()).toEqual({ paused: false, pending: 0 });
  });

  it("uses scroll settle as a hard gate even without a pause owner", () => {
    const { buffer, emitSettled } = makeHarness();
    const seen: string[] = [];
    emitSettled(false);

    buffer.enqueue(() => seen.push("settled"));
    expect(seen).toEqual([]);

    emitSettled(true);
    expect(seen).toEqual(["settled"]);
  });

  it("does not let vertical settle bypass an active pause", () => {
    const { buffer, emitSettled } = makeHarness();
    const owner = Symbol("scroll");
    const seen: string[] = [];
    emitSettled(false);
    buffer.setPaused(owner, "momentum", true);

    buffer.enqueue(() => seen.push("a"));
    buffer.enqueue(() => seen.push("b"));
    expect(seen).toEqual([]);
    expect(buffer.stats()).toEqual({ paused: true, pending: 2 });

    emitSettled(true);
    expect(seen).toEqual([]);
    buffer.setPaused(owner, "momentum", false);

    expect(seen).toEqual(["a", "b"]);
    expect(buffer.stats()).toEqual({ paused: false, pending: 0 });
  });

  it("keeps pager and drawer commits buffered when the coalescing timer fires", () => {
    const { buffer, runNextTimer } = makeHarness();
    const seen: string[] = [];
    const owner = Symbol("pager");
    buffer.setPaused(owner, "drag", true);
    buffer.enqueue(() => seen.push("timer"));

    expect(seen).toEqual([]);
    runNextTimer(); // 80 ms coalescing timer, below maxHoldMs

    expect(seen).toEqual([]);
    expect(buffer.stats()).toEqual({ paused: true, pending: 1 });
    buffer.setPaused(owner, "drag", false);
    expect(seen).toEqual(["timer"]);
    expect(buffer.stats()).toEqual({ paused: false, pending: 0 });
  });

  it("drains one bounded batch on final unpause and coalesces the remainder", () => {
    const { buffer, runNextTimer } = makeHarness(2);
    const owner = Symbol("drawer");
    const seen: number[] = [];
    buffer.setPaused(owner, "drawer", true);
    for (let value = 1; value <= 5; value += 1) {
      buffer.enqueue(() => seen.push(value));
    }

    buffer.clearPauseOwner(owner);
    expect(seen).toEqual([1, 2]);
    expect(buffer.stats().pending).toBe(3);

    runNextTimer();
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(buffer.stats().pending).toBe(1);
  });

  it("flushes after maxHoldMs despite a stuck pause when scroll is settled", () => {
    const { buffer, runNextTimer } = makeHarness();
    const seen: string[] = [];
    buffer.setPaused(Symbol("drawer"), "drawer", true);
    buffer.enqueue(() => seen.push("ceiling"));

    runNextTimer(); // coalescing timer
    expect(seen).toEqual([]);
    runNextTimer(); // max-hold timer

    expect(seen).toEqual(["ceiling"]);
    expect(buffer.stats()).toEqual({ paused: true, pending: 0 });
  });

  it("never lets maxHoldMs bypass an active scroll gesture", () => {
    const { buffer, emitSettled, runNextTimer, activeTimers } = makeHarness();
    const seen: string[] = [];
    emitSettled(false);
    buffer.setPaused(Symbol("scroll"), "momentum", true);
    buffer.enqueue(() => seen.push("after-settle"));

    runNextTimer(); // coalescing timer
    runNextTimer(); // max-hold timer

    expect(seen).toEqual([]);
    expect(activeTimers()).toBe(0);
    emitSettled(true);
    expect(seen).toEqual(["after-settle"]);
  });

  it("limits a max-hold flush and coalesces expired remainder in bounded batches", () => {
    const { buffer, runNextTimer, activeTimers } = makeHarness(2, 150);
    const seen: number[] = [];
    buffer.setPaused(Symbol("drawer"), "drawer", true);
    for (let value = 1; value <= 5; value += 1) {
      buffer.enqueue(() => seen.push(value));
    }

    expect(activeTimers()).toBe(2);
    runNextTimer(); // coalescing timer: pause still protects the batch
    expect(seen).toEqual([]);
    expect(activeTimers()).toBe(1);

    runNextTimer(); // max-hold timer: first bounded batch
    expect(seen).toEqual([1, 2]);
    expect(buffer.stats().pending).toBe(3);
    expect(activeTimers()).toBe(1);

    runNextTimer(); // expired remainder flows on the coalescing timer
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(buffer.stats().pending).toBe(1);
    expect(activeTimers()).toBe(1);
  });

  it("does not commit a result after its consumer unsubscribes", () => {
    const { buffer, emitSettled } = makeHarness();
    const owner = Symbol("scroll");
    const seen: string[] = [];
    emitSettled(false);
    buffer.setPaused(owner, "drag", true);

    const cancel = buffer.enqueue(() => seen.push("stale"));
    cancel();
    emitSettled(true);

    expect(seen).toEqual([]);
    expect(buffer.stats().pending).toBe(0);
  });
});
