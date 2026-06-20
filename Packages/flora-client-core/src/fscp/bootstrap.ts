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

import { isApiRequestError } from "../api/errors.js";
import { apiGetE2EState, apiGetKeyBackup } from "../api/messaging.js";
import { fromBase64Flexible } from "./base64url.js";
import {
  decryptKeyBackup,
  parseKeyBackupPayload,
  restoreLocalMaterialFromBackupPlaintext,
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
import { apiPutMyE2ePublicKey, apiTryGetUserE2ePublicKey } from "./messaging.js";

export type FscpBootstrapStatus =
  | "ready"
  | "not_initialized"
  | "needs_restore"
  | "wrong_password"
  | "backup_not_found"
  | "key_mismatch"
  | "orphan_local_profile"
  | "registration_pending";

export type FscpPendingOperation = "publish" | "sync_device_uuid";

export type FscpBootstrapResult = {
  status: FscpBootstrapStatus;
  material: FscpLocalMaterial | null;
  localPubKey?: string;
  serverPubKey?: string;
  pendingOperation: FscpPendingOperation | null;
};

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
): Promise<PublishResult> {
  const ownerNorm = ownerUserUuid.trim().toLowerCase();
  const server = await apiTryGetUserE2ePublicKey(ownerNorm);
  if (!server?.publicKeyBase64) {
    return { ok: false, error: "server pubkey not found" };
  }

  const localBytes = await deriveAgreementPublicKeyBytes(material);
  const serverBytes = decodeAgreementPublicKeyBytes(server.publicKeyBase64);
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
): Promise<FscpLocalMaterial> {
  const raw = await apiGetKeyBackup();
  const payload = parseKeyBackupPayload(raw);
  const plaintext = await decryptKeyBackup(payload, password);
  const restored = await restoreLocalMaterialFromBackupPlaintext(plaintext);
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

async function finalizeWithServerPubkey(opts: {
  storage: FscpKeyStorageAdapter;
  ownerUserUuid: string;
  material: FscpLocalMaterial;
  serverPublicKeyBase64: string;
  serverDeviceUuid: string | null;
}): Promise<FscpBootstrapResult> {
  const ownerNorm = opts.ownerUserUuid.trim().toLowerCase();
  const localBytes = await deriveAgreementPublicKeyBytes(opts.material);
  const serverBytes = decodeAgreementPublicKeyBytes(opts.serverPublicKeyBase64);

  if (!agreementPubkeysEqual(localBytes, serverBytes)) {
    return buildMismatchResult(opts.material, opts.serverPublicKeyBase64);
  }

  let material: FscpLocalMaterial = {
    ...opts.material,
    deviceUuidFromServer: opts.serverDeviceUuid ?? opts.material.deviceUuidFromServer,
  };
  await persistFscpLocalMaterial(opts.storage, ownerNorm, material);

  if (!material.deviceUuidFromServer) {
    const sync = await syncFscpDeviceUuid(opts.storage, ownerNorm, material);
    if (!sync.ok) {
      return {
        status: "registration_pending",
        material,
        localPubKey: await agreementPublicKeyBase64Url(material),
        serverPubKey: opts.serverPublicKeyBase64,
        pendingOperation: "sync_device_uuid",
      };
    }
    material = { ...material, deviceUuidFromServer: sync.deviceUuid };
  }

  return {
    status: "ready",
    material,
    localPubKey: await agreementPublicKeyBase64Url(material),
    serverPubKey: opts.serverPublicKeyBase64,
    pendingOperation: null,
  };
}

export async function finalizeRestoredMaterial(opts: {
  storage: FscpKeyStorageAdapter;
  ownerUserUuid: string;
  material: FscpLocalMaterial;
}): Promise<FscpBootstrapResult> {
  const ownerNorm = opts.ownerUserUuid.trim().toLowerCase();
  await persistFscpLocalMaterial(opts.storage, ownerNorm, opts.material);

  const server = await apiTryGetUserE2ePublicKey(ownerNorm);
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
    serverPublicKeyBase64: server.publicKeyBase64,
    serverDeviceUuid: server.deviceUuid,
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
}): Promise<FscpBootstrapResult> {
  const ownerNorm = opts.ownerUserUuid.trim().toLowerCase();
  if (!ownerNorm) {
    return { status: "needs_restore", material: null, pendingOperation: null };
  }

  if (opts.accountPassword && opts.forceRestoreFromBackupOnLogin) {
    try {
      const restored = await restoreFromPasswordBackup(opts.accountPassword);
      return finalizeRestoredMaterial({
        storage: opts.storage,
        ownerUserUuid: ownerNorm,
        material: restored,
      });
    } catch (e) {
      if (isApiRequestError(e) && e.status === 404) {
        /* no backup — fall through */
      } else if (
        e instanceof Error &&
        (e.message.includes("Неверный пароль") || e.message.includes("поврежд"))
      ) {
        return { status: "wrong_password", material: null, pendingOperation: null };
      } else if (isApiRequestError(e)) {
        throw e;
      } else {
        throw e;
      }
    }
  }

  const local = await loadFscpLocalMaterial(opts.storage, ownerNorm);

  if (local && opts.accountPassword && opts.preferBackupOverLocal) {
    try {
      const restored = await restoreFromPasswordBackup(opts.accountPassword);
      const server = await apiTryGetUserE2ePublicKey(ownerNorm);
      const preferBackup = await shouldPreferBackupOverLocal({
        local,
        restored,
        serverPublicKeyBase64: server?.publicKeyBase64,
      });
      if (preferBackup) {
        return finalizeRestoredMaterial({
          storage: opts.storage,
          ownerUserUuid: ownerNorm,
          material: restored,
        });
      }
    } catch (e) {
      if (isApiRequestError(e) && e.status === 404) {
        /* no server backup — keep local */
      } else if (
        !(e instanceof Error) ||
        (!e.message.includes("Неверный пароль") && !e.message.includes("поврежд"))
      ) {
        if (isApiRequestError(e)) throw e;
      }
    }
  }

  if (local) {
    const server = await apiTryGetUserE2ePublicKey(ownerNorm);
    if (!server?.publicKeyBase64) {
      return {
        status: "orphan_local_profile",
        material: local,
        localPubKey: await agreementPublicKeyBase64Url(local),
        pendingOperation: null,
      };
    }
    return finalizeWithServerPubkey({
      storage: opts.storage,
      ownerUserUuid: ownerNorm,
      material: local,
      serverPublicKeyBase64: server.publicKeyBase64,
      serverDeviceUuid: server.deviceUuid,
    });
  }

  const e2eState = await apiGetE2EState();
  const server = await apiTryGetUserE2ePublicKey(ownerNorm);
  const hasServerPubKey = !!server?.publicKeyBase64?.trim();

  let hasKeyBackup = false;
  try {
    await apiGetKeyBackup();
    hasKeyBackup = true;
  } catch (e) {
    if (!isApiRequestError(e) || e.status !== 404) throw e;
  }

  const mustRestore = accountRequiresKeyRestore({
    hasServerPubKey,
    e2eState: e2eState.state,
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
      serverPubKey: server?.publicKeyBase64 ?? undefined,
    };
  }

  try {
    const restored = await restoreFromPasswordBackup(opts.accountPassword);
    return finalizeRestoredMaterial({
      storage: opts.storage,
      ownerUserUuid: ownerNorm,
      material: restored,
    });
  } catch (e) {
    if (isApiRequestError(e) && e.status === 404) {
      return {
        status: "backup_not_found",
        material: null,
        pendingOperation: null,
        serverPubKey: server?.publicKeyBase64 ?? undefined,
      };
    }
    if (e instanceof Error && e.message.includes("Некорректный payload")) {
      throw e;
    }
    return {
      status: "wrong_password",
      material: null,
      pendingOperation: null,
      serverPubKey: server?.publicKeyBase64 ?? undefined,
    };
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
