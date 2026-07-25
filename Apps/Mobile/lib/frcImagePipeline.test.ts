import { describe, expect, it } from "vitest";
import {
  FrcImagePipeline,
  type FrcImagePipelineBackend,
  type FrcPipelineFetchResult,
} from "./frcImagePipeline";

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
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

type Intermediate = { id: string; key: string };

describe("FrcImagePipeline", () => {
  it("keeps the underlying work-pause mechanism available as a rollback lever", async () => {
    const starts: string[] = [];
    const backend: FrcImagePipelineBackend<Intermediate, string> = {
      fetch: async (key) => {
        starts.push(key);
        return { kind: "ready", value: key };
      },
      decode: async (_key, intermediate) => intermediate.key,
      discard: () => {},
    };
    const pipeline = new FrcImagePipeline(backend);
    const owner = Symbol("rollback");
    pipeline.setWorkPaused(owner, "drag", true);

    const result = new Promise<string>((resolve) => {
      pipeline.subscribe("post", "post", resolve);
    });
    expect(starts).toEqual([]);

    pipeline.clearWorkPauseOwner(owner);
    await expect(result).resolves.toBe("post");
    expect(starts).toEqual(["post"]);
  });

  it("recalculates a task priority from its current subscribers, including lowering", async () => {
    const starts: string[] = [];
    const backend: FrcImagePipelineBackend<Intermediate, string> = {
      fetch: async (key) => {
        starts.push(key);
        return { kind: "ready", value: key };
      },
      decode: async (_key, intermediate) => intermediate.key,
      discard: () => {},
    };
    const pipeline = new FrcImagePipeline(backend);
    const owner = Symbol("rank");
    pipeline.setWorkPaused(owner, "drag", true);

    pipeline.subscribe("shared", "post", () => {}, () => {}, "background");
    const visible = pipeline.subscribe("shared", "post", () => {}, () => {}, "visible");
    pipeline.subscribe("middle", "post", () => {}, () => {}, "near");
    visible.unsubscribe();

    pipeline.clearWorkPauseOwner(owner);
    await flushPromises();

    expect(starts).toEqual(["middle", "shared"]);
  });

  it("reserves independent download capacity for posts and avatars", async () => {
    const starts: string[] = [];
    const runs = new Map<
      string,
      ReturnType<typeof deferred<FrcPipelineFetchResult<Intermediate, string>>>
    >();
    const backend: FrcImagePipelineBackend<Intermediate, string> = {
      fetch: (key, { signal }) => {
        starts.push(key);
        const run = deferred<FrcPipelineFetchResult<Intermediate, string>>();
        runs.set(key, run);
        signal.addEventListener("abort", () => run.reject(new Error("aborted")));
        return run.promise;
      },
      decode: async (_key, intermediate) => intermediate.key,
      discard: () => {},
    };
    const pipeline = new FrcImagePipeline(backend);
    const subscriptions = [
      pipeline.subscribe("avatar-1", "avatar", () => {}),
      pipeline.subscribe("avatar-2", "avatar", () => {}),
      pipeline.subscribe("post-1", "post", () => {}),
      pipeline.subscribe("post-2", "post", () => {}),
      pipeline.subscribe("post-3", "post", () => {}),
      pipeline.subscribe("post-4", "post", () => {}),
    ];

    expect(starts).toEqual(["avatar-1", "post-1", "post-2", "post-3"]);
    expect(starts).not.toContain("avatar-2");
    expect(starts).not.toContain("post-4");

    for (const subscription of subscriptions) subscription.unsubscribe();
    await flushPromises();
  });

  it("runs one post and one avatar decode independently", async () => {
    const decodeStarts: string[] = [];
    const decodeRuns = new Map<string, ReturnType<typeof deferred<string>>>();
    const discarded: string[] = [];
    const backend: FrcImagePipelineBackend<Intermediate, string> = {
      fetch: async (key) => ({
        kind: "intermediate",
        value: { id: `${key}-fri`, key },
      }),
      decode: (key, _intermediate, context) => {
        decodeStarts.push(key);
        context.markUncancellable();
        const run = deferred<string>();
        decodeRuns.set(key, run);
        return run.promise;
      },
      discard: (intermediate) => discarded.push(intermediate.id),
    };
    const pipeline = new FrcImagePipeline(backend);
    const seen: string[] = [];
    pipeline.subscribe("avatar-1", "avatar", (value) => seen.push(value));
    pipeline.subscribe("avatar-2", "avatar", (value) => seen.push(value));
    pipeline.subscribe("post-1", "post", (value) => seen.push(value));
    pipeline.subscribe("post-2", "post", (value) => seen.push(value));
    await flushPromises();

    expect(decodeStarts).toEqual(["avatar-1", "post-1"]);

    decodeRuns.get("avatar-1")?.resolve("avatar-1");
    decodeRuns.get("post-1")?.resolve("post-1");
    await flushPromises();
    expect(decodeStarts).toEqual(["avatar-1", "post-1", "avatar-2", "post-2"]);

    decodeRuns.get("avatar-2")?.resolve("avatar-2");
    decodeRuns.get("post-2")?.resolve("post-2");
    await flushPromises();
    expect(seen).toEqual(["avatar-1", "post-1", "avatar-2", "post-2"]);
    expect(discarded).toHaveLength(4);
  });

  it("evicts the farthest pending decode and deletes every discarded intermediate", async () => {
    const attempts = new Map<string, number>();
    const live = new Set<string>();
    const discarded: string[] = [];
    const runningDecode = deferred<string>();
    const backend: FrcImagePipelineBackend<Intermediate, string> = {
      fetch: async (key) => {
        const attempt = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, attempt);
        const intermediate = { id: `${key}#${attempt}`, key };
        live.add(intermediate.id);
        return { kind: "intermediate", value: intermediate };
      },
      decode: (key, intermediate, context) => {
        context.markUncancellable();
        if (key === "running") return runningDecode.promise;
        return Promise.resolve(intermediate.id);
      },
      discard: (intermediate) => {
        discarded.push(intermediate.id);
        live.delete(intermediate.id);
      },
    };
    const pipeline = new FrcImagePipeline(backend, {
      postDownloadConcurrency: 4,
      postDecodeConcurrency: 1,
      maxPendingDecodes: 2,
    });

    const running = pipeline.subscribe("running", "post", () => {}, () => {}, "visible");
    await flushPromises();
    const near = pipeline.subscribe("near", "post", () => {}, () => {}, "near");
    const backgroundOld = pipeline.subscribe(
      "background-old",
      "post",
      () => {},
      () => {},
      "background",
    );
    const backgroundFar = pipeline.subscribe(
      "background-far",
      "post",
      () => {},
      () => {},
      "background",
    );
    await flushPromises();

    expect(pipeline.stats()).toMatchObject({
      pendingDecode: 2,
      deferred: 1,
      discardedPending: 1,
    });
    expect(discarded).toContain("background-far#1");
    expect(live.has("background-far#1")).toBe(false);
    expect(live.has("near#1")).toBe(true);
    expect(live.has("background-old#1")).toBe(true);

    // The deferred row moves into view. Its fresh download displaces the
    // lower-priority pending artifact instead of waiting behind it forever.
    backgroundFar.setPriority("visible");
    await flushPromises();
    expect(attempts.get("background-far")).toBe(2);
    expect(discarded).toContain("background-old#1");
    expect(pipeline.stats()).toMatchObject({
      pendingDecode: 2,
      deferred: 1,
      discardedPending: 2,
    });

    near.unsubscribe();
    backgroundOld.unsubscribe();
    backgroundFar.unsubscribe();
    running.unsubscribe();
    runningDecode.resolve("running");
    await flushPromises();

    expect(live.size).toBe(0);
  });
});
