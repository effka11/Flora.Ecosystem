import { isApiRequestError } from "../api/errors.js";
import {
  apiGetE2EState,
  apiGetKeyBackup,
  apiPutKeyBackup,
  type PutKeyBackupRequest,
} from "../api/messaging.js";
import { asRecord, readNum } from "../contracts/parse.js";
import { getTelemetry } from "../telemetry/index.js";
import type { FscpKeyStorageAdapter } from "./keyStorage.js";
import {
  bootstrapPlaintextFromLocalMaterial,
  classifyKeyBackup,
  createKeyBackup,
  type FscpBackupState,
} from "./keyBackup.js";
import {
  deriveAgreementPublicKeyBytes,
  localMaterialSelfCheck,
  type FscpLocalMaterial,
} from "./keys.js";
import { floraNewUuid } from "./floraUuid.js";
import {
  agreementPubkeysEqual,
  decodeAgreementPublicKeyBytes,
  publishAgreementPublicKey,
  publishLocalKeyConfirmed,
  resolveFscpMaterialOnDevice,
  retryPendingFscpOperation,
  type FscpBootstrapResult,
} from "./bootstrap.js";
import { apiTryGetUserE2ePublicKey } from "./messaging.js";

export type SyncFscpOnLoginResult = {
  bootstrap: FscpBootstrapResult;
  backupUploaded: boolean;
  backupSkippedReason?:
    | "not_ready"
    | "locked_or_frozen"
    | "unchanged"
    | "no_password"
    | "conflict"
    | "upload_error"
    | "not_authenticated"
    | "pubkey_mismatch"
    | "self_check_failed"
    | "malformed";
};

function readBackupRevision(raw: unknown): number {
  const o = asRecord(raw);
  if (!o) return 0;
  return readNum(o, ["backupRevision", "BackupRevision"]) ?? 0;
}

function epochIdentityPublicKeysFromPlaintext(
  plaintext: Awaited<ReturnType<typeof bootstrapPlaintextFromLocalMaterial>>,
): PutKeyBackupRequest["epochIdentityPublicKeys"] {
  return plaintext.keyEpochs.map((epoch) => ({
    keyEpochId: epoch.keyEpochId,
    epochAccountIdentityPublicKeyBase64Url: epoch.epochAccountIdentityPublicKeyBase64Url,
  }));
}

export async function ensureKeyBackupOnServer(opts: {
  ownerUserUuid: string;
  accountPassword: string;
  material: FscpLocalMaterial;
  /**
   * Allow CREATING/OVERWRITING the server backup with the current local material.
   * MUST be true ONLY where the password was just proven current — immediately after a
   * successful apiLogin or at registration. Live sessions / inline unlock modals pass false:
   * they are restore-only and must never clobber a backup encrypted under a newer password
   * (e.g. another device just changed the account password). See review п.2 / "Модель безопасности".
   */
  authoritativeOverwrite?: boolean;
}): Promise<{ uploaded: boolean; skippedReason?: SyncFscpOnLoginResult["backupSkippedReason"] }> {
  const telemetry = getTelemetry();
  const ownerNorm = opts.ownerUserUuid.trim().toLowerCase();
  if (!ownerNorm || !opts.accountPassword.trim()) {
    return { uploaded: false, skippedReason: "no_password" };
  }

  const e2eState = await apiGetE2EState();
  if (e2eState.freeze || e2eState.state === "locked") {
    return { uploaded: false, skippedReason: "locked_or_frozen" };
  }

  const localPub = await deriveAgreementPublicKeyBytes(opts.material);
  const plaintext = await bootstrapPlaintextFromLocalMaterial(
    opts.material.agreementPrivateKey,
    opts.material.signingPrivateKey,
  );
  const epochIdentityPublicKeys = epochIdentityPublicKeysFromPlaintext(plaintext);

  // Determine the readability of the existing backup (single source of truth).
  let existingRevision = 0;
  let state: FscpBackupState = "missing";
  try {
    const existingRaw = await apiGetKeyBackup();
    existingRevision = readBackupRevision(existingRaw);
    const cls = await classifyKeyBackup(existingRaw, opts.accountPassword);
    state = cls.state;
    // A readable backup is never clobbered here — overwrite is reserved for missing/unreadable.
    if (cls.state === "healthy") {
      return { uploaded: false, skippedReason: "unchanged" };
    }
  } catch (e) {
    if (isApiRequestError(e) && e.status === 404) {
      state = "missing";
    } else {
      // Transient network/server error: NOT a password problem. Let syncFscpOnLogin map it.
      throw e;
    }
  }

  if (state === "unreadable" || state === "malformed") {
    telemetry.capture({ type: "backup_decrypt_failed", state });
  }

  // Malformed backups are never silently overwritten — surface for investigation (review п.4).
  if (state === "malformed") {
    telemetry.capture({ type: "backup_overwrite_skipped", reason: "malformed" });
    return { uploaded: false, skippedReason: "malformed" };
  }

  // From here state is "missing" or "unreadable": writing requires a proven-current password.
  if (!opts.authoritativeOverwrite) {
    telemetry.capture({ type: "backup_overwrite_skipped", reason: "not_authenticated" });
    return { uploaded: false, skippedReason: "not_authenticated" };
  }

  // Confirm THIS device is the authoritative identity and its keys are self-consistent
  // before letting it overwrite the only recoverable backup (review п.1, п.2).
  let server = await apiTryGetUserE2ePublicKey(ownerNorm);
  let serverPubStr = server?.publicKeyBase64?.trim();
  // First registration: bootstrap may be "ready" after PUT pubkey while GET still 404, or publish
  // failed earlier and orphan was healed in syncFscpOnLogin — publish once when password is authoritative.
  if (!serverPubStr && opts.authoritativeOverwrite) {
    const published = await publishAgreementPublicKey(opts.material);
    if (published.ok) {
      server = await apiTryGetUserE2ePublicKey(ownerNorm);
      serverPubStr = server?.publicKeyBase64?.trim();
    }
  }
  if (!serverPubStr) {
    telemetry.capture({ type: "backup_overwrite_skipped", reason: "pubkey_mismatch" });
    return { uploaded: false, skippedReason: "pubkey_mismatch" };
  }
  const serverPub = decodeAgreementPublicKeyBytes(serverPubStr);
  if (!agreementPubkeysEqual(localPub, serverPub)) {
    telemetry.capture({ type: "backup_overwrite_skipped", reason: "pubkey_mismatch" });
    return { uploaded: false, skippedReason: "pubkey_mismatch" };
  }
  if (!(await localMaterialSelfCheck(opts.material, serverPub))) {
    telemetry.capture({ type: "backup_overwrite_skipped", reason: "self_check_failed" });
    return { uploaded: false, skippedReason: "self_check_failed" };
  }

  const backupKeyId = floraNewUuid();
  const keyBackup = await createKeyBackup({
    userUuid: ownerNorm,
    password: opts.accountPassword,
    plaintext,
    backupRevision: Math.max(existingRevision, 0) + 1,
    epochSetRevision: 1,
    backupKeyId,
  });

  try {
    await apiPutKeyBackup({
      keyBackup,
      epochIdentityPublicKeys,
    });
  } catch (e) {
    if (isApiRequestError(e) && e.status === 409) {
      return { uploaded: false, skippedReason: "conflict" };
    }
    throw e;
  }

  // Healed a previously broken (old-password / corrupted) backup — record it.
  if (state === "unreadable") {
    telemetry.capture({ type: "backup_self_healed", previousState: "unreadable" });
  }
  return { uploaded: true };
}

