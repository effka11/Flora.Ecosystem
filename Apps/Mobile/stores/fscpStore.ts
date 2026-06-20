import { create } from "zustand";
import type { FscpLocalMaterial } from "@flora/client-core/fscp";
import {
  canDecryptFscp,
  canSendFscp,
  decryptKeyBackup,
  decryptMessageWire,
  decryptRecoveryBackup,
  decryptMessagePreview,
  extractTextFromPlaintext,
  finalizeRestoredMaterial,
  parseKeyBackupPayload,
  publishLocalKeyConfirmed as publishLocalKeyConfirmedCore,
  resolveFscpMaterialOnDevice,
  restoreLocalMaterialFromBackupPlaintext,
  retryPendingFscpOperation,
  syncFscpOnLogin,
  type FscpBootstrapResult,
  type FscpBootstrapStatus,
  type FscpMessagePlaintext,
  type FscpPendingOperation,
  type RecoveryBackupPayloadOut,
} from "@flora/client-core/fscp";
import { apiGetKeyBackup, apiGetRecoveryBackup } from "@flora/client-core/api";
import { clearFscpMaterialForUser } from "@flora/client-core/fscp";
import { getTelemetry } from "@flora/client-core/telemetry";
import { mobileFscpKeyStorage } from "@/lib/fscp/storage";
import { messageThreadCache } from "@/stores/messageThreadCache";

function applyBootstrapResult(result: FscpBootstrapResult): Partial<FscpState> {
  return {
    status: result.status,
    material: result.material,
    localPubKey: result.localPubKey ?? null,
    serverPubKey: result.serverPubKey ?? null,
    pendingOperation: result.pendingOperation,
    unlocked: result.status === "ready",
  };
}

type FscpState = {
  status: FscpBootstrapStatus;
  material: FscpLocalMaterial | null;
  localPubKey: string | null;
  serverPubKey: string | null;
  pendingOperation: FscpPendingOperation | null;
  ownerUserUuid: string | null;
  unlocked: boolean;
  canDecrypt: () => boolean;
  canSend: () => boolean;
  bootstrap: (ownerUserUuid: string, accountPassword?: string) => Promise<FscpBootstrapResult>;
  syncOnLogin: (ownerUserUuid: string, accountPassword: string) => Promise<FscpBootstrapResult>;
  syncKeysFromAccountPassword: (
    ownerUserUuid: string,
    accountPassword: string,
  ) => Promise<FscpBootstrapResult>;
  restoreWithAccountPassword: (
    ownerUserUuid: string,
    accountPassword: string,
  ) => Promise<FscpBootstrapResult>;
  /** First device at registration: create + publish identity AND upload the initial backup. */
  provisionKeysAtRegistration: (
    ownerUserUuid: string,
    accountPassword: string,
  ) => Promise<FscpBootstrapResult>;
  passwordSyncedForOwner: string | null;
  publishLocalKeyConfirmed: () => Promise<void>;
  retryPendingOperation: () => Promise<void>;
  unlock: (input: { password?: string; phrase?: string }) => Promise<void>;
  deleteLocalMaterial: () => Promise<void>;
  decryptWire: (wire: string, viewerUserUuid: string) => Promise<string>;
  decryptWirePlaintext: (wire: string, viewerUserUuid: string) => Promise<FscpMessagePlaintext>;
  decryptPreview: (
    encryptedPayload: string | null | undefined,
    viewerUserUuid: string,
  ) => Promise<string | null>;
  lock: () => void;
  clearRuntimeState: () => void;
};

const initialRuntime = {
  status: "needs_restore" as FscpBootstrapStatus,
  material: null,
  localPubKey: null,
  serverPubKey: null,
  pendingOperation: null,
  ownerUserUuid: null,
  unlocked: false,
  passwordSyncedForOwner: null as string | null,
};

