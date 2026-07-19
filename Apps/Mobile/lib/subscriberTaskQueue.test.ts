import { describe, expect, it, vi } from "vitest";
import { SubscriberTaskQueue } from "./subscriberTaskQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("SubscriberTaskQueue", () => {
  it("deduplicates subscribers and resolves both from one worker call", async () => {
    const work = deferred<string>();
    const worker = vi.fn(() => work.promise);
    const queue = new SubscriberTaskQueue(worker);
    const first = queue.request("image");
    const second = queue.request("image");

    expect(worker).toHaveBeenCalledTimes(1);
    work.resolve("png");

    await expect(first).resolves.toBe("png");
    await expect(second).resolves.toBe("png");
  });

  it("drops a queued task when its last subscriber leaves", async () => {
    const active = deferred<string>();
    const worker = vi.fn((key: string) => key === "active" ? active.promise : Promise.resolve(key));
    const queue = new SubscriberTaskQueue(worker);
    queue.request("active").catch(() => {});
    const cancel = queue.subscribe("recycled", () => {});

    cancel();
    active.resolve("done");
    await flushPromises();

    expect(worker).toHaveBeenCalledTimes(1);
    expect(worker).not.toHaveBeenCalledWith("recycled");
  });

  it("does not let a recycled key jump ahead when it subscribes again", async () => {
    const active = deferred<string>();
    const calls: string[] = [];
    const worker = vi.fn(async (key: string) => {
      calls.push(key);
      if (key === "active") return active.promise;
      return key;
    });
    const queue = new SubscriberTaskQueue(worker);
    queue.request("active").catch(() => {});
    const cancel = queue.subscribe("recycled", () => {});
    cancel();
    const middle = queue.request("middle");
    const recycled = queue.request("recycled");

    active.resolve("done");
    await expect(middle).resolves.toBe("middle");
    await expect(recycled).resolves.toBe("recycled");
    expect(calls).toEqual(["active", "middle", "recycled"]);
  });

  it("uses ref-counted pause reasons and resumes in FIFO order", async () => {
    const calls: string[] = [];
    const queue = new SubscriberTaskQueue(async (key: string) => {
      calls.push(key);
      return key;
    });
    const pane = Symbol("pane");
    const drawer = Symbol("drawer");

    queue.setPaused(pane, "momentum", true);
    queue.setPaused(drawer, "drawer", true);
    const first = queue.request("first");
    const second = queue.request("second");
    expect(calls).toEqual([]);

    queue.setPaused(pane, "momentum", false);
    expect(calls).toEqual([]);

    queue.clearPauseOwner(drawer);
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(calls).toEqual(["first", "second"]);
  });

  it("treats repeated begin for one owner and reason as idempotent", async () => {
    const queue = new SubscriberTaskQueue(async (key: string) => key);
    const owner = Symbol("scroll");

    queue.setPaused(owner, "drag", true);
    queue.setPaused(owner, "drag", true);
    const result = queue.request("image");
    queue.setPaused(owner, "drag", false);

    await expect(result).resolves.toBe("image");
    expect(queue.stats().paused).toBe(false);
  });
});
