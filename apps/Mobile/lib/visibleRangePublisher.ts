/**
 * Coalesces `visibleRange` publications to a bounded cadence during
 * continuous scroll, instead of a debounce that silently keeps postponing
 * while events keep arriving.
 *
 * The first `update()` after an idle period publishes immediately (leading
 * edge) and opens a window; further updates inside that window only replace
 * a pending value, which fires once the window elapses (trailing edge) and
 * immediately opens the next window. Under a steady stream of viewability
 * events this settles into a publish roughly every `windowMs`, and the
 * latest value is never dropped — it is only ever delayed to the next edge.
 *
 * `flush()` is the settle path: it bypasses the window entirely (cancelling
 * any pending trailing publish) so the final position is never held behind a
 * timer a stopped gesture will not refill.
 */

export type VisibleIndexRange = { min: number | null; max: number | null };

export type VisibleRangePublisherOptions = {
  publish: (range: VisibleIndexRange) => void;
  windowMs?: number;
  schedule?: (run: () => void, delayMs: number) => () => void;
};

export type VisibleRangePublisher = {
  /** Report a range observed during active scroll; coalesced to `windowMs`. */
  update: (range: VisibleIndexRange) => void;
  /** Publish immediately, bypassing and resetting the coalescing window. */
  flush: (range: VisibleIndexRange) => void;
  /** Cancel any pending trailing publish without firing it. */
  dispose: () => void;
};

export const DEFAULT_VISIBLE_RANGE_WINDOW_MS = 100;

export function createVisibleRangePublisher(
  options: VisibleRangePublisherOptions,
): VisibleRangePublisher {
  const windowMs = options.windowMs ?? DEFAULT_VISIBLE_RANGE_WINDOW_MS;
  const schedule =
    options.schedule ??
    ((run: () => void, delayMs: number) => {
      const id = setTimeout(run, delayMs);
      return () => clearTimeout(id);
    });

  let cancelWindow: (() => void) | null = null;
  let pending: VisibleIndexRange | null = null;

  const openWindow = (): void => {
    cancelWindow = schedule(() => {
      cancelWindow = null;
      if (pending === null) return;
      const range = pending;
      pending = null;
      options.publish(range);
      openWindow();
    }, windowMs);
  };

  const update = (range: VisibleIndexRange): void => {
    if (cancelWindow === null) {
      options.publish(range);
      openWindow();
      return;
    }
    pending = range;
  };

  const flush = (range: VisibleIndexRange): void => {
    cancelWindow?.();
    cancelWindow = null;
    pending = null;
    options.publish(range);
  };

  const dispose = (): void => {
    cancelWindow?.();
    cancelWindow = null;
    pending = null;
  };

  return { update, flush, dispose };
}
