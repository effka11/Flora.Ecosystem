import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.mock("@/lib/mmkv", () => ({
  mmkv: {
    getString: (key: string) => store.get(key),
    set: (key: string, value: string) => {
      store.set(key, value);
    },
    delete: (key: string) => {
      store.delete(key);
    },
  },
}));

// eslint-disable-next-line import/first -- vi.mock must be registered before the module under test loads.
import { createFloraThemeStorage } from "./floraThemeStorage";

const LEGACY_KEY = "flora.userSettings.theme";
const STORAGE_KEY = "flora.userSettings.theme.v2";

describe("floraThemeStorage", () => {
  beforeEach(() => {
    store.clear();
  });

  it("resets a legacy saved theme to dark", () => {
    store.set(LEGACY_KEY, "light");

    const storage = createFloraThemeStorage();

    expect(storage.load()).toBe("dark");
    expect(store.has(LEGACY_KEY)).toBe(false);
  });

  it("keeps a theme saved after the reset", () => {
    store.set(STORAGE_KEY, "light");

    const storage = createFloraThemeStorage();

    expect(storage.load()).toBe("light");
  });

  it("prefers the current key and drops the legacy one when both exist", () => {
    store.set(LEGACY_KEY, "flora");
    store.set(STORAGE_KEY, "light");

    const storage = createFloraThemeStorage();

    expect(storage.load()).toBe("light");
    expect(store.has(LEGACY_KEY)).toBe(false);
  });

  it("saves the new choice under the current key", () => {
    const storage = createFloraThemeStorage();

    storage.save("flora");

    expect(store.get(STORAGE_KEY)).toBe("flora");
    expect(store.has(LEGACY_KEY)).toBe(false);
  });
});
