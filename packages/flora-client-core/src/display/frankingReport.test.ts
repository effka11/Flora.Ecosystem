import { describe, expect, it } from "vitest";
import { FSCP_WIRE_PREFIX, toBase64Url, utf8Bytes } from "@flora/fscp";
import {
  canReportMessage,
  FRANKING_MISSING_RECEIPT_MESSAGE,
  FRANKING_MISSING_RECEIPT_WARNING,
  FRANKING_REPORT_CATEGORY_OPTIONS,
  frankingMissingReceiptWarning,
} from "./frankingReport.js";

function taggedWireWithoutReceipt(): string {
  return `${FSCP_WIRE_PREFIX}${toBase64Url(utf8Bytes(JSON.stringify({ frankTagBase64Url: "tag" })))}`;
}

describe("canReportMessage", () => {
  it("allows an incoming 1:1 message", () => {
    expect(canReportMessage({ isFromMe: false, isGroupChat: false })).toBe(true);
  });

  it("blocks own messages, groups, sending, decrypting, failed decrypt, and tagged without receipt", () => {
    expect(canReportMessage({ isFromMe: true, isGroupChat: false })).toBe(false);
    expect(canReportMessage({ isFromMe: false, isGroupChat: true })).toBe(false);
    expect(
      canReportMessage({ isFromMe: false, isGroupChat: false, sendStatus: "sending" }),
    ).toBe(false);
    expect(
      canReportMessage({ isFromMe: false, isGroupChat: false, decryptState: "decrypting" }),
    ).toBe(false);
    expect(
      canReportMessage({ isFromMe: false, isGroupChat: false, decryptState: "failed" }),
    ).toBe(false);
    expect(
      canReportMessage({
        isFromMe: false,
        isGroupChat: false,
        frankTagBase64Url: "tag",
        hasServerFrankReceipt: false,
      }),
    ).toBe(false);
    expect(
      canReportMessage({
        isFromMe: false,
        isGroupChat: false,
        frankTagBase64Url: "tag",
        hasServerFrankReceipt: true,
      }),
    ).toBe(true);
    expect(
      canReportMessage({
        isFromMe: false,
        isGroupChat: false,
        wire: taggedWireWithoutReceipt(),
        hasServerFrankReceipt: false,
      }),
    ).toBe(false);
  });

  it("keeps franking category values", () => {
    expect(FRANKING_REPORT_CATEGORY_OPTIONS.map((item) => item.value)).toEqual([
      "abuse",
      "threats",
      "spam",
      "csam",
      "other",
    ]);
  });
});

describe("frankingMissingReceiptWarning", () => {
  it("warns tagged 1:1 messages without a receipt, including own", () => {
    expect(
      frankingMissingReceiptWarning({
        isGroupChat: false,
        frankTagBase64Url: "tag",
        hasServerFrankReceipt: false,
      }),
    ).toBe(true);
    expect(
      frankingMissingReceiptWarning({
        isGroupChat: true,
        frankTagBase64Url: "tag",
        hasServerFrankReceipt: false,
      }),
    ).toBe(false);
    expect(
      frankingMissingReceiptWarning({
        isGroupChat: false,
        frankTagBase64Url: "tag",
        hasServerFrankReceipt: true,
      }),
    ).toBe(false);
    expect(
      frankingMissingReceiptWarning({
        isGroupChat: false,
        wire: taggedWireWithoutReceipt(),
        hasServerFrankReceipt: false,
      }),
    ).toBe(true);
  });
});

describe("franking receipt copy", () => {
  it("keeps submit error distinct from the delivery warning", () => {
    expect(FRANKING_MISSING_RECEIPT_WARNING).toBe(
      "Сообщение доставлено без серверной квитанции.",
    );
    expect(FRANKING_MISSING_RECEIPT_MESSAGE).toBe(
      "Нет серверной квитанции\u00A0\u00A0–\u00A0\u00A0жалобу на это сообщение подать нельзя.",
    );
    expect(FRANKING_MISSING_RECEIPT_MESSAGE.includes("\u2014")).toBe(false);
  });
});