export async function syncFscpOnLogin(opts: {
  storage: FscpKeyStorageAdapter;
  ownerUserUuid: string;
  accountPassword: string;
  autoPublishOnMismatch?: boolean;
  preferBackupOverLocal?: boolean;
  forceRestoreFromBackupOnLogin?: boolean;
  /**
   * Web/mobile asymmetry (intentional, not a bug — review п.3):
   * - Web holds the AUTHORITATIVE local material (created at first setup) and is the backup keeper,
   *   so it uploads/heals (skipKeyBackupUpload omitted/false).
   * - Mobile DERIVES its material FROM the backup (restore-only) and must never push, except at
   *   registration on the first device, so it passes skipKeyBackupUpload: true on every login.
   */
  skipKeyBackupUpload?: boolean;
  /**
   * Forwarded to ensureKeyBackupOnServer: true only right after a successful apiLogin / at
   * registration (password proven current). Inline unlock modals / live sessions pass false.
   */
  authoritativeOverwrite?: boolean;
}): Promise<SyncFscpOnLoginResult> {
  const password = opts.accountPassword?.trim();
  if (!password) {
    const bootstrap = await resolveFscpMaterialOnDevice({
      storage: opts.storage,
      ownerUserUuid: opts.ownerUserUuid,
    });
    return { bootstrap, backupUploaded: false, backupSkippedReason: "no_password" };
  }

  let bootstrap = await resolveFscpMaterialOnDevice({
    storage: opts.storage,
    ownerUserUuid: opts.ownerUserUuid,
    accountPassword: password,
    preferBackupOverLocal: opts.preferBackupOverLocal,
    forceRestoreFromBackupOnLogin: opts.forceRestoreFromBackupOnLogin,
  });

  const autoPublish = opts.autoPublishOnMismatch !== false;
  if (
    autoPublish &&
    bootstrap.status === "key_mismatch" &&
    bootstrap.material
  ) {
    bootstrap = await publishLocalKeyConfirmed({
      storage: opts.storage,
      ownerUserUuid: opts.ownerUserUuid,
      material: bootstrap.material,
    });
  }

  // First registration: local keys may exist while server publish failed (e.g. API/DB not ready).
  if (
    bootstrap.status === "registration_pending" &&
    bootstrap.material &&
    bootstrap.pendingOperation
  ) {
    bootstrap = await retryPendingFscpOperation({
      storage: opts.storage,
      ownerUserUuid: opts.ownerUserUuid,
      material: bootstrap.material,
      pendingOperation: bootstrap.pendingOperation,
    });
  }

  // Local profile without server pubkey — publish before backup when password is authoritative.
  if (
    bootstrap.status === "orphan_local_profile" &&
    bootstrap.material &&
    opts.authoritativeOverwrite
  ) {
    bootstrap = await publishLocalKeyConfirmed({
      storage: opts.storage,
      ownerUserUuid: opts.ownerUserUuid,
      material: bootstrap.material,
    });
  }

  if (bootstrap.status !== "ready" || !bootstrap.material) {
    return { bootstrap, backupUploaded: false, backupSkippedReason: "not_ready" };
  }

  if (opts.skipKeyBackupUpload) {
    return { bootstrap, backupUploaded: false };
  }

  try {
    const backup = await ensureKeyBackupOnServer({
      ownerUserUuid: opts.ownerUserUuid,
      accountPassword: password,
      material: bootstrap.material,
      authoritativeOverwrite: opts.authoritativeOverwrite,
    });

    return {
      bootstrap,
      backupUploaded: backup.uploaded,
      backupSkippedReason: backup.skippedReason,
    };
  } catch {
    return { bootstrap, backupUploaded: false, backupSkippedReason: "upload_error" };
  }
}
