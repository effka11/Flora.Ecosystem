/**
 * JS-observable interaction phase for idle work (prefetch, coalesce, FRC).
 *
 * List drag/momentum comes from collapsible-header / FlashList callbacks
 * (not per `onScroll`). Pager busy-guard (touch + pager + strip) and the
 * tab-switch overlay (`route`) publish here too, so tab preload does not
 * Fabric-mount during RNGH/Reanimated motion that `InteractionManager`
 * cannot see. An inflight idle `router.prefetch` or a focused Settings
 * section commit holds `mount` so those Fabric commits do not share a
 * frame with each other.
 *
 * "Settled" means no owner reports an active reason.
 */

export type ScrollActivityReason =
  | "drag"
  | "momentum"
  | "touch"
  | "pager"
  | "strip"
  | "route"
  | "mount";

export type PagerBusyActivity = {
  touch: boolean;
  pager: boolean;
  strip: boolean;
};

type Listener = (settled: boolean) => void;

const activeReasons = new Map<symbol, Set<ScrollActivityReason>>();
const listeners = new Set<Listener>();

function computeSettled(): boolean {
  for (const reasons of activeReasons.values()) {
    if (reasons.size > 0) return false;
  }
  return true;
}

let settled = true;

function refresh(): void {
  const next = computeSettled();
  if (next === settled) return;
  settled = next;
  for (const listener of listeners) listener(settled);
}

function applyReason(owner: symbol, reason: ScrollActivityReason, active: boolean): void {
  const reasons = activeReasons.get(owner) ?? new Set<ScrollActivityReason>();
  if (active) {
    reasons.add(reason);
    activeReasons.set(owner, reasons);
    return;
  }
  reasons.delete(reason);
  if (reasons.size === 0) activeReasons.delete(owner);
}

export function setScrollActivity(
  owner: symbol,
  reason: ScrollActivityReason,
  active: boolean,
): void {
  applyReason(owner, reason, active);
  refresh();
}

export function clearScrollActivityOwner(owner: symbol): void {
  if (activeReasons.delete(owner)) refresh();
}

/**
 * Map a pager busy-guard snapshot onto the shared idle registry in one
 * refresh, so swapping touch→pager in the same tick cannot flap settled.
 */
export function setPagerBusyActivity(owner: symbol, busy: PagerBusyActivity): void {
  applyReason(owner, "touch", busy.touch);
  applyReason(owner, "pager", busy.pager);
  applyReason(owner, "strip", busy.strip);
  refresh();
}

export function isScrollSettled(): boolean {
  return settled;
}

export type IdleMountHold = {
  /** Hold `mount` for the duration of `commit` plus `scheduleClear`. Nested runs share one reason. */
  run: (commit: () => void) => void;
  /** Drop the hold immediately (blur / unmount). In-flight clears become no-ops. */
  reset: () => void;
  dispose: () => void;
};

/**
 * Ref-counted `mount` hold so a Fabric commit can occupy idle-busy until
 * the next frame(s), without flapping when two commits overlap.
 */
export function createIdleMountHold(
  owner: symbol,
  scheduleClear: (release: () => void) => void,
): IdleMountHold {
  let depth = 0;
  let gen = 0;
  let disposed = false;

  return {
    run(commit) {
      if (disposed) {
        commit();
        return;
      }
      const current = gen;
      depth += 1;
      setScrollActivity(owner, "mount", true);
      commit();
      scheduleClear(() => {
        if (disposed || current !== gen) return;
        depth = Math.max(0, depth - 1);
        if (depth === 0) setScrollActivity(owner, "mount", false);
      });
    },
    reset() {
      if (disposed) return;
      gen += 1;
      depth = 0;
      setScrollActivity(owner, "mount", false);
    },
    dispose() {
      disposed = true;
      depth = 0;
      setScrollActivity(owner, "mount", false);
    },
  };
}

/**
 * Subscribe to settled-state transitions. The listener fires only when the
 * aggregate settled state flips, receiving the new value.
 */
export function subscribeScrollSettled(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only reset. */
export function __resetScrollActivity(): void {
  activeReasons.clear();
  listeners.clear();
  settled = true;
}
