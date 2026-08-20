import {
  isScrollSettled as liveIsScrollSettled,
  subscribeScrollSettled as liveSubscribeScrollSettled,
} from "@/lib/scrollActivity";

export type IdleScrollGateDeps = {
  isScrollSettled?: () => boolean;
  subscribeScrollSettled?: (listener: (settled: boolean) => void) => () => void;
};

export type IdleSlicedDeps = IdleScrollGateDeps & {
  yieldBetweenSteps?: () => Promise<void>;
};

export type IdleSlicedHandle<T> = {
  cancel: () => void;
  done: Promise<T[] | null>;
};

/** Yield to the macrotask queue so a feed frame can run between sodium steps. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Pause work while the feed (or any scrollActivity owner) is unsettled.
 * Cancel resolves an in-flight wait so the caller can stop.
 */
export function createIdleScrollGate(deps: IdleScrollGateDeps = {}) {
  const isScrollSettled = deps.isScrollSettled ?? liveIsScrollSettled;
  const subscribeScrollSettled = deps.subscribeScrollSettled ?? liveSubscribeScrollSettled;
  let cancelled = false;
  let abortWait: (() => void) | null = null;

  const waitUntilSettled = (): Promise<void> => {
    if (cancelled || isScrollSettled()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const unsub = subscribeScrollSettled((settled) => {
        if (!settled) return;
        unsub();
        abortWait = null;
        resolve();
      });
      abortWait = () => {
        unsub();
        abortWait = null;
        resolve();
      };
    });
  };

  return {
    isCancelled: () => cancelled,
    isScrollSettled,
    cancel() {
      cancelled = true;
      abortWait?.();
      abortWait = null;
    },
    async pauseIfBusy(): Promise<boolean> {
      while (!cancelled && !isScrollSettled()) {
        await waitUntilSettled();
      }
      return !cancelled;
    },
  };
}

/** Map items one-by-one, pausing before and after each step if scroll is busy. */
export function mapIdleSliced<T, R>(
  items: readonly T[],
  mapOne: (item: T) => Promise<R>,
  deps: IdleSlicedDeps = {},
): IdleSlicedHandle<R> {
  const gate = createIdleScrollGate(deps);
  const yieldStep = deps.yieldBetweenSteps ?? yieldToEventLoop;
  const done = (async () => {
    const out: R[] = [];
    for (const item of items) {
      if (gate.isCancelled()) return null;
      // Skip `await` when already settled so the first mapOne starts on this tick.
      if (!gate.isScrollSettled()) {
        if (!(await gate.pauseIfBusy())) return null;
      }
      const value = await mapOne(item);
      if (gate.isCancelled()) return null;
      if (!gate.isScrollSettled()) {
        if (!(await gate.pauseIfBusy())) return null;
      }
      out.push(value);
      await yieldStep();
      if (gate.isCancelled()) return null;
    }
    return gate.isCancelled() ? null : out;
  })();
  return { cancel: () => gate.cancel(), done };
}
