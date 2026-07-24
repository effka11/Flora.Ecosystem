import { parseLoginPayload } from "../contracts/auth.js";
import type {
  RefreshCapability,
  SessionRecord,
  SessionSnapshot,
  SessionStore,
} from "../auth/types.js";

/**
 * `invalid` is reserved for terminal Invalid from the Auth refresh endpoint.
 * `storage_pending` may carry an effective volatile R2 awaiting local CAS.
 */
export type SessionRefreshOutcome =
  | "ready"
  | "invalid"
  | "transient"
  | "protocol_error"
  | "storage_pending"
  | "superseded";

/** Platform lock hook; the callback must run at most once. */
export type RunRefreshExclusive = <T>(operation: () => Promise<T>) => Promise<T>;

type AtomicSessionStore = SessionStore &
  Required<
    Pick<
      SessionStore,
      "readSession" | "compareAndSetSession" | "compareAndClearSession"
    >
  >;

type StoredSnapshot = {
  mode: "atomic" | "legacy";
  snapshot: SessionSnapshot;
};

type PendingMutation =
  | {
      kind: "set";
      store: SessionStore;
      epoch: number;
      base: StoredSnapshot;
      next: SessionRecord;
    }
  | {
      kind: "clear";
      store: SessionStore;
      epoch: number;
      base: StoredSnapshot;
    };

type CoordinatorOptions = {
  session: SessionStore;
  fetchImpl: typeof fetch;
  refreshUrl: string;
  onPascalFallback?: (key: string) => void;
  runRefreshExclusive?: RunRefreshExclusive;
  retrySafeRefreshBackend: boolean;
};

type RefreshResponse =
  | { kind: "ready"; next: SessionRecord }
  | { kind: "invalid" }
  | { kind: "transient" }
  | { kind: "protocol_error" }
  | { kind: "storage_pending" }
  | { kind: "superseded" };

const LOST_RESPONSE_RETRY_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAtomicSessionStore(store: SessionStore): store is AtomicSessionStore {
  const methods = [
    typeof store.readSession === "function",
    typeof store.compareAndSetSession === "function",
    typeof store.compareAndClearSession === "function",
  ];
  const count = methods.filter(Boolean).length;
  if (count !== 0 && count !== methods.length) {
    throw new Error("SessionStore atomic bridge must implement all three methods.");
  }
  return count === methods.length;
}

function copySessionRecord(session: SessionRecord): SessionRecord {
  const refresh =
    session.refresh?.kind === "cookie"
      ? { kind: "cookie" as const }
      : session.refresh?.kind === "token"
        ? { kind: "token" as const, token: session.refresh.token }
        : null;
  return {
    accessToken: session.accessToken,
    refresh,
    expiresAt: session.expiresAt,
  };
}

function validateSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
    throw new Error("SessionStore returned an invalid session revision.");
  }
  if (snapshot.session === null) {
    return { revision: snapshot.revision, session: null };
  }

  const { accessToken, refresh, expiresAt } = snapshot.session;
  if (
    (accessToken !== null && typeof accessToken !== "string") ||
    (expiresAt !== null && typeof expiresAt !== "string")
  ) {
    throw new Error("SessionStore returned an invalid session record.");
  }
  if (
    refresh !== null &&
    refresh.kind !== "cookie" &&
    (refresh.kind !== "token" ||
      typeof refresh.token !== "string" ||
      refresh.token.length === 0)
  ) {
    throw new Error("SessionStore returned an invalid refresh capability.");
  }

  return {
    revision: snapshot.revision,
    session: copySessionRecord(snapshot.session),
  };
}

async function readStoredSnapshot(store: SessionStore): Promise<StoredSnapshot> {
  if (isAtomicSessionStore(store)) {
    return {
      mode: "atomic",
      snapshot: validateSnapshot(await store.readSession()),
    };
  }

  const [accessToken, refreshToken, expiresAt] = await Promise.all([
    store.getAccessToken(),
    store.getRefreshToken(),
    store.getExpiresAt(),
  ]);
  const session =
    accessToken === null && refreshToken === null && expiresAt === null
      ? null
      : {
          accessToken,
          refresh: refreshToken
            ? ({ kind: "token", token: refreshToken } as const)
            : null,
          expiresAt,
        };
  return {
    mode: "legacy",
    snapshot: { revision: 0, session },
  };
}

function refreshCapabilitiesEqual(
  left: RefreshCapability | null,
  right: RefreshCapability | null,
): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === "cookie") return true;
  return right.kind === "token" && left.token === right.token;
}

function sessionRecordsEqual(
  left: SessionRecord | null,
  right: SessionRecord | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.accessToken === right.accessToken &&
    left.expiresAt === right.expiresAt &&
    refreshCapabilitiesEqual(left.refresh, right.refresh)
  );
}

function snapshotsEqual(left: StoredSnapshot, right: StoredSnapshot): boolean {
  if (left.mode !== right.mode) return false;
  if (
    left.mode === "atomic" &&
    left.snapshot.revision !== right.snapshot.revision
  ) {
    return false;
  }
  return sessionRecordsEqual(left.snapshot.session, right.snapshot.session);
}

