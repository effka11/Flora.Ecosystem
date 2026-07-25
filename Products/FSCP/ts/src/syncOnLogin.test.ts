import { createRequire } from "node:module";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@flora/client-core/api/errors.js";
import { configureSodiumLoader, type SodiumModule } from "./sodium.js";
import { configureFscpKdf } from "./kdf.js";
import { configureTelemetry, type TelemetryEvent } from "@flora/client-core/telemetry/index.js";
import {
  agreementPublicKeyBase64Url,
  createInitialFscpIdentity,
  persistFscpLocalMaterial,
  type FscpLocalMaterial,
} from "./keys.js";
import type { FscpKeyStorageAdapter, FscpProfileRecord } from "./keyStorage.js";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers-sumo") as SodiumModule;

const mockGetE2EState = vi.fn();
const mockGetKeyBackup = vi.fn();
const mockPutKeyBackup = vi.fn();
const mockTryGetUserE2ePublicKey = vi.fn();
const mockPutMyE2ePublicKey = vi.fn();
const mockCreateKeyBackup = vi.fn();
const mockClassifyKeyBackup = vi.fn();

vi.mock("@flora/client-core/api/messaging.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@flora/client-core/api/messaging.js")>();
  return {
    ...actual,
    apiGetE2EState: () => mockGetE2EState(),
    apiGetKeyBackup: () => mockGetKeyBackup(),
    apiPutKeyBackup: (...args: unknown[]) => mockPutKeyBackup(...args),
  };
});

vi.mock("./messaging.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./messaging.js")>();
  return {
    ...actual,
    apiTryGetUserE2ePublicKey: (...args: unknown[]) => mockTryGetUserE2ePublicKey(...args),
    apiPutMyE2ePublicKey: (...args: unknown[]) => mockPutMyE2ePublicKey(...args),
  };
});

vi.mock("./keyBackup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./keyBackup.js")>();
  return {
    ...actual,
    createKeyBackup: (...args: unknown[]) => mockCreateKeyBackup(...args),
    classifyKeyBackup: (...args: unknown[]) => mockClassifyKeyBackup(...args),
  };
});

let realMaterial: FscpLocalMaterial;
let realPubB64: string;
let otherPubB64: string;
let events: TelemetryEvent[];

beforeAll(async () => {
  await sodium.ready;
  configureSodiumLoader(async () => sodium);
  realMaterial = await createInitialFscpIdentity();
  realPubB64 = await agreementPublicKeyBase64Url(realMaterial);
  const other = await createInitialFscpIdentity();
  otherPubB64 = await agreementPublicKeyBase64Url(other);
});

const activeState = () => ({ state: "active", freeze: false, updatedAt: new Date().toISOString() });

