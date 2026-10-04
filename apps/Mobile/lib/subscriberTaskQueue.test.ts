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
    const recycled = queue.subscribe("recycled", () => {});

    recycled.unsubscribe();
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
    const cancelled = queue.subscribe("recycled", () => {});
    cancelled.unsubscribe();
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

  it("runs strictly by priority, FIFO within a priority", async () => {
    const calls: string[] = [];
    const queue = new SubscriberTaskQueue(async (key: string) => {
      calls.push(key);
      return key;
    });
    const owner = Symbol("scroll");
    queue.setPaused(owner, "drag", true);

    queue.request("bg", "background");
    queue.request("v1", "visible");
    queue.request("n1", "near");
    queue.request("v2", "visible");

    queue.setPaused(owner, "drag", false);
    await flushPromises();

    expect(calls).toEqual(["v1", "v2", "n1", "bg"]);
  });

  it("promotes an existing queued task to a higher priority", async () => {
    const calls: string[] = [];
    const queue = new SubscriberTaskQueue(async (key: string) => {
      calls.push(key);
      return key;
    });
    const owner = Symbol("scroll");
    queue.setPaused(owner, "drag", true);

    queue.request("early", "background");
    queue.request("late", "background");
    // Re-subscribe "late" as visible: it should now win despite its later seq.
    queue.subscribe("late", () => {}, () => {}, "visible");

    queue.setPaused(owner, "drag", false);
    await flushPromises();

    expect(calls[0]).toBe("late");
  });

  it("preempts a running cancellable task with a higher-priority one and requeues it", async () => {
    const starts: string[] = [];
    const queue = new SubscriberTaskQueue<string>((key, ctx) => {
      starts.push(key);
      if (key === "bg") {
        return new Promise<string>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new Error("preempted")));
        });
      }
      return Promise.resolve(key);
    });

    queue.request("bg", "background").catch(() => {});
    await flushPromises();
    expect(starts).toEqual(["bg"]);

    const visible = queue.request("v", "visible");
    await expect(visible).resolves.toBe("v");
    await flushPromises();
    // bg was aborted, visible ran, bg was requeued and restarted.
    expect(starts).toEqual(["bg", "v", "bg"]);
  });

  it("never preempts a task that marked itself uncancellable", async () => {
    const starts: string[] = [];
    const decode = deferred<string>();
    const queue = new SubscriberTaskQueue<string>((key, ctx) => {
      starts.push(key);
      if (key === "decode") {
        ctx.markUncancellable();
        return decode.promise;
      }
      return Promise.resolve(key);
    });

    queue.request("decode", "background").catch(() => {});
    await flushPromises();
    expect(starts).toEqual(["decode"]);

    const visible = queue.request("v", "visible");
    await flushPromises();
    // Visible waits behind the in-flight uncancellable decode.
    expect(starts).toEqual(["decode"]);

    decode.resolve("done");
    await expect(visible).resolves.toBe("v");
    expect(starts).toEqual(["decode", "v"]);
  });

  it("aborts and requeues cancellable running work on pause", async () => {
    const starts: string[] = [];
    const queue = new SubscriberTaskQueue<string>((key, ctx) => {
      starts.push(key);
      return new Promise<string>((resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("paused")));
        if (starts.length > 1) resolve(key); // second run settles
      });
    });
    const owner = Symbol("scroll");

    queue.request("dl", "background").catch(() => {});
    await flushPromises();
    expect(starts).toEqual(["dl"]);

    queue.setPaused(owner, "momentum", true);
    await flushPromises();
    // Aborted and requeued, but nothing new starts while paused.
    expect(starts).toEqual(["dl"]);

    queue.setPaused(owner, "momentum", false);
    await flushPromises();
    expect(starts).toEqual(["dl", "dl"]);
  });

  it("lets an in-flight uncancellable task finish across a pause", async () => {
    const decode = deferred<string>();
    let aborted = false;
    const queue = new SubscriberTaskQueue<string>((_key, ctx) => {
      ctx.markUncancellable();
      ctx.signal.addEventListener("abort", () => {
        aborted = true;
      });
      return decode.promise;
    });
    const owner = Symbol("scroll");

    const result = queue.request("decode", "visible");
    await flushPromises();

    queue.setPaused(owner, "drag", true);
    await flushPromises();
    expect(aborted).toBe(false);

    decode.resolve("png");
    await expect(result).resolves.toBe("png");
  });

  it("requeues an aborted task when a subscriber arrives before the abort lands", async () => {
    const runs: ((value: string) => void)[] = [];
    const queue = new SubscriberTaskQueue<string>((_key, ctx) => {
      return new Promise<string>((resolve, reject) => {
        runs.push(resolve);
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    const seen: string[] = [];
    const failures: unknown[] = [];
    const first = queue.subscribe("image", () => {}, () => {});
    await flushPromises();
    expect(runs).toHaveLength(1);

    // React runs the cleanup of the old effect before the body of the new one,
    // so the second subscriber lands on a task that is already being aborted.
    first.unsubscribe();
    queue.subscribe(
      "image",
      (value) => seen.push(value),
      (error) => failures.push(error),
    );

    await flushPromises();
    expect(runs).toHaveLength(2);

    runs[1]("png");
    await flushPromises();
    expect(seen).toEqual(["png"]);
    expect(failures).toEqual([]);
    expect(queue.stats()).toMatchObject({ queued: 0, running: 0, subscribers: 0 });
  });

  it("ignores a late settle from a preempted run", async () => {
    const runs: { key: string; resolve: (value: string) => void }[] = [];
    // A worker that ignores its abort signal: its run outlives the preemption.
    const queue = new SubscriberTaskQueue<string>((key) => {
      return new Promise<string>((resolve) => {
        runs.push({ key, resolve });
      });
    });

    const background: string[] = [];
    const backgroundErrors: unknown[] = [];
    queue.subscribe(
      "bg",
      (value) => background.push(value),
      (error) => backgroundErrors.push(error),
      "background",
    );
    expect(runs.map((run) => run.key)).toEqual(["bg"]);

    // Preemption abandons the bg run and takes its slot immediately.
    const visible = queue.request("v", "visible");
    expect(runs.map((run) => run.key)).toEqual(["bg", "v"]);

    runs[0].resolve("stale");
    await flushPromises();
    expect(background).toEqual([]);
    expect(backgroundErrors).toEqual([]);

    runs[1].resolve("v-done");
    await expect(visible).resolves.toBe("v-done");
    await flushPromises();

    // bg kept its subscriber and was restarted rather than settled by the stale run.
    expect(runs.map((run) => run.key)).toEqual(["bg", "v", "bg"]);
    runs[2].resolve("bg-done");
    await flushPromises();
    expect(background).toEqual(["bg-done"]);
  });

  it("raises priority through setPriority without dropping the subscription", async () => {
    const calls: string[] = [];
    const queue = new SubscriberTaskQueue(async (key: string) => {
      calls.push(key);
      return key;
    });
    const owner = Symbol("scroll");
    queue.setPaused(owner, "drag", true);

    const early = queue.request("early", "background");
    const seen: string[] = [];
    const late = queue.subscribe("late", (value) => seen.push(value), () => {}, "background");
    late.setPriority("visible");

    queue.setPaused(owner, "drag", false);
    await flushPromises();

    expect(calls).toEqual(["late", "early"]);
    expect(seen).toEqual(["late"]);
    await expect(early).resolves.toBe("early");
  });

  it("lowers priority through setPriority without dropping the subscription", async () => {
    const calls: string[] = [];
    const queue = new SubscriberTaskQueue(async (key: string) => {
      calls.push(key);
      return key;
    });
    const owner = Symbol("scroll");
    queue.setPaused(owner, "drag", true);

    const seen: string[] = [];
    const hot = queue.subscribe("hot", (value) => seen.push(value), () => {}, "visible");
    const mid = queue.request("mid", "near");
    hot.setPriority("background");

    queue.setPaused(owner, "drag", false);
    await flushPromises();

    // "hot" was first in and visible, but it no longer outranks "mid".
    expect(calls).toEqual(["mid", "hot"]);
    expect(seen).toEqual(["hot"]);
    await expect(mid).resolves.toBe("mid");
  });

  it("falls back to the highest remaining subscriber when one leaves", async () => {
    const calls: string[] = [];
    const queue = new SubscriberTaskQueue(async (key: string) => {
      calls.push(key);
      return key;
    });
    const owner = Symbol("scroll");
    queue.setPaused(owner, "drag", true);

    const shared = queue.request("shared", "background");
    const visible = queue.subscribe("shared", () => {}, () => {}, "visible");
    const other = queue.request("other", "near");
    visible.unsubscribe();

    queue.setPaused(owner, "drag", false);
    await flushPromises();

    // Without the visible subscriber "shared" is background again.
    expect(calls).toEqual(["other", "shared"]);
    await expect(shared).resolves.toBe("shared");
    await expect(other).resolves.toBe("other");
  });

  it("runs per-attempt cleanup after an abandoned worker finally settles", async () => {
    const work = deferred<string>();
    const cleanups: string[] = [];
    const queue = new SubscriberTaskQueue<string>((key, context) => {
      context.onSettled(() => cleanups.push(key));
      return work.promise; // deliberately ignores abort
    });

    const subscription = queue.subscribe("image", () => {});
    subscription.unsubscribe();
    expect(cleanups).toEqual([]);

    work.resolve("late");
    await flushPromises();

    expect(cleanups).toEqual(["image"]);
    expect(queue.stats()).toMatchObject({ queued: 0, running: 0, subscribers: 0 });
  });

  it("rejects subscribers when the worker fails on its own", async () => {
    const queue = new SubscriberTaskQueue<string>(async () => {
      throw new Error("decode failed");
    });

    await expect(queue.request("image")).rejects.toThrow("decode failed");
    expect(queue.stats()).toMatchObject({ queued: 0, running: 0, subscribers: 0 });
  });
});
