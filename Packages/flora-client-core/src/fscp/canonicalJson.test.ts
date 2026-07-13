import { describe, expect, it } from "vitest";
import { canonicalJson, compareCodeUnits } from "./canonicalJson.js";

/**
 * Полный набор имён полей FSCP v1 wire (envelope + recipient + RKE + aead).
 * Гарантия «code-unit сортировка не меняет байты v1»: для этих ключей порядок
 * обязан совпадать с прежним localeCompare, иначе подписи старых конвертов
 * перестали бы проверяться.
 */
const V1_WIRE_KEYS = [
  "aead",
  "algorithm",
  "ciphertextBase64Url",
  "conversationUuid",
  "createdAt",
  "deviceUuid",
  "ephemeralPublicKeyBase64Url",
  "keyEpochId",
  "messageKeyId",
  "messageUuid",
  "name",
  "nonceBase64Url",
  "preKeyId",
  "recipientAgreementPublicKeyId",
  "recipientKeyEnvelope",
  "recipients",
  "saltBase64Url",
  "senderDeviceUuid",
  "senderSignatureBase64Url",
  "senderSigningPublicKeyBase64Url",
  "senderUserUuid",
  "userUuid",
  "version",
];

describe("canonicalJson (FSCP.md §Canonical encoding)", () => {
  it("sorts object keys by UTF-16 code unit, not locale", () => {
    // Code-unit: "B" (0x42) < "a" (0x61) < "b" (0x62); ICU localeCompare дал бы a, b, B.
    expect(canonicalJson({ b: 1, a: 2, B: 3 })).toBe('{"B":3,"a":2,"b":1}');
  });

  it("keeps v1 wire key order identical to legacy localeCompare (wire bytes unchanged)", () => {
    const codeUnit = [...V1_WIRE_KEYS].sort(compareCodeUnits);
    const legacy = [...V1_WIRE_KEYS].sort((a, b) => a.localeCompare(b));
    expect(codeUnit).toEqual(legacy);
    // И порядок в исходном списке уже канонический.
    expect(codeUnit).toEqual(V1_WIRE_KEYS);
  });

  it("produces a stable golden string for a nested envelope-like object", () => {
    const sample = {
      version: 1,
      recipients: [
        { userUuid: "AAAA", recipientKeyEnvelope: { preKeyId: null, version: 1 } },
        { userUuid: "bbbb", recipientKeyEnvelope: { preKeyId: null, version: 1 } },
      ],
      aead: { nonceBase64Url: "n0", name: "xchacha20-poly1305" },
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(canonicalJson(sample)).toBe(
      '{"aead":{"name":"xchacha20-poly1305","nonceBase64Url":"n0"},' +
        '"createdAt":"2026-01-01T00:00:00.000Z",' +
        '"recipients":[{"recipientKeyEnvelope":{"preKeyId":null,"version":1},"userUuid":"AAAA"},' +
        '{"recipientKeyEnvelope":{"preKeyId":null,"version":1},"userUuid":"bbbb"}],' +
        '"version":1}',
    );
  });

  it("does not reorder arrays and escapes strings like JSON.stringify", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson({ s: 'кириллица "q" \n' })).toBe(`{"s":${JSON.stringify('кириллица "q" \n')}}`);
  });

  it("rejects unsupported types", () => {
    expect(() => canonicalJson(undefined)).toThrow();
    expect(() => canonicalJson(() => 1)).toThrow();
  });
});
