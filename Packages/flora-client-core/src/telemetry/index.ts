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
      reason: "not_authenticated" | "pubkey_mismatch" | "self_check_failed" | "malformed";
    }
  | { type: "restore_success" }
  | { type: "restore_failure"; reason: "wrong_password" | "backup_not_found" | "error" };

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
