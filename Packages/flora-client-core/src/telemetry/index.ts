export type TelemetryEvent =
  | { type: "cold_start_ms"; ms: number }
  | { type: "decrypt_message_ms"; ms: number }
  | { type: "media_error"; kind: string; message: string }
  | { type: "api_refresh"; ok: boolean }
  | { type: "pascal_case_fallback"; key: string }
  | { type: "secure_store_degraded" }
  | { type: "incoming_webm_video" }
  // FSCP key-backup self-heal observability. NEVER include keys/passwords/ciphertext —
  // only enumerable states/reasons and boolean outcomes (zero-knowledge preserved).
  | { type: "backup_decrypt_failed"; state: "unreadable" | "malformed" }
  | { type: "backup_self_healed"; previousState: "unreadable" }
  | {
      type: "backup_overwrite_skipped";
      reason:
        | "not_authenticated"
        | "pubkey_mismatch"
        | "self_check_failed"
        | "malformed"
        | "kdf_failed";
    }
  | { type: "restore_success" }
  | { type: "restore_failure"; reason: "wrong_password" | "backup_not_found" | "error" | "transient" }
  // Injected Argon2id (worker) unusable → derived on the main thread instead.
  | { type: "kdf_fallback_used"; reason: "worker_failed" | "invalid_output" }
  // Restore/unlock reliability (login-sync self-heal, e2e-security domain — see
  // Products/FSCP/ts/src/resilience.ts and loginHandoff.ts). `failure`/error-class fields are
  // ALWAYS inline literal unions here, never `FscpTransportFailureClass` imported from
  // `@flora/fscp`: that package declares this one as a peerDependency and re-exports it from
  // ./fscp/index.ts, so an import the other way would close a package cycle.
  //
  // Why the modal opened — mirrors the subset of FscpBootstrapStatus that can plausibly ask
  // for a password, plus the explicit "Ввести пароль" button (see
  // Apps/Web/app/_dashboard/FscpMobileBackupCallout.tsx, messages/page.tsx).
  | {
      type: "unlock_prompt_shown";
      reason: "needs_restore" | "wrong_password" | "backup_not_found" | "manual";
    }
  // Outcome of a single syncFscpOnLogin() call (regular login OR the silent handoff restore).
  | {
      type: "login_sync_outcome";
      ok: boolean;
      failure?: "transient" | "wrong_password" | "not_found" | "permanent";
      attempts: number;
    }
  // Result of consuming a loginHandoff.ts stash for a silent post-login restore.
  | { type: "login_handoff_used"; ok: boolean };

export type TelemetrySink = {
  capture(event: TelemetryEvent): void;
  captureException(err: unknown, context?: Record<string, string>): void;
};

let _sink: TelemetrySink = {
  capture() {},
  captureException() {},
};

export function configureTelemetry(sink: TelemetrySink): void {
  _sink = sink;
}

export function getTelemetry(): TelemetrySink {
  return _sink;
}

export function measureAsync<T>(event: Omit<TelemetryEvent, "ms"> & { type: "decrypt_message_ms" | "cold_start_ms" }, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  return fn().finally(() => {
    _sink.capture({ ...event, ms: Date.now() - start });
  });
}
