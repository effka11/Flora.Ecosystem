/**
 * Cross-impl parity (docs/fscp/FSCP.md §Test vectors): байт-критичные модули
 * Apps/Web/lib/fscp обязаны давать идентичный результат с Packages/flora-client-core
 * до консолидации клиентов (next-architecture.md §9). Дрейф = молчаливая потеря
 * совместимости wire между Web и Mobile.
 */
import { describe, expect, it } from "vitest";
import { messageBodyAadLine, recipientKeyEnvelopeAadLine } from "./aad.js";
import { canonicalJson } from "./canonicalJson.js";
import {
  FLORA_UUID_NAMESPACE,
  FSCP_BOOTSTRAP_DEVICE_UUID,
  FSCP_BOOTSTRAP_KEY_EPOCH_ID,
  FSCP_WIRE_PREFIX,
} from "./constants.js";
import { agreementPublicKeyId, dmConversationUuid } from "./deriveIds.js";
import {
  messageBodyAadLine as webMessageBodyAadLine,
  recipientKeyEnvelopeAadLine as webRecipientKeyEnvelopeAadLine,
} from "../../../../Apps/Web/lib/fscp/aad";
import { canonicalJson as webCanonicalJson } from "../../../../Apps/Web/lib/fscp/canonicalJson";
import * as webConstants from "../../../../Apps/Web/lib/fscp/constants";
import {
  agreementPublicKeyId as webAgreementPublicKeyId,
  dmConversationUuid as webDmConversationUuid,
} from "../../../../Apps/Web/lib/fscp/deriveIds";

const AAD_PARAMS = {
  conversationUuid: "11111111-1111-4111-8111-111111111111",
  keyEpochId: "22222222-2222-4222-8222-222222222222",
  messageUuid: "33333333-3333-4333-8333-333333333333",
  messageKeyId: "44444444-4444-4444-8444-444444444444",
  senderUserUuid: "55555555-5555-4555-8555-555555555555",
  senderDeviceUuid: "66666666-6666-4666-8666-666666666666",
};

const MIXED_CASE = {
  ...AAD_PARAMS,
  conversationUuid: "11111111-1111-4111-8111-111111111111".toUpperCase(),
  senderUserUuid: "0198C5B6-7E2D-7ABC-9DEF-0123456789AB",
};

describe("web ↔ client-core parity (byte-critical fscp modules)", () => {
  it("constants are identical", () => {
    expect(webConstants.FSCP_WIRE_PREFIX).toBe(FSCP_WIRE_PREFIX);
    expect(webConstants.FSCP_BOOTSTRAP_KEY_EPOCH_ID).toBe(FSCP_BOOTSTRAP_KEY_EPOCH_ID);
    expect(webConstants.FSCP_BOOTSTRAP_DEVICE_UUID).toBe(FSCP_BOOTSTRAP_DEVICE_UUID);
    expect(webConstants.FLORA_UUID_NAMESPACE).toBe(FLORA_UUID_NAMESPACE);
  });

  it("recipientKeyEnvelopeAadLine is identical (incl. mixed-case input)", () => {
    for (const base of [AAD_PARAMS, MIXED_CASE]) {
      const params = {
        ...base,
        recipientUserUuid: "77777777-7777-4777-8777-777777777777",
        recipientDeviceUuid: "88888888-8888-4888-8888-888888888888",
        recipientAgreementPublicKeyId: "99999999-9999-4999-8999-999999999999",
      };
      expect(webRecipientKeyEnvelopeAadLine(params)).toBe(recipientKeyEnvelopeAadLine(params));
    }
  });

  it("messageBodyAadLine is identical", () => {
    const params = { ...AAD_PARAMS, createdAt: "2026-07-13T00:00:00.000Z" };
    expect(webMessageBodyAadLine(params)).toBe(messageBodyAadLine(params));
  });

  it("canonicalJson is identical on nested mixed-case structures", () => {
    const samples: unknown[] = [
      { b: 1, a: 2, B: 3, nested: { z: [3, 1, { y: null, x: "т" }], A: true } },
      { version: 1, recipients: [{ userUuid: "AA" }, { userUuid: "aa" }], preKeyId: null },
      ["mixed", 1, null, { k: "v" }],
    ];
    for (const s of samples) {
      expect(webCanonicalJson(s)).toBe(canonicalJson(s));
    }
  });

  it("deriveIds are identical (incl. argument order and case)", () => {
    const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const b = "0198C5B6-7E2D-7ABC-9DEF-0123456789AB";
    expect(webDmConversationUuid(a, b)).toBe(dmConversationUuid(a, b));
    expect(webDmConversationUuid(b, a)).toBe(dmConversationUuid(a, b));
    expect(webAgreementPublicKeyId(b, FSCP_BOOTSTRAP_KEY_EPOCH_ID)).toBe(
      agreementPublicKeyId(b, FSCP_BOOTSTRAP_KEY_EPOCH_ID),
    );
  });
});