function mutationWasApplied(
  mutation: PendingMutation,
  current: StoredSnapshot,
): boolean {
  if (mutation.base.mode !== current.mode) return false;
  const revisionChanged =
    current.mode === "legacy" ||
    current.snapshot.revision !== mutation.base.snapshot.revision;
  if (!revisionChanged) return false;
  if (mutation.kind === "clear") return current.snapshot.session === null;
  return sessionRecordsEqual(current.snapshot.session, mutation.next);
}

async function compareAndSet(
  store: SessionStore,
  base: StoredSnapshot,
  next: SessionRecord,
): Promise<boolean> {
  if (base.mode === "atomic") {
    if (!isAtomicSessionStore(store)) return false;
    return store.compareAndSetSession(base.snapshot.revision, copySessionRecord(next));
  }
  if (next.refresh?.kind !== "token") {
    throw new Error("Cookie refresh requires the atomic SessionStore bridge.");
  }
  await store.saveSession({
    accessToken: next.accessToken ?? "",
    refreshToken: next.refresh.token,
    expiresAt: next.expiresAt ?? "",
  });
  return true;
}

async function compareAndClear(
  store: SessionStore,
  base: StoredSnapshot,
): Promise<boolean> {
  if (base.mode === "atomic") {
    if (!isAtomicSessionStore(store)) return false;
    return store.compareAndClearSession(base.snapshot.revision);
  }
  await store.clearSession(false);
  return true;
}

/** @internal Use the configured coordinator functions exported from `./client`. */
export class SessionRefreshCoordinator {
  private epoch = 0;
  private inFlight: Promise<SessionRefreshOutcome> | null = null;
  private pending: PendingMutation | null = null;
  private confirmedInvalidEpoch: number | null = null;

  supersede(): void {
    this.epoch += 1;
    this.pending = null;
    this.confirmedInvalidEpoch = null;
  }

  resetForTests(): void {
    this.epoch = 0;
    this.inFlight = null;
    this.pending = null;
    this.confirmedInvalidEpoch = null;
  }

  hasPendingCommit(store: SessionStore): boolean {
    return (
      this.pending?.store === store &&
      this.pending.epoch === this.epoch
    );
  }

  async readEffectiveSession(store: SessionStore): Promise<SessionRecord | null> {
    const pending = this.currentPending(store);
    if (!pending) return (await readStoredSnapshot(store)).snapshot.session;

    try {
      const current = await readStoredSnapshot(store);
      if (mutationWasApplied(pending, current)) {
        this.pending = null;
        return pending.kind === "set" ? copySessionRecord(pending.next) : null;
      }
      if (!snapshotsEqual(pending.base, current)) {
        this.pending = null;
        if (pending.kind === "clear") this.confirmedInvalidEpoch = null;
        return current.snapshot.session;
      }
    } catch {
      // The volatile R2 (or confirmed clear) remains authoritative while storage
      // is unavailable. The next coordinator call retries only this local commit.
    }

    return pending.kind === "set" ? copySessionRecord(pending.next) : null;
  }

  async isConfirmedInvalidReadyToNotify(store: SessionStore): Promise<boolean> {
    if (this.confirmedInvalidEpoch !== this.epoch) return false;
    const session = await this.readEffectiveSession(store).catch(() => undefined);
    if (session !== null) return false;
    const pending = this.currentPending(store);
    return pending?.kind !== "clear";
  }

