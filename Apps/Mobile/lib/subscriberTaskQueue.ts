export type QueuePauseReason = "drag" | "momentum" | "drawer";

/** Higher rank runs first; FIFO breaks ties within a rank. */
export type QueuePriority = "visible" | "near" | "background";

const PRIORITY_RANK: Record<QueuePriority, number> = {
  visible: 3,
  near: 2,
  background: 1,
};

export type QueueWorkerContext = {
  /** Aborted when the task is preempted by higher priority or its last subscriber leaves. */
  signal: AbortSignal;
  /** Call right before an uncancellable stage (e.g. native decode); disables preemption/abort. */
  markUncancellable: () => void;
  /** Register cleanup that runs after this attempt has settled, even when it was abandoned. */
  onSettled: (cleanup: () => void) => void;
};

export type QueueWorker<T> = (key: string, ctx: QueueWorkerContext) => Promise<T>;

/** Live subscription: leave the queue, or re-rank without leaving it. */
export type QueueSubscription = {
  unsubscribe: () => void;
  /** Re-rank this subscriber; the task follows the maximum of its subscribers. */
  setPriority: (priority: QueuePriority) => void;
};

type Subscriber<T> = {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  priority: QueuePriority;
};

/**
 * One attempt at running a task. Tasks outlive their runs: a preempted or
 * paused run is abandoned on the spot and the task waits for a fresh one, so
 * the outcome of a run has to be matched against the task's current
 * generation before it is allowed to speak for the task's subscribers.
 */
type TaskRun = {
  generation: number;
  controller: AbortController;
  uncancellable: boolean;
  /** A run holds one concurrency slot until it is abandoned or settles. */
  slotReleased: boolean;
  settledCleanups: (() => void)[];
};

type Task<T> = {
  key: string;
  seq: number;
  priority: QueuePriority;
  state: "queued" | "running";
  subscribers: Map<symbol, Subscriber<T>>;
  run: TaskRun | null;
};

export type SubscriberTaskQueueStats = {
  queued: number;
  running: number;
  subscribers: number;
  paused: boolean;
};

/**
 * Subscriber-aware queue for expensive native work with priority lanes.
 *
 * - Ordering: strict priority (`visible > near > background`), FIFO within a
 *   lane. A task's rank is the maximum over its *current* subscribers, so a
 *   row that fell out of the visible band stops holding a visible slot.
 * - Preemption: a higher-priority task preempts a running task that is still
 *   in its cancellable stage; the preempted run is abandoned and its task is
 *   requeued immediately, so the winner does not wait for the dead run to
 *   notice the abort. A task that has called `markUncancellable()` (native
 *   decode started) always runs to completion — at most one such decode can
 *   sit in front of a visible task.
 * - Queued tasks with no subscribers are discarded before starting. A running
 *   cancellable task whose last subscriber leaves is aborted but kept until it
 *   settles: if a subscriber arrives in the meantime (list row recycling), the
 *   task is requeued instead of failing the newcomer.
 */
export class SubscriberTaskQueue<T> {
  private readonly tasks = new Map<string, Task<T>>();
  private readonly pauseReasons = new Map<symbol, Set<QueuePauseReason>>();
  private running = 0;
  private seqCounter = 0;
  private generationCounter = 0;