describe("ensureKeyBackupOnServer", () => {
  beforeEach(() => {
    mockGetE2EState.mockReset();
    mockGetKeyBackup.mockReset();
    mockPutKeyBackup.mockReset();
    mockTryGetUserE2ePublicKey.mockReset();
    mockPutMyE2ePublicKey.mockReset();
    mockPutMyE2ePublicKey.mockResolvedValue({ deviceUuid: "device-uuid" });
    mockCreateKeyBackup.mockReset();
    mockClassifyKeyBackup.mockReset();
    mockCreateKeyBackup.mockResolvedValue({ ciphertext: "stub" });
    mockPutKeyBackup.mockResolvedValue({});
    events = [];
    configureTelemetry({ capture: (e) => events.push(e), captureException: () => {} });
  });

  it("skips upload when E2E state is locked", async () => {
    const { ensureKeyBackupOnServer } = await import("./syncOnLogin.js");
    mockGetE2EState.mockResolvedValue({ state: "locked", freeze: false, updatedAt: "" });

    const result = await ensureKeyBackupOnServer({
      ownerUserUuid: "user-uuid",
      accountPassword: "secret",
      material: realMaterial,
      authoritativeOverwrite: true,
    });

    expect(result).toEqual({ uploaded: false, skippedReason: "locked_or_frozen" });
    expect(mockGetKeyBackup).not.toHaveBeenCalled();
    expect(mockPutKeyBackup).not.toHaveBeenCalled();
  });

  it("skips upload when freeze flag is set", async () => {
    const { ensureKeyBackupOnServer } = await import("./syncOnLogin.js");
    mockGetE2EState.mockResolvedValue({ state: "active", freeze: true, updatedAt: "" });

    const result = await ensureKeyBackupOnServer({
      ownerUserUuid: "user-uuid",
      accountPassword: "secret",
      material: realMaterial,
      authoritativeOverwrite: true,
    });

    expect(result).toEqual({ uploaded: false, skippedReason: "locked_or_frozen" });
  });

  it("returns unchanged when existing backup is healthy", async () => {
    const { ensureKeyBackupOnServer } = await import("./syncOnLogin.js");
    mockGetE2EState.mockResolvedValue(activeState());
    mockGetKeyBackup.mockResolvedValue({ backupRevision: 3 });
    mockClassifyKeyBackup.mockResolvedValue({ state: "healthy", payload: {}, plaintext: {} });

    const result = await ensureKeyBackupOnServer({
      ownerUserUuid: "user-uuid",
      accountPassword: "secret",
      material: realMaterial,
      authoritativeOverwrite: true,
    });

    expect(result).toEqual({ uploaded: false, skippedReason: "unchanged" });
    expect(mockPutKeyBackup).not.toHaveBeenCalled();
  });

  it("heals an unreadable backup and bumps the revision when authoritative", async () => {
    const { ensureKeyBackupOnServer } = await import("./syncOnLogin.js");
    mockGetE2EState.mockResolvedValue(activeState());
    mockGetKeyBackup.mockResolvedValue({ backupRevision: 5 });
    mockClassifyKeyBackup.mockResolvedValue({ state: "unreadable" });
    mockTryGetUserE2ePublicKey.mockResolvedValue({ publicKeyBase64: realPubB64, deviceUuid: null });

    const result = await ensureKeyBackupOnServer({
      ownerUserUuid: "user-uuid",
      accountPassword: "secret",
      material: realMaterial,
      authoritativeOverwrite: true,
    });

    expect(result).toEqual({ uploaded: true });
    expect(mockCreateKeyBackup).toHaveBeenCalledWith(
      expect.objectContaining({ backupRevision: 6 }),
    );
    expect(mockPutKeyBackup).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ type: "backup_decrypt_failed", state: "unreadable" });
    expect(events).toContainEqual({ type: "backup_self_healed", previousState: "unreadable" });
  });

  it("refuses to overwrite an unreadable backup when NOT authoritative (anti-clobber)", async () => {
    const { ensureKeyBackupOnServer } = await import("./syncOnLogin.js");
    mockGetE2EState.mockResolvedValue(activeState());
    mockGetKeyBackup.mockResolvedValue({ backupRevision: 5 });
    mockClassifyKeyBackup.mockResolvedValue({ state: "unreadable" });

    const result = await ensureKeyBackupOnServer({
      ownerUserUuid: "user-uuid",
      accountPassword: "old-password",
      material: realMaterial,
      authoritativeOverwrite: false,
    });

    expect(result).toEqual({ uploaded: false, skippedReason: "not_authenticated" });
    expect(mockPutKeyBackup).not.toHaveBeenCalled();
    expect(mockTryGetUserE2ePublicKey).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: "backup_overwrite_skipped", reason: "not_authenticated" });
  });

  it("refuses to overwrite when local pubkey != server pubkey", async () => {
    const { ensureKeyBackupOnServer } = await import("./syncOnLogin.js");
    mockGetE2EState.mockResolvedValue(activeState());
    mockGetKeyBackup.mockResolvedValue({ backupRevision: 1 });
    mockClassifyKeyBackup.mockResolvedValue({ state: "unreadable" });
    mockTryGetUserE2ePublicKey.mockResolvedValue({ publicKeyBase64: otherPubB64, deviceUuid: null });

    const result = await ensureKeyBackupOnServer({
      ownerUserUuid: "user-uuid",
      accountPassword: "secret",
      material: realMaterial,
      authoritativeOverwrite: true,
    });

    expect(result).toEqual({ uploaded: false, skippedReason: "pubkey_mismatch" });
    expect(mockPutKeyBackup).not.toHaveBeenCalled();
  });

  it("refuses to overwrite when local material fails its self-check", async () => {
    const { ensureKeyBackupOnServer } = await import("./syncOnLogin.js");
    mockGetE2EState.mockResolvedValue(activeState());
    mockGetKeyBackup.mockResolvedValue({ backupRevision: 1 });
    mockClassifyKeyBackup.mockResolvedValue({ state: "unreadable" });
    mockTryGetUserE2ePublicKey.mockResolvedValue({ publicKeyBase64: realPubB64, deviceUuid: null });

    // Same agreement key (so pubkey matches server) but a corrupted/invalid signing key.
    const brokenSigning: FscpLocalMaterial = {
      ...realMaterial,
      signingPrivateKey: new Uint8Array(32).fill(1),
    };

    const result = await ensureKeyBackupOnServer({
      ownerUserUuid: "user-uuid",
      accountPassword: "secret",
      material: brokenSigning,
      authoritativeOverwrite: true,
    });

    expect(result).toEqual({ uploaded: false, skippedReason: "self_check_failed" });
    expect(mockPutKeyBackup).not.toHaveBeenCalled();
  });

  it("never silently overwrites a malformed backup, even when authoritative", async () => {
    const { ensureKeyBackupOnServer } = await import("./syncOnLogin.js");
    mockGetE2EState.mockResolvedValue(activeState());
    mockGetKeyBackup.mockResolvedValue({ backupRevision: 1 });
    mockClassifyKeyBackup.mockResolvedValue({ state: "malformed", reason: "bad shape" });

    const result = await ensureKeyBackupOnServer({
      ownerUserUuid: "user-uuid",
      accountPassword: "secret",
      material: realMaterial,
      authoritativeOverwrite: true,
    });

    expect(result).toEqual({ uploaded: false, skippedReason: "malformed" });
    expect(mockPutKeyBackup).not.toHaveBeenCalled();
    expect(mockTryGetUserE2ePublicKey).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: "backup_overwrite_skipped", reason: "malformed" });
  });

  it("never overwrites an existing backup when KDF classification fails during authoritative login", async () => {
    const { ensureKeyBackupOnServer } = await import("./syncOnLogin.js");
    const actualBackup = await vi.importActual<typeof import("./keyBackup.js")>("./keyBackup.js");
    configureFscpKdf(async ({ passwordBytes }) => new Uint8Array(32).fill(passwordBytes[0] ?? 0));
    const plaintext = await actualBackup.bootstrapPlaintextFromLocalMaterial(
      realMaterial.agreementPrivateKey,
      realMaterial.signingPrivateKey,
    );
    const backup = await actualBackup.createKeyBackup({
      userUuid: "kdf-failed-authoritative-login",
      password: "proven-login-password",
      plaintext,
      backupRevision: 7,
      epochSetRevision: 1,
      backupKeyId: "44444444-4444-4444-4444-444444444444",
    });
    // The injected KDF fails and crypto_pwhash is absent, so the mandatory fallback fails too.
    configureFscpKdf(async () => {
      throw new Error("worker failed");
    });
    configureSodiumLoader(async () => ({ ...sodium, crypto_pwhash: undefined }) as SodiumModule);
    mockClassifyKeyBackup.mockImplementation(async (...args: Parameters<typeof actualBackup.classifyKeyBackup>) =>
      actualBackup.classifyKeyBackup(...args),
    );
    mockGetE2EState.mockResolvedValue(activeState());
    mockGetKeyBackup.mockResolvedValue(backup);

    const result = await ensureKeyBackupOnServer({
      ownerUserUuid: "kdf-failed-authoritative-login",
      accountPassword: "proven-login-password",
      material: realMaterial,
      authoritativeOverwrite: true,
    });

    expect(result).toEqual({ uploaded: false, skippedReason: "kdf_failed" });
    expect(result).not.toMatchObject({ skippedReason: "wrong_password" });
    expect(mockPutKeyBackup).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: "backup_overwrite_skipped", reason: "kdf_failed" });
  });

  it("publishes pubkey when missing on server and authoritative, then uploads backup", async () => {
    const { ensureKeyBackupOnServer } = await import("./syncOnLogin.js");
    mockGetE2EState.mockResolvedValue(activeState());
    mockGetKeyBackup.mockRejectedValue(new (await import("@flora/client-core/api/errors.js")).ApiRequestError(404, "not found"));
    mockTryGetUserE2ePublicKey
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ publicKeyBase64: realPubB64, deviceUuid: "device-uuid" });

    const result = await ensureKeyBackupOnServer({
      ownerUserUuid: "user-uuid",
      accountPassword: "secret",
      material: realMaterial,
      authoritativeOverwrite: true,
    });

    expect(result).toEqual({ uploaded: true });
    expect(mockPutMyE2ePublicKey).toHaveBeenCalledTimes(1);
    expect(mockPutKeyBackup).toHaveBeenCalledTimes(1);
  });

  it("creates the first backup (missing) and returns conflict on PUT 409", async () => {
    const { ApiRequestError } = await import("@flora/client-core/api/errors.js");
    const { ensureKeyBackupOnServer } = await import("./syncOnLogin.js");
    mockGetE2EState.mockResolvedValue(activeState());
    mockGetKeyBackup.mockRejectedValue(new ApiRequestError(404, "not found"));
    mockTryGetUserE2ePublicKey.mockResolvedValue({ publicKeyBase64: realPubB64, deviceUuid: null });
    mockPutKeyBackup.mockRejectedValue(new ApiRequestError(409, "Conflict"));

    const result = await ensureKeyBackupOnServer({
      ownerUserUuid: "user-uuid",
      accountPassword: "secret",
      material: realMaterial,
      authoritativeOverwrite: true,
    });

    expect(result).toEqual({ uploaded: false, skippedReason: "conflict" });
    expect(mockCreateKeyBackup).toHaveBeenCalledWith(
      expect.objectContaining({ backupRevision: 1 }),
    );
  });
});

