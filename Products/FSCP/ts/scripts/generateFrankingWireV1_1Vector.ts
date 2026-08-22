import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { messageBodyAadLine } from "../src/aad.js";
import { fromBase64Url, utf8Bytes } from "../src/base64url.js";
import { canonicalJson } from "../src/canonicalJson.js";
import {
  FSCP_BOOTSTRAP_DEVICE_UUID,
  FSCP_BOOTSTRAP_KEY_EPOCH_ID,
  FSCP_WIRE_PREFIX,
} from "../src/constants.js";
import { dmConversationUuid } from "../src/deriveIds.js";
import {
  buildFscpWireEnvelope,
  decryptFscpWireEnvelopeDetailed,
  padPlaintextJsonV1,
  type FscpEnvelopeWire,
  type FscpMessagePlaintext,
} from "../src/envelope.js";
import { computeFrankTagV1, frankCommitInputV1 } from "../src/franking.js";
import { withFloraGoldenClock } from "../src/floraUuid.js";
import { configureSodiumLoader, scalarmultBase, type SodiumModule } from "../src/sodium.js";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers") as SodiumModule;
await sodium.ready;

const b64 = (value: Uint8Array): string =>
  sodium.to_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
const bytes = (start: number, length: number): Uint8Array =>
  Uint8Array.from({ length }, (_, index) => (start + index) & 0xff);

