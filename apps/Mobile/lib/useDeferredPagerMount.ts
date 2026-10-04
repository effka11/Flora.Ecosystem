import { useCallback, useEffect, useRef, useState } from "react";
import {
  schedulePagerMediaWake,
  type PagerMediaWakeHandle,
} from "@/lib/feedPagerMediaWake";
import {
  isScrollSettled,
  subscribeScrollSettled,
} from "@/lib/scrollActivity";
import {
  mountedSetsEqual,
  nextMountCandidate,
  reconcileMountedIds,
} from "@/lib/settingsMountedSections";

/** Как settings: не греть дальнюю страницу сразу после жеста. */
const WARMUP_QUIET_MS = 400;
/** Зазор между шагами idle-прогрева. */
const WARMUP_STEP_GAP_MS = 120;

/** After hidden→focused, wait remaining quiet ms before expanding pager neighbors. */
export function neighborExpandDeferMs(
  requireQuiet: boolean,
  quietForMs: number,
  quietMs = WARMUP_QUIET_MS,
): number | null {
  if (!requireQuiet) return null;
  if (quietForMs >= quietMs) return null;
  return quietMs - quietForMs;
}

/**
 * Sticky-окно маунта страниц пейджера: active сразу, соседи после settle,
 * остальные по одной в тишину. Не расширять mid-pan (RNGH busy-guard).
 *
 * `allowIdleWarmup` (default true — People): соседи + дальние страницы в тишину.
 * false — только активная страница (preload Messages, пока вкладка без фокуса).
 */
export function useDeferredPagerMount<T extends string>(
  pageIds: readonly T[],
  initialIndex = 0,
  allowIdleWarmup = true,
): {
  mountedIds: ReadonlySet<T>;
  setBusy: (busy: boolean) => void;
  ensureMounted: (id: T) => boolean;
  onCommitted: (index: number) => void;
} {
  const [mountedIds, setMountedIds] = useState<ReadonlySet<T>>(() => {
    const id = pageIds[Math.max(0, Math.min(initialIndex, pageIds.length - 1))];
    return new Set<T>(id == null ? [] : [id]);
  });
  const mountedIdsRef = useRef(mountedIds);
  mountedIdsRef.current = mountedIds;
  const pageIdsRef = useRef(pageIds);
  pageIdsRef.current = pageIds;
  const allowIdleWarmupRef = useRef(allowIdleWarmup);
  allowIdleWarmupRef.current = allowIdleWarmup;
  const prevAllowIdleWarmupRef = useRef(allowIdleWarmup);
  const activeIndexRef = useRef(initialIndex);

  const mountWakeRef = useRef<PagerMediaWakeHandle | null>(null);
  const warmupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);
  const pendingIndexRef = useRef<number | null>(null);
  const lastInteractionAtRef = useRef(Date.now());
  const quietNeighborsOnceRef = useRef(false);
  const scheduleAdvanceRef = useRef<(activeIndex: number) => void>(() => {});

  const cancelWake = useCallback(() => {
    mountWakeRef.current?.cancel();
    mountWakeRef.current = null;
    if (warmupTimerRef.current != null) {
      clearTimeout(warmupTimerRef.current);
      warmupTimerRef.current = null;
    }
  }, []);

  const scheduleAdvance = useCallback(
    (activeIndex: number) => {
      activeIndexRef.current = activeIndex;
      cancelWake();
      pendingIndexRef.current = null;
      mountWakeRef.current = schedulePagerMediaWake({
        run: () => {
          mountWakeRef.current = null;
          if (busyRef.current) {
            pendingIndexRef.current = activeIndex;
            return;
          }
          const expandNeighbors = allowIdleWarmupRef.current;
          if (expandNeighbors && !isScrollSettled()) {
            pendingIndexRef.current = activeIndex;
            return;
          }
          const neighborWait = neighborExpandDeferMs(
            expandNeighbors && quietNeighborsOnceRef.current,
            Date.now() - lastInteractionAtRef.current,
          );
          if (neighborWait != null) {
            warmupTimerRef.current = setTimeout(() => {
              warmupTimerRef.current = null;
              scheduleAdvanceRef.current(activeIndex);
            }, neighborWait);
            return;
          }
          if (expandNeighbors) {
            quietNeighborsOnceRef.current = false;
          }
          const ids = pageIdsRef.current;
          const withNeighbors = reconcileMountedIds({
            prev: mountedIdsRef.current,
            visibleIds: ids,
            activeIndex,
            expandNeighbors,
          });
          if (!mountedSetsEqual(mountedIdsRef.current, withNeighbors)) {
            mountedIdsRef.current = withNeighbors;
            setMountedIds(withNeighbors);
            if (expandNeighbors) {
              scheduleAdvanceRef.current(activeIndex);
            }
            return;
          }
          if (!expandNeighbors) return;
          const candidate = nextMountCandidate(ids, mountedIdsRef.current, activeIndex);
          if (candidate == null) return;
          const quietFor = Date.now() - lastInteractionAtRef.current;
          if (quietFor < WARMUP_QUIET_MS) {
            warmupTimerRef.current = setTimeout(() => {
              warmupTimerRef.current = null;
              scheduleAdvanceRef.current(activeIndex);
            }, WARMUP_QUIET_MS - quietFor);
            return;
          }
          const grown = new Set(mountedIdsRef.current);
          grown.add(candidate);
          mountedIdsRef.current = grown;
          setMountedIds(grown);
          warmupTimerRef.current = setTimeout(() => {
            warmupTimerRef.current = null;
            scheduleAdvanceRef.current(activeIndex);
          }, WARMUP_STEP_GAP_MS);
        },
      });
    },
    [cancelWake],
  );
  scheduleAdvanceRef.current = scheduleAdvance;

  const flushIfIdle = useCallback(() => {
    if (busyRef.current) return;
    const pending = pendingIndexRef.current;
    if (pending == null) return;
    scheduleAdvance(pending);
  }, [scheduleAdvance]);

  const setBusy = useCallback(
    (busy: boolean) => {
      lastInteractionAtRef.current = Date.now();
      busyRef.current = busy;
      if (!busy) flushIfIdle();
    },
    [flushIfIdle],
  );

  const ensureMounted = useCallback((id: T) => {
    if (mountedIdsRef.current.has(id)) return false;
    const next = new Set(mountedIdsRef.current);
    next.add(id);
    mountedIdsRef.current = next;
    setMountedIds(next);
    return true;
  }, []);

  const onCommitted = useCallback(
    (index: number) => {
      lastInteractionAtRef.current = Date.now();
      scheduleAdvance(index);
    },
    [scheduleAdvance],
  );

  useEffect(() => {
    scheduleAdvance(initialIndex);
    return cancelWake;
  }, [cancelWake, initialIndex, scheduleAdvance]);

  useEffect(() => {
    const prev = prevAllowIdleWarmupRef.current;
    prevAllowIdleWarmupRef.current = allowIdleWarmup;
    if (!prev && allowIdleWarmup) {
      quietNeighborsOnceRef.current = true;
      lastInteractionAtRef.current = Date.now();
      scheduleAdvance(activeIndexRef.current);
    }
  }, [allowIdleWarmup, scheduleAdvance]);

  useEffect(() => {
    return subscribeScrollSettled((settled) => {
      if (settled) flushIfIdle();
    });
  }, [flushIfIdle]);

  return { mountedIds, setBusy, ensureMounted, onCommitted };
}