export const useFscpStore = create<FscpState>((set, get) => ({
  ...initialRuntime,
  canDecrypt() {
    const s = get();
    return canDecryptFscp({
      status: s.status,
      material: s.material,
      pendingOperation: s.pendingOperation,
    });
  },
  canSend() {
    const s = get();
    return canSendFscp({
      status: s.status,
      material: s.material,
      pendingOperation: s.pendingOperation,
    });
  },
  async bootstrap(ownerUserUuid, accountPassword) {
    const prevStatus = get().status;
    const result = await resolveFscpMaterialOnDevice({
      storage: mobileFscpKeyStorage,
      ownerUserUuid,
      accountPassword,
      preferBackupOverLocal: !!accountPassword,
    });
    const ownerNorm = ownerUserUuid.trim().toLowerCase();
    set({
      ...applyBootstrapResult(result),
      ownerUserUuid: ownerNorm,
    });
    if (result.status === "ready" && prevStatus !== "ready") {
      messageThreadCache.clearDecryptCaches();
    }
    return result;
  },
  async syncOnLogin(ownerUserUuid, accountPassword) {
    const sync = await syncFscpOnLogin({
      storage: mobileFscpKeyStorage,
      ownerUserUuid,
      accountPassword,
      preferBackupOverLocal: true,
      forceRestoreFromBackupOnLogin: true,
      skipKeyBackupUpload: true,
    });
    const ownerNorm = ownerUserUuid.trim().toLowerCase();
    set({
      ...applyBootstrapResult(sync.bootstrap),
      ownerUserUuid: ownerNorm,
      passwordSyncedForOwner: sync.bootstrap.status === "ready" ? ownerNorm : null,
    });
    if (sync.bootstrap.status === "ready") {
      messageThreadCache.clearDecryptCaches();
    }
    return sync.bootstrap;
  },
  async restoreWithAccountPassword(ownerUserUuid, accountPassword) {
    const ownerNorm = ownerUserUuid.trim().toLowerCase();
    const telemetry = getTelemetry();
    const { status } = get();
    const result =
      status === "key_mismatch"
        ? await get().syncKeysFromAccountPassword(ownerUserUuid, accountPassword)
        : await get().syncOnLogin(ownerUserUuid, accountPassword);
    if (result.status === "ready") {
      set({ passwordSyncedForOwner: ownerNorm });
      telemetry.capture({ type: "restore_success" });
    } else if (result.status === "wrong_password") {
      telemetry.capture({ type: "restore_failure", reason: "wrong_password" });
    } else if (result.status === "backup_not_found") {
      telemetry.capture({ type: "restore_failure", reason: "backup_not_found" });
    }
    return result;
  },
  async provisionKeysAtRegistration(ownerUserUuid, accountPassword) {
    // First device for a brand-new account: create + publish identity and upload the initial
    // backup (nothing to clobber). This is the ONLY mobile path that uploads a key backup —
    // every other mobile path is restore-only (see syncOnLogin skipKeyBackupUpload).
    const sync = await syncFscpOnLogin({
      storage: mobileFscpKeyStorage,
      ownerUserUuid,
      accountPassword,
      preferBackupOverLocal: false,
      forceRestoreFromBackupOnLogin: false,
      skipKeyBackupUpload: false,
      authoritativeOverwrite: true,
    });
    const ownerNorm = ownerUserUuid.trim().toLowerCase();
    set({
      ...applyBootstrapResult(sync.bootstrap),
      ownerUserUuid: ownerNorm,
      passwordSyncedForOwner: sync.bootstrap.status === "ready" ? ownerNorm : null,
    });
    if (sync.bootstrap.status === "ready") {
      messageThreadCache.clearDecryptCaches();
    }
    return sync.bootstrap;
  },
  async syncKeysFromAccountPassword(ownerUserUuid, accountPassword) {
    await clearFscpMaterialForUser(mobileFscpKeyStorage, ownerUserUuid.trim().toLowerCase());
    set({
      material: null,
      localPubKey: null,
      serverPubKey: null,
      status: "needs_restore",
      pendingOperation: null,
      unlocked: false,
      passwordSyncedForOwner: null,
    });
    messageThreadCache.clearDecryptCaches();
    return get().syncOnLogin(ownerUserUuid, accountPassword);
  },
  async publishLocalKeyConfirmed() {
    const { material, ownerUserUuid, status } = get();
    if (!material || !ownerUserUuid) return;
    if (status !== "orphan_local_profile" && status !== "key_mismatch") return;
    const result = await publishLocalKeyConfirmedCore({
      storage: mobileFscpKeyStorage,
      ownerUserUuid,
      material,
    });
    set(applyBootstrapResult(result));
    if (result.status === "ready") {
      messageThreadCache.clearDecryptCaches();
    }
  },
  async retryPendingOperation() {
    const { material, ownerUserUuid, status, pendingOperation } = get();
    if (status !== "registration_pending" || !material || !ownerUserUuid || !pendingOperation) {
      return;
    }
    const result = await retryPendingFscpOperation({
      storage: mobileFscpKeyStorage,
      ownerUserUuid,
      material,
      pendingOperation,
    });
    set(applyBootstrapResult(result));
    if (result.status === "ready") {
      messageThreadCache.clearDecryptCaches();
    }
  },
  async unlock(input) {
    const ownerUserUuid = get().ownerUserUuid;
    if (!ownerUserUuid) throw new Error("FSCP: пользователь не определён");

    let restored: FscpLocalMaterial;
    if (input.password) {
      const raw = await apiGetKeyBackup();
      const plaintext = await decryptKeyBackup(parseKeyBackupPayload(raw), input.password);
      const keys = await restoreLocalMaterialFromBackupPlaintext(plaintext);
      restored = {
        agreementPrivateKey: keys.agreementPrivateKey,
        signingPrivateKey: keys.signingPrivateKey,
        deviceUuidFromServer: null,
      };
    } else if (input.phrase) {
      const raw = (await apiGetRecoveryBackup()) as RecoveryBackupPayloadOut;
      const plaintext = await decryptRecoveryBackup(raw, input.phrase);
      const keys = await restoreLocalMaterialFromBackupPlaintext(plaintext);
      restored = {
        agreementPrivateKey: keys.agreementPrivateKey,
        signingPrivateKey: keys.signingPrivateKey,
        deviceUuidFromServer: null,
      };
    } else {
      throw new Error("Укажите пароль или recovery phrase");
    }

    const result = await finalizeRestoredMaterial({
      storage: mobileFscpKeyStorage,
      ownerUserUuid,
      material: restored,
    });
    const ownerNorm = ownerUserUuid.trim().toLowerCase();
    set({
      ...applyBootstrapResult(result),
      passwordSyncedForOwner: result.status === "ready" ? ownerNorm : null,
    });
    if (result.status === "ready") {
      messageThreadCache.clearDecryptCaches();
    }
  },
  async deleteLocalMaterial() {
    const ownerUserUuid = get().ownerUserUuid;
    if (!ownerUserUuid) return;
    await clearFscpMaterialForUser(mobileFscpKeyStorage, ownerUserUuid);
    set({
      material: null,
      localPubKey: null,
      serverPubKey: null,
      status: "needs_restore",
      pendingOperation: null,
      unlocked: false,
    });
  },
  async decryptWire(wire, viewerUserUuid) {
    const plain = await get().decryptWirePlaintext(wire, viewerUserUuid);
    return extractTextFromPlaintext(plain);
  },
  async decryptWirePlaintext(wire, viewerUserUuid) {
    if (!get().canDecrypt()) throw new Error("FSCP не готов к расшифровке");
    const material = get().material;
    if (!material) throw new Error("FSCP не инициализирован");
    return decryptMessageWire({
      wire,
      viewerUserUuid,
      agreementPrivateKey: material.agreementPrivateKey,
    });
  },
  async decryptPreview(encryptedPayload, viewerUserUuid) {
    if (!get().canDecrypt()) return null;
    const material = get().material;
    if (!material) return null;
    return decryptMessagePreview({
      encryptedPayload,
      viewerUserUuid,
      agreementPrivateKey: material.agreementPrivateKey,
    });
  },
  lock() {
    set({ unlocked: false });
  },
  clearRuntimeState() {
    set({ ...initialRuntime, passwordSyncedForOwner: null });
  },
}));
