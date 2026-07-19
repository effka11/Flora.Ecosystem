/**
 * Errata-5 hardening (Documents/fscp/FSCP.md, FSCP-REVIEW.md):
 *  - паддинг plaintext до бакетов (скрытие длины от сервера/наблюдателя);
 *  - типизированные категории сбоев decrypt (FscpDecryptError);
 *  - forward-compat: неизвестные kind'ы блоков сохраняются placeholder'ом;
 *  - анти-DoS: классификация сбоев в FSM сессии (порог compromised_local).
 */
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { fromBase64Url } from "./base64url.js";
import { configureSodiumLoader, type SodiumModule } from "./sodium.js";
import {
  buildFscpWireEnvelope,
  decryptFscpWireEnvelope,
  FscpDecryptError,
  fscpDecryptFailureCategory,
  fscpPlaintextBucketBytes,
  padPlaintextJsonV1,
  type FscpMessagePlaintext,
} from "./envelope.js";
import {
  classifyDecryptFailure,
  createConversationSession,
  FSCP_DECRYPT_COMPROMISE_THRESHOLD,
  noteInboundDecrypted,
  noteInboundDecryptFailure,
} from "./conversationSession.js";
import { messageBlocksToPreview } from "./preview.js";

const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers") as SodiumModule;

const SENDER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RECEIVER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeAll(async () => {
  await sodium.ready;
  configureSodiumLoader(async () => sodium);
});

async function buildTestWire(body: string, payload?: FscpMessagePlaintext) {
  const senderBox = sodium.crypto_box_keypair();
  const senderSign = sodium.crypto_sign_keypair();
  const receiverBox = sodium.crypto_box_keypair();
  const wire = await buildFscpWireEnvelope({
    senderUserUuid: SENDER,
    receiverUserUuid: RECEIVER,
    senderAgreementPrivateKey: senderBox.privateKey.subarray(0, 32),
    senderSigningPrivateKey: senderSign.privateKey,
    receiverAgreementPublicKey: receiverBox.publicKey,
    messageBody: body,
    ...(payload ? { messagePayload: payload } : {}),
  });
  return { wire, receiverBox, senderBox };
}

describe("паддинг plaintext (errata-5)", () => {
  it("бакеты: шаг 256 Б до 4 КиБ, дальше шаг 1 КиБ", () => {
    expect(fscpPlaintextBucketBytes(0)).toBe(256);
    expect(fscpPlaintextBucketBytes(100)).toBe(256);
    expect(fscpPlaintextBucketBytes(247)).toBe(256);
    expect(fscpPlaintextBucketBytes(248)).toBe(512);
    expect(fscpPlaintextBucketBytes(1000)).toBe(1024);
    expect(fscpPlaintextBucketBytes(4000)).toBe(4096);
    expect(fscpPlaintextBucketBytes(4090)).toBe(5120);
    expect(fscpPlaintextBucketBytes(10_000)).toBe(10_240);
  });

  it("padPlaintextJsonV1 даёт валидный JSON ровно в размер бакета", () => {
    for (const body of ["", "x", "Привет 🌸", "a".repeat(500), "б".repeat(3000)]) {
      const json = JSON.stringify({
        type: "blocks",
        version: 1,
        blocks: [{ kind: "text", body }],
        clientCreatedAt: "2026-01-01T00:00:00.000Z",
      });
      const padded = padPlaintextJsonV1(json);
      const paddedLen = new TextEncoder().encode(padded).byteLength;
      expect(paddedLen).toBe(fscpPlaintextBucketBytes(new TextEncoder().encode(json).byteLength));
      const parsed = JSON.parse(padded) as Record<string, unknown>;
      expect(parsed.type).toBe("blocks");
      expect((parsed.blocks as unknown[]).length).toBe(1);
      expect(typeof parsed.pad).toBe("string");
    }
  });

  it("сообщения разной длины внутри одного бакета дают одинаковую длину ciphertext", async () => {
    const a = await buildTestWire("ok");
    const b = await buildTestWire("немного длиннее, но тот же бакет");
    const ctLen = (wire: string) => {
      const json = new TextDecoder().decode(fromBase64Url(wire.slice("fscp1:".length)));
      const env = JSON.parse(json) as { ciphertextBase64Url: string };
      return env.ciphertextBase64Url.length;
    };
    expect(ctLen(a.wire)).toBe(ctLen(b.wire));
  });

  it("паддинг прозрачен для получателя (поле pad не всплывает)", async () => {
    const { wire, receiverBox } = await buildTestWire("проверка паддинга");
    const plain = await decryptFscpWireEnvelope({
      wire,
      viewerUserUuid: RECEIVER,
      agreementPrivateKey: receiverBox.privateKey.subarray(0, 32),
    });
    expect(plain.blocks).toEqual([{ kind: "text", body: "проверка паддинга" }]);
    expect("pad" in plain).toBe(false);
  });
});

