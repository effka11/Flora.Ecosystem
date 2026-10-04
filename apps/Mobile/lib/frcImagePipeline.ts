import {
  SubscriberTaskQueue,
  type QueuePauseReason,
  type QueuePriority,
  type QueueSubscription,
  type QueueWorkerContext,
  type SubscriberTaskQueueStats,
} from "./subscriberTaskQueue";

export type FrcImageLane = "post" | "avatar";

export type FrcPipelineFetchResult<TIntermediate, TResult> =
  | { kind: "ready"; value: TResult }
  | { kind: "intermediate"; value: TIntermediate };

export type FrcImagePipelineBackend<TIntermediate, TResult> = {
  fetch: (
    key: string,
    context: { signal: AbortSignal },
  ) => Promise<FrcPipelineFetchResult<TIntermediate, TResult>>;
  /**
   * Decode consumes one intermediate. Call `markUncancellable` immediately
   * before entering native work; the pipeline owns deletion in every outcome.
   */
  decode: (
    key: string,
    intermediate: TIntermediate,
    context: QueueWorkerContext,
  ) => Promise<TResult>;
  /** Idempotent, non-throwing deletion of an intermediate file. */
  discard: (intermediate: TIntermediate) => void;
};

export type FrcImagePipelineOptions = {
  postDownloadConcurrency?: number;
  avatarDownloadConcurrency?: number;
  postDecodeConcurrency?: number;
  avatarDecodeConcurrency?: number;
  maxPendingDecodes?: number;
};

export type FrcImagePipelineStats = SubscriberTaskQueueStats & {
  downloadQueued: number;
  downloadRunning: number;
  decodeQueued: number;
  decodeRunning: number;
  pendingDecode: number;
  deferred: number;
  discardedPending: number;
};

type PipelineSubscriber<TResult> = {
  resolve: (value: TResult) => void;
  reject: (error: unknown) => void;
  priority: QueuePriority;
};

type PipelineTaskState =
  | "queued-download"
  | "downloading"
  | "waiting-decode"
  | "decoding"
  | "deferred";

type PipelineTask<TIntermediate, TResult> = {
  key: string;
  lane: FrcImageLane;
  seq: number;
  priority: QueuePriority;
  state: PipelineTaskState;
  subscribers: Map<symbol, PipelineSubscriber<TResult>>;
  stageSubscription: QueueSubscription | null;
  intermediate: TIntermediate | null;
  downloadRun: symbol | null;
  decodeRun: symbol | null;
};

const PRIORITY_RANK: Record<QueuePriority, number> = {
  visible: 3,
  near: 2,
  background: 1,
};

export const FRC_POST_DOWNLOAD_CONCURRENCY = 3;
export const FRC_AVATAR_DOWNLOAD_CONCURRENCY = 1;
export const FRC_POST_DECODE_CONCURRENCY = 1;
export const FRC_AVATAR_DECODE_CONCURRENCY = 1;
export const FRC_MAX_PENDING_DECODES = 16;

