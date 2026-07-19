import { describe, expect, it, vi } from "vitest";
import { createPostViewBatcher, type PostViewBatcherDeps } from "./postViewBatcher";

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
  await Promise.resolve();
}

function harness(overrides: Partial<PostViewBatcherDeps> = {}) {
  const persisted = new Set<string>();
  const persist = vi.fn((ids: Set<string>) => {
    persisted.clear();
    for (const id of ids) persisted.add(id);
  });
  const applyCounts = vi.fn<(counts: Record<string, number>) => void>();
  const notifyChange = vi.fn<(id: string, count: number) => void>();
  let moving = false;
  const deps: PostViewBatcherDeps = {
    loadPersisted: () => new Set(persisted),
    persist,
    send: (id) => Promise.resolve({ viewsCount: id.length }),
    applyCounts,
    notifyChange,
    isMoving: () => moving,
    ...overrides,
  };
  const batcher = createPostViewBatcher(deps);
  return {
    batcher,
    persist,
    applyCounts,
    notifyChange,
    persisted,
    setMoving: (v: boolean) => {
      moving = v;
    },
  };
}

describe("createPostViewBatcher", () => {
  it("does not persist or apply counts while moving; flush does both once", async () => {
    const send = vi.fn((id: string) => Promise.resolve({ viewsCount: id.length }));
    const h = harness({ send });
    h.setMoving(true);

    h.batcher.observe("aa");
    h.batcher.observe("bbb");
    await flushPromises();

    expect(send).toHaveBeenCalledTimes(2);
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.applyCounts).not.toHaveBeenCalled();

    h.batcher.flush();
    expect(h.persist).toHaveBeenCalledTimes(1);
    expect([...h.persisted].sort()).toEqual(["aa", "bbb"]);
    expect(h.applyCounts).toHaveBeenCalledTimes(1);
    expect(h.applyCounts).toHaveBeenCalledWith({ aa: 2, bbb: 3 });
    expect(h.notifyChange).toHaveBeenCalledWith("aa", 2);
  });

  it("applies counts immediately when settled", async () => {
    const h = harness();
    h.setMoving(false);
    h.batcher.observe("xyz");
    await flushPromises();
    expect(h.applyCounts).toHaveBeenCalledWith({ xyz: 3 });
    expect(h.persist).toHaveBeenCalledTimes(1);
  });

  it("dedupes an id against persisted and in-flight sets", async () => {
    const send = vi.fn((id: string) => Promise.resolve({ viewsCount: id.length }));
    const h = harness({ send });
    h.setMoving(true);
    h.batcher.observe("dup");
    h.batcher.observe("dup");
    await flushPromises();
    h.batcher.flush();
    h.batcher.observe("dup");
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rolls back an id on send failure and never persists it", async () => {
    const gate = deferred<{ viewsCount: number } | null>();
    const send = vi.fn(() => gate.promise);
    const h = harness({ send });
    h.setMoving(true);
    h.batcher.observe("bad");
    gate.reject(new Error("network"));
    await flushPromises();

    h.batcher.flush();
    expect(h.persist).not.toHaveBeenCalled();
    expect([...h.persisted]).toEqual([]);
  });

  it("rolls back when server returns null", async () => {
    const send = vi.fn(() => Promise.resolve(null));
    const h = harness({ send });
    h.setMoving(true);
    h.batcher.observe("nope");
    await flushPromises();
    h.batcher.flush();
    expect(h.persist).not.toHaveBeenCalled();
  });

  it("reset flushes the outgoing session before switching", async () => {
    const h = harness();
    h.setMoving(true);
    h.batcher.observe("aa");
    await flushPromises();
    h.batcher.reset(new Set(["seed"]));
    // outgoing "aa" was persisted during reset's flush
    expect(h.persist).toHaveBeenCalled();
    const snap = h.batcher.snapshot();
    expect(snap.persistedSize).toBe(1);
    expect(snap.optimisticSize).toBe(0);
  });
});
