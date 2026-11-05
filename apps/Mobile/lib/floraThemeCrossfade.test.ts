import { describe, expect, it, vi } from "vitest";
import type { FloraThemeCrossfadeApi } from "flora-theme-crossfade";
import {
  createFloraThemeTransition,
  instantFloraThemeTransition,
} from "./floraThemeCrossfade";

function createCrossfade(freezeResult: boolean | Error) {
  const api: FloraThemeCrossfadeApi = {
    freeze: vi.fn(() =>
      freezeResult instanceof Error ? Promise.reject(freezeResult) : Promise.resolve(freezeResult),
    ),
    reveal: vi.fn(),
    cancel: vi.fn(),
  };
  return api;
}

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("floraThemeCrossfade", () => {
  it("instant transition applies synchronously", () => {
    const apply = vi.fn(() => true);
    instantFloraThemeTransition(apply);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("falls back to instant when the native module is missing", () => {
    const apply = vi.fn(() => true);
    createFloraThemeTransition(null)(apply);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("applies only after the snapshot covers the screen", async () => {
    const api = createCrossfade(true);
    const apply = vi.fn(() => true);
    createFloraThemeTransition(api)(apply);
    expect(api.freeze).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();

    await flushMicrotasks();
    expect(apply).toHaveBeenCalledTimes(1);
    // Растворение после коммита запускает провайдер, не стратегия.
    expect(api.reveal).not.toHaveBeenCalled();
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it("drops the snapshot when the palette did not change under it", async () => {
    const api = createCrossfade(true);
    const apply = vi.fn(() => false);
    createFloraThemeTransition(api)(apply);
    await flushMicrotasks();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(api.reveal).toHaveBeenCalledWith(0);
  });

  it("does not touch the overlay when freeze declined to cover", async () => {
    const api = createCrossfade(false);
    const apply = vi.fn(() => false);
    createFloraThemeTransition(api)(apply);
    await flushMicrotasks();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(api.reveal).not.toHaveBeenCalled();
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it("still applies the theme when freeze rejects", async () => {
    const api = createCrossfade(new Error("no surface"));
    const apply = vi.fn(() => true);
    createFloraThemeTransition(api)(apply);
    await flushMicrotasks();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(api.reveal).not.toHaveBeenCalled();
  });

  it("coalesces selections while the snapshot is being taken", async () => {
    const api = createCrossfade(true);
    const apply = vi.fn(() => true);
    const transition = createFloraThemeTransition(api);
    transition(apply);
    transition(apply);
    expect(api.freeze).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
    // Отложенный apply прочитал актуальный выбор store — второй не нужен.
    expect(apply).toHaveBeenCalledTimes(1);
    expect(api.reveal).not.toHaveBeenCalled();
  });

  it("starts a new transition once the previous one applied", async () => {
    const api = createCrossfade(true);
    const transition = createFloraThemeTransition(api);
    transition(() => true);
    await flushMicrotasks();
    transition(() => true);
    expect(api.freeze).toHaveBeenCalledTimes(2);
    await flushMicrotasks();
  });
});
