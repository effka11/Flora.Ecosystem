export type PagerMediaWakeHandle = {
  cancel: () => void;
};

export type AfterInteractionsTask = {
  cancel: () => void;
};

type AfterInteractions = (cb: () => void) => AfterInteractionsTask;

function defaultAfterInteractions(cb: () => void): AfterInteractionsTask {
  // Lazy require: vitest cannot parse react-native's flow entry.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { InteractionManager } = require("react-native") as typeof import("react-native");
  const task = InteractionManager.runAfterInteractions(cb);
  return { cancel: () => task.cancel() };
}

/**
 * Schedules FRC media wake after pager settle interactions drain.
 * `afterInteractions` is injectable so unit tests do not depend on RN.
 */
export function schedulePagerMediaWake(options: {
  run: () => void;
  afterInteractions?: AfterInteractions;
}): PagerMediaWakeHandle {
  let cancelled = false;
  const schedule = options.afterInteractions ?? defaultAfterInteractions;

  const task = schedule(() => {
    if (cancelled) return;
    options.run();
  });

  return {
    cancel: () => {
      cancelled = true;
      task.cancel();
    },
  };
}
