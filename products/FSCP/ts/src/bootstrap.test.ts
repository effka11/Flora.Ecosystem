import { createRequire } from "node:module";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@flora/client-core/api/errors.js";
import { accountRequiresKeyRestore } from "./bootstrap.js";
import { configureFscpKdf } from "./kdf.js";
import { bootstrapPlaintextFromLocalMaterial, createKeyBackup } from "./keyBackup.js";
import type { FscpKeyStorageAdapter, FscpProfileRecord } from "./keyStorage.js";
import {
  agreementPublicKeyBase64Url,
  persistFscpLocalMaterial,
  type FscpLocalMaterial,
} from "./keys.js";
import { createFscpDeadline, FscpBackupError } from "./resilience.js";
import { configureSodiumLoader, deriveKeyArgon2id, type SodiumModule } from "./sodium.js";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers-sumo") as SodiumModule;

const mockGetE2EState = vi.fn();
const mockGetKeyBackup = vi.fn();
const mockTryGetUserE2ePublicKey = vi.fn();
const mockPutMyE2ePublicKey = vi.fn();
const mockCreateInitialIdentity = vi.fn();
const mockDecryptKeyBackup = vi.fn();

vi.mock("@flora/client-core/api/messaging.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@flora/client-core/api/messaging.js")>();
  return {
    ...actual,
    apiGetE2EState: () => mockGetE2EState(),
    apiGetKeyBackup: () => mockGetKeyBackup(),
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

vi.mock("./keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./keys.js")>();
  return {
    ...actual,
    createInitialFscpIdentity: () => mockCreateInitialIdentity(),
  };
});

vi.mock("./keyBackup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./keyBackup.js")>();
  return {
    ...actual,
    decryptKeyBackup: (...args: Parameters<typeof actual.decryptKeyBackup>) =>
      mockDecryptKeyBackup(...args),
  };
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

const freshState = () => ({ state: "not_initialized", freeze: false, updatedAt: "" });

let material: FscpLocalMaterial;
let publicKey: string;

beforeAll(async () => {
  await sodium.ready;
  configureSodiumLoader(async () => sodium);
  const actualKeys = await vi.importActual<typeof import("./keys.js")>("./keys.js");
  material = await actualKeys.createInitialFscpIdentity();
  publicKey = await agreementPublicKeyBase64Url(material);
});

beforeEach(() => {
  mockGetE2EState.mockReset();
  mockGetKeyBackup.mockReset();
  mockTryGetUserE2ePublicKey.mockReset();
  mockPutMyE2ePublicKey.mockReset();
  mockCreateInitialIdentity.mockReset();
  mockDecryptKeyBackup.mockReset();
  mockCreateInitialIdentity.mockResolvedValue(material);
  mockDecryptKeyBackup.mockImplementation(async (...args) => {
    const actual = await vi.importActual<typeof import("./keyBackup.js")>("./keyBackup.js");
    return actual.decryptKeyBackup(...args);
  });
  mockPutMyE2ePublicKey.mockResolvedValue({ deviceUuid: "device-uuid" });
});

afterEach(() => {
  configureFscpKdf(null);
  configureSodiumLoader(async () => sodium);
  vi.useRealTimers();
});

describe("accountRequiresKeyRestore", () => {
  it("requires restore when server already has a pubkey", () => {
    expect(
      accountRequiresKeyRestore({
        hasServerPubKey: true,
        e2eState: "not_initialized",
        hasKeyBackup: false,
      }),
    ).toBe(true);
  });

  it("requires restore when messaging E2E is initialized", () => {
    expect(
      accountRequiresKeyRestore({
        hasServerPubKey: false,
        e2eState: "active",
        hasKeyBackup: false,
      }),
    ).toBe(true);
  });

  it("requires restore when key backup exists on server", () => {
    expect(
      accountRequiresKeyRestore({
        hasServerPubKey: false,
        e2eState: "not_initialized",
        hasKeyBackup: true,
      }),
    ).toBe(true);
  });

  it("allows new identity only for a fresh account", () => {
    expect(
      accountRequiresKeyRestore({
        hasServerPubKey: false,
        e2eState: "not_initialized",
        hasKeyBackup: false,
      }),
    ).toBe(false);
  });
});

