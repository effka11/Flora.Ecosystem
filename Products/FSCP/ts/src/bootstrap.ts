/**
 * FSCP device bootstrap orchestrator (MVP: single-active-identity).
 *
 * Invariants:
 * - Identity creation only via createInitialFscpIdentity().
 * - persist ≠ publish ≠ syncDeviceUuid.
 * - canDecryptFscp / canSendFscp are product policy, not crypto limits.
 * - Orphan local profile: no auto-publish without user confirm.
 * - key_mismatch: no auto-publish; restore account backup only if backup pubkey == server.
 */

import { isApiRequestError } from "@flora/client-core/api/errors.js";
import {
  apiGetE2EState,
  apiGetKeyBackup,
  type MsgE2EState,
} from "@flora/client-core/api/messaging.js";
import { fromBase64Flexible } from "./base64url.js";
import {
  decryptKeyBackup,
  parseKeyBackupPayload,
  restoreLocalMaterialFromBackupPlaintext,
  type FscpBackupState,
  type KeyBackupPayloadOut,
} from "./keyBackup.js";
import type { FscpKeyStorageAdapter } from "./keyStorage.js";
import {
  agreementPublicKeyBase64Url,
  createInitialFscpIdentity,
  deriveAgreementPublicKeyBytes,
  loadFscpLocalMaterial,
  persistFscpLocalMaterial,
  type FscpLocalMaterial,
} from "./keys.js";
import {
  apiPutMyE2ePublicKey,
  apiTryGetUserE2ePublicKey,
  type UserE2eKeyBundle,
} from "./messaging.js";
import {
  FscpBackupError,
  classifyTransportFailure,
  createFscpDeadline,
  isFscpBackupError,
  withFscpRetry,
  type FscpDeadline,
  type FscpRetryOptions,
  type FscpTransportFailureClass,
} from "./resilience.js";

export type FscpBootstrapStatus =
  | "ready"
  | "not_initialized"
  | "needs_restore"
  | "wrong_password"
  | "backup_not_found"
  | "key_mismatch"
  | "orphan_local_profile"
  | "registration_pending"
  | "transient_error";

export type FscpPendingOperation = "publish" | "sync_device_uuid";

export type FscpBootstrapResult = {
  status: FscpBootstrapStatus;
  material: FscpLocalMaterial | null;
  localPubKey?: string;
  serverPubKey?: string;
  pendingOperation: FscpPendingOperation | null;
  failure?: FscpTransportFailureClass;
};

type KnownKeyBackup = {
  raw?: unknown;
  state?: FscpBackupState;
};

type ResolveReadSnapshot = {
  knownE2eState?: MsgE2EState;
  knownBackup?: KnownKeyBackup;
};

type ReadAttemptStarted = NonNullable<FscpRetryOptions["onAttemptStarted"]>;

/*
 * Owner-scoped promise tails are a mutex, not a result cache: every waiter reruns the resolve
 * after the previous call and therefore observes the latest storage state. This protects one
 * JS realm only. Two browser tabs can still race through shared localStorage; the future web
 * adapter remedy is navigator.locks.request(), without adding a DOM dependency to this kernel.
 */
const ownerResolveTails = new Map<string, Promise<void>>();

async function serializeResolveForOwner<T>(ownerNorm: string, fn: () => Promise<T>): Promise<T> {
  const previous = ownerResolveTails.get(ownerNorm) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(
    () => gate,
    () => gate,
  );
  ownerResolveTails.set(ownerNorm, tail);

  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (ownerResolveTails.get(ownerNorm) === tail) {
      ownerResolveTails.delete(ownerNorm);
    }
  }
}

function retryRead<T>(
  fn: () => Promise<T>,
  deadline: FscpDeadline,
  onAttemptStarted?: ReadAttemptStarted,
): Promise<T> {
  return withFscpRetry(fn, { deadline, onAttemptStarted });
}