describe("категории сбоев decrypt (FscpDecryptError)", () => {
  it("not_fscp_wire", async () => {
    await expect(
      decryptFscpWireEnvelope({ wire: "plain text", viewerUserUuid: RECEIVER, agreementPrivateKey: new Uint8Array(32) }),
    ).rejects.toMatchObject({ category: "not_fscp_wire" });
  });

  it("malformed_envelope", async () => {
    await expect(
      decryptFscpWireEnvelope({ wire: "fscp1:%%%", viewerUserUuid: RECEIVER, agreementPrivateKey: new Uint8Array(32) }),
    ).rejects.toMatchObject({ category: "malformed_envelope" });
  });

  it("no_recipient_entry для стороннего пользователя", async () => {
    const { wire } = await buildTestWire("hi");
    await expect(
      decryptFscpWireEnvelope({
        wire,
        viewerUserUuid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        agreementPrivateKey: new Uint8Array(32),
      }),
    ).rejects.toMatchObject({ category: "no_recipient_entry" });
  });

  it("rke_unwrap_failed при чужом agreement-ключе", async () => {
    const { wire } = await buildTestWire("hi");
    const stranger = sodium.crypto_box_keypair();
    await expect(
      decryptFscpWireEnvelope({
        wire,
        viewerUserUuid: RECEIVER,
        agreementPrivateKey: stranger.privateKey.subarray(0, 32),
      }),
    ).rejects.toMatchObject({ category: "rke_unwrap_failed" });
  });

  it("fscpDecryptFailureCategory даёт malformed_envelope для посторонних ошибок", () => {
    expect(fscpDecryptFailureCategory(new Error("x"))).toBe("malformed_envelope");
    expect(fscpDecryptFailureCategory(new FscpDecryptError("body_decrypt_failed", "x"))).toBe("body_decrypt_failed");
  });

  it("сборка конверта с некорректным ключом подписи падает, а не подписывает случайным ключом", async () => {
    const senderBox = sodium.crypto_box_keypair();
    const receiverBox = sodium.crypto_box_keypair();
    await expect(
      buildFscpWireEnvelope({
        senderUserUuid: SENDER,
        receiverUserUuid: RECEIVER,
        senderAgreementPrivateKey: senderBox.privateKey.subarray(0, 32),
        senderSigningPrivateKey: new Uint8Array(16),
        receiverAgreementPublicKey: receiverBox.publicKey,
        messageBody: "x",
      }),
    ).rejects.toThrow();
  });
});

