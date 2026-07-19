export type QueuePauseReason = "drag" | "momentum" | "drawer";

type Subscriber<T> = {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type Task<T> = {
  key: string;
  state: "queued" | "running";
  subscribers: Map<symbol, Subscriber<T>>;
};

export type SubscriberTaskQueueStats = {
  queued: number;
  running: number;
  subscribers: number;
  paused: boolean;
};

/**
 * Subscriber-aware FIFO for expensive native work.
 *
 * Queued tasks with no subscribers are discarded before starting. Running
 * native work is allowed to finish so callers never race file deletion or an
 * uncancellable FFI operation.
 */
export class SubscriberTaskQueue<T> {
  private readonly tasks = new Map<string, Task<T>>();
  private readonly fifo: Task<T>[] = [];
  private readonly pauseReasons = new Map<symbol, Set<QueuePauseReason>>();
  private running = 0;

  constructor(
    private readonly worker: (key: string) => Promise<T>,
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
  ): () => void {
    let task = this.tasks.get(key);
    if (!task) {
      task = {
        key,
        state: "queued",
        subscribers: new Map(),
      };
      this.tasks.set(key, task);
      this.fifo.push(task);
    }

    const token = Symbol(key);
    task.subscribers.set(token, { resolve, reject });
    this.pump();

    return () => {
      const current = this.tasks.get(key);
      current?.subscribers.delete(token);
      if (current?.state === "queued" && current.subscribers.size === 0) {
        this.tasks.delete(key);
      }
    };
  }

  request(key: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.subscribe(key, resolve, reject);
    });
  }

  setPaused(owner: symbol, reason: QueuePauseReason, paused: boolean): void {
    const reasons = this.pauseReasons.get(owner) ?? new Set<QueuePauseReason>();
    if (paused) {
      reasons.add(reason);
      this.pauseReasons.set(owner, reasons);
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

  private pump(): void {
    if (this.isPaused()) return;

    while (this.running < this.concurrency && this.fifo.length > 0) {
      const task = this.fifo.shift()!;
      if (this.tasks.get(task.key) !== task || task.state !== "queued") continue;
      if (task.subscribers.size === 0) {
        this.tasks.delete(task.key);
        continue;
      }

      task.state = "running";
      this.running += 1;
      void this.worker(task.key).then(
        (value) => {
          for (const subscriber of task.subscribers.values()) subscriber.resolve(value);
        },
        (error) => {
          for (const subscriber of task.subscribers.values()) subscriber.reject(error);
        },
      ).finally(() => {
        this.tasks.delete(task.key);
        this.running -= 1;
        this.pump();
      });
    }
  }
}
