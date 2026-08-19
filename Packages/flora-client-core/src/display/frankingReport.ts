import {
  frankingReportBlockedByMissingReceipt,
  peekFscpWireFrankTagBase64Url,
} from "@flora/fscp";
import { FRANKING_REPORT_CATEGORIES, type FrankingReportCategory } from "../contracts/franking.js";

export const FRANKING_MISSING_RECEIPT_MESSAGE =
  "Нет серверной квитанции\u00A0\u00A0–\u00A0\u00A0жалобу на это сообщение подать нельзя.";

/** Delivery warning for tagged v1.1+ without a receipt (franking.md §4.3). */
export const FRANKING_MISSING_RECEIPT_WARNING =
  "Сообщение доставлено без серверной квитанции.";

function reportFrankTag(input: {
  frankTagBase64Url?: string | null;
  wire?: string | null;
}): string | null {
  return peekFscpWireFrankTagBase64Url(input.wire) ?? (input.frankTagBase64Url?.trim() || null);
}

const FRANKING_REPORT_CATEGORY_LABELS: Record<FrankingReportCategory, string> = {
  abuse: "Злоупотребление",
  threats: "Угрозы",
  spam: "Спам",
  csam: "Эксплуатация несовершеннолетних",
  other: "Другое",
};

export const FRANKING_REPORT_CATEGORY_OPTIONS: readonly {
  value: FrankingReportCategory;
  label: string;
}[] = FRANKING_REPORT_CATEGORIES.map((value) => ({
  value,
  label: FRANKING_REPORT_CATEGORY_LABELS[value],
}));

export function canReportMessage(input: {
  isFromMe: boolean;
  isGroupChat: boolean;
  sendStatus?: string;
  decryptState?: string;
  frankTagBase64Url?: string | null;
  wire?: string | null;
  hasServerFrankReceipt?: boolean;
}): boolean {
  if (input.isFromMe) return false;
  if (input.isGroupChat) return false;
  if (input.sendStatus === "sending") return false;
  if (input.decryptState === "decrypting" || input.decryptState === "failed") return false;
  if (
    frankingReportBlockedByMissingReceipt({
      frankTagBase64Url: reportFrankTag(input),
      hasServerFrankReceipt: Boolean(input.hasServerFrankReceipt),
    })
  ) {
    return false;
  }
  return true;
}

/** Tagged v1.1+ without receipt: delivery warning (§4.3). Groups stay quiet. */
export function frankingMissingReceiptWarning(input: {
  isGroupChat: boolean;
  frankTagBase64Url?: string | null;
  wire?: string | null;
  hasServerFrankReceipt?: boolean;
}): boolean {
  if (input.isGroupChat) return false;
  return frankingReportBlockedByMissingReceipt({
    frankTagBase64Url: reportFrankTag(input),
    hasServerFrankReceipt: Boolean(input.hasServerFrankReceipt),
  });
}