describe("resolveFscpMaterialOnDevice resilience", () => {
  it("maps a 500 while reading the backup to transient_error, not wrong_password", async () => {
    vi.useFakeTimers();
    const { resolveFscpMaterialOnDevice } = await import("./bootstrap.js");
    mockGetE2EState.mockResolvedValue(freshState());
    mockTryGetUserE2ePublicKey.mockResolvedValue(null);
    mockGetKeyBackup.mockRejectedValue(new ApiRequestError(500, "server error"));

    const pending = resolveFscpMaterialOnDevice({
      storage: storage(),
      ownerUserUuid: "bootstrap-500",
    });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({
      status: "transient_error",
      material: null,
      failure: "transient",
    });
  });

  it("retries a transient backup read and becomes ready on the second attempt", async () => {
    vi.useFakeTimers();
    const { resolveFscpMaterialOnDevice } = await import("./bootstrap.js");
    mockGetE2EState.mockResolvedValue(freshState());
    mockTryGetUserE2ePublicKey.mockResolvedValue(null);
    mockGetKeyBackup
      .mockRejectedValueOnce(new ApiRequestError(500, "temporary"))
      .mockRejectedValueOnce(new ApiRequestError(404, "missing"));

    const pending = resolveFscpMaterialOnDevice({
      storage: storage(),
      ownerUserUuid: "bootstrap-retry-ready",
    });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({ status: "ready" });
    expect(mockGetKeyBackup).toHaveBeenCalledTimes(2);
  });

  it("maps a real AEAD authentication failure for a valid backup to wrong_password", async () => {
    const { resolveFscpMaterialOnDevice } = await import("./bootstrap.js");
    configureFscpKdf(async ({ passwordBytes }) => new Uint8Array(32).fill(passwordBytes[0] ?? 0));
    const plaintext = await bootstrapPlaintextFromLocalMaterial(
      material.agreementPrivateKey,
      material.signingPrivateKey,
    );
    const backup = await createKeyBackup({
      userUuid: "bootstrap-aead",
      password: "right-password",
      plaintext,
      backupRevision: 1,
      epochSetRevision: 1,
      backupKeyId: "11111111-1111-1111-1111-111111111111",
    });
    mockGetE2EState.mockResolvedValue({ state: "active", freeze: false, updatedAt: "" });
    mockTryGetUserE2ePublicKey.mockResolvedValue({ publicKeyBase64: publicKey, deviceUuid: "device" });
    mockGetKeyBackup.mockResolvedValue(backup);

    await expect(
      resolveFscpMaterialOnDevice({
        storage: storage(),
        ownerUserUuid: "bootstrap-aead",
        accountPassword: "wrong-password",
      }),
    ).resolves.toMatchObject({ status: "wrong_password", failure: "wrong_password" });
  });

  it("maps KDF failure to transient_error rather than unreadable/wrong_password", async () => {
    const { resolveFscpMaterialOnDevice } = await import("./bootstrap.js");
    mockGetE2EState.mockResolvedValue({ state: "active", freeze: false, updatedAt: "" });
    mockTryGetUserE2ePublicKey.mockResolvedValue({ publicKeyBase64: publicKey, deviceUuid: "device" });
    mockGetKeyBackup.mockResolvedValue({ backupRevision: 1 });
    mockDecryptKeyBackup.mockRejectedValue(
      new FscpBackupError("kdf_failed", "KDF infrastructure unavailable"),
    );

    const result = await resolveFscpMaterialOnDevice({
      storage: storage(),
      ownerUserUuid: "bootstrap-kdf",
      accountPassword: "password",
    });

    expect(result.status).toBe("transient_error");
    expect(result.status).not.toBe("wrong_password");
    expect(result.failure).toBe("permanent");
  });

  it("serializes concurrent passwordless and password resolves for one fresh owner", async () => {
    const { resolveFscpMaterialOnDevice } = await import("./bootstrap.js");
    const accountStorage = storage();
    mockGetE2EState.mockResolvedValue(freshState());
    mockTryGetUserE2ePublicKey
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ publicKeyBase64: publicKey, deviceUuid: "device-uuid" });
    mockGetKeyBackup.mockRejectedValue(new ApiRequestError(404, "missing"));

    const [passwordless, withPassword] = await Promise.all([
      resolveFscpMaterialOnDevice({
        storage: accountStorage,
        ownerUserUuid: "bootstrap-mutex",
      }),
      resolveFscpMaterialOnDevice({
        storage: accountStorage,
        ownerUserUuid: "bootstrap-mutex",
        accountPassword: "proven-password",
      }),
    ]);

    expect(passwordless.status).toBe("ready");
    expect(withPassword.status).toBe("ready");
    expect(mockCreateInitialIdentity).toHaveBeenCalledTimes(1);
    expect(mockPutMyE2ePublicKey).toHaveBeenCalledTimes(1);
  });

  it("deduplicates login-sync reads and runs Argon2id once on a new device", async () => {
    const { syncFscpOnLogin } = await import("./syncOnLogin.js");
    let kdfCalls = 0;
    configureFscpKdf(async ({ passwordBytes }) => {
      kdfCalls += 1;
      return new Uint8Array(32).fill(passwordBytes[0] ?? 0);
    });
    const plaintext = await bootstrapPlaintextFromLocalMaterial(
      material.agreementPrivateKey,
      material.signingPrivateKey,
    );
    const backup = await createKeyBackup({
      userUuid: "bootstrap-dedupe",
      password: "password",
      plaintext,
      backupRevision: 1,
      epochSetRevision: 1,
      backupKeyId: "22222222-2222-2222-2222-222222222222",
    });
    kdfCalls = 0;
    mockGetE2EState.mockResolvedValue({ state: "active", freeze: false, updatedAt: "" });
    mockGetKeyBackup.mockResolvedValue(backup);
    mockTryGetUserE2ePublicKey.mockResolvedValue({
      publicKeyBase64: publicKey,
      deviceUuid: "device-uuid",
    });

    const result = await syncFscpOnLogin({
      storage: storage(),
      ownerUserUuid: "bootstrap-dedupe",
      accountPassword: "password",
      authoritativeOverwrite: true,
    });

    expect(result.bootstrap.status).toBe("ready");
    expect(mockGetKeyBackup).toHaveBeenCalledTimes(1);
    expect(mockGetE2EState).toHaveBeenCalledTimes(1);
    expect(kdfCalls).toBe(1);
  });

  it("keeps local material when the server public-key read exhausts retries", async () => {
    vi.useFakeTimers();
    const { resolveFscpMaterialOnDevice } = await import("./bootstrap.js");
    const accountStorage = storage();
    await persistFscpLocalMaterial(accountStorage, "bootstrap-local", material);
    mockTryGetUserE2ePublicKey.mockRejectedValue(new ApiRequestError(500, "server error"));

    const pending = resolveFscpMaterialOnDevice({
      storage: accountStorage,
      ownerUserUuid: "bootstrap-local",
    });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({
      status: "transient_error",
      material,
      failure: "transient",
    });
  });

  it("finishes a hung read when the caller's shared deadline expires", async () => {
    vi.useFakeTimers();
    const { resolveFscpMaterialOnDevice } = await import("./bootstrap.js");
    mockGetE2EState.mockImplementation(() => new Promise(() => {}));

    const pending = resolveFscpMaterialOnDevice({
      storage: storage(),
      ownerUserUuid: "bootstrap-deadline",
      deadline: createFscpDeadline(25),
    });
    await vi.advanceTimersByTimeAsync(25);

    await expect(pending).resolves.toMatchObject({
      status: "transient_error",
      failure: "transient",
    });
  });
});

describe("deriveKeyArgon2id fallback", () => {
  it("uses crypto_pwhash when the injected KDF throws and returns identical bytes", async () => {
    const params = {
      passwordBytes: new Uint8Array([1, 2, 3]),
      salt: new Uint8Array(16).fill(7),
      memoryKiB: 8,
      iterations: 1,
      keyLen: 32,
    };
    const expected = await deriveKeyArgon2id(params);
    configureFscpKdf(async () => {
      throw new Error("worker crashed");
    });

    await expect(deriveKeyArgon2id(params)).resolves.toEqual(expected);
  });
});
