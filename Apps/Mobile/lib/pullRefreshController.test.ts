import { describe, expect, it, vi } from "vitest";
import { createPullRefreshController } from "./pullRefreshController";

describe("createPullRefreshController", () => {
  it("isRefreshing is true only while run is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(() => gate);
    const onChange = vi.fn();
    const controller = createPullRefreshController({ onChange });

    expect(controller.isRefreshing()).toBe(false);
    const pending = controller.requestRefresh(run);
    expect(controller.isRefreshing()).toBe(true);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(run).toHaveBeenCalledTimes(1);

    release();
    await pending;
    expect(controller.isRefreshing()).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("re-entry during in-flight is a no-op", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(() => gate);
    const controller = createPullRefreshController();

    const first = controller.requestRefresh(run);
    await controller.requestRefresh(run);
    expect(run).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(controller.isRefreshing()).toBe(false);
  });

  it("clears refreshing after reject", async () => {
    const onChange = vi.fn();
    const controller = createPullRefreshController({ onChange });
    const run = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(controller.requestRefresh(run)).resolves.toBeUndefined();
    expect(controller.isRefreshing()).toBe(false);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });
});
