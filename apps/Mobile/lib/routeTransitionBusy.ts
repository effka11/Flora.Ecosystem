import { setScrollActivity } from "@/lib/scrollActivity";

export type RouteTransitionBusyController = {
  cover: () => void;
  /** Capture the generation; call `finish` when the overlay fade ends. */
  reveal: () => { finish: () => void };
  reset: () => void;
  dispose: () => void;
};

/**
 * Hold idle-busy for the tab-switch overlay until reset, or until the
 * reveal fade finishes. A later cover/reset bumps generation so a stale
 * fade callback cannot clear a newer hold.
 */
export function createRouteTransitionBusyController(opts: {
  setBusy: (busy: boolean) => void;
}): RouteTransitionBusyController {
  let gen = 0;
  let disposed = false;

  const setBusy = (busy: boolean) => {
    if (disposed) return;
    opts.setBusy(busy);
  };

  return {
    cover() {
      if (disposed) return;
      gen += 1;
      setBusy(true);
    },
    reveal() {
      const current = gen;
      return {
        finish() {
          if (disposed || current !== gen) return;
          setBusy(false);
        },
      };
    },
    reset() {
      if (disposed) return;
      gen += 1;
      setBusy(false);
    },
    dispose() {
      disposed = true;
      opts.setBusy(false);
    },
  };
}

export function bindRouteTransitionBusy(owner: symbol): RouteTransitionBusyController {
  return createRouteTransitionBusyController({
    setBusy: (busy) => setScrollActivity(owner, "route", busy),
  });
}
