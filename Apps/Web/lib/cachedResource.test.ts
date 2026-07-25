import assert from "node:assert/strict";
import test from "node:test";
import { createCachedResource, createKeyedCachedResource } from "./cachedResource";

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("get() -> set(same value) repeated does not extend TTL; next get() after TTL refetches", async () => {
  let calls = 0;
  const value = { id: "same" };
  const resource = createCachedResource(async () => {
    calls += 1;
    return value;
  }, 30);

  const first = await resource.get();
  assert.equal(calls, 1);
  assert.equal(first, value);

  // Simulate the get() -> set(same reference) anti-pattern repeated many times.
  for (let i = 0; i < 10; i += 1) {
    resource.set(resource.peek() as typeof value);
  }
  assert.equal(calls, 1);

  await wait(60);
  const second = await resource.get();
  assert.equal(calls, 2);
  assert.equal(second, value);
});

test("set(different value) resets fetchedAt so get() stays cached within TTL", async () => {
  let calls = 0;
  const resource = createCachedResource(async () => {
    calls += 1;
    return { id: `fetched-${calls}` };
  }, 200);

  await resource.get();
  assert.equal(calls, 1);

  resource.set({ id: "replaced" });
  await wait(20);
  const value = await resource.get();
  assert.equal(calls, 1);
  assert.deepEqual(value, { id: "replaced" });
});

test("refresh() bypasses TTL, updates cache, and dedupes concurrent calls", async () => {
  let calls = 0;
  const resource = createCachedResource(async () => {
    calls += 1;
    await wait(5);
    return { id: `v${calls}` };
  }, 60_000);

  const first = await resource.get();
  assert.equal(calls, 1);
  assert.deepEqual(first, { id: "v1" });

  const [a, b] = await Promise.all([resource.refresh(), resource.refresh()]);
  assert.equal(calls, 2);
  assert.equal(a, b);
  assert.deepEqual(a, { id: "v2" });
  assert.equal(resource.peek(), a);
});

test("refresh() propagates fetcher errors without leaving inFlight stuck", async () => {
  let calls = 0;
  const resource = createCachedResource(async () => {
    calls += 1;
    if (calls === 1) throw new Error("network down");
    return { id: "ok" };
  }, 60_000);

  await assert.rejects(resource.refresh(), /network down/);
  assert.equal(calls, 1);

  const value = await resource.refresh();
  assert.equal(calls, 2);
  assert.deepEqual(value, { id: "ok" });
});

test("patch() updates value via peek() without touching TTL or fetcher; no-op on empty cache", async () => {
  let calls = 0;
  const resource = createCachedResource(async () => {
    calls += 1;
    return { count: 1 };
  }, 200);

  resource.patch((prev) => ({ count: prev.count + 1 }));
  assert.equal(resource.peek(), null);
  assert.equal(calls, 0);

  await resource.get();
  assert.equal(calls, 1);

  resource.patch((prev) => ({ count: prev.count + 1 }));
  assert.deepEqual(resource.peek(), { count: 2 });
  assert.equal(calls, 1);

  await wait(20);
  const value = await resource.get();
  assert.equal(calls, 1, "patch() must not reset fetchedAt / trigger a refetch within TTL");
  assert.deepEqual(value, { count: 2 });
});

test("invalidate() forces the next get() to go to the network", async () => {
  let calls = 0;
  const resource = createCachedResource(async () => {
    calls += 1;
    return { count: calls };
  }, 60_000);

  await resource.get();
  assert.equal(calls, 1);

  resource.invalidate();
  assert.equal(resource.peek(), null);

  await resource.get();
  assert.equal(calls, 2);
});

