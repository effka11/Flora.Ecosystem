import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { utf8Bytes } from "../src/base64url.js";
import { padPlaintextJsonV1 } from "../src/envelope.js";
import {
  computeFrankTagV1,
  encodeFrankingComplaintBundleV2,
  encodeFrankingComplaintDisclosureV1,
  frankCommitInputV1,
  frankReceiptPayloadV1,
  frankingWrapAadV2,
  sealFrankingComplaintBundleV2,
  unwrapReportContentKeyV2,
  wrapReportContentKeyV2,
  type FrankingComplaintDisclosureInputV1,
} from "../src/franking.js";
import { scalarmultBase, type SodiumModule } from "../src/sodium.js";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers") as SodiumModule;
await sodium.ready;

const b64 = (value: Uint8Array): string =>
  sodium.to_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
const bytes = (start: number, length: number): Uint8Array =>
  Uint8Array.from({ length }, (_, index) => (start + index) & 0xff);
const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

function sodiumWithRandomSequence(sequence: readonly Uint8Array[]): SodiumModule {
  let index = 0;
  return new Proxy(sodium, {
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
  }) as SodiumModule;
}

const bundleUuid = "11111111-1111-4111-8111-111111111111";
const reviewerUserUuid = "22222222-2222-4222-8222-222222222222";
const reviewerDeviceUuid = "33333333-3333-4333-8333-333333333333";
const conversationUuid = "44444444-4444-4444-8444-444444444444";
const senderUserUuid = "55555555-5555-4555-8555-555555555555";
const senderDeviceUuid = "66666666-6666-4666-8666-666666666666";
const receiverUserUuid = "77777777-7777-4777-8777-777777777777";
const serverReceivedAt = "2026-08-22T14:00:00.000Z";
const serverSigning = sodium.crypto_sign_seed_keypair!(bytes(1, 32));

function metadata(index: 1 | 2) {
  return {
    messageUuid:
      index === 1
        ? "88888888-8888-4888-8888-888888888888"
        : "99999999-9999-4999-8999-999999999999",
    persistedMessageUuid:
      index === 1
        ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    conversationUuid,
    senderUserUuid,
    senderDeviceUuid,
    receiverUserUuid,
    createdAt:
      index === 1 ? "2026-08-22T13:59:58.000Z" : "2026-08-22T13:59:59.000Z",
  };
}

const firstMetadata = metadata(1);
const firstFrankingKey = bytes(33, 32);
const firstFrankingKeyBase64Url = b64(firstFrankingKey);
const firstPlaintextUtf8 = utf8Bytes(
  padPlaintextJsonV1(
    JSON.stringify({
      type: "blocks",
      version: 1,
      blocks: [{ kind: "text", body: "first canonical disclosure" }],
      clientCreatedAt: firstMetadata.createdAt,
      frankingKeyBase64Url: firstFrankingKeyBase64Url,
    }),
  ),
);
const firstCommitInputUtf8 = frankCommitInputV1(firstMetadata, firstPlaintextUtf8);
const firstFrankTagBase64Url = b64(
  computeFrankTagV1(firstFrankingKey, firstCommitInputUtf8),
);
const firstReceiptPayloadUtf8 = frankReceiptPayloadV1({
  frankTagBase64Url: firstFrankTagBase64Url,
  messageUuid: firstMetadata.messageUuid,
  conversationUuid: firstMetadata.conversationUuid,
  senderUserUuid: firstMetadata.senderUserUuid,
  receiverUserUuid: firstMetadata.receiverUserUuid,
  serverReceivedAt,
});
const firstComplaint: FrankingComplaintDisclosureInputV1 = {
  plaintextUtf8: firstPlaintextUtf8,
  frankingKeyBase64Url: firstFrankingKeyBase64Url,
  frankTagBase64Url: firstFrankTagBase64Url,
  serverFrankReceipt: {
    signatureBase64Url: b64(
      sodium.crypto_sign_detached(
        utf8Bytes(firstReceiptPayloadUtf8),
        serverSigning.privateKey,
      ),
    ),
    serverFrankingKeyId: "golden-franking-key-1",
    serverReceivedAt,
  },
  ...firstMetadata,
};

const secondMetadata = metadata(2);
const secondPlaintextUtf8 = utf8Bytes(
  padPlaintextJsonV1(
    JSON.stringify({
      type: "blocks",
      version: 1,
      blocks: [{ kind: "text", body: "second canonical disclosure" }],
      clientCreatedAt: secondMetadata.createdAt,
    }),
  ),
);
const secondComplaint: FrankingComplaintDisclosureInputV1 = {
  plaintextUtf8: secondPlaintextUtf8,
  frankingKeyBase64Url: null,
  frankTagBase64Url: null,
  serverFrankReceipt: null,
  ...secondMetadata,
};
const messages = [firstComplaint, secondComplaint];

