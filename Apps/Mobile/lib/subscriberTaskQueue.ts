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
};

export type QueueWorker<T> = (key: string, ctx: QueueWorkerContext) => Promise<T>;

type Subscriber<T> = {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type Task<T> = {
  key: string;
  seq: number;
  priority: QueuePriority;
  state: "queued" | "running";
  subscribers: Map<symbol, Subscriber<T>>;
  controller?: AbortController;
  uncancellable: boolean;
  /** Requeue instead of rejecting when the abort was a preemption. */
  requeueOnAbort: boolean;
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
 * - Ordering: strict priority (`visible > near > background`), FIFO within a lane.
 * - Preemption: a higher-priority task preempts a running task that is still in
 *   its cancellable stage; the preempted task is requeued. A task that has
 *   called `markUncancellable()` (native decode started) always runs to
 *   completion — at most one such decode can sit in front of a visible task.
 * - Queued tasks with no subscribers are discarded before starting; a running
 *   cancellable task whose last subscriber leaves is aborted and dropped.
 */
export class SubscriberTaskQueue<T> {
  private readonly tasks = new Map<string, Task<T>>();
  private readonly pauseReasons = new Map<symbol, Set<QueuePauseReason>>();
  private running = 0;
  private seqCounter = 0;

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
  ): () => void {
    let task = this.tasks.get(key);
    if (!task) {
      task = {
        key,
        seq: this.seqCounter++,
        priority,
        state: "queued",
        subscribers: new Map(),
        uncancellable: false,
        requeueOnAbort: false,
      };
      this.tasks.set(key, task);
    } else if (PRIORITY_RANK[priority] > PRIORITY_RANK[task.priority]) {
      // Promote an existing task to the higher requested priority.
      task.priority = priority;
    }

    const token = Symbol(key);
    task.subscribers.set(token, { resolve, reject });
    this.pump();

    return () => {
      const current = this.tasks.get(key);
      if (!current) return;
      current.subscribers.delete(token);
      if (current.subscribers.size > 0) return;
      if (current.state === "queued") {
        this.tasks.delete(key);
        return;
      }
      // Running with no subscribers: abort if still cancellable, else let it finish.
      if (!current.uncancellable && current.controller) {
        current.requeueOnAbort = false;
        current.controller.abort();
      }
    };
  }

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

  private isPaused(): boolean {
    return this.pauseReasons.size > 0;
  }

  private abortCancellableRunning(): void {
    for (const task of this.runningTasks()) {
      if (task.uncancellable) continue;
      task.requeueOnAbort = true;
      task.controller?.abort();
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

  private pump(): void {
    if (this.isPaused()) return;

    // Drop queued tasks that lost all subscribers before starting.
    for (const task of this.tasks.values()) {
      if (task.state === "queued" && task.subscribers.size === 0) this.tasks.delete(task.key);
    }

    while (this.running < this.concurrency) {
      const next = this.bestQueued();
      if (!next) return;
      this.start(next);
    }

    // At capacity: consider preempting a cancellable lower-priority runner.
    const next = this.bestQueued();
    if (!next) return;
    for (const runner of this.runningTasks()) {
      if (runner.uncancellable || runner.requeueOnAbort) continue;
      if (PRIORITY_RANK[next.priority] > PRIORITY_RANK[runner.priority]) {
        runner.requeueOnAbort = true;
        runner.controller?.abort();
        return; // resumes via the runner's settle handler
      }
    }
  }

  private start(task: Task<T>): void {
    task.state = "running";
    task.uncancellable = false;
    task.requeueOnAbort = false;
    const controller = new AbortController();
    task.controller = controller;
    this.running += 1;

    const ctx: QueueWorkerContext = {
      signal: controller.signal,
      markUncancellable: () => {
        task.uncancellable = true;
      },
    };

    this.worker(task.key, ctx).then(
      (value) => this.settle(task, { value }),
      (error) => this.settle(task, { error }),
    );
  }

  private settle(task: Task<T>, outcome: { value: T } | { error: unknown }): void {
    // Preemption: requeue without notifying subscribers.
    if ("error" in outcome && task.requeueOnAbort) {
      task.state = "queued";
      task.controller = undefined;
      task.uncancellable = false;
      task.requeueOnAbort = false;
      this.running -= 1;
      this.pump();
      return;
    }

    this.tasks.delete(task.key);
    this.running -= 1;
    if ("value" in outcome) {
      for (const subscriber of task.subscribers.values()) subscriber.resolve(outcome.value);
    } else {
      for (const subscriber of task.subscribers.values()) subscriber.reject(outcome.error);
    }
    this.pump();
  }
}
