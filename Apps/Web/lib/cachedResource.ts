export const DEFAULT_TTL_MS = 60_000;

type CacheEntry<T> = {
  value: T;
  fetchedAt: number;
};

export type CachedResource<T> = {
  prefetch: () => void;
  peek: () => T | null;
  get: () => Promise<T>;
  set: (value: T) => void;
  refresh: () => Promise<T>;
  patch: (updater: (prev: T) => T) => void;
  invalidate: () => void;
};

export function createCachedResource<T>(fetcher: () => Promise<T>, ttlMs = DEFAULT_TTL_MS): CachedResource<T> {
  let entry: CacheEntry<T> | null = null;
  let inFlight: Promise<T> | null = null;
  let inFlightForced = false;
  let fetchSeq = 0;
  let appliedSeq = 0;
  let epoch = 0;

  // Starts a new network request, tagging it with the sequence/epoch it was
  // born into so its `.then` can decide (once it eventually settles) whether
  // it is still allowed to write into `entry`.
  const startFetch = (forced: boolean): Promise<T> => {
    fetchSeq += 1;
    const mySeq = fetchSeq;
    const myEpoch = epoch;

    let promise: Promise<T>;
    promise = fetcher()
      .then((value) => {
        if (myEpoch === epoch && mySeq > appliedSeq) {
          entry = { value, fetchedAt: Date.now() };
          appliedSeq = mySeq;
        }
        if (inFlight === promise) {
          inFlight = null;
          inFlightForced = false;
        }
        return value;
      })
      .catch((error) => {
        if (inFlight === promise) {
          inFlight = null;
          inFlightForced = false;
        }
        throw error;
      });

    inFlight = promise;
    inFlightForced = forced;
    return promise;
  };

  // `forced` requests (refresh()) only dedupe against another forced request;
  // a plain get()/prefetch() in flight must not be handed back to a caller
  // that explicitly asked for data no older than "now".
  const request = (forced: boolean): Promise<T> => {
    if (inFlight && (!forced || inFlightForced)) return inFlight;
    return startFetch(forced);
  };

  const isFresh = (): boolean => Boolean(entry && Date.now() - entry.fetchedAt < ttlMs);

  return {
    prefetch() {
      if (isFresh()) return;
      void request(false).catch(() => {});
    },
    peek() {
      return entry?.value ?? null;
    },
    get() {
      if (isFresh() && entry) {
        return Promise.resolve(entry.value);
      }
      return request(false);
    },
    set(value) {
      if (entry && entry.value === value) return;
      entry = { value, fetchedAt: Date.now() };
    },
    refresh() {
      return request(true);
    },
    patch(updater) {
      if (!entry) return;
      entry = { value: updater(entry.value), fetchedAt: entry.fetchedAt };
    },
    invalidate() {
      entry = null;
      inFlight = null;
      inFlightForced = false;
      epoch += 1;
    },
  };
}

type KeyedRequestMeta = {
  fetchSeq: number;
  appliedSeq: number;
  epoch: number;
};

export function createKeyedCachedResource<K, T>(
  fetcher: (key: K) => Promise<T>,
  ttlMs = DEFAULT_TTL_MS,
): {
  prefetch: (key: K) => void;
  peek: (key: K) => T | null;
  get: (key: K) => Promise<T>;
  set: (key: K, value: T) => void;
  invalidate: (key?: K) => void;
} {
  const entries = new Map<K, CacheEntry<T>>();
  const inFlights = new Map<K, Promise<T>>();
  const meta = new Map<K, KeyedRequestMeta>();

  const getMeta = (key: K): KeyedRequestMeta => {
    let m = meta.get(key);
    if (!m) {
      m = { fetchSeq: 0, appliedSeq: 0, epoch: 0 };
      meta.set(key, m);
    }
    return m;
  };

  // No `refresh`/`patch` on the keyed surface, so every request here is
  // non-forced; the only staleness hazard is a request started before
  // invalidate(key) landing in the map afterwards.
  const fetchFresh = (key: K): Promise<T> => {
    const existing = inFlights.get(key);
    if (existing) return existing;

    const m = getMeta(key);
    m.fetchSeq += 1;
    const mySeq = m.fetchSeq;
    const myEpoch = m.epoch;

    let promise: Promise<T>;
    promise = fetcher(key)
      .then((value) => {
        if (myEpoch === m.epoch && mySeq > m.appliedSeq) {
          entries.set(key, { value, fetchedAt: Date.now() });
          m.appliedSeq = mySeq;
        }
        if (inFlights.get(key) === promise) {
          inFlights.delete(key);
        }
        return value;
      })
      .catch((error) => {
        if (inFlights.get(key) === promise) {
          inFlights.delete(key);
        }
        throw error;
      });

    inFlights.set(key, promise);
    return promise;
  };

  const isFresh = (key: K): boolean => {
    const entry = entries.get(key);
    return Boolean(entry && Date.now() - entry.fetchedAt < ttlMs);
  };

  return {
    prefetch(key) {
      if (isFresh(key)) return;
      void fetchFresh(key).catch(() => {});
    },
    peek(key) {
      return entries.get(key)?.value ?? null;
    },
    get(key) {
      const entry = entries.get(key);
      if (entry && isFresh(key)) {
        return Promise.resolve(entry.value);
      }
      return fetchFresh(key);
    },
    set(key, value) {
      const existing = entries.get(key);
      if (existing && existing.value === value) return;
      entries.set(key, { value, fetchedAt: Date.now() });
    },
    invalidate(key) {
      if (key === undefined) {
        // Bump epoch for every key with a live entry or an in-flight request
        // so an orphaned promise (started before this call) can't write its
        // result back in after we clear the maps below.
        for (const k of new Set<K>([...entries.keys(), ...inFlights.keys()])) {
          getMeta(k).epoch += 1;
        }
        entries.clear();
        inFlights.clear();
        return;
      }
      entries.delete(key);
      inFlights.delete(key);
      getMeta(key).epoch += 1;
    },
  };
}
