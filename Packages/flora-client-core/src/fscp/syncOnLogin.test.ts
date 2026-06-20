import { createRequire } from "node:module";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { configureSodiumLoader, type SodiumModule } from "./sodium.js";
import { configureTelemetry, type TelemetryEvent } from "../telemetry/index.js";
import {
  agreementPublicKeyBase64Url,
  createInitialFscpIdentity,
  type FscpLocalMaterial,
} from "./keys.js";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers-sumo") as SodiumModule;

const mockGetE2EState = vi.fn();
const mockGetKeyBackup = vi.fn();
const mockPutKeyBackup = vi.fn();
const mockTryGetUserE2ePublicKey = vi.fn();
const mockPutMyE2ePublicKey = vi.fn();
const mockCreateKeyBackup = vi.fn();
const mockClassifyKeyBackup = vi.fn();

vi.mock("../api/messaging.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/messaging.js")>();
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

  it("publishes pubkey when missing on server and authoritative, then uploads backup", async () => {
    const { ensureKeyBackupOnServer } = await import("./syncOnLogin.js");
    mockGetE2EState.mockResolvedValue(activeState());
    mockGetKeyBackup.mockRejectedValue(new (await import("../api/errors.js")).ApiRequestError(404, "not found"));
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
    const { ApiRequestError } = await import("../api/errors.js");
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
