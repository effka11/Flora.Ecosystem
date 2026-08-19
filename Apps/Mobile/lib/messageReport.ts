export {
  canReportMessage,
  FRANKING_MISSING_RECEIPT_MESSAGE,
  FRANKING_MISSING_RECEIPT_WARNING,
  FRANKING_REPORT_CATEGORY_OPTIONS,
  frankingMissingReceiptWarning,
} from "@flora/client-core/display";

/** Текст для модалки: `instanceof ApiRequestError` на Metro часто ложный. */
export function frankingReportUserError(err: unknown): string {
  if (typeof err === "object" && err !== null && "message" in err) {
    const message = (err as { message: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }
  }
  return "Не удалось отправить жалобу.";
}