function restoreFailureResult(opts: {
  error: unknown;
  material: FscpLocalMaterial | null;
  serverPubKey?: string;
}): FscpBootstrapResult {
  const failure = classifyTransportFailure(opts.error);
  if (
    (isFscpBackupError(opts.error) && opts.error.kind === "aead_auth_failed") ||
    failure === "wrong_password"
  ) {
    return {
      status: "wrong_password",
      material: opts.material,
      pendingOperation: null,
      serverPubKey: opts.serverPubKey,
      failure,
    };
  }
  if (failure === "not_found") {
    return {
      status: "backup_not_found",
      material: opts.material,
      pendingOperation: null,
      serverPubKey: opts.serverPubKey,
      failure,
    };
  }
  return {
    status: "transient_error",
    material: opts.material,
    pendingOperation: null,
    serverPubKey: opts.serverPubKey,
    failure,
  };
}

export function agreementPubkeysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== 32 || b.length !== 32) return false;
  for (let i = 0; i < 32; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function decodeAgreementPublicKeyBytes(encoded: string): Uint8Array {
  const bytes = fromBase64Flexible(encoded.trim());
  if (bytes.length !== 32) {
    throw new Error("FSCP: agreement public key must be 32 bytes.");
  }
  return bytes;
}

/** SECURITY/UX: block decrypt/send until local pubkey matches server-published pubkey. */
export function canDecryptFscp(r: FscpBootstrapResult): boolean {
  return r.status === "ready" && r.material !== null;
}

export function canSendFscp(r: FscpBootstrapResult): boolean {
  return canDecryptFscp(r);
}

/** True when account already has E2E on server — never auto-create a new identity. */
export function accountRequiresKeyRestore(params: {
  hasServerPubKey: boolean;
  e2eState: string;
  hasKeyBackup: boolean;
}): boolean {
  if (params.hasServerPubKey) return true;
  if (params.e2eState !== "not_initialized") return true;
  return params.hasKeyBackup;
}

/** Diagnostics / future recovery-tools only — not for production UI decrypt. */
export function hasDecryptMaterial(r: FscpBootstrapResult): boolean {
  return r.material !== null;
}

type PublishResult =
  | { ok: true; deviceUuid: string }
  | { ok: false; error: string };

export async function publishAgreementPublicKey(material: FscpLocalMaterial): Promise<PublishResult> {
  try {
    const pub = await agreementPublicKeyBase64Url(material);
    const up = await apiPutMyE2ePublicKey(pub, null);
    return { ok: true, deviceUuid: up.deviceUuid };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "publish failed" };
  }
}

/**
 * PRECONDITION (backend contract, MVP):
 * SetMyE2EPublicKey with unchanged publicKeyBase64 is treated as idempotent for routing —
 * only deviceUuid may be assigned. If backend later adds side effects on any PUT, revisit.
 */
export async function syncFscpDeviceUuid(
  storage: FscpKeyStorageAdapter,
  ownerUserUuid: string,
  material: FscpLocalMaterial,
  serverPubKey?: string,
): Promise<PublishResult> {
  const ownerNorm = ownerUserUuid.trim().toLowerCase();
  let serverPubKeyValue = serverPubKey?.trim();
  if (!serverPubKeyValue) {
    const server = await apiTryGetUserE2ePublicKey(ownerNorm);
    serverPubKeyValue = server?.publicKeyBase64?.trim();
    if (!serverPubKeyValue) {
      return { ok: false, error: "server pubkey not found" };
    }
  }

  const localBytes = await deriveAgreementPublicKeyBytes(material);
  const serverBytes = decodeAgreementPublicKeyBytes(serverPubKeyValue);
  if (!agreementPubkeysEqual(localBytes, serverBytes)) {
    return { ok: false, error: "pubkey mismatch" };
  }

  try {
    const pub = await agreementPublicKeyBase64Url(material);
    const up = await apiPutMyE2ePublicKey(pub, null);
    const updated: FscpLocalMaterial = { ...material, deviceUuidFromServer: up.deviceUuid };
    await persistFscpLocalMaterial(storage, ownerNorm, updated);
    return { ok: true, deviceUuid: up.deviceUuid };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "sync deviceUuid failed" };
  }
}

