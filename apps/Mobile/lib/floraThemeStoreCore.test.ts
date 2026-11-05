import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FloraThemeTransition } from "./floraThemeCrossfade";
import { applyFloraTheme, getFloraThemeId } from "./floraThemeRuntime";
import {
  createFloraThemeStore,
  effectiveFloraThemeId,
  type FloraThemeState,
} from "./floraThemeStoreCore";

function createStore(
  initialSavedThemeId: FloraThemeState["savedThemeId"] = "dark",
  transition?: FloraThemeTransition,
) {
  const save = vi.fn();
  const store = createFloraThemeStore({
    initialSavedThemeId,
    persistence: { save },
    transition,
  });
  return { store, save };
}

/** Переход, который откладывает применение до явного `flush()` — как нативный freeze. */
function createDeferredTransition() {
  const queue: (() => boolean)[] = [];
  const transition: FloraThemeTransition = (apply) => {
    queue.push(apply);
  };
  const flush = () => {
    const results: boolean[] = [];
    while (queue.length > 0) results.push(queue.shift()!());
    return results;
  };
  return { transition, flush, pending: () => queue.length };
}

describe("floraThemeStoreCore", () => {
  beforeEach(() => {
    applyFloraTheme("dark");
  });

  it("applies the saved theme at creation", () => {
    const { store } = createStore("light");
    expect(store.getState().savedThemeId).toBe("light");
    expect(store.getState().appliedThemeId).toBe("light");
    expect(store.getState().previewThemeId).toBeNull();
    expect(store.getState().version).toBe(0);
    expect(getFloraThemeId()).toBe("light");
  });

  it("select applies the preview immediately with the instant transition", () => {
    const { store, save } = createStore();
    store.getState().selectTheme("light");
    expect(store.getState().previewThemeId).toBe("light");
    expect(store.getState().appliedThemeId).toBe("light");
    expect(store.getState().version).toBe(1);
    expect(effectiveFloraThemeId(store.getState())).toBe("light");
    expect(getFloraThemeId()).toBe("light");
    expect(save).not.toHaveBeenCalled();
  });

  it("selecting the same theme twice does not bump the version", () => {
    const { store } = createStore();
    store.getState().selectTheme("light");
    store.getState().selectTheme("light");
    expect(store.getState().version).toBe(1);
  });

  it("selecting the saved theme returns to it and bumps the version once", () => {
    const { store } = createStore();
    store.getState().selectTheme("light");
    store.getState().selectTheme("dark");
    expect(store.getState().previewThemeId).toBeNull();
    expect(store.getState().appliedThemeId).toBe("dark");
    expect(store.getState().version).toBe(2);
    expect(getFloraThemeId()).toBe("dark");
  });

  it("commit persists the preview without touching the palette", () => {
    const { store, save } = createStore();
    store.getState().selectTheme("flora");
    expect(store.getState().commitTheme()).toBe("flora");
    expect(save).toHaveBeenCalledWith("flora");
    expect(store.getState().savedThemeId).toBe("flora");
    expect(store.getState().previewThemeId).toBeNull();
    expect(store.getState().appliedThemeId).toBe("flora");
    expect(store.getState().version).toBe(1);
    expect(getFloraThemeId()).toBe("flora");
  });

  it("commit without a preview is a no-op", () => {
    const { store, save } = createStore();
    expect(store.getState().commitTheme()).toBe("dark");
    expect(save).not.toHaveBeenCalled();
    expect(store.getState().version).toBe(0);
  });

  it("discard returns to the saved theme", () => {
    const { store, save } = createStore();
    store.getState().selectTheme("light");
    expect(store.getState().discardTheme()).toBe("dark");
    expect(store.getState().previewThemeId).toBeNull();
    expect(store.getState().appliedThemeId).toBe("dark");
    expect(store.getState().version).toBe(2);
    expect(getFloraThemeId()).toBe("dark");
    expect(save).not.toHaveBeenCalled();
  });

  it("discard without a preview is a no-op", () => {
    const { store } = createStore();
    expect(store.getState().discardTheme()).toBe("dark");
    expect(store.getState().version).toBe(0);
  });

  describe("with a deferred transition", () => {
    it("updates the selection at once and the palette when the transition applies", () => {
      const deferred = createDeferredTransition();
      const { store } = createStore("dark", deferred.transition);
      store.getState().selectTheme("light");
      expect(store.getState().previewThemeId).toBe("light");
      expect(store.getState().appliedThemeId).toBe("dark");
      expect(store.getState().version).toBe(0);
      expect(getFloraThemeId()).toBe("dark");
      expect(deferred.pending()).toBe(1);

      expect(deferred.flush()).toEqual([true]);
      expect(store.getState().appliedThemeId).toBe("light");
      expect(store.getState().version).toBe(1);
      expect(getFloraThemeId()).toBe("light");
    });

    it("does not start a transition when the palette would not change", () => {
      const deferred = createDeferredTransition();
      const { store } = createStore("dark", deferred.transition);
      store.getState().selectTheme("dark");
      expect(deferred.pending()).toBe(0);
      store.getState().discardTheme();
      expect(deferred.pending()).toBe(0);
    });

    it("applies the latest selection and reports no change for the stale one", () => {
      const deferred = createDeferredTransition();
      const { store } = createStore("dark", deferred.transition);
      store.getState().selectTheme("light");
      store.getState().selectTheme("flora");
      expect(deferred.pending()).toBe(2);
      // Первый apply применяет уже актуальную тему, второй — ничего нового.
      expect(deferred.flush()).toEqual([true, false]);
      expect(store.getState().appliedThemeId).toBe("flora");
      expect(store.getState().version).toBe(1);
      expect(getFloraThemeId()).toBe("flora");
    });

    it("reports no change when the selection was reverted before the transition applied", () => {
      const deferred = createDeferredTransition();
      const { store } = createStore("dark", deferred.transition);
      store.getState().selectTheme("light");
      store.getState().selectTheme("dark");
      expect(deferred.pending()).toBe(1);
      expect(deferred.flush()).toEqual([false]);
      expect(store.getState().appliedThemeId).toBe("dark");
      expect(store.getState().version).toBe(0);
    });

    it("commit while the transition is pending keeps the palette change on track", () => {
      const deferred = createDeferredTransition();
      const { store, save } = createStore("dark", deferred.transition);
      store.getState().selectTheme("light");
      expect(store.getState().commitTheme()).toBe("light");
      expect(save).toHaveBeenCalledWith("light");
      expect(store.getState().savedThemeId).toBe("light");
      expect(store.getState().appliedThemeId).toBe("dark");
      expect(deferred.flush()).toEqual([true]);
      expect(store.getState().appliedThemeId).toBe("light");
      expect(store.getState().version).toBe(1);
    });

    it("discard after an applied preview schedules a transition back", () => {
      const deferred = createDeferredTransition();
      const { store } = createStore("dark", deferred.transition);
      store.getState().selectTheme("light");
      deferred.flush();
      expect(store.getState().discardTheme()).toBe("dark");
      expect(store.getState().appliedThemeId).toBe("light");
      expect(deferred.flush()).toEqual([true]);
      expect(store.getState().appliedThemeId).toBe("dark");
      expect(store.getState().version).toBe(2);
      expect(getFloraThemeId()).toBe("dark");
    });
  });
});
