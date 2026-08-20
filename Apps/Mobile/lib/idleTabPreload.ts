import { setScrollActivity } from "@/lib/scrollActivity";

/**
 * Generic idle/prefetch machine for tab preloaders, plus the serialize lock
 * that keeps two prefetches from mounting their Fabric trees in one frame.
 *
 * Idle here is the scroll-activity registry (list drag/momentum, pager
 * touch/pager/strip, tab-switch overlay, and inflight prefetch `mount`),
 * never `InteractionManager`: RNGH/Reanimated motion is invisible to it.
 * This module stays free of react-native / expo-router imports so the
 * machine is unit-testable.
 */

/** Quiet window after the last `settled: true` before an Android UI prefetch. */
export const IDLE_TAB_PRELOAD_QUIET_MS = 400;

/** Minimum delay after Messages prefetch-or-skip before Notifications may mount. */
export const IDLE_TAB_PRELOAD_SERIAL_GAP_MS = 120;

export type IdleTabPreloadGate = {
  platform: string; // "android" | "ios" | ...
  appActive: boolean;
  dataSuccess: boolean;
  scrollSettled: boolean;
  quietForMs: number;
  tabActive: boolean;
  alreadyPrefetched: boolean;
  /**
   * Predecessor barrier (Messages skip/prefetch). Messages passes true;
   * Notifications fills this from `getMessagesIdlePreloadCompleteAt`.
   */
  messagesComplete: boolean;
  /** Elapsed since Messages prefetch-or-skip. Messages passes ≥ serial gap. */
  messagesCompleteForMs: number;
};

export function canPrefetchIdleTab(gate: IdleTabPreloadGate): boolean {
  return (
    gate.platform === "android" &&
    gate.appActive &&
    gate.dataSuccess &&
    gate.scrollSettled &&
    gate.quietForMs >= IDLE_TAB_PRELOAD_QUIET_MS &&
    gate.messagesComplete &&
    gate.messagesCompleteForMs >= IDLE_TAB_PRELOAD_SERIAL_GAP_MS &&
    !gate.tabActive &&
    !gate.alreadyPrefetched
  );
}

/**
 * Re-check at `router.prefetch` fire (after the serial gap), not only at enqueue.
 * Same gates as `canPrefetchIdleTab` plus `cancelled` — Android and quiet ≥ 400
 * must still hold when the serializer actually starts the mount.
 */
export type IdleTabPrefetchFireGate = {
  cancelled: boolean;
  platform: string;
  appActive: boolean;
  dataSuccess: boolean;
  scrollSettled: boolean;
  quietForMs: number;
  tabActive: boolean;
  messagesComplete: boolean;
  messagesCompleteForMs: number;
};

export function canRunQueuedIdleTabPrefetch(gate: IdleTabPrefetchFireGate): boolean {
  return (
    !gate.cancelled &&
    canPrefetchIdleTab({
      platform: gate.platform,
      appActive: gate.appActive,
      dataSuccess: gate.dataSuccess,
      scrollSettled: gate.scrollSettled,
      quietForMs: gate.quietForMs,
      tabActive: gate.tabActive,
      alreadyPrefetched: false,
      messagesComplete: gate.messagesComplete,
      messagesCompleteForMs: gate.messagesCompleteForMs,
    })
  );
}

export type IdleTabPreloadSnapshot = {
  platform: string;
  appActive: boolean;
  dataSuccess: boolean;
  tabActive: boolean;
  messagesComplete: boolean;
  messagesCompleteForMs: number;
};

export type IdleTabPreloadController = {
  evaluate: () => void;
  onScrollSettled: (settled: boolean) => void;
  onAppActive: (active: boolean) => void;
  dispose: () => void;
  hasPendingTimer: () => boolean;
  hasPrefetched: () => boolean;
  /** Clear an enqueue latch so a busy-aborted job can be retried after quiet. Skip (tab active) stays latched. */
  unlatch: () => void;
  /** Elapsed since the current settled stretch started; 0 if scroll is busy. */
  quietForMs: () => number;
};

/**
 * Testable idle/prefetch machine. A React hook only binds RN/query to this.
 * Prefetch is not latched until `canPrefetchIdleTab` is true at fire time and
 * scroll is still settled.
 */