  refresh(options: CoordinatorOptions): Promise<SessionRefreshOutcome> {
    if (this.inFlight) return this.inFlight;

    const epoch = this.epoch;
    const attempt = this.run(options, epoch);
    this.inFlight = attempt.finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private currentPending(store: SessionStore): PendingMutation | null {
    if (
      this.pending?.store !== store ||
      this.pending.epoch !== this.epoch
    ) {
      return null;
    }
    return this.pending;
  }

  private isCurrent(options: CoordinatorOptions, epoch: number): boolean {
    return this.epoch === epoch && this.currentPendingStoreMatches(options.session);
  }

  private currentPendingStoreMatches(store: SessionStore): boolean {
    return this.pending === null || this.pending.store === store;
  }

  private async run(
    options: CoordinatorOptions,
    epoch: number,
  ): Promise<SessionRefreshOutcome> {
    let baseline: StoredSnapshot;
    try {
      baseline = await readStoredSnapshot(options.session);
    } catch {
      return this.epoch === epoch ? "storage_pending" : "superseded";
    }
    if (!this.isCurrent(options, epoch)) return "superseded";

    const operation = () => this.runExclusive(options, epoch, baseline);
    try {
      return options.runRefreshExclusive
        ? await options.runRefreshExclusive(operation)
        : await operation();
    } catch {
      return this.isCurrent(options, epoch) ? "transient" : "superseded";
    }
  }

  private async runExclusive(
    options: CoordinatorOptions,
    epoch: number,
    baseline: StoredSnapshot,
  ): Promise<SessionRefreshOutcome> {
    let current: StoredSnapshot;
    try {
      current = await readStoredSnapshot(options.session);
    } catch {
      return this.epoch === epoch ? "storage_pending" : "superseded";
    }
    if (!this.isCurrent(options, epoch)) return "superseded";

    const pending = this.currentPending(options.session);
    if (pending) return this.retryPending(options, epoch, pending, current);
    if (!snapshotsEqual(baseline, current)) return "superseded";

    const capability = baseline.snapshot.session?.refresh;
    if (!capability) return "superseded";

    const response = await this.requestRefresh(
      options,
      epoch,
      baseline,
      capability,
    );
    if (!this.isCurrent(options, epoch)) return "superseded";
    if (response.kind !== "ready" && response.kind !== "invalid") {
      return response.kind;
    }

    try {
      current = await readStoredSnapshot(options.session);
    } catch {
      return "storage_pending";
    }
    if (!this.isCurrent(options, epoch) || !snapshotsEqual(baseline, current)) {
      return "superseded";
    }

    if (response.kind === "invalid") {
      this.confirmedInvalidEpoch = epoch;
      return this.commitMutation(options, epoch, {
        kind: "clear",
        store: options.session,
        epoch,
        base: baseline,
      });
    }

    return this.commitMutation(options, epoch, {
      kind: "set",
      store: options.session,
      epoch,
      base: baseline,
      next: response.next,
    });
  }

  private async retryPending(
    options: CoordinatorOptions,
    epoch: number,
    pending: PendingMutation,
    current: StoredSnapshot,
  ): Promise<SessionRefreshOutcome> {
    if (!this.isCurrent(options, epoch)) return "superseded";
    if (mutationWasApplied(pending, current)) {
      this.pending = null;
      return pending.kind === "set" ? "ready" : "invalid";
    }
    if (!snapshotsEqual(pending.base, current)) {
      this.pending = null;
      if (pending.kind === "clear") this.confirmedInvalidEpoch = null;
      return "superseded";
    }
    return this.commitMutation(options, epoch, pending);
  }

  private async commitMutation(
    options: CoordinatorOptions,
    epoch: number,
    mutation: PendingMutation,
  ): Promise<SessionRefreshOutcome> {
    if (!this.isCurrent(options, epoch)) return "superseded";

    let committed: boolean;
    try {
      committed =
        mutation.kind === "set"
          ? await compareAndSet(options.session, mutation.base, mutation.next)
          : await compareAndClear(options.session, mutation.base);
    } catch {
      if (!this.isCurrent(options, epoch)) return "superseded";
      this.pending = mutation;
      return "storage_pending";
    }

    if (!this.isCurrent(options, epoch)) return "superseded";
    this.pending = null;
    if (!committed) {
      if (mutation.kind === "clear") this.confirmedInvalidEpoch = null;
      return "superseded";
    }
    if (mutation.kind === "set") this.confirmedInvalidEpoch = null;
    return mutation.kind === "set" ? "ready" : "invalid";
  }

  private async requestRefresh(
    options: CoordinatorOptions,
    epoch: number,
    baseline: StoredSnapshot,
    capability: RefreshCapability,
  ): Promise<RefreshResponse> {
    let response: Response;
    try {
      response = await this.fetchRefresh(options, capability);
    } catch {
      if (!options.retrySafeRefreshBackend) {
        return { kind: "transient" };
      }
      await sleep(LOST_RESPONSE_RETRY_DELAY_MS);
      if (!this.isCurrent(options, epoch)) return { kind: "superseded" };

      let current: StoredSnapshot;
      try {
        current = await readStoredSnapshot(options.session);
      } catch {
        return { kind: "storage_pending" };
      }
      if (!snapshotsEqual(baseline, current)) {
        return { kind: "superseded" };
      }

      try {
        response = await this.fetchRefresh(options, capability);
      } catch {
        return { kind: "transient" };
      }
    }

    if (!this.isCurrent(options, epoch)) return { kind: "superseded" };
    if (response.status === 401) {
      return { kind: "invalid" };
    }
    if (!response.ok) {
      if (
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500
      ) {
        return { kind: "transient" };
      }
      return { kind: "protocol_error" };
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return { kind: "protocol_error" };
    }

    try {
      const parsed = parseLoginPayload(raw, {
        onPascalFallback: options.onPascalFallback,
      });
      return {
        kind: "ready",
        next: {
          accessToken: parsed.accessToken,
          refresh:
            capability.kind === "cookie"
              ? { kind: "cookie" }
              : { kind: "token", token: parsed.refreshToken },
          expiresAt: parsed.expiresAt,
        },
      };
    } catch {
      return { kind: "protocol_error" };
    }
  }

  private fetchRefresh(
    options: CoordinatorOptions,
    capability: RefreshCapability,
  ): Promise<Response> {
    return options.fetchImpl(options.refreshUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body:
        capability.kind === "token"
          ? JSON.stringify({ refreshToken: capability.token })
          : "{}",
      ...(capability.kind === "cookie" ? { credentials: "include" as const } : {}),
    });
  }
}