export async function restoreFromPasswordBackup(
  password: string,
  knownBackup?: unknown,
): Promise<FscpLocalMaterial> {
  const raw = knownBackup === undefined ? await apiGetKeyBackup() : knownBackup;
  let payload: KeyBackupPayloadOut;
  try {
    payload = parseKeyBackupPayload(raw);
  } catch (e) {
    if (isFscpBackupError(e)) throw e;
    throw new FscpBackupError(
      "malformed",
      e instanceof Error ? e.message : "Некорректный payload key-backup.",
    );
  }
  const plaintext = await decryptKeyBackup(payload, password);
  let restored: Awaited<ReturnType<typeof restoreLocalMaterialFromBackupPlaintext>>;
  try {
    restored = await restoreLocalMaterialFromBackupPlaintext(plaintext);
  } catch (e) {
    if (isFscpBackupError(e)) throw e;
    throw new FscpBackupError(
      "malformed",
      e instanceof Error ? e.message : "Расшифрованные данные резервной копии повреждены.",
    );
  }
  return {
    agreementPrivateKey: restored.agreementPrivateKey,
    signingPrivateKey: restored.signingPrivateKey,
    deviceUuidFromServer: null,
  };
}

async function buildMismatchResult(
  material: FscpLocalMaterial,
  serverPubKey: string,
): Promise<FscpBootstrapResult> {
  const localPubKey = await agreementPublicKeyBase64Url(material);
  return {
    status: "key_mismatch",
    material,
    localPubKey,
    serverPubKey,
    pendingOperation: null,
  };
}

export async function finalizeWithServerPubkey(opts: {
  storage: FscpKeyStorageAdapter;
  ownerUserUuid: string;
  material: FscpLocalMaterial;
  server: UserE2eKeyBundle;
}): Promise<FscpBootstrapResult> {
  const ownerNorm = opts.ownerUserUuid.trim().toLowerCase();
  const localBytes = await deriveAgreementPublicKeyBytes(opts.material);
  const serverBytes = decodeAgreementPublicKeyBytes(opts.server.publicKeyBase64);

  if (!agreementPubkeysEqual(localBytes, serverBytes)) {
    return buildMismatchResult(opts.material, opts.server.publicKeyBase64);
  }

  let material: FscpLocalMaterial = {
    ...opts.material,
    deviceUuidFromServer: opts.server.deviceUuid ?? opts.material.deviceUuidFromServer,
  };
  await persistFscpLocalMaterial(opts.storage, ownerNorm, material);

  if (!material.deviceUuidFromServer) {
    const sync = await syncFscpDeviceUuid(
      opts.storage,
      ownerNorm,
      material,
      opts.server.publicKeyBase64,
    );
    if (!sync.ok) {
      return {
        status: "registration_pending",
        material,
        localPubKey: await agreementPublicKeyBase64Url(material),
        serverPubKey: opts.server.publicKeyBase64,
        pendingOperation: "sync_device_uuid",
      };
    }
    material = { ...material, deviceUuidFromServer: sync.deviceUuid };
  }

  return {
    status: "ready",
    material,
    localPubKey: await agreementPublicKeyBase64Url(material),
    serverPubKey: opts.server.publicKeyBase64,
    pendingOperation: null,
  };
}