function abortError(): Error {
  const error = new Error("FRC image pipeline run was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Subscriber-aware two-stage image pipeline.
 *
 * Posts and avatars have reserved queue capacity at both stages. Together the
 * defaults allow four downloads and two native decodes, while an avatar burst
 * can never consume the post lane's slots. Downloaded intermediates waiting
 * for decode are globally bounded; overflow discards the lowest-priority,
 * newest task and keeps its subscribers deferred for a later retry.
 */
export class FrcImagePipeline<TIntermediate, TResult> {
  private readonly tasks = new Map<string, PipelineTask<TIntermediate, TResult>>();
  private readonly downloadQueues: Record<FrcImageLane, SubscriberTaskQueue<
    FrcPipelineFetchResult<TIntermediate, TResult>
  >>;
  private readonly decodeQueues: Record<FrcImageLane, SubscriberTaskQueue<TResult>>;
  private readonly maxPendingDecodes: number;
  private seqCounter = 0;
  private discardedPending = 0;

  constructor(
    private readonly backend: FrcImagePipelineBackend<TIntermediate, TResult>,
    options: FrcImagePipelineOptions = {},
  ) {
    this.maxPendingDecodes = options.maxPendingDecodes ?? FRC_MAX_PENDING_DECODES;
    if (!Number.isInteger(this.maxPendingDecodes) || this.maxPendingDecodes < 1) {
      throw new Error("FrcImagePipeline maxPendingDecodes must be a positive integer");
    }

    this.downloadQueues = {
      post: new SubscriberTaskQueue(
        (key, context) => this.runDownload(key, "post", context),
        options.postDownloadConcurrency ?? FRC_POST_DOWNLOAD_CONCURRENCY,
      ),
      avatar: new SubscriberTaskQueue(
        (key, context) => this.runDownload(key, "avatar", context),
        options.avatarDownloadConcurrency ?? FRC_AVATAR_DOWNLOAD_CONCURRENCY,
      ),
    };
    this.decodeQueues = {
      post: new SubscriberTaskQueue(
        (key, context) => this.runDecode(key, "post", context),
        options.postDecodeConcurrency ?? FRC_POST_DECODE_CONCURRENCY,
      ),
      avatar: new SubscriberTaskQueue(
        (key, context) => this.runDecode(key, "avatar", context),
        options.avatarDecodeConcurrency ?? FRC_AVATAR_DECODE_CONCURRENCY,
      ),
    };
  }

  subscribe(
    key: string,
    lane: FrcImageLane,
    resolve: (value: TResult) => void,
    reject: (error: unknown) => void = () => {},
    priority: QueuePriority = "visible",
  ): QueueSubscription {
    const existing = this.tasks.get(key);
    const task: PipelineTask<TIntermediate, TResult> = existing ?? {
      key,
      lane,
      seq: this.seqCounter++,
      priority,
      state: "queued-download",
      subscribers: new Map(),
      stageSubscription: null,
      intermediate: null,
      downloadRun: null,
      decodeRun: null,
    };
    if (!existing) this.tasks.set(key, task);

    const token = Symbol(key);
    task.subscribers.set(token, { resolve, reject, priority });
    this.refreshPriority(task);
    this.ensureStageSubscription(task);

    let active = true;
    return {
      unsubscribe: () => {
        if (!active) return;
        active = false;
        if (this.tasks.get(key) !== task) return;
        task.subscribers.delete(token);
        if (task.subscribers.size > 0) {
          this.refreshPriority(task);
          return;
        }
        this.removeUnobservedTask(task);
      },
      setPriority: (next) => {
        if (!active || this.tasks.get(key) !== task) return;
        const subscriber = task.subscribers.get(token);
        if (!subscriber || subscriber.priority === next) return;
        subscriber.priority = next;
        this.refreshPriority(task);
      },
    };
  }

  /** Rollback lever: callers can still pause actual work without changing subscriptions. */
  setWorkPaused(owner: symbol, reason: QueuePauseReason, paused: boolean): void {
    for (const queue of this.allQueues()) queue.setPaused(owner, reason, paused);
  }

  clearWorkPauseOwner(owner: symbol): void {
    for (const queue of this.allQueues()) queue.clearPauseOwner(owner);
  }

  stats(): FrcImagePipelineStats {
    const downloads = this.sumQueueStats(Object.values(this.downloadQueues));
    const decodes = this.sumQueueStats(Object.values(this.decodeQueues));
    let queued = 0;
    let running = 0;
    let subscribers = 0;
    let pendingDecode = 0;
    let deferred = 0;

    for (const task of this.tasks.values()) {
      subscribers += task.subscribers.size;
      if (task.state === "downloading" || task.state === "decoding") running += 1;
      else queued += 1;
      if (task.state === "waiting-decode") pendingDecode += 1;
      if (task.state === "deferred") deferred += 1;
    }

    return {
      queued,
      running,
      subscribers,
      paused: downloads.paused || decodes.paused,
      downloadQueued: downloads.queued,
      downloadRunning: downloads.running,
      decodeQueued: decodes.queued,
      decodeRunning: decodes.running,
      pendingDecode,
      deferred,
      discardedPending: this.discardedPending,
    };
  }

  private allQueues(): {
    setPaused: (owner: symbol, reason: QueuePauseReason, paused: boolean) => void;
    clearPauseOwner: (owner: symbol) => void;
  }[] {
    return [
      this.downloadQueues.post,
      this.downloadQueues.avatar,
      this.decodeQueues.post,
      this.decodeQueues.avatar,
    ];
  }

  private sumQueueStats(
    queues: { stats: () => SubscriberTaskQueueStats }[],
  ): SubscriberTaskQueueStats {
    let queued = 0;
    let running = 0;
    let subscribers = 0;
    let paused = false;
    for (const queue of queues) {
      const stats = queue.stats();
      queued += stats.queued;
      running += stats.running;
      subscribers += stats.subscribers;
      paused ||= stats.paused;
    }
    return { queued, running, subscribers, paused };
  }

  private taskFor(
    key: string,
    lane: FrcImageLane,
  ): PipelineTask<TIntermediate, TResult> {
    const task = this.tasks.get(key);
    if (!task || task.lane !== lane) {
      throw new Error(`Missing ${lane} FRC pipeline task: ${key}`);
    }
    return task;
  }

  private async runDownload(
    key: string,
    lane: FrcImageLane,
    context: QueueWorkerContext,
  ): Promise<FrcPipelineFetchResult<TIntermediate, TResult>> {
    const task = this.taskFor(key, lane);
    const run = Symbol("download-run");
    task.downloadRun = run;
    task.state = "downloading";
    context.onSettled(() => this.onRunSettled(task, "download", run));

    const result = await this.backend.fetch(key, { signal: context.signal });
    if (!context.signal.aborted) return result;
    if (result.kind === "intermediate") this.backend.discard(result.value);
    throw abortError();
  }

  private async runDecode(
    key: string,
    lane: FrcImageLane,
    context: QueueWorkerContext,
  ): Promise<TResult> {
    const task = this.taskFor(key, lane);
    const intermediate = task.intermediate;
    if (intermediate === null) throw new Error(`Missing FRC intermediate for ${key}`);

    const run = Symbol("decode-run");
    task.decodeRun = run;
    task.state = "decoding";
    context.onSettled(() => this.onRunSettled(task, "decode", run));
    this.resumeDeferred();

    try {
      return await this.backend.decode(key, intermediate, context);
    } finally {
      if (task.intermediate === intermediate) task.intermediate = null;
      this.backend.discard(intermediate);
    }
  }

  private onRunSettled(
    task: PipelineTask<TIntermediate, TResult>,
    stage: "download" | "decode",
    run: symbol,
  ): void {
    const field = stage === "download" ? "downloadRun" : "decodeRun";
    if (task[field] !== run) return;
    task[field] = null;
    if (task.subscribers.size > 0 || this.tasks.get(task.key) !== task) return;
    if (task.intermediate !== null) {
      this.backend.discard(task.intermediate);
      task.intermediate = null;
    }
    this.tasks.delete(task.key);
    this.resumeDeferred();
  }

  private ensureStageSubscription(task: PipelineTask<TIntermediate, TResult>): void {
    if (task.stageSubscription) return;
    if (task.state === "waiting-decode" || task.state === "decoding") {
      this.subscribeDecode(task);
      return;
    }
    if (task.state === "deferred") task.state = "queued-download";
    this.subscribeDownload(task);
  }

  private subscribeDownload(task: PipelineTask<TIntermediate, TResult>): void {
    task.state = "queued-download";
    task.stageSubscription = this.downloadQueues[task.lane].subscribe(
      task.key,
      (result) => this.onDownloaded(task, result),
      (error) => this.failTask(task, error),
      task.priority,
    );
  }

  private subscribeDecode(task: PipelineTask<TIntermediate, TResult>): void {
    task.stageSubscription = this.decodeQueues[task.lane].subscribe(
      task.key,
      (result) => this.completeTask(task, result),
      (error) => this.failTask(task, error),
      task.priority,
    );
  }

  private onDownloaded(
    task: PipelineTask<TIntermediate, TResult>,
    result: FrcPipelineFetchResult<TIntermediate, TResult>,
  ): void {
    if (this.tasks.get(task.key) !== task) {
      if (result.kind === "intermediate") this.backend.discard(result.value);
      return;
    }
    task.stageSubscription = null;
    if (result.kind === "ready") {
      this.completeTask(task, result.value);
      return;
    }
    if (task.subscribers.size === 0) {
      this.backend.discard(result.value);
      this.tasks.delete(task.key);
      this.resumeDeferred();
      return;
    }

    task.intermediate = result.value;
    task.state = "waiting-decode";
    this.subscribeDecode(task);
    this.enforcePendingLimit();
    this.resumeDeferred();
  }

  private completeTask(task: PipelineTask<TIntermediate, TResult>, result: TResult): void {
    if (this.tasks.get(task.key) !== task) return;
    this.tasks.delete(task.key);
    task.stageSubscription = null;
    for (const subscriber of task.subscribers.values()) subscriber.resolve(result);
    this.resumeDeferred();
  }

  private failTask(task: PipelineTask<TIntermediate, TResult>, error: unknown): void {
    if (this.tasks.get(task.key) !== task) return;
    this.tasks.delete(task.key);
    task.stageSubscription = null;
    if (task.intermediate !== null) {
      this.backend.discard(task.intermediate);
      task.intermediate = null;
    }
    for (const subscriber of task.subscribers.values()) subscriber.reject(error);
    this.resumeDeferred();
  }

  private removeUnobservedTask(task: PipelineTask<TIntermediate, TResult>): void {
    task.stageSubscription?.unsubscribe();
    task.stageSubscription = null;
    if (task.state === "downloading" || task.state === "decoding") {
      // The run cleanup owns deletion after abort/native completion. Keeping
      // the task lets an immediate re-subscribe join that same generation.
      return;
    }
    if (task.intermediate !== null) {
      this.backend.discard(task.intermediate);
      task.intermediate = null;
    }
    this.tasks.delete(task.key);
    this.resumeDeferred();
  }

  private refreshPriority(task: PipelineTask<TIntermediate, TResult>): void {
    let best: QueuePriority | null = null;
    for (const subscriber of task.subscribers.values()) {
      if (best === null || PRIORITY_RANK[subscriber.priority] > PRIORITY_RANK[best]) {
        best = subscriber.priority;
      }
    }
    if (best === null || best === task.priority) return;
    const previous = task.priority;
    task.priority = best;
    task.stageSubscription?.setPriority(best);
    if (
      task.state === "deferred" &&
      PRIORITY_RANK[best] > PRIORITY_RANK[previous]
    ) {
      this.ensureStageSubscription(task);
    }
  }

  private enforcePendingLimit(): void {
    for (;;) {
      const waiting = [...this.tasks.values()].filter(
        (task) => task.state === "waiting-decode",
      );
      if (waiting.length <= this.maxPendingDecodes) return;
      let victim = waiting[0];
      for (const candidate of waiting.slice(1)) {
        const candidateRank = PRIORITY_RANK[candidate.priority];
        const victimRank = PRIORITY_RANK[victim.priority];
        if (
          candidateRank < victimRank ||
          (candidateRank === victimRank && candidate.seq > victim.seq)
        ) {
          victim = candidate;
        }
      }
      this.deferTask(victim);
    }
  }

  private deferTask(task: PipelineTask<TIntermediate, TResult>): void {
    task.stageSubscription?.unsubscribe();
    task.stageSubscription = null;
    if (task.intermediate !== null) {
      this.backend.discard(task.intermediate);
      task.intermediate = null;
    }
    task.state = "deferred";
    this.discardedPending += 1;
    if (task.subscribers.size === 0) this.tasks.delete(task.key);
  }

  private resumeDeferred(): void {
    const activeDownloads = [...this.tasks.values()].some(
      (task) => task.state === "queued-download" || task.state === "downloading",
    );
    if (activeDownloads) return;

    const waiting = [...this.tasks.values()].filter(
      (task) => task.state === "waiting-decode",
    ).length;
    let available = this.maxPendingDecodes - waiting;
    while (available > 0) {
      let best: PipelineTask<TIntermediate, TResult> | null = null;
      for (const task of this.tasks.values()) {
        if (task.state !== "deferred" || task.subscribers.size === 0) continue;
        if (
          best === null ||
          PRIORITY_RANK[task.priority] > PRIORITY_RANK[best.priority] ||
          (task.priority === best.priority && task.seq < best.seq)
        ) {
          best = task;
        }
      }
      if (!best) return;
      this.ensureStageSubscription(best);
      available -= 1;
    }
  }
}
