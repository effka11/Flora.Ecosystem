import { describe, expect, it } from "vitest";
import { LruCache } from "./lruCache";

describe("LruCache", () => {
  it("evicts the oldest entry past capacity", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.has("a")).toBe(false);
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
    expect(cache.size).toBe(2);
  });

  it("refreshes recency on get so the recently-read key survives", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1); // "a" now most-recent
    cache.set("c", 3); // evicts least-recent "b"
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
  });

  it("overwrites without growing and keeps recency", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 9);
    expect(cache.size).toBe(2);
    cache.set("c", 3); // evicts "b" (a was refreshed by overwrite)
    expect(cache.get("a")).toBe(9);
    expect(cache.has("b")).toBe(false);
  });

  it("rejects invalid capacity", () => {
    expect(() => new LruCache<string, number>(0)).toThrow();
    expect(() => new LruCache<string, number>(-1)).toThrow();
  });
});
