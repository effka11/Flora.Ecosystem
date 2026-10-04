import { afterEach, describe, expect, it } from "vitest";
import {
  __resetScrollActivity,
  isScrollSettled,
} from "./scrollActivity";
import {
  bindRouteTransitionBusy,
  createRouteTransitionBusyController,
} from "./routeTransitionBusy";

afterEach(() => __resetScrollActivity());

describe("createRouteTransitionBusyController", () => {
  it("holds busy from cover until reveal finishes", () => {
    const busy: boolean[] = [];
    const controller = createRouteTransitionBusyController({
      setBusy: (next) => {
        busy.push(next);
      },
    });
    controller.cover();
    const reveal = controller.reveal();
    expect(busy).toEqual([true]);
    reveal.finish();
    expect(busy).toEqual([true, false]);
  });

  it("ignores a stale reveal finish after a later cover", () => {
    let current = false;
    const controller = createRouteTransitionBusyController({
      setBusy: (next) => {
        current = next;
      },
    });
    controller.cover();
    const first = controller.reveal();
    controller.cover();
    first.finish();
    expect(current).toBe(true);
    controller.reveal().finish();
    expect(current).toBe(false);
  });

  it("reset clears busy and ignores a later finish", () => {
    let current = false;
    const controller = createRouteTransitionBusyController({
      setBusy: (next) => {
        current = next;
      },
    });
    controller.cover();
    const reveal = controller.reveal();
    controller.reset();
    expect(current).toBe(false);
    reveal.finish();
    expect(current).toBe(false);
  });
});

describe("bindRouteTransitionBusy", () => {
  it("publishes the route reason onto scrollActivity", () => {
    const owner = Symbol("route");
    const controller = bindRouteTransitionBusy(owner);
    controller.cover();
    expect(isScrollSettled()).toBe(false);
    controller.reveal().finish();
    expect(isScrollSettled()).toBe(true);
    controller.dispose();
  });
});
