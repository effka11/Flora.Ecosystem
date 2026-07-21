/**
 * Consumer golden-вектора fscp-d2d-recovery-v1.json
 * (e2e-security.md §DeviceToDeviceRecoveryEnvelope, кейсы
 * device_to_device_recovery_envelope_v1_success / _wrong_challenge / ...):
 * клиентская сторона — open (подпись source, AAD-binding, AEAD decrypt) байт-в-байт
 * против референс-генератора. Серверный consumer — fscp_d2d_recovery_vectors.rs.
 * Файл вектора — regenerate-only: python Documents/test-vectors/_gen_fscp_d2d_recovery_v1.py
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { canonicalJson } from "./canonicalJson.js";
import {
  deviceAgreementPublicKeyId,
  deviceRecoveryAadLine,
  openDeviceRecoveryEnvelope,
  type FscpDeviceRecoveryEnvelope,
} from "./deviceRecovery.js";
import { fromBase64Url } from "./base64url.js";
import { configureSodiumLoader, type SodiumModule } from "./sodium.js";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers") as SodiumModule;

const vectorsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "..",
  "Documents", "test-vectors",
);

type D2dCase = {
  caseId: string;
  envelope: FscpDeviceRecoveryEnvelope;
  expectedClient?: "ok";
  expectedClientErrorCategory?: string;
};

type D2dVector = {
  vectorId: string;
  aadDomain: string;
  signatureDomain: string;
  uuids: {
    userUuid: string;
    sourceDeviceUuid: string;
    targetDeviceUuid: string;
    recoveryRequestId: string;
    transferredKeyEpochIds: string[];
    targetAgreementPublicKeyId: string;
  };
  keys: Record<string, string>;
  aadUtf8: string;
  payloadPlaintextUtf8: string;
  canonicalSigningPayloadUtf8: string;
  envelope: FscpDeviceRecoveryEnvelope;
  cases: D2dCase[];
};

const v = JSON.parse(
  readFileSync(path.join(vectorsDir, "fscp-d2d-recovery-v1.json"), "utf8"),
) as D2dVector;

beforeAll(async () => {
  await sodium.ready;
  configureSodiumLoader(async () => sodium);
});

function openParams(envelope: FscpDeviceRecoveryEnvelope) {
  return {
    envelope,
    expected: {
      recoveryRequestId: v.uuids.recoveryRequestId,
      userUuid: v.uuids.userUuid,
      targetDeviceUuid: v.uuids.targetDeviceUuid,
      sourceDeviceUuid: v.uuids.sourceDeviceUuid,
    },
    sourceDeviceSigningPublicKey: fromBase64Url(v.keys.sourceSigningPublicKeyBase64Url!),
    targetDeviceAgreementPrivateKey: fromBase64Url(v.keys.targetAgreementPrivateKeyBase64Url!),
  };
}

describe("golden: fscp-d2d-recovery-v1.json (DeviceToDeviceRecoveryEnvelope)", () => {
  it("targetAgreementPublicKeyId детерминирован (uuid v5, device-agreement-v1)", () => {
    expect(deviceAgreementPublicKeyId(v.uuids.userUuid, v.uuids.targetDeviceUuid)).toBe(
      v.uuids.targetAgreementPublicKeyId,
    );
  });

  it("AAD-строка воспроизводится байт-в-байт", () => {
    const line = deviceRecoveryAadLine({
      recoveryRequestId: v.uuids.recoveryRequestId,
      userUuid: v.uuids.userUuid,
      sourceDeviceUuid: v.uuids.sourceDeviceUuid,
      targetDeviceUuid: v.uuids.targetDeviceUuid,
      targetAgreementPublicKeyId: v.uuids.targetAgreementPublicKeyId,
      transferredKeyEpochIds: v.uuids.transferredKeyEpochIds,
    });
    expect(line).toBe(v.aadUtf8);
  });

  it("canonical signing payload воспроизводится байт-в-байт", () => {
    const { sourceDeviceSignatureBase64Url: _sig, ...envNoSig } = v.envelope;
    expect(`${v.signatureDomain} | ${canonicalJson(envNoSig)}`).toBe(
      v.canonicalSigningPayloadUtf8,
    );
  });

  it("success: target открывает конверт, plaintext байт-в-байт", async () => {
    const opened = await openDeviceRecoveryEnvelope(openParams(v.envelope));
    expect(JSON.stringify(opened)).toBe(v.payloadPlaintextUtf8);
    expect(opened.keyEpochs.map((e) => e.keyEpochId)).toEqual(v.uuids.transferredKeyEpochIds);
  });

  it("негативные кейсы дают ожидаемую категорию ошибки", async () => {
    const negative = v.cases.filter((c) => c.expectedClientErrorCategory);
    expect(negative.length).toBeGreaterThanOrEqual(4);
    for (const c of negative) {
      await expect(
        openDeviceRecoveryEnvelope(openParams(c.envelope)),
        c.caseId,
      ).rejects.toMatchObject({
        name: "FscpDeviceRecoveryOpenError",
        category: c.expectedClientErrorCategory,
      });
    }
  });
});