export async function finalizeRestoredMaterial(opts: {
  storage: FscpKeyStorageAdapter;
  ownerUserUuid: string;
  material: FscpLocalMaterial;
  server?: UserE2eKeyBundle | null;
  deadline?: FscpDeadline;
  onAttemptStarted?: ReadAttemptStarted;
}): Promise<FscpBootstrapResult> {
  const ownerNorm = opts.ownerUserUuid.trim().toLowerCase();
  await persistFscpLocalMaterial(opts.storage, ownerNorm, opts.material);

  const deadline = opts.deadline ?? createFscpDeadline();
  const server =
    opts.server !== undefined
      ? opts.server
      : await retryRead(
          () => apiTryGetUserE2ePublicKey(ownerNorm),
          deadline,
          opts.onAttemptStarted,
        );
  if (!server?.publicKeyBase64) {
    return {
      status: "orphan_local_profile",
      material: opts.material,
      localPubKey: await agreementPublicKeyBase64Url(opts.material),
      pendingOperation: null,
    };
  }

  return finalizeWithServerPubkey({
    storage: opts.storage,
    ownerUserUuid: ownerNorm,
    material: opts.material,
    server,
  });
}

/** Когда backup и сервер согласованы, а локальные ключи — нет: восстановить с backup (mobile). */
export async function shouldPreferBackupOverLocal(opts: {
  local: FscpLocalMaterial;
  restored: FscpLocalMaterial;
  serverPublicKeyBase64?: string | null;
}): Promise<boolean> {
  const localPub = await deriveAgreementPublicKeyBytes(opts.local);
  const restoredPub = await deriveAgreementPublicKeyBytes(opts.restored);
  if (agreementPubkeysEqual(localPub, restoredPub)) return false;

  const serverKey = opts.serverPublicKeyBase64?.trim();
  if (!serverKey) return true;

  const serverPub = decodeAgreementPublicKeyBytes(serverKey);
  const localMatchesServer = agreementPubkeysEqual(localPub, serverPub);
  const restoredMatchesServer = agreementPubkeysEqual(restoredPub, serverPub);

  if (localMatchesServer && !restoredMatchesServer) return true;
  if (restoredMatchesServer && !localMatchesServer) return true;
  return false;
}

export async function resolveFscpMaterialOnDevice(opts: {
  storage: FscpKeyStorageAdapter;
  ownerUserUuid: string;
  accountPassword?: string;
  /** На новом устройстве (mobile): восстановить backup, если локальные ключи устарели. На web — false. */
  preferBackupOverLocal?: boolean;
  /** Mobile login: всегда восстановить из password backup, игнорируя local SecureStore. */
  forceRestoreFromBackupOnLogin?: boolean;
  /** Shared wall-clock budget for every retry point in this resolve. */
  deadline?: FscpDeadline;
  /** Counts idempotent read attempts; used by login-sync telemetry. */
  onAttemptStarted?: ReadAttemptStarted;
  /** Output-only handoff of already-read state to syncFscpOnLogin; never persisted. */
  readSnapshot?: ResolveReadSnapshot;
}): Promise<FscpBootstrapResult> {
  const ownerNorm = opts.ownerUserUuid.trim().toLowerCase();
  if (!ownerNorm) {
    return { status: "needs_restore", material: null, pendingOperation: null };
  }

  return serializeResolveForOwner(ownerNorm, async () => {
    // The default deadline starts only after this call owns the mutex. syncFscpOnLogin passes a
    // deferred deadline with the same property, so time spent waiting in the queue is not charged.
    const deadline = opts.deadline ?? createFscpDeadline();
    return resolveFscpMaterialInCriticalSection(opts, ownerNorm, deadline);
  });
}

