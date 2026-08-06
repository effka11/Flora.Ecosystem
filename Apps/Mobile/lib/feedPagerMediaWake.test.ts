import { describe, expect, it, vi } from "vitest";
import { schedulePagerMediaWake } from "./feedPagerMediaWake";

describe("schedulePagerMediaWake", () => {
  it("fires run once when the scheduled callback runs", () => {
    let fire: (() => void) | null = null;
    const run = vi.fn();
    schedulePagerMediaWake({
      run,
      afterInteractions: (cb) => {
        fire = cb;
        return { cancel: vi.fn() };
      },
    });
    expect(run).not.toHaveBeenCalled();
    fire!();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not call run when cancelled before fire", () => {
    let fire: (() => void) | null = null;
    const cancelTask = vi.fn();
    const run = vi.fn();
    const handle = schedulePagerMediaWake({
      run,
      afterInteractions: (cb) => {
        fire = cb;
        return { cancel: cancelTask };
      },
    });
    handle.cancel();
    expect(cancelTask).toHaveBeenCalledTimes(1);
    fire!();
    expect(run).not.toHaveBeenCalled();
  });
});
