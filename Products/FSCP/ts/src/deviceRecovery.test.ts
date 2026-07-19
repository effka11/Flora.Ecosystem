// Positive/negative векторы DeviceToDeviceRecoveryEnvelope —
// требование Cryptography gate из Documents/fscp/e2e-security.md.
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildDeviceRecoveryEnvelope,
  deviceAgreementPublicKeyId,
  deviceRecoveryAadLine,
  openDeviceRecoveryEnvelope,
  type FscpDeviceRecoveryEnvelope,
  type FscpDeviceRecoveryPayload,
} from "./deviceRecovery.js";
import { generateEd25519KeyPair, generateX25519KeyPair, fromBase64Url } from "./unlockFlow.js";
import { configureSodiumLoader } from "./sodium.js";

beforeAll(() => {
  configureSodiumLoader(async () => {
    const mod = await import("libsodium-wrappers-sumo");
    const sodium = (mod.default ?? mod) as never;
    return sodium;
  });
});

const USER = "11111111-1111-4111-8111-111111111111";
const SOURCE_DEVICE = "22222222-2222-4222-8222-222222222222";
const TARGET_DEVICE = "33333333-3333-4333-8333-333333333333";
const RECOVERY_REQUEST = "44444444-4444-4444-8444-444444444444";
const EPOCH_A = "55555555-5555-4555-8555-555555555555";
const EPOCH_B = "66666666-6666-4666-8666-666666666666";

async function fixture() {
  const sourceSigning = await generateEd25519KeyPair();
  const targetAgreement = await generateX25519KeyPair();
  const payload: FscpDeviceRecoveryPayload = {
    keyEpochs: [
      {
        keyEpochId: EPOCH_B,
        rootKeyBase64Url: "cm9vdC1i",
        epochAccountIdentityPrivateKeyBase64Url: "cHJpdi1i",
        epochAccountIdentityPublicKeyBase64Url: "cHViLWI",
        conversationKeyBackups: [],
      },
      {
        keyEpochId: EPOCH_A,
        rootKeyBase64Url: "cm9vdC1h",
        epochAccountIdentityPrivateKeyBase64Url: "cHJpdi1h",
        epochAccountIdentityPublicKeyBase64Url: "cHViLWE",
        conversationKeyBackups: [],
      },
    ],
  };
  const envelope = await buildDeviceRecoveryEnvelope({
    recoveryRequestId: RECOVERY_REQUEST,
    userUuid: USER,
    sourceDeviceUuid: SOURCE_DEVICE,
    targetDeviceUuid: TARGET_DEVICE,
    targetDeviceAgreementPublicKey: fromBase64Url(targetAgreement.agreementPublicKeyBase64Url),
    sourceDeviceSigningPrivateKey: fromBase64Url(sourceSigning.signingPrivateKeyBase64Url),
    payload,
  });
  return { sourceSigning, targetAgreement, payload, envelope };
}

function openParams(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    envelope: f.envelope,
    expected: {
      recoveryRequestId: RECOVERY_REQUEST,
      userUuid: USER,
      targetDeviceUuid: TARGET_DEVICE,
      sourceDeviceUuid: SOURCE_DEVICE,
    },
    sourceDeviceSigningPublicKey: fromBase64Url(f.sourceSigning.signingPublicKeyBase64Url),
    targetDeviceAgreementPrivateKey: fromBase64Url(f.targetAgreement.agreementPrivateKeyBase64Url),
  };
}

