import { getFloraRuntimeCacheKey } from "@/lib/runtimeCacheVersion";

/**
 * Живой объект, который пересобирается при смене runtime-ключа
 * (шаг сетки + тема) и кэширует готовые значения по ключу.
 *
 * Кэш на несколько записей: переключение темы «туда-обратно» не должно
 * заново вызывать `StyleSheet.create` для уже собранной палитры.
 */
export function createKeyedLiveValue<T extends object>(
  factory: () => T,
  getKey: () => string = getFloraRuntimeCacheKey,
  maxEntries = 6,
): T {
  const cache = new Map<string, T>();
  const limit = Math.max(1, maxEntries);

  const resolve = (): T => {
    const key = getKey();
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const value = factory();
    if (cache.size >= limit) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
    cache.set(key, value);
    return value;
  };

  return new Proxy({} as T, {
    get(_target, prop) {
      const value = (resolve() as Record<PropertyKey, unknown>)[prop];
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(resolve())
        : value;
    },
    ownKeys() {
      return Reflect.ownKeys(resolve() as object);
    },
    getOwnPropertyDescriptor(_target, prop) {
      return Object.getOwnPropertyDescriptor(resolve() as object, prop);
    },
    has(_target, prop) {
      return prop in resolve();
    },
    // StyleSheet.create freezes style objects in dev. Accepting that on an
    // empty target makes the next ownKeys throw for the rest of the session.
    preventExtensions() {
      return false;
    },
  });
}
