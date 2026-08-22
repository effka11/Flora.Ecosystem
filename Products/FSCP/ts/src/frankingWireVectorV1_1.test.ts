/**
 * Consumer regenerate-only golden-вектора FSCP-FRANK wire v1.1.
 * Регенерация: npm run generate:franking-wire-v1-1-vector --workspace=@flora/fscp
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { messageBodyAadLine } from "./aad.js";
import { fromBase64Url, utf8Bytes } from "./base64url.js";
import { FSCP_WIRE_PREFIX } from "./constants.js";
import {
  decryptFscpWireEnvelopeDetailed,
  peekFscpWireFrankTagBase64Url,
  type FscpEnvelopeWire,
} from "./envelope.js";
import {
  computeFrankTagV1,
  frankCommitInputV1,
  type FrankCommitContextV1,
} from "./franking.js";
import { configureSodiumLoader, type SodiumModule } from "./sodium.js";
import { toBase64Url } from "./unlockFlow.js";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers") as SodiumModule;

type WireVector = {
  vectorId: string;
  fscpProtocolVersion: number;
  deterministicAlgorithmA: {
    inputs: {
      frankingKeyBase64Url: string;
      plaintextUtf8: string;
      commit: FrankCommitContextV1;
      keyEpochId: string;
      messageKeyId: string;
    };
    expected: {
      commitInputUtf8: string;
      frankTagBase64Url: string;
      bodyAadUtf8: string;
    };
  };
  recordedWire: {
    wire: string;
    tamperedFrankTagResignedWire: string;
    tamperedFrankTagBase64Url: string;
    receiver: {
      userUuid: string;
      agreementPrivateKeyBase64Url: string;
      agreementPublicKeyBase64Url: string;
    };
    expected: {
      body: string;
      clientCreatedAt: string;
      messageUuid: string;
      messageKeyId: string;
      createdAt: string;
      plaintextUtf8: string;
      frankingKeyBase64Url: string;
      frankTagBase64Url: string;
      commitInputUtf8: string;
      bodyAadUtf8: string;
    };
  };
};

const vectorsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "Documents",
  "test-vectors",
);
const vector = JSON.parse(
  readFileSync(path.join(vectorsDir, "fscp-franking-wire-v1_1.json"), "utf8"),
) as WireVector;

function decodeEnvelope(wire: string): FscpEnvelopeWire {
  const encoded = wire.slice(FSCP_WIRE_PREFIX.length);
  return JSON.parse(new TextDecoder().decode(fromBase64Url(encoded))) as FscpEnvelopeWire;
}

beforeAll(async () => {
  await sodium.ready;
  configureSodiumLoader(async () => sodium);
});

describe("golden: fscp-franking-wire-v1_1.json", () => {
  it("declares fscpProtocolVersion 1.1", () => {
    expect(vector.vectorId).toBe("fscp_franking_wire_v1_1");
    expect(vector.fscpProtocolVersion).toBe(1.1);
  });

  it("reproduces deterministic Algorithm A commitInput and 32-byte frankTag", () => {
    const { inputs, expected } = vector.deterministicAlgorithmA;
    const commitInput = frankCommitInputV1(inputs.commit, utf8Bytes(inputs.plaintextUtf8));
    const frankTag = computeFrankTagV1(
      fromBase64Url(inputs.frankingKeyBase64Url),
      commitInput,
    );

    expect(commitInput).toBe(expected.commitInputUtf8);
    expect(frankTag).toHaveLength(32);
    expect(toBase64Url(frankTag)).toBe(expected.frankTagBase64Url);
    expect(JSON.parse(inputs.plaintextUtf8)).toMatchObject({
      frankingKeyBase64Url: inputs.frankingKeyBase64Url,
    });
  });

  it("reproduces the v1_1 body AAD with frankTag as the final field", () => {
    const { inputs, expected } = vector.deterministicAlgorithmA;
    const aad = messageBodyAadLine({
      conversationUuid: inputs.commit.conversationUuid,
      keyEpochId: inputs.keyEpochId,
      messageUuid: inputs.commit.messageUuid,
      messageKeyId: inputs.messageKeyId,
      senderUserUuid: inputs.commit.senderUserUuid,
      senderDeviceUuid: inputs.commit.senderDeviceUuid,
      createdAt: inputs.commit.createdAt,
      frankTagBase64Url: expected.frankTagBase64Url,
    });

    expect(aad).toBe(expected.bodyAadUtf8);
    expect(aad.startsWith("flora.messaging.message.v1_1 | ")).toBe(true);
    expect(aad.endsWith(` | ${expected.frankTagBase64Url}`)).toBe(true);
  });

  it("opens the recorded tagged fscp1 wire and rechecks its Algorithm A values", async () => {
    const recorded = vector.recordedWire;
    const opened = await decryptFscpWireEnvelopeDetailed({
      wire: recorded.wire,
      viewerUserUuid: recorded.receiver.userUuid,
      agreementPrivateKey: fromBase64Url(
        recorded.receiver.agreementPrivateKeyBase64Url,
      ),
    });
    const envelope = opened.envelope;
    const commitInput = frankCommitInputV1(
      {
        conversationUuid: envelope.conversationUuid,
        messageUuid: envelope.messageUuid,
        senderUserUuid: envelope.senderUserUuid,
        senderDeviceUuid: envelope.senderDeviceUuid,
        receiverUserUuid: recorded.receiver.userUuid,
        createdAt: envelope.createdAt,
      },
      opened.plaintextUtf8,
    );
    const aad = messageBodyAadLine({
      conversationUuid: envelope.conversationUuid,
      keyEpochId: envelope.keyEpochId,
      messageUuid: envelope.messageUuid,
      messageKeyId: envelope.messageKeyId,
      senderUserUuid: envelope.senderUserUuid,
      senderDeviceUuid: envelope.senderDeviceUuid,
      createdAt: envelope.createdAt,
      frankTagBase64Url: envelope.frankTagBase64Url,
    });

    expect(recorded.wire.startsWith(FSCP_WIRE_PREFIX)).toBe(true);
    expect(peekFscpWireFrankTagBase64Url(recorded.wire)).toBe(
      recorded.expected.frankTagBase64Url,
    );
    expect(fromBase64Url(recorded.expected.frankTagBase64Url)).toHaveLength(32);
    expect(envelope.messageUuid).toBe(recorded.expected.messageUuid);
    expect(envelope.messageKeyId).toBe(recorded.expected.messageKeyId);
    expect(envelope.createdAt).toBe(recorded.expected.createdAt);
    expect(opened.plaintext.blocks).toEqual([
      { kind: "text", body: recorded.expected.body },
    ]);
    expect(opened.plaintext.clientCreatedAt).toBe(recorded.expected.clientCreatedAt);
    expect(new TextDecoder().decode(opened.plaintextUtf8)).toBe(
      recorded.expected.plaintextUtf8,
    );
    expect(opened.frankingKeyBase64Url).toBe(
      recorded.expected.frankingKeyBase64Url,
    );
    expect(commitInput).toBe(recorded.expected.commitInputUtf8);
    expect(
      toBase64Url(
        computeFrankTagV1(
          fromBase64Url(recorded.expected.frankingKeyBase64Url),
          commitInput,
        ),
      ),
    ).toBe(recorded.expected.frankTagBase64Url);
    expect(aad).toBe(recorded.expected.bodyAadUtf8);
  });

  it("rejects a re-signed frankTag substitution at body AEAD", async () => {
    const recorded = vector.recordedWire;
    const original = decodeEnvelope(recorded.wire);
    const tampered = decodeEnvelope(recorded.tamperedFrankTagResignedWire);

    expect(tampered.frankTagBase64Url).toBe(recorded.tamperedFrankTagBase64Url);
    expect(tampered.frankTagBase64Url).not.toBe(original.frankTagBase64Url);
    expect(tampered.ciphertextBase64Url).toBe(original.ciphertextBase64Url);
    expect(tampered.senderSignatureBase64Url).not.toBe(
      original.senderSignatureBase64Url,
    );

    await expect(
      decryptFscpWireEnvelopeDetailed({
        wire: recorded.tamperedFrankTagResignedWire,
        viewerUserUuid: recorded.receiver.userUuid,
        agreementPrivateKey: fromBase64Url(
          recorded.receiver.agreementPrivateKeyBase64Url,
        ),
      }),
    ).rejects.toMatchObject({
      name: "FscpDecryptError",
      category: "body_decrypt_failed",
    });
  });
});
