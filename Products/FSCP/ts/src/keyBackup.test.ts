import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { configureSodiumLoader, type SodiumModule } from "./sodium.js";
import {
  bootstrapPlaintextFromLocalMaterial,
  createKeyBackup,
  decryptKeyBackup,
  parseKeyBackupPayload,
} from "./keyBackup.js";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers-sumo") as SodiumModule;

beforeAll(async () => {
  await sodium.ready;
  configureSodiumLoader(async () => sodium);
});

describe("keyBackup", () => {
  it("roundtrips backup with string AEAD additional data (RN-compatible)", async () => {
    const box = sodium.crypto_box_keypair();
    const sign = sodium.crypto_sign_keypair();
    const plaintext = await bootstrapPlaintextFromLocalMaterial(
      box.privateKey.subarray(0, 32),
      sign.privateKey,
    );

    const backup = await createKeyBackup({
      userUuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      password: "test-password-123",
      plaintext,
      backupRevision: 1,
      epochSetRevision: 1,
      backupKeyId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    });

    const parsed = parseKeyBackupPayload(backup);
    const restored = await decryptKeyBackup(parsed, "test-password-123");
    expect(restored.primaryKeyEpochId).toBe(plaintext.primaryKeyEpochId);
    expect(restored.keyEpochs).toHaveLength(1);
  });

  it("rejects wrong password", async () => {
    const box = sodium.crypto_box_keypair();
    const sign = sodium.crypto_sign_keypair();
    const plaintext = await bootstrapPlaintextFromLocalMaterial(
      box.privateKey.subarray(0, 32),
      sign.privateKey,
    );
    const backup = await createKeyBackup({
      userUuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      password: "right",
      plaintext,
      backupRevision: 1,
      epochSetRevision: 1,
      backupKeyId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    });
    await expect(decryptKeyBackup(parseKeyBackupPayload(backup), "wrong")).rejects.toThrow(
      /Неверный пароль/,
    );
  });
});
