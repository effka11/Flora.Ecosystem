/**
 * JS-observable scroll phase for the feed.
 *
 * The collapsible header already emits stable JS callbacks on drag/momentum
 * begin/end (not per `onScroll`). Those callbacks drive this ref-counted
 * registry so that view persistence and page prefetch can defer their work
 * until the list is settled, without adding a `runOnJS` hop to every scroll
 * event.
 *
 * "Settled" means no owner reports an active drag or momentum phase.
 */

export type ScrollActivityReason = "drag" | "momentum";

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

export function setScrollActivity(
  owner: symbol,
  reason: ScrollActivityReason,
  active: boolean,
): void {
  const reasons = activeReasons.get(owner) ?? new Set<ScrollActivityReason>();
  if (active) {
    reasons.add(reason);
    activeReasons.set(owner, reasons);
  } else {
    reasons.delete(reason);
    if (reasons.size === 0) activeReasons.delete(owner);
  }
  refresh();
}

export function clearScrollActivityOwner(owner: symbol): void {
  if (activeReasons.delete(owner)) refresh();
}

export function isScrollSettled(): boolean {
  return settled;
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