const disclosureCanonicalBytes = encodeFrankingComplaintDisclosureV1(
  sodium,
  firstComplaint,
);
const bundleCanonicalBytes = encodeFrankingComplaintBundleV2(sodium, {
  bundleUuid,
  messages,
});

const reportContentKey = bytes(65, 32);
const disclosureNonce = bytes(97, 24);
const sealed = sealFrankingComplaintBundleV2(
  sodiumWithRandomSequence([reportContentKey, disclosureNonce]),
  { bundleUuid, messages },
);
if (!equalBytes(sealed.reportContentKey, reportContentKey)) {
  throw new Error("Deterministic reportContentKey was not used.");
}

const reviewerAgreementPrivateKey = bytes(121, 32);
const reviewerAgreementPublicKey = scalarmultBase(
  sodium,
  reviewerAgreementPrivateKey,
);
const wrapSalt = bytes(153, 32);
const wrapEphemeralSecret = bytes(185, 32);
const wrapNonce = bytes(217, 24);
const wrapTarget = {
  userUuid: reviewerUserUuid,
  deviceUuid: reviewerDeviceUuid,
  agreementPublicKey: reviewerAgreementPublicKey,
};
const wrapped = wrapReportContentKeyV2(
  sodiumWithRandomSequence([wrapSalt, wrapEphemeralSecret, wrapNonce]),
  {
    reportContentKey,
    bundleUuid,
    target: wrapTarget,
  },
);
const unwrapped = unwrapReportContentKeyV2(sodium, {
  wrappedKey: wrapped.wrappedKey,
  bundleUuid,
  userUuid: reviewerUserUuid,
  deviceUuid: reviewerDeviceUuid,
  agreementPrivateKey: reviewerAgreementPrivateKey,
});
if (!equalBytes(unwrapped, reportContentKey)) {
  throw new Error("Generated v2 wrap does not unwrap to reportContentKey.");
}

function serializeComplaint(input: FrankingComplaintDisclosureInputV1) {
  return {
    plaintextUtf8: new TextDecoder().decode(input.plaintextUtf8),
    frankingKeyBase64Url: input.frankingKeyBase64Url,
    frankTagBase64Url: input.frankTagBase64Url,
    serverFrankReceipt: input.serverFrankReceipt,
    messageUuid: input.messageUuid,
    persistedMessageUuid: input.persistedMessageUuid,
    conversationUuid: input.conversationUuid,
    senderUserUuid: input.senderUserUuid,
    senderDeviceUuid: input.senderDeviceUuid,
    receiverUserUuid: input.receiverUserUuid,
    createdAt: input.createdAt,
  };
}

const vector = {
  vectorId: "fscp_franking_disclosure_bundle_v2",
  fscpProtocolVersion: 1.1,
  generatedBy:
    "Products/FSCP/ts/scripts/generateFrankingDisclosureV2Vector.ts",
  disclosureV1: {
    input: serializeComplaint(firstComplaint),
    expected: {
      canonicalUtf8: new TextDecoder().decode(disclosureCanonicalBytes),
      canonicalBytesBase64Url: b64(disclosureCanonicalBytes),
    },
  },
  bundleV2: {
    input: {
      bundleUuid,
      messages: messages.map(serializeComplaint),
    },
    expected: {
      canonicalUtf8: new TextDecoder().decode(bundleCanonicalBytes),
      canonicalBytesBase64Url: b64(bundleCanonicalBytes),
    },
    sealed: {
      reportContentKeyBase64Url: b64(reportContentKey),
      nonceBase64Url: b64(disclosureNonce),
      disclosureCiphertextBase64Url: sealed.disclosureCiphertext,
    },
  },
  wrapV2: {
    target: {
      userUuid: reviewerUserUuid,
      deviceUuid: reviewerDeviceUuid,
      agreementPrivateKeyBase64Url: b64(reviewerAgreementPrivateKey),
      agreementPublicKeyBase64Url: b64(reviewerAgreementPublicKey),
    },
    randomInputs: {
      saltBase64Url: b64(wrapSalt),
      ephemeralSecretBase64Url: b64(wrapEphemeralSecret),
      nonceBase64Url: b64(wrapNonce),
    },
    expected: {
      aadUtf8: frankingWrapAadV2({
        bundleUuid,
        userUuid: reviewerUserUuid,
        deviceUuid: reviewerDeviceUuid,
      }),
      wrappedKey: wrapped.wrappedKey,
    },
  },
};

const output = resolve(
  process.cwd(),
  "../../Documents/test-vectors/fscp-franking-disclosure-bundle-v2.json",
);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(vector, null, 2)}\n`, "utf8");
console.log(output);