describe("forward-compat: неизвестные kind'ы блоков", () => {
  it("незнакомый блок сохраняется placeholder'ом, а не выбрасывается", async () => {
    const payload = {
      type: "blocks",
      version: 1,
      blocks: [
        { kind: "text", body: "до" },
        { kind: "sticker", stickerId: "flower-42" },
        { kind: "text", body: "после" },
      ],
      clientCreatedAt: "2026-01-01T00:00:00.000Z",
    } as unknown as FscpMessagePlaintext;
    const { wire, receiverBox } = await buildTestWire("", payload);
    const plain = await decryptFscpWireEnvelope({
      wire,
      viewerUserUuid: RECEIVER,
      agreementPrivateKey: receiverBox.privateKey.subarray(0, 32),
    });
    expect(plain.blocks).toEqual([
      { kind: "text", body: "до" },
      { kind: "unknown", originalKind: "sticker" },
      { kind: "text", body: "после" },
    ]);
    expect(messageBlocksToPreview(plain.blocks)).toBe("до · Сообщение · после");
  });
});

describe("анти-DoS: классификация сбоев в FSM сессии", () => {
  const BASE = {
    conversationUuid: "b338d82e-ee40-53a4-a6c4-bd587cd2f7c1",
    keyEpochId: "00000000-0000-4000-8000-000000000001",
    peerUserUuid: RECEIVER,
  };

  it("отклонённый конверт (форма/подпись) не трогает сессию", () => {
    const s0 = noteInboundDecrypted(createConversationSession(BASE), "33333333-3333-4333-8333-333333333333").session;
    for (const cat of ["not_fscp_wire", "malformed_envelope", "signature_missing", "signature_invalid", "no_recipient_entry", "malformed_plaintext"] as const) {
      const { session, compromisedNow } = noteInboundDecryptFailure(s0, cat);
      expect(compromisedNow).toBe(false);
      expect(session.sessionState).toBe("ready");
      expect(session.consecutiveDecryptFailures ?? 0).toBe(0);
      expect(classifyDecryptFailure(cat)).toBe("envelope_rejected");
    }
  });

  it("одиночный key-mismatch-сбой не замораживает исходящие", () => {
    const s0 = createConversationSession(BASE);
    const { session, compromisedNow } = noteInboundDecryptFailure(s0, "rke_unwrap_failed");
    expect(compromisedNow).toBe(false);
    expect(session.sessionState).toBe("uninitialized");
    expect(session.consecutiveDecryptFailures).toBe(1);
  });

  it(`${FSCP_DECRYPT_COMPROMISE_THRESHOLD} подряд key-mismatch-сбоя → compromised_local(decrypt_failure)`, () => {
    let s = createConversationSession(BASE);
    let compromised = false;
    for (let i = 0; i < FSCP_DECRYPT_COMPROMISE_THRESHOLD; i++) {
      const out = noteInboundDecryptFailure(s, i % 2 === 0 ? "rke_unwrap_failed" : "body_decrypt_failed");
      s = out.session;
      compromised = out.compromisedNow;
    }
    expect(compromised).toBe(true);
    expect(s.sessionState).toBe("compromised_local");
    expect(s.compromiseReason).toBe("decrypt_failure");
  });

  it("успешный decrypt сбрасывает счётчик сбоев", () => {
    let s = createConversationSession(BASE);
    s = noteInboundDecryptFailure(s, "rke_unwrap_failed").session;
    s = noteInboundDecryptFailure(s, "body_decrypt_failed").session;
    s = noteInboundDecrypted(s, "44444444-4444-4444-8444-444444444444").session;
    expect(s.consecutiveDecryptFailures).toBe(0);
    const after = noteInboundDecryptFailure(s, "rke_unwrap_failed");
    expect(after.session.consecutiveDecryptFailures).toBe(1);
    expect(after.session.sessionState).toBe("ready");
  });

  it("в compromised_local повторные сбои идемпотентны", () => {
    let s = createConversationSession(BASE);
    for (let i = 0; i < FSCP_DECRYPT_COMPROMISE_THRESHOLD; i++) {
      s = noteInboundDecryptFailure(s, "rke_unwrap_failed").session;
    }
    const { session, compromisedNow } = noteInboundDecryptFailure(s, "rke_unwrap_failed");
    expect(compromisedNow).toBe(false);
    expect(session).toBe(s);
  });
});