describe("DeviceToDeviceRecoveryEnvelope", () => {
  it("roundtrip: target открывает конверт и получает материал всех epochs", async () => {
    const f = await fixture();
    const opened = await openDeviceRecoveryEnvelope(openParams(f));
    expect(opened.keyEpochs).toHaveLength(2);
    const byId = new Map(opened.keyEpochs.map((e) => [e.keyEpochId.toLowerCase(), e]));
    expect(byId.get(EPOCH_A)?.rootKeyBase64Url).toBe("cm9vdC1h");
    expect(byId.get(EPOCH_B)?.epochAccountIdentityPrivateKeyBase64Url).toBe("cHJpdi1i");
  });

  it("форма конверта соответствует спеке (§DeviceToDeviceRecoveryEnvelope)", async () => {
    const f = await fixture();
    const env = f.envelope;
    expect(env.version).toBe(1);
    expect(env.transferredKeyEpochIds).toEqual([EPOCH_A, EPOCH_B]); // sorted
    expect(env.targetAgreementPublicKeyId).toBe(deviceAgreementPublicKeyId(USER, TARGET_DEVICE));
    expect(env.aead.name).toBe("xchacha20-poly1305");
    expect(fromBase64Url(env.ephemeralPublicKeyBase64Url)).toHaveLength(32);
    expect(fromBase64Url(env.saltBase64Url)).toHaveLength(32);
    expect(fromBase64Url(env.aead.nonceBase64Url)).toHaveLength(24);
    expect(fromBase64Url(env.sourceDeviceSignatureBase64Url)).toHaveLength(64);
  });

  it("AAD-строка формируется по нормативному шаблону", () => {
    const line = deviceRecoveryAadLine({
      recoveryRequestId: RECOVERY_REQUEST,
      userUuid: USER,
      sourceDeviceUuid: SOURCE_DEVICE,
      targetDeviceUuid: TARGET_DEVICE,
      targetAgreementPublicKeyId: "77777777-7777-4777-8777-777777777777",
      transferredKeyEpochIds: [EPOCH_B, EPOCH_A],
    });
    expect(line).toBe(
      `flora.messaging.device-to-device-recovery.v1 | ${RECOVERY_REQUEST} | ${USER} | ${SOURCE_DEVICE} | ${TARGET_DEVICE} | 77777777-7777-4777-8777-777777777777 | ${EPOCH_A},${EPOCH_B}`,
    );
  });

  it("negative: подпись чужого устройства отклоняется", async () => {
    const f = await fixture();
    const otherSigning = await generateEd25519KeyPair();
    await expect(
      openDeviceRecoveryEnvelope({
        ...openParams(f),
        sourceDeviceSigningPublicKey: fromBase64Url(otherSigning.signingPublicKeyBase64Url),
      }),
    ).rejects.toMatchObject({ name: "FscpDeviceRecoveryOpenError", category: "signature_invalid" });
  });

  it("negative: подмена transferredKeyEpochIds после подписи отклоняется подписью", async () => {
    const f = await fixture();
    const tampered: FscpDeviceRecoveryEnvelope = {
      ...f.envelope,
      transferredKeyEpochIds: [EPOCH_A],
    };
    await expect(
      openDeviceRecoveryEnvelope({ ...openParams(f), envelope: tampered }),
    ).rejects.toMatchObject({ category: "signature_invalid" });
  });

  it("negative: чужой agreement-ключ target → decrypt_failed (AEAD)", async () => {
    const f = await fixture();
    await expect(
      openDeviceRecoveryEnvelope({
        ...openParams(f),
        targetDeviceAgreementPrivateKey: fromBase64Url(
          (await generateX25519KeyPair()).agreementPrivateKeyBase64Url,
        ),
      }),
    ).rejects.toMatchObject({ category: "decrypt_failed" });
  });

  it("negative: порча ciphertext ловится подписью (ciphertext под подписью)", async () => {
    const f = await fixture();
    const ct = fromBase64Url(f.envelope.ciphertextBase64Url);
    ct[0] = (ct[0] ?? 0) ^ 0x01;
    const tampered: FscpDeviceRecoveryEnvelope = {
      ...f.envelope,
      ciphertextBase64Url: f.envelope.ciphertextBase64Url.startsWith("A")
        ? `B${f.envelope.ciphertextBase64Url.slice(1)}`
        : `A${f.envelope.ciphertextBase64Url.slice(1)}`,
    };
    await expect(
      openDeviceRecoveryEnvelope({ ...openParams(f), envelope: tampered }),
    ).rejects.toMatchObject({ category: "signature_invalid" });
  });

  it("negative: конверт для другого recovery-запроса отклоняется по binding", async () => {
    const f = await fixture();
    await expect(
      openDeviceRecoveryEnvelope({
        ...openParams(f),
        expected: {
          recoveryRequestId: "99999999-9999-4999-8999-999999999999",
          userUuid: USER,
          targetDeviceUuid: TARGET_DEVICE,
        },
      }),
    ).rejects.toMatchObject({ category: "binding_mismatch" });
  });

  it("negative: пустой keyEpochs при сборке отклоняется", async () => {
    const f = await fixture();
    await expect(
      buildDeviceRecoveryEnvelope({
        recoveryRequestId: RECOVERY_REQUEST,
        userUuid: USER,
        sourceDeviceUuid: SOURCE_DEVICE,
        targetDeviceUuid: TARGET_DEVICE,
        targetDeviceAgreementPublicKey: fromBase64Url(f.targetAgreement.agreementPublicKeyBase64Url),
        sourceDeviceSigningPrivateKey: fromBase64Url(f.sourceSigning.signingPrivateKeyBase64Url),
        payload: { keyEpochs: [] },
      }),
    ).rejects.toThrow(/keyEpochs/);
  });
});

describe("device approve canonical (errata-5)", () => {
  it("формат совпадает с серверным build_canonical_device_approve_payload", async () => {
    const { buildDeviceApproveCanonical } = await import("./unlockFlow.js");
    expect(
      buildDeviceApproveCanonical({
        userUuid: USER,
        keyEpochId: EPOCH_A,
        newDeviceUuid: TARGET_DEVICE,
        approvingDeviceUuid: SOURCE_DEVICE,
      }),
    ).toBe(
      "flora.messaging.device-approve.v1 | " +
        `${USER} | ${EPOCH_A} | ${TARGET_DEVICE} | ${SOURCE_DEVICE}`,
    );
  });
});