describe("syncFscpOnLogin resilience and read handoff", () => {
  beforeEach(() => {
    mockGetE2EState.mockReset();
    mockGetKeyBackup.mockReset();
    mockPutKeyBackup.mockReset();
    mockTryGetUserE2ePublicKey.mockReset();
    mockPutMyE2ePublicKey.mockReset();
    mockCreateKeyBackup.mockReset();
    mockClassifyKeyBackup.mockReset();
    mockPutKeyBackup.mockResolvedValue({});
    mockCreateKeyBackup.mockResolvedValue({ ciphertext: "stub" });
  });

  it("returns transient_error without throwing when resolve has a transient read failure", async () => {
    vi.useFakeTimers();
    const { syncFscpOnLogin } = await import("./syncOnLogin.js");
    mockGetE2EState.mockRejectedValue(new ApiRequestError(500, "temporary"));

    const pending = syncFscpOnLogin({
      storage: storage(),
      ownerUserUuid: "sync-transient",
      accountPassword: "secret",
    });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({
      bootstrap: { status: "transient_error", failure: "transient" },
      backupUploaded: false,
      backupSkippedReason: "transient_error",
      failure: "transient",
    });
  });

  it("passes resolve's known reads to ensure and derives the backup only once", async () => {
    const { syncFscpOnLogin } = await import("./syncOnLogin.js");
    let kdfCalls = 0;
    configureFscpKdf(async ({ passwordBytes }) => {
      kdfCalls += 1;
      return new Uint8Array(32).fill(passwordBytes[0] ?? 0);
    });
    const actualBackup = await vi.importActual<typeof import("./keyBackup.js")>("./keyBackup.js");
    const plaintext = await actualBackup.bootstrapPlaintextFromLocalMaterial(
      realMaterial.agreementPrivateKey,
      realMaterial.signingPrivateKey,
    );
    const backup = await actualBackup.createKeyBackup({
      userUuid: "sync-handoff",
      password: "secret",
      plaintext,
      backupRevision: 1,
      epochSetRevision: 1,
      backupKeyId: "33333333-3333-3333-3333-333333333333",
    });
    kdfCalls = 0;
    mockGetE2EState.mockResolvedValue(activeState());
    mockGetKeyBackup.mockResolvedValue(backup);
    mockTryGetUserE2ePublicKey.mockResolvedValue({
      publicKeyBase64: realPubB64,
      deviceUuid: "device-uuid",
    });

    const result = await syncFscpOnLogin({
      storage: storage(),
      ownerUserUuid: "sync-handoff",
      accountPassword: "secret",
      authoritativeOverwrite: true,
    });

    expect(result.backupSkippedReason).toBe("unchanged");
    expect(mockGetE2EState).toHaveBeenCalledTimes(1);
    expect(mockGetKeyBackup).toHaveBeenCalledTimes(1);
    expect(kdfCalls).toBe(1);
  });

  it("retries a read but invokes apiPutKeyBackup exactly once", async () => {
    vi.useFakeTimers();
    const { syncFscpOnLogin } = await import("./syncOnLogin.js");
    configureFscpKdf(async () => new Uint8Array(32).fill(9));
    const accountStorage = storage();
    await persistFscpLocalMaterial(accountStorage, "sync-one-write", realMaterial);
    mockGetE2EState.mockResolvedValue(activeState());
    mockGetKeyBackup.mockRejectedValue(new ApiRequestError(404, "missing"));
    mockTryGetUserE2ePublicKey
      .mockResolvedValueOnce({ publicKeyBase64: realPubB64, deviceUuid: "device-uuid" })
      .mockRejectedValueOnce(new ApiRequestError(500, "temporary"))
      .mockRejectedValueOnce(new ApiRequestError(500, "temporary"))
      .mockResolvedValue({ publicKeyBase64: realPubB64, deviceUuid: "device-uuid" });

    const pending = syncFscpOnLogin({
      storage: accountStorage,
      ownerUserUuid: "sync-one-write",
      accountPassword: "secret",
      authoritativeOverwrite: true,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toMatchObject({ backupUploaded: true });
    expect(mockTryGetUserE2ePublicKey).toHaveBeenCalledTimes(4);
    expect(mockPutKeyBackup).toHaveBeenCalledTimes(1);
  });
});

afterEach(() => {
  configureFscpKdf(null);
  configureSodiumLoader(async () => sodium);
  configureTelemetry({ capture: () => {}, captureException: () => {} });
  vi.useRealTimers();
});

function storage(): FscpKeyStorageAdapter {
  const profiles = new Map<string, FscpProfileRecord>();
  return {
    getProfile: async (owner) => profiles.get(owner) ?? null,
    setProfile: async (owner, record) => {
      profiles.set(owner, record);
    },
    clearProfile: async (owner) => {
      profiles.delete(owner);
    },
    clearAllProfiles: async () => {
      profiles.clear();
    },
  };
}