export function createIdleTabPreloadController(opts: {
  quietMs?: number;
  now?: () => number;
  isScrollSettled: () => boolean;
  getSnapshot: () => IdleTabPreloadSnapshot;
  prefetch: () => void;
  /** Messages skip (tab already active) — still counts as “prefetch or skip”. */
  onSkip?: () => void;
}): IdleTabPreloadController {
  const quietMs = opts.quietMs ?? IDLE_TAB_PRELOAD_QUIET_MS;
  const now = opts.now ?? Date.now;
  let alreadyPrefetched = false;
  let skipLatched = false;
  let lastSettledAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const cancelTimer = () => {
    if (timer == null) return;
    clearTimeout(timer);
    timer = null;
  };

  const evaluate = () => {
    if (disposed || alreadyPrefetched) {
      cancelTimer();
      return;
    }

    const snapshot = opts.getSnapshot();
    if (snapshot.tabActive) {
      alreadyPrefetched = true;
      skipLatched = true;
      cancelTimer();
      opts.onSkip?.();
      return;
    }

    if (!opts.isScrollSettled()) {
      lastSettledAt = null;
      cancelTimer();
      return;
    }
    if (lastSettledAt == null) {
      lastSettledAt = now();
    }

    const gate: IdleTabPreloadGate = {
      platform: snapshot.platform,
      appActive: snapshot.appActive,
      dataSuccess: snapshot.dataSuccess,
      scrollSettled: true,
      quietForMs: now() - lastSettledAt,
      tabActive: snapshot.tabActive,
      alreadyPrefetched,
      messagesComplete: snapshot.messagesComplete,
      messagesCompleteForMs: snapshot.messagesCompleteForMs,
    };

    if (canPrefetchIdleTab(gate)) {
      alreadyPrefetched = true;
      cancelTimer();
      opts.prefetch();
      return;
    }

    const readyIfTimersElapsed =
      snapshot.messagesComplete &&
      canPrefetchIdleTab({
        ...gate,
        quietForMs: quietMs,
        messagesCompleteForMs: Math.max(
          gate.messagesCompleteForMs,
          IDLE_TAB_PRELOAD_SERIAL_GAP_MS,
        ),
      });
    if (!readyIfTimersElapsed) {
      cancelTimer();
      return;
    }

    const wait = Math.max(
      quietMs - gate.quietForMs,
      IDLE_TAB_PRELOAD_SERIAL_GAP_MS - gate.messagesCompleteForMs,
      0,
    );
    cancelTimer();
    timer = setTimeout(() => {
      timer = null;
      evaluate();
    }, wait);
  };

  return {
    evaluate,
    onScrollSettled(settled) {
      if (settled) {
        lastSettledAt = now();
      } else {
        lastSettledAt = null;
        cancelTimer();
      }
      evaluate();
    },
    onAppActive(active) {
      if (!active) {
        lastSettledAt = null;
        cancelTimer();
        return;
      }
      lastSettledAt = opts.isScrollSettled() ? now() : null;
      evaluate();
    },
    dispose() {
      disposed = true;
      cancelTimer();
    },
    hasPendingTimer: () => timer != null,
    hasPrefetched: () => alreadyPrefetched,
    unlatch() {
      if (disposed || skipLatched) return;
      alreadyPrefetched = false;
    },
    quietForMs() {
      if (lastSettledAt == null || !opts.isScrollSettled()) return 0;
      return now() - lastSettledAt;
    },
  };
}

export type IdleTabPrefetchEnqueueOpts = {
  /** Re-checked at fire time (after the serial gap). Default: always run. */
  shouldRun?: () => boolean;
  onAbort?: () => void;
};

export type IdleTabPreloadSerializer = {
  enqueue(
    owner: symbol,
    job: (release: () => void) => void,
    opts?: IdleTabPrefetchEnqueueOpts,
  ): void;
  /** Idempotent. No-op if `owner` is not the inflight owner. Also drops queued jobs for this owner. */
  release(owner: symbol): void;
  /** Drop a job that has not started. Does not release an inflight mount or stamp the serial gap. */
  dropQueued(owner: symbol): void;
  isInFlight(): boolean;
  isOwnerInFlight(owner: symbol): boolean;
  isOwnerQueuedOrInFlight(owner: symbol): boolean;
  dispose(): void;
};

type SerializerEntry = {
  owner: symbol;
  job: (release: () => void) => void;
  shouldRun?: () => boolean;
  onAbort?: () => void;
};

/**
 * One prefetch at a time: a second job waits for the running one to release
 * its mount frame plus `gapMs`, so two Fabric mounts never land together.
 * `shouldRun` is re-checked after that gap (busy aborts; the controller unlatches).
 */