async function resolveFscpMaterialInCriticalSection(
  opts: {
    storage: FscpKeyStorageAdapter;
    ownerUserUuid: string;
    accountPassword?: string;
    preferBackupOverLocal?: boolean;
    forceRestoreFromBackupOnLogin?: boolean;
    deadline?: FscpDeadline;
    onAttemptStarted?: ReadAttemptStarted;
    readSnapshot?: ResolveReadSnapshot;
  },
  ownerNorm: string,
  deadline: FscpDeadline,
): Promise<FscpBootstrapResult> {
  const local = await loadFscpLocalMaterial(opts.storage, ownerNorm);

  if (opts.accountPassword && opts.forceRestoreFromBackupOnLogin) {
    let raw: unknown;
    try {
      raw = await retryRead(() => apiGetKeyBackup(), deadline, opts.onAttemptStarted);
      if (opts.readSnapshot) opts.readSnapshot.knownBackup = { raw };
    } catch (e) {
      if (classifyTransportFailure(e) === "not_found") {
        if (opts.readSnapshot) opts.readSnapshot.knownBackup = { state: "missing" };
        /* no backup — fall through and validate the current local storage */
      } else {
        return restoreFailureResult({ error: e, material: local });
      }
    }

    if (raw !== undefined) {
      let restored: FscpLocalMaterial;
      try {
        restored = await restoreFromPasswordBackup(opts.accountPassword, raw);
        if (opts.readSnapshot) {
          opts.readSnapshot.knownBackup = { raw, state: "healthy" };
        }
      } catch (e) {
        if (opts.readSnapshot && isFscpBackupError(e)) {
          opts.readSnapshot.knownBackup = {
            raw,
            state:
              e.kind === "aead_auth_failed"
                ? "unreadable"
                : e.kind === "kdf_failed"
                  ? "kdf_failed"
                  : "malformed",
          };
        }
        return restoreFailureResult({ error: e, material: local });
      }

      try {
        return await finalizeRestoredMaterial({
          storage: opts.storage,
          ownerUserUuid: ownerNorm,
          material: restored,
          deadline,
          onAttemptStarted: opts.onAttemptStarted,
        });
      } catch (e) {
        return restoreFailureResult({ error: e, material: restored });
      }
    }
  }

  let knownServer: UserE2eKeyBundle | null | undefined;

  if (local && opts.accountPassword && opts.preferBackupOverLocal) {
    let raw: unknown;
    try {
      raw = await retryRead(() => apiGetKeyBackup(), deadline, opts.onAttemptStarted);
      if (opts.readSnapshot) opts.readSnapshot.knownBackup = { raw };
    } catch (e) {
      const failure = classifyTransportFailure(e);
      if (failure === "not_found") {
        if (opts.readSnapshot) opts.readSnapshot.knownBackup = { state: "missing" };
        /* no server backup — validate and keep local */
      } else {
        return restoreFailureResult({ error: e, material: local });
      }
    }

    if (raw !== undefined) {
      try {
        const restored = await restoreFromPasswordBackup(opts.accountPassword, raw);
        if (opts.readSnapshot) {
          opts.readSnapshot.knownBackup = { raw, state: "healthy" };
        }
        knownServer = await retryRead(
          () => apiTryGetUserE2ePublicKey(ownerNorm),
          deadline,
          opts.onAttemptStarted,
        );
        const preferBackup = await shouldPreferBackupOverLocal({
          local,
          restored,
          serverPublicKeyBase64: knownServer?.publicKeyBase64,
        });
        if (preferBackup) {
          try {
            return await finalizeRestoredMaterial({
              storage: opts.storage,
              ownerUserUuid: ownerNorm,
              material: restored,
              server: knownServer,
              deadline,
              onAttemptStarted: opts.onAttemptStarted,
            });
          } catch (e) {
            return restoreFailureResult({
              error: e,
              material: restored,
              serverPubKey: knownServer?.publicKeyBase64,
            });
          }
        }
      } catch (e) {
        if (isFscpBackupError(e) && e.kind === "aead_auth_failed") {
          // A proven-current login password can legitimately fail against an old backup.
          // Keep validating the local profile; ensureKeyBackupOnServer may heal it later.
          if (opts.readSnapshot) {
            opts.readSnapshot.knownBackup = { raw, state: "unreadable" };
          }
        } else {
          if (opts.readSnapshot && isFscpBackupError(e)) {
            opts.readSnapshot.knownBackup = {
              raw,
              state: e.kind === "kdf_failed" ? "kdf_failed" : "malformed",
            };
          }
          return restoreFailureResult({ error: e, material: local });
        }
      }
    }
  }

  if (local) {
    if (knownServer === undefined) {
      try {
        knownServer = await retryRead(
          () => apiTryGetUserE2ePublicKey(ownerNorm),
          deadline,
          opts.onAttemptStarted,
        );
      } catch (e) {
        return restoreFailureResult({ error: e, material: local });
      }
    }
    if (!knownServer?.publicKeyBase64) {
      return {
        status: "orphan_local_profile",
        material: local,
        localPubKey: await agreementPublicKeyBase64Url(local),
        pendingOperation: null,
      };
    }
    try {
      return await finalizeWithServerPubkey({
        storage: opts.storage,
        ownerUserUuid: ownerNorm,
        material: local,
        server: knownServer,
      });
    } catch (e) {
      return restoreFailureResult({
        error: e,
        material: local,
        serverPubKey: knownServer.publicKeyBase64,
      });
    }
  }

  let decision: {
    e2eState: MsgE2EState;
    server: UserE2eKeyBundle | null;
    knownBackup: KnownKeyBackup;
  };
  try {
    decision = await retryRead(async () => {
      const e2eState = await apiGetE2EState();
      const server = await apiTryGetUserE2ePublicKey(ownerNorm);
      let knownBackup = opts.readSnapshot?.knownBackup;
      if (!knownBackup) {
        try {
          knownBackup = { raw: await apiGetKeyBackup() };
        } catch (e) {
          if (!isApiRequestError(e) || e.status !== 404) throw e;
          knownBackup = { state: "missing" };
        }
      }
      return { e2eState, server, knownBackup };
    }, deadline, opts.onAttemptStarted);
  } catch (e) {
    // Server state is unknown: never derive mustRestore=false and never create a new identity.
    return restoreFailureResult({ error: e, material: null });
  }

  if (opts.readSnapshot) {
    opts.readSnapshot.knownE2eState = decision.e2eState;
    opts.readSnapshot.knownBackup = decision.knownBackup;
  }

  const hasServerPubKey = !!decision.server?.publicKeyBase64?.trim();
  const hasKeyBackup = decision.knownBackup.state !== "missing";
  const mustRestore = accountRequiresKeyRestore({
    hasServerPubKey,
    e2eState: decision.e2eState.state,
    hasKeyBackup,
  });

  if (!mustRestore) {
    const material = await createInitialFscpIdentity();
    await persistFscpLocalMaterial(opts.storage, ownerNorm, material);
    const pub = await publishAgreementPublicKey(material);
    if (!pub.ok) {
      return {
        status: "registration_pending",
        material,
        localPubKey: await agreementPublicKeyBase64Url(material),
        pendingOperation: "publish",
      };
    }
    const readyMaterial: FscpLocalMaterial = { ...material, deviceUuidFromServer: pub.deviceUuid };
    await persistFscpLocalMaterial(opts.storage, ownerNorm, readyMaterial);
    return {
      status: "ready",
      material: readyMaterial,
      localPubKey: await agreementPublicKeyBase64Url(readyMaterial),
      pendingOperation: null,
    };
  }

  if (!opts.accountPassword) {
    return {
      status: "needs_restore",
      material: null,
      pendingOperation: null,
      serverPubKey: decision.server?.publicKeyBase64 ?? undefined,
    };
  }

  if (decision.knownBackup.state === "missing" || !("raw" in decision.knownBackup)) {
    return {
      status: "backup_not_found",
      material: null,
      pendingOperation: null,
      serverPubKey: decision.server?.publicKeyBase64 ?? undefined,
      failure: "not_found",
    };
  }

  let restored: FscpLocalMaterial;
  try {
    restored = await restoreFromPasswordBackup(
      opts.accountPassword,
      decision.knownBackup.raw,
    );
    decision.knownBackup.state = "healthy";
    if (opts.readSnapshot) opts.readSnapshot.knownBackup = decision.knownBackup;
  } catch (e) {
    if (isFscpBackupError(e)) {
      decision.knownBackup.state =
        e.kind === "aead_auth_failed"
          ? "unreadable"
          : e.kind === "kdf_failed"
            ? "kdf_failed"
            : "malformed";
      if (opts.readSnapshot) opts.readSnapshot.knownBackup = decision.knownBackup;
    }
    return restoreFailureResult({
      error: e,
      material: null,
      serverPubKey: decision.server?.publicKeyBase64,
    });
  }

  try {
    return await finalizeRestoredMaterial({
      storage: opts.storage,
      ownerUserUuid: ownerNorm,
      material: restored,
      server: decision.server,
      deadline,
      onAttemptStarted: opts.onAttemptStarted,
    });
  } catch (e) {
    return restoreFailureResult({
      error: e,
      material: restored,
      serverPubKey: decision.server?.publicKeyBase64,
    });
  }
}

