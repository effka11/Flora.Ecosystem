/**
 * FSCP restore/unlock resilience taxonomy: transport failures, retries, shared deadline.
 *
 * This is the login-sync / restore domain (`e2e-security`), deliberately NOT the per-message
 * decrypt taxonomy of envelope.ts (`FscpDecryptFailureCategory` / `FscpDecryptError` /
 * `fscpDecryptFailureCategory` / `classifyDecryptFailure`). That one feeds the conversation
 * session FSM and is anti-DoS oriented; this one decides "retry or ask the user for a password".
 * Names must stay disjoint: index.ts re-exports both with `export *`.
 *
 * SCOPE — `withFscpRetry` wraps IDEMPOTENT READ operations ONLY:
 * - never wrap a write such as `apiPutKeyBackup`: if the response is lost but the PUT landed,
 *   a replay carries a stale `existingRevision` and the server answers 409 (and a blind rewrite
 *   of a key backup is exactly the data-loss we are trying to avoid);
 * - the deadline race abandons the awaited promise, it does NOT cancel the HTTP request already
 *   in flight — so a call that "timed out" here may still be applied on the server.
 * Read phase → retry. Write phase → one attempt, and re-read the revision if a retry is ever
 * needed there.
 */

import { isApiRequestError, isNetworkError } from "@flora/client-core/api/errors.js";

/**
 * How a restore/login-sync failure should be treated by the caller:
 * - transient:      network blip / server hiccup / deadline exhausted — retry, never blame the password.
 * - wrong_password: AEAD authentication failed — the only case that justifies asking for a password.
 * - not_found:      HTTP 404 — the resource genuinely does not exist (e.g. no key backup yet).
 * - permanent:      everything else, including anything we do not understand (conservative: no retry).
 */
export type FscpTransportFailureClass = "transient" | "wrong_password" | "not_found" | "permanent";

export type FscpBackupErrorKind = "aead_auth_failed" | "kdf_failed" | "malformed";

/**
 * Typed key/recovery-backup failure.
 *
 * `kind` is additive on top of the legacy `message`: existing callers (mobile bootstrap branch,
 * the divergent Apps/Web copy) still match on message substrings, so the historical texts are
 * preserved verbatim by the throwing side.
 */
export class FscpBackupError extends Error {
  readonly kind: FscpBackupErrorKind;

  constructor(kind: FscpBackupErrorKind, message: string) {
    super(message);
    this.name = "FscpBackupError";
    this.kind = kind;
  }
}

/** Structural check too: FSCP may be loaded twice (SSR/client bundles), where instanceof fails. */
export function isFscpBackupError(e: unknown): e is FscpBackupError {
  if (e instanceof FscpBackupError) return true;
  if (!(e instanceof Error) || e.name !== "FscpBackupError") return false;
  const kind = (e as { kind?: unknown }).kind;
  return kind === "aead_auth_failed" || kind === "kdf_failed" || kind === "malformed";
}

/** Whole-resolve time budget: retries are spent inside it, not on top of it. */
export const FSCP_RESOLVE_DEADLINE_MS = 12_000;

export const FSCP_RETRY_ATTEMPTS = 3;

export const FSCP_RETRY_DELAYS_MS: readonly number[] = [300, 900, 2500];

/**
 * Absolute wall-clock budget (Date.now()), so ONE deadline can be shared by several
 * `withFscpRetry` calls inside a single resolve — see `createFscpDeadline`.
 */
export type FscpDeadline = {
  remainingMs(): number;
  expired(): boolean;
};

export function createFscpDeadline(ms: number = FSCP_RESOLVE_DEADLINE_MS): FscpDeadline {
  const endsAt = Date.now() + Math.max(0, ms);
  return {
    remainingMs: () => Math.max(0, endsAt - Date.now()),
    expired: () => Date.now() >= endsAt,
  };
}

/** Raised when the shared budget runs out; classified as `transient` (server state unknown). */
export class FscpDeadlineExceededError extends Error {
  constructor(message = "FSCP: истёк бюджет времени на восстановление ключей.") {
    super(message);
    this.name = "FscpDeadlineExceededError";
  }
}

export function isFscpDeadlineExceededError(e: unknown): e is FscpDeadlineExceededError {
  if (e instanceof FscpDeadlineExceededError) return true;
  return e instanceof Error && e.name === "FscpDeadlineExceededError";
}

