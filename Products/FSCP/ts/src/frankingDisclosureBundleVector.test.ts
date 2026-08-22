/**
 * Consumer regenerate-only golden-вектора disclosure v1 + bundle/wrap v2.
 * Регенерация:
 * npm run generate:franking-disclosure-bundle-v2-vector --workspace=@flora/fscp
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { utf8Bytes } from "./base64url.js";
import {
  decodeFrankingComplaintBundleV2,
  encodeFrankingComplaintBundleV2,
  encodeFrankingComplaintDisclosureV1,
  frankingWrapAadV2,
  openFrankingDisclosureV1,
  sealFrankingComplaintBundleV2,
  unwrapReportContentKeyV2,
  wrapReportContentKeyV2,
  type FrankingComplaintDisclosureInputV1,
  type ServerFrankReceiptV1,
} from "./franking.js";
import { decodeFrankingComplaintDisclosureV1 } from "./frankingDisclosure.js";
import type { SodiumModule } from "./sodium.js";
import { toBase64Url } from "./unlockFlow.js";
import { fromBase64Url } from "./base64url.js";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers") as SodiumModule;

type SerializedComplaint = {
  plaintextUtf8: string;
  frankingKeyBase64Url: string | null;
  frankTagBase64Url: string | null;
  serverFrankReceipt: ServerFrankReceiptV1 | null;
  messageUuid: string;
  persistedMessageUuid: string;
  conversationUuid: string;
  senderUserUuid: string;
  senderDeviceUuid: string;
  receiverUserUuid: string;
  createdAt: string;
};

type DisclosureBundleVector = {
  vectorId: string;
  fscpProtocolVersion: number;
  disclosureV1: {
    input: SerializedComplaint;
    expected: {
      canonicalUtf8: string;
      canonicalBytesBase64Url: string;
    };
  };
  bundleV2: {
    input: {
      bundleUuid: string;
      messages: SerializedComplaint[];
    };
    expected: {
      canonicalUtf8: string;
      canonicalBytesBase64Url: string;
    };
    sealed: {
      reportContentKeyBase64Url: string;
      nonceBase64Url: string;
      disclosureCiphertextBase64Url: string;
    };
  };
  wrapV2: {
    target: {
      userUuid: string;
      deviceUuid: string;
      agreementPrivateKeyBase64Url: string;
      agreementPublicKeyBase64Url: string;
    };
    randomInputs: {
      saltBase64Url: string;
      ephemeralSecretBase64Url: string;
      nonceBase64Url: string;
    };
    expected: {
      aadUtf8: string;
      wrappedKey: string;
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
  readFileSync(
    path.join(vectorsDir, "fscp-franking-disclosure-bundle-v2.json"),
    "utf8",
  ),
) as DisclosureBundleVector;

function complaint(input: SerializedComplaint): FrankingComplaintDisclosureInputV1 {
  return {
    ...input,
    plaintextUtf8: utf8Bytes(input.plaintextUtf8),
  };
}

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

beforeAll(async () => {
  await sodium.ready;
});

describe("golden: fscp-franking-disclosure-bundle-v2.json", () => {
  it("declares fscpProtocolVersion 1.1", () => {
    expect(vector.vectorId).toBe("fscp_franking_disclosure_bundle_v2");
    expect(vector.fscpProtocolVersion).toBe(1.1);
  });

  it("reproduces canonical disclosure v1 bytes exactly", () => {
    const encoded = encodeFrankingComplaintDisclosureV1(
      sodium,
      complaint(vector.disclosureV1.input),
    );
    const decoded = decodeFrankingComplaintDisclosureV1(encoded);

    expect(new TextDecoder().decode(encoded)).toBe(
      vector.disclosureV1.expected.canonicalUtf8,
    );
    expect(toBase64Url(encoded)).toBe(
      vector.disclosureV1.expected.canonicalBytesBase64Url,
    );
    expect(decoded.messageUuid).toBe(vector.disclosureV1.input.messageUuid);
    expect(decoded.plaintextUtf8Base64Url).toBe(
      toBase64Url(utf8Bytes(vector.disclosureV1.input.plaintextUtf8)),
    );
  });

  it("reproduces canonical bundle v2 bytes and decodes both tuples", () => {
    const messages = vector.bundleV2.input.messages.map(complaint);
    const encoded = encodeFrankingComplaintBundleV2(sodium, {
      bundleUuid: vector.bundleV2.input.bundleUuid,
      messages,
    });
    const decoded = decodeFrankingComplaintBundleV2(encoded);

    expect(new TextDecoder().decode(encoded)).toBe(
      vector.bundleV2.expected.canonicalUtf8,
    );
    expect(toBase64Url(encoded)).toBe(
      vector.bundleV2.expected.canonicalBytesBase64Url,
    );
    expect(decoded.bundleUuid).toBe(vector.bundleV2.input.bundleUuid);
    expect(decoded.messages.map((message) => message.messageUuid)).toEqual(
      vector.bundleV2.input.messages.map((message) => message.messageUuid),
    );
  });

  it("reproduces and opens the fixed bundle seal", () => {
    const messages = vector.bundleV2.input.messages.map(complaint);
    const reportContentKey = fromBase64Url(
      vector.bundleV2.sealed.reportContentKeyBase64Url,
    );
    const nonce = fromBase64Url(vector.bundleV2.sealed.nonceBase64Url);
    const reproduced = sealFrankingComplaintBundleV2(
      sodiumWithRandomSequence([reportContentKey, nonce]),
      {
        bundleUuid: vector.bundleV2.input.bundleUuid,
        messages,
      },
    );

    expect(toBase64Url(reproduced.reportContentKey)).toBe(
      vector.bundleV2.sealed.reportContentKeyBase64Url,
    );
    expect(reproduced.disclosureCiphertext).toBe(
      vector.bundleV2.sealed.disclosureCiphertextBase64Url,
    );

    const opened = openFrankingDisclosureV1(
      sodium,
      fromBase64Url(vector.bundleV2.sealed.disclosureCiphertextBase64Url),
      reportContentKey,
    );
    expect(new TextDecoder().decode(opened)).toBe(
      vector.bundleV2.expected.canonicalUtf8,
    );
    expect(decodeFrankingComplaintBundleV2(opened).messages).toHaveLength(2);
  });

  it("reproduces wrap v2 bytes and unwraps the fixed reportContentKey", () => {
    const target = vector.wrapV2.target;
    const reportContentKey = fromBase64Url(
      vector.bundleV2.sealed.reportContentKeyBase64Url,
    );
    const wrapped = wrapReportContentKeyV2(
      sodiumWithRandomSequence([
        fromBase64Url(vector.wrapV2.randomInputs.saltBase64Url),
        fromBase64Url(vector.wrapV2.randomInputs.ephemeralSecretBase64Url),
        fromBase64Url(vector.wrapV2.randomInputs.nonceBase64Url),
      ]),
      {
        reportContentKey,
        bundleUuid: vector.bundleV2.input.bundleUuid,
        target: {
          userUuid: target.userUuid,
          deviceUuid: target.deviceUuid,
          agreementPublicKey: fromBase64Url(
            target.agreementPublicKeyBase64Url,
          ),
        },
      },
    );

    expect(
      frankingWrapAadV2({
        bundleUuid: vector.bundleV2.input.bundleUuid,
        userUuid: target.userUuid,
        deviceUuid: target.deviceUuid,
      }),
    ).toBe(vector.wrapV2.expected.aadUtf8);
    expect(wrapped.wrappedKey).toBe(vector.wrapV2.expected.wrappedKey);
    expect(
      toBase64Url(
        unwrapReportContentKeyV2(sodium, {
          wrappedKey: vector.wrapV2.expected.wrappedKey,
          bundleUuid: vector.bundleV2.input.bundleUuid,
          userUuid: target.userUuid,
          deviceUuid: target.deviceUuid,
          agreementPrivateKey: fromBase64Url(
            target.agreementPrivateKeyBase64Url,
          ),
        }),
      ),
    ).toBe(vector.bundleV2.sealed.reportContentKeyBase64Url);
  });

  it("rejects unwrap under a different bundle scope", () => {
    const target = vector.wrapV2.target;
    expect(() =>
      unwrapReportContentKeyV2(sodium, {
        wrappedKey: vector.wrapV2.expected.wrappedKey,
        bundleUuid: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        userUuid: target.userUuid,
        deviceUuid: target.deviceUuid,
        agreementPrivateKey: fromBase64Url(
          target.agreementPrivateKeyBase64Url,
        ),
      }),
    ).toThrow();
  });
});