export async function retryPendingFscpOperation(opts: {
  storage: FscpKeyStorageAdapter;
  ownerUserUuid: string;
  material: FscpLocalMaterial;
  pendingOperation: FscpPendingOperation;
}): Promise<FscpBootstrapResult> {
  const ownerNorm = opts.ownerUserUuid.trim().toLowerCase();

  if (opts.pendingOperation === "publish") {
    const pub = await publishAgreementPublicKey(opts.material);
    if (!pub.ok) {
      return {
        status: "registration_pending",
        material: opts.material,
        localPubKey: await agreementPublicKeyBase64Url(opts.material),
        pendingOperation: "publish",
      };
    }
    const readyMaterial: FscpLocalMaterial = {
      ...opts.material,
      deviceUuidFromServer: pub.deviceUuid,
    };
    await persistFscpLocalMaterial(opts.storage, ownerNorm, readyMaterial);
    const server = await apiTryGetUserE2ePublicKey(ownerNorm);
    return {
      status: "ready",
      material: readyMaterial,
      localPubKey: await agreementPublicKeyBase64Url(readyMaterial),
      serverPubKey: server?.publicKeyBase64,
      pendingOperation: null,
    };
  }

  const sync = await syncFscpDeviceUuid(opts.storage, ownerNorm, opts.material);
  if (!sync.ok) {
    const server = await apiTryGetUserE2ePublicKey(ownerNorm);
    return {
      status: "registration_pending",
      material: opts.material,
      localPubKey: await agreementPublicKeyBase64Url(opts.material),
      serverPubKey: server?.publicKeyBase64,
      pendingOperation: "sync_device_uuid",
    };
  }
  const readyMaterial: FscpLocalMaterial = {
    ...opts.material,
    deviceUuidFromServer: sync.deviceUuid,
  };
  const server = await apiTryGetUserE2ePublicKey(ownerNorm);
  return {
    status: "ready",
    material: readyMaterial,
    localPubKey: await agreementPublicKeyBase64Url(readyMaterial),
    serverPubKey: server?.publicKeyBase64,
    pendingOperation: null,
  };
}

export async function publishLocalKeyConfirmed(opts: {
  storage: FscpKeyStorageAdapter;
  ownerUserUuid: string;
  material: FscpLocalMaterial;
}): Promise<FscpBootstrapResult> {
  const pub = await publishAgreementPublicKey(opts.material);
  const ownerNorm = opts.ownerUserUuid.trim().toLowerCase();
  if (!pub.ok) {
    return {
      status: "registration_pending",
      material: opts.material,
      localPubKey: await agreementPublicKeyBase64Url(opts.material),
      pendingOperation: "publish",
    };
  }
  const readyMaterial: FscpLocalMaterial = {
    ...opts.material,
    deviceUuidFromServer: pub.deviceUuid,
  };
  await persistFscpLocalMaterial(opts.storage, ownerNorm, readyMaterial);
  const server = await apiTryGetUserE2ePublicKey(ownerNorm);
  return {
    status: "ready",
    material: readyMaterial,
    localPubKey: await agreementPublicKeyBase64Url(readyMaterial),
    serverPubKey: server?.publicKeyBase64,
    pendingOperation: null,
  };
}