test("refresh() does not reuse an in-flight get(): fetcher is called again with a distinct promise", async () => {
  let calls = 0;
  const deferreds: Array<{ resolve: (value: { id: string }) => void }> = [];
  const resource = createCachedResource<{ id: string }>(() => {
    calls += 1;
    return new Promise((resolve) => {
      deferreds.push({ resolve });
    });
  }, 60_000);

  const getPromise = resource.get();
  assert.equal(calls, 1);

  const refreshPromise = resource.refresh();
  assert.equal(calls, 2, "refresh() must start its own fetcher call instead of reusing get()'s in-flight request");
  assert.notEqual(getPromise, refreshPromise);

  deferreds[0]!.resolve({ id: "stale" });
  deferreds[1]!.resolve({ id: "fresh" });
  await Promise.all([getPromise, refreshPromise]);
});

test("refresh() wins the cache regardless of completion order: old request finishes first", async () => {
  let calls = 0;
  const deferreds: Array<{ resolve: (value: { id: string }) => void }> = [];
  const resource = createCachedResource<{ id: string }>(() => {
    calls += 1;
    return new Promise((resolve) => {
      deferreds.push({ resolve });
    });
  }, 60_000);

  const getPromise = resource.get();
  const refreshPromise = resource.refresh();
  assert.equal(calls, 2);

  // The get()-triggered (older) request settles first...
  deferreds[0]!.resolve({ id: "stale" });
  await getPromise;
  assert.deepEqual(resource.peek(), { id: "stale" }, "in-flight window: last-settled-so-far value is visible");

  // ...but once the forced refresh() settles, its value must win and stay.
  deferreds[1]!.resolve({ id: "fresh" });
  const refreshed = await refreshPromise;
  assert.deepEqual(refreshed, { id: "fresh" });
  assert.deepEqual(resource.peek(), { id: "fresh" });
});

test("refresh() wins the cache regardless of completion order: forced request finishes first", async () => {
  let calls = 0;
  const deferreds: Array<{ resolve: (value: { id: string }) => void }> = [];
  const resource = createCachedResource<{ id: string }>(() => {
    calls += 1;
    return new Promise((resolve) => {
      deferreds.push({ resolve });
    });
  }, 60_000);

  const getPromise = resource.get();
  const refreshPromise = resource.refresh();
  assert.equal(calls, 2);

  // The forced refresh() settles first...
  deferreds[1]!.resolve({ id: "fresh" });
  const refreshed = await refreshPromise;
  assert.deepEqual(refreshed, { id: "fresh" });
  assert.deepEqual(resource.peek(), { id: "fresh" });

  // ...the older get()-triggered request settling afterwards must not
  // overwrite the newer forced result.
  deferreds[0]!.resolve({ id: "stale" });
  const stale = await getPromise;
  assert.deepEqual(stale, { id: "stale" }, "the older request still resolves with its own value");
  assert.deepEqual(resource.peek(), { id: "fresh" }, "older result must not clobber the newer forced result");
});