export function classifyTransportFailure(e: unknown): FscpTransportFailureClass {
  if (isFscpDeadlineExceededError(e)) return "transient";

  if (isFscpBackupError(e)) {
    // Only a Poly1305 tag mismatch is evidence about the password. A broken KDF or a
    // structurally invalid payload says nothing about it — never ask for a password there.
    return e.kind === "aead_auth_failed" ? "wrong_password" : "permanent";
  }

  if (isNetworkError(e)) return "transient";

  if (isApiRequestError(e)) {
    const status = e.status;
    if (status === 404) return "not_found";
    if (status === 408 || status === 425 || status === 429) return "transient";
    if (status >= 500) return "transient";
    return "permanent";
  }

  // Unknown failure: do not retry what we cannot explain.
  return "permanent";
}

/**
 * Portable surface: the FSCP kernel compiles against a bare ES2022 lib (no DOM, no @types/node),
 * and the timer handle type differs per host — so timers are reached through globalThis.
 */
const hostTimers = globalThis as unknown as {
  setTimeout(handler: () => void, timeoutMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type FscpRetryOptions = {
  attempts?: number;
  delaysMs?: number[];
  deadline?: FscpDeadline;
  jitter?: boolean;
  /** 1-based; the last observed value is the number of attempts spent. */
  onAttemptStarted?: (info: { attempt: number }) => void;
  onAttemptFailed?: (info: { attempt: number; failure: FscpTransportFailureClass }) => void;
};

function jitteredDelayMs(base: number, jitter: boolean): number {
  if (!jitter || base <= 0) return Math.max(0, base);
  // ±25%: decorrelates clients retrying together without changing the backoff magnitude.
  const spread = base * 0.25;
  return Math.max(0, Math.round(base - spread + Math.random() * spread * 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    hostTimers.setTimeout(() => resolve(), ms);
  });
}

/**
 * Races one attempt against the remaining budget. A hung response must not hold the resolve
 * forever; the in-flight request itself cannot be cancelled from here, hence read-only scope.
 */
async function raceDeadline<T>(promise: Promise<T>, deadline: FscpDeadline | undefined): Promise<T> {
  if (!deadline) return promise;
  const remaining = deadline.remainingMs();
  if (remaining <= 0) {
    void promise.catch(() => {});
    throw new FscpDeadlineExceededError();
  }
  let timer: unknown;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = hostTimers.setTimeout(() => reject(new FscpDeadlineExceededError()), remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) hostTimers.clearTimeout(timer);
    // The abandoned attempt may still reject later — swallow it, it is nobody's error anymore.
    void promise.catch(() => {});
  }
}

/**
 * Retries `fn` while — and only while — the failure classifies as `transient`.
 * Anything else (wrong password, 404, permanent) is rethrown immediately, unchanged.
 *
 * Attempts spent are observable through `onAttemptStarted` / `onAttemptFailed` (telemetry
 * `login_sync_outcome { attempts }` lives in the caller, not here).
 */
export async function withFscpRetry<T>(
  fn: () => Promise<T>,
  opts?: FscpRetryOptions,
): Promise<T> {
  const attempts = Math.max(1, Math.trunc(opts?.attempts ?? FSCP_RETRY_ATTEMPTS));
  const delays = opts?.delaysMs ?? [...FSCP_RETRY_DELAYS_MS];
  const jitter = opts?.jitter !== false;
  const deadline = opts?.deadline;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (deadline?.expired()) {
      throw lastError ?? new FscpDeadlineExceededError();
    }
    opts?.onAttemptStarted?.({ attempt });
    try {
      return await raceDeadline(fn(), deadline);
    } catch (e) {
      lastError = e;
      const failure = classifyTransportFailure(e);
      opts?.onAttemptFailed?.({ attempt, failure });
      if (failure !== "transient") throw e;
      if (attempt >= attempts) throw e;

      const base = delays.length > 0 ? (delays[Math.min(attempt - 1, delays.length - 1)] ?? 0) : 0;
      const delay = jitteredDelayMs(base, jitter);
      // No budget left for the backoff itself — stop now instead of sleeping past the deadline.
      if (deadline && delay >= deadline.remainingMs()) throw e;
      if (delay > 0) await sleep(delay);
    }
  }

  throw lastError ?? new FscpDeadlineExceededError();
}