function sodiumWithRandomSequence(sequence: readonly Uint8Array[]): {
  sodium: SodiumModule;
  assertExhausted: () => void;
} {
  let index = 0;
  return {
    sodium: new Proxy(sodium, {
      get(target, property, receiver) {
        if (property === "randombytes_buf") {
          return (length: number): Uint8Array => {
            const next = sequence[index++];
            if (!next || next.length !== length) {
              throw new Error(
                `Deterministic random sequence mismatch at ${index - 1}: requested ${length} bytes.`,
              );
            }
            return next.slice();
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as SodiumModule,
    assertExhausted: () => {
      if (index !== sequence.length) {
        throw new Error(
          `Deterministic random sequence not exhausted: used ${index} of ${sequence.length}.`,
        );
      }
    },
  };
}

const senderUserUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const receiverUserUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const conversationUuid = dmConversationUuid(senderUserUuid, receiverUserUuid);
const deterministicMessageUuid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const deterministicMessageKeyId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const deterministicCreatedAt = "2026-08-22T12:34:56.789Z";
const deterministicFrankingKey = bytes(1, 32);
const deterministicFrankingKeyBase64Url = b64(deterministicFrankingKey);
const deterministicPlaintextUtf8 = padPlaintextJsonV1(
  JSON.stringify({
    type: "blocks",
    version: 1,
    blocks: [{ kind: "text", body: "FSCP v1.1 deterministic Algorithm A" }],
    clientCreatedAt: deterministicCreatedAt,
    frankingKeyBase64Url: deterministicFrankingKeyBase64Url,
  }),
);
const deterministicCommit = {
  conversationUuid,
  messageUuid: deterministicMessageUuid,
  senderUserUuid,
  senderDeviceUuid: FSCP_BOOTSTRAP_DEVICE_UUID,
  receiverUserUuid,
  createdAt: deterministicCreatedAt,
};
const deterministicCommitInputUtf8 = frankCommitInputV1(
  deterministicCommit,
  utf8Bytes(deterministicPlaintextUtf8),
);
const deterministicFrankTagBase64Url = b64(
  computeFrankTagV1(deterministicFrankingKey, deterministicCommitInputUtf8),
);
const deterministicBodyAadUtf8 = messageBodyAadLine({
  conversationUuid,
  keyEpochId: FSCP_BOOTSTRAP_KEY_EPOCH_ID,
  messageUuid: deterministicMessageUuid,
  messageKeyId: deterministicMessageKeyId,
  senderUserUuid,
  senderDeviceUuid: FSCP_BOOTSTRAP_DEVICE_UUID,
  createdAt: deterministicCreatedAt,
  frankTagBase64Url: deterministicFrankTagBase64Url,
});

const senderAgreementPrivateKey = bytes(41, 32);
const receiverAgreementPrivateKey = bytes(73, 32);
const receiverAgreementPublicKey = scalarmultBase(sodium, receiverAgreementPrivateKey);
const senderSigning = sodium.crypto_sign_seed_keypair!(bytes(105, 32));
const recordedMessageUuid = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const recordedMessageKeyId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const recordedCreatedAt = "2026-08-22T13:00:00.000Z";
const recordedClientCreatedAt = recordedCreatedAt;
const recordedBody = "FSCP v1.1 recorded wire roundtrip";
const recordedPayload: FscpMessagePlaintext = {
  type: "blocks",
  version: 1,
  blocks: [{ kind: "text", body: recordedBody }],
  clientCreatedAt: recordedClientCreatedAt,
};

const npub = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
const recordedRandom = [
  bytes(137, 32),
  bytes(169, 32),
  bytes(201, npub),
  bytes(10, 32),
  bytes(42, 32),
  bytes(74, npub),
  bytes(98, 32),
  bytes(130, 32),
  bytes(162, npub),
];
const sequenced = sodiumWithRandomSequence(recordedRandom);
configureSodiumLoader(async () => sequenced.sodium);

const wire = await withFloraGoldenClock(
  {
    uuids: [recordedMessageUuid, recordedMessageKeyId],
    createdAt: recordedCreatedAt,
  },
  () =>
    buildFscpWireEnvelope({
      senderUserUuid,
      receiverUserUuid,
      senderAgreementPrivateKey,
      senderSigningPrivateKey: senderSigning.privateKey,
      receiverAgreementPublicKey,
      messagePayload: recordedPayload,
      emitFrankTag: true,
    }),
);
sequenced.assertExhausted();
const opened = await decryptFscpWireEnvelopeDetailed({
  wire,
  viewerUserUuid: receiverUserUuid,
  agreementPrivateKey: receiverAgreementPrivateKey,
});
const envelope = opened.envelope;
const recordedFrankingKeyBase64Url = opened.frankingKeyBase64Url;
const recordedFrankTagBase64Url = envelope.frankTagBase64Url;
if (!recordedFrankingKeyBase64Url || !recordedFrankTagBase64Url) {
  throw new Error("Generated v1.1 wire did not contain franking material.");
}
if (
  envelope.messageUuid !== recordedMessageUuid ||
  envelope.messageKeyId !== recordedMessageKeyId ||
  envelope.createdAt !== recordedCreatedAt
) {
  throw new Error("Generated v1.1 wire did not honour the golden clock.");
}
const recordedCommit = {
  conversationUuid: envelope.conversationUuid,
  messageUuid: envelope.messageUuid,
  senderUserUuid: envelope.senderUserUuid,
  senderDeviceUuid: envelope.senderDeviceUuid,
  receiverUserUuid,
  createdAt: envelope.createdAt,
};
const recordedCommitInputUtf8 = frankCommitInputV1(recordedCommit, opened.plaintextUtf8);
const recordedBodyAadUtf8 = messageBodyAadLine({
  conversationUuid: envelope.conversationUuid,
  keyEpochId: envelope.keyEpochId,
  messageUuid: envelope.messageUuid,
  messageKeyId: envelope.messageKeyId,
  senderUserUuid: envelope.senderUserUuid,
  senderDeviceUuid: envelope.senderDeviceUuid,
  createdAt: envelope.createdAt,
  frankTagBase64Url: recordedFrankTagBase64Url,
});

const tamperedTag = fromBase64Url(recordedFrankTagBase64Url);
tamperedTag[0] = (tamperedTag[0] ?? 0) ^ 0x01;
const tamperedFrankTagBase64Url = b64(tamperedTag);
const { senderSignatureBase64Url: _signature, ...unsignedEnvelope } = envelope;
const tamperedUnsignedEnvelope = {
  ...unsignedEnvelope,
  frankTagBase64Url: tamperedFrankTagBase64Url,
};
const tamperedSignature = sodium.crypto_sign_detached(
  utf8Bytes(
    `flora.messaging.envelope-signature.v1 | ${canonicalJson(tamperedUnsignedEnvelope)}`,
  ),
  senderSigning.privateKey,
);
const tamperedEnvelope: FscpEnvelopeWire = {
  ...tamperedUnsignedEnvelope,
  senderSignatureBase64Url: b64(tamperedSignature),
};
const tamperedFrankTagResignedWire = `${FSCP_WIRE_PREFIX}${b64(
  utf8Bytes(JSON.stringify(tamperedEnvelope)),
)}`;

const vector = {
  vectorId: "fscp_franking_wire_v1_1",
  fscpProtocolVersion: 1.1,
  generatedBy: "Products/FSCP/ts/scripts/generateFrankingWireV1_1Vector.ts",
  deterministicAlgorithmA: {
    inputs: {
      frankingKeyBase64Url: deterministicFrankingKeyBase64Url,
      plaintextUtf8: deterministicPlaintextUtf8,
      commit: deterministicCommit,
      keyEpochId: FSCP_BOOTSTRAP_KEY_EPOCH_ID,
      messageKeyId: deterministicMessageKeyId,
    },
    expected: {
      commitInputUtf8: deterministicCommitInputUtf8,
      frankTagBase64Url: deterministicFrankTagBase64Url,
      bodyAadUtf8: deterministicBodyAadUtf8,
    },
  },
  recordedWire: {
    wire,
    tamperedFrankTagResignedWire,
    tamperedFrankTagBase64Url,
    receiver: {
      userUuid: receiverUserUuid,
      agreementPrivateKeyBase64Url: b64(receiverAgreementPrivateKey),
      agreementPublicKeyBase64Url: b64(receiverAgreementPublicKey),
    },
    expected: {
      body: recordedBody,
      clientCreatedAt: recordedClientCreatedAt,
      messageUuid: recordedMessageUuid,
      messageKeyId: recordedMessageKeyId,
      createdAt: recordedCreatedAt,
      plaintextUtf8: new TextDecoder().decode(opened.plaintextUtf8),
      frankingKeyBase64Url: recordedFrankingKeyBase64Url,
      frankTagBase64Url: recordedFrankTagBase64Url,
      commitInputUtf8: recordedCommitInputUtf8,
      bodyAadUtf8: recordedBodyAadUtf8,
    },
  },
};

const output = resolve(
  process.cwd(),
  "../../Documents/test-vectors/fscp-franking-wire-v1_1.json",
);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(vector, null, 2)}\n`, "utf8");
console.log(output);