test("two concurrent refresh() calls dedupe into a single fetcher call and share one promise", async () => {
  let calls = 0;
  const resource = createCachedResource(async () => {
    calls += 1;
    await wait(5);
    return { id: `v${calls}` };
  }, 60_000);

  const [a, b] = await Promise.all([resource.refresh(), resource.refresh()]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.deepEqual(resource.peek(), a);
});

test("invalidate() during an in-flight request discards its result: peek() stays null and the next get() refetches", async () => {
  let calls = 0;
  const resolvers: Array<(value: { id: string }) => void> = [];
  const resource = createCachedResource<{ id: string }>(() => {
    calls += 1;
    return new Promise((resolve) => {
      resolvers.push(resolve);
    });
  }, 60_000);

  const pending = resource.get();
  assert.equal(calls, 1);

  resource.invalidate();
  resolvers[0]!({ id: "orphaned" });
  await pending;

  assert.equal(resource.peek(), null, "result of a request started before invalidate() must not populate the cache");

  const next = resource.get();
  assert.equal(calls, 2, "the next get() after invalidate() must hit the network again, not reuse a stale promise");
  resolvers[1]!({ id: "fresh" });
  await next;
  assert.deepEqual(resource.peek(), { id: "fresh" });
});

test("refresh() rejects propagate without leaving a stuck inFlight, and a late catch() of an old request does not clobber the new one", async () => {
  let calls = 0;
  const rejecters: Array<(error: Error) => void> = [];
  const resolvers: Array<(value: { id: string }) => void> = [];
  const resource = createCachedResource<{ id: string }>(() => {
    calls += 1;
    return new Promise((resolve, reject) => {
      rejecters.push(reject);
      resolvers.push(resolve);
    });
  }, 60_000);

  const first = resource.get();
  const firstRejection = assert.rejects(first, /boom/);
  rejecters[0]!(new Error("boom"));
  await firstRejection;

  const second = resource.get();
  assert.equal(calls, 2, "a fresh request must be started after the previous one rejected");
  resolvers[1]!({ id: "ok" });
  await second;
  assert.deepEqual(resource.peek(), { id: "ok" });
});

test("keyed: invalidate(key) during an in-flight request for that key discards its result without touching other keys", async () => {
  let calls = 0;
  let resolveA: ((value: { key: string; n: number }) => void) | null = null;
  const resource = createKeyedCachedResource<string, { key: string; n: number }>((key) => {
    calls += 1;
    if (key === "a") {
      return new Promise((resolve) => {
        resolveA = resolve;
      });
    }
    return Promise.resolve({ key, n: calls });
  }, 60_000);

  const pendingA = resource.get("a");
  await resource.get("b");
  assert.deepEqual(resource.peek("b"), { key: "b", n: 2 });

  resource.invalidate("a");
  resolveA!({ key: "a", n: 1 });
  await pendingA;

  assert.equal(resource.peek("a"), null, "invalidate(key) must discard the result of a request already in flight for that key");
  assert.deepEqual(resource.peek("b"), { key: "b", n: 2 }, "other keys must be unaffected");
});

test("keyed: invalidate() without a key during an in-flight request discards its result", async () => {
  let calls = 0;
  const resolvers: Array<(value: { key: string; n: number }) => void> = [];
  const resource = createKeyedCachedResource<string, { key: string; n: number }>((key) => {
    calls += 1;
    return new Promise((resolve) => {
      resolvers.push(resolve);
    });
  }, 60_000);

  const pendingA = resource.get("a");
  resource.invalidate();
  resolvers[0]!({ key: "a", n: 1 });
  await pendingA;

  assert.equal(resource.peek("a"), null, "invalidate() must discard results of requests started before it, keyed variant included");

  const next = resource.get("a");
  assert.equal(calls, 2, "the next get() after a no-key invalidate() must refetch");
  resolvers[1]!({ key: "a", n: 2 });
  await next;
  assert.deepEqual(resource.peek("a"), { key: "a", n: 2 });
});

test("keyed: set() identity guard is per-key; invalidate(key) clears only that key", async () => {
  let calls = 0;
  const resource = createKeyedCachedResource(async (key: string) => {
    calls += 1;
    return { key, calls };
  }, 30);

  const valueA = await resource.get("a");
  const valueB = await resource.get("b");
  assert.equal(calls, 2);

  for (let i = 0; i < 5; i += 1) {
    resource.set("a", resource.peek("a") as typeof valueA);
  }
  for (let i = 0; i < 5; i += 1) {
    resource.set("b", { key: "b", calls: -1 });
  }
  assert.deepEqual(resource.peek("b"), { key: "b", calls: -1 });

  await wait(60);

  await resource.get("a");
  assert.equal(calls, 3, "identity-guarded set() on key a must not extend TTL");

  resource.invalidate("b");
  assert.equal(resource.peek("b"), null);
  assert.notEqual(resource.peek("a"), null);

  resource.invalidate();
  assert.equal(resource.peek("a"), null);
  assert.equal(resource.peek("b"), null);
});
