import type { QueuePauseReason } from "./subscriberTaskQueue";

export type FrcCommitBufferOptions = {
  isSettled: () => boolean;
  subscribeSettled: (listener: (settled: boolean) => void) => () => void;
  schedule?: (run: () => void, delayMs: number) => () => void;
  now?: () => number;
  /** Maximum hold under a stuck pause. Retains the existing injectable option name. */
  delayMs?: number;
  maxBatchSize?: number;
};

export type FrcCommitBufferStats = {
  paused: boolean;
  pending: number;
};

const COALESCE_DELAY_MS = 80;
const DEFAULT_MAX_HOLD_MS = 1500;
const DEFAULT_MAX_BATCH_SIZE = 8;

/**
 * Coalesces React state commits without pausing download/decode work.
 *
 * `isSettled()` is the hard gate: no path commits during vertical scroll.
 * Pause owners are a soft gate: normal settle/coalescing cannot bypass them,
 * but the oldest entry may cross the maximum hold while the list is settled.
 */
export class FrcCommitBuffer {
  private readonly pauseReasons = new Map<symbol, Set<QueuePauseReason>>();
  private readonly pending = new Map<symbol, { commit: () => void; enqueuedAt: number }>();
  private readonly schedule: (run: () => void, delayMs: number) => () => void;
  private readonly now: () => number;
  private readonly maxHoldMs: number;
  private readonly maxBatchSize: number;
  private readonly unsubscribeSettled: () => void;
  private cancelCoalesced: (() => void) | null = null;
  private cancelHold: (() => void) | null = null;

  constructor(private readonly options: FrcCommitBufferOptions) {
    this.maxHoldMs = options.delayMs ?? DEFAULT_MAX_HOLD_MS;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    if (!(this.maxHoldMs >= 0) || !Number.isFinite(this.maxHoldMs)) {
      throw new Error("FrcCommitBuffer delayMs must be a non-negative finite number");
    }
    if (!Number.isInteger(this.maxBatchSize) || this.maxBatchSize < 1) {
      throw new Error("FrcCommitBuffer maxBatchSize must be a positive integer");
    }
    this.schedule =
      options.schedule ??
      ((run, delayMs) => {
        const id = setTimeout(run, delayMs);
        return () => clearTimeout(id);
      });
    this.now = options.now ?? performance.now.bind(performance);
    this.unsubscribeSettled = options.subscribeSettled((settled) => {
      if (settled) this.tryFlush();
    });
  }

  enqueue(commit: () => void): () => void {
    if (this.options.isSettled() && !this.isPaused() && this.pending.size === 0) {
      commit();
      return () => {};
    }

    const token = Symbol("frc-commit");
    this.pending.set(token, { commit, enqueuedAt: this.now() });
    if (!this.isPaused() && this.options.isSettled()) this.flushBatch();
    else this.scheduleTimers();

    return () => {
      if (!this.pending.delete(token)) return;
      if (this.pending.size === 0) this.cancelTimers();
      else if (this.isPaused()) this.scheduleHold();
    };
  }

  setPaused(owner: symbol, reason: QueuePauseReason, paused: boolean): void {
    const reasons = this.pauseReasons.get(owner) ?? new Set<QueuePauseReason>();
    if (paused) {
      reasons.add(reason);
      this.pauseReasons.set(owner, reasons);
      this.scheduleTimers();
      return;
    }
    reasons.delete(reason);
    if (reasons.size === 0) this.pauseReasons.delete(owner);
    this.onPauseChanged();
  }

  clearPauseOwner(owner: symbol): void {
    if (!this.pauseReasons.delete(owner)) return;
    this.onPauseChanged();
  }

  isPaused(): boolean {
    return this.pauseReasons.size > 0;
  }

  stats(): FrcCommitBufferStats {
    return { paused: this.isPaused(), pending: this.pending.size };
  }

  dispose(): void {
    this.unsubscribeSettled();
    this.cancelTimers();
    this.pending.clear();
    this.pauseReasons.clear();
  }

  private onPauseChanged(): void {
    if (this.isPaused()) {
      this.scheduleTimers();
      return;
    }
    this.cancelHoldTimer();
    if (this.options.isSettled()) this.flushBatch();
    else this.scheduleCoalesced();
  }

  private tryFlush(): void {
    if (!this.options.isSettled() || this.pending.size === 0) return;
    if (this.isPaused() && !this.oldestExpired()) return;
    this.flushBatch();
  }

  private oldestExpired(): boolean {
    const oldest = this.pending.values().next().value as
      | { commit: () => void; enqueuedAt: number }
      | undefined;
    return oldest !== undefined && this.now() - oldest.enqueuedAt >= this.maxHoldMs;
  }

  private scheduleTimers(): void {
    if (this.pending.size === 0) return;
    this.scheduleCoalesced();
    if (this.isPaused()) this.scheduleHold();
  }

  private scheduleCoalesced(): void {
    if (this.cancelCoalesced || this.pending.size === 0) return;
    this.cancelCoalesced = this.schedule(() => {
      this.cancelCoalesced = null;
      this.tryFlush();
    }, COALESCE_DELAY_MS);
  }

  private scheduleHold(): void {
    if (this.cancelHold || this.pending.size === 0 || !this.isPaused()) return;
    // Once the ceiling has been crossed, bounded follow-up batches belong to
    // the coalescing timer rather than a zero-delay hold loop.
    if (this.oldestExpired()) return;
    const oldest = this.pending.values().next().value as {
      commit: () => void;
      enqueuedAt: number;
    };
    const remaining = Math.max(0, this.maxHoldMs - (this.now() - oldest.enqueuedAt));
    this.cancelHold = this.schedule(() => {
      this.cancelHold = null;
      this.tryFlush();
      if (this.options.isSettled() && this.isPaused() && this.pending.size > 0) {
        this.scheduleHold();
      }
    }, remaining);
  }

  private flushBatch(): void {
    this.cancelTimers();
    let committed = 0;
    for (const [token, entry] of this.pending) {
      this.pending.delete(token);
      entry.commit();
      committed += 1;
      if (committed >= this.maxBatchSize) break;
    }
    this.scheduleTimers();
  }

  private cancelTimers(): void {
    this.cancelCoalesced?.();
    this.cancelCoalesced = null;
    this.cancelHoldTimer();
  }

  private cancelHoldTimer(): void {
    this.cancelHold?.();
    this.cancelHold = null;
  }
}
