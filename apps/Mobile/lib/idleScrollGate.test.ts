import { describe, expect, it, vi } from "vitest";
import { mapIdleSliced } from "./idleScrollGate";

function createScrollGate(initiallySettled: boolean) {
  let settled = initiallySettled;
  const listeners = new Set<(settled: boolean) => void>();
  return {
    isScrollSettled: () => settled,
    subscribeScrollSettled: (listener: (settled: boolean) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setSettled(next: boolean) {
      if (next === settled) return;
      settled = next;
      for (const listener of [...listeners]) listener(settled);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("mapIdleSliced", () => {
  it("does not start the next item until scroll settles after an in-flight step", async () => {
    const scroll = createScrollGate(true);
    const first = deferred<string>();
    const mapOne = vi.fn((item: string) => {
      if (item === "a") return first.promise;
      return Promise.resolve("b-done");
    });

    const handle = mapIdleSliced(["a", "b"], mapOne, {
      isScrollSettled: scroll.isScrollSettled,
      subscribeScrollSettled: scroll.subscribeScrollSettled,
      yieldBetweenSteps: () => Promise.resolve(),
    });

    expect(mapOne).toHaveBeenCalledTimes(1);
    scroll.setSettled(false);
    first.resolve("a-done");
    await Promise.resolve();
    await Promise.resolve();
    expect(mapOne).toHaveBeenCalledTimes(1);

    scroll.setSettled(true);
    await expect(handle.done).resolves.toEqual(["a-done", "b-done"]);
    expect(mapOne).toHaveBeenCalledTimes(2);
  });

  it("cancel stops a pending wait without mapping further items", async () => {
    const scroll = createScrollGate(false);
    const mapOne = vi.fn(() => Promise.resolve("x"));
    const handle = mapIdleSliced(["a", "b"], mapOne, {
      isScrollSettled: scroll.isScrollSettled,
      subscribeScrollSettled: scroll.subscribeScrollSettled,
      yieldBetweenSteps: () => Promise.resolve(),
    });
    await Promise.resolve();
    handle.cancel();
    await expect(handle.done).resolves.toBeNull();
    expect(mapOne).not.toHaveBeenCalled();
  });
});