export function createIdleTabPreloadSerializer(
  opts: {
    gapMs?: number;
    now?: () => number;
    /** Shared singleton publishes `mount` onto scrollActivity so other idle Fabric work waits. */
    onInFlight?: (owner: symbol, inflight: boolean) => void;
  } = {},
): IdleTabPreloadSerializer {
  const gapMs = opts.gapMs ?? IDLE_TAB_PRELOAD_SERIAL_GAP_MS;
  const now = opts.now ?? Date.now;
  let queue: SerializerEntry[] = [];
  let inflight: symbol | null = null;
  let lastReleasedAt: number | null = null;
  let gapTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function clearGapTimer(): void {
    if (gapTimer == null) return;
    clearTimeout(gapTimer);
    gapTimer = null;
  }

  function abortHeadIfNeeded(): void {
    while (queue.length > 0) {
      const head = queue[0];
      if (!head.shouldRun || head.shouldRun()) return;
      queue.shift();
      head.onAbort?.();
    }
  }

  function startNext(): void {
    if (disposed || inflight != null) return;
    abortHeadIfNeeded();
    if (queue.length === 0) return;

    if (lastReleasedAt != null) {
      const waited = now() - lastReleasedAt;
      if (waited < gapMs) {
        if (gapTimer == null) {
          gapTimer = setTimeout(() => {
            gapTimer = null;
            startNext();
          }, gapMs - waited);
        }
        return;
      }
    }

    abortHeadIfNeeded();
    if (queue.length === 0) return;

    clearGapTimer();
    const next = queue.shift();
    if (!next) return;
    inflight = next.owner;
    opts.onInFlight?.(next.owner, true);
    let jobReleased = false;
    next.job(() => {
      if (jobReleased) return;
      jobReleased = true;
      release(next.owner);
    });
  }

  function release(owner: symbol): void {
    if (disposed) return;
    queue = queue.filter((entry) => entry.owner !== owner);
    if (inflight !== owner) return;
    opts.onInFlight?.(owner, false);
    inflight = null;
    lastReleasedAt = now();
    clearGapTimer();
    startNext();
  }

  function dropQueued(owner: symbol): void {
    if (disposed) return;
    const wasHead = queue[0]?.owner === owner;
    const before = queue.length;
    queue = queue.filter((entry) => entry.owner !== owner);
    if (queue.length === before) return;
    if (wasHead) clearGapTimer();
    startNext();
  }

  return {
    enqueue(owner, job, enqueueOpts) {
      if (disposed) return;
      queue.push({
        owner,
        job,
        shouldRun: enqueueOpts?.shouldRun,
        onAbort: enqueueOpts?.onAbort,
      });
      startNext();
    },
    release,
    dropQueued,
    isInFlight: () => inflight != null || queue.length > 0,
    isOwnerInFlight: (owner) => inflight === owner,
    isOwnerQueuedOrInFlight: (owner) =>
      inflight === owner || queue.some((entry) => entry.owner === owner),
    dispose() {
      disposed = true;
      clearGapTimer();
      queue = [];
      if (inflight != null) opts.onInFlight?.(inflight, false);
      inflight = null;
      lastReleasedAt = null;
    },
  };
}

export function abortQueuedIdleTabPrefetch(
  serializer: IdleTabPreloadSerializer,
  owner: symbol,
  unlatch: () => void,
): void {
  serializer.dropQueued(owner);
  if (!serializer.isOwnerInFlight(owner)) unlatch();
}

let sharedSerializer: IdleTabPreloadSerializer | null = null;
let messagesEpoch = 0;
let messagesCompleteEpoch = -1;
let messagesCompleteAt: number | null = null;
const messagesCompleteListeners = new Set<() => void>();

function notifyMessagesIdlePreloadListeners(): void {
  for (const listener of messagesCompleteListeners) listener();
}

/** Process-wide lock shared by every tab preload hook. */
export function getIdleTabPreloadSerializer(): IdleTabPreloadSerializer {
  sharedSerializer ??= createIdleTabPreloadSerializer({
    onInFlight: (owner, inflight) => setScrollActivity(owner, "mount", inflight),
  });
  return sharedSerializer;
}

/**
 * Messages-first barrier for Notifications (explicit: `notificationsTabPreload`
 * is the only subscriber). Start a Messages preload session. Invalidates a
 * previous skip/prefetch stamp so a remounted Notifications hook cannot race
 * ahead of this instance.
 */
export function beginMessagesIdlePreloadEpoch(): void {
  messagesEpoch += 1;
  messagesCompleteAt = null;
  notifyMessagesIdlePreloadListeners();
}

/** Stamp “Messages prefetch or skip finished” for the current epoch. */
export function markMessagesIdlePreloadComplete(at: number = Date.now()): void {
  if (messagesCompleteEpoch === messagesEpoch && messagesCompleteAt != null) return;
  messagesCompleteEpoch = messagesEpoch;
  messagesCompleteAt = at;
  notifyMessagesIdlePreloadListeners();
}

export function getMessagesIdlePreloadCompleteAt(): number | null {
  if (messagesCompleteEpoch !== messagesEpoch) return null;
  return messagesCompleteAt;
}

export function subscribeMessagesIdlePreloadComplete(listener: () => void): () => void {
  messagesCompleteListeners.add(listener);
  return () => {
    messagesCompleteListeners.delete(listener);
  };
}

/** test-only */
export function __resetIdleTabPreloadSerializer(): void {
  sharedSerializer?.dispose();
  sharedSerializer = null;
  messagesEpoch = 0;
  messagesCompleteEpoch = -1;
  messagesCompleteAt = null;
  messagesCompleteListeners.clear();
}
