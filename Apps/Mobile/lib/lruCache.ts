/**
 * Minimal bounded LRU cache. Backed by a Map, whose insertion order is used as
 * the recency list: reads re-insert the key, and inserts past `capacity` evict
 * the oldest entry. Keeps feed-row layout/ratio caches from growing without
 * bound as the recommendations corpus scrolls.
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("LruCache capacity must be a positive integer");
    }
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}