  constructor(
    private readonly worker: QueueWorker<T>,
    private readonly concurrency = 1,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("SubscriberTaskQueue concurrency must be a positive integer");
    }
  }

  subscribe(
    key: string,
    resolve: (value: T) => void,
    reject: (error: unknown) => void = () => {},
    priority: QueuePriority = "visible",
  ): QueueSubscription {
    const existing = this.tasks.get(key);
    const task: Task<T> = existing ?? {
      key,
      seq: this.seqCounter++,
      priority,
      state: "queued",
      subscribers: new Map(),
      run: null,
    };
    if (!existing) this.tasks.set(key, task);

    const token = Symbol(key);
    task.subscribers.set(token, { resolve, reject, priority });
    this.refreshPriority(task);
    this.pump();

    let active = true;
    return {
      unsubscribe: () => {
        if (!active) return;
        active = false;
        if (this.tasks.get(key) !== task) return;
        task.subscribers.delete(token);
        if (task.subscribers.size > 0) {
          if (this.refreshPriority(task)) this.pump();
          return;
        }
        if (task.state === "queued") {
          this.tasks.delete(key);
          return;
        }
        // Running with nobody waiting: abort if still cancellable, else let it
        // finish. The task stays until its run settles so that a subscriber
        // arriving before then is picked up by `settle`.
        if (task.run && !task.run.uncancellable) task.run.controller.abort();
      },
      setPriority: (next: QueuePriority) => {
        if (!active) return;
        if (this.tasks.get(key) !== task) return;
        const subscriber = task.subscribers.get(token);
        if (!subscriber || subscriber.priority === next) return;
        subscriber.priority = next;
        if (this.refreshPriority(task)) this.pump();
      },
    };
  }

  /**
   * One-shot promise for a key. The subscriber can never leave, so the caller
   * waits for however long the queue takes (including across pauses); prefer
   * {@link subscribe} anywhere a consumer can go away.
   */
  request(key: string, priority: QueuePriority = "visible"): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.subscribe(key, resolve, reject, priority);
    });
  }

  setPaused(owner: symbol, reason: QueuePauseReason, paused: boolean): void {
    const wasPaused = this.isPaused();
    const reasons = this.pauseReasons.get(owner) ?? new Set<QueuePauseReason>();
    if (paused) {
      reasons.add(reason);
      this.pauseReasons.set(owner, reasons);
      // On the first pause, abort in-flight cancellable work and requeue it so
      // no new download runs during scroll; an already-started native decode
      // (uncancellable) is allowed to finish.
      if (!wasPaused) this.abortCancellableRunning();
      return;
    }
    reasons.delete(reason);
    if (reasons.size === 0) this.pauseReasons.delete(owner);
    if (!this.isPaused()) this.pump();
  }

  clearPauseOwner(owner: symbol): void {
    if (!this.pauseReasons.delete(owner)) return;
    if (!this.isPaused()) this.pump();
  }

  stats(): SubscriberTaskQueueStats {
    let queued = 0;
    let running = 0;
    let subscribers = 0;
    for (const task of this.tasks.values()) {
      if (task.state === "running") running += 1;
      else queued += 1;
      subscribers += task.subscribers.size;
    }
    return { queued, running, subscribers, paused: this.isPaused() };
  }

  isPaused(): boolean {
    return this.pauseReasons.size > 0;
  }

  /** Task rank = maximum over current subscribers; returns true when it moved. */
  private refreshPriority(task: Task<T>): boolean {
    let best: QueuePriority | null = null;
    for (const subscriber of task.subscribers.values()) {
      if (best === null || PRIORITY_RANK[subscriber.priority] > PRIORITY_RANK[best]) {
        best = subscriber.priority;
      }
    }
    // Keep the last rank while the task has no subscribers: it is about to be
    // dropped or about to gain one.
    if (best === null || best === task.priority) return false;
    task.priority = best;
    return true;
  }

  private abortCancellableRunning(): void {
    for (const task of this.runningTasks()) {
      if (task.run?.uncancellable) continue;
      this.abandonRun(task);
    }
  }

  private bestQueued(): Task<T> | null {
    let best: Task<T> | null = null;
    for (const task of this.tasks.values()) {
      if (task.state !== "queued" || task.subscribers.size === 0) continue;
      if (
        best === null ||
        PRIORITY_RANK[task.priority] > PRIORITY_RANK[best.priority] ||
        (PRIORITY_RANK[task.priority] === PRIORITY_RANK[best.priority] && task.seq < best.seq)
      ) {
        best = task;
      }
    }
    return best;
  }

  private runningTasks(): Task<T>[] {
    return [...this.tasks.values()].filter((t) => t.state === "running");
  }

  /** Lowest-ranked cancellable runner that `priority` is allowed to displace. */
  private preemptableRunner(priority: QueuePriority): Task<T> | null {
    for (const task of this.runningTasks()) {
      if (!task.run || task.run.uncancellable) continue;
      if (PRIORITY_RANK[priority] > PRIORITY_RANK[task.priority]) return task;
    }
    return null;
  }

  private pump(): void {
    if (this.isPaused()) return;

    // Drop queued tasks that lost all subscribers before starting.
    for (const task of this.tasks.values()) {
      if (task.state === "queued" && task.subscribers.size === 0) this.tasks.delete(task.key);
    }

    for (;;) {
      while (this.running < this.concurrency) {
        const next = this.bestQueued();
        if (!next) return;
        this.start(next);
      }

      // At capacity: displace a cancellable lower-priority runner. Each pass
      // replaces a runner with a strictly higher-ranked task, so this ends.
      const next = this.bestQueued();
      if (!next) return;
      const victim = this.preemptableRunner(next.priority);
      if (!victim) return;
      this.abandonRun(victim);
    }
  }

  private start(task: Task<T>): void {
    const run: TaskRun = {
      generation: ++this.generationCounter,
      controller: new AbortController(),
      uncancellable: false,
      slotReleased: false,
      settledCleanups: [],
    };
    task.state = "running";
    task.run = run;
    this.running += 1;

    const ctx: QueueWorkerContext = {
      signal: run.controller.signal,
      // Scoped to this run: a late call from an abandoned run cannot pin the
      // task's current run.
      markUncancellable: () => {
        run.uncancellable = true;
      },
      onSettled: (cleanup) => {
        run.settledCleanups.push(cleanup);
      },
    };

    this.worker(task.key, ctx).then(
      (value) => this.settle(task, run, { value }),
      (error) => this.settle(task, run, { error }),
    );
  }

  /**
   * Detach a dead run and put its task back in the queue. The slot is freed
   * right away — the run has been told to stop, and whatever it still reports
   * is discarded by the generation check in {@link settle}.
   */
  private abandonRun(task: Task<T>): void {
    const run = task.run;
    if (!run) return;
    task.run = null;
    task.state = "queued";
    this.releaseSlot(run);
    if (task.subscribers.size === 0) this.tasks.delete(task.key);
    run.controller.abort();
  }

  private releaseSlot(run: TaskRun): void {
    if (run.slotReleased) return;
    run.slotReleased = true;
    this.running -= 1;
  }

  private settle(task: Task<T>, run: TaskRun, outcome: { value: T } | { error: unknown }): void {
    this.releaseSlot(run);
    try {
      // Outcome of an abandoned run (preempted, paused, or belonging to a task
      // that was already dropped): it speaks for no one, the current run owns
      // the subscribers now.
      if (task.run?.generation !== run.generation || this.tasks.get(task.key) !== task) {
        this.pump();
        return;
      }
      task.run = null;

      if ("error" in outcome && run.controller.signal.aborted && task.subscribers.size > 0) {
        // Aborted because the last subscriber left, but someone subscribed again
        // before the abort landed (row recycling). The work is still wanted:
        // requeue instead of failing the newcomer.
        task.state = "queued";
        this.pump();
        return;
      }

      this.tasks.delete(task.key);
      if ("value" in outcome) {
        for (const subscriber of task.subscribers.values()) subscriber.resolve(outcome.value);
      } else {
        for (const subscriber of task.subscribers.values()) subscriber.reject(outcome.error);
      }
      this.pump();
    } finally {
      for (const cleanup of run.settledCleanups) cleanup();
    }
  }
}
